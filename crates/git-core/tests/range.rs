#![cfg(unix)]

use l1_git_core::{
    Comparison, Coordinator, ErrorKind, FilePatch, Limits, Oid, RANGE_PATCH_LIMIT, RangeFile,
    RangeFiles, RangeStatus, Request, Response, file_patch, range_files, range_patches, run,
};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str], input: &[u8]) -> Vec<u8> {
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
    output.stdout
}

fn line(output: Vec<u8>) -> String {
    String::from_utf8(output).unwrap().trim_end().to_owned()
}

fn oid(value: &str) -> Oid {
    Oid::try_from(value.to_owned()).unwrap()
}

const FILE: &str = "100644";
const EXECUTABLE: &str = "100755";
const SYMLINK: &str = "120000";
const SUBMODULE: &str = "160000";
const PINNED: &str = "1111111111111111111111111111111111111111";
const MOVED: &str = "2222222222222222222222222222222222222222";

/// A tree's entries by path. A submodule's contents are the commit it is at.
type Tree = BTreeMap<Vec<u8>, (&'static str, Vec<u8>)>;

fn tree(entries: &[(&str, &'static str, &[u8])]) -> Tree {
    entries
        .iter()
        .map(|(path, mode, contents)| (path.as_bytes().to_vec(), (*mode, contents.to_vec())))
        .collect()
}

struct Fixture {
    directory: TempDir,
    repo: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo with spaces");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--quiet", "--initial-branch=main"], b"");
        Self { directory, repo }
    }

    fn path(&self) -> &str {
        self.repo.to_str().unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        line(git(&self.repo, args, b""))
    }

    /// Commits trees that a file system might refuse to hold.
    fn commit(&self, tree: &Tree, parents: &[&Oid]) -> Oid {
        let mut index = Vec::new();
        for (path, (mode, contents)) in tree {
            let object = if *mode == SUBMODULE {
                String::from_utf8(contents.clone()).unwrap()
            } else {
                line(git(&self.repo, &["hash-object", "-w", "--stdin"], contents))
            };
            index.extend(format!("{mode} {object}\t").into_bytes());
            index.extend(path);
            index.push(0);
        }
        self.git(&["read-tree", "--empty"]);
        git(&self.repo, &["update-index", "-z", "--index-info"], &index);
        let written = self.git(&["write-tree"]);
        let mut args = vec!["commit-tree", &written, "-m", "commit"];
        for parent in parents {
            args.extend(["-p", parent.as_str()]);
        }
        oid(&self.git(&args))
    }

    fn range(&self, before: &Tree, after: &Tree) -> (Oid, Oid) {
        let base = self.commit(before, &[]);
        let head = self.commit(after, &[&base]);
        (base, head)
    }

    fn files(&self, (base, head): &(Oid, Oid)) -> Vec<RangeFile> {
        ready(range_files(self.path(), base, head).unwrap())
    }

    fn patches(&self, (base, head): &(Oid, Oid)) -> Vec<(String, Option<FilePatch>)> {
        range_patches(self.path(), base, head)
            .unwrap()
            .into_iter()
            .map(|read| (read.path, read.patch))
            .collect()
    }

    fn read(&self, request: serde_json::Value) -> Result<Response, ErrorKind> {
        let undo = self.directory.path().join("undo");
        let coordinator = Coordinator::new(Limits::default(), undo);
        run(&coordinator, serde_json::from_value(request).unwrap()).map_err(|error| error.kind)
    }

    fn one(&self, range: &(Oid, Oid), from: &str, file: &str) -> Result<FilePatch, ErrorKind> {
        let (base, head) = range;
        self.read(serde_json::json!({
            "op": "filePatch",
            "path": self.path(),
            "comparison": Comparison::between(base.as_str(), head.as_str()),
            "file": file,
            "from": from,
        }))
        .map(|response| match response {
            Response::FilePatch(patch) => patch,
            other => panic!("a file patch, got {other:?}"),
        })
    }
}

fn ready(files: RangeFiles) -> Vec<RangeFile> {
    match files {
        RangeFiles::Ready {
            files,
            content_missing: false,
            ..
        } => files,
        other => panic!("every file, got {other:?}"),
    }
}

