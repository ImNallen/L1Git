use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Limits, Operation, RepositoryError, StaleReason,
    StatusEntry, UndoHistory, worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

const HEAD_MOVED: ErrorKind = ErrorKind::StaleView {
    reason: StaleReason::HeadMoved,
};
const PATH_CHANGED: ErrorKind = ErrorKind::StaleView {
    reason: StaleReason::PathChanged,
};
fn not_chosen(paths: &[&str]) -> ErrorKind {
    ErrorKind::StaleView {
        reason: StaleReason::PathNotChosen {
            paths: paths.iter().map(|path| (*path).to_owned()).collect(),
        },
    }
}
const HISTORY_CHANGED: ErrorKind = ErrorKind::StaleView {
    reason: StaleReason::HistoryChanged,
};
const ASSUME_UNCHANGED: u32 = 0x8000;
const INTENT_TO_ADD: u32 = 0x2000_0000;
const SKIP_WORKTREE: u32 = 0x4000_0000;
const STORED_FLAGS: u32 = ASSUME_UNCHANGED | INTENT_TO_ADD | SKIP_WORKTREE;

fn git_command(path: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command.arg("-C").arg(path).args(args);
    command
}

fn git_output(path: &Path, args: &[&str]) -> std::process::Output {
    git_command(path, args)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = git_output(path, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn init(root: &Path) {
    fs::create_dir(root).unwrap();
    git(root, &["init", "--quiet", "--initial-branch=main"]);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("commit.gpgSign", "false"),
        ("core.hooksPath", "/dev/null"),
    ] {
        git(root, &["config", key, value]);
    }
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("repo with spaces");
        init(&root);
        Self { directory, root }
    }

    fn committed(files: &[(&str, &str)]) -> Self {
        let repo = Self::new();
        for (path, contents) in files {
            repo.put(path, contents);
        }
        git(&repo.root, &["add", "--all"]);
        git(&repo.root, &["commit", "--quiet", "-m", "initial"]);
        repo
    }

    fn conflicted() -> Self {
        let repo = Self::committed(&[("shared.txt", "base\n")]);
        repo.git(&["switch", "--quiet", "-c", "theirs"]);
        repo.put("shared.txt", "theirs\n");
        repo.git(&["commit", "--quiet", "-am", "theirs"]);
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("shared.txt", "ours\n");
        repo.git(&["commit", "--quiet", "-am", "ours"]);
        assert!(
            !git_output(&repo.root, &["merge", "--quiet", "theirs"])
                .status
                .success()
        );
        repo
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn undo_dir(&self) -> PathBuf {
        self.directory.path().join("undo")
    }

    fn coordinator(&self) -> Coordinator {
        Coordinator::new(Limits::default(), self.undo_dir())
    }

    fn put(&self, path: &str, contents: &str) {
        let file = self.root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, contents).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn status(&self) -> Vec<String> {
        self.git(&["status", "--porcelain", "-z", "--untracked-files=all"])
            .split('\0')
            .filter(|record| !record.is_empty())
            .map(str::to_owned)
            .collect()
    }

    fn index(&self) -> String {
        self.git(&["ls-files", "--stage", "--debug"])
            .lines()
            .filter(|line| !line.starts_with("  ") || line.contains("flags"))
            .map(|line| match line.split_once("flags:") {
                Some((_, flags)) => format!(
                    "{:x}",
                    u32::from_str_radix(flags.trim(), 16).unwrap() & STORED_FLAGS
                ),
                None => line.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn git_dir_names(&self, keep: impl Fn(&str) -> bool) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.root.join(".git"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| keep(name))
            .collect();
        names.sort();
        names
    }

    fn git_dir_leftovers(&self) -> Vec<String> {
        self.git_dir_names(|name| name == "index.lock" || name.starts_with("l1git-"))
    }

    fn shared_indexes(&self) -> Vec<String> {
        self.git_dir_names(|name| name.starts_with("sharedindex."))
    }

    fn index_info(&self, info: &[u8]) {
        use std::io::Write as _;
        let mut child = git_command(&self.root, &["update-index", "-z", "--index-info"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(info).unwrap();
        assert!(child.wait().unwrap().success());
    }

    fn split(files: &[(&str, &str)], expiry: Option<&str>) -> Self {
        let repo = Self::committed(files);
        repo.git(&["config", "core.splitIndex", "true"]);
        if let Some(expiry) = expiry {
            repo.git(&["config", "splitIndex.sharedIndexExpire", expiry]);
        }
        repo.put("staged", "staged with Git\n");
        repo.git(&["add", "staged"]);
        assert_eq!(repo.shared_indexes().len(), 1);
        repo
    }
}

fn entries(repo: &Repo, paths: &[&str]) -> (Vec<StatusEntry>, Expect) {
    let status = worktree_status(repo.path()).unwrap();
    let entries = status
        .entries
        .into_iter()
        .filter(|entry| paths.contains(&entry_path(entry)))
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), paths.len(), "{paths:?}");
    (entries, Expect { head: status.head })
}

fn entry_path(entry: &StatusEntry) -> &str {
    match entry {
        StatusEntry::Ordinary { path, .. }
        | StatusEntry::Renamed { path, .. }
        | StatusEntry::Unmerged { path, .. }
        | StatusEntry::Untracked { path } => path,
    }
}

fn stage(
    coordinator: &Coordinator,
    repo: &Repo,
    paths: &[&str],
) -> Result<Applied, RepositoryError> {
    let (entries, expect) = entries(repo, paths);
    coordinator.write(repo.path(), &Operation::StageFiles { entries }, &expect)
}

fn unstage(
    coordinator: &Coordinator,
    repo: &Repo,
    paths: &[&str],
) -> Result<Applied, RepositoryError> {
    let (entries, expect) = entries(repo, paths);
    coordinator.write(repo.path(), &Operation::UnstageFiles { entries }, &expect)
}

fn kind(result: Result<Applied, RepositoryError>) -> ErrorKind {
    result.unwrap_err().kind
}

fn round_trip(coordinator: &Coordinator, repo: &Repo, write: impl FnOnce() -> Applied) {
    let before = repo.index();
    let applied = write();
    let after = repo.index();
    assert_ne!(before, after);
    for _ in 0..2 {
        assert_eq!(coordinator.undo(repo.path(), applied.id).unwrap(), applied);
        assert_eq!(repo.index(), before);
    }
    for _ in 0..2 {
        assert_eq!(coordinator.redo(repo.path(), applied.id).unwrap(), applied);
        assert_eq!(repo.index(), after);
    }
    assert!(
        repo.git_dir_leftovers().is_empty(),
        "{:?}",
        repo.git_dir_leftovers()
    );
}

#[test]
fn stages_and_unstages_modified_deleted_and_untracked_paths_and_undoes_each() {
    let repo = Repo::committed(&[("modified.txt", "one\n"), ("deleted.txt", "gone\n")]);
    let coordinator = repo.coordinator();
    repo.put("modified.txt", "two\n");
    fs::remove_file(repo.root.join("deleted.txt")).unwrap();
    repo.put("new.txt", "new\n");
    let paths = ["deleted.txt", "modified.txt", "new.txt"];
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &paths).unwrap()
    });
    assert_eq!(
        repo.status(),
        ["D  deleted.txt", "M  modified.txt", "A  new.txt"]
    );
    round_trip(&coordinator, &repo, || {
        unstage(&coordinator, &repo, &paths).unwrap()
    });
    assert_eq!(
        repo.status(),
        [" D deleted.txt", " M modified.txt", "?? new.txt"]
    );
}

#[test]
fn names_paths_literally_whatever_characters_they_hold() {
    let repo = Repo::committed(&[("x", "x\n"), ("x1", "x1\n"), ("[x]", "bracket\n")]);
    let coordinator = repo.coordinator();
    for path in ["x", "x1", "[x]"] {
        repo.put(path, "edited\n");
    }
    repo.put("x*", "star\n");
    repo.put("a b.txt", "space\n");
    repo.put("new\nline.txt", "newline\n");
    stage(
        &coordinator,
        &repo,
        &["x*", "[x]", "a b.txt", "new\nline.txt"],
    )
    .unwrap();
    assert_eq!(
        repo.status(),
        [
            "M  [x]",
            "A  a b.txt",
            "A  new\nline.txt",
            " M x",
            "A  x*",
            " M x1"
        ]
    );
}

#[test]
fn stages_and_unstages_a_rename_as_both_of_its_paths() {
    let repo = Repo::committed(&[("old.txt", "one\ntwo\nthree\n")]);
    let coordinator = repo.coordinator();
    fs::rename(repo.root.join("old.txt"), repo.root.join("new.txt")).unwrap();
    repo.git(&["add", "--intent-to-add", "new.txt"]);
    assert_eq!(repo.status(), [" R new.txt", "old.txt"]);
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["new.txt"]).unwrap()
    });
    assert_eq!(repo.status(), ["R  new.txt", "old.txt"]);
    round_trip(&coordinator, &repo, || {
        unstage(&coordinator, &repo, &["new.txt"]).unwrap()
    });
    assert_eq!(repo.status(), [" D old.txt", "?? new.txt"]);
}

