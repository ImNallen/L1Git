#![cfg(unix)]

use l1_git_core::{
    Applied, BranchTip, ConflictFile, ConflictSnapshot, Coordinator, EntryId, ErrorKind, Expect,
    Head, Limits, MergeAction, MergeAttention, MergeSelection, MergeState, Oid, Operation,
    ReplayKind, ReplayOf, ReplayPrediction, ReplayProgress, ReplayReview, RepositoryError, Request,
    Response, StaleReason, UndoHistory, run, worktree_status,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::{fs::PermissionsExt, process::ExitStatusExt},
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
    let commit = conflicting(root, pick);
    let stopped = terminal(root, &[pick.start(), &[commit.as_str()]].concat());
    assert!(!stopped.status.success(), "{pick:?} should stop");
    assert!(
        git(root, &["status", "--porcelain"]).contains("UU f.txt"),
        "the replay should stop on f.txt"
    );
    commit
}

/// A commit that conflicts in `f.txt` when `pick` applies it to HEAD.
fn conflicting(root: &Path, pick: Pick) -> String {
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
    match pick {
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
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pick {
    CherryPick,
    Revert,
}

impl Pick {
    const fn marker(self) -> &'static str {
        match self {
            Self::CherryPick => "CHERRY_PICK_HEAD",
            Self::Revert => "REVERT_HEAD",
        }
    }

    const fn command(self) -> &'static str {
        match self {
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }

    const fn kind(self) -> ReplayKind {
        match self {
            Self::CherryPick => ReplayKind::CherryPick,
            Self::Revert => ReplayKind::Revert,
        }
    }

    const fn start(self) -> &'static [&'static str] {
        match self {
            Self::CherryPick => &["cherry-pick"],
            Self::Revert => &["revert", "--no-edit"],
        }
    }
}

const FORCE_QUIT: &str = "L1GIT_REPLAY_FORCE_QUIT";

/// Kills Git and the process that runs it, as a force quit in that hook would.
const KILL_GIT_AND_APP: &str = "git=$PPID\napp=$(ps -o ppid= -p $git)\nkill -9 $app $git\n";

/// Kills every `git` above this process and leaves the app alone. `--abort` runs
/// `git reset`, so more than one is running.
const KILL_GIT_ANCESTORS: &str = "at=$PPID\nwhile [ \"$at\" -gt 1 ]; do\n  name=$(ps -o comm= -p $at)\n  up=$(ps -o ppid= -p $at)\n  [ \"${name##*/}\" = git ] && kill -9 $at\n  at=$up\ndone\n";

fn finish_operation(shown: &ReplayProgress, message: &str) -> Operation {
    Operation::FinishReplay {
        of: shown.of(),
        staged: shown.staged.clone(),
        tree: shown.tree.clone().expect("every conflict is resolved"),
        message: message.to_owned(),
    }
}

const PICKS: [Pick; 2] = [Pick::CherryPick, Pick::Revert];

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
        Self::with_objects(format, "sha1")
    }

    fn with_objects(format: &str, objects: &str) -> Self {
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
                &format!("--object-format={objects}"),
            ],
        );
        assert!(init.status.success(), "{init:?}");
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

    fn history(&self) -> UndoHistory {
        self.coordinator().undo_history(self.path()).unwrap()
    }

    fn undo_id(&self) -> Option<EntryId> {
        self.history().undo.map(|entry| entry.id)
    }

    /// Only plumbing moves a branch under a marker. Porcelain refuses or clears it.
    fn move_head_with_plumbing(&self) -> String {
        let moved = self.git(&["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "moved"]);
        self.git(&["update-ref", "refs/heads/main", moved.trim()]);
        moved.trim().to_owned()
    }

    fn snapshot(&self, file: &str) -> ConflictSnapshot {
        let answer = run(
            &self.coordinator(),
            Request::ConflictFile {
                path: self.path().to_owned(),
                file: file.to_owned(),
            },
        )
        .unwrap();
        let Response::ConflictFile(ConflictFile::Editable { snapshot }) = answer else {
            panic!("{file} should be editable: {answer:?}");
        };
        *snapshot
    }

    fn save(&self, file: &str, text: &str) -> Applied {
        let seen = self.snapshot(file);
        self.coordinator()
            .write(
                self.path(),
                &Operation::SaveConflict {
                    path: seen.path,
                    version: seen.version,
                    text: Some(text.to_owned()),
                },
                &Expect { head: seen.head },
            )
            .unwrap()
    }

    fn stage(&self, file: &str) -> Applied {
        let status = worktree_status(self.path()).unwrap();
        let entries = status
            .entries
            .into_iter()
            .filter(|entry| serde_json::to_value(entry).unwrap()["path"] == file)
            .collect();
        self.coordinator()
            .write(
                self.path(),
                &Operation::StageFiles { entries },
                &Expect { head: status.head },
            )
            .unwrap()
    }

    fn read(&self, file: &str) -> String {
        fs::read_to_string(self.root.join(file)).unwrap()
    }

    fn status(&self) -> String {
        self.git(&["status", "--porcelain"])
    }

    fn has_marker(&self, pick: Pick) -> bool {
        terminal(&self.root, &["show-ref", "--exists", pick.marker()])
            .status
            .success()
    }

    fn hook(&self, name: &str, body: &str) {
        self.git(&["config", "core.hooksPath", ".git/hooks"]);
        let path = self.root.join(".git/hooks").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn no_hooks(&self) {
        self.git(&["config", "core.hooksPath", "/dev/null"]);
    }

    fn resolve(&self) {
        self.save("f.txt", "a\nRESOLVED\nc\n");
        self.stage("f.txt");
    }

    fn finish_as_shown(
        &self,
        shown: &ReplayProgress,
        message: &str,
    ) -> Result<Applied, RepositoryError> {
        self.coordinator().write(
            self.path(),
            &finish_operation(shown, message),
            &Expect {
                head: shown.destination.clone(),
            },
        )
    }

    fn finish(&self, message: &str) -> Result<Applied, RepositoryError> {
        self.finish_as_shown(&self.progress(), message)
    }

    fn abort_as_shown(&self, shown: &ReplayProgress) -> Result<MergeState, RepositoryError> {
        self.coordinator()
            .abort_replay(self.path(), &shown.of(), &shown.destination)
    }

    fn abort(&self) -> Result<MergeState, RepositoryError> {
        self.abort_as_shown(&self.progress())
    }

    fn undo(&self, applied: &Applied) -> Result<Applied, RepositoryError> {
        self.coordinator().undo(self.path(), applied.id)
    }

    fn redo(&self, applied: &Applied) -> Result<Applied, RepositoryError> {
        self.coordinator().redo(self.path(), applied.id)
    }

    fn finished(format: &str, pick: Pick) -> (Self, Applied) {
        let (repo, _) = Self::stopped(format, pick);
        repo.resolve();
        let applied = repo.finish("Finished\n").unwrap();
        (repo, applied)
    }

    /// Runs Finish in a process of its own, for a hook that kills that process.
    fn force_quit_during_finish(&self) {
        let quit = Command::new(std::env::current_exe().unwrap())
            .args(["force_quit_process", "--exact", "--nocapture"])
            .env(
                FORCE_QUIT,
                format!("{}\n{}", self.path(), self.undo_dir().display()),
            )
            .output()
            .unwrap();
        assert_eq!(quit.status.signal(), Some(9), "{quit:?}");
        self.no_hooks();
    }

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
        assert_eq!(progress.kind, pick.kind());
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
fn modify_delete_stops(format: &str) -> [Repo; 2] {
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
    [head_changes, head_removes]
}

#[test]
fn a_modify_delete_conflict_stays_in_the_footprint_after_it_is_resolved() {
    for format in FORMATS {
        for repo in modify_delete_stops(format) {
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
fn a_root_commit_replays_in_a_sha256_repository() {
    for format in FORMATS {
        let repo = Repo::with_objects(format, "sha256");
        repo.git(&["switch", "--quiet", "--orphan", "other"]);
        repo.put("f.txt", "root\n");
        let root = repo.commit_all("root");
        repo.git(&["switch", "--quiet", "main"]);
        repo.fails(&["cherry-pick", &root]);
        let progress = repo.progress();
        assert_eq!(progress.unresolved, ["f.txt"], "{format}");
        assert_eq!(progress.footprint, ["f.txt"], "{format}");
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

fn external_message(repo: &Repo) -> String {
    match repo.state() {
        MergeState::Attention {
            session: None,
            reason: MergeAttention::ExternalOperation,
            message,
        } => message,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_sequence_names_the_commands_that_end_it() {
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
        assert_eq!(
            external_message(&repo),
            "A cherry-pick of several commits is in progress. Continue it with git cherry-pick --continue or end it with git cherry-pick --abort, then refresh.",
            "{format}",
        );
        repo.git(&["cherry-pick", "--abort"]);

        repo.git(&["switch", "--quiet", "topic"]);
        repo.put("f.txt", "a\nLATER\nc\n");
        repo.commit_all("later");
        repo.fails(&["revert", "--no-edit", "HEAD~1", "HEAD~2"]);
        assert_eq!(
            external_message(&repo),
            "A revert of several commits is in progress. Continue it with git revert --continue or end it with git revert --abort, then refresh.",
            "{format}",
        );
    }
}

#[test]
fn an_external_operation_is_named() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        repo.commit_all("theirs");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");

        repo.git(&["bisect", "start"]);
        assert_eq!(
            external_message(&repo),
            "A bisect is in progress. Finish or abort it with Git, then refresh.",
            "{format}",
        );
        repo.fails(&["cherry-pick", "topic"]);
        assert_eq!(
            external_message(&repo),
            "A cherry-pick and a bisect are in progress. Finish or abort them with Git, then refresh.",
            "{format}",
        );
        repo.git(&["cherry-pick", "--abort"]);
        repo.git(&["bisect", "reset"]);

        repo.fails(&["merge", "--no-edit", "topic"]);
        assert_eq!(
            external_message(&repo),
            "A merge is in progress. Finish or abort it with Git, then refresh.",
            "{format}",
        );
        repo.git(&["merge", "--abort"]);

        repo.git(&["switch", "--quiet", "topic"]);
        repo.fails(&["rebase", "main"]);
        assert_eq!(
            external_message(&repo),
            "A rebase is in progress. Finish or abort it with Git, then refresh.",
            "{format}",
        );
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

#[test]
fn the_resolver_undoes_through_a_journal_derived_from_gits_state() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let conflicted = repo.read("f.txt");
        let saved = repo.save("f.txt", "a\nRESOLVED\nc\n");
        assert_eq!(repo.undo_id(), Some(saved.id), "{format} {pick:?}");
        let marked = repo.stage("f.txt");
        assert_eq!(repo.undo_id(), Some(marked.id), "{format} {pick:?}");
        assert!(repo.progress().unresolved.is_empty());

        let coordinator = repo.coordinator();
        coordinator.undo(repo.path(), marked.id).unwrap();
        assert_eq!(repo.progress().unresolved, ["f.txt"], "{format} {pick:?}");
        coordinator.undo(repo.path(), saved.id).unwrap();
        assert_eq!(repo.read("f.txt"), conflicted, "{format} {pick:?}");
        assert_eq!(repo.history().undo, None);
        coordinator.redo(repo.path(), saved.id).unwrap();
        assert_eq!(repo.read("f.txt"), "a\nRESOLVED\nc\n");
        coordinator.redo(repo.path(), marked.id).unwrap();
        assert!(repo.progress().unresolved.is_empty(), "{format} {pick:?}");
    }
}

#[test]
fn deleting_the_journal_folder_loses_only_resolution_undo() {
    for (format, pick) in cases() {
        let (repo, commit) = Repo::stopped(format, pick);
        repo.save("f.txt", "a\nRESOLVED\nc\n");
        fs::remove_dir_all(repo.root.join(".git/l1git/replay")).unwrap();
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
        assert_eq!(repo.progress().commit.as_str(), commit);
        assert_eq!(repo.read("f.txt"), "a\nRESOLVED\nc\n");
    }
}

#[test]
fn a_journal_goes_away_once_git_says_the_replay_is_over() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.save("f.txt", "a\nRESOLVED\nc\n");
        let folders = repo.root.join(".git/l1git/replay");
        assert_eq!(fs::read_dir(&folders).unwrap().count(), 1);
        repo.git(&[pick.command(), "--abort"]);
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
        assert_eq!(
            fs::read_dir(&folders).unwrap().count(),
            0,
            "{format} {pick:?}"
        );
    }
}

#[test]
fn a_new_replay_sweeps_the_journal_of_the_one_before_it() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.save("f.txt", "a\nRESOLVED\nc\n");
        let folders = repo.root.join(".git/l1git/replay");
        let first = fs::read_dir(&folders)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        repo.move_head_with_plumbing();
        assert_eq!(
            repo.history().undo,
            None,
            "{format} {pick:?}: a new HEAD is a new journal"
        );
        assert!(!first.exists(), "{format} {pick:?}");
        assert_eq!(
            fs::read_dir(&folders).unwrap().count(),
            1,
            "{format} {pick:?}"
        );
    }
}

#[test]
fn only_index_edits_inside_the_footprint_pass_during_a_replay() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.put("u.txt", "edited\n");
        let status = worktree_status(repo.path()).unwrap();
        let entries: Vec<_> = status
            .entries
            .iter()
            .filter(|entry| serde_json::to_value(entry).unwrap()["path"] == "u.txt")
            .cloned()
            .collect();
        let expect = Expect {
            head: status.head.clone(),
        };
        let coordinator = repo.coordinator();
        let error = refused(coordinator.write(
            repo.path(),
            &Operation::StageFiles {
                entries: entries.clone(),
            },
            &expect,
        ));
        assert!(
            error.message.contains("u.txt"),
            "{format} {pick:?}: {}",
            error.message
        );
        for operation in [
            Operation::Discard { entries },
            Operation::Commit {
                message: "no".to_owned(),
                staged: status.staged_stamp.clone(),
            },
            Operation::Amend {
                message: "no".to_owned(),
                staged: status.staged_stamp.clone(),
            },
            Operation::StashPush {
                message: String::new(),
                untracked: false,
                paths: Vec::new(),
            },
        ] {
            refused(coordinator.write(repo.path(), &operation, &expect));
        }
        assert_eq!(repo.read("u.txt"), "edited\n");
    }
}

/// Runs only inside the process `force_quit_during_finish` starts, because a hook
/// kills it.
#[test]
fn force_quit_process() {
    let Ok(request) = std::env::var(FORCE_QUIT) else {
        return;
    };
    let (root, undo) = request.split_once('\n').unwrap();
    let coordinator = Coordinator::new(Limits::default(), undo);
    let MergeState::Replay { progress } = coordinator.merge_state(root).unwrap() else {
        panic!("a replay should be in flight");
    };
    let answer = coordinator.write(
        root,
        &finish_operation(&progress, "Finished\n"),
        &Expect {
            head: progress.destination,
        },
    );
    panic!("the hook should have killed this process before {answer:?}");
}

#[test]
fn finish_commits_the_reviewed_result_with_the_right_author() {
    for (format, pick) in cases() {
        let (repo, commit) = Repo::stopped(format, pick);
        repo.git(&["config", "user.name", "Finisher"]);
        repo.resolve();
        let before = repo.oid("HEAD");
        let shown = repo.progress();
        let applied = repo.finish_as_shown(&shown, "Finished\n").unwrap();
        assert_eq!(repo.oid("HEAD^"), before, "{format} {pick:?}");
        assert_eq!(repo.git(&["log", "-1", "--format=%B"]).trim(), "Finished");
        assert_eq!(
            repo.oid("HEAD^{tree}"),
            shown.tree.unwrap().as_str(),
            "{format} {pick:?}"
        );
        assert_eq!(
            repo.git(&["log", "-1", "--format=%an"]).trim(),
            match pick {
                Pick::CherryPick => "Ada",
                Pick::Revert => "Finisher",
            },
            "{format} {pick:?} from {commit}"
        );
        assert!(!repo.has_marker(pick), "{format} {pick:?}");
        assert_eq!(repo.state(), MergeState::Idle);
        assert_eq!(repo.status(), "");
        assert_eq!(repo.undo_id(), Some(applied.id), "{format} {pick:?}");
    }
}

#[test]
fn finish_closes_the_journal_and_joins_the_global_history() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let saved = repo.save("f.txt", "a\nSAVED\nc\n");
        let marked = repo.stage("f.txt");
        repo.undo(&marked).unwrap();
        repo.undo(&saved).unwrap();
        assert_eq!(repo.progress().unresolved, ["f.txt"], "{format} {pick:?}");
        repo.resolve();
        let finished = repo.finish("Finished\n").unwrap();
        let history = repo.history();
        assert_eq!(
            history.undo.map(|entry| entry.id),
            Some(finished.id),
            "{format} {pick:?}"
        );
        assert_eq!(history.redo, None);
        assert_eq!(
            fs::read_dir(repo.root.join(".git/l1git/replay"))
                .unwrap()
                .count(),
            0,
            "{format} {pick:?}"
        );
    }
}

