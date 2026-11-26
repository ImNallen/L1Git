use super::{CheckedOut, Plan, PullCheckout, PullHead, PullKey, upstream::Upstream};
use crate::{
    BranchRef, InProgress, Oid, RepositoryError,
    git::{self, Deadline},
    repository::WorktreeRecord,
    sync,
    write::{Repo, branches::Listing, worktrees},
};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Relation {
    UpToDate,
    /// The author pushed `commits` that the branch lacks.
    Behind {
        commits: u32,
    },
    /// The branch has `commits` that the head lacks.
    Ahead {
        commits: u32,
    },
    /// Both moved, as after a force-push.
    Diverged {
        ahead: u32,
        behind: u32,
    },
    /// This repository lacks the head, so it cannot compare them yet.
    Unfetched,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Changes {
    Clean,
    /// Changed or untracked files.
    Uncommitted,
    InProgress {
        operation: InProgress,
    },
    /// Git lists the worktree, and its folder is missing.
    Missing,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Apart {
    pub(super) ahead: u32,
    pub(super) behind: u32,
}

pub(super) const fn relation(apart: Apart) -> Relation {
    match apart {
        Apart {
            ahead: 0,
            behind: 0,
        } => Relation::UpToDate,
        Apart { ahead: 0, behind } => Relation::Behind { commits: behind },
        Apart { ahead, behind: 0 } => Relation::Ahead { commits: ahead },
        Apart { ahead, behind } => Relation::Diverged { ahead, behind },
    }
}

pub(super) fn compare(
    root: &Path,
    tip: &Oid,
    head: &Oid,
    reads: Deadline,
) -> Result<Relation, RepositoryError> {
    if !has_commit(root, head, reads)? {
        return Ok(Relation::Unfetched);
    }
    let range = format!("{}...{}", tip.as_str(), head.as_str());
    let counted = git::line(&git::read(
        root,
        &["rev-list", "--left-right", "--count", &range],
        reads,
    )?);
    let (ahead, behind) = counted.split_once('\t').ok_or_else(git::malformed)?;
    let count = |side: &str| side.parse().map_err(|_| git::malformed());
    Ok(relation(Apart {
        ahead: count(ahead)?,
        behind: count(behind)?,
    }))
}

pub(super) fn has_commit(root: &Path, oid: &Oid, reads: Deadline) -> Result<bool, RepositoryError> {
    let object = format!("{}^{{commit}}", oid.as_str());
    Ok(git::run(root, &["cat-file", "-e", &object], reads)?
        .status
        .success())
}

pub(super) fn holder<'r>(
    records: &'r [WorktreeRecord],
    branch: &BranchRef,
) -> Option<&'r WorktreeRecord> {
    records
        .iter()
        .find(|record| record.branch() == Some(branch.as_str()))
}

pub(super) fn read(
    repo: &Repo,
    pull: &PullKey,
    head: &PullHead,
    reads: Deadline,
) -> Result<PullCheckout, RepositoryError> {
    let branch = pull.branch()?;
    let listing = Listing::read(repo, reads)?;
    let plan = || plan(repo, listing.worktrees(), &branch, pull, head, reads);
    let Some(tip) = listing.slot(&branch)?.tip else {
        return Ok(PullCheckout::Absent {
            plan: plan()?,
            branch,
        });
    };
    let relation = compare(&repo.root, &tip, &head.oid, reads)?;
    Ok(match holder(listing.worktrees(), &branch) {
        Some(record) => PullCheckout::Ready {
            worktree: checked_out(record, reads)?,
            branch,
            tip,
            relation,
        },
        None => PullCheckout::Parked {
            plan: plan()?,
            branch,
            tip,
            relation,
        },
    })
}

fn plan(
    repo: &Repo,
    records: &[WorktreeRecord],
    branch: &BranchRef,
    pull: &PullKey,
    head: &PullHead,
    reads: Deadline,
) -> Result<Plan, RepositoryError> {
    let main = records
        .iter()
        .find(|record| record.main)
        .and_then(|record| record.root.as_deref())
        .unwrap_or(&repo.root);
    Ok(Plan {
        folder: worktrees::default_folder(main, branch)
            .to_string_lossy()
            .into_owned(),
        pushes: Upstream::of(&repo.root, pull, head, reads)?.pushes(),
    })
}

fn checked_out(record: &WorktreeRecord, reads: Deadline) -> Result<CheckedOut, RepositoryError> {
    let changes = match record.root.as_deref() {
        Some(root) if !record.prunable => changes(root, reads)?,
        Some(_) | None => Changes::Missing,
    };
    Ok(CheckedOut {
        root: record.root.as_deref().map_or_else(
            || record.listed.clone(),
            |root| root.to_string_lossy().into_owned(),
        ),
        name: record.name(),
        main: record.main,
        changes,
        trouble: None,
    })
}

fn changes(root: &Path, reads: Deadline) -> Result<Changes, RepositoryError> {
    if let Some(operation) = sync::in_progress(root, reads)?.first() {
        return Ok(Changes::InProgress {
            operation: *operation,
        });
    }
    let status = git::read(root, &["status", "--porcelain=v1", "-z"], reads)?;
    Ok(if status.is_empty() {
        Changes::Clean
    } else {
        Changes::Uncommitted
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_relation_names_which_side_moved() {
        for ((ahead, behind), expected) in [
            ((0, 0), Relation::UpToDate),
            ((0, 3), Relation::Behind { commits: 3 }),
            ((2, 0), Relation::Ahead { commits: 2 }),
            (
                (2, 1),
                Relation::Diverged {
                    ahead: 2,
                    behind: 1,
                },
            ),
        ] {
            assert_eq!(relation(Apart { ahead, behind }), expected);
        }
    }
}
