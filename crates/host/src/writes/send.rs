use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Echo, Event, Method, Write, Written, not_sent, refused, unknown};
use crate::drafts::{Lines, Side};
use crate::github::{ApiError, GitHub, api_failure};
use crate::graphql::gave_up;

const ADD_REVIEW: &str = include_str!("add_review.graphql");
const SUBMIT_REVIEW: &str = include_str!("submit_review.graphql");
const REPLY: &str = include_str!("reply.graphql");
const RESOLVE: &str = include_str!("resolve.graphql");
const UNRESOLVE: &str = include_str!("unresolve.graphql");
const COMMENT: &str = include_str!("comment.graphql");
const MERGE: &str = include_str!("merge.graphql");

impl GitHub<'_> {
    /// Sends `write` once. Its outcome is final.
    pub(super) fn write(&self, write: &Write) -> Written {
        match write {
            Write::SingleComment {
                pull,
                commit,
                lines,
                body,
            } => self.mutate(
                ADD_REVIEW,
                "addPullRequestReview",
                json!({
                    "pullRequestId": pull, "commitOID": commit, "event": "COMMENT",
                    "threads": [thread(lines, body)],
                }),
                review,
            ),
            Write::SubmitReview {
                pull,
                commit,
                event,
                body,
                threads,
            } => self.mutate(
                ADD_REVIEW,
                "addPullRequestReview",
                json!({
                    "pullRequestId": pull, "commitOID": commit, "event": event.github(), "body": body,
                    "threads": threads.iter().map(|each| thread(&each.lines, &each.body)).collect::<Vec<_>>(),
                }),
                review,
            ),
            Write::SubmitPending {
                review: id,
                event,
                body,
            } => self.mutate(
                SUBMIT_REVIEW,
                "submitPullRequestReview",
                json!({"pullRequestReviewId": id, "event": event.github(), "body": body}),
                review,
            ),
            Write::Reply { thread, body } => self.mutate(
                REPLY,
                "addPullRequestReviewThreadReply",
                json!({"pullRequestReviewThreadId": thread, "body": body}),
                |payload| Echo::Comment {
                    id: text_at(payload, "/comment/id"),
                },
            ),
            Write::Resolve { thread } => self.mutate(
                RESOLVE,
                "resolveReviewThread",
                json!({"threadId": thread}),
                resolved,
            ),
            Write::Unresolve { thread } => self.mutate(
                UNRESOLVE,
                "unresolveReviewThread",
                json!({"threadId": thread}),
                resolved,
            ),
            Write::Comment { pull, body } => self.mutate(
                COMMENT,
                "addComment",
                json!({"subjectId": pull, "body": body}),
                |payload| Echo::Comment {
                    id: text_at(payload, "/commentEdge/node/id"),
                },
            ),
            Write::Merge {
                pull,
                expected_head,
                method,
                headline,
                body,
            } => self.mutate(
                MERGE,
                "mergePullRequest",
                drop_nulls(json!({
                    "pullRequestId": pull, "expectedHeadOid": expected_head, "mergeMethod": method.github(),
                    "commitHeadline": headline, "commitBody": body,
                })),
                |payload| Echo::Merged {
                    commit: text_at(payload, "/pullRequest/mergeCommit/oid"),
                },
            ),
            Write::DeleteHeadBranch {
                pull,
                branch,
                expected_head,
            } => self.delete_head_branch(pull, branch, expected_head),
        }
    }

    /// One POST of one mutation. Its outcome is final.
    pub(super) fn mutate<E>(
        &self,
        document: &str,
        field: &str,
        input: Value,
        echo: fn(&Value) -> E,
    ) -> Written<E> {
        let Ok(url) = self.url("graphql") else {
            return not_sent("L1 Git could not make GitHub's address, so it sent nothing.");
        };
        let request = self
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .body(json!({"query": document, "variables": {"input": input}}).to_string());
        match self.send(request) {
            Ok((_, body)) => judge(&body, field, echo),
            Err(error) => self.missed(error),
        }
    }

    /// What a failed send says about whether GitHub did it.
    fn missed<E>(&self, error: ApiError) -> Written<E> {
        match error {
            ApiError::Ended => not_sent("L1 Git's GitHub sign-in changed, so it sent nothing."),
            ApiError::Unreachable => not_sent(api_failure(error).message),
            ApiError::Unauthorized => refused(self.signed_out().message),
            ApiError::Status(400..=499)
            | ApiError::RateLimited { .. }
            | ApiError::Forbidden { .. }
            | ApiError::SsoRequired { .. }
            | ApiError::NotFound { .. } => refused(api_failure(error).message),
            ApiError::Status(_)
            | ApiError::Unanswered
            | ApiError::TooLarge
            | ApiError::Unfinished { .. }
            | ApiError::Unexpected => unknown(),
        }
    }
}