#[test]
fn finish_works_after_a_modify_delete_resolved_either_way() {
    for format in FORMATS {
        let [head_changes, head_removes] = modify_delete_stops(format);

        let before = head_changes.oid("HEAD");
        head_changes.git(&["rm", "--quiet", "--force", "u.txt"]);
        head_changes.finish("Takes the removal\n").unwrap();
        assert_eq!(head_changes.oid("HEAD^"), before, "{format}");
        assert!(!head_changes.root.join("u.txt").exists(), "{format}");
        assert_eq!(head_changes.status(), "", "{format}");

        let before = head_removes.oid("HEAD");
        head_removes.git(&["add", "u.txt"]);
        head_removes.finish("Takes the change\n").unwrap();
        assert_eq!(head_removes.oid("HEAD^"), before, "{format}");
        assert_eq!(head_removes.read("u.txt"), "theirs\n", "{format}");
        assert_eq!(head_removes.status(), "", "{format}");
    }
}

#[test]
fn a_modify_delete_resolved_to_heads_side_is_empty() {
    for format in FORMATS {
        let [_, head_removes] = modify_delete_stops(format);
        let _ = fs::remove_file(head_removes.root.join("u.txt"));
        head_removes.git(&["rm", "--quiet", "--cached", "u.txt"]);
        assert!(head_removes.progress().empty, "{format}");
        let error = head_removes.finish("Finished\n").unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::UnchangedPath,
            "{format}: {}",
            error.message
        );
    }
}

#[test]
fn finish_records_a_rename() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.put("g.txt", &numbered("g"));
        repo.commit_all("adds g");
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        repo.git(&["mv", "g.txt", "g2.txt"]);
        let commit = repo.commit_all("changes f, renames g");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        repo.fails(&["cherry-pick", &commit]);
        repo.resolve();
        repo.finish("Finished\n").unwrap();
        let names = repo.git(&["ls-tree", "--name-only", "HEAD"]);
        assert!(
            names.contains("g2.txt") && !names.contains("g.txt\n"),
            "{names}"
        );
    }
}

#[test]
fn a_real_comment_line_survives_finish_with_the_suggested_message() {
    for format in FORMATS {
        for (comment, config) in [("#", None), (";", Some(";"))] {
            let repo = Repo::new(format);
            if let Some(config) = config {
                repo.git(&["config", "core.commentChar", config]);
            }
            let body = format!("theirs\n\n{comment} real\n");
            repo.git(&["switch", "--quiet", "-c", "topic"]);
            repo.put("f.txt", "a\nTHEIRS\nc\n");
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "--quiet", "--cleanup=verbatim", "-m", &body]);
            repo.git(&["switch", "--quiet", "main"]);
            repo.put("f.txt", "a\nOURS\nc\n");
            repo.commit_all("ours");
            repo.fails(&["cherry-pick", "topic"]);
            repo.resolve();
            let shown = repo.progress();
            assert_eq!(shown.suggested_message, body, "{format} {comment}");
            repo.finish_as_shown(&shown, &shown.suggested_message)
                .unwrap();
            assert_eq!(
                repo.git(&["log", "-1", "--format=%B"]),
                format!("{body}\n"),
                "{format} {comment}"
            );
        }
    }
}

#[test]
fn a_repeated_finish_answers_the_same_entry_and_runs_nothing() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let shown = repo.progress();
        let first = repo.finish_as_shown(&shown, "Finished\n").unwrap();
        let made = repo.oid("HEAD");
        let runs = repo.directory.path().join("runs");
        repo.hook("pre-commit", &format!("echo run >> '{}'\n", runs.display()));
        let again = repo.finish_as_shown(&shown, "Finished\n").unwrap();
        assert_eq!(again.id, first.id, "{format} {pick:?}");
        assert_eq!(again.operation, first.operation);
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert!(!runs.exists(), "{format} {pick:?}: Git ran again");
        repo.no_hooks();
    }
}

#[test]
fn a_finish_after_the_replay_ended_otherwise_refuses() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let shown = repo.progress();
        repo.git(&[pick.command(), "--abort"]);
        let error = repo.finish_as_shown(&shown, "Finished\n").unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{format} {pick:?}");
    }
}

#[test]
fn a_finish_naming_another_commit_is_stale_and_changes_nothing() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let shown = repo.progress();
        let head = repo.oid("HEAD");
        let stale = Operation::FinishReplay {
            of: ReplayOf {
                kind: shown.kind,
                commit: Oid::try_from(head.clone()).unwrap(),
            },
            staged: shown.staged.clone(),
            tree: shown.tree.clone().unwrap(),
            message: "Finished\n".to_owned(),
        };
        let error = repo
            .coordinator()
            .write(
                repo.path(),
                &stale,
                &Expect {
                    head: shown.destination.clone(),
                },
            )
            .unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::StaleView {
                reason: StaleReason::HeadMoved
            },
            "{format} {pick:?}"
        );
        assert_eq!(repo.oid("HEAD"), head);
        assert!(repo.has_marker(pick));
    }
}

#[test]
fn a_finish_after_head_or_the_staged_files_moved_is_stale() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let shown = repo.progress();
        repo.put("f.txt", "a\nAGAIN\nc\n");
        repo.git(&["add", "f.txt"]);
        assert_eq!(
            repo.finish_as_shown(&shown, "Finished\n").unwrap_err().kind,
            ErrorKind::StaleView {
                reason: StaleReason::StagedChanged
            },
            "{format} {pick:?}"
        );
        let shown = repo.progress();
        repo.move_head_with_plumbing();
        assert_eq!(
            repo.finish_as_shown(&shown, "Finished\n").unwrap_err().kind,
            ErrorKind::StaleView {
                reason: StaleReason::HeadMoved
            },
            "{format} {pick:?}"
        );
        assert!(repo.has_marker(pick));
    }
}

#[test]
fn an_empty_staged_result_refuses_finish_and_points_at_abort() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.git(&["read-tree", "HEAD"]);
        repo.git(&["checkout-index", "--all", "--force"]);
        let head = repo.oid("HEAD");
        let error = repo.finish("Finished\n").unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnchangedPath, "{format} {pick:?}");
        assert!(error.message.contains("Abort"), "{}", error.message);
        assert_eq!(repo.oid("HEAD"), head);
        assert!(repo.has_marker(pick));
    }
}

#[test]
fn a_message_and_every_conflict_are_required() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let shown = repo.progress();
        let unmerged = Operation::FinishReplay {
            of: shown.of(),
            staged: shown.staged.clone(),
            tree: Oid::try_from(repo.oid("HEAD^{tree}")).unwrap(),
            message: "Finished\n".to_owned(),
        };
        let error = repo
            .coordinator()
            .write(
                repo.path(),
                &unmerged,
                &Expect {
                    head: shown.destination,
                },
            )
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{format} {pick:?}");
        assert!(error.message.contains("f.txt"), "{}", error.message);
        repo.resolve();
        let error = repo.finish("  \n").unwrap_err();
        assert_eq!(error.kind, ErrorKind::GitFailed, "{format} {pick:?}");
        assert!(repo.has_marker(pick));
    }
}

#[test]
fn finish_refuses_a_staged_edit_outside_the_footprint_and_an_unstaged_edit_inside_it() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        repo.put("u.txt", "staged\n");
        repo.git(&["add", "u.txt"]);
        let error = refused(repo.finish("Finished\n"));
        assert!(
            error.message.contains("u.txt"),
            "{format} {pick:?}: {}",
            error.message
        );
        repo.git(&["restore", "--staged", "--worktree", "u.txt"]);

        repo.put("f.txt", "a\nUNSTAGED\nc\n");
        let error = refused(repo.finish("Finished\n"));
        assert!(
            error.message.contains("f.txt"),
            "{format} {pick:?}: {}",
            error.message
        );
        assert!(repo.has_marker(pick));
    }
}

#[test]
fn an_unrelated_unstaged_edit_survives_finish() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.put("v.txt", "edited\n");
        repo.resolve();
        repo.finish("Finished\n").unwrap();
        assert_eq!(repo.read("v.txt"), "edited\n", "{format} {pick:?}");
        assert_eq!(repo.status(), " M v.txt\n");
    }
}

#[test]
fn a_sequence_of_commits_refuses_finish() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        let first = repo.commit_all("first");
        repo.put("u.txt", "theirs\n");
        repo.commit_all("second");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        repo.fails(&["cherry-pick", "topic~1", "topic"]);
        repo.put("f.txt", "a\nRESOLVED\nc\n");
        repo.git(&["add", "f.txt"]);
        let status = worktree_status(repo.path()).unwrap();
        let head = repo.oid("HEAD");
        let error = refused(repo.coordinator().write(
            repo.path(),
            &Operation::FinishReplay {
                of: ReplayOf {
                    kind: ReplayKind::CherryPick,
                    commit: Oid::try_from(first).unwrap(),
                },
                staged: status.staged_stamp,
                tree: Oid::try_from(repo.git(&["write-tree"]).trim().to_owned()).unwrap(),
                message: "Finished\n".to_owned(),
            },
            &Expect { head: status.head },
        ));
        assert!(error.message.contains("No single"), "{}", error.message);
        assert_eq!(repo.oid("HEAD"), head, "{format}");
        assert!(repo.has_marker(Pick::CherryPick));
    }
}

#[test]
fn a_linked_worktree_finishes_its_own_replay() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let linked = repo.linked("linked", "busy");
        stop(&linked, pick);
        let path = linked.to_str().unwrap();
        let coordinator = repo.coordinator();
        fs::write(linked.join("f.txt"), "a\nRESOLVED\nc\n").unwrap();
        git(&linked, &["add", "f.txt"]);
        let MergeState::Replay { progress } = coordinator.merge_state(path).unwrap() else {
            panic!("{format} {pick:?}");
        };
        let applied = coordinator
            .write(
                path,
                &finish_operation(&progress, "Finished\n"),
                &Expect {
                    head: progress.destination,
                },
            )
            .unwrap();
        assert_eq!(applied.root, path);
        assert_eq!(
            git(&linked, &["log", "-1", "--format=%s"]).trim(),
            "Finished",
            "{format} {pick:?}"
        );
        assert_eq!(coordinator.merge_state(path).unwrap(), MergeState::Idle);
    }
}

#[test]
fn a_failing_hook_stops_finish_and_leaves_the_replay_in_progress() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let shown = repo.progress();
        let head = repo.oid("HEAD");
        repo.hook("pre-commit", "echo nope >&2\nexit 1\n");
        let error = repo.finish_as_shown(&shown, "Finished\n").unwrap_err();
        assert!(
            matches!(&error.kind, ErrorKind::HookFailed { output } if output.contains("nope")),
            "{format} {pick:?}: {error:?}"
        );
        repo.no_hooks();
        assert_eq!(repo.oid("HEAD"), head);
        assert!(repo.has_marker(pick));
        assert_eq!(repo.progress(), shown, "{format} {pick:?}");
        repo.finish_as_shown(&shown, "Finished\n").unwrap();
    }
}

#[test]
fn a_hook_that_changes_the_result_keeps_the_commit_and_says_so() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        repo.hook("pre-commit", "echo hooked > u.txt\ngit add u.txt\n");
        let error = repo.finish("Finished\n").unwrap_err();
        assert!(
            matches!(error.kind, ErrorKind::AfterHookFailed { .. }),
            "{format} {pick:?}: {error:?}"
        );
        repo.no_hooks();
        assert_eq!(repo.git(&["log", "-1", "--format=%s"]).trim(), "Finished");
        assert!(repo.history().undo.is_some(), "{format} {pick:?}");
        assert!(!repo.has_marker(pick));
    }
}

#[test]
fn a_stale_index_lock_answers_lock_held_as_an_active_merge_does() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let lock = repo.root.join(".git/index.lock");
        fs::write(&lock, "").unwrap();
        assert_eq!(
            repo.progress().unresolved,
            ["f.txt"],
            "no tree to write yet"
        );
        fs::remove_file(&lock).unwrap();
        repo.resolve();
        fs::write(&lock, "").unwrap();
        let error = repo.coordinator().merge_state(repo.path()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::LockHeld, "{format} {pick:?}");
        fs::remove_file(&lock).unwrap();
        assert!(repo.progress().tree.is_some());
    }
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["branch", "source"]);
        repo.put("u.txt", "ours\n");
        repo.commit_all("ours");
        repo.git(&["switch", "--quiet", "source"]);
        repo.put("v.txt", "theirs\n");
        repo.commit_all("theirs");
        repo.git(&["switch", "--quiet", "main"]);
        let coordinator = repo.coordinator();
        let review = coordinator
            .review_merge(
                repo.path(),
                &MergeSelection::Branch {
                    reference: "refs/heads/source".to_owned(),
                },
            )
            .unwrap();
        coordinator
            .merge(repo.path(), &MergeAction::Start { review })
            .unwrap();
        assert!(matches!(repo.state(), MergeState::Active { .. }));
        fs::write(repo.root.join(".git/index.lock"), "").unwrap();
        let error = coordinator.merge_state(repo.path()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::LockHeld, "{format}");
    }
}

/// F2, by hook kill: Git and the app die in `pre-commit`, with the entry pending.
#[test]
fn a_force_quit_in_pre_commit_leaves_the_replay_finishable() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let shown = repo.progress();
        let head = repo.oid("HEAD");
        repo.hook("pre-commit", KILL_GIT_AND_APP);
        repo.force_quit_during_finish();

        assert_eq!(repo.oid("HEAD"), head, "{format} {pick:?}");
        assert!(repo.has_marker(pick));
        assert_eq!(repo.progress(), shown, "{format} {pick:?}");
        assert!(
            repo.history().undo.is_some(),
            "the resolver's journal still answers"
        );

        let finished = repo.finish_as_shown(&shown, "Finished\n").unwrap();
        assert_eq!(repo.git(&["log", "-1", "--format=%s"]).trim(), "Finished");
        assert_eq!(repo.undo_id(), Some(finished.id), "{format} {pick:?}");
    }
}

/// F5, by hook kill: Git and the app die in `post-commit`, after the marker went.
#[test]
fn a_force_quit_after_the_commit_settles_to_an_undo_entry() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let head = repo.oid("HEAD");
        repo.hook("post-commit", KILL_GIT_AND_APP);
        repo.force_quit_during_finish();

        assert_eq!(repo.oid("HEAD^"), head, "{format} {pick:?}");
        assert!(!repo.has_marker(pick));
        assert_eq!(repo.state(), MergeState::Idle);
        let entry = repo.history().undo.expect("the commit landed");
        assert!(
            matches!(entry.operation, Operation::FinishReplay { .. }),
            "{format} {pick:?}: {entry:?}"
        );
    }
}

/// F5 again, with only Git killed: the app is alive to answer, and it cannot yet
/// tell whether the commit landed.
#[test]
fn a_git_killed_after_the_commit_settles_on_the_next_request() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let head = repo.oid("HEAD");
        repo.hook("post-commit", "kill -9 $PPID\n");
        let error = repo.finish("Finished\n").unwrap_err();
        assert_eq!(error.kind, ErrorKind::GitFailed, "{}", error.message);
        repo.no_hooks();
        assert_eq!(repo.oid("HEAD^"), head, "{format} {pick:?}");
        assert!(repo.history().undo.is_some(), "{format} {pick:?}");
    }
}

/// The proof reads a commit's parent and tree, so it cannot tell a commit a terminal
/// made from the staged result apart from the one Finish would have made.
#[test]
fn a_commit_after_a_force_quit_settles_by_its_parent_and_tree() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        repo.hook("pre-commit", KILL_GIT_AND_APP);
        repo.force_quit_during_finish();
        repo.git(&["commit", "--quiet", "-m", "from a terminal"]);
        assert!(
            matches!(
                repo.history().undo.map(|entry| entry.operation),
                Some(Operation::FinishReplay { .. })
            ),
            "{format} {pick:?}: same parent and tree"
        );

        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        repo.hook("pre-commit", KILL_GIT_AND_APP);
        repo.force_quit_during_finish();
        repo.put("u.txt", "more\n");
        repo.git(&["add", "u.txt"]);
        repo.git(&["commit", "--quiet", "-m", "from a terminal"]);
        assert_eq!(repo.history().undo, None, "{format} {pick:?}: another tree");
    }
}

