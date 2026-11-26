use super::{HeadFrom, NoPush, PullHead, PullKey, Pushes};
use crate::{
    AddRemote, BranchRef, ErrorKind, GitHubRepository, Remote, RepositoryError, git::Deadline,
    remotes, sync::Wanted, write::branches::Setting,
};
use std::path::Path;

pub(super) enum Upstream {
    Branch {
        remote: String,
        merge: BranchRef,
        adds: Option<AddRemote>,
    },
    /// `refs/pull/<number>/head` on the base remote, which GitHub keeps
    /// after a fork is gone and which takes no push.
    PullRef { remote: String, why: NoPush },
}

impl Upstream {
    pub(super) fn of(
        root: &Path,
        pull: &PullKey,
        head: &PullHead,
        reads: Deadline,
    ) -> Result<Self, RepositoryError> {
        Self::found(root, pull, head, reads)?.ok_or_else(|| {
            RepositoryError::new(
                ErrorKind::GitFailed,
                format!(
                    "No remote of this repository is github.com/{}/{}, so L1 Git cannot fetch the pull request.",
                    pull.github.owner, pull.github.repo
                ),
            )
        })
    }

    /// Where pushes go, or nowhere when no remote is the pull request's
    /// repository, so a read still answers.
    pub(super) fn pushes_of(
        root: &Path,
        pull: &PullKey,
        head: &PullHead,
        reads: Deadline,
    ) -> Result<Pushes, RepositoryError> {
        Ok(Self::found(root, pull, head, reads)?.map_or(
            Pushes::Nowhere {
                why: NoPush::NoRemote,
            },
            |upstream| upstream.pushes(),
        ))
    }

    fn found(
        root: &Path,
        pull: &PullKey,
        head: &PullHead,
        reads: Deadline,
    ) -> Result<Option<Self>, RepositoryError> {
        let found = remotes::read(root, reads)?;
        let Some(base) = remotes::of_github(found.clone(), &pull.github) else {
            return Ok(None);
        };
        let merge = head.reference.clone();
        let fork = match &head.from {
            HeadFrom::Same => {
                return Ok(Some(Self::Branch {
                    remote: base,
                    merge,
                    adds: None,
                }));
            }
            HeadFrom::Fork { edits: false, .. } => {
                return Ok(Some(Self::PullRef {
                    remote: base,
                    why: NoPush::NoEdits,
                }));
            }
            HeadFrom::Gone => {
                return Ok(Some(Self::PullRef {
                    remote: base,
                    why: NoPush::ForkGone,
                }));
            }
            HeadFrom::Fork {
                repository,
                edits: true,
            } => repository,
        };
        if let Some(remote) = remotes::of_github(found.clone(), fork) {
            return Ok(Some(Self::Branch {
                remote,
                merge,
                adds: None,
            }));
        }
        let url = remotes::sibling_url(&remotes::raw_url(root, &base, reads)?, fork).ok_or_else(
            || {
                RepositoryError::new(
                    ErrorKind::GitFailed,
                    format!(
                        "L1 Git cannot tell the URL of {}/{} from {base}'s.",
                        fork.owner, fork.repo
                    ),
                )
            },
        )?;
        let name = free_name(&found, fork);
        Ok(Some(Self::Branch {
            remote: name.clone(),
            merge,
            adds: Some(AddRemote { name, url }),
        }))
    }

    pub(super) fn settled(
        root: &Path,
        pull: &PullKey,
        head: &PullHead,
        reads: Deadline,
    ) -> Result<Self, RepositoryError> {
        let upstream = Self::of(root, pull, head, reads)?;
        if let Some(remote) = upstream.adds() {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                format!(
                    "The remote {} changed while L1 Git fetched the pull request. Try again.",
                    remote.name
                ),
            ));
        }
        Ok(upstream)
    }

    pub(super) const fn adds(&self) -> Option<&AddRemote> {
        match self {
            Self::Branch { adds, .. } => adds.as_ref(),
            Self::PullRef { .. } => None,
        }
    }

    pub(super) fn remote(&self) -> &str {
        match self {
            Self::Branch { remote, .. } | Self::PullRef { remote, .. } => remote,
        }
    }

    pub(super) const fn wanted<'h>(&'h self, head: &'h PullHead) -> Wanted<'h> {
        match self {
            Self::Branch { merge, .. } => Wanted::Branch(merge),
            Self::PullRef { .. } => Wanted::Commit(&head.oid),
        }
    }

    fn pushes(&self) -> Pushes {
        match self {
            Self::Branch {
                remote,
                merge,
                adds,
            } => Pushes::ToPullRequest {
                remote: remote.clone(),
                destination: merge.clone(),
                adds_remote: adds.is_some(),
            },
            Self::PullRef { why, .. } => Pushes::Nowhere { why: *why },
        }
    }

    pub(super) fn settings(&self, pull: &PullKey) -> [Setting; 2] {
        let (remote, merge) = match self {
            Self::Branch { remote, merge, .. } => (remote, merge.as_str().to_owned()),
            Self::PullRef { remote, .. } => (remote, format!("refs/pull/{}/head", pull.number)),
        };
        [
            Setting {
                key: "remote".into(),
                value: remote.clone(),
            },
            Setting {
                key: "merge".into(),
                value: merge,
            },
        ]
    }
}

/// Case is ignored because a disk that folds case would put two such
/// remotes' refs in one folder.
fn free_name(remotes: &[Remote], fork: &GitHubRepository) -> String {
    let taken = |name: &str| {
        remotes
            .iter()
            .any(|remote| remote.name.eq_ignore_ascii_case(name))
    };
    let both = format!("{}-{}", fork.owner, fork.repo);
    [fork.owner.clone(), both.clone()]
        .into_iter()
        .chain((2..).map(|count| format!("{both}-{count}")))
        .find(|name| !taken(name))
        .unwrap_or(both)
}
