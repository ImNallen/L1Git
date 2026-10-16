use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Head {
    Attached { reference: String, oid: String },
    Unborn { reference: String },
    Detached { oid: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub root: String,
    pub name: String,
    pub head: Head,
    pub branches: Vec<Branch>,
    pub remotes: Vec<Remote>,
    pub commits: Vec<Commit>,
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
