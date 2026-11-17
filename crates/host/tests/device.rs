#![cfg(unix)]

#[allow(dead_code)]
mod support;

use std::path::Path;

use l1_git_host::{ClientId, Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};
use support::{DEVICE_CODE, FakeGitHub, Form, Reply, Seen, USER_CODE};

fn host(dir: &Path, github: &FakeGitHub, client_id: Option<&str>) -> Host {
    Host::new(HostConfig {
        dir: dir.to_owned(),
        vault: VaultChoice::Memory,
        gh: GhChoice::At(dir.join("no-gh")),
        github: Endpoints::loopback(&github.url()).unwrap(),
        client_id: client_id.map(ClientId::new),
    })
}

fn send(host: &Host, request: Value) -> Result<Value, Value> {
    let request: Request = serde_json::from_value(request).unwrap();
    let reply = match run(host, request) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap()),
        Err(error) => Err(serde_json::to_value(error).unwrap()),
    };
    let (Ok(value) | Err(value)) = &reply;
    let text = value.to_string();
    assert!(
        !text.contains(DEVICE_CODE) && !text.contains("gho_"),
        "a secret escaped: {text}"
    );
    reply
}

struct World {
    dir: tempfile::TempDir,
    github: FakeGitHub,
    host: Host,
}

impl World {
    fn new(interval_secs: u64) -> World {
        let dir = tempfile::tempdir().unwrap();
        let github = FakeGitHub::start();
        github.device_code(Reply::device_code(
            &format!("{}login/device", github.url()),
            interval_secs,
        ));
        let host = host(dir.path(), &github, Some("fixture-client"));
        World { dir, github, host }
    }

    fn send(&self, request: Value) -> Result<Value, Value> {
        send(&self.host, request)
    }

    fn start(&self) -> Value {
        self.send(json!({"op": "deviceStart"})).unwrap()["status"]["deviceCode"].clone()
    }

    fn poll(&self, prompt: &Value) -> Result<Value, Value> {
        self.send(json!({"op": "devicePoll", "session": prompt["session"]}))
    }

    fn token_requests(&self) -> usize {
        self.github
            .forms()
            .iter()
            .filter(|form| form.path == "/login/oauth/access_token")
            .count()
    }
}

#[test]
fn browser_sign_in_end_to_end() {
    let world = World::new(0);
    world.github.polls_then_pending([
        Reply::oauth_error("authorization_pending"),
        Reply::access_token("gho_device"),
    ]);
    world
        .github
        .answer("gho_device", Reply::user("octo", 1, Some("repo, read:org")));
    let fresh = world.send(json!({"op": "status"})).unwrap()["status"].clone();
    assert_eq!(fresh["deviceSignIn"], true);
    assert_eq!(fresh["deviceCode"], Value::Null);

    let prompt = world.start();
    assert_eq!(prompt["userCode"], USER_CODE);
    assert_eq!(
        prompt["verificationUri"],
        format!("{}login/device", world.github.url())
    );
    assert!(
        prompt["expiresInMs"].as_u64().unwrap() > 890_000,
        "{prompt}"
    );
    assert_eq!(
        world.github.forms(),
        [Form {
            path: "/login/device/code".to_owned(),
            body: "client_id=fixture-client&scope=repo".to_owned(),
        }]
    );

    let pending = world.poll(&prompt).unwrap()["status"].clone();
    assert_eq!(pending["github"]["kind"], "notConnected");
    assert_eq!(pending["deviceCode"]["session"], prompt["session"]);
    assert!(pending["revision"].as_u64() > fresh["revision"].as_u64());

    let connected = world.poll(&prompt).unwrap()["status"].clone();
    assert_eq!(connected["deviceCode"], Value::Null);
    let github = &connected["github"];
    assert_eq!(github["kind"], "connected");
    assert_eq!(github["login"], "octo");
    assert_eq!(github["method"], "device");
    assert_eq!(github["access"], "private");
    let poll = Form {
        path: "/login/oauth/access_token".to_owned(),
        body: format!(
            "client_id=fixture-client&device_code={DEVICE_CODE}&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
        ),
    };
    assert_eq!(world.github.forms()[1..], [poll.clone(), poll]);
    assert_eq!(
        world.github.seen(),
        [Seen {
            path: "/user".to_owned(),
            authorization: Some("Bearer gho_device".to_owned()),
        }]
    );

    let stale = world.poll(&prompt).unwrap();
    assert_eq!(stale["status"], connected, "a stale timer changes nothing");
    assert_eq!(world.token_requests(), 2);

    let restarted = host(world.dir.path(), &world.github, Some("fixture-client"));
    let saved = send(&restarted, json!({"op": "status"})).unwrap();
    assert_eq!(saved["status"]["github"]["login"], "octo");
    assert_eq!(saved["status"]["github"]["method"], "device");
}

