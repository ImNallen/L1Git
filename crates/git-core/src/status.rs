use crate::{
    ChangeStatus, ChangedFile, Conflict, ErrorKind, FilePatch, IndexObject, Mode, MoveSide, Moved,
    Oid, PATCH_LIMIT, RepositoryError, Side, Sides, StagedStamp, Stages, StatusEntry,
    SubmoduleState, WorktreePatch, WorktreeStatus,
    git::{self, Deadline, LocalRead},
    repository::{self, text_patch},
    untracked::untracked,
};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path},
};

pub fn worktree_status(path: &str) -> Result<WorktreeStatus, RepositoryError> {
    worktree_status_within(path, Deadline::of(LocalRead::WorktreeStatus))
}

pub(crate) fn worktree_status_within(
    path: &str,
    deadline: Deadline,
) -> Result<WorktreeStatus, RepositoryError> {
    let root = repository::root(path, deadline)?;
    let head = repository::head(&root, deadline)?;
    let (entries, staged_stamp) = entries(&root, Untracked::All, deadline)?;
    Ok(WorktreeStatus {
        head,
        entries,
        staged_stamp,
        root: root.to_string_lossy().into_owned(),
    })
}

#[derive(Clone, Copy)]
pub(crate) enum Untracked {
    All,
    No,
}

pub(crate) fn entries(
    root: &Path,
    untracked: Untracked,
    deadline: Deadline,
) -> Result<(Vec<StatusEntry>, StagedStamp), RepositoryError> {
    let output = git::read(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--find-renames",
            match untracked {
                Untracked::All => "--untracked-files=all",
                Untracked::No => "--untracked-files=no",
            },
        ],
        deadline,
    )?;
    let mut stamp = sha1_smol::Sha1::new();
    let mut stamped = |fields: &[&[u8]]| {
        for field in fields {
            stamp.update(field);
            stamp.update(&[0]);
        }
        stamp.update(b"\n");
    };
    let mut entries = Vec::new();
    let mut fields = output.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        entries.push(match field {
            [] => continue,
            [b'1', b' ', record @ ..] => {
                let [xy, sub, m_head, m_index, _, h_head, h_index, path] = columns::<8>(record)?;
                if staged_status(xy) != b"." {
                    stamped(&[
                        b"1",
                        staged_status(xy),
                        m_head,
                        m_index,
                        h_head,
                        h_index,
                        path,
                    ]);
                }
                StatusEntry::Ordinary {
                    path: git::text(path),
                    submodule: submodule(sub)?,
                    sides: sides(xy)?,
                    index: index_object(m_index, h_index)?,
                }
            }
            [b'2', b' ', record @ ..] => {
                let [xy, sub, m_head, m_index, _, h_head, h_index, _, path] = columns::<9>(record)?;
                let original = fields.next().ok_or_else(git::malformed)?;
                if staged_status(xy) != b"." {
                    stamped(&[
                        b"2",
                        staged_status(xy),
                        m_head,
                        m_index,
                        h_head,
                        h_index,
                        path,
                        original,
                    ]);
                }
                let entry = index_object(m_index, h_index)?.ok_or_else(git::malformed)?;
                let staged = |unstaged, index| {
                    Ok::<_, RepositoryError>(MoveSide::Staged {
                        unstaged: change(unstaged)?,
                        index,
                    })
                };
                let (how, side) = match xy {
                    [b'R', unstaged] => (Moved::Renamed, staged(*unstaged, entry)?),
                    [b'C', unstaged] => (Moved::Copied, staged(*unstaged, entry)?),
                    b".R" => (Moved::Renamed, MoveSide::Unstaged { original: entry }),
                    b".C" => (Moved::Copied, MoveSide::Unstaged { original: entry }),
                    _ => return Err(git::malformed()),
                };
                StatusEntry::Renamed {
                    path: git::text(path),
                    original: git::text(original),
                    how,
                    submodule: submodule(sub)?,
                    side,
                }
            }
            [b'u', b' ', record @ ..] => {
                stamped(&[b"u", record]);
                let [xy, sub, m1, m2, m3, _, h1, h2, h3, path] = columns::<10>(record)?;
                StatusEntry::Unmerged {
                    path: git::text(path),
                    conflict: conflict(xy)?,
                    submodule: submodule(sub)?,
                    stages: Stages {
                        base: index_object(m1, h1)?,
                        ours: index_object(m2, h2)?,
                        theirs: index_object(m3, h3)?,
                    },
                }
            }
            [b'?', b' ', path @ ..] => StatusEntry::Untracked {
                path: git::text(path),
            },
            _ => return Err(git::malformed()),
        });
    }
    Ok((entries, StagedStamp::of(&stamp)))
}

