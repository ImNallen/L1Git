use serde::{Deserialize, Serialize};

use crate::pulls::{Nodes, Page};

/// The viewer's review that is started on GitHub and not yet submitted. Only
/// its author can see one, so GitHub answers no one else's.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Pending {
    None,
    /// GitHub left it out, so there may be one.
    Unknown,
    Review {
        id: String,
        comments: Page<PendingComment>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct PendingComment {
    path: String,
}

#[derive(Deserialize)]
pub(super) struct ReviewNode {
    id: String,
    comments: Nodes<PendingComment>,
}

impl Pending {
    pub(super) fn new(reviews: Option<Nodes<ReviewNode>>) -> Pending {
        let Some(reviews) = reviews else {
            return Pending::Unknown;
        };
        let total = reviews.total_count;
        match reviews.items().next() {
            Some(review) => Pending::Review {
                id: review.id,
                comments: review.comments.page(Some),
            },
            None if total == 0 => Pending::None,
            None => Pending::Unknown,
        }
    }
}
