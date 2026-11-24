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

    fn pull(&self) -> Result<Value, Value> {
        self.send(json!({"op": "pullRequest", "repository": {"owner": "octo", "repo": "app"}, "number": 12}))
    }

    fn pulls(&self, answer: Value) -> Value {
        self.github.graphql([Reply::graphql(answer)]);
        self.pull().unwrap()["data"].clone()
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
        "labels": {"totalCount": 0, "nodes": []}, "latestOpinionatedReviews": {"totalCount": 0, "nodes": []},
        "statusCheckRollup": null,
    })
}

fn row_with(number: u32, fields: Value) -> Value {
    with(row(number), fields)
}

fn with(mut object: Value, fields: Value) -> Value {
    let Value::Object(fields) = fields else {
        panic!("fields are an object")
    };
    object.as_object_mut().unwrap().extend(fields);
    object
}

fn pull(fields: Value) -> Value {
    let empty = || json!({"totalCount": 0, "nodes": []});
    let pull = json!({
        "number": 12, "title": "Fix it", "body": "", "isDraft": false, "mergedAt": null, "closedAt": null,
        "createdAt": "2026-11-24T16:23:14Z", "updatedAt": "2026-11-24T16:23:14Z", "author": {"login": "hubot"},
        "viewerDidAuthor": false, "additions": 1, "deletions": 2, "changedFiles": 1, "labels": empty(),
        "baseRefName": "main", "headRefName": "fix", "headRefOid": "1".repeat(40),
        "isCrossRepository": false, "maintainerCanModify": false,
        "headRepository": {"name": "app", "owner": {"login": "octo"}},
        "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
        "reviewRequests": empty(), "latestReviews": empty(), "latestOpinionatedReviews": empty(),
        "statusCheckRollup": null, "commits": empty(), "timelineItems": empty(), "reviewThreads": empty(),
    });
    json!({"data": {"repository": {"pullRequest": with(pull, fields)}}})
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
        json!({"owner": "octo", "repo": "app", "requested": "repo:octo/app is:pr is:open review-requested:@me sort:updated-desc"})
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
        "repo:octo/new is:pr is:open review-requested:@me sort:updated-desc"
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
    let opinions = |states: &[&str]| json!({"latestOpinionatedReviews": {"totalCount": states.len(), "nodes": states.iter().map(|state| json!({"state": state})).collect::<Vec<_>>()}});
    let more = |states: &[&str]| {
        let mut fields = opinions(states);
        fields["latestOpinionatedReviews"]["totalCount"] = json!(states.len() + 1);
        fields
    };
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
            row_with(11, more(&["APPROVED"])),
            row_with(12, more(&["APPROVED", "CHANGES_REQUESTED"])),
            row_with(13, more(&[])),
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
    assert_eq!(item(11)["review"], "required");
    assert_eq!(item(12)["review"], "changesRequested");
    assert_eq!(item(13)["review"], "required");
}

