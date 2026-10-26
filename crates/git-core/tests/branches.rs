use l1_git_core::{
    Applied, BranchMerged, BranchTip, Coordinator, ErrorKind, Expect, Head, Limits, Oid, Operation,
    RepositoryError, Request, Response, StaleReason, Start, UpstreamMerged, run,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

const BRANCH_CHANGED: ErrorKind = ErrorKind::StaleView {
    reason: StaleReason::BranchChanged,
};

fn git_output(path: &Path, args: &[&str]) -> std::process::Output {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = git_output(path, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .to_owned()
}

fn init(root: &Path, options: &[&str]) {
    fs::create_dir_all(root).unwrap();
    let mut args = vec!["init", "--quiet", "--initial-branch=main"];
    args.extend(options);
    git(root, &args);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("commit.gpgSign", "false"),
        ("core.hooksPath", "/dev/null"),
    ] {
        git(root, &["config", key, value]);
    }
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
    coordinator: Coordinator,
}

impl Repo {
    fn new() -> Self {
        Self::init(&[])
    }

    fn init(options: &[&str]) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        init(&root, options);
        let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));
        let repo = Self {
            directory,
            root,
            coordinator,
        };
        repo.commit("base");
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        for n in 1..=3 {
            repo.commit(&format!("topic {n}"));
        }
        repo.git(&["switch", "--quiet", "main"]);
        repo
    }

    fn commit(&self, message: &str) {
        fs::write(self.root.join("file.txt"), message).unwrap();
        self.git(&["add", "file.txt"]);
        self.git(&["commit", "--quiet", "-m", message]);
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn oid(&self, revision: &str) -> Oid {
        Oid::try_from(self.git(&["rev-parse", revision])).unwrap()
    }

    fn tip(&self, name: &str) -> BranchTip {
        BranchTip {
            reference: format!("refs/heads/{name}").try_into().unwrap(),
            oid: self.oid(&format!("refs/heads/{name}")),
        }
    }

    fn expect(&self) -> Expect {
        let head = match self.git(&["symbolic-ref", "-q", "HEAD"]) {
            reference if !reference.is_empty() => Head::Attached {
                reference,
                oid: self.oid("HEAD").as_str().to_owned(),
            },
            _ => Head::Detached {
                oid: self.oid("HEAD").as_str().to_owned(),
            },
        };
        Expect { head }
    }

    fn write(&self, operation: Operation) -> Result<Applied, RepositoryError> {
        self.coordinator
            .write(self.path(), &operation, &self.expect())
    }

    fn create(&self, name: &str, at: Start) -> Result<Applied, RepositoryError> {
        self.write(Operation::CreateBranch {
            name: name.to_owned(),
            at,
        })
    }

    fn rename(&self, branch: &str, to: &str) -> Result<Applied, RepositoryError> {
        self.write(Operation::RenameBranch {
            branch: self.tip(branch),
            to: to.to_owned(),
        })
    }

    fn delete(&self, branch: &str) -> Result<Applied, RepositoryError> {
        self.write(Operation::DeleteBranch {
            branch: self.tip(branch),
        })
    }

    fn undo(&self, applied: &Applied) -> Result<Applied, RepositoryError> {
        self.coordinator.undo(self.path(), applied.id)
    }

    fn redo(&self, applied: &Applied) -> Result<Applied, RepositoryError> {
        self.coordinator.redo(self.path(), applied.id)
    }

    fn state(&self) -> String {
        let config = self
            .git(&["config", "--local", "--list"])
            .lines()
            .filter(|line| line.starts_with("branch."))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "{}\n{}\n{config}",
            self.git(&["for-each-ref", "--format=%(refname) %(objectname)"]),
            self.git(&["worktree", "list", "--porcelain"]),
        )
        .lines()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
    }

    fn prune(&self) {
        self.git(&["reflog", "expire", "--expire=now", "--all"]);
        self.git(&["gc", "--quiet", "--prune=now"]);
    }
}

impl Repo {
    fn fetch_prunes(&self, state: &str, reference: &str) -> String {
        self.git(&["update-ref", "-d", reference]);
        without(state, reference)
    }
}

