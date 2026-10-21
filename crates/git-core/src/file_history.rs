use crate::{
    Blame, BlameRange, ErrorKind, FileRevision, RepositoryError,
    git::{self, Deadline},
    repository::{COMMIT_FORMAT, PATCH_LIMIT, non_utf8_path, parse_commits, root, verify_commit},
};
use std::collections::HashMap;

const BLAME_LIMIT: usize = 16 * PATCH_LIMIT;
const BINARY_PROBE: usize = 8000;

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
    let (kind, bytes) = tree_entry(&entry, file)?.ok_or_else(missing_file)?;
    match kind {
        b"blob" => {}
        b"commit" => {
            return Err(RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "This is a submodule. L1 Git does not blame the files inside it.",
            ));
        }
        _ => return Err(missing_file()),
    }
    if bytes > PATCH_LIMIT as u64 {
        return Ok(Blame::TooLarge { bytes });
    }
    let output = match git::read_capped(
        &root,
        &["blame", "--porcelain", "--no-textconv", oid, "--", file],
        BLAME_LIMIT,
        deadline,
    )? {
        git::Capped::Within(output) => output,
        git::Capped::Over(_) => return Ok(Blame::TooLarge { bytes }),
    };
    porcelain(&output)
}

fn missing_file() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnsupportedPath,
        "This file is not in the selected commit, so it has no lines to blame. Choose a commit that has the file.",
    )
}

/// `ls-tree -l` prints `<mode> <type> <object> <size>\t<path>`.
fn tree_entry<'a>(
    output: &'a [u8],
    file: &str,
) -> Result<Option<(&'a [u8], u64)>, RepositoryError> {
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
        let (Some(_mode), Some(kind), Some(_object), Some(size)) = (
            columns.next(),
            columns.next(),
            columns.next(),
            columns.next(),
        ) else {
            return Err(git::malformed());
        };
        let size = std::str::from_utf8(size)
            .ok()
            .and_then(|size| size.parse().ok())
            .unwrap_or(0);
        return Ok(Some((kind, size)));
    }
    Ok(None)
}

#[derive(Default)]
struct Author {
    name: String,
    email: String,
    time: i64,
    summary: String,
}

fn porcelain(output: &[u8]) -> Result<Blame, RepositoryError> {
    let mut authors: HashMap<String, Author> = HashMap::new();
    let mut ranges: Vec<BlameRange> = Vec::new();
    let mut contents = Vec::new();
    let mut current: Option<(String, u32)> = None;
    let mut lines = output.split(|byte| *byte == b'\n').peekable();
    while let Some(line) = lines.next() {
        if line.is_empty() && lines.peek().is_none() {
            break;
        }
        if let Some(content) = line.strip_prefix(b"\t") {
            let (oid, final_line) = current.take().ok_or_else(git::malformed)?;
            contents.extend_from_slice(content);
            contents.push(b'\n');
            match ranges.last_mut() {
                Some(range) if range.oid == oid && range.start + range.lines == final_line => {
                    range.lines += 1;
                }
                _ => ranges.push(BlameRange {
                    oid,
                    start: final_line,
                    lines: 1,
                    author: String::new(),
                    email: String::new(),
                    timestamp: 0,
                    summary: String::new(),
                }),
            }
            continue;
        }
        if current.is_none() {
            let text = std::str::from_utf8(line).map_err(|_| git::malformed())?;
            let mut columns = text.split(' ');
            let (Some(oid), Some(_), Some(final_line)) =
                (columns.next(), columns.next(), columns.next())
            else {
                return Err(git::malformed());
            };
            let final_line = final_line.parse().map_err(|_| git::malformed())?;
            authors.entry(oid.to_owned()).or_default();
            current = Some((oid.to_owned(), final_line));
            continue;
        }
        let (oid, _) = current.as_ref().ok_or_else(git::malformed)?;
        let author = authors.get_mut(oid).ok_or_else(git::malformed)?;
        let (key, value) = match line.iter().position(|byte| *byte == b' ') {
            Some(space) => (&line[..space], &line[space + 1..]),
            None => (line, &line[line.len()..]),
        };
        match key {
            b"author" => author.name = git::text(value),
            b"author-mail" => {
                author.email = git::text(value)
                    .trim_start_matches('<')
                    .trim_end_matches('>')
                    .to_owned();
            }
            b"author-time" => {
                author.time = git::text(value).parse().map_err(|_| git::malformed())?;
            }
            b"summary" => author.summary = git::text(value),
            _ => {}
        }
    }
    if current.is_some() {
        return Err(git::malformed());
    }
    if contents[..contents.len().min(BINARY_PROBE)].contains(&0) {
        return Ok(Blame::Binary);
    }
    for range in &mut ranges {
        let author = &authors[&range.oid];
        range.author.clone_from(&author.name);
        range.email.clone_from(&author.email);
        range.timestamp = author.time;
        range.summary.clone_from(&author.summary);
    }
    Ok(Blame::Text {
        lossy: std::str::from_utf8(&contents).is_err(),
        contents: git::text(&contents),
        ranges,
    })
}
