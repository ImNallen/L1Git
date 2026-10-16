use l1_git_core::{
    Branch, ChangeStatus, DiffBase, ErrorKind, FilePatch, HISTORY_LIMIT, Head, commit_detail,
    file_patch, snapshot,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    repo: PathBuf,
}

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
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.test")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.test")
        .env("GIT_AUTHOR_DATE", "1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "1700000000 +0000")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end_matches('\n')
        .to_owned()
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo with spaces");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--initial-branch=main"]);
        git(&repo, &["config", "core.hooksPath", "/dev/null"]);
        Self {
            _directory: directory,
            repo,
        }
    }
    fn path(&self) -> &str {
        self.repo.to_str().unwrap()
    }
    fn commit(&self, filename: &str, contents: &str, message: &str) -> String {
        fs::write(self.repo.join(filename), contents).unwrap();
        git(&self.repo, &["add", "--", filename]);
        git(&self.repo, &["commit", "-m", message]);
        git(&self.repo, &["rev-parse", "HEAD"])
    }
}

#[test]
fn normalizes_subfolders_and_symlinks_but_keeps_worktrees_distinct() {
    let fixture = Fixture::new();
    fixture.commit("first", "one", "initial");
    let child = fixture.repo.join("subfolder");
    fs::create_dir(&child).unwrap();
    let original = snapshot(fixture.path(), None).unwrap();
    assert_eq!(
        snapshot(child.to_str().unwrap(), None).unwrap().root,
        original.root
    );
    #[cfg(unix)]
    {
        let alias = fixture._directory.path().join("alias");
        std::os::unix::fs::symlink(&fixture.repo, &alias).unwrap();
        assert_eq!(
            snapshot(alias.to_str().unwrap(), None).unwrap().root,
            original.root
        );
    }
    let linked = fixture._directory.path().join("linked");
    git(
        &fixture.repo,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let linked = snapshot(linked.to_str().unwrap(), None).unwrap();
    assert_ne!(linked.root, original.root);
    assert!(
        matches!(linked.head, Head::Attached { reference, .. } if reference == "refs/heads/linked")
    );
}

#[test]
fn reads_local_remote_and_tracking_refs_and_skips_symbolic_remote_head() {
    let fixture = Fixture::new();
    let oid = fixture.commit("first", "one", "initial");
    let remote = fixture._directory.path().join("remote.git");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--bare", "--initial-branch=main"]);
    git(&fixture.repo, &["branch", "feat/with/slashes"]);
    git(
        &fixture.repo,
        &["remote", "add", "team/origin", remote.to_str().unwrap()],
    );
    git(
        &fixture.repo,
        &["push", "-u", "team/origin", "main", "feat/with/slashes"],
    );
    git(&fixture.repo, &["fetch", "team/origin"]);
    git(
        &fixture.repo,
        &["remote", "set-head", "team/origin", "main"],
    );
    let result = snapshot(fixture.path(), None).unwrap();
    assert_eq!(result.branches.len(), 4);
    assert!(matches!(result.head, Head::Attached { oid: head, .. } if head == oid));
    assert!(result.branches.iter().any(|b| matches!(b, Branch::Local { reference, upstream: Some(upstream), .. } if reference == "refs/heads/main" && upstream == "refs/remotes/team/origin/main")));
    assert!(result.branches.iter().any(|b| matches!(b, Branch::Remote { name, remote, .. } if name == "team/origin/feat/with/slashes" && remote == "team/origin")));
}

#[test]
fn distinguishes_unborn_and_detached_and_includes_unreferenced_head() {
    let fixture = Fixture::new();
    let result = snapshot(fixture.path(), None).unwrap();
    assert_eq!(
        result.head,
        Head::Unborn {
            reference: "refs/heads/main".into()
        }
    );
    assert!(result.commits.is_empty());
    let oid = fixture.commit("first", "one", "initial");
    git(&fixture.repo, &["checkout", "--detach"]);
    let detached = fixture.commit("second", "two", "detached commit");
    let result = snapshot(fixture.path(), None).unwrap();
    assert_eq!(
        result.head,
        Head::Detached {
            oid: detached.clone()
        }
    );
    assert_eq!(result.commits[0].oid, detached);
    assert_eq!(result.commits[0].parents, [oid]);
}

#[test]
fn branch_selection_has_its_own_bounded_history_without_checkout() {
    let fixture = Fixture::new();
    let initial = fixture.commit("first", "one", "initial");
    git(&fixture.repo, &["branch", "old"]);
    let tree = git(&fixture.repo, &["rev-parse", "HEAD^{tree}"]);
    let mut parent = initial.clone();
    for index in 0..=HISTORY_LIMIT {
        parent = git(
            &fixture.repo,
            &[
                "commit-tree",
                &tree,
                "-p",
                &parent,
                "-m",
                &format!("commit {index}"),
            ],
        );
    }
    git(&fixture.repo, &["update-ref", "refs/heads/main", &parent]);
    let all = snapshot(fixture.path(), None).unwrap();
    assert_eq!(all.commits.len(), HISTORY_LIMIT);
    assert!(all.history_truncated);
    assert!(!all.commits.iter().any(|c| c.oid == initial));
    let selected = snapshot(fixture.path(), Some("refs/heads/old")).unwrap();
    assert_eq!(selected.commits.len(), 1);
    assert_eq!(selected.commits[0].oid, initial);
    assert!(!selected.history_truncated);
    assert_eq!(
        git(&fixture.repo, &["symbolic-ref", "HEAD"]),
        "refs/heads/main"
    );
    for reference in ["main", "--all", "refs/heads/missing", "refs/heads/main~1"] {
        assert!(matches!(
            snapshot(fixture.path(), Some(reference)).unwrap_err().kind,
            ErrorKind::InvalidRef
        ));
    }
}

#[test]
fn detail_preserves_message_paths_and_first_parent_merge_policy() {
    let fixture = Fixture::new();
    let root_oid = fixture.commit("first", "one", "initial\n\nFull body.");
    let initial = commit_detail(fixture.path(), &root_oid).unwrap();
    assert_eq!(initial.commit.subject, "initial");
    assert_eq!(initial.commit.author, "Ada");
    assert_eq!(initial.commit.timestamp, 1700000000);
    assert_eq!(initial.message, "initial\n\nFull body.\n");
    assert!(matches!(initial.diff_base, DiffBase::EmptyTree));
    assert_eq!(initial.files[0].path, "first");
    assert_eq!(initial.files[0].status, ChangeStatus::Added);
    git(&fixture.repo, &["checkout", "-b", "feature"]);
    let feature = fixture.commit("a\tfile\n.txt", "feature", "feature");
    git(&fixture.repo, &["checkout", "main"]);
    let main = fixture.commit("main.txt", "main", "main");
    git(
        &fixture.repo,
        &["merge", "--no-ff", "feature", "-m", "merge"],
    );
    let merge = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let detail = commit_detail(fixture.path(), &merge).unwrap();
    assert_eq!(detail.commit.parents, [main, feature]);
    assert!(matches!(detail.diff_base, DiffBase::FirstParent));
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].path, "a\tfile\n.txt");
    assert_eq!(detail.files[0].status, ChangeStatus::Added);
}

