use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, Head, Limits, Oid, Operation, RepositoryError,
    StaleReason, TagTip,
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

const TAG_CHANGED: ErrorKind = ErrorKind::StaleView {
    reason: StaleReason::TagChanged,
};

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
        .stdin(Stdio::null())
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

struct Repo {
    _directory: TempDir,
    root: PathBuf,
    coordinator: Coordinator,
}

impl Repo {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--quiet", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("tag.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            git(&root, &["config", key, value]);
        }
        let coordinator = Coordinator::new(Limits::default(), directory.path().join("undo"));
        let repo = Self {
            _directory: directory,
            root,
            coordinator,
        };
        repo.git(&["commit", "--quiet", "--allow-empty", "-m", "base"]);
        repo.git(&["commit", "--quiet", "--allow-empty", "-m", "second"]);
        repo
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn oid(&self, revision: &str) -> Oid {
        Oid::try_from(self.git(&["rev-parse", revision])).unwrap()
    }

    fn write(&self, operation: Operation) -> Result<Applied, RepositoryError> {
        let head = Head::Attached {
            reference: "refs/heads/main".to_owned(),
            oid: self.oid("HEAD").as_str().to_owned(),
        };
        self.coordinator
            .write(self.path(), &operation, &Expect { head })
    }

    fn create(
        &self,
        name: &str,
        at: &str,
        message: Option<&str>,
    ) -> Result<Applied, RepositoryError> {
        self.write(Operation::CreateTag {
            name: name.to_owned(),
            at: self.oid(at),
            message: message.map(str::to_owned),
        })
    }

    fn tip(&self, name: &str) -> TagTip {
        let reference = format!("refs/tags/{name}");
        TagTip {
            oid: self.oid(&reference),
            reference: reference.try_into().unwrap(),
        }
    }

    fn delete(&self, tip: TagTip) -> Result<Applied, RepositoryError> {
        self.write(Operation::DeleteTag { tag: tip })
    }

    fn state(&self) -> String {
        self.git(&["for-each-ref", "--format=%(refname) %(objectname)"])
    }

    fn prune(&self) {
        self.git(&["reflog", "expire", "--expire=now", "--all"]);
        self.git(&["gc", "--quiet", "--prune=now"]);
    }

    fn no_entry(&self) {
        let history = self.coordinator.undo_history(self.path()).unwrap();
        assert_eq!(history.undo, None, "no undo entry");
    }

    fn round_trip(&self, before: &str, applied: &Applied) {
        let after = self.state();
        self.prune();
        self.coordinator.undo(self.path(), applied.id).unwrap();
        assert_eq!(self.state(), before, "undo");
        self.prune();
        self.coordinator.redo(self.path(), applied.id).unwrap();
        assert_eq!(self.state(), after, "redo");
        self.git(&["fsck", "--no-progress", "--connectivity-only"]);
    }

    fn dangling_commit(&self) -> String {
        let tree = self.git(&["rev-parse", "HEAD^{tree}"]);
        self.git(&["commit-tree", &tree, "-p", "HEAD", "-m", "only tagged"])
    }
}

#[test]
fn creates_a_lightweight_tag_and_undoes_and_redoes_it_after_gc() {
    let repo = Repo::new();
    let before = repo.state();
    let applied = repo.create("v0.2.0", "HEAD~1", None).unwrap();
    assert_eq!(repo.git(&["cat-file", "-t", "v0.2.0"]), "commit");
    assert_eq!(repo.oid("refs/tags/v0.2.0"), repo.oid("HEAD~1"));
    repo.round_trip(&before, &applied);
}

#[test]
fn creates_an_annotated_tag_and_redo_brings_back_the_same_tag_object() {
    let repo = Repo::new();
    let at = repo.dangling_commit();
    let before = repo.state();
    let applied = repo
        .create("v0.3.0", &at, Some("Release 0.3.0\n\nNotes.\n"))
        .unwrap();
    assert_eq!(repo.git(&["cat-file", "-t", "v0.3.0"]), "tag");
    assert_eq!(
        repo.git(&["tag", "-l", "--format=%(contents)%(taggername)", "v0.3.0"]),
        "Release 0.3.0\n\nNotes.\nAda"
    );
    assert_eq!(repo.oid("v0.3.0^{commit}").as_str(), at);
    repo.round_trip(&before, &applied);
    assert_eq!(repo.oid("v0.3.0^{commit}").as_str(), at);
}

#[test]
fn refuses_invalid_and_existing_names_and_changes_nothing() {
    let repo = Repo::new();
    repo.git(&["tag", "v0.1.0"]);
    let before = repo.state();
    for name in ["v0..1", "-x", "HEAD", "a b", "v1/", "v1.lock", ""] {
        let error = repo.create(name, "HEAD", None).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef, "{name}");
        assert_eq!(error.message, format!("'{name}' is not a valid tag name."));
    }
    for message in [None, Some("annotated")] {
        let error = repo.create("v0.1.0", "HEAD", message).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef);
        assert_eq!(error.message, "A tag named 'v0.1.0' already exists.");
        let error = repo.create("v0.1.0/rc", "HEAD", message).unwrap_err();
        assert_eq!(
            error.message,
            "A tag named 'v0.1.0' already exists, so Git cannot also store 'v0.1.0/rc'."
        );
    }
    assert_eq!(repo.state(), before);
    repo.no_entry();
}

