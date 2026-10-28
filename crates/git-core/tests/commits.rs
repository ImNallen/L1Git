use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Limits, Operation, RepositoryError, StaleReason,
    worktree_status,
};
use std::{
    fs,
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

#[derive(Clone, Copy)]
enum Kind {
    Commit,
    Amend,
    EditMessage,
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
}

impl Repo {
    fn unborn() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
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

    fn born() -> Self {
        let repo = Self::unborn();
        repo.put("a.txt", "one\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "--quiet", "-m", "initial"]);
        repo
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn coordinator(&self) -> Coordinator {
        Coordinator::new(Limits::default(), self.directory.path().join("undo"))
    }

    fn put(&self, path: &str, contents: &str) {
        fs::write(self.root.join(path), contents).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }

    fn status(&self) -> String {
        self.git(&["status", "--porcelain"])
    }

    fn staged_edit(&self, path: &str, contents: &str) {
        self.put(path, contents);
        self.git(&["add", path]);
    }

    fn request(&self, kind: Kind, message: &str) -> (Operation, Expect) {
        let status = worktree_status(self.path()).unwrap();
        let message = message.to_owned();
        let staged = status.staged_stamp;
        let operation = match kind {
            Kind::Commit => Operation::Commit { message, staged },
            Kind::Amend => Operation::Amend { message, staged },
            Kind::EditMessage => Operation::EditMessage { message },
        };
        (operation, Expect { head: status.head })
    }

    fn write(&self, kind: Kind, message: &str) -> Result<Applied, RepositoryError> {
        let (operation, expect) = self.request(kind, message);
        self.coordinator().write(self.path(), &operation, &expect)
    }

    fn undo(&self, applied: &Applied) {
        self.coordinator().undo(self.path(), applied.id).unwrap();
    }

    fn redo(&self, applied: &Applied) {
        self.coordinator().redo(self.path(), applied.id).unwrap();
    }

    fn refs(&self) -> String {
        self.git(&["for-each-ref", "--format=%(refname) %(objectname)"])
            + &self.git(&["symbolic-ref", "-q", "HEAD"])
    }

    fn hook(&self, name: &str, body: &str) {
        let hooks = self.directory.path().join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let path = hooks.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        self.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    }

    fn undo_entry(&self) -> Option<Applied> {
        self.coordinator().undo_history(self.path()).unwrap().undo
    }
}

fn refused(result: Result<Applied, RepositoryError>, kind: ErrorKind) -> RepositoryError {
    let error = result.expect_err("the write should refuse");
    assert_eq!(error.kind, kind, "{}", error.message);
    error
}

#[test]
fn commits_the_staged_files_and_undoes_and_redoes_the_branch_move() {
    let repo = Repo::born();
    let parent = repo.head();
    repo.staged_edit("a.txt", "two\n");
    repo.put("unstaged.txt", "not staged\n");
    let applied = repo.write(Kind::Commit, "Update a\n\nBody.\n").unwrap();
    let made = repo.head();
    assert_eq!(
        repo.git(&["log", "-1", "--format=%B%P"]),
        format!("Update a\n\nBody.\n{parent}\n")
    );
    assert_eq!(repo.status(), "?? unstaged.txt\n");
    let reflog = repo.git(&["reflog", "-1", "--format=%gs", "main"]);
    assert!(reflog.contains("Update a"), "{reflog}");

    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
    assert_eq!(repo.status(), "M  a.txt\n?? unstaged.txt\n");
    repo.git(&["reflog", "expire", "--expire-unreachable=now", "--all"]);
    repo.git(&["gc", "--quiet", "--prune=now"]);
    repo.redo(&applied);
    assert_eq!(repo.head(), made);
    assert_eq!(repo.status(), "?? unstaged.txt\n");
    repo.git(&["fsck", "--no-progress"]);
}

#[test]
fn amends_keeping_parents_and_author_and_undo_leaves_the_change_staged() {
    let repo = Repo::born();
    repo.staged_edit("b.txt", "b\n");
    repo.git(&["commit", "--quiet", "-m", "second"]);
    let old = repo.head();
    let kept = repo.git(&["log", "-1", "--format=%P %an %ae %ad"]);
    repo.staged_edit("c.txt", "c\n");
    let applied = repo.write(Kind::Amend, "second, amended\n").unwrap();
    assert_ne!(repo.head(), old);
    assert_eq!(repo.git(&["log", "-1", "--format=%P %an %ae %ad"]), kept);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "second, amended\n");
    assert_eq!(repo.status(), "");

    repo.undo(&applied);
    assert_eq!(repo.head(), old);
    assert_eq!(repo.status(), "A  c.txt\n");
    repo.git(&["reflog", "expire", "--expire-unreachable=now", "--all"]);
    repo.git(&["gc", "--quiet", "--prune=now"]);
    repo.redo(&applied);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "second, amended\n");
    repo.undo(&applied);
    assert_eq!(repo.head(), old);
    repo.git(&["fsck", "--no-progress"]);
}

#[test]
fn edits_a_message_alone_and_keeps_staged_changes_out_even_on_an_empty_commit() {
    let repo = Repo::born();
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "empty"]);
    let old = repo.head();
    let tree = repo.git(&["rev-parse", "HEAD^{tree}", "HEAD^"]);
    repo.staged_edit("a.txt", "staged\n");
    let applied = repo.write(Kind::EditMessage, "renamed\n").unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD^{tree}", "HEAD^"]), tree);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "renamed\n");
    assert_eq!(repo.status(), "M  a.txt\n");
    repo.undo(&applied);
    assert_eq!(repo.head(), old);
    assert_eq!(repo.status(), "M  a.txt\n");
}

