use crate::{
    Blame, BlameRange, Commit, ErrorKind, FileRevision, RepositoryError,
    git::{self, Deadline, LocalRead},
    repository::{COMMIT_FORMAT, PATCH_LIMIT, non_utf8_path, parse_commits, root, verify_commit},
};
use std::{collections::HashMap, path::Path};

const BLAME_LIMIT: usize = 16 * PATCH_LIMIT;
const BINARY_PROBE: usize = 8000;

pub fn file_history(
    path: &str,
    oid: &str,
    file: &str,
) -> Result<Vec<FileRevision>, RepositoryError> {
    file_history_within(path, oid, file, Deadline::of(LocalRead::FileHistory))
}

pub fn blame(path: &str, oid: &str, file: &str) -> Result<Blame, RepositoryError> {
    blame_within(path, oid, file, Deadline::of(LocalRead::Blame))
}

pub(crate) fn file_history_within(
    path: &str,
    oid: &str,
    file: &str,
    deadline: Deadline,
) -> Result<Vec<FileRevision>, RepositoryError> {
    let root = root(path, deadline)?;
    verify_commit(&root, oid, deadline)?;
    if file.is_empty() {
        return Err(missing_file());
    }
    if file.contains(char::REPLACEMENT_CHARACTER) {
        return Err(non_utf8_path());
    }
    let output = git::read(
        &root,
        &[
            "--literal-pathspecs",
            "log",
            "--follow",
            COMMIT_FORMAT,
            "-z",
            "--name-only",
            "--no-ext-diff",
            "--no-textconv",
            oid,
            "--",
            file,
        ],
        deadline,
    )?;
    revisions(&output, file)
}

/// Each record is the six commit fields, then a field holding a newline and
/// the file's path in that commit. Merges print no path, so they keep the
/// path of the newer revision.
fn revisions(output: &[u8], file: &str) -> Result<Vec<FileRevision>, RepositoryError> {
    let mut fields = output.split(|byte| *byte == 0).peekable();
    let mut records = Vec::new();
    let mut paths = Vec::new();
    let mut path = file.to_owned();
    while fields.peek().is_some_and(|field| !field.is_empty()) {
        for _ in 0..6 {
            records.extend_from_slice(fields.next().ok_or_else(git::malformed)?);
            records.push(0);
        }
        if let Some(named) = fields.next_if(|field| field.first() == Some(&b'\n')) {
            path = git::text(&named[1..]);
        }
        paths.push(path.clone());
    }
    if fields.any(|field| !field.is_empty()) {
        return Err(git::malformed());
    }
    Ok(parse_commits(&records)?
        .into_iter()
        .zip(paths)
        .map(|(commit, path)| FileRevision { commit, path })
        .collect())
}

pub(crate) fn blame_within(
    path: &str,
    oid: &str,
    file: &str,
    deadline: Deadline,
) -> Result<Blame, RepositoryError> {
    let root = root(path, deadline)?;
    verify_commit(&root, oid, deadline)?;
    if file.is_empty() {
        return Err(missing_file());
    }
    if file.contains(char::REPLACEMENT_CHARACTER) {
        return Err(non_utf8_path());
    }
    let entry = git::read(
        &root,
        &[
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            "-l",
            "--full-tree",
            oid,
            "--",
            file,
        ],
        deadline,
    )?;
    let entry = tree_entry(&entry, file)?.ok_or_else(missing_file)?;
    match entry.kind {
        b"blob" => {}
        b"commit" => {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "This is a submodule. L1 Git does not blame the files inside it.",
            ));
        }
        _ => return Err(missing_file()),
    }
    if entry.bytes > PATCH_LIMIT as u64 {
        return Ok(Blame::TooLarge { bytes: entry.bytes });
    }
    let object = git::text(entry.object);
    let contents =
        match git::read_capped(&root, &["cat-file", "blob", &object], PATCH_LIMIT, deadline)? {
            git::Capped::Within(contents) => contents,
            git::Capped::Over(bytes) => return Ok(Blame::TooLarge { bytes }),
        };
    if contents[..contents.len().min(BINARY_PROBE)].contains(&0) {
        return Ok(Blame::Binary);
    }
    let ranges = if contents.is_empty() {
        Vec::new()
    } else {
        let output = match git::read_capped(
            &root,
            &[
                "blame",
                "--porcelain",
                "--no-textconv",
                "--no-ignore-revs-file",
                oid,
                "--",
                file,
            ],
            BLAME_LIMIT,
            deadline,
        )? {
            git::Capped::Within(output) => output,
            git::Capped::Over(_) => {
                return Ok(Blame::TooLarge { bytes: entry.bytes });
            }
        };
        credited(&root, porcelain(&output)?, deadline)?
    };
    Ok(Blame::Text {
        lossy: std::str::from_utf8(&contents).is_err(),
        contents: git::text(&contents),
        ranges,
    })
}

