//! Opening a pull request. Unlike a write to a pull request, it keeps no
//! record in drafts.json: a pull request that isn't open has no number to
//! keep one under. GitHub keeps at most one open pull request from a head
//! into a base and refuses a second, so a look on GitHub tells whether one
//! is open: before sending, after a refusal, and when the user checks after
//! an answer that never came.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Written;
use crate::Host;
use crate::drafts::{MOST_CHARS, NodeId};
use crate::github::{ApiError, GitHub, Login, api_failure};
use crate::graphql::Reply;
use crate::pulls::Repository;
use crate::wire::Failure;

const CONTEXT: &str = include_str!("open_context.graphql");
const CREATE: &str = include_str!("create_pull.graphql");
/// GitHub's longest title.
const TITLE_CHARS: usize = 256;
/// Pages of 100 open pull requests from one head L1 Git reads at most, so
/// 1,000 of them. Forks' branches of the same name count toward them.
const MOST_PAGES: usize = 10;
const UNKNOWN: &str = "GitHub didn't answer in time, so the pull request may already be open. L1 Git looks for it on GitHub before it sends anything again.";

/// What opening a pull request from one head needs to know first.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenContext {
    repository_id: NodeId,
    /// None for a repository without commits.
    default_branch: Option<String>,
    /// The open pull requests from the head in this repository. A fork's
    /// branch of the same name is another head.
    open: Vec<OpenPull>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenPull {
    number: u32,
    base: String,
}

/// One click on Open pull request. `repository_id` is the context's, so it
/// opens in the repository the user looked at.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Opening {
    repository_id: NodeId,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Opened {
    Done {
        number: u32,
    },
    /// GitHub already has an open pull request from the head into the base,
    /// so L1 Git opened none.
    AlreadyOpen {
        number: u32,
    },
    /// Nothing reached GitHub, so it is safe to open again.
    NotSent {
        message: String,
    },
    /// GitHub answered and opened none. The message carries GitHub's reason.
    Refused {
        message: String,
    },
    /// It left and no answer says whether GitHub opened it. Reading the
    /// context again tells.
    Unknown {
        message: String,
    },
}

#[derive(Default, Deserialize)]
struct Found {
    repository: Option<Facts>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Facts {
    id: NodeId,
    default_branch_ref: Option<Named>,
    pull_requests: Nodes,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Nodes {
    nodes: Vec<Option<Row>>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    number: u32,
    base_ref_name: String,
    is_cross_repository: bool,
}

impl OpenContext {
    fn open_into(&self, base: &str) -> Option<u32> {
        self.open
            .iter()
            .find(|pull| pull.base == base)
            .map(|pull| pull.number)
    }
}

impl Opening {
    /// What GitHub would refuse anyway, told before anything is sent.
    fn check(&self) -> Result<(), &'static str> {
        let title = self.title.trim();
        if title.is_empty() || title.chars().count() > TITLE_CHARS {
            return Err("A pull request needs a title of at most 256 characters.");
        }
        if self.body.chars().count() > MOST_CHARS {
            return Err("A description holds at most 65,536 characters.");
        }
        if self.head.trim().is_empty() || self.base.trim().is_empty() || self.head == self.base {
            return Err("A pull request merges one branch into another.");
        }
        Ok(())
    }
}

fn not_sent(message: impl Into<String>) -> Opened {
    Opened::NotSent {
        message: message.into(),
    }
}

impl Host {
    pub(crate) fn open_context(
        &self,
        repository: &Repository,
        head: &str,
    ) -> Result<OpenContext, Failure> {
        self.with_github(|github| github.open_context(repository, head))
            .map(|read| read.value)
    }

    /// Opens a pull request as `as_login` only, and sends it at most once.
    pub(crate) fn open_pull(
        &self,
        as_login: &Login,
        repository: &Repository,
        opening: &Opening,
    ) -> Opened {
        if let Err(problem) = opening.check() {
            return not_sent(format!("L1 Git sent nothing. {problem}"));
        }
        let generation = match self.signed_in_as(as_login) {
            Ok(generation) => generation,
            Err(message) => return not_sent(message),
        };
        self.as_connection(generation, |github| github.open_pull(repository, opening))
            .unwrap_or_else(|failure| not_sent(failure.message))
    }
}

impl GitHub<'_> {
    /// A read GitHub answers only in part is no read: a pull request it left
    /// out would read as none open. So is one with more pages than
    /// [`MOST_PAGES`], which answers [`ApiError::TooLarge`].
    fn open_context(&self, repository: &Repository, head: &str) -> Result<OpenContext, ApiError> {
        let (owner, repo) = repository.names();
        let mut variables = json!({"owner": owner, "repo": repo, "head": head});
        let mut context: Option<OpenContext> = None;
        for _ in 0..MOST_PAGES {
            let Reply { data, withheld } = self.graphql::<Found>(CONTEXT, variables.clone())?;
            let facts = match data.repository {
                Some(facts) if withheld.is_empty() => facts,
                _ => return Err(withheld.explain("repository", repository.to_string())),
            };
            let read = context.get_or_insert_with(|| OpenContext {
                repository_id: facts.id.clone(),
                default_branch: facts.default_branch_ref.map(|named| named.name),
                open: Vec::new(),
            });
            // Each page names the repository it is from.
            if facts.id != read.repository_id {
                return Err(ApiError::Unexpected);
            }
            let Nodes { nodes, page_info } = facts.pull_requests;
            read.open.extend(
                nodes
                    .into_iter()
                    .flatten()
                    .filter(|row| !row.is_cross_repository)
                    .map(|row| OpenPull {
                        number: row.number,
                        base: row.base_ref_name,
                    }),
            );
            if !page_info.has_next_page {
                return context.ok_or(ApiError::Unexpected);
            }
            let Some(cursor) = page_info.end_cursor else {
                return Err(ApiError::Unexpected);
            };
            variables["after"] = json!(cursor);
        }
        Err(ApiError::TooLarge)
    }

