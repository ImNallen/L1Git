use super::{
    Applied, Direction, Expect, Repo, Restored, Writing,
    files::{self, Content, FileChange, Stat},
    index::{self, IndexChange, IndexEntry},
    resolution,
    store::{self, EntryObjects, Objects},
    txn::{Published, Txn},
};
use crate::{
    CONFLICT_TEXT_LIMIT, ConflictKeep, ConflictSide, ConflictSummary, ConflictUnsupported,
    ConflictVersion, Head, Mode, Oid, RepositoryError, WholeFileConflict, WholeFileDisk,
    WholeFileShape, WholeFileSide,
    git::{self, Deadline, WriteDeadline},
    repository,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io};

const RESOLVE: files::Verb = files::Verb {
    verb: "resolve",
    verbing: "resolving",
    capital: "Resolve",
};

/// Git calls a file binary when its first 8000 bytes hold a NUL.
const BINARY_PROBE: usize = 8000;

const BATCH_BYTES: u64 = 8 * 1024 * 1024;

const HASH_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Parent {
    Folder(Option<(u64, u64)>),
    Missing,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WholeChange {
    index: IndexChange,
    scope: Vec<Parent>,
    pub(super) file: FileChange,
}

impl WholeChange {
    pub(super) fn objects(&self) -> Objects {
        Objects::exact(self.index.objects())
    }
}

struct Side {
    row: IndexEntry,
    shown: ConflictSide,
}

struct Whole {
    version: ConflictVersion,
    shape: WholeFileShape,
    current: Option<Side>,
    incoming: Option<Side>,
    disk: WholeFileDisk,
    rows: Vec<IndexEntry>,
    stat: Option<Stat>,
    scope: Vec<Parent>,
}

enum Classified {
    Text(u32),
    Whole(Box<Whole>),
    External(ConflictUnsupported),
}

struct Seen {
    head: Head,
    attributes: BTreeMap<String, Vec<u8>>,
    config: Vec<u8>,
    sizes: BTreeMap<Oid, u64>,
    blobs: BTreeMap<Oid, Result<(), ConflictUnsupported>>,
    links: BTreeMap<Oid, Vec<u8>>,
}

pub(crate) fn conflict_summary_within(
    path: &str,
    deadline: Deadline,
) -> Result<Vec<ConflictSummary>, RepositoryError> {
    let repo = Repo::open(path, deadline)?;
    Ok(classify_all(&repo, None, deadline)?
        .1
        .into_iter()
        .map(|(path, classified)| match classified {
            Classified::Text(conflicts) => ConflictSummary::Text { path, conflicts },
            Classified::Whole(whole) => ConflictSummary::WholeFile {
                path,
                version: whole.version,
                shape: whole.shape,
                current: whole.current.map(|side| side.shown),
                incoming: whole.incoming.map(|side| side.shown),
                disk: whole.disk,
            },
            Classified::External(reason) => ConflictSummary::External { path, reason },
        })
        .collect())
}

pub(crate) fn whole_file_within(
    path: &str,
    file: &str,
    deadline: Deadline,
) -> Result<Option<WholeFileConflict>, RepositoryError> {
    let repo = Repo::open(path, deadline)?;
    crate::status::check(file)?;
    let (head, mut classified) = classify_all(&repo, Some(file), deadline)?;
    let Some((_, Classified::Whole(whole))) = classified.pop() else {
        return Ok(None);
    };
    let texts = texts(&repo, &whole.rows, deadline)?;
    let text = |stage: u8| {
        whole
            .rows
            .iter()
            .find(|row| row.stage == stage)
            .and_then(|row| texts.get(&row.oid).cloned())
    };
    let shown = |side: Option<&Side>, stage| {
        side.map(|side| WholeFileSide {
            mode: side.shown.mode,
            size: side.shown.size,
            text: text(stage),
        })
    };
    Ok(Some(WholeFileConflict {
        head,
        version: whole.version.clone(),
        shape: whole.shape,
        base: text(1),
        current: shown(whole.current.as_ref(), 2),
        incoming: shown(whole.incoming.as_ref(), 3),
        disk: whole.disk,
    }))
}

fn texts(
    repo: &Repo,
    rows: &[IndexEntry],
    deadline: Deadline,
) -> Result<BTreeMap<Oid, String>, RepositoryError> {
    let oids: Vec<&Oid> = rows
        .iter()
        .filter(|row| row.mode != Mode::Submodule)
        .map(|row| &row.oid)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let sizes = sizes(repo, &oids, deadline)?;
    let wanted: Vec<&Oid> = oids
        .into_iter()
        .filter(|oid| sizes[*oid] <= CONFLICT_TEXT_LIMIT as u64)
        .collect();
    let keep = wanted.iter().copied().collect();
    let (_, bytes) = blobs(repo, &wanted, &sizes, &keep, deadline)?;
    Ok(bytes
        .into_iter()
        .filter(|(_, bytes)| !bytes.contains(&0))
        .filter_map(|(oid, bytes)| Some((oid, String::from_utf8(bytes).ok()?)))
        .collect())
}

fn classify_all(
    repo: &Repo,
    only: Option<&str>,
    deadline: Deadline,
) -> Result<(Head, Vec<(String, Classified)>), RepositoryError> {
    let head = repository::head(&repo.root, deadline)?;
    let (rows, _) = index::read_worktree(&repo.root, deadline)?;
    let mut unmerged = Vec::new();
    for (path, entries) in &rows {
        if entries.iter().all(|entry| entry.stage == 0) {
            continue;
        }
        let path = str::from_utf8(path).map_err(|_| repository::non_utf8_path())?;
        if only.is_none_or(|only| only == path) {
            unmerged.push((path.to_owned(), entries.as_slice()));
        }
    }
    if unmerged.is_empty() {
        return Ok((head, Vec::new()));
    }
    let seen = read_seen(repo, head.clone(), &unmerged, deadline)?;
    let mut classified = unmerged
        .into_iter()
        .map(|(path, target)| {
            let classified = classify(repo, &seen, &path, target)?;
            Ok((path, classified))
        })
        .collect::<Result<Vec<_>, RepositoryError>>()?;
    let hashed = hash_files(
        repo,
        classified
            .iter()
            .filter_map(|(path, classified)| match classified {
                Classified::Whole(_) => Some(path.as_str()),
                Classified::Text(_) | Classified::External(_) => None,
            }),
        deadline,
    )?;
    for (path, classified) in &mut classified {
        if let Classified::Whole(whole) = classified {
            whole.disk = disk(repo, &seen, path, whole, hashed.get(path))?;
        }
    }
    Ok((head, classified))
}

/// Hashes each regular file within `HASH_LIMIT` as `git add` would store it,
/// in one `hash-object`, which writes no object. A name that the line-based
/// input cannot carry is left out.
fn hash_files<'p>(
    repo: &Repo,
    paths: impl Iterator<Item = &'p str>,
    deadline: Deadline,
) -> Result<BTreeMap<String, Oid>, RepositoryError> {
    let hashable: Vec<&str> = paths
        .filter(|path| !path.contains('\n') && !path.starts_with('"'))
        .filter(|path| {
            fs::symlink_metadata(repo.root.join(path))
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= HASH_LIMIT)
        })
        .collect();
    if hashable.is_empty() {
        return Ok(BTreeMap::new());
    }
    let input: Vec<u8> = hashable
        .iter()
        .flat_map(|path| path.bytes().chain([b'\n']))
        .collect();
    let output = git::read_with_input(
        &repo.root,
        &["hash-object", "--stdin-paths"],
        input,
        deadline,
    )?;
    let oids: Vec<Oid> = git::text(&output)
        .lines()
        .map(|line| Oid::try_from(line.to_owned()).map_err(|_| git::malformed()))
        .collect::<Result<_, _>>()?;
    if oids.len() != hashable.len() {
        return Err(git::malformed());
    }
    Ok(hashable.into_iter().map(str::to_owned).zip(oids).collect())
}