fn staged_status(xy: &[u8]) -> &[u8] {
    xy.get(..1).unwrap_or_default()
}

fn columns<const N: usize>(record: &[u8]) -> Result<[&[u8]; N], RepositoryError> {
    record
        .splitn(N, |byte| *byte == b' ')
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| git::malformed())
}

/// `000000` is no entry.
pub(crate) fn index_object(
    mode: &[u8],
    oid: &[u8],
) -> Result<Option<IndexObject>, RepositoryError> {
    if mode == b"000000" {
        return Ok(None);
    }
    let mode = Mode::parse(mode).ok_or_else(git::malformed)?;
    let oid = Oid::try_from(git::text(oid)).map_err(|_| git::malformed())?;
    Ok(Some(IndexObject { mode, oid }))
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
    worktree_patch_within(path, file, side, Deadline::of(LocalRead::WorktreePatch))
}

pub(crate) fn worktree_patch_within(
    path: &str,
    file: &str,
    side: Side,
    deadline: Deadline,
) -> Result<WorktreePatch, RepositoryError> {
    let root = repository::root(path, deadline)?;
    check(file)?;
    let (entries, _) = entries(&root, Untracked::All, deadline)?;
    let entry = entries
        .iter()
        .find(|entry| lists(entry, file, side))
        .ok_or_else(|| no_changes(file, side))?;
    let changed = |diff: Option<FilePatch>| {
        diff.map(|diff| WorktreePatch::Diff { diff })
            .ok_or_else(|| no_changes(file, side))
    };
    let staged = |detect: &str, paths: &[&str]| {
        let head = head_or_empty_tree(&root, deadline)?;
        tracked(
            &root,
            &["diff-index", "--cached", detect, &head],
            paths,
            file,
            deadline,
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
                let head = head_or_empty_tree(&root, deadline)?;
                tracked(
                    &root,
                    &["diff-index", "--no-renames", &head],
                    &[file],
                    file,
                    deadline,
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
            deadline,
        )?),
        (StatusEntry::Renamed { original, how, .. }, _) => {
            let detect = match how {
                Moved::Renamed => "--find-renames",
                Moved::Copied => "--find-copies-harder",
            };
            changed(match side {
                Side::Staged => staged(detect, &[original, file])?,
                Side::Unstaged => tracked(
                    &root,
                    &["diff-files", detect],
                    &[original, file],
                    file,
                    deadline,
                )?,
            })
        }
        (StatusEntry::Untracked { .. }, _) => {
            untracked(&root, file, deadline)?.ok_or_else(|| no_changes(file, side))
        }
    }
}