fn kind(result: Result<Applied, RepositoryError>) -> ErrorKind {
    result.unwrap_err().kind
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

fn without(state: &str, reference: &str) -> String {
    let prefix = format!("{reference} ");
    state
        .lines()
        .filter(|line| !line.starts_with(&prefix))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn creates_a_branch_at_a_commit_and_undoes_it_after_gc() {
    let repo = Repo::new();
    let at = repo.oid("topic~1");
    let applied = repo
        .create("fix/one", Start::Commit { oid: at.clone() })
        .unwrap();
    assert_eq!(repo.oid("refs/heads/fix/one"), at);
    assert_eq!(
        repo.git(&["reflog", "-1", "--format=%gs", "refs/heads/fix/one"]),
        format!("branch: Created from {}", at.as_str())
    );
    repo.git(&["branch", "-D", "--quiet", "topic"]);
    let before = without(&repo.state(), "refs/heads/fix/one");
    round_trip(&repo, &before, &applied);
}

#[test]
fn creates_from_a_local_branch_only_while_it_holds_the_tip_shown() {
    let repo = Repo::new();
    let start = Start::Local {
        reference: "refs/heads/topic".to_owned().try_into().unwrap(),
        oid: repo.oid("topic"),
    };
    let before = repo.state();
    let applied = repo.create("copy", start.clone()).unwrap();
    assert_eq!(repo.oid("copy"), repo.oid("topic"));
    round_trip(&repo, &before, &applied);

    let stale = Start::Local {
        reference: "refs/heads/topic".to_owned().try_into().unwrap(),
        oid: repo.oid("topic~1"),
    };
    let before = repo.state();
    let error = repo.create("late", stale).unwrap_err();
    assert_eq!(error.kind, BRANCH_CHANGED);
    assert!(
        error
            .message
            .starts_with("topic is no longer at the commit"),
        "{}",
        error.message
    );
    assert_eq!(repo.state(), before);
}

fn with_remote() -> (Repo, PathBuf) {
    let repo = Repo::new();
    let remote = repo.directory.path().join("remote.git");
    git(
        repo.directory.path(),
        &["init", "--quiet", "--bare", "remote.git"],
    );
    repo.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    repo.git(&["push", "--quiet", "origin", "main", "topic"]);
    repo.git(&["fetch", "--quiet", "origin"]);
    (repo, remote)
}

#[test]
fn creates_from_a_remote_branch_with_it_as_the_upstream() {
    let (repo, _remote) = with_remote();
    let start = Start::Remote {
        reference: "refs/remotes/origin/topic".to_owned().try_into().unwrap(),
        oid: repo.oid("origin/topic"),
    };
    let before = repo.state();
    let applied = repo.create("review", start).unwrap();
    assert_eq!(repo.git(&["config", "branch.review.remote"]), "origin");
    assert_eq!(
        repo.git(&["config", "branch.review.merge"]),
        "refs/heads/topic"
    );
    round_trip(&repo, &before, &applied);

    repo.git(&["config", "branch.autoSetupMerge", "false"]);
    let start = Start::Remote {
        reference: "refs/remotes/origin/main".to_owned().try_into().unwrap(),
        oid: repo.oid("origin/main"),
    };
    repo.create("plain", start).unwrap();
    assert!(
        !git_output(&repo.root, &["config", "branch.plain.merge"])
            .status
            .success()
    );

    let stale = Start::Remote {
        reference: "refs/remotes/origin/topic".to_owned().try_into().unwrap(),
        oid: repo.oid("origin/topic~1"),
    };
    let before = repo.state();
    let error = repo.create("late", stale).unwrap_err();
    assert_eq!(error.kind, BRANCH_CHANGED);
    assert!(
        error
            .message
            .starts_with("origin/topic is no longer at the commit"),
        "{}",
        error.message
    );
    assert_eq!(repo.state(), before);
}

#[test]
fn refuses_names_with_gits_reason_and_changes_nothing() {
    let repo = Repo::new();
    repo.git(&["branch", "feat/x"]);
    let before = repo.state();
    let at = || Start::Commit {
        oid: repo.oid("HEAD"),
    };
    let refused = |name: &str| {
        let error = repo.create(name, at()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef, "{name}");
        error.message
    };
    assert_eq!(
        refused("bad..name"),
        "'bad..name' is not a valid branch name."
    );
    assert_eq!(refused("-x"), "'-x' is not a valid branch name.");
    assert_eq!(refused("feat/"), "'feat/' is not a valid branch name.");
    assert_eq!(refused("main"), "A branch named 'main' already exists.");
    assert_eq!(
        refused("feat"),
        "A branch named 'feat/x' already exists, so Git cannot also store 'feat'."
    );
    assert_eq!(refused("@"), "'@' is not a valid branch name.");
    assert_eq!(
        refused("refs/heads/x"),
        "'refs/heads/x' is not a valid branch name."
    );
    repo.git(&["config", "core.ignorecase", "true"]);
    assert_eq!(
        refused("Topic"),
        "A branch named 'topic' already exists, and this repository does not tell names apart by case."
    );
    repo.git(&["config", "core.ignorecase", "false"]);
    assert_eq!(repo.state(), before);
    let history = repo.coordinator.undo_history(repo.path()).unwrap();
    assert_eq!(history.undo, None);
}

#[test]
fn renames_the_checked_out_branch_and_its_upstream_with_head_following() {
    let (repo, _remote) = with_remote();
    repo.git(&["branch", "--quiet", "--set-upstream-to=origin/main", "main"]);
    let linked = repo.directory.path().join("linked");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        linked.to_str().unwrap(),
        "topic",
    ]);
    let before = repo.state();
    let applied = repo.rename("main", "trunk").unwrap();
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/trunk");
    assert_eq!(
        repo.git(&["config", "branch.trunk.merge"]),
        "refs/heads/main"
    );
    round_trip(&repo, &before, &applied);

    let before = repo.state();
    let applied = repo.rename("topic", "feature/topic").unwrap();
    assert_eq!(
        git(&linked, &["symbolic-ref", "HEAD"]),
        "refs/heads/feature/topic"
    );
    round_trip(&repo, &before, &applied);
}

