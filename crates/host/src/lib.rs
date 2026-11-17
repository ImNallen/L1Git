//! L1 Git's side of GitHub. Build one `Host` and send it `Request`s with
//! `run`. Every reply, error or not, carries the current `Status`, so a screen
//! that mirrors it is always current.

mod gh;
mod github;
mod process;
mod state;
mod wire;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use gh::Gh;
use state::{Saved, State, Unreadable, unix_millis};
use wire::Failure;

pub use github::{Endpoints, Login};
pub use wire::{
    Access, Answer, ConnectionView, EndReason, Ended, ErrorKind, GhProbe, GitHubStatus, HostError,
    KeychainProblem, Method, Request, Response, Status,
};

pub struct HostConfig {
    /// Where `host.json` lives.
    pub dir: PathBuf,
    pub gh: GhChoice,
    pub github: Endpoints,
}

pub enum GhChoice {
    /// PATH, then the install directories a desktop launch leaves off PATH.
    Search,
    At(PathBuf),
}

/// Owns the GitHub connection and every call to GitHub. Share it as
/// `Arc<Host>`.
pub struct Host {
    endpoints: Endpoints,
    gh: Gh,
    state: Mutex<State>,
}

impl Host {
    /// Reads `host.json` and nothing else, so building a host never prompts
    /// for the keychain or waits on the network.
    pub fn new(config: HostConfig) -> Host {
        let (saved, ended) = match Saved::load(&config.dir.join("host.json")) {
            Ok(saved) => (saved, None),
            Err(Unreadable) => (
                Saved::default(),
                Some(Ended {
                    login: None,
                    reason: EndReason::Unreadable,
                }),
            ),
        };
        Host {
            endpoints: config.github,
            gh: Gh::new(config.gh),
            state: Mutex::new(State {
                revision: unix_millis(),
                saved,
                ended,
            }),
        }
    }

    /// For a transport whose blocking task died before `run` answered.
    pub fn interrupted(&self) -> HostError {
        Failure::new(
            ErrorKind::Interrupted,
            "L1 Git stopped before GitHub answered. Try again.",
        )
        .with(self.status())
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Synchronous, like `l1_git_core::run`, so call it off any async runtime.
#[allow(
    clippy::result_large_err,
    reason = "a HostError is built once per request, here, and never propagated"
)]
pub fn run(host: &Host, request: Request) -> Result<Response, HostError> {
    let answer = match request {
        Request::Status {} => Answer::Status,
        Request::ProbeGh {} => Answer::ProbeGh(host.gh.probe()),
    };
    Ok(Response {
        answer,
        status: host.status(),
    })
}
