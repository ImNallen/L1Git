use super::*;
use crate::{Coordinator, Limits, Operation, StaleReason, git::LocalRead};
use std::{path::PathBuf, process::Command};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    undo: PathBuf,
    coordinator: Coordinator,
}
impl Fixture {
    fn new(pop: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("repo");
        let undo = temp.path().join("undo");
        fs::create_dir(&root).unwrap();
        let fixture = Self {
            coordinator: Coordinator::new(Limits::default(), undo.clone()),
            _temp: temp,
            root,
            undo,
        };
        fixture.git(&["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("core.hooksPath", "/dev/null"),
            ("core.autocrlf", "false"),
        ] {
            fixture.git(&["config", key, value]);
        }
        fs::create_dir(fixture.root.join("dir")).unwrap();
        fixture.put("base\n");
        fs::write(fixture.root.join("g"), "original\n").unwrap();
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "-qm", "base"]);
        fixture.put("incoming\n");
        fixture.git(&["stash", "push", "-qm", "incoming"]);
        fixture.put("current\n");
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "-qm", "current"]);
        let output = fixture
            .command(&["stash", if pop { "pop" } else { "apply" }])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(fixture.git(&["ls-files", "-u"]).contains("dir/f"));
        fixture
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        command.arg("-C").arg(&self.root).args(args);
        command
    }
    fn git(&self, args: &[&str]) -> String {
        let output = self.command(args).output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
    fn put(&self, text: impl AsRef<[u8]>) {
        fs::write(self.root.join("dir/f"), text).unwrap();
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(self.root.join("dir/f")).unwrap()
    }
    fn read(&self) -> ConflictFile {
        conflict_file_within(
            self.path(),
            "dir/f",
            self.coordinator.deadline(LocalRead::ConflictFile),
        )
        .unwrap()
    }
    fn snapshot(&self) -> ConflictSnapshot {
        let ConflictFile::Editable { snapshot } = self.read() else {
            panic!("not editable")
        };
        *snapshot
    }
    fn save(&self, seen: &ConflictSnapshot, text: &str) -> Result<Applied, RepositoryError> {
        self.coordinator.write(
            self.path(),
            &Operation::SaveConflict {
                path: seen.path.clone(),
                version: seen.version.clone(),
                text: Some(text.into()),
            },
            &Expect {
                head: seen.head.clone(),
            },
        )
    }
    fn history(&self) -> crate::UndoHistory {
        self.coordinator.undo_history(self.path()).unwrap()
    }
    fn settle(&self) -> Result<(), RepositoryError> {
        self.coordinator
            .locked(self.path(), git::LocalWrite::SaveConflict, |_, _, _, _| {
                Ok(())
            })
    }
    fn fail(&self, point: &str) {
        fs::write(self.root.join(format!(".fail-resolution-{point}")), "").unwrap();
    }
}

#[test]
fn stash_apply_and_pop_save_mark_and_two_ordered_undo_redo_steps() {
    for pop in [false, true] {
        let f = Fixture::new(pop);
        let seen = f.snapshot();
        assert_eq!(
            (&*seen.base, &*seen.current, &*seen.incoming),
            ("base\n", "current\n", "incoming\n")
        );
        let before = f.bytes();
        let index = f.git(&["ls-files", "--stage"]);
        fs::write(f.root.join("g"), "unrelated\n").unwrap();
        f.git(&["add", "g"]);
        let unrelated = f.git(&["ls-files", "--stage", "g"]);
        let saved = f.save(&seen, "resolved\n").unwrap();
        assert_eq!(f.bytes(), b"resolved\n");
        assert_eq!(
            f.git(&["ls-files", "-u"]),
            index
                .lines()
                .filter(|l| l.ends_with("dir/f"))
                .map(|l| format!("{l}\n"))
                .collect::<String>()
        );
        let fresh = f.snapshot();
        let marked = f
            .coordinator
            .write(
                f.path(),
                &Operation::StageFiles {
                    entries: vec![fresh.entry],
                },
                &Expect { head: fresh.head },
            )
            .unwrap();
        assert!(f.git(&["ls-files", "-u"]).is_empty());
        f.coordinator.undo(f.path(), marked.id).unwrap();
        assert!(!f.git(&["ls-files", "-u"]).is_empty());
        assert_eq!(f.bytes(), b"resolved\n");
        f.coordinator.undo(f.path(), saved.id).unwrap();
        assert_eq!(f.bytes(), before);
        f.coordinator.redo(f.path(), saved.id).unwrap();
        assert_eq!(f.bytes(), b"resolved\n");
        f.coordinator.redo(f.path(), marked.id).unwrap();
        assert!(f.git(&["ls-files", "-u"]).is_empty());
        assert_eq!(f.git(&["ls-files", "--stage", "g"]), unrelated);
        assert_eq!(f.git(&["stash", "list"]).lines().count(), 1);
        let encoded = serde_json::to_string(&saved).unwrap();
        assert!(!encoded.contains("resolved\\n"));
        assert!(!encoded.contains("\"text\""));
        assert!(encoded.len() < 1024);
        let loaded: Applied = serde_json::from_str(&encoded).unwrap();
        assert!(matches!(loaded.operation, Operation::SaveConflict { text, .. } if text.is_none()));
    }
}

