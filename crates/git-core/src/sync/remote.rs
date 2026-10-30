use super::{Coordinator, PublishOptions, lock_ignoring_poison, read};
use crate::{
    ErrorKind, RepositoryError,
    git::{self, Deadline, LocalRead},
};
use serde::{Deserialize, Serialize};
use std::{fmt, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddRemote {
    pub name: String,
    pub url: String,
}

impl fmt::Debug for AddRemote {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AddRemote")
            .field("name", &self.name)
            .field("url", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRemoteReport {
    pub name: String,
    pub refresh: AddRemoteRefresh,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AddRemoteRefresh {
    Refreshed { options: PublishOptions },
    Failed { message: String },
}

const SAVE_FAILED: &str = "Could not add the remote. Check Git's configuration and config lock, then reload remotes before retrying.";
const REFRESH_FAILED: &str = "The remote was added, but its configuration could not be refreshed. Reload remotes before reviewing publication.";
fn failed() -> RepositoryError {
    RepositoryError::new(ErrorKind::GitFailed, SAVE_FAILED)
}

impl Coordinator {
    /// Adds configuration only. Err means the common config rename did not commit.
    pub fn add_remote(
        &self,
        path: &str,
        remote: &AddRemote,
    ) -> Result<AddRemoteReport, RepositoryError> {
        self.add_remote_then(path, remote, || self.publish_options(path))
    }

    fn add_remote_then(
        &self,
        path: &str,
        remote: &AddRemote,
        refresh: impl FnOnce() -> Result<PublishOptions, RepositoryError>,
    ) -> Result<AddRemoteReport, RepositoryError> {
        let reads = self.deadline(LocalRead::BranchStatus);
        let repository = read::open(path, reads).map_err(|_| failed())?;
        let locks = self.locks(&repository.common_dir);
        let mut gate = lock_ignoring_poison(&locks.gate);
        let write = lock_ignoring_poison(&locks.write);
        let reads = reads.renewed();
        validate(&repository.root, remote, reads)?;
        let absent = || remote_absent(&repository.root, &remote.name, reads);
        if !absent().map_err(|_| failed())? {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                "A remote with this name is already configured. Choose another name.",
            ));
        }
        let fetch = format!("+refs/heads/*:refs/remotes/{}/*", remote.name);
        git::install_config_values(
            &repository.root,
            &repository.git_config,
            &[
                (format!("remote.{}.url", remote.name), remote.url.as_str()),
                (format!("remote.{}.fetch", remote.name), fetch.as_str()),
            ],
            reads,
            absent,
            SAVE_FAILED,
        )?;
        gate.last_fetch = None;
        drop(write);
        // Independent global, include, and worktree configs cannot share config.lock.
        let refreshed =
            verify(&repository.root, remote, &fetch, reads.renewed()).and_then(|()| refresh());
        Ok(AddRemoteReport {
            name: remote.name.clone(),
            refresh: match refreshed {
                Ok(options) => AddRemoteRefresh::Refreshed { options },
                Err(_) => AddRemoteRefresh::Failed {
                    message: REFRESH_FAILED.into(),
                },
            },
        })
    }
}

fn validate(root: &Path, remote: &AddRemote, reads: Deadline) -> Result<(), RepositoryError> {
    let name = &remote.name;
    if name.is_empty()
        || name == "."
        || name.starts_with('-')
        || name.ends_with('/')
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Enter a valid Git remote name.",
        ));
    }
    let namespace = format!("refs/remotes/{name}/__l1git_probe");
    let checked = git::run(root, &["check-ref-format", &namespace], reads).map_err(|_| failed())?;
    if !checked.status.success() {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Enter a valid Git remote name.",
        ));
    }
    let endpoint = &remote.url;
    if endpoint.is_empty()
        || endpoint.trim() != endpoint
        || endpoint.starts_with('-')
        || endpoint.chars().any(char::is_control)
        || endpoint.split_once("::").is_some_and(|(helper, _)| {
            !helper.is_empty()
                && helper
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
    {
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Enter a Git endpoint URL or filesystem path.",
        ));
    }
    if endpoint.contains("://") {
        let valid = url::Url::parse(endpoint).is_ok_and(|url| {
            matches!(url.scheme(), "https" | "http" | "ssh" | "git" | "file")
                && (url.scheme() == "file" || url.host_str().is_some())
        });
        if !valid {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                "Enter a supported Git endpoint URL or filesystem path.",
            ));
        }
    } else if let Some((host, path)) = endpoint.split_once(':') {
        // A colon before a slash is Git's scp-style transport. Other values are paths.
        if !host.contains('/')
            && (host.is_empty()
                || host.chars().any(char::is_whitespace)
                || path.is_empty()
                || matches!(host, "https" | "http" | "ssh" | "git" | "file"))
        {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                "Enter a valid SSH endpoint or filesystem path.",
            ));
        }
    }
    Ok(())
}

