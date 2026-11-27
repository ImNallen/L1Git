use serde::{Deserialize, Serialize};

use super::{CommentNode, Commit, GitCommit, ReviewState, commit};
use crate::pulls::{Actor, login};

#[derive(Debug, Serialize)]
pub(super) struct Event {
    id: String,
    by: Option<String>,
    at: String,
    #[serde(flatten)]
    what: What,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum What {
    Commit {
        oid: String,
        headline: String,
    },
    Review {
        state: ReviewState,
        body: String,
    },
    Comment {
        body: String,
    },
    ForcePushed {
        from: Option<String>,
        to: Option<String>,
    },
    Merged {
        oid: Option<String>,
    },
    Closed,
    Reopened,
    BranchDeleted,
    ReadyForReview,
    ConvertedToDraft,
}

#[derive(Deserialize)]
pub(super) struct Oid {
    pub(super) oid: String,
}

#[derive(Deserialize)]
pub(super) struct Act {
    id: String,
    author: Option<Actor>,
    at: String,
}

#[derive(Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
pub(super) enum Item {
    PullRequestCommit {
        id: String,
        commit: GitCommit,
    },
    PullRequestReview {
        id: String,
        author: Option<Actor>,
        submitted_at: Option<String>,
        state: ReviewState,
        body: String,
    },
    IssueComment(CommentNode),
    HeadRefForcePushedEvent {
        id: String,
        author: Option<Actor>,
        at: String,
        before_commit: Option<Oid>,
        after_commit: Option<Oid>,
    },
    MergedEvent {
        id: String,
        author: Option<Actor>,
        at: String,
        commit: Option<Oid>,
    },
    ClosedEvent(Act),
    ReopenedEvent(Act),
    HeadRefDeletedEvent(Act),
    ReadyForReviewEvent(Act),
    ConvertToDraftEvent(Act),
    #[serde(other)]
    Unknown,
}

pub(super) fn event(item: Item) -> Option<Event> {
    let act = |Act { id, author, at }: Act, what| Event {
        id,
        by: login(author),
        at,
        what,
    };
    Some(match item {
        Item::PullRequestCommit { id, commit: node } => {
            let Commit {
                oid,
                headline,
                by,
                at,
            } = commit(node);
            Event {
                id,
                by,
                at,
                what: What::Commit { oid, headline },
            }
        }
        // Only a review the viewer has not submitted yet has no time.
        Item::PullRequestReview {
            id,
            author,
            submitted_at,
            state,
            body,
        } => Event {
            id,
            by: login(author),
            at: submitted_at?,
            what: What::Review { state, body },
        },
        Item::IssueComment(CommentNode {
            id,
            author,
            at,
            body,
        }) => Event {
            id,
            by: login(author),
            at,
            what: What::Comment { body },
        },
        Item::HeadRefForcePushedEvent {
            id,
            author,
            at,
            before_commit,
            after_commit,
        } => Event {
            id,
            by: login(author),
            at,
            what: What::ForcePushed {
                from: before_commit.map(|commit| commit.oid),
                to: after_commit.map(|commit| commit.oid),
            },
        },
        Item::MergedEvent {
            id,
            author,
            at,
            commit,
        } => Event {
            id,
            by: login(author),
            at,
            what: What::Merged {
                oid: commit.map(|commit| commit.oid),
            },
        },
        Item::ClosedEvent(event) => act(event, What::Closed),
        Item::ReopenedEvent(event) => act(event, What::Reopened),
        Item::HeadRefDeletedEvent(event) => act(event, What::BranchDeleted),
        Item::ReadyForReviewEvent(event) => act(event, What::ReadyForReview),
        Item::ConvertToDraftEvent(event) => act(event, What::ConvertedToDraft),
        Item::Unknown => return None,
    })
}
