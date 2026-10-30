use super::{
    Applied, Change, Direction, EntryId, Expect, Repo, Restored,
    branches::Writing,
    checkout,
    discard::refresh,
    files::{self, FileChange, STASH, STASH_WORDS},
    index::{self, IndexChange, Rows},
    store::{self, EntryObjects, LockedStore, Objects, Step},
    txn::{Published, RefTxn, Runner, Txn},
};
use crate::{
    ErrorKind, Head, Mode, MoveSide, Oid, RepositoryError, Sides, StaleReason, StatusEntry,
    git::{self, Deadline, WriteDeadline, Wrote},
    status::{self, Untracked},
    stderr,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StashTip {
    pub name: String,
    pub oid: Oid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(super) enum StashChange {
    Pending {
        before: Snapshot,
    },
    Settled {
        list: Presence,
        files: Vec<FileChange>,
        index: IndexChange,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Presence {
    Added(Listed),
    Removed(Listed),
    Kept(Listed),
    Dropped(Listed),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Listed {
    oid: Oid,
    subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    head: Head,
    list: Vec<Listed>,
    captured: Vec<Captured>,
    candidates: Vec<String>,
    intent: Intent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Captured {
    path: String,
    before: files::Content,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Intent {
    Push { head: Oid },
    Apply { listed: Listed },
    Pop { listed: Listed },
    Drop { listed: Listed },
}

struct Now {
    head: Head,
    list: Vec<Listed>,
    rows: Rows,
    raw_index: Vec<u8>,
    status: Vec<StatusEntry>,
}

struct Candidates {
    names: Vec<String>,
    files: Vec<String>,
}

struct Parents {
    base: Oid,
    index: Oid,
    untracked: Option<Oid>,
    index_part: bool,
}

struct Blob {
    mode: Mode,
    oid: Oid,
}

enum Verdict {
    Leave(RepositoryError),
    Keep {
        presence: Presence,
        trouble: Option<RepositoryError>,
    },
}

enum ListMove {
    Add,
    Remove,
    Require,
}

enum RemoveResult {
    Dropped,
    Missing,
}

impl StashChange {
    pub(super) fn objects(&self) -> Vec<Oid> {
        match self {
            Self::Pending { .. } => Vec::new(),
            Self::Settled { index, .. } => index.objects(),
        }
    }

    pub(super) const fn repository_wide(&self) -> bool {
        match self {
            Self::Pending { before } => matches!(before.intent, Intent::Drop { .. }),
            Self::Settled {
                list: Presence::Dropped(_),
                ..
            } => true,
            Self::Settled {
                list: Presence::Added(_) | Presence::Removed(_) | Presence::Kept(_),
                ..
            } => false,
        }
    }

    pub(super) fn touches_skip_worktree(&self) -> bool {
        match self {
            Self::Pending { .. } => false,
            Self::Settled { index, .. } => index.touches_skip_worktree(),
        }
    }
}

impl Presence {
    fn listed(&self) -> &Listed {
        match self {
            Self::Added(listed)
            | Self::Removed(listed)
            | Self::Kept(listed)
            | Self::Dropped(listed) => listed,
        }
    }
}

pub(super) fn push(
    writing: &Writing<'_>,
    expect: &Expect,
    message: &str,
    untracked: bool,
    paths: &[String],
) -> Result<(Applied, Option<Published>), RepositoryError> {
    let repo = writing.repo;
    let deadline = writing.deadline;
    checkout::refuse_unfinished(repo, "stash", deadline.reads())?;
    let head = repo.head_as_seen(expect, deadline)?;
    let head_oid = born(&head)?;
    let full = observe(repo, deadline)?;
    refuse_utf8(&full.rows)?;
    let requested = requested(paths)?;
    let candidates = push_candidates(repo, &full, requested.as_ref(), untracked)?;
    refuse_unmerged(&full.status)?;
    refuse_intent(&full.rows, requested.as_ref())?;
    refuse_assume_unchanged(repo, &full.rows, requested.as_ref(), deadline)?;
    if candidates.files.is_empty() {
        return Err(nothing_to_save());
    }
    let spec = literal_pathspecs(&candidates.files);
    let snapshot = Snapshot {
        head,
        list: full.list.clone(),
        captured: Vec::new(),
        candidates: candidates.names,
        intent: Intent::Push { head: head_oid },
    };
    record_and_finish(
        writing,
        snapshot,
        &full,
        &candidates.files,
        false,
        |txn| run_push(txn, message, untracked, &spec),
        |files, before, now, code, said| judge_push(repo, files, before, now, code, said, deadline),
    )
}

pub(super) fn apply(
    writing: &Writing<'_>,
    expect: &Expect,
    tip: &StashTip,
    pop: bool,
) -> Result<(Applied, Option<Published>), RepositoryError> {
    let repo = writing.repo;
    let deadline = writing.deadline;
    let doing = if pop {
        "pop the stash"
    } else {
        "apply the stash"
    };
    checkout::refuse_unfinished(repo, doing, deadline.reads())?;
    let head = repo.head_as_seen(expect, deadline)?;
    let _ = born(&head)?;
    let listed = require_tip(repo, tip, deadline)?;
    let full = observe(repo, deadline)?;
    refuse_utf8(&full.rows)?;
    refuse_unmerged(&full.status)?;
    refuse_intent(&full.rows, None)?;
    let parents = parents_of(repo, &listed.oid, deadline.reads())?;
    let candidates =
        apply_candidates_of(repo, &listed.oid, &parents, &full.rows, deadline.reads())?;
    if parents.index_part
        && let Some(path) = staged_outside(&full.status, &candidates.names)
    {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            format!(
                "This stash has staged changes, and {path} is also staged. Apply would unstage it. Commit or unstage {path}, then apply the stash."
            ),
        ));
    }
    let snapshot = Snapshot {
        head,
        list: full.list.clone(),
        captured: Vec::new(),
        candidates: candidates.names,
        intent: if pop {
            Intent::Pop {
                listed: listed.clone(),
            }
        } else {
            Intent::Apply { listed }
        },
    };
    let oid = snapshot_oid(&snapshot);
    record_and_finish(
        writing,
        snapshot,
        &full,
        &candidates.files,
        true,
        |txn| {
            txn.stash(&["apply", "-q", "--index", oid.as_str()])
                .lazy_fetch_unprompted()
                .run(txn.runner().deadline())
        },
        |files, before, now, code, said| {
            judge_apply(repo, files, before, now, code, said, deadline)
        },
    )
}

pub(super) fn drop_stash(
    writing: &Writing<'_>,
    tip: &StashTip,
) -> Result<Applied, RepositoryError> {
    let repo = writing.repo;
    let deadline = writing.deadline;
    let listed = require_tip(repo, tip, deadline)?;
    let full = observe(repo, deadline)?;
    let txn = RefTxn::begin(repo, deadline)?;
    let (applied, pending, recorded) =
        writing
            .store
            .record_with(repo, writing.log, writing.operation, |entry| {
                entry.keep_stash(txn.runner(), &listed.oid)?;
                Ok(StashChange::Pending {
                    before: Snapshot {
                        head: full.head.clone(),
                        list: full.list.clone(),
                        captured: Vec::new(),
                        candidates: Vec::new(),
                        intent: Intent::Drop {
                            listed: listed.clone(),
                        },
                    },
                })
            })?;
    let StashChange::Pending { before } = pending else {
        return Err(git::malformed());
    };
    match remove_at(&txn, &listed) {
        Ok(RemoveResult::Dropped) => {}
        Ok(RemoveResult::Missing) => return Err(stash_moved(&tip.name)),
        Err(error) => return Err(error),
    }
    let change = StashChange::Settled {
        list: Presence::Dropped(listed),
        files: Vec::new(),
        index: IndexChange::empty(before.head),
    };
    confirm(writing.store, txn.runner(), applied.id, recorded, change)?;
    Ok(applied)
}

fn snapshot_oid(snapshot: &Snapshot) -> String {
    match &snapshot.intent {
        Intent::Apply { listed } | Intent::Pop { listed } | Intent::Drop { listed } => {
            listed.oid.as_str().to_owned()
        }
        Intent::Push { head } => head.as_str().to_owned(),
    }
}

fn record_and_finish(
    writing: &Writing<'_>,
    snapshot: Snapshot,
    full: &Now,
    file_paths: &[String],
    all_blobs: bool,
    run: impl FnOnce(&RefTxn<'_>) -> Result<Wrote, RepositoryError>,
    judge: impl FnOnce(&Path, &Snapshot, &Now, Option<i32>, &str) -> Result<Verdict, RepositoryError>,
) -> Result<(Applied, Option<Published>), RepositoryError> {
    let repo = writing.repo;
    let store = writing.store;
    let log = writing.log;
    let deadline = writing.deadline;
    let operation = writing.operation;
    let txn = RefTxn::begin(repo, deadline)?;
    let (applied, pending, recorded) = store.record_with(repo, log, operation, |entry| {
        let files = entry.files();
        store::private_folder()
            .create(&files)
            .map_err(|error| files::failed("the undo history", &error))?;
        fs::write(files.join(INDEX_BEFORE), &full.raw_index)
            .map_err(|error| files::failed("the undo history", &error))?;
        let status = serde_json::to_vec(&full.status).map_err(|_| git::malformed())?;
        fs::write(files.join(STATUS_BEFORE), status)
            .map_err(|error| files::failed("the undo history", &error))?;
        let captured = file_paths
            .iter()
            .enumerate()
            .map(|(at, path)| {
                Ok(Captured {
                    path: path.clone(),
                    before: files::capture(&repo.root, path, &files, format!("{at}.before"))?,
                })
            })
            .collect::<Result<Vec<_>, RepositoryError>>()?;
        let blobs = if all_blobs {
            index::stored_blobs(&full.rows)
        } else {
            index::stored_blobs_of(&full.rows, &snapshot.candidates)
        };
        entry.keep(txn.runner(), &Objects::exact(blobs))?;
        Ok(StashChange::Pending {
            before: Snapshot {
                captured,
                ..snapshot.clone()
            },
        })
    })?;
    let StashChange::Pending { before } = pending else {
        return Err(git::malformed());
    };
    let txn = txn.renewed()?;
    let ran = match run(&txn) {
        Ok(wrote) => wrote,
        Err(error) => {
            recorded.stay_pending();
            return Err(error);
        }
    };
    let said = ran.stderr().to_owned();
    let code = ran.code();
    let now = match observe(repo, deadline.renewed()) {
        Ok(now) => now,
        Err(error) => {
            recorded.stay_pending();
            return Err(error);
        }
    };
    let files = store.entry(applied.id).files();
    let verdict = match judge(&files, &before, &now, code, &said) {
        Ok(verdict) => verdict,
        Err(error) => {
            recorded.stay_pending();
            return Err(error);
        }
    };
    let (presence, trouble) = match verdict {
        Verdict::Leave(error) => return Err(error),
        Verdict::Keep { presence, trouble } => (presence, trouble),
    };
    let (presence, trouble) = match (&before.intent, code, trouble) {
        (Intent::Pop { listed }, Some(0), None) => {
            if let Err(error) = store
                .entry(applied.id)
                .keep_stash(txn.runner(), &listed.oid)
            {
                recorded.stay_pending();
                return Err(error);
            }
            match finish_drop(&txn, listed) {
                Ok(()) => (Presence::Removed(listed.clone()), None),
                Err(error) if error.kind == ErrorKind::Raced || is_stash_changed(&error) => {
                    (Presence::Kept(listed.clone()), Some(error))
                }
                Err(error) => {
                    recorded.stay_pending();
                    return Err(error);
                }
            }
        }
        (_, _, trouble) => (presence, trouble),
    };
    let change = match build_settled(repo, &files, &before, &now, presence) {
        Ok(change) => change,
        Err(error) => {
            recorded.stay_pending();
            return Err(error);
        }
    };
    confirm(store, txn.runner(), applied.id, recorded, change)?;
    match trouble {
        Some(error) => Err(error),
        None => Ok((applied, None)),
    }
}

fn finish_drop(txn: &RefTxn<'_>, listed: &Listed) -> Result<(), RepositoryError> {
    match remove_at(txn, listed)? {
        RemoveResult::Dropped => Ok(()),
        RemoveResult::Missing => Err(RepositoryError::stale(
            StaleReason::StashChanged,
            "Git applied the stash, but the stash list changed, so L1 Git kept the entry.",
        )),
    }
}

fn is_stash_changed(error: &RepositoryError) -> bool {
    matches!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::StashChanged,
        }
    )
}

fn confirm(
    store: &LockedStore,
    runner: &impl super::txn::Runner,
    id: EntryId,
    recorded: store::Recorded<'_>,
    change: StashChange,
) -> Result<(), RepositoryError> {
    let wire = Change::Stash(change);
    if let Err(error) = store.entry(id).keep(runner, &wire.objects()) {
        recorded.stay_pending();
        return Err(error);
    }
    if let Err(error) = recorded.replace(&wire) {
        recorded.stay_pending();
        return Err(store::unwritable(error));
    }
    recorded.confirm();
    Ok(())
}

fn judge_push(
    repo: &Repo,
    files: &Path,
    before: &Snapshot,
    now: &Now,
    code: Option<i32>,
    said: &str,
    deadline: WriteDeadline,
) -> Result<Verdict, RepositoryError> {
    let Intent::Push { head } = &before.intent else {
        return Err(git::malformed());
    };
    if now.head != before.head {
        return Ok(Verdict::Leave(raced(
            "Another process moved HEAD while Git stashed, so L1 Git has no undo entry for it. Refresh.",
        )));
    }
    let before_rows = load_rows(files)?;
    let index_diff = diff_paths(&before.head, &before_rows, &now.rows)?;
    let status_diff = status_changes(&load_status(files)?, &now.status);
    let allowed: BTreeSet<&str> = before.candidates.iter().map(String::as_str).collect();
    if index_diff
        .iter()
        .any(|path| !allowed.contains(path.as_str()))
        || status_diff
            .iter()
            .any(|path| !allowed.contains(path.as_str()))
    {
        return Ok(Verdict::Leave(raced(
            "Git changed a path this stash does not cover, so L1 Git kept no undo entry. Refresh.",
        )));
    }
    let files_changed = any_file_changed(&repo.root, files, &before.captured)?;
    match added_entry(&before.list, &now.list) {
        Some(added) => {
            let parent = first_parent(&repo.root, &added.oid, deadline.reads())?;
            if &parent != head {
                return Ok(Verdict::Leave(raced(
                    "Git stored a stash that is not based on HEAD, so L1 Git kept no undo entry. Refresh.",
                )));
            }
            let trouble = match code {
                Some(0) | None => None,
                Some(_) => Some(partial("stashing", said)),
            };
            Ok(Verdict::Keep {
                presence: Presence::Added(added.clone()),
                trouble,
            })
        }
        None if !files_changed && index_diff.is_empty() && now.list == before.list => {
            Ok(Verdict::Leave(if code == Some(0) || code.is_none() {
                nothing_to_save()
            } else {
                git_said("Git could not stash.", said)
            }))
        }
        None => Ok(Verdict::Leave(raced(
            "The stash list changed in a way L1 Git cannot undo, so this change has no Undo. Refresh.",
        ))),
    }
}

fn judge_apply(
    repo: &Repo,
    files: &Path,
    before: &Snapshot,
    now: &Now,
    code: Option<i32>,
    said: &str,
    deadline: WriteDeadline,
) -> Result<Verdict, RepositoryError> {
    let listed = match &before.intent {
        Intent::Apply { listed } | Intent::Pop { listed } => listed,
        Intent::Push { .. } | Intent::Drop { .. } => return Err(git::malformed()),
    };
    let pop = matches!(before.intent, Intent::Pop { .. });
    if now.head != before.head {
        return Ok(Verdict::Leave(raced(
            "Another process moved HEAD while Git applied the stash, so L1 Git has no undo entry for it. Refresh.",
        )));
    }
    let before_rows = load_rows(files)?;
    let index_diff = diff_paths(&before.head, &before_rows, &now.rows)?;
    let status_diff = status_changes(&load_status(files)?, &now.status);
    let allowed: BTreeSet<&str> = before.candidates.iter().map(String::as_str).collect();
    if let Some(path) = outside_write(
        repo,
        &before_rows,
        &now.rows,
        &allowed,
        &status_diff,
        &index_diff,
        deadline.reads(),
    )? {
        return Ok(Verdict::Leave(raced(format!(
            "Git wrote {path}, which this stash does not cover, so L1 Git kept no undo entry. Refresh."
        ))));
    }
    let files_changed = any_file_changed(&repo.root, files, &before.captured)?;
    if !files_changed && index_diff.is_empty() {
        if pop && code == Some(0) {
            return Ok(Verdict::Keep {
                presence: Presence::Kept(listed.clone()),
                trouble: None,
            });
        }
        return Ok(Verdict::Leave(if code == Some(0) || code.is_none() {
            RepositoryError::new(ErrorKind::UnchangedPath, "Git changed nothing.")
        } else {
            git_said("Git could not apply the stash.", said)
        }));
    }
    let unmerged = unmerged_paths(&now.status);
    if !unmerged.is_empty() {
        let mut message = format!("{} have conflicts.", join_paths(&unmerged));
        if pop {
            message.push_str(" The stash entry is kept.");
        }
        return Ok(Verdict::Keep {
            presence: Presence::Kept(listed.clone()),
            trouble: Some(RepositoryError::new(ErrorKind::Conflict, message)),
        });
    }
    if matches!(code, Some(0) | None) {
        let presence = if pop && code.is_none() && position(&now.list, &listed.oid).is_none() {
            Presence::Removed(listed.clone())
        } else {
            Presence::Kept(listed.clone())
        };
        return Ok(Verdict::Keep {
            presence,
            trouble: None,
        });
    }
    let mut message = partial("applying the stash", said).message;
    if pop {
        message.push_str(" The stash entry is kept.");
    }
    Ok(Verdict::Keep {
        presence: Presence::Kept(listed.clone()),
        trouble: Some(RepositoryError::new(ErrorKind::GitFailed, message)),
    })
}

fn build_settled(
    repo: &Repo,
    files: &Path,
    before: &Snapshot,
    now: &Now,
    presence: Presence,
) -> Result<StashChange, RepositoryError> {
    let before_rows = load_rows(files)?;
    let changed = changed_files(&repo.root, files, &before.captured)?;
    let index = IndexChange::differing(before.head.clone(), &before_rows, &now.rows)?;
    Ok(StashChange::Settled {
        list: presence,
        files: changed,
        index,
    })
}

pub(super) fn landed(
    repo: &Repo,
    entry: &EntryObjects,
    change: &StashChange,
    deadline: WriteDeadline,
) -> Result<Option<StashChange>, RepositoryError> {
    let StashChange::Pending { before } = change else {
        return Ok(Some(change.clone()));
    };
    if let Intent::Drop { listed } = &before.intent {
        let list = read_list(&repo.root, deadline.reads())?;
        return Ok(position(&list, &listed.oid)
            .is_none()
            .then(|| StashChange::Settled {
                list: Presence::Dropped(listed.clone()),
                files: Vec::new(),
                index: IndexChange::empty(before.head.clone()),
            }));
    }
    let now = observe(repo, deadline)?;
    let files = entry.files();
    let verdict = match &before.intent {
        Intent::Push { .. } => judge_push(repo, &files, before, &now, None, "", deadline)?,
        Intent::Apply { .. } | Intent::Pop { .. } => {
            judge_apply(repo, &files, before, &now, None, "", deadline)?
        }
        Intent::Drop { .. } => return Err(git::malformed()),
    };
    match verdict {
        Verdict::Leave(_) => Ok(None),
        Verdict::Keep { presence, .. } => {
            Ok(Some(build_settled(repo, &files, before, &now, presence)?))
        }
    }
}

pub(super) fn step(
    repo: &Repo,
    store: &LockedStore,
    entry: &EntryObjects,
    change: &StashChange,
    step: Step,
    direction: Direction,
    deadline: WriteDeadline,
) -> Result<Option<Published>, RepositoryError> {
    let StashChange::Settled { list, files, index } = change else {
        return Err(git::malformed());
    };
    let listed = list.listed();
    let action = list_move(list, direction);
    let touches = !files.is_empty() || !index.is_empty();
    if touches {
        checkout::refuse_unfinished(repo, "try again", deadline.reads())?;
    }
    if !matches!(list, Presence::Dropped(_)) && repo.head(deadline)? != index.head() {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved after this change, so L1 Git cannot undo or redo it exactly. Refresh.",
        ));
    }
    let refs = RefTxn::begin(repo, deadline)?;
    let current = read_list(refs.root(), deadline.reads())?;
    match action {
        ListMove::Require => {
            if position(&current, &listed.oid).is_none() {
                return Err(RepositoryError::stale(
                    StaleReason::StashChanged,
                    "The stash entry is no longer in the list, so L1 Git cannot undo or redo this exactly. Refresh.",
                ));
            }
        }
        ListMove::Remove => {
            if position(&current, &listed.oid).is_some() {
                entry.keep_stash(refs.runner(), &listed.oid)?;
            }
        }
        ListMove::Add => {}
    }
    let published = if touches {
        let mut txn = Txn::begin(repo, deadline)?;
        let restored = index::restore(&txn, entry, index, direction)?;
        let rows = index::read(&txn)?;
        let pending =
            files::check_files(&repo.root, &rows, &entry.files(), files, direction, &STASH)?;
        if matches!(action, ListMove::Add) {
            ensure_stored(&refs, entry, listed)?;
        }
        let placing = !pending.is_empty();
        files::place_checked(
            &txn,
            entry.id(),
            &entry.files(),
            &pending,
            direction,
            &STASH_WORDS,
            |_| Ok(()),
        )?;
        if restored == Restored::Staged || placing {
            let mut names: Vec<&str> = files.iter().map(|change| change.path.as_str()).collect();
            names.extend(index.path_names());
            // Stat refresh must see the rows written by the restore, not the rows from before it.
            refresh(&txn, &rows, &names);
            Some(txn.publish_index(&Change::Stash(change.clone()))?)
        } else {
            None
        }
    } else {
        if matches!(action, ListMove::Add) {
            ensure_stored(&refs, entry, listed)?;
        }
        None
    };
    if matches!(action, ListMove::Remove) {
        if matches!(list, Presence::Added(_))
            && direction == Direction::Undo
            && !stash_matches_worktree(repo, listed, deadline)
        {
            let _ = store.save(step.log());
            if let Some(published) = published {
                published.run_hook();
            }
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                "L1 Git put the files back, but kept the stash because it holds bytes the worktree does not.",
            ));
        }
        remove_at(&refs, listed)?;
    }
    let _ = store.save(step.log());
    Ok(published)
}

