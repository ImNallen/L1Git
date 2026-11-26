use serde::Deserialize;
use serde_json::json;

use super::{DELETE_REF, Echo, Written, not_sent, refused};
use crate::drafts::{NodeId, Oid};
use crate::github::{ApiError, GitHub, api_failure};
use crate::graphql::Reply;

const HEAD_BRANCH: &str = include_str!("head_branch.graphql");

#[derive(Default, Deserialize)]
struct Answer {
    node: Option<Facts>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Facts {
    merged: bool,
    head_ref_name: String,
    is_cross_repository: bool,
    head_ref: Option<HeadRef>,
    head_repository: Option<HeadRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadRef {
    id: String,
    target: Option<Target>,
    associated_pull_requests: Count,
}

#[derive(Deserialize)]
struct Target {
    oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadRepository {
    based_on: Count,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Count {
    total_count: u32,
}

#[derive(Debug, PartialEq)]
enum Plan {
    Delete { id: String },
    Gone,
    Keep { why: String },
}

/// The merged pull request is never open, so every open one counted here is
/// another.
fn plan(facts: Facts, branch: &str, expected_head: &Oid) -> Plan {
    let keep = |why: String| Plan::Keep { why };
    if !facts.merged {
        return keep(format!(
            "L1 Git kept {branch}, because its pull request has not merged."
        ));
    }
    if facts.head_ref_name != branch {
        return keep(format!(
            "L1 Git kept {branch}, because the pull request's head is {}.",
            facts.head_ref_name
        ));
    }
    if facts.is_cross_repository {
        return keep(format!(
            "L1 Git kept {branch}, because it is in another repository."
        ));
    }
    let Some(head) = facts.head_ref else {
        return Plan::Gone;
    };
    if head
        .target
        .is_none_or(|target| target.oid != expected_head.as_str())
    {
        return keep(format!(
            "L1 Git kept {branch}, because it has a new commit since the merge."
        ));
    }
    let based_on = facts
        .head_repository
        .map_or(0, |repository| repository.based_on.total_count);
    match (head.associated_pull_requests.total_count, based_on) {
        (0, 0) => Plan::Delete { id: head.id },
        (0, open) => keep(format!(
            "L1 Git kept {branch}, because {open} open pull request(s) merge into it."
        )),
        (open, _) => keep(format!(
            "L1 Git kept {branch}, because {open} open pull request(s) use it as their head."
        )),
    }
}

impl GitHub<'_> {
    pub(super) fn delete_head_branch(
        &self,
        pull: &NodeId,
        branch: &str,
        expected_head: &Oid,
    ) -> Written {
        let found = self
            .graphql::<Answer>(HEAD_BRANCH, json!({"pull": pull, "branch": branch}))
            .and_then(|Reply { data, withheld }| {
                data.node
                    .ok_or_else(|| withheld.explain("node", "this pull request".to_owned()))
            });
        let facts = match found {
            Ok(facts) => facts,
            Err(ApiError::Unauthorized) => return not_sent(self.signed_out().message),
            Err(error) => {
                return not_sent(format!(
                    "L1 Git could not check {branch} first, so it deleted nothing. {}",
                    api_failure(error).message
                ));
            }
        };
        match plan(facts, branch, expected_head) {
            Plan::Gone => Written::Done {
                echo: Echo::BranchDeleted {},
            },
            Plan::Keep { why } => refused(why),
            Plan::Delete { id } => {
                self.mutate(DELETE_REF, "deleteRef", json!({"refId": id}), |_| {
                    Echo::BranchDeleted {}
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(c: char) -> Oid {
        Oid::try_from(c.to_string().repeat(40)).unwrap()
    }

    fn facts(head: Option<(&str, u32)>, based_on: u32) -> Facts {
        Facts {
            merged: true,
            head_ref_name: "fix".to_owned(),
            is_cross_repository: false,
            head_ref: head.map(|(oid, open)| HeadRef {
                id: "REF_1".to_owned(),
                target: Some(Target {
                    oid: oid.to_owned(),
                }),
                associated_pull_requests: Count { total_count: open },
            }),
            head_repository: Some(HeadRepository {
                based_on: Count {
                    total_count: based_on,
                },
            }),
        }
    }

    #[test]
    fn deletes_only_a_merged_branch_still_at_its_head_that_nothing_else_uses() {
        let head = "1".repeat(40);
        let plan = |facts: Facts| plan(facts, "fix", &oid('1'));
        assert_eq!(
            plan(facts(Some((&head, 0)), 0)),
            Plan::Delete {
                id: "REF_1".to_owned()
            }
        );
        assert_eq!(plan(facts(None, 3)), Plan::Gone, "gone is done");
        for kept in [
            facts(Some((&"2".repeat(40), 0)), 0),
            facts(Some((&head, 1)), 0),
            facts(Some((&head, 0)), 2),
            Facts {
                merged: false,
                ..facts(Some((&head, 0)), 0)
            },
            Facts {
                is_cross_repository: true,
                ..facts(Some((&head, 0)), 0)
            },
            Facts {
                head_ref_name: "main".to_owned(),
                ..facts(Some((&head, 0)), 0)
            },
        ] {
            assert!(matches!(plan(kept), Plan::Keep { .. }));
        }
    }
}
