use super::*;
use crate::{ConflictFile, Expect, Limits, Request, Response, worktree_status};
use std::process::Command;
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    undo: PathBuf,
}
impl Fixture {
    fn new(conflict: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        #[cfg(not(windows))]
        let root = root.canonicalize().unwrap();
        let root = root.join("repository");
        fs::create_dir(&root).unwrap();
        let fixture = Self {
            undo: temp.path().join("undo"),
            root,
            _temp: temp,
        };
        fixture.git(&["init", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Merge test"),
            ("user.email", "merge@example.test"),
            ("core.hooksPath", "/dev/null"),
            ("commit.gpgSign", "false"),
            ("maintenance.auto", "false"),
            ("gc.auto", "0"),
        ] {
            fixture.git(&["config", key, value]);
        }
        fixture.put("conflict.txt", "base\n");
        fixture.put("other.txt", "original\n");
        fixture.put(".gitignore", "ignored.txt\n");
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "-m", "base"]);
        fixture.git(&["switch", "-c", "upstream"]);
        fixture.put(
            if conflict {
                "conflict.txt"
            } else {
                "incoming.txt"
            },
            "incoming\n",
        );
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "-m", "incoming"]);
        fixture.git(&["switch", "main"]);
        fixture.put("conflict.txt", "current\n");
        fixture.git(&["commit", "-am", "current"]);
        fixture.git(&["branch", "--set-upstream-to=upstream"]);
        fixture
    }
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
    fn coordinator(&self) -> Coordinator {
        Coordinator::new(Limits::default(), &self.undo)
    }
    fn put(&self, path: &str, text: &str) {
        fs::write(self.root.join(path), text).unwrap();
    }
    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }
    fn start(&self, coordinator: &Coordinator) -> MergeSession {
        let review = coordinator
            .review_merge(self.path(), &MergeSelection::Upstream)
            .unwrap();
        let report = coordinator
            .merge(self.path(), &MergeAction::Start { review })
            .unwrap();
        assert!(
            matches!(report.outcome, MergeOutcome::Started { problem: None }),
            "{report:?}"
        );
        active(report.state)
    }
    fn finish(&self, coordinator: &Coordinator) -> MergeReport {
        let MergeState::Active {
            session,
            staged,
            tree: Some(tree),
            ..
        } = coordinator.merge_state(self.path()).unwrap()
        else {
            panic!("Expected ready merge")
        };
        coordinator
            .merge(
                self.path(),
                &MergeAction::Finish {
                    session: session.id,
                    staged,
                    tree,
                    message: "Merge reviewed upstream".into(),
                },
            )
            .unwrap()
    }
    fn record(&self) -> (Repo, Record, WriteDeadline) {
        let deadline = self.coordinator().write_deadline(LocalWrite::MergeStart);
        let repo = Repo::open(self.path(), deadline.reads()).unwrap();
        let record = load(&repo).unwrap().unwrap();
        (repo, record, deadline)
    }
    fn stage(&self, coordinator: &Coordinator, path: &str) -> super::super::Applied {
        let status = worktree_status(self.path()).unwrap();
        let entries = status
            .entries
            .into_iter()
            .filter(|entry| paths(std::slice::from_ref(entry)).contains(path))
            .collect();
        coordinator
            .write(
                self.path(),
                &Operation::StageFiles { entries },
                &Expect { head: status.head },
            )
            .unwrap()
    }
    #[cfg(unix)]
    fn hook(&self, name: &str, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        self.git(&["config", "core.hooksPath", ".git/hooks"]);
        let path = self.root.join(".git/hooks").join(name);
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
fn git(path: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command.arg("-C").arg(path).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}
fn active(state: MergeState) -> MergeSession {
    match state {
        MergeState::Active { session, .. } => session,
        state @ (MergeState::Idle | MergeState::Attention { .. }) => panic!("{state:?}"),
    }
}

#[test]
fn clean_merge_pins_parents_survives_restart_and_retires_history() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let session = f.start(&coordinator);
    assert_eq!(
        f.git(&["rev-parse", "HEAD"]),
        session.review.destination.oid.as_str()
    );
    assert_eq!(
        f.git(&["rev-parse", "MERGE_HEAD"]),
        session.review.source.oid.as_str()
    );
    let reopened = f.coordinator();
    assert_eq!(active(reopened.merge_state(f.path()).unwrap()), session);
    let report = f.finish(&reopened);
    assert!(matches!(
        report.outcome,
        MergeOutcome::Finished { problem: None, .. }
    ));
    assert_eq!(
        f.git(&["show", "-s", "--format=%P", "HEAD"]),
        format!(
            "{} {}",
            session.review.destination.oid.as_str(),
            session.review.source.oid.as_str()
        )
    );
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert_eq!(reopened.undo_history(f.path()).unwrap().undo, None);
    let retried = reopened
        .merge(
            f.path(),
            &MergeAction::Abort {
                session: session.id,
            },
        )
        .unwrap();
    assert_eq!(retried.outcome, report.outcome);
}

