mod create;
mod remove;
mod state;
mod update;
mod upstream;

use super::{Repo, branches, branches::Listing};
use crate::{
    BranchRef, Coordinator, GitHubRepository, Oid, RepositoryError, StaleReason, git::LocalRead,
};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;
use upstream::Upstream;

pub use state::{Changes, Relation};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullKey {
    pub github: GitHubRepository,
    pub number: NonZeroU32,
}

impl PullKey {
    fn branch(&self) -> Result<BranchRef, RepositoryError> {
        BranchRef::try_from(format!("refs/heads/pr/{}", self.number))
    }
}

/// The pull request's head as GitHub reported it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullHead {
    /// The head branch in the repository it lives in.
    pub reference: BranchRef,
    pub oid: Oid,
    pub from: HeadFrom,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HeadFrom {
    /// `edits` when the repository takes pushes from you.
    Same { edits: bool },
    /// `edits` when the fork takes pushes from you.
    Fork {
        repository: GitHubRepository,
        edits: bool,
    },
    /// The fork was deleted. GitHub keeps `refs/pull/<number>/head`.
    Gone,
}

/// The local copy of a pull request: the branch `pr/<number>`, and the
/// worktree that has it checked out. Every request answers it, read after the
/// request ran.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PullCheckout {
    Absent {
        branch: BranchRef,
        plan: Plan,
    },
    /// The branch exists, and no worktree has it checked out.
    Parked {
        branch: BranchRef,
        tip: Oid,
        relation: Relation,
        plan: Plan,
    },
    Ready {
        branch: BranchRef,
        tip: Oid,
        relation: Relation,
        worktree: CheckedOut,
    },
}

/// What Try would do. The write works it out again under the write lock.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub folder: String,
    pub pushes: Pushes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Pushes {
    /// Pushing the branch updates the pull request's head branch,
    /// `destination` on `remote`. `adds_remote` when Try adds `remote` first.
    ToPullRequest {
        remote: String,
        destination: BranchRef,
        adds_remote: bool,
    },
    /// Pushing updates nothing on the pull request.
    Nowhere { why: NoPush },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoPush {
    /// The fork takes no push from you. The branch follows
    /// `refs/pull/<number>/head`, which takes none either.
    NoEdits,
    /// The fork was deleted. The branch follows `refs/pull/<number>/head`.
    ForkGone,
    /// No remote of the repository is the pull request's, so Try cannot
    /// fetch it.
    NoRemote,
    /// The repository takes no push from you. The branch follows the head
    /// branch, so pulling still works.
    ReadOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedOut {
    pub root: String,
    pub name: String,
    /// The main worktree, which Remove refuses.
    pub main: bool,
    pub changes: Changes,
    /// Git made the worktree, but its `post-checkout` hook failed or was
    /// stopped. Only the answer to the Try that made it carries it.
    pub trouble: Option<RepositoryError>,
}

impl Coordinator {
    /// Reads the local copy of `pull`. Takes no lock and fetches nothing.
    pub fn pull_request_checkout(
        &self,
        path: &str,
        pull: &PullKey,
        head: &PullHead,
    ) -> Result<PullCheckout, RepositoryError> {
        let reads = self.deadline(LocalRead::PullCheckout);
        state::read(&Repo::open(path, reads)?, pull, head, reads)
    }

    fn fetch_head(
        &self,
        path: &str,
        pull: &PullKey,
        head: &PullHead,
    ) -> Result<(), RepositoryError> {
        let reads = self.deadline(LocalRead::PullCheckout);
        let repo = Repo::open(path, reads)?;
        let upstream = Upstream::of(&repo.root, pull, head, reads)?;
        if let Some(remote) = upstream.adds() {
            self.save_remote(path, remote)?;
        }
        self.fetch_wanted(path, upstream.remote(), upstream.wanted(head))
    }
}

fn seen_at(listing: &Listing, branch: &BranchRef, seen: &Oid) -> Result<Oid, RepositoryError> {
    match listing.slot(branch)?.tip {
        Some(tip) if tip == *seen => Ok(tip),
        Some(_) | None => Err(branches::moved(branch.name())),
    }
}

fn head_missing() -> RepositoryError {
    RepositoryError::stale(
        StaleReason::BranchChanged,
        "The pull request changed on GitHub since L1 Git read it, so nothing changed. Refresh it and try again.",
    )
}
