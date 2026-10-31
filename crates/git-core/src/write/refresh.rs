use super::{Repo, txn::RefreshTxn};
use crate::{
    Coordinator, MoveSide, RepositoryError, Sides, StatusEntry, WorktreeStatus,
    git::{self, LocalRead, LocalWrite, WriteDeadline},
    status::worktree_status_within,
    sync::Writers,
};
use std::{collections::HashSet, path::Path};

impl Coordinator {
    /// Reads one worktree's status, then saves fresh stat data in the
    /// background when the index caches stale stat data. Reads run with
    /// optional locks off, so Git never saves it, and every read would hash
    /// those files again.
    pub fn worktree_status(&self, path: &str) -> Result<WorktreeStatus, RepositoryError> {
        let status = worktree_status_within(path, self.deadline(LocalRead::WorktreeStatus))?;
        let root = status.root.clone();
        let changed = changed_on_disk(&status.entries);
        let deadline = self.write_deadline(LocalWrite::RefreshIndex);
        self.refresh_later(move |writers| {
            let _ = refresh(writers, &root, &changed, deadline);
        });
        Ok(status)
    }
}

/// It never waits. A write that holds or wants the repository, or another
/// process's `index.lock`, skips it, and a write that starts waiting stops
/// it.
fn refresh(
    writers: &Writers,
    root: &str,
    changed: &HashSet<String>,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    if !stale(Path::new(root), changed, deadline)? {
        return Ok(());
    }
    let repo = Repo::open(root, deadline.reads())?;
    writers
        .unless_busy(&repo.common_dir, |wanted| {
            RefreshTxn::begin(&repo, deadline.renewed())?.refresh(wanted)
        })
        .unwrap_or(Ok(()))
}

/// `diff-files` compares stat data only, so it lists every entry whose file
/// was touched. One that status found unchanged on disk has stale stat data.
fn stale(
    root: &Path,
    changed: &HashSet<String>,
    deadline: WriteDeadline,
) -> Result<bool, RepositoryError> {
    let touched = git::read(
        root,
        &["diff-files", "--name-only", "-z", "--ignore-submodules"],
        deadline.reads(),
    )?;
    Ok(touched
        .split(|byte| *byte == 0)
        .any(|path| !path.is_empty() && !changed.contains(&git::text(path))))
}

fn changed_on_disk(entries: &[StatusEntry]) -> HashSet<String> {
    let mut changed = HashSet::new();
    for entry in entries {
        match entry {
            StatusEntry::Ordinary {
                path,
                sides: Sides::Unstaged { .. } | Sides::Both { .. },
                ..
            }
            | StatusEntry::Renamed {
                path,
                side: MoveSide::Staged {
                    unstaged: Some(_), ..
                },
                ..
            }
            | StatusEntry::Unmerged { path, .. } => {
                changed.insert(path.clone());
            }
            StatusEntry::Renamed {
                path,
                original,
                side: MoveSide::Unstaged { .. },
                ..
            } => {
                changed.insert(path.clone());
                changed.insert(original.clone());
            }
            StatusEntry::Ordinary {
                sides: Sides::Staged { .. },
                ..
            }
            | StatusEntry::Renamed {
                side: MoveSide::Staged { unstaged: None, .. },
                ..
            }
            | StatusEntry::Untracked { .. } => {}
        }
    }
    changed
}