#[test]
fn conflict_edits_have_ordered_undo_redo_and_abort_closes_the_journal() {
    let f = Fixture::new(true);
    let coordinator = f.coordinator();
    let session = f.start(&coordinator);
    let before = fs::read(f.root.join("conflict.txt")).unwrap();
    let Response::ConflictFile(ConflictFile::Editable { snapshot }) = crate::run(
        &coordinator,
        Request::ConflictFile {
            path: f.path().into(),
            file: "conflict.txt".into(),
        },
    )
    .unwrap() else {
        panic!("Expected text conflict")
    };
    let saved = coordinator
        .write(
            f.path(),
            &Operation::SaveConflict {
                path: "conflict.txt".into(),
                version: snapshot.version,
                text: Some("resolved\n".into()),
            },
            &Expect {
                head: worktree_status(f.path()).unwrap().head,
            },
        )
        .unwrap();
    let marked = f.stage(&coordinator, "conflict.txt");
    coordinator.undo(f.path(), marked.id).unwrap();
    assert!(!f.git(&["ls-files", "-u"]).is_empty());
    assert_eq!(
        fs::read_to_string(f.root.join("conflict.txt")).unwrap(),
        "resolved\n"
    );
    coordinator.undo(f.path(), saved.id).unwrap();
    assert_eq!(fs::read(f.root.join("conflict.txt")).unwrap(), before);
    coordinator.redo(f.path(), saved.id).unwrap();
    coordinator.redo(f.path(), marked.id).unwrap();
    assert_eq!(f.git(&["ls-files", "-u"]), "");
    coordinator
        .merge(
            f.path(),
            &MergeAction::Abort {
                session: session.id,
            },
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("conflict.txt")).unwrap(),
        "current\n"
    );
    assert!(coordinator.undo(f.path(), saved.id).is_err());
    assert!(coordinator.redo(f.path(), marked.id).is_err());
    assert_eq!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Abort {
                    session: session.id
                }
            )
            .unwrap()
            .outcome,
        MergeOutcome::Aborted
    );
}

#[test]
fn abort_refuses_unrelated_staged_and_unstaged_edits_before_git_runs() {
    for staged in [false, true] {
        let f = Fixture::new(true);
        let coordinator = f.coordinator();
        let session = f.start(&coordinator);
        f.put("other.txt", "precious\n");
        if staged {
            f.git(&["add", "other.txt"]);
        }
        let index = f.git(&["ls-files", "--stage"]);
        let error = coordinator
            .merge(
                f.path(),
                &MergeAction::Abort {
                    session: session.id,
                },
            )
            .unwrap_err();
        assert!(error.message.contains("other.txt"), "{error:?}");
        assert_eq!(f.git(&["ls-files", "--stage"]), index);
        assert_eq!(
            fs::read_to_string(f.root.join("other.txt")).unwrap(),
            "precious\n"
        );
        assert_eq!(
            f.git(&["rev-parse", "MERGE_HEAD"]),
            session.review.source.oid.as_str()
        );
        let status = worktree_status(f.path()).unwrap();
        let operation = Operation::StageFiles {
            entries: status
                .entries
                .into_iter()
                .filter(|entry| paths(std::slice::from_ref(entry)).contains("other.txt"))
                .collect(),
        };
        assert!(
            coordinator
                .write(f.path(), &operation, &Expect { head: status.head })
                .is_err()
        );
    }
}

#[test]
fn abort_preserves_untracked_and_ignored_files_and_base_history() {
    let f = Fixture::new(true);
    let coordinator = f.coordinator();
    f.put("other.txt", "temporary\n");
    let entry = f.stage(&coordinator, "other.txt");
    coordinator.undo(f.path(), entry.id).unwrap();
    f.git(&["restore", "other.txt"]);
    let history = coordinator.undo_history(f.path()).unwrap();
    f.put("notes.txt", "keep\n");
    f.put("ignored.txt", "keep ignored\n");
    let session = f.start(&coordinator);
    coordinator
        .merge(
            f.path(),
            &MergeAction::Abort {
                session: session.id,
            },
        )
        .unwrap();
    assert_eq!(coordinator.undo_history(f.path()).unwrap(), history);
    assert_eq!(
        fs::read_to_string(f.root.join("notes.txt")).unwrap(),
        "keep\n"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("ignored.txt")).unwrap(),
        "keep ignored\n"
    );
}

#[test]
fn zero_tree_delta_can_finish_and_upstream_movement_does_not_invalidate_it() {
    let f = Fixture::new(true);
    let coordinator = f.coordinator();
    let session = f.start(&coordinator);
    f.put("conflict.txt", "current\n");
    let entry = f.stage(&coordinator, "conflict.txt");
    f.git(&[
        "update-ref",
        "refs/heads/upstream",
        session.review.destination.oid.as_str(),
    ]);
    assert!(matches!(
        coordinator.merge_state(f.path()).unwrap(),
        MergeState::Active {
            source_moved: true,
            ..
        }
    ));
    f.finish(&coordinator);
    assert_eq!(
        f.git(&["rev-parse", "HEAD^{tree}"]),
        f.git(&["rev-parse", "HEAD^1^{tree}"])
    );
    assert_eq!(
        f.git(&["rev-parse", "HEAD^2"]),
        session.review.source.oid.as_str()
    );
    assert!(coordinator.undo(f.path(), entry.id).is_err());
}

#[test]
fn stale_reviews_dirty_start_hidden_index_and_foreign_operations_refuse() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let shown = coordinator
        .review_merge(f.path(), &MergeSelection::Upstream)
        .unwrap();
    f.git(&["config", "branch.main.remote", "missing"]);
    assert!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Start {
                    review: shown.clone()
                }
            )
            .is_err()
    );
    f.git(&["config", "branch.main.remote", "."]);
    f.put("other.txt", "dirty\n");
    assert!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Start {
                    review: shown.clone()
                }
            )
            .is_err()
    );
    f.git(&["update-index", "--assume-unchanged", "other.txt"]);
    assert!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Start {
                    review: shown.clone()
                }
            )
            .is_err()
    );
    f.git(&["update-index", "--no-assume-unchanged", "other.txt"]);
    f.git(&["restore", "other.txt"]);
    fs::write(
        f.root.join(".git/CHERRY_PICK_HEAD"),
        shown.source.oid.as_str(),
    )
    .unwrap();
    assert!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Start {
                    review: shown.clone()
                }
            )
            .is_err()
    );
    fs::remove_file(f.root.join(".git/CHERRY_PICK_HEAD")).unwrap();
    f.git(&[
        "update-ref",
        "refs/heads/upstream",
        shown.destination.oid.as_str(),
    ]);
    assert!(
        coordinator
            .merge(f.path(), &MergeAction::Start { review: shown })
            .is_err()
    );
    assert_eq!(f.git(&["status", "--porcelain"]), "");
}

