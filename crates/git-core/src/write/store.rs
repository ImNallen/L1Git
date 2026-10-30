use super::{
    Applied, Change, Direction, EntryId, Operation, Repo,
    txn::{Runner, Txn},
};
use crate::{
    ErrorKind, Oid, RepositoryError, StaleReason,
    git::{Deadline, WriteDeadline},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, File, TryLockError},
    io,
    ops::Deref,
    path::{Path, PathBuf},
    thread,
    time::{Duration, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 100;
const VERSION: u32 = 2;
const LOCK_POLL: Duration = Duration::from_millis(10);

pub(super) struct Store {
    dir: PathBuf,
    common_dir: String,
    repository: Identity,
}

pub(super) struct LockedStore {
    store: Store,
    _lock: File,
}

/// The Git common directory as the file system knows it. A repository
/// deleted and created again at the same path gets a new one, so its history
/// never reaches the new repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
    created: Option<u64>,
}

impl Identity {
    fn of(common_dir: &Path) -> Result<Self, RepositoryError> {
        #[cfg(windows)]
        let (metadata, (device, inode)) =
            crate::windows_fs::metadata(common_dir).map_err(unreadable)?;
        #[cfg(not(windows))]
        let metadata = fs::metadata(common_dir).map_err(unreadable)?;
        let created = metadata
            .created()
            .ok()
            .and_then(|created| created.duration_since(UNIX_EPOCH).ok())
            .and_then(|since| u64::try_from(since.as_nanos()).ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                created,
            })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                device,
                inode,
                created,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(Self {
                device: 0,
                inode: 0,
                created,
            })
        }
    }
}

impl Store {
    pub(super) fn open(undo_dir: &Path, common_dir: &Path) -> Result<Self, RepositoryError> {
        Ok(Self {
            dir: undo_dir.join(
                sha1_smol::Sha1::from(common_dir.as_os_str().as_encoded_bytes())
                    .digest()
                    .to_string(),
            ),
            common_dir: common_dir.to_string_lossy().into_owned(),
            repository: Identity::of(common_dir)?,
        })
    }

    pub(super) fn log(&self) -> Result<Log, RepositoryError> {
        let empty = Log {
            version: VERSION,
            common_dir: self.common_dir.clone(),
            repository: self.repository.clone(),
            entries: Vec::new(),
            undone: 0,
            pending: None,
        };
        let bytes = match fs::read(self.dir.join("log.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(empty),
            Err(error) => return Err(unreadable(error)),
        };
        let log: Log = serde_json::from_slice(&bytes).map_err(|_| self.damaged())?;
        if log.version != VERSION
            || log.common_dir != self.common_dir
            || log.undone > log.entries.len()
        {
            return Err(self.damaged());
        }
        if log.repository != self.repository {
            return Ok(empty);
        }
        Ok(log)
    }

    pub(super) fn applied(&self, id: EntryId) -> Result<Applied, RepositoryError> {
        self.read(id, "applied.json")
    }

    pub(super) fn record_of(&self, id: EntryId) -> Result<(Applied, Change), RepositoryError> {
        Ok((
            self.read(id, "applied.json")?,
            self.read(id, "change.json")?,
        ))
    }

    fn entry_dir(&self, id: EntryId) -> PathBuf {
        self.dir.join("entries").join(id.to_string())
    }

    fn read<T: serde::de::DeserializeOwned>(
        &self,
        id: EntryId,
        name: &str,
    ) -> Result<T, RepositoryError> {
        let bytes = fs::read(self.entry_dir(id).join(name)).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                history_changed()
            } else {
                unreadable(error)
            }
        })?;
        serde_json::from_slice(&bytes).map_err(|_| self.damaged())
    }

    fn damaged(&self) -> RepositoryError {
        RepositoryError::new(
            ErrorKind::UnreadablePath,
            format!(
                "L1 Git cannot read this repository's undo history. Delete {} to start a new one.",
                self.dir.display()
            ),
        )
    }
}

pub(super) fn history_changed() -> RepositoryError {
    RepositoryError::stale(
        StaleReason::HistoryChanged,
        "The undo history changed since L1 Git showed it. Refresh and try again.",
    )
}

