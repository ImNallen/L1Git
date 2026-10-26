#![cfg(unix)]

use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Limits, Operation, RepositoryError, StaleReason,
    StatusEntry, worktree_status,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
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
    fn new(files: &[(&str, &str)]) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        let repo = Self { directory, root };
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
        repo.git(&["commit", "--quiet", "--allow-empty", "-m", "initial"]);
        repo
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn coordinator(&self) -> Coordinator {
        Coordinator::new(Limits::default(), self.directory.path().join("undo"))
    }

    fn put(&self, path: &str, contents: &str) {
        let file = self.root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, contents).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn status(&self) -> String {
        self.git(&["status", "--porcelain", "--untracked-files=all"])
    }

    fn request(&self, paths: &[&str]) -> (Operation, Expect) {
        let status = worktree_status(self.path()).unwrap();
        let entries: Vec<StatusEntry> = status
            .entries
            .into_iter()
            .filter(|entry| paths.contains(&path_of(entry)))
            .collect();
        assert_eq!(entries.len(), paths.len(), "{paths:?}");
        (Operation::Discard { entries }, Expect { head: status.head })
    }

    fn discard(&self, paths: &[&str]) -> Result<Applied, RepositoryError> {
        let (operation, expect) = self.request(paths);
        self.coordinator().write(self.path(), &operation, &expect)
    }

    fn unstaged(&self) -> Vec<String> {
        worktree_status(self.path())
            .unwrap()
            .entries
            .iter()
            .map(|entry| path_of(entry).to_owned())
            .collect()
    }

    /// Every path below the root but `.git`, with its kind, permission bits,
    /// and bytes or link target.
    fn disk(&self) -> BTreeMap<String, String> {
        let mut found = BTreeMap::new();
        let mut folders = vec![self.root.clone()];
        while let Some(folder) = folders.pop() {
            for item in fs::read_dir(&folder).unwrap() {
                let path = item.unwrap().path();
                let name = path.strip_prefix(&self.root).unwrap().display().to_string();
                if name == ".git" {
                    continue;
                }
                let metadata = fs::symlink_metadata(&path).unwrap();
                let shown = if metadata.is_symlink() {
                    format!("link {}", fs::read_link(&path).unwrap().display())
                } else if metadata.is_dir() {
                    folders.push(path);
                    continue;
                } else {
                    format!(
                        "{:o} {:?}",
                        metadata.permissions().mode() & 0o7777,
                        fs::read(&path).unwrap()
                    )
                };
                found.insert(name, shown);
            }
        }
        found
    }
}

fn path_of(entry: &StatusEntry) -> &str {
    match entry {
        StatusEntry::Ordinary { path, .. }
        | StatusEntry::Renamed { path, .. }
        | StatusEntry::Unmerged { path, .. }
        | StatusEntry::Untracked { path } => path,
    }
}

fn refused(result: Result<Applied, RepositoryError>, kind: &ErrorKind) -> RepositoryError {
    let error = result.expect_err("the discard should refuse");
    assert_eq!(&error.kind, kind, "{}", error.message);
    error
}

fn stale(reason: StaleReason) -> ErrorKind {
    ErrorKind::StaleView { reason }
}

fn executable(file: &Path, on: bool) {
    fs::set_permissions(
        file,
        fs::Permissions::from_mode(if on { 0o755 } else { 0o644 }),
    )
    .unwrap();
}

