//! One write at a time per pull request. A write takes its pull request's
//! lane in this process first, reads what is already where its result would
//! appear, is recorded in `drafts.json` with the drafts it carries, and only
//! then leaves. Its record goes once GitHub's answer, or a later read, says
//! what happened.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use super::{Checked, Seen, Settled, Write, Written, Wrote, not_sent};
use crate::Host;
use crate::drafts::{AttemptId, BookKey, Carried};
use crate::github::{ApiError, Login};
use crate::state::{CommitId, unix_millis};
use crate::wire::{ErrorKind, Failure};

const BUSY: &str = "Another write for this pull request is still sending, so L1 Git sent nothing.";

/// The pull requests this process is sending a write for, and which write
/// once it has left. Every window of this process shares them.
#[derive(Default)]
pub(crate) struct Lanes(Mutex<HashMap<String, Option<AttemptId>>>);

struct Lane<'a> {
    lanes: &'a Lanes,
    key: String,
}

impl Lanes {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Option<AttemptId>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn take(&self, key: String) -> Option<Lane<'_>> {
        let mut held = self.lock();
        if held.contains_key(&key) {
            return None;
        }
        held.insert(key.clone(), None);
        Some(Lane { lanes: self, key })
    }
}

impl Lane<'_> {
    fn sends(&self, attempt: Option<&AttemptId>) {
        self.lanes.lock().insert(self.key.clone(), attempt.cloned());
    }
}

impl Drop for Lane<'_> {
    fn drop(&mut self) {
        self.lanes.lock().remove(&self.key);
    }
}

impl Host {
    fn lane_key(&self, key: &BookKey) -> String {
        format!(
            "{} {} {}#{}",
            self.endpoints.api().as_str(),
            key.login,
            key.repository,
            key.number
        )
        .to_lowercase()
    }

    /// The write this process is sending for `key`'s pull request.
    pub(crate) fn sending(&self, key: &BookKey) -> Option<AttemptId> {
        self.lanes
            .lock()
            .get(&self.lane_key(key))
            .cloned()
            .flatten()
    }

    /// Sent only as `as_login`, so a click made for one account never posts
    /// as another.
    fn signed_in_as(&self, as_login: &Login) -> Result<CommitId, String> {
        let Some((generation, login)) = self.connection() else {
            return Err(
                "L1 Git is not connected to GitHub, so it sent nothing. Sign in from Settings › Hosts."
                    .to_owned(),
            );
        };
        if login != *as_login {
            return Err(format!(
                "L1 Git is signed in to GitHub as {login}, not {as_login}, so it sent nothing."
            ));
        }
        Ok(generation)
    }

    pub(crate) fn write(
        &self,
        key: &BookKey,
        attempt: AttemptId,
        write: Write,
        carried: &[Carried],
    ) -> Wrote {
        if let Err(problem) = write.check() {
            return Wrote::alone(not_sent(format!("L1 Git sent nothing. {problem}")));
        }
        let generation = match self.signed_in_as(&key.login) {
            Ok(generation) => generation,
            Err(message) => return Wrote::alone(not_sent(message)),
        };
        let Some(lane) = self.lanes.take(self.lane_key(key)) else {
            return Wrote::alone(not_sent(BUSY));
        };
        match self.shelved(key, |book, _| (book.held(), false)) {
            Ok((Ok(()), _)) => {}
            Ok((Err(problem), drafts)) => {
                return Wrote {
                    written: not_sent(problem),
                    drafts: Some(drafts),
                };
            }
            Err(failure) => return Wrote::alone(unrecorded(failure)),
        }
        self.as_connection(generation, |github| {
            let before = match github.before(&write, &key.login) {
                Ok(before) => before,
                Err(error) => return Wrote::alone(github.unread(error)),
            };
            let begun = self.shelved(key, |book, _| {
                let begun = book.begin(
                    attempt.clone(),
                    unix_millis(),
                    write.clone(),
                    before,
                    carried,
                );
                let save = begun.is_ok();
                (begun, save)
            });
            match begun {
                Ok((Ok(()), _)) => {}
                Ok((Err(problem), drafts)) => {
                    return Wrote {
                        written: not_sent(problem),
                        drafts: Some(drafts),
                    };
                }
                Err(failure) => return Wrote::alone(unrecorded(failure)),
            }
            lane.sends(Some(&attempt));
            let written = github.write(&write);
            lane.sends(None);
            self.finish(key, &attempt, written)
        })
        .unwrap_or_else(|failure| Wrote::alone(not_sent(failure.message)))
    }

