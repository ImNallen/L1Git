use std::time::{Duration, Instant};

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use url::Url;

use crate::Host;
use crate::github::{self, ApiError, api_failure, read_body};
use crate::state::{WriteLock, unix_nanos};
use crate::vault::Token;
use crate::wire::{DevicePrompt, ErrorKind, Failure, Method};

/// The OAuth app that signs in through a browser. It ships in the binary, so
/// it is public by OAuth's design.
#[derive(Clone, Debug)]
pub struct ClientId(String);

impl ClientId {
    /// `L1GIT_GITHUB_CLIENT_ID` when this crate was built, so the app and the
    /// bridge agree. Unset or empty: `None`, which hides browser sign-in.
    pub fn compiled() -> Option<ClientId> {
        option_env!("L1GIT_GITHUB_CLIENT_ID")
            .filter(|id| !id.is_empty())
            .map(ClientId::new)
    }

    pub fn new(id: &str) -> ClientId {
        ClientId(id.to_owned())
    }
}

#[derive(Clone)]
pub(crate) struct Session {
    id: String,
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_at: Instant,
    interval: Duration,
    next_poll: Instant,
}

impl Session {
    pub(crate) fn prompt(&self, now: Instant) -> DevicePrompt {
        DevicePrompt {
            session: self.id.clone(),
            user_code: self.user_code.clone(),
            verification_uri: self.verification_uri.clone(),
            expires_in_ms: ceil_millis(self.expires_at.saturating_duration_since(now)),
            poll_after_ms: ceil_millis(self.next_poll.saturating_duration_since(now)),
        }
    }
}

fn ceil_millis(duration: Duration) -> u64 {
    duration.as_nanos().div_ceil(1_000_000) as u64
}

pub(crate) enum PollAnswer {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Refused(Failure),
    Token(Token),
}

pub(crate) enum Step {
    Wait(Session),
    Finished(Token),
    Ended(Failure),
}

const SLOW_DOWN: Duration = Duration::from_secs(5);

