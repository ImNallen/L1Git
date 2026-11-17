//! L1 Git's side of GitHub. Build one `Host` and send it `Request`s with
//! `run`. Every reply, error or not, carries the current `Status`, so a screen
//! that mirrors it is always current. Tokens never leave this crate.

mod connect;
mod gh;
mod github;
mod process;
mod state;
mod vault;
mod wire;

#[cfg(all(test, unix))]
#[path = "../tests/support/mod.rs"]
#[allow(dead_code)]
mod support;
#[cfg(all(test, unix))]
mod tests;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use gh::Gh;
use github::Http;
use state::{Saved, State, Unreadable, unix_millis};
use vault::{MemoryVault, SystemVault, Vault};
use wire::Failure;

pub use github::{Endpoints, Login};
pub use wire::{
    Access, Answer, ConnectionView, EndReason, Ended, ErrorKind, GhProbe, GitHubStatus, HostError,
    KeychainProblem, Method, Request, Response, Status,
};

pub struct HostConfig {
    /// Where `host.json` lives.
    pub dir: PathBuf,
    pub vault: VaultChoice,
    pub gh: GhChoice,
    pub github: Endpoints,
}

pub enum VaultChoice {
    /// The macOS login keychain, Windows Credential Manager, or a Secret
    /// Service elsewhere. Give each binary its own `service`, so two binaries
    /// never share one item.
    System { service: String },
    /// Process memory, for tests.
    Memory,
}

pub enum GhChoice {
    /// PATH, then the install directories a desktop launch leaves off PATH.
    Search,
    At(PathBuf),
}

/// Owns the GitHub connection, its token, and every call to GitHub. Share it
/// as `Arc<Host>`.
pub struct Host {
    file: PathBuf,
    endpoints: Endpoints,
    gh: Gh,
    vault: Box<dyn Vault>,
    http: Http,
    writer: Mutex<()>,
    state: Mutex<State>,
}

impl Host {
    /// Reads `host.json` and nothing else, so building a host never prompts
    /// for the keychain or waits on the network.
    pub fn new(config: HostConfig) -> Host {
        let vault: Box<dyn Vault> = match config.vault {
            VaultChoice::System { service } => Box::new(SystemVault::new(service)),
            VaultChoice::Memory => Box::<MemoryVault>::default(),
        };
        Host::with_vault(config.dir, config.github, config.gh, vault)
    }

    fn with_vault(dir: PathBuf, endpoints: Endpoints, gh: GhChoice, vault: Box<dyn Vault>) -> Host {
        let file = dir.join("host.json");
        let (saved, ended) = match Saved::load(&file) {
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
            http: Http::new(!endpoints.api().is_loopback()),
            file,
            endpoints,
            gh: Gh::new(gh),
            vault,
            writer: Mutex::new(()),
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
    let outcome = match request {
        Request::Status {} => Ok(Answer::Status),
        Request::ProbeGh {} => Ok(Answer::ProbeGh(host.probe_gh())),
        Request::ConnectGh { login } => host.connect_gh(login).map(|()| Answer::ConnectGh),
        Request::Disconnect {} => host.disconnect().map(|()| Answer::Disconnect),
        Request::Verify {} => host.verify().map(|()| Answer::Verify),
    };
    let status = host.status();
    match outcome {
        Ok(answer) => Ok(Response { answer, status }),
        Err(failure) => Err(failure.with(status)),
    }
}
