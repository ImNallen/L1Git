use l1_git_core::{
    Base, BaseDetail, Blame, BlameRange, Branch, ChangeStatus, Comparison, Conflict, ErrorKind,
    FilePatch, HISTORY_LIMIT, Head, IndexObject, LINE_STATS_LIMIT, LineStats, MoveSide, Moved, Oid,
    RepositoryRefs, Side, Sides, Squash, Stages, Stash, StatusEntry, Submodule, SubmoduleState,
    Tag, Target, TargetDetail, Worktree, WorktreePatch, WorktreeStatus, blame, commit_detail,
    file_history, file_patch, line_stats, refs, snapshot, worktree_patch, worktree_status,
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    repo: PathBuf,
}

fn git(path: &Path, args: &[&str]) -> String {
    git_with_input(path, args, b"")
}

fn git_with_input(path: &Path, args: &[&str], input: &[u8]) -> String {
    git_dated(path, args, input, "1700000000 +0000")
}

fn git_dated(path: &Path, args: &[&str], input: &[u8], date: &str) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let mut child = command
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.test")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.test")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
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
    let original = snapshot(fixture.path()).unwrap();
    assert_eq!(
        snapshot(child.to_str().unwrap()).unwrap().root,
        original.root
    );
    #[cfg(unix)]
    {
        let alias = fixture._directory.path().join("alias");
        std::os::unix::fs::symlink(&fixture.repo, &alias).unwrap();
        assert_eq!(
            snapshot(alias.to_str().unwrap()).unwrap().root,
            original.root
        );
    }
    let linked = fixture._directory.path().join("linked");
    git(
        &fixture.repo,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let linked = snapshot(linked.to_str().unwrap()).unwrap();
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
    let result = snapshot(fixture.path()).unwrap();
    assert_eq!(result.branches.len(), 4);
    assert!(matches!(result.head, Head::Attached { oid: head, .. } if head == oid));
    assert!(result.branches.iter().any(|b| matches!(b, Branch::Local { reference, upstream: Some(upstream), .. } if reference == "refs/heads/main" && upstream == "refs/remotes/team/origin/main")));
    assert!(result.branches.iter().any(|b| matches!(b, Branch::Remote { name, remote, .. } if name == "team/origin/feat/with/slashes" && remote == "team/origin")));
}

#[test]
fn reads_refs_without_history_matching_the_snapshot() {
    let fixture = Fixture::new();
    let oid = fixture.commit("first", "one", "initial");
    let remote = fixture._directory.path().join("remote.git");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--bare", "--initial-branch=main"]);
    git(&fixture.repo, &["branch", "feat/x"]);
    git(
        &fixture.repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&fixture.repo, &["push", "-u", "origin", "main"]);
    let child = fixture.repo.join("subfolder");
    fs::create_dir(&child).unwrap();
    let result = refs(child.to_str().unwrap()).unwrap();
    let root = fixture.repo.canonicalize().unwrap();
    assert_eq!(
        result,
        RepositoryRefs {
            root: root.to_str().unwrap().into(),
            name: "repo with spaces".into(),
            head: Head::Attached {
                reference: "refs/heads/main".into(),
                oid: oid.clone(),
            },
            branches: vec![
                Branch::Local {
                    reference: "refs/heads/feat/x".into(),
                    name: "feat/x".into(),
                    oid: oid.clone(),
                    upstream: None,
                },
                Branch::Local {
                    reference: "refs/heads/main".into(),
                    name: "main".into(),
                    oid: oid.clone(),
                    upstream: Some("refs/remotes/origin/main".into()),
                },
                Branch::Remote {
                    reference: "refs/remotes/origin/main".into(),
                    name: "origin/main".into(),
                    oid: oid.clone(),
                    remote: "origin".into(),
                },
            ],
            tags: vec![],
            stashes: vec![],
            submodules: vec![],
        }
    );
    let snapshot = snapshot(fixture.path()).unwrap();
    assert_eq!(
        (
            snapshot.root,
            snapshot.name,
            snapshot.head,
            snapshot.branches
        ),
        (result.root, result.name, result.head, result.branches)
    );
    assert!(matches!(
        refs(remote.to_str().unwrap()).unwrap_err().kind,
        ErrorKind::BareRepository
    ));
}

#[test]
fn distinguishes_unborn_and_detached_and_includes_unreferenced_head() {
    let fixture = Fixture::new();
    let result = snapshot(fixture.path()).unwrap();
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
    let result = snapshot(fixture.path()).unwrap();
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
fn reads_tags_at_their_peeled_commits_and_includes_tag_only_history() {
    let fixture = Fixture::new();
    let initial = fixture.commit("first", "one", "initial");
    let tree = git(&fixture.repo, &["rev-parse", "HEAD^{tree}"]);
    let tagged = git(
        &fixture.repo,
        &["commit-tree", &tree, "-p", &initial, "-m", "tag only"],
    );
    git(
        &fixture.repo,
        &["tag", "-a", "-m", "release", "v1.0", &initial],
    );
    git(&fixture.repo, &["tag", "light", &tagged]);
    git(
        &fixture.repo,
        &["tag", "-a", "-m", "nested", "nested", "v1.0"],
    );
    git(&fixture.repo, &["tag", "tree", &tree]);
    git(
        &fixture.repo,
        &["tag", "-a", "-m", "tree", "tree-annotated", &tree],
    );
    let result = snapshot(fixture.path()).unwrap();
    assert_eq!(
        result.tags,
        [
            Tag {
                reference: "refs/tags/light".into(),
                name: "light".into(),
                oid: tagged.clone(),
            },
            Tag {
                reference: "refs/tags/nested".into(),
                name: "nested".into(),
                oid: initial.clone(),
            },
            Tag {
                reference: "refs/tags/v1.0".into(),
                name: "v1.0".into(),
                oid: initial.clone(),
            },
        ]
    );
    assert_eq!(
        result
            .commits
            .iter()
            .map(|commit| commit.oid.as_str())
            .collect::<Vec<_>>(),
        [tagged.as_str(), initial.as_str()]
    );
}

#[test]
fn reads_tags_stashes_and_mapped_submodules_and_keeps_stashes_out_of_history() {
    let fixture = Fixture::new();
    let initial = fixture.commit("notes.txt", "one\n", "initial");
    let source = fixture._directory.path().join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "--initial-branch=main"]);
    fs::write(source.join("inner.txt"), "inner\n").unwrap();
    git(&source, &["add", "inner.txt"]);
    git(&source, &["commit", "-m", "inner"]);
    let inner = git(&source, &["rev-parse", "HEAD"]);
    git(
        &fixture.repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            source.to_str().unwrap(),
            "libs/inner module",
        ],
    );
    let orphan = fixture.repo.join("orphan");
    fs::create_dir(&orphan).unwrap();
    git(&orphan, &["init", "--initial-branch=main"]);
    git(&orphan, &["commit", "--allow-empty", "-m", "orphan"]);
    git(&fixture.repo, &["add", "orphan"]);
    git(&fixture.repo, &["commit", "-m", "add modules"]);
    let modules = git(&fixture.repo, &["rev-parse", "HEAD"]);
    git(
        &fixture.repo,
        &["tag", "-a", "-m", "release", "v1.0", &initial],
    );
    git(&fixture.repo, &["tag", "nightly"]);
    fs::write(fixture.repo.join("notes.txt"), "two\n").unwrap();
    git(&fixture.repo, &["stash", "push", "-m", "first stash"]);
    fs::write(fixture.repo.join("notes.txt"), "three\n").unwrap();
    git(&fixture.repo, &["stash", "push", "-m", "second stash"]);
    let stash = |name: &str| git(&fixture.repo, &["rev-parse", name]);
    let result = refs(fixture.path()).unwrap();
    assert_eq!(
        result.tags,
        [
            Tag {
                reference: "refs/tags/nightly".into(),
                name: "nightly".into(),
                oid: modules.clone(),
            },
            Tag {
                reference: "refs/tags/v1.0".into(),
                name: "v1.0".into(),
                oid: initial.clone(),
            },
        ]
    );
    assert_eq!(
        result.stashes,
        [
            Stash {
                name: "stash@{0}".into(),
                oid: stash("stash@{0}"),
                message: "On main: second stash".into(),
                timestamp: 1_700_000_000,
            },
            Stash {
                name: "stash@{1}".into(),
                oid: stash("stash@{1}"),
                message: "On main: first stash".into(),
                timestamp: 1_700_000_000,
            },
        ]
    );
    assert_eq!(
        result.submodules,
        [Submodule {
            path: "libs/inner module".into(),
            oid: inner,
        }]
    );
    let snapshot = snapshot(fixture.path()).unwrap();
    assert_eq!(
        (snapshot.tags, snapshot.stashes, snapshot.submodules),
        (result.tags, result.stashes, result.submodules)
    );
    assert_eq!(
        snapshot
            .commits
            .iter()
            .map(|commit| commit.oid.as_str())
            .collect::<Vec<_>>(),
        [modules.as_str(), initial.as_str()]
    );
}

fn map_module(fixture: &Fixture, mapped: &str, gitlink: &str) {
    fs::write(
        fixture.repo.join(".gitmodules"),
        format!("[submodule \"module\"]\n\tpath = {mapped}\n\turl = ./module\n"),
    )
    .unwrap();
    git(&fixture.repo, &["add", ".gitmodules"]);
    git(
        &fixture.repo,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{},{gitlink}", "1".repeat(40)),
        ],
    );
    git(&fixture.repo, &["commit", "-m", "map module"]);
}

#[test]
fn reads_refs_without_stashes_or_submodules_that_git_cannot_read() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    map_module(&fixture, "module", "module");
    fs::write(fixture.repo.join("notes.txt"), "two\n").unwrap();
    git(&fixture.repo, &["stash", "push", "-m", "lost"]);
    let stash = git(&fixture.repo, &["rev-parse", "stash@{0}"]);
    fs::remove_file(
        fixture
            .repo
            .join(".git/objects")
            .join(&stash[..2])
            .join(&stash[2..]),
    )
    .unwrap();
    let result = refs(fixture.path()).unwrap();
    assert_eq!(result.stashes, []);
    assert_eq!(result.submodules.len(), 1);
    assert_eq!(snapshot(fixture.path()).unwrap().stashes, []);
    fs::write(fixture.repo.join(".git/index"), "not an index").unwrap();
    let result = refs(fixture.path()).unwrap();
    assert_eq!(result.submodules, []);
    assert_eq!(result.branches.len(), 1);
}

