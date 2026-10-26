use super::{
    Applied, Change, Direction, Expect, Operation, Repo,
    index::{self, IndexEntry},
    store::{EntryObjects, LockedStore, Log},
    txn::{Published, Txn},
};
use crate::{
    ChangeStatus, ErrorKind, IndexObject, MoveSide, RepositoryError, Sides, StaleReason,
    StatusEntry, git::WriteDeadline, status,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscardChange {
    paths: Vec<Discarded>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discarded {
    path: String,
    before: Content,
    after: Content,
}

impl Discarded {
    const fn source_and_target(&self, direction: Direction) -> (&Content, &Content) {
        match direction {
            Direction::Undo => (&self.after, &self.before),
            Direction::Redo => (&self.before, &self.after),
        }
    }
}

/// A path's raw state on disk. A file's bytes are kept as `copy` in the
/// entry's `files` folder, so no filter or line-ending rule ever touches them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Content {
    Absent,
    File { copy: String, permissions: u32 },
    Symlink { target: Vec<u8> },
}

#[derive(Debug, Clone, Copy)]
enum Seen<'e> {
    Tracked(&'e IndexObject),
    Untracked,
}

impl Seen<'_> {
    fn matches(self, fresh: &[IndexEntry]) -> bool {
        match (self, fresh) {
            (Self::Tracked(seen), [entry]) => {
                entry.stage == 0 && entry.mode == seen.mode && entry.oid == seen.oid
            }
            (Self::Untracked, []) => true,
            _ => false,
        }
    }
}

struct Target<'e> {
    path: &'e str,
    seen: Seen<'e>,
    /// Whether the user saw something on disk at the path.
    present: bool,
}

fn unsupported(message: String) -> RepositoryError {
    RepositoryError::new(ErrorKind::UnsupportedPath, message)
}

fn target(entry: &StatusEntry) -> Result<Target<'_>, RepositoryError> {
    let nothing = |path: &str| {
        Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            format!("{path} has no unstaged change to discard. Refresh the worktree status."),
        ))
    };
    let tracked = |path, index, unstaged| {
        Ok(Target {
            path,
            seen: Seen::Tracked(index),
            present: unstaged != ChangeStatus::Deleted,
        })
    };
    match entry {
        StatusEntry::Ordinary {
            path,
            submodule: Some(_),
            ..
        }
        | StatusEntry::Renamed {
            path,
            submodule: Some(_),
            ..
        } => Err(unsupported(format!(
            "{path} is a submodule. L1 Git does not discard changes inside a submodule."
        ))),
        StatusEntry::Ordinary {
            path,
            sides: Sides::Staged { .. },
            ..
        }
        | StatusEntry::Renamed {
            path,
            side: MoveSide::Staged { unstaged: None, .. },
            ..
        } => nothing(path),
        StatusEntry::Ordinary {
            path,
            index: Some(index),
            sides: Sides::Unstaged { unstaged } | Sides::Both { unstaged, .. },
            ..
        } => tracked(path.as_str(), index, *unstaged),
        StatusEntry::Renamed {
            path,
            side:
                MoveSide::Staged {
                    unstaged: Some(unstaged),
                    index,
                },
            ..
        } => tracked(path.as_str(), index, *unstaged),
        StatusEntry::Ordinary {
            path, index: None, ..
        }
        | StatusEntry::Renamed {
            path,
            side: MoveSide::Unstaged { .. },
            ..
        } => Err(added_with_intent(path)),
        StatusEntry::Unmerged { path, .. } => Err(unsupported(format!(
            "{path} has a conflict. Resolve it with Git, or mark it resolved, before you discard it."
        ))),
        StatusEntry::Untracked { path } if path.ends_with('/') => Err(unsupported(format!(
            "{path} is a nested repository. L1 Git does not discard it."
        ))),
        StatusEntry::Untracked { path } => Ok(Target {
            path,
            seen: Seen::Untracked,
            present: true,
        }),
    }
}

fn added_with_intent(path: &str) -> RepositoryError {
    unsupported(format!(
        "{path} was added with git add -N. Unstage it first, then discard it."
    ))
}

fn targets(entries: &[StatusEntry]) -> Result<Vec<Target<'_>>, RepositoryError> {
    if entries.is_empty() {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            "Choose at least one file.",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut targets = Vec::new();
    for entry in entries {
        let target = target(entry)?;
        status::check(target.path)?;
        if target.path.contains(['\0', char::REPLACEMENT_CHARACTER]) {
            return Err(unsupported(
                "L1 Git cannot discard file names that are not valid UTF-8.".to_owned(),
            ));
        }
        if !seen.insert(target.path) {
            return Err(unsupported(format!(
                "{} is listed twice. Refresh the worktree status.",
                target.path
            )));
        }
        targets.push(target);
    }
    Ok(targets)
}

