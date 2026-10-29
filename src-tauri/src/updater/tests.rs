use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

struct Feed {
    url: String,
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Feed {
    fn new(signature: &str, payload: &str, version: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let manifest = serde_json::json!({ "version": version, "notes": "<script>plain notes</script>", "url": format!("{url}/payload"), "signature": signature }).to_string();
        let payload = payload.to_owned();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let worker = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let read = stream.read(&mut request).unwrap();
                let body = if String::from_utf8_lossy(&request[..read]).starts_with("GET /payload ")
                {
                    &payload
                } else {
                    &manifest
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        Self {
            url,
            stopped,
            worker: Some(worker),
        }
    }
}
impl Drop for Feed {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(self.url.trim_start_matches("http://"));
        self.worker.take().unwrap().join().unwrap();
    }
}

fn fixtures() -> serde_json::Value {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scripts/updater-fixture-signing.mjs"
        ))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn app(public_key: &str) -> tauri::App<MockRuntime> {
    app_at_version(public_key, "0.1.0")
}

fn app_at_version(public_key: &str, version: &str) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = version.parse().unwrap();
    context.config_mut().identifier = "dev.l1.git.updater-unit-tests".into();
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": public_key, "requireSignedVersion": true, "dangerInsecureTransportProtocol": true }));
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap()
}

async fn found(app: &tauri::App<MockRuntime>, feed: &Feed) -> Option<Update> {
    app.updater_builder()
        .endpoints(vec![feed.url.parse().unwrap()])
        .unwrap()
        .no_proxy()
        .build()
        .unwrap()
        .check()
        .await
        .unwrap()
}

fn controller() -> Controller {
    Controller {
        revision: 0,
        generation: 0,
        track: Track::Stable,
        installed_version: "0.1.0".into(),
        preference_error: None,
        phase: Phase::Idle,
    }
}

#[test]
fn real_updater_verifies_bytes_key_and_required_signed_version() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    for (signature, payload, success) in [
        ("signature", fixture["payload"].as_str().unwrap(), true),
        ("signature", "corrupted payload", false),
        ("wrongKey", fixture["payload"].as_str().unwrap(), false),
        ("absentVersion", fixture["payload"].as_str().unwrap(), false),
        (
            "mismatchedVersion",
            fixture["payload"].as_str().unwrap(),
            false,
        ),
    ] {
        let feed = Feed::new(fixture[signature].as_str().unwrap(), payload, "0.2.0");
        tauri::async_runtime::block_on(async {
            let update = found(&app, &feed).await.unwrap();
            let mut received = 0;
            let bytes = update.download(|chunk, _| received += chunk, || {}).await;
            assert_eq!(bytes.is_ok(), success, "{signature}: {bytes:?}");
            assert!(received > 0);
            if let Ok(bytes) = bytes {
                assert_eq!(bytes, payload.as_bytes());
            }
        });
    }
}

#[test]
fn default_comparator_never_downgrades_or_reinstalls() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    for version in ["0.0.9", "0.1.0", "0.1.0-nightly.20260101.1"] {
        let feed = Feed::new(fixture["signature"].as_str().unwrap(), "unused", version);
        assert!(tauri::async_runtime::block_on(found(&app, &feed)).is_none());
    }
    let nightly = app_at_version(
        fixture["publicKey"].as_str().unwrap(),
        "0.3.0-nightly.20261029.1",
    );
    for version in ["0.2.9", "0.3.0-nightly.20261028.1"] {
        let feed = Feed::new(fixture["signature"].as_str().unwrap(), "unused", version);
        assert!(tauri::async_runtime::block_on(found(&nightly, &feed)).is_none());
    }
    let newer_stable = Feed::new(fixture["signature"].as_str().unwrap(), "unused", "0.3.0");
    assert!(tauri::async_runtime::block_on(found(&nightly, &newer_stable)).is_some());
}

