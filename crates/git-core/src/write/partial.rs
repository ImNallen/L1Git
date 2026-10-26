use super::{
    discard,
    index::{self, Rows},
    txn::Txn,
};
use crate::{
    ErrorKind, Mode, MoveSide, RepositoryError, Side, StaleReason, StatusEntry, git,
    status::{self, PatchBytes, SidePatch, SideRead},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, num::NonZeroU32, path::Path};

/// One line of the patch the user saw, as `@pierre/diffs` names a selected
/// line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinePick {
    pub side: LineSide,
    /// Counted from 1: the old file's line for a deletion, the new file's for
    /// an addition.
    pub line: NonZeroU32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineSide {
    Deletions,
    Additions,
}

impl LineSide {
    const fn file(self) -> &'static str {
        match self {
            Self::Deletions => "old",
            Self::Additions => "new",
        }
    }
}

/// What to take from a patch. A pick on a context line is ignored.
#[derive(Debug, Clone, Copy)]
pub(super) enum Picks<'p> {
    /// Every change of one hunk, counted from 0.
    Hunk(u32),
    Lines(&'p [LinePick]),
}

/// `Forward` applies the picked changes to the old side. `Reverse` takes them
/// back out of the new side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Apply {
    Forward,
    Reverse,
}

impl Apply {
    /// `--whitespace=nowarn` beats `apply.whitespace`, which would refuse a
    /// shown line or strip its spaces. `--recount`, `-C`, and
    /// `--unidiff-zero` would let a hunk land away from the shown lines.
    pub(super) const fn args(self) -> &'static [&'static str] {
        match self {
            Self::Forward => &["apply", "--cached", "--whitespace=nowarn", "-"],
            Self::Reverse => &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
        }
    }

    /// The side the patch applies to. An unpicked change on it stays as
    /// context, and one on the other side is dropped.
    const fn applies_to(self) -> LineSide {
        match self {
            Self::Forward => LineSide::Deletions,
            Self::Reverse => LineSide::Additions,
        }
    }
}

/// Why a file patch cannot become a partial patch. Each is a fact about its
/// bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refusal {
    /// A second `diff --git` section, as a type change prints.
    Sections,
    /// A symbolic link or a submodule on either side.
    Mode(Mode),
    Copy,
    /// A kept line would follow, on `side`, a line that ends the file
    /// without a newline. `git apply` accepts that patch and joins the two
    /// lines into one.
    NoNewlineSuccessor {
        side: LineSide,
    },
    NoHunk {
        index: u32,
        hunks: usize,
    },
    /// No line of any hunk has this number on this side.
    NotInDiff(LinePick),
    Malformed,
}

/// The partial writes. Each reads one side of the path and applies its
/// patch one way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Stage,
    Unstage,
    Discard,
}

impl Action {
    const fn side(self) -> Side {
        match self {
            Self::Stage | Self::Discard => Side::Unstaged,
            Self::Unstage => Side::Staged,
        }
    }

    pub(super) const fn apply(self) -> Apply {
        match self {
            Self::Stage => Apply::Forward,
            Self::Unstage | Self::Discard => Apply::Reverse,
        }
    }

    pub(super) const fn verb(self) -> &'static str {
        match self {
            Self::Stage => "stage",
            Self::Unstage => "unstage",
            Self::Discard => "discard",
        }
    }
}

/// A hunk or line write as the request names it.
pub(super) struct Part<'o> {
    action: Action,
    path: &'o str,
    picks: Picks<'o>,
    /// The text of the patch the user saw.
    shown: &'o str,
}

/// What `Part::read` proved and built under the index lock.
pub(super) struct Prepared {
    /// The patch read under the lock, whose text is the shown one.
    pub(super) fresh: Vec<u8>,
    /// The picked part of `fresh`, which holds a change.
    pub(super) patch: Vec<u8>,
}

impl<'o> Part<'o> {
    /// Refuses what `status::check` refuses, a name holding NUL or U+FFFD,
    /// which Git would read as another file, and no lines.
    pub(super) fn new(
        action: Action,
        path: &'o str,
        picks: Picks<'o>,
        shown: &'o str,
    ) -> Result<Self, RepositoryError> {
        status::check(path)?;
        if path.contains(['\0', char::REPLACEMENT_CHARACTER]) {
            return Err(unsupported(format!(
                "L1 Git cannot {} part of a file whose name is not valid UTF-8.",
                action.verb()
            )));
        }
        if let Picks::Lines([]) = picks {
            return Err(RepositoryError::new(
                ErrorKind::UnchangedPath,
                "Choose at least one line.",
            ));
        }
        Ok(Self {
            action,
            path,
            picks,
            shown,
        })
    }

    pub(super) const fn action(&self) -> Action {
        self.action
    }

