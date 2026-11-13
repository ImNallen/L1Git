use super::*;
use std::path::Path;

#[test]
fn counts_the_regions_the_resolver_draws() {
    for (text, regions) in [
        ("plain\n", 0),
        ("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n", 1),
        (
            "<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> topic\nkept\n<<<<<<<\nd\n=======\ne\n>>>>>>>\n",
            2,
        ),
        (
            "<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> topic\r\n",
            1,
        ),
        (
            "<<<<<<<<<< long\nours\n==========\ntheirs\n>>>>>>>>>> long\n",
            1,
        ),
        ("<<<<<< six\nours\n======\ntheirs\n>>>>>> six\n", 0),
        ("<<<<<<<x\nours\n=======\ntheirs\n>>>>>>>x\n", 0),
        ("<<<<<<< HEAD\nunfinished\n=======\n", 0),
        (">>>>>>> stray\n", 0),
        (
            "<<<<<<< outer\n<<<<<<< inner\na\n=======\nb\n>>>>>>> inner\n=======\nc\n>>>>>>> outer\n",
            2,
        ),
    ] {
        assert_eq!(conflict_regions(text), regions, "{text:?}");
    }
}

#[test]
fn a_recorded_whole_file_change_keeps_its_stored_form() {
    let head = Head::Attached {
        reference: "refs/heads/main".into(),
        oid: "a".repeat(40),
    };
    let change = super::super::Change::Whole(WholeChange {
        index: IndexChange::empty(head),
        scope: vec![Parent::Folder(Some((1, 2))), Parent::Missing, Parent::Other],
        file: FileChange {
            path: "f.txt".into(),
            before: Content::Absent,
            after: Content::Symlink {
                target: b"t".to_vec(),
            },
        },
    });
    let stored = serde_json::to_value(&change).unwrap();
    assert_eq!(stored["domain"], "whole");
    assert_eq!(
        stored["scope"],
        serde_json::json!([{"folder": [1, 2]}, "missing", "other"])
    );
    assert_eq!(
        serde_json::from_value::<super::super::Change>(stored).unwrap(),
        change
    );
}

fn git(root: &Path, args: &[&str]) -> std::process::Output {
    let mut command = std::process::Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command.arg("-C").arg(root).args(args).output().unwrap()
}

fn ok(root: &Path, args: &[&str]) -> String {
    let output = git(root, args);
    assert!(output.status.success(), "{args:?}");
    String::from_utf8(output.stdout).unwrap()
}

fn deleted_by_us() -> (tempfile::TempDir, std::path::PathBuf, crate::Coordinator) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("repo");
    fs::create_dir(&root).unwrap();
    ok(&root, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("core.hooksPath", "/dev/null"),
        ("commit.gpgSign", "false"),
    ] {
        ok(&root, &["config", key, value]);
    }
    fs::write(root.join("f"), "base\n").unwrap();
    ok(&root, &["add", "."]);
    ok(&root, &["commit", "-qm", "base"]);
    ok(&root, &["switch", "-qc", "topic"]);
    fs::write(root.join("f"), "theirs\n").unwrap();
    ok(&root, &["commit", "-qam", "theirs"]);
    ok(&root, &["switch", "-q", "main"]);
    ok(&root, &["rm", "-q", "f"]);
    ok(&root, &["commit", "-qm", "ours"]);
    assert!(!git(&root, &["merge", "-q", "topic"]).status.success());
    let coordinator = crate::Coordinator::new(crate::Limits::default(), temp.path().join("undo"));
    (temp, root, coordinator)
}

fn delete(root: &Path, coordinator: &crate::Coordinator) -> Result<Applied, RepositoryError> {
    let path = root.to_str().unwrap();
    let Some(ConflictSummary::WholeFile { version, .. }) =
        conflict_summary_within(path, coordinator.deadline(git::LocalRead::ConflictSummary))
            .unwrap()
            .pop()
    else {
        panic!("f should be a whole-file conflict");
    };
    coordinator.write(
        path,
        &crate::Operation::ResolveWhole {
            path: "f".into(),
            version,
            keep: ConflictKeep::Current,
        },
        &Expect {
            head: crate::worktree_status(path).unwrap().head,
        },
    )
}

#[test]
fn a_stop_before_placing_leaves_no_entry() {
    let (_temp, root, coordinator) = deleted_by_us();
    let conflict = ok(&root, &["ls-files", "--stage", "--debug", "f"]);
    fs::write(root.join(".fail-whole-recorded"), "").unwrap();
    assert!(delete(&root, &coordinator).is_err());
    fs::remove_file(root.join(".fail-whole-recorded")).unwrap();
    assert_eq!(
        ok(&root, &["ls-files", "--stage", "--debug", "f"]),
        conflict
    );
    assert_eq!(fs::read(root.join("f")).unwrap(), b"theirs\n");
    let history = coordinator.undo_history(root.to_str().unwrap()).unwrap();
    assert_eq!((history.undo, history.redo), (None, None));
}