#[test]
fn deletes_merged_and_unmerged_branches_and_undo_brings_back_every_commit() {
    let (repo, _remote) = with_remote();
    repo.git(&["branch", "--quiet", "merged", "main"]);
    let before = repo.state();
    let applied = repo.delete("merged").unwrap();
    assert!(!repo.state().contains("refs/heads/merged "));
    round_trip(&repo, &before, &applied);

    repo.git(&[
        "branch",
        "--quiet",
        "--set-upstream-to=origin/topic",
        "topic",
    ]);
    let tip = repo.oid("topic");
    let before = repo.state();
    let applied = repo.delete("topic").unwrap();
    assert!(
        !git_output(&repo.root, &["config", "branch.topic.merge"])
            .status
            .success()
    );
    let before = repo.fetch_prunes(&before, "refs/remotes/origin/topic");
    repo.prune();
    assert!(
        !git_output(&repo.root, &["cat-file", "-e", tip.as_str()])
            .status
            .success()
    );
    round_trip(&repo, &before, &applied);
    repo.prune();
    repo.undo(&applied).unwrap();
    assert_eq!(
        repo.git(&["log", "--format=%s", "topic"]),
        "topic 3\ntopic 2\ntopic 1\nbase"
    );
    assert_eq!(
        repo.git(&["config", "branch.topic.merge"]),
        "refs/heads/topic"
    );
}

#[test]
fn refuses_to_delete_a_branch_a_worktree_uses() {
    let repo = Repo::new();
    let linked = repo.directory.path().join("linked");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        linked.to_str().unwrap(),
        "topic",
    ]);
    let before = repo.state();
    for name in ["main", "topic"] {
        let error = repo.delete(name).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{name}");
        assert!(
            error.message.contains("is checked out in"),
            "{}",
            error.message
        );
    }
    git(&linked, &["switch", "--quiet", "--detach"]);
    fs::create_dir_all(repo.root.join(".git/worktrees/linked/rebase-merge")).unwrap();
    fs::write(
        repo.root
            .join(".git/worktrees/linked/rebase-merge/head-name"),
        "refs/heads/topic\n",
    )
    .unwrap();
    let error = repo.delete("topic").unwrap_err();
    assert_eq!(error.kind, ErrorKind::Conflict);
    assert!(
        error.message.contains("rebasing or bisecting"),
        "{}",
        error.message
    );
    fs::remove_dir_all(repo.root.join(".git/worktrees/linked/rebase-merge")).unwrap();
    git(&linked, &["switch", "--quiet", "topic"]);
    assert_eq!(repo.state(), before);
}

