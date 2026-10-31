use super::{Gate, lock_ignoring_poison};
use std::sync::{
    Mutex, MutexGuard, TryLockError,
    atomic::{AtomicUsize, Ordering},
};

/// A repository's locks. The write lock is private so every writer goes
/// through `write_lock`, which a running index refresh watches and stops for.
#[derive(Default)]
pub(super) struct Locks {
    pub(super) gate: Mutex<Gate>,
    write: Mutex<()>,
    wanted: AtomicUsize,
}

impl Locks {
    pub(super) fn write_lock(&self) -> MutexGuard<'_, ()> {
        self.wanted.fetch_add(1, Ordering::SeqCst);
        let write = lock_ignoring_poison(&self.write);
        self.wanted.fetch_sub(1, Ordering::SeqCst);
        write
    }

    pub(super) fn try_write(&self) -> Option<MutexGuard<'_, ()>> {
        match self.write.try_lock() {
            Ok(write) => Some(write),
            Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    pub(super) fn wanted(&self) -> bool {
        self.wanted.load(Ordering::SeqCst) > 0
    }
}
