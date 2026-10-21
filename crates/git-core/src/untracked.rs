use crate::{
    ErrorKind, FilePatch, PATCH_LIMIT, RepositoryError, WorktreePatch,
    git::{self, Deadline},
    repository::text_patch,
};
use std::{
    fs,
    io::{self, Read},
    path::Path,
};

/// Reads without following links first, so Git's diff can be checked against worktree bytes.
pub(crate) fn untracked(
    root: &Path,
    file: &str,
    deadline: Deadline,
) -> Result<Option<WorktreePatch>, RepositoryError> {
    let found = match open_without_following_links(root, file) {
        Ok(found) => found,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unreadable(error)),
    };
    let diff = match found {
        Found::File {
            file: handle,
            executable,
        } => regular(root, file, handle, executable, deadline)?,
        Found::Link(target) => {
            let oid = hash(root, &["--no-filters"], target.clone(), deadline)?;
            text_patch(&link_patch(file, &oid, &target))
        }
        Found::Directory if file.ends_with('/') => {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "L1 Git cannot show a diff for a nested repository.",
            ));
        }
        Found::Directory | Found::Changed => return Err(changed()),
        Found::Other => {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "L1 Git can show diffs only for regular files and symbolic links.",
            ));
        }
    };
    Ok(Some(WorktreePatch::Diff { diff }))
}

fn unreadable(error: io::Error) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnreadablePath,
        format!("L1 Git could not read this file ({error}). Check its permissions, then refresh."),
    )
}

fn changed() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnreadablePath,
        "This file changed while L1 Git was reading it. Refresh the worktree status.",
    )
}

/// Git opens the path again for the blob id and again for the shown text, so
/// both are checked against the bytes read here. Git takes attributes from the
/// working tree, not the index, and a clean filter must give the same output
/// on each run.
fn regular(
    root: &Path,
    file: &str,
    mut handle: fs::File,
    executable: bool,
    deadline: Deadline,
) -> Result<FilePatch, RepositoryError> {
    let size = handle.metadata().map_err(unreadable)?.len();
    if size > PATCH_LIMIT as u64 {
        return Ok(FilePatch::TooLarge { bytes: size });
    }
    let mut read_without_links = Vec::new();
    (&mut handle)
        .take(PATCH_LIMIT as u64 + 1)
        .read_to_end(&mut read_without_links)
        .map_err(unreadable)?;
    if read_without_links.len() > PATCH_LIMIT {
        return Ok(FilePatch::TooLarge {
            bytes: read_without_links.len() as u64,
        });
    }
    // Git reads standard input for a bare `-`.
    let given = if file == "-" { "./-" } else { file };
    let run = git::run_capped(
        root,
        &[
            "-c",
            "core.safecrlf=false",
            "diff",
            "--no-index",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--full-index",
            "--no-textconv",
            "--no-ext-diff",
            "--",
            "/dev/null",
            given,
        ],
        PATCH_LIMIT,
        deadline,
    )?;
    if !matches!(run.code, Some(0 | 1)) {
        let stderr = run.stderr();
        return Err(if stderr.is_empty() {
            git::read_failed()
        } else {
            RepositoryError::new(ErrorKind::GitFailed, stderr)
        });
    }
    let patch = match run.stdout {
        git::Capped::Within(patch) => patch,
        git::Capped::Over(bytes) => return Ok(FilePatch::TooLarge { bytes }),
    };
    let read_nothing = read_without_links.is_empty();
    let oid = hash(
        root,
        &[&format!("--path={file}")],
        read_without_links,
        deadline,
    )?;
    let read_mode = if executable { "100755" } else { "100644" };
    let body = patch
        .strip_prefix(header(given, read_mode, &oid).as_bytes())
        .ok_or_else(changed)?;
    let binary = format!(
        "Binary files /dev/null and {} differ\n",
        git::quoted("b/", given)
    );
    if body == binary.as_bytes() {
        return Ok(FilePatch::Binary);
    }
    let hunk = match body {
        [] => body,
        _ => body
            .strip_prefix(lead(given).as_bytes())
            .ok_or_else(changed)?,
    };
    let shown = added(hunk).ok_or_else(changed)?;
    // Git shows no lines for an empty file, even when a clean filter adds some.
    let hidden = read_nothing && shown.is_empty();
    if !hidden && hash(root, &["--no-filters"], shown, deadline)? != oid {
        return Err(changed());
    }
    let mode = if executable && file_mode(root, deadline)? {
        "100755"
    } else {
        "100644"
    };
    let mut patch = header(file, mode, &oid).into_bytes();
    if !hunk.is_empty() {
        patch.extend_from_slice(lead(file).as_bytes());
        patch.extend_from_slice(hunk);
    }
    Ok(text_patch(&patch))
}