#[test]
fn stale_staged_result_and_ordinary_commit_cannot_finish() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    f.start(&coordinator);
    let MergeState::Active {
        session,
        staged,
        tree: Some(tree),
        ..
    } = coordinator.merge_state(f.path()).unwrap()
    else {
        panic!()
    };
    let status = worktree_status(f.path()).unwrap();
    assert!(
        coordinator
            .write(
                f.path(),
                &Operation::Commit {
                    message: "wrong".into(),
                    staged: status.staged_stamp
                },
                &Expect { head: status.head }
            )
            .is_err()
    );
    f.put("incoming.txt", "changed\n");
    f.git(&["add", "incoming.txt"]);
    assert!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Finish {
                    session: session.id,
                    staged,
                    tree,
                    message: "stale".into()
                }
            )
            .is_err()
    );
    assert_eq!(
        f.git(&["rev-parse", "HEAD"]),
        session.review.destination.oid.as_str()
    );
}

#[test]
fn interrupted_intents_reconcile_without_replaying_git() {
    for phase in ["starting", "finishing", "aborting"] {
        let f = Fixture::new(false);
        let coordinator = f.coordinator();
        let session = f.start(&coordinator);
        let (repo, mut record, deadline) = f.record();
        record.phase = match phase {
            "starting" => SessionPhase::Starting,
            "finishing" => SessionPhase::Finishing {
                tree: staged_tree(&repo, deadline).unwrap(),
            },
            _ => SessionPhase::Aborting,
        };
        record.save(&repo).unwrap();
        let reopened = f.coordinator();
        if phase != "finishing" {
            assert!(matches!(
                reopened.merge_state(f.path()).unwrap(),
                MergeState::Attention { .. }
            ));
            assert!(
                reopened
                    .merge(
                        f.path(),
                        &MergeAction::Abort {
                            session: session.id
                        }
                    )
                    .is_err()
            );
            assert!(reopened.undo_history(f.path()).is_err());
        } else {
            assert!(matches!(
                reopened.merge_state(f.path()).unwrap(),
                MergeState::Active { .. }
            ));
        }
        assert_eq!(
            f.git(&["rev-parse", "HEAD"]),
            session.review.destination.oid.as_str()
        );
    }
}

#[test]
fn interrupted_terminal_intents_are_closed_with_durable_receipts() {
    for finish in [true, false] {
        let f = Fixture::new(false);
        let coordinator = f.coordinator();
        let session = f.start(&coordinator);
        let (repo, mut record, deadline) = f.record();
        record.phase = if finish {
            SessionPhase::Finishing {
                tree: staged_tree(&repo, deadline).unwrap(),
            }
        } else {
            SessionPhase::Aborting
        };
        record.save(&repo).unwrap();
        if finish {
            f.git(&["commit", "-m", "finished before crash"]);
        } else {
            f.git(&["merge", "--abort"]);
        }
        let reopened = f.coordinator();
        assert_eq!(reopened.merge_state(f.path()).unwrap(), MergeState::Idle);
        let report = reopened
            .merge(
                f.path(),
                &MergeAction::Abort {
                    session: session.id,
                },
            )
            .unwrap();
        if finish {
            assert!(matches!(
                report.outcome,
                MergeOutcome::Finished {
                    problem: Some(_),
                    ..
                }
            ));
        } else {
            assert_eq!(report.outcome, MergeOutcome::Aborted);
        }
    }
}

#[test]
fn linked_worktree_history_and_branch_mutations_cannot_bypass_a_session() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let other = f.root.parent().unwrap().join("linked");
    f.git(&["worktree", "add", "-b", "linked", other.to_str().unwrap()]);
    let before = worktree_status(f.path()).unwrap();
    let renamed = coordinator
        .write(
            f.path(),
            &Operation::RenameBranch {
                branch: BranchTip {
                    reference: BranchRef::try_from("refs/heads/main".to_owned()).unwrap(),
                    oid: Oid::try_from(f.git(&["rev-parse", "HEAD"])).unwrap(),
                },
                to: "destination".into(),
            },
            &Expect { head: before.head },
        )
        .unwrap();
    let session = f.start(&coordinator);
    assert!(
        coordinator
            .undo(other.to_str().unwrap(), renamed.id)
            .is_err()
    );
    assert!(
        coordinator
            .write(
                other.to_str().unwrap(),
                &Operation::RenameBranch {
                    branch: session.review.destination.clone(),
                    to: "bypass".into()
                },
                &Expect {
                    head: worktree_status(other.to_str().unwrap()).unwrap().head
                }
            )
            .is_err()
    );
    fs::write(other.join("other.txt"), "linked edit\n").unwrap();
    let status = worktree_status(other.to_str().unwrap()).unwrap();
    let entry = coordinator
        .write(
            other.to_str().unwrap(),
            &Operation::StageFiles {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    coordinator.undo(other.to_str().unwrap(), entry.id).unwrap();
    coordinator.redo(other.to_str().unwrap(), entry.id).unwrap();
    assert_eq!(
        active(coordinator.merge_state(f.path()).unwrap()).id,
        session.id
    );
}

#[test]
fn direct_cross_worktree_index_history_is_refused() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    f.put("other.txt", "temporary\n");
    let entry = f.stage(&coordinator, "other.txt");
    coordinator.undo(f.path(), entry.id).unwrap();
    f.git(&["restore", "other.txt"]);
    let other = f.root.parent().unwrap().join("linked");
    f.git(&["worktree", "add", "-b", "linked", other.to_str().unwrap()]);
    f.start(&coordinator);
    assert!(coordinator.redo(other.to_str().unwrap(), entry.id).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("other.txt")).unwrap(),
        "original\n"
    );
}

