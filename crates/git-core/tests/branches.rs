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

fn init(root: &Path) {
    fs::create_dir_all(root).unwrap();
    git(root, &["init", "--quiet", "--initial-branch=main"]);
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
    /// `main` holds `base`, and `topic` adds three commits that only it
    /// reaches.
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        init(&root);
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

    /// Refs, every worktree's HEAD, and branch config: what a branch write
    /// may change.
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

    /// Leaves only what refs reach, as a user's `gc` eventually does.
    fn prune(&self) {
        self.git(&["reflog", "expire", "--expire=now", "--all"]);
        self.git(&["gc", "--quiet", "--prune=now"]);
    }
}

fn kind(result: Result<Applied, RepositoryError>) -> ErrorKind {
    result.unwrap_err().kind
}

/// Undoes then redoes `applied`, pruning the repository before each step,
/// and checks each step lands exactly on the state before or after it.
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
    assert_eq!(kind(repo.create("late", stale)), BRANCH_CHANGED);
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
    // The remote ref protected the commits at the delete; a pruning fetch
    // drops it before the undo.
    repo.git(&["update-ref", "-d", "refs/remotes/origin/topic"]);
    let before = without(&before, "refs/remotes/origin/topic");
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
