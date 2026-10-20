use crate::{
    ChangeStatus, Conflict, ErrorKind, FilePatch, MoveSide, Moved, PATCH_LIMIT, RepositoryError,
    Side, Sides, StatusEntry, SubmoduleState, WorktreePatch, WorktreeStatus, git,
    repository::{self, text_patch},
};
use std::{
    fs,
    io::{self, BufRead, Read},
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
        let head = base(&root)?;
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
                let head = base(&root)?;
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
    let Some(section) = section_for(&numstat, destination)? else {
        return Ok(None);
    };
    if section.binary {
        return Ok(Some(FilePatch::Binary));
    }
    Ok(Some(
        match git::read_capped(root, &args("--patch"), PATCH_LIMIT)? {
            git::Capped::Within(patch) => text_patch(
                sections(&patch)
                    .nth(section.index)
                    .ok_or_else(git::malformed)?,
            ),
            git::Capped::Over(bytes) => FilePatch::TooLarge { bytes },
        },
    ))
}

struct Section {
    index: usize,
    binary: bool,
}

fn section_for(numstat: &[u8], destination: &str) -> Result<Option<Section>, RepositoryError> {
    let mut fields = numstat.split(|byte| *byte == 0);
    let mut index = 0;
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
            return Ok(Some(Section {
                index,
                binary: added == b"-" && deleted == b"-",
            }));
        }
        index += 1;
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

enum Found {
    File { file: fs::File, executable: bool },
    Link(Vec<u8>),
    Directory,
    Other,
}

fn untracked(root: &Path, file: &str) -> Result<WorktreePatch, RepositoryError> {
    let diff = match open_without_following_links(root, file)
        .map_err(|_| no_changes(file, Side::Unstaged))?
    {
        Found::File {
            file: handle,
            executable,
        } => added_file(
            root,
            file,
            handle,
            if executable { "100755" } else { "100644" },
        )?,
        Found::Link(target) => text_patch(&added_patch(root, file, "120000", &target)?),
        Found::Directory => {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "L1 Git cannot show a diff for a nested repository.",
            ));
        }
        Found::Other => {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "L1 Git can show diffs only for regular files and symbolic links.",
            ));
        }
    };
    Ok(WorktreePatch::Diff { diff })
}

#[cfg(unix)]
fn open_without_following_links(root: &Path, file: &str) -> io::Result<Found> {
    use std::{
        ffi::{CStr, CString},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::fs::PermissionsExt,
        },
    };
    let open_at = |dir: &OwnedFd, name: &CStr, flags: libc::c_int| -> io::Result<OwnedFd> {
        // SAFETY: `dir` is an open descriptor and `name` is NUL-terminated and
        // outlives the call.
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `openat` returned a new descriptor that nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    };
    let names = file
        .trim_end_matches('/')
        .split('/')
        .map(|name| CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput)))
        .collect::<io::Result<Vec<_>>>()?;
    let (name, parents) = names
        .split_last()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut dir = OwnedFd::from(fs::File::open(root)?);
    for parent in parents {
        dir = open_at(&dir, parent, libc::O_RDONLY | libc::O_DIRECTORY)?;
    }
    match open_at(&dir, name, libc::O_RDONLY | libc::O_NONBLOCK) {
        Ok(fd) => {
            let file = fs::File::from(fd);
            let metadata = file.metadata()?;
            Ok(if metadata.is_file() {
                Found::File {
                    executable: metadata.permissions().mode() & 0o100 != 0,
                    file,
                }
            } else if metadata.is_dir() {
                Found::Directory
            } else {
                Found::Other
            })
        }
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            let mut target = vec![0u8; 4096];
            loop {
                // SAFETY: the pointer and length describe `target`, which is
                // writable and outlives the call.
                let length = unsafe {
                    libc::readlinkat(
                        dir.as_raw_fd(),
                        name.as_ptr(),
                        target.as_mut_ptr().cast(),
                        target.len(),
                    )
                };
                let length = usize::try_from(length).map_err(|_| io::Error::last_os_error())?;
                if length < target.len() {
                    target.truncate(length);
                    return Ok(Found::Link(target));
                }
                target.resize(target.len() * 2, 0);
            }
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn open_without_following_links(root: &Path, file: &str) -> io::Result<Found> {
    let path = root.join(file.trim_end_matches('/'));
    let kind = fs::symlink_metadata(&path)?.file_type();
    Ok(if kind.is_symlink() {
        Found::Link(
            fs::read_link(&path)?
                .to_string_lossy()
                .into_owned()
                .into_bytes(),
        )
    } else if kind.is_dir() {
        Found::Directory
    } else if kind.is_file() {
        Found::File {
            file: fs::File::open(&path)?,
            executable: false,
        }
    } else {
        Found::Other
    })
}

/// Git calls a file binary when its first 8000 bytes contain a NUL.
const BINARY_PROBE: usize = 8000;

fn added_file(
    root: &Path,
    file: &str,
    handle: fs::File,
    mode: &str,
) -> Result<FilePatch, RepositoryError> {
    let unreadable = |_| no_changes(file, Side::Unstaged);
    let mut handle = io::BufReader::new(handle);
    let mut kept = Vec::new();
    (&mut handle)
        .take(PATCH_LIMIT as u64 + 1)
        .read_to_end(&mut kept)
        .map_err(unreadable)?;
    if kept[..kept.len().min(BINARY_PROBE)].contains(&0) {
        return Ok(FilePatch::Binary);
    }
    if kept.len() <= PATCH_LIMIT {
        let patch = added_patch(root, file, mode, &kept)?;
        return Ok(if patch.len() <= PATCH_LIMIT {
            text_patch(&patch)
        } else {
            FilePatch::TooLarge {
                bytes: patch.len() as u64,
            }
        });
    }
    let mut size = kept.len() as u64;
    let mut breaks = newlines(&kept);
    let mut last = kept.last().copied();
    loop {
        let chunk = handle.fill_buf().map_err(unreadable)?;
        if chunk.is_empty() {
            break;
        }
        size += chunk.len() as u64;
        breaks += newlines(chunk);
        last = chunk.last().copied();
        let length = chunk.len();
        handle.consume(length);
    }
    let unterminated = u64::from(last != Some(b'\n'));
    let oid = "0".repeat(
        match git::line(&git::read(root, &["rev-parse", "--show-object-format"])?).as_str() {
            "sha256" => 64,
            _ => 40,
        },
    );
    let lines = breaks + unterminated;
    let header = header(file, mode, &oid, lines);
    Ok(FilePatch::TooLarge {
        bytes: header.len() as u64 + size + lines + unterminated * NO_NEWLINE.len() as u64,
    })
}

fn newlines(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|byte| **byte == b'\n').count() as u64
}