/// The files of `c2_discard_undo.sh`: a lossy clean filter, an LFS-style
/// filter, `eol=crlf` with LF bytes, an executable bit turned on, a
/// retargeted symlink, an untracked file, and a file only its owner reads.
fn filtered() -> Repo {
    let repo = Repo::new(&[]);
    let filters = repo.directory.path().join("filters");
    fs::create_dir(&filters).unwrap();
    for (name, script) in [
        (
            "fakelfs-clean",
            "#!/bin/sh\nd=\"$(git rev-parse --git-dir)/fakelfs\"; mkdir -p \"$d\"; t=$(mktemp); cat > \"$t\"; s=$(shasum -a 256 < \"$t\" | cut -c1-64); mv \"$t\" \"$d/$s\"; echo \"fakelfs-pointer $s\"\n",
        ),
        (
            "fakelfs-smudge",
            "#!/bin/sh\nread tag s; d=\"$(git rev-parse --git-dir)/fakelfs\"; if [ \"$tag\" = fakelfs-pointer ] && [ -f \"$d/$s\" ]; then cat \"$d/$s\"; else echo \"$tag $s\"; fi\n",
        ),
    ] {
        let file = filters.join(name);
        fs::write(&file, script).unwrap();
        executable(&file, true);
    }
    for (key, value) in [
        ("filter.strip.clean", "grep -v '^OUTPUT:'".to_owned()),
        ("filter.strip.smudge", "cat".to_owned()),
        (
            "filter.fakelfs.clean",
            filters.join("fakelfs-clean").display().to_string(),
        ),
        (
            "filter.fakelfs.smudge",
            filters.join("fakelfs-smudge").display().to_string(),
        ),
        ("filter.fakelfs.required", "true".to_owned()),
    ] {
        repo.git(&["config", key, &value]);
    }
    repo.put(
        ".gitattributes",
        "*.nb filter=strip\n*.bin filter=fakelfs\n*.crlf text eol=crlf\n",
    );
    for (path, contents) in [
        ("n.nb", "cell\n"),
        ("x.sh", "v1\n"),
        ("big.bin", "blob-v1\n"),
        ("w.crlf", "a\r\nb\r\n"),
        ("target-one", "t\n"),
        ("secret.txt", "old\n"),
    ] {
        repo.put(path, contents);
    }
    symlink("target-one", repo.root.join("link")).unwrap();
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "--quiet", "-m", "base"]);
    repo.put("n.nb", "cell2\nOUTPUT: 42\n");
    repo.put("x.sh", "v2\n");
    executable(&repo.root.join("x.sh"), true);
    repo.put("big.bin", "blob-v2-large\n");
    repo.put("w.crlf", "a\nb\nc\n");
    repo.put("secret.txt", "new\n");
    fs::set_permissions(
        repo.root.join("secret.txt"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::remove_file(repo.root.join("link")).unwrap();
    symlink("target-two", repo.root.join("link")).unwrap();
    repo.put("u.txt", "untracked\n");
    repo
}

const FILTERED: [&str; 7] = [
    "n.nb",
    "x.sh",
    "big.bin",
    "w.crlf",
    "link",
    "secret.txt",
    "u.txt",
];

#[test]
fn undo_puts_back_every_byte_mode_and_link_target_that_filters_would_change() {
    let repo = filtered();
    let before = (repo.disk(), repo.status());
    let applied = repo.discard(&FILTERED).unwrap();
    assert_eq!(repo.status(), "");
    let discarded = repo.disk();
    assert_eq!(discarded["link"], "link target-one");
    assert!(!discarded.contains_key("u.txt"));

    repo.coordinator().undo(repo.path(), applied.id).unwrap();
    assert_eq!((repo.disk(), repo.status()), before);

    repo.coordinator().redo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.disk(), discarded);
    assert_eq!(repo.status(), "");

    repo.coordinator().undo(repo.path(), applied.id).unwrap();
    assert_eq!((repo.disk(), repo.status()), before);
}

#[test]
fn discards_a_deleted_file_in_a_deleted_folder_and_undo_deletes_it_again() {
    let repo = Repo::new(&[("deep/er/f", "one\n"), ("g", "g\n")]);
    fs::remove_dir_all(repo.root.join("deep")).unwrap();
    let applied = repo.discard(&["deep/er/f"]).unwrap();
    assert_eq!(
        fs::read_to_string(repo.root.join("deep/er/f")).unwrap(),
        "one\n"
    );
    assert_eq!(repo.status(), "");
    repo.coordinator().undo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.status(), " D deep/er/f\n");
}

