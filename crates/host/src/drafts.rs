//! Words typed for a pull request and not sent yet. They are the user's work,
//! so they live in `drafts.json` beside `host.json` and are written the same
//! way, and never need GitHub to be reachable. Preferences go in the webview's
//! `localStorage`; work goes here.

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::PoisonError;
use std::{fs, io};

use serde::{Deserialize, Serialize};

use crate::Host;
use crate::github::{ApiBase, Login};
use crate::pulls::Repository;
use crate::state::unix_millis;
use crate::wire::{ErrorKind, Failure};

const VERSION: u64 = 1;
/// The pull request written to longest ago goes first.
const MOST_PULLS: usize = 100;
const MOST_DRAFTS: usize = 100;
/// GitHub's limit on a comment's body.
const MOST_CHARS: usize = 65_536;

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
pub struct PullDrafts {
    drafts: Vec<Draft>,
    refused: Option<Refused>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refused {
    Stale,
    Full,
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
    path: FilePath,
    side: Side,
    line: NonZeroU32,
    start: Option<LinePoint>,
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
    side: Side,
    line: NonZeroU32,
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

fn load(path: &Path) -> Result<Vec<Book>, Failure> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(unreadable()),
    };
    match serde_json::from_slice::<Version>(&bytes) {
        Ok(Version { version }) if version > VERSION => Err(Failure::new(
            ErrorKind::Storage,
            "A newer version of L1 Git saved the drafts on this computer. L1 Git left them as they are; update it to see them.",
        )),
        Ok(Version { version: VERSION }) => serde_json::from_slice::<File>(&bytes)
            .map(|file| file.pulls)
            .map_err(|_| unreadable()),
        _ => Err(unreadable()),
    }
}

fn unreadable() -> Failure {
    Failure::new(
        ErrorKind::Storage,
        "L1 Git can't read the drafts saved on this computer, so it left them as they are and saved nothing.",
    )
}

fn save(path: &Path, pulls: Vec<Book>) -> Result<(), Failure> {
    let write = || -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let temporary = path.with_extension("tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(&File {
                version: VERSION,
                pulls,
            })?,
        )?;
        fs::rename(temporary, path)
    };
    write().map_err(|_| {
        Failure::new(
            ErrorKind::Storage,
            "L1 Git could not save this draft. Check that its configuration folder is writable.",
        )
    })
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
                (None, None) if drafts.len() >= MOST_DRAFTS => Some(Refused::Full),
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
        let _only = self.drafting.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.file.with_file_name("drafts.json");
        let mut pulls = load(&path)?;
        let api = self.endpoints.api();
        let is_read = matches!(change, Change::Read {});
        let mut book = match pulls.iter().position(|book| {
            &book.api == api
                && book.login == login
                && book.repository == repository
                && book.number == number
        }) {
            Some(index) => pulls.remove(index),
            None => Book {
                api: api.clone(),
                login,
                repository,
                number,
                drafts: Vec::new(),
            },
        };
        let refused = apply(&mut book.drafts, change, unix_millis());
        let drafts = book.drafts.clone();
        if refused.is_none() && !is_read {
            if !book.drafts.is_empty() {
                pulls.push(book);
            }
            let extra = pulls.len().saturating_sub(MOST_PULLS);
            pulls.drain(..extra);
            save(&path, pulls)?;
        }
        Ok(PullDrafts { drafts, refused })
    }
}
