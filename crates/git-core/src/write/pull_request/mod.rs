mod state;
mod upstream;

use super::{
    RefTxn, Repo, branches,
    branches::{Listing, Setting},
    checkout::{self, NewBranch},
    refs::{self, Move, capitalized},
    worktrees,
};
use crate::{
    BranchRef, BranchTip, Coordinator, ErrorKind, GitHubRepository, Head, InProgress, Oid,
    RepositoryError, StaleReason, directories,
    git::{Deadline, LocalRead, LocalWrite, WriteDeadline, Wrote},
    repository::{self, WorktreeRecord},
    sync,
    write::MergeTxn,
};
use serde::{Deserialize, Serialize};
use state::holder;
use std::{num::NonZeroU32, path::Path};
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
    Same,
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
    /// The branch follows `refs/pull/<number>/head`, which takes no push.
    Nowhere { why: NoPush },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoPush {
    NoEdits,
    ForkGone,
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

enum Step {
    FastForward,
    Replace,
}

impl Step {
    fn of(
        branch: &BranchRef,
        relation: &Relation,
        replace: bool,
    ) -> Result<Option<Self>, RepositoryError> {
        Ok(match relation {
            Relation::UpToDate => None,
            Relation::Behind { .. } => Some(Self::FastForward),
            Relation::Ahead { .. } | Relation::Diverged { .. } if replace => Some(Self::Replace),
            Relation::Ahead { .. } => None,
            Relation::Diverged { ahead, .. } => {
                return Err(RepositoryError::new(
                    ErrorKind::Conflict,
                    format!(
                        "{} has {} the pull request does not, so L1 Git did not move it. Replace it with the pull request to leave them behind.",
                        branch.name(),
                        commits(*ahead)
                    ),
                ));
            }
            Relation::Unfetched => return Err(head_missing()),
        })
    }
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

    /// Makes `pr/<number>` at the head and checks it out in a linked worktree
    /// at `folder`, missing or empty, or answers the copy that already
    /// exists. A kept branch is checked out at its own tip. The head is
    /// fetched first, under the gate. Git runs as the user, so hooks run. It
    /// records no undo entry and never forces, and when Git fails to make the
    /// worktree it deletes the branch it made.
    pub fn try_pull_request(
        &self,
        path: &str,
        pull: &PullKey,
        head: &PullHead,
        folder: &Path,
    ) -> Result<PullCheckout, RepositoryError> {
        let typed = folder.to_str().ok_or_else(directories::unusable_location)?;
        let target = directories::resolved_target(folder);
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
            if let Some(record) = worktrees::at(listing.worktrees(), &target) {
                return Err(worktrees::occupied(record, typed));
            }
            directories::vacant(folder)?;
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
            if let Some(created) = created {
                created.forget(&txn.renewed()?, &repo, &head.oid)?;
            }
            Err(checkout::refusal(ran))
        })
    }

    /// Moves `pr/<number>` to the head when it is still at `seen`. A branch
    /// behind the head fast-forwards. One with commits the head lacks moves
    /// only with `replace`, which leaves them behind and keeps uncommitted
    /// changes the move does not touch. In a worktree that runs
    /// `merge --ff-only` or `reset --keep` there, and a kept branch moves by
    /// `update-ref`. The head is fetched first, under the gate. It records no
    /// undo entry and never forces.
    pub fn update_pull_request(
        &self,
        path: &str,
        pull: &PullKey,
        head: &PullHead,
        seen: &Oid,
        replace: bool,
    ) -> Result<PullCheckout, RepositoryError> {
        self.fetch_head(path, pull, head)?;
        self.unrecorded(
            path,
            LocalWrite::UpdatePullRequest,
            |repo, _, _, deadline| {
                let reads = deadline.reads();
                let branch = pull.branch()?;
                let listing = Listing::read(&repo, reads)?;
                listing.refuse_symbolic(&branch)?;
                let tip = seen_at(&listing, &branch, seen)?;
                let relation = state::compare(&repo.root, &tip, &head.oid, reads)?;
                let Some(step) = Step::of(&branch, &relation, replace)? else {
                    return state::read(&repo, pull, head, reads);
                };
                match holder(listing.worktrees(), &branch) {
                    None => {
                        let txn = RefTxn::begin(&repo, deadline)?;
                        refs::transact(
                            &txn,
                            &[Move {
                                name: branch.as_str().to_owned(),
                                old: Some(tip),
                                new: Some(head.oid.clone()),
                            }],
                            &format!("l1git: pull request #{}", pull.number),
                            "branch",
                        )?;
                    }
                    Some(record) => {
                        let worktree = movable(&repo, record, &branch, &tip, deadline)?;
                        match step {
                            Step::FastForward => {
                                let ran = MergeTxn::begin(&worktree, deadline)?
                                    .fast_forward(&head.oid)
                                    .run(deadline);
                                if !ran.as_ref().is_ok_and(|ran| ran.code() == Some(0)) {
                                    return Err(checkout::refusal(ran));
                                }
                            }
                            Step::Replace => {
                                let ran = RefTxn::begin(&worktree, deadline)?
                                    .reset_keep(&head.oid)
                                    .run(deadline)?;
                                if ran.code() != Some(0) {
                                    return Err(reset_refusal(ran));
                                }
                            }
                        }
                    }
                }
                state::read(&repo, pull, head, deadline.renewed().reads())
            },
        )
    }

    /// Removes the worktree that has `pr/<number>` checked out with
    /// `git worktree remove`, never `--force`, by the same refusals as
    /// Remove worktree, run from the main worktree. Then deletes the branch
    /// when it is still at `seen` and every commit on it is in the head, and
    /// keeps it otherwise. Remotes stay. It records no undo entry, and drops
    /// the entries only that worktree could run.
    pub fn remove_pull_request(
        &self,
        path: &str,
        pull: &PullKey,
        head: &PullHead,
        seen: &Oid,
    ) -> Result<PullCheckout, RepositoryError> {
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

fn seen_at(listing: &Listing, branch: &BranchRef, seen: &Oid) -> Result<Oid, RepositoryError> {
    match listing.slot(branch)?.tip {
        Some(tip) if tip == *seen => Ok(tip),
        Some(_) | None => Err(branches::moved(branch.name())),
    }
}

fn movable(
    repo: &Repo,
    record: &WorktreeRecord,
    branch: &BranchRef,
    tip: &Oid,
    deadline: WriteDeadline,
) -> Result<Repo, RepositoryError> {
    let reads = deadline.reads();
    let name = record.name();
    let Some(root) = record.root.as_deref().filter(|_| !record.prunable) else {
        return Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The folder of {name} is missing. Remove the worktree, then try the pull request again."
            ),
        ));
    };
    let worktree = repo.worktree(&root.to_string_lossy(), reads)?;
    if let Some(operation) = sync::in_progress(&worktree.root, reads)?.first() {
        return Err(in_progress(*operation, &name));
    }
    let head = repository::head(&worktree.root, reads)?;
    if head
        != (Head::Attached {
            reference: branch.as_str().to_owned(),
            oid: tip.as_str().to_owned(),
        })
    {
        return Err(branches::moved(branch.name()));
    }
    Ok(worktree)
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

fn in_progress(operation: InProgress, name: &str) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::Conflict,
        format!(
            "{} is in progress in {name}. Finish or abort it there, then update.",
            capitalized(operation.name())
        ),
    )
}

/// `reset --keep` names each file whose uncommitted change it would
/// overwrite.
fn reset_refusal(ran: Wrote) -> RepositoryError {
    let paths: Vec<String> = ran
        .stderr()
        .lines()
        .filter_map(|line| {
            line.strip_prefix("error: Entry '")?
                .strip_suffix("' not uptodate. Cannot merge.")
                .map(str::to_owned)
        })
        .collect();
    if paths.is_empty() {
        return checkout::refusal(Ok(ran));
    }
    RepositoryError::new(
        ErrorKind::Conflict,
        format!(
            "The pull request changes files you changed and did not commit: {}. Commit, discard, or move them first.",
            paths.join(", ")
        ),
    )
}

fn head_missing() -> RepositoryError {
    RepositoryError::stale(
        StaleReason::BranchChanged,
        "The pull request changed on GitHub since L1 Git read it, so nothing changed. Refresh it and try again.",
    )
}

fn commits(count: u32) -> String {
    if count == 1 {
        "1 commit".into()
    } else {
        format!("{count} commits")
    }
}