#[test]
fn lists_only_mapped_gitlinks_and_reads_the_map_from_the_index_when_sparse() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    map_module(&fixture, "vendor", "vendor/nested");
    assert_eq!(refs(fixture.path()).unwrap().submodules, []);
    map_module(&fixture, "module", "module");
    git(
        &fixture.repo,
        &["update-index", "--skip-worktree", ".gitmodules"],
    );
    fs::remove_file(fixture.repo.join(".gitmodules")).unwrap();
    assert_eq!(
        refs(fixture.path()).unwrap().submodules,
        [Submodule {
            path: "module".into(),
            oid: "1".repeat(40),
        }]
    );
}

#[test]
fn reads_a_conflicted_submodule_at_the_commit_head_records() {
    let fixture = Fixture::new();
    fixture.commit(
        ".gitmodules",
        "[submodule \"module\"]\n\tpath = module\n\turl = ./module\n",
        "map module",
    );
    let record = |oid: &str, message: &str| {
        git(
            &fixture.repo,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{oid},module"),
            ],
        );
        git(&fixture.repo, &["commit", "-m", message]);
    };
    record(&"1".repeat(40), "base");
    git(&fixture.repo, &["switch", "-c", "other"]);
    record(&"2".repeat(40), "theirs");
    git(&fixture.repo, &["switch", "main"]);
    record(&"3".repeat(40), "ours");
    merge(&fixture, "other");
    assert_eq!(
        refs(fixture.path()).unwrap().submodules,
        [Submodule {
            path: "module".into(),
            oid: "3".repeat(40),
        }]
    );
}

#[test]
fn reads_linked_and_detached_worktrees_and_marks_the_opened_root() {
    let fixture = Fixture::new();
    let oid = fixture.commit("first", "one", "initial");
    let linked = fixture._directory.path().join("linked");
    let detached = fixture._directory.path().join("detached");
    git(
        &fixture.repo,
        &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
    );
    git(
        &fixture.repo,
        &["worktree", "add", "--detach", detached.to_str().unwrap()],
    );
    let worktree = |path: &Path, name: &str, head: Head, current: bool| Worktree {
        root: fs::canonicalize(path).unwrap().to_str().unwrap().into(),
        name: name.into(),
        head,
        current,
    };
    let attached = |reference: &str| Head::Attached {
        reference: reference.into(),
        oid: oid.clone(),
    };
    let detached_head = Head::Detached { oid: oid.clone() };
    assert_eq!(
        snapshot(fixture.path()).unwrap().worktrees,
        [
            worktree(
                &fixture.repo,
                "repo with spaces",
                attached("refs/heads/main"),
                true
            ),
            worktree(&detached, "detached", detached_head.clone(), false),
            worktree(&linked, "linked", attached("refs/heads/feature"), false),
        ]
    );
    assert_eq!(
        snapshot(linked.to_str().unwrap()).unwrap().worktrees,
        [
            worktree(
                &fixture.repo,
                "repo with spaces",
                attached("refs/heads/main"),
                false
            ),
            worktree(&detached, "detached", detached_head, false),
            worktree(&linked, "linked", attached("refs/heads/feature"), true),
        ]
    );
}

#[test]
fn history_includes_commits_only_a_detached_worktree_reaches() {
    let fixture = Fixture::new();
    let initial = fixture.commit("first", "one", "initial");
    let detached = fixture._directory.path().join("detached");
    git(
        &fixture.repo,
        &["worktree", "add", "--detach", detached.to_str().unwrap()],
    );
    let detached = detached.to_str().unwrap();
    git(
        Path::new(detached),
        &["commit", "--allow-empty", "-m", "detached only"],
    );
    let tip = git(Path::new(detached), &["rev-parse", "HEAD"]);
    assert_eq!(
        snapshot(fixture.path())
            .unwrap()
            .commits
            .iter()
            .map(|commit| commit.oid.as_str())
            .collect::<Vec<_>>(),
        [tip.as_str(), initial.as_str()]
    );
}

#[test]
fn history_keeps_the_newest_commits_across_branches_and_flags_truncation() {
    let fixture = Fixture::new();
    let initial = fixture.commit("first", "one", "initial");
    git(&fixture.repo, &["branch", "old"]);
    let mut stream = String::new();
    for index in 0..HISTORY_LIMIT {
        let message = format!("commit {index}");
        stream.push_str(&format!(
            "commit refs/heads/main\ncommitter Ada <ada@example.test> 1700000000 +0000\ndata {}\n{message}\n",
            message.len()
        ));
        if index == 0 {
            stream.push_str(&format!("from {initial}\n"));
        }
    }
    git_with_input(
        &fixture.repo,
        &["fast-import", "--quiet"],
        stream.as_bytes(),
    );
    let result = snapshot(fixture.path()).unwrap();
    assert_eq!(result.commits.len(), HISTORY_LIMIT);
    assert!(result.history_truncated);
    assert!(!result.commits.iter().any(|c| c.oid == initial));
    assert!(result.branches.iter().any(|branch| matches!(
        branch,
        Branch::Local { name, oid, .. } if name == "old" && *oid == initial
    )));
    assert_eq!(
        git(&fixture.repo, &["symbolic-ref", "HEAD"]),
        "refs/heads/main"
    );
}

#[test]
fn pairs_a_squash_merged_branch_with_its_squash_commit_only() {
    let fixture = Fixture::new();
    fixture.commit("first", "one", "initial");
    git(&fixture.repo, &["checkout", "-b", "feat/merged"]);
    fixture.commit("merged", "merged", "merged work");
    git(&fixture.repo, &["checkout", "main"]);
    git(
        &fixture.repo,
        &["merge", "--no-ff", "feat/merged", "-m", "merge"],
    );
    git(&fixture.repo, &["checkout", "-b", "feat/open"]);
    fixture.commit("open", "open", "open work");
    git(&fixture.repo, &["checkout", "-b", "feat/squashed", "main"]);
    fixture.commit("first", "one\ntwo", "squashed one");
    let tip = fixture.commit("second", "second", "squashed two");
    git(&fixture.repo, &["checkout", "main"]);
    fs::write(fixture.repo.join("open"), "other").unwrap();
    git(&fixture.repo, &["add", "open"]);
    git_dated(
        &fixture.repo,
        &["commit", "-m", "same path as feat/open, other contents"],
        b"",
        "1700000030 +0000",
    );
    assert_eq!(snapshot(fixture.path()).unwrap().squashes, []);
    git(&fixture.repo, &["merge", "--squash", "feat/squashed"]);
    git_dated(
        &fixture.repo,
        &["commit", "-m", "squashed (#1)"],
        b"",
        "1700000060 +0000",
    );
    let commit = git(&fixture.repo, &["rev-parse", "HEAD"]);
    assert_eq!(
        snapshot(fixture.path()).unwrap().squashes,
        [Squash { tip, commit }]
    );
}

