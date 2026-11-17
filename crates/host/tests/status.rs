#![cfg(unix)]

#[allow(dead_code)]
mod support;

use std::fs;
use std::path::Path;

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};
use support::FakeGh;

fn host(dir: &Path, gh: GhChoice) -> Host {
    Host::new(HostConfig {
        dir: dir.to_owned(),
        vault: VaultChoice::Memory,
        gh,
        github: Endpoints::loopback("http://127.0.0.1:9/").unwrap(),
    })
}

fn send(host: &Host, request: Value) -> Result<Value, Value> {
    let request: Request = serde_json::from_value(request).unwrap();
    match run(host, request) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap()),
        Err(error) => Err(serde_json::to_value(error).unwrap()),
    }
}

#[test]
fn status_reads_the_saved_connection_and_runs_nothing() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("host.json"),
        r#"{"version":1,"connections":[{"api":"http://127.0.0.1:9/","login":"octo","userId":1,"method":"gh","access":"private","connectedAt":1,"generation":1}]}"#,
    )
    .unwrap();
    let gh = FakeGh::new("signed-in");
    let status = send(
        &host(dir.path(), GhChoice::At(gh.path())),
        json!({"op": "status"}),
    )
    .unwrap();
    assert_eq!(
        status["status"]["github"],
        json!({"kind": "connected", "login": "octo", "api": "http://127.0.0.1:9/", "method": "gh", "access": "private", "connectedAt": 1})
    );
    assert!(gh.calls().is_empty(), "status ran gh");
}

#[test]
fn unreadable_file_reports_ended_unreadable() {
    for contents in [
        "not json",
        r#"{"version":2,"connections":[]}"#,
        r#"{"version":1,"connections":[],"extra":true}"#,
        r#"{"version":1,"connections":[{"api":"http://example.com/","login":"octo","userId":1,"method":"gh","access":"private","connectedAt":1,"generation":1}]}"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("host.json"), contents).unwrap();
        let status = send(&host(dir.path(), GhChoice::Search), json!({"op": "status"})).unwrap();
        assert_eq!(
            status["status"]["github"],
            json!({"kind": "notConnected", "ended": {"login": null, "reason": "unreadable"}}),
            "{contents}"
        );
    }
}

#[test]
fn probe_reports_every_gh_state() {
    let dir = tempfile::tempdir().unwrap();
    let gh = FakeGh::new("signed-in");
    let host = host(dir.path(), GhChoice::At(gh.path()));
    let probe = send(&host, json!({"op": "probeGh"})).unwrap();
    assert_eq!(
        probe["data"],
        json!({"kind": "ready", "login": "octo", "access": "private", "path": gh.path().display().to_string()})
    );
    for (recording, kind) in [
        ("signed-out", "signedOut"),
        ("bad-token", "broken"),
        ("env-token", "signedOut"),
        ("unknown-flag", "outdated"),
    ] {
        gh.replay(recording);
        let probe = send(&host, json!({"op": "probeGh"})).unwrap();
        assert_eq!(probe["data"]["kind"], kind, "{recording}");
    }
    let missing = self::host(dir.path(), GhChoice::At(dir.path().join("no-gh")));
    let probe = send(&missing, json!({"op": "probeGh"})).unwrap();
    assert_eq!(probe["data"], json!({"kind": "missing"}));
    assert!(
        gh.calls()
            .iter()
            .all(|call| !call.starts_with("auth token")),
        "probing never reads a token"
    );
}

#[test]
fn revision_holds_still_and_never_goes_backwards() {
    let dir = tempfile::tempdir().unwrap();
    let gh = FakeGh::new("signed-in");
    let first = host(dir.path(), GhChoice::At(gh.path()));
    let revision = |host: &Host, op: &str| {
        send(host, json!({"op": op})).unwrap()["status"]["revision"]
            .as_u64()
            .unwrap()
    };
    let before = revision(&first, "status");
    assert_eq!(revision(&first, "probeGh"), before);
    assert_eq!(revision(&first, "status"), before);
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert!(revision(&host(dir.path(), GhChoice::At(gh.path())), "status") > before);
}