fn hash(
    root: &Path,
    options: &[&str],
    content: Vec<u8>,
    deadline: Deadline,
) -> Result<String, RepositoryError> {
    let mut args = vec!["-c", "core.safecrlf=false", "hash-object", "--stdin"];
    args.extend(options);
    Ok(git::line(&git::read_with_input(
        root, &args, content, deadline,
    )?))
}

/// `git diff --no-index` prints the executable bit even where `core.fileMode`
/// tells `git add` to ignore it.
fn file_mode(root: &Path, deadline: Deadline) -> Result<bool, RepositoryError> {
    let output = git::run(
        root,
        &["config", "--type=bool", "--get", "core.fileMode"],
        deadline,
    )?;
    match output.status.code() {
        Some(0) => Ok(output.stdout != b"false\n"),
        Some(1) => Ok(true),
        _ => Err(git::malformed()),
    }
}

const NO_NEWLINE: &[u8] = b"\\ No newline at end of file\n";

fn added(hunk: &[u8]) -> Option<Vec<u8>> {
    let mut lines = hunk.split_inclusive(|byte| *byte == b'\n');
    let mut content = Vec::new();
    if lines
        .next()
        .is_some_and(|range| !range.starts_with(b"@@ -0,0 +1"))
    {
        return None;
    }
    for line in lines {
        match line {
            [b'+', rest @ ..] => content.extend_from_slice(rest),
            _ if line == NO_NEWLINE && content.ends_with(b"\n") => {
                content.pop();
            }
            _ => return None,
        }
    }
    Some(content)
}

fn header(file: &str, mode: &str, oid: &str) -> String {
    format!(
        "diff --git {} {}\nnew file mode {mode}\nindex {}..{oid}\n",
        git::quoted("a/", file),
        git::quoted("b/", file),
        "0".repeat(oid.len())
    )
}

fn lead(file: &str) -> String {
    let new = git::quoted("b/", file);
    let tab = if new.contains(' ') { "\t" } else { "" };
    format!("--- /dev/null\n+++ {new}{tab}\n")
}

fn link_patch(file: &str, oid: &str, target: &[u8]) -> Vec<u8> {
    let mut patch = (header(file, "120000", oid) + &lead(file)).into_bytes();
    let count = match target.split_inclusive(|byte| *byte == b'\n').count() {
        1 => String::new(),
        lines => format!(",{lines}"),
    };
    patch.extend_from_slice(format!("@@ -0,0 +1{count} @@\n").as_bytes());
    for line in target.split_inclusive(|byte| *byte == b'\n') {
        patch.push(b'+');
        patch.extend_from_slice(line);
    }
    if !target.ends_with(b"\n") {
        patch.push(b'\n');
        patch.extend_from_slice(NO_NEWLINE);
    }
    patch
}

enum Found {
    Changed,
    File { file: fs::File, executable: bool },
    Link(Vec<u8>),
    Directory,
    Other,
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
    fn retrying(mut call: impl FnMut() -> isize) -> io::Result<isize> {
        loop {
            let result = call();
            if result >= 0 {
                return Ok(result);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    let open_at = |dir: &OwnedFd, name: &CStr, flags: libc::c_int| -> io::Result<OwnedFd> {
        let fd = retrying(|| {
            // SAFETY: `dir` is an open descriptor and `name` is NUL-terminated
            // and outlives the call.
            unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                ) as isize
            }
        })?;
        // SAFETY: `openat` returned a new descriptor that nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd as libc::c_int) })
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
        dir = match open_at(&dir, parent, libc::O_RDONLY | libc::O_DIRECTORY) {
            Ok(dir) => dir,
            Err(error) if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) => {
                return Ok(Found::Changed);
            }
            Err(error) => return Err(error),
        };
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
                let length = match retrying(|| {
                    // SAFETY: the pointer and length describe `target`, which
                    // is writable and outlives the call.
                    unsafe {
                        libc::readlinkat(
                            dir.as_raw_fd(),
                            name.as_ptr(),
                            target.as_mut_ptr().cast(),
                            target.len(),
                        )
                    }
                }) {
                    Ok(length) => length as usize,
                    Err(error) if error.raw_os_error() == Some(libc::EINVAL) => {
                        return Ok(Found::Changed);
                    }
                    Err(error) => return Err(error),
                };
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
fn open_without_following_links(_root: &Path, _file: &str) -> io::Result<Found> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

#[cfg(all(test, unix))]
mod unix_tests {
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
        assert!(matches!(
            open_without_following_links(&root, "swapped/null"),
            Ok(Found::Changed)
        ));
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