#[test]
fn abort_restores_head_and_every_file() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let before = repo.git(&["rev-parse", "HEAD", "HEAD^{tree}"]);
        assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.git(&["rev-parse", "HEAD", "HEAD^{tree}"]), before);
        assert_eq!(repo.status(), "", "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nOURS\nc\n");
        assert!(!repo.has_marker(pick));
        assert_eq!(repo.state(), MergeState::Idle);
    }
}

#[test]
fn abort_works_over_the_wire_after_a_resolved_conflict() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.resolve();
        let shown = repo.progress();
        let answer = run(
            &repo.coordinator(),
            Request::ReplayAbort {
                path: repo.path().to_owned(),
                of: shown.of(),
                head: shown.destination,
            },
        )
        .unwrap();
        assert!(
            matches!(answer, Response::ReplayAbort(MergeState::Idle)),
            "{format} {pick:?}: {answer:?}"
        );
        assert_eq!(repo.read("f.txt"), "a\nOURS\nc\n");
        assert_eq!(repo.status(), "");
    }
}

#[test]
fn abort_ends_a_modify_delete_conflict() {
    for format in FORMATS {
        for repo in modify_delete_stops(format) {
            let head = repo.oid("HEAD");
            assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format}");
            assert_eq!(repo.oid("HEAD"), head);
            assert_eq!(repo.status(), "", "{format}");
        }
    }
}

#[test]
fn abort_puts_a_rename_back() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.put("g.txt", &numbered("g"));
        repo.commit_all("adds g");
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        repo.git(&["mv", "g.txt", "g2.txt"]);
        let commit = repo.commit_all("changes f, renames g");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        repo.fails(&["cherry-pick", &commit]);
        assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format}");
        assert_eq!(repo.read("g.txt"), numbered("g"));
        assert!(!repo.root.join("g2.txt").exists(), "{format}");
        assert_eq!(repo.status(), "");
    }
}

#[test]
fn a_staged_edit_outside_the_footprint_refuses_abort_and_keeps_its_bytes() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.put("u.txt", "staged\n");
        repo.git(&["add", "u.txt"]);
        let staged = repo.git(&["rev-parse", ":u.txt"]);
        let error = repo.abort().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{format} {pick:?}");
        assert!(error.message.contains("u.txt"), "{}", error.message);
        assert!(repo.has_marker(pick));
        assert_eq!(repo.git(&["rev-parse", ":u.txt"]), staged);
        assert_eq!(repo.read("u.txt"), "staged\n");
        assert_eq!(repo.progress().unresolved, ["f.txt"]);
    }
}

#[test]
fn a_revert_with_no_commit_and_an_earlier_staged_edit_refuses_abort() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        let commit = repo.commit_all("theirs");
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        repo.put("u.txt", "staged\n");
        repo.git(&["add", "u.txt"]);
        repo.fails(&["revert", "--no-commit", &commit]);
        let error = repo.abort().unwrap_err();
        assert!(
            error.message.contains("u.txt"),
            "{format}: {}",
            error.message
        );
        assert_eq!(repo.read("u.txt"), "staged\n");
    }
}

#[test]
fn an_unrelated_unstaged_edit_survives_abort() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.put("v.txt", "edited\n");
        assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.read("v.txt"), "edited\n");
        assert_eq!(repo.status(), " M v.txt\n");
    }
}

#[test]
fn an_unstaged_edit_on_a_resolved_path_stops_abort_and_keeps_the_replay() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.put("f.txt", "a\nRESOLVED\nc\n");
        repo.git(&["add", "f.txt"]);
        repo.put("f.txt", "a\nMORE\nc\n");
        let head = repo.oid("HEAD");
        let error = repo.abort().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{format} {pick:?}");
        assert!(error.message.contains("f.txt"), "{}", error.message);
        assert!(repo.has_marker(pick));
        assert_eq!(repo.oid("HEAD"), head);
        assert_eq!(repo.read("f.txt"), "a\nMORE\nc\n");
        repo.git(&["add", "f.txt"]);
        assert_eq!(repo.abort().unwrap(), MergeState::Idle);
    }
}

#[test]
fn a_repeated_abort_answers_idle_and_runs_nothing() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let shown = repo.progress();
        assert_eq!(repo.abort_as_shown(&shown).unwrap(), MergeState::Idle);
        let runs = repo.directory.path().join("runs");
        for hook in ["post-index-change", "reference-transaction"] {
            repo.hook(hook, &format!("echo run >> '{}'\n", runs.display()));
        }
        assert_eq!(repo.abort_as_shown(&shown).unwrap(), MergeState::Idle);
        assert!(!runs.exists(), "{format} {pick:?}: Git ran again");
        repo.no_hooks();
    }
}

#[test]
fn an_abort_naming_another_commit_or_head_is_stale_and_changes_nothing() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let shown = repo.progress();
        let stale = ErrorKind::StaleView {
            reason: StaleReason::HeadMoved,
        };
        let other = ReplayOf {
            kind: shown.kind,
            commit: Oid::try_from(repo.oid("HEAD")).unwrap(),
        };
        let error = repo
            .coordinator()
            .abort_replay(repo.path(), &other, &shown.destination)
            .unwrap_err();
        assert_eq!(error.kind, stale, "{format} {pick:?}");
        assert!(repo.has_marker(pick));
        repo.move_head_with_plumbing();
        assert_eq!(repo.abort_as_shown(&shown).unwrap_err().kind, stale);
        assert!(repo.has_marker(pick), "{format} {pick:?}");
    }
}

fn abort_refused(repo: &Repo, commit: &str) {
    let head = repo.oid("HEAD");
    let error = repo
        .coordinator()
        .abort_replay(
            repo.path(),
            &ReplayOf {
                kind: ReplayKind::CherryPick,
                commit: Oid::try_from(commit.to_owned()).unwrap(),
            },
            &worktree_status(repo.path()).unwrap().head,
        )
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert_eq!(repo.oid("HEAD"), head);
    assert!(repo.has_marker(Pick::CherryPick));
}

#[test]
fn abort_refuses_a_sequence_a_pruned_commit_and_a_footprint_it_cannot_name() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        let first = repo.commit_all("first");
        repo.put("u.txt", "theirs\n");
        repo.commit_all("second");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        repo.fails(&["cherry-pick", "topic~1", "topic"]);
        abort_refused(&repo, &first);

        let (repo, commit) = Repo::stopped(format, Pick::CherryPick);
        repo.git(&["branch", "--quiet", "-D", "topic"]);
        repo.git(&["reflog", "expire", "--expire=now", "--all"]);
        repo.git(&["gc", "--quiet", "--prune=now"]);
        abort_refused(&repo, &commit);

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
        abort_refused(&repo, &commit);
    }
}

#[test]
fn a_linked_worktree_aborts_only_its_own_replay() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let linked = repo.linked("linked", "busy");
        stop(&linked, pick);
        let path = linked.to_str().unwrap();
        let coordinator = repo.coordinator();
        let MergeState::Replay { progress } = coordinator.merge_state(path).unwrap() else {
            panic!("{format} {pick:?}");
        };
        let state = coordinator
            .abort_replay(path, &progress.of(), &progress.destination)
            .unwrap();
        assert_eq!(state, MergeState::Idle, "{format} {pick:?}");
        assert_eq!(git(&linked, &["status", "--porcelain"]), "");
    }
}

/// A1, by a real kill: a smudge filter kills Git while `git reset --merge` is
/// writing files during Abort.
#[test]
fn an_abort_killed_while_writing_files_finishes_when_repeated() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let head = repo.oid("HEAD");
        let filter = repo.directory.path().join("kill-git");
        fs::write(&filter, format!("#!/bin/sh\n{KILL_GIT_ANCESTORS}cat\n")).unwrap();
        fs::set_permissions(&filter, fs::Permissions::from_mode(0o755)).unwrap();
        repo.git(&["config", "filter.killed.smudge", filter.to_str().unwrap()]);
        fs::write(
            repo.root.join(".git/info/attributes"),
            "f.txt filter=killed\n",
        )
        .unwrap();
        let shown = repo.progress();

        let error = repo.abort_as_shown(&shown).unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::GitFailed,
            "{format} {pick:?}: {}",
            error.message
        );
        assert!(repo.has_marker(pick), "{format} {pick:?}");
        assert_eq!(repo.oid("HEAD"), head);
        repo.git(&["config", "--unset", "filter.killed.smudge"]);

        let lock = repo.root.join(".git/index.lock");
        if lock.exists() {
            let error = repo.abort_as_shown(&shown).unwrap_err();
            assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
            assert!(error.message.contains("index.lock"), "{}", error.message);
            fs::remove_file(&lock).unwrap();
        }
        let state = repo
            .coordinator()
            .abort_replay(repo.path(), &shown.of(), &shown.destination)
            .unwrap();
        assert_eq!(state, MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.oid("HEAD"), head);
        assert_eq!(repo.read("f.txt"), "a\nOURS\nc\n");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

/// A2, by a real kill: `post-index-change` runs with the index written and the
/// marker still set.
#[test]
fn an_abort_killed_after_the_index_was_written_finishes_when_repeated() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let head = repo.oid("HEAD");
        let shown = repo.progress();
        repo.hook("post-index-change", KILL_GIT_ANCESTORS);
        let error = repo.abort_as_shown(&shown).unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::GitFailed,
            "{format} {pick:?}: {}",
            error.message
        );
        repo.no_hooks();
        assert!(repo.has_marker(pick), "{format} {pick:?}");
        assert_eq!(
            repo.status(),
            "",
            "the index and files are already restored"
        );

        let progress = repo.progress();
        assert!(progress.empty, "{format} {pick:?}");
        assert_eq!(repo.abort_as_shown(&progress).unwrap(), MergeState::Idle);
        assert!(!repo.has_marker(pick));
        assert_eq!(repo.oid("HEAD"), head);
    }
}

/// A3, by a terminal abort: the marker is gone, so the next request sweeps the
/// journal and answers idle.
#[test]
fn an_abort_that_ended_before_the_answer_reads_as_idle_and_sweeps() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        repo.save("f.txt", "a\nRESOLVED\nc\n");
        let shown = repo.progress();
        repo.git(&[pick.command(), "--abort"]);
        assert_eq!(repo.abort_as_shown(&shown).unwrap(), MergeState::Idle);
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
        assert_eq!(
            fs::read_dir(repo.root.join(".git/l1git/replay"))
                .unwrap()
                .count(),
            0,
            "{format} {pick:?}"
        );
    }
}

const KILL_AT_REF_COMMIT: &str = "[ \"$1\" = committed ] || exit 0\n";

/// F3, by hook kill: Git and the app die as the ref moves, with the marker still set.
fn killed_as_the_ref_moved(format: &str, pick: Pick) -> (Repo, String) {
    let (repo, _) = Repo::stopped(format, pick);
    repo.resolve();
    let before = repo.oid("HEAD");
    repo.hook(
        "reference-transaction",
        &format!("{KILL_AT_REF_COMMIT}{KILL_GIT_AND_APP}"),
    );
    repo.force_quit_during_finish();
    assert_eq!(
        repo.oid("HEAD^"),
        before,
        "{format} {pick:?}: the ref moved"
    );
    assert!(
        repo.has_marker(pick),
        "{format} {pick:?}: the marker stayed"
    );
    (repo, before)
}

#[test]
fn a_kill_as_the_ref_moves_reads_as_empty_and_abort_keeps_the_commit() {
    for (format, pick) in cases() {
        let (repo, _) = killed_as_the_ref_moved(format, pick);
        let _ = fs::remove_file(repo.root.join(".git/index.lock"));
        let progress = repo.progress();
        assert!(progress.empty, "{format} {pick:?}");
        let error = repo.finish_as_shown(&progress, "Again\n").unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnchangedPath, "{format} {pick:?}");
        assert!(error.message.contains("Abort"), "{}", error.message);

        let made = repo.oid("HEAD");
        assert_eq!(repo.abort_as_shown(&progress).unwrap(), MergeState::Idle);
        assert_eq!(
            repo.oid("HEAD"),
            made,
            "{format} {pick:?}: Abort keeps the commit"
        );
        assert_eq!(repo.git(&["log", "-1", "--format=%s"]).trim(), "Finished");
        assert_eq!(repo.status(), "");
        assert!(
            matches!(
                repo.history().undo.map(|entry| entry.operation),
                Some(Operation::FinishReplay { .. })
            ),
            "{format} {pick:?}: the pending entry settles once the marker is gone"
        );
    }
}

/// F4, by constructing the state from F3: no hook runs between Git clearing the
/// marker and committing the index, so this clears the marker and writes the lock.
#[test]
fn a_kill_after_the_marker_went_settles_with_the_lock_still_there() {
    for (format, pick) in cases() {
        let (repo, _) = killed_as_the_ref_moved(format, pick);
        repo.git(&["update-ref", "--no-deref", "-d", pick.marker()]);
        let lock = repo.root.join(".git/index.lock");
        fs::write(&lock, "").unwrap();
        assert_eq!(repo.state(), MergeState::Idle, "{format} {pick:?}");
        assert!(
            matches!(
                repo.history().undo.map(|entry| entry.operation),
                Some(Operation::FinishReplay { .. })
            ),
            "{format} {pick:?}"
        );
        fs::remove_file(&lock).unwrap();
        assert_eq!(
            repo.status(),
            "",
            "{format} {pick:?}: the index equals HEAD"
        );
    }
}

/// `foo` is a file on one side and a folder on the other, so Git files the file under
/// a new name. A real pick and `git merge-tree` label that name differently.
fn stopped_on_a_renamed_path(format: &str, pick: Pick) -> Repo {
    let repo = Repo::new(format);
    repo.put("foo", "file\n");
    repo.commit_all("foo is a file");
    let start: &[&str] = match pick {
        Pick::CherryPick => &["cherry-pick"],
        Pick::Revert => &["revert", "--no-edit"],
    };
    let commit = match pick {
        Pick::CherryPick => {
            repo.git(&["switch", "--quiet", "-c", "topic", "HEAD^"]);
            fs::create_dir(repo.root.join("foo")).unwrap();
            repo.put("foo/x", "x\n");
            let commit = repo.commit_all("foo is a folder");
            repo.git(&["switch", "--quiet", "main"]);
            commit
        }
        Pick::Revert => {
            fs::remove_file(repo.root.join("foo")).unwrap();
            let removed = repo.commit_all("foo/x goes\n\nwith a body");
            fs::create_dir(repo.root.join("foo")).unwrap();
            repo.put("foo/x", "x\n");
            repo.commit_all("foo is a folder");
            removed
        }
    };
    repo.fails(&[start, &[commit.as_str()]].concat());
    repo
}

