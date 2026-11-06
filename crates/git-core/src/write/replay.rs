use super::{
    Applied, BranchTip, Change, CommitTxn, Direction, Expect, Operation, ReplayTxn, Repo,
    branches::Writing,
    commit::{self, Target, Trace},
    merge::{self, Edit},
    refs::{self, Files, RefChange},
    store::{self, EntryObjects, LockedStore, Recorded},
    txn::{RefreshTxn, Runner},
};
use crate::{
    BranchRef, ErrorKind, Head, MoveSide, Oid, RepositoryError, Sides, StagedStamp, StaleReason,
    StatusEntry,
    git::{self, WriteDeadline, Wrote},
    status::{self, Untracked},
    sync::{self, InProgress},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

/// The empty tree stands in for a root commit's missing parent.
const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

const WHO: &str = "This cherry-pick or revert";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplayKind {
    CherryPick,
    Revert,
}

impl ReplayKind {
    const fn marker(self) -> &'static str {
        match self {
            Self::CherryPick => "CHERRY_PICK_HEAD",
            Self::Revert => "REVERT_HEAD",
        }
    }

    pub(crate) const fn command(self) -> &'static str {
        match self {
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }

    pub(super) const fn operation(self) -> InProgress {
        match self {
            Self::CherryPick => InProgress::CherryPick,
            Self::Revert => InProgress::Revert,
        }
    }
}

/// The only identity a replay has. There is no session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayOf {
    pub kind: ReplayKind,
    pub commit: Oid,
}

impl ReplayReview {
    fn of(&self) -> ReplayOf {
        ReplayOf {
            kind: self.kind,
            commit: self.commit.clone(),
        }
    }
}

impl ReplayOf {
    /// `merge-tree`'s (base, theirs). A pick merges the commit's change onto
    /// HEAD, and a revert merges the opposite change.
    fn sides(
        &self,
        repo: &Repo,
        deadline: WriteDeadline,
    ) -> Result<(String, String), RepositoryError> {
        let parent = parents(repo, &self.commit, deadline)?
            .into_iter()
            .next()
            .unwrap_or_else(|| {
                if repo.null_oid.len() == EMPTY_TREE_SHA1.len() {
                    EMPTY_TREE_SHA1.to_owned()
                } else {
                    EMPTY_TREE_SHA256.to_owned()
                }
            });
        let commit = self.commit.as_str().to_owned();
        Ok(match self.kind {
            ReplayKind::CherryPick => (parent, commit),
            ReplayKind::Revert => (commit, parent),
        })
    }
}

/// What `merge-tree` says applying the commit to HEAD would do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReplayPrediction {
    Clean { tree: Oid },
    Conflict { paths: Vec<String> },
    Empty,
}

/// A pure function of the repository, so Start asks whether anything moved with
/// one comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayReview {
    pub root: String,
    pub kind: ReplayKind,
    pub commit: Oid,
    pub subject: String,
    pub destination: BranchTip,
    pub prediction: ReplayPrediction,
}

/// Derived on every read. L1 Git stores none of it as state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayProgress {
    pub root: String,
    pub kind: ReplayKind,
    pub commit: Oid,
    pub subject: String,
    pub destination: Head,
    pub footprint: Vec<String>,
    pub unresolved: Vec<String>,
    pub staged: StagedStamp,
    /// `None` while a path is unmerged.
    pub tree: Option<Oid>,
    /// The staged result equals HEAD. Finish refuses, and Abort clears the
    /// marker and keeps every commit.
    pub empty: bool,
    pub suggested_message: String,
}

impl ReplayProgress {
    #[must_use]
    pub fn of(&self) -> ReplayOf {
        ReplayOf {
            kind: self.kind,
            commit: self.commit.clone(),
        }
    }
}

/// `change.json` exists from before Git runs, so a crash can never leave a pending
/// entry with no recorded change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum ReplayChange {
    Pending { before: Head, tree: Option<Oid> },
    Landed(RefChange),
}

/// The single check for a replay L1 Git can finish. Everything else stays an
/// external operation: `sequencer/`, because `--abort` would rewind the commits
/// already picked; another operation alongside; a `-m` pick, because Git records
/// no parent number; a pruned commit; and an unborn branch.
pub(super) fn in_flight(
    repo: &Repo,
    deadline: WriteDeadline,
) -> Result<Option<ReplayOf>, RepositoryError> {
    let kind = match sync::in_progress(&repo.root, deadline.reads())?.as_slice() {
        [InProgress::CherryPick] => ReplayKind::CherryPick,
        [InProgress::Revert] => ReplayKind::Revert,
        _ => return Ok(None),
    };
    if !sync::pseudoref_exists(&repo.root, kind.marker(), deadline.reads())? {
        return Ok(None);
    }
    let Some(commit) = commit::resolve(repo, deadline, kind.marker())? else {
        return Ok(None);
    };
    if parents(repo, &commit, deadline)?.len() > 1
        || matches!(repo.head(deadline)?, Head::Unborn { .. })
    {
        return Ok(None);
    }
    Ok(Some(ReplayOf { kind, commit }))
}

