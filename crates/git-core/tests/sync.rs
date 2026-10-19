use l1_git_core::{
    Advance, AdvanceOutcome, Blocker, BranchRef, BranchRole, BranchState, BranchStatus,
    Coordinator, ErrorKind, FetchFailure, FetchMode, FetchOutcome, Limits, Oid, RemoteFetch,
    RepositoryOverview, SkipReason,
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

fn advance(name: &str, from: &str, to: &str) -> Advance {
    Advance {
        reference: branch_ref(name),
        from: oid(from),
        to: oid(to),
    }
}

fn advanced(name: &str, from: &str, to: &str) -> AdvanceOutcome {
    AdvanceOutcome::Advanced {
        reference: branch_ref(name),
        from: oid(from),
        to: oid(to),
    }
}

fn skipped(name: &str, reason: SkipReason) -> AdvanceOutcome {
    AdvanceOutcome::Skipped {
        reference: branch_ref(name),
        reason,
    }
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

fn up_to_date(name: &str) -> BranchState {
    BranchState::UpToDate {
        upstream: upstream(name),
    }
}

#[test]
fn fast_forwards_the_checked_out_default_branch_after_a_fetch() {
    let world = World::new();
    let coordinator = coordinator();
    let target = world.colleague_pushes("main", "f", "one\ntwo\n");

    let local = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    assert_eq!(local.fetch, None);
    assert_eq!(local.name, "work tree");
    assert_eq!(local.root, path(&world.work));
    assert_eq!(local.common_dir, path(&world.work.join(".git")));
    let main = branch(&local, "main");
    assert_eq!(main.role, BranchRole::Default);
    assert_eq!(main.checked_out_at, Some(path(&world.work)));
    assert_eq!(main.state, up_to_date("main"));

    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    let summary = fetched.fetch.clone().unwrap();
    assert!(summary.changed);
    assert!(!summary.coalesced);
    assert_eq!(
        summary.remotes,
        [RemoteFetch {
            remote: "origin".into(),
            outcome: FetchOutcome::Fetched
        }]
    );
    assert_eq!(
        branch(&fetched, "main").state,
        behind("main", &target, 1, None)
    );

    let report = coordinator
        .fast_forward(world.path(), &[advance("main", &world.initial, &target)])
        .unwrap();
    assert_eq!(report.outcomes, [advanced("main", &world.initial, &target)]);
    assert_eq!(branch(&report.overview, "main").state, up_to_date("main"));
    assert_eq!(report.overview.fetch, None);
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), target);
    assert_eq!(
        git(&world.work, &["rev-list", "--parents", "-1", "HEAD"]),
        format!("{target} {}", world.initial)
    );
    assert_eq!(git(&world.work, &["status", "--porcelain"]), "");
    assert_eq!(
        fs::read_to_string(world.work.join("f")).unwrap(),
        "one\ntwo\n"
    );
    assert_eq!(
        git(&world.work, &["reflog", "-1", "--format=%gs", "main"]),
        "l1git fast-forward: Fast-forward"
    );

    let unchanged = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap()
        .fetch
        .unwrap();
    assert!(!unchanged.changed);
}

