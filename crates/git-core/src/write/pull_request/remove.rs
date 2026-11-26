use super::{PullCheckout, PullHead, PullKey, Relation, seen_at, state, state::holder};
use crate::{
    BranchTip, Coordinator, Oid, RepositoryError, WantedCommits,
    git::{Deadline, LocalWrite},
    repository::{self, WorktreeRecord},
    write::{RefTxn, Repo, branches, branches::Listing, worktrees},
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
    /// `optional_fetch_deadline`. When that fails, it still removes the
    /// worktree, and keeps a branch it cannot compare.
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
                let txn = RefTxn::begin(&main, deadline)?;
                if let Some(record) = holder(listing.worktrees(), &branch) {
                    let name = record.name();
                    worktrees::refuse_removal(&main, record, &name, reads)?;
                    let ran = txn.worktree(&["remove", &record.listed]).run(deadline);
                    let reads = deadline.renewed().reads();
                    let listed = |found: &WorktreeRecord| found.listed == record.listed;
                    if repository::worktree_records(&main.root, reads)?
                        .iter()
                        .any(listed)
                    {
                        return Err(worktrees::removal_refusal(ran, &name));
                    }
                    let root = record.root.as_deref().unwrap_or(Path::new(&record.listed));
                    store.forget_worktree(&log, &root.to_string_lossy())?;
                }
                let reads = deadline.renewed().reads();
                let relation = state::compare(&main.root, &tip, &head.oid, reads)?;
                if matches!(relation, Relation::UpToDate | Relation::Behind { .. }) {
                    let txn = txn.renewed()?;
                    branches::run_delete(
                        &txn,
                        &BranchTip {
                            reference: branch.clone(),
                            oid: tip,
                        },
                    )?;
                    branches::set_config(&txn, &branch, &slot.config, &[])?;
                }
                state::read(&main, pull, head, deadline.renewed().reads())
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