#[test]
fn a_conflict_git_renames_to_avoid_a_clash_can_be_finished_and_aborted() {
    for (format, pick) in cases() {
        let repo = stopped_on_a_renamed_path(format, pick);
        let shown = repo.progress();
        assert_eq!(shown.unresolved.len(), 1, "{format} {pick:?}: {shown:?}");
        let renamed = shown.unresolved[0].clone();
        assert!(renamed.starts_with("foo~"), "{format} {pick:?}: {renamed}");
        assert!(
            shown.footprint.contains(&renamed),
            "{format} {pick:?}: {:?} lacks {renamed}",
            shown.footprint
        );

        assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format} {pick:?}");

        let repo = stopped_on_a_renamed_path(format, pick);
        let renamed = repo.progress().unresolved[0].clone();
        repo.stage(&renamed);
        let shown = repo.progress();
        assert!(shown.unresolved.is_empty(), "{format} {pick:?}: {shown:?}");
        assert!(
            shown.footprint.contains(&renamed),
            "{format} {pick:?}: resolving does not shrink it"
        );
        let applied = repo.finish("Finished\n").unwrap();
        assert!(
            repo.git(&["ls-files"]).contains(&renamed),
            "{format} {pick:?}"
        );
        repo.undo(&applied).unwrap();
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

#[test]
fn a_renamed_path_resolved_in_a_terminal_before_the_first_read_can_still_be_finished() {
    for (format, pick) in cases() {
        let repo = stopped_on_a_renamed_path(format, pick);
        let unmerged = repo.git(&["diff", "--name-only", "--diff-filter=U"]);
        let renamed = unmerged.trim().to_owned();
        repo.git(&["add", "--", &renamed]);
        let shown = repo.progress();
        assert!(
            shown.footprint.contains(&renamed),
            "{format} {pick:?}: {shown:?}"
        );
        repo.finish("Finished\n").unwrap();
        assert!(
            repo.git(&["ls-files"]).contains(&renamed),
            "{format} {pick:?}"
        );
    }
}

/// `git update-index` can make a path unmerged, so being unmerged says nothing about who
/// made the change.
#[test]
fn abort_refuses_a_path_something_other_than_the_operation_made_unmerged() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let blob = repo.git(&["rev-parse", ":u.txt"]);
        let null = "0".repeat(blob.trim().len());
        let script = format!(
            "printf '0 {null}\\tu.txt\\n100644 {}\\t2\\tu.txt\\n' | sed 's/\\t2\\t/ 2\\t/' | git update-index --index-info",
            blob.trim()
        );
        let ran = Command::new("sh")
            .args(["-c", &script])
            .current_dir(&repo.root)
            .output()
            .unwrap();
        assert!(ran.status.success(), "{ran:?}");
        assert!(repo.status().contains("u.txt"), "{format} {pick:?}");

        let error = repo.abort().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{format} {pick:?}");
        assert!(error.message.contains("u.txt"), "{}", error.message);
        assert!(!repo.progress().footprint.contains(&"u.txt".to_owned()));
    }
}

/// The memo must not carry one operation's index into the next one on the same commit.
#[test]
fn a_stale_memo_does_not_widen_a_later_no_commit_revert() {
    for (format, pick) in cases().filter(|(_, pick)| *pick == Pick::Revert) {
        let (repo, commit) = Repo::stopped(format, pick);
        assert!(!repo.progress().footprint.contains(&"u.txt".to_owned()));
        repo.git(&["revert", "--abort"]);
        repo.put("u.txt", "staged\n");
        repo.git(&["add", "u.txt"]);
        repo.fails(&["revert", "-n", &commit]);

        let error = repo.abort().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{format}");
        assert!(error.message.contains("u.txt"), "{}", error.message);
        assert_eq!(repo.read("u.txt"), "staged\n", "{format}");
    }
}

/// The commit's side of the clash, so Git labels the path with the commit, not `HEAD`.
fn stopped_on_a_path_labelled_with_the_commit(format: &str, subject: &str) -> Repo {
    let repo = Repo::new(format);
    repo.git(&["switch", "--quiet", "-c", "topic"]);
    repo.put("foo", "file\n");
    let commit = repo.commit_all(subject);
    repo.git(&["switch", "--quiet", "main"]);
    fs::create_dir(repo.root.join("foo")).unwrap();
    repo.put("foo/x", "x\n");
    repo.commit_all("foo is a folder");
    repo.fails(&["cherry-pick", &commit]);
    repo
}

#[test]
fn the_footprint_names_a_commit_labelled_path_whatever_the_subject_holds() {
    for format in ["files", "reftable"] {
        for subject in [
            "pick me",
            "fix a/b and c/d",
            "say \"hi\" (now)",
            "first\nsecond",
        ] {
            let repo = stopped_on_a_path_labelled_with_the_commit(format, subject);
            let shown = repo.progress();
            assert_eq!(shown.unresolved.len(), 1, "{format} {subject}: {shown:?}");
            assert!(
                shown.footprint.contains(&shown.unresolved[0]),
                "{format} {subject}: {:?} lacks {}",
                shown.footprint,
                shown.unresolved[0]
            );
            assert_eq!(
                repo.abort().unwrap(),
                MergeState::Idle,
                "{format} {subject}"
            );
        }
    }
}

#[test]
fn abort_refuses_a_staged_editor_backup_beside_a_renamed_path() {
    for (format, pick) in cases() {
        for backup in ["foo~", "foo~1"] {
            let repo = stopped_on_a_renamed_path(format, pick);
            repo.put(backup, "backup\n");
            repo.git(&["add", "--", backup]);

            let error = repo.abort().unwrap_err();
            assert_eq!(
                error.kind,
                ErrorKind::Conflict,
                "{format} {pick:?} {backup}"
            );
            assert!(error.message.contains(backup), "{}", error.message);
            assert_eq!(repo.read(backup), "backup\n", "{format} {pick:?} {backup}");
        }
    }
}

#[test]
fn removing_a_renamed_path_keeps_it_in_the_footprint_and_undo_can_bring_it_back() {
    for (format, pick) in cases() {
        let repo = stopped_on_a_renamed_path(format, pick);
        let renamed = repo.progress().unresolved[0].clone();
        fs::remove_file(repo.root.join(&renamed)).unwrap();
        let resolved = repo.stage(&renamed);
        assert!(
            repo.progress().footprint.contains(&renamed),
            "{format} {pick:?}: resolving does not shrink it"
        );
        repo.undo(&resolved).unwrap();
        assert_eq!(repo.progress().unresolved, [renamed], "{format} {pick:?}");
    }
}

/// Git takes `foo~HEAD_0` when HEAD already tracks `foo~HEAD`, so the operation never
/// touches that file, and an edit staged on it is the user's own.
#[test]
fn abort_refuses_a_staged_edit_on_a_tracked_file_named_like_a_renamed_path() {
    for format in ["files", "reftable"] {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        fs::create_dir(repo.root.join("foo")).unwrap();
        repo.put("foo/x", "x\n");
        let commit = repo.commit_all("foo is a folder");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("foo", "file\n");
        repo.put("foo~HEAD", "mine\n");
        repo.commit_all("foo is a file");
        repo.fails(&["cherry-pick", &commit]);
        assert_eq!(repo.progress().unresolved, ["foo~HEAD_0"], "{format}");
        assert!(
            !repo.progress().footprint.contains(&"foo~HEAD".to_owned()),
            "{format}"
        );

        repo.put("foo~HEAD", "edited\n");
        repo.git(&["add", "--", "foo~HEAD"]);
        repo.git(&["rm", "--quiet", "--cached", "-f", "--", "foo~HEAD_0"]);
        let error = repo.abort().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{format}");
        assert!(error.message.contains("foo~HEAD"), "{}", error.message);
        assert_eq!(repo.read("foo~HEAD"), "edited\n", "{format}");
    }
}

#[test]
fn a_clash_on_a_name_that_looks_like_pathspec_magic_still_reads_and_aborts() {
    for format in ["files", "reftable"] {
        for name in [":!foo", ":(foo", ":"] {
            let repo = Repo::new(format);
            repo.git(&["switch", "--quiet", "-c", "topic"]);
            fs::create_dir(repo.root.join(name)).unwrap();
            repo.put(&format!("{name}/x"), "x\n");
            let commit = repo.commit_all("a folder");
            repo.git(&["switch", "--quiet", "main"]);
            repo.put(name, "file\n");
            repo.commit_all("a file");
            repo.fails(&["cherry-pick", &commit]);

            let shown = repo.progress();
            assert_eq!(shown.unresolved.len(), 1, "{format} {name}: {shown:?}");
            assert!(
                shown.footprint.contains(&shown.unresolved[0]),
                "{format} {name}"
            );
            assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format} {name}");
        }
    }
}

/// Undoing and redoing Mark resolved restores an index row with no stat data, and
/// `--abort` would report that as an unstaged edit.
#[test]
fn abort_works_after_mark_resolved_is_undone_and_redone() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::stopped(format, pick);
        let saved = repo.save("f.txt", "a\nSAVED\nc\n");
        let marked = repo.stage("f.txt");
        repo.undo(&marked).unwrap();
        repo.redo(&marked).unwrap();
        assert!(saved.id < marked.id, "{format} {pick:?}");
        assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format} {pick:?}");
    }
}

#[test]
fn undo_removes_the_commit_and_its_files_and_redo_returns_the_same_oid() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let made = repo.oid("HEAD");
        let result = repo.git(&["rev-parse", "HEAD^{tree}"]);
        let parent = repo.oid("HEAD^");

        assert_eq!(repo.undo(&applied).unwrap().id, applied.id);
        assert_eq!(repo.oid("HEAD"), parent, "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nOURS\nc\n");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
        assert_eq!(
            repo.root.join("n.txt").exists(),
            pick == Pick::Revert,
            "{format} {pick:?}"
        );
        assert_eq!(
            repo.state(),
            MergeState::Idle,
            "Undo does not reopen a conflict"
        );

        assert_eq!(repo.redo(&applied).unwrap().id, applied.id);
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert_eq!(repo.git(&["rev-parse", "HEAD^{tree}"]), result);
        assert_eq!(repo.read("f.txt"), "a\nRESOLVED\nc\n");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

#[test]
fn a_repeated_undo_answers_the_entry_and_changes_nothing() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let parent = repo.oid("HEAD^");
        repo.undo(&applied).unwrap();
        assert_eq!(repo.undo(&applied).unwrap().id, applied.id);
        assert_eq!(repo.oid("HEAD"), parent, "{format} {pick:?}");
    }
}

#[test]
fn older_history_is_still_reachable_after_a_finished_replay_is_undone() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        repo.put("u.txt", "more\n");
        repo.git(&["add", "u.txt"]);
        let status = worktree_status(repo.path()).unwrap();
        let earlier = repo
            .coordinator()
            .write(
                repo.path(),
                &Operation::Commit {
                    message: "earlier\n".to_owned(),
                    staged: status.staged_stamp,
                },
                &Expect { head: status.head },
            )
            .unwrap();
        stop(&repo.root, pick);
        repo.save("f.txt", "a\nSAVED\nc\n");
        repo.stage("f.txt");
        let finished = repo.finish("Finished\n").unwrap();
        repo.undo(&finished).unwrap();
        assert_eq!(repo.undo_id(), Some(earlier.id), "{format} {pick:?}");
    }
}

#[test]
fn an_unrelated_edit_survives_undo_and_redo() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        repo.put("v.txt", "edited\n");
        repo.put("u.txt", "staged\n");
        repo.git(&["add", "u.txt"]);
        repo.undo(&applied).unwrap();
        assert_eq!(repo.read("v.txt"), "edited\n", "{format} {pick:?}");
        assert_eq!(repo.read("u.txt"), "staged\n", "{format} {pick:?}");
        assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "u.txt\n");
        repo.redo(&applied).unwrap();
        assert_eq!(repo.read("v.txt"), "edited\n", "{format} {pick:?}");
        assert_eq!(repo.status(), "M  u.txt\n M v.txt\n", "{format} {pick:?}");
    }
}

#[test]
fn an_overlapping_edit_refuses_undo_with_head_unmoved() {
    let stale = ErrorKind::StaleView {
        reason: StaleReason::PathChanged,
    };
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let made = repo.oid("HEAD");
        repo.put("f.txt", "a\nEDITED\nc\n");
        let error = repo.undo(&applied).unwrap_err();
        assert_eq!(error.kind, stale, "{format} {pick:?}: {}", error.message);
        assert!(error.message.contains("f.txt"), "{}", error.message);
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nEDITED\nc\n");

        repo.git(&["add", "f.txt"]);
        let error = repo.undo(&applied).unwrap_err();
        assert_eq!(error.kind, stale, "{format} {pick:?}: {}", error.message);
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "f.txt\n");

        repo.git(&["restore", "--staged", "--worktree", "f.txt"]);
        repo.undo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), repo.oid("main"));
    }
}

#[test]
fn abort_refuses_to_overwrite_a_file_at_a_path_the_replay_deleted() {
    for (format, pick) in cases().filter(|(_, pick)| *pick == Pick::Revert) {
        for ignored in [true, false] {
            let (repo, _) = Repo::stopped(format, pick);
            assert!(!repo.root.join("n.txt").exists(), "{format}");
            if ignored {
                repo.git(&["config", "core.excludesFile", ".git/ignored"]);
                fs::write(repo.root.join(".git/ignored"), "n.txt\n").unwrap();
            }
            repo.put("n.txt", "mine\n");

            let error = repo.abort().unwrap_err();
            assert_eq!(
                error.kind,
                ErrorKind::Conflict,
                "{format} ignored {ignored}"
            );
            assert!(error.message.contains("n.txt"), "{}", error.message);
            assert_eq!(repo.read("n.txt"), "mine\n", "{format} ignored {ignored}");
            assert!(matches!(repo.state(), MergeState::Replay { .. }));

            fs::remove_file(repo.root.join("n.txt")).unwrap();
            assert_eq!(repo.abort().unwrap(), MergeState::Idle);
            assert!(repo.root.join("n.txt").exists(), "Abort restored it");
        }
    }
}

#[test]
fn a_file_touched_with_no_edits_does_not_refuse_undo_or_redo() {
    let touch = |repo: &Repo, path: &str| {
        fs::File::options()
            .write(true)
            .open(repo.root.join(path))
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60))
            .unwrap();
    };
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let parent = repo.oid("HEAD^");
        let made = repo.oid("HEAD");
        touch(&repo, "f.txt");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
        repo.hook("post-index-change", "echo fired >> .git/index-changes\n");
        repo.undo(&applied).unwrap();
        repo.no_hooks();
        assert_eq!(repo.oid("HEAD"), parent, "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nOURS\nc\n");
        assert_eq!(
            fs::read_to_string(repo.root.join(".git/index-changes")).unwrap(),
            "fired\n",
            "{format} {pick:?}: refreshing stat data runs no hook"
        );

        touch(&repo, "f.txt");
        repo.redo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nRESOLVED\nc\n");
    }
}

#[test]
fn an_ignored_or_untracked_file_at_a_created_path_refuses_the_step() {
    for format in FORMATS {
        for ignored in [true, false] {
            let (repo, applied) = Repo::finished(format, Pick::Revert);
            assert!(
                !repo.root.join("n.txt").exists(),
                "the revert removed n.txt"
            );
            if ignored {
                fs::write(repo.root.join(".git/info/exclude"), "n.txt\n").unwrap();
            }
            repo.put("n.txt", "mine\n");
            let made = repo.oid("HEAD");
            let error = refused(repo.undo(&applied));
            assert!(error.message.contains("n.txt"), "{}", error.message);
            assert_eq!(repo.oid("HEAD"), made, "{format} ignored {ignored}");
            assert_eq!(repo.read("n.txt"), "mine\n");

            let (repo, applied) = Repo::finished(format, Pick::CherryPick);
            repo.undo(&applied).unwrap();
            if ignored {
                fs::write(repo.root.join(".git/info/exclude"), "n.txt\n").unwrap();
            }
            repo.put("n.txt", "mine\n");
            let parent = repo.oid("HEAD");
            let error = refused(repo.redo(&applied));
            assert!(error.message.contains("n.txt"), "{}", error.message);
            assert_eq!(repo.oid("HEAD"), parent, "{format} ignored {ignored}");
            assert_eq!(repo.read("n.txt"), "mine\n");
        }
    }
}

#[test]
fn undo_refuses_any_operation_in_progress() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let made = repo.oid("HEAD");
        repo.git(&["bisect", "start"]);
        let error = refused(repo.undo(&applied));
        assert!(error.message.starts_with("A bisect"), "{}", error.message);
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
    }
}

#[test]
fn undo_after_head_moved_is_stale() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let moved = repo.move_head_with_plumbing();
        let error = repo.undo(&applied).unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::StaleView {
                reason: StaleReason::HeadMoved
            },
            "{format} {pick:?}"
        );
        assert_eq!(repo.oid("HEAD"), moved);
    }
}

#[test]
fn undo_refuses_while_the_index_is_locked_or_not_ordinary() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let made = repo.oid("HEAD");
        let lock = repo.root.join(".git/index.lock");
        fs::write(&lock, "").unwrap();
        let error = refused(repo.undo(&applied));
        assert!(error.message.contains("index.lock"), "{}", error.message);
        fs::remove_file(&lock).unwrap();
        repo.git(&["update-index", "--skip-worktree", "v.txt"]);
        let error = refused(repo.undo(&applied));
        assert!(error.message.contains("skip-worktree"), "{}", error.message);
        repo.git(&["update-index", "--no-skip-worktree", "v.txt"]);
        repo.git(&["config", "core.sparseCheckout", "true"]);
        let error = refused(repo.undo(&applied));
        assert!(error.message.contains("sparse"), "{}", error.message);
        repo.git(&["config", "core.sparseCheckout", "false"]);
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        repo.undo(&applied).unwrap();
    }
}