#[test]
fn moves_a_free_branch_by_compare_and_swap_and_retries_harmlessly() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "feat"]);
    world.publish("feat");
    let target = world.colleague_pushes("feat", "g", "colleague\n");
    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    let feat = branch(&fetched, "feat");
    assert_eq!(feat.checked_out_at, None);
    assert_eq!(feat.state, behind("feat", &target, 1, None));
    let request = advance("feat", &world.initial, &target);

    git(&world.work, &["switch", "--quiet", "-c", "side"]);
    let side = commit(&world.work, "s", "side\n", "side");
    git(&world.work, &["switch", "--quiet", "main"]);
    git(&world.work, &["branch", "--force", "feat", "side"]);
    let report = coordinator
        .fast_forward(world.path(), std::slice::from_ref(&request))
        .unwrap();
    assert_eq!(report.outcomes, [skipped("feat", SkipReason::Changed)]);
    assert_eq!(git(&world.work, &["rev-parse", "feat"]), side);

    git(&world.work, &["branch", "--force", "feat", &world.initial]);
    for _ in 0..2 {
        let report = coordinator
            .fast_forward(world.path(), std::slice::from_ref(&request))
            .unwrap();
        assert_eq!(report.outcomes, [advanced("feat", &world.initial, &target)]);
        assert_eq!(git(&world.work, &["rev-parse", "feat"]), target);
    }
    assert_eq!(
        git(&world.work, &["reflog", "-1", "--format=%gs", "feat"]),
        "l1git: fast-forward"
    );
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), world.initial);
}

#[test]
fn reports_divergence_and_refuses_a_forged_fast_forward() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "feat"]);
    world.publish("feat");
    let theirs = world.colleague_pushes("feat", "g", "colleague\n");
    git(&world.work, &["switch", "--quiet", "feat"]);
    let ours = commit(&world.work, "h", "mine\n", "local work");
    git(&world.work, &["switch", "--quiet", "main"]);

    let local = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    assert_eq!(
        branch(&local, "feat").state,
        BranchState::Ahead {
            upstream: upstream("feat"),
            ahead: 1
        }
    );
    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    assert_eq!(
        branch(&fetched, "feat").state,
        BranchState::Diverged {
            upstream: upstream("feat"),
            ahead: 1,
            behind: 1
        }
    );
    let report = coordinator
        .fast_forward(world.path(), &[advance("feat", &ours, &theirs)])
        .unwrap();
    assert_eq!(report.outcomes, [skipped("feat", SkipReason::NotBehind)]);
    assert_eq!(git(&world.work, &["rev-parse", "feat"]), ours);
}

#[test]
fn tracked_changes_block_but_untracked_files_only_block_when_overwritten() {
    let world = World::new();
    let coordinator = coordinator();
    let worktree = path(&world.work);
    let second = world.colleague_pushes("main", "f", "one\ntwo\n");
    fs::write(world.work.join("f"), "local edit\n").unwrap();

    let dirty = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    let blocker = Blocker::Dirty {
        worktree: worktree.clone(),
    };
    assert_eq!(
        branch(&dirty, "main").state,
        behind("main", &second, 1, Some(blocker))
    );
    let report = coordinator
        .fast_forward(world.path(), &[advance("main", &world.initial, &second)])
        .unwrap();
    assert_eq!(
        report.outcomes,
        [skipped(
            "main",
            SkipReason::Dirty {
                worktree: worktree.clone()
            }
        )]
    );
    assert_eq!(
        fs::read_to_string(world.work.join("f")).unwrap(),
        "local edit\n"
    );
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), world.initial);

    git(&world.work, &["checkout", "--", "f"]);
    fs::write(world.work.join("notes.txt"), "scratch\n").unwrap();
    let untracked = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    assert_eq!(
        branch(&untracked, "main").state,
        behind("main", &second, 1, None)
    );
    let report = coordinator
        .fast_forward(world.path(), &[advance("main", &world.initial, &second)])
        .unwrap();
    assert_eq!(report.outcomes, [advanced("main", &world.initial, &second)]);
    assert_eq!(
        fs::read_to_string(world.work.join("notes.txt")).unwrap(),
        "scratch\n"
    );

    let third = world.colleague_pushes("main", "notes.txt", "theirs\n");
    let colliding = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    assert_eq!(
        branch(&colliding, "main").state,
        behind("main", &third, 1, None)
    );
    let report = coordinator
        .fast_forward(world.path(), &[advance("main", &second, &third)])
        .unwrap();
    assert_eq!(
        report.outcomes,
        [skipped("main", SkipReason::Dirty { worktree })]
    );
    assert_eq!(
        fs::read_to_string(world.work.join("notes.txt")).unwrap(),
        "scratch\n"
    );
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), second);
}

