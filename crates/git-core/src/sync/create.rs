use super::Coordinator;
use crate::{
    ErrorKind, RepositoryError,
    directories::{has_git, nearest_directory},
    git::{self, Finished, Mutation},
    stderr,
};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRepository {
    pub path: String,
}

impl Coordinator {
    /// Runs `git init` at an absolute `target`, creating missing folders. An
    /// existing folder keeps its files and starts being tracked.
    pub fn create_repository(&self, target: &Path) -> Result<NewRepository, RepositoryError> {
        if target.exists() && !target.is_dir() {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "A file already exists at this location. Choose another location.",
            ));
        }
        if has_git(target) {
            return Err(RepositoryError::new(
                ErrorKind::GitFailed,
                "This folder is already a Git repository. Add it with Local folder.",
            ));
        }
        let (nearest, path) = runnable(target)?;
        match git::mutate(
            nearest,
            Mutation::Init { target: path },
            self.limits.local_deadline,
        )? {
            Finished::Succeeded => Ok(NewRepository {
                path: path.to_owned(),
            }),
            Finished::Failed { stderr } => Err(RepositoryError::new(
                ErrorKind::GitFailed,
                stderr::summarize(&stderr),
            )),
            Finished::TimedOut => Err(RepositoryError::new(
                ErrorKind::TimedOut,
                format!(
                    "Creating the repository took longer than {} seconds, so L1 Git stopped Git. Retry.",
                    self.limits.local_deadline.as_secs()
                ),
            )),
        }
    }
}

/// Where Git can run for a `target` that may not exist yet, and the target as
/// the text Git gets on its command line.
pub(super) fn runnable(target: &Path) -> Result<(&Path, &str), RepositoryError> {
    let unsupported = || {
        RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "L1 Git cannot use this location. Choose another location.",
        )
    };
    Ok((
        nearest_directory(target).ok_or_else(unsupported)?,
        target.to_str().ok_or_else(unsupported)?,
    ))
}