fn parents(
    repo: &Repo,
    commit: &Oid,
    deadline: WriteDeadline,
) -> Result<Vec<String>, RepositoryError> {
    let output = git::read(
        &repo.root,
        &["show", "-s", "--format=%P", commit.as_str()],
        deadline.reads(),
    )?;
    Ok(git::text(&output)
        .split_whitespace()
        .map(str::to_owned)
        .collect())
}

fn base(repo: &Repo) -> PathBuf {
    repo.git_dir.join("l1git").join("replay")
}

fn folder(repo: &Repo, of: &ReplayOf, head: &Oid) -> PathBuf {
    base(repo).join(format!(
        "{}-{}-{}",
        of.kind.command(),
        of.commit.as_str(),
        head.as_str()
    ))
}

fn prepared(repo: &Repo, of: &ReplayOf, head: &Oid) -> Result<PathBuf, RepositoryError> {
    let folder = folder(repo, of, head);
    for dir in [repo.git_dir.join("l1git"), base(repo), folder.clone()] {
        merge::checked_dir(&dir)?;
    }
    Ok(folder)
}

/// NUL-separated paths, or `None` when one is not UTF-8, which L1 Git cannot name.
fn listed_paths(bytes: &[u8]) -> Option<BTreeSet<String>> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8(path.to_vec()).ok())
        .collect()
}

struct Simulated {
    tree: Oid,
    conflicted: BTreeSet<String>,
}

impl Simulated {
    /// `None` when a path is not UTF-8, which L1 Git cannot name.
    fn footprint(
        &self,
        repo: &Repo,
        head: &Oid,
        deadline: WriteDeadline,
    ) -> Result<Option<Vec<String>>, RepositoryError> {
        let changed = git::read(
            &repo.root,
            &[
                "diff-tree",
                "-r",
                "--no-renames",
                "--name-only",
                "-z",
                head.as_str(),
                self.tree.as_str(),
            ],
            deadline.reads(),
        )?;
        Ok(
            listed_paths(&changed)
                .map(|changed| self.conflicted.union(&changed).cloned().collect()),
        )
    }

    /// The paths the result writes that HEAD does not track. `git cherry-pick`
    /// overwrites an ignored file at one of them, silently. A conflicted path HEAD
    /// does not track is one of them, because the tree holds it.
    fn added(
        &self,
        repo: &Repo,
        head: &Oid,
        deadline: WriteDeadline,
    ) -> Result<Vec<String>, RepositoryError> {
        merge::names(
            repo,
            WHO,
            &[
                "diff-tree",
                "-r",
                "--no-renames",
                "--diff-filter=A",
                "--name-only",
                "-z",
                head.as_str(),
                self.tree.as_str(),
            ],
            deadline,
        )
    }
}

/// Touches neither the index nor the worktree. `None` when `merge-tree` cannot
/// answer, as when a partial clone lacks a blob.
fn simulate(
    repo: &Repo,
    of: &ReplayOf,
    head: &Oid,
    deadline: WriteDeadline,
) -> Result<Option<Simulated>, RepositoryError> {
    let (merge_base, theirs) = of.sides(repo, deadline)?;
    let ran = git::run(
        &repo.root,
        &[
            "merge-tree",
            "--write-tree",
            "-z",
            "--name-only",
            "--no-messages",
            &format!("--merge-base={merge_base}"),
            head.as_str(),
            &theirs,
        ],
        deadline.reads(),
    )?;
    if !matches!(ran.status.code(), Some(0 | 1)) {
        return Ok(None);
    }
    let Some(end) = ran.stdout.iter().position(|byte| *byte == 0) else {
        return Err(git::malformed());
    };
    let tree = Oid::try_from(git::text(&ran.stdout[..end])).map_err(|_| git::malformed())?;
    Ok(listed_paths(&ran.stdout[end..]).map(|conflicted| Simulated { tree, conflicted }))
}

/// The conflicted paths and every path the simulated result changes, under the names
/// Git really gives them. Nothing here reads the index, so a staged edit the operation
/// did not make stays outside, which is what lets Abort refuse to drop it. `merge-tree`
/// runs custom merge drivers, so each (kind, commit, HEAD) runs it once, and the memo
/// keeps the answer. Losing the memo costs one more run.
fn footprint(
    repo: &Repo,
    of: &ReplayOf,
    head: &Oid,
    deadline: WriteDeadline,
) -> Result<Option<Vec<String>>, RepositoryError> {
    let memo = folder(repo, of, head).join("footprint.json");
    if let Ok(Some(paths)) = merge::read::<Vec<String>>(&memo) {
        return Ok(Some(paths));
    }
    let Some(simulated) = simulate(repo, of, head, deadline)? else {
        return Ok(None);
    };
    let Some(paths) = simulated.footprint(repo, head, deadline)? else {
        return Ok(None);
    };
    let paths: Vec<_> = real_names(repo, of, head, paths.into_iter().collect(), deadline)?
        .into_iter()
        .collect();
    let _ = prepared(repo, of, head).and_then(|_| merge::persist(&memo, &paths));
    Ok(Some(paths))
}

