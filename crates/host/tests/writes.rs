#![cfg(unix)]

#[allow(dead_code)]
mod support;

use std::sync::{Arc, Barrier};
use std::thread;

use l1_git_host::{Endpoints, GhChoice, Host, HostConfig, Request, VaultChoice, run};
use serde_json::{Value, json};
use support::{FakeGh, FakeGitHub, Reply};

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
        world.send(json!({"op": "connectGh", "login": "octo"}));
        world
    }

    fn send(&self, request: Value) -> Value {
        let request: Request = serde_json::from_value(request).unwrap();
        let reply = serde_json::to_value(run(&self.host, request).unwrap()).unwrap();
        assert!(!reply.to_string().contains("gho_"), "a token escaped");
        reply
    }

    fn write_as(&self, login: &str, write: Value) -> Value {
        let reply = self.send(json!({"op": "write", "asLogin": login, "write": write}));
        assert_eq!(reply["op"], "write");
        reply["data"].clone()
    }

    fn write(&self, write: Value) -> Value {
        self.write_as("octo", write)
    }

    fn mutations(&self) -> Vec<Value> {
        self.github
            .questions()
            .into_iter()
            .filter(|question| question["query"].as_str().unwrap().starts_with("mutation"))
            .collect()
    }

    /// Asserts the one question asked was `field`'s mutation with `input`.
    fn sent_once(&self, field: &str, input: Value) {
        let asked = self.github.questions();
        assert_eq!(asked.len(), 1, "one question, never a second");
        let query = asked[0]["query"].as_str().unwrap();
        assert!(query.starts_with("mutation"), "{query}");
        assert!(
            query.contains(&format!("{field}(input: $input)")),
            "{query}"
        );
        assert_eq!(asked[0]["variables"], json!({"input": input}));
    }
}

fn answered(field: &str, payload: Value) -> Reply {
    Reply::graphql(json!({"data": {field: payload}}))
}

fn oid(digit: char) -> String {
    digit.to_string().repeat(40)
}

fn comment() -> Value {
    json!({"kind": "comment", "pull": "PR_1", "body": "Looks good once CI is green."})
}

fn done(echo: Value) -> Value {
    json!({"kind": "done", "echo": echo})
}

#[test]
fn a_single_comment_is_a_review_of_one_thread() {
    let world = World::connected();
    world.github.graphql([answered(
        "addPullRequestReview",
        json!({"pullRequestReview": {"id": "PRR_1"}}),
    )]);
    let lines = json!({"path": "src/a.rs", "side": "right", "line": 12, "start": {"side": "right", "line": 10}});
    let written = world.write(json!({"kind": "singleComment", "pull": "PR_1", "commit": oid('1'), "lines": lines, "body": "Off by one?"}));
    assert_eq!(written, done(json!({"kind": "review", "id": "PRR_1"})));
    world.sent_once(
        "addPullRequestReview",
        json!({"pullRequestId": "PR_1", "commitOID": oid('1'), "event": "COMMENT", "threads": [
            {"path": "src/a.rs", "line": 12, "side": "RIGHT", "startLine": 10, "startSide": "RIGHT", "body": "Off by one?"},
        ]}),
    );
}

#[test]
fn a_review_sends_its_verdict_summary_and_every_thread_at_once() {
    let world = World::connected();
    world.github.graphql([answered(
        "addPullRequestReview",
        json!({"pullRequestReview": {"id": "PRR_2"}}),
    )]);
    let line =
        |line: u32, side: &str| json!({"path": "a.rs", "side": side, "line": line, "start": null});
    let written = world.write(json!({
        "kind": "submitReview", "pull": "PR_1", "commit": oid('1'), "event": "requestChanges", "body": "Two things.",
        "threads": [{"lines": line(3, "left"), "body": "Gone?"}, {"lines": line(9, "right"), "body": "Why?"}],
    }));
    assert_eq!(written, done(json!({"kind": "review", "id": "PRR_2"})));
    world.sent_once(
        "addPullRequestReview",
        json!({"pullRequestId": "PR_1", "commitOID": oid('1'), "event": "REQUEST_CHANGES", "body": "Two things.", "threads": [
            {"path": "a.rs", "line": 3, "side": "LEFT", "body": "Gone?"},
            {"path": "a.rs", "line": 9, "side": "RIGHT", "body": "Why?"},
        ]}),
    );
}

#[test]
fn a_pending_review_from_github_is_submitted_as_it_is() {
    let world = World::connected();
    world.github.graphql([answered(
        "submitPullRequestReview",
        json!({"pullRequestReview": {"id": "PRR_3"}}),
    )]);
    let written = world
        .write(json!({"kind": "submitPending", "review": "PRR_3", "event": "approve", "body": ""}));
    assert_eq!(written, done(json!({"kind": "review", "id": "PRR_3"})));
    world.sent_once(
        "submitPullRequestReview",
        json!({"pullRequestReviewId": "PRR_3", "event": "APPROVE", "body": ""}),
    );
}

