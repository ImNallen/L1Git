use l1_git_core::{
    Blocker, BranchRef, BranchRole, BranchState, BranchStatus, Coordinator, ErrorKind,
    FetchFailure, FetchMode, FetchOutcome, Limits, Oid, RemoteFetch, RepositoryOverview,
};
use std::{
    fs,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
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

/// A working copy, its bare `origin`, and a colleague's clone that pushes to it.
struct World {
    directory: TempDir,
    remote: PathBuf,
    work: PathBuf,
    colleague: PathBuf,
    initial: String,
}

impl World {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let remote = base.join("remote.git");
        let work = base.join("work tree");
        let colleague = base.join("colleague");
        git(
            &base,
            &["init", "--bare", "--initial-branch=main", "remote.git"],
        );
        git(&base, &["init", "--initial-branch=main", "work tree"]);
        git(&work, &["config", "core.hooksPath", "/dev/null"]);
        let initial = commit(&work, "f", "one\n", "initial");
        git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&work, &["push", "--quiet", "-u", "origin", "main"]);
        git(
            &base,
            &["clone", "--quiet", remote.to_str().unwrap(), "colleague"],
        );
        git(&colleague, &["config", "core.hooksPath", "/dev/null"]);
        Self {
            directory,
            remote,
            work,
            colleague,
            initial,
        }
    }

    fn path(&self) -> &str {
        self.work.to_str().unwrap()
    }

    fn file(&self, name: &str) -> PathBuf {
        self.directory.path().canonicalize().unwrap().join(name)
    }

    fn publish(&self, branch: &str) {
        git(&self.work, &["push", "--quiet", "-u", "origin", branch]);
        git(&self.colleague, &["fetch", "--quiet", "origin"]);
    }

    fn colleague_pushes(&self, branch: &str, file: &str, contents: &str) -> String {
        git(&self.colleague, &["switch", "--quiet", branch]);
        let oid = commit(
            &self.colleague,
            file,
            contents,
            &format!("{branch}: {file}"),
        );
        git(&self.colleague, &["push", "--quiet", "origin", branch]);
        oid
    }

    fn worktree(&self, name: &str, branch: &str) -> PathBuf {
        let path = self.file(name);
        git(
            &self.work,
            &["worktree", "add", "--quiet", path.to_str().unwrap(), branch],
        );
        path
    }

    fn script(&self, name: &str, body: &str) -> String {
        let path = self.file(name);
        fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_str().unwrap().to_owned()
    }
}

fn commit(path: &Path, file: &str, contents: &str, message: &str) -> String {
    fs::write(path.join(file), contents).unwrap();
    git(path, &["add", "--", file]);
    git(path, &["commit", "--quiet", "-m", message]);
    git(path, &["rev-parse", "HEAD"])
}

fn limits() -> Limits {
    Limits {
        fetch_deadline: Duration::from_secs(2),
        local_deadline: Duration::from_secs(30),
        network_slots: NonZeroUsize::new(4).unwrap(),
    }
}

fn coordinator() -> Coordinator {
    Coordinator::new(limits())
}

fn oid(value: &str) -> Oid {
    Oid::try_from(value.to_owned()).unwrap()
}

fn branch_ref(name: &str) -> BranchRef {
    BranchRef::try_from(format!("refs/heads/{name}")).unwrap()
}

fn branch<'a>(overview: &'a RepositoryOverview, name: &str) -> &'a BranchStatus {
    overview
        .branches
        .iter()
        .find(|branch| branch.name == name)
        .unwrap_or_else(|| panic!("no branch {name}"))
}

