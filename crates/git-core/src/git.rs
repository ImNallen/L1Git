use crate::{ErrorKind, RepositoryError};
use std::{
    path::Path,
    process::{Command, Output},
};

pub(crate) fn run(path: &Path, args: &[&str]) -> Result<Output, RepositoryError> {
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
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RepositoryError::new(
                ErrorKind::GitMissing,
                "Git is not installed or is not on PATH. Install Git and try again.",
            )
        } else {
            RepositoryError::new(ErrorKind::GitFailed, format!("Could not run Git: {error}"))
        }
    })?;
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

pub(crate) fn read(path: &Path, args: &[&str]) -> Result<Vec<u8>, RepositoryError> {
    let output = run(path, args)?;
    if !output.status.success() {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Git could not read this repository. Check its permissions and missing objects. For a partial clone, fetch the required objects with Git, then refresh.",
        ));
    }
    Ok(output.stdout)
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
