use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Head, Limits, Oid, Operation, RepositoryError,
    StaleReason, Start,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
    let (ok, stdout, stderr) = run_git(path, args);
    assert!(ok, "git {args:?}: {stderr}");
    stdout
}

fn run_git(path: &Path, args: &[&str]) -> (bool, String, String) {
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
    (
        output.status.success(),
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn configure(root: &Path) {
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("commit.gpgSign", "false"),
        ("core.hooksPath", "/dev/null"),
    ] {
        git(root, &["config", key, value]);
    }
}

fn commit(root: &Path, files: &[(&str, &str)], message: &str) {
    for (path, text) in files {
        fs::write(root.join(path), text).unwrap();
        git(root, &["add", path]);
    }
    git(root, &["commit", "--quiet", "-m", message]);
}

/// A clone of a repository with `main`, `feature`, which changes
/// `both.txt` and adds `feature.txt`, and `topic`, which only the remote
/// has. Locally only `main` exists.
struct Repo {
    _directory: TempDir,
    root: PathBuf,
    coordinator: Coordinator,
}

impl Repo {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let upstream = base.join("upstream");
        fs::create_dir_all(&upstream).unwrap();
        git(&upstream, &["init", "--quiet", "--initial-branch=main"]);
        configure(&upstream);
        commit(
            &upstream,
            &[("shared.txt", "shared\n"), ("both.txt", "one\n")],
            "base",
        );
        git(&upstream, &["switch", "--quiet", "-c", "feature"]);
        commit(
            &upstream,
            &[("both.txt", "two\n"), ("feature.txt", "feature\n")],
            "feature",
        );
        git(&upstream, &["switch", "--quiet", "-c", "topic", "main"]);
        commit(&upstream, &[("topic.txt", "topic\n")], "topic");
        git(&upstream, &["switch", "--quiet", "main"]);
        let root = base.join("repo");
        git(
            &base,
            &["clone", "--quiet", upstream.to_str().unwrap(), "repo"],
        );
        configure(&root);
        let coordinator = Coordinator::new(Limits::default(), base.join("undo"));
        Self {
            _directory: directory,
            root,
            coordinator,
        }
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn oid(&self, revision: &str) -> Oid {
        Oid::try_from(self.git(&["rev-parse", revision])).unwrap()
    }

    fn head(&self) -> Head {
        let oid = self.oid("HEAD").as_str().to_owned();
        match self.symbolic_head() {
            Some(reference) => Head::Attached { reference, oid },
            None => Head::Detached { oid },
        }
    }

    fn symbolic_head(&self) -> Option<String> {
        let (attached, reference, _) = run_git(&self.root, &["symbolic-ref", "-q", "HEAD"]);
        attached.then_some(reference)
    }

    fn local(&self, name: &str) -> Start {
        let reference = format!("refs/heads/{name}");
        Start::Local {
            oid: self.oid(&reference),
            reference: reference.try_into().unwrap(),
        }
    }

    fn remote(&self, name: &str) -> Start {
        let reference = format!("refs/remotes/origin/{name}");
        Start::Remote {
            oid: self.oid(&reference),
            reference: reference.try_into().unwrap(),
        }
    }

    fn commit_at(&self, revision: &str) -> Start {
        Start::Commit {
            oid: self.oid(revision),
        }
    }

    fn checkout(&self, target: Start) -> Result<Applied, RepositoryError> {
        let expect = Expect { head: self.head() };
        self.checkout_seen(target, &expect)
    }

    fn checkout_seen(&self, target: Start, expect: &Expect) -> Result<Applied, RepositoryError> {
        self.coordinator
            .write(self.path(), &Operation::Checkout { target }, expect)
    }

    fn undo(&self, applied: &Applied) -> Result<Applied, RepositoryError> {
        self.coordinator.undo(self.path(), applied.id)
    }

    fn redo(&self, applied: &Applied) -> Result<Applied, RepositoryError> {
        self.coordinator.redo(self.path(), applied.id)
    }

    fn state(&self) -> String {
        let head = self
            .symbolic_head()
            .unwrap_or_else(|| format!("detached {}", self.oid("HEAD").as_str()));
        let config: Vec<String> = self
            .git(&["config", "--local", "--list"])
            .lines()
            .filter(|line| line.starts_with("branch."))
            .map(str::to_owned)
            .collect();
        [
            self.git(&["for-each-ref", "--format=%(refname) %(objectname)"]),
            head,
            self.git(&["status", "--porcelain"]),
            self.git(&["ls-files", "-s"]),
            config.join("\n"),
        ]
        .join("\n--\n")
    }

    fn prune(&self) {
        self.git(&["reflog", "expire", "--expire=now", "--all"]);
        self.git(&["gc", "--quiet", "--prune=now"]);
    }

    fn next_undo(&self) -> Option<Applied> {
        self.coordinator.undo_history(self.path()).unwrap().undo
    }
}

fn refused(result: Result<Applied, RepositoryError>) -> RepositoryError {
    result.unwrap_err()
}

fn round_trip(repo: &Repo, before: &str, applied: &Applied) {
    let after = repo.state();
    repo.prune();
    repo.undo(applied).unwrap();
    assert_eq!(repo.state(), before, "undo");
    repo.prune();
    repo.redo(applied).unwrap();
    assert_eq!(repo.state(), after, "redo");
    repo.git(&["fsck", "--no-progress", "--connectivity-only"]);
}

fn hooks(repo: &Repo, name: &str, script: &str) {
    let dir = repo.root.join(".git/test-hooks");
    fs::create_dir_all(&dir).unwrap();
    let hook = dir.join(name);
    fs::write(&hook, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    repo.git(&["config", "core.hooksPath", dir.to_str().unwrap()]);
}

#[test]
fn checks_out_a_local_branch_and_undoes_and_redoes_it() {
    let repo = Repo::new();
    repo.git(&["branch", "--quiet", "feature", "origin/feature"]);
    let before = repo.state();
    let applied = repo.checkout(repo.local("feature")).unwrap();
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature");
    assert_eq!(repo.git(&["show", ":both.txt"]), "two");
    assert_eq!(
        repo.git(&["reflog", "-1", "--format=%gs", "HEAD"]),
        "checkout: moving from main to feature"
    );
    round_trip(&repo, &before, &applied);
}

#[test]
fn checks_out_a_remote_branch_as_a_new_tracking_branch_and_undo_deletes_it() {
    let repo = Repo::new();
    let before = repo.state();
    let applied = repo.checkout(repo.remote("topic")).unwrap();
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
    assert_eq!(repo.oid("refs/heads/topic"), repo.oid("origin/topic"));
    assert_eq!(repo.git(&["config", "branch.topic.remote"]), "origin");
    assert_eq!(
        repo.git(&["config", "branch.topic.merge"]),
        "refs/heads/topic"
    );
    round_trip(&repo, &before, &applied);
}

#[test]
fn undo_of_a_remote_checkout_puts_back_a_leftover_branch_section() {
    let repo = Repo::new();
    repo.git(&["config", "branch.topic.merge", "refs/heads/leftover"]);
    repo.git(&["config", "branch.topic.description", "kept"]);
    let before = repo.state();
    let applied = repo.checkout(repo.remote("topic")).unwrap();
    assert_eq!(
        repo.git(&["config", "branch.topic.merge"]),
        "refs/heads/topic"
    );
    round_trip(&repo, &before, &applied);
}

#[test]
fn a_remote_branch_whose_local_branch_exists_checks_out_that_branch() {
    let repo = Repo::new();
    repo.git(&["branch", "--quiet", "feature", "origin/feature"]);
    let before = repo.state();
    let refs = repo.git(&["for-each-ref", "refs/heads"]);
    let applied = repo.checkout(repo.remote("feature")).unwrap();
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature");
    assert_eq!(repo.git(&["for-each-ref", "refs/heads"]), refs);
    round_trip(&repo, &before, &applied);
}

#[test]
fn detaches_at_a_commit_and_comes_back_to_a_detached_commit_after_gc() {
    let repo = Repo::new();
    let before = repo.state();
    let applied = repo.checkout(repo.commit_at("origin/feature")).unwrap();
    assert_eq!(
        repo.head(),
        Head::Detached {
            oid: repo.oid("origin/feature").as_str().to_owned()
        }
    );
    round_trip(&repo, &before, &applied);
    repo.undo(&applied).unwrap();

    repo.git(&["switch", "--quiet", "--detach", "main"]);
    commit(
        &repo.root,
        &[("only.txt", "only here\n")],
        "on a detached HEAD",
    );
    let detached = repo.state();
    let leave = repo.checkout(repo.local("main")).unwrap();
    round_trip(&repo, &detached, &leave);
}

#[test]
fn carries_a_change_to_a_file_both_commits_share() {
    let repo = Repo::new();
    fs::write(repo.root.join("shared.txt"), "edited\n").unwrap();
    let before = repo.state();
    let applied = repo.checkout(repo.remote("feature")).unwrap();
    assert_eq!(
        repo.git(&["status", "--porcelain", "shared.txt"]),
        " M shared.txt"
    );
    round_trip(&repo, &before, &applied);
}

#[test]
fn refuses_a_change_git_would_overwrite_and_names_the_file() {
    let repo = Repo::new();
    fs::write(repo.root.join("both.txt"), "mine\n").unwrap();
    fs::write(repo.root.join("feature.txt"), "untracked\n").unwrap();
    let before = repo.state();
    let error = refused(repo.checkout(repo.remote("feature")));
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert!(error.message.contains("both.txt"), "{}", error.message);
    assert!(!error.message.contains("stash"), "{}", error.message);
    assert_eq!(repo.state(), before);
}

#[test]
fn refuses_to_overwrite_an_ignored_file() {
    let repo = Repo::new();
    fs::write(repo.root.join(".git/info/exclude"), "feature.txt\n").unwrap();
    fs::write(repo.root.join("feature.txt"), "secret\n").unwrap();
    let before = repo.state();
    let error = refused(repo.checkout(repo.remote("feature")));
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert!(error.message.contains("feature.txt"), "{}", error.message);
    assert_eq!(repo.state(), before);
    assert_eq!(
        fs::read_to_string(repo.root.join("feature.txt")).unwrap(),
        "secret\n"
    );
}

#[test]
fn refuses_a_change_the_target_already_holds() {
    for setup in [
        "stage the target's text",
        "stage a new file",
        "delete a file",
    ] {
        let repo = Repo::new();
        match setup {
            "stage the target's text" => {
                fs::write(repo.root.join("both.txt"), "two\n").unwrap();
                repo.git(&["add", "both.txt"]);
            }
            "stage a new file" => {
                fs::write(repo.root.join("feature.txt"), "feature\n").unwrap();
                repo.git(&["add", "feature.txt"]);
            }
            _ => fs::remove_file(repo.root.join("both.txt")).unwrap(),
        }
        let before = repo.state();
        let error = refused(repo.checkout(repo.remote("feature")));
        assert_eq!(
            error.kind,
            ErrorKind::Conflict,
            "{setup}: {}",
            error.message
        );
        assert!(error.message.contains(".txt"), "{setup}: {}", error.message);
        assert_eq!(repo.state(), before, "{setup}");
    }
}

#[test]
fn refuses_while_git_has_an_operation_in_progress() {
    let repo = Repo::new();
    repo.git(&["switch", "--quiet", "-c", "side"]);
    commit(&repo.root, &[("both.txt", "side\n")], "side");
    let merge = Command::new("git")
        .arg("-C")
        .arg(&repo.root)
        .args(["merge", "--quiet", "origin/feature"])
        .output()
        .unwrap();
    assert!(!merge.status.success());
    let before = repo.state();
    let error = refused(repo.checkout(repo.remote("topic")));
    assert_eq!(error.kind, ErrorKind::Conflict);
    assert!(
        error.message.starts_with("A merge is in progress"),
        "{}",
        error.message
    );
    assert_eq!(repo.state(), before);
    repo.git(&["merge", "--abort"]);

    for (file, name) in [
        ("CHERRY_PICK_HEAD", "A cherry-pick"),
        ("REVERT_HEAD", "A revert"),
        ("rebase-merge", "A rebase"),
        ("rebase-apply", "A rebase or am"),
        ("BISECT_LOG", "A bisect"),
    ] {
        let path = repo.root.join(".git").join(file);
        if file.starts_with("rebase") {
            fs::create_dir(&path).unwrap();
        } else {
            fs::write(&path, repo.oid("HEAD").as_str()).unwrap();
        }
        let error = refused(repo.checkout(repo.remote("topic")));
        assert_eq!(error.kind, ErrorKind::Conflict, "{file}");
        assert!(error.message.starts_with(name), "{file}: {}", error.message);
        let _ = fs::remove_file(&path).or_else(|_| fs::remove_dir(&path));
    }
}

#[test]
fn a_stale_head_or_a_moved_target_refuses() {
    let repo = Repo::new();
    repo.git(&["branch", "--quiet", "feature", "origin/feature"]);
    let seen = Expect { head: repo.head() };
    commit(&repo.root, &[("later.txt", "later\n")], "later");
    let before = repo.state();
    let error = refused(repo.checkout_seen(repo.local("feature"), &seen));
    assert_eq!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::HeadMoved
        }
    );
    assert_eq!(repo.state(), before);

    let target = repo.local("feature");
    repo.git(&["branch", "--quiet", "-f", "feature", "origin/main"]);
    let before = repo.state();
    let error = refused(repo.checkout(target));
    assert_eq!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::BranchChanged
        }
    );
    assert_eq!(repo.state(), before);
}

