use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Head, Limits, NewWorktree, Oid, Operation,
    RepositoryError, Start, WorktreeBranch, WorktreeReview, WorktreeSource, snapshot,
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

/// `<tmp>/repo` cloned from `<tmp>/upstream`, which has `main`, `feature`
/// and `topic`. Default worktree folders land in `<tmp>/.worktrees`.
struct Repo {
    _directory: TempDir,
    base: PathBuf,
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
        commit(&upstream, &[("shared.txt", "shared\n")], "base");
        git(&upstream, &["switch", "--quiet", "-c", "feature"]);
        commit(&upstream, &[("feature.txt", "feature\n")], "feature");
        git(&upstream, &["switch", "--quiet", "-c", "topic", "main"]);
        commit(&upstream, &[("topic.txt", "topic\n")], "topic");
        git(&upstream, &["switch", "--quiet", "main"]);
        git(
            &base,
            &["clone", "--quiet", upstream.to_str().unwrap(), "repo"],
        );
        let root = base.join("repo");
        configure(&root);
        Self {
            coordinator: Coordinator::new(Limits::default(), base.join("undo")),
            _directory: directory,
            base,
            root,
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

    fn local(&self, name: &str) -> WorktreeSource {
        let reference = format!("refs/heads/{name}");
        WorktreeSource::Local {
            oid: self.oid(&reference),
            reference: reference.try_into().unwrap(),
        }
    }

    fn remote(&self, name: &str) -> WorktreeSource {
        let reference = format!("refs/remotes/origin/{name}");
        WorktreeSource::Remote {
            oid: self.oid(&reference),
            reference: reference.try_into().unwrap(),
        }
    }

    fn review(&self, source: &WorktreeSource) -> Result<WorktreeReview, RepositoryError> {
        self.coordinator.review_worktree(self.path(), source)
    }

    fn create(
        &self,
        source: &WorktreeSource,
        folder: &Path,
    ) -> Result<NewWorktree, RepositoryError> {
        self.coordinator
            .create_worktree(self.path(), source, folder)
    }

    /// A linked worktree made through Try it locally, at its default folder.
    fn tried(&self, source: &WorktreeSource) -> PathBuf {
        let folder = PathBuf::from(self.review(source).unwrap().folder);
        self.create(source, &folder).unwrap();
        folder
    }

    fn remove_from(&self, opened: &Path, worktree: &Path) -> Result<(), RepositoryError> {
        self.coordinator
            .remove_worktree(opened.to_str().unwrap(), worktree.to_str().unwrap())
    }

    fn listed(&self) -> Vec<String> {
        self.git(&["worktree", "list", "--porcelain"])
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .map(str::to_owned)
            .collect()
    }

    fn has_branch(&self, name: &str) -> bool {
        run_git(
            &self.root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
        )
        .0
    }

    fn post_checkout(&self, script: &str) {
        let hooks = self.base.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        fs::write(&hook, format!("#!/bin/sh\n{script}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        self.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    }

    fn write_in(&self, root: &Path, operation: Operation) -> Applied {
        let head = head(root);
        self.coordinator
            .write(root.to_str().unwrap(), &operation, &Expect { head })
            .unwrap()
    }

    fn next_undo(&self) -> Option<Applied> {
        self.coordinator.undo_history(self.path()).unwrap().undo
    }
}

fn head(root: &Path) -> Head {
    let oid = git(root, &["rev-parse", "HEAD"]);
    match run_git(root, &["symbolic-ref", "-q", "HEAD"]) {
        (true, reference, _) => Head::Attached { reference, oid },
        _ => Head::Detached { oid },
    }
}

fn canonical(path: &Path) -> String {
    path.canonicalize().unwrap().to_str().unwrap().to_owned()
}

#[test]
fn trying_a_remote_branch_makes_a_tracking_branch_in_a_worktree_at_the_default_folder() {
    let repo = Repo::new();
    fs::write(repo.root.join("shared.txt"), "edited here\n").unwrap();
    let source = repo.remote("feature");

    let review = repo.review(&source).unwrap();
    assert_eq!(
        review,
        WorktreeReview {
            folder: repo
                .base
                .join(".worktrees/repo-feature")
                .to_str()
                .unwrap()
                .into(),
            branch: WorktreeBranch::New {
                reference: "refs/heads/feature".to_owned().try_into().unwrap(),
                upstream: Some("refs/remotes/origin/feature".to_owned().try_into().unwrap()),
            },
        }
    );
    let folder = PathBuf::from(&review.folder);
    let created = repo.create(&source, &folder).unwrap();

    assert_eq!(created.root, canonical(&folder));
    assert_eq!(created.name, "repo-feature");
    assert!(created.trouble.is_none());
    assert_eq!(
        git(&folder, &["symbolic-ref", "HEAD"]),
        "refs/heads/feature"
    );
    assert_eq!(
        repo.git(&["rev-parse", "--symbolic-full-name", "feature@{upstream}"]),
        "refs/remotes/origin/feature"
    );
    assert_eq!(repo.oid("feature"), repo.oid("origin/feature"));
    assert!(folder.join("feature.txt").exists());
    assert_eq!(
        head(&repo.root),
        Head::Attached {
            reference: "refs/heads/main".into(),
            oid: repo.oid("main").as_str().into(),
        }
    );
    assert_eq!(repo.git(&["status", "--porcelain"]), " M shared.txt");
    let listed = snapshot(repo.path()).unwrap().worktrees;
    let made = listed
        .iter()
        .find(|worktree| worktree.root == created.root)
        .unwrap();
    assert_eq!(
        (made.name.as_str(), made.main, made.current),
        ("repo-feature", false, false)
    );
    assert!(
        repo.next_undo().is_none(),
        "Try it locally has no undo entry"
    );
}

#[test]
fn trying_a_local_branch_checks_it_out_in_new_parent_folders_without_moving_it() {
    let repo = Repo::new();
    repo.git(&["branch", "topic", "origin/topic"]);
    let tip = repo.oid("topic");
    let source = repo.local("topic");
    assert_eq!(
        repo.review(&source).unwrap().branch,
        WorktreeBranch::Existing {
            reference: "refs/heads/topic".to_owned().try_into().unwrap()
        }
    );
    let folder = repo.base.join("deeper/still/topic");

    let created = repo.create(&source, &folder).unwrap();

    assert_eq!(created.root, canonical(&folder));
    assert_eq!(git(&folder, &["symbolic-ref", "HEAD"]), "refs/heads/topic");
    assert_eq!(repo.oid("topic"), tip);
}

#[test]
fn an_existing_empty_folder_takes_the_worktree() {
    let repo = Repo::new();
    let folder = repo.base.join("empty");
    fs::create_dir(&folder).unwrap();

    repo.create(&repo.remote("topic"), &folder).unwrap();

    assert_eq!(git(&folder, &["symbolic-ref", "HEAD"]), "refs/heads/topic");
}

#[test]
fn a_branch_checked_out_in_any_worktree_is_refused_before_anything_is_made() {
    let repo = Repo::new();
    let linked = repo.base.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        "--track",
        "-b",
        "feature",
        linked.to_str().unwrap(),
        "origin/feature",
    ]);
    let folder = repo.base.join("try");

    for (source, holder) in [
        (repo.local("main"), &repo.root),
        (repo.remote("feature"), &linked),
    ] {
        for error in [
            repo.review(&source).unwrap_err(),
            repo.create(&source, &folder).unwrap_err(),
        ] {
            assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
            assert!(
                error.message.contains(holder.to_str().unwrap()),
                "{}",
                error.message
            );
        }
    }
    assert!(!folder.exists());
    assert_eq!(repo.listed().len(), 2);
}

#[test]
fn a_folder_with_files_is_refused_and_no_branch_is_made() {
    let repo = Repo::new();
    let folder = repo.base.join("busy");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("notes.txt"), "mine\n").unwrap();

    let error = repo.create(&repo.remote("feature"), &folder).unwrap_err();

    assert_eq!(error.kind, ErrorKind::UnsupportedPath, "{}", error.message);
    assert!(!repo.has_branch("feature"));
    assert_eq!(
        fs::read_to_string(folder.join("notes.txt")).unwrap(),
        "mine\n"
    );
    assert_eq!(repo.listed().len(), 1);
}

#[test]
fn a_failed_checkout_leaves_no_branch_folder_or_registration_behind() {
    let repo = Repo::new();
    let upstream = repo.base.join("upstream");
    git(&upstream, &["switch", "--quiet", "feature"]);
    commit(
        &upstream,
        &[(".gitattributes", "*.txt filter=broken\n")],
        "filtered",
    );
    git(&upstream, &["switch", "--quiet", "main"]);
    repo.git(&["fetch", "--quiet"]);
    repo.git(&["config", "filter.broken.smudge", "false"]);
    repo.git(&["config", "filter.broken.required", "true"]);
    let config = repo.git(&["config", "--local", "--list"]);
    let folder = repo.base.join("broken");

    let error = repo.create(&repo.remote("feature"), &folder).unwrap_err();

    assert_eq!(error.kind, ErrorKind::GitFailed, "{}", error.message);
    assert!(!repo.has_branch("feature"));
    assert!(!folder.exists());
    assert_eq!(repo.listed().len(), 1);
    assert_eq!(repo.git(&["config", "--local", "--list"]), config);
}

#[test]
fn creating_twice_answers_the_same_worktree_without_running_git_again() {
    let repo = Repo::new();
    let runs = repo.base.join("runs");
    repo.post_checkout(&format!("echo ran >> '{}'", runs.display()));
    let source = repo.remote("feature");
    let folder = PathBuf::from(repo.review(&source).unwrap().folder);

    let first = repo.create(&source, &folder).unwrap();
    let second = repo.create(&source, &folder).unwrap();

    assert_eq!((second.root, second.name), (first.root, first.name));
    assert!(second.trouble.is_none());
    assert_eq!(fs::read_to_string(&runs).unwrap(), "ran\n");
    assert_eq!(repo.listed().len(), 2);
}

#[test]
fn a_failing_post_checkout_hook_keeps_the_worktree_and_reports_its_output() {
    let repo = Repo::new();
    repo.post_checkout("echo the hook said no >&2\nexit 3");
    let folder = repo.base.join("hooked");

    let created = repo.create(&repo.remote("topic"), &folder).unwrap();

    let trouble = created.trouble.expect("the hook failure is reported");
    match trouble.kind {
        ErrorKind::AfterHookFailed { output } => {
            assert!(output.contains("the hook said no"), "{output}");
        }
        other => panic!("expected afterHookFailed, got {other:?}"),
    }
    assert_eq!(created.root, canonical(&folder));
    assert_eq!(git(&folder, &["symbolic-ref", "HEAD"]), "refs/heads/topic");
}

#[test]
fn a_folder_git_still_registers_is_refused_with_the_command_that_clears_it() {
    let repo = Repo::new();
    let missing = repo.base.join("missing");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        "--detach",
        missing.to_str().unwrap(),
    ]);
    fs::remove_dir_all(&missing).unwrap();
    let stopped = repo.base.join("stopped");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        "--detach",
        "--lock",
        "--reason",
        "initializing",
        stopped.to_str().unwrap(),
    ]);

    let gone = repo.create(&repo.remote("feature"), &missing).unwrap_err();
    let half = repo.create(&repo.remote("feature"), &stopped).unwrap_err();

    assert!(
        gone.message.contains("git worktree prune"),
        "{}",
        gone.message
    );
    assert!(
        half.message.contains("git worktree remove --force --force"),
        "{}",
        half.message
    );
    assert!(!repo.has_branch("feature"));
    assert_eq!(repo.listed().len(), 3);
}