fn path(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn upstream(name: &str) -> String {
    format!("refs/remotes/origin/{name}")
}

fn behind(name: &str, target: &str, count: u32, blocker: Option<Blocker>) -> BranchState {
    BranchState::Behind {
        upstream: upstream(name),
        target: oid(target),
        behind: count,
        blocker,
    }
}

#[test]
fn fetches_of_one_repository_never_overlap_and_concurrent_requests_share_one() {
    let world = World::new();
    let coordinator = Arc::new(coordinator());
    git(&world.work, &["branch", "develop"]);
    let linked = world.worktree("wt-develop", "develop");
    let log = world.file("upload-pack.log");
    let wrapper = world.script(
        "upload-pack",
        &format!(
            "echo start >> '{log}'\nsleep 1\ngit upload-pack \"$@\"\nstatus=$?\necho end >> '{log}'\nexit $status\n",
            log = log.display()
        ),
    );
    git(
        &world.work,
        &["config", "remote.origin.uploadpack", &wrapper],
    );

    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [path(&world.work), path(&linked)]
        .into_iter()
        .map(|root| {
            let (coordinator, barrier) = (Arc::clone(&coordinator), Arc::clone(&barrier));
            thread::spawn(move || {
                barrier.wait();
                coordinator.overview(&root, FetchMode::Remote).unwrap()
            })
        })
        .collect();
    let mut coalesced: Vec<bool> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap().fetch.unwrap().coalesced)
        .collect();
    coalesced.sort();
    assert_eq!(coalesced, [false, true]);
    assert_eq!(fs::read_to_string(&log).unwrap(), "start\nend\n");

    let later = coordinator
        .overview(linked.to_str().unwrap(), FetchMode::Remote)
        .unwrap();
    assert!(!later.fetch.unwrap().coalesced);
    assert_eq!(
        fs::read_to_string(&log).unwrap(),
        "start\nend\nstart\nend\n"
    );
}

const FAKE_SSH_AUTH: &str = r#"if [ "$SSH_ASKPASS_REQUIRE" = force ] && [ -n "$SSH_ASKPASS" ]; then
  "$SSH_ASKPASS" "Enter passphrase:" >/dev/null 2>&1 || {
    echo "git@example.invalid: Permission denied (publickey)." >&2
    exit 255
  }
fi
if ( : </dev/tty ) 2>/dev/null; then
  read -r passphrase </dev/tty
fi
echo "git@example.invalid: Permission denied (publickey)." >&2
exit 255
"#;

#[test]
fn reports_each_remote_and_fails_fast_on_rejected_credentials() {
    let world = World::new();
    let coordinator = coordinator();
    let target = world.colleague_pushes("main", "f", "one\ntwo\n");
    let ssh = world.script("fake-ssh", FAKE_SSH_AUTH);
    git(&world.work, &["config", "core.sshCommand", &ssh]);
    git(&world.work, &["config", "ssh.variant", "ssh"]);
    git(
        &world.work,
        &[
            "remote",
            "add",
            "locked",
            "ssh://git@example.invalid/team/app.git",
        ],
    );
    git(
        &world.work,
        &[
            "remote",
            "add",
            "github",
            "git@github.com:l1-family/l1-git.git",
        ],
    );
    git(
        &world.work,
        &["config", "remote.github.skipFetchAll", "true"],
    );

    let started = Instant::now();
    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        fetched.fetch.clone().unwrap().remotes,
        [
            RemoteFetch {
                remote: "github".into(),
                outcome: FetchOutcome::Skipped
            },
            RemoteFetch {
                remote: "locked".into(),
                outcome: FetchOutcome::Failed {
                    failure: FetchFailure::Auth,
                    message: "git@example.invalid: Permission denied (publickey). fatal: Could not read from remote repository.".into()
                }
            },
            RemoteFetch {
                remote: "origin".into(),
                outcome: FetchOutcome::Fetched
            },
        ]
    );
    assert_eq!(
        branch(&fetched, "main").state,
        behind("main", &target, 1, None)
    );
}

