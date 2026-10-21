#![cfg(unix)]

use l1_git_core::{ErrorKind, Side, stop_all_git, worktree_patch, worktree_status};
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

    let mut own_group = Command::new("sleep").arg("30").spawn().unwrap();
    let mut other_group = Command::new("sleep");
    other_group.arg("30");
    std::os::unix::process::CommandExt::process_group(&mut other_group, 0);
    let mut other_group = other_group.spawn().unwrap();

    let stopping = Instant::now();
    stop_all_git();
    let untouched = [
        own_group.try_wait().unwrap(),
        other_group.try_wait().unwrap(),
    ];
    for child in [&mut own_group, &mut other_group] {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert_eq!(
        untouched,
        [None, None],
        "stop_all_git signalled a process it did not start"
    );
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

    let refused = worktree_status(root.to_str().unwrap()).unwrap_err();
    assert_eq!(
        refused.message,
        "L1 Git is quitting, so it did not run Git."
    );
}
