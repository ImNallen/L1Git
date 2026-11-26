mod advance;
mod clone;
mod create;
mod fetch;
mod locks;
use locks::Locks;
mod push;
mod read;
mod remote;
pub use clone::CloneUrl;
pub use create::NewRepository;
pub use push::{
    PublishChoice, PublishOptions, PublishRemote, PublishRemoteAvailability, PushAvailability,
    PushIntent, PushOutcome, PushPurpose, PushRefresh, PushReport, PushUnavailable,
    TrackingOutcome,
};
pub use remote::{AddRemote, AddRemoteRefresh, AddRemoteReport};

pub(crate) use advance::is_at;
pub use read::InProgress;
pub(crate) use read::{in_progress, pseudoref_exists};

use crate::{
    Advance, AdvanceOutcome, BranchRef, CommitsFetch, ErrorKind, FastForwardReport, FetchFailure,
    FetchMode, FetchOutcome, FetchSummary, GitHubRepository, Oid, RepositoryError,
    RepositoryOverview, SkipReason, WantedCommits,
    git::{Deadline, LocalRead, LocalWrite, NoHooks, WriteDeadline},
    remotes,
};
use std::{
    collections::HashMap,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, PoisonError, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How long one remote may take to fetch.
    pub fetch_deadline: Duration,
    /// How long a fetch that the operation can do without may take, as
    /// Remove pull request's fetch of the head. One commit by ID needs a few
    /// seconds even over a slow SSH handshake, and Remove that gives up on
    /// it only keeps the branch.
    pub optional_fetch_deadline: Duration,
    /// How long one ordinary push may take.
    pub push_deadline: Duration,
    /// How long a probe, ref move, or worktree fast-forward may take. A partial
    /// clone downloads blobs during the fast-forward.
    pub local_deadline: Duration,
    /// How long cloning a new repository may take.
    pub clone_deadline: Duration,
    /// Remote operations that may run at once across all repositories.
    pub network_slots: NonZeroUsize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            fetch_deadline: Duration::from_secs(300),
            optional_fetch_deadline: Duration::from_secs(15),
            push_deadline: Duration::from_secs(300),
            local_deadline: Duration::from_secs(120),
            clone_deadline: Duration::from_secs(3600),
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
    clones: clone::Clones,
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

/// A branch fetched by its full name moves the remote-tracking ref its fetch
/// refspec maps it to. A commit fetched by id moves no ref.
pub(crate) enum Wanted<'a> {
    Branch(&'a BranchRef),
    Commit(&'a Oid),
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
            clones: clone::Clones::default(),
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
    /// `FetchMode::Remote`, fetch its remotes first, and with
    /// `FetchMode::Branch` only that branch, unless a fetch of every remote of
    /// the same repository finished after this call started.
    pub fn overview(
        &self,
        path: &str,
        mode: FetchMode,
    ) -> Result<RepositoryOverview, RepositoryError> {
        let requested = Instant::now();
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let deadline = self.limits.local_deadline;
        let source = match &mode {
            FetchMode::Local => return read::read(&repository, None, deadline, reads),
            FetchMode::Remote => None,
            FetchMode::Branch(branch) => Some(fetch::source(&repository.root, branch, reads)?),
        };
        let locks = self.locks(&repository.common_dir);
        let mut gate = lock_ignoring_poison(&locks.gate);
        let summary = match (&gate.last_fetch, &source) {
            (Some((finished, summary)), _)
                if *finished > requested
                    && source.as_ref().is_none_or(|source| {
                        summary.remotes.iter().any(|fetched| {
                            fetched.remote == source.remote
                                && fetched.outcome == FetchOutcome::Fetched
                        })
                    }) =>
            {
                FetchSummary {
                    coalesced: true,
                    ..summary.clone()
                }
            }
            (_, Some(source)) => {
                let _slot = self.slots.acquire();
                fetch::fetch_branch(
                    &repository.root,
                    source,
                    self.limits.fetch_deadline,
                    reads.renewed(),
                )?
            }
            (_, None) => {
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

    /// Fetches commits by their ids from the remote that is `github`, so a pull
    /// request from a fork or a deleted branch can be read. No ref moves.
    pub fn fetch_commits(
        &self,
        path: &str,
        github: &GitHubRepository,
        commits: &WantedCommits,
    ) -> Result<CommitsFetch, RepositoryError> {
        self.fetch_commits_by(path, github, commits, None, true)
    }

    /// `fetch_commits` for a write to a pull request's copy, which goes on
    /// without the commits. It gives up once `optional_fetch_deadline` has
    /// passed, the wait for the gate and a network slot included, and runs
    /// no hook.
    pub(crate) fn fetch_optional_commits(
        &self,
        path: &str,
        github: &GitHubRepository,
        commits: &WantedCommits,
    ) -> Result<CommitsFetch, RepositoryError> {
        let until = Instant::now() + self.limits.optional_fetch_deadline;
        self.fetch_commits_by(path, github, commits, Some(until), false)
    }

    fn fetch_commits_by(
        &self,
        path: &str,
        github: &GitHubRepository,
        commits: &WantedCommits,
        until: Option<Instant>,
        run_hooks: bool,
    ) -> Result<CommitsFetch, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let remotes = remotes::read(&repository.root, reads)?;
        let Some(remote) = remotes::of_github(remotes, github) else {
            return Ok(CommitsFetch::NoRemote);
        };
        let locks = self.locks(&repository.common_dir);
        let (Some(_gate), Some(_slot)) = (
            lock_until(&locks.gate, until),
            self.slots.acquire_until(until),
        ) else {
            return Ok(CommitsFetch::Failed {
                failure: FetchFailure::Busy,
                message: format!("Another fetch kept {remote} busy."),
            });
        };
        let deadline = until.map_or(self.limits.fetch_deadline, |until| {
            until.saturating_duration_since(Instant::now())
        });
        let hooks = if run_hooks {
            None
        } else {
            Some(NoHooks::of(&repository.root, reads)?)
        };
        let oids = commits.oids();
        fetch::fetch_commits(&repository.root, &remote, oids, deadline, hooks.as_ref())
    }

    /// Fetches for a write to a pull request's copy, so it runs no hook.
    pub(crate) fn fetch_wanted(
        &self,
        path: &str,
        remote: &str,
        wanted: Wanted<'_>,
    ) -> Result<(), RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let deadline = self.limits.fetch_deadline;
        let hooks = NoHooks::of(&repository.root, reads)?;
        let failure = self.gated(&repository.common_dir, || {
            let _slot = self.slots.acquire();
            Ok::<_, RepositoryError>(match wanted {
                Wanted::Branch(branch) => {
                    match fetch::fetch(
                        &repository.root,
                        remote,
                        Some(branch.as_str()),
                        deadline,
                        Some(&hooks),
                    )? {
                        FetchOutcome::Failed { failure, message } => Some((failure, message)),
                        FetchOutcome::Fetched | FetchOutcome::Skipped => None,
                    }
                }
                Wanted::Commit(oid) => match fetch::fetch_commits(
                    &repository.root,
                    remote,
                    std::slice::from_ref(oid),
                    deadline,
                    Some(&hooks),
                )? {
                    CommitsFetch::Failed { failure, message } => Some((failure, message)),
                    CommitsFetch::Done | CommitsFetch::NoRemote => None,
                },
            })
        })?;
        match failure {
            None => Ok(()),
            Some((failure, message)) => Err(RepositoryError::new(
                if failure == FetchFailure::TimedOut {
                    ErrorKind::TimedOut
                } else {
                    ErrorKind::GitFailed
                },
                format!("L1 Git could not fetch from {remote}. {message}"),
            )),
        }
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

/// Waits for `mutex` until `until`, or for as long as it takes without one.
/// A mutex wakes no waiter at a deadline, so the wait polls.
fn lock_until<T>(mutex: &Mutex<T>, until: Option<Instant>) -> Option<MutexGuard<'_, T>> {
    let Some(until) = until else {
        return Some(lock_ignoring_poison(mutex));
    };
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() >= until => return None,
            Err(TryLockError::WouldBlock) => thread::sleep(STOP_POLL),
        }
    }
}

const STOP_POLL: Duration = Duration::from_millis(20);

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

    /// Waits for a slot until `until`, or for as long as it takes without one.
    fn acquire_until(&self, until: Option<Instant>) -> Option<Permit<'_>> {
        let Some(until) = until else {
            return Some(self.acquire());
        };
        let mut free = lock_ignoring_poison(&self.free);
        while *free == 0 {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            free = self
                .released
                .wait_timeout(free, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        *free -= 1;
        Some(Permit(self))
    }

    /// Waits for a slot until `stop` turns true. Setting `stop` wakes nothing,
    /// so the wait polls it.
    fn acquire_unless(&self, stop: &AtomicBool) -> Option<Permit<'_>> {
        let mut free = lock_ignoring_poison(&self.free);
        loop {
            if stop.load(Ordering::SeqCst) {
                // This wait may hold the wake-up of a slot that it will not take.
                if *free > 0 {
                    self.released.notify_one();
                }
                return None;
            }
            if *free > 0 {
                *free -= 1;
                return Some(Permit(self));
            }
            free = self
                .released
                .wait_timeout(free, STOP_POLL)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *lock_ignoring_poison(&self.0.free) += 1;
        self.0.released.notify_one();
    }
}
