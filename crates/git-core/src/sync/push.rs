use super::{Coordinator, lock_ignoring_poison, read};
use crate::{
    BranchRef, FetchFailure, Head, Oid, RepositoryError, RepositoryOverview,
    git::{self, Captured, Deadline, LocalRead, Mutation},
    remotes, repository, stderr,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushPurpose {
    Upstream,
    Publish,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishChoice {
    pub remote: String,
    pub destination: BranchRef,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRemote {
    pub name: String,
    pub availability: PublishRemoteAvailability,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PublishRemoteAvailability {
    Eligible { endpoint: String },
    Unavailable { reason: PushUnavailable },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PublishOptions {
    Available {
        branch: BranchRef,
        source: Oid,
        remotes: Vec<PublishRemote>,
    },
    Unavailable {
        reason: PushUnavailable,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TrackingOutcome {
    Set,
    Failed { message: String },
    SkippedChanged { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushIntent {
    pub purpose: PushPurpose,
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
    UnusableFetchMapping,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PushOutcome {
    Published { tracking: TrackingOutcome },
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

    pub fn publish_options(&self, path: &str) -> Result<PublishOptions, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let (branch, source) = match publish_source(&repository, reads)? {
            Ok(source) => source,
            Err(reason) => return Ok(PublishOptions::Unavailable { reason }),
        };
        let names = git::read(&repository.root, &["remote"], reads)?;
        let mut remotes = Vec::new();
        for name in git::text(&names).lines() {
            let availability = match remote_endpoint(&repository.root, name, reads)? {
                Ok(endpoint) => PublishRemoteAvailability::Eligible {
                    endpoint: display_endpoint(PushPurpose::Publish, &endpoint),
                },
                Err(reason) => PublishRemoteAvailability::Unavailable { reason },
            };
            remotes.push(PublishRemote {
                name: name.into(),
                availability,
            });
        }
        Ok(PublishOptions::Available {
            branch,
            source,
            remotes,
        })
    }

    pub fn prepare_publish(
        &self,
        path: &str,
        choice: &PublishChoice,
    ) -> Result<PushAvailability, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        prepare_publication(&repository, choice, reads)
    }

    pub fn push(&self, path: &str, intent: &PushIntent) -> Result<PushReport, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads)?;
        let locks = self.locks(&repository.common_dir);
        let _gate = lock_ignoring_poison(&locks.gate);
        let _slot = self.slots.acquire();
        let current = {
            let _write = lock_ignoring_poison(&locks.write);
            prepare_intent(&repository, intent, reads.renewed())?
        };
        let mut outcome = if current
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
        if intent.purpose == PushPurpose::Publish
            && matches!(outcome, PushOutcome::Pushed | PushOutcome::UpToDate)
        {
            let _write = lock_ignoring_poison(&locks.write);
            let tracking =
                establish_tracking(&repository, intent, reads.renewed()).unwrap_or_else(|_| {
                    TrackingOutcome::Failed {
                        message: "Upstream setup failed. Check branch settings in Git.".into(),
                    }
                });
            outcome = PushOutcome::Published { tracking };
        }
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
    if remotes.is_empty() && merges.is_empty() {
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
    prepare_target(
        repository,
        reads,
        PushPurpose::Upstream,
        branch,
        source,
        remote,
        destination,
    )
}

fn remote_endpoint(
    root: &Path,
    remote: &str,
    reads: Deadline,
) -> Result<Result<String, PushUnavailable>, RepositoryError> {
    let names = git::read(root, &["remote"], reads)?;
    if !git::text(&names).lines().any(|name| name == remote) || remote.starts_with('-') {
        return Ok(Err(PushUnavailable::UnsupportedConfiguration));
    }
    let mirror_key = format!("remote.{remote}.mirror");
    match git::config_flag(root, &mirror_key, false, reads) {
        Ok(true) => return Ok(Err(PushUnavailable::Mirror)),
        Err(_) => return Ok(Err(PushUnavailable::UnsupportedConfiguration)),
        Ok(false) => {}
    }
    let urls = git::run(
        root,
        &["remote", "get-url", "--push", "--all", remote],
        reads,
    )?;
    if !urls.status.success() {
        return Ok(Err(PushUnavailable::UnsupportedConfiguration));
    }
    let urls = git::text(&urls.stdout);
    let endpoints: Vec<_> = urls.lines().collect();
    let [endpoint] = endpoints.as_slice() else {
        return Ok(Err(PushUnavailable::MultipleEndpoints));
    };
    if endpoint.is_empty() {
        return Ok(Err(PushUnavailable::UnsupportedConfiguration));
    }
    Ok(Ok((*endpoint).to_owned()))
}

fn display_endpoint(purpose: PushPurpose, endpoint: &str) -> String {
    if purpose == PushPurpose::Publish
        && (Path::new(endpoint).is_absolute() || !endpoint.contains(':'))
    {
        endpoint.into()
    } else {
        remotes::display_url(endpoint).0
    }
}

fn prepare_target(
    repository: &read::Repository,
    reads: Deadline,
    purpose: PushPurpose,
    branch: BranchRef,
    source: Oid,
    remote: &str,
    destination: BranchRef,
) -> Result<PushAvailability, RepositoryError> {
    let root = &repository.root;
    let endpoint = match remote_endpoint(root, remote, reads)? {
        Ok(endpoint) => endpoint,
        Err(reason) => return Ok(unavailable(reason)),
    };
    let mirror_key = format!("remote.{remote}.mirror");
    let identity = vec![
        repository.root.to_string_lossy().into_owned(),
        repository.common_dir.to_string_lossy().into_owned(),
        branch.as_str().into(),
        source.as_str().into(),
        remote.into(),
        destination.as_str().into(),
        format!("{purpose:?}"),
        endpoint.clone(),
    ];
    let mut policy = Vec::new();
    for key in [
        format!("remote.{remote}.url"),
        format!("remote.{remote}.pushurl"),
        format!("remote.{remote}.fetch"),
        mirror_key,
        format!("remote.{remote}.receivepack"),
        format!("remote.{remote}.vcs"),
        "core.hooksPath".into(),
        "core.sshCommand".into(),
        "push.gpgSign".into(),
        format!("branch.{}.remote", branch.name()),
        format!("branch.{}.merge", branch.name()),
        "extensions.worktreeConfig".into(),
    ] {
        let configured = git::run(
            root,
            &["config", "--null", "--show-origin", "--get-all", &key],
            reads,
        )?
        .stdout;
        policy.push((key, configured));
    }
    if purpose == PushPurpose::Publish && !usable_mapping(root, remote, &destination, reads)? {
        return Ok(unavailable(PushUnavailable::UnusableFetchMapping));
    }
    let fingerprint = sha1_smol::Sha1::from(
        serde_json::to_vec(&(identity, policy)).map_err(|_| git::malformed())?,
    )
    .digest()
    .to_string();
    Ok(PushAvailability::Ready {
        intent: PushIntent {
            purpose,
            branch,
            source,
            remote: remote.into(),
            destination,
            endpoint: display_endpoint(purpose, &endpoint),
            fingerprint,
        },
    })
}

fn publish_source(
    repository: &read::Repository,
    reads: Deadline,
) -> Result<Result<(BranchRef, Oid), PushUnavailable>, RepositoryError> {
    let (branch, source) = match repository::head(&repository.root, reads)? {
        Head::Detached { .. } => return Ok(Err(PushUnavailable::Detached)),
        Head::Unborn { .. } => return Ok(Err(PushUnavailable::Unborn)),
        Head::Attached { reference, oid } => (BranchRef::try_from(reference)?, Oid::try_from(oid)?),
    };
    if !std::fs::symlink_metadata(repository.common_dir.join("config"))
        .is_ok_and(|metadata| metadata.is_file())
    {
        return Ok(Err(PushUnavailable::UnsupportedConfiguration));
    }
    for suffix in ["remote", "merge"] {
        if !values(
            &repository.root,
            &format!("branch.{}.{suffix}", branch.name()),
            reads,
        )?
        .is_empty()
        {
            return Ok(Err(PushUnavailable::UnsupportedConfiguration));
        }
    }
    Ok(Ok((branch, source)))
}

fn prepare_publication(
    repository: &read::Repository,
    choice: &PublishChoice,
    reads: Deadline,
) -> Result<PushAvailability, RepositoryError> {
    let (branch, source) = match publish_source(repository, reads)? {
        Ok(source) => source,
        Err(reason) => return Ok(unavailable(reason)),
    };
    prepare_target(
        repository,
        reads,
        PushPurpose::Publish,
        branch,
        source,
        &choice.remote,
        choice.destination.clone(),
    )
}

fn prepare_intent(
    repository: &read::Repository,
    intent: &PushIntent,
    reads: Deadline,
) -> Result<PushAvailability, RepositoryError> {
    match intent.purpose {
        PushPurpose::Upstream => prepare(repository, reads),
        PushPurpose::Publish => prepare_publication(
            repository,
            &PublishChoice {
                remote: intent.remote.clone(),
                destination: intent.destination.clone(),
            },
            reads,
        ),
    }
}

fn refspec_match<'a>(pattern: &str, reference: &'a str) -> Option<&'a str> {
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        if suffix.contains('*') {
            return None;
        }
        reference.strip_prefix(prefix)?.strip_suffix(suffix)
    } else {
        (pattern == reference).then_some("")
    }
}

fn usable_mapping(
    root: &Path,
    remote: &str,
    destination: &BranchRef,
    reads: Deadline,
) -> Result<bool, RepositoryError> {
    let specs = values(root, &format!("remote.{remote}.fetch"), reads)?;
    let mut targets = Vec::new();
    for spec in &specs {
        if let Some(excluded) = spec.strip_prefix('^') {
            if refspec_match(excluded, destination.as_str()).is_some() {
                return Ok(false);
            }
            continue;
        }
        let spec = spec.strip_prefix('+').unwrap_or(spec);
        let Some((from, to)) = spec.split_once(':') else {
            if refspec_match(spec, destination.as_str()).is_some() {
                return Ok(false);
            }
            continue;
        };
        if let Some(capture) = refspec_match(from, destination.as_str()) {
            if from.matches('*').count() != to.matches('*').count() || to.matches('*').count() > 1 {
                return Ok(false);
            }
            let target = to.replace('*', capture);
            if !target.starts_with("refs/")
                || target.starts_with("refs/heads/")
                || target.starts_with("refs/tags/")
                || [
                    "refs/stash",
                    "refs/replace/",
                    "refs/notes/",
                    "refs/bisect/",
                    "refs/rewritten/",
                    "refs/worktree/",
                ]
                .iter()
                .any(|prefix| target.starts_with(prefix))
                || !git::run(root, &["check-ref-format", &target], reads)?
                    .status
                    .success()
            {
                return Ok(false);
            }
            targets.push(target);
        }
    }
    let [target] = targets.as_slice() else {
        return Ok(false);
    };
    for spec in &specs {
        let Some((from, to)) = spec.strip_prefix('+').unwrap_or(spec).split_once(':') else {
            continue;
        };
        if let Some(capture) = refspec_match(to, target) {
            let source = from.replace('*', capture);
            let excluded = specs
                .iter()
                .filter_map(|spec| spec.strip_prefix('^'))
                .any(|pattern| refspec_match(pattern, &source).is_some());
            if source != destination.as_str() && !excluded {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn establish_tracking(
    repository: &read::Repository,
    intent: &PushIntent,
    reads: Deadline,
) -> Result<TrackingOutcome, RepositoryError> {
    let unchanged = || {
        Ok(prepare_intent(repository, intent, reads.renewed())?
            == PushAvailability::Ready {
                intent: intent.clone(),
            })
    };
    if !unchanged()? {
        return Ok(TrackingOutcome::SkippedChanged {
            message: "The branch or configuration changed. Upstream was not set.".into(),
        });
    }
    git::install_tracking(
        &repository.root,
        &repository.common_dir.join("config"),
        &intent.branch,
        &intent.remote,
        &intent.destination,
        reads,
        unchanged,
    )?;
    let remotes = values(
        &repository.root,
        &format!("branch.{}.remote", intent.branch.name()),
        reads.renewed(),
    )?;
    let merges = values(
        &repository.root,
        &format!("branch.{}.merge", intent.branch.name()),
        reads.renewed(),
    )?;
    if remotes == [intent.remote.clone()] && merges == [intent.destination.as_str()] {
        Ok(TrackingOutcome::Set)
    } else {
        Ok(TrackingOutcome::Failed {
            message: "Effective upstream settings changed. Check branch settings in Git.".into(),
        })
    }
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
    let [prefix @ .., header, record, "Done"] = lines.as_slice() else {
        return uncertain();
    };
    if stdout.starts_with('…')
        || prefix
            .iter()
            .any(|line| matches!(line.as_bytes(), [_, b'\t', ..]))
        || !header.starts_with("To ")
        || !stdout.ends_with('\n')
    {
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
            "…hook output\nTo local\n \ta:refs/heads/main\tupdated\nDone\n",
            "To other\n \ta:refs/heads/other\tupdated\nDone\nTo local\n \ta:refs/heads/main\tupdated\nDone\n",
            "hook output\nTo local\n \ta:refs/heads/main\tupdated\nDone",
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
