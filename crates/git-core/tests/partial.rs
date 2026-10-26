#![cfg(unix)]

use l1_git_core::{
    Applied, Coordinator, ErrorKind, Expect, FilePatch, Limits, LinePick, LineSide, Operation,
    RepositoryError, Side, WorktreePatch, worktree_patch, worktree_status,
};
use std::{
    fs,
    io::Write as _,
    num::NonZeroU32,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

fn git_output(path: &Path, args: &[&str], input: &[u8]) -> Output {
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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

fn git(path: &Path, args: &[&str]) -> Vec<u8> {
    let output = git_output(path, args, b"");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

struct Repo {
    directory: TempDir,
    root: PathBuf,
}

impl Repo {
    fn new(files: &[(&str, &[u8])], config: &[(&str, &str)]) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir(&root).unwrap();
        let repo = Self { directory, root };
        repo.git(&["init", "--quiet", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Ada"),
            ("user.email", "ada@example.test"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", "/dev/null"),
        ]
        .iter()
        .chain(config)
        {
            repo.git(&["config", key, value]);
        }
        for (file, contents) in files {
            repo.write(file, contents);
        }
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "base"]);
        repo
    }

    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn git(&self, args: &[&str]) -> Vec<u8> {
        git(&self.root, args)
    }

    fn write(&self, file: &str, contents: impl AsRef<[u8]>) {
        fs::write(self.root.join(file), contents).unwrap();
    }

    fn index_blob(&self, file: &str) -> Option<Vec<u8>> {
        let output = git_output(&self.root, &["show", &format!(":{file}")], b"");
        output.status.success().then_some(output.stdout)
    }

    fn index_mode(&self, file: &str) -> String {
        let listed = String::from_utf8(self.git(&["ls-files", "-s", "--", file])).unwrap();
        listed.split(' ').next().unwrap().to_owned()
    }

    fn worktree(&self, file: &str) -> Option<Vec<u8>> {
        fs::read(self.root.join(file)).ok()
    }

    fn shown(&self, file: &str, side: Side) -> String {
        match worktree_patch(self.path(), file, side).unwrap() {
            WorktreePatch::Diff {
                diff: FilePatch::Text { patch, .. },
            } => patch,
            other => panic!("{file} shows no text: {other:?}"),
        }
    }

    fn run(&self, operation: &Operation) -> Result<Applied, RepositoryError> {
        let head = worktree_status(self.path()).unwrap().head;
        Coordinator::new(Limits::default(), self.directory.path().join("undo")).write(
            self.path(),
            operation,
            &Expect { head },
        )
    }

    fn stage_hunk(&self, file: &str, hunk: u32) -> Result<Applied, RepositoryError> {
        let shown = self.shown(file, Side::Unstaged);
        self.run(&Operation::StageHunk {
            path: file.to_owned(),
            hunk,
            shown,
        })
    }

    fn unstage_hunk(&self, file: &str, hunk: u32) -> Result<Applied, RepositoryError> {
        let shown = self.shown(file, Side::Staged);
        self.run(&Operation::UnstageHunk {
            path: file.to_owned(),
            hunk,
            shown,
        })
    }

    fn stage_lines(&self, file: &str, lines: &[LinePick]) -> Result<Applied, RepositoryError> {
        let shown = self.shown(file, Side::Unstaged);
        self.run(&Operation::StageLines {
            path: file.to_owned(),
            lines: lines.to_vec(),
            shown,
        })
    }

    fn unstage_lines(&self, file: &str, lines: &[LinePick]) -> Result<Applied, RepositoryError> {
        let shown = self.shown(file, Side::Staged);
        self.run(&Operation::UnstageLines {
            path: file.to_owned(),
            lines: lines.to_vec(),
            shown,
        })
    }

    fn discard_hunk(&self, file: &str, hunk: u32) -> Result<Applied, RepositoryError> {
        let shown = self.shown(file, Side::Unstaged);
        self.run(&Operation::DiscardHunk {
            path: file.to_owned(),
            hunk,
            shown,
        })
    }

    fn discard_lines(&self, file: &str, lines: &[LinePick]) -> Result<Applied, RepositoryError> {
        let shown = self.shown(file, Side::Unstaged);
        self.run(&Operation::DiscardLines {
            path: file.to_owned(),
            lines: lines.to_vec(),
            shown,
        })
    }

    fn interactive(&self, args: &[&str], answers: &str) {
        let mut all = vec!["-c", "interactive.singleKey=false"];
        all.extend(args);
        let output = git_output(&self.root, &all, answers.as_bytes());
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn d(line: u32) -> LinePick {
    LinePick {
        side: LineSide::Deletions,
        line: NonZeroU32::new(line).unwrap(),
    }
}

fn a(line: u32) -> LinePick {
    LinePick {
        side: LineSide::Additions,
        line: NonZeroU32::new(line).unwrap(),
    }
}

fn lines(count: usize) -> String {
    (1..=count).map(|line| format!("line {line}\n")).collect()
}

fn edit(text: &str, at: &[(usize, Option<&str>)], after: &[(usize, &str)]) -> String {
    let mut out = String::new();
    for (line, old) in (1..).zip(text.split_inclusive('\n')) {
        match at.iter().find(|(number, _)| *number == line) {
            Some((_, Some(new))) => out.push_str(new),
            Some((_, None)) => {}
            None => out.push_str(old),
        }
        if let Some((_, inserted)) = after.iter().find(|(number, _)| *number == line) {
            out.push_str(inserted);
        }
    }
    out
}

fn three() -> String {
    edit(
        &lines(30),
        &[
            (3, Some("line 3 changed\n")),
            (15, Some("line 15 changed\n")),
            (27, Some("line 27 changed\n")),
        ],
        &[],
    )
}

fn bytes(text: &str) -> Option<Vec<u8>> {
    Some(text.as_bytes().to_vec())
}

fn refused(result: Result<Applied, RepositoryError>, kind: &ErrorKind) {
    let error = result.expect_err("the write should refuse");
    assert_eq!(&error.kind, kind, "{}", error.message);
}

fn bare_apply(repo: &Repo, args: &[&str], patch: &[u8]) -> Output {
    git_output(&repo.root, args, patch)
}

fn middle_stage() -> Repo {
    let repo = Repo::new(&[("f.txt", lines(30).as_bytes())], &[]);
    repo.write("f.txt", three());
    repo
}

#[test]
fn middle_hunk_stage_hunk_2_of_3_matches_git_add_p() {
    let repo = middle_stage();
    repo.stage_hunk("f.txt", 1).unwrap();
    let oracle = middle_stage();
    oracle.interactive(&["add", "-p", "f.txt"], "n\ny\nn\n");
    assert_eq!(repo.index_blob("f.txt"), oracle.index_blob("f.txt"));
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(&lines(30), &[(15, Some("line 15 changed\n"))], &[]))
    );
}

#[test]
fn middle_hunk_worktree_untouched_by_stage() {
    let repo = middle_stage();
    repo.stage_hunk("f.txt", 1).unwrap();
    assert_eq!(repo.worktree("f.txt"), bytes(&three()));
}

fn middle_unstage() -> Repo {
    let repo = middle_stage();
    repo.git(&["add", "f.txt"]);
    repo
}

#[test]
fn middle_hunk_unstage_hunk_2_of_3_matches_git_reset_p() {
    let repo = middle_unstage();
    repo.unstage_hunk("f.txt", 1).unwrap();
    let oracle = middle_unstage();
    oracle.interactive(&["reset", "-p", "--", "f.txt"], "n\ny\nn\n");
    assert_eq!(repo.index_blob("f.txt"), oracle.index_blob("f.txt"));
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(
            &lines(30),
            &[
                (3, Some("line 3 changed\n")),
                (27, Some("line 27 changed\n"))
            ],
            &[]
        ))
    );
}

