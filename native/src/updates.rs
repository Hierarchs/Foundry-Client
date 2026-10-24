use crate::core::Result;
use semver::Version;
use serde::{Deserialize, Serialize};

pub const RELEASES_URL: &str = "https://github.com/Hierarchs/Foundry-Client/releases";
const ENDPOINT: &str = "https://api.github.com/repos/Hierarchs/Foundry-Client/releases/latest";
const MAX_RESPONSE: usize = 1_048_576;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub release_url: String,
    pub download_url: Option<String>,
    pub download_label: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub status: String,
    pub message: String,
    pub current_version: String,
    pub last_checked: Option<String>,
    pub release: Option<Release>,
}
impl State {
    pub fn new(current: &str) -> Self {
        Self {
            status: "idle".into(),
            message: "Check for a newer version of Foundry Client.".into(),
            current_version: current.into(),
            last_checked: None,
            release: None,
        }
    }
    pub fn checking(&mut self) {
        self.status = "checking".into();
        self.message = "Checking for updates…".into();
    }
    pub fn complete(&mut self, result: Result<Option<Release>>) {
        self.last_checked = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .ok();
        match result {
            Ok(Some(release)) => {
                let latest = Version::parse(&release.version).unwrap();
                let current = Version::parse(&self.current_version).unwrap();
                if latest.cmp_precedence(&current).is_gt() {
                    self.status = "available".into();
                    self.message = format!("Foundry Client {} is available.", release.version);
                } else {
                    self.status = "upToDate".into();
                    self.message = if latest.cmp_precedence(&current).is_lt() {
                        "You’re using a newer build than the latest public release.".into()
                    } else {
                        "You’re up to date.".into()
                    };
                }
                self.release = Some(release);
            }
            Ok(None) => {
                self.status = "noRelease".into();
                self.message =
                    "No public stable release was found. Check the releases page for downloads."
                        .into();
                self.release = None;
            }
            Err(message) => {
                self.status = "error".into();
                self.message = message;
                self.release = None;
            }
        }
    }
    pub fn link(&self, kind: &str) -> Result<&str> {
        match kind {
            "releases" => Ok(RELEASES_URL),
            "release" => self
                .release
                .as_ref()
                .map(|r| r.release_url.as_str())
                .ok_or("Check for updates first.".into()),
            "download" if self.status == "available" => self
                .release
                .as_ref()
                .and_then(|r| r.download_url.as_deref())
                .ok_or("This release has no Windows download yet.".into()),
            _ => Err("Choose an available update link.".into()),
        }
    }
}
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    state: String,
}

pub fn interpret_response(status: u32, body: &[u8]) -> Result<Option<Release>> {
    match status {
        404 => return Ok(None),
        403 | 429 => return Err("GitHub is limiting update checks. Please try again later.".into()),
        200 => (),
        _ => return Err("The update service is unavailable. Please try again later.".into()),
    }
    if body.len() > MAX_RESPONSE {
        return Err("The update service returned an oversized response.".into());
    }
    let release: GitHubRelease = serde_json::from_slice(body)
        .map_err(|_| "The update service returned invalid release information.")?;
    if release.tag_name.len() > 128 {
        return Err("The release has an unsupported version tag.".into());
    }
    let version = Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .map_err(|_| "The release has an unsupported version tag.")?;
    if release.draft || release.prerelease || !version.pre.is_empty() {
        return Ok(None);
    }
    let base = format!("{RELEASES_URL}/download/{}", release.tag_name);
    let mut download_url = None;
    let mut download_label = String::new();
    for (name, label) in [
        (
            format!("Foundry-Client-Rust-Setup-{version}-x64.exe"),
            "Download installer",
        ),
        (
            format!("Foundry-Client-Rust-{version}-x64.zip"),
            "Download portable ZIP",
        ),
    ] {
        let expected = format!("{base}/{name}");
        if release
            .assets
            .iter()
            .any(|a| a.name == name && a.state == "uploaded" && a.browser_download_url == expected)
        {
            download_url = Some(expected);
            download_label = label.into();
            break;
        }
    }
    Ok(Some(Release {
        version: version.to_string(),
        release_url: format!("{RELEASES_URL}/tag/{}", release.tag_name),
        download_url,
        download_label,
    }))
}

