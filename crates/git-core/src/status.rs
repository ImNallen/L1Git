use crate::{
    Conflict, ErrorKind, FilePatch, Head, RepositoryError, StatusCode, StatusEntry, WorktreeStatus,
    git,
    repository::{self, capped_patch},
};
use std::path::{Component, Path};

pub fn worktree_status(path: &str) -> Result<WorktreeStatus, RepositoryError> {
    let root = repository::root(path)?;
    let output = git::read(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-ahead-behind",
            "--find-renames",
            "--untracked-files=all",
        ],
    )?;
    let (head, entries) = parse(&output)?;
    Ok(WorktreeStatus {
        root: root.to_string_lossy().into_owned(),
        head,
        entries,
    })
}

fn parse(output: &[u8]) -> Result<(Head, Vec<StatusEntry>), RepositoryError> {
    let (mut oid, mut branch) = (None, None);
    let mut entries = Vec::new();
    let mut fields = output
        .strip_suffix(&[0])
        .unwrap_or(output)
        .split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        let entry = match field {
            [b'#', b' ', header @ ..] => {
                if let Some(value) = header.strip_prefix(b"branch.oid ") {
                    oid = Some(git::text(value));
                } else if let Some(value) = header.strip_prefix(b"branch.head ") {
                    branch = Some(git::text(value));
                }
                continue;
            }
            [b'1', b' ', record @ ..] => {
                let [xy, .., path] = columns::<8>(record)?;
                let (staged, unstaged) = codes(xy)?;
                StatusEntry::Ordinary {
                    path: git::text(path),
                    staged,
                    unstaged,
                }
            }
            [b'2', b' ', record @ ..] => {
                let [xy, .., path] = columns::<9>(record)?;
                let (staged, unstaged) = codes(xy)?;
                StatusEntry::Renamed {
                    path: git::text(path),
                    original: git::text(fields.next().ok_or_else(git::malformed)?),
                    staged,
                    unstaged,
                }
            }
            [b'u', b' ', record @ ..] => {
                let [xy, .., path] = columns::<10>(record)?;
                StatusEntry::Unmerged {
                    path: git::text(path),
                    conflict: conflict(xy)?,
                }
            }
            [b'?', b' ', path @ ..] => StatusEntry::Untracked {
                path: git::text(path),
            },
            _ => return Err(git::malformed()),
        };
        entries.push(entry);
    }
    let head = match (oid, branch) {
        (Some(oid), Some(branch)) if oid == "(initial)" && branch != "(detached)" => Head::Unborn {
            reference: format!("refs/heads/{branch}"),
        },
        (Some(oid), Some(branch)) if oid != "(initial)" && branch == "(detached)" => {
            Head::Detached { oid }
        }
        (Some(oid), Some(branch)) if oid != "(initial)" => Head::Attached {
            reference: format!("refs/heads/{branch}"),
            oid,
        },
        _ => return Err(git::malformed()),
    };
    Ok((head, entries))
}

fn columns<const N: usize>(record: &[u8]) -> Result<[&[u8]; N], RepositoryError> {
    record
        .splitn(N, |byte| *byte == b' ')
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| git::malformed())
}

fn codes(xy: &[u8]) -> Result<(StatusCode, StatusCode), RepositoryError> {
    let code = |byte| {
        Ok(match byte {
            b'.' => StatusCode::Unmodified,
            b'M' => StatusCode::Modified,
            b'T' => StatusCode::TypeChanged,
            b'A' => StatusCode::Added,
            b'D' => StatusCode::Deleted,
            b'R' => StatusCode::Renamed,
            b'C' => StatusCode::Copied,
            _ => return Err(git::malformed()),
        })
    };
    match xy {
        [staged, unstaged] => Ok((code(*staged)?, code(*unstaged)?)),
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

/// Diffs `file` in the worktree against HEAD, or against the empty tree before
/// the first commit. An untracked file diffs against `/dev/null`.
pub fn worktree_patch(path: &str, file: &str) -> Result<FilePatch, RepositoryError> {
    let root = repository::root(path)?;
    let mut components = Path::new(file).components();
    if !components.all(|component| matches!(component, Component::Normal(_))) || file.is_empty() {
        return Err(no_changes());
    }
    let base = base(&root)?;
    // `git diff` rewrites the index after comparing a file whose stat changed,
    // even with optional locks off. The `diff-index` plumbing never writes it.
    let tracked = |format| {
        [
            "--literal-pathspecs",
            "diff-index",
            "-z",
            format,
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            &base,
            "--",
            file,
        ]
    };
    let numstat = git::read(&root, &tracked("--numstat"))?;
    if let Some(binary) = numstat.split(|byte| *byte == 0).find_map(|record| {
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        match (fields.next(), fields.next(), fields.next()) {
            (Some(added), Some(deleted), Some(changed)) if changed == file.as_bytes() => {
                Some(added == b"-" && deleted == b"-")
            }
            _ => None,
        }
    }) {
        return patch(&root, &tracked("--patch"), binary, &[0]);
    }
    untracked_patch(&root, file)?.ok_or_else(|| {
        if file.contains(char::REPLACEMENT_CHARACTER) {
            RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "L1 Git cannot open diffs for file names that are not valid UTF-8.",
            )
        } else {
            no_changes()
        }
    })
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

fn untracked_patch(root: &Path, file: &str) -> Result<Option<FilePatch>, RepositoryError> {
    let listed = git::run(
        root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            file,
        ],
    )?;
    if !listed.status.success()
        || !listed
            .stdout
            .split(|byte| *byte == 0)
            .any(|listed| listed == file.as_bytes())
    {
        return Ok(None);
    }
    // `--no-index` exits 1 when the files differ, which they always do here.
    let added = |format| {
        [
            "diff",
            "--no-index",
            "-z",
            format,
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
    let numstat = git::read_accepting(root, &added("--numstat"), &[1])?;
    patch(
        root,
        &added("--patch"),
        numstat.starts_with(b"-\t-\t"),
        &[1],
    )
    .map(Some)
}

fn no_changes() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnchangedPath,
        "This file has no uncommitted changes. Refresh the worktree status.",
    )
}

fn patch(
    root: &Path,
    args: &[&str],
    binary: bool,
    exit_codes: &[i32],
) -> Result<FilePatch, RepositoryError> {
    if binary {
        Ok(FilePatch::Binary)
    } else {
        capped_patch(root, args, exit_codes)
    }
}