#[test]
fn duplicate_stale_and_track_switch_completions_cannot_replace_current_candidate() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    let feed = Feed::new(
        fixture["signature"].as_str().unwrap(),
        fixture["payload"].as_str().unwrap(),
        "0.2.0",
    );
    let update = tauri::async_runtime::block_on(found(&app, &feed)).unwrap();
    let mut controller = controller();
    let (old, _) = controller.begin_check().unwrap();
    assert!(controller.begin_check().is_none());
    controller.track = Track::Nightly;
    controller.phase = Phase::Idle;
    let (current, _) = controller.begin_check().unwrap();
    assert!(!controller.finish_check(old, Ok(Some(update.clone()))));
    assert!(controller.finish_check(current, Ok(Some(update))));
    let Phase::Available { release, .. } = &controller.phase else {
        panic!()
    };
    let release = release.clone();
    controller.phase = Phase::Downloading {
        release: release.clone(),
        received: 0,
        total: None,
    };
    assert!(controller.begin_check().is_none());
    assert!(controller.finish_download(release.clone(), Err("offline".into())));
    assert!(!controller.finish_download(release.clone(), Ok(vec![1])));
    controller.phase = Phase::Downloading {
        release: release.clone(),
        received: 0,
        total: None,
    };
    controller.phase = Phase::Idle;
    assert!(!controller.finish_download(release.clone(), Ok(vec![1])));
    controller.begin_check();
    assert!(!controller.finish_check(current, Ok(None)));
    controller.phase = Phase::Downloading {
        release: release.clone(),
        received: 0,
        total: None,
    };
    assert!(controller.finish_download(release, Ok(vec![1])));
    assert!(controller.begin_check().is_none());
}

#[test]
fn actual_failed_install_retains_verified_download_and_reopens_repository_admission() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    let feed = Feed::new(
        fixture["signature"].as_str().unwrap(),
        fixture["payload"].as_str().unwrap(),
        "0.2.0",
    );
    tauri::async_runtime::block_on(async {
        let update = found(&app, &feed).await.unwrap();
        let bytes = update.download(|_, _| {}, || {}).await.unwrap();
        let release = Release {
            candidate: Candidate {
                id: "1".into(),
                version: update.version.clone(),
                notes: None,
            },
            update,
        };
        let temporary = tempfile::tempdir().unwrap();
        let updater = Arc::new(Updater {
            app: app.handle().clone(),
            inner: Mutex::new(Controller {
                phase: Phase::Downloaded {
                    verified: Arc::new(Verified { release, bytes }),
                    message: None,
                },
                ..controller()
            }),
            preference: temporary.path().join("updates.json"),
            activity: Arc::new(RepositoryActivity::default()),
            feeds: None,
        });
        let hidden_request = updater.activity.admit().unwrap();
        assert!(matches!(
            updater.install("1".into()).unwrap().state,
            UpdateState::Downloaded {
                message: Some(_),
                ..
            }
        ));
        drop(hidden_request);
        assert!(updater.install("stale".into()).is_err());
        assert!(matches!(
            updater.install("1".into()).unwrap().state,
            UpdateState::Installing { .. }
        ));
        assert!(matches!(
            updater.install("1".into()).unwrap().state,
            UpdateState::Installing { .. }
        ));
        assert!(updater.activity.admit().is_err());
        for _ in 0..1000 {
            if matches!(
                updater.snapshot().state,
                UpdateState::Downloaded {
                    message: Some(_),
                    ..
                }
            ) {
                assert!(updater.activity.admit().is_ok());
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("failed install did not recover");
    });
}

#[test]
fn track_defaults_restores_and_failed_persistence_does_not_claim_success() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("config/updates.json");
    assert_eq!(
        preference(&path, "0.2.0-nightly.20261029.1").0,
        Track::Nightly
    );
    assert_eq!(preference(&path, "0.2.0").0, Track::Stable);
    save_preference(&path, Track::Stable).unwrap();
    assert_eq!(
        preference(&path, "0.2.0-nightly.20261029.1").0,
        Track::Stable
    );
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(preference(&path, "0.2.0").1.is_some());
    assert!(save_preference(&path.join("invalid"), Track::Nightly).is_err());
}

#[test]
fn production_policy_matches_release_key_and_exposes_no_frontend_updater_permission() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert_eq!(
        config["plugins"]["updater"]["pubkey"].as_str().unwrap(),
        include_str!("../../../scripts/updater-public-key.txt").trim()
    );
    assert_eq!(config["plugins"]["updater"]["requireSignedVersion"], true);
    assert_ne!(config["plugins"]["updater"]["allowDowngrades"], true);
    let capabilities = include_str!("../../capabilities/default.json");
    assert!(!capabilities.contains("updater:"));
    assert_eq!(Track::Stable.feed(), STABLE);
    assert_eq!(Track::Nightly.feed(), NIGHTLY);
}