#[test]
fn middle_hunk_discard_hunk_2_of_3_matches_git_checkout_p() {
    let repo = middle_stage();
    repo.discard_hunk("f.txt", 1).unwrap();
    let oracle = middle_stage();
    oracle.interactive(&["checkout", "-p", "--", "f.txt"], "n\ny\nn\n");
    assert_eq!(repo.worktree("f.txt"), oracle.worktree("f.txt"));
    assert_eq!(
        repo.worktree("f.txt"),
        bytes(&edit(
            &lines(30),
            &[
                (3, Some("line 3 changed\n")),
                (27, Some("line 27 changed\n"))
            ],
            &[]
        ))
    );
}

#[test]
fn later_hunk_after_a_line_count_changing_hunk_unstage_hunk_3() {
    let inserted = "inserted A\ninserted B\ninserted C\n";
    let repo = Repo::new(&[("f.txt", lines(30).as_bytes())], &[]);
    repo.write(
        "f.txt",
        edit(
            &lines(30),
            &[
                (15, Some("line 15 changed\n")),
                (27, Some("line 27 changed\n")),
            ],
            &[(2, inserted)],
        ),
    );
    repo.git(&["add", "f.txt"]);
    repo.unstage_hunk("f.txt", 2).unwrap();
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(
            &lines(30),
            &[(15, Some("line 15 changed\n"))],
            &[(2, inserted)]
        ))
    );
}