#[test]
fn refuses_to_unstage_a_conflict_and_stages_it_as_resolved() {
    let repo = Repo::conflicted();
    let coordinator = repo.coordinator();
    let conflicted = repo.index();
    assert_eq!(
        kind(unstage(&coordinator, &repo, &["shared.txt"])),
        ErrorKind::UnsupportedPath
    );
    assert_eq!(repo.index(), conflicted);
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["shared.txt"]).unwrap()
    });
    assert_eq!(repo.status(), ["M  shared.txt"]);
    let applied = coordinator.undo_history(repo.path()).unwrap().undo.unwrap();
    coordinator.undo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.status(), ["UU shared.txt"]);
}

#[test]
fn unstages_before_the_first_commit_even_a_file_edited_after_staging() {
    let repo = Repo::new();
    let coordinator = repo.coordinator();
    repo.put("f", "staged\n");
    repo.git(&["add", "f"]);
    repo.put("f", "edited\n");
    assert_eq!(repo.status(), ["AM f"]);
    round_trip(&coordinator, &repo, || {
        unstage(&coordinator, &repo, &["f"]).unwrap()
    });
    assert_eq!(repo.status(), ["?? f"]);
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["f"]).unwrap()
    });
}

#[test]
fn refuses_a_view_that_changed_and_then_writes_the_fresh_one_once() {
    let repo = Repo::committed(&[("README.md", "one\n"), ("other.txt", "a\n")]);
    let coordinator = repo.coordinator();
    repo.put("README.md", "two\n");
    repo.put("other.txt", "b\n");
    let (seen, expect) = entries(&repo, &["README.md"]);
    let write = Operation::StageFiles { entries: seen };

    repo.git(&["add", "README.md"]);
    let staged_by_terminal = repo.index();
    assert_eq!(
        kind(coordinator.write(repo.path(), &write, &expect)),
        PATH_CHANGED
    );
    assert_eq!(repo.index(), staged_by_terminal);
    repo.git(&["reset", "--quiet", "README.md"]);

    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "moves HEAD"]);
    assert_eq!(
        kind(coordinator.write(repo.path(), &write, &expect)),
        HEAD_MOVED
    );

    let (fresh, expect) = entries(&repo, &["README.md"]);
    let write = Operation::StageFiles { entries: fresh };
    coordinator.write(repo.path(), &write, &expect).unwrap();
    let staged = repo.index();
    assert_eq!(
        kind(coordinator.write(repo.path(), &write, &expect)),
        PATH_CHANGED
    );
    assert_eq!(repo.index(), staged);
    assert_eq!(repo.status(), ["M  README.md", " M other.txt"]);
}

#[test]
fn an_undo_refuses_to_replace_a_file_or_folder_staged_after_the_write() {
    let repo = Repo::committed(&[("f", "file\n"), ("keep.txt", "keep\n")]);
    let coordinator = repo.coordinator();
    fs::remove_file(repo.root.join("f")).unwrap();
    let deletion = stage(&coordinator, &repo, &["f"]).unwrap();
    repo.put("f/new", "staged elsewhere\n");
    repo.git(&["add", "f/new"]);
    let descendant_staged = repo.index();
    assert_eq!(
        kind(coordinator.undo(repo.path(), deletion.id)),
        PATH_CHANGED
    );
    assert_eq!(repo.index(), descendant_staged);

    repo.put("a/b", "added\n");
    repo.git(&["add", "a/b"]);
    let unstaged = unstage(&coordinator, &repo, &["a/b"]).unwrap();
    fs::remove_dir_all(repo.root.join("a")).unwrap();
    repo.put("a", "now a file\n");
    repo.git(&["add", "a"]);
    let ancestor_staged = repo.index();
    assert_eq!(
        kind(coordinator.undo(repo.path(), unstaged.id)),
        PATH_CHANGED
    );
    assert_eq!(repo.index(), ancestor_staged);
    assert!(repo.git_dir_leftovers().is_empty());
}

#[test]
fn an_undo_refuses_a_path_changed_after_the_write_and_names_entries_by_id() {
    let repo = Repo::committed(&[("a.txt", "a\n"), ("b.txt", "b\n")]);
    let coordinator = repo.coordinator();
    repo.put("a.txt", "a2\n");
    repo.put("b.txt", "b2\n");
    let first = stage(&coordinator, &repo, &["a.txt"]).unwrap();
    let second = stage(&coordinator, &repo, &["b.txt"]).unwrap();
    assert!(second.id > first.id);
    assert_eq!(
        kind(coordinator.undo(repo.path(), first.id)),
        HISTORY_CHANGED
    );
    repo.put("b.txt", "b3\n");
    repo.git(&["add", "b.txt"]);
    let edited = repo.index();
    assert_eq!(kind(coordinator.undo(repo.path(), second.id)), PATH_CHANGED);
    assert_eq!(repo.index(), edited);
    let history = coordinator.undo_history(repo.path()).unwrap();
    assert_eq!(history.undo, Some(second));
    assert_eq!(history.redo, None);
}

#[test]
fn reports_a_held_index_lock_and_leaves_it_alone() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("f", "two\n");
    let lock = repo.root.join(".git/index.lock");
    fs::write(&lock, "held").unwrap();
    assert_eq!(
        kind(stage(&coordinator, &repo, &["f"])),
        ErrorKind::LockHeld
    );
    assert_eq!(fs::read_to_string(&lock).unwrap(), "held");
    fs::remove_file(&lock).unwrap();
    stage(&coordinator, &repo, &["f"]).unwrap();
    assert!(repo.git_dir_leftovers().is_empty());
}

#[test]
fn restores_a_staged_blob_that_a_repository_gc_pruned() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("f", "two, staged then undone\n");
    let applied = stage(&coordinator, &repo, &["f"]).unwrap();
    let staged = repo.git(&["rev-parse", ":f"]);
    coordinator.undo(repo.path(), applied.id).unwrap();
    repo.put("f", "three\n");
    repo.git(&["gc", "--quiet", "--prune=now"]);
    assert!(
        !git_output(&repo.root, &["cat-file", "-e", staged.trim()])
            .status
            .success()
    );
    coordinator.redo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.git(&["rev-parse", ":f"]), staged);
    assert_eq!(repo.git(&["show", ":f"]), "two, staged then undone\n");
    repo.git(&["fsck", "--no-progress"]);
    assert_eq!(repo.git(&["for-each-ref", "refs/undo", "refs/l1git"]), "");
}

#[test]
fn keeps_one_hundred_entries_and_drops_the_oldest_and_the_redo_side() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("f", "two\n");
    let entries_dir = || {
        let store = fs::read_dir(repo.undo_dir())
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        fs::read_dir(store.path().join("entries")).unwrap().count()
    };
    let first = stage(&coordinator, &repo, &["f"]).unwrap();
    for _ in 0..50 {
        unstage(&coordinator, &repo, &["f"]).unwrap();
        stage(&coordinator, &repo, &["f"]).unwrap();
    }
    assert_eq!(entries_dir(), 100);
    assert_eq!(
        kind(coordinator.redo(repo.path(), first.id)),
        HISTORY_CHANGED
    );
    let newest = coordinator.undo_history(repo.path()).unwrap().undo.unwrap();
    coordinator.undo(repo.path(), newest.id).unwrap();
    assert_eq!(
        kind(unstage(&coordinator, &repo, &["f"])),
        ErrorKind::UnchangedPath
    );
    let history = coordinator.undo_history(repo.path()).unwrap();
    assert_eq!(history.redo.map(|entry| entry.id), Some(newest.id));
    assert_eq!(repo.status(), [" M f"]);
    stage(&coordinator, &repo, &["f"]).unwrap();
    assert_eq!(entries_dir(), 100);
    assert_eq!(coordinator.undo_history(repo.path()).unwrap().redo, None);
}

#[test]
fn undoes_intent_to_add_even_after_its_file_is_gone() {
    let repo = Repo::committed(&[("kept", "k\n")]);
    let coordinator = repo.coordinator();
    repo.put("dir/present", "p\n");
    repo.put("dir/deleted", "d\n");
    repo.git(&["add", "--intent-to-add", "dir/present", "dir/deleted"]);
    fs::remove_file(repo.root.join("dir/deleted")).unwrap();
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["dir/present", "dir/deleted"]).unwrap()
    });
    assert_eq!(repo.status(), ["A  dir/present"]);
    let applied = coordinator.undo_history(repo.path()).unwrap().undo.unwrap();
    coordinator.undo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.status(), [" D dir/deleted", " A dir/present"]);
    assert!(!repo.root.join("dir/deleted").exists());
}

