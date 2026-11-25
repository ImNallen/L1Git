use crate::{
    FilePatch, Oid, PatchContext, RepositoryError,
    git::{self, Deadline, LocalRead},
    repository::{PATCH_LIMIT, non_utf8_path, root, text_patch, verify_commit},
};
use serde::Serialize;
use std::{
    io::{self, BufRead, BufReader, Read},
    iter,
    path::Path,
};

/// The patches of one range together. A patch over `PATCH_LIMIT` does not count.
pub const RANGE_PATCH_LIMIT: usize = 8 * PATCH_LIMIT;
const PIECE: u64 = 64 * 1024;
const BLOCK: &[u8] = b"diff --git ";
const RENAMES: &str = "--find-renames=50%";
/// Pairs files by their blob ids alone, so it reads no contents.
const EXACT_RENAMES: &str = "--find-renames=100%";

/// What `head` changed since it forked from `base`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RangeFiles {
    Ready {
        merge_base: Oid,
        /// In Git's order, by the bytes of `path`.
        files: Vec<RangeFile>,
        /// Git could not read every file's contents, as in a partial clone. The
        /// files then have no line counts, and one that was renamed and edited
        /// is a deletion and an addition.
        content_missing: bool,
    },
    /// This clone does not have these commits.
    Missing { oids: Vec<Oid> },
    /// No commit is in the history of both. A `shallow` clone may lack it.
    Unrelated { shallow: bool },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RangeFile {
    pub path: String,
    pub status: RangeStatus,
    /// Where a renamed file was, and how much of it is the same, in percent.
    pub from: Option<String>,
    pub similarity: Option<u8>,
    /// `None` for a binary file.
    pub added: Option<u64>,
    pub deleted: Option<u64>,
    /// `None` on the side that does not have the file. A submodule's is the
    /// commit it is at.
    pub old_blob: Option<Oid>,
    pub new_blob: Option<Oid>,
    /// What the range leaves at `path`, or deletes there, is a submodule.
    pub submodule: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum RangeStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "T")]
    TypeChanged,
    #[serde(rename = "R")]
    Renamed,
}

/// `patch` is `None` for a file to read by itself: one after the patches reached
/// `RANGE_PATCH_LIMIT`, or any when Git could not read every file's contents.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RangePatch {
    pub path: String,
    pub patch: Option<FilePatch>,
}

pub fn range_files(path: &str, base: &Oid, head: &Oid) -> Result<RangeFiles, RepositoryError> {
    range_files_within(path, base, head, Deadline::of(LocalRead::RangeFiles))
}

pub(crate) fn range_files_within(
    path: &str,
    base: &Oid,
    head: &Oid,
    deadline: Deadline,
) -> Result<RangeFiles, RepositoryError> {
    let root = root(path, deadline)?;
    let oids = missing(&root, &[base, head], deadline)?;
    if !oids.is_empty() {
        return Ok(RangeFiles::Missing { oids });
    }
    let found = git::run(
        &root,
        &["merge-base", base.as_str(), head.as_str()],
        deadline,
    )?;
    let merge_base = match found.status.code() {
        Some(0) => Oid::try_from(git::line(&found.stdout))?,
        Some(1) => {
            return Ok(RangeFiles::Unrelated {
                shallow: git::line(&git::read(
                    &root,
                    &["rev-parse", "--is-shallow-repository"],
                    deadline,
                )?) == "true",
            });
        }
        _ => return Err(git::read_failed()),
    };
    let ends = [merge_base.as_str(), head.as_str()];
    let counted = git::run(
        &root,
        &strs(&args(ends, RENAMES, &["--raw", "--numstat"], &[])),
        deadline,
    )?;
    let files = if counted.status.success() {
        let mut output = counted.stdout.as_slice();
        let changes = changes(&mut output).map_err(unreadable)?;
        let counts = changes
            .iter()
            .map(|change| counts(&mut output, change))
            .collect::<io::Result<Vec<_>>>()
            .map_err(unreadable)?;
        iter::zip(changes, counts)
            .map(|(change, counts)| file(&change, counts))
            .collect::<Result<_, _>>()?
    } else {
        names(&root, ends, deadline)?
            .iter()
            .map(|change| file(change, None))
            .collect::<Result<_, _>>()?
    };
    Ok(RangeFiles::Ready {
        merge_base,
        files,
        content_missing: !counted.status.success(),
    })
}

