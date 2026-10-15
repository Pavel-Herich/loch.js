#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Native initialization runs even when an old service worker serves cached HTML.
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .initialization_script(include_str!("../desktop-cache-reset.js"))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri launch failed");
}
