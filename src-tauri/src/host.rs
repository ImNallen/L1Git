use l1_git_host::{Host, HostError, Request, Response};
use std::sync::Arc;

/// Runs in the blocking pool, because `run` uses a blocking HTTP client that
/// panics when it sends from an async thread.
#[tauri::command]
pub async fn host_run(
    host: tauri::State<'_, Arc<Host>>,
    request: Request,
) -> Result<Response, HostError> {
    let owned = Arc::clone(&host);
    tauri::async_runtime::spawn_blocking(move || l1_git_host::run(&owned, request))
        .await
        .map_err(|_| host.interrupted())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use l1_git_host::{Endpoints, GhChoice, HostConfig, VaultChoice};
    use serde_json::{Value, json};
    use std::path::PathBuf;
    use tauri::test::{
        INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
    };
    use tauri::webview::InvokeRequest;

    fn app(host: Arc<Host>) -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(host)
            .invoke_handler(tauri::generate_handler![host_run])
            .build(mock_context(noop_assets()))
            .unwrap()
    }

    fn invoke(app: &tauri::App<MockRuntime>, request: Value) -> Result<Value, Value> {
        let webview = tauri::WebviewWindowBuilder::new(app, "main", Default::default())
            .build()
            .unwrap();
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "host_run".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: json!({ "request": request }).into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    fn memory_host(dir: PathBuf, gh: GhChoice) -> Arc<Host> {
        Arc::new(Host::new(HostConfig {
            dir,
            vault: VaultChoice::Memory,
            gh,
            github: Endpoints::loopback("http://127.0.0.1:9/").unwrap(),
            client_id: None,
        }))
    }

    #[test]
    fn host_run_answers_without_repository_activity() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(memory_host(dir.path().into(), GhChoice::Search));
        let reply = invoke(&app, json!({ "op": "status" })).unwrap();
        assert_eq!(reply["op"], "status");
        assert_eq!(
            reply["status"]["github"],
            json!({ "kind": "notConnected", "ended": null })
        );
    }

    #[cfg(unix)]
    fn fake_gh(dir: &std::path::Path) -> GhChoice {
        let gh = dir.join("gh");
        std::os::unix::fs::symlink(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../crates/host/tests/fixtures/fake-gh"
            ),
            &gh,
        )
        .unwrap();
        std::fs::write(dir.join("token-octo"), "gho_fixture\n").unwrap();
        GhChoice::At(gh)
    }

    #[cfg(unix)]
    fn reached_github(reply: Result<Value, Value>) -> bool {
        reply.is_err_and(|error| {
            error["message"]
                == "L1 Git could not reach GitHub. Check your connection, then try again."
        })
    }

    #[cfg(unix)]
    #[test]
    fn host_run_calls_github_from_the_blocking_pool() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(memory_host(dir.path().into(), fake_gh(dir.path())));
        let reply = invoke(&app, json!({ "op": "connectGh", "login": "octo" }));
        assert!(reached_github(reply.clone()), "{reply:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_host_that_called_github_drops_on_an_async_thread() {
        let dir = tempfile::tempdir().unwrap();
        let host = memory_host(dir.path().into(), fake_gh(dir.path()));
        let request =
            serde_json::from_value(json!({ "op": "connectGh", "login": "octo" })).unwrap();
        let reply = l1_git_host::run(&host, request)
            .map(|response| serde_json::to_value(response).unwrap())
            .map_err(|error| serde_json::to_value(error).unwrap());
        assert!(reached_github(reply.clone()), "{reply:?}");
        let host = Arc::into_inner(host).unwrap();
        let dropped = tauri::async_runtime::spawn(async move { drop(host) });
        tauri::async_runtime::block_on(dropped).unwrap();
    }
}
