#![cfg(unix)]

use l1_git_core::{
    ChangeStatus, Coordinator, ErrorKind, FilePatch, Request, Side, Sides, StatusEntry,
    WorktreePatch, run, worktree_patch, worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime},
};
use tempfile::TempDir;

const CAP: Duration = Duration::from_secs(1);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const HANGS: &str = "echo $$ >> {pids}; exec sleep 30";
const LEAVES_STDERR_OPEN: &str = "sh -c 'sleep 10 </dev/null >/dev/null & cat'";

fn git(path: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("-C")
        .arg(path)
        .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.test"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

struct Repository {
    _directory: TempDir,
    root: PathBuf,
    pids: PathBuf,
}

impl Repository {
    /// Commits `tracked.filtered` before the filter exists, so the commit
    /// itself never runs it. `{pids}` in `clean` names a file for process IDs.
    fn with_filter(clean: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        let pids = directory.path().join("pids");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet", "--initial-branch=main"]);
        git(&root, &["config", "core.hooksPath", "/dev/null"]);
        fs::write(root.join(".gitattributes"), "*.filtered filter=test\n").unwrap();
        fs::write(root.join("tracked.filtered"), "before\n").unwrap();
        git(&root, &["add", "--", ".gitattributes", "tracked.filtered"]);
        git(&root, &["commit", "--quiet", "-m", "initial"]);
        let clean = clean.replace("{pids}", &format!("'{}'", pids.display()));
        git(&root, &["config", "filter.test.clean", &clean]);
        Self {
            _directory: directory,
            root,
            pids,
        }
    }

    fn path(&self) -> String {
        self.root.to_str().unwrap().to_owned()
    }

    /// The same size with a new mtime, so Git must run the clean filter to
    /// compare the file with the index.
    fn edit_tracked(&self) {
        let path = self.root.join("tracked.filtered");
        fs::write(&path, "after!\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(60))
            .unwrap();
    }

    fn assert_filters_stopped(&self) {
        let pids = fs::read_to_string(&self.pids).unwrap();
        assert!(!pids.trim().is_empty(), "the filter never ran");
        let alive = |pid: &&str| {
            Command::new("kill")
                .args(["-0", pid])
                .output()
                .unwrap()
                .status
                .success()
        };
        let asked = Instant::now();
        while pids.split_whitespace().any(|pid| alive(&pid))
            && asked.elapsed() < Duration::from_secs(1)
        {
            thread::sleep(Duration::from_millis(20));
        }
        let survivors: Vec<_> = pids.split_whitespace().filter(alive).collect();
        assert!(survivors.is_empty(), "still running: {survivors:?}");
    }
}

fn timed_out(request: Request) -> String {
    let coordinator = Coordinator::default().cap_reads(CAP);
    let started = Instant::now();
    let error = run(&coordinator, request).unwrap_err();
    let elapsed = started.elapsed();
    assert!(matches!(error.kind, ErrorKind::TimedOut), "{error:?}");
    assert!(elapsed >= CAP, "{elapsed:?}");
    assert!(
        elapsed < CAP + TERMINATE_GRACE + Duration::from_millis(500),
        "{elapsed:?}"
    );
    error.message
}

fn quickly<T>(read: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = read();
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    value
}

#[test]
fn a_filter_that_never_finishes_times_out_worktree_status_and_leaves_no_process() {
    let repository = Repository::with_filter(HANGS);
    repository.edit_tracked();
    assert_eq!(
        timed_out(Request::WorktreeStatus {
            path: repository.path(),
        }),
        "Reading the worktree status took longer than 1 s, so L1 Git stopped Git. Retry. If it happens again, check for a slow disk or a Git filter that does not finish."
    );
    repository.assert_filters_stopped();
}

#[test]
fn a_filter_that_never_finishes_times_out_an_untracked_patch_and_leaves_no_process() {
    let repository = Repository::with_filter(HANGS);
    fs::write(repository.root.join("new.filtered"), "new\n").unwrap();
    assert_eq!(
        timed_out(Request::WorktreePatch {
            path: repository.path(),
            file: "new.filtered".into(),
            side: Side::Unstaged,
        }),
        "Reading this file's changes took longer than 1 s, so L1 Git stopped Git. Retry. If it happens again, check for a slow disk or a Git filter that does not finish."
    );
    repository.assert_filters_stopped();
}

#[test]
fn a_filter_that_ignores_sigterm_is_still_stopped() {
    let repository = Repository::with_filter(&format!("trap '' TERM; {HANGS}"));
    repository.edit_tracked();
    timed_out(Request::WorktreeStatus {
        path: repository.path(),
    });
    repository.assert_filters_stopped();
}

#[test]
fn a_filter_that_leaves_stderr_open_stalls_neither_status_nor_a_tracked_patch() {
    let repository = Repository::with_filter(LEAVES_STDERR_OPEN);
    repository.edit_tracked();
    let path = repository.path();
    let status = quickly(|| worktree_status(&path)).unwrap();
    assert_eq!(
        status.entries,
        vec![StatusEntry::Ordinary {
            path: "tracked.filtered".into(),
            submodule: None,
            sides: Sides::Unstaged {
                unstaged: ChangeStatus::Modified,
            },
        }]
    );
    let patch = quickly(|| worktree_patch(&path, "tracked.filtered", Side::Unstaged)).unwrap();
    let WorktreePatch::Diff {
        diff: FilePatch::Text { patch, .. },
    } = patch
    else {
        panic!("{patch:?}");
    };
    assert!(
        patch.ends_with("@@ -1 +1 @@\n-before\n+after!\n"),
        "{patch}"
    );
}

#[test]
fn file_history_and_blame_stop_at_their_deadlines() {
    let repository = Repository::with_filter("cat");
    let oid = fs::read_to_string(repository.root.join(".git/refs/heads/main")).unwrap();
    let coordinator = Coordinator::default().cap_reads(Duration::from_millis(1));
    let (path, oid, file) = (
        repository.path(),
        oid.trim().to_owned(),
        "tracked.filtered".to_owned(),
    );
    for (request, subject) in [
        (
            Request::FileHistory {
                path: path.clone(),
                oid: oid.clone(),
                file: file.clone(),
            },
            "Reading this file's history took longer than 1 ms",
        ),
        (
            Request::Blame { path, oid, file },
            "Reading this file's blame took longer than 1 ms",
        ),
    ] {
        let error = run(&coordinator, request).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::TimedOut), "{error:?}");
        assert!(error.message.starts_with(subject), "{}", error.message);
    }
}