#[test]
fn save_refuses_stale_head_index_bytes_identity_permissions_and_transforms() {
    for case in [
        "head",
        "index",
        "bytes",
        "identity",
        "permissions",
        "attributes",
        "config",
    ] {
        let f = Fixture::new(false);
        let seen = f.snapshot();
        match case {
            "head" => {
                f.git(&["update-ref", "refs/heads/main", "HEAD~1"]);
            }
            "index" => {
                f.git(&["add", "dir/f"]);
            }
            "bytes" => f.put("external\n"),
            "identity" => {
                let bytes = f.bytes();
                fs::remove_file(f.root.join("dir/f")).unwrap();
                f.put(bytes);
            }
            "permissions" => files::set_permissions(&f.root.join("dir/f"), 0o755).unwrap(),
            "attributes" => {
                fs::write(f.root.join(".gitattributes"), "dir/f ident\n").unwrap();
            }
            "config" => {
                f.git(&["config", "core.autocrlf", "true"]);
            }
            _ => unreachable!(),
        }
        let bytes = f.bytes();
        let rows = f.git(&["ls-files", "--stage"]);
        assert!(
            matches!(
                f.save(&seen, "result\n").unwrap_err().kind,
                ErrorKind::StaleView { .. }
            ),
            "{case}"
        );
        assert_eq!(f.bytes(), bytes);
        assert_eq!(f.git(&["ls-files", "--stage"]), rows);
        assert!(f.history().undo.is_none());
    }
}

#[test]
fn unsupported_representations_and_unsafe_paths_are_refused() {
    for (bytes, reason) in [
        (vec![0, 1], ConflictUnsupported::Binary),
        (vec![255], ConflictUnsupported::Encoding),
        (
            vec![b'x'; CONFLICT_TEXT_LIMIT + 1],
            ConflictUnsupported::TooLarge,
        ),
        (b"one\r\ntwo\n".to_vec(), ConflictUnsupported::Encoding),
    ] {
        let f = Fixture::new(false);
        f.put(bytes);
        assert!(
            matches!(f.read(), ConflictFile::External { reason: actual, .. } if actual == reason)
        );
    }
    for attr in ["filter=custom", "ident", "working-tree-encoding=UTF-16"] {
        let f = Fixture::new(false);
        fs::write(f.root.join(".gitattributes"), format!("dir/f {attr}\n")).unwrap();
        assert!(matches!(
            f.read(),
            ConflictFile::External {
                reason: ConflictUnsupported::Attributes,
                ..
            }
        ));
    }
    let f = Fixture::new(false);
    for path in ["../outside", ".git/config", "/tmp/outside", "dir/../g"] {
        assert!(
            conflict_file_within(
                f.path(),
                path,
                f.coordinator.deadline(LocalRead::ConflictFile)
            )
            .is_err()
        );
    }
    f.git(&["add", "dir/f"]);
    assert!(matches!(
        f.read(),
        ConflictFile::External {
            reason: ConflictUnsupported::Structural,
            ..
        }
    ));
}

#[cfg(unix)]
#[test]
fn never_reads_or_overwrites_a_symlink_target_or_parent() {
    use std::os::unix::fs::symlink;
    for parent in [false, true] {
        let f = Fixture::new(false);
        let seen = f.snapshot();
        let outside = f._temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("f"), "private\n").unwrap();
        if parent {
            fs::remove_dir_all(f.root.join("dir")).unwrap();
            symlink(&outside, f.root.join("dir")).unwrap();
        } else {
            fs::remove_file(f.root.join("dir/f")).unwrap();
            symlink(outside.join("f"), f.root.join("dir/f")).unwrap();
        }
        assert!(f.save(&seen, "result\n").is_err());
        assert_eq!(fs::read(outside.join("f")).unwrap(), b"private\n");
        if !parent {
            assert!(matches!(
                f.read(),
                ConflictFile::External {
                    reason: ConflictUnsupported::SpecialFile,
                    ..
                }
            ));
        }
    }
}

