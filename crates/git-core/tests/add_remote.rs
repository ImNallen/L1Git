use l1_git_core::{AddRemote, AddRemoteRefresh, Coordinator, Limits, PublishOptions, Request};
use std::{fs, path::Path, process::Command, sync::Arc, thread};

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "user.name=Ada",
            "-c",
            "user.email=ada@example.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
fn fixture() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    git(
        directory.path(),
        &["init", "--quiet", "--initial-branch=main"],
    );
    fs::write(directory.path().join("f"), "unchanged\n").unwrap();
    git(directory.path(), &["add", "f"]);
    git(directory.path(), &["commit", "--quiet", "-m", "initial"]);
    directory
}
fn core(root: &Path) -> Coordinator {
    Coordinator::new(Limits::default(), root.join("undo"))
}
fn input(name: &str, url: &str) -> AddRemote {
    AddRemote {
        name: name.into(),
        url: url.into(),
    }
}
fn config(root: &Path, key: &str) -> Vec<u8> {
    git(root, &["config", "--null", "--get-all", key])
}

#[test]
fn adds_pair_without_contacting_endpoint_or_changing_repository_state() {
    let directory = fixture();
    let root = directory.path();
    let endpoint = tempfile::tempdir().unwrap();
    git(endpoint.path(), &["init", "--bare", "--quiet"]);
    let config_path = root.join(".git/config");
    git(root, &["config", "unrelated.value", "keep\nall values"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config_path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let before = (
        git(root, &["show-ref"]),
        git(root, &["rev-parse", "HEAD"]),
        fs::read(root.join(".git/index")).unwrap(),
        fs::read(root.join("f")).unwrap(),
    );
    let endpoint_refs = git(endpoint.path(), &["for-each-ref"]);
    let core = core(root);
    let history = serde_json::to_value(core.undo_history(root.to_str().unwrap()).unwrap()).unwrap();
    let report = core
        .add_remote(
            root.to_str().unwrap(),
            &input("Team/Case.name", endpoint.path().to_str().unwrap()),
        )
        .unwrap();
    assert_eq!(report.name, "Team/Case.name");
    assert!(matches!(
        report.refresh,
        AddRemoteRefresh::Refreshed {
            options: PublishOptions::Available { .. }
        }
    ));
    assert_eq!(
        config(root, "remote.Team/Case.name.url"),
        [endpoint.path().to_str().unwrap().as_bytes(), &[0]].concat()
    );
    assert_eq!(
        config(root, "remote.Team/Case.name.fetch"),
        b"+refs/heads/*:refs/remotes/Team/Case.name/*\0"
    );
    assert_eq!(config(root, "unrelated.value"), b"keep\nall values\0");
    assert_eq!(
        before,
        (
            git(root, &["show-ref"]),
            git(root, &["rev-parse", "HEAD"]),
            fs::read(root.join(".git/index")).unwrap(),
            fs::read(root.join("f")).unwrap()
        )
    );
    assert_eq!(endpoint_refs, git(endpoint.path(), &["for-each-ref"]));
    assert_eq!(
        history,
        serde_json::to_value(core.undo_history(root.to_str().unwrap()).unwrap()).unwrap()
    );
    assert!(!config_path.with_extension("lock").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(config_path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

#[test]
fn refuses_effective_common_include_and_worktree_definitions_including_non_url_keys() {
    for scope in ["common", "include", "worktree"] {
        for field in ["url", "pushurl", "fetch", "tagopt"] {
            let directory = fixture();
            let root = directory.path();
            let config_path = root.join(".git/config");
            let key = format!("remote.Taken.{field}");
            match scope {
                "include" => {
                    let include = root.join("included");
                    git(
                        root,
                        &[
                            "config",
                            "--file",
                            include.to_str().unwrap(),
                            &key,
                            "original\nvalue",
                        ],
                    );
                    git(root, &["config", "include.path", include.to_str().unwrap()]);
                }
                "worktree" => {
                    git(root, &["config", "extensions.worktreeConfig", "true"]);
                    git(root, &["config", "--worktree", &key, "original\nvalue"]);
                }
                _ => {
                    git(root, &["config", &key, "original\nvalue"]);
                }
            }
            let before = fs::read(&config_path).unwrap();
            assert!(
                core(root)
                    .add_remote(
                        root.to_str().unwrap(),
                        &input("Taken", "../new endpoint.git")
                    )
                    .is_err(),
                "{scope} {field}"
            );
            assert_eq!(fs::read(&config_path).unwrap(), before);
            assert_eq!(config(root, &key), b"original\nvalue\0");
            core(root)
                .add_remote(root.to_str().unwrap(), &input("taken", "../other.git"))
                .unwrap();
        }
    }
}

#[test]
fn refuses_global_definition() {
    const MARKER: &str = "L1_ADD_REMOTE_GLOBAL_CHILD";
    if std::env::var_os(MARKER).is_none() {
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join(".gitconfig"),
            "[remote \"globalOnly\"]\n pushurl = secret\n",
        )
        .unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "refuses_global_definition", "--nocapture"])
            .env(MARKER, "1")
            .env("HOME", home.path())
            .env("XDG_CONFIG_HOME", home.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
        return;
    }
    let directory = fixture();
    let root = directory.path();
    let before = fs::read(root.join(".git/config")).unwrap();
    assert!(
        core(root)
            .add_remote(root.to_str().unwrap(), &input("globalOnly", "../endpoint"))
            .is_err()
    );
    assert_eq!(fs::read(root.join(".git/config")).unwrap(), before);
}

#[test]
fn validates_names_and_endpoints_without_leaking_urls() {
    let directory = fixture();
    let root = directory.path();
    let before = fs::read(root.join(".git/config")).unwrap();
    let core = core(root);
    for name in [
        "", ".", "..", "-x", "a b", "a\nb", "a\tb", "a/", "a//b", "a..b", "a@{b", "a.lock", "a?",
        "a\\b",
    ] {
        let remote = input(name, "https://token:secret@example.test/private-secret");
        let error = core
            .add_remote(root.to_str().unwrap(), &remote)
            .unwrap_err();
        assert!(!format!("{error:?} {remote:?}").contains("secret"));
        assert_eq!(fs::read(root.join(".git/config")).unwrap(), before);
    }
    for url in [
        "",
        " path",
        "path ",
        "-option",
        "file\0name",
        "a\nb",
        "ext::secret",
        "https://",
        "https:/secret",
        "custom://secret",
        "host:",
    ] {
        assert!(
            core.add_remote(root.to_str().unwrap(), &input("new", url))
                .is_err(),
            "{url:?}"
        );
        assert_eq!(fs::read(root.join(".git/config")).unwrap(), before);
    }
    for (i, url) in [
        "../path with spaces",
        "bare-relative.git",
        "/absolute/endpoint",
        "git@example.test:repo",
        "ssh://git@[::1]/repo",
        "https://example.test/repo",
        "http://example.test/",
        "https://example.test",
        "ssh://git@example.test/",
        "git://example.test/",
        "file:///nonexistent/repo",
    ]
    .iter()
    .enumerate()
    {
        core.add_remote(root.to_str().unwrap(), &input(&format!("valid{i}"), url))
            .unwrap();
        assert_eq!(
            config(root, &format!("remote.valid{i}.url")),
            [url.as_bytes(), &[0]].concat()
        );
    }
    let request: Request = serde_json::from_value(serde_json::json!({"op":"addRemote","path":root,"remote":{"name":"origin","url":"https://secret@example.test/private"}})).unwrap();
    assert!(!format!("{request:?}").contains("secret"));
}

#[test]
fn held_config_lock_leaves_original_and_foreign_lock_untouched() {
    let directory = fixture();
    let root = directory.path();
    let before = fs::read(root.join(".git/config")).unwrap();
    fs::write(root.join(".git/config.lock"), "foreign").unwrap();
    let error = core(root)
        .add_remote(
            root.to_str().unwrap(),
            &input("origin", "https://token:secret@example.test/private"),
        )
        .unwrap_err();
    assert!(!format!("{error:?}").contains("secret"));
    assert_eq!(fs::read(root.join(".git/config")).unwrap(), before);
    assert_eq!(fs::read(root.join(".git/config.lock")).unwrap(), b"foreign");
}

#[test]
fn linked_worktrees_share_target_and_serialize_concurrent_additions() {
    let directory = fixture();
    let root = directory.path().canonicalize().unwrap();
    let linked = root.join("linked");
    git(
        &root,
        &["worktree", "add", "--quiet", "-b", "linked", "linked"],
    );
    let core = Arc::new(core(&root));
    let jobs: Vec<_> = [root.clone(), linked.clone()]
        .into_iter()
        .map(|path| {
            let core = Arc::clone(&core);
            thread::spawn(move || {
                core.add_remote(
                    path.to_str().unwrap(),
                    &input("shared", "../never-contacted.git"),
                )
            })
        })
        .collect();
    let results: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
    assert_eq!(
        config(&root, "remote.shared.url"),
        b"../never-contacted.git\0"
    );
    assert_eq!(
        config(&linked, "remote.shared.fetch"),
        b"+refs/heads/*:refs/remotes/shared/*\0"
    );
    assert!(!root.join(".git/worktrees/linked/config").exists());
}
