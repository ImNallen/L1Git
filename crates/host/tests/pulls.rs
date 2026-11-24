#![cfg(unix)]

#[allow(dead_code)]
mod support;

use std::time::{SystemTime, UNIX_EPOCH};

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};
use support::{FakeGh, FakeGitHub, Reply, Seen};

struct World {
    _dir: tempfile::TempDir,
    github: FakeGitHub,
    host: Host,
}

impl World {
    fn connected() -> World {
        let dir = tempfile::tempdir().unwrap();
        let gh = FakeGh::new("signed-in");
        gh.token("octo", "gho_octo");
        let github = FakeGitHub::start();
        github.answer("gho_octo", Reply::user("octo", 1, Some("repo")));
        let host = Host::new(HostConfig {
            dir: dir.path().to_owned(),
            vault: VaultChoice::Memory,
            gh: GhChoice::At(gh.path()),
            github: Endpoints::loopback(&github.url()).unwrap(),
            client_id: None,
        });
        let world = World {
            _dir: dir,
            github,
            host,
        };
        world
            .send(json!({"op": "connectGh", "login": "octo"}))
            .unwrap();
        world
    }

    fn send(&self, request: Value) -> Result<Value, Value> {
        let request: Request = serde_json::from_value(request).unwrap();
        let reply = match run(&self.host, request) {
            Ok(response) => Ok(serde_json::to_value(response).unwrap()),
            Err(error) => Err(serde_json::to_value(error).unwrap()),
        };
        let (Ok(value) | Err(value)) = &reply;
        assert!(!value.to_string().contains("gho_"), "a token escaped");
        reply
    }

    fn open(&self) -> Result<Value, Value> {
        self.send(list("octo", "app", "open"))
    }

    fn opens(&self, answer: Value) -> Value {
        self.github.graphql([Reply::graphql(answer)]);
        self.open().unwrap()["data"].clone()
    }

    fn fails(&self, reply: Reply) -> Value {
        self.github.graphql([reply]);
        self.open().unwrap_err()
    }
}

fn list(owner: &str, repo: &str, list: &str) -> Value {
    json!({"op": "pullRequests", "repository": {"owner": owner, "repo": repo}, "list": list})
}

fn row(number: u32) -> Value {
    json!({
        "number": number, "title": "Fix it", "isDraft": false, "mergedAt": null, "closedAt": null,
        "headRefName": "fix", "baseRefName": "main", "updatedAt": "2026-11-24T16:23:14Z",
        "additions": 1, "deletions": 2, "mergeable": "MERGEABLE", "reviewDecision": null,
        "totalCommentsCount": 0, "viewerDidAuthor": false, "author": {"login": "hubot"},
        "labels": {"totalCount": 0, "nodes": []}, "latestOpinionatedReviews": {"nodes": []},
        "statusCheckRollup": null,
    })
}

fn row_with(number: u32, fields: Value) -> Value {
    let mut row = row(number);
    let Value::Object(fields) = fields else {
        panic!("fields are an object")
    };
    row.as_object_mut().unwrap().extend(fields);
    row
}

fn open(name: &str, rows: Vec<Value>, requested: &[u32]) -> Value {
    json!({"data": {
        "repository": {"nameWithOwner": name, "pullRequests": {"totalCount": rows.len(), "nodes": rows}},
        "requested": {"nodes": requested.iter().map(|number| json!({"number": number})).collect::<Vec<_>>()},
    }})
}

fn refusal(kind: &str, path: Value) -> Value {
    json!({"type": kind, "path": path, "locations": [{"line": 1, "column": 9}], "message": format!("GitHub says {kind}.")})
}

fn withheld(errors: Vec<Value>) -> Value {
    json!({"data": {"repository": null, "requested": {"nodes": []}}, "errors": errors})
}

const SSO: &str =
    "https://github.com/orgs/octo-org/sso?authorization_request=A1B2C3&return_to=settings";

