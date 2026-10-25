use super::{Change, Direction, Expect, Repo, store, txn::Txn};
use crate::{
    ChangeStatus, ErrorKind, Head, IndexObject, Mode, MoveSide, Moved, Oid, RepositoryError, Sides,
    Stages, StaleReason, StatusEntry,
    git::{self, Write, WriteDeadline},
    status,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::Path,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexEntry {
    mode: Mode,
    oid: Oid,
    stage: u8,
    intent_to_add: bool,
    skip_worktree: bool,
}

const INTENT_TO_ADD: u32 = 0x2000_0000;
const SKIP_WORKTREE: u32 = 0x4000_0000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathChange {
    path: String,
    before: Vec<IndexEntry>,
    after: Vec<IndexEntry>,
}

impl PathChange {
    fn source_and_target(&self, direction: Direction) -> (&[IndexEntry], &[IndexEntry]) {
        match direction {
            Direction::Undo => (&self.after, &self.before),
            Direction::Redo => (&self.before, &self.after),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexChange {
    head: Head,
    paths: Vec<PathChange>,
}

impl IndexChange {
    pub(super) fn objects(&self) -> Vec<Oid> {
        let objects: BTreeSet<&Oid> = self
            .paths
            .iter()
            .flat_map(|path| path.before.iter().chain(&path.after))
            .filter_map(stored)
            .collect();
        objects.into_iter().cloned().collect()
    }

    pub(super) fn touches_skip_worktree(&self) -> bool {
        self.paths
            .iter()
            .flat_map(|path| path.before.iter().chain(&path.after))
            .any(|entry| entry.skip_worktree)
    }
}

/// The object an entry names, unless the repository never needs it from the
/// store: an intent-to-add entry names the empty blob, which Git may never
/// have written, and a submodule entry names a commit in another repository.
fn stored(entry: &IndexEntry) -> Option<&Oid> {
    (!entry.intent_to_add && entry.mode != Mode::Submodule).then_some(&entry.oid)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Seen {
    Absent,
    IntentToAdd,
    /// Status shows an intent-to-add file deleted from disk as `.D` with the
    /// empty blob, so this ignores the intent-to-add flag.
    Staged(IndexObject),
    Conflict(Stages),
}

impl Seen {
    fn matches(&self, fresh: &[IndexEntry]) -> bool {
        let object = |entry: &IndexEntry| IndexObject {
            mode: entry.mode,
            oid: entry.oid.clone(),
        };
        match (self, fresh) {
            (Self::Absent, []) => true,
            (Self::IntentToAdd, [entry]) => entry.stage == 0 && entry.intent_to_add,
            (Self::Staged(seen), [entry]) => entry.stage == 0 && object(entry) == *seen,
            (Self::Conflict(stages), entries) => {
                let at = |stage| {
                    entries
                        .iter()
                        .find(|entry| entry.stage == stage)
                        .map(object)
                };
                entries.iter().all(|entry| entry.stage != 0)
                    && at(1) == stages.base
                    && at(2) == stages.ours
                    && at(3) == stages.theirs
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Command {
    Stage,
    Unstage,
}

impl Command {
    const fn verb(self) -> &'static str {
        match self {
            Self::Stage => "stage",
            Self::Unstage => "unstage",
        }
    }

    /// `reset` is the one unstage command that works on a born and an unborn
    /// HEAD: `restore --staged` cannot resolve an unborn HEAD, and `rm
    /// --cached` refuses a file staged and then edited before the first
    /// commit.
    const fn args(self) -> &'static [&'static str] {
        match self {
            Self::Stage => &[
                "--literal-pathspecs",
                "add",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Self::Unstage => &[
                "--literal-pathspecs",
                "reset",
                "-q",
                "--no-refresh",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
        }
    }
}

struct Plan {
    touched: BTreeSet<String>,
    claims: BTreeMap<String, Seen>,
}

impl Plan {
    fn new(command: Command, entries: &[StatusEntry]) -> Result<Self, RepositoryError> {
        if entries.is_empty() {
            return Err(RepositoryError::new(
                ErrorKind::UnchangedPath,
                "Choose at least one file.",
            ));
        }
        let mut plan = Self {
            touched: BTreeSet::new(),
            claims: BTreeMap::new(),
        };
        for entry in entries {
            for (path, seen) in claims(entry) {
                checked(path, command)?;
                if plan.claims.insert(path.to_owned(), seen).is_some() {
                    return Err(RepositoryError::new(
                        ErrorKind::UnsupportedPath,
                        format!("{path} is listed twice. Refresh the worktree status."),
                    ));
                }
            }
            plan.touched
                .extend(touched(command, entry)?.into_iter().map(str::to_owned));
        }
        Ok(plan)
    }
}

fn checked(path: &str, command: Command) -> Result<(), RepositoryError> {
    status::check(path)?;
    if path.contains(['\0', char::REPLACEMENT_CHARACTER]) {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            format!(
                "L1 Git cannot {} file names that are not valid UTF-8.",
                command.verb()
            ),
        ));
    }
    if command == Command::Stage && path.ends_with('/') {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            format!(
                "L1 Git does not stage the nested repository {path}. Add it as a submodule with Git."
            ),
        ));
    }
    Ok(())
}

fn claims(entry: &StatusEntry) -> Vec<(&str, Seen)> {
    match entry {
        StatusEntry::Ordinary {
            path,
            index: Some(object),
            ..
        } => vec![(path, Seen::Staged(object.clone()))],
        StatusEntry::Ordinary {
            path,
            index: None,
            sides: Sides::Unstaged {
                unstaged: ChangeStatus::Added,
            },
            ..
        } => vec![(path, Seen::IntentToAdd)],
        StatusEntry::Ordinary {
            path, index: None, ..
        }
        | StatusEntry::Untracked { path } => vec![(path, Seen::Absent)],
        StatusEntry::Renamed {
            path,
            original,
            how,
            side: MoveSide::Staged { index, .. },
            ..
        } => {
            let mut claims = vec![(path.as_str(), Seen::Staged(index.clone()))];
            if *how == Moved::Renamed {
                claims.push((original, Seen::Absent));
            }
            claims
        }
        StatusEntry::Renamed {
            path,
            original,
            side: MoveSide::Unstaged { original: object },
            ..
        } => vec![
            (path, Seen::IntentToAdd),
            (original, Seen::Staged(object.clone())),
        ],
        StatusEntry::Unmerged { path, stages, .. } => {
            vec![(path, Seen::Conflict(stages.clone()))]
        }
    }
}

/// A staged rename's original is gone from disk and index, so `git add`
/// would refuse it, and only unstaging names it.
fn touched(command: Command, entry: &StatusEntry) -> Result<Vec<&str>, RepositoryError> {
    let nothing = |path: &str| {
        Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            format!(
                "{path} has nothing to {}. Refresh the worktree status.",
                command.verb()
            ),
        ))
    };
    match (command, entry) {
        (
            Command::Stage,
            StatusEntry::Ordinary {
                path,
                sides: Sides::Unstaged { .. } | Sides::Both { .. },
                ..
            }
            | StatusEntry::Renamed {
                path,
                side: MoveSide::Staged {
                    unstaged: Some(_), ..
                },
                ..
            }
            | StatusEntry::Renamed {
                path,
                how: Moved::Copied,
                side: MoveSide::Unstaged { .. },
                ..
            }
            | StatusEntry::Unmerged { path, .. }
            | StatusEntry::Untracked { path },
        ) => Ok(vec![path]),
        (
            Command::Stage,
            StatusEntry::Renamed {
                path,
                original,
                how: Moved::Renamed,
                side: MoveSide::Unstaged { .. },
                ..
            },
        )
        | (
            Command::Unstage,
            StatusEntry::Renamed {
                path,
                original,
                how: Moved::Renamed,
                side: MoveSide::Staged { .. },
                ..
            },
        ) => Ok(vec![path, original]),
        (
            Command::Unstage,
            StatusEntry::Ordinary {
                path,
                sides: Sides::Staged { .. } | Sides::Both { .. },
                ..
            }
            | StatusEntry::Renamed {
                path,
                how: Moved::Copied,
                side: MoveSide::Staged { .. },
                ..
            },
        ) => Ok(vec![path]),
        (Command::Unstage, StatusEntry::Unmerged { path, .. }) => Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            format!(
                "{path} has a conflict. Unstaging it would silently keep HEAD's version. Stage it to mark it resolved, or resolve it with Git."
            ),
        )),
        (
            Command::Stage,
            StatusEntry::Ordinary { path, .. } | StatusEntry::Renamed { path, .. },
        )
        | (
            Command::Unstage,
            StatusEntry::Ordinary { path, .. }
            | StatusEntry::Renamed { path, .. }
            | StatusEntry::Untracked { path },
        ) => nothing(path),
    }
}

pub(super) fn edit(
    txn: &Txn<'_>,
    expect: &Expect,
    command: Command,
    entries: &[StatusEntry],
) -> Result<Change, RepositoryError> {
    let plan = Plan::new(command, entries)?;
    let head = txn.repo().head(txn.deadline())?;
    if head != expect.head {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved since L1 Git read this worktree. Refresh and try again.",
        ));
    }
    let paths = with_file_ancestors(txn, plan.claims.keys().map(String::as_str))?;
    let before = read(txn, &paths)?;
    for (path, seen) in &plan.claims {
        if !seen.matches(at(&before, path)) {
            return Err(RepositoryError::stale(
                StaleReason::PathChanged,
                format!("{path} changed since L1 Git read it. Refresh and try again."),
            ));
        }
    }
    txn.git(command.args())
        .input(nul_separated(plan.touched.iter().map(String::as_str)))
        .run(txn.deadline())?
        .succeeded()?;
    let after = read(txn, &paths)?;
    let change = between(head, before, after)?;
    if let Some(other) = change
        .paths
        .iter()
        .find(|path| !plan.claims.contains_key(&path.path))
    {
        return Err(RepositoryError::stale(
            StaleReason::PathNotChosen,
            format!(
                "Git would also {} {}, which was not chosen. Refresh, choose it too, and try again.",
                command.verb(),
                other.path
            ),
        ));
    }
    Ok(Change::Index(change))
}

