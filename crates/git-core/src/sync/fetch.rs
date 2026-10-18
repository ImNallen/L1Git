use super::{now, stderr};
use crate::{
    FetchFailure, FetchOutcome, FetchSummary, RemoteFetch, RepositoryError,
    git::{self, Finished, Mutation},
};
use std::{collections::HashSet, path::Path, time::Duration};

pub(super) fn fetch_all(root: &Path, deadline: Duration) -> Result<FetchSummary, RepositoryError> {
    let before = tips(root)?;
    let names = git::read(root, &["remote"])?;
    let skipped = skipped_remotes(root)?;
    let remotes = git::text(&names)
        .lines()
        .map(|remote| {
            let outcome = if skipped.contains(remote) {
                FetchOutcome::Skipped
            } else {
                fetch(root, remote, deadline)?
            };
            Ok(RemoteFetch {
                remote: remote.to_owned(),
                outcome,
            })
        })
        .collect::<Result<_, RepositoryError>>()?;
    Ok(FetchSummary {
        at: now(),
        changed: tips(root)? != before,
        coalesced: false,
        remotes,
    })
}

fn fetch(root: &Path, remote: &str, deadline: Duration) -> Result<FetchOutcome, RepositoryError> {
    Ok(
        match git::mutate(root, Mutation::Fetch { remote }, deadline)? {
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
fn skipped_remotes(root: &Path) -> Result<HashSet<String>, RepositoryError> {
    let output = git::run(
        root,
        &[
            "config",
            "--type=bool",
            "--get-regexp",
            r"^remote\..*\.(skipfetchall|skipdefaultupdate)$",
        ],
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

fn tips(root: &Path) -> Result<Vec<u8>, RepositoryError> {
    git::read(
        root,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )
}
