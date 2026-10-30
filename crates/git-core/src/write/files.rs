use super::{Direction, EntryId, index, txn::Txn};
use crate::{ErrorKind, RepositoryError, StaleReason};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
};

/// The word a refusal uses, so discard and stash share this layer and
/// discard's sentences stay the ones its tests read.
pub(super) struct Verb {
    pub(super) verb: &'static str,
    pub(super) verbing: &'static str,
    pub(super) capital: &'static str,
}

pub(super) const DISCARD: Verb = Verb {
    verb: "discard",
    verbing: "discarding",
    capital: "Discard",
};

pub(super) const STASH: Verb = Verb {
    verb: "stash",
    verbing: "stashing",
    capital: "Stash",
};

pub(super) struct StepWords {
    pub(super) undone: &'static str,
    pub(super) redone: &'static str,
}

pub(super) const DISCARD_WORDS: StepWords = StepWords {
    undone: "The files L1 Git already put back stay put back.",
    redone: "The files L1 Git already discarded again stay discarded.",
};

pub(super) const STASH_WORDS: StepWords = StepWords {
    undone: "The files L1 Git already put back stay put back.",
    redone: "The files L1 Git already changed again stay changed.",
};

pub(super) fn unsupported(message: String) -> RepositoryError {
    RepositoryError::new(ErrorKind::UnsupportedPath, message)
}

pub(super) fn changed(path: &str) -> RepositoryError {
    RepositoryError::stale(
        StaleReason::PathChanged,
        format!("{path} changed since L1 Git read it. Refresh and try again."),
    )
}

pub(super) fn failed(path: &str, error: &io::Error) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        format!("L1 Git could not read or write {path}: {error}"),
    )
}

pub(super) fn stopped(error: RepositoryError, done: &str) -> RepositoryError {
    RepositoryError::new(
        error.kind,
        format!("{}. {done}", error.message.trim_end_matches('.')),
    )
}

