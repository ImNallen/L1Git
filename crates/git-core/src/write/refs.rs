use super::{
    Direction, RefTxn, Repo,
    store::{EntryObjects, Objects},
    txn::Runner,
};
use crate::{
    ErrorKind, Head, Oid, RepositoryError, StaleReason,
    git::{self, WriteDeadline},
    stderr, sync,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RefChange {
    before: Head,
    after: Head,
    replaced: Option<Oid>,
}

impl RefChange {
    pub(super) fn new(
        before: Head,
        after: Head,
        replaced: Option<Oid>,
    ) -> Result<Self, RepositoryError> {
        let change = Self {
            before,
            after,
            replaced,
        };
        Move::between(&change.before, &change.after)?;
        Ok(change)
    }

    pub(super) fn objects(&self) -> Objects {
        Objects {
            tips: self.replaced.iter().cloned().collect(),
            not: oid(&self.after).into_iter().collect(),
        }
    }
}

pub(super) struct Move {
    pub(super) name: String,
    pub(super) old: Option<Oid>,
    pub(super) new: Option<Oid>,
}

impl Move {
    fn between(from: &Head, to: &Head) -> Result<Self, RepositoryError> {
        let name = match (from, to) {
            (
                Head::Attached { reference, .. } | Head::Unborn { reference },
                Head::Attached {
                    reference: other, ..
                }
                | Head::Unborn { reference: other },
            ) if reference == other => reference.clone(),
            (Head::Detached { .. }, Head::Detached { .. }) => "HEAD".to_owned(),
            _ => return Err(git::malformed()),
        };
        Ok(Self {
            name,
            old: oid(from),
            new: oid(to),
        })
    }

    fn line(&self) -> String {
        let option = if self.name == "HEAD" {
            "option no-deref\n"
        } else {
            ""
        };
        let name = &self.name;
        let command = match (&self.old, &self.new) {
            (Some(old), Some(new)) if old == new => format!("verify {name} {}", old.as_str()),
            (Some(old), Some(new)) => format!("update {name} {} {}", new.as_str(), old.as_str()),
            (None, Some(new)) => format!("create {name} {}", new.as_str()),
            (Some(old), None) => format!("delete {name} {}", old.as_str()),
            (None, None) => return String::new(),
        };
        format!("{option}{command}\n")
    }
}

pub(super) fn oid(head: &Head) -> Option<Oid> {
    match head {
        Head::Attached { oid, .. } | Head::Detached { oid } => Oid::try_from(oid.clone()).ok(),
        Head::Unborn { .. } => None,
    }
}

pub(super) fn transact(
    txn: &RefTxn,
    moves: &[Move],
    reflog: &str,
    noun: &str,
) -> Result<(), RepositoryError> {
    let mut input = String::from("start\n");
    for change in moves {
        input.push_str(&change.line());
    }
    input.push_str("prepare\ncommit\n");
    let wrote = txn
        .update_refs(reflog, input.into_bytes())
        .run(txn.runner().deadline())?;
    if wrote.code() == Some(0) {
        return Ok(());
    }
    let said = wrote.stderr();
    if said.contains(stderr::LOCK_HELD) {
        return Err(RepositoryError::new(
            ErrorKind::LockHeld,
            format!(
                "Another Git process is changing a {noun}, so nothing changed. Wait for it to finish, then try again. Git said: {}",
                stderr::summarize(said)
            ),
        ));
    }
    let moved = [
        "but expected",
        "reference already exists",
        "unable to resolve reference",
    ];
    if moved.iter().any(|text| said.contains(text)) {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            format!(
                "A {noun} moved since L1 Git read it, so nothing changed. Refresh and try again."
            ),
        ));
    }
    Err(RepositoryError::new(
        ErrorKind::GitFailed,
        format!(
            "Git did not move the {noun}, so nothing changed. Git said: {}",
            stderr::summarize(said)
        ),
    ))
}

pub(super) fn restore(
    repo: &Repo,
    entry: &EntryObjects,
    change: &RefChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let (from, to) = match direction {
        Direction::Undo => (&change.after, &change.before),
        Direction::Redo => (&change.before, &change.after),
    };
    if let Some(operation) = sync::in_progress(&repo.root, deadline.reads())?
        .into_iter()
        .find(|operation| operation.holds_commits())
    {
        return Err(RepositoryError::new(
            ErrorKind::Conflict,
            format!(
                "{} is in progress in this worktree, and moving its branch now would change what it finishes with. Finish or abort it with Git, then try again.",
                capitalized(operation.name())
            ),
        ));
    }
    let head = repo.head(deadline)?;
    if head == *to {
        return Ok(());
    }
    if head != *from {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved after this commit, so L1 Git cannot undo or redo it exactly. Refresh.",
        ));
    }
    let step = Move::between(from, to)?;
    let stranded = Objects {
        tips: step.old.iter().cloned().collect(),
        not: step.new.iter().cloned().collect(),
    };
    let txn = RefTxn::begin(repo, deadline)?;
    entry.keep(txn.runner(), &stranded)?;
    entry.bring_back(
        txn.runner(),
        &Objects {
            tips: stranded.not.clone(),
            not: stranded.tips.clone(),
        },
    )?;
    let reflog = match direction {
        Direction::Undo => "l1git undo",
        Direction::Redo => "l1git redo",
    };
    transact(&txn, &[step], reflog, "branch")
}

pub(super) fn capitalized(text: &str) -> String {
    let mut characters = text.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}
