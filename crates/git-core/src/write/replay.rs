use super::{
    Operation, Repo, commit,
    merge::{self, Edit},
    refs,
};
use crate::{
    Head, Oid, RepositoryError, StagedStamp,
    git::{self, WriteDeadline},
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

    pub(super) const fn operation(self) -> InProgress {
        match self {
            Self::CherryPick => InProgress::CherryPick,
            Self::Revert => InProgress::Revert,
        }
    }

    const fn slug(self) -> &'static str {
        match self {
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
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
        of.kind.slug(),
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

/// The conflicted paths and every path the simulated result changes. These come
/// from trees, so index edits cannot widen them and resolving cannot shrink them.
/// `merge-tree` runs custom merge drivers, so each (kind, commit, HEAD) runs it
/// once, and the memo keeps the answer. Losing the memo costs one more run.
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
    let changed = git::read(
        &repo.root,
        &[
            "diff-tree",
            "-r",
            "--no-renames",
            "--name-only",
            "-z",
            head.as_str(),
            simulated.tree.as_str(),
        ],
        deadline.reads(),
    )?;
    let Some(changed) = listed_paths(&changed) else {
        return Ok(None);
    };
    let paths: Vec<_> = simulated.conflicted.union(&changed).cloned().collect();
    let _ = prepared(repo, of, head).and_then(|_| merge::persist(&memo, &paths));
    Ok(Some(paths))
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

/// `None` unless `in_flight` answers and `merge-tree` can name the footprint. A
/// pick from a terminal and a pick from L1 Git read the same.
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
    let subject = git::line(&git::read(
        &repo.root,
        &["show", "-s", "--format=%s", of.commit.as_str()],
        deadline.reads(),
    )?);
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

/// Index edits within the footprint pass. Anything else refuses and says why. A
/// replay whose footprint `merge-tree` cannot name reads as an external operation,
/// so it passes as one does.
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
        Edit::Refused => Err(merge::refused(format!(
            "{name} is in progress in this worktree. Only resolution and index edits within its affected paths are available until Finish or Abort."
        ))),
    }
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
    let lines: Vec<_> = merge_msg.split_inclusive('\n').collect();
    let bare = |line: &str| line.trim_end_matches('\n').to_owned();
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
