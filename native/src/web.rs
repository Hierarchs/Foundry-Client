use crate::{
    core,
    desktop::{MediaRequest, NativeEvent, PopupRequest},
};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};
use tao::{event_loop::EventLoopProxy, window::Window};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
use windows::{
    Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT},
    core::{BOOL, HSTRING, Interface, PWSTR, w},
};
use wry::{
    PermissionResponse, Theme, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    WebViewExtWindows, http::Response,
};

pub const UI_URL: &str = "https://foundry.localhost/index.html";
pub const ADAPTER: &str = concat!(
    include_str!("../../src/performance-adapter.js"),
    "\n",
    include_str!("../../src/foundry-adapter.js")
);

#[derive(Clone)]
pub struct Trust {
    pub hotkeys: Arc<AtomicU32>,
    pub initial: String,
    pub extra: Arc<Mutex<HashSet<String>>>,
    pub media: Arc<AtomicBool>,
}
impl Trust {
    pub fn allowed(&self, url: &str) -> bool {
        self.extra
            .lock()
            .is_ok_and(|origins| core::allowed_navigation(url, &self.initial, &origins))
    }
}

pub fn launcher(
    window: &Window,
    context: &mut WebContext,
    args: String,
    proxy: EventLoopProxy<NativeEvent>,
    hotkeys: Arc<AtomicU32>,
) -> wry::Result<WebView> {
    let rpc_proxy = proxy.clone();
    let view = WebViewBuilder::new_with_web_context(context)
        .with_id("launcher")
        .with_profile_name("launcher")
        .with_additional_browser_args(args)
        .with_https_scheme(true)
        .with_theme(Theme::Dark)
        .with_general_autofill_enabled(false)
        .with_background_color((12, 16, 24, 255))
        .with_custom_protocol("foundry".into(), |_id, request| {
            let (content, mime): (&[u8], &str) = match request.uri().path() {
                "/index.html" => (
                    include_bytes!("../../src/ui/index.html"),
                    "text/html; charset=utf-8",
                ),
                "/styles.css" => (
                    include_bytes!("../../src/ui/styles.css"),
                    "text/css; charset=utf-8",
                ),
                "/app.js" => (
                    include_bytes!("../../src/ui/app.js"),
                    "text/javascript; charset=utf-8",
                ),
                "/mark.svg" => (include_bytes!("../../src/ui/mark.svg"), "image/svg+xml"),
                "/icon.ico" => (include_bytes!("../../src/ui/icon.ico"), "image/x-icon"),
                _ => {
                    return Response::builder()
                        .status(404)
                        .body(Vec::<u8>::new().into())
                        .unwrap();
                }
            };
            Response::builder()
                .header("Content-Type", mime)
                .header("X-Content-Type-Options", "nosniff")
                .body(content.into())
                .unwrap()
        })
        .with_initialization_script(include_str!("bridge.js"))
        .with_ipc_handler(move |request| {
            // Only this local webview gets an IPC handler. Remote pages never get one.
            if request.uri() == UI_URL && request.body().len() <= 65_536 {
                let _ = rpc_proxy.send_event(NativeEvent::Rpc(request.body().clone()));
            }
        })
        .with_navigation_handler(|url| url == UI_URL || url == "foundry://localhost/index.html")
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_devtools(cfg!(feature = "test-driver"))
        .with_url("foundry://localhost/index.html")
        .build_as_child(window)?;
    keyboard(&view, proxy, hotkeys)?;
    Ok(view)
}

