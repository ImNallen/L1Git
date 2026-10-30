mod exit_signals;
mod file_history;
mod git;
mod model;
mod remotes;
mod repository;
mod run;
mod status;
mod stderr;
mod sync;
mod untracked;
#[cfg(windows)]
mod windows_fs;
mod write;

pub use exit_signals::{OnQuit, stop_git_on_exit_signals};
pub use file_history::{blame, file_history};
pub use git::stop_all_git;
pub use model::*;
pub use repository::{
    HISTORY_LIMIT, LINE_STATS_LIMIT, PATCH_LIMIT, commit_detail, file_patch, line_stats, refs,
    snapshot,
};
pub use run::{Request, Response, run};
pub use status::{worktree_patch, worktree_status};
pub use sync::{
    AddRemote, AddRemoteRefresh, AddRemoteReport, Coordinator, Limits, PublishChoice,
    PublishOptions, PublishRemote, PublishRemoteAvailability, PushAvailability, PushIntent,
    PushOutcome, PushPurpose, PushRefresh, PushReport, PushUnavailable, TrackingOutcome,
};
pub use write::{
    Applied, BranchTip, EntryId, Expect, LinePick, LineSide, Operation, Start, StashTip, TagTip,
    UndoHistory,
};