#[cfg(unix)]
#[test]
fn hooks_can_refuse_or_change_the_reviewed_tree_without_false_success() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    f.start(&coordinator);
    f.hook("pre-commit", "echo refused >&2; exit 1");
    let MergeState::Active {
        session,
        staged,
        tree: Some(tree),
        ..
    } = coordinator.merge_state(f.path()).unwrap()
    else {
        panic!()
    };
    assert!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Finish {
                    session: session.id,
                    staged,
                    tree,
                    message: "refused".into()
                }
            )
            .is_err()
    );
    assert!(matches!(
        coordinator.merge_state(f.path()).unwrap(),
        MergeState::Active { .. }
    ));
    f.hook(
        "pre-commit",
        "echo hook > incoming.txt; git add incoming.txt",
    );
    assert!(matches!(
        f.finish(&coordinator).outcome,
        MergeOutcome::Finished {
            problem: Some(_),
            ..
        }
    ));
    assert_eq!(f.git(&["show", "HEAD:incoming.txt"]), "hook");
}

#[cfg(unix)]
#[test]
fn timeout_after_commit_observes_landed_state_and_stops_hook_descendants() {
    let f = Fixture::new(false);
    f.start(&f.coordinator());
    f.hook(
        "post-commit",
        "(sleep 2; echo escaped > escaped.txt) &\nsleep 20",
    );
    let coordinator = f
        .coordinator()
        .cap_writes(std::time::Duration::from_millis(700));
    assert!(matches!(
        f.finish(&coordinator).outcome,
        MergeOutcome::Finished {
            problem: Some(_),
            ..
        }
    ));
    std::thread::sleep(std::time::Duration::from_millis(2200));
    assert!(!f.root.join("escaped.txt").exists());
}

#[test]
fn ignored_or_untracked_collision_never_overwrites_the_file() {
    for (ignored, name) in [
        (false, "incoming.txt"),
        (true, "incoming.txt"),
        (true, "INCOMING.txt"),
    ] {
        let f = Fixture::new(false);
        let coordinator = f.coordinator();
        if ignored {
            f.git(&["config", "core.excludesFile", ".git/excludes"]);
            fs::write(f.root.join(".git/excludes"), format!("{name}\n")).unwrap();
        }
        f.put(name, "precious collision\n");
        let shown = coordinator
            .review_merge(f.path(), &MergeSelection::Upstream)
            .unwrap();
        let error = coordinator
            .merge(f.path(), &MergeAction::Start { review: shown })
            .unwrap_err();
        assert!(error.message.contains(name), "ignored={ignored} {error:?}");
        assert_eq!(
            fs::read_to_string(f.root.join(name)).unwrap(),
            "precious collision\n"
        );
    }
}

#[cfg(unix)]
#[test]
fn post_commit_hook_failure_reports_the_landed_commit() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    f.start(&coordinator);
    f.hook("post-commit", "echo post-failed >&2; exit 1");
    let report = f.finish(&coordinator);
    let MergeOutcome::Finished {
        problem: Some(problem),
        ..
    } = report.outcome
    else {
        panic!("Expected landed hook diagnostic")
    };
    assert!(problem.contains("post-commit"));
}

#[test]
fn external_head_or_merge_head_changes_keep_evidence_and_block_abort() {
    for change_head in [false, true] {
        let f = Fixture::new(false);
        let coordinator = f.coordinator();
        let session = f.start(&coordinator);
        if change_head {
            f.git(&[
                "update-ref",
                session.review.destination.reference.as_str(),
                session.review.source.oid.as_str(),
            ]);
        } else {
            fs::write(
                f.root.join(".git/MERGE_HEAD"),
                session.review.destination.oid.as_str(),
            )
            .unwrap();
        }
        assert!(matches!(
            coordinator.merge_state(f.path()).unwrap(),
            MergeState::Attention { .. }
        ));
        assert!(
            coordinator
                .merge(
                    f.path(),
                    &MergeAction::Abort {
                        session: session.id
                    }
                )
                .is_err()
        );
        assert!(f.root.join(".git/l1git/merge/current.json").exists());
    }
}

#[test]
fn simultaneous_linked_worktree_sessions_have_independent_journals_and_closure() {
    let f = Fixture::new(true);
    let coordinator = f.coordinator();
    let linked = f.root.parent().unwrap().join("linked merge");
    let path = linked.to_str().unwrap();
    f.git(&["worktree", "add", "-b", "linked", path]);
    git(&linked, &["branch", "--set-upstream-to=upstream"]);
    let first = f.start(&coordinator);
    let review = coordinator
        .review_merge(path, &MergeSelection::Upstream)
        .unwrap();
    let second = active(
        coordinator
            .merge(path, &MergeAction::Start { review })
            .unwrap()
            .state,
    );
    assert_ne!(first.id, second.id);
    fs::write(linked.join("conflict.txt"), "linked resolution\n").unwrap();
    let status = worktree_status(path).unwrap();
    let entry = coordinator
        .write(
            path,
            &Operation::StageFiles {
                entries: status.entries,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert!(coordinator.undo(f.path(), entry.id).is_err());
    coordinator
        .merge(f.path(), &MergeAction::Abort { session: first.id })
        .unwrap();
    assert_eq!(active(coordinator.merge_state(path).unwrap()).id, second.id);
    assert_eq!(
        coordinator.undo_history(path).unwrap().undo.unwrap().id,
        entry.id
    );
    coordinator.undo(path, entry.id).unwrap();
    coordinator
        .merge(path, &MergeAction::Abort { session: second.id })
        .unwrap();
    assert_eq!(git(&linked, &["status", "--porcelain"]), "");
}

#[test]
fn moved_destination_invalidates_start_review_without_writing_merge_metadata() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let review = coordinator
        .review_merge(f.path(), &MergeSelection::Upstream)
        .unwrap();
    f.git(&["commit", "--allow-empty", "-m", "moved"]);
    assert!(
        coordinator
            .merge(f.path(), &MergeAction::Start { review })
            .is_err()
    );
    assert!(!f.root.join(".git/MERGE_HEAD").exists());
}

#[test]
fn pinned_source_survives_remote_rewrite_and_gc() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let session = f.start(&coordinator);
    f.git(&[
        "update-ref",
        "refs/heads/upstream",
        session.review.destination.oid.as_str(),
    ]);
    f.git(&["reflog", "expire", "--expire=now", "--all"]);
    f.git(&["gc", "--prune=now"]);
    let report = f.finish(&coordinator);
    assert!(matches!(report.outcome, MergeOutcome::Finished { .. }));
    assert_eq!(
        f.git(&["show", "-s", "--format=%P", "HEAD"]),
        format!(
            "{} {}",
            session.review.destination.oid.as_str(),
            session.review.source.oid.as_str()
        )
    );
}

