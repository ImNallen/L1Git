use super::{Coordinator, lock_ignoring_poison, read};
use crate::{
    BranchRef, FetchFailure, Head, Oid, RepositoryError, RepositoryOverview,
    git::{self, Captured, Deadline, LocalRead, Mutation},
    remotes, repository, stderr,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushIntent {
    pub branch: BranchRef,
    pub source: Oid,
    pub remote: String,
    pub destination: BranchRef,
    pub endpoint: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PushAvailability {
    Ready { intent: PushIntent },
    Unavailable { reason: PushUnavailable },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushUnavailable {
    Detached,
    Unborn,
    NoUpstream,
    LocalUpstream,
    UnsupportedConfiguration,
    Mirror,
    MultipleEndpoints,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PushOutcome {
    Pushed,
    UpToDate,
    Stale,
    Rejected { message: String },
    Failed { message: String },
    Uncertain { message: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PushRefresh {
    Refreshed {
        overview: RepositoryOverview,
        availability: Box<PushAvailability>,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReport {
    pub outcome: PushOutcome,
    pub refresh: PushRefresh,
}

impl Coordinator {
    pub fn prepare_push(&self, path: &str) -> Result<PushAvailability, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        prepare(&repository, reads)
    }

    pub fn push(&self, path: &str, intent: &PushIntent) -> Result<PushReport, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let locks = self.locks(&repository.common_dir);
        let _gate = lock_ignoring_poison(&locks.gate);
        let _slot = self.slots.acquire();
        let current = {
            let _write = lock_ignoring_poison(&locks.write);
            prepare(&repository, reads.renewed())?
        };
        let outcome = if current
            != (PushAvailability::Ready {
                intent: intent.clone(),
            }) {
            PushOutcome::Stale
        } else {
            match git::capture_mutation(
                &repository.root,
                Mutation::Push {
                    remote: &intent.remote,
                    source: &intent.source,
                    destination: &intent.destination,
                },
                self.limits.push_deadline,
            ) {
                Ok(captured) => publication(captured, &intent.source, &intent.destination),
                Err(_) => PushOutcome::Uncertain {
                    message: "Git could not confirm publication. Check the remote before retrying."
                        .into(),
                },
            }
        };
        let refresh = (|| {
            let overview = read::read(
                &repository,
                None,
                self.limits.local_deadline,
                reads.renewed(),
            )?;
            let availability = prepare(&repository, reads.renewed())?;
            Ok::<_, RepositoryError>(PushRefresh::Refreshed {
                overview,
                availability: Box::new(availability),
            })
        })()
        .unwrap_or_else(|_| PushRefresh::Failed {
            message:
                "Could not refresh local branch status. Refresh the repository to check its counts."
                    .into(),
        });
        Ok(PushReport { outcome, refresh })
    }
}

fn unavailable(reason: PushUnavailable) -> PushAvailability {
    PushAvailability::Unavailable { reason }
}

fn values(root: &Path, key: &str, reads: Deadline) -> Result<Vec<String>, RepositoryError> {
    let output = git::run(root, &["config", "--null", "--get-all", key], reads)?;
    match output.status.code() {
        Some(0) => output
            .stdout
            .strip_suffix(&[0])
            .ok_or_else(git::malformed)?
            .split(|byte| *byte == 0)
            .map(|value| String::from_utf8(value.to_vec()).map_err(|_| git::malformed()))
            .collect(),
        Some(1) => Ok(Vec::new()),
        _ => Err(git::read_failed()),
    }
}

fn prepare(
    repository: &read::Repository,
    reads: Deadline,
) -> Result<PushAvailability, RepositoryError> {
    let root = &repository.root;
    let (branch, source) = match repository::head(root, reads)? {
        Head::Detached { .. } => return Ok(unavailable(PushUnavailable::Detached)),
        Head::Unborn { .. } => return Ok(unavailable(PushUnavailable::Unborn)),
        Head::Attached { reference, oid } => (BranchRef::try_from(reference)?, Oid::try_from(oid)?),
    };
    let remotes = values(root, &format!("branch.{}.remote", branch.name()), reads)?;
    let merges = values(root, &format!("branch.{}.merge", branch.name()), reads)?;
    if remotes.is_empty() || merges.is_empty() {
        return Ok(unavailable(PushUnavailable::NoUpstream));
    }
    let ([remote], [merge]) = (remotes.as_slice(), merges.as_slice()) else {
        return Ok(unavailable(PushUnavailable::UnsupportedConfiguration));
    };
    if remote == "." {
        return Ok(unavailable(PushUnavailable::LocalUpstream));
    }
    let Ok(destination) = BranchRef::try_from(merge.clone()) else {
        return Ok(unavailable(PushUnavailable::UnsupportedConfiguration));
    };
    let names = git::read(root, &["remote"], reads)?;
    if !git::text(&names).lines().any(|name| name == remote) || remote.starts_with('-') {
        return Ok(unavailable(PushUnavailable::UnsupportedConfiguration));
    }
    let mirror_key = format!("remote.{remote}.mirror");
    match git::config_flag(root, &mirror_key, false, reads) {
        Ok(true) => return Ok(unavailable(PushUnavailable::Mirror)),
        Err(_) => return Ok(unavailable(PushUnavailable::UnsupportedConfiguration)),
        Ok(false) => {}
    }
    let urls = git::run(
        root,
        &["remote", "get-url", "--push", "--all", remote],
        reads,
    )?;
    if !urls.status.success() {
        return Ok(unavailable(PushUnavailable::UnsupportedConfiguration));
    }
    let urls = git::text(&urls.stdout);
    let endpoints: Vec<_> = urls.lines().collect();
    let [endpoint] = endpoints.as_slice() else {
        return Ok(unavailable(PushUnavailable::MultipleEndpoints));
    };
    if endpoint.is_empty() {
        return Ok(unavailable(PushUnavailable::UnsupportedConfiguration));
    }
    // Length-delimited canonical inputs keep credentials inside core. This is
    // freshness evidence, not an authorization token or a config-edit lock.
    let identity = vec![
        repository.root.to_string_lossy().into_owned(),
        repository.common_dir.to_string_lossy().into_owned(),
        branch.as_str().into(),
        source.as_str().into(),
        remote.clone(),
        merge.clone(),
        (*endpoint).into(),
    ];
    let mut policy = Vec::new();
    for key in [
        format!("remote.{remote}.url"),
        format!("remote.{remote}.pushurl"),
        format!("remote.{remote}.fetch"),
        mirror_key,
        format!("remote.{remote}.receivepack"),
        "core.hooksPath".into(),
        "core.sshCommand".into(),
        "push.gpgSign".into(),
    ] {
        let configured = values(root, &key, reads)?;
        policy.push((key, configured));
    }
    let fingerprint = sha1_smol::Sha1::from(
        serde_json::to_vec(&(identity, policy)).map_err(|_| git::malformed())?,
    )
    .digest()
    .to_string();
    Ok(PushAvailability::Ready {
        intent: PushIntent {
            branch,
            source,
            remote: remote.clone(),
            destination,
            endpoint: remotes::display_url(endpoint).0,
            fingerprint,
        },
    })
}

fn publication(captured: Captured, source: &Oid, destination: &BranchRef) -> PushOutcome {
    let Captured::Completed {
        success,
        stdout,
        stderr,
    } = captured
    else {
        return PushOutcome::Uncertain {
            message: concat!(
                "Push timed out. The remote may have accepted the commit. ",
                "Check the remote before retrying."
            )
            .into(),
        };
    };
    let uncertain = || PushOutcome::Uncertain {
        message: concat!(
            "Git did not confirm publication. The remote may have accepted the commit. ",
            "Check the remote before retrying."
        )
        .into(),
    };
    let Ok(stdout) = String::from_utf8(stdout) else {
        return uncertain();
    };
    // Unclassified transport errors can follow remote acceptance.
    if stdout.is_empty() && !success && stderr::classify(&stderr) == FetchFailure::Auth {
        return PushOutcome::Failed {
            message: "Authentication failed. Check your Git credentials and remote access.".into(),
        };
    }
    let lines: Vec<_> = stdout.lines().collect();
    let [header, record, "Done"] = lines.as_slice() else {
        return uncertain();
    };
    if !header.starts_with("To ") || !stdout.ends_with('\n') {
        return uncertain();
    }
    let fields: Vec<_> = record.split('\t').collect();
    let [flag, refs, summary] = fields.as_slice() else {
        return uncertain();
    };
    if refs.split_once(':') != Some((source.as_str(), destination.as_str())) {
        return uncertain();
    }
    match (*flag, success) {
        (" " | "*", true) => PushOutcome::Pushed,
        ("=", true) => PushOutcome::UpToDate,
        ("!", false)
            if summary.starts_with("[rejected]") || summary.starts_with("[remote rejected]") =>
        {
            PushOutcome::Rejected {
                message: concat!(
                    "The remote rejected this push. ",
                    "Check for newer remote commits or remote hook requirements."
                )
                .into(),
            }
        }
        _ => uncertain(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_capture_cannot_claim_an_authentication_refusal() {
        let outcome = publication(
            Captured::Completed {
                success: false,
                stdout: "…".as_bytes().to_vec(),
                stderr: "Permission denied (publickey).".into(),
            },
            &Oid::try_from("a".repeat(40)).unwrap(),
            &BranchRef::try_from("refs/heads/main".to_owned()).unwrap(),
        );
        assert!(matches!(outcome, PushOutcome::Uncertain { .. }));
    }

    #[test]
    fn incomplete_or_inconsistent_porcelain_never_claims_no_publication() {
        let destination = BranchRef::try_from("refs/heads/main".to_owned()).unwrap();
        let source = "a".repeat(40);
        for output in [
            "",
            "Done\n",
            "…\n=\ta:refs/heads/main\t[up to date]\nDone\n",
            " \ta:refs/heads/main\tx\n",
            " \ta:refs/heads/other\tx\nDone\n",
            " \ta:refs/heads/main\tx\n \tb:refs/heads/other\tx\nDone\n",
            "To local\n!\ta:refs/heads/main\t[rejected] reason\nWrong\n",
        ] {
            let stdout = output.replace("a:", &format!("{source}:"));
            assert!(
                matches!(
                    publication(
                        Captured::Completed {
                            success: true,
                            stdout: stdout.as_bytes().to_vec(),
                            stderr: String::new()
                        },
                        &Oid::try_from("a".repeat(40)).unwrap(),
                        &destination
                    ),
                    PushOutcome::Uncertain { .. }
                ),
                "{stdout}"
            );
        }
    }
}
