//! Words typed where a write holds the place wait in drafts.json, so closing
//! the window can't lose them, until the write ends.

#![cfg(unix)]

#[allow(dead_code)]
mod support;
#[allow(dead_code)]
mod writing;

use serde_json::{Value, json};
use support::Reply;
use writing::{World, attempt, drafts_on, oid, said};

fn conversation() -> Value {
    json!({"kind": "conversation"})
}

fn put(world: &World, text: &str, at: &Value) -> Value {
    world.drafts(
        json!({"kind": "put", "anchor": conversation(), "head": oid('1'), "text": text, "at": at}),
    )
}

/// Saves `typed`, sends it, and GitHub never answers. Answers the `savedAt`
/// it was sent at.
fn lost(world: &World, typed: &str) -> Value {
    let carried = world.draft(conversation(), typed);
    world.github.graphql([said(&[]), Reply::unanswered()]);
    let write = json!({"kind": "comment", "pull": "PR_1", "body": typed});
    let wrote = world.wrote(&attempt(), write, json!([carried]));
    assert_eq!(wrote["written"]["kind"], "unknown", "{wrote}");
    carried["at"].clone()
}

fn texts(answer: &Value, field: &str) -> Vec<String> {
    answer[field]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| each["text"].as_str().unwrap().to_owned())
        .collect()
}

/// Another window types on "A B" while a write carries "A B C", and the
/// write is kept as a draft. Answers what the keep left.
fn both(world: &World) -> Value {
    let older = world.draft(conversation(), "A B")["at"].clone();
    let typed = put(world, "A B C", &older);
    let sent = typed["drafts"][0]["savedAt"].clone();
    world.github.graphql([said(&[]), Reply::unanswered()]);
    let carried = json!({"anchor": conversation(), "head": oid('1'), "at": sent});
    let write = json!({"kind": "comment", "pull": "PR_1", "body": "A B C"});
    let attempt = attempt();
    assert_eq!(
        world.wrote(&attempt, write, json!([carried]))["written"]["kind"],
        "unknown"
    );

    let waited = put(world, "A B X", &older);
    assert_eq!(waited["refused"], json!({"kind": "sent"}));
    assert_eq!(texts(&waited, "waiting"), ["A B X"]);
    let closed = drafts_on(&world.restarted(), json!({"kind": "read"}));
    assert_eq!(
        texts(&closed, "waiting"),
        ["A B X"],
        "a close loses nothing"
    );
    assert_eq!(closed["waiting"][0]["on"], older);
    world.drafts(json!({"kind": "keep", "attempt": attempt}))
}

#[test]
fn words_typed_on_an_older_draft_wait_on_disk_and_stay_beside_what_the_write_gives_back() {
    let world = World::connected();
    let back = both(&world);
    assert_eq!(texts(&back, "drafts"), ["A B C"]);
    assert_eq!(texts(&back, "waiting"), ["A B X"], "both stay to pick from");

    let forgot =
        world.drafts(json!({"kind": "forget", "anchor": conversation(), "head": oid('1')}));
    assert_eq!(texts(&forgot, "drafts"), ["A B C"]);
    assert_eq!(texts(&forgot, "waiting"), Vec::<String>::new());
}

#[test]
fn saving_at_a_place_ends_the_words_that_waited_there() {
    let world = World::connected();
    let back = both(&world);
    let mine = put(&world, "A B X", &back["drafts"][0]["savedAt"]);
    assert_eq!(mine["refused"], Value::Null);
    assert_eq!(texts(&mine, "drafts"), ["A B X"]);
    assert_eq!(texts(&mine, "waiting"), Vec::<String>::new());
}

#[test]
fn words_typed_on_the_draft_a_write_carried_save_over_what_it_gives_back() {
    let world = World::connected();
    let sent = lost(&world, "A B C");
    assert_eq!(
        put(&world, "A B C X", &sent)["refused"],
        json!({"kind": "sent"})
    );
    let kept = world.drafts(json!({"kind": "keep", "attempt": world.drafts(json!({"kind": "read"}))["sent"][0]["attempt"]}));
    assert_eq!(texts(&kept, "drafts"), ["A B C X"]);
    assert_eq!(kept["drafts"][0]["mayHavePosted"], true);
    assert_eq!(texts(&kept, "waiting"), Vec::<String>::new());
}

#[test]
fn words_typed_on_the_draft_a_write_posted_become_a_new_draft() {
    let world = World::connected();
    let sent = lost(&world, "A B C");
    put(&world, "A B C X", &sent);
    world.github.graphql([said(&[("IC_1", "octo", "A B C")])]);
    let checked = world.check();
    assert_eq!(checked["settled"][0]["seen"]["kind"], "landed");
    assert_eq!(texts(&checked["drafts"], "drafts"), ["A B C X"]);
    assert_eq!(checked["drafts"]["drafts"][0]["mayHavePosted"], false);
    assert_eq!(texts(&checked["drafts"], "waiting"), Vec::<String>::new());
}
