use std::fs;
use std::path::{Path, PathBuf};

use l1_git_host::{Endpoints, ErrorKind, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};

const HEAD: &str = "1111111111111111111111111111111111111111";
const NEXT: &str = "2222222222222222222222222222222222222222";

/// No sign-in, no gh and no network: drafts are kept on this machine alone.
fn open(dir: &Path, github: Endpoints) -> Host {
    Host::new(HostConfig {
        dir: dir.to_owned(),
        vault: VaultChoice::Memory,
        gh: GhChoice::At(PathBuf::from("/nonexistent/gh")),
        github,
        client_id: None,
    })
}

fn host(dir: &Path) -> Host {
    open(dir, Endpoints::github_com())
}

fn pull(login: &str, repo: &str, number: u32, change: Value) -> Value {
    json!({
        "op": "drafts",
        "login": login,
        "repository": {"owner": "octo", "repo": repo},
        "number": number,
        "change": change,
    })
}

fn ask(host: &Host, request: Value) -> Result<Value, ErrorKind> {
    let request: Request = serde_json::from_value(request).expect("a drafts request");
    match run(host, request) {
        Ok(response) => {
            let response = serde_json::to_value(response).unwrap();
            assert_eq!(response["op"], "drafts");
            Ok(response["data"].clone())
        }
        Err(error) => Err(error.kind),
    }
}

fn on(host: &Host, change: Value) -> Value {
    ask(host, pull("octo", "app", 1, change)).expect("the drafts answer")
}

fn read() -> Value {
    json!({"kind": "read"})
}

fn line() -> Value {
    json!({"kind": "line", "path": "src/main.rs", "side": "right", "line": 12, "start": {"side": "right", "line": 10}})
}

fn conversation() -> Value {
    json!({"kind": "conversation"})
}

fn put(anchor: Value, head: &str, text: &str, at: Value) -> Value {
    json!({"kind": "put", "anchor": anchor, "head": head, "text": text, "at": at})
}

fn delete(anchor: Value, head: &str, at: Value) -> Value {
    json!({"kind": "delete", "anchor": anchor, "head": head, "at": at})
}

fn texts(answer: &Value) -> Vec<String> {
    answer["drafts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|draft| draft["text"].as_str().unwrap().to_owned())
        .collect()
}

fn saved_at(answer: &Value, index: usize) -> Value {
    answer["drafts"][index]["savedAt"].clone()
}

fn drafts_file(dir: &Path) -> PathBuf {
    dir.join("drafts.json")
}

#[test]
fn a_draft_survives_a_restart_without_a_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    let first = host(dir.path());
    let saved = on(&first, put(line(), HEAD, "Off by one?", Value::Null));
    assert_eq!(saved["refused"], Value::Null);
    let draft = &saved["drafts"][0];
    assert_eq!(draft["anchor"], line());
    assert_eq!(draft["head"], HEAD);
    assert_eq!(draft["text"], "Off by one?");
    assert_eq!(draft["writtenAt"], draft["savedAt"]);
    drop(first);

    let again = on(&host(dir.path()), read());
    assert_eq!(again["drafts"], saved["drafts"]);
    assert_eq!(again["refused"], Value::Null);
    assert!(
        !dir.path().join("host.json").exists(),
        "drafts leave the GitHub connection alone"
    );
}

#[test]
fn a_tmp_left_behind_by_a_crash_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    on(
        &host(dir.path()),
        put(conversation(), HEAD, "Kept", Value::Null),
    );
    for left in ["drafts.tmp", "drafts.4242.0.tmp"] {
        fs::write(dir.path().join(left), "{\"version\": 1, \"pul").unwrap();
    }

    let host = host(dir.path());
    assert_eq!(texts(&on(&host, read())), ["Kept"]);
    let more = on(&host, put(line(), HEAD, "And this", Value::Null));
    assert_eq!(texts(&more), ["Kept", "And this"]);
    let file: Value = serde_json::from_slice(&fs::read(drafts_file(dir.path())).unwrap()).unwrap();
    assert_eq!(file["version"], 1);
    let left: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert_eq!(
        left,
        Vec::<String>::new(),
        "a save clears what a crash left"
    );
}

#[test]
fn a_file_from_a_newer_l1_git_is_refused_and_left_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let newer = r#"{"version": 2, "books": {"shape": "unknown to this build"}}"#;
    fs::write(drafts_file(dir.path()), newer).unwrap();
    let host = host(dir.path());

    assert!(matches!(
        ask(&host, pull("octo", "app", 1, read())),
        Err(ErrorKind::Storage)
    ));
    assert!(matches!(
        ask(
            &host,
            pull(
                "octo",
                "app",
                1,
                put(conversation(), HEAD, "Mine", Value::Null)
            )
        ),
        Err(ErrorKind::Storage)
    ));
    assert_eq!(fs::read_to_string(drafts_file(dir.path())).unwrap(), newer);
}