    /// Send anyway: the user knows it may post twice. A read first may still
    /// show that it landed, and then nothing leaves.
    pub(crate) fn send_again(&self, key: &BookKey, attempt: &AttemptId) -> Wrote {
        let generation = match self.signed_in_as(&key.login) {
            Ok(generation) => generation,
            Err(message) => return Wrote::alone(not_sent(message)),
        };
        let Some(lane) = self.lanes.take(self.lane_key(key)) else {
            return Wrote::alone(not_sent(BUSY));
        };
        let gone = "This write isn't waiting anymore, so L1 Git sent nothing.";
        self.as_connection(generation, |github| {
            let found = self.shelved(key, |book, _| {
                let found = book.sent().iter().find(|sent| sent.attempt == *attempt);
                (found.cloned(), false)
            });
            let sent = match found {
                Ok((Some(sent), _)) => sent,
                Ok((None, drafts)) => {
                    return Wrote {
                        written: not_sent(gone),
                        drafts: Some(drafts),
                    };
                }
                Err(failure) => return Wrote::alone(not_sent(failure.message)),
            };
            match github.seen(&sent.write, &sent.before, &key.login) {
                Ok(Some(Seen::Landed { echo })) => {
                    return self.finish(key, attempt, Written::Done { echo });
                }
                Ok(_) => {}
                Err(error) => return Wrote::alone(github.unread(error)),
            }
            let before = match github.before(&sent.write, &key.login) {
                Ok(before) => before,
                Err(error) => return Wrote::alone(github.unread(error)),
            };
            match self.shelved(key, |book, _| {
                let found = book.resend(attempt, before, unix_millis());
                (found, found)
            }) {
                Ok((true, _)) => {}
                Ok((false, drafts)) => {
                    return Wrote {
                        written: not_sent(gone),
                        drafts: Some(drafts),
                    };
                }
                Err(failure) => return Wrote::alone(unrecorded(failure)),
            }
            lane.sends(Some(attempt));
            let written = github.write(&sent.write);
            lane.sends(None);
            self.finish(key, attempt, written)
        })
        .unwrap_or_else(|failure| Wrote::alone(not_sent(failure.message)))
    }

    /// Done drops the drafts the write carried, an answer that GitHub didn't
    /// do it gives them back, and unknown keeps the record for a read to
    /// settle. A record that can't be updated stays, and a read settles it.
    fn finish(&self, key: &BookKey, attempt: &AttemptId, written: Written) -> Wrote {
        let finished = self.shelved(key, |book, _| {
            let changed = match &written {
                Written::Done { .. } => book.landed(attempt),
                Written::NotSent { .. } | Written::Refused { .. } => book.give_back(attempt, false),
                Written::Unknown { .. } => false,
            };
            ((), changed)
        });
        Wrote {
            written,
            drafts: finished.ok().map(|((), drafts)| drafts),
        }
    }

    /// Reads what GitHub shows of each write of this pull request whose
    /// outcome is unknown, and settles the ones the read tells about.
    pub(crate) fn check(&self, key: &BookKey) -> Result<Checked, Failure> {
        let generation = self
            .signed_in_as(&key.login)
            .map_err(|message| Failure::new(ErrorKind::NotConnected, message))?;
        let sending = self.sending(key);
        let (waiting, mut drafts) = self.shelved(key, |book, _| {
            let waiting: Vec<_> = book
                .sent()
                .iter()
                .filter(|sent| Some(&sent.attempt) != sending.as_ref())
                .cloned()
                .collect();
            (waiting, false)
        })?;
        if waiting.is_empty() {
            return Ok(Checked {
                settled: Vec::new(),
                drafts,
            });
        }
        let seen = self.as_connection(generation, |github| {
            let mut seen = Vec::new();
            for sent in waiting {
                match github.seen(&sent.write, &sent.before, &key.login) {
                    Ok(Some(shown)) => seen.push((sent, shown)),
                    Ok(None) => {}
                    Err(ApiError::Unauthorized) => {
                        github.signed_out();
                        break;
                    }
                    Err(_) => {}
                }
            }
            seen
        })?;
        let mut settled = Vec::new();
        if !seen.is_empty() {
            let sending = self.sending(key);
            (settled, drafts) = self.shelved(key, |book, _| {
                let mut settled = Vec::new();
                for (sent, seen) in seen {
                    let unchanged = book
                        .sent()
                        .iter()
                        .any(|now| now.attempt == sent.attempt && now.at == sent.at);
                    if !unchanged || sending.as_ref() == Some(&sent.attempt) {
                        continue;
                    }
                    match seen {
                        Seen::Landed { .. } => book.landed(&sent.attempt),
                        Seen::NotLanded { .. } => book.give_back(&sent.attempt, false),
                    };
                    settled.push(Settled {
                        attempt: sent.attempt,
                        write: sent.write,
                        seen,
                    });
                }
                let changed = !settled.is_empty();
                (settled, changed)
            })?;
        }
        Ok(Checked { settled, drafts })
    }
}

fn unrecorded(failure: Failure) -> Written {
    not_sent(format!(
        "L1 Git could not keep a record of this write on this computer, so it sent nothing. {}",
        failure.message
    ))
}
