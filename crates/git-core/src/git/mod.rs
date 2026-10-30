#[cfg(windows)]
mod windows;
mod write;

pub(crate) use write::{
    LocalWrite, Write, WriteDeadline, Wrote, install_config_values, install_tracking,
};

use crate::{BranchRef, ErrorKind, Oid, RepositoryError};
use std::{
    io::{self, Read, Write as _},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
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
            "diff.suppressBlankEmpty=false",
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

fn without_prompts(command: &mut Command) -> &mut Command {
    command
        .env("SSH_ASKPASS", "/usr/bin/false")
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GCM_INTERACTIVE", "never")
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
    BranchMerged,
    UndoHistory,
}

impl LocalRead {
    pub(crate) const fn budget(self) -> Duration {
        Duration::from_secs(match self {
            Self::Snapshot => 120,
            Self::Refs
            | Self::LineStats
            | Self::WorktreeStatus
            | Self::WorktreePatch
            | Self::BranchMerged
            | Self::UndoHistory => 30,
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
            Self::BranchMerged => "whether the branch is merged",
            Self::UndoHistory => "the undo history",
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Work {
    Read(LocalRead),
    Write(LocalWrite),
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Deadline {
    work: Work,
    budget: Duration,
    at: Instant,
}

impl Deadline {
    pub(crate) fn of(read: LocalRead) -> Self {
        Self::start(read, read.budget())
    }

    pub(crate) fn start(read: LocalRead, budget: Duration) -> Self {
        Self::new(Work::Read(read), budget)
    }

    fn new(work: Work, budget: Duration) -> Self {
        Self {
            work,
            budget,
            at: Instant::now() + budget,
        }
    }

    pub(crate) fn renewed(self) -> Self {
        Self::new(self.work, self.budget)
    }

    pub(crate) fn remaining(&self) -> Duration {
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
            match self.work {
                Work::Read(read) => format!(
                    "Reading {} took longer than {budget}, so L1 Git stopped Git. Retry. If it happens again, check for a slow disk or a Git filter that does not finish.",
                    read.subject()
                ),
                Work::Write(write) => format!(
                    "{} took longer than {budget}, so L1 Git stopped Git. {} Retry. If it happens again, check for a Git filter or hook that does not finish.",
                    write.doing(),
                    write.left_behind()
                ),
            },
        )
    }

    fn broken(&self) -> RepositoryError {
        match self.work {
            Work::Read(_) => read_failed(),
            Work::Write(write) => RepositoryError::new(
                ErrorKind::GitFailed,
                format!(
                    "Git stopped unexpectedly while {}. {} Retry.",
                    write.doing().to_lowercase(),
                    write.left_behind()
                ),
            ),
        }
    }
}

struct Ran {
    status: ExitStatus,
    stdout: Capped,
    stderr: CapturedPipe,
}

/// Spawns Git in its own process group so an expired deadline stops every
/// process it started, such as a clean filter.
fn execute(
    mut command: Command,
    deadline: Deadline,
    input: Option<Vec<u8>>,
    cap: Option<usize>,
) -> Result<Ran, RepositoryError> {
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
    let stderr = CapturedPipe::drain(child.child.stderr.take());
    let Some(mut pipe) = child.child.stdout.take() else {
        child.stop();
        return Err(deadline.broken());
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(capped(&mut pipe, cap));
    });
    let stdout = loop {
        #[cfg(windows)]
        let wait = deadline.remaining().min(POLL);
        #[cfg(not(windows))]
        let wait = deadline.remaining();
        match receiver.recv_timeout(wait) {
            Ok(Ok(stdout)) => break stdout,
            Ok(Err(_)) => {
                child.stop();
                return Err(deadline.broken());
            }
            Err(mpsc::RecvTimeoutError::Timeout) if !deadline.remaining().is_zero() => {
                #[cfg(windows)]
                if matches!(child.exited(), Ok(true)) {
                    child.job.terminate();
                }
            }
            Err(_) => {
                child.stop();
                return Err(deadline.expired());
            }
        }
    };
    let mut pause = FIRST_EXIT_POLL;
    let status = loop {
        match child.exited() {
            Ok(true) => break child.wait().map_err(|_| deadline.broken())?,
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
                return Err(deadline.broken());
            }
        }
    };
    if let Some(writer) = writer {
        match writer.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) if error.kind() == io::ErrorKind::BrokenPipe && !status.success() => {}
            _ => return Err(deadline.broken()),
        }
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
        && let Some(error) = too_old(ran.status.code(), &text(&ran.stderr.after_exit()))
    {
        return Err(error);
    }
    Ok(Exit {
        status: ran.status,
        stdout,
    })
}

pub(crate) fn run(path: &Path, args: &[&str], deadline: Deadline) -> Result<Exit, RepositoryError> {
    whole(execute(command(path, args), deadline, None, None)?)
}

pub(crate) fn config_flag(
    path: &Path,
    key: &str,
    if_unset: bool,
    deadline: Deadline,
) -> Result<bool, RepositoryError> {
    let output = run(path, &["config", "--type=bool", "--get", key], deadline)?;
    match output.status.code() {
        Some(0) => Ok(output.stdout == b"true\n"),
        Some(1) => Ok(if_unset),
        _ => Err(malformed()),
    }
}

/// `name` as Git reads it from its command line. Under
/// `core.precomposeunicode`, Git on macOS composes each argument's
/// decomposed characters its own way, which is not NFC, so `git tag` stores
/// a decomposed name composed. `git config --default` echoes an argument
/// after that step.
pub(crate) fn precomposed(
    path: &Path,
    name: &str,
    deadline: Deadline,
) -> Result<String, RepositoryError> {
    if name.is_ascii() {
        return Ok(name.to_owned());
    }
    let default = format!("--default={name}");
    let echoed = read(
        path,
        &[
            "config",
            "--file",
            "/dev/null",
            &default,
            "--get",
            "l1git.name",
        ],
        deadline,
    )?;
    Ok(line(&echoed))
}

/// `base()` passes `--no-lazy-fetch`, which Git before 2.45 rejects.
fn too_old(code: Option<i32>, stderr: &str) -> Option<RepositoryError> {
    (code == Some(129) && stderr.contains("no-lazy-fetch")).then(|| {
        RepositoryError::new(
            ErrorKind::GitFailed,
            "L1 Git requires Git 2.45 or later. Update Git and try again.",
        )
    })
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
    succeeded(whole(execute(
        command(path, args),
        deadline,
        Some(input),
        None,
    )?)?)
}

pub(crate) enum Capped {
    Within(Vec<u8>),
    Over(u64),
}

pub(crate) struct CappedRun {
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Capped,
    stderr: CapturedPipe,
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
    let ran = execute(command(path, args), deadline, None, Some(cap))?;
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
    UpdateTracking {
        reference: &'a str,
        source: &'a Oid,
        expected: Option<&'a Oid>,
    },
    Push {
        remote: &'a str,
        source: &'a Oid,
        destination: &'a BranchRef,
    },
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
            Self::Push {
                remote,
                source,
                destination,
            } => owned(&[
                &format!("--config-env=remote.{remote}.mirror=L1GIT_PUSH_MIRROR"),
                // Git reverses positive mappings when matching negative refspecs.
                // The identity mapping makes this exclusion work with wildcard mappings.
                "-c",
                &format!("remote.{remote}.fetch={0}:{0}", destination.as_str()),
                "-c",
                &format!("remote.{remote}.fetch=^{}", destination.as_str()),
                "-c",
                "push.pushOption=",
                "push",
                "--porcelain",
                "--no-force",
                "--no-follow-tags",
                "--recurse-submodules=no",
                "--",
                remote,
                &format!("{}:{}", source.as_str(), destination.as_str()),
            ]),
            Self::UpdateTracking {
                reference,
                source,
                expected,
            } => owned(&[
                "update-ref",
                "--no-deref",
                "-m",
                "l1git: push",
                reference,
                source.as_str(),
                &expected.map_or_else(
                    || "0".repeat(source.as_str().len()),
                    |oid| oid.as_str().to_owned(),
                ),
            ]),
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

const STDERR_CAP: usize = 64 * 1024;
const POLL: Duration = Duration::from_millis(10);
const FIRST_EXIT_POLL: Duration = Duration::from_micros(50);
const LAST_EXIT_POLL: Duration = Duration::from_millis(1);
const INHERITED_STDERR_WAIT: Duration = Duration::from_secs(1);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
const SPAWN_POLL: Duration = Duration::from_micros(100);

/// A process that Git starts, such as a hook, can keep a pipe open after
/// Git exits.
struct CapturedPipe(mpsc::Receiver<Vec<u8>>);

impl CapturedPipe {
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> Self {
        let (sender, receiver) = mpsc::channel();
        if let Some(mut pipe) = pipe {
            thread::spawn(move || {
                let _ = sender.send(marked_tail(&mut pipe, STDERR_CAP));
            });
        }
        Self(receiver)
    }

    fn after_exit(self) -> Vec<u8> {
        self.0
            .recv_timeout(INHERITED_STDERR_WAIT)
            .unwrap_or_else(|_| "…".as_bytes().to_vec())
    }
}

fn marked_tail(pipe: &mut impl Read, cap: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0; 8192];
    let mut cut = false;
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => kept.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                cut = true;
                break;
            }
        }
        if kept.len() > 2 * cap {
            kept.drain(..kept.len() - cap);
            cut = true;
        }
    }
    if kept.len() > cap {
        kept.drain(..kept.len() - cap);
        cut = true;
    }
    if !cut {
        return kept;
    }
    let start = kept
        .iter()
        .position(|byte| byte & 0xC0 != 0x80)
        .unwrap_or(kept.len());
    ["…".as_bytes(), &kept[start..]].concat()
}

