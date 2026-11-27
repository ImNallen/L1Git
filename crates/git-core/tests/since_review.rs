#![cfg(unix)]

use l1_git_core::{
    Coordinator, FilePatch, FromBase, Limits, Oid, RangeFile, RangeStatus, Response, SinceReview,
    Untold, range_patches, run, since_review,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str], input: &[u8]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let mut child = command
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.test")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.test")
        .env("GIT_AUTHOR_DATE", "1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "1700000000 +0000")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
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

fn oid(value: String) -> Oid {
    Oid::try_from(value).unwrap()
}

/// Thirty numbered lines, with some of them replaced.
fn lines(edits: &[(usize, &str)]) -> String {
    (1..=30)
        .map(|n| {
            let edit = edits.iter().find(|(at, _)| *at == n);
            format!(
                "{}\n",
                edit.map_or(n.to_string(), |(_, text)| (*text).to_owned())
            )
        })
        .collect()
}

type Tree = BTreeMap<&'static str, String>;

fn tree(entries: &[(&'static str, String)]) -> Tree {
    entries.iter().cloned().collect()
}

struct Fixture {
    directory: TempDir,
    repo: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--quiet", "--initial-branch=main"], b"");
        Self { directory, repo }
    }

    fn path(&self) -> &str {
        self.repo.to_str().unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.repo, args, b"")
    }

    fn commit(&self, tree: &Tree, parents: &[&Oid]) -> Oid {
        let mut index = String::new();
        for (path, contents) in tree {
            let blob = git(
                &self.repo,
                &["hash-object", "-w", "--stdin"],
                contents.as_bytes(),
            );
            index.push_str(&format!("100644 {blob}\t{path}\n"));
        }
        self.git(&["read-tree", "--empty"]);
        git(
            &self.repo,
            &["update-index", "--index-info"],
            index.as_bytes(),
        );
        let written = self.git(&["write-tree"]);
        let mut args = vec!["commit-tree", &written, "-m", "commit"];
        for parent in parents {
            args.extend(["-p", parent.as_str()]);
        }
        oid(self.git(&args))
    }

    fn read(&self, pull: &Pull) -> SinceReview {
        since_review(self.path(), &pull.base, &pull.reviewed, &pull.head).unwrap()
    }

    /// A clone of the branches at `tips`, made with `options`.
    fn clone(&self, tips: &[&Oid], options: &[&str]) -> String {
        for (n, tip) in tips.iter().enumerate() {
            self.git(&["update-ref", &format!("refs/heads/tip{n}"), tip.as_str()]);
        }
        self.git(&["config", "uploadpack.allowFilter", "true"]);
        let source = url::Url::from_file_path(self.repo.canonicalize().unwrap()).unwrap();
        let path = self.directory.path().join("clone");
        let mut args = vec!["clone", "--quiet", "--no-checkout", "--no-single-branch"];
        args.extend(options);
        args.extend([source.as_str(), path.to_str().unwrap()]);
        git(self.directory.path(), &args, b"");
        path.to_str().unwrap().to_owned()
    }
}

/// `base` is the tip of the base branch now, and `reviewed` the head you reviewed.
struct Pull {
    base: Oid,
    reviewed: Oid,
    head: Oid,
}

struct Ready {
    since: Oid,
    from_base: FromBase,
    reviewed: Vec<RangeFile>,
    files: Vec<RangeFile>,
    content_missing: bool,
}

fn ready(read: SinceReview) -> Ready {
    match read {
        SinceReview::Ready {
            since,
            from_base,
            reviewed,
            files,
            content_missing,
        } => Ready {
            since,
            from_base,
            reviewed,
            files,
            content_missing,
        },
        other => panic!("a since list, got {other:?}"),
    }
}

fn names(files: &[RangeFile]) -> Vec<String> {
    files
        .iter()
        .map(|file| {
            let status = match file.status {
                RangeStatus::Added => 'A',
                RangeStatus::Deleted => 'D',
                RangeStatus::Modified => 'M',
                RangeStatus::TypeChanged => 'T',
                RangeStatus::Renamed => 'R',
            };
            format!("{status} {}", file.path)
        })
        .collect()
}

/// The added and deleted lines of `path`'s patch from `since` to `head`.
fn changed_lines(path: &str, since: &Oid, head: &Oid, file: &str) -> Vec<String> {
    let patches = range_patches(path, since, head).unwrap();
    let Some(FilePatch::Text { patch, .. }) = patches
        .into_iter()
        .find(|read| read.path == file)
        .and_then(|read| read.patch)
    else {
        panic!("a text patch of {file}");
    };
    patch
        .lines()
        .filter(|line| {
            (line.starts_with('+') || line.starts_with('-'))
                && !line.starts_with("+++")
                && !line.starts_with("---")
        })
        .map(str::to_owned)
        .collect()
}

/// You reviewed `a`, `b`, `c` and `d`. Then main changed `b`, `u` and two lines of `d`,
/// one of them the line the pull request changed. The author rebased, settled that
/// conflict with a line of their own, and changed `c` again.
fn rebased(fixture: &Fixture) -> Pull {
    let start = fixture.commit(
        &tree(&[
            ("a", lines(&[])),
            ("b", lines(&[])),
            ("c", lines(&[])),
            ("d", lines(&[])),
            ("u", "x\n".into()),
        ]),
        &[],
    );
    let reviewed = fixture.commit(
        &tree(&[
            ("a", lines(&[(5, "five")])),
            ("b", lines(&[(5, "five")])),
            ("c", lines(&[(5, "five")])),
            ("d", lines(&[(20, "twenty")])),
            ("u", "x\n".into()),
        ]),
        &[&start],
    );
    let base = fixture.commit(
        &tree(&[
            ("a", lines(&[])),
            ("b", lines(&[(28, "main28")])),
            ("c", lines(&[])),
            ("d", lines(&[(2, "main2"), (20, "MAIN20")])),
            ("u", "x\ny\n".into()),
        ]),
        &[&start],
    );
    let replayed = fixture.commit(
        &tree(&[
            ("a", lines(&[(5, "five")])),
            ("b", lines(&[(5, "five"), (28, "main28")])),
            ("c", lines(&[(5, "five")])),
            ("d", lines(&[(2, "main2"), (20, "twenty-main")])),
            ("u", "x\ny\n".into()),
        ]),
        &[&base],
    );
    let head = fixture.commit(
        &tree(&[
            ("a", lines(&[(5, "five")])),
            ("b", lines(&[(5, "five"), (28, "main28")])),
            ("c", lines(&[(5, "five"), (9, "nine")])),
            ("d", lines(&[(2, "main2"), (20, "twenty-main")])),
            ("u", "x\ny\n".into()),
        ]),
        &[&replayed],
    );
    Pull {
        base,
        reviewed,
        head,
    }
}

#[test]
fn leaves_out_what_main_changed_under_a_rebase() {
    let fixture = Fixture::new();
    let pull = rebased(&fixture);
    let read = ready(fixture.read(&pull));
    assert_eq!(read.from_base, FromBase::LeftOut);
    assert_eq!(names(&read.files), ["M c", "M d"]);
    assert_eq!(
        changed_lines(fixture.path(), &read.since, &pull.head, "d"),
        ["-twenty", "+twenty-main"]
    );
    assert_eq!(
        changed_lines(fixture.path(), &read.since, &pull.head, "c"),
        ["-9", "+nine"]
    );
    assert_eq!(names(&read.reviewed), ["M a", "M b", "M c", "M d"]);
    assert!(!read.content_missing);
    assert_ne!(read.since, pull.reviewed);
    assert_eq!(
        fixture.git(&["rev-parse", &format!("{}^", read.since.as_str())]),
        pull.base.as_str()
    );
}

#[test]
fn reads_a_merge_of_main_like_a_rebase() {
    let fixture = Fixture::new();
    let start = fixture.commit(
        &tree(&[
            ("a", lines(&[])),
            ("b", lines(&[])),
            ("c", lines(&[])),
            ("u", "x\n".into()),
        ]),
        &[],
    );
    let reviewed = fixture.commit(
        &tree(&[
            ("a", lines(&[(5, "five")])),
            ("b", lines(&[(5, "five")])),
            ("c", lines(&[(5, "five")])),
            ("u", "x\n".into()),
        ]),
        &[&start],
    );
    let base = fixture.commit(
        &tree(&[
            ("a", lines(&[])),
            ("b", lines(&[(28, "main28")])),
            ("c", lines(&[])),
            ("u", "x\ny\n".into()),
        ]),
        &[&start],
    );
    let merged = tree(&[
        ("a", lines(&[(5, "five")])),
        ("b", lines(&[(5, "five"), (28, "main28")])),
        ("c", lines(&[(5, "five")])),
        ("u", "x\ny\n".into()),
    ]);
    let merge = fixture.commit(&merged, &[&reviewed, &base]);
    let mut after = merged.clone();
    after.insert("c", lines(&[(5, "five"), (9, "nine")]));
    let head = fixture.commit(&after, &[&merge]);
    let pull = Pull {
        base,
        reviewed,
        head,
    };
    let read = ready(fixture.read(&pull));
    assert_eq!(read.from_base, FromBase::LeftOut);
    assert_eq!(names(&read.files), ["M c"]);
}

#[test]
fn is_the_reviewed_commit_when_the_base_did_not_move() {
    let fixture = Fixture::new();
    let start = fixture.commit(&tree(&[("a", lines(&[])), ("b", lines(&[]))]), &[]);
    let reviewed = fixture.commit(
        &tree(&[("a", lines(&[(5, "five")])), ("b", lines(&[]))]),
        &[&start],
    );
    let head = fixture.commit(
        &tree(&[("a", lines(&[(5, "five"), (9, "nine")])), ("b", lines(&[]))]),
        &[&reviewed],
    );
    // Main moved on, but the pull request did not take it in.
    let base = fixture.commit(
        &tree(&[("a", lines(&[])), ("b", lines(&[(1, "main1")]))]),
        &[&start],
    );
    let pull = Pull {
        base,
        reviewed: reviewed.clone(),
        head,
    };
    let read = ready(fixture.read(&pull));
    assert_eq!(read.from_base, FromBase::None);
    assert_eq!(read.since, reviewed);
    assert_eq!(names(&read.files), ["M a"]);
    assert_eq!(names(&read.reviewed), ["M a"]);
}

#[test]
fn writes_the_same_commit_twice_and_no_ref() {
    let fixture = Fixture::new();
    let pull = rebased(&fixture);
    fixture.git(&["update-ref", "refs/heads/main", pull.base.as_str()]);
    let refs = || {
        fixture.git(&[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "--include-root-refs",
        ])
    };
    let index = || fs::read(fixture.repo.join(".git/index")).unwrap();
    let before = (refs(), index());
    let first = ready(fixture.read(&pull)).since;
    let second = ready(fixture.read(&pull)).since;
    assert_eq!(first, second);
    assert_ne!(first, pull.reviewed);
    assert_eq!((refs(), index()), before);
}

/// You reviewed a change to `kept`, and main deleted `kept`. The author rebased and kept
/// the file as you reviewed it.
#[test]
fn a_file_main_deleted_and_the_pull_request_kept_is_left_out() {
    let fixture = Fixture::new();
    let start = fixture.commit(&tree(&[("a", lines(&[])), ("kept", lines(&[]))]), &[]);
    let reviewed = fixture.commit(
        &tree(&[
            ("a", lines(&[(5, "five")])),
            ("kept", lines(&[(5, "five")])),
        ]),
        &[&start],
    );
    let base = fixture.commit(&tree(&[("a", lines(&[]))]), &[&start]);
    let replayed = fixture.commit(
        &tree(&[
            ("a", lines(&[(5, "five")])),
            ("kept", lines(&[(5, "five")])),
        ]),
        &[&base],
    );
    let head = fixture.commit(
        &tree(&[
            ("a", lines(&[(5, "five"), (9, "nine")])),
            ("kept", lines(&[(5, "five")])),
        ]),
        &[&replayed],
    );
    let pull = Pull {
        base,
        reviewed,
        head,
    };
    let read = ready(fixture.read(&pull));
    assert_eq!(read.from_base, FromBase::LeftOut);
    assert_eq!(names(&read.files), ["M a"]);
}

/// You reviewed the deletion of `gone`, and main changed `gone`. Git keeps main's
/// version in the replayed tree, so the replay would hide the deletion.
#[test]
fn a_file_the_pull_request_deleted_and_main_changed_is_untold() {
    let fixture = Fixture::new();
    let start = fixture.commit(&tree(&[("a", lines(&[])), ("gone", lines(&[]))]), &[]);
    let reviewed = fixture.commit(&tree(&[("a", lines(&[(5, "five")]))]), &[&start]);
    let base = fixture.commit(
        &tree(&[("a", lines(&[])), ("gone", lines(&[(9, "nine")]))]),
        &[&start],
    );
    let replayed = fixture.commit(&tree(&[("a", lines(&[(5, "five")]))]), &[&base]);
    let head = fixture.commit(
        &tree(&[("a", lines(&[(5, "five"), (9, "nine")]))]),
        &[&replayed],
    );
    let pull = Pull {
        base,
        reviewed: reviewed.clone(),
        head,
    };
    let read = ready(fixture.read(&pull));
    assert_eq!(
        read.from_base,
        FromBase::Untold {
            why: Untold::Conflict
        }
    );
    assert_eq!(read.since, reviewed);
    assert_eq!(names(&read.files), ["M a"]);
}

#[test]
fn a_blobless_clone_is_untold() {
    let fixture = Fixture::new();
    let pull = rebased(&fixture);
    let clone = fixture.clone(
        &[&pull.base, &pull.head, &pull.reviewed],
        &["--filter=blob:none"],
    );
    let read = ready(since_review(&clone, &pull.base, &pull.reviewed, &pull.head).unwrap());
    assert_eq!(
        read.from_base,
        FromBase::Untold {
            why: Untold::Unreadable
        }
    );
    assert_eq!(read.since, pull.reviewed);
    assert!(read.content_missing);
    assert_eq!(names(&read.files), ["M b", "M c", "M d", "M u"]);
}

#[test]
fn a_shallow_clone_is_untold() {
    let fixture = Fixture::new();
    let first = fixture.commit(&tree(&[("a", lines(&[]))]), &[]);
    let start = fixture.commit(&tree(&[("a", lines(&[])), ("b", lines(&[]))]), &[&first]);
    let reviewed = fixture.commit(
        &tree(&[("a", lines(&[(5, "five")])), ("b", lines(&[]))]),
        &[&start],
    );
    let base = fixture.commit(
        &tree(&[("a", lines(&[])), ("b", lines(&[(1, "main1")]))]),
        &[&start],
    );
    let head = fixture.commit(
        &tree(&[("a", lines(&[(5, "five")])), ("b", lines(&[(1, "main1")]))]),
        &[&base],
    );
    let pull = Pull {
        base,
        reviewed: reviewed.clone(),
        head,
    };
    assert_eq!(ready(fixture.read(&pull)).from_base, FromBase::LeftOut);
    let clone = fixture.clone(&[&pull.base, &pull.head, &pull.reviewed], &["--depth=2"]);
    let read = ready(since_review(&clone, &pull.base, &pull.reviewed, &pull.head).unwrap());
    assert_eq!(
        read.from_base,
        FromBase::Untold {
            why: Untold::Shallow
        }
    );
    assert_eq!(read.since, reviewed);
    assert_eq!(names(&read.files), ["M b"]);
}

#[test]
fn names_a_reviewed_commit_this_clone_lacks() {
    let fixture = Fixture::new();
    let pull = rebased(&fixture);
    // A clone made after the force push never had the commit you reviewed.
    let clone = fixture.clone(&[&pull.base, &pull.head], &[]);
    assert_eq!(
        since_review(&clone, &pull.base, &pull.reviewed, &pull.head).unwrap(),
        SinceReview::Missing {
            oids: vec![pull.reviewed.clone()]
        }
    );
}

#[test]
fn runs_no_merge_driver_of_the_repository_or_the_person() {
    let fixture = Fixture::new();
    let pull = rebased(&fixture);
    let ran = fixture.directory.path().join("driver ran");
    let attributes = fixture.directory.path().join("attributes");
    fs::write(&attributes, "b merge=mine\n").unwrap();
    fs::write(fixture.repo.join(".git/info/attributes"), "d merge=mine\n").unwrap();
    let driver = format!("touch '{}'; false", ran.display());
    fixture.git(&["config", "merge.mine.driver", &driver]);
    fixture.git(&["config", "merge.default", "mine"]);
    fixture.git(&[
        "config",
        "core.attributesFile",
        attributes.to_str().unwrap(),
    ]);
    let read = ready(fixture.read(&pull));
    assert!(!ran.exists());
    // Git cannot merge `d` without the driver its attributes name, so it conflicts.
    assert_eq!(
        read.from_base,
        FromBase::Untold {
            why: Untold::Conflict
        }
    );
}

#[test]
fn the_bridge_answers_it_in_camel_case() {
    let fixture = Fixture::new();
    let pull = rebased(&fixture);
    let coordinator = Coordinator::new(Limits::default(), fixture.directory.path().join("undo"));
    let request = json!({
        "op": "sinceReview",
        "path": fixture.path(),
        "base": pull.base.as_str(),
        "reviewed": pull.reviewed.as_str(),
        "head": pull.head.as_str(),
    });
    let response = run(&coordinator, serde_json::from_value(request).unwrap()).unwrap();
    assert!(matches!(response, Response::SinceReview(_)));
    let answer = serde_json::to_value(&response).unwrap();
    assert_eq!(answer["op"], "sinceReview");
    assert_eq!(answer["data"]["kind"], "ready");
    assert_eq!(answer["data"]["fromBase"], json!({ "kind": "leftOut" }));
    assert_eq!(answer["data"]["contentMissing"], false);
    assert_eq!(answer["data"]["files"][0]["path"], "c");
    assert_eq!(answer["data"]["reviewed"][0]["path"], "a");
    assert!(answer["data"]["since"].is_string());
    let form = |from_base: FromBase| serde_json::to_value(from_base).unwrap();
    assert_eq!(form(FromBase::None), json!({ "kind": "none" }));
    for (why, name) in [
        (Untold::Shallow, "shallow"),
        (Untold::Conflict, "conflict"),
        (Untold::Unreadable, "unreadable"),
    ] {
        assert_eq!(
            form(FromBase::Untold { why }),
            json!({ "kind": "untold", "why": name })
        );
    }
    let missing = SinceReview::Missing {
        oids: vec![pull.reviewed.clone()],
    };
    assert_eq!(
        serde_json::to_value(missing).unwrap(),
        json!({ "kind": "missing", "oids": [pull.reviewed.as_str()] })
    );
}