#[test]
fn open_pull_requests_answer_in_l1_gits_words() {
    let world = World::connected();
    world.github.graphql([Reply::recorded("open")]);
    let answer = world.open().unwrap();
    assert_eq!(answer["op"], "pullRequests");
    assert_eq!(answer["status"]["github"]["login"], "octo");
    let label = |name: &str, color: &str| json!({"name": name, "color": color});
    assert_eq!(
        answer["data"],
        json!({"total": 59, "items": [
            {
                "number": 12, "title": "Read the configuration file once",
                "state": {"kind": "open", "draft": false}, "author": "hubot", "viewerIsAuthor": false,
                "head": "read-config-once", "base": "main",
                "labels": {"total": 4, "items": [
                    label("bug", "d73a4a"), label("documentation", "0075ca"),
                    label("good first issue", "7057ff"), label("help wanted", "008672"),
                ]},
                "comments": 23, "reviewRequested": true, "review": "changesRequested",
                "checks": {"passed": 6, "failed": 1, "skipped": 0, "running": 6},
                "mergeable": "mergeable", "additions": 80, "deletions": 8,
                "updatedAt": "2026-11-24T15:33:39Z",
            },
            {
                "number": 7, "title": "Try a faster parser",
                "state": {"kind": "open", "draft": true}, "author": "monalisa", "viewerIsAuthor": false,
                "head": "faster-parser", "base": "main", "labels": {"total": 0, "items": []},
                "comments": 2, "reviewRequested": false, "review": "required",
                "checks": {"passed": 6, "failed": 0, "skipped": 7, "running": 0},
                "mergeable": "mergeable", "additions": 123, "deletions": 0,
                "updatedAt": "2026-11-24T15:31:48Z",
            },
            {
                "number": 11, "title": "Explain an empty search",
                "state": {"kind": "open", "draft": false}, "author": "octo", "viewerIsAuthor": true,
                "head": "empty-search", "base": "main", "labels": {"total": 0, "items": []},
                "comments": 1, "reviewRequested": false, "review": "approved",
                "checks": {"passed": 12, "failed": 0, "skipped": 6, "running": 0},
                "mergeable": "conflicting", "additions": 201, "deletions": 195,
                "updatedAt": "2026-11-23T14:11:27Z",
            },
            {
                "number": 9, "title": "Fix a typo in the guide",
                "state": {"kind": "open", "draft": false}, "author": "monalisa", "viewerIsAuthor": false,
                "head": "fix-typo", "base": "main",
                "labels": {"total": 2, "items": [label("bug", "d73a4a"), label("documentation", "0075ca")]},
                "comments": 4, "reviewRequested": false, "review": "required",
                "checks": {"passed": 0, "failed": 0, "skipped": 0, "running": 0},
                "mergeable": "mergeable", "additions": 35, "deletions": 2,
                "updatedAt": "2026-11-20T01:58:16Z",
            },
        ]})
    );
    assert_eq!(
        world.github.seen().last(),
        Some(&Seen {
            path: "/graphql".to_owned(),
            authorization: Some("Bearer gho_octo".to_owned()),
        })
    );
    assert_eq!(
        world.github.questions()[0]["variables"],
        json!({"owner": "octo", "repo": "app", "requested": "repo:octo/app is:pr is:open review-requested:@me"})
    );
}