pub(crate) fn step(session: Session, answer: PollAnswer, now: Instant) -> Step {
    let expired = || {
        Step::Ended(Failure::new(
            ErrorKind::DeviceExpired,
            "The sign-in code expired before it was entered on GitHub. Sign in again for a new code.",
        ))
    };
    let interval = match answer {
        PollAnswer::Token(token) => return Step::Finished(token),
        PollAnswer::Refused(failure) => return Step::Ended(failure),
        PollAnswer::Denied => {
            return Step::Ended(Failure::new(
                ErrorKind::DeviceDenied,
                "The sign-in was cancelled on GitHub. Sign in again for a new code.",
            ));
        }
        PollAnswer::Expired => return expired(),
        _ if now >= session.expires_at => return expired(),
        PollAnswer::Pending => session.interval,
        PollAnswer::SlowDown => session.interval + SLOW_DOWN,
    };
    Step::Wait(Session {
        interval,
        next_poll: now + interval,
        ..session
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Reply<T> {
    Refused {
        error: String,
        error_description: Option<String>,
    },
    Granted(T),
}

fn refused(http_status: u16, error: String, description: Option<String>) -> Failure {
    Failure::new(
        ErrorKind::GitHubFailed { http_status },
        format!(
            "GitHub refused the browser sign-in: {}",
            description.unwrap_or(error)
        ),
    )
}

impl Host {
    fn client_id(&self) -> Result<&ClientId, Failure> {
        self.client_id.as_ref().ok_or_else(|| {
            Failure::new(
                ErrorKind::DeviceUnavailable,
                "This build of L1 Git cannot sign in through a browser. Sign in with the GitHub CLI instead.",
            )
        })
    }

    fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<(u16, Reply<T>), Failure> {
        let url = self
            .endpoints
            .web()
            .join(path)
            .map_err(|_| api_failure(ApiError::Unexpected))?;
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form)
            .finish();
        let response = self
            .http
            .client()?
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .map_err(|error| api_failure(github::reaching(&error)))?;
        let status = response.status().as_u16();
        let bytes = read_body(response).map_err(api_failure)?;
        match serde_json::from_slice(&bytes) {
            Ok(reply) => Ok((status, reply)),
            Err(_) if !(200..300).contains(&status) => Err(api_failure(ApiError::Status(status))),
            Err(_) => Err(api_failure(ApiError::Unexpected)),
        }
    }

    fn set_device(&self, _: &WriteLock<'_>, device: Option<Session>) {
        let mut state = self.lock();
        state.device = device;
        state.revision += 1;
    }

    pub(crate) fn device_start(&self) -> Result<(), Failure> {
        #[derive(Deserialize)]
        struct Code {
            device_code: String,
            user_code: String,
            verification_uri: String,
            expires_in: u64,
            interval: u64,
        }
        let client_id = self.client_id()?;
        let writer = self.lock_writes();
        let started = Instant::now();
        let code = match self.post::<Code>(
            "login/device/code",
            &[("client_id", &client_id.0), ("scope", "repo")],
        )? {
            (_, Reply::Granted(code)) => code,
            (
                status,
                Reply::Refused {
                    error,
                    error_description,
                },
            ) => return Err(refused(status, error, error_description)),
        };
        let on_github = Url::parse(&code.verification_uri)
            .is_ok_and(|page| page.origin() == self.endpoints.web().origin());
        if !on_github {
            return Err(api_failure(ApiError::Unexpected));
        }
        let interval = Duration::from_secs(code.interval);
        self.set_device(
            &writer,
            Some(Session {
                id: unix_nanos().to_string(),
                device_code: code.device_code,
                user_code: code.user_code,
                verification_uri: code.verification_uri,
                expires_at: started + Duration::from_secs(code.expires_in),
                interval,
                next_poll: started + interval,
            }),
        );
        Ok(())
    }

    pub(crate) fn device_poll(&self, id: &str) -> Result<(), Failure> {
        let client_id = self.client_id()?;
        let writer = self.lock_writes();
        let session = match &self.lock().device {
            Some(session) if session.id == id => session.clone(),
            _ => return Ok(()),
        };
        if Instant::now() < session.next_poll {
            return Ok(());
        }
        let (answer, failure) = match self.ask(client_id, &session.device_code) {
            Ok(answer) => (answer, None),
            Err(failure) => (PollAnswer::Pending, Some(failure)),
        };
        match step(session, answer, Instant::now()) {
            Step::Wait(next) => {
                self.set_device(&writer, Some(next));
                failure.map_or(Ok(()), Err)
            }
            Step::Ended(failure) => {
                self.set_device(&writer, None);
                Err(failure)
            }
            Step::Finished(token) => {
                self.set_device(&writer, None);
                let verified = github::verify(
                    self.http.client()?,
                    self.endpoints.api(),
                    Method::Device,
                    token,
                )
                .map_err(|error| match error {
                    ApiError::Unauthorized => Failure::new(
                        ErrorKind::Rejected,
                        "GitHub did not accept the browser sign-in. Sign in again.",
                    ),
                    error => api_failure(error),
                })?;
                self.commit(&writer, verified)
            }
        }
    }

    fn ask(&self, client_id: &ClientId, device_code: &str) -> Result<PollAnswer, Failure> {
        #[derive(Deserialize)]
        struct Granted {
            access_token: String,
        }
        match self.post::<Granted>(
            "login/oauth/access_token",
            &[
                ("client_id", &client_id.0),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )? {
            (_, Reply::Granted(granted)) => Token::parse(&granted.access_token)
                .map(PollAnswer::Token)
                .ok_or_else(|| api_failure(ApiError::Unexpected)),
            (
                status,
                Reply::Refused {
                    error,
                    error_description,
                },
            ) => match error.as_str() {
                "authorization_pending" => Ok(PollAnswer::Pending),
                "slow_down" => Ok(PollAnswer::SlowDown),
                "expired_token" => Ok(PollAnswer::Expired),
                "access_denied" => Ok(PollAnswer::Denied),
                _ => Ok(PollAnswer::Refused(refused(
                    status,
                    error,
                    error_description,
                ))),
            },
        }
    }

    pub(crate) fn device_cancel(&self, id: &str) -> Result<(), Failure> {
        self.client_id()?;
        let writer = self.lock_writes();
        let current = self
            .lock()
            .device
            .as_ref()
            .is_some_and(|session| session.id == id);
        if current {
            self.set_device(&writer, None);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(now: Instant) -> Session {
        Session {
            id: "1".to_owned(),
            device_code: "fixture-device-code".to_owned(),
            user_code: "WDJB-MJHT".to_owned(),
            verification_uri: "https://github.com/login/device".to_owned(),
            expires_at: now + Duration::from_secs(900),
            interval: Duration::from_secs(5),
            next_poll: now,
        }
    }

    fn waits(step: Step) -> (Duration, Instant) {
        match step {
            Step::Wait(session) => (session.interval, session.next_poll),
            _ => panic!("the session ended"),
        }
    }

    fn ends(step: Step) -> ErrorKind {
        match step {
            Step::Ended(failure) => failure.kind,
            _ => panic!("the session goes on"),
        }
    }

    #[test]
    fn step_table() {
        let now = Instant::now();
        let later = now + Duration::from_secs(60);
        let five = Duration::from_secs(5);
        let ten = Duration::from_secs(10);

        assert_eq!(
            waits(step(session(now), PollAnswer::Pending, later)),
            (five, later + five)
        );
        assert_eq!(
            waits(step(session(now), PollAnswer::SlowDown, later)),
            (ten, later + ten)
        );
        let slowed = match step(session(now), PollAnswer::SlowDown, now) {
            Step::Wait(session) => session,
            _ => panic!("the session ended"),
        };
        assert_eq!(
            waits(step(slowed, PollAnswer::Pending, later)),
            (ten, later + ten),
            "the slower interval stays"
        );

        let expired = now + Duration::from_secs(900);
        for answer in [PollAnswer::Pending, PollAnswer::SlowDown] {
            assert_eq!(
                ends(step(session(now), answer, expired)),
                ErrorKind::DeviceExpired
            );
        }
        assert_eq!(
            ends(step(session(now), PollAnswer::Expired, later)),
            ErrorKind::DeviceExpired
        );
        assert_eq!(
            ends(step(session(now), PollAnswer::Denied, later)),
            ErrorKind::DeviceDenied
        );
        let disabled = refused(200, "device_flow_disabled".to_owned(), None);
        assert_eq!(
            ends(step(session(now), PollAnswer::Refused(disabled), later)),
            ErrorKind::GitHubFailed { http_status: 200 }
        );
        let token = Token::parse("gho_device").unwrap();
        assert!(matches!(
            step(session(now), PollAnswer::Token(token), expired),
            Step::Finished(token) if token.expose() == "gho_device"
        ));
    }

    #[test]
    fn prompt_never_tells_a_client_to_poll_early() {
        let now = Instant::now();
        let mut waiting = session(now);
        waiting.next_poll = now + Duration::from_micros(1_500);
        let prompt = waiting.prompt(now);
        assert_eq!(prompt.poll_after_ms, 2);
        assert_eq!(prompt.expires_in_ms, 900_000);
        assert_eq!(
            session(now)
                .prompt(now + Duration::from_secs(1_000))
                .expires_in_ms,
            0
        );
    }
}
