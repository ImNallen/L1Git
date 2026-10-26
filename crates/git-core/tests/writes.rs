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
            .map(|line| line.split("flags:").last().unwrap().trim())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn git_dir_leftovers(&self) -> Vec<String> {
        let git_dir = self.root.join(".git");
        fs::read_dir(git_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name == "index.lock" || name.starts_with("l1git-"))
            .collect()
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
    let repo = Repo::committed(&[("shared.txt", "base\n")]);
    let coordinator = repo.coordinator();
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
    use std::{ffi::OsStr, io::Write, os::unix::ffi::OsStrExt};
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
    let mut child = git_command(&repo.root, &["update-index", "-z", "--index-info"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&info).unwrap();
    assert!(child.wait().unwrap().success());
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
