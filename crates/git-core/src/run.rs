use crate::{
    Advance, Blame, CommitDetail, Comparison, Coordinator, FastForwardReport, FetchMode, FilePatch,
    FileRevision, LineStats, RepositoryError, RepositoryOverview, RepositoryRefs,
    RepositorySnapshot, Side, WorktreePatch, WorktreeStatus,
    file_history::{blame_within, file_history_within},
    git::LocalRead,
    repository::{
        commit_detail_within, file_patch_within, line_stats_within, refs_within, snapshot_within,
    },
    status::{worktree_patch_within, worktree_status_within},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Snapshot {
        path: String,
    },
    Refs {
        path: String,
    },
    CommitDetail {
        path: String,
        comparison: Comparison,
    },
    LineStats {
        path: String,
        oids: Vec<String>,
    },
    FilePatch {
        path: String,
        comparison: Comparison,
        file: String,
    },
    FileHistory {
        path: String,
        oid: String,
        file: String,
    },
    Blame {
        path: String,
        oid: String,
        file: String,
    },
    Overview {
        path: String,
        mode: FetchMode,
    },
    FastForward {
        path: String,
        advances: Vec<Advance>,
    },
    WorktreeStatus {
        path: String,
    },
    WorktreePatch {
        path: String,
        file: String,
        side: Side,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "op", content = "data", rename_all = "camelCase")]
pub enum Response {
    Snapshot(RepositorySnapshot),
    Refs(RepositoryRefs),
    CommitDetail(CommitDetail),
    LineStats(Vec<LineStats>),
    FilePatch(FilePatch),
    FileHistory(Vec<FileRevision>),
    Blame(Blame),
    Overview(RepositoryOverview),
    FastForward(FastForwardReport),
    WorktreeStatus(WorktreeStatus),
    WorktreePatch(WorktreePatch),
}

pub fn run(coordinator: &Coordinator, request: Request) -> Result<Response, RepositoryError> {
    let deadline = |read| coordinator.deadline(read);
    Ok(match request {
        Request::Snapshot { path } => {
            Response::Snapshot(snapshot_within(&path, deadline(LocalRead::Snapshot))?)
        }
        Request::Refs { path } => Response::Refs(refs_within(&path, deadline(LocalRead::Refs))?),
        Request::CommitDetail { path, comparison } => Response::CommitDetail(commit_detail_within(
            &path,
            &comparison,
            deadline(LocalRead::CommitDetail),
        )?),
        Request::LineStats { path, oids } => Response::LineStats(line_stats_within(
            &path,
            &oids,
            deadline(LocalRead::LineStats),
        )?),
        Request::FilePatch {
            path,
            comparison,
            file,
        } => Response::FilePatch(file_patch_within(
            &path,
            &comparison,
            &file,
            deadline(LocalRead::FilePatch),
        )?),
        Request::FileHistory { path, oid, file } => Response::FileHistory(file_history_within(
            &path,
            &oid,
            &file,
            deadline(LocalRead::FileHistory),
        )?),
        Request::Blame { path, oid, file } => Response::Blame(blame_within(
            &path,
            &oid,
            &file,
            deadline(LocalRead::Blame),
        )?),
        Request::Overview { path, mode } => Response::Overview(coordinator.overview(&path, mode)?),
        Request::FastForward { path, advances } => {
            Response::FastForward(coordinator.fast_forward(&path, &advances)?)
        }
        Request::WorktreeStatus { path } => Response::WorktreeStatus(worktree_status_within(
            &path,
            deadline(LocalRead::WorktreeStatus),
        )?),
        Request::WorktreePatch { path, file, side } => Response::WorktreePatch(
            worktree_patch_within(&path, &file, side, deadline(LocalRead::WorktreePatch))?,
        ),
    })
}
