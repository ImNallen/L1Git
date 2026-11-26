use super::{Deadline, read_failed, run, text};
use crate::{ErrorKind, RepositoryError};
use std::{ffi::OsString, path::Path, process::Command};

pub(crate) const HOOK_OFF: &str = "L1GIT_HOOK_OFF";

/// `core.hooksPath` does not turn off a hook that config defines, so each
/// one comes back as a flag that turns it off by name. The name can hold
/// `=`, which `-c` would split on, so the value comes from [`HOOK_OFF`]
/// through `--config-env`, which splits on the last `=`.
pub(crate) fn defined(
    root: &Path,
    deadline: Deadline,
    event: Option<&str>,
) -> Result<Vec<String>, RepositoryError> {
    let mut args = vec!["config", "-z", "--get-regexp", r"^hook\..*\.event$"];
    args.extend(event);
    let found = run(root, &args, deadline)?;
    match found.status.code() {
        Some(0) => Ok(found
            .stdout
            .split(|byte| *byte == 0)
            .filter_map(|record| {
                let key = text(record.split(|byte| *byte == b'\n').next()?);
                let name = key.strip_prefix("hook.")?.strip_suffix(".event")?;
                Some(format!("--config-env=hook.{name}.enabled={HOOK_OFF}"))
            })
            .collect()),
        Some(1) => Ok(Vec::new()),
        _ => Err(read_failed()),
    }
}

/// Keeps Git from running any hook or a file system monitor, which config
/// can point at a tracked script. `core.hooksPath` on the command line moves
/// the hooks folder to an empty one, and outranks every config file. On Windows Git reads
/// `/dev/null` as a folder at the root of the drive, which another user can
/// make, so the folder is a new one in the user's own temporary folder.
pub(crate) struct NoHooks {
    empty: tempfile::TempDir,
    defined: Vec<String>,
}

impl NoHooks {
    pub(crate) fn of(root: &Path, deadline: Deadline) -> Result<Self, RepositoryError> {
        let empty = tempfile::Builder::new()
            .prefix("l1git-no-hooks-")
            .tempdir()
            .map_err(|error| {
                RepositoryError::new(
                    ErrorKind::GitFailed,
                    format!("L1 Git could not make a folder to run Git without hooks: {error}"),
                )
            })?;
        Ok(Self {
            empty,
            defined: defined(root, deadline, None)?,
        })
    }

    /// Goes before the Git command's name.
    pub(crate) fn apply(&self, command: &mut Command) {
        let mut path = OsString::from("core.hooksPath=");
        path.push(self.empty.path());
        command
            .arg("-c")
            .arg(path)
            .args(["-c", "core.fsmonitor=false"])
            .args(&self.defined)
            .env(HOOK_OFF, "false");
    }
}
