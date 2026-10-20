use crate::{
    Change, Conflict, ErrorKind, FilePatch, MoveSide, Moved, RepositoryError, Side, Sides,
    StatusEntry, SubmoduleState, WorktreePatch, WorktreeStatus,
    git::{self, Exit},
    repository::{self, capped_patch},
};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub fn worktree_status(path: &str) -> Result<WorktreeStatus, RepositoryError> {
    let root = repository::root(path)?;
    Ok(WorktreeStatus {
        head: repository::head(&root)?,
        entries: entries(&root)?,
        root: root.to_string_lossy().into_owned(),
    })
}

fn entries(root: &Path) -> Result<Vec<StatusEntry>, RepositoryError> {
    let output = git::read(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--find-renames",
            "--untracked-files=all",
        ],
    )?;
    let mut entries = Vec::new();
    let mut fields = output.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        entries.push(match field {
            [] => continue,
            [b'1', b' ', record @ ..] => {
                let [xy, sub, .., path] = columns::<8>(record)?;
                StatusEntry::Ordinary {
                    path: git::text(path),
                    submodule: submodule(sub)?,
                    sides: sides(xy)?,
                }
            }
            [b'2', b' ', record @ ..] => {
                let [xy, sub, .., path] = columns::<9>(record)?;
                let staged = |unstaged| {
                    Ok::<_, RepositoryError>(MoveSide::Staged {
                        unstaged: change(unstaged)?,
                    })
                };
                let (how, side) = match xy {
                    [b'R', unstaged] => (Moved::Renamed, staged(*unstaged)?),
                    [b'C', unstaged] => (Moved::Copied, staged(*unstaged)?),
                    b".R" => (Moved::Renamed, MoveSide::Unstaged),
                    b".C" => (Moved::Copied, MoveSide::Unstaged),
                    _ => return Err(git::malformed()),
                };
                StatusEntry::Renamed {
                    path: git::text(path),
                    original: git::text(fields.next().ok_or_else(git::malformed)?),
                    how,
                    submodule: submodule(sub)?,
                    side,
                }
            }
            [b'u', b' ', record @ ..] => {
                let [xy, sub, .., path] = columns::<10>(record)?;
                StatusEntry::Unmerged {
                    path: git::text(path),
                    conflict: conflict(xy)?,
                    submodule: submodule(sub)?,
                }
            }
            [b'?', b' ', path @ ..] => StatusEntry::Untracked {
                path: git::text(path),
            },
            _ => return Err(git::malformed()),
        });
    }
    Ok(entries)
}

fn columns<const N: usize>(record: &[u8]) -> Result<[&[u8]; N], RepositoryError> {
    record
        .splitn(N, |byte| *byte == b' ')
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| git::malformed())
}

fn change(code: u8) -> Result<Option<Change>, RepositoryError> {
    Ok(Some(match code {
        b'.' => return Ok(None),
        b'M' => Change::Modified,
        b'T' => Change::TypeChanged,
        b'A' => Change::Added,
        b'D' => Change::Deleted,
        _ => return Err(git::malformed()),
    }))
}

fn sides(xy: &[u8]) -> Result<Sides, RepositoryError> {
    let [staged, unstaged] = xy else {
        return Err(git::malformed());
    };
    match (change(*staged)?, change(*unstaged)?) {
        (Some(staged), Some(unstaged)) => Ok(Sides::Both { staged, unstaged }),
        (Some(staged), None) => Ok(Sides::Staged { staged }),
        (None, Some(unstaged)) => Ok(Sides::Unstaged { unstaged }),
        (None, None) => Err(git::malformed()),
    }
}

fn submodule(field: &[u8]) -> Result<Option<SubmoduleState>, RepositoryError> {
    let flag = |byte: u8, set: u8| match byte {
        b'.' => Ok(false),
        byte if byte == set => Ok(true),
        _ => Err(git::malformed()),
    };
    match field {
        b"N..." => Ok(None),
        [b'S', commit, modified, untracked] => Ok(Some(SubmoduleState {
            commit_changed: flag(*commit, b'C')?,
            modified: flag(*modified, b'M')?,
            untracked: flag(*untracked, b'U')?,
        })),
        _ => Err(git::malformed()),
    }
}

fn conflict(xy: &[u8]) -> Result<Conflict, RepositoryError> {
    Ok(match xy {
        b"DD" => Conflict::BothDeleted,
        b"AU" => Conflict::AddedByUs,
        b"UD" => Conflict::DeletedByThem,
        b"UA" => Conflict::AddedByThem,
        b"DU" => Conflict::DeletedByUs,
        b"AA" => Conflict::BothAdded,
        b"UU" => Conflict::BothModified,
        _ => return Err(git::malformed()),
    })
}

