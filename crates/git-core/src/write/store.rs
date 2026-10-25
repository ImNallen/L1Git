use super::{Applied, Change, Direction, EntryId, Operation, Repo, txn::Txn};
use crate::{
    ErrorKind, Oid, RepositoryError, StaleReason,
    git::{Deadline, WriteDeadline},
};
use serde::{Deserialize, Serialize};
use std::{
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
        #[cfg(not(unix))]
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

    /// The history of this repository. A log that an earlier repository at
    /// the same path left reads as empty.
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
        fs::create_dir_all(store.dir.join("entries")).map_err(unwritable)?;
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

    /// The log with a write that a crash left between its record and its
    /// publish settled: kept when the index holds what the write wrote,
    /// dropped otherwise.
    pub(super) fn settled_log(&self, deadline: WriteDeadline) -> Result<Log, RepositoryError> {
        let log = self.log()?;
        let Some(id) = log.pending else {
            return Ok(log);
        };
        let settled = if self.landed(id, deadline)? {
            log.pushed(id)
        } else {
            log.without_pending()
        };
        self.save(&settled)?;
        self.forget(&settled);
        Ok(settled)
    }

    fn landed(&self, id: EntryId, deadline: WriteDeadline) -> Result<bool, RepositoryError> {
        let Ok((applied, change)) = self.record_of(id) else {
            return Ok(false);
        };
        let Ok(repo) = Repo::open(&applied.root, deadline.reads()) else {
            return Ok(false);
        };
        if repo.common_dir.to_string_lossy() != self.common_dir {
            return Ok(false);
        }
        change.landed(&repo, deadline)
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
            objects: self.entry_dir(id).join("objects"),
        }
    }

    /// Writes the entry and saves the log with the entry pending, so the
    /// history names the write before the index changes.
    pub(super) fn record(
        &self,
        txn: &Txn<'_>,
        log: &Log,
        operation: &Operation,
        change: &Change,
    ) -> Result<Recorded<'_>, RepositoryError> {
        let id = EntryId::after(log.entries.last().copied());
        let applied = Applied {
            id,
            root: txn.repo().root(),
            operation: operation.clone(),
        };
        let mut entry = NewEntry {
            dir: self.entry_dir(id),
            kept: false,
        };
        fs::create_dir(&entry.dir).map_err(unwritable)?;
        self.entry(id).keep(txn, &change.objects())?;
        self.write(id, "applied.json", &applied)?;
        self.write(id, "change.json", change)?;
        let pending = log.with_pending(id);
        self.save(&pending)?;
        entry.kept = true;
        Ok(Recorded {
            store: self,
            log: pending,
            applied,
            entry,
        })
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
        let bytes =
            serde_json::to_vec(value).map_err(|error| unwritable(io::Error::other(error)))?;
        fs::write(self.entry_dir(id).join(name), bytes).map_err(unwritable)
    }
}

impl Deref for LockedStore {
    type Target = Store;

    fn deref(&self) -> &Store {
        &self.store
    }
}

/// A write the log names as pending. Dropped unconfirmed, as when the index
/// could not be replaced, it takes the write back out of the log.
pub(super) struct Recorded<'s> {
    store: &'s LockedStore,
    log: Log,
    applied: Applied,
    entry: NewEntry,
}

impl Recorded<'_> {
    /// Marks the write done once the index holds it. If the log cannot be
    /// saved, it stays pending, and the next locked request keeps it,
    /// because the index holds what it wrote.
    pub(super) fn confirm(mut self) -> Applied {
        let id = self.applied.id;
        let done = self.log.pushed(id);
        if self.store.save(&done).is_ok() {
            self.store.forget(&done);
        }
        self.log = done;
        self.entry.kept = true;
        self.applied.clone()
    }
}

impl Drop for Recorded<'_> {
    fn drop(&mut self) {
        if self.log.pending.is_some() {
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
    /// A write recorded but not yet known to have reached the index.
    pending: Option<EntryId>,
}

/// Where an entry sits for one direction. Only `Next` carries the log a
/// step leaves, so only the entry the log names next can be stepped.
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

    /// The log after `id` is done: the redo entries go, and past the cap the
    /// oldest.
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

pub(super) struct EntryObjects {
    objects: PathBuf,
}

impl EntryObjects {
    fn keep(&self, txn: &Txn<'_>, oids: &[Oid]) -> Result<(), RepositoryError> {
        if oids.is_empty() {
            return Ok(());
        }
        let pack = self.objects.join("pack");
        fs::create_dir_all(&pack).map_err(unwritable)?;
        let base = pack.join("pack").to_string_lossy().into_owned();
        txn.git(&["pack-objects", "-q", &base])
            .objects(&self.objects)
            .alternates(&txn.repo().objects)
            .input(lines(oids))
            .run(txn.deadline())?
            .succeeded()?;
        Ok(())
    }

    /// Copies back whichever of `oids` the repository lacks, as after a
    /// `gc --prune=now` there, because `update-index --index-info` accepts an
    /// object that does not exist and would leave a broken index. Git names
    /// each missing object in its answer, so the answer is read by name.
    pub(super) fn bring_back(&self, txn: &Txn<'_>, oids: Vec<Oid>) -> Result<(), RepositoryError> {
        if oids.is_empty() {
            return Ok(());
        }
        let found = txn
            .git(&["cat-file", "--batch-check=%(objectname)"])
            .input(lines(&oids))
            .uncapped()
            .run(txn.deadline())?
            .succeeded()?;
        let missing: Vec<Oid> = found
            .split(|byte| *byte == b'\n')
            .filter_map(|answer| answer.strip_suffix(b" missing"))
            .filter_map(|name| oids.iter().find(|oid| oid.as_str().as_bytes() == name))
            .cloned()
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        let base = txn
            .repo()
            .objects
            .join("pack")
            .join("pack")
            .to_string_lossy()
            .into_owned();
        txn.git(&["pack-objects", "-q", &base])
            .alternates(&self.objects)
            .input(lines(&missing))
            .run(txn.deadline())?
            .succeeded()?;
        Ok(())
    }
}

fn lines(oids: &[Oid]) -> Vec<u8> {
    oids.iter()
        .flat_map(|oid| oid.as_str().bytes().chain([b'\n']))
        .collect()
}

fn private_dir(dir: &Path) -> Result<(), RepositoryError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
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

fn unwritable(error: io::Error) -> RepositoryError {
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