/// A path Git renames to avoid a clash is `<path>~<label>`. `merge-tree` labels it with
/// the commit ID it was given, and a real pick or revert with what this builds. If HEAD
/// already tracks that name, Git adds a suffix, so that file is the user's own and stays
/// out. Finish and Abort then refuse and name the path, and the terminal can end it.
fn real_names(
    repo: &Repo,
    of: &ReplayOf,
    head: &Oid,
    paths: BTreeSet<String>,
    deadline: WriteDeadline,
) -> Result<BTreeSet<String>, RepositoryError> {
    if !paths.iter().any(|path| path.contains('~')) {
        return Ok(paths);
    }
    let (_, theirs) = of.sides(repo, deadline)?;
    let short = git::line(&git::read(
        &repo.root,
        &["rev-parse", "--short", of.commit.as_str()],
        deadline.reads(),
    )?);
    let message = git::read(
        &repo.root,
        &["show", "-s", "--format=%B", of.commit.as_str()],
        deadline.reads(),
    )?;
    let message = git::text(&message);
    let subject = message.lines().next().unwrap_or_default().replace('/', "_");
    let label = match of.kind {
        ReplayKind::CherryPick => format!("{short} ({subject})"),
        ReplayKind::Revert => format!("parent of {short} ({subject})"),
    };
    paths
        .into_iter()
        .map(|path| {
            let name = match path.rsplit_once('~') {
                Some((stem, side)) if side == head.as_str() => format!("{stem}~HEAD"),
                Some((stem, side)) if side == theirs => format!("{stem}~{label}"),
                Some(_) | None => return Ok(path),
            };
            let tracked = git::read(
                &repo.root,
                &[
                    "--literal-pathspecs",
                    "ls-tree",
                    "--name-only",
                    "-z",
                    head.as_str(),
                    "--",
                    &name,
                ],
                deadline.reads(),
            )?;
            Ok(if tracked.is_empty() { name } else { path })
        })
        .collect()
}

fn tree_of(repo: &Repo, commit: &Oid, deadline: WriteDeadline) -> Result<Oid, RepositoryError> {
    let output = git::read(
        &repo.root,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{tree}}", commit.as_str()),
        ],
        deadline.reads(),
    )?;
    Oid::try_from(git::line(&output)).map_err(|_| git::malformed())
}

fn subject(repo: &Repo, commit: &Oid, deadline: WriteDeadline) -> Result<String, RepositoryError> {
    let shown = git::read(
        &repo.root,
        &["show", "-s", "--format=%s", commit.as_str()],
        deadline.reads(),
    )?;
    Ok(git::line(&shown))
}

/// `None` unless `in_flight` answers and `merge-tree` can name the footprint.
pub(super) fn progress(
    repo: &Repo,
    deadline: WriteDeadline,
) -> Result<Option<ReplayProgress>, RepositoryError> {
    let Some(of) = in_flight(repo, deadline)? else {
        return Ok(None);
    };
    let destination = repo.head(deadline)?;
    let head = refs::oid(&destination).ok_or_else(git::malformed)?;
    let Some(footprint) = footprint(repo, &of, &head, deadline)? else {
        return Ok(None);
    };
    let (entries, staged) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    let unresolved = merge::unresolved(&entries);
    let tree = if unresolved.is_empty() {
        Some(merge::staged_tree(repo, deadline)?)
    } else {
        None
    };
    let empty = match &tree {
        Some(tree) => *tree == tree_of(repo, &head, deadline)?,
        None => false,
    };
    let subject = subject(repo, &of.commit, deadline)?;
    let suggested_message = match fs::read(repo.git_dir.join("MERGE_MSG")) {
        Ok(message) => cut_conflicts_block(&git::text(&message), &comment_string(repo, deadline)?),
        Err(_) => String::new(),
    };
    Ok(Some(ReplayProgress {
        root: repo.root(),
        kind: of.kind,
        commit: of.commit,
        subject,
        destination,
        footprint,
        unresolved,
        staged,
        tree,
        empty,
        suggested_message,
    }))
}