/// `status path[ < from similarity] +added -deleted`, with `bin` for no counts.
fn summary(files: &[RangeFile]) -> Vec<String> {
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
            let from = match (&file.from, file.similarity) {
                (Some(from), Some(similarity)) => format!(" < {from} {similarity}"),
                (None, None) => String::new(),
                other => panic!("{other:?}"),
            };
            let counts = match (file.added, file.deleted) {
                (Some(added), Some(deleted)) => format!("+{added} -{deleted}"),
                (None, None) => "bin".into(),
                other => panic!("{other:?}"),
            };
            let sub = if file.submodule { " sub" } else { "" };
            format!("{status} {}{from} {counts}{sub}", file.path)
        })
        .collect()
}

fn lines(range: std::ops::Range<u32>) -> Vec<u8> {
    range
        .flat_map(|n| format!("line {n}\n").into_bytes())
        .collect()
}

const ODD: &str = "we\"ird\\\n\tname";

fn odd_range(fixture: &Fixture) -> (Oid, Oid) {
    let mut before = tree(&[
        ("crlf", FILE, b"one\r\ntwo\r\n"),
        ("dir/mode", FILE, b"same\n"),
        ("dir/moved", FILE, b"same contents\n"),
        ("edited", FILE, &lines(0..20)),
        ("gone", FILE, b"gone\n"),
        ("link", SYMLINK, b"target"),
        ("logo", FILE, b"\x89PNG\0\x01"),
        ("mode.bin", FILE, b"\0\x01"),
        ("module", SUBMODULE, PINNED.as_bytes()),
        ("no newline", FILE, b"one\ntwo"),
        ("type", FILE, b"text\n"),
        ("module to file", SUBMODULE, PINNED.as_bytes()),
        ("cafe\u{301}", FILE, b"decomposed\n"),
        (ODD, FILE, b"odd\n"),
        ("\u{e9}.txt", FILE, b"accent\n"),
    ]);
    before.insert(b"bad\xff".to_vec(), (FILE, b"bytes\n".to_vec()));
    let mut after = before.clone();
    for (path, mode, contents) in [
        ("crlf", FILE, b"one\r\n2\r\n".as_slice()),
        ("dir/mode", EXECUTABLE, b"same\n"),
        ("link", SYMLINK, b"elsewhere"),
        ("logo", FILE, b"\x89PNG\0\x02"),
        ("mode.bin", EXECUTABLE, b"\0\x01"),
        ("module", SUBMODULE, MOVED.as_bytes()),
        ("new module", SUBMODULE, PINNED.as_bytes()),
        ("no newline", FILE, b"one\ntwo\n"),
        ("type", SYMLINK, b"edited"),
        ("module to file", FILE, b"now a file\n"),
        ("cafe\u{301}", FILE, b"decomposed\nmore\n"),
        (ODD, FILE, b"odd\nmore\n"),
        ("\u{e9}.txt", FILE, b"accent\nmore\n"),
        ("empty", FILE, b""),
        ("moved\there", FILE, b"same contents\n"),
        ("re\"named", FILE, &lines(1..21)),
    ] {
        after.insert(path.as_bytes().to_vec(), (mode, contents.to_vec()));
    }
    for path in ["gone", "dir/moved", "edited"] {
        after.remove(path.as_bytes());
    }
    after.insert(b"bad\xff".to_vec(), (FILE, b"bytes\nmore\n".to_vec()));
    fixture.range(&before, &after)
}

