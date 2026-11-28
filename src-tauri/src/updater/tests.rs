use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

/// Answers each request with the status and body `respond` gives its path.
struct Server {
    url: String,
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(respond: impl Fn(&str, &str) -> (u16, String) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let base = url.clone();
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
                let request = String::from_utf8_lossy(&request[..read]);
                let path = request.split(' ').nth(1).unwrap_or_default();
                let (status, body) = respond(&base, path);
                write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        Self {
            url,
            stopped,
            worker: Some(worker),
        }
    }

    fn feed(signature: &str, payload: &str, version: &str) -> Self {
        let signature = signature.to_owned();
        let payload = payload.to_owned();
        let version = version.to_owned();
        Self::new(move |url, path| {
            let body = if path == "/payload" {
                payload.clone()
            } else {
                serde_json::json!({ "version": version, "notes": "<script>plain notes</script>", "url": format!("{url}/payload"), "signature": signature }).to_string()
            };
            (200, body)
        })
    }
}
impl Drop for Server {
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
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": public_key, "requireSignedVersion": true, "dangerousInsecureTransportProtocol": true }));
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap()
}

async fn found(app: &tauri::App<MockRuntime>, feed: &Server) -> Option<Update> {
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
fn loopback_fixture_transport_setting_is_recognized() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    let config: tauri_plugin_updater::Config =
        serde_json::from_value(app.config().plugins.0["updater"].clone()).unwrap();
    assert!(config.dangerous_insecure_transport_protocol);
    assert!(config.require_signed_version);
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
        let feed = Server::feed(fixture[signature].as_str().unwrap(), payload, "0.2.0");
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
        let feed = Server::feed(fixture["signature"].as_str().unwrap(), "unused", version);
        assert!(tauri::async_runtime::block_on(found(&app, &feed)).is_none());
    }
    let nightly = app_at_version(
        fixture["publicKey"].as_str().unwrap(),
        "0.3.0-nightly.20261029.1",
    );
    for version in ["0.2.9", "0.3.0-nightly.20261028.1"] {
        let feed = Server::feed(fixture["signature"].as_str().unwrap(), "unused", version);
        assert!(tauri::async_runtime::block_on(found(&nightly, &feed)).is_none());
    }
    let newer_stable = Server::feed(fixture["signature"].as_str().unwrap(), "unused", "0.3.0");
    assert!(tauri::async_runtime::block_on(found(&nightly, &newer_stable)).is_some());
}

