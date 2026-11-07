use l1_git_core::{
    Coordinator, DirectoryEntry, ErrorKind, Head, Limits, Request, Response, expand_home,
    list_directories, run,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("-C")
        .arg(path)
        .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.test"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn base() -> (TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    (directory, base)
}

fn folders(base: &Path, names: &[&str]) {
    for name in names {
        fs::create_dir_all(base.join(name)).unwrap();
    }
}

fn listed(path: &Path) -> Vec<DirectoryEntry> {
    list_directories(path.to_str().unwrap(), None)
        .unwrap()
        .entries
}

fn names(entries: &[DirectoryEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.name.as_str()).collect()
}

#[test]
fn a_directory_lists_its_child_directories_sorted_ignoring_case() {
    let (_directory, base) = base();
    folders(&base, &["beta", "Alpha", "gamma"]);
    fs::write(base.join("file.txt"), "").unwrap();
    let entries = listed(&base);
    assert_eq!(names(&entries), ["Alpha", "beta", "gamma"]);
    assert_eq!(entries[0].path, base.join("Alpha").to_str().unwrap());
    assert!(entries.iter().all(|entry| !entry.repository));
}

#[test]
fn a_partial_name_lists_the_parents_children_that_start_with_it_ignoring_case() {
    let (_directory, base) = base();
    folders(&base, &["Docs", "docs-site", "other"]);
    assert_eq!(names(&listed(&base.join("doc"))), ["Docs", "docs-site"]);
    assert_eq!(names(&listed(&base.join("DOCS-"))), ["docs-site"]);
    assert_eq!(names(&listed(&base.join("nothing"))), [] as [&str; 0]);
}

#[test]
fn a_file_lists_the_directories_that_share_its_name() {
    let (_directory, base) = base();
    folders(&base, &["notes-old", "other"]);
    fs::write(base.join("notes"), "").unwrap();
    assert_eq!(names(&listed(&base.join("notes"))), ["notes-old"]);
}

#[test]
fn dot_directories_appear_only_for_a_prefix_that_starts_with_a_dot() {
    let (_directory, base) = base();
    folders(&base, &[".config", ".cache", "visible"]);
    assert_eq!(names(&listed(&base)), ["visible"]);
    assert_eq!(names(&listed(&base.join("vis"))), ["visible"]);
    assert_eq!(names(&listed(&base.join(".c"))), [".cache", ".config"]);
}

#[test]
fn a_child_with_git_metadata_is_a_repository_but_a_bare_one_is_not() {
    let (_directory, base) = base();
    folders(&base, &["plain", "repo", "linked"]);
    git(&base.join("repo"), &["init", "--quiet"]);
    fs::write(base.join("linked/.git"), "gitdir: elsewhere\n").unwrap();
    git(&base, &["init", "--quiet", "--bare", "bare.git"]);
    let entries = listed(&base);
    let repository = |name: &str| {
        entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap()
            .repository
    };
    assert!(repository("repo"));
    assert!(repository("linked"));
    assert!(!repository("plain"));
    assert!(!repository("bare.git"));
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_directory_is_listed_and_one_to_a_file_is_not() {
    let (_directory, base) = base();
    folders(&base, &["list", "target"]);
    fs::write(base.join("file"), "").unwrap();
    std::os::unix::fs::symlink(base.join("target"), base.join("list/to-dir")).unwrap();
    std::os::unix::fs::symlink(base.join("file"), base.join("list/to-file")).unwrap();
    assert_eq!(names(&listed(&base.join("list"))), ["to-dir"]);
}

#[test]
fn a_path_inside_a_repository_offers_that_one_directory() {
    let (_directory, base) = base();
    folders(&base, &["repo/src/deep", "repo/other"]);
    git(&base.join("repo"), &["init", "--quiet"]);
    let only = |path: PathBuf, expected: &Path| {
        assert_eq!(
            listed(&path),
            [DirectoryEntry {
                name: expected.file_name().unwrap().to_str().unwrap().to_owned(),
                path: expected.to_str().unwrap().to_owned(),
                repository: true,
            }]
        );
    };
    only(base.join("repo"), &base.join("repo"));
    only(base.join("repo/src/deep"), &base.join("repo/src/deep"));
    only(base.join("repo/oth"), &base.join("repo"));
}

#[test]
fn a_missing_parent_lists_nothing_without_an_error() {
    let (_directory, base) = base();
    assert_eq!(listed(&base.join("gone/deeper/still")), []);
}

#[test]
fn a_long_listing_stops_after_the_cap_in_sorted_order() {
    let (_directory, base) = base();
    for index in 0..501 {
        fs::create_dir(base.join(format!("d{index:03}"))).unwrap();
    }
    let entries = listed(&base);
    assert_eq!(entries.len(), 500);
    assert_eq!(entries[499].name, "d499");
}

#[cfg(target_os = "macos")]
#[test]
fn listing_home_does_not_probe_privacy_protected_folders() {
    let (_directory, base) = base();
    folders(&base, &["Documents/.git", "Projects/.git"]);
    let entries = list_directories("~", Some(&base)).unwrap().entries;
    assert_eq!(names(&entries), ["Documents", "Projects"]);
    assert!(!entries[0].repository, "Documents is not probed");
    assert!(entries[1].repository);
}

#[test]
fn home_expands_only_for_a_leading_tilde_segment() {
    let home = Path::new(if cfg!(windows) {
        r"C:\home"
    } else {
        "/home/ada"
    });
    let expand = |typed| expand_home(typed, Some(home)).unwrap();
    assert_eq!(expand("~"), home);
    assert_eq!(expand("~/"), home);
    assert_eq!(expand("~/Projects"), home.join("Projects"));
    assert_eq!(expand("~/a/../b/./c/"), home.join("b").join("c"));
    #[cfg(windows)]
    assert_eq!(expand(r"~\Projects"), home.join("Projects"));
    assert_eq!(
        expand_home("~/x", None).unwrap_err().kind,
        ErrorKind::UnsupportedPath
    );
}

#[test]
fn relative_paths_are_refused() {
    let home = Path::new("/home/ada");
    for typed in ["", "Projects", "./Projects", "../x", "~other/x"] {
        let error = expand_home(typed, Some(home)).unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnsupportedPath, "{typed}");
        assert!(error.message.contains("absolute"), "{}", error.message);
    }
}