#[test]
fn lists_every_kind_of_change_in_gits_order() {
    let fixture = Fixture::new();
    let range = odd_range(&fixture);
    let files = fixture.files(&range);
    assert_eq!(
        summary(&files),
        [
            "M bad\u{fffd} +1 -0".to_owned(),
            "M cafe\u{301} +1 -0".into(),
            "M crlf +1 -1".into(),
            "M dir/mode +0 -0".into(),
            "A empty +0 -0".into(),
            "D gone +0 -1".into(),
            "M link +1 -1".into(),
            "M logo bin".into(),
            "M mode.bin bin".into(),
            "M module +1 -1 sub".into(),
            "T module to file +1 -1".into(),
            "R moved\there < dir/moved 100 +0 -0".into(),
            "A new module +1 -0 sub".into(),
            "M no newline +1 -1".into(),
            "R re\"named < edited 94 +1 -1".into(),
            "T type +1 -1".into(),
            format!("M {ODD} +1 -0"),
            "M \u{e9}.txt +1 -0".into(),
        ]
    );
    let blobs = |path: &str| {
        let file = files.iter().find(|file| file.path == path).unwrap();
        let text = |blob: &Option<Oid>| blob.as_ref().map(|oid| oid.as_str().to_owned());
        (text(&file.old_blob), text(&file.new_blob))
    };
    let (old, new) = blobs("dir/mode");
    assert_eq!(old, new);
    assert_eq!(blobs("gone").1, None);
    assert_eq!(blobs("empty").0, None);
    assert_eq!(blobs("module"), (Some(PINNED.into()), Some(MOVED.into())));
    let (base, head) = &range;
    assert!(matches!(
        range_files(fixture.path(), base, head).unwrap(),
        RangeFiles::Ready { merge_base, .. } if merge_base == *base
    ));
    assert_eq!(
        range_files(fixture.path(), head, head).unwrap(),
        RangeFiles::Ready {
            merge_base: head.clone(),
            files: Vec::new(),
            content_missing: false,
        }
    );
    assert_eq!(range_patches(fixture.path(), head, head).unwrap(), []);
}

#[test]
fn patches_every_kind_of_change_as_the_single_read_does() {
    let fixture = Fixture::new();
    let range = odd_range(&fixture);
    let files = fixture.files(&range);
    let patches = fixture.patches(&range);
    assert_eq!(files.len(), patches.len());
    for (file, (path, patch)) in files.iter().zip(&patches) {
        assert_eq!(&file.path, path);
        let patch = patch.as_ref().unwrap();
        if path.contains('\u{fffd}') {
            assert!(matches!(patch, FilePatch::Text { lossy: true, .. }));
            assert_eq!(
                fixture.one(&range, path, path),
                Err(ErrorKind::UnsupportedPath)
            );
            continue;
        }
        let from = file.from.as_deref().unwrap_or(path);
        assert_eq!(fixture.one(&range, from, path).as_ref(), Ok(patch));
    }
    let text = |path: &str| {
        let (_, patch) = patches.iter().find(|(read, _)| read == path).unwrap();
        match patch {
            Some(FilePatch::Text { patch, .. }) => patch.as_str(),
            other => panic!("{path} as text, got {other:?}"),
        }
    };
    let patch = |path: &str| &patches.iter().find(|(read, _)| read == path).unwrap().1;
    assert_eq!(*patch("logo"), Some(FilePatch::Binary));
    assert_eq!(
        text("mode.bin"),
        "diff --git a/mode.bin b/mode.bin\nold mode 100644\nnew mode 100755\n"
    );
    assert_eq!(
        text("moved\there"),
        "diff --git a/dir/moved \"b/moved\\there\"\nsimilarity index 100%\nrename from dir/moved\nrename to \"moved\\there\"\n"
    );
    assert!(text("re\"named").ends_with(" line 19\n+line 20\n"));
    assert!(text("type").contains("-text\ndiff --git a/type b/type\nnew file mode 120000\n"));
    assert!(text("crlf").ends_with(" one\r\n-two\r\n+2\r\n"));
    assert!(text("no newline").ends_with("-two\n\\ No newline at end of file\n+two\n"));
    assert!(text("module").ends_with(&format!(
        "-Subproject commit {PINNED}\n+Subproject commit {MOVED}\n"
    )));
    assert!(
        text(ODD).starts_with(
            "diff --git \"a/we\\\"ird\\\\\\n\\tname\" \"b/we\\\"ird\\\\\\n\\tname\"\n"
        )
    );
}