/// A crash between moving the files and moving the ref, by constructing the state:
/// no hook runs between the two that can also stop L1 Git's own transaction.
#[test]
fn undo_repeated_after_the_files_moved_finishes_the_ref() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let (made, parent) = (repo.oid("HEAD"), repo.oid("HEAD^"));
        repo.git(&["read-tree", "-m", "-u", &made, &parent]);
        assert_eq!(repo.oid("HEAD"), made);
        assert!(
            !repo.status().is_empty(),
            "{format} {pick:?}: a staged inverse"
        );
        repo.undo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), parent, "{format} {pick:?}");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

/// A crash after the ref moved and before the log saved, by constructing the state:
/// both moves done by hand, with the log still naming the entry as next to undo.
#[test]
fn undo_repeated_after_the_ref_moved_only_saves_the_log() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let (made, parent) = (repo.oid("HEAD"), repo.oid("HEAD^"));
        repo.git(&["read-tree", "-m", "-u", &made, &parent]);
        repo.git(&["update-ref", "refs/heads/main", &parent, &made]);
        repo.undo(&applied).unwrap();
        assert_eq!(repo.history().redo.map(|entry| entry.id), Some(applied.id));
        repo.redo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
    }
}

/// The hook moves the branch once the files have moved, so the compare-and-swap fails.
const MOVE_BRANCH_ONCE: &str = "[ -e .git/moved ] && exit 0\ntouch .git/moved\ngit update-ref refs/heads/main \"$(git commit-tree 'HEAD^{tree}' -p HEAD -m moved)\"\n";

#[test]
fn a_failed_ref_move_puts_the_files_back() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        repo.hook("post-index-change", MOVE_BRANCH_ONCE);
        let error = repo.undo(&applied).unwrap_err();
        repo.no_hooks();
        assert_eq!(
            error.kind,
            ErrorKind::StaleView {
                reason: StaleReason::HeadMoved
            },
            "{format} {pick:?}: {}",
            error.message
        );
        assert_eq!(repo.read("f.txt"), "a\nRESOLVED\nc\n", "{format} {pick:?}");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

#[test]
fn a_failed_ref_move_that_cannot_put_the_files_back_says_both() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        repo.hook(
            "post-index-change",
            &format!("{MOVE_BRANCH_ONCE}echo edited > f.txt\n"),
        );
        let error = repo.undo(&applied).unwrap_err();
        repo.no_hooks();
        assert!(
            error.message.contains("moved since")
                && error.message.contains("could not put them back")
                && error.message.contains("f.txt"),
            "{format} {pick:?}: {}",
            error.message
        );
        assert_eq!(repo.read("f.txt"), "edited\n");
    }
}

#[test]
fn redo_brings_the_commit_back_after_it_was_pruned() {
    for (format, pick) in cases() {
        let (repo, applied) = Repo::finished(format, pick);
        let made = repo.oid("HEAD");
        repo.undo(&applied).unwrap();
        if pick == Pick::CherryPick {
            repo.git(&["branch", "--quiet", "-D", "topic"]);
        }
        repo.git(&["reflog", "expire", "--expire=now", "--all"]);
        repo.git(&["gc", "--quiet", "--prune=now"]);
        assert!(
            !terminal(&repo.root, &["cat-file", "-e", &made])
                .status
                .success(),
            "{format} {pick:?}: gc should prune the commit"
        );
        repo.redo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nRESOLVED\nc\n");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

#[test]
fn undo_from_another_worktree_changes_the_worktree_that_finished() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let linked = repo.linked("linked", "busy");
        stop(&linked, pick);
        let path = linked.to_str().unwrap();
        fs::write(linked.join("f.txt"), "a\nRESOLVED\nc\n").unwrap();
        git(&linked, &["add", "f.txt"]);
        let coordinator = repo.coordinator();
        let MergeState::Replay { progress } = coordinator.merge_state(path).unwrap() else {
            panic!("{format} {pick:?}");
        };
        let applied = coordinator
            .write(
                path,
                &finish_operation(&progress, "Finished\n"),
                &Expect {
                    head: progress.destination,
                },
            )
            .unwrap();
        let parent = git(&linked, &["rev-parse", "HEAD^"]);
        coordinator.undo(repo.path(), applied.id).unwrap();
        assert_eq!(
            git(&linked, &["rev-parse", "HEAD"]),
            parent,
            "{format} {pick:?}"
        );
        assert_eq!(git(&linked, &["status", "--porcelain"]), "");
    }
}

#[test]
fn a_replay_on_a_detached_head_finishes_and_undoes() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        let commit = repo.commit_all("theirs");
        repo.git(&["switch", "--quiet", "--detach", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        repo.fails(&["cherry-pick", &commit]);
        repo.resolve();
        let before = repo.oid("HEAD");
        let applied = repo.finish("Finished\n").unwrap();
        let made = repo.oid("HEAD");
        assert_eq!(repo.oid("HEAD^"), before, "{format}");
        repo.undo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), before, "{format}");
        repo.redo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), made, "{format}");
    }
}

#[test]
fn undo_works_on_an_entry_a_crash_left_pending() {
    for (format, pick) in cases() {
        let (repo, parent) = killed_as_the_ref_moved(format, pick);
        let _ = fs::remove_file(repo.root.join(".git/index.lock"));
        let progress = repo.progress();
        repo.abort_as_shown(&progress).unwrap();
        let entry = repo.history().undo.expect("the entry settled");
        let made = repo.oid("HEAD");
        repo.undo(&entry).unwrap();
        assert_eq!(repo.oid("HEAD"), parent, "{format} {pick:?}");
        repo.redo(&entry).unwrap();
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
    }
}

/// By a real kill: a smudge filter kills Git after `git read-tree` rewrote `f.txt`
/// and before it wrote `n.txt`.
#[test]
fn an_undo_killed_inside_read_tree_refuses_until_its_rewritten_files_are_discarded() {
    for format in FORMATS {
        let (repo, applied) = Repo::finished(format, Pick::Revert);
        let made = repo.oid("HEAD");
        let parent = repo.oid("HEAD^");
        let filter = repo.directory.path().join("kill-git");
        fs::write(&filter, format!("#!/bin/sh\n{KILL_GIT_ANCESTORS}cat\n")).unwrap();
        fs::set_permissions(&filter, fs::Permissions::from_mode(0o755)).unwrap();
        repo.git(&["config", "filter.killed.smudge", filter.to_str().unwrap()]);
        fs::write(
            repo.root.join(".git/info/attributes"),
            "n.txt filter=killed\n",
        )
        .unwrap();

        let error = repo.undo(&applied).unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::GitFailed,
            "{format}: {}",
            error.message
        );
        assert_eq!(
            repo.oid("HEAD"),
            made,
            "{format}: the ref moves only after read-tree"
        );
        repo.git(&["config", "--unset", "filter.killed.smudge"]);
        let _ = fs::remove_file(repo.root.join(".git/index.lock"));
        assert_eq!(repo.status(), " M f.txt\n", "{format}: Git's partial state");

        let error = repo.undo(&applied).unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::StaleView {
                reason: StaleReason::PathChanged
            },
            "{format}: {}",
            error.message
        );
        repo.git(&["restore", "f.txt"]);
        repo.undo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), parent, "{format}");
        assert_eq!(repo.status(), "", "{format}");
    }
}

#[test]
fn undo_from_another_worktree_refuses_while_that_worktree_holds_a_replay() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let linked = repo.linked("linked", "busy");
        let path = linked.to_str().unwrap();
        fs::write(linked.join("u.txt"), "more\n").unwrap();
        git(&linked, &["add", "u.txt"]);
        let coordinator = repo.coordinator();
        let status = worktree_status(path).unwrap();
        let earlier = coordinator
            .write(
                path,
                &Operation::Commit {
                    message: "earlier\n".to_owned(),
                    staged: status.staged_stamp,
                },
                &Expect { head: status.head },
            )
            .unwrap();
        stop(&linked, pick);
        let head = git(&linked, &["rev-parse", "HEAD"]);
        let error = refused(coordinator.undo(repo.path(), earlier.id));
        let holder = match pick {
            Pick::CherryPick => "a cherry-pick",
            Pick::Revert => "a revert",
        };
        assert_eq!(
            error.message,
            format!(
                "This history entry changes a worktree with {holder} in progress. Use that worktree's resolution Undo until Finish or Abort."
            ),
        );
        assert_eq!(
            git(&linked, &["rev-parse", "HEAD"]),
            head,
            "{format} {pick:?}"
        );
    }
}

fn of(pick: Pick, commit: &str) -> ReplayOf {
    ReplayOf {
        kind: pick.kind(),
        commit: Oid::try_from(commit.to_owned()).unwrap(),
    }
}

fn head_of(review: &ReplayReview) -> Head {
    Head::Attached {
        reference: review.destination.reference.as_str().to_owned(),
        oid: review.destination.oid.as_str().to_owned(),
    }
}

fn touch(root: &Path, path: &str) {
    fs::File::options()
        .write(true)
        .open(root.join(path))
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60))
        .unwrap();
}

/// What a refusal must leave alone.
#[derive(Debug, PartialEq, Eq)]
struct Frozen {
    branch: Vec<u8>,
    head: Vec<u8>,
    status: String,
    files: BTreeMap<PathBuf, Vec<u8>>,
    merge_msg: bool,
}

fn files_under(dir: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }
        if path.is_dir() {
            files_under(&path, files);
        } else {
            files.insert(path.clone(), fs::read(&path).unwrap());
        }
    }
}

impl Repo {
    fn frozen(&self) -> Frozen {
        let mut files = BTreeMap::new();
        files_under(&self.root, &mut files);
        Frozen {
            branch: terminal(&self.root, &["symbolic-ref", "-q", "HEAD"]).stdout,
            head: terminal(&self.root, &["rev-parse", "-q", "--verify", "HEAD"]).stdout,
            status: self.git(&["--no-optional-locks", "status", "--porcelain", "--ignored"]),
            files,
            merge_msg: self.root.join(".git/MERGE_MSG").exists(),
        }
    }

    fn review(&self, of: &ReplayOf) -> Result<ReplayReview, RepositoryError> {
        self.coordinator().review_replay(self.path(), of)
    }

    fn start(&self, review: &ReplayReview) -> Result<Applied, RepositoryError> {
        self.coordinator().write(
            self.path(),
            &Operation::Replay {
                review: review.clone(),
            },
            &Expect {
                head: head_of(review),
            },
        )
    }

    fn logging_hook(&self, name: &str, code: u8) {
        let log = self.directory.path().join("hooks-ran");
        self.hook(
            name,
            &format!(
                "cat > /dev/null\necho {name} >> '{}'\nexit {code}\n",
                log.display()
            ),
        );
    }

    fn hooks_ran(&self) -> Vec<String> {
        let log = fs::read_to_string(self.directory.path().join("hooks-ran")).unwrap_or_default();
        let mut ran: Vec<_> = log.lines().map(str::to_owned).collect();
        ran.sort();
        ran.dedup();
        ran
    }

    /// A commit `pick` can apply, which `change` makes: on `topic` for a pick, and
    /// below HEAD for a revert. HEAD moved on from it either way.
    fn commit_to_apply(&self, pick: Pick, change: impl FnOnce(&Self), message: &str) -> String {
        if pick == Pick::CherryPick {
            self.git(&["switch", "--quiet", "-c", "topic"]);
        }
        change(self);
        let commit = self.commit_all(message);
        if pick == Pick::CherryPick {
            self.git(&["switch", "--quiet", "main"]);
        }
        self.put("u.txt", "ahead\n");
        self.commit_all("ahead");
        commit
    }

    fn adding(&self, pick: Pick, path: &str) -> String {
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(self.root.join(parent)).unwrap();
        }
        match pick {
            Pick::CherryPick => {
                self.commit_to_apply(pick, |repo| repo.put(path, "new\n"), "adds a file")
            }
            Pick::Revert => {
                self.put(path, "new\n");
                self.commit_all("has a file");
                self.commit_to_apply(
                    pick,
                    |repo| fs::remove_file(repo.root.join(path)).unwrap(),
                    "removes a file",
                )
            }
        }
    }

    fn clean(format: &str, pick: Pick) -> (Self, ReplayOf) {
        let repo = Self::new(format);
        let commit = repo.adding(pick, "n.txt");
        (repo, of(pick, &commit))
    }

    fn editing(format: &str, pick: Pick) -> (Self, ReplayOf) {
        let repo = Self::new(format);
        let commit =
            repo.commit_to_apply(pick, |repo| repo.put("f.txt", "a\nEDITED\nc\n"), "edits f");
        (repo, of(pick, &commit))
    }

    /// HEAD already holds what applying the commit would leave.
    fn empty(format: &str, pick: Pick) -> (Self, ReplayOf) {
        let repo = Self::new(format);
        let commit = match pick {
            Pick::CherryPick => {
                repo.git(&["switch", "--quiet", "-c", "topic"]);
                repo.put("n.txt", "n\n");
                let commit = repo.commit_all("adds n");
                repo.git(&["switch", "--quiet", "main"]);
                repo.put("n.txt", "n\n");
                repo.commit_all("adds n here too");
                commit
            }
            Pick::Revert => {
                repo.put("n.txt", "n\n");
                let commit = repo.commit_all("adds n");
                fs::remove_file(repo.root.join("n.txt")).unwrap();
                repo.commit_all("removes n by hand");
                commit
            }
        };
        (repo, of(pick, &commit))
    }
}

fn refuses(repo: &Repo, of: &ReplayOf, says: &str) {
    let before = repo.frozen();
    let error = repo.review(of).expect_err(says);
    assert_eq!(error.kind, ErrorKind::Conflict, "{says}: {}", error.message);
    assert!(error.message.contains(says), "{says}: {}", error.message);
    assert_eq!(repo.frozen(), before, "{says}: a refusal changes nothing");
}

/// Start re-runs the list, so a review taken before the problem does not get past it.
fn start_refuses(repo: &Repo, shown: &ReplayReview, says: &str) {
    let before = repo.frozen();
    let head = worktree_status(repo.path()).unwrap().head;
    let error = repo
        .coordinator()
        .write(
            repo.path(),
            &Operation::Replay {
                review: shown.clone(),
            },
            &Expect { head },
        )
        .expect_err(says);
    assert_eq!(error.kind, ErrorKind::Conflict, "{says}: {}", error.message);
    assert!(error.message.contains(says), "{says}: {}", error.message);
    assert_eq!(repo.frozen(), before, "{says}: a refusal changes nothing");
    assert_eq!(
        repo.history().undo,
        None,
        "{says}: a refusal records nothing"
    );
}

#[test]
fn a_review_names_the_commit_its_destination_and_what_git_would_do() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let answer = run(
            &repo.coordinator(),
            Request::ReplayReview {
                path: repo.path().to_owned(),
                of: of.clone(),
            },
        )
        .unwrap();
        let Response::ReplayReview(review) = answer else {
            panic!("{answer:?}");
        };
        let ReplayPrediction::Clean { tree } = &review.prediction else {
            panic!("{format} {pick:?}: {review:?}");
        };
        let subject = match pick {
            Pick::CherryPick => "adds a file",
            Pick::Revert => "removes a file",
        };
        assert_eq!(
            serde_json::to_value(&review).unwrap(),
            serde_json::json!({
                "root": repo.path(),
                "kind": serde_json::to_value(pick.kind()).unwrap(),
                "commit": of.commit.as_str(),
                "subject": subject,
                "destination": {"reference": "refs/heads/main", "oid": repo.oid("HEAD")},
                "prediction": {"kind": "clean", "tree": tree.as_str()},
            }),
            "{format} {pick:?}"
        );
        assert_eq!(repo.review(&of).unwrap(), review, "{format} {pick:?}");
    }
}

#[test]
fn a_review_writes_nothing_but_loose_objects() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::editing(format, pick);
        touch(&repo.root, "f.txt");
        repo.hook("post-index-change", "echo fired >> .git/index-changes\n");
        let before = repo.frozen();
        let index = fs::read(repo.root.join(".git/index")).unwrap();

        repo.review(&of).unwrap();

        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
        assert_eq!(
            fs::read(repo.root.join(".git/index")).unwrap(),
            index,
            "{format} {pick:?}: a touched file does not refresh the index"
        );
        assert!(
            !repo.root.join(".git/index-changes").exists(),
            "{format} {pick:?}: no index write runs the hook"
        );
        assert!(
            !repo.root.join(".git/l1git").exists(),
            "{format} {pick:?}: a review keeps no memo"
        );
    }
}