    fn open_pull(&self, repository: &Repository, opening: &Opening) -> Opened {
        let context = match self.open_context(repository, &opening.head) {
            Ok(context) => context,
            Err(ApiError::Unauthorized) => return not_sent(self.signed_out().message),
            Err(ApiError::TooLarge) => {
                return not_sent(format!(
                    "More than 1,000 pull requests are open on GitHub from a branch named {}, forks' included, which is more than L1 Git reads, so it can't tell whether one is open into {} and sent nothing. Open the pull request on GitHub.",
                    opening.head, opening.base
                ));
            }
            Err(error) => {
                return not_sent(format!(
                    "L1 Git could not look for an open pull request first, so it sent nothing. {}",
                    api_failure(error).message
                ));
            }
        };
        if context.repository_id != opening.repository_id {
            return not_sent(format!(
                "{repository} is another repository on GitHub than the one L1 Git read, so it sent nothing. Open the pull request again."
            ));
        }
        if let Some(number) = context.open_into(&opening.base) {
            return Opened::AlreadyOpen { number };
        }
        let written = self.mutate(
            CREATE,
            "createPullRequest",
            json!({
                "repositoryId": opening.repository_id, "baseRefName": opening.base,
                "headRefName": opening.head, "title": opening.title.trim(), "body": opening.body,
                "draft": opening.draft,
            }),
            |payload| {
                payload
                    .pointer("/pullRequest/number")
                    .and_then(Value::as_u64)
                    .and_then(|number| u32::try_from(number).ok())
            },
        );
        self.opened(repository, opening, written)
    }

    /// A refusal may be GitHub's one open pull request per head and base, so
    /// a look tells. Nothing here sends again.
    fn opened(
        &self,
        repository: &Repository,
        opening: &Opening,
        written: Written<Option<u32>>,
    ) -> Opened {
        let open = || {
            self.open_context(repository, &opening.head)
                .ok()
                .and_then(|context| context.open_into(&opening.base))
        };
        match written {
            Written::Done { echo: Some(number) } => Opened::Done { number },
            Written::Done { echo: None } => match open() {
                Some(number) => Opened::Done { number },
                None => Opened::Unknown {
                    message: UNKNOWN.to_owned(),
                },
            },
            Written::NotSent { message } => Opened::NotSent { message },
            Written::Refused { message } => match open() {
                Some(number) => Opened::AlreadyOpen { number },
                None => Opened::Refused { message },
            },
            Written::Unknown { .. } => Opened::Unknown {
                message: UNKNOWN.to_owned(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::writes::send::judge;

    fn number(payload: &Value) -> Option<u32> {
        payload
            .pointer("/pullRequest/number")
            .and_then(Value::as_u64)
            .and_then(|number| u32::try_from(number).ok())
    }

    /// GitHub keeps one open pull request per head and base, and answers a
    /// second with a typed error in place of the payload. That is a refusal,
    /// never an unknown, so sending again after it can't open a second.
    #[test]
    fn github_refuses_a_second_open_pull_request_from_a_head_into_a_base() {
        let answer = json!({
            "data": {"createPullRequest": null},
            "errors": [{
                "type": "UNPROCESSABLE",
                "path": ["createPullRequest"],
                "locations": [{"line": 2, "column": 3}],
                "message": "A pull request already exists for octo:feature.",
            }],
        });
        let written = judge(answer.to_string().as_bytes(), "createPullRequest", number);
        assert_eq!(
            written,
            Written::Refused {
                message: "GitHub didn't do it: A pull request already exists for octo:feature."
                    .to_owned()
            }
        );
        let done = json!({"data": {"createPullRequest": {"pullRequest": {"number": 42}}}});
        assert_eq!(
            judge(done.to_string().as_bytes(), "createPullRequest", number),
            Written::Done { echo: Some(42) }
        );
    }

    #[test]
    fn an_opening_github_would_refuse_is_told_before_sending() {
        let opening = |title: &str, head: &str, base: &str| Opening {
            repository_id: NodeId::try_from("R_1".to_owned()).unwrap(),
            base: base.to_owned(),
            head: head.to_owned(),
            title: title.to_owned(),
            body: String::new(),
            draft: false,
        };
        assert!(opening("Fix it", "fix", "main").check().is_ok());
        assert!(opening(" \n", "fix", "main").check().is_err());
        assert!(opening(&"x".repeat(257), "fix", "main").check().is_err());
        assert!(opening("Fix it", "main", "main").check().is_err());
        assert!(opening("Fix it", "", "main").check().is_err());
        let long = Opening {
            body: "x".repeat(MOST_CHARS + 1),
            ..opening("Fix it", "fix", "main")
        };
        assert!(long.check().is_err());
    }
}