fn between(head: Head, before: Rows, mut after: Rows) -> Result<IndexChange, RepositoryError> {
    let mut paths = Vec::new();
    for (path, before) in before {
        let after = after.remove(&path).unwrap_or_default();
        if before != after {
            paths.push(PathChange {
                path,
                before,
                after,
            });
        }
    }
    paths.extend(after.into_iter().map(|(path, after)| PathChange {
        path,
        before: Vec::new(),
        after,
    }));
    paths.sort_by(|a, b| a.path.cmp(&b.path));
    if paths.is_empty() {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            "Git made no change to the index. Refresh the worktree status.",
        ));
    }
    Ok(IndexChange { head, paths })
}

/// Puts the recorded entries of `direction`'s target into the copy. Returns
/// whether the copy changed: a repeated step finds the index already there.
pub(super) fn restore(
    txn: &Txn<'_>,
    entry: &store::EntryObjects,
    change: &IndexChange,
    direction: Direction,
) -> Result<bool, RepositoryError> {
    if txn.repo().head(txn.deadline())? != change.head {
        return Err(RepositoryError::stale(
            StaleReason::HeadMoved,
            "HEAD moved after this change, so L1 Git cannot undo or redo it exactly. Refresh.",
        ));
    }
    let recorded: BTreeSet<&str> = change.paths.iter().map(|path| path.path.as_str()).collect();
    let paths = with_file_ancestors(txn, recorded.iter().copied())?;
    let current = read(txn, &paths)?;
    let changed_since = |path: &str| {
        RepositoryError::stale(
            StaleReason::PathChanged,
            format!(
                "{path} changed after this change, so L1 Git cannot undo or redo it without losing that edit. Refresh."
            ),
        )
    };
    if let Some(other) = unrecorded(&current, &recorded) {
        return Err(changed_since(other));
    }
    let mut pending = Vec::new();
    for path in &change.paths {
        let (from, to) = path.source_and_target(direction);
        let now = at(&current, &path.path);
        if now == to {
            continue;
        }
        if now != from {
            return Err(changed_since(&path.path));
        }
        pending.push((path.path.as_str(), to));
    }
    if pending.is_empty() {
        return Ok(false);
    }
    let objects: BTreeSet<&Oid> = pending
        .iter()
        .flat_map(|(_, to)| to.iter().filter_map(stored))
        .collect();
    entry.bring_back(txn, objects.into_iter().cloned().collect())?;
    put(txn, &pending)?;
    let written = read(txn, &paths)?;
    let inexact = unrecorded(&written, &recorded).or_else(|| {
        change
            .paths
            .iter()
            .find(|path| at(&written, &path.path) != path.source_and_target(direction).1)
            .map(|path| path.path.as_str())
    });
    if let Some(path) = inexact {
        return Err(RepositoryError::stale(
            StaleReason::PathChanged,
            format!(
                "{path} did not come back exactly, so L1 Git left the index unchanged. Refresh."
            ),
        ));
    }
    Ok(true)
}