#[test]
fn a_failing_post_checkout_hook_keeps_the_entry_and_shows_its_output() {
    let repo = Repo::new();
    hooks(
        &repo,
        "post-checkout",
        "#!/bin/sh\necho lint said no >&2\nexit 3\n",
    );
    let before = repo.state();
    let error = refused(repo.checkout(repo.remote("topic")));
    let ErrorKind::AfterHookFailed { output } = &error.kind else {
        panic!("{error:?}");
    };
    assert!(output.contains("lint said no"), "{output}");
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
    let entry = repo.next_undo().expect("the checkout has an entry");
    let undone = refused(repo.undo(&entry));
    assert!(matches!(undone.kind, ErrorKind::AfterHookFailed { .. }));
    assert_eq!(repo.state(), before);
    let history = repo.coordinator.undo_history(repo.path()).unwrap();
    assert_eq!(history.redo.map(|redo| redo.id), Some(entry.id));
}

#[test]
fn a_switch_git_cannot_finish_puts_the_files_and_the_new_branch_back() {
    let repo = Repo::new();
    fs::write(repo.root.join("shared.txt"), "carried\n").unwrap();
    let before = repo.state();
    fs::write(repo.root.join(".git/HEAD.lock"), "").unwrap();
    let error = refused(repo.checkout(repo.remote("topic")));
    fs::remove_file(repo.root.join(".git/HEAD.lock")).unwrap();
    assert!(error.message.contains("put them back"), "{}", error.message);
    assert_eq!(repo.state(), before);
    assert!(repo.next_undo().is_none());
}

