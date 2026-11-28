use super::{
    Applied, Change, Direction, Expect, Operation, RebaseTxn, ReplayOf, Repo, Writing, entry_path,
    merge,
    refs::{self, Files, RefChange},
    replay::{self, Paths, Resolution},
    store::{self, EntryObjects, Objects, Recorded},
    txn::Runner,
};
use crate::{
    BranchRef, ErrorKind, Head, Oid, RemoteRef, RepositoryError, StagedStamp, StaleReason,
    StatusEntry,
    git::{self, Deadline, WriteDeadline, Wrote},
    status::{self, Untracked},
    stderr,
    sync::{self, InProgress},
};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const WHO: &str = "Pull (Rebase)";
const STEPPING: &str = "This rebase";
/// How a sentence names it, as `replay::known_footprint` asks.
const NAME: &str = "the rebase";

/// The identity Continue, Skip, and Abort carry. Git's own state answers it again
/// on every request, so a rebase that moved on answers `staleView`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebaseOf {
    /// `rebase-merge/head-name`, the branch Git moves when the rebase ends.
    pub branch: BranchRef,
    pub onto: Oid,
    /// Where `branch` pointed before the rebase, which Abort puts back.
    pub orig_head: Oid,
    /// `REBASE_HEAD`, the commit Git stopped applying.
    pub step: Oid,
}

/// Derived on every read from `rebase-merge/` and the index. L1 Git stores none of
/// it as state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseProgress {
    pub root: String,
    pub branch: BranchRef,
    pub onto: Oid,
    /// A branch that points at `onto`, the rebased branch's upstream first, so the
    /// panel can name it. `None` when no local or remote-tracking branch does.
    pub onto_name: Option<String>,
    pub orig_head: Oid,
    pub step: Oid,
    pub subject: String,
    /// The step's place in the rebase, from `msgnum` and `end`.
    pub done: u32,
    pub total: u32,
    /// The detached HEAD: `onto` and the commits replayed so far.
    pub head: Head,
    pub footprint: Vec<String>,
    /// The paths `merge-tree` says conflict, which are the paths Git stopped on.
    /// They stay listed once resolved.
    pub conflicted: Vec<String>,
    pub unresolved: Vec<String>,
    pub staged: StagedStamp,
    /// `None` while a path is unmerged.
    pub tree: Option<Oid>,
    /// The staged result equals HEAD. Continue refuses, and Skip drops the commit.
    pub empty: bool,
}

impl RebaseProgress {
    #[must_use]
    pub fn of(&self) -> RebaseOf {
        RebaseOf {
            branch: self.branch.clone(),
            onto: self.onto.clone(),
            orig_head: self.orig_head.clone(),
            step: self.step.clone(),
        }
    }
}

impl RebaseOf {
    fn pick(&self) -> ReplayOf {
        ReplayOf::picking(self.step.clone())
    }

    /// Where the branch was, which a finished rebase's undo entry moves it back to.
    fn before(&self) -> Head {
        Head::Attached {
            reference: self.branch.as_str().to_owned(),
            oid: self.orig_head.as_str().to_owned(),
        }
    }
}

/// `change.json` exists from before Git runs, so a crash can never leave a
/// pending entry with no recorded change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum RebaseChange {
    Pending { before: Head, onto: Oid },
    Landed(RefChange),
}

impl RebaseChange {
    pub(super) fn objects(&self) -> Objects {
        match self {
            Self::Pending { .. } => Objects::default(),
            Self::Landed(change) => change.objects(),
        }
    }
}

