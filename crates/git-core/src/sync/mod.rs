mod advance;
mod fetch;
mod locks;
use locks::Locks;
mod push;
mod read;
mod remote;
pub use push::{
    PublishChoice, PublishOptions, PublishRemote, PublishRemoteAvailability, PushAvailability,
    PushIntent, PushOutcome, PushPurpose, PushRefresh, PushReport, PushUnavailable,
    TrackingOutcome,
};
pub use remote::{AddRemote, AddRemoteRefresh, AddRemoteReport};

pub(crate) use advance::is_at;
pub(crate) use read::in_progress;

use crate::{
    Advance, AdvanceOutcome, FastForwardReport, FetchMode, FetchSummary, RepositoryError,
    RepositoryOverview, SkipReason,
    git::{Deadline, LocalRead, LocalWrite, WriteDeadline},
};
use std::{
    collections::HashMap,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How long one remote may take to fetch.
    pub fetch_deadline: Duration,
    /// How long one ordinary push may take.
    pub push_deadline: Duration,
    /// How long a probe, ref move, or worktree fast-forward may take. A partial
    /// clone downloads blobs during the fast-forward.
    pub local_deadline: Duration,
    /// Remote operations that may run at once across all repositories.
    pub network_slots: NonZeroUsize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            fetch_deadline: Duration::from_secs(300),
            push_deadline: Duration::from_secs(300),
            local_deadline: Duration::from_secs(120),
            network_slots: NonZeroUsize::new(4).unwrap(),
        }
    }
}

/// Owns every Git command that contacts a remote, moves a ref, or writes, and
/// the undo history. Keep one per process. Per Git common dir it runs at most
/// one fetch, push, fast-forward, or config addition at a time (the gate) and at
/// most one write, undo, redo, ref move, or config addition at a time (the write
/// lock). Ordinary writes never take the gate, so they never wait for a fetch.
/// Push, fast-forward, and config addition take the gate before the write lock.
/// At most `network_slots`
/// remote operations run at once. Local reads take no lock. An index refresh
/// after a status read holds the write lock only while nothing else wants it.
pub struct Coordinator {
    limits: Limits,
    read_cap: Option<Duration>,
    write_cap: Option<Duration>,
    undo_dir: PathBuf,
    repositories: Repositories,
    refreshes: Arc<Refreshes>,
    slots: Semaphore,
}

type Repositories = Arc<Mutex<HashMap<PathBuf, Arc<Locks>>>>;

#[derive(Default)]
struct Refreshes {
    running: Mutex<usize>,
    finished: Condvar,
}

/// Counts a refresh until its thread ends, even by a panic.
struct Running(Arc<Refreshes>);

impl Drop for Running {
    fn drop(&mut self) {
        *lock_ignoring_poison(&self.0.running) -= 1;
        self.0.finished.notify_all();
    }
}

/// Lets a background refresh take a repository's write lock.
pub(crate) struct Writers(Repositories);

impl Writers {
    /// Runs `work` under the write lock of `common_dir` when nothing holds or
    /// wants that lock. `work` gets a check that turns true once a write, an
    /// undo, or a ref move wants it, so it can stop and let go.
    pub(crate) fn unless_busy<T>(
        &self,
        common_dir: &Path,
        work: impl FnOnce(&dyn Fn() -> bool) -> T,
    ) -> Option<T> {
        let locks = locks_in(&self.0, common_dir);
        let _write = locks.try_write()?;
        let wanted = || locks.wanted();
        (!wanted()).then(|| work(&wanted))
    }
}

#[derive(Default)]
struct Gate {
    last_fetch: Option<(Instant, FetchSummary)>,
}

impl Coordinator {
    /// `undo_dir` holds one undo store per repository. Nothing is created
    /// there until the first write.
    pub fn new(limits: Limits, undo_dir: impl Into<PathBuf>) -> Self {
        Self {
            limits,
            read_cap: None,
            write_cap: None,
            undo_dir: undo_dir.into(),
            repositories: Repositories::default(),
            refreshes: Arc::default(),
            slots: Semaphore::new(limits.network_slots),
        }
    }

    /// Lowers every local read's deadline to at most `cap`. Only tests and the
    /// development bridge use it.
    pub fn cap_reads(self, cap: Duration) -> Self {
        Self {
            read_cap: Some(cap),
            ..self
        }
    }

    /// Lowers every write's deadline to at most `cap`.
    pub fn cap_writes(self, cap: Duration) -> Self {
        Self {
            write_cap: Some(cap),
            ..self
        }
    }

    pub(crate) fn deadline(&self, read: LocalRead) -> Deadline {
        Deadline::start(read, capped(read.budget(), self.read_cap))
    }

    pub(crate) fn write_deadline(&self, write: LocalWrite) -> WriteDeadline {
        WriteDeadline::start(write, capped(write.budget(), self.write_cap))
    }

