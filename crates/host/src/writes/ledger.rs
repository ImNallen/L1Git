//! One write at a time per pull request. A write takes its pull request's
//! lane first, an OS lock in the configuration folder that every L1 Git on
//! it shares, reads what is already where its result would appear, is
//! recorded in `drafts.json` with the drafts it carries, and only then
//! leaves. Its record goes once GitHub's answer, or a later read, says what
//! happened, and the lane goes with that update.

use super::{Checked, Seen, Settled, Write, Written, Wrote, not_sent, refused};
use crate::Host;
use crate::drafts::{AttemptId, BookKey, Carried, Lane};
use crate::github::{ApiError, Login};
use crate::state::{CommitId, unix_millis};
use crate::wire::{ErrorKind, Failure};

const BUSY: &str = "Another write for this pull request is still sending, so L1 Git sent nothing.";
const ELSEWHERE: &str = "Another L1 Git window is sending this. L1 Git sent nothing.";
const FIRST: &str = "The first send may still have posted.";

/// Which send of a write an answer is for. Only the first send's refusal
/// shows that GitHub never had it.
#[derive(Clone, Copy, PartialEq)]
enum Sending {
    First,
    Again,
}

impl Host {
    pub(crate) fn lane_name(&self, key: &BookKey) -> String {
        format!(
            "{} {} {}#{}",
            self.endpoints.api().as_str(),
            key.login,
            key.repository,
            key.number
        )
        .to_lowercase()
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
        let taken = self.gated(key, |book, _, gate| {
            let lane = match gate.take() {
                Ok(Some(lane)) => match book.held() {
                    Ok(()) => Ok(lane),
                    Err(problem) => {
                        gate.free(lane);
                        Err(not_sent(problem))
                    }
                },
                Ok(None) => Err(not_sent(BUSY)),
                Err(failure) => Err(unrecorded(failure)),
            };
            (lane, false)
        });
        let lane = match taken {
            Ok((Ok(lane), _)) => lane,
            Ok((Err(written), drafts)) => {
                return Wrote {
                    written,
                    drafts: Some(drafts),
                };
            }
            Err(failure) => return Wrote::alone(unrecorded(failure)),
        };
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
            let written = github.write(&write);
            self.finish(key, &attempt, written, lane, Sending::First)
        })
        .unwrap_or_else(|failure| Wrote::alone(not_sent(failure.message)))
    }

    /// Send anyway: the user knows it may post twice. A read first may still
    /// show that it landed, and then nothing leaves. Whatever stops or
    /// refuses this send says nothing of the first, which stays unknown.
    pub(crate) fn send_again(&self, key: &BookKey, attempt: &AttemptId) -> Wrote {
        let generation = match self.signed_in_as(&key.login) {
            Ok(generation) => generation,
            Err(message) => return Wrote::alone(not_sent(message)),
        };
        let gone = "This write isn't waiting anymore, so L1 Git sent nothing.";
        let taken = self.gated(key, |book, _, gate| {
            let found = book.sent().iter().find(|sent| sent.attempt == *attempt);
            let taken = match found {
                None => Err(not_sent(gone)),
                Some(sent) => match gate.take() {
                    Ok(Some(lane)) => Ok((lane, sent.clone())),
                    Ok(None) => Err(not_sent(ELSEWHERE)),
                    Err(failure) => Err(unrecorded(failure)),
                },
            };
            (taken, false)
        });
        let (lane, sent) = match taken {
            Ok((Ok(taken), _)) => taken,
            Ok((Err(written), drafts)) => {
                return Wrote {
                    written,
                    drafts: Some(drafts),
                };
            }
            Err(failure) => return Wrote::alone(not_sent(failure.message)),
        };
        let wrote = self
            .as_connection(generation, |github| {
                match github.seen(&sent.write, &sent.before, &key.login) {
                    Ok(Some(Seen::Landed { echo })) => {
                        return self.finish(
                            key,
                            attempt,
                            Written::Done { echo },
                            lane,
                            Sending::Again,
                        );
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
                let written = github.write(&sent.write);
                self.finish(key, attempt, written, lane, Sending::Again)
            })
            .unwrap_or_else(|failure| Wrote::alone(not_sent(failure.message)));
        let written = match wrote.written {
            Written::NotSent { message } => not_sent(format!("{message} {FIRST}")),
            Written::Refused { message } => refused(format!(
                "{message} That answer is for sending it again. {FIRST}"
            )),
            written => written,
        };
        Wrote { written, ..wrote }
    }

    /// Done drops the drafts the write carried, an answer that GitHub didn't
    /// do its first send gives them back, and anything else keeps the record
    /// for a read to settle. A record that can't be updated stays, and a read
    /// settles it.
    fn finish(
        &self,
        key: &BookKey,
        attempt: &AttemptId,
        written: Written,
        lane: Lane,
        sending: Sending,
    ) -> Wrote {
        let finished = self.gated(key, |book, _, gate| {
            let changed = match &written {
                Written::Done { .. } => book.landed(attempt),
                Written::NotSent { .. } | Written::Refused { .. } if sending == Sending::First => {
                    book.give_back(attempt, false)
                }
                Written::NotSent { .. } | Written::Refused { .. } | Written::Unknown { .. } => {
                    false
                }
            };
            gate.free(lane);
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
        let (waiting, mut drafts) = self.gated(key, |book, _, gate| {
            let waiting = if book.sent().is_empty() || gate.held() {
                Vec::new()
            } else {
                book.sent().to_vec()
            };
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
            (settled, drafts) = self.gated(key, |book, _, gate| {
                let mut settled = Vec::new();
                let sending = gate.held();
                for (sent, seen) in seen {
                    let unchanged = book
                        .sent()
                        .iter()
                        .any(|now| now.attempt == sent.attempt && now.at == sent.at);
                    if !unchanged || sending {
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