#[test]
fn an_unreadable_file_is_refused_and_left_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let broken = "{\"version\": 1, \"pulls\": [{]}";
    fs::write(drafts_file(dir.path()), broken).unwrap();
    let host = host(dir.path());
    assert!(matches!(
        ask(
            &host,
            pull(
                "octo",
                "app",
                1,
                put(conversation(), HEAD, "Mine", Value::Null)
            )
        ),
        Err(ErrorKind::Storage)
    ));
    assert_eq!(fs::read_to_string(drafts_file(dir.path())).unwrap(), broken);
}

#[test]
fn a_write_based_on_a_draft_another_window_changed_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let host = host(dir.path());
    let first = on(&host, put(conversation(), HEAD, "One", Value::Null));
    let one = saved_at(&first, 0);
    let second = on(&host, put(conversation(), HEAD, "One, two", one.clone()));
    let two = saved_at(&second, 0);
    assert_ne!(one, two);
    assert_eq!(
        second["drafts"][0]["writtenAt"],
        first["drafts"][0]["writtenAt"]
    );

    for stale in [
        put(conversation(), HEAD, "Other window", one.clone()),
        put(conversation(), HEAD, "Other window", Value::Null),
        delete(conversation(), HEAD, one.clone()),
    ] {
        let refused = on(&host, stale);
        assert_eq!(refused["refused"], json!({"kind": "stale"}));
        assert_eq!(texts(&refused), ["One, two"]);
    }

    let gone = on(&host, delete(conversation(), HEAD, two.clone()));
    assert_eq!(gone["refused"], Value::Null);
    assert!(texts(&gone).is_empty());
    let again = on(&host, delete(conversation(), HEAD, two));
    assert_eq!(
        again["refused"],
        Value::Null,
        "deleting a deleted draft is done"
    );
    let sent_elsewhere = on(&host, put(conversation(), HEAD, "Still typing", one));
    assert_eq!(sent_elsewhere["refused"], json!({"kind": "stale"}));
    assert!(texts(&sent_elsewhere).is_empty());
}

#[test]
fn a_pull_request_past_the_hundredth_is_refused_and_no_draft_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let host = host(dir.path());
    let hi = |number| {
        ask(
            &host,
            pull(
                "octo",
                "app",
                number,
                put(conversation(), HEAD, "Hi", Value::Null),
            ),
        )
        .unwrap()
    };
    for number in 1..=100 {
        assert_eq!(hi(number)["refused"], Value::Null);
    }
    let full = hi(101);
    assert_eq!(
        full["refused"],
        json!({"kind": "full", "of": "pullRequests"})
    );
    assert!(texts(&full).is_empty());
    let nothing = ask(
        &host,
        pull("octo", "app", 101, delete(conversation(), HEAD, json!(1))),
    )
    .unwrap();
    assert_eq!(
        nothing["refused"],
        Value::Null,
        "deleting nothing needs no room"
    );
    let file: Value = serde_json::from_slice(&fs::read(drafts_file(dir.path())).unwrap()).unwrap();
    assert_eq!(file["pulls"].as_array().unwrap().len(), 100);
    let first = ask(&host, pull("octo", "app", 1, read())).unwrap();
    assert_eq!(
        texts(&first),
        ["Hi"],
        "the oldest pull request keeps its words"
    );
    let edited = ask(
        &host,
        pull(
            "octo",
            "app",
            1,
            put(conversation(), HEAD, "Hi again", saved_at(&first, 0)),
        ),
    )
    .unwrap();
    assert_eq!(
        edited["refused"],
        Value::Null,
        "a kept pull request takes edits"
    );

    let second = ask(&host, pull("octo", "app", 2, read())).unwrap();
    let emptied = ask(
        &host,
        pull(
            "octo",
            "app",
            2,
            delete(conversation(), HEAD, saved_at(&second, 0)),
        ),
    )
    .unwrap();
    assert!(texts(&emptied).is_empty());
    assert_eq!(hi(101)["refused"], Value::Null, "deleting made room");
}

#[test]
fn one_pull_request_holds_a_bounded_number_of_drafts() {
    let dir = tempfile::tempdir().unwrap();
    let host = host(dir.path());
    for number in 1..=100 {
        let anchor =
            json!({"kind": "line", "path": "a.rs", "side": "left", "line": number, "start": null});
        assert_eq!(
            on(&host, put(anchor, HEAD, "x", Value::Null))["refused"],
            Value::Null
        );
    }
    let full = on(&host, put(conversation(), HEAD, "One more", Value::Null));
    assert_eq!(full["refused"], json!({"kind": "full", "of": "drafts"}));
    assert_eq!(full["drafts"].as_array().unwrap().len(), 100);
}

