use std::io::{self, Read};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const STDERR_TAIL: usize = 8 * 1024;

pub(crate) struct Ran {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr_tail: String,
}

#[derive(Debug)]
pub(crate) enum RunError {
    NotFound,
    TimedOut,
    TooLarge,
    Io(io::Error),
}

enum Pipe {
    Stdout(io::Result<Option<Vec<u8>>>),
    Stderr(io::Result<String>),
}

/// Runs a short command with no stdin. On Unix it gets its own process group,
/// so a deadline also stops what it started, such as the macOS `security`
/// helper holding a keychain prompt.
pub(crate) fn run(mut command: Command, deadline: Duration, cap: usize) -> Result<Ran, RunError> {
    let started = Instant::now();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => RunError::NotFound,
        _ => RunError::Io(error),
    })?;
    let (sender, receiver) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut kept = Vec::new();
            let read = stdout
                .by_ref()
                .take(cap as u64 + 1)
                .read_to_end(&mut kept)
                .map(|_| (kept.len() <= cap).then_some(kept));
            let _ = sender.send(Pipe::Stdout(read));
        });
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let _ = sender.send(Pipe::Stderr(tail(stderr)));
        });
    }
    let (mut stdout, mut stderr) = (None, None);
    while stdout.is_none() || stderr.is_none() {
        let left = deadline.saturating_sub(started.elapsed());
        match receiver.recv_timeout(left) {
            Ok(Pipe::Stdout(Ok(Some(bytes)))) => stdout = Some(bytes),
            Ok(Pipe::Stdout(Ok(None))) => return Err(stop(child, RunError::TooLarge)),
            Ok(Pipe::Stderr(Ok(text))) => stderr = Some(text),
            Ok(Pipe::Stdout(Err(error)) | Pipe::Stderr(Err(error))) => {
                return Err(stop(child, RunError::Io(error)));
            }
            Err(_) => return Err(stop(child, RunError::TimedOut)),
        }
    }
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return Ok(Ran {
                    stdout: stdout.unwrap_or_default(),
                    stderr_tail: stderr.unwrap_or_default(),
                });
            }
            Ok(None) if started.elapsed() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => return Err(stop(child, RunError::TimedOut)),
            Err(error) => return Err(stop(child, RunError::Io(error))),
        }
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn tail(mut pipe: impl Read) -> io::Result<String> {
    let mut kept = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let read = pipe.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        kept.extend_from_slice(&buffer[..read]);
        if kept.len() > 2 * STDERR_TAIL {
            kept.drain(..kept.len() - STDERR_TAIL);
        }
    }
    let start = kept.len().saturating_sub(STDERR_TAIL);
    Ok(String::from_utf8_lossy(&kept[start..]).into_owned())
}

/// The child is still unreaped here, so its pid still names its process group.
/// Another thread reaps it, in case it is stuck in the kernel.
fn stop(mut child: Child, error: RunError) -> RunError {
    #[cfg(unix)]
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: kill(2) takes no pointers. The group is this unreaped child's.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    let _ = child.kill();
    thread::spawn(move || child.wait());
    error
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    fn alive(pid: libc::pid_t) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn deadline_kills_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let started = Instant::now();
        let result = run(
            sh(&format!(
                "sleep 60 & echo $! > '{}'; wait",
                pidfile.display()
            )),
            Duration::from_millis(300),
            1024,
        );
        assert!(
            matches!(result, Err(RunError::TimedOut)),
            "{:?}",
            result.err()
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let grandchild: libc::pid_t = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let gone = Instant::now();
        while alive(grandchild) {
            assert!(
                gone.elapsed() < Duration::from_secs(2),
                "the grandchild outlived the deadline"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn stdin_is_null() {
        let ran = run(sh("cat"), Duration::from_secs(5), 1024).unwrap();
        assert!(ran.stdout.is_empty());
    }

    #[test]
    fn output_over_the_cap_is_too_large() {
        let result = run(sh("yes"), Duration::from_secs(5), 1024);
        assert!(
            matches!(result, Err(RunError::TooLarge)),
            "{:?}",
            result.err()
        );
    }

    #[test]
    fn missing_program_is_not_found() {
        let result = run(
            Command::new("/nonexistent/gh"),
            Duration::from_secs(5),
            1024,
        );
        assert!(
            matches!(result, Err(RunError::NotFound)),
            "{:?}",
            result.err()
        );
    }

    #[test]
    fn keeps_stdout_and_the_tail_of_stderr() {
        let ran = run(
            sh("echo out; i=0; while [ $i -lt 2000 ]; do echo err$i >&2; i=$((i+1)); done; exit 3"),
            Duration::from_secs(5),
            1024,
        )
        .unwrap();
        assert_eq!(ran.stdout, b"out\n");
        assert!(ran.stderr_tail.len() <= STDERR_TAIL);
        assert!(ran.stderr_tail.ends_with("err1999\n"));
    }
}