#[test]
fn a_renamed_file_reads_whole_and_only_under_its_own_old_path() {
    let fixture = Fixture::new();
    let range = odd_range(&fixture);
    let (base, head) = &range;
    let whole = fixture.read(serde_json::json!({
        "op": "filePatch",
        "path": fixture.path(),
        "comparison": Comparison::between(base.as_str(), head.as_str()),
        "file": "re\"named",
        "from": "edited",
        "context": "whole",
    }));
    let Ok(Response::FilePatch(FilePatch::Text { patch, .. })) = whole else {
        panic!("a text patch, got {whole:?}");
    };
    assert!(
        patch.contains("\n@@ -1,20 +1,20 @@\n-line 0\n line 1\n"),
        "{patch}"
    );
    assert!(patch.ends_with(" line 19\n+line 20\n"), "{patch}");
    for (from, file) in [
        ("gone", "re\"named"),
        ("missing", "missing"),
        ("", "re\"named"),
        ("edited", ""),
        ("dir", "dir"),
    ] {
        assert_eq!(
            fixture.one(&range, from, file),
            Err(ErrorKind::UnchangedPath),
            "{from:?} {file:?}"
        );
    }
    let error = fixture.read(serde_json::json!({
        "op": "filePatch",
        "path": fixture.path(),
        "comparison": {
            "base": {"kind": "commit", "oid": base},
            "target": {"kind": "worktree", "root": fixture.repo},
        },
        "file": "re\"named",
        "from": "edited",
    }));
    assert!(matches!(error, Err(ErrorKind::UnsupportedPath)));
}

#[test]
fn a_path_that_is_also_a_folder_reads_alone() {
    let fixture = Fixture::new();
    let range = fixture.range(
        &tree(&[
            ("into/a", FILE, b"first\n"),
            ("out", FILE, &lines(0..30)),
            ("swap a", FILE, b"left\n"),
            ("swap b", FILE, b"right\n"),
        ]),
        &tree(&[
            ("into", FILE, b"unrelated\n"),
            ("out/deeper", FILE, b"new\n"),
            ("swap a", FILE, b"right\n"),
            ("swap b", FILE, b"left\n"),
            ("lib", FILE, &lines(0..30)),
        ]),
    );
    let files = fixture.files(&range);
    assert_eq!(
        summary(&files),
        [
            "A into +1 -0",
            "D into/a +0 -1",
            "R lib < out 100 +0 -0",
            "A out/deeper +1 -0",
            "M swap a +1 -1",
            "M swap b +1 -1",
        ]
    );
    for (file, (path, patch)) in files.iter().zip(fixture.patches(&range)) {
        let from = file.from.as_deref().unwrap_or(&path);
        assert_eq!(fixture.one(&range, from, &path), Ok(patch.unwrap()));
    }
}

