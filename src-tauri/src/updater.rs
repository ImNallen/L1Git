use crate::activity::RepositoryActivity;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const EVENT: &str = "l1git-update";
#[cfg(not(feature = "updater-fixture"))]
const STABLE: &str = "https://github.com/ImNallen/L1Git/releases/latest/download/latest.json";
#[cfg(not(feature = "updater-fixture"))]
const NIGHTLY: &str = "https://github.com/ImNallen/L1Git/releases/download/nightly/latest.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Track {
    Stable,
    Nightly,
}

impl Track {
    fn installed(version: &str) -> Self {
        if version.contains("-nightly.") {
            Self::Nightly
        } else {
            Self::Stable
        }
    }

    fn feed(self) -> &'static str {
        #[cfg(feature = "updater-fixture")]
        {
            env!("L1GIT_FIXTURE_FEED")
        }
        #[cfg(not(feature = "updater-fixture"))]
        match self {
            Self::Stable => STABLE,
            Self::Nightly => NIGHTLY,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    id: String,
    version: String,
    notes: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnavailableReason {
    Development,
    #[cfg(target_os = "linux")]
    ManualLinux,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateState {
    Unavailable {
        reason: UnavailableReason,
    },
    Idle,
    Checking,
    Current,
    Available {
        candidate: Candidate,
        message: Option<String>,
    },
    Downloading {
        candidate: Candidate,
        received: u64,
        total: Option<u64>,
    },
    Downloaded {
        candidate: Candidate,
        message: Option<String>,
    },
    Installing {
        candidate: Candidate,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    track: Track,
    installed_version: String,
    preference_error: Option<String>,
    state: UpdateState,
}

#[derive(Clone)]
struct Release {
    candidate: Candidate,
    update: Update,
}
struct Verified {
    release: Release,
    bytes: Vec<u8>,
}

enum Phase {
    Unavailable(UnavailableReason),
    Idle,
    Checking,
    Current,
    Available {
        release: Release,
        message: Option<String>,
    },
    Downloading {
        release: Release,
        received: u64,
        total: Option<u64>,
    },
    Downloaded {
        verified: Arc<Verified>,
        message: Option<String>,
    },
    Installing(Arc<Verified>),
    Failed(String),
}

struct Controller {
    revision: u64,
    generation: u64,
    track: Track,
    installed_version: String,
    preference_error: Option<String>,
    phase: Phase,
}

impl Controller {
    fn snapshot(&self) -> Snapshot {
        let state = match &self.phase {
            Phase::Unavailable(reason) => UpdateState::Unavailable { reason: *reason },
            Phase::Idle => UpdateState::Idle,
            Phase::Checking => UpdateState::Checking,
            Phase::Current => UpdateState::Current,
            Phase::Available { release, message } => UpdateState::Available {
                candidate: release.candidate.clone(),
                message: message.clone(),
            },
            Phase::Downloading {
                release,
                received,
                total,
            } => UpdateState::Downloading {
                candidate: release.candidate.clone(),
                received: *received,
                total: *total,
            },
            Phase::Downloaded { verified, message } => UpdateState::Downloaded {
                candidate: verified.release.candidate.clone(),
                message: message.clone(),
            },
            Phase::Installing(verified) => UpdateState::Installing {
                candidate: verified.release.candidate.clone(),
            },
            Phase::Failed(message) => UpdateState::Failed {
                message: message.clone(),
            },
        };
        Snapshot {
            revision: self.revision,
            track: self.track,
            installed_version: self.installed_version.clone(),
            preference_error: self.preference_error.clone(),
            state,
        }
    }

    fn begin_check(&mut self) -> Option<(u64, Track)> {
        if !matches!(
            self.phase,
            Phase::Idle | Phase::Current | Phase::Available { .. } | Phase::Failed(_)
        ) {
            return None;
        }
        self.generation += 1;
        self.phase = Phase::Checking;
        Some((self.generation, self.track))
    }

    fn finish_check(&mut self, generation: u64, result: Result<Option<Update>, String>) -> bool {
        if self.generation != generation || !matches!(self.phase, Phase::Checking) {
            return false;
        }
        self.phase = match result {
            Ok(Some(update)) => Phase::Available {
                release: Release {
                    candidate: Candidate {
                        id: generation.to_string(),
                        version: update.version.clone(),
                        notes: update.body.clone(),
                    },
                    update,
                },
                message: None,
            },
            Ok(None) => Phase::Current,
            Err(message) => Phase::Failed(message),
        };
        true
    }

    fn downloading(&self, id: &str) -> bool {
        matches!(&self.phase, Phase::Downloading { release, .. } if release.candidate.id == id)
    }

    fn finish_download(&mut self, release: Release, result: Result<Vec<u8>, String>) -> bool {
        if !self.downloading(&release.candidate.id) {
            return false;
        }
        self.phase = match result {
            Ok(bytes) => Phase::Downloaded {
                verified: Arc::new(Verified { release, bytes }),
                message: None,
            },
            Err(message) => Phase::Available {
                release,
                message: Some(message),
            },
        };
        true
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preference {
    version: u8,
    track: Track,
}

fn preference(path: &std::path::Path, installed: &str) -> (Track, Option<String>) {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Preference>(&bytes) {
            Ok(saved) if saved.version == 1 => (saved.track, None),
            _ => (Track::installed(installed), Some("The saved update channel could not be read. Select a channel to save it again.".into())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Track::installed(installed), None),
        Err(_) => (Track::installed(installed), Some("The saved update channel could not be read. Select a channel to try again.".into())),
    }
}

fn save_preference(path: &std::path::Path, track: Track) -> Result<(), String> {
    let save = || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let temporary = path.with_extension("tmp");
        std::fs::write(
            &temporary,
            serde_json::to_vec(&Preference { version: 1, track })?,
        )?;
        std::fs::rename(temporary, path)
    };
    save().map_err(|_| "The update channel could not be saved. Check app configuration directory permissions and try again.".into())
}

pub struct Updater<R: tauri::Runtime = tauri::Wry> {
    app: AppHandle<R>,
    inner: Mutex<Controller>,
    preference: PathBuf,
    activity: Arc<RepositoryActivity>,
    #[cfg(test)]
    feeds: Option<[String; 2]>,
}

impl<R: tauri::Runtime> Updater<R> {
    pub fn new(app: AppHandle<R>, activity: Arc<RepositoryActivity>) -> tauri::Result<Self> {
        #[cfg(feature = "updater-fixture")]
        assert!(
            app.config()
                .identifier
                .starts_with("dev.l1.git.updater-fixture."),
            "fixture build must use an isolated identifier"
        );
        let installed_version = app.package_info().version.to_string();
        let path = app.path().app_config_dir()?.join("updates.json");
        let (track, preference_error) = preference(&path, &installed_version);
        let reason = if cfg!(debug_assertions) {
            Some(UnavailableReason::Development)
        } else if tauri_plugin_updater::target().is_none() {
            Some(UnavailableReason::Unsupported)
        } else {
            Self::linux_reason(&app)
        };
        Ok(Self {
            app,
            activity,
            preference: path,
            #[cfg(test)]
            feeds: None,
            inner: Mutex::new(Controller {
                revision: 0,
                generation: 0,
                track,
                installed_version,
                preference_error,
                phase: reason.map_or(Phase::Idle, Phase::Unavailable),
            }),
        })
    }

    #[cfg(target_os = "linux")]
    fn linux_reason(app: &AppHandle<R>) -> Option<UnavailableReason> {
        app.env()
            .appimage
            .is_none()
            .then_some(UnavailableReason::ManualLinux)
    }
    #[cfg(not(target_os = "linux"))]
    fn linux_reason(_: &AppHandle<R>) -> Option<UnavailableReason> {
        None
    }

    fn publish(&self, controller: &mut Controller) -> Snapshot {
        controller.revision += 1;
        let snapshot = controller.snapshot();
        let _ = self.app.emit(EVENT, &snapshot);
        snapshot
    }

    pub fn snapshot(&self) -> Snapshot {
        self.inner.lock().unwrap().snapshot()
    }

    pub fn start(self: &Arc<Self>) {
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            updater.check();
            loop {
                tokio::time::sleep(Duration::from_secs(60 * 60)).await;
                updater.check();
            }
        });
    }

    pub fn select_track(self: &Arc<Self>, track: Track) -> Result<Snapshot, String> {
        let mut controller = self.inner.lock().unwrap();
        if matches!(controller.phase, Phase::Installing(_)) {
            return Err("Wait for installation to finish.".into());
        }
        if let Err(message) = save_preference(&self.preference, track) {
            controller.preference_error = Some(message);
            return Ok(self.publish(&mut controller));
        }
        controller.preference_error = None;
        controller.track = track;
        controller.generation += 1;
        if !matches!(controller.phase, Phase::Unavailable(_)) {
            controller.phase = Phase::Idle;
        }
        self.publish(&mut controller);
        drop(controller);
        Ok(self.check())
    }

    pub fn check(self: &Arc<Self>) -> Snapshot {
        let mut controller = self.inner.lock().unwrap();
        let Some((generation, track)) = controller.begin_check() else {
            return controller.snapshot();
        };
        let snapshot = self.publish(&mut controller);
        drop(controller);
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let result = updater.fetch(track).await.map_err(classify);
            let mut controller = updater.inner.lock().unwrap();
            if controller.finish_check(generation, result) {
                updater.publish(&mut controller);
            }
        });
        snapshot
    }

    async fn fetch(&self, track: Track) -> tauri_plugin_updater::Result<Option<Update>> {
        let feed = track.feed();
        #[cfg(test)]
        let feed = self
            .feeds
            .as_ref()
            .map_or(feed, |feeds| &feeds[usize::from(track == Track::Nightly)]);
        let builder = self
            .app
            .updater_builder()
            .endpoints(vec![feed.parse().expect("fixed update endpoint")])?
            .timeout(Duration::from_secs(30));
        #[cfg(feature = "updater-fixture")]
        let builder = builder.pubkey(env!("L1GIT_FIXTURE_PUBLIC_KEY"));
        builder.build()?.check().await
    }

    pub fn download(self: &Arc<Self>, id: String) -> Result<Snapshot, String> {
        let mut controller = self.inner.lock().unwrap();
        let release = match &controller.phase {
            Phase::Available { release, .. } if release.candidate.id == id => release.clone(),
            Phase::Downloading { release, .. } if release.candidate.id == id => {
                return Ok(controller.snapshot());
            }
            Phase::Downloaded { verified, .. } | Phase::Installing(verified)
                if verified.release.candidate.id == id =>
            {
                return Ok(controller.snapshot());
            }
            _ => return Err("This update changed. Check the current update and try again.".into()),
        };
        controller.phase = Phase::Downloading {
            release: release.clone(),
            received: 0,
            total: None,
        };
        let snapshot = self.publish(&mut controller);
        drop(controller);
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut received = 0;
            let result = release
                .update
                .download(
                    |chunk, total| {
                        received += chunk as u64;
                        let mut controller = updater.inner.lock().unwrap();
                        if let Phase::Downloading {
                            release: current,
                            received: current_received,
                            total: current_total,
                        } = &mut controller.phase
                            && current.candidate.id == release.candidate.id
                        {
                            *current_received = received;
                            *current_total = total;
                            updater.publish(&mut controller);
                        }
                    },
                    || {},
                )
                .await
                .map_err(classify);
            let mut controller = updater.inner.lock().unwrap();
            if controller.finish_download(release, result) {
                updater.publish(&mut controller);
            }
        });
        Ok(snapshot)
    }

    pub fn install(self: &Arc<Self>, id: String) -> Result<Snapshot, String> {
        let mut controller = self.inner.lock().unwrap();
        if let Phase::Installing(verified) = &controller.phase
            && verified.release.candidate.id == id
        {
            return Ok(controller.snapshot());
        }
        let verified = match &controller.phase {
            Phase::Downloaded { verified, .. } if verified.release.candidate.id == id => {
                Arc::clone(verified)
            }
            _ => {
                return Err(
                    "This update changed. Download the current update before installing.".into(),
                );
            }
        };
        let permit = match self.activity.begin_install() {
            Ok(permit) => permit,
            Err(message) => {
                controller.phase = Phase::Downloaded {
                    verified,
                    message: Some(message.into()),
                };
                return Ok(self.publish(&mut controller));
            }
        };
        controller.phase = Phase::Installing(Arc::clone(&verified));
        let snapshot = self.publish(&mut controller);
        drop(controller);
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                verified.release.update.install(&verified.bytes)
            }));
            match result {
                Ok(Ok(())) => {
                    std::mem::forget(permit);
                    updater.app.request_restart();
                }
                other => {
                    drop(permit);
                    let message = match other {
                        Ok(Err(error)) => classify(error),
                        _ => {
                            "Installation stopped unexpectedly. Your drafts are intact. Try again."
                                .into()
                        }
                    };
                    let mut controller = updater.inner.lock().unwrap();
                    controller.phase = Phase::Downloaded {
                        verified,
                        message: Some(message),
                    };
                    updater.publish(&mut controller);
                }
            }
        });
        Ok(snapshot)
    }
}

