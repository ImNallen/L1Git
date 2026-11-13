use super::{
    Applied, Change, Direction, Expect, RebaseTxn, Repo,
    branches::Writing,
    merge,
    refs::{self, Files, RefChange},
    store::{self, EntryObjects, Objects, Recorded},
    txn::Runner,
};
use crate::{
    BranchRef, ErrorKind, Head, Oid, RemoteRef, RepositoryError, StaleReason, StatusEntry,
    git::{self, WriteDeadline, Wrote},
    status::{self, Untracked},
    stderr,
    sync::{self, InProgress},
};
use serde::{Deserialize, Serialize};

const WHO: &str = "Pull (Rebase)";

/// `change.json` exists from before Git runs, so a crash can never leave a
/// pending entry with no recorded change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum RebaseChange {
    Pending { before: Head, onto: Oid },
    Landed(RefChange),
}

impl RebaseChange {
    pub(super) fn objects(&self) -> Objects {
        match self {
            Self::Pending { .. } => Objects::default(),
            Self::Landed(change) => change.objects(),
        }
    }
}

/// Replays the commits of the checked-out `branch` onto what `onto` names now,
/// as `git pull --rebase` does. A rebase that stops is aborted, so it never
/// stays in progress and nothing changes.
pub(super) fn apply(
    writing: &Writing<'_>,
    expect: &Expect,
    branch: &BranchRef,
    onto: &RemoteRef,
) -> Result<Applied, RepositoryError> {
    let &Writing {
        repo,
        store,
        log,
        deadline,
        operation,
    } = writing;
    if let Some(applied) = already_landed(writing, expect)? {
        return Ok(applied);
    }
    let head = repo.head_as_seen(expect, deadline)?;
    let before = match &head {
        Head::Attached { reference, .. } if reference == branch.as_str() => {
            refs::oid(&head).ok_or_else(git::malformed)?
        }
        Head::Attached { .. } | Head::Detached { .. } | Head::Unborn { .. } => {
            return Err(merge::refused(format!(
                "{} is not checked out in this worktree, so L1 Git did not rebase it.",
                branch.name()
            )));
        }
    };
    if let Some(running) = sync::in_progress(&repo.root, deadline.reads())?.first() {
        return Err(merge::refused(format!(
            "{} is in progress in this worktree. Finish or abort it before you pull.",
            refs::capitalized(running.name())
        )));
    }
    merge::safe_index_for(repo, WHO, deadline)?;
    let (entries, _) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    if !entries.is_empty() {
        return Err(merge::refused(format!(
            "Commit or stash these changes before you rebase: {}.",
            entries.iter().map(path).collect::<Vec<_>>().join(", ")
        )));
    }
    let upstream = git::read(
        &repo.root,
        &["for-each-ref", "--format=%(upstream)", branch.as_str()],
        deadline.reads(),
    )?;
    if git::line(&upstream) != onto.as_str() {
        return Err(RepositoryError::stale(
            StaleReason::BranchChanged,
            format!(
                "The upstream of {} changed since L1 Git read it, so nothing changed. Refresh and pull again.",
                branch.name()
            ),
        ));
    }
    let target = commit_of(repo, onto.as_str(), deadline)?;
    if ancestor(repo, &target, &before, deadline)? {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            format!(
                "{} already contains {}, so there is nothing to rebase.",
                branch.name(),
                onto.as_str().trim_start_matches("refs/remotes/")
            ),
        ));
    }
    let collisions = merge::colliding_files(
        repo,
        WHO,
        &written(repo, &before, &target, deadline)?,
        deadline,
    )?;
    if !collisions.is_empty() {
        return Err(merge::refused(format!(
            "Preserve these untracked or ignored files first, because the rebase would write to their paths: {}.",
            collisions.join(", ")
        )));
    }
    let (applied, _, mut recorded) = store.record_with(repo, log, operation, |_| {
        Ok(RebaseChange::Pending {
            before: head.clone(),
            onto: target.clone(),
        })
    })?;
    recorded.durable()?;
    let txn = RebaseTxn::begin(repo, deadline)?;
    let wrote = recorded.pending_on_err(txn.rebase(&target).run(deadline))?;
    let txn = txn.renewed();
    match wrote.code() {
        Some(0) => {
            land(recorded, txn.runner(), &head, &target)?;
            Ok(applied)
        }
        Some(_) => Err(stopped(repo, &txn, &head, &wrote).unwrap_or_else(|error| error)),
        // A killed Git may have finished. The next request settles from Git's state.
        None => {
            recorded.stay_pending();
            Err(stopped(repo, &txn, &head, &wrote).unwrap_or_else(|error| error))
        }
    }
}