const NO_NEWLINE: &str = "\n\\ No newline at end of file\n";

fn added_patch(
    root: &Path,
    file: &str,
    mode: &str,
    content: &[u8],
) -> Result<Vec<u8>, RepositoryError> {
    let oid = git::line(&git::read_with_input(
        root,
        &["hash-object", "--no-filters", "--stdin"],
        content.to_vec(),
    )?);
    let lines = content.split_inclusive(|byte| *byte == b'\n').count() as u64;
    let mut patch = header(file, mode, &oid, lines).into_bytes();
    for line in content.split_inclusive(|byte| *byte == b'\n') {
        patch.push(b'+');
        patch.extend_from_slice(line);
    }
    if !content.is_empty() && !content.ends_with(b"\n") {
        patch.extend_from_slice(NO_NEWLINE.as_bytes());
    }
    Ok(patch)
}

fn header(file: &str, mode: &str, oid: &str, lines: u64) -> String {
    let (old, new) = (quoted("a/", file), quoted("b/", file));
    let mut header = format!(
        "diff --git {old} {new}\nnew file mode {mode}\nindex {}..{oid}\n",
        "0".repeat(oid.len())
    );
    if lines > 0 {
        let tab = if new.contains(' ') { "\t" } else { "" };
        let count = match lines {
            1 => String::new(),
            lines => format!(",{lines}"),
        };
        header.push_str(&format!(
            "--- /dev/null\n+++ {new}{tab}\n@@ -0,0 +1{count} @@\n"
        ));
    }
    header
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

#[cfg(all(test, unix))]
mod tests {
    use super::{Found, open_without_following_links};
    use std::{fs, os::unix::fs::symlink, process::Command};

    #[test]
    fn untracked_reads_never_pass_through_a_symbolic_link() {
        let directory = tempfile::tempdir().unwrap();
        let (root, outside) = (
            directory.path().join("root"),
            directory.path().join("outside"),
        );
        fs::create_dir_all(root.join("real")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("null"), "SECRET\n").unwrap();
        fs::write(root.join("real/file"), "inside\n").unwrap();
        symlink(&outside, root.join("swapped")).unwrap();
        symlink(&outside, root.join("link")).unwrap();
        assert!(
            Command::new("mkfifo")
                .arg(root.join("fifo"))
                .status()
                .unwrap()
                .success()
        );
        assert!(matches!(
            open_without_following_links(&root, "real/file"),
            Ok(Found::File { .. })
        ));
        assert!(open_without_following_links(&root, "swapped/null").is_err());
        assert!(
            matches!(open_without_following_links(&root, "link"), Ok(Found::Link(target)) if target == outside.as_os_str().as_encoded_bytes())
        );
        assert!(matches!(
            open_without_following_links(&root, "fifo"),
            Ok(Found::Other)
        ));
        assert!(matches!(
            open_without_following_links(&root, "real"),
            Ok(Found::Directory)
        ));
    }
}
