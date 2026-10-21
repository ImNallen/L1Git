use super::{now, stderr};
use crate::{
    Blocker, BranchRef, BranchRole, BranchState, BranchStatus, ErrorKind, FetchSummary, Oid,
    RepositoryError, RepositoryOverview,
    git::{self, Deadline, Finished, Mutation},
    repository,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

const MAINLINE: [&str; 5] = ["main", "master", "develop", "development", "trunk"];
const FALLBACK_DEFAULT: [&str; 2] = ["main", "master"];
/// What Git leaves in a worktree's git dir while a merge, rebase, am,
/// cherry-pick, revert, or bisect is unfinished.
const OPERATION_STATE: [&str; 7] = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_LOG",
];

pub(super) struct Repository {
    pub root: PathBuf,
    pub common_dir: PathBuf,
}

pub(super) fn open(path: &str, reads: Deadline) -> Result<Repository, RepositoryError> {
    let root = repository::root(path, reads)?;
    let output = git::read(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        reads,
    )?;
    let common_dir = Path::new(&git::line(&output)).canonicalize().map_err(|_| {
        RepositoryError::new(
            ErrorKind::MissingPath,
            "The repository moved while opening. Choose its current folder.",
        )
    })?;
    Ok(Repository { root, common_dir })
}

/// A worktree path can contain a newline, so each record ends with NUL and
/// newline. No field starts with a newline: paths are absolute and refs start
/// with `refs/`.
fn records(output: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut rest = output;
    std::iter::from_fn(move || {
        let end = rest.windows(2).position(|pair| pair == b"\0\n")?;
        let record = &rest[..end];
        rest = &rest[end + 2..];
        Some(record)
    })
}

struct Row {
    reference: String,
    oid: String,
    upstream: String,
    track: String,
    worktree: String,
    symref: String,
}

fn rows(root: &Path, patterns: &[&str], reads: Deadline) -> Result<Vec<Row>, RepositoryError> {
    let mut args = vec![
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(symref)%00",
    ];
    args.extend(patterns);
    let output = git::read(root, &args, reads)?;
    records(&output)
        .filter_map(|row| {
            let fields: Vec<_> = row.split(|byte| *byte == 0).collect();
            let Ok([reference, oid, upstream, track, worktree, symref]) =
                <[&[u8]; 6]>::try_from(fields)
            else {
                return Some(Err(git::malformed()));
            };
            Some(Ok(Row {
                reference: String::from_utf8(reference.to_vec()).ok()?,
                oid: git::text(oid),
                upstream: git::text(upstream),
                track: git::text(track),
                worktree: git::text(worktree),
                symref: git::text(symref),
            }))
        })
        .collect()
}

pub(super) fn read(
    repository: &Repository,
    fetch: Option<FetchSummary>,
    deadline: Duration,
    mut reads: Deadline,
) -> Result<RepositoryOverview, RepositoryError> {
    let root = &repository.root;
    let rows = rows(root, &["refs/heads/", "refs/remotes/"], reads)?;
    let tips: HashMap<&str, &str> = rows
        .iter()
        .map(|row| (row.reference.as_str(), row.oid.as_str()))
        .collect();
    let remote_heads: Vec<(&str, &str)> = rows
        .iter()
        .filter(|row| !row.symref.is_empty())
        .filter_map(|row| {
            let remote = row
                .reference
                .strip_prefix("refs/remotes/")?
                .strip_suffix("/HEAD")?;
            Some((remote, row.symref.as_str()))
        })
        .collect();
    let locals: Vec<(BranchRef, &Row)> = rows.iter().filter_map(local_ref).collect();
    let roles = roles(
        &locals
            .iter()
            .map(|(reference, row)| (reference.name(), row.upstream.as_str()))
            .collect::<Vec<_>>(),
        &remote_heads,
    );
    let detached = has_detached_worktree(root, reads)?;
    let mut branches = Vec::with_capacity(locals.len());
    for ((reference, row), role) in locals.into_iter().zip(roles) {
        let Local {
            oid,
            checked_out_at,
            state,
        } = local(root, &reference, row, &tips, detached, deadline, &mut reads)?;
        branches.push(BranchStatus {
            name: reference.name().to_owned(),
            reference,
            oid,
            role,
            checked_out_at,
            state,
        });
    }
    let common_dir = &repository.common_dir;
    let main_worktree = if common_dir.file_name().is_some_and(|name| name == ".git") {
        common_dir.parent().unwrap_or(root)
    } else {
        root
    };
    Ok(RepositoryOverview {
        root: utf8(root)?,
        common_dir: utf8(common_dir)?,
        name: main_worktree
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Repository".into()),
        branches,
        fetch,
        observed_at: now(),
    })
}