#[test]
fn detail_preserves_message_paths_and_first_parent_merge_policy() {
    let fixture = Fixture::new();
    let root_oid = fixture.commit("first", "one", "initial\n\nFull body.");
    let initial = commit_detail(fixture.path(), &Comparison::commit(&root_oid)).unwrap();
    let TargetDetail::Commit { commit, message } = initial.target else {
        panic!("a commit target");
    };
    assert_eq!(commit.subject, "initial");
    assert_eq!(commit.author, "Ada");
    assert_eq!(commit.timestamp, 1700000000);
    assert_eq!(message, "initial\n\nFull body.\n");
    assert!(matches!(initial.base, BaseDetail::EmptyTree));
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
    let detail = commit_detail(fixture.path(), &Comparison::commit(&merge)).unwrap();
    let TargetDetail::Commit { commit, .. } = &detail.target else {
        panic!("a commit target");
    };
    assert_eq!(commit.parents, [main, feature]);
    assert!(matches!(detail.base, BaseDetail::FirstParent));
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
    let files = commit_detail(fixture.path(), &Comparison::commit(&oid))
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

fn paths(comparison: Comparison, fixture: &Fixture) -> Vec<(String, ChangeStatus)> {
    commit_detail(fixture.path(), &comparison)
        .unwrap()
        .files
        .into_iter()
        .map(|file| (file.path, file.status))
        .collect()
}

fn changed(path: &str, status: ChangeStatus) -> (String, ChangeStatus) {
    (path.to_owned(), status)
}

#[test]
fn compares_two_commits_either_way_round() {
    let fixture = Fixture::new();
    let first = fixture.commit("kept.txt", "one\n", "first");
    fixture.commit("gone.txt", "bye\n", "second");
    git(&fixture.repo, &["rm", "--quiet", "gone.txt"]);
    fixture.commit("kept.txt", "two\n", "third");
    let last = fixture.commit("new.txt", "hi\n", "fourth");
    assert_eq!(
        paths(Comparison::between(&first, &last), &fixture),
        [
            changed("kept.txt", ChangeStatus::Modified),
            changed("new.txt", ChangeStatus::Added),
        ]
    );
    assert_eq!(
        paths(Comparison::between(&last, &first), &fixture),
        [
            changed("kept.txt", ChangeStatus::Modified),
            changed("new.txt", ChangeStatus::Deleted),
        ]
    );
    let detail = commit_detail(fixture.path(), &Comparison::between(&first, &last)).unwrap();
    assert!(matches!(detail.base, BaseDetail::Commit { commit } if commit.oid == first));
    assert!(matches!(detail.target, TargetDetail::Commit { commit, .. } if commit.oid == last));
    let FilePatch::Text { patch, .. } = file_patch(
        fixture.path(),
        &Comparison::between(&last, &first),
        "kept.txt",
    )
    .unwrap() else {
        panic!("a text patch");
    };
    assert!(patch.contains("-two\n+one\n"), "{patch}");
    assert!(paths(Comparison::between(&last, &last), &fixture).is_empty());
    assert!(matches!(
        file_patch(
            fixture.path(),
            &Comparison::between(&last, &last),
            "kept.txt"
        )
        .unwrap_err()
        .kind,
        ErrorKind::UnchangedPath
    ));
}

#[test]
fn compares_a_commit_with_a_dirty_worktree() {
    let fixture = Fixture::new();
    let first = fixture.commit("edited.txt", "one\n", "first");
    let second = fixture.commit("touched.txt", "same\n", "second");
    let linked = fixture._directory.path().join("linked");
    git(
        &fixture.repo,
        &["worktree", "add", "--detach", linked.to_str().unwrap()],
    );
    fs::write(linked.join("edited.txt"), "two\n").unwrap();
    fs::write(linked.join("notes.txt"), "new\n").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(linked.join("touched.txt"), "same\n").unwrap();
    let against = |oid: &str| Comparison {
        base: Base::Commit {
            oid: oid.to_owned(),
        },
        target: Target::Worktree {
            root: linked.to_str().unwrap().to_owned(),
        },
    };
    let comparison = against(&second);
    assert_eq!(
        paths(comparison.clone(), &fixture),
        [
            changed("edited.txt", ChangeStatus::Modified),
            changed("notes.txt", ChangeStatus::Added),
        ]
    );
    assert_eq!(
        paths(against(&first), &fixture),
        [
            changed("edited.txt", ChangeStatus::Modified),
            changed("touched.txt", ChangeStatus::Added),
            changed("notes.txt", ChangeStatus::Added),
        ]
    );
    let detail = commit_detail(fixture.path(), &comparison).unwrap();
    assert!(matches!(
        detail.target,
        TargetDetail::Worktree {
            head: Head::Detached { .. },
            ..
        }
    ));
    let FilePatch::Text { patch, .. } =
        file_patch(fixture.path(), &comparison, "edited.txt").unwrap()
    else {
        panic!("a text patch");
    };
    assert!(patch.contains("-one\n+two\n"), "{patch}");
    let FilePatch::Text { patch, .. } =
        file_patch(fixture.path(), &comparison, "notes.txt").unwrap()
    else {
        panic!("a text patch");
    };
    assert!(patch.contains("+new\n"), "{patch}");
    fs::remove_file(linked.join("notes.txt")).unwrap();
    assert!(matches!(
        file_patch(fixture.path(), &comparison, "notes.txt")
            .unwrap_err()
            .kind,
        ErrorKind::UnchangedPath
    ));
    assert!(matches!(
        file_patch(fixture.path(), &comparison, "../outside.txt")
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedPath
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn compares_a_worktree_and_reports_a_non_utf8_untracked_name_as_unsupported() {
    use std::os::unix::ffi::OsStrExt;
    let fixture = Fixture::new();
    let oid = fixture.commit("a.txt", "a\n", "first");
    fs::write(
        fixture
            .repo
            .join(std::ffi::OsStr::from_bytes(b"bad\xff.txt")),
        "new\n",
    )
    .unwrap();
    let comparison = Comparison {
        base: Base::Commit { oid },
        target: Target::Worktree {
            root: fixture.path().to_owned(),
        },
    };
    assert_eq!(
        paths(comparison.clone(), &fixture),
        [changed("bad\u{FFFD}.txt", ChangeStatus::Added)]
    );
    assert!(matches!(
        file_patch(fixture.path(), &comparison, "bad\u{FFFD}.txt")
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedPath
    ));
}

#[test]
fn rejects_a_worktree_target_without_a_base_commit_or_from_another_repository() {
    let fixture = Fixture::new();
    let oid = fixture.commit("a.txt", "a\n", "first");
    let other = Fixture::new();
    other.commit("b.txt", "b\n", "other");
    let worktree = |base, root: &str| Comparison {
        base,
        target: Target::Worktree {
            root: root.to_owned(),
        },
    };
    assert!(matches!(
        commit_detail(
            fixture.path(),
            &worktree(Base::FirstParent {}, fixture.path())
        )
        .unwrap_err()
        .kind,
        ErrorKind::InvalidOid
    ));
    assert!(matches!(
        commit_detail(
            fixture.path(),
            &worktree(Base::Commit { oid }, other.path())
        )
        .unwrap_err()
        .kind,
        ErrorKind::MissingPath
    ));
}

#[test]
fn file_patch_reads_text_against_the_first_parent_and_the_empty_tree() {
    let fixture = Fixture::new();
    let root = fixture.commit("notes.txt", "one\ntwo\n", "initial");
    let second = fixture.commit("notes.txt", "one\n2\n", "edit");
    assert_eq!(
        file_patch(fixture.path(), &Comparison::commit(&root), "notes.txt").unwrap(),
        FilePatch::Text {
            patch: "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\nindex 0000000..814f4a4\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n".into(),
            lossy: false,
        }
    );
    assert_eq!(
        file_patch(fixture.path(), &Comparison::commit(&second), "notes.txt").unwrap(),
        FilePatch::Text {
            patch: "diff --git a/notes.txt b/notes.txt\nindex 814f4a4..99b356d 100644\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n".into(),
            lossy: false,
        }
    );
}

#[test]
fn file_patch_flags_text_that_is_not_valid_utf8() {
    let fixture = Fixture::new();
    fixture.commit("latin1.txt", "caf\n", "initial");
    fs::write(fixture.repo.join("latin1.txt"), b"caf\xe9\n").unwrap();
    git(&fixture.repo, &["commit", "-am", "latin-1"]);
    let oid = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let FilePatch::Text { patch, lossy } =
        file_patch(fixture.path(), &Comparison::commit(&oid), "latin1.txt").unwrap()
    else {
        panic!("expected a text patch");
    };
    assert!(lossy);
    assert!(patch.ends_with("-caf\n+caf\u{FFFD}\n"), "{patch:?}");
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
        file_patch(fixture.path(), &Comparison::commit(&oid), "logo.png").unwrap(),
        FilePatch::Binary
    );
    assert_eq!(
        file_patch(fixture.path(), &Comparison::commit(&oid), "large.txt").unwrap(),
        FilePatch::TooLarge { bytes: 1_190_129 }
    );
}

#[test]
fn file_history_follows_a_rename_and_names_the_path_in_each_commit() {
    let fixture = Fixture::new();
    fixture.commit("old.txt", "one\n", "add old");
    fixture.commit("other.txt", "other\n", "touch another file");
    fixture.commit("old.txt", "one\ntwo\n", "edit old");
    git(&fixture.repo, &["mv", "old.txt", "new.txt"]);
    git(&fixture.repo, &["commit", "-m", "rename"]);
    let tip = fixture.commit("new.txt", "one\ntwo\nthree\n", "edit new");
    let history = file_history(fixture.path(), &tip, "new.txt").unwrap();
    let oids: Vec<_> = history.iter().map(|r| r.commit.oid.as_str()).collect();
    assert_eq!(
        oids,
        [
            "61efd688e8086e1e99772b245bb30d20ce5f319e",
            "7d7f7a24dd7f5cd415bab006a874e80bedcfb36d",
            "f83e54f247619626054bca27eca8f21e53dfad68",
            "90221ff9945e6c07dde9f7660f4202dd7756403e",
        ]
    );
    let named: Vec<_> = history
        .iter()
        .map(|r| (r.commit.subject.as_str(), r.path.as_str()))
        .collect();
    assert_eq!(
        named,
        [
            ("edit new", "new.txt"),
            ("rename", "new.txt"),
            ("edit old", "old.txt"),
            ("add old", "old.txt"),
        ]
    );
    let older = oids[2];
    assert_eq!(
        file_history(fixture.path(), older, "old.txt")
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn file_history_rejects_an_unknown_commit_and_an_empty_path() {
    let fixture = Fixture::new();
    let oid = fixture.commit("a.txt", "a\n", "initial");
    assert!(matches!(
        file_history(fixture.path(), &"0".repeat(40), "a.txt")
            .unwrap_err()
            .kind,
        ErrorKind::InvalidOid
    ));
    assert!(matches!(
        file_history(fixture.path(), "HEAD", "a.txt")
            .unwrap_err()
            .kind,
        ErrorKind::InvalidOid
    ));
    assert!(matches!(
        file_history(fixture.path(), &oid, "").unwrap_err().kind,
        ErrorKind::UnsupportedPath
    ));
}

#[test]
fn blame_reads_ranges_for_a_file_edited_by_two_authors() {
    let fixture = Fixture::new();
    let first = fixture.commit("story.txt", "a\nb\nc\nd\n", "write story");
    fs::write(fixture.repo.join("story.txt"), "a\nB\nC\nd\ne\n").unwrap();
    git_dated(
        &fixture.repo,
        &[
            "commit",
            "-am",
            "revise story",
            "--author=Bo <bo@example.test>",
        ],
        b"",
        "1700086400 +0000",
    );
    let second = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let Blame::Text {
        contents,
        lossy,
        ranges,
    } = blame(fixture.path(), &second, "story.txt").unwrap()
    else {
        panic!("expected text");
    };
    assert_eq!(contents, "a\nB\nC\nd\ne\n");
    assert!(!lossy);
    let range =
        |oid: &str, start, lines, author: &str, email: &str, timestamp, summary: &str| BlameRange {
            oid: oid.to_owned(),
            start,
            lines,
            author: author.into(),
            email: email.into(),
            timestamp,
            summary: summary.into(),
        };
    let ada = |start, lines| {
        range(
            &first,
            start,
            lines,
            "Ada",
            "ada@example.test",
            1_700_000_000,
            "write story",
        )
    };
    let bo = |start, lines| {
        range(
            &second,
            start,
            lines,
            "Bo",
            "bo@example.test",
            1_700_086_400,
            "revise story",
        )
    };
    assert_eq!(ranges, vec![ada(1, 1), bo(2, 2), ada(4, 1), bo(5, 1)]);
}

#[test]
fn blame_ignores_a_configured_ignore_revs_file() {
    let fixture = Fixture::new();
    let oid = fixture.commit("a.txt", "a\n", "initial");
    git(
        &fixture.repo,
        &["config", "blame.ignoreRevsFile", "missing-revs.txt"],
    );
    let Blame::Text { ranges, .. } = blame(fixture.path(), &oid, "a.txt").unwrap() else {
        panic!("expected text");
    };
    assert_eq!(ranges.len(), 1);
}

#[test]
fn blame_names_authors_as_the_history_does_and_reads_an_empty_file() {
    let fixture = Fixture::new();
    fixture.commit(
        ".mailmap",
        "Mapped <mapped@example.test> <ada@example.test>\n",
        "map",
    );
    let oid = fixture.commit("empty.txt", "", "empty");
    let Blame::Text {
        contents, ranges, ..
    } = blame(fixture.path(), &oid, ".mailmap").unwrap()
    else {
        panic!("expected text");
    };
    assert_eq!(
        contents,
        "Mapped <mapped@example.test> <ada@example.test>\n"
    );
    let commit = snapshot(fixture.path())
        .unwrap()
        .commits
        .into_iter()
        .find(|commit| commit.oid == ranges[0].oid)
        .unwrap();
    assert_eq!(
        (ranges[0].author.as_str(), ranges[0].email.as_str()),
        (commit.author.as_str(), commit.email.as_str())
    );
    assert_eq!(ranges[0].author, "Ada");
    assert_eq!(
        blame(fixture.path(), &oid, "empty.txt").unwrap(),
        Blame::Text {
            contents: String::new(),
            lossy: false,
            ranges: Vec::new(),
        }
    );
}

#[test]
fn blame_keeps_a_missing_final_newline() {
    let fixture = Fixture::new();
    let oid = fixture.commit("tail.txt", "one\ntwo", "no final newline");
    let Blame::Text { contents, .. } = blame(fixture.path(), &oid, "tail.txt").unwrap() else {
        panic!("expected text");
    };
    assert_eq!(contents, "one\ntwo");
}

#[test]
fn blame_reports_binary_oversized_missing_and_submodule_paths() {
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
    git(
        &fixture.repo,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{oid},vendor"),
        ],
    );
    git(&fixture.repo, &["commit", "-m", "submodule"]);
    let with_submodule = git(&fixture.repo, &["rev-parse", "HEAD"]);
    assert_eq!(
        blame(fixture.path(), &oid, "logo.png").unwrap(),
        Blame::Binary
    );
    assert_eq!(
        blame(fixture.path(), &oid, "large.txt").unwrap(),
        Blame::TooLarge { bytes: 1_120_000 }
    );
    for (commit, path) in [
        (&oid, "missing.txt"),
        (&oid, ""),
        (&with_submodule, "vendor"),
    ] {
        assert!(
            matches!(
                blame(fixture.path(), commit, path).unwrap_err().kind,
                ErrorKind::UnsupportedPath
            ),
            "{path:?}"
        );
    }
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
                file_patch(fixture.path(), &Comparison::commit(&oid), path)
                    .unwrap_err()
                    .kind,
                ErrorKind::UnchangedPath
            ),
            "{path:?}"
        );
    }
    assert!(matches!(
        file_patch(
            fixture.path(),
            &Comparison::commit("HEAD"),
            "dir/changed.txt"
        )
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
        file_patch(fixture.path(), &Comparison::commit(&oid), "*").unwrap(),
        FilePatch::Text {
            patch: "diff --git a/* b/*\nnew file mode 100644\nindex 0000000..ce7b819\n--- /dev/null\n+++ b/*\n@@ -0,0 +1 @@\n+star\n\\ No newline at end of file\n".into(),
            lossy: false,
        }
    );
    assert!(matches!(
        file_patch(fixture.path(), &Comparison::commit(&oid), ":(glob)*")
            .unwrap_err()
            .kind,
        ErrorKind::UnchangedPath
    ));
}

#[test]
fn file_patch_leaves_non_ascii_names_unquoted() {
    let fixture = Fixture::new();
    let oid = fixture.commit("café.txt", "crème\n", "initial");
    let FilePatch::Text { patch, .. } =
        file_patch(fixture.path(), &Comparison::commit(&oid), "café.txt").unwrap()
    else {
        panic!("expected a text patch");
    };
    assert!(
        patch.starts_with("diff --git a/café.txt b/café.txt\n"),
        "{patch:?}"
    );
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
    let detail = commit_detail(fixture.path(), &Comparison::commit(&oid)).unwrap();
    assert_eq!(detail.files[0].path, "bad\u{FFFD}.txt");
    assert!(matches!(
        file_patch(
            fixture.path(),
            &Comparison::commit(&oid),
            &detail.files[0].path
        )
        .unwrap_err()
        .kind,
        ErrorKind::UnsupportedPath
    ));
}

#[test]
fn line_stats_count_lines_against_the_first_parent_or_the_empty_tree() {
    let fixture = Fixture::new();
    let root = fixture.commit("notes", "one\ntwo\n", "root");
    let edit = fixture.commit("notes", "one\nTWO\nthree\n", "edit");
    fs::write(
        fixture.repo.join("logo.png"),
        [0x89, b'P', b'N', b'G', 0, 1],
    )
    .unwrap();
    git(&fixture.repo, &["add", "logo.png"]);
    let binary = fixture.commit("notes", "one\nTWO\nthree\nfour\n", "binary");
    git(&fixture.repo, &["commit", "--allow-empty", "-m", "empty"]);
    let empty = git(&fixture.repo, &["rev-parse", "HEAD"]);
    git(&fixture.repo, &["checkout", "-b", "feature"]);
    fixture.commit("feature.txt", "a\nb\nc\n", "feature");
    git(&fixture.repo, &["checkout", "main"]);
    fixture.commit("main.txt", "main\n", "main");
    git(
        &fixture.repo,
        &["merge", "--no-ff", "feature", "-m", "merge"],
    );
    let merge = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let missing = "0123456789abcdef0123456789abcdef01234567".to_owned();
    let stats = |oid: &String, added, deleted| LineStats {
        oid: oid.clone(),
        added,
        deleted,
    };
    assert_eq!(
        line_stats(
            fixture.path(),
            &[
                merge.clone(),
                missing,
                empty.clone(),
                binary.clone(),
                edit.clone(),
                root.clone()
            ]
        )
        .unwrap(),
        [
            stats(&merge, 3, 0),
            stats(&empty, 0, 0),
            stats(&binary, 1, 0),
            stats(&edit, 2, 1),
            stats(&root, 2, 0),
        ]
    );
    assert!(matches!(
        line_stats(fixture.path(), &["HEAD".to_owned()])
            .unwrap_err()
            .kind,
        ErrorKind::InvalidOid
    ));
    assert!(matches!(
        line_stats(fixture.path(), &vec![root; LINE_STATS_LIMIT + 1])
            .unwrap_err()
            .kind,
        ErrorKind::InvalidOid
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
    let mut subjects = snapshot(fixture.path())
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
    let result = commit_detail(clone.to_str().unwrap(), &Comparison::commit(&oid))
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
        snapshot("/not/a/real/l1git/path").unwrap_err().kind,
        ErrorKind::MissingPath
    ));
    assert!(matches!(
        snapshot(fixture._directory.path().to_str().unwrap())
            .unwrap_err()
            .kind,
        ErrorKind::NotRepository
    ));
    let bare = fixture._directory.path().join("bare.git");
    fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    assert!(matches!(
        snapshot(bare.to_str().unwrap()).unwrap_err().kind,
        ErrorKind::BareRepository
    ));
    for oid in [
        "HEAD",
        "--all",
        "abc",
        "0000000000000000000000000000000000000000",
    ] {
        assert!(matches!(
            commit_detail(fixture.path(), &Comparison::commit(oid))
                .unwrap_err()
                .kind,
            ErrorKind::InvalidOid
        ));
    }
}

fn staged_at(repo: &Path, path: &str, stage: char) -> Option<IndexObject> {
    git(
        repo,
        &["--literal-pathspecs", "ls-files", "-s", "-z", "--", path],
    )
    .split('\0')
    .find_map(|record| {
        let (entry, name) = record.split_once('\t')?;
        let [mode, oid, at] = entry.split(' ').collect::<Vec<_>>()[..] else {
            panic!("{record}");
        };
        (name == path && at.starts_with(stage)).then(|| IndexObject {
            mode: serde_json::from_value(mode.into()).unwrap(),
            oid: Oid::try_from(oid.to_owned()).unwrap(),
        })
    })
}

fn index_at(repo: &Path, path: &str) -> Option<IndexObject> {
    staged_at(repo, path, '0')
}

fn ordinary(repo: &Path, path: &str, sides: Sides) -> StatusEntry {
    StatusEntry::Ordinary {
        path: path.into(),
        submodule: None,
        sides,
        index: index_at(repo, path),
    }
}

fn untracked(path: &str) -> StatusEntry {
    StatusEntry::Untracked { path: path.into() }
}

fn unmerged(repo: &Path, path: &str, conflict: Conflict) -> StatusEntry {
    StatusEntry::Unmerged {
        path: path.into(),
        conflict,
        submodule: None,
        stages: Stages {
            base: staged_at(repo, path, '1'),
            ours: staged_at(repo, path, '2'),
            theirs: staged_at(repo, path, '3'),
        },
    }
}

fn diff(patch: &str) -> WorktreePatch {
    WorktreePatch::Diff {
        diff: FilePatch::Text {
            patch: patch.into(),
            lossy: false,
        },
    }
}

fn text(patch: &str) -> Option<FilePatch> {
    Some(FilePatch::Text {
        patch: patch.into(),
        lossy: false,
    })
}

fn merge(fixture: &Fixture, branch: &str) {
    let merge = Command::new("git")
        .arg("-C")
        .arg(&fixture.repo)
        .args([
            "-c",
            "user.name=Ada",
            "-c",
            "user.email=ada@example.test",
            "merge",
            branch,
        ])
        .output()
        .unwrap();
    assert!(!merge.status.success());
}

#[test]
fn worktree_status_tags_staged_unstaged_renamed_and_untracked_paths() {
    let fixture = Fixture::new();
    for name in [
        "staged.txt",
        "unstaged.txt",
        "both.txt",
        "old name.txt",
        "line\nbreak.txt",
        "clean.txt",
    ] {
        fs::write(fixture.repo.join(name), format!("{name}\none\ntwo\n")).unwrap();
    }
    git(&fixture.repo, &["add", "."]);
    git(&fixture.repo, &["commit", "-m", "initial"]);
    let oid = git(&fixture.repo, &["rev-parse", "HEAD"]);
    fs::write(fixture.repo.join("staged.txt"), "staged\n").unwrap();
    git(&fixture.repo, &["add", "staged.txt"]);
    fs::write(fixture.repo.join("unstaged.txt"), "unstaged\n").unwrap();
    fs::write(fixture.repo.join("both.txt"), "staged\n").unwrap();
    git(&fixture.repo, &["add", "both.txt"]);
    fs::write(fixture.repo.join("both.txt"), "staged\nthen edited\n").unwrap();
    git(&fixture.repo, &["mv", "old name.txt", "new name.txt"]);
    fs::write(
        fixture.repo.join("new name.txt"),
        "old name.txt\none\ntwo\nthree\n",
    )
    .unwrap();
    fs::write(fixture.repo.join("line\nbreak.txt"), "edited\n").unwrap();
    fs::write(fixture.repo.join("with space.txt"), "new\n").unwrap();
    fs::create_dir(fixture.repo.join("folder")).unwrap();
    fs::write(fixture.repo.join("folder/nested\nname.txt"), "new\n").unwrap();
    let status = worktree_status(fixture.path()).unwrap();
    assert_eq!(
        status,
        WorktreeStatus {
            staged_stamp: status.staged_stamp.clone(),
            root: snapshot(fixture.path()).unwrap().root,
            head: Head::Attached {
                reference: "refs/heads/main".into(),
                oid,
            },
            entries: vec![
                ordinary(
                    &fixture.repo,
                    "both.txt",
                    Sides::Both {
                        staged: ChangeStatus::Modified,
                        unstaged: ChangeStatus::Modified,
                    }
                ),
                ordinary(
                    &fixture.repo,
                    "line\nbreak.txt",
                    Sides::Unstaged {
                        unstaged: ChangeStatus::Modified,
                    }
                ),
                StatusEntry::Renamed {
                    path: "new name.txt".into(),
                    original: "old name.txt".into(),
                    how: Moved::Renamed,
                    submodule: None,
                    side: MoveSide::Staged {
                        unstaged: Some(ChangeStatus::Modified),
                        index: index_at(&fixture.repo, "new name.txt").unwrap(),
                    },
                },
                ordinary(
                    &fixture.repo,
                    "staged.txt",
                    Sides::Staged {
                        staged: ChangeStatus::Modified,
                    }
                ),
                ordinary(
                    &fixture.repo,
                    "unstaged.txt",
                    Sides::Unstaged {
                        unstaged: ChangeStatus::Modified,
                    }
                ),
                untracked("folder/nested\nname.txt"),
                untracked("with space.txt"),
            ],
        }
    );
}

#[test]
fn worktree_status_and_patch_read_every_conflict_kind() {
    let fixture = Fixture::new();
    fs::write(fixture.repo.join("shared.txt"), "base\n").unwrap();
    fs::write(fixture.repo.join("gone.txt"), "moved\nlines\n").unwrap();
    fs::write(fixture.repo.join("kept by us.txt"), "base\n").unwrap();
    fs::write(fixture.repo.join("kept by them.txt"), "base\n").unwrap();
    git(&fixture.repo, &["add", "."]);
    git(&fixture.repo, &["commit", "-m", "initial"]);
    git(&fixture.repo, &["switch", "-c", "theirs"]);
    fs::write(fixture.repo.join("shared.txt"), "theirs\n").unwrap();
    fs::write(fixture.repo.join("both added.txt"), "theirs\n").unwrap();
    fs::write(fixture.repo.join("kept by them.txt"), "theirs\n").unwrap();
    fs::remove_file(fixture.repo.join("kept by us.txt")).unwrap();
    git(&fixture.repo, &["mv", "gone.txt", "theirs.txt"]);
    git(&fixture.repo, &["add", "-A"]);
    git(&fixture.repo, &["commit", "-m", "theirs"]);
    git(&fixture.repo, &["switch", "main"]);
    fs::write(fixture.repo.join("shared.txt"), "ours\n").unwrap();
    fs::write(fixture.repo.join("both added.txt"), "ours\n").unwrap();
    fs::write(fixture.repo.join("kept by us.txt"), "ours\n").unwrap();
    fs::remove_file(fixture.repo.join("kept by them.txt")).unwrap();
    git(&fixture.repo, &["mv", "gone.txt", "ours.txt"]);
    git(&fixture.repo, &["add", "-A"]);
    git(&fixture.repo, &["commit", "-m", "ours"]);
    merge(&fixture, "theirs");
    assert_eq!(
        worktree_status(fixture.path()).unwrap().entries,
        vec![
            unmerged(&fixture.repo, "both added.txt", Conflict::BothAdded),
            unmerged(&fixture.repo, "gone.txt", Conflict::BothDeleted),
            unmerged(&fixture.repo, "kept by them.txt", Conflict::DeletedByUs),
            unmerged(&fixture.repo, "kept by us.txt", Conflict::DeletedByThem),
            unmerged(&fixture.repo, "ours.txt", Conflict::AddedByUs),
            unmerged(&fixture.repo, "shared.txt", Conflict::BothModified),
            unmerged(&fixture.repo, "theirs.txt", Conflict::AddedByThem),
        ]
    );
    let expected = [
        (
            "both added.txt",
            Conflict::BothAdded,
            text(
                "diff --git a/both added.txt b/both added.txt\nindex b19a1e93bec1317dc6097229e12afaffbfa74dc2..5eb9640fc3f80dac61e1d3494746a7cd2aa5e64e 100644\n--- a/both added.txt\t\n+++ b/both added.txt\t\n@@ -1 +1,5 @@\n+<<<<<<< HEAD\n ours\n+=======\n+theirs\n+>>>>>>> theirs\n",
            ),
        ),
        ("gone.txt", Conflict::BothDeleted, None),
        (
            "kept by them.txt",
            Conflict::DeletedByUs,
            text(
                "diff --git a/kept by them.txt b/kept by them.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..950b81b7eee953d050aa05a641f8e056c85dd1bd\n--- /dev/null\n+++ b/kept by them.txt\t\n@@ -0,0 +1 @@\n+theirs\n",
            ),
        ),
        ("kept by us.txt", Conflict::DeletedByThem, None),
        ("ours.txt", Conflict::AddedByUs, None),
        (
            "shared.txt",
            Conflict::BothModified,
            text(
                "diff --git a/shared.txt b/shared.txt\nindex b19a1e93bec1317dc6097229e12afaffbfa74dc2..5eb9640fc3f80dac61e1d3494746a7cd2aa5e64e 100644\n--- a/shared.txt\n+++ b/shared.txt\n@@ -1 +1,5 @@\n+<<<<<<< HEAD\n ours\n+=======\n+theirs\n+>>>>>>> theirs\n",
            ),
        ),
        (
            "theirs.txt",
            Conflict::AddedByThem,
            text(
                "diff --git a/theirs.txt b/theirs.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..27cc1fc6636cc4c570f9f4bf9a3000d9e70793ab\n--- /dev/null\n+++ b/theirs.txt\n@@ -0,0 +1,2 @@\n+moved\n+lines\n",
            ),
        ),
    ];
    for (file, conflict, diff) in expected {
        for side in [Side::Staged, Side::Unstaged] {
            assert_eq!(
                worktree_patch(fixture.path(), file, side).unwrap(),
                WorktreePatch::Conflicted {
                    conflict,
                    diff: diff.clone(),
                },
                "{file} {side:?}"
            );
        }
    }
}

#[test]
fn worktree_status_reads_head_from_the_real_ref() {
    let fixture = Fixture::new();
    let first = fixture.commit("notes.txt", "one\n", "initial");
    assert_eq!(worktree_status(fixture.path()).unwrap().entries, vec![]);
    let agrees = |path: &str| {
        let head = worktree_status(path).unwrap().head;
        assert_eq!(head, snapshot(path).unwrap().head);
        head
    };
    git(&fixture.repo, &["switch", "-c", "(detached)"]);
    assert_eq!(
        agrees(fixture.path()),
        Head::Attached {
            reference: "refs/heads/(detached)".into(),
            oid: first.clone(),
        }
    );
    git(&fixture.repo, &["tag", "v1"]);
    git(&fixture.repo, &["symbolic-ref", "HEAD", "refs/tags/v1"]);
    assert_eq!(
        agrees(fixture.path()),
        Head::Attached {
            reference: "refs/tags/v1".into(),
            oid: first.clone(),
        }
    );
    git(&fixture.repo, &["switch", "main"]);

    let detached = fixture._directory.path().join("detached");
    git(
        &fixture.repo,
        &[
            "worktree",
            "add",
            "--detach",
            detached.to_str().unwrap(),
            &first,
        ],
    );
    assert_eq!(
        agrees(detached.to_str().unwrap()),
        Head::Detached { oid: first }
    );

    let unborn = fixture._directory.path().join("unborn");
    fs::create_dir(&unborn).unwrap();
    git(&unborn, &["init", "--initial-branch=(detached)"]);
    fs::write(unborn.join("added.txt"), "added\n").unwrap();
    git(&unborn, &["add", "added.txt"]);
    fs::write(unborn.join("loose.txt"), "loose\n").unwrap();
    let status = worktree_status(unborn.to_str().unwrap()).unwrap();
    assert_eq!(
        status,
        WorktreeStatus {
            staged_stamp: status.staged_stamp.clone(),
            root: snapshot(unborn.to_str().unwrap()).unwrap().root,
            head: Head::Unborn {
                reference: "refs/heads/(detached)".into(),
            },
            entries: vec![
                ordinary(
                    &unborn,
                    "added.txt",
                    Sides::Staged {
                        staged: ChangeStatus::Added,
                    }
                ),
                untracked("loose.txt"),
            ],
        }
    );
}

#[test]
fn worktree_reads_leave_the_index_untouched() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    let index = fixture.repo.join(".git/index");
    let before = fs::read(&index).unwrap();
    let modified = fs::metadata(&index).unwrap().modified().unwrap();
    fs::File::options()
        .write(true)
        .open(fixture.repo.join("notes.txt"))
        .unwrap()
        .set_modified(modified + std::time::Duration::from_secs(10))
        .unwrap();
    fs::write(fixture.repo.join("loose.txt"), "loose\n").unwrap();
    assert_eq!(
        worktree_status(fixture.path()).unwrap().entries,
        vec![untracked("loose.txt")]
    );
    assert!(worktree_patch(fixture.path(), "loose.txt", Side::Unstaged).is_ok());
    for side in [Side::Staged, Side::Unstaged] {
        assert!(worktree_patch(fixture.path(), "notes.txt", side).is_err());
    }
    assert_eq!(fs::metadata(&index).unwrap().modified().unwrap(), modified);
    assert_eq!(fs::read(&index).unwrap(), before);
}

#[test]
fn worktree_patch_splits_staged_and_unstaged_sides() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\ntwo\n", "initial");
    fixture.commit("gone.txt", "bye\n", "second");
    fixture.commit("kept.txt", "kept\n", "third");
    fs::write(fixture.repo.join("notes.txt"), "one\n2\n").unwrap();
    git(&fixture.repo, &["add", "notes.txt"]);
    fs::write(fixture.repo.join("notes.txt"), "one\n2\nthree\n").unwrap();
    fs::remove_file(fixture.repo.join("gone.txt")).unwrap();
    git(&fixture.repo, &["rm", "--cached", "--quiet", "kept.txt"]);
    assert_eq!(
        worktree_patch(fixture.path(), "notes.txt", Side::Staged).unwrap(),
        diff(
            "diff --git a/notes.txt b/notes.txt\nindex 814f4a422927b82f5f8a43f8fab6d3839e3983f2..99b356dcd03dde0755c749bcd4cae4b2b73a8fa8 100644\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n"
        )
    );
    assert_eq!(
        worktree_patch(fixture.path(), "notes.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/notes.txt b/notes.txt\nindex 99b356dcd03dde0755c749bcd4cae4b2b73a8fa8..f04eb265ebd74fba2cddf0a6adf2a6a7f81c87aa 100644\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,3 @@\n one\n 2\n+three\n"
        )
    );
    assert_eq!(
        worktree_patch(fixture.path(), "gone.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex b023018cabc396e7692c70bbf5784a93d3f738ab..0000000000000000000000000000000000000000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
        )
    );
    let error = worktree_patch(fixture.path(), "gone.txt", Side::Staged).unwrap_err();
    assert!(matches!(error.kind, ErrorKind::UnchangedPath));
    assert_eq!(
        error.message,
        "This file has no staged changes. Refresh the worktree status."
    );
    assert_eq!(
        worktree_patch(fixture.path(), "kept.txt", Side::Staged).unwrap(),
        diff(
            "diff --git a/kept.txt b/kept.txt\ndeleted file mode 100644\nindex bd93009536360a2d96f2b097ac88b28f1fc8cdb4..0000000000000000000000000000000000000000\n--- a/kept.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-kept\n"
        )
    );
    assert_eq!(
        worktree_patch(fixture.path(), "kept.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/kept.txt b/kept.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..bd93009536360a2d96f2b097ac88b28f1fc8cdb4\n--- /dev/null\n+++ b/kept.txt\n@@ -0,0 +1 @@\n+kept\n"
        )
    );
}

