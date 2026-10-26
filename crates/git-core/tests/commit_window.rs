#![cfg(unix)]

use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Limits, Operation, RepositoryError, worktree_status,
};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use tempfile::TempDir;

fn git_in(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
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
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn executable(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[derive(Clone, Copy, Debug)]
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
    fn staged_on_second_commit() -> Self {
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
        fs::write(repo.root.join("a.txt"), "one\n").unwrap();
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "--quiet", "-m", "first"]);
        repo.git(&["commit", "--quiet", "--allow-empty", "-m", "second"]);
        fs::write(repo.root.join("a.txt"), "two\n").unwrap();
        repo.git(&["add", "a.txt"]);
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        git_in(&self.root, args)
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn coordinator(&self) -> Coordinator {
        Coordinator::new(Limits::default(), self.directory.path().join("undo"))
    }

    fn before_git_reads_head(&self, body: &str) {
        executable(&self.root.join(".git/before-commit"), body);
    }

    fn write(&self, kind: Kind, message: &str) -> Result<Applied, RepositoryError> {
        let status = worktree_status(self.path()).unwrap();
        let message = message.to_owned();
        let staged = status.staged_stamp;
        let operation = match kind {
            Kind::Commit => Operation::Commit { message, staged },
            Kind::Amend => Operation::Amend { message, staged },
            Kind::EditMessage => Operation::EditMessage { message },
        };
        self.coordinator()
            .write(self.path(), &operation, &Expect { head: status.head })
    }

    fn undo_entry(&self) -> Option<Applied> {
        self.coordinator().undo_history(self.path()).unwrap().undo
    }

    fn main(&self) -> String {
        self.git(&["rev-parse", "main"])
    }
}

fn raced(result: Result<Applied, RepositoryError>) -> RepositoryError {
    let error = result.expect_err("the write should answer raced");
    assert_eq!(error.kind, ErrorKind::Raced, "{}", error.message);
    error
}

fn an_amend_of_a_commit_another_process_swapped_in_undoes_to_that_commit(kind: Kind, reflog: bool) {
    let repo = Repo::staged_on_second_commit();
    if !reflog {
        repo.git(&["config", "core.logAllRefUpdates", "false"]);
        fs::remove_dir_all(repo.root.join(".git/logs")).unwrap();
    }
    let shown = repo.main();
    repo.before_git_reads_head(
        "x=$(git commit-tree 'HEAD^{tree}' -p HEAD^ -m other) && git update-ref refs/heads/main \"$x\" && echo \"$x\" > .git/other\n",
    );
    let error = raced(repo.write(kind, "Mine\n"));
    let other = fs::read_to_string(repo.root.join(".git/other"))
        .unwrap()
        .trim()
        .to_owned();
    let mine = repo.main();
    assert_ne!(other, shown);
    assert_eq!(repo.git(&["log", "-1", "--format=%s", &mine]), "Mine");
    assert!(
        error.message.contains(&other[..7]),
        "{kind:?}: {}",
        error.message
    );
    let entry = repo
        .undo_entry()
        .expect("Git replaced the other commit, so undo gives it back");
    repo.coordinator().undo(repo.path(), entry.id).unwrap();
    assert_eq!(
        repo.main(),
        other,
        "{kind:?}, reflog {reflog}: undo restores what Git replaced"
    );
    repo.coordinator().redo(repo.path(), entry.id).unwrap();
    assert_eq!(repo.main(), mine, "{kind:?}, reflog {reflog}");
}

fn a_commit_on_a_commit_another_process_made_undoes_to_that_commit() {
    let repo = Repo::staged_on_second_commit();
    repo.before_git_reads_head(
        "x=$(git commit-tree 'HEAD^{tree}' -p HEAD -m other) && git update-ref refs/heads/main \"$x\" && echo \"$x\" > .git/other\n",
    );
    raced(repo.write(Kind::Commit, "Mine\n"));
    let other = fs::read_to_string(repo.root.join(".git/other"))
        .unwrap()
        .trim()
        .to_owned();
    assert_eq!(repo.git(&["rev-parse", "main^"]), other);
    let entry = repo.undo_entry().expect("undo removes only our commit");
    repo.coordinator().undo(repo.path(), entry.id).unwrap();
    assert_eq!(repo.main(), other);
}