#[test]
fn refuses_a_name_that_differs_only_in_case_where_refs_fold_case() {
    let repo = Repo::new();
    repo.git(&["config", "core.ignorecase", "true"]);
    repo.git(&["tag", "v1"]);
    repo.git(&["pack-refs", "--all"]);
    let before = repo.state();
    for message in [None, Some("annotated")] {
        let error = repo.create("V1", "HEAD", message).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef);
        assert!(
            error.message.contains("does not tell names apart by case"),
            "{}",
            error.message
        );
    }
    assert_eq!(repo.state(), before);
    repo.no_entry();
}

#[test]
fn signing_follows_tag_gpg_sign_and_a_broken_signer_changes_nothing() {
    let repo = Repo::new();
    repo.git(&["config", "tag.gpgSign", "true"]);
    repo.git(&["config", "gpg.program", "/nonexistent/gpg"]);
    let before = repo.state();
    let error = repo.create("signed", "HEAD", Some("Signed")).unwrap_err();
    assert_eq!(error.kind, ErrorKind::GitFailed);
    assert!(
        error.message.contains("/nonexistent/gpg"),
        "{}",
        error.message
    );
    let error = repo.create("light", "HEAD", None).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidRef);
    assert!(
        error.message.starts_with("tag.gpgSign is on"),
        "{}",
        error.message
    );
    assert_eq!(repo.state(), before);
    repo.no_entry();
}

#[test]
fn an_annotated_tag_without_an_identity_answers_missing_identity() {
    let repo = Repo::new();
    repo.git(&["config", "user.useConfigOnly", "true"]);
    repo.git(&["config", "user.name", ""]);
    let before = repo.state();
    let error = repo.create("v1", "HEAD", Some("Release")).unwrap_err();
    let ErrorKind::MissingIdentity { output } = &error.kind else {
        panic!("{error:?}");
    };
    assert!(output.contains("empty ident name"), "{output}");
    assert!(error.message.contains("made no tag"), "{}", error.message);
    assert_eq!(repo.state(), before);
    repo.no_entry();
}

#[test]
fn deletes_each_kind_and_undo_after_gc_restores_the_same_object() {
    let repo = Repo::new();
    let only_tagged = repo.dangling_commit();
    repo.git(&["tag", "light", &only_tagged]);
    repo.git(&[
        "tag",
        "-a",
        "-m",
        "Release\n\nBody",
        "annotated",
        &only_tagged,
    ]);
    for name in ["light", "annotated"] {
        let shown = repo.git(&["cat-file", "-p", &format!("refs/tags/{name}")]);
        let before = repo.state();
        let applied = repo.delete(repo.tip(name)).unwrap();
        assert!(
            !repo.state().contains(&format!("refs/tags/{name} ")),
            "{name} deleted"
        );
        let after = repo.state();
        repo.prune();
        repo.coordinator.undo(repo.path(), applied.id).unwrap();
        assert_eq!(repo.state(), before, "undo {name}");
        assert_eq!(
            repo.git(&["cat-file", "-p", &format!("refs/tags/{name}")]),
            shown
        );
        repo.prune();
        repo.coordinator.redo(repo.path(), applied.id).unwrap();
        assert_eq!(repo.state(), after, "redo {name}");
        repo.prune();
        repo.coordinator.undo(repo.path(), applied.id).unwrap();
        assert_eq!(repo.state(), before, "undo {name} again");
        repo.git(&["fsck", "--no-progress", "--connectivity-only"]);
    }
}

#[test]
fn refuses_a_tag_moved_since_the_view_and_an_undo_after_a_later_move() {
    let repo = Repo::new();
    repo.git(&["tag", "-a", "-m", "first", "v0.1.0", "HEAD~1"]);
    let shown = repo.tip("v0.1.0");
    repo.git(&["tag", "-f", "v0.1.0", "HEAD"]);
    let before = repo.state();
    let error = repo.delete(shown).unwrap_err();
    assert_eq!(error.kind, TAG_CHANGED);
    assert!(
        error.message.starts_with("v0.1.0 no longer points where"),
        "{}",
        error.message
    );
    assert_eq!(repo.state(), before);
    repo.no_entry();

    let applied = repo.create("v0.2.0", "HEAD", None).unwrap();
    repo.git(&["tag", "-f", "v0.2.0", "HEAD~1"]);
    let moved = repo.state();
    let error = repo.coordinator.undo(repo.path(), applied.id).unwrap_err();
    assert_eq!(error.kind, TAG_CHANGED);
    assert_eq!(repo.state(), moved);
}

