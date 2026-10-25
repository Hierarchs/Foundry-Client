use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;

pub type Result<T> = std::result::Result<T, String>;

pub fn normalize_url(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(|c| c.is_ascii_control() || c == ' ')
    {
        return Err("Enter a valid game join link without spaces or control characters.".into());
    }
    let candidate = if value.contains("://")
        || value.starts_with("javascript:")
        || value.starts_with("data:")
        || value.starts_with("file:")
    {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let url = Url::parse(&candidate).map_err(|_| "That join link is not a valid URL.")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Use an HTTP or HTTPS game join link.".into());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Use a join link without an embedded username or password.".into());
    }
    Ok(url.into())
}

pub fn origin(value: &str) -> Result<String> {
    Url::parse(value)
        .map(|u| u.origin().ascii_serialization())
        .map_err(|_| "Invalid origin.".into())
}
pub fn sqyre(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|h| h == "sqyre.app" || h.ends_with(".sqyre.app"))
}
pub fn allowed_navigation(target: &str, initial: &str, extra: &HashSet<String>) -> bool {
    normalize_url(target).ok().is_some_and(|url| {
        origin(&url)
            .ok()
            .is_some_and(|o| origin(initial).is_ok_and(|i| i == o) || extra.contains(&o))
            || (url.starts_with("https://")
                && initial.starts_with("https://")
                && sqyre(&url)
                && sqyre(initial))
    })
}
pub fn profile_name(url: &str) -> Result<String> {
    let digest = Sha256::digest(origin(url)?.as_bytes());
    Ok(format!("game-{}", &format!("{digest:x}")[..24]))
}
pub fn backup_key(url: &str) -> Result<String> {
    Ok(format!("persist:{}", profile_name(url)?))
}
pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default = "balanced")]
    pub profile: String,
    pub last_joined: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub group: String,
}
fn balanced() -> String {
    "balanced".into()
}
fn yes() -> bool {
    true
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub background_throttle: bool,
    pub keep_awake: bool,
    pub allow_media: bool,
    pub prefer_dedicated_gpu: bool,
    pub auto_check_updates: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            background_throttle: yes(),
            keep_awake: yes(),
            allow_media: false,
            prefer_dedicated_gpu: yes(),
            auto_check_updates: yes(),
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Data {
    pub sessions: Vec<Session>,
    pub preferences: Preferences,
    pub backups: BTreeMap<String, BTreeMap<String, Value>>,
    pub layouts: BTreeMap<String, crate::layouts::Placement>,
    pub playtime: BTreeMap<String, crate::playtime::Record>,
    pub hud: crate::features::Hud,
    pub world_settings: BTreeMap<String, crate::features::WorldSettings>,
    pub recovery: Option<Session>,
}
pub fn profiles() -> Value {
    json!({
        "efficiency": { "name": "Efficiency", "description": "Lighter rendering for laptops and busy scenes.", "settings": { "performanceMode": 0, "maxFPS": 30, "pixelRatioResolutionScaling": false } },
        "balanced": { "name": "Balanced", "description": "A smooth tabletop with moderate visual detail.", "settings": { "performanceMode": 1, "maxFPS": 60, "pixelRatioResolutionScaling": false } },
        "quality": { "name": "Quality", "description": "More visual detail for a capable dedicated GPU.", "settings": { "performanceMode": 2, "maxFPS": 60, "pixelRatioResolutionScaling": true } }
    })
}
pub fn settings_values(value: &Value) -> BTreeMap<String, Value> {
    ["performanceMode", "maxFPS", "pixelRatioResolutionScaling"]
        .into_iter()
        .filter_map(|key| {
            value
                .get(key)
                .filter(|v| {
                    if key == "pixelRatioResolutionScaling" {
                        v.is_boolean()
                    } else {
                        v.is_number()
                    }
                })
                .map(|v| (key.to_owned(), v.clone()))
        })
        .collect()
}

pub struct Store {
    pub data: Data,
    pub warning: Option<String>,
    pub directory: PathBuf,
}
impl Store {
    pub fn load(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let file = directory.join("client-settings.json");
        let mut warning = None;
        let saved: Value = match fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => {
                    fs::copy(
                        &file,
                        directory.join(format!("client-settings.recovery-{}.json", now_millis())),
                    )
                    .map_err(|e| format!("Could not preserve corrupt settings: {e}"))?;
                    warning = Some(
                        "Saved settings could not be read. A recovery copy was preserved.".into(),
                    );
                    json!({})
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e.to_string()),
        };
        let mut data = Data::default();
        let mut ids = HashSet::new();
        if let Some(sessions) = saved["sessions"].as_array() {
            for item in sessions.iter().take(100) {
                if let Ok(mut session) = serde_json::from_value::<Session>(item.clone()) {
                    if session.id.is_empty()
                        || session.id.len() > 80
                        || !session
                            .id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                        || !ids.insert(session.id.clone())
                    {
                        continue;
                    }
                    if let Ok(url) = normalize_url(&session.url) {
                        session.url = url;
                        session.name = session.name.trim().chars().take(80).collect();
                        session.group = session.group.trim().chars().take(40).collect();
                        if session.name.is_empty() {
                            session.name =
                                Url::parse(&session.url).unwrap().host_str().unwrap().into();
                        }
                        if profiles().get(&session.profile).is_none() {
                            session.profile = balanced();
                        }
                        // Invalid legacy timestamps must not break the launcher's date formatter.
                        if session
                            .last_joined
                            .as_ref()
                            .is_some_and(|s| s.len() < 20 || !s.contains('T') || !s.ends_with('Z'))
                        {
                            session.last_joined = None;
                        }
                        data.sessions.push(session);
                    }
                }
            }
        }
        patch_preferences(&mut data.preferences, &saved["preferences"]);
        if let Some(backups) = saved["backups"].as_object() {
            for (key, value) in backups {
                if key.starts_with("persist:game-") && key.len() < 80 {
                    data.backups.insert(key.clone(), settings_values(value));
                }
            }
        }
        if let Some(layouts) = saved["layouts"].as_object() {
            for (key, value) in layouts.iter().take(100) {
                if (key == "main"
                    || (key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())))
                    && let Ok(placement) =
                        serde_json::from_value::<crate::layouts::Placement>(value.clone())
                    && placement.valid()
                {
                    data.layouts.insert(key.clone(), placement);
                }
            }
        }
        if let Some(records) = saved["playtime"].as_object() {
            for (key, value) in records.iter().take(1000) {
                if key.len() == 64
                    && key.chars().all(|c| c.is_ascii_hexdigit())
                    && let Ok(record) =
                        serde_json::from_value::<crate::playtime::Record>(value.clone())
                    && record.valid()
                {
                    data.playtime.insert(key.clone(), record);
                }
            }
        }
        if let Ok(hud) = serde_json::from_value::<crate::features::Hud>(saved["hud"].clone())
            && hud.valid()
        {
            data.hud = hud;
        }
        if let Some(configs) = saved["world_settings"].as_object() {
            for (key, value) in configs.iter().take(1000) {
                if key.len() == 64
                    && key.chars().all(|c| c.is_ascii_hexdigit())
                    && let Ok(mut config) =
                        serde_json::from_value::<crate::features::WorldSettings>(value.clone())
                    && config.valid()
                {
                    config.original =
                        settings_values(&serde_json::to_value(config.original).unwrap());
                    data.world_settings.insert(key.clone(), config);
                }
            }
        }
        if let Ok(mut recovery) = serde_json::from_value::<Session>(saved["recovery"].clone())
            && let Ok(url) = normalize_url(&recovery.url)
        {
            recovery.url = url;
            recovery.name = recovery.name.chars().take(80).collect();
            if profiles().get(&recovery.profile).is_none() {
                recovery.profile = balanced();
            }
            data.recovery = Some(recovery);
        }
        Ok(Self {
            data,
            warning,
            directory,
        })
    }
    pub fn write(&self) -> Result<()> {
        let temporary = self
            .directory
            .join(format!("settings-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(&self.data)?)?;
            file.sync_all()?;
            fs::rename(&temporary, self.directory.join("client-settings.json"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|e| format!("Could not save settings: {e}"))
    }
    pub fn session(&self, input: &Value, use_saved: bool) -> Result<Session> {
        let previous = input["id"]
            .as_str()
            .and_then(|id| self.data.sessions.iter().find(|s| s.id == id));
        if use_saved && let Some(session) = previous {
            return Ok(session.clone());
        }
        let url = normalize_url(input["url"].as_str().unwrap_or_default())?;
        let name: String = input["name"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .chars()
            .take(80)
            .collect();
        let profile = input["profile"]
            .as_str()
            .filter(|p| profiles().get(p).is_some())
            .unwrap_or("balanced");
        Ok(Session {
            id: previous
                .map(|s| s.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: if name.is_empty() {
                Url::parse(&url).unwrap().host_str().unwrap().into()
            } else {
                name
            },
            url,
            profile: profile.into(),
            last_joined: previous.and_then(|s| s.last_joined.clone()),
            favorite: input["favorite"]
                .as_bool()
                .unwrap_or_else(|| previous.is_some_and(|s| s.favorite)),
            group: input["group"]
                .as_str()
                .map(|s| s.trim().chars().take(40).collect())
                .unwrap_or_else(|| previous.map(|s| s.group.clone()).unwrap_or_default()),
        })
    }
    pub fn save(&mut self, input: &Value) -> Result<String> {
        let item = self.session(input, false)?;
        let old = self.data.clone();
        let id = item.id.clone();
        if let Some(index) = self.data.sessions.iter().position(|s| s.id == id) {
            self.data.sessions[index] = item;
        } else {
            if self.data.sessions.len() >= 100 {
                return Err("You can save up to 100 sessions.".into());
            }
            self.data.sessions.push(item);
        }
        if let Err(error) = self.write() {
            self.data = old;
            return Err(error);
        }
        Ok(id)
    }
    pub fn update_preferences(&mut self, input: &Value) -> Result<()> {
        let old = self.data.preferences.clone();
        patch_preferences(&mut self.data.preferences, input);
        if let Err(error) = self.write() {
            self.data.preferences = old;
            return Err(error);
        }
        Ok(())
    }
}
fn patch_preferences(preferences: &mut Preferences, input: &Value) {
    if let Some(v) = input["backgroundThrottle"].as_bool() {
        preferences.background_throttle = v;
    }
    if let Some(v) = input["keepAwake"].as_bool() {
        preferences.keep_awake = v;
    }
    if let Some(v) = input["allowMedia"].as_bool() {
        preferences.allow_media = v;
    }
    if let Some(v) = input["preferDedicatedGpu"].as_bool() {
        preferences.prefer_dedicated_gpu = v;
    }
    if let Some(v) = input["autoCheckUpdates"].as_bool() {
        preferences.auto_check_updates = v;
    }
}
pub fn lock_instance(directory: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options
        .open(directory.join("native-instance.lock"))
        .map_err(|_| {
            "Foundry Client is already running, or its data directory is not writable.".into()
        })
}

/// Import bookmarks/preferences once; keep the Electron store and browser data intact.
pub fn import_legacy(directory: &Path, legacy: &Path) -> Result<bool> {
    let destination = directory.join("client-settings.json");
    if destination.exists() || !legacy.is_file() {
        return Ok(false);
    }
    let mut saved: Value = serde_json::from_slice(&fs::read(legacy).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if !saved.is_object() {
        return Err("The previous settings file does not contain an object.".into());
    }
    // Backups belong to the browser storage in which they were captured.
    saved["backups"] = json!({});
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|e| e.to_string())?;
    output
        .write_all(&serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        std::env::temp_dir().join(format!("foundry-rust-{}", uuid::Uuid::new_v4()))
    }
    fn cleanup(directory: PathBuf) {
        let directory = fs::canonicalize(directory).unwrap();
        assert!(directory.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(
            directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("foundry-rust-")
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn automatic_import_preserves_the_old_store_and_never_overwrites_native_settings() {
        let directory = temporary();
        fs::create_dir_all(&directory).unwrap();
        let legacy = directory.join("old.json");
        let original = json!({"sessions":[{"id":"old","name":"Imported","url":"https://game.example/join?token=kept","profile":"balanced","lastJoined":null}],"preferences":{"keepAwake":false},"backups":{"persist:game-old":{"maxFPS":30}}});
        fs::write(&legacy, original.to_string()).unwrap();
        let native = directory.join("native");
        assert!(import_legacy(&native, &legacy).unwrap());
        let imported = Store::load(native.clone()).unwrap();
        assert_eq!(imported.data.sessions[0].name, "Imported");
        assert!(!imported.data.preferences.keep_awake);
        assert!(imported.data.backups.is_empty());
        assert_eq!(fs::read_to_string(&legacy).unwrap(), original.to_string());
        assert!(!import_legacy(&native, &legacy).unwrap());
        cleanup(directory);
    }
    #[test]
    fn invitation_urls_are_preserved() {
        assert_eq!(
            normalize_url(" a.games.sqyre.app/world/join?invite=private#seat ").unwrap(),
            "https://a.games.sqyre.app/world/join?invite=private#seat"
        );
        assert!(normalize_url("http://127.0.0.1:30000/join").is_ok());
        assert!(normalize_url("http://[::1]:30000").is_ok());
    }
    #[test]
    fn unsafe_links_are_rejected() {
        for value in [
            "javascript:alert(1)",
            "file:///C:/Windows",
            "data:text/plain,test",
            "https://user:pass@host.com",
            "ftp://remote.com",
            "https://exa\nmple.com",
            "https://host/a b",
            "",
        ] {
            assert!(normalize_url(value).is_err(), "{value}");
        }
    }
    #[test]
    fn origins_and_sqyre_lookalikes() {
        let initial = "https://a.games.sqyre.app/join";
        assert!(allowed_navigation(
            "https://www.sqyre.app/login",
            initial,
            &HashSet::new()
        ));
        for target in [
            "https://sqyre.app.evil.com",
            "https://evil-sqyre.app",
            "http://a.games.sqyre.app",
        ] {
            assert!(!allowed_navigation(target, initial, &HashSet::new()));
        }
    }
    #[test]
    fn local_lan_vpn_and_hosted_join_links_are_supported() {
        let cases: Vec<(String, String)> =
            serde_json::from_str(include_str!("../../tests/fixtures/join-links.json")).unwrap();
        for (input, expected) in cases {
            assert_eq!(normalize_url(&input).unwrap(), expected, "{input}");
        }
        let initial = "http://10.8.0.12:30000/foundry/join";
        assert!(allowed_navigation(
            "http://10.8.0.12:30000/foundry/game",
            initial,
            &HashSet::new()
        ));
        assert!(!allowed_navigation(
            "http://10.8.0.13:30000/foundry/game",
            initial,
            &HashSet::new()
        ));
        assert!(!allowed_navigation(
            "http://10.8.0.12:30001/foundry/game",
            initial,
            &HashSet::new()
        ));
        assert!(allowed_navigation(
            "https://login.example.com/",
            initial,
            &HashSet::from(["https://login.example.com".into()])
        ));
        assert_ne!(
            profile_name(initial).unwrap(),
            profile_name("https://10.8.0.12:30000/foundry/join").unwrap()
        );
        let directory = temporary();
        let mut store = Store::load(directory.clone()).unwrap();
        store
            .save(&json!({"url": initial, "name": "VPN game"}))
            .unwrap();
        assert_eq!(
            Store::load(directory.clone()).unwrap().data.sessions[0].url,
            initial
        );
        cleanup(directory);
    }
    #[test]
    fn profiles_isolate_servers_and_match_legacy_cache_keys() {
        assert_eq!(
            profile_name("https://a.example/join?x=1").unwrap(),
            profile_name("https://a.example/world").unwrap()
        );
        assert_ne!(
            profile_name("https://a.example").unwrap(),
            profile_name("https://b.example").unwrap()
        );
        assert!(
            backup_key("https://a.example")
                .unwrap()
                .starts_with("persist:game-")
        );
    }
    #[test]
    fn edits_preferences_and_backups_survive_restart() {
        let directory = temporary();
        let mut store = Store::load(directory.clone()).unwrap();
        let id = store
            .save(&json!({"name":"Friday", "url":"a.games.sqyre.app", "profile":"efficiency"}))
            .unwrap();
        store
            .save(&json!({"id":id, "name":"Friday edited", "url":"b.games.sqyre.app"}))
            .unwrap();
        store
            .update_preferences(&json!({"allowMedia":true,"keepAwake":"false"}))
            .unwrap();
        let key = backup_key("https://b.games.sqyre.app").unwrap();
        store.data.backups.insert(
            key.clone(),
            settings_values(&json!({"maxFPS":60,"worldThing":true})),
        );
        store.write().unwrap();
        let restarted = Store::load(directory.clone()).unwrap();
        assert_eq!(restarted.data.sessions.len(), 1);
        assert_eq!(restarted.data.sessions[0].name, "Friday edited");
        assert!(restarted.data.preferences.allow_media && restarted.data.preferences.keep_awake);
        assert_eq!(restarted.data.backups[&key].len(), 1);
        cleanup(directory);
    }
    #[test]
    fn legacy_settings_import_and_corruption_recovery() {
        let directory = temporary();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("client-settings.json"), r#"{"sessions":[{"id":"old-id","name":"Legacy","url":"https://a.games.sqyre.app","profile":"quality","lastJoined":null}],"preferences":{"backgroundThrottle":false},"backups":{}}"#).unwrap();
        let imported = Store::load(directory.clone()).unwrap();
        assert_eq!(imported.data.sessions[0].id, "old-id");
        assert!(!imported.data.preferences.background_throttle);
        fs::write(directory.join("client-settings.json"), "{broken").unwrap();
        assert!(Store::load(directory.clone()).unwrap().warning.is_some());
        assert!(fs::read_dir(&directory).unwrap().any(|f| {
            f.unwrap()
                .file_name()
                .to_string_lossy()
                .contains("recovery")
        }));
        cleanup(directory);
    }
}
