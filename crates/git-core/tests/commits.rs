use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Limits, Operation, RepositoryError, StaleReason,
    worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[derive(Clone, Copy)]
enum Kind {
    Commit,
    Amend,
    EditMessage,
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
}

impl Repo {
    fn unborn() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            git(&root, &["config", key, value]);
        }
        Self { directory, root }
    }

    fn born() -> Self {
        let repo = Self::unborn();
        repo.put("a.txt", "one\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "--quiet", "-m", "initial"]);
        repo
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn coordinator(&self) -> Coordinator {
        Coordinator::new(Limits::default(), self.directory.path().join("undo"))
    }

    fn put(&self, path: &str, contents: &str) {
        fs::write(self.root.join(path), contents).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }

    fn status(&self) -> String {
        self.git(&["status", "--porcelain"])
    }

    fn staged_edit(&self, path: &str, contents: &str) {
        self.put(path, contents);
        self.git(&["add", path]);
    }

    fn request(&self, kind: Kind, message: &str) -> (Operation, Expect) {
        let status = worktree_status(self.path()).unwrap();
        let message = message.to_owned();
        let staged = status.staged_stamp;
        let operation = match kind {
            Kind::Commit => Operation::Commit { message, staged },
            Kind::Amend => Operation::Amend { message, staged },
            Kind::EditMessage => Operation::EditMessage { message },
        };
        (operation, Expect { head: status.head })
    }

    fn write(&self, kind: Kind, message: &str) -> Result<Applied, RepositoryError> {
        let (operation, expect) = self.request(kind, message);
        self.coordinator().write(self.path(), &operation, &expect)
    }

    fn undo(&self, applied: &Applied) {
        self.coordinator().undo(self.path(), applied.id).unwrap();
    }

    fn redo(&self, applied: &Applied) {
        self.coordinator().redo(self.path(), applied.id).unwrap();
    }

    fn refs(&self) -> String {
        self.git(&["for-each-ref", "--format=%(refname) %(objectname)"])
            + &self.git(&["symbolic-ref", "-q", "HEAD"])
    }
}

fn refused(result: Result<Applied, RepositoryError>, kind: ErrorKind) -> RepositoryError {
    let error = result.expect_err("the write should refuse");
    assert_eq!(error.kind, kind, "{}", error.message);
    error
}

#[test]
fn commits_the_staged_files_and_undoes_and_redoes_the_branch_move() {
    let repo = Repo::born();
    let parent = repo.head();
    repo.staged_edit("a.txt", "two\n");
    repo.put("unstaged.txt", "not staged\n");
    let applied = repo.write(Kind::Commit, "Update a\n\nBody.\n").unwrap();
    let made = repo.head();
    assert_eq!(
        repo.git(&["log", "-1", "--format=%B%P"]),
        format!("Update a\n\nBody.\n{parent}\n")
    );
    assert_eq!(repo.status(), "?? unstaged.txt\n");
    let reflog = repo.git(&["reflog", "-1", "--format=%gs", "main"]);
    assert!(reflog.contains("Update a"), "{reflog}");

    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
    assert_eq!(repo.status(), "M  a.txt\n?? unstaged.txt\n");
    repo.git(&["reflog", "expire", "--expire-unreachable=now", "--all"]);
    repo.git(&["gc", "--quiet", "--prune=now"]);
    repo.redo(&applied);
    assert_eq!(repo.head(), made);
    assert_eq!(repo.status(), "?? unstaged.txt\n");
    repo.git(&["fsck", "--no-progress"]);
}

#[test]
fn amends_keeping_parents_and_author_and_undo_leaves_the_change_staged() {
    let repo = Repo::born();
    repo.staged_edit("b.txt", "b\n");
    repo.git(&["commit", "--quiet", "-m", "second"]);
    let old = repo.head();
    let kept = repo.git(&["log", "-1", "--format=%P %an %ae %ad"]);
    repo.staged_edit("c.txt", "c\n");
    let applied = repo.write(Kind::Amend, "second, amended\n").unwrap();
    assert_ne!(repo.head(), old);
    assert_eq!(repo.git(&["log", "-1", "--format=%P %an %ae %ad"]), kept);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "second, amended\n");
    assert_eq!(repo.status(), "");

    repo.undo(&applied);
    assert_eq!(repo.head(), old);
    assert_eq!(repo.status(), "A  c.txt\n");
    repo.git(&["reflog", "expire", "--expire-unreachable=now", "--all"]);
    repo.git(&["gc", "--quiet", "--prune=now"]);
    repo.redo(&applied);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "second, amended\n");
    repo.undo(&applied);
    assert_eq!(repo.head(), old);
    repo.git(&["fsck", "--no-progress"]);
}