fn remote_absent(root: &Path, name: &str, reads: Deadline) -> Result<bool, RepositoryError> {
    let output = git::run(
        root,
        &[
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            "^remote\\.",
        ],
        reads,
    )?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(failed());
    }
    Ok(!output.stdout.split(|b| *b == 0).any(|key| {
        key.strip_prefix(b"remote.")
            .and_then(|key| key.iter().rposition(|b| *b == b'.').map(|end| &key[..end]))
            == Some(name.as_bytes())
    }))
}

fn verify(
    root: &Path,
    remote: &AddRemote,
    fetch: &str,
    reads: Deadline,
) -> Result<(), RepositoryError> {
    for (key, expected) in [("url", remote.url.as_str()), ("fetch", fetch)] {
        let key = format!("remote.{}.{key}", remote.name);
        let output = git::run(root, &["config", "--null", "--get-all", &key], reads)?;
        if !output.status.success() || output.stdout != [expected.as_bytes(), &[0]].concat() {
            return Err(failed());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FetchSummary, Limits};
    use std::{process::Command, time::Instant};

    #[test]
    fn addition_waits_for_gate_then_write_and_renews_deadlines_without_a_network_slot() {
        use std::{
            sync::{Arc, mpsc},
            time::Duration,
        };
        let directory = tempfile::tempdir().unwrap();
        assert!(
            Command::new("git")
                .arg("init")
                .arg("--quiet")
                .arg(directory.path())
                .status()
                .unwrap()
                .success()
        );
        let root = directory.path().canonicalize().unwrap();
        let core = Arc::new(
            Coordinator::new(Limits::default(), root.join("undo"))
                .cap_reads(Duration::from_millis(500)),
        );
        let locks = core.locks(&root.join(".git"));
        let gate = lock_ignoring_poison(&locks.gate);
        let write = lock_ignoring_poison(&locks.write);
        let permits: Vec<_> = (0..core.limits.network_slots.get())
            .map(|_| core.slots.acquire())
            .collect();
        let (tx, rx) = mpsc::channel();
        let worker = Arc::clone(&core);
        let job = std::thread::spawn(move || {
            tx.send(worker.add_remote(
                root.to_str().unwrap(),
                &AddRemote {
                    name: "waited".into(),
                    url: "../endpoint".into(),
                },
            ))
            .unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(600)).is_err());
        drop(gate);
        assert!(rx.recv_timeout(Duration::from_millis(600)).is_err());
        drop(write);
        rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        drop(permits);
        job.join().unwrap();
    }

    #[test]
    fn external_include_definition_during_staging_refuses_the_addition() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        assert!(
            Command::new("git")
                .arg("init")
                .arg("--quiet")
                .arg(root)
                .status()
                .unwrap()
                .success()
        );
        let include = root.join("included");
        std::fs::write(&include, "").unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["config", "include.path"])
                .arg(&include)
                .status()
                .unwrap()
                .success()
        );
        let config = root.join(".git/config");
        let before = std::fs::read(&config).unwrap();
        let reads = Deadline::of(LocalRead::BranchStatus);
        assert!(remote_absent(root, "raced", reads).unwrap());
        let result = git::install_config_values(
            root,
            &config,
            &[
                ("remote.raced.url".into(), "../endpoint"),
                (
                    "remote.raced.fetch".into(),
                    "+refs/heads/*:refs/remotes/raced/*",
                ),
            ],
            reads,
            || {
                std::fs::write(
                    &include,
                    "[remote \"raced\"]\n pushurl = externally-added\n",
                )
                .unwrap();
                remote_absent(root, "raced", reads)
            },
            SAVE_FAILED,
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(config).unwrap(), before);
        assert!(!root.join(".git/config.lock").exists());
    }

    #[test]
    fn committed_addition_survives_refresh_failure_and_clears_fetch_cache() {
        let directory = tempfile::tempdir().unwrap();
        assert!(
            Command::new("git")
                .arg("init")
                .arg("--quiet")
                .arg(directory.path())
                .status()
                .unwrap()
                .success()
        );
        let root = directory.path().canonicalize().unwrap();
        let core = Coordinator::new(Limits::default(), root.join("undo"));
        let locks = core.locks(&root.join(".git"));
        lock_ignoring_poison(&locks.gate).last_fetch = Some((
            Instant::now(),
            FetchSummary {
                at: 0,
                changed: false,
                coalesced: false,
                remotes: vec![],
            },
        ));
        let remote = AddRemote {
            name: "saved".into(),
            url: "../endpoint".into(),
        };
        let report = core
            .add_remote_then(root.to_str().unwrap(), &remote, || Err(failed()))
            .unwrap();
        assert_eq!(report.name, "saved");
        assert!(matches!(report.refresh, AddRemoteRefresh::Failed { .. }));
        verify(
            &root,
            &remote,
            "+refs/heads/*:refs/remotes/saved/*",
            Deadline::of(LocalRead::BranchStatus),
        )
        .unwrap();
        assert!(lock_ignoring_poison(&locks.gate).last_fetch.is_none());
        assert!(core.add_remote(root.to_str().unwrap(), &remote).is_err());
    }
}