/// Replays the commits of the checked-out `branch` onto what `onto` names now,
/// as `git pull --rebase` does. A rebase that stops where L1 Git can continue it
/// stays in progress and answers `rebaseStopped`, with no entry: whichever
/// Continue or Skip ends it records one. Any other stop is aborted, so nothing
/// changes.
pub(super) fn apply(
    writing: &Writing<'_>,
    expect: &Expect,
    branch: &BranchRef,
    onto: &RemoteRef,
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
    let before = match &head {
        Head::Attached { reference, .. } if reference == branch.as_str() => {
            refs::oid(&head).ok_or_else(git::malformed)?
        }
        Head::Attached { .. } | Head::Detached { .. } | Head::Unborn { .. } => {
            return Err(merge::refused(format!(
                "{} is not checked out in this worktree, so L1 Git did not rebase it.",
                branch.name()
            )));
        }
    };
    if let Some(running) = sync::in_progress(&repo.root, deadline.reads())?.first() {
        return Err(merge::refused(format!(
            "{} is in progress in this worktree. Finish or abort it before you pull.",
            refs::capitalized(running.name())
        )));
    }
    merge::safe_index_for(repo, WHO, deadline)?;
    let (entries, _) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    if !entries.is_empty() {
        return Err(merge::refused(format!(
            "Commit or stash these changes before you rebase: {}.",
            entries
                .iter()
                .map(entry_path)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    let upstream = git::read(
        &repo.root,
        &["for-each-ref", "--format=%(upstream)", branch.as_str()],
        deadline.reads(),
    )?;
    if git::line(&upstream) != onto.as_str() {
        return Err(RepositoryError::stale(
            StaleReason::BranchChanged,
            format!(
                "The upstream of {} changed since L1 Git read it, so nothing changed. Refresh and pull again.",
                branch.name()
            ),
        ));
    }
    let target = commit_of(repo, onto.as_str(), deadline)?;
    if ancestor(repo, &target, &before, deadline)? {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            format!(
                "{} already contains {}, so there is nothing to rebase.",
                branch.name(),
                onto.as_str().trim_start_matches("refs/remotes/")
            ),
        ));
    }
    let collisions = merge::colliding_files(
        repo,
        WHO,
        &written(repo, &before, &target, deadline)?,
        deadline,
    )?;
    if !collisions.is_empty() {
        return Err(merge::refused(format!(
            "Preserve these untracked or ignored files first, because the rebase would write to their paths: {}.",
            collisions.join(", ")
        )));
    }
    let (applied, _, mut recorded) = store.record_with(repo, log, operation, |_| {
        Ok(RebaseChange::Pending {
            before: head.clone(),
            onto: target.clone(),
        })
    })?;
    recorded.durable()?;
    let txn = RebaseTxn::begin(repo, deadline)?;
    let wrote = recorded.pending_on_err(txn.rebase(&target).run(deadline))?;
    let txn = txn.renewed();
    match wrote.code() {
        Some(0) => {
            land(recorded, txn.runner(), &head, &target)?;
            Ok(applied)
        }
        Some(_) => Err(stopped(repo, &txn, &head, &wrote).unwrap_or_else(|error| error)),
        // A killed Git may have finished. The next request settles from Git's state.
        None => {
            recorded.stay_pending();
            Err(stopped(repo, &txn, &head, &wrote).unwrap_or_else(|error| error))
        }
    }
}

fn commit_of(repo: &Repo, name: &str, deadline: WriteDeadline) -> Result<Oid, RepositoryError> {
    let output = git::read(
        &repo.root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{name}^{{commit}}"),
        ],
        deadline.reads(),
    )?;
    Oid::try_from(git::line(&output))
}

/// Every path the rebase may write: Git first checks out `onto`, then replays
/// each local commit, so a path a commit adds and a later one deletes counts.
fn written(
    repo: &Repo,
    before: &Oid,
    onto: &Oid,
    deadline: WriteDeadline,
) -> Result<Vec<String>, RepositoryError> {
    let mut paths = merge::names(
        repo,
        WHO,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            before.as_str(),
            onto.as_str(),
        ],
        deadline,
    )?;
    paths.extend(merge::names(
        repo,
        WHO,
        &[
            "log",
            "--no-show-signature",
            "--format=",
            "--name-only",
            "--no-renames",
            "-z",
            &format!("{}..{}", onto.as_str(), before.as_str()),
        ],
        deadline,
    )?);
    Ok(paths)
}

fn ancestor(
    repo: &Repo,
    ancestor: &Oid,
    of: &Oid,
    deadline: WriteDeadline,
) -> Result<bool, RepositoryError> {
    let ran = git::run(
        &repo.root,
        &[
            "merge-base",
            "--is-ancestor",
            ancestor.as_str(),
            of.as_str(),
        ],
        deadline.reads(),
    )?;
    match ran.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git::read_failed()),
    }
}

fn rebasing(repo: &Repo, deadline: WriteDeadline) -> Result<bool, RepositoryError> {
    Ok(sync::in_progress(&repo.root, deadline.reads())?
        .iter()
        .any(|running| matches!(running, InProgress::Rebase | InProgress::RebaseOrAm)))
}