/// Whether the worktree's index holds what the change wrote, read without a
/// lock. A crash can leave a write recorded but never published.
pub(super) fn landed(
    repo: &Repo,
    change: &IndexChange,
    deadline: WriteDeadline,
) -> Result<bool, RepositoryError> {
    if repo.head(deadline)? != change.head {
        return Ok(false);
    }
    let paths: Vec<&str> = change.paths.iter().map(|path| path.path.as_str()).collect();
    let rows = rows(&paths, |args| git::read(&repo.root, args, deadline.reads()))?;
    Ok(change
        .paths
        .iter()
        .all(|path| at(&rows, &path.path) == path.after))
}

fn unrecorded<'r>(rows: &'r Rows, recorded: &BTreeSet<&str>) -> Option<&'r str> {
    rows.keys()
        .map(String::as_str)
        .find(|path| !recorded.contains(path))
}

type Rows = BTreeMap<String, Vec<IndexEntry>>;

fn at<'r>(rows: &'r Rows, path: &str) -> &'r [IndexEntry] {
    rows.get(path).map_or(&[], Vec::as_slice)
}

fn nul_separated<'p>(paths: impl IntoIterator<Item = &'p str>) -> Vec<u8> {
    paths
        .into_iter()
        .flat_map(|path| path.bytes().chain([0]))
        .collect()
}

