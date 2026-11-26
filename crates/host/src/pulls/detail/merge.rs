use serde::{Deserialize, Serialize};

/// What the repository lets a merge do, as GitHub would offer it to the viewer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Merge {
    allowed: Allowed,
    preferred: Method,
    /// GitHub deletes the head branch itself once the pull request merges.
    deletes_branch: bool,
}

#[derive(Debug, Serialize)]
struct Allowed {
    merge: bool,
    squash: bool,
    rebase: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "SCREAMING_SNAKE_CASE"))]
enum Method {
    Squash,
    Rebase,
    /// Also a method GitHub adds later, since a merge commit is GitHub's own default.
    #[serde(other)]
    Merge,
}

/// The repository's settings, read beside the pull request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Settings {
    merge_commit_allowed: bool,
    squash_merge_allowed: bool,
    rebase_merge_allowed: bool,
    viewer_default_merge_method: Method,
    delete_branch_on_merge: bool,
}

impl From<Settings> for Merge {
    fn from(settings: Settings) -> Merge {
        Merge {
            allowed: Allowed {
                merge: settings.merge_commit_allowed,
                squash: settings.squash_merge_allowed,
                rebase: settings.rebase_merge_allowed,
            },
            preferred: settings.viewer_default_merge_method,
            deletes_branch: settings.delete_branch_on_merge,
        }
    }
}

/// The head branch as it stands on GitHub.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HeadRef {
    id: String,
    /// Open pull requests other than this one whose head is this branch. Ones
    /// based on it are not counted.
    others_open: u32,
    viewer_can_delete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RefNode {
    id: String,
    associated_pull_requests: Count,
}

#[derive(Deserialize)]
struct Count {
    #[serde(rename = "totalCount")]
    total: u32,
}

impl HeadRef {
    /// GitHub counts this pull request among the branch's own while it is open.
    pub(super) fn new(node: RefNode, open: bool, viewer_can_delete: bool) -> HeadRef {
        HeadRef {
            id: node.id,
            others_open: node
                .associated_pull_requests
                .total
                .saturating_sub(u32::from(open)),
            viewer_can_delete,
        }
    }
}
