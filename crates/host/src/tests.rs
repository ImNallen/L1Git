use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::github::{ApiBase, ApiError, Verified};
use crate::support::{FakeGh, FakeGitHub, Reply};
use crate::vault::{Token, Vault};
use crate::wire::Failure;
use crate::*;

type Hook = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct RecordingVault {
    items: Mutex<HashMap<String, String>>,
    calls: Mutex<Vec<&'static str>>,
    failing: Mutex<HashMap<&'static str, KeychainProblem>>,
    during_replace: Mutex<Option<Hook>>,
}

impl RecordingVault {
    fn call(&self, name: &'static str) -> Result<(), KeychainProblem> {
        self.calls.lock().unwrap().push(name);
        self.failing
            .lock()
            .unwrap()
            .get(name)
            .copied()
            .map_or(Ok(()), Err)
    }

    fn fail(&self, name: &'static str, problem: KeychainProblem) {
        self.failing.lock().unwrap().insert(name, problem);
    }

    fn heal(&self) {
        self.failing.lock().unwrap().clear();
    }

    fn during_replace(&self, hook: impl FnOnce() + Send + 'static) {
        *self.during_replace.lock().unwrap() = Some(Box::new(hook));
    }

    fn tokens(&self) -> Vec<String> {
        self.items.lock().unwrap().values().cloned().collect()
    }

    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

impl Vault for Arc<RecordingVault> {
    fn open(&self) -> Result<(), KeychainProblem> {
        self.call("open")
    }

    fn read(&self, api: &ApiBase) -> Result<Option<Token>, KeychainProblem> {
        self.call("read")?;
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(api.as_str())
            .and_then(|secret| Token::parse(secret)))
    }

    fn replace(&self, api: &ApiBase, token: &Token) -> Result<(), KeychainProblem> {
        self.call("replace")?;
        if let Some(hook) = self.during_replace.lock().unwrap().take() {
            hook();
        }
        self.items
            .lock()
            .unwrap()
            .insert(api.as_str().to_owned(), token.expose().to_owned());
        Ok(())
    }

    fn delete_if_present(&self, api: &ApiBase) -> Result<(), KeychainProblem> {
        self.call("delete")?;
        self.items.lock().unwrap().remove(api.as_str());
        Ok(())
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    vault: Arc<RecordingVault>,
    gh: FakeGh,
    github: FakeGitHub,
    host: Host,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(RecordingVault::default());
        let gh = FakeGh::new("signed-in");
        let github = FakeGitHub::start();
        let host = open(dir.path(), &vault, &gh, &github);
        Fixture {
            dir,
            vault,
            gh,
            github,
            host,
        }
    }

    fn restart(&self) -> Host {
        open(self.dir.path(), &self.vault, &self.gh, &self.github)
    }

    fn connect(&self, token: &str, login: &str) -> Result<(), Failure> {
        let host = &self.host;
        host.commit(
            &host.lock_writes(),
            Verified::assume(token, login, 1, Access::Private),
        )
    }

    fn file(&self) -> Value {
        file(self.dir.path())
    }
}

fn open(dir: &Path, vault: &Arc<RecordingVault>, gh: &FakeGh, github: &FakeGitHub) -> Host {
    Host::with_vault(
        dir.to_owned(),
        Endpoints::loopback(&github.url()).unwrap(),
        GhChoice::At(gh.path()),
        Box::new(Arc::clone(vault)),
    )
}

fn file(dir: &Path) -> Value {
    fs::read(dir.join("host.json"))
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        .unwrap_or(Value::Null)
}

fn saved_logins(file: &Value) -> Vec<String> {
    file["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|connection| connection["login"].as_str().unwrap().to_owned())
        .collect()
}

fn github(host: &Host) -> Value {
    serde_json::to_value(host.status().github).unwrap()
}

fn connected_as(host: &Host) -> Option<String> {
    match host.status().github {
        GitHubStatus::Connected(view) => Some(view.login),
        GitHubStatus::NotConnected { .. } => None,
    }
}

fn kind(result: Result<Response, HostError>) -> ErrorKind {
    result.expect_err("the request fails").kind
}

#[test]
fn status_never_touches_vault_gh_or_network() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    let host = fixture.restart();
    let before = fixture.vault.calls().len();
    for _ in 0..3 {
        let status = run(&host, Request::Status {}).unwrap().status;
        assert!(matches!(status.github, GitHubStatus::Connected(_)));
    }
    assert_eq!(
        fixture.vault.calls().len(),
        before,
        "status read the keychain"
    );
    assert!(fixture.gh.calls().is_empty(), "status ran gh");
    assert!(fixture.github.seen().is_empty(), "status called GitHub");

    let _ = run(&host, Request::Verify {});
    assert!(
        fixture.vault.calls().len() > before,
        "verify reads the keychain"
    );
    assert_eq!(fixture.github.seen().len(), 1, "verify calls GitHub");
}

