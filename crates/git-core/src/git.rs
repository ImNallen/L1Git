use crate::{BranchRef, ErrorKind, Oid, RepositoryError};
use std::{
    io::{self, Read, Write},
    path::Path,
    process::{Child, ChildStderr, Command, ExitStatus, Stdio},
    sync::{
        Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
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
            "-c",
            "core.quotePath=false",
            "-C",
        ])
        .arg(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    command
}

fn command(path: &Path, args: &[&str]) -> Command {
    let mut command = base(path, false);
    command.args(args);
    command
}

fn quitting() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        "L1 Git is quitting, so it did not run Git.",
    )
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

/// Every local read L1 Git serves. Each gets one deadline for all of its Git
/// commands, about 100 times or more its run time on the large fixture.
/// Branch status starts its deadline again after a fetch, probe, ref move, or
/// merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalRead {
    Snapshot,
    Refs,
    CommitDetail,
    LineStats,
    FilePatch,
    FileHistory,
    Blame,
    WorktreeStatus,
    WorktreePatch,
    BranchStatus,
}

impl LocalRead {
    pub(crate) const fn budget(self) -> Duration {
        Duration::from_secs(match self {
            Self::Snapshot => 120,
            Self::Refs | Self::LineStats | Self::WorktreeStatus | Self::WorktreePatch => 30,
            Self::CommitDetail | Self::FilePatch => 20,
            Self::FileHistory | Self::Blame | Self::BranchStatus => 60,
        })
    }

    const fn subject(self) -> &'static str {
        match self {
            Self::Snapshot => "the commit history",
            Self::Refs => "the branches",
            Self::CommitDetail => "this commit",
            Self::LineStats => "the line counts",
            Self::FilePatch => "this file's diff",
            Self::FileHistory => "this file's history",
            Self::Blame => "this file's blame",
            Self::WorktreeStatus => "the worktree status",
            Self::WorktreePatch => "this file's changes",
            Self::BranchStatus => "the branch status",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Deadline {
    read: LocalRead,
    budget: Duration,
    at: Instant,
}

impl Deadline {
    pub(crate) fn of(read: LocalRead) -> Self {
        Self::start(read, read.budget())
    }

    pub(crate) fn start(read: LocalRead, budget: Duration) -> Self {
        Self {
            read,
            budget,
            at: Instant::now() + budget,
        }
    }

    /// The same read with its full budget again. Branch status renews only
    /// after a fetch, probe, ref move, or merge, which have their own
    /// deadlines, or after waiting for another fetch or fast-forward of the
    /// repository.
    pub(crate) fn renewed(self) -> Self {
        Self::start(self.read, self.budget)
    }

    fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    fn expired(&self) -> RepositoryError {
        let budget = if self.budget.subsec_millis() == 0 {
            format!("{} s", self.budget.as_secs())
        } else {
            format!("{} ms", self.budget.as_millis())
        };
        RepositoryError::new(
            ErrorKind::TimedOut,
            format!(
                "Reading {} took longer than {budget}, so L1 Git stopped Git. Retry. If it happens again, check for a slow disk or a Git filter that does not finish.",
                self.read.subject()
            ),
        )
    }
}

struct Ran {
    status: ExitStatus,
    stdout: Capped,
    stderr: Stderr,
}

/// Spawns Git in its own process group so an expired deadline stops every
/// process it started, such as a clean filter.
fn execute(
    path: &Path,
    args: &[&str],
    deadline: Deadline,
    input: Option<Vec<u8>>,
    cap: Option<usize>,
) -> Result<Ran, RepositoryError> {
    let mut command = command(path, args);
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = Group::spawn(command)?;
    // Writing from another thread keeps a full stdout pipe from blocking Git.
    let writer = child
        .child
        .stdin
        .take()
        .zip(input)
        .map(|(mut stdin, input)| thread::spawn(move || stdin.write_all(&input)));
    let stderr = Stderr::drain(child.child.stderr.take());
    let Some(mut pipe) = child.child.stdout.take() else {
        child.stop();
        return Err(read_failed());
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(capped(&mut pipe, cap));
    });
    let stdout = match receiver.recv_timeout(deadline.remaining()) {
        Ok(Ok(stdout)) => stdout,
        Ok(Err(_)) => {
            child.stop();
            return Err(read_failed());
        }
        Err(_) => {
            child.stop();
            return Err(deadline.expired());
        }
    };
    let mut pause = FIRST_EXIT_POLL;
    let status = loop {
        match child.exited() {
            Ok(true) => break child.wait().map_err(|_| read_failed())?,
            Ok(false) if deadline.remaining().is_zero() => {
                child.stop();
                return Err(deadline.expired());
            }
            Ok(false) => {
                thread::sleep(pause);
                pause = (pause * 2).min(LAST_EXIT_POLL);
            }
            Err(_) => {
                child.stop();
                return Err(read_failed());
            }
        }
    };
    if let Some(writer) = writer
        && !matches!(writer.join(), Ok(Ok(())))
    {
        return Err(read_failed());
    }
    Ok(Ran {
        status,
        stdout,
        stderr,
    })
}

fn capped(pipe: &mut impl Read, cap: Option<usize>) -> io::Result<Capped> {
    let mut kept = Vec::new();
    let Some(cap) = cap else {
        pipe.read_to_end(&mut kept)?;
        return Ok(Capped::Within(kept));
    };
    pipe.take(cap as u64 + 1).read_to_end(&mut kept)?;
    let rest = io::copy(pipe, &mut io::sink())?;
    Ok(if kept.len() <= cap {
        Capped::Within(kept)
    } else {
        Capped::Over(kept.len() as u64 + rest)
    })
}

/// The status and output of a Git command. Its stderr is never read, so a
/// process that holds stderr open cannot delay it.
pub(crate) struct Exit {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
}

fn whole(ran: Ran) -> Result<Exit, RepositoryError> {
    let Capped::Within(stdout) = ran.stdout else {
        return Err(read_failed());
    };
    if ran.status.code() == Some(129)
        && String::from_utf8_lossy(&ran.stderr.after_exit()).contains("no-lazy-fetch")
    {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "L1 Git requires Git 2.45 or later. Update Git and try again.",
        ));
    }
    Ok(Exit {
        status: ran.status,
        stdout,
    })
}

