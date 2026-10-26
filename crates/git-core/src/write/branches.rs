use super::{
    Applied, Change, Direction, Operation, RefTxn, Repo,
    refs::{self, Move},
    store::{EntryObjects, LockedStore, Log},
    txn::Runner,
};
use crate::{
    BranchMerged, BranchRef, ErrorKind, Oid, RemoteRef, RepositoryError, StaleReason,
    UpstreamMerged,
    git::{self, Capped, Deadline, WriteDeadline, Wrote},
    repository, stderr,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// A local branch and the tip the user saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchTip {
    pub reference: BranchRef,
    pub oid: Oid,
}

/// Where a new branch starts. A branch start must still point at `oid`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Start {
    Commit { oid: Oid },
    Local { reference: BranchRef, oid: Oid },
    Remote { reference: RemoteRef, oid: Oid },
}

impl Start {
    const fn oid(&self) -> &Oid {
        match self {
            Self::Commit { oid } | Self::Local { oid, .. } | Self::Remote { oid, .. } => oid,
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Commit { oid } => oid.as_str(),
            Self::Local { reference, .. } => reference.as_str(),
            Self::Remote { reference, .. } => reference.as_str(),
        }
    }

    fn verified(&self) -> Option<Move> {
        let reference = match self {
            Self::Commit { .. } => return None,
            Self::Local { reference, .. } => reference.as_str(),
            Self::Remote { reference, .. } => reference.as_str(),
        };
        Some(Move {
            name: reference.to_owned(),
            old: Some(self.oid().clone()),
            new: Some(self.oid().clone()),
        })
    }
}

/// One branch name as Git holds it: its tip, its config section, and the
/// worktrees whose HEAD names it. Undo and redo guard the tip and the
/// worktrees, and put the config back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Slot {
    branch: BranchRef,
    tip: Option<Oid>,
    config: Vec<Setting>,
    heads: Vec<String>,
}

/// One `branch.<name>.<key>` entry. Git reads a key with no value as true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Setting {
    key: String,
    value: String,
}

/// The branch names a write touched, before it and after it. One slot for a
/// create or delete, the old and the new name for a rename. `after` is
/// missing only while the write runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BranchChange {
    before: Vec<Slot>,
    after: Option<Vec<Slot>>,
}

fn guarded(slots: &[Slot]) -> Vec<(&BranchRef, &Option<Oid>, &[String])> {
    slots
        .iter()
        .map(|slot| (&slot.branch, &slot.tip, slot.heads.as_slice()))
        .collect()
}

