#![cfg(unix)]

use l1_git_core::{
    CommitsFetch, Coordinator, FetchFailure, FetchMode, GitHubRepository, Limits, Oid, RangeFiles,
    Request, Response, WantedCommits, range_files, run,
};
use std::{
    fs,
    num::NonZeroUsize,
    os::unix::fs::PermissionsExt,
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
        .trim_end()
        .to_owned()
}

fn oid(value: &str) -> Oid {
    Oid::try_from(value.to_owned()).unwrap()
}

fn commit(path: &Path, file: &str, contents: &str) -> Oid {
    fs::write(path.join(file), contents).unwrap();
    git(path, &["add", "--", file]);
    git(path, &["commit", "--quiet", "-m", file]);
    oid(&git(path, &["rev-parse", "HEAD"]))
}

fn github(name: &str) -> GitHubRepository {
    let (owner, repo) = name.split_once('/').unwrap();
    GitHubRepository {
        owner: owner.into(),
        repo: repo.into(),
    }
}

fn wanted(oids: &[&Oid]) -> WantedCommits {
    WantedCommits::try_from(oids.iter().copied().cloned().collect::<Vec<_>>()).unwrap()
}

/// `work` is a clone of `remote.git`, which it reaches through the URL of
/// octo/app on GitHub. `base` and `head` reached the remote later.
struct World {
    directory: TempDir,
    remote: PathBuf,
    work: PathBuf,
    base: Oid,
    head: Oid,
}

impl World {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let top = directory.path().canonicalize().unwrap();
        let (remote, work, other) = (top.join("remote.git"), top.join("work"), top.join("other"));
        git(&top, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(&remote, &["config", "uploadpack.allowFilter", "true"]);
        git(&top, &["init", "-q", "-b", "main", "other"]);
        commit(&other, "f", "one\n");
        git(
            &other,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&other, &["push", "-q", "origin", "main"]);
        git(&top, &["clone", "-q", remote.to_str().unwrap(), "work"]);
        let world = |base, head| Self {
            directory,
            remote,
            work,
            base,
            head,
        };
        let base = commit(&other, "f", "two\n");
        git(&other, &["tag", "-a", "v1", "-m", "v1"]);
        git(&other, &["push", "-q", "origin", "main", "v1"]);
        git(&other, &["switch", "-q", "-c", "topic"]);
        let head = commit(&other, "g", "new\n");
        git(&other, &["push", "-q", "origin", "topic"]);
        let world = world(base, head);
        world.point("origin", "https://github.com/octo/app.git");
        world
    }

    fn path(&self) -> &str {
        self.work.to_str().unwrap()
    }

    fn file(&self, name: &str) -> PathBuf {
        self.directory.path().canonicalize().unwrap().join(name)
    }

    fn config(&self, key: &str, value: &str) {
        git(&self.work, &["config", "--add", key, value]);
    }

    /// Gives a remote a URL on GitHub that Git rewrites to `remote.git`.
    fn point(&self, name: &str, url: &str) {
        git(&self.work, &["config", &format!("remote.{name}.url"), url]);
        self.config(&format!("url.{}.insteadOf", self.remote.display()), url);
    }

    fn wrapper(&self, body: &str) {
        let path = self.file("upload-pack");
        fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        self.config("remote.origin.uploadpack", path.to_str().unwrap());
    }

    fn fetch(&self, name: &str, oids: &[&Oid]) -> CommitsFetch {
        self.coordinator()
            .fetch_commits(self.path(), &github(name), &wanted(oids))
            .unwrap()
    }

    fn coordinator(&self) -> Coordinator {
        let limits = Limits {
            fetch_deadline: Duration::from_secs(5),
            network_slots: NonZeroUsize::new(4).unwrap(),
            ..Limits::default()
        };
        Coordinator::new(limits, self.file("undo"))
    }

    fn has(&self, oid: &Oid) -> bool {
        let found = Command::new("git")
            .arg("-C")
            .arg(&self.work)
            .args(["--no-lazy-fetch", "cat-file", "-e", oid.as_str()])
            .output()
            .unwrap();
        found.status.success()
    }