#[test]
fn worktree_patch_shows_a_staged_rename_with_its_edits() {
    let fixture = Fixture::new();
    fixture.commit("old.txt", "one\ntwo\nthree\nfour\n", "initial");
    git(&fixture.repo, &["mv", "old.txt", "new.txt"]);
    fs::write(fixture.repo.join("new.txt"), "one\ntwo\nthree\n4\n").unwrap();
    git(&fixture.repo, &["add", "new.txt"]);
    fs::write(fixture.repo.join("new.txt"), "one\ntwo\nthree\n4\nfive\n").unwrap();
    assert_eq!(
        worktree_patch(fixture.path(), "new.txt", Side::Staged).unwrap(),
        diff(
            "diff --git a/old.txt b/new.txt\nsimilarity index 73%\nrename from old.txt\nrename to new.txt\nindex f384549cbeb481e437091320de6d1f2e15e11b4a..edb299e1fc6dc01d9d84b5cec97e815a3f5a09da 100644\n--- a/old.txt\n+++ b/new.txt\n@@ -1,4 +1,4 @@\n one\n two\n three\n-four\n+4\n"
        )
    );
    assert_eq!(
        worktree_patch(fixture.path(), "new.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/new.txt b/new.txt\nindex edb299e1fc6dc01d9d84b5cec97e815a3f5a09da..82773b0efaae74b4561105269c6a3cc9a27c3abc 100644\n--- a/new.txt\n+++ b/new.txt\n@@ -2,3 +2,4 @@ one\n two\n three\n 4\n+five\n"
        )
    );
}

