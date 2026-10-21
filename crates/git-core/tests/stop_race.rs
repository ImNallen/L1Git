#![cfg(unix)]

use l1_git_core::{refs, stop_all_git};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const CHILD: &str = "L1GIT_STOP_RACE_DIRECTORY";
const ROUNDS: usize = 20;
const READERS: usize = 8;

fn alive_sleeps(pids: &Path) -> Vec<String> {
    let Ok(pids) = fs::read_to_string(pids) else {
        return Vec::new();
    };
    pids.split_whitespace()
        .filter(|pid| {
            Command::new("ps")
                .args(["-o", "command=", "-p", pid])
                .output()
                .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "sleep 5")
        })
        .map(str::to_owned)
        .collect()
}

/// Runs only inside the process that `stop_all_git_reaches_a_command_that_is_starting`
/// starts, so stopping Git cannot touch the other test.
#[test]
fn reader_process() {
    let Ok(directory) = env::var(CHILD) else {
        return;
    };
    for _ in 0..READERS {
        let directory = directory.clone();
        thread::spawn(move || {
            while refs(&directory).is_err_and(|error| !error.message.contains("quitting")) {}
        });
    }
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
        % 1_200_000;
    thread::sleep(Duration::from_nanos(u64::from(jitter)));
    stop_all_git();
    std::process::exit(0);
}

#[test]
fn stop_all_git_reaches_a_command_that_is_starting() {
    let directory = tempfile::tempdir().unwrap();
    let bin = directory.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let path = format!("{}:{}", bin.display(), env::var("PATH").unwrap());
    let mut survivors = Vec::new();
    for round in 0..ROUNDS {
        let pids = directory.path().join(format!("pids-{round}"));
        fs::write(
            bin.join("git"),
            format!("#!/bin/sh\necho $$ >> '{}'\nexec sleep 5\n", pids.display()),
        )
        .unwrap();
        fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
        let status = Command::new(env::current_exe().unwrap())
            .args(["reader_process", "--exact", "--nocapture"])
            .env(CHILD, directory.path())
            .env("PATH", &path)
            .status()
            .unwrap();
        thread::sleep(Duration::from_millis(300));
        for pid in alive_sleeps(&pids) {
            Command::new("kill").args(["-9", &pid]).status().unwrap();
            survivors.push(format!("round {round}: {pid}"));
        }
        assert!(status.success(), "round {round}: {status}");
    }
    assert!(
        survivors.is_empty(),
        "Git outlived stop_all_git: {survivors:?}"
    );
}