#[test]
fn detail_reports_added_deleted_modified_and_type_changed_paths() {
    let fixture = Fixture::new();
    fixture.commit("edited", "one", "initial");
    fixture.commit("removed", "gone", "second");
    fixture.commit("kind", "regular file", "third");
    fs::write(fixture.repo.join("edited"), "two").unwrap();
    fs::create_dir_all(fixture.repo.join("nested/dir")).unwrap();
    fs::write(fixture.repo.join("nested/dir/added"), "new").unwrap();
    git(&fixture.repo, &["add", "edited", "nested/dir/added"]);
    git(&fixture.repo, &["rm", "--quiet", "removed"]);
    let blob = git(&fixture.repo, &["rev-parse", "HEAD:edited"]);
    git(
        &fixture.repo,
        &[
            "update-index",
            "--cacheinfo",
            &format!("120000,{blob},kind"),
        ],
    );
    git(&fixture.repo, &["commit", "-m", "every status"]);
    let oid = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let files = commit_detail(fixture.path(), &oid)
        .unwrap()
        .files
        .into_iter()
        .map(|file| (file.path, file.status))
        .collect::<Vec<_>>();
    assert_eq!(
        files,
        [
            ("edited".to_owned(), ChangeStatus::Modified),
            ("kind".to_owned(), ChangeStatus::TypeChanged),
            ("nested/dir/added".to_owned(), ChangeStatus::Added),
            ("removed".to_owned(), ChangeStatus::Deleted),
        ]
    );
}

