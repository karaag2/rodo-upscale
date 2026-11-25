// Engine side of Rodo Upscale. Commands and events are specified in CONTRACT.md.
// Stub for now: the real implementation lands in the backend work.

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running Rodo Upscale");
}