#[test]
fn worktree_status_and_patch_read_a_move_added_with_intent_to_add() {
    let fixture = Fixture::new();
    fixture.commit("old.txt", "one\ntwo\nthree\nfour\n", "initial");
    fs::rename(fixture.repo.join("old.txt"), fixture.repo.join("new.txt")).unwrap();
    git(&fixture.repo, &["add", "--intent-to-add", "new.txt"]);
    assert_eq!(
        worktree_status(fixture.path()).unwrap().entries,
        vec![StatusEntry::Renamed {
            path: "new.txt".into(),
            original: "old.txt".into(),
            how: Moved::Renamed,
            submodule: None,
            side: MoveSide::Unstaged {
                original: index_at(&fixture.repo, "old.txt").unwrap(),
            },
        }]
    );
    assert_eq!(
        worktree_patch(fixture.path(), "new.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n"
        )
    );
    let error = worktree_patch(fixture.path(), "new.txt", Side::Staged).unwrap_err();
    assert!(matches!(error.kind, ErrorKind::UnchangedPath), "{error:?}");
}

#[test]
fn worktree_patch_shows_untracked_files_as_added_on_the_unstaged_side() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    fs::write(fixture.repo.join("with space.txt"), "hello\nworld\n").unwrap();
    fs::write(fixture.repo.join("café.txt"), "crème\n").unwrap();
    fs::write(
        fixture.repo.join("logo.png"),
        [0x89, b'P', b'N', b'G', 0, 1],
    )
    .unwrap();
    fs::write(
        fixture.repo.join("large.txt"),
        "0123456789abcde\n".repeat(70_000),
    )
    .unwrap();
    assert_eq!(
        worktree_patch(fixture.path(), "with space.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/with space.txt b/with space.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..94954abda49de8615a048f8d2e64b5de848e27a1\n--- /dev/null\n+++ b/with space.txt\t\n@@ -0,0 +1,2 @@\n+hello\n+world\n"
        )
    );
    assert_eq!(
        worktree_patch(fixture.path(), "café.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/café.txt b/café.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..8049d57230284eb1e7b8fb6a9a3d68c565bbdee2\n--- /dev/null\n+++ b/café.txt\n@@ -0,0 +1 @@\n+crème\n"
        )
    );
    assert_eq!(
        worktree_patch(fixture.path(), "logo.png", Side::Unstaged).unwrap(),
        WorktreePatch::Diff {
            diff: FilePatch::Binary
        }
    );
    assert_eq!(
        worktree_patch(fixture.path(), "large.txt", Side::Unstaged).unwrap(),
        WorktreePatch::Diff {
            diff: FilePatch::TooLarge { bytes: 1_120_000 }
        }
    );
    let error = worktree_patch(fixture.path(), "with space.txt", Side::Staged).unwrap_err();
    assert!(matches!(error.kind, ErrorKind::UnchangedPath));
}

