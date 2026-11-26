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

/// `pr/<number>` against the pull request's head.
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

/// What the worktree holds beside its branch.
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

/// `counts` is `(ahead, behind)` of the branch against the head, or `None`
/// when this repository lacks the head.
pub(super) const fn relation(counts: Option<(u32, u32)>) -> Relation {
    match counts {
        None => Relation::Unfetched,
        Some((0, 0)) => Relation::UpToDate,
        Some((0, behind)) => Relation::Behind { commits: behind },
        Some((ahead, 0)) => Relation::Ahead { commits: ahead },
        Some((ahead, behind)) => Relation::Diverged { ahead, behind },
    }
}

pub(super) fn counts(
    root: &Path,
    tip: &Oid,
    head: &Oid,
    reads: Deadline,
) -> Result<Option<(u32, u32)>, RepositoryError> {
    if !has_commit(root, head, reads)? {
        return Ok(None);
    }
    let range = format!("{}...{}", tip.as_str(), head.as_str());
    let counted = git::line(&git::read(
        root,
        &["rev-list", "--left-right", "--count", &range],
        reads,
    )?);
    let parsed = counted
        .split_once('\t')
        .and_then(|(ahead, behind)| Some((ahead.parse().ok()?, behind.parse().ok()?)));
    parsed.map(Some).ok_or_else(git::malformed)
}

pub(super) fn has_commit(root: &Path, oid: &Oid, reads: Deadline) -> Result<bool, RepositoryError> {
    let object = format!("{}^{{commit}}", oid.as_str());
    Ok(git::run(root, &["cat-file", "-e", &object], reads)?
        .status
        .success())
}

/// The worktree that has `branch` checked out.
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
    let relation = relation(counts(&repo.root, &tip, &head.oid, reads)?);
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
        for (counts, expected) in [
            (None, Relation::Unfetched),
            (Some((0, 0)), Relation::UpToDate),
            (Some((0, 3)), Relation::Behind { commits: 3 }),
            (Some((2, 0)), Relation::Ahead { commits: 2 }),
            (
                Some((2, 1)),
                Relation::Diverged {
                    ahead: 2,
                    behind: 1,
                },
            ),
        ] {
            assert_eq!(relation(counts), expected, "{counts:?}");
        }
    }
}