impl LockedStore {
    pub(super) fn lock(
        undo_dir: &Path,
        common_dir: &Path,
        deadline: Deadline,
    ) -> Result<Self, RepositoryError> {
        private_dir(undo_dir)?;
        let store = Store::open(undo_dir, common_dir)?;
        private_folder()
            .recursive(true)
            .create(store.dir.join("entries"))
            .map_err(unwritable)?;
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(store.dir.join("lock"))
            .map_err(unwritable)?;
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) if !deadline.remaining().is_zero() => {
                    thread::sleep(LOCK_POLL);
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(RepositoryError::new(
                        ErrorKind::LockHeld,
                        "Another L1 Git is changing this repository's undo history. Try again.",
                    ));
                }
                Err(TryLockError::Error(error)) => return Err(unwritable(error)),
            }
        }
        Ok(Self { store, _lock: lock })
    }

    pub(super) fn settled_log(
        &self,
        opened: &Repo,
        deadline: WriteDeadline,
    ) -> Result<Log, RepositoryError> {
        let mut log = self.log()?;
        if let Some(id) = log.pending {
            log = match self.landed(id, opened, deadline)? {
                Some(change) => {
                    self.write(id, "change.json", &change)?;
                    log.pushed(id)
                }
                None => log.without_pending(),
            };
            self.save(&log)?;
            self.forget(&log);
        }
        for id in log.next_steps() {
            self.remove_copies_a_stopped_step_left(id);
        }
        Ok(log)
    }

    fn remove_copies_a_stopped_step_left(&self, id: EntryId) {
        if let Ok((applied, change)) = self.record_of(id) {
            change.remove_copies_beside(&applied);
        }
    }

    fn landed(
        &self,
        id: EntryId,
        opened: &Repo,
        deadline: WriteDeadline,
    ) -> Result<Option<Change>, RepositoryError> {
        let (applied, change) = self.record_of(id)?;
        if change.keeps_overwritten_files() {
            return Ok(Some(change));
        }
        let entry = self.entry(id);
        if applied.root == opened.root() || change.repository_wide() {
            return change.landed(opened, &entry, deadline);
        }
        match opened.worktree(&applied.root, deadline.reads()) {
            Ok(repo) => change.landed(&repo, &entry, deadline),
            Err(error) if matches!(change, Change::Resolution(_)) => Err(error),
            Err(_) => Ok(None),
        }
    }

    pub(super) fn save(&self, log: &Log) -> Result<(), RepositoryError> {
        let temporary = self.dir.join("log.json.new");
        let bytes = serde_json::to_vec(log).map_err(|error| unwritable(io::Error::other(error)))?;
        fs::write(&temporary, bytes)
            .and_then(|()| fs::rename(&temporary, self.dir.join("log.json")))
            .map_err(unwritable)
    }

    pub(super) fn entry(&self, id: EntryId) -> EntryObjects {
        EntryObjects {
            id,
            objects: self.entry_dir(id).join("objects"),
        }
    }

    pub(super) fn record(
        &self,
        txn: &Txn<'_>,
        log: &Log,
        operation: &Operation,
        change: &Change,
    ) -> Result<(Applied, Recorded<'_>), RepositoryError> {
        let (applied, _, recorded) = self.record_with(txn.repo(), log, operation, |entry| {
            entry.keep(txn, &change.objects())?;
            Ok(change.clone())
        })?;
        Ok((applied, recorded))
    }

    pub(super) fn record_with<C: Clone>(
        &self,
        repo: &Repo,
        log: &Log,
        operation: &Operation,
        fill: impl FnOnce(&EntryObjects) -> Result<C, RepositoryError>,
    ) -> Result<(Applied, C, Recorded<'_>), RepositoryError>
    where
        Change: From<C>,
    {
        let id = EntryId::after(log.entries.last().copied());
        let applied = Applied {
            id,
            root: repo.root(),
            operation: operation.clone(),
        };
        let entry = NewEntry {
            dir: self.entry_dir(id),
            kept: false,
        };
        private_folder().create(&entry.dir).map_err(unwritable)?;
        let change = fill(&self.entry(id))?;
        self.write(id, "applied.json", &applied)?;
        self.write(id, "change.json", &Change::from(change.clone()))?;
        let log = log.with_pending(id);
        self.save(&log)?;
        Ok((
            applied,
            change,
            Recorded {
                store: self,
                id,
                log,
                entry,
            },
        ))
    }

    pub(super) fn remove_traces(&self) -> Result<(), RepositoryError> {
        for entry in fs::read_dir(&self.dir).map_err(unwritable)?.flatten() {
            if entry.file_name().to_string_lossy().starts_with("trace-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        Ok(())
    }

    pub(super) fn new_trace_dir(&self, id: EntryId) -> Result<PathBuf, RepositoryError> {
        let dir = self.dir.join(format!("trace-{id}"));
        private_dir(&dir)?;
        Ok(dir)
    }

    pub(super) fn record_intent(
        &self,
        repo: &Repo,
        log: &Log,
        operation: &Operation,
    ) -> Result<(Applied, Recorded<'_>), RepositoryError> {
        let id = EntryId::after(log.entries.last().copied());
        let applied = Applied {
            id,
            root: repo.root(),
            operation: operation.clone(),
        };
        let entry = NewEntry {
            dir: self.entry_dir(id),
            kept: false,
        };
        private_folder().create(&entry.dir).map_err(unwritable)?;
        self.write(id, "applied.json", &applied)?;
        let log = log.with_pending(id);
        self.save(&log)?;
        Ok((
            applied,
            Recorded {
                store: self,
                id,
                log,
                entry,
            },
        ))
    }

    fn forget(&self, log: &Log) {
        let Ok(names) = fs::read_dir(self.dir.join("entries")) else {
            return;
        };
        for name in names.flatten() {
            let listed = EntryId::try_from(name.file_name().to_string_lossy().into_owned())
                .is_ok_and(|id| log.entries.contains(&id) || log.pending == Some(id));
            if !listed {
                let _ = fs::remove_dir_all(name.path());
            }
        }
    }

    fn write(
        &self,
        id: EntryId,
        name: &str,
        value: &impl Serialize,
    ) -> Result<(), RepositoryError> {
        self.write_file(id, name, value).map_err(unwritable)
    }

    fn write_file(&self, id: EntryId, name: &str, value: &impl Serialize) -> io::Result<()> {
        let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
        let file = self.entry_dir(id).join(name);
        let temporary = self.entry_dir(id).join(format!("{name}.new"));
        fs::write(&temporary, bytes).and_then(|()| fs::rename(&temporary, file))
    }
}

impl Deref for LockedStore {
    type Target = Store;

    fn deref(&self) -> &Store {
        &self.store
    }
}

pub(super) struct Recorded<'s> {
    store: &'s LockedStore,
    id: EntryId,
    log: Log,
    entry: NewEntry,
}

impl Recorded<'_> {
    pub(super) fn complete(
        self,
        runner: &impl Runner,
        change: &Change,
    ) -> Result<(), RepositoryError> {
        self.store.entry(self.id).keep(runner, &change.objects())?;
        self.store.write(self.id, "change.json", change)?;
        self.confirm();
        Ok(())
    }

    pub(super) fn replace(&self, change: &Change) -> io::Result<()> {
        self.store.write_file(self.id, "change.json", change)
    }

    pub(super) fn durable(&self) -> Result<(), RepositoryError> {
        fn sync(path: &Path) -> io::Result<()> {
            if path.is_dir() {
                for child in fs::read_dir(path)? {
                    sync(&child?.path())?;
                }
                #[cfg(unix)]
                File::open(path)?.sync_all()?;
                Ok(())
            } else {
                fs::OpenOptions::new().write(true).open(path)?.sync_all()
            }
        }
        sync(&self.entry.dir).map_err(unwritable)?;
        fs::OpenOptions::new()
            .write(true)
            .open(self.store.dir.join("log.json"))
            .and_then(|file| file.sync_all())
            .map_err(unwritable)?;
        #[cfg(unix)]
        File::open(&self.store.dir)
            .and_then(|file| file.sync_all())
            .map_err(unwritable)?;
        Ok(())
    }

    pub(super) fn confirm_checked(mut self) -> Result<(), RepositoryError> {
        self.entry.kept = true;
        let done = self.log.pushed(self.id);
        self.store.save(&done)?;
        self.store.forget(&done);
        Ok(())
    }

    pub(super) fn stay_pending(mut self) {
        self.entry.kept = true;
    }

    /// Marks the write done once the index holds it. If the log cannot be
    /// saved, it stays pending, and the next locked request keeps it,
    /// because the index holds what it wrote.
    pub(super) fn confirm(mut self) {
        self.entry.kept = true;
        let done = self.log.pushed(self.id);
        if self.store.save(&done).is_ok() {
            self.store.forget(&done);
        }
    }
}

