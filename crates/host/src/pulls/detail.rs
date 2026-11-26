use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    Actor, CHECKS, CheckState, Label, Mergeability, Nodes, Page, Repository, State, items, login,
};
use crate::github::{ApiError, GitHub};
use crate::graphql::Reply;

const DETAIL: &str = include_str!("detail.graphql");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    number: u32,
    title: String,
    /// Markdown.
    body: String,
    state: State,
    author: Option<String>,
    viewer_is_author: bool,
    viewer_permission: Permission,
    base: String,
    base_oid: String,
    head: Head,
    labels: Page<Label>,
    additions: u32,
    deletions: u32,
    changed_files: u32,
    created_at: String,
    updated_at: String,
    reviewers: Vec<Reviewer>,
    /// None when this sign-in cannot read them.
    checks: Option<Page<Check>>,
    /// The newest 100, oldest first, as is `timeline`.
    commits: Page<Commit>,
    timeline: Page<Event>,
    /// None when GitHub could only answer without them.
    threads: Option<Page<Thread>>,
    mergeable: Mergeability,
    merge_state: MergeState,
}

/// The viewer's role in the base repository. GitHub names none for a
/// GitHub App's sign-in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "SCREAMING_SNAKE_CASE"))]
enum Permission {
    Admin,
    Maintain,
    Write,
    Triage,
    Read,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Head {
    branch: String,
    oid: String,
    /// None when the fork is gone.
    repository: Option<Repository>,
    cross_repository: bool,
    maintainer_can_modify: bool,
}

#[derive(Debug, Serialize)]
struct Reviewer {
    /// None for a team, whose name needs a scope that the browser sign-in does
    /// not ask for.
    login: Option<String>,
    state: ReviewState,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "SCREAMING_SNAKE_CASE"))]
enum ReviewState {
    #[serde(skip_deserializing)]
    Requested,
    Approved,
    ChangesRequested,
    Dismissed,
    #[serde(other)]
    Commented,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "SCREAMING_SNAKE_CASE"))]
enum MergeState {
    Behind,
    Blocked,
    Clean,
    Dirty,
    HasHooks,
    Unstable,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    name: String,
    state: CheckState,
    required: bool,
    started_at: Option<String>,
    completed_at: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Serialize)]
struct Commit {
    oid: String,
    headline: String,
    by: Option<String>,
    at: String,
}