#[test]
fn makes_a_first_commit_and_undo_leaves_head_unborn_with_the_file_staged() {
    let repo = Repo::unborn();
    repo.staged_edit("f", "first\n");
    let applied = repo.write(Kind::Commit, "First\n").unwrap();
    assert_eq!(repo.git(&["log", "--format=%s|%P"]), "First|\n");
    repo.undo(&applied);
    assert_eq!(repo.git(&["for-each-ref"]), "");
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/main\n");
    assert_eq!(repo.status(), "A  f\n");
    repo.redo(&applied);
    assert_eq!(repo.git(&["log", "--format=%s"]), "First\n");
}

#[test]
fn commits_on_a_detached_head_and_undo_keeps_it_detached() {
    let repo = Repo::born();
    repo.git(&["checkout", "--quiet", "--detach"]);
    let parent = repo.head();
    repo.staged_edit("a.txt", "two\n");
    let applied = repo.write(Kind::Commit, "Detached\n").unwrap();
    assert_eq!(
        repo.git(&["rev-parse", "HEAD^"]).trim(),
        parent,
        "parent is the old HEAD"
    );
    assert_eq!(repo.git(&["rev-parse", "main"]).trim(), parent);
    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
    assert!(
        git_fails(&repo.root, &["symbolic-ref", "-q", "HEAD"]),
        "HEAD stays detached"
    );
    assert_eq!(repo.status(), "M  a.txt\n");
}

fn git_fails(path: &Path, args: &[&str]) -> bool {
    !Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdout(Stdio::null())
        .status()
        .unwrap()
        .success()
}

#[test]
fn refuses_an_empty_message_and_nothing_staged_without_changing_anything() {
    let repo = Repo::born();
    let before = repo.refs();
    refused(
        repo.write(Kind::Commit, "Nothing\n"),
        ErrorKind::UnchangedPath,
    );
    repo.put("u.txt", "untracked\n");
    refused(
        repo.write(Kind::Commit, "Nothing\n"),
        ErrorKind::UnchangedPath,
    );
    repo.staged_edit("a.txt", "two\n");
    refused(repo.write(Kind::Commit, "  \n\n"), ErrorKind::GitFailed);
    assert_eq!(repo.refs(), before);
    assert_eq!(repo.status(), "M  a.txt\n?? u.txt\n");
}

