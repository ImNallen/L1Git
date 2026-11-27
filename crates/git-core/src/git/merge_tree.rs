use super::{Deadline, malformed, run, run_objects, text};
use crate::{Oid, RepositoryError};
use std::{collections::BTreeSet, path::Path};

/// What settings `merge_tree` merges with.
pub(crate) enum Merging {
    /// The repository's, with its attributes and merge drivers, as `git merge` and
    /// `git cherry-pick` would merge here.
    AsConfigured,
    /// Fixed ones, so every clone of the same commits gives the same tree. No
    /// attribute file and no custom merge driver takes part, and each conflicting
    /// hunk keeps `theirs`.
    PinnedFavoringTheirs,
}

/// The tree `merge-tree` writes and the paths it says conflict. Touches neither the
/// index nor the worktree, and writes loose objects only. `None` when `merge-tree`
/// cannot answer, as when a partial clone lacks a blob, or when a conflicted path is
/// not UTF-8.
pub(crate) fn merge_tree(
    root: &Path,
    merge_base: Option<&str>,
    ours: &str,
    theirs: &str,
    merging: Merging,
    deadline: Deadline,
) -> Result<Option<(Oid, BTreeSet<String>)>, RepositoryError> {
    let merge_base = merge_base.map(|base| format!("--merge-base={base}"));
    let settings = match merging {
        Merging::AsConfigured => None,
        Merging::PinnedFavoringTheirs => match pinned(root, ours, deadline)? {
            Some(settings) => Some(settings),
            None => return Ok(None),
        },
    };
    let mut args: Vec<&str> = settings.iter().flatten().map(String::as_str).collect();
    args.extend([
        "merge-tree",
        "--write-tree",
        "-z",
        "--name-only",
        "--no-messages",
    ]);
    if settings.is_some() {
        args.extend(["-X", "theirs"]);
    }
    args.extend(merge_base.as_deref());
    args.extend([ours, theirs]);
    let ran = if settings.is_some() {
        run_objects(root, &args, deadline)?
    } else {
        run(root, &args, deadline)?
    };
    if !matches!(ran.status.code(), Some(0 | 1)) {
        return Ok(None);
    }
    let Some(end) = ran.stdout.iter().position(|byte| *byte == 0) else {
        return Err(malformed());
    };
    let tree = Oid::try_from(text(&ran.stdout[..end])).map_err(|_| malformed())?;
    Ok(listed_paths(&ran.stdout[end..]).map(|conflicted| (tree, conflicted)))
}

/// The settings a person's configuration could otherwise change. Attributes come
/// from an empty tree and from no attribute file, but Git still reads
/// `.git/info/attributes`, so each custom merge driver configured here is given an
/// empty command, which Git cannot run, and its paths conflict instead. `None` when
/// a driver's name cannot be written as a setting.
fn pinned(
    root: &Path,
    like: &str,
    deadline: Deadline,
) -> Result<Option<Vec<String>>, RepositoryError> {
    let empty_tree = match like.len() {
        64 => "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
        _ => "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    };
    let mut settings = vec![
        "core.attributesFile=".to_owned(),
        "merge.renames=true".to_owned(),
        "merge.directoryRenames=true".to_owned(),
        "merge.renameLimit=7000".to_owned(),
        "merge.renormalize=false".to_owned(),
        "merge.default=text".to_owned(),
    ];
    let drivers = run_objects(
        root,
        &[
            "config",
            "-z",
            "--name-only",
            "--get-regexp",
            r"^merge\..+\.driver$",
        ],
        deadline,
    )?;
    match drivers.status.code() {
        Some(0) => {
            for key in drivers.stdout.split(|byte| *byte == 0) {
                if key.is_empty() {
                    continue;
                }
                let Ok(key) = std::str::from_utf8(key) else {
                    return Ok(None);
                };
                if key.contains('=') {
                    return Ok(None);
                }
                settings.push(format!("{key}="));
            }
        }
        Some(1) => {}
        _ => return Err(malformed()),
    }
    let mut args = vec![format!("--attr-source={empty_tree}")];
    for setting in settings {
        args.extend(["-c".to_owned(), setting]);
    }
    Ok(Some(args))
}

/// NUL-separated paths, or `None` when one is not UTF-8, which L1 Git cannot name.
pub(crate) fn listed_paths(bytes: &[u8]) -> Option<BTreeSet<String>> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8(path.to_vec()).ok())
        .collect()
}
