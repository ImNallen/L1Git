use crate::{
    CommitsFetch, ErrorKind, FetchBranch, FetchFailure, FetchOutcome, FetchSummary, Oid,
    RemoteFetch, RepositoryError,
    git::{self, Deadline, Finished, Mutation},
    remotes, stderr,
};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    time::Duration,
};

pub(super) fn fetch_all(
    root: &Path,
    deadline: Duration,
    reads: Deadline,
) -> Result<FetchSummary, RepositoryError> {
    let before = tips(root, reads)?;
    let names = remotes::names(root, reads)?;
    let skipped = skipped_remotes(root, reads)?;
    let remotes = names
        .into_iter()
        .map(|remote| {
            let outcome = if skipped.contains(remote.as_str()) {
                FetchOutcome::Skipped
            } else {
                fetch(root, &remote, None, deadline)?
            };
            Ok(RemoteFetch { remote, outcome })
        })
        .collect::<Result<_, RepositoryError>>()?;
    summary(root, &before, reads, remotes)
}

fn summary(
    root: &Path,
    before: &[u8],
    reads: Deadline,
    remotes: Vec<RemoteFetch>,
) -> Result<FetchSummary, RepositoryError> {
    let after = tips(root, reads.renewed())?;
    Ok(FetchSummary {
        changed: after != before,
        moved: moved(before, &after),
        coalesced: false,
        remotes,
    })
}

/// How many branches the fetch created, moved, or deleted. A symbolic ref such
/// as `origin/HEAD` follows its target, so it does not count again.
fn moved(before: &[u8], after: &[u8]) -> u32 {
    let branches = |tips: &[u8]| -> BTreeMap<Vec<u8>, Vec<u8>> {
        tips.split(|byte| *byte == b'\n')
            .filter_map(|line| {
                let mut fields = line.splitn(3, |byte| *byte == b' ');
                match (fields.next(), fields.next(), fields.next()) {
                    (Some(name), Some(oid), Some(b"")) => Some((name.to_vec(), oid.to_vec())),
                    _ => None,
                }
            })
            .collect()
    };
    let (before, after) = (branches(before), branches(after));
    let count = after
        .iter()
        .filter(|(name, oid)| before.get(*name) != Some(oid))
        .count()
        + before
            .keys()
            .filter(|name| !after.contains_key(*name))
            .count();
    u32::try_from(count).unwrap_or(u32::MAX)
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
    summary(
        root,
        &before,
        reads,
        vec![RemoteFetch {
            remote: source.remote.clone(),
            outcome,
        }],
    )
}

pub(super) fn fetch(
    root: &Path,
    remote: &str,
    branch: Option<&str>,
    deadline: Duration,
) -> Result<FetchOutcome, RepositoryError> {
    let finished = git::mutate(root, Mutation::Fetch { remote, branch }, deadline)?;
    Ok(match failed(finished, remote, deadline) {
        None => FetchOutcome::Fetched,
        Some((failure, message)) => FetchOutcome::Failed { failure, message },
    })
}

/// Fetches the objects behind `oids` and moves no ref.
pub(super) fn fetch_commits(
    root: &Path,
    remote: &str,
    oids: &[Oid],
    deadline: Duration,
) -> Result<CommitsFetch, RepositoryError> {
    let finished = git::mutate(root, Mutation::FetchCommits { remote, oids }, deadline)?;
    Ok(match failed(finished, remote, deadline) {
        None => CommitsFetch::Done,
        Some((failure, message)) => CommitsFetch::Failed { failure, message },
    })
}

fn failed(finished: Finished, remote: &str, deadline: Duration) -> Option<(FetchFailure, String)> {
    match finished {
        Finished::Succeeded => None,
        Finished::Failed { stderr } => {
            Some((stderr::classify(&stderr), stderr::summarize(&stderr)))
        }
        Finished::TimedOut => Some((
            FetchFailure::TimedOut,
            format!(
                "{remote} did not answer within {} seconds.",
                deadline.as_secs()
            ),
        )),
    }
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
            "--format=%(refname) %(objectname) %(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
        reads,
    )
}
