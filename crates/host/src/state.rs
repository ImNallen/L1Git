use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, io};

use serde::{Deserialize, Serialize};

use crate::Host;
use crate::github::{ApiBase, Login};
use crate::wire::{Access, ConnectionView, Ended, GitHubStatus, Method, Status};

pub(crate) struct State {
    pub(crate) revision: u64,
    pub(crate) saved: Saved,
    pub(crate) ended: Option<Ended>,
}

#[derive(Default)]
pub(crate) struct Saved {
    connections: Vec<Connection>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Connection {
    api: ApiBase,
    login: Login,
    user_id: u64,
    method: Method,
    access: Access,
    connected_at: u64,
    generation: CommitId,
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

    fn get(&self, api: &ApiBase) -> Option<&Connection> {
        self.connections
            .iter()
            .find(|connection| &connection.api == api)
    }
}

impl Host {
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
        }
    }
}

pub(crate) fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
