use super::{
    Applied, Change, Direction, EntryId, Expect, Operation, Repo, Restored, index,
    partial::{self, Part},
    store::{self, EntryObjects, LockedStore, Log},
    txn::{Published, Txn},
};
use crate::{
    ChangeStatus, ErrorKind, IndexObject, MoveSide, RepositoryError, Sides, StaleReason,
    StatusEntry,
    git::{self, WriteDeadline},
    status,
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

impl DiscardChange {
    fn tracked(&self) -> Vec<&str> {
        self.paths
            .iter()
            .filter(|discarded| discarded.after != Content::Absent)
            .map(|discarded| discarded.path.as_str())
            .collect()
    }
}

impl Discarded {
    fn held(&self) -> String {
        let path = &self.path;
        match &self.before {
            Content::Absent => format!("{path} did not exist"),
            Content::File { copy, .. } => format!("{path} matched the copy {copy}"),
            Content::Symlink { target } => {
                format!("{path} was a link to {}", String::from_utf8_lossy(target))
            }
        }
    }

    const fn source_and_target(&self, direction: Direction) -> (&Content, &Content) {
        match direction {
            Direction::Undo => (&self.after, &self.before),
            Direction::Redo => (&self.before, &self.after),
        }
    }
}

/// File bytes are copied raw, so no Git filter or line-ending rule touches them.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Seen<'e> {
    Tracked(&'e IndexObject),
    Untracked,
}

#[derive(Debug, PartialEq, Eq)]
struct Target<'e> {
    path: &'e str,
    seen: Seen<'e>,
    on_disk: bool,
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
            on_disk: unstaged != ChangeStatus::Deleted,
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
            on_disk: true,
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

/// Paths per Git call, so one argument list stays far below the system's
/// limit.
const PATHS_PER_READ: usize = 1000;

fn reported_now(
    root: &Path,
    targets: &[Target<'_>],
    deadline: WriteDeadline,
) -> Result<(), RepositoryError> {
    for chunk in targets.chunks(PATHS_PER_READ) {
        let paths: Vec<&str> = chunk.iter().map(|target| target.path).collect();
        let (fresh, _) =
            status::entries_of(root, status::Untracked::All, Some(&paths), deadline.reads())?;
        let now: BTreeMap<&str, Target<'_>> = fresh
            .iter()
            .filter_map(|entry| target(entry).ok())
            .map(|now| (now.path, now))
            .collect();
        if let Some(target) = chunk
            .iter()
            .find(|target| now.get(target.path) != Some(target))
        {
            return Err(changed(target.path));
        }
    }
    Ok(())
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
    repo.head_as_seen(expect, deadline)?;
    let paths: Vec<&str> = targets.iter().map(|target| target.path).collect();
    let rows = index::read(&txn)?;
    let stats = guard(&repo.root, &rows, &paths)?;
    // Status shows a deleted intent-to-add file with the empty blob, so only
    // the index's flags catch that one.
    if let Some(target) = targets.iter().find(|target| {
        index::at(&rows, target.path)
            .iter()
            .any(|entry| entry.intent_to_add)
    }) {
        return Err(added_with_intent(target.path));
    }
    reported_now(&repo.root, &targets, deadline)?;
    let scratch = Scratch::new(&txn)?;
    let tracked: Vec<&str> = targets
        .iter()
        .filter(|target| matches!(target.seen, Seen::Tracked(_)))
        .map(|target| target.path)
        .collect();
    let checkout = scratch.0.join("checkout");
    if !tracked.is_empty() {
        let prefix = checkout_prefix(&checkout);
        txn.git(&["checkout-index", &prefix, "-f", "-z", "--stdin"])
            .lazy_fetch_unprompted()
            .input(index::nul_separated(tracked.iter().copied()))
            .run(deadline)?
            .succeeded()?;
    }
    let landings: Vec<Landing<'_>> = targets
        .iter()
        .zip(stats)
        .map(|(target, stat)| Landing {
            path: target.path,
            stat,
            after: match target.seen {
                Seen::Tracked(_) => After::Checkout,
                Seen::Untracked => After::Absent,
            },
        })
        .collect();
    land(txn, store, log, operation, &rows, &checkout, &landings)
}

pub(super) fn discard_part(
    repo: &Repo,
    store: &LockedStore,
    log: &Log,
    deadline: WriteDeadline,
    expect: &Expect,
    operation: &Operation,
    part: &Part<'_>,
) -> Result<(Applied, Option<Published>), RepositoryError> {
    let path = part.path();
    let txn = Txn::begin(repo, deadline)?;
    repo.head_as_seen(expect, deadline)?;
    let rows = index::read(&txn)?;
    let [stat]: [Option<Stat>; 1] = guard(&repo.root, &rows, &[path])?
        .try_into()
        .map_err(|_| git::malformed())?;
    if index::at(&rows, path)
        .iter()
        .any(|entry| entry.intent_to_add)
    {
        return Err(added_with_intent(path));
    }
    let prepared = part.read(&txn)?;
    let scratch = Scratch::new(&txn)?;
    let checkout = scratch.0.join("checkout");
    let after = if partial::revert(&txn, &rows, part, prepared, &checkout)? {
        if let Some(stat) = &stat {
            set_permissions(&checkout.join(path), stat.mode & 0o7777)
                .map_err(|error| failed(path, &error))?;
        }
        After::Checkout
    } else {
        After::Absent
    };
    land(
        txn,
        store,
        log,
        operation,
        &rows,
        &checkout,
        &[Landing { path, stat, after }],
    )
}

pub(super) fn checkout_prefix(checkout: &Path) -> String {
    let mut prefix = checkout.as_os_str().to_owned();
    prefix.push("/");
    format!("--prefix={}", prefix.to_string_lossy())
}

enum After {
    Absent,
    Checkout,
}

struct Landing<'p> {
    path: &'p str,
    stat: Option<Stat>,
    after: After,
}

fn land(
    txn: Txn<'_>,
    store: &LockedStore,
    log: &Log,
    operation: &Operation,
    rows: &index::Rows,
    checkout: &Path,
    landings: &[Landing<'_>],
) -> Result<(Applied, Option<Published>), RepositoryError> {
    let root = &txn.repo().root;
    let (applied, mut discard, recorded) = store.record_with(&txn, log, operation, |entry| {
        let files = entry.files();
        store::private_folder()
            .create(&files)
            .map_err(|error| failed("the undo history", &error))?;
        let paths = landings
            .iter()
            .enumerate()
            .map(|(at, landing)| {
                let before = capture(root, landing.path, &files, format!("{at}.before"))?;
                let after = match landing.after {
                    After::Checkout => {
                        capture(checkout, landing.path, &files, format!("{at}.after"))?
                    }
                    After::Absent => Content::Absent,
                };
                Ok(Discarded {
                    path: landing.path.to_owned(),
                    before,
                    after,
                })
            })
            .collect::<Result<_, RepositoryError>>()?;
        Ok(DiscardChange { paths })
    })?;
    let mut placed = 0;
    let failure: Option<RepositoryError> = discard
        .paths
        .iter()
        .zip(landings)
        .try_for_each(|(discarded, landing)| {
            before_placing(&discarded.path);
            unchanged(root, &discarded.path, &landing.stat)?;
            place(
                root,
                applied.id,
                &discarded.path,
                &discarded.after,
                &checkout.join(&discarded.path),
            )?;
            placed += 1;
            Ok(())
        })
        .err();
    let Some(refusal) = failure else {
        refresh(&txn, rows, &discard.tracked());
        let published = txn.commit_recorded(recorded, &Change::Discard(discard));
        return Ok((applied, published.ok()));
    };
    if placed == 0 {
        return Err(refusal);
    }
    discard.paths.truncate(placed);
    let done = match recorded.replace(&Change::Discard(discard.clone())) {
        Ok(()) => {
            "The files L1 Git already discarded stay discarded, and Undo puts them back.".to_owned()
        }
        Err(unsaved) => {
            let entry = store.entry(applied.id);
            if place_step(&txn, rows, &entry, &discard, Direction::Undo).is_ok() {
                return Err(stopped(refusal, &store::unwritable(unsaved).message));
            }
            let files = entry.files();
            let kept: Vec<String> = discard
                .paths
                .iter()
                .filter(|path| !holds(root, &path.path, &path.before, &files).unwrap_or(false))
                .map(Discarded::held)
                .collect();
            format!(
                "L1 Git could not write its undo history ({unsaved}) or put back what it discarded, so Undo cannot restore it. Before the discard, {}. The copies are in {}.",
                kept.join(", "),
                files.display()
            )
        }
    };
    refresh(&txn, rows, &discard.tracked());
    let _ = txn.commit_recorded(recorded, &Change::Discard(discard));
    Err(stopped(refusal, &done))
}

fn stopped(error: RepositoryError, done: &str) -> RepositoryError {
    RepositoryError::new(
        error.kind,
        format!("{}. {done}", error.message.trim_end_matches('.')),
    )
}

pub(super) fn step(
    txn: &Txn<'_>,
    entry: &EntryObjects,
    change: &DiscardChange,
    direction: Direction,
) -> Result<Restored, RepositoryError> {
    let rows = index::read(txn)?;
    place_step(txn, &rows, entry, change, direction)?;
    if direction == Direction::Undo {
        return Ok(Restored::AlreadyThere);
    }
    refresh(txn, &rows, &change.tracked());
    Ok(Restored::Staged)
}

/// Git trusts an entry's stat data, and when the size it holds differs from
/// the file's, as after a checkout that converted line endings, it reports
/// the file modified without reading it, so `add --refresh` alone cannot
/// clear it. Each entry is written again without stat data first, so Git
/// compares the content. Git never reads the stat data of a skip-worktree
/// or assume-unchanged entry, and writing it again would drop the flag, so
/// those stay as they are. Under `core.ignoreStat`, `update-index` marks
/// each entry it writes assume-unchanged, as `git restore` marks what it
/// checks out, which would hide a later edit, so it runs with that off.
/// `add --refresh` stops at a path the index lacks and refreshes none.
fn refresh(txn: &Txn<'_>, rows: &index::Rows, paths: &[&str]) {
    let paths: Vec<&str> = paths
        .iter()
        .copied()
        .filter(|path| !index::at(rows, path).is_empty())
        .collect();
    if paths.is_empty() {
        return;
    }
    let info: Vec<u8> = paths
        .iter()
        .filter_map(|path| match index::at(rows, path) {
            [entry]
                if entry.stage == 0
                    && !entry.intent_to_add
                    && !entry.skip_worktree
                    && !entry.assume_unchanged =>
            {
                Some(format!(
                    "{} {}\t{path}\0",
                    entry.mode.octal(),
                    entry.oid.as_str()
                ))
            }
            _ => None,
        })
        .flat_map(String::into_bytes)
        .collect();
    let _ = txn
        .git(&[
            "-c",
            "core.ignoreStat=false",
            "update-index",
            "-z",
            "--index-info",
        ])
        .input(info)
        .run(txn.deadline());
    let _ = txn
        .git(&[
            "--literal-pathspecs",
            "add",
            "--refresh",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ])
        .input(index::nul_separated(paths.iter().copied()))
        .run(txn.deadline());
}

fn place_step(
    txn: &Txn<'_>,
    rows: &index::Rows,
    entry: &EntryObjects,
    change: &DiscardChange,
    direction: Direction,
) -> Result<(), RepositoryError> {
    let root = &txn.repo().root;
    let files = entry.files();
    let paths: Vec<&str> = change.paths.iter().map(|path| path.path.as_str()).collect();
    let stats = guard(root, rows, &paths)?;
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
    let mut placed = 0;
    pending
        .iter()
        .zip(&prepared)
        .try_for_each(|((discarded, to, stat), temporary)| {
            before_placing(&discarded.path);
            unchanged(root, &discarded.path, stat)?;
            place(root, entry.id(), &discarded.path, to, temporary)?;
            placed += 1;
            Ok(())
        })
        .map_err(|error| match (placed, direction) {
            (0, _) => error,
            (_, Direction::Undo) => {
                stopped(error, "The files L1 Git already put back stay put back.")
            }
            (_, Direction::Redo) => stopped(
                error,
                "The files L1 Git already discarded again stay discarded.",
            ),
        })
}

#[cfg(test)]
type Hook = Box<dyn FnMut(&str)>;

#[cfg(test)]
thread_local! {
    static BEFORE_PLACING: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn before_placing(path: &str) {
    BEFORE_PLACING.with_borrow_mut(|hook| {
        if let Some(hook) = hook {
            hook(path);
        }
    });
}

#[cfg(not(test))]
const fn before_placing(_path: &str) {}

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

fn guard(
    root: &Path,
    rows: &index::Rows,
    paths: &[&str],
) -> Result<Vec<Option<Stat>>, RepositoryError> {
    let stats = writable_stats(root, paths)?;
    no_other_names(root, rows, paths, &stats)?;
    Ok(stats)
}

/// A case-insensitive disk opens a tracked file through any name it folds
/// to the same one, whatever `core.ignorecase` says, and Git's `icase`
/// pathspecs fold only ASCII.
fn no_other_names(
    root: &Path,
    rows: &index::Rows,
    paths: &[&str],
    stats: &[Option<Stat>],
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
                "{path} and {other} are the same file on this disk, so discarding {path} would change {other}. L1 Git does not discard it."
            )));
        }
    }
    Ok(())
}

