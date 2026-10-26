use super::{
    Applied, Change, CommitTxn, EntryId, Expect, Operation, Repo,
    refs::{RefChange, capitalized, oid},
    store::{LockedStore, Log},
};
use crate::{
    ErrorKind, Head, Oid, RepositoryError, StagedStamp, StaleReason, StatusEntry,
    git::{self, WriteDeadline, Wrote},
    status::{self, Untracked},
    stderr, sync,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead},
    path::PathBuf,
};

#[derive(Clone, Copy)]
pub(super) enum Kind<'a> {
    New(&'a StagedStamp),
    Amend(&'a StagedStamp),
    EditMessage,
}

impl Kind<'_> {
    const fn flags(self) -> &'static [&'static str] {
        match self {
            Self::New(_) => &[],
            Self::Amend(_) => &["--amend"],
            Self::EditMessage => &["--amend", "--only", "--allow-empty"],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    Branch(String),
    Detached,
}

impl Target {
    fn of(head: &Head) -> Self {
        match head {
            Head::Attached { reference, .. } | Head::Unborn { reference } => {
                Self::Branch(reference.clone())
            }
            Head::Detached { .. } => Self::Detached,
        }
    }

    fn at(&self, oid: Option<&Oid>) -> Result<Head, RepositoryError> {
        Ok(match (self, oid) {
            (Self::Branch(reference), Some(oid)) => Head::Attached {
                reference: reference.clone(),
                oid: oid.as_str().to_owned(),
            },
            (Self::Branch(reference), None) => Head::Unborn {
                reference: reference.clone(),
            },
            (Self::Detached, Some(oid)) => Head::Detached {
                oid: oid.as_str().to_owned(),
            },
            (Self::Detached, None) => return Err(git::malformed()),
        })
    }

    fn current(
        &self,
        repo: &Repo,
        deadline: WriteDeadline,
    ) -> Result<Option<Oid>, RepositoryError> {
        match self {
            Self::Branch(reference) => resolve(repo, deadline, reference),
            Self::Detached => Ok(match repo.head(deadline)? {
                head @ Head::Detached { .. } => oid(&head),
                Head::Attached { .. } | Head::Unborn { .. } => None,
            }),
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Branch(reference) => reference.strip_prefix("refs/heads/").unwrap_or(reference),
            Self::Detached => "detached HEAD",
        }
    }

    fn reference(&self) -> &str {
        match self {
            Self::Branch(reference) => reference,
            Self::Detached => "HEAD",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Update {
    old: Option<Oid>,
    new: Oid,
}

#[expect(
    clippy::too_many_arguments,
    reason = "the write's context and its operation's fields"
)]
pub(super) fn commit(
    repo: &Repo,
    store: &LockedStore,
    log: &Log,
    deadline: WriteDeadline,
    expect: &Expect,
    operation: &Operation,
    kind: Kind<'_>,
    message: &str,
) -> Result<Applied, RepositoryError> {
    let txn = CommitTxn::begin(repo, deadline)?;
    let reads = deadline.reads();
    if let Some(operation) = sync::in_progress(&repo.root, reads)?
        .into_iter()
        .find(|operation| operation.holds_commits())
    {
        return Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "{} is in progress in this worktree. Finish or abort it with Git first. L1 Git does not commit during one, because Undo could not put it back.",
                capitalized(operation.name())
            ),
        ));
    }
    if message.trim().is_empty() {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Write a commit message. Git refuses an empty one.",
        ));
    }
    if let Kind::New(staged) | Kind::Amend(staged) = kind {
        let (entries, stamp) = status::entries(&repo.root, Untracked::No, reads)?;
        if let Some(path) = entries.iter().find_map(|entry| match entry {
            StatusEntry::Unmerged { path, .. } => Some(path),
            StatusEntry::Ordinary { .. }
            | StatusEntry::Renamed { .. }
            | StatusEntry::Untracked { .. } => None,
        }) {
            return Err(RepositoryError::new(
                ErrorKind::Conflict,
                format!("{path} has a conflict. Mark it resolved before you commit."),
            ));
        }
        if stamp != *staged {
            return Err(RepositoryError::stale(
                StaleReason::StagedChanged,
                "The staged files changed since L1 Git showed them. Refresh and try again.",
            ));
        }
        if matches!(kind, Kind::New(_)) && entries.iter().all(|entry| !staged_side(entry)) {
            return Err(nothing_staged());
        }
    }
    let head = repo.head(deadline)?;
    if head != expect.head {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved since L1 Git read this worktree. Refresh and try again.",
        ));
    }
    let before = oid(&head);
    if before.is_none() && !matches!(kind, Kind::New(_)) {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            "There is no commit to amend yet.",
        ));
    }
    let (applied, recorded) = store.record_intent(repo, log, operation)?;
    let trace = Trace::create(store, applied.id)?;
    let wrote = txn
        .commit(kind.flags(), message)
        .traces(&trace.events, &trace.refs)
        .run(deadline)?;
    let txn = txn.renewed();
    let deadline = deadline.renewed();
    if wrote.code() != Some(0) {
        return Err(refused(&wrote, &trace));
    }
    let printed = printed(wrote.stdout()).ok_or_else(|| {
        RepositoryError::new(
            ErrorKind::GitFailed,
            "Git finished, but L1 Git could not read which commit it made, so it has no undo entry for it. Check the history.",
        )
    })?;
    let target = Target::of(&head);
    let update = named(repo, deadline, &printed)?.and_then(|made| trace.update(&target, &made));
    let Some(update) = update else {
        return Err(elsewhere(&printed, &target));
    };
    if target.current(repo, deadline)?.as_ref() != Some(&update.new) {
        return Err(elsewhere(short(&update.new), &target));
    }
    if update.old.as_ref() == Some(&update.new) {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            "Nothing changed. Git made the same commit as HEAD, because the message, the files, and the second it ran are the same.",
        ));
    }
    let race = (update.old != before).then(|| raced(kind, &update, &target));
    let replaced = match kind {
        Kind::New(_) => None,
        Kind::Amend(_) | Kind::EditMessage => update.old.clone(),
    };
    let change = RefChange::new(
        target.at(update.old.as_ref())?,
        target.at(Some(&update.new))?,
        replaced,
    )?;
    recorded
        .complete(txn.runner(), &Change::Ref(change))
        .map_err(|error| {
            RepositoryError::new(
                error.kind,
                format!(
                    "Git made the commit, but L1 Git could not record it, so it cannot undo it. {}",
                    error.message
                ),
            )
        })?;
    race.map_or(Ok(applied), Err)
}