pub fn endpoint(testing: bool) -> String {
    if cfg!(feature = "test-driver")
        && testing
        && let Ok(value) = std::env::var("FOUNDRY_CLIENT_UPDATE_TEST_URL")
        && let Ok(url) = url::Url::parse(&value)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
        && url.username().is_empty()
        && url.password().is_none()
    {
        return url.into();
    }
    ENDPOINT.into()
}

// Runs on a short-lived worker, never the UI event loop. This HTTP session
// shares no game cookies, credentials, or session URLs.
#[cfg(windows)]
pub fn fetch(endpoint: &str) -> Result<Option<Release>> {
    use std::{
        ffi::c_void,
        ptr,
        time::{Duration, Instant},
    };
    use windows::{
        Win32::Networking::WinHttp::*,
        core::{HSTRING, PCWSTR, w},
    };
    struct Handle(*mut c_void);
    impl Handle {
        fn new(value: *mut c_void) -> windows::core::Result<Self> {
            if value.is_null() {
                Err(windows::core::Error::from_thread())
            } else {
                Ok(Self(value))
            }
        }
    }
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
    let request = || -> Result<Option<Release>> {
        let start = Instant::now();
        let url = url::Url::parse(endpoint).map_err(|_| "Invalid update endpoint.")?;
        let host = HSTRING::from(url.host_str().ok_or("Invalid update host.")?);
        let agent = HSTRING::from(format!("Foundry-Client/{}", env!("CARGO_PKG_VERSION")));
        let path = HSTRING::from(&url[url::Position::BeforePath..url::Position::AfterQuery]);
        unsafe {
            let session = Handle::new(WinHttpOpen(
                &agent,
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                PCWSTR::null(),
                PCWSTR::null(),
                0,
            ))
            .map_err(|e| e.to_string())?;
            WinHttpSetTimeouts(session.0, 3000, 5000, 5000, 5000).map_err(|e| e.to_string())?;
            let connection = Handle::new(WinHttpConnect(
                session.0,
                &host,
                url.port_or_known_default().ok_or("Invalid update port.")?,
                0,
            ))
            .map_err(|e| e.to_string())?;
            let flags = if url.scheme() == "https" {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            };
            let handle = Handle::new(WinHttpOpenRequest(
                connection.0,
                w!("GET"),
                &path,
                PCWSTR::null(),
                PCWSTR::null(),
                ptr::null(),
                flags,
            ))
            .map_err(|e| e.to_string())?;
            let disabled = WINHTTP_DISABLE_REDIRECTS
                | WINHTTP_DISABLE_COOKIES
                | WINHTTP_DISABLE_AUTHENTICATION;
            WinHttpSetOption(
                Some(handle.0),
                WINHTTP_OPTION_DISABLE_FEATURE,
                Some(&disabled.to_ne_bytes()),
            )
            .map_err(|e| e.to_string())?;
            let headers: Vec<u16> =
                "Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2026-03-10\r\n"
                    .encode_utf16()
                    .collect();
            WinHttpSendRequest(handle.0, Some(&headers), None, 0, 0, 0)
                .map_err(|e| e.to_string())?;
            WinHttpReceiveResponse(handle.0, ptr::null_mut()).map_err(|e| e.to_string())?;
            let mut status = 0_u32;
            let mut size = size_of::<u32>() as u32;
            WinHttpQueryHeaders(
                handle.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some((&mut status as *mut u32).cast()),
                &mut size,
                ptr::null_mut(),
            )
            .map_err(|e| e.to_string())?;
            if status != 200 {
                return interpret_response(status, &[]);
            }
            let mut body = Vec::new();
            loop {
                if start.elapsed() > Duration::from_secs(20) {
                    return Err("The update check timed out. Please try again.".into());
                }
                let mut buffer = [0_u8; 8192];
                let mut read = 0;
                WinHttpReadData(
                    handle.0,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut read,
                )
                .map_err(|e| e.to_string())?;
                if read == 0 {
                    break;
                }
                if body.len() + read as usize > MAX_RESPONSE {
                    return Err("The update service returned an oversized response.".into());
                }
                body.extend_from_slice(&buffer[..read as usize]);
            }
            interpret_response(status, &body)
        }
    };
    request().map_err(|error| {
        if error.contains("0x") {
            "Could not check for updates. Check your connection and try again.".into()
        } else {
            error
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn release(tag: &str) -> serde_json::Value {
        json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":[]})
    }
    #[test]
    fn semantic_versions_never_offer_a_downgrade() {
        for (current, latest, expected) in [
            ("0.2.2", "v0.10.0", "available"),
            ("0.10.0", "v0.2.2", "upToDate"),
            ("0.2.2", "0.2.2", "upToDate"),
            ("0.2.2+local", "v0.2.2+other", "upToDate"),
        ] {
            let mut state = State::new(current);
            state.complete(interpret_response(
                200,
                release(latest).to_string().as_bytes(),
            ));
            assert_eq!(state.status, expected);
            assert!(state.last_checked.is_some());
            assert!(state.link("download").is_err());
        }
    }
    #[test]
    fn prereleases_missing_releases_and_errors_are_distinct() {
        for key in ["draft", "prerelease"] {
            let mut value = release("v1.0.0");
            value[key] = json!(true);
            assert!(
                interpret_response(200, value.to_string().as_bytes())
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            interpret_response(200, release("v1.0.0-beta.1").to_string().as_bytes())
                .unwrap()
                .is_none()
        );
        assert!(interpret_response(404, b"{}").unwrap().is_none());
        for status in [403, 429, 500, 302] {
            assert!(interpret_response(status, b"{}").is_err());
        }
        assert!(interpret_response(200, b"not json").is_err());
        assert!(interpret_response(200, release("bad-tag").to_string().as_bytes()).is_err());
        assert!(interpret_response(200, &vec![b' '; MAX_RESPONSE + 1]).is_err());
        let mut state = State::new("0.2.2");
        state.complete(interpret_response(404, b"{}"));
        assert_eq!(state.status, "noRelease");
        state.complete(Err("Offline".into()));
        assert_eq!(state.status, "error");
    }
    #[test]
    fn downloads_must_be_uploaded_matching_assets_from_this_repository() {
        let mut value = release("v0.3.0");
        let name = "Foundry-Client-Rust-Setup-0.3.0-x64.exe";
        let expected = format!("{RELEASES_URL}/download/v0.3.0/{name}");
        for target in [
            "file:///C:/evil.exe",
            "https://github.com.evil.test/evil.exe",
            "https://github.com/Other/Repo/releases/download/v0.3.0/evil.exe",
            "https://github.com/Hierarchs/Foundry-Client/releases/download/v0.2.1/old.exe",
        ] {
            value["assets"] =
                json!([{"name":name,"state":"uploaded","browser_download_url":target}]);
            assert!(
                interpret_response(200, value.to_string().as_bytes())
                    .unwrap()
                    .unwrap()
                    .download_url
                    .is_none()
            );
        }
        value["html_url"] = json!("file:///C:/evil.exe");
        value["assets"] = json!([{"name":name,"state":"uploaded","browser_download_url":expected}]);
        let mut state = State::new("0.2.2");
        state.complete(interpret_response(200, value.to_string().as_bytes()));
        assert_eq!(state.link("download").unwrap(), expected);
        assert_eq!(
            state.link("release").unwrap(),
            format!("{RELEASES_URL}/tag/v0.3.0")
        );
        assert!(state.link("file:///C:/evil.exe").is_err());
        value["assets"][0]["state"] = json!("new");
        assert!(
            interpret_response(200, value.to_string().as_bytes())
                .unwrap()
                .unwrap()
                .download_url
                .is_none()
        );
    }
}