impl Drop for Recorded<'_> {
    fn drop(&mut self) {
        if !self.entry.kept {
            self.entry.kept = self.store.save(&self.log.without_pending()).is_err();
        }
    }
}

struct NewEntry {
    dir: PathBuf,
    kept: bool,
}

impl Drop for NewEntry {
    fn drop(&mut self) {
        if !self.kept {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Log {
    version: u32,
    common_dir: String,
    repository: Identity,
    entries: Vec<EntryId>,
    undone: usize,
    pending: Option<EntryId>,
}

pub(super) enum Position {
    Next(Step),
    AlreadyDone,
    Elsewhere,
}

pub(super) struct Step {
    log: Log,
}

impl Step {
    pub(super) const fn log(&self) -> &Log {
        &self.log
    }
}

impl Log {
    pub(super) fn next_undo(&self) -> Option<EntryId> {
        let at = self.entries.len().checked_sub(self.undone + 1)?;
        self.entries.get(at).copied()
    }

    pub(super) fn next_redo(&self) -> Option<EntryId> {
        let at = self.entries.len().checked_sub(self.undone)?;
        self.entries.get(at).copied()
    }

    fn next_steps(&self) -> impl Iterator<Item = EntryId> {
        [self.next_undo(), self.next_redo()].into_iter().flatten()
    }

    pub(super) fn position(&self, id: EntryId, direction: Direction) -> Position {
        let (next, done) = match direction {
            Direction::Undo => (self.next_undo(), self.next_redo()),
            Direction::Redo => (self.next_redo(), self.next_undo()),
        };
        if next == Some(id) {
            Position::Next(Step {
                log: self.stepped(direction),
            })
        } else if done == Some(id) {
            Position::AlreadyDone
        } else {
            Position::Elsewhere
        }
    }

    fn stepped(&self, direction: Direction) -> Self {
        let undone = match direction {
            Direction::Undo => self.undone + 1,
            Direction::Redo => self.undone - 1,
        };
        Self {
            undone,
            ..self.clone()
        }
    }

    fn with_pending(&self, id: EntryId) -> Self {
        Self {
            pending: Some(id),
            ..self.clone()
        }
    }

    fn without_pending(&self) -> Self {
        Self {
            pending: None,
            ..self.clone()
        }
    }

    fn pushed(&self, id: EntryId) -> Self {
        let mut entries = self.entries[..self.entries.len() - self.undone].to_vec();
        entries.push(id);
        let over = entries.len().saturating_sub(MAX_ENTRIES);
        Self {
            entries: entries.split_off(over),
            undone: 0,
            pending: None,
            ..self.clone()
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct Objects {
    pub(super) tips: Vec<Oid>,
    pub(super) not: Vec<Oid>,
}

impl Objects {
    pub(super) fn exact(tips: Vec<Oid>) -> Self {
        Self {
            tips,
            not: Vec::new(),
        }
    }

    fn revs(&self, tips: &[Oid]) -> Vec<u8> {
        let mut revs = lines(tips);
        if !self.not.is_empty() {
            revs.extend(b"--not\n");
            revs.extend(lines(&self.not));
        }
        revs
    }
}

pub(super) struct EntryObjects {
    id: EntryId,
    objects: PathBuf,
}

impl EntryObjects {
    pub(super) const fn id(&self) -> EntryId {
        self.id
    }

    pub(super) fn files(&self) -> PathBuf {
        self.objects.with_file_name("files")
    }

    pub(super) fn keep(
        &self,
        runner: &impl Runner,
        objects: &Objects,
    ) -> Result<(), RepositoryError> {
        let tips = if self.objects.exists() {
            missing(runner, Some(&self.objects), &objects.tips)?
        } else {
            objects.tips.clone()
        };
        if tips.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(self.objects.join("pack")).map_err(unwritable)?;
        let base = pack_base(&self.objects);
        runner
            .git(&["pack-objects", "--revs", "-q", &base])
            .object_directory(&self.objects)
            .alternate_object_directory(&runner.repo().objects)
            .input(objects.revs(&tips))
            .run(runner.deadline())?
            .succeeded()?;
        Ok(())
    }

    /// `update-index --index-info` accepts an object that does not exist, so
    /// this copies back whichever tips the repository lacks, as after a
    /// `gc --prune=now` there.
    pub(super) fn bring_back(
        &self,
        runner: &impl Runner,
        objects: &Objects,
    ) -> Result<(), RepositoryError> {
        let missing = missing(runner, None, &objects.tips)?;
        if missing.is_empty() {
            return Ok(());
        }
        let base = pack_base(&runner.repo().objects);
        runner
            .git(&["pack-objects", "--revs", "-q", &base])
            .alternate_object_directory(&self.objects)
            .input(objects.revs(&missing))
            .run(runner.deadline())?
            .succeeded()?;
        Ok(())
    }

    pub(super) fn keep_branch(
        &self,
        runner: &impl Runner,
        tip: &Oid,
        name: &str,
    ) -> Result<(), RepositoryError> {
        let exclude = format!("--exclude={name}");
        self.keep_unique(runner, tip, &[&exclude, LASTING_REFS[0], LASTING_REFS[1]])
    }

    pub(super) fn keep_left_behind(
        &self,
        runner: &impl Runner,
        tip: &Oid,
        except_branch: Option<&str>,
    ) -> Result<(), RepositoryError> {
        let exclude = except_branch.map(|name| format!("--exclude={name}"));
        let mut not: Vec<&str> = exclude.iter().map(String::as_str).collect();
        not.extend(CHECKOUT_TRUSTED_REFS);
        self.keep_unique(runner, tip, &not)
    }

    fn keep_unique(
        &self,
        runner: &impl Runner,
        tip: &Oid,
        not: &[&str],
    ) -> Result<(), RepositoryError> {
        let tips = std::slice::from_ref(tip);
        if self.objects.exists() && missing(runner, Some(&self.objects), tips)?.is_empty() {
            return Ok(());
        }
        let mut args = vec![
            "rev-list",
            "--objects",
            "--missing=allow-promisor",
            tip.as_str(),
            "--not",
        ];
        args.extend(not);
        let listed = runner
            .git(&args)
            .uncapped()
            .run(runner.deadline())?
            .succeeded()?;
        if listed.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(self.objects.join("pack")).map_err(unwritable)?;
        let base = pack_base(&self.objects);
        runner
            .git(&["pack-objects", "-q", &base])
            .object_directory(&self.objects)
            .alternate_object_directory(&runner.repo().objects)
            .input(listed)
            .run(runner.deadline())?
            .succeeded()?;
        Ok(())
    }

    pub(super) fn keep_stash(
        &self,
        runner: &impl Runner,
        tip: &Oid,
    ) -> Result<(), RepositoryError> {
        self.keep_unique(runner, tip, &["--branches", "--tags"])
    }

    pub(super) fn keep_tag(
        &self,
        runner: &impl Runner,
        tip: &Oid,
        name: &str,
    ) -> Result<(), RepositoryError> {
        let exclude = format!("--exclude={name}");
        self.keep_unique(runner, tip, &[LASTING_REFS[0], &exclude, LASTING_REFS[1]])
    }

    pub(super) fn bring_back_tip(
        &self,
        runner: &impl Runner,
        tip: &Oid,
        noun: &str,
    ) -> Result<(), RepositoryError> {
        let mut present = runner.git(&["cat-file", "-e", tip.as_str()]);
        let mut list = runner.git(&[
            "rev-list",
            "--objects",
            "--missing=allow-promisor",
            tip.as_str(),
            "--not",
            "--all",
        ]);
        if self.objects.exists() {
            present = present.alternate_object_directory(&self.objects);
            list = list.alternate_object_directory(&self.objects);
        }
        let lost = || {
            RepositoryError::new(
                ErrorKind::GitFailed,
                format!(
                    "Git no longer has some of this {noun}'s commits, and L1 Git's undo store does not hold them, so nothing changed. A branch, tag, or remote-tracking branch that shared them was likely deleted outside L1 Git and its commits pruned."
                ),
            )
        };
        // rev-list skips a missing tip under --missing=allow-promisor.
        if present.run(runner.deadline())?.code() != Some(0) {
            return Err(lost());
        }
        let listed = list.uncapped().run(runner.deadline())?;
        if listed.code() != Some(0) {
            return Err(lost());
        }
        let reached = listed
            .stdout()
            .split(|byte| *byte == b'\n')
            .filter_map(|line| line.split(|byte| *byte == b' ').next())
            .filter(|oid| !oid.is_empty())
            .map(|oid| Oid::try_from(String::from_utf8_lossy(oid).into_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| crate::git::malformed())?;
        let lacking = missing(runner, None, &reached)?;
        if lacking.is_empty() {
            return Ok(());
        }
        let base = pack_base(&runner.repo().objects);
        runner
            .git(&["pack-objects", "-q", &base])
            .alternate_object_directory(&self.objects)
            .input(lines(&lacking))
            .run(runner.deadline())?
            .succeeded()?;
        Ok(())
    }
}

/// The refs whose objects a branch's undo entry need not keep. A fetch with
/// `--prune` drops remote-tracking refs, and a checkout moves HEAD.
const LASTING_REFS: [&str; 2] = ["--branches", "--tags"];

const CHECKOUT_TRUSTED_REFS: [&str; 3] = ["--branches", "--tags", "--remotes"];

/// What `pack-objects` names its pack after in an object directory.
fn pack_base(objects: &Path) -> String {
    objects
        .join("pack")
        .join("pack")
        .to_string_lossy()
        .into_owned()
}

fn missing(
    runner: &impl Runner,
    store: Option<&Path>,
    oids: &[Oid],
) -> Result<Vec<Oid>, RepositoryError> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut check = runner.git(&["cat-file", "--batch-check=%(objectname)"]);
    if let Some(store) = store {
        check = check.object_directory(store);
    }
    let found = check
        .input(lines(oids))
        .uncapped()
        .run(runner.deadline())?
        .succeeded()?;
    let named: BTreeSet<&[u8]> = found
        .split(|byte| *byte == b'\n')
        .filter_map(|answer| answer.strip_suffix(b" missing"))
        .collect();
    Ok(oids
        .iter()
        .filter(|oid| named.contains(oid.as_str().as_bytes()))
        .cloned()
        .collect())
}

fn lines(oids: &[Oid]) -> Vec<u8> {
    oids.iter()
        .flat_map(|oid| oid.as_str().bytes().chain([b'\n']))
        .collect()
}

pub(super) fn private_folder() -> fs::DirBuilder {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    builder
}

fn private_dir(dir: &Path) -> Result<(), RepositoryError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        private_folder()
            .recursive(true)
            .create(dir)
            .map_err(unwritable)?;
        let metadata = fs::metadata(dir).map_err(unwritable)?;
        // SAFETY: geteuid(2) takes no arguments and cannot fail.
        let user = unsafe { libc::geteuid() };
        if metadata.uid() != user || metadata.mode() & 0o022 != 0 {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                format!(
                    "L1 Git keeps undo history only in a folder that you own and others cannot write. {} is not one.",
                    dir.display()
                ),
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir).map_err(unwritable)
    }
}

pub(super) fn unwritable(error: io::Error) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        format!("L1 Git could not write its undo history, so it made no change: {error}"),
    )
}

fn unreadable(error: io::Error) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnreadablePath,
        format!("L1 Git could not read its undo history: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(entries: u64, undone: usize) -> Log {
        Log {
            version: VERSION,
            common_dir: String::new(),
            repository: Identity {
                device: 0,
                inode: 0,
                created: None,
            },
            entries: (1..=entries).map(EntryId).collect(),
            undone,
            pending: None,
        }
    }

    #[test]
    fn a_new_entry_drops_the_redo_entries_then_the_oldest_past_the_cap() {
        assert_eq!(
            log(5, 2).pushed(EntryId(9)).entries,
            [1, 2, 3, 9].map(EntryId)
        );
        let full = log(100, 0).pushed(EntryId(200)).entries;
        assert_eq!(full.len(), MAX_ENTRIES);
        assert_eq!(full.first(), Some(&EntryId(2)));
        assert_eq!(full.last(), Some(&EntryId(200)));
    }

    #[test]
    fn undo_and_redo_walk_one_cursor() {
        let history = log(3, 1);
        assert_eq!(history.next_undo(), Some(EntryId(2)));
        assert_eq!(history.next_redo(), Some(EntryId(3)));
        assert!(matches!(
            history.position(EntryId(3), Direction::Undo),
            Position::AlreadyDone
        ));
        assert!(matches!(
            history.position(EntryId(2), Direction::Undo),
            Position::Next(_)
        ));
        assert!(matches!(
            history.position(EntryId(1), Direction::Redo),
            Position::Elsewhere
        ));
        let all = log(2, 2);
        assert_eq!(all.next_undo(), None);
        assert_eq!(all.stepped(Direction::Redo).next_undo(), Some(EntryId(1)));
    }
}