#[test]
fn a_reply_names_its_thread() {
    let world = World::connected();
    world.github.graphql([answered(
        "addPullRequestReviewThreadReply",
        json!({"comment": {"id": "PRRC_9"}}),
    )]);
    let written = world.write(json!({"kind": "reply", "thread": "PRRT_1", "body": "Fixed."}));
    assert_eq!(written, done(json!({"kind": "comment", "id": "PRRC_9"})));
    world.sent_once(
        "addPullRequestReviewThreadReply",
        json!({"pullRequestReviewThreadId": "PRRT_1", "body": "Fixed."}),
    );
}

#[test]
fn resolving_and_unresolving_name_their_thread() {
    for (kind, field, resolved) in [
        ("resolve", "resolveReviewThread", true),
        ("unresolve", "unresolveReviewThread", false),
    ] {
        let world = World::connected();
        world.github.graphql([answered(
            field,
            json!({"thread": {"id": "PRRT_1", "isResolved": resolved}}),
        )]);
        let written = world.write(json!({"kind": kind, "thread": "PRRT_1"}));
        assert_eq!(
            written,
            done(json!({"kind": "thread", "id": "PRRT_1", "resolved": resolved}))
        );
        world.sent_once(field, json!({"threadId": "PRRT_1"}));
    }
}

#[test]
fn a_conversation_comment_is_added_to_the_pull_request() {
    let world = World::connected();
    world.github.graphql([answered(
        "addComment",
        json!({"commentEdge": {"node": {"id": "IC_7"}}}),
    )]);
    assert_eq!(
        world.write(comment()),
        done(json!({"kind": "comment", "id": "IC_7"}))
    );
    world.sent_once(
        "addComment",
        json!({"subjectId": "PR_1", "body": "Looks good once CI is green."}),
    );
}

#[test]
fn a_merge_names_the_head_it_expects_and_leaves_out_github_s_own_texts() {
    let world = World::connected();
    world.github.graphql([answered(
        "mergePullRequest",
        json!({"pullRequest": {"mergeCommit": {"oid": oid('9')}}}),
    )]);
    let written = world.write(json!({
        "kind": "merge", "pull": "PR_1", "expectedHead": oid('1'), "method": "squash",
        "headline": "Fix it (#12)", "body": null,
    }));
    assert_eq!(written, done(json!({"kind": "merged", "commit": oid('9')})));
    world.sent_once(
        "mergePullRequest",
        json!({"pullRequestId": "PR_1", "expectedHeadOid": oid('1'), "mergeMethod": "SQUASH", "commitHeadline": "Fix it (#12)"}),
    );
}

fn delete_branch() -> Value {
    json!({"kind": "deleteHeadBranch", "pull": "PR_1", "branch": "fix", "expectedHead": oid('1')})
}

fn branch(head: Value, heads: u32, bases: u32) -> Reply {
    let mut head = head;
    if head.is_object() {
        head["associatedPullRequests"] = json!({"totalCount": heads});
    }
    Reply::graphql(json!({"data": {"node": {
        "merged": true, "headRefName": "fix", "isCrossRepository": false, "headRef": head,
        "headRepository": {"basedOn": {"totalCount": bases}},
    }}}))
}

fn at(digit: char) -> Value {
    json!({"id": "REF_1", "target": {"oid": oid(digit)}})
}

#[test]
fn a_head_branch_is_checked_then_deleted_by_the_id_github_gave() {
    let world = World::connected();
    world.github.graphql([
        branch(at('1'), 0, 0),
        answered("deleteRef", json!({"clientMutationId": null})),
    ]);
    assert_eq!(
        world.write(delete_branch()),
        done(json!({"kind": "branchDeleted"}))
    );
    let asked = world.github.questions();
    assert_eq!(
        asked[0]["variables"],
        json!({"pull": "PR_1", "branch": "fix"})
    );
    assert_eq!(world.mutations().len(), 1);
    assert_eq!(asked[1]["variables"], json!({"input": {"refId": "REF_1"}}));
}

#[test]
fn a_head_branch_already_gone_is_done_without_a_delete() {
    let world = World::connected();
    world.github.graphql([branch(Value::Null, 0, 0)]);
    assert_eq!(
        world.write(delete_branch()),
        done(json!({"kind": "branchDeleted"}))
    );
    assert_eq!(world.github.questions().len(), 1);
}

#[test]
fn a_head_branch_that_moved_or_is_in_use_is_kept() {
    for (head, heads, bases, why) in [
        (at('2'), 0, 0, "new commit"),
        (at('1'), 1, 0, "as their head"),
        (at('1'), 0, 2, "merge into it"),
    ] {
        let world = World::connected();
        world.github.graphql([branch(head, heads, bases)]);
        let written = world.write(delete_branch());
        assert_eq!(written["kind"], "refused");
        assert!(
            written["message"].as_str().unwrap().contains(why),
            "{written}"
        );
        assert!(world.mutations().is_empty(), "nothing is deleted");
    }
}