enum Transition<'a> {
    Create(&'a Slot),
    Delete(&'a Slot),
    Rename(&'a BranchRef, &'a BranchRef),
}

impl<'a> Transition<'a> {
    fn between(from: &'a [Slot], to: &'a [Slot]) -> Result<Self, RepositoryError> {
        match (from, to) {
            ([old], [new]) if old.tip.is_none() && new.tip.is_some() => Ok(Self::Create(new)),
            ([old], [new]) if old.tip.is_some() && new.tip.is_none() => Ok(Self::Delete(old)),
            ([a, b], [c, d])
                if a.tip.is_some() && d.tip.is_some() && b.tip.is_none() && c.tip.is_none() =>
            {
                Ok(Self::Rename(&a.branch, &b.branch))
            }
            ([a, b], [c, d])
                if b.tip.is_some() && c.tip.is_some() && a.tip.is_none() && d.tip.is_none() =>
            {
                Ok(Self::Rename(&b.branch, &a.branch))
            }
            _ => Err(git::malformed()),
        }
    }
}

struct Listed {
    reference: String,
    oid: String,
    symref: String,
}

/// Every local branch, the repository's config, and every worktree's HEAD,
/// read in three Git commands.
struct Listing {
    branches: Vec<Listed>,
    config: Vec<(String, String)>,
    /// Each worktree's root as Git prints it, and the branch its HEAD names.
    /// Prunable and locked worktrees count, as they do for `git branch -d`.
    worktrees: Vec<(String, Option<String>)>,
}

impl Listing {
    fn read(repo: &Repo, reads: Deadline) -> Result<Self, RepositoryError> {
        let refs = git::read(
            &repo.root,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(objectname)%00%(symref)",
                "refs/heads/",
            ],
            reads,
        )?;
        let branches = refs
            .split(|byte| *byte == b'\n')
            .filter(|row| !row.is_empty())
            .map(
                |row| match row.split(|byte| *byte == 0).collect::<Vec<_>>()[..] {
                    [reference, oid, symref] => Ok(Listed {
                        reference: git::text(reference),
                        oid: git::text(oid),
                        symref: git::text(symref),
                    }),
                    _ => Err(git::malformed()),
                },
            )
            .collect::<Result<_, _>>()?;
        let config = git::read(&repo.root, &["config", "--local", "-z", "--list"], reads)?
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
            .map(|record| {
                let text = git::text(record);
                match text.split_once('\n') {
                    Some((key, value)) => (key.to_owned(), value.to_owned()),
                    None => (text, "true".to_owned()),
                }
            })
            .collect();
        let listed = git::read(
            &repo.root,
            &["worktree", "list", "--porcelain", "-z"],
            reads,
        )?;
        let fields: Vec<_> = listed.split(|byte| *byte == 0).collect();
        let worktrees = fields
            .split(|field| field.is_empty())
            .filter_map(|record| {
                let root = record
                    .iter()
                    .find_map(|field| field.strip_prefix(b"worktree "))?;
                let branch = record
                    .iter()
                    .find_map(|field| field.strip_prefix(b"branch "))
                    .map(git::text);
                Some((git::text(root), branch))
            })
            .collect();
        Ok(Self {
            branches,
            config,
            worktrees,
        })
    }

    fn listed(&self, branch: &BranchRef) -> Option<&Listed> {
        self.branches
            .iter()
            .find(|listed| listed.reference == branch.as_str())
    }

    fn slot(&self, branch: &BranchRef) -> Result<Slot, RepositoryError> {
        let tip = self
            .listed(branch)
            .map(|listed| Oid::try_from(listed.oid.clone()))
            .transpose()
            .map_err(|_| git::malformed())?;
        let prefix = format!("branch.{}.", branch.name());
        Ok(Slot {
            branch: branch.clone(),
            tip,
            config: self
                .config
                .iter()
                .filter_map(|(key, value)| {
                    let key = key.strip_prefix(&prefix).filter(|key| !key.contains('.'))?;
                    Some(Setting {
                        key: key.to_owned(),
                        value: value.clone(),
                    })
                })
                .collect(),
            heads: self
                .worktrees
                .iter()
                .filter(|(_, head)| head.as_deref() == Some(branch.as_str()))
                .map(|(root, _)| root.clone())
                .collect(),
        })
    }

    fn slots_like(&self, slots: &[Slot]) -> Result<Vec<Slot>, RepositoryError> {
        slots.iter().map(|slot| self.slot(&slot.branch)).collect()
    }

    /// `update-ref` follows a symbolic ref, so a delete or rename of one
    /// would change the branch it points at.
    fn refuse_symbolic(&self, branch: &BranchRef) -> Result<(), RepositoryError> {
        match self.listed(branch) {
            Some(listed) if !listed.symref.is_empty() => Err(RepositoryError::new(
                ErrorKind::InvalidRef,
                format!(
                    "{} points at {}. L1 Git does not change symbolic branches.",
                    branch.name(),
                    listed.symref
                ),
            )),
            Some(_) | None => Ok(()),
        }
    }

    fn ignores_case(&self) -> bool {
        self.config
            .iter()
            .any(|(key, value)| key == "core.ignorecase" && value.eq_ignore_ascii_case("true"))
    }

    /// Refuses a new name that another branch already holds, or that Git
    /// could not store beside one, as a file beside a folder of the same
    /// name, or in another case on a disk that ignores case.
    fn refuse_clash(
        &self,
        target: &BranchRef,
        source: Option<&BranchRef>,
    ) -> Result<(), RepositoryError> {
        let fold = |name: &str| {
            if self.ignores_case() {
                name.to_lowercase()
            } else {
                name.to_owned()
            }
        };
        let name = target.name();
        let wanted = fold(name);
        let clash = |message: String| Err(RepositoryError::new(ErrorKind::InvalidRef, message));
        for listed in &self.branches {
            if source.is_some_and(|source| source.as_str() == listed.reference) {
                continue;
            }
            let Some(other) = listed.reference.strip_prefix("refs/heads/") else {
                continue;
            };
            let folded = fold(other);
            if other == name {
                return clash(format!("A branch named '{name}' already exists."));
            }
            if folded == wanted {
                return clash(format!(
                    "A branch named '{other}' already exists, and this repository does not tell names apart by case."
                ));
            }
            if folded.starts_with(&format!("{wanted}/"))
                || wanted.starts_with(&format!("{folded}/"))
            {
                return clash(format!(
                    "A branch named '{other}' already exists, so Git cannot also store '{name}'."
                ));
            }
        }
        Ok(())
    }

    /// Git refuses to delete a branch that a worktree has checked out, or is
    /// rebasing or bisecting.
    fn refuse_in_use(&self, repo: &Repo, slot: &Slot) -> Result<(), RepositoryError> {
        let name = slot.branch.name();
        if let Some(root) = slot.heads.first() {
            return Err(RepositoryError::new(
                ErrorKind::Conflict,
                format!(
                    "{name} is checked out in {root}, so L1 Git cannot delete it. Switch that worktree to another branch first."
                ),
            ));
        }
        if let Some(gitdir) = operation_on(repo, &slot.branch) {
            let root = if gitdir == repo.common_dir {
                self.worktrees.first().map(|(root, _)| root.clone())
            } else {
                fs::read_to_string(gitdir.join("gitdir")).ok().map(|file| {
                    Path::new(file.trim_end())
                        .parent()
                        .map_or_else(String::new, |root| root.to_string_lossy().into_owned())
                })
            }
            .unwrap_or_default();
            return Err(RepositoryError::new(
                ErrorKind::Conflict,
                format!(
                    "Git is rebasing or bisecting {name} in {root}, so L1 Git cannot delete it. Finish or abort that with Git first."
                ),
            ));
        }
        Ok(())
    }
}