#[test]
fn unusable_keychain_fails_before_gh_hands_over_a_token() {
    let fixture = Fixture::new();
    fixture.gh.token("octo", "gho_one");
    fixture.vault.fail("open", KeychainProblem::Unavailable);
    let request = serde_json::from_value(json!({"op": "connectGh", "login": "octo"})).unwrap();
    assert_eq!(
        kind(run(&fixture.host, request)),
        ErrorKind::Keychain {
            problem: KeychainProblem::Unavailable
        }
    );
    assert!(
        !fixture
            .gh
            .calls()
            .iter()
            .any(|call| call.starts_with("auth token")),
        "{:?}",
        fixture.gh.calls()
    );
    assert!(fixture.github.seen().is_empty());
    assert_eq!(fixture.file(), Value::Null, "nothing was saved");
}

#[test]
fn reconnect_writes_the_slot_only_while_no_record_names_it() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    let seen = Arc::new(Mutex::new(None));
    let dir = fixture.dir.path().to_owned();
    let during = Arc::clone(&seen);
    fixture
        .vault
        .during_replace(move || *during.lock().unwrap() = Some(saved_logins(&file(&dir))));
    fixture.connect("gho_two", "hubot").unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(Vec::<String>::new()));
    assert_eq!(saved_logins(&fixture.file()), ["hubot"]);
    assert_eq!(fixture.vault.tokens(), ["gho_two"]);
}

#[test]
fn crash_after_vault_write_is_not_connected() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    let blocker = fixture.dir.path().join("host.tmp");
    let block = blocker.clone();
    fixture
        .vault
        .during_replace(move || fs::create_dir(block).unwrap());
    let failed = fixture.connect("gho_two", "hubot").unwrap_err();
    assert_eq!(failed.kind, ErrorKind::Storage);
    assert_eq!(connected_as(&fixture.host), None);
    assert_eq!(connected_as(&fixture.restart()), None, "a restart agrees");
    assert!(saved_logins(&fixture.file()).is_empty());
    assert_eq!(
        fixture.vault.tokens(),
        ["gho_two"],
        "the orphan sits in the one slot"
    );

    fs::remove_dir(blocker).unwrap();
    fixture.connect("gho_three", "octo").unwrap();
    assert_eq!(connected_as(&fixture.host).as_deref(), Some("octo"));
    assert_eq!(
        fixture.vault.tokens(),
        ["gho_three"],
        "the next connect overwrites it"
    );
}

#[test]
fn failed_vault_write_keeps_nothing() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    let before = fixture.host.status().revision;
    fixture.vault.fail("replace", KeychainProblem::Locked);
    let failed = fixture.connect("gho_two", "octo").unwrap_err();
    assert_eq!(
        failed.kind,
        ErrorKind::Keychain {
            problem: KeychainProblem::Locked
        }
    );
    assert_eq!(connected_as(&fixture.host), None);
    assert!(saved_logins(&fixture.file()).is_empty());
    assert!(fixture.host.status().revision > before);
}

#[test]
fn disconnect_is_idempotent_and_clears_orphans() {
    let fixture = Fixture::new();
    let api = Endpoints::loopback(&fixture.github.url()).unwrap();
    fixture
        .vault
        .replace(api.api(), &Token::parse("gho_orphan").unwrap())
        .unwrap();
    run(&fixture.host, Request::Disconnect {}).unwrap();
    assert!(fixture.vault.tokens().is_empty());
    run(&fixture.host, Request::Disconnect {}).unwrap();
    assert_eq!(connected_as(&fixture.host), None);
}

#[test]
fn disconnect_keychain_failure_still_disconnects() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    fixture.vault.fail("delete", KeychainProblem::Locked);
    let failed = run(&fixture.host, Request::Disconnect {}).unwrap_err();
    assert_eq!(
        failed.kind,
        ErrorKind::Keychain {
            problem: KeychainProblem::Locked
        }
    );
    assert_eq!(
        serde_json::to_value(&failed.status.github).unwrap(),
        json!({"kind": "notConnected", "ended": null})
    );
    assert!(saved_logins(&fixture.file()).is_empty());

    fixture.vault.heal();
    run(&fixture.host, Request::Disconnect {}).unwrap();
    assert!(
        fixture.vault.tokens().is_empty(),
        "disconnecting again removes it"
    );
}