#[test]
fn removing_a_clean_worktree_deletes_its_folder_and_ignored_files_and_keeps_its_branch() {
    let repo = Repo::new();
    let folder = repo.tried(&repo.remote("feature"));
    fs::write(repo.root.join(".git/info/exclude"), "node_modules/\n").unwrap();
    fs::create_dir(folder.join("node_modules")).unwrap();
    fs::write(folder.join("node_modules/dependency.js"), "1\n").unwrap();
    let tip = repo.oid("feature");

    repo.remove_from(&repo.root, &folder).unwrap();

    assert!(!folder.exists());
    assert_eq!(repo.listed(), [repo.path()]);
    assert_eq!(repo.oid("feature"), tip);
    assert_eq!(repo.git(&["config", "branch.feature.remote"]), "origin");
    assert!(
        repo.next_undo().is_none(),
        "Remove worktree has no undo entry"
    );
}

#[test]
fn removing_a_worktree_git_no_longer_lists_succeeds_again() {
    let repo = Repo::new();
    let folder = repo.tried(&repo.remote("feature"));
    repo.remove_from(&repo.root, &folder).unwrap();

    repo.remove_from(&repo.root, &folder).unwrap();

    assert_eq!(repo.listed(), [repo.path()]);
}

#[test]
fn remove_refuses_the_main_and_the_open_worktree() {
    let repo = Repo::new();
    let folder = repo.tried(&repo.remote("feature"));

    let main = repo.remove_from(&folder, &repo.root).unwrap_err();
    let open = repo.remove_from(&folder, &folder).unwrap_err();

    assert_eq!(main.kind, ErrorKind::UnsupportedPath, "{}", main.message);
    assert_eq!(open.kind, ErrorKind::Conflict, "{}", open.message);
    assert_eq!(repo.listed().len(), 2);
    assert!(folder.join("feature.txt").exists());
}