#[test]
fn refuses_a_stale_view_and_changes_nothing() {
    let repo = Repo::new(&[("f", "one\n"), ("g", "one\n")]);
    repo.put("f", "two\n");
    let (operation, expect) = repo.request(&["f"]);
    repo.git(&["add", "f"]);
    repo.put("f", "three\n");
    let coordinator = repo.coordinator();
    refused(
        coordinator.write(repo.path(), &operation, &expect),
        &stale(StaleReason::PathChanged),
    );
    assert_eq!(fs::read_to_string(repo.root.join("f")).unwrap(), "three\n");

    let (operation, expect) = repo.request(&["f"]);
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "moved"]);
    refused(
        coordinator.write(repo.path(), &operation, &expect),
        &stale(StaleReason::HeadMoved),
    );

    repo.put("g", "seen\n");
    let (operation, expect) = repo.request(&["g"]);
    fs::remove_file(repo.root.join("g")).unwrap();
    refused(
        coordinator.write(repo.path(), &operation, &expect),
        &stale(StaleReason::PathChanged),
    );
    assert_eq!(repo.status(), " M f\n D g\n");
    let history = coordinator.undo_history(repo.path()).unwrap();
    assert_eq!((history.undo, history.redo), (None, None));
}

#[test]
fn undo_refuses_after_a_later_edit_and_keeps_that_edit() {
    let repo = Repo::new(&[("f", "one\n")]);
    repo.put("f", "two\n");
    let applied = repo.discard(&["f"]).unwrap();
    repo.put("f", "later\n");
    let error = refused(
        repo.coordinator().undo(repo.path(), applied.id),
        &stale(StaleReason::PathChanged),
    );
    assert!(
        error.message.starts_with("f changed after the discard"),
        "{}",
        error.message
    );
    assert_eq!(fs::read_to_string(repo.root.join("f")).unwrap(), "later\n");
    assert_eq!(
        repo.coordinator().undo_history(repo.path()).unwrap().undo,
        Some(applied.clone())
    );

    repo.put("f", "one\n");
    repo.coordinator().undo(repo.path(), applied.id).unwrap();
    assert_eq!(fs::read_to_string(repo.root.join("f")).unwrap(), "two\n");
    repo.put("f", "edited again\n");
    refused(
        repo.coordinator().redo(repo.path(), applied.id),
        &stale(StaleReason::PathChanged),
    );
    assert_eq!(
        fs::read_to_string(repo.root.join("f")).unwrap(),
        "edited again\n"
    );
}

#[test]
fn leaves_nested_repositories_and_submodules_alone() {
    let repo = Repo::new(&[("d/f", "one\n"), ("f", "one\n")]);
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
    fs::write(sub.join("dirty"), "x\n").unwrap();
    let nested = repo.root.join("nested");
    fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "--quiet"]);
    fs::write(nested.join("inner"), "x\n").unwrap();
    repo.put("d/f", "two\n");
    git(&repo.root.join("d"), &["init", "--quiet"]);
    repo.put("d/g", "inner file\n");
    repo.put("f", "two\n");
    let disk = repo.disk();
    let unstaged = repo.unstaged();

    for path in ["sub", "nested/", "d/f", "d/g"] {
        if unstaged.iter().any(|listed| listed == path) {
            refused(repo.discard(&[path]), &ErrorKind::UnsupportedPath);
        }
    }
    assert!(
        unstaged.iter().any(|listed| listed == "d/f"),
        "{unstaged:?}"
    );
    assert_eq!(repo.disk(), disk);
    repo.discard(&["f"]).unwrap();
    assert_eq!(fs::read_to_string(repo.root.join("f")).unwrap(), "one\n");
}

#[test]
fn refuses_intent_to_add_files_and_a_folder_where_a_file_was() {
    let repo = Repo::new(&[("f", "one\n")]);
    repo.put("added", "content\n");
    repo.git(&["add", "-N", "added"]);
    refused(repo.discard(&["added"]), &ErrorKind::UnsupportedPath);
    assert_eq!(
        fs::read_to_string(repo.root.join("added")).unwrap(),
        "content\n"
    );

    repo.git(&["rm", "--cached", "--quiet", "added"]);
    fs::remove_file(repo.root.join("added")).unwrap();
    repo.put("gone", "content\n");
    repo.git(&["add", "-N", "gone"]);
    fs::remove_file(repo.root.join("gone")).unwrap();
    let error = refused(repo.discard(&["gone"]), &ErrorKind::UnsupportedPath);
    assert!(error.message.contains("git add -N"), "{}", error.message);
    assert!(!repo.root.join("gone").exists());

    fs::remove_file(repo.root.join("f")).unwrap();
    repo.put("f/inside", "keep\n");
    refused(repo.discard(&["f"]), &ErrorKind::UnsupportedPath);
    assert_eq!(
        fs::read_to_string(repo.root.join("f/inside")).unwrap(),
        "keep\n"
    );
}