#[test]
fn fast_forwards_a_linked_worktree_inside_that_worktree() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "develop"]);
    world.publish("develop");
    let linked = world.worktree("wt-develop", "develop");
    let target = world.colleague_pushes("develop", "d", "develop\n");

    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    let develop = branch(&fetched, "develop");
    assert_eq!(develop.role, BranchRole::Mainline);
    assert_eq!(develop.checked_out_at, Some(path(&linked)));
    assert_eq!(develop.state, behind("develop", &target, 1, None));
    let from_linked = coordinator
        .overview(linked.to_str().unwrap(), FetchMode::Local)
        .unwrap();
    assert_eq!(from_linked.root, path(&linked));
    assert_eq!(from_linked.common_dir, fetched.common_dir);
    assert_eq!(from_linked.name, "work tree");

    let report = coordinator
        .fast_forward(world.path(), &[advance("develop", &world.initial, &target)])
        .unwrap();
    assert_eq!(
        report.outcomes,
        [advanced("develop", &world.initial, &target)]
    );
    assert_eq!(git(&linked, &["rev-parse", "HEAD"]), target);
    assert_eq!(git(&linked, &["status", "--porcelain"]), "");
    assert_eq!(fs::read_to_string(linked.join("d")).unwrap(), "develop\n");
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), world.initial);
    assert_eq!(git(&world.work, &["status", "--porcelain"]), "");
}

#[cfg(unix)]
#[test]
fn a_worktree_path_with_a_newline_keeps_its_row_whole() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "develop"]);
    world.publish("develop");
    let linked = world.worktree("wt\ndevelop", "develop");
    let target = world.colleague_pushes("develop", "d", "develop\n");

    let fetched = coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    assert_eq!(names(&fetched), ["develop", "main"]);
    let develop = branch(&fetched, "develop");
    assert_eq!(develop.checked_out_at, Some(path(&linked)));
    assert_eq!(develop.state, behind("develop", &target, 1, None));

    let report = coordinator
        .fast_forward(world.path(), &[advance("develop", &world.initial, &target)])
        .unwrap();
    assert_eq!(
        report.outcomes,
        [advanced("develop", &world.initial, &target)]
    );
    assert_eq!(git(&linked, &["rev-parse", "HEAD"]), target);
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

#[test]
fn a_branch_mid_rebase_in_a_linked_worktree_is_in_use() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "develop"]);
    world.publish("develop");
    let linked = world.worktree("wt-develop", "develop");
    let target = world.colleague_pushes("develop", "d", "develop\n");
    git(&world.work, &["fetch", "--quiet", "origin"]);
    let editor = world.script("break-editor", "echo break > \"$1\"\n");
    git(
        &linked,
        &[
            "-c",
            &format!("sequence.editor={editor}"),
            "rebase",
            "--quiet",
            "-i",
            "HEAD",
        ],
    );
    assert_eq!(
        git(
            &world.work,
            &[
                "for-each-ref",
                "--format=[%(worktreepath)]",
                "refs/heads/develop"
            ]
        ),
        "[]"
    );

    let local = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    let develop = branch(&local, "develop");
    let in_use = Blocker::InUse {
        worktree: path(&linked),
    };
    assert_eq!(develop.checked_out_at, Some(path(&linked)));
    assert_eq!(develop.state, behind("develop", &target, 1, Some(in_use)));
    let report = coordinator
        .fast_forward(world.path(), &[advance("develop", &world.initial, &target)])
        .unwrap();
    assert_eq!(
        report.outcomes,
        [skipped(
            "develop",
            SkipReason::InUse {
                worktree: path(&linked)
            }
        )]
    );
    assert_eq!(git(&world.work, &["rev-parse", "develop"]), world.initial);
}

