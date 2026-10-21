mod advance;
mod fetch;
mod read;
mod stderr;

use crate::{
    Advance, AdvanceOutcome, FastForwardReport, FetchMode, FetchSummary, RepositoryError,
    RepositoryOverview, SkipReason,
    git::{Deadline, LocalRead},
};
use std::{
    collections::HashMap,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How long one remote may take to fetch.
    pub fetch_deadline: Duration,
    /// How long a probe, ref move, or worktree fast-forward may take. A partial
    /// clone downloads blobs during the fast-forward.
    pub local_deadline: Duration,
    /// Fetches that may run at once across all repositories.
    pub network_slots: NonZeroUsize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            fetch_deadline: Duration::from_secs(300),
            local_deadline: Duration::from_secs(120),
            network_slots: NonZeroUsize::new(4).unwrap(),
        }
    }
}

/// Owns every Git command that contacts a remote or moves a ref. Keep one per
/// process. It runs at most one fetch or fast-forward per repository at a time
/// and at most `network_slots` fetches at once. Local reads take no lock.
pub struct Coordinator {
    limits: Limits,
    read_cap: Option<Duration>,
    gates: Mutex<HashMap<PathBuf, Arc<Mutex<Gate>>>>,
    slots: Semaphore,
}

#[derive(Default)]
struct Gate {
    last_fetch: Option<(Instant, FetchSummary)>,
}

impl Default for Coordinator {
    fn default() -> Self {
        Self::new(Limits::default())
    }
}

impl Coordinator {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            read_cap: None,
            gates: Mutex::default(),
            slots: Semaphore::new(limits.network_slots),
        }
    }

    /// Lowers every local read's deadline to at most `cap`.
    pub fn cap_reads(self, cap: Duration) -> Self {
        Self {
            read_cap: Some(cap),
            ..self
        }
    }

    pub(crate) fn deadline(&self, read: LocalRead) -> Deadline {
        let budget = read.budget();
        Deadline::start(read, self.read_cap.map_or(budget, |cap| cap.min(budget)))
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
        let gate = self.gate(&repository.common_dir);
        let mut gate = lock_ignoring_poison(&gate);
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
    /// before another fetch or fast-forward can start. A branch already at `to`
    /// counts as advanced, so a retry is harmless. An error moving one branch is
    /// reported as that branch's outcome.
    pub fn fast_forward(
        &self,
        path: &str,
        advances: &[Advance],
    ) -> Result<FastForwardReport, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let deadline = self.limits.local_deadline;
        let gate = self.gate(&repository.common_dir);
        let _gate = lock_ignoring_poison(&gate);
        let outcomes = advances
            .iter()
            .map(|request| {
                advance::advance(&repository.root, request, deadline, reads.renewed())
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
            overview: read::read(&repository, None, deadline, reads.renewed())?,
        })
    }

    fn gate(&self, common_dir: &Path) -> Arc<Mutex<Gate>> {
        Arc::clone(
            lock_ignoring_poison(&self.gates)
                .entry(common_dir.to_owned())
                .or_default(),
        )
    }
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