#[test]
fn discards_names_with_a_newline_or_a_carriage_return_and_no_other_file() {
    let repo = Repo::new(&[("x", "x one\n"), ("x\r", "cr one\n"), ("a\nb", "nl one\n")]);
    for path in ["x", "x\r", "a\nb"] {
        repo.put(path, &format!("{path} edited\n"));
    }
    let before = repo.disk();
    let applied = repo.discard(&["x\r", "a\nb"]).unwrap();
    assert_eq!(
        fs::read_to_string(repo.root.join("x")).unwrap(),
        "x edited\n"
    );
    assert_eq!(
        fs::read_to_string(repo.root.join("x\r")).unwrap(),
        "cr one\n"
    );
    assert_eq!(
        fs::read_to_string(repo.root.join("a\nb")).unwrap(),
        "nl one\n"
    );
    repo.coordinator().undo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.disk(), before);
}

#[test]
fn a_failing_smudge_filter_changes_nothing_and_records_nothing() {
    let repo = Repo::new(&[]);
    repo.put(".gitattributes", "*.bin filter=broken\n");
    repo.put("a.bin", "one\n");
    repo.git(&["config", "filter.broken.clean", "cat"]);
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "--quiet", "-m", "base"]);
    repo.git(&["config", "filter.broken.smudge", "false"]);
    repo.git(&["config", "filter.broken.required", "true"]);
    repo.put("a.bin", "two\n");
    repo.discard(&["a.bin"])
        .expect_err("the smudge filter fails");
    assert_eq!(
        fs::read_to_string(repo.root.join("a.bin")).unwrap(),
        "two\n"
    );
    let history = repo.coordinator().undo_history(repo.path()).unwrap();
    assert_eq!((history.undo, history.redo), (None, None));
    let leftovers: Vec<_> = fs::read_dir(repo.root.join(".git"))
        .unwrap()
        .map(|item| item.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name == "index.lock" || name.starts_with("l1git-"))
        .collect();
    assert_eq!(leftovers, Vec::<String>::new());
}

#[test]
fn keeps_the_entry_when_a_later_file_cannot_be_replaced_and_undo_puts_back_the_rest() {
    let repo = Repo::new(&[("a/one", "one\n"), ("b/two", "two\n")]);
    repo.put("a/one", "edited\n");
    repo.put("b/two", "edited\n");
    let (operation, expect) = repo.request(&["a/one", "b/two"]);
    let locked = repo.root.join("b");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    let error = repo
        .coordinator()
        .write(repo.path(), &operation, &expect)
        .expect_err("b cannot take a new file");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        error.message.contains("Undo puts them back"),
        "{}",
        error.message
    );
    assert_eq!(repo.status(), " M b/two\n");

    let kept = repo
        .coordinator()
        .undo_history(repo.path())
        .unwrap()
        .undo
        .unwrap();
    repo.coordinator().undo(repo.path(), kept.id).unwrap();
    assert_eq!(repo.status(), " M a/one\n M b/two\n");
    assert_eq!(
        fs::read_to_string(repo.root.join("a/one")).unwrap(),
        "edited\n"
    );
}

#[test]
fn refuses_two_names_for_one_file_on_a_case_insensitive_disk() {
    let repo = Repo::new(&[("foo.txt", "one\n")]);
    if !repo.root.join("FOO.TXT").exists() {
        return;
    }
    repo.git(&["config", "core.ignorecase", "false"]);
    fs::rename(repo.root.join("foo.txt"), repo.root.join("Foo.txt")).unwrap();
    repo.put("Foo.txt", "two\n");
    let unstaged = repo.unstaged();
    if !unstaged.iter().any(|path| path == "Foo.txt") {
        return;
    }
    refused(
        repo.discard(&["foo.txt", "Foo.txt"]),
        &ErrorKind::UnsupportedPath,
    );
    assert_eq!(
        fs::read_to_string(repo.root.join("Foo.txt")).unwrap(),
        "two\n"
    );
}
