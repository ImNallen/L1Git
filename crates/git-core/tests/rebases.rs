#![cfg(unix)]

use l1_git_core::{
    Applied, BranchRef, BranchTip, Coordinator, ErrorKind, Expect, Head, Limits, MergeAttention,
    MergeState, Oid, Operation, OperationProbe, RebaseOf, RebaseProgress, RemoteRef,
    RepositoryError, Request, Response, StaleReason, run, worktree_status,
};
use std::{
    fs,
    num::NonZeroUsize,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::Duration,
};
use tempfile::TempDir;

const FORMATS: [&str; 2] = ["files", "reftable"];

fn terminal(path: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
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
        .envs(env.iter().copied())
        .env("GIT_EDITOR", ":")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = terminal(path, args, &[]);
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

fn limits() -> Limits {
    Limits {
        clone_deadline: Duration::from_secs(30),
        fetch_deadline: Duration::from_secs(10),
        optional_fetch_deadline: Duration::from_secs(10),
        push_deadline: Duration::from_secs(10),
        local_deadline: Duration::from_secs(30),
        network_slots: NonZeroUsize::new(4).unwrap(),
    }
}

fn branch(name: &str) -> BranchRef {
    BranchRef::try_from(format!("refs/heads/{name}")).unwrap()
}

fn oid(value: &str) -> Oid {
    Oid::try_from(value.to_owned()).unwrap()
}

/// A clone of a bare remote. `main` has three local commits, and its upstream one
/// that conflicts with the first two: `f` and `g` both change on each side. The
/// third commit adds `h`, which applies cleanly.
struct World {
    directory: TempDir,
    work: PathBuf,
    /// The local commits, oldest first.
    ours: [String; 3],
    theirs: String,
}

impl World {
    fn new() -> Self {
        Self::with_format("files")
    }

    fn with_format(format: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        git(
            &base,
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                &format!("--ref-format={format}"),
                "remote.git",
            ],
        );
        git(
            &base,
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                &format!("--ref-format={format}"),
                "work",
            ],
        );
        let work = base.join("work");
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
        ] {
            git(&work, &["config", key, value]);
        }
        let world = |work: PathBuf| Self {
            directory,
            work,
            ours: Default::default(),
            theirs: String::new(),
        };
        let mut world = world(work);
        world.put("f", "f base\n");
        world.put("g", "g base\n");
        world.commit_all("base");
        git(
            &world.work,
            &[
                "remote",
                "add",
                "origin",
                base.join("remote.git").to_str().unwrap(),
            ],
        );
        git(&world.work, &["push", "--quiet", "-u", "origin", "main"]);
        git(&world.work, &["switch", "--quiet", "--detach"]);
        world.put("f", "f theirs\n");
        world.put("g", "g theirs\n");
        world.theirs = world.commit_all("theirs");
        git(&world.work, &["push", "--quiet", "origin", "HEAD:main"]);
        git(&world.work, &["switch", "--quiet", "main"]);
        git(&world.work, &["fetch", "--quiet", "origin"]);
        world.put("f", "f ours\n");
        let first = world.commit_all("ours f");
        world.put("g", "g ours\n");
        let second = world.commit_all("ours g");
        world.put("h", "h ours\n");
        let third = world.commit_all("ours h");
        world.ours = [first, second, third];
        world
    }

    fn path(&self) -> &str {
        self.work.to_str().unwrap()
    }

    fn coordinator(&self) -> Coordinator {
        Coordinator::new(limits(), self.directory.path().join("undo"))
    }

    fn put(&self, file: &str, text: &str) {
        fs::write(self.work.join(file), text).unwrap();
    }

    fn read(&self, file: &str) -> String {
        fs::read_to_string(self.work.join(file)).unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.work, args)
    }

    fn commit_all(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "--quiet", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }

    fn status(&self) -> String {
        self.git(&["status", "--porcelain", "--untracked-files=no"])
    }

    fn rebasing(&self) -> bool {
        self.work.join(".git/rebase-merge").exists()
    }

    fn pull(&self) -> Result<Applied, RepositoryError> {
        let status = worktree_status(self.path()).unwrap();
        self.coordinator().write(
            self.path(),
            &Operation::Rebase {
                branch: branch("main"),
                onto: RemoteRef::try_from("refs/remotes/origin/main".to_owned()).unwrap(),
            },
            &Expect { head: status.head },
        )
    }

    fn state(&self) -> MergeState {
        self.coordinator().merge_state(self.path()).unwrap()
    }

    fn progress(&self) -> RebaseProgress {
        match self.state() {
            MergeState::Rebase { progress } => progress,
            other => panic!("expected a rebase in progress: {other:?}"),
        }
    }

    fn assert_external(&self, why: &str) -> String {
        match self.state() {
            MergeState::Attention {
                session: None,
                reason: MergeAttention::ExternalOperation,
                message,
            } => message,
            other => panic!("{why}: {other:?}"),
        }
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

    fn resolve(&self, file: &str, text: &str) {
        self.put(file, text);
        self.stage(file);
    }

    fn write(&self, operation: &Operation, head: &Head) -> Result<Applied, RepositoryError> {
        self.coordinator()
            .write(self.path(), operation, &Expect { head: head.clone() })
    }

    fn continue_rebase(&self, shown: &RebaseProgress) -> Result<Applied, RepositoryError> {
        self.write(&continue_operation(shown), &shown.head)
    }

    fn skip(&self, shown: &RebaseProgress) -> Result<Applied, RepositoryError> {
        self.write(
            &Operation::SkipRebase {
                of: shown.of(),
                staged: shown.staged.clone(),
            },
            &shown.head,
        )
    }

    fn abort(&self, shown: &RebaseProgress) -> Result<MergeState, RepositoryError> {
        self.coordinator()
            .abort_rebase(self.path(), &shown.of(), &shown.head)
    }

    fn undo_id(&self) -> Option<l1_git_core::EntryId> {
        self.coordinator()
            .undo_history(self.path())
            .unwrap()
            .undo
            .map(|entry| entry.id)
    }

    fn subjects(&self) -> String {
        self.git(&["log", "--format=%s", "main"])
    }

    fn hook(&self, name: &str, body: &str) {
        self.git(&["config", "core.hooksPath", ".git/hooks"]);
        let path = self.work.join(".git/hooks").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Pulls, which stops on `f` in the first local commit.
    fn stopped() -> Self {
        let world = Self::new();
        let stop = world.pull().unwrap_err();
        assert_eq!(
            stop.kind,
            ErrorKind::RebaseStopped {
                output: String::new()
            },
            "{stop:?}"
        );
        world
    }

    /// Resolves the first stop and continues to the second, on `g`.
    fn at_second_stop() -> Self {
        let world = Self::stopped();
        world.resolve("f", "f resolved\n");
        let stop = world.continue_rebase(&world.progress()).unwrap_err();
        assert_eq!(
            stop.message,
            "The rebase stopped on a conflict in commit 2 of 3. Resolve it, then continue or abort the rebase."
        );
        world
    }
}

fn continue_operation(shown: &RebaseProgress) -> Operation {
    Operation::ContinueRebase {
        of: shown.of(),
        staged: shown.staged.clone(),
        tree: shown.tree.clone().expect("every conflict is resolved"),
    }
}

fn refused(error: &RepositoryError, message: &str) {
    assert_eq!(error.kind, ErrorKind::Conflict, "{error:?}");
    assert_eq!(error.message, message);
}

#[test]
fn a_pull_rebase_that_conflicts_stays_in_progress_for_the_app() {
    let world = World::new();
    let stop = world.pull().unwrap_err();
    assert_eq!(
        stop.message,
        "The rebase stopped on a conflict in commit 1 of 3. Resolve it, then continue or abort the rebase."
    );
    assert!(world.rebasing());
    assert_eq!(world.head(), world.theirs);
    let progress = world.progress();
    assert_eq!(progress.branch, branch("main"));
    assert_eq!(progress.onto, oid(&world.theirs));
    assert_eq!(
        progress.onto_name.as_deref(),
        Some("refs/remotes/origin/main")
    );
    assert_eq!(progress.orig_head, oid(&world.ours[2]));
    assert_eq!(progress.step, oid(&world.ours[0]));
    assert_eq!(progress.subject, "ours f");
    assert_eq!((progress.done, progress.total), (1, 3));
    assert_eq!(
        progress.head,
        Head::Detached {
            oid: world.theirs.clone()
        }
    );
    assert_eq!(progress.footprint, ["f"]);
    assert_eq!(progress.conflicted, ["f"]);
    assert_eq!(progress.unresolved, ["f"]);
    assert_eq!(progress.tree, None);
    assert!(!progress.empty);
    // The pull's entry drops with the stop. The request that ends the rebase records one.
    assert_eq!(world.undo_id(), None);
    let Response::OperationProbe(probe) = run(
        &world.coordinator(),
        Request::OperationProbe {
            path: world.path().to_owned(),
        },
    )
    .unwrap() else {
        panic!("an operation probe");
    };
    assert_eq!(probe, OperationProbe::Rebase);
    // The panel serializes the identity back as it read it.
    let wire = serde_json::to_value(progress.of()).unwrap();
    assert_eq!(
        serde_json::from_value::<RebaseOf>(wire).unwrap(),
        progress.of()
    );
}

#[test]
fn continue_stops_on_the_next_step_then_finishes_with_one_undo_for_the_whole_rebase() {
    let world = World::at_second_stop();
    let progress = world.progress();
    assert_eq!(progress.step, oid(&world.ours[1]));
    assert_eq!((progress.done, progress.total), (2, 3));
    assert_eq!(progress.unresolved, ["g"]);
    assert_eq!(world.undo_id(), None, "a new step starts a new journal");
    assert_eq!(
        world.git(&["log", "-1", "--format=%s", "HEAD"]),
        "ours f",
        "Git committed the first step with its own message"
    );

    world.resolve("g", "g resolved\n");
    let resolution = world.undo_id().expect("staging has resolution Undo");
    let applied = world.continue_rebase(&world.progress()).unwrap();
    assert_ne!(applied.id, resolution);
    assert!(!world.rebasing());
    assert_eq!(world.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(world.subjects(), "ours h\nours g\nours f\ntheirs\nbase");
    assert_eq!(world.read("f"), "f resolved\n");
    assert_eq!(world.read("g"), "g resolved\n");
    assert_eq!(world.state(), MergeState::Idle);
    assert_eq!(world.undo_id(), Some(applied.id));
    let rebased = world.head();

    world.coordinator().undo(world.path(), applied.id).unwrap();
    assert_eq!(world.head(), world.ours[2]);
    assert_eq!(world.read("f"), "f ours\n");
    assert_eq!(world.status(), "");
    world.coordinator().redo(world.path(), applied.id).unwrap();
    assert_eq!(world.head(), rebased);
    assert_eq!(world.status(), "");
}

#[test]
fn a_repeated_continue_answers_the_entry_it_recorded() {
    let world = World::at_second_stop();
    world.resolve("g", "g resolved\n");
    let shown = world.progress();
    let applied = world.continue_rebase(&shown).unwrap();
    assert_eq!(world.continue_rebase(&shown).unwrap(), applied);
}

#[test]
fn skip_drops_a_step_whose_result_matches_head() {
    let world = World::stopped();
    world.resolve("f", "f theirs\n");
    let shown = world.progress();
    assert!(shown.empty);
    let error = world.continue_rebase(&shown).unwrap_err();
    assert_eq!(error.kind, ErrorKind::UnchangedPath);
    assert_eq!(
        error.message,
        "The staged result matches HEAD, so this commit has nothing left to apply. Skip it instead."
    );

    let stop = world.skip(&shown).unwrap_err();
    assert_eq!(
        stop.message,
        "The rebase stopped on a conflict in commit 2 of 3. Resolve it, then continue or abort the rebase."
    );
    world.resolve("g", "g resolved\n");
    let applied = world.continue_rebase(&world.progress()).unwrap();
    assert_eq!(world.subjects(), "ours h\nours g\ntheirs\nbase");
    world.coordinator().undo(world.path(), applied.id).unwrap();
    assert_eq!(world.head(), world.ours[2]);
}

#[test]
fn skip_refuses_a_result_that_differs_from_head() {
    let world = World::stopped();
    world.resolve("f", "f resolved\n");
    refused(
        &world.skip(&world.progress()).unwrap_err(),
        "The staged result differs from HEAD, and Skip would discard it. Continue the rebase instead.",
    );
    assert_eq!(world.progress().step, oid(&world.ours[0]));
}

#[test]
fn abort_puts_the_branch_back_where_the_rebase_began() {
    let world = World::at_second_stop();
    let shown = world.progress();
    assert_eq!(world.abort(&shown).unwrap(), MergeState::Idle);
    assert!(!world.rebasing());
    assert_eq!(world.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(world.head(), world.ours[2]);
    assert_eq!(world.read("f"), "f ours\n");
    assert_eq!(world.status(), "");
    assert_eq!(world.undo_id(), None);
    // A repeated abort finds the branch where the first one put it.
    assert_eq!(world.abort(&shown).unwrap(), MergeState::Idle);
}

#[test]
fn continue_and_abort_answer_stale_for_a_rebase_that_moved_on() {
    let world = World::stopped();
    let first = world.progress();
    world.resolve("f", "f resolved\n");
    let resolved = world.progress();
    let error = world
        .continue_rebase(&first_with_tree(&first, &resolved))
        .unwrap_err();
    assert_eq!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::StagedChanged
        }
    );

    world.continue_rebase(&resolved).unwrap_err();
    let error = world.continue_rebase(&resolved).unwrap_err();
    assert_eq!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::HeadMoved
        },
        "{error:?}"
    );
    let error = world.abort(&resolved).unwrap_err();
    assert_eq!(
        error.kind,
        ErrorKind::StaleView {
            reason: StaleReason::HeadMoved
        }
    );
    assert_eq!(world.progress().step, oid(&world.ours[1]));
}