#[test]
fn refuses_a_stale_staged_list_or_a_moved_head() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    let (operation, expect) = repo.request(Kind::Commit, "Mine\n");
    repo.staged_edit("b.txt", "b\n");
    refused(
        repo.coordinator().write(repo.path(), &operation, &expect),
        ErrorKind::StaleView {
            reason: StaleReason::StagedChanged,
        },
    );
    let (operation, expect) = repo.request(Kind::Commit, "Mine\n");
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "other"]);
    let other = repo.head();
    refused(
        repo.coordinator().write(repo.path(), &operation, &expect),
        ErrorKind::StaleView {
            reason: StaleReason::StagedChanged,
        },
    );
    assert_eq!(repo.head(), other);
    repo.staged_edit("a.txt", "three\n");
    let (operation, expect) = repo.request(Kind::Commit, "Mine\n");
    repo.put("a.txt", "edited after the view\n");
    repo.coordinator()
        .write(repo.path(), &operation, &expect)
        .expect("an unstaged edit does not make the staged list stale");
}

#[test]
fn a_commit_that_lands_on_a_branch_l1_git_did_not_check_has_no_undo_entry() {
    let repo = Repo::born();
    repo.git(&["branch", "other"]);
    let parent = repo.head();
    repo.hook("pre-commit", "git symbolic-ref HEAD refs/heads/other\n");
    repo.staged_edit("a.txt", "two\n");
    let error = refused(repo.write(Kind::Commit, "Raced\n"), ErrorKind::Raced);
    let made = repo.git(&["rev-parse", "other"]);
    assert!(error.message.contains(&made[..7]), "{}", error.message);
    assert_eq!(repo.git(&["rev-parse", "main"]).trim(), parent);
    assert_eq!(repo.git(&["log", "-1", "--format=%s", "other"]), "Raced\n");
    assert!(repo.undo_entry().is_none());
}

#[test]
fn refuses_during_a_merge_or_with_an_unmerged_path() {
    let repo = Repo::born();
    let head = repo.head();
    repo.staged_edit("a.txt", "two\n");
    fs::write(repo.root.join(".git/MERGE_HEAD"), format!("{head}\n")).unwrap();
    let error = refused(repo.write(Kind::Commit, "Merge\n"), ErrorKind::Conflict);
    assert!(error.message.contains("merge"), "{}", error.message);
    fs::remove_file(repo.root.join(".git/MERGE_HEAD")).unwrap();
    fs::write(repo.root.join(".git/BISECT_LOG"), "").unwrap();
    repo.write(Kind::Commit, "During a bisect\n")
        .expect("a bisect does not block a commit");
}

#[test]
fn a_failing_hook_answers_hook_failed_with_its_output_and_changes_nothing() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    let before = repo.refs();
    for name in ["pre-commit", "commit-msg"] {
        repo.hook(name, "echo 'lint failed: TODO'\necho oops >&2\nexit 1\n");
        let error = repo.write(Kind::Commit, "Hooked\n").unwrap_err();
        let ErrorKind::HookFailed { output } = &error.kind else {
            panic!("{error:?}");
        };
        assert!(output.contains("lint failed: TODO"), "{output}");
        assert!(output.contains("oops"), "{output}");
        assert!(error.message.contains(name), "{}", error.message);
        repo.hook(name, "exit 0\n");
    }
    repo.hook("post-commit", "exit 1\n");
    repo.write(Kind::Commit, "Post-commit failures do not count\n")
        .expect("a failing post-commit hook leaves the commit made");
    assert_ne!(repo.refs(), before);
}

#[test]
fn a_missing_identity_answers_missing_identity() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    repo.git(&["config", "user.useConfigOnly", "true"]);
    repo.git(&["config", "user.name", ""]);
    let error = repo.write(Kind::Commit, "Who\n").unwrap_err();
    let ErrorKind::MissingIdentity { output } = &error.kind else {
        panic!("{error:?}");
    };
    assert!(
        output.contains("no name was given") || output.contains("empty ident name"),
        "{output}"
    );
    assert!(error.message.contains("name"), "{}", error.message);
    assert_eq!(repo.status(), "M  a.txt\n");
}

