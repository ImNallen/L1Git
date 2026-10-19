use crate::{
    Branch, ChangeStatus, ChangedFile, Commit, CommitDetail, DiffBase, ErrorKind, FilePatch, Head,
    RepositoryError, RepositorySnapshot, git, remotes,
};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const HISTORY_LIMIT: usize = 200;
pub const PATCH_LIMIT: usize = 1024 * 1024;
const COMMIT_FORMAT: &str = "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%at";

pub(crate) fn root(path: &str) -> Result<PathBuf, RepositoryError> {
    let path = Path::new(path).canonicalize().map_err(|_| {
        RepositoryError::new(
            ErrorKind::MissingPath,
            "This directory is missing or inaccessible. Choose an existing repository folder.",
        )
    })?;
    if !path.is_dir() {
        return Err(RepositoryError::new(
            ErrorKind::NotRepository,
            "Choose a repository directory, not a file.",
        ));
    }
    let bare = git::run(&path, &["rev-parse", "--is-bare-repository"])?;
    if !bare.status.success() {
        return Err(RepositoryError::new(
            ErrorKind::NotRepository,
            "This folder is not inside a Git repository. Choose a repository or one of its subfolders.",
        ));
    }
    if git::line(&bare.stdout) == "true" {
        return Err(RepositoryError::new(
            ErrorKind::BareRepository,
            "Bare repositories are not supported yet. Choose a working copy of this repository.",
        ));
    }
    let top = git::read(&path, &["rev-parse", "--show-toplevel"])?;
    let top = std::str::from_utf8(top.strip_suffix(b"\n").unwrap_or(&top)).map_err(|_| {
        RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "Repository paths must be valid UTF-8.",
        )
    })?;
    Path::new(top).canonicalize().map_err(|_| {
        RepositoryError::new(
            ErrorKind::MissingPath,
            "The repository moved while opening. Choose its current folder.",
        )
    })
}

fn head(path: &Path) -> Result<Head, RepositoryError> {
    let symbolic = git::run(path, &["symbolic-ref", "--quiet", "HEAD"])?;
    let target = git::run(path, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    match (symbolic.status.success(), target.status.success()) {
        (true, true) => Ok(Head::Attached {
            reference: git::line(&symbolic.stdout),
            oid: git::line(&target.stdout),
        }),
        (true, false) => Ok(Head::Unborn {
            reference: git::line(&symbolic.stdout),
        }),
        (false, true) => Ok(Head::Detached {
            oid: git::line(&target.stdout),
        }),
        (false, false) => Err(RepositoryError::new(
            ErrorKind::GitFailed,
            "HEAD is unreadable. Repair the repository's HEAD and refresh.",
        )),
    }
}

fn branches(path: &Path, remote_names: &[&str]) -> Result<Vec<Branch>, RepositoryError> {
    let output = git::read(
        path,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)%00%(objectname)%00%(upstream)%00%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )?;
    let mut branches = Vec::new();
    for row in output
        .split(|byte| *byte == b'\n')
        .filter(|row| !row.is_empty())
    {
        let fields: Vec<_> = row.split(|byte| *byte == 0).collect();
        let [reference, oid, upstream, symbolic] = fields.as_slice() else {
            return Err(git::malformed());
        };
        if reference.starts_with(b"refs/remotes/") && !symbolic.is_empty() {
            continue;
        }
        let reference = git::text(reference);
        let oid = git::text(oid);
        if let Some(name) = reference.strip_prefix("refs/heads/") {
            branches.push(Branch::Local {
                name: name.into(),
                reference,
                oid,
                upstream: if upstream.is_empty() {
                    None
                } else {
                    Some(git::text(upstream))
                },
            });
        } else if let Some(name) = reference.strip_prefix("refs/remotes/") {
            let remote = remote_names
                .iter()
                .filter(|remote| {
                    name.strip_prefix(**remote)
                        .is_some_and(|suffix| suffix.starts_with('/'))
                })
                .max_by_key(|remote| remote.len());
            branches.push(Branch::Remote {
                name: name.into(),
                reference,
                oid,
                remote: remote
                    .map(|s| (*s).into())
                    .unwrap_or_else(|| "Unconfigured remote".into()),
            });
        }
    }
    Ok(branches)
}