fn p_new() -> String {
    edit(
        &lines(12),
        &[(5, Some("five NEW\n")), (6, Some("six NEW\n")), (7, None)],
        &[(7, "seven-and-a-half NEW\n")],
    )
}

fn partial() -> Repo {
    let repo = Repo::new(&[("f.txt", lines(12).as_bytes())], &[]);
    repo.write("f.txt", p_new());
    repo
}

#[test]
fn partial_lines_paired_order_stage_minus_5_minus_7_plus_5_unpicked_minus_become_context_unpicked_plus_dropped()
 {
    let repo = partial();
    repo.stage_lines("f.txt", &[d(5), d(7), a(5)]).unwrap();
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(
            &lines(12),
            &[(5, Some("five NEW\n")), (7, None)],
            &[]
        ))
    );
}

#[test]
fn partial_lines_gits_grouped_order_staging_the_minus_5_plus_5_row_lands_five_new_after_line_7_not_in_place()
 {
    let repo = partial();
    let grouped = concat!(
        "diff --git a/f.txt b/f.txt\n",
        "--- a/f.txt\n",
        "+++ b/f.txt\n",
        "@@ -2,9 +2,9 @@\n",
        " line 2\n line 3\n line 4\n-line 5\n line 6\n line 7\n+five NEW\n line 8\n line 9\n line 10\n",
    );
    let applied = bare_apply(
        &repo,
        &["apply", "--cached", "--whitespace=nowarn", "-"],
        grouped.as_bytes(),
    );
    assert!(applied.status.success());
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(&lines(12), &[(5, None)], &[(7, "five NEW\n")]))
    );
}

#[test]
fn partial_lines_paired_order_staging_the_minus_5_plus_5_row_replaces_line_5_in_place() {
    let repo = partial();
    repo.stage_lines("f.txt", &[d(5), a(5)]).unwrap();
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(&lines(12), &[(5, Some("five NEW\n"))], &[]))
    );
}

#[test]
fn partial_lines_unstage_minus_6_plus_6_plus_7_unpicked_plus_become_context_unpicked_minus_dropped()
{
    let repo = partial();
    repo.git(&["add", "f.txt"]);
    repo.unstage_lines("f.txt", &[d(6), a(6), a(7)]).unwrap();
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(
            &lines(12),
            &[(5, Some("five NEW\n")), (7, None)],
            &[]
        ))
    );
}

#[test]
fn partial_lines_discard_minus_5_plus_5_pair_only() {
    let repo = partial();
    repo.discard_lines("f.txt", &[d(5), a(5)]).unwrap();
    assert_eq!(
        repo.worktree("f.txt"),
        bytes(&edit(
            &lines(12),
            &[(6, Some("six NEW\n")), (7, None)],
            &[(7, "seven-and-a-half NEW\n")]
        ))
    );
}

#[test]
fn partial_lines_across_three_hunks_shifted_starts() {
    let repo = Repo::new(&[("f.txt", lines(30).as_bytes())], &[]);
    repo.write(
        "f.txt",
        edit(
            &lines(30),
            &[(3, None), (4, None), (27, Some("x\n"))],
            &[(15, "added 15a\nadded 15b\n")],
        ),
    );
    repo.stage_lines("f.txt", &[d(4), a(15), a(27)]).unwrap();
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(
            &lines(30),
            &[(4, None)],
            &[(15, "added 15b\n"), (27, "x\n")]
        ))
    );
}

#[test]
fn no_eof_newline_stage_only_the_last_line_change() {
    let repo = Repo::new(&[("f.txt", b"a\nb\nc")], &[]);
    repo.write("f.txt", "a\nB\nC");
    repo.stage_lines("f.txt", &[d(3), a(3)]).unwrap();
    assert_eq!(repo.index_blob("f.txt"), bytes("a\nb\nC"));
}