#[test]
fn stale_401_cannot_sign_out_a_newer_connection() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    let host = &fixture.host;
    let stale = host.with_github(|_| {
        fixture.connect("gho_two", "octo").unwrap();
        Err::<(), _>(ApiError::Unauthorized)
    });
    assert_eq!(stale.unwrap_err().kind, ErrorKind::SignedOut);
    assert_eq!(connected_as(host).as_deref(), Some("octo"));
    assert_eq!(saved_logins(&fixture.file()), ["octo"]);
    assert_eq!(fixture.vault.tokens(), ["gho_two"]);
}

#[test]
fn a_read_asks_nothing_more_once_its_connection_ended() {
    let fixture = Fixture::new();
    for end in [
        |fixture: &Fixture| drop(run(&fixture.host, Request::Disconnect {}).unwrap()),
        |fixture: &Fixture| fixture.connect("gho_two", "hubot").unwrap(),
    ] {
        fixture.connect("gho_one", "octo").unwrap();
        let seen = std::cell::Cell::new(0);
        let read = fixture.host.with_github(|github| {
            end(&fixture);
            seen.set(fixture.github.seen().len());
            github.user().map(drop)
        });
        assert_eq!(read.unwrap_err().kind, ErrorKind::Interrupted);
        assert_eq!(fixture.github.seen().len(), seen.get());
    }
}

#[test]
fn missing_token_forgets_with_ended_token_missing() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    fixture.vault.items.lock().unwrap().clear();
    let failed = run(&fixture.host, Request::Verify {}).unwrap_err();
    assert_eq!(failed.kind, ErrorKind::SignedOut);
    assert_eq!(
        serde_json::to_value(&failed.status.github).unwrap(),
        json!({"kind": "notConnected", "ended": {"login": "octo", "reason": "tokenMissing"}})
    );
    assert!(saved_logins(&fixture.file()).is_empty());
    assert!(fixture.github.seen().is_empty());
}

#[test]
fn locked_keychain_on_use_keeps_connection() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    fixture.vault.fail("read", KeychainProblem::Locked);
    assert_eq!(
        kind(run(&fixture.host, Request::Verify {})),
        ErrorKind::Keychain {
            problem: KeychainProblem::Locked
        }
    );
    assert_eq!(connected_as(&fixture.host).as_deref(), Some("octo"));
    assert_eq!(saved_logins(&fixture.file()), ["octo"]);
}

#[test]
fn revoked_token_forgets_the_connection() {
    let fixture = Fixture::new();
    fixture.connect("gho_one", "octo").unwrap();
    fixture.github.answer("gho_one", Reply::bad_credentials());
    assert_eq!(
        kind(run(&fixture.host, Request::Verify {})),
        ErrorKind::SignedOut
    );
    assert_eq!(
        github(&fixture.host),
        json!({"kind": "notConnected", "ended": {"login": "octo", "reason": "revoked"}})
    );
    assert!(
        fixture.vault.tokens().is_empty(),
        "the dead token is deleted"
    );
    assert_eq!(connected_as(&fixture.restart()), None);
}

#[test]
fn unreadable_file_is_rewritten_by_connect_and_dismissed_by_disconnect() {
    let fixture = Fixture::new();
    fs::write(fixture.dir.path().join("host.json"), "not json").unwrap();
    let host = fixture.restart();
    assert_eq!(
        github(&host),
        json!({"kind": "notConnected", "ended": {"login": null, "reason": "unreadable"}})
    );
    host.commit(
        &host.lock_writes(),
        Verified::assume("gho_one", "octo", 1, Access::Private),
    )
    .unwrap();
    assert_eq!(connected_as(&fixture.restart()).as_deref(), Some("octo"));

    let fixture = Fixture::new();
    fs::write(fixture.dir.path().join("host.json"), "not json").unwrap();
    run(&fixture.restart(), Request::Disconnect {}).unwrap();
    assert_eq!(
        github(&fixture.restart()),
        json!({"kind": "notConnected", "ended": null}),
        "disconnect dismisses the notice for good"
    );
}
