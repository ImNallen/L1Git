#![cfg(unix)]

use l1_git_core::{
    Applied, BranchTip, Coordinator, ErrorKind, Expect, Head, Limits, MergeAttention, MergeState,
    Operation, ReplayKind, ReplayProgress, RepositoryError, worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

const FORMATS: [&str; 2] = ["files", "reftable"];

fn terminal(path: &Path, args: &[&str]) -> Output {
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
    let output = terminal(path, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// Leaves a real `git cherry-pick` or `git revert` stopped on a conflict in
/// `f.txt`. The replayed commit also adds or removes `n.txt`, which applies
/// cleanly. Returns the replayed commit.
fn stop(root: &Path, pick: Pick) -> String {
    let commit_theirs = || {
        fs::write(root.join("f.txt"), "a\nTHEIRS\nc\n").unwrap();
        fs::write(root.join("n.txt"), "n\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "--quiet", "-m", "theirs\n\nbody"]);
        git(root, &["rev-parse", "HEAD"]).trim().to_owned()
    };
    let commit_ours = || {
        fs::write(root.join("f.txt"), "a\nOURS\nc\n").unwrap();
        git(root, &["commit", "--quiet", "-am", "ours"]);
    };
    let start: &[&str] = match pick {
        Pick::CherryPick => &["cherry-pick"],
        Pick::Revert => &["revert", "--no-edit"],
    };
    let commit = match pick {
        Pick::CherryPick => {
            let branch = git(root, &["symbolic-ref", "--short", "HEAD"]);
            git(root, &["switch", "--quiet", "-c", "topic"]);
            let commit = commit_theirs();
            git(root, &["switch", "--quiet", branch.trim()]);
            commit_ours();
            commit
        }
        Pick::Revert => {
            let commit = commit_theirs();
            commit_ours();
            commit
        }
    };
    let stopped = terminal(root, &[start, &[commit.as_str()]].concat());
    assert!(!stopped.status.success(), "{start:?} should stop");
    assert!(
        git(root, &["status", "--porcelain"]).contains("UU f.txt"),
        "the replay should stop on f.txt"
    );
    commit
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pick {
    CherryPick,
    Revert,
}

const PICKS: [Pick; 2] = [Pick::CherryPick, Pick::Revert];

/// Every case runs in both ref formats, for both commands.
fn cases() -> impl Iterator<Item = (&'static str, Pick)> {
    FORMATS
        .into_iter()
        .flat_map(|format| PICKS.into_iter().map(move |pick| (format, pick)))
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
}

impl Repo {
    fn new(format: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        let init = terminal(
            &root,
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                &format!("--ref-format={format}"),
            ],
        );
        assert!(init.status.success());
        let repo = Self { directory, root };
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
        ] {
            repo.git(&["config", key, value]);
        }
        repo.put("f.txt", "a\nb\nc\n");
        repo.put("u.txt", "u\n");
        repo.put("v.txt", "v\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "--quiet", "-m", "base"]);
        repo
    }

    fn stopped(format: &str, pick: Pick) -> (Self, String) {
        let repo = Self::new(format);
        let commit = stop(&repo.root, pick);
        (repo, commit)
    }

    fn fails(&self, args: &[&str]) {
        let output = terminal(&self.root, args);
        assert!(!output.status.success(), "git {args:?} should stop");
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn commit_all(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "--quiet", "-m", message]);
        self.oid("HEAD")
    }

    fn state(&self) -> MergeState {
        self.coordinator().merge_state(self.path()).unwrap()
    }

    fn progress(&self) -> ReplayProgress {
        match self.state() {
            MergeState::Replay { progress } => progress,
            other => panic!("expected a replay in flight: {other:?}"),
        }
    }

    fn assert_external(&self, why: &str) {
        match self.state() {
            MergeState::Attention {
                session: None,
                reason: MergeAttention::ExternalOperation,
                ..
            } => {}
            other => panic!("{why}: {other:?}"),
        }
    }

    /// What Git staged against HEAD, which the derived footprint must cover.
    fn staged_paths(&self) -> Vec<String> {
        let listed = self.git(&[
            "diff-index",
            "--cached",
            "--no-renames",
            "--name-only",
            "HEAD",
        ]);
        let mut paths: Vec<_> = listed.lines().map(str::to_owned).collect();
        paths.sort();
        paths.dedup();
        paths
    }

    fn oid(&self, name: &str) -> String {
        self.git(&["rev-parse", name]).trim().to_owned()
    }

    fn put(&self, path: &str, text: &str) {
        fs::write(self.root.join(path), text).unwrap();
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

    fn linked(&self, name: &str, branch: &str) -> PathBuf {
        let linked = self.root.parent().unwrap().join(name);
        self.git(&[
            "worktree",
            "add",
            "--quiet",
            "-b",
            branch,
            linked.to_str().unwrap(),
            "HEAD",
        ]);
        linked
    }

    fn tip(&self, reference: &str) -> BranchTip {
        serde_json::from_value(serde_json::json!({
            "reference": reference,
            "oid": self.oid(reference),
        }))
        .unwrap()
    }

    fn write_at(&self, path: &str, operation: &Operation) -> Result<Applied, RepositoryError> {
        let head = worktree_status(path).unwrap().head;
        self.coordinator().write(path, operation, &Expect { head })
    }
}

fn refused(result: Result<Applied, RepositoryError>) -> RepositoryError {
    let error = result.expect_err("the write should refuse");
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    error
}

#[test]
fn a_branch_with_a_replay_in_flight_in_another_worktree_cannot_be_renamed_or_deleted() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let linked = repo.linked("linked", "busy");
        stop(&linked, pick);
        let busy = repo.tip("refs/heads/busy");
        let shown = busy.oid.clone();
        for operation in [
            Operation::RenameBranch {
                branch: busy.clone(),
                to: "other".to_owned(),
            },
            Operation::DeleteBranch { branch: busy },
        ] {
            let error = refused(repo.write_at(repo.path(), &operation));
            assert!(
                error.message.contains("refs/heads/busy")
                    && error.message.contains(linked.to_str().unwrap()),
                "{format} {pick:?}: {}",
                error.message
            );
        }
        assert_eq!(repo.oid("refs/heads/busy"), shown.as_str());
    }
}

#[test]
fn a_branch_or_tag_named_like_a_marker_does_not_count_as_in_flight() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["branch", "CHERRY_PICK_HEAD"]);
        repo.git(&["tag", "REVERT_HEAD"]);
        repo.git(&["branch", "busy"]);
        let linked = repo.linked("linked", "other");
        let moved = repo.write_at(
            linked.to_str().unwrap(),
            &Operation::RenameBranch {
                branch: repo.tip("refs/heads/busy"),
                to: "renamed".to_owned(),
            },
        );
        assert!(moved.is_ok(), "{format}: {moved:?}");
        repo.put("u.txt", "more\n");
        repo.git(&["add", "u.txt"]);
        let status = worktree_status(repo.path()).unwrap();
        let committed = repo.coordinator().write(
            repo.path(),
            &Operation::Commit {
                message: "more\n".to_owned(),
                staged: status.staged_stamp,
            },
            &Expect { head: status.head },
        );
        assert!(committed.is_ok(), "{format}: {committed:?}");
    }
}

