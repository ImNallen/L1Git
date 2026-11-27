//! Words typed where a write holds the place, by a window that didn't know
//! yet. They wait in `drafts.json`, so closing that window can't lose them,
//! until the write ends.

use serde::{Deserialize, Serialize};

use super::{Anchor, Book, Draft, Oid, Text, same_place};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Waiting {
    anchor: Anchor,
    head: Oid,
    text: Text,
    /// The `savedAt` of the draft they were typed on, or null for none.
    on: Option<u64>,
}

impl Book {
    /// One place waits once: a later save there replaces what waited.
    pub(super) fn wait(&mut self, anchor: Anchor, head: Oid, text: Text, on: Option<u64>) {
        self.unwait(&anchor, &head);
        self.waiting.push(Waiting {
            anchor,
            head,
            text,
            on,
        });
    }

    pub(super) fn unwait(&mut self, anchor: &Anchor, head: &Oid) {
        self.waiting
            .retain(|waiting| !same_place(&waiting.anchor, &waiting.head, anchor, head));
    }

    /// A write that carried `carried` ended. Words typed on the very draft
    /// it carried save over what it gave back, or as a new draft when GitHub
    /// has it. Words typed on another draft wait on, beside it, for the user
    /// to pick.
    pub(super) fn ended(&mut self, carried: &[Draft], now: u64) {
        for draft in carried {
            let found = self.waiting.iter().position(|waiting| {
                same_place(&waiting.anchor, &waiting.head, &draft.anchor, &draft.head)
                    && waiting.on == Some(draft.saved_at)
            });
            let Some(index) = found else { continue };
            let waiting = self.waiting.remove(index);
            match self
                .drafts
                .iter_mut()
                .find(|kept| kept.is_at(&waiting.anchor, &waiting.head))
            {
                Some(kept) => {
                    kept.saved_at = now.max(kept.saved_at + 1);
                    kept.written_at = now;
                    kept.head = waiting.head;
                    kept.text = waiting.text;
                }
                None => self.drafts.push(Draft {
                    anchor: waiting.anchor,
                    head: waiting.head,
                    text: waiting.text,
                    written_at: now,
                    saved_at: now,
                    may_have_posted: false,
                }),
            }
        }
    }
}