/// Paths per `ls-files` call, so one argument list stays far below the
/// system's limit.
const PATHS_PER_READ: usize = 1000;

/// The index entries at `paths` and below them, keyed by exact path.
fn rows(
    paths: &[&str],
    mut ls_files: impl FnMut(&[&str]) -> Result<Vec<u8>, RepositoryError>,
) -> Result<Rows, RepositoryError> {
    let mut rows = Rows::new();
    for chunk in paths.chunks(PATHS_PER_READ) {
        let mut args = vec![
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "--debug",
            "-z",
            "--",
        ];
        args.extend(chunk);
        for (path, entry) in parse_debug(&ls_files(&args)?)? {
            let entries = rows.entry(path).or_default();
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
    }
    Ok(rows)
}

fn read(txn: &Txn<'_>, paths: &[String]) -> Result<Rows, RepositoryError> {
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    rows(&paths, |args| {
        txn.git(args).uncapped().run(txn.deadline())?.succeeded()
    })
}

/// `paths` and every folder above them that the copy holds as a file, at
/// any stage. Git replaces such an entry without a word when it adds a path
/// below it. Each folder is looked up by exact name with `:<stage>:<path>`,
/// and a name is found unless Git echoes it back as missing, so no answer
/// is matched to a question by its position.
fn with_file_ancestors<'p>(
    txn: &Txn<'_>,
    paths: impl Iterator<Item = &'p str> + Clone,
) -> Result<Vec<String>, RepositoryError> {
    let folders: BTreeSet<&str> = paths
        .clone()
        .flat_map(|path| path.match_indices('/').map(move |(at, _)| &path[..at]))
        .collect();
    let mut all: BTreeSet<String> = paths.map(str::to_owned).collect();
    if folders.is_empty() {
        return Ok(all.into_iter().collect());
    }
    fn names(folder: &str) -> impl Iterator<Item = String> + '_ {
        (0..=3).map(move |stage| format!(":{stage}:{folder}"))
    }
    let input: Vec<u8> = folders
        .iter()
        .flat_map(|folder| names(folder))
        .flat_map(|name| name.into_bytes().into_iter().chain([0]))
        .collect();
    let output = txn
        .git(&["cat-file", "--batch-check=%(objectname)", "-Z"])
        .input(input)
        .uncapped()
        .run(txn.deadline())?
        .succeeded()?;
    let missing: BTreeSet<&[u8]> = output
        .split(|byte| *byte == 0)
        .filter_map(|answer| answer.strip_suffix(b" missing"))
        .collect();
    all.extend(
        folders
            .into_iter()
            .filter(|folder| names(folder).any(|name| !missing.contains(name.as_bytes())))
            .map(str::to_owned),
    );
    Ok(all.into_iter().collect())
}

