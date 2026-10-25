use super::{Capped, Deadline, Work, base, execute, text, too_old};
use crate::{ErrorKind, RepositoryError, StaleReason, stderr, write::Txn};
use std::{ffi::OsStr, path::Path, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalWrite {
    StageFiles,
    UnstageFiles,
    Undo,
    Redo,
}

impl LocalWrite {
    pub(crate) const fn budget(self) -> Duration {
        Duration::from_secs(match self {
            Self::StageFiles | Self::UnstageFiles | Self::Undo | Self::Redo => 120,
        })
    }

    pub(super) const fn doing(self) -> &'static str {
        match self {
            Self::StageFiles => "Staging the files",
            Self::UnstageFiles => "Unstaging the files",
            Self::Undo => "Undoing the change",
            Self::Redo => "Redoing the change",
        }
    }

    const fn reflog_action(self) -> &'static str {
        match self {
            Self::StageFiles => "l1git stage",
            Self::UnstageFiles => "l1git unstage",
            Self::Undo => "l1git undo",
            Self::Redo => "l1git redo",
        }
    }

    pub(super) const fn left_behind(self) -> &'static str {
        match self {
            Self::StageFiles | Self::UnstageFiles | Self::Undo | Self::Redo => {
                "The index is unchanged."
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WriteDeadline {
    write: LocalWrite,
    deadline: Deadline,
}

impl WriteDeadline {
    pub(crate) fn start(write: LocalWrite, budget: Duration) -> Self {
        Self {
            write,
            deadline: Deadline::new(Work::Write(write), budget),
        }
    }

    pub(crate) fn renewed(self) -> Self {
        Self {
            deadline: self.deadline.renewed(),
            ..self
        }
    }

    pub(crate) const fn reads(self) -> Deadline {
        self.deadline
    }
}

pub(crate) struct Write<'a> {
    dir: &'a Path,
    args: Vec<&'a str>,
    env: Vec<(&'static str, &'a OsStr)>,
    input: Option<Vec<u8>>,
    cap: Option<usize>,
}

const WRITE_STDOUT_CAP: usize = 1024 * 1024;

impl<'a> Write<'a> {
    /// A Git command of the write that `txn` holds. It needs the transaction,
    /// so no Git write runs outside one, and it always runs on the
    /// transaction's private copy of the index, so it cannot reach the index
    /// before the write is recorded. Hooks are off, because Git would run
    /// `post-index-change` against the copy.
    pub(crate) fn new(txn: &'a Txn<'_>, dir: &'a Path, args: &[&'a str]) -> Self {
        let mut all = vec!["-c", "core.hooksPath=/dev/null"];
        all.extend(args);
        Self {
            dir,
            args: all,
            env: vec![("GIT_INDEX_FILE", txn.copy().as_os_str())],
            input: None,
            cap: Some(WRITE_STDOUT_CAP),
        }
    }

    /// Git's `post-index-change` hook, run as `git add` runs it: from the
    /// worktree root, against the real index, once `txn` replaced it.
    pub(crate) fn post_index_change(txn: &'a Txn<'_>, skip_worktree: bool) -> Self {
        Self {
            dir: txn.root(),
            args: vec![
                "hook",
                "run",
                "--ignore-missing",
                "post-index-change",
                "--",
                "0",
                if skip_worktree { "1" } else { "0" },
            ],
            env: Vec::new(),
            input: None,
            cap: Some(WRITE_STDOUT_CAP),
        }
    }

    /// Writes new objects to `objects` instead of the repository.
    pub(crate) fn objects(mut self, objects: &'a Path) -> Self {
        self.env.push(("GIT_OBJECT_DIRECTORY", objects.as_os_str()));
        self
    }

    /// Reads objects from `objects` as well as the repository.
    pub(crate) fn alternates(mut self, objects: &'a Path) -> Self {
        self.env
            .push(("GIT_ALTERNATE_OBJECT_DIRECTORIES", objects.as_os_str()));
        self
    }

    pub(crate) fn input(mut self, bytes: Vec<u8>) -> Self {
        self.input = Some(bytes);
        self
    }

    pub(crate) fn uncapped(mut self) -> Self {
        self.cap = None;
        self
    }

    pub(crate) fn run(self, deadline: WriteDeadline) -> Result<Wrote, RepositoryError> {
        let WriteDeadline { write, deadline } = deadline;
        let mut command = base(self.dir, false);
        command
            .args(&self.args)
            .env("GIT_EDITOR", ":")
            .env("GIT_REFLOG_ACTION", write.reflog_action());
        for (key, value) in self.env {
            command.env(key, value);
        }
        let ran = execute(command, deadline, self.input, self.cap)?;
        let Capped::Within(stdout) = ran.stdout else {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                format!(
                    "Git printed more than L1 Git expected while {}. {} Retry.",
                    write.doing().to_lowercase(),
                    write.left_behind()
                ),
            ));
        };
        Ok(Wrote {
            write,
            code: ran.status.code(),
            stdout,
            stderr: text(&ran.stderr.after_exit()),
        })
    }
}

pub(crate) struct Wrote {
    write: LocalWrite,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

impl Wrote {
    pub(crate) fn succeeded(self) -> Result<Vec<u8>, RepositoryError> {
        if self.code == Some(0) {
            return Ok(self.stdout);
        }
        Err(self.failed())
    }

    fn failed(&self) -> RepositoryError {
        if let Some(error) = too_old(self.code, &self.stderr) {
            return error;
        }
        if self.stderr.contains(stderr::LOCK_HELD) {
            return RepositoryError::new(
                ErrorKind::LockHeld,
                format!(
                    "Another Git process is changing this repository. {} Wait for it to finish, then try again. Git said: {}",
                    self.write.left_behind(),
                    stderr::summarize(&self.stderr)
                ),
            );
        }
        if self.stderr.contains("did not match any files") {
            return RepositoryError::stale(
                StaleReason::PathChanged,
                format!(
                    "A path changed since L1 Git read it. {} Refresh and try again.",
                    self.write.left_behind()
                ),
            );
        }
        RepositoryError::new(
            ErrorKind::GitFailed,
            format!(
                "{} failed. {} Git said: {}",
                self.write.doing(),
                self.write.left_behind(),
                stderr::summarize(&self.stderr)
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_a_held_lock_wherever_git_names_it() {
        let wrote = Wrote {
            write: LocalWrite::StageFiles,
            code: Some(128),
            stdout: Vec::new(),
            stderr: "warning: in the working copy of 'f', LF will be replaced by CRLF\nfatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository.\n".into(),
        };
        assert_eq!(wrote.failed().kind, ErrorKind::LockHeld);
    }
}
