use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub monitor: Option<String>,
    pub monitor_x: i32,
    pub monitor_y: i32,
}
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub name: Option<String>,
}
pub fn key(url: &str, name: &str, slot: usize) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{url}\0{name}\0{slot}").as_bytes())
    )
}
impl Placement {
    pub fn valid(&self) -> bool {
        (100..=32768).contains(&self.width)
            && (100..=32768).contains(&self.height)
            && self.scale.is_finite()
            && (0.5..=8.).contains(&self.scale)
            && self.monitor.as_ref().is_none_or(|s| s.len() <= 256)
    }
    pub fn fit(&self, screens: &[Screen]) -> Option<Self> {
        let screen = screens
            .iter()
            .find(|m| self.monitor.is_some() && m.name == self.monitor)
            .or_else(|| {
                screens.iter().find(|m| {
                    self.x as i64 >= m.x as i64
                        && (self.x as i64) < m.x as i64 + m.width as i64
                        && self.y as i64 >= m.y as i64
                        && (self.y as i64) < m.y as i64 + m.height as i64
                })
            })
            .or_else(|| screens.first())?;
        let ratio = screen.scale / self.scale;
        let width = ((self.width as f64 * ratio).round() as u32).clamp(
            320.min(screen.width.saturating_sub(32).max(1)),
            screen.width.saturating_sub(32).max(1),
        );
        let height = ((self.height as f64 * ratio).round() as u32).clamp(
            240.min(screen.height.saturating_sub(96).max(1)),
            screen.height.saturating_sub(96).max(1),
        );
        let x = screen.x as i64
            + ((self.x as i64 - self.monitor_x as i64) as f64 * ratio).round() as i64;
        let y = screen.y as i64
            + ((self.y as i64 - self.monitor_y as i64) as f64 * ratio).round() as i64;
        Some(Self {
            x: x.clamp(
                screen.x as i64 + 8,
                screen.x as i64 + (screen.width - width).max(8) as i64,
            ) as i32,
            y: y.clamp(
                screen.y as i64 + 8,
                screen.y as i64 + (screen.height - height).max(8) as i64,
            ) as i32,
            width,
            height,
            scale: screen.scale,
            monitor: screen.name.clone(),
            monitor_x: screen.x,
            monitor_y: screen.y,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_displays_negative_coordinates_and_dpi_changes_stay_reachable() {
        let saved = Placement {
            x: -1800,
            y: 100,
            width: 900,
            height: 600,
            scale: 1.,
            monitor: Some("left".into()),
            monitor_x: -1920,
            monitor_y: 0,
        };
        let screens = [
            Screen {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.,
                name: Some("main".into()),
            },
            Screen {
                x: -2560,
                y: 0,
                width: 2560,
                height: 1440,
                scale: 1.5,
                name: Some("left".into()),
            },
        ];
        let left = saved.fit(&screens).unwrap();
        assert_eq!(left.x, -2380);
        assert_eq!(left.width, 1350);
        let fallback = saved.fit(&screens[..1]).unwrap();
        assert!(fallback.x >= 0 && fallback.x + fallback.width as i32 <= 1920);
        assert!(fallback.y >= 0 && fallback.y + fallback.height as i32 <= 1080);
        assert!(saved.fit(&[]).is_none());
        assert_ne!(
            key("https://a/game", "sheet", 0),
            key("https://a/game", "sheet", 1)
        );
        let invalid = Placement {
            scale: f64::NAN,
            ..saved
        };
        assert!(!invalid.valid());
    }
}