#[test]
fn edits_a_message_alone_and_keeps_staged_changes_out_even_on_an_empty_commit() {
    let repo = Repo::born();
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "empty"]);
    let old = repo.head();
    let tree = repo.git(&["rev-parse", "HEAD^{tree}", "HEAD^"]);
    repo.staged_edit("a.txt", "staged\n");
    let applied = repo.write(Kind::EditMessage, "renamed\n").unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD^{tree}", "HEAD^"]), tree);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "renamed\n");
    assert_eq!(repo.status(), "M  a.txt\n");
    repo.undo(&applied);
    assert_eq!(repo.head(), old);
    assert_eq!(repo.status(), "M  a.txt\n");
}

#[test]
fn makes_a_first_commit_and_undo_leaves_head_unborn_with_the_file_staged() {
    let repo = Repo::unborn();
    repo.staged_edit("f", "first\n");
    let applied = repo.write(Kind::Commit, "First\n").unwrap();
    assert_eq!(repo.git(&["log", "--format=%s|%P"]), "First|\n");
    repo.undo(&applied);
    assert_eq!(repo.git(&["for-each-ref"]), "");
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/main\n");
    assert_eq!(repo.status(), "A  f\n");
    repo.redo(&applied);
    assert_eq!(repo.git(&["log", "--format=%s"]), "First\n");
}

#[test]
fn commits_on_a_detached_head_and_undo_keeps_it_detached() {
    let repo = Repo::born();
    repo.git(&["checkout", "--quiet", "--detach"]);
    let parent = repo.head();
    repo.staged_edit("a.txt", "two\n");
    let applied = repo.write(Kind::Commit, "Detached\n").unwrap();
    assert_eq!(
        repo.git(&["rev-parse", "HEAD^"]).trim(),
        parent,
        "parent is the old HEAD"
    );
    assert_eq!(repo.git(&["rev-parse", "main"]).trim(), parent);
    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
    assert!(
        git_fails(&repo.root, &["symbolic-ref", "-q", "HEAD"]),
        "HEAD stays detached"
    );
    assert_eq!(repo.status(), "M  a.txt\n");
}

fn git_fails(path: &Path, args: &[&str]) -> bool {
    !Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdout(Stdio::null())
        .status()
        .unwrap()
        .success()
}

#[test]
fn refuses_an_empty_message_and_nothing_staged_without_changing_anything() {
    let repo = Repo::born();
    let before = repo.refs();
    refused(
        repo.write(Kind::Commit, "Nothing\n"),
        ErrorKind::UnchangedPath,
    );
    repo.put("u.txt", "untracked\n");
    refused(
        repo.write(Kind::Commit, "Nothing\n"),
        ErrorKind::UnchangedPath,
    );
    repo.staged_edit("a.txt", "two\n");
    refused(repo.write(Kind::Commit, "  \n\n"), ErrorKind::GitFailed);
    assert_eq!(repo.refs(), before);
    assert_eq!(repo.status(), "M  a.txt\n?? u.txt\n");
}

