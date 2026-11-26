//! The only way L1 Git changes anything on GitHub. One `Write` is one click.
//! Its mutation leaves at most once, and `Written` says whether GitHub has it.
//! Unlike the detail read, nothing here asks again: a write sent twice can
//! land twice.

mod branch;
#[cfg(all(test, unix))]
mod tests;

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::Host;
use crate::drafts::{Lines, MOST_CHARS, NodeId, Oid, Side};
use crate::github::{ApiError, GitHub, Login, api_failure};
use crate::graphql::gave_up;

const ADD_REVIEW: &str = include_str!("writes/add_review.graphql");
const SUBMIT_REVIEW: &str = include_str!("writes/submit_review.graphql");
const REPLY: &str = include_str!("writes/reply.graphql");
const RESOLVE: &str = include_str!("writes/resolve.graphql");
const UNRESOLVE: &str = include_str!("writes/unresolve.graphql");
const COMMENT: &str = include_str!("writes/comment.graphql");
const MERGE: &str = include_str!("writes/merge.graphql");
const DELETE_REF: &str = include_str!("writes/delete_ref.graphql");

const UNKNOWN: &str = "L1 Git sent this to GitHub and got no answer it could read, so GitHub may or may not have done it. L1 Git reads the pull request again to find out.";

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Write {
    /// Add single comment. GitHub's reference does not say that a thread added
    /// by pull request id posts at once, so this is a review of one thread.
    SingleComment {
        pull: NodeId,
        commit: Oid,
        lines: Lines,
        body: String,
    },
    /// Finish review: the summary, the verdict and every thread at once, so
    /// the author gets one notification.
    SubmitReview {
        pull: NodeId,
        commit: Oid,
        event: Event,
        body: String,
        threads: Vec<Thread>,
    },
    /// The review the viewer started on github.com, as it is there.
    SubmitPending {
        review: NodeId,
        event: Event,
        body: String,
    },
    Reply {
        thread: NodeId,
        body: String,
    },
    Resolve {
        thread: NodeId,
    },
    Unresolve {
        thread: NodeId,
    },
    /// A comment on the conversation.
    Comment {
        pull: NodeId,
        body: String,
    },
    /// GitHub merges only while the head is `expected_head`. A null headline
    /// or body is GitHub's own.
    Merge {
        pull: NodeId,
        expected_head: Oid,
        method: Method,
        headline: Option<String>,
        body: Option<String>,
    },
    /// After a merge: deletes `branch` on GitHub only while it is still at
    /// `expected_head` and no open pull request has it as head or base.
    DeleteHeadBranch {
        pull: NodeId,
        branch: String,
        expected_head: Oid,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Thread {
    lines: Lines,
    body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Event {
    Comment,
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Written {
    Done {
        echo: Echo,
    },
    /// Nothing reached GitHub, so it is safe to send again.
    NotSent {
        message: String,
    },
    /// GitHub answered and did not do it. The message carries GitHub's reason.
    Refused {
        message: String,
    },
    /// It left and no answer says whether GitHub did it. Only a read can.
    Unknown {
        message: String,
    },
}

/// What GitHub says it made, by its own ids.
#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Echo {
    Review {
        id: Option<String>,
    },
    Comment {
        id: Option<String>,
    },
    Thread {
        id: Option<String>,
        resolved: Option<bool>,
    },
    Merged {
        commit: Option<String>,
    },
    BranchDeleted {},
}

fn not_sent(message: impl Into<String>) -> Written {
    Written::NotSent {
        message: message.into(),
    }
}

fn refused(message: impl Into<String>) -> Written {
    Written::Refused {
        message: message.into(),
    }
}

fn unknown() -> Written {
    Written::Unknown {
        message: UNKNOWN.to_owned(),
    }
}

impl Write {
    /// What GitHub would refuse anyway, told before anything is sent.
    fn check(&self) -> Result<(), &'static str> {
        let fits = |text: &str| text.chars().count() <= MOST_CHARS;
        let said = |text: &str| !text.trim().is_empty() && fits(text);
        let (ok, problem) = match self {
            Write::SingleComment { body, .. }
            | Write::Reply { body, .. }
            | Write::Comment { body, .. } => (
                said(body),
                "A comment needs words, and holds at most 65,536 characters.",
            ),
            Write::SubmitReview {
                event,
                body,
                threads,
                ..
            } => (
                fits(body)
                    && threads.iter().all(|thread| said(&thread.body))
                    && (*event != Event::Comment || said(body) || !threads.is_empty()),
                "A review needs a summary or a comment, and each holds at most 65,536 characters.",
            ),
            Write::SubmitPending { body, .. } => {
                (fits(body), "A summary holds at most 65,536 characters.")
            }
            Write::Merge { headline, body, .. } => (
                headline.as_deref().is_none_or(said) && body.as_deref().is_none_or(fits),
                "A merge commit needs a headline, and its message holds at most 65,536 characters.",
            ),
            Write::DeleteHeadBranch { branch, .. } => {
                (!branch.trim().is_empty(), "A branch needs a name.")
            }
            Write::Resolve { .. } | Write::Unresolve { .. } => (true, ""),
        };
        if ok { Ok(()) } else { Err(problem) }
    }
}

impl Host {
    /// Sent only as `as_login`, so a click made for one account never posts
    /// as another.
    pub(crate) fn write(&self, as_login: &Login, write: Write) -> Written {
        if let Err(problem) = write.check() {
            return not_sent(format!("L1 Git sent nothing. {problem}"));
        }
        let Some((generation, login)) = self.connection() else {
            return not_sent(
                "L1 Git is not connected to GitHub, so it sent nothing. Sign in from Settings › Hosts.",
            );
        };
        if login != *as_login {
            return not_sent(format!(
                "L1 Git is signed in to GitHub as {login}, not {as_login}, so it sent nothing."
            ));
        }
        self.as_connection(generation, |github| github.write(write))
            .unwrap_or_else(|failure| not_sent(failure.message))
    }
}

impl GitHub<'_> {
    fn write(&self, write: Write) -> Written {
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
                    "threads": [thread(&lines, &body)],
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
            } => self.delete_head_branch(&pull, &branch, &expected_head),
        }
    }

    /// One POST of one mutation. Its outcome is final.
    fn mutate(
        &self,
        document: &str,
        field: &str,
        input: Value,
        echo: fn(&Value) -> Echo,
    ) -> Written {
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
    fn missed(&self, error: ApiError) -> Written {
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

/// A payload means GitHub did it, whatever else the answer says. Without one,
/// only typed errors are refusals; GitHub leaves untyped what it failed at.
fn judge(body: &[u8], field: &str, echo: fn(&Value) -> Echo) -> Written {
    #[derive(Deserialize)]
    struct Answered {
        data: Option<Map<String, Value>>,
        #[serde(default)]
        errors: Vec<Problem>,
    }
    #[derive(Deserialize)]
    struct Problem {
        #[serde(rename = "type")]
        kind: Option<String>,
        message: String,
    }
    let Ok(Answered { data, errors }) = serde_json::from_slice::<Answered>(body) else {
        return unknown();
    };
    if let Some(payload) = data
        .as_ref()
        .and_then(|data| data.get(field))
        .filter(|payload| payload.is_object())
    {
        return Written::Done {
            echo: echo(payload),
        };
    }
    let typed = |problem: &Problem| problem.kind.as_deref().is_some_and(|kind| !gave_up(kind));
    match errors.first() {
        Some(first) if errors.iter().all(typed) => {
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

fn side(side: Side) -> &'static str {
    match side {
        Side::Left => "LEFT",
        Side::Right => "RIGHT",
    }
}

impl Event {
    fn github(self) -> &'static str {
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
fn drop_nulls(mut input: Value) -> Value {
    if let Some(fields) = input.as_object_mut() {
        fields.retain(|_, value| !value.is_null());
    }
    input
}

fn text_at(payload: &Value, pointer: &str) -> Option<String> {
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
