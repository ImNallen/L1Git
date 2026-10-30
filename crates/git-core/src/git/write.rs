use super::{Capped, Deadline, Work, base, execute, text, too_old, without_prompts};
use crate::{
    ErrorKind, RepositoryError, StaleReason, stderr,
    write::{CommitTxn, HOOK_OFF, Outside, Published, RefTxn, ScratchIndex, Txn},
};
use std::{
    ffi::OsStr,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalWrite {
    SaveConflict,
    StageFiles,
    UnstageFiles,
    StagePart,
    UnstagePart,
    Commit,
    Amend,
    EditMessage,
    Discard,
    DiscardPart,
    CreateBranch,
    RenameBranch,
    DeleteBranch,
    Checkout,
    CreateTag,
    DeleteTag,
    StashPush,
    StashApply,
    StashPop,
    StashDrop,
    Undo,
    Redo,
    UndoCheckout,
    RedoCheckout,
    UndoStash,
    RedoStash,
}

impl LocalWrite {
    pub(crate) const fn budget(self) -> Duration {
        Duration::from_secs(match self {
            Self::SaveConflict
            | Self::StageFiles
            | Self::UnstageFiles
            | Self::StagePart
            | Self::UnstagePart
            | Self::DiscardPart
            | Self::CreateBranch
            | Self::RenameBranch
            | Self::DeleteBranch
            | Self::CreateTag
            | Self::DeleteTag
            | Self::Undo
            | Self::Redo => 120,
            Self::Discard => 300,
            Self::Commit
            | Self::Amend
            | Self::EditMessage
            | Self::Checkout
            | Self::UndoCheckout
            | Self::RedoCheckout
            | Self::StashPush
            | Self::StashApply
            | Self::StashPop
            | Self::StashDrop
            | Self::UndoStash
            | Self::RedoStash => 600,
        })
    }

    pub(super) const fn doing(self) -> &'static str {
        match self {
            Self::SaveConflict => "Saving the conflict result",
            Self::StageFiles => "Staging the files",
            Self::UnstageFiles => "Unstaging the files",
            Self::StagePart => "Staging part of the file",
            Self::UnstagePart => "Unstaging part of the file",
            Self::Commit => "Committing",
            Self::Amend => "Amending the commit",
            Self::EditMessage => "Editing the commit message",
            Self::Discard => "Discarding the changes",
            Self::DiscardPart => "Discarding part of the file",
            Self::CreateBranch => "Creating the branch",
            Self::RenameBranch => "Renaming the branch",
            Self::DeleteBranch => "Deleting the branch",
            Self::Checkout => "Checking out",
            Self::CreateTag => "Creating the tag",
            Self::DeleteTag => "Deleting the tag",
            Self::StashPush => "Stashing the changes",
            Self::StashApply => "Applying the stash",
            Self::StashPop => "Popping the stash",
            Self::StashDrop => "Dropping the stash",
            Self::Undo => "Undoing the change",
            Self::Redo => "Redoing the change",
            Self::UndoCheckout => "Undoing the checkout",
            Self::RedoCheckout => "Redoing the checkout",
            Self::UndoStash => "Undoing the stash change",
            Self::RedoStash => "Redoing the stash change",
        }
    }

    const fn reflog_action(self) -> &'static str {
        match self {
            Self::SaveConflict => "l1git save conflict",
            Self::StageFiles => "l1git stage",
            Self::UnstageFiles => "l1git unstage",
            Self::StagePart => "l1git stage part",
            Self::UnstagePart => "l1git unstage part",
            Self::Commit => "l1git commit",
            Self::Amend => "l1git amend",
            Self::EditMessage => "l1git edit message",
            Self::Discard => "l1git discard",
            Self::DiscardPart => "l1git discard part",
            Self::CreateBranch => "l1git create branch",
            Self::RenameBranch => "l1git rename branch",
            Self::DeleteBranch => "l1git delete branch",
            Self::Checkout => "l1git checkout",
            Self::CreateTag => "l1git create tag",
            Self::DeleteTag => "l1git delete tag",
            Self::StashPush => "l1git stash",
            Self::StashApply => "l1git stash apply",
            Self::StashPop => "l1git stash pop",
            Self::StashDrop => "l1git stash drop",
            Self::Undo | Self::UndoCheckout | Self::UndoStash => "l1git undo",
            Self::Redo | Self::RedoCheckout | Self::RedoStash => "l1git redo",
        }
    }

    pub(super) const fn left_behind(self) -> &'static str {
        match self {
            Self::StageFiles
            | Self::UnstageFiles
            | Self::StagePart
            | Self::UnstagePart
            | Self::Undo
            | Self::Redo => "The index is unchanged.",
            Self::Commit | Self::Amend | Self::EditMessage => {
                "Git may have finished the commit, so check the history."
            }
            Self::SaveConflict | Self::Discard | Self::DiscardPart => "No file changed.",
            Self::CreateBranch | Self::RenameBranch | Self::DeleteBranch => {
                "L1 Git rereads the branch to see what changed."
            }
            Self::CreateTag | Self::DeleteTag => "L1 Git rereads the tag to see what changed.",
            Self::Checkout | Self::UndoCheckout | Self::RedoCheckout => {
                "L1 Git rereads HEAD to see whether Git moved it."
            }
            Self::StashPush
            | Self::StashApply
            | Self::StashPop
            | Self::StashDrop
            | Self::UndoStash
            | Self::RedoStash => {
                "L1 Git rereads the worktree and the stash list to see what changed."
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
    as_user: bool,
    lazy_fetch: bool,
}

const WRITE_STDOUT_CAP: usize = 1024 * 1024;

impl<'a> Write<'a> {
    pub(crate) fn new(txn: &'a Txn<'_>, dir: &'a Path, args: &[&'a str]) -> Self {
        Self::on_index(txn, dir, txn.copy(), args)
    }

    pub(crate) fn on_scratch(
        txn: &'a Txn<'_>,
        scratch: &'a ScratchIndex,
        args: &[&'a str],
    ) -> Self {
        Self::on_index(txn, txn.root(), scratch.index(), args)
            .object_directory(scratch.objects())
            .alternate_object_directory(txn.objects())
    }

    /// Hooks are off, because Git would run `post-index-change` against a
    /// private index. That index stays whole, because writing a split index
    /// makes a new shared index and can expire the one the real index names.
    fn on_index(txn: &'a Txn<'_>, dir: &'a Path, index: &'a Path, args: &[&'a str]) -> Self {
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
                ("GIT_INDEX_FILE", index.as_os_str()),
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

    pub(crate) fn branch(txn: &'a RefTxn<'_>, args: &[&'a str]) -> Self {
        let mut all = vec!["branch"];
        all.extend(args);
        Self {
            dir: txn.root(),
            args: all,
            env: Vec::new(),
            input: None,
            cap: Some(WRITE_STDOUT_CAP),
            as_user: true,
            lazy_fetch: false,
        }
    }

    pub(crate) fn tag(txn: &'a RefTxn<'_>, args: &[&'a str], message: &str) -> Self {
        let mut all = vec!["tag"];
        all.extend(args);
        Self {
            dir: txn.root(),
            args: all,
            env: Vec::new(),
            input: Some(message.as_bytes().to_vec()),
            cap: Some(WRITE_STDOUT_CAP),
            as_user: true,
            lazy_fetch: false,
        }
    }

    /// With no `GIT_REFLOG_ACTION`, HEAD's reflog reads `checkout: moving from
    /// A to B`, which `git switch -` reads.
    /// `git stash` runs as the user, on the real index, with hooks on. No
    /// `GIT_LITERAL_PATHSPECS`: a pathspec file uses `:(literal)` instead.
    pub(crate) fn stash(txn: &'a RefTxn<'_>, args: &[&'a str]) -> Self {
        let mut all = vec!["stash"];
        all.extend(args);
        Self {
            dir: txn.root(),
            args: all,
            env: Vec::new(),
            input: None,
            cap: Some(WRITE_STDOUT_CAP),
            as_user: true,
            lazy_fetch: false,
        }
    }

    pub(crate) fn switch(txn: &'a RefTxn<'_>, args: &[&'a str]) -> Self {
        let mut all = vec![
            "-c",
            "core.quotePath=false",
            "switch",
            "--quiet",
            "--no-overwrite-ignore",
        ];
        all.extend(args);
        Self {
            dir: txn.root(),
            args: all,
            env: Vec::new(),
            input: None,
            cap: None,
            as_user: true,
            lazy_fetch: true,
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
            command
        };
        if self.lazy_fetch {
            without_prompts(&mut command);
        }
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

pub(crate) fn install_tracking(
    root: &Path,
    config: &Path,
    branch: &crate::BranchRef,
    remote: &str,
    destination: &crate::BranchRef,
    reads: Deadline,
    unchanged: impl Fn() -> Result<bool, RepositoryError>,
) -> Result<(), RepositoryError> {
    install_config_values(
        root,
        config,
        &[
            (format!("branch.{}.remote", branch.name()), remote),
            (
                format!("branch.{}.merge", branch.name()),
                destination.as_str(),
            ),
        ],
        reads,
        unchanged,
        "Could not set upstream atomically. Check Git's config lock and branch settings.",
    )
}

pub(crate) fn install_config_values(
    root: &Path,
    config: &Path,
    values: &[(String, &str)],
    reads: Deadline,
    unchanged: impl Fn() -> Result<bool, RepositoryError>,
    failure_message: &'static str,
) -> Result<(), RepositoryError> {
    use std::{fs, io::Write as _};
    let failed = |step: &str| {
        RepositoryError::new(
            ErrorKind::GitFailed,
            format!("{failure_message} Could not {step}."),
        )
    };
    let lock_path = config.with_extension("lock");
    let mut lock = ConfigLock {
        file: private_config_file(&lock_path)
            .map_err(|error| failed(&format!("create the config lock ({error})")))?,
        path: lock_path,
    };
    let metadata = fs::symlink_metadata(config)
        .map_err(|error| failed(&format!("inspect the config ({error})")))?;
    if !metadata.is_file() {
        return Err(failed("replace a non-file config"));
    }
    let bytes = fs::read(config).map_err(|error| failed(&format!("read the config ({error})")))?;
    let stage_path = config.with_extension(format!(
        "l1git-{}-{}",
        std::process::id(),
        CONFIG_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let stage_file = private_config_file(&stage_path)
        .map_err(|error| failed(&format!("create the staged config ({error})")))?;
    drop(stage_file);
    let stage = StagedConfig(stage_path);
    fs::write(&stage.0, &bytes)
        .map_err(|error| failed(&format!("write the staged config ({error})")))?;
    let stage_name = stage
        .0
        .to_str()
        .ok_or_else(|| failed("encode the staged config path"))?;
    for (key, value) in values {
        let mut command = super::base(root, false);
        command.args(["config", "--file", stage_name, "--replace-all", key, value]);
        let output = execute(command, reads, None, Some(1024))?;
        if !output.status.success() {
            return Err(failed("edit the staged config with Git"));
        }
    }
    if !unchanged()?
        || fs::read(config).map_err(|error| failed(&format!("recheck the config ({error})")))?
            != bytes
    {
        return Err(failed("save over an externally changed config"));
    }
    lock.file
        .set_permissions(metadata.permissions())
        .map_err(|error| failed(&format!("preserve config permissions ({error})")))?;
    lock.file
        .write_all(
            &fs::read(&stage.0)
                .map_err(|error| failed(&format!("read the staged config ({error})")))?,
        )
        .map_err(|error| failed(&format!("write the config lock ({error})")))?;
    lock.file
        .sync_all()
        .map_err(|error| failed(&format!("flush the config lock ({error})")))?;
    if !unchanged()?
        || fs::read(config).map_err(|error| failed(&format!("recheck the config ({error})")))?
            != bytes
    {
        return Err(failed("save over an externally changed config"));
    }
    if !lock.owns_path() {
        return Err(failed("verify config lock ownership"));
    }
    fs::rename(&lock.path, config)
        .map_err(|error| failed(&format!("replace the config ({error})")))?;
    Ok(())
}

static CONFIG_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct ConfigLock {
    path: std::path::PathBuf,
    file: std::fs::File,
}

impl ConfigLock {
    fn owns_path(&self) -> bool {
        if !std::fs::symlink_metadata(&self.path).is_ok_and(|metadata| metadata.is_file()) {
            return false;
        }
        let owned = self.file.try_clone().and_then(same_file::Handle::from_file);
        let current = same_file::Handle::from_path(&self.path);
        matches!((owned, current), (Ok(owned), Ok(current)) if owned == current)
    }
}

impl Drop for ConfigLock {
    fn drop(&mut self) {
        if self.owns_path() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct StagedConfig(std::path::PathBuf);
impl Drop for StagedConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn private_config_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
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

    #[test]
    fn staged_tracking_pair_is_not_installed_if_revalidation_fails() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let config = root.join("config");
        let original = b"[unrelated]\n value = keep\n";
        std::fs::write(&config, original).unwrap();
        let branch = crate::BranchRef::try_from("refs/heads/topic".to_owned()).unwrap();
        let destination = crate::BranchRef::try_from("refs/heads/published".to_owned()).unwrap();
        let result = install_tracking(
            root,
            &config,
            &branch,
            "origin",
            &destination,
            Deadline::start(
                super::super::LocalRead::BranchStatus,
                Duration::from_secs(30),
            ),
            || Ok(false),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&config).unwrap(), original);
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 1);
    }

    #[test]
    fn failed_second_config_edit_never_installs_the_first() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config");
        let original = b"[unrelated]\n value = keep\n";
        std::fs::write(&config, original).unwrap();
        let result = install_config_values(
            directory.path(),
            &config,
            &[
                ("remote.origin.url".into(), "secret"),
                ("invalid".into(), "no"),
            ],
            Deadline::of(super::super::LocalRead::BranchStatus),
            || Ok(true),
            "Failed",
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&config).unwrap(), original);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn external_common_config_edit_survives_final_guard() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config");
        std::fs::write(&config, b"[unrelated]\n value = before\n").unwrap();
        let calls = std::cell::Cell::new(0);
        let external = b"[unrelated]\n value = external\n";
        let result = install_config_values(
            directory.path(),
            &config,
            &[("remote.origin.url".into(), "secret")],
            Deadline::of(super::super::LocalRead::BranchStatus),
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    std::fs::write(&config, external).unwrap();
                }
                Ok(true)
            },
            "Failed",
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&config).unwrap(), external);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn cleanup_never_removes_a_replaced_config_lock() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.lock");
        let lock = ConfigLock {
            file: private_config_file(&path).unwrap(),
            path: path.clone(),
        };
        std::fs::rename(&path, directory.path().join("old-lock")).unwrap();
        std::fs::write(&path, b"another process").unwrap();
        drop(lock);
        assert_eq!(std::fs::read(path).unwrap(), b"another process");
    }
}