fn put(txn: &Txn<'_>, targets: &[(&str, &[IndexEntry])]) -> Result<(), RepositoryError> {
    let null_oid = &txn.repo().null_oid;
    let mut info = Vec::new();
    for (path, _) in targets {
        info.extend(format!("0 {null_oid}\t{path}\0").bytes());
    }
    for (path, entries) in targets {
        for entry in entries.iter().filter(|entry| !entry.intent_to_add) {
            info.extend(
                format!(
                    "{} {} {}\t{path}\0",
                    entry.mode.octal(),
                    entry.oid.as_str(),
                    entry.stage
                )
                .bytes(),
            );
        }
    }
    txn.git(&["update-index", "-z", "--index-info"])
        .input(info)
        .run(txn.deadline())?
        .succeeded()?;
    let intent: Vec<(&str, Mode)> = targets
        .iter()
        .filter_map(|(path, entries)| {
            let entry = entries.iter().find(|entry| entry.intent_to_add)?;
            Some((*path, entry.mode))
        })
        .collect();
    if !intent.is_empty() {
        add_intent(txn, &intent)?;
    }
    let skipped = nul_separated(
        targets
            .iter()
            .filter(|(_, entries)| entries.iter().any(|entry| entry.skip_worktree))
            .map(|(path, _)| *path),
    );
    if !skipped.is_empty() {
        txn.git(&["update-index", "-z", "--skip-worktree", "--stdin"])
            .input(skipped)
            .run(txn.deadline())?
            .succeeded()?;
    }
    Ok(())
}

/// `git add -N` needs a file at the path, which may be gone from the
/// worktree. So Git adds placeholders of the recorded mode from a private
/// work tree, and the worktree is never touched.
fn add_intent(txn: &Txn<'_>, targets: &[(&str, Mode)]) -> Result<(), RepositoryError> {
    let tree = txn.scratch("intent");
    let _ = fs::remove_dir_all(&tree);
    let result = placeholders(&tree, targets).and_then(|()| {
        let git_dir = format!("--git-dir={}", txn.repo().git_dir.display());
        let work_tree = format!("--work-tree={}", tree.display());
        Write::new(
            txn,
            &tree,
            &[
                &git_dir,
                &work_tree,
                "-c",
                "core.fsmonitor=false",
                "--literal-pathspecs",
                "add",
                "--intent-to-add",
                "--force",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
        )
        .input(nul_separated(targets.iter().map(|(path, _)| *path)))
        .run(txn.deadline())?
        .succeeded()
        .map(drop)
    });
    let _ = fs::remove_dir_all(&tree);
    result
}

fn placeholders(tree: &Path, targets: &[(&str, Mode)]) -> Result<(), RepositoryError> {
    let failed = |error: io::Error| {
        RepositoryError::new(
            ErrorKind::GitFailed,
            format!("L1 Git could not prepare an intent-to-add entry: {error}"),
        )
    };
    for (path, mode) in targets {
        let file = tree.join(path);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(failed)?;
        }
        placeholder(&file, *mode).map_err(failed)?;
    }
    Ok(())
}

#[cfg(unix)]
fn placeholder(file: &Path, mode: Mode) -> io::Result<()> {
    use std::os::unix::fs::{PermissionsExt, symlink};
    match mode {
        Mode::Symlink => symlink("placeholder", file),
        Mode::Executable => {
            fs::write(file, b"")?;
            fs::set_permissions(file, fs::Permissions::from_mode(0o755))
        }
        Mode::File | Mode::Submodule => fs::write(file, b""),
    }
}