/// Git exited without finishing. It either refused before it started, as a
/// `pre-rebase` hook can, or it stopped partway. A stop L1 Git can continue stays,
/// and this aborts any other.
fn stopped(
    repo: &Repo,
    txn: &RebaseTxn<'_>,
    head: &Head,
    wrote: &Wrote,
) -> Result<RepositoryError, RepositoryError> {
    let deadline = txn.runner().deadline();
    let said = stderr::summarize(wrote.stderr());
    if !rebasing(repo, deadline)? {
        return Ok(RepositoryError::new(
            ErrorKind::GitFailed,
            if repo.head(deadline)? == *head {
                format!("Git did not rebase, and nothing changed. Git said: {said}")
            } else {
                format!(
                    "Git stopped the rebase, but HEAD moved anyway. Check the history. Git said: {said}"
                )
            },
        ));
    }
    if let Some(progress) = progress(repo, deadline)? {
        return Ok(stopped_on(&progress, wrote.stderr()));
    }
    let (entries, _) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    let conflicts = merge::unresolved(&entries);
    let aborted = txn.abort().run(deadline)?;
    if aborted.code() != Some(0) || rebasing(repo, deadline)? || repo.head(deadline)? != *head {
        return Ok(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The rebase stopped, and L1 Git could not abort it. Finish or abort it with Git. Git said: {}",
                stderr::summarize(aborted.stderr())
            ),
        ));
    }
    Ok(if conflicts.is_empty() {
        RepositoryError::new(
            ErrorKind::GitFailed,
            format!(
                "The rebase stopped, so L1 Git aborted it and nothing changed. Git said: {said}"
            ),
        )
    } else {
        RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The rebase stopped on conflicts in {}, so L1 Git aborted it and nothing changed. Use Pull (Fast-forward if possible) to merge instead.",
                conflicts.join(", ")
            ),
        )
    })
}

fn unexpected() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        "Git stopped the rebase, but HEAD is not where L1 Git expected, so it has no undo entry for it. Check the history.",
    )
}

fn land(
    recorded: Recorded<'_>,
    runner: &impl Runner,
    before: &Head,
    onto: &Oid,
) -> Result<(), RepositoryError> {
    let deadline = runner.deadline();
    let after = runner.repo().head(deadline)?;
    let change =
        landed_change(runner.repo(), before, onto, &after, deadline)?.ok_or_else(unexpected)?;
    recorded
        .complete(runner, &Change::Rebase(change))
        .map_err(|error| {
            RepositoryError::new(
                error.kind,
                format!(
                    "Git finished the rebase, but L1 Git could not record it, so it cannot undo it. {}",
                    error.message
                ),
            )
        })
}

/// The old tip stays kept, because the rebased branch no longer reaches it.
fn landed_change(
    repo: &Repo,
    before: &Head,
    onto: &Oid,
    after: &Head,
    deadline: WriteDeadline,
) -> Result<Option<RebaseChange>, RepositoryError> {
    let (
        Head::Attached {
            reference: from, ..
        },
        Head::Attached { reference: to, .. },
    ) = (before, after)
    else {
        return Ok(None);
    };
    let (Some(old), Some(new)) = (refs::oid(before), refs::oid(after)) else {
        return Ok(None);
    };
    if from != to || old == new || !ancestor(repo, onto, &new, deadline)? {
        return Ok(None);
    }
    Ok(Some(RebaseChange::Landed(RefChange::new(
        before.clone(),
        after.clone(),
        Some(old),
    )?)))
}

fn already_landed(
    writing: &Writing<'_>,
    expect: &Expect,
) -> Result<Option<Applied>, RepositoryError> {
    refs::already_landed(writing, expect, |change| {
        if let Change::Rebase(RebaseChange::Landed(change)) = change {
            Some(change)
        } else {
            None
        }
    })
}

/// Settles a pending entry from Git alone. A rebase still in progress, or a
/// branch that does not contain `onto`, records nothing.
pub(super) fn landed(
    repo: &Repo,
    change: &RebaseChange,
    deadline: WriteDeadline,
) -> Result<Option<RebaseChange>, RepositoryError> {
    let RebaseChange::Pending { before, onto } = change else {
        return Ok(Some(change.clone()));
    };
    if rebasing(repo, deadline)? {
        return Ok(None);
    }
    landed_change(repo, before, onto, &repo.head(deadline)?, deadline)
}

