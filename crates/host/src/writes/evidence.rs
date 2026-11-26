//! What a read shows of a write whose answer was lost. A write that would
//! post twice counts as landed only on an id that was not there before it
//! left, made by the viewer, with its words and threads. Seeing nothing never
//! means it didn't land. A write GitHub can do twice without harm settles
//! from state either way.

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::{Value, json};

use super::{Echo, Event, Seen, Write, Written, not_sent};
use crate::drafts::Lines;
use crate::github::{ApiError, GitHub, Login, api_failure};
use crate::graphql::Reply;

const COMMENTS: &str = include_str!("seen_comments.graphql");
const THREAD: &str = include_str!("seen_thread.graphql");
const REVIEWS: &str = include_str!("seen_reviews.graphql");
const REVIEW: &str = include_str!("seen_review.graphql");
const PULL: &str = include_str!("seen_pull.graphql");

#[derive(Deserialize)]
struct Found<T> {
    node: Option<T>,
}

impl<T> Default for Found<T> {
    fn default() -> Found<T> {
        Found { node: None }
    }
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<Option<T>>,
}

impl<T> Nodes<T> {
    fn all(self) -> impl Iterator<Item = T> {
        self.nodes.into_iter().flatten()
    }
}

#[derive(Deserialize)]
struct Said {
    id: String,
    author: Option<Author>,
    body: String,
}

#[derive(Deserialize)]
struct Author {
    login: String,
}

#[derive(Deserialize)]
struct Conversation {
    comments: Nodes<Said>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    is_resolved: bool,
    comments: Nodes<Said>,
}

#[derive(Deserialize)]
struct Reviews {
    reviews: Nodes<Review>,
}