#[cfg(not(unix))]
fn placeholder(file: &Path, _mode: Mode) -> io::Result<()> {
    fs::write(file, b"")
}

/// Parses `ls-files --stage --debug -z`. Each entry line,
/// `<mode> <oid> <stage>\t<path>`, ends in NUL, and its debug lines follow,
/// each starting with two spaces and ending in a newline, the last holding
/// `flags: <hex>`. A path can hold a newline, so only lines that start with
/// two spaces are debug lines.
fn parse_debug(output: &[u8]) -> Result<Vec<(String, IndexEntry)>, RepositoryError> {
    let mut parsed = Vec::new();
    let mut open: Option<(String, Mode, Oid, u8)> = None;
    for mut piece in output.split(|byte| *byte == 0) {
        let mut flags = None;
        while let Some(rest) = piece.strip_prefix(b"  ") {
            let end = rest
                .iter()
                .position(|byte| *byte == b'\n')
                .ok_or_else(git::malformed)?;
            if let Some(at) = rest[..end]
                .windows(7)
                .position(|window| window == b"flags: ")
            {
                let hex = git::text(&rest[at + 7..end]);
                flags = Some(u32::from_str_radix(hex.trim(), 16).map_err(|_| git::malformed())?);
            }
            piece = &rest[end + 1..];
        }
        if let Some(flags) = flags {
            let (path, mode, oid, stage) = open.take().ok_or_else(git::malformed)?;
            parsed.push((
                path,
                IndexEntry {
                    mode,
                    oid,
                    stage,
                    intent_to_add: flags & INTENT_TO_ADD != 0,
                    skip_worktree: flags & SKIP_WORKTREE != 0,
                },
            ));
        }
        if piece.is_empty() {
            continue;
        }
        if open.is_some() {
            return Err(git::malformed());
        }
        let tab = piece
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(git::malformed)?;
        let [mode, oid, stage] = piece[..tab].split(|byte| *byte == b' ').collect::<Vec<_>>()[..]
        else {
            return Err(git::malformed());
        };
        let IndexObject { mode, oid } =
            status::index_object(mode, oid)?.ok_or_else(git::malformed)?;
        let stage = match stage {
            [digit @ b'0'..=b'3'] => digit - b'0',
            _ => return Err(git::malformed()),
        };
        open = Some((git::text(&piece[tab + 1..]), mode, oid, stage));
    }
    if open.is_some() {
        return Err(git::malformed());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

    fn entry(stage: u8, intent_to_add: bool) -> IndexEntry {
        IndexEntry {
            mode: Mode::File,
            oid: Oid::try_from(OID.to_owned()).unwrap(),
            stage,
            intent_to_add,
            skip_worktree: false,
        }
    }

    #[test]
    fn parses_debug_records_whose_paths_hold_newlines() {
        let debug = "  ctime: 0:0\n  mtime: 0:0\n  dev: 0\tino: 0\n  uid: 0\tgid: 0\n  size: 0\tflags: 20004000\n";
        let plain = debug.replace("20004000", "1000");
        let output = format!("100644 {OID} 0\tnew\nline\0{debug}100644 {OID} 1\tx\0{plain}");
        assert_eq!(
            parse_debug(output.as_bytes()).unwrap(),
            [
                ("new\nline".to_owned(), entry(0, true)),
                ("x".to_owned(), entry(1, false)),
            ]
        );
        assert!(parse_debug(format!("100644 {OID} 0\tx\0").as_bytes()).is_err());
    }

    #[test]
    fn a_staged_blob_matches_an_intent_to_add_entry_deleted_from_disk() {
        let object = IndexObject {
            mode: Mode::File,
            oid: Oid::try_from(OID.to_owned()).unwrap(),
        };
        assert!(Seen::Staged(object.clone()).matches(&[entry(0, true)]));
        assert!(Seen::Staged(object).matches(&[entry(0, false)]));
        assert!(Seen::IntentToAdd.matches(&[entry(0, true)]));
        assert!(!Seen::IntentToAdd.matches(&[entry(0, false)]));
        assert!(!Seen::Absent.matches(&[entry(0, true)]));
    }
}