/// Every refusal, in one place, so Start re-runs the identical list. Writes only
/// `merge-tree`'s loose objects.
pub(super) fn review(
    repo: &Repo,
    of: &ReplayOf,
    deadline: WriteDeadline,
) -> Result<ReplayReview, RepositoryError> {
    // First, because a stopped rebase also detaches HEAD, and the rebase is the reason.
    if let Some(running) = sync::in_progress(&repo.root, deadline.reads())?.first() {
        return Err(merge::refused(format!(
            "{} is in progress in this worktree. Finish or abort it first.",
            refs::capitalized(running.name())
        )));
    }
    let name = of.kind.operation().name();
    let Head::Attached { reference, oid } = repo.head(deadline)? else {
        return Err(merge::refused(format!(
            "{} needs a checked-out local branch with a commit. Check one out first.",
            refs::capitalized(name)
        )));
    };
    let branch = BranchRef::try_from(reference).map_err(|_| git::malformed())?;
    let head = Oid::try_from(oid).map_err(|_| git::malformed())?;
    commit::refuse_non_commit(repo, deadline, &of.commit)?;
    let short = commit::short(&of.commit);
    if parents(repo, &of.commit, deadline)?.len() > 1 {
        return Err(merge::refused(format!(
            "{short} is a merge commit, and L1 Git applies only a commit with one parent. Use Git to choose a parent."
        )));
    }
    let on_branch = merge::ancestor(repo, &of.commit, &head, deadline)?;
    if on_branch && of.kind == ReplayKind::CherryPick {
        return Err(merge::refused(format!(
            "{short} is already on {}, so there is nothing to cherry-pick.",
            branch.name()
        )));
    }
    if !on_branch && of.kind == ReplayKind::Revert {
        return Err(merge::refused(format!(
            "{short} is not on {}, so there is nothing to revert.",
            branch.name()
        )));
    }
    merge::safe_index_for(repo, WHO, deadline)?;
    if !merge::config(repo, "pull.twohead", deadline)?.is_empty() {
        return Err(merge::refused(format!(
            "pull.twohead changes how Git applies a commit, and this review cannot predict it. Run {name} with Git instead."
        )));
    }
    let staged = staged_paths(repo, &head, deadline)?;
    if !staged.is_empty() {
        return Err(merge::refused(format!(
            "These paths have staged changes: {}. Commit or unstage them first.",
            staged.into_iter().collect::<Vec<_>>().join(", ")
        )));
    }
    let unknown = || {
        merge::refused(format!(
            "L1 Git cannot work out what {name} would change. Run it with Git instead."
        ))
    };
    let simulated = simulate(repo, of, &head, deadline)?.ok_or_else(unknown)?;
    let prediction = if !simulated.conflicted.is_empty() {
        ReplayPrediction::Conflict {
            paths: simulated.conflicted.iter().cloned().collect(),
        }
    } else if simulated.tree == tree_of(repo, &head, deadline)? {
        ReplayPrediction::Empty
    } else {
        ReplayPrediction::Clean {
            tree: simulated.tree.clone(),
        }
    };
    if prediction != ReplayPrediction::Empty {
        let footprint = simulated
            .footprint(repo, &head, deadline)?
            .ok_or_else(unknown)?;
        let (entries, _) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
        let edited: Vec<_> = unstaged_paths(&entries)
            .into_iter()
            .filter(|path| footprint.contains(path))
            .collect();
        if !edited.is_empty() {
            return Err(merge::refused(format!(
                "These paths have unstaged edits, and {name} would change them: {}. Commit, stash, or undo the edits first.",
                edited.join(", ")
            )));
        }
        let added = simulated.added(repo, &head, deadline)?;
        let collisions = merge::colliding_files(repo, WHO, &added, deadline)?;
        if !collisions.is_empty() {
            return Err(merge::refused(format!(
                "Preserve these untracked or ignored files first, because {name} would write to their paths: {}.",
                collisions.join(", ")
            )));
        }
    }
    Ok(ReplayReview {
        root: repo.root(),
        kind: of.kind,
        commit: of.commit.clone(),
        subject: subject(repo, &of.commit, deadline)?,
        destination: BranchTip {
            reference: branch,
            oid: head,
        },
        prediction,
    })
}

/// Where the resolver's undo history lives while this replay lasts. The path comes
/// from Git's state, and nothing reads the folder to learn what is in progress, so
/// deleting it costs only resolution Undo. Runs under the store lock.
pub(super) fn journal(repo: &Repo, progress: &ReplayProgress) -> Result<PathBuf, RepositoryError> {
    let head = refs::oid(&progress.destination).ok_or_else(git::malformed)?;
    let folder = prepared(repo, &progress.of(), &head)?;
    sweep(repo, Some(&folder));
    Ok(folder.join("undo"))
}

/// Removes every journal and memo but `keep`, which a finished or restarted replay
/// left behind. Runs under the store lock.
pub(super) fn sweep(repo: &Repo, keep: Option<&Path>) {
    let Ok(folders) = fs::read_dir(base(repo)) else {
        return;
    };
    for folder in folders.flatten() {
        if keep != Some(folder.path().as_path()) {
            let _ = fs::remove_dir_all(folder.path());
        }
    }
}

/// A replay whose footprint `merge-tree` cannot name reads as an external
/// operation, so it passes as one does.
pub(super) fn admit(
    repo: &Repo,
    operation: &Operation,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let Some(of) = in_flight(repo, deadline)? else {
        return Ok(());
    };
    let head = refs::oid(&repo.head(deadline)?).ok_or_else(git::malformed)?;
    let Some(footprint) = footprint(repo, &of, &head, deadline)? else {
        return Ok(());
    };
    let name = refs::capitalized(of.kind.operation().name());
    match merge::edit(operation) {
        Edit::Paths(changed) => {
            let outside = outside(changed, &footprint);
            if outside.is_empty() {
                return Ok(());
            }
            Err(merge::refused(format!(
                "{name} is in progress in this worktree, and it does not change these paths: {}. Finish or abort it before you change them.",
                outside.join(", ")
            )))
        }
        Edit::Finish => Ok(()),
        Edit::Refused => Err(merge::refused(format!(
            "{name} is in progress in this worktree. Only resolution and index edits within its affected paths are available until Finish or Abort."
        ))),
    }
}

