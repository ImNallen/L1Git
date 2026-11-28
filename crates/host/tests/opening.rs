#![cfg(unix)]

#[allow(dead_code)]
mod support;
#[allow(dead_code)]
mod writing;

use serde_json::{Value, json};
use support::Reply;
use writing::{World, answered};

/// The repository's id, default branch and open pull requests from the head:
/// number, base, and whether the head is a fork's.
fn context(open: &[(u32, &str, bool)]) -> Reply {
    page(open, None)
}

/// One page of the context, followed by another at `next` when there is one.
fn page(open: &[(u32, &str, bool)], next: Option<&str>) -> Reply {
    let nodes: Vec<Value> = open
        .iter()
        .map(|(number, base, fork)| {
            json!({"number": number, "baseRefName": base, "isCrossRepository": fork})
        })
        .collect();
    Reply::graphql(json!({"data": {"repository": {
        "id": "R_1", "defaultBranchRef": {"name": "main"}, "pullRequests": {
            "nodes": nodes, "pageInfo": {"hasNextPage": next.is_some(), "endCursor": next},
        },
    }}}))
}

/// A page of 100 forks' pull requests from a branch of the same name.
fn forks(first: u32, next: &str) -> Reply {
    let open: Vec<(u32, &str, bool)> = (first..first + 100)
        .map(|number| (number, "main", true))
        .collect();
    page(&open, Some(next))
}

fn opening() -> Value {
    json!({"repositoryId": "R_1", "base": "main", "head": "fix", "title": " Fix it ", "body": "Start at a.rs.", "draft": false})
}

fn open_as(world: &World, login: &str, open: Value) -> Value {
    let reply = world.send(json!({
        "op": "openPull", "asLogin": login, "repository": {"owner": "octo", "repo": "app"}, "open": open,
    }));
    assert_eq!(reply["op"], "openPull", "{reply}");
    reply["data"].clone()
}

fn open(world: &World) -> Value {
    open_as(world, "octo", opening())
}

fn read_context(world: &World) -> Value {
    world.send(json!({"op": "openPullContext", "repository": {"owner": "octo", "repo": "app"}, "head": "fix"}))
}

fn created(number: u32) -> Reply {
    answered(
        "createPullRequest",
        json!({"pullRequest": {"number": number}}),
    )
}

fn duplicate() -> Reply {
    Reply::graphql(json!({"data": {"createPullRequest": null}, "errors": [{
        "type": "UNPROCESSABLE",
        "path": ["createPullRequest"],
        "locations": [{"line": 2, "column": 3}],
        "message": "A pull request already exists for octo:fix.",
    }]}))
}

#[test]
fn the_context_names_the_repository_and_the_pull_requests_open_from_the_head_in_it() {
    let world = World::connected();
    world.github.graphql([context(&[
        (4, "main", false),
        (9, "main", true),
        (5, "release", false),
    ])]);
    let reply = read_context(&world);
    assert_eq!(
        reply["data"],
        json!({"repositoryId": "R_1", "defaultBranch": "main", "open": [
            {"number": 4, "base": "main"},
            {"number": 5, "base": "release"},
        ]}),
        "a fork's branch of the same name is another head"
    );
    let asked = &world.github.questions()[0];
    assert_eq!(
        asked["variables"],
        json!({"owner": "octo", "repo": "app", "head": "fix"})
    );
    assert!(world.mutations().is_empty());
}

/// Forks' pull requests from a branch of the same name fill pages too, so the
/// one from this repository can be on a later page.
#[test]
fn the_context_reads_every_page_of_pull_requests_open_from_the_head() {
    let world = World::connected();
    world
        .github
        .graphql([forks(100, "page-2"), page(&[(7, "main", false)], None)]);
    assert_eq!(open(&world), json!({"kind": "alreadyOpen", "number": 7}));
    assert!(world.mutations().is_empty());
    let asked = world.github.questions();
    assert_eq!(asked.len(), 2);
    assert_eq!(
        asked[1]["variables"],
        json!({"owner": "octo", "repo": "app", "head": "fix", "after": "page-2"})
    );

    world
        .github
        .graphql([forks(100, "page-2"), page(&[(7, "main", false)], None)]);
    assert_eq!(
        read_context(&world)["data"]["open"],
        json!([{"number": 7, "base": "main"}])
    );
}

/// L1 Git reads at most ten pages. A head with more can't show that none is
/// open, so nothing is sent.
#[test]
fn a_context_past_the_last_page_l1_git_reads_is_no_context() {
    let world = World::connected();
    let pages = || (0..10).map(|n| forks(100 * (n + 1), &format!("page-{}", n + 2)));
    world.github.graphql(pages());
    let opened = open(&world);
    assert_eq!(opened["kind"], "notSent", "{opened}");
    assert!(
        opened["message"].as_str().unwrap().starts_with(
            "More than 1,000 pull requests are open on GitHub from a branch named fix,"
        ),
        "{opened}"
    );
    assert!(world.mutations().is_empty());
    assert_eq!(world.github.questions().len(), 10, "it stops at ten pages");

    world.github.graphql(pages());
    assert_eq!(read_context(&world)["error"]["kind"], "gitHubFailed");
}

#[test]
fn a_context_github_answers_only_in_part_is_no_context() {
    let world = World::connected();
    world.github.graphql([Reply::graphql(json!({
        "data": {"repository": {"id": "R_1", "defaultBranchRef": null, "pullRequests": {
            "nodes": [null], "pageInfo": {"hasNextPage": false, "endCursor": null},
        }}},
        "errors": [{"type": "FORBIDDEN", "path": ["repository", "pullRequests", "nodes", 0], "message": "No."}],
    }))]);
    assert_eq!(read_context(&world)["error"]["kind"], "gitHubFailed");
}