/// A payload means GitHub did it, whatever else the answer says. GraphQL
/// answers a query that doesn't parse or validate with errors that point into
/// the query and no `data` at all, before it runs anything, so that is a
/// refusal. Otherwise only typed errors are refusals; GitHub leaves untyped
/// what it failed at, such as a timeout.
pub(super) fn judge<E>(body: &[u8], field: &str, echo: fn(&Value) -> E) -> Written<E> {
    #[derive(Deserialize)]
    struct Problem {
        #[serde(rename = "type")]
        kind: Option<String>,
        message: String,
        #[serde(default)]
        locations: Vec<Value>,
        #[serde(default)]
        path: Vec<Value>,
        extensions: Option<Extensions>,
    }
    #[derive(Deserialize)]
    struct Extensions {
        code: Option<String>,
    }
    let Ok(Value::Object(answer)) = serde_json::from_slice::<Value>(body) else {
        return unknown();
    };
    if let Some(payload) = answer
        .get("data")
        .and_then(|data| data.get(field))
        .filter(|payload| payload.is_object())
    {
        return Written::Done {
            echo: echo(payload),
        };
    }
    let errors = answer
        .get("errors")
        .cloned()
        .and_then(|errors| serde_json::from_value::<Vec<Problem>>(errors).ok())
        .unwrap_or_default();
    let typed = |problem: &Problem| problem.kind.as_deref().is_some_and(|kind| !gave_up(kind));
    // GitHub's validation errors name a place in the document, which starts
    // with the operation. Any other path is in the answer, so the field ran.
    let in_document = |problem: &Problem| match problem.path.first() {
        None => true,
        Some(Value::String(first)) => first.split(' ').next() == Some("mutation"),
        Some(_) => false,
    };
    let in_query = |problem: &Problem| {
        problem.kind.is_none()
            && in_document(problem)
            && (!problem.locations.is_empty()
                || problem
                    .extensions
                    .as_ref()
                    .is_some_and(|extensions| extensions.code.is_some()))
    };
    let never_ran = !answer.contains_key("data") && errors.iter().all(in_query);
    match errors.first() {
        Some(first) if never_ran || errors.iter().all(typed) => {
            refused(format!("GitHub didn't do it: {}", first.message))
        }
        _ => unknown(),
    }
}

fn thread(lines: &Lines, body: &str) -> Value {
    drop_nulls(json!({
        "path": lines.path, "line": lines.line, "side": side(lines.side), "body": body,
        "startLine": lines.start.map(|start| start.line),
        "startSide": lines.start.map(|start| side(start.side)),
    }))
}

pub(super) fn side(side: Side) -> &'static str {
    match side {
        Side::Left => "LEFT",
        Side::Right => "RIGHT",
    }
}

impl Event {
    pub(super) fn github(self) -> &'static str {
        match self {
            Event::Comment => "COMMENT",
            Event::Approve => "APPROVE",
            Event::RequestChanges => "REQUEST_CHANGES",
        }
    }
}

impl Method {
    fn github(self) -> &'static str {
        match self {
            Method::Merge => "MERGE",
            Method::Squash => "SQUASH",
            Method::Rebase => "REBASE",
        }
    }
}

/// In GraphQL a field given null is set to null. Only one left out takes
/// GitHub's default.
pub(super) fn drop_nulls(mut input: Value) -> Value {
    if let Some(fields) = input.as_object_mut() {
        fields.retain(|_, value| !value.is_null());
    }
    input
}

pub(super) fn text_at(payload: &Value, pointer: &str) -> Option<String> {
    payload
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn review(payload: &Value) -> Echo {
    Echo::Review {
        id: text_at(payload, "/pullRequestReview/id"),
    }
}

fn resolved(payload: &Value) -> Echo {
    Echo::Thread {
        id: text_at(payload, "/thread/id"),
        resolved: payload
            .pointer("/thread/isResolved")
            .and_then(Value::as_bool),
    }
}