async fn wait_for(
    updater: &Updater<MockRuntime>,
    predicate: impl Fn(&UpdateState) -> bool,
) -> Snapshot {
    for _ in 0..1000 {
        let snapshot = updater.snapshot();
        if predicate(&snapshot.state) {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!(
        "updater did not reach expected state: {:?}",
        updater.snapshot()
    );
}

#[test]
fn real_commands_check_download_switch_track_and_keep_verified_bytes_until_explicit_install() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    let stable = Feed::new(
        fixture["signature"].as_str().unwrap(),
        fixture["payload"].as_str().unwrap(),
        "0.2.0",
    );
    let nightly = Feed::new(
        fixture["signature"].as_str().unwrap(),
        fixture["payload"].as_str().unwrap(),
        "0.2.0",
    );
    let temporary = tempfile::tempdir().unwrap();
    let updater = Arc::new(Updater {
        app: app.handle().clone(),
        inner: Mutex::new(controller()),
        preference: temporary.path().join("updates.json"),
        activity: Arc::new(RepositoryActivity::default()),
        feeds: Some([stable.url.clone(), nightly.url.clone()]),
    });
    tauri::async_runtime::block_on(async {
        assert!(matches!(updater.check().state, UpdateState::Checking));
        let first = wait_for(&updater, |state| {
            matches!(state, UpdateState::Available { .. })
        })
        .await;
        let UpdateState::Available { candidate, .. } = first.state else {
            panic!()
        };
        assert!(updater.install(candidate.id.clone()).is_err());
        assert!(matches!(
            updater.download(candidate.id.clone()).unwrap().state,
            UpdateState::Downloading { .. }
        ));
        assert!(updater.download(candidate.id.clone()).is_ok());
        let downloaded = wait_for(&updater, |state| {
            matches!(state, UpdateState::Downloaded { .. })
        })
        .await;
        assert_eq!(
            updater.check().revision,
            downloaded.revision,
            "quiet checks must retain verified bytes"
        );
        assert!(matches!(
            updater.select_track(Track::Nightly).unwrap().state,
            UpdateState::Checking
        ));
        assert_eq!(preference(&updater.preference, "0.1.0").0, Track::Nightly);
        assert!(updater.download(candidate.id.clone()).is_err());
        assert!(updater.install(candidate.id.clone()).is_err());
        let second = wait_for(&updater, |state| {
            matches!(state, UpdateState::Available { .. })
        })
        .await;
        assert_eq!(second.track, Track::Nightly);
        let UpdateState::Available {
            candidate: next, ..
        } = second.state
        else {
            panic!()
        };
        assert_ne!(candidate.id, next.id);
        assert!(second.revision > downloaded.revision);
        std::fs::remove_file(&updater.preference).unwrap();
        std::fs::create_dir(&updater.preference).unwrap();
        let refused = updater.select_track(Track::Stable).unwrap();
        assert_eq!(refused.track, Track::Nightly);
        assert!(refused.preference_error.is_some());
        assert!(matches!(refused.state, UpdateState::Available { .. }));
    });
}

#[test]
#[ignore = "requires the disposable packaged feed started by scripts/updater-harness.mjs"]
fn packaged_fixture_feed_downloads_the_exact_signed_successor() {
    let directory = PathBuf::from(
        std::env::var("L1GIT_PACKAGED_FIXTURE_DIR").expect("set the disposable harness directory"),
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("harness.json")).unwrap()).unwrap();
    assert!(
        metadata["identifier"]
            .as_str()
            .unwrap()
            .starts_with("dev.l1.git.updater-fixture.")
    );
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("version-1.json")).unwrap()).unwrap();
    let app = app_at_version(
        config["plugins"]["updater"]["pubkey"].as_str().unwrap(),
        metadata["installedVersion"].as_str().unwrap(),
    );
    tauri::async_runtime::block_on(async {
        let update = app
            .updater_builder()
            .endpoints(vec![metadata["feed"].as_str().unwrap().parse().unwrap()])
            .unwrap()
            .no_proxy()
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .expect("signed successor");
        assert_eq!(
            update.version,
            metadata["successorVersion"].as_str().unwrap()
        );
        let bytes = update.download(|_, _| {}, || {}).await.unwrap();
        let artifact = std::fs::read(metadata["artifact"].as_str().unwrap()).unwrap();
        assert!(!bytes.is_empty());
        assert!(
            bytes == artifact,
            "download must equal the packaged successor bytes"
        );
    });
}
