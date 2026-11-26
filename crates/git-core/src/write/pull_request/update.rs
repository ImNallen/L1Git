use super::{
    PullCheckout, PullHead, PullKey, Relation, head_missing, seen_at, state, state::holder,
};
use crate::{
    BranchRef, Coordinator, ErrorKind, Head, InProgress, Oid, RepositoryError,
    git::{LocalWrite, WriteDeadline, Wrote},
    repository::{self, WorktreeRecord},
    sync,
    write::{
        MergeTxn, RefTxn, Repo, branches,
        branches::Listing,
        checkout,
        refs::{self, Move, capitalized},
    },
};

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
/// overwrite, and each untracked file at a path the head adds.
fn reset_refusal(ran: Wrote) -> RepositoryError {
    let paths: Vec<String> = ran
        .stderr()
        .lines()
        .filter_map(|line| {
            let changed = line
                .strip_prefix("error: Entry '")
                .and_then(|rest| rest.strip_suffix("' not uptodate. Cannot merge."));
            let untracked = line
                .strip_prefix("error: Untracked working tree file '")
                .and_then(|rest| rest.strip_suffix("' would be overwritten by merge."));
            changed.or(untracked).map(str::to_owned)
        })
        .collect();
    if paths.is_empty() {
        return checkout::refusal(Ok(ran));
    }
    RepositoryError::new(
        ErrorKind::Conflict,
        format!(
            "The pull request changes files you changed or added and did not commit: {}. Commit, discard, or move them first.",
            paths.join(", ")
        ),
    )
}

fn commits(count: u32) -> String {
    if count == 1 {
        "1 commit".into()
    } else {
        format!("{count} commits")
    }
}