#[cfg(unix)]
#[test]
fn worktree_patch_reads_untracked_symlinks_without_following_them() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    let outside = fixture._directory.path();
    fs::create_dir(outside.join("with null")).unwrap();
    fs::write(outside.join("with null/null"), "OUTSIDE-NULL-SECRET\n").unwrap();
    fs::create_dir(outside.join("without null")).unwrap();
    fs::write(outside.join("secret.txt"), "OUTSIDE-FILE-SECRET\n").unwrap();
    assert!(
        Command::new("mkfifo")
            .arg(outside.join("fifo"))
            .status()
            .unwrap()
            .success()
    );
    let links = [
        ("to dir", "../with null"),
        ("to empty dir", "../without null"),
        ("to file", "../secret.txt"),
        ("to fifo", "../fifo"),
        ("broken", "missing"),
        ("odd\nname", "target"),
    ];
    for (name, target) in links {
        symlink(target, fixture.repo.join(name)).unwrap();
    }
    let path = fixture.path().to_owned();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let patches: Vec<_> = links
            .iter()
            .map(|(name, _)| worktree_patch(&path, name, Side::Unstaged))
            .collect();
        let _ = sender.send(patches);
    });
    let patches = receiver
        .recv_timeout(std::time::Duration::from_secs(20))
        .expect("a symlink read hung");
    assert_eq!(
        patches.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
        vec![
            diff(
                "diff --git a/to dir b/to dir\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..440d74ac48b8da9a4db8e41c520476957674e62c\n--- /dev/null\n+++ b/to dir\t\n@@ -0,0 +1 @@\n+../with null\n\\ No newline at end of file\n"
            ),
            diff(
                "diff --git a/to empty dir b/to empty dir\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..d76cc606224471c316e6064fdc46fa25698a755f\n--- /dev/null\n+++ b/to empty dir\t\n@@ -0,0 +1 @@\n+../without null\n\\ No newline at end of file\n"
            ),
            diff(
                "diff --git a/to file b/to file\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..54707ca7814ef46338e75afbc95f399b9d0dac7f\n--- /dev/null\n+++ b/to file\t\n@@ -0,0 +1 @@\n+../secret.txt\n\\ No newline at end of file\n"
            ),
            diff(
                "diff --git a/to fifo b/to fifo\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..3c8a36b7f613603fac0348c2b5ed3e93d27d9d9f\n--- /dev/null\n+++ b/to fifo\t\n@@ -0,0 +1 @@\n+../fifo\n\\ No newline at end of file\n"
            ),
            diff(
                "diff --git a/broken b/broken\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..6eab79a6ce25b19851f591e3e974e192c6858cf6\n--- /dev/null\n+++ b/broken\n@@ -0,0 +1 @@\n+missing\n\\ No newline at end of file\n"
            ),
            diff(
                "diff --git \"a/odd\\nname\" \"b/odd\\nname\"\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..1de565933b05f74c75ff9a6520af5f9f8a5a2f1d\n--- /dev/null\n+++ \"b/odd\\nname\"\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n"
            )
        ]
    );
}

#[test]
fn worktree_patch_diffs_against_the_empty_tree_before_the_first_commit() {
    let fixture = Fixture::new();
    fs::write(fixture.repo.join("first.txt"), "first\n").unwrap();
    git(&fixture.repo, &["add", "first.txt"]);
    fs::write(fixture.repo.join("loose.txt"), "loose\n").unwrap();
    assert_eq!(
        worktree_patch(fixture.path(), "first.txt", Side::Staged).unwrap(),
        diff(
            "diff --git a/first.txt b/first.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..9c59e24b8393179a5d712de4f990178df5734d99\n--- /dev/null\n+++ b/first.txt\n@@ -0,0 +1 @@\n+first\n"
        )
    );
    assert!(worktree_patch(fixture.path(), "first.txt", Side::Unstaged).is_err());
    assert_eq!(
        worktree_patch(fixture.path(), "loose.txt", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/loose.txt b/loose.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..b6586661e7ec0a4c9389276355d01e145861eb0c\n--- /dev/null\n+++ b/loose.txt\n@@ -0,0 +1 @@\n+loose\n"
        )
    );
}

#[test]
fn worktree_patch_marks_submodules_with_a_notice() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    let source = fixture._directory.path().join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "--initial-branch=main"]);
    fs::write(source.join("inner.txt"), "inner\n").unwrap();
    git(&source, &["add", "inner.txt"]);
    git(&source, &["commit", "-m", "inner"]);
    git(
        &fixture.repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            source.to_str().unwrap(),
            "module",
        ],
    );
    git(&fixture.repo, &["commit", "-m", "add module"]);
    fs::write(fixture.repo.join("module/inner.txt"), "edited\n").unwrap();
    fs::write(fixture.repo.join("module/loose.txt"), "loose\n").unwrap();
    let state = SubmoduleState {
        commit_changed: false,
        modified: true,
        untracked: true,
    };
    assert_eq!(
        worktree_status(fixture.path()).unwrap().entries,
        vec![StatusEntry::Ordinary {
            path: "module".into(),
            submodule: Some(state),
            sides: Sides::Unstaged {
                unstaged: ChangeStatus::Modified,
            },
            index: index_at(&fixture.repo, "module"),
        }]
    );
    assert_eq!(
        worktree_patch(fixture.path(), "module", Side::Unstaged).unwrap(),
        WorktreePatch::Submodule { submodule: state }
    );
}

