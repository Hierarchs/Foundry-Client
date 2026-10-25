# Foundry Client — Rust edition

A dedicated **Windows 10/11 x64 client for Foundry Virtual Tabletop V14**, including games hosted on **Sqyre**. Version 0.2 replaces the Electron/Node desktop host with Rust and uses Microsoft's installed **Evergreen WebView2** renderer. The launcher remains lightweight HTML/CSS/JavaScript embedded in the executable.

## Run it

Download/extract the portable archive from `release/rust/`, then run **Foundry Client.exe**. Alternatively, use **Foundry-Client-Rust-Setup-0.5.0-x64.exe**. The installer creates separate Rust-edition shortcuts and leaves an existing Electron installation intact.

1. Start your game on Sqyre and copy its **game join link**.
2. Paste it into **Join a session**, optionally name it, and click **Join session**.
3. Keep **Save to my session library** checked to return later. Use **New session** to add different links.
4. Sign in through your host / Foundry as usual.
5. After joining a world, open **Performance** to apply a rendering profile.

This application is a client for an existing server. It does not include or host Foundry, start Sqyre servers, or bundle licensed game content. A hosting dashboard URL is not necessarily a game join link. Authentication providers that prohibit embedded browsers may need additional integration; logging in through an external browser does not automatically transfer its cookies into this client.

