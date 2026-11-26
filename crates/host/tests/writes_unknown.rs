#![cfg(unix)]

#[allow(dead_code)]
mod support;
#[allow(dead_code)]
mod writing;

use std::sync::{Arc, Barrier};
use std::thread;

use serde_json::{Value, json};
use support::Reply;
use writing::{
    World, answered, attempt, drafts_on, oid, pull_state, resolved, reviews, said, write_on,
};

fn conversation() -> Value {
    json!({"kind": "conversation"})
}

fn lgtm() -> Value {
    json!({"kind": "comment", "pull": "PR_1", "body": "LGTM"})
}

/// Sends `write` carrying one conversation draft of its words, and GitHub
/// hears it and never answers.
fn lost(world: &World, write: Value, before: Reply) -> (String, Value) {
    let carried = world.draft(conversation(), write["body"].as_str().unwrap());
    world.github.graphql([before, Reply::unanswered()]);
    let attempt = attempt();
    let wrote = world.wrote(&attempt, write, json!([carried]));
    assert_eq!(wrote["written"]["kind"], "unknown", "{wrote}");
    (attempt, wrote)
}

fn kept(answer: &Value) -> (usize, usize) {
    let count = |field: &str| answer[field].as_array().unwrap().len();
    (count("drafts"), count("sent"))
}