#[cfg(unix)]
#[test]
fn an_absolute_path_is_kept_and_listed_entries_are_absolute() {
    let (_directory, base) = base();
    folders(&base, &["home/Projects/app"]);
    let home = base.join("home");
    let entries = list_directories("~/Projects", Some(&home)).unwrap().entries;
    assert_eq!(names(&entries), ["app"]);
    assert_eq!(entries[0].path, home.join("Projects/app").to_str().unwrap());
    assert_eq!(
        expand_home("/usr/local", Some(&home)).unwrap(),
        Path::new("/usr/local")
    );
}

fn coordinator(base: &Path) -> Coordinator {
    Coordinator::new(Limits::default(), base.join("undo"))
}

#[test]
fn a_new_repository_is_created_with_missing_parents_and_opens_with_an_unborn_head() {
    let (_directory, base) = base();
    let core = coordinator(&base);
    let target = base.join("not/yet/here");
    let Response::CreateRepository(created) = run(
        &core,
        Request::CreateRepository {
            path: target.to_str().unwrap().to_owned(),
        },
    )
    .unwrap() else {
        panic!("the request answered with something else");
    };
    assert_eq!(created.path, target.to_str().unwrap());
    assert!(target.join(".git").is_dir());

    let Response::Snapshot(snapshot) =
        run(&core, Request::Snapshot { path: created.path }).unwrap()
    else {
        panic!("the request answered with something else");
    };
    assert_eq!(snapshot.root.as_str(), target.to_str().unwrap());
    assert!(matches!(snapshot.head, Head::Unborn { .. }));
    assert!(snapshot.commits.is_empty());
}

#[test]
fn a_new_repository_starts_tracking_a_folder_and_keeps_its_files() {
    let (_directory, base) = base();
    let target = base.join("folder");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("kept.txt"), "kept\n").unwrap();
    coordinator(&base).create_repository(&target).unwrap();
    assert!(target.join(".git").is_dir());
    assert_eq!(
        fs::read_to_string(target.join("kept.txt")).unwrap(),
        "kept\n"
    );
}

#[test]
fn creating_refuses_an_existing_repository_and_a_file() {
    let (_directory, base) = base();
    let core = coordinator(&base);
    let repo = base.join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "--quiet"]);
    let head = fs::read(repo.join(".git/HEAD")).unwrap();
    let error = core.create_repository(&repo).unwrap_err();
    assert!(error.message.contains("Local folder"), "{}", error.message);
    assert_eq!(fs::read(repo.join(".git/HEAD")).unwrap(), head);

    let file = base.join("file");
    fs::write(&file, "").unwrap();
    assert!(core.create_repository(&file).is_err());
    assert!(file.is_file());
    assert!(core.create_repository(&file.join("below")).is_err());
}

