use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

pub const REQUEST: u64 = u64::MAX;
pub const SAMPLE: &str = "(()=>{const g=globalThis.game;if(!g?.ready||!g.world?.id||g.socket?.connected===false)return null;return {id:String(g.world.id).slice(0,128),name:String(g.world.title||g.world.id).slice(0,100)};})()";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub name: String,
    pub milliseconds: u64,
}
impl Record {
    pub fn valid(&self) -> bool {
        self.name.len() <= 512 && self.milliseconds <= 3_155_760_000_000
    }
}
#[derive(Default)]
pub struct Tracker {
    last: Option<(String, Instant)>,
    world: Option<String>,
    name: Option<String>,
    session_ms: u64,
}
pub fn identity(origin: &str, world: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{origin}\0{world}").as_bytes())
    )
}
impl Tracker {
    pub fn observe(
        &mut self,
        now: Instant,
        sample: Option<(String, String)>,
        records: &mut BTreeMap<String, Record>,
    ) -> bool {
        let Some((key, name)) = sample else {
            self.last = None;
            return false;
        };
        let mut changed = false;
        if let Some((previous, at)) = &self.last
            && previous == &key
        {
            let elapsed = now.saturating_duration_since(*at);
            // A long gap means sleep, suspension, or a stalled renderer.
            if elapsed <= Duration::from_secs(15)
                && let Some(record) = records.get_mut(&key)
            {
                let ms = elapsed.as_millis() as u64;
                record.milliseconds = record.milliseconds.saturating_add(ms);
                self.session_ms = self.session_ms.saturating_add(ms);
                changed = ms > 0;
            }
        }
        if self.world.as_ref() != Some(&key) {
            self.session_ms = 0;
        }
        let record = records.entry(key.clone()).or_insert_with(|| {
            changed = true;
            Record {
                name: name.clone(),
                milliseconds: 0,
            }
        });
        if record.name != name {
            record.name = name.clone();
            changed = true;
        }
        self.world = Some(key.clone());
        self.name = Some(name);
        self.last = Some((key, now));
        changed
    }
    pub fn reset(&mut self) {
        self.last = None;
        self.world = None;
        self.name = None;
        self.session_ms = 0;
    }
    pub fn snapshot(&self, records: &BTreeMap<String, Record>) -> Value {
        let mut worlds: Vec<_> = records
            .values()
            .map(|r| json!({"name":r.name,"seconds":r.milliseconds/1000}))
            .collect();
        worlds.sort_by_key(|v| std::cmp::Reverse(v["seconds"].as_u64().unwrap_or(0)));
        let total = records
            .values()
            .fold(0_u64, |sum, r| sum.saturating_add(r.milliseconds));
        json!({"tracking":self.last.is_some(),"world":self.name,"sessionSeconds":self.session_ms/1000,"totalSeconds":total/1000,"worlds":worlds})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_confirmed_loaded_intervals_count_and_sleep_is_excluded() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        let mut records = BTreeMap::new();
        let sample = Some((identity("https://server", "world"), "World".into()));
        assert!(!tracker.observe(now, None, &mut records));
        tracker.observe(now, sample.clone(), &mut records);
        tracker.observe(now + Duration::from_secs(5), sample.clone(), &mut records);
        assert_eq!(tracker.snapshot(&records)["totalSeconds"], 5);
        tracker.observe(now + Duration::from_secs(10), None, &mut records);
        tracker.observe(now + Duration::from_secs(30), sample.clone(), &mut records);
        tracker.observe(now + Duration::from_secs(35), sample.clone(), &mut records);
        assert_eq!(tracker.snapshot(&records)["totalSeconds"], 10);
        tracker.observe(
            now + Duration::from_secs(3600),
            sample.clone(),
            &mut records,
        );
        assert_eq!(tracker.snapshot(&records)["totalSeconds"], 10);
        tracker.observe(now + Duration::from_secs(3605), sample, &mut records);
        assert_eq!(tracker.snapshot(&records)["totalSeconds"], 15);
        tracker.reset();
        assert_eq!(tracker.snapshot(&records)["sessionSeconds"], 0);
        assert_eq!(tracker.snapshot(&records)["totalSeconds"], 15);
        let loaded: BTreeMap<String, Record> =
            serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
        assert_eq!(loaded.values().next().unwrap().milliseconds, 15000);
        assert_ne!(
            identity("https://server", "world"),
            identity("https://other", "world")
        );
    }
}