    /// Every ref, reflog, and file of the Git folder that is not an object.
    fn state(&self) -> Vec<(PathBuf, Vec<u8>)> {
        let top = self.work.join(".git");
        let mut files = Vec::new();
        let mut folders = vec![top.clone()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(folder).unwrap() {
                let path = entry.unwrap().path();
                if path == top.join("objects") {
                    continue;
                }
                if path.is_dir() {
                    folders.push(path);
                } else {
                    files.push((path.clone(), fs::read(&path).unwrap()));
                }
            }
        }
        files.sort();
        files
    }
}

#[test]
fn fetches_missing_commits_by_id_and_moves_nothing() {
    let world = World::new();
    let (base, head) = (&world.base, &world.head);
    let before = world.state();
    assert_eq!(
        range_files(world.path(), base, head).unwrap(),
        RangeFiles::Missing {
            oids: vec![base.clone(), head.clone()]
        }
    );
    assert_eq!(world.fetch("octo/app", &[base, head]), CommitsFetch::Done);
    assert!(matches!(
        range_files(world.path(), base, head).unwrap(),
        RangeFiles::Ready { files, .. } if files.len() == 1
    ));
    assert_eq!(world.state(), before);
    assert_eq!(world.fetch("OCTO/App", &[head]), CommitsFetch::Done);
    assert_eq!(world.state(), before);
}

#[test]
fn a_commit_no_branch_of_the_remote_reaches_is_fetched() {
    let world = World::new();
    git(
        &world.remote,
        &["update-ref", "refs/pull/1/head", world.head.as_str()],
    );
    git(&world.remote, &["branch", "-D", "topic"]);
    assert_eq!(world.fetch("octo/app", &[&world.head]), CommitsFetch::Done);
    assert!(world.has(&world.head));
    git(&world.remote, &["update-ref", "-d", "refs/pull/1/head"]);
    let other = oid(&git(
        &world.remote,
        &[
            "-c",
            "user.name=a",
            "-c",
            "user.email=a@b",
            "commit-tree",
            "main^{tree}",
            "-m",
            "loose",
        ],
    ));
    git(
        &world.remote,
        &["config", "uploadpack.allowAnySHA1InWant", "true"],
    );
    assert_eq!(world.fetch("octo/app", &[&other]), CommitsFetch::Done);
    assert!(world.has(&other));
}

#[test]
fn no_configuration_makes_the_fetch_move_a_ref() {
    for protocol in ["0", "2"] {
        for (refspec, mirror) in [
            ("+refs/*:refs/*", "true"),
            ("+refs/heads/*:refs/heads/fetched/*", "false"),
            ("+refs/tags/*:refs/tags/*", "false"),
            ("+*:refs/hostile/*", "false"),
        ] {
            let world = World::new();
            git(
                &world.remote,
                &["config", "uploadpack.allowAnySHA1InWant", "true"],
            );
            git(
                &world.work,
                &["update-ref", "refs/remotes/origin/gone", "HEAD"],
            );
            git(&world.work, &["tag", "local"]);
            git(&world.work, &["remote", "set-head", "origin", "-d"]);
            git(
                &world.work,
                &["config", "--unset-all", "remote.origin.fetch"],
            );
            for (key, value) in [
                ("protocol.version", protocol),
                ("remote.origin.fetch", refspec),
                ("remote.origin.mirror", mirror),
                ("remote.origin.tagOpt", "--tags"),
                ("remote.origin.prune", "true"),
                ("remote.origin.pruneTags", "true"),
                ("remote.origin.followRemoteHEAD", "always"),
                ("fetch.prune", "true"),
                ("fetch.pruneTags", "true"),
                ("fetch.recurseSubmodules", "true"),
                ("fetch.all", "true"),
                ("gc.auto", "1"),
                ("maintenance.autoDetach", "false"),
            ] {
                world.config(key, value);
            }
            git(
                &world.work,
                &[
                    "config",
                    "fetch.bundleURI",
                    world.file("bundle").to_str().unwrap(),
                ],
            );
            git(
                &world.file("other"),
                &[
                    "bundle",
                    "create",
                    "-q",
                    world.file("bundle").to_str().unwrap(),
                    "topic",
                    "main",
                ],
            );
            let before = world.state();
            let fetched = world.fetch("octo/app", &[&world.base, &world.head]);
            assert_eq!(fetched, CommitsFetch::Done, "{protocol} {refspec}");
            assert!(world.has(&world.base) && world.has(&world.head));
            let names = |state: &[(PathBuf, Vec<u8>)]| {
                state
                    .iter()
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>()
            };
            let after = world.state();
            assert_eq!(names(&after), names(&before), "{protocol} {refspec}");
            assert_eq!(after, before, "{protocol} {refspec}");
        }
    }
}

