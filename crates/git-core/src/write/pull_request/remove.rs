use super::{PullCheckout, PullHead, PullKey, Relation, seen_at, state, state::holder};
use crate::{
    BranchRef, BranchTip, Coordinator, Oid, RepositoryError, WantedCommits,
    git::{Deadline, LocalWrite},
    repository::{self, WorktreeRecord},
    write::{
        RefTxn, Repo, branches,
        branches::{Listing, Setting},
        worktrees,
    },
};
use std::path::Path;

impl Coordinator {
    /// Removes the worktree that has `pr/<number>` checked out with
    /// `git worktree remove`, never `--force`, by the same refusals as
    /// Remove worktree, run from the main worktree. Then deletes the branch
    /// when it is still at `seen` and every commit on it is in the head, and
    /// keeps it otherwise. Remotes stay. It records no undo entry, and drops
    /// the entries only that worktree could run. The head is fetched first by
    /// its id from the base remote, under the gate, within the short
    /// `optional_fetch_deadline`, the wait for the gate included. When that
    /// fails, it still removes the worktree, and keeps a branch it cannot
    /// compare.
    pub fn remove_pull_request(
        &self,
        path: &str,
        pull: &PullKey,
        head: &PullHead,
        seen: &Oid,
    ) -> Result<PullCheckout, RepositoryError> {
        let _ = WantedCommits::try_from(vec![head.oid.clone()])
            .and_then(|wanted| self.fetch_optional_commits(path, &pull.github, &wanted));
        self.unrecorded(
            path,
            LocalWrite::RemovePullRequest,
            |opened, store, log, deadline| {
                let reads = deadline.reads();
                let branch = pull.branch()?;
                let listing = Listing::read(&opened, reads)?;
                let main = main_worktree(opened, listing.worktrees(), reads)?;
                listing.refuse_symbolic(&branch)?;
                let slot = listing.slot(&branch)?;
                if slot.tip.is_none() && holder(listing.worktrees(), &branch).is_none() {
                    return state::read(&main, pull, head, reads);
                }
                let tip = seen_at(&listing, &branch, seen)?;
                let relation = state::compare(&main.root, &tip, &head.oid, reads)?;
                let plan = state::plan(&main, listing.worktrees(), &branch, pull, head, reads)?;
                let txn = RefTxn::begin(&main, deadline)?;
                let removed = match holder(listing.worktrees(), &branch) {
                    None => false,
                    Some(record) => {
                        let name = record.name();
                        worktrees::refuse_removal(&main, record, &name, reads)?;
                        let ran = txn.worktree(&["remove", &record.listed]).run(deadline);
                        let reads = deadline.renewed().reads();
                        let listed = |found: &WorktreeRecord| found.listed == record.listed;
                        let stays = repository::worktree_records(&main.root, reads).map_or_else(
                            |_| !ran.as_ref().is_ok_and(|ran| ran.code() == Some(0)),
                            |records| records.iter().any(listed),
                        );
                        if stays {
                            return Err(worktrees::removal_refusal(ran, &name));
                        }
                        let root = record.root.as_deref().unwrap_or(Path::new(&record.listed));
                        // Once the worktree is gone, Remove answers the copy
                        // as it is, so a step that fails from here on keeps
                        // what it would have tidied away.
                        let _ = store.forget_worktree(&log, &root.to_string_lossy());
                        true
                    }
                };
                let deleted = matches!(relation, Relation::UpToDate | Relation::Behind { .. })
                    && match txn
                        .renewed()
                        .and_then(|txn| delete(&txn, &branch, &tip, &slot.config))
                    {
                        Ok(()) => true,
                        Err(error) if !removed => return Err(error),
                        Err(_) => false,
                    };
                Ok(if deleted {
                    PullCheckout::Absent { branch, plan }
                } else {
                    PullCheckout::Parked {
                        branch,
                        tip,
                        relation,
                        plan,
                    }
                })
            },
        )
    }
}

/// The main worktree, or `opened` when the main one is a bare repository,
/// which Git lists with no HEAD.
fn main_worktree(
    opened: Repo,
    records: &[WorktreeRecord],
    reads: Deadline,
) -> Result<Repo, RepositoryError> {
    match records
        .iter()
        .find(|record| record.main && record.head.is_some())
        .and_then(|record| record.root.as_deref())
    {
        Some(main) if main != opened.root => opened.worktree(&main.to_string_lossy(), reads),
        Some(_) | None => Ok(opened),
    }
}

/// Deletes `branch` at `tip`. A section of settings that Git fails to drop
/// stays behind for a branch that no longer exists.
fn delete(
    txn: &RefTxn<'_>,
    branch: &BranchRef,
    tip: &Oid,
    config: &[Setting],
) -> Result<(), RepositoryError> {
    branches::run_delete(
        txn,
        &BranchTip {
            reference: branch.clone(),
            oid: tip.clone(),
        },
    )?;
    let _ = branches::set_config(txn, branch, config, &[]);
    Ok(())
}
