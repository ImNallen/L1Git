use serde::{Deserialize, Serialize};

use crate::Login;
use crate::pulls::{PullRequest, PullRequestList, PullRequests, Repository};

/// Variants without fields are empty structs, because serde ignores unknown
/// fields on an internally tagged unit variant.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    /// Reads memory only, so it is safe on every app mount.
    Status {},
    /// Runs `gh auth status`. Reads no token.
    ProbeGh {},
    /// Copies gh's token for the account the consent dialog named.
    ConnectGh {
        login: Login,
    },
    Disconnect {},
    /// Reads the token and asks GitHub who it belongs to.
    Verify {},
    /// Asks GitHub for a code to enter in the browser, replacing any running
    /// browser sign-in.
    DeviceStart {},
    /// Asks GitHub at most once whether the code was entered, and not before
    /// `pollAfterMs`.
    DevicePoll {
        session: String,
    },
    DeviceCancel {
        session: String,
    },
    /// Asks GitHub for one repository's pull requests.
    PullRequests {
        repository: Repository,
        list: PullRequestList,
    },
    PullRequest {
        repository: Repository,
        number: u32,
    },
}

/// `{op, data?, status}`.
#[derive(Debug, Serialize)]
pub struct Response {
    #[serde(flatten)]
    pub answer: Answer,
    pub status: Status,
}

#[derive(Debug, Serialize)]
#[serde(tag = "op", content = "data", rename_all = "camelCase")]
pub enum Answer {
    Status,
    ProbeGh(GhProbe),
    ConnectGh,
    Disconnect,
    Verify,
    DeviceStart,
    DevicePoll,
    DeviceCancel,
    PullRequests(PullRequests),
    PullRequest(Box<PullRequest>),
}

/// Everything the webview knows about the host side. No field can hold a
/// token or a device code.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Grows with every change. A client keeps the status with the highest
    /// revision it has seen.
    pub revision: u64,
    pub github: GitHubStatus,
    /// Whether this build can sign in through a browser.
    pub device_sign_in: bool,
    /// Present while a browser sign-in waits for the user.
    pub device_code: Option<DevicePrompt>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePrompt {
    pub session: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in_ms: u64,
    /// Rust asks GitHub no sooner, so an earlier `devicePoll` only answers
    /// with the status.
    pub poll_after_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitHubStatus {
    /// `ended` says why the last connection ended without the user
    /// disconnecting. It lives in memory until the next connect or disconnect.
    NotConnected {
        ended: Option<Ended>,
    },
    Connected(ConnectionView),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub login: String,
    pub api: String,
    pub method: Method,
    pub access: Access,
    /// Unix seconds.
    pub connected_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    Gh,
    Device,
}

/// What the token can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// A classic or OAuth token with the `repo` scope.
    Private,
    /// A classic or OAuth token without `repo`: public repositories only.
    PublicOnly,
    /// No scope list, as for fine-grained tokens: the token's own settings
    /// decide per repository.
    PerRepository,
}

