use super::{
    PullCheckout, PullHead, PullKey, head_missing, state, state::holder, upstream::Upstream,
};
use crate::{
    BranchRef, Coordinator, ErrorKind, RepositoryError, directories,
    git::{Deadline, LocalRead, LocalWrite},
    repository::{self, WorktreeRecord},
    write::{
        RefTxn, Repo, branches,
        branches::{Listing, Setting},
        checkout::{self, NewBranch},
        refs::{self, Move},
        worktrees,
    },
};
use std::path::Path;

impl Coordinator {
    /// Makes `pr/<number>` at the head and checks it out in a linked worktree
    /// at `folder`, missing or empty, or answers the copy that already
    /// exists. A kept branch is checked out at its own tip. The head is
    /// fetched first, under the gate. Git runs as the user, so hooks run. It
    /// records no undo entry and never forces, and when Git fails to make the
    /// worktree it deletes the branch it made, or puts back the settings of
    /// the branch it kept.
    pub fn try_pull_request(
        &self,
        path: &str,
        pull: &PullKey,
        head: &PullHead,
        folder: &Path,
    ) -> Result<PullCheckout, RepositoryError> {
        let typed = folder.to_str().ok_or_else(directories::unusable_location)?;
        let target = directories::resolved_target(folder);
        let reads = self.deadline(LocalRead::PullCheckout);
        let records = repository::worktree_records(&Repo::open(path, reads)?.root, reads)?;
        if holder(&records, &pull.branch()?).is_none() {
            usable(&records, &target, folder, typed)?;
        }
        self.fetch_head(path, pull, head)?;
        self.unrecorded(path, LocalWrite::TryPullRequest, |repo, _, _, deadline| {
            let reads = deadline.reads();
            let branch = pull.branch()?;
            let upstream = Upstream::settled(&repo.root, pull, head, reads)?;
            let listing = Listing::read(&repo, reads)?;
            listing.refuse_symbolic(&branch)?;
            if holder(listing.worktrees(), &branch).is_some() {
                return state::read(&repo, pull, head, reads);
            }
            usable(listing.worktrees(), &target, folder, typed)?;
            let slot = listing.slot(&branch)?;
            let txn = RefTxn::begin(&repo, deadline)?;
            let created = match slot.tip {
                Some(_) => None,
                None => {
                    create(&repo, &txn, &listing, &branch, head, pull, reads)?;
                    Some(NewBranch {
                        branch: branch.clone(),
                        before: slot.config.clone(),
                    })
                }
            };
            let wanted = tracking(&slot.config, upstream.settings(pull));
            let ran = branches::set_config(&txn, &branch, &slot.config, &wanted).and_then(|()| {
                txn.worktree(&["add", "--quiet", typed, branch.name()])
                    .run(deadline)
            });
            let reads = deadline.renewed().reads();
            let made = repository::worktree_records(&repo.root, reads)?;
            if let Some(record) = worktrees::at(&made, &target)
                && let Some(worktree) = worktrees::finished(record, &branch)
            {
                let trouble = checkout::hook_trouble(
                    ran,
                    &format!("Git made the worktree {}", worktree.name),
                    "Remove worktree takes it away.",
                );
                let mut answer = state::read(&repo, pull, head, reads)?;
                if let PullCheckout::Ready { worktree, .. } = &mut answer {
                    worktree.trouble = trouble;
                }
                return Ok(answer);
            }
            let txn = txn.renewed()?;
            match created {
                Some(created) => created.forget(&txn, &repo, &head.oid)?,
                None => {
                    let now = Listing::read(&repo, reads)?.slot(&branch)?.config;
                    branches::set_config(&txn, &branch, &now, &slot.config)?;
                }
            }
            Err(checkout::refusal(ran))
        })
    }
}

fn create(
    repo: &Repo,
    txn: &RefTxn<'_>,
    listing: &Listing,
    branch: &BranchRef,
    head: &PullHead,
    pull: &PullKey,
    reads: Deadline,
) -> Result<(), RepositoryError> {
    listing.refuse_clash(repo, branch, None)?;
    if let Some(root) = listing.slot(branch)?.heads.first() {
        return Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The worktree at {root} waits for its first commit on {}, so L1 Git cannot make that branch.",
                branch.name()
            ),
        ));
    }
    if !state::has_commit(&repo.root, &head.oid, reads)? {
        return Err(head_missing());
    }
    refs::transact(
        txn,
        &[Move {
            name: branch.as_str().to_owned(),
            old: None,
            new: Some(head.oid.clone()),
        }],
        &format!("branch: Created from pull request #{}", pull.number),
        "branch",
    )
}

/// A missing or empty folder that is no worktree of the repository.
fn usable(
    records: &[WorktreeRecord],
    target: &Path,
    folder: &Path,
    typed: &str,
) -> Result<(), RepositoryError> {
    if let Some(record) = worktrees::at(records, target) {
        return Err(worktrees::occupied(record, typed));
    }
    directories::vacant(folder).map(drop)
}

fn tracking(config: &[Setting], upstream: [Setting; 2]) -> Vec<Setting> {
    let ours = |setting: &&Setting| matches!(setting.key.as_str(), "remote" | "merge");
    if config.iter().filter(ours).eq(upstream.iter()) {
        return config.to_vec();
    }
    config
        .iter()
        .filter(|setting| !ours(setting))
        .cloned()
        .chain(upstream)
        .collect()
}
