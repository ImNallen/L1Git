#![deny(
    clippy::wildcard_enum_match_arm,
    clippy::match_wildcard_for_single_variants
)]

mod index;
mod store;
mod txn;

use crate::{
    Coordinator, ErrorKind, Head, Oid, RepositoryError, StatusEntry,
    git::{self, Deadline, LocalRead, LocalWrite, WriteDeadline},
    repository,
};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use store::{LockedStore, Log, Position, Store};
pub(crate) use txn::{HOOK_OFF, Published, Txn};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    /// Stages what is on disk at each entry's paths, as `git add` does. The
    /// entries are `worktreeStatus` entries, sent back unchanged. An unmerged
    /// path is marked resolved.
    StageFiles { entries: Vec<StatusEntry> },
    /// Puts each entry's paths back to HEAD's version in the index, or
    /// removes them before the first commit. Unmerged paths are refused.
    UnstageFiles { entries: Vec<StatusEntry> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expect {
    /// The worktree's HEAD as `worktreeStatus` reported it.
    pub head: Head,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub id: EntryId,
    /// The worktree the write changed. One history covers every worktree of
    /// a repository, so this can differ from the request's `path`.
    pub root: String,
    pub operation: Operation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoHistory {
    pub undo: Option<Applied>,
    pub redo: Option<Applied>,
}

/// 16 lowercase hex digits on the wire. A newer entry has a larger id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct EntryId(u64);

impl EntryId {
    fn after(newest: Option<Self>) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| {
                u64::try_from(since.as_nanos()).unwrap_or(u64::MAX)
            });
        Self(newest.map_or(now, |newest| now.max(newest.0 + 1)))
    }
}

impl TryFrom<String> for EntryId {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if let Ok(id) = u64::from_str_radix(&value, 16)
            && Self(id).to_string() == value
        {
            return Ok(Self(id));
        }
        Err("Use an undo entry id that L1 Git gave.")
    }
}

impl From<EntryId> for String {
    fn from(value: EntryId) -> Self {
        value.to_string()
    }
}

impl fmt::Display for EntryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:016x}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "domain", rename_all = "camelCase")]
enum Change {
    Index(index::IndexChange),
}

impl Change {
    fn objects(&self) -> Vec<Oid> {
        match self {
            Self::Index(change) => change.objects(),
        }
    }

    fn restore(
        &self,
        txn: &Txn<'_>,
        entry: &store::EntryObjects,
        direction: Direction,
    ) -> Result<Restored, RepositoryError> {
        match self {
            Self::Index(change) => index::restore(txn, entry, change, direction),
        }
    }

    fn landed(&self, repo: &Repo, deadline: WriteDeadline) -> Result<bool, RepositoryError> {
        match self {
            Self::Index(change) => index::landed(repo, change, deadline),
        }
    }