/// `--raw` lists a file whose stat changed but whose content did not, because
/// plumbing never refreshes the index, so only the paths `--numstat` counts
/// are kept.
pub(crate) fn worktree_changes(
    root: &Path,
    base: &str,
    deadline: Deadline,
) -> Result<Vec<ChangedFile>, RepositoryError> {
    let output = git::read(
        root,
        &[
            "diff-index",
            "-z",
            "--raw",
            "--numstat",
            "--no-renames",
            base,
            "--",
        ],
        deadline,
    )?;
    let mut listed = Vec::new();
    let mut counted = HashSet::new();
    let mut fields = output.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        match field {
            [] => continue,
            [b':', raw @ ..] => {
                let status = raw.rsplit(|byte| *byte == b' ').next().unwrap_or_default();
                listed.push((status, fields.next().ok_or_else(git::malformed)?));
            }
            numstat => {
                let path = numstat
                    .splitn(3, |byte| *byte == b'\t')
                    .nth(2)
                    .ok_or_else(git::malformed)?;
                counted.insert(path);
            }
        }
    }
    let mut files = listed
        .into_iter()
        .filter(|(status, path)| *status == b"U" || counted.contains(path))
        .map(|(status, path)| {
            Ok(ChangedFile {
                path: git::text(path),
                status: repository::change_status(status)?,
            })
        })
        .collect::<Result<Vec<_>, RepositoryError>>()?;
    let tracked: HashSet<String> = files.iter().map(|file| file.path.clone()).collect();
    files.extend(
        entries(root, Untracked::All, deadline)?
            .0
            .into_iter()
            .filter_map(|entry| match entry {
                StatusEntry::Untracked { path } if !tracked.contains(&path) => Some(ChangedFile {
                    path,
                    status: ChangeStatus::Added,
                }),
                _ => None,
            }),
    );
    Ok(files)
}

pub(crate) fn worktree_file_patch(
    root: &Path,
    base: &str,
    file: &str,
    deadline: Deadline,
) -> Result<Option<FilePatch>, RepositoryError> {
    check(file)?;
    if file.contains(char::REPLACEMENT_CHARACTER) {
        return Err(repository::non_utf8_path());
    }
    if let Some(diff) = tracked(
        root,
        &["diff-index", "--no-renames", base],
        &[file],
        file,
        deadline,
    )? {
        return Ok(Some(diff));
    }
    let untracked_path = entries(root, Untracked::All, deadline)?
        .0
        .iter()
        .any(|entry| matches!(entry, StatusEntry::Untracked { path } if path == file));
    if !untracked_path {
        return Ok(None);
    }
    match untracked(root, file, deadline)? {
        Some(WorktreePatch::Diff { diff }) => Ok(Some(diff)),
        Some(_) => Err(git::malformed()),
        None => Ok(None),
    }
}

pub(crate) fn check(file: &str) -> Result<(), RepositoryError> {
    let components: Vec<_> = Path::new(file).components().collect();
    if components.is_empty()
        || !components
            .iter()
            .all(|component| matches!(component, Component::Normal(_)))
        || file
            .strip_suffix('/')
            .unwrap_or(file)
            .split('/')
            .any(|name| name.is_empty() || name == ".")
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
                    MoveSide::Staged { unstaged, .. } => side == Side::Staged || unstaged.is_some(),
                    MoveSide::Unstaged { .. } => side == Side::Unstaged,
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

fn head_or_empty_tree(root: &Path, deadline: Deadline) -> Result<String, RepositoryError> {
    let head = git::run(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        deadline,
    )?;
    if head.status.success() {
        return Ok(git::line(&head.stdout));
    }
    Ok(git::line(&git::read_with_input(
        root,
        &["hash-object", "-t", "tree", "--stdin"],
        Vec::new(),
        deadline,
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
    deadline: Deadline,
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
    let numstat = git::read(root, &args("--numstat"), deadline)?;
    let Some(binary) = binary_at(&numstat, destination)? else {
        return Ok(None);
    };
    if binary {
        return Ok(Some(FilePatch::Binary));
    }
    Ok(Some(
        match git::read_capped(root, &args("--patch"), PATCH_LIMIT, deadline)? {
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

fn ends_at(section: &[u8], file: &str) -> bool {
    let target = git::quoted("", file);
    let same = format!(
        "diff --git {} {}",
        git::quoted("a/", file),
        git::quoted("b/", file)
    );
    section
        .split(|byte| *byte == b'\n')
        .enumerate()
        .any(|(at, line)| {
            (at == 0 && line == same.as_bytes())
                || line == format!("rename to {target}").as_bytes()
                || line == format!("copy to {target}").as_bytes()
        })
}