#[test]
fn signing_that_cannot_run_fails_without_a_commit() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    repo.git(&["config", "commit.gpgSign", "true"]);
    repo.git(&["config", "gpg.program", "/nonexistent/gpg"]);
    let before = repo.refs();
    let error = refused(repo.write(Kind::Commit, "Signed\n"), ErrorKind::GitFailed);
    assert!(error.message.contains("gpg"), "{}", error.message);
    assert_eq!(repo.refs(), before);
    assert_eq!(repo.status(), "M  a.txt\n");
}

#[test]
fn undo_refuses_after_head_moved_and_during_a_merge() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    let applied = repo.write(Kind::Commit, "Mine\n").unwrap();
    let made = repo.head();
    fs::write(repo.root.join(".git/MERGE_HEAD"), format!("{made}\n")).unwrap();
    refused(
        repo.coordinator().undo(repo.path(), applied.id),
        ErrorKind::Conflict,
    );
    fs::remove_file(repo.root.join(".git/MERGE_HEAD")).unwrap();
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "other"]);
    refused(
        repo.coordinator().undo(repo.path(), applied.id),
        ErrorKind::StaleView {
            reason: StaleReason::HeadMoved,
        },
    );
    assert_eq!(repo.git(&["rev-parse", "HEAD^"]).trim(), made);
}

#[test]
fn a_commit_git_was_killed_after_making_is_not_reported_as_made() {
    let repo = Repo::born();
    repo.hook("post-commit", "kill -9 $PPID\n");
    repo.staged_edit("a.txt", "two\n");
    let error = refused(repo.write(Kind::Commit, "Landed\n"), ErrorKind::GitFailed);
    assert!(
        error.message.contains("check the history"),
        "{}",
        error.message
    );
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Landed\n");
    assert!(repo.undo_entry().is_none());
}

#[test]
fn hooks_see_the_users_environment_not_l1_gits() {
    let repo = Repo::born();
    let seen = repo.directory.path().join("seen");
    repo.hook(
        "pre-commit",
        &format!(
            "printf '%s|%s|%s|%s' \"$GIT_CONFIG_PARAMETERS\" \"$GIT_OPTIONAL_LOCKS\" \"$GIT_NO_LAZY_FETCH\" \"$(git rev-parse --short HEAD)\" > '{}'\n",
            seen.display()
        ),
    );
    repo.staged_edit("a.txt", "two\n");
    let short = repo.git(&["rev-parse", "--short", "HEAD"]);
    repo.write(Kind::Commit, "Clean env\n").unwrap();
    assert_eq!(
        fs::read_to_string(&seen).unwrap(),
        format!("|||{}", short.trim())
    );
    let reflog = repo.git(&["reflog", "-1", "--format=%gs", "main"]);
    assert_eq!(reflog, "commit: Clean env\n");
}

#[test]
fn undo_of_a_commit_moves_only_the_ref_and_runs_its_hooks() {
    let repo = Repo::born();
    let parent = repo.head();
    repo.staged_edit("a.txt", "two\n");
    let applied = repo.write(Kind::Commit, "Ref only\n").unwrap();
    let seen = repo.directory.path().join("seen");
    repo.hook(
        "reference-transaction",
        &format!("cat > /dev/null\necho \"$1\" >> '{}'\n", seen.display()),
    );
    fs::write(repo.root.join(".git/index.lock"), "").unwrap();
    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
    assert!(
        repo.root.join(".git/index.lock").exists(),
        "another tool's index.lock is left alone"
    );
    assert!(
        fs::read_to_string(&seen).unwrap().contains("committed"),
        "reference-transaction ran"
    );
}