#[test]
fn no_eof_newline_stage_the_newline_only_change() {
    let repo = Repo::new(&[("f.txt", b"a\nb\nc")], &[]);
    repo.write("f.txt", "a\nb\nc\n");
    repo.stage_hunk("f.txt", 0).unwrap();
    assert_eq!(repo.index_blob("f.txt"), bytes("a\nb\nc\n"));
}

fn appended() -> Repo {
    let repo = Repo::new(&[("f.txt", b"a\nb\nc")], &[]);
    repo.write("f.txt", "a\nb\nc\nd\n");
    repo
}

#[test]
fn no_eof_newline_no_guard_git_apply_accepts_context_without_newline_followed_by_plus_d_and_corrupts_the_line()
 {
    let repo = appended();
    let unguarded = concat!(
        "diff --git a/f.txt b/f.txt\n",
        "--- a/f.txt\n",
        "+++ b/f.txt\n",
        "@@ -1,3 +1,4 @@\n",
        " a\n b\n c\n\\ No newline at end of file\n+d\n",
    );
    let applied = bare_apply(
        &repo,
        &["apply", "--cached", "--whitespace=nowarn", "-"],
        unguarded.as_bytes(),
    );
    assert!(applied.status.success());
    assert_eq!(repo.index_blob("f.txt"), bytes("a\nb\ncd\n"));
}

#[test]
fn no_eof_newline_builder_refuses_picking_the_appended_line_without_its_newline_fix() {
    let repo = appended();
    let error = repo.stage_lines("f.txt", &[a(4)]).unwrap_err();
    assert_eq!(error.kind, ErrorKind::UnsupportedPath);
    assert_eq!(
        error.message,
        "L1 Git cannot stage only these lines of f.txt, because line 3 of the old file has no newline at its end and a chosen line would follow it. Include the change to that line, or stage the whole file."
    );
    assert_eq!(repo.index_blob("f.txt"), bytes("a\nb\nc"));
}

#[test]
fn no_eof_newline_pick_appended_line_plus_the_minus_c_plus_c_newline_pair() {
    let repo = appended();
    repo.stage_lines("f.txt", &[d(3), a(3), a(4)]).unwrap();
    assert_eq!(repo.index_blob("f.txt"), bytes("a\nb\nc\nd\n"));
}

#[test]
fn no_eof_newline_both_sides_unstage_first_line_change_keep_eof_change() {
    let repo = Repo::new(&[("f.txt", b"a\nb\nc")], &[]);
    repo.write("f.txt", "A\nb\nc\nd");
    repo.git(&["add", "f.txt"]);
    repo.unstage_lines("f.txt", &[d(1), a(1)]).unwrap();
    assert_eq!(repo.index_blob("f.txt"), bytes("a\nb\nc\nd"));
}

fn blank_context() -> Repo {
    let repo = Repo::new(
        &[("f.txt", b"a\n\nb\nc\n")],
        &[("diff.suppressBlankEmpty", "true")],
    );
    repo.write("f.txt", "A\n\nB\nc\n");
    assert!(
        repo.shown("f.txt", Side::Unstaged).contains("+A\n\n-b\n"),
        "Git prints the blank context line as an empty line"
    );
    repo
}

#[test]
fn suppress_blank_empty_stage_lines_keeps_the_empty_context_line() {
    let repo = blank_context();
    repo.stage_lines("f.txt", &[d(1), a(1)]).unwrap();
    assert_eq!(repo.index_blob("f.txt"), bytes("A\n\nb\nc\n"));
}

#[test]
fn suppress_blank_empty_stage_hunk() {
    let repo = blank_context();
    repo.stage_hunk("f.txt", 0).unwrap();
    assert_eq!(repo.index_blob("f.txt"), bytes("A\n\nB\nc\n"));
}

#[test]
fn suppress_blank_empty_discard_hunk() {
    let repo = blank_context();
    repo.discard_hunk("f.txt", 0).unwrap();
    assert_eq!(repo.worktree("f.txt"), bytes("a\n\nb\nc\n"));
}

fn crlf() -> String {
    lines(30).replace('\n', "\r\n")
}

fn crlf_new() -> String {
    edit(
        &crlf(),
        &[
            (3, Some("line 3 changed\r\n")),
            (15, Some("line 15 changed\r\n")),
            (27, Some("line 27 changed\r\n")),
        ],
        &[],
    )
}