#[test]
fn recently_merged_covers_seven_days() {
    let days_now = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            / 86_400
    };
    let world = World::connected();
    world.github.graphql([Reply::recorded("merged")]);
    let before = days_now();
    let answer = world.send(list("octo", "app", "recentlyMerged")).unwrap();
    let after = days_now();
    assert_eq!(answer["data"]["total"], 27);
    let states: Vec<_> = answer["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["state"].clone())
        .collect();
    assert_eq!(
        states,
        [
            json!({"kind": "merged", "at": "2026-11-17T19:18:14Z"}),
            json!({"kind": "merged", "at": "2026-11-23T18:24:25Z"}),
        ]
    );

    let asked = world.github.questions()[0]["variables"]["merged"].clone();
    let since = asked
        .as_str()
        .unwrap()
        .strip_prefix("repo:octo/app is:pr is:merged merged:>=")
        .and_then(|rest| rest.strip_suffix(" sort:updated-desc"))
        .unwrap_or_else(|| panic!("{asked}"));
    let [year, month, day] = since
        .split('-')
        .map(|part| part.parse::<u64>().unwrap())
        .collect::<Vec<_>>()[..]
    else {
        panic!("{since}")
    };
    let leap = |year: u64| {
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
    };
    let february = if leap(year) { 29 } else { 28 };
    let months = [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let days = (1970..year)
        .map(|year| if leap(year) { 366 } else { 365 })
        .sum::<u64>()
        + months[..month as usize - 1].iter().sum::<u64>()
        + day
        - 1;
    assert!((before - 7..=after - 7).contains(&days), "{since}");
}

/// GitHub answers the list with this field too slowly, and then with a 502.
#[test]
fn lists_never_ask_for_the_merge_state() {
    let world = World::connected();
    world
        .github
        .graphql([Reply::recorded("open"), Reply::recorded("merged")]);
    world.open().unwrap();
    world.send(list("octo", "app", "recentlyMerged")).unwrap();
    for question in world.github.questions() {
        let query = question["query"].as_str().unwrap();
        assert!(query.contains("mergeable"), "{query}");
        assert!(!query.contains("mergeStateStatus"), "{query}");
    }
}

#[test]
fn a_renamed_repository_still_marks_requested_reviews() {
    let world = World::connected();
    world.github.graphql([
        Reply::graphql(open("octo/new", vec![row(7)], &[])),
        Reply::graphql(open("octo/new", vec![row(7)], &[7])),
    ]);
    let answer = world.send(list("octo", "old", "open")).unwrap();
    assert_eq!(answer["data"]["items"][0]["reviewRequested"], true);
    let asked = world.github.questions();
    assert_eq!(asked.len(), 2);
    assert_eq!(
        asked[1]["variables"]["requested"],
        "repo:octo/new is:pr is:open review-requested:@me"
    );
}

#[test]
fn another_letter_case_is_not_a_rename() {
    let world = World::connected();
    world
        .github
        .graphql([Reply::graphql(open("Octo/App", vec![row(7)], &[]))]);
    world.open().unwrap();
    assert_eq!(world.github.questions().len(), 1);
}

#[test]
fn one_unreadable_repository_leaves_the_connection_alone() {
    let world = World::connected();
    let answer = withheld(vec![refusal("NOT_FOUND", json!(["repository"]))]);
    let error = world.fails(Reply::graphql(answer));
    assert_eq!(error["kind"], "notFound");
    let message = error["message"].as_str().unwrap();
    assert!(message.contains("octo/app"), "{message}");
    assert_eq!(error["status"]["github"]["kind"], "connected");

    let unexplained = world.fails(Reply::graphql(withheld(Vec::new())));
    assert_eq!(unexplained["kind"], "notFound");
}

#[test]
fn the_repositorys_own_error_explains_it() {
    let world = World::connected();
    let error = world.fails(Reply::graphql(withheld(vec![
        refusal("FORBIDDEN", json!(["requested"])),
        refusal("NOT_FOUND", json!(["repository"])),
    ])));
    assert_eq!(error["kind"], "notFound");
}

#[test]
fn single_sign_on_names_where_to_authorize() {
    let world = World::connected();
    let forbidden = || Reply::graphql(withheld(vec![refusal("FORBIDDEN", json!(["repository"]))]));
    let header = format!("required; url={SSO}");
    for reply in [
        forbidden().with_header("X-GitHub-SSO", &header),
        Reply::status(403, r#"{"message":"Protected by SAML."}"#)
            .with_header("X-GitHub-SSO", &header),
    ] {
        let error = world.fails(reply);
        assert_eq!(error["kind"], "ssoRequired");
        assert_eq!(error["url"], SSO);
        assert_eq!(error["status"]["github"]["kind"], "connected");
    }
    for elsewhere in [
        "http://github.com/orgs/octo-org/sso",
        "https://github.com.evil.test/orgs/octo-org/sso",
        "https://github.com@evil.test/orgs/octo-org/sso",
        "javascript:alert(1)",
    ] {
        let reply = forbidden().with_header("X-GitHub-SSO", &format!("required; url={elsewhere}"));
        let error = world.fails(reply);
        assert_eq!(error["kind"], "gitHubFailed", "{elsewhere}");
        assert!(!error.to_string().contains("evil"), "{error}");
    }
}

#[test]
fn other_refusals_show_githubs_own_sentence() {
    let world = World::connected();
    for answer in [
        withheld(vec![refusal("FORBIDDEN", json!(["repository"]))]),
        withheld(vec![refusal("INSUFFICIENT_SCOPES", json!(["repository"]))]),
        json!({"errors": [refusal("INSUFFICIENT_SCOPES", json!([]))]}),
        json!({"data": null, "errors": [{"message": "GitHub says INSUFFICIENT_SCOPES."}]}),
    ] {
        let error = world.fails(Reply::graphql(answer));
        assert_eq!(error["kind"], "gitHubFailed");
        assert_eq!(error["httpStatus"], 403);
        let message = error["message"].as_str().unwrap();
        assert!(message.contains("GitHub says "), "{message}");
    }
}

#[test]
fn unreadable_review_requests_fail_the_read() {
    let world = World::connected();
    let answer = |requested: Value, errors: Vec<Value>| {
        let mut answer = open("octo/app", vec![row(7)], &[]);
        answer["data"]["requested"] = requested;
        answer["errors"] = json!(errors);
        Reply::graphql(answer)
    };
    let error = || vec![refusal("FORBIDDEN", json!(["requested"]))];
    for (requested, errors) in [
        (json!(null), error()),
        (json!(null), Vec::new()),
        (json!({"nodes": null}), Vec::new()),
        (json!({"nodes": []}), error()),
        (
            json!({"nodes": [null]}),
            vec![refusal("FORBIDDEN", json!(["requested", "nodes", 0]))],
        ),
    ] {
        let error = world.fails(answer(requested.clone(), errors));
        assert_eq!(
            error["status"]["github"]["kind"], "connected",
            "{requested}"
        );
    }
}

#[test]
fn failures_of_the_whole_request_keep_their_kind() {
    let world = World::connected();
    let reset = "4000000000";
    for kind in ["RATE_LIMITED", "RATE_LIMIT"] {
        let error = world.fails(
            Reply::graphql(
                json!({"errors": [{"type": kind, "message": "API rate limit exceeded"}]}),
            )
            .with_header("X-RateLimit-Reset", reset),
        );
        assert_eq!(error["kind"], "rateLimited");
        assert_eq!(error["resetAt"], 4_000_000_000_u64);
    }
    for (reply, http_status) in [
        (Reply::status(502, "<html>"), 502),
        (Reply::status(200, "<html>"), 200),
        (Reply::graphql(json!({"data": null})), 200),
    ] {
        let error = world.fails(reply);
        assert_eq!(error["kind"], "gitHubFailed");
        assert_eq!(error["httpStatus"], http_status);
        assert_eq!(error["status"]["github"]["kind"], "connected");
    }
}

#[test]
fn a_revoked_token_signs_out() {
    let world = World::connected();
    let error = world.fails(Reply::bad_credentials());
    assert_eq!(error["kind"], "signedOut");
    assert_eq!(
        error["status"]["github"],
        json!({"kind": "notConnected", "ended": {"login": "octo", "reason": "revoked"}})
    );
    assert_eq!(world.open().unwrap_err()["kind"], "notConnected");
    assert_eq!(world.github.questions().len(), 1);
}

#[test]
fn withheld_checks_are_not_no_checks() {
    let world = World::connected();
    let none = world.opens(open("octo/app", vec![row(7)], &[]));
    assert_eq!(
        none["items"][0]["checks"],
        json!({"passed": 0, "failed": 0, "skipped": 0, "running": 0})
    );

    let mut answer = open("octo/app", vec![row(7)], &[]);
    let path = json!([
        "repository",
        "pullRequests",
        "nodes",
        0,
        "statusCheckRollup"
    ]);
    answer["errors"] = json!([refusal("FORBIDDEN", path)]);
    assert_eq!(world.opens(answer)["items"][0]["checks"], json!(null));
}

#[test]
fn a_withheld_row_still_counts() {
    let world = World::connected();
    let mut answer = open("octo/app", vec![json!(null), row(7)], &[]);
    let path = json!(["repository", "pullRequests", "nodes", 0]);
    answer["errors"] = json!([refusal("FORBIDDEN", path)]);
    let page = world.opens(answer);
    assert_eq!(page["total"], 2);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["number"], 7);
}

#[test]
fn states_and_verdicts_claim_the_least() {
    let world = World::connected();
    let contexts = |runs: Value, statuses: Value| json!({"statusCheckRollup": {"contexts": {"checkRunCountsByState": runs, "statusContextCountsByState": statuses}}});
    let opinions = |states: &[&str]| json!({"latestOpinionatedReviews": {"nodes": states.iter().map(|state| json!({"state": state})).collect::<Vec<_>>()}});
    let page = world.opens(open(
        "octo/app",
        vec![
            row_with(1, json!({"mergedAt": "2026-11-24T16:23:14Z", "closedAt": "2026-11-24T16:23:15Z"})),
            row_with(2, json!({"closedAt": "2026-11-24T16:23:15Z", "isDraft": true})),
            row_with(3, json!({"reviewDecision": "BY_MAGIC", "mergeable": "BY_MAGIC"})),
            row_with(4, opinions(&["CHANGES_REQUESTED", "APPROVED"])),
            row_with(5, opinions(&["APPROVED", "DISMISSED"])),
            row_with(6, opinions(&["DISMISSED"])),
            row_with(7, {
                let mut fields = opinions(&["CHANGES_REQUESTED"]);
                fields["reviewDecision"] = json!("APPROVED");
                fields
            }),
            row_with(8, json!({"author": null, "labels": null, "totalCommentsCount": null, "latestOpinionatedReviews": null})),
            row_with(9, contexts(
                json!([{"state": "BY_MAGIC", "count": 1}, {"state": "STALE", "count": 2}, {"state": "NEUTRAL", "count": 3}, {"state": "TIMED_OUT", "count": 4}]),
                json!([{"state": "EXPECTED", "count": 10}, {"state": "ERROR", "count": 20}, {"state": "SUCCESS", "count": 30}]),
            )),
            row_with(10, contexts(json!(null), json!([]))),
        ],
        &[],
    ));
    let item = |number: usize| &page["items"][number - 1];
    assert_eq!(
        item(1)["state"],
        json!({"kind": "merged", "at": "2026-11-24T16:23:14Z"})
    );
    assert_eq!(
        item(2)["state"],
        json!({"kind": "closed", "at": "2026-11-24T16:23:15Z"})
    );
    assert_eq!(item(3)["review"], "required");
    assert_eq!(item(3)["mergeable"], "unknown");
    assert_eq!(item(4)["review"], "changesRequested");
    assert_eq!(item(5)["review"], "approved");
    assert_eq!(item(6)["review"], json!(null));
    assert_eq!(item(7)["review"], "approved");
    assert_eq!(item(8)["author"], json!(null));
    assert_eq!(item(8)["comments"], 0);
    assert_eq!(
        item(9)["checks"],
        json!({"passed": 30, "failed": 24, "skipped": 3, "running": 13})
    );
    assert_eq!(item(10)["checks"], json!(null));
}