#[derive(Deserialize)]
struct Review {
    id: String,
    state: String,
    body: String,
    comments: Nodes<LineComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineComment {
    path: String,
    line: Option<u32>,
    original_line: Option<u32>,
    start_line: Option<u32>,
    original_start_line: Option<u32>,
    body: String,
}

#[derive(Deserialize)]
struct ReviewState {
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullState {
    merged: bool,
    merge_commit: Option<Commit>,
    head_ref: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct Commit {
    oid: String,
}

/// GitHub may store line endings and outer spaces other than as typed.
fn same_text(a: &str, b: &str) -> bool {
    let plain = |text: &str| text.replace("\r\n", "\n").replace('\r', "\n");
    plain(a).trim() == plain(b).trim()
}

/// A review dismissed since it landed, as a push dismissing stale approvals
/// does, still shows that it landed.
fn is_verdict(state: &str, event: Event) -> bool {
    state == "DISMISSED"
        || state
            == match event {
                Event::Comment => "COMMENTED",
                Event::Approve => "APPROVED",
                Event::RequestChanges => "CHANGES_REQUESTED",
            }
}

impl LineComment {
    /// GitHub keeps the line a comment was made on as `original*`, and moves
    /// `line` along with later commits.
    fn is(&self, lines: &Lines, body: &str) -> bool {
        let on = |line: Option<u32>, original: Option<u32>, want: u32| {
            line == Some(want) || original == Some(want)
        };
        self.path == lines.path.as_str()
            && on(self.line, self.original_line, lines.line.get())
            && lines
                .start
                .is_none_or(|start| on(self.start_line, self.original_start_line, start.line.get()))
            && same_text(&self.body, body)
    }
}

impl Review {
    /// Exactly these threads, in any order.
    fn holds(self, threads: &[(&Lines, &str)]) -> bool {
        let mut left: Vec<LineComment> = self.comments.all().collect();
        left.len() == threads.len()
            && threads.iter().all(|(lines, body)| {
                let found = left.iter().position(|comment| comment.is(lines, body));
                found.map(|index| left.swap_remove(index)).is_some()
            })
    }
}

impl GitHub<'_> {
    /// A read GitHub failed at in any part is no reading: what it left out
    /// would read as nothing there.
    fn node<T: for<'de> Deserialize<'de>>(
        &self,
        query: &str,
        variables: Value,
    ) -> Result<Option<T>, ApiError> {
        let Reply { data, withheld } = self.graphql::<Found<T>>(query, variables)?;
        if withheld.is_empty() {
            Ok(data.node)
        } else {
            Err(withheld.explain("node", "what this write names".to_owned()))
        }
    }

    fn reviews(&self, pull: &str, login: &Login) -> Result<Vec<Review>, ApiError> {
        let found = self.node::<Reviews>(REVIEWS, json!({"id": pull, "login": login}))?;
        Ok(found.map_or_else(Vec::new, |found| found.reviews.all().collect()))
    }

    fn conversation(&self, pull: &str) -> Result<Vec<Said>, ApiError> {
        let found = self.node::<Conversation>(COMMENTS, json!({"id": pull}))?;
        Ok(found.map_or_else(Vec::new, |found| found.comments.all().collect()))
    }

    fn replies(&self, thread: &str) -> Result<Vec<Said>, ApiError> {
        let found = self.node::<Thread>(THREAD, json!({"id": thread}))?;
        Ok(found.map_or_else(Vec::new, |found| found.comments.all().collect()))
    }

    /// The ids already where `write`'s result would appear, read just before
    /// it leaves. A write GitHub can do twice without harm needs none.
    pub(super) fn before(&self, write: &Write, login: &Login) -> Result<Vec<String>, ApiError> {
        let ids = |said: Vec<Said>| said.into_iter().map(|said| said.id).collect();
        Ok(match write {
            Write::Comment { pull, .. } => ids(self.conversation(pull.as_str())?),
            Write::Reply { thread, .. } => ids(self.replies(thread.as_str())?),
            Write::SingleComment { pull, .. } | Write::SubmitReview { pull, .. } => self
                .reviews(pull.as_str(), login)?
                .into_iter()
                .map(|review| review.id)
                .collect(),
            _ => Vec::new(),
        })
    }

    /// What a read shows of `write` now, or `None` when it shows nothing that
    /// tells.
    pub(super) fn seen(
        &self,
        write: &Write,
        before: &[String],
        login: &Login,
    ) -> Result<Option<Seen>, ApiError> {
        let new = |id: &str| !before.iter().any(|known| known == id);
        let landed = |echo: Echo| Some(Seen::Landed { echo });
        let not_landed = |message: String| Some(Seen::NotLanded { message });
        let posted = |said: Vec<Said>, body: &str| {
            said.into_iter()
                .find(|said| {
                    new(&said.id)
                        && said
                            .author
                            .as_ref()
                            .is_some_and(|author| author.login.eq_ignore_ascii_case(login.as_str()))
                        && same_text(&said.body, body)
                })
                .and_then(|said| landed(Echo::Comment { id: Some(said.id) }))
        };
        let reviewed = |pull: &str, event: Event, body: &str, threads: &[(&Lines, &str)]| {
            Ok::<_, ApiError>(self.reviews(pull, login)?.into_iter().find_map(|review| {
                let id = review.id.clone();
                (new(&id)
                    && is_verdict(&review.state, event)
                    && same_text(&review.body, body)
                    && review.holds(threads))
                .then_some(Seen::Landed {
                    echo: Echo::Review { id: Some(id) },
                })
            }))
        };
        Ok(match write {
            Write::Comment { pull, body } => posted(self.conversation(pull.as_str())?, body),
            Write::Reply { thread, body } => posted(self.replies(thread.as_str())?, body),
            Write::SingleComment {
                pull, lines, body, ..
            } => reviewed(pull.as_str(), Event::Comment, "", &[(lines, body)])?,
            Write::SubmitReview {
                pull,
                event,
                body,
                threads,
                ..
            } => {
                let threads: Vec<_> = threads
                    .iter()
                    .map(|thread| (&thread.lines, thread.body.as_str()))
                    .collect();
                reviewed(pull.as_str(), *event, body, &threads)?
            }
            Write::SubmitPending { review, event, .. } => self
                .node::<ReviewState>(REVIEW, json!({"id": review}))?
                .filter(|found| is_verdict(&found.state, *event))
                .and_then(|_| {
                    landed(Echo::Review {
                        id: Some(review.as_str().to_owned()),
                    })
                }),
            Write::Resolve { thread } | Write::Unresolve { thread } => {
                let resolved = matches!(write, Write::Resolve { .. });
                match self.node::<Thread>(THREAD, json!({"id": thread})) {
                    Ok(Some(found)) if found.is_resolved == resolved => landed(Echo::Thread {
                        id: Some(thread.as_str().to_owned()),
                        resolved: Some(resolved),
                    }),
                    Ok(Some(_)) if resolved => {
                        not_landed("GitHub hasn't resolved this thread.".to_owned())
                    }
                    Ok(Some(_)) => not_landed("GitHub hasn't unresolved this thread.".to_owned()),
                    Ok(None) | Err(ApiError::NotFound { .. }) => {
                        not_landed("This thread is gone from GitHub.".to_owned())
                    }
                    Err(error) => return Err(error),
                }
            }
            Write::Merge { pull, .. } => match self.node::<PullState>(PULL, json!({"id": pull}))? {
                Some(PullState {
                    merged: true,
                    merge_commit,
                    ..
                }) => landed(Echo::Merged {
                    commit: merge_commit.map(|commit| commit.oid),
                }),
                Some(_) => not_landed("GitHub hasn't merged this pull request.".to_owned()),
                None => None,
            },
            Write::DeleteHeadBranch { pull, branch, .. } => {
                match self.node::<PullState>(PULL, json!({"id": pull}))? {
                    Some(PullState { head_ref: None, .. }) => landed(Echo::BranchDeleted {}),
                    Some(_) => not_landed(format!("{branch} is still on GitHub.")),
                    None => None,
                }
            }
        })
    }

    /// For a read that had to come before sending and failed.
    pub(super) fn unread(&self, error: ApiError) -> Written {
        match error {
            ApiError::Unauthorized => not_sent(self.signed_out().message),
            error => not_sent(format!(
                "L1 Git could not read the pull request first, so it sent nothing. {}",
                api_failure(error).message
            )),
        }
    }
}