#[test]
fn an_undo_puts_back_the_assume_unchanged_bit_that_unstaging_dropped() {
    let repo = Repo::committed(&[("f", "one\n"), ("g", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("f", "two\n");
    repo.git(&["add", "f"]);
    repo.git(&["update-index", "--assume-unchanged", "f", "g"]);
    round_trip(&coordinator, &repo, || {
        unstage(&coordinator, &repo, &["f"]).unwrap()
    });
    assert_eq!(repo.git(&["ls-files", "-v"]), "H f\nh g\n");
}

#[test]
fn undo_and_redo_of_a_stage_restore_exactly_when_git_ignores_stat() {
    let repo = Repo::committed(&[("f", "one\n"), ("g", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("f", "two\n");
    repo.git(&["config", "core.ignoreStat", "true"]);
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["f"]).unwrap()
    });
    assert_eq!(repo.git(&["ls-files", "-v"]), "h f\nH g\n");
}

#[test]
fn undo_and_redo_of_an_unstage_restore_exactly_when_git_ignores_stat() {
    let repo = Repo::committed(&[("f", "one\n"), ("marked", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("f", "two\n");
    repo.put("marked", "two\n");
    repo.git(&["add", "f", "marked"]);
    repo.git(&["update-index", "--assume-unchanged", "marked"]);
    repo.git(&["config", "core.ignoreStat", "true"]);
    round_trip(&coordinator, &repo, || {
        unstage(&coordinator, &repo, &["f", "marked"]).unwrap()
    });
    assert_eq!(repo.git(&["ls-files", "-v"]), "H f\nH marked\n");
}

#[test]
fn an_undo_puts_back_intent_to_add_exactly_when_git_ignores_stat() {
    let repo = Repo::committed(&[("kept", "k\n")]);
    let coordinator = repo.coordinator();
    repo.put("new", "n\n");
    repo.git(&["add", "--intent-to-add", "new"]);
    repo.git(&["config", "core.ignoreStat", "true"]);
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["new"]).unwrap()
    });
}

#[test]
fn an_undo_puts_back_a_conflict_exactly_when_git_ignores_stat() {
    let repo = Repo::conflicted();
    let coordinator = repo.coordinator();
    repo.git(&["config", "core.ignoreStat", "true"]);
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["shared.txt"]).unwrap()
    });
}

#[test]
fn stages_a_file_a_folder_replaced_only_with_the_paths_git_also_changes() {
    let repo = Repo::committed(&[("a", "file\n"), ("d/x", "tracked\n")]);
    let coordinator = repo.coordinator();
    fs::remove_file(repo.root.join("a")).unwrap();
    repo.put("a/b", "inside\n");
    fs::remove_dir_all(repo.root.join("d")).unwrap();
    repo.put("d", "now a file\n");
    let untouched = repo.index();
    for (chosen, unchosen) in [
        (&["a/b"][..], &["a"][..]),
        (&["d"], &["d/x"]),
        (&["a", "d/x"], &["a/b"]),
    ] {
        assert_eq!(
            kind(stage(&coordinator, &repo, chosen)),
            not_chosen(unchosen),
            "{chosen:?}"
        );
        assert_eq!(repo.index(), untouched);
    }
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["a", "a/b", "d", "d/x"]).unwrap()
    });
    assert_eq!(repo.status(), ["D  a", "A  a/b", "A  d", "D  d/x"]);
}

#[test]
fn finds_the_file_above_a_chosen_path_whatever_the_names_hold() {
    let repo = Repo::committed(&[("z", "file\n"), ("0:z", "file\n")]);
    let coordinator = repo.coordinator();
    for folder in ["z", "0:z"] {
        fs::remove_file(repo.root.join(folder)).unwrap();
        repo.put(&format!("{folder}/x"), "inside\n");
    }
    repo.put("a\nb/c", "newline folder\n");
    let untouched = repo.index();
    for (chosen, unchosen) in [(&["a\nb/c", "z/x"][..], "z"), (&["0:z/x"], "0:z")] {
        assert_eq!(
            kind(stage(&coordinator, &repo, chosen)),
            not_chosen(&[unchosen]),
            "{chosen:?}"
        );
        assert_eq!(repo.index(), untouched);
    }
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["a\nb/c", "z", "z/x", "0:z", "0:z/x"]).unwrap()
    });

    repo.put("0:a/b", "added\n");
    repo.git(&["add", "0:a/b"]);
    let unstaged = unstage(&coordinator, &repo, &["0:a/b"]).unwrap();
    fs::remove_dir_all(repo.root.join("0:a")).unwrap();
    repo.put("0:a", "now a file\n");
    repo.git(&["add", "0:a"]);
    let ancestor_staged = repo.index();
    assert_eq!(
        kind(coordinator.undo(repo.path(), unstaged.id)),
        PATH_CHANGED
    );
    assert_eq!(repo.index(), ancestor_staged);
}

#[test]
fn refuses_to_drop_a_file_entry_restaged_above_a_chosen_path() {
    let repo = Repo::committed(&[("z", "file\n")]);
    let coordinator = repo.coordinator();
    fs::remove_file(repo.root.join("z")).unwrap();
    repo.put("z/x", "inside\n");
    let (seen, expect) = entries(&repo, &["z", "z/x"]);
    let restaged = repo.directory.path().join("restaged");
    fs::write(&restaged, "restaged by another tool\n").unwrap();
    let blob = repo.git(&["hash-object", "-w", restaged.to_str().unwrap()]);
    repo.git(&[
        "update-index",
        "--cacheinfo",
        &format!("100644,{},z", blob.trim()),
    ]);
    let restaged = repo.index();
    let only_inside = seen
        .iter()
        .filter(|entry| entry_path(entry) == "z/x")
        .cloned()
        .collect();
    for (entries, refused) in [(only_inside, not_chosen(&["z"])), (seen, PATH_CHANGED)] {
        assert_eq!(
            kind(coordinator.write(repo.path(), &Operation::StageFiles { entries }, &expect)),
            refused
        );
        assert_eq!(repo.index(), restaged);
    }
}

#[test]
fn refuses_to_stage_a_deleted_file_that_is_now_a_folder_of_unchosen_files() {
    let repo = Repo::committed(&[("z", "file\n")]);
    let coordinator = repo.coordinator();
    fs::remove_file(repo.root.join("z")).unwrap();
    repo.put("z/x", "not chosen\n");
    let untouched = repo.index();
    assert_eq!(
        kind(stage(&coordinator, &repo, &["z"])),
        not_chosen(&["z/x"])
    );
    assert_eq!(repo.index(), untouched);
    assert_eq!(repo.status(), [" D z", "?? z/x"]);
}

#[test]
fn a_refused_write_leaves_a_split_index_readable_and_a_written_one_round_trips() {
    for expiry in [Some("now"), None] {
        let repo = Repo::split(&[("z", "file\n"), ("f", "one\n")], expiry);
        let coordinator = repo.coordinator();
        fs::remove_file(repo.root.join("z")).unwrap();
        repo.put("z/x", "not chosen\n");
        let (untouched, shared) = (repo.index(), repo.shared_indexes());
        assert_eq!(
            kind(stage(&coordinator, &repo, &["z"])),
            not_chosen(&["z/x"]),
            "{expiry:?}"
        );
        assert_eq!(repo.index(), untouched, "{expiry:?}");
        assert_eq!(repo.shared_indexes(), shared, "{expiry:?}");

        repo.put("f", "two\n");
        round_trip(&coordinator, &repo, || {
            stage(&coordinator, &repo, &["f"]).unwrap()
        });
        assert_eq!(
            repo.status(),
            ["M  f", "A  staged", " D z", "?? z/x"],
            "{expiry:?}"
        );
        repo.git(&["add", "z", "z/x"]);
        assert_eq!(
            repo.status(),
            ["M  f", "A  staged", "D  z", "A  z/x"],
            "{expiry:?}"
        );
    }
}

#[test]
fn a_refused_undo_leaves_a_split_index_readable() {
    for expiry in [Some("now"), None] {
        let repo = Repo::split(&[("f", "one\n")], expiry);
        let coordinator = repo.coordinator();
        repo.put("n", "new\n");
        repo.git(&["add", "n"]);
        let unstaged = unstage(&coordinator, &repo, &["n"]).unwrap();
        fs::remove_file(repo.root.join("n")).unwrap();
        repo.put("n/x", "staged with Git\n");
        repo.git(&["add", "n/x"]);
        let (staged, shared) = (repo.index(), repo.shared_indexes());
        assert_eq!(
            kind(coordinator.undo(repo.path(), unstaged.id)),
            PATH_CHANGED,
            "{expiry:?}"
        );
        assert_eq!(repo.index(), staged, "{expiry:?}");
        assert_eq!(repo.shared_indexes(), shared, "{expiry:?}");
        assert_eq!(repo.status(), ["A  n/x", "A  staged"], "{expiry:?}");
    }
}

