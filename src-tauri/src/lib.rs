// Engine side of Rodo Upscale. Commands and events are specified in CONTRACT.md.

mod engine;

use engine::{JobControl, Settings};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;

pub(crate) const IMAGE_EXTS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

#[derive(Default)]
struct AppState {
    job: Mutex<Option<Arc<JobControl>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    path: String,
    count: usize,
    total_bytes: u64,
    first_image: Option<String>,
    sample_width: Option<u32>,
    sample_height: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobStarted {
    output_dir: String,
    total: usize,
    already_done: usize,
}

/// Images directly inside `dir` (not recursive), sorted by name. Hidden files are skipped.
pub(crate) fn list_images(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(dir).map_err(|_| "Impossible d'ouvrir ce dossier.".to_string())?;
    let mut images: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let hidden = p.file_name().and_then(|n| n.to_str()).map_or(true, |n| n.starts_with('.'));
            let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
            !hidden && ext.map_or(false, |e| IMAGE_EXTS.contains(&e.as_str()))
        })
        .collect();
    images.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    Ok(images)
}

#[tauri::command]
fn scan_folder(path: String) -> Result<ScanResult, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("Ce n'est pas un dossier.".into());
    }
    let images = list_images(&dir)?;
    let total_bytes = images.iter().filter_map(|p| p.metadata().ok()).map(|m| m.len()).sum();
    let first = images.first();
    let dims = first.and_then(|p| image::image_dimensions(p).ok());
    Ok(ScanResult {
        path,
        count: images.len(),
        total_bytes,
        first_image: first.map(|p| p.to_string_lossy().into_owned()),
        sample_width: dims.map(|d| d.0),
        sample_height: dims.map(|d| d.1),
    })
}

#[tauri::command]
fn start_job(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input_dir: String,
    settings: Settings,
) -> Result<JobStarted, String> {
    let mut slot = state.job.lock().unwrap();
    if slot.as_ref().is_some_and(|j| j.running.load(Ordering::SeqCst)) {
        return Err("Un traitement est déjà en cours.".into());
    }
    let (control, started) = engine::start(app, PathBuf::from(input_dir), settings)?;
    *slot = Some(control);
    Ok(started)
}

#[tauri::command]
fn pause_job(state: State<'_, AppState>) {
    if let Some(job) = state.job.lock().unwrap().as_ref() {
        job.pause.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|_| "Impossible d'ouvrir ce dossier.".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![scan_folder, start_job, pause_job, open_path])
        .build(tauri::generate_context!())
        .expect("error while building Rodo Upscale")
        .run(|app, event| {
            // Closing the window must not leave the engine running in the background.
            if let RunEvent::Exit = event {
                if let Some(job) = app.state::<AppState>().job.lock().unwrap().as_ref() {
                    job.cancel.store(true, Ordering::SeqCst);
                }
            }
        });
}