/// Each case-insensitive disk folds names its own way, some also across
/// Unicode normalization forms.
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

fn writable_stats(root: &Path, paths: &[&str]) -> Result<Vec<Option<Stat>>, RepositoryError> {
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
            if let Some(other) = stat
                .identity
                .and_then(|identity| files.insert(identity, path))
            {
                return Err(unsupported(format!(
                    "{other} and {path} are the same file on disk. Discard one of them."
                )));
            }
        }
        stats.push(stat);
    }
    Ok(stats)
}

fn unchanged(root: &Path, path: &str, seen: &Option<Stat>) -> Result<(), RepositoryError> {
    if Stat::of(&root.join(path)).map_err(|error| failed(path, &error))? == *seen {
        Ok(())
    } else {
        Err(changed(path))
    }
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

fn place(
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

/// A linked worktree can live on another file system than its Git dir, so
/// the prepared file is copied beside the path first and renamed from there.
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

fn copy_beside(id: EntryId, file: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(format!(".l1git-{id}-"));
    name.push(file.file_name().unwrap_or_default());
    file.with_file_name(name)
}

pub(super) fn remove_copies_beside(root: &Path, id: EntryId, change: &DiscardChange) {
    for discarded in &change.paths {
        let _ = fs::remove_file(copy_beside(id, &root.join(&discarded.path)));
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stat {
    folder: bool,
    identity: Option<(u64, u64)>,
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
            identity: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Coordinator, Limits, git::LocalWrite, worktree_status};
    use std::process::Command;

    struct Repo {
        directory: tempfile::TempDir,
        root: PathBuf,
        coordinator: Coordinator,
    }

    impl Repo {
        fn new(files: &[(&str, &str)]) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap().join("repo");
            fs::create_dir(&root).unwrap();
            let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));
            let repo = Self {
                directory,
                root,
                coordinator,
            };
            repo.git(&["init", "--quiet", "--initial-branch=main"]);
            for (key, value) in [
                ("user.name", "Ada"),
                ("user.email", "ada@example.test"),
                ("commit.gpgSign", "false"),
                ("core.hooksPath", "/dev/null"),
            ] {
                repo.git(&["config", key, value]);
            }
            for (path, contents) in files {
                repo.put(path, contents);
            }
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "--quiet", "-m", "initial"]);
            repo
        }

        fn path(&self) -> &str {
            self.root.to_str().unwrap()
        }

        fn put(&self, path: &str, contents: &str) {
            fs::write(self.root.join(path), contents).unwrap();
        }

        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.root.join(path)).unwrap()
        }

        fn git(&self, args: &[&str]) -> String {
            let mut command = Command::new("git");
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("GIT_") {
                    command.env_remove(key);
                }
            }
            let output = command
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}");
            String::from_utf8(output.stdout).unwrap()
        }

        fn undo(&self) -> PathBuf {
            self.directory.path().join("undo")
        }

        fn request(&self, paths: &[&str]) -> (Operation, Expect) {
            let status = worktree_status(self.path()).unwrap();
            let entries: Vec<StatusEntry> = status
                .entries
                .into_iter()
                .filter(|entry| {
                    paths.contains(
                        &serde_json::to_value(entry).unwrap()["path"]
                            .as_str()
                            .unwrap(),
                    )
                })
                .collect();
            assert_eq!(entries.len(), paths.len(), "{paths:?}");
            (Operation::Discard { entries }, Expect { head: status.head })
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum Editor {
        InPlace,
        Atomic,
    }

    fn hooked<T>(hook: impl FnMut(&str) + 'static, run: impl FnOnce() -> T) -> T {
        BEFORE_PLACING.set(Some(Box::new(hook)));
        let result = run();
        BEFORE_PLACING.set(None);
        result
    }

    fn editing<T>(file: PathBuf, editor: Editor, run: impl FnOnce() -> T) -> T {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        hooked(
            move |path| {
                if path == name {
                    match editor {
                        Editor::InPlace => fs::write(&file, "editor\n").unwrap(),
                        Editor::Atomic => {
                            let saved = file.with_file_name(".editor-save");
                            fs::write(&saved, "editor\n").unwrap();
                            fs::rename(&saved, &file).unwrap();
                        }
                    }
                }
            },
            run,
        )
    }

    fn entries(undo: &Path) -> Vec<PathBuf> {
        fs::read_dir(undo)
            .unwrap()
            .filter_map(|store| fs::read_dir(store.unwrap().path().join("entries")).ok())
            .flatten()
            .map(|entry| entry.unwrap().path())
            .collect()
    }

    fn lock_entries(entries: &[PathBuf], mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        for entry in entries {
            fs::set_permissions(entry, fs::Permissions::from_mode(mode)).unwrap();
        }
    }

    fn stale(error: &RepositoryError) {
        assert_eq!(
            error.kind,
            ErrorKind::StaleView {
                reason: StaleReason::PathChanged
            },
            "{}",
            error.message
        );
    }

    #[test]
    fn keeps_an_edit_that_lands_while_earlier_files_are_discarded() {
        for editor in [Editor::InPlace, Editor::Atomic] {
            let repo = Repo::new(&[("a", "one\n"), ("b", "one\n")]);
            repo.put("a", "two\n");
            repo.put("b", "two\n");
            let (operation, expect) = repo.request(&["a", "b"]);
            let error = editing(repo.root.join("b"), editor, || {
                repo.coordinator.write(repo.path(), &operation, &expect)
            })
            .expect_err("b changed before its turn");
            stale(&error);
            assert_eq!(repo.read("b"), "editor\n", "{editor:?}");
            assert_eq!(repo.read("a"), "one\n", "{editor:?}");

            let kept = repo
                .coordinator
                .undo_history(repo.path())
                .unwrap()
                .undo
                .expect("a was discarded");
            repo.coordinator.undo(repo.path(), kept.id).unwrap();
            assert_eq!(repo.read("a"), "two\n", "{editor:?}");
            assert_eq!(repo.read("b"), "editor\n", "{editor:?}");
        }
    }

    #[test]
    fn undo_keeps_an_edit_that_lands_while_earlier_files_are_put_back() {
        for editor in [Editor::InPlace, Editor::Atomic] {
            let repo = Repo::new(&[("a", "one\n"), ("b", "one\n")]);
            repo.put("a", "two\n");
            repo.put("b", "two\n");
            let (operation, expect) = repo.request(&["a", "b"]);
            let applied = repo
                .coordinator
                .write(repo.path(), &operation, &expect)
                .unwrap();
            let error = editing(repo.root.join("b"), editor, || {
                repo.coordinator.undo(repo.path(), applied.id)
            })
            .expect_err("b changed before its turn");
            stale(&error);
            assert!(
                error.message.contains("already put back"),
                "{}",
                error.message
            );
            assert_eq!(repo.read("b"), "editor\n", "{editor:?}");
            assert_eq!(repo.read("a"), "two\n", "{editor:?}");

            let again = repo
                .coordinator
                .undo(repo.path(), applied.id)
                .expect_err("b holds neither state");
            assert!(again.message.starts_with("b changed"), "{}", again.message);
            assert_eq!(repo.read("b"), "editor\n", "{editor:?}");
        }
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

    #[test]
    fn a_discard_that_cannot_record_where_it_stopped_puts_back_what_it_discarded() {
        let repo = Repo::new(&[("first", "one\n"), ("second", "one\n")]);
        repo.put("first", "two\n");
        repo.put("second", "two\n");
        let (operation, expect) = repo.request(&["first", "second"]);
        let second = repo.root.join("second");
        let undo = repo.undo();
        let error = hooked(
            move |path| {
                if path == "second" {
                    fs::write(&second, "editor\n").unwrap();
                    lock_entries(&entries(&undo), 0o500);
                }
            },
            || repo.coordinator.write(repo.path(), &operation, &expect),
        )
        .expect_err("second changed before its turn");
        lock_entries(&entries(&repo.undo()), 0o700);
        stale(&error);
        assert_eq!(repo.read("first"), "two\n", "{}", error.message);
        assert_eq!(repo.read("second"), "editor\n");
        let history = repo.coordinator.undo_history(repo.path()).unwrap();
        assert_eq!((history.undo, history.redo), (None, None));
    }

    #[test]
    fn a_discard_that_can_neither_record_where_it_stopped_nor_put_back_names_what_it_kept() {
        let repo = Repo::new(&[("first", "one\n"), ("second", "one\n")]);
        repo.put("first", "two\n");
        repo.put("second", "two\n");
        let (operation, expect) = repo.request(&["first", "second"]);
        let (first, second) = (repo.root.join("first"), repo.root.join("second"));
        let undo = repo.undo();
        let mut turns = 0;
        let error = hooked(
            move |path| match path {
                "second" => {
                    fs::write(&second, "editor\n").unwrap();
                    lock_entries(&entries(&undo), 0o500);
                }
                "first" => {
                    turns += 1;
                    if turns == 2 {
                        fs::write(&first, "later\n").unwrap();
                    }
                }
                _ => {}
            },
            || repo.coordinator.write(repo.path(), &operation, &expect),
        )
        .expect_err("second changed before its turn");
        lock_entries(&entries(&repo.undo()), 0o700);
        stale(&error);
        assert_eq!(repo.read("first"), "later\n");
        assert_eq!(repo.read("second"), "editor\n");
        let [entry] = &entries(&repo.undo())[..] else {
            panic!("one entry keeps the discarded bytes");
        };
        let files = entry.join("files");
        assert!(
            error.message.contains("first") && error.message.contains(&files.display().to_string()),
            "{}",
            error.message
        );
        assert!(
            fs::read_dir(&files)
                .unwrap()
                .any(|copy| fs::read(copy.unwrap().path()).unwrap() == b"two\n"),
            "{files:?} keeps what first held"
        );
        assert!(
            repo.coordinator
                .undo_history(repo.path())
                .unwrap()
                .undo
                .is_some()
        );
    }

    #[test]
    fn undo_removes_a_copy_that_a_stopped_placement_left_beside_a_path() {
        let repo = Repo::new(&[("f", "one\n")]);
        repo.put("f", "two\n");
        let (operation, expect) = repo.request(&["f"]);
        let applied = repo
            .coordinator
            .write(repo.path(), &operation, &expect)
            .unwrap();
        let leftover = repo.root.join(format!(".l1git-{}-f", applied.id));
        fs::write(&leftover, "partial copy\n").unwrap();
        repo.coordinator.undo(repo.path(), applied.id).unwrap();
        assert!(!leftover.exists());
        assert_eq!(repo.git(&["status", "--porcelain"]), " M f\n");
    }

    #[test]
    fn the_next_write_removes_copies_that_a_crashed_discard_left_beside_its_paths() {
        let repo = Repo::new(&[("f", "one\n"), ("g", "one\n")]);
        repo.put("f", "two\n");
        repo.put("g", "two\n");
        let (operation, _) = repo.request(&["f"]);
        let mut leftover = None;
        repo.coordinator
            .locked(
                repo.path(),
                LocalWrite::Discard,
                |opened, store, log, deadline| {
                    let txn = Txn::begin(&opened, deadline)?;
                    let (applied, _, recorded) =
                        store.record_with(&txn, &log, &operation, |_| {
                            Ok(DiscardChange {
                                paths: vec![Discarded {
                                    path: "f".to_owned(),
                                    before: Content::Absent,
                                    after: Content::Absent,
                                }],
                            })
                        })?;
                    let file = repo.root.join(format!(".l1git-{}-f", applied.id));
                    fs::write(&file, "partial copy\n").unwrap();
                    leftover = Some(file);
                    std::mem::forget(recorded);
                    std::mem::forget(txn);
                    Ok(())
                },
            )
            .unwrap();
        fs::remove_file(repo.root.join(".git/index.lock")).unwrap();
        let leftover = leftover.unwrap();
        assert!(leftover.exists());

        let (operation, expect) = repo.request(&["g"]);
        repo.coordinator
            .write(repo.path(), &operation, &expect)
            .unwrap();
        assert!(!leftover.exists());
    }
}
