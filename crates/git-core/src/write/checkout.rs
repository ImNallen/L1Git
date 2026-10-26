use super::{
    Applied, Change, Direction, Expect, RefTxn, Repo, Start,
    branches::{self, Listing, Setting, Writing},
    commit::{resolve, short},
    discard::Stat,
    refs::{capitalized, oid},
    store::EntryObjects,
    txn::Runner,
};
use crate::{
    BranchRef, BranchTip, ChangeStatus, ErrorKind, Head, MoveSide, Moved, Oid, RemoteRef,
    RepositoryError, Sides, StaleReason, StatusEntry,
    git::{self, Deadline, WriteDeadline, Wrote},
    status::{self, Untracked},
    stderr, sync,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum CheckoutChange {
    Pending {
        before: Head,
        goal: Head,
        created: Option<NewBranch>,
    },
    Landed {
        before: Head,
        after: Head,
        created: Option<MadeBranch>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NewBranch {
    branch: BranchRef,
    before: Vec<Setting>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MadeBranch {
    branch: BranchRef,
    before: Vec<Setting>,
    after: Vec<Setting>,
}

struct Switch {
    goal: Head,
    to_name: String,
    from_name: String,
    args: Vec<String>,
    created: Option<NewBranch>,
    reverse: &'static str,
}

pub(super) fn checkout(
    writing: &Writing<'_>,
    expect: &Expect,
    target: &Start,
) -> Result<Applied, RepositoryError> {
    let repo = writing.repo;
    let deadline = writing.deadline;
    let reads = deadline.reads();
    refuse_unfinished(repo, "check out", reads)?;
    let before = repo.head(deadline)?;
    if before != expect.head {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved since L1 Git read this worktree. Refresh and try again.",
        ));
    }
    let from = leaving(&before)?;
    let planned = Switch::to_target(repo, &before, target, deadline)?;
    refuse_absorbing(repo, &from, &planned.goal, &planned.to_name, reads)?;
    let txn = RefTxn::begin(repo, deadline)?;
    let (applied, _, recorded) =
        writing
            .store
            .record_with(repo, writing.log, writing.operation, |entry| {
                if matches!(before, Head::Detached { .. }) {
                    entry.keep_left_behind(txn.runner(), &from, None)?;
                }
                Ok(CheckoutChange::Pending {
                    before: before.clone(),
                    goal: planned.goal.clone(),
                    created: planned.created.clone(),
                })
            })?;
    if repo.head(deadline)? != before {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved while L1 Git got ready to check out. Refresh and try again.",
        ));
    }
    match switch(&txn, repo, &before, &planned, deadline) {
        Outcome::Failed(error) => Err(error),
        Outcome::Unread(error) => {
            recorded.stay_pending();
            Err(error)
        }
        Outcome::Reached { after, trouble } => {
            let deadline = deadline.renewed();
            let created = match &planned.created {
                None => None,
                Some(new) => match made(repo, new, &after, deadline) {
                    Ok(Some(made)) => Some(made),
                    Ok(None) => {
                        recorded.stay_pending();
                        return Err(raced(&planned));
                    }
                    Err(error) => {
                        recorded.stay_pending();
                        return Err(error);
                    }
                },
            };
            let change = CheckoutChange::Landed {
                before,
                after,
                created,
            };
            match recorded.replace(&Change::Checkout(change)) {
                Ok(()) => recorded.confirm(),
                Err(_) => recorded.stay_pending(),
            }
            trouble.map_or(Ok(applied), Err)
        }
    }
}