#[test]
fn a_new_repository_at_the_same_path_starts_with_an_empty_history() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("f", "secret from the old repository\n");
    let applied = stage(&coordinator, &repo, &["f"]).unwrap();
    let secret = repo.git(&["rev-parse", ":f"]);
    coordinator.undo(repo.path(), applied.id).unwrap();

    fs::remove_dir_all(&repo.root).unwrap();
    init(&repo.root);
    repo.put("f", "one\n");
    repo.git(&["add", "f"]);
    repo.git(&["commit", "--quiet", "-m", "initial"]);
    let fresh = repo.index();
    assert_eq!(
        coordinator.undo_history(repo.path()).unwrap(),
        UndoHistory {
            undo: None,
            redo: None
        }
    );
    assert_eq!(
        kind(coordinator.redo(repo.path(), applied.id)),
        HISTORY_CHANGED
    );
    assert_eq!(repo.index(), fresh);
    assert!(
        !git_output(&repo.root, &["cat-file", "-e", secret.trim()])
            .status
            .success()
    );
}

#[test]
fn a_write_entry_carries_every_field_that_worktree_status_sends() {
    let index = serde_json::json!({
        "mode": "100644",
        "oid": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    });
    let entries = [
        serde_json::json!({
            "kind": "ordinary",
            "path": "f",
            "submodule": null,
            "sides": { "kind": "unstaged", "unstaged": "M" },
            "index": index,
        }),
        serde_json::json!({
            "kind": "renamed",
            "path": "new",
            "original": "old",
            "how": "renamed",
            "submodule": null,
            "side": { "kind": "staged", "unstaged": null, "index": index },
        }),
        serde_json::json!({
            "kind": "unmerged",
            "path": "f",
            "conflict": "bothAdded",
            "submodule": null,
            "stages": { "base": null, "ours": index, "theirs": index },
        }),
    ];
    let parse = |entry: &serde_json::Value| {
        serde_json::from_value::<Operation>(serde_json::json!({
            "kind": "stageFiles",
            "entries": [entry],
        }))
    };
    let optional = [
        &["submodule", "index"][..],
        &["submodule", "side.unstaged"],
        &["submodule", "stages.base"],
    ];
    for (entry, fields) in entries.iter().zip(optional) {
        assert!(parse(entry).is_ok(), "{entry}");
        for field in fields {
            let mut missing = entry.clone();
            match field.split_once('.') {
                Some((outer, inner)) => missing[outer].as_object_mut().unwrap().remove(inner),
                None => missing.as_object_mut().unwrap().remove(*field),
            };
            assert!(
                parse(&missing).is_err(),
                "accepted {missing} without {field}"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn stages_a_name_holding_the_replacement_character_and_refuses_one_that_is_not_utf8() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    repo.put("ok\u{FFFD}name.txt", "valid UTF-8\n");
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["ok\u{FFFD}name.txt"]).unwrap()
    });
    assert_eq!(repo.status(), ["A  ok\u{FFFD}name.txt"]);

    let blob = repo.git(&["hash-object", "-w", "f"]);
    let mut info = format!("100644 {}\tcaf", blob.trim()).into_bytes();
    info.extend(b"\xff\0");
    repo.index_info(&info);
    let indexed = repo.index();
    let refused = unstage(&coordinator, &repo, &["caf\u{FFFD}"]).unwrap_err();
    assert_eq!(
        refused.kind,
        ErrorKind::UnsupportedPath,
        "{}",
        refused.message
    );
    assert!(
        refused.message.contains("unstage") && refused.message.contains("UTF-8"),
        "{}",
        refused.message
    );
    assert_eq!(repo.index(), indexed);

    if fs::write(repo.root.join(OsStr::from_bytes(b"bad\xffname")), "x\n").is_ok() {
        let refused = stage(&coordinator, &repo, &["bad\u{FFFD}name"]).unwrap_err();
        assert_eq!(
            refused.kind,
            ErrorKind::UnsupportedPath,
            "{}",
            refused.message
        );
        assert!(refused.message.contains("UTF-8"), "{}", refused.message);
        assert_eq!(repo.index(), indexed);
    }
}

#[cfg(unix)]
#[test]
fn refuses_either_of_two_names_that_read_the_same_when_one_is_not_utf8() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    let blob = repo.git(&["hash-object", "-w", "f"]);
    let mut info = Vec::new();
    for name in [&b"caf\xff"[..], "caf\u{FFFD}".as_bytes()] {
        info.extend(format!("100644 {}\t", blob.trim()).bytes());
        info.extend(name);
        info.push(0);
    }
    repo.index_info(&info);
    let mut twins = vec![(false, "caf\u{FFFD}")];
    for (bytes, name) in [
        (&b"ok\xffname.txt"[..], "ok\u{FFFD}name.txt"),
        (b"dir\xff/a.txt", "dir\u{FFFD}/a.txt"),
    ] {
        let file = repo.root.join(OsStr::from_bytes(bytes));
        if fs::create_dir_all(file.parent().unwrap())
            .and_then(|()| fs::write(file, "not UTF-8\n"))
            .is_ok()
        {
            repo.put(name, "valid UTF-8\n");
            twins.push((true, name));
        }
    }
    let indexed = repo.index();
    let status = worktree_status(repo.path()).unwrap();
    for (staging, name) in twins {
        let entries: Vec<StatusEntry> = status
            .entries
            .iter()
            .filter(|entry| entry_path(entry) == name)
            .cloned()
            .collect();
        assert_eq!(entries.len(), 2, "{name}");
        for entry in entries {
            let entries = vec![entry];
            let operation = if staging {
                Operation::StageFiles { entries }
            } else {
                Operation::UnstageFiles { entries }
            };
            let expect = Expect {
                head: status.head.clone(),
            };
            let refused = coordinator
                .write(repo.path(), &operation, &expect)
                .unwrap_err();
            assert_eq!(
                refused.kind,
                ErrorKind::UnsupportedPath,
                "{name}: {}",
                refused.message
            );
            assert_eq!(repo.index(), indexed, "{name}");
        }
    }
}

#[test]
fn refuses_to_stage_a_name_that_git_would_spell_in_another_case() {
    let repo = Repo::committed(&[("Dir/a", "one\n")]);
    let coordinator = repo.coordinator();
    repo.git(&["config", "core.ignorecase", "true"]);
    if repo.root.join("DIR").exists() {
        fs::rename(repo.root.join("Dir"), repo.root.join("moving")).unwrap();
        fs::rename(repo.root.join("moving"), repo.root.join("dir")).unwrap();
    }
    repo.put("Dir/a", "two\n");
    repo.put("dir/b", "new\n");
    assert_eq!(repo.status(), [" M Dir/a", "?? dir/b"]);
    let untouched = repo.index();
    for chosen in [&["dir/b"][..], &["Dir/a", "dir/b"]] {
        let refused = stage(&coordinator, &repo, chosen).unwrap_err();
        assert_eq!(
            refused.kind,
            ErrorKind::UnsupportedPath,
            "{chosen:?}: {}",
            refused.message
        );
        assert!(refused.message.contains("Dir/b"), "{}", refused.message);
        assert_eq!(repo.index(), untouched);
    }
    assert_eq!(coordinator.undo_history(repo.path()).unwrap().undo, None);
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["Dir/a"]).unwrap()
    });
}

#[test]
fn an_undo_that_git_would_put_back_in_another_case_names_both_spellings() {
    let repo = Repo::committed(&[("k", "k\n")]);
    let coordinator = repo.coordinator();
    repo.git(&["config", "core.ignorecase", "true"]);
    repo.put("dir/b", "b\n");
    repo.git(&["add", "--intent-to-add", "dir/b"]);
    let staged = stage(&coordinator, &repo, &["dir/b"]).unwrap();
    let blob = repo.git(&["rev-parse", "HEAD:k"]);
    repo.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("100644,{},Dir/z", blob.trim()),
    ]);
    let indexed = repo.index();
    let refused = coordinator.undo(repo.path(), staged.id).unwrap_err();
    assert_eq!(refused.kind, PATH_CHANGED, "{}", refused.message);
    assert!(
        refused.message.contains("dir/b") && refused.message.contains("Dir/b"),
        "{}",
        refused.message
    );
    assert_eq!(repo.index(), indexed);
}

