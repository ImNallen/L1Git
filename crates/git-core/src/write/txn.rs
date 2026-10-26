use super::{
    Applied, Change, Operation, Repo,
    store::{LockedStore, Log, Step},
};
use crate::{
    ErrorKind, RepositoryError,
    git::{self, HeldIndexLock, Write, WriteDeadline},
};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const PREFIX: &str = "l1git-";

pub(crate) const HOOK_OFF: &str = "L1GIT_HOOK_OFF";

/// Only `commit_write` and `commit_step` replace the index with the copy, so
/// nothing reaches the index before the undo history names it.
pub(crate) struct Txn<'r> {
    repo: &'r Repo,
    lock: PathBuf,
    copy: PathBuf,
    deadline: WriteDeadline,
    hooks: Hooks,
    published: bool,
    _held: HeldIndexLock,
}

/// `core.hooksPath` does not turn off a hook that config defines, so each
/// command of the transaction turns those off by name. The name can hold
/// `=`, which `-c` would split on, so the value comes from
/// [`HOOK_OFF`] through `--config-env`, which splits on the last `=`.
struct Hooks {
    file: bool,
    disabled: Vec<String>,
}

impl Hooks {
    fn of(repo: &Repo, deadline: WriteDeadline) -> Result<Self, RepositoryError> {
        let found = git::run(
            &repo.root,
            &[
                "config",
                "-z",
                "--get-regexp",
                r"^hook\..*\.event$",
                "^post-index-change$",
            ],
            deadline.reads(),
        )?;
        let disabled = match found.status.code() {
            Some(0) => found
                .stdout
                .split(|byte| *byte == 0)
                .filter_map(|record| {
                    let key = git::text(record.split(|byte| *byte == b'\n').next()?);
                    let name = key.strip_prefix("hook.")?.strip_suffix(".event")?;
                    Some(format!("--config-env=hook.{name}.enabled={HOOK_OFF}"))
                })
                .collect(),
            Some(1) => Vec::new(),
            _ => return Err(git::read_failed()),
        };
        Ok(Self {
            file: executable(&repo.hook),
            disabled,
        })
    }

    fn any(&self) -> bool {
        self.file || !self.disabled.is_empty()
    }
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(path: &Path) -> bool {
    path.is_file()
}

fn private(repo: &Repo, name: &str) -> PathBuf {
    repo.git_dir
        .join(format!("{PREFIX}{name}.{}", std::process::id()))
}

impl<'r> Txn<'r> {
    pub(super) fn begin(repo: &'r Repo, deadline: WriteDeadline) -> Result<Self, RepositoryError> {
        let held = HeldIndexLock::begin()?;
        let hooks = Hooks::of(repo, deadline)?;
        let lock = repo.index.with_extension("lock");
        match fs::File::options().write(true).create_new(true).open(&lock) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(RepositoryError::new(
                    ErrorKind::LockHeld,
                    format!(
                        "Another Git process is changing this worktree's index, so {} exists. Wait for it to finish, then try again. If no Git process is running, delete that file.",
                        lock.display()
                    ),
                ));
            }
            Err(error) => {
                return Err(RepositoryError::new(
                    ErrorKind::GitFailed,
                    format!("L1 Git could not lock the index: {error}"),
                ));
            }
        }
        let txn = Self {
            repo,
            copy: private(repo, "index"),
            lock,
            deadline,
            hooks,
            published: false,
            _held: held,
        };
        txn.sweep();
        txn.copy_index().map_err(|error| {
            RepositoryError::new(
                ErrorKind::GitFailed,
                format!("L1 Git could not copy the index: {error}"),
            )
        })?;
        Ok(txn)
    }

    pub(super) const fn repo(&self) -> &'r Repo {
        self.repo
    }

    pub(super) const fn deadline(&self) -> WriteDeadline {
        self.deadline
    }

    pub(crate) fn copy(&self) -> &Path {
        &self.copy
    }

    pub(crate) fn disabled_hooks(&self) -> &[String] {
        &self.hooks.disabled
    }

    /// Git reads an entry whose file changed in the same second as the index
    /// was written by its contents, judged by the index file's mtime. A copy
    /// with a newer mtime would hide a same-size edit, so it keeps the
    /// original's.
    fn copy_index(&self) -> io::Result<()> {
        let modified = match fs::metadata(&self.repo.index) {
            Ok(metadata) => metadata.modified()?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        fs::copy(&self.repo.index, &self.copy)?;
        fs::File::options()
            .write(true)
            .open(&self.copy)?
            .set_modified(modified)
    }

    fn sweep(&self) {
        let Ok(names) = fs::read_dir(&self.repo.git_dir) else {
            return;
        };
        for name in names.flatten() {
            if name.file_name().to_string_lossy().starts_with(PREFIX) {
                let path = name.path();
                let _ = fs::remove_file(&path).or_else(|_| fs::remove_dir_all(&path));
            }
        }
    }

    pub(super) fn git<'a>(&'a self, args: &[&'a str]) -> Write<'a> {
        Write::new(self, &self.repo.root, args)
    }

    pub(super) fn scratch(&self, name: &str) -> PathBuf {
        private(self.repo, name)
    }

    /// Records the write, then replaces the index, then marks the record
    /// done. A crash between the first two leaves a pending record that the
    /// next locked request settles from the index.
    pub(super) fn commit_write(
        mut self,
        store: &LockedStore,
        log: &Log,
        operation: &Operation,
        change: &Change,
    ) -> Result<(Applied, Published), RepositoryError> {
        let (applied, recorded) = store.record(&self, log, operation, change)?;
        let published = self.publish(change)?;
        recorded.confirm();
        Ok((applied, published))
    }

    /// Replaces the index with an undo or redo of the entry the log names
    /// next, then saves the stepped log. A crash between the two leaves the
    /// log one step behind, and repeating the step finds nothing left to do.
    pub(super) fn commit_step(
        mut self,
        store: &LockedStore,
        step: Step,
        change: &Change,
    ) -> Result<Published, RepositoryError> {
        let published = self.publish(change)?;
        let _ = store.save(step.log());
        Ok(published)
    }

    fn publish(&mut self, change: &Change) -> Result<Published, RepositoryError> {
        let renamed = if self.copy.exists() {
            fs::rename(&self.copy, &self.lock)
                .and_then(|()| fs::rename(&self.lock, &self.repo.index))
        } else {
            fs::remove_file(&self.lock)
        };
        renamed.map_err(|error| {
            RepositoryError::new(
                ErrorKind::GitFailed,
                format!("L1 Git could not replace the index, so it is unchanged: {error}"),
            )
        })?;
        self.published = true;
        Ok(Published {
            root: self.repo.root.clone(),
            deadline: self.deadline,
            skip_worktree: change.touches_skip_worktree(),
            hooks: self.hooks.any(),
        })
    }
}

pub(crate) struct Published {
    root: PathBuf,
    deadline: WriteDeadline,
    skip_worktree: bool,
    hooks: bool,
}

impl Published {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) const fn skip_worktree(&self) -> bool {
        self.skip_worktree
    }

    /// Runs `post-index-change` after the write let go of its locks, as Git
    /// runs it after it lets go of `index.lock`. Like Git, the write ignores
    /// how the hook ends.
    pub(super) fn run_hook(self) {
        if self.hooks {
            let _ = Write::post_index_change(&self).run(self.deadline);
        }
    }
}

