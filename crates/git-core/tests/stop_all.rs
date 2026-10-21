#![cfg(unix)]

use l1_git_core::{ErrorKind, Side, stop_all_git, worktree_patch};
use std::{
    fs,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
}

fn alive(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid])
        .output()
        .unwrap()
        .status
        .success()
}

/// The only test in this binary, because `stop_all_git` stops every Git
/// command in the process.
#[test]
fn stop_all_git_stops_a_hung_read_and_every_process_it_started() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("repo");
    let pids = directory.path().join("pids");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(root.join(".gitattributes"), "*.filtered filter=test\n").unwrap();
    git(
        &root,
        &[
            "config",
            "filter.test.clean",
            &format!(
                "trap '' TERM; echo $$ >> '{}'; exec sleep 60",
                pids.display()
            ),
        ],
    );
    fs::write(root.join("new.filtered"), "new\n").unwrap();

    let path = root.to_str().unwrap().to_owned();
    let read = thread::spawn(move || worktree_patch(&path, "new.filtered", Side::Unstaged));
    let started = Instant::now();
    while fs::read_to_string(&pids).map_or(true, |pids| pids.is_empty()) {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the filter never ran"
        );
        thread::sleep(Duration::from_millis(20));
    }

    let stopping = Instant::now();
    stop_all_git();
    let error = read.join().unwrap().unwrap_err();
    assert!(matches!(error.kind, ErrorKind::GitFailed), "{error:?}");
    assert!(
        stopping.elapsed() < Duration::from_secs(2),
        "{:?}",
        stopping.elapsed()
    );
    let pid = fs::read_to_string(&pids).unwrap().trim().to_owned();
    let asked = Instant::now();
    while alive(&pid) && asked.elapsed() < Duration::from_secs(1) {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(&pid), "the filter {pid} is still running");
}