#[test]
fn a_replay_started_in_a_terminal_reads_from_gits_state_alone() {
    for (format, pick) in cases() {
        let (repo, commit) = Repo::stopped(format, pick);
        let progress = repo.progress();
        assert_eq!(progress.root, repo.path());
        assert_eq!(
            progress.kind,
            match pick {
                Pick::CherryPick => ReplayKind::CherryPick,
                Pick::Revert => ReplayKind::Revert,
            }
        );
        assert_eq!(progress.commit.as_str(), commit);
        assert_eq!(progress.subject, "theirs");
        assert_eq!(
            progress.destination,
            Head::Attached {
                reference: "refs/heads/main".to_owned(),
                oid: repo.oid("HEAD"),
            }
        );
        assert_eq!(progress.footprint, ["f.txt", "n.txt"], "{format} {pick:?}");
        assert_eq!(progress.footprint, repo.staged_paths());
        assert_eq!(progress.unresolved, ["f.txt"]);
        assert_eq!(progress.tree, None);
        assert!(!progress.empty);
        assert_eq!(
            progress.suggested_message,
            match pick {
                Pick::CherryPick => "theirs\n\nbody\n".to_owned(),
                Pick::Revert => format!("Revert \"theirs\"\n\nThis reverts commit {commit}.\n"),
            }
        );
    }
}