**Microsoft Edge WebView2 Runtime is required.** It is normally present on modern Windows installations; [download it from Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if needed. Rust, Node.js, and Visual Studio are not required to run the compiled client. These builds are unsigned. The Rust client checks for updates and opens downloads for manual installation; WebView2 receives its own Microsoft updates.

## Update checker

Open **Preferences → Client updates** to check manually, see the installed version and last check time, read release notes, or open a newer Windows download. **Check for updates on startup** is enabled by default and can be turned off. Available versions appear in a banner in the launcher; checks do not open dialogs or interrupt a game.

The Rust host queries this repository's [latest public stable GitHub release](https://github.com/Hierarchs/Foundry-Client/releases) on a background worker using Windows networking. It compares semantic versions, ignores drafts/prereleases, and never offers a downgrade. Missing releases, offline errors, and rate limits have separate messages. Requests use no game cookies, invitation links, account tokens, or authentication. The request has bounded response size, timeouts, certificate validation, and no automatic redirects. Only matching Windows assets hosted under this repository's release URL can become download buttons.

Downloads open in the default browser. Close the client before running the new installer, or extract the portable ZIP and run its executable. Saved sessions and browser profiles remain in their existing user-data folders. The checker does not automatically install or execute downloaded files. This feature belongs to the Rust edition; the retained Electron comparison host does not check for updates.

### Publishing updates

The checker reads public stable GitHub releases. If none are available, it reports **No public stable release was found**. A source commit or Actions artifact alone is not an update feed.

For a future release, synchronize the versions in `package.json`, `package-lock.json`, `native/Cargo.toml`, and `native/Cargo.lock`, commit the tested source, and push a matching `vX.Y.Z` Git tag. The workflow verifies/builds Windows, creates a draft release with the executable, installer, portable ZIP, license notices and SHA-256 hashes, then publishes it as the latest release after uploads finish. A mismatched tag is rejected. The publishing job alone has release-write permissions. Do not move an already-published version tag; use a new version for fixes.

## Connection compatibility

Version 0.2.1 accepts **HTTP and HTTPS** game join URLs without a hosting-provider or IP-address allowlist:

| Server type | Example join URL |
| --- | --- |
| Local server | `http://localhost:30000/join` |
| LAN address or hostname | `http://192.168.1.42:30000/join`, `http://foundry-pc:30000/join` |
| VPN address or DNS name | `http://10.8.0.12:30000/join`, `http://game.example-tailnet.ts.net:30000/join` |
| Public IPv4 / IPv6 | `http://203.0.113.42:30000/join`, `http://[2001:db8::42]:30000/join` |
| HTTPS / reverse proxy | `https://foundry.example.org:34443/table/join?invite=kept#seat` |
| Hosted Foundry game | Paste the full game join URL supplied by the provider |

Use the full URL, including `http://` or `https://` and any required port. Links without a protocol default to HTTPS. Ports, reverse-proxy paths, invitation queries, and fragments are retained. IPv6 addresses use square brackets when included in a URL.

[Foundry's hosting partners](https://foundryvtt.com/article/partnerships/) include Sqyre, The Forge, Molten Hosting, and Foundry Server. Their standard game join URLs are accepted; sign-in redirects to other origins ask for confirmation. The client uses the PC's normal network and DNS configuration, including an already-connected VPN. The server must be reachable through that network. It does not set up a VPN or port forwarding.

HTTPS certificate validation remains enabled. Camera, microphone, and other secure-context browser features can be unavailable on non-local HTTP servers. The connection test suite covers a real HTTP game fixture outside the previous localhost allowlist and a shared URL matrix covering LAN, VPN, IPv4, IPv6, HTTPS, and provider-style links. Authenticated sessions on each provider and a real VPN still need live compatibility testing.

## What Rust changes

- Removes the Electron/Node host and the Chromium runtime bundled with the old application. The Rust release executable is about **1.6 MiB**, excluding the separately installed WebView2 runtime and dependency notices.
- Uses one WebView2 environment with isolated browser profiles per server origin. Switching sessions drops the old game view and its pop-outs while retaining cached assets and supported login cookies.
- Uses Rust for URL validation, atomic settings writes, window lifetime, cache clearing, diagnostics, and rendering-profile backups.
- Uses an event loop that sleeps when idle. Full process diagnostics run only when requested. Gameplay FPS, connection status, playtime and adaptive FPS share one lightweight sample, without scanning processes.
- Requests the dedicated GPU when enabled. Hardware acceleration, browser sandboxing, certificate verification, and GPU safety checks remain enabled.
- Requests lower WebView2 memory targets for inactive views and minimized windows, including unfocused pop-outs. Focused gameplay keeps its normal memory target.

### Measured limits

The saved [comparison report](benchmarks/host-overhead.json) uses three alternating runs per backend, fresh profiles, the same launcher, and a local static WebGL 2 test page. Each scenario takes five samples after warming up. These are medians of run medians on the development PC:

| Summed process working set | Electron baseline | Rust / WebView2 |
| --- | ---: | ---: |
| Launcher | 363 MiB | 396 MiB |
| Local WebGL test page | 465 MiB | 469 MiB |

**The rewrite does not establish a RAM or FPS improvement.** The clear measured benefit is the much smaller application distribution. Loaded-page memory was approximately unchanged; launcher memory was higher. The report includes frequent diagnostic sampling, attached test tooling, different Chromium runtime versions, and shared memory pages that may be counted more than once. It is not a Foundry gameplay benchmark. Actual scene performance still depends on the GPU, maps, modules, animations, network, and host.

## Rendering controls

### Adaptive FPS and pop-out memory

Version 0.5.0 adds **Preferences → Performance behavior**. **Adaptive FPS** is opt-in. It applies a 15, 30 (default), or 60 FPS idle ceiling after 30 seconds without mouse/keyboard input, when the game loses focus, or while the game is hidden. Input/focus restores the active target, including 240 FPS or uncapped. The idle ceiling never raises a lower active target. Manual FPS changes, rendering profiles and remembered world settings update that active target while idle. Turning adaptive FPS off restores it and removes its input listeners and timer. Scene changes use the new canvas's target unless remembered world settings reapply a chosen limit.

**Economize inactive pop-outs** is enabled by default. Unfocused, hidden or minimized pop-outs request WebView2's lower memory target; focusing them restores the normal target. This is a browser memory request, not a fixed RAM limit. Scripts and connections are not suspended. Disable the preference if switching between many sheets feels less responsive. The behavior follows [Microsoft's WebView2 performance guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance). Actual savings depend on the browser and the loaded content.

### Lighter telemetry

The Rust host installs its bundled sampling helper once per document and reuses it. Playtime, connection status, adaptive FPS and the optional HUD FPS reading use one sample every five seconds, increasing to once every 2.5 seconds while the gameplay FPS display is visible. Hidden HUDs and minimized windows use the slower interval. The gameplay HUD no longer runs a separate diagnostics timer. Full process memory/CPU scans remain limited to the visible Performance page and explicit requests.

Playtime history is sent with periodic samples only while its Preferences panel is open. Hidden history rows are not rebuilt, unchanged session/cache/runtime lists retain their existing elements, and HUD text changes only when its value changes. These changes reduce the client's own work; real Foundry scene FPS and RAM gains have not been measured.

### Remembered world settings

In the Rust edition, join a V14 world and open **Performance → Remember this world**. Choose a rendering profile and/or FPS target, then click **Save and apply**. Only the checked choices are remembered. They are stored per server origin and world ID and reapplied on world entry, reload, and Foundry's public `canvasReady` scene event. **Forget and restore original** removes the saved choices and restores the values captured before the first remembered change. Original values are written locally before changes are made. Reload if Foundry requests it. Remembered choices take precedence over the session bookmark's suggested profile.

### Customizable HUD

**Preferences → HUD preferences** controls the FPS button, playtime display, game title, and compact spacing. Choose **Ctrl+Shift+F** or **Ctrl+Shift+H** to hide/restore the HUD and **Ctrl+Shift+L** or **Ctrl+Shift+O** for the library. Changes apply immediately to the main game and pop-outs and survive restart. **Reset HUD preferences** restores the original layout and shortcuts. Fullscreen remains **F11**. Reconnection controls remain available when the connection is lost.

### Reconnect and recovery

When a loaded world's socket disconnects, the HUD shows **Connection lost** and a **Reconnect** button. Foundry can reconnect itself; the button explicitly reloads the game if needed. The client does not automatically reload over unsaved work. The connection status is checked with the shared playtime/FPS sample, without extra diagnostic scans.

An active-session marker is saved on connection and cleared on normal disconnect or close. After an unexpected client exit, the launcher offers **Recover session** or **Dismiss**. Recovery reopens the prior join link in its existing browser profile; it does not bypass sign-in or recover unsaved Foundry form edits. It requires a click rather than connecting automatically.

### Session organization

Use session search, **Favorites only**, and the group filter in the library. Star a session to place it first, and set its group while adding or editing it. **Export sessions** saves a JSON file with names, join links, profiles, favorites, and groups. **Import sessions** validates the whole file before merging it; identical name-and-URL bookmarks are skipped, while different named bookmarks for one server are preserved. Existing entries are not overwritten. Imports are limited to 100 total sessions and 1 MB. Browser cookies, playtime, and world settings are not exported. Exported join links can contain private invitation tokens; share those files deliberately.

Version 0.3.0 adds **Canvas FPS limit** in Performance: 30, 60, 90, 120, 144, 165, 180, 240, and uncapped. Apply it after joining a V14 world. It changes the live canvas ticker through PixiJS's public `maxFPS` property, rather than writing values beyond Foundry's registered settings range. **Restore FPS limit** restores the original ticker value. The override applies to the loaded canvas; scene changes, reloads, or graphics changes may reset it. It does not change stored Foundry settings or disable browser synchronization. Actual FPS depends on the display, scene, and GPU; 240 FPS is a target, not a guaranteed result. [PixiJS ticker documentation](https://pixijs.com/8.x/guides/components/ticker).

## Time played

Version 0.3.1 adds **Preferences → Time played**, showing a cumulative total, the current connection, and a breakdown by Foundry world. A compact timer also appears in the game toolbar. It starts only after a world reports `game.ready` with a world ID, and pauses when the socket disconnects or the client leaves the game. Loaded games continue counting while minimized or while viewing client preferences. Login/setup screens do not count. Counters are local to this Windows user and keyed by server origin plus world ID.

The Rust host samples the loaded game every five seconds (2.5 seconds while the FPS HUD is monitoring) without process diagnostics. Only intervals between two successful, connected samples count; transitions can undercount by a few seconds. Long gaps from computer sleep or suspension are discarded. Totals are saved every minute and on normal disconnect/exit, so an unexpected process termination may lose up to a minute. **Ctrl+Shift+F** restores a hidden client toolbar, **Ctrl+Shift+L** opens the library, and **F11** toggles fullscreen.

## Multi-monitor layouts

Move the main window and Foundry pop-outs to your preferred monitors. Normal window positions and sizes are saved automatically, with writes debounced while moving/resizing. When you reopen the client or a pop-out, its saved placement is adjusted for the current displays and DPI scaling. Missing displays fall back to an available monitor, with the window kept on screen. Maximized/fullscreen/minimized states do not replace the saved normal geometry.

Named pop-outs are matched by their window name and session join link; unnamed windows use opening order. Reopen sheets through Foundry to restore them—the client does not automatically open game documents. **Preferences → Multi-monitor layout → Bring pop-outs to this monitor** moves open normal pop-outs onto the main window's display. Real Foundry sheet compatibility and physical monitor hot-plug testing remain to be verified; native reopen/restart restoration and simulated monitor/DPI changes are tested.

## Foundry rendering presets

Presets use only registered Foundry V14 **client** settings. Choosing a preset in the launcher stores a preference; it takes effect only after clicking **Apply to current world**.

| Profile | Foundry quality | FPS cap | Pixel ratio scaling |
| --- | --- | ---: | --- |
| Efficiency | Low | 30 | Off |
| Balanced | Medium | 60 | Off |
| Quality | High | 60 | On |

Original values are saved before the first change and can be restored across a client restart. Unsupported settings are skipped. No world settings or other players' settings are changed. Reload if Foundry requests it. These controls are shared with the retained Electron adapter and tested against asynchronous setting changes.

The Performance page hides the game, which can pause its rendering. Use **FPS** in the game toolbar to measure during play. Canvas ticker FPS is not an end-to-end presentation benchmark.

| Action | Shortcut |
| --- | --- |
| Fullscreen | F11 |
| Hide / restore toolbar | Ctrl+Shift+F |
| Session library | Ctrl+Shift+L |

The library can stay open while the game remains connected. **Disconnect** releases the game view. Foundry same-origin and blank-document pop-outs retain their opener and server profile. Camera/microphone requests require enabling the preference and approving a native permission prompt. Background throttling and GPU preference changes require a restart; the screen-awake and memory-target choices update immediately.

## Saved sessions and migration

On first launch, the Rust edition imports saved links and preferences from the previous Electron file, without changing it:

- Previous store: `%APPDATA%/foundry-client/client-settings.json`
- Rust store: `%APPDATA%/foundry-client/native/client-settings.json`
- Native browser profiles/cache: `%LOCALAPPDATA%/FoundryClient/WebView2/`

Browser logins and Foundry browser settings use the new WebView2 profiles, so sign in again and apply the desired rendering preset. Old rendering backups belong to the old browser and remain in its store; new native backups are captured before changing the new browser's settings. Import happens once and never overwrites an existing native store.

Complete join URLs, including paths, invitation tokens, and fragments, are retained. Links are private local bookmarks saved in plain text. Different origins have separate login and asset storage; worlds on the same origin share it. Clearing **Asset cache** removes only the selected profile's disk cache, preserving login storage and settings. Corrupt settings are preserved in recovery copies.

## Development and verification

Install stable Rust, Visual Studio C++ build tools with a Windows SDK, and WebView2. Node.js 24+ is used for the development/test/package scripts. The frontend needs no compilation or framework.

```powershell
npm ci
npm start                 # Rust app
npm run build             # Optimized native release, no test driver
npm run test:rust         # Native validation/storage/migration tests
npm test                  # Shared adapter and legacy compatibility unit tests
npm run check             # JavaScript syntax checks
npm run test:e2e          # Real Rust app + local integration fixture
npm run dist              # Rust executable, installer, portable zip, notices, hashes
```

The wrapper script finds Cargo in `%USERPROFILE%/.cargo/bin` if the current shell has not refreshed PATH. Cargo can also be used directly:

```powershell
cargo build --manifest-path native/Cargo.toml --release --locked
cargo test --manifest-path native/Cargo.toml --locked
```

Release builds use optimization, thin LTO, a static C runtime, and stripped symbols. The `test-driver` Cargo feature enables local-only CDP test controls; **production packaging builds without it**. Native integration checks cover migrated sessions, multiple links, WebGL 2, no game IPC/Node bridge, asynchronous presets, restart restore, persistent cookies, pop-outs, cache retention, and unreachable-host recovery. They use a mock world, not licensed Foundry code. A real V14 world on Sqyre is still needed for host/module compatibility verification.

The GitHub workflow builds Rust artifacts and runs syntax checks, shared unit tests, native unit tests, formatting, and Clippy. Native GUI integration tests require a Windows desktop session and WebGL-capable renderer and are run locally. The Electron implementation is retained for comparisons and compatibility checks:

```powershell
npm run start:electron
npm run test:electron
# Optimized native test-driver binary for the repeatable overhead comparison:
cargo build --manifest-path native/Cargo.toml --release --features test-driver --locked
$env:FOUNDRY_NATIVE_TEST_EXE = (Resolve-Path native/target/release/foundry-client.exe).Path
npm run benchmark
# Build production again before distributing:
npm run dist
```

## Remote-content isolation

Only the embedded local launcher has an IPC handler, validated against its exact local origin. Game pages and pop-outs get no Node runtime, custom IPC handler, filesystem bridge, or host objects. Native code executes only fixed, bundled Foundry adapter scripts in the game. External links and new sign-in origins require a native confirmation. HTTP and HTTPS join URLs are accepted; a change of scheme, host, or port changes the origin. Sqyre's automatic cross-subdomain navigation is limited to HTTPS. OS commands and custom-protocol URLs cannot be launched by game links. Test debugging ports and test data overrides are unavailable in a normal production build.

## References

- [Foundry requirements](https://foundryvtt.com/article/requirements/)
- [Foundry settings](https://foundryvtt.com/article/settings/)
- [Foundry V14 client-settings API](https://foundryvtt.com/api/v14/classes/foundry.helpers.ClientSettings.html)
- [WebView2 performance guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)
- [Wry native webview documentation](https://docs.rs/wry/latest/wry/)

Independent project; not affiliated with Foundry Gaming, LLC or Sqyre. Names and trademarks belong to their respective owners. Dependency license notices are included with the distribution.