#[test]
fn worktree_patch_rejects_paths_without_changes_and_paths_outside_the_worktree() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    fixture.commit(".gitignore", "ignored.txt\n", "ignore");
    fs::write(fixture.repo.join("ignored.txt"), "secret\n").unwrap();
    fs::write(fixture._directory.path().join("outside.txt"), "outside\n").unwrap();
    for file in ["notes.txt", "ignored.txt", "*.txt", "missing.txt"] {
        let error = worktree_patch(fixture.path(), file, Side::Unstaged).unwrap_err();
        assert!(
            matches!(error.kind, ErrorKind::UnchangedPath),
            "{file}: {error}"
        );
    }
    fs::create_dir_all(fixture.repo.join("nested/deeper")).unwrap();
    fs::write(fixture.repo.join("nested/deeper/leaf.txt"), "leaf\n").unwrap();
    for file in [
        "",
        "../outside.txt",
        "/etc/hosts",
        "./notes.txt",
        "nested/./deeper/leaf.txt",
        "nested//deeper/leaf.txt",
    ] {
        let error = worktree_patch(fixture.path(), file, Side::Unstaged).unwrap_err();
        assert!(
            matches!(error.kind, ErrorKind::UnsupportedPath),
            "{file}: {error}"
        );
        assert_eq!(
            error.message,
            "Choose a path inside this worktree, relative to its root."
        );
    }
}

#[test]
fn worktree_patch_rejects_an_untracked_nested_repository() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    let nested = fixture.repo.join("nested");
    fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "--initial-branch=main"]);
    fs::write(nested.join("inner.txt"), "inner\n").unwrap();
    assert_eq!(
        worktree_status(fixture.path()).unwrap().entries,
        vec![untracked("nested/")]
    );
    let error = worktree_patch(fixture.path(), "nested/", Side::Unstaged).unwrap_err();
    assert!(
        matches!(error.kind, ErrorKind::UnsupportedPath),
        "{error:?}"
    );
    assert_eq!(
        error.message,
        "L1 Git cannot show a diff for a nested repository."
    );
}

fn within<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(work());
    });
    receiver
        .recv_timeout(std::time::Duration::from_secs(20))
        .expect("the read hung")
}

fn assert_matches_git(fixture: &Fixture, names: &[&str]) {
    let path = fixture.path().to_owned();
    let owned: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
    let ours = within(move || {
        owned
            .iter()
            .map(|name| worktree_patch(&path, name, Side::Unstaged).unwrap())
            .collect::<Vec<_>>()
    });
    let mut add = vec!["add", "--intent-to-add", "--"];
    add.extend(names);
    git(&fixture.repo, &add);
    for (name, ours) in names.iter().zip(ours) {
        let theirs = Command::new("git")
            .arg("-C")
            .arg(&fixture.repo)
            .args([
                "-c",
                "core.quotePath=false",
                "diff",
                "--full-index",
                "--no-color",
                "--no-textconv",
                "--no-ext-diff",
                "--",
                name,
            ])
            .output()
            .unwrap();
        assert!(theirs.status.success(), "{name}");
        let theirs = String::from_utf8_lossy(&theirs.stdout);
        match ours {
            WorktreePatch::Diff {
                diff: FilePatch::Text { patch, .. },
            } => assert_eq!(patch, theirs, "{name:?}"),
            WorktreePatch::Diff {
                diff: FilePatch::Binary,
            } => assert!(
                theirs.ends_with(&format!("Binary files /dev/null and b/{name} differ\n")),
                "{name:?}: {theirs}"
            ),
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[test]
fn worktree_patch_writes_untracked_patches_byte_identical_to_git() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    git(&fixture.repo, &["config", "core.autocrlf", "false"]);
    let files: [(&str, &[u8]); 14] = [
        ("plain.txt", b"one\ntwo\n"),
        ("with space.txt", b"x\n"),
        ("caf\u{e9}.txt", "cr\u{e8}me\n".as_bytes()),
        ("tab\there.txt", b"t\n"),
        ("quote\"d.txt", b"q\n"),
        ("back\\slash.txt", b"b\n"),
        ("line\nbreak.txt", b"l\n"),
        ("-", b"dash\n"),
        ("no newline.txt", b"first\nend"),
        ("crlf.txt", b"a\r\nb\r\n"),
        ("empty", b""),
        ("dir/nested.txt", b"n\n"),
        ("exec.sh", b"#!/bin/sh\necho hi\n"),
        ("latin1.txt", b"caf\xe9\n"),
    ];
    fs::create_dir(fixture.repo.join("dir")).unwrap();
    for (name, content) in files {
        fs::write(fixture.repo.join(name), content).unwrap();
    }
    let mut names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            fixture.repo.join("exec.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::os::unix::fs::symlink("target text", fixture.repo.join("link")).unwrap();
        std::os::unix::fs::symlink("../x", fixture.repo.join("dir link")).unwrap();
        names.extend(["link", "dir link"]);
    }
    assert_matches_git(&fixture, &names);
}

#[test]
fn worktree_patch_converts_line_endings_and_honors_attributes_like_git() {
    let crlf: &[u8] = b"a\r\nb\r\n";
    let lone_cr: &[u8] = b"a\r\nb\rc\n";
    type Files<'a> = &'a [(&'a str, &'a [u8])];
    let cases: [(&str, &str, Files); 4] = [
        (
            "input",
            "",
            &[
                ("crlf.txt", crlf),
                ("lone cr.txt", lone_cr),
                ("plain.txt", b"x\n"),
            ],
        ),
        ("true", "", &[("crlf.txt", crlf), ("lone cr.txt", lone_cr)]),
        (
            "false",
            "*.lf text eol=lf\n*.crlf text eol=crlf\n*.auto text=auto\n*.raw -text\n*.legacy crlf=input\n*.text text\n",
            &[
                ("a.lf", crlf),
                ("a.crlf", crlf),
                ("a.auto", crlf),
                ("lone.auto", lone_cr),
                ("a.raw", crlf),
                ("a.legacy", crlf),
                ("a.text", lone_cr),
            ],
        ),
        (
            "false",
            "*.dat binary\n*.nod -diff\n",
            &[
                ("a.dat", b"text\n"),
                ("a.nod", b"text\n"),
                ("nul.txt", b"a\0b\n"),
            ],
        ),
    ];
    for (autocrlf, attributes, files) in cases {
        let fixture = Fixture::new();
        fixture.commit("notes.txt", "one\n", "initial");
        if !attributes.is_empty() {
            fixture.commit(".gitattributes", attributes, "attributes");
        }
        git(&fixture.repo, &["config", "core.autocrlf", autocrlf]);
        for (name, content) in files {
            fs::write(fixture.repo.join(name), content).unwrap();
        }
        let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
        assert_matches_git(&fixture, &names);
    }
}

#[test]
fn worktree_patch_follows_big_file_threshold_and_file_mode_like_git() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    git(&fixture.repo, &["config", "core.bigFileThreshold", "10"]);
    git(&fixture.repo, &["config", "core.fileMode", "false"]);
    fs::write(fixture.repo.join("big.txt"), "more than ten bytes\n").unwrap();
    fs::write(fixture.repo.join("run.sh"), "x\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            fixture.repo.join("run.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    assert_matches_git(&fixture, &["big.txt", "run.sh"]);
}

#[test]
fn worktree_patch_shows_what_git_would_stage_under_any_attribute() {
    let fixture = Fixture::new();
    fixture.commit(
        ".gitattributes",
        "*.up filter=upper\n*.off filter=unconfigured\n*.bin diff=bin\n*.forced diff\n*.nod -diff\n*.id ident\n*.u16 working-tree-encoding=UTF-16\n*.stamp filter=stamp\n",
        "attributes",
    );
    for (key, value) in [
        ("filter.upper.clean", "tr a-z A-Z"),
        ("filter.stamp.clean", "sh -c 'echo stamped; cat'"),
        ("diff.bin.binary", "true"),
        ("core.autocrlf", "false"),
    ] {
        git(&fixture.repo, &["config", key, value]);
    }
    let files: [(&str, &[u8]); 10] = [
        ("a.up", b"lower\n"),
        ("a.off", b"lower\n"),
        ("a.bin", b"text\n"),
        ("a.forced", b"a\0b\n"),
        ("empty.nod", b""),
        ("a.nod", b"text\n"),
        ("a.id", b"x\n$Id: 0123456789abcdef $\n"),
        ("a.u16", b"\xff\xfeo\0n\0e\0\n\0"),
        ("empty.stamp", b""),
        ("a.stamp", b"x\n"),
    ];
    for (name, content) in files {
        fs::write(fixture.repo.join(name), content).unwrap();
    }
    let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
    assert_matches_git(&fixture, &names);
}

#[test]
fn worktree_patch_names_a_required_filter_that_fails() {
    let fixture = Fixture::new();
    fixture.commit(".gitattributes", "*.req filter=req\n", "attributes");
    git(&fixture.repo, &["config", "filter.req.clean", "false"]);
    git(&fixture.repo, &["config", "filter.req.required", "true"]);
    fs::write(fixture.repo.join("a.req"), "x\n").unwrap();
    let error = worktree_patch(fixture.path(), "a.req", Side::Unstaged).unwrap_err();
    assert!(matches!(error.kind, ErrorKind::GitFailed), "{error:?}");
    assert!(
        error
            .message
            .ends_with("fatal: a.req: clean filter 'req' failed"),
        "{error:?}"
    );
}

#[test]
fn worktree_patch_shows_only_the_copy_for_a_copied_entry() {
    let fixture = Fixture::new();
    fixture.commit("s", "one\ntwo\nthree\nfour\nfive\n", "initial");
    git(&fixture.repo, &["config", "diff.renames", "copies"]);
    fs::copy(fixture.repo.join("s"), fixture.repo.join("t")).unwrap();
    fs::write(fixture.repo.join("s"), "one\ntwo\nthree\nfour\nfive\nz\n").unwrap();
    git(&fixture.repo, &["add", "-A"]);
    assert_eq!(
        worktree_status(fixture.path()).unwrap().entries,
        vec![
            ordinary(
                &fixture.repo,
                "s",
                Sides::Staged {
                    staged: ChangeStatus::Modified,
                }
            ),
            StatusEntry::Renamed {
                path: "t".into(),
                original: "s".into(),
                how: Moved::Copied,
                submodule: None,
                side: MoveSide::Staged {
                    unstaged: None,
                    index: index_at(&fixture.repo, "t").unwrap(),
                },
            },
        ]
    );
    assert_eq!(
        worktree_patch(fixture.path(), "t", Side::Staged).unwrap(),
        diff("diff --git a/s b/t\nsimilarity index 100%\ncopy from s\ncopy to t\n")
    );
}

#[test]
fn worktree_patch_shows_a_staged_submodule_move_as_a_gitlink_diff() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    let source = fixture._directory.path().join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "--initial-branch=main"]);
    fs::write(source.join("inner.txt"), "inner\n").unwrap();
    git(&source, &["add", "inner.txt"]);
    git(&source, &["commit", "-m", "inner"]);
    git(
        &fixture.repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            source.to_str().unwrap(),
            "module",
        ],
    );
    git(&fixture.repo, &["commit", "-m", "add module"]);
    let module = fixture.repo.join("module");
    let before = git(&module, &["rev-parse", "HEAD"]);
    fs::write(module.join("inner.txt"), "moved\n").unwrap();
    git(&module, &["commit", "-am", "move"]);
    let after = git(&module, &["rev-parse", "HEAD"]);
    git(&fixture.repo, &["add", "module"]);
    fs::write(module.join("loose.txt"), "loose\n").unwrap();
    assert_eq!(
        worktree_patch(fixture.path(), "module", Side::Staged).unwrap(),
        diff(&format!(
            "diff --git a/module b/module\nindex {before}..{after} 160000\n--- a/module\n+++ b/module\n@@ -1 +1 @@\n-Subproject commit {before}\n+Subproject commit {after}\n"
        ))
    );
    assert_eq!(
        worktree_patch(fixture.path(), "module", Side::Unstaged).unwrap(),
        WorktreePatch::Submodule {
            submodule: SubmoduleState {
                commit_changed: false,
                modified: false,
                untracked: true,
            }
        }
    );
}