#[test]
fn remove_refuses_a_worktree_with_changes_a_locked_one_and_one_mid_rebase() {
    let repo = Repo::new();
    let dirty = repo.tried(&repo.remote("feature"));
    fs::write(dirty.join("draft.txt"), "unsaved\n").unwrap();
    let locked = repo.tried(&repo.remote("topic"));
    repo.git(&["worktree", "lock", locked.to_str().unwrap()]);
    repo.git(&["branch", "rebasing", "origin/feature"]);
    let rebasing = repo.tried(&repo.local("rebasing"));
    let (stopped, _, _) = run_git(&rebasing, &["rebase", "--exec", "false", "HEAD~1"]);
    assert!(!stopped, "the rebase stops at its exec line");
    assert_eq!(git(&rebasing, &["status", "--porcelain"]), "");

    for (worktree, said) in [
        (&dirty, "uncommitted or untracked"),
        (&locked, "git worktree unlock"),
        (&rebasing, "A rebase is in progress"),
    ] {
        let error = repo.remove_from(&repo.root, worktree).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
        assert!(error.message.contains(said), "{}", error.message);
        assert!(worktree.exists());
    }
    assert_eq!(
        fs::read_to_string(dirty.join("draft.txt")).unwrap(),
        "unsaved\n"
    );
    assert_eq!(repo.listed().len(), 4);
}