#[test]
fn an_undo_for_a_removed_worktree_names_that_worktree() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    let linked = repo.directory.path().canonicalize().unwrap().join("linked");
    let linked = linked.to_str().unwrap();
    repo.git(&["worktree", "add", "--quiet", "-b", "side", linked]);
    fs::write(Path::new(linked).join("f"), "linked edit\n").unwrap();
    let status = worktree_status(linked).unwrap();
    let applied = coordinator
        .write(
            linked,
            &Operation::StageFiles {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    repo.git(&["worktree", "remove", "--force", linked]);
    let refused = coordinator.undo(repo.path(), applied.id).unwrap_err();
    assert_eq!(refused.kind, ErrorKind::MissingPath);
    assert!(refused.message.contains(linked), "{}", refused.message);
    assert_eq!(
        coordinator.undo_history(repo.path()).unwrap().undo,
        Some(applied)
    );
}

#[cfg(unix)]
#[test]
fn runs_post_index_change_once_against_the_published_index_and_only_then() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::committed(&[("f", "one\n"), ("z", "file\n")]);
    let coordinator = repo.coordinator();
    let hooks = repo.directory.path().join("hooks");
    let log = repo.directory.path().join("hook.log");
    fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("post-index-change");
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\nprintf '%s %s|%s|%s|%s|%s\\n' \"$1\" \"$2\" \"$(pwd -P)\" \"${{GIT_INDEX_FILE-unset}}\" \"${{GIT_LITERAL_PATHSPECS-unset}}\" \"$(env -u GIT_INDEX_FILE git ls-files --stage -- f g)\" >> '{}'\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    let runs = || fs::read_to_string(&log).unwrap_or_default();
    let run = |index: &str| format!("0 0|{}|unset|unset|{index}\n", repo.path());

    repo.put("f", "two\n");
    let one = "100644 5626abf0f72e58d7a153368ba57db4c673c0e171 0\tf";
    let two = "100644 f719efd430d52bcfc8566a43b2eb655688d38871 0\tf";
    let applied = stage(&coordinator, &repo, &["f"]).unwrap();
    assert_eq!(runs(), run(two));
    coordinator.undo(repo.path(), applied.id).unwrap();
    assert_eq!(runs(), [run(two), run(one)].concat());

    fs::remove_file(repo.root.join("z")).unwrap();
    repo.put("z/x", "not chosen\n");
    assert_eq!(
        kind(stage(&coordinator, &repo, &["z"])),
        not_chosen(&["z/x"])
    );
    assert_eq!(runs(), [run(two), run(one)].concat());

    repo.put("g", "intent\n");
    repo.git(&["add", "--intent-to-add", "g"]);
    fs::remove_file(&log).unwrap();
    let staged = stage(&coordinator, &repo, &["g"]).unwrap();
    coordinator.undo(repo.path(), staged.id).unwrap();
    let intent = "100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tg";
    let added = "100644 434930e2d2c24dcd4e5c5bb00d3058a2704d9f24 0\tg";
    assert_eq!(
        runs(),
        [
            run(&format!("{one}\n{added}")),
            run(&format!("{one}\n{intent}"))
        ]
        .concat()
    );
}

#[test]
fn refuses_nested_repositories_and_writes_that_change_nothing() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    git(&repo.root, &["init", "--quiet", "nested"]);
    repo.put("nested/inside", "x\n");
    assert_eq!(
        kind(stage(&coordinator, &repo, &["nested/"])),
        ErrorKind::UnsupportedPath
    );
    repo.put("f", "two\n");
    repo.git(&["add", "f"]);
    assert_eq!(
        kind(stage(&coordinator, &repo, &["f"])),
        ErrorKind::UnchangedPath
    );
    let (_, expect) = entries(&repo, &["f"]);
    assert_eq!(
        kind(coordinator.write(
            repo.path(),
            &Operation::StageFiles {
                entries: Vec::new(),
            },
            &expect,
        )),
        ErrorKind::UnchangedPath
    );
    assert_eq!(coordinator.undo_history(repo.path()).unwrap().undo, None);
}

#[cfg(unix)]
#[test]
fn keeps_undo_history_only_in_a_folder_closed_to_others() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::committed(&[("f", "one\n")]);
    repo.put("f", "two\n");
    let shared = repo.directory.path().join("shared");
    fs::create_dir(&shared).unwrap();
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
    let coordinator = Coordinator::new(Limits::default(), &shared);
    assert_eq!(
        kind(stage(&coordinator, &repo, &["f"])),
        ErrorKind::UnsupportedPath
    );
    assert_eq!(repo.status(), [" M f"]);
    stage(&repo.coordinator(), &repo, &["f"]).unwrap();
    let mode = fs::metadata(repo.undo_dir()).unwrap().permissions().mode();
    assert_eq!(mode & 0o077, 0, "{mode:o}");
}

#[test]
fn one_history_spans_worktrees_and_undo_acts_where_the_write_did() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    let linked = repo.directory.path().canonicalize().unwrap().join("linked");
    repo.git(&[
        "worktree",
        "add",
        "--quiet",
        "-b",
        "side",
        linked.to_str().unwrap(),
    ]);
    fs::write(linked.join("f"), "linked edit\n").unwrap();
    let status = worktree_status(linked.to_str().unwrap()).unwrap();
    let applied = coordinator
        .write(
            linked.to_str().unwrap(),
            &Operation::StageFiles {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert_eq!(applied.root, linked.to_str().unwrap());
    let history = coordinator.undo_history(repo.path()).unwrap();
    assert_eq!(history.undo.as_ref(), Some(&applied));
    coordinator.undo(repo.path(), applied.id).unwrap();
    assert_eq!(git(&linked, &["status", "--porcelain"]), " M f\n");
    assert_eq!(repo.status(), Vec::<String>::new());
}

#[test]
fn stages_a_submodule_commit_and_undoes_it_without_copying_the_commit() {
    let repo = Repo::committed(&[("f", "one\n")]);
    let coordinator = repo.coordinator();
    let sub = repo.root.join("sub");
    fs::create_dir(&sub).unwrap();
    for args in [
        &["init", "--quiet", "--initial-branch=main"][..],
        &["config", "user.name", "Ada"],
        &["config", "user.email", "ada@example.test"],
        &["commit", "--quiet", "--allow-empty", "-m", "first"],
    ] {
        git(&sub, args);
    }
    repo.git(&["add", "sub"]);
    repo.git(&["commit", "--quiet", "-m", "add sub"]);
    git(
        &sub,
        &["commit", "--quiet", "--allow-empty", "-m", "second"],
    );
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["sub"]).unwrap()
    });
    assert_eq!(
        repo.git(&["rev-parse", ":sub"]),
        git(&sub, &["rev-parse", "HEAD"])
    );
}

#[test]
fn stages_a_same_size_edit_that_git_can_see_only_by_its_contents() {
    let repo = Repo::new();
    let coordinator = repo.coordinator();
    let minute_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    let backdate = |path: &str| {
        fs::File::options()
            .write(true)
            .open(repo.root.join(path))
            .unwrap()
            .set_modified(minute_ago)
            .unwrap();
    };
    repo.put("f", "one\n");
    backdate("f");
    repo.git(&["add", "f"]);
    repo.git(&["commit", "--quiet", "-m", "initial"]);
    repo.git(&["config", "core.trustctime", "false"]);
    repo.put("f", "two\n");
    backdate("f");
    backdate(".git/index");
    stage(&coordinator, &repo, &["f"]).unwrap();
    assert_eq!(repo.status(), ["M  f"]);
}

#[test]
fn sends_a_stale_view_with_its_reason_and_other_errors_without_one() {
    let stale = RepositoryError {
        kind: PATH_CHANGED,
        message: "f changed.".into(),
    };
    assert_eq!(
        serde_json::to_value(&stale).unwrap(),
        serde_json::json!({ "kind": "staleView", "reason": "pathChanged", "message": "f changed." })
    );
    let unchosen = RepositoryError {
        kind: not_chosen(&["z/x"]),
        message: "z/x too.".into(),
    };
    assert_eq!(
        serde_json::to_value(&unchosen).unwrap(),
        serde_json::json!({ "kind": "staleView", "reason": "pathNotChosen", "paths": ["z/x"], "message": "z/x too." })
    );
    let held = RepositoryError {
        kind: ErrorKind::LockHeld,
        message: "held".into(),
    };
    assert_eq!(
        serde_json::to_value(&held).unwrap(),
        serde_json::json!({ "kind": "lockHeld", "message": "held" })
    );
}

#[cfg(unix)]
#[test]
fn runs_a_hook_that_config_defines_only_once_the_index_holds_the_write() {
    for name in ["probe", "a=b"] {
        let repo = Repo::committed(&[("f", "one\n")]);
        let coordinator = repo.coordinator();
        let log = repo.directory.path().join("config-hook.log");
        let command = format!(
            "printf '%s|%s\\n' \"${{GIT_INDEX_FILE-unset}}\" \"$(env -u GIT_INDEX_FILE git ls-files --stage -- f)\" >> '{}'; true",
            log.display()
        );
        let event = format!("hook.{name}.event");
        let run = format!("hook.{name}.command");
        let probe = repo.directory.path().join("probe");
        init(&probe);
        git(&probe, &["config", &event, "post-index-change"]);
        git(&probe, &["config", &run, &command]);
        git(
            &probe,
            &["hook", "run", "--ignore-missing", "post-index-change"],
        );
        if fs::read_to_string(&log).is_err() {
            return;
        }
        fs::remove_file(&log).unwrap();
        repo.git(&["config", &event, "post-index-change"]);
        repo.git(&["config", &run, &command]);
        repo.put("f", "two\n");
        stage(&coordinator, &repo, &["f"]).unwrap();
        assert_eq!(
            fs::read_to_string(&log).unwrap(),
            "unset|100644 f719efd430d52bcfc8566a43b2eb655688d38871 0\tf\n",
            "{name}"
        );
    }
}