pub(super) fn step(
    repo: &Repo,
    entry: &EntryObjects,
    change: &RebaseChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let RebaseChange::Landed(change) = change else {
        return Err(store::history_changed());
    };
    refs::restore_with(repo, entry, change, direction, Files::Follow, deadline)
}

fn state_dir(repo: &Repo) -> PathBuf {
    repo.git_dir.join("rebase-merge")
}

fn state_file(repo: &Repo, name: &str) -> Option<String> {
    fs::read_to_string(state_dir(repo).join(name))
        .ok()
        .map(|text| text.trim().to_owned())
}

/// The commits of a todo list, or `None` when a line is anything but a pick.
fn picks(todo: &str) -> Option<Vec<&str>> {
    todo.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let mut words = line.split_whitespace();
            match (words.next(), words.next()) {
                (Some("pick" | "p"), Some(commit)) => Some(commit),
                _ => None,
            }
        })
        .collect()
}

/// The single check for a rebase L1 Git can continue. Every merge-backend rebase
/// writes `rebase-merge/interactive`, so the todo list tells a plain one: every
/// command done and to do is a pick. Everything else stays an external operation:
/// another operation alongside, `rebase-apply`, an edit, exec, squash, fixup,
/// reword, or merge command, a detached rebase, and a stop with no `REBASE_HEAD` or
/// on a merge commit.
pub(super) fn in_flight(
    repo: &Repo,
    deadline: Deadline,
) -> Result<Option<RebaseOf>, RepositoryError> {
    if sync::in_progress(&repo.root, deadline)? != [InProgress::Rebase] {
        return Ok(None);
    }
    let file = |name| state_file(repo, name);
    let (Some(head_name), Some(onto), Some(orig_head), Some(done), Some(todo)) = (
        file("head-name"),
        file("onto"),
        file("orig-head"),
        file("done"),
        file("git-rebase-todo"),
    ) else {
        return Ok(None);
    };
    if picks(&done).is_none() || picks(&todo).is_none() {
        return Ok(None);
    }
    let (Ok(branch), Ok(onto), Ok(orig_head)) = (
        BranchRef::try_from(head_name),
        Oid::try_from(onto),
        Oid::try_from(orig_head),
    ) else {
        return Ok(None);
    };
    if !sync::pseudoref_exists(&repo.root, "REBASE_HEAD", deadline)? {
        return Ok(None);
    }
    let Some(step) = super::commit::resolve_within(repo, deadline, "REBASE_HEAD")? else {
        return Ok(None);
    };
    if replay::parents(repo, &step, deadline)?.len() > 1 {
        return Ok(None);
    }
    Ok(Some(RebaseOf {
        branch,
        onto,
        orig_head,
        step,
    }))
}

fn counts(repo: &Repo) -> Option<(u32, u32)> {
    let number = |name| state_file(repo, name)?.parse().ok();
    Some((number("msgnum")?, number("end")?))
}

/// The rebased branch's upstream when it points at `onto`, else a local branch,
/// else a remote-tracking one.
fn onto_name(
    repo: &Repo,
    of: &RebaseOf,
    deadline: WriteDeadline,
) -> Result<Option<String>, RepositoryError> {
    let upstream = git::line(&git::read(
        &repo.root,
        &["for-each-ref", "--format=%(upstream)", of.branch.as_str()],
        deadline.reads(),
    )?);
    let pointing = git::text(&git::read(
        &repo.root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "--points-at",
            of.onto.as_str(),
            "refs/heads",
            "refs/remotes",
        ],
        deadline.reads(),
    )?);
    let names: Vec<_> = pointing
        .lines()
        .filter(|name| !name.ends_with("/HEAD"))
        .collect();
    Ok(if names.contains(&upstream.as_str()) {
        Some(upstream)
    } else {
        names
            .iter()
            .find(|name| name.starts_with("refs/heads/"))
            .or_else(|| names.first())
            .map(|name| (*name).to_owned())
    })
}