#[test]
fn a_remote_branch_its_refspec_excludes_is_refused() {
    let repo = Repo::new();
    repo.git(&[
        "config",
        "--add",
        "remote.origin.fetch",
        "^refs/heads/topic",
    ]);
    let before = repo.state();
    let error = refused(repo.checkout(repo.remote("topic")));
    assert_eq!(error.kind, ErrorKind::InvalidRef, "{}", error.message);
    assert_eq!(repo.state(), before);
}

#[test]
fn undo_refuses_to_delete_a_created_branch_that_moved() {
    let repo = Repo::new();
    let applied = repo.checkout(repo.remote("topic")).unwrap();
    repo.git(&["switch", "--quiet", "main"]);
    repo.git(&["branch", "--quiet", "-f", "topic", "origin/feature"]);
    let before = repo.state();
    let error = refused(repo.undo(&applied));
    assert_eq!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::BranchChanged
        },
        "{}",
        error.message
    );
    assert_eq!(repo.state(), before);
}

#[test]
fn undo_refuses_when_head_moved_after_the_checkout() {
    let repo = Repo::new();
    let applied = repo.checkout(repo.remote("topic")).unwrap();
    commit(&repo.root, &[("later.txt", "later\n")], "later");
    let before = repo.state();
    let error = refused(repo.undo(&applied));
    assert_eq!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::HeadMoved
        }
    );
    assert_eq!(repo.state(), before);
}

#[test]
fn refuses_the_branch_head_is_on_one_another_worktree_has_and_an_unborn_head() {
    let repo = Repo::new();
    let error = refused(repo.checkout(repo.local("main")));
    assert_eq!(error.kind, ErrorKind::UnchangedPath);

    repo.git(&["branch", "--quiet", "feature", "origin/feature"]);
    let other = repo.root.with_file_name("other");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        other.to_str().unwrap(),
        "feature",
    ]);
    let before = repo.state();
    let error = refused(repo.checkout(repo.local("feature")));
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert!(error.message.contains("other"), "{}", error.message);
    assert_eq!(repo.state(), before);

    repo.git(&["switch", "--quiet", "--orphan", "fresh"]);
    let unborn = Expect {
        head: Head::Unborn {
            reference: "refs/heads/fresh".to_owned(),
        },
    };
    let error = refused(repo.checkout_seen(repo.local("main"), &unborn));
    assert_eq!(error.kind, ErrorKind::UnsupportedPath, "{}", error.message);
}