/// The first read's identity and staged stamp, with a tree that would pass.
fn first_with_tree(first: &RebaseProgress, resolved: &RebaseProgress) -> RebaseProgress {
    RebaseProgress {
        tree: resolved.tree.clone(),
        ..first.clone()
    }
}

#[test]
fn continue_refuses_before_git_runs() {
    let world = World::stopped();
    let shown = world.progress();
    let unresolved = RebaseProgress {
        tree: Some(oid(&world.git(&["rev-parse", "HEAD^{tree}"]))),
        ..shown.clone()
    };
    refused(
        &world.continue_rebase(&unresolved).unwrap_err(),
        "f has a conflict. Mark it resolved before you continue.",
    );

    world.resolve("f", "f resolved\n");
    world.put("g", "g edited\n");
    refused(
        &world.continue_rebase(&world.progress()).unwrap_err(),
        "These paths have unstaged edits, and Git continues a rebase only when every change is staged: g. Stage them or undo the edits first.",
    );
    world.git(&["checkout", "--", "g"]);

    world.put("x", "x\n");
    world.git(&["add", "x"]);
    refused(
        &world.continue_rebase(&world.progress()).unwrap_err(),
        "Preserve these staged changes before you continue, because the commit being rebased does not change them: x.",
    );
    world.git(&["rm", "--cached", "--quiet", "x"]);
    fs::remove_file(world.work.join("x")).unwrap();

    fs::write(world.work.join(".git/info/exclude"), "h\n").unwrap();
    world.put("h", "build output\n");
    refused(
        &world.continue_rebase(&world.progress()).unwrap_err(),
        "Preserve these untracked or ignored files first, because the rest of the rebase would write to their paths: h.",
    );
    assert_eq!(world.read("h"), "build output\n");
    assert_eq!(world.progress().step, oid(&world.ours[0]));
}