pub fn range_patches(
    path: &str,
    merge_base: &Oid,
    head: &Oid,
) -> Result<Vec<RangePatch>, RepositoryError> {
    range_patches_within(
        path,
        merge_base,
        head,
        Deadline::of(LocalRead::RangePatches),
    )
}

pub(crate) fn range_patches_within(
    path: &str,
    merge_base: &Oid,
    head: &Oid,
    deadline: Deadline,
) -> Result<Vec<RangePatch>, RepositoryError> {
    let root = root(path, deadline)?;
    for oid in [merge_base, head] {
        verify_commit(&root, oid.as_str(), deadline)?;
    }
    let ends = [merge_base.as_str(), head.as_str()];
    let formats = ["--raw", PatchContext::Hunks.patch_format()];
    let (changes, patches) = match patches(
        &root,
        &args(ends, RENAMES, &formats, &[]),
        RANGE_PATCH_LIMIT,
        deadline,
    )? {
        Some(read) => (read.changes, read.patches),
        None => (names(&root, ends, deadline)?, Vec::new()),
    };
    Ok(changes
        .iter()
        .zip(patches.into_iter().map(Some).chain(iter::repeat(None)))
        .map(|(change, patch)| RangePatch {
            path: git::text(&change.path),
            patch,
        })
        .collect())
}

/// One file of a range, as `range_patches` reads it, or `None` when the range
/// has no such change. `from` is `file` itself unless the file was renamed.
pub(crate) fn file_patch(
    root: &Path,
    ends: [&str; 2],
    from: &str,
    file: &str,
    context: PatchContext,
    deadline: Deadline,
) -> Result<Option<FilePatch>, RepositoryError> {
    let paths = if from == file {
        &[file][..]
    } else {
        &[from, file]
    };
    if paths.iter().any(|path| path.is_empty()) {
        return Ok(None);
    }
    let read = patches(
        root,
        &args(ends, RENAMES, &["--raw", context.patch_format()], paths),
        usize::MAX,
        deadline,
    )?
    .ok_or_else(git::read_failed)?;
    let found = iter::zip(read.changes, read.patches)
        .find(|(change, _)| {
            change.path == file.as_bytes()
                && change
                    .from
                    .as_ref()
                    .map_or(from == file, |(old, _)| old == from.as_bytes())
        })
        .map(|(_, patch)| patch);
    if found.is_none() && paths.iter().any(|path| path.contains('\u{FFFD}')) {
        return Err(non_utf8_path());
    }
    Ok(found)
}