fn list_move(presence: &Presence, direction: Direction) -> ListMove {
    match (presence, direction) {
        (Presence::Added(_), Direction::Undo) => ListMove::Remove,
        (Presence::Removed(_), Direction::Redo) | (Presence::Dropped(_), Direction::Redo) => {
            ListMove::Remove
        }
        (Presence::Added(_), Direction::Redo) => ListMove::Add,
        (Presence::Removed(_), Direction::Undo) | (Presence::Dropped(_), Direction::Undo) => {
            ListMove::Add
        }
        (Presence::Kept(_), Direction::Undo | Direction::Redo) => ListMove::Require,
    }
}

fn ensure_stored(
    txn: &RefTxn<'_>,
    entry: &EntryObjects,
    listed: &Listed,
) -> Result<(), RepositoryError> {
    let list = read_list(txn.root(), txn.runner().deadline().reads())?;
    if position(&list, &listed.oid).is_some() {
        return Ok(());
    }
    entry.bring_back_tip(txn.runner(), &listed.oid, "stash")?;
    store_at(txn, &listed.subject, &listed.oid)
}

fn remove_at(txn: &RefTxn<'_>, listed: &Listed) -> Result<RemoveResult, RepositoryError> {
    let list = read_list(txn.root(), txn.runner().deadline().reads())?;
    let Some(at) = position(&list, &listed.oid) else {
        return Ok(RemoveResult::Missing);
    };
    let name = format!("stash@{{{at}}}");
    let wrote = txn.stash(&["drop", &name]).run(txn.runner().deadline())?;
    if wrote.code() != Some(0) {
        return Err(git_said("Git could not drop the stash.", wrote.stderr()));
    }
    let printed =
        parse_dropped(&git::text(wrote.stdout())).or_else(|| parse_dropped(wrote.stderr()));
    let Some(printed) = printed else {
        return Err(git::malformed());
    };
    if printed != listed.oid {
        let subject = list
            .iter()
            .find(|item| item.oid == printed)
            .map(|item| item.subject.clone())
            .unwrap_or_default();
        store_at(txn, &subject, &printed)?;
        return Err(raced(
            "Git dropped a different stash entry. L1 Git put that entry back. Refresh.",
        ));
    }
    let after = read_list(txn.root(), txn.runner().deadline().reads())?;
    if position(&after, &listed.oid).is_some() {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Git reported the drop, but the stash is still listed. Refresh.",
        ));
    }
    Ok(RemoveResult::Dropped)
}