/// `None` unless `in_flight` answers and `merge-tree` can name the step's footprint.
pub(super) fn progress(
    repo: &Repo,
    deadline: WriteDeadline,
) -> Result<Option<RebaseProgress>, RepositoryError> {
    let Some(of) = in_flight(repo, deadline.reads())? else {
        return Ok(None);
    };
    let head = repo.head(deadline)?;
    let (Some(current), Some((done, total))) = (refs::oid(&head), counts(repo)) else {
        return Ok(None);
    };
    let Some(Paths {
        footprint,
        conflicted,
    }) = replay::paths(repo, &of.pick(), &current, deadline)?
    else {
        return Ok(None);
    };
    let Resolution {
        unresolved,
        staged,
        tree,
        empty,
    } = replay::resolution(repo, &current, deadline)?;
    Ok(Some(RebaseProgress {
        root: repo.root(),
        onto_name: onto_name(repo, &of, deadline)?,
        subject: replay::subject(repo, &of.step, deadline)?,
        branch: of.branch,
        onto: of.onto,
        orig_head: of.orig_head,
        step: of.step,
        done,
        total,
        head,
        footprint,
        conflicted,
        unresolved,
        staged,
        tree,
        empty,
    }))
}

/// Where the resolver's undo history lives while this step lasts: the folder a
/// cherry-pick of the step onto HEAD would use.
pub(super) fn journal(repo: &Repo, progress: &RebaseProgress) -> Result<PathBuf, RepositoryError> {
    let head = refs::oid(&progress.head).ok_or_else(git::malformed)?;
    replay::journal(repo, &progress.of().pick(), &head)
}

/// A rebase whose footprint `merge-tree` cannot name reads as an external
/// operation, so it passes as one does.
pub(super) fn admit(
    repo: &Repo,
    operation: &Operation,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let Some(of) = in_flight(repo, deadline.reads())? else {
        return Ok(());
    };
    let Some(head) = refs::oid(&repo.head(deadline)?) else {
        return Ok(());
    };
    let Some(paths) = replay::paths(repo, &of.pick(), &head, deadline)? else {
        return Ok(());
    };
    replay::confine(
        "A rebase",
        ("Continue", "continue"),
        &paths.footprint,
        operation,
    )
}