    pub(super) const fn path(&self) -> &'o str {
        self.path
    }

    /// Reads the path's side again through the diff pane's own read. Call it
    /// with the index lock held.
    pub(super) fn read(&self, txn: &Txn<'_>) -> Result<Prepared, RepositoryError> {
        let fresh = status::read_side(
            &txn.repo().root,
            self.path,
            self.action.side(),
            txn.deadline().reads(),
        )?;
        self.prepare(fresh)
    }

    /// A refusal describes only the patch the user is looking at, so a path
    /// that no longer lists a change or whose patch differs from `shown` is
    /// stale before the bytes are judged. A path whose patch has no text, or
    /// that this write never splits, is refused whatever was shown.
    fn prepare(&self, fresh: Option<SideRead>) -> Result<Prepared, RepositoryError> {
        let Some(SideRead { entry, patch }) = fresh else {
            return Err(changed());
        };
        let fresh = match patch {
            SidePatch::Diff(PatchBytes::Text(bytes)) => bytes,
            SidePatch::Diff(PatchBytes::Binary) => {
                return Err(self.cannot("Git shows it as a binary file"));
            }
            SidePatch::Diff(PatchBytes::TooLarge { .. }) => {
                return Err(self.cannot("its diff is too large to show"));
            }
            SidePatch::Submodule(_) => return Err(self.cannot("it is a submodule")),
            SidePatch::Conflicted { .. } => return Err(self.cannot("it has a conflict")),
        };
        self.refuse_entry(&entry)?;
        if String::from_utf8_lossy(&fresh) != self.shown {
            return Err(changed());
        }
        let patch = partial_patch(&fresh, self.picks, self.action.apply())
            .map_err(|refusal| self.refused(refusal))?
            .ok_or_else(|| {
                RepositoryError::new(
                    ErrorKind::UnchangedPath,
                    format!(
                        "The chosen lines of {} hold no change to {}.",
                        self.path,
                        self.action.verb()
                    ),
                )
            })?;
        Ok(Prepared { fresh, patch })
    }

    fn refuse_entry(&self, entry: &StatusEntry) -> Result<(), RepositoryError> {
        match entry {
            StatusEntry::Ordinary {
                submodule: Some(_), ..
            }
            | StatusEntry::Renamed {
                submodule: Some(_), ..
            } => Err(self.cannot("it is a submodule")),
            StatusEntry::Renamed {
                original,
                side: MoveSide::Unstaged { .. },
                ..
            } => Err(self.cannot(&format!(
                "Git shows it as a move from {original}, which git add -N started"
            ))),
            StatusEntry::Ordinary { .. }
            | StatusEntry::Renamed { .. }
            | StatusEntry::Unmerged { .. }
            | StatusEntry::Untracked { .. } => Ok(()),
        }
    }

    fn cannot(&self, because: &str) -> RepositoryError {
        unsupported(format!(
            "L1 Git can only {} all of {}, because {because}.",
            self.action.verb(),
            self.path
        ))
    }

    fn refused(&self, refusal: Refusal) -> RepositoryError {
        let (path, verb) = (self.path, self.action.verb());
        match refusal {
            Refusal::Sections => self.cannot("Git shows its type change as two changes"),
            Refusal::Mode(Mode::Symlink) => self.cannot("it is a symbolic link"),
            Refusal::Mode(Mode::Submodule) => self.cannot("it is a submodule"),
            Refusal::Mode(mode @ (Mode::File | Mode::Executable)) => {
                self.cannot(&format!("Git shows it with mode {}", mode.octal()))
            }
            Refusal::Copy => self.cannot("Git shows it as a copy of another file"),
            Refusal::NoNewlineSuccessor { side } => unsupported(format!(
                "L1 Git cannot {verb} only these lines of {path}, because the last line of the {} file has no newline and a chosen line would follow it. Include the change to that line, or {verb} the whole file.",
                side.file()
            )),
            Refusal::NoHunk { index, hunks } => RepositoryError::new(
                ErrorKind::UnchangedPath,
                format!(
                    "The diff of {path} has {hunks} hunks, so it has no hunk {index}, counting from 0."
                ),
            ),
            Refusal::NotInDiff(LinePick { side, line }) => RepositoryError::new(
                ErrorKind::UnchangedPath,
                format!(
                    "Line {line} of the {} file is not in the diff of {path}.",
                    side.file()
                ),
            ),
            Refusal::Malformed => git::malformed(),
        }
    }
}

/// Works out what `part`'s path holds once its picked lines are discarded,
/// in an index and object folder of its own, and checks that file out under
/// `checkout`. No Git process here reads the worktree file: the fresh patch
/// applied to the path's index entry gives exactly the bytes Git diffed, and
/// the stat taken before the read and checked again before the rename shows
/// the file still holds them. `false` when the path is left with no file.
pub(super) fn revert(
    txn: &Txn<'_>,
    rows: &Rows,
    part: &Part<'_>,
    prepared: Prepared,
    checkout: &Path,
) -> Result<bool, RepositoryError> {
    let scratch = txn.scratch_index("partial")?;
    let deadline = txn.deadline();
    let path = part.path;
    let seed: Vec<u8> = index::at(rows, path)
        .iter()
        .filter(|entry| entry.stage == 0)
        .flat_map(|entry| {
            format!("{} {} 0\t{path}\0", entry.mode.octal(), entry.oid.as_str()).into_bytes()
        })
        .collect();
    if !seed.is_empty() {
        txn.git_on(&scratch, &["update-index", "-z", "--index-info"])
            .input(seed)
            .run(deadline)?
            .succeeded()?;
    }
    for (apply, patch) in [
        (Apply::Forward, prepared.fresh),
        (Apply::Reverse, prepared.patch),
    ] {
        txn.git_on(&scratch, apply.args())
            .input(patch)
            .run(deadline)?
            .succeeded()?;
    }
    let listed = txn
        .git_on(
            &scratch,
            &["--literal-pathspecs", "ls-files", "-z", "--", path],
        )
        .run(deadline)?
        .succeeded()?;
    if listed.is_empty() {
        return Ok(false);
    }
    let prefix = discard::checkout_prefix(checkout);
    txn.git_on(
        &scratch,
        &["checkout-index", &prefix, "-f", "-z", "--stdin"],
    )
    .input(index::nul_separated([path]))
    .run(deadline)?
    .succeeded()?;
    Ok(true)
}

fn changed() -> RepositoryError {
    RepositoryError::stale(
        StaleReason::PathChanged,
        "This file changed. Refresh to see its current diff.",
    )
}

fn unsupported(message: String) -> RepositoryError {
    RepositoryError::new(ErrorKind::UnsupportedPath, message)
}