#[test]
fn a_hidden_rebase_blocks_even_when_the_file_transport_is_disabled() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "develop"]);
    world.publish("develop");
    let linked = world.worktree("wt-develop", "develop");
    let target = world.colleague_pushes("develop", "d", "develop\n");
    git(&world.work, &["fetch", "--quiet", "origin"]);
    let editor = world.script("break-editor", "echo break > \"$1\"\n");
    git(
        &linked,
        &[
            "-c",
            &format!("sequence.editor={editor}"),
            "rebase",
            "--quiet",
            "-i",
            "HEAD",
        ],
    );
    git(&world.work, &["config", "protocol.file.allow", "never"]);

    let local = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    let develop = branch(&local, "develop");
    let in_use = Blocker::InUse {
        worktree: path(&linked),
    };
    assert_eq!(develop.checked_out_at, Some(path(&linked)));
    assert_eq!(develop.state, behind("develop", &target, 1, Some(in_use)));
    let report = coordinator
        .fast_forward(world.path(), &[advance("develop", &world.initial, &target)])
        .unwrap();
    assert_eq!(
        report.outcomes,
        [skipped(
            "develop",
            SkipReason::InUse {
                worktree: path(&linked)
            }
        )]
    );
    assert_eq!(git(&world.work, &["rev-parse", "develop"]), world.initial);
}

fn hook(world: &World, name: &str, body: &str) {
    let hooks = world.file("hooks");
    fs::create_dir_all(&hooks).unwrap();
    world.script(
        &format!("hooks/{name}"),
        &format!("unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n{body}"),
    );
    git(
        &world.work,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
}

#[test]
fn update_all_rechecks_each_branch_after_the_moves_before_it() {
    let world = World::new();
    let coordinator = coordinator();
    for name in ["develop", "release", "old"] {
        git(&world.work, &["branch", name]);
    }
    world.publish("develop");
    world.publish("release");
    let develop_worktree = world.worktree("wt-develop", "develop");
    let release_worktree = world.worktree("wt-release", "release");
    let develop = world.colleague_pushes("develop", "d", "develop\n");
    let release = world.colleague_pushes("release", "r", "release\n");
    coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    hook(
        &world,
        "post-merge",
        &format!(
            "git -C '{}' switch --quiet old\n",
            release_worktree.display()
        ),
    );

    let report = coordinator
        .fast_forward(
            world.path(),
            &[
                advance("develop", &world.initial, &develop),
                advance("release", &world.initial, &release),
            ],
        )
        .unwrap();
    assert_eq!(
        report.outcomes,
        [
            advanced("develop", &world.initial, &develop),
            advanced("release", &world.initial, &release)
        ]
    );
    assert_eq!(git(&develop_worktree, &["rev-parse", "HEAD"]), develop);
    assert_eq!(
        git(&release_worktree, &["symbolic-ref", "HEAD"]),
        "refs/heads/old"
    );
    assert_eq!(git(&world.work, &["rev-parse", "old"]), world.initial);
    assert_eq!(git(&world.work, &["rev-parse", "release"]), release);
}

#[test]
fn the_same_advance_twice_in_one_request_is_advanced_twice() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "feat"]);
    world.publish("feat");
    let target = world.colleague_pushes("feat", "g", "colleague\n");
    coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();

    let request = advance("feat", &world.initial, &target);
    let report = coordinator
        .fast_forward(world.path(), &[request.clone(), request])
        .unwrap();
    assert_eq!(
        report.outcomes,
        [
            advanced("feat", &world.initial, &target),
            advanced("feat", &world.initial, &target)
        ]
    );
    assert_eq!(git(&world.work, &["rev-parse", "feat"]), target);
}