fn nothing_to_apply(kind: ReplayKind) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnchangedPath,
        format!(
            "This {} changes nothing, because the result matches HEAD. L1 Git made no commit.",
            kind.command()
        ),
    )
}

/// Reviews again and compares the whole answer, so nothing the user saw has moved.
pub(super) fn apply(
    writing: &Writing<'_>,
    expect: &Expect,
    shown: &ReplayReview,
) -> Result<Applied, RepositoryError> {
    let &Writing {
        repo,
        store,
        log,
        deadline,
        operation,
    } = writing;
    if let Some(applied) = already_landed(writing, expect)? {
        return Ok(applied);
    }
    let head = repo.head_as_seen(expect, deadline)?;
    let of = shown.of();
    if review(repo, &of, deadline)? != *shown {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            format!(
                "What this {} would do changed since L1 Git showed it, so nothing changed. Review it again.",
                of.kind.command()
            ),
        ));
    }
    let tree = match &shown.prediction {
        ReplayPrediction::Clean { tree } => Some(tree.clone()),
        ReplayPrediction::Conflict { .. } => None,
        ReplayPrediction::Empty => return Err(nothing_to_apply(of.kind)),
    };
    let (applied, _, recorded) = store.record_with(repo, log, operation, |_| {
        Ok(ReplayChange::Pending {
            before: head.clone(),
            tree,
        })
    })?;
    recorded.durable()?;
    let trace = Trace::create(store, applied.id)?;
    let txn = ReplayTxn::begin(repo, deadline)?;
    let wrote = match txn
        .apply(&of)
        .traces(&trace.events, &trace.refs)
        .run(deadline)
    {
        Ok(wrote) => wrote,
        Err(error) => {
            recorded.stay_pending();
            return Err(error);
        }
    };
    let txn = txn.renewed();
    match wrote.code() {
        Some(0) => {
            let (_, race) = land(recorded, txn.runner(), &wrote, &trace, &head)?;
            race.map_or(Ok(applied), Err)
        }
        Some(_) => Err(classify(repo, &txn, shown, &wrote, &trace).unwrap_or_else(|error| error)),
        // A killed Git may have made the commit. The next request settles from Git's state.
        None => {
            recorded.stay_pending();
            Err(commit::refused(&wrote, &trace))
        }
    }
}

/// Git exited without making a commit, so nothing landed and the entry drops. Git's
/// state says what happened, never the exit code: `rerere.autoUpdate` exits 1 with
/// nothing unresolved, and a hook or signing stop exits 128 with the result staged.
fn classify(
    repo: &Repo,
    txn: &ReplayTxn<'_>,
    shown: &ReplayReview,
    wrote: &Wrote,
    trace: &Trace,
) -> Result<RepositoryError, RepositoryError> {
    let deadline = txn.runner().deadline();
    let (entries, _) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    let unresolved = merge::unresolved(&entries);
    // Another process's `index.lock` makes this `None`, which matches no tree below.
    let staged = if unresolved.is_empty() {
        merge::staged_tree(repo, deadline).ok()
    } else {
        None
    };
    let matches_head =
        staged.is_some() && staged == Some(tree_of(repo, &shown.destination.oid, deadline)?);
    let marked = sync::pseudoref_exists(&repo.root, shown.kind.marker(), deadline.reads())?;
    if !marked {
        let predicted = match &shown.prediction {
            ReplayPrediction::Clean { tree } => Some(tree),
            ReplayPrediction::Conflict { .. } | ReplayPrediction::Empty => None,
        };
        if shown.kind != ReplayKind::Revert {
            return Ok(commit::refused(wrote, trace));
        }
        if predicted.is_some() && predicted == staged.as_ref() {
            // Git writes REVERT_HEAD only on a conflict, so a clean revert that a hook
            // or signing stopped has none. Writing it makes this a pick's stop.
            if let Err(error) = txn
                .mark_revert(&shown.commit)
                .run(deadline)
                .and_then(Wrote::succeeded)
            {
                return Ok(RepositoryError::new(
                    ErrorKind::GitFailed,
                    format!(
                        "{} The result stays staged with no revert in progress, because L1 Git could not mark one. Commit it, or unstage and discard it. {}",
                        commit::refused(wrote, trace).message,
                        error.message
                    ),
                ));
            }
        } else if matches_head && wrote.code() == Some(1) {
            // An empty revert leaves MERGE_MSG and no marker, and `--abort` refuses it.
            let _ = fs::remove_file(repo.git_dir.join("MERGE_MSG"));
            return Ok(nothing_to_apply(shown.kind));
        } else {
            return Ok(commit::refused(wrote, trace));
        }
    } else if matches_head && txn.abort(shown.kind).run(deadline)?.code() == Some(0) {
        return Ok(nothing_to_apply(shown.kind));
    }
    let noun = shown.kind.command();
    Ok(if unresolved.is_empty() {
        RepositoryError::new(
            ErrorKind::ReplayStopped {
                output: wrote.stderr().to_owned(),
            },
            format!(
                "{} The result is staged. Finish or abort the {noun}.",
                commit::refused(wrote, trace).message
            ),
        )
    } else {
        RepositoryError::new(
            ErrorKind::ReplayStopped {
                output: String::new(),
            },
            format!(
                "The {noun} stopped on a conflict, so Git made no commit. Resolve it, then finish or abort the {noun}."
            ),
        )
    })
}

