use super::{
    Applied, Change, Direction, Expect, Repo,
    branches::Writing,
    files::{self, Content, FileChange, Stat},
    index,
    store::{self, EntryObjects},
    txn::{Published, Txn},
};
use crate::{
    CONFLICT_TEXT_LIMIT, Conflict, ConflictFile, ConflictSnapshot, ConflictUnsupported,
    ConflictVersion, ErrorKind, Head, IndexObject, Mode, RepositoryError, Stages, StatusEntry,
    git::{self, Capped, Deadline, WriteDeadline},
    repository, status,
};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};

const SAVE: files::Verb = files::Verb {
    verb: "save",
    verbing: "saving",
    capital: "Save",
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ResolutionChange {
    head: Head,
    rows: Vec<index::IndexEntry>,
    scope: Vec<Option<(u64, u64)>>,
    transforms: Vec<u8>,
    file: FileChange,
}

struct Captured {
    snapshot: ConflictSnapshot,
    rows: Vec<index::IndexEntry>,
    stat: Option<Stat>,
    scope: Vec<Option<(u64, u64)>>,
    transforms: Vec<u8>,
}
enum Capture {
    Editable(Box<Captured>),
    External(ConflictUnsupported),
}

pub(crate) fn conflict_file_within(
    path: &str,
    file: &str,
    deadline: Deadline,
) -> Result<ConflictFile, RepositoryError> {
    let repo = Repo::open(path, deadline)?;
    Ok(match capture(&repo, file, deadline)? {
        Capture::Editable(captured) => ConflictFile::Editable {
            snapshot: Box::new(captured.snapshot),
        },
        Capture::External(reason) => ConflictFile::External {
            root: repo.root(),
            path: file.into(),
            reason,
        },
    })
}

fn text(bytes: Vec<u8>) -> Result<String, ConflictUnsupported> {
    if bytes.len() > CONFLICT_TEXT_LIMIT {
        return Err(ConflictUnsupported::TooLarge);
    }
    if bytes.contains(&0) {
        return Err(ConflictUnsupported::Binary);
    }
    let text = String::from_utf8(bytes).map_err(|_| ConflictUnsupported::Encoding)?;
    let crlf = text.contains("\r\n");
    let mut previous = 0;
    for byte in text.bytes() {
        if (previous == b'\r' && byte != b'\n') || (byte == b'\n' && (previous == b'\r') != crlf) {
            return Err(ConflictUnsupported::Encoding);
        }
        previous = byte;
    }
    if previous == b'\r' {
        return Err(ConflictUnsupported::Encoding);
    }
    Ok(text)
}

fn disk(path: &Path) -> Result<Vec<u8>, RepositoryError> {
    let shown = path.to_string_lossy();
    let mut bytes = Vec::new();
    {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::custom_flags(
            &mut options,
            libc::O_NOFOLLOW | libc::O_NONBLOCK,
        );
        options.open(path)
    }
    .and_then(|file| {
        file.take((CONFLICT_TEXT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
    })
    .map_err(|error| files::failed(&shown, &error))?;
    Ok(bytes)
}

fn scope(repo: &Repo, path: &str) -> Result<Vec<Option<(u64, u64)>>, RepositoryError> {
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
        .map(|parent| {
            let metadata =
                fs::symlink_metadata(parent).map_err(|error| files::failed(path, &error))?;
            if !metadata.is_dir() {
                return Err(files::changed(path));
            }
            Ok(Stat::of(parent)
                .map_err(|error| files::failed(path, &error))?
                .and_then(|stat| stat.identity))
        })
        .collect()
}

fn transforms(
    repo: &Repo,
    path: &str,
    deadline: Deadline,
) -> Result<(Vec<u8>, bool), RepositoryError> {
    let attrs = git::read(
        &repo.root,
        &[
            "check-attr",
            "-z",
            "filter",
            "ident",
            "working-tree-encoding",
            "text",
            "eol",
            "--",
            path,
        ],
        deadline,
    )?;
    let fields: Vec<_> = attrs.split(|byte| *byte == 0).collect();
    let supported = fields.chunks_exact(3).all(|field| {
        ![b"filter".as_slice(), b"ident", b"working-tree-encoding"].contains(&field[1])
            || [b"unspecified".as_slice(), b"unset"].contains(&field[2])
    });
    let config = git::run(
        &repo.root,
        &[
            "config",
            "-z",
            "--get-regexp",
            "^core\\.(autocrlf|eol|safecrlf|filemode|ignorecase)$",
        ],
        deadline,
    )?;
    if !matches!(config.status.code(), Some(0 | 1)) {
        return Err(git::read_failed());
    }
    let mut result = attrs;
    result.extend_from_slice(&config.stdout);
    Ok((result, supported))
}

fn capture(repo: &Repo, path: &str, deadline: Deadline) -> Result<Capture, RepositoryError> {
    status::check(path)?;
    if path.len() > 4096 {
        return Err(files::unsupported("This conflict path is too long.".into()));
    }
    let head = repository::head(&repo.root, deadline)?;
    let (rows, _) = index::read_worktree(&repo.root, deadline)?;
    let target = index::at(&rows, path);
    let [base, current, incoming] = target else {
        return Ok(Capture::External(ConflictUnsupported::Structural));
    };
    if [base.stage, current.stage, incoming.stage] != [1, 2, 3]
        || target.iter().any(|row| {
            row.mode != base.mode || row.intent_to_add || row.skip_worktree || row.assume_unchanged
        })
    {
        return Ok(Capture::External(ConflictUnsupported::Structural));
    }
    if !matches!(base.mode, Mode::File | Mode::Executable) {
        return Ok(Capture::External(ConflictUnsupported::SpecialFile));
    }
    let stats = files::guard(&repo.root, &rows, &[path], &SAVE)?;
    let stat = stats.into_iter().next().flatten();
    let metadata = match fs::symlink_metadata(repo.root.join(path)) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(Capture::External(ConflictUnsupported::SpecialFile)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Capture::External(ConflictUnsupported::Structural));
        }
        Err(error) => return Err(files::failed(path, &error)),
    };
    let scope = scope(repo, path)?;
    let (transforms, supported) = transforms(repo, path, deadline)?;
    if !supported {
        return Ok(Capture::External(ConflictUnsupported::Attributes));
    }
    if metadata.len() > CONFLICT_TEXT_LIMIT as u64 {
        return Ok(Capture::External(ConflictUnsupported::TooLarge));
    }
    let working = match text(disk(&repo.root.join(path))?) {
        Ok(text) => text,
        Err(reason) => return Ok(Capture::External(reason)),
    };
    let mut contents = Vec::new();
    for row in target {
        let blob = git::read_capped(
            &repo.root,
            &["cat-file", "blob", row.oid.as_str()],
            CONFLICT_TEXT_LIMIT,
            deadline,
        )?;
        let bytes = match blob {
            Capped::Within(bytes) => bytes,
            Capped::Over(_) => return Ok(Capture::External(ConflictUnsupported::TooLarge)),
        };
        match text(bytes) {
            Ok(text) => contents.push(text),
            Err(reason) => return Ok(Capture::External(reason)),
        }
    }
    files::guard(&repo.root, &rows, &[path], &SAVE)?;
    files::unchanged(&repo.root, path, &stat)?;
    if head != repository::head(&repo.root, deadline)?
        || target != index::at(&index::read_worktree(&repo.root, deadline)?.0, path)
        || scope != self::scope(repo, path)?
        || transforms != self::transforms(repo, path, deadline)?.0
        || working.as_bytes() != disk(&repo.root.join(path))?
    {
        return Err(files::changed(path));
    }
    let object = |row: &index::IndexEntry| {
        Some(IndexObject {
            mode: row.mode,
            oid: row.oid.clone(),
        })
    };
    let entry = StatusEntry::Unmerged {
        path: path.into(),
        conflict: Conflict::BothModified,
        submodule: None,
        stages: Stages {
            base: object(base),
            ours: object(current),
            theirs: object(incoming),
        },
    };
    let encoded = serde_json::to_vec(&(
        repo.root(),
        &repo.git_dir,
        path,
        &head,
        target,
        &scope,
        &stat,
        &transforms,
        &working,
    ))
    .map_err(|_| git::malformed())?;
    let mut digest = sha1_smol::Sha1::new();
    digest.update(&(encoded.len() as u64).to_le_bytes());
    digest.update(&encoded);
    let version =
        ConflictVersion::try_from(digest.digest().to_string()).map_err(|_| git::malformed())?;
    let [base, current, incoming]: [String; 3] =
        contents.try_into().map_err(|_| git::malformed())?;
    Ok(Capture::Editable(Box::new(Captured {
        snapshot: ConflictSnapshot {
            root: repo.root(),
            path: path.into(),
            head,
            entry,
            version,
            base,
            current,
            incoming,
            working,
        },
        rows: target.to_vec(),
        stat,
        scope,
        transforms,
    })))
}

pub(super) fn save(
    writing: &Writing<'_>,
    expect: &Expect,
    path: &str,
    version: &ConflictVersion,
    result: &str,
) -> Result<(Applied, Option<Published>), RepositoryError> {
    text(result.as_bytes().to_vec()).map_err(|reason| files::unsupported(format!("This result cannot be saved in L1 Git ({reason:?}). Use a regular UTF-8 text file up to 256 KiB with uniform LF or CRLF endings.")))?;
    let Writing {
        repo,
        store,
        log,
        deadline,
        operation,
    } = writing;
    let mut txn = Txn::begin(repo, *deadline)?;
    repo.head_as_seen(expect, *deadline)?;
    let Capture::Editable(seen) = capture(repo, path, deadline.reads())? else {
        return Err(files::changed(path));
    };
    if seen.snapshot.version != *version {
        return Err(files::changed(path));
    }
    if seen.snapshot.working == result {
        return Err(RepositoryError::new(
            ErrorKind::UnchangedPath,
            "The result already matches the working file. No save was recorded.",
        ));
    }
    let scratch = files::Scratch::new(&txn)?;
    let prepared = scratch.path().join("result");
    let metadata =
        fs::symlink_metadata(repo.root.join(path)).map_err(|error| files::failed(path, &error))?;
    let permissions = files::permissions(&metadata);
    fs::write(&prepared, result)
        .and_then(|()| files::set_permissions(&prepared, permissions))
        .and_then(|()| fs::File::open(&prepared)?.sync_all())
        .map_err(|error| files::failed(path, &error))?;
    let (applied, change, recorded) = store.record_with(repo, log, operation, |entry| {
        let copies = entry.files();
        store::private_folder()
            .create(&copies)
            .map_err(|error| files::failed(path, &error))?;
        let bytes = disk(&repo.root.join(path))?;
        files::unchanged(&repo.root, path, &seen.stat)?;
        if bytes != seen.snapshot.working.as_bytes() {
            return Err(files::changed(path));
        }
        fs::write(copies.join("before"), bytes).map_err(|error| files::failed(path, &error))?;
        fs::write(copies.join("after"), result).map_err(|error| files::failed(path, &error))?;
        let before = Content::File {
            copy: "before".into(),
            permissions,
        };
        let after = Content::File {
            copy: "after".into(),
            permissions,
        };
        Ok(ResolutionChange {
            head: seen.snapshot.head.clone(),
            rows: seen.rows.clone(),
            scope: seen.scope.clone(),
            transforms: seen.transforms.clone(),
            file: FileChange {
                path: path.into(),
                before,
                after,
            },
        })
    })?;
    recorded.durable()?;
    #[cfg(test)]
    if repo.root.join(".stop-resolution-recorded").exists() {
        recorded.stay_pending();
        return Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "Stopped after recording",
        ));
    }
    checkpoint("recorded", repo)?;
    let Capture::Editable(fresh) = capture(repo, path, deadline.reads())? else {
        return Err(files::changed(path));
    };
    if fresh.snapshot.version != *version {
        return Err(files::changed(path));
    }
    files::unchanged(&repo.root, path, &seen.stat)?;
    files::place(&repo.root, applied.id, path, &change.file.after, &prepared)?;
    let placed = (|| {
        checkpoint("placed", repo)?;
        if !files::holds(
            &repo.root,
            path,
            &change.file.after,
            &store.entry(applied.id).files(),
        )
        .map_err(|error| files::failed(path, &error))?
        {
            return Err(files::changed(path));
        }
        txn.publish_index(&Change::Resolution(change.clone()))
    })();
    let published = match placed {
        Ok(published) => published,
        Err(error) => {
            recorded.stay_pending();
            return Err(recovery(error));
        }
    };
    recorded.confirm_checked().map_err(recovery)?;
    Ok((applied, Some(published)))
}