impl Switch {
    fn to_target(
        repo: &Repo,
        before: &Head,
        target: &Start,
        deadline: WriteDeadline,
    ) -> Result<Self, RepositoryError> {
        let reads = deadline.reads();
        let from = shown(before);
        match target {
            Start::Commit { oid } => {
                if resolve(repo, deadline, oid.as_str())?.as_ref() != Some(oid) {
                    return Err(RepositoryError::new(
                        ErrorKind::InvalidOid,
                        format!("{} is not a commit.", short(oid)),
                    ));
                }
                let goal = Head::Detached {
                    oid: oid.as_str().to_owned(),
                };
                if *before == goal {
                    return Err(RepositoryError::new(
                        ErrorKind::UnchangedPath,
                        format!("HEAD is already at {}.", short(oid)),
                    ));
                }
                Ok(Self {
                    goal,
                    to_name: short(oid).to_owned(),
                    from_name: from,
                    args: vec!["--detach".to_owned(), oid.as_str().to_owned()],
                    created: None,
                    reverse: "Undo",
                })
            }
            Start::Local { reference, oid } => {
                let listing = Listing::read(repo, reads)?;
                if listing.slot(reference)?.tip.as_ref() != Some(oid) {
                    return Err(branches::moved(reference.name()));
                }
                Self::existing(&listing, before, reference, oid.clone(), from)
            }
            Start::Remote { reference, oid } => {
                let remote = branches::short(reference.as_str());
                if !sync::is_at(&repo.root, reference.as_str(), oid, reads)? {
                    return Err(branches::moved(remote));
                }
                let name = local_name(repo, reference, reads)?;
                let branch = branches::new_name(repo, &name, reads)?;
                let listing = Listing::read(repo, reads)?;
                let slot = listing.slot(&branch)?;
                if let Some(tip) = slot.tip {
                    return Self::existing(&listing, before, &branch, tip, from);
                }
                listing.refuse_clash(&branch, None)?;
                if let Some(root) = slot.heads.first() {
                    return Err(RepositoryError::new(
                        ErrorKind::Conflict,
                        format!(
                            "The worktree at {root} waits for its first commit on {name}, so a new {name} would move it."
                        ),
                    ));
                }
                Ok(Self {
                    goal: Head::Attached {
                        reference: branch.as_str().to_owned(),
                        oid: oid.as_str().to_owned(),
                    },
                    to_name: remote.to_owned(),
                    from_name: from,
                    args: vec![
                        "--no-guess".to_owned(),
                        "-c".to_owned(),
                        name,
                        "--track".to_owned(),
                        reference.as_str().to_owned(),
                    ],
                    created: Some(NewBranch {
                        branch,
                        before: slot.config,
                    }),
                    reverse: "Undo",
                })
            }
        }
    }

    fn existing(
        listing: &Listing,
        before: &Head,
        branch: &BranchRef,
        tip: Oid,
        from: String,
    ) -> Result<Self, RepositoryError> {
        let name = branch.name();
        if matches!(before, Head::Attached { reference, .. } if reference == branch.as_str()) {
            return Err(RepositoryError::new(
                ErrorKind::UnchangedPath,
                format!("{name} is already checked out."),
            ));
        }
        listing.refuse_symbolic(branch)?;
        if let Some(root) = listing.slot(branch)?.heads.first() {
            return Err(RepositoryError::new(
                ErrorKind::Conflict,
                format!(
                    "{name} is checked out in {root}, and Git checks out a branch in one worktree at a time. Switch that worktree to another branch first."
                ),
            ));
        }
        Ok(Self {
            goal: Head::Attached {
                reference: branch.as_str().to_owned(),
                oid: tip.as_str().to_owned(),
            },
            to_name: name.to_owned(),
            from_name: from,
            args: vec!["--no-guess".to_owned(), "--".to_owned(), name.to_owned()],
            created: None,
            reverse: "Undo",
        })
    }

    fn to_recorded(
        repo: &Repo,
        entry: &EntryObjects,
        runner: &impl Runner,
        from: &Head,
        to: &Head,
        remake: Option<&MadeBranch>,
        direction: Direction,
    ) -> Result<Self, RepositoryError> {
        let (step, reverse) = match direction {
            Direction::Undo => ("undo", "Redo"),
            Direction::Redo => ("redo", "Undo"),
        };
        let reads = runner.deadline().reads();
        let tip = oid(to).ok_or_else(git::malformed)?;
        let mut args = Vec::new();
        let mut created = None;
        match to {
            Head::Detached { .. } => {
                entry.bring_back_branch(runner, &tip)?;
                args.extend(["--detach".to_owned(), tip.as_str().to_owned()]);
            }
            Head::Attached { reference, .. } => {
                let branch = BranchRef::try_from(reference.clone())?;
                let name = branch.name().to_owned();
                let slot = Listing::read(repo, reads)?.slot(&branch)?;
                match (&slot.tip, remake) {
                    (None, Some(_)) => {
                        entry.bring_back_branch(runner, &tip)?;
                        created = Some(NewBranch {
                            branch: branch.clone(),
                            before: slot.config,
                        });
                        args.extend([
                            "--no-guess".to_owned(),
                            "-c".to_owned(),
                            name,
                            "--no-track".to_owned(),
                            tip.as_str().to_owned(),
                        ]);
                    }
                    (Some(_), Some(_)) => {
                        return Err(branches::exists_again(&branch, "redo this checkout"));
                    }
                    (Some(now), None) if *now == tip => {
                        args.extend(["--no-guess".to_owned(), "--".to_owned(), name]);
                    }
                    _ => {
                        return Err(RepositoryError::stale(
                            StaleReason::BranchChanged,
                            format!(
                                "{name} moved since this checkout, so L1 Git cannot {step} it exactly. Check out {name} instead."
                            ),
                        ));
                    }
                }
            }
            Head::Unborn { .. } => return Err(git::malformed()),
        }
        Ok(Self {
            goal: to.clone(),
            to_name: shown(to),
            from_name: shown(from),
            args,
            created,
            reverse,
        })
    }
}