/// Runs on the global store, because the result joins global history.
pub(super) fn finish(
    writing: &Writing<'_>,
    expect: &Expect,
    of: &ReplayOf,
    staged: &StagedStamp,
    tree: &Oid,
    message: &str,
) -> Result<Applied, RepositoryError> {
    let &Writing {
        repo,
        store,
        log,
        deadline,
        operation,
    } = writing;
    if let Some(applied) = already_landed(writing, expect)? {
        return Ok(applied);
    }
    let name = of.kind.operation().name();
    match in_flight(repo, deadline)? {
        Some(found) if found == *of => {}
        Some(_) => {
            return Err(RepositoryError::stale(
                StaleReason::HeadMoved,
                "A different cherry-pick or revert is in progress now, so nothing changed. Refresh.",
            ));
        }
        None => {
            return Err(merge::refused(
                "No single cherry-pick or revert is in progress in this worktree, so there is nothing to finish. Refresh.",
            ));
        }
    }
    let head = repo.head_as_seen(expect, deadline)?;
    let before = refs::oid(&head).ok_or_else(git::malformed)?;
    settle_journal(repo, of, &before, deadline)?;
    merge::safe_index_for(repo, WHO, deadline)?;
    if message.trim().is_empty() {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Write a commit message. Git refuses an empty one.",
        ));
    }
    let (entries, stamp) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    if let Some(path) = entries.iter().find_map(|entry| match entry {
        StatusEntry::Unmerged { path, .. } => Some(path),
        StatusEntry::Ordinary { .. }
        | StatusEntry::Renamed { .. }
        | StatusEntry::Untracked { .. } => None,
    }) {
        return Err(merge::refused(format!(
            "{path} has a conflict. Mark it resolved before you finish."
        )));
    }
    if stamp != *staged || merge::staged_tree(repo, deadline)? != *tree {
        return Err(RepositoryError::stale(
            StaleReason::StagedChanged,
            "The staged result changed since L1 Git showed it. Review it again before you finish.",
        ));
    }
    if *tree == tree_of(repo, &before, deadline)? {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            format!(
                "The staged result matches HEAD, so there is no commit to make. Abort to end {name}."
            ),
        ));
    }
    let footprint = known_footprint(repo, of, &before, deadline)?;
    let extra = outside(staged_paths(repo, &before, deadline)?, &footprint);
    if !extra.is_empty() {
        return Err(merge::refused(format!(
            "Preserve these staged changes before you finish, because {name} does not change them: {}.",
            extra.join(", ")
        )));
    }
    let edited: Vec<_> = unstaged_paths(&entries)
        .into_iter()
        .filter(|path| footprint.contains(path))
        .collect();
    if !edited.is_empty() {
        return Err(merge::refused(format!(
            "These paths have unstaged edits that the reviewed result leaves out: {}. Stage them or undo the edits before you finish.",
            edited.join(", ")
        )));
    }
    let (applied, _, recorded) = store.record_with(repo, log, operation, |_| {
        Ok(ReplayChange::Pending {
            before: head.clone(),
            tree: Some(tree.clone()),
        })
    })?;
    recorded.durable()?;
    let trace = Trace::create(store, applied.id)?;
    let txn = CommitTxn::begin(repo, deadline)?;
    let wrote = match txn
        .commit(&[], message)
        .traces(&trace.events, &trace.refs)
        .run(deadline)
    {
        Ok(wrote) => wrote,
        Err(error) => {
            recorded.stay_pending();
            return Err(error);
        }
    };
    let txn = txn.renewed();
    let deadline = deadline.renewed();
    // A killed Git may have made the commit. The next request settles from Git's state.
    if wrote.code().is_none() {
        recorded.stay_pending();
        return Err(commit::refused(&wrote, &trace));
    }
    let (made, race) = land(recorded, txn.runner(), &wrote, &trace, &head)?;
    if tree_of(repo, &made, deadline)? != *tree {
        return Err(race.unwrap_or_else(|| {
            RepositoryError::new(
                ErrorKind::AfterHookFailed {
                    output: wrote.stderr().to_owned(),
                },
                "Git made the commit, but a hook changed the staged files first, so it differs from the result you reviewed. Undo removes the commit.",
            )
        }));
    }
    race.map_or(Ok(applied), Err)
}

