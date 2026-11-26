//! The only way L1 Git changes anything on GitHub. One `Write` is one click.
//! Its mutation leaves at most once, and `Written` says whether GitHub has it.
//! Unlike the detail read, nothing here asks again: a write sent twice can
//! land twice.

mod branch;
mod evidence;
mod ledger;
mod send;
#[cfg(all(test, unix))]
mod tests;

use serde::{Deserialize, Serialize};

use crate::drafts::{AttemptId, Lines, MOST_CHARS, NodeId, Oid, PullDrafts};

pub(crate) use ledger::Lanes;

const UNKNOWN: &str = "L1 Git sent this to GitHub and got no answer it could read, so GitHub may or may not have done it. L1 Git looks again each time it reads this pull request.";

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Thread {
    lines: Lines,
    body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Event {
    Comment,
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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

/// A write's answer, with what the pull request's drafts and writes hold
/// after it, when L1 Git got as far as reading them.
#[derive(Debug, Serialize)]
pub struct Wrote {
    written: Written,
    drafts: Option<PullDrafts>,
}

impl Wrote {
    fn alone(written: Written) -> Wrote {
        Wrote {
            written,
            drafts: None,
        }
    }
}

/// What a read showed of the writes whose outcome was unknown. The ones it
/// could not tell about are still in `drafts.sent`.
#[derive(Debug, Serialize)]
pub struct Checked {
    settled: Vec<Settled>,
    drafts: PullDrafts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settled {
    attempt: AttemptId,
    write: Write,
    seen: Seen,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Seen {
    /// GitHub has it: a read shows what it made.
    Landed { echo: Echo },
    /// A read shows GitHub hasn't done it. Only a write GitHub can do twice
    /// without harm, such as resolve or merge, settles this way; it can be
    /// sent again.
    NotLanded { message: String },
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
                    && match event {
                        Event::Approve => true,
                        Event::Comment => said(body) || !threads.is_empty(),
                        Event::RequestChanges => said(body),
                    },
                "A review needs a summary or a comment, Request changes needs a summary, and each holds at most 65,536 characters.",
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