#[test]
fn a_persons_configuration_and_checkout_change_nothing() {
    let fixture = Fixture::new();
    let mut before = tree(&[
        (".gitattributes", FILE, b"*.rs diff=mine\n"),
        (
            ".gitmodules",
            FILE,
            b"[submodule \"m\"]\n\tpath = m\n\turl = ../m\n\tignore = all\n",
        ),
        ("a/code.rs", FILE, b"f\ne\nb\ne\ne\nb\nd\na\n"),
        ("b/indent.rs", FILE, b"1\n2\na\n\nb\n3\n4\n"),
        ("m", SUBMODULE, PINNED.as_bytes()),
        ("moved", FILE, &lines(0..40)),
        ("moved too", FILE, &lines(100..140)),
        ("\u{e9}", FILE, b"one\n"),
    ]);
    let mut after = before.clone();
    after.insert(
        b"a/code.rs".to_vec(),
        (FILE, b"d\na\nf\ne\nb\ne\ne\nb\n".to_vec()),
    );
    after.insert(
        b"b/indent.rs".to_vec(),
        (FILE, b"1\n2\na\n\nb\na\n\nb\n3\n4\n".to_vec()),
    );
    after.insert(b"m".to_vec(), (SUBMODULE, MOVED.as_bytes().to_vec()));
    after.insert("\u{e9}".as_bytes().to_vec(), (FILE, b"two\n".to_vec()));
    for (from, to, kept) in [
        ("moved", "elsewhere", 0..45),
        ("moved too", "other", 100..145),
    ] {
        after.remove(from.as_bytes());
        after.insert(to.as_bytes().to_vec(), (FILE, lines(kept)));
    }
    let range = fixture.range(&before, &after);
    let read = || {
        let files = fixture.files(&range);
        let patches = fixture.patches(&range);
        let single: Vec<_> = files
            .iter()
            .map(|file| {
                let from = file.from.as_deref().unwrap_or(&file.path);
                fixture.one(&range, from, &file.path).unwrap()
            })
            .collect();
        for ((path, patch), single) in patches.iter().zip(&single) {
            assert_eq!(patch.as_ref(), Some(single), "{path}");
        }
        (files, patches)
    };
    let pinned = read();
    assert_eq!(
        summary(&pinned.0),
        [
            "M a/code.rs +2 -2",
            "M b/indent.rs +3 -0",
            "R elsewhere < moved 88 +5 -0",
            "M m +1 -1 sub",
            "R other < moved too 88 +5 -0",
            "M \u{e9} +1 -1",
        ]
    );

    let attributes = fixture.directory.path().join("attributes");
    fs::write(&attributes, "* -diff\n").unwrap();
    // An attribute of the checked-out branch, not of the range.
    fs::write(fixture.repo.join(".gitattributes"), "*.rs binary\n").unwrap();
    for (key, value) in [
        ("core.abbrev", "7"),
        ("core.attributesFile", attributes.to_str().unwrap()),
        ("core.bigFileThreshold", "1"),
        ("core.quotePath", "true"),
        ("color.ui", "always"),
        ("color.diff", "always"),
        ("diff.algorithm", "patience"),
        ("diff.context", "9"),
        ("diff.external", "/usr/bin/false"),
        ("diff.ignoreSubmodules", "all"),
        ("diff.indentHeuristic", "false"),
        ("diff.interHunkContext", "9"),
        ("diff.mine.algorithm", "patience"),
        ("diff.mine.command", "/usr/bin/false"),
        ("diff.mine.textconv", "/usr/bin/false"),
        ("diff.mnemonicPrefix", "true"),
        ("diff.noprefix", "true"),
        ("diff.orderFile", attributes.to_str().unwrap()),
        ("diff.relative", "true"),
        ("diff.renameLimit", "1"),
        ("diff.renames", "false"),
        ("diff.submodule", "log"),
        ("diff.suppressBlankEmpty", "true"),
        ("submodule.m.ignore", "all"),
    ] {
        fixture.git(&["config", key, value]);
    }
    assert_eq!(read(), pinned);

    // A range that does change the attributes is read with those of its head.
    before.insert(b"b/kept.rs".to_vec(), (FILE, b"same\n".to_vec()));
    let mut attributed = before.clone();
    attributed.insert(b".gitattributes".to_vec(), (FILE, b"*.rs -diff\n".to_vec()));
    attributed.insert(b"b/kept.rs".to_vec(), (FILE, b"edited\n".to_vec()));
    assert_eq!(
        summary(&fixture.files(&fixture.range(&before, &attributed))),
        ["M .gitattributes +1 -1", "M b/kept.rs bin"]
    );
}

#[test]
fn a_huge_file_keeps_the_patches_after_it_until_the_limit() {
    let fixture = Fixture::new();
    let large = |lines: usize| "0123456789abcde\n".repeat(lines).into_bytes();
    let just_over = large(70_000);
    let half = large(30_000);
    let mut after = tree(&[
        ("a", FILE, b"first\n"),
        ("b huge", FILE, &just_over),
        ("b one line", FILE, &vec![b'x'; 3 * 1024 * 1024]),
        ("c", FILE, b"after\n"),
    ]);
    let before = tree(&[("kept", FILE, b"kept\n")]);
    after.extend(before.clone());
    let filling = RANGE_PATCH_LIMIT / half.len() + 2;
    for n in 0..filling {
        after.insert(format!("d {n:02}").into_bytes(), (FILE, half.clone()));
    }
    after.insert(b"e".to_vec(), (FILE, b"past the limit\n".to_vec()));
    let range = fixture.range(&before, &after);
    let patches = fixture.patches(&range);
    assert_eq!(patches.len(), filling + 5);
    let (added, huge, one_line, small) = (&patches[0], &patches[1], &patches[2], &patches[3]);
    assert!(matches!(added.1, Some(FilePatch::Text { .. })));
    assert!(matches!(huge.1, Some(FilePatch::TooLarge { bytes }) if bytes > 1024 * 1024));
    assert!(matches!(one_line.1, Some(FilePatch::TooLarge { bytes }) if bytes > 3 * 1024 * 1024));
    assert!(matches!(&small.1, Some(FilePatch::Text { patch, .. }) if patch.ends_with("+after\n")));
    for (path, patch) in &patches[..4] {
        assert_eq!(fixture.one(&range, path, path).ok(), *patch);
        assert_eq!(
            file_patch(fixture.path(), &between(&range), path).ok(),
            *patch
        );
    }
    let read = patches.iter().take_while(|(_, patch)| patch.is_some());
    let bytes: usize = read
        .clone()
        .map(|(_, patch)| match patch {
            Some(FilePatch::Text { patch, .. }) => patch.len(),
            _ => 0,
        })
        .sum();
    assert!(bytes <= RANGE_PATCH_LIMIT && bytes + half.len() + 1024 * 64 > RANGE_PATCH_LIMIT);
    let count = read.count();
    assert!(patches[count..].iter().all(|(_, patch)| patch.is_none()));
    assert_eq!(patches.last().unwrap().0, "e");
    assert!(matches!(
        fixture.one(&range, "e", "e"),
        Ok(FilePatch::Text { .. })
    ));
}