/// Proves the commit Git made on `head` and completes the entry. An answer of `raced`
/// comes back beside the commit, because the entry stands either way: Undo moves the
/// branch back to the commit Git replaced.
fn land(
    recorded: Recorded<'_>,
    runner: &impl Runner,
    wrote: &Wrote,
    trace: &Trace,
    head: &Head,
) -> Result<(Oid, Option<RepositoryError>), RepositoryError> {
    let target = Target::of(head);
    let update = commit::proved(runner.repo(), wrote, trace, &target, runner.deadline())?;
    let race = (update.old != refs::oid(head)).then(|| commit::raced_new(&update, &target));
    let change = RefChange::new(
        target.at(update.old.as_ref())?,
        target.at(Some(&update.new))?,
        None,
    )?;
    commit::record_commit(
        recorded,
        runner,
        &Change::Replay(ReplayChange::Landed(change)),
    )?;
    Ok((update.new, race))
}

/// The undo log is the receipt for a repeated request. Nothing else records that a
/// replay finished, and Git's marker is gone by then.
fn already_landed(
    writing: &Writing<'_>,
    expect: &Expect,
) -> Result<Option<Applied>, RepositoryError> {
    let Some(id) = writing.log.next_undo() else {
        return Ok(None);
    };
    let (applied, change) = writing.store.record_of(id)?;
    let Change::Replay(ReplayChange::Landed(change)) = change else {
        return Ok(None);
    };
    Ok((applied.operation == *writing.operation
        && applied.root == writing.repo.root()
        && change.moved(&expect.head, &writing.repo.head(writing.deadline)?))
    .then_some(applied))
}

/// Settles a pending entry from Git alone. A commit whose parent, tree, or branch
/// differ stays, with no undo entry. The marker is not consulted, because Git moves
/// the ref before it clears the marker.
pub(super) fn landed(
    repo: &Repo,
    change: &ReplayChange,
    deadline: WriteDeadline,
) -> Result<Option<ReplayChange>, RepositoryError> {
    let ReplayChange::Pending { before, tree } = change else {
        return Ok(Some(change.clone()));
    };
    let head = repo.head(deadline)?;
    let (Some(parent), Some(made)) = (refs::oid(before), refs::oid(&head)) else {
        return Ok(None);
    };
    if head == *before || Target::of(&head) != Target::of(before) {
        return Ok(None);
    }
    let shown = git::read(
        &repo.root,
        &["show", "-s", "--format=%P%n%T", made.as_str()],
        deadline.reads(),
    )?;
    let shown = git::text(&shown);
    let mut lines = shown.lines();
    if lines.next() != Some(parent.as_str())
        || tree
            .as_ref()
            .is_some_and(|tree| lines.next() != Some(tree.as_str()))
    {
        return Ok(None);
    }
    Ok(Some(ReplayChange::Landed(RefChange::new(
        before.clone(),
        head,
        None,
    )?)))
}

/// Refuses a staged edit outside the footprint before Git runs, because `--abort`
/// silently drops it along with the conflict. Git owns everything after that: it
/// restores the files and clears the marker last, so repeating a stopped abort
/// finishes it. Nothing records the abort, so Undo cannot put a conflict back.
pub(super) fn abort(
    repo: &Repo,
    of: &ReplayOf,
    head: &Head,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let running = sync::in_progress(&repo.root, deadline.reads())?;
    let Some(operation) = running.first() else {
        return Ok(());
    };
    let Some(found) = in_flight(repo, deadline)? else {
        return Err(merge::refused(format!(
            "{} is in progress in this worktree, and L1 Git cannot abort it. End it with Git.",
            refs::capitalized(operation.name())
        )));
    };
    if found != *of || repo.head(deadline)? != *head {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "The cherry-pick or revert in progress, or its branch, changed since L1 Git showed it, so nothing changed. Refresh.",
        ));
    }
    let current = refs::oid(head).ok_or_else(git::malformed)?;
    settle_journal(repo, of, &current, deadline)?;
    merge::safe_index_for(repo, WHO, deadline)?;
    let footprint = known_footprint(repo, of, &current, deadline)?;
    let extra = outside(staged_paths(repo, &current, deadline)?, &footprint);
    if !extra.is_empty() {
        return Err(merge::refused(format!(
            "Abort would discard these staged changes, because {} does not change them: {}. Preserve them, then abort.",
            of.kind.operation().name(),
            extra.join(", ")
        )));
    }
    // `--abort` restores a path the replay deleted over whatever now sits there.
    let collisions = merge::colliding_files(repo, WHO, &footprint, deadline)?;
    if !collisions.is_empty() {
        return Err(merge::refused(format!(
            "Abort would overwrite these untracked or ignored files, because {} changes their paths: {}. Preserve them, then abort.",
            of.kind.operation().name(),
            collisions.join(", ")
        )));
    }
    // A row that resolution Undo restored has no stat data, which `--abort` reports as
    // an unstaged edit.
    RefreshTxn::begin(repo, deadline)?.refresh(&|| false)?;
    let txn = ReplayTxn::begin(repo, deadline)?;
    let wrote = txn.abort(of.kind).run(deadline)?;
    let deadline = deadline.renewed();
    if wrote.stderr().contains("not uptodate") {
        return Err(merge::refused(format!(
            "A file has unstaged edits, so Git did not abort. Stage the file or undo the edits, then abort. Git said: {}",
            crate::stderr::summarize(wrote.stderr())
        )));
    }
    wrote.succeeded()?;
    if sync::pseudoref_exists(&repo.root, of.kind.marker(), deadline.reads())?
        || repo.head(deadline)? != *head
    {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Git finished the abort, but its marker or HEAD did not end as expected. Inspect the repository with Git.",
        ));
    }
    Ok(())
}