#[test]
fn a_commit_git_refused_after_another_process_moved_head_is_not_reported_as_made() {
    for (kind, parent) in [
        (Kind::Commit, "HEAD"),
        (Kind::Amend, "HEAD^"),
        (Kind::EditMessage, "HEAD^"),
    ] {
        let repo = Repo::born();
        repo.git(&["commit", "--quiet", "--allow-empty", "-m", "second"]);
        repo.hook(
            "pre-commit",
            &format!(
                "git update-ref refs/heads/main $(git commit-tree 'HEAD^{{tree}}' -p {parent} -m other)\n"
            ),
        );
        repo.staged_edit("a.txt", "two\n");
        refused(
            repo.write(kind, "Mine\n"),
            ErrorKind::StaleView {
                reason: StaleReason::HeadMoved,
            },
        );
        assert_eq!(repo.git(&["log", "-1", "--format=%s", "main"]), "other\n");
        assert_eq!(repo.status(), "M  a.txt\n");
        assert!(repo.undo_entry().is_none(), "nothing of ours to undo");
    }
}

#[test]
fn a_commit_another_process_builds_on_during_post_commit_is_named_and_not_undone() {
    let repo = Repo::born();
    repo.hook(
        "post-commit",
        "git update-ref refs/heads/main $(git commit-tree 'HEAD^{tree}' -p HEAD -m other)\n",
    );
    repo.staged_edit("a.txt", "two\n");
    let error = refused(repo.write(Kind::Commit, "Mine\n"), ErrorKind::Raced);
    let mine = repo.git(&["rev-parse", "main^"]);
    assert_eq!(
        repo.git(&["log", "-1", "--format=%s", mine.trim()]),
        "Mine\n"
    );
    assert!(error.message.contains(&mine[..7]), "{}", error.message);
    assert!(
        repo.undo_entry().is_none(),
        "undo must not remove the other process's commit"
    );
}

#[test]
fn a_commit_a_hook_sets_the_branch_to_again_stays_ours() {
    let repo = Repo::born();
    let parent = repo.head();
    repo.hook("post-commit", "git update-ref refs/heads/main HEAD\n");
    repo.staged_edit("a.txt", "two\n");
    let applied = repo
        .write(Kind::Commit, "Mine\n")
        .expect("main still holds the commit Git made");
    repo.undo(&applied);
    assert_eq!(repo.head(), parent);
}

#[test]
fn a_commit_keeps_its_branch_when_head_switches_during_post_commit() {
    let repo = Repo::born();
    let parent = repo.head();
    repo.git(&["branch", "feature"]);
    repo.hook("post-commit", "git symbolic-ref HEAD refs/heads/feature\n");
    repo.staged_edit("a.txt", "two\n");
    let applied = repo
        .write(Kind::Commit, "Mine\n")
        .expect("the commit landed on main");
    assert_eq!(repo.git(&["log", "-1", "--format=%s", "main"]), "Mine\n");
    repo.git(&["config", "core.hooksPath", "/dev/null"]);
    refused(
        repo.coordinator().undo(repo.path(), applied.id),
        ErrorKind::StaleView {
            reason: StaleReason::HeadMoved,
        },
    );
    assert_eq!(repo.git(&["rev-parse", "feature"]).trim(), parent);
    repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    repo.undo(&applied);
    assert_eq!(repo.git(&["rev-parse", "main"]).trim(), parent);
    assert_eq!(repo.git(&["rev-parse", "feature"]).trim(), parent);
}

#[test]
fn a_hook_that_prints_a_lot_shows_what_it_printed_last() {
    let repo = Repo::born();
    repo.hook(
        "pre-commit",
        "i=0\nwhile [ $i -lt 2000 ]; do echo \"noise line $i ................................................\"; i=$((i+1)); done\necho 'THE REAL ERROR: lint failed'\nexit 1\n",
    );
    repo.staged_edit("a.txt", "two\n");
    let error = repo.write(Kind::Commit, "Loud\n").unwrap_err();
    let ErrorKind::HookFailed { output } = &error.kind else {
        panic!("{error:?}");
    };
    assert!(
        output.ends_with("THE REAL ERROR: lint failed\n"),
        "{}",
        &output[output.len().saturating_sub(200)..]
    );
    assert!(output.starts_with('…'), "the cut is marked");
    assert_eq!(output.len(), 64 * 1024 + "…".len());
}