pub(crate) fn run(path: &Path, args: &[&str], deadline: Deadline) -> Result<Exit, RepositoryError> {
    whole(execute(path, args, deadline, None, None)?)
}

pub(crate) fn read_failed() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        "Git could not read this repository. Check its permissions and missing objects. For a partial clone, fetch the required objects with Git, then refresh.",
    )
}

fn succeeded(output: Exit) -> Result<Vec<u8>, RepositoryError> {
    if !output.status.success() {
        return Err(read_failed());
    }
    Ok(output.stdout)
}

pub(crate) fn read(
    path: &Path,
    args: &[&str],
    deadline: Deadline,
) -> Result<Vec<u8>, RepositoryError> {
    succeeded(run(path, args, deadline)?)
}

pub(crate) fn read_with_input(
    path: &Path,
    args: &[&str],
    input: Vec<u8>,
    deadline: Deadline,
) -> Result<Vec<u8>, RepositoryError> {
    succeeded(whole(execute(path, args, deadline, Some(input), None)?)?)
}

pub(crate) enum Capped {
    Within(Vec<u8>),
    Over(u64),
}

pub(crate) struct CappedRun {
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Capped,
    stderr: Stderr,
}

impl CappedRun {
    /// Waits at most 1 s after Git exits for the rest of its stderr.
    pub(crate) fn stderr(self) -> String {
        text(&self.stderr.after_exit()).trim_end().to_owned()
    }
}

pub(crate) fn run_capped(
    path: &Path,
    args: &[&str],
    cap: usize,
    deadline: Deadline,
) -> Result<CappedRun, RepositoryError> {
    let ran = execute(path, args, deadline, None, Some(cap))?;
    Ok(CappedRun {
        code: ran.status.code(),
        stdout: ran.stdout,
        stderr: ran.stderr,
    })
}

pub(crate) fn read_capped(
    path: &Path,
    args: &[&str],
    cap: usize,
    deadline: Deadline,
) -> Result<Capped, RepositoryError> {
    let run = run_capped(path, args, cap, deadline)?;
    if run.code != Some(0) {
        return Err(read_failed());
    }
    Ok(run.stdout)
}

pub(crate) fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub(crate) fn line(bytes: &[u8]) -> String {
    text(bytes.strip_suffix(b"\n").unwrap_or(bytes))
}