/// Reads one side of a path that `worktree_status` lists, so the patch always
/// agrees with the entry it was opened from.
pub fn worktree_patch(
    path: &str,
    file: &str,
    side: Side,
) -> Result<WorktreePatch, RepositoryError> {
    let root = repository::root(path)?;
    if file.is_empty()
        || !Path::new(file)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "Choose a path inside this worktree, relative to its root.",
        ));
    }
    let entries = entries(&root)?;
    let entry = entries
        .iter()
        .find(|entry| lists(entry, file, side))
        .ok_or_else(|| no_changes(file, side))?;
    let changed = |diff: Option<FilePatch>| {
        diff.map(|diff| WorktreePatch::Diff { diff })
            .ok_or_else(|| no_changes(file, side))
    };
    match (entry, side) {
        (
            StatusEntry::Unmerged {
                conflict,
                submodule,
                ..
            },
            _,
        ) => Ok(WorktreePatch::Conflicted {
            conflict: *conflict,
            diff: if submodule.is_none() && fs::symlink_metadata(root.join(file)).is_ok() {
                tracked(
                    &root,
                    &["diff-index", "--no-renames", &base(&root)?],
                    &[file],
                )?
            } else {
                None
            },
        }),
        (
            StatusEntry::Ordinary {
                submodule: Some(submodule),
                ..
            }
            | StatusEntry::Renamed {
                submodule: Some(submodule),
                ..
            },
            _,
        ) => Ok(WorktreePatch::Submodule {
            submodule: *submodule,
        }),
        (StatusEntry::Ordinary { .. }, Side::Staged) => changed(tracked(
            &root,
            &["diff-index", "--cached", "--no-renames", &base(&root)?],
            &[file],
        )?),
        (
            StatusEntry::Ordinary { .. }
            | StatusEntry::Renamed {
                side: MoveSide::Staged { .. },
                ..
            },
            Side::Unstaged,
        ) => changed(tracked(&root, &["diff-files", "--no-renames"], &[file])?),
        (StatusEntry::Renamed { original, how, .. }, _) => {
            let detect = match how {
                Moved::Renamed => "--find-renames",
                Moved::Copied => "--find-copies-harder",
            };
            let head;
            let command = match side {
                Side::Staged => {
                    head = base(&root)?;
                    vec!["diff-index", "--cached", detect, &head]
                }
                Side::Unstaged => vec!["diff-files", detect],
            };
            changed(tracked(&root, &command, &[original, file])?)
        }
        (StatusEntry::Untracked { .. }, _) => untracked(&root, file),
    }
}

fn lists(entry: &StatusEntry, file: &str, side: Side) -> bool {
    match entry {
        StatusEntry::Ordinary { path, sides, .. } => {
            path == file
                && matches!(
                    (sides, side),
                    (Sides::Both { .. }, _)
                        | (Sides::Staged { .. }, Side::Staged)
                        | (Sides::Unstaged { .. }, Side::Unstaged)
                )
        }
        StatusEntry::Renamed {
            path, side: moved, ..
        } => {
            path == file
                && match moved {
                    MoveSide::Staged { unstaged } => side == Side::Staged || unstaged.is_some(),
                    MoveSide::Unstaged => side == Side::Unstaged,
                }
        }
        StatusEntry::Unmerged { path, .. } => path == file,
        StatusEntry::Untracked { path } => path == file && side == Side::Unstaged,
    }
}

fn no_changes(file: &str, side: Side) -> RepositoryError {
    if file.contains(char::REPLACEMENT_CHARACTER) {
        return RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "L1 Git cannot open diffs for file names that are not valid UTF-8.",
        );
    }
    RepositoryError::new(
        ErrorKind::UnchangedPath,
        match side {
            Side::Staged => "This file has no staged changes. Refresh the worktree status.",
            Side::Unstaged => "This file has no unstaged changes. Refresh the worktree status.",
        },
    )
}