#[test]
fn creating_refuses_a_relative_path() {
    let (_directory, base) = base();
    let error = run(
        &coordinator(&base),
        Request::CreateRepository {
            path: "relative/here".to_owned(),
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::UnsupportedPath);
}

/// A bare remote with one commit on main.
fn remote(base: &Path) -> PathBuf {
    let work = base.join("seed");
    fs::create_dir(&work).unwrap();
    git(&work, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(work.join("readme.md"), "hello\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "--quiet", "-m", "first"]);
    git(base, &["clone", "--quiet", "--bare", "seed", "remote.git"]);
    base.join("remote.git")
}

fn clone_request(url: &str, target: &str) -> Request {
    serde_json::from_value(serde_json::json!({
        "op": "cloneRepository",
        "url": url,
        "path": target,
    }))
    .unwrap()
}

#[test]
fn a_clone_from_a_bare_remote_creates_missing_parents_and_opens() {
    let (_directory, base) = base();
    let remote = remote(&base);
    let core = coordinator(&base);
    let target = base.join("new/parent/clone");
    let Response::CloneRepository(cloned) = run(
        &core,
        clone_request(remote.to_str().unwrap(), target.to_str().unwrap()),
    )
    .unwrap() else {
        panic!("the request answered with something else");
    };
    assert_eq!(cloned.path, target.to_str().unwrap());
    assert_eq!(
        fs::read_to_string(target.join("readme.md")).unwrap(),
        "hello\n"
    );
    let Response::Snapshot(snapshot) = run(&core, Request::Snapshot { path: cloned.path }).unwrap()
    else {
        panic!("the request answered with something else");
    };
    assert_eq!(snapshot.commits.len(), 1);
}

#[test]
fn a_clone_goes_into_an_existing_empty_folder() {
    let (_directory, base) = base();
    let remote = remote(&base);
    let target = base.join("empty");
    fs::create_dir(&target).unwrap();
    coordinator(&base)
        .clone_repository(remote.to_str().unwrap(), &target)
        .unwrap();
    assert!(target.join("readme.md").is_file());
}

#[test]
fn a_clone_refuses_a_folder_with_files_and_leaves_it_alone() {
    let (_directory, base) = base();
    let remote = remote(&base);
    let target = base.join("busy");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("mine.txt"), "mine\n").unwrap();
    let error = coordinator(&base)
        .clone_repository(remote.to_str().unwrap(), &target)
        .unwrap_err();
    assert!(error.message.contains("not empty"), "{}", error.message);
    assert_eq!(
        fs::read_to_string(target.join("mine.txt")).unwrap(),
        "mine\n"
    );
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);

    let file = base.join("file");
    fs::write(&file, "mine\n").unwrap();
    assert!(
        coordinator(&base)
            .clone_repository(remote.to_str().unwrap(), &file)
            .is_err()
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "mine\n");
}

#[test]
fn a_clone_refuses_an_invalid_endpoint_before_touching_the_target() {
    let (_directory, base) = base();
    let target = base.join("never");
    for url in [
        "",
        " https://example.test/a.git",
        "-upload-pack=touch",
        "ext::sh -c touch",
        "ftp://example.test/a.git",
        "https://:",
        "https:only",
    ] {
        let result = coordinator(&base).clone_repository(url, &target);
        assert!(result.is_err(), "{url}");
        assert!(!target.exists(), "{url}");
    }
}

#[test]
fn a_failed_clone_reports_git_without_the_urls_credentials() {
    let (_directory, base) = base();
    let target = base.join("failed");
    let request = clone_request(
        "https://ada:s3cret@127.0.0.1:1/team/app.git",
        target.to_str().unwrap(),
    );
    assert!(
        !format!("{request:?}").contains("s3cret"),
        "the request's Debug output hides the URL"
    );
    let error = run(&coordinator(&base), request).unwrap_err();
    assert!(!error.message.contains("s3cret"), "{}", error.message);
    assert!(!error.message.is_empty());
    assert!(!target.exists());
}

#[test]
fn cancelling_nothing_is_fine() {
    let (_directory, base) = base();
    let core = coordinator(&base);
    for _ in 0..2 {
        let answer = run(
            &core,
            Request::CancelClone {
                path: base.join("nothing").to_str().unwrap().to_owned(),
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(answer).unwrap(),
            serde_json::json!({ "op": "cancelClone" })
        );
    }
}