#[test]
fn file_patch_reads_text_against_the_first_parent_and_the_empty_tree() {
    let fixture = Fixture::new();
    let root = fixture.commit("notes.txt", "one\ntwo\n", "initial");
    let second = fixture.commit("notes.txt", "one\n2\n", "edit");
    assert_eq!(
        file_patch(fixture.path(), &root, "notes.txt").unwrap(),
        FilePatch::Text {
            patch: "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\nindex 0000000..814f4a4\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n".into()
        }
    );
    assert_eq!(
        file_patch(fixture.path(), &second, "notes.txt").unwrap(),
        FilePatch::Text {
            patch: "diff --git a/notes.txt b/notes.txt\nindex 814f4a4..99b356d 100644\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n".into()
        }
    );
}

#[test]
fn file_patch_reports_binary_and_oversized_files_without_patch_text() {
    let fixture = Fixture::new();
    fs::write(
        fixture.repo.join("logo.png"),
        [0x89, b'P', b'N', b'G', 0, 1, 2],
    )
    .unwrap();
    let large = "0123456789abcde\n".repeat(70_000);
    fs::write(fixture.repo.join("large.txt"), &large).unwrap();
    git(&fixture.repo, &["add", "logo.png", "large.txt"]);
    git(&fixture.repo, &["commit", "-m", "assets"]);
    let oid = git(&fixture.repo, &["rev-parse", "HEAD"]);
    assert_eq!(
        file_patch(fixture.path(), &oid, "logo.png").unwrap(),
        FilePatch::Binary
    );
    assert_eq!(
        file_patch(fixture.path(), &oid, "large.txt").unwrap(),
        FilePatch::TooLarge { bytes: 1_190_129 }
    );
}

#[test]
fn file_patch_rejects_paths_the_commit_did_not_change() {
    let fixture = Fixture::new();
    fixture.commit("kept.txt", "kept", "initial");
    fs::create_dir(fixture.repo.join("dir")).unwrap();
    let oid = fixture.commit("dir/changed.txt", "changed", "second");
    for path in ["kept.txt", "dir", "missing.txt", ""] {
        assert!(
            matches!(
                file_patch(fixture.path(), &oid, path).unwrap_err().kind,
                ErrorKind::UnchangedPath
            ),
            "{path:?}"
        );
    }
    assert!(matches!(
        file_patch(fixture.path(), "HEAD", "dir/changed.txt")
            .unwrap_err()
            .kind,
        ErrorKind::InvalidOid
    ));
}

#[test]
fn file_patch_treats_pathspec_magic_as_a_literal_path() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "a", "initial");
    fs::write(fixture.repo.join("a.txt"), "b").unwrap();
    fs::write(fixture.repo.join("*"), "star").unwrap();
    git(&fixture.repo, &["add", "--", "a.txt", ":(literal)*"]);
    git(&fixture.repo, &["commit", "-m", "glob-looking path"]);
    let oid = git(&fixture.repo, &["rev-parse", "HEAD"]);
    assert_eq!(
        file_patch(fixture.path(), &oid, "*").unwrap(),
        FilePatch::Text {
            patch: "diff --git a/* b/*\nnew file mode 100644\nindex 0000000..ce7b819\n--- /dev/null\n+++ b/*\n@@ -0,0 +1 @@\n+star\n\\ No newline at end of file\n".into()
        }
    );
    assert!(matches!(
        file_patch(fixture.path(), &oid, ":(glob)*")
            .unwrap_err()
            .kind,
        ErrorKind::UnchangedPath
    ));
}