pub(crate) fn mutate(
    path: &Path,
    mutation: Mutation<'_>,
    deadline: Duration,
) -> Result<Finished, RepositoryError> {
    Ok(match capture_mutation(path, mutation, deadline)? {
        Captured::Completed { success: true, .. } => Finished::Succeeded,
        Captured::Completed { stderr, .. } => Finished::Failed { stderr },
        Captured::TimedOut => Finished::TimedOut,
    })
}

pub(crate) enum Captured {
    Completed {
        success: bool,
        stdout: Vec<u8>,
        stderr: String,
    },
    TimedOut,
}

pub(crate) fn capture_mutation(
    path: &Path,
    mutation: Mutation<'_>,
    deadline: Duration,
) -> Result<Captured, RepositoryError> {
    let merge = matches!(mutation, Mutation::MergeFastForward { .. });
    let capture = matches!(mutation, Mutation::Push { .. });
    let mut command = base(path, merge);
    if merge {
        command.env("GIT_REFLOG_ACTION", "l1git fast-forward");
    }
    if capture {
        command
            .env("L1GIT_PUSH_MIRROR", "false")
            .env("GIT_ASKPASS", "/usr/bin/false");
    }
    without_prompts(&mut command)
        .args(mutation.args())
        .stdin(Stdio::null())
        .stdout(if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped());
    let started = Instant::now();
    let mut child = Group::spawn(command)?;
    let stderr = CapturedPipe::drain(child.child.stderr.take());
    let stdout = CapturedPipe::drain(child.child.stdout.take());
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
            return Ok(Captured::Completed {
                success: status.success(),
                stdout: stdout.after_exit(),
                stderr: text(&stderr),
            });
        }
        if started.elapsed() >= deadline {
            child.stop();
            return Ok(Captured::TimedOut);
        }
        thread::sleep(POLL);
    }
}

