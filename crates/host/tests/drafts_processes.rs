//! Two L1 Git processes on one configuration folder, as a second launch on
//! Linux or Windows makes, or the dev bridge beside the app.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{env, fs, thread};

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};

const HEAD: &str = "1111111111111111111111111111111111111111";
const PROCESSES: u32 = 3;
const DRAFTS: u32 = 40;
const DIR: &str = "L1GIT_DRAFTS_TEST_DIR";
const PROCESS: &str = "L1GIT_DRAFTS_TEST_PROCESS";

fn host(dir: &Path) -> Host {
    Host::new(HostConfig {
        dir: dir.to_owned(),
        vault: VaultChoice::Memory,
        gh: GhChoice::At(PathBuf::from("/nonexistent/gh")),
        github: Endpoints::github_com(),
        client_id: None,
    })
}

fn ask(host: &Host, number: u32, change: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(json!({
        "op": "drafts",
        "login": "octo",
        "repository": {"owner": "octo", "repo": "app"},
        "number": number,
        "change": change,
    }))
    .unwrap();
    run(host, request)
        .map(|response| serde_json::to_value(response).unwrap()["data"].clone())
        .map_err(|error| error.message)
}

/// Each process writes its own pull request and one they share, so a lost
/// update shows in both.
fn pull_of(process: u32, draft: u32) -> u32 {
    if draft.is_multiple_of(2) {
        100
    } else {
        process
    }
}

/// Runs only inside a process that `two_processes_keep_every_draft_they_confirm`
/// starts, and prints each draft its host confirmed.
#[test]
fn one_of_the_processes() {
    let (Some(dir), Ok(process)) = (env::var_os(DIR), env::var(PROCESS)) else {
        return;
    };
    let dir = PathBuf::from(dir);
    let process: u32 = process.parse().unwrap();
    let host = host(&dir);
    while !dir.join("go").exists() {
        thread::sleep(Duration::from_millis(1));
    }
    for draft in 0..DRAFTS {
        let thread = format!("T_{process}_{draft}");
        let change = json!({"kind": "put", "anchor": {"kind": "reply", "thread": thread}, "head": HEAD, "text": thread, "at": null});
        match ask(&host, pull_of(process, draft), change) {
            Ok(answer) if answer["refused"].is_null() => println!("confirmed {thread}"),
            Ok(answer) => println!("refused {thread} {}", answer["refused"]),
            Err(message) => println!("failed {thread} {message}"),
        }
    }
}

#[test]
fn two_processes_keep_every_draft_they_confirm() {
    let dir = tempfile::tempdir().unwrap();
    let children: Vec<_> = (1..=PROCESSES)
        .map(|process| {
            Command::new(env::current_exe().unwrap())
                .args(["one_of_the_processes", "--exact", "--nocapture"])
                .env(DIR, dir.path())
                .env(PROCESS, process.to_string())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    thread::sleep(Duration::from_millis(200));
    fs::write(dir.path().join("go"), "").unwrap();

    let started = Instant::now();
    let mut confirmed = BTreeSet::new();
    let mut other = Vec::new();
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        for line in String::from_utf8(output.stdout).unwrap().lines() {
            if let Some(thread) = line.strip_prefix("confirmed ") {
                confirmed.insert(thread.to_owned());
            } else if line.starts_with("refused ") || line.starts_with("failed ") {
                other.push(line.to_owned());
            }
        }
    }
    assert!(started.elapsed() < Duration::from_secs(60));

    let reader = host(dir.path());
    let kept: BTreeSet<String> = (1..=PROCESSES)
        .chain([100])
        .flat_map(|number| {
            ask(&reader, number, json!({"kind": "read"})).unwrap()["drafts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|draft| draft["text"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(other, Vec::<String>::new(), "every save landed and said so");
    assert_eq!(
        kept, confirmed,
        "every confirmed draft is kept, and no other"
    );
    assert_eq!(confirmed.len(), (PROCESSES * DRAFTS) as usize);
}
