pub(super) use super::files::Stat;
use super::files::{
    Content, DISCARD, DISCARD_WORDS, FileChange, Scratch, capture, changed, check_files,
    copy_beside, failed, guard, holds, place, place_checked, set_permissions, stopped, unchanged,
    unsupported,
};
use super::{
    Applied, Change, Direction, EntryId, Expect, Operation, Repo, Restored, index,
    partial::{self, Part},
    store::{self, EntryObjects, LockedStore, Log},
    txn::{Published, Txn},
};
use crate::{
    ChangeStatus, ErrorKind, IndexObject, MoveSide, RepositoryError, Sides, StatusEntry,
    git::{self, WriteDeadline},
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
    let stats = guard(&repo.root, &rows, &paths, &DISCARD)?;
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
    let checkout = scratch.path().join("checkout");
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
    let [stat]: [Option<Stat>; 1] = guard(&repo.root, &rows, &[path], &DISCARD)?
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
    let checkout = scratch.path().join("checkout");
    let after = partial::check_out_without_picks(&txn, &rows, part, prepared, &checkout)?;
    if let (After::Checkout, Some(stat)) = (&after, &stat) {
        keep_permissions(&checkout.join(path), stat).map_err(|error| failed(path, &error))?;
    }
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

/// The partial patch carries no mode, so the file keeps its own bits.
fn keep_permissions(prepared: &Path, stat: &Stat) -> io::Result<()> {
    set_permissions(prepared, stat.mode & 0o7777)
}

pub(super) fn checkout_prefix(checkout: &Path) -> String {
    let mut prefix = checkout.as_os_str().to_owned();
    prefix.push("/");
    format!("--prefix={}", prefix.to_string_lossy())
}

pub(super) enum After {
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
    let (applied, mut discard, recorded) =
        store.record_with(txn.repo(), log, operation, |entry| {
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
pub(super) fn refresh(txn: &Txn<'_>, rows: &index::Rows, paths: &[&str]) {
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
    let changes: Vec<FileChange> = change
        .paths
        .iter()
        .map(|discarded| FileChange {
            path: discarded.path.clone(),
            before: discarded.before.clone(),
            after: discarded.after.clone(),
        })
        .collect();
    let files = entry.files();
    let pending = check_files(
        &txn.repo().root,
        rows,
        &files,
        &changes,
        direction,
        &DISCARD,
    )?;
    place_checked(
        txn,
        entry.id(),
        &files,
        &pending,
        direction,
        &DISCARD_WORDS,
        before_placing,
    )
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

pub(super) fn remove_copies_beside(root: &Path, id: EntryId, change: &DiscardChange) {
    for discarded in &change.paths {
        let _ = fs::remove_file(copy_beside(id, &root.join(&discarded.path)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Coordinator, Limits, StaleReason, git::LocalWrite, worktree_status};
    use std::{path::PathBuf, process::Command};

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
                        store.record_with(txn.repo(), &log, &operation, |_| {
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
