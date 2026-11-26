//! A write that left, or may have, kept in `drafts.json` with the drafts it
//! carried. It is saved before the write leaves and stays until GitHub's
//! answer or a read says what happened, so no window, restart or sign-in can
//! send those words again by accident.

use serde::{Deserialize, Serialize};

use super::{Anchor, AttemptId, Book, Draft, Oid};
use crate::writes::Write;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Sent {
    pub(crate) attempt: AttemptId,
    /// Unix milliseconds when it last left.
    pub(crate) at: u64,
    pub(crate) write: Write,
    /// The ids already where its result would appear, read just before it
    /// left. Only an id not among them can show that it landed.
    pub(crate) before: Vec<String>,
    drafts: Vec<Draft>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentView {
    attempt: AttemptId,
    at: u64,
    write: Write,
    drafts: Vec<Draft>,
    /// An L1 Git on this folder is sending it now. Otherwise its outcome is
    /// unknown.
    sending: bool,
}

/// A draft a write carries, as saved at `at`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Carried {
    anchor: Anchor,
    head: Oid,
    at: u64,
}

impl Sent {
    pub(super) fn view(&self, sending: bool) -> SentView {
        SentView {
            attempt: self.attempt.clone(),
            at: self.at,
            write: self.write.clone(),
            drafts: self.drafts.clone(),
            sending,
        }
    }
}

impl Book {
    /// Whether a write that left, or may have, holds this draft's place.
    pub(super) fn holds(&self, anchor: &Anchor, head: &Oid) -> bool {
        self.sent
            .iter()
            .any(|sent| sent.drafts.iter().any(|draft| draft.is_at(anchor, head)))
    }

    pub(crate) fn sent(&self) -> &[Sent] {
        &self.sent
    }

    /// Why a write for this pull request can't leave now, if it can't.
    pub(crate) fn held(&self) -> Result<(), &'static str> {
        if self.sent.is_empty() {
            Ok(())
        } else {
            Err(
                "Another write for this pull request is sending, or may have posted, so L1 Git sent nothing.",
            )
        }
    }

    /// Records `write` before it leaves, taking the drafts it carries out of
    /// the drafts. One write at a time holds a pull request.
    pub(crate) fn begin(
        &mut self,
        attempt: AttemptId,
        at: u64,
        write: Write,
        before: Vec<String>,
        carried: &[Carried],
    ) -> Result<(), &'static str> {
        self.held()?;
        let mut drafts = Vec::with_capacity(carried.len());
        for each in carried {
            let found = self.drafts.iter().position(|draft| {
                draft.is_at(&each.anchor, &each.head) && draft.saved_at == each.at
            });
            let Some(index) = found else {
                self.drafts.extend(drafts);
                return Err(
                    "A draft changed or went away since this window read it, so L1 Git sent nothing.",
                );
            };
            drafts.push(self.drafts.remove(index));
        }
        self.sent.push(Sent {
            attempt,
            at,
            write,
            before,
            drafts,
        });
        Ok(())
    }

    /// GitHub has it, so its drafts are done.
    pub(crate) fn landed(&mut self, attempt: &AttemptId) -> bool {
        let before = self.sent.len();
        self.sent.retain(|sent| sent.attempt != *attempt);
        self.sent.len() != before
    }

    /// Its drafts return to typing. `may_have_posted` marks words GitHub may
    /// have, so a later send of them warns.
    pub(crate) fn give_back(&mut self, attempt: &AttemptId, may_have_posted: bool) -> bool {
        let Some(index) = self.sent.iter().position(|sent| sent.attempt == *attempt) else {
            return false;
        };
        let sent = self.sent.remove(index);
        self.drafts
            .extend(sent.drafts.into_iter().map(|draft| Draft {
                may_have_posted: draft.may_have_posted || may_have_posted,
                ..draft
            }));
        true
    }

    /// Send anyway: the same write leaves again, from a new reading of what
    /// is there.
    pub(crate) fn resend(&mut self, attempt: &AttemptId, before: Vec<String>, at: u64) -> bool {
        match self.sent.iter_mut().find(|sent| sent.attempt == *attempt) {
            Some(sent) => {
                sent.before = before;
                sent.at = at;
                true
            }
            None => false,
        }
    }
}