#[test]
fn forced_duplicate_checkout_cannot_move_an_active_destination_from_another_worktree() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let linked = f.root.parent().unwrap().join("duplicate");
    let path = linked.to_str().unwrap();
    f.git(&["worktree", "add", "--force", path, "main"]);
    let status = worktree_status(path).unwrap();
    let entry = coordinator
        .write(
            path,
            &Operation::EditMessage {
                message: "Reviewed destination".into(),
            },
            &Expect { head: status.head },
        )
        .unwrap();
    let session = f.start(&coordinator);
    assert!(
        coordinator
            .undo(path, entry.id)
            .unwrap_err()
            .message
            .contains("destination of an unfinished merge")
    );
    fs::write(linked.join("other.txt"), "another worktree's change\n").unwrap();
    git(&linked, &["add", "other.txt"]);
    let status = worktree_status(path).unwrap();
    for operation in [
        Operation::Commit {
            message: "new commit".into(),
            staged: status.staged_stamp.clone(),
        },
        Operation::Amend {
            message: "amended commit".into(),
            staged: status.staged_stamp.clone(),
        },
        Operation::EditMessage {
            message: "rewritten commit".into(),
        },
    ] {
        assert!(
            coordinator
                .write(
                    path,
                    &operation,
                    &Expect {
                        head: status.head.clone()
                    }
                )
                .unwrap_err()
                .message
                .contains("destination of an unfinished merge")
        );
    }
    assert_eq!(
        f.git(&["rev-parse", "HEAD"]),
        session.review.destination.oid.as_str()
    );
    assert_eq!(
        active(coordinator.merge_state(f.path()).unwrap()).id,
        session.id
    );
}

#[test]
fn forced_duplicate_checkout_cannot_start_a_second_merge_for_the_same_destination() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let linked = f.root.parent().unwrap().join("duplicate-merge");
    let path = linked.to_str().unwrap();
    f.git(&["worktree", "add", "--force", path, "main"]);
    let review = coordinator
        .review_merge(path, &MergeSelection::Upstream)
        .unwrap();
    let session = f.start(&coordinator);

    let error = coordinator
        .merge(path, &MergeAction::Start { review })
        .unwrap_err();
    assert!(error.message.contains("destination of an unfinished merge"));
    assert_eq!(
        active(coordinator.merge_state(f.path()).unwrap()).id,
        session.id
    );
    assert_eq!(coordinator.merge_state(path).unwrap(), MergeState::Idle);
    assert!(git(&linked, &["status", "--porcelain"]).is_empty());
    assert_eq!(
        f.git(&["rev-parse", "HEAD"]),
        session.review.destination.oid.as_str()
    );
}

#[test]
fn missing_unrelated_worktree_does_not_block_an_ordinary_commit() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    let linked = f.root.parent().unwrap().join("missing-unrelated");
    f.git(&[
        "worktree",
        "add",
        "-b",
        "unrelated",
        linked.to_str().unwrap(),
    ]);
    fs::remove_dir_all(&linked).unwrap();
    f.put("other.txt", "healthy worktree edit\n");
    f.stage(&coordinator, "other.txt");
    let status = worktree_status(f.path()).unwrap();

    coordinator
        .write(
            f.path(),
            &Operation::Commit {
                message: "Commit in the healthy worktree".into(),
                staged: status.staged_stamp,
            },
            &Expect { head: status.head },
        )
        .unwrap();
    assert_eq!(f.git(&["show", "HEAD:other.txt"]), "healthy worktree edit");
    assert!(f.git(&["status", "--porcelain"]).is_empty());
}

#[test]
#[cfg(unix)]
fn start_never_adopts_an_unrelated_edit_made_during_the_merge() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    f.hook(
        "post-index-change",
        "printf 'independent external edit\\n' > other.txt\n\
         env -u GIT_INDEX_FILE git -c core.hooksPath=/dev/null add other.txt",
    );
    let review = coordinator
        .review_merge(f.path(), &MergeSelection::Upstream)
        .unwrap();
    let _ = coordinator.merge(f.path(), &MergeAction::Start { review });
    assert_eq!(
        fs::read_to_string(f.root.join("other.txt")).unwrap(),
        "independent external edit\n"
    );
    f.git(&["config", "core.hooksPath", "/dev/null"]);
    let (_, record, _) = f.record();
    let aborted = coordinator.merge(
        f.path(),
        &MergeAction::Abort {
            session: record.session.id,
        },
    );
    assert_eq!(
        fs::read_to_string(f.root.join("other.txt")).unwrap(),
        "independent external edit\n"
    );
    assert!(aborted.is_err());
}