fn missing_file() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnsupportedPath,
        "This file is not in the selected commit, so it has no lines to blame. Choose a commit that has the file.",
    )
}

struct TreeEntry<'a> {
    kind: &'a [u8],
    object: &'a [u8],
    bytes: u64,
}

/// `ls-tree -l` prints `<mode> <type> <object> <size>\t<path>`.
fn tree_entry<'a>(output: &'a [u8], file: &str) -> Result<Option<TreeEntry<'a>>, RepositoryError> {
    for record in output.split(|byte| *byte == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(git::malformed)?;
        if &record[tab + 1..] != file.as_bytes() {
            continue;
        }
        let mut columns = record[..tab]
            .split(|byte| *byte == b' ')
            .filter(|column| !column.is_empty());
        let (Some(_mode), Some(kind), Some(object), Some(size)) = (
            columns.next(),
            columns.next(),
            columns.next(),
            columns.next(),
        ) else {
            return Err(git::malformed());
        };
        let bytes = std::str::from_utf8(size)
            .ok()
            .and_then(|size| size.parse().ok())
            .unwrap_or(0);
        return Ok(Some(TreeEntry {
            kind,
            object,
            bytes,
        }));
    }
    Ok(None)
}

/// Each porcelain group starts with `<oid> <original line> <final line>`,
/// then key-value lines, then the line's text after a tab.
fn porcelain(output: &[u8]) -> Result<Vec<(String, u32, u32)>, RepositoryError> {
    let mut ranges: Vec<(String, u32, u32)> = Vec::new();
    let mut header = true;
    for line in output.split(|byte| *byte == b'\n') {
        if header {
            if line.is_empty() {
                continue;
            }
            let text = std::str::from_utf8(line).map_err(|_| git::malformed())?;
            let mut columns = text.split(' ');
            let (Some(oid), Some(_), Some(start)) =
                (columns.next(), columns.next(), columns.next())
            else {
                return Err(git::malformed());
            };
            let start: u32 = start.parse().map_err(|_| git::malformed())?;
            match ranges.last_mut() {
                Some((last, first, lines)) if last == oid && *first + *lines == start => {
                    *lines += 1;
                }
                _ => ranges.push((oid.to_owned(), start, 1)),
            }
            header = false;
        } else if line.starts_with(b"\t") {
            header = true;
        }
    }
    if !header {
        return Err(git::malformed());
    }
    Ok(ranges)
}

/// Names each range's commit with the history's own format, so Blame and the
/// graph show the same author.
fn credited(
    root: &Path,
    ranges: Vec<(String, u32, u32)>,
    deadline: Deadline,
) -> Result<Vec<BlameRange>, RepositoryError> {
    let mut oids: Vec<&str> = ranges.iter().map(|(oid, ..)| oid.as_str()).collect();
    oids.sort_unstable();
    oids.dedup();
    let output = git::read_with_input(
        root,
        &["log", "--no-walk=unsorted", COMMIT_FORMAT, "-z", "--stdin"],
        oids.iter()
            .flat_map(|oid| format!("{oid}\n").into_bytes())
            .collect(),
        deadline,
    )?;
    let commits: HashMap<String, Commit> = parse_commits(&output)?
        .into_iter()
        .map(|commit| (commit.oid.clone(), commit))
        .collect();
    ranges
        .into_iter()
        .map(|(oid, start, lines)| {
            let commit = commits.get(&oid).ok_or_else(git::malformed)?;
            Ok(BlameRange {
                start,
                lines,
                author: commit.author.clone(),
                email: commit.email.clone(),
                timestamp: commit.timestamp,
                summary: commit.subject.clone(),
                oid,
            })
        })
        .collect()
}