fn path(entry: &StatusEntry) -> &str {
    match entry {
        StatusEntry::Ordinary { path, .. }
        | StatusEntry::Renamed { path, .. }
        | StatusEntry::Unmerged { path, .. }
        | StatusEntry::Untracked { path } => path,
    }
}

fn commit_of(repo: &Repo, name: &str, deadline: WriteDeadline) -> Result<Oid, RepositoryError> {
    let output = git::read(
        &repo.root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{name}^{{commit}}"),
        ],
        deadline.reads(),
    )?;
    Oid::try_from(git::line(&output))
}

/// Every path the rebase may write: Git first checks out `onto`, then replays
/// each local commit, so a path a commit adds and a later one deletes counts.
fn written(
    repo: &Repo,
    before: &Oid,
    onto: &Oid,
    deadline: WriteDeadline,
) -> Result<Vec<String>, RepositoryError> {
    let mut paths = merge::names(
        repo,
        WHO,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            before.as_str(),
            onto.as_str(),
        ],
        deadline,
    )?;
    paths.extend(merge::names(
        repo,
        WHO,
        &[
            "log",
            "--no-show-signature",
            "--format=",
            "--name-only",
            "--no-renames",
            "-z",
            &format!("{}..{}", onto.as_str(), before.as_str()),
        ],
        deadline,
    )?);
    Ok(paths)
}

fn ancestor(
    repo: &Repo,
    ancestor: &Oid,
    of: &Oid,
    deadline: WriteDeadline,
) -> Result<bool, RepositoryError> {
    let ran = git::run(
        &repo.root,
        &[
            "merge-base",
            "--is-ancestor",
            ancestor.as_str(),
            of.as_str(),
        ],
        deadline.reads(),
    )?;
    match ran.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git::read_failed()),
    }
}

fn rebasing(repo: &Repo, deadline: WriteDeadline) -> Result<bool, RepositoryError> {
    Ok(sync::in_progress(&repo.root, deadline.reads())?
        .iter()
        .any(|running| matches!(running, InProgress::Rebase | InProgress::RebaseOrAm)))
}

/// Git exited without finishing. It either refused before it started, as a
/// `pre-rebase` hook can, or it stopped partway, which this aborts.
fn stopped(
    repo: &Repo,
    txn: &RebaseTxn<'_>,
    head: &Head,
    wrote: &Wrote,
) -> Result<RepositoryError, RepositoryError> {
    let deadline = txn.runner().deadline();
    let said = stderr::summarize(wrote.stderr());
    if !rebasing(repo, deadline)? {
        return Ok(RepositoryError::new(
            ErrorKind::GitFailed,
            if repo.head(deadline)? == *head {
                format!("Git did not rebase, and nothing changed. Git said: {said}")
            } else {
                format!(
                    "Git stopped the rebase, but HEAD moved anyway. Check the history. Git said: {said}"
                )
            },
        ));
    }
    let (entries, _) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
    let conflicts = merge::unresolved(&entries);
    let aborted = txn.abort().run(deadline)?;
    if aborted.code() != Some(0) || rebasing(repo, deadline)? || repo.head(deadline)? != *head {
        return Ok(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The rebase stopped, and L1 Git could not abort it. Finish or abort it with Git. Git said: {}",
                stderr::summarize(aborted.stderr())
            ),
        ));
    }
    Ok(if conflicts.is_empty() {
        RepositoryError::new(
            ErrorKind::GitFailed,
            format!(
                "The rebase stopped, so L1 Git aborted it and nothing changed. Git said: {said}"
            ),
        )
    } else {
        RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The rebase stopped on conflicts in {}, so L1 Git aborted it and nothing changed. Use Pull (Fast-forward if possible) to merge instead.",
                conflicts.join(", ")
            ),
        )
    })
}