impl Drop for Txn<'_> {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let mut copy_lock = self.copy.clone().into_os_string();
        copy_lock.push(".lock");
        for path in [
            self.copy.as_path(),
            Path::new(&copy_lock),
            self.lock.as_path(),
        ] {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Coordinator, Expect, Limits, git::LocalWrite, worktree_status};
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        let output = command.arg("-C").arg(root).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    fn stage(path: &str, file: &str) -> (Operation, Expect) {
        let status = worktree_status(path).unwrap();
        let entries = status
            .entries
            .into_iter()
            .filter(|entry| serde_json::to_value(entry).unwrap()["path"] == file)
            .collect();
        (
            Operation::StageFiles { entries },
            Expect { head: status.head },
        )
    }

    fn crash(coordinator: &Coordinator, path: &str, published: bool) {
        let (operation, expect) = stage(path, "f");
        coordinator
            .locked(
                path,
                LocalWrite::StageFiles,
                |repo, store, log, deadline| {
                    let (mut txn, change) = operation.apply(&repo, deadline, &expect)?;
                    let (_, recorded) = store.record(&txn, &log, &operation, &change)?;
                    if published {
                        txn.publish(&change)?;
                    }
                    std::mem::forget(recorded);
                    std::mem::forget(txn);
                    Ok(())
                },
            )
            .unwrap();
    }

    #[test]
    fn the_next_write_keeps_a_crashed_write_only_if_it_reached_the_index() {
        for published in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap().join("repo");
            fs::create_dir(&root).unwrap();
            git(&root, &["init", "--quiet", "--initial-branch=main"]);
            for (key, value) in [
                ("user.name", "Ada"),
                ("user.email", "ada@example.test"),
                ("core.hooksPath", "/dev/null"),
            ] {
                git(&root, &["config", key, value]);
            }
            fs::write(root.join("f"), "one\n").unwrap();
            fs::write(root.join("g"), "one\n").unwrap();
            git(&root, &["add", "f", "g"]);
            git(&root, &["commit", "--quiet", "-m", "initial"]);
            fs::write(root.join("f"), "two\n").unwrap();
            fs::write(root.join("g"), "two\n").unwrap();
            let path = root.to_str().unwrap();
            let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));
            let status = || git(&root, &["status", "--porcelain"]);

            crash(&coordinator, path, published);
            let _ = fs::remove_file(root.join(".git/index.lock"));
            let crashed = if published { "M  f\n" } else { " M f\n" };
            assert_eq!(status(), format!("{crashed} M g\n"), "{published}");
            let history = coordinator.undo_history(path).unwrap();
            assert_eq!((history.undo, history.redo), (None, None), "{published}");

            let (operation, expect) = stage(path, "g");
            let staged = coordinator.write(path, &operation, &expect).unwrap();
            coordinator.undo(path, staged.id).unwrap();
            let history = coordinator.undo_history(path).unwrap();
            assert_eq!(history.redo, Some(staged), "{published}");
            match history.undo {
                Some(kept) if published => {
                    coordinator.undo(path, kept.id).unwrap();
                    assert_eq!(status(), " M f\n M g\n");
                }
                None if !published => assert_eq!(status(), " M f\n M g\n"),
                other => panic!("published {published}: {other:?}"),
            }
        }
    }
}
