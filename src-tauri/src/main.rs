#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::{Update, UpdaterExt};

struct ServerProcess {
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
}

struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current_version: String,
}

fn start_server(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if app.state::<ServerProcess>().stopping.load(Ordering::SeqCst) {
                return;
            }

            let parent_pid = std::process::id().to_string();
            let sidecar = match app
                .shell()
                .sidecar("cctv-server")
                .map(|command| {
                    command
                        .args(["--parent-pid", parent_pid.as_str()])
                        .set_process_group(true)
                })
            {
                Ok(sidecar) => sidecar,
                Err(_) => {
                    std::thread::sleep(Duration::from_secs(3));
                    continue;
                }
            };

            match sidecar.spawn() {
                Ok((mut events, child)) => {
                    if let Ok(mut guard) = app.state::<ServerProcess>().child.lock() {
                        *guard = Some(child);
                    }
                    while let Some(event) = events.recv().await {
                        if let CommandEvent::Terminated(_) = event {
                            break;
                        }
                    }
                    if let Ok(mut guard) = app.state::<ServerProcess>().child.lock() {
                        guard.take();
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_secs(3)),
            }

            if app.state::<ServerProcess>().stopping.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

fn stop_server(app: &AppHandle) {
    let state = app.state::<ServerProcess>();
    state.stopping.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
    stop_stale_servers();
}

fn restart_server(app: &AppHandle) {
    let state = app.state::<ServerProcess>();
    state.stopping.store(false, Ordering::SeqCst);
    start_server(app.clone());
}

fn stop_stale_servers() {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/IM", "cctv-server.exe"])
            .output();
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/IM", "cctv-server-x86_64-pc-windows-msvc.exe"])
            .output();
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-Process | Where-Object { $_.ProcessName -like 'cctv-server*' } | Stop-Process -Force -ErrorAction SilentlyContinue",
            ])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "cctv-server"])
            .output();
    }
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let info = update.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
    });
    *pending.0.lock().map_err(|error| error.to_string())? = update;
    Ok(info)
}

#[tauri::command]
async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let Some(update) = pending.0.lock().map_err(|error| error.to_string())?.take() else {
        return Err("No update is ready to install.".into());
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Update download failed: {error}"))?;
    stop_server(&app);
    match update.install(&bytes) {
        Ok(()) => {
            app.restart();
            Ok(())
        }
        Err(error) => {
            restart_server(&app);
            Err(format!("Update installation failed: {error}"))
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            app_version,
            check_update,
            install_update
        ])
        .setup(|app| {
            app.manage(ServerProcess {
                child: Mutex::new(None),
                stopping: AtomicBool::new(false),
            });
            app.manage(PendingUpdate(Mutex::new(None)));
            start_server(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                stop_server(window.app_handle());
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building CCTV Viewer")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}