#[cfg(unix)]
mod parts {
    use super::*;
    use l1_git_core::{FilePatch, LinePick, LineSide, Side, WorktreePatch, worktree_patch};
    use std::{
        io::Write as _,
        num::NonZeroU32,
        os::unix::fs::{PermissionsExt, symlink},
        process::Output,
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Act {
        Stage,
        Unstage,
        Discard,
    }

    #[derive(Clone, Debug)]
    enum Choice {
        Hunk(u32),
        Lines(Vec<LinePick>),
    }

    fn d(line: u32) -> LinePick {
        LinePick {
            side: LineSide::Deletions,
            line: NonZeroU32::new(line).unwrap(),
        }
    }

    fn a(line: u32) -> LinePick {
        LinePick {
            side: LineSide::Additions,
            line: NonZeroU32::new(line).unwrap(),
        }
    }

    fn numbered(count: usize) -> String {
        (1..=count).map(|line| format!("line {line}\n")).collect()
    }

    fn replaced(text: &str, edits: &[(&str, &str)]) -> String {
        edits.iter().fold(text.to_owned(), |text, (from, to)| {
            assert!(text.contains(from), "{from:?}");
            text.replacen(from, to, 1)
        })
    }

    /// The text the diff pane shows, or nothing for a patch with no text.
    fn shown(repo: &Repo, file: &str, side: Side) -> String {
        match worktree_patch(repo.path(), file, side) {
            Ok(WorktreePatch::Diff {
                diff: FilePatch::Text { patch, .. },
            }) => patch,
            _ => String::new(),
        }
    }

    fn part(repo: &Repo, act: Act, file: &str, choice: Choice) -> Operation {
        let side = match act {
            Act::Unstage => Side::Staged,
            Act::Stage | Act::Discard => Side::Unstaged,
        };
        let (path, shown) = (file.to_owned(), shown(repo, file, side));
        match (act, choice) {
            (Act::Stage, Choice::Hunk(hunk)) => Operation::StageHunk { path, hunk, shown },
            (Act::Unstage, Choice::Hunk(hunk)) => Operation::UnstageHunk { path, hunk, shown },
            (Act::Discard, Choice::Hunk(hunk)) => Operation::DiscardHunk { path, hunk, shown },
            (Act::Stage, Choice::Lines(lines)) => Operation::StageLines { path, lines, shown },
            (Act::Unstage, Choice::Lines(lines)) => Operation::UnstageLines { path, lines, shown },
            (Act::Discard, Choice::Lines(lines)) => Operation::DiscardLines { path, lines, shown },
        }
    }

    fn send(
        coordinator: &Coordinator,
        repo: &Repo,
        operation: &Operation,
    ) -> Result<Applied, RepositoryError> {
        let head = worktree_status(repo.path()).unwrap().head;
        coordinator.write(repo.path(), operation, &Expect { head })
    }

    fn write_part(
        coordinator: &Coordinator,
        repo: &Repo,
        act: Act,
        file: &str,
        choice: Choice,
    ) -> Result<Applied, RepositoryError> {
        send(coordinator, repo, &part(repo, act, file, choice))
    }

    fn git_with_input(path: &Path, args: &[&str], input: &[u8]) -> Output {
        let mut child = git_command(path, args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    }

    /// A file's bytes and permission bits, or nothing when it is gone.
    fn file(repo: &Repo, path: &str) -> Option<(Vec<u8>, u32)> {
        let file = repo.root.join(path);
        let metadata = fs::symlink_metadata(&file).ok()?;
        Some((
            fs::read(&file).unwrap(),
            metadata.permissions().mode() & 0o7777,
        ))
    }

    /// Undo puts back the file as it was and redo the file as the discard
    /// left it, twice each, and the index never changes.
    fn file_round_trip(
        coordinator: &Coordinator,
        repo: &Repo,
        path: &str,
        write: impl FnOnce() -> Applied,
    ) {
        let index = repo.index();
        let before = file(repo, path);
        let applied = write();
        let after = file(repo, path);
        assert_ne!(before, after);
        for _ in 0..2 {
            assert_eq!(coordinator.undo(repo.path(), applied.id).unwrap(), applied);
            assert_eq!(file(repo, path), before);
        }
        for _ in 0..2 {
            assert_eq!(coordinator.redo(repo.path(), applied.id).unwrap(), applied);
            assert_eq!(file(repo, path), after);
        }
        assert_eq!(repo.index(), index);
        assert!(
            repo.git_dir_leftovers().is_empty(),
            "{:?}",
            repo.git_dir_leftovers()
        );
    }

    /// The write refuses with `kind` and changes neither index nor disk.
    fn refuses(coordinator: &Coordinator, repo: &Repo, operation: &Operation, kind: &ErrorKind) {
        let (index, status) = (repo.index(), repo.status());
        let error = send(coordinator, repo, operation).expect_err("the write should refuse");
        assert_eq!(&error.kind, kind, "{}", error.message);
        assert_eq!(repo.index(), index);
        assert_eq!(repo.status(), status);
        assert!(repo.git_dir_leftovers().is_empty());
    }

    fn forty() -> String {
        numbered(40)
    }

    fn two(text: &str) -> String {
        replaced(
            text,
            &[
                ("line 10\n", "line 10 changed\n"),
                ("line 30\n", "line 30 changed\n"),
            ],
        )
    }

    /// The prototype's `stale.ts`: take the shown patch, change the repository,
    /// then send the write with the old `shown`.
    fn after_change(act: Act, setup: impl Fn(&Repo), change: impl Fn(&Repo)) -> (Repo, Operation) {
        let repo = Repo::committed(&[("f.txt", &forty())]);
        setup(&repo);
        let operation = part(&repo, act, "f.txt", Choice::Hunk(1));
        change(&repo);
        (repo, operation)
    }

    type Edit = fn(&Repo);

    fn worktree_two(repo: &Repo) {
        repo.put("f.txt", &two(&forty()));
    }

    fn staged_two(repo: &Repo) {
        worktree_two(repo);
        repo.git(&["add", "f.txt"]);
    }

    fn index_holds(repo: &Repo, contents: &str) {
        repo.put("tmp", contents);
        let oid = repo.git(&["hash-object", "-w", "tmp"]);
        fs::remove_file(repo.root.join("tmp")).unwrap();
        repo.git(&[
            "update-index",
            "--cacheinfo",
            &format!("100644,{},f.txt", oid.trim()),
        ]);
    }

    #[test]
    fn a_write_against_the_shown_patch_succeeds_when_nothing_changed() {
        let (repo, operation) = after_change(Act::Stage, worktree_two, |_| {});
        send(&repo.coordinator(), &repo, &operation).unwrap();
        assert_eq!(
            repo.git(&["show", ":f.txt"]),
            replaced(&forty(), &[("line 30\n", "line 30 changed\n")])
        );
    }

    #[test]
    fn refuses_every_change_since_the_patch_was_shown_and_changes_nothing() {
        let rewrite_in_hunk: Edit = |repo| {
            repo.put(
                "f.txt",
                &replaced(
                    &two(&forty()),
                    &[("line 30 changed\n", "line 30 REWRITTEN\n")],
                ),
            );
        };
        let index_above: Edit =
            |repo| index_holds(repo, &format!("inserted A\ninserted B\n{}", forty()));
        let index_in_context: Edit = |repo| {
            index_holds(
                repo,
                &replaced(&forty(), &[("line 29\n", "line 29 staged elsewhere\n")]),
            );
        };
        let staged_above: Edit = |repo| {
            repo.put("f.txt", &format!("new top\n{}", two(&forty())));
            repo.git(&["add", "f.txt"]);
        };
        let worktree_above: Edit = |repo| {
            repo.put(
                "f.txt",
                &format!("inserted 1\ninserted 2\ninserted 3\n{}", two(&forty())),
            );
        };
        let worktree_in_hunk: Edit = |repo| {
            repo.put(
                "f.txt",
                &replaced(&two(&forty()), &[("line 31\n", "line 31 edited\n")]),
            );
        };
        let cases: [(&str, Act, Edit, Edit); 6] = [
            (
                "stage-worktree-edited-in-hunk",
                Act::Stage,
                worktree_two,
                rewrite_in_hunk,
            ),
            (
                "stage-index-edited-above",
                Act::Stage,
                worktree_two,
                index_above,
            ),
            (
                "stage-index-edited-in-hunk-context",
                Act::Stage,
                worktree_two,
                index_in_context,
            ),
            (
                "unstage-index-edited-above",
                Act::Unstage,
                staged_two,
                staged_above,
            ),
            (
                "discard-worktree-edited-above",
                Act::Discard,
                worktree_two,
                worktree_above,
            ),
            (
                "discard-worktree-edited-in-hunk",
                Act::Discard,
                worktree_two,
                worktree_in_hunk,
            ),
        ];
        for (name, act, setup, change) in cases {
            let (repo, operation) = after_change(act, setup, change);
            let disk = fs::read(repo.root.join("f.txt")).unwrap();
            refuses(&repo.coordinator(), &repo, &operation, &PATH_CHANGED);
            assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), disk, "{name}");
        }
    }