pub(super) fn branch(
    root: &Path,
    reference: &BranchRef,
    deadline: Duration,
    reads: &mut Deadline,
) -> Result<Option<Local>, RepositoryError> {
    let rows = rows(root, &[reference.as_str()], *reads)?;
    let Some((reference, row)) = rows
        .iter()
        .filter_map(local_ref)
        .find(|(found, _)| found == reference)
    else {
        return Ok(None);
    };
    let detached = has_detached_worktree(root, *reads)?;
    local(
        root,
        &reference,
        row,
        &HashMap::new(),
        detached,
        deadline,
        reads,
    )
    .map(Some)
}

/// A symbolic `refs/heads/*` is skipped because `update-ref` would move the
/// branch it points to.
fn local_ref(row: &Row) -> Option<(BranchRef, &Row)> {
    if !row.symref.is_empty() {
        return None;
    }
    Some((BranchRef::try_from(row.reference.clone()).ok()?, row))
}

pub(super) struct Local {
    pub oid: Oid,
    pub checked_out_at: Option<String>,
    pub state: BranchState,
}

fn local(
    root: &Path,
    reference: &BranchRef,
    row: &Row,
    tips: &HashMap<&str, &str>,
    detached: bool,
    deadline: Duration,
    reads: &mut Deadline,
) -> Result<Local, RepositoryError> {
    let oid = Oid::try_from(row.oid.clone()).map_err(|_| git::malformed())?;
    let track = parse_track(&row.track).ok_or_else(git::malformed)?;
    let target = match track {
        Track::Counts { ahead: 0, behind } if behind > 0 => {
            upstream_oid(root, &row.upstream, tips, *reads)?
        }
        _ => None,
    };
    let mut state = state(&row.upstream, track, target);
    let mut checked_out_at = (!row.worktree.is_empty()).then(|| row.worktree.clone());
    if let BranchState::Behind {
        target, blocker, ..
    } = &mut state
    {
        let checkout = match checked_out_at.take() {
            Some(worktree) => Checkout::At(worktree),
            None if !detached => Checkout::Nowhere,
            None => {
                let checkout = hidden_checkout(root, reference, target, deadline)?;
                *reads = reads.renewed();
                checkout
            }
        };
        match checkout {
            Checkout::Nowhere => {}
            Checkout::At(worktree) => {
                *blocker = blocker_for(reference, &occupant(&worktree, *reads)?);
                checked_out_at = Some(worktree);
            }
            Checkout::Unverified(message) => *blocker = Some(Blocker::Unverified { message }),
        }
    }
    Ok(Local {
        oid,
        checked_out_at,
        state,
    })
}

/// An upstream outside `refs/heads/` and `refs/remotes/`, such as one mapped by
/// a custom fetch refspec, is missing from `tips`.
fn upstream_oid(
    root: &Path,
    upstream: &str,
    tips: &HashMap<&str, &str>,
    reads: Deadline,
) -> Result<Option<Oid>, RepositoryError> {
    let tip = match tips.get(upstream) {
        Some(tip) => (*tip).to_owned(),
        None => {
            let output = git::run(
                root,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{upstream}^{{commit}}"),
                ],
                reads,
            )?;
            if !output.status.success() {
                return Ok(None);
            }
            git::line(&output.stdout)
        }
    };
    Ok(Oid::try_from(tip).ok())
}

