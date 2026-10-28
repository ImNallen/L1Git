use super::read::{self, Local};
use crate::{
    Advance, AdvanceOutcome, Blocker, BranchRef, BranchState, Oid, RepositoryError, SkipReason,
    git::{self, Deadline, Finished, Mutation},
    stderr,
};
use std::{path::Path, time::Duration};

#[derive(Debug, PartialEq, Eq)]
enum Plan<'a> {
    Done,
    Skip(SkipReason),
    Move,
    Merge { worktree: &'a str },
}

fn plan<'a>(advance: &Advance, current: Option<&'a Local>) -> Plan<'a> {
    let Some(current) = current else {
        return Plan::Skip(SkipReason::Changed);
    };
    if current.oid == advance.to {
        return Plan::Done;
    }
    if current.oid != advance.from {
        return Plan::Skip(SkipReason::Changed);
    }
    match &current.state {
        BranchState::Behind {
            target, blocker, ..
        } if *target == advance.to => match (blocker, &current.checked_out_at) {
            (Some(Blocker::Dirty { worktree }), _) => Plan::Skip(SkipReason::Dirty {
                worktree: worktree.clone(),
            }),
            (Some(Blocker::InUse { worktree }), _) => Plan::Skip(SkipReason::InUse {
                worktree: worktree.clone(),
            }),
            (Some(Blocker::Unverified { message }), _) => Plan::Skip(SkipReason::Failed {
                message: message.clone(),
            }),
            (None, Some(worktree)) => Plan::Merge { worktree },
            (None, None) => Plan::Move,
        },
        BranchState::Behind { .. } => Plan::Skip(SkipReason::Changed),
        _ => Plan::Skip(SkipReason::NotBehind),
    }
}

/// Plans from a fresh read of the one branch, so a move made earlier in the
/// same request, or by another program, is seen.
pub(super) fn advance(
    root: &Path,
    request: &Advance,
    deadline: Duration,
    reads: &mut Deadline,
) -> Result<AdvanceOutcome, RepositoryError> {
    let Advance {
        reference,
        from,
        to,
    } = request;
    let current = read::branch(root, reference, deadline, reads)?;
    let reason = match plan(request, current.as_ref()) {
        Plan::Done => None,
        Plan::Skip(reason) => Some(reason),
        Plan::Move => {
            let mutation = Mutation::MoveRef {
                branch: reference,
                from,
                to,
            };
            let finished = git::mutate(root, mutation, deadline)?;
            *reads = reads.renewed();
            match finished {
                Finished::Succeeded => None,
                Finished::Failed { stderr } if stderr.contains("but expected") => {
                    Some(SkipReason::Changed)
                }
                finished => Some(failed(finished)),
            }
        }
        Plan::Merge { worktree } if !still_checked_out(worktree, reference, from, *reads)? => {
            Some(SkipReason::Changed)
        }
        Plan::Merge { worktree } => {
            let finished = git::mutate(
                Path::new(worktree),
                Mutation::MergeFastForward { to },
                deadline,
            )?;
            *reads = reads.renewed();
            match finished {
                Finished::Succeeded => None,
                Finished::Failed { stderr } if stderr.contains("would be overwritten") => {
                    Some(SkipReason::Dirty {
                        worktree: worktree.to_owned(),
                    })
                }
                Finished::Failed { stderr } if stderr.contains("You have not concluded") => {
                    Some(SkipReason::InUse {
                        worktree: worktree.to_owned(),
                    })
                }
                finished => Some(failed(finished)),
            }
        }
    };
    let reason = match reason {
        None if !is_at(root, reference.as_str(), to, *reads)? => Some(SkipReason::Changed),
        reason => reason,
    };
    Ok(match reason {
        None => AdvanceOutcome::Advanced {
            reference: reference.clone(),
            from: from.clone(),
            to: to.clone(),
        },
        Some(reason) => AdvanceOutcome::Skipped {
            reference: reference.clone(),
            reason,
        },
    })
}