#[test]
fn slow_down_grows_the_interval_and_an_early_poll_stays_home() {
    let world = World::new(0);
    world
        .github
        .polls_then_pending([Reply::oauth_error("slow_down")]);
    let prompt = world.start();
    assert_eq!(prompt["pollAfterMs"], 0);

    let slowed = world.poll(&prompt).unwrap()["status"].clone();
    let wait = slowed["deviceCode"]["pollAfterMs"].as_u64().unwrap();
    assert!((4_000..=5_000).contains(&wait), "{wait}");

    let early = world.poll(&prompt).unwrap()["status"].clone();
    assert_eq!(world.token_requests(), 1, "an early poll asked GitHub");
    assert_eq!(early["revision"], slowed["revision"]);
    let left = early["deviceCode"]["pollAfterMs"].as_u64().unwrap();
    assert!(left > 0 && left <= wait, "{left}");
}

#[test]
fn expired_and_denied_codes_end_the_session() {
    for (answer, kind) in [
        ("expired_token", "deviceExpired"),
        ("access_denied", "deviceDenied"),
    ] {
        let world = World::new(0);
        world
            .github
            .polls_then_pending([Reply::oauth_error(answer)]);
        let prompt = world.start();
        let error = world.poll(&prompt).unwrap_err();
        assert_eq!(error["kind"], kind);
        assert_eq!(error["status"]["deviceCode"], Value::Null);
        assert_eq!(
            error["status"]["github"],
            json!({"kind": "notConnected", "ended": null})
        );
        world.poll(&prompt).unwrap();
        assert_eq!(world.token_requests(), 1, "{answer}: polled after the end");
        assert!(!world.dir.path().join("host.json").exists());
    }
}

#[test]
fn cancel_replace_and_stale_sessions_are_harmless() {
    let world = World::new(0);
    let first = world.start();
    let second = world.start();
    assert_ne!(first["session"], second["session"]);
    let replaced = world.poll(&first).unwrap();
    assert_eq!(
        replaced["status"]["deviceCode"]["session"],
        second["session"]
    );
    assert_eq!(world.token_requests(), 0, "polled a replaced session");

    let cancel = json!({"op": "deviceCancel", "session": second["session"]});
    let cancelled = world.send(cancel.clone()).unwrap();
    assert_eq!(cancelled["status"]["deviceCode"], Value::Null);
    let again = world.send(cancel).unwrap();
    assert_eq!(again["status"], cancelled["status"]);
    world.poll(&second).unwrap();
    assert_eq!(world.token_requests(), 0, "polled a cancelled session");
}

#[test]
fn start_keeps_no_session_when_github_refuses_or_names_another_site() {
    let world = World::new(5);
    world
        .github
        .device_code(Reply::oauth_error("device_flow_disabled"));
    let refused = world.send(json!({"op": "deviceStart"})).unwrap_err();
    assert_eq!(refused["kind"], "gitHubFailed");
    assert_eq!(refused["status"]["deviceCode"], Value::Null);

    world
        .github
        .device_code(Reply::device_code("https://example.com/login/device", 5));
    let elsewhere = world.send(json!({"op": "deviceStart"})).unwrap_err();
    assert_eq!(elsewhere["kind"], "gitHubFailed");
    assert_eq!(elsewhere["status"]["deviceCode"], Value::Null);
}

#[test]
fn without_a_client_id_browser_sign_in_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let github = FakeGitHub::start();
    let host = host(dir.path(), &github, None);
    let status = send(&host, json!({"op": "status"})).unwrap();
    assert_eq!(status["status"]["deviceSignIn"], false);
    for request in [
        json!({"op": "deviceStart"}),
        json!({"op": "devicePoll", "session": "1"}),
        json!({"op": "deviceCancel", "session": "1"}),
    ] {
        let error = send(&host, request.clone()).unwrap_err();
        assert_eq!(error["kind"], "deviceUnavailable", "{request}");
        assert_eq!(error["status"]["deviceSignIn"], false);
    }
    assert!(github.forms().is_empty());
}