#[test]
fn worktree_patch_refuses_paths_inside_a_git_directory() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    for file in [".git", ".git/config", ".GIT/config", "sub/.Git/HEAD"] {
        let error = worktree_patch(fixture.path(), file, Side::Unstaged).unwrap_err();
        assert!(
            matches!(error.kind, ErrorKind::UnsupportedPath),
            "{file}: {error:?}"
        );
        assert_eq!(
            error.message,
            "L1 Git does not show diffs for files inside a .git directory."
        );
    }
}

#[cfg(unix)]
#[test]
fn worktree_patch_never_leaks_through_a_file_swapped_for_a_symlink() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    let outside = fixture._directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("null"), "SECRET\n").unwrap();
    fs::write(outside.join("secret"), "SECRET\n").unwrap();
    let victim = fixture.repo.join("victim");
    fs::write(&victim, "plain\n").unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let swapper = {
        let (done, victim, outside) = (done.clone(), victim.clone(), outside.clone());
        std::thread::spawn(move || {
            let staging = victim.with_file_name("staging");
            while !done.load(Ordering::Relaxed) {
                for target in [outside.clone(), outside.join("secret")] {
                    let _ = fs::remove_file(&staging);
                    let _ = std::os::unix::fs::symlink(&target, &staging);
                    let _ = fs::rename(&staging, &victim);
                    let _ = fs::write(&staging, "plain\n");
                    let _ = fs::rename(&staging, &victim);
                }
            }
        })
    };
    let reads: Vec<_> = (0..200)
        .map(|_| worktree_patch(fixture.path(), "victim", Side::Unstaged))
        .collect();
    done.store(true, Ordering::Relaxed);
    swapper.join().unwrap();
    let leaks = reads
        .iter()
        .filter(|read| format!("{read:?}").contains("SECRET"))
        .count();
    assert_eq!(leaks, 0);
    let unexplained: Vec<_> = reads
        .iter()
        .filter_map(|read| read.as_ref().err())
        .filter(|error| error.message.contains("os error"))
        .collect();
    assert!(unexplained.is_empty(), "{unexplained:?}");
}

#[test]
fn worktree_patch_returns_when_a_filter_leaves_stderr_open() {
    let fixture = Fixture::new();
    fixture.commit(".gitattributes", "*.bg filter=bg\n", "attributes");
    git(
        &fixture.repo,
        &[
            "config",
            "filter.bg.clean",
            "sh -c 'sleep 8 </dev/null >/dev/null & cat'",
        ],
    );
    fs::write(fixture.repo.join("a.bg"), "x\n").unwrap();
    let path = fixture.path().to_owned();
    let started = std::time::Instant::now();
    let patch = within(move || worktree_patch(&path, "a.bg", Side::Unstaged));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert!(
        matches!(
            patch,
            Ok(WorktreePatch::Diff {
                diff: FilePatch::Text { .. }
            })
        ),
        "{patch:?}"
    );
}

#[cfg(unix)]
#[test]
fn worktree_patch_never_shows_text_that_git_read_after_a_swap() {
    let fixture = Fixture::new();
    fixture.commit(".gitattributes", "d/victim filter=slow\n", "attributes");
    git(
        &fixture.repo,
        &["config", "filter.slow.clean", "sh -c 'cat; sleep 1'"],
    );
    let outside = fixture._directory.path().join("outside");
    fs::create_dir_all(outside.join("d")).unwrap();
    fs::write(outside.join("d/victim"), "SECRET\n").unwrap();
    fs::create_dir(fixture.repo.join("d")).unwrap();
    fs::write(fixture.repo.join("d/victim"), "plain\n").unwrap();
    let path = fixture.path().to_owned();
    let reader = std::thread::spawn(move || worktree_patch(&path, "d/victim", Side::Unstaged));
    std::thread::sleep(std::time::Duration::from_millis(500));
    fs::rename(fixture.repo.join("d"), fixture.repo.join("real")).unwrap();
    std::os::unix::fs::symlink(outside.join("d"), fixture.repo.join("d")).unwrap();
    let error = reader.join().unwrap().unwrap_err();
    assert!(matches!(error.kind, ErrorKind::UnreadablePath), "{error:?}");
    assert_eq!(
        error.message,
        "This file changed while L1 Git was reading it. Refresh the worktree status."
    );
}

#[cfg(unix)]
#[test]
fn worktree_patch_shows_both_sections_of_a_type_change_on_either_side() {
    let fixture = Fixture::new();
    fixture.commit("staged", "s\n", "initial");
    fixture.commit("unstaged", "u\n", "second");
    for name in ["staged", "unstaged"] {
        fs::remove_file(fixture.repo.join(name)).unwrap();
        std::os::unix::fs::symlink("elsewhere", fixture.repo.join(name)).unwrap();
    }
    git(&fixture.repo, &["add", "staged"]);
    assert_eq!(
        worktree_status(fixture.path()).unwrap().entries,
        vec![
            ordinary(
                &fixture.repo,
                "staged",
                Sides::Staged {
                    staged: ChangeStatus::TypeChanged,
                }
            ),
            ordinary(
                &fixture.repo,
                "unstaged",
                Sides::Unstaged {
                    unstaged: ChangeStatus::TypeChanged,
                }
            ),
        ]
    );
    assert_eq!(
        worktree_patch(fixture.path(), "staged", Side::Staged).unwrap(),
        diff(
            "diff --git a/staged b/staged\ndeleted file mode 100644\nindex b4785957bc986dc39c629de9fac9df46972c00fc..0000000000000000000000000000000000000000\n--- a/staged\n+++ /dev/null\n@@ -1 +0,0 @@\n-s\ndiff --git a/staged b/staged\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..f98eb10ae82b19af44956c0891e3cc36187fa092\n--- /dev/null\n+++ b/staged\n@@ -0,0 +1 @@\n+elsewhere\n\\ No newline at end of file\n"
        )
    );
    assert_eq!(
        worktree_patch(fixture.path(), "unstaged", Side::Unstaged).unwrap(),
        diff(
            "diff --git a/unstaged b/unstaged\ndeleted file mode 100644\nindex 4ae8ef021bf6fcfff43a13be5abfa52bb6fb5dbc..0000000000000000000000000000000000000000\n--- a/unstaged\n+++ /dev/null\n@@ -1 +0,0 @@\n-u\ndiff --git a/unstaged b/unstaged\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..f98eb10ae82b19af44956c0891e3cc36187fa092\n--- /dev/null\n+++ b/unstaged\n@@ -0,0 +1 @@\n+elsewhere\n\\ No newline at end of file\n"
        )
    );
}

#[cfg(unix)]
#[test]
fn worktree_patch_keeps_only_the_copy_next_to_a_type_change() {
    let fixture = Fixture::new();
    fixture.commit("c", "one\ntwo\nthree\nfour\n", "initial");
    git(&fixture.repo, &["config", "status.renames", "copies"]);
    fs::copy(fixture.repo.join("c"), fixture.repo.join("c2")).unwrap();
    git(&fixture.repo, &["add", "c2"]);
    fs::remove_file(fixture.repo.join("c")).unwrap();
    std::os::unix::fs::symlink("elsewhere", fixture.repo.join("c")).unwrap();
    git(&fixture.repo, &["add", "c"]);
    assert_eq!(
        worktree_patch(fixture.path(), "c2", Side::Staged).unwrap(),
        diff("diff --git a/c b/c2\nsimilarity index 100%\ncopy from c\ncopy to c2\n")
    );
    assert_eq!(
        worktree_patch(fixture.path(), "c", Side::Staged).unwrap(),
        diff(
            "diff --git a/c b/c\ndeleted file mode 100644\nindex f384549cbeb481e437091320de6d1f2e15e11b4a..0000000000000000000000000000000000000000\n--- a/c\n+++ /dev/null\n@@ -1,4 +0,0 @@\n-one\n-two\n-three\n-four\ndiff --git a/c b/c\nnew file mode 120000\nindex 0000000000000000000000000000000000000000..f98eb10ae82b19af44956c0891e3cc36187fa092\n--- /dev/null\n+++ b/c\n@@ -0,0 +1 @@\n+elsewhere\n\\ No newline at end of file\n"
        )
    );
}

#[test]
fn worktree_patch_stops_reading_at_the_cap_and_reports_the_size() {
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    for (name, size) in [
        ("over cap.txt", 256u64 << 20),
        ("over threshold.txt", 4 << 30),
    ] {
        fs::write(fixture.repo.join(name), "text line\n".repeat(200_000)).unwrap();
        fs::File::options()
            .write(true)
            .open(fixture.repo.join(name))
            .unwrap()
            .set_len(size)
            .unwrap();
    }
    let path = fixture.path().to_owned();
    let started = std::time::Instant::now();
    let patches = within(move || {
        ["over cap.txt", "over threshold.txt"]
            .map(|name| worktree_patch(&path, name, Side::Unstaged).unwrap())
    });
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        patches,
        [
            WorktreePatch::Diff {
                diff: FilePatch::TooLarge { bytes: 256 << 20 }
            },
            WorktreePatch::Diff {
                diff: FilePatch::TooLarge { bytes: 4 << 30 }
            },
        ]
    );
}

#[cfg(unix)]
#[test]
fn worktree_patch_names_a_read_failure() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.commit("notes.txt", "one\n", "initial");
    let locked = fixture.repo.join("locked.txt");
    fs::write(&locked, "x\n").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let error = worktree_patch(fixture.path(), "locked.txt", Side::Unstaged).unwrap_err();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(error.kind, ErrorKind::UnreadablePath), "{error:?}");
    assert_eq!(
        error.message,
        "L1 Git could not read this file (Permission denied (os error 13)). Check its permissions, then refresh."
    );
}
