#![cfg(unix)]

use l1_git_core::{
    Applied, BranchTip, Coordinator, ErrorKind, Expect, Limits, Operation, RepositoryError,
    worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

const FORMATS: [&str; 2] = ["files", "reftable"];

fn terminal(path: &Path, args: &[&str]) -> Output {
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
    let output = terminal(path, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// Leaves a real `git cherry-pick` or `git revert` stopped on a conflict in
/// `f.txt`. The replayed commit also adds or removes `n.txt`, which applies
/// cleanly. Returns the replayed commit.
fn stop(root: &Path, pick: Pick) -> String {
    let commit_theirs = || {
        fs::write(root.join("f.txt"), "a\nTHEIRS\nc\n").unwrap();
        fs::write(root.join("n.txt"), "n\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "--quiet", "-m", "theirs\n\nbody"]);
        git(root, &["rev-parse", "HEAD"]).trim().to_owned()
    };
    let commit_ours = || {
        fs::write(root.join("f.txt"), "a\nOURS\nc\n").unwrap();
        git(root, &["commit", "--quiet", "-am", "ours"]);
    };
    let start: &[&str] = match pick {
        Pick::CherryPick => &["cherry-pick"],
        Pick::Revert => &["revert", "--no-edit"],
    };
    let commit = match pick {
        Pick::CherryPick => {
            let branch = git(root, &["symbolic-ref", "--short", "HEAD"]);
            git(root, &["switch", "--quiet", "-c", "topic"]);
            let commit = commit_theirs();
            git(root, &["switch", "--quiet", branch.trim()]);
            commit_ours();
            commit
        }
        Pick::Revert => {
            let commit = commit_theirs();
            commit_ours();
            commit
        }
    };
    let stopped = terminal(root, &[start, &[commit.as_str()]].concat());
    assert!(!stopped.status.success(), "{start:?} should stop");
    assert!(
        git(root, &["status", "--porcelain"]).contains("UU f.txt"),
        "the replay should stop on f.txt"
    );
    commit
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pick {
    CherryPick,
    Revert,
}

const PICKS: [Pick; 2] = [Pick::CherryPick, Pick::Revert];

/// Every case runs in both ref formats, for both commands.
fn cases() -> impl Iterator<Item = (&'static str, Pick)> {
    FORMATS
        .into_iter()
        .flat_map(|format| PICKS.into_iter().map(move |pick| (format, pick)))
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
}

impl Repo {
    fn new(format: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        let init = terminal(
            &root,
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                &format!("--ref-format={format}"),
            ],
        );
        assert!(init.status.success());
        let repo = Self { directory, root };
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
        ] {
            repo.git(&["config", key, value]);
        }
        repo.put("f.txt", "a\nb\nc\n");
        repo.put("u.txt", "u\n");
        repo.put("v.txt", "v\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "--quiet", "-m", "base"]);
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn oid(&self, name: &str) -> String {
        self.git(&["rev-parse", name]).trim().to_owned()
    }

    fn put(&self, path: &str, text: &str) {
        fs::write(self.root.join(path), text).unwrap();
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn undo_dir(&self) -> PathBuf {
        self.directory.path().join("undo")
    }

    fn coordinator(&self) -> Coordinator {
        Coordinator::new(Limits::default(), self.undo_dir())
    }

    fn linked(&self, name: &str, branch: &str) -> PathBuf {
        let linked = self.directory.path().join(name);
        self.git(&[
            "worktree",
            "add",
            "--quiet",
            "-b",
            branch,
            linked.to_str().unwrap(),
            "HEAD",
        ]);
        linked
    }

    fn tip(&self, reference: &str) -> BranchTip {
        serde_json::from_value(serde_json::json!({
            "reference": reference,
            "oid": self.oid(reference),
        }))
        .unwrap()
    }

    fn write_at(&self, path: &str, operation: &Operation) -> Result<Applied, RepositoryError> {
        let head = worktree_status(path).unwrap().head;
        self.coordinator().write(path, operation, &Expect { head })
    }
}

fn refused(result: Result<Applied, RepositoryError>) -> RepositoryError {
    let error = result.expect_err("the write should refuse");
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    error
}

#[test]
fn a_branch_with_a_replay_in_flight_in_another_worktree_cannot_be_renamed_or_deleted() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let linked = repo.linked("linked", "busy");
        stop(&linked, pick);
        let busy = repo.tip("refs/heads/busy");
        let shown = busy.oid.clone();
        for operation in [
            Operation::RenameBranch {
                branch: busy.clone(),
                to: "other".to_owned(),
            },
            Operation::DeleteBranch { branch: busy },
        ] {
            let error = refused(repo.write_at(repo.path(), &operation));
            assert!(
                error.message.contains("refs/heads/busy")
                    && error.message.contains(linked.to_str().unwrap()),
                "{format} {pick:?}: {}",
                error.message
            );
        }
        assert_eq!(repo.oid("refs/heads/busy"), shown.as_str());
        repo.git(&["show-ref", "--exists", "refs/heads/busy"]);
    }
}

#[test]
fn a_branch_or_tag_named_like_a_marker_does_not_count_as_in_flight() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["branch", "CHERRY_PICK_HEAD"]);
        repo.git(&["tag", "REVERT_HEAD"]);
        repo.git(&["branch", "busy"]);
        let linked = repo.linked("linked", "other");
        let moved = repo.write_at(
            linked.to_str().unwrap(),
            &Operation::RenameBranch {
                branch: repo.tip("refs/heads/busy"),
                to: "renamed".to_owned(),
            },
        );
        assert!(moved.is_ok(), "{format}: {moved:?}");
        repo.put("u.txt", "more\n");
        repo.git(&["add", "u.txt"]);
        let status = worktree_status(repo.path()).unwrap();
        let committed = repo.coordinator().write(
            repo.path(),
            &Operation::Commit {
                message: "more\n".to_owned(),
                staged: status.staged_stamp,
            },
            &Expect { head: status.head },
        );
        assert!(committed.is_ok(), "{format}: {committed:?}");
    }
}
