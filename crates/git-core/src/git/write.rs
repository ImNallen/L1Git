use super::{Capped, Deadline, Work, base, execute, text, too_old, without_prompts};
use crate::{
    ErrorKind, RepositoryError, StaleReason, stderr,
    write::{CommitTxn, HOOK_OFF, Outside, Published, RefTxn, Txn},
};
use std::{
    ffi::OsStr,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalWrite {
    StageFiles,
    UnstageFiles,
    Commit,
    Amend,
    EditMessage,
    Discard,
    Undo,
    Redo,
}

impl LocalWrite {
    pub(crate) const fn budget(self) -> Duration {
        Duration::from_secs(match self {
            Self::StageFiles | Self::UnstageFiles | Self::Undo | Self::Redo => 120,
            Self::Discard => 300,
            Self::Commit | Self::Amend | Self::EditMessage => 600,
        })
    }

    pub(super) const fn doing(self) -> &'static str {
        match self {
            Self::StageFiles => "Staging the files",
            Self::UnstageFiles => "Unstaging the files",
            Self::Commit => "Committing",
            Self::Amend => "Amending the commit",
            Self::EditMessage => "Editing the commit message",
            Self::Discard => "Discarding the changes",
            Self::Undo => "Undoing the change",
            Self::Redo => "Redoing the change",
        }
    }

    const fn reflog_action(self) -> &'static str {
        match self {
            Self::StageFiles => "l1git stage",
            Self::UnstageFiles => "l1git unstage",
            Self::Commit => "l1git commit",
            Self::Amend => "l1git amend",
            Self::EditMessage => "l1git edit message",
            Self::Discard => "l1git discard",
            Self::Undo => "l1git undo",
            Self::Redo => "l1git redo",
        }
    }

    pub(super) const fn left_behind(self) -> &'static str {
        match self {
            Self::StageFiles | Self::UnstageFiles | Self::Undo | Self::Redo => {
                "The index is unchanged."
            }
            Self::Commit | Self::Amend | Self::EditMessage => {
                "Git may have finished the commit, so check the history."
            }
            Self::Discard => "No file changed.",
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
    as_user: bool,
    lazy_fetch: bool,
}

const WRITE_STDOUT_CAP: usize = 1024 * 1024;

impl<'a> Write<'a> {
    /// Hooks are off, because Git would run `post-index-change` against the
    /// copy. The copy stays whole, because writing a split copy makes a new
    /// shared index and can expire the one the real index names.
    pub(crate) fn new(txn: &'a Txn<'_>, dir: &'a Path, args: &[&'a str]) -> Self {
        let mut all = vec![
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.splitIndex=false",
        ];
        all.extend(txn.disabled_hooks().iter().map(String::as_str));
        all.extend(args);
        Self {
            dir,
            args: all,
            env: vec![
                ("GIT_INDEX_FILE", txn.copy().as_os_str()),
                (HOOK_OFF, OsStr::new("false")),
            ],
            input: None,
            cap: Some(WRITE_STDOUT_CAP),
            as_user: false,
            lazy_fetch: false,
        }
    }

    pub(crate) fn outside_index(txn: &'a Outside<'_>, args: &[&'a str]) -> Self {
        let mut all = vec!["-c", "core.hooksPath=/dev/null"];
        all.extend(args);
        Self {
            dir: txn.root(),
            args: all,
            env: Vec::new(),
            input: None,
            cap: Some(WRITE_STDOUT_CAP),
            as_user: false,
            lazy_fetch: false,
        }
    }

    pub(crate) fn commit(txn: &'a CommitTxn<'_>, flags: &[&'a str], message: &str) -> Self {
        let mut args = vec!["commit", "-F", "-"];
        args.extend(flags);
        Self {
            dir: txn.root(),
            args,
            env: Vec::new(),
            input: Some(message.as_bytes().to_vec()),
            cap: None,
            as_user: true,
            lazy_fetch: false,
        }
    }

    pub(crate) fn update_refs(txn: &'a RefTxn<'_>, reflog: &'a str, input: Vec<u8>) -> Self {
        Self {
            dir: txn.root(),
            args: vec!["update-ref", "-m", reflog, "--stdin"],
            env: Vec::new(),
            input: Some(input),
            cap: Some(WRITE_STDOUT_CAP),
            as_user: true,
            lazy_fetch: false,
        }
    }

    pub(crate) fn post_index_change(published: &'a Published) -> Self {
        Self {
            dir: published.root(),
            args: vec![
                "hook",
                "run",
                "--ignore-missing",
                "post-index-change",
                "--",
                if published.worktree_updated() {
                    "1"
                } else {
                    "0"
                },
                if published.skip_worktree() { "1" } else { "0" },
            ],
            env: Vec::new(),
            input: None,
            cap: Some(WRITE_STDOUT_CAP),
            as_user: false,
            lazy_fetch: false,
        }
    }

    pub(crate) fn traces(mut self, events: &'a Path, refs: &'a Path) -> Self {
        self.env.push(("GIT_TRACE2_EVENT", events.as_os_str()));
        self.env.push(("GIT_TRACE_REFS", refs.as_os_str()));
        self
    }

    pub(crate) fn object_directory(mut self, objects: &'a Path) -> Self {
        self.env.push(("GIT_OBJECT_DIRECTORY", objects.as_os_str()));
        self
    }

    pub(crate) fn alternate_object_directory(mut self, objects: &'a Path) -> Self {
        self.env
            .push(("GIT_ALTERNATE_OBJECT_DIRECTORIES", objects.as_os_str()));
        self
    }

    pub(crate) fn input(mut self, bytes: Vec<u8>) -> Self {
        self.input = Some(bytes);
        self
    }

    pub(crate) fn lazy_fetch_unprompted(mut self) -> Self {
        self.lazy_fetch = true;
        self
    }

    pub(crate) fn uncapped(mut self) -> Self {
        self.cap = None;
        self
    }

    pub(crate) fn run(self, deadline: WriteDeadline) -> Result<Wrote, RepositoryError> {
        let WriteDeadline { write, deadline } = deadline;
        let mut command = if self.as_user {
            as_user(self.dir)
        } else {
            let mut command = base(self.dir, self.lazy_fetch);
            command.env("GIT_REFLOG_ACTION", write.reflog_action());
            if self.lazy_fetch {
                without_prompts(&mut command);
            }
            command
        };
        command.args(&self.args).env("GIT_EDITOR", ":");
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

fn as_user(dir: &Path) -> Command {
    let mut command = Command::new("git");
    for (key, value) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key.starts_with("GIT_") {
            command.env_remove(&*key);
        } else if key == "LC_ALL" {
            command.env_remove("LC_ALL").env("LC_CTYPE", value);
        }
    }
    command
        .arg("-C")
        .arg(dir)
        .env("LC_MESSAGES", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    command
}

pub(crate) struct Wrote {
    write: LocalWrite,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

impl Wrote {
    pub(crate) const fn code(&self) -> Option<i32> {
        self.code
    }

    pub(crate) fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    pub(crate) fn stderr(&self) -> &str {
        &self.stderr
    }

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