#[test]
fn interrupted_private_abort_cannot_reopen_resolution_history() {
    let f = Fixture::new(true);
    let coordinator = f.coordinator();
    f.start(&coordinator);
    let (repo, mut record, deadline) = f.record();
    record.phase = SessionPhase::Aborting;
    record.save(&repo).unwrap();
    let txn = MergeIndexTxn::begin(&repo, deadline).unwrap();
    txn.runner()
        .git(&["update-index", "--refresh"])
        .run(deadline)
        .unwrap();
    txn.abort().run(deadline).unwrap().succeeded().unwrap();
    drop(txn);

    assert!(matches!(
        f.coordinator().merge_state(f.path()).unwrap(),
        MergeState::Attention {
            reason: MergeAttention::RecoveryRequired,
            ..
        }
    ));
    assert!(!f.git(&["ls-files", "-u"]).is_empty());
    assert!(!f.root.join(".git/MERGE_HEAD").exists());
    assert!(f.coordinator().undo_history(f.path()).is_err());
}

#[test]
fn nondefault_merge_strategy_configuration_refuses_before_mutation() {
    for (key, value) in [
        ("branch.main.mergeOptions", "--strategy=ours"),
        ("pull.twohead", "ours"),
    ] {
        let f = Fixture::new(false);
        let coordinator = f.coordinator();
        f.git(&["config", key, value]);
        let review = coordinator
            .review_merge(f.path(), &MergeSelection::Upstream)
            .unwrap();
        let before = review.destination.oid.clone();
        let error = coordinator
            .merge(f.path(), &MergeAction::Start { review })
            .unwrap_err();
        assert!(error.message.contains("default merge strategy options"));
        assert_eq!(f.git(&["rev-parse", "HEAD"]), before.as_str());
        assert!(f.git(&["status", "--porcelain"]).is_empty());
        assert!(!f.root.join(".git/MERGE_HEAD").exists());
        assert_eq!(coordinator.merge_state(f.path()).unwrap(), MergeState::Idle);
    }
}

#[test]
fn foreign_operation_and_corrupt_session_have_distinct_attention_reasons() {
    let f = Fixture::new(false);
    let coordinator = f.coordinator();
    fs::write(
        f.root.join(".git/CHERRY_PICK_HEAD"),
        f.git(&["rev-parse", "upstream"]),
    )
    .unwrap();
    assert!(matches!(
        coordinator.merge_state(f.path()).unwrap(),
        MergeState::Attention {
            reason: MergeAttention::ExternalOperation,
            session: None,
            ..
        }
    ));
    fs::remove_file(f.root.join(".git/CHERRY_PICK_HEAD")).unwrap();
    f.start(&coordinator);
    let (repo, record, _) = f.record();
    fs::write(
        directory(&repo, record.session.id).join("state.json"),
        "{corrupt",
    )
    .unwrap();
    assert!(matches!(
        coordinator.merge_state(f.path()).unwrap(),
        MergeState::Attention {
            reason: MergeAttention::RecoveryRequired,
            session: None,
            ..
        }
    ));
    assert!(coordinator.undo_history(f.path()).is_err());
    assert!(
        coordinator
            .merge(
                f.path(),
                &MergeAction::Abort {
                    session: record.session.id
                }
            )
            .is_err()
    );
    assert!(f.root.join(".git/MERGE_HEAD").exists());
}

impl Fixture {
    fn selected(&self, reference: &str) -> MergeReview {
        self.coordinator()
            .review_merge(
                self.path(),
                &MergeSelection::Branch {
                    reference: reference.into(),
                },
            )
            .unwrap()
    }
    fn behind(&self) {
        self.git(&["reset", "--hard", "upstream^"]);
        self.git(&["branch", "--unset-upstream"]);
    }
    fn prepare_fast_forward(&self) -> (Repo, Record, WriteDeadline) {
        self.behind();
        let review = self.selected("refs/heads/upstream");
        let deadline = self.coordinator().write_deadline(LocalWrite::MergeStart);
        let repo = Repo::open(self.path(), deadline.reads()).unwrap();
        for dir in [repo.git_dir.join("l1git"), base(&repo)] {
            checked_dir(&dir).unwrap();
        }
        let id = EntryId::after(None);
        checked_dir(&directory(&repo, id)).unwrap();
        let record = Record {
            version: 2,
            identity: Identity::of(&repo.git_dir).unwrap(),
            session: MergeSession {
                id,
                review,
                footprint: vec![],
                suggested_message: "Fast-forward".into(),
            },
            phase: SessionPhase::FastForwarding,
        };
        record
            .keep(
                &repo,
                deadline,
                vec![
                    record.session.review.destination.oid.clone(),
                    record.session.review.source.oid.clone(),
                ],
            )
            .unwrap();
        record.save(&repo).unwrap();
        persist(&base(&repo).join("current.json"), &id).unwrap();
        (repo, record, deadline)
    }
}

#[test]
fn explicit_local_and_remote_sources_without_tracking_finish_or_abort() {
    for remote in [false, true] {
        for conflict in [false, true] {
            let f = Fixture::new(conflict);
            f.git(&["branch", "--unset-upstream"]);
            let reference = if remote {
                "refs/remotes/origin/topic"
            } else {
                "refs/heads/upstream"
            };
            if remote {
                f.git(&["update-ref", reference, "upstream"]);
            }
            let review = f.selected(reference);
            assert_eq!(review.context, MergeContext::Branch);
            assert_eq!(review.plan, MergePlan::MergeCommit);
            let coordinator = f.coordinator();
            let report = coordinator
                .merge(f.path(), &MergeAction::Start { review })
                .unwrap();
            let session = active(report.state);
            f.git(&[
                "update-ref",
                reference,
                session.review.destination.oid.as_str(),
            ]);
            assert!(matches!(
                coordinator.merge_state(f.path()).unwrap(),
                MergeState::Active {
                    source_moved: true,
                    ..
                }
            ));
            if conflict {
                f.put("conflict.txt", "resolution\n");
                f.stage(&coordinator, "conflict.txt");
            }
            let landed = f.finish(&coordinator);
            assert!(matches!(landed.outcome, MergeOutcome::Finished { .. }));
            assert_eq!(
                f.git(&["rev-parse", "HEAD^2"]),
                session.review.source.oid.as_str()
            );
        }
        let f = Fixture::new(true);
        f.git(&["branch", "--unset-upstream"]);
        let session = active(
            f.coordinator()
                .merge(
                    f.path(),
                    &MergeAction::Start {
                        review: f.selected("refs/heads/upstream"),
                    },
                )
                .unwrap()
                .state,
        );
        f.coordinator()
            .merge(
                f.path(),
                &MergeAction::Abort {
                    session: session.id,
                },
            )
            .unwrap();
        assert_eq!(f.git(&["status", "--porcelain"]), "");
    }
}

