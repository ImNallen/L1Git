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
    repository, stderr, sync,
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

    fn reference(&self) -> Option<&str> {
        match self {
            Self::Commit { .. } => None,
            Self::Local { reference, .. } => Some(reference.as_str()),
            Self::Remote { reference, .. } => Some(reference.as_str()),
        }
    }

    fn name(&self) -> &str {
        self.reference().unwrap_or(self.oid().as_str())
    }

    fn verified(&self) -> Option<Move> {
        self.reference().map(|reference| Move {
            name: reference.to_owned(),
            old: Some(self.oid().clone()),
            new: Some(self.oid().clone()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Slot {
    branch: BranchRef,
    pub(super) tip: Option<Oid>,
    pub(super) config: Vec<Setting>,
    pub(super) heads: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Setting {
    key: String,
    value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BranchChange {
    before: Vec<Slot>,
    after: Option<Vec<Slot>>,
}

impl BranchChange {
    fn landed(before: &[Slot], after: Vec<Slot>) -> Option<Self> {
        Transition::between(before, &after).ok()?;
        Some(Self {
            before: before.to_vec(),
            after: Some(after),
        })
    }
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

struct WorktreeHead {
    root: String,
    branch: Option<String>,
}

struct Listed {
    reference: String,
    oid: String,
    symref: String,
}

pub(super) struct Listing {
    branches: Vec<Listed>,
    config: Vec<(String, String)>,
    worktrees: Vec<WorktreeHead>,
}

impl Listing {
    pub(super) fn read(repo: &Repo, reads: Deadline) -> Result<Self, RepositoryError> {
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
        let config = config(repo, &["--local"], reads)?;
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
                Some(WorktreeHead {
                    root: git::text(root),
                    branch,
                })
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

    pub(super) fn slot(&self, branch: &BranchRef) -> Result<Slot, RepositoryError> {
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
                .filter(|head| head.branch.as_deref() == Some(branch.as_str()))
                .map(|head| head.root.clone())
                .collect(),
        })
    }

    fn slots_like(&self, slots: &[Slot]) -> Result<Vec<Slot>, RepositoryError> {
        slots.iter().map(|slot| self.slot(&slot.branch)).collect()
    }

    pub(super) fn refuse_symbolic(&self, branch: &BranchRef) -> Result<(), RepositoryError> {
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

    /// A loose ref is a file, so a disk that folds case, which Git records in
    /// `core.ignorecase`, folds each folder and name of a branch. Reftable
    /// keeps names apart on any disk.
    fn folds_case(&self) -> bool {
        let set = |name: &str, wanted: &str| {
            self.config
                .iter()
                .any(|(key, value)| key == name && value.eq_ignore_ascii_case(wanted))
        };
        set("core.ignorecase", "true") && !set("extensions.refstorage", "reftable")
    }

    pub(super) fn refuse_clash(
        &self,
        target: &BranchRef,
        source: Option<&BranchRef>,
    ) -> Result<(), RepositoryError> {
        let folds = self.folds_case();
        let same = |a: &str, b: &str| a == b || (folds && a.to_lowercase() == b.to_lowercase());
        let name = target.name();
        let clash = |message: String| Err(RepositoryError::new(ErrorKind::InvalidRef, message));
        if let Some(source) = source
            .map(BranchRef::name)
            .filter(|source| *source != name && same(source, name))
        {
            return clash(format!(
                "This repository does not tell names apart by case, so Git cannot rename '{source}' to '{name}' in one step. Rename it to another name first, then to '{name}'."
            ));
        }
        let wanted: Vec<_> = name.split('/').collect();
        for other in self
            .branches
            .iter()
            .filter_map(|listed| listed.reference.strip_prefix("refs/heads/"))
            .filter(|other| source.is_none_or(|source| source.name() != *other))
        {
            let theirs: Vec<_> = other.split('/').collect();
            let shared = wanted
                .iter()
                .zip(&theirs)
                .take_while(|(a, b)| a == b)
                .count();
            let last = |parts: &[&str]| shared + 1 == parts.len();
            let message = match (wanted.get(shared), theirs.get(shared)) {
                (None, None) => format!("A branch named '{name}' already exists."),
                (Some(a), Some(b)) if !same(a, b) => continue,
                (Some(_), Some(_)) if last(&wanted) && last(&theirs) => format!(
                    "A branch named '{other}' already exists, and this repository does not tell names apart by case."
                ),
                (Some(_), Some(_)) if !last(&wanted) && !last(&theirs) => format!(
                    "A branch named '{other}' already exists, and this repository does not tell names apart by case. Write the folder as '{}'.",
                    theirs[..=shared].join("/")
                ),
                _ => format!(
                    "A branch named '{other}' already exists, so Git cannot also store '{name}'."
                ),
            };
            return clash(message);
        }
        Ok(())
    }

    pub(super) fn refuse_in_use(&self, repo: &Repo, slot: &Slot) -> Result<(), RepositoryError> {
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
                self.worktrees.first().map(|head| head.root.clone())
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

pub(super) fn config(
    repo: &Repo,
    scope: &[&str],
    reads: Deadline,
) -> Result<Vec<(String, String)>, RepositoryError> {
    let mut args = vec!["config"];
    args.extend(scope);
    args.extend(["-z", "--list"]);
    Ok(git::read(&repo.root, &args, reads)?
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| {
            let text = git::text(record);
            match text.split_once('\n') {
                Some((key, value)) => (key.to_owned(), value.to_owned()),
                // Git reads a config key with no value as true.
                None => (text, "true".to_owned()),
            }
        })
        .collect())
}

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

pub(super) fn new_name(
    repo: &Repo,
    name: &str,
    reads: Deadline,
) -> Result<BranchRef, RepositoryError> {
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

pub(super) fn moved(name: &str) -> RepositoryError {
    RepositoryError::stale(
        StaleReason::BranchChanged,
        format!(
            "{name} is no longer at the commit L1 Git showed, so nothing changed. Refresh and try again."
        ),
    )
}

pub(super) fn exists_again(branch: &BranchRef, doing: &str) -> RepositoryError {
    let name = branch.name();
    RepositoryError::stale(
        StaleReason::BranchChanged,
        format!(
            "A branch named {name} exists again, so L1 Git cannot {doing} without taking over a branch it may not have made. Delete or rename {name} first."
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
    if let Some(start) = at.reference()
        && !sync::is_at(&writing.repo.root, start, at.oid(), reads)?
    {
        return Err(moved(short(start)));
    }
    let upstream = Upstream::of(writing.repo, name, at, reads)?;
    let reflog = format!("branch: Created from {}", at.name());
    record_around(writing, vec![before], None, |txn| {
        let mut moves = vec![Move {
            name: branch.as_str().to_owned(),
            old: None,
            new: Some(at.oid().clone()),
        }];
        moves.extend(at.verified());
        refs::transact(txn, &moves, &reflog).map_err(as_branch_changed)?;
        upstream
            .as_ref()
            .map_or(Ok(()), |upstream| upstream.set(txn, name))
    })
}

enum Track {
    Never,
    Remote,
    Always,
    Inherit,
    Simple,
}

struct Upstream {
    remote: String,
    merges: Vec<String>,
    rebase: bool,
}

impl Upstream {
    fn of(
        repo: &Repo,
        name: &str,
        at: &Start,
        reads: Deadline,
    ) -> Result<Option<Self>, RepositoryError> {
        let Some(start) = at.reference() else {
            return Ok(None);
        };
        let config = config(repo, &[], reads)?;
        let last = |key: &str| values(&config, key).last().copied();
        let track = match last("branch.autosetupmerge") {
            None => Track::Remote,
            Some("always") => Track::Always,
            Some("inherit") => Track::Inherit,
            Some("simple") => Track::Simple,
            Some(_) => {
                let read = ["config", "--type=bool", "--get", "branch.autoSetupMerge"];
                match git::line(&git::read(&repo.root, &read, reads)?).as_str() {
                    "false" => Track::Never,
                    _ => Track::Remote,
                }
            }
        };
        let upstream = |remote: Option<&str>, merges: Vec<String>| Self {
            remote: remote.unwrap_or(".").to_owned(),
            rebase: match last("branch.autosetuprebase") {
                Some("always") => true,
                Some("local") => remote.is_none(),
                Some("remote") => remote.is_some(),
                _ => false,
            },
            merges,
        };
        let shown = short(start);
        let tracked = match (track, at) {
            (Track::Inherit, Start::Local { .. }) => {
                let merges: Vec<_> = values(&config, &format!("branch.{shown}.merge"))
                    .into_iter()
                    .map(str::to_owned)
                    .collect();
                last(&format!("branch.{shown}.remote"))
                    .filter(|_| !merges.is_empty())
                    .map(|remote| upstream(Some(remote), merges))
            }
            (Track::Never | Track::Inherit, _) => None,
            (track, _) => match fetched_into(&config, start)[..] {
                [] => (matches!(track, Track::Always) && matches!(at, Start::Local { .. }))
                    .then(|| upstream(None, vec![start.to_owned()])),
                [(remote, ref source)] => (!matches!(track, Track::Simple)
                    || *source == format!("refs/heads/{name}"))
                .then(|| upstream(Some(remote), vec![source.clone()])),
                _ => {
                    return Err(RepositoryError::new(
                        ErrorKind::InvalidRef,
                        format!(
                            "More than one remote's fetch refspec maps to {shown}, so Git would not set the new branch's upstream. Give each remote its own refs/remotes/ folder, then try again."
                        ),
                    ));
                }
            },
        };
        if let Some(upstream) = &tracked
            && upstream.rebase
            && upstream.merges.len() > 1
        {
            return Err(RepositoryError::new(
                ErrorKind::InvalidRef,
                format!(
                    "{shown} has more than one upstream, and Git does not give a new branch more than one when branch.autoSetupRebase asks it to rebase. Start the branch from a commit instead."
                ),
            ));
        }
        Ok(tracked)
    }

    fn set(&self, txn: &RefTxn<'_>, name: &str) -> Result<(), RepositoryError> {
        let runner = txn.runner();
        let deadline = runner.deadline();
        let what = "set the branch's upstream";
        let key = |field: &str| format!("branch.{name}.{field}");
        let run = |args: &[&str]| {
            let mut all = vec!["config", "--local"];
            all.extend(args);
            runner.git(&all).run(deadline)
        };
        finished(&run(&["--", &key("remote"), &self.remote])?, what)?;
        run(&["--unset-all", "--", &key("merge")])?;
        for merge in &self.merges {
            finished(&run(&["--add", "--", &key("merge"), merge])?, what)?;
        }
        if self.rebase {
            finished(&run(&["--", &key("rebase"), "true"])?, what)?;
        }
        Ok(())
    }
}

pub(super) fn fetched_into<'c>(
    config: &'c [(String, String)],
    reference: &str,
) -> Vec<(&'c str, String)> {
    let refspecs: Vec<(&str, &str)> = config
        .iter()
        .filter_map(|(key, value)| {
            let remote = key.strip_prefix("remote.")?.strip_suffix(".fetch")?;
            Some((remote, value.as_str()))
        })
        .collect();
    let excluded = |remote: &str, source: &str| {
        refspecs.iter().any(|(other, value)| {
            *other == remote
                && value
                    .strip_prefix('^')
                    .is_some_and(|pattern| refspec_side_matches(pattern, source))
        })
    };
    let mut found: Vec<(&str, String)> = Vec::new();
    for (remote, value) in &refspecs {
        let Some((source, destination)) = value.strip_prefix('+').unwrap_or(value).split_once(':')
        else {
            continue;
        };
        let mapped = match (source.split_once('*'), destination.split_once('*')) {
            (Some((head, tail)), Some((prefix, suffix))) => reference
                .strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix(suffix))
                .map(|matched| format!("{head}{matched}{tail}")),
            (None, None) => (destination == reference).then(|| source.to_owned()),
            _ => None,
        };
        if let Some(mapped) = mapped
            && !excluded(remote, &mapped)
            && found.iter().all(|(seen, _)| seen != remote)
        {
            found.push((remote, mapped));
        }
    }
    found
}

fn refspec_side_matches(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        Some((prefix, suffix)) => {
            name.len() >= prefix.len() + suffix.len()
                && name.starts_with(prefix)
                && name.ends_with(suffix)
        }
        None => pattern == name,
    }
}

fn values<'c>(config: &'c [(String, String)], key: &str) -> Vec<&'c str> {
    config
        .iter()
        .filter(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
        .collect()
}

pub(super) fn short(reference: &str) -> &str {
    reference
        .strip_prefix("refs/heads/")
        .or_else(|| reference.strip_prefix("refs/remotes/"))
        .unwrap_or(reference)
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
        return Err(moved(tip.reference.name()));
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
    record_around(writing, vec![source, left], None, |txn| {
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
        return Err(moved(tip.reference.name()));
    }
    listing.refuse_in_use(writing.repo, &before)?;
    let config = before.config.clone();
    record_around(writing, vec![before], Some(tip), |txn| {
        run_delete(txn, tip)?;
        set_config(txn, &tip.reference, &config, &[])
    })
}

pub(super) fn run_delete(txn: &RefTxn<'_>, tip: &BranchTip) -> Result<(), RepositoryError> {
    let delete = Move {
        name: tip.reference.as_str().to_owned(),
        old: Some(tip.oid.clone()),
        new: None,
    };
    refs::transact(txn, &[delete], "branch: Deleted by L1 Git").map_err(as_branch_changed)
}

fn record_around(
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
    let Some(change) = BranchChange::landed(&before, after) else {
        let names: Vec<_> = before.iter().map(|slot| slot.branch.name()).collect();
        return Err(RepositoryError::stale(
            StaleReason::BranchChanged,
            format!(
                "{} changed in a way L1 Git cannot undo, so this change has no Undo. Refresh to see the branches.",
                names.join(" and ")
            ),
        ));
    };
    match recorded.replace(&Change::Branch(change)) {
        Ok(()) => recorded.confirm(),
        Err(_) => recorded.stay_pending(),
    }
    acted.map(|()| applied)
}

pub(super) fn set_config(
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

pub(super) fn step(
    repo: &Repo,
    entry: &EntryObjects,
    change: &BranchChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let after = change.after.as_deref().ok_or_else(git::malformed)?;
    let (from, to, step, reflog) = match direction {
        Direction::Undo => (after, change.before.as_slice(), "undo", "l1git undo"),
        Direction::Redo => (change.before.as_slice(), after, "redo", "l1git redo"),
    };
    let listing = Listing::read(repo, deadline.reads())?;
    let mut current = listing.slots_like(from)?;
    let txn = RefTxn::begin(repo, deadline)?;
    let transition = Transition::between(from, to)?;
    if let Transition::Create(slot) = transition
        && guarded(&current) != guarded(from)
    {
        return Err(exists_again(&slot.branch, &format!("{step} this change")));
    }
    if guarded(&current) != guarded(to) {
        if guarded(&current) != guarded(from) {
            let names: Vec<_> = from.iter().map(|slot| slot.branch.name()).collect();
            return Err(RepositoryError::stale(
                StaleReason::BranchChanged,
                format!(
                    "{} changed after this change, so L1 Git cannot {step} it exactly. Refresh.",
                    names.join(" or ")
                ),
            ));
        }
        match transition {
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
        current = Listing::read(repo, deadline.renewed().reads())?.slots_like(to)?;
    } else if let Transition::Delete(slot) = transition {
        let tip = slot.tip.as_ref().ok_or_else(git::malformed)?;
        entry.keep_branch(txn.runner(), tip, slot.branch.name())?;
    }
    for (now, wanted) in current.iter().zip(to) {
        set_config(&txn, &wanted.branch, &now.config, &wanted.config)?;
    }
    Ok(())
}

pub(super) fn landed(
    repo: &Repo,
    change: &BranchChange,
    deadline: WriteDeadline,
) -> Result<Option<BranchChange>, RepositoryError> {
    let now = Listing::read(repo, deadline.reads())?.slots_like(&change.before)?;
    Ok(BranchChange::landed(&change.before, now))
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