/// `merge --ff-only` moves whatever the worktree has checked out.
fn still_checked_out(
    worktree: &str,
    reference: &BranchRef,
    from: &Oid,
    reads: Deadline,
) -> Result<bool, RepositoryError> {
    let output = git::run(
        Path::new(worktree),
        &["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"],
        reads,
    )?;
    Ok(output.status.success()
        && git::text(&output.stdout) == format!("{}\n{}\n", from.as_str(), reference.as_str()))
}

pub(crate) fn is_at(
    root: &Path,
    reference: &str,
    to: &Oid,
    reads: Deadline,
) -> Result<bool, RepositoryError> {
    let output = git::run(
        root,
        &["rev-parse", "--verify", "--quiet", reference],
        reads,
    )?;
    Ok(output.status.success() && git::line(&output.stdout) == to.as_str())
}

fn failed(finished: Finished) -> SkipReason {
    SkipReason::Failed {
        message: match finished {
            Finished::Failed { stderr } => stderr::summarize(&stderr),
            Finished::Succeeded | Finished::TimedOut => {
                "Git did not finish the fast-forward in time.".into()
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(digit: char) -> Oid {
        Oid::try_from(digit.to_string().repeat(40)).unwrap()
    }

    fn status(oid_digit: char, checked_out_at: Option<&str>, state: BranchState) -> Local {
        Local {
            oid: oid(oid_digit),
            checked_out_at: checked_out_at.map(str::to_owned),
            state,
        }
    }

    fn behind(target: char, blocker: Option<Blocker>) -> BranchState {
        BranchState::Behind {
            upstream: "refs/remotes/origin/main".into(),
            target: oid(target),
            behind: 1,
            blocker,
        }
    }

    #[test]
    fn plans_only_the_move_the_row_offered() {
        let request = Advance {
            reference: BranchRef::try_from("refs/heads/main".to_owned()).unwrap(),
            from: oid('a'),
            to: oid('b'),
        };
        let free = status('a', None, behind('b', None));
        assert_eq!(plan(&request, Some(&free)), Plan::Move);
        let checked_out = status('a', Some("/w"), behind('b', None));
        assert_eq!(
            plan(&request, Some(&checked_out)),
            Plan::Merge { worktree: "/w" }
        );
        let dirty = status(
            'a',
            Some("/w"),
            behind(
                'b',
                Some(Blocker::Dirty {
                    worktree: "/w".into(),
                }),
            ),
        );
        assert_eq!(
            plan(&request, Some(&dirty)),
            Plan::Skip(SkipReason::Dirty {
                worktree: "/w".into()
            })
        );
        let in_use = status(
            'a',
            Some("/w"),
            behind(
                'b',
                Some(Blocker::InUse {
                    worktree: "/w".into(),
                }),
            ),
        );
        assert_eq!(
            plan(&request, Some(&in_use)),
            Plan::Skip(SkipReason::InUse {
                worktree: "/w".into()
            })
        );
        let done = status(
            'b',
            None,
            BranchState::UpToDate {
                upstream: "refs/remotes/origin/main".into(),
            },
        );
        assert_eq!(plan(&request, Some(&done)), Plan::Done);
        let moved = status('c', None, behind('b', None));
        assert_eq!(
            plan(&request, Some(&moved)),
            Plan::Skip(SkipReason::Changed)
        );
        let upstream_moved = status('a', None, behind('c', None));
        assert_eq!(
            plan(&request, Some(&upstream_moved)),
            Plan::Skip(SkipReason::Changed)
        );
        assert_eq!(plan(&request, None), Plan::Skip(SkipReason::Changed));
        let diverged = status(
            'a',
            None,
            BranchState::Diverged {
                upstream: "refs/remotes/origin/main".into(),
                ahead: 1,
                behind: 1,
            },
        );
        assert_eq!(
            plan(&request, Some(&diverged)),
            Plan::Skip(SkipReason::NotBehind)
        );
    }
}