fn utf8(path: &Path) -> Result<String, RepositoryError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        RepositoryError::new(
            ErrorKind::UnsupportedPath,
            "Repository paths must be valid UTF-8.",
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Track {
    Gone,
    Counts { ahead: u32, behind: u32 },
}

fn parse_track(track: &str) -> Option<Track> {
    if track == "gone" {
        return Some(Track::Gone);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in track.split(", ").filter(|part| !part.is_empty()) {
        match part.split_once(' ')? {
            ("ahead", count) => ahead = count.parse().ok()?,
            ("behind", count) => behind = count.parse().ok()?,
            _ => return None,
        }
    }
    Some(Track::Counts { ahead, behind })
}

fn state(upstream: &str, track: Track, target: Option<Oid>) -> BranchState {
    if upstream.is_empty() {
        return BranchState::Untracked;
    }
    let upstream = upstream.to_owned();
    match track {
        Track::Gone => BranchState::Gone { upstream },
        Track::Counts {
            ahead: 0,
            behind: 0,
        } => BranchState::UpToDate { upstream },
        Track::Counts { ahead, behind: 0 } => BranchState::Ahead { upstream, ahead },
        Track::Counts { ahead: 0, behind } => match target {
            Some(target) => BranchState::Behind {
                upstream,
                target,
                behind,
                blocker: None,
            },
            None => BranchState::Untracked,
        },
        Track::Counts { ahead, behind } => BranchState::Diverged {
            upstream,
            ahead,
            behind,
        },
    }
}

fn roles(branches: &[(&str, &str)], remote_heads: &[(&str, &str)]) -> Vec<BranchRole> {
    let remote_head = remote_heads
        .iter()
        .find(|(remote, _)| *remote == "origin")
        .or_else(|| remote_heads.first());
    let tracking_head = remote_head.and_then(|(remote, target)| {
        let short = target.strip_prefix(&format!("refs/remotes/{remote}/"));
        let trackers = || {
            branches
                .iter()
                .enumerate()
                .filter(|(_, (_, upstream))| upstream == target)
        };
        trackers()
            .find(|(_, (name, _))| Some(*name) == short)
            .or_else(|| trackers().next())
            .map(|(index, _)| index)
    });
    let default = tracking_head.or_else(|| {
        FALLBACK_DEFAULT
            .iter()
            .find_map(|candidate| branches.iter().position(|(name, _)| name == candidate))
    });
    branches
        .iter()
        .enumerate()
        .map(|(index, (name, _))| {
            if Some(index) == default {
                BranchRole::Default
            } else if MAINLINE.contains(name) {
                BranchRole::Mainline
            } else {
                BranchRole::Other
            }
        })
        .collect()
}

/// Rebase and bisect detach HEAD, so only a detached worktree can hide a
/// checked-out branch from `%(worktreepath)`.
fn has_detached_worktree(root: &Path, reads: Deadline) -> Result<bool, RepositoryError> {
    let output = git::run(root, &["worktree", "list", "--porcelain", "-z"], reads)?;
    Ok(!output.status.success()
        || output
            .stdout
            .split(|byte| *byte == 0)
            .any(|field| field == b"detached"))
}

enum Checkout {
    Nowhere,
    At(String),
    Unverified(String),
}

/// Asks Git whether the branch is checked out anywhere. `%(worktreepath)` is
/// empty for a branch whose worktree is mid-rebase or mid-bisect. Only a probe
/// that succeeds proves the branch is free.
fn hidden_checkout(
    root: &Path,
    branch: &BranchRef,
    to: &Oid,
    deadline: Duration,
) -> Result<Checkout, RepositoryError> {
    Ok(
        match git::mutate(root, Mutation::ProbeFastForward { branch, to }, deadline)? {
            Finished::Succeeded => Checkout::Nowhere,
            Finished::Failed { stderr } => match checked_out_at(&stderr) {
                Some(worktree) => Checkout::At(worktree),
                None => Checkout::Unverified(format!(
                    "Git could not check whether this branch is checked out. {}",
                    stderr::summarize(&stderr)
                )),
            },
            Finished::TimedOut => Checkout::Unverified(
                "Git did not finish checking whether this branch is checked out.".into(),
            ),
        },
    )
}

fn checked_out_at(stderr: &str) -> Option<String> {
    let (_, rest) = stderr.split_once(" checked out at '")?;
    let (path, _) = rest.rsplit_once('\'')?;
    Some(path.to_owned())
}

#[derive(Debug)]
struct Occupant {
    worktree: String,
    head: Option<String>,
    mid_operation: bool,
    dirty: bool,
}

fn occupant(worktree: &str, reads: Deadline) -> Result<Occupant, RepositoryError> {
    let path = Path::new(worktree);
    let head = git::run(path, &["symbolic-ref", "--quiet", "HEAD"], reads)?;
    let mut pending = vec!["rev-parse", "--path-format=absolute"];
    for operation in OPERATION_STATE {
        pending.extend(["--git-path", operation]);
    }
    let pending = git::run(path, &pending, reads)?;
    let status = git::run(
        path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=no"],
        reads,
    )?;
    Ok(Occupant {
        worktree: worktree.to_owned(),
        head: head.status.success().then(|| git::line(&head.stdout)),
        mid_operation: !pending.status.success()
            || git::text(&pending.stdout)
                .lines()
                .any(|path| Path::new(path).exists()),
        dirty: !status.status.success() || !status.stdout.is_empty(),
    })
}

/// Untracked files never block, because Git refuses the merge itself when it
/// would overwrite one.
fn blocker_for(branch: &BranchRef, occupant: &Occupant) -> Option<Blocker> {
    let worktree = occupant.worktree.clone();
    if occupant.head.as_deref() != Some(branch.as_str()) || occupant.mid_operation {
        Some(Blocker::InUse { worktree })
    } else if occupant.dirty {
        Some(Blocker::Dirty { worktree })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(digit: char) -> Oid {
        Oid::try_from(digit.to_string().repeat(40)).unwrap()
    }

    #[test]
    fn parses_every_track_form() {
        assert_eq!(
            parse_track(""),
            Some(Track::Counts {
                ahead: 0,
                behind: 0
            })
        );
        assert_eq!(parse_track("gone"), Some(Track::Gone));
        assert_eq!(
            parse_track("ahead 2"),
            Some(Track::Counts {
                ahead: 2,
                behind: 0
            })
        );
        assert_eq!(
            parse_track("behind 13"),
            Some(Track::Counts {
                ahead: 0,
                behind: 13
            })
        );
        assert_eq!(
            parse_track("ahead 1, behind 4"),
            Some(Track::Counts {
                ahead: 1,
                behind: 4
            })
        );
        assert_eq!(parse_track("ahead x"), None);
        assert_eq!(parse_track("sideways 1"), None);
    }

    #[test]
    fn derives_state_from_upstream_and_track() {
        let upstream = "refs/remotes/origin/main";
        let counts = |ahead, behind| Track::Counts { ahead, behind };
        assert_eq!(state("", Track::Gone, None), BranchState::Untracked);
        assert_eq!(
            state(upstream, Track::Gone, None),
            BranchState::Gone {
                upstream: upstream.into()
            }
        );
        assert_eq!(
            state(upstream, counts(0, 0), Some(oid('a'))),
            BranchState::UpToDate {
                upstream: upstream.into()
            }
        );
        assert_eq!(
            state(upstream, counts(3, 0), Some(oid('a'))),
            BranchState::Ahead {
                upstream: upstream.into(),
                ahead: 3
            }
        );
        assert_eq!(
            state(upstream, counts(0, 2), Some(oid('a'))),
            BranchState::Behind {
                upstream: upstream.into(),
                target: oid('a'),
                behind: 2,
                blocker: None
            }
        );
        assert_eq!(
            state(upstream, counts(1, 2), Some(oid('a'))),
            BranchState::Diverged {
                upstream: upstream.into(),
                ahead: 1,
                behind: 2
            }
        );
        assert_eq!(state(upstream, counts(0, 2), None), BranchState::Untracked);
    }

    #[test]
    fn assigns_one_default_and_marks_mainlines() {
        use BranchRole::{Default, Mainline, Other};
        let branches = [
            ("develop", "refs/remotes/origin/develop"),
            ("feature", "refs/remotes/origin/develop"),
            ("main", "refs/remotes/origin/main"),
            ("trunk", ""),
        ];
        assert_eq!(
            roles(
                &branches,
                &[
                    ("fork", "refs/remotes/fork/main"),
                    ("origin", "refs/remotes/origin/develop")
                ]
            ),
            [Default, Other, Mainline, Mainline]
        );
        assert_eq!(
            roles(&branches, &[("fork", "refs/remotes/fork/main")]),
            [Mainline, Other, Default, Mainline]
        );
        assert_eq!(roles(&branches, &[]), [Mainline, Other, Default, Mainline]);
        assert_eq!(
            roles(&[("feature", ""), ("master", "")], &[]),
            [Other, Default]
        );
        assert_eq!(
            roles(
                &[("main", ""), ("work", "refs/remotes/fork/trunk")],
                &[("fork", "refs/remotes/fork/trunk")]
            ),
            [Mainline, Default]
        );
        assert_eq!(roles(&[("feature", "")], &[]), [Other]);
    }

    #[test]
    fn reads_the_worktree_from_gits_refusal() {
        assert_eq!(
            checked_out_at(
                "fatal: refusing to fetch into branch 'refs/heads/rb' checked out at '/tmp/it's here'\n"
            )
            .as_deref(),
            Some("/tmp/it's here")
        );
        assert_eq!(
            checked_out_at(" ! [rejected] a -> b (non-fast-forward)\n"),
            None
        );
    }

    #[test]
    fn blocks_on_other_heads_operations_and_tracked_changes() {
        let branch = BranchRef::try_from("refs/heads/main".to_owned()).unwrap();
        let occupant = |head: Option<&str>, mid_operation, dirty| Occupant {
            worktree: "/w".into(),
            head: head.map(str::to_owned),
            mid_operation,
            dirty,
        };
        let in_use = Some(Blocker::InUse {
            worktree: "/w".into(),
        });
        assert_eq!(
            blocker_for(&branch, &occupant(Some("refs/heads/main"), false, false)),
            None
        );
        assert_eq!(
            blocker_for(&branch, &occupant(Some("refs/heads/main"), false, true)),
            Some(Blocker::Dirty {
                worktree: "/w".into()
            })
        );
        assert_eq!(
            blocker_for(&branch, &occupant(Some("refs/heads/main"), true, true)),
            in_use
        );
        assert_eq!(blocker_for(&branch, &occupant(None, false, false)), in_use);
        assert_eq!(
            blocker_for(&branch, &occupant(Some("refs/heads/other"), false, false)),
            in_use
        );
    }
}
