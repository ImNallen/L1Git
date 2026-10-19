use l1_git_core::{
    Advance, CommitDetail, Coordinator, ErrorKind, FastForwardReport, FetchMode, FilePatch,
    RepositoryError, RepositoryOverview, RepositoryRefs, RepositorySnapshot,
};
use std::sync::Arc;

fn worker_error() -> RepositoryError {
    RepositoryError {
        kind: ErrorKind::GitFailed,
        message: "Git stopped unexpectedly. Try again.".into(),
    }
}

#[tauri::command]
async fn repository_snapshot(path: String) -> Result<RepositorySnapshot, RepositoryError> {
    tauri::async_runtime::spawn_blocking(move || l1_git_core::snapshot(&path))
        .await
        .map_err(|_| worker_error())?
}

#[tauri::command]
async fn repository_refs(path: String) -> Result<RepositoryRefs, RepositoryError> {
    tauri::async_runtime::spawn_blocking(move || l1_git_core::refs(&path))
        .await
        .map_err(|_| worker_error())?
}

#[tauri::command]
async fn repository_commit_detail(
    path: String,
    oid: String,
) -> Result<CommitDetail, RepositoryError> {
    tauri::async_runtime::spawn_blocking(move || l1_git_core::commit_detail(&path, &oid))
        .await
        .map_err(|_| worker_error())?
}

#[tauri::command]
async fn repository_file_patch(
    path: String,
    oid: String,
    file: String,
) -> Result<FilePatch, RepositoryError> {
    tauri::async_runtime::spawn_blocking(move || l1_git_core::file_patch(&path, &oid, &file))
        .await
        .map_err(|_| worker_error())?
}

#[tauri::command]
async fn repository_overview(
    coordinator: tauri::State<'_, Arc<Coordinator>>,
    path: String,
    mode: FetchMode,
) -> Result<RepositoryOverview, RepositoryError> {
    let coordinator = Arc::clone(&coordinator);
    tauri::async_runtime::spawn_blocking(move || coordinator.overview(&path, mode))
        .await
        .map_err(|_| worker_error())?
}

#[tauri::command]
async fn repository_fast_forward(
    coordinator: tauri::State<'_, Arc<Coordinator>>,
    path: String,
    advances: Vec<Advance>,
) -> Result<FastForwardReport, RepositoryError> {
    let coordinator = Arc::clone(&coordinator);
    tauri::async_runtime::spawn_blocking(move || coordinator.fast_forward(&path, &advances))
        .await
        .map_err(|_| worker_error())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Coordinator::default()))
        .invoke_handler(tauri::generate_handler![
            repository_snapshot,
            repository_refs,
            repository_commit_detail,
            repository_file_patch,
            repository_overview,
            repository_fast_forward
        ])
        .run(tauri::generate_context!())
        .expect("L1 Git could not start");
}
