use super::{
    BranchTip, Change, CommitTxn, EntryId, MergeTxn, Operation, Repo, commit, index,
    store::{EntryObjects, Identity, LockedStore, Objects},
    txn::Runner,
};
use crate::{
    BranchRef, Coordinator, ErrorKind, Head, Oid, RepositoryError, StagedStamp, StaleReason,
    StatusEntry,
    git::{self, LocalWrite, WriteDeadline},
    status::{self, Untracked},
    sync,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeSource {
    pub reference: String,
    pub oid: Oid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeTracking {
    pub remote: String,
    pub merge: String,
    pub fetch: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeReview {
    pub root: String,
    pub destination: BranchTip,
    pub source: MergeSource,
    pub tracking: MergeTracking,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MergeAction {
    Start {
        review: MergeReview,
    },
    Finish {
        session: EntryId,
        staged: StagedStamp,
        tree: Oid,
        message: String,
    },
    Abort {
        session: EntryId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeSession {
    pub id: EntryId,
    pub review: MergeReview,
    pub footprint: Vec<String>,
    pub suggested_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MergeState {
    Idle,
    Active {
        session: MergeSession,
        unresolved: Vec<String>,
        staged: StagedStamp,
        tree: Option<Oid>,
        upstream_moved: bool,
    },
    Attention {
        session: Option<MergeSession>,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MergeOutcome {
    Started {
        problem: Option<String>,
    },
    Finished {
        commit: Oid,
        problem: Option<String>,
    },
    Aborted,
    NotStarted {
        problem: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeReport {
    pub state: MergeState,
    pub outcome: MergeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SessionPhase {
    Starting,
    Active,
    Finishing { tree: Oid },
    Aborting,
    Closed { outcome: MergeOutcome },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    identity: Identity,
    session: MergeSession,
    phase: SessionPhase,
}

fn refused(message: impl Into<String>) -> RepositoryError {
    RepositoryError::new(ErrorKind::Conflict, message)
}

fn storage(error: impl std::fmt::Display) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnreadablePath,
        format!(
            "L1 Git cannot read or persist the merge session. Preserve its files and resolve this before changing the repository. {error}"
        ),
    )
}

fn base(repo: &Repo) -> PathBuf {
    repo.git_dir.join("l1git").join("merge")
}
fn directory(repo: &Repo, id: EntryId) -> PathBuf {
    base(repo).join(id.to_string())
}

fn checked_dir(path: &Path) -> Result<(), RepositoryError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(storage(format!(
            "{} is not an ordinary directory.",
            path.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            super::store::private_folder()
                .create(path)
                .map_err(storage)?;
            sync_dir(
                path.parent()
                    .ok_or_else(|| storage("Missing session parent."))?,
            )
        }
        Err(error) => Err(storage(error)),
    }
}

fn sync_dir(path: &Path) -> Result<(), RepositoryError> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(storage)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn persist<T: Serialize>(path: &Path, value: &T) -> Result<(), RepositoryError> {
    let temporary = path.with_extension(format!("{}.tmp", EntryId::after(None)));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(storage)?;
    file.write_all(&serde_json::to_vec(value).map_err(storage)?)
        .map_err(storage)?;
    file.sync_all().map_err(storage)?;
    fs::rename(&temporary, path).map_err(storage)?;
    sync_dir(
        path.parent()
            .ok_or_else(|| storage("Missing session parent."))?,
    )
}

fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, RepositoryError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {}
        Ok(_) => return Err(storage("The session record is not an ordinary file.")),
        Err(error) => return Err(storage(error)),
    }
    serde_json::from_slice(&fs::read(path).map_err(storage)?)
        .map(Some)
        .map_err(storage)
}

impl Record {
    fn save(&self, repo: &Repo) -> Result<(), RepositoryError> {
        persist(&directory(repo, self.session.id).join("state.json"), self)
    }

    fn close(&mut self, repo: &Repo, outcome: MergeOutcome) -> Result<(), RepositoryError> {
        self.phase = SessionPhase::Closed { outcome };
        self.save(repo)
    }

    fn objects(&self, repo: &Repo) -> EntryObjects {
        EntryObjects::for_merge(&directory(repo, self.session.id), self.session.id)
    }

    fn keep(
        &self,
        repo: &Repo,
        deadline: WriteDeadline,
        tips: Vec<Oid>,
    ) -> Result<(), RepositoryError> {
        let txn = MergeTxn::begin(repo, deadline)?;
        self.objects(repo)
            .keep(txn.runner(), &Objects::exact(tips))?;
        fn sync_files(path: &Path) -> Result<(), RepositoryError> {
            for entry in fs::read_dir(path).map_err(storage)? {
                let path = entry.map_err(storage)?.path();
                if path.is_dir() {
                    sync_files(&path)?;
                } else {
                    fs::File::open(&path)
                        .and_then(|file| file.sync_all())
                        .map_err(storage)?;
                }
            }
            sync_dir(path)
        }
        sync_files(&directory(repo, self.session.id))
    }
}

fn load(repo: &Repo) -> Result<Option<Record>, RepositoryError> {
    // Check every parent before following the pointer, including on read-only discovery.
    for path in [repo.git_dir.join("l1git"), base(repo)] {
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Err(storage("The merge directory is not an ordinary directory.")),
            Err(error) => return Err(storage(error)),
        }
    }
    let Some(id) = read::<EntryId>(&base(repo).join("current.json"))? else {
        return Ok(None);
    };
    load_id(repo, id).map(Some)
}

fn load_id(repo: &Repo, id: EntryId) -> Result<Record, RepositoryError> {
    let dir = directory(repo, id);
    let meta = fs::symlink_metadata(&dir).map_err(storage)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(storage("Invalid session directory."));
    }
    let record: Record =
        read(&dir.join("state.json"))?.ok_or_else(|| storage("Missing session record."))?;
    if record.version != 1
        || record.identity != Identity::of(&repo.git_dir)?
        || record.session.id != id
        || record.session.review.root != repo.root()
    {
        return Err(storage(
            "The session belongs to a different worktree or format.",
        ));
    }
    Ok(record)
}

fn expected_head(session: &MergeSession) -> Head {
    Head::Attached {
        reference: session.review.destination.reference.as_str().into(),
        oid: session.review.destination.oid.as_str().into(),
    }
}

fn marker(repo: &Repo, name: &str) -> Result<Option<String>, RepositoryError> {
    match fs::read_to_string(repo.git_dir.join(name)) {
        Ok(text) => Ok(Some(text.trim().to_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(storage(error)),
    }
}

fn owned(repo: &Repo, record: &Record, deadline: WriteDeadline) -> Result<bool, RepositoryError> {
    let operations = sync::in_progress(&repo.root, deadline.reads())?;
    Ok(repo.head(deadline)? == expected_head(&record.session)
        && marker(repo, "MERGE_HEAD")?.as_deref()
            == Some(record.session.review.source.oid.as_str())
        && operations.len() == 1
        && operations[0].name() == "a merge"
        && marker(repo, "MERGE_AUTOSTASH")?.is_none())
}

fn baseline(
    repo: &Repo,
    record: &Record,
    deadline: WriteDeadline,
) -> Result<bool, RepositoryError> {
    Ok(repo.head(deadline)? == expected_head(&record.session)
        && sync::in_progress(&repo.root, deadline.reads())?.is_empty()
        && status::entries(&repo.root, Untracked::No, deadline.reads())?
            .0
            .is_empty()
        && marker(repo, "MERGE_AUTOSTASH")?.is_none())
}

fn landed(
    repo: &Repo,
    record: &Record,
    tree: &Oid,
    deadline: WriteDeadline,
) -> Result<Option<MergeOutcome>, RepositoryError> {
    let Head::Attached { reference, oid } = repo.head(deadline)? else {
        return Ok(None);
    };
    if reference != record.session.review.destination.reference.as_str()
        || !sync::in_progress(&repo.root, deadline.reads())?.is_empty()
    {
        return Ok(None);
    }
    let output = git::read(
        &repo.root,
        &["show", "-s", "--format=%P%n%T", &oid],
        deadline.reads(),
    )?;
    let text = git::text(&output);
    let mut lines = text.lines();
    let parents = format!(
        "{} {}",
        record.session.review.destination.oid.as_str(),
        record.session.review.source.oid.as_str()
    );
    if lines.next() != Some(parents.as_str()) {
        return Ok(None);
    }
    let problem = (lines.next() != Some(tree.as_str())).then(|| "Git created the merge commit with a different tree than the reviewed staged result. Inspect the commit before pushing.".to_owned());
    Ok(Some(MergeOutcome::Finished {
        commit: Oid::try_from(oid).map_err(|_| git::malformed())?,
        problem,
    }))
}

fn reconcile(repo: &Repo, deadline: WriteDeadline) -> Result<Option<Record>, RepositoryError> {
    let Some(mut record) = load(repo)? else {
        return Ok(None);
    };
    match record.phase.clone() {
        SessionPhase::Starting if baseline(repo, &record, deadline)? => {
            record.close(repo, MergeOutcome::NotStarted { problem: "The interrupted merge did not change the clean starting state. Review and start again.".into() })?;
        }
        SessionPhase::Finishing { tree } => {
            if let Some(mut outcome) = landed(repo, &record, &tree, deadline)? {
                if let MergeOutcome::Finished { problem, .. } = &mut outcome {
                    problem.get_or_insert_with(|| "The merge commit landed during an interrupted Finish. Inspect it before pushing.".into());
                }
                record.close(repo, outcome)?;
            } else if owned(repo, &record, deadline)? {
                record.phase = SessionPhase::Active;
                record.save(repo)?;
            }
        }
        SessionPhase::Aborting if baseline(repo, &record, deadline)? => {
            record.close(repo, MergeOutcome::Aborted)?;
        }
        SessionPhase::Aborting if owned(repo, &record, deadline)? => {
            record.phase = SessionPhase::Active;
            record.save(repo)?;
        }
        SessionPhase::Starting
        | SessionPhase::Active
        | SessionPhase::Aborting
        | SessionPhase::Closed { .. } => {}
    }
    Ok(Some(record))
}

fn state(
    repo: &Repo,
    record: Option<&Record>,
    deadline: WriteDeadline,
) -> Result<MergeState, RepositoryError> {
    if let Some(record) = record {
        match &record.phase {
            SessionPhase::Closed { .. } => {}
            SessionPhase::Active if owned(repo, record, deadline)? => {
                let (entries, staged) =
                    status::entries(&repo.root, Untracked::No, deadline.reads())?;
                let unresolved: Vec<_> = entries
                    .iter()
                    .filter_map(|entry| {
                        if let StatusEntry::Unmerged { path, .. } = entry {
                            Some(path.clone())
                        } else {
                            None
                        }
                    })
                    .collect();
                let tree = if unresolved.is_empty() {
                    Some(staged_tree(repo, deadline)?)
                } else {
                    None
                };
                let current =
                    commit::resolve(repo, deadline, &record.session.review.source.reference)?;
                return Ok(MergeState::Active {
                    session: record.session.clone(),
                    unresolved,
                    staged,
                    tree,
                    upstream_moved: current.as_ref() != Some(&record.session.review.source.oid),
                });
            }
            SessionPhase::Starting
            | SessionPhase::Active
            | SessionPhase::Finishing { .. }
            | SessionPhase::Aborting => {
                return Ok(MergeState::Attention { session: Some(record.session.clone()), message: "Merge recovery needs attention. Git's state does not prove a safe continuation or the merge-owned paths. Preserve the session files and resolve the operation externally; L1 Git will not reset or guess.".into() });
            }
        }
    }
    if !sync::in_progress(&repo.root, deadline.reads())?.is_empty() {
        Ok(MergeState::Attention { session: None, message: "A Git operation started outside this merge session is in progress. Finish or abort it with Git, then refresh.".into() })
    } else {
        Ok(MergeState::Idle)
    }
}

fn failed_hook(path: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct Event {
        event: String,
        sid: String,
        child_id: Option<u64>,
        child_class: Option<String>,
        hook_name: Option<String>,
        code: Option<i64>,
    }
    let mut hooks = std::collections::HashMap::new();
    for line in fs::read_to_string(path).ok()?.lines() {
        let Ok(event) = serde_json::from_str::<Event>(line) else {
            continue;
        };
        if event.sid.contains('/') {
            continue;
        }
        if event.event == "child_start" && event.child_class.as_deref() == Some("hook") {
            if let (Some(id), Some(name)) = (event.child_id, event.hook_name) {
                hooks.insert(id, name);
            }
        } else if event.event == "child_exit"
            && event.code.is_some_and(|code| code != 0)
            && let Some(name) = event.child_id.and_then(|id| hooks.get(&id))
        {
            return Some(format!(
                "The {name} hook failed. Inspect the merge commit before pushing."
            ));
        }
    }
    None
}

fn staged_tree(repo: &Repo, deadline: WriteDeadline) -> Result<Oid, RepositoryError> {
    let txn = MergeTxn::begin(repo, deadline)?;
    let bytes = txn
        .runner()
        .git(&["write-tree"])
        .run(deadline)?
        .succeeded()?;
    Oid::try_from(git::line(&bytes)).map_err(|_| git::malformed())
}

fn config(repo: &Repo, key: &str, deadline: WriteDeadline) -> Result<Vec<String>, RepositoryError> {
    let ran = git::run(
        &repo.root,
        &["config", "--null", "--get-all", key],
        deadline.reads(),
    )?;
    if !ran.status.success() && ran.status.code() != Some(1) {
        return Err(git::malformed());
    }
    ran.stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| String::from_utf8(value.to_vec()).map_err(|_| git::malformed()))
        .collect()
}

fn review(repo: &Repo, deadline: WriteDeadline) -> Result<MergeReview, RepositoryError> {
    let Head::Attached { reference, oid } = repo.head(deadline)? else {
        return Err(refused(
            "Merge upstream needs a checked-out local branch with an existing commit.",
        ));
    };
    let branch = BranchRef::try_from(reference).map_err(|_| git::malformed())?;
    let one = |values: Vec<String>| match values.as_slice() {
        [value] => Ok(value.clone()),
        _ => Err(refused(
            "Configure exactly one upstream for this branch before merging.",
        )),
    };
    let remote = one(config(
        repo,
        &format!("branch.{}.remote", branch.name()),
        deadline,
    )?)?;
    let merge = one(config(
        repo,
        &format!("branch.{}.merge", branch.name()),
        deadline,
    )?)?;
    let fetch = if remote == "." {
        Vec::new()
    } else {
        config(repo, &format!("remote.{remote}.fetch"), deadline)?
    };
    let source_ref = git::line(&git::read(
        &repo.root,
        &["for-each-ref", "--format=%(upstream)", branch.as_str()],
        deadline.reads(),
    )?);
    if !source_ref.starts_with("refs/") || source_ref.contains('\n') {
        return Err(refused(
            "The configured upstream is missing. Fetch explicitly, then review again.",
        ));
    }
    let source = commit::resolve(repo, deadline, &source_ref)?.ok_or_else(|| {
        refused("The upstream commit is missing. Fetch explicitly, then review again.")
    })?;
    let destination = Oid::try_from(oid).map_err(|_| git::malformed())?;
    let counts = git::read(
        &repo.root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{}...{}", destination.as_str(), source.as_str()),
        ],
        deadline.reads(),
    )?;
    let counts = git::text(&counts);
    let counts: Vec<_> = counts.split_whitespace().collect();
    if counts.len() != 2 || counts.contains(&"0") {
        return Err(refused(
            "Merge upstream is available only when this branch and its upstream have diverged. Use Fast-forward for a branch that is only behind.",
        ));
    }
    Ok(MergeReview {
        root: repo.root(),
        destination: BranchTip {
            reference: branch,
            oid: destination,
        },
        source: MergeSource {
            reference: source_ref,
            oid: source,
        },
        tracking: MergeTracking {
            remote,
            merge,
            fetch,
        },
    })
}

fn safe_index(repo: &Repo, deadline: WriteDeadline) -> Result<(), RepositoryError> {
    if repo.index.with_extension("lock").exists() {
        return Err(refused(
            "Another Git process owns index.lock. Wait for it to finish.",
        ));
    }
    let (rows, _) = index::read_worktree(&repo.root, deadline.reads())?;
    if rows
        .values()
        .flatten()
        .any(|row| row.skip_worktree || row.assume_unchanged || row.intent_to_add)
    {
        return Err(refused(
            "Merge needs an index without skip-worktree, assume-unchanged, or intent-to-add entries. Restore an ordinary index before starting or continuing.",
        ));
    }
    let sparse = config(repo, "core.sparseCheckout", deadline)?;
    if sparse.iter().any(|value| value != "false" && value != "0") {
        return Err(refused("Merge upstream does not support sparse checkout."));
    }
    Ok(())
}

fn refuse_untracked_collisions(
    repo: &Repo,
    source: &Oid,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let names = |args: &[&str]| -> Result<Vec<String>, RepositoryError> {
        git::read(&repo.root, args, deadline.reads())?
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| {
                String::from_utf8(path.to_vec())
                    .map_err(|_| refused("Merge paths must be valid UTF-8."))
            })
            .collect()
    };
    let incoming = names(&["ls-tree", "-r", "-z", "--name-only", source.as_str()])?;
    // No exclude rules: ignored files need the same protection as other untracked files.
    let untracked = names(&["ls-files", "--others", "-z"])?;
    let collisions: Vec<_> = untracked
        .into_iter()
        .filter(|path| {
            let path = path.trim_end_matches('/');
            incoming.iter().any(|target| {
                target == path
                    || target.starts_with(&format!("{path}/"))
                    || path.starts_with(&format!("{target}/"))
            })
        })
        .collect();
    if collisions.is_empty() {
        Ok(())
    } else {
        Err(refused(format!(
            "Preserve these untracked or ignored files before merging because they overlap the source tree: {}",
            collisions.join(", ")
        )))
    }
}

fn paths(entries: &[StatusEntry]) -> BTreeSet<String> {
    entries
        .iter()
        .flat_map(|entry| match entry {
            StatusEntry::Renamed { path, original, .. } => vec![path.clone(), original.clone()],
            StatusEntry::Ordinary { path, .. }
            | StatusEntry::Unmerged { path, .. }
            | StatusEntry::Untracked { path } => vec![path.clone()],
        })
        .collect()
}

fn within_footprint(
    session: &MergeSession,
    changed: BTreeSet<String>,
) -> Result<(), RepositoryError> {
    let outside: Vec<_> = changed
        .into_iter()
        .filter(|path| !session.footprint.contains(path))
        .collect();
    if !outside.is_empty() {
        return Err(refused(format!(
            "Preserve these tracked changes outside the merge before continuing: {}. L1 Git has not run Abort or changed the index.",
            outside.join(", ")
        )));
    }
    Ok(())
}

impl Coordinator {
    fn merge_locked<T>(
        &self,
        path: &str,
        write: LocalWrite,
        work: impl FnOnce(&Repo, &LockedStore, WriteDeadline) -> Result<T, RepositoryError>,
    ) -> Result<T, RepositoryError> {
        let deadline = self.write_deadline(write);
        let repo = Repo::open(path, deadline.reads())?;
        self.gated(&repo.common_dir, || {
            self.writing(&repo.common_dir, || {
                let base = LockedStore::lock(self.undo_dir(), &repo.common_dir, deadline.reads())?;
                work(&repo, &base, deadline.renewed())
            })
        })
    }

    pub(crate) fn guard_merge_refs<T>(
        &self,
        path: &Path,
        names: &[String],
        work: impl FnOnce() -> Result<T, RepositoryError>,
    ) -> Result<T, RepositoryError> {
        let deadline = self.write_deadline(LocalWrite::MergeStart);
        let repo = Repo::open(
            path.to_str()
                .ok_or_else(|| storage("Invalid worktree path."))?,
            deadline.reads(),
        )?;
        let _base = LockedStore::lock(self.undo_dir(), &repo.common_dir, deadline.reads())?;
        guard_refs(&repo, names, deadline.renewed())?;
        work()
    }

    pub fn review_merge(&self, path: &str) -> Result<MergeReview, RepositoryError> {
        self.merge_locked(path, LocalWrite::MergeStart, |repo, _, deadline| {
            let record = reconcile(repo, deadline)?;
            if state(repo, record.as_ref(), deadline)? != MergeState::Idle {
                return Err(refused(
                    "Finish or resolve the current Git operation before starting a merge.",
                ));
            }
            review(repo, deadline)
        })
    }

    pub fn merge_state(&self, path: &str) -> Result<MergeState, RepositoryError> {
        self.merge_locked(
            path,
            LocalWrite::MergeStart,
            |repo, _, deadline| match reconcile(repo, deadline) {
                Ok(record) => state(repo, record.as_ref(), deadline),
                Err(error) => Ok(MergeState::Attention {
                    session: None,
                    message: error.message,
                }),
            },
        )
    }

    pub fn merge(&self, path: &str, action: &MergeAction) -> Result<MergeReport, RepositoryError> {
        let write = match action {
            MergeAction::Start { .. } => LocalWrite::MergeStart,
            MergeAction::Finish { .. } => LocalWrite::MergeFinish,
            MergeAction::Abort { .. } => LocalWrite::MergeAbort,
        };
        self.merge_locked(path, write, |repo, base_store, deadline| {
            let current = reconcile(repo, deadline)?;
            if let MergeAction::Start { review: shown } = action {
                if state(repo, current.as_ref(), deadline)? != MergeState::Idle { return Err(refused("Finish or resolve the current Git operation first.")) }
                base_store.settled_log(repo, deadline)?;
                if review(repo, deadline)? != *shown { return Err(RepositoryError::stale(StaleReason::HeadMoved, "The reviewed branch, upstream, or tracking configuration changed. Review the merge again.")) }
                safe_index(repo, deadline)?;
                if !status::entries(&repo.root, Untracked::No, deadline.reads())?.0.is_empty() { return Err(refused("Merge upstream needs a clean tracked worktree and index. Commit or stash your changes first.")) }
                refuse_untracked_collisions(repo, &shown.source.oid, deadline)?;
                for dir in [repo.git_dir.join("l1git"), base(repo)] { checked_dir(&dir)?; }
                let id = EntryId::after(current.as_ref().map(|record| record.session.id));
                checked_dir(&directory(repo, id))?;
                let mut record = Record { version: 1, identity: Identity::of(&repo.git_dir)?, session: MergeSession { id, review: shown.clone(), footprint: Vec::new(), suggested_message: format!("Merge {} into {}", shown.source.reference, shown.destination.reference.name()) }, phase: SessionPhase::Starting };
                record.keep(repo, deadline, vec![shown.destination.oid.clone(), shown.source.oid.clone()])?;
                record.save(repo)?;
                persist(&base(repo).join("current.json"), &id)?;
                let txn = MergeTxn::begin(repo, deadline)?;
                let ran = txn.start(&shown.source.oid).run(deadline);
                let deadline = deadline.renewed();
                if owned(repo, &record, deadline)? {
                    // Only this uninterrupted observation can establish ownership of the merge output.
                    if ran.is_err() { return Err(refused("Merge was interrupted. Its affected paths cannot be proved; preserve the session and resolve it externally.")) }
                    let entries = status::entries(&repo.root, Untracked::No, deadline.reads())?.0;
                    record.session.footprint = paths(&entries).into_iter().collect();
                    let conflicts = entries.iter().any(|entry| matches!(entry, StatusEntry::Unmerged { .. }));
                    let problem = match ran { Ok(wrote) if wrote.code() == Some(1) && conflicts => None, result => result.and_then(|wrote| wrote.succeeded()).err().map(|error| error.message) };
                    record.phase = SessionPhase::Active;
                    record.save(repo)?;
                    return Ok(MergeReport { state: state(repo, Some(&record), deadline)?, outcome: MergeOutcome::Started { problem } });
                }
                let problem = ran.and_then(|wrote| wrote.succeeded()).err().map_or_else(|| "Git did not leave the reviewed merge active.".into(), |error| error.message);
                if baseline(repo, &record, deadline)? {
                    let outcome = MergeOutcome::NotStarted { problem };
                    record.close(repo, outcome.clone())?;
                    return Ok(MergeReport { state: MergeState::Idle, outcome });
                }
                return Err(refused(format!("{problem} Merge recovery needs attention. No automatic reset was attempted.")));
            }
            let (MergeAction::Finish { session: id, .. } | MergeAction::Abort { session: id }) = action else { unreachable!() };
            let mut record = load_id(repo, *id)?;
            if let SessionPhase::Closed { outcome } = &record.phase { return Ok(MergeReport { state: state(repo, current.as_ref(), deadline)?, outcome: outcome.clone() }); }
            if current.as_ref().map(|record| record.session.id) != Some(*id) || !matches!(record.phase, SessionPhase::Active) || !owned(repo, &record, deadline)? {
                return Err(refused("The merge session changed or needs recovery. Refresh and inspect its state before continuing."));
            }
            let journal = LockedStore::lock(&directory(repo, *id).join("undo"), &repo.common_dir, deadline.reads())?;
            journal.settled_log(repo, deadline)?;
            safe_index(repo, deadline)?;
            let (entries, stamp) = status::entries(&repo.root, Untracked::No, deadline.reads())?;
            within_footprint(&record.session, paths(&entries))?;
            match action {
                MergeAction::Finish { staged, tree, message, .. } => {
                    if message.trim().is_empty() { return Err(refused("Write a merge commit message.")) }
                    if entries.iter().any(|entry| matches!(entry, StatusEntry::Unmerged { .. })) { return Err(refused("Resolve and stage every conflict before finishing the merge.")) }
                    if stamp != *staged || staged_tree(repo, deadline)? != *tree { return Err(RepositoryError::stale(StaleReason::StagedChanged, "The staged merge result changed. Review it again before finishing.")) }
                    if !git::read(&repo.root, &["diff", "--name-only", "-z", "--no-ext-diff"], deadline.reads())?.is_empty() { return Err(refused("Stage or preserve the remaining tracked edits before finishing the merge.")) }
                    record.keep(repo, deadline, vec![tree.clone()])?;
                    record.phase = SessionPhase::Finishing { tree: tree.clone() };
                    record.save(repo)?;
                    let txn = CommitTxn::begin(repo, deadline)?;
                    let trace = directory(repo, record.session.id).join(format!("finish-{}.json", EntryId::after(None)));
                    let refs = trace.with_extension("refs");
                    let result = txn.commit(&["--allow-empty"], message).traces(&trace, &refs).run(deadline).and_then(|wrote| wrote.succeeded());
                    let deadline = deadline.renewed();
                    if let Some(mut outcome) = landed(repo, &record, tree, deadline)? {
                        if let MergeOutcome::Finished { problem, .. } = &mut outcome
                            && let Err(error) = result {
                            *problem = Some(format!("The merge commit landed, but {} {}", error.message, problem.as_deref().unwrap_or("Inspect the commit before pushing.")));
                        }
                        if let MergeOutcome::Finished { problem, .. } = &mut outcome
                            && let Some(hook) = failed_hook(&trace) {
                            *problem = Some(format!("{} {hook}", problem.as_deref().unwrap_or("The merge commit landed.")));
                        }
                        record.close(repo, outcome.clone())?;
                        return Ok(MergeReport { state: state(repo, Some(&record), deadline)?, outcome });
                    }
                    if owned(repo, &record, deadline)? { record.phase = SessionPhase::Active; record.save(repo)?; }
                    Err(result.err().unwrap_or_else(|| refused("Git did not create the reviewed merge commit. Inspect the merge state before retrying.")))
                }
                MergeAction::Abort { .. } => {
                    if marker(repo, "ORIG_HEAD")?.as_deref() != Some(record.session.review.destination.oid.as_str()) { return Err(refused("ORIG_HEAD changed outside this merge. Abort is unsafe; preserve your work and resolve it externally.")) }
                    record.phase = SessionPhase::Aborting;
                    record.save(repo)?;
                    let txn = MergeTxn::begin(repo, deadline)?;
                    // Restored index rows have no stat cache; refresh it before Git's reset-merge check.
                    let refreshed = txn.runner().git(&["update-index", "--refresh"]).run(deadline)?;
                    if !matches!(refreshed.code(), Some(0 | 1)) { refreshed.succeeded()?; }
                    let result = txn.abort().run(deadline).and_then(|wrote| wrote.succeeded());
                    let deadline = deadline.renewed();
                    if baseline(repo, &record, deadline)? {
                        record.close(repo, MergeOutcome::Aborted)?;
                        return Ok(MergeReport { state: MergeState::Idle, outcome: MergeOutcome::Aborted });
                    }
                    if owned(repo, &record, deadline)? { record.phase = SessionPhase::Active; record.save(repo)?; }
                    Err(result.err().unwrap_or_else(|| refused("Git did not restore the clean starting state. Preserve your work and inspect the merge externally.")))
                }
                MergeAction::Start { .. } => unreachable!(),
            }
        })
    }
}

pub(super) fn journal(
    repo: &Repo,
    deadline: WriteDeadline,
) -> Result<Option<PathBuf>, RepositoryError> {
    let record = reconcile(repo, deadline)?;
    match state(repo, record.as_ref(), deadline)? {
        MergeState::Active { session, .. } => Ok(Some(directory(repo, session.id).join("undo"))),
        MergeState::Attention {
            session: Some(_),
            message,
        } => Err(refused(message)),
        MergeState::Attention { session: None, .. } | MergeState::Idle => Ok(None),
    }
}

pub(super) fn admit(
    repo: &Repo,
    operation: &Operation,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    guard_branches(repo, operation, deadline)?;
    let record = reconcile(repo, deadline)?;
    if let Some(record) = record
        && !matches!(record.phase, SessionPhase::Closed { .. })
    {
        if !matches!(record.phase, SessionPhase::Active) || !owned(repo, &record, deadline)? {
            return Err(refused(
                "The merge needs recovery before more changes are safe.",
            ));
        }
        let changed = match operation {
            Operation::SaveConflict { path, .. }
            | Operation::StageHunk { path, .. }
            | Operation::UnstageHunk { path, .. }
            | Operation::StageLines { path, .. }
            | Operation::UnstageLines { path, .. } => BTreeSet::from([path.clone()]),
            Operation::StageFiles { entries } | Operation::UnstageFiles { entries } => {
                paths(entries)
            }
            Operation::Commit { .. }
            | Operation::Amend { .. }
            | Operation::EditMessage { .. }
            | Operation::Discard { .. }
            | Operation::DiscardHunk { .. }
            | Operation::DiscardLines { .. }
            | Operation::CreateBranch { .. }
            | Operation::RenameBranch { .. }
            | Operation::DeleteBranch { .. }
            | Operation::Checkout { .. }
            | Operation::CreateTag { .. }
            | Operation::DeleteTag { .. }
            | Operation::StashPush { .. }
            | Operation::StashApply { .. }
            | Operation::StashPop { .. }
            | Operation::StashDrop { .. } => {
                return Err(refused(
                    "A managed merge is active. Only resolution and index edits within its affected paths are available until Finish or Abort.",
                ));
            }
        };
        within_footprint(&record.session, changed)?;
    }
    Ok(())
}

fn branch_names(operation: &Operation) -> Vec<String> {
    match operation {
        Operation::RenameBranch { branch, to } => {
            vec![branch.reference.as_str().into(), format!("refs/heads/{to}")]
        }
        Operation::DeleteBranch { branch } => vec![branch.reference.as_str().into()],
        Operation::CreateBranch { name, .. } => vec![format!("refs/heads/{name}")],
        Operation::SaveConflict { .. }
        | Operation::StageFiles { .. }
        | Operation::UnstageFiles { .. }
        | Operation::Commit { .. }
        | Operation::Amend { .. }
        | Operation::EditMessage { .. }
        | Operation::Discard { .. }
        | Operation::StageHunk { .. }
        | Operation::UnstageHunk { .. }
        | Operation::StageLines { .. }
        | Operation::UnstageLines { .. }
        | Operation::DiscardHunk { .. }
        | Operation::DiscardLines { .. }
        | Operation::Checkout { .. }
        | Operation::CreateTag { .. }
        | Operation::DeleteTag { .. }
        | Operation::StashPush { .. }
        | Operation::StashApply { .. }
        | Operation::StashPop { .. }
        | Operation::StashDrop { .. } => Vec::new(),
    }
}

fn guard_branches(
    repo: &Repo,
    operation: &Operation,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let names = branch_names(operation);
    if names.is_empty() {
        return Ok(());
    }
    guard_refs(repo, &names, deadline)
}

pub(super) fn guard_refs(
    repo: &Repo,
    names: &[String],
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    let output = git::read(
        &repo.root,
        &["worktree", "list", "--porcelain", "-z"],
        deadline.reads(),
    )?;
    for field in output.split(|byte| *byte == 0) {
        if let Some(path) = field.strip_prefix(b"worktree ") {
            let path = std::str::from_utf8(path).map_err(|_| git::malformed())?;
            let target = repo.worktree(path, deadline.reads())?;
            if let Some(record) = reconcile(&target, deadline)?
                && !matches!(record.phase, SessionPhase::Closed { .. })
                && names
                    .iter()
                    .any(|name| name == record.session.review.destination.reference.as_str())
            {
                return Err(refused(format!(
                    "{} is the destination of an unfinished merge in {}. Finish or abort it before changing that branch.",
                    record.session.review.destination.reference.as_str(),
                    path
                )));
            }
        }
    }
    Ok(())
}

pub(super) fn admit_step(
    opened: &Repo,
    applied: &super::Applied,
    change: &Change,
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    if let Change::Branch(branch) = change {
        guard_refs(opened, &branch.references(), deadline)?;
    }
    if change.repository_wide() {
        return Ok(());
    }
    let target = opened.worktree(&applied.root, deadline.reads())?;
    if target.root != opened.root && journal(&target, deadline)?.is_some() {
        return Err(refused(
            "This history entry changes a worktree with an active merge. Use that worktree's resolution Undo until Finish or Abort.",
        ));
    }
    admit(&target, &applied.operation, deadline)?;
    Ok(())
}

#[cfg(test)]
mod tests;