fn between((base, head): &(Oid, Oid)) -> Comparison {
    Comparison::between(base.as_str(), head.as_str())
}

#[test]
fn names_missing_commits_and_histories_without_a_merge_base() {
    let fixture = Fixture::new();
    let one = tree(&[("f", FILE, b"one\n")]);
    let two = tree(&[("f", FILE, b"two\n")]);
    let base = fixture.commit(&one, &[]);
    let fork = fixture.commit(&two, &[&base]);
    let ahead = fixture.commit(&one, &[&fork]);
    let head = fixture.commit(&tree(&[("f", FILE, b"2\n")]), &[&fork]);
    let alone = fixture.commit(&two, &[]);
    let blob = oid(&fixture.git(&["rev-parse", &format!("{}:f", base.as_str())]));
    let absent = oid(&"3".repeat(40));
    let long = oid(&"4".repeat(64));
    let files = |base: &Oid, head: &Oid| range_files(fixture.path(), base, head).unwrap();
    for (left, right, oids) in [
        (&absent, &head, vec![absent.clone()]),
        (&base, &absent, vec![absent.clone()]),
        (&absent, &absent, vec![absent.clone()]),
        (&absent, &long, vec![absent.clone(), long.clone()]),
        (&blob, &head, vec![blob.clone()]),
    ] {
        assert_eq!(files(left, right), RangeFiles::Missing { oids });
    }
    assert_eq!(
        files(&alone, &head),
        RangeFiles::Unrelated { shallow: false }
    );
    assert!(matches!(
        files(&ahead, &head),
        RangeFiles::Ready { merge_base, .. } if merge_base == fork
    ));
    assert_eq!(
        range_patches(fixture.path(), &absent, &head)
            .unwrap_err()
            .kind,
        ErrorKind::InvalidOid
    );

    fixture.git(&["update-ref", "refs/heads/main", ahead.as_str()]);
    fixture.git(&["update-ref", "refs/heads/topic", head.as_str()]);
    let clone = clone(&fixture, &["--depth=1", "--no-single-branch"]);
    assert_eq!(
        range_files(&clone, &ahead, &head).unwrap(),
        RangeFiles::Unrelated { shallow: true }
    );
}

fn clone(fixture: &Fixture, options: &[&str]) -> String {
    fixture.git(&["config", "uploadpack.allowFilter", "true"]);
    let source = url::Url::from_file_path(fixture.repo.canonicalize().unwrap()).unwrap();
    let path = fixture.directory.path().join("clone");
    let mut args = vec!["clone", "--quiet", "--no-checkout"];
    args.extend(options);
    args.extend([source.as_str(), path.to_str().unwrap()]);
    git(fixture.directory.path(), &args, b"");
    path.to_str().unwrap().to_owned()
}