#[test]
fn refuses_a_stale_staged_list_or_a_moved_head() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    let (operation, expect) = repo.request(Kind::Commit, "Mine\n");
    repo.staged_edit("b.txt", "b\n");
    refused(
        repo.coordinator().write(repo.path(), &operation, &expect),
        ErrorKind::StaleView {
            reason: StaleReason::StagedChanged,
        },
    );
    let (operation, expect) = repo.request(Kind::Commit, "Mine\n");
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "other"]);
    let other = repo.head();
    refused(
        repo.coordinator().write(repo.path(), &operation, &expect),
        ErrorKind::StaleView {
            reason: StaleReason::StagedChanged,
        },
    );
    assert_eq!(repo.head(), other);
    repo.staged_edit("a.txt", "three\n");
    let (operation, expect) = repo.request(Kind::Commit, "Mine\n");
    repo.put("a.txt", "edited after the view\n");
    repo.coordinator()
        .write(repo.path(), &operation, &expect)
        .expect("an unstaged edit does not make the staged list stale");
}

#[test]
fn reports_a_race_that_moved_head_to_another_branch_and_offers_undo() {
    let repo = Repo::born();
    repo.git(&["branch", "other"]);
    let parent = repo.head();
    let hooks = repo.directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    hook(
        &hooks,
        "pre-commit",
        "git symbolic-ref HEAD refs/heads/other\n",
    );
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    repo.staged_edit("a.txt", "two\n");
    let error = refused(repo.write(Kind::Commit, "Raced\n"), ErrorKind::Raced);
    assert!(error.message.contains("other"), "{}", error.message);
    assert_eq!(repo.git(&["rev-parse", "main"]).trim(), parent);
    repo.git(&["config", "core.hooksPath", "/dev/null"]);
    let history = repo.coordinator().undo_history(repo.path()).unwrap();
    let entry = history.undo.expect("the raced commit can be undone");
    repo.undo(&entry);
    assert_eq!(repo.git(&["rev-parse", "other"]).trim(), parent);
}

fn hook(dir: &Path, name: &str, body: &str) {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn refuses_during_a_merge_or_with_an_unmerged_path() {
    let repo = Repo::born();
    let head = repo.head();
    repo.staged_edit("a.txt", "two\n");
    fs::write(repo.root.join(".git/MERGE_HEAD"), format!("{head}\n")).unwrap();
    let error = refused(repo.write(Kind::Commit, "Merge\n"), ErrorKind::Conflict);
    assert!(error.message.contains("merge"), "{}", error.message);
    fs::remove_file(repo.root.join(".git/MERGE_HEAD")).unwrap();
    fs::write(repo.root.join(".git/BISECT_LOG"), "").unwrap();
    repo.write(Kind::Commit, "During a bisect\n")
        .expect("a bisect does not block a commit");
}

#[test]
fn a_failing_hook_answers_hook_failed_with_its_output_and_changes_nothing() {
    let repo = Repo::born();
    let hooks = repo.directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    repo.staged_edit("a.txt", "two\n");
    let before = repo.refs();
    for name in ["pre-commit", "commit-msg"] {
        hook(
            &hooks,
            name,
            "echo 'lint failed: TODO'\necho oops >&2\nexit 1\n",
        );
        let error = refused(repo.write(Kind::Commit, "Hooked\n"), ErrorKind::HookFailed);
        let output = error.output.unwrap_or_default();
        assert!(output.contains("lint failed: TODO"), "{output}");
        assert!(output.contains("oops"), "{output}");
        assert!(error.message.contains(name), "{}", error.message);
        fs::remove_file(hooks.join(name)).unwrap();
    }
    hook(&hooks, "post-commit", "exit 1\n");
    repo.write(Kind::Commit, "Post-commit failures do not count\n")
        .expect("a failing post-commit hook leaves the commit made");
    assert_ne!(repo.refs(), before);
}

#[test]
fn a_missing_identity_answers_missing_identity() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    repo.git(&["config", "user.useConfigOnly", "true"]);
    repo.git(&["config", "user.name", ""]);
    let error = refused(
        repo.write(Kind::Commit, "Who\n"),
        ErrorKind::MissingIdentity,
    );
    assert!(error.message.contains("name"), "{}", error.message);
    assert_eq!(repo.status(), "M  a.txt\n");
}