    pub(crate) fn undo_dir(&self) -> &Path {
        &self.undo_dir
    }

    pub(crate) fn writing<T>(&self, common_dir: &Path, work: impl FnOnce() -> T) -> T {
        let locks = self.locks(common_dir);
        let _write = locks.write_lock();
        work()
    }

    /// Runs `refresh` on its own thread, so the read that asked for it can
    /// answer first.
    pub(crate) fn refresh_later(&self, refresh: impl FnOnce(&Writers) + Send + 'static) {
        *lock_ignoring_poison(&self.refreshes.running) += 1;
        let running = Running(Arc::clone(&self.refreshes));
        let writers = Writers(Arc::clone(&self.repositories));
        let _ = thread::Builder::new().spawn(move || {
            let _running = running;
            refresh(&writers);
        });
    }

    /// Blocks until every index refresh that a status read started has
    /// finished. Only tests use it.
    pub fn wait_for_refreshes(&self) {
        let running = lock_ignoring_poison(&self.refreshes.running);
        drop(
            self.refreshes
                .finished
                .wait_while(running, |running| *running > 0),
        );
    }

    pub(crate) fn gated<T>(&self, common_dir: &Path, work: impl FnOnce() -> T) -> T {
        let locks = self.locks(common_dir);
        let _gate = lock_ignoring_poison(&locks.gate);
        work()
    }

    /// The local branches of the repository containing `path`. With
    /// `FetchMode::Remote`, fetch its remotes first, unless a fetch of the same
    /// repository finished after this call started.
    pub fn overview(
        &self,
        path: &str,
        mode: FetchMode,
    ) -> Result<RepositoryOverview, RepositoryError> {
        let requested = Instant::now();
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let deadline = self.limits.local_deadline;
        if mode == FetchMode::Local {
            return read::read(&repository, None, deadline, reads);
        }
        let locks = self.locks(&repository.common_dir);
        let mut gate = lock_ignoring_poison(&locks.gate);
        let summary = match &gate.last_fetch {
            Some((finished, summary)) if *finished > requested => FetchSummary {
                coalesced: true,
                ..summary.clone()
            },
            _ => {
                let summary = {
                    let _slot = self.slots.acquire();
                    fetch::fetch_all(
                        &repository.root,
                        self.limits.fetch_deadline,
                        reads.renewed(),
                    )?
                };
                gate.last_fetch = Some((Instant::now(), summary.clone()));
                summary
            }
        };
        read::read(&repository, Some(summary), deadline, reads.renewed())
    }

    /// Fast-forwards each requested branch in order, then rereads the repository
    /// before another fetch or fast-forward can start. Each branch moves under
    /// the write lock, so it never interleaves with a write. A branch already at
    /// `to` counts as advanced, so a retry is harmless. An error moving one
    /// branch is reported as that branch's outcome.
    pub fn fast_forward(
        &self,
        path: &str,
        advances: &[Advance],
    ) -> Result<FastForwardReport, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let deadline = self.limits.local_deadline;
        let locks = self.locks(&repository.common_dir);
        let _gate = lock_ignoring_poison(&locks.gate);
        let mut reads = reads.renewed();
        let outcomes = advances
            .iter()
            .map(|request| {
                let _write = locks.write_lock();
                self.guard_merge_refs(
                    &repository.root,
                    &[request.reference.as_str().to_owned()],
                    || advance::advance(&repository.root, request, deadline, &mut reads),
                )
                .unwrap_or_else(|error| AdvanceOutcome::Skipped {
                    reference: request.reference.clone(),
                    reason: SkipReason::Failed {
                        message: error.message,
                    },
                })
            })
            .collect();
        Ok(FastForwardReport {
            outcomes,
            overview: read::read(&repository, None, deadline, reads)?,
        })
    }

    fn locks(&self, common_dir: &Path) -> Arc<Locks> {
        locks_in(&self.repositories, common_dir)
    }
}

fn locks_in(repositories: &Repositories, common_dir: &Path) -> Arc<Locks> {
    Arc::clone(
        lock_ignoring_poison(repositories)
            .entry(common_dir.to_owned())
            .or_default(),
    )
}

fn capped(budget: Duration, cap: Option<Duration>) -> Duration {
    cap.map_or(budget, |cap| cap.min(budget))
}

fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Semaphore {
    free: Mutex<usize>,
    released: Condvar,
}

struct Permit<'a>(&'a Semaphore);

impl Semaphore {
    fn new(slots: NonZeroUsize) -> Self {
        Self {
            free: Mutex::new(slots.get()),
            released: Condvar::new(),
        }
    }

    fn acquire(&self) -> Permit<'_> {
        let mut free = self
            .released
            .wait_while(lock_ignoring_poison(&self.free), |free| *free == 0)
            .unwrap_or_else(PoisonError::into_inner);
        *free -= 1;
        Permit(self)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *lock_ignoring_poison(&self.0.free) += 1;
        self.0.released.notify_one();
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
