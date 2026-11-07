use crate::{
    AddRemote, AddRemoteReport, Advance, Applied, Blame, BranchMerged, BranchTip, CloneUrl,
    CommitDetail, Comparison, ConflictFile, Coordinator, EntryId, Expect, FastForwardReport,
    FetchMode, FilePatch, FileRevision, Head, LineStats, MergeAction, MergeReport, MergeReview,
    MergeSelection, MergeState, NewRepository, Operation, PublishChoice, PublishOptions,
    PushAvailability, PushIntent, PushReport, ReplayOf, ReplayReview, RepositoryError,
    RepositoryOverview, RepositoryRefs, RepositorySnapshot, Side, UndoHistory, WorktreePatch,
    WorktreeStatus,
    directories::{DirectoryListing, expand_home, home_dir, list_directories},
    file_history::{blame_within, file_history_within},
    git::LocalRead,
    repository::{
        commit_detail_within, file_patch_within, line_stats_within, refs_within, snapshot_within,
    },
    status::worktree_patch_within,
    write::merged_within,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    MergeReview {
        path: String,
        selection: MergeSelection,
    },
    MergeState {
        path: String,
    },
    Merge {
        path: String,
        action: MergeAction,
    },
    ReplayReview {
        path: String,
        of: ReplayOf,
    },
    ReplayAbort {
        path: String,
        of: ReplayOf,
        head: Head,
    },
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
    PublishOptions {
        path: String,
    },
    AddRemote {
        path: String,
        remote: AddRemote,
    },
    PreparePublish {
        path: String,
        choice: PublishChoice,
    },
    PreparePush {
        path: String,
    },
    Push {
        path: String,
        intent: PushIntent,
    },
    FastForward {
        path: String,
        advances: Vec<Advance>,
    },
    WorktreeStatus {
        path: String,
    },
    ConflictFile {
        path: String,
        file: String,
    },
    WorktreePatch {
        path: String,
        file: String,
        side: Side,
    },
    Write {
        path: String,
        operation: Operation,
        expect: Expect,
    },
    Undo {
        path: String,
        id: EntryId,
    },
    Redo {
        path: String,
        id: EntryId,
    },
    UndoHistory {
        path: String,
    },
    BranchMerged {
        path: String,
        branch: BranchTip,
    },
    ListDirectories {
        path: String,
    },
    CreateRepository {
        path: String,
    },
    CloneRepository {
        url: CloneUrl,
        path: String,
    },
    CancelClone {
        path: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "op", content = "data", rename_all = "camelCase")]
pub enum Response {
    MergeReview(MergeReview),
    MergeState(MergeState),
    Merge(MergeReport),
    ReplayReview(ReplayReview),
    ReplayAbort(MergeState),
    Snapshot(RepositorySnapshot),
    Refs(RepositoryRefs),
    CommitDetail(CommitDetail),
    LineStats(Vec<LineStats>),
    FilePatch(FilePatch),
    FileHistory(Vec<FileRevision>),
    Blame(Blame),
    Overview(RepositoryOverview),
    PublishOptions(PublishOptions),
    AddRemote(AddRemoteReport),
    PreparePublish(PushAvailability),
    PreparePush(PushAvailability),
    Push(PushReport),
    FastForward(FastForwardReport),
    WorktreeStatus(WorktreeStatus),
    WorktreePatch(WorktreePatch),
    ConflictFile(ConflictFile),
    Write(Applied),
    Undo(Applied),
    Redo(Applied),
    UndoHistory(UndoHistory),
    BranchMerged(BranchMerged),
    ListDirectories(DirectoryListing),
    CreateRepository(NewRepository),
    CloneRepository(NewRepository),
    CancelClone,
}

pub fn run(coordinator: &Coordinator, request: Request) -> Result<Response, RepositoryError> {
    let deadline = |read| coordinator.deadline(read);
    Ok(match request {
        Request::MergeReview { path, selection } => {
            Response::MergeReview(coordinator.review_merge(&path, &selection)?)
        }
        Request::MergeState { path } => Response::MergeState(coordinator.merge_state(&path)?),
        Request::Merge { path, action } => Response::Merge(coordinator.merge(&path, &action)?),
        Request::ReplayReview { path, of } => {
            Response::ReplayReview(coordinator.review_replay(&path, &of)?)
        }
        Request::ReplayAbort { path, of, head } => {
            Response::ReplayAbort(coordinator.abort_replay(&path, &of, &head)?)
        }
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
        Request::PublishOptions { path } => {
            Response::PublishOptions(coordinator.publish_options(&path)?)
        }
        Request::AddRemote { path, remote } => {
            Response::AddRemote(coordinator.add_remote(&path, &remote)?)
        }
        Request::PreparePublish { path, choice } => {
            Response::PreparePublish(coordinator.prepare_publish(&path, &choice)?)
        }
        Request::PreparePush { path } => Response::PreparePush(coordinator.prepare_push(&path)?),
        Request::Push { path, intent } => Response::Push(coordinator.push(&path, &intent)?),
        Request::FastForward { path, advances } => {
            Response::FastForward(coordinator.fast_forward(&path, &advances)?)
        }
        Request::WorktreeStatus { path } => {
            Response::WorktreeStatus(coordinator.worktree_status(&path)?)
        }
        Request::ConflictFile { path, file } => Response::ConflictFile(
            crate::write::conflict_file_within(&path, &file, deadline(LocalRead::ConflictFile))?,
        ),
        Request::WorktreePatch { path, file, side } => Response::WorktreePatch(
            worktree_patch_within(&path, &file, side, deadline(LocalRead::WorktreePatch))?,
        ),
        Request::Write {
            path,
            operation,
            expect,
        } => Response::Write(coordinator.write(&path, &operation, &expect)?),
        Request::Undo { path, id } => Response::Undo(coordinator.undo(&path, id)?),
        Request::Redo { path, id } => Response::Redo(coordinator.redo(&path, id)?),
        Request::UndoHistory { path } => Response::UndoHistory(coordinator.undo_history(&path)?),
        Request::BranchMerged { path, branch } => Response::BranchMerged(merged_within(
            &path,
            &branch,
            deadline(LocalRead::BranchMerged),
        )?),
        Request::ListDirectories { path } => {
            Response::ListDirectories(list_directories(&path, home_dir().as_deref())?)
        }
        Request::CreateRepository { path } => Response::CreateRepository(
            coordinator.create_repository(&expand_home(&path, home_dir().as_deref())?)?,
        ),
        Request::CloneRepository { url, path } => Response::CloneRepository(
            coordinator.clone_repository(&url.0, &expand_home(&path, home_dir().as_deref())?)?,
        ),
        Request::CancelClone { path } => {
            coordinator.cancel_clone(&expand_home(&path, home_dir().as_deref())?);
            Response::CancelClone
        }
    })
}