#[test]
fn resolving_a_conflict_keeps_the_footprint_and_reports_the_staged_tree() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let before = repo.progress().footprint;
        repo.put("f.txt", "a\nRESOLVED\nc\n");
        repo.git(&["add", "f.txt"]);
        let progress = repo.progress();
        assert_eq!(progress.footprint, before);
        assert_eq!(progress.unresolved, Vec::<String>::new());
        assert_eq!(
            progress.tree.as_ref().map(|tree| tree.as_str().to_owned()),
            Some(repo.git(&["write-tree"]).trim().to_owned())
        );
        assert!(!progress.empty);
    }
}

#[test]
fn a_result_equal_to_head_reads_as_empty() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.git(&["read-tree", "HEAD"]);
        repo.git(&["checkout-index", "--all", "--force"]);
        let progress = repo.progress();
        assert_eq!(
            progress.tree.as_ref().map(|tree| tree.as_str().to_owned()),
            Some(repo.oid("HEAD^{tree}"))
        );
        assert!(progress.empty, "{format} {pick:?}");
    }
}

/// Stops on a modify/delete conflict in `u.txt`, in both directions: HEAD
/// changes what the commit removes, and HEAD removes what the commit changes.
fn modify_delete_stops(format: &str) -> Vec<(Repo, String)> {
    let head_changes = Repo::new(format);
    head_changes.git(&["switch", "--quiet", "-c", "topic"]);
    head_changes.git(&["rm", "--quiet", "u.txt"]);
    let removes = head_changes.commit_all("removes u");
    head_changes.git(&["switch", "--quiet", "main"]);
    head_changes.put("u.txt", "ours\n");
    head_changes.commit_all("changes u");
    let head_removes = Repo::new(format);
    head_removes.git(&["switch", "--quiet", "-c", "topic"]);
    head_removes.put("u.txt", "theirs\n");
    let changes = head_removes.commit_all("changes u");
    head_removes.git(&["switch", "--quiet", "main"]);
    head_removes.git(&["rm", "--quiet", "u.txt"]);
    head_removes.commit_all("removes u");
    head_changes.fails(&["cherry-pick", &removes]);
    head_removes.fails(&["cherry-pick", &changes]);
    vec![(head_changes, removes), (head_removes, changes)]
}

#[test]
fn a_modify_delete_conflict_stays_in_the_footprint_after_it_is_resolved() {
    for format in FORMATS {
        for (repo, _) in modify_delete_stops(format) {
            let progress = repo.progress();
            assert_eq!(progress.footprint, ["u.txt"], "{format}");
            assert_eq!(progress.unresolved, ["u.txt"], "{format}");
            let _ = fs::remove_file(repo.root.join("u.txt"));
            repo.git(&["rm", "--quiet", "--cached", "--ignore-unmatch", "u.txt"]);
            let progress = repo.progress();
            assert_eq!(progress.footprint, ["u.txt"], "{format}");
            assert_eq!(progress.unresolved, Vec::<String>::new(), "{format}");
        }
    }
}

fn numbered(lines: &str) -> String {
    format!("1\n2\n{lines}\n4\n5\n6\n7\n8\n9\n")
}