fn a_commit_on_a_branch_another_process_switched_to_has_no_undo_entry() {
    let repo = Repo::staged_on_second_commit();
    let shown = repo.main();
    repo.git(&["branch", "feature", "HEAD^"]);
    repo.before_git_reads_head("git symbolic-ref HEAD refs/heads/feature\n");
    raced(repo.write(Kind::Commit, "Mine\n"));
    assert_eq!(repo.main(), shown);
    assert_eq!(repo.git(&["log", "-1", "--format=%s", "feature"]), "Mine");
    assert!(repo.undo_entry().is_none());
}

fn sha1_hex(bytes: &[u8]) -> String {
    sha1_smol::Sha1::from(bytes).digest().to_string()
}

/// Another commit whose ID starts with `prefix`, and its object body.
fn colliding_commit(repo: &Repo, prefix: &str, mine: &str) -> (String, String) {
    let tree = repo.git(&["rev-parse", "main^{tree}"]);
    let parent = repo.git(&["rev-parse", "main^"]);
    (0u64..)
        .map(|n| {
            let body = format!(
                "tree {tree}\nparent {parent}\nauthor Eve <eve@example.test> 1700000000 +0000\ncommitter Eve <eve@example.test> 1700000000 +0000\n\nother {n}\n"
            );
            let oid = sha1_hex(&[format!("commit {}\0", body.len()).as_bytes(), body.as_bytes()].concat());
            (body, oid)
        })
        .find(|(_, oid)| oid.starts_with(prefix) && oid != mine)
        .unwrap()
}

fn point_main_at_new_commit(repo: &Repo, body: &str, oid: &str) {
    let mut hash = Command::new("git")
        .arg("-C")
        .arg(&repo.root)
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    hash.stdin
        .take()
        .unwrap()
        .write_all(body.as_bytes())
        .unwrap();
    let written = hash.wait_with_output().unwrap();
    assert_eq!(String::from_utf8(written.stdout).unwrap().trim(), oid);
    repo.git(&["update-ref", "refs/heads/main", oid]);
}

fn wait_for(path: &Path) {
    while !path.exists() {
        thread::sleep(Duration::from_millis(5));
    }
}

fn after_git_exits_wait_for_collision(repo: &Repo) {
    repo.git(&["config", "core.abbrev", "4"]);
    executable(
        &repo.root.join(".git/after-commit"),
        "touch .git/exited\nwhile [ ! -e .git/collided ]; do sleep 0.02; done\n",
    );
}

fn a_commit_that_shares_the_printed_prefix_is_not_taken_as_ours() {
    let repo = Repo::staged_on_second_commit();
    after_git_exits_wait_for_collision(&repo);
    let (result, other) = thread::scope(|scope| {
        let write = scope.spawn(|| repo.write(Kind::Commit, "Mine\n"));
        wait_for(&repo.root.join(".git/exited"));
        let mine = repo.main();
        let printed = repo.git(&["rev-parse", "--short", "HEAD"]);
        let (body, other) = colliding_commit(&repo, &printed, &mine);
        point_main_at_new_commit(&repo, &body, &other);
        fs::write(repo.root.join(".git/collided"), "").unwrap();
        (write.join().unwrap(), other)
    });
    raced(result);
    assert_eq!(repo.main(), other, "L1 Git leaves the other commit alone");
    assert!(
        repo.undo_entry().is_none(),
        "undo must not move main off a commit L1 Git did not make"
    );
}