#[test]
fn a_partial_clone_without_contents_still_lists_the_files() {
    let fixture = Fixture::new();
    let range = fixture.range(
        &tree(&[
            (".gitattributes", FILE, b"*.txt text\n"),
            ("edited", FILE, b"one\n"),
            ("moved", FILE, b"moved\n"),
            ("moved and edited", FILE, &lines(0..30)),
        ]),
        &tree(&[
            (".gitattributes", FILE, b"*.txt text\n"),
            ("edited", FILE, b"two\n"),
            ("elsewhere", FILE, b"moved\n"),
            ("rewritten", FILE, &lines(0..31)),
        ]),
    );
    let (base, head) = &range;
    fixture.git(&["update-ref", "refs/heads/main", head.as_str()]);
    let clone = clone(&fixture, &["--filter=blob:none"]);
    let objects = || git(Path::new(&clone), &["count-objects", "-v"], b"");
    let before = objects();
    let RangeFiles::Ready {
        files,
        content_missing: true,
        ..
    } = range_files(&clone, base, head).unwrap()
    else {
        panic!("a list without counts");
    };
    assert_eq!(
        summary(&files),
        [
            "M edited bin",
            "R elsewhere < moved 100 bin",
            "D moved and edited bin",
            "A rewritten bin",
        ]
    );
    let patches = range_patches(&clone, base, head).unwrap();
    assert_eq!(
        patches
            .iter()
            .map(|read| (read.path.as_str(), &read.patch))
            .collect::<Vec<_>>(),
        files
            .iter()
            .map(|file| (file.path.as_str(), &None))
            .collect::<Vec<_>>()
    );
    let one = fixture.read(serde_json::json!({
        "op": "filePatch",
        "path": clone,
        "comparison": between(&range),
        "file": "edited",
        "from": "edited",
    }));
    assert!(matches!(one, Err(ErrorKind::GitFailed)), "{one:?}");
    assert_eq!(objects(), before);
}

#[test]
fn requests_take_only_full_object_ids() {
    let request = |json: serde_json::Value| serde_json::from_value::<Request>(json).is_ok();
    let oid = "a".repeat(40);
    assert!(request(
        serde_json::json!({"op": "rangeFiles", "path": "/r", "base": oid, "head": oid})
    ));
    assert!(request(
        serde_json::json!({"op": "rangePatches", "path": "/r", "mergeBase": oid, "head": oid})
    ));
    for bad in ["HEAD", "--all", "abc", &"A".repeat(40)] {
        assert!(!request(
            serde_json::json!({"op": "rangeFiles", "path": "/r", "base": oid, "head": bad})
        ));
        assert!(!request(
            serde_json::json!({"op": "rangePatches", "path": "/r", "mergeBase": bad, "head": oid})
        ));
    }
}

/// A small linear congruential generator, so a seed names a repository.
struct Random(u64);

impl Random {
    fn below(&mut self, bound: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as usize) % bound
    }

    fn pick<T: Copy>(&mut self, from: &[T]) -> T {
        from[self.below(from.len())]
    }

    fn path(&mut self) -> Vec<u8> {
        let parts = [
            "a", "b c", "d\te", "f\"g", "h\\i", "j\nk", "\u{e9}", "e\u{301}", "-x", "*",
        ];
        let folder = self.pick(&["", "", "src/", "src/deep/", "b/"]);
        format!("{folder}{}{}", self.pick(&parts), self.below(30)).into_bytes()
    }

    fn contents(&mut self) -> Vec<u8> {
        let end = self.pick(&["\n", "\r\n", "\n"]);
        let mut text: Vec<u8> = (0..self.below(40))
            .flat_map(|_| {
                let word = [
                    "",
                    "diff --git a/x b/x",
                    "@@ -1 +1 @@",
                    "--- a/x",
                    "Binary files a",
                    "one",
                ];
                format!("{}{}{end}", self.pick(&word), self.below(4)).into_bytes()
            })
            .collect();
        match self.below(8) {
            0 => drop(text.pop()),
            1 => text.push(0),
            2 => text.push(0xff),
            _ => {}
        }
        text
    }

    fn entry(&mut self) -> (&'static str, Vec<u8>) {
        match self.below(12) {
            0 => (SYMLINK, b"target".to_vec()),
            1 => (SUBMODULE, self.pick(&[PINNED, MOVED]).as_bytes().to_vec()),
            2 | 3 => (EXECUTABLE, self.contents()),
            _ => (FILE, self.contents()),
        }
    }

    fn changed(&mut self, before: &Tree) -> Tree {
        let mut after = before.clone();
        for path in before.keys() {
            let Some(entry) = after.get(path).cloned() else {
                continue;
            };
            match self.below(8) {
                0 => drop(after.remove(path)),
                1 | 2 => drop(after.insert(path.clone(), self.entry())),
                3 | 4 => {
                    after.remove(path);
                    let (mode, mut contents) = entry;
                    if mode == FILE && self.below(2) == 0 {
                        contents.extend(b"appended\n");
                    }
                    let path = self.path();
                    after.insert(path, (mode, contents));
                }
                5 => {
                    let mode = if entry.0 == FILE { EXECUTABLE } else { FILE };
                    after.insert(path.clone(), (mode, entry.1));
                }
                _ => {}
            }
        }
        for _ in 0..self.below(6) {
            let path = self.path();
            let entry = self.entry();
            after.insert(path, entry);
        }
        after
    }
}

