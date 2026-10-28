#![cfg(unix)]

use l1_git_core::{
    ChangeStatus, Coordinator, ErrorKind, Expect, FilePatch, Head, IndexObject, Limits, Mode, Oid,
    Operation, Request, Side, Sides, StatusEntry, WorktreePatch, run, worktree_patch,
    worktree_status,
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
        .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.test"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
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

fn unused_undo_dir() -> PathBuf {
    std::env::temp_dir().join("l1git-deadline-tests-never-write")
}

fn timed_out(request: Request) -> String {
    let coordinator = Coordinator::new(Limits::default(), unused_undo_dir()).cap_reads(CAP);
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
    assert!(
        matches!(
            status.entries.as_slice(),
            [StatusEntry::Ordinary {
                path,
                submodule: None,
                sides: Sides::Unstaged {
                    unstaged: ChangeStatus::Modified,
                },
                index: Some(_),
            }] if path == "tracked.filtered"
        ),
        "{status:?}"
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
    let coordinator =
        Coordinator::new(Limits::default(), unused_undo_dir()).cap_reads(Duration::from_millis(1));
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

#[test]
fn a_stage_that_a_filter_never_finishes_stops_at_its_deadline_and_leaves_nothing() {
    let repository = Repository::with_filter(HANGS);
    repository.edit_tracked();
    let undo = repository.root.parent().unwrap().join("undo");
    let coordinator = Coordinator::new(Limits::default(), &undo).cap_writes(CAP);
    let oid = |spec: &str| Oid::try_from(git(&repository.root, &["rev-parse", spec])).unwrap();
    let entry = StatusEntry::Ordinary {
        path: "tracked.filtered".into(),
        submodule: None,
        sides: Sides::Unstaged {
            unstaged: ChangeStatus::Modified,
        },
        index: Some(IndexObject {
            mode: Mode::File,
            oid: oid(":tracked.filtered"),
        }),
    };
    let expect = Expect {
        head: Head::Attached {
            reference: "refs/heads/main".into(),
            oid: oid("HEAD").as_str().to_owned(),
        },
    };
    let index = fs::read(repository.root.join(".git/index")).unwrap();
    let started = Instant::now();
    let error = coordinator
        .write(
            &repository.path(),
            &Operation::StageFiles {
                entries: vec![entry],
            },
            &expect,
        )
        .unwrap_err();
    let elapsed = started.elapsed();
    assert_eq!(error.kind, ErrorKind::TimedOut, "{error:?}");
    assert!(
        error.message.starts_with(
            "Staging the files took longer than 1 s, so L1 Git stopped Git. The index is unchanged."
        ),
        "{}",
        error.message
    );
    assert!(elapsed >= CAP, "{elapsed:?}");
    assert!(
        elapsed < CAP + TERMINATE_GRACE + Duration::from_millis(500),
        "{elapsed:?}"
    );
    repository.assert_filters_stopped();
    let left: Vec<_> = fs::read_dir(repository.root.join(".git"))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name == "index.lock" || name.starts_with("l1git-"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
    assert_eq!(fs::read(repository.root.join(".git/index")).unwrap(), index);
    let store = fs::read_dir(&undo).unwrap().next().unwrap().unwrap().path();
    assert_eq!(fs::read_dir(store.join("entries")).unwrap().count(), 0);
}