fn classify(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::Reqwest(_) | Error::Network(_) => "Could not reach the update server. Check your connection and try again.".into(),
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => "The update's signature or signed version could not be verified. Download again, or wait for a corrected release.".into(),
        Error::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => "L1 Git cannot replace this app. Move it to a writable location or update manually.".into(),
        Error::TempDirNotOnSameMountPoint => "Move L1 Git to a writable location on the same disk and try again, or update manually.".into(),
        other => format!("Update failed: {other}. Try again or update manually."),
    }
}

#[tauri::command]
pub fn updater_snapshot(updater: tauri::State<'_, Arc<Updater>>) -> Snapshot {
    updater.snapshot()
}
#[tauri::command]
pub fn updater_check(updater: tauri::State<'_, Arc<Updater>>) -> Snapshot {
    updater.check()
}
#[tauri::command]
pub fn updater_select_track(
    updater: tauri::State<'_, Arc<Updater>>,
    track: Track,
) -> Result<Snapshot, String> {
    updater.select_track(track)
}
#[tauri::command]
pub fn updater_download(
    updater: tauri::State<'_, Arc<Updater>>,
    candidate: String,
) -> Result<Snapshot, String> {
    updater.download(candidate)
}
#[tauri::command]
pub fn updater_install(
    updater: tauri::State<'_, Arc<Updater>>,
    candidate: String,
) -> Result<Snapshot, String> {
    updater.install(candidate)
}

#[cfg(test)]
mod tests;