/// Git refuses a tree that holds a path both as a file and as a folder.
fn without_collisions(tree: Tree) -> Tree {
    let folders: Vec<Vec<u8>> = tree
        .keys()
        .filter_map(|path| Some(path[..path.iter().rposition(|byte| *byte == b'/')?].to_vec()))
        .collect();
    tree.into_iter()
        .filter(|(path, _)| !folders.contains(path))
        .collect()
}

#[test]
fn generated_ranges_read_the_same_together_and_alone() {
    let fixture = Fixture::new();
    for seed in 0..6 {
        let mut random = Random(seed);
        let before: Tree = (0..25).map(|_| (random.path(), random.entry())).collect();
        let before = without_collisions(before);
        let after = without_collisions(random.changed(&before));
        let range = fixture.range(&before, &after);
        let files = fixture.files(&range);
        let patches = fixture.patches(&range);
        assert_eq!(files.len(), patches.len(), "seed {seed}");
        let (base, head) = &range;
        let mut whole = Vec::new();
        for (file, (path, patch)) in files.iter().zip(&patches) {
            let context = format!("seed {seed}, {path:?}");
            assert_eq!(&file.path, path, "{context}");
            let patch = patch.as_ref().unwrap();
            let from = file.from.as_deref().unwrap_or(path);
            assert_eq!(
                fixture.one(&range, from, path).as_ref(),
                Ok(patch),
                "{context}"
            );
            match patch {
                FilePatch::Text { patch, lossy } => {
                    let count = |sign| {
                        let mut in_hunk = false;
                        let mut count = 0;
                        for line in patch.split_inclusive('\n') {
                            in_hunk = line.starts_with("@@ ")
                                || in_hunk && !line.starts_with("diff --git ");
                            count += u64::from(in_hunk && line.starts_with(sign));
                        }
                        count
                    };
                    let binary = file.added.is_none();
                    if file.status != RangeStatus::TypeChanged && !binary {
                        assert_eq!(
                            (file.added, file.deleted),
                            (Some(count('+')), Some(count('-'))),
                            "{context}"
                        );
                    }
                    if !binary && file.from.is_none() && !path.contains('\u{301}') {
                        assert_eq!(
                            file_patch(fixture.path(), &between(&range), path).unwrap(),
                            *patch_of(patch, *lossy),
                            "{context}"
                        );
                    }
                    whole.push(patch.clone());
                }
                FilePatch::Binary => assert_eq!(file.added, None, "{context}"),
                FilePatch::TooLarge { .. } => panic!("{context}"),
            }
        }
        let printed = git(
            &fixture.repo,
            &[
                "-c",
                "core.quotePath=false",
                &format!("--attr-source={}", head.as_str()),
                "diff-tree",
                "-r",
                "-p",
                "-M",
                base.as_str(),
                head.as_str(),
            ],
            b"",
        );
        let printed = String::from_utf8_lossy(&printed);
        let blocks: usize = files
            .iter()
            .map(|file| 1 + usize::from(file.status == RangeStatus::TypeChanged))
            .sum();
        assert_eq!(
            printed
                .split_inclusive('\n')
                .filter(|line| line.starts_with("diff --git "))
                .count(),
            blocks,
            "seed {seed}"
        );
        for patch in whole {
            assert!(printed.contains(&patch), "seed {seed}");
        }
    }
}

fn patch_of(patch: &str, lossy: bool) -> Box<FilePatch> {
    Box::new(FilePatch::Text {
        patch: patch.to_owned(),
        lossy,
    })
}
