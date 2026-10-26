use super::{
    Applied, Change, Direction, RefTxn, Repo,
    branches::{self, Writing},
    commit,
    refs::{self, Move},
    store::EntryObjects,
    txn::Runner,
};
use crate::{
    ErrorKind, Oid, RepositoryError, StaleReason, TagRef,
    git::{self, Deadline, WriteDeadline},
    stderr,
};
use serde::{Deserialize, Serialize};

/// A tag and what its ref held when the user saw it: the commit for a
/// lightweight tag, or the tag object for an annotated one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TagTip {
    pub reference: TagRef,
    pub oid: Oid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum TagChange {
    Pending { tag: TagRef, before: Option<Oid> },
    Created { tag: TagRef, oid: Oid },
    Deleted { tag: TagRef, oid: Oid },
}

impl TagChange {
    fn between(tag: &TagRef, before: Option<&Oid>, after: Option<Oid>) -> Option<Self> {
        match (before, after) {
            (None, Some(oid)) => Some(Self::Created {
                tag: tag.clone(),
                oid,
            }),
            (Some(oid), None) => Some(Self::Deleted {
                tag: tag.clone(),
                oid: oid.clone(),
            }),
            (None, None) | (Some(_), Some(_)) => None,
        }
    }
}

struct Listed {
    reference: String,
    oid: Oid,
    symref: String,
}

fn listed(repo: &Repo, pattern: &str, reads: Deadline) -> Result<Vec<Listed>, RepositoryError> {
    git::read(
        &repo.root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            pattern,
        ],
        reads,
    )?
    .split(|byte| *byte == b'\n')
    .filter(|row| !row.is_empty())
    .map(
        |row| match row.split(|byte| *byte == 0).collect::<Vec<_>>()[..] {
            [reference, oid, symref] => Ok(Listed {
                reference: git::text(reference),
                oid: Oid::try_from(git::text(oid)).map_err(|_| git::malformed())?,
                symref: git::text(symref),
            }),
            _ => Err(git::malformed()),
        },
    )
    .collect()
}

fn held(repo: &Repo, tag: &TagRef, reads: Deadline) -> Result<Option<Oid>, RepositoryError> {
    let Some(found) = listed(repo, tag.as_str(), reads)?
        .into_iter()
        .find(|listed| listed.reference == tag.as_str())
    else {
        return Ok(None);
    };
    if !found.symref.is_empty() {
        return Err(RepositoryError::new(
            ErrorKind::InvalidRef,
            format!(
                "{} points at {}. L1 Git does not change symbolic tags.",
                tag.name(),
                found.symref
            ),
        ));
    }
    Ok(Some(found.oid))
}

fn new_name(repo: &Repo, name: &str, reads: Deadline) -> Result<TagRef, RepositoryError> {
    let invalid = || {
        RepositoryError::new(
            ErrorKind::InvalidRef,
            format!("'{name}' is not a valid tag name."),
        )
    };
    // `git tag` refuses a leading `-` and `HEAD`, though `check-ref-format` allows them.
    if name.contains('\0') || name.starts_with('-') || name == "HEAD" {
        return Err(invalid());
    }
    let reference = format!("refs/tags/{name}");
    if !git::run(&repo.root, &["check-ref-format", &reference], reads)?
        .status
        .success()
    {
        return Err(invalid());
    }
    TagRef::try_from(reference).map_err(|_| invalid())
}

fn moved(name: &str) -> RepositoryError {
    RepositoryError::stale(
        StaleReason::TagChanged,
        format!(
            "{name} no longer points where L1 Git showed, so nothing changed. Refresh and try again."
        ),
    )
}

fn as_tag_changed(error: RepositoryError) -> RepositoryError {
    if matches!(error.kind, ErrorKind::StaleView { .. }) {
        RepositoryError::stale(StaleReason::TagChanged, error.message)
    } else {
        error
    }
}

