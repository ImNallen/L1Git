//! A signed-in host on a fake GitHub, and the answers GitHub gives to the
//! reads and mutations a write makes.

use std::sync::atomic::{AtomicU64, Ordering};

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};

use crate::support::{FakeGh, FakeGitHub, Reply};

pub struct World {
    pub dir: tempfile::TempDir,
    pub github: FakeGitHub,
    pub host: Host,
    gh: FakeGh,
}

static ATTEMPTS: AtomicU64 = AtomicU64::new(0);

pub fn attempt() -> String {
    format!("attempt-{}", ATTEMPTS.fetch_add(1, Ordering::Relaxed))
}

pub fn pull() -> Value {
    json!({"repository": {"owner": "octo", "repo": "app"}, "number": 12})
}

impl World {
    pub fn connected() -> World {
        let dir = tempfile::tempdir().unwrap();
        let gh = FakeGh::new("signed-in");
        gh.token("octo", "gho_octo");
        let github = FakeGitHub::start();
        github.answer("gho_octo", Reply::user("octo", 1, Some("repo")));
        let host = Self::host_on(&dir, &github, &gh);
        let world = World {
            dir,
            github,
            host,
            gh,
        };
        world.send(json!({"op": "connectGh", "login": "octo"}));
        world
    }

    fn host_on(dir: &tempfile::TempDir, github: &FakeGitHub, gh: &FakeGh) -> Host {
        Host::new(HostConfig {
            dir: dir.path().to_owned(),
            vault: VaultChoice::Memory,
            gh: GhChoice::At(gh.path()),
            github: Endpoints::loopback(&github.url()).unwrap(),
            client_id: None,
        })
    }

    pub fn gh(&self) -> std::path::PathBuf {
        self.gh.path()
    }

    /// Another L1 Git on the same folder, signed in again: the app after a
    /// restart, or a second process.
    pub fn restarted(&self) -> Host {
        let host = Self::host_on(&self.dir, &self.github, &self.gh);
        ask(&host, json!({"op": "connectGh", "login": "octo"}));
        host
    }

    pub fn send(&self, request: Value) -> Value {
        ask(&self.host, request)
    }

    /// The whole answer: `written`, and the drafts and writes kept after it.
    pub fn wrote(&self, attempt: &str, write: Value, drafts: Value) -> Value {
        write_on(&self.host, attempt, write, drafts)
    }

    pub fn write(&self, write: Value) -> Value {
        self.wrote(&attempt(), write, json!([]))["written"].clone()
    }

    pub fn check(&self) -> Value {
        check_on(&self.host)
    }

    pub fn send_again(&self, attempt: &str) -> Value {
        let mut request = json!({"op": "sendAgain", "asLogin": "octo", "attempt": attempt});
        merge(&mut request, pull());
        let reply = self.send(request);
        assert_eq!(reply["op"], "sendAgain", "{reply}");
        reply["data"].clone()
    }

    pub fn drafts(&self, change: Value) -> Value {
        drafts_on(&self.host, change)
    }

    /// Saves `text` as a new draft at `anchor`, and answers how to carry it.
    pub fn draft(&self, anchor: Value, text: &str) -> Value {
        let head = "1".repeat(40);
        let answer = self.drafts(
            json!({"kind": "put", "anchor": anchor.clone(), "head": head, "text": text, "at": null}),
        );
        let saved = answer["drafts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|draft| draft["anchor"] == anchor)
            .unwrap();
        json!({"anchor": anchor, "head": head, "at": saved["savedAt"]})
    }

    pub fn mutations(&self) -> Vec<Value> {
        self.github
            .questions()
            .into_iter()
            .filter(|question| question["query"].as_str().unwrap().starts_with("mutation"))
            .collect()
    }
}

pub fn ask(host: &Host, request: Value) -> Value {
    let request: Request = serde_json::from_value(request).unwrap();
    let reply = match run(host, request) {
        Ok(response) => serde_json::to_value(response).unwrap(),
        Err(error) => json!({"error": serde_json::to_value(error).unwrap()}),
    };
    assert!(!reply.to_string().contains("gho_"), "a token escaped");
    reply
}

fn merge(request: &mut Value, more: Value) {
    for (field, value) in more.as_object().unwrap() {
        request[field] = value.clone();
    }
}

pub fn write_on(host: &Host, attempt: &str, write: Value, drafts: Value) -> Value {
    write_as(host, "octo", attempt, write, drafts)
}

pub fn write_as(host: &Host, login: &str, attempt: &str, write: Value, drafts: Value) -> Value {
    let mut request = json!({"op": "write", "asLogin": login, "attempt": attempt, "write": write, "drafts": drafts});
    merge(&mut request, pull());
    let reply = ask(host, request);
    assert_eq!(reply["op"], "write", "{reply}");
    reply["data"].clone()
}

pub fn check_on(host: &Host) -> Value {
    let mut request = json!({"op": "check", "asLogin": "octo"});
    merge(&mut request, pull());
    let reply = ask(host, request);
    assert_eq!(reply["op"], "check", "{reply}");
    reply["data"].clone()
}

pub fn drafts_on(host: &Host, change: Value) -> Value {
    let mut request = json!({"op": "drafts", "login": "octo", "change": change});
    merge(&mut request, pull());
    let reply = ask(host, request);
    assert_eq!(reply["op"], "drafts", "{reply}");
    reply["data"].clone()
}

pub fn answered(field: &str, payload: Value) -> Reply {
    Reply::graphql(json!({"data": {field: payload}}))
}

pub fn oid(digit: char) -> String {
    digit.to_string().repeat(40)
}

/// A pull request's conversation, or a thread, as the read before a write
/// and the reads after it see it.
pub fn said(comments: &[(&str, &str, &str)]) -> Reply {
    let nodes: Vec<Value> = comments
        .iter()
        .map(|(id, by, body)| json!({"id": id, "author": {"login": by}, "body": body}))
        .collect();
    Reply::graphql(json!({"data": {"node": {"isResolved": false, "comments": {"nodes": nodes}}}}))
}

/// A review's comment: path, line and body.
pub type Commented<'a> = (&'a str, u32, &'a str);

/// The viewer's reviews: id, state, body and comments.
pub fn reviews(reviews: &[(&str, &str, &str, &[Commented])]) -> Reply {
    let nodes: Vec<Value> = reviews
        .iter()
        .map(|(id, state, body, comments)| {
            let comments: Vec<Value> = comments
                .iter()
                .map(|(path, line, body)| json!({"path": path, "line": line, "originalLine": line, "startLine": null, "originalStartLine": null, "body": body}))
                .collect();
            json!({"id": id, "state": state, "body": body, "comments": {"nodes": comments}})
        })
        .collect();
    Reply::graphql(json!({"data": {"node": {"reviews": {"nodes": nodes}}}}))
}

pub fn resolved(resolved: bool) -> Reply {
    Reply::graphql(json!({"data": {"node": {"isResolved": resolved, "comments": {"nodes": []}}}}))
}

pub fn pull_state(merged: bool, head: bool) -> Reply {
    let head = if head {
        json!({"id": "REF_1"})
    } else {
        Value::Null
    };
    let commit = if merged {
        json!({"oid": oid('9')})
    } else {
        Value::Null
    };
    Reply::graphql(
        json!({"data": {"node": {"merged": merged, "mergeCommit": commit, "headRef": head}}}),
    )
}

pub fn comment() -> Value {
    json!({"kind": "comment", "pull": "PR_1", "body": "Looks good once CI is green."})
}

pub fn done(echo: Value) -> Value {
    json!({"kind": "done", "echo": echo})
}