#[test]
fn a_review_refuses_what_version_one_does_not_do() {
    type Setup = fn(&Repo);
    let setups: [(&str, Setup); 10] = [
        ("checked-out local branch", |repo| {
            repo.git(&["switch", "--quiet", "--detach"]);
        }),
        ("checked-out local branch", |repo| {
            repo.git(&["switch", "--quiet", "--orphan", "fresh"]);
        }),
        ("A bisect is in progress", |repo| {
            repo.git(&["bisect", "start"]);
        }),
        ("staged changes: v.txt", |repo| {
            repo.put("v.txt", "staged\n");
            repo.git(&["add", "v.txt"]);
        }),
        ("index.lock", |repo| {
            repo.put(".git/index.lock", "");
        }),
        ("skip-worktree", |repo| {
            repo.git(&["update-index", "--skip-worktree", "v.txt"]);
        }),
        ("assume-unchanged", |repo| {
            repo.git(&["update-index", "--assume-unchanged", "v.txt"]);
        }),
        ("intent-to-add", |repo| {
            repo.put("later.txt", "later\n");
            repo.git(&["add", "-N", "later.txt"]);
        }),
        ("sparse checkout", |repo| {
            repo.git(&["config", "core.sparseCheckout", "true"]);
        }),
        ("pull.twohead", |repo| {
            repo.git(&["config", "pull.twohead", "ours"]);
        }),
    ];
    for (format, pick) in cases() {
        for (says, setup) in setups {
            let (repo, of) = Repo::clean(format, pick);
            let shown = repo.review(&of).unwrap();
            setup(&repo);
            refuses(&repo, &of, says);
            start_refuses(&repo, &shown, says);
        }
    }
}

#[test]
fn a_review_refuses_an_operation_in_progress() {
    let elsewhere = |repo: &Repo| {
        repo.git(&["switch", "--quiet", "-c", "elsewhere"]);
        repo.put("w.txt", "w\n");
        let commit = repo.commit_all("elsewhere");
        repo.git(&["switch", "--quiet", "main"]);
        of(Pick::CherryPick, &commit)
    };
    for format in FORMATS {
        for pick in PICKS {
            let repo = Repo::new(format);
            let of = elsewhere(&repo);
            let shown = repo.review(&of).unwrap();
            stop(&repo.root, pick);
            refuses(&repo, &of, "is in progress");
            start_refuses(&repo, &shown, "has refs/heads/main as its destination");
        }

        let repo = Repo::new(format);
        let of = elsewhere(&repo);
        let shown = repo.review(&of).unwrap();
        conflicting(&repo.root, Pick::CherryPick);
        repo.fails(&["merge", "--no-edit", "topic"]);
        refuses(&repo, &of, "A merge is in progress");
        start_refuses(&repo, &shown, "A merge is in progress");

        let repo = Repo::new(format);
        let of = elsewhere(&repo);
        let shown = repo.review(&of).unwrap();
        conflicting(&repo.root, Pick::CherryPick);
        repo.git(&["switch", "--quiet", "topic"]);
        repo.fails(&["rebase", "main"]);
        refuses(&repo, &of, "A rebase is in progress");
        start_refuses(&repo, &shown, "A rebase is in progress");
    }
}

#[test]
fn a_review_refuses_an_active_merge_session() {
    for format in FORMATS {
        let repo = Repo::new(format);
        let commit = repo.adding(Pick::CherryPick, "n.txt");
        repo.git(&["switch", "--quiet", "-c", "source", "HEAD^"]);
        repo.put("u.txt", "source\n");
        repo.commit_all("source");
        repo.git(&["switch", "--quiet", "main"]);
        let coordinator = repo.coordinator();
        let review = coordinator
            .review_merge(
                repo.path(),
                &MergeSelection::Branch {
                    reference: "refs/heads/source".to_owned(),
                },
            )
            .unwrap();
        let picked = of(Pick::CherryPick, &commit);
        let shown = repo.review(&picked).unwrap();
        coordinator
            .merge(repo.path(), &MergeAction::Start { review })
            .unwrap();
        refuses(&repo, &picked, "Finish or resolve the current merge");
        start_refuses(&repo, &shown, "destination of an unfinished merge");
    }
}

#[test]
fn a_review_refuses_an_unmerged_path_no_operation_holds() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        repo.put("v.txt", "stashed\n");
        repo.git(&["stash", "push", "--quiet"]);
        repo.put("v.txt", "committed\n");
        repo.commit_all("v");
        repo.fails(&["stash", "pop"]);
        refuses(&repo, &of, "staged changes: v.txt");
    }
}

#[test]
fn a_review_refuses_what_is_not_a_commit() {
    for (format, pick) in cases() {
        let (repo, _) = Repo::clean(format, pick);
        repo.git(&["tag", "-a", "-m", "annotated", "v1"]);
        for oid in [
            repo.oid("HEAD:f.txt"),
            repo.oid("HEAD^{tree}"),
            repo.oid("v1"),
            "1".repeat(40),
        ] {
            let before = repo.frozen();
            let error = repo.review(&of(pick, &oid)).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidOid, "{}", error.message);
            assert_eq!(repo.frozen(), before, "{format} {pick:?}");
        }
    }
}

#[test]
fn a_review_refuses_a_merge_commit() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "side"]);
        repo.put("u.txt", "side\n");
        repo.commit_all("side");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("v.txt", "main\n");
        repo.commit_all("main");
        repo.git(&["merge", "--quiet", "--no-ff", "--no-edit", "side"]);
        let merged = repo.oid("HEAD");
        if pick == Pick::CherryPick {
            repo.git(&["branch", "kept"]);
            repo.git(&["reset", "--quiet", "--hard", "HEAD^"]);
        }
        refuses(&repo, &of(pick, &merged), "is a merge commit");
    }
}

#[test]
fn a_review_refuses_a_pick_already_on_the_branch_and_a_revert_not_on_it() {
    for format in FORMATS {
        let repo = Repo::new(format);
        let below = repo.oid("HEAD");
        repo.put("u.txt", "more\n");
        repo.commit_all("more");
        refuses(&repo, &of(Pick::CherryPick, &below), "already on main");
        refuses(
            &repo,
            &of(Pick::CherryPick, &repo.oid("HEAD")),
            "already on main",
        );
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("n.txt", "n\n");
        let elsewhere = repo.commit_all("elsewhere");
        repo.git(&["switch", "--quiet", "main"]);
        refuses(&repo, &of(Pick::Revert, &elsewhere), "is not on main");
    }
}

#[test]
fn a_review_refuses_an_unstaged_edit_it_would_change_and_passes_any_other() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::editing(format, pick);
        repo.put("v.txt", "unrelated\n");
        assert!(
            matches!(
                repo.review(&of).unwrap().prediction,
                ReplayPrediction::Clean { .. }
            ),
            "{format} {pick:?}"
        );
        let shown = repo.review(&of).unwrap();
        repo.put("f.txt", "a\nUNSTAGED\nc\n");
        refuses(&repo, &of, "unstaged edits, and");
        start_refuses(&repo, &shown, "unstaged edits, and");
        let error = repo.review(&of).unwrap_err();
        assert!(error.message.contains("f.txt"), "{}", error.message);
        assert!(!error.message.contains("v.txt"), "{}", error.message);

        fs::remove_file(repo.root.join("f.txt")).unwrap();
        refuses(&repo, &of, "unstaged edits, and");

        repo.git(&["restore", "f.txt"]);
        touch(&repo.root, "f.txt");
        repo.review(&of).expect("a touched file has no edits");
    }
}

#[test]
fn a_review_refuses_an_untracked_or_ignored_file_at_a_path_the_result_adds() {
    let excluded = |repo: &Repo, pattern: &str| {
        repo.put(".git/info/exclude", &format!("{pattern}\n"));
    };
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        repo.put("n.txt", "mine\n");
        refuses(&repo, &of, "files first");
        excluded(&repo, "n.txt");
        refuses(&repo, &of, "n.txt");
        assert_eq!(repo.read("n.txt"), "mine\n", "{format} {pick:?}");

        let (repo, of) = Repo::clean(format, pick);
        fs::create_dir(repo.root.join("n.txt")).unwrap();
        repo.put("n.txt/inside", "mine\n");
        excluded(&repo, "n.txt/");
        refuses(&repo, &of, "n.txt/inside");

        let repo = Repo::new(format);
        let commit = repo.adding(pick, "d/n.txt");
        fs::remove_dir(repo.root.join("d")).unwrap_or(());
        repo.put("d", "mine\n");
        excluded(&repo, "d");
        refuses(
            &repo,
            &self::of(pick, &commit),
            "untracked or ignored files",
        );
    }
}

#[test]
fn a_review_refuses_an_ignored_file_at_a_conflicted_path_head_does_not_track() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("v.txt", "theirs\n");
        let commit = repo.commit_all("edits v");
        repo.git(&["switch", "--quiet", "main"]);
        repo.git(&["rm", "--quiet", "v.txt"]);
        repo.git(&["commit", "--quiet", "-m", "removes v"]);
        let of = of(Pick::CherryPick, &commit);
        assert_eq!(
            repo.review(&of).unwrap().prediction,
            ReplayPrediction::Conflict {
                paths: vec!["v.txt".to_owned()]
            },
            "{format}"
        );
        repo.put(".git/info/exclude", "v.txt\n");
        repo.put("v.txt", "mine\n");
        refuses(&repo, &of, "v.txt");
        assert_eq!(repo.read("v.txt"), "mine\n", "{format}");
    }
}

#[test]
fn a_review_refuses_a_commit_merge_tree_cannot_read() {
    for format in FORMATS {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        repo.put("f.txt", "a\nTHEIRS\nc\n");
        let commit = repo.commit_all("theirs");
        repo.git(&["switch", "--quiet", "main"]);
        repo.put("f.txt", "a\nOURS\nc\n");
        repo.commit_all("ours");
        let blob = repo.oid(&format!("{commit}^:f.txt"));
        fs::remove_file(
            repo.root
                .join(".git/objects")
                .join(&blob[..2])
                .join(&blob[2..]),
        )
        .unwrap();
        refuses(
            &repo,
            &of(Pick::CherryPick, &commit),
            "cannot work out what a cherry-pick would change",
        );
    }
}

#[test]
fn a_review_says_when_the_result_would_be_empty() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::empty(format, pick);
        let before = repo.frozen();
        assert_eq!(
            repo.review(&of).unwrap().prediction,
            ReplayPrediction::Empty,
            "{format} {pick:?}"
        );
        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
    }
}

#[test]
fn a_clean_result_is_the_commit_git_makes_with_undo_and_redo() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        repo.git(&["config", "user.name", "Applier"]);
        let before = repo.oid("HEAD");
        let review = repo.review(&of).unwrap();
        let ReplayPrediction::Clean { tree } = review.prediction.clone() else {
            panic!("{format} {pick:?}: {review:?}");
        };
        let original = repo.git(&["log", "-1", "--format=%ad", of.commit.as_str()]);

        let applied = repo.start(&review).unwrap();

        assert_eq!(repo.oid("HEAD^"), before, "{format} {pick:?}");
        assert_eq!(repo.oid("HEAD^{tree}"), tree.as_str(), "{format} {pick:?}");
        assert_eq!(repo.read("n.txt"), "new\n", "{format} {pick:?}");
        let made = repo.oid("HEAD");
        let message = repo.git(&["log", "-1", "--format=%B"]);
        let (author, message_is, reflog) = match pick {
            Pick::CherryPick => (
                "Ada",
                "adds a file\n\n".to_owned(),
                "cherry-pick: adds a file",
            ),
            Pick::Revert => (
                "Applier",
                format!(
                    "Revert \"removes a file\"\n\nThis reverts commit {}.\n\n",
                    of.commit.as_str()
                ),
                "revert: Revert \"removes a file\"",
            ),
        };
        assert_eq!(message, message_is, "{format} {pick:?}");
        assert_eq!(
            repo.git(&["log", "-1", "--format=%an"]).trim(),
            author,
            "{format} {pick:?}"
        );
        assert_eq!(
            repo.git(&["log", "-1", "--format=%cn"]).trim(),
            "Applier",
            "{format} {pick:?}"
        );
        if pick == Pick::CherryPick {
            assert_eq!(
                repo.git(&["log", "-1", "--format=%ad"]),
                original,
                "{format}: the author date stays"
            );
        }
        assert_eq!(
            repo.git(&["log", "-1", "--walk-reflogs", "--format=%gs"])
                .trim(),
            reflog,
            "{format} {pick:?}"
        );
        assert_eq!(repo.state(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
        assert!(!repo.root.join(".git/MERGE_MSG").exists());
        assert_eq!(repo.history().undo.as_ref(), Some(&applied));
        assert!(
            matches!(&applied.operation, Operation::Replay { review: recorded } if *recorded == review)
        );

        repo.undo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), before, "{format} {pick:?}");
        assert!(!repo.root.join("n.txt").exists(), "{format} {pick:?}");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
        assert_eq!(repo.history().redo.as_ref(), Some(&applied));

        repo.redo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert_eq!(repo.read("n.txt"), "new\n", "{format} {pick:?}");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

#[test]
fn a_clean_result_runs_the_hooks_git_runs_for_one() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let review = repo.review(&of).unwrap();
        repo.logging_hook("pre-commit", 1);
        repo.logging_hook("commit-msg", 1);
        repo.logging_hook("prepare-commit-msg", 0);
        repo.logging_hook("post-commit", 3);
        repo.logging_hook("reference-transaction", 0);
        repo.logging_hook("post-index-change", 0);

        let applied = repo.start(&review).unwrap();

        assert_eq!(
            repo.hooks_ran(),
            [
                "post-commit",
                "post-index-change",
                "prepare-commit-msg",
                "reference-transaction",
            ],
            "{format} {pick:?}"
        );
        repo.no_hooks();
        assert_eq!(repo.history().undo.as_ref(), Some(&applied));
    }
}

#[test]
fn a_content_merge_printed_before_the_summary_still_proves_the_commit() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let commit = match pick {
            Pick::CherryPick => {
                repo.git(&["switch", "--quiet", "-c", "topic"]);
                repo.put("f.txt", "a\nb\nc\nd\n");
                let commit = repo.commit_all("adds a line");
                repo.git(&["switch", "--quiet", "main"]);
                repo.put("f.txt", "A\nb\nc\n");
                repo.commit_all("edits the top");
                commit
            }
            Pick::Revert => {
                repo.put("f.txt", "a\nb\nc\nd\n");
                let commit = repo.commit_all("adds a line");
                repo.put("f.txt", "A\nb\nc\nd\n");
                repo.commit_all("edits the top");
                commit
            }
        };
        let before = repo.oid("HEAD");
        let review = repo.review(&of(pick, &commit)).unwrap();
        let applied = repo.start(&review).unwrap();
        assert_eq!(repo.oid("HEAD^"), before, "{format} {pick:?}");
        assert_eq!(repo.history().undo.as_ref(), Some(&applied));
        repo.undo(&applied).unwrap();

        let terminal = terminal(&repo.root, &[pick.start(), &[commit.as_str()]].concat());
        let printed = String::from_utf8(terminal.stdout).unwrap();
        assert!(
            printed.starts_with("Auto-merging f.txt\n[main "),
            "{format} {pick:?}: {printed}"
        );
    }
}

#[test]
fn a_repeated_start_answers_the_same_entry_and_runs_nothing() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let review = repo.review(&of).unwrap();
        let applied = repo.start(&review).unwrap();
        let made = repo.oid("HEAD");
        repo.logging_hook("reference-transaction", 0);

        assert_eq!(repo.start(&review).unwrap(), applied, "{format} {pick:?}");

        assert_eq!(repo.hooks_ran(), Vec::<String>::new(), "{format} {pick:?}");
        repo.no_hooks();
        assert_eq!(repo.oid("HEAD"), made, "{format} {pick:?}");
        assert_eq!(repo.history().undo.as_ref(), Some(&applied));

        repo.undo(&applied).unwrap();
        let again = repo.start(&review).unwrap();
        assert_ne!(again.id, applied.id, "{format} {pick:?}: it was undone");
        assert_eq!(
            repo.oid("HEAD^"),
            review.destination.oid.as_str(),
            "{format} {pick:?}"
        );
    }
}