pub(super) fn create(
    writing: &Writing<'_>,
    name: &str,
    at: &Oid,
    message: Option<&str>,
) -> Result<Applied, RepositoryError> {
    let repo = writing.repo;
    let reads = writing.deadline.reads();
    let tag = new_name(repo, name, reads)?;
    let tags = listed(repo, "refs/tags/", reads)?;
    branches::refuse_clash(
        "tag",
        tags.iter()
            .filter_map(|listed| listed.reference.strip_prefix("refs/tags/")),
        tag.name(),
        None,
        branches::folds_case(&branches::config(repo, &["--local"], reads)?),
    )?;
    if message.is_none() && git::config_flag(&repo.root, "tag.gpgSign", false, reads)? {
        return Err(RepositoryError::new(
            ErrorKind::InvalidRef,
            "tag.gpgSign is on, so Git signs every tag, and a signed tag needs a message. Add a message, or turn tag.gpgSign off.",
        ));
    }
    record_around(writing, &tag, None, |txn| match message {
        None => {
            let create = Move {
                name: tag.as_str().to_owned(),
                old: None,
                new: Some(at.clone()),
            };
            refs::transact(txn, &[create], "tag: Created by L1 Git", "tag").map_err(as_tag_changed)
        }
        Some(message) => annotate(txn, &tag, at, message),
    })
}

fn annotate(
    txn: &RefTxn<'_>,
    tag: &TagRef,
    at: &Oid,
    message: &str,
) -> Result<(), RepositoryError> {
    let wrote = txn
        .tag(&["-a", "-F", "-", "--", tag.name(), at.as_str()], message)
        .run(txn.runner().deadline())?;
    if wrote.code() == Some(0) {
        return Ok(());
    }
    let said = wrote.stderr();
    if let Some(missing) = commit::missing_identity(said, said, "it made no tag") {
        return Err(missing);
    }
    if said.contains(stderr::LOCK_HELD) {
        return Err(RepositoryError::new(
            ErrorKind::LockHeld,
            format!(
                "Another Git process is changing a tag, so nothing changed. Wait for it to finish, then try again. Git said: {}",
                stderr::summarize(said)
            ),
        ));
    }
    if said.contains("already exists") {
        return Err(RepositoryError::stale(
            StaleReason::TagChanged,
            format!(
                "A tag named '{}' appeared since L1 Git read the tags, so nothing changed. Refresh and try again.",
                tag.name()
            ),
        ));
    }
    Err(RepositoryError::new(
        ErrorKind::GitFailed,
        format!(
            "Git could not create the tag. Git said: {}",
            stderr::summarize(said)
        ),
    ))
}

pub(super) fn delete(writing: &Writing<'_>, tip: &TagTip) -> Result<Applied, RepositoryError> {
    let tag = &tip.reference;
    if held(writing.repo, tag, writing.deadline.reads())?.as_ref() != Some(&tip.oid) {
        return Err(moved(tag.name()));
    }
    record_around(writing, tag, Some(&tip.oid), |txn| {
        remove(txn, tag, &tip.oid, "tag: Deleted by L1 Git")
    })
}

fn remove(txn: &RefTxn<'_>, tag: &TagRef, oid: &Oid, reflog: &str) -> Result<(), RepositoryError> {
    let delete = Move {
        name: tag.as_str().to_owned(),
        old: Some(oid.clone()),
        new: None,
    };
    refs::transact(txn, &[delete], reflog, "tag").map_err(as_tag_changed)
}