/// Git prints `[<branch> <abbreviated oid>] <subject>` once it has moved the
/// branch and run `post-commit`. The branch there is HEAD's when Git prints,
/// which another process may have switched, so only the OID is read.
fn printed(stdout: &[u8]) -> Option<String> {
    let line = git::text(stdout.split(|byte| *byte == b'\n').next()?);
    line.split(' ').find_map(|token| {
        token
            .strip_suffix(']')
            .filter(|hex| hex.len() >= 4 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_owned)
    })
}

/// Git abbreviates the ID it prints so that no other object starts with it,
/// so the ID names our commit only while it still names one object.
fn named(
    repo: &Repo,
    deadline: WriteDeadline,
    printed: &str,
) -> Result<Option<Oid>, RepositoryError> {
    let ran = git::run(
        &repo.root,
        &["rev-parse", &format!("--disambiguate={printed}")],
        deadline.reads(),
    )?;
    let listed = git::text(&ran.stdout);
    let mut objects = listed.lines();
    match (objects.next(), objects.next()) {
        (Some(only), None) if ran.status.success() => Oid::try_from(only.to_owned())
            .map(Some)
            .map_err(|_| git::malformed()),
        _ => Ok(None),
    }
}

fn resolve(
    repo: &Repo,
    deadline: WriteDeadline,
    name: &str,
) -> Result<Option<Oid>, RepositoryError> {
    let ran = git::run(
        &repo.root,
        &["rev-parse", "-q", "--verify", &format!("{name}^{{commit}}")],
        deadline.reads(),
    )?;
    if !ran.status.success() {
        return Ok(None);
    }
    Oid::try_from(git::line(&ran.stdout))
        .map(Some)
        .map_err(|_| git::malformed())
}