/// File bytes are copied raw, so no Git filter or line-ending rule touches them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum Content {
    Absent,
    File { copy: String, permissions: u32 },
    Symlink { target: Vec<u8> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileChange {
    pub(super) path: String,
    pub(super) before: Content,
    pub(super) after: Content,
}

impl FileChange {
    pub(super) fn source_and_target(&self, direction: Direction) -> (&Content, &Content) {
        match direction {
            Direction::Undo => (&self.after, &self.before),
            Direction::Redo => (&self.before, &self.after),
        }
    }
}

pub(super) struct Placement {
    path: String,
    to: Content,
    stat: Option<Stat>,
}

/// Checks every path, and returns only the ones that still need placing.
/// Nothing is written.
pub(super) fn check_files(
    root: &Path,
    rows: &index::Rows,
    files: &Path,
    changes: &[FileChange],
    direction: Direction,
    verb: &Verb,
) -> Result<Vec<Placement>, RepositoryError> {
    if changes.is_empty() {
        return Ok(Vec::new());
    }
    let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
    let stats = guard(root, rows, &paths, verb)?;
    let mut pending = Vec::new();
    for (change, stat) in changes.iter().zip(stats) {
        let (from, to) = change.source_and_target(direction);
        let at = |content| {
            holds(root, &change.path, content, files).map_err(|error| failed(&change.path, &error))
        };
        if at(to)? {
            continue;
        }
        if !at(from)? {
            return Err(RepositoryError::stale(
                StaleReason::PathChanged,
                format!(
                    "{} changed after the {}, so L1 Git cannot undo or redo it without losing that edit. Refresh.",
                    change.path, verb.verb
                ),
            ));
        }
        pending.push(Placement {
            path: change.path.clone(),
            to: to.clone(),
            stat,
        });
    }
    Ok(pending)
}

pub(super) fn place_checked(
    txn: &Txn<'_>,
    id: EntryId,
    files: &Path,
    pending: &[Placement],
    direction: Direction,
    words: &StepWords,
    before_placing: impl Fn(&str),
) -> Result<(), RepositoryError> {
    if pending.is_empty() {
        return Ok(());
    }
    let root = &txn.repo().root;
    let scratch = Scratch::new(txn)?;
    let mut prepared = Vec::new();
    for (at, placement) in pending.iter().enumerate() {
        let temporary = scratch.0.join(at.to_string());
        prepare(&placement.to, files, &temporary)
            .map_err(|error| failed(&placement.path, &error))?;
        prepared.push(temporary);
    }
    let mut placed = 0;
    pending
        .iter()
        .zip(&prepared)
        .try_for_each(|(placement, temporary)| {
            before_placing(&placement.path);
            unchanged(root, &placement.path, &placement.stat)?;
            place(root, id, &placement.path, &placement.to, temporary)?;
            placed += 1;
            Ok(())
        })
        .map_err(|error| match (placed, direction) {
            (0, _) => error,
            (_, Direction::Undo) => stopped(error, words.undone),
            (_, Direction::Redo) => stopped(error, words.redone),
        })
}

pub(super) struct Scratch(PathBuf);

impl Scratch {
    pub(super) fn new(txn: &Txn<'_>) -> Result<Self, RepositoryError> {
        let dir = txn.scratch("files");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).map_err(|error| failed("a scratch folder", &error))?;
        Ok(Self(dir))
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn guard(
    root: &Path,
    rows: &index::Rows,
    paths: &[&str],
    verb: &Verb,
) -> Result<Vec<Option<Stat>>, RepositoryError> {
    let stats = writable_stats(root, paths, verb)?;
    no_other_names(root, rows, paths, &stats, verb)?;
    Ok(stats)
}

fn no_other_names(
    root: &Path,
    rows: &index::Rows,
    paths: &[&str],
    stats: &[Option<Stat>],
    verb: &Verb,
) -> Result<(), RepositoryError> {
    let chosen: BTreeMap<(u64, u64), &str> = paths
        .iter()
        .zip(stats)
        .filter_map(|(path, stat)| Some((stat.as_ref()?.identity?, *path)))
        .collect();
    let folds: BTreeSet<String> = chosen
        .values()
        .map(|path| fold_for_any_disk(path))
        .collect();
    if folds.is_empty() {
        return Ok(());
    }
    let names: BTreeSet<&str> = paths.iter().copied().collect();
    for other in rows.keys().filter_map(|name| str::from_utf8(name).ok()) {
        if names.contains(other) || !folds.contains(&fold_for_any_disk(other)) {
            continue;
        }
        let identity = Stat::of(&root.join(other))
            .ok()
            .flatten()
            .and_then(|stat| stat.identity);
        if let Some(path) = identity.and_then(|identity| chosen.get(&identity)) {
            return Err(unsupported(format!(
                "{path} and {other} are the same file on this disk, so {} {path} would change {other}. L1 Git does not {} it.",
                verb.verbing, verb.verb
            )));
        }
    }
    Ok(())
}

fn fold_for_any_disk(name: &str) -> String {
    if name.is_ascii() {
        return name.to_ascii_lowercase();
    }
    let mut folded = DECOMPOSE.normalize(name).into_owned();
    for _ in 0..FOLD_ROUNDS {
        folded = fold_round(&folded);
    }
    folded
}

const FOLD_ROUNDS: usize = 2;

const DECOMPOSE: icu_normalizer::DecomposingNormalizerBorrowed<'static> =
    icu_normalizer::DecomposingNormalizerBorrowed::new_nfd();

fn fold_round(name: &str) -> String {
    let cased: String = name
        .chars()
        .flat_map(char::to_uppercase)
        .flat_map(char::to_lowercase)
        .collect();
    DECOMPOSE.normalize(&cased).into_owned()
}

fn writable_stats(
    root: &Path,
    paths: &[&str],
    verb: &Verb,
) -> Result<Vec<Option<Stat>>, RepositoryError> {
    let mut files: BTreeMap<(u64, u64), &str> = BTreeMap::new();
    let mut stats = Vec::new();
    for path in paths {
        let mut folder = root.to_path_buf();
        let mut names = path.split('/').peekable();
        while let Some(name) = names.next() {
            folder.push(name);
            if names.peek().is_none() {
                break;
            }
            let shown = folder.strip_prefix(root).unwrap_or(&folder).display();
            match fs::symlink_metadata(&folder) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                Err(error) => return Err(failed(path, &error)),
                Ok(metadata) if !metadata.is_dir() => {
                    return Err(unsupported(format!(
                        "{shown} is a file or a link on disk, so L1 Git cannot write {path} below it. {} or move {shown} first.",
                        verb.capital
                    )));
                }
                Ok(_) => {}
            }
            if fs::symlink_metadata(folder.join(".git")).is_ok() {
                return Err(unsupported(format!(
                    "{path} is inside the nested repository {shown}. L1 Git does not change it."
                )));
            }
        }
        let stat = Stat::of(&root.join(path)).map_err(|error| failed(path, &error))?;
        if let Some(stat) = &stat {
            if stat.folder {
                return Err(unsupported(format!(
                    "{path} is a folder on disk. Move or delete the folder, then {} {path}.",
                    verb.verb
                )));
            }
            if let Some(other) = stat
                .identity
                .and_then(|identity| files.insert(identity, path))
            {
                return Err(unsupported(format!(
                    "{other} and {path} are the same file on disk. {} one of them.",
                    verb.capital
                )));
            }
        }
        stats.push(stat);
    }
    Ok(stats)
}

pub(super) fn unchanged(
    root: &Path,
    path: &str,
    seen: &Option<Stat>,
) -> Result<(), RepositoryError> {
    if Stat::of(&root.join(path)).map_err(|error| failed(path, &error))? == *seen {
        Ok(())
    } else {
        Err(changed(path))
    }
}

pub(super) fn capture(
    root: &Path,
    path: &str,
    files: &Path,
    copy: String,
) -> Result<Content, RepositoryError> {
    let file = root.join(path);
    let captured = match fs::symlink_metadata(&file) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Content::Absent),
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_symlink() => {
            #[cfg(windows)]
            return Err(unsupported(format!(
                "L1 Git cannot discard or stash the symbolic link {path} on Windows because Undo cannot restore it. The link was left unchanged."
            )));
            #[cfg(not(windows))]
            fs::read_link(&file).map(|target| Content::Symlink {
                target: link_bytes(target),
            })
        }
        Ok(metadata) => copy_private(&file, &files.join(&copy)).map(|()| Content::File {
            copy,
            permissions: permissions(&metadata),
        }),
    };
    captured.map_err(|error| failed(path, &error))
}