pub(super) fn step(
    repo: &Repo,
    entry: &EntryObjects,
    change: &ReplayChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let ReplayChange::Landed(change) = change else {
        return Err(store::history_changed());
    };
    refs::restore_with(repo, entry, change, direction, Files::Follow, deadline)
}

fn settle_journal(
    repo: &Repo,
    of: &ReplayOf,
    head: &Oid,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let journal = folder(repo, of, head).join("undo");
    LockedStore::lock(&journal, &repo.common_dir, deadline.reads())?.settled_log(repo, deadline)?;
    Ok(())
}

fn known_footprint(
    repo: &Repo,
    of: &ReplayOf,
    head: &Oid,
    deadline: WriteDeadline,
) -> Result<Vec<String>, RepositoryError> {
    footprint(repo, of, head, deadline)?.ok_or_else(|| {
        merge::refused(format!(
            "L1 Git cannot work out which paths {} changes. End it with Git.",
            of.kind.operation().name()
        ))
    })
}

fn staged_paths(
    repo: &Repo,
    head: &Oid,
    deadline: WriteDeadline,
) -> Result<BTreeSet<String>, RepositoryError> {
    let output = git::read(
        &repo.root,
        &[
            "diff-index",
            "--cached",
            "--no-renames",
            "--name-only",
            "-z",
            head.as_str(),
            "--",
        ],
        deadline.reads(),
    )?;
    listed_paths(&output).ok_or_else(git::malformed)
}

/// `git diff` would rewrite the index and run `post-index-change` for a file touched
/// with no edits, even with `GIT_OPTIONAL_LOCKS=0`. `git status` does neither.
fn unstaged_paths(entries: &[StatusEntry]) -> BTreeSet<String> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            StatusEntry::Ordinary {
                path,
                sides: Sides::Unstaged { .. } | Sides::Both { .. },
                ..
            }
            | StatusEntry::Renamed {
                path,
                side:
                    MoveSide::Staged {
                        unstaged: Some(_), ..
                    }
                    | MoveSide::Unstaged { .. },
                ..
            } => Some(path.clone()),
            StatusEntry::Ordinary { .. }
            | StatusEntry::Renamed { .. }
            | StatusEntry::Unmerged { .. }
            | StatusEntry::Untracked { .. } => None,
        })
        .collect()
}

fn outside(paths: BTreeSet<String>, footprint: &[String]) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| !footprint.contains(path))
        .collect()
}

/// What Git started each `Conflicts:` line with. `auto` only changes what `git
/// commit` picks for its own template, so a stopped replay still wrote `#`.
fn comment_string(repo: &Repo, deadline: WriteDeadline) -> Result<String, RepositoryError> {
    let ran = git::run(
        &repo.root,
        &[
            "config",
            "-z",
            "--get-regexp",
            r"^core\.comment(char|string)$",
        ],
        deadline.reads(),
    )?;
    if !matches!(ran.status.code(), Some(0 | 1)) {
        return Err(git::read_failed());
    }
    let text = git::text(&ran.stdout);
    let last = text
        .split('\0')
        .rfind(|record| !record.is_empty())
        .and_then(|record| record.split_once('\n'))
        .map(|(_, value)| value);
    Ok(match last {
        Some(value) if !value.eq_ignore_ascii_case("auto") => value.to_owned(),
        Some(_) | None => "#".to_owned(),
    })
}

/// Cuts the hint Git appends to `MERGE_MSG` when a replay stops: a `Conflicts:`
/// heading and its paths, all comments, at the very end. Other comment lines stay,
/// because a commit's body can hold a real `# ...` line. Under `commit.cleanup =
/// scissors`, Git writes its cut line and notes before the hint.
fn cut_conflicts_block(merge_msg: &str, comment: &str) -> String {
    fn bare(line: &str) -> &str {
        line.trim_end_matches('\n')
    }
    let lines: Vec<_> = merge_msg.split_inclusive('\n').collect();
    let path = format!("{comment}\t");
    let heading = format!("{comment} Conflicts:");
    let mut keep = lines.len();
    while keep > 0 && lines[keep - 1].starts_with(&path) {
        keep -= 1;
    }
    if keep == lines.len() || keep == 0 || bare(lines[keep - 1]) != heading {
        return merge_msg.to_owned();
    }
    keep -= 1;
    let cut_line = format!("{comment} ------------------------ >8 ------------------------");
    if let Some(cut) = lines[..keep]
        .iter()
        .rposition(|line| bare(line) == cut_line)
        && lines[cut..keep]
            .iter()
            .all(|line| line.starts_with(comment))
    {
        keep = cut;
    }
    while keep > 0 && bare(lines[keep - 1]).is_empty() {
        keep -= 1;
    }
    lines[..keep].concat()
}

#[cfg(test)]
mod tests;