#[test]
fn a_fetch_leaves_an_existing_fetch_head_alone() {
    let world = World::new();
    git(&world.work, &["fetch", "-q", "origin"]);
    let head = world.work.join(".git/FETCH_HEAD");
    let before = fs::read(&head).unwrap();
    let loose = commit(&world.file("other"), "h", "later\n");
    git(&world.file("other"), &["push", "-q", "origin", "topic"]);
    assert_eq!(world.fetch("octo/app", &[&loose]), CommitsFetch::Done);
    assert_eq!(fs::read(&head).unwrap(), before);
}

#[test]
fn picks_the_remote_of_the_repository_on_github() {
    let world = World::new();
    assert_eq!(
        world.fetch("octo/other", &[&world.head]),
        CommitsFetch::NoRemote
    );
    assert!(!world.has(&world.head));
    let log = world.file("log");
    let dead = |name: &str| {
        git(
            &world.work,
            &[
                "config",
                &format!("remote.{name}.url"),
                "https://github.com/octo/app.git",
            ],
        );
        world.config(
            &format!("remote.{name}.uploadpack"),
            &format!("echo {name} >> '{}'; false", log.display()),
        );
    };
    git(&world.work, &["remote", "rename", "origin", "zeta"]);
    dead("alpha");
    let failed = |named: &str| {
        let fetched = world.fetch("octo/app", &[&world.head]);
        assert!(
            matches!(fetched, CommitsFetch::Failed { .. }),
            "{fetched:?}"
        );
        assert_eq!(
            fs::read_to_string(&log).unwrap().lines().last(),
            Some(named)
        );
    };
    failed("alpha");
    dead("origin");
    failed("origin");
    dead("upstream");
    failed("upstream");
    git(
        &world.work,
        &[
            "config",
            "remote.upstream.url",
            "https://github.com/octo/app-next",
        ],
    );
    failed("origin");
}