fn operation_on(repo: &Repo, branch: &BranchRef) -> Option<PathBuf> {
    let mut gitdirs = vec![repo.common_dir.clone()];
    if let Ok(names) = fs::read_dir(repo.common_dir.join("worktrees")) {
        gitdirs.extend(names.flatten().map(|name| name.path()));
    }
    gitdirs.into_iter().find(|gitdir| {
        let read = |file: &str| fs::read_to_string(gitdir.join(file)).unwrap_or_default();
        read("rebase-merge/head-name").trim_end() == branch.as_str()
            || read("rebase-apply/head-name").trim_end() == branch.as_str()
            || read("rebase-merge/update-refs")
                .lines()
                .any(|line| line == branch.as_str())
            || read("BISECT_START").trim_end() == branch.name()
    })
}

/// The context every branch write shares.
pub(super) struct Writing<'a> {
    pub(super) repo: &'a Repo,
    pub(super) store: &'a LockedStore,
    pub(super) log: &'a Log,
    pub(super) deadline: WriteDeadline,
    pub(super) operation: &'a Operation,
}

const NAME_OUTPUT_CAP: usize = 64 * 1024;

fn invalid_name(name: &str) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::InvalidRef,
        format!("'{name}' is not a valid branch name."),
    )
}

/// Checks a new name with `git check-ref-format --branch` and answers Git's
/// reason when it refuses.
fn new_name(repo: &Repo, name: &str, reads: Deadline) -> Result<BranchRef, RepositoryError> {
    if name.contains('\0') || name.starts_with("refs/") {
        return Err(invalid_name(name));
    }
    let ran = git::run_capped(
        &repo.root,
        &["check-ref-format", "--branch", name],
        NAME_OUTPUT_CAP,
        reads,
    )?;
    let printed = match &ran.stdout {
        Capped::Within(printed) => git::line(printed),
        Capped::Over(_) => return Err(git::malformed()),
    };
    if ran.code != Some(0) {
        let said = ran.stderr();
        let reason = said
            .lines()
            .next()
            .map(|line| line.strip_prefix("fatal: ").unwrap_or(line).to_owned())
            .filter(|line| !line.is_empty());
        return Err(match reason {
            Some(reason) => RepositoryError::new(ErrorKind::InvalidRef, format!("{reason}.")),
            None => invalid_name(name),
        });
    }
    if printed != name {
        return Err(invalid_name(name));
    }
    BranchRef::try_from(format!("refs/heads/{name}")).map_err(|_| invalid_name(name))
}