fn copy_private(from: &Path, to: &Path) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    io::copy(&mut fs::File::open(from)?, &mut options.open(to)?).map(drop)
}

pub(super) fn holds(root: &Path, path: &str, content: &Content, files: &Path) -> io::Result<bool> {
    let file = root.join(path);
    let metadata = match fs::symlink_metadata(&file) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(*content == Content::Absent);
        }
        other => other?,
    };
    match content {
        Content::Absent => Ok(false),
        Content::Symlink { target } => {
            Ok(metadata.is_symlink() && link_bytes(fs::read_link(&file)?) == *target)
        }
        Content::File {
            copy,
            permissions: kept,
        } => Ok(metadata.is_file()
            && permissions(&metadata) == *kept
            && same_bytes(&file, &files.join(copy))?),
    }
}

fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    use std::io::Read;
    let (mut a, mut b) = (fs::File::open(a)?, fs::File::open(b)?);
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let (mut left, mut right) = (vec![0; 64 * 1024], vec![0; 64 * 1024]);
    loop {
        let read = a.read(&mut left)?;
        if read == 0 {
            return Ok(b.read(&mut right[..1])? == 0);
        }
        b.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

fn prepare(content: &Content, files: &Path, temporary: &Path) -> io::Result<()> {
    match content {
        Content::Absent => Ok(()),
        Content::File { copy, permissions } => {
            fs::copy(files.join(copy), temporary)?;
            set_permissions(temporary, *permissions)
        }
        Content::Symlink { target } => symlink(target, temporary),
    }
}

pub(super) fn place(
    root: &Path,
    id: EntryId,
    path: &str,
    content: &Content,
    prepared: &Path,
) -> Result<(), RepositoryError> {
    let file = root.join(path);
    let placed = match content {
        Content::Absent => match fs::remove_file(&file) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
        Content::File { .. } | Content::Symlink { .. } => file
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| match fs::rename(prepared, &file) {
                Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                    rename_across(prepared, &file, &copy_beside(id, &file))
                }
                other => other,
            }),
    };
    placed.map_err(|error| failed(path, &error))
}