/// Keeps the picked lines of `patch` and turns the rest into context or
/// drops them, so `git apply` with `apply`'s flags applies only the picks.
/// `None` when no change is left.
pub(super) fn partial_patch(
    patch: &[u8],
    picks: Picks<'_>,
    apply: Apply,
) -> Result<Option<Vec<u8>>, Refusal> {
    let parsed = Parsed::read(patch)?;
    let chosen = parsed.chosen(picks)?;
    let mut body = Vec::new();
    let (mut delta, mut old_total, mut new_total) = (0, 0, 0);
    for hunk in &parsed.hunks {
        let kept: Vec<(Marker, &Line<'_>)> = paired(&hunk.lines)
            .into_iter()
            .filter_map(|line| Some((line.row.kept(&chosen, apply)?, line)))
            .collect();
        if kept.iter().all(|(marker, _)| *marker == Marker::Context) {
            continue;
        }
        let old_count = lines_on(&kept, LineSide::Deletions)?;
        let new_count = lines_on(&kept, LineSide::Additions)?;
        let (old_at, new_at) = match apply {
            Apply::Forward => {
                let old_at = hunk.old.first();
                (old_at, old_at + delta)
            }
            Apply::Reverse => {
                let new_at = hunk.new.first();
                (new_at - delta, new_at)
            }
        };
        delta += new_count - old_count;
        old_total += old_count;
        new_total += new_count;
        body.extend_from_slice(
            format!(
                "@@ -{},{old_count} +{},{new_count} @@",
                start(old_at, old_count),
                start(new_at, new_count)
            )
            .as_bytes(),
        );
        body.extend_from_slice(hunk.tail);
        for (marker, line) in kept {
            body.push(marker.byte());
            body.extend_from_slice(line.body);
            if line.no_newline {
                body.extend_from_slice(NO_NEWLINE);
            }
        }
    }
    if body.is_empty() {
        return Ok(None);
    }
    let mut built = rewrite_header(&parsed.header, old_total, new_total)?;
    built.extend(body);
    Ok(Some(built))
}

const SECTION: &[u8] = b"diff --git ";
const NO_NEWLINE: &[u8] = b"\\ No newline at end of file\n";
const DEV_NULL: &[u8] = b"/dev/null\n";

struct Parsed<'b> {
    header: Vec<&'b [u8]>,
    hunks: Vec<Hunk<'b>>,
}

struct Hunk<'b> {
    old: Span,
    new: Span,
    /// What follows the second `@@`, newline included.
    tail: &'b [u8],
    lines: Vec<Line<'b>>,
}

#[derive(Clone, Copy)]
struct Span {
    start: u32,
    count: u32,
}

impl Span {
    /// The line the span's first line is at. Git writes the line before an
    /// empty span.
    fn first(self) -> i64 {
        i64::from(self.start) + i64::from(self.count == 0)
    }
}

/// A hunk header writes the line before a span with no lines.
const fn start(first: i64, count: i64) -> i64 {
    if count == 0 { first - 1 } else { first }
}

struct Line<'b> {
    row: Row,
    /// The bytes after the marker, newline included.
    body: &'b [u8],
    no_newline: bool,
}

#[derive(Clone, Copy)]
enum Row {
    Context { old: NonZeroU32, new: NonZeroU32 },
    Change(LinePick),
}

impl Row {
    fn names(self) -> impl Iterator<Item = LinePick> {
        let (old, new) = match self {
            Self::Context { old, new } => (Some(old), Some(new)),
            Self::Change(LinePick {
                side: LineSide::Deletions,
                line,
            }) => (Some(line), None),
            Self::Change(LinePick {
                side: LineSide::Additions,
                line,
            }) => (None, Some(line)),
        };
        [
            old.map(|line| LinePick {
                side: LineSide::Deletions,
                line,
            }),
            new.map(|line| LinePick {
                side: LineSide::Additions,
                line,
            }),
        ]
        .into_iter()
        .flatten()
    }

    fn kept(self, chosen: &BTreeSet<LinePick>, apply: Apply) -> Option<Marker> {
        let Self::Change(pick) = self else {
            return Some(Marker::Context);
        };
        if chosen.contains(&pick) {
            Some(Marker::Change(pick.side))
        } else if pick.side == apply.applies_to() {
            Some(Marker::Context)
        } else {
            None
        }
    }

    fn changes(self, side: LineSide) -> bool {
        matches!(self, Self::Change(pick) if pick.side == side)
    }
}

/// A line of the built patch.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Marker {
    Context,
    Change(LineSide),
}

impl Marker {
    const fn byte(self) -> u8 {
        match self {
            Self::Context => b' ',
            Self::Change(LineSide::Deletions) => b'-',
            Self::Change(LineSide::Additions) => b'+',
        }
    }

    fn on(self, side: LineSide) -> bool {
        self == Self::Context || self == Self::Change(side)
    }
}

impl<'b> Parsed<'b> {
    fn read(patch: &'b [u8]) -> Result<Self, Refusal> {
        if !patch.ends_with(b"\n") {
            return Err(Refusal::Malformed);
        }
        let mut lines = patch.split_inclusive(|byte| *byte == b'\n').peekable();
        let first = lines
            .next()
            .filter(|line| line.starts_with(SECTION))
            .ok_or(Refusal::Malformed)?;
        if lines.clone().any(|line| line.starts_with(SECTION)) {
            return Err(Refusal::Sections);
        }
        let mut header = vec![first];
        while let Some(line) = lines.next_if(|line| !line.starts_with(b"@@ ")) {
            refuse_kind(line)?;
            header.push(line);
        }
        let mut hunks = Vec::new();
        while let Some(line) = lines.next() {
            let (old, new, tail) = hunk_header(line).ok_or(Refusal::Malformed)?;
            let mut hunk = Hunk {
                old,
                new,
                tail,
                lines: Vec::new(),
            };
            let (mut at_old, mut at_new) = (old.start, new.start);
            let (mut old_left, mut new_left) = (old.count, new.count);
            while old_left > 0
                || new_left > 0
                || lines.peek().is_some_and(|line| line.starts_with(b"\\"))
            {
                let line = lines.next().ok_or(Refusal::Malformed)?;
                let (&marker, body) = line.split_first().ok_or(Refusal::Malformed)?;
                let row = match marker {
                    b'\\' => {
                        hunk.lines.last_mut().ok_or(Refusal::Malformed)?.no_newline = true;
                        continue;
                    }
                    b' ' => Row::Context {
                        old: take(&mut at_old, &mut old_left)?,
                        new: take(&mut at_new, &mut new_left)?,
                    },
                    b'-' => Row::Change(LinePick {
                        side: LineSide::Deletions,
                        line: take(&mut at_old, &mut old_left)?,
                    }),
                    b'+' => Row::Change(LinePick {
                        side: LineSide::Additions,
                        line: take(&mut at_new, &mut new_left)?,
                    }),
                    _ => return Err(Refusal::Malformed),
                };
                hunk.lines.push(Line {
                    row,
                    body,
                    no_newline: false,
                });
            }
            hunks.push(hunk);
        }
        Ok(Self { header, hunks })
    }

