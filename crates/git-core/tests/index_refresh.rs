#![cfg(unix)]

use l1_git_core::{Coordinator, Expect, Limits, Operation, Start, worktree_status};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command.arg("-C").arg(root).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct Repo {
    temp: TempDir,
    root: PathBuf,
    coordinator: Coordinator,
}

impl Repo {
    /// A repository whose committed files `f` and `g` have stale stat data.
    fn stale(config: &[(&str, &str)]) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
            ("maintenance.auto", "false"),
            ("gc.auto", "0"),
        ]
        .iter()
        .chain(config)
        {
            git(&root, &["config", key, value]);
        }
        for file in ["f", "g"] {
            fs::write(root.join(file), "one\n").unwrap();
        }
        git(&root, &["add", "f", "g"]);
        git(&root, &["commit", "--quiet", "-m", "Initial"]);
        touch(&root.join("f"), 1);
        touch(&root.join("g"), 1);
        let coordinator = Coordinator::new(Limits::default(), temp.path().join("undo"));
        Self {
            temp,
            root,
            coordinator,
        }
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn file(&self, name: &str) -> PathBuf {
        self.temp.path().join(name)
    }

    fn script(&self, name: &str, body: &str) -> PathBuf {
        let path = self.file(name);
        fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn read_status(&self) {
        let status = self.coordinator.worktree_status(self.path()).unwrap();
        assert!(status.entries.is_empty(), "{:?}", status.entries);
    }
}

/// Git compares modification and change times by the second, so a second
/// touch needs another `hours`.
fn touch(path: &Path, hours: u64) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(hours * 3600))
        .unwrap();
}

/// Whether the index caches `path`'s current modification time.
fn cached(root: &Path, path: &str) -> bool {
    let debug = git(root, &["ls-files", "--debug", "--", path]);
    let mtime = debug
        .lines()
        .find_map(|line| line.trim().strip_prefix("mtime: "))
        .unwrap();
    let file = fs::metadata(root.join(path)).unwrap().modified().unwrap();
    let seconds = file.duration_since(UNIX_EPOCH).unwrap().as_secs();
    mtime.split(':').next().unwrap() == seconds.to_string()
}

fn wait_for(what: &str, done: impl Fn() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "waited for {what}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_refresh_runs_no_hook() {
    let repo = Repo::stale(&[]);
    let marker = repo.file("hook-ran");
    let hooks = repo.file("hooks");
    fs::create_dir(&hooks).unwrap();
    let hook = repo.script(
        "post-index-change",
        &format!(": > '{}'\n", marker.display()),
    );
    fs::rename(hook, hooks.join("post-index-change")).unwrap();
    git(
        &repo.root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    git(
        &repo.root,
        &["config", "hook.log.event", "post-index-change"],
    );
    let command = format!(": > '{}'", marker.display());
    git(&repo.root, &["config", "hook.log.command", &command]);
    git(
        &repo.root,
        &["hook", "run", "post-index-change", "--", "0", "0"],
    );
    assert!(marker.exists(), "the hooks run outside L1 Git");
    fs::remove_file(&marker).unwrap();

    repo.read_status();
    repo.coordinator.wait_for_refreshes();
    assert!(cached(&repo.root, "f"), "stat data stayed stale");
    assert!(!marker.exists(), "the refresh ran post-index-change");
}

#[test]
fn a_refresh_changes_only_the_index_of_the_worktree_it_read() {
    let repo = Repo::stale(&[]);
    let linked = repo.root.with_file_name("linked");
    git(
        &repo.root,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            linked.to_str().unwrap(),
        ],
    );
    touch(&linked.join("f"), 1);

    let status = repo
        .coordinator
        .worktree_status(linked.to_str().unwrap())
        .unwrap();
    assert!(status.entries.is_empty(), "{:?}", status.entries);
    repo.coordinator.wait_for_refreshes();
    assert!(cached(&linked, "f"), "the linked index stayed stale");
    assert!(!cached(&repo.root, "f"), "the main index changed");
}

#[test]
fn a_refresh_never_runs_while_a_write_holds_the_repository() {
    let repo = Repo::stale(&[]);
    let (started, go) = (repo.file("started"), repo.file("go"));
    let hooks = repo.file("hooks");
    fs::create_dir(&hooks).unwrap();
    let hook = repo.script(
        "reference-transaction",
        &format!(
            "cat > /dev/null\n[ \"$1\" = prepared ] || exit 0\n: > '{}'\nwhile [ ! -e '{}' ]; do sleep 0.01; done\n",
            started.display(),
            go.display()
        ),
    );
    fs::rename(hook, hooks.join("reference-transaction")).unwrap();
    git(
        &repo.root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let oid = l1_git_core::Oid::try_from(git(&repo.root, &["rev-parse", "HEAD"]).trim().to_owned())
        .unwrap();
    let head = worktree_status(repo.path()).unwrap().head;

    thread::scope(|scope| {
        let branch = scope.spawn(|| {
            repo.coordinator.write(
                repo.path(),
                &Operation::CreateBranch {
                    name: "topic".into(),
                    at: Start::Commit { oid },
                },
                &Expect { head },
            )
        });
        wait_for("the branch write", || started.exists());
        repo.read_status();
        repo.coordinator.wait_for_refreshes();
        assert!(!cached(&repo.root, "f"), "refreshed during a write");
        fs::write(&go, "").unwrap();
        branch.join().unwrap().unwrap();
    });
    assert!(!cached(&repo.root, "f"), "a skipped refresh ran later");

    repo.read_status();
    repo.coordinator.wait_for_refreshes();
    assert!(cached(&repo.root, "f"), "stat data stayed stale");
}

#[test]
fn a_write_stops_a_running_refresh_instead_of_waiting_for_it() {
    let repo = Repo::stale(&[]);
    let (count, blocked) = (repo.file("count"), repo.file("blocked"));
    let clean = repo.script(
        "clean",
        &format!(
            "n=$(($(cat '{count}') + 1))\necho $n > '{count}'\nif [ $n = 2 ]; then\n  : > '{blocked}'\n  sleep 60\nfi\ncat\n",
            count = count.display(),
            blocked = blocked.display()
        ),
    );
    git(
        &repo.root,
        &["config", "filter.slow.clean", clean.to_str().unwrap()],
    );
    fs::write(repo.root.join(".gitattributes"), "f filter=slow\n").unwrap();
    git(&repo.root, &["add", ".gitattributes"]);
    git(&repo.root, &["commit", "--quiet", "-m", "Filter f"]);
    fs::write(&count, "0").unwrap();
    touch(&repo.root.join("f"), 2);
    fs::write(repo.root.join("g"), "two\n").unwrap();

    let status = repo.coordinator.worktree_status(repo.path()).unwrap();
    wait_for("the refresh to run the filter", || blocked.exists());
    let started = Instant::now();
    repo.coordinator
        .write(
            repo.path(),
            &Operation::StageFiles {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the write waited {:?} for the refresh",
        started.elapsed()
    );
    repo.coordinator.wait_for_refreshes();
    assert_eq!(git(&repo.root, &["diff", "--cached", "--name-only"]), "g\n");
    assert!(!repo.root.join(".git/index.lock").exists());
}