#[test]
fn a_destination_that_moved_after_the_review_is_stale() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let shown = repo.review(&of).unwrap();
        repo.put("v.txt", "moved\n");
        repo.commit_all("moved");
        let before = repo.frozen();
        let head_moved = ErrorKind::StaleView {
            reason: StaleReason::HeadMoved,
        };

        let as_seen = repo.start(&shown).unwrap_err();
        assert_eq!(as_seen.kind, head_moved, "{}", as_seen.message);

        let current = worktree_status(repo.path()).unwrap().head;
        let reviewed_earlier = repo
            .coordinator()
            .write(
                repo.path(),
                &Operation::Replay {
                    review: shown.clone(),
                },
                &Expect { head: current },
            )
            .unwrap_err();
        assert_eq!(
            reviewed_earlier.kind, head_moved,
            "{}",
            reviewed_earlier.message
        );
        assert!(
            reviewed_earlier.message.contains("Review it again"),
            "{}",
            reviewed_earlier.message
        );
        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
    }
}

#[test]
fn a_fresh_review_with_an_older_head_is_stale() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let older = worktree_status(repo.path()).unwrap().head;
        repo.put("v.txt", "moved\n");
        repo.commit_all("moved");
        let review = repo.review(&of).unwrap();
        let before = repo.frozen();
        let error = repo
            .coordinator()
            .write(
                repo.path(),
                &Operation::Replay { review },
                &Expect { head: older },
            )
            .unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::StaleView {
                reason: StaleReason::HeadMoved
            },
            "{format} {pick:?}: {}",
            error.message
        );
        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
    }
}

#[test]
fn a_review_that_differs_in_any_field_is_stale() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let review = repo.review(&of).unwrap();
        let before = repo.frozen();
        let mut other_subject = review.clone();
        other_subject.subject = "something else".to_owned();
        let mut other_prediction = review.clone();
        other_prediction.prediction = ReplayPrediction::Conflict {
            paths: vec!["n.txt".to_owned()],
        };
        for shown in [other_subject, other_prediction] {
            let error = repo.start(&shown).unwrap_err();
            assert_eq!(
                error.kind,
                ErrorKind::StaleView {
                    reason: StaleReason::HeadMoved
                },
                "{}",
                error.message
            );
        }
        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
    }
}

#[test]
fn start_refuses_an_empty_result_and_changes_nothing() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::empty(format, pick);
        let review = repo.review(&of).unwrap();
        let before = repo.frozen();
        let error = repo.start(&review).unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnchangedPath, "{}", error.message);
        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
    }
}

#[test]
fn start_refuses_an_ignored_file_that_appeared_after_the_review_and_keeps_its_bytes() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let shown = repo.review(&of).unwrap();
        repo.put(".git/info/exclude", "n.txt\n");
        repo.put("n.txt", "precious\n");
        start_refuses(&repo, &shown, "untracked or ignored files");
        assert_eq!(repo.read("n.txt"), "precious\n", "{format} {pick:?}");
    }
}

#[test]
fn an_unrelated_unstaged_edit_survives_a_clean_result_and_its_undo() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        let before = repo.oid("HEAD");
        repo.put("v.txt", "unrelated\n");
        let review = repo.review(&of).unwrap();
        let applied = repo.start(&review).unwrap();
        assert_eq!(repo.read("v.txt"), "unrelated\n", "{format} {pick:?}");
        assert_eq!(repo.status(), " M v.txt\n", "{format} {pick:?}");

        repo.undo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), before, "{format} {pick:?}");
        assert_eq!(repo.read("v.txt"), "unrelated\n", "{format} {pick:?}");
        assert_eq!(repo.status(), " M v.txt\n", "{format} {pick:?}");

        repo.redo(&applied).unwrap();
        assert_eq!(repo.read("v.txt"), "unrelated\n", "{format} {pick:?}");
        assert_eq!(repo.status(), " M v.txt\n", "{format} {pick:?}");
    }
}

#[test]
fn a_file_touched_with_no_edits_does_not_stop_a_start() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::editing(format, pick);
        touch(&repo.root, "f.txt");
        let review = repo.review(&of).unwrap();
        let applied = repo.start(&review).unwrap();
        assert_eq!(repo.history().undo.as_ref(), Some(&applied));
        assert_eq!(repo.status(), "", "{format} {pick:?}");
    }
}

#[test]
fn a_linked_worktree_starts_on_its_own_branch() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let commit = repo.adding(pick, "n.txt");
        let main = repo.oid("HEAD");
        let linked = repo.linked("linked", "busy");
        let path = linked.to_str().unwrap();
        let coordinator = repo.coordinator();
        let review = coordinator.review_replay(path, &of(pick, &commit)).unwrap();
        assert_eq!(review.root, path, "{format} {pick:?}");
        assert_eq!(
            review.destination.reference.as_str(),
            "refs/heads/busy",
            "{format} {pick:?}"
        );

        let applied = coordinator
            .write(
                path,
                &Operation::Replay {
                    review: review.clone(),
                },
                &Expect {
                    head: head_of(&review),
                },
            )
            .unwrap();

        assert_eq!(applied.root, path, "{format} {pick:?}");
        assert_eq!(repo.oid("refs/heads/busy^"), main, "{format} {pick:?}");
        assert_eq!(repo.oid("HEAD"), main, "{format} {pick:?}: main stays");
        assert_eq!(repo.status(), "", "{format} {pick:?}");

        coordinator.undo(repo.path(), applied.id).unwrap();
        assert_eq!(repo.oid("refs/heads/busy"), main, "{format} {pick:?}");
        assert_eq!(git(&linked, &["status", "--porcelain"]), "");
    }
}

#[test]
fn an_unfinished_operation_on_the_branch_in_another_worktree_stops_a_start() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "elsewhere"]);
        repo.put("w.txt", "w\n");
        let commit = repo.commit_all("elsewhere");
        repo.git(&["switch", "--quiet", "main"]);
        let linked = repo.root.parent().unwrap().join("second");
        let path = linked.to_str().unwrap();
        repo.git(&["worktree", "add", "--quiet", "--force", path, "main"]);
        let coordinator = repo.coordinator();
        let shown = coordinator
            .review_replay(path, &of(Pick::CherryPick, &commit))
            .unwrap();
        let applying = conflicting_on_main(&repo, pick);
        repo.fails(&[pick.start(), &[applying.as_str()]].concat());
        let head = worktree_status(path).unwrap().head;
        let error = refused(coordinator.write(
            path,
            &Operation::Replay { review: shown },
            &Expect { head },
        ));
        assert!(
            error.message.contains("refs/heads/main") && error.message.contains(repo.path()),
            "{format} {pick:?}: {}",
            error.message
        );
    }
    for format in FORMATS {
        let repo = Repo::new(format);
        let commit = repo.adding(Pick::CherryPick, "n.txt");
        repo.git(&["switch", "--quiet", "-c", "source", "HEAD^"]);
        repo.put("v.txt", "source\n");
        repo.commit_all("source");
        repo.git(&["switch", "--quiet", "main"]);
        let linked = repo.root.parent().unwrap().join("second");
        let path = linked.to_str().unwrap();
        repo.git(&["worktree", "add", "--quiet", "--force", path, "main"]);
        let coordinator = repo.coordinator();
        let shown = coordinator
            .review_replay(path, &of(Pick::CherryPick, &commit))
            .unwrap();
        let merge = coordinator
            .review_merge(
                repo.path(),
                &MergeSelection::Branch {
                    reference: "refs/heads/source".to_owned(),
                },
            )
            .unwrap();
        coordinator
            .merge(repo.path(), &MergeAction::Start { review: merge })
            .unwrap();
        let head = worktree_status(path).unwrap().head;
        let error = refused(coordinator.write(
            path,
            &Operation::Replay { review: shown },
            &Expect { head },
        ));
        assert!(
            error.message.contains("destination of an unfinished merge"),
            "{format}: {}",
            error.message
        );
    }
}

/// As `conflicting`, for a repository whose `main` another worktree also holds, so
/// it never leaves `main`.
fn conflicting_on_main(repo: &Repo, pick: Pick) -> String {
    match pick {
        Pick::CherryPick => {
            let before = repo.oid("HEAD");
            repo.put("f.txt", "a\nTHEIRS\nc\n");
            let theirs = repo.commit_all("theirs");
            repo.git(&["reset", "--quiet", "--hard", &before]);
            repo.git(&["branch", "kept-theirs", &theirs]);
            repo.put("f.txt", "a\nOURS\nc\n");
            repo.commit_all("ours");
            theirs
        }
        Pick::Revert => {
            repo.put("f.txt", "a\nTHEIRS\nc\n");
            let commit = repo.commit_all("theirs");
            repo.put("f.txt", "a\nOURS\nc\n");
            repo.commit_all("ours");
            commit
        }
    }
}

#[test]
fn start_refuses_while_a_replay_holds_a_detached_head() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        repo.git(&["switch", "--quiet", "-c", "elsewhere"]);
        repo.put("w.txt", "w\n");
        let commit = repo.commit_all("elsewhere");
        repo.git(&["switch", "--quiet", "main"]);
        let shown = repo.review(&of(Pick::CherryPick, &commit)).unwrap();
        let applying = conflicting(&repo.root, pick);
        repo.git(&["switch", "--quiet", "--detach"]);
        repo.fails(&[pick.start(), &[applying.as_str()]].concat());
        start_refuses(&repo, &shown, "Only resolution and index edits");
    }
}

#[test]
fn a_branch_named_like_a_marker_does_not_read_as_a_replay_in_progress() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        repo.git(&["branch", "CHERRY_PICK_HEAD"]);
        repo.git(&["branch", "REVERT_HEAD"]);
        repo.git(&["tag", "CHERRY_PICK_HEAD"]);
        let kept = repo.oid("refs/heads/CHERRY_PICK_HEAD");
        let review = repo.review(&of).unwrap();
        let applied = repo.start(&review).unwrap();
        assert_eq!(repo.state(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.oid("refs/heads/CHERRY_PICK_HEAD"), kept);
        assert_eq!(repo.oid("refs/heads/REVERT_HEAD"), kept);
        repo.undo(&applied).unwrap();
        assert_eq!(repo.oid("HEAD"), kept, "{format} {pick:?}");
    }
}

/// Applies the commit and compares the prediction with what Git did. Start refuses
/// an empty prediction, so a terminal applies that one.
fn prediction_holds(label: &str, kind: &str, repo: &Repo, pick: Pick, commit: &str) {
    let of = of(pick, commit);
    let review = repo.review(&of).unwrap();
    assert_eq!(
        serde_json::to_value(&review.prediction).unwrap()["kind"],
        kind,
        "{label}: {review:?}"
    );
    let before = repo.oid("HEAD");
    match &review.prediction {
        ReplayPrediction::Clean { tree } => {
            repo.start(&review).unwrap();
            assert_eq!(repo.oid("HEAD^"), before, "{label}");
            assert_eq!(repo.oid("HEAD^{tree}"), tree.as_str(), "{label}");
        }
        ReplayPrediction::Conflict { paths } => {
            let error = repo.start(&review).unwrap_err();
            assert_eq!(
                error.kind,
                ErrorKind::ReplayStopped {
                    output: String::new()
                },
                "{label}: {}",
                error.message
            );
            assert_eq!(repo.oid("HEAD"), before, "{label}");
            assert_eq!(repo.progress().unresolved, *paths, "{label}");
        }
        ReplayPrediction::Empty => {
            repo.fails(&[pick.start(), &[commit]].concat());
            assert_eq!(repo.oid("HEAD"), before, "{label}");
            assert_eq!(repo.status(), "", "{label}: a real run staged nothing");
        }
    }
}

/// On `topic` for a pick and below HEAD for a revert, so `head_change` makes HEAD
/// differ from what the commit's change was made against.
fn applying_after(
    repo: &Repo,
    pick: Pick,
    change: impl FnOnce(&Repo),
    head_change: impl FnOnce(&Repo),
) -> String {
    if pick == Pick::CherryPick {
        repo.git(&["switch", "--quiet", "-c", "topic"]);
    }
    change(repo);
    let commit = repo.commit_all("the commit");
    if pick == Pick::CherryPick {
        repo.git(&["switch", "--quiet", "main"]);
    }
    head_change(repo);
    repo.commit_all("head moves on");
    commit
}

#[test]
fn a_prediction_matches_what_git_does_when_clean_or_conflicted_or_empty() {
    for (format, pick) in cases() {
        let label = format!("{format} {pick:?}");
        let (repo, of) = Repo::clean(format, pick);
        prediction_holds(
            &format!("{label} clean"),
            "clean",
            &repo,
            pick,
            of.commit.as_str(),
        );

        let repo = Repo::new(format);
        let commit = conflicting(&repo.root, pick);
        prediction_holds(
            &format!("{label} conflict"),
            "conflict",
            &repo,
            pick,
            &commit,
        );

        let (repo, of) = Repo::empty(format, pick);
        prediction_holds(
            &format!("{label} empty"),
            "empty",
            &repo,
            pick,
            of.commit.as_str(),
        );
    }
}

#[test]
fn a_prediction_matches_what_git_does_through_a_rename() {
    for (format, pick) in cases() {
        let label = format!("{format} {pick:?} rename");
        let repo = Repo::new(format);
        repo.put("r.txt", &numbered("3"));
        repo.commit_all("adds r");
        let commit = applying_after(
            &repo,
            pick,
            |repo| repo.put("r.txt", &numbered("THEIRS")),
            |repo| {
                repo.git(&["mv", "r.txt", "s.txt"]);
            },
        );
        prediction_holds(&label, "clean", &repo, pick, &commit);
        assert!(repo.root.join("s.txt").exists(), "{label}");
        assert!(!repo.root.join("r.txt").exists(), "{label}");

        let repo = Repo::new(format);
        repo.put("r.txt", &numbered("3"));
        repo.commit_all("adds r");
        let commit = applying_after(
            &repo,
            pick,
            |repo| repo.put("r.txt", &numbered("THEIRS")),
            |repo| {
                repo.git(&["mv", "r.txt", "s.txt"]);
                repo.put("s.txt", &numbered("OURS"));
            },
        );
        prediction_holds(
            &format!("{label} conflict"),
            "conflict",
            &repo,
            pick,
            &commit,
        );
        assert_eq!(repo.progress().unresolved, ["s.txt"], "{label}");
    }
}

#[test]
fn a_prediction_matches_what_git_does_through_a_modify_delete() {
    for (format, pick) in cases() {
        let label = format!("{format} {pick:?} modify/delete");
        let repo = Repo::new(format);
        let commit = applying_after(
            &repo,
            pick,
            |repo| repo.put("u.txt", "theirs\n"),
            |repo| {
                repo.git(&["rm", "--quiet", "u.txt"]);
            },
        );
        prediction_holds(&label, "conflict", &repo, pick, &commit);
        assert_eq!(repo.progress().unresolved, ["u.txt"], "{label}");

        let repo = Repo::new(format);
        let commit = applying_after(
            &repo,
            pick,
            |repo| {
                repo.git(&["rm", "--quiet", "u.txt"]);
            },
            |repo| repo.put("u.txt", "ours\n"),
        );
        prediction_holds(
            &format!("{label} reversed"),
            "conflict",
            &repo,
            pick,
            &commit,
        );
        assert_eq!(repo.progress().unresolved, ["u.txt"], "{label}");
    }
}

#[test]
fn a_prediction_matches_what_git_does_for_a_root_commit() {
    for format in FORMATS {
        for objects in ["sha1", "sha256"] {
            let label = format!("{format} {objects} root");
            let repo = Repo::with_objects(format, objects);
            repo.git(&["switch", "--quiet", "--orphan", "other"]);
            repo.put("o.txt", "root\n");
            let root = repo.commit_all("root");
            repo.git(&["switch", "--quiet", "main"]);
            prediction_holds(&label, "clean", &repo, Pick::CherryPick, &root);

            let repo = Repo::with_objects(format, objects);
            repo.git(&["switch", "--quiet", "--orphan", "other"]);
            repo.put("f.txt", "root\n");
            let root = repo.commit_all("root");
            repo.git(&["switch", "--quiet", "main"]);
            prediction_holds(
                &format!("{label} conflict"),
                "conflict",
                &repo,
                Pick::CherryPick,
                &root,
            );

            let repo = Repo::with_objects(format, objects);
            let root = repo.oid("HEAD");
            repo.put("n.txt", "n\n");
            repo.commit_all("more");
            prediction_holds(
                &format!("{label} revert"),
                "clean",
                &repo,
                Pick::Revert,
                &root,
            );
            assert!(!repo.root.join("f.txt").exists(), "{label}");
            assert!(repo.root.join("n.txt").exists(), "{label}");

            let repo = Repo::with_objects(format, objects);
            let root = repo.oid("HEAD");
            repo.put("u.txt", "ours\n");
            repo.commit_all("changes u");
            prediction_holds(
                &format!("{label} revert conflict"),
                "conflict",
                &repo,
                Pick::Revert,
                &root,
            );
        }
    }
}

