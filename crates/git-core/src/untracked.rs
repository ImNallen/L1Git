use crate::{
    ErrorKind, FilePatch, PATCH_LIMIT, RepositoryError, Side, WorktreePatch, git,
    repository::text_patch, status::no_changes,
};
use std::{
    fs,
    io::{self, Read},
    path::Path,
};

/// Builds the patch `git add -N` followed by `git diff --full-index` would
/// show for an untracked path, without writing to the repository and without
/// handing the path to Git to open.
pub(crate) fn untracked(root: &Path, file: &str) -> Result<WorktreePatch, RepositoryError> {
    let found =
        open_without_following_links(root, file).map_err(|error| unreadable(file, error))?;
    let diff = match found {
        Found::File {
            file: handle,
            executable,
        } => return regular(root, file, handle, executable),
        Found::Link(target) => {
            let oid = git::line(&git::read_with_input(
                root,
                &["hash-object", "--no-filters", "--stdin"],
                target.clone(),
            )?);
            text_patch(&new_file_patch(file, "120000", &oid, &target))
        }
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

fn unreadable(file: &str, error: io::Error) -> RepositoryError {
    match error.kind() {
        io::ErrorKind::NotFound => no_changes(file, Side::Unstaged),
        _ => RepositoryError::new(
            ErrorKind::UnreadablePath,
            format!(
                "L1 Git could not read this file ({error}). Check its permissions, then refresh."
            ),
        ),
    }
}

/// Git calls content binary when its first 8000 bytes contain a NUL.
const BINARY_PROBE: usize = 8000;

fn regular(
    root: &Path,
    file: &str,
    mut handle: fs::File,
    executable: bool,
) -> Result<WorktreePatch, RepositoryError> {
    let rules = Rules::read(root, file)?;
    if let Some(filter) = rules.filter {
        return Ok(WorktreePatch::Filtered { filter });
    }
    let binary = WorktreePatch::Diff {
        diff: FilePatch::Binary,
    };
    let size = handle
        .metadata()
        .map_err(|error| unreadable(file, error))?
        .len();
    if rules.binary || size > rules.big_file_threshold {
        return Ok(binary);
    }
    let mut kept = Vec::new();
    (&mut handle)
        .take(PATCH_LIMIT as u64 + 1)
        .read_to_end(&mut kept)
        .map_err(|error| unreadable(file, error))?;
    if kept[..kept.len().min(BINARY_PROBE)].contains(&0) {
        return Ok(binary);
    }
    if kept.len() > PATCH_LIMIT || size > PATCH_LIMIT as u64 {
        return Ok(WorktreePatch::Diff {
            diff: FilePatch::TooLarge {
                bytes: size.max(kept.len() as u64),
            },
        });
    }
    let oid = git::line(&git::read_with_input(
        root,
        &[
            "-c",
            "core.safecrlf=false",
            "hash-object",
            "--stdin",
            &format!("--path={file}"),
        ],
        kept.clone(),
    )?);
    let mode = if executable && rules.file_mode {
        "100755"
    } else {
        "100644"
    };
    let patch = new_file_patch(file, mode, &oid, &rules.eol.to_git(&kept));
    Ok(WorktreePatch::Diff {
        diff: if patch.len() > PATCH_LIMIT {
            FilePatch::TooLarge {
                bytes: patch.len() as u64,
            }
        } else {
            text_patch(&patch)
        },
    })
}

/// What Git's attributes and config say about one untracked path.
struct Rules {
    filter: Option<String>,
    binary: bool,
    eol: Eol,
    big_file_threshold: u64,
    file_mode: bool,
}

#[derive(PartialEq)]
enum Attribute {
    Set,
    Unset,
    Unspecified,
    Value(String),
}

impl Rules {
    fn read(root: &Path, file: &str) -> Result<Self, RepositoryError> {
        let output = git::read(
            root,
            &[
                "check-attr",
                "-z",
                "diff",
                "text",
                "eol",
                "crlf",
                "filter",
                "--",
                file,
            ],
        )?;
        let fields: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
        let attribute = |name: &str| {
            fields
                .chunks_exact(3)
                .find(|record| record[1] == name.as_bytes())
                .map_or(Attribute::Unspecified, |record| match record[2] {
                    b"set" => Attribute::Set,
                    b"unset" => Attribute::Unset,
                    b"unspecified" => Attribute::Unspecified,
                    value => Attribute::Value(git::text(value)),
                })
        };
        let config = config(root)?;
        let setting = |key: &str| {
            config
                .iter()
                .rev()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value)
        };
        let drivers_with_clean: Vec<&str> = config
            .iter()
            .filter_map(|(name, _)| {
                let rest = name.strip_prefix("filter.")?;
                rest.strip_suffix(".clean")
                    .or_else(|| rest.strip_suffix(".process"))
            })
            .collect();
        let auto_crlf = match setting("core.autocrlf") {
            Some(Some(value)) if value.eq_ignore_ascii_case("input") => AutoCrlf::Input,
            Some(value) if boolean(value.as_deref()) == Some(true) => AutoCrlf::True,
            _ => AutoCrlf::False,
        };
        Ok(Self {
            filter: match attribute("filter") {
                Attribute::Value(driver) if drivers_with_clean.contains(&driver.as_str()) => {
                    Some(driver)
                }
                _ => None,
            },
            binary: attribute("diff") == Attribute::Unset,
            eol: Eol::decide(
                &attribute("text"),
                &attribute("crlf"),
                &attribute("eol"),
                auto_crlf,
            ),
            big_file_threshold: setting("core.bigfilethreshold")
                .and_then(|value| size(value.as_deref()?))
                .unwrap_or(512 * 1024 * 1024),
            file_mode: setting("core.filemode")
                .and_then(|value| boolean(value.as_deref()))
                .unwrap_or(true),
        })
    }
}

type Setting = (String, Option<String>);

fn config(root: &Path) -> Result<Vec<Setting>, RepositoryError> {
    let output = git::run(
        root,
        &[
            "config",
            "-z",
            "--get-regexp",
            r"^(core\.(autocrlf|filemode|bigfilethreshold)|filter\..*\.(clean|process))$",
        ],
    )?;
    match output.status.code() {
        Some(0) => {}
        Some(1) => return Ok(Vec::new()),
        _ => return Err(git::malformed()),
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(
            |record| match record.iter().position(|byte| *byte == b'\n') {
                Some(at) => (git::text(&record[..at]), Some(git::text(&record[at + 1..]))),
                None => (git::text(record), None),
            },
        )
        .collect())
}

/// Reads a Git boolean. A key with no value means true.
fn boolean(value: Option<&str>) -> Option<bool> {
    let Some(value) = value else {
        return Some(true);
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" => Some(true),
        "false" | "no" | "off" | "" => Some(false),
        number => number.parse::<i64>().ok().map(|number| number != 0),
    }
}

/// Reads a Git size such as `512m`.
fn size(value: &str) -> Option<u64> {
    let value = value.trim();
    let (number, unit) = match value.char_indices().last()? {
        (at, 'k' | 'K') => (&value[..at], 1 << 10),
        (at, 'm' | 'M') => (&value[..at], 1 << 20),
        (at, 'g' | 'G') => (&value[..at], 1 << 30),
        _ => (value, 1),
    };
    number.parse::<u64>().ok()?.checked_mul(unit)
}

#[derive(Clone, Copy)]
enum AutoCrlf {
    False,
    True,
    Input,
}

/// How Git turns working-tree line endings into the content it would stage.
#[derive(Debug, PartialEq)]
enum Eol {
    Keep,
    Text,
    Auto,
}

impl Eol {
    /// Mirrors `convert_attrs` in Git's `convert.c`. Only the direction toward
    /// the repository matters here, and it turns CRLF into LF for every text
    /// action.
    fn decide(text: &Attribute, crlf: &Attribute, eol: &Attribute, auto_crlf: AutoCrlf) -> Self {
        let from = |attribute: &Attribute| match attribute {
            Attribute::Set => Some(Self::Text),
            Attribute::Unset => Some(Self::Keep),
            Attribute::Value(value) if value == "input" => Some(Self::Text),
            Attribute::Value(value) if value == "auto" => Some(Self::Auto),
            _ => None,
        };
        let action = from(text).or_else(|| from(crlf));
        let eol = matches!(eol, Attribute::Value(value) if value == "lf" || value == "crlf");
        match (action, eol) {
            (Some(Self::Keep), _) => Self::Keep,
            (Some(Self::Auto), _) => Self::Auto,
            (_, true) | (Some(Self::Text), false) => Self::Text,
            (None, false) => match auto_crlf {
                AutoCrlf::False => Self::Keep,
                AutoCrlf::True | AutoCrlf::Input => Self::Auto,
            },
        }
    }

    /// Mirrors `crlf_to_git`: auto mode leaves content Git would call binary
    /// alone, and every conversion drops the CR of each CRLF pair.
    fn to_git(&self, content: &[u8]) -> Vec<u8> {
        if *self == Self::Keep || (*self == Self::Auto && looks_binary(content)) {
            return content.to_vec();
        }
        let mut converted = Vec::with_capacity(content.len());
        for (at, byte) in content.iter().enumerate() {
            if !(*byte == b'\r' && content.get(at + 1) == Some(&b'\n')) {
                converted.push(*byte);
            }
        }
        converted
    }
}

/// Mirrors `gather_stats` and `convert_is_binary` in Git's `convert.c`.
fn looks_binary(content: &[u8]) -> bool {
    let (mut lone_cr, mut nul, mut printable, mut nonprintable) = (0u64, 0u64, 0u64, 0u64);
    let mut at = 0;
    while at < content.len() {
        match content[at] {
            b'\r' if content.get(at + 1) == Some(&b'\n') => at += 1,
            b'\r' => lone_cr += 1,
            b'\n' => {}
            127 => nonprintable += 1,
            b'\x08' | b'\t' | b'\x1b' | b'\x0c' => printable += 1,
            0 => {
                nul += 1;
                nonprintable += 1;
            }
            byte if byte < 32 => nonprintable += 1,
            _ => printable += 1,
        }
        at += 1;
    }
    if content.last() == Some(&0x1a) {
        nonprintable = nonprintable.saturating_sub(1);
    }
    lone_cr > 0 || nul > 0 || (printable >> 7) < nonprintable
}

const NO_NEWLINE: &str = "\n\\ No newline at end of file\n";

fn new_file_patch(file: &str, mode: &str, oid: &str, content: &[u8]) -> Vec<u8> {
    let (old, new) = (quoted("a/", file), quoted("b/", file));
    let mut patch = format!(
        "diff --git {old} {new}\nnew file mode {mode}\nindex {}..{oid}\n",
        "0".repeat(oid.len())
    )
    .into_bytes();
    if content.is_empty() {
        return patch;
    }
    let tab = if new.contains(' ') { "\t" } else { "" };
    let count = match content.split_inclusive(|byte| *byte == b'\n').count() {
        1 => String::new(),
        lines => format!(",{lines}"),
    };
    patch.extend_from_slice(
        format!("--- /dev/null\n+++ {new}{tab}\n@@ -0,0 +1{count} @@\n").as_bytes(),
    );
    for line in content.split_inclusive(|byte| *byte == b'\n') {
        patch.push(b'+');
        patch.extend_from_slice(line);
    }
    if !content.ends_with(b"\n") {
        patch.extend_from_slice(NO_NEWLINE.as_bytes());
    }
    patch
}

/// Quotes a path the way Git's diff headers do with `core.quotePath=false`.
pub(crate) fn quoted(prefix: &str, path: &str) -> String {
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

enum Found {
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
                let length = retrying(|| {
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
                })? as usize;
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

#[cfg(test)]
mod tests {
    use super::{Attribute, AutoCrlf, Eol, looks_binary};

    #[test]
    fn line_endings_follow_git_convert_rules() {
        let value = |value: &str| Attribute::Value(value.into());
        let (none, set, unset) = (Attribute::Unspecified, Attribute::Set, Attribute::Unset);
        let (lf, crlf, auto, input) = (value("lf"), value("crlf"), value("auto"), value("input"));
        let cases = [
            (&none, &none, &none, AutoCrlf::False, Eol::Keep),
            (&none, &none, &none, AutoCrlf::Input, Eol::Auto),
            (&none, &none, &none, AutoCrlf::True, Eol::Auto),
            (&set, &none, &none, AutoCrlf::False, Eol::Text),
            (&unset, &none, &lf, AutoCrlf::True, Eol::Keep),
            (&none, &none, &lf, AutoCrlf::False, Eol::Text),
            (&auto, &none, &crlf, AutoCrlf::False, Eol::Auto),
            (&none, &input, &none, AutoCrlf::False, Eol::Text),
        ];
        for (text, crlf, eol, auto_crlf, expected) in cases {
            assert_eq!(Eol::decide(text, crlf, eol, auto_crlf), expected);
        }
        assert_eq!(Eol::Text.to_git(b"a\r\nb\rc\r"), b"a\nb\rc\r");
        assert_eq!(Eol::Auto.to_git(b"a\r\nb\r\n"), b"a\nb\n");
        assert_eq!(Eol::Auto.to_git(b"a\r\nb\rc"), b"a\r\nb\rc");
        assert!(looks_binary(b"a\0b"));
        assert!(!looks_binary(b"plain\r\ntext\n\x1a"));
    }
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
