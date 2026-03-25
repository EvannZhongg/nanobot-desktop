use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, menu::{Menu, MenuItem, PredefinedMenuItem}, Runtime};
use crate::{ProcState, refresh_child, stop_all_processes, kill_matching_processes};

/// Initializes the system tray with status menu items and a background polling task.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let agent_status = MenuItem::with_id(app, "agent_status", "Working: Status...", false, None::<&str>)?;
    let gateway_status = MenuItem::with_id(app, "gateway_status", "Routing: Status...", false, None::<&str>)?;
    
    let tray_menu = {
        let sep = PredefinedMenuItem::separator(app)?;
        let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
        let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        Menu::with_items(app, &[&agent_status, &gateway_status, &sep, &show, &hide, &quit])?
    };

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(tray_menu))?;
        tray.on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<Arc<Mutex<ProcState>>>() {
                    let s = state.inner().clone();
                    stop_all_processes(&s);
                }
                kill_matching_processes("agent");
                kill_matching_processes("gateway");
                app.exit(0);
            }
            _ => {}
        });
        
        tray.on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button, button_state, .. } = event {
                if button == tauri::tray::MouseButton::Left && button_state == tauri::tray::MouseButtonState::Up {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
    }

    let state_handle = app.state::<Arc<Mutex<ProcState>>>().inner().clone();
    let agent_item = agent_status.clone();
    let gateway_item = gateway_status.clone();

    // Background task to update tray menu with real-time status
    tauri::async_runtime::spawn(async move {
        loop {
            let (agent_running, gateway_running) = {
                if let Ok(mut guard) = state_handle.lock() {
                    let agent = refresh_child(&mut guard.agent);
                    let gateway = refresh_child(&mut guard.gateway);
                    (agent, gateway)
                } else {
                    (false, false)
                }
            };

            let agent_text = if agent_running { "Working: Running" } else { "Working: Stopped" };
            let gateway_text = if gateway_running { "Routing: Connected" } else { "Routing: Disconnected" };

            let _ = agent_item.set_text(agent_text);
            let _ = gateway_item.set_text(gateway_text);
            
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });

    Ok(())
}