fn raced(kind: Kind<'_>, update: &Update, target: &Target) -> RepositoryError {
    let made = short(&update.new);
    let old = update.old.as_ref().map_or("nothing", short);
    let name = target.name();
    RepositoryError::new(
        ErrorKind::Raced,
        match kind {
            Kind::New(_) => format!(
                "Another process moved HEAD while Git committed, so the commit {made} landed on {name} after {old} instead of after what L1 Git showed. Undo moves {name} back to {old}."
            ),
            Kind::Amend(_) | Kind::EditMessage => format!(
                "Another process moved HEAD while Git amended, so the amend {made} replaced {old} on {name}, not the commit L1 Git showed. Undo puts {old} back."
            ),
        },
    )
}

fn elsewhere(made: &str, target: &Target) -> RepositoryError {
    let name = target.name();
    RepositoryError::new(
        ErrorKind::Raced,
        format!(
            "Git made the commit {made}, but another process moved HEAD or {name} while Git committed, so {name} does not point at it. L1 Git cannot undo it. Git's reflog names it."
        ),
    )
}

fn staged_side(entry: &StatusEntry) -> bool {
    match entry {
        StatusEntry::Ordinary { sides, .. } => !matches!(sides, crate::Sides::Unstaged { .. }),
        StatusEntry::Renamed { side, .. } => matches!(side, crate::MoveSide::Staged { .. }),
        StatusEntry::Unmerged { .. } | StatusEntry::Untracked { .. } => false,
    }
}

fn short(oid: &Oid) -> &str {
    &oid.as_str()[..7]
}

fn nothing_staged() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnchangedPath,
        "Nothing is staged, so there is nothing to commit. Stage a file, or amend the previous commit.",
    )
}

fn refused(wrote: &Wrote, trace: &Trace) -> RepositoryError {
    let said = wrote.stderr();
    let printed = format!("{said}\n{}", git::text(wrote.stdout()));
    if let Some(hook) = trace.failed_hook() {
        return RepositoryError::new(
            ErrorKind::HookFailed {
                output: said.to_owned(),
            },
            format!("The {hook} hook stopped the commit, so Git made no commit."),
        );
    }
    let has = |needles: &[&str]| needles.iter().any(|needle| printed.contains(needle));
    if has(&[
        "identity unknown",
        "empty ident name",
        "no email was given",
        "no name was given",
    ]) {
        return RepositoryError::new(
            ErrorKind::MissingIdentity {
                output: said.to_owned(),
            },
            "Git does not know your name and email, so it made no commit. Set them with the commands below, then try again.",
        );
    }
    if has(&[
        "nothing to commit",
        "nothing added to commit",
        "no changes added to commit",
    ]) {
        return nothing_staged();
    }
    if has(&["Aborting commit due to empty commit message"]) {
        return RepositoryError::new(
            ErrorKind::GitFailed,
            "The message is empty once Git removes its comment lines, so Git made no commit.",
        );
    }
    if said.contains(stderr::LOCK_HELD) {
        return RepositoryError::new(
            ErrorKind::LockHeld,
            format!(
                "Another Git process is changing this repository, so Git made no commit. Wait for it to finish, then try again. Git said: {}",
                stderr::summarize(said)
            ),
        );
    }
    if said.contains("cannot lock ref") {
        return RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved while Git was committing, so Git made no commit. Refresh.",
        );
    }
    if wrote.code().is_none() || said.contains("repository has been updated") {
        return RepositoryError::new(
            ErrorKind::GitFailed,
            format!(
                "Git stopped before it finished, and it may have made the commit first. L1 Git has no undo entry for it, so check the history. Git said: {}",
                stderr::summarize(said)
            ),
        );
    }
    RepositoryError::new(
        ErrorKind::GitFailed,
        format!("Git made no commit. Git said: {}", stderr::summarize(said)),
    )
}

/// A Git process that a hook left running cannot recreate these traces once
/// the folder is gone.
struct Trace {
    dir: PathBuf,
    events: PathBuf,
    refs: PathBuf,
}

#[derive(Deserialize)]
struct Event {
    event: String,
    sid: String,
    child_id: Option<u64>,
    child_class: Option<String>,
    hook_name: Option<String>,
    #[serde(default)]
    argv: Vec<String>,
    code: Option<i64>,
}