    fn chosen(&self, picks: Picks<'_>) -> Result<BTreeSet<LinePick>, Refusal> {
        match picks {
            Picks::Hunk(index) => {
                let hunk = usize::try_from(index)
                    .ok()
                    .and_then(|at| self.hunks.get(at))
                    .ok_or(Refusal::NoHunk {
                        index,
                        hunks: self.hunks.len(),
                    })?;
                Ok(hunk
                    .lines
                    .iter()
                    .filter_map(|line| match line.row {
                        Row::Change(pick) => Some(pick),
                        Row::Context { .. } => None,
                    })
                    .collect())
            }
            Picks::Lines(picks) => {
                let named: BTreeSet<LinePick> = self
                    .hunks
                    .iter()
                    .flat_map(|hunk| &hunk.lines)
                    .flat_map(|line| line.row.names())
                    .collect();
                match picks.iter().find(|pick| !named.contains(pick)) {
                    Some(pick) => Err(Refusal::NotInDiff(*pick)),
                    None => Ok(picks.iter().copied().collect()),
                }
            }
        }
    }
}

/// Counts off one line of a span: its number, counted from 1.
fn take(next: &mut u32, left: &mut u32) -> Result<NonZeroU32, Refusal> {
    *left = left.checked_sub(1).ok_or(Refusal::Malformed)?;
    let line = NonZeroU32::new(*next).ok_or(Refusal::Malformed)?;
    *next = next.checked_add(1).ok_or(Refusal::Malformed)?;
    Ok(line)
}

fn refuse_kind(line: &[u8]) -> Result<(), Refusal> {
    const MODES: [&[u8]; 4] = [
        b"old mode ",
        b"new mode ",
        b"deleted file mode ",
        b"new file mode ",
    ];
    if line.starts_with(b"copy from ") || line.starts_with(b"copy to ") {
        return Err(Refusal::Copy);
    }
    let octal = MODES
        .iter()
        .find_map(|prefix| line.strip_prefix(*prefix))
        .or_else(|| {
            let ids = line.strip_prefix(b"index ")?;
            Some(&ids[ids.iter().position(|byte| *byte == b' ')? + 1..])
        });
    match octal.map(|octal| Mode::parse(octal.strip_suffix(b"\n").unwrap_or(octal))) {
        None | Some(Some(Mode::File | Mode::Executable)) => Ok(()),
        Some(Some(mode)) => Err(Refusal::Mode(mode)),
        Some(None) => Err(Refusal::Malformed),
    }
}

/// `@@ -<start>[,<count>] +<start>[,<count>] @@<tail>`. A missing count is 1.
fn hunk_header(line: &[u8]) -> Option<(Span, Span, &[u8])> {
    let (old, rest) = span(line.strip_prefix(b"@@ -")?)?;
    let (new, rest) = span(rest.strip_prefix(b"+")?)?;
    Some((old, new, rest.strip_prefix(b"@@")?))
}

fn span(bytes: &[u8]) -> Option<(Span, &[u8])> {
    let end = bytes.iter().position(|byte| *byte == b' ')?;
    let number = |digits: &[u8]| {
        if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        str::from_utf8(digits).ok()?.parse().ok()
    };
    let spec = &bytes[..end];
    let span = match spec.iter().position(|byte| *byte == b',') {
        Some(comma) => Span {
            start: number(&spec[..comma])?,
            count: number(&spec[comma + 1..])?,
        },
        None => Span {
            start: number(spec)?,
            count: 1,
        },
    };
    Some((span, &bytes[end + 1..]))
}

/// Within each block of changes, the k-th deletion then the k-th addition,
/// as the split view draws rows. Git's order, all deletions then all
/// additions, would put a staged addition after the deletions left as
/// context instead of in place of its row.
fn paired<'h, 'b>(lines: &'h [Line<'b>]) -> Vec<&'h Line<'b>> {
    let mut out = Vec::with_capacity(lines.len());
    let mut rest = lines;
    while let Some(first) = rest.first() {
        if matches!(first.row, Row::Context { .. }) {
            out.push(first);
            rest = &rest[1..];
            continue;
        }
        let removed = rest
            .iter()
            .take_while(|line| line.row.changes(LineSide::Deletions))
            .count();
        let added = rest[removed..]
            .iter()
            .take_while(|line| line.row.changes(LineSide::Additions))
            .count();
        let (deletions, additions) = (&rest[..removed], &rest[removed..removed + added]);
        for row in 0..removed.max(added) {
            out.extend(deletions.get(row));
            out.extend(additions.get(row));
        }
        rest = &rest[removed + added..];
    }
    out
}