#[test]
fn opening_looks_first_then_sends_create_pull_request_once() {
    let world = World::connected();
    world
        .github
        .graphql([context(&[(5, "release", false)]), created(12)]);
    assert_eq!(open(&world), json!({"kind": "done", "number": 12}));
    let sent = world.mutations();
    assert_eq!(sent.len(), 1, "one mutation, never a second");
    assert!(
        sent[0]["query"]
            .as_str()
            .unwrap()
            .contains("createPullRequest(input: $input)")
    );
    assert_eq!(
        sent[0]["variables"],
        json!({"input": {
            "repositoryId": "R_1", "baseRefName": "main", "headRefName": "fix",
            "title": "Fix it", "body": "Start at a.rs.", "draft": false,
        }})
    );
}

#[test]
fn a_draft_is_opened_as_a_draft() {
    let world = World::connected();
    world.github.graphql([context(&[]), created(13)]);
    let mut draft = opening();
    draft["draft"] = json!(true);
    assert_eq!(
        open_as(&world, "octo", draft),
        json!({"kind": "done", "number": 13})
    );
    assert_eq!(world.mutations()[0]["variables"]["input"]["draft"], true);
}

#[test]
fn a_pull_request_already_open_from_the_head_into_the_base_sends_nothing() {
    let world = World::connected();
    world.github.graphql([context(&[(7, "main", false)])]);
    assert_eq!(open(&world), json!({"kind": "alreadyOpen", "number": 7}));
    assert!(world.mutations().is_empty());
}

#[test]
fn github_refusing_a_second_pull_request_is_already_open() {
    let world = World::connected();
    world
        .github
        .graphql([context(&[]), duplicate(), context(&[(8, "main", false)])]);
    assert_eq!(open(&world), json!({"kind": "alreadyOpen", "number": 8}));
    assert_eq!(
        world.mutations().len(),
        1,
        "it looked, and sent nothing more"
    );
}

#[test]
fn a_refusal_with_nothing_open_keeps_github_s_words() {
    let world = World::connected();
    world.github.graphql([
        context(&[]),
        Reply::graphql(json!({"data": {"createPullRequest": null}, "errors": [{
            "type": "UNPROCESSABLE", "path": ["createPullRequest"],
            "message": "No commits between main and fix.",
        }]})),
        context(&[]),
    ]);
    let opened = open(&world);
    assert_eq!(opened["kind"], "refused");
    assert!(
        opened["message"]
            .as_str()
            .unwrap()
            .contains("No commits between main and fix."),
        "{opened}"
    );
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn an_opening_github_never_answered_is_unknown_until_the_context_shows_it() {
    let world = World::connected();
    world.github.graphql([context(&[]), Reply::unanswered()]);
    let opened = open(&world);
    assert_eq!(opened["kind"], "unknown");
    assert!(
        opened["message"]
            .as_str()
            .unwrap()
            .starts_with("GitHub didn't answer in time"),
        "{opened}"
    );
    assert_eq!(world.mutations().len(), 1, "never sent again on its own");

    world.github.graphql([context(&[(14, "main", false)])]);
    assert_eq!(
        read_context(&world)["data"]["open"],
        json!([{"number": 14, "base": "main"}]),
        "checking GitHub is the context again"
    );
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn sending_again_after_an_unknown_opening_that_landed_opens_nothing() {
    let world = World::connected();
    world.github.graphql([context(&[]), Reply::unanswered()]);
    assert_eq!(open(&world)["kind"], "unknown");
    world.github.graphql([context(&[(14, "main", false)])]);
    assert_eq!(open(&world), json!({"kind": "alreadyOpen", "number": 14}));
    assert_eq!(world.mutations().len(), 1);
}

#[test]
fn a_look_that_fails_sends_nothing() {
    let world = World::connected();
    world
        .github
        .graphql([Reply::status(502, "<html>"), created(1)]);
    let opened = open(&world);
    assert_eq!(opened["kind"], "notSent", "{opened}");
    assert!(world.mutations().is_empty());
}

#[test]
fn another_repository_under_the_name_sends_nothing() {
    let world = World::connected();
    world
        .github
        .graphql([Reply::graphql(json!({"data": {"repository": {
            "id": "R_2", "defaultBranchRef": {"name": "main"}, "pullRequests": {
                "nodes": [], "pageInfo": {"hasNextPage": false, "endCursor": null},
            },
        }}}))]);
    assert_eq!(open(&world)["kind"], "notSent");
    assert!(world.mutations().is_empty());
}

#[test]
fn an_opening_for_another_account_or_without_a_title_sends_nothing() {
    let world = World::connected();
    let opened = open_as(&world, "hubot", opening());
    assert_eq!(opened["kind"], "notSent");
    assert!(
        opened["message"]
            .as_str()
            .unwrap()
            .contains("as octo, not hubot")
    );
    let mut untitled = opening();
    untitled["title"] = json!("  ");
    assert_eq!(open_as(&world, "octo", untitled)["kind"], "notSent");
    world.send(json!({"op": "disconnect"}));
    assert_eq!(open(&world)["kind"], "notSent");
    assert!(world.github.questions().is_empty());
}

#[test]
fn opening_keeps_no_record_on_this_computer() {
    let world = World::connected();
    world.github.graphql([context(&[]), created(3)]);
    assert_eq!(open(&world)["kind"], "done");
    assert!(
        !world.dir.path().join("drafts.json").exists(),
        "a pull request that isn't open has no number to keep a record under"
    );
}