#[test]
fn a_branch_that_moves_past_the_target_during_its_merge_is_changed() {
    let world = World::new();
    let coordinator = coordinator();
    let target = world.colleague_pushes("main", "f", "one\ntwo\n");
    coordinator
        .overview(world.path(), FetchMode::Remote)
        .unwrap();
    hook(
        &world,
        "post-merge",
        "git -c user.name=Ada -c user.email=ada@example.test commit --quiet --allow-empty -m hook\n",
    );

    let report = coordinator
        .fast_forward(world.path(), &[advance("main", &world.initial, &target)])
        .unwrap();
    assert_eq!(report.outcomes, [skipped("main", SkipReason::Changed)]);
    assert_eq!(git(&world.work, &["rev-parse", "main^"]), target);
    assert_eq!(
        git(&world.work, &["log", "-1", "--format=%s", "main"]),
        "hook"
    );
}

const UNAPPLICABLE_PATCH: &str =
    "From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Ada <ada@example.test>
Date: Tue, 14 Nov 2023 22:13:20 +0000
Subject: [PATCH] edit

---
 f | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-nope
+edit
--
2.0
";

#[test]
fn a_stopped_am_or_a_started_bisect_keeps_an_attached_branch_in_use() {
    let world = World::new();
    let coordinator = coordinator();
    let target = world.colleague_pushes("main", "g", "colleague\n");
    git(&world.work, &["fetch", "--quiet", "origin"]);
    let request = advance("main", &world.initial, &target);
    let in_use = Blocker::InUse {
        worktree: path(&world.work),
    };
    let assert_in_use = || {
        assert_eq!(
            git(&world.work, &["symbolic-ref", "HEAD"]),
            "refs/heads/main"
        );
        assert_eq!(git(&world.work, &["status", "--porcelain", "-uno"]), "");
        let local = coordinator
            .overview(world.path(), FetchMode::Local)
            .unwrap();
        assert_eq!(
            branch(&local, "main").state,
            behind("main", &target, 1, Some(in_use.clone()))
        );
        let report = coordinator
            .fast_forward(world.path(), std::slice::from_ref(&request))
            .unwrap();
        assert_eq!(
            report.outcomes,
            [skipped(
                "main",
                SkipReason::InUse {
                    worktree: path(&world.work)
                }
            )]
        );
        assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), world.initial);
    };

    let patch = world.file("edit.patch");
    fs::write(&patch, UNAPPLICABLE_PATCH).unwrap();
    let am = git_command(&world.work, &["am", patch.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!am.status.success());
    assert!(world.work.join(".git/rebase-apply").is_dir());
    assert_in_use();
    git(&world.work, &["am", "--abort"]);

    git(&world.work, &["bisect", "start"]);
    assert_in_use();
    git(&world.work, &["bisect", "reset"]);

    let report = coordinator
        .fast_forward(world.path(), std::slice::from_ref(&request))
        .unwrap();
    assert_eq!(report.outcomes, [advanced("main", &world.initial, &target)]);
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), target);
}

fn names(overview: &RepositoryOverview) -> Vec<&str> {
    overview
        .branches
        .iter()
        .map(|branch| branch.name.as_str())
        .collect()
}

#[test]
fn a_symbolic_branch_is_never_offered_or_moved() {
    let world = World::new();
    let coordinator = coordinator();
    let target = world.colleague_pushes("main", "f", "one\ntwo\n");
    git(&world.work, &["fetch", "--quiet", "origin"]);
    git(
        &world.work,
        &["symbolic-ref", "refs/heads/alias", "refs/heads/main"],
    );
    git(&world.work, &["config", "branch.alias.remote", "origin"]);
    git(
        &world.work,
        &["config", "branch.alias.merge", "refs/heads/main"],
    );

    let local = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    assert_eq!(names(&local), ["main"]);
    let report = coordinator
        .fast_forward(world.path(), &[advance("alias", &world.initial, &target)])
        .unwrap();
    assert_eq!(report.outcomes, [skipped("alias", SkipReason::Changed)]);
    assert_eq!(
        git(&world.work, &["rev-parse", "refs/heads/main"]),
        world.initial
    );
    assert_eq!(
        git(&world.work, &["symbolic-ref", "refs/heads/alias"]),
        "refs/heads/main"
    );
    assert_eq!(fs::read_to_string(world.work.join("f")).unwrap(), "one\n");
}

