use super::now;
use crate::{
    ErrorKind, FetchBranch, FetchFailure, FetchOutcome, FetchSummary, RemoteFetch, RepositoryError,
    git::{self, Deadline, Finished, Mutation},
    stderr,
};
use std::{collections::HashSet, path::Path, time::Duration};

pub(super) fn fetch_all(
    root: &Path,
    deadline: Duration,
    reads: Deadline,
) -> Result<FetchSummary, RepositoryError> {
    let before = tips(root, reads)?;
    let names = git::read(root, &["remote"], reads)?;
    let skipped = skipped_remotes(root, reads)?;
    let remotes = git::text(&names)
        .lines()
        .map(|remote| {
            let outcome = if skipped.contains(remote) {
                FetchOutcome::Skipped
            } else {
                fetch(root, remote, None, deadline)?
            };
            Ok(RemoteFetch {
                remote: remote.to_owned(),
                outcome,
            })
        })
        .collect::<Result<_, RepositoryError>>()?;
    Ok(FetchSummary {
        at: now(),
        changed: tips(root, reads.renewed())? != before,
        coalesced: false,
        remotes,
    })
}

/// Where a branch's commits come from.
pub(super) struct Source {
    pub(super) remote: String,
    /// The branch's full name on `remote`.
    branch: String,
}

/// A local branch's `branch.<name>.remote` and `branch.<name>.merge`, or for a
/// remote-tracking branch the remote and source whose fetch refspec writes it.
pub(super) fn source(
    root: &Path,
    branch: &FetchBranch,
    reads: Deadline,
) -> Result<Source, RepositoryError> {
    match branch {
        FetchBranch::Local(branch) => {
            let config = |key: &str| -> Result<Option<String>, RepositoryError> {
                let key = format!("branch.{}.{key}", branch.name());
                let output = git::run(root, &["config", "--get", &key], reads)?;
                match output.status.code() {
                    Some(0) => Ok(Some(git::line(&output.stdout))),
                    Some(1) => Ok(None),
                    _ => Err(git::read_failed()),
                }
            };
            match (config("remote")?, config("merge")?) {
                (Some(remote), Some(merge)) if remote != "." => Ok(Source {
                    remote,
                    branch: merge,
                }),
                _ => Err(RepositoryError::new(
                    ErrorKind::InvalidRef,
                    format!(
                        "{} has no upstream on a remote, so there is nothing to fetch for it. Publish it, or use Fetch all.",
                        branch.name()
                    ),
                )),
            }
        }
        FetchBranch::Remote(reference) => {
            let tracking = reference.as_str();
            let output = git::run(
                root,
                &["config", "--get-regexp", r"^remote\..*\.fetch$"],
                reads,
            )?;
            if !matches!(output.status.code(), Some(0 | 1)) {
                return Err(git::read_failed());
            }
            git::text(&output.stdout)
                .lines()
                .find_map(|line| {
                    let (key, refspec) = line.split_once(' ')?;
                    let remote = key.strip_prefix("remote.")?.strip_suffix(".fetch")?;
                    Some(Source {
                        remote: remote.to_owned(),
                        branch: fetched_into(refspec, tracking)?,
                    })
                })
                .ok_or_else(|| {
                    RepositoryError::new(
                        ErrorKind::InvalidRef,
                        format!(
                            "No remote of this repository fetches into {}, so there is nothing to fetch for it. Use Fetch all.",
                            tracking.trim_start_matches("refs/remotes/")
                        ),
                    )
                })
        }
    }
}

/// The source ref that `refspec` fetches into `tracking`, if it writes there.
/// A negative refspec writes nothing.
fn fetched_into(refspec: &str, tracking: &str) -> Option<String> {
    let refspec = refspec.strip_prefix('+').unwrap_or(refspec);
    if refspec.starts_with('^') {
        return None;
    }
    let (source, destination) = refspec.split_once(':')?;
    match (source.split_once('*'), destination.split_once('*')) {
        (Some((source_head, source_tail)), Some((head, tail))) => {
            let matched = tracking.strip_prefix(head)?.strip_suffix(tail)?;
            (!matched.is_empty()).then(|| format!("{source_head}{matched}{source_tail}"))
        }
        (None, None) => (destination == tracking).then(|| source.to_owned()),
        _ => None,
    }
}

/// Fetches one branch without pruning, so other remote-tracking branches stay
/// as they were.
pub(super) fn fetch_branch(
    root: &Path,
    source: &Source,
    deadline: Duration,
    reads: Deadline,
) -> Result<FetchSummary, RepositoryError> {
    let before = tips(root, reads)?;
    let outcome = fetch(root, &source.remote, Some(&source.branch), deadline)?;
    Ok(FetchSummary {
        at: now(),
        changed: tips(root, reads.renewed())? != before,
        coalesced: false,
        remotes: vec![RemoteFetch {
            remote: source.remote.clone(),
            outcome,
        }],
    })
}

fn fetch(
    root: &Path,
    remote: &str,
    branch: Option<&str>,
    deadline: Duration,
) -> Result<FetchOutcome, RepositoryError> {
    Ok(
        match git::mutate(root, Mutation::Fetch { remote, branch }, deadline)? {
            Finished::Succeeded => FetchOutcome::Fetched,
            Finished::Failed { stderr } => FetchOutcome::Failed {
                failure: stderr::classify(&stderr),
                message: stderr::summarize(&stderr),
            },
            Finished::TimedOut => FetchOutcome::Failed {
                failure: FetchFailure::TimedOut,
                message: format!(
                    "{remote} did not answer within {} seconds.",
                    deadline.as_secs()
                ),
            },
        },
    )
}

/// The remotes `git fetch --all` leaves out.
fn skipped_remotes(root: &Path, reads: Deadline) -> Result<HashSet<String>, RepositoryError> {
    let output = git::run(
        root,
        &[
            "config",
            "--type=bool",
            "--get-regexp",
            r"^remote\..*\.(skipfetchall|skipdefaultupdate)$",
        ],
        reads,
    )?;
    Ok(git::text(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(' ')?;
            let (remote, _) = key.strip_prefix("remote.")?.rsplit_once('.')?;
            (value == "true").then(|| remote.to_owned())
        })
        .collect())
}

fn tips(root: &Path, reads: Deadline) -> Result<Vec<u8>, RepositoryError> {
    git::read(
        root,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/",
            "refs/remotes/",
        ],
        reads,
    )
}