/// Pins whatever a person's configuration could change, so a range reads the
/// same everywhere and its line counts match GitHub's. Attributes come from the
/// range's own head, because the checked-out branch can have others.
fn args<'a>(
    [base, head]: [&'a str; 2],
    renames: &'a str,
    formats: &[&'a str],
    paths: &[&'a str],
) -> Vec<String> {
    let attributes = format!("--attr-source={head}");
    let mut args = vec![
        "-c",
        "core.attributesFile=",
        "-c",
        "core.bigFileThreshold=512m",
        // Git on macOS would otherwise compose the decomposed names in `paths`.
        "-c",
        "core.precomposeUnicode=false",
        &attributes,
        "--literal-pathspecs",
        "diff-tree",
        "--no-commit-id",
        "-r",
        "-z",
        "--no-abbrev",
        renames,
        "-l1000",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--ignore-submodules=none",
        "--no-ext-diff",
        "--no-textconv",
    ];
    args.extend(formats);
    args.extend([base, head, "--"]);
    args.extend(paths);
    args.into_iter().map(str::to_owned).collect()
}

fn missing(root: &Path, oids: &[&Oid], deadline: Deadline) -> Result<Vec<Oid>, RepositoryError> {
    let mut asked: Vec<&Oid> = oids.to_vec();
    asked.dedup();
    let output = git::read_with_input(
        root,
        &["cat-file", "--batch-check=%(objecttype)"],
        asked
            .iter()
            .flat_map(|oid| format!("{}\n", oid.as_str()).into_bytes())
            .collect(),
        deadline,
    )?;
    let output = git::text(&output);
    if output.lines().count() != asked.len() {
        return Err(git::malformed());
    }
    Ok(iter::zip(asked, output.lines())
        .filter(|(_, kind)| *kind != "commit")
        .map(|(oid, _)| oid.clone())
        .collect())
}

/// The changes of a range without reading any file's contents.
fn names(root: &Path, ends: [&str; 2], deadline: Deadline) -> Result<Vec<Change>, RepositoryError> {
    let args = args(ends, EXACT_RENAMES, &["--raw"], &[]);
    changes(&mut git::read(root, &strs(&args), deadline)?.as_slice()).map_err(unreadable)
}

struct Change {
    path: Vec<u8>,
    /// A renamed file's old path and similarity.
    from: Option<(Vec<u8>, u8)>,
    status: RangeStatus,
    old: Side,
    new: Side,
}

/// One side of a change, with a mode of zeros when it has no file.
struct Side {
    mode: Vec<u8>,
    oid: Vec<u8>,
}

impl Side {
    fn exists(&self) -> bool {
        self.mode.iter().any(|digit| *digit != b'0')
    }

    fn blob(&self) -> Result<Option<Oid>, RepositoryError> {
        self.exists()
            .then(|| Oid::try_from(git::text(&self.oid)).map_err(|_| git::malformed()))
            .transpose()
    }
}

impl Change {
    /// Git shows a change of type as a deletion and an addition.
    fn blocks(&self) -> usize {
        match self.status {
            RangeStatus::TypeChanged => 2,
            _ => 1,
        }
    }
}

fn file(change: &Change, counts: Option<(u64, u64)>) -> Result<RangeFile, RepositoryError> {
    let left = if change.new.exists() {
        &change.new
    } else {
        &change.old
    };
    Ok(RangeFile {
        path: git::text(&change.path),
        status: change.status,
        from: change.from.as_ref().map(|(path, _)| git::text(path)),
        similarity: change.from.as_ref().map(|(_, similarity)| *similarity),
        added: counts.map(|(added, _)| added),
        deleted: counts.map(|(_, deleted)| deleted),
        old_blob: change.old.blob()?,
        new_blob: change.new.blob()?,
        submodule: left.mode == b"160000",
    })
}

fn malformed() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

fn unreadable(error: io::Error) -> RepositoryError {
    if error.kind() == io::ErrorKind::InvalidData {
        git::malformed()
    } else {
        git::read_failed()
    }
}

fn field(output: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut field = Vec::new();
    output.read_until(0, &mut field)?;
    if field.pop() != Some(0) {
        return Err(malformed());
    }
    Ok(field)
}

/// Reads `--raw -z` records up to the first byte that starts none.
fn changes(output: &mut impl BufRead) -> io::Result<Vec<Change>> {
    let mut changes = Vec::new();
    while output.fill_buf()?.first() == Some(&b':') {
        let record = field(output)?;
        let columns: Vec<_> = record[1..].split(|byte| *byte == b' ').collect();
        let [old_mode, new_mode, old_oid, new_oid, status] = columns[..] else {
            return Err(malformed());
        };
        let side = |mode: &[u8], oid: &[u8]| Side {
            mode: mode.to_vec(),
            oid: oid.to_vec(),
        };
        let (status, from) = match status {
            b"A" => (RangeStatus::Added, None),
            b"D" => (RangeStatus::Deleted, None),
            b"M" => (RangeStatus::Modified, None),
            b"T" => (RangeStatus::TypeChanged, None),
            [b'R', similarity @ ..] => {
                let similarity = number(similarity)?;
                (RangeStatus::Renamed, Some((field(output)?, similarity)))
            }
            _ => return Err(malformed()),
        };
        changes.push(Change {
            path: field(output)?,
            from,
            status,
            old: side(old_mode, old_oid),
            new: side(new_mode, new_oid),
        });
    }
    Ok(changes)
}

/// Reads the `--numstat -z` record of `change`, which has no counts for a
/// binary file.
fn counts(output: &mut impl BufRead, change: &Change) -> io::Result<Option<(u64, u64)>> {
    let record = field(output)?;
    let mut columns = record.splitn(3, |byte| *byte == b'\t');
    let (Some(added), Some(deleted), Some(path)) = (columns.next(), columns.next(), columns.next())
    else {
        return Err(malformed());
    };
    let path = match &change.from {
        None => path.to_vec(),
        Some((from, _)) if path.is_empty() && field(output)? == *from => field(output)?,
        Some(_) => return Err(malformed()),
    };
    if path != change.path {
        return Err(malformed());
    }
    Ok(match (added, deleted) {
        (b"-", b"-") => None,
        _ => Some((number(added)?, number(deleted)?)),
    })
}

fn number<T: std::str::FromStr>(digits: &[u8]) -> io::Result<T> {
    std::str::from_utf8(digits)
        .ok()
        .and_then(|digits| digits.parse().ok())
        .ok_or_else(malformed)
}

struct Patches {
    changes: Vec<Change>,
    /// Of the first changes, up to the limit.
    patches: Vec<FilePatch>,
}

/// `None` when Git failed.
fn patches(
    root: &Path,
    args: &[String],
    limit: usize,
    deadline: Deadline,
) -> Result<Option<Patches>, RepositoryError> {
    let (read, succeeded) = git::run_reading(root, &strs(args), deadline, move |stdout| {
        Ok(read_patches(&mut BufReader::new(stdout), limit))
    })?;
    match read {
        Ok(read) if succeeded || read.patches.len() < read.changes.len() => Ok(Some(read)),
        Err(error) if succeeded => Err(unreadable(error)),
        _ => Ok(None),
    }
}

fn strs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

/// Every line of a hunk starts with a space, a sign, or a backslash, and a
/// header quotes a path's newlines, so only a block's first line starts with
/// `BLOCK`. A line can be longer than memory allows, so it arrives in pieces.
fn read_patches(output: &mut impl BufRead, limit: usize) -> io::Result<Patches> {
    let changes = changes(output)?;
    if !changes.is_empty() && !field(output)?.is_empty() {
        return Err(malformed());
    }
    let mut patches = Vec::with_capacity(changes.len());
    let mut kept = 0;
    let mut open: Option<Open> = None;
    let mut piece = Vec::new();
    let mut line_start = true;
    loop {
        piece.clear();
        output.take(PIECE).read_until(b'\n', &mut piece)?;
        let first = line_start && piece.starts_with(BLOCK);
        match &mut open {
            Some(open) if first && open.blocks_left > 0 => open.next_block(),
            _ if first || piece.is_empty() => {
                if let Some(open) = open.take() {
                    let patch = open.finish()?;
                    if let FilePatch::Text { patch, .. } = &patch {
                        kept += patch.len();
                    }
                    if kept > limit {
                        break;
                    }
                    patches.push(patch);
                }
                if piece.is_empty() {
                    if patches.len() != changes.len() {
                        return Err(malformed());
                    }
                    break;
                }
                let change = changes.get(patches.len()).ok_or_else(malformed)?;
                open = Some(Open::new(change.blocks()));
            }
            _ => {}
        }
        open.as_mut().ok_or_else(malformed)?.add(&piece, line_start);
        line_start = piece.ends_with(b"\n");
    }
    Ok(Patches { changes, patches })
}

/// The patch being read.
struct Open {
    blocks_left: usize,
    in_header: bool,
    binary: bool,
    bytes: u64,
    /// Empty once `bytes` passes the limit.
    kept: Vec<u8>,
}

impl Open {
    fn new(blocks: usize) -> Self {
        Self {
            blocks_left: blocks - 1,
            in_header: true,
            binary: false,
            bytes: 0,
            kept: Vec::new(),
        }
    }

    fn next_block(&mut self) {
        self.blocks_left -= 1;
        self.in_header = true;
    }

    fn add(&mut self, piece: &[u8], line_start: bool) {
        if self.in_header && line_start {
            self.in_header = !piece.starts_with(b"@@ ");
            self.binary |= self.in_header && piece.starts_with(b"Binary files ");
        }
        self.bytes += piece.len() as u64;
        if self.bytes <= PATCH_LIMIT as u64 {
            self.kept.extend_from_slice(piece);
        } else {
            self.kept = Vec::new();
        }
    }

    fn finish(self) -> io::Result<FilePatch> {
        if self.blocks_left > 0 {
            return Err(malformed());
        }
        Ok(if self.binary {
            FilePatch::Binary
        } else if self.bytes > PATCH_LIMIT as u64 {
            FilePatch::TooLarge { bytes: self.bytes }
        } else {
            text_patch(&self.kept)
        })
    }
}