fn config_value<'c>(config: &'c [u8], key: &str) -> Option<&'c [u8]> {
    config.split(|byte| *byte == 0).rev().find_map(|record| {
        let at = record.iter().position(|byte| *byte == b'\n')?;
        record[..at]
            .eq_ignore_ascii_case(key.as_bytes())
            .then(|| &record[at + 1..])
    })
}

fn converts(attributes: &[u8], config: &[u8]) -> bool {
    let fields: Vec<_> = attributes.split(|byte| *byte == 0).collect();
    let attribute = fields.chunks_exact(3).any(|field| {
        [b"text".as_slice(), b"eol"].contains(&field[1])
            && ![b"unspecified".as_slice(), b"unset"].contains(&field[2])
    });
    attribute
        || config_value(config, "core.autocrlf").is_some_and(|value| {
            !value.eq_ignore_ascii_case(b"false") && !value.is_empty() && value != b"0"
        })
}

fn same_mode(metadata: &fs::Metadata, mode: Mode, config: &[u8]) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let filemode = config_value(config, "core.filemode")
            .is_none_or(|value| !value.eq_ignore_ascii_case(b"false") && value != b"0");
        !filemode || (metadata.permissions().mode() & 0o100 != 0) == (mode == Mode::Executable)
    }
    #[cfg(not(unix))]
    {
        let _ = (metadata, mode, config);
        true
    }
}