fn crlf_raw() -> Repo {
    let repo = Repo::new(
        &[("f.txt", crlf().as_bytes())],
        &[("core.autocrlf", "false")],
    );
    repo.write("f.txt", crlf_new());
    repo.stage_hunk("f.txt", 1).unwrap();
    repo
}

#[test]
fn crlf_stored_as_is_stage_middle_hunk() {
    let repo = crlf_raw();
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(&crlf(), &[(15, Some("line 15 changed\r\n"))], &[]))
    );
}

#[test]
fn crlf_stored_as_is_discard_first_hunk_in_worktree() {
    let repo = crlf_raw();
    repo.discard_hunk("f.txt", 0).unwrap();
    assert_eq!(
        repo.worktree("f.txt"),
        bytes(&edit(
            &crlf(),
            &[
                (15, Some("line 15 changed\r\n")),
                (27, Some("line 27 changed\r\n"))
            ],
            &[]
        ))
    );
}

fn crlf_attribute() -> Repo {
    let repo = Repo::new(
        &[
            (".gitattributes", b"*.txt text eol=crlf\n"),
            ("f.txt", lines(30).as_bytes()),
        ],
        &[],
    );
    fs::remove_file(repo.root.join("f.txt")).unwrap();
    repo.git(&["checkout", "--", "f.txt"]);
    assert!(repo.worktree("f.txt").unwrap().starts_with(b"line 1\r\n"));
    repo.write("f.txt", crlf_new());
    repo.stage_hunk("f.txt", 1).unwrap();
    repo
}

#[test]
fn eol_crlf_attribute_lf_in_index_crlf_on_disk_stage_middle_hunk() {
    let repo = crlf_attribute();
    assert_eq!(
        repo.index_blob("f.txt"),
        bytes(&edit(&lines(30), &[(15, Some("line 15 changed\n"))], &[]))
    );
}

#[test]
fn eol_crlf_attribute_discard_first_hunk_applies_lf_patch_to_crlf_worktree() {
    let repo = crlf_attribute();
    repo.discard_hunk("f.txt", 0).unwrap();
    assert_eq!(
        repo.worktree("f.txt"),
        bytes(&edit(
            &crlf(),
            &[
                (15, Some("line 15 changed\r\n")),
                (27, Some("line 27 changed\r\n"))
            ],
            &[]
        ))
    );
}

const NEWFILE: &str = "one\ntwo\nthree\nfour\n";

fn untracked() -> Repo {
    let repo = Repo::new(&[("keep.txt", b"k\n")], &[]);
    repo.write("n.txt", NEWFILE);
    repo
}

#[test]
fn untracked_stage_whole_hunk_via_creation_patch() {
    let repo = untracked();
    repo.stage_hunk("n.txt", 0).unwrap();
    assert_eq!(repo.index_blob("n.txt"), bytes(NEWFILE));
}

#[test]
fn untracked_stage_lines_1_and_3_creation_patch_stale_index_oid_kept() {
    let repo = untracked();
    repo.stage_lines("n.txt", &[a(1), a(3)]).unwrap();
    assert_eq!(repo.index_blob("n.txt"), bytes("one\nthree\n"));
}

#[test]
fn untracked_index_mode_after_partial_creation() {
    let repo = untracked();
    repo.stage_lines("n.txt", &[a(1), a(3)]).unwrap();
    assert_eq!(repo.index_mode("n.txt"), "100644");
}

#[test]
fn intent_to_add_stage_line_2_via_diff_files_patch() {
    let repo = untracked();
    repo.git(&["add", "-N", "n.txt"]);
    repo.stage_lines("n.txt", &[a(2)]).unwrap();
    assert_eq!(repo.index_blob("n.txt"), bytes("two\n"));
}

#[test]
fn untracked_discard_line_2_creation_becomes_modification() {
    let repo = untracked();
    repo.discard_lines("n.txt", &[a(2)]).unwrap();
    assert_eq!(repo.worktree("n.txt"), bytes("one\nthree\nfour\n"));
}

#[test]
fn untracked_still_untracked_after_partial_discard() {
    let repo = untracked();
    repo.discard_lines("n.txt", &[a(2)]).unwrap();
    assert_eq!(repo.index_blob("n.txt"), None);
}