fn moved(branch: &BranchRef) -> RepositoryError {
    RepositoryError::stale(
        StaleReason::BranchChanged,
        format!(
            "{} is no longer at the commit L1 Git showed, so nothing changed. Refresh and try again.",
            branch.name()
        ),
    )
}

fn as_branch_changed(error: RepositoryError) -> RepositoryError {
    let head_moved = ErrorKind::StaleView {
        reason: StaleReason::HeadMoved,
    };
    if error.kind == head_moved {
        RepositoryError::stale(StaleReason::BranchChanged, error.message)
    } else {
        error
    }
}

pub(super) fn create(
    writing: &Writing<'_>,
    name: &str,
    at: &Start,
) -> Result<Applied, RepositoryError> {
    let reads = writing.deadline.reads();
    let branch = new_name(writing.repo, name, reads)?;
    let listing = Listing::read(writing.repo, reads)?;
    listing.refuse_clash(&branch, None)?;
    let before = listing.slot(&branch)?;
    if let Some(root) = before.heads.first() {
        return Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The worktree at {root} waits for its first commit on {name}, so a new {name} would move it. Choose another name."
            ),
        ));
    }
    let upstream = match at {
        Start::Remote { reference, .. } if tracks(writing.repo, name, reference, reads)? => {
            Some(format!("--set-upstream-to={}", reference.as_str()))
        }
        Start::Commit { .. } | Start::Local { .. } | Start::Remote { .. } => None,
    };
    let reflog = format!("branch: Created from {}", at.name());
    apply(writing, vec![before], None, |txn| {
        let mut moves = vec![Move {
            name: branch.as_str().to_owned(),
            old: None,
            new: Some(at.oid().clone()),
        }];
        moves.extend(at.verified());
        refs::transact(txn, &moves, &reflog).map_err(as_branch_changed)?;
        if let Some(upstream) = &upstream {
            txn.branch(&[upstream, "--", name])
                .run(txn.runner().deadline())?;
        }
        Ok(())
    })
}

/// Whether `git branch` would set a remote start as the new branch's
/// upstream under `branch.autoSetupMerge`.
fn tracks(
    repo: &Repo,
    name: &str,
    start: &RemoteRef,
    reads: Deadline,
) -> Result<bool, RepositoryError> {
    let ran = git::run(
        &repo.root,
        &["config", "--get", "branch.autoSetupMerge"],
        reads,
    )?;
    Ok(match git::line(&ran.stdout).to_lowercase().as_str() {
        "false" | "no" | "off" | "0" | "inherit" => false,
        "simple" => start.as_str().ends_with(&format!("/{name}")),
        _ => true,
    })
}

pub(super) fn rename(
    writing: &Writing<'_>,
    tip: &BranchTip,
    to: &str,
) -> Result<Applied, RepositoryError> {
    let reads = writing.deadline.reads();
    let target = new_name(writing.repo, to, reads)?;
    new_name(writing.repo, tip.reference.name(), reads).map_err(|error| {
        RepositoryError::new(
            error.kind,
            format!(
                "L1 Git cannot rename {}, because Git would refuse to give the name back on Undo: {}",
                tip.reference.name(),
                error.message
            ),
        )
    })?;
    if target == tip.reference {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            format!("The branch is already named {to}."),
        ));
    }
    let listing = Listing::read(writing.repo, reads)?;
    listing.refuse_symbolic(&tip.reference)?;
    let source = listing.slot(&tip.reference)?;
    if source.tip.as_ref() != Some(&tip.oid) {
        return Err(moved(&tip.reference));
    }
    listing.refuse_clash(&target, Some(&tip.reference))?;
    let left = listing.slot(&target)?;
    if !left.config.is_empty() {
        return Err(RepositoryError::new(
            ErrorKind::InvalidRef,
            format!(
                "This repository's config still holds settings for a branch named {to}, which Git would merge into the renamed branch. Remove them with git config --remove-section branch.{to}, or choose another name."
            ),
        ));
    }
    if let Some(root) = left.heads.first() {
        return Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "The worktree at {root} waits for its first commit on {to}, so renaming a branch to {to} would move it. Choose another name."
            ),
        ));
    }
    let names = [tip.reference.name(), target.name()];
    apply(writing, vec![source, left], None, |txn| {
        run_rename(txn, names[0], names[1])
    })
}