fn disk(
    repo: &Repo,
    seen: &Seen,
    path: &str,
    whole: &Whole,
    hashed: Option<&Oid>,
) -> Result<WholeFileDisk, RepositoryError> {
    let sides = [
        (whole.current.as_ref(), WholeFileDisk::MatchesCurrent),
        (whole.incoming.as_ref(), WholeFileDisk::MatchesIncoming),
    ];
    let file = repo.root.join(path);
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(sides
                .into_iter()
                .find_map(|(side, matched)| side.is_none().then_some(matched))
                .unwrap_or(WholeFileDisk::Missing));
        }
        Err(error) => return Err(files::failed(path, &error)),
    };
    let present = || {
        sides
            .into_iter()
            .filter_map(|(side, matched)| Some((side?, matched)))
    };
    if metadata.is_symlink() {
        let target =
            files::link_bytes(fs::read_link(&file).map_err(|error| files::failed(path, &error))?);
        let mut known = true;
        for (side, matched) in present().filter(|(side, _)| side.row.mode == Mode::Symlink) {
            match seen.links.get(&side.row.oid) {
                Some(bytes) if *bytes == target => return Ok(matched),
                Some(_) => {}
                None => known = false,
            }
        }
        return Ok(if known {
            WholeFileDisk::Edited
        } else {
            WholeFileDisk::Unknown
        });
    }
    let files_of = || present().filter(|(side, _)| side.row.mode != Mode::Symlink);
    if let Some(hashed) = hashed {
        return Ok(files_of()
            .find(|(side, _)| {
                side.row.oid == *hashed && same_mode(&metadata, side.row.mode, &seen.config)
            })
            .map_or(WholeFileDisk::Edited, |(_, matched)| matched));
    }
    let attributes = seen.attributes.get(path).map_or(&[][..], Vec::as_slice);
    let differs = !converts(attributes, &seen.config)
        && files_of().all(|(side, _)| side.shown.size != metadata.len());
    Ok(if differs {
        WholeFileDisk::Edited
    } else {
        WholeFileDisk::Unknown
    })
}