#[test]
fn removing_a_worktree_drops_the_undo_entries_only_it_could_run() {
    let repo = Repo::new();
    let linked = repo.tried(&repo.remote("feature"));
    let on_main = repo.write_in(
        &repo.root,
        Operation::Checkout {
            target: Start::Commit {
                oid: repo.oid("HEAD"),
            },
        },
    );
    let branch_made_there = repo.write_in(
        &linked,
        Operation::CreateBranch {
            name: "made-there".into(),
            at: Start::Commit {
                oid: repo.oid("feature"),
            },
        },
    );
    let checkout_there = repo.write_in(
        &linked,
        Operation::Checkout {
            target: Start::Commit {
                oid: repo.oid("feature"),
            },
        },
    );
    assert_eq!(
        repo.next_undo().map(|entry| entry.id),
        Some(checkout_there.id)
    );

    repo.remove_from(&repo.root, &linked).unwrap();

    assert_eq!(
        repo.next_undo().map(|entry| entry.id),
        Some(branch_made_there.id)
    );
    repo.coordinator
        .undo(repo.path(), branch_made_there.id)
        .unwrap();
    assert!(!repo.has_branch("made-there"));
    repo.coordinator.undo(repo.path(), on_main.id).unwrap();
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert!(repo.next_undo().is_none());
}