#[test]
fn a_stop_after_placing_keeps_an_entry_that_undoes_the_file() {
    let (_temp, root, coordinator) = deleted_by_us();
    let conflict = ok(&root, &["ls-files", "--stage", "f"]);
    fs::write(root.join(".fail-whole-placed"), "").unwrap();
    let error = delete(&root, &coordinator).unwrap_err();
    assert!(
        error.message.contains("Undo puts the file back"),
        "{error:?}"
    );
    fs::remove_file(root.join(".fail-whole-placed")).unwrap();
    assert!(!root.join("f").exists());
    assert_eq!(ok(&root, &["ls-files", "--stage", "f"]), conflict);
    let path = root.to_str().unwrap();
    let undo = coordinator.undo_history(path).unwrap().undo.unwrap();
    coordinator.undo(path, undo.id).unwrap();
    assert_eq!(fs::read(root.join("f")).unwrap(), b"theirs\n");
    assert_eq!(ok(&root, &["ls-files", "--stage", "f"]), conflict);
    let applied = delete(&root, &coordinator).unwrap();
    assert!(!root.join("f").exists());
    assert_eq!(ok(&root, &["ls-files", "--stage", "f"]), "");
    coordinator.undo(path, applied.id).unwrap();
    assert_eq!(ok(&root, &["ls-files", "--stage", "f"]), conflict);
}

#[test]
fn only_line_ending_rules_make_a_size_difference_unproven() {
    let attrs = |text: &str, eol: &str| format!("f\0text\0{text}\0f\0eol\0{eol}\0").into_bytes();
    let none = attrs("unspecified", "unspecified");
    for (attributes, config, converts_expected) in [
        (none.clone(), b"".to_vec(), false),
        (none.clone(), b"core.autocrlf\nfalse\0".to_vec(), false),
        (none.clone(), b"core.autocrlf\ntrue\0".to_vec(), true),
        (
            none.clone(),
            b"core.autocrlf\ntrue\0core.autocrlf\nfalse\0".to_vec(),
            false,
        ),
        (none.clone(), b"core.autocrlf\ninput\0".to_vec(), true),
        (attrs("set", "unspecified"), b"".to_vec(), true),
        (attrs("unset", "unspecified"), b"".to_vec(), false),
        (attrs("auto", "crlf"), b"".to_vec(), true),
    ] {
        assert_eq!(
            converts(&attributes, &config),
            converts_expected,
            "{attributes:?} {config:?}"
        );
    }
}

fn read_whole(root: &Path, file: &str) -> Option<WholeFileConflict> {
    let deadline = crate::Coordinator::new(crate::Limits::default(), root.join("../undo"))
        .deadline(git::LocalRead::ConflictFile);
    whole_file_within(root.to_str().unwrap(), file, deadline).unwrap()
}

#[test]
fn reads_each_version_of_a_whole_file_conflict() {
    let (_temp, root, coordinator) = deleted_by_us();
    let whole = read_whole(&root, "f").unwrap();
    let summary = conflict_summary_within(
        root.to_str().unwrap(),
        coordinator.deadline(git::LocalRead::ConflictSummary),
    )
    .unwrap();
    assert_eq!(
        summary,
        vec![ConflictSummary::WholeFile {
            path: "f".into(),
            version: whole.version.clone(),
            shape: WholeFileShape::DeletedByUs,
            current: None,
            incoming: Some(ConflictSide {
                mode: Mode::File,
                size: 7
            }),
            disk: WholeFileDisk::MatchesIncoming,
        }]
    );
    assert_eq!(
        whole.head,
        crate::worktree_status(root.to_str().unwrap()).unwrap().head
    );
    assert_eq!(whole.base.as_deref(), Some("base\n"));
    assert_eq!(whole.current, None);
    assert_eq!(
        whole.incoming,
        Some(WholeFileSide {
            mode: Mode::File,
            size: 7,
            text: Some("theirs\n".into()),
        })
    );
    assert_eq!(read_whole(&root, "missing"), None);
}

#[cfg(unix)]
#[test]
fn reads_a_link_target_and_no_text_for_binary_versions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("repo");
    fs::create_dir(&root).unwrap();
    ok(&root, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.test"),
        ("core.hooksPath", "/dev/null"),
        ("commit.gpgSign", "false"),
    ] {
        ok(&root, &["config", key, value]);
    }
    let link = |target: &str| {
        let _ = fs::remove_file(root.join("link"));
        std::os::unix::fs::symlink(target, root.join("link")).unwrap();
    };
    let commit = |blob: &[u8], target: &str, text: &str, message: &str| {
        fs::write(root.join("blob.bin"), blob).unwrap();
        link(target);
        fs::write(root.join("text.txt"), text).unwrap();
        ok(&root, &["add", "-A"]);
        ok(&root, &["commit", "-qm", message]);
    };
    commit(b"\0base", "base-target", "base\n", "base");
    ok(&root, &["switch", "-qc", "topic"]);
    commit(b"\0theirs!", "their-target", "theirs\n", "theirs");
    ok(&root, &["switch", "-q", "main"]);
    commit(b"\0ours", "our-target", "ours\n", "ours");
    assert!(!git(&root, &["merge", "-q", "topic"]).status.success());

    let binary = read_whole(&root, "blob.bin").unwrap();
    assert_eq!(binary.shape, WholeFileShape::Binary);
    assert_eq!(
        (binary.current, binary.incoming),
        (
            Some(WholeFileSide {
                mode: Mode::File,
                size: 5,
                text: None
            }),
            Some(WholeFileSide {
                mode: Mode::File,
                size: 8,
                text: None
            })
        )
    );
    let symlink = read_whole(&root, "link").unwrap();
    assert_eq!(symlink.shape, WholeFileShape::Symlink);
    assert_eq!(symlink.base.as_deref(), Some("base-target"));
    assert_eq!(
        symlink.current.and_then(|side| side.text).as_deref(),
        Some("our-target")
    );
    assert_eq!(
        symlink.incoming.and_then(|side| side.text).as_deref(),
        Some("their-target")
    );
    assert_eq!(read_whole(&root, "text.txt"), None);
}
