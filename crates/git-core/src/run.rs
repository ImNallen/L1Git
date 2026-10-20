use crate::{
    Advance, CommitDetail, Coordinator, FastForwardReport, FetchMode, FilePatch, LineStats,
    RepositoryError, RepositoryOverview, RepositoryRefs, RepositorySnapshot, Side, WorktreePatch,
    WorktreeStatus, commit_detail, file_patch, line_stats, refs, snapshot, worktree_patch,
    worktree_status,
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
        oid: String,
    },
    LineStats {
        path: String,
        oids: Vec<String>,
    },
    FilePatch {
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
    Overview(RepositoryOverview),
    FastForward(FastForwardReport),
    WorktreeStatus(WorktreeStatus),
    WorktreePatch(WorktreePatch),
}

pub fn run(coordinator: &Coordinator, request: Request) -> Result<Response, RepositoryError> {
    Ok(match request {
        Request::Snapshot { path } => Response::Snapshot(snapshot(&path)?),
        Request::Refs { path } => Response::Refs(refs(&path)?),
        Request::CommitDetail { path, oid } => Response::CommitDetail(commit_detail(&path, &oid)?),
        Request::LineStats { path, oids } => Response::LineStats(line_stats(&path, &oids)?),
        Request::FilePatch { path, oid, file } => {
            Response::FilePatch(file_patch(&path, &oid, &file)?)
        }
        Request::Overview { path, mode } => Response::Overview(coordinator.overview(&path, mode)?),
        Request::FastForward { path, advances } => {
            Response::FastForward(coordinator.fast_forward(&path, &advances)?)
        }
        Request::WorktreeStatus { path } => Response::WorktreeStatus(worktree_status(&path)?),
        Request::WorktreePatch { path, file, side } => {
            Response::WorktreePatch(worktree_patch(&path, &file, side)?)
        }
    })
}