#[test]
fn refuses_a_tip_that_moved_since_the_view() {
    let repo = Repo::new();
    let shown = repo.tip("topic");
    repo.git(&["branch", "--force", "topic", "topic~1"]);
    let before = repo.state();
    for operation in [
        Operation::DeleteBranch {
            branch: shown.clone(),
        },
        Operation::RenameBranch {
            branch: shown.clone(),
            to: "other".to_owned(),
        },
    ] {
        assert_eq!(kind(repo.write(operation)), BRANCH_CHANGED);
    }
    assert_eq!(repo.state(), before);
}

#[test]
fn an_undo_refuses_a_branch_moved_after_the_write() {
    let repo = Repo::new();
    let applied = repo
        .create(
            "late",
            Start::Commit {
                oid: repo.oid("HEAD"),
            },
        )
        .unwrap();
    repo.git(&["branch", "--force", "late", "topic"]);
    let before = repo.state();
    assert_eq!(kind(repo.undo(&applied)), BRANCH_CHANGED);
    assert_eq!(repo.state(), before);
}

#[test]
fn a_step_that_creates_a_branch_refuses_one_made_again_at_the_same_tip() {
    let repo = Repo::new();
    let created = repo
        .create(
            "late",
            Start::Commit {
                oid: repo.oid("HEAD"),
            },
        )
        .unwrap();
    repo.undo(&created).unwrap();
    repo.git(&["branch", "--quiet", "late", "HEAD"]);
    repo.git(&["config", "branch.late.description", "mine"]);
    let made_again = repo.state();
    assert_eq!(kind(repo.redo(&created)), BRANCH_CHANGED);
    assert_eq!(repo.state(), made_again);

    repo.git(&["branch", "--quiet", "gone", "topic"]);
    let deleted = repo.delete("gone").unwrap();
    repo.git(&["branch", "--quiet", "gone", "topic"]);
    repo.git(&["config", "branch.gone.description", "mine"]);
    let made_again = repo.state();
    assert_eq!(kind(repo.undo(&deleted)), BRANCH_CHANGED);
    assert_eq!(repo.state(), made_again);
}

#[test]
fn undo_of_a_create_keeps_the_commits_of_a_branch_deleted_outside_l1_git() {
    let repo = Repo::new();
    repo.git(&["switch", "--quiet", "-c", "scratch"]);
    repo.commit("only on late");
    let tip = repo.oid("HEAD");
    repo.git(&["switch", "--quiet", "main"]);
    repo.git(&["branch", "--quiet", "-D", "scratch"]);
    let created = repo
        .create("late", Start::Commit { oid: tip.clone() })
        .unwrap();
    repo.git(&["branch", "--quiet", "-D", "late"]);
    repo.undo(&created).unwrap();
    repo.prune();
    assert!(
        !git_output(&repo.root, &["cat-file", "-e", tip.as_str()])
            .status
            .success()
    );
    repo.redo(&created).unwrap();
    assert_eq!(repo.oid("refs/heads/late"), tip);
    repo.git(&["fsck", "--no-progress", "--connectivity-only"]);
}

#[test]
fn refuses_symbolic_branches_and_a_rename_undo_could_not_reverse() {
    let repo = Repo::new();
    repo.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/topic"]);
    let alias = BranchTip {
        reference: "refs/heads/alias".to_owned().try_into().unwrap(),
        oid: repo.oid("topic"),
    };
    let before = repo.state();
    let error = repo
        .write(Operation::DeleteBranch { branch: alias })
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidRef);
    assert_eq!(repo.state(), before);
    repo.git(&["update-ref", "-d", "--no-deref", "refs/heads/alias"]);

    repo.git(&["update-ref", "refs/heads/-f", "topic"]);
    let before = repo.state();
    let error = repo.rename("-f", "dashless").unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidRef);
    assert_eq!(repo.state(), before);
    let applied = repo.delete("-f").unwrap();
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    round_trip(&repo, &before, &applied);
}