fn parse_commits(output: &[u8]) -> Result<Vec<Commit>, RepositoryError> {
    let output = output.strip_suffix(&[0]).unwrap_or(output);
    if output.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<_> = output.split(|byte| *byte == 0).collect();
    let mut records = fields.chunks_exact(6);
    let commits = records
        .by_ref()
        .map(|fields| {
            let [oid, parents, subject, author, email, timestamp] = fields else {
                return Err(git::malformed());
            };
            Ok(Commit {
                oid: git::text(oid),
                parents: git::text(parents)
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect(),
                subject: git::text(subject),
                author: git::text(author),
                email: git::text(email),
                timestamp: git::text(timestamp).parse().map_err(|_| git::malformed())?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !records.remainder().is_empty() {
        return Err(git::malformed());
    }
    Ok(commits)
}

pub fn snapshot(
    path: &str,
    reference: Option<&str>,
) -> Result<RepositorySnapshot, RepositoryError> {
    let root = root(path)?;
    let head = head(&root)?;
    let remotes = remotes::read(&root)?;
    let branches = branches(
        &root,
        &remotes
            .iter()
            .map(|remote| remote.name.as_str())
            .collect::<Vec<_>>(),
    )?;
    if let Some(reference) = reference {
        let exists = branches.iter().any(|branch| match branch {
            Branch::Local {
                reference: candidate,
                ..
            }
            | Branch::Remote {
                reference: candidate,
                ..
            } => candidate == reference,
        });
        if !exists {
            return Err(RepositoryError::new(
                ErrorKind::InvalidRef,
                "That branch is no longer available. Refresh the repository and select a current branch.",
            ));
        }
    }
    let limit = format!("--max-count={}", HISTORY_LIMIT + 1);
    let mut args = vec!["log", "--topo-order", COMMIT_FORMAT, "-z", &limit];
    if let Some(reference) = reference {
        args.push(reference);
    } else {
        args.extend(["--branches", "--remotes"]);
        if !matches!(head, Head::Unborn { .. }) {
            args.push("HEAD");
        }
    }
    args.push("--");
    let mut commits = parse_commits(&git::read(&root, &args)?)?;
    let history_truncated = commits.len() > HISTORY_LIMIT;
    commits.truncate(HISTORY_LIMIT);
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Repository".into());
    let root = root
        .to_str()
        .ok_or_else(|| {
            RepositoryError::new(
                ErrorKind::UnsupportedPath,
                "Repository paths must be valid UTF-8.",
            )
        })?
        .to_owned();
    Ok(RepositorySnapshot {
        root,
        name,
        head,
        branches,
        remotes,
        commits,
        history_truncated,
        observed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

fn open_commit(path: &str, oid: &str) -> Result<(PathBuf, Commit), RepositoryError> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RepositoryError::new(
            ErrorKind::InvalidOid,
            "Choose a full commit ID from this repository's history.",
        ));
    }
    let root = root(path)?;
    let verified = git::run(
        &root,
        &["rev-parse", "--verify", &format!("{oid}^{{commit}}")],
    )?;
    if !verified.status.success() {
        return Err(RepositoryError::new(
            ErrorKind::InvalidOid,
            "This commit is no longer available. Refresh the repository.",
        ));
    }
    let output = git::read(&root, &["log", "-1", COMMIT_FORMAT, "-z", oid, "--"])?;
    let commit = parse_commits(&output)?
        .into_iter()
        .next()
        .ok_or_else(git::malformed)?;
    Ok((root, commit))
}

fn diff_base(commit: &Commit) -> (DiffBase, &str) {
    match commit.parents.first() {
        Some(parent) => (DiffBase::FirstParent, parent),
        None => (DiffBase::EmptyTree, "--root"),
    }
}

pub fn commit_detail(path: &str, oid: &str) -> Result<CommitDetail, RepositoryError> {
    let (root, commit) = open_commit(path, oid)?;
    let message = git::line(&git::read(
        &root,
        &["show", "--no-patch", "--format=%B", oid, "--"],
    )?);
    let (diff_base, base) = diff_base(&commit);
    let args = [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        base,
        oid,
        "--",
    ];
    let output = git::read(&root, &args)?;
    let mut files = Vec::new();
    if !output.is_empty() {
        let fields: Vec<_> = output
            .strip_suffix(&[0])
            .unwrap_or(&output)
            .split(|byte| *byte == 0)
            .collect();
        let mut records = fields.chunks_exact(2);
        for row in records.by_ref() {
            let [status, path] = row else {
                return Err(git::malformed());
            };
            let status = match *status {
                b"A" => ChangeStatus::Added,
                b"D" => ChangeStatus::Deleted,
                b"M" => ChangeStatus::Modified,
                b"T" => ChangeStatus::TypeChanged,
                _ => return Err(git::malformed()),
            };
            files.push(ChangedFile {
                path: git::text(path),
                status,
            });
        }
        if !records.remainder().is_empty() {
            return Err(git::malformed());
        }
    }
    Ok(CommitDetail {
        commit,
        message,
        files,
        diff_base,
    })
}

pub fn file_patch(path: &str, oid: &str, file: &str) -> Result<FilePatch, RepositoryError> {
    let (root, commit) = open_commit(path, oid)?;
    if file.is_empty() {
        return Err(unchanged_path());
    }
    let (_, base) = diff_base(&commit);
    let args = |format| {
        [
            "--literal-pathspecs",
            "diff-tree",
            "--no-commit-id",
            "-r",
            "-z",
            format,
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            base,
            oid,
            "--",
            file,
        ]
    };
    let numstat = git::read(&root, &args("--numstat"))?;
    let (added, deleted) = numstat
        .split(|byte| *byte == 0)
        .find_map(|record| {
            let mut fields = record.splitn(3, |byte| *byte == b'\t');
            match (fields.next(), fields.next(), fields.next()) {
                (Some(added), Some(deleted), Some(changed)) if changed == file.as_bytes() => {
                    Some((added, deleted))
                }
                _ => None,
            }
        })
        .ok_or_else(|| {
            if file.contains(char::REPLACEMENT_CHARACTER) {
                RepositoryError::new(
                    ErrorKind::UnsupportedPath,
                    "L1 Git cannot open diffs for file names that are not valid UTF-8.",
                )
            } else {
                unchanged_path()
            }
        })?;
    if added == b"-" && deleted == b"-" {
        return Ok(FilePatch::Binary);
    }
    Ok(
        match git::read_capped(&root, &args("--patch"), PATCH_LIMIT)? {
            git::Capped::Within(patch) => FilePatch::Text {
                lossy: std::str::from_utf8(&patch).is_err(),
                patch: git::text(&patch),
            },
            git::Capped::Over(bytes) => FilePatch::TooLarge { bytes },
        },
    )
}

fn unchanged_path() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnchangedPath,
        "This file did not change in the selected commit. Choose one of its changed paths.",
    )
}