fn store_at(txn: &RefTxn<'_>, subject: &str, oid: &Oid) -> Result<(), RepositoryError> {
    txn.stash(&["store", "-m", subject, oid.as_str()])
        .run(txn.runner().deadline())?
        .succeeded()
        .map(drop)
}

/// Undo of a push drops the stash only when the restored worktree still holds
/// every blob the stash commit recorded. A miss keeps the entry.
fn stash_matches_worktree(repo: &Repo, listed: &Listed, deadline: WriteDeadline) -> bool {
    let reads = deadline.reads();
    let Ok(parents) = parents_of(repo, &listed.oid, reads) else {
        return false;
    };
    let Ok(work) = ls_tree(&repo.root, &listed.oid, reads) else {
        return false;
    };
    let untracked = if let Some(oid) = &parents.untracked {
        let Ok(tree) = ls_tree(&repo.root, oid, reads) else {
            return false;
        };
        tree
    } else {
        BTreeMap::new()
    };
    let Ok(names) = diff_names(&repo.root, &parents.base, &listed.oid, reads) else {
        return false;
    };
    for path in names {
        if let Some(blob) = work.get(&path) {
            if blob.mode == Mode::Submodule {
                continue;
            }
            if !file_hashes_to(&repo.root, &path, &blob.oid, reads) {
                return false;
            }
        } else if fs::symlink_metadata(repo.root.join(&path)).is_ok() {
            return false;
        }
    }
    for (path, blob) in &untracked {
        if blob.mode == Mode::Submodule {
            continue;
        }
        if !file_hashes_to(&repo.root, path, &blob.oid, reads) {
            return false;
        }
    }
    let Ok(index_tree) = ls_tree(&repo.root, &parents.index, reads) else {
        return false;
    };
    let Ok((rows, _)) = index::read_worktree(&repo.root, reads) else {
        return false;
    };
    stage0_matches(&rows, &index_tree)
}