#[test]
fn keys_isolate_accounts_hosts_and_pull_requests() {
    let dir = tempfile::tempdir().unwrap();
    let github = host(dir.path());
    ask(
        &github,
        pull(
            "octo",
            "app",
            1,
            put(conversation(), HEAD, "Mine", Value::Null),
        ),
    )
    .unwrap();

    assert_eq!(
        texts(&ask(&github, pull("OCTO", "APP", 1, read())).unwrap()),
        ["Mine"]
    );
    for other in [
        pull("hubot", "app", 1, read()),
        pull("octo", "app", 2, read()),
        pull("octo", "web", 1, read()),
    ] {
        assert!(
            texts(&ask(&github, other.clone()).unwrap()).is_empty(),
            "{other}"
        );
    }
    let enterprise = open(
        dir.path(),
        Endpoints::loopback("http://127.0.0.1:9/").unwrap(),
    );
    assert!(texts(&ask(&enterprise, pull("octo", "app", 1, read())).unwrap()).is_empty());
}

#[test]
fn a_line_is_a_place_at_one_head_and_other_drafts_follow_the_head() {
    let dir = tempfile::tempdir().unwrap();
    let host = host(dir.path());
    on(&host, put(line(), HEAD, "At the old head", Value::Null));
    let both = on(&host, put(line(), NEXT, "At the new head", Value::Null));
    assert_eq!(texts(&both), ["At the old head", "At the new head"]);

    let first = on(&host, put(conversation(), HEAD, "Looks good", Value::Null));
    let moved = on(
        &host,
        put(conversation(), NEXT, "Looks good now", saved_at(&first, 2)),
    );
    assert_eq!(moved["refused"], Value::Null);
    assert_eq!(
        texts(&moved),
        ["At the old head", "At the new head", "Looks good now"]
    );
    assert_eq!(moved["drafts"][2]["head"], NEXT);
}

#[test]
fn every_anchor_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let host = host(dir.path());
    let anchors = [
        json!({"kind": "line", "path": "docs/read me.md", "side": "left", "line": 3, "start": null}),
        json!({"kind": "reply", "thread": "PRRT_kwDOAbc-12_="}),
        json!({"kind": "conversation"}),
        json!({"kind": "summary"}),
        json!({"kind": "merge"}),
    ];
    for anchor in &anchors {
        on(&host, put(anchor.clone(), HEAD, "Words", Value::Null));
    }
    let kept: Vec<Value> = on(&host, read())["drafts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|draft| draft["anchor"].clone())
        .collect();
    assert_eq!(kept, anchors);
}

#[test]
fn drafts_refuse_what_github_would_not_take() {
    let long = "x".repeat(65_537);
    let anchor = |fields: Value| {
        let mut base =
            json!({"kind": "line", "path": "a.rs", "side": "right", "line": 5, "start": null});
        base.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        base
    };
    let change = |anchor: Value, head: &str, text: &str| json!({"kind": "put", "anchor": anchor, "head": head, "text": text, "at": null});
    let ok = anchor(json!({}));
    assert!(
        serde_json::from_value::<Request>(pull(
            "octo",
            "app",
            1,
            change(ok.clone(), HEAD, &"x".repeat(65_536))
        ))
        .is_ok()
    );
    for refused in [
        change(ok.clone(), HEAD, " \n "),
        change(ok.clone(), HEAD, &long),
        change(ok.clone(), "abc", "x"),
        change(ok.clone(), &"A".repeat(40), "x"),
        change(anchor(json!({"line": 0})), HEAD, "x"),
        change(anchor(json!({"path": ""})), HEAD, "x"),
        change(anchor(json!({"side": "both"})), HEAD, "x"),
        change(
            anchor(json!({"start": {"side": "right", "line": 5}})),
            HEAD,
            "x",
        ),
        change(
            anchor(json!({"start": {"side": "right", "line": 9}})),
            HEAD,
            "x",
        ),
        change(anchor(json!({"extra": 1})), HEAD, "x"),
        change(json!({"kind": "reply", "thread": "has space"}), HEAD, "x"),
        change(json!({"kind": "conversation", "path": "a.rs"}), HEAD, "x"),
        change(json!({"kind": "review"}), HEAD, "x"),
        json!({"kind": "put", "anchor": ok.clone(), "head": HEAD, "text": "x", "at": null, "extra": 1}),
        json!({"kind": "delete", "anchor": ok.clone(), "head": HEAD}),
        json!({"kind": "read", "at": 1}),
    ] {
        assert!(
            serde_json::from_value::<Request>(pull("octo", "app", 1, refused.clone())).is_err(),
            "{refused}"
        );
    }
    assert!(
        serde_json::from_value::<Request>(pull("-octo", "app", 1, json!({"kind": "read"})))
            .is_err()
    );
}
