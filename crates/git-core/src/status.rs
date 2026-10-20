use crate::{
    ChangeStatus, Conflict, ErrorKind, FilePatch, MoveSide, Moved, PATCH_LIMIT, RepositoryError,
    Side, Sides, StatusEntry, SubmoduleState, WorktreePatch, WorktreeStatus, git,
    repository::{self, text_patch},
    untracked::{quoted, untracked},
};
use std::{
    fs,
    path::{Component, Path},
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

fn change(code: u8) -> Result<Option<ChangeStatus>, RepositoryError> {
    Ok(Some(match code {
        b'.' => return Ok(None),
        b'M' => ChangeStatus::Modified,
        b'T' => ChangeStatus::TypeChanged,
        b'A' => ChangeStatus::Added,
        b'D' => ChangeStatus::Deleted,
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
    check(file)?;
    let entries = entries(&root)?;
    let entry = entries
        .iter()
        .find(|entry| lists(entry, file, side))
        .ok_or_else(|| no_changes(file, side))?;
    let changed = |diff: Option<FilePatch>| {
        diff.map(|diff| WorktreePatch::Diff { diff })
            .ok_or_else(|| no_changes(file, side))
    };
    let staged = |detect: &str, paths: &[&str]| {
        let head = head_or_empty_tree(&root)?;
        tracked(
            &root,
            &["diff-index", "--cached", detect, &head],
            paths,
            file,
        )
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
                let head = head_or_empty_tree(&root)?;
                tracked(&root, &["diff-index", "--no-renames", &head], &[file], file)?
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
            Side::Unstaged,
        ) => Ok(WorktreePatch::Submodule {
            submodule: *submodule,
        }),
        (StatusEntry::Ordinary { .. }, Side::Staged) => changed(staged("--no-renames", &[file])?),
        (
            StatusEntry::Ordinary { .. }
            | StatusEntry::Renamed {
                side: MoveSide::Staged { .. },
                ..
            },
            Side::Unstaged,
        ) => changed(tracked(
            &root,
            &["diff-files", "--no-renames"],
            &[file],
            file,
        )?),
        (StatusEntry::Renamed { original, how, .. }, _) => {
            let detect = match how {
                Moved::Renamed => "--find-renames",
                Moved::Copied => "--find-copies-harder",
            };
            changed(match side {
                Side::Staged => staged(detect, &[original, file])?,
                Side::Unstaged => tracked(&root, &["diff-files", detect], &[original, file], file)?,
            })
        }
        (StatusEntry::Untracked { .. }, _) => untracked(&root, file),
    }
}

fn check(file: &str) -> Result<(), RepositoryError> {
    let components: Vec<_> = Path::new(file).components().collect();
    if components.is_empty()
        || !components
            .iter()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "Choose a path inside this worktree, relative to its root.",
        ));
    }
    if components
        .iter()
        .any(|component| component.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "L1 Git does not show diffs for files inside a .git directory.",
        ));
    }
    Ok(())
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

pub(crate) fn no_changes(file: &str, side: Side) -> RepositoryError {
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

fn head_or_empty_tree(root: &Path) -> Result<String, RepositoryError> {
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
/// after it compares a file whose stat changed. One path can print two
/// sections, as a type change does. A move pair also prints the source's own
/// change, so only the sections that end at `destination` are kept.
fn tracked(
    root: &Path,
    command: &[&str],
    paths: &[&str],
    destination: &str,
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
    let Some(binary) = binary_at(&numstat, destination)? else {
        return Ok(None);
    };
    if binary {
        return Ok(Some(FilePatch::Binary));
    }
    Ok(Some(
        match git::read_capped(root, &args("--patch"), PATCH_LIMIT)? {
            git::Capped::Within(patch) if paths.len() == 1 => text_patch(&patch),
            git::Capped::Within(patch) => {
                let kept: Vec<u8> = sections(&patch)
                    .filter(|section| ends_at(section, destination))
                    .flatten()
                    .copied()
                    .collect();
                if kept.is_empty() {
                    return Err(git::malformed());
                }
                text_patch(&kept)
            }
            git::Capped::Over(bytes) => FilePatch::TooLarge { bytes },
        },
    ))
}

/// Whether Git sees the change that ends at `destination` as binary, or `None`
/// when no numstat record ends there.
fn binary_at(numstat: &[u8], destination: &str) -> Result<Option<bool>, RepositoryError> {
    let mut fields = numstat.split(|byte| *byte == 0);
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let mut columns = record.splitn(3, |byte| *byte == b'\t');
        let (Some(added), Some(deleted), Some(path)) =
            (columns.next(), columns.next(), columns.next())
        else {
            return Err(git::malformed());
        };
        let path = if path.is_empty() {
            fields.next();
            fields.next().ok_or_else(git::malformed)?
        } else {
            path
        };
        if path == destination.as_bytes() {
            return Ok(Some(added == b"-" && deleted == b"-"));
        }
    }
    Ok(None)
}

fn sections(patch: &[u8]) -> impl Iterator<Item = &[u8]> {
    const START: &[u8] = b"diff --git ";
    let mut starts: Vec<usize> = (0..patch.len())
        .filter(|&at| (at == 0 || patch[at - 1] == b'\n') && patch[at..].starts_with(START))
        .collect();
    starts.push(patch.len());
    (0..starts.len() - 1).map(move |index| &patch[starts[index]..starts[index + 1]])
}

/// A section ends at `file` when it moves a path to `file`, or when it
/// changes `file` in place.
fn ends_at(section: &[u8], file: &str) -> bool {
    let target = quoted("", file);
    let same = format!("diff --git {} {}", quoted("a/", file), quoted("b/", file));
    section
        .split(|byte| *byte == b'\n')
        .enumerate()
        .any(|(at, line)| {
            (at == 0 && line == same.as_bytes())
                || line == format!("rename to {target}").as_bytes()
                || line == format!("copy to {target}").as_bytes()
        })
}