fn stage0_matches(rows: &Rows, tree: &BTreeMap<String, Blob>) -> bool {
    let mut index = BTreeMap::new();
    for (path, entries) in rows {
        let Ok(path) = str::from_utf8(path) else {
            return false;
        };
        match entries.as_slice() {
            [one] if one.stage == 0 => {
                index.insert(path.to_owned(), (one.mode, one.oid.clone()));
            }
            [] => {}
            _ => return false,
        }
    }
    index.len() == tree.len()
        && tree.iter().all(|(path, blob)| {
            index
                .get(path)
                .is_some_and(|(mode, oid)| mode == &blob.mode && oid == &blob.oid)
        })
}

fn observe(repo: &Repo, deadline: WriteDeadline) -> Result<Now, RepositoryError> {
    let head = repo.head(deadline)?;
    let list = read_list(&repo.root, deadline.reads())?;
    let (rows, raw_index) = index::read_worktree(&repo.root, deadline.reads())?;
    let (status, _) = status::entries(&repo.root, Untracked::All, deadline.reads())?;
    Ok(Now {
        head,
        list,
        rows,
        raw_index,
        status,
    })
}

fn push_candidates(
    repo: &Repo,
    now: &Now,
    requested: Option<&BTreeSet<String>>,
    include_untracked: bool,
) -> Result<Candidates, RepositoryError> {
    if let Some(requested) = requested {
        for path in requested {
            if !status_lists(&now.status, path) {
                return Err(files::changed(path));
            }
        }
    }
    let mut names = BTreeSet::new();
    let mut files = BTreeSet::new();
    for entry in &now.status {
        let path = entry_path(entry);
        if path.ends_with('/') {
            continue;
        }
        if !include_untracked && matches!(entry, StatusEntry::Untracked { .. }) {
            if requested.is_some_and(|requested| requested.contains(path)) {
                return Err(files::changed(path));
            }
            continue;
        }
        let original = entry_original(entry);
        let named = requested.is_none_or(|requested| {
            requested.contains(path)
                || original.is_some_and(|original| requested.contains(original))
        });
        if !named {
            continue;
        }
        if is_gitlink(&now.rows, path) || entry_is_submodule(entry) {
            names.insert(path.to_owned());
            continue;
        }
        names.insert(path.to_owned());
        files.insert(path.to_owned());
        if let Some(original) = original {
            names.insert(original.to_owned());
            if !is_gitlink(&now.rows, original) && !original.ends_with('/') {
                files.insert(original.to_owned());
            }
        }
    }
    let file_list: Vec<String> = files.into_iter().collect();
    let refs: Vec<&str> = file_list.iter().map(String::as_str).collect();
    if !refs.is_empty() {
        files::guard(&repo.root, &now.rows, &refs, &STASH)?;
    }
    Ok(Candidates {
        names: names.into_iter().collect(),
        files: file_list,
    })
}