impl Access {
    pub(crate) fn from_scopes(scopes: Option<&str>) -> Access {
        match scopes.map(str::trim) {
            None | Some("") => Access::PerRepository,
            Some(list) if list.split(',').any(|scope| scope.trim() == "repo") => Access::Private,
            Some(_) => Access::PublicOnly,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    pub login: Option<String>,
    pub reason: EndReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    /// GitHub answered 401 to the saved token.
    Revoked,
    /// The keychain no longer holds the token `host.json` names.
    TokenMissing,
    /// `host.json` could not be read at startup.
    Unreadable,
}

/// Every state the GitHub CLI can be in. The consent dialog renders each.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GhProbe {
    /// Neither on PATH nor in a known install directory.
    Missing,
    /// gh predates `auth status --json`.
    Outdated,
    /// gh has no stored github.com account. An account that gh reads from an
    /// environment variable does not count.
    SignedOut,
    /// gh's active account has a token GitHub refuses.
    Broken {
        login: Login,
    },
    Failed {
        detail: String,
    },
    /// `path` is the gh L1 Git will ask, shown in the consent dialog.
    Ready {
        login: Login,
        access: Access,
        path: String,
    },
}

/// `{kind, ...fields, message, status}`.
#[derive(Debug, Serialize)]
pub struct HostError {
    #[serde(flatten)]
    pub kind: ErrorKind,
    pub message: String,
    pub status: Status,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ErrorKind {
    GhMissing,
    GhOutdated,
    GhSignedOut,
    /// GitHub says the token belongs to someone other than the account the
    /// user consented to.
    GhAccountChanged {
        expected: String,
        found: String,
    },
    GhFailed,
    /// GitHub refused the token being connected.
    Rejected,
    /// A saved token stopped working, so the connection is gone and
    /// `status.github.ended` says why.
    SignedOut,
    NotConnected,
    RateLimited {
        /// Unix seconds.
        reset_at: Option<u64>,
    },
    Unreachable,
    GitHubFailed {
        http_status: u16,
    },
    Keychain {
        problem: KeychainProblem,
    },
    /// GitHub answers the same for something that is gone and something this
    /// sign-in cannot read.
    NotFound,
    /// The token works, but not for this organization until the user
    /// authorizes it at `url`.
    SsoRequired {
        url: String,
    },
    /// `host.json` could not be written.
    Storage,
    /// The task running the request died, or its sign-in ended, before GitHub
    /// answered.
    Interrupted,
    /// This build has no OAuth client ID, so it cannot sign in through a
    /// browser.
    DeviceUnavailable,
    DeviceExpired,
    /// The user declined the sign-in on GitHub.
    DeviceDenied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeychainProblem {
    /// Locked, or the user denied L1 Git at the system prompt.
    Locked,
    /// No usable store, such as a Linux session without a Secret Service.
    Unavailable,
}

#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) kind: ErrorKind,
    pub(crate) message: String,
}

impl Failure {
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Failure {
        Failure {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn with(self, status: Status) -> HostError {
        HostError {
            kind: self.kind,
            message: self.message,
            status,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn login(raw: &str) -> Login {
        Login::try_from(raw.to_owned()).unwrap()
    }

    fn json(value: impl Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn response_shapes() {
        let signed_out = Status {
            revision: 7,
            github: GitHubStatus::NotConnected { ended: None },
            device_sign_in: true,
            device_code: Some(DevicePrompt {
                session: "1".to_owned(),
                user_code: "WDJB-MJHT".to_owned(),
                verification_uri: "https://github.com/login/device".to_owned(),
                expires_in_ms: 899_000,
                poll_after_ms: 5_000,
            }),
        };
        let connected = Status {
            revision: 8,
            github: GitHubStatus::Connected(ConnectionView {
                login: "octo".to_owned(),
                api: "https://api.github.com/".to_owned(),
                method: Method::Device,
                access: Access::PublicOnly,
                connected_at: 1,
            }),
            device_sign_in: false,
            device_code: None,
        };
        assert_eq!(
            json(Response {
                answer: Answer::ProbeGh(GhProbe::Ready {
                    login: login("octo"),
                    access: Access::Private,
                    path: "/opt/homebrew/bin/gh".to_owned(),
                }),
                status: signed_out,
            }),
            json!({
                "op": "probeGh",
                "data": {"kind": "ready", "login": "octo", "access": "private", "path": "/opt/homebrew/bin/gh"},
                "status": {"revision": 7, "github": {"kind": "notConnected", "ended": null}, "deviceSignIn": true, "deviceCode": {
                    "session": "1", "userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device",
                    "expiresInMs": 899_000, "pollAfterMs": 5_000,
                }},
            })
        );
        assert_eq!(
            json(Response {
                answer: Answer::Disconnect,
                status: connected,
            }),
            json!({
                "op": "disconnect",
                "status": {"revision": 8, "github": {
                    "kind": "connected", "login": "octo", "api": "https://api.github.com/",
                    "method": "device", "access": "publicOnly", "connectedAt": 1,
                }, "deviceSignIn": false, "deviceCode": null},
            })
        );
        let error = |kind: ErrorKind| {
            json(HostError {
                kind,
                message: "Sentence.".to_owned(),
                status: Status {
                    revision: 9,
                    github: GitHubStatus::NotConnected {
                        ended: Some(Ended {
                            login: Some("octo".to_owned()),
                            reason: EndReason::TokenMissing,
                        }),
                    },
                    device_sign_in: false,
                    device_code: None,
                },
            })
        };
        let status = json!({"revision": 9, "github": {"kind": "notConnected", "ended": {"login": "octo", "reason": "tokenMissing"}}, "deviceSignIn": false, "deviceCode": null});
        assert_eq!(
            error(ErrorKind::GhAccountChanged {
                expected: "octo".to_owned(),
                found: "hubot".to_owned()
            }),
            json!({"kind": "ghAccountChanged", "expected": "octo", "found": "hubot", "message": "Sentence.", "status": status})
        );
        assert_eq!(
            error(ErrorKind::RateLimited { reset_at: Some(5) }),
            json!({"kind": "rateLimited", "resetAt": 5, "message": "Sentence.", "status": status})
        );
        assert_eq!(
            error(ErrorKind::GitHubFailed { http_status: 502 }),
            json!({"kind": "gitHubFailed", "httpStatus": 502, "message": "Sentence.", "status": status})
        );
        assert_eq!(
            error(ErrorKind::Keychain {
                problem: KeychainProblem::Locked
            }),
            json!({"kind": "keychain", "problem": "locked", "message": "Sentence.", "status": status})
        );
        assert_eq!(
            error(ErrorKind::SignedOut),
            json!({"kind": "signedOut", "message": "Sentence.", "status": status})
        );
        assert_eq!(
            error(ErrorKind::DeviceExpired),
            json!({"kind": "deviceExpired", "message": "Sentence.", "status": status})
        );
    }

    #[test]
    fn requests_reject_unknown_ops_and_fields() {
        let parse = |value: Value| serde_json::from_value::<Request>(value);
        let pulls = |owner: &str, repo: &str, list: &str| json!({"op": "pullRequests", "repository": {"owner": owner, "repo": repo}, "list": list});
        assert!(matches!(
            parse(json!({"op": "status"})),
            Ok(Request::Status {})
        ));
        assert!(matches!(
            parse(json!({"op": "connectGh", "login": "octo"})),
            Ok(Request::ConnectGh { login }) if login.as_str() == "octo"
        ));
        assert!(matches!(
            parse(json!({"op": "devicePoll", "session": "1"})),
            Ok(Request::DevicePoll { session }) if session == "1"
        ));
        assert!(parse(pulls("octo", "app-2.x_y", "recentlyMerged")).is_ok());
        for refused in [
            json!({"op": "status", "extra": 1}),
            json!({"op": "connectGh", "login": "-x"}),
            json!({"op": "connectGh"}),
            json!({"op": "connectGh", "login": "octo", "token": "gho_x"}),
            json!({"op": "verify", "extra": 1}),
            json!({"op": "deviceStart", "clientId": "x"}),
            json!({"op": "devicePoll"}),
            json!({"op": "deviceCancel", "session": 1}),
            pulls("octo", "app", "closed"),
            pulls("octo", "app extra", "open"),
            pulls("octo\"", "app", "open"),
            pulls("octo", "..", "open"),
            pulls("", "app", "open"),
            json!({"op": "pullRequest", "repository": {"owner": "octo", "repo": "app"}, "number": -1}),
            json!({"op": "pullRequest", "repository": {"owner": "octo", "repo": "app"}, "number": "1"}),
            json!({"op": "pullRequests", "repository": {"owner": "octo", "repo": "app", "extra": 1}, "list": "open"}),
        ] {
            assert!(parse(refused.clone()).is_err(), "{refused}");
        }
    }
}