#[test]
fn one_pull_request_answers_in_l1_gits_words() {
    let world = World::connected();
    world.github.graphql([Reply::recorded("pull-open")]);
    let answer = world.pull().unwrap();
    assert_eq!(answer["op"], "pullRequest");
    assert_eq!(answer["status"]["github"]["login"], "octo");
    let hunk = "@@ -1,2 +1,2 @@\n-let file = read();\n+let file = read_once();";
    let facts = json!({
        "number": 12, "title": "Read the configuration file once",
        "body": "The file was read for **every** request.",
        "state": {"kind": "open", "draft": false}, "author": "hubot", "viewerIsAuthor": false, "base": "main",
        "labels": {"total": 1, "items": [{"name": "bug", "color": "d73a4a"}]},
        "additions": 80, "deletions": 8, "changedFiles": 3,
        "createdAt": "2026-05-07T21:40:00Z", "updatedAt": "2026-11-24T15:33:39Z",
        "head": {
            "branch": "read-config-once", "oid": "1".repeat(40),
            "repository": {"owner": "hubot", "repo": "app"},
            "crossRepository": true, "maintainerCanModify": true,
        },
        "mergeable": "mergeable", "mergeState": "blocked",
    });
    assert_eq!(
        answer["data"],
        with(
            facts,
            json!({
                "reviewers": [
                    {"login": "monalisa", "state": "requested"},
                    {"login": "review-bot", "state": "commented"},
                ],
                "checks": {"total": 11, "items": [
                    {
                        "name": "build", "state": "passed", "required": true, "startedAt": "2026-11-20T18:16:37Z",
                        "completedAt": "2026-11-20T18:20:24Z", "url": "https://github.com/octo/app/actions/runs/1/job/1",
                    },
                    {
                        "name": "lint", "state": "passed", "required": false, "startedAt": "2026-11-20T18:16:37Z",
                        "completedAt": "2026-11-20T18:20:17Z", "url": "https://github.com/octo/app/actions/runs/1/job/2",
                    },
                    {
                        "name": "license/cla", "state": "running", "required": false, "startedAt": "2026-07-19T02:59:11Z",
                        "completedAt": null, "url": "https://github.com/octo/app/actions/runs/1/job/3",
                    },
                ]},
                "commits": {"total": 6, "items": [
                    {"oid": "2".repeat(40), "headline": "Read the file once", "by": "hubot", "at": "2026-11-18T23:07:11Z"},
                    {"oid": "3".repeat(40), "headline": "Keep the parsed file", "by": "hubot", "at": "2026-11-19T18:59:20Z"},
                ]},
                "timeline": {"total": 8, "items": [
                    {"kind": "commit", "oid": "2".repeat(40), "headline": "Read the file once", "by": "hubot", "at": "2026-11-18T23:07:11Z"},
                    {"kind": "forcePushed", "from": "4".repeat(40), "to": "5".repeat(40), "by": "hubot", "at": "2026-10-13T18:51:33Z"},
                    {"kind": "readyForReview", "by": "hubot", "at": "2026-05-07T21:46:18Z"},
                    {"kind": "review", "id": "PRR_1", "state": "commented", "body": "Looks close.", "by": "review-bot", "at": "2026-11-18T23:12:36Z"},
                    {"kind": "comment", "body": "Thanks for the pull request.", "by": "octo-bot", "at": "2026-10-13T18:48:27Z"},
                ]},
                "threads": {"total": 6, "items": [
                    {
                        "id": "PRRT_1", "review": "PRR_1", "path": "src/config.rs", "line": null, "startLine": null, "originalLine": 175, "originalStartLine": null,
                        "side": "right", "outdated": true, "resolved": true, "hunk": hunk,
                        "comments": {"total": 2, "items": [{"by": "review-bot", "at": "2026-11-18T23:12:35Z", "body": "Could this stay lazy?"}]},
                    },
                    {
                        "id": "PRRT_2", "review": null, "path": "src/main.rs", "line": 30, "startLine": 30, "originalLine": 26, "originalStartLine": null,
                        "side": "right", "outdated": false, "resolved": false, "hunk": hunk,
                        "comments": {"total": 4, "items": [{"by": "monalisa", "at": "2026-11-19T18:23:35Z", "body": "Could this stay lazy?"}]},
                    },
                ]},
            })
        )
    );
    assert_eq!(
        world.github.questions()[0]["variables"],
        json!({"owner": "octo", "repo": "app", "number": 12})
    );
}

#[test]
fn a_merged_pull_request_tells_how_it_ended() {
    let world = World::connected();
    world.github.graphql([Reply::recorded("pull-merged")]);
    let data = world.pull().unwrap()["data"].clone();
    assert_eq!(
        data["state"],
        json!({"kind": "merged", "at": "2026-11-17T19:18:14Z"})
    );
    assert_eq!(
        data["timeline"]["items"],
        json!([
            {"kind": "merged", "oid": "6".repeat(40), "by": "hubot", "at": "2026-11-17T19:18:14Z"},
            {"kind": "closed", "by": "hubot", "at": "2026-11-17T19:18:14Z"},
            {"kind": "branchDeleted", "by": "hubot", "at": "2026-11-17T19:18:36Z"},
        ])
    );
    assert_eq!(data["viewerIsAuthor"], true);
    assert_eq!(data["checks"]["items"][0]["state"], "skipped");
    assert_eq!(data["mergeable"], "unknown");
    assert_eq!(data["mergeState"], "unknown");
}

#[test]
fn a_missing_pull_request_names_what_is_missing() {
    let world = World::connected();
    for (answer, what) in [
        (
            json!({"data": {"repository": {"pullRequest": null}}, "errors": [refusal("NOT_FOUND", json!(["repository", "pullRequest"]))]}),
            "can't find pull request #12 in octo/app on",
        ),
        (
            json!({"data": {"repository": null}, "errors": [refusal("NOT_FOUND", json!(["repository"]))]}),
            "can't find octo/app on",
        ),
    ] {
        world.github.graphql([Reply::graphql(answer)]);
        let error = world.pull().unwrap_err();
        assert_eq!(error["kind"], "notFound");
        let message = error["message"].as_str().unwrap();
        assert!(message.contains(what), "{message}");
    }
}

#[test]
fn reviewers_show_what_is_asked_of_them_last() {
    let world = World::connected();
    let review = |login: &str, state: &str| json!({"author": {"login": login}, "state": state});
    let data = world.pulls(pull(json!({
        "latestReviews": {"nodes": [
            review("approver", "COMMENTED"), review("asked-again", "APPROVED"), review("talker", "COMMENTED"),
            review("hubot", "COMMENTED"), review("newcomer", "BY_MAGIC"),
            {"author": null, "state": "APPROVED"},
        ]},
        "latestOpinionatedReviews": {"nodes": [
            review("approver", "APPROVED"), review("asked-again", "APPROVED"), review("dismissed", "DISMISSED"),
        ]},
        "reviewRequests": {"nodes": [
            {"requestedReviewer": {"login": "asked-again"}}, {"requestedReviewer": {}},
        ]},
    })));
    assert_eq!(
        data["reviewers"],
        json!([
            {"login": "approver", "state": "approved"},
            {"login": "asked-again", "state": "requested"},
            {"login": "dismissed", "state": "dismissed"},
            {"login": "newcomer", "state": "commented"},
            {"login": "talker", "state": "commented"},
            {"login": null, "state": "requested"},
        ])
    );
}

