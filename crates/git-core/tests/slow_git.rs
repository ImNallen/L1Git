#![cfg(unix)]

use l1_git_core::{Coordinator, ErrorKind, Request, Response, run};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

const CAP: Duration = Duration::from_secs(1);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .arg("-C")
        .arg(path)
        .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.test"])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn alive(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid])
        .output()
        .unwrap()
        .status
        .success()
}

/// The only test in this binary, because it puts a fake Git first on PATH.
#[test]
fn a_git_that_hangs_on_one_commit_times_out_that_detail_and_leaves_no_process() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    git(
        &root,
        &["commit", "--quiet", "--allow-empty", "-m", "first"],
    );
    let first = git(&root, &["rev-parse", "HEAD"]);
    git(&root, &["commit", "--quiet", "--allow-empty", "-m", "slow"]);
    let slow = git(&root, &["rev-parse", "HEAD"]);

    let real = String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned();
    let pids = directory.path().join("pids");
    let bin = directory.path().join("bin");
    fs::create_dir(&bin).unwrap();
    fs::write(
        bin.join("git"),
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = {slow} ]; then echo $$ >> '{}'; exec sleep 30; fi\ndone\nexec '{real}' \"$@\"\n",
            pids.display()
        ),
    )
    .unwrap();
    fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    // SAFETY: this binary runs one test, and no other thread exists yet.
    unsafe { std::env::set_var("PATH", path) };

    let coordinator = Coordinator::default().cap_reads(CAP);
    let request = |oid: &str| Request::CommitDetail {
        path: root.to_str().unwrap().to_owned(),
        oid: oid.to_owned(),
    };
    let started = Instant::now();
    let error = run(&coordinator, request(&slow)).unwrap_err();
    let elapsed = started.elapsed();
    assert!(matches!(error.kind, ErrorKind::TimedOut), "{error:?}");
    assert_eq!(
        error.message,
        "Reading this commit took longer than 1 s, so L1 Git stopped Git. Retry. If it happens again, check for a slow disk or a Git filter that does not finish."
    );
    assert!(elapsed >= CAP, "{elapsed:?}");
    assert!(
        elapsed < CAP + TERMINATE_GRACE + Duration::from_millis(500),
        "{elapsed:?}"
    );

    let pids = fs::read_to_string(&pids).unwrap();
    assert_eq!(pids.lines().count(), 1, "{pids}");
    let pid = pids.trim();
    let asked = Instant::now();
    while alive(pid) && asked.elapsed() < Duration::from_secs(1) {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(pid), "the hung Git {pid} is still running");

    let Ok(Response::CommitDetail(detail)) = run(&coordinator, request(&first)) else {
        panic!("the other commit did not load");
    };
    assert_eq!(detail.commit.oid, first);
}
