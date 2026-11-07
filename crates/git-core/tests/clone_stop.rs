#![cfg(unix)]

use l1_git_core::{Coordinator, ErrorKind, Limits, RepositoryError};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

const SLOW: &str = "https://slow.example.test/app.git";

fn git(path: &Path, args: &[&str]) {
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
}

fn alive(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid])
        .output()
        .unwrap()
        .status
        .success()
}

fn wait_for(what: &str, ready: impl Fn() -> bool) {
    let started = Instant::now();
    while !ready() {
        assert!(started.elapsed() < Duration::from_secs(10), "{what}");
        thread::sleep(Duration::from_millis(10));
    }
}

fn clone_into(core: &Arc<Coordinator>, target: &Path) -> thread::JoinHandle<RepositoryError> {
    let (core, target) = (Arc::clone(core), target.to_owned());
    thread::spawn(move || core.clone_repository(SLOW, &target).unwrap_err())
}

/// The only test in this binary, because it puts a fake Git first on PATH. The
/// fake writes part of a clone, then hangs without cleaning up, as a killed
/// Git leaves it.
#[test]
fn stopping_a_clone_removes_only_what_it_created() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let remote = base.join("seed");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--quiet", "--initial-branch=main"]);
    git(
        &remote,
        &["commit", "--quiet", "--allow-empty", "-m", "first"],
    );

    let real = String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned();
    let pids = base.join("pids");
    let bin = base.join("bin");
    fs::create_dir(&bin).unwrap();
    fs::write(
        bin.join("git"),
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do last=\"$arg\"; [ \"$arg\" = {SLOW} ] && slow=1; done\nif [ -n \"$slow\" ]; then\n  mkdir -p \"$last\"; echo partial > \"$last/partial\"; echo $$ >> '{}'; exec sleep 30\nfi\nexec '{real}' \"$@\"\n",
            pids.display()
        ),
    )
    .unwrap();
    fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    // SAFETY: this binary runs one test, and no other thread exists yet.
    unsafe { std::env::set_var("PATH", path) };

    let core = Arc::new(Coordinator::new(Limits::default(), base.join("undo")));
    let target = base.join("created");
    let running = clone_into(&core, &target);
    wait_for("the clone never started", || {
        target.join("partial").is_file()
    });

    let duplicate = core
        .clone_repository(remote.to_str().unwrap(), &target)
        .unwrap_err();
    assert!(
        duplicate.message.contains("already cloning"),
        "{}",
        duplicate.message
    );
    assert!(
        target.join("partial").is_file(),
        "the refusal touched nothing"
    );

    core.cancel_clone(&target);
    core.cancel_clone(&target);
    let error = running.join().unwrap();
    assert!(error.message.contains("cancelled"), "{}", error.message);
    assert!(!target.exists(), "a target this clone created is removed");
    let pid = fs::read_to_string(&pids).unwrap().trim().to_owned();
    wait_for("the stopped Git is still running", || !alive(&pid));

    core.clone_repository(remote.to_str().unwrap(), &target)
        .expect("the target is free again after a stopped clone");
    assert!(target.join(".git").is_dir());

    let empty = base.join("empty");
    fs::create_dir(&empty).unwrap();
    let running = clone_into(&core, &empty);
    wait_for("the clone never started", || {
        empty.join("partial").is_file()
    });
    core.cancel_clone(&empty);
    running.join().unwrap();
    assert_eq!(
        fs::read_dir(&empty).unwrap().count(),
        0,
        "a folder that was empty is emptied"
    );
    assert!(empty.is_dir(), "and stays");

    let hurried = Arc::new(Coordinator::new(
        Limits {
            clone_deadline: Duration::from_millis(200),
            ..Limits::default()
        },
        base.join("undo"),
    ));
    let timed_out = base.join("timed-out");
    let error = clone_into(&hurried, &timed_out).join().unwrap();
    assert_eq!(error.kind, ErrorKind::TimedOut);
    assert!(!timed_out.exists(), "a timed out clone is removed too");
}