fn run_rename(txn: &RefTxn<'_>, from: &str, to: &str) -> Result<(), RepositoryError> {
    finished(
        &txn.branch(&["-m", "--", from, to])
            .run(txn.runner().deadline())?,
        "rename the branch",
    )
}

fn finished(wrote: &Wrote, what: &str) -> Result<(), RepositoryError> {
    if wrote.code() == Some(0) {
        return Ok(());
    }
    let said = wrote.stderr();
    let kind = if said.contains(stderr::LOCK_HELD) {
        ErrorKind::LockHeld
    } else {
        ErrorKind::GitFailed
    };
    Err(RepositoryError::new(
        kind,
        format!(
            "Git could not {what}. Git said: {}",
            stderr::summarize(said)
        ),
    ))
}

pub(super) fn delete(writing: &Writing<'_>, tip: &BranchTip) -> Result<Applied, RepositoryError> {
    let listing = Listing::read(writing.repo, writing.deadline.reads())?;
    listing.refuse_symbolic(&tip.reference)?;
    let before = listing.slot(&tip.reference)?;
    if before.tip.as_ref() != Some(&tip.oid) {
        return Err(moved(&tip.reference));
    }
    listing.refuse_in_use(writing.repo, &before)?;
    let config = before.config.clone();
    apply(writing, vec![before], Some(tip), |txn| {
        run_delete(txn, tip)?;
        set_config(txn, &tip.reference, &config, &[])
    })
}

fn run_delete(txn: &RefTxn<'_>, tip: &BranchTip) -> Result<(), RepositoryError> {
    let delete = Move {
        name: tip.reference.as_str().to_owned(),
        old: Some(tip.oid.clone()),
        new: None,
    };
    refs::transact(txn, &[delete], "branch: Deleted by L1 Git").map_err(as_branch_changed)
}