fn apply_candidates_of(
    repo: &Repo,
    work: &Oid,
    parents: &Parents,
    rows: &Rows,
    reads: Deadline,
) -> Result<Candidates, RepositoryError> {
    let mut names = BTreeSet::new();
    names.extend(diff_names(&repo.root, &parents.base, work, reads)?);
    names.extend(diff_names(
        &repo.root,
        &parents.base,
        &parents.index,
        reads,
    )?);
    if let Some(untracked) = &parents.untracked {
        names.extend(ls_tree(&repo.root, untracked, reads)?.into_keys());
    }
    let renames = name_status(
        &repo.root,
        &[
            "diff-index",
            "--cached",
            "-M",
            "-z",
            "--name-status",
            parents.base.as_str(),
        ],
        reads,
    )?;
    for (code, paths) in renames {
        if (code == b'R' || code == b'C') && paths.len() == 2 && names.contains(&paths[0]) {
            names.insert(paths[1].clone());
        }
    }
    let mut files = Vec::new();
    for name in &names {
        if !is_gitlink(rows, name) {
            files.push(name.clone());
        }
    }
    let refs: Vec<&str> = files.iter().map(String::as_str).collect();
    if !refs.is_empty() {
        files::guard(&repo.root, rows, &refs, &STASH)?;
    }
    Ok(Candidates {
        names: names.into_iter().collect(),
        files,
    })
}

