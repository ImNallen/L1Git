use crate::{ErrorKind, RepositoryError};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

const LISTING_CAP: usize = 500;

/// Reading these from the home directory raises a macOS privacy prompt, which
/// opening a folder list must not do.
const PRIVACY_FOLDERS: [&str; 6] = [
    "Desktop",
    "Documents",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub repository: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub entries: Vec<DirectoryEntry>,
}

/// The current user's home directory, from the environment.
pub(crate) fn home_dir() -> Option<PathBuf> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable)
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// The absolute path a typed path names. `~` and paths under it expand to
/// `home`, and `.` and `..` resolve by name. A relative path is refused.
pub fn expand_home(typed: &str, home: Option<&Path>) -> Result<PathBuf, RepositoryError> {
    let under_home = typed
        .strip_prefix('~')
        .filter(|rest| rest.is_empty() || rest.starts_with(std::path::is_separator));
    let path = match under_home {
        Some(rest) => home
            .ok_or_else(|| {
                RepositoryError::new(
                    ErrorKind::UnsupportedPath,
                    "L1 Git could not find your home directory. Enter an absolute path.",
                )
            })?
            .join(rest.trim_start_matches(std::path::is_separator)),
        None => PathBuf::from(typed),
    };
    if !path.is_absolute() {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "Enter an absolute path, or one that starts with ~.",
        ));
    }
    Ok(normalized(&path))
}

fn normalized(path: &Path) -> PathBuf {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other),
        }
    }
    clean
}

pub(crate) fn has_git(directory: &Path) -> bool {
    directory
        .join(".git")
        .metadata()
        .is_ok_and(|git| git.is_dir() || git.is_file())
}

/// The deepest ancestor of `path`, or `path` itself, that is a directory.
pub(crate) fn nearest_directory(path: &Path) -> Option<&Path> {
    path.ancestors().find(|ancestor| ancestor.is_dir())
}

/// What a typed path offers the Local folder step. Inside a repository that is
/// the one directory. Otherwise it is the children of a directory, or the
/// children of the parent whose names start with the last segment. A missing
/// parent offers nothing.
pub fn list_directories(
    typed: &str,
    home: Option<&Path>,
) -> Result<DirectoryListing, RepositoryError> {
    let path = expand_home(typed, home)?;
    let Some(nearest) = nearest_directory(&path) else {
        return Ok(DirectoryListing { entries: vec![] });
    };
    if nearest.ancestors().any(has_git) {
        return Ok(DirectoryListing {
            entries: vec![DirectoryEntry {
                name: nearest.file_name().map_or_else(
                    || nearest.to_string_lossy().into_owned(),
                    |name| name.to_string_lossy().into_owned(),
                ),
                path: nearest.to_string_lossy().into_owned(),
                repository: true,
            }],
        });
    }
    if nearest == path {
        return children(&path, "", home);
    }
    match (
        path.parent(),
        path.file_name().and_then(|name| name.to_str()),
    ) {
        (Some(parent), Some(prefix)) if parent == nearest => children(parent, prefix, home),
        _ => Ok(DirectoryListing { entries: vec![] }),
    }
}

fn children(
    directory: &Path,
    prefix: &str,
    home: Option<&Path>,
) -> Result<DirectoryListing, RepositoryError> {
    let read = fs::read_dir(directory).map_err(|_| {
        RepositoryError::new(
            ErrorKind::UnreadablePath,
            "L1 Git cannot read this folder. Check its permissions.",
        )
    })?;
    let wanted = prefix.to_lowercase();
    let mut names: Vec<String> = read
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.to_lowercase().starts_with(&wanted)
                && (prefix.starts_with('.') || !name.starts_with('.'))
                && directory.join(name).is_dir()
        })
        .collect();
    names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
    names.truncate(LISTING_CAP);
    let private = is_private_parent(directory, home);
    Ok(DirectoryListing {
        entries: names
            .into_iter()
            .map(|name| {
                let path = directory.join(&name);
                DirectoryEntry {
                    repository: !(private && PRIVACY_FOLDERS.contains(&name.as_str()))
                        && has_git(&path),
                    path: path.to_string_lossy().into_owned(),
                    name,
                }
            })
            .collect(),
    })
}

fn is_private_parent(directory: &Path, home: Option<&Path>) -> bool {
    cfg!(target_os = "macos")
        && home.is_some_and(|home| {
            directory
                .canonicalize()
                .is_ok_and(|directory| home.canonicalize().is_ok_and(|home| home == directory))
        })
}

/// A stable name for a path that may not exist yet: its nearest existing
/// directory with symlinks resolved, then the rest of the path.
pub(crate) fn resolved_target(path: &Path) -> PathBuf {
    let Some(nearest) = nearest_directory(path) else {
        return path.to_owned();
    };
    let rest = path.strip_prefix(nearest).unwrap_or(Path::new(""));
    nearest
        .canonicalize()
        .map_or_else(|_| path.to_owned(), |nearest| nearest.join(rest))
}
