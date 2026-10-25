use crate::{
    core::{self, Session, Store},
    layouts,
    metrics::Metrics,
    playtime, updates,
    web::{self, Trust},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget},
    window::{Fullscreen, Window, WindowBuilder, WindowId},
};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::Win32::System::Power::{
    ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
};
use wry::{
    MemoryUsageLevel, PermissionResponse, Rect, Theme, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

pub struct PopupRequest {
    pub name: String,
    pub generation: u64,
    pub profile: String,
    pub environment: ICoreWebView2Environment,
    pub args: ICoreWebView2NewWindowRequestedEventArgs,
    pub deferral: ICoreWebView2Deferral,
    pub trust: Trust,
}
pub struct MediaRequest {
    pub generation: u64,
    pub origin: String,
    pub args: ICoreWebView2PermissionRequestedEventArgs,
    pub deferral: ICoreWebView2Deferral,
    pub allowed: Arc<AtomicBool>,
}
pub enum NativeEvent {
    Rpc(String),
    Loading(u64),
    Loaded {
        generation: u64,
        error: Option<String>,
    },
    Redirect {
        generation: u64,
        popup: Option<WindowId>,
        url: String,
    },
    External(String),
    Shortcut(&'static str),
    Popup(PopupRequest),
    ClosePopup(WindowId),
    Media(MediaRequest),
    Evaluated {
        request: u64,
        result: core::Result<Value>,
    },
    CacheCleared {
        request: u64,
        result: core::Result<()>,
    },
}
#[derive(Deserialize)]
struct Rpc {
    id: u64,
    action: String,
    #[serde(default)]
    payload: Value,
}
struct Popup {
    view: WebView,
    _window: Window,
    layout_key: String,
}
enum Work {
    FrameLimit,
    Frame,
    Diagnostic(Value),
    ProfileRead(Option<String>),
    ProfileWrite { key: String, restore: bool },
}
struct Pending {
    generation: u64,
    deadline: Instant,
    work: Work,
}

struct Client {
    ui: WebView,
    game: Option<WebView>,
    popouts: HashMap<WindowId, Popup>,
    cache_view: Option<(u64, WebView)>,
    window: Window,
    store: Store,
    active: Option<Session>,
    active_saved: bool,
    trust: Option<Trust>,
    generation: u64,
    phase: String,
    message: String,
    overlay: bool,
    focus: bool,
    fullscreen: bool,
    awake: bool,
    metrics: Metrics,
    graphics: Value,
    updates: updates::State,
    update_result: Option<std::sync::mpsc::Receiver<core::Result<Option<updates::Release>>>>,
    update_deadline: Option<Instant>,
    pending: HashMap<u64, Pending>,
    layout_deadline: Option<Instant>,
    playtime: playtime::Tracker,
    playtime_tick: Instant,
    playtime_save: Instant,
    playtime_dirty: bool,
    proxy: EventLoopProxy<NativeEvent>,
    testing: bool,
    exiting: bool,
    _instance: std::fs::File,
    _context: WebContext,
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let testing =
        cfg!(feature = "test-driver") && std::env::var("FOUNDRY_CLIENT_TEST").as_deref() == Ok("1");
    let directory = if testing {
        PathBuf::from(std::env::var("FOUNDRY_CLIENT_TEST_USER_DATA")?)
    } else {
        PathBuf::from(std::env::var("APPDATA")?).join("foundry-client/native")
    };
    std::fs::create_dir_all(&directory)?;
    let instance = core::lock_instance(&directory)?;
    let migration = if testing {
        Ok(false)
    } else {
        core::import_legacy(
            &directory,
            &directory.parent().unwrap().join("client-settings.json"),
        )
    };
    let mut store = Store::load(directory.clone())?;
    match migration {
        Ok(true) => store.warning = Some("Saved links and preferences were imported. Sign in again in the new WebView2 client.".into()),
        Err(_) => store.warning = Some("The previous client's saved links could not be imported. Its files have been preserved.".into()),
        _ => (),
    }
    let event_loop = EventLoopBuilder::<NativeEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Foundry Client")
        .with_inner_size(LogicalSize::new(1440., 940.))
        .with_min_inner_size(LogicalSize::new(960., 680.))
        .with_decorations(false)
        .with_theme(Some(tao::window::Theme::Dark))
        .build(&event_loop)?;
    let browser_data = if testing {
        directory.join("WebView2")
    } else {
        PathBuf::from(std::env::var("LOCALAPPDATA")?).join("FoundryClient/WebView2")
    };
    let mut context = WebContext::new(Some(browser_data));
    let mut args = "--autoplay-policy=no-user-gesture-required".to_owned();
    if store.data.preferences.prefer_dedicated_gpu {
        args.push_str(" --force-high-performance-gpu");
    }
    if !store.data.preferences.background_throttle {
        args.push_str(" --disable-background-timer-throttling --disable-renderer-backgrounding");
    }
    if testing {
        let port: u16 = std::env::var("FOUNDRY_CLIENT_DEBUG_PORT")?.parse()?;
        args.push_str(&format!(
            " --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
        ));
    }
    let ui = web::launcher(&window, &mut context, args, proxy.clone())?;
    let mut client = Client {
        ui,
        game: None,
        popouts: HashMap::new(),
        cache_view: None,
        window,
        store,
        active: None,
        active_saved: false,
        trust: None,
        generation: 0,
        phase: "idle".into(),
        message: "Ready when you are.".into(),
        overlay: false,
        focus: false,
        fullscreen: false,
        awake: false,
        metrics: Metrics::new(),
        graphics: json!({"webgl":"pending"}),
        updates: updates::State::new(env!("CARGO_PKG_VERSION")),
        update_result: None,
        update_deadline: None,
        pending: HashMap::new(),
        layout_deadline: None,
        playtime: playtime::Tracker::default(),
        playtime_tick: Instant::now(),
        playtime_save: Instant::now() + Duration::from_secs(60),
        playtime_dirty: false,
        proxy,
        testing,
        exiting: false,
        _instance: instance,
        _context: context,
    };
    if let Some(saved) = client.store.data.layouts.get("main") {
        SelfWindow::restore(&client.window, saved);
    }
    client.layout();
    if client.store.data.preferences.auto_check_updates {
        client.check_updates();
    }
    event_loop.run(move |event, target, flow| {
        let mut deadline = client.pending.values().map(|p| p.deadline).min();
        if client.game.is_some()
            && client.phase != "error"
            && !client.pending.contains_key(&playtime::REQUEST)
        {
            deadline = Some(deadline.map_or(client.playtime_tick, |d| d.min(client.playtime_tick)));
        }
        if client.playtime_dirty {
            deadline = Some(deadline.map_or(client.playtime_save, |d| d.min(client.playtime_save)));
        }
        if let Some(layout) = client.layout_deadline {
            deadline = Some(deadline.map_or(layout, |d| d.min(layout)));
        }
        if client.update_result.is_some() {
            let next = Instant::now() + Duration::from_millis(200);
            deadline = Some(deadline.map_or(next, |d| d.min(next)));
        }
        *flow = deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        match event {
            Event::UserEvent(event) => client.event(event, target),
            Event::WindowEvent {
                window_id, event, ..
            } if window_id == client.window.id() => match event {
                WindowEvent::CloseRequested => {
                    if client.confirm_leave("Close the client and disconnect?") {
                        client.exiting = true;
                    }
                }
                WindowEvent::Moved(_) => client.remember_main(),
                WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Focused(_) => {
                    client.layout();
                    client.power();
                    client.remember_main();
                }
                _ => (),
            },
            Event::WindowEvent {
                window_id, event, ..
            } => {
                if let Some(popup) = client.popouts.get(&window_id) {
                    match event {
                        WindowEvent::CloseRequested => {
                            client.remember_popup(window_id);
                            client.popouts.remove(&window_id);
                        }
                        WindowEvent::Moved(_) => client.remember_popup(window_id),
                        WindowEvent::Resized(size) => {
                            let _ = popup.view.set_bounds(Rect {
                                position: PhysicalPosition::new(0, 0).into(),
                                size: size.into(),
                            });
                            client.remember_popup(window_id);
                        }
                        _ => (),
                    }
                }
            }
            Event::MainEventsCleared => {
                if client.playtime_dirty && Instant::now() >= client.playtime_save {
                    client.save_playtime();
                }
                if client.game.is_some()
                    && client.phase != "error"
                    && Instant::now() >= client.playtime_tick
                    && !client.pending.contains_key(&playtime::REQUEST)
                {
                    client.playtime_tick = Instant::now() + Duration::from_secs(5);
                    if client
                        .begin_script(playtime::REQUEST, playtime::SAMPLE.into(), Work::Frame)
                        .is_err()
                    {
                        client.observe_playtime(None);
                    }
                }
                if client.layout_deadline.is_some_and(|d| Instant::now() >= d) {
                    client.flush_layouts();
                }
                let result = client
                    .update_result
                    .as_ref()
                    .and_then(|r| match r.try_recv() {
                        Ok(value) => Some(value),
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(Err(
                            "The update check could not finish. Please try again.".into(),
                        )),
                        Err(std::sync::mpsc::TryRecvError::Empty) => None,
                    })
                    .or_else(|| {
                        (client.update_result.is_some()
                            && client.update_deadline.is_some_and(|d| Instant::now() >= d))
                        .then(|| Err("The update check timed out. Please try again.".into()))
                    });
                if let Some(result) = result {
                    client.update_result = None;
                    client.update_deadline = None;
                    client.updates.complete(result);
                    client.publish();
                }
                let expired: Vec<_> = client
                    .pending
                    .iter()
                    .filter(|(_, p)| p.deadline <= Instant::now())
                    .map(|(id, _)| *id)
                    .collect();
                for id in expired {
                    client.pending.remove(&id);
                    if id == playtime::REQUEST {
                        client.observe_playtime(None);
                        continue;
                    }
                    client.reply(
                        id,
                        Err("The game took too long to respond. Try reloading it.".into()),
                    );
                }
            }
            Event::LoopDestroyed => {
                client.release();
                client.power();
            }
            _ => (),
        }
        if client.exiting {
            client.remember_main();
            client.release();
            client.power();
            *flow = ControlFlow::Exit;
        }
    });
}

impl Client {
    fn observe_playtime(&mut self, value: Option<Value>) {
        let sample = value.as_ref().and_then(|value| {
            let id = value["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128)?;
            let origin = core::origin(&self.active.as_ref()?.url).ok()?;
            let name = value["name"]
                .as_str()
                .unwrap_or(id)
                .chars()
                .take(100)
                .collect();
            Some((playtime::identity(&origin, id), name))
        });
        self.playtime_dirty |=
            self.playtime
                .observe(Instant::now(), sample, &mut self.store.data.playtime);
        let _ = self.ui.evaluate_script(&format!(
            "window.__clientPlaytime?.({});",
            self.playtime.snapshot(&self.store.data.playtime)
        ));
    }
    fn save_playtime(&mut self) {
        self.playtime_save = Instant::now() + Duration::from_secs(60);
        if self.playtime_dirty {
            match self.store.write() {
                Ok(()) => self.playtime_dirty = false,
                Err(error) => self.store.warning = Some(error),
            }
        }
    }
    fn remember_main(&mut self) {
        if let Some(placement) = SelfWindow::capture(&self.window) {
            self.store.data.layouts.insert("main".into(), placement);
            self.layout_deadline = Some(Instant::now() + Duration::from_millis(500));
        }
    }
    fn remember_popup(&mut self, id: WindowId) {
        if let Some(popup) = self.popouts.get(&id)
            && let Some(placement) = SelfWindow::capture(&popup._window)
        {
            self.store
                .data
                .layouts
                .insert(popup.layout_key.clone(), placement);
            self.layout_deadline = Some(Instant::now() + Duration::from_millis(500));
        }
    }
    fn flush_layouts(&mut self) {
        if self.layout_deadline.take().is_some()
            && let Err(error) = self.store.write()
        {
            self.store.warning = Some(error);
        }
    }
    fn check_updates(&mut self) {
        if self.updates.status == "checking" {
            return;
        }
        self.updates.checking();
        let (sender, receiver) = std::sync::mpsc::channel();
        let endpoint = updates::endpoint(self.testing);
        if let Err(error) = std::thread::Builder::new()
            .name("update-check".into())
            .spawn(move || {
                let _ = sender.send(updates::fetch(&endpoint));
            })
        {
            self.updates
                .complete(Err(format!("Could not start the update check: {error}")));
        } else {
            self.update_result = Some(receiver);
            self.update_deadline = Some(Instant::now() + Duration::from_secs(25));
        }
        self.publish();
    }
    fn snapshot(&self) -> Value {
        let mut active = self
            .active
            .as_ref()
            .map(|a| serde_json::to_value(a).unwrap());
        if !self.active_saved
            && let Some(a) = active.as_mut()
        {
            a["id"] = Value::Null;
        }
        json!({"sessions":self.store.data.sessions,"preferences":self.store.data.preferences,"profiles":core::profiles(),"active":active,
            "status":{"phase":self.phase,"message":self.message},"overlay":self.overlay,"focusMode":self.focus,"warning":self.store.warning,"updates":self.updates,"playtime":self.playtime.snapshot(&self.store.data.playtime),
            "runtime":{"app":env!("CARGO_PKG_VERSION"),"backend":"rust","rust":env!("FOUNDRY_RUST_VERSION"),"engine":"WebView2","chromium":wry::webview_version().unwrap_or_else(|_| "Unknown".into()),"ramGB":self.metrics.ram_gb()}})
    }
    fn publish(&self) {
        let _ = self
            .ui
            .evaluate_script(&format!("window.__clientState?.({});", self.snapshot()));
    }
    fn reply(&self, id: u64, value: core::Result<Value>) {
        let response = match value {
            Ok(result) => json!({"id":id,"result":result}),
            Err(error) => json!({"id":id,"error":error}),
        };
        let _ = self
            .ui
            .evaluate_script(&format!("window.__clientReply?.({response});"));
    }
    fn status(&mut self, phase: &str, message: impl Into<String>) {
        self.phase = phase.into();
        self.message = message.into();
        self.publish();
    }
    fn confirm_leave(&self, message: &str) -> bool {
        self.active.is_none()
            || self.testing
            || rfd::MessageDialog::new()
                .set_title("Foundry Client")
                .set_description(format!("{message}\n\nSave any open work in Foundry first."))
                .set_buttons(rfd::MessageButtons::YesNo)
                .show()
                == rfd::MessageDialogResult::Yes
    }
    fn layout(&self) {
        let size = self.window.inner_size();
        let _ = self.ui.set_bounds(Rect {
            position: PhysicalPosition::new(0, 0).into(),
            size: size.into(),
        });
        let minimized = self.window.is_minimized();
        let level = if minimized && self.store.data.preferences.background_throttle {
            MemoryUsageLevel::Low
        } else {
            MemoryUsageLevel::Normal
        };
        let ui_level = if self.active.is_none() || self.focus {
            MemoryUsageLevel::Low
        } else {
            level
        };
        let _ = self.ui.set_memory_usage_level(ui_level);
        if let Some(game) = &self.game {
            let top = if self.focus {
                0
            } else {
                (52. * self.window.scale_factor()).round() as u32
            };
            let _ = game.set_bounds(Rect {
                position: PhysicalPosition::new(0, top as i32).into(),
                size: PhysicalSize::new(size.width.max(1), size.height.saturating_sub(top).max(1))
                    .into(),
            });
            let _ = game.set_visible(!self.overlay && !minimized);
            let _ = game.set_memory_usage_level(if self.overlay {
                MemoryUsageLevel::Low
            } else {
                level
            });
        }
    }
    fn power(&mut self) {
        let wanted = self.active.is_some()
            && self.store.data.preferences.keep_awake
            && !self.window.is_minimized()
            && !self.exiting;
        if wanted != self.awake {
            unsafe {
                SetThreadExecutionState(if wanted {
                    ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
                } else {
                    ES_CONTINUOUS
                });
            }
            self.awake = wanted;
        }
    }
    fn release(&mut self) {
        self.playtime.reset();
        self.save_playtime();
        self.playtime_tick = Instant::now();
        for id in self.popouts.keys().copied().collect::<Vec<_>>() {
            self.remember_popup(id);
        }
        self.flush_layouts();
        self.popouts.clear();
        self.game = None;
        self.active = None;
        self.trust = None;
        self.overlay = false;
        self.focus = false;
        self.generation += 1;
        let stale: Vec<_> = self.pending.keys().copied().collect();
        self.pending.clear();
        for id in stale {
            if id == playtime::REQUEST {
                continue;
            }
            self.reply(
                id,
                Err("The session changed before this operation finished.".into()),
            );
        }
        self.power();
    }
    fn set_overlay(&mut self, shown: bool) {
        self.overlay = shown;
        if shown {
            self.focus = false;
        }
        self.layout();
        self.publish();
        if !shown && let Some(game) = &self.game {
            let _ = game.focus();
        }
    }
    fn connect(&mut self, input: &Value) -> core::Result<Value> {
        let item = self.store.session(input, true)?;
        if !self.confirm_leave("Disconnect from the current session?") {
            return Ok(self.snapshot());
        }
        self.release();
        let trust = Trust {
            initial: item.url.clone(),
            extra: Arc::new(Mutex::new(HashSet::new())),
            media: Arc::new(AtomicBool::new(self.store.data.preferences.allow_media)),
        };
        let profile = core::profile_name(&item.url)?;
        self.active_saved = input["id"]
            .as_str()
            .is_some_and(|id| self.store.data.sessions.iter().any(|s| s.id == id));
        self.active = Some(item.clone());
        self.trust = Some(trust.clone());
        match web::game(
            &self.window,
            self.ui.environment(),
            &profile,
            &item.url,
            trust,
            self.generation,
            self.proxy.clone(),
        ) {
            Ok(view) => self.game = Some(view),
            Err(e) => {
                self.release();
                return Err(format!("Could not create the game renderer: {e}"));
            }
        }
        if self.active_saved {
            if let Some(saved) = self
                .store
                .data
                .sessions
                .iter_mut()
                .find(|s| s.id == item.id)
            {
                saved.last_joined = time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .ok();
            }
            if let Err(error) = self.store.write() {
                self.store.warning = Some(error);
            }
        }
        self.layout();
        self.power();
        self.status("loading", "Connecting to your table…");
        if let Some(game) = &self.game {
            let _ = game.focus();
        }
        Ok(self.snapshot())
    }
    fn begin_script(&mut self, id: u64, script: String, work: Work) -> core::Result<()> {
        let game = self.game.as_ref().ok_or("Connect to a game first.")?;
        let url = game.url().map_err(|e| e.to_string())?;
        if !self.trust.as_ref().is_some_and(|t| t.allowed(&url)) {
            return Err("The game is not on a trusted server page.".into());
        }
        web::evaluate(game, id, script, self.proxy.clone())?;
        self.pending.insert(
            id,
            Pending {
                generation: self.generation,
                deadline: Instant::now() + Duration::from_secs(15),
                work,
            },
        );
        Ok(())
    }
    fn diagnostics(&mut self, id: u64) -> core::Result<Option<Value>> {
        let mut metrics = self.metrics.sample();
        metrics["gpu"] = self.graphics.clone();
        metrics["foundry"] = Value::Null;
        if self.game.is_some() && self.phase != "error" {
            self.begin_script(
                id,
                format!("(()=>{{{};return readFoundry();}})()", web::ADAPTER),
                Work::Diagnostic(metrics),
            )?;
            Ok(None)
        } else {
            Ok(Some(metrics))
        }
    }
    fn profile(&mut self, id: u64, profile: Option<String>) -> core::Result<()> {
        if self
            .pending
            .values()
            .any(|p| !matches!(p.work, Work::Diagnostic(_) | Work::Frame))
        {
            return Err("Please wait for the current rendering operation to finish.".into());
        }
        if profile
            .as_ref()
            .is_some_and(|p| core::profiles().get(p).is_none())
        {
            return Err("Choose a valid rendering profile.".into());
        }
        self.begin_script(
            id,
            format!("(()=>{{{};return readFoundry();}})()", web::ADAPTER),
            Work::ProfileRead(profile),
        )
    }
    fn evaluated(&mut self, id: u64, result: core::Result<Value>) {
        let Some(pending) = self.pending.remove(&id) else {
            return;
        };
        if pending.generation != self.generation {
            self.reply(id, Err("The session changed.".into()));
            return;
        }
        if id == playtime::REQUEST {
            self.observe_playtime(result.ok());
            return;
        }
        let result = result.and_then(|value| match pending.work {
            Work::FrameLimit => Ok(Some(value)),
            Work::Diagnostic(mut metrics) => {
                metrics["foundry"] = value;
                Ok(Some(metrics))
            }
            Work::Frame => Ok(Some(value)),
            Work::ProfileRead(profile) => {
                if value["ready"] != true {
                    return Err("Join a Foundry world before applying a rendering profile.".into());
                }
                if value["version"]
                    .as_str()
                    .is_none_or(|v| !(v == "14" || v.starts_with("14.")))
                {
                    return Err("Rendering presets currently target Foundry V14.".into());
                }
                let game_url = self
                    .game
                    .as_ref()
                    .unwrap()
                    .url()
                    .map_err(|e| e.to_string())?;
                let key = core::backup_key(&game_url)?;
                let restore = profile.is_none();
                let settings =
                    if let Some(profile) = profile {
                        let baseline = self.store.data.backups.entry(key.clone()).or_default();
                        for (name, original) in core::settings_values(&value["settings"]) {
                            baseline.entry(name).or_insert(original);
                        }
                        self.store.write()?;
                        core::profiles()[profile]["settings"].clone()
                    } else {
                        serde_json::to_value(
                            self.store.data.backups.get(&key).ok_or(
                                "No original rendering settings are saved for this server.",
                            )?,
                        )
                        .map_err(|e| e.to_string())?
                    };
                self.begin_script(
                    id,
                    format!(
                        "(async()=>{{{};return await changeFoundrySettings({},{});}})()",
                        web::ADAPTER,
                        settings,
                        restore
                    ),
                    Work::ProfileWrite { key, restore },
                )?;
                Ok(None)
            }
            Work::ProfileWrite { key, restore } => {
                if restore {
                    if let Some(backup) = self.store.data.backups.get_mut(&key) {
                        if let Some(applied) = value["applied"].as_array() {
                            for key in applied.iter().filter_map(Value::as_str) {
                                backup.remove(key);
                            }
                        }
                        if backup.is_empty() {
                            self.store.data.backups.remove(&key);
                        }
                    }
                    self.store.write()?;
                }
                Ok(Some(value))
            }
        });
        match result {
            Ok(Some(value)) => self.reply(id, Ok(value)),
            Ok(None) => (),
            Err(error) => self.reply(id, Err(error)),
        }
    }
    fn cache(&mut self, id: u64, session_id: &Value) -> core::Result<()> {
        if self.cache_view.is_some() {
            return Err("A cache operation is already running.".into());
        }
        let saved = self
            .store
            .data
            .sessions
            .iter()
            .find(|s| Some(s.id.as_str()) == session_id.as_str())
            .ok_or("Select a saved session first.")?;
        let profile = core::profile_name(&saved.url)?;
        if self
            .active
            .as_ref()
            .is_some_and(|s| core::profile_name(&s.url).is_ok_and(|p| p == profile))
        {
            return Err("Disconnect from this server before clearing its asset cache.".into());
        }
        let view = WebViewBuilder::new()
            .with_environment(self.ui.environment())
            .with_profile_name(profile)
            .with_visible(false)
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_url("about:blank")
            .build_as_child(&self.window)
            .map_err(|e| e.to_string())?;
        web::clear_cache(&view, id, self.proxy.clone())?;
        self.cache_view = Some((id, view));
        Ok(())
    }
    fn command(&mut self, request: &Rpc) -> core::Result<Option<Value>> {
        let input = &request.payload;
        let value = match request.action.as_str() {
            #[cfg(feature = "test-driver")]
            "test-layout" if self.testing => {
                if input.is_object()
                    && let Some(popup) = self.popouts.values().next()
                {
                    let mut p = SelfWindow::capture(&popup._window).ok_or("No normal pop-out.")?;
                    p.x = 160;
                    p.y = 120;
                    p.width = 760;
                    p.height = 500;
                    SelfWindow::apply(&popup._window, &p);
                }
                json!(
                    self.popouts
                        .values()
                        .map(|p| SelfWindow::capture(&p._window))
                        .collect::<Vec<_>>()
                )
            }
            "frame-limit" => {
                if self
                    .pending
                    .values()
                    .any(|p| !matches!(p.work, Work::Diagnostic(_) | Work::Frame))
                {
                    return Err("Wait for the current rendering operation to finish.".into());
                }
                if !input.is_null()
                    && ![0, 30, 60, 90, 120, 144, 165, 180, 240]
                        .iter()
                        .any(|n| input == *n)
                {
                    return Err("Choose a supported FPS limit.".into());
                }
                self.begin_script(
                    request.id,
                    format!(
                        "(()=>{{{};return changeFrameLimit({input});}})()",
                        web::ADAPTER
                    ),
                    Work::FrameLimit,
                )?;
                return Ok(None);
            }
            "gather-windows" => {
                for popup in self.popouts.values() {
                    let mut placement = SelfWindow::capture(&popup._window)
                        .ok_or("Restore minimized windows first.")?;
                    let screen =
                        SelfWindow::screen(&self.window).ok_or("No display is available.")?;
                    placement.monitor = screen.name.clone();
                    placement.monitor_x = screen.x;
                    placement.x = screen.x;
                    placement.monitor_y = screen.y;
                    placement.y = screen.y;
                    if let Some(fit) = placement.fit(&[screen]) {
                        SelfWindow::apply(&popup._window, &fit);
                    }
                }
                json!(true)
            }
            "check-updates" => {
                self.check_updates();
                self.snapshot()
            }
            "open-update" => {
                let url = self
                    .updates
                    .link(input.as_str().ok_or("Choose an update link.")?)?;
                if !self.testing {
                    webbrowser::open(url).map_err(|e| e.to_string())?;
                }
                json!(url)
            }
            "state" => self.snapshot(),
            "save" => {
                let id = self.store.save(input)?;
                self.publish();
                let mut result = self.snapshot();
                result["savedId"] = json!(id);
                result
            }
            "remove" => {
                let id = input.as_str().ok_or("Invalid session.")?;
                let old = self.store.data.clone();
                self.store.data.sessions.retain(|s| s.id != id);
                if let Err(error) = self.store.write() {
                    self.store.data = old;
                    return Err(error);
                }
                self.publish();
                self.snapshot()
            }
            "connect" => self.connect(input)?,
            "disconnect" => {
                if self.confirm_leave("Disconnect from the current session?") {
                    self.release();
                    self.status("idle", "Ready when you are.");
                }
                self.snapshot()
            }
            "overlay" => {
                self.set_overlay(input.as_bool().unwrap_or(false));
                self.snapshot()
            }
            "preferences" => {
                self.store.update_preferences(input)?;
                if let Some(trust) = &self.trust {
                    trust
                        .media
                        .store(self.store.data.preferences.allow_media, Ordering::Relaxed);
                }
                self.layout();
                self.power();
                self.publish();
                self.snapshot()
            }
            "diagnostics" => return self.diagnostics(request.id),
            "frame" => {
                self.begin_script(request.id, "(()=>{const fps=globalThis.canvas?.app?.ticker?.FPS;return typeof fps==='number'&&Number.isFinite(fps)?Math.round(fps):null;})()".into(), Work::Frame)?;
                return Ok(None);
            }
            "graphics" => {
                let renderer = input["renderer"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase();
                let hardware = input["webgl2"] == true
                    && !["swiftshader", "llvmpipe", "basic render", "software"]
                        .iter()
                        .any(|s| renderer.contains(s));
                self.graphics =
                    json!({"webgl":if hardware{"enabled"}else{"software_or_unavailable"}});
                Value::Bool(hardware)
            }
            "profile" => {
                self.profile(
                    request.id,
                    Some(
                        input
                            .as_str()
                            .ok_or("Choose a valid rendering profile.")?
                            .into(),
                    ),
                )?;
                return Ok(None);
            }
            "restore" => {
                self.profile(request.id, None)?;
                return Ok(None);
            }
            "cache" => {
                self.cache(request.id, input)?;
                return Ok(None);
            }
            "reload" => {
                self.game
                    .as_ref()
                    .ok_or("Connect to a game first.")?
                    .reload()
                    .map_err(|e| e.to_string())?;
                self.set_overlay(false);
                self.snapshot()
            }
            "focus" => {
                if self.game.is_some() {
                    self.overlay = false;
                    self.focus = !self.focus;
                    self.layout();
                    self.publish();
                }
                self.snapshot()
            }
            "fullscreen" => {
                self.fullscreen = !self.fullscreen;
                self.window
                    .set_fullscreen(self.fullscreen.then_some(Fullscreen::Borderless(None)));
                self.snapshot()
            }
            "sqyre" => {
                webbrowser::open("https://www.sqyre.app/").map_err(|e| e.to_string())?;
                Value::Null
            }
            "minimize" => {
                self.window.set_minimized(true);
                Value::Null
            }
            "maximize" => {
                self.window.set_maximized(!self.window.is_maximized());
                Value::Null
            }
            "drag" => {
                let _ = self.window.drag_window();
                Value::Null
            }
            "close" => {
                if self.confirm_leave("Close the client and disconnect?") {
                    self.exiting = true;
                }
                Value::Null
            }
            _ => return Err("Unknown client action.".into()),
        };
        Ok(Some(value))
    }
    fn event(&mut self, event: NativeEvent, target: &EventLoopWindowTarget<NativeEvent>) {
        match event {
            NativeEvent::Rpc(body) => {
                if let Ok(request) = serde_json::from_str::<Rpc>(&body) {
                    if request.id > 9_007_199_254_740_991 {
                        return;
                    }
                    match self.command(&request) {
                        Ok(Some(value)) => self.reply(request.id, Ok(value)),
                        Ok(None) => (),
                        Err(error) => self.reply(request.id, Err(error)),
                    }
                }
            }
            NativeEvent::Loading(generation) if generation == self.generation => {
                self.observe_playtime(None);
                self.status("loading", "Connecting to your table…")
            }
            NativeEvent::Loaded { generation, error } if generation == self.generation => {
                if let Some(error) = error {
                    self.observe_playtime(None);
                    self.overlay = true;
                    self.focus = false;
                    self.layout();
                    self.status("error", error);
                } else {
                    self.playtime_tick = Instant::now();
                    self.status("connected", "Game page loaded");
                }
            }
            NativeEvent::Evaluated { request, result } => self.evaluated(request, result),
            NativeEvent::CacheCleared { request, result } => {
                if self
                    .cache_view
                    .as_ref()
                    .is_some_and(|(id, _)| *id == request)
                {
                    self.cache_view = None;
                    self.reply(request, result.map(|_| Value::Bool(true)));
                }
            }
            NativeEvent::Shortcut(action) => {
                if action == "library" {
                    self.set_overlay(true);
                    let _ = self.ui.evaluate_script(
                        "document.querySelector('[data-page=\"sessions\"]')?.click();",
                    );
                    let _ = self.ui.focus();
                } else {
                    let _ = self.command(&Rpc {
                        id: 0,
                        action: action.into(),
                        payload: Value::Null,
                    });
                }
            }
            NativeEvent::Redirect {
                generation,
                popup,
                url,
            } if generation == self.generation => {
                let Some(trust) = &self.trust else {
                    return;
                };
                let Ok(origin) = core::origin(&url) else {
                    return;
                };
                if rfd::MessageDialog::new().set_title("Game sign-in redirect").set_description(format!("Allow this game to navigate to {origin}?\n\nAllow only if this is part of your host’s sign-in flow."))
                    .set_buttons(rfd::MessageButtons::YesNo).show()==rfd::MessageDialogResult::Yes{
                    if let Ok(mut extra)=trust.extra.lock(){extra.insert(origin);}
                    if let Some(id)=popup{if let Some(popup)=self.popouts.get(&id){let _=popup.view.load_url(&url);}}else if let Some(game)=&self.game{let _=game.load_url(&url);}
                }
            }
            NativeEvent::External(url) => {
                if let Ok(url) = core::normalize_url(&url) {
                    let origin = core::origin(&url).unwrap_or_default();
                    if rfd::MessageDialog::new()
                        .set_title("Open a link")
                        .set_description(format!("Open {origin} in your default browser?"))
                        .set_buttons(rfd::MessageButtons::YesNo)
                        .show()
                        == rfd::MessageDialogResult::Yes
                    {
                        let _ = webbrowser::open(&url);
                    }
                }
            }
            NativeEvent::Popup(request) => {
                #[cfg(feature = "test-driver")]
                eprintln!("creating popup generation {}", request.generation);
                if request.generation == self.generation
                    && let Err(error) = self.popup(&request, target)
                {
                    #[cfg(feature = "test-driver")]
                    eprintln!("popup error: {error}");
                    self.status("error", format!("The pop-out could not open: {error}"));
                }
                unsafe {
                    let _ = request.deferral.Complete();
                }
            }
            NativeEvent::ClosePopup(id) => {
                self.remember_popup(id);
                self.popouts.remove(&id);
            }
            NativeEvent::Media(request) => {
                let allowed = request.generation == self.generation
                    && request.allowed.load(Ordering::Relaxed)
                    && rfd::MessageDialog::new()
                        .set_title("Camera and microphone")
                        .set_description(format!(
                            "Allow {} to use your camera or microphone?",
                            request.origin
                        ))
                        .set_buttons(rfd::MessageButtons::YesNo)
                        .show()
                        == rfd::MessageDialogResult::Yes;
                unsafe {
                    let _ = request.args.SetState(if allowed {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DENY
                    });
                    let _ = request.deferral.Complete();
                }
            }
            _ => (),
        }
    }
    fn popup(
        &mut self,
        request: &PopupRequest,
        target: &EventLoopWindowTarget<NativeEvent>,
    ) -> core::Result<()> {
        let url = self
            .active
            .as_ref()
            .ok_or("Connect to a game first.")?
            .url
            .as_str();
        let layout_key = (0..64)
            .map(|slot| layouts::key(url, &request.name, slot))
            .find(|key| !self.popouts.values().any(|p| p.layout_key == *key))
            .ok_or("Close an unused pop-out first.")?;
        let window = WindowBuilder::new()
            .with_title("Foundry · Pop-out")
            .with_inner_size(LogicalSize::new(1000., 760.))
            .with_theme(Some(tao::window::Theme::Dark))
            .build(target)
            .map_err(|e| e.to_string())?;
        if let Some(saved) = self.store.data.layouts.get(&layout_key) {
            SelfWindow::restore(&window, saved);
        }
        let id = window.id();
        let nav_trust = request.trust.clone();
        let nav_proxy = self.proxy.clone();
        let generation = self.generation;
        let view = WebViewBuilder::new()
            .with_environment(request.environment.clone())
            .with_profile_name(request.profile.clone())
            .with_theme(Theme::Dark)
            .with_background_color((16, 21, 30, 255))
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_navigation_handler(move |url| {
                if url == "about:blank" || nav_trust.allowed(&url) {
                    true
                } else {
                    if core::normalize_url(&url).is_ok() {
                        let _ = nav_proxy.send_event(NativeEvent::Redirect {
                            generation,
                            popup: Some(id),
                            url,
                        });
                    }
                    false
                }
            })
            .with_devtools(cfg!(feature = "test-driver"))
            .with_url("about:blank")
            .build(&window)
            .map_err(|e| e.to_string())?;
        web::wire(
            &view,
            request.trust.clone(),
            request.profile.clone(),
            generation,
            Some(id),
            self.proxy.clone(),
        )
        .map_err(|e| e.to_string())?;
        unsafe {
            request
                .args
                .SetNewWindow(&view.webview())
                .map_err(|e| e.to_string())?;
        }
        self.popouts.insert(
            id,
            Popup {
                view,
                _window: window,
                layout_key,
            },
        );
        #[cfg(feature = "test-driver")]
        eprintln!("popup attached, total={}", self.popouts.len());
        Ok(())
    }
}

struct SelfWindow;
impl SelfWindow {
    fn screen(window: &Window) -> Option<layouts::Screen> {
        let m = window
            .current_monitor()
            .or_else(|| window.primary_monitor())?;
        Some(layouts::Screen {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
            name: m.name(),
        })
    }
    fn capture(window: &Window) -> Option<layouts::Placement> {
        if window.is_minimized() || window.is_maximized() || window.fullscreen().is_some() {
            return None;
        }
        let position = window.outer_position().ok()?;
        let size = window.inner_size();
        let m = Self::screen(window)?;
        let saved = layouts::Placement {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            scale: window.scale_factor(),
            monitor: m.name,
            monitor_x: m.x,
            monitor_y: m.y,
        };
        saved.valid().then_some(saved)
    }
    fn apply(window: &Window, p: &layouts::Placement) {
        window.set_minimized(false);
        window.set_maximized(false);
        window.set_inner_size(PhysicalSize::new(p.width, p.height));
        window.set_outer_position(PhysicalPosition::new(p.x, p.y));
    }
    fn restore(window: &Window, p: &layouts::Placement) {
        let mut monitors: Vec<_> = window.available_monitors().collect();
        let primary = window.primary_monitor();
        monitors.sort_by_key(|m| Some(m.clone()) != primary);
        let screens: Vec<_> = monitors
            .into_iter()
            .map(|m| layouts::Screen {
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
                scale: m.scale_factor(),
                name: m.name(),
            })
            .collect();
        if let Some(p) = p.fit(&screens) {
            Self::apply(window, &p);
        }
    }
}