#[test]
fn a_head_branch_that_could_not_be_checked_is_not_deleted() {
    for reply in [
        Reply::status(502, "<html>"),
        Reply::graphql(json!({"data": {"node": null}, "errors": [
            {"type": "NOT_FOUND", "path": ["node"], "message": "Could not resolve to a node."},
        ]})),
    ] {
        let world = World::connected();
        world.github.graphql([reply]);
        assert_eq!(world.write(delete_branch())["kind"], "notSent");
        assert_eq!(
            world.github.questions().len(),
            1,
            "the check is not asked again"
        );
    }
}

#[test]
fn a_disconnect_while_the_branch_is_checked_deletes_nothing() {
    let world = World::connected();
    let checked = Arc::new(Barrier::new(2));
    world
        .github
        .graphql([branch(at('1'), 0, 0).after(&checked)]);
    let written = thread::scope(|scope| {
        let writing = scope.spawn(|| world.write(delete_branch()));
        while world.github.questions().is_empty() {
            thread::yield_now();
        }
        world.send(json!({"op": "disconnect"}));
        checked.wait();
        writing.join().unwrap()
    });
    assert_eq!(written["kind"], "notSent");
    assert_eq!(world.github.questions().len(), 1);
    assert!(world.mutations().is_empty());
}

#[test]
fn a_write_for_another_account_sends_nothing() {
    let world = World::connected();
    let written = world.write_as("hubot", comment());
    assert_eq!(written["kind"], "notSent");
    let message = written["message"].as_str().unwrap();
    assert!(message.contains("as octo, not hubot"), "{message}");
    assert!(world.github.questions().is_empty());
}

#[test]
fn a_write_without_a_connection_sends_nothing() {
    let world = World::connected();
    world.send(json!({"op": "disconnect"}));
    assert_eq!(world.write(comment())["kind"], "notSent");
    assert!(world.github.questions().is_empty());
}

#[test]
fn a_write_github_would_refuse_sends_nothing() {
    let world = World::connected();
    for refused in [
        json!({"kind": "comment", "pull": "PR_1", "body": " \n"}),
        json!({"kind": "reply", "thread": "PRRT_1", "body": "x".repeat(65_537)}),
        json!({"kind": "submitReview", "pull": "PR_1", "commit": oid('1'), "event": "comment", "body": "", "threads": []}),
        json!({"kind": "merge", "pull": "PR_1", "expectedHead": oid('1'), "method": "merge", "headline": " ", "body": null}),
    ] {
        assert_eq!(world.write(refused)["kind"], "notSent");
    }
    assert!(world.github.questions().is_empty());
}

#[test]
fn what_github_refuses_is_refused_with_its_own_words() {
    for (reply, words) in [
        (
            Reply::graphql(json!({"data": {"addComment": null}, "errors": [
                {"type": "UNPROCESSABLE", "path": ["addComment"], "message": "Pull request is locked."},
            ]})),
            "Pull request is locked.",
        ),
        (
            Reply::status(
                403,
                r#"{"message":"Resource not accessible by integration"}"#,
            ),
            "Resource not accessible by integration",
        ),
        (Reply::status(422, "{}"), "HTTP 422"),
        (Reply::rate_limited(1_700_000_000), "rate limit"),
    ] {
        let world = World::connected();
        world.github.graphql([reply]);
        let written = world.write(comment());
        assert_eq!(written["kind"], "refused", "{written}");
        assert!(
            written["message"].as_str().unwrap().contains(words),
            "{written}"
        );
        assert_eq!(world.github.questions().len(), 1);
    }
}

#[test]
fn a_token_github_refuses_is_refused_and_signs_out() {
    let world = World::connected();
    world.github.graphql([Reply::bad_credentials()]);
    let reply = world.send(json!({"op": "write", "asLogin": "octo", "write": comment()}));
    assert_eq!(reply["data"]["kind"], "refused");
    assert_eq!(
        reply["status"]["github"],
        json!({"kind": "notConnected", "ended": {"login": "octo", "reason": "revoked"}})
    );
    assert_eq!(world.github.questions().len(), 1);
}

#[test]
fn a_write_with_no_answer_it_can_read_is_unknown_and_never_sent_again() {
    for reply in [
        Reply::status(502, "<html>"),
        Reply::status(200, "<html>"),
        Reply::graphql(
            json!({"errors": [{"message": "Something went wrong while executing your query."}]}),
        ),
        Reply::graphql(json!({"data": {"addComment": null}, "errors": [
            {"type": "RESOURCE_LIMITS_EXCEEDED", "path": ["addComment"], "message": "Too much."},
        ]})),
        Reply::graphql(json!({"data": {"addComment": null}})),
    ] {
        let world = World::connected();
        world
            .github
            .graphql([reply, answered("addComment", json!({}))]);
        let written = world.write(comment());
        assert_eq!(written["kind"], "unknown", "{written}");
        assert_eq!(world.github.questions().len(), 1, "never asked again");
    }
}

#[test]
fn a_write_github_heard_and_never_answered_is_unknown() {
    let world = World::connected();
    world.github.silence();
    let written = world.write(comment());
    assert_eq!(written["kind"], "unknown");
    let message = written["message"].as_str().unwrap();
    assert!(message.contains("may or may not"), "{message}");
    assert_eq!(world.github.questions().len(), 1);
}