#[test]
fn skips_the_remotes_git_fetch_all_skips() {
    let world = World::new();
    let coordinator = coordinator();
    for (remote, key, value) in [
        ("dead", "skipDefaultUpdate", "true"),
        ("old.mirror", "skipFetchAll", "yes"),
        ("wanted", "skipDefaultUpdate", "false"),
    ] {
        git(&world.work, &["remote", "add", remote, "/nonexistent.git"]);
        git(
            &world.work,
            &["config", &format!("remote.{remote}.{key}"), value],
        );
    }

    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    assert_eq!(
        fetched.fetch.unwrap().remotes,
        [
            RemoteFetch {
                remote: "dead".into(),
                outcome: FetchOutcome::Skipped
            },
            RemoteFetch {
                remote: "old.mirror".into(),
                outcome: FetchOutcome::Skipped
            },
            RemoteFetch {
                remote: "origin".into(),
                outcome: FetchOutcome::Fetched
            },
            RemoteFetch {
                remote: "wanted".into(),
                outcome: FetchOutcome::Failed {
                    failure: FetchFailure::Other,
                    message: "fatal: '/nonexistent.git' does not appear to be a git repository fatal: Could not read from remote repository.".into()
                }
            },
        ]
    );
}

#[test]
fn a_hung_remote_times_out_and_leaves_no_process_behind() {
    let world = World::new();
    let coordinator = coordinator();
    let marker = format!("sleep 600.{}", std::process::id());
    let ssh = world.script("hanging-ssh", &format!("{marker}\n"));
    git(&world.work, &["config", "core.sshCommand", &ssh]);
    git(&world.work, &["config", "ssh.variant", "ssh"]);
    git(
        &world.work,
        &[
            "remote",
            "add",
            "hung",
            "ssh://git@example.invalid/team/app.git",
        ],
    );

    let started = Instant::now();
    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        fetched.fetch.clone().unwrap().remotes,
        [
            RemoteFetch {
                remote: "hung".into(),
                outcome: FetchOutcome::Failed {
                    failure: FetchFailure::TimedOut,
                    message: "hung did not answer within 2 seconds.".into()
                }
            },
            RemoteFetch {
                remote: "origin".into(),
                outcome: FetchOutcome::Fetched
            },
        ]
    );
    assert_eq!(locks(&world.work.join(".git")), Vec::<PathBuf>::new());
    let survivors = |marker: &str| {
        Command::new("pgrep")
            .args(["-f", marker])
            .output()
            .unwrap()
            .stdout
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    while !survivors(&marker).is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(String::from_utf8(survivors(&marker)).unwrap(), "");
}

fn locks(directory: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(locks(&path));
        } else if path.extension().is_some_and(|extension| extension == "lock") {
            found.push(path);
        }
    }
    found
}

#[test]
fn a_fetch_stopped_at_its_deadline_releases_its_ref_locks() {
    let world = World::new();
    let coordinator = coordinator();
    world.colleague_pushes("main", "f", "one\ntwo\n");
    let marker = format!("sleep 601.{}", std::process::id());
    let hooks = world.file("hooks");
    fs::create_dir(&hooks).unwrap();
    world.script(
        "hooks/reference-transaction",
        &format!("cat >/dev/null\nif [ \"$1\" = prepared ]; then {marker}; fi\n"),
    );
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );

    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    assert_eq!(
        fetched.fetch.unwrap().remotes,
        [RemoteFetch {
            remote: "origin".into(),
            outcome: FetchOutcome::Failed {
                failure: FetchFailure::TimedOut,
                message: "origin did not answer within 2 seconds.".into()
            }
        }]
    );
    assert_eq!(locks(&world.work.join(".git")), Vec::<PathBuf>::new());
    assert_eq!(
        git(&world.work, &["rev-parse", "refs/remotes/origin/main"]),
        world.initial
    );
    let survivors = Command::new("pgrep")
        .args(["-f", &marker])
        .output()
        .unwrap()
        .stdout;
    assert_eq!(String::from_utf8(survivors).unwrap(), "");
}