#[test]
fn abort_refuses_what_it_would_silently_destroy() {
    let world = World::stopped();
    let shown = world.progress();

    world.put("x", "x\n");
    world.git(&["add", "x"]);
    refused(
        &world.abort(&shown).unwrap_err(),
        "Abort would discard these staged changes, because the rebase does not change them: x. Preserve them, then abort.",
    );
    world.git(&["rm", "--cached", "--quiet", "x"]);
    fs::remove_file(world.work.join("x")).unwrap();

    world.put("g", "g edited\n");
    refused(
        &world.abort(&shown).unwrap_err(),
        "Abort would discard these unstaged edits, which resolve no conflict: g. Preserve them, then abort.",
    );
    world.git(&["checkout", "--", "g"]);

    fs::write(world.work.join(".git/info/exclude"), "h\n").unwrap();
    world.put("h", "build output\n");
    refused(
        &world.abort(&shown).unwrap_err(),
        "Abort would overwrite these untracked or ignored files, because main tracks their paths: h. Preserve them, then abort.",
    );
    assert_eq!(world.read("h"), "build output\n");
    fs::remove_file(world.work.join("h")).unwrap();

    // Edits to a conflicted file are its resolution, which Abort discards.
    world.put("f", "half resolved\n");
    assert_eq!(world.abort(&shown).unwrap(), MergeState::Idle);
    assert_eq!(world.head(), world.ours[2]);
}

