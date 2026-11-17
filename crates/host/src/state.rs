use std::path::Path;
use std::sync::{MutexGuard, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::{fs, io};

use serde::{Deserialize, Serialize};

use crate::Host;
use crate::device::Session;
use crate::github::{Account, ApiBase, Login, Verified};
use crate::vault::keychain;
use crate::wire::{
    Access, ConnectionView, EndReason, Ended, ErrorKind, Failure, GitHubStatus, KeychainProblem,
    Method, Status,
};

pub(crate) struct State {
    pub(crate) revision: u64,
    pub(crate) saved: Saved,
    pub(crate) ended: Option<Ended>,
    pub(crate) device: Option<Session>,
}

#[derive(Clone, Default)]
pub(crate) struct Saved {
    connections: Vec<Connection>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Connection {
    api: ApiBase,
    login: Login,
    user_id: u64,
    method: Method,
    access: Access,
    connected_at: u64,
    pub(crate) generation: CommitId,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct CommitId(u64);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u8,
    connections: Vec<Connection>,
}

pub(crate) struct Unreadable;

impl Saved {
    pub(crate) fn load(path: &Path) -> Result<Saved, Unreadable> {
        match fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<File>(&bytes) {
                Ok(File {
                    version: 1,
                    connections,
                }) => Ok(Saved { connections }),
                _ => Err(Unreadable),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Saved::default()),
            Err(_) => Err(Unreadable),
        }
    }

    fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let temporary = path.with_extension("tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "connections": self.connections,
            }))?,
        )?;
        fs::rename(temporary, path)
    }

    pub(crate) fn get(&self, api: &ApiBase) -> Option<&Connection> {
        self.connections
            .iter()
            .find(|connection| &connection.api == api)
    }

    fn without(&self, api: &ApiBase) -> Saved {
        Saved {
            connections: self
                .connections
                .iter()
                .filter(|connection| &connection.api != api)
                .cloned()
                .collect(),
        }
    }

    fn with(&self, connection: Connection) -> Saved {
        let mut next = self.without(&connection.api);
        next.connections.push(connection);
        next
    }
}

pub(crate) struct WriteLock<'a> {
    _guard: MutexGuard<'a, ()>,
}

impl Host {
    pub(crate) fn lock_writes(&self) -> WriteLock<'_> {
        WriteLock {
            _guard: self.writer.lock().unwrap_or_else(PoisonError::into_inner),
        }
    }

    pub(crate) fn status(&self) -> Status {
        let state = self.lock();
        let github = match state.saved.get(self.endpoints.api()) {
            Some(connection) => GitHubStatus::Connected(ConnectionView {
                login: connection.login.to_string(),
                api: connection.api.as_str().to_owned(),
                method: connection.method,
                access: connection.access,
                connected_at: connection.connected_at,
            }),
            None => GitHubStatus::NotConnected {
                ended: state.ended.clone(),
            },
        };
        Status {
            revision: state.revision,
            github,
            device_sign_in: self.client_id.is_some(),
            device_code: state
                .device
                .as_ref()
                .map(|session| session.prompt(Instant::now())),
        }
    }

    fn store(&self, _: &WriteLock<'_>, saved: Saved, ended: Option<Ended>) -> Result<(), Failure> {
        saved.save(&self.file).map_err(|_| {
            Failure::new(
                ErrorKind::Storage,
                "L1 Git could not save its GitHub connection. Check that its configuration folder is writable, then try again.",
            )
        })?;
        let mut state = self.lock();
        state.saved = saved;
        state.ended = ended;
        state.revision += 1;
        Ok(())
    }

    pub(crate) fn commit(&self, writer: &WriteLock<'_>, verified: Verified) -> Result<(), Failure> {
        let api = self.endpoints.api();
        let mut saved = self.lock().saved.clone();
        let previous = saved.get(api).map(|connection| connection.generation);
        if previous.is_some() {
            saved = saved.without(api);
            self.store(writer, saved.clone(), None)?;
        }
        let (token, account, access, method) = verified.into_parts();
        self.vault.replace(api, &token).map_err(keychain)?;
        let connection = Connection {
            api: api.clone(),
            login: account.login,
            user_id: account.id,
            method,
            access,
            connected_at: unix_secs(),
            generation: CommitId(unix_nanos().max(previous.map_or(0, |last| last.0 + 1))),
        };
        self.store(writer, saved.with(connection), None)
    }

    pub(crate) fn disconnect_and_clear_slot(&self, writer: &WriteLock<'_>) -> Result<(), Failure> {
        let api = self.endpoints.api();
        let (saved, ended) = {
            let state = self.lock();
            (state.saved.clone(), state.ended.is_some())
        };
        if saved.get(api).is_some() || ended {
            self.store(writer, saved.without(api), None)?;
        }
        self.vault.delete_if_present(api).map_err(left_in_keychain)
    }

    pub(crate) fn forget(&self, _: &WriteLock<'_>, generation: CommitId, reason: EndReason) {
        let api = self.endpoints.api();
        let saved = self.lock().saved.clone();
        let Some(login) = saved
            .get(api)
            .filter(|connection| connection.generation == generation)
            .map(|connection| connection.login.to_string())
        else {
            return;
        };
        let next = saved.without(api);
        let _ = next.save(&self.file);
        let _ = self.vault.delete_if_present(api);
        let mut state = self.lock();
        state.saved = next;
        state.ended = Some(Ended {
            login: Some(login),
            reason,
        });
        state.revision += 1;
    }

    pub(crate) fn refresh(
        &self,
        writer: &WriteLock<'_>,
        generation: CommitId,
        account: Account,
        access: Access,
    ) -> Result<(), Failure> {
        let saved = self.lock().saved.clone();
        let Some(current) = saved
            .get(self.endpoints.api())
            .filter(|connection| connection.generation == generation)
        else {
            return Ok(());
        };
        if current.login.as_str() == account.login.as_str() && current.access == access {
            return Ok(());
        }
        let updated = Connection {
            login: account.login,
            access,
            ..current.clone()
        };
        self.store(writer, saved.with(updated), None)
    }
}

fn left_in_keychain(problem: KeychainProblem) -> Failure {
    Failure::new(
        ErrorKind::Keychain { problem },
        "L1 Git disconnected from GitHub, but could not remove its copy of the sign-in from the system keychain. The next sign-in replaces it.",
    )
}

fn since_epoch() -> std::time::Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

pub(crate) fn unix_secs() -> u64 {
    since_epoch().as_secs()
}

pub(crate) fn unix_millis() -> u64 {
    since_epoch().as_millis() as u64
}

pub(crate) fn unix_nanos() -> u64 {
    since_epoch().as_nanos() as u64
}