fn rename_across(prepared: &Path, file: &Path, beside: &Path) -> io::Result<()> {
    let copied = if fs::symlink_metadata(prepared)?.is_symlink() {
        fs::read_link(prepared).and_then(|target| symlink(&link_bytes(target), beside))
    } else {
        fs::copy(prepared, beside).map(drop)
    };
    let renamed = copied.and_then(|()| fs::rename(beside, file));
    if renamed.is_err() {
        let _ = fs::remove_file(beside);
    }
    renamed
}

pub(super) fn copy_beside(id: EntryId, file: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(format!(".l1git-{id}-"));
    name.push(file.file_name().unwrap_or_default());
    file.with_file_name(name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Stat {
    folder: bool,
    pub(super) identity: Option<(u64, u64)>,
    size: u64,
    pub(super) mode: u32,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Stat {
    pub(super) fn of(file: &Path) -> io::Result<Option<Self>> {
        #[cfg(windows)]
        let read = crate::windows_fs::metadata(file);
        #[cfg(not(windows))]
        let read = fs::symlink_metadata(file);
        let metadata = match read {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            other => other?,
        };
        #[cfg(windows)]
        let (metadata, identity) = metadata;
        let stat = Self::from(&metadata);
        #[cfg(windows)]
        let stat = Self {
            identity: Some(identity),
            ..stat
        };
        Ok(Some(stat))
    }
}

#[cfg(unix)]
impl From<&fs::Metadata> for Stat {
    fn from(metadata: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            folder: metadata.is_dir(),
            identity: Some((metadata.dev(), metadata.ino())),
            size: metadata.size(),
            mode: metadata.mode(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

#[cfg(unix)]
fn permissions(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o7777
}

#[cfg(unix)]
pub(super) fn set_permissions(file: &Path, permissions: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(file, fs::Permissions::from_mode(permissions))
}

#[cfg(unix)]
pub(super) fn link_bytes(target: PathBuf) -> Vec<u8> {
    use std::os::unix::ffi::OsStringExt;
    target.into_os_string().into_vec()
}

#[cfg(unix)]
fn symlink(target: &[u8], link: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(target), link)
}

#[cfg(not(unix))]
impl From<&fs::Metadata> for Stat {
    fn from(metadata: &fs::Metadata) -> Self {
        let since = |time: io::Result<std::time::SystemTime>| {
            time.ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or((0, 0), |since| {
                    (
                        i64::try_from(since.as_secs()).unwrap_or(i64::MAX),
                        i64::from(since.subsec_nanos()),
                    )
                })
        };
        Self {
            folder: metadata.is_dir(),
            identity: None,
            size: metadata.len(),
            mode: u32::from(metadata.permissions().readonly()),
            modified: since(metadata.modified()),
            changed: since(metadata.created()),
        }
    }
}

#[cfg(not(unix))]
fn permissions(metadata: &fs::Metadata) -> u32 {
    u32::from(metadata.permissions().readonly())
}

#[cfg(windows)]
pub(super) fn set_permissions(file: &Path, readonly: u32) -> io::Result<()> {
    let mut permissions = fs::metadata(file)?.permissions();
    permissions.set_readonly(readonly != 0);
    fs::set_permissions(file, permissions)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn set_permissions(_file: &Path, _permissions: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn link_bytes(target: PathBuf) -> Vec<u8> {
    target.to_string_lossy().into_owned().into_bytes()
}

#[cfg(not(unix))]
fn symlink(_target: &[u8], _link: &Path) -> io::Result<()> {
    Err(io::Error::other(
        "L1 Git restores symlinks on macOS and Linux only",
    ))
}

#[cfg(test)]
mod tests {
    use super::fold_for_any_disk;
    use super::fold_round;

    #[cfg(windows)]
    #[test]
    fn refuses_to_capture_a_native_link_before_a_destructive_write() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let link = temp.path().join("link");
        assert!(
            std::process::Command::new("cmd")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap()
                .status
                .success()
        );
        let error = super::capture(temp.path(), "link", temp.path(), "copy".into()).unwrap_err();
        assert_eq!(error.kind, crate::ErrorKind::UnsupportedPath);
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        std::fs::remove_dir(link).unwrap();
    }

    #[test]
    fn every_character_settles_within_the_fold_rounds() {
        for character in (0..=u32::from(char::MAX)).filter_map(char::from_u32) {
            let folded = fold_for_any_disk(&character.to_string());
            assert_eq!(
                fold_round(&folded),
                folded,
                "U+{:04X}",
                u32::from(character)
            );
        }
    }
}