    fn touches_skip_worktree(&self) -> bool {
        match self {
            Self::Index(change) => change.touches_skip_worktree(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Restored {
    AlreadyThere,
    Staged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Undo,
    Redo,
}

impl Direction {
    const fn write(self) -> LocalWrite {
        match self {
            Self::Undo => LocalWrite::Undo,
            Self::Redo => LocalWrite::Redo,
        }
    }
}

impl Operation {
    fn local_write(&self) -> LocalWrite {
        match self {
            Self::StageFiles { .. } => LocalWrite::StageFiles,
            Self::UnstageFiles { .. } => LocalWrite::UnstageFiles,
        }
    }

    fn apply<'r>(
        &self,
        repo: &'r Repo,
        deadline: WriteDeadline,
        expect: &Expect,
    ) -> Result<(Txn<'r>, Change), RepositoryError> {
        match self {
            Self::StageFiles { entries } => {
                index::edit(repo, deadline, expect, index::Command::Stage, entries)
            }
            Self::UnstageFiles { entries } => {
                index::edit(repo, deadline, expect, index::Command::Unstage, entries)
            }
        }
    }
}

struct Repo {
    root: PathBuf,
    common_dir: PathBuf,
    git_dir: PathBuf,
    index: PathBuf,
    objects: PathBuf,
    /// Where Git looks for the `post-index-change` hook, after
    /// `core.hooksPath`. Relative, because an absolute form fails when
    /// `core.hooksPath` is `/dev/null`.
    hook: PathBuf,
    null_oid: String,
}

impl Repo {
    fn open(path: &str, deadline: Deadline) -> Result<Self, RepositoryError> {
        let root = repository::root(path, deadline)?;
        let output = git::read(
            &root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
                "--absolute-git-dir",
                "--git-path",
                "index",
                "--git-path",
                "objects",
                "--path-format=relative",
                "--git-path",
                "hooks/post-index-change",
                "--show-object-format",
            ],
            deadline,
        )?;
        let text = String::from_utf8(output).map_err(|_| repository::non_utf8_path())?;
        let [common_dir, git_dir, index, objects, hook, format] =
            text.lines().collect::<Vec<_>>()[..]
        else {
            return Err(git::malformed());
        };
        let null_oid = match format {
            "sha1" => "0".repeat(40),
            "sha256" => "0".repeat(64),
            _ => return Err(git::malformed()),
        };
        Ok(Self {
            common_dir: repository::canonical(common_dir)?,
            git_dir: git_dir.into(),
            index: index.into(),
            objects: objects.into(),
            hook: root.join(hook),
            null_oid,
            root,
        })
    }

    fn root(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn head(&self, deadline: WriteDeadline) -> Result<Head, RepositoryError> {
        repository::head(&self.root, deadline.reads())
    }

    fn worktree(&self, root: &str, deadline: Deadline) -> Result<Self, RepositoryError> {
        match Self::open(root, deadline) {
            Ok(repo) if repo.common_dir == self.common_dir => Ok(repo),
            Ok(_)
            | Err(RepositoryError {
                kind: ErrorKind::MissingPath | ErrorKind::NotRepository,
                ..
            }) => Err(RepositoryError::new(
                ErrorKind::MissingPath,
                format!(
                    "{root} is no longer a worktree of this repository, so L1 Git cannot change it."
                ),
            )),
            Err(error) => Err(error),
        }
    }
}

impl Coordinator {
    pub fn write(
        &self,
        path: &str,
        operation: &Operation,
        expect: &Expect,
    ) -> Result<Applied, RepositoryError> {
        let (applied, published) = self.locked(
            path,
            operation.local_write(),
            |repo, store, log, deadline| {
                let (txn, change) = operation.apply(&repo, deadline, expect)?;
                txn.commit_write(store, &log, operation, &change)
            },
        )?;
        published.run_hook();
        Ok(applied)
    }

    /// Undoes `id` if it is the next entry to undo. If it is the next entry
    /// to redo, it was already undone, so this answers it again and changes
    /// nothing. Any other id answers `staleView`.
    pub fn undo(&self, path: &str, id: EntryId) -> Result<Applied, RepositoryError> {
        self.step(path, id, Direction::Undo)
    }

    /// The mirror of `undo`.
    pub fn redo(&self, path: &str, id: EntryId) -> Result<Applied, RepositoryError> {
        self.step(path, id, Direction::Redo)
    }

    /// The next entry to undo and the next to redo. Takes no lock.
    pub fn undo_history(&self, path: &str) -> Result<UndoHistory, RepositoryError> {
        let repo = Repo::open(path, self.deadline(LocalRead::UndoHistory))?;
        let store = Store::open(self.undo_dir(), &repo.common_dir)?;
        let log = store.log()?;
        let applied = |id: Option<EntryId>| id.map(|id| store.applied(id)).transpose();
        Ok(UndoHistory {
            undo: applied(log.next_undo())?,
            redo: applied(log.next_redo())?,
        })
    }

    fn locked<T>(
        &self,
        path: &str,
        write: LocalWrite,
        work: impl FnOnce(Repo, &LockedStore, Log, WriteDeadline) -> Result<T, RepositoryError>,
    ) -> Result<T, RepositoryError> {
        let deadline = self.write_deadline(write);
        let repo = Repo::open(path, deadline.reads())?;
        let common_dir = repo.common_dir.clone();
        self.writing(&common_dir, || {
            let store = LockedStore::lock(self.undo_dir(), &common_dir, deadline.reads())?;
            let deadline = deadline.renewed();
            let log = store.settled_log(&repo, deadline)?;
            work(repo, &store, log, deadline)
        })
    }

    fn step(
        &self,
        path: &str,
        id: EntryId,
        direction: Direction,
    ) -> Result<Applied, RepositoryError> {
        let (applied, published) =
            self.locked(path, direction.write(), |opened, store, log, deadline| {
                let step = match log.position(id, direction) {
                    Position::Next(step) => step,
                    Position::AlreadyDone => return Ok((store.applied(id)?, None)),
                    Position::Elsewhere => return Err(store::history_changed()),
                };
                let (applied, change) = store.record_of(id)?;
                let repo = if applied.root == opened.root() {
                    opened
                } else {
                    opened.worktree(&applied.root, deadline.reads())?
                };
                let txn = Txn::begin(&repo, deadline)?;
                match change.restore(&txn, &store.entry(id), direction)? {
                    Restored::AlreadyThere => {
                        store.save(step.log())?;
                        Ok((applied, None))
                    }
                    Restored::Staged => Ok((applied, Some(txn.commit_step(store, step, &change)?))),
                }
            })?;
        if let Some(published) = published {
            published.run_hook();
        }
        Ok(applied)
    }
}