#[test]
fn signing_that_cannot_run_fails_without_a_commit() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    repo.git(&["config", "commit.gpgSign", "true"]);
    repo.git(&["config", "gpg.program", "/nonexistent/gpg"]);
    let before = repo.refs();
    let error = refused(repo.write(Kind::Commit, "Signed\n"), ErrorKind::GitFailed);
    assert!(error.message.contains("gpg"), "{}", error.message);
    assert_eq!(repo.refs(), before);
    assert_eq!(repo.status(), "M  a.txt\n");
}

#[test]
fn undo_refuses_after_head_moved_and_during_a_merge() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    let applied = repo.write(Kind::Commit, "Mine\n").unwrap();
    let made = repo.head();
    fs::write(repo.root.join(".git/MERGE_HEAD"), format!("{made}\n")).unwrap();
    refused(
        repo.coordinator().undo(repo.path(), applied.id),
        ErrorKind::Conflict,
    );
    fs::remove_file(repo.root.join(".git/MERGE_HEAD")).unwrap();
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "other"]);
    refused(
        repo.coordinator().undo(repo.path(), applied.id),
        ErrorKind::StaleView {
            reason: StaleReason::HeadMoved,
        },
    );
    assert_eq!(repo.git(&["rev-parse", "HEAD^"]).trim(), made);
}

#[test]
fn a_commit_git_made_before_it_died_keeps_its_undo_entry() {
    let repo = Repo::born();
    let parent = repo.head();
    let hooks = repo.directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    hook(&hooks, "post-commit", "kill -9 $PPID\n");
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    repo.staged_edit("a.txt", "two\n");
    let applied = repo
        .write(Kind::Commit, "Landed\n")
        .expect("the ref moved, so the commit counts");
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Landed\n");
    repo.git(&["config", "core.hooksPath", "/dev/null"]);
    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
    assert_eq!(repo.status(), "M  a.txt\n");
}

#[test]
fn hooks_see_the_users_environment_not_l1_gits() {
    let repo = Repo::born();
    let hooks = repo.directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let seen = repo.directory.path().join("seen");
    hook(
        &hooks,
        "pre-commit",
        &format!(
            "printf '%s|%s|%s|%s' \"$GIT_CONFIG_PARAMETERS\" \"$GIT_OPTIONAL_LOCKS\" \"$GIT_NO_LAZY_FETCH\" \"$(git rev-parse --short HEAD)\" > '{}'\n",
            seen.display()
        ),
    );
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    repo.staged_edit("a.txt", "two\n");
    let short = repo.git(&["rev-parse", "--short", "HEAD"]);
    repo.write(Kind::Commit, "Clean env\n").unwrap();
    assert_eq!(
        fs::read_to_string(&seen).unwrap(),
        format!("|||{}", short.trim())
    );
    let reflog = repo.git(&["reflog", "-1", "--format=%gs", "main"]);
    assert_eq!(reflog, "commit: Clean env\n");
}

#[test]
fn undo_of_a_commit_moves_only_the_ref_and_runs_its_hooks() {
    let repo = Repo::born();
    let parent = repo.head();
    repo.staged_edit("a.txt", "two\n");
    let applied = repo.write(Kind::Commit, "Ref only\n").unwrap();
    let hooks = repo.directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let seen = repo.directory.path().join("seen");
    hook(
        &hooks,
        "reference-transaction",
        &format!("cat > /dev/null\necho \"$1\" >> '{}'\n", seen.display()),
    );
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    fs::write(repo.root.join(".git/index.lock"), "").unwrap();
    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
    assert!(
        repo.root.join(".git/index.lock").exists(),
        "another tool's index.lock is left alone"
    );
    assert!(
        fs::read_to_string(&seen).unwrap().contains("committed"),
        "reference-transaction ran"
    );
}
