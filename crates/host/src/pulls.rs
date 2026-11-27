//! What the pull request screens read, in L1 Git's own words. The GraphQL
//! documents and the shapes they answer in stay in `list` and `detail`.

mod detail;
mod list;

use std::fmt;

use serde::{Deserialize, Serialize};

pub use detail::PullRequest;
pub use list::{PullRequestList, PullRequests};

/// The same shape a snapshot's remotes carry. Both names go into search
/// queries, so neither can hold a space or a quote.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Repository {
    owner: Name,
    repo: Name,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(try_from = "String")]
struct Name(String);

impl TryFrom<String> for Name {
    type Error = String;

    fn try_from(value: String) -> Result<Name, String> {
        let valid = !value.is_empty()
            && value != "."
            && value != ".."
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
        if valid {
            Ok(Name(value))
        } else {
            Err(format!(
                "{value:?} is not part of a GitHub repository's name."
            ))
        }
    }
}

impl fmt::Display for Repository {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.owner.0, self.repo.0)
    }
}

impl Repository {
    fn parse(name_with_owner: &str) -> Option<Repository> {
        let (owner, repo) = name_with_owner.split_once('/')?;
        Some(Repository {
            owner: Name::try_from(owner.to_owned()).ok()?,
            repo: Name::try_from(repo.to_owned()).ok()?,
        })
    }

    fn is_named(&self, name_with_owner: &str) -> bool {
        self.to_string().eq_ignore_ascii_case(name_with_owner)
    }
}

/// A list GitHub may cut short or leave entries out of. `total` is GitHub's
/// own count, so `items` is incomplete whenever it is shorter.
#[derive(Debug, Serialize)]
pub struct Page<T> {
    items: Vec<T>,
    total: u32,
}

impl<T> Page<T> {
    fn empty() -> Page<T> {
        Page {
            items: Vec::new(),
            total: 0,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum State {
    Open { draft: bool },
    Merged { at: String },
    Closed { at: String },
}

impl State {
    fn new(draft: bool, merged_at: Option<String>, closed_at: Option<String>) -> State {
        match (merged_at, closed_at) {
            (Some(at), _) => State::Merged { at },
            (None, Some(at)) => State::Closed { at },
            (None, None) => State::Open { draft },
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Label {
    name: String,
    /// Six hex digits.
    color: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "SCREAMING_SNAKE_CASE"))]
enum Mergeability {
    Mergeable,
    Conflicting,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "SCREAMING_SNAKE_CASE"))]
enum Review {
    Approved,
    ChangesRequested,
    /// Also a decision GitHub adds later, so it never looks like an approval.
    #[serde(other)]
    Required,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum CheckState {
    Passed,
    Failed,
    Skipped,
    Running,
}

impl CheckState {
    /// Reads a check run's state, status or conclusion and a commit status's
    /// state, which share their spellings. Like gh, a state GitHub adds later
    /// counts as running, so it never looks like a pass.
    fn from_github(state: &str) -> CheckState {
        match state {
            "SUCCESS" => CheckState::Passed,
            "NEUTRAL" | "SKIPPED" => CheckState::Skipped,
            "ACTION_REQUIRED" | "CANCELLED" | "ERROR" | "FAILURE" | "STARTUP_FAILURE"
            | "TIMED_OUT" => CheckState::Failed,
            _ => CheckState::Running,
        }
    }
}

/// The field GitHub withholds from a token that may not read checks.
const CHECKS: &str = "statusCheckRollup";

#[derive(Deserialize)]
struct Actor {
    login: String,
}

/// GitHub answers null for a deleted account.
fn login(actor: Option<Actor>) -> Option<String> {
    actor.map(|actor| actor.login)
}

/// GitHub answers null for an entry this sign-in cannot read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Nodes<T> {
    #[serde(default)]
    total_count: u32,
    nodes: Option<Vec<Option<T>>>,
}

impl<T> Nodes<T> {
    fn items(self) -> impl Iterator<Item = T> {
        self.nodes.into_iter().flatten().flatten()
    }

    fn page<U>(self, parse: impl FnMut(T) -> Option<U>) -> Page<U> {
        Page {
            total: self.total_count,
            items: self.items().filter_map(parse).collect(),
        }
    }
}

fn items<T>(nodes: Option<Nodes<T>>) -> impl Iterator<Item = T> {
    nodes.into_iter().flat_map(Nodes::items)
}