fn local_name(
    repo: &Repo,
    reference: &RemoteRef,
    reads: Deadline,
) -> Result<String, RepositoryError> {
    let config = branches::config(repo, &[], reads)?;
    let shown = branches::short(reference.as_str());
    let refused = |message: String| Err(RepositoryError::new(ErrorKind::InvalidRef, message));
    match &branches::fetched_into(&config, reference.as_str())[..] {
        [(_, source)] => match source.strip_prefix("refs/heads/") {
            Some(name) => Ok(name.to_owned()),
            None => refused(format!(
                "{shown} comes from {source}, which is not a branch on its remote, so Git cannot track it. Create a branch from it instead."
            )),
        },
        [] => refused(format!(
            "No remote's fetch refspec maps {shown}, so Git cannot set it as a new branch's upstream. Create a branch from it instead."
        )),
        _ => refused(format!(
            "More than one remote's fetch refspec maps {shown}, so Git cannot tell which one a new branch should track. Give each remote its own refs/remotes/ folder, then try again."
        )),
    }
}

fn leaving(head: &Head) -> Result<Oid, RepositoryError> {
    match head {
        Head::Unborn { .. } => Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "This worktree has no commit yet, and Undo could not put HEAD back on a branch with no commits. Use git switch in a terminal.",
        )),
        Head::Attached { reference, .. } if !reference.starts_with("refs/heads/") => {
            Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                format!(
                    "HEAD points at {reference}, which is not a local branch, so git switch could not put it back on Undo."
                ),
            ))
        }
        Head::Attached { .. } | Head::Detached { .. } => oid(head).ok_or_else(git::malformed),
    }
}

fn refuse_unfinished(repo: &Repo, doing: &str, reads: Deadline) -> Result<(), RepositoryError> {
    match sync::in_progress(&repo.root, reads)?.first() {
        Some(operation) => Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "{} is in progress in this worktree. Finish or abort it with Git, then {doing}.",
                capitalized(operation.name())
            ),
        )),
        None => Ok(()),
    }
}

