use super::{
    Coordinator,
    create::{file_in_the_way, runnable, unusable_location},
    lock_ignoring_poison,
    remote::validate_endpoint,
};
use crate::{
    ErrorKind, NewRepository, RepositoryError,
    directories::resolved_target,
    git::{self, Captured, Mutation, Stoppable},
    stderr,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

/// A clone source, which may carry credentials, so it never reaches a log.
#[derive(Deserialize)]
#[serde(transparent)]
pub struct CloneUrl(pub String);

impl fmt::Debug for CloneUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Each running clone's stop flag, by resolved target path.
#[derive(Default)]
pub(super) struct Clones(Mutex<HashMap<PathBuf, Arc<AtomicBool>>>);

struct RunningClone<'a> {
    clones: &'a Clones,
    key: PathBuf,
    stop: Arc<AtomicBool>,
}

impl Clones {
    fn begin(&self, target: &Path) -> Result<RunningClone<'_>, RepositoryError> {
        let key = resolved_target(target);
        let mut running = lock_ignoring_poison(&self.0);
        if running.contains_key(&key) {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                "L1 Git is already cloning into this location. Choose another location.",
            ));
        }
        let stop = Arc::new(AtomicBool::new(false));
        running.insert(key.clone(), Arc::clone(&stop));
        Ok(RunningClone {
            clones: self,
            key,
            stop,
        })
    }
}

impl Drop for RunningClone<'_> {
    fn drop(&mut self) {
        lock_ignoring_poison(&self.clones.0).remove(&self.key);
    }
}

/// What a clone may replace at its target, so that stopping it removes only
/// what it created.
enum Before {
    Missing,
    EmptyFolder,
}

fn before_clone(target: &Path) -> Result<Before, RepositoryError> {
    let refused = |message: &str| RepositoryError::new(ErrorKind::UnsupportedPath, message);
    match target.metadata() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Before::Missing),
        Err(_) => Err(unusable_location()),
        Ok(found) if !found.is_dir() => Err(file_in_the_way()),
        Ok(_) => {
            let unreadable = |_| refused("L1 Git cannot read this folder. Check its permissions.");
            if fs::read_dir(target).map_err(unreadable)?.next().is_some() {
                return Err(refused(
                    "This folder already exists and is not empty. Choose another location.",
                ));
            }
            Ok(Before::EmptyFolder)
        }
    }
}

fn cancelled() -> RepositoryError {
    RepositoryError::new(ErrorKind::GitFailed, "The clone was cancelled.")
}

fn remove_partial(target: &Path, before: &Before) -> io::Result<()> {
    let removed = match before {
        Before::Missing => fs::remove_dir_all(target),
        Before::EmptyFolder => fs::read_dir(target).and_then(|entries| {
            entries.into_iter().try_for_each(|entry| {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    fs::remove_dir_all(entry.path())
                } else {
                    fs::remove_file(entry.path())
                }
            })
        }),
    };
    match removed {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

impl Coordinator {
    /// Clones `url` into an absolute `target` that does not exist or is an
    /// empty folder, creating missing folders. It takes a network slot, and
    /// `cancel_clone` stops it while it waits for one or runs.
    pub fn clone_repository(
        &self,
        url: &str,
        target: &Path,
    ) -> Result<NewRepository, RepositoryError> {
        validate_endpoint(url)?;
        let running = self.clones.begin(target)?;
        let Some(_slot) = self.slots.acquire_unless(&running.stop) else {
            return Err(cancelled());
        };
        let before = before_clone(target)?;
        let (nearest, path) = runnable(target)?;
        let deadline = self.limits.clone_deadline;
        let stopped = |kind: ErrorKind, reason: String| {
            let left = match remove_partial(target, &before) {
                Ok(()) => "",
                Err(_) => " L1 Git could not remove what it had copied so far.",
            };
            RepositoryError::new(kind, format!("{reason}{left}"))
        };
        match git::capture_until(
            nearest,
            Mutation::Clone { url, target: path },
            deadline,
            &running.stop,
        )? {
            Stoppable::Ran(Captured::Completed { success: true, .. }) => Ok(NewRepository {
                path: path.to_owned(),
            }),
            Stoppable::Ran(Captured::Completed { stderr, .. }) => Err(RepositoryError::new(
                ErrorKind::GitFailed,
                stderr::summarize(&stderr),
            )),
            Stoppable::Ran(Captured::TimedOut) => Err(stopped(
                ErrorKind::TimedOut,
                format!(
                    "Cloning took longer than {} seconds, so L1 Git stopped Git. Retry on a faster connection.",
                    deadline.as_secs()
                ),
            )),
            Stoppable::Stopped => {
                let error = cancelled();
                Err(stopped(error.kind, error.message))
            }
        }
    }

    /// Stops the clone running into `target`, if there is one.
    pub fn cancel_clone(&self, target: &Path) {
        if let Some(stop) = lock_ignoring_poison(&self.clones.0).get(&resolved_target(target)) {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Limits, Semaphore};
    use super::*;
    use std::{
        num::NonZeroUsize,
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    const PATIENCE: Duration = Duration::from_secs(5);

    #[test]
    fn cancelling_a_clone_that_waits_for_a_slot_frees_its_location() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let core = Arc::new(Coordinator::new(Limits::default(), base.join("undo")));
        let held: Vec<_> = (0..core.limits.network_slots.get())
            .map(|_| core.slots.acquire())
            .collect();
        let target = base.join("waiting");
        let (sent, finished) = mpsc::channel();
        let (worker, to) = (Arc::clone(&core), target.clone());
        thread::spawn(move || {
            sent.send(worker.clone_repository("https://example.test/app.git", &to))
                .unwrap();
        });
        let started = Instant::now();
        while lock_ignoring_poison(&core.clones.0).is_empty() {
            assert!(started.elapsed() < PATIENCE, "the clone never registered");
            thread::sleep(Duration::from_millis(1));
        }

        core.cancel_clone(&target);

        let error = finished.recv_timeout(PATIENCE).unwrap().unwrap_err();
        assert!(error.message.contains("cancelled"), "{}", error.message);
        assert!(!target.exists(), "Git never ran");
        assert!(lock_ignoring_poison(&core.clones.0).is_empty());
        drop(held);
    }

    #[test]
    fn a_cancelled_wait_passes_a_released_slot_to_the_next_waiter() {
        for _ in 0..20 {
            let slots = Arc::new(Semaphore::new(NonZeroUsize::MIN));
            let stop = Arc::new(AtomicBool::new(false));
            let held = slots.acquire();
            let (cancelling, flag) = (Arc::clone(&slots), Arc::clone(&stop));
            thread::spawn(move || assert!(cancelling.acquire_unless(&flag).is_none()));
            thread::sleep(Duration::from_millis(5));
            let (acquired, next) = mpsc::channel();
            let waiting = Arc::clone(&slots);
            thread::spawn(move || {
                let _slot = waiting.acquire();
                acquired.send(()).unwrap();
            });
            thread::sleep(Duration::from_millis(5));
            stop.store(true, Ordering::SeqCst);
            drop(held);
            next.recv_timeout(PATIENCE)
                .expect("the next waiter never woke");
        }
    }
}