fn parents_of(repo: &Repo, oid: &Oid, reads: Deadline) -> Result<Parents, RepositoryError> {
    let raw = git::read(
        &repo.root,
        &["rev-list", "--parents", "-n", "1", oid.as_str()],
        reads,
    )?;
    let line = git::line(&raw);
    let mut ids = line.split_whitespace();
    let _self = ids.next();
    let base = parse_oid(ids.next().ok_or_else(git::malformed)?)?;
    let index = parse_oid(ids.next().ok_or_else(git::malformed)?)?;
    let untracked = ids.next().map(parse_oid).transpose()?;
    let index_part = !diff_names(&repo.root, &base, &index, reads)?.is_empty();
    Ok(Parents {
        base,
        index,
        untracked,
        index_part,
    })
}

fn born(head: &Head) -> Result<Oid, RepositoryError> {
    match head {
        Head::Attached { oid, .. } | Head::Detached { oid } => {
            Oid::try_from(oid.clone()).map_err(|_| git::malformed())
        }
        Head::Unborn { .. } => Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "You do not have the initial commit yet",
        )),
    }
}

fn requested(paths: &[String]) -> Result<Option<BTreeSet<String>>, RepositoryError> {
    if paths.is_empty() {
        return Ok(None);
    }
    let mut set = BTreeSet::new();
    for path in paths {
        status::check(path)?;
        if path.contains('\0') {
            return Err(files::unsupported(
                "L1 Git cannot stash a file name that holds a NUL byte.".to_owned(),
            ));
        }
        set.insert(path.clone());
    }
    Ok(Some(set))
}

fn require_tip(
    repo: &Repo,
    tip: &StashTip,
    deadline: WriteDeadline,
) -> Result<Listed, RepositoryError> {
    check_name(&tip.name)?;
    let resolved = resolve(&repo.root, &tip.name, deadline.reads())?;
    if resolved.as_ref() != Some(&tip.oid) {
        return Err(stash_moved(&tip.name));
    }
    let list = read_list(&repo.root, deadline.reads())?;
    let subject = list
        .iter()
        .find(|item| item.oid == tip.oid)
        .map(|item| item.subject.clone())
        .unwrap_or_default();
    Ok(Listed {
        oid: tip.oid.clone(),
        subject,
    })
}

fn check_name(name: &str) -> Result<(), RepositoryError> {
    let Some(index) = name
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
    else {
        return Err(files::unsupported(format!(
            "{name} is not a stash@{{n}} entry. Refresh the stash list."
        )));
    };
    if index.is_empty()
        || !index.bytes().all(|byte| byte.is_ascii_digit())
        || (index.len() > 1 && index.starts_with('0'))
    {
        return Err(files::unsupported(format!(
            "{name} is not a stash@{{n}} entry. Refresh the stash list."
        )));
    }
    Ok(())
}

fn refuse_utf8(rows: &Rows) -> Result<(), RepositoryError> {
    if rows.keys().any(|path| str::from_utf8(path).is_err()) {
        return Err(files::unsupported(
            "A file name that is not valid UTF-8 is in the index, which L1 Git cannot stash. Rename that file, or stash it with Git.".to_owned(),
        ));
    }
    Ok(())
}

fn refuse_unmerged(status: &[StatusEntry]) -> Result<(), RepositoryError> {
    let paths = unmerged_paths(status);
    if paths.is_empty() {
        return Ok(());
    }
    Err(RepositoryError::new(
        ErrorKind::Conflict,
        format!(
            "{} have conflicts. Resolve them, then try again.",
            join_paths(&paths)
        ),
    ))
}

fn refuse_intent(rows: &Rows, only: Option<&BTreeSet<String>>) -> Result<(), RepositoryError> {
    for (path, entries) in rows {
        if !entries.iter().any(|entry| entry.intent_to_add) {
            continue;
        }
        let Some(path) = str::from_utf8(path).ok() else {
            continue;
        };
        if only.is_some_and(|only| !only.contains(path)) {
            continue;
        }
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            format!("Entry '{path}' not uptodate. Cannot merge."),
        ));
    }
    Ok(())
}

fn refuse_assume_unchanged(
    repo: &Repo,
    rows: &Rows,
    only: Option<&BTreeSet<String>>,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    for (path, entries) in rows {
        let Some(path) = str::from_utf8(path).ok() else {
            continue;
        };
        if only.is_some_and(|only| !only.contains(path)) {
            continue;
        }
        let Some(entry) = entries
            .iter()
            .find(|entry| entry.stage == 0 && entry.assume_unchanged)
        else {
            continue;
        };
        if !file_hashes_to(&repo.root, path, &entry.oid, deadline.reads()) {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                format!(
                    "{path} is marked assume-unchanged and its file differs from the index. Stashing would replace the file with the index copy. Refresh it with Git first."
                ),
            ));
        }
    }
    Ok(())
}

fn run_push(
    txn: &RefTxn<'_>,
    message: &str,
    untracked: bool,
    spec: &[u8],
) -> Result<Wrote, RepositoryError> {
    let mut args = vec!["push", "-q"];
    if !message.is_empty() {
        args.extend(["-m", message]);
    }
    if untracked {
        args.push("-u");
    }
    if !spec.is_empty() {
        args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    }
    let mut command = txn.stash(&args);
    if !spec.is_empty() {
        command = command.input(spec.to_vec());
    }
    command.run(txn.runner().deadline())
}

fn literal_pathspecs(paths: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend(b":(literal)");
        out.extend(path.as_bytes());
        out.push(0);
    }
    out
}

fn outside_write(
    repo: &Repo,
    before_rows: &Rows,
    after_rows: &Rows,
    allowed: &BTreeSet<&str>,
    status_diff: &BTreeSet<String>,
    index_diff: &[String],
    reads: Deadline,
) -> Result<Option<String>, RepositoryError> {
    for path in status_diff {
        if allowed.contains(path.as_str()) {
            continue;
        }
        let row_changed = index::at(before_rows, path) != index::at(after_rows, path);
        if !row_changed || !hashes_like_before(repo, path, before_rows, reads) {
            return Ok(Some(path.clone()));
        }
    }
    for path in index_diff {
        if allowed.contains(path.as_str()) {
            continue;
        }
        if !hashes_like_before(repo, path, before_rows, reads) {
            return Ok(Some(path.clone()));
        }
    }
    Ok(None)
}

