use l1_git_core::{
    Coordinator, Expect, FilePatch, Limits, Operation, Side, Start, UndoHistory, WorktreePatch,
    snapshot, worktree_patch, worktree_status,
};
use std::{
    fs,
    path::Path,
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn reads_and_writes_a_repository_with_spaces_unicode_and_crlf() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("répo with spaces");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("commit.gpgSign", "false"),
        ("core.autocrlf", "true"),
        ("maintenance.auto", "false"),
        ("gc.auto", "0"),
    ] {
        git(&root, &["config", key, value]);
    }
    let path = root.to_str().unwrap();
    let coordinator = Coordinator::new(Limits::default(), temp.path().join("undo"));
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/新 file.txt"), b"first\r\nsecond\r\n").unwrap();
    let patch = worktree_patch(path, "nested/新 file.txt", Side::Unstaged).unwrap();
    assert!(
        matches!(patch, WorktreePatch::Diff { diff: FilePatch::Text { ref patch, .. } } if patch.contains("+first\n+second\n")),
        "{patch:?}"
    );
    let status = worktree_status(path).unwrap();
    let staged = coordinator
        .write(
            path,
            &Operation::StageFiles {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert!(git(&root, &["show", ":nested/新 file.txt"]).contains("first\nsecond"));
    coordinator.undo(path, staged.id).unwrap();
    assert!(git(&root, &["ls-files"]).is_empty());
    coordinator.redo(path, staged.id).unwrap();
    let status = worktree_status(path).unwrap();
    let committed = coordinator
        .write(
            path,
            &Operation::Commit {
                message: "Initial commit".into(),
                staged: status.staged_stamp,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert_eq!(snapshot(path).unwrap().commits.len(), 1);
    coordinator.undo(path, committed.id).unwrap();
    coordinator.redo(path, committed.id).unwrap();
    fs::write(root.join("nested/新 file.txt"), b"edited\r\n").unwrap();
    let status = worktree_status(path).unwrap();
    let discarded = coordinator
        .write(
            path,
            &Operation::Discard {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert_eq!(
        fs::read(root.join("nested/新 file.txt")).unwrap(),
        b"first\r\nsecond\r\n"
    );
    coordinator.undo(path, discarded.id).unwrap();
    assert_eq!(
        fs::read(root.join("nested/新 file.txt")).unwrap(),
        b"edited\r\n"
    );
    coordinator.redo(path, discarded.id).unwrap();
    assert!(worktree_status(path).unwrap().entries.is_empty());
    assert_eq!(
        coordinator.undo_history(path).unwrap().undo.unwrap().id,
        discarded.id
    );
    assert!(!root.join(".git/index.lock").exists());

    let oid = l1_git_core::Oid::try_from(git(&root, &["rev-parse", "HEAD"])).unwrap();
    for (operation, reference) in [
        (
            Operation::CreateBranch {
                name: "topic".into(),
                at: Start::Commit { oid: oid.clone() },
            },
            "refs/heads/topic",
        ),
        (
            Operation::CreateTag {
                name: "v1".into(),
                at: oid.clone(),
                message: Some("Release".into()),
            },
            "refs/tags/v1",
        ),
    ] {
        let status = worktree_status(path).unwrap();
        let applied = coordinator
            .write(path, &operation, &Expect { head: status.head })
            .unwrap();
        assert!(!git(&root, &["rev-parse", reference]).is_empty());
        coordinator.undo(path, applied.id).unwrap();
        assert!(git(&root, &["for-each-ref", reference]).is_empty());
        coordinator.redo(path, applied.id).unwrap();
        assert!(!git(&root, &["for-each-ref", reference]).is_empty());
    }
    fs::write(root.join("nested/新 file.txt"), b"stashed\r\n").unwrap();
    let status = worktree_status(path).unwrap();
    let stashed = coordinator
        .write(
            path,
            &Operation::StashPush {
                message: "Saved edit".into(),
                untracked: false,
                paths: Vec::new(),
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert!(worktree_status(path).unwrap().entries.is_empty());
    coordinator.undo(path, stashed.id).unwrap();
    assert_eq!(
        fs::read(root.join("nested/新 file.txt")).unwrap(),
        b"stashed\r\n"
    );
    coordinator.redo(path, stashed.id).unwrap();
    assert!(worktree_status(path).unwrap().entries.is_empty());

    #[cfg(windows)]
    for invalid in ["nested\\file", "file:stream", ".git /config", "trailing."] {
        assert_eq!(
            worktree_patch(path, invalid, Side::Unstaged)
                .unwrap_err()
                .kind,
            l1_git_core::ErrorKind::UnsupportedPath
        );
    }
}

fn seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).unwrap().as_secs()
}

/// Whether the index caches `path`'s current modification time.
fn cached(root: &Path, path: &str) -> bool {
    let debug = git(root, &["ls-files", "--debug", "--", path]);
    let mtime = debug
        .lines()
        .find_map(|line| line.trim().strip_prefix("mtime: "))
        .unwrap();
    let file = fs::metadata(root.join(path)).unwrap().modified().unwrap();
    mtime.split(':').next().unwrap() == seconds(file).to_string()
}

#[test]
fn a_status_read_refreshes_stale_stat_data_unless_another_process_holds_the_index_lock() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("répo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("commit.gpgSign", "false"),
        ("maintenance.auto", "false"),
        ("gc.auto", "0"),
    ] {
        git(&root, &["config", key, value]);
    }
    fs::write(root.join("f.txt"), "one\n").unwrap();
    git(&root, &["add", "f.txt"]);
    git(&root, &["commit", "--quiet", "-m", "Initial"]);
    let touched = SystemTime::now() - Duration::from_secs(3600);
    fs::File::options()
        .write(true)
        .open(root.join("f.txt"))
        .unwrap()
        .set_modified(touched)
        .unwrap();
    let stage = git(&root, &["ls-files", "--stage", "--debug"]);
    let path = root.to_str().unwrap();
    let coordinator = Coordinator::new(Limits::default(), temp.path().join("undo"));
    let lock = root.join(".git/index.lock");
    fs::write(&lock, "another process").unwrap();

    assert!(
        coordinator
            .worktree_status(path)
            .unwrap()
            .entries
            .is_empty()
    );
    coordinator.wait_for_refreshes();
    assert_eq!(fs::read_to_string(&lock).unwrap(), "another process");
    assert!(!cached(&root, "f.txt"), "refreshed under a foreign lock");

    fs::remove_file(&lock).unwrap();
    assert!(
        coordinator
            .worktree_status(path)
            .unwrap()
            .entries
            .is_empty()
    );
    coordinator.wait_for_refreshes();
    assert!(cached(&root, "f.txt"), "stat data stayed stale");
    let refreshed = git(&root, &["ls-files", "--stage", "--debug"]);
    let rows = |listing: &str| -> Vec<String> {
        listing
            .lines()
            .filter(|line| !line.contains("time: ") && !line.contains("ino: "))
            .map(str::to_owned)
            .collect()
    };
    assert_eq!(rows(&refreshed), rows(&stage));
    assert_eq!(
        coordinator.undo_history(path).unwrap(),
        UndoHistory {
            undo: None,
            redo: None
        }
    );
    assert!(!lock.exists());
    let leftovers: Vec<_> = fs::read_dir(root.join(".git"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| name.to_string_lossy().starts_with("l1git-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}