/// Quotes a path the way Git's diff headers do with `core.quotePath=false`.
pub(crate) fn quoted(prefix: &str, path: &str) -> String {
    let special = |c: char| c < ' ' || c == '"' || c == '\\' || c == '\x7f';
    if !path.contains(special) {
        return format!("{prefix}{path}");
    }
    let mut quoted = format!("\"{prefix}");
    for c in path.chars() {
        match c {
            '\x07' => quoted.push_str("\\a"),
            '\x08' => quoted.push_str("\\b"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\x0b' => quoted.push_str("\\v"),
            '\x0c' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            c if special(c) => quoted.push_str(&format!("\\{:03o}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

pub(crate) fn malformed() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        "Git returned an unreadable record. Check the repository and your Git version.",
    )
}

pub(crate) enum Mutation<'a> {
    Fetch {
        remote: &'a str,
    },
    ProbeFastForward {
        branch: &'a BranchRef,
        to: &'a Oid,
    },
    MoveRef {
        branch: &'a BranchRef,
        from: &'a Oid,
        to: &'a Oid,
    },
    MergeFastForward {
        to: &'a Oid,
    },
}

impl Mutation<'_> {
    fn args(&self) -> Vec<String> {
        let owned = |args: &[&str]| args.iter().map(|arg| (*arg).to_owned()).collect();
        match self {
            Self::Fetch { remote } => owned(&[
                "fetch",
                "--prune",
                "--no-prune-tags",
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
            Self::MoveRef { branch, from, to } => owned(&[
                "update-ref",
                "-m",
                "l1git: fast-forward",
                branch.as_str(),
                to.as_str(),
                from.as_str(),
            ]),
            Self::MergeFastForward { to } => owned(&["merge", "--ff-only", to.as_str()]),
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
const FIRST_EXIT_POLL: Duration = Duration::from_micros(50);
const LAST_EXIT_POLL: Duration = Duration::from_millis(1);
const INHERITED_STDERR_WAIT: Duration = Duration::from_secs(1);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
const SPAWN_POLL: Duration = Duration::from_micros(100);

/// A process that Git starts, such as a clean filter, can keep stderr open
/// after Git exits.
struct Stderr(mpsc::Receiver<Vec<u8>>);

impl Stderr {
    fn drain(pipe: Option<ChildStderr>) -> Self {
        let (sender, receiver) = mpsc::channel();
        if let Some(mut pipe) = pipe {
            thread::spawn(move || {
                let mut kept = Vec::new();
                let _ = (&mut pipe).take(STDERR_CAP).read_to_end(&mut kept);
                let _ = io::copy(&mut pipe, &mut io::sink());
                let _ = sender.send(kept);
            });
        }
        Self(receiver)
    }

    fn after_exit(self) -> Vec<u8> {
        self.0
            .recv_timeout(INHERITED_STDERR_WAIT)
            .unwrap_or_default()
    }
}

pub(crate) fn mutate(
    path: &Path,
    mutation: Mutation<'_>,
    deadline: Duration,
) -> Result<Finished, RepositoryError> {
    // A partial clone must download the blobs of the tree it checks out.
    let merge = matches!(mutation, Mutation::MergeFastForward { .. });
    let mut command = base(path, merge);
    if merge {
        command.env("GIT_REFLOG_ACTION", "l1git fast-forward");
    }
    command
        .args(mutation.args())
        .env("SSH_ASKPASS", "/usr/bin/false")
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let mut child = Group::spawn(command)?;
    let stderr = Stderr::drain(child.child.stderr.take());
    let failed = |error: io::Error| {
        RepositoryError::new(ErrorKind::GitFailed, format!("Could not run Git: {error}"))
    };
    loop {
        let exited = match child.exited() {
            Ok(exited) => exited,
            Err(error) => {
                child.stop();
                return Err(failed(error));
            }
        };
        if exited {
            let status = child.wait().map_err(failed)?;
            let stderr = stderr.after_exit();
            return Ok(if status.success() {
                Finished::Succeeded
            } else {
                Finished::Failed {
                    stderr: text(&stderr),
                }
            });
        }
        if started.elapsed() >= deadline {
            child.stop();
            return Ok(Finished::TimedOut);
        }
        thread::sleep(POLL);
    }
}

/// The process group of every Git command that has not been reaped. Each
/// command leads its own group, and its pid cannot be reused until it is
/// reaped, so a listed pid always names that command's group.
static RUNNING: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static STOPPING: AtomicBool = AtomicBool::new(false);
/// Commands between the `STOPPING` check and their entry in `RUNNING`.
static SPAWNING: AtomicUsize = AtomicUsize::new(0);

fn running() -> MutexGuard<'static, Vec<u32>> {
    RUNNING.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Spawning;

impl Spawning {
    fn enter() -> Self {
        SPAWNING.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for Spawning {
    fn drop(&mut self) {
        SPAWNING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A Git command in its own process group, so a deadline or `stop_all_git`
/// stops every process it started, such as a clean filter.
struct Group {
    child: Child,
    reaped: bool,
}

impl Group {
    /// Refuses to start once `stop_all_git` has begun. `stop_all_git` waits for
    /// a command that passed the check to be listed, so it reaches it.
    fn spawn(mut command: Command) -> Result<Self, RepositoryError> {
        let spawning = Spawning::enter();
        if STOPPING.load(Ordering::SeqCst) {
            return Err(quitting());
        }
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let child = command.spawn().map_err(spawn_error)?;
        running().push(child.id());
        drop(spawning);
        let group = Self {
            child,
            reaped: false,
        };
        if STOPPING.load(Ordering::SeqCst) {
            group.stop();
            return Err(quitting());
        }
        Ok(group)
    }

    /// An error means the pid may no longer be this command's, so the caller
    /// must not signal it.
    fn exited(&mut self) -> io::Result<bool> {
        if self.reaped {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        #[cfg(unix)]
        {
            child_exited(self.child.id())
        }
        #[cfg(not(unix))]
        {
            Ok(self.child.try_wait()?.is_some())
        }
    }

    fn exited_within(&mut self, grace: Duration) -> bool {
        let asked = Instant::now();
        loop {
            if !matches!(self.exited(), Ok(false)) {
                return true;
            }
            if asked.elapsed() >= grace {
                return false;
            }
            thread::sleep(POLL);
        }
    }

    fn signal(&mut self, signal: Signal) {
        if self.exited().is_ok() {
            signal_group(self.child.id(), signal);
        }
    }

    fn wait(mut self) -> io::Result<ExitStatus> {
        self.reap()
    }

    /// After `stop_all_git` starts, a command that exited still has its group
    /// killed, so nothing it started outlives the process.
    fn reap(&mut self) -> io::Result<ExitStatus> {
        self.unlist();
        if STOPPING.load(Ordering::SeqCst) {
            self.signal(Signal::Kill);
        }
        self.reaped = true;
        self.child.wait()
    }

    fn unlist(&self) {
        let pid = self.child.id();
        running().retain(|listed| *listed != pid);
    }

    /// Git deletes its lock files on SIGTERM but cannot on SIGKILL. SIGKILL
    /// then reaches every process Git started, including one that ignores
    /// SIGTERM. Returns whether Git exited.
    fn halt(&mut self) -> bool {
        self.signal(Signal::Terminate);
        let exited = self.exited_within(TERMINATE_GRACE);
        self.signal(Signal::Kill);
        #[cfg(not(unix))]
        let _ = self.child.kill();
        exited || self.exited_within(TERMINATE_GRACE)
    }

    /// A process stuck in the kernel survives SIGKILL, so another thread
    /// reaps it.
    fn stop(mut self) {
        if self.halt() {
            let _ = self.reap();
        } else {
            thread::spawn(move || self.wait());
        }
    }
}

/// A command dropped without `wait` or `stop`, as during a panic, is stopped
/// so it never runs outside `stop_all_git`.
impl Drop for Group {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        if matches!(self.exited(), Ok(false)) && !self.halt() {
            self.unlist();
            return;
        }
        let _ = self.reap();
    }
}

/// Leaves the child unreaped, so its pid keeps naming its group. An error,
/// such as ECHILD after another reaper took it, means the pid is no longer
/// known to be this process's child.
#[cfg(unix)]
fn child_exited(pid: u32) -> io::Result<bool> {
    // SAFETY: `siginfo_t` is plain data that waitid(2) only writes to.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a valid, writable `siginfo_t` for the whole call.
    let status = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.si_signo != 0)
}

#[cfg(not(unix))]
fn child_exited(_pid: u32) -> io::Result<bool> {
    Ok(false)
}

/// Stops every Git command L1 Git started that is still running, for a
/// process that is about to exit. A command checked before it began is
/// waited for, for up to 1 s, so it is listed and stopped. Later commands are
/// refused. It can block for about 2 s when a command is slow to start and
/// another ignores SIGTERM.
pub fn stop_all_git() {
    STOPPING.store(true, Ordering::SeqCst);
    let asked = Instant::now();
    while SPAWNING.load(Ordering::SeqCst) > 0 && asked.elapsed() < SHUTDOWN_GRACE {
        thread::sleep(SPAWN_POLL);
    }
    signal_listed(Signal::Terminate);
    let asked = Instant::now();
    while !running().is_empty() && asked.elapsed() < SHUTDOWN_GRACE {
        thread::sleep(POLL);
    }
    signal_listed(Signal::Kill);
}

/// A listed pid is unreaped, because `Group` unlists it before reaping and
/// cannot while this holds the lock. The check also skips a child the system
/// reaped on its own.
fn signal_listed(signal: Signal) {
    for pid in running().iter() {
        if child_exited(*pid).is_ok() {
            signal_group(*pid, signal);
        }
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Terminate,
    Kill,
}

/// Callers first check that the pid is still this process's unreaped child,
/// so it names the group that child leads. A group below 2 would make kill(2)
/// signal the caller's own group or every process.
#[cfg(unix)]
fn signal_group(pid: u32, signal: Signal) {
    let Ok(group @ 2..) = i32::try_from(pid) else {
        return;
    };
    let signal = match signal {
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: kill(2) takes no pointers.
    unsafe {
        libc::kill(-group, signal);
    }
}

#[cfg(not(unix))]
fn signal_group(_pid: u32, _signal: Signal) {}