pub fn game(
    window: &Window,
    environment: ICoreWebView2Environment,
    profile: &str,
    url: &str,
    trust: Trust,
    generation: u64,
    proxy: EventLoopProxy<NativeEvent>,
) -> wry::Result<WebView> {
    let nav_trust = trust.clone();
    let nav_proxy = proxy.clone();
    let view = WebViewBuilder::new()
        .with_id("game")
        .with_environment(environment)
        .with_profile_name(profile)
        .with_theme(Theme::Dark)
        .with_autoplay(true)
        .with_general_autofill_enabled(false)
        .with_background_color((16, 21, 30, 255))
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_navigation_handler(move |url| {
            if nav_trust.allowed(&url) {
                return true;
            }
            if core::normalize_url(&url).is_ok() {
                let _ = nav_proxy.send_event(NativeEvent::Redirect {
                    generation,
                    popup: None,
                    url,
                });
            }
            false
        })
        .with_devtools(cfg!(feature = "test-driver"))
        .with_url(url)
        .build_as_child(window)?;
    wire(&view, trust, profile.to_owned(), generation, None, proxy)?;
    Ok(view)
}

pub fn wire(
    view: &WebView,
    trust: Trust,
    profile: String,
    generation: u64,
    popup: Option<tao::window::WindowId>,
    proxy: EventLoopProxy<NativeEvent>,
) -> wry::Result<()> {
    keyboard(view, proxy.clone(), trust.hotkeys.clone())?;
    let failed_proxy = proxy.clone();
    if popup.is_none() {
        let loading_proxy = proxy.clone();
        let mut token = 0;
        unsafe {
            view.webview().add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, _| {
                    let _ = loading_proxy.send_event(NativeEvent::Loading(generation));
                    Ok(())
                })),
                &mut token,
            )?;
            view.webview().add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut success = BOOL(0);
                    args.IsSuccess(&mut success)?;
                    let error = if success.as_bool() { None } else {
                        let mut code = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                        args.WebErrorStatus(&mut code)?;
                        Some(format!("Connection failed ({}). Check that your host is running, then retry.", code.0))
                    };
                    let _ = failed_proxy.send_event(NativeEvent::Loaded { generation, error });
                }
                Ok(())
            })), &mut token)?;
        }
    }
    let popup_proxy = proxy.clone();
    let popup_trust = trust.clone();
    let environment = view.environment();
    let mut token = 0;
    unsafe {
        let media_proxy = proxy.clone();
        let media_trust = trust.clone();
        view.webview().add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                if let Ok(options) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    options.SetSavesInProfile(false)?;
                }
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                args.PermissionKind(&mut kind)?;
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let url = take_pwstr(uri);
                if media_trust.media.load(Ordering::Relaxed)
                    && media_trust.allowed(&url)
                    && (kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE)
                {
                    let deferral = args.GetDeferral()?;
                    let _ = media_proxy.send_event(NativeEvent::Media(MediaRequest {
                        generation,
                        origin: core::origin(&url).unwrap_or_default(),
                        args,
                        deferral,
                        allowed: media_trust.media.clone(),
                    }));
                }
                Ok(())
            })),
            &mut token,
        )?;
        // Use a deferral so child windows are constructed outside the WebView2 COM callback.
        view.webview().add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                args.SetHandled(true)?;
                let mut address = PWSTR::null();
                args.Uri(&mut address)?;
                let url = take_pwstr(address);
                let source = sender
                    .and_then(|s| {
                        let mut p = PWSTR::null();
                        s.Source(&mut p).ok()?;
                        Some(take_pwstr(p))
                    })
                    .unwrap_or_default();
                #[cfg(feature = "test-driver")]
                eprintln!("popup request: target={url} source={source}");
                if !(popup_trust.allowed(&source) || (popup.is_some() && source == "about:blank")) {
                    return Ok(());
                }
                if url != "about:blank" && !popup_trust.allowed(&url) {
                    if core::normalize_url(&url).is_ok() {
                        let _ = popup_proxy.send_event(NativeEvent::External(url));
                    }
                    return Ok(());
                }
                let deferral = args.GetDeferral()?;
                let _ = popup_proxy.send_event(NativeEvent::Popup(PopupRequest {
                    generation,
                    name: args
                        .cast::<ICoreWebView2NewWindowRequestedEventArgs2>()
                        .ok()
                        .and_then(|a| {
                            let mut name = PWSTR::null();
                            a.Name(&mut name).ok()?;
                            Some(take_pwstr(name))
                        })
                        .unwrap_or_default(),
                    profile: profile.clone(),
                    environment: environment.clone(),
                    args,
                    deferral,
                    trust: popup_trust.clone(),
                }));
                Ok(())
            })),
            &mut token,
        )?;
        let crash_proxy = proxy.clone();
        view.webview().add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, _| {
                let _ = crash_proxy.send_event(NativeEvent::Loaded {
                    generation,
                    error: Some("The game renderer stopped. Reload the game to reconnect.".into()),
                });
                Ok(())
            })),
            &mut token,
        )?;
        if let Some(id) = popup {
            view.webview().add_WindowCloseRequested(
                &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    let _ = proxy.send_event(NativeEvent::ClosePopup(id));
                    Ok(())
                })),
                &mut token,
            )?;
        }
    }
    Ok(())
}

