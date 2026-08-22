#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

struct Daemon(Mutex<Option<Child>>);

fn spawn_daemon() -> Child {
    let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    Command::new("node")
        .arg("backend/server.js")
        .arg("--port")
        .arg("3001")
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn Relay daemon")
}

fn main() {
    let child = spawn_daemon();
    tauri::Builder::default()
        .manage(Daemon(Mutex::new(Some(child))))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                let _ = app;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Relay");
}
