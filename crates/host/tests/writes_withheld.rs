#![cfg(unix)]

#[allow(dead_code)]
mod support;
#[allow(dead_code)]
mod writing;

use serde_json::{Value, json};
use support::Reply;
use writing::{World, oid, resolved};

/// GitHub answers 200 with `node` and an error beside it when it failed at
/// part of a read.
fn failed_at(node: Value, path: &[&str]) -> Reply {
    Reply::graphql(json!({"data": {"node": node}, "errors": [
        {"type": "SERVICE_UNAVAILABLE", "path": path, "message": "Something went wrong while executing your query."},
    ]}))
}

#[test]
fn a_write_whose_read_first_github_failed_at_sends_nothing() {
    let lines = json!({"path": "a.rs", "side": "right", "line": 3, "start": null});
    for write in [
        json!({"kind": "comment", "pull": "PR_1", "body": "LGTM"}),
        json!({"kind": "reply", "thread": "PRRT_1", "body": "Done"}),
        json!({"kind": "singleComment", "pull": "PR_1", "commit": oid('1'), "lines": lines, "body": "Why?"}),
        json!({"kind": "submitReview", "pull": "PR_1", "commit": oid('1'), "event": "approve", "body": "", "threads": []}),
    ] {
        let world = World::connected();
        world.github.graphql([failed_at(Value::Null, &["node"])]);
        let written = world.write(write.clone());
        assert_eq!(written["kind"], "notSent", "{write}: {written}");
        assert!(world.mutations().is_empty(), "{write}");
    }
}

#[test]
fn a_read_github_failed_at_after_a_lost_write_settles_nothing() {
    let world = World::connected();
    let resolve = json!({"kind": "resolve", "thread": "PRRT_1"});
    world.github.graphql([Reply::unanswered()]);
    assert_eq!(world.write(resolve)["kind"], "unknown");
    world.github.graphql([failed_at(Value::Null, &["node"])]);
    assert_eq!(world.check()["settled"], json!([]), "not gone, unread");
    world.github.graphql([resolved(true)]);
    assert_eq!(world.check()["settled"][0]["seen"]["kind"], "landed");

    let world = World::connected();
    let delete = json!({"kind": "deleteHeadBranch", "pull": "PR_1", "branch": "fix", "expectedHead": oid('1')});
    world.github.graphql([
        Reply::graphql(json!({"data": {"node": {
            "merged": true, "headRefName": "fix", "isCrossRepository": false,
            "headRef": {"target": {"oid": oid('1')}, "associatedPullRequests": {"totalCount": 0}},
            "headRepository": {"id": "R_1", "basedOn": {"totalCount": 0}},
        }}})),
        Reply::unanswered(),
    ]);
    assert_eq!(world.write(delete)["kind"], "unknown");
    let partly = json!({"merged": true, "mergeCommit": {"oid": oid('9')}, "headRef": null});
    world
        .github
        .graphql([failed_at(partly, &["node", "headRef"])]);
    let checked = world.check();
    assert_eq!(
        checked["settled"],
        json!([]),
        "a head GitHub left out is not a deleted one: {checked}"
    );
    assert_eq!(checked["drafts"]["sent"].as_array().unwrap().len(), 1);
}