#[test]
fn file_patch_reports_non_utf8_file_names_as_unsupported() {
    use std::os::unix::ffi::OsStrExt;
    let fixture = Fixture::new();
    fixture.commit("a.txt", "a", "initial");
    let blob = git(&fixture.repo, &["hash-object", "-w", "a.txt"]);
    let mut cacheinfo = format!("100644,{blob},").into_bytes();
    cacheinfo.extend(b"bad\xff.txt");
    let status = Command::new("git")
        .arg("-C")
        .arg(&fixture.repo)
        .args(["update-index", "--add", "--cacheinfo"])
        .arg(std::ffi::OsStr::from_bytes(&cacheinfo))
        .status()
        .unwrap();
    assert!(status.success());
    git(&fixture.repo, &["commit", "-m", "non-UTF-8 name"]);
    let oid = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let detail = commit_detail(fixture.path(), &oid).unwrap();
    assert_eq!(detail.files[0].path, "bad\u{FFFD}.txt");
    assert!(matches!(
        file_patch(fixture.path(), &oid, &detail.files[0].path)
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedPath
    ));
}

#[test]
fn all_branches_excludes_private_and_stash_only_commits() {
    let fixture = Fixture::new();
    fixture.commit("first", "one", "initial");
    let tree = git(&fixture.repo, &["rev-parse", "HEAD^{tree}"]);
    for (reference, subject) in [
        ("refs/remotes/origin/remote-work", "remote work"),
        ("refs/t3/checkpoints/latest", "private checkpoint"),
        ("refs/stash", "stash only"),
    ] {
        let oid = git(&fixture.repo, &["commit-tree", &tree, "-m", subject]);
        git(&fixture.repo, &["update-ref", reference, &oid]);
    }
    let mut subjects = snapshot(fixture.path(), None)
        .unwrap()
        .commits
        .into_iter()
        .map(|commit| commit.subject)
        .collect::<Vec<_>>();
    subjects.sort();
    assert_eq!(subjects, ["initial", "remote work"]);
}

#[test]
fn partial_clone_details_never_fetch_missing_objects() {
    let fixture = Fixture::new();
    let oid = fixture.commit("first", "one", "initial");
    git(&fixture.repo, &["config", "uploadpack.allowFilter", "true"]);
    let source = url::Url::from_file_path(fixture.repo.canonicalize().unwrap()).unwrap();
    let clone = fixture._directory.path().join("partial-clone");
    git(
        fixture._directory.path(),
        &[
            "clone",
            "--no-checkout",
            "--filter=tree:0",
            source.as_str(),
            clone.to_str().unwrap(),
        ],
    );
    let packs = || {
        let mut names = fs::read_dir(clone.join(".git/objects/pack"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        names.sort();
        names
    };
    let before = packs();
    let result = commit_detail(clone.to_str().unwrap(), &oid)
        .map(|_| "detail loaded".to_owned())
        .unwrap_or_else(|error| format!("{:?}", error.kind));
    assert_eq!(result, "GitFailed");
    assert_eq!(packs(), before);
    assert_eq!(git(&clone, &["rev-parse", "HEAD"]), oid);
}

#[test]
fn rejects_missing_invalid_and_bare_repositories_and_invalid_oids() {
    let fixture = Fixture::new();
    assert!(matches!(
        snapshot("/not/a/real/l1git/path", None).unwrap_err().kind,
        ErrorKind::MissingPath
    ));
    assert!(matches!(
        snapshot(fixture._directory.path().to_str().unwrap(), None)
            .unwrap_err()
            .kind,
        ErrorKind::NotRepository
    ));
    let bare = fixture._directory.path().join("bare.git");
    fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    assert!(matches!(
        snapshot(bare.to_str().unwrap(), None).unwrap_err().kind,
        ErrorKind::BareRepository
    ));
    for oid in [
        "HEAD",
        "--all",
        "abc",
        "0000000000000000000000000000000000000000",
    ] {
        assert!(matches!(
            commit_detail(fixture.path(), oid).unwrap_err().kind,
            ErrorKind::InvalidOid
        ));
    }
}