#[test]
fn a_rebase_in_progress_holds_its_branch_and_its_paths() {
    let world = World::stopped();
    let shown = world.progress();
    let tip = BranchTip {
        reference: branch("main"),
        oid: oid(&world.ours[2]),
    };
    for operation in [
        Operation::RenameBranch {
            branch: tip.clone(),
            to: "renamed".to_owned(),
        },
        Operation::DeleteBranch { branch: tip },
    ] {
        let error = world.write(&operation, &shown.head).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{error:?}");
        assert!(
            error.message.contains("is rebasing refs/heads/main"),
            "{error:?}"
        );
    }
    world.put("g", "g edited\n");
    let status = worktree_status(world.path()).unwrap();
    let entries = status
        .entries
        .into_iter()
        .filter(|entry| serde_json::to_value(entry).unwrap()["path"] == "g")
        .collect();
    refused(
        &world
            .write(&Operation::StageFiles { entries }, &status.head)
            .unwrap_err(),
        "A rebase is in progress in this worktree, and it does not change these paths: g. Continue or abort it before you change them.",
    );
    let error = world
        .write(
            &Operation::Commit {
                message: "no".to_owned(),
                staged: status.staged_stamp,
            },
            &status.head,
        )
        .unwrap_err();
    assert_eq!(
        error.message,
        "A rebase is in progress in this worktree. Only resolution and index edits within its affected paths are available until Continue or Abort."
    );
}

