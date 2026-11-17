use super::{
    RefTxn, Repo, branches,
    checkout::{self, Landing},
    refs::capitalized,
};
use crate::{
    BranchRef, Coordinator, ErrorKind, Oid, RemoteRef, RepositoryError, directories,
    git::{Deadline, LocalRead, LocalWrite, Wrote},
    repository::{self, WorktreeRecord},
    sync,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Git writes this lock reason while `git worktree add` runs, and leaves it
/// when it was killed before it finished.
const INITIALIZING: &str = "initializing";

/// What a new worktree checks out: a branch the user picked, at the tip they
/// saw. The JSON matches `Start::Local` and `Start::Remote`. The core picks
/// the local branch by Check out's rules, so no caller names one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorktreeSource {
    Local { reference: BranchRef, oid: Oid },
    Remote { reference: RemoteRef, oid: Oid },
}

impl WorktreeSource {
    fn landing(&self, repo: &Repo, reads: Deadline) -> Result<Landing, RepositoryError> {
        match self {
            Self::Local { reference, oid } => Landing::local(repo, reference, oid, reads),
            Self::Remote { reference, oid } => Landing::remote(repo, reference, oid, reads),
        }
    }
}

/// What Create worktree would do, for the dialog. The write works it out
/// again under the write lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReview {
    /// `<parent of the main worktree>/.worktrees/<main folder>-<branch>`,
    /// with each `/` in the branch name written as `-`.
    pub folder: String,
    pub branch: WorktreeBranch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorktreeBranch {
    Existing {
        reference: BranchRef,
    },
    /// A source with nothing to track, such as a pull request's hidden ref,
    /// leaves `upstream` empty.
    New {
        reference: BranchRef,
        upstream: Option<RemoteRef>,
    },
}

/// A worktree Git made, named as the snapshot names it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWorktree {
    pub root: String,
    pub name: String,
    /// Git made the worktree, but its `post-checkout` hook failed or was
    /// stopped. The worktree stays.
    pub trouble: Option<RepositoryError>,
}

impl Coordinator {
    /// Reads what `create_worktree` would do with `source`, and refuses what
    /// it would refuse. Takes no lock.
    pub fn review_worktree(
        &self,
        path: &str,
        source: &WorktreeSource,
    ) -> Result<WorktreeReview, RepositoryError> {
        let reads = self.deadline(LocalRead::WorktreeReview);
        let repo = Repo::open(path, reads)?;
        let landing = source.landing(&repo, reads)?;
        landing.refuse_checked_out()?;
        let records = repository::worktree_records(&repo.root, reads)?;
        let main = records
            .iter()
            .find(|record| record.main)
            .and_then(|record| record.root.as_deref())
            .unwrap_or(&repo.root);
        Ok(WorktreeReview {
            folder: default_folder(main, &landing.branch)
                .to_string_lossy()
                .into_owned(),
            branch: match &landing.creates {
                None => WorktreeBranch::Existing {
                    reference: landing.branch.clone(),
                },
                Some(creates) => WorktreeBranch::New {
                    reference: landing.branch.clone(),
                    upstream: Some(creates.upstream.clone()),
                },
            },
        })
    }