#[test]
fn undo_runs_in_any_worktree_after_the_one_it_was_made_in_is_removed() {
    let repo = Repo::new();
    let linked = repo.directory.path().join("linked");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        "--detach",
        linked.to_str().unwrap(),
    ]);
    let before = repo.state();
    let applied = repo
        .coordinator
        .write(
            linked.to_str().unwrap(),
            &Operation::DeleteBranch {
                branch: repo.tip("topic"),
            },
            &repo.expect(),
        )
        .unwrap();
    repo.git(&["worktree", "remove", linked.to_str().unwrap()]);
    let before = before
        .lines()
        .take_while(|line| !line.contains("linked"))
        .collect::<Vec<_>>();
    repo.undo(&applied).unwrap();
    let after = repo.state();
    for line in before.iter().filter(|line| line.starts_with("refs/")) {
        assert!(after.contains(line), "{line}");
    }
}

#[test]
fn reports_whether_a_branch_is_merged_into_head_and_its_upstream() {
    let (repo, _remote) = with_remote();
    repo.git(&[
        "branch",
        "--quiet",
        "--set-upstream-to=origin/topic",
        "topic",
    ]);
    let merged = |name: &str| {
        let request: Request = serde_json::from_value(serde_json::json!({
            "op": "branchMerged",
            "path": repo.path(),
            "branch": repo.tip(name),
        }))
        .unwrap();
        match run(&repo.coordinator, request).unwrap() {
            Response::BranchMerged(merged) => merged,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(
        merged("topic"),
        BranchMerged {
            head: false,
            upstream: Some(UpstreamMerged {
                reference: "refs/remotes/origin/topic".to_owned(),
                merged: true,
            }),
        }
    );
    repo.git(&["branch", "--quiet", "old", "main"]);
    assert_eq!(
        merged("old"),
        BranchMerged {
            head: true,
            upstream: None,
        }
    );
}

fn no_entry(repo: &Repo) {
    let history = repo.coordinator.undo_history(repo.path()).unwrap();
    assert_eq!(history.undo, None, "no undo entry");
}

#[test]
fn refuses_a_folder_that_differs_only_in_case_where_refs_fold_case() {
    let repo = Repo::new();
    repo.git(&["config", "core.ignorecase", "true"]);
    repo.git(&["branch", "grp/leaf"]);
    let before = repo.state();
    let at = Start::Commit {
        oid: repo.oid("HEAD"),
    };
    for refused in [repo.create("Grp/x", at), repo.rename("topic", "Grp/y")] {
        let error = refused.unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef, "{}", error.message);
        assert!(
            error.message.contains("'grp/leaf'")
                && error.message.contains("does not tell names apart by case"),
            "{}",
            error.message
        );
    }
    assert_eq!(repo.state(), before);
    no_entry(&repo);

    let applied = repo.rename("topic", "grp/y").unwrap();
    round_trip(&repo, &before, &applied);
}

#[test]
fn refuses_a_case_only_rename_where_refs_fold_case() {
    let repo = Repo::new();
    repo.git(&["config", "core.ignorecase", "true"]);
    repo.git(&["branch", "packed"]);
    repo.git(&["pack-refs", "--all"]);
    repo.git(&["branch", "loose"]);
    let before = repo.state();
    for (name, to) in [("packed", "Packed"), ("loose", "LOOSE")] {
        let error = repo.rename(name, to).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef, "{}", error.message);
        assert!(
            error.message.contains("does not tell names apart by case"),
            "{}",
            error.message
        );
    }
    assert_eq!(repo.state(), before);
    no_entry(&repo);

    let first = repo.rename("packed", "interim").unwrap();
    let second = repo.rename("interim", "Packed").unwrap();
    repo.undo(&second).unwrap();
    repo.undo(&first).unwrap();
    assert_eq!(repo.state(), before);
}

#[test]
fn reftable_tells_names_apart_by_case_and_undoes_each_case_change() {
    let repo = Repo::init(&["--ref-format=reftable"]);
    repo.git(&["config", "core.ignorecase", "true"]);
    repo.git(&["branch", "grp/leaf"]);
    let head = || Start::Commit {
        oid: repo.oid("HEAD"),
    };
    let rename = |branch: &str, to: &str| Operation::RenameBranch {
        branch: repo.tip(branch),
        to: to.to_owned(),
    };
    let create = |name: &str| Operation::CreateBranch {
        name: name.to_owned(),
        at: head(),
    };
    for operation in [
        create("Grp/x"),
        rename("topic", "Grp/y"),
        rename("grp/leaf", "GRP/Leaf"),
        create("MAIN"),
    ] {
        let before = repo.state();
        let applied = repo.write(operation).unwrap();
        assert_ne!(repo.state(), before);
        round_trip(&repo, &before, &applied);
    }
}