/// How many kept lines `side` holds. A line that ends its file without a
/// newline must be the last of them.
fn lines_on(kept: &[(Marker, &Line<'_>)], side: LineSide) -> Result<i64, Refusal> {
    let mut count = 0;
    let mut ended = false;
    for (_, line) in kept.iter().filter(|(marker, _)| marker.on(side)) {
        if ended {
            return Err(Refusal::NoNewlineSuccessor { side });
        }
        ended = line.no_newline;
        count += 1;
    }
    Ok(count)
}

/// A file name as a `---` or `+++` line spells it after `a/` or `b/`, quoted
/// or not, through the end of the line. Git ends the line with a tab when the
/// name holds a space.
struct Name<'b> {
    quoted: bool,
    rest: &'b [u8],
}

impl<'b> Name<'b> {
    fn of(label: &'b [u8], prefix: &[u8]) -> Option<Self> {
        let (quoted, label) = match label.strip_prefix(b"\"") {
            Some(inside) => (true, inside),
            None => (false, label),
        };
        Some(Self {
            quoted,
            rest: label.strip_prefix(prefix)?,
        })
    }

    fn with(&self, prefix: &[u8], rest: &[u8]) -> Vec<u8> {
        let quote: &[u8] = if self.quoted { b"\"" } else { b"" };
        [quote, prefix, rest].concat()
    }

    fn label(&self, prefix: &[u8]) -> Vec<u8> {
        self.with(prefix, self.rest)
    }

    /// As `diff --git` spells it, with no tab or newline.
    fn bare(&self, prefix: &[u8]) -> Vec<u8> {
        let rest = self.rest.strip_suffix(b"\n").unwrap_or(self.rest);
        self.with(prefix, rest.strip_suffix(b"\t").unwrap_or(rest))
    }
}

/// A partial patch changes content only, so it names the destination on
/// both sides and drops the mode, rename, and similarity lines. A creation
/// or deletion that now keeps lines on its empty side becomes a modification.
fn rewrite_header(header: &[&[u8]], old_total: i64, new_total: i64) -> Result<Vec<u8>, Refusal> {
    const DROPPED: [&[u8]; 6] = [
        b"old mode ",
        b"new mode ",
        b"similarity index ",
        b"dissimilarity index ",
        b"rename from ",
        b"rename to ",
    ];
    let label = |prefix: &[u8]| {
        header
            .iter()
            .find_map(|line| line.strip_prefix(prefix))
            .ok_or(Refusal::Malformed)
    };
    let (minus, plus) = (label(b"--- ")?, label(b"+++ ")?);
    let keeps_creation = minus == DEV_NULL && old_total == 0;
    let keeps_deletion = plus == DEV_NULL && new_total == 0;
    let name = if plus == DEV_NULL {
        Name::of(minus, b"a/")
    } else {
        Name::of(plus, b"b/")
    }
    .ok_or(Refusal::Malformed)?;
    let keeps = |line: &[u8]| {
        if DROPPED.iter().any(|prefix| line.starts_with(prefix)) {
            false
        } else if line.starts_with(b"new file mode ") {
            keeps_creation
        } else if line.starts_with(b"deleted file mode ") {
            keeps_deletion
        } else if line.starts_with(b"index ") {
            keeps_creation || keeps_deletion
        } else {
            true
        }
    };
    let mut out = Vec::new();
    for line in header {
        if line.starts_with(SECTION) {
            out.extend_from_slice(SECTION);
            out.extend(name.bare(b"a/"));
            out.push(b' ');
            out.extend(name.bare(b"b/"));
            out.push(b'\n');
        } else if line.starts_with(b"--- ") && !keeps_creation {
            out.extend_from_slice(b"--- ");
            out.extend(name.label(b"a/"));
        } else if line.starts_with(b"+++ ") && !keeps_deletion {
            out.extend_from_slice(b"+++ ");
            out.extend(name.label(b"b/"));
        } else if keeps(line) {
            out.extend_from_slice(line);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChangeStatus, IndexObject, Moved, Oid, Sides};

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

    fn built(patch: &str, picks: Picks<'_>, apply: Apply) -> String {
        let built = partial_patch(patch.as_bytes(), picks, apply)
            .unwrap()
            .expect("a change is left");
        String::from_utf8(built).unwrap()
    }

    fn refused(patch: &str, picks: Picks<'_>, apply: Apply) -> Refusal {
        partial_patch(patch.as_bytes(), picks, apply).unwrap_err()
    }

    /// Two lines inserted after line 3, then line 15 changed.
    const TWO_HUNKS: &str = concat!(
        "diff --git a/f b/f\n",
        "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n",
        "--- a/f\n",
        "+++ b/f\n",
        "@@ -1,6 +1,8 @@\n",
        " l1\n l2\n l3\n+A\n+B\n l4\n l5\n l6\n",
        "@@ -12,7 +14,7 @@ tail\n",
        " l12\n l13\n l14\n-l15\n+L15\n l16\n l17\n l18\n",
    );

    #[test]
    fn a_forward_hunk_keeps_its_old_start_and_shifts_its_new_start_by_the_hunks_kept_before_it() {
        assert_eq!(
            built(TWO_HUNKS, Picks::Hunk(1), Apply::Forward),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -12,7 +12,7 @@ tail\n",
                " l12\n l13\n l14\n-l15\n+L15\n l16\n l17\n l18\n",
            )
        );
        assert_eq!(
            built(
                TWO_HUNKS,
                Picks::Lines(&[a(4), d(15), a(17)]),
                Apply::Forward
            ),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -1,6 +1,7 @@\n",
                " l1\n l2\n l3\n+A\n l4\n l5\n l6\n",
                "@@ -12,7 +13,7 @@ tail\n",
                " l12\n l13\n l14\n-l15\n+L15\n l16\n l17\n l18\n",
            )
        );
    }

    #[test]
    fn a_reverse_hunk_keeps_its_new_start_and_shifts_its_old_start_by_the_hunks_kept_before_it() {
        assert_eq!(
            built(TWO_HUNKS, Picks::Hunk(1), Apply::Reverse),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -14,7 +14,7 @@ tail\n",
                " l12\n l13\n l14\n-l15\n+L15\n l16\n l17\n l18\n",
            )
        );
        assert_eq!(
            built(
                TWO_HUNKS,
                Picks::Lines(&[a(4), d(15), a(17)]),
                Apply::Reverse
            ),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -1,7 +1,8 @@\n",
                " l1\n l2\n l3\n+A\n B\n l4\n l5\n l6\n",
                "@@ -13,7 +14,7 @@ tail\n",
                " l12\n l13\n l14\n-l15\n+L15\n l16\n l17\n l18\n",
            )
        );
    }

    const BLOCK: &str = concat!(
        "diff --git a/f b/f\n",
        "--- a/f\n",
        "+++ b/f\n",
        "@@ -4,5 +4,5 @@\n",
        " line 4\n-line 5\n-line 6\n-line 7\n+five\n+six\n+seven\n line 8\n",
    );

    #[test]
    fn emits_each_deletion_beside_the_addition_of_its_row() {
        assert_eq!(
            built(BLOCK, Picks::Lines(&[d(5), a(5)]), Apply::Forward),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -4,5 +4,5 @@\n",
                " line 4\n-line 5\n+five\n line 6\n line 7\n line 8\n",
            )
        );
        assert_eq!(
            built(BLOCK, Picks::Lines(&[d(6), a(6), a(7)]), Apply::Reverse),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -4,4 +4,5 @@\n",
                " line 4\n five\n-line 6\n+six\n+seven\n line 8\n",
            )
        );
    }

    #[test]
    fn ignores_a_pick_on_a_context_line_and_refuses_one_on_no_line() {
        assert_eq!(
            built(
                BLOCK,
                Picks::Lines(&[d(4), a(4), d(5), a(5), a(8)]),
                Apply::Forward
            ),
            built(BLOCK, Picks::Lines(&[d(5), a(5)]), Apply::Forward),
        );
        assert_eq!(
            partial_patch(
                BLOCK.as_bytes(),
                Picks::Lines(&[d(4), a(8)]),
                Apply::Forward
            ),
            Ok(None)
        );
        assert_eq!(
            refused(BLOCK, Picks::Lines(&[d(5), d(9)]), Apply::Forward),
            Refusal::NotInDiff(d(9))
        );
        assert_eq!(
            refused(BLOCK, Picks::Lines(&[a(3)]), Apply::Forward),
            Refusal::NotInDiff(a(3))
        );
    }

    #[test]
    fn refuses_a_hunk_index_past_the_last_hunk() {
        assert_eq!(
            refused(TWO_HUNKS, Picks::Hunk(2), Apply::Forward),
            Refusal::NoHunk { index: 2, hunks: 2 }
        );
        let no_hunks = "diff --git a/f b/f\nold mode 100644\nnew mode 100755\n";
        assert_eq!(
            refused(no_hunks, Picks::Hunk(0), Apply::Forward),
            Refusal::NoHunk { index: 0, hunks: 0 }
        );
    }

    /// The old file ends `c` with no newline, and the new one adds `d`.
    const APPENDED: &str = concat!(
        "diff --git a/f b/f\n",
        "--- a/f\n",
        "+++ b/f\n",
        "@@ -1,3 +1,4 @@\n",
        " a\n b\n-c\n\\ No newline at end of file\n+c\n+d\n",
    );

    #[test]
    fn refuses_a_line_after_one_without_a_newline_and_takes_the_newline_fix_with_it() {
        assert_eq!(
            refused(APPENDED, Picks::Lines(&[a(4)]), Apply::Forward),
            Refusal::NoNewlineSuccessor {
                side: LineSide::Additions
            }
        );
        assert_eq!(
            built(APPENDED, Picks::Lines(&[d(3), a(3), a(4)]), Apply::Forward),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -1,3 +1,4 @@\n",
                " a\n b\n-c\n\\ No newline at end of file\n+c\n+d\n",
            )
        );
        assert_eq!(
            refused(APPENDED, Picks::Lines(&[d(3)]), Apply::Reverse),
            Refusal::NoNewlineSuccessor {
                side: LineSide::Deletions
            }
        );
    }

    #[test]
    fn keeps_a_no_newline_line_that_stays_last() {
        let last = concat!(
            "diff --git a/f b/f\n",
            "--- a/f\n",
            "+++ b/f\n",
            "@@ -1,3 +1,3 @@\n",
            "-a\n+A\n b\n-c\n\\ No newline at end of file\n+C\n\\ No newline at end of file\n",
        );
        assert_eq!(
            built(last, Picks::Lines(&[d(3), a(3)]), Apply::Forward),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -1,3 +1,3 @@\n",
                " a\n b\n-c\n\\ No newline at end of file\n+C\n\\ No newline at end of file\n",
            )
        );
        assert_eq!(
            built(last, Picks::Lines(&[d(1), a(1)]), Apply::Reverse),
            concat!(
                "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
                "@@ -1,3 +1,3 @@\n",
                "-a\n+A\n b\n C\n\\ No newline at end of file\n",
            )
        );
    }

    #[test]
    fn refuses_a_second_section_a_link_a_submodule_and_a_copy() {
        let type_change = concat!(
            "diff --git a/link b/link\n",
            "deleted file mode 120000\n",
            "index 1de565933b05f74c75ff9a6520af5f9f8a5a2f1d..0000000000000000000000000000000000000000\n",
            "--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n\\ No newline at end of file\n",
            "diff --git a/link b/link\n",
            "new file mode 100644\n",
            "index 0000000000000000000000000000000000000000..3f899ea7ab51da801dbacbf633c168b0591d7765\n",
            "--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+now a file\n",
        );
        assert_eq!(
            refused(type_change, Picks::Hunk(0), Apply::Forward),
            Refusal::Sections
        );
        let link = concat!(
            "diff --git a/link b/link\n",
            "index 1de565933b05f74c75ff9a6520af5f9f8a5a2f1d..27fa34919ae70aa0d7eaccdfbf393cfc440e7d25 120000\n",
            "--- a/link\n+++ b/link\n@@ -1 +1 @@\n",
            "-target\n\\ No newline at end of file\n+other\n\\ No newline at end of file\n",
        );
        assert_eq!(
            refused(link, Picks::Hunk(0), Apply::Forward),
            Refusal::Mode(Mode::Symlink)
        );
        let new_link = link.replace(" 120000\n", "\n").replace(
            "diff --git a/link b/link\n",
            "diff --git a/link b/link\nnew mode 120000\n",
        );
        assert_eq!(
            refused(&new_link, Picks::Hunk(0), Apply::Forward),
            Refusal::Mode(Mode::Symlink)
        );
        let submodule = concat!(
            "diff --git a/sub b/sub\n",
            "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 160000\n",
            "--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n",
            "-Subproject commit 1111111111111111111111111111111111111111\n",
            "+Subproject commit 2222222222222222222222222222222222222222\n",
        );
        assert_eq!(
            refused(submodule, Picks::Hunk(0), Apply::Reverse),
            Refusal::Mode(Mode::Submodule)
        );
        let copy = concat!(
            "diff --git a/old.txt b/copy.txt\n",
            "similarity index 90%\n",
            "copy from old.txt\n",
            "copy to copy.txt\n",
            "index c9e9e05f445e6b772f19fea1449759b7458a446e..ba8f42d96d5feb97993a58063308b7e7b176d2f5 100644\n",
            "--- a/old.txt\n+++ b/copy.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n",
        );
        assert_eq!(refused(copy, Picks::Hunk(0), Apply::Reverse), Refusal::Copy);
    }

    #[test]
    fn refuses_bytes_that_are_not_one_git_file_patch() {
        for patch in [
            "",
            "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n",
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b",
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n-a\n+b\n",
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n+c\n",
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\nnot a hunk\n",
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n\\ No newline at end of file\n-a\n+b\n",
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0 +1 @@\n a\n",
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -+1 +1 @@\n-a\n+b\n",
            "diff --git a/f b/f\nold mode 100664\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n",
            "diff --git a/f b/f\n--- f\n+++ f\n@@ -1 +1 @@\n-a\n+b\n",
            "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n",
        ] {
            assert_eq!(
                partial_patch(patch.as_bytes(), Picks::Hunk(0), Apply::Forward),
                Err(Refusal::Malformed),
                "{patch:?}"
            );
        }
    }

    #[test]
    fn drops_mode_lines_and_the_index_line_of_a_modification() {
        let mode = concat!(
            "diff --git a/mode.sh b/mode.sh\n",
            "old mode 100644\n",
            "new mode 100755\n",
            "index 28ce6a8b26aa170e1de65536fe8abe1832bd3242..3d3fffbbfd74e37fb6e9ce38b0ef7e97da0f2d3d\n",
            "--- a/mode.sh\n+++ b/mode.sh\n@@ -1 +1,2 @@\n m\n+n\n",
        );
        assert_eq!(
            built(mode, Picks::Hunk(0), Apply::Forward),
            "diff --git a/mode.sh b/mode.sh\n--- a/mode.sh\n+++ b/mode.sh\n@@ -1,1 +1,2 @@\n m\n+n\n"
        );
    }

    #[test]
    fn edits_a_rename_destination_in_place() {
        let rename = concat!(
            "diff --git a/old.txt b/new.txt\n",
            "similarity index 91%\n",
            "rename from old.txt\n",
            "rename to new.txt\n",
            "index c9e9e05f445e6b772f19fea1449759b7458a446e..ba8f42d96d5feb97993a58063308b7e7b176d2f5 100644\n",
            "--- a/old.txt\n+++ b/new.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
        );
        assert_eq!(
            built(rename, Picks::Hunk(0), Apply::Reverse),
            "diff --git a/new.txt b/new.txt\n--- a/new.txt\n+++ b/new.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n"
        );
    }

    const CREATION: &str = concat!(
        "diff --git a/n.txt b/n.txt\n",
        "new file mode 100644\n",
        "index 0000000000000000000000000000000000000000..f384549cbeb481e437091320de6d1f2e15e11b4a\n",
        "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,4 @@\n+one\n+two\n+three\n+four\n",
    );

    #[test]
    fn keeps_a_creation_that_keeps_no_old_lines_and_otherwise_makes_it_a_modification() {
        assert_eq!(
            built(CREATION, Picks::Lines(&[a(1), a(3)]), Apply::Forward),
            concat!(
                "diff --git a/n.txt b/n.txt\n",
                "new file mode 100644\n",
                "index 0000000000000000000000000000000000000000..f384549cbeb481e437091320de6d1f2e15e11b4a\n",
                "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+three\n",
            )
        );
        assert_eq!(built(CREATION, Picks::Hunk(0), Apply::Reverse), CREATION);
        assert_eq!(
            built(CREATION, Picks::Lines(&[a(2)]), Apply::Reverse),
            "diff --git a/n.txt b/n.txt\n--- a/n.txt\n+++ b/n.txt\n@@ -1,3 +1,4 @@\n one\n+two\n three\n four\n"
        );
    }

    const DELETION: &str = concat!(
        "diff --git a/g.txt b/g.txt\n",
        "deleted file mode 100644\n",
        "index 9a2bb5cbe9a0a3da5ac3ca1c96b6bbd3bc8e94de..0000000000000000000000000000000000000000\n",
        "--- a/g.txt\n+++ /dev/null\n@@ -1,4 +0,0 @@\n-d1\n-d2\n-d3\n-d4\n",
    );

    #[test]
    fn keeps_a_deletion_that_keeps_no_new_lines_and_otherwise_makes_it_a_modification() {
        assert_eq!(
            built(DELETION, Picks::Lines(&[d(1), d(4)]), Apply::Reverse),
            concat!(
                "diff --git a/g.txt b/g.txt\n",
                "deleted file mode 100644\n",
                "index 9a2bb5cbe9a0a3da5ac3ca1c96b6bbd3bc8e94de..0000000000000000000000000000000000000000\n",
                "--- a/g.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-d1\n-d4\n",
            )
        );
        assert_eq!(
            built(DELETION, Picks::Lines(&[d(2), d(3)]), Apply::Forward),
            "diff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1,4 +1,2 @@\n d1\n-d2\n-d3\n d4\n"
        );
    }

    #[test]
    fn keeps_a_quoted_name_quoted_and_the_tab_after_a_name_with_a_space() {
        let quoted = concat!(
            "diff --git \"a/tab\\there.txt\" \"b/tab\\there.txt\"\n",
            "index bca70f35318f31dd1d1d1d2d2e64c19b880899ff..8a08eba85c872cd83776ed37dd9c6de453c789c2 100644\n",
            "--- \"a/tab\\there.txt\"\n+++ \"b/tab\\there.txt\"\n@@ -1 +1,2 @@\n q\n+r\n",
        );
        assert_eq!(
            built(quoted, Picks::Hunk(0), Apply::Forward),
            concat!(
                "diff --git \"a/tab\\there.txt\" \"b/tab\\there.txt\"\n",
                "--- \"a/tab\\there.txt\"\n+++ \"b/tab\\there.txt\"\n@@ -1,1 +1,2 @@\n q\n+r\n",
            )
        );
        let spaced = concat!(
            "diff --git a/a b.txt b/a b.txt\n",
            "deleted file mode 100644\n",
            "index 587be6b4c3f93f93c489c0111bba5596147a26cb..0000000000000000000000000000000000000000\n",
            "--- a/a b.txt\t\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n",
        );
        assert_eq!(
            built(spaced, Picks::Lines(&[d(2)]), Apply::Forward),
            "diff --git a/a b.txt b/a b.txt\n--- a/a b.txt\t\n+++ b/a b.txt\t\n@@ -1,2 +1,1 @@\n x\n-y\n"
        );
        let renamed_quoted = concat!(
            "diff --git a/old \"b/new \\\"one\\\".txt\"\n",
            "similarity index 80%\n",
            "rename from old\n",
            "rename to \"new \\\"one\\\".txt\"\n",
            "--- a/old\n+++ \"b/new \\\"one\\\".txt\"\t\n@@ -1 +1 @@\n-x\n+y\n",
        );
        assert_eq!(
            built(renamed_quoted, Picks::Hunk(0), Apply::Forward),
            concat!(
                "diff --git \"a/new \\\"one\\\".txt\" \"b/new \\\"one\\\".txt\"\n",
                "--- \"a/new \\\"one\\\".txt\"\t\n+++ \"b/new \\\"one\\\".txt\"\t\n@@ -1,1 +1,1 @@\n-x\n+y\n",
            )
        );
    }

    const OID: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

    fn modified(path: &str) -> StatusEntry {
        StatusEntry::Ordinary {
            path: path.to_owned(),
            submodule: None,
            sides: Sides::Unstaged {
                unstaged: ChangeStatus::Modified,
            },
            index: Some(IndexObject {
                mode: Mode::File,
                oid: Oid::try_from(OID.to_owned()).unwrap(),
            }),
        }
    }

    fn read(entry: StatusEntry, patch: SidePatch) -> Option<SideRead> {
        Some(SideRead { entry, patch })
    }

    fn text(patch: &str) -> SidePatch {
        SidePatch::Diff(PatchBytes::Text(patch.as_bytes().to_vec()))
    }

    fn kind(result: Result<Prepared, RepositoryError>) -> ErrorKind {
        result.map(|prepared| prepared.patch).unwrap_err().kind
    }

    const STALE: ErrorKind = ErrorKind::StaleView {
        reason: StaleReason::PathChanged,
    };

    #[test]
    fn refuses_a_name_git_would_read_as_another_file_and_an_empty_choice_before_any_read() {
        let lines = |path| Part::new(Action::Stage, path, Picks::Lines(&[]), BLOCK);
        assert_eq!(lines("f").err().unwrap().kind, ErrorKind::UnchangedPath);
        for path in ["../f", ".git/config", "a\0b", "caf\u{FFFD}"] {
            let error = Part::new(Action::Stage, path, Picks::Hunk(0), BLOCK).err();
            assert_eq!(error.unwrap().kind, ErrorKind::UnsupportedPath, "{path:?}");
        }
    }

    #[test]
    fn a_path_that_lists_no_change_or_whose_patch_differs_from_the_shown_one_is_stale() {
        let part = Part::new(Action::Stage, "f", Picks::Hunk(0), BLOCK).unwrap();
        assert_eq!(kind(part.prepare(None)), STALE);
        assert_eq!(
            kind(part.prepare(read(modified("f"), text(APPENDED)))),
            STALE
        );
        let prepared = part.prepare(read(modified("f"), text(BLOCK))).unwrap();
        assert_eq!(
            prepared.patch,
            partial_patch(BLOCK.as_bytes(), Picks::Hunk(0), Apply::Forward)
                .unwrap()
                .unwrap()
        );
    }

    #[test]
    fn refuses_a_patch_with_no_text_and_a_move_git_add_n_started_whatever_was_shown() {
        let part = Part::new(Action::Stage, "f", Picks::Hunk(0), BLOCK).unwrap();
        let moved = StatusEntry::Renamed {
            path: "f".to_owned(),
            original: "e".to_owned(),
            how: Moved::Renamed,
            submodule: None,
            side: MoveSide::Unstaged {
                original: IndexObject {
                    mode: Mode::File,
                    oid: Oid::try_from(OID.to_owned()).unwrap(),
                },
            },
        };
        for fresh in [
            read(modified("f"), SidePatch::Diff(PatchBytes::Binary)),
            read(
                modified("f"),
                SidePatch::Diff(PatchBytes::TooLarge { bytes: 2 << 20 }),
            ),
            read(moved, text(APPENDED)),
        ] {
            assert_eq!(kind(part.prepare(fresh)), ErrorKind::UnsupportedPath);
        }
    }

    #[test]
    fn judges_the_bytes_only_once_they_are_the_shown_ones() {
        let link = concat!(
            "diff --git a/f b/f\n",
            "index 1de565933b05f74c75ff9a6520af5f9f8a5a2f1d..27fa34919ae70aa0d7eaccdfbf393cfc440e7d25 120000\n",
            "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-target\n+other\n",
        );
        let shown_link = Part::new(Action::Unstage, "f", Picks::Hunk(0), link).unwrap();
        assert_eq!(
            kind(shown_link.prepare(read(modified("f"), text(link)))),
            ErrorKind::UnsupportedPath
        );
        let shown_text = Part::new(Action::Unstage, "f", Picks::Hunk(0), BLOCK).unwrap();
        assert_eq!(
            kind(shown_text.prepare(read(modified("f"), text(link)))),
            STALE
        );
        for picks in [Picks::Hunk(1), Picks::Lines(&[d(4)]), Picks::Lines(&[d(9)])] {
            let part = Part::new(Action::Stage, "f", picks, BLOCK).unwrap();
            assert_eq!(
                kind(part.prepare(read(modified("f"), text(BLOCK)))),
                ErrorKind::UnchangedPath
            );
        }
    }

    #[test]
    fn compares_bytes_that_are_not_utf8_by_the_text_shown_for_them() {
        let latin = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-caf\xe9\n+CAF\xe9\n";
        let shown = String::from_utf8_lossy(latin).into_owned();
        let part = Part::new(Action::Stage, "f", Picks::Hunk(0), &shown).unwrap();
        let fresh = SidePatch::Diff(PatchBytes::Text(latin.to_vec()));
        let prepared = part.prepare(read(modified("f"), fresh)).unwrap();
        assert!(prepared.patch.ends_with(b"-caf\xe9\n+CAF\xe9\n"));
    }
}