    /// Makes a linked worktree at `folder`, missing or empty, on the branch
    /// `source` lands on. Git runs as the user, so hooks and filters run. It
    /// records no undo entry and never forces.
    ///
    /// When `folder` already is this repository's worktree on that branch, it
    /// answers that worktree again. When Git fails, it deletes the branch it
    /// made, so nothing changed.
    pub fn create_worktree(
        &self,
        path: &str,
        source: &WorktreeSource,
        folder: &Path,
    ) -> Result<NewWorktree, RepositoryError> {
        let typed = folder.to_str().ok_or_else(directories::unusable_location)?;
        let target = directories::resolved_target(folder);
        self.unrecorded(path, LocalWrite::CreateWorktree, |repo, _, _, deadline| {
            let reads = deadline.reads();
            let landing = source.landing(&repo, reads)?;
            if let Some(record) = at(&repository::worktree_records(&repo.root, reads)?, &target) {
                return answered(record, &landing.branch, typed);
            }
            // Before Git, because `worktree add -b` makes the branch first.
            directories::vacant(folder)?;
            landing.refuse_checked_out()?;
            let txn = RefTxn::begin(&repo, deadline)?;
            let name = landing.branch.name();
            let args = match &landing.creates {
                None => vec!["add", "--quiet", typed, name],
                Some(creates) => vec![
                    "add",
                    "--quiet",
                    "--track",
                    "-b",
                    name,
                    typed,
                    creates.upstream.as_str(),
                ],
            };
            let ran = txn.worktree(&args).run(deadline);
            let reads = deadline.renewed().reads();
            if let Some(record) = at(&repository::worktree_records(&repo.root, reads)?, &target)
                && let Some(made) = finished(record, &landing.branch)
            {
                return Ok(NewWorktree {
                    trouble: checkout::hook_trouble(
                        ran,
                        &format!("Git made the worktree {}", made.name),
                        "Remove worktree takes it away.",
                    ),
                    ..made
                });
            }
            if let Some(creates) = &landing.creates {
                creates.new.forget(&txn.renewed()?, &repo, &landing.tip)?;
            }
            Err(checkout::refusal(ran))
        })
    }

    /// Removes a clean linked worktree with `git worktree remove`, never
    /// `--force`, and keeps its branch. Drops the undo entries recorded in it
    /// that only it could run, and records none.
    ///
    /// A `worktree` Git no longer lists answers `Ok` after the same drop, so
    /// a retry converges.
    pub fn remove_worktree(&self, path: &str, worktree: &str) -> Result<(), RepositoryError> {
        if !Path::new(worktree).is_absolute() {
            return Err(directories::unusable_location());
        }
        let wanted = directories::resolved_target(Path::new(worktree));
        self.unrecorded(
            path,
            LocalWrite::RemoveWorktree,
            |opened, store, log, deadline| {
                let reads = deadline.reads();
                let records = repository::worktree_records(&opened.root, reads)?;
                let Some(record) = at(&records, &wanted) else {
                    return store.forget_worktree(&log, &wanted.to_string_lossy());
                };
                let name = record.name();
                refuse_removal(&opened, record, &name, reads)?;
                let txn = RefTxn::begin(&opened, deadline)?;
                let ran = txn.worktree(&["remove", &record.listed]).run(deadline);
                let reads = deadline.renewed().reads();
                if at(&repository::worktree_records(&opened.root, reads)?, &wanted).is_some() {
                    return Err(removal_refusal(ran, &name));
                }
                let root = record.root.as_deref().unwrap_or(Path::new(&record.listed));
                store.forget_worktree(&log, &root.to_string_lossy())
            },
        )
    }
}

/// The record Git keeps for the folder at `target`, which may be missing.
fn at<'r>(records: &'r [WorktreeRecord], target: &Path) -> Option<&'r WorktreeRecord> {
    records
        .iter()
        .find(|record| record.root.as_deref().unwrap_or(Path::new(&record.listed)) == target)
}

/// The record as a finished worktree on `branch`.
fn finished(record: &WorktreeRecord, branch: &BranchRef) -> Option<NewWorktree> {
    let root = record.root.as_ref()?;
    (record.branch() == Some(branch.as_str())
        && !record.prunable
        && record.locked.as_deref() != Some(INITIALIZING))
    .then(|| NewWorktree {
        root: root.to_string_lossy().into_owned(),
        name: record.name(),
        trouble: None,
    })
}

