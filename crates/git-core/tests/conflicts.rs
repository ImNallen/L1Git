use l1_git_core::{
    Applied, ConflictFile, ConflictKeep, ConflictSide, ConflictSummary, ConflictUnsupported,
    Coordinator, ErrorKind, Expect, InProgress, Limits, MergeAction, MergeOutcome, MergeSelection,
    MergeState, Mode, Operation, OperationProbe, ReplayKind, RepositoryError, Request, Response,
    StaleReason, WholeFileDisk, WholeFileShape, run, worktree_status,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

const LINES: [&str; 12] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", ""];

fn edited(word: &str) -> Vec<u8> {
    let mut lines = LINES;
    lines[1] = word;
    lines[9] = word;
    lines.join("\n").into_bytes()
}

const PATH_CHANGED: ErrorKind = ErrorKind::StaleView {
    reason: StaleReason::PathChanged,
};

fn terminal(path: &Path, args: &[&str]) -> Output {
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
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
    coordinator: Coordinator,
}

impl Repo {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));
        let repo = Self {
            directory,
            root,
            coordinator,
        };
        repo.git(&["init", "--quiet", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
            ("core.autocrlf", "false"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
        ] {
            repo.git(&["config", key, value]);
        }
        repo.put("keep.txt", b"keep\n");
        repo.put("f.txt", LINES.join("\n").as_bytes());
        repo.put("bin.dat", b"\0base");
        repo.git(&["add", "."]);
        repo.git(&["commit", "--quiet", "-m", "base"]);
        repo
    }

    fn diverged(ours: impl Fn(&Self), theirs: impl Fn(&Self)) -> Self {
        let repo = Self::new();
        repo.git(&["switch", "--quiet", "-c", "topic"]);
        theirs(&repo);
        repo.commit("theirs");
        repo.git(&["switch", "--quiet", "main"]);
        ours(&repo);
        repo.commit("ours");
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        let output = terminal(&self.root, args);
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn fails(&self, args: &[&str]) {
        assert!(!terminal(&self.root, args).status.success(), "{args:?}");
    }

    fn commit(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "--quiet", "-m", message]);
    }

    fn put(&self, path: &str, bytes: &[u8]) {
        fs::write(self.root.join(path), bytes).unwrap();
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn start_merge(&self) {
        let review = self
            .coordinator
            .review_merge(
                self.path(),
                &MergeSelection::Branch {
                    reference: "refs/heads/topic".into(),
                },
            )
            .unwrap();
        let report = self
            .coordinator
            .merge(self.path(), &MergeAction::Start { review })
            .unwrap();
        assert_eq!(report.outcome, MergeOutcome::Started { problem: None });
    }

    fn summary(&self) -> Vec<ConflictSummary> {
        match run(
            &self.coordinator,
            Request::ConflictSummary {
                path: self.path().into(),
            },
        )
        .unwrap()
        {
            Response::ConflictSummary(summary) => summary,
            other => panic!("{other:?}"),
        }
    }

    fn summary_of(&self, path: &str) -> ConflictSummary {
        self.summary()
            .into_iter()
            .find(|summary| summary_path(summary) == path)
            .unwrap_or_else(|| panic!("{path} is not summarized"))
    }

    fn probe(&self) -> OperationProbe {
        match run(
            &self.coordinator,
            Request::OperationProbe {
                path: self.path().into(),
            },
        )
        .unwrap()
        {
            Response::OperationProbe(probe) => probe,
            other => panic!("{other:?}"),
        }
    }

    fn conflict_file(&self, file: &str) -> ConflictFile {
        match run(
            &self.coordinator,
            Request::ConflictFile {
                path: self.path().into(),
                file: file.into(),
            },
        )
        .unwrap()
        {
            Response::ConflictFile(file) => file,
            other => panic!("{other:?}"),
        }
    }

    fn resolve(&self, path: &str, keep: ConflictKeep) -> Result<Applied, RepositoryError> {
        let ConflictSummary::WholeFile { version, .. } = self.summary_of(path) else {
            panic!("{path} is not a whole-file conflict");
        };
        self.coordinator.write(
            self.path(),
            &Operation::ResolveWhole {
                path: path.into(),
                version,
                keep,
            },
            &Expect {
                head: worktree_status(self.path()).unwrap().head,
            },
        )
    }

    fn disk_label(&self, path: &str) -> WholeFileDisk {
        match self.summary_of(path) {
            ConflictSummary::WholeFile { disk, .. } => disk,
            other => panic!("{other:?}"),
        }
    }

    fn rows(&self, path: &str) -> String {
        self.git(&["ls-files", "--stage", "--", path])
    }

    fn disk(&self, path: &str) -> Disk {
        let file = self.root.join(path);
        match fs::symlink_metadata(&file) {
            Err(_) => Disk::Absent,
            Ok(metadata) if metadata.is_symlink() => {
                Disk::Link(fs::read_link(&file).unwrap().to_string_lossy().into_owned())
            }
            Ok(_) => Disk::File(fs::read(&file).unwrap()),
        }
    }

    fn blob(&self, spec: &str) -> String {
        self.git(&["rev-parse", spec]).trim().to_owned()
    }

    fn unresolved(&self) -> Vec<String> {
        match self.coordinator.merge_state(self.path()).unwrap() {
            MergeState::Active { unresolved, .. } => unresolved,
            MergeState::Replay { progress } => progress.unresolved,
            other => panic!("{other:?}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Disk {
    Absent,
    File(Vec<u8>),
    Link(String),
}

fn summary_path(summary: &ConflictSummary) -> &str {
    match summary {
        ConflictSummary::Text { path, .. }
        | ConflictSummary::WholeFile { path, .. }
        | ConflictSummary::External { path, .. } => path,
    }
}

const fn file(size: u64) -> Option<ConflictSide> {
    Some(ConflictSide {
        mode: Mode::File,
        size,
    })
}

struct Case {
    name: &'static str,
    ours: fn(&Repo),
    theirs: fn(&Repo),
    path: &'static str,
    shape: WholeFileShape,
    current: Option<ConflictSide>,
    incoming: Option<ConflictSide>,
}

fn cases() -> Vec<Case> {
    let mut cases = vec![
        Case {
            name: "deleted by them",
            ours: |repo| repo.put("f.txt", b"ours\n"),
            theirs: |repo| fs::remove_file(repo.root.join("f.txt")).unwrap(),
            path: "f.txt",
            shape: WholeFileShape::DeletedByThem,
            current: file(5),
            incoming: None,
        },
        Case {
            name: "deleted by us",
            ours: |repo| fs::remove_file(repo.root.join("f.txt")).unwrap(),
            theirs: |repo| repo.put("f.txt", b"theirs\n"),
            path: "f.txt",
            shape: WholeFileShape::DeletedByUs,
            current: None,
            incoming: file(7),
        },
        Case {
            name: "binary",
            ours: |repo| repo.put("bin.dat", b"\0ours"),
            theirs: |repo| repo.put("bin.dat", b"\0theirs"),
            path: "bin.dat",
            shape: WholeFileShape::Binary,
            current: file(5),
            incoming: file(7),
        },
    ];
    if cfg!(unix) {
        cases.push(Case {
            name: "symlink",
            ours: |repo| link(repo, "ours-target"),
            theirs: |repo| link(repo, "theirs-target"),
            path: "link",
            shape: WholeFileShape::Symlink,
            current: Some(ConflictSide {
                mode: Mode::Symlink,
                size: 11,
            }),
            incoming: Some(ConflictSide {
                mode: Mode::Symlink,
                size: 13,
            }),
        });
    }
    cases
}

#[cfg(unix)]
fn link(repo: &Repo, target: &str) {
    std::os::unix::fs::symlink(target, repo.root.join("link")).unwrap();
}

#[cfg(not(unix))]
fn link(_repo: &Repo, _target: &str) {
    unreachable!("symlink cases run on Unix only")
}

fn kept(repo: &Repo, case: &Case, keep: ConflictKeep) -> (String, Disk) {
    let (side, branch) = match keep {
        ConflictKeep::Current => (case.current, "main"),
        ConflictKeep::Incoming => (case.incoming, "topic"),
    };
    let Some(side) = side else {
        return (String::new(), Disk::Absent);
    };
    let spec = format!("{branch}:{}", case.path);
    let row = format!(
        "{} {} 0\t{}\n",
        serde_json::to_value(side.mode).unwrap().as_str().unwrap(),
        repo.blob(&spec),
        case.path
    );
    let bytes = repo.git(&["cat-file", "blob", &spec]).into_bytes();
    let disk = if side.mode == Mode::Symlink {
        Disk::Link(String::from_utf8(bytes).unwrap())
    } else {
        Disk::File(bytes)
    };
    (row, disk)
}

#[test]
fn whole_file_resolutions_stage_the_kept_side_and_undo_to_the_exact_conflict() {
    for case in cases() {
        for keep in [ConflictKeep::Current, ConflictKeep::Incoming] {
            let label = format!("{} keeping {keep:?}", case.name);
            let repo = Repo::diverged(case.ours, case.theirs);
            repo.start_merge();
            let ConflictSummary::WholeFile {
                shape,
                current,
                incoming,
                ..
            } = repo.summary_of(case.path)
            else {
                panic!("{label}: {:?}", repo.summary_of(case.path));
            };
            assert_eq!(
                (shape, current, incoming),
                (case.shape, case.current, case.incoming),
                "{label}"
            );
            let (conflict, before) = (repo.rows(case.path), repo.disk(case.path));
            let applied = repo.resolve(case.path, keep).unwrap();
            let (row, disk) = kept(&repo, &case, keep);
            let resolved = (repo.rows(case.path), repo.disk(case.path));
            assert_eq!(resolved, (row.clone(), disk.clone()), "{label}");
            assert!(
                !repo.unresolved().contains(&case.path.to_owned()),
                "{label}"
            );
            assert!(
                repo.summary()
                    .iter()
                    .all(|summary| summary_path(summary) != case.path),
                "{label}"
            );

            repo.coordinator.undo(repo.path(), applied.id).unwrap();
            assert_eq!(
                (repo.rows(case.path), repo.disk(case.path)),
                (conflict.clone(), before.clone()),
                "{label} undone"
            );
            assert!(repo.unresolved().contains(&case.path.to_owned()), "{label}");
            assert!(
                matches!(
                    repo.summary_of(case.path),
                    ConflictSummary::WholeFile { .. }
                ),
                "{label}"
            );

            repo.coordinator.redo(repo.path(), applied.id).unwrap();
            assert_eq!(
                (repo.rows(case.path), repo.disk(case.path)),
                (row, disk),
                "{label} redone"
            );
            repo.coordinator.undo(repo.path(), applied.id).unwrap();
            assert_eq!(
                (repo.rows(case.path), repo.disk(case.path)),
                (conflict, before),
                "{label} undone again"
            );
        }
    }
}

#[test]
fn a_resolved_merge_finishes_with_the_kept_sides() {
    let repo = Repo::diverged(
        |repo| {
            repo.put("f.txt", b"ours\n");
            repo.put("bin.dat", b"\0ours");
        },
        |repo| {
            fs::remove_file(repo.root.join("f.txt")).unwrap();
            repo.put("bin.dat", b"\0theirs");
        },
    );
    repo.start_merge();
    repo.resolve("f.txt", ConflictKeep::Incoming).unwrap();
    repo.resolve("bin.dat", ConflictKeep::Incoming).unwrap();
    let MergeState::Active {
        session,
        unresolved,
        staged,
        tree: Some(tree),
        ..
    } = repo.coordinator.merge_state(repo.path()).unwrap()
    else {
        panic!("the merge should be ready");
    };
    assert_eq!(unresolved, Vec::<String>::new());
    assert_eq!(
        session.conflicted,
        Some(vec!["bin.dat".to_owned(), "f.txt".to_owned()])
    );
    let report = repo
        .coordinator
        .merge(
            repo.path(),
            &MergeAction::Finish {
                session: session.id,
                staged,
                tree,
                message: "Merge topic".into(),
            },
        )
        .unwrap();
    assert!(matches!(
        report.outcome,
        MergeOutcome::Finished { problem: None, .. }
    ));
    assert_eq!(
        repo.git(&["ls-tree", "--name-only", "HEAD"]),
        "bin.dat\nkeep.txt\n"
    );
    assert_eq!(repo.git(&["cat-file", "blob", "HEAD:bin.dat"]), "\0theirs");
}

#[test]
fn a_whole_file_resolution_works_in_a_terminal_cherry_pick() {
    let repo = Repo::new();
    repo.git(&["switch", "--quiet", "-c", "topic"]);
    fs::remove_file(repo.root.join("f.txt")).unwrap();
    repo.commit("removes f");
    let removes = repo.blob("HEAD");
    repo.git(&["switch", "--quiet", "main"]);
    repo.put("f.txt", b"ours\n");
    repo.commit("changes f");
    repo.fails(&["cherry-pick", &removes]);
    assert_eq!(
        repo.probe(),
        OperationProbe::Replay {
            replay: ReplayKind::CherryPick
        }
    );
    let MergeState::Replay { progress } = repo.coordinator.merge_state(repo.path()).unwrap() else {
        panic!("the pick should be in flight");
    };
    assert_eq!(progress.conflicted, ["f.txt"]);
    let conflict = repo.rows("f.txt");
    let applied = repo.resolve("f.txt", ConflictKeep::Incoming).unwrap();
    assert_eq!(
        (repo.rows("f.txt"), repo.disk("f.txt")),
        (String::new(), Disk::Absent)
    );
    let MergeState::Replay { progress } = repo.coordinator.merge_state(repo.path()).unwrap() else {
        panic!("the pick should be in flight");
    };
    assert_eq!(progress.conflicted, ["f.txt"]);
    assert_eq!(progress.unresolved, Vec::<String>::new());
    repo.coordinator.undo(repo.path(), applied.id).unwrap();
    assert_eq!(
        (repo.rows("f.txt"), repo.disk("f.txt")),
        (conflict, Disk::File(b"ours\n".to_vec()))
    );
}

#[test]
fn a_changed_conflict_or_a_path_outside_the_merge_is_refused() {
    let repo = Repo::diverged(
        |repo| repo.put("f.txt", b"ours\n"),
        |repo| fs::remove_file(repo.root.join("f.txt")).unwrap(),
    );
    repo.start_merge();
    let ConflictSummary::WholeFile { version, .. } = repo.summary_of("f.txt") else {
        panic!("f.txt is deleted by them");
    };
    let conflict = repo.rows("f.txt");
    repo.put("f.txt", b"edited after the summary\n");
    let expect = Expect {
        head: worktree_status(repo.path()).unwrap().head,
    };
    let resolve = |path: &str| {
        repo.coordinator.write(
            repo.path(),
            &Operation::ResolveWhole {
                path: path.into(),
                version: version.clone(),
                keep: ConflictKeep::Current,
            },
            &expect,
        )
    };
    assert_eq!(resolve("f.txt").unwrap_err().kind, PATH_CHANGED);
    assert_eq!(resolve("keep.txt").unwrap_err().kind, ErrorKind::Conflict);
    assert_eq!(
        (repo.rows("f.txt"), repo.disk("f.txt")),
        (conflict, Disk::File(b"edited after the summary\n".to_vec()))
    );
    assert_eq!(
        repo.coordinator.undo_history(repo.path()).unwrap().undo,
        None
    );
}

#[test]
fn keeping_a_file_whose_folder_is_gone_is_refused_and_deleting_it_stays_undoable() {
    let repo = Repo::new();
    fs::create_dir(repo.root.join("sub")).unwrap();
    repo.put("sub/f.txt", LINES.join("\n").as_bytes());
    repo.commit("nested");
    repo.git(&["switch", "--quiet", "-c", "topic"]);
    fs::remove_dir_all(repo.root.join("sub")).unwrap();
    repo.commit("theirs");
    repo.git(&["switch", "--quiet", "main"]);
    repo.put("sub/f.txt", &edited("ours"));
    repo.commit("ours");
    repo.start_merge();
    fs::remove_dir_all(repo.root.join("sub")).unwrap();
    let conflict = repo.rows("sub/f.txt");

    let refused = repo
        .resolve("sub/f.txt", ConflictKeep::Current)
        .unwrap_err();
    assert_eq!(
        refused.kind,
        ErrorKind::UnsupportedPath,
        "{}",
        refused.message
    );
    assert_eq!(
        (repo.rows("sub/f.txt"), repo.disk("sub/f.txt")),
        (conflict.clone(), Disk::Absent),
        "a refused resolution changes nothing"
    );
    assert_eq!(
        repo.coordinator.undo_history(repo.path()).unwrap().undo,
        None
    );

    let applied = repo.resolve("sub/f.txt", ConflictKeep::Incoming).unwrap();
    assert_eq!(repo.rows("sub/f.txt"), "", "the deletion is staged");
    repo.coordinator.undo(repo.path(), applied.id).unwrap();
    assert_eq!(
        (repo.rows("sub/f.txt"), repo.disk("sub/f.txt")),
        (conflict, Disk::Absent),
        "undo restores the conflict"
    );
}

#[test]
fn a_path_whose_folder_became_a_file_is_external_and_the_rest_still_summarize() {
    let repo = Repo::new();
    fs::create_dir(repo.root.join("d")).unwrap();
    repo.put("d/f.txt", LINES.join("\n").as_bytes());
    repo.commit("nested");
    repo.git(&["switch", "--quiet", "-c", "topic"]);
    repo.put("d/f.txt", &edited("theirs"));
    repo.put("f.txt", &edited("theirs"));
    repo.commit("theirs");
    repo.git(&["switch", "--quiet", "main"]);
    fs::remove_dir_all(repo.root.join("d")).unwrap();
    repo.put("d", b"a file where the folder was\n");
    repo.put("f.txt", &edited("ours"));
    repo.commit("ours");
    repo.start_merge();
    fs::remove_dir_all(repo.root.join("d")).ok();
    fs::remove_file(repo.root.join("d")).ok();
    fs::rename(repo.root.join("d~HEAD"), repo.root.join("d")).unwrap();

    let summary = repo.summary();
    assert!(
        summary.iter().any(|entry| matches!(
            entry,
            ConflictSummary::External { path, reason: ConflictUnsupported::Structural } if path == "d/f.txt"
        )),
        "{summary:?}"
    );
    assert!(
        summary
            .iter()
            .any(|entry| matches!(entry, ConflictSummary::Text { path, .. } if path == "f.txt")),
        "{summary:?}"
    );
}

#[test]
fn the_summary_labels_text_whole_file_and_external_conflicts() {
    let repo = Repo::diverged(
        |repo| {
            repo.put("f.txt", &edited("OURS"));
            repo.put("bin.dat", b"\0ours");
            repo.put("added.txt", b"ours\n");
        },
        |repo| {
            repo.put("f.txt", &edited("THEIRS"));
            repo.put("bin.dat", b"\0theirs");
            repo.put("added.txt", b"theirs\n");
        },
    );
    repo.fails(&["merge", "--quiet", "topic"]);
    let summary = repo.summary();
    assert_eq!(
        summary.iter().map(summary_path).collect::<Vec<_>>(),
        ["added.txt", "bin.dat", "f.txt"]
    );
    assert_eq!(
        repo.summary_of("f.txt"),
        ConflictSummary::Text {
            path: "f.txt".into(),
            conflicts: 2,
        }
    );
    assert!(matches!(
        repo.conflict_file("f.txt"),
        ConflictFile::Editable { .. }
    ));
    assert!(matches!(
        repo.summary_of("bin.dat"),
        ConflictSummary::WholeFile {
            shape: WholeFileShape::Binary,
            ..
        }
    ));
    assert!(matches!(
        repo.conflict_file("bin.dat"),
        ConflictFile::External {
            reason: ConflictUnsupported::Binary,
            ..
        }
    ));
    assert_eq!(
        repo.summary_of("added.txt"),
        ConflictSummary::External {
            path: "added.txt".into(),
            reason: ConflictUnsupported::Structural,
        }
    );
    repo.put(
        "f.txt",
        b"one\nOURS\nthree\n<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> topic\nseven\n",
    );
    assert_eq!(
        repo.summary_of("f.txt"),
        ConflictSummary::Text {
            path: "f.txt".into(),
            conflicts: 1,
        }
    );
    repo.put("f.txt", b"one\r\ntwo\n");
    assert_eq!(
        repo.summary_of("f.txt"),
        ConflictSummary::External {
            path: "f.txt".into(),
            reason: ConflictUnsupported::Encoding,
        }
    );
    assert!(matches!(
        repo.conflict_file("f.txt"),
        ConflictFile::External {
            reason: ConflictUnsupported::Encoding,
            ..
        }
    ));
}

#[test]
fn the_probe_names_each_operation_without_writing() {
    let repo = Repo::new();
    assert_eq!(repo.probe(), OperationProbe::Idle);

    let merging = Repo::diverged(
        |repo| repo.put("f.txt", b"ours\n"),
        |repo| repo.put("f.txt", b"theirs\n"),
    );
    merging.fails(&["merge", "--quiet", "topic"]);
    let index = fs::read(merging.root.join(".git/index")).unwrap();
    assert_eq!(
        merging.probe(),
        OperationProbe::External {
            operations: vec![InProgress::Merge]
        }
    );
    assert_eq!(fs::read(merging.root.join(".git/index")).unwrap(), index);
    assert!(!merging.root.join(".git/l1git").exists());
    assert!(!merging.directory.path().join("undo").exists());

    let managed = Repo::diverged(
        |repo| repo.put("f.txt", b"ours\n"),
        |repo| repo.put("f.txt", b"theirs\n"),
    );
    managed.start_merge();
    assert_eq!(managed.probe(), OperationProbe::Merge { attention: false });
    let MergeState::Active { session, .. } =
        managed.coordinator.merge_state(managed.path()).unwrap()
    else {
        panic!("the merge should be active");
    };
    assert_eq!(session.conflicted, Some(vec!["f.txt".to_owned()]));
    managed.git(&["merge", "--abort"]);
    assert_eq!(managed.probe(), OperationProbe::Merge { attention: true });

    let rebasing = Repo::diverged(
        |repo| repo.put("f.txt", b"ours\n"),
        |repo| repo.put("f.txt", b"theirs\n"),
    );
    rebasing.fails(&["rebase", "topic"]);
    assert_eq!(
        rebasing.probe(),
        OperationProbe::External {
            operations: vec![InProgress::Rebase]
        }
    );
}

#[test]
fn the_summary_says_which_side_the_file_on_disk_matches() {
    let deleted_by_them = Repo::diverged(
        |repo| repo.put("f.txt", b"ours\n"),
        |repo| fs::remove_file(repo.root.join("f.txt")).unwrap(),
    );
    deleted_by_them.fails(&["merge", "--quiet", "topic"]);
    assert_eq!(
        deleted_by_them.disk_label("f.txt"),
        WholeFileDisk::MatchesCurrent
    );
    deleted_by_them.put("f.txt", b"hand edit\n");
    assert_eq!(deleted_by_them.disk_label("f.txt"), WholeFileDisk::Edited);
    fs::remove_file(deleted_by_them.root.join("f.txt")).unwrap();
    assert_eq!(
        deleted_by_them.disk_label("f.txt"),
        WholeFileDisk::MatchesIncoming
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        deleted_by_them.put("f.txt", b"ours\n");
        assert_eq!(
            deleted_by_them.disk_label("f.txt"),
            WholeFileDisk::MatchesCurrent
        );
        fs::set_permissions(
            deleted_by_them.root.join("f.txt"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert_eq!(
            deleted_by_them.disk_label("f.txt"),
            WholeFileDisk::Edited,
            "the executable bit is part of what Git would stage"
        );
    }

    let deleted_by_us = Repo::diverged(
        |repo| fs::remove_file(repo.root.join("f.txt")).unwrap(),
        |repo| repo.put("f.txt", b"theirs\n"),
    );
    deleted_by_us.fails(&["merge", "--quiet", "topic"]);
    assert_eq!(
        deleted_by_us.disk_label("f.txt"),
        WholeFileDisk::MatchesIncoming
    );
    fs::remove_file(deleted_by_us.root.join("f.txt")).unwrap();
    assert_eq!(
        deleted_by_us.disk_label("f.txt"),
        WholeFileDisk::MatchesCurrent
    );
    deleted_by_us.put("f.txt", b"recreated\n");
    assert_eq!(deleted_by_us.disk_label("f.txt"), WholeFileDisk::Edited);

    let binary = Repo::diverged(
        |repo| repo.put("bin.dat", b"\0ours"),
        |repo| repo.put("bin.dat", b"\0theirs"),
    );
    binary.fails(&["merge", "--quiet", "topic"]);
    assert_eq!(binary.disk_label("bin.dat"), WholeFileDisk::MatchesCurrent);
    binary.git(&["checkout", "--theirs", "--", "bin.dat"]);
    assert_eq!(binary.disk_label("bin.dat"), WholeFileDisk::MatchesIncoming);
    fs::remove_file(binary.root.join("bin.dat")).unwrap();
    assert_eq!(binary.disk_label("bin.dat"), WholeFileDisk::Missing);
    binary.put("bin.dat", b"\0edited");
    let ConflictSummary::WholeFile { version, .. } = binary.summary_of("bin.dat") else {
        panic!("bin.dat is binary");
    };
    binary.put("bin.dat", b"\0theirs");
    assert_eq!(binary.disk_label("bin.dat"), WholeFileDisk::MatchesIncoming);
    let stale = binary.coordinator.write(
        binary.path(),
        &Operation::ResolveWhole {
            path: "bin.dat".into(),
            version,
            keep: ConflictKeep::Incoming,
        },
        &Expect {
            head: worktree_status(binary.path()).unwrap().head,
        },
    );
    assert_eq!(stale.unwrap_err().kind, PATH_CHANGED);
}

#[test]
fn the_disk_comparison_follows_line_ending_attributes() {
    let repo = Repo::diverged(
        |repo| {
            repo.put(".gitattributes", b"*.txt text eol=crlf\n");
            repo.put("f.txt", b"ours\n");
        },
        |repo| fs::remove_file(repo.root.join("f.txt")).unwrap(),
    );
    repo.fails(&["merge", "--quiet", "topic"]);
    repo.put("f.txt", b"ours\r\n");
    assert_eq!(repo.disk_label("f.txt"), WholeFileDisk::MatchesCurrent);
    repo.put("f.txt", b"other\r\n");
    assert_eq!(repo.disk_label("f.txt"), WholeFileDisk::Edited);
}