#[test]
fn a_hook_that_prints_one_long_line_shows_its_end() {
    let repo = Repo::born();
    repo.hook(
        "pre-commit",
        "head -c 100000 /dev/zero | tr '\\0' x\necho ' THE REAL ERROR'\nexit 1\n",
    );
    repo.staged_edit("a.txt", "two\n");
    let error = repo.write(Kind::Commit, "Loud\n").unwrap_err();
    let ErrorKind::HookFailed { output } = &error.kind else {
        panic!("{error:?}");
    };
    assert!(
        output.starts_with("…x") && output.ends_with("xxx THE REAL ERROR\n"),
        "{} bytes: {:?}",
        output.len(),
        output.chars().take(20).collect::<String>()
    );
    assert!(output.len() <= 64 * 1024 + "…".len(), "{}", output.len());
}

#[test]
fn an_amend_that_makes_the_same_commit_answers_unchanged_and_records_nothing() {
    let second = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    };
    for _ in 0..5 {
        let repo = Repo::born();
        let started = second();
        repo.git(&["commit", "--quiet", "--allow-empty", "-m", "same"]);
        let head = repo.head();
        let result = repo.write(Kind::EditMessage, "same\n");
        if second() != started {
            continue;
        }
        refused(result, ErrorKind::UnchangedPath);
        assert_eq!(repo.head(), head);
        assert!(repo.undo_entry().is_none());
        return;
    }
    panic!("no attempt fit in one second, so Git never made the same commit");
}

#[test]
fn the_commit_traces_stay_in_a_private_folder_that_goes_with_the_commit() {
    let repo = Repo::born();
    let seen = repo.directory.path().join("seen");
    repo.hook(
        "pre-commit",
        &format!(
            "echo \"$GIT_TRACE2_EVENT\" > '{0}'\necho \"$GIT_TRACE_REFS\" >> '{0}'\nls -ld \"$(dirname \"$GIT_TRACE2_EVENT\")\" | cut -c1-10 >> '{0}'\n",
            seen.display()
        ),
    );
    repo.hook(
        "post-commit",
        "(sleep 1; git rev-parse HEAD) > /dev/null 2>&1 &\n",
    );
    repo.staged_edit("a.txt", "two\n");
    repo.write(Kind::Commit, "Traced\n").unwrap();
    let report = fs::read_to_string(&seen).unwrap();
    let [events, refs, mode] = report.lines().collect::<Vec<_>>()[..] else {
        panic!("{report}");
    };
    let folder = Path::new(events).parent().unwrap();
    assert_eq!(Path::new(refs).parent(), Some(folder), "{report}");
    assert_eq!(mode, "drwx------", "{report}");
    assert!(
        folder.starts_with(repo.directory.path().join("undo")),
        "{report}"
    );
    std::thread::sleep(std::time::Duration::from_secs(2));
    assert!(
        !folder.exists(),
        "a git a hook left running cannot bring the trace back: {report}"
    );
    let left = folder.with_file_name("trace-0000000000000001");
    fs::create_dir(&left).unwrap();
    fs::write(left.join("trace2.json"), "left by a crash").unwrap();
    repo.staged_edit("a.txt", "three\n");
    repo.write(Kind::Commit, "Traced again\n").unwrap();
    assert!(
        !left.exists(),
        "the next commit sweeps a crashed run's folder"
    );
}

#[test]
fn undo_that_a_reference_transaction_hook_refuses_says_the_branch_is_unchanged() {
    let repo = Repo::born();
    repo.staged_edit("a.txt", "two\n");
    let applied = repo.write(Kind::Commit, "Kept\n").unwrap();
    let made = repo.head();
    repo.hook(
        "reference-transaction",
        "cat > /dev/null\n[ \"$1\" = prepared ] && { echo 'policy says no'; exit 1; }\nexit 0\n",
    );
    let error = refused(
        repo.coordinator().undo(repo.path(), applied.id),
        ErrorKind::GitFailed,
    );
    assert!(
        error.message.contains("policy says no"),
        "{}",
        error.message
    );
    assert!(!error.message.contains("index"), "{}", error.message);
    assert_eq!(repo.head(), made);
}