#[test]
fn untracked_discard_the_only_hunk_deletes_the_file() {
    let repo = untracked();
    repo.discard_hunk("n.txt", 0).unwrap();
    assert_eq!(repo.worktree("n.txt"), None);
}

fn staged_new() -> Repo {
    let repo = untracked();
    repo.git(&["add", "n.txt"]);
    repo.unstage_lines("n.txt", &[a(4)]).unwrap();
    repo
}

#[test]
fn staged_new_file_unstage_line_4_creation_becomes_modification() {
    let repo = staged_new();
    assert_eq!(repo.index_blob("n.txt"), bytes("one\ntwo\nthree\n"));
}

#[test]
fn staged_new_file_unstage_the_rest_removes_the_index_entry() {
    let repo = staged_new();
    repo.unstage_hunk("n.txt", 0).unwrap();
    assert_eq!(repo.index_blob("n.txt"), None);
}

#[test]
fn staged_new_file_worktree_file_survives_unstage() {
    let repo = staged_new();
    repo.unstage_hunk("n.txt", 0).unwrap();
    assert_eq!(repo.worktree("n.txt"), bytes(NEWFILE));
}

const DELFILE: &str = "d1\nd2\nd3\nd4\n";

fn deleted() -> Repo {
    let repo = Repo::new(&[("g.txt", DELFILE.as_bytes())], &[]);
    fs::remove_file(repo.root.join("g.txt")).unwrap();
    repo
}

#[test]
fn deleted_stage_removal_of_lines_2_3_deletion_becomes_modification() {
    let repo = deleted();
    repo.stage_lines("g.txt", &[d(2), d(3)]).unwrap();
    assert_eq!(repo.index_blob("g.txt"), bytes("d1\nd4\n"));
}

#[test]
fn deleted_stage_the_remaining_hunk_removes_the_index_entry() {
    let repo = deleted();
    repo.stage_lines("g.txt", &[d(2), d(3)]).unwrap();
    repo.stage_hunk("g.txt", 0).unwrap();
    assert_eq!(repo.index_blob("g.txt"), None);
}

#[test]
fn deleted_discard_deletion_of_lines_1_and_4_recreates_file_with_those_lines() {
    let repo = deleted();
    repo.discard_lines("g.txt", &[d(1), d(4)]).unwrap();
    assert_eq!(repo.worktree("g.txt"), bytes("d1\nd4\n"));
}

#[test]
fn staged_deletion_unstage_line_2_brings_back_a_one_line_index_entry() {
    let repo = Repo::new(&[("g.txt", DELFILE.as_bytes())], &[]);
    repo.git(&["rm", "-q", "g.txt"]);
    repo.unstage_lines("g.txt", &[d(2)]).unwrap();
    assert_eq!(repo.index_blob("g.txt"), bytes("d2\n"));
}

fn renamed() -> Repo {
    let repo = Repo::new(&[("old.txt", lines(30).as_bytes())], &[]);
    repo.git(&["mv", "old.txt", "new.txt"]);
    repo.write(
        "new.txt",
        edit(
            &lines(30),
            &[
                (2, Some("line 2 changed\n")),
                (29, Some("line 29 changed\n")),
            ],
            &[],
        ),
    );
    repo
}

fn rename_unstaged() -> Repo {
    let repo = renamed();
    repo.git(&["add", "new.txt"]);
    repo.unstage_hunk("new.txt", 1).unwrap();
    repo
}

#[test]
fn staged_rename_unstage_hunk_2_rename_stays_staged() {
    let repo = rename_unstaged();
    assert_eq!(
        repo.index_blob("new.txt"),
        bytes(&edit(&lines(30), &[(2, Some("line 2 changed\n"))], &[]))
    );
    assert_eq!(
        String::from_utf8(repo.git(&["status", "--porcelain"])).unwrap(),
        "RM old.txt -> new.txt\n"
    );
}

#[test]
fn staged_rename_old_path_still_removed_from_index() {
    let repo = rename_unstaged();
    assert_eq!(repo.index_blob("old.txt"), None);
}

#[test]
fn unstaged_edits_on_top_of_a_staged_rename_stage_hunk_2() {
    let repo = renamed();
    repo.stage_hunk("new.txt", 1).unwrap();
    assert_eq!(
        repo.index_blob("new.txt"),
        bytes(&edit(&lines(30), &[(29, Some("line 29 changed\n"))], &[]))
    );
}