/// `GIT_TRACE_REFS` prints each update of a finished ref transaction as
/// `<n>: <ref> <old> -> <new> (F=<flags>, T=<type>) "<reflog message>"`.
fn update_in(line: &str, reference: &str) -> Option<Update> {
    let (before, after) = line.split_once(" -> ")?;
    let mut left = before.rsplit(' ');
    let (old, name, index) = (left.next()?, left.next()?, left.next()?);
    let mut right = after.split(' ');
    let (new, flags) = (right.next()?, right.next()?);
    let numbered = index
        .strip_suffix(':')
        .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()));
    if !numbered || name != reference || !flags.starts_with("(F=") {
        return None;
    }
    let old = Oid::try_from(old.to_owned()).ok()?;
    Some(Update {
        old: old.as_str().bytes().any(|byte| byte != b'0').then_some(old),
        new: Oid::try_from(new.to_owned()).ok()?,
    })
}

/// `reference-transaction` stops a commit only while preparing.
fn stops_commit(name: &str, argv: &[String]) -> bool {
    match name {
        "pre-commit" | "prepare-commit-msg" | "commit-msg" => true,
        "reference-transaction" => argv
            .get(1)
            .is_some_and(|phase| phase == "preparing" || phase == "prepared"),
        _ => false,
    }
}

impl Trace {
    fn create(store: &LockedStore, id: EntryId) -> Result<Self, RepositoryError> {
        store.remove_traces()?;
        let dir = store.new_trace_dir(id)?;
        Ok(Self {
            events: dir.join("trace2.json"),
            refs: dir.join("refs.txt"),
            dir,
        })
    }

    /// Git processes that hooks start trace their updates to the same file.
    /// Git traces its own once it has moved the branch, before `post-commit`
    /// and the `committed` `reference-transaction` hook run, so a later update
    /// to the same commit is a hook's.
    fn update(&self, target: &Target, made: &Oid) -> Option<Update> {
        let file = fs::File::open(&self.refs).ok()?;
        io::BufReader::new(file)
            .split(b'\n')
            .map_while(Result::ok)
            .filter_map(|line| update_in(&String::from_utf8_lossy(&line), target.reference()))
            .find(|update| update.new == *made)
    }

    fn failed_hook(&self) -> Option<String> {
        let text = fs::read_to_string(&self.events).ok()?;
        let mut hooks = HashMap::new();
        for line in text.lines() {
            let Ok(event) = serde_json::from_str::<Event>(line) else {
                continue;
            };
            if event.sid.contains('/') {
                continue;
            }
            match (event.event.as_str(), event.child_id) {
                ("child_start", Some(id)) if event.child_class.as_deref() == Some("hook") => {
                    if let Some(name) = event.hook_name {
                        hooks.insert(id, (name, event.argv));
                    }
                }
                ("child_exit", Some(id)) if event.code.is_some_and(|code| code != 0) => {
                    if let Some((name, argv)) = hooks.get(&id)
                        && stops_commit(name, argv)
                    {
                        return Some(name.clone());
                    }
                }
                _ => {}
            }
        }
        None
    }
}

impl Drop for Trace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_reference_transaction_only_while_preparing() {
        let argv = |phase: &str| vec!["hook".to_owned(), phase.to_owned()];
        assert!(stops_commit("pre-commit", &[]));
        assert!(stops_commit("reference-transaction", &argv("prepared")));
        assert!(!stops_commit("reference-transaction", &argv("aborted")));
        assert!(!stops_commit("post-commit", &[]));
    }

    #[test]
    fn reads_a_finished_update_from_gits_ref_trace() {
        let old = "f0a33e14bc0706ae47638de725ced1a228a023cf";
        let new = "723013ba8605cd967f18b0301e6cd17c6f9fdd34";
        let update = |old: &str| Update {
            old: Oid::try_from(old.to_owned()).ok(),
            new: Oid::try_from(new.to_owned()).unwrap(),
        };
        let line = |name: &str, from: &str| {
            format!(
                "12:44:19.503683 refs/debug.c:88         1: {name} {from} -> {new} (F=0xc, T=0x0) \"commit: a -> b\""
            )
        };
        assert_eq!(
            update_in(&line("refs/heads/main", old), "refs/heads/main"),
            Some(update(old))
        );
        assert_eq!(update_in(&line("refs/heads/main", old), "HEAD"), None);
        assert_eq!(
            update_in(&line("refs/heads/main", &"0".repeat(40)), "refs/heads/main"),
            Some(update("none"))
        );
        let reflog = format!(
            "12:44:19.508030 refs/debug.c:306        reflog_ent HEAD (ret 0): {old} -> {new}, T <t@x> 1793015059 \"commit: c3\""
        );
        assert_eq!(update_in(&reflog, "HEAD"), None);
    }
}
