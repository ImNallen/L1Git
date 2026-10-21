use std::io;

/// What SIGQUIT does once Git is stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnQuit {
    /// Dies by SIGQUIT, as a command-line program should.
    Raise,
    /// Exits with status 131. A macOS app that dies by SIGQUIT is reported as
    /// a crash.
    Exit,
}

/// Stops Git before SIGINT, SIGTERM, SIGHUP, or SIGQUIT ends this process.
/// Git runs in its own process groups, so a signal sent to a terminal's group
/// never reaches it. The handler only writes the signal to a pipe. A thread
/// reads it, runs `stop_all_git`, and raises the signal again with its default
/// action, so a parent sees this process die by that signal, except as
/// `quit` says for SIGQUIT. No signal is blocked, so Git starts with none
/// blocked, and a signal ignored when this process started, as under `nohup`,
/// stays ignored.
#[cfg(unix)]
pub fn stop_git_on_exit_signals(quit: OnQuit) -> io::Result<()> {
    use std::{fs::File, io::Read, os::fd::FromRawFd, thread};

    let mut ends = [0; 2];
    // SAFETY: `ends` has room for the two descriptors pipe(2) writes.
    if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: pipe(2) returned this descriptor, and nothing else owns it.
    let mut read_end = unsafe { File::from_raw_fd(ends[0]) };
    for end in ends {
        // SAFETY: `end` is a descriptor pipe(2) just returned.
        unsafe { libc::fcntl(end, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    // SAFETY: as above. A full pipe then drops a signal instead of blocking
    // the thread the handler interrupted.
    unsafe {
        let flags = libc::fcntl(ends[1], libc::F_GETFL);
        libc::fcntl(ends[1], libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    WRITE_END.store(ends[1], Ordering::Relaxed);
    thread::spawn(move || {
        let mut signal = [0];
        if read_end.read_exact(&mut signal).is_err() {
            return;
        }
        crate::stop_all_git();
        let signal = libc::c_int::from(signal[0]);
        if signal == libc::SIGQUIT && quit == OnQuit::Exit {
            std::process::exit(128 + signal);
        }
        // SAFETY: signal(2) and raise(3) take no pointers. The default action
        // of each handled signal ends the process.
        unsafe {
            libc::signal(signal, libc::SIG_DFL);
            libc::raise(signal);
        }
        std::process::exit(128 + signal);
    });
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGQUIT] {
        // SAFETY: `sigaction` is plain data that sigaction(2) fills in.
        let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
        // SAFETY: `current` is valid and writable for the call.
        if unsafe { libc::sigaction(signal, std::ptr::null(), &mut current) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if current.sa_sigaction == libc::SIG_IGN {
            continue;
        }
        // SAFETY: as above.
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = record as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        // SAFETY: `action` is valid for the call, and `record` calls only
        // async-signal-safe functions.
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn stop_git_on_exit_signals(_quit: OnQuit) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
use std::sync::atomic::{AtomicI32, Ordering};

#[cfg(unix)]
static WRITE_END: AtomicI32 = AtomicI32::new(-1);

#[cfg(unix)]
extern "C" fn record(signal: libc::c_int) {
    let byte = signal as u8;
    let errno = errno();
    // SAFETY: write(2) is async-signal-safe, `byte` outlives the call, and
    // `errno` points at this thread's errno.
    unsafe {
        let saved = *errno;
        libc::write(
            WRITE_END.load(Ordering::Relaxed),
            (&raw const byte).cast(),
            1,
        );
        *errno = saved;
    }
}

#[cfg(any(target_os = "linux", target_os = "emscripten"))]
fn errno() -> *mut libc::c_int {
    // SAFETY: returns this thread's errno location and has no preconditions.
    unsafe { libc::__errno_location() }
}

#[cfg(any(target_os = "android", target_os = "netbsd", target_os = "openbsd"))]
fn errno() -> *mut libc::c_int {
    // SAFETY: returns this thread's errno location and has no preconditions.
    unsafe { libc::__errno() }
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "emscripten",
        target_os = "android",
        target_os = "netbsd",
        target_os = "openbsd"
    ))
))]
fn errno() -> *mut libc::c_int {
    // SAFETY: returns this thread's errno location and has no preconditions.
    unsafe { libc::__error() }
}