fn read_seen(
    repo: &Repo,
    head: Head,
    unmerged: &[(String, &[IndexEntry])],
    deadline: Deadline,
) -> Result<Seen, RepositoryError> {
    let mut args = vec!["check-attr", "-z", "--stdin"];
    args.extend(resolution::TRANSFORM_ATTRIBUTES);
    let listed = git::read_with_input(
        &repo.root,
        &args,
        index::nul_separated(unmerged.iter().map(|(path, _)| path.as_str())),
        deadline,
    )?;
    let mut attributes: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let fields: Vec<_> = listed.split(|byte| *byte == 0).collect();
    for field in fields.chunks_exact(3) {
        let path = String::from_utf8(field[0].to_vec()).map_err(|_| git::malformed())?;
        let kept = attributes.entry(path).or_default();
        for part in field {
            kept.extend_from_slice(part);
            kept.push(0);
        }
    }
    let config = resolution::transform_config(repo, deadline)?;
    let oids: Vec<&Oid> = unmerged
        .iter()
        .flat_map(|(_, entries)| entries.iter())
        .filter(|entry| entry.mode != Mode::Submodule)
        .map(|entry| &entry.oid)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let sizes = sizes(repo, &oids, deadline)?;
    let wanted: Vec<&Oid> = unmerged
        .iter()
        .filter(|(_, entries)| {
            text_candidate(entries).is_some()
                || [2, 3]
                    .iter()
                    .all(|stage| entries.iter().any(|entry| entry.stage == *stage))
        })
        .flat_map(|(_, entries)| entries.iter())
        .filter(|entry| matches!(entry.mode, Mode::File | Mode::Executable))
        .chain(
            unmerged
                .iter()
                .flat_map(|(_, entries)| entries.iter())
                .filter(|entry| entry.mode == Mode::Symlink && entry.stage != 1),
        )
        .map(|entry| &entry.oid)
        .filter(|oid| {
            sizes
                .get(*oid)
                .is_some_and(|size| *size <= CONFLICT_TEXT_LIMIT as u64)
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let links: std::collections::BTreeSet<&Oid> = unmerged
        .iter()
        .flat_map(|(_, entries)| entries.iter())
        .filter(|entry| entry.mode == Mode::Symlink)
        .map(|entry| &entry.oid)
        .collect();
    let (blobs, links) = blobs(repo, &wanted, &sizes, &links, deadline)?;
    Ok(Seen {
        head,
        attributes,
        config,
        sizes,
        blobs,
        links,
    })
}

fn sizes(
    repo: &Repo,
    oids: &[&Oid],
    deadline: Deadline,
) -> Result<BTreeMap<Oid, u64>, RepositoryError> {
    let input: Vec<u8> = oids
        .iter()
        .flat_map(|oid| oid.as_str().bytes().chain([b'\n']))
        .collect();
    let listed = git::read_with_input(
        &repo.root,
        &[
            "cat-file",
            "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        ],
        input,
        deadline,
    )?;
    let mut sizes = BTreeMap::new();
    for line in git::text(&listed).lines() {
        let mut fields = line.split(' ');
        let (Some(oid), Some("blob"), Some(size), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(git::read_failed());
        };
        let oid = Oid::try_from(oid.to_owned()).map_err(|_| git::malformed())?;
        sizes.insert(oid, size.parse().map_err(|_| git::malformed())?);
    }
    if sizes.len() != oids.len() {
        return Err(git::malformed());
    }
    Ok(sizes)
}

type Blobs = (
    BTreeMap<Oid, Result<(), ConflictUnsupported>>,
    BTreeMap<Oid, Vec<u8>>,
);

fn blobs(
    repo: &Repo,
    oids: &[&Oid],
    sizes: &BTreeMap<Oid, u64>,
    keep: &std::collections::BTreeSet<&Oid>,
    deadline: Deadline,
) -> Result<Blobs, RepositoryError> {
    let mut checked = BTreeMap::new();
    let mut kept = BTreeMap::new();
    let mut batches: Vec<Vec<&Oid>> = vec![Vec::new()];
    let mut held = 0;
    for oid in oids {
        let size = sizes[*oid];
        if held + size > BATCH_BYTES && !batches[batches.len() - 1].is_empty() {
            batches.push(Vec::new());
            held = 0;
        }
        held += size;
        batches.last_mut().ok_or_else(git::malformed)?.push(oid);
    }
    for batch in batches.into_iter().filter(|batch| !batch.is_empty()) {
        let input: Vec<u8> = batch
            .iter()
            .flat_map(|oid| oid.as_str().bytes().chain([b'\n']))
            .collect();
        let output = git::read_with_input(&repo.root, &["cat-file", "--batch"], input, deadline)?;
        let mut rest = output.as_slice();
        for oid in batch {
            let end = rest
                .iter()
                .position(|byte| *byte == b'\n')
                .ok_or_else(git::malformed)?;
            let header = git::text(&rest[..end]);
            let size: usize = match header.split(' ').collect::<Vec<_>>()[..] {
                [named, "blob", size] if named == oid.as_str() => {
                    size.parse().map_err(|_| git::malformed())?
                }
                _ => return Err(git::malformed()),
            };
            let body = rest
                .get(end + 1..end + 1 + size)
                .ok_or_else(git::malformed)?;
            if keep.contains(oid) {
                kept.insert(oid.clone(), body.to_vec());
            }
            checked.insert(oid.clone(), resolution::text(body.to_vec()).map(drop));
            rest = rest.get(end + 2 + size..).ok_or_else(git::malformed)?;
        }
    }
    Ok((checked, kept))
}

fn text_candidate(target: &[IndexEntry]) -> Option<[&IndexEntry; 3]> {
    let [base, current, incoming] = target else {
        return None;
    };
    ([base.stage, current.stage, incoming.stage] == [1, 2, 3]
        && target.iter().all(|row| row.mode == base.mode)
        && matches!(base.mode, Mode::File | Mode::Executable))
    .then_some([base, current, incoming])
}

fn classify(
    repo: &Repo,
    seen: &Seen,
    path: &str,
    target: &[IndexEntry],
) -> Result<Classified, RepositoryError> {
    let stage = |number| target.iter().find(|row| row.stage == number);
    let stages: Vec<u8> = target.iter().map(|row| row.stage).collect();
    if !matches!(
        stages.as_slice(),
        [1, 2] | [1, 3] | [2] | [3] | [2, 3] | [1, 2, 3]
    ) || target
        .iter()
        .any(|row| row.intent_to_add || row.skip_worktree || row.assume_unchanged)
    {
        return Ok(Classified::External(ConflictUnsupported::Structural));
    }
    if target.iter().any(|row| row.mode == Mode::Submodule) {
        return Ok(Classified::External(ConflictUnsupported::SpecialFile));
    }
    if under_a_non_folder(repo, path) {
        return Ok(Classified::External(ConflictUnsupported::Structural));
    }
    let attributes = seen.attributes.get(path).map_or(&[][..], Vec::as_slice);
    let mut binary = false;
    if let Some(rows) = text_candidate(target) {
        match text_conflict(repo, seen, path, attributes, rows)? {
            Ok(conflicts) => return Ok(Classified::Text(conflicts)),
            Err(ConflictUnsupported::Binary) => binary = true,
            Err(ConflictUnsupported::TooLarge) if binary_on_disk(repo, path) => binary = true,
            Err(ConflictUnsupported::Structural) => {}
            Err(reason) => return Ok(Classified::External(reason)),
        }
    }
    if !resolution::supported(attributes) {
        return Ok(Classified::External(ConflictUnsupported::Attributes));
    }
    let (base, current, incoming) = (stage(1), stage(2), stage(3));
    let shape = match (base, current, incoming) {
        (_, None, None) => return Ok(Classified::External(ConflictUnsupported::Structural)),
        (Some(_), Some(_), None) => WholeFileShape::DeletedByThem,
        (None, Some(_), None) => WholeFileShape::AddedByUs,
        (Some(_), None, Some(_)) => WholeFileShape::DeletedByUs,
        (None, None, Some(_)) => WholeFileShape::AddedByThem,
        (_, Some(current), Some(incoming)) => {
            if current.mode == Mode::Symlink || incoming.mode == Mode::Symlink {
                WholeFileShape::Symlink
            } else if binary
                || [current, incoming]
                    .iter()
                    .any(|row| seen.blobs.get(&row.oid) == Some(&Err(ConflictUnsupported::Binary)))
                || binary_on_disk(repo, path)
            {
                WholeFileShape::Binary
            } else {
                return Ok(Classified::External(ConflictUnsupported::Structural));
            }
        }
    };
    if cfg!(not(unix)) && target.iter().any(|row| row.mode == Mode::Symlink) {
        return Ok(Classified::External(ConflictUnsupported::SpecialFile));
    }
    let stat = Stat::of(&repo.root.join(path)).map_err(|error| files::failed(path, &error))?;
    if fs::symlink_metadata(repo.root.join(path)).is_ok_and(|metadata| metadata.is_dir()) {
        return Ok(Classified::External(ConflictUnsupported::SpecialFile));
    }
    let side = |row: Option<&IndexEntry>| {
        row.map(|row| {
            Ok(Side {
                row: row.clone(),
                shown: ConflictSide {
                    mode: row.mode,
                    size: *seen.sizes.get(&row.oid).ok_or_else(git::malformed)?,
                },
            })
        })
        .transpose()
    };
    let (current, incoming) = (side(current)?, side(incoming)?);
    let scope = scope(repo, path)?;
    let encoded = serde_json::to_vec(&(
        "whole",
        repo.root(),
        &repo.git_dir,
        path,
        &seen.head,
        target,
        &stat,
        &scope,
        attributes,
        &seen.config,
    ))
    .map_err(|_| git::malformed())?;
    let mut digest = sha1_smol::Sha1::new();
    digest.update(&(encoded.len() as u64).to_le_bytes());
    digest.update(&encoded);
    let version =
        ConflictVersion::try_from(digest.digest().to_string()).map_err(|_| git::malformed())?;
    Ok(Classified::Whole(Box::new(Whole {
        version,
        shape,
        current,
        incoming,
        disk: WholeFileDisk::Unknown,
        rows: target.to_vec(),
        stat,
        scope,
    })))
}

fn text_conflict(
    repo: &Repo,
    seen: &Seen,
    path: &str,
    attributes: &[u8],
    rows: [&IndexEntry; 3],
) -> Result<Result<u32, ConflictUnsupported>, RepositoryError> {
    let metadata = match fs::symlink_metadata(repo.root.join(path)) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(Err(ConflictUnsupported::SpecialFile)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Err(ConflictUnsupported::Structural));
        }
        Err(error) => return Err(files::failed(path, &error)),
    };
    if !resolution::supported(attributes) {
        return Ok(Err(ConflictUnsupported::Attributes));
    }
    if metadata.len() > CONFLICT_TEXT_LIMIT as u64 {
        return Ok(Err(ConflictUnsupported::TooLarge));
    }
    let working = crate::untracked::read_regular_bounded(&repo.root, path, CONFLICT_TEXT_LIMIT)?;
    let working = match resolution::text(working) {
        Ok(working) => working,
        Err(reason) => return Ok(Err(reason)),
    };
    for row in rows {
        match seen.blobs.get(&row.oid) {
            Some(Ok(())) => {}
            Some(Err(reason)) => return Ok(Err(*reason)),
            None => return Ok(Err(ConflictUnsupported::TooLarge)),
        }
    }
    Ok(Ok(conflict_regions(&working)))
}

fn under_a_non_folder(repo: &Repo, path: &str) -> bool {
    let mut folder = repo.root.clone();
    let parts: Vec<_> = path.split('/').collect();
    parts[..parts.len() - 1].iter().any(|name| {
        folder.push(name);
        fs::symlink_metadata(&folder).is_ok_and(|metadata| !metadata.is_dir())
    })
}

fn binary_on_disk(repo: &Repo, path: &str) -> bool {
    crate::untracked::read_regular_bounded(&repo.root, path, BINARY_PROBE)
        .is_ok_and(|bytes| bytes[..bytes.len().min(BINARY_PROBE)].contains(&0))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Marker {
    Start,
    Base,
    Separator,
    End,
}

/// Reads a line as `@pierre/diffs` does when it draws the resolver.
fn marker(line: &str) -> Option<Marker> {
    let content = line.strip_suffix('\n').unwrap_or(line);
    let content = content.strip_suffix('\r').unwrap_or(content).as_bytes();
    let first = *content.first()?;
    let run = content.iter().take_while(|byte| **byte == first).count();
    if run < 7 {
        return None;
    }
    if first == b'=' {
        return (run == content.len()).then_some(Marker::Separator);
    }
    if run != content.len() && !matches!(content[run], b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ') {
        return None;
    }
    match first {
        b'<' => Some(Marker::Start),
        b'|' => Some(Marker::Base),
        b'>' => Some(Marker::End),
        _ => None,
    }
}

fn conflict_regions(text: &str) -> u32 {
    let mut open = 0_u32;
    let mut closed = 0;
    for line in text.split_inclusive('\n') {
        match marker(line) {
            Some(Marker::Start) => open += 1,
            Some(Marker::End) if open > 0 => {
                open -= 1;
                closed += 1;
            }
            Some(Marker::Base | Marker::Separator | Marker::End) | None => {}
        }
    }
    closed
}

fn scope(repo: &Repo, path: &str) -> Result<Vec<Parent>, RepositoryError> {
    let mut parents = vec![
        repo.root.clone(),
        repo.git_dir.clone(),
        repo.common_dir.clone(),
    ];
    let mut folder = repo.root.clone();
    let parts: Vec<_> = path.split('/').collect();
    for name in &parts[..parts.len() - 1] {
        folder.push(name);
        parents.push(folder.clone());
    }
    parents
        .iter()
        .map(|parent| match fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.is_dir() => Ok(Parent::Folder(
                Stat::of(parent)
                    .map_err(|error| files::failed(path, &error))?
                    .and_then(|stat| stat.identity),
            )),
            Ok(_) => Ok(Parent::Other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Parent::Missing),
            Err(error) => Err(files::failed(path, &error)),
        })
        .collect()
}

fn whole(repo: &Repo, path: &str, deadline: Deadline) -> Result<Whole, RepositoryError> {
    crate::status::check(path)?;
    match classify_all(repo, Some(path), deadline)?.1.pop() {
        Some((_, Classified::Whole(whole))) => Ok(*whole),
        Some((_, Classified::Text(_) | Classified::External(_))) | None => {
            Err(files::changed(path))
        }
    }
}

fn checkout_permissions(existing: Option<u32>, mode: Mode) -> u32 {
    #[cfg(unix)]
    {
        let base = existing.unwrap_or(0o644) & !0o111;
        if mode == Mode::Executable {
            base | ((base & 0o444) >> 2)
        } else {
            base
        }
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        existing.unwrap_or(0)
    }
}

enum Kept {
    Absent,
    File { bytes: Vec<u8>, permissions: u32 },
    Symlink { target: Vec<u8> },
}

pub(super) fn resolve(
    writing: &Writing<'_>,
    expect: &Expect,
    path: &str,
    version: &ConflictVersion,
    keep: ConflictKeep,
) -> Result<(Applied, Option<Published>), RepositoryError> {
    let Writing {
        repo,
        store,
        log,
        deadline,
        operation,
    } = writing;
    let mut txn = Txn::begin(repo, *deadline)?;
    let head = repo.head_as_seen(expect, *deadline)?;
    let seen = whole(repo, path, deadline.reads())?;
    if seen.version != *version {
        return Err(files::changed(path));
    }
    let before = index::read(&txn)?;
    if index::at(&before, path) != seen.rows {
        return Err(files::changed(path));
    }
    files::guard(&repo.root, &before, &[path], &RESOLVE)?;
    files::unchanged(&repo.root, path, &seen.stat)?;
    let side = match keep {
        ConflictKeep::Current => seen.current.as_ref(),
        ConflictKeep::Incoming => seen.incoming.as_ref(),
    }
    .map(|side| &side.row);
    if side.is_some() && seen.scope.contains(&Parent::Missing) {
        return Err(files::unsupported(format!(
            "The folder that holds {path} is missing. Restore the folder, or keep the side without the file."
        )));
    }
    let existing = fs::symlink_metadata(repo.root.join(path))
        .ok()
        .filter(fs::Metadata::is_file)
        .map(|metadata| files::permissions(&metadata));
    let kept = match side {
        None => Kept::Absent,
        Some(row) if row.mode == Mode::Symlink => Kept::Symlink {
            target: git::read(
                &repo.root,
                &["cat-file", "blob", row.oid.as_str()],
                deadline.reads(),
            )?,
        },
        Some(row) => Kept::File {
            bytes: git::read(
                &repo.root,
                &[
                    "cat-file",
                    "--filters",
                    &format!("--path={path}"),
                    row.oid.as_str(),
                ],
                deadline.reads(),
            )?,
            permissions: checkout_permissions(existing, row.mode),
        },
    };
    let resolved: Vec<IndexEntry> = side
        .into_iter()
        .map(|row| IndexEntry {
            stage: 0,
            ..row.clone()
        })
        .collect();
    index::put(&txn, &[(path, &resolved)])?;
    let after = index::read(&txn)?;
    let staged = IndexChange::differing(head, &before, &after)?;
    if staged.path_names().ne([path]) || index::at(&after, path) != resolved {
        return Err(files::changed(path));
    }
    let (applied, change, mut recorded) = store.record_with(repo, log, operation, |entry| {
        let copies = entry.files();
        store::private_folder()
            .create(&copies)
            .map_err(|error| files::failed(path, &error))?;
        files::unchanged(&repo.root, path, &seen.stat)?;
        let before = files::capture(&repo.root, path, &copies, "before".into())?;
        files::unchanged(&repo.root, path, &seen.stat)?;
        let after = match &kept {
            Kept::Absent => Content::Absent,
            Kept::Symlink { target } => Content::Symlink {
                target: target.clone(),
            },
            Kept::File { bytes, permissions } => {
                fs::write(copies.join("after"), bytes)
                    .map_err(|error| files::failed(path, &error))?;
                Content::File {
                    copy: "after".into(),
                    permissions: *permissions,
                }
            }
        };
        Ok(WholeChange {
            index: staged.clone(),
            scope: seen.scope.clone(),
            file: FileChange {
                path: path.into(),
                before,
                after,
            },
        })
    })?;
    recorded.durable()?;
    store.entry(applied.id).keep(&txn, &change.objects())?;
    let copies = store.entry(applied.id).files();
    let scratch = files::Scratch::new(&txn)?;
    let prepared = scratch.path().join("result");
    files::prepare(&change.file.after, &copies, &prepared)
        .map_err(|error| files::failed(path, &error))?;
    checkpoint("recorded", repo)?;
    if whole(repo, path, deadline.reads())?.version != *version {
        return Err(files::changed(path));
    }
    files::guard(&repo.root, &before, &[path], &RESOLVE)?;
    files::unchanged(&repo.root, path, &seen.stat)?;
    resolution::same_repository(repo, path, deadline.reads())?;
    files::place(&repo.root, applied.id, path, &change.file.after, &prepared)?;
    let placed = (|| {
        checkpoint("placed", repo)?;
        #[cfg(unix)]
        sync_parent(&repo.root, path)?;
        if !files::holds(&repo.root, path, &change.file.after, &copies)
            .map_err(|error| files::failed(path, &error))?
        {
            return Err(files::changed(path));
        }
        txn.publish(&super::Change::Whole(change.clone()))
    })();
    let published = recorded.pending_on_err(placed).map_err(recovery)?;
    recorded.confirm_checked().map_err(recovery)?;
    Ok((applied, Some(published)))
}

/// The nearest folder that still exists holds the new name or the removal.
#[cfg(unix)]
fn sync_parent(root: &std::path::Path, path: &str) -> Result<(), RepositoryError> {
    let mut folder = root.join(path);
    while folder.pop() && folder.starts_with(root) {
        if folder.is_dir() {
            return fs::File::open(&folder)
                .and_then(|folder| folder.sync_all())
                .map_err(|error| files::failed(path, &error));
        }
    }
    Ok(())
}

fn recovery(error: RepositoryError) -> RepositoryError {
    files::stopped(
        error,
        "The kept side was placed on disk and the conflict is still in the index. Refresh, then Undo puts the file back, or resolve it again.",
    )
}

pub(super) fn landed(
    repo: &Repo,
    entry: &EntryObjects,
    change: &WholeChange,
    deadline: WriteDeadline,
) -> Result<Option<WholeChange>, RepositoryError> {
    let path = &change.file.path;
    let rows = index::read_worktree(&repo.root, deadline.reads())?.0;
    files::guard(&repo.root, &rows, &[path], &RESOLVE)?;
    if scope(repo, path)? != change.scope {
        return Err(files::changed(path));
    }
    let at = |content| {
        files::holds(&repo.root, path, content, &entry.files())
            .map_err(|error| files::failed(path, &error))
    };
    if index::landed(repo, &change.index, deadline)? {
        return if at(&change.file.after)? {
            Ok(Some(change.clone()))
        } else {
            Err(files::changed(path))
        };
    }
    if at(&change.file.before)? {
        return Ok(None);
    }
    if at(&change.file.after)? {
        return Ok(Some(WholeChange {
            index: IndexChange::empty(change.index.head()),
            ..change.clone()
        }));
    }
    Err(files::changed(path))
}

pub(super) fn step(
    txn: &Txn<'_>,
    entry: &EntryObjects,
    change: &WholeChange,
    direction: Direction,
) -> Result<Restored, RepositoryError> {
    let repo = txn.repo();
    let path = &change.file.path;
    let expect = Expect {
        head: change.index.head(),
    };
    repo.head_as_seen(&expect, txn.deadline())?;
    if scope(repo, path)? != change.scope {
        return Err(files::changed(path));
    }
    let rows = index::read(txn)?;
    let copies = entry.files();
    let pending = files::check_files(
        &repo.root,
        &rows,
        &copies,
        std::slice::from_ref(&change.file),
        direction,
        &RESOLVE,
    )?;
    let restored = index::restore(txn, entry, &change.index, direction)?;
    files::place_checked(
        txn,
        entry.id(),
        &copies,
        &pending,
        direction,
        &files::STASH_WORDS,
        |_| {
            resolution::same_repository(repo, path, txn.deadline().reads())?;
            repo.head_as_seen(&expect, txn.deadline())?;
            if scope(repo, path)? != change.scope {
                return Err(files::changed(path));
            }
            Ok(())
        },
    )?;
    checkpoint("stepped", repo)?;
    Ok(
        if pending.is_empty() && restored == Restored::AlreadyThere {
            Restored::AlreadyThere
        } else {
            Restored::Staged
        },
    )
}

#[cfg(not(test))]
fn checkpoint(_point: &str, _repo: &Repo) -> Result<(), RepositoryError> {
    Ok(())
}

#[cfg(test)]
fn checkpoint(point: &str, repo: &Repo) -> Result<(), RepositoryError> {
    if repo.root.join(format!(".fail-whole-{point}")).exists() {
        Err(RepositoryError::new(
            crate::ErrorKind::GitFailed,
            format!("Injected {point} failure"),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