#[test]
fn probes_only_beside_a_detached_worktree_and_blocks_when_unanswered() {
    let world = World::new();
    let coordinator = Coordinator::new(Limits {
        local_deadline: Duration::ZERO,
        ..limits()
    });
    git(&world.work, &["branch", "feat"]);
    git(
        &world.work,
        &["branch", "--set-upstream-to", "origin/main", "feat"],
    );
    let target = world.colleague_pushes("main", "f", "one\ntwo\n");
    git(&world.work, &["fetch", "--quiet", "origin"]);
    git(&world.work, &["branch", "side"]);
    world.worktree("attached", "side");
    let unprobed = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    assert_eq!(
        branch(&unprobed, "feat").state,
        behind("main", &target, 1, None)
    );

    let detached = world.file("detached");
    git(
        &world.work,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            detached.to_str().unwrap(),
        ],
    );

    let local = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    let feat = branch(&local, "feat");
    assert_eq!(feat.checked_out_at, None);
    assert_eq!(
        feat.state,
        BranchState::Behind {
            upstream: upstream("main"),
            target: oid(&target),
            behind: 1,
            blocker: Some(Blocker::Unverified {
                message: "Git did not finish checking whether this branch is checked out.".into()
            })
        }
    );
}

#[test]
fn reports_gone_upstreams_and_resolves_the_default_branch() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "develop"]);
    git(&world.work, &["branch", "feat"]);
    world.publish("develop");
    world.publish("feat");
    git(&world.remote, &["branch", "--delete", "--force", "feat"]);
    git(
        &world.work,
        &["update-ref", "-d", "refs/remotes/origin/feat"],
    );

    let overview = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    let feat = branch(&overview, "feat");
    assert_eq!(feat.reference, branch_ref("feat"));
    assert_eq!(feat.oid, oid(&world.initial));
    assert_eq!(feat.checked_out_at, None);
    let roles: Vec<_> = overview
        .branches
        .iter()
        .map(|branch| (branch.name.as_str(), branch.role))
        .collect();
    assert_eq!(
        roles,
        [
            ("develop", BranchRole::Mainline),
            ("feat", BranchRole::Other),
            ("main", BranchRole::Default)
        ]
    );
    assert_eq!(
        feat.state,
        BranchState::Gone {
            upstream: upstream("feat")
        }
    );

    git(&world.work, &["remote", "set-head", "origin", "develop"]);
    let overview = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    assert_eq!(branch(&overview, "develop").role, BranchRole::Default);
    assert_eq!(branch(&overview, "main").role, BranchRole::Mainline);
}

#[test]
fn accepts_only_local_branches_and_full_object_ids() {
    for valid in [
        "refs/heads/main",
        "refs/heads/feat/x-1.2",
        "refs/heads/ünïcode",
    ] {
        assert_eq!(
            BranchRef::try_from(valid.to_owned()).unwrap().as_str(),
            valid
        );
    }
    for invalid in [
        "refs/remotes/origin/main",
        "refs/tags/v1",
        "HEAD",
        "refs/heads/",
        "refs/heads/a..b",
        "refs/heads/.hidden",
        "refs/heads/x.lock",
        "refs/heads/a b",
        "refs/heads/a:b",
        "refs/heads/-x/",
        "refs/heads/@",
        "refs/heads/a@{1}",
    ] {
        let error = BranchRef::try_from(invalid.to_owned()).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::InvalidRef), "{invalid}");
    }
    assert!(Oid::try_from("a".repeat(64)).is_ok());
    for invalid in ["A".repeat(40), "a".repeat(39), "g".repeat(40)] {
        let error = Oid::try_from(invalid).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::InvalidOid));
    }
    let error = coordinator()
        .overview("/not/a/real/l1git/path", FetchMode::Remote)
        .unwrap_err();
    assert!(matches!(error.kind, ErrorKind::MissingPath));
}