    #[test]
    fn refuses_a_discard_that_git_apply_would_land_on_a_copy_27_lines_away() {
        let block = "alpha\nbeta\ngamma\nTARGET\ndelta\nepsilon\nzeta\n";
        let head = "top 1\ntop 2\ntop 3\ntop 4\n";
        let twice = format!("{head}{block}{}{block}", numbered(20));
        let repo = Repo::committed(&[("f.txt", &twice)]);
        repo.put(
            "f.txt",
            &replaced(&twice, &[("TARGET\n", "TARGET changed\n")]),
        );
        let operation = part(&repo, Act::Discard, "f.txt", Choice::Hunk(0));
        let fixed = replaced(&twice, &[("TARGET\n", "TARGET user-edited\n")]);
        let (first, second) = fixed.split_at(head.len() + block.len());
        let moved = format!(
            "{first}{}",
            replaced(second, &[("TARGET\n", "TARGET changed\n")])
        );
        repo.put("f.txt", &moved);
        refuses(&repo.coordinator(), &repo, &operation, &PATH_CHANGED);
        assert_eq!(fs::read_to_string(repo.root.join("f.txt")).unwrap(), moved);
    }

    #[test]
    fn refuses_a_shown_patch_whose_blob_ids_were_forged() {
        let repo = Repo::committed(&[("f.txt", &forty())]);
        worktree_two(&repo);
        let Operation::StageHunk { path, hunk, shown } =
            part(&repo, Act::Stage, "f.txt", Choice::Hunk(1))
        else {
            unreachable!("a stage of a hunk");
        };
        let (index_line, _) = shown.split_once('\n').unwrap().1.split_once('\n').unwrap();
        let forged = shown.replacen(
            index_line,
            &format!("index {}..{} 100644", "1".repeat(40), "2".repeat(40)),
            1,
        );
        refuses(
            &repo.coordinator(),
            &repo,
            &Operation::StageHunk {
                path,
                hunk,
                shown: forged,
            },
            &PATH_CHANGED,
        );
    }

    #[test]
    fn reports_a_held_index_lock_before_reading_the_patch() {
        let (repo, operation) = after_change(Act::Stage, worktree_two, |_| {});
        fs::write(repo.root.join(".git/index.lock"), "").unwrap();
        let error = send(&repo.coordinator(), &repo, &operation).unwrap_err();
        assert_eq!(error.kind, ErrorKind::LockHeld, "{}", error.message);
        fs::remove_file(repo.root.join(".git/index.lock")).unwrap();
        assert_eq!(repo.status(), [" M f.txt"]);
    }

    fn three_hunks() -> Repo {
        let repo = Repo::committed(&[("f.txt", &numbered(30))]);
        repo.put(
            "f.txt",
            &replaced(
                &numbered(30),
                &[
                    ("line 3\n", "line 3 changed\n"),
                    ("line 15\n", "line 15 changed\n"),
                    ("line 27\n", "line 27 changed\n"),
                ],
            ),
        );
        repo
    }

    #[test]
    fn undo_and_redo_of_each_partial_write_restore_the_index_or_the_file_exactly() {
        for (act, choice) in [
            (Act::Stage, Choice::Hunk(1)),
            (Act::Stage, Choice::Lines(vec![d(15), a(15), a(27)])),
            (Act::Unstage, Choice::Hunk(1)),
            (Act::Unstage, Choice::Lines(vec![d(3), d(27), a(27)])),
        ] {
            let repo = three_hunks();
            if act == Act::Unstage {
                repo.git(&["add", "f.txt"]);
            }
            let coordinator = repo.coordinator();
            round_trip(&coordinator, &repo, || {
                write_part(&coordinator, &repo, act, "f.txt", choice.clone()).unwrap()
            });
        }
        for choice in [Choice::Hunk(1), Choice::Lines(vec![d(3), a(3), a(27)])] {
            let repo = three_hunks();
            fs::set_permissions(repo.root.join("f.txt"), fs::Permissions::from_mode(0o755))
                .unwrap();
            let coordinator = repo.coordinator();
            file_round_trip(&coordinator, &repo, "f.txt", || {
                write_part(&coordinator, &repo, Act::Discard, "f.txt", choice.clone()).unwrap()
            });
        }
    }

    #[test]
    fn unstaging_a_hunk_of_a_staged_rename_keeps_the_rename() {
        let repo = Repo::committed(&[("old.txt", &numbered(30))]);
        repo.git(&["mv", "old.txt", "new.txt"]);
        repo.put(
            "new.txt",
            &replaced(
                &numbered(30),
                &[
                    ("line 2\n", "line 2 changed\n"),
                    ("line 29\n", "line 29 changed\n"),
                ],
            ),
        );
        repo.git(&["add", "new.txt"]);
        let coordinator = repo.coordinator();
        round_trip(&coordinator, &repo, || {
            write_part(
                &coordinator,
                &repo,
                Act::Unstage,
                "new.txt",
                Choice::Hunk(1),
            )
            .unwrap()
        });
        assert_eq!(repo.status(), ["RM new.txt", "old.txt"]);
    }

    #[test]
    fn a_partial_unstage_keeps_skip_worktree_and_drops_assume_unchanged() {
        for (flag, tag) in [("--skip-worktree", "S"), ("--assume-unchanged", "H")] {
            let repo = three_hunks();
            repo.git(&["add", "f.txt"]);
            repo.git(&["update-index", flag, "f.txt"]);
            let coordinator = repo.coordinator();
            round_trip(&coordinator, &repo, || {
                write_part(&coordinator, &repo, Act::Unstage, "f.txt", Choice::Hunk(1)).unwrap()
            });
            assert_eq!(
                repo.git(&["ls-files", "-v", "f.txt"]),
                format!("{tag} f.txt\n"),
                "{flag}"
            );
        }
    }

    #[test]
    fn unstages_all_of_a_new_file_whose_entry_carries_either_flag() {
        for flag in ["--skip-worktree", "--assume-unchanged"] {
            let repo = Repo::committed(&[("keep", "k\n")]);
            repo.put("n.txt", "one\ntwo\n");
            repo.git(&["add", "n.txt"]);
            repo.git(&["update-index", flag, "n.txt"]);
            let coordinator = repo.coordinator();
            round_trip(&coordinator, &repo, || {
                write_part(&coordinator, &repo, Act::Unstage, "n.txt", Choice::Hunk(0)).unwrap()
            });
            assert_eq!(repo.git(&["ls-files", "n.txt"]), "", "{flag}");
        }
    }

    fn respelled_folder(ignorecase: &str) -> Repo {
        let repo = Repo::committed(&[("dir/old.txt", "old\n")]);
        repo.git(&["config", "core.ignorecase", ignorecase]);
        fs::rename(repo.root.join("dir"), repo.root.join("moving")).unwrap();
        fs::rename(repo.root.join("moving"), repo.root.join("Dir")).unwrap();
        repo.put("Dir/new.txt", "one\ntwo\n");
        repo
    }

    #[test]
    fn refuses_to_stage_part_of_a_new_file_under_a_second_spelling_of_its_folder() {
        let repo = respelled_folder("true");
        let operation = part(&repo, Act::Stage, "Dir/new.txt", Choice::Lines(vec![a(1)]));
        refuses(
            &repo.coordinator(),
            &repo,
            &operation,
            &ErrorKind::UnsupportedPath,
        );

        let repo = respelled_folder("false");
        write_part(
            &repo.coordinator(),
            &repo,
            Act::Stage,
            "Dir/new.txt",
            Choice::Lines(vec![a(1)]),
        )
        .unwrap();
        assert_eq!(repo.git(&["show", ":Dir/new.txt"]), "one\n");
    }

    /// The second hunk of Git's own patch, reverse-applied by `git apply` to
    /// the worktree of a repository set up the same way.
    fn apply_reverse_of_second_hunk(repo: &Repo) -> Vec<u8> {
        let patch = repo.git(&["diff-files", "--patch", "--full-index", "--", "f.txt"]);
        let starts: Vec<usize> = patch.match_indices("\n@@ ").map(|(at, _)| at + 1).collect();
        let second = format!("{}{}", &patch[..starts[0]], &patch[starts[1]..]);
        let applied = git_with_input(
            &repo.root,
            &["apply", "--reverse", "--whitespace=nowarn", "-"],
            second.as_bytes(),
        );
        assert!(
            applied.status.success(),
            "{}",
            String::from_utf8_lossy(&applied.stderr)
        );
        fs::read(repo.root.join("f.txt")).unwrap()
    }

    fn crlf_lines() -> String {
        numbered(30).replace('\n', "\r\n")
    }

    fn crlf_edited() -> String {
        replaced(
            &crlf_lines(),
            &[
                ("line 3\r\n", "line 3 changed\r\n"),
                ("line 27\r\n", "line 27 changed\r\n"),
            ],
        )
    }

