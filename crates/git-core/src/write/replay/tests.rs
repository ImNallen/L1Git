use super::*;

#[test]
fn cutting_the_conflicts_block_keeps_every_real_line() {
    for (merge_msg, comment, kept) in [
        (
            "theirs\n\nbody\n# real line\n\n# Conflicts:\n#\tf.txt\n#\tg.txt\n",
            "#",
            "theirs\n\nbody\n# real line\n",
        ),
        ("theirs\n\n; Conflicts:\n;\tf.txt\n", ";", "theirs\n"),
        ("theirs\n\n// Conflicts:\n//\tf.txt\n", "//", "theirs\n"),
        (
            "theirs\n\n# Conflicts:\n#\told.txt\n\n# Conflicts:\n#\tf.txt\n",
            "#",
            "theirs\n\n# Conflicts:\n#\told.txt\n",
        ),
        (
            "theirs\n\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\n# Everything below it will be ignored.\n#\n# Conflicts:\n#\tf.txt\n",
            "#",
            "theirs\n",
        ),
    ] {
        assert_eq!(cut_conflicts_block(merge_msg, comment), kept, "{merge_msg}");
    }
}

#[test]
fn cutting_changes_nothing_without_a_trailing_block() {
    for (merge_msg, comment) in [
        ("theirs\n\nbody\n", "#"),
        ("theirs\n\n# Conflicts:\n", "#"),
        ("theirs\n\n# Conflicts:\n#\tf.txt\nmore body\n", "#"),
        ("theirs\n\n# Conflicts:\n#\tf.txt\n", ";"),
        ("# Conflicts:", "#"),
        ("", "#"),
    ] {
        assert_eq!(cut_conflicts_block(merge_msg, comment), merge_msg);
    }
}

/// F1, by constructing the state: no hook runs between recording the entry and
/// starting Git, so this records it and stops there.
#[cfg(unix)]
mod crash {
    use super::*;
    use crate::{Coordinator, Limits, MergeState, git::LocalWrite};
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> std::process::Output {
        let mut command = Command::new("git");
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        command.arg("-C").arg(root).args(args).output().unwrap()
    }

    #[test]
    fn a_pending_entry_recorded_before_git_ran_drops_and_finish_still_works() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        for args in [
            &["init", "--quiet", "--initial-branch=main"][..],
            &["config", "user.name", "Ada"],
            &["config", "user.email", "ada@example.test"],
            &["config", "core.hooksPath", "/dev/null"],
        ] {
            assert!(git(&root, args).status.success());
        }
        fs::write(root.join("f.txt"), "base\n").unwrap();
        for args in [
            &["add", "."][..],
            &["commit", "-qm", "base"],
            &["switch", "-qc", "topic"],
        ] {
            assert!(git(&root, args).status.success());
        }
        fs::write(root.join("f.txt"), "theirs\n").unwrap();
        for args in [&["commit", "-qam", "theirs"][..], &["switch", "-q", "main"]] {
            assert!(git(&root, args).status.success());
        }
        fs::write(root.join("f.txt"), "ours\n").unwrap();
        assert!(git(&root, &["commit", "-qam", "ours"]).status.success());
        assert!(!git(&root, &["cherry-pick", "topic"]).status.success());
        fs::write(root.join("f.txt"), "resolved\n").unwrap();
        assert!(git(&root, &["add", "."]).status.success());

        let path = root.to_str().unwrap();
        let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));
        let MergeState::Replay { progress } = coordinator.merge_state(path).unwrap() else {
            panic!("a replay should be in flight");
        };
        let operation = Operation::FinishReplay {
            of: progress.of(),
            staged: progress.staged.clone(),
            tree: progress.tree.clone().unwrap(),
            message: "Finished\n".to_owned(),
        };
        let head = progress.destination.clone();
        coordinator
            .locked(path, LocalWrite::ReplayFinish, |repo, store, log, _| {
                let (_, _, recorded) = store.record_with(&repo, &log, &operation, |_| {
                    Ok(ReplayChange::Pending {
                        before: head.clone(),
                        tree: progress.tree.clone(),
                    })
                })?;
                recorded.durable()?;
                recorded.stay_pending();
                Ok(())
            })
            .unwrap();

        assert_eq!(
            coordinator.merge_state(path).unwrap(),
            MergeState::Replay {
                progress: progress.clone()
            }
        );
        assert_eq!(coordinator.undo_history(path).unwrap().undo, None);
        let finished = coordinator
            .write(path, &operation, &Expect { head: head.clone() })
            .unwrap();
        assert_eq!(
            coordinator
                .undo_history(path)
                .unwrap()
                .undo
                .map(|entry| entry.id),
            Some(finished.id)
        );
    }
}
