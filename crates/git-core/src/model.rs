use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Head {
    Attached { reference: String, oid: String },
    Unborn { reference: String },
    Detached { oid: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Branch {
    Local {
        reference: String,
        name: String,
        oid: String,
        upstream: Option<String>,
    },
    Remote {
        reference: String,
        name: String,
        oid: String,
        remote: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub reference: String,
    pub name: String,
    /// The commit the tag points at, through any annotated tag objects.
    pub oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub root: String,
    pub name: String,
    pub head: Head,
    /// This worktree is the snapshot's root.
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepository {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Remote {
    pub name: String,
    pub url: String,
    pub github: Option<GitHubRepository>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
}

/// `commit` carries the combined changes of the branch that ends at `tip`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Squash {
    pub tip: String,
    pub commit: String,
}

/// The branch list of a repository without its history, for sidebar rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRefs {
    pub root: String,
    pub name: String,
    pub head: Head,
    pub branches: Vec<Branch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub root: String,
    pub name: String,
    pub head: Head,
    pub branches: Vec<Branch>,
    /// Tags that point at commits, sorted by ref name.
    pub tags: Vec<Tag>,
    /// Every worktree of the repository except bare and prunable entries.
    pub worktrees: Vec<Worktree>,
    pub remotes: Vec<Remote>,
    pub commits: Vec<Commit>,
    pub squashes: Vec<Squash>,
    pub history_truncated: bool,
    pub observed_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChangeStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "T")]
    TypeChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: Commit,
    pub message: String,
    pub files: Vec<ChangedFile>,
    pub diff_base: DiffBase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffBase {
    EmptyTree,
    FirstParent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilePatch {
    Text { patch: String, lossy: bool },
    Binary,
    TooLarge { bytes: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineStats {
    pub oid: String,
    pub added: u64,
    pub deleted: u64,
}

/// The uncommitted changes of one worktree, in the order Git lists them:
/// changed paths, then unmerged paths, then untracked paths, each by path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub root: String,
    pub head: Head,
    pub entries: Vec<StatusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StatusEntry {
    Ordinary {
        path: String,
        submodule: Option<SubmoduleState>,
        sides: Sides,
    },
    Renamed {
        path: String,
        original: String,
        how: Moved,
        submodule: Option<SubmoduleState>,
        side: MoveSide,
    },
    Unmerged {
        path: String,
        conflict: Conflict,
        submodule: Option<SubmoduleState>,
    },
    Untracked {
        path: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Sides {
    Staged {
        staged: ChangeStatus,
    },
    Unstaged {
        unstaged: ChangeStatus,
    },
    Both {
        staged: ChangeStatus,
        unstaged: ChangeStatus,
    },
}

/// A move between the index and the working tree comes from a path added with
/// `git add -N`, and its index side never carries a separate change.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MoveSide {
    Staged { unstaged: Option<ChangeStatus> },
    Unstaged,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Moved {
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleState {
    pub commit_changed: bool,
    pub modified: bool,
    pub untracked: bool,
}

/// `Staged` compares HEAD, or the empty tree before the first commit, with the
/// index. `Unstaged` compares the index with the working tree.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Staged,
    Unstaged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreePatch {
    Diff {
        diff: FilePatch,
    },
    Submodule {
        submodule: SubmoduleState,
    },
    /// `diff` compares the working-tree file, conflict markers included, with
    /// HEAD. It is absent for a submodule and when that file is gone or matches
    /// HEAD.
    Conflicted {
        conflict: Conflict,
        diff: Option<FilePatch>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    BothDeleted,
    AddedByUs,
    DeletedByThem,
    AddedByThem,
    DeletedByUs,
    BothAdded,
    BothModified,
}

/// A full 40- or 64-digit lowercase object id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Oid(String);

impl Oid {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Oid {
    type Error = RepositoryError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if matches!(value.len(), 40 | 64)
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(Self(value))
        } else {
            Err(RepositoryError::new(
                ErrorKind::InvalidOid,
                "Use a full commit ID.",
            ))
        }
    }
}

impl From<Oid> for String {
    fn from(value: Oid) -> Self {
        value.0
    }
}

/// A `refs/heads/*` name, the only kind of ref L1 Git moves. Remote-tracking refs,
/// tags, and `HEAD` cannot be constructed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BranchRef(String);

impl BranchRef {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn name(&self) -> &str {
        &self.0["refs/heads/".len()..]
    }
}

impl TryFrom<String> for BranchRef {
    type Error = RepositoryError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let valid = value.strip_prefix("refs/heads/").is_some_and(|name| {
            !name.is_empty()
                && !name.ends_with('/')
                && !name.ends_with('.')
                && !name.contains("..")
                && !name.contains("@{")
                && name != "@"
                && name.split('/').all(|part| {
                    !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock")
                })
                && name
                    .chars()
                    .all(|c| !c.is_control() && !" ~^:?*[\\".contains(c))
        });
        if valid {
            Ok(Self(value))
        } else {
            Err(RepositoryError::new(
                ErrorKind::InvalidRef,
                "Only local branches can be fast-forwarded.",
            ))
        }
    }
}

impl From<BranchRef> for String {
    fn from(value: BranchRef) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FetchMode {
    /// Refs already on disk. Never contacts a remote.
    Local,
    /// Fetch every remote of the repository first, once per common dir.
    Remote,
}

/// One repository seen through one worktree root. Two worktrees of a repository
/// share `common_dir` and `branches` and differ in `root`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOverview {
    pub root: String,
    pub common_dir: String,
    pub name: String,
    /// Every local branch, sorted by ref name.
    pub branches: Vec<BranchStatus>,
    /// Present only when this call fetched or joined a fetch.
    pub fetch: Option<FetchSummary>,
    pub observed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub reference: BranchRef,
    pub name: String,
    pub oid: Oid,
    pub role: BranchRole,
    pub checked_out_at: Option<String>,
    pub state: BranchState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchRole {
    /// The local branch tracking the remote HEAD, else `main` or `master`.
    Default,
    /// Another long-lived branch name, such as `develop` or `trunk`.
    Mainline,
    Other,
}

/// How a branch relates to its upstream. `Behind` has no `ahead` count because
/// zero commits ahead is what makes it a fast-forward.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BranchState {
    Untracked,
    Gone {
        upstream: String,
    },
    UpToDate {
        upstream: String,
    },
    Ahead {
        upstream: String,
        ahead: u32,
    },
    Diverged {
        upstream: String,
        ahead: u32,
        behind: u32,
    },
    Behind {
        upstream: String,
        target: Oid,
        behind: u32,
        /// `None` means L1 Git can fast-forward the branch now.
        blocker: Option<Blocker>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Blocker {
    /// Tracked files in the worktree have uncommitted changes.
    Dirty { worktree: String },
    /// The worktree has another branch checked out or an unfinished merge, rebase,
    /// am, cherry-pick, revert, or bisect.
    InUse { worktree: String },
    /// Git could not tell whether a worktree has the branch checked out.
    Unverified { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchSummary {
    pub at: u64,
    /// Whether any local or remote-tracking branch moved.
    pub changed: bool,
    /// This call waited for a fetch that finished after it started instead of
    /// fetching again.
    pub coalesced: bool,
    pub remotes: Vec<RemoteFetch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteFetch {
    pub remote: String,
    pub outcome: FetchOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FetchOutcome {
    Fetched,
    /// `remote.<name>.skipFetchAll` or `remote.<name>.skipDefaultUpdate` is set.
    Skipped,
    Failed {
        failure: FetchFailure,
        /// Git's own words with credentials removed from URLs.
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FetchFailure {
    Auth,
    Network,
    TimedOut,
    Busy,
    Other,
}

/// Move `reference` from `from` to `to`, exactly the pair shown in a `Behind` row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Advance {
    pub reference: BranchRef,
    pub from: Oid,
    pub to: Oid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastForwardReport {
    /// In request order.
    pub outcomes: Vec<AdvanceOutcome>,
    /// Read after the last move, before another fetch or move can start.
    pub overview: RepositoryOverview,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AdvanceOutcome {
    /// The branch is at `to`, including when it already was.
    Advanced {
        reference: BranchRef,
        from: Oid,
        to: Oid,
    },
    Skipped {
        reference: BranchRef,
        reason: SkipReason,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkipReason {
    /// The branch or its upstream no longer matches the request.
    Changed,
    NotBehind,
    Dirty {
        worktree: String,
    },
    InUse {
        worktree: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    MissingPath,
    NotRepository,
    BareRepository,
    GitMissing,
    GitFailed,
    InvalidRef,
    InvalidOid,
    UnchangedPath,
    UnsupportedPath,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryError {
    pub kind: ErrorKind,
    pub message: String,
}

impl RepositoryError {
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RepositoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RepositoryError {}
