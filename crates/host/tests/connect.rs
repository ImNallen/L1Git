#![cfg(unix)]

#[allow(dead_code)]
mod support;

use std::path::Path;
use std::sync::Arc;
use std::{fs, thread};

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};
use support::{FakeGh, FakeGitHub, Reply, Seen};

struct World {
    dir: tempfile::TempDir,
    gh: FakeGh,
    github: FakeGitHub,
    host: Host,
}

impl World {
    fn new() -> World {
        let dir = tempfile::tempdir().unwrap();
        let gh = FakeGh::new("signed-in");
        gh.token("octo", "gho_octo");
        let github = FakeGitHub::start();
        github.answer(
            "gho_octo",
            Reply::user("octo", 1, Some("gist, read:org, repo, workflow")),
        );
        let host = host(dir.path(), GhChoice::At(gh.path()), &github);
        World {
            dir,
            gh,
            github,
            host,
        }
    }

    fn send(&self, request: Value) -> Result<Value, Value> {
        send(&self.host, request)
    }

    fn restart(&self) -> Host {
        host(self.dir.path(), GhChoice::At(self.gh.path()), &self.github)
    }

    fn file(&self) -> String {
        fs::read_to_string(self.dir.path().join("host.json")).unwrap_or_default()
    }
}

fn host(dir: &Path, gh: GhChoice, github: &FakeGitHub) -> Host {
    Host::new(HostConfig {
        dir: dir.to_owned(),
        vault: VaultChoice::Memory,
        gh,
        github: Endpoints::loopback(&github.url()).unwrap(),
        client_id: None,
    })
}

fn send(host: &Host, request: Value) -> Result<Value, Value> {
    let request: Request = serde_json::from_value(request).unwrap();
    match run(host, request) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap()),
        Err(error) => Err(serde_json::to_value(error).unwrap()),
    }
}

fn connect(login: &str) -> Value {
    json!({"op": "connectGh", "login": login})
}

fn seen(authorization: &str) -> Seen {
    Seen {
        path: "/user".to_owned(),
        authorization: Some(format!("Bearer {authorization}")),
    }
}

#[test]
fn connect_gh_end_to_end() {
    let world = World::new();
    let probe = world.send(json!({"op": "probeGh"})).unwrap();
    assert_eq!(
        probe["data"],
        json!({"kind": "ready", "login": "octo", "access": "private", "path": world.gh.path().display().to_string()})
    );

    let connected = world.send(connect("octo")).unwrap();
    assert_eq!(connected["op"], "connectGh");
    let github = &connected["status"]["github"];
    assert_eq!(github["kind"], "connected");
    assert_eq!(github["login"], "octo");
    assert_eq!(github["api"], world.github.url());
    assert_eq!(github["method"], "gh");
    assert_eq!(github["access"], "private");
    assert_eq!(world.github.seen(), [seen("gho_octo")]);
    assert!(
        world
            .gh
            .calls()
            .contains(&"auth token --hostname github.com --user octo".to_owned()),
        "{:?}",
        world.gh.calls()
    );

    let file = world.file();
    for field in [
        r#""login":"octo""#,
        r#""generation":"#,
        r#""api":"http://127.0.0.1"#,
    ] {
        assert!(file.contains(field), "{file}");
    }
    let replies = [
        probe,
        connected,
        world.send(json!({"op": "status"})).unwrap(),
    ];
    for text in replies.iter().map(Value::to_string).chain([file]) {
        assert!(!text.contains("gho_"), "a token escaped: {text}");
    }

    let restarted = send(&world.restart(), json!({"op": "status"})).unwrap();
    assert_eq!(restarted["status"]["github"]["login"], "octo");
}

#[test]
fn connect_copies_the_consented_account_after_gh_switches() {
    let world = World::new();
    world.send(json!({"op": "probeGh"})).unwrap();
    world.gh.signed_in_as("hubot");
    world.gh.token("hubot", "gho_hubot");
    world
        .github
        .answer("gho_hubot", Reply::user("hubot", 2, Some("repo")));
    let connected = world.send(connect("octo")).unwrap();
    assert_eq!(connected["status"]["github"]["login"], "octo");
    assert_eq!(world.github.seen(), [seen("gho_octo")]);
}

#[test]
fn connect_refuses_a_token_for_another_account() {
    let world = World::new();
    world
        .github
        .answer("gho_octo", Reply::user("hubot", 2, Some("repo")));
    let error = world.send(connect("octo")).unwrap_err();
    assert_eq!(error["kind"], "ghAccountChanged");
    assert_eq!(error["expected"], "octo");
    assert_eq!(error["found"], "hubot");
    assert_eq!(
        error["status"]["github"],
        json!({"kind": "notConnected", "ended": null})
    );
    assert_eq!(world.file(), "", "nothing was saved");
}

