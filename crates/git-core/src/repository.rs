use crate::{
    Branch, ChangeStatus, ChangedFile, Commit, CommitDetail, DiffBase, ErrorKind, FilePatch, Head,
    LineStats, Oid, Remote, RepositoryError, RepositoryRefs, RepositorySnapshot, Squash, Tag,
    Worktree,
    git::{self, Deadline, LocalRead},
    remotes,
};
use std::{
    collections::HashMap,
    panic,
    path::{Path, PathBuf},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

pub const HISTORY_LIMIT: usize = 50_000;
pub const PATCH_LIMIT: usize = 1024 * 1024;
pub const LINE_STATS_LIMIT: usize = 500;
const COMMIT_FORMAT: &str = "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%at";
const SQUASH_SCAN_LIMIT: usize = 2000;
const SQUASH_BRANCH_LIMIT: usize = 1000;

pub(crate) fn root(path: &str, deadline: Deadline) -> Result<PathBuf, RepositoryError> {
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
    let bare = git::run(&path, &["rev-parse", "--is-bare-repository"], deadline)?;
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
    let top = git::read(&path, &["rev-parse", "--show-toplevel"], deadline)?;
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

pub(crate) fn head(path: &Path, deadline: Deadline) -> Result<Head, RepositoryError> {
    let symbolic = git::run(path, &["symbolic-ref", "--quiet", "HEAD"], deadline)?;
    let target = git::run(path, &["rev-parse", "--verify", "HEAD^{commit}"], deadline)?;
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

fn branches(
    path: &Path,
    remote_names: &[&str],
    deadline: Deadline,
) -> Result<Vec<Branch>, RepositoryError> {
    let output = git::read(
        path,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)%00%(objectname)%00%(upstream)%00%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
        deadline,
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

fn tags(path: &Path, deadline: Deadline) -> Result<Vec<Tag>, RepositoryError> {
    let output = git::read(
        path,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
            "refs/tags/",
        ],
        deadline,
    )?;
    let mut tags = Vec::new();
    for row in output
        .split(|byte| *byte == b'\n')
        .filter(|row| !row.is_empty())
    {
        let fields: Vec<_> = row.split(|byte| *byte == 0).collect();
        let [reference, oid, kind, peeled, peeled_kind] = fields.as_slice() else {
            return Err(git::malformed());
        };
        let (oid, kind) = if peeled.is_empty() {
            (oid, kind)
        } else {
            (peeled, peeled_kind)
        };
        let reference = git::text(reference);
        let oid = match *kind {
            b"commit" => git::text(oid),
            b"tag" => match peel_to_commit(path, &reference, deadline)? {
                Some(oid) => oid,
                None => continue,
            },
            _ => continue,
        };
        let Some(name) = reference.strip_prefix("refs/tags/") else {
            return Err(git::malformed());
        };
        tags.push(Tag {
            name: name.into(),
            oid,
            reference,
        });
    }
    Ok(tags)
}

/// Older Git dereferences `%(*objectname)` only once, so a tag of a tag can
/// still name a tag object.
fn peel_to_commit(
    path: &Path,
    reference: &str,
    deadline: Deadline,
) -> Result<Option<String>, RepositoryError> {
    let output = git::run(
        path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
        deadline,
    )?;
    Ok(output.status.success().then(|| git::line(&output.stdout)))
}

fn worktrees(root: &Path, deadline: Deadline) -> Result<Vec<Worktree>, RepositoryError> {
    let output = git::read(root, &["worktree", "list", "--porcelain", "-z"], deadline)?;
    let fields: Vec<_> = output.split(|byte| *byte == 0).collect();
    let mut worktrees = Vec::new();
    for record in fields
        .split(|field| field.is_empty())
        .filter(|record| !record.is_empty())
    {
        let (mut path, mut oid, mut reference) = (None, None, None);
        let mut listed = true;
        for field in record {
            if let Some(value) = field.strip_prefix(b"worktree ") {
                path = Some(git::text(value));
            } else if let Some(value) = field.strip_prefix(b"HEAD ") {
                oid = Some(git::text(value));
            } else if let Some(value) = field.strip_prefix(b"branch ") {
                reference = Some(git::text(value));
            } else if *field == b"bare" || field.starts_with(b"prunable") {
                listed = false;
            }
        }
        if !listed {
            continue;
        }
        let (Some(path), Some(oid)) = (path, oid) else {
            return Err(git::malformed());
        };
        let Ok(path) = Path::new(&path).canonicalize() else {
            continue;
        };
        let head = match reference {
            Some(reference) if oid.bytes().all(|byte| byte == b'0') => Head::Unborn { reference },
            Some(reference) => Head::Attached { reference, oid },
            None => Head::Detached { oid },
        };
        worktrees.push(Worktree {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            current: path == root,
            root: path.to_string_lossy().into_owned(),
            head,
        });
    }
    Ok(worktrees)
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

fn read_refs(
    root: &Path,
    remotes: &[Remote],
    deadline: Deadline,
) -> Result<RepositoryRefs, RepositoryError> {
    let head = head(root, deadline)?;
    let branches = branches(
        root,
        &remotes
            .iter()
            .map(|remote| remote.name.as_str())
            .collect::<Vec<_>>(),
        deadline,
    )?;
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
    Ok(RepositoryRefs {
        root,
        name,
        head,
        branches,
    })
}

pub fn refs(path: &str) -> Result<RepositoryRefs, RepositoryError> {
    refs_within(path, Deadline::of(LocalRead::Refs))
}

pub(crate) fn refs_within(
    path: &str,
    deadline: Deadline,
) -> Result<RepositoryRefs, RepositoryError> {
    let root = root(path, deadline)?;
    read_refs(&root, &remotes::read(&root, deadline)?, deadline)
}

pub fn snapshot(path: &str) -> Result<RepositorySnapshot, RepositoryError> {
    snapshot_within(path, Deadline::of(LocalRead::Snapshot))
}

pub(crate) fn snapshot_within(
    path: &str,
    deadline: Deadline,
) -> Result<RepositorySnapshot, RepositoryError> {
    let root = root(path, deadline)?;
    let remotes = remotes::read(&root, deadline)?;
    let RepositoryRefs {
        root: root_text,
        name,
        head,
        branches,
    } = read_refs(&root, &remotes, deadline)?;
    let tags = tags(&root, deadline)?;
    let worktrees = worktrees(&root, deadline)?;
    let limit = format!("--max-count={}", HISTORY_LIMIT + 1);
    let mut args = vec![
        "log",
        "--topo-order",
        COMMIT_FORMAT,
        "-z",
        &limit,
        "--branches",
        "--remotes",
        "--tags",
    ];
    if !matches!(head, Head::Unborn { .. }) {
        args.push("HEAD");
    }
    args.extend(
        worktrees
            .iter()
            .filter_map(|worktree| match &worktree.head {
                Head::Detached { oid } => Some(oid.as_str()),
                _ => None,
            }),
    );
    args.push("--");
    let mut commits = parse_commits(&git::read(&root, &args, deadline)?)?;
    let history_truncated = commits.len() > HISTORY_LIMIT;
    commits.truncate(HISTORY_LIMIT);
    // A partial clone lacks the blobs to diff, so it shows no squash merges.
    let squashes = squashes(&root, &commits, deadline).unwrap_or_default();
    Ok(RepositorySnapshot {
        root: root_text,
        name,
        head,
        branches,
        tags,
        worktrees,
        remotes,
        commits,
        squashes,
        history_truncated,
        observed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

/// Pairs each branch tip that no loaded commit builds on with a newer commit
/// whose patch equals the branch's changes since it forked.
fn squashes(
    root: &Path,
    commits: &[Commit],
    deadline: Deadline,
) -> Result<Vec<Squash>, RepositoryError> {
    let index: HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(position, commit)| (commit.oid.as_str(), position))
        .collect();
    let mut children = vec![0; commits.len()];
    for commit in commits {
        for parent in &commit.parents {
            if let Some(&position) = index.get(parent.as_str()) {
                children[position] += 1;
            }
        }
    }
    let fork = |tip: usize| {
        let mut at = tip;
        for _ in 0..SQUASH_BRANCH_LIMIT {
            let parent = *index.get(commits[at].parents.first()?.as_str())?;
            if children[parent] > 1 {
                return Some(parent);
            }
            at = parent;
        }
        None
    };
    let branches: Vec<(usize, usize)> = (0..commits.len())
        .filter(|&tip| children[tip] == 0)
        .filter_map(|tip| Some((tip, fork(tip)?)))
        .collect();
    // Topological order lists a branch's own commits below its tip, so every
    // commit above the tip is outside the branch.
    let mut earliest_tip_below = i64::MAX;
    let mut tips = branches.iter().rev().peekable();
    let mut candidates = Vec::new();
    for position in (0..commits.len()).rev() {
        let commit = &commits[position];
        if commit.parents.len() == 1 && commit.timestamp >= earliest_tip_below {
            candidates.push(position);
        }
        if let Some(&&(tip, _)) = tips.peek()
            && tip == position
        {
            earliest_tip_below = earliest_tip_below.min(commit.timestamp);
            tips.next();
        }
    }
    candidates.reverse();
    candidates.truncate(SQUASH_SCAN_LIMIT);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    // Diffing every candidate costs far more than listing the paths it
    // changes, so only commits that change a branch's exact paths get diffed.
    let (branch_paths, candidate_paths) = in_parallel(
        || changed_paths(root, ranges(commits, &branches), deadline),
        || changed_paths(root, singles(commits, &candidates), deadline),
    );
    let (branch_paths, candidate_paths) = (branch_paths?, candidate_paths?);
    let mut by_paths: HashMap<&str, Vec<usize>> = HashMap::new();
    for &position in &candidates {
        if let Some(paths) = candidate_paths.get(&commits[position].oid) {
            by_paths.entry(paths).or_default().push(position);
        }
    }
    let mut pairs = Vec::new();
    for &(tip, base) in &branches {
        let Some(matches) = branch_paths
            .get(&commits[tip].oid)
            .and_then(|paths| by_paths.get(paths.as_str()))
        else {
            continue;
        };
        for &position in matches {
            if position < tip && commits[position].timestamp >= commits[tip].timestamp {
                pairs.push(((tip, base), position));
            }
        }
    }
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    let mut paired_branches: Vec<_> = pairs.iter().map(|&(branch, _)| branch).collect();
    paired_branches.dedup();
    let mut paired_candidates: Vec<_> = pairs.iter().map(|&(_, position)| position).collect();
    paired_candidates.sort_unstable();
    paired_candidates.dedup();
    let (branch_patches, candidate_patches) = in_parallel(
        || patch_ids(root, ranges(commits, &paired_branches), deadline),
        || patch_ids(root, singles(commits, &paired_candidates), deadline),
    );
    let (branch_patches, candidate_patches) = (branch_patches?, candidate_patches?);
    Ok(pairs
        .into_iter()
        .filter(|&((tip, _), position)| {
            branch_patches
                .get(&commits[tip].oid)
                .is_some_and(|patch| candidate_patches.get(&commits[position].oid) == Some(patch))
        })
        .map(|((tip, _), position)| Squash {
            tip: commits[tip].oid.clone(),
            commit: commits[position].oid.clone(),
        })
        .collect())
}

/// `git diff-tree --stdin` diffs `<tip> <base>` from the base to the tip and
/// labels it with the tip, so a tip that is also another branch's squash
/// commit needs its range and its own commit read in separate runs.
fn ranges(commits: &[Commit], branches: &[(usize, usize)]) -> Vec<u8> {
    branches
        .iter()
        .flat_map(|&(tip, base)| {
            format!("{} {}\n", commits[tip].oid, commits[base].oid).into_bytes()
        })
        .collect()
}

fn singles(commits: &[Commit], positions: &[usize]) -> Vec<u8> {
    positions
        .iter()
        .flat_map(|&position| format!("{}\n", commits[position].oid).into_bytes())
        .collect()
}

fn in_parallel<A: Send, B>(a: impl FnOnce() -> A + Send, b: impl FnOnce() -> B) -> (A, B) {
    thread::scope(|scope| {
        let a = scope.spawn(a);
        let b = b();
        (
            a.join()
                .unwrap_or_else(|payload| panic::resume_unwind(payload)),
            b,
        )
    })
}

/// Maps each commit `git diff-tree --stdin` reports to its changed paths, one
/// `<status>\t<path>` line each. Empty diffs have no entry.
fn changed_paths(
    root: &Path,
    input: Vec<u8>,
    deadline: Deadline,
) -> Result<HashMap<String, String>, RepositoryError> {
    let output = git::read_with_input(
        root,
        &[
            "diff-tree",
            "--stdin",
            "-r",
            "--name-status",
            "--no-renames",
        ],
        input,
        deadline,
    )?;
    let mut changes: HashMap<String, String> = HashMap::new();
    let mut current = None;
    for line in git::text(&output).lines() {
        if line.contains('\t') {
            let oid = current.as_ref().ok_or_else(git::malformed)?;
            let paths = changes.entry(String::clone(oid)).or_default();
            paths.push_str(line);
            paths.push('\n');
        } else {
            current = Some(line.to_owned());
        }
    }
    Ok(changes)
}

/// Maps each commit `git diff-tree --stdin` reports to the stable patch ID of
/// its diff. Empty diffs have no entry.
fn patch_ids(
    root: &Path,
    input: Vec<u8>,
    deadline: Deadline,
) -> Result<HashMap<String, String>, RepositoryError> {
    let diff = git::read_with_input(
        root,
        &[
            "diff-tree",
            "--stdin",
            "-p",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
        ],
        input,
        deadline,
    )?;
    git::text(&git::read_with_input(
        root,
        &["patch-id", "--stable"],
        diff,
        deadline,
    )?)
    .lines()
    .map(|line| {
        let (patch, oid) = line.split_once(' ').ok_or_else(git::malformed)?;
        Ok((oid.to_owned(), patch.to_owned()))
    })
    .collect()
}

fn open_commit(
    path: &str,
    oid: &str,
    deadline: Deadline,
) -> Result<(PathBuf, Commit), RepositoryError> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RepositoryError::new(
            ErrorKind::InvalidOid,
            "Choose a full commit ID from this repository's history.",
        ));
    }
    let root = root(path, deadline)?;
    let verified = git::run(
        &root,
        &["rev-parse", "--verify", &format!("{oid}^{{commit}}")],
        deadline,
    )?;
    if !verified.status.success() {
        return Err(RepositoryError::new(
            ErrorKind::InvalidOid,
            "This commit is no longer available. Refresh the repository.",
        ));
    }
    let output = git::read(
        &root,
        &["log", "-1", COMMIT_FORMAT, "-z", oid, "--"],
        deadline,
    )?;
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
    commit_detail_within(path, oid, Deadline::of(LocalRead::CommitDetail))
}

pub(crate) fn commit_detail_within(
    path: &str,
    oid: &str,
    deadline: Deadline,
) -> Result<CommitDetail, RepositoryError> {
    let (root, commit) = open_commit(path, oid, deadline)?;
    let message = git::line(&git::read(
        &root,
        &["show", "--no-patch", "--format=%B", oid, "--"],
        deadline,
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
    let output = git::read(&root, &args, deadline)?;
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
    file_patch_within(path, oid, file, Deadline::of(LocalRead::FilePatch))
}

pub(crate) fn file_patch_within(
    path: &str,
    oid: &str,
    file: &str,
    deadline: Deadline,
) -> Result<FilePatch, RepositoryError> {
    let (root, commit) = open_commit(path, oid, deadline)?;
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
    let numstat = git::read(&root, &args("--numstat"), deadline)?;
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
        match git::read_capped(&root, &args("--patch"), PATCH_LIMIT, deadline)? {
            git::Capped::Within(patch) => text_patch(&patch),
            git::Capped::Over(bytes) => FilePatch::TooLarge { bytes },
        },
    )
}

pub(crate) fn text_patch(patch: &[u8]) -> FilePatch {
    FilePatch::Text {
        lossy: std::str::from_utf8(patch).is_err(),
        patch: git::text(patch),
    }
}

/// Counts each commit's changed lines against the same base as its detail.
/// Commits Git cannot read are left out instead of failing the whole batch.
pub fn line_stats(path: &str, oids: &[String]) -> Result<Vec<LineStats>, RepositoryError> {
    line_stats_within(path, oids, Deadline::of(LocalRead::LineStats))
}

pub(crate) fn line_stats_within(
    path: &str,
    oids: &[String],
    deadline: Deadline,
) -> Result<Vec<LineStats>, RepositoryError> {
    if oids.len() > LINE_STATS_LIMIT {
        return Err(RepositoryError::new(
            ErrorKind::InvalidOid,
            format!("Request line counts for at most {LINE_STATS_LIMIT} commits at once."),
        ));
    }
    for oid in oids {
        Oid::try_from(oid.clone())?;
    }
    let root = root(path, deadline)?;
    let output = git::read_with_input(
        &root,
        &[
            "diff-tree",
            "--stdin",
            "--always",
            "-r",
            "-z",
            "--numstat",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--root",
            "--diff-merges=first-parent",
        ],
        oids.iter()
            .flat_map(|oid| format!("{oid}\n").into_bytes())
            .collect(),
        deadline,
    )?;
    let lines = |count: &[u8]| match count {
        b"-" => Ok(0),
        count => std::str::from_utf8(count)
            .ok()
            .and_then(|count| count.parse::<u64>().ok())
            .ok_or_else(git::malformed),
    };
    let mut counts: HashMap<&[u8], (u64, u64)> = HashMap::new();
    let mut current = None;
    for field in output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let mut columns = field.splitn(3, |byte| *byte == b'\t');
        match (columns.next(), columns.next(), columns.next()) {
            (Some(oid), None, None) => {
                counts.entry(oid).or_default();
                current = Some(oid);
            }
            (Some(added), Some(deleted), Some(_)) => {
                let total = current
                    .and_then(|oid| counts.get_mut(oid))
                    .ok_or_else(git::malformed)?;
                total.0 += lines(added)?;
                total.1 += lines(deleted)?;
            }
            _ => return Err(git::malformed()),
        }
    }
    Ok(oids
        .iter()
        .filter_map(|oid| {
            let &(added, deleted) = counts.get(oid.as_bytes())?;
            Some(LineStats {
                oid: oid.clone(),
                added,
                deleted,
            })
        })
        .collect())
}

fn unchanged_path() -> RepositoryError {
    RepositoryError::new(
        ErrorKind::UnchangedPath,
        "This file did not change in the selected commit. Choose one of its changed paths.",
    )
}