#[test]
fn duplicate_stale_and_track_switch_completions_cannot_replace_current_candidate() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    let feed = Server::feed(
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
    assert!(!controller.finish_check(
        old,
        Ok(Some(Found {
            update: update.clone(),
            changes: None
        }))
    ));
    assert!(controller.finish_check(
        current,
        Ok(Some(Found {
            update,
            changes: None
        }))
    ));
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
    let feed = Server::feed(
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
                changes: None,
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
            compare: None,
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
    let stable = Server::feed(
        fixture["signature"].as_str().unwrap(),
        fixture["payload"].as_str().unwrap(),
        "0.2.0",
    );
    let nightly = Server::feed(
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
        compare: None,
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

fn comparison(status: &str, total: usize, commits: &[(&str, usize)]) -> String {
    let commits: Vec<_> = commits
        .iter()
        .map(|(message, parents)| {
            serde_json::json!({
                "sha": "0000",
                "commit": { "message": message },
                "parents": vec![serde_json::json!({ "sha": "1111" }); *parents],
            })
        })
        .collect();
    serde_json::json!({ "status": status, "total_commits": total, "commits": commits, "files": [] })
        .to_string()
}

/// Serves `pages` for the range v0.1.0...v0.2.0 and 404 for anything else.
fn compare_server(pages: Vec<(u16, String)>) -> (Server, Arc<std::sync::atomic::AtomicUsize>) {
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&requests);
    let server = Server::new(move |_, path| {
        counted.fetch_add(1, Ordering::SeqCst);
        let page = path
            .strip_prefix("/v0.1.0...v0.2.0?per_page=100&page=")
            .and_then(|page| page.parse::<usize>().ok())
            .and_then(|page| pages.get(page.wrapping_sub(1)));
        page.cloned()
            .unwrap_or((404, r#"{"message":"Not Found"}"#.into()))
    });
    (server, requests)
}

fn changes_from(server: &Server, installed: &str) -> Option<Vec<String>> {
    tauri::async_runtime::block_on(changes(&format!("{}/", server.url), installed, "0.2.0"))
}

#[test]
fn compare_lists_every_non_merge_subject_newest_first() {
    let (server, _) = compare_server(vec![(
        200,
        comparison(
            "ahead",
            3,
            &[
                ("feat(pulls): first (#1)\n\nBody text.", 1),
                ("Merge branch 'main' into feature", 2),
                ("fix(shell): second (#2)", 1),
            ],
        ),
    )]);
    assert_eq!(
        changes_from(&server, "0.1.0").unwrap(),
        ["fix(shell): second (#2)", "feat(pulls): first (#1)"]
    );
}

#[test]
fn compare_pages_until_it_has_the_whole_range() {
    let subjects: Vec<String> = (0..150).map(|n| format!("change {n}")).collect();
    let page = |range: std::ops::Range<usize>, total| {
        let commits: Vec<_> = subjects[range].iter().map(|s| (s.as_str(), 1)).collect();
        (200, comparison("ahead", total, &commits))
    };
    let (server, _) = compare_server(vec![page(0..100, 150), page(100..150, 150)]);
    let mut expected = subjects.clone();
    expected.reverse();
    assert_eq!(changes_from(&server, "0.1.0").unwrap(), expected);

    let (short, _) = compare_server(vec![page(0..100, 150), page(0..0, 150)]);
    assert_eq!(changes_from(&short, "0.1.0"), None);

    let (long, requests) = compare_server(vec![page(0..100, 501); 6]);
    assert_eq!(changes_from(&long, "0.1.0"), None);
    assert_eq!(requests.load(Ordering::SeqCst), COMPARE_PAGES);
}

#[test]
fn compare_without_the_whole_ahead_range_is_none() {
    let ahead = comparison("ahead", 1, &[("feat: one", 1)]);
    for (status, body) in [
        (200, comparison("behind", 1, &[("feat: one", 1)])),
        (200, comparison("diverged", 1, &[("feat: one", 1)])),
        (200, comparison("identical", 0, &[])),
        (200, "not json".into()),
        (403, r#"{"message":"API rate limit exceeded"}"#.into()),
        (500, ahead.clone()),
    ] {
        let (server, _) = compare_server(vec![(status, body.clone())]);
        assert_eq!(changes_from(&server, "0.1.0"), None, "{status} {body}");
    }
    let (server, requests) = compare_server(vec![(200, ahead)]);
    assert_eq!(changes_from(&server, "0.0.9"), None, "missing tag");
    assert_eq!(changes_from(&server, "0.1.0/../x"), None);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[test]
fn check_publishes_the_candidate_once_with_its_changes_or_without_them() {
    let fixture = fixtures();
    let app = app(fixture["publicKey"].as_str().unwrap());
    let feed = Server::feed(
        fixture["signature"].as_str().unwrap(),
        fixture["payload"].as_str().unwrap(),
        "0.2.0",
    );
    let (listed, _) = compare_server(vec![(
        200,
        comparison("ahead", 2, &[("feat: old (#1)", 1), ("feat: new (#2)", 1)]),
    )]);
    let (failing, _) = compare_server(vec![(200, comparison("behind", 0, &[]))]);
    let temporary = tempfile::tempdir().unwrap();
    for (compare, changes) in [
        (
            &listed,
            serde_json::json!(["feat: new (#2)", "feat: old (#1)"]),
        ),
        (&failing, serde_json::Value::Null),
    ] {
        let updater = Arc::new(Updater {
            app: app.handle().clone(),
            inner: Mutex::new(controller()),
            preference: temporary.path().join("updates.json"),
            activity: Arc::new(RepositoryActivity::default()),
            feeds: Some([feed.url.clone(), feed.url.clone()]),
            compare: Some(format!("{}/", compare.url)),
        });
        tauri::async_runtime::block_on(async {
            let checking = updater.check();
            let available = wait_for(&updater, |state| {
                matches!(state, UpdateState::Available { .. })
            })
            .await;
            assert_eq!(available.revision, checking.revision + 1);
            let json = serde_json::to_value(&available).unwrap();
            assert_eq!(json["state"]["candidate"]["changes"], changes);
            assert_eq!(
                json["state"]["candidate"]["notes"],
                "<script>plain notes</script>"
            );
            assert_eq!(json["state"]["message"], serde_json::Value::Null);
        });
    }
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
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .expect("signed successor");
        assert_eq!(
            update.timeout, None,
            "manifest deadline must not limit downloads"
        );
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