#[test]
fn a_rename_on_either_side_names_both_paths() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.put("r.txt", &numbered("3"));
        repo.put("g.txt", &numbered("g"));
        repo.commit_all("more");
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("r.txt", &numbered("THEIRS"));
        repo.git(&["mv", "g.txt", "g2.txt"]);
        let commit = repo.commit_all("changes r, renames g");
        repo.git(&["switch", "--quiet", "main"]);
        repo.git(&["mv", "r.txt", "h.txt"]);
        repo.put("h.txt", &numbered("OURS"));
        repo.commit_all("renames r");
        repo.fails(&["cherry-pick", &commit]);
        let progress = repo.progress();
        assert_eq!(progress.unresolved, ["h.txt"], "{format}");
        assert_eq!(progress.footprint, ["g.txt", "g2.txt", "h.txt"], "{format}");
        assert_eq!(progress.footprint, repo.staged_paths());

        let (repo, _) = Repo::stopped(format, Pick::Revert);
        repo.git(&["revert", "--abort"]);
        repo.put("r.txt", &numbered("3"));
        repo.commit_all("adds r");
        repo.git(&["mv", "r.txt", "s.txt"]);
        repo.put("f.txt", "a\nFIRST\nc\n");
        let renames = repo.commit_all("renames r");
        repo.put("f.txt", "a\nSECOND\nc\n");
        repo.commit_all("changes f");
        repo.fails(&["revert", "--no-edit", &renames]);
        let progress = repo.progress();
        assert_eq!(progress.unresolved, ["f.txt"], "{format}");
        assert_eq!(progress.footprint, ["f.txt", "r.txt", "s.txt"], "{format}");
        assert_eq!(progress.footprint, repo.staged_paths());
    }
}

#[test]
fn a_root_commit_replays_against_the_empty_tree() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "--orphan", "other"]);
        repo.put("f.txt", "root\n");
        let root = repo.commit_all("root");
        repo.git(&["switch", "--quiet", "main"]);
        repo.fails(&["cherry-pick", &root]);
        let progress = repo.progress();
        assert_eq!(progress.unresolved, ["f.txt"], "{format}");
        assert_eq!(progress.footprint, ["f.txt"], "{format}");
        repo.git(&["cherry-pick", "--abort"]);

        let base = repo.oid("main");
        let root = repo.git(&["rev-list", "--max-parents=0", &base]);
        repo.put("u.txt", "ours\n");
        repo.commit_all("changes u");
        repo.fails(&["revert", "--no-edit", root.trim()]);
        let progress = repo.progress();
        assert_eq!(progress.kind, ReplayKind::Revert);
        assert!(
            progress.unresolved.contains(&"u.txt".to_owned()),
            "{format}"
        );
        assert_eq!(progress.footprint, repo.staged_paths(), "{format}");
    }
}

#[test]
fn a_sequence_of_commits_stays_external() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        repo.commit_all("first");
        repo.put("u.txt", "theirs\n");
        repo.commit_all("second");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        repo.fails(&["cherry-pick", "topic~1", "topic"]);
        repo.git(&["show-ref", "--exists", "CHERRY_PICK_HEAD"]);
        repo.assert_external(format);
    }
}

#[test]
fn a_mainline_pick_of_a_merge_commit_stays_external() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("u.txt", "side\n");
        repo.commit_all("side");
        repo.git(&["switch", "--quiet", "-c", "merged", "main"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        repo.commit_all("changes f");
        repo.git(&["merge", "--quiet", "--no-ff", "--no-edit", "topic"]);
        let merge = repo.oid("HEAD");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("u.txt", "ours\n");
        repo.commit_all("changes u");
        repo.fails(&["cherry-pick", "-m", "1", &merge]);
        repo.git(&["show-ref", "--exists", "CHERRY_PICK_HEAD"]);
        repo.assert_external(format);
    }
}

#[test]
fn a_pruned_marker_commit_stays_external() {
    for format in FORMATS {
        let (repo, commit) = Repo::stopped(format, Pick::CherryPick);
        repo.git(&["branch", "--quiet", "-D", "topic"]);
        repo.git(&["reflog", "expire", "--expire=now", "--all"]);
        repo.git(&["gc", "--quiet", "--prune=now"]);
        assert!(
            !terminal(&repo.root, &["cat-file", "-e", &commit])
                .status
                .success(),
            "{format}: the commit should be gone"
        );
        repo.git(&["show-ref", "--exists", "CHERRY_PICK_HEAD"]);
        repo.assert_external(format);
    }
}

#[test]
fn another_operation_alongside_stays_external() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        repo.git(&["bisect", "start"]);
        stop(&repo.root, pick);
        repo.assert_external(format);
    }
}

#[test]
fn a_blob_merge_tree_cannot_read_stays_external() {
    for format in FORMATS {
        let (repo, commit) = Repo::stopped(format, Pick::CherryPick);
        let blob = repo.oid(&format!("{commit}^:f.txt"));
        fs::remove_file(
            repo.root
                .join(".git/objects")
                .join(&blob[..2])
                .join(&blob[2..]),
        )
        .unwrap();
        repo.assert_external(format);
    }
}