fn unexpected() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        "Git stopped the rebase, but HEAD is not where L1 Git expected, so it has no undo entry for it. Check the history.",
    )
}

fn land(
    recorded: Recorded<'_>,
    runner: &impl Runner,
    before: &Head,
    onto: &Oid,
) -> Result<(), RepositoryError> {
    let deadline = runner.deadline();
    let after = runner.repo().head(deadline)?;
    let change =
        landed_change(runner.repo(), before, onto, &after, deadline)?.ok_or_else(unexpected)?;
    recorded
        .complete(runner, &Change::Rebase(change))
        .map_err(|error| {
            RepositoryError::new(
                error.kind,
                format!(
                    "Git finished the rebase, but L1 Git could not record it, so it cannot undo it. {}",
                    error.message
                ),
            )
        })
}

/// The old tip stays kept, because the rebased branch no longer reaches it.
fn landed_change(
    repo: &Repo,
    before: &Head,
    onto: &Oid,
    after: &Head,
    deadline: WriteDeadline,
) -> Result<Option<RebaseChange>, RepositoryError> {
    let (
        Head::Attached {
            reference: from, ..
        },
        Head::Attached { reference: to, .. },
    ) = (before, after)
    else {
        return Ok(None);
    };
    let (Some(old), Some(new)) = (refs::oid(before), refs::oid(after)) else {
        return Ok(None);
    };
    if from != to || old == new || !ancestor(repo, onto, &new, deadline)? {
        return Ok(None);
    }
    Ok(Some(RebaseChange::Landed(RefChange::new(
        before.clone(),
        after.clone(),
        Some(old),
    )?)))
}

/// The undo log is the receipt for a repeated request, because Git leaves no
/// trace that a rebase finished.
fn already_landed(
    writing: &Writing<'_>,
    expect: &Expect,
) -> Result<Option<Applied>, RepositoryError> {
    let Some(id) = writing.log.next_undo() else {
        return Ok(None);
    };
    let (applied, change) = writing.store.record_of(id)?;
    let Change::Rebase(RebaseChange::Landed(change)) = change else {
        return Ok(None);
    };
    Ok((applied.operation == *writing.operation
        && applied.root == writing.repo.root()
        && change.moved(&expect.head, &writing.repo.head(writing.deadline)?))
    .then_some(applied))
}

/// Settles a pending entry from Git alone. A rebase still in progress, or a
/// branch that does not contain `onto`, records nothing.
pub(super) fn landed(
    repo: &Repo,
    change: &RebaseChange,
    deadline: WriteDeadline,
) -> Result<Option<RebaseChange>, RepositoryError> {
    let RebaseChange::Pending { before, onto } = change else {
        return Ok(Some(change.clone()));
    };
    if rebasing(repo, deadline)? {
        return Ok(None);
    }
    landed_change(repo, before, onto, &repo.head(deadline)?, deadline)
}

pub(super) fn step(
    repo: &Repo,
    entry: &EntryObjects,
    change: &RebaseChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let RebaseChange::Landed(change) = change else {
        return Err(store::history_changed());
    };
    refs::restore_with(repo, entry, change, direction, Files::Follow, deadline)
}
