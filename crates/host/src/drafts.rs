//! Words typed for a pull request and not sent yet. They are the user's work,
//! so they live in `drafts.json` beside `host.json`, and never need GitHub to
//! be reachable. Preferences go in the webview's `localStorage`; work goes
//! here.

use std::io::Write;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::{fs, io, process};

use serde::{Deserialize, Serialize};

use crate::Host;
use crate::github::{ApiBase, Login};
use crate::pulls::Repository;
use crate::state::unix_millis;
use crate::wire::{ErrorKind, Failure};

const VERSION: u64 = 1;
/// Pull requests with drafts, across every account and GitHub.
const MOST_PULLS: usize = 100;
const MOST_DRAFTS: usize = 100;
/// GitHub's limit on a comment's body.
pub(crate) const MOST_CHARS: usize = 65_536;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Change {
    Read {},
    /// Adds a draft where there is none when `at` is null, else replaces the
    /// one saved at `at`. Any other `at` was read before another window wrote.
    Put {
        anchor: Anchor,
        head: Oid,
        text: Text,
        at: Option<u64>,
    },
    /// Deleting a draft that is gone is done; deleting one changed since
    /// `at` is stale.
    Delete {
        anchor: Anchor,
        head: Oid,
        at: u64,
    },
}

/// Every answer carries what this pull request holds now, so a window that
/// was refused shows the other window's words.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullDrafts {
    drafts: Vec<Draft>,
    refused: Option<Refused>,
    /// Where an unreadable `drafts.json` went, on the one answer that moved
    /// it.
    set_aside: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Refused {
    Stale,
    /// Nothing is dropped to make room, so the user chooses what to send or
    /// delete, and `of` names where.
    Full {
        of: Limit,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Limit {
    /// This pull request's drafts.
    Drafts,
    /// The pull requests that have drafts.
    PullRequests,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    anchor: Anchor,
    /// The pull request's head when this text was last written.
    head: Oid,
    text: Text,
    /// Unix milliseconds.
    written_at: u64,
    /// Grows with every save of this draft, so it is also what `at` names.
    saved_at: u64,
}

impl Draft {
    /// A line number means something at one commit only, so a line draft's
    /// place includes its head. Every other draft follows the head along.
    fn is_at(&self, anchor: &Anchor, head: &Oid) -> bool {
        self.anchor == *anchor && (!matches!(anchor, Anchor::Line(_)) || self.head == *head)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Anchor {
    Line(Lines),
    Reply {
        thread: NodeId,
    },
    Conversation {},
    Summary {},
    /// The merge commit's message: its first line is the headline.
    Merge {},
}

/// GitHub's terms: `side` and `line` are the range's last line, and `start`
/// its first when the range spans more than one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawLines")]
pub struct Lines {
    pub(crate) path: FilePath,
    pub(crate) side: Side,
    pub(crate) line: NonZeroU32,
    pub(crate) start: Option<LinePoint>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLines {
    path: FilePath,
    side: Side,
    line: NonZeroU32,
    start: Option<LinePoint>,
}

impl TryFrom<RawLines> for Lines {
    type Error = &'static str;

    fn try_from(raw: RawLines) -> Result<Lines, Self::Error> {
        if raw
            .start
            .is_some_and(|start| start.side == raw.side && start.line >= raw.line)
        {
            return Err("A range starts on a line above where it ends.");
        }
        Ok(Lines {
            path: raw.path,
            side: raw.side,
            line: raw.line,
            start: raw.start,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinePoint {
    pub(crate) side: Side,
    pub(crate) line: NonZeroU32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Left,
    Right,
}

macro_rules! checked_string {
    ($name:ident, $check:expr, $problem:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl TryFrom<String> for $name {
            type Error = &'static str;

            fn try_from(value: String) -> Result<$name, Self::Error> {
                let check: fn(&str) -> bool = $check;
                if check(&value) {
                    Ok($name(value))
                } else {
                    Err($problem)
                }
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }

        impl $name {
            #[allow(dead_code, reason = "not every checked string is read back")]
            pub(crate) fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

checked_string!(
    Oid,
    |value| matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
    "An object id is 40 or 64 lowercase hex digits."
);
checked_string!(
    NodeId,
    |value| (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_=".contains(&b)),
    "A GitHub node id is letters, digits, -, _ and =."
);
checked_string!(
    FilePath,
    |value| (1..=4096).contains(&value.len()) && !value.contains('\0'),
    "A path is 1 to 4096 bytes without a NUL."
);
checked_string!(
    Text,
    |value| !value.trim().is_empty() && value.chars().count() <= MOST_CHARS,
    "A draft holds 1 to 65,536 characters that are not all spaces."
);

/// One pull request's drafts under one account on one GitHub.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Book {
    api: ApiBase,
    login: Login,
    repository: Repository,
    number: u32,
    drafts: Vec<Draft>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u64,
    pulls: Vec<Book>,
}

/// Read alone first, so a newer build's shape is never parsed as this one's.
#[derive(Deserialize)]
struct Version {
    version: u64,
}

struct Loaded {
    pulls: Vec<Book>,
    set_aside: Option<String>,
}

/// An unreadable file, such as one a power loss emptied, would refuse every
/// save after it. It moves aside instead, kept for whoever wants to look,
/// and the drafts start again.
fn load(dir: &Path, path: &Path) -> Result<Loaded, Failure> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Loaded {
                pulls: Vec::new(),
                set_aside: None,
            });
        }
        Err(_) => return Err(unreadable()),
    };
    match serde_json::from_slice::<Version>(&bytes) {
        Ok(Version { version }) if version > VERSION => {
            return Err(Failure::new(
                ErrorKind::Storage,
                "A newer version of L1 Git saved the drafts on this computer. L1 Git left them as they are; update it to see them.",
            ));
        }
        Ok(Version { version: VERSION }) => {
            if let Ok(file) = serde_json::from_slice::<File>(&bytes) {
                return Ok(Loaded {
                    pulls: file.pulls,
                    set_aside: None,
                });
            }
        }
        _ => {}
    }
    let aside = dir.join(format!("drafts.corrupt-{}.json", unix_millis()));
    fs::rename(path, &aside).map_err(|_| unreadable())?;
    Ok(Loaded {
        pulls: Vec::new(),
        set_aside: Some(aside.display().to_string()),
    })
}

fn unreadable() -> Failure {
    Failure::new(
        ErrorKind::Storage,
        "L1 Git can't read the drafts saved on this computer, so it left them as they are and saved nothing.",
    )
}

fn unwritable() -> Failure {
    Failure::new(
        ErrorKind::Storage,
        "L1 Git could not save this draft. Check that its configuration folder is writable.",
    )
}

/// Held from the read to the save, so another L1 Git on this folder never
/// saves over a change it didn't read. The system lets go of it when the
/// process ends, however it ends.
fn lock(dir: &Path) -> Result<fs::File, Failure> {
    let open = || -> io::Result<fs::File> {
        fs::create_dir_all(dir)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("drafts.lock"))?;
        file.lock()?;
        Ok(file)
    };
    open().map_err(|_| unwritable())
}

/// Every save writes a file of its own, so no other save can rename it away.
static SAVES: AtomicU64 = AtomicU64::new(0);

/// Fails only when `drafts.json` still holds what it held before.
fn save(dir: &Path, path: &Path, pulls: Vec<Book>) -> Result<(), Failure> {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("drafts.") && name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
    let temporary = dir.join(format!(
        "drafts.{}.{}.tmp",
        process::id(),
        SAVES.fetch_add(1, Ordering::Relaxed)
    ));
    let write = || -> io::Result<()> {
        let bytes = serde_json::to_vec(&File {
            version: VERSION,
            pulls,
        })?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    };
    if write().is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(unwritable());
    }
    // The rename saved it. Syncing the folder keeps the rename through a
    // power loss, and failing to doesn't undo it.
    #[cfg(unix)]
    let _ = fs::File::open(dir).and_then(|folder| folder.sync_all());
    Ok(())
}

/// `None` when the change is done, and `drafts` is then what to save.
fn apply(drafts: &mut Vec<Draft>, change: Change, now: u64) -> Option<Refused> {
    match change {
        Change::Read {} => None,
        Change::Put {
            anchor,
            head,
            text,
            at,
        } => {
            let found = drafts.iter().position(|draft| draft.is_at(&anchor, &head));
            match (found, at) {
                (None, None) if drafts.len() >= MOST_DRAFTS => {
                    Some(Refused::Full { of: Limit::Drafts })
                }
                (None, None) => {
                    drafts.push(Draft {
                        anchor,
                        head,
                        text,
                        written_at: now,
                        saved_at: now,
                    });
                    None
                }
                (Some(index), Some(at)) if drafts[index].saved_at == at => {
                    let draft = &mut drafts[index];
                    draft.saved_at = now.max(at + 1);
                    draft.head = head;
                    draft.text = text;
                    None
                }
                _ => Some(Refused::Stale),
            }
        }
        Change::Delete { anchor, head, at } => {
            match drafts.iter().position(|draft| draft.is_at(&anchor, &head)) {
                None => None,
                Some(index) if drafts[index].saved_at == at => {
                    drafts.remove(index);
                    None
                }
                Some(_) => Some(Refused::Stale),
            }
        }
    }
}

impl Host {
    pub(crate) fn drafts(
        &self,
        login: Login,
        repository: Repository,
        number: u32,
        change: Change,
    ) -> Result<PullDrafts, Failure> {
        let dir = self.file.parent().unwrap_or(Path::new("."));
        let _only = lock(dir)?;
        let path = dir.join("drafts.json");
        let Loaded {
            mut pulls,
            set_aside,
        } = load(dir, &path)?;
        let api = self.endpoints.api();
        let is_read = matches!(change, Change::Read {});
        let found = pulls.iter().position(|book| {
            &book.api == api
                && book.login == login
                && book.repository == repository
                && book.number == number
        });
        let mut book = match found {
            Some(index) => pulls.remove(index),
            None => Book {
                api: api.clone(),
                login,
                repository,
                number,
                drafts: Vec::new(),
            },
        };
        let mut refused = apply(&mut book.drafts, change, unix_millis());
        if refused.is_none()
            && found.is_none()
            && !book.drafts.is_empty()
            && pulls.len() >= MOST_PULLS
        {
            book.drafts.clear();
            refused = Some(Refused::Full {
                of: Limit::PullRequests,
            });
        }
        let drafts = book.drafts.clone();
        if refused.is_none() && !is_read {
            if !book.drafts.is_empty() {
                pulls.push(book);
            }
            save(dir, &path, pulls)?;
        }
        Ok(PullDrafts {
            drafts,
            refused,
            set_aside,
        })
    }
}