fn changed(path: &str) -> RepositoryError {
    RepositoryError::stale(
        StaleReason::PathChanged,
        format!("{path} changed since L1 Git read it. Refresh and try again."),
    )
}

fn failed(path: &str, error: &io::Error) -> RepositoryError {
    RepositoryError::new(
        ErrorKind::GitFailed,
        format!("L1 Git could not read or write {path}: {error}"),
    )
}

pub(super) fn discard(
    repo: &Repo,
    store: &LockedStore,
    log: &Log,
    deadline: WriteDeadline,
    expect: &Expect,
    operation: &Operation,
    entries: &[StatusEntry],
) -> Result<(Applied, Option<Published>), RepositoryError> {
    let targets = targets(entries)?;
    let txn = Txn::begin(repo, deadline)?;
    if repo.head(deadline)? != expect.head {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved since L1 Git read this worktree. Refresh and try again.",
        ));
    }
    let paths: Vec<&str> = targets.iter().map(|target| target.path).collect();
    let rows = index::read(&txn)?;
    let stats = guard(&repo.root, &paths)?;
    for (target, stat) in targets.iter().zip(&stats) {
        let fresh = index::at(&rows, target.path);
        if fresh.iter().any(|entry| entry.intent_to_add) {
            return Err(added_with_intent(target.path));
        }
        if !target.seen.matches(fresh) || target.present != stat.is_some() {
            return Err(changed(target.path));
        }
    }
    let scratch = Scratch::new(&txn)?;
    let tracked: Vec<&str> = targets
        .iter()
        .filter(|target| matches!(target.seen, Seen::Tracked(_)))
        .map(|target| target.path)
        .collect();
    let checkout = scratch.0.join("checkout");
    if !tracked.is_empty() {
        let mut prefix = checkout.clone().into_os_string();
        prefix.push("/");
        let prefix = format!("--prefix={}", prefix.to_string_lossy());
        txn.git(&["checkout-index", &prefix, "-f", "-z", "--stdin"])
            .lazy_fetch()
            .input(index::nul_separated(tracked.iter().copied()))
            .run(deadline)?
            .succeeded()?;
    }
    let (applied, discard, recorded) = store.record_with(&txn, log, operation, |entry| {
        let files = entry.files();
        fs::create_dir(&files).map_err(|error| failed("the undo history", &error))?;
        let paths = targets
            .iter()
            .enumerate()
            .map(|(at, target)| {
                let before = capture(&repo.root, target.path, &files, format!("{at}.before"))?;
                let after = match target.seen {
                    Seen::Tracked(_) => {
                        capture(&checkout, target.path, &files, format!("{at}.after"))?
                    }
                    Seen::Untracked => Content::Absent,
                };
                Ok(Discarded {
                    path: target.path.to_owned(),
                    before,
                    after,
                })
            })
            .collect::<Result<_, RepositoryError>>()?;
        Ok(DiscardChange { paths })
    })?;
    unchanged(&repo.root, paths.iter().copied().zip(&stats))?;
    let placed = discard.paths.iter().try_for_each(|discarded| {
        place(
            &repo.root,
            &discarded.path,
            &discarded.after,
            &checkout.join(&discarded.path),
        )
    });
    if let Err(error) = placed {
        recorded.confirm();
        return Err(RepositoryError::new(
            error.kind,
            format!(
                "{} The files L1 Git already discarded stay discarded, and Undo puts them back.",
                error.message
            ),
        ));
    }
    if !tracked.is_empty() {
        let _ = txn
            .git(&[
                "--literal-pathspecs",
                "add",
                "--refresh",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ])
            .input(index::nul_separated(tracked.iter().copied()))
            .run(deadline);
    }
    let published = txn
        .commit_recorded(recorded, &Change::Discard(discard))
        .ok();
    Ok((applied, published))
}

/// Puts each path back to its other recorded state. A path already there is
/// left alone, so a step stopped partway finishes when repeated.
pub(super) fn step(
    txn: &Txn<'_>,
    entry: &EntryObjects,
    change: &DiscardChange,
    direction: Direction,
) -> Result<(), RepositoryError> {
    let root = &txn.repo().root;
    let files = entry.files();
    let paths: Vec<&str> = change.paths.iter().map(|path| path.path.as_str()).collect();
    let stats = guard(root, &paths)?;
    let mut pending = Vec::new();
    for (discarded, stat) in change.paths.iter().zip(stats) {
        let (from, to) = discarded.source_and_target(direction);
        let at = |content| {
            holds(root, &discarded.path, content, &files)
                .map_err(|error| failed(&discarded.path, &error))
        };
        if at(to)? {
            continue;
        }
        if !at(from)? {
            return Err(RepositoryError::stale(
                StaleReason::PathChanged,
                format!(
                    "{} changed after the discard, so L1 Git cannot undo or redo it without losing that edit. Refresh.",
                    discarded.path
                ),
            ));
        }
        pending.push((discarded, to, stat));
    }
    if pending.is_empty() {
        return Ok(());
    }
    let scratch = Scratch::new(txn)?;
    let mut prepared = Vec::new();
    for (at, (discarded, to, _)) in pending.iter().enumerate() {
        let temporary = scratch.0.join(at.to_string());
        prepare(to, &files, &temporary).map_err(|error| failed(&discarded.path, &error))?;
        prepared.push(temporary);
    }
    unchanged(
        root,
        pending
            .iter()
            .map(|(discarded, _, stat)| (discarded.path.as_str(), stat)),
    )?;
    pending
        .iter()
        .zip(&prepared)
        .try_for_each(|((discarded, to, _), temporary)| place(root, &discarded.path, to, temporary))
}