/// `git switch` keeps a staged change that already equals the target's
/// version, and takes a file you deleted that the target changes or deletes,
/// so neither shows as a change afterwards and switching back would undo
/// it.
fn refuse_absorbing(
    repo: &Repo,
    from: &Oid,
    goal: &Head,
    to: &str,
    reads: Deadline,
) -> Result<(), RepositoryError> {
    let goal = oid(goal).ok_or_else(git::malformed)?;
    refuse_taking_untracked(repo, from, &goal, to, reads)?;
    let (entries, _) = status::entries(&repo.root, Untracked::No, reads)?;
    let mut staged = BTreeSet::new();
    let mut deleted = BTreeSet::new();
    for entry in entries {
        match entry {
            StatusEntry::Unmerged { path, .. } => {
                return Err(RepositoryError::new(
                    ErrorKind::Conflict,
                    format!("{path} has a conflict. Resolve it, then check out {to}."),
                ));
            }
            StatusEntry::Ordinary {
                path,
                sides:
                    Sides::Unstaged {
                        unstaged: ChangeStatus::Deleted,
                    },
                ..
            }
            | StatusEntry::Renamed {
                original: path,
                how: Moved::Renamed,
                side: MoveSide::Unstaged { .. },
                ..
            } => {
                deleted.insert(path);
            }
            StatusEntry::Ordinary {
                sides: Sides::Unstaged { .. },
                ..
            }
            | StatusEntry::Renamed {
                how: Moved::Copied,
                side: MoveSide::Unstaged { .. },
                ..
            }
            | StatusEntry::Untracked { .. } => {}
            StatusEntry::Ordinary { path, .. } => {
                staged.insert(path);
            }
            StatusEntry::Renamed { path, original, .. } => {
                staged.insert(path);
                staged.insert(original);
            }
        }
    }
    if staged.is_empty() && deleted.is_empty() {
        return Ok(());
    }
    let changed = names(
        repo,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--name-only",
            "--no-renames",
            from.as_str(),
            goal.as_str(),
        ],
        reads,
    )?;
    let mut absorbed: Vec<String> = deleted
        .into_iter()
        .filter(|path| changed.contains(path))
        .collect();
    let staged: Vec<String> = staged
        .into_iter()
        .filter(|path| changed.contains(path))
        .collect();
    if !staged.is_empty() {
        let differ = names(
            repo,
            &[
                "diff-index",
                "--cached",
                "-z",
                "--name-only",
                "--no-renames",
                goal.as_str(),
            ],
            reads,
        )?;
        absorbed.extend(staged.into_iter().filter(|path| !differ.contains(path)));
    }
    if absorbed.is_empty() {
        return Ok(());
    }
    absorbed.sort();
    Err(RepositoryError::new(
        ErrorKind::Conflict,
        format!(
            "After a checkout of {to}, Git would no longer list your uncommitted changes to {}, and Undo could not bring them back. Commit, unstage, or discard them first.",
            listed(&absorbed)
        ),
    ))
}

/// In a sparse checkout, `git switch` takes over an untracked or ignored file
/// where the target adds one instead of refusing, so switching back deletes
/// it.
fn refuse_taking_untracked(
    repo: &Repo,
    from: &Oid,
    goal: &Oid,
    to: &str,
    reads: Deadline,
) -> Result<(), RepositoryError> {
    let sparse = git::read(
        &repo.root,
        &[
            "config",
            "--get",
            "--type=bool",
            "--default=false",
            "core.sparseCheckout",
        ],
        reads,
    )?;
    if sparse != b"true\n" {
        return Ok(());
    }
    let added = names(
        repo,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--name-only",
            "--no-renames",
            "--diff-filter=A",
            from.as_str(),
            goal.as_str(),
        ],
        reads,
    )?;
    let present: Vec<&str> = added
        .iter()
        .map(String::as_str)
        .filter(|path| repo.root.join(path).symlink_metadata().is_ok())
        .collect();
    if present.is_empty() {
        return Ok(());
    }
    let args = [
        &["--literal-pathspecs", "ls-files", "--others", "-z", "--"],
        &present[..],
    ]
    .concat();
    let taken: Vec<String> = names(repo, &args, reads)?.into_iter().collect();
    if taken.is_empty() {
        return Ok(());
    }
    Err(RepositoryError::new(
        ErrorKind::Conflict,
        format!(
            "This sparse checkout would take over the untracked or ignored files at {}, which {to} adds, and switching back would delete them. Move or delete them first.",
            listed(&taken)
        ),
    ))
}

fn names(repo: &Repo, args: &[&str], reads: Deadline) -> Result<BTreeSet<String>, RepositoryError> {
    Ok(git::read(&repo.root, args, reads)?
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(git::text)
        .collect())
}

enum Outcome {
    Reached {
        after: Head,
        trouble: Option<RepositoryError>,
    },
    Failed(RepositoryError),
    Unread(RepositoryError),
}