#[test]
fn sets_the_upstream_plain_git_branch_sets_for_each_auto_setup_merge() {
    let (repo, _remote) = with_remote();
    repo.git(&["push", "--quiet", "origin", "topic:feat/x"]);
    repo.git(&["fetch", "--quiet", "origin"]);
    repo.git(&["branch", "--quiet", "--set-upstream-to=origin/main", "main"]);
    let remote = |name: &str| Start::Remote {
        reference: format!("refs/remotes/origin/{name}").try_into().unwrap(),
        oid: repo.oid(&format!("origin/{name}")),
    };
    let local = |name: &str| Start::Local {
        reference: format!("refs/heads/{name}").try_into().unwrap(),
        oid: repo.oid(name),
    };
    let commit = repo.oid("HEAD");
    let starts = [
        ("feat/x", "origin/feat/x", remote("feat/x")),
        ("x", "origin/feat/x", remote("feat/x")),
        ("review", "origin/topic", remote("topic")),
        ("copy", "main", local("main")),
        ("plain", "topic", local("topic")),
        (
            "at",
            commit.as_str(),
            Start::Commit {
                oid: commit.clone(),
            },
        ),
    ];
    let settings = |name: &str| {
        let prefix = format!("branch.{name}.");
        repo.git(&["config", "--local", "--list"])
            .lines()
            .filter(|line| line.starts_with(&prefix))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let set = |key: &str, value: Option<&str>| match value {
        Some(value) => drop(repo.git(&["config", key, value])),
        None => drop(git_output(&repo.root, &["config", "--unset", key])),
    };
    let mut tracked = 0;
    for rebase in [None, Some("always")] {
        set("branch.autoSetupRebase", rebase);
        for merge in [
            None,
            Some("true"),
            Some("false"),
            Some("always"),
            Some("inherit"),
            Some("simple"),
        ] {
            set("branch.autoSetupMerge", merge);
            for (name, from, start) in &starts {
                repo.git(&["branch", "--quiet", "--", name, from]);
                let git_wrote = settings(name);
                repo.git(&["branch", "-D", "--quiet", "--", name]);
                repo.create(name, start.clone()).unwrap();
                assert_eq!(
                    settings(name),
                    git_wrote,
                    "autoSetupMerge {merge:?}, autoSetupRebase {rebase:?}, {name} from {from}"
                );
                tracked += usize::from(!git_wrote.is_empty());
                repo.git(&["branch", "-D", "--quiet", "--", name]);
            }
        }
    }
    assert!(tracked > 0);
}

#[test]
fn an_undo_says_git_no_longer_has_commits_only_a_deleted_tag_reached() {
    let repo = Repo::new();
    repo.git(&["tag", "keep", "topic"]);
    let applied = repo.delete("topic").unwrap();
    repo.git(&["tag", "-d", "keep"]);
    repo.prune();
    let before = repo.state();
    let error = repo.undo(&applied).unwrap_err();
    assert_eq!(error.kind, ErrorKind::GitFailed);
    assert!(
        error
            .message
            .starts_with("Git no longer has some of this branch's commits"),
        "{}",
        error.message
    );
    assert_eq!(repo.state(), before);
}

#[test]
fn records_no_entry_when_git_leaves_a_branch_undo_cannot_read() {
    let repo = Repo::new();
    let hooks = repo.directory.path().join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("reference-transaction");
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\n[ \"$1\" = committed ] || exit 0\n[ -z \"$MOVED\" ] || exit 0\ngrep -q ' refs/heads/topic$' || exit 0\nMOVED=1 git update-ref refs/heads/topic {}\n",
            repo.oid("main").as_str()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    let error = repo.delete("topic").unwrap_err();
    assert_eq!(error.kind, BRANCH_CHANGED, "{}", error.message);
    assert_eq!(repo.oid("topic"), repo.oid("main"));
    no_entry(&repo);
}