#[test]
fn equal_contained_and_fast_forward_are_terminal_and_move_only_destination() {
    let f = Fixture::new(false);
    f.behind();
    for reference in ["refs/heads/main", "refs/heads/base"] {
        if reference.ends_with("base") {
            f.git(&["branch", "base", "HEAD"]);
        }
        let review = f.selected(reference);
        assert_eq!(review.plan, MergePlan::UpToDate);
        let report = f
            .coordinator()
            .merge(f.path(), &MergeAction::Start { review })
            .unwrap();
        assert_eq!(report.outcome, MergeOutcome::UpToDate);
        assert_eq!(report.state, MergeState::Idle);
    }
    f.git(&["update-ref", "refs/remotes/origin/topic", "upstream"]);
    let review = f.selected("refs/remotes/origin/topic");
    assert_eq!(review.plan, MergePlan::FastForward);
    let source = review.source.oid.clone();
    let report = f
        .coordinator()
        .merge(f.path(), &MergeAction::Start { review })
        .unwrap();
    assert_eq!(report.state, MergeState::Idle);
    assert_eq!(
        report.outcome,
        MergeOutcome::FastForwarded {
            commit: source.clone(),
            problem: None
        }
    );
    assert_eq!(f.git(&["rev-parse", "HEAD"]), source.as_str());
    assert_eq!(
        f.git(&["rev-parse", "refs/remotes/origin/topic"]),
        source.as_str()
    );
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert!(!f.root.join(".git/MERGE_HEAD").exists());
    assert_eq!(f.selected("refs/heads/base").plan, MergePlan::UpToDate);
}

#[test]
fn selection_rejects_aliases_expressions_tags_missing_and_unrelated_histories() {
    let f = Fixture::new(false);
    f.git(&["update-ref", "refs/remotes/origin/topic", "upstream"]);
    f.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/topic",
    ]);
    f.git(&["tag", "-a", "tagged", "upstream", "-m", "tagged"]);
    f.git(&[
        "update-ref",
        "refs/remotes/origin/tag-object",
        "refs/tags/tagged",
    ]);
    for reference in [
        "upstream",
        "refs/heads/upstream^",
        "refs/heads/*",
        "refs/heads/missing",
        "refs/remotes/origin/HEAD",
        "refs/tags/tagged",
        "refs/remotes/origin/tag-object",
    ] {
        assert!(
            f.coordinator()
                .review_merge(
                    f.path(),
                    &MergeSelection::Branch {
                        reference: reference.into()
                    }
                )
                .is_err(),
            "{reference}"
        );
    }
    let unrelated = f.git(&[
        "commit-tree",
        &f.git(&["rev-parse", "upstream^{tree}"]),
        "-m",
        "unrelated",
    ]);
    f.git(&["update-ref", "refs/heads/unrelated", &unrelated]);
    assert!(
        f.coordinator()
            .review_merge(
                f.path(),
                &MergeSelection::Branch {
                    reference: "refs/heads/unrelated".into()
                }
            )
            .unwrap_err()
            .message
            .contains("unrelated histories")
    );
}

#[test]
fn selected_review_rechecks_source_destination_context_and_plan() {
    for change in ["source", "destination", "context", "plan"] {
        let f = Fixture::new(false);
        let mut review = f.selected("refs/heads/upstream");
        match change {
            "source" => {
                f.git(&["update-ref", "refs/heads/upstream", "HEAD"]);
            }
            "destination" => {
                f.git(&["commit", "--allow-empty", "-m", "moved"]);
            }
            "context" => {
                review.context = MergeContext::Upstream {
                    tracking: MergeTracking {
                        remote: "wrong".into(),
                        merge: "refs/heads/wrong".into(),
                        fetch: vec![],
                    },
                };
            }
            "plan" => {
                review.plan = MergePlan::FastForward;
            }
            _ => unreachable!(),
        }
        assert!(
            f.coordinator()
                .merge(f.path(), &MergeAction::Start { review })
                .is_err(),
            "{change}"
        );
        assert!(!f.root.join(".git/MERGE_HEAD").exists());
    }
}