/// Records the slots before the write, runs it, then records the slots Git
/// left, whether or not Git finished. A write that stops after Git changed
/// something keeps its entry, so Undo puts back what Git did.
fn apply(
    writing: &Writing<'_>,
    before: Vec<Slot>,
    packed: Option<&BranchTip>,
    act: impl FnOnce(&RefTxn<'_>) -> Result<(), RepositoryError>,
) -> Result<Applied, RepositoryError> {
    let txn = RefTxn::begin(writing.repo, writing.deadline)?;
    let (applied, _, recorded) =
        writing
            .store
            .record_with(writing.repo, writing.log, writing.operation, |entry| {
                if let Some(tip) = packed {
                    entry.keep_branch(txn.runner(), &tip.oid, tip.reference.name())?;
                }
                Ok(BranchChange {
                    before: before.clone(),
                    after: None,
                })
            })?;
    let acted = act(&txn);
    let reread = Listing::read(writing.repo, writing.deadline.renewed().reads())
        .and_then(|listing| listing.slots_like(&before));
    let after = match reread {
        Ok(after) => after,
        Err(error) => {
            recorded.stay_pending();
            return Err(acted.err().unwrap_or(error));
        }
    };
    if after == before {
        return Err(acted.err().unwrap_or_else(|| {
            RepositoryError::new(ErrorKind::UnchangedPath, "Git changed nothing.")
        }));
    }
    let change = Change::Branch(BranchChange {
        before,
        after: Some(after),
    });
    match recorded.replace(&change) {
        Ok(()) => recorded.confirm(),
        Err(_) => recorded.stay_pending(),
    }
    acted.map(|()| applied)
}

/// Puts a branch's config section back to `wanted`, entry by entry, in
/// order.
fn set_config(
    txn: &RefTxn<'_>,
    branch: &BranchRef,
    now: &[Setting],
    wanted: &[Setting],
) -> Result<(), RepositoryError> {
    if now == wanted {
        return Ok(());
    }
    let runner = txn.runner();
    let deadline = runner.deadline();
    let section = format!("branch.{}", branch.name());
    let what = "change the branch's settings";
    if !now.is_empty() {
        finished(
            &runner
                .git(&["config", "--local", "--remove-section", "--", &section])
                .run(deadline)?,
            what,
        )?;
    }
    for setting in wanted {
        let key = format!("{section}.{}", setting.key);
        finished(
            &runner
                .git(&["config", "--local", "--add", "--", &key, &setting.value])
                .run(deadline)?,
            what,
        )?;
    }
    Ok(())
}

/// Undoes or redoes a branch write. A step that stopped after Git moved the
/// ref finds the ref already moved and finishes the config.
pub(super) fn step(
    repo: &Repo,
    entry: &EntryObjects,
    change: &BranchChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let after = change.after.as_deref().ok_or_else(git::malformed)?;
    let (from, to) = match direction {
        Direction::Undo => (after, change.before.as_slice()),
        Direction::Redo => (change.before.as_slice(), after),
    };
    let listing = Listing::read(repo, deadline.reads())?;
    let current = listing.slots_like(from)?;
    let txn = RefTxn::begin(repo, deadline)?;
    if guarded(&current) != guarded(to) {
        if guarded(&current) != guarded(from) {
            let names: Vec<_> = from.iter().map(|slot| slot.branch.name()).collect();
            let step = match direction {
                Direction::Undo => "undo",
                Direction::Redo => "redo",
            };
            return Err(RepositoryError::stale(
                StaleReason::BranchChanged,
                format!(
                    "{} changed after this change, so L1 Git cannot {step} it exactly. Refresh.",
                    names.join(" or ")
                ),
            ));
        }
        let reflog = match direction {
            Direction::Undo => "l1git undo",
            Direction::Redo => "l1git redo",
        };
        match Transition::between(from, to)? {
            Transition::Create(slot) => {
                let tip = slot.tip.as_ref().ok_or_else(git::malformed)?;
                entry.bring_back_branch(txn.runner(), tip)?;
                let create = Move {
                    name: slot.branch.as_str().to_owned(),
                    old: None,
                    new: Some(tip.clone()),
                };
                refs::transact(&txn, &[create], reflog).map_err(as_branch_changed)?;
            }
            Transition::Delete(slot) => {
                listing.refuse_symbolic(&slot.branch)?;
                listing.refuse_in_use(repo, slot)?;
                let tip = slot.tip.clone().ok_or_else(git::malformed)?;
                entry.keep_branch(txn.runner(), &tip, slot.branch.name())?;
                run_delete(
                    &txn,
                    &BranchTip {
                        reference: slot.branch.clone(),
                        oid: tip,
                    },
                )?;
            }
            Transition::Rename(old, new) => {
                listing.refuse_symbolic(old)?;
                run_rename(&txn, old.name(), new.name())?;
            }
        }
    }
    let now = Listing::read(repo, deadline.renewed().reads())?.slots_like(to)?;
    for (now, wanted) in now.iter().zip(to) {
        set_config(&txn, &wanted.branch, &now.config, &wanted.config)?;
    }
    Ok(())
}

/// What a write that stopped before it was marked done left, or `None` if it
/// changed nothing.
pub(super) fn landed(
    repo: &Repo,
    change: &BranchChange,
    deadline: WriteDeadline,
) -> Result<Option<BranchChange>, RepositoryError> {
    let now = Listing::read(repo, deadline.reads())?.slots_like(&change.before)?;
    Ok((now != change.before).then(|| BranchChange {
        before: change.before.clone(),
        after: Some(now),
    }))
}

pub(crate) fn merged_within(
    path: &str,
    branch: &BranchTip,
    reads: Deadline,
) -> Result<BranchMerged, RepositoryError> {
    let root = repository::root(path, reads)?;
    let tip = branch.oid.as_str();
    let ancestor = |of: &str| -> Result<bool, RepositoryError> {
        let ran = git::run(&root, &["merge-base", "--is-ancestor", tip, of], reads)?;
        Ok(ran.status.code() == Some(0))
    };
    let listed = git::read(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream)",
            branch.reference.as_str(),
        ],
        reads,
    )?;
    let upstream = listed
        .split(|byte| *byte == b'\n')
        .find_map(|row| {
            let (reference, upstream) = row.split_at(row.iter().position(|byte| *byte == 0)?);
            (reference == branch.reference.as_str().as_bytes()).then(|| git::text(&upstream[1..]))
        })
        .filter(|upstream| !upstream.is_empty());
    let upstream = match upstream {
        Some(reference)
            if git::run(
                &root,
                &[
                    "rev-parse",
                    "--quiet",
                    "--verify",
                    &format!("{reference}^{{commit}}"),
                ],
                reads,
            )?
            .status
            .success() =>
        {
            Some(UpstreamMerged {
                merged: ancestor(&reference)?,
                reference,
            })
        }
        Some(_) | None => None,
    };
    Ok(BranchMerged {
        head: ancestor("HEAD")?,
        upstream,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Coordinator, Expect, Limits, git::LocalWrite};
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        let output = command.arg("-C").arg(root).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}");
        git::line(&output.stdout)
    }

    #[test]
    fn a_delete_stopped_after_git_keeps_its_entry_and_its_commits() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("core.hooksPath", "/dev/null"),
        ] {
            git(&root, &["config", key, value]);
        }
        git(&root, &["commit", "--quiet", "--allow-empty", "-m", "base"]);
        git(&root, &["switch", "--quiet", "-c", "topic"]);
        git(
            &root,
            &["commit", "--quiet", "--allow-empty", "-m", "only on topic"],
        );
        git(&root, &["switch", "--quiet", "main"]);
        git(&root, &["config", "branch.topic.merge", "refs/heads/topic"]);
        let tip = BranchTip {
            reference: BranchRef::try_from("refs/heads/topic".to_owned()).unwrap(),
            oid: Oid::try_from(git(&root, &["rev-parse", "topic"])).unwrap(),
        };
        let operation = Operation::DeleteBranch {
            branch: tip.clone(),
        };
        let path = root.to_str().unwrap();
        let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));

        coordinator
            .locked(
                path,
                LocalWrite::DeleteBranch,
                |repo, store, log, deadline| {
                    let before = Listing::read(&repo, deadline.reads())?.slot(&tip.reference)?;
                    let txn = RefTxn::begin(&repo, deadline)?;
                    let (_, _, recorded) = store.record_with(&repo, &log, &operation, |entry| {
                        entry.keep_branch(txn.runner(), &tip.oid, "topic")?;
                        Ok(BranchChange {
                            before: vec![before],
                            after: None,
                        })
                    })?;
                    run_delete(&txn, &tip)?;
                    std::mem::forget(recorded);
                    Ok(())
                },
            )
            .unwrap();
        git(&root, &["reflog", "expire", "--expire=now", "--all"]);
        git(&root, &["gc", "--quiet", "--prune=now"]);

        let history = coordinator.undo_history(path).unwrap();
        assert_eq!(history.undo, None, "the stopped write is still pending");
        let head = repository::head(&root, Deadline::of(git::LocalRead::Refs)).unwrap();
        let made = coordinator
            .write(
                path,
                &Operation::CreateBranch {
                    name: "later".to_owned(),
                    at: Start::Commit {
                        oid: Oid::try_from(git(&root, &["rev-parse", "HEAD"])).unwrap(),
                    },
                },
                &Expect { head },
            )
            .unwrap();
        coordinator.undo(path, made.id).unwrap();
        let kept = coordinator.undo_history(path).unwrap().undo.unwrap();
        assert_eq!(kept.operation, operation);
        coordinator.undo(path, kept.id).unwrap();
        assert_eq!(
            git(&root, &["log", "--format=%s", "topic"]),
            "only on topic\nbase"
        );
        assert_eq!(
            git(&root, &["config", "branch.topic.merge"]),
            "refs/heads/topic"
        );
    }
}