fn base(root: &Path) -> Result<String, RepositoryError> {
    let head = git::run(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?;
    if head.status.success() {
        return Ok(git::line(&head.stdout));
    }
    Ok(git::line(&git::read_with_input(
        root,
        &["hash-object", "-t", "tree", "--stdin"],
        Vec::new(),
    )?))
}

/// Runs diff plumbing, which never rewrites the index the way `git diff` does
/// after it compares a file whose stat changed.
fn tracked(
    root: &Path,
    command: &[&str],
    paths: &[&str],
) -> Result<Option<FilePatch>, RepositoryError> {
    let args = |format| {
        let mut args = vec!["--literal-pathspecs"];
        args.extend(command);
        args.extend([
            "-z",
            format,
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--",
        ]);
        args.extend(paths);
        args
    };
    let numstat = git::read(root, &args("--numstat"))?;
    if numstat.is_empty() {
        return Ok(None);
    }
    patch(
        root,
        &args("--patch"),
        numstat.starts_with(b"-\t-\t"),
        Exit::Success,
    )
    .map(Some)
}

fn untracked(root: &Path, file: &str) -> Result<WorktreePatch, RepositoryError> {
    let on_disk = root.join(file.trim_end_matches('/'));
    let kind = fs::symlink_metadata(&on_disk)
        .map_err(|_| no_changes(file, Side::Unstaged))?
        .file_type();
    let diff = if kind.is_file() {
        let args = |format| {
            [
                "diff",
                "--no-index",
                "-z",
                format,
                "--full-index",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--",
                "/dev/null",
                file,
            ]
        };
        let numstat = git::read_exiting(root, &args("--numstat"), Exit::Differs)?;
        patch(
            root,
            &args("--patch"),
            numstat.starts_with(b"-\t-\t"),
            Exit::Differs,
        )?
    } else if kind.is_symlink() {
        let target = fs::read_link(&on_disk).map_err(|_| no_changes(file, Side::Unstaged))?;
        symlink_patch(root, file, &link_text(target))?
    } else if kind.is_dir() {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "L1 Git cannot show a diff for a nested repository.",
        ));
    } else {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "L1 Git can show diffs only for regular files and symbolic links.",
        ));
    };
    Ok(WorktreePatch::Diff { diff })
}

#[cfg(unix)]
fn link_text(target: PathBuf) -> Vec<u8> {
    std::os::unix::ffi::OsStringExt::into_vec(target.into_os_string())
}

#[cfg(not(unix))]
fn link_text(target: PathBuf) -> Vec<u8> {
    target.to_string_lossy().into_owned().into_bytes()
}

/// Writes the patch Git shows for a new symbolic link from the link text alone.
/// `diff --no-index` would follow the link to a directory or a FIFO.
fn symlink_patch(root: &Path, file: &str, target: &[u8]) -> Result<FilePatch, RepositoryError> {
    let oid = git::line(&git::read_with_input(
        root,
        &["hash-object", "--no-filters", "--stdin"],
        target.to_vec(),
    )?);
    let (old, new) = (quoted("a/", file), quoted("b/", file));
    let tab = if new.contains(' ') { "\t" } else { "" };
    let lines: Vec<&[u8]> = target.split_inclusive(|byte| *byte == b'\n').collect();
    let count = match lines.len() {
        1 => String::new(),
        count => format!(",{count}"),
    };
    let mut patch = format!(
        "diff --git {old} {new}\nnew file mode 120000\nindex {}..{oid}\n--- /dev/null\n+++ {new}{tab}\n@@ -0,0 +1{count} @@\n",
        "0".repeat(oid.len()),
    )
    .into_bytes();
    for line in lines {
        patch.push(b'+');
        patch.extend_from_slice(line);
    }
    if !target.ends_with(b"\n") {
        patch.extend_from_slice(b"\n\\ No newline at end of file\n");
    }
    Ok(FilePatch::Text {
        lossy: std::str::from_utf8(&patch).is_err(),
        patch: git::text(&patch),
    })
}

/// Quotes a path the way Git's diff headers do with `core.quotePath=false`.
fn quoted(prefix: &str, path: &str) -> String {
    let special = |c: char| c < ' ' || c == '"' || c == '\\' || c == '\x7f';
    if !path.contains(special) {
        return format!("{prefix}{path}");
    }
    let mut quoted = format!("\"{prefix}");
    for c in path.chars() {
        match c {
            '\x07' => quoted.push_str("\\a"),
            '\x08' => quoted.push_str("\\b"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\x0b' => quoted.push_str("\\v"),
            '\x0c' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            c if special(c) => quoted.push_str(&format!("\\{:03o}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

fn patch(
    root: &Path,
    args: &[&str],
    binary: bool,
    exit: Exit,
) -> Result<FilePatch, RepositoryError> {
    if binary {
        Ok(FilePatch::Binary)
    } else {
        capped_patch(root, args, exit)
    }
}