    fn crlf_blob_under_autocrlf() -> Repo {
        let repo = Repo::new();
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.put("f.txt", &crlf_lines());
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "--quiet", "-m", "crlf"]);
        repo.git(&["config", "core.autocrlf", "true"]);
        repo.put("f.txt", &crlf_edited());
        repo
    }

    fn eol_crlf_under_safecrlf() -> Repo {
        let repo = Repo::committed(&[
            (".gitattributes", "*.txt text eol=crlf\n"),
            ("f.txt", &numbered(30)),
        ]);
        repo.git(&["config", "core.safecrlf", "true"]);
        fs::remove_file(repo.root.join("f.txt")).unwrap();
        repo.git(&["checkout", "--", "f.txt"]);
        repo.put("f.txt", &crlf_edited());
        repo
    }

    #[test]
    fn discards_a_hunk_as_git_apply_reverse_does_whatever_the_line_ending_rules() {
        for setup in [crlf_blob_under_autocrlf, eol_crlf_under_safecrlf] {
            let repo = setup();
            let coordinator = repo.coordinator();
            file_round_trip(&coordinator, &repo, "f.txt", || {
                write_part(&coordinator, &repo, Act::Discard, "f.txt", Choice::Hunk(1)).unwrap()
            });
            let sibling = setup();
            assert_eq!(
                fs::read(repo.root.join("f.txt")).unwrap(),
                apply_reverse_of_second_hunk(&sibling)
            );
            assert_eq!(
                fs::read_to_string(repo.root.join("f.txt")).unwrap(),
                replaced(&crlf_lines(), &[("line 3\r\n", "line 3 changed\r\n")])
            );
        }
    }

    #[test]
    fn an_untracked_file_stays_untracked_after_a_partial_discard_and_goes_after_a_full_one() {
        for (choice, left) in [
            (Choice::Lines(vec![a(2)]), Some("one\nthree\nfour\n")),
            (Choice::Hunk(0), None),
        ] {
            let repo = Repo::committed(&[("keep", "k\n")]);
            repo.put("n.txt", "one\ntwo\nthree\nfour\n");
            let coordinator = repo.coordinator();
            file_round_trip(&coordinator, &repo, "n.txt", || {
                write_part(&coordinator, &repo, Act::Discard, "n.txt", choice.clone()).unwrap()
            });
            assert_eq!(
                fs::read_to_string(repo.root.join("n.txt")).ok().as_deref(),
                left
            );
            let listed = if left.is_some() {
                vec!["?? n.txt"]
            } else {
                vec![]
            };
            assert_eq!(repo.status(), listed);
        }
    }

    #[test]
    fn a_partial_discard_of_a_file_deleted_on_disk_brings_back_the_chosen_lines() {
        let repo = Repo::committed(&[("g.txt", "d1\nd2\nd3\nd4\n")]);
        fs::remove_file(repo.root.join("g.txt")).unwrap();
        let coordinator = repo.coordinator();
        file_round_trip(&coordinator, &repo, "g.txt", || {
            write_part(
                &coordinator,
                &repo,
                Act::Discard,
                "g.txt",
                Choice::Lines(vec![d(1), d(4)]),
            )
            .unwrap()
        });
        assert_eq!(
            fs::read_to_string(repo.root.join("g.txt")).unwrap(),
            "d1\nd4\n"
        );
    }

    #[test]
    fn a_partial_discard_keeps_the_files_permission_bits() {
        let repo = three_hunks();
        fs::set_permissions(repo.root.join("f.txt"), fs::Permissions::from_mode(0o640)).unwrap();
        write_part(
            &repo.coordinator(),
            &repo,
            Act::Discard,
            "f.txt",
            Choice::Hunk(0),
        )
        .unwrap();
        assert_eq!(file(&repo, "f.txt").unwrap().1, 0o640);
    }

    #[test]
    fn a_partial_discard_writes_nothing_into_the_object_store() {
        let objects = |repo: &Repo| {
            let mut found = Vec::new();
            let mut folders = vec![repo.root.join(".git/objects")];
            while let Some(folder) = folders.pop() {
                for item in fs::read_dir(folder).unwrap() {
                    let path = item.unwrap().path();
                    if path.is_dir() {
                        folders.push(path);
                    } else {
                        found.push(path);
                    }
                }
            }
            found.sort();
            found
        };
        let repo = three_hunks();
        repo.put("n.txt", "one\ntwo\n");
        let before = objects(&repo);
        let coordinator = repo.coordinator();
        write_part(&coordinator, &repo, Act::Discard, "f.txt", Choice::Hunk(1)).unwrap();
        write_part(
            &coordinator,
            &repo,
            Act::Discard,
            "n.txt",
            Choice::Lines(vec![a(1)]),
        )
        .unwrap();
        assert_eq!(objects(&repo), before);
    }

    #[test]
    fn refuses_to_split_a_patch_it_cannot_apply_part_of() {
        let unsupported = ErrorKind::UnsupportedPath;
        let stage = |repo: &Repo, file: &str| part(repo, Act::Stage, file, Choice::Hunk(0));

        let repo = Repo::committed(&[("b.bin", "a\0b\n")]);
        repo.put("b.bin", "a\0c\n");
        refuses(
            &repo.coordinator(),
            &repo,
            &stage(&repo, "b.bin"),
            &unsupported,
        );

        let repo = Repo::committed(&[("big.txt", "small\n")]);
        repo.put(
            "big.txt",
            &"x".repeat(1100 * 1024).replace("xxxxxxxxxx", "xxxxxxxxx\n"),
        );
        refuses(
            &repo.coordinator(),
            &repo,
            &stage(&repo, "big.txt"),
            &unsupported,
        );

        let repo = Repo::conflicted();
        refuses(
            &repo.coordinator(),
            &repo,
            &stage(&repo, "shared.txt"),
            &unsupported,
        );

        let repo = Repo::committed(&[("f", "one\n")]);
        let sub = repo.root.join("sub");
        init(&sub);
        git(&sub, &["commit", "--quiet", "--allow-empty", "-m", "first"]);
        repo.git(&["add", "sub"]);
        repo.git(&["commit", "--quiet", "-m", "add sub"]);
        git(
            &sub,
            &["commit", "--quiet", "--allow-empty", "-m", "second"],
        );
        refuses(
            &repo.coordinator(),
            &repo,
            &stage(&repo, "sub"),
            &unsupported,
        );
        repo.git(&["add", "sub"]);
        let unstage = part(&repo, Act::Unstage, "sub", Choice::Hunk(0));
        refuses(&repo.coordinator(), &repo, &unstage, &unsupported);

        let repo = Repo::committed(&[("keep", "k\n")]);
        symlink("target", repo.root.join("link")).unwrap();
        repo.git(&["add", "link"]);
        repo.git(&["commit", "--quiet", "-m", "link"]);
        fs::remove_file(repo.root.join("link")).unwrap();
        symlink("other", repo.root.join("link")).unwrap();
        refuses(
            &repo.coordinator(),
            &repo,
            &stage(&repo, "link"),
            &unsupported,
        );

        fs::remove_file(repo.root.join("link")).unwrap();
        repo.put("link", "now a file\n");
        refuses(
            &repo.coordinator(),
            &repo,
            &stage(&repo, "link"),
            &unsupported,
        );

        let repo = Repo::committed(&[("a.txt", &numbered(20))]);
        repo.git(&["config", "status.renames", "copies"]);
        repo.put("b.txt", &format!("{}extra\n", numbered(20)));
        repo.put("a.txt", &format!("{}more\n", numbered(20)));
        repo.git(&["add", "a.txt", "b.txt"]);
        let unstage = part(&repo, Act::Unstage, "b.txt", Choice::Hunk(0));
        refuses(&repo.coordinator(), &repo, &unstage, &unsupported);

        let repo = Repo::committed(&[("old.txt", &numbered(20))]);
        fs::rename(repo.root.join("old.txt"), repo.root.join("new.txt")).unwrap();
        repo.put("new.txt", &format!("{}more\n", numbered(20)));
        repo.git(&["add", "-N", "new.txt"]);
        refuses(
            &repo.coordinator(),
            &repo,
            &stage(&repo, "new.txt"),
            &unsupported,
        );

        for deleted in [false, true] {
            let repo = Repo::committed(&[("keep", "k\n")]);
            repo.put("n.txt", "one\ntwo\n");
            repo.git(&["add", "-N", "n.txt"]);
            let discard = part(&repo, Act::Discard, "n.txt", Choice::Hunk(0));
            if deleted {
                fs::remove_file(repo.root.join("n.txt")).unwrap();
            }
            refuses(&repo.coordinator(), &repo, &discard, &unsupported);
        }
    }

    #[test]
    fn refuses_a_line_after_one_without_a_newline_until_the_newline_fix_comes_with_it() {
        let repo = Repo::committed(&[("f.txt", "a\nb\nc")]);
        repo.put("f.txt", "a\nb\nc\nd\n");
        let coordinator = repo.coordinator();
        let alone = part(&repo, Act::Stage, "f.txt", Choice::Lines(vec![a(4)]));
        refuses(&coordinator, &repo, &alone, &ErrorKind::UnsupportedPath);
        round_trip(&coordinator, &repo, || {
            write_part(
                &coordinator,
                &repo,
                Act::Stage,
                "f.txt",
                Choice::Lines(vec![d(3), a(3), a(4)]),
            )
            .unwrap()
        });
        assert_eq!(repo.git(&["show", ":f.txt"]), "a\nb\nc\nd\n");
    }
}