pub fn keyboard(
    view: &WebView,
    proxy: EventLoopProxy<NativeEvent>,
    hotkeys: Arc<AtomicU32>,
) -> wry::Result<()> {
    let mut token = 0;
    unsafe {
        view.controller().add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                    args.KeyEventKind(&mut kind)?;
                    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                        && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                    {
                        return Ok(());
                    }
                    let mut key = 0;
                    args.VirtualKey(&mut key)?;
                    let ctrl = GetKeyState(VK_CONTROL.0 as i32) < 0;
                    let shift = GetKeyState(VK_SHIFT.0 as i32) < 0;
                    let action = match (key, ctrl, shift) {
                        (0x7A, _, _) => Some("fullscreen"),
                        (key, true, true) if key == hotkeys.load(Ordering::Relaxed) & 255 => {
                            Some("focus")
                        }
                        (key, true, true)
                            if key == (hotkeys.load(Ordering::Relaxed) >> 8) & 255 =>
                        {
                            Some("library")
                        }
                        (0x74, _, _) | (0x52, true, false) => Some("reload"),
                        _ => None,
                    };
                    if let Some(action) = action {
                        args.SetHandled(true)?;
                        let _ = proxy.send_event(NativeEvent::Shortcut(action));
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

pub fn evaluate(
    view: &WebView,
    request: u64,
    script: String,
    proxy: EventLoopProxy<NativeEvent>,
) -> core::Result<()> {
    let params = serde_json::json!({"expression":script,"awaitPromise":true,"returnByValue":true,"timeout":12000}).to_string();
    unsafe {
        view.webview()
            .CallDevToolsProtocolMethod(
                w!("Runtime.evaluate"),
                &HSTRING::from(params),
                &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, response| {
                        let result = status.map_err(|e| e.to_string()).and_then(|_| {
                            let value: serde_json::Value =
                                serde_json::from_str(&response).map_err(|e| e.to_string())?;
                            if let Some(exception) = value.get("exceptionDetails") {
                                return Err(exception["exception"]["description"]
                                    .as_str()
                                    .unwrap_or("The game could not complete this operation.")
                                    .lines()
                                    .next()
                                    .unwrap_or_default()
                                    .chars()
                                    .take(500)
                                    .collect());
                            }
                            Ok(value["result"]["value"].clone())
                        });
                        let _ = proxy.send_event(NativeEvent::Evaluated { request, result });
                        Ok(())
                    },
                )),
            )
            .map_err(|e| e.to_string())
    }
}

pub fn clear_cache(
    view: &WebView,
    request: u64,
    proxy: EventLoopProxy<NativeEvent>,
) -> core::Result<()> {
    unsafe {
        let profile = view
            .webview()
            .cast::<ICoreWebView2_13>()
            .and_then(|v| v.Profile())
            .and_then(|p| p.cast::<ICoreWebView2Profile2>())
            .map_err(|e| e.to_string())?;
        profile
            .ClearBrowsingData(
                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                &ClearBrowsingDataCompletedHandler::create(Box::new(move |status| {
                    let _ = proxy.send_event(NativeEvent::CacheCleared {
                        request,
                        result: status.map_err(|e| e.to_string()),
                    });
                    Ok(())
                })),
            )
            .map_err(|e| e.to_string())
    }
}