/// What a create answers when Git already registers its folder: the same
/// worktree again, or a refusal that names the fix, because Git would
/// otherwise answer with advice to force.
fn answered(
    record: &WorktreeRecord,
    branch: &BranchRef,
    folder: &str,
) -> Result<NewWorktree, RepositoryError> {
    if let Some(made) = finished(record, branch) {
        return Ok(made);
    }
    let refused = |message: String| Err(RepositoryError::new(ErrorKind::Conflict, message));
    if record.locked.as_deref() == Some(INITIALIZING) {
        return refused(format!(
            "Git was stopped while it made the worktree at {folder}. Run git worktree remove --force --force {} in a terminal, then try again.",
            record.listed
        ));
    }
    if record.root.is_none() || record.prunable {
        return refused(format!(
            "Git still lists a worktree at {folder}, but its folder is missing or no longer a worktree. Run git worktree prune in a terminal, or choose another folder."
        ));
    }
    let on = record.branch().map_or("a detached HEAD", branches::short);
    refused(format!(
        "{folder} is already a worktree of this repository, on {on}. Choose another folder."
    ))
}

fn refuse_removal(
    opened: &Repo,
    record: &WorktreeRecord,
    name: &str,
    reads: Deadline,
) -> Result<(), RepositoryError> {
    let refused = |kind, message: String| Err(RepositoryError::new(kind, message));
    if record.main {
        return refused(
            ErrorKind::UnsupportedPath,
            format!(
                "{name} is this repository's main worktree, and Git removes only linked worktrees."
            ),
        );
    }
    if record.root.as_deref() == Some(&opened.root) {
        return refused(
            ErrorKind::Conflict,
            format!(
                "{name} is the worktree you have open. Open another worktree of this repository to remove this one."
            ),
        );
    }
    match record.locked.as_deref() {
        Some(INITIALIZING) => {
            return refused(
                ErrorKind::Conflict,
                format!(
                    "Git was stopped while it made {name}. Run git worktree remove --force --force {} in a terminal to finish removing it.",
                    record.listed
                ),
            );
        }
        Some(reason) => {
            let why = if reason.is_empty() {
                String::new()
            } else {
                format!(" ({reason})")
            };
            return refused(
                ErrorKind::Conflict,
                format!(
                    "{name} is locked{why}, so L1 Git leaves it alone. Run git worktree unlock {} in a terminal first.",
                    record.listed
                ),
            );
        }
        None => {}
    }
    let Some(root) = &record.root else {
        return Ok(());
    };
    // Git removes a clean worktree that is stopped mid-rebase, and its
    // rebase state with it.
    let target = opened.worktree(&root.to_string_lossy(), reads)?;
    match sync::in_progress(&target.root, reads)?.first() {
        Some(operation) => refused(
            ErrorKind::Conflict,
            format!(
                "{} is in progress in {name}. Finish or abort it there, then remove the worktree.",
                capitalized(operation.name())
            ),
        ),
        None => Ok(()),
    }
}

fn removal_refusal(ran: Result<Wrote, RepositoryError>, name: &str) -> RepositoryError {
    if let Ok(wrote) = &ran
        && wrote
            .stderr()
            .contains("contains modified or untracked files")
    {
        return RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "{name} has uncommitted or untracked files. Commit, stash, or discard them there, then remove the worktree."
            ),
        );
    }
    checkout::refusal(ran)
}

/// `<main parent>/.worktrees/<main folder>-<branch with / as ->`.
fn default_folder(main: &Path, branch: &BranchRef) -> PathBuf {
    main.parent()
        .unwrap_or(main)
        .join(".worktrees")
        .join(format!(
            "{}-{}",
            repository::display_name(main),
            branch.name().replace('/', "-")
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_folder_sits_beside_the_main_worktree_and_flattens_the_branch() {
        let branch = BranchRef::try_from("refs/heads/feat/ui/x".to_owned()).unwrap();
        assert_eq!(
            default_folder(Path::new("/u/src/l1git"), &branch),
            Path::new("/u/src/.worktrees/l1git-feat-ui-x")
        );
    }
}