/// Git writes the index and the files before it moves HEAD.
fn switch(
    txn: &RefTxn<'_>,
    repo: &Repo,
    from: &Head,
    planned: &Switch,
    deadline: WriteDeadline,
) -> Outcome {
    let index = Stat::of(&repo.index).ok();
    let args: Vec<&str> = planned.args.iter().map(String::as_str).collect();
    let ran = txn.switch(&args).run(deadline);
    let now = match repo.head(deadline.renewed()) {
        Ok(head) => head,
        Err(error) => return Outcome::Unread(error),
    };
    if now == planned.goal {
        return Outcome::Reached {
            trouble: after_trouble(planned, ran),
            after: now,
        };
    }
    if same_branch(&now, &planned.goal) {
        return Outcome::Reached {
            after: now,
            trouble: Some(raced(planned)),
        };
    }
    if !same_branch_or_commit(&now, from) {
        return Outcome::Failed(RepositoryError::new(
            ErrorKind::Raced,
            format!(
                "Another process moved HEAD while Git checked out {}, so L1 Git has no undo entry for it. Refresh.",
                planned.to_name
            ),
        ));
    }
    let refused = refusal(ran);
    if Stat::of(&repo.index).ok() == index {
        // Git refuses for these before it writes any file.
        if matches!(refused.kind, ErrorKind::Conflict | ErrorKind::LockHeld) {
            return Outcome::Failed(refused);
        }
        return Outcome::Failed(RepositoryError::new(
            refused.kind,
            format!(
                "HEAD did not move. If Git changed some files before it stopped, they show as changes. Discard them to put them back. {}",
                refused.message
            ),
        ));
    }
    Outcome::Failed(match put_back(txn, repo, from, planned) {
        Ok(()) => RepositoryError::new(
            refused.kind,
            format!(
                "HEAD did not move. Git had changed the files first, and L1 Git put them back, so nothing changed. {}",
                refused.message
            ),
        ),
        Err(error) => RepositoryError::new(
            ErrorKind::GitFailed,
            format!(
                "Git changed the files to {}'s version but could not move HEAD, and L1 Git could not put them back, so they show as staged changes: {} {} To put them back, unstage the files that {} changes, then discard them.",
                planned.to_name, error.message, refused.message, planned.to_name
            ),
        ),
    })
}

fn same_branch(now: &Head, goal: &Head) -> bool {
    matches!(
        (now, goal),
        (Head::Attached { reference: a, .. }, Head::Attached { reference: b, .. }) if a == b
    )
}

fn same_branch_or_commit(a: &Head, b: &Head) -> bool {
    match (a, b) {
        (
            Head::Attached { reference: a, .. } | Head::Unborn { reference: a },
            Head::Attached { reference: b, .. } | Head::Unborn { reference: b },
        ) => a == b,
        (Head::Detached { oid: a }, Head::Detached { oid: b }) => a == b,
        _ => false,
    }
}

fn raced(planned: &Switch) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::Raced,
        format!(
            "{} moved while Git checked it out, so HEAD is not at the commit L1 Git showed. Undo puts back {}.",
            planned.to_name, planned.from_name
        ),
    )
}

fn after_trouble(planned: &Switch, ran: Result<Wrote, RepositoryError>) -> Option<RepositoryError> {
    match ran {
        Ok(wrote) if wrote.code() == Some(0) => None,
        Ok(wrote) => Some(RepositoryError::new(
            ErrorKind::AfterHookFailed {
                output: wrote.stderr().to_owned(),
            },
            format!(
                "Git checked out {}, but the post-checkout hook failed. {} puts back {}.",
                planned.to_name, planned.reverse, planned.from_name
            ),
        )),
        Err(error) => {
            let stopped = if matches!(error.kind, ErrorKind::TimedOut) {
                "ran past its deadline, so L1 Git stopped it and its hooks. Check for a hook that does not finish."
            } else {
                "was stopped before its hooks finished."
            };
            Some(RepositoryError::new(
                error.kind,
                format!(
                    "Git checked out {}, but it {stopped} {} puts back {}.",
                    planned.to_name, planned.reverse, planned.from_name
                ),
            ))
        }
    }
}

fn refusal(ran: Result<Wrote, RepositoryError>) -> RepositoryError {
    let wrote = match ran {
        Ok(wrote) => wrote,
        Err(error) => return error,
    };
    let said = wrote.stderr();
    if wrote.code() == Some(1)
        && (said.lines().last() == Some("Aborting")
            || said.contains("resolve your current index first"))
    {
        return RepositoryError::new(ErrorKind::Conflict, in_the_way(said));
    }
    let summary = stderr::summarize(said);
    if [
        "already used by worktree",
        "is already checked out at",
        "cannot switch branch",
    ]
    .iter()
    .any(|text| said.contains(text))
    {
        return RepositoryError::new(ErrorKind::Conflict, format!("Git said: {summary}"));
    }
    if said.contains(stderr::LOCK_HELD) {
        return RepositoryError::new(
            ErrorKind::LockHeld,
            format!(
                "Another Git process is changing this repository. Wait for it to finish, then try again. Git said: {summary}"
            ),
        );
    }
    RepositoryError::new(ErrorKind::GitFailed, format!("Git said: {summary}"))
}