#[test]
fn a_hook_that_stops_the_commit_keeps_the_step_in_progress() {
    let world = World::stopped();
    world.resolve("f", "f resolved\n");
    world.hook("prepare-commit-msg", "echo 'no commit today' >&2\nexit 1\n");
    let error = world.continue_rebase(&world.progress()).unwrap_err();
    let ErrorKind::RebaseStopped { output } = &error.kind else {
        panic!("{error:?}");
    };
    assert!(output.contains("no commit today"), "{output}");
    assert_eq!(
        error.message,
        "Git did not commit this step, so the rebase is still on commit 1 of 3 and the result stays staged. Fix what Git reported, then continue or abort the rebase."
    );
    let progress = world.progress();
    assert_eq!(progress.step, oid(&world.ours[0]));
    assert!(progress.unresolved.is_empty());
    world.git(&["config", "core.hooksPath", "/dev/null"]);
    world.continue_rebase(&progress).unwrap_err();
    assert_eq!(world.progress().step, oid(&world.ours[1]));
}

#[test]
fn a_rebase_started_in_a_terminal_is_continued_and_undone_in_the_app() {
    for format in FORMATS {
        let world = World::with_format(format);
        world.git(&["switch", "--quiet", "-c", "topic"]);
        world.git(&["branch", "--quiet", "-f", "main", &world.theirs]);
        let stopped = terminal(&world.work, &["rebase", "main"], &[]);
        assert!(
            !stopped.status.success(),
            "{format}: the rebase should stop"
        );
        let shown = world.progress();
        assert_eq!(shown.branch, branch("topic"), "{format}");
        assert_eq!(shown.onto_name.as_deref(), Some("refs/heads/main"));
        assert_eq!((shown.done, shown.total), (1, 3));

        world.resolve("f", "f resolved\n");
        world.continue_rebase(&world.progress()).unwrap_err();
        world.resolve("g", "g resolved\n");
        let applied = world.continue_rebase(&world.progress()).unwrap();
        assert_eq!(world.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
        assert_eq!(world.git(&["rev-parse", "HEAD~3"]), world.theirs);
        world.coordinator().undo(world.path(), applied.id).unwrap();
        assert_eq!(world.head(), world.ours[2], "{format}");
    }
}

#[test]
fn a_rebase_with_more_than_picks_stays_external() {
    let world = World::new();
    world.git(&["switch", "--quiet", "-c", "topic"]);
    world.git(&["branch", "--quiet", "-f", "main", &world.theirs]);
    let stopped = terminal(&world.work, &["rebase", "--exec", "true", "main"], &[]);
    assert!(!stopped.status.success(), "the rebase should stop");
    assert!(
        terminal(&world.work, &["show-ref", "--exists", "REBASE_HEAD"], &[])
            .status
            .success(),
        "Git stopped on a conflicted pick"
    );
    let message = world.assert_external("an exec line is not a plain rebase");
    assert_eq!(
        message,
        "A rebase is in progress. Continue it with git rebase --continue or end it with git rebase --abort, then refresh."
    );
    terminal(&world.work, &["rebase", "--abort"], &[]);

    let stopped = terminal(
        &world.work,
        &["rebase", "--interactive", "main"],
        &[("GIT_SEQUENCE_EDITOR", "sed -i.bak '1s/^pick/edit/'")],
    );
    assert!(!stopped.status.success() || world.rebasing());
    world.assert_external("an interactive edit stays in the terminal");
}