#[test]
fn connect_when_gh_lost_the_account() {
    let world = World::new();
    world.gh.forget("octo");
    let error = world.send(connect("octo")).unwrap_err();
    assert_eq!(error["kind"], "ghSignedOut");
    assert!(world.github.seen().is_empty());
    assert_eq!(world.file(), "");
}

#[test]
fn connect_rejected_token() {
    let world = World::new();
    world.github.answer("gho_octo", Reply::bad_credentials());
    let error = world.send(connect("octo")).unwrap_err();
    assert_eq!(error["kind"], "rejected");
    assert_eq!(
        error["status"]["github"],
        json!({"kind": "notConnected", "ended": null})
    );
    assert_eq!(world.file(), "");
}

#[test]
fn rate_limit_reports_when_it_resets() {
    let world = World::new();
    world
        .github
        .answer("gho_octo", Reply::rate_limited(4_000_000_000));
    let error = world.send(connect("octo")).unwrap_err();
    assert_eq!(error["kind"], "rateLimited");
    assert_eq!(error["resetAt"], 4_000_000_000_u64);
}

#[test]
fn redirects_never_carry_the_token() {
    let world = World::new();
    let elsewhere = FakeGitHub::start();
    world.github.answer(
        "gho_octo",
        Reply::redirect(&format!("{}user", elsewhere.url())),
    );
    let error = world.send(connect("octo")).unwrap_err();
    assert_eq!(error["kind"], "gitHubFailed");
    assert_eq!(error["httpStatus"], 302);
    assert!(elsewhere.seen().is_empty());
}

#[test]
fn verify_revoked_forgets() {
    let world = World::new();
    world.send(connect("octo")).unwrap();
    world.github.answer("gho_octo", Reply::bad_credentials());
    let error = world.send(json!({"op": "verify"})).unwrap_err();
    assert_eq!(error["kind"], "signedOut");
    assert_eq!(
        error["status"]["github"],
        json!({"kind": "notConnected", "ended": {"login": "octo", "reason": "revoked"}})
    );
    assert!(!world.file().contains("octo"), "{}", world.file());
    let again = world.send(json!({"op": "verify"})).unwrap_err();
    assert_eq!(again["kind"], "notConnected");
}

#[test]
fn verify_refreshes_login_and_access() {
    let world = World::new();
    world.send(connect("octo")).unwrap();
    world
        .github
        .answer("gho_octo", Reply::user("octo-renamed", 1, Some("read:org")));
    let verified = world.send(json!({"op": "verify"})).unwrap();
    assert_eq!(verified["status"]["github"]["login"], "octo-renamed");
    assert_eq!(verified["status"]["github"]["access"], "publicOnly");
    let restarted = send(&world.restart(), json!({"op": "status"})).unwrap();
    assert_eq!(restarted["status"]["github"]["login"], "octo-renamed");
}

#[test]
fn double_connect_serializes() {
    let world = Arc::new(World::new());
    world.gh.serial_slow_tokens();
    let clicks: Vec<_> = (0..2)
        .map(|_| {
            let world = Arc::clone(&world);
            thread::spawn(move || world.send(connect("octo")))
        })
        .collect();
    for click in clicks {
        let reply = click.join().unwrap().unwrap();
        assert_eq!(reply["status"]["github"]["login"], "octo");
    }
    let tokens = world
        .gh
        .calls()
        .iter()
        .filter(|call| call.starts_with("auth token"))
        .count();
    assert_eq!(tokens, 2);
    assert_eq!(world.file().matches(r#""login""#).count(), 1);
}

#[test]
fn revision_moves_only_on_change() {
    let world = World::new();
    let revision = |reply: &Result<Value, Value>| match reply {
        Ok(value) | Err(value) => value["status"]["revision"].as_u64().unwrap(),
    };
    let first = revision(&world.send(json!({"op": "status"})));
    assert_eq!(revision(&world.send(json!({"op": "status"}))), first);
    assert_eq!(revision(&world.send(json!({"op": "probeGh"}))), first);
    let connected = revision(&world.send(connect("octo")));
    assert!(connected > first);
    let verified = revision(&world.send(json!({"op": "verify"})));
    assert_eq!(verified, connected, "nothing changed");
    world
        .github
        .answer("gho_octo", Reply::user("octo-renamed", 1, Some("repo")));
    let renamed = revision(&world.send(json!({"op": "verify"})));
    assert!(renamed > verified);
    let disconnected = revision(&world.send(json!({"op": "disconnect"})));
    assert!(disconnected > renamed);
}
