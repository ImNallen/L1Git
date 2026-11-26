#![cfg(unix)]
//! A second L1 Git process on the configuration folder while the first one
//! sends a write: a second launch on Linux or Windows, or the dev bridge
//! beside the app.

#[allow(dead_code)]
mod support;
#[allow(dead_code)]
mod writing;

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Barrier};
use std::time::Duration;
use std::{env, fs, thread};

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, VaultChoice};
use serde_json::{Value, json};
use writing::{World, answered, ask, attempt, check_on, drafts_on, said, write_on};

const DIR: &str = "L1GIT_WRITES_TEST_DIR";
const API: &str = "L1GIT_WRITES_TEST_API";
const GH: &str = "L1GIT_WRITES_TEST_GH";

fn send_again_on(host: &Host, attempt: &str) -> Value {
    let request = json!({"op": "sendAgain", "asLogin": "octo", "repository": {"owner": "octo", "repo": "app"}, "number": 12, "attempt": attempt});
    ask(host, request)["data"].clone()
}

/// What the second process does while the first one's write is at GitHub.
fn elsewhere(host: &Host) -> Value {
    let read = drafts_on(host, json!({"kind": "read"}));
    let attempt = read["sent"][0]["attempt"]
        .as_str()
        .unwrap_or("none")
        .to_owned();
    json!({
        "read": read,
        "keep": drafts_on(host, json!({"kind": "keep", "attempt": attempt})),
        "again": send_again_on(host, &attempt)["written"],
        "check": check_on(host),
        "write": write_on(host, &writing::attempt(), json!({"kind": "comment", "pull": "PR_1", "body": "LGTM"}), json!([]))["written"],
    })
}

/// Runs only inside the process that
/// `another_process_neither_keeps_nor_sends_again_a_write_in_flight` starts.
#[test]
fn the_other_process() {
    let (Some(dir), Ok(api), Some(gh)) = (env::var_os(DIR), env::var(API), env::var_os(GH)) else {
        return;
    };
    let host = Host::new(HostConfig {
        dir: PathBuf::from(dir),
        vault: VaultChoice::Memory,
        gh: GhChoice::At(PathBuf::from(gh)),
        github: Endpoints::loopback(&api).unwrap(),
        client_id: None,
    });
    ask(&host, json!({"op": "connectGh", "login": "octo"}));
    let dir = PathBuf::from(env::var_os(DIR).unwrap());
    fs::write(dir.join("connected"), "").unwrap();
    while !dir.join("go").exists() {
        thread::sleep(Duration::from_millis(1));
    }
    println!("answers {}", elsewhere(&host));
}

fn in_flight(world: &World, during: impl FnOnce() -> Value) -> (Value, Value) {
    let carried = world.draft(json!({"kind": "conversation"}), "LGTM");
    let answering = Arc::new(Barrier::new(2));
    world.github.graphql([
        said(&[]),
        answered(
            "addComment",
            json!({"commentEdge": {"node": {"id": "IC_9"}}}),
        )
        .after(&answering),
    ]);
    let first = attempt();
    thread::scope(|scope| {
        let writing = scope.spawn(|| {
            world.wrote(
                &first,
                json!({"kind": "comment", "pull": "PR_1", "body": "LGTM"}),
                json!([carried]),
            )
        });
        while world.mutations().is_empty() {
            thread::yield_now();
        }
        let answers = during();
        answering.wait();
        (writing.join().unwrap(), answers)
    })
}

fn assert_held(world: &World, wrote: &Value, answers: &Value) {
    assert_eq!(answers["read"]["sent"][0]["sending"], true, "{answers}");
    assert_eq!(
        answers["keep"]["refused"],
        json!({"kind": "sending"}),
        "{answers}"
    );
    assert_eq!(answers["keep"]["drafts"], json!([]), "no words handed back");
    assert_eq!(answers["again"]["kind"], "notSent", "{answers}");
    assert!(
        answers["again"]["message"]
            .as_str()
            .unwrap()
            .contains("Another L1 Git window is sending this."),
        "{answers}"
    );
    assert_eq!(answers["check"]["settled"], json!([]));
    assert_eq!(answers["check"]["drafts"]["sent"][0]["sending"], true);
    assert_eq!(answers["write"]["kind"], "notSent", "{answers}");
    assert_eq!(wrote["written"]["kind"], "done", "{wrote}");
    let after = world.drafts(json!({"kind": "read"}));
    assert_eq!(
        (after["drafts"].clone(), after["sent"].clone()),
        (json!([]), json!([]))
    );
    assert_eq!(world.mutations().len(), 1, "it posted once");
    assert_eq!(
        world.github.questions().len(),
        2,
        "the other process asked GitHub nothing"
    );
}

#[test]
fn another_l1_git_on_the_folder_neither_keeps_nor_sends_again_a_write_in_flight() {
    let world = World::connected();
    let other = world.restarted();
    let (wrote, answers) = in_flight(&world, || elsewhere(&other));
    assert_held(&world, &wrote, &answers);
}

#[test]
fn another_process_neither_keeps_nor_sends_again_a_write_in_flight() {
    let world = World::connected();
    let child = Command::new(env::current_exe().unwrap())
        .args(["the_other_process", "--exact", "--nocapture"])
        .env(DIR, world.dir.path())
        .env(API, world.github.url())
        .env(GH, world.gh())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    while !world.dir.path().join("connected").exists() {
        thread::sleep(Duration::from_millis(1));
    }
    let (wrote, answers) = in_flight(&world, || {
        fs::write(world.dir.path().join("go"), "").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let line = stdout
            .lines()
            .find_map(|line| line.strip_prefix("answers "))
            .unwrap();
        serde_json::from_str(line).unwrap()
    });
    assert_held(&world, &wrote, &answers);
}