#[test]
fn the_timeline_skips_what_it_cannot_tell_but_counts_it() {
    let world = World::connected();
    let act =
        |kind: &str| json!({"__typename": kind, "author": null, "at": "2026-11-24T16:23:14Z"});
    let data = world.pulls(pull(json!({"timelineItems": {"totalCount": 9, "nodes": [
        {"__typename": "PullRequestReview", "id": "PRR_2", "author": {"login": "octo"}, "submittedAt": null, "state": "PENDING", "body": "Not sent yet."},
        {"__typename": "NewEvent", "extra": {"nested": 1}},
        null,
        act("ReopenedEvent"),
        act("ConvertToDraftEvent"),
        {"__typename": "HeadRefForcePushedEvent", "author": null, "at": "2026-11-24T16:23:14Z", "beforeCommit": null, "afterCommit": null},
        {"__typename": "PullRequestCommit", "commit": {"oid": "a", "messageHeadline": "Fix it", "committedDate": "2026-11-24T16:23:14Z", "author": {"name": "Mona Lisa", "user": null}}},
    ]}})));
    let at = "2026-11-24T16:23:14Z";
    assert_eq!(
        data["timeline"],
        json!({"total": 9, "items": [
            {"kind": "reopened", "by": null, "at": at},
            {"kind": "convertedToDraft", "by": null, "at": at},
            {"kind": "forcePushed", "from": null, "to": null, "by": null, "at": at},
            {"kind": "commit", "oid": "a", "headline": "Fix it", "by": "Mona Lisa", "at": at},
        ]})
    );
}

#[test]
fn checks_claim_the_least() {
    let world = World::connected();
    let run = |status: &str, conclusion: Value| json!({"__typename": "CheckRun", "name": "run", "status": status, "conclusion": conclusion, "startedAt": null, "completedAt": null, "url": null, "isRequired": false});
    let nodes = json!([
        run("QUEUED", json!(null)),
        run("COMPLETED", json!("BY_MAGIC")),
        run("COMPLETED", json!("CANCELLED")),
        {"__typename": "StatusContext", "context": "ci/build", "state": "FAILURE", "url": "https://ci.test/1", "isRequired": true},
        {"__typename": "NewContext", "name": "new"},
        null,
    ]);
    let data = world.pulls(pull(
        json!({"statusCheckRollup": {"contexts": {"totalCount": 6, "nodes": nodes}}}),
    ));
    let states: Vec<_> = data["checks"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|check| check["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["running", "running", "failed", "failed"]);
    assert_eq!(data["checks"]["total"], 6);
    assert_eq!(
        data["checks"]["items"][3],
        json!({"name": "ci/build", "state": "failed", "required": true, "startedAt": null, "completedAt": null, "url": "https://ci.test/1"})
    );

    let none = world.pulls(pull(json!({})));
    assert_eq!(none["checks"], json!({"items": [], "total": 0}));
    let mut withheld = pull(json!({}));
    withheld["errors"] = json!([refusal(
        "FORBIDDEN",
        json!(["repository", "pullRequest", "statusCheckRollup"])
    )]);
    assert_eq!(world.pulls(withheld)["checks"], json!(null));
}

#[test]
fn a_gone_fork_and_unknown_values_still_read() {
    let world = World::connected();
    let data = world.pulls(pull(json!({
        "author": null, "headRepository": null, "isCrossRepository": true,
        "mergeStateStatus": "BY_MAGIC", "reviewRequests": null, "latestReviews": null, "latestOpinionatedReviews": null,
        "reviewThreads": {"totalCount": 1, "nodes": [{
            "id": "PRRT_1", "path": "src/main.rs", "line": null, "startLine": null, "originalLine": null, "originalStartLine": null,
            "diffSide": "LEFT", "isOutdated": false, "isResolved": false, "first": {"nodes": []}, "comments": {"totalCount": 0, "nodes": []},
        }]},
    })));
    assert_eq!(data["author"], json!(null));
    assert_eq!(data["head"]["repository"], json!(null));
    assert_eq!(data["head"]["crossRepository"], true);
    assert_eq!(data["mergeState"], "unknown");
    assert_eq!(data["reviewers"], json!([]));
    assert_eq!(data["threads"]["items"][0]["side"], "left");
    assert_eq!(data["threads"]["items"][0]["hunk"], "");
}