#[test]
fn a_conflict_stops_with_no_output_and_reads_as_a_replay_in_progress() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let commit = conflicting(&repo.root, pick);
        let before = repo.oid("HEAD");
        repo.put("v.txt", "unrelated\n");
        let review = repo.review(&of(pick, &commit)).unwrap();
        assert_eq!(
            review.prediction,
            ReplayPrediction::Conflict {
                paths: vec!["f.txt".to_owned()]
            },
            "{format} {pick:?}"
        );

        let error = repo.start(&review).unwrap_err();

        assert_eq!(
            error.kind,
            ErrorKind::ReplayStopped {
                output: String::new()
            },
            "{format} {pick:?}: {}",
            error.message
        );
        assert_eq!(repo.oid("HEAD"), before, "{format} {pick:?}");
        assert!(repo.has_marker(pick), "{format} {pick:?}");
        let progress = repo.progress();
        assert_eq!(progress.unresolved, ["f.txt"], "{format} {pick:?}");
        assert_eq!(progress.commit.as_str(), commit, "{format} {pick:?}");
        assert_eq!(repo.read("v.txt"), "unrelated\n", "{format} {pick:?}");
        refused(repo.start(&review));

        repo.resolve();
        let finished = repo.finish("Finished\n").unwrap();
        assert_eq!(repo.oid("HEAD^"), before, "{format} {pick:?}");
        assert_eq!(repo.undo_id(), Some(finished.id), "{format} {pick:?}");
        assert_eq!(repo.read("v.txt"), "unrelated\n", "{format} {pick:?}");

        let repo = Repo::new(format);
        let commit = conflicting(&repo.root, pick);
        let review = repo.review(&of(pick, &commit)).unwrap();
        let shown = repo.frozen();
        repo.start(&review).unwrap_err();
        assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.frozen(), shown, "{format} {pick:?}");
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
    }
}

fn failing_gpg(repo: &Repo) {
    let program = repo.directory.path().join("failing-gpg");
    fs::write(&program, "#!/bin/sh\necho signing-said-no >&2\nexit 1\n").unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "gpg.program", program.to_str().unwrap()]);
    repo.git(&["config", "commit.gpgSign", "true"]);
}

/// The two ways Git stops a clean result before it commits, and what each printed.
fn stop_before_commit(repo: &Repo, how: &str) -> &'static str {
    match how {
        "hook" => {
            repo.hook("prepare-commit-msg", "echo hook-said-no >&2\nexit 1\n");
            "hook-said-no"
        }
        _ => {
            failing_gpg(repo);
            "gpg failed to sign"
        }
    }
}

fn let_commits_through(repo: &Repo) {
    repo.no_hooks();
    repo.git(&["config", "commit.gpgSign", "false"]);
}

#[test]
fn a_hook_or_signing_stop_keeps_the_result_staged_and_finish_commits_it() {
    for (format, pick) in cases() {
        for how in ["hook", "signing"] {
            let label = format!("{format} {pick:?} {how}");
            let (repo, of) = Repo::clean(format, pick);
            repo.git(&["config", "user.name", "Applier"]);
            let before = repo.oid("HEAD");
            let review = repo.review(&of).unwrap();
            let ReplayPrediction::Clean { tree } = review.prediction.clone() else {
                panic!("{label}: {review:?}");
            };
            let says = stop_before_commit(&repo, how);

            let error = repo.start(&review).unwrap_err();

            let ErrorKind::ReplayStopped { output } = &error.kind else {
                panic!("{label}: {error:?}");
            };
            assert!(output.contains(says), "{label}: {output}");
            let_commits_through(&repo);
            assert_eq!(repo.oid("HEAD"), before, "{label}");
            assert_eq!(repo.status(), "A  n.txt\n", "{label}");
            assert!(repo.has_marker(pick), "{label}");

            let progress = repo.progress();
            assert_eq!(progress.of(), of, "{label}");
            assert_eq!(progress.unresolved, Vec::<String>::new(), "{label}");
            assert_eq!(progress.tree.as_ref(), Some(&tree), "{label}");
            assert!(!progress.empty, "{label}");

            let finished = repo
                .finish_as_shown(&progress, &progress.suggested_message)
                .unwrap();
            assert_eq!(repo.oid("HEAD^"), before, "{label}");
            assert_eq!(repo.oid("HEAD^{tree}"), tree.as_str(), "{label}");
            assert_eq!(
                repo.git(&["log", "-1", "--format=%an"]).trim(),
                match pick {
                    Pick::CherryPick => "Ada",
                    Pick::Revert => "Applier",
                },
                "{label}"
            );
            assert!(!repo.has_marker(pick), "{label}");
            assert_eq!(repo.state(), MergeState::Idle, "{label}");
            assert_eq!(repo.undo_id(), Some(finished.id), "{label}");
            repo.undo(&finished).unwrap();
            assert_eq!(repo.oid("HEAD"), before, "{label}");
        }
    }
}

#[test]
fn a_hook_or_signing_stop_is_undone_by_abort() {
    for (format, pick) in cases() {
        for how in ["hook", "signing"] {
            let label = format!("{format} {pick:?} {how}");
            let (repo, of) = Repo::clean(format, pick);
            let review = repo.review(&of).unwrap();
            let shown = repo.frozen();
            stop_before_commit(&repo, how);
            repo.start(&review).unwrap_err();
            let_commits_through(&repo);

            assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{label}");

            assert!(!repo.has_marker(pick), "{label}");
            assert_eq!(repo.frozen(), shown, "{label}");
            assert_eq!(repo.history().undo, None, "{label}");
        }
    }
}

#[test]
fn a_clean_revert_a_hook_refuses_the_marker_for_stays_staged_and_says_so() {
    for format in FORMATS {
        let (repo, of) = Repo::clean(format, Pick::Revert);
        let before = repo.oid("HEAD");
        let review = repo.review(&of).unwrap();
        repo.hook("prepare-commit-msg", "exit 1\n");
        repo.hook(
            "reference-transaction",
            "[ \"$1\" = prepared ] || { cat > /dev/null; exit 0; }\n! grep -q REVERT_HEAD\n",
        );

        let error = repo.start(&review).unwrap_err();

        assert_eq!(
            error.kind,
            ErrorKind::GitFailed,
            "{format}: {}",
            error.message
        );
        assert!(error.message.contains("stays staged"), "{}", error.message);
        repo.no_hooks();
        assert!(!repo.has_marker(Pick::Revert), "{format}");
        assert_eq!(repo.oid("HEAD"), before, "{format}");
        assert_eq!(repo.status(), "A  n.txt\n", "{format}");
        assert_eq!(repo.state(), MergeState::Idle, "{format}");
        assert_eq!(repo.history().undo, None, "{format}");
    }
}

fn conflicting_in_f_only(format: &str, pick: Pick) -> (Repo, ReplayOf) {
    let repo = Repo::new(format);
    let commit = applying_after(
        &repo,
        pick,
        |repo| repo.put("f.txt", "a\nTHEIRS\nc\n"),
        |repo| repo.put("f.txt", "a\nOURS\nc\n"),
    );
    (repo, of(pick, &commit))
}

/// Records `resolution` for the conflict, so the real run stages it again.
fn remembering(repo: &Repo, pick: Pick, of: &ReplayOf, resolution: &str) {
    repo.git(&["config", "rerere.enabled", "true"]);
    repo.git(&["config", "rerere.autoUpdate", "true"]);
    repo.fails(&[pick.start(), &[of.commit.as_str()]].concat());
    repo.put("f.txt", resolution);
    repo.git(&["add", "f.txt"]);
    repo.git(&["rerere"]);
    repo.git(&[pick.command(), "--abort"]);
}

#[test]
fn rerere_auto_update_stops_with_nothing_unresolved_and_finish_commits_it() {
    for (format, pick) in cases() {
        let (repo, of) = conflicting_in_f_only(format, pick);
        remembering(&repo, pick, &of, "a\nREMEMBERED\nc\n");
        let before = repo.oid("HEAD");
        let review = repo.review(&of).unwrap();
        assert_eq!(
            review.prediction,
            ReplayPrediction::Conflict {
                paths: vec!["f.txt".to_owned()]
            },
            "{format} {pick:?}: merge-tree does not use rerere"
        );

        let error = repo.start(&review).unwrap_err();

        let ErrorKind::ReplayStopped { output } = &error.kind else {
            panic!("{format} {pick:?}: {error:?}");
        };
        assert!(
            output.contains("using previous resolution"),
            "{format} {pick:?}: {output}"
        );
        assert_eq!(repo.oid("HEAD"), before, "{format} {pick:?}");
        let progress = repo.progress();
        assert_eq!(
            progress.unresolved,
            Vec::<String>::new(),
            "{format} {pick:?}"
        );
        assert!(!progress.empty, "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nREMEMBERED\nc\n");

        repo.finish_as_shown(&progress, "Finished\n").unwrap();
        assert_eq!(repo.oid("HEAD^"), before, "{format} {pick:?}");
        assert_eq!(repo.read("f.txt"), "a\nREMEMBERED\nc\n");
    }
}

#[test]
fn rerere_that_restores_heads_side_answers_unchanged_and_leaves_no_trace() {
    for (format, pick) in cases() {
        let (repo, of) = conflicting_in_f_only(format, pick);
        remembering(&repo, pick, &of, "a\nOURS\nc\n");
        let before = repo.frozen();
        let review = repo.review(&of).unwrap();

        let error = repo.start(&review).unwrap_err();

        assert_eq!(
            error.kind,
            ErrorKind::UnchangedPath,
            "{format} {pick:?}: {}",
            error.message
        );
        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
        assert!(!repo.has_marker(pick), "{format} {pick:?}");
        assert_eq!(repo.state(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
    }
}

/// A merge driver that merges to `merged` until run `until`, then runs `then` and
/// keeps HEAD's side. Each review and each Start's review run it once, so the real
/// run can see something different from what the review saw.
fn counted_driver(repo: &Repo, until: u32, then: &str) {
    let runs = repo.directory.path().join("driver-runs");
    let driver = repo.directory.path().join("driver");
    let runs = runs.display();
    fs::write(
        &driver,
        format!(
            "#!/bin/sh\nrun=$(( $(cat '{runs}' 2>/dev/null || echo 0) + 1 ))\necho $run > '{runs}'\nif [ \"$run\" -ge {until} ]; then\n  {then}\n  exit 0\nfi\necho merged > \"$1\"\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&driver, fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&[
        "config",
        "merge.counted.driver",
        &format!("'{}' %A", driver.display()),
    ]);
    repo.put(".git/info/attributes", "f.txt merge=counted\n");
}

#[test]
fn a_clean_prediction_that_turns_out_empty_answers_unchanged_and_leaves_no_message() {
    for (format, pick) in cases() {
        let (repo, of) = conflicting_in_f_only(format, pick);
        counted_driver(&repo, 3, ":");
        let before = repo.frozen();
        let review = repo.review(&of).unwrap();
        assert!(
            matches!(review.prediction, ReplayPrediction::Clean { .. }),
            "{format} {pick:?}: {review:?}"
        );

        let error = repo.start(&review).unwrap_err();

        assert_eq!(
            error.kind,
            ErrorKind::UnchangedPath,
            "{format} {pick:?}: {}",
            error.message
        );
        assert!(
            error.message.contains("result matches HEAD"),
            "{format} {pick:?}: {}",
            error.message
        );
        assert_eq!(repo.frozen(), before, "{format} {pick:?}");
        assert!(!repo.root.join(".git/MERGE_MSG").exists());
        assert!(!repo.has_marker(pick), "{format} {pick:?}");
        assert_eq!(repo.state(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
    }
}

#[test]
fn a_lock_git_cannot_take_after_the_review_refuses_with_nothing_changed() {
    for (format, pick) in cases() {
        let (repo, of) = conflicting_in_f_only(format, pick);
        let lock = repo.root.join(".git/index.lock");
        let remove_once = repo.directory.path().join("locked-once");
        counted_driver(
            &repo,
            2,
            &format!(
                "[ -e '{once}' ] || {{ touch '{once}' '{lock}'; }}; echo merged > \"$1\"",
                once = remove_once.display(),
                lock = lock.display(),
            ),
        );
        let before = repo.oid("HEAD");
        let review = repo.review(&of).unwrap();

        let error = repo.start(&review).unwrap_err();

        assert_eq!(
            error.kind,
            ErrorKind::LockHeld,
            "{format} {pick:?}: {}",
            error.message
        );
        assert!(lock.exists(), "{format} {pick:?}");
        fs::remove_file(&lock).unwrap();
        assert_eq!(repo.oid("HEAD"), before, "{format} {pick:?}");
        assert_eq!(repo.status(), "", "{format} {pick:?}");
        assert!(!repo.has_marker(pick), "{format} {pick:?}");
        assert_eq!(repo.history().undo, None, "{format} {pick:?}");
    }
}

#[test]
fn a_branch_named_like_a_marker_does_not_hide_or_fake_a_stop() {
    for (format, pick) in cases() {
        let (repo, of) = Repo::clean(format, pick);
        repo.git(&["branch", "CHERRY_PICK_HEAD"]);
        repo.git(&["branch", "REVERT_HEAD"]);
        let kept = repo.oid("refs/heads/CHERRY_PICK_HEAD");
        let review = repo.review(&of).unwrap();
        repo.hook("prepare-commit-msg", "exit 1\n");

        let error = repo.start(&review).unwrap_err();

        assert!(
            matches!(error.kind, ErrorKind::ReplayStopped { .. }),
            "{format} {pick:?}: {error:?}"
        );
        repo.no_hooks();
        assert_eq!(repo.progress().of(), of, "{format} {pick:?}");
        assert!(repo.has_marker(pick), "{format} {pick:?}");
        assert_eq!(repo.abort().unwrap(), MergeState::Idle, "{format} {pick:?}");
        assert_eq!(repo.oid("refs/heads/CHERRY_PICK_HEAD"), kept);
        assert_eq!(repo.oid("refs/heads/REVERT_HEAD"), kept);

        let (repo, of) = conflicting_in_f_only(format, pick);
        repo.git(&["branch", "CHERRY_PICK_HEAD"]);
        repo.git(&["branch", "REVERT_HEAD"]);
        counted_driver(&repo, 3, ":");
        let review = repo.review(&of).unwrap();
        let error = repo.start(&review).unwrap_err();
        assert_eq!(
            error.kind,
            ErrorKind::UnchangedPath,
            "{format} {pick:?}: a branch is no marker: {}",
            error.message
        );
    }
}

#[test]
fn a_linked_worktree_holds_its_own_stop() {
    for (format, pick) in cases() {
        let repo = Repo::new(format);
        let commit = repo.adding(pick, "n.txt");
        let linked = repo.linked("linked", "busy");
        let path = linked.to_str().unwrap();
        let coordinator = repo.coordinator();
        let review = coordinator.review_replay(path, &of(pick, &commit)).unwrap();
        failing_gpg(&repo);

        let error = coordinator
            .write(
                path,
                &Operation::Replay {
                    review: review.clone(),
                },
                &Expect {
                    head: head_of(&review),
                },
            )
            .unwrap_err();

        assert!(
            matches!(error.kind, ErrorKind::ReplayStopped { .. }),
            "{format} {pick:?}: {error:?}"
        );
        repo.git(&["config", "commit.gpgSign", "false"]);
        assert_eq!(
            repo.state(),
            MergeState::Idle,
            "{format} {pick:?}: main stays"
        );
        let MergeState::Replay { progress } = coordinator.merge_state(path).unwrap() else {
            panic!("{format} {pick:?}: the linked worktree holds it");
        };
        assert_eq!(progress.root, path, "{format} {pick:?}");
        assert_eq!(progress.commit.as_str(), commit, "{format} {pick:?}");
        coordinator
            .abort_replay(path, &progress.of(), &progress.destination)
            .unwrap();
        assert_eq!(
            git(&linked, &["status", "--porcelain"]),
            "",
            "{format} {pick:?}"
        );
    }
}
