use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    Actor, CHECKS, CheckState, Label, Mergeability, Nodes, Page, Repository, State, login,
};
use crate::github::{ApiError, GitHub};
use crate::graphql::Reply;
use crate::state::unix_secs;

/// `mergeStateStatus` stays out of `row.graphql`. On 50 rows it runs into
/// GitHub's ten-second limit.
const OPEN: &str = concat!(include_str!("open.graphql"), include_str!("row.graphql"));
const MERGED: &str = concat!(include_str!("merged.graphql"), include_str!("row.graphql"));
const RECENT_DAYS: u64 = 7;

/// Newest change first, up to 50 rows.
pub type PullRequests = Page<Summary>;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestList {
    Open,
    RecentlyMerged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    number: u32,
    title: String,
    state: State,
    author: Option<String>,
    viewer_is_author: bool,
    head: String,
    base: String,
    labels: Page<Label>,
    comments: u32,
    /// From the viewer, or from a team they are on.
    review_requested: bool,
    /// None when nothing asks for a review and nobody has left a verdict.
    review: Option<Review>,
    /// None when this sign-in cannot read them.
    checks: Option<CheckCounts>,
    mergeable: Mergeability,
    additions: u32,
    deletions: u32,
    created_at: String,
    updated_at: String,
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

#[derive(Debug, Default, Serialize)]
struct CheckCounts {
    passed: u32,
    failed: u32,
    skipped: u32,
    running: u32,
}

#[derive(Default, Deserialize)]
struct Open {
    repository: Option<OpenRepository>,
    requested: Option<Nodes<Numbered>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRepository {
    name_with_owner: String,
    pull_requests: Nodes<Row>,
}

#[derive(Default, Deserialize)]
struct Merged {
    repository: Option<Named>,
    merged: Option<Nodes<Row>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Named {
    name_with_owner: String,
}

#[derive(Deserialize)]
struct Numbered {
    number: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    number: u32,
    title: String,
    is_draft: bool,
    merged_at: Option<String>,
    closed_at: Option<String>,
    head_ref_name: String,
    base_ref_name: String,
    created_at: String,
    updated_at: String,
    additions: u32,
    deletions: u32,
    mergeable: Mergeability,
    review_decision: Option<Review>,
    total_comments_count: Option<u32>,
    viewer_did_author: bool,
    author: Option<Actor>,
    labels: Option<Nodes<Label>>,
    latest_opinionated_reviews: Option<Nodes<Opinion>>,
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Opinion {
    state: String,
}

#[derive(Deserialize)]
struct Rollup {
    contexts: Contexts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contexts {
    check_run_counts_by_state: Option<Vec<StateCount>>,
    status_context_counts_by_state: Option<Vec<StateCount>>,
}

#[derive(Deserialize)]
struct StateCount {
    state: String,
    count: u32,
}

impl GitHub<'_> {
    pub(crate) fn pull_requests(
        &self,
        repository: &Repository,
        list: PullRequestList,
    ) -> Result<PullRequests, ApiError> {
        let (name, page) = self.list(repository, list)?;
        if repository.is_named(&name) {
            return Ok(page);
        }
        // GraphQL follows a rename, but search silently finds nothing under
        // the old name.
        let current = Repository::parse(&name).ok_or(ApiError::Unexpected)?;
        Ok(self.list(&current, list)?.1)
    }

    /// The page, and the name the repository goes by now.
    fn list(
        &self,
        repository: &Repository,
        list: PullRequestList,
    ) -> Result<(String, PullRequests), ApiError> {
        match list {
            PullRequestList::Open => self.open(repository),
            PullRequestList::RecentlyMerged => self.recently_merged(repository),
        }
    }

    fn open(&self, repository: &Repository) -> Result<(String, PullRequests), ApiError> {
        let Repository { owner, repo } = repository;
        let requested =
            format!("repo:{repository} is:pr is:open review-requested:@me sort:updated-desc");
        let Reply {
            data: Open {
                repository: found,
                requested,
            },
            withheld,
        } = self.graphql(
            OPEN,
            json!({"owner": owner, "repo": repo, "requested": requested}),
        )?;
        let Some(found) = found else {
            return Err(withheld.explain("repository", repository.to_string()));
        };
        if found.pull_requests.nodes.is_none() {
            return Err(
                withheld.explain("repository", format!("the pull requests in {repository}"))
            );
        }
        // Without the requests every row would say that nobody waits for the
        // viewer's review.
        let requested = requested
            .filter(|_| !withheld.field("requested"))
            .and_then(|search| search.nodes);
        let Some(requested) = requested else {
            return Err(
                withheld.explain("requested", format!("the review requests in {repository}"))
            );
        };
        let requested = requested
            .into_iter()
            .flatten()
            .map(|pull| pull.number)
            .collect();
        let checks_withheld = withheld.field(CHECKS);
        let page = found
            .pull_requests
            .page(|row| Some(summary(row, &requested, checks_withheld)));
        Ok((found.name_with_owner, page))
    }

    fn recently_merged(&self, repository: &Repository) -> Result<(String, PullRequests), ApiError> {
        let Repository { owner, repo } = repository;
        let since = day(unix_secs().saturating_sub(RECENT_DAYS * 86_400));
        let merged =
            format!("repo:{repository} is:pr is:merged merged:>={since} sort:updated-desc");
        let Reply {
            data: Merged {
                repository: found,
                merged,
            },
            withheld,
        } = self.graphql(
            MERGED,
            json!({"owner": owner, "repo": repo, "merged": merged}),
        )?;
        let Some(found) = found else {
            return Err(withheld.explain("repository", repository.to_string()));
        };
        let Some(merged) = merged.filter(|merged| merged.nodes.is_some()) else {
            return Err(withheld.explain(
                "merged",
                format!("the merged pull requests in {repository}"),
            ));
        };
        let checks_withheld = withheld.field(CHECKS);
        let page = merged.page(|row| Some(summary(row, &HashSet::new(), checks_withheld)));
        Ok((found.name_with_owner, page))
    }
}

fn summary(row: Row, requested: &HashSet<u32>, checks_withheld: bool) -> Summary {
    Summary {
        review_requested: requested.contains(&row.number),
        review: row
            .review_decision
            .or_else(|| row.latest_opinionated_reviews.and_then(verdict)),
        checks: counts(row.status_check_rollup, checks_withheld),
        number: row.number,
        title: row.title,
        state: State::new(row.is_draft, row.merged_at, row.closed_at),
        author: login(row.author),
        viewer_is_author: row.viewer_did_author,
        head: row.head_ref_name,
        base: row.base_ref_name,
        labels: row
            .labels
            .map_or_else(Page::empty, |labels| labels.page(Some)),
        comments: row.total_comments_count.unwrap_or(0),
        mergeable: row.mergeable,
        additions: row.additions,
        deletions: row.deletions,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// GitHub decides only where a rule asks for reviews. Elsewhere one request
/// for changes outweighs any approval, as it would under a rule. A verdict that
/// GitHub left out may be one, so the rest cannot approve.
fn verdict(opinions: Nodes<Opinion>) -> Option<Review> {
    let total = opinions.total_count as usize;
    let states: Vec<_> = opinions.items().map(|opinion| opinion.state).collect();
    let any = |state| states.iter().any(|found| found == state);
    if any("CHANGES_REQUESTED") {
        Some(Review::ChangesRequested)
    } else if states.len() < total {
        Some(Review::Required)
    } else {
        any("APPROVED").then_some(Review::Approved)
    }
}

fn counts(rollup: Option<Rollup>, withheld: bool) -> Option<CheckCounts> {
    let mut counts = CheckCounts::default();
    let Some(Rollup { contexts }) = rollup else {
        return (!withheld).then_some(counts);
    };
    let runs = contexts.check_run_counts_by_state?;
    let statuses = contexts.status_context_counts_by_state?;
    for StateCount { state, count } in runs.into_iter().chain(statuses) {
        *match CheckState::from_github(&state) {
            CheckState::Passed => &mut counts.passed,
            CheckState::Failed => &mut counts.failed,
            CheckState::Skipped => &mut counts.skipped,
            CheckState::Running => &mut counts.running,
        } += count;
    }
    Some(counts)
}

/// The UTC day of a Unix time, as GitHub's search writes it.
fn day(unix_secs: u64) -> String {
    let days = unix_secs / 86_400 + 719_468;
    let era = days / 146_097;
    let day_of_era = days % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = (month_from_march + 2) % 12 + 1;
    let year = era * 400 + year_of_era + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::day;

    #[test]
    fn days_follow_the_calendar() {
        for (unix_secs, date) in [
            (0, "1970-01-01"),
            (68_169_599, "1972-02-28"),
            (68_169_600, "1972-02-29"),
            (951_782_400, "2000-02-29"),
            (951_868_800, "2000-03-01"),
            (1_767_225_599, "2025-12-31"),
            (1_767_225_600, "2026-01-01"),
            (4_107_542_400, "2100-03-01"),
        ] {
            assert_eq!(day(unix_secs), date);
        }
    }
}