/// Unix process-group IDs remain unreaped until unlisted. Windows job handles
/// retain their process trees after the original Git process exits.
struct Running {
    pid: u32,
    #[cfg(windows)]
    job: std::sync::Arc<windows::Job>,
}

static RUNNING: Mutex<Vec<Running>> = Mutex::new(Vec::new());
static STOPPING: AtomicBool = AtomicBool::new(false);
/// Commands between the `STOPPING` check and their entry in `RUNNING`.
static SPAWNING: AtomicUsize = AtomicUsize::new(0);
static HELD_INDEX_LOCKS: AtomicUsize = AtomicUsize::new(0);

pub(crate) struct HeldIndexLock;

impl HeldIndexLock {
    /// Counts the transaction before it takes the index lock, and refuses
    /// once `stop_all_git` has begun. `stop_all_git` sets `STOPPING` before
    /// it reads the count, so it either waits for this transaction or this
    /// transaction sees it quitting and takes no lock.
    pub(crate) fn begin() -> Result<Self, RepositoryError> {
        HELD_INDEX_LOCKS.fetch_add(1, Ordering::SeqCst);
        let held = Self;
        if STOPPING.load(Ordering::SeqCst) {
            return Err(quitting());
        }
        Ok(held)
    }
}

impl Drop for HeldIndexLock {
    fn drop(&mut self) {
        HELD_INDEX_LOCKS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn running() -> MutexGuard<'static, Vec<Running>> {
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
    #[cfg(windows)]
    job: std::sync::Arc<windows::Job>,
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
        #[cfg(windows)]
        let job = std::sync::Arc::new(windows::Job::new().map_err(spawn_error)?);
        #[cfg(windows)]
        let child = job.spawn(&mut command).map_err(spawn_error)?;
        #[cfg(not(windows))]
        let child = command.spawn().map_err(spawn_error)?;
        running().push(Running {
            pid: child.id(),
            #[cfg(windows)]
            job: std::sync::Arc::clone(&job),
        });
        drop(spawning);
        let group = Self {
            child,
            #[cfg(windows)]
            job,
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
        #[cfg(windows)]
        {
            let _ = signal;
            self.job.terminate();
        }
        #[cfg(not(windows))]
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
        #[cfg(windows)]
        self.job.terminate();
        if STOPPING.load(Ordering::SeqCst) {
            self.signal(Signal::Kill);
        }
        self.reaped = true;
        self.child.wait()
    }

    fn unlist(&self) {
        let pid = self.child.id();
        running().retain(|listed| listed.pid != pid);
    }

    /// Unix gives Git time to remove locks on SIGTERM before SIGKILL. Windows
    /// terminates its job immediately. Returns whether Git exited.
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

#[cfg(not(any(unix, windows)))]
fn child_exited(_pid: u32) -> io::Result<bool> {
    Ok(false)
}

/// Stops every Git command L1 Git started that is still running, for a
/// process that is about to exit. A command checked before it began is
/// waited for, for up to 1 s, so it is listed and stopped. Later commands are
/// refused. Then it waits up to 1 s for index transactions to remove their
/// locks, and later transactions take none. It can block for about 3 s when a command is slow to start and
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
    let asked = Instant::now();
    while HELD_INDEX_LOCKS.load(Ordering::SeqCst) > 0 && asked.elapsed() < SHUTDOWN_GRACE {
        thread::sleep(POLL);
    }
}

/// A listed pid is unreaped, because `Group` unlists it before reaping and
/// cannot while this holds the lock. The check also skips a child the system
/// reaped on its own.
fn signal_listed(signal: Signal) {
    for process in running().iter() {
        #[cfg(windows)]
        {
            let _ = signal;
            process.job.terminate();
        }
        #[cfg(not(windows))]
        if child_exited(process.pid).is_ok() {
            signal_group(process.pid, signal);
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

#[cfg(not(any(unix, windows)))]
fn signal_group(_pid: u32, _signal: Signal) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn kept(printed: &str, cap: usize) -> String {
        String::from_utf8(marked_tail(&mut printed.as_bytes(), cap)).unwrap()
    }

    #[test]
    fn a_cut_output_keeps_its_last_bytes_and_marks_the_cut() {
        assert_eq!(kept("short\n", 9), "short\n");
        assert_eq!(kept("drop\nkept\nend\n", 9), "…kept\nend\n");
        assert_eq!(kept("aaaaaaaaaabbbb\n", 5), "…bbbb\n");
        assert_eq!(kept("aaaaabbbbb", 5), "…bbbbb");
    }

    #[cfg(unix)]
    #[test]
    fn a_successful_command_that_refuses_its_input_is_not_reported_as_successful() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec 0<&-; exit 0"]);
        let result = execute(
            command,
            Deadline::of(LocalRead::Snapshot),
            Some(vec![b'x'; 1024 * 1024]),
            None,
        );
        assert!(matches!(result, Err(error) if error.kind == ErrorKind::GitFailed));
    }
}
