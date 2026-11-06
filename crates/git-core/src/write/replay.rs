use super::{Repo, commit};
use crate::{
    Head, Oid, RepositoryError,
    git::{self, WriteDeadline},
    sync::{self, InProgress},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplayKind {
    CherryPick,
    Revert,
}

impl ReplayKind {
    const fn marker(self) -> &'static str {
        match self {
            Self::CherryPick => "CHERRY_PICK_HEAD",
            Self::Revert => "REVERT_HEAD",
        }
    }

    pub(super) const fn operation(self) -> InProgress {
        match self {
            Self::CherryPick => InProgress::CherryPick,
            Self::Revert => InProgress::Revert,
        }
    }
}

/// The only identity a replay has. There is no session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayOf {
    pub kind: ReplayKind,
    pub commit: Oid,
}

/// The single check for a replay L1 Git can finish. Everything else stays an
/// external operation: `sequencer/`, because `--abort` would rewind the commits
/// already picked; another operation alongside; a `-m` pick, because Git records
/// no parent number; a pruned commit; and an unborn branch.
pub(super) fn in_flight(
    repo: &Repo,
    deadline: WriteDeadline,
) -> Result<Option<ReplayOf>, RepositoryError> {
    let kind = match sync::in_progress(&repo.root, deadline.reads())?.as_slice() {
        [InProgress::CherryPick] => ReplayKind::CherryPick,
        [InProgress::Revert] => ReplayKind::Revert,
        _ => return Ok(None),
    };
    if !sync::pseudoref_exists(&repo.root, kind.marker(), deadline.reads())? {
        return Ok(None);
    }
    let Some(commit) = commit::resolve(repo, deadline, kind.marker())? else {
        return Ok(None);
    };
    if parents(repo, &commit, deadline)?.len() > 1
        || matches!(repo.head(deadline)?, Head::Unborn { .. })
    {
        return Ok(None);
    }
    Ok(Some(ReplayOf { kind, commit }))
}

fn parents(
    repo: &Repo,
    commit: &Oid,
    deadline: WriteDeadline,
) -> Result<Vec<String>, RepositoryError> {
    let output = git::read(
        &repo.root,
        &["show", "-s", "--format=%P", commit.as_str()],
        deadline.reads(),
    )?;
    Ok(git::text(&output)
        .split_whitespace()
        .map(str::to_owned)
        .collect())
}
