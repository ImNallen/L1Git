use l1_git_core::{Coordinator, ErrorKind, RepositoryError, Request, Response};
use std::sync::Arc;

fn worker_error() -> RepositoryError {
    RepositoryError {
        kind: ErrorKind::GitFailed,
        message: "Git stopped unexpectedly. Try again.".into(),
    }
}

#[tauri::command]
async fn repository_run(
    coordinator: tauri::State<'_, Arc<Coordinator>>,
    request: Request,
) -> Result<Response, RepositoryError> {
    let coordinator = Arc::clone(&coordinator);
    tauri::async_runtime::spawn_blocking(move || l1_git_core::run(&coordinator, request))
        .await
        .map_err(|_| worker_error())?
}

fn main() {
    if let Err(error) = l1_git_core::stop_git_on_exit_signals(l1_git_core::OnQuit::Exit) {
        eprintln!("L1 Git cannot stop Git when a signal ends it: {error}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Coordinator::default()))
        .invoke_handler(tauri::generate_handler![repository_run])
        .build(tauri::generate_context!())
        .expect("L1 Git could not start")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                l1_git_core::stop_all_git();
            }
        });
}
