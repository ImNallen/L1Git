use l1_git_core::{
    Coordinator, Expect, Limits, Operation, PushAvailability, PushIntent, PushOutcome, PushRefresh,
    PushUnavailable, worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn git_command(path: &Path, args: &[&str]) -> Command {
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
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.test")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.test")
        .env("GIT_AUTHOR_DATE", "1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "1700000000 +0000");
    command
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = git_command(path, args).output().unwrap();
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

    fn undo(&self) -> PathBuf {
        self.directory.path().join("undo")
    }

    fn path(&self) -> &str {
        self.work.to_str().unwrap()
    }

    fn file(&self, name: &str) -> PathBuf {
        self.directory.path().canonicalize().unwrap().join(name)
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

fn coordinator(world: &World) -> Coordinator {
    Coordinator::new(
        Limits {
            push_deadline: Duration::from_secs(10),
            ..Limits::default()
        },
        world.undo(),
    )
}
fn intent(core: &Coordinator, path: &str) -> PushIntent {
    match core.prepare_push(path).unwrap() {
        PushAvailability::Ready { intent } => intent,
        other => panic!("expected ready, got {other:?}"),
    }
}
fn refs(path: &Path) -> String {
    git(path, &["for-each-ref", "--format=%(refname) %(objectname)"])
}
fn local(world: &World, core: &Coordinator) -> (String, String, Vec<u8>, String) {
    (
        git(&world.work, &["rev-parse", "HEAD"]),
        git(&world.work, &["ls-files", "-s"]),
        fs::read(world.work.join("f")).unwrap(),
        serde_json::to_string(&core.undo_history(world.path()).unwrap()).unwrap(),
    )
}
fn only_main(world: &World, before: &str, oid: &str) {
    let expected = before
        .lines()
        .map(|line| {
            if line.starts_with("refs/heads/main ") {
                format!("refs/heads/main {oid}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(refs(&world.remote), expected);
}

#[test]
fn pushes_exact_source_and_destination_despite_widening_configuration() {
    let world = World::new();
    let core = coordinator(&world);
    git(&world.work, &["branch", "other"]);
    git(&world.work, &["push", "origin", "other"]);
    let oid = commit(&world.work, "f", "two\n", "two");
    git(&world.work, &["tag", "-a", "unpublished", "-m", "tag"]);
    for (key, value) in [
        ("push.default", "matching"),
        ("remote.origin.push", "refs/heads/*:refs/heads/*"),
        ("push.followTags", "true"),
        ("push.recurseSubmodules", "on-demand"),
        ("branch.main.pushRemote", "nonexistent"),
        ("remote.pushDefault", "nonexistent"),
        ("push.pushOption", "must-be-cleared"),
    ] {
        git(&world.work, &["config", key, value]);
    }
    fs::write(world.work.join("f"), "dirty\n").unwrap();
    let before = refs(&world.remote);
    let unchanged = local(&world, &core);
    let prepared = intent(&core, world.path());
    assert_eq!(prepared.source.as_str(), oid);
    let report = core.push(world.path(), &prepared).unwrap();
    assert_eq!(report.outcome, PushOutcome::Pushed);
    assert!(matches!(report.refresh, PushRefresh::Refreshed { .. }));
    only_main(&world, &before, &oid);
    assert_eq!(local(&world, &core), unchanged);
    assert_eq!(
        core.push(world.path(), &prepared).unwrap().outcome,
        PushOutcome::UpToDate
    );
    only_main(&world, &before, &oid);
}

#[test]
fn resolves_upstream_name_custom_fetch_mapping_and_separate_pushurl() {
    let world = World::new();
    let core = coordinator(&world);
    let other = world.file("push.git");
    git(
        world.directory.path(),
        &[
            "clone",
            "--bare",
            world.remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(
        &world.work,
        &["config", "remote.origin.pushurl", other.to_str().unwrap()],
    );
    git(
        &world.work,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/custom/*",
        ],
    );
    git(
        &world.work,
        &["config", "branch.main.merge", "refs/heads/published"],
    );
    git(
        &world.work,
        &["push", "origin", "HEAD:refs/heads/published"],
    );
    git(&world.work, &["fetch", "origin"]);
    let before_fetch = refs(&world.remote);
    let before = refs(&other);
    let oid = commit(&world.work, "f", "two\n", "two");
    let prepared = intent(&core, world.path());
    assert_eq!(prepared.destination.as_str(), "refs/heads/published");
    assert_eq!(prepared.remote, "origin");
    assert_eq!(
        core.push(world.path(), &prepared).unwrap().outcome,
        PushOutcome::Pushed
    );
    assert_eq!(refs(&world.remote), before_fetch);
    assert_eq!(
        refs(&other),
        before
            .lines()
            .map(|line| if line.starts_with("refs/heads/published ") {
                format!("refs/heads/published {oid}")
            } else {
                line.to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(
        git(&world.work, &["rev-parse", "refs/custom/published"]),
        oid
    );
}

#[test]
fn refuses_unsupported_targets_without_publication() {
    let world = World::new();
    let core = coordinator(&world);
    let before = refs(&world.remote);
    git(&world.work, &["config", "remote.origin.mirror", "false"]);
    for (key, value, reason) in [
        ("remote.origin.mirror", "true", PushUnavailable::Mirror),
        ("branch.main.remote", ".", PushUnavailable::LocalUpstream),
        (
            "branch.main.merge",
            "refs/tags/no",
            PushUnavailable::UnsupportedConfiguration,
        ),
    ] {
        let old = git(&world.work, &["config", "--get", key]);
        git(&world.work, &["config", key, value]);
        assert_eq!(
            core.prepare_push(world.path()).unwrap(),
            PushAvailability::Unavailable { reason }
        );
        git(&world.work, &["config", key, &old]);
    }
    git(
        &world.work,
        &[
            "config",
            "--add",
            "remote.origin.pushurl",
            world.remote.to_str().unwrap(),
        ],
    );
    git(
        &world.work,
        &[
            "config",
            "--add",
            "remote.origin.pushurl",
            world.remote.to_str().unwrap(),
        ],
    );
    assert_eq!(
        core.prepare_push(world.path()).unwrap(),
        PushAvailability::Unavailable {
            reason: PushUnavailable::MultipleEndpoints
        }
    );
    git(
        &world.work,
        &["config", "--unset-all", "remote.origin.pushurl"],
    );

    git(
        &world.work,
        &[
            "config",
            "--add",
            "remote.origin.url",
            world.remote.to_str().unwrap(),
        ],
    );
    assert_eq!(
        core.prepare_push(world.path()).unwrap(),
        PushAvailability::Unavailable {
            reason: PushUnavailable::MultipleEndpoints
        }
    );
    git(&world.work, &["config", "--unset-all", "remote.origin.url"]);
    git(
        &world.work,
        &[
            "config",
            "remote.origin.url",
            world.remote.to_str().unwrap(),
        ],
    );
    git(&world.work, &["switch", "--detach", "--quiet"]);
    assert_eq!(
        core.prepare_push(world.path()).unwrap(),
        PushAvailability::Unavailable {
            reason: PushUnavailable::Detached
        }
    );
    git(&world.work, &["switch", "--orphan", "empty", "--quiet"]);
    assert_eq!(
        core.prepare_push(world.path()).unwrap(),
        PushAvailability::Unavailable {
            reason: PushUnavailable::Unborn
        }
    );
    assert_eq!(refs(&world.remote), before);
}

#[test]
fn changed_remote_transport_refuses_a_prepared_push() {
    let world = World::new();
    let core = coordinator(&world);
    commit(&world.work, "f", "two\n", "two");
    let prepared = intent(&core, world.path());
    let before = refs(&world.remote);
    git(&world.work, &["config", "remote.origin.vcs", "ext"]);
    assert_eq!(
        core.push(world.path(), &prepared).unwrap().outcome,
        PushOutcome::Stale
    );
    assert_eq!(refs(&world.remote), before);
}

#[test]
fn stale_source_checkout_and_destination_do_not_publish() {
    let world = World::new();
    let core = coordinator(&world);
    let before = refs(&world.remote);
    let first = intent(&core, world.path());
    commit(&world.work, "f", "two\n", "two");
    assert_eq!(
        core.push(world.path(), &first).unwrap().outcome,
        PushOutcome::Stale
    );
    let current = intent(&core, world.path());
    let other = world.file("other.git");
    git(
        world.directory.path(),
        &["init", "--bare", other.to_str().unwrap()],
    );
    git(
        &world.work,
        &["config", "remote.origin.url", other.to_str().unwrap()],
    );
    assert_eq!(intent(&core, world.path()).endpoint, current.endpoint);
    assert_eq!(
        core.push(world.path(), &current).unwrap().outcome,
        PushOutcome::Stale
    );
    assert_eq!(refs(&other), "");
    git(
        &world.work,
        &[
            "config",
            "remote.origin.url",
            world.remote.to_str().unwrap(),
        ],
    );

    git(
        &world.work,
        &["config", "branch.main.merge", "refs/heads/other"],
    );
    assert_eq!(
        core.push(world.path(), &current).unwrap().outcome,
        PushOutcome::Stale
    );
    git(
        &world.work,
        &["config", "branch.main.merge", "refs/heads/main"],
    );
    git(&world.work, &["switch", "--quiet", "-c", "other"]);
    assert_eq!(
        core.push(world.path(), &current).unwrap().outcome,
        PushOutcome::Stale
    );
    assert_eq!(refs(&world.remote), before);
}

#[test]
fn uses_the_clicked_worktree_and_handles_equals_in_remote_name() {
    let world = World::new();
    let core = coordinator(&world);
    git(&world.work, &["remote", "rename", "origin", "a=b"]);
    git(&world.work, &["branch", "--track", "feature", "a=b/main"]);
    let worktree = world.worktree("linked", "feature");
    let path = worktree.to_str().unwrap();
    let oid = commit(&worktree, "f", "linked\n", "linked");
    let before = refs(&world.remote);
    let prepared = intent(&core, path);
    assert_eq!(prepared.branch.as_str(), "refs/heads/feature");
    assert_eq!(
        core.push(world.path(), &prepared).unwrap().outcome,
        PushOutcome::Stale
    );
    assert_eq!(
        core.push(path, &prepared).unwrap().outcome,
        PushOutcome::Pushed
    );
    only_main(&world, &before, &oid);
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), world.initial);
}

#[test]
fn remote_non_fast_forward_and_receive_hook_rejections_are_explicit() {
    let world = World::new();
    let core = coordinator(&world);
    world.colleague_pushes("main", "colleague", "new\n");
    commit(&world.work, "f", "ours\n", "ours");
    let before = refs(&world.remote);
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Rejected { .. }
    ));
    assert_eq!(refs(&world.remote), before);
}

#[test]
fn preserves_hooks_and_known_publication_when_refresh_fails() {
    let world = World::new();
    let core = coordinator(&world);
    let hooks = world.file("hooks");
    fs::create_dir(&hooks).unwrap();
    let script = world.script("receive", "exit 1\n");
    fs::copy(script, world.remote.join("hooks/pre-receive")).unwrap();
    let oid = commit(&world.work, "f", "two\n", "two");
    let before = refs(&world.remote);
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Rejected { .. }
    ));
    assert_eq!(refs(&world.remote), before);
    fs::remove_file(world.remote.join("hooks/pre-receive")).unwrap();
    let script = world.script(
        "pre-push",
        "git config remote.origin.fetch 'invalid:ref:spec'\n",
    );
    fs::copy(script, hooks.join("pre-push")).unwrap();
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let report = core
        .push(world.path(), &intent(&core, world.path()))
        .unwrap();
    assert_eq!(report.outcome, PushOutcome::Pushed);
    assert!(matches!(report.refresh, PushRefresh::Failed { .. }));
    only_main(&world, &before, &oid);
}

fn wait_for(path: &Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "hook did not start"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn source_is_pinned_while_a_concurrent_local_commit_finishes() {
    let world = World::new();
    let core = Arc::new(coordinator(&world));
    let oid = commit(&world.work, "f", "two\n", "two");
    let hooks = world.file("hooks");
    fs::create_dir(&hooks).unwrap();
    let started = world.file("started");
    let proceed = world.file("proceed");
    let script = world.script(
        "pre-push",
        &format!(
            "touch '{}'\nwhile test ! -f '{}'; do sleep 0.01; done\n",
            started.display(),
            proceed.display()
        ),
    );
    fs::copy(script, hooks.join("pre-push")).unwrap();
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let prepared = intent(&core, world.path());
    let path = world.path().to_owned();
    let shared = Arc::clone(&core);
    let pushed = thread::spawn(move || shared.push(&path, &prepared).unwrap());
    wait_for(&started);
    fs::write(world.work.join("f"), "three\n").unwrap();
    git(&world.work, &["add", "f"]);
    git(&world.work, &["config", "user.name", "Ada"]);
    git(&world.work, &["config", "user.email", "ada@example.test"]);
    let status = worktree_status(world.path()).unwrap();
    core.write(
        world.path(),
        &Operation::Commit {
            message: "three".into(),
            staged: status.staged_stamp,
        },
        &Expect { head: status.head },
    )
    .unwrap();
    let newer = git(&world.work, &["rev-parse", "HEAD"]);
    fs::write(proceed, "go").unwrap();
    assert_eq!(pushed.join().unwrap().outcome, PushOutcome::Pushed);
    assert_eq!(git(&world.remote, &["rev-parse", "main"]), oid);
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), newer);
}

#[test]
fn timeout_after_acceptance_is_uncertain_and_auth_failure_is_redacted() {
    let world = World::new();
    let core = Coordinator::new(
        Limits {
            push_deadline: Duration::from_secs(2),
            ..Limits::default()
        },
        world.undo(),
    );
    let oid = commit(&world.work, "f", "two\n", "two");
    let script = world.script("post-receive", "sleep 10\n");
    fs::copy(script, world.remote.join("hooks/post-receive")).unwrap();
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Uncertain { .. }
    ));
    assert_eq!(git(&world.remote, &["rev-parse", "main"]), oid);
    git(
        &world.work,
        &[
            "config",
            "remote.origin.url",
            "ssh://secret:password@example.invalid/repo?token=secret",
        ],
    );
    let script = world.script(
        "ssh",
        "echo 'Permission denied (publickey). secret:password' >&2\nexit 1\n",
    );
    git(&world.work, &["config", "core.sshCommand", &script]);
    let prepared = intent(&core, world.path());
    let wire = serde_json::to_string(&prepared).unwrap();
    assert!(!wire.contains("secret"));
    assert!(!wire.contains("password"));
    let outcome = core.push(world.path(), &prepared).unwrap().outcome;
    assert!(matches!(outcome, PushOutcome::Failed { .. }));
    assert!(
        !serde_json::to_string(&outcome)
            .unwrap()
            .contains("password")
    );
}

#[test]
fn no_upstream_and_ambiguous_merge_are_unavailable() {
    let world = World::new();
    let core = coordinator(&world);
    git(&world.work, &["config", "--unset", "branch.main.merge"]);
    assert_eq!(
        core.prepare_push(world.path()).unwrap(),
        PushAvailability::Unavailable {
            reason: PushUnavailable::UnsupportedConfiguration
        }
    );
    git(
        &world.work,
        &["config", "--add", "branch.main.merge", "refs/heads/main"],
    );
    git(
        &world.work,
        &["config", "--add", "branch.main.merge", "refs/heads/other"],
    );
    assert_eq!(
        core.prepare_push(world.path()).unwrap(),
        PushAvailability::Unavailable {
            reason: PushUnavailable::UnsupportedConfiguration
        }
    );
}

#[test]
fn pre_push_hook_output_preserves_complete_publication_status() {
    let world = World::new();
    let core = coordinator(&world);
    let hooks = world.file("hooks");
    fs::create_dir(&hooks).unwrap();
    let script = world.script(
        "pre-push",
        "echo 'pre-push checks passed'\nprintf 'To run lint: use the project script\\nchecks\\tpassed\\n'\n",
    );
    fs::copy(script, hooks.join("pre-push")).unwrap();
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let oid = commit(&world.work, "f", "two\n", "two");
    let before = refs(&world.remote);
    let prepared = intent(&core, world.path());
    assert_eq!(
        core.push(world.path(), &prepared).unwrap().outcome,
        PushOutcome::Pushed
    );
    only_main(&world, &before, &oid);
    assert_eq!(
        core.push(world.path(), &prepared).unwrap().outcome,
        PushOutcome::UpToDate
    );
    only_main(&world, &before, &oid);
    let reject = world.script("reject", "exit 1\n");
    fs::copy(reject, world.remote.join("hooks/pre-receive")).unwrap();
    commit(&world.work, "f", "three\n", "three");
    let before_rejection = refs(&world.remote);
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Rejected { .. }
    ));
    assert_eq!(refs(&world.remote), before_rejection);
}

#[test]
fn capped_hook_output_cannot_confirm_publication_and_does_not_deadlock() {
    let world = World::new();
    let core = coordinator(&world);
    let oid = commit(&world.work, "f", "two\n", "two");
    let before = refs(&world.remote);
    let hooks = world.file("hooks");
    fs::create_dir(&hooks).unwrap();
    let script = world.script(
        "pre-push",
        "head -c 200000 /dev/zero | tr '\\000' x\nhead -c 200000 /dev/zero | tr '\\000' x >&2\n",
    );
    fs::copy(script, hooks.join("pre-push")).unwrap();
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Uncertain { .. }
    ));
    only_main(&world, &before, &oid);
}

#[test]
fn pre_push_hook_refusal_and_required_signing_are_honored() {
    let world = World::new();
    let core = coordinator(&world);
    commit(&world.work, "f", "two\n", "two");
    let before = refs(&world.remote);
    let hooks = world.file("hooks");
    fs::create_dir(&hooks).unwrap();
    let marker = world.file("hook-invoked");
    let script = world.script(
        "pre-push",
        &format!("echo \"$1\" > '{}'\nexit 1\n", marker.display()),
    );
    fs::copy(script, hooks.join("pre-push")).unwrap();
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Uncertain { .. }
    ));
    assert_eq!(fs::read_to_string(marker).unwrap(), "origin\n");
    assert_eq!(refs(&world.remote), before);
    git(&world.work, &["config", "core.hooksPath", "/dev/null"]);
    git(&world.work, &["config", "push.gpgSign", "true"]);
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Uncertain { .. }
    ));
    assert_eq!(refs(&world.remote), before);
}

#[test]
fn network_loss_cannot_claim_no_publication() {
    let world = World::new();
    let core = coordinator(&world);
    let before = refs(&world.remote);
    let script = world.script("ssh", "echo 'Connection reset by peer' >&2\nexit 1\n");
    git(
        &world.work,
        &["config", "remote.origin.url", "ssh://example.invalid/repo"],
    );
    git(&world.work, &["config", "core.sshCommand", &script]);
    assert!(matches!(
        core.push(world.path(), &intent(&core, world.path()))
            .unwrap()
            .outcome,
        PushOutcome::Uncertain { .. }
    ));
    assert_eq!(refs(&world.remote), before);
}

#[test]
fn authentication_refusal_never_opens_configured_askpass() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    let world = World::new();
    let core = coordinator(&world);
    let before = refs(&world.remote);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/private.git", listener.local_addr().unwrap());
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&stopped);
    let server = thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .unwrap();
                    let _ = stream.read(&mut [0; 4096]);
                    let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"private\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(error) => panic!("private auth server: {error}"),
            }
        }
    });
    let marker = world.file("askpass-opened");
    let askpass = world.script(
        "askpass",
        &format!("touch '{}'\nexit 1\n", marker.display()),
    );
    git(&world.work, &["config", "remote.origin.url", &endpoint]);
    git(&world.work, &["config", "credential.helper", ""]);
    git(&world.work, &["config", "core.askPass", &askpass]);
    let outcome = core
        .push(world.path(), &intent(&core, world.path()))
        .unwrap()
        .outcome;
    stopped.store(true, Ordering::SeqCst);
    server.join().unwrap();
    assert!(matches!(outcome, PushOutcome::Failed { .. }), "{outcome:?}");
    assert!(!marker.exists(), "an authentication prompt was opened");
    assert_eq!(refs(&world.remote), before);
}

fn untracked(world: &World) {
    git(&world.work, &["config", "--unset", "branch.main.remote"]);
    git(&world.work, &["config", "--unset", "branch.main.merge"]);
}

fn publish_intent(core: &Coordinator, world: &World, destination: &str) -> PushIntent {
    let choice = l1_git_core::PublishChoice {
        remote: "origin".into(),
        destination: l1_git_core::BranchRef::try_from(format!("refs/heads/{destination}")).unwrap(),
    };
    match core.prepare_publish(world.path(), &choice).unwrap() {
        PushAvailability::Ready { intent } => intent,
        other => panic!("{other:?}"),
    }
}

fn no_tracking(world: &World) {
    for suffix in ["remote", "merge"] {
        assert_eq!(
            git_command(
                &world.work,
                &["config", "--get-all", &format!("branch.main.{suffix}")]
            )
            .output()
            .unwrap()
            .status
            .code(),
            Some(1)
        );
    }
}

fn tracking(world: &World, destination: &str) {
    assert_eq!(
        git(&world.work, &["config", "--get-all", "branch.main.remote"]),
        "origin"
    );
    assert_eq!(
        git(&world.work, &["config", "--get-all", "branch.main.merge"]),
        format!("refs/heads/{destination}")
    );
}

fn publish_hook(world: &World, body: &str) {
    let hooks = world.file("publish-hooks");
    fs::create_dir(&hooks).unwrap();
    fs::copy(world.script("publish-hook", body), hooks.join("pre-push")).unwrap();
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
}

#[test]
fn publishes_new_equal_and_fast_forward_without_touching_local_state() {
    for destination in ["new-target", "main"] {
        for advance in [false, true] {
            let world = World::new();
            untracked(&world);
            if advance {
                commit(&world.work, "f", "two\n", "two");
            }
            fs::write(world.work.join("dirty"), "untracked\n").unwrap();
            fs::write(world.work.join("f"), "staged\n").unwrap();
            git(&world.work, &["add", "f"]);
            fs::write(world.work.join("f"), "unstaged\n").unwrap();
            let core = coordinator(&world);
            publish_hook(
                &world,
                "git config unrelated.fromHook preserved\ngit config url./unrelated/.insteadOf never-used:\n",
            );
            let before_refs = refs(&world.remote);
            let head = git(&world.work, &["rev-parse", "HEAD"]);
            let index = fs::read(world.work.join(".git/index")).unwrap();
            let status = git(&world.work, &["status", "--porcelain"]);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    world.work.join(".git/config"),
                    fs::Permissions::from_mode(0o640),
                )
                .unwrap();
            }
            let intent = publish_intent(&core, &world, destination);
            let report = core.push(world.path(), &intent).unwrap();
            assert_eq!(
                report.outcome,
                PushOutcome::Published {
                    tracking: l1_git_core::TrackingOutcome::Set
                }
            );
            let after = refs(&world.remote);
            let target = format!("refs/heads/{destination} ");
            let mut expected: Vec<_> = before_refs
                .lines()
                .filter(|line| !line.starts_with(&target))
                .map(str::to_owned)
                .collect();
            expected.push(format!("{target}{head}"));
            expected.sort();
            assert_eq!(after, expected.join("\n"));
            tracking(&world, destination);
            assert_eq!(
                git(&world.work, &["config", "unrelated.fromHook"]),
                "preserved"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(world.work.join(".git/config"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o640
                );
            }
            assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), head);
            assert_eq!(fs::read(world.work.join(".git/index")).unwrap(), index);
            assert_eq!(git(&world.work, &["status", "--porcelain"]), status);
            assert_eq!(
                fs::read_to_string(world.work.join("f")).unwrap(),
                "unstaged\n"
            );
            assert_eq!(
                fs::read_to_string(world.work.join("dirty")).unwrap(),
                "untracked\n"
            );
            assert!(!world.undo().exists());
        }
    }
}

#[test]
fn symbolic_tracking_refs_cannot_move_local_branches_on_publication() {
    for existing_upstream in [false, true] {
        for chained in [false, true] {
            let world = World::new();
            if !existing_upstream {
                untracked(&world);
            }
            git(&world.work, &["branch", "unrelated"]);
            commit(&world.work, "f", "two\n", "two");
            git(
                &world.work,
                &[
                    "config",
                    "remote.origin.fetch",
                    "+refs/heads/main:refs/remotes/origin/alias",
                ],
            );
            if chained {
                git(
                    &world.work,
                    &[
                        "symbolic-ref",
                        "refs/remotes/origin/next",
                        "refs/heads/unrelated",
                    ],
                );
            }
            git(
                &world.work,
                &[
                    "symbolic-ref",
                    "refs/remotes/origin/alias",
                    if chained {
                        "refs/remotes/origin/next"
                    } else {
                        "refs/heads/unrelated"
                    },
                ],
            );
            let before = refs(&world.remote);
            let local = refs(&world.work);
            let core = coordinator(&world);
            let availability = if existing_upstream {
                core.prepare_push(world.path()).unwrap()
            } else {
                core.prepare_publish(
                    world.path(),
                    &l1_git_core::PublishChoice {
                        remote: "origin".into(),
                        destination: l1_git_core::BranchRef::try_from("refs/heads/main".to_owned())
                            .unwrap(),
                    },
                )
                .unwrap()
            };
            assert!(
                matches!(availability, PushAvailability::Unavailable { .. }),
                "{availability:?}"
            );
            git(
                &world.work,
                &[
                    "update-ref",
                    "--no-deref",
                    "-d",
                    "refs/remotes/origin/alias",
                ],
            );
            let reviewed = if existing_upstream {
                intent(&core, world.path())
            } else {
                publish_intent(&core, &world, "main")
            };
            git(
                &world.work,
                &[
                    "symbolic-ref",
                    "refs/remotes/origin/alias",
                    "refs/heads/unrelated",
                ],
            );
            assert_eq!(
                core.push(world.path(), &reviewed).unwrap().outcome,
                PushOutcome::Stale
            );
            assert_eq!(refs(&world.remote), before);
            assert_eq!(refs(&world.work), local);
        }
    }
}

#[test]
fn ordinary_push_refuses_tracking_updates_to_local_branches_and_tags() {
    for source in ["refs/heads/main", "heads/main", "main"] {
        for target in ["refs/heads/unrelated", "refs/tags/unrelated"] {
            let world = World::new();
            let core = coordinator(&world);
            let reviewed = intent(&core, world.path());
            git(
                &world.work,
                &[
                    "config",
                    "remote.origin.fetch",
                    &format!("+{source}:{target}"),
                ],
            );
            assert!(matches!(
                core.prepare_push(world.path()).unwrap(),
                PushAvailability::Unavailable { .. }
            ));
            let before = refs(&world.work);
            let remote = refs(&world.remote);
            assert_eq!(
                core.push(world.path(), &reviewed).unwrap().outcome,
                PushOutcome::Stale
            );
            assert_eq!(refs(&world.work), before);
            assert_eq!(refs(&world.remote), remote);
        }
    }
}

#[test]
fn hook_cannot_redirect_tracking_updates_to_a_local_branch() {
    for publishing in [false, true] {
        for mapping in [
            "+refs/heads/main:refs/remotes/origin/alias",
            "+refs/heads/*:refs/remotes/origin/*",
        ] {
            let world = World::new();
            if publishing {
                untracked(&world);
            }
            git(&world.work, &["branch", "unrelated"]);
            let oid = commit(&world.work, "f", "two\n", "two");
            git(&world.work, &["config", "remote.origin.fetch", mapping]);
            let target = if mapping.contains('*') {
                "refs/remotes/origin/main"
            } else {
                "refs/remotes/origin/alias"
            };
            publish_hook(
                &world,
                &format!("git symbolic-ref {target} refs/heads/unrelated\n"),
            );
            let core = coordinator(&world);
            let reviewed = if publishing {
                publish_intent(&core, &world, "main")
            } else {
                intent(&core, world.path())
            };
            let report = core.push(world.path(), &reviewed).unwrap();
            assert!(
                matches!(
                    report.outcome,
                    PushOutcome::Published { .. } | PushOutcome::Pushed
                ),
                "{report:?}"
            );
            assert_eq!(git(&world.work, &["rev-parse", "unrelated"]), world.initial);
            assert_eq!(git(&world.remote, &["rev-parse", "main"]), oid);
        }
    }
}

#[test]
fn changed_tracking_ref_is_preserved_after_confirmed_publication() {
    let world = World::new();
    let oid = commit(&world.work, "f", "two\n", "two");
    let tree = git(&world.work, &["rev-parse", "HEAD^{tree}"]);
    let newer = git(
        &world.work,
        &["commit-tree", &tree, "-p", &oid, "-m", "concurrent update"],
    );
    publish_hook(
        &world,
        &format!("git update-ref refs/remotes/origin/main {newer}\n"),
    );
    let core = coordinator(&world);
    let report = core
        .push(world.path(), &intent(&core, world.path()))
        .unwrap();
    assert_eq!(report.outcome, PushOutcome::Pushed);
    assert!(matches!(report.refresh, PushRefresh::Failed { .. }));
    assert_eq!(
        git(&world.work, &["rev-parse", "refs/remotes/origin/main"]),
        newer
    );
    assert_eq!(git(&world.remote, &["rev-parse", "main"]), oid);
}

#[test]
fn publish_options_handle_no_remotes_partial_config_and_remote_policy() {
    let world = World::new();
    let core = coordinator(&world);
    git(&world.work, &["config", "--unset", "branch.main.merge"]);
    assert!(matches!(
        core.publish_options(world.path()).unwrap(),
        l1_git_core::PublishOptions::Unavailable {
            reason: PushUnavailable::UnsupportedConfiguration
        }
    ));
    git(&world.work, &["config", "--unset", "branch.main.remote"]);
    git(&world.work, &["config", "remote.origin.mirror", "true"]);
    let options = serde_json::to_value(core.publish_options(world.path()).unwrap()).unwrap();
    assert_eq!(options["remotes"][0]["availability"]["reason"], "mirror");
    git(&world.work, &["remote", "remove", "origin"]);
    let options = serde_json::to_value(core.publish_options(world.path()).unwrap()).unwrap();
    assert_eq!(options["remotes"], serde_json::json!([]));
}

#[test]
fn stale_publish_source_target_and_config_never_send_or_set_tracking() {
    for change in [
        "source",
        "remote",
        "mapping",
        "tracking",
        "destination",
        "purpose",
        "fingerprint",
        "rewrite",
    ] {
        let world = World::new();
        untracked(&world);
        let core = coordinator(&world);
        let mut intent = publish_intent(&core, &world, "reviewed");
        match change {
            "source" => {
                commit(&world.work, "f", "two\n", "two");
            }
            "remote" => {
                git(
                    &world.work,
                    &["config", "remote.origin.pushurl", "/different.git"],
                );
            }
            "rewrite" => {
                git(
                    &world.work,
                    &[
                        "config",
                        "url./changed/.insteadOf",
                        world.remote.to_str().unwrap(),
                    ],
                );
            }
            "mapping" => {
                git(
                    &world.work,
                    &[
                        "config",
                        "remote.origin.fetch",
                        "+refs/heads/*:refs/remotes/custom/*",
                    ],
                );
            }
            "tracking" => {
                git(&world.work, &["config", "branch.main.remote", "other"]);
            }
            "destination" => {
                intent.destination =
                    l1_git_core::BranchRef::try_from("refs/heads/unreviewed".to_owned()).unwrap();
            }
            "purpose" => intent.purpose = l1_git_core::PushPurpose::Upstream,
            "fingerprint" => intent.fingerprint = "a".repeat(40),
            _ => unreachable!(),
        }
        let before = refs(&world.remote);
        assert_eq!(
            core.push(world.path(), &intent).unwrap().outcome,
            PushOutcome::Stale,
            "{change}"
        );
        assert_eq!(refs(&world.remote), before);
        if change != "tracking" {
            no_tracking(&world);
        }
    }
}

#[test]
fn publish_rejection_and_uncertainty_never_set_tracking() {
    for scenario in ["diverged", "refused", "uncertain"] {
        let world = World::new();
        untracked(&world);
        let core = coordinator(&world);
        if scenario == "diverged" {
            world.colleague_pushes("main", "colleague", "new\n");
            commit(&world.work, "local", "new\n", "diverge");
        } else if scenario == "refused" {
            commit(&world.work, "local", "new\n", "new");
            fs::copy(
                world.script("reject-publication", "exit 1\n"),
                world.remote.join("hooks/pre-receive"),
            )
            .unwrap();
        } else {
            publish_hook(&world, "exit 1\n");
        }
        let before = refs(&world.remote);
        let report = core
            .push(world.path(), &publish_intent(&core, &world, "main"))
            .unwrap();
        assert!(
            matches!(
                report.outcome,
                PushOutcome::Rejected { .. } | PushOutcome::Uncertain { .. }
            ),
            "{report:?}"
        );
        no_tracking(&world);
        assert_eq!(refs(&world.remote), before);
    }
}

#[test]
fn post_hook_changes_skip_tracking_but_keep_exact_publication() {
    for script in [
        "git switch --quiet -c other\n",
        "git -c user.name=Ada -c user.email=ada@example.test commit --quiet --allow-empty -m hook\n",
        "git config branch.main.remote another\n",
        "git config remote.origin.fetch invalid:ref:spec\n",
        "git config remote.origin.pushurl /not-reviewed.git\n",
    ] {
        let world = World::new();
        untracked(&world);
        let core = coordinator(&world);
        publish_hook(&world, script);
        let intent = publish_intent(&core, &world, "reviewed");
        let report = core.push(world.path(), &intent).unwrap();
        assert!(
            matches!(
                report.outcome,
                PushOutcome::Published {
                    tracking: l1_git_core::TrackingOutcome::SkippedChanged { .. }
                        | l1_git_core::TrackingOutcome::Failed { .. }
                }
            ),
            "{report:?}"
        );
        assert_eq!(
            git(&world.remote, &["rev-parse", "reviewed"]),
            intent.source.as_str()
        );
        if !script.contains("branch.main.remote") {
            no_tracking(&world);
        }
        assert_eq!(
            git_command(&world.work, &["config", "--get", "branch.other.remote"])
                .output()
                .unwrap()
                .status
                .code(),
            Some(1)
        );
        if script.contains("invalid:ref:spec") {
            assert!(matches!(report.refresh, PushRefresh::Failed { .. }));
        }
    }
}

#[test]
fn config_lock_failure_is_atomic_and_preserves_the_unowned_lock() {
    let world = World::new();
    untracked(&world);
    let core = coordinator(&world);
    let intent = publish_intent(&core, &world, "published");
    let config = fs::read(world.work.join(".git/config")).unwrap();
    fs::write(world.work.join(".git/config.lock"), "another process").unwrap();
    let report = core.push(world.path(), &intent).unwrap();
    assert!(matches!(
        report.outcome,
        PushOutcome::Published {
            tracking: l1_git_core::TrackingOutcome::Failed { .. }
        }
    ));
    assert_eq!(
        git(&world.remote, &["rev-parse", "published"]),
        intent.source.as_str()
    );
    no_tracking(&world);
    assert_eq!(fs::read(world.work.join(".git/config")).unwrap(), config);
    assert_eq!(
        fs::read_to_string(world.work.join(".git/config.lock")).unwrap(),
        "another process"
    );
}

#[test]
fn custom_mapping_includes_worktree_config_and_fresh_unrelated_edits_work() {
    let world = World::new();
    untracked(&world);
    let core = coordinator(&world);
    let include = world.file("unrelated-config");
    fs::write(&include, "[unrelated]\n value = included\n").unwrap();
    git(
        &world.work,
        &["config", "include.path", include.to_str().unwrap()],
    );
    git(
        &world.work,
        &["config", "extensions.worktreeConfig", "true"],
    );
    git(
        &world.work,
        &["config", "--worktree", "unrelated.worktree", "kept"],
    );
    git(
        &world.work,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/custom/*",
        ],
    );
    git(&world.work, &["switch", "--quiet", "-c", "spare"]);
    let linked = world.worktree("linked-publish", "main");
    let choice = l1_git_core::PublishChoice {
        remote: "origin".into(),
        destination: l1_git_core::BranchRef::try_from("refs/heads/custom".to_owned()).unwrap(),
    };
    let PushAvailability::Ready { intent } = core
        .prepare_publish(linked.to_str().unwrap(), &choice)
        .unwrap()
    else {
        panic!("not ready")
    };
    git(&world.work, &["config", "unrelated.fresh", "preserved"]);
    let report = core.push(linked.to_str().unwrap(), &intent).unwrap();
    assert_eq!(
        report.outcome,
        PushOutcome::Published {
            tracking: l1_git_core::TrackingOutcome::Set
        }
    );
    assert_eq!(
        git(&linked, &["rev-parse", "main@{upstream}"]),
        intent.source.as_str()
    );
    assert_eq!(
        git(&world.work, &["config", "unrelated.fresh"]),
        "preserved"
    );
    assert_eq!(git(&world.work, &["config", "unrelated.value"]), "included");
    assert_eq!(
        git(&world.work, &["config", "--worktree", "unrelated.worktree"]),
        "kept"
    );
}

#[test]
fn relevant_negative_and_ambiguous_fetch_mappings_are_unavailable() {
    for mapping in [
        "^refs/heads/blocked",
        "+refs/heads/blocked:refs/remotes/other/blocked",
        "+refs/heads/*:refs/heads/*",
        "+refs/heads/other:refs/remotes/origin/blocked",
        "+refs/heads/blocked:refs/stash",
    ] {
        let world = World::new();
        untracked(&world);
        let core = coordinator(&world);
        git(
            &world.work,
            &["config", "--add", "remote.origin.fetch", mapping],
        );
        let choice = l1_git_core::PublishChoice {
            remote: "origin".into(),
            destination: l1_git_core::BranchRef::try_from("refs/heads/blocked".to_owned()).unwrap(),
        };
        assert_eq!(
            core.prepare_publish(world.path(), &choice).unwrap(),
            PushAvailability::Unavailable {
                reason: PushUnavailable::UnusableFetchMapping
            }
        );
        no_tracking(&world);
    }
    let world = World::new();
    untracked(&world);
    git(
        &world.work,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "^refs/heads/unrelated",
        ],
    );
    assert_eq!(
        publish_intent(&coordinator(&world), &world, "allowed").purpose,
        l1_git_core::PushPurpose::Publish
    );
}

#[test]
fn confirmed_publication_survives_tracking_and_refresh_failure_and_keeps_fresh_config() {
    let world = World::new();
    untracked(&world);
    let core = coordinator(&world);
    publish_hook(
        &world,
        "git config unrelated.fromHook preserved\ngit config remote.broken.url /not-used.git\ngit config remote.broken.fetch invalid:ref:spec\n",
    );
    let intent = publish_intent(&core, &world, "published");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            world.work.join(".git/config"),
            fs::Permissions::from_mode(0o640),
        )
        .unwrap();
    }
    let report = core.push(world.path(), &intent).unwrap();
    assert!(matches!(
        report.outcome,
        PushOutcome::Published {
            tracking: l1_git_core::TrackingOutcome::Failed { .. }
        }
    ));
    assert!(matches!(report.refresh, PushRefresh::Failed { .. }));
    assert_eq!(
        git(&world.remote, &["rev-parse", "published"]),
        intent.source.as_str()
    );
    assert_eq!(
        git(&world.work, &["config", "unrelated.fromHook"]),
        "preserved"
    );
    no_tracking(&world);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(world.work.join(".git/config"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
}

#[test]
fn a_timeout_after_remote_acceptance_does_not_set_tracking() {
    let world = World::new();
    untracked(&world);
    let core = Coordinator::new(
        Limits {
            push_deadline: Duration::from_secs(2),
            ..Limits::default()
        },
        world.undo(),
    );
    fs::copy(
        world.script("slow-receive", "sleep 10\n"),
        world.remote.join("hooks/post-receive"),
    )
    .unwrap();
    let intent = publish_intent(&core, &world, "published");
    assert!(matches!(
        core.push(world.path(), &intent).unwrap().outcome,
        PushOutcome::Uncertain { .. }
    ));
    assert_eq!(
        git(&world.remote, &["rev-parse", "published"]),
        intent.source.as_str()
    );
    no_tracking(&world);
}