/// A scratch folder in the Git dir. `Txn::begin` sweeps one a crash left.
struct Scratch(PathBuf);

impl Scratch {
    fn new(txn: &Txn<'_>) -> Result<Self, RepositoryError> {
        let dir = txn.scratch("discard");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).map_err(|error| failed("a scratch folder", &error))?;
        Ok(Self(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Refuses a path L1 Git must not write: one below a nested repository, a
/// file, or a symlink, one that is a folder, and two names for one file.
/// Answers each path's `lstat` identity, or `None` when it is absent.
fn guard(root: &Path, paths: &[&str]) -> Result<Vec<Option<Stat>>, RepositoryError> {
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
                        "{shown} is a file or a link on disk, so L1 Git cannot write {path} below it. Discard or move {shown} first."
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
                    "{path} is a folder on disk. Move or delete the folder, then discard {path}."
                )));
            }
            if let Some(other) = stat.file().and_then(|file| files.insert(file, path)) {
                return Err(unsupported(format!(
                    "{other} and {path} are the same file on disk. Discard one of them."
                )));
            }
        }
        stats.push(stat);
    }
    Ok(stats)
}

fn unchanged<'p>(
    root: &Path,
    seen: impl IntoIterator<Item = (&'p str, &'p Option<Stat>)>,
) -> Result<(), RepositoryError> {
    for (path, stat) in seen {
        if Stat::of(&root.join(path)).map_err(|error| failed(path, &error))? != *stat {
            return Err(changed(path));
        }
    }
    Ok(())
}

fn capture(
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
            fs::read_link(&file).map(|target| Content::Symlink {
                target: link_bytes(target),
            })
        }
        Ok(metadata) => fs::copy(&file, files.join(&copy)).map(|_| Content::File {
            copy,
            permissions: permissions(&metadata),
        }),
    };
    captured.map_err(|error| failed(path, &error))
}

fn holds(root: &Path, path: &str, content: &Content, files: &Path) -> io::Result<bool> {
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

/// Changes one path in one step: deletes it, or renames the prepared file
/// over it after creating the folders above it.
fn place(
    root: &Path,
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
            .and_then(|()| fs::rename(prepared, &file)),
    };
    placed.map_err(|error| failed(path, &error))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stat {
    folder: bool,
    device: u64,
    inode: u64,
    size: u64,
    mode: u32,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Stat {
    fn of(file: &Path) -> io::Result<Option<Self>> {
        let metadata = match fs::symlink_metadata(file) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            other => other?,
        };
        Ok(Some(Self::from(&metadata)))
    }

    /// `None` where the file system gives no inode numbers.
    fn file(&self) -> Option<(u64, u64)> {
        (self.inode != 0).then_some((self.device, self.inode))
    }
}

#[cfg(unix)]
impl From<&fs::Metadata> for Stat {
    fn from(metadata: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            folder: metadata.is_dir(),
            device: metadata.dev(),
            inode: metadata.ino(),
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
fn set_permissions(file: &Path, permissions: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(file, fs::Permissions::from_mode(permissions))
}

#[cfg(unix)]
fn link_bytes(target: PathBuf) -> Vec<u8> {
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
            device: 0,
            inode: 0,
            size: metadata.len(),
            mode: 0,
            modified: since(metadata.modified()),
            changed: since(metadata.created()),
        }
    }
}

#[cfg(not(unix))]
fn permissions(_metadata: &fs::Metadata) -> u32 {
    0
}

#[cfg(not(unix))]
fn set_permissions(_file: &Path, _permissions: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn link_bytes(target: PathBuf) -> Vec<u8> {
    target.to_string_lossy().into_owned().into_bytes()
}

#[cfg(not(unix))]
fn symlink(_target: &[u8], _link: &Path) -> io::Result<()> {
    Err(io::Error::other(
        "L1 Git restores symlinks on macOS and Linux only",
    ))
}