#[test]
fn preserves_crlf_no_final_newline_and_mode_without_cleaning_restored_bytes() {
    for original in ["one\r\ntwo\r\n", "one\r\ntwo", "one\ntwo", ""] {
        let f = Fixture::new(false);
        f.put(original);
        files::set_permissions(&f.root.join("dir/f"), 0o755).unwrap();
        fs::write(f.root.join(".gitattributes"), "dir/f text eol=crlf\n").unwrap();
        let saved = f.save(&f.snapshot(), "result\r\nlast").unwrap();
        assert_eq!(f.bytes(), b"result\r\nlast");
        assert_eq!(
            files::permissions(&fs::metadata(f.root.join("dir/f")).unwrap()),
            0o755
        );
        f.coordinator.undo(f.path(), saved.id).unwrap();
        assert_eq!(f.bytes(), original.as_bytes());
        f.coordinator.redo(f.path(), saved.id).unwrap();
        assert_eq!(f.bytes(), b"result\r\nlast");
    }
}

#[test]
fn external_edits_block_undo_redo_and_noop_does_not_record() {
    let f = Fixture::new(false);
    let seen = f.snapshot();
    assert_eq!(
        f.save(&seen, &seen.working).unwrap_err().kind,
        ErrorKind::UnchangedPath
    );
    assert!(f.history().undo.is_none());
    let saved = f.save(&seen, "result\n").unwrap();
    f.put("external\n");
    assert_eq!(
        f.coordinator.undo(f.path(), saved.id).unwrap_err().kind,
        ErrorKind::StaleView {
            reason: StaleReason::PathChanged
        }
    );
    assert_eq!(f.bytes(), b"external\n");
    f.put("result\n");
    f.coordinator.undo(f.path(), saved.id).unwrap();
    f.put("external again\n");
    assert!(f.coordinator.redo(f.path(), saved.id).is_err());
    assert_eq!(f.bytes(), b"external again\n");
}

#[test]
fn failures_before_placement_drop_record_but_after_placement_retain_and_settle() {
    for point in ["recorded", "placed"] {
        let f = Fixture::new(false);
        let seen = f.snapshot();
        f.fail(point);
        let error = f.save(&seen, "result\n").unwrap_err();
        if point == "recorded" {
            assert_eq!(f.bytes(), seen.working.as_bytes());
        } else {
            assert_eq!(f.bytes(), b"result\n");
            assert!(error.message.contains("placed on disk"));
        }
        f.settle().unwrap();
        if point == "recorded" {
            assert!(f.history().undo.is_none());
        } else {
            let saved = f.history().undo.unwrap();
            f.coordinator.undo(f.path(), saved.id).unwrap();
            assert_eq!(f.bytes(), seen.working.as_bytes());
        }
    }
}

#[test]
fn recovery_after_restart_classifies_before_after_neither_and_resolved_index() {
    for state in ["before", "after", "neither", "resolved"] {
        let mut f = Fixture::new(false);
        let seen = f.snapshot();
        if state == "before" {
            fs::write(f.root.join(".stop-resolution-recorded"), "").unwrap();
        } else {
            f.fail("placed");
        }
        assert!(f.save(&seen, "result\n").is_err());
        if state == "neither" {
            f.put("external\n");
        }
        if state == "resolved" {
            f.git(&["add", "dir/f"]);
        }
        f.coordinator = Coordinator::new(Limits::default(), f.undo.clone());
        if state == "neither" {
            assert!(f.settle().is_err());
            assert_eq!(f.bytes(), b"external\n");
            f.put("result\n");
            f.settle().unwrap();
            assert!(f.history().undo.is_some());
        } else {
            f.settle().unwrap();
            assert_eq!(f.history().undo.is_some(), state != "before");
        }
    }
}

#[test]
fn stopped_undo_and_redo_can_be_repeated_without_losing_the_journal() {
    let f = Fixture::new(false);
    let seen = f.snapshot();
    let saved = f.save(&seen, "result\n").unwrap();
    f.fail("stepped");
    assert!(f.coordinator.undo(f.path(), saved.id).is_err());
    assert_eq!(f.bytes(), seen.working.as_bytes());
    fs::remove_file(f.root.join(".fail-resolution-stepped")).unwrap();
    f.coordinator.undo(f.path(), saved.id).unwrap();
    f.fail("stepped");
    assert!(f.coordinator.redo(f.path(), saved.id).is_err());
    assert_eq!(f.bytes(), b"result\n");
    fs::remove_file(f.root.join(".fail-resolution-stepped")).unwrap();
    f.coordinator.redo(f.path(), saved.id).unwrap();
}
