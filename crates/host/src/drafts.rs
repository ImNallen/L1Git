//! Words typed for a pull request and not sent yet. They are the user's work,
//! so they live in `drafts.json` beside `host.json`, and never need GitHub to
//! be reachable. Preferences go in the webview's `localStorage`; work goes
//! here.

mod file;
mod sent;
mod waiting;

use std::num::NonZeroU32;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Host;
use crate::github::{ApiBase, Login};
use crate::pulls::Repository;
use crate::state::unix_millis;
use crate::wire::Failure;
use file::Shelf;
pub(crate) use file::{Gate, Lane};
pub(crate) use sent::{Carried, Sent, SentView};
pub(crate) use waiting::Waiting;

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
    /// Keep as draft: a write that may have posted gives its drafts back,
    /// marked so, and holds the pull request no longer. Keeping one that is
    /// gone is done.
    Keep {
        attempt: AttemptId,
    },
    /// Drops the words that waited at this place, as picking the other
    /// window's words does. Forgetting none is done.
    Forget {
        anchor: Anchor,
        head: Oid,
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
    /// Writes that left, or may have, with the drafts each carried.
    sent: Vec<SentView>,
    /// Words typed where a write held the place, until the write ends, or,
    /// when they were typed on another draft than it carried, until a save
    /// or `forget` at their place.
    waiting: Vec<Waiting>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Refused {
    Stale,
    /// A write that left, or may have, holds this place, until it is known
    /// or the user keeps it as a draft. The words wait in `waiting`.
    Sent,
    /// Its write is still sending, so it can't be kept as a draft yet.
    Sending,
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
    /// A write carried these words, GitHub's answer was lost, and the user
    /// kept them as a draft. Sending them again may post them twice.
    #[serde(default)]
    may_have_posted: bool,
}

impl Draft {
    fn is_at(&self, anchor: &Anchor, head: &Oid) -> bool {
        same_place(&self.anchor, &self.head, anchor, head)
    }
}

/// A line number means something at one commit only, so a line draft's
/// place includes its head. Every other draft follows the head along.
fn same_place(anchor: &Anchor, head: &Oid, other: &Anchor, other_head: &Oid) -> bool {
    anchor == other && (!matches!(anchor, Anchor::Line(_)) || head == other_head)
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
    AttemptId,
    |value| (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)),
    "An attempt id is 1 to 64 letters, digits, - and _."
);
checked_string!(
    Text,
    |value| !value.trim().is_empty() && value.chars().count() <= MOST_CHARS,
    "A draft holds 1 to 65,536 characters that are not all spaces."
);

/// One pull request's drafts under one account on one GitHub.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Book {
    api: ApiBase,
    login: Login,
    repository: Repository,
    number: u32,
    drafts: Vec<Draft>,
    #[serde(default)]
    sent: Vec<Sent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    waiting: Vec<Waiting>,
}

/// One pull request, as one account names it on this computer's GitHub.
pub(crate) struct BookKey {
    pub(crate) login: Login,
    pub(crate) repository: Repository,
    pub(crate) number: u32,
}

impl Book {
    fn view(&self, set_aside: Option<String>, sending: bool) -> PullDrafts {
        PullDrafts {
            drafts: self.drafts.clone(),
            refused: None,
            set_aside,
            sent: self.sent.iter().map(|sent| sent.view(sending)).collect(),
            waiting: self.waiting.clone(),
        }
    }
}

/// `None` when the change is done, and `book` is then what to save. `room`
/// says whether a book that was not there before may be kept.
fn apply(book: &mut Book, change: Change, now: u64, room: bool, gate: &Gate) -> Option<Refused> {
    let place = match &change {
        Change::Put { anchor, head, .. } | Change::Delete { anchor, head, .. } => {
            Some((anchor.clone(), head.clone()))
        }
        _ => None,
    };
    let refused = apply_change(book, change, now, room, gate);
    if let (None, Some((anchor, head))) = (refused, place) {
        book.unwait(&anchor, &head);
    }
    refused
}

fn apply_change(
    book: &mut Book,
    change: Change,
    now: u64,
    room: bool,
    gate: &Gate,
) -> Option<Refused> {
    match change {
        Change::Read {} => None,
        Change::Put {
            anchor,
            head,
            text,
            at,
        } if book.holds(&anchor, &head) => {
            book.wait(anchor, head, text, at);
            Some(Refused::Sent)
        }
        Change::Put {
            anchor,
            head,
            text,
            at,
        } => {
            let drafts = &mut book.drafts;
            let found = drafts.iter().position(|draft| draft.is_at(&anchor, &head));
            match (found, at) {
                (None, None) if drafts.len() >= MOST_DRAFTS => {
                    Some(Refused::Full { of: Limit::Drafts })
                }
                (None, None) if !room => Some(Refused::Full {
                    of: Limit::PullRequests,
                }),
                (None, None) => {
                    drafts.push(Draft {
                        anchor,
                        head,
                        text,
                        written_at: now,
                        saved_at: now,
                        may_have_posted: false,
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
            let drafts = &mut book.drafts;
            match drafts.iter().position(|draft| draft.is_at(&anchor, &head)) {
                None => None,
                Some(index) if drafts[index].saved_at == at => {
                    drafts.remove(index);
                    None
                }
                Some(_) => Some(Refused::Stale),
            }
        }
        Change::Keep { .. } if gate.held() => Some(Refused::Sending),
        Change::Keep { attempt } => {
            book.give_back(&attempt, true);
            None
        }
        Change::Forget { anchor, head } => {
            book.unwait(&anchor, &head);
            None
        }
    }
}

impl Host {
    /// One pull request's book under the drafts lock, saved when `change`
    /// says to. `change` also learns whether a book that was not there before
    /// may be kept.
    pub(crate) fn shelved<R>(
        &self,
        key: &BookKey,
        change: impl FnOnce(&mut Book, bool) -> (R, bool),
    ) -> Result<(R, PullDrafts), Failure> {
        self.gated(key, |book, room, _| change(book, room))
    }

    /// `shelved`, with the way to the pull request's lane. A lane freed here
    /// is free to others only once the book is saved, since they look under
    /// the same lock.
    pub(crate) fn gated<R>(
        &self,
        key: &BookKey,
        change: impl FnOnce(&mut Book, bool, &Gate) -> (R, bool),
    ) -> Result<(R, PullDrafts), Failure> {
        let mut shelf = Shelf::open(self.file.parent().unwrap_or(Path::new(".")))?;
        let (mut book, room) = shelf.take(self.endpoints.api(), key);
        let gate = shelf.gate(&self.lane_name(key));
        let (answer, save) = change(&mut book, room, &gate);
        let sending = !book.sent.is_empty() && gate.held();
        let view = book.view(shelf.set_aside.clone(), sending);
        if save {
            shelf.save(book)?;
        }
        Ok((answer, view))
    }

    pub(crate) fn drafts(&self, key: &BookKey, change: Change) -> Result<PullDrafts, Failure> {
        let is_read = matches!(change, Change::Read {});
        let (refused, view) = self.gated(key, |book, room, gate| {
            let refused = apply(book, change, unix_millis(), room, gate);
            let waits = refused == Some(Refused::Sent);
            (refused, (refused.is_none() || waits) && !is_read)
        })?;
        Ok(PullDrafts { refused, ..view })
    }
}