fn recovery(error: RepositoryError) -> RepositoryError {
    files::stopped(
        error,
        "The result was placed on disk. Undo recovery is pending; keep the draft and retry after refreshing. The before and after copies remain in the undo history.",
    )
}

pub(super) fn landed(
    repo: &Repo,
    entry: &EntryObjects,
    change: &ResolutionChange,
    deadline: WriteDeadline,
) -> Result<bool, RepositoryError> {
    let rows = index::read_worktree(&repo.root, deadline.reads())?.0;
    files::guard(&repo.root, &rows, &[&change.file.path], &SAVE)?;
    if scope(repo, &change.file.path)? != change.scope {
        return Err(files::changed(&change.file.path));
    }
    let at = |content| {
        files::holds(&repo.root, &change.file.path, content, &entry.files())
            .map_err(|error| files::failed(&change.file.path, &error))
    };
    if at(&change.file.after)? {
        Ok(true)
    } else if at(&change.file.before)? {
        Ok(false)
    } else {
        Err(files::changed(&change.file.path))
    }
}

pub(super) fn step(
    txn: &Txn<'_>,
    entry: &EntryObjects,
    change: &ResolutionChange,
    direction: Direction,
) -> Result<(), RepositoryError> {
    let repo = txn.repo();
    repo.head_as_seen(
        &Expect {
            head: change.head.clone(),
        },
        txn.deadline(),
    )?;
    let rows = index::read(txn)?;
    let path = &change.file.path;
    if index::at(&rows, path) != change.rows
        || scope(repo, path)? != change.scope
        || transforms(repo, path, txn.deadline().reads())?.0 != change.transforms
    {
        return Err(files::changed(path));
    }
    let copies = entry.files();
    let pending = files::check_files(
        &repo.root,
        &rows,
        &copies,
        std::slice::from_ref(&change.file),
        direction,
        &SAVE,
    )?;
    files::place_checked(
        txn,
        entry.id(),
        &copies,
        &pending,
        direction,
        &files::STASH_WORDS,
        |_| {},
    )?;
    checkpoint("stepped", repo)
}

pub(super) fn remove_copy_beside(applied: &Applied, change: &ResolutionChange) {
    let _ = fs::remove_file(files::copy_beside(
        applied.id,
        &Path::new(&applied.root).join(&change.file.path),
    ));
}

#[cfg(not(test))]
fn checkpoint(_point: &str, _repo: &Repo) -> Result<(), RepositoryError> {
    Ok(())
}
#[cfg(test)]
fn checkpoint(point: &str, repo: &Repo) -> Result<(), RepositoryError> {
    if repo.root.join(format!(".fail-resolution-{point}")).exists() {
        Err(RepositoryError::new(
            ErrorKind::GitFailed,
            format!("Injected {point} failure"),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