fn in_the_way(said: &str) -> String {
    let heading = said
        .lines()
        .find(|line| line.ends_with(':') && !line.starts_with('\t'))
        .map(|line| line.trim_start_matches("error: ").trim_end_matches(':'));
    let paths: Vec<String> = said
        .lines()
        .filter_map(|line| {
            line.strip_prefix('\t')
                .or_else(|| line.strip_suffix(": needs merge"))
                .map(str::to_owned)
        })
        .collect();
    let heading = heading.unwrap_or("These files are in the way");
    if paths.is_empty() {
        return format!("Git said: {}", stderr::summarize(said));
    }
    format!(
        "{heading}: {}. Commit, discard, or move them first.",
        listed(&paths)
    )
}

fn listed(paths: &[String]) -> String {
    const SHOWN: usize = 10;
    let mut text = paths
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > SHOWN {
        text.push_str(&format!(", and {} more", paths.len() - SHOWN));
    }
    text
}

/// `git switch -c` creates the branch before it moves HEAD.
fn put_back(
    txn: &RefTxn<'_>,
    repo: &Repo,
    from: &Head,
    planned: &Switch,
) -> Result<(), RepositoryError> {
    let txn = txn.renewed()?;
    let runner = txn.runner();
    let deadline = runner.deadline();
    let from = oid(from).ok_or_else(git::malformed)?;
    let goal = oid(&planned.goal).ok_or_else(git::malformed)?;
    runner
        .git(&["read-tree", "-m", "-u", goal.as_str(), from.as_str()])
        .lazy_fetch_unprompted()
        .run(deadline)?
        .succeeded()?;
    let Some(new) = &planned.created else {
        return Ok(());
    };
    let slot = Listing::read(repo, deadline.reads())?.slot(&new.branch)?;
    if slot.tip.as_ref() == Some(&goal) {
        branches::run_delete(
            &txn,
            &BranchTip {
                reference: new.branch.clone(),
                oid: goal,
            },
        )?;
    }
    branches::set_config(&txn, &new.branch, &slot.config, &new.before)
}

fn made(
    repo: &Repo,
    new: &NewBranch,
    after: &Head,
    deadline: WriteDeadline,
) -> Result<Option<MadeBranch>, RepositoryError> {
    let slot = Listing::read(repo, deadline.reads())?.slot(&new.branch)?;
    Ok(
        (slot.tip.is_some() && slot.tip == oid(after)).then(|| MadeBranch {
            branch: new.branch.clone(),
            before: new.before.clone(),
            after: slot.config,
        }),
    )
}

pub(super) fn landed(
    repo: &Repo,
    change: &CheckoutChange,
    deadline: WriteDeadline,
) -> Result<Option<CheckoutChange>, RepositoryError> {
    let CheckoutChange::Pending {
        before,
        goal,
        created,
    } = change
    else {
        return Ok(Some(change.clone()));
    };
    if repo.head(deadline)? != *goal {
        return Ok(None);
    }
    let created = match created {
        None => None,
        Some(new) => match made(repo, new, goal, deadline)? {
            Some(made) => Some(made),
            None => return Ok(None),
        },
    };
    Ok(Some(CheckoutChange::Landed {
        before: before.clone(),
        after: goal.clone(),
        created,
    }))
}

