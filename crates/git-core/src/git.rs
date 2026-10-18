use crate::{BranchRef, ErrorKind, Oid, RepositoryError};
use std::{
    io::{self, Read},
    path::Path,
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

fn base(path: &Path, lazy_fetch: bool) -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    if !lazy_fetch {
        command.arg("--no-lazy-fetch");
    }
    command
        .args([
            "--no-pager",
            "-c",
            "color.ui=false",
            "-c",
            "log.showSignature=false",
            "-C",
        ])
        .arg(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("LC_ALL", "C");
    command
}

fn command(path: &Path, args: &[&str]) -> Command {
    let mut command = base(path, false);
    command.args(args);
    command
}

fn spawn_error(error: io::Error) -> RepositoryError {
    if error.kind() == io::ErrorKind::NotFound {
        RepositoryError::new(
            ErrorKind::GitMissing,
            "Git is not installed or is not on PATH. Install Git and try again.",
        )
    } else {
        RepositoryError::new(ErrorKind::GitFailed, format!("Could not run Git: {error}"))
    }
}

pub(crate) fn run(path: &Path, args: &[&str]) -> Result<Output, RepositoryError> {
    let output = command(path, args).output().map_err(spawn_error)?;
    if output.status.code() == Some(129)
        && String::from_utf8_lossy(&output.stderr).contains("no-lazy-fetch")
    {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "L1 Git requires Git 2.45 or later. Update Git and try again.",
        ));
    }
    Ok(output)
}

fn read_failed() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        "Git could not read this repository. Check its permissions and missing objects. For a partial clone, fetch the required objects with Git, then refresh.",
    )
}

pub(crate) fn read(path: &Path, args: &[&str]) -> Result<Vec<u8>, RepositoryError> {
    let output = run(path, args)?;
    if !output.status.success() {
        return Err(read_failed());
    }
    Ok(output.stdout)
}

pub(crate) enum Capped {
    Within(Vec<u8>),
    Over(u64),
}

pub(crate) fn read_capped(
    path: &Path,
    args: &[&str],
    cap: usize,
) -> Result<Capped, RepositoryError> {
    let mut child = command(path, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(spawn_error)?;
    let mut stdout = child.stdout.take().ok_or_else(read_failed)?;
    let mut kept = Vec::new();
    (&mut stdout)
        .take(cap as u64 + 1)
        .read_to_end(&mut kept)
        .map_err(|_| read_failed())?;
    let rest = io::copy(&mut stdout, &mut io::sink()).map_err(|_| read_failed())?;
    if !child.wait().map_err(|_| read_failed())?.success() {
        return Err(read_failed());
    }
    Ok(if kept.len() <= cap {
        Capped::Within(kept)
    } else {
        Capped::Over(kept.len() as u64 + rest)
    })
}

pub(crate) fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub(crate) fn line(bytes: &[u8]) -> String {
    text(bytes.strip_suffix(b"\n").unwrap_or(bytes))
}

pub(crate) fn malformed() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        "Git returned an unreadable record. Check the repository and your Git version.",
    )
}

/// The complete list of Git commands that contact a remote or move a ref. Nothing
/// here can create a merge commit, rebase, push, reset, or check out.
pub(crate) enum Mutation<'a> {
    Fetch {
        remote: &'a str,
    },
    /// Writes nothing. Git's refusals report a branch checked out in any worktree,
    /// including one hidden by a rebase or bisect, which `%(worktreepath)` misses.
    ProbeFastForward {
        branch: &'a BranchRef,
        to: &'a Oid,
    },
}

impl Mutation<'_> {
    fn args(&self) -> Vec<String> {
        let owned = |args: &[&str]| args.iter().map(|arg| (*arg).to_owned()).collect();
        match self {
            Self::Fetch { remote } => owned(&[
                "fetch",
                "--no-write-fetch-head",
                "--no-auto-maintenance",
                "--recurse-submodules=no",
                "--",
                remote,
            ]),
            // The probe reads only this repository, so a ban on the file
            // transport does not apply to it.
            Self::ProbeFastForward { branch, to } => owned(&[
                "-c",
                "protocol.file.allow=always",
                "fetch",
                "--dry-run",
                "--no-write-fetch-head",
                "--no-auto-maintenance",
                "--recurse-submodules=no",
                ".",
                &format!("{}:{}", to.as_str(), branch.as_str()),
            ]),
        }
    }
}

pub(crate) enum Finished {
    Succeeded,
    Failed { stderr: String },
    TimedOut,
}

const STDERR_CAP: u64 = 64 * 1024;
const POLL: Duration = Duration::from_millis(10);
const STDERR_GRACE: Duration = Duration::from_secs(1);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

/// Runs a mutation with no stdin, no prompts, and a deadline. At the deadline the
/// whole process group dies, so an ssh or credential helper started by Git cannot
/// outlive it.
pub(crate) fn mutate(
    path: &Path,
    mutation: Mutation<'_>,
    deadline: Duration,
) -> Result<Finished, RepositoryError> {
    let mut command = base(path, false);
    command
        .args(mutation.args())
        .env("SSH_ASKPASS", "/usr/bin/false")
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let started = Instant::now();
    let mut child = command.spawn().map_err(spawn_error)?;
    let (sender, receiver) = mpsc::channel();
    if let Some(mut stderr) = child.stderr.take() {
        thread::spawn(move || {
            let mut kept = Vec::new();
            let _ = (&mut stderr).take(STDERR_CAP).read_to_end(&mut kept);
            let _ = io::copy(&mut stderr, &mut io::sink());
            let _ = sender.send(kept);
        });
    }
    loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            RepositoryError::new(ErrorKind::GitFailed, format!("Could not run Git: {error}"))
        })? {
            // A daemon that inherited stderr must not hold the caller past exit.
            let stderr = receiver.recv_timeout(STDERR_GRACE).unwrap_or_default();
            return Ok(if status.success() {
                Finished::Succeeded
            } else {
                Finished::Failed {
                    stderr: text(&stderr),
                }
            });
        }
        if started.elapsed() >= deadline {
            stop(&mut child);
            return Ok(Finished::TimedOut);
        }
        thread::sleep(POLL);
    }
}

/// Git deletes its lock files on SIGTERM but cannot on SIGKILL.
#[cfg(unix)]
fn stop(child: &mut Child) {
    signal_group(child, libc::SIGTERM);
    let asked = Instant::now();
    while asked.elapsed() < TERMINATE_GRACE {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        thread::sleep(POLL);
    }
    signal_group(child, libc::SIGKILL);
    let _ = child.wait();
}

#[cfg(unix)]
fn signal_group(child: &mut Child, signal: libc::c_int) {
    let Ok(group) = i32::try_from(child.id()) else {
        let _ = child.kill();
        return;
    };
    // SAFETY: kill(2) takes no pointers. The group id is the pid of a child we have
    // not reaped yet, so it cannot name another process group.
    unsafe {
        libc::kill(-group, signal);
    }
}

#[cfg(not(unix))]
fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}