#[test]
fn an_odd_ref_degrades_only_its_own_row() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.work, &["branch", "feat"]);
    world.publish("feat");
    git(
        &world.work,
        &[
            "config",
            "--replace-all",
            "remote.origin.fetch",
            "+refs/heads/*:refs/upstream/origin/*",
        ],
    );
    let target = world.colleague_pushes("main", "f", "one\ntwo\n");
    git(&world.work, &["fetch", "--quiet", "origin"]);
    git(&world.work, &["pack-refs", "--all"]);
    let packed = world.work.join(".git/packed-refs");
    let contents = fs::read(&packed).unwrap();
    let mut lines: Vec<Vec<u8>> = contents
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(<[u8]>::to_vec)
        .collect();
    lines.push([world.initial.as_bytes(), b" refs/heads/caf\xe9"].concat());
    lines[1..].sort_by(|a, b| a[41..].cmp(&b[41..]));
    fs::write(&packed, [lines.join(&b'\n'), b"\n".to_vec()].concat()).unwrap();

    let local = coordinator
        .overview(world.path(), FetchMode::Local)
        .unwrap();
    assert_eq!(names(&local), ["feat", "main"]);
    assert_eq!(
        branch(&local, "feat").state,
        BranchState::UpToDate {
            upstream: "refs/upstream/origin/feat".into()
        }
    );
    assert_eq!(
        branch(&local, "main").state,
        BranchState::Behind {
            upstream: "refs/upstream/origin/main".into(),
            target: oid(&target),
            behind: 1,
            blocker: None
        }
    );
    let report = coordinator
        .fast_forward(world.path(), &[advance("main", &world.initial, &target)])
        .unwrap();
    assert_eq!(report.outcomes, [advanced("main", &world.initial, &target)]);
    assert_eq!(git(&world.work, &["rev-parse", "HEAD"]), target);
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
        } else if path
            .extension()
            .is_some_and(|extension| extension == "lock")
        {
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

    let overview = coordinator
        .overview(world.path(), FetchMode::Remote)
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
fn a_fetch_keeps_local_tags_when_the_repository_prunes_tags() {
    let world = World::new();
    git(&world.work, &["config", "fetch.pruneTags", "true"]);
    git(&world.work, &["tag", "local-only"]);

    coordinator()
        .overview(world.path(), FetchMode::Remote)
        .unwrap();

    assert_eq!(git(&world.work, &["tag", "--list"]), "local-only");
}

#[test]
fn fast_forwards_a_blob_filtered_partial_clone() {
    let world = World::new();
    let coordinator = coordinator();
    git(&world.remote, &["config", "uploadpack.allowFilter", "true"]);
    let source = url::Url::from_file_path(&world.remote).unwrap();
    let partial = world.file("partial");
    git(
        world.directory.path(),
        &[
            "clone",
            "--quiet",
            "--filter=blob:none",
            source.as_str(),
            partial.to_str().unwrap(),
        ],
    );
    let target = world.colleague_pushes("main", "f", "one\ntwo\n");

    let fetched = coordinator
        .overview(partial.to_str().unwrap(), FetchMode::Remote)
        .unwrap();
    assert_eq!(
        branch(&fetched, "main").state,
        behind("main", &target, 1, None)
    );
    let report = coordinator
        .fast_forward(
            partial.to_str().unwrap(),
            &[advance("main", &world.initial, &target)],
        )
        .unwrap();
    assert_eq!(report.outcomes, [advanced("main", &world.initial, &target)]);
    assert_eq!(fs::read_to_string(partial.join("f")).unwrap(), "one\ntwo\n");
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