pub(super) fn step(
    repo: &Repo,
    entry: &EntryObjects,
    change: &CheckoutChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<Option<RepositoryError>, RepositoryError> {
    let CheckoutChange::Landed {
        before,
        after,
        created,
    } = change
    else {
        return Err(git::malformed());
    };
    let (from, to, name) = match direction {
        Direction::Undo => (after, before, "undo"),
        Direction::Redo => (before, after, "redo"),
    };
    refuse_unfinished(repo, &format!("{name} the checkout"), deadline.reads())?;
    let txn = RefTxn::begin(repo, deadline)?;
    let runner = txn.runner();
    let head = repo.head(deadline)?;
    let tip = oid(after).ok_or_else(git::malformed)?;
    let mut trouble = None;
    if head == *from {
        if let (Direction::Undo, Some(made)) = (direction, created) {
            refuse_unmaking(repo, made, &tip, deadline.reads())?;
        }
        let remake = created.as_ref().filter(|_| direction == Direction::Redo);
        let planned = Switch::to_recorded(repo, entry, runner, from, to, remake, direction)?;
        let left = oid(from).ok_or_else(git::malformed)?;
        refuse_absorbing(repo, &left, to, &planned.to_name, deadline.reads())?;
        if matches!(from, Head::Detached { .. }) {
            entry.keep_left_behind(runner, &left, None)?;
        }
        match switch(&txn, repo, from, &planned, deadline) {
            Outcome::Reached {
                after: now,
                trouble: reached,
            } if now == *to => trouble = reached,
            Outcome::Reached { .. } => {
                return Err(RepositoryError::new(
                    ErrorKind::Raced,
                    format!(
                        "{} moved while Git checked it out, so HEAD is not at the commit this checkout recorded, and L1 Git cannot {name} it exactly. Refresh.",
                        planned.to_name
                    ),
                ));
            }
            Outcome::Failed(error) | Outcome::Unread(error) => return Err(error),
        }
    } else if head != *to {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            format!("HEAD moved after this checkout, so L1 Git cannot {name} it exactly. Refresh."),
        ));
    } else if let (Direction::Redo, Some(made)) = (direction, created) {
        return Err(branches::exists_again(&made.branch, "redo this checkout"));
    }
    if let Some(made) = created {
        let txn = txn.renewed()?;
        match direction {
            Direction::Undo => unmake(&txn, repo, entry, made, &tip)?,
            Direction::Redo => {
                let reads = txn.runner().deadline().reads();
                let slot = Listing::read(repo, reads)?.slot(&made.branch)?;
                branches::set_config(&txn, &made.branch, &slot.config, &made.after)?;
            }
        }
    }
    Ok(trouble)
}

fn refuse_unmaking(
    repo: &Repo,
    made: &MadeBranch,
    tip: &Oid,
    reads: Deadline,
) -> Result<(), RepositoryError> {
    let listing = Listing::read(repo, reads)?;
    let mut slot = listing.slot(&made.branch)?;
    if slot.tip.as_ref() != Some(tip) {
        return Err(made_moved(made));
    }
    listing.refuse_symbolic(&made.branch)?;
    if slot.heads.len() > 1 {
        return Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "Another worktree also has {} checked out, so L1 Git cannot delete it on Undo. Switch that worktree to another branch first.",
                made.branch.name()
            ),
        ));
    }
    slot.heads.clear();
    listing.refuse_in_use(repo, &slot)
}

fn made_moved(made: &MadeBranch) -> RepositoryError {
    let name = made.branch.name();
    RepositoryError::stale(
        StaleReason::BranchChanged,
        format!(
            "{name} moved since this checkout created it, so L1 Git cannot delete it on Undo without losing its new commits. Refresh."
        ),
    )
}

fn unmake(
    txn: &RefTxn<'_>,
    repo: &Repo,
    entry: &EntryObjects,
    made: &MadeBranch,
    tip: &Oid,
) -> Result<(), RepositoryError> {
    let listing = Listing::read(repo, txn.runner().deadline().reads())?;
    let slot = listing.slot(&made.branch)?;
    match &slot.tip {
        Some(now) if now == tip => {
            listing.refuse_symbolic(&made.branch)?;
            listing.refuse_in_use(repo, &slot)?;
            entry.keep_left_behind(txn.runner(), tip, Some(made.branch.name()))?;
            branches::run_delete(
                txn,
                &BranchTip {
                    reference: made.branch.clone(),
                    oid: tip.clone(),
                },
            )?;
        }
        None => {}
        Some(_) => return Err(made_moved(made)),
    }
    branches::set_config(txn, &made.branch, &slot.config, &made.before)
}

fn shown(head: &Head) -> String {
    match head {
        Head::Attached { reference, .. } | Head::Unborn { reference } => reference
            .strip_prefix("refs/heads/")
            .unwrap_or(reference)
            .to_owned(),
        Head::Detached { oid } => oid.chars().take(7).collect(),
    }
}
