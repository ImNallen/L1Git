use serde::{Deserialize, Serialize};

use super::CommentNode;
use crate::pulls::{Nodes, Page, login};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Thread {
    id: String,
    /// The `id` of the review that opened it.
    review: Option<String>,
    path: String,
    /// Null once the thread is outdated, and on a thread about the whole file.
    line: Option<u32>,
    start_line: Option<u32>,
    original_line: Option<u32>,
    original_start_line: Option<u32>,
    side: Side,
    outdated: bool,
    resolved: bool,
    hunk: String,
    comments: Page<Comment>,
    can: Can,
}

#[derive(Debug, Serialize)]
struct Can {
    reply: bool,
    resolve: bool,
    unresolve: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "SCREAMING_SNAKE_CASE"))]
enum Side {
    Left,
    #[serde(other)]
    Right,
}

#[derive(Debug, Serialize)]
struct Comment {
    id: String,
    by: Option<String>,
    at: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadNode {
    id: String,
    path: String,
    line: Option<u32>,
    start_line: Option<u32>,
    original_line: Option<u32>,
    original_start_line: Option<u32>,
    diff_side: Side,
    is_outdated: bool,
    is_resolved: bool,
    first: Nodes<Opening>,
    comments: Nodes<CommentNode>,
    viewer_can_reply: bool,
    viewer_can_resolve: bool,
    viewer_can_unresolve: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opening {
    diff_hunk: String,
    pull_request_review: Option<Id>,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

pub(super) fn thread(node: ThreadNode) -> Thread {
    let (hunk, review) = node
        .first
        .items()
        .next()
        .map(|opening| (opening.diff_hunk, opening.pull_request_review))
        .unwrap_or_default();
    Thread {
        id: node.id,
        review: review.map(|review| review.id),
        path: node.path,
        line: node.line,
        start_line: node.start_line,
        original_line: node.original_line,
        original_start_line: node.original_start_line,
        side: node.diff_side,
        outdated: node.is_outdated,
        resolved: node.is_resolved,
        hunk,
        comments: node.comments.page(
            |CommentNode {
                 id,
                 author,
                 at,
                 body,
             }| {
                Some(Comment {
                    id,
                    by: login(author),
                    at,
                    body,
                })
            },
        ),
        can: Can {
            reply: node.viewer_can_reply,
            resolve: node.viewer_can_resolve,
            unresolve: node.viewer_can_unresolve,
        },
    }
}