#[test]
fn a_lost_comment_is_kept_with_its_draft_until_a_new_comment_shows_its_words() {
    let world = World::connected();
    let (attempt, wrote) = lost(&world, lgtm(), said(&[("IC_1", "octo", "LGTM")]));
    let drafts = &wrote["drafts"];
    assert_eq!(kept(drafts), (0, 1), "{drafts}");
    assert_eq!(drafts["sent"][0]["attempt"], attempt.as_str());
    assert_eq!(drafts["sent"][0]["sending"], false);
    assert_eq!(drafts["sent"][0]["drafts"][0]["text"], "LGTM");

    world.github.graphql([said(&[("IC_1", "octo", "LGTM")])]);
    let checked = world.check();
    assert_eq!(
        checked["settled"],
        json!([]),
        "the earlier LGTM is not this one"
    );
    assert_eq!(kept(&checked["drafts"]), (0, 1));

    world.github.graphql([said(&[
        ("IC_1", "octo", "LGTM"),
        ("IC_2", "hubot", "LGTM"),
        ("IC_3", "octo", "LGTM!"),
    ])]);
    assert_eq!(
        world.check()["settled"],
        json!([]),
        "only the viewer's own words"
    );

    world.github.graphql([said(&[
        ("IC_1", "octo", "LGTM"),
        ("IC_4", "octo", "LGTM\r\n"),
    ])]);
    let checked = world.check();
    assert_eq!(
        checked["settled"],
        json!([{"attempt": attempt, "write": lgtm(), "seen": {"kind": "landed", "echo": {"kind": "comment", "id": "IC_4"}}}])
    );
    assert_eq!(
        kept(&checked["drafts"]),
        (0, 0),
        "the draft went with its record"
    );
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn nothing_else_is_sent_for_a_pull_request_while_a_write_may_have_posted() {
    let world = World::connected();
    lost(&world, lgtm(), said(&[]));
    assert_eq!(world.write(lgtm())["kind"], "notSent");
    let resolve = json!({"kind": "resolve", "thread": "PRRT_1"});
    assert_eq!(world.write(resolve)["kind"], "notSent");
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn a_restart_a_second_process_or_signing_in_again_still_shows_what_may_have_posted() {
    let world = World::connected();
    let (attempt, _) = lost(&world, lgtm(), said(&[]));

    world.send(json!({"op": "disconnect"}));
    world.send(json!({"op": "connectGh", "login": "octo"}));
    let again = world.drafts(json!({"kind": "read"}));
    assert_eq!(again["sent"][0]["attempt"], attempt.as_str());
    assert_eq!(world.write(lgtm())["kind"], "notSent");

    let other = world.restarted();
    let read = drafts_on(&other, json!({"kind": "read"}));
    assert_eq!(kept(&read), (0, 1));
    assert_eq!(read["sent"][0]["sending"], false);
    let carried = json!([{"anchor": conversation(), "head": oid('1'), "at": 1}]);
    let wrote = write_on(&other, &writing::attempt(), lgtm(), carried);
    assert_eq!(wrote["written"]["kind"], "notSent", "{wrote}");
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn a_second_window_or_process_sends_nothing_while_a_write_is_in_flight() {
    let world = World::connected();
    let carried = world.draft(conversation(), "LGTM");
    let answering = Arc::new(Barrier::new(2));
    world.github.graphql([
        said(&[]),
        answered(
            "addComment",
            json!({"commentEdge": {"node": {"id": "IC_9"}}}),
        )
        .after(&answering),
    ]);
    let first = attempt();
    let other = world.restarted();
    let (wrote, during) = thread::scope(|scope| {
        let writing = scope.spawn(|| world.wrote(&first, lgtm(), json!([carried])));
        while world.mutations().is_empty() {
            thread::yield_now();
        }
        let during = (
            world.write(lgtm()),
            world.drafts(json!({"kind": "read"})),
            world.drafts(json!({"kind": "keep", "attempt": first})),
            write_on(&other, &attempt(), lgtm(), json!([]))["written"].clone(),
            world.check(),
        );
        answering.wait();
        (writing.join().unwrap(), during)
    });
    let (same, read, keep, elsewhere, checked) = during;
    assert_eq!(same["kind"], "notSent");
    assert!(
        same["message"].as_str().unwrap().contains("still sending"),
        "{same}"
    );
    assert_eq!(read["sent"][0]["sending"], true);
    assert_eq!(keep["refused"], json!({"kind": "sending"}));
    assert_eq!(elsewhere["kind"], "notSent");
    assert_eq!(checked["settled"], json!([]));
    assert_eq!(wrote["written"]["kind"], "done");
    assert_eq!(kept(&wrote["drafts"]), (0, 0));
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn an_earlier_review_with_the_same_words_never_settles_a_lost_one() {
    let world = World::connected();
    let line = json!({"path": "a.rs", "side": "right", "line": 3, "start": null});
    let anchor = json!({"kind": "line", "path": "a.rs", "side": "right", "line": 3, "start": null});
    let carried = world.draft(anchor, "Gone?");
    let review = json!({"kind": "submitReview", "pull": "PR_1", "commit": oid('1'), "event": "comment", "body": "", "threads": [
        {"lines": line, "body": "Gone?"},
    ]});
    let earlier: &[(&str, u32, &str)] = &[("a.rs", 3, "Gone?")];
    world.github.graphql([
        reviews(&[("PRR_1", "COMMENTED", "", earlier)]),
        Reply::unanswered(),
    ]);
    let attempt = attempt();
    let wrote = world.wrote(&attempt, review, json!([carried]));
    assert_eq!(wrote["written"]["kind"], "unknown");

    let other: &[(&str, u32, &str)] = &[("a.rs", 3, "Gone?"), ("b.rs", 1, "Also")];
    world.github.graphql([reviews(&[
        ("PRR_1", "COMMENTED", "", earlier),
        ("PRR_2", "APPROVED", "", earlier),
        ("PRR_3", "COMMENTED", "", other),
    ])]);
    let checked = world.check();
    assert_eq!(checked["settled"], json!([]), "{checked}");
    assert_eq!(kept(&checked["drafts"]), (0, 1), "its draft stays with it");

    world.github.graphql([reviews(&[
        ("PRR_1", "COMMENTED", "", earlier),
        ("PRR_4", "COMMENTED", "", earlier),
    ])]);
    let checked = world.check();
    assert_eq!(checked["settled"][0]["seen"]["echo"]["id"], "PRR_4");
    assert_eq!(kept(&checked["drafts"]), (0, 0));
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn a_lost_approval_github_dismissed_before_the_read_still_settles() {
    let world = World::connected();
    let approve = json!({"kind": "submitReview", "pull": "PR_1", "commit": oid('1'), "event": "approve", "body": "Ship it", "threads": []});
    world.github.graphql([reviews(&[]), Reply::unanswered()]);
    assert_eq!(world.write(approve)["kind"], "unknown");
    world
        .github
        .graphql([reviews(&[("PRR_7", "DISMISSED", "Ship it", &[])])]);
    let checked = world.check();
    assert_eq!(
        checked["settled"][0]["seen"]["echo"]["id"], "PRR_7",
        "{checked}"
    );

    let pending =
        json!({"kind": "submitPending", "review": "PRR_8", "event": "approve", "body": ""});
    world.github.graphql([Reply::unanswered()]);
    assert_eq!(world.write(pending)["kind"], "unknown");
    world.github.graphql([Reply::graphql(
        json!({"data": {"node": {"state": "DISMISSED"}}}),
    )]);
    let checked = world.check();
    assert_eq!(
        checked["settled"][0]["seen"]["echo"]["id"], "PRR_8",
        "{checked}"
    );
    assert_eq!(world.mutations().len(), 2);
}

#[test]
fn a_lost_reply_or_single_comment_needs_a_new_id_too() {
    let world = World::connected();
    let reply = json!({"kind": "reply", "thread": "PRRT_1", "body": "Done"});
    let anchor = json!({"kind": "reply", "thread": "PRRT_1"});
    let carried = world.draft(anchor, "Done");
    world
        .github
        .graphql([said(&[("C_1", "octo", "Done")]), Reply::unanswered()]);
    assert_eq!(
        world.wrote(&attempt(), reply, json!([carried]))["written"]["kind"],
        "unknown"
    );
    world.github.graphql([said(&[("C_1", "octo", "Done")])]);
    assert_eq!(world.check()["settled"], json!([]));

    let world = World::connected();
    let lines = json!({"path": "a.rs", "side": "right", "line": 3, "start": null});
    let single = json!({"kind": "singleComment", "pull": "PR_1", "commit": oid('1'), "lines": lines, "body": "Why?"});
    let same: &[(&str, u32, &str)] = &[("a.rs", 3, "Why?")];
    world.github.graphql([
        reviews(&[("PRR_1", "COMMENTED", "", same)]),
        Reply::unanswered(),
    ]);
    assert_eq!(world.write(single)["kind"], "unknown");
    world
        .github
        .graphql([reviews(&[("PRR_1", "COMMENTED", "", same)])]);
    assert_eq!(world.check()["settled"], json!([]));
}

#[test]
fn keep_as_draft_gives_the_words_back_marked_and_frees_the_pull_request() {
    let world = World::connected();
    let (attempt, _) = lost(&world, lgtm(), said(&[]));
    let typed = world.drafts(json!({"kind": "put", "anchor": conversation(), "head": oid('1'), "text": "LGTM again", "at": null}));
    assert_eq!(
        typed["refused"],
        json!({"kind": "sent"}),
        "its place is held"
    );

    let kept_back = world.drafts(json!({"kind": "keep", "attempt": attempt}));
    assert_eq!(kept_back["refused"], Value::Null);
    assert_eq!(kept(&kept_back), (1, 0));
    let draft = &kept_back["drafts"][0];
    assert_eq!(draft["text"], "LGTM");
    assert_eq!(draft["mayHavePosted"], true);

    let edited = world.drafts(json!({"kind": "put", "anchor": conversation(), "head": oid('1'), "text": "LGTM, thanks", "at": draft["savedAt"]}));
    assert_eq!(edited["drafts"][0]["mayHavePosted"], true, "the mark stays");
    world.github.graphql([
        said(&[]),
        answered(
            "addComment",
            json!({"commentEdge": {"node": {"id": "IC_2"}}}),
        ),
    ]);
    assert_eq!(
        world.write(lgtm())["kind"],
        "done",
        "the pull request is free"
    );
    assert_eq!(world.mutations().len(), 2);
}

#[test]
fn send_anyway_sends_nothing_when_a_read_first_shows_it_landed() {
    let world = World::connected();
    let (attempt, _) = lost(&world, lgtm(), said(&[]));
    world.github.graphql([said(&[("IC_5", "octo", "LGTM")])]);
    let again = world.send_again(&attempt);
    assert_eq!(
        again["written"],
        json!({"kind": "done", "echo": {"kind": "comment", "id": "IC_5"}})
    );
    assert_eq!(kept(&again["drafts"]), (0, 0));
    assert_eq!(
        world.mutations().len(),
        1,
        "GitHub had it, so it was not sent again"
    );
}

#[test]
fn send_anyway_sends_the_same_write_once_more_from_a_fresh_reading() {
    let world = World::connected();
    let (attempt, _) = lost(&world, lgtm(), said(&[("IC_1", "octo", "LGTM")]));
    world.github.graphql([
        said(&[("IC_1", "octo", "LGTM")]),
        said(&[("IC_1", "octo", "LGTM")]),
        Reply::unanswered(),
    ]);
    let again = world.send_again(&attempt);
    assert_eq!(again["written"]["kind"], "unknown");
    assert_eq!(again["drafts"]["sent"][0]["attempt"], attempt.as_str());
    let sent = world.mutations();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["variables"], sent[1]["variables"]);

    world
        .github
        .graphql([said(&[("IC_1", "octo", "LGTM"), ("IC_6", "octo", "LGTM")])]);
    assert_eq!(world.check()["settled"][0]["seen"]["kind"], "landed");
}

#[test]
fn a_lost_resolve_settles_from_the_thread_and_can_be_sent_again() {
    let world = World::connected();
    let resolve = json!({"kind": "resolve", "thread": "PRRT_1"});
    world.github.graphql([Reply::status(502, "<html>")]);
    assert_eq!(world.write(resolve.clone())["kind"], "unknown");
    assert_eq!(
        world.write(resolve.clone())["kind"],
        "notSent",
        "held until known"
    );

    world.github.graphql([resolved(false)]);
    let checked = world.check();
    assert_eq!(checked["settled"][0]["seen"]["kind"], "notLanded");
    assert_eq!(kept(&checked["drafts"]), (0, 0));

    world.github.graphql([Reply::unanswered(), resolved(true)]);
    assert_eq!(world.write(resolve)["kind"], "unknown");
    let checked = world.check();
    assert_eq!(
        checked["settled"][0]["seen"],
        json!({"kind": "landed", "echo": {"kind": "thread", "id": "PRRT_1", "resolved": true}})
    );
    assert_eq!(world.mutations().len(), 2);
}

#[test]
fn a_lost_merge_settles_from_whether_it_merged() {
    for (merged, seen) in [(true, "landed"), (false, "notLanded")] {
        let world = World::connected();
        let merge = json!({"kind": "merge", "pull": "PR_1", "expectedHead": oid('1'), "method": "squash", "headline": null, "body": null});
        world
            .github
            .graphql([Reply::unanswered(), pull_state(merged, true)]);
        assert_eq!(world.write(merge)["kind"], "unknown");
        assert_eq!(world.check()["settled"][0]["seen"]["kind"], seen);
    }
}

#[test]
fn a_draft_changed_since_the_window_read_it_sends_nothing() {
    let world = World::connected();
    let mut carried = world.draft(conversation(), "LGTM");
    carried["at"] = json!(carried["at"].as_u64().unwrap() - 1);
    world.github.graphql([said(&[])]);
    let wrote = world.wrote(&attempt(), lgtm(), json!([carried]));
    assert_eq!(wrote["written"]["kind"], "notSent");
    assert_eq!(kept(&wrote["drafts"]), (1, 0), "the draft is where it was");
    assert!(world.mutations().is_empty());
}

#[test]
fn what_github_refused_gives_its_drafts_back_unmarked() {
    let world = World::connected();
    let carried = world.draft(conversation(), "LGTM");
    world.github.graphql([
        said(&[]),
        Reply::graphql(json!({"data": {"addComment": null}, "errors": [
            {"type": "UNPROCESSABLE", "path": ["addComment"], "message": "Pull request is locked."},
        ]})),
    ]);
    let wrote = world.wrote(&attempt(), lgtm(), json!([carried]));
    assert_eq!(wrote["written"]["kind"], "refused");
    assert_eq!(kept(&wrote["drafts"]), (1, 0));
    assert_eq!(wrote["drafts"]["drafts"][0]["mayHavePosted"], false);
}

#[test]
fn a_read_that_fails_before_sending_sends_nothing() {
    let world = World::connected();
    let carried = world.draft(conversation(), "LGTM");
    world.github.graphql([Reply::status(502, "<html>")]);
    let wrote = world.wrote(&attempt(), lgtm(), json!([carried]));
    assert_eq!(wrote["written"]["kind"], "notSent");
    assert!(world.mutations().is_empty());
    assert_eq!(
        kept(&drafts_on(&world.host, json!({"kind": "read"}))),
        (1, 0)
    );
}
