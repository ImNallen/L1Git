mod output;

use crate::{
    Base, Comparison, ErrorKind, FilePatch, Oid, PatchContext, RepositoryError, Target,
    git::{self, Deadline, LocalRead},
    repository::{PATCH_LIMIT, non_utf8_path, root, unavailable_commit, unchanged_path},
};
use output::{Change, Limit, Patches, changes, counts, read_patches, unreadable};
use serde::Serialize;
use std::{
    io::{self, BufReader},
    iter,
    path::Path,
};

/// The patches of one range together. A patch over `PATCH_LIMIT` does not count.
pub const RANGE_PATCH_LIMIT: usize = 8 * PATCH_LIMIT;
const RENAMES: &str = "--find-renames=50%";
/// Pairs files by their blob ids alone, so it reads no contents.
const EXACT_RENAMES: &str = "--find-renames=100%";
const NO_RENAMES: &str = "--no-renames";

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
        /// The clone is shallow, so `merge_base` can be older than the commit
        /// where `head` really forked.
        shallow: bool,
    },
    /// A partial clone that does not have the folders of these commits.
    TreesMissing,
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
    let shallow = git::read(&root, &["rev-parse", "--is-shallow-repository"], deadline)?;
    let shallow = git::line(&shallow) == "true";
    let found = git::run_objects(
        &root,
        &["merge-base", base.as_str(), head.as_str()],
        deadline,
    )?;
    let merge_base = match found.status.code() {
        Some(0) => Oid::try_from(git::line(&found.stdout))?,
        Some(1) => return Ok(RangeFiles::Unrelated { shallow }),
        _ => return Err(git::read_failed()),
    };
    let ends = [&merge_base, head];
    let counted = git::run_objects(
        &root,
        &strs(&args(ends, RENAMES, &["--raw", "--numstat"], &[])),
        deadline,
    )?;
    let content_missing = !counted.status.success();
    let files = if content_missing {
        let Some(changes) = names(&root, ends, deadline)? else {
            return if partial(&root, deadline)? {
                Ok(RangeFiles::TreesMissing)
            } else {
                Err(git::read_failed())
            };
        };
        changes
            .iter()
            .map(|change| file(change, None))
            .collect::<Result<_, _>>()?
    } else {
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
    };
    Ok(RangeFiles::Ready {
        merge_base,
        files,
        content_missing,
        shallow,
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
    let ends = [merge_base, head];
    verify(&root, ends, deadline)?;
    let formats = ["--raw", PatchContext::Hunks.patch_format()];
    let limit = Limit {
        bytes: RANGE_PATCH_LIMIT,
        files: usize::MAX,
    };
    let args = args(ends, RENAMES, &formats, &[]);
    let (changes, patches) = match patches(&root, &args, limit, deadline)? {
        Some(read) => (read.changes, read.patches),
        None => (
            names(&root, ends, deadline)?.ok_or_else(git::read_failed)?,
            Vec::new(),
        ),
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

/// One file of the range between two commits, as `range_patches` reads it.
/// `from` is `file` itself unless the file was renamed.
pub(crate) fn range_patch_within(
    path: &str,
    comparison: &Comparison,
    from: &str,
    file: &str,
    context: PatchContext,
    deadline: Deadline,
) -> Result<FilePatch, RepositoryError> {
    let (Base::Commit { oid: base }, Target::Commit { oid: head }) =
        (&comparison.base, &comparison.target)
    else {
        return Err(RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "L1 Git reads a file with its old path only between two commits.",
        ));
    };
    let root = root(path, deadline)?;
    let ends = [&Oid::try_from(base.clone())?, &Oid::try_from(head.clone())?];
    verify(&root, ends, deadline)?;
    if file.is_empty() || from.is_empty() {
        return Err(unchanged_path(comparison));
    }
    let formats = ["--raw", context.patch_format()];
    let find = |args: &[String], files| -> Result<_, RepositoryError> {
        let limit = Limit {
            bytes: usize::MAX,
            files,
        };
        let read = patches(&root, args, limit, deadline)?;
        Ok(read.map(|read| {
            iter::zip(read.changes, read.patches)
                .find(|(change, _)| {
                    change.path == file.as_bytes()
                        && match &change.from {
                            None => from == file,
                            Some((old, _)) => old == from.as_bytes(),
                        }
                })
                .map(|(_, patch)| patch)
        }))
    };
    let found = if from == file {
        let alone = args(ends, NO_RENAMES, &formats, &[file]);
        find(&alone, usize::MAX)?.ok_or_else(git::read_failed)?
    } else {
        match find(&args(ends, RENAMES, &formats, &[from, file]), usize::MAX)? {
            Some(Some(patch)) => Some(patch),
            // A path also takes in the files of a folder with its name, and one
            // of them can pair up instead. Git then lists the whole range from
            // that file on, and stops after it. It fails when there is none.
            alone => {
                let skip = format!("--skip-to={file}");
                let whole = args(ends, RENAMES, &[formats[0], formats[1], &skip], &[]);
                match (find(&whole, 1)?, alone) {
                    (Some(found), _) => found,
                    (None, Some(_)) => None,
                    (None, None) => return Err(git::read_failed()),
                }
            }
        }
    };
    found.ok_or_else(|| {
        if [from, file]
            .iter()
            .any(|path| path.contains(char::REPLACEMENT_CHARACTER))
        {
            non_utf8_path()
        } else {
            unchanged_path(comparison)
        }
    })
}

/// Pins whatever a person's configuration could change, so a range reads the
/// same everywhere. GitHub ignores attributes, so they come from an empty tree.
fn args(ends: [&Oid; 2], renames: &str, formats: &[&str], paths: &[&str]) -> Vec<String> {
    let [base, head] = ends.map(Oid::as_str);
    let attributes = format!(
        "--attr-source={}",
        match head.len() {
            64 => "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
            _ => "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        }
    );
    let mut args = vec![
        "-c",
        "core.attributesFile=",
        "-c",
        "core.bigFileThreshold=512m",
        // Git on macOS would otherwise compose the decomposed names in `paths`.
        "-c",
        "core.precomposeUnicode=false",
        "-c",
        "diff.default.binary=auto",
        // What Git itself takes as the heading of a hunk.
        "-c",
        "diff.default.xfuncname=^([A-Za-z_$].*)$",
        &attributes,
        "--literal-pathspecs",
        "diff-tree",
        "--no-commit-id",
        "-r",
        "-z",
        "--no-abbrev",
        "--full-index",
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

fn verify(root: &Path, ends: [&Oid; 2], deadline: Deadline) -> Result<(), RepositoryError> {
    if missing(root, &ends, deadline)?.is_empty() {
        Ok(())
    } else {
        Err(unavailable_commit())
    }
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

/// The changes of a range without reading any file's contents, or `None` when
/// Git failed.
fn names(
    root: &Path,
    ends: [&Oid; 2],
    deadline: Deadline,
) -> Result<Option<Vec<Change>>, RepositoryError> {
    let args = args(ends, EXACT_RENAMES, &["--raw"], &[]);
    let listed = git::run_objects(root, &strs(&args), deadline)?;
    if !listed.status.success() {
        return Ok(None);
    }
    changes(&mut listed.stdout.as_slice())
        .map(Some)
        .map_err(unreadable)
}

fn partial(root: &Path, deadline: Deadline) -> Result<bool, RepositoryError> {
    let promisors = ["config", "--get-regexp", r"^remote\..*\.promisor$"];
    Ok(git::run(root, &promisors, deadline)?.status.success())
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

/// `None` when Git failed.
fn patches(
    root: &Path,
    args: &[String],
    limit: Limit,
    deadline: Deadline,
) -> Result<Option<Patches>, RepositoryError> {
    let (read, succeeded) = git::run_objects_reading(root, &strs(args), deadline, move |stdout| {
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
