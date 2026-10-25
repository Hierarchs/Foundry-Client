use crate::core::{self, Result, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const WORLD_REQUEST: u64 = u64::MAX - 1;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Hud {
    pub show_fps: bool,
    pub show_time: bool,
    pub show_title: bool,
    pub compact: bool,
    pub focus_key: String,
    pub library_key: String,
}
impl Default for Hud {
    fn default() -> Self {
        Self {
            show_fps: true,
            show_time: true,
            show_title: true,
            compact: false,
            focus_key: "F".into(),
            library_key: "L".into(),
        }
    }
}
impl Hud {
    pub fn valid(&self) -> bool {
        matches!(self.focus_key.as_str(), "F" | "H")
            && matches!(self.library_key.as_str(), "L" | "O")
    }
    pub fn keys(&self) -> u32 {
        (self.focus_key.as_bytes()[0] as u32) | ((self.library_key.as_bytes()[0] as u32) << 8)
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSettings {
    pub profile: Option<String>,
    pub fps: Option<u32>,
    #[serde(default)]
    pub original: BTreeMap<String, Value>,
    #[serde(default)]
    pub original_fps: Option<f64>,
}
impl WorldSettings {
    pub fn valid(&self) -> bool {
        if self
            .original_fps
            .is_some_and(|fps| !fps.is_finite() || !(0.0..=1000.0).contains(&fps))
        {
            return false;
        }
        self.profile
            .as_ref()
            .is_none_or(|p| core::profiles().get(p).is_some())
            && self
                .fps
                .is_none_or(|v| [0, 30, 60, 90, 120, 144, 165, 180, 240].contains(&v))
            && (self.profile.is_some() || self.fps.is_some())
    }
}
impl Store {
    pub fn update_hud(&mut self, input: &Value) -> Result<()> {
        let mut value = serde_json::to_value(&self.data.hud).unwrap();
        let input = input.as_object().ok_or("Invalid HUD preferences.")?;
        for (key, setting) in input {
            if value.get(key).is_some() {
                value[key] = setting.clone();
            }
        }
        let hud: Hud = serde_json::from_value(value).map_err(|_| "Invalid HUD preferences.")?;
        if !hud.valid() {
            return Err("Choose a listed keyboard shortcut.".into());
        }
        let old = self.data.hud.clone();
        self.data.hud = hud;
        if let Err(error) = self.write() {
            self.data.hud = old;
            return Err(error);
        }
        Ok(())
    }
    pub fn organize(&mut self, input: &Value) -> Result<()> {
        let previous = self
            .data
            .sessions
            .iter()
            .find(|s| Some(s.id.as_str()) == input["id"].as_str())
            .ok_or("Select a saved session.")?;
        let mut value = serde_json::to_value(previous).unwrap();
        for key in ["favorite", "group"] {
            if input.get(key).is_some() {
                value[key] = input[key].clone();
            }
        }
        self.save(&value)?;
        Ok(())
    }
    pub fn export_sessions(&self) -> Value {
        json!({"format":"foundry-client-sessions","version":1,"sessions":self.data.sessions.iter().map(|s|json!({"name":s.name,"url":s.url,"profile":s.profile,"group":s.group,"favorite":s.favorite})).collect::<Vec<_>>()})
    }
    pub fn import_sessions(&mut self, value: &Value) -> Result<usize> {
        if value["format"] != "foundry-client-sessions" || value["version"] != 1 {
            return Err("Choose a Foundry Client session export.".into());
        }
        let entries = value["sessions"]
            .as_array()
            .filter(|v| v.len() <= 100)
            .ok_or("Import up to 100 saved sessions.")?;
        let mut sessions = self.data.sessions.clone();
        let mut added = 0;
        for entry in entries {
            if !entry.is_object() {
                return Err("Each imported session must be an object.".into());
            }
            let mut clean = entry.clone();
            clean["id"] = Value::Null;
            let item = self.session(&clean, false)?;
            if sessions
                .iter()
                .any(|s| s.url == item.url && s.name == item.name)
            {
                continue;
            }
            if sessions.len() >= 100 {
                return Err("The import would exceed 100 sessions.".into());
            }
            sessions.push(item);
            added += 1;
        }
        let old = std::mem::replace(&mut self.data.sessions, sessions);
        if let Err(error) = self.write() {
            self.data.sessions = old;
            return Err(error);
        }
        Ok(added)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn organization_import_validation_and_hud_preferences_survive_restart() {
        let dir = std::env::temp_dir().join(format!("foundry-features-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir.clone()).unwrap();
        let id=store.save(&json!({"url":"http://10.0.0.1:30000","name":"Campaign","group":"Friday","favorite":true})).unwrap();
        store
            .save(&json!({"id":id,"url":"http://10.0.0.1:30000","name":"Edited"}))
            .unwrap();
        assert!(store.data.sessions[0].favorite);
        assert_eq!(store.data.sessions[0].group, "Friday");
        store
            .update_hud(&json!({"compact":true,"showTime":false,"focusKey":"H"}))
            .unwrap();
        assert!(store.update_hud(&json!({"focusKey":"Escape"})).is_err());
        let export = store.export_sessions();
        assert_eq!(store.import_sessions(&export).unwrap(), 0);
        let bad = json!({"format":"foundry-client-sessions","version":1,"sessions":[{"url":"https://valid.example"},{"url":"file:///C:/Windows"}]});
        assert!(store.import_sessions(&bad).is_err());
        assert_eq!(store.data.sessions.len(), 1);
        let mut alternative = store.export_sessions();
        alternative["sessions"][0]["name"] = json!("Alternative bookmark");
        assert_eq!(store.import_sessions(&alternative).unwrap(), 1);
        assert_eq!(
            store.export_sessions()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let loaded = Store::load(dir.clone()).unwrap();
        assert!(loaded.data.hud.compact);
        assert!(!loaded.data.hud.show_time);
        assert_eq!(loaded.data.sessions[0].group, "Friday");
        let dir = std::fs::canonicalize(dir).unwrap();
        assert!(dir.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(
            dir.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("foundry-features-")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