fn stopped_on(progress: &RebaseProgress, output: &str) -> RepositoryError {
    let at = format!("commit {} of {}", progress.done, progress.total);
    if progress.unresolved.is_empty() {
        RepositoryError::new(
            ErrorKind::RebaseStopped {
                output: output.to_owned(),
            },
            format!(
                "Git stopped the rebase at {at} without committing it. The result is staged. Continue or abort the rebase."
            ),
        )
    } else {
        RepositoryError::new(
            ErrorKind::RebaseStopped {
                output: String::new(),
            },
            format!(
                "The rebase stopped on a conflict in {at}. Resolve it, then continue or abort the rebase."
            ),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Proceed {
    Continue,
    Skip,
}

impl Proceed {
    pub(super) const fn flag(self) -> &'static str {
        match self {
            Self::Continue => "--continue",
            Self::Skip => "--skip",
        }
    }
}

/// Every path the rest of the todo list writes. `git rebase` overwrites an ignored
/// file at one of them, silently.
fn remaining(repo: &Repo, deadline: WriteDeadline) -> Result<Vec<String>, RepositoryError> {
    let todo = state_file(repo, "git-rebase-todo").unwrap_or_default();
    let Some(commits) = picks(&todo) else {
        return Ok(Vec::new());
    };
    if commits.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec![
        "log",
        "--no-walk=unsorted",
        "--no-show-signature",
        "--format=",
        "--name-only",
        "--no-renames",
        "-z",
    ];
    args.extend(commits);
    merge::names(repo, STEPPING, &args, deadline)
}

/// Continues or skips the step Git stopped on. Both run on the global store and
/// record one entry for the whole rebase before Git runs, as Pull (Rebase) does.
/// It lands when this request ends the rebase, and it drops when Git stops on the
/// next step, so whichever request finishes the rebase holds its Undo.
pub(super) fn proceed(
    writing: &Writing<'_>,
    expect: &Expect,
    of: &RebaseOf,
    staged: &StagedStamp,
    tree: Option<&Oid>,
    how: Proceed,
) -> Result<Applied, RepositoryError> {
    let &Writing {
        repo,
        store,
        log,
        deadline,
        operation,
    } = writing;
    let before = of.before();
    if let Some(applied) = already_landed(
        writing,
        &Expect {
            head: before.clone(),
        },
    )? {
        return Ok(applied);
    }
    match in_flight(repo, deadline.reads())? {
        Some(found) if found == *of => {}
        Some(_) => {
            return Err(RepositoryError::stale(
                StaleReason::HeadMoved,
                "The rebase moved on to another commit since L1 Git showed it, so nothing changed. Refresh.",
            ));
        }
        None => {
            return Err(merge::refused(
                "No rebase that L1 Git can continue is in progress in this worktree. Refresh.",
            ));
        }
    }
    let head = repo.head_as_seen(expect, deadline)?;
    let current = refs::oid(&head).ok_or_else(git::malformed)?;
    replay::settle_journal(repo, &of.pick(), &current, deadline)?;
    merge::safe_index_for(repo, STEPPING, deadline)?;
    let (entries, stamp) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    if let Some(path) = entries.iter().find_map(|entry| match entry {
        StatusEntry::Unmerged { path, .. } => Some(path),
        StatusEntry::Ordinary { .. }
        | StatusEntry::Renamed { .. }
        | StatusEntry::Untracked { .. } => None,
    }) {
        return Err(merge::refused(format!(
            "{path} has a conflict. Mark it resolved before you continue."
        )));
    }
    let result = merge::staged_tree(repo, deadline)?;
    if stamp != *staged || tree.is_some_and(|tree| *tree != result) {
        return Err(RepositoryError::stale(
            StaleReason::StagedChanged,
            "The staged result changed since L1 Git showed it. Review it again before you continue.",
        ));
    }
    let empty = result == replay::tree_of(repo, &current, deadline)?;
    match how {
        Proceed::Continue if empty => {
            return Err(RepositoryError::new(
                ErrorKind::UnchangedPath,
                "The staged result matches HEAD, so this commit has nothing left to apply. Skip it instead.",
            ));
        }
        Proceed::Skip if !empty => {
            return Err(merge::refused(
                "The staged result differs from HEAD, and Skip would discard it. Continue the rebase instead.",
            ));
        }
        Proceed::Continue | Proceed::Skip => {}
    }
    if how == Proceed::Continue {
        let footprint = replay::known_footprint(repo, &of.pick(), &current, NAME, deadline)?;
        let extra = replay::outside(replay::staged_paths(repo, &current, deadline)?, &footprint);
        if !extra.is_empty() {
            return Err(merge::refused(format!(
                "Preserve these staged changes before you continue, because the commit being rebased does not change them: {}.",
                extra.join(", ")
            )));
        }
    }
    let edited: Vec<_> = replay::unstaged_paths(&entries).into_iter().collect();
    if !edited.is_empty() {
        return Err(merge::refused(match how {
            Proceed::Continue => format!(
                "These paths have unstaged edits, and Git continues a rebase only when every change is staged: {}. Stage them or undo the edits first.",
                edited.join(", ")
            ),
            Proceed::Skip => format!(
                "Skip would discard these unstaged edits: {}. Preserve them or undo the edits first.",
                edited.join(", ")
            ),
        }));
    }
    let collisions = merge::colliding_files(repo, STEPPING, &remaining(repo, deadline)?, deadline)?;
    if !collisions.is_empty() {
        return Err(merge::refused(format!(
            "Preserve these untracked or ignored files first, because the rest of the rebase would write to their paths: {}.",
            collisions.join(", ")
        )));
    }
    let (applied, _, mut recorded) = store.record_with(repo, log, operation, |_| {
        Ok(RebaseChange::Pending {
            before: before.clone(),
            onto: of.onto.clone(),
        })
    })?;
    recorded.durable()?;
    let txn = RebaseTxn::begin(repo, deadline)?;
    let wrote = recorded.pending_on_err(txn.proceed(how).run(deadline))?;
    let txn = txn.renewed();
    let deadline = txn.runner().deadline();
    // A killed Git may have finished. The next request settles from Git's state.
    if wrote.code().is_none() {
        recorded.stay_pending();
        return Err(wrote.succeeded().err().unwrap_or_else(git::read_failed));
    }
    if !rebasing(repo, deadline)? {
        land(recorded, txn.runner(), &before, &of.onto)?;
        return if wrote.code() == Some(0) {
            Ok(applied)
        } else {
            Err(RepositoryError::new(
                ErrorKind::AfterHookFailed {
                    output: wrote.stderr().to_owned(),
                },
                format!(
                    "Git finished the rebase, but it reported a problem. Check the history. Undo puts {} back where it was.",
                    of.branch.name()
                ),
            ))
        };
    }
    Err(still(repo, of, &wrote, deadline)?)
}

/// Git ran and the rebase is still in progress: on the next step, still on this
/// one because Git did not commit it, or somewhere L1 Git cannot continue.
fn still(
    repo: &Repo,
    of: &RebaseOf,
    wrote: &Wrote,
    deadline: WriteDeadline,
) -> Result<RepositoryError, RepositoryError> {
    let said = stderr::summarize(wrote.stderr());
    let Some(now) = progress(repo, deadline)? else {
        return Ok(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The rebase stopped where L1 Git cannot continue it. Continue it with git rebase --continue or end it with git rebase --abort. Git said: {said}"
            ),
        ));
    };
    if now.step != of.step {
        return Ok(stopped_on(&now, wrote.stderr()));
    }
    Ok(RepositoryError::new(
        ErrorKind::RebaseStopped {
            output: wrote.stderr().to_owned(),
        },
        format!(
            "Git did not commit this step, so the rebase is still on commit {} of {} and the result stays staged. Fix what Git reported, then continue or abort the rebase.",
            now.done, now.total
        ),
    ))
}