#[derive(Debug, Serialize)]
struct Event {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
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

#[derive(Default, Deserialize)]
struct Answer {
    repository: Option<Found>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Found {
    viewer_permission: Option<Permission>,
    pull_request: Option<Node>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    number: u32,
    title: String,
    body: String,
    is_draft: bool,
    merged_at: Option<String>,
    closed_at: Option<String>,
    created_at: String,
    updated_at: String,
    author: Option<Actor>,
    viewer_did_author: bool,
    additions: u32,
    deletions: u32,
    changed_files: u32,
    labels: Option<Nodes<Label>>,
    base_ref_name: String,
    base_ref_oid: String,
    head_ref_name: String,
    head_ref_oid: String,
    is_cross_repository: bool,
    maintainer_can_modify: bool,
    head_repository: Option<HeadRepository>,
    mergeable: Mergeability,
    merge_state_status: MergeState,
    review_requests: Option<Nodes<ReviewRequest>>,
    latest_reviews: Option<Nodes<Review>>,
    latest_opinionated_reviews: Option<Nodes<Review>>,
    status_check_rollup: Option<Rollup>,
    commits: Nodes<PullCommit>,
    timeline_items: Nodes<Item>,
    review_threads: Option<Nodes<ThreadNode>>,
}

#[derive(Deserialize)]
struct HeadRepository {
    name: String,
    owner: Actor,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRequest {
    requested_reviewer: Option<Requested>,
}

#[derive(Deserialize)]
struct Requested {
    login: Option<String>,
}

#[derive(Deserialize)]
struct Review {
    author: Option<Actor>,
    state: ReviewState,
}

#[derive(Deserialize)]
struct Rollup {
    contexts: Nodes<RollupContext>,
}

#[derive(Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
enum RollupContext {
    CheckRun {
        name: String,
        status: String,
        conclusion: Option<String>,
        started_at: Option<String>,
        completed_at: Option<String>,
        is_required: bool,
        url: Option<String>,
    },
    StatusContext {
        context: String,
        state: String,
        is_required: bool,
        url: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize)]
struct PullCommit {
    commit: GitCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    oid: String,
    message_headline: String,
    committed_date: String,
    author: Option<GitActor>,
}

#[derive(Deserialize)]
struct GitActor {
    name: Option<String>,
    user: Option<Actor>,
}

#[derive(Deserialize)]
struct Oid {
    oid: String,
}

#[derive(Deserialize)]
struct Act {
    id: String,
    author: Option<Actor>,
    at: String,
}

#[derive(Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
enum Item {
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

#[derive(Deserialize)]
struct CommentNode {
    id: String,
    author: Option<Actor>,
    at: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadNode {
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

impl GitHub<'_> {
    pub(crate) fn pull_request(
        &self,
        repository: &Repository,
        number: u32,
    ) -> Result<PullRequest, ApiError> {
        match self.ask_pull_request(repository, number, true) {
            // GitHub runs out of time over a pull request with many threads, and
            // says so in any of these ways.
            Err(
                ApiError::Status(502 | 504) | ApiError::Unfinished { .. } | ApiError::Unexpected,
            ) => self.ask_pull_request(repository, number, false),
            answer => answer,
        }
    }

    fn ask_pull_request(
        &self,
        repository: &Repository,
        number: u32,
        threads: bool,
    ) -> Result<PullRequest, ApiError> {
        let Repository { owner, repo } = repository;
        let Reply {
            data: Answer { repository: found },
            withheld,
        } = self.graphql(
            DETAIL,
            json!({"owner": owner, "repo": repo, "number": number, "threads": threads}),
        )?;
        let Some(found) = found else {
            return Err(withheld.explain("repository", repository.to_string()));
        };
        let Some(node) = found.pull_request else {
            let what = format!("pull request #{number} in {repository}");
            return Err(withheld.explain("repository", what));
        };
        let permission = found.viewer_permission.unwrap_or(Permission::Unknown);
        Ok(parse(node, permission, withheld.field(CHECKS)))
    }
}

fn parse(node: Node, viewer_permission: Permission, checks_withheld: bool) -> PullRequest {
    PullRequest {
        reviewers: reviewers(
            node.author.as_ref(),
            node.latest_reviews,
            node.latest_opinionated_reviews,
            node.review_requests,
        ),
        number: node.number,
        title: node.title,
        body: node.body,
        state: State::new(node.is_draft, node.merged_at, node.closed_at),
        author: login(node.author),
        viewer_is_author: node.viewer_did_author,
        viewer_permission,
        base: node.base_ref_name,
        base_oid: node.base_ref_oid,
        head: Head {
            branch: node.head_ref_name,
            oid: node.head_ref_oid,
            repository: node
                .head_repository
                .and_then(|head| Repository::parse(&format!("{}/{}", head.owner.login, head.name))),
            cross_repository: node.is_cross_repository,
            maintainer_can_modify: node.maintainer_can_modify,
        },
        labels: node
            .labels
            .map_or_else(Page::empty, |labels| labels.page(Some)),
        additions: node.additions,
        deletions: node.deletions,
        changed_files: node.changed_files,
        created_at: node.created_at,
        updated_at: node.updated_at,
        checks: match node.status_check_rollup {
            Some(rollup) => Some(rollup.contexts.page(check)),
            None => (!checks_withheld).then(Page::empty),
        },
        commits: node.commits.page(|pull| Some(commit(pull.commit))),
        timeline: node.timeline_items.page(event),
        threads: node
            .review_threads
            .map(|threads| threads.page(|thread| Some(self::thread(thread)))),
        mergeable: node.mergeable,
        merge_state: node.merge_state_status,
    }
}

/// A verdict outlasts a later comment, and a new request outlasts both. The
/// author's own replies do not make them a reviewer.
fn reviewers(
    author: Option<&Actor>,
    latest: Option<Nodes<Review>>,
    verdicts: Option<Nodes<Review>>,
    requests: Option<Nodes<ReviewRequest>>,
) -> Vec<Reviewer> {
    let mut people = items(latest)
        .chain(items(verdicts))
        .filter_map(|review| Some((login(review.author)?, review.state)))
        .filter(|(login, _)| author.is_none_or(|author| &author.login != login))
        .collect::<BTreeMap<_, _>>();
    let mut teams = Vec::new();
    for request in items(requests) {
        match request.requested_reviewer.and_then(|found| found.login) {
            Some(login) => {
                people.insert(login, ReviewState::Requested);
            }
            None => teams.push(Reviewer {
                login: None,
                state: ReviewState::Requested,
            }),
        }
    }
    people
        .into_iter()
        .map(|(login, state)| Reviewer {
            login: Some(login),
            state,
        })
        .chain(teams)
        .collect()
}

fn check(context: RollupContext) -> Option<Check> {
    match context {
        RollupContext::CheckRun {
            name,
            status,
            conclusion,
            started_at,
            completed_at,
            is_required,
            url,
        } => Some(Check {
            name,
            state: CheckState::from_github(conclusion.as_deref().unwrap_or(&status)),
            required: is_required,
            started_at,
            completed_at,
            url,
        }),
        RollupContext::StatusContext {
            context,
            state,
            is_required,
            url,
        } => Some(Check {
            name: context,
            state: CheckState::from_github(&state),
            required: is_required,
            started_at: None,
            completed_at: None,
            url,
        }),
        RollupContext::Unknown => None,
    }
}

fn commit(commit: GitCommit) -> Commit {
    Commit {
        oid: commit.oid,
        headline: commit.message_headline,
        by: commit
            .author
            .and_then(|author| login(author.user).or(author.name)),
        at: commit.committed_date,
    }
}

fn event(item: Item) -> Option<Event> {
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

fn thread(node: ThreadNode) -> Thread {
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
    }
}
