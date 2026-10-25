use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Limits, Operation, RepositoryError, StatusEntry,
    worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

fn git_output(path: &Path, args: &[&str]) -> std::process::Output {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .arg("-C")
        .arg(path)
        .args(args)
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
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            git(&root, &["config", key, value]);
        }
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
        ErrorKind::StaleView
    );
    assert_eq!(repo.index(), staged_by_terminal);
    repo.git(&["reset", "--quiet", "README.md"]);

    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "moves HEAD"]);
    assert_eq!(
        kind(coordinator.write(repo.path(), &write, &expect)),
        ErrorKind::StaleView
    );

    let (fresh, expect) = entries(&repo, &["README.md"]);
    let write = Operation::StageFiles { entries: fresh };
    coordinator.write(repo.path(), &write, &expect).unwrap();
    let staged = repo.index();
    assert_eq!(
        kind(coordinator.write(repo.path(), &write, &expect)),
        ErrorKind::StaleView
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
        ErrorKind::StaleView
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
        ErrorKind::StaleView
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
        ErrorKind::StaleView
    );
    repo.put("b.txt", "b3\n");
    repo.git(&["add", "b.txt"]);
    let edited = repo.index();
    assert_eq!(
        kind(coordinator.undo(repo.path(), second.id)),
        ErrorKind::StaleView
    );
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
        ErrorKind::StaleView
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
fn records_the_file_a_new_folder_replaces_so_undo_restores_it() {
    let repo = Repo::committed(&[("a", "file\n"), ("d/x", "tracked\n")]);
    let coordinator = repo.coordinator();
    fs::remove_file(repo.root.join("a")).unwrap();
    repo.put("a/b", "inside\n");
    fs::remove_dir_all(repo.root.join("d")).unwrap();
    repo.put("d", "now a file\n");
    round_trip(&coordinator, &repo, || {
        stage(&coordinator, &repo, &["a/b", "d"]).unwrap()
    });
    assert_eq!(repo.status(), ["D  a", "A  a/b", "A  d", "D  d/x"]);
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