fn hashes_like_before(repo: &Repo, path: &str, rows: &Rows, reads: Deadline) -> bool {
    let Some(entry) = index::at(rows, path).iter().find(|entry| entry.stage == 0) else {
        return fs::symlink_metadata(repo.root.join(path)).is_err();
    };
    if entry.mode == Mode::Submodule {
        return true;
    }
    file_hashes_to(&repo.root, path, &entry.oid, reads)
}

const INDEX_BEFORE: &str = "index-before";
const STATUS_BEFORE: &str = "status-before";

fn load_rows(files: &Path) -> Result<Rows, RepositoryError> {
    let raw = fs::read(files.join(INDEX_BEFORE))
        .map_err(|error| files::failed("the undo history", &error))?;
    index::parse_rows(&raw)
}

fn load_status(files: &Path) -> Result<Vec<StatusEntry>, RepositoryError> {
    let raw = fs::read(files.join(STATUS_BEFORE))
        .map_err(|error| files::failed("the undo history", &error))?;
    serde_json::from_slice(&raw).map_err(|_| git::malformed())
}

fn any_file_changed(
    root: &Path,
    files: &Path,
    captured: &[Captured],
) -> Result<bool, RepositoryError> {
    for captured in captured {
        let same = files::holds(root, &captured.path, &captured.before, files)
            .map_err(|error| files::failed(&captured.path, &error))?;
        if !same {
            return Ok(true);
        }
    }
    Ok(false)
}

fn changed_files(
    root: &Path,
    files: &Path,
    captured: &[Captured],
) -> Result<Vec<FileChange>, RepositoryError> {
    let mut changed = Vec::new();
    for (at, captured) in captured.iter().enumerate() {
        let same = files::holds(root, &captured.path, &captured.before, files)
            .map_err(|error| files::failed(&captured.path, &error))?;
        if same {
            continue;
        }
        changed.push(FileChange {
            path: captured.path.clone(),
            before: captured.before.clone(),
            after: files::capture(root, &captured.path, files, format!("{at}.after"))?,
        });
    }
    Ok(changed)
}

fn diff_paths(head: &Head, before: &Rows, after: &Rows) -> Result<Vec<String>, RepositoryError> {
    Ok(IndexChange::differing(head.clone(), before, after)?
        .path_names()
        .map(str::to_owned)
        .collect())
}

fn status_changes(before: &[StatusEntry], after: &[StatusEntry]) -> BTreeSet<String> {
    let before = status_map(before);
    let after = status_map(after);
    let mut changed = BTreeSet::new();
    for (path, entry) in &before {
        if after.get(path) != Some(entry) {
            changed.insert(path.clone());
        }
    }
    for path in after.keys() {
        if !before.contains_key(path) {
            changed.insert(path.clone());
        }
    }
    changed
}

fn status_map(entries: &[StatusEntry]) -> BTreeMap<String, StatusEntry> {
    entries
        .iter()
        .map(|entry| (entry_path(entry).to_owned(), entry.clone()))
        .collect()
}

fn status_lists(entries: &[StatusEntry], path: &str) -> bool {
    entries
        .iter()
        .any(|entry| entry_path(entry) == path || entry_original(entry) == Some(path))
}

fn staged_outside(entries: &[StatusEntry], candidates: &[String]) -> Option<String> {
    let candidates: BTreeSet<&str> = candidates.iter().map(String::as_str).collect();
    entries.iter().find_map(|entry| {
        if !is_staged(entry) {
            return None;
        }
        let path = entry_path(entry);
        (!candidates.contains(path)).then(|| path.to_owned())
    })
}

fn is_staged(entry: &StatusEntry) -> bool {
    match entry {
        StatusEntry::Ordinary {
            sides: Sides::Staged { .. } | Sides::Both { .. },
            ..
        } => true,
        StatusEntry::Renamed {
            side: MoveSide::Staged { .. },
            ..
        } => true,
        StatusEntry::Ordinary { .. }
        | StatusEntry::Renamed { .. }
        | StatusEntry::Unmerged { .. }
        | StatusEntry::Untracked { .. } => false,
    }
}

fn unmerged_paths(entries: &[StatusEntry]) -> Vec<&str> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            StatusEntry::Unmerged { path, .. } => Some(path.as_str()),
            StatusEntry::Ordinary { .. }
            | StatusEntry::Renamed { .. }
            | StatusEntry::Untracked { .. } => None,
        })
        .collect()
}

fn entry_path(entry: &StatusEntry) -> &str {
    match entry {
        StatusEntry::Ordinary { path, .. }
        | StatusEntry::Renamed { path, .. }
        | StatusEntry::Unmerged { path, .. }
        | StatusEntry::Untracked { path } => path,
    }
}

fn entry_original(entry: &StatusEntry) -> Option<&str> {
    match entry {
        StatusEntry::Renamed { original, .. } => Some(original),
        StatusEntry::Ordinary { .. }
        | StatusEntry::Unmerged { .. }
        | StatusEntry::Untracked { .. } => None,
    }
}

fn entry_is_submodule(entry: &StatusEntry) -> bool {
    match entry {
        StatusEntry::Ordinary {
            submodule: Some(_), ..
        }
        | StatusEntry::Renamed {
            submodule: Some(_), ..
        }
        | StatusEntry::Unmerged {
            submodule: Some(_), ..
        } => true,
        StatusEntry::Ordinary { .. }
        | StatusEntry::Renamed { .. }
        | StatusEntry::Unmerged { .. }
        | StatusEntry::Untracked { .. } => false,
    }
}

fn is_gitlink(rows: &Rows, path: &str) -> bool {
    index::at(rows, path)
        .iter()
        .any(|entry| entry.mode == Mode::Submodule)
}

fn added_entry<'a>(before: &[Listed], after: &'a [Listed]) -> Option<&'a Listed> {
    (after.len() == before.len() + 1 && after[1..] == before[..]).then_some(&after[0])
}

fn position(list: &[Listed], oid: &Oid) -> Option<usize> {
    list.iter().position(|listed| &listed.oid == oid)
}

fn read_list(root: &Path, reads: Deadline) -> Result<Vec<Listed>, RepositoryError> {
    let raw = git::read(root, &["stash", "list", "-z", "--format=%H%x1f%gs"], reads)?;
    let mut list = Vec::new();
    for record in raw.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(2, |byte| *byte == 0x1f);
        let oid = parse_oid(&git::text(parts.next().ok_or_else(git::malformed)?))?;
        let subject = git::text(parts.next().unwrap_or(b""));
        list.push(Listed { oid, subject });
    }
    Ok(list)
}