fn record_around(
    writing: &Writing<'_>,
    tag: &TagRef,
    before: Option<&Oid>,
    act: impl FnOnce(&RefTxn<'_>) -> Result<(), RepositoryError>,
) -> Result<Applied, RepositoryError> {
    let txn = RefTxn::begin(writing.repo, writing.deadline)?;
    let (applied, _, recorded) =
        writing
            .store
            .record_with(writing.repo, writing.log, writing.operation, |entry| {
                if let Some(oid) = before {
                    entry.keep_tag(txn.runner(), oid, tag.name())?;
                }
                Ok(TagChange::Pending {
                    tag: tag.clone(),
                    before: before.cloned(),
                })
            })?;
    let acted = act(&txn);
    let after = match held(writing.repo, tag, writing.deadline.renewed().reads()) {
        Ok(after) => after,
        Err(error) => {
            recorded.stay_pending();
            return Err(acted.err().unwrap_or(error));
        }
    };
    if after.as_ref() == before {
        return Err(acted.err().unwrap_or_else(|| {
            RepositoryError::new(ErrorKind::UnchangedPath, "Git changed nothing.")
        }));
    }
    let Some(change) = TagChange::between(tag, before, after) else {
        return Err(RepositoryError::stale(
            StaleReason::TagChanged,
            format!(
                "{} changed in a way L1 Git cannot undo, so this change has no Undo. Refresh to see the tags.",
                tag.name()
            ),
        ));
    };
    match recorded.replace(&Change::Tag(change)) {
        Ok(()) => recorded.confirm(),
        Err(_) => recorded.stay_pending(),
    }
    acted.map(|()| applied)
}

pub(super) fn step(
    repo: &Repo,
    entry: &EntryObjects,
    change: &TagChange,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let (tag, from, to) = match (change, direction) {
        (TagChange::Created { tag, oid }, Direction::Redo)
        | (TagChange::Deleted { tag, oid }, Direction::Undo) => (tag, None, Some(oid)),
        (TagChange::Created { tag, oid }, Direction::Undo)
        | (TagChange::Deleted { tag, oid }, Direction::Redo) => (tag, Some(oid), None),
        (TagChange::Pending { .. }, _) => return Err(git::malformed()),
    };
    let now = held(repo, tag, deadline.reads())?;
    let already = now.as_ref() == to;
    if already && to.is_some() {
        return Ok(());
    }
    if !already && now.as_ref() != from {
        let step = match direction {
            Direction::Undo => "undo",
            Direction::Redo => "redo",
        };
        return Err(RepositoryError::stale(
            StaleReason::TagChanged,
            format!(
                "{} changed after this change, so L1 Git cannot {step} it exactly. Refresh.",
                tag.name()
            ),
        ));
    }
    let reflog = match direction {
        Direction::Undo => "l1git undo",
        Direction::Redo => "l1git redo",
    };
    let txn = RefTxn::begin(repo, deadline)?;
    match (from, to) {
        (_, Some(oid)) => {
            entry.bring_back_tip(txn.runner(), oid, "tag")?;
            let create = Move {
                name: tag.as_str().to_owned(),
                old: None,
                new: Some(oid.clone()),
            };
            refs::transact(&txn, &[create], reflog, "tag").map_err(as_tag_changed)
        }
        (Some(oid), None) => {
            entry.keep_tag(txn.runner(), oid, tag.name())?;
            if already {
                return Ok(());
            }
            remove(&txn, tag, oid, reflog)
        }
        (None, None) => Err(git::malformed()),
    }
}

pub(super) fn landed(
    repo: &Repo,
    change: &TagChange,
    deadline: WriteDeadline,
) -> Result<Option<TagChange>, RepositoryError> {
    match change {
        TagChange::Pending { tag, before } => Ok(TagChange::between(
            tag,
            before.as_ref(),
            held(repo, tag, deadline.reads())?,
        )),
        TagChange::Created { .. } | TagChange::Deleted { .. } => Ok(Some(change.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Coordinator, Expect, Limits, Operation, git::LocalWrite, repository};
    use std::{fs, path::Path, process::Command};

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
    fn a_delete_stopped_after_git_keeps_its_entry_and_the_tag_object() {
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
        git(&root, &["tag", "-a", "-m", "Release", "v1"]);
        let shown = git(&root, &["cat-file", "-p", "v1"]);
        let tip = TagTip {
            reference: TagRef::try_from("refs/tags/v1".to_owned()).unwrap(),
            oid: Oid::try_from(git(&root, &["rev-parse", "refs/tags/v1"])).unwrap(),
        };
        let operation = Operation::DeleteTag { tag: tip.clone() };
        let path = root.to_str().unwrap();
        let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));

        coordinator
            .locked(path, LocalWrite::DeleteTag, |repo, store, log, deadline| {
                let txn = RefTxn::begin(&repo, deadline)?;
                let (_, _, recorded) = store.record_with(&repo, &log, &operation, |entry| {
                    entry.keep_tag(txn.runner(), &tip.oid, "v1")?;
                    Ok(TagChange::Pending {
                        tag: tip.reference.clone(),
                        before: Some(tip.oid.clone()),
                    })
                })?;
                remove(&txn, &tip.reference, &tip.oid, "test")?;
                std::mem::forget(recorded);
                Ok(())
            })
            .unwrap();
        git(&root, &["gc", "--quiet", "--prune=now"]);

        let history = coordinator.undo_history(path).unwrap();
        assert_eq!(history.undo, None, "the stopped write is still pending");
        let head = repository::head(&root, Deadline::of(git::LocalRead::Refs)).unwrap();
        let made = coordinator
            .write(
                path,
                &Operation::CreateTag {
                    name: "later".to_owned(),
                    at: Oid::try_from(git(&root, &["rev-parse", "HEAD"])).unwrap(),
                    message: None,
                },
                &Expect { head },
            )
            .unwrap();
        coordinator.undo(path, made.id).unwrap();
        let kept = coordinator.undo_history(path).unwrap().undo.unwrap();
        assert_eq!(kept.operation, operation);
        coordinator.undo(path, kept.id).unwrap();
        assert_eq!(git(&root, &["cat-file", "-p", "v1"]), shown);
    }
}