/// Before Git runs, refuses what `--abort` would destroy that is not the rebase's
/// own work. Git resets the index and the tracked files to `orig_head`, so it drops
/// a staged change outside the step's footprint, an unstaged edit anywhere but a
/// conflicted path, and an ignored file at a path `orig_head` tracks. The commits
/// replayed so far and the step's resolution are the rebase's own. Nothing records
/// the abort, so Undo cannot put the rebase back.
pub(super) fn abort(
    repo: &Repo,
    of: &RebaseOf,
    head: &Head,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let running = sync::in_progress(&repo.root, deadline.reads())?;
    if running.is_empty() {
        // A repeated abort finds the branch where the first one put it.
        return if repo.head(deadline)? == of.before() {
            Ok(())
        } else {
            Err(RepositoryError::stale(
                StaleReason::HeadMoved,
                "The rebase is no longer in progress, and it did not end with an abort. Refresh.",
            ))
        };
    }
    let Some(found) = in_flight(repo, deadline.reads())? else {
        return Err(merge::refused(format!(
            "{} is in progress in this worktree, and L1 Git cannot abort it. End it with Git.",
            refs::capitalized(running[0].name())
        )));
    };
    if found != *of || repo.head(deadline)? != *head {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "The rebase in progress changed since L1 Git showed it, so nothing changed. Refresh.",
        ));
    }
    let current = refs::oid(head).ok_or_else(git::malformed)?;
    replay::settle_journal(repo, &of.pick(), &current, deadline)?;
    merge::safe_index_for(repo, STEPPING, deadline)?;
    let Some(Paths {
        footprint,
        conflicted,
    }) = replay::paths(repo, &of.pick(), &current, deadline)?
    else {
        return Err(merge::refused(
            "L1 Git cannot work out which paths the rebase changes. End it with Git.",
        ));
    };
    let extra = replay::outside(replay::staged_paths(repo, &current, deadline)?, &footprint);
    if !extra.is_empty() {
        return Err(merge::refused(format!(
            "Abort would discard these staged changes, because the rebase does not change them: {}. Preserve them, then abort.",
            extra.join(", ")
        )));
    }
    let (entries, _) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    let edited = replay::outside(replay::unstaged_paths(&entries), &conflicted);
    if !edited.is_empty() {
        return Err(merge::refused(format!(
            "Abort would discard these unstaged edits, which resolve no conflict: {}. Preserve them, then abort.",
            edited.join(", ")
        )));
    }
    let mut restored = merge::names(
        repo,
        STEPPING,
        &[
            "diff-tree",
            "-r",
            "--no-renames",
            "--name-only",
            "-z",
            current.as_str(),
            of.orig_head.as_str(),
        ],
        deadline,
    )?;
    restored.extend(footprint);
    let collisions = merge::colliding_files(repo, STEPPING, &restored, deadline)?;
    if !collisions.is_empty() {
        return Err(merge::refused(format!(
            "Abort would overwrite these untracked or ignored files, because {} tracks their paths: {}. Preserve them, then abort.",
            of.branch.name(),
            collisions.join(", ")
        )));
    }
    let txn = RebaseTxn::begin(repo, deadline)?;
    let wrote = txn.abort().run(deadline)?;
    let deadline = deadline.renewed();
    wrote.succeeded()?;
    if rebasing(repo, deadline)? || repo.head(deadline)? != of.before() {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Git finished the abort, but the rebase or HEAD did not end as expected. Inspect the repository with Git.",
        ));
    }
    Ok(())
}
