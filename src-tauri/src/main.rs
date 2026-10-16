use l1_git_core::{CommitDetail, ErrorKind, RepositoryError, RepositorySnapshot};

fn worker_error() -> RepositoryError {
    RepositoryError {
        kind: ErrorKind::GitFailed,
        message: "The repository reader stopped unexpectedly. Try again.".into(),
    }
}

#[tauri::command]
async fn repository_snapshot(
    path: String,
    reference: Option<String>,
) -> Result<RepositorySnapshot, RepositoryError> {
    tauri::async_runtime::spawn_blocking(move || l1_git_core::snapshot(&path, reference.as_deref()))
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            repository_snapshot,
            repository_commit_detail
        ])
        .run(tauri::generate_context!())
        .expect("L1 Git could not start");
}