fn resolve(root: &Path, name: &str, reads: Deadline) -> Result<Option<Oid>, RepositoryError> {
    let ran = git::run(root, &["rev-parse", "--verify", "--quiet", name], reads)?;
    if !ran.status.success() {
        return Ok(None);
    }
    Ok(Some(parse_oid(&git::line(&ran.stdout))?))
}

fn first_parent(root: &Path, oid: &Oid, reads: Deadline) -> Result<Oid, RepositoryError> {
    let spec = format!("{}^1", oid.as_str());
    let raw = git::read(root, &["rev-parse", "--verify", &spec], reads)?;
    parse_oid(&git::line(&raw))
}

fn diff_names(
    root: &Path,
    from: &Oid,
    to: &Oid,
    reads: Deadline,
) -> Result<Vec<String>, RepositoryError> {
    let changes = name_status(
        root,
        &[
            "diff-tree",
            "-r",
            "--no-commit-id",
            "-z",
            "--name-status",
            "-M",
            from.as_str(),
            to.as_str(),
        ],
        reads,
    )?;
    Ok(changes.into_iter().flat_map(|(_, paths)| paths).collect())
}

fn name_status(
    root: &Path,
    args: &[&str],
    reads: Deadline,
) -> Result<Vec<(u8, Vec<String>)>, RepositoryError> {
    parse_name_status(&git::read(root, args, reads)?)
}

fn parse_name_status(raw: &[u8]) -> Result<Vec<(u8, Vec<String>)>, RepositoryError> {
    let parts: Vec<&[u8]> = raw.split(|byte| *byte == 0).collect();
    let mut cursor = 0;
    let mut changes = Vec::new();
    while cursor < parts.len() {
        if parts[cursor].is_empty() {
            cursor += 1;
            continue;
        }
        let status = std::str::from_utf8(parts[cursor]).map_err(|_| git::malformed())?;
        let code = status
            .as_bytes()
            .first()
            .copied()
            .ok_or_else(git::malformed)?;
        cursor += 1;
        if code == b'R' || code == b'C' {
            if cursor + 1 >= parts.len() {
                return Err(git::malformed());
            }
            let old = git::text(parts[cursor]);
            let new = git::text(parts[cursor + 1]);
            cursor += 2;
            changes.push((code, vec![old, new]));
        } else {
            if cursor >= parts.len() {
                return Err(git::malformed());
            }
            let path = git::text(parts[cursor]);
            cursor += 1;
            changes.push((code, vec![path]));
        }
    }
    Ok(changes)
}

fn ls_tree(
    root: &Path,
    oid: &Oid,
    reads: Deadline,
) -> Result<BTreeMap<String, Blob>, RepositoryError> {
    let raw = git::read(root, &["ls-tree", "-r", "-z", oid.as_str()], reads)?;
    let mut tree = BTreeMap::new();
    for record in raw.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(git::malformed)?;
        let mut fields = record[..tab].split(|byte| *byte == b' ');
        let mode = fields.next().ok_or_else(git::malformed)?;
        let _kind = fields.next();
        let oid = fields.next().ok_or_else(git::malformed)?;
        tree.insert(
            git::text(&record[tab + 1..]),
            Blob {
                mode: Mode::parse(mode).ok_or_else(git::malformed)?,
                oid: parse_oid(&git::text(oid))?,
            },
        );
    }
    Ok(tree)
}

fn file_hashes_to(root: &Path, path: &str, oid: &Oid, reads: Deadline) -> bool {
    if path.contains('\n') || fs::symlink_metadata(root.join(path)).is_err() {
        return false;
    }
    git::read_with_input(
        root,
        &["hash-object", "--stdin-paths"],
        format!("{path}\n").into_bytes(),
        reads,
    )
    .ok()
    .is_some_and(|output| git::line(&output) == oid.as_str())
}

fn parse_oid(text: &str) -> Result<Oid, RepositoryError> {
    Oid::try_from(text.trim().to_owned()).map_err(|_| git::malformed())
}

fn parse_dropped(output: &str) -> Option<Oid> {
    let start = output.find("Dropped stash@{")?;
    let rest = &output[start..];
    let open = rest.find('(')?;
    let close = rest[open + 1..].find(')')?;
    Oid::try_from(rest[open + 1..open + 1 + close].to_owned()).ok()
}

fn join_paths(paths: &[&str]) -> String {
    match paths {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [one, two] => format!("{one} and {two}"),
        [first, rest @ ..] => {
            let Some((last, middle)) = rest.split_last() else {
                return (*first).to_owned();
            };
            let mut message = (*first).to_owned();
            for path in middle {
                message.push_str(", ");
                message.push_str(path);
            }
            message.push_str(" and ");
            message.push_str(last);
            message
        }
    }
}

fn nothing_to_save() -> RepositoryError {
    RepositoryError::new(ErrorKind::UnchangedPath, "No local changes to save")
}

fn stash_moved(name: &str) -> RepositoryError {
    RepositoryError::stale(
        StaleReason::StashChanged,
        format!("{name} no longer holds the stash you saw. Refresh and try again."),
    )
}

fn partial(verb: &str, said: &str) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        format!(
            "Git could not finish {verb}. Undo puts back the files it changed. Git said: {}",
            stderr::summarize(said)
        ),
    )
}

fn git_said(prefix: &str, said: &str) -> RepositoryError {
    if said.contains(stderr::LOCK_HELD) {
        return RepositoryError::new(
            ErrorKind::LockHeld,
            format!(
                "Another Git process is changing this repository. Wait for it to finish, then try again. Git said: {}",
                stderr::summarize(said)
            ),
        );
    }
    RepositoryError::new(
        ErrorKind::GitFailed,
        format!("{prefix} Git said: {}", stderr::summarize(said)),
    )
}

fn raced(message: impl Into<String>) -> RepositoryError {
    RepositoryError::new(ErrorKind::Raced, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_oid_git_prints_when_it_drops_a_stash() {
        let oid = "f44e936413564be95578877a46ac23afbf99f104";
        let parsed = parse_dropped(&format!("Dropped stash@{{0}} ({oid})\n")).unwrap();
        assert_eq!(parsed.as_str(), oid);
    }
}
