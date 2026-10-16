use crate::{ErrorKind, RepositoryError};
use std::{
    io::{self, Read},
    path::Path,
    process::{Command, Output, Stdio},
};

fn command(path: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .args([
            "--no-lazy-fetch",
            "--no-pager",
            "-c",
            "color.ui=false",
            "-c",
            "log.showSignature=false",
            "-C",
        ])
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("LC_ALL", "C");
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