#[test]
fn fast_forward_refuses_dirty_and_ignored_or_untracked_collisions() {
    for obstacle in ["dirty", "staged", "untracked", "ignored", "case-alias"] {
        let f = Fixture::new(false);
        f.behind();
        let review = f.selected("refs/heads/upstream");
        let name = if obstacle == "case-alias" {
            "INCOMING.txt"
        } else if matches!(obstacle, "dirty" | "staged") {
            "other.txt"
        } else {
            "incoming.txt"
        };
        if obstacle == "ignored" {
            f.git(&["config", "core.excludesFile", ".git/excludes"]);
            fs::write(f.root.join(".git/excludes"), "incoming.txt\n").unwrap();
        }
        f.put(name, "preserve\n");
        if obstacle == "staged" {
            f.git(&["add", name]);
        }
        let before = f.git(&["rev-parse", "HEAD"]);
        assert!(
            f.coordinator()
                .merge(f.path(), &MergeAction::Start { review })
                .is_err(),
            "{obstacle}"
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
        assert_eq!(fs::read_to_string(f.root.join(name)).unwrap(), "preserve\n");
    }
}

#[test]
fn fast_forward_restart_before_and_after_publication_and_ambiguous_state() {
    for point in ["before", "after", "ambiguous", "different-branch", "marker"] {
        let f = Fixture::new(false);
        let (repo, record, _) = f.prepare_fast_forward();
        if point != "before" {
            f.git(&[
                "merge",
                "--ff-only",
                record.session.review.source.oid.as_str(),
            ]);
        }
        if point == "ambiguous" {
            f.put("incoming.txt", "external edit\n");
        }
        if point == "different-branch" {
            f.git(&["switch", "-c", "different"]);
        }
        if point == "marker" {
            fs::write(
                repo.git_dir.join("MERGE_AUTOSTASH"),
                record.session.review.destination.oid.as_str(),
            )
            .unwrap();
        }
        let state = f.coordinator().merge_state(f.path()).unwrap();
        let recovered = load(&repo).unwrap().unwrap();
        if matches!(point, "before" | "after") {
            assert_eq!(state, MergeState::Idle);
            assert!(matches!(recovered.phase, SessionPhase::Closed { .. }));
            let report = f
                .coordinator()
                .merge(
                    f.path(),
                    &MergeAction::Abort {
                        session: record.session.id,
                    },
                )
                .unwrap();
            assert!(if point == "after" {
                matches!(report.outcome, MergeOutcome::FastForwarded { .. })
            } else {
                matches!(report.outcome, MergeOutcome::NotStarted { .. })
            });
        } else {
            assert!(matches!(state, MergeState::Attention { .. }), "{point}");
            assert!(matches!(recovered.phase, SessionPhase::FastForwarding));
            assert!(
                f.coordinator()
                    .merge(
                        f.path(),
                        &MergeAction::Abort {
                            session: record.session.id
                        }
                    )
                    .is_err()
            );
        }
    }
}

#[test]
fn legacy_active_session_decodes_pins_without_resolving_tracking_and_writes_v2() {
    let f = Fixture::new(true);
    let session = f.start(&f.coordinator());
    let (repo, record, _) = f.record();
    let path = directory(&repo, session.id).join("state.json");
    let mut value = serde_json::to_value(record).unwrap();
    value["version"] = 1.into();
    let review = value["session"]["review"].as_object_mut().unwrap();
    let tracking = review.remove("context").unwrap()["tracking"].clone();
    review.remove("plan");
    review.insert("tracking".into(), tracking);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    f.git(&["branch", "--unset-upstream"]);
    f.git(&[
        "update-ref",
        "refs/heads/upstream",
        session.review.destination.oid.as_str(),
    ]);
    let state = f.coordinator().merge_state(f.path()).unwrap();
    assert_eq!(active(state).review, session.review);
    f.coordinator()
        .merge(
            f.path(),
            &MergeAction::Abort {
                session: session.id,
            },
        )
        .unwrap();
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(written["version"], 2);
    value["version"] = 999.into();
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(matches!(
        f.coordinator().merge_state(f.path()).unwrap(),
        MergeState::Attention {
            reason: MergeAttention::RecoveryRequired,
            ..
        }
    ));
    assert_eq!(
        fs::read(&path).unwrap(),
        serde_json::to_vec(&value).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn fast_forward_reports_advancement_when_post_merge_hook_fails() {
    let f = Fixture::new(false);
    f.behind();
    f.hook("post-merge", "echo failed >&2; exit 1");
    let review = f.selected("refs/heads/upstream");
    let target = review.source.oid.clone();
    let report = f
        .coordinator()
        .merge(f.path(), &MergeAction::Start { review })
        .unwrap();
    assert!(matches!(
        report.outcome,
        MergeOutcome::FastForwarded {
            problem: Some(_),
            ..
        }
    ));
    assert_eq!(f.git(&["rev-parse", "HEAD"]), target.as_str());
    assert_eq!(report.state, MergeState::Idle);
}

#[cfg(unix)]
#[test]
fn fast_forward_timeout_after_publication_reports_confirmed_advancement() {
    let f = Fixture::new(false);
    f.behind();
    f.hook("post-merge", "sleep 20");
    let review = f.selected("refs/heads/upstream");
    let target = review.source.oid.clone();
    let coordinator = f
        .coordinator()
        .cap_writes(std::time::Duration::from_secs(3));
    let report = coordinator
        .merge(f.path(), &MergeAction::Start { review })
        .unwrap();
    assert!(matches!(
        report.outcome,
        MergeOutcome::FastForwarded {
            problem: Some(_),
            ..
        }
    ));
    assert_eq!(f.git(&["rev-parse", "HEAD"]), target.as_str());
    assert_eq!(coordinator.merge_state(f.path()).unwrap(), MergeState::Idle);
}

#[test]
fn record_decoder_rejects_unknown_fields_and_mismatched_versions_without_rewriting() {
    let f = Fixture::new(false);
    let session = f.start(&f.coordinator());
    let (repo, record, _) = f.record();
    let path = directory(&repo, session.id).join("state.json");
    for change in ["extra", "root", "id", "legacy-with-new-review", "future"] {
        let mut value = serde_json::to_value(&record).unwrap();
        match change {
            "extra" => value["session"]["review"]["extra"] = true.into(),
            "root" => value["session"]["review"]["root"] = "/different".into(),
            "id" => value["session"]["id"] = EntryId::after(Some(session.id)).to_string().into(),
            "legacy-with-new-review" => value["version"] = 1.into(),
            "phase" => value["phase"] = serde_json::json!({"kind":"fastForwarding"}),
            "future" => value["version"] = 3.into(),
            _ => unreachable!(),
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(
            matches!(
                f.coordinator().merge_state(f.path()).unwrap(),
                MergeState::Attention {
                    reason: MergeAttention::RecoveryRequired,
                    ..
                }
            ),
            "{change}"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}