#[test]
fn undo_of_a_create_finds_the_tag_already_gone_and_keeps_its_object_for_redo() {
    let repo = Repo::new();
    let before = repo.state();
    let applied = repo.create("v0.2.0", "HEAD", Some("Release")).unwrap();
    let after = repo.state();
    repo.git(&["tag", "-d", "v0.2.0"]);
    repo.coordinator.undo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.state(), before);
    let history = repo.coordinator.undo_history(repo.path()).unwrap();
    assert_eq!(history.redo.map(|entry| entry.id), Some(applied.id));
    repo.prune();
    repo.coordinator.redo(repo.path(), applied.id).unwrap();
    assert_eq!(repo.state(), after);

    let pruned = repo.create("v0.4.0", "HEAD", Some("Pruned")).unwrap();
    repo.git(&["tag", "-d", "v0.4.0"]);
    repo.prune();
    repo.coordinator.undo(repo.path(), pruned.id).unwrap();
    let error = repo.coordinator.redo(repo.path(), pruned.id).unwrap_err();
    assert_eq!(error.kind, ErrorKind::GitFailed);
    assert!(
        error
            .message
            .starts_with("Git no longer has some of this tag's commits"),
        "{}",
        error.message
    );
}

#[test]
fn refuses_to_tag_a_tree_a_blob_or_a_tag_object() {
    let repo = Repo::new();
    repo.git(&["tag", "-a", "-m", "Release", "v1"]);
    fs::write(repo.root.join("notes.txt"), "notes\n").unwrap();
    let blob = repo.git(&["hash-object", "-w", "notes.txt"]);
    let before = repo.state();
    for at in ["HEAD^{tree}", blob.as_str(), "refs/tags/v1"] {
        for message in [None, Some("annotated")] {
            let error = repo.create("t", at, message).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidOid, "{at}: {}", error.message);
            assert!(
                error.message.ends_with("is not a commit."),
                "{}",
                error.message
            );
        }
    }
    assert_eq!(repo.state(), before);
    repo.no_entry();
}

#[test]
fn signs_an_annotated_tag_when_tag_force_sign_annotated_asks() {
    let repo = Repo::new();
    let gpg = repo.root.parent().unwrap().join("gpg");
    fs::write(
        &gpg,
        "#!/bin/sh\ncat >/dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 1700000000 FAKE' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n",
    )
    .unwrap();
    fs::set_permissions(&gpg, fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "tag.forceSignAnnotated", "true"]);
    repo.git(&["config", "gpg.program", gpg.to_str().unwrap()]);

    repo.create("v1", "HEAD", Some("Release")).unwrap();
    let object = repo.git(&["cat-file", "-p", "v1"]);
    assert!(
        object.contains("\nRelease\n-----BEGIN PGP SIGNATURE-----\n"),
        "{object}"
    );
    repo.create("v2", "HEAD", None).unwrap();
    assert_eq!(repo.git(&["cat-file", "-t", "v2"]), "commit");
}

#[test]
fn a_message_of_only_whitespace_makes_a_lightweight_tag() {
    let repo = Repo::new();
    let before = repo.state();
    let applied = repo.create("v1", "HEAD", Some(" \n\t\n")).unwrap();
    assert_eq!(repo.git(&["cat-file", "-t", "v1"]), "commit");
    repo.round_trip(&before, &applied);
}

#[test]
fn refuses_a_case_twin_where_the_disk_folds_case_whatever_core_ignorecase_says() {
    let repo = Repo::new();
    if !repo.root.join(".git/REFS").exists() {
        return;
    }
    repo.git(&["config", "core.ignorecase", "false"]);
    repo.git(&["tag", "packed"]);
    repo.git(&["pack-refs", "--all"]);
    repo.git(&["tag", "loose"]);
    let before = repo.state();
    for name in ["PACKED", "Loose"] {
        for message in [None, Some("annotated")] {
            let error = repo.create(name, "HEAD", message).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidRef, "{}", error.message);
            assert!(
                error.message.contains("does not tell names apart by case"),
                "{}",
                error.message
            );
        }
    }
    assert_eq!(repo.state(), before);
    repo.no_entry();
}

#[test]
fn a_decomposed_name_is_created_and_compared_as_git_stores_it() {
    let repo = Repo::new();
    repo.git(&["config", "core.precomposeunicode", "true"]);
    let decomposed = "va\u{308}st";
    let stored = if cfg!(target_os = "macos") {
        "v\u{e4}st"
    } else {
        decomposed
    };
    for (suffix, message) in [("light", None), ("annotated", Some("Release"))] {
        let before = repo.state();
        let applied = repo
            .create(&format!("{decomposed}-{suffix}"), "HEAD", message)
            .unwrap();
        assert!(
            repo.state()
                .contains(&format!("refs/tags/{stored}-{suffix} ")),
            "{}",
            repo.state()
        );
        repo.round_trip(&before, &applied);
    }

    repo.git(&["tag", stored]);
    let before = repo.state();
    for message in [None, Some("annotated")] {
        let error = repo.create(decomposed, "HEAD", message).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef, "{}", error.message);
        assert_eq!(
            error.message,
            format!("A tag named '{stored}' already exists.")
        );
        let error = repo
            .create(&format!("{decomposed}/rc"), "HEAD", message)
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRef, "{}", error.message);
    }
    assert_eq!(repo.state(), before);
}