#[test]
fn a_branch_or_tag_named_like_a_marker_reads_as_idle() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["branch", "CHERRY_PICK_HEAD"]);
        repo.git(&["tag", "REVERT_HEAD"]);
        assert_eq!(repo.state(), MergeState::Idle, "{format}");
    }
}

#[test]
fn a_linked_worktree_answers_only_for_its_own_replay() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let linked = repo.linked("linked", "busy");
        let commit = stop(&linked, pick);
        assert_eq!(repo.state(), MergeState::Idle, "{format} {pick:?}");
        let path = linked.to_str().unwrap();
        let MergeState::Replay { progress } = repo.coordinator().merge_state(path).unwrap() else {
            panic!("{format} {pick:?}: the linked worktree holds a replay");
        };
        assert_eq!(progress.commit.as_str(), commit);
        assert_eq!(progress.root, path);
        assert_eq!(
            progress.destination,
            Head::Attached {
                reference: "refs/heads/busy".to_owned(),
                oid: git(&linked, &["rev-parse", "HEAD"]).trim().to_owned(),
            }
        );
    }
}

#[test]
fn the_suggested_message_keeps_a_real_comment_line_and_honours_the_comment_char() {
    for format in FORMATS {
        for (comment, config) in [("#", None), (";", Some(";")), ("//", Some("//"))] {
            let repo = Repo::new(format);
            if let Some(config) = config {
                repo.git(&["config", "core.commentChar", config]);
            }
            repo.git(&["switch", "--quiet", "-c", "topic"]);
            repo.put("f.txt", "a\nTHEIRS\nc\n");
            repo.git(&["add", "-A"]);
            repo.git(&[
                "commit",
                "--quiet",
                "--cleanup=verbatim",
                "-m",
                "theirs\n\n# real\n; real too",
            ]);
            repo.git(&["switch", "--quiet", "main"]);
            repo.put("f.txt", "a\nOURS\nc\n");
            repo.commit_all("ours");
            repo.fails(&["cherry-pick", "topic"]);
            assert!(
                fs::read_to_string(repo.root.join(".git/MERGE_MSG"))
                    .unwrap()
                    .contains(&format!("{comment} Conflicts:")),
                "{comment}"
            );
            assert_eq!(
                repo.progress().suggested_message,
                "theirs\n\n# real\n; real too\n",
                "{format} {comment}"
            );
        }
    }
}

#[test]
fn a_second_read_does_not_run_a_merge_driver_again_and_the_memo_can_be_deleted() {
    for format in FORMATS {
        let repo = Repo::new(format);
        let runs = repo.directory.path().join("runs");
        repo.git(&[
            "config",
            "merge.counted.driver",
            &format!("echo run >> '{}'; exit 1", runs.display()),
        ]);
        fs::write(
            repo.root.join(".git/info/attributes"),
            "f.txt merge=counted\n",
        )
        .unwrap();
        stop(&repo.root, Pick::CherryPick);
        let count = || fs::read_to_string(&runs).unwrap().lines().count();
        let after_git = count();
        assert_eq!(after_git, 1, "{format}: the real pick ran the driver");

        let first = repo.progress().footprint;
        assert_eq!(count(), after_git + 1, "{format}: the first read simulates");
        assert_eq!(repo.progress().footprint, first);
        assert_eq!(
            count(),
            after_git + 1,
            "{format}: the second read uses the memo"
        );

        fs::remove_dir_all(repo.root.join(".git/l1git/replay")).unwrap();
        assert_eq!(repo.progress().footprint, first);
        assert_eq!(
            count(),
            after_git + 2,
            "{format}: deleting the memo recomputes"
        );

        let memo = fs::read_dir(repo.root.join(".git/l1git/replay"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("footprint.json");
        fs::write(&memo, "{corrupt").unwrap();
        assert_eq!(repo.progress().footprint, first);
        assert_eq!(
            count(),
            after_git + 3,
            "{format}: a damaged memo recomputes"
        );
    }
}
