#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod activity;
mod updater;

use l1_git_core::{Coordinator, ErrorKind, Limits, RepositoryError, Request, Response};
use std::sync::Arc;
use tauri::Manager;

fn worker_error() -> RepositoryError {
    RepositoryError {
        kind: ErrorKind::GitFailed,
        message: "Git stopped unexpectedly. Try again.".into(),
    }
}

#[tauri::command]
async fn repository_run(
    coordinator: tauri::State<'_, Arc<Coordinator>>,
    activity: tauri::State<'_, Arc<activity::RepositoryActivity>>,
    request: Request,
) -> Result<Response, RepositoryError> {
    let permit = activity.admit().map_err(|message| RepositoryError {
        kind: ErrorKind::GitFailed,
        message: message.into(),
    })?;
    let coordinator = Arc::clone(&coordinator);
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        l1_git_core::run(&coordinator, request)
    })
    .await
    .map_err(|_| worker_error())?
}

fn main() {
    if let Err(error) = l1_git_core::stop_git_on_exit_signals(l1_git_core::OnQuit::Exit) {
        eprintln!("L1 Git cannot stop Git when a signal ends it: {error}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let undo_dir = app.path().app_data_dir()?.join("undo");
            app.manage(Arc::new(Coordinator::new(Limits::default(), undo_dir)));
            let activity = Arc::new(activity::RepositoryActivity::default());
            let updater = Arc::new(updater::Updater::new(
                app.handle().clone(),
                Arc::clone(&activity),
            )?);
            app.manage(activity);
            app.manage(Arc::clone(&updater));
            updater.start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repository_run,
            updater::updater_snapshot,
            updater::updater_check,
            updater::updater_select_track,
            updater::updater_download,
            updater::updater_install
        ])
        .build(tauri::generate_context!())
        .expect("L1 Git could not start")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                l1_git_core::stop_all_git();
            }
        });
}
