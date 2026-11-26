use super::{HeadFrom, NoPush, PullHead, PullKey, Pushes};
use crate::{
    AddRemote, BranchRef, ErrorKind, GitHubRepository, Remote, RepositoryError, git::Deadline,
    remotes, sync::Wanted, write::branches::Setting,
};
use std::path::Path;

/// What `pr/<number>` follows, by where the head lives.
pub(super) enum Upstream {
    /// The head branch on `remote`, fetched by name, so the branch tracks
    /// its remote-tracking ref and Push reaches the pull request. A fork
    /// that takes your pushes gets a named remote, because Push refuses a
    /// URL. `adds` is that remote when no remote is the fork yet.
    Branch {
        remote: String,
        merge: BranchRef,
        adds: Option<AddRemote>,
    },
    /// `refs/pull/<number>/head` on the base remote, which GitHub keeps
    /// after a fork is gone, which `git pull` follows, and which takes no
    /// push. The head commit is fetched by id.
    PullRef { remote: String, why: NoPush },
}

impl Upstream {
    pub(super) fn of(
        root: &Path,
        pull: &PullKey,
        head: &PullHead,
        reads: Deadline,
    ) -> Result<Self, RepositoryError> {
        let found = remotes::read(root, reads)?;
        let base = remotes::of_github(found.clone(), &pull.github).ok_or_else(|| {
            RepositoryError::new(
                ErrorKind::GitFailed,
                format!(
                    "No remote of this repository is github.com/{}/{}, so L1 Git cannot fetch the pull request.",
                    pull.github.owner, pull.github.repo
                ),
            )
        })?;
        let merge = head.reference.clone();
        let fork = match &head.from {
            HeadFrom::Same => {
                return Ok(Self::Branch {
                    remote: base,
                    merge,
                    adds: None,
                });
            }
            HeadFrom::Fork { edits: false, .. } => {
                return Ok(Self::PullRef {
                    remote: base,
                    why: NoPush::NoEdits,
                });
            }
            HeadFrom::Gone => {
                return Ok(Self::PullRef {
                    remote: base,
                    why: NoPush::ForkGone,
                });
            }
            HeadFrom::Fork {
                repository,
                edits: true,
            } => repository,
        };
        if let Some(remote) = remotes::of_github(found.clone(), fork) {
            return Ok(Self::Branch {
                remote,
                merge,
                adds: None,
            });
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
        Ok(Self::Branch {
            remote: name.clone(),
            merge,
            adds: Some(AddRemote { name, url }),
        })
    }

    /// `of` under the write lock, after the fetch added any remote it needs.
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

    pub(super) fn pushes(&self) -> Pushes {
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

    /// `branch.pr/<number>.remote` and `.merge`.
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

/// The fork owner's login, else `<owner>-<repo>`, else that with a number,
/// whichever no remote has. Case is ignored, because a disk that folds case
/// would put two such remotes' refs in one folder.
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