fn mode_and_content() -> Repo {
    let repo = Repo::new(&[("s.sh", lines(30).as_bytes())], &[]);
    repo.write("s.sh", three());
    fs::set_permissions(repo.root.join("s.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    repo.stage_hunk("s.sh", 0).unwrap();
    repo
}

#[test]
fn mode_change_plus_edits_stage_hunk_1_without_the_mode() {
    let repo = mode_and_content();
    assert_eq!(
        repo.index_blob("s.sh"),
        bytes(&edit(&lines(30), &[(3, Some("line 3 changed\n"))], &[]))
    );
}

#[test]
fn mode_change_plus_edits_index_mode_stays_100644() {
    let repo = mode_and_content();
    assert_eq!(repo.index_mode("s.sh"), "100644");
}

fn latin() -> Repo {
    let repo = Repo::new(&[("l.txt", b"caf\xe9 1\ncaf\xe9 2\ncaf\xe9 3\n")], &[]);
    repo.write("l.txt", b"caf\xe9 1\ncaf\xe9 TWO\ncaf\xe9 3\n");
    repo
}

#[test]
fn latin_1_content_patch_built_from_raw_bytes_applies() {
    let repo = latin();
    let shown = repo.shown("l.txt", Side::Unstaged);
    assert!(shown.contains('\u{FFFD}'));
    repo.stage_hunk("l.txt", 0).unwrap();
    assert_eq!(
        repo.index_blob("l.txt").unwrap(),
        b"caf\xe9 1\ncaf\xe9 TWO\ncaf\xe9 3\n"
    );
}

#[test]
fn latin_1_content_patch_built_from_the_lossy_js_string_is_refused() {
    let repo = latin();
    let raw = repo.git(&[
        "diff-files",
        "--no-renames",
        "-z",
        "--patch",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "l.txt",
    ]);
    let lossy = String::from_utf8_lossy(&raw).into_owned();
    let applied = bare_apply(
        &repo,
        &["apply", "--cached", "--whitespace=nowarn", "-"],
        lossy.as_bytes(),
    );
    assert!(!applied.status.success());
    assert!(
        String::from_utf8_lossy(&applied.stderr).contains("patch does not apply"),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
}

fn whitespace(setting: &str) -> Repo {
    let repo = Repo::new(
        &[("w.txt", lines(5).as_bytes())],
        &[("apply.whitespace", setting)],
    );
    repo.write("w.txt", edit(&lines(5), &[(3, Some("trailing   \n"))], &[]));
    repo
}

fn unstaged_patch(repo: &Repo, file: &str) -> Vec<u8> {
    repo.git(&[
        "diff-files",
        "--no-renames",
        "--patch",
        "--full-index",
        "--",
        file,
    ])
}

#[test]
fn apply_whitespace_error_in_repo_config_bare_git_apply_refuses() {
    let repo = whitespace("error");
    let applied = bare_apply(
        &repo,
        &["apply", "--cached", "-"],
        &unstaged_patch(&repo, "w.txt"),
    );
    assert!(!applied.status.success());
    assert_eq!(repo.index_blob("w.txt"), bytes(&lines(5)));
}

#[test]
fn apply_whitespace_error_in_repo_config_whitespace_nowarn_applies() {
    let repo = whitespace("error");
    repo.stage_hunk("w.txt", 0).unwrap();
    assert_eq!(
        repo.index_blob("w.txt"),
        bytes(&edit(&lines(5), &[(3, Some("trailing   \n"))], &[]))
    );
}

#[test]
fn apply_whitespace_fix_bare_git_apply_silently_rewrites_the_staged_line() {
    let repo = whitespace("fix");
    let applied = bare_apply(
        &repo,
        &["apply", "--cached", "-"],
        &unstaged_patch(&repo, "w.txt"),
    );
    assert!(applied.status.success());
    assert_eq!(
        repo.index_blob("w.txt"),
        bytes(&edit(&lines(5), &[(3, Some("trailing\n"))], &[]))
    );
    repo.git(&["reset", "-q"]);
    repo.stage_hunk("w.txt", 0).unwrap();
    assert_eq!(
        repo.index_blob("w.txt"),
        bytes(&edit(&lines(5), &[(3, Some("trailing   \n"))], &[]))
    );
}