#[test]
fn says_why_a_fetch_failed() {
    let world = World::new();
    let absent = oid(&"3".repeat(40));
    let CommitsFetch::Failed { failure, message } = world.fetch("octo/app", &[&absent]) else {
        panic!("a failure");
    };
    assert_eq!(failure, FetchFailure::Other);
    assert!(message.contains("not our ref"), "{message}");
    assert_eq!(
        world.fetch("octo/app", &[&world.head, &absent]),
        CommitsFetch::Failed { failure, message }
    );

    let secret = World::new();
    git(
        &secret.work,
        &[
            "config",
            "remote.origin.url",
            "https://ada:s3cret@github.com/octo/app.git",
        ],
    );
    secret.config(
        "url.https://ada:s3cret@127.0.0.1:1/.insteadOf",
        "https://ada:s3cret@github.com/",
    );
    let CommitsFetch::Failed { failure, message } = secret.fetch("octo/app", &[&secret.head])
    else {
        panic!("a failure");
    };
    assert_eq!(failure, FetchFailure::Network);
    assert!(!message.contains("s3cret"), "{message}");

    let hung = World::new();
    hung.wrapper("exec sleep 30\n");
    let limits = Limits {
        fetch_deadline: Duration::from_secs(1),
        ..Limits::default()
    };
    let started = Instant::now();
    assert_eq!(
        Coordinator::new(limits, hung.file("undo"))
            .fetch_commits(hung.path(), &github("octo/app"), &wanted(&[&hung.head]))
            .unwrap(),
        CommitsFetch::Failed {
            failure: FetchFailure::TimedOut,
            message: "origin did not answer within 1 seconds.".into(),
        }
    );
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn never_overlaps_another_fetch_of_the_repository() {
    let world = World::new();
    let log = world.file("upload-pack.log");
    world.wrapper(&format!(
        "echo start >> '{log}'\nsleep 1\ngit upload-pack \"$@\"\nstatus=$?\necho end >> '{log}'\nexit $status\n",
        log = log.display()
    ));
    let coordinator = Arc::new(world.coordinator());
    let barrier = Arc::new(Barrier::new(3));
    let start = |work: Box<dyn FnOnce(&Coordinator) + Send>| {
        let (coordinator, barrier) = (Arc::clone(&coordinator), Arc::clone(&barrier));
        thread::spawn(move || {
            barrier.wait();
            work(&coordinator);
        })
    };
    let one = |commit: &Oid| {
        let (path, commits) = (world.path().to_owned(), wanted(&[commit]));
        start(Box::new(move |coordinator| {
            let fetched = coordinator.fetch_commits(&path, &github("octo/app"), &commits);
            assert_eq!(fetched.unwrap(), CommitsFetch::Done);
        }))
    };
    let path = world.path().to_owned();
    for handle in [
        one(&world.head),
        one(&world.base),
        start(Box::new(move |coordinator| {
            coordinator.overview(&path, FetchMode::Remote).unwrap();
        })),
    ] {
        handle.join().unwrap();
    }
    let lines = fs::read_to_string(&log).unwrap();
    for pair in lines.lines().collect::<Vec<_>>().chunks(2) {
        assert_eq!(pair, ["start", "end"], "{lines}");
    }
    assert!(world.has(&world.head) && world.has(&world.base));
}

#[test]
fn shallow_and_partial_clones_fetch_what_they_are() {
    let world = World::new();
    let url = url::Url::from_file_path(&world.remote).unwrap();
    for (name, option) in [("shallow", "--depth=1"), ("partial", "--filter=blob:none")] {
        let path = world.file(name);
        git(
            path.parent().unwrap(),
            &["clone", "-q", "--single-branch", option, url.as_str(), name],
        );
        git(
            &path,
            &["config", "remote.origin.url", "https://github.com/octo/app"],
        );
        git(
            &path,
            &[
                "config",
                &format!("url.{url}.insteadOf"),
                "https://github.com/octo/app",
            ],
        );
        let refs = git(&path, &["for-each-ref"]);
        let shallow = fs::read(path.join(".git/shallow")).ok();
        assert_eq!(
            world
                .coordinator()
                .fetch_commits(
                    path.to_str().unwrap(),
                    &github("octo/app"),
                    &wanted(&[&world.base, &world.head])
                )
                .unwrap(),
            CommitsFetch::Done
        );
        assert_eq!(git(&path, &["for-each-ref"]), refs);
        assert_eq!(fs::read(path.join(".git/shallow")).ok(), shallow);
        let files = range_files(path.to_str().unwrap(), &world.base, &world.head).unwrap();
        assert!(
            matches!(&files, RangeFiles::Ready { files, content_missing, .. }
                if files.len() == 1 && *content_missing == (name == "partial")),
            "{name} {files:?}"
        );
    }
}

#[test]
fn a_request_names_one_or_two_commits() {
    let request = |oids: &[&str]| {
        serde_json::from_value::<Request>(serde_json::json!({
            "op": "fetchCommits",
            "path": "/r",
            "github": {"owner": "octo", "repo": "app"},
            "oids": oids,
        }))
        .is_ok()
    };
    let (a, b) = (&*"a".repeat(40), &*"b".repeat(40));
    assert!(request(&[a]));
    assert!(request(&[a, b]));
    for bad in [&[][..], &[a, b, a], &["main"], &["--upload-pack=x"]] {
        assert!(!request(bad), "{bad:?}");
    }
    let world = World::new();
    let answer = run(
        &world.coordinator(),
        serde_json::from_value(serde_json::json!({
            "op": "fetchCommits",
            "path": world.path(),
            "github": {"owner": "octo", "repo": "app"},
            "oids": [world.head],
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(matches!(answer, Response::FetchCommits(CommitsFetch::Done)));
}