fn a_hook_that_forges_gits_update_to_a_commit_sharing_the_printed_prefix_is_not_taken_as_ours() {
    let repo = Repo::staged_on_second_commit();
    after_git_exits_wait_for_collision(&repo);
    let hooks = repo.root.join(".git/forging-hooks");
    fs::create_dir(&hooks).unwrap();
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    executable(
        &hooks.join("reference-transaction"),
        "[ \"$1\" = prepared ] && [ ! -e .git/mine ] || exit 0\n\
         awk '$3 == \"refs/heads/main\" { print $1, $2 }' > .git/mine.part && mv .git/mine.part .git/mine\n\
         while [ ! -e .git/forged ]; do sleep 0.02; done\n\
         printf '00:00:00.000000 refs/debug.c:88         1: refs/heads/main %s -> %s (F=0xc, T=0x0) \"commit: Mine\"\\n' \"$(cut -d' ' -f1 .git/mine)\" \"$(cat .git/forged)\" >> \"$GIT_TRACE_REFS\"\n",
    );
    let (result, other) = thread::scope(|scope| {
        let write = scope.spawn(|| repo.write(Kind::Commit, "Mine\n"));
        wait_for(&repo.root.join(".git/mine"));
        let traced = fs::read_to_string(repo.root.join(".git/mine")).unwrap();
        let mine = traced.split_whitespace().nth(1).unwrap().to_owned();
        let (body, other) = colliding_commit(&repo, &mine[..5], &mine);
        fs::write(repo.root.join(".git/forged.part"), &other).unwrap();
        fs::rename(
            repo.root.join(".git/forged.part"),
            repo.root.join(".git/forged"),
        )
        .unwrap();
        wait_for(&repo.root.join(".git/exited"));
        assert_eq!(repo.main(), mine, "Git made our commit");
        point_main_at_new_commit(&repo, &body, &other);
        fs::write(repo.root.join(".git/collided"), "").unwrap();
        (write.join().unwrap(), other)
    });
    raced(result);
    assert_eq!(repo.main(), other, "L1 Git leaves the other commit alone");
    assert!(
        repo.undo_entry().is_none(),
        "a forged trace line must not make another commit ours"
    );
}

fn put_fake_git_first_on_path() -> TempDir {
    let real = String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned();
    let bin = tempfile::tempdir().unwrap();
    executable(
        &bin.path().join("git"),
        &format!(
            "as_another_process() {{ [ -x \"$2/.git/$1\" ] && (cd \"$2\" && env -u GIT_TRACE2_EVENT -u GIT_TRACE_REFS \"./.git/$1\" < /dev/null) && rm -f \"$2/.git/$1\"; }}\n\
             [ \"$1\" = -C ] && [ \"$3\" = commit ] || exec '{real}' \"$@\"\n\
             as_another_process before-commit \"$2\"\n\
             '{real}' \"$@\"\n\
             code=$?\n\
             as_another_process after-commit \"$2\"\n\
             exit $code\n"
        ),
    );
    let path = format!(
        "{}:{}",
        bin.path().display(),
        std::env::var("PATH").unwrap()
    );
    // SAFETY: this binary runs one test, and no other thread exists yet.
    unsafe { std::env::set_var("PATH", path) };
    bin
}

/// The only test in this binary, because it puts a fake Git first on PATH.
#[test]
fn another_process_that_moves_head_around_gits_commit_is_never_taken_for_ours() {
    let _bin = put_fake_git_first_on_path();
    for kind in [Kind::Amend, Kind::EditMessage] {
        an_amend_of_a_commit_another_process_swapped_in_undoes_to_that_commit(kind, true);
    }
    an_amend_of_a_commit_another_process_swapped_in_undoes_to_that_commit(Kind::Amend, false);
    a_commit_on_a_commit_another_process_made_undoes_to_that_commit();
    a_commit_on_a_branch_another_process_switched_to_has_no_undo_entry();
    a_commit_that_shares_the_printed_prefix_is_not_taken_as_ours();
    a_hook_that_forges_gits_update_to_a_commit_sharing_the_printed_prefix_is_not_taken_as_ours();
}
