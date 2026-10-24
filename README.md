# Foundry Client

A dedicated Windows desktop client for **Foundry Virtual Tabletop V14**, including games hosted on **Sqyre**. Paste any game's join link, save multiple sessions, and switch between them from your library.

This is a client for an existing server. You still start and manage your hosted game on Sqyre. No Foundry server, license, system, module, or game content is bundled.

## Play

1. Open **Foundry Client** (the portable `.exe` or installed app).
2. Start the world on Sqyre and copy its **game join link**. A hosting dashboard URL is not the game join link.
3. Paste the link under **Join a session**. Give it a name if you want, and keep **Save to my session library** checked to return later.
4. Click **Join session**, then sign in through your host / Foundry as usual.
5. Add more links with **New session**. Use **Sessions** or **Ctrl+Shift+L** while playing to switch worlds.

The full URL, including invitation query strings and paths, is preserved. Links must use HTTPS; local development servers can use HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Sqyre's first-party `sqyre.app` navigation remains in the client. Other sign-in redirects require a native confirmation. Cross-site pop-up links can be opened in your normal browser. A provider that forbids embedded browsers may require additional integration; external-browser logins are not automatically transferred into the client.

## Performance

- Current Electron / Chromium runtime with **hardware acceleration enabled**, a preference for the dedicated GPU on hybrid systems, and normal GPU driver safety checks. The GPU preference can be changed under Preferences and takes effect after restarting.
- **One active game**. Switching or disconnecting closes the old renderer and its pop-out windows.
- Persistent Chromium disk / code caching and server-specific browser sessions retain assets and logins across visits.
- Background animation throttling, a visible-window screen-awake option, fullscreen, and a toolbar-free focus mode.
- On-demand diagnostics report Foundry's canvas ticker FPS, WebGL context, aggregate client memory, and normalized CPU usage. Diagnostics poll while their page is visible or when the optional **FPS** game-toolbar monitor is enabled. The diagnostics page hides the game, which can pause rendering; use the toolbar monitor to measure during play.

The **Performance** page offers opt-in Foundry V14 client settings:

| Profile | Foundry quality | FPS cap | Pixel ratio scaling |
| --- | --- | --- | --- |
| Efficiency | Low (0) | 30 | Off |
| Balanced | Medium (1) | 60 | Off |
| Quality | High (2) | 60 | On |

Choosing a profile in the launcher saves your preference. **It is only applied when you click Apply to current world after joining a world.** No world settings or other players' settings are modified. The adapter checks that each setting exists with `client` scope and validates registered choices / ranges. Unsupported settings are skipped. Original values are backed up before the first change and can be restored. Backups survive a client restart. Foundry may request a reload to finish applying settings.

This wrapper reduces browser clutter and provides deliberate rendering controls. It does **not** claim a measured FPS improvement over Chrome or Edge. Your GPU, maps, animations, modules, internet connection, and server still matter. Sqyre server performance is controlled by Sqyre. The Foundry FPS value comes from its canvas ticker and is not an end-to-end frame presentation benchmark.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Fullscreen | F11 |
| Hide / restore client toolbar | Ctrl+Shift+F |
| Session library | Ctrl+Shift+L |

Focus mode hides the toolbar; **Ctrl+Shift+F** restores it. The library can remain open while your game runs. Use **Disconnect** to release the game's resources. Foundry's same-origin and blank-document pop-out windows are supported with the same sandbox restrictions as the game.

## Local development

Requires Windows 10 / 11 x64 and Node.js 24 or newer. An accelerated GPU supporting WebGL 2 and at least 8 GB system RAM are recommended by Foundry for clients (16 GB recommended).

```powershell
npm ci
# If your npm configuration blocks Electron's install script:
node node_modules/electron/install.js
npm start
```

The application has no frontend framework and no production npm dependencies. The launcher uses local HTML, CSS, and JavaScript; a `WebContentsView` displays the game separately.

```powershell
npm run check       # JavaScript syntax
npm test            # URL, storage, scope, and setting rollback tests
npm run test:e2e    # Real Electron integration tests against a local fixture
npm run pack        # Unpacked app under release/win-unpacked/
npm run dist        # Windows x64 installer and portable executable
npm run test:packaged # Smoke check the built app (uses its normal local app-data folder)
```

Builds are written to `release/`. `Foundry-Client-Setup-0.1.0-x64.exe` is the installer; `Foundry-Client-0.1.0-x64-win.exe` is the portable app. The generated binaries are unsigned. Windows may show the publisher as unknown. Code signing and automatic updates are not configured; update the Electron dependency regularly and rebuild to receive Chromium security fixes. The repository workflow verifies and builds Windows artifacts without publishing a release.

Integration tests use a small local mock world to verify the wrapper, including multiple sessions, storage persistence, sandboxing, profile application / restoration, pop-outs, and failure recovery. **A real licensed Foundry V14 world on Sqyre is still required for end-to-end host and module compatibility verification.** The tests do not establish performance gains. No production Sqyre credentials or game links are included.

## Storage and permissions

Settings are stored in `%APPDATA%/foundry-client/client-settings.json`. Browser partitions live alongside that file and are isolated by server origin. Worlds on the same origin share Foundry client settings and login cookies, just as they would in the same browser. The portable app also uses this user-data directory; it does not store logins beside its executable.

Session URLs are saved as local bookmarks in plain text. Invitation tokens in URLs remain private data. Credentials entered into a game remain in Chromium's session storage / cookies as directed by the host. The client does not collect telemetry, send analytics, or export passwords. Clearing **Asset cache** removes only HTTP assets and retains login storage and settings.

Remote game pages receive no Node.js access, preload script, IPC API, or filesystem bridge. Context isolation, OS sandboxing, web security, certificate checks, and mixed-content protection remain enabled. Permissions are denied by default except fullscreen and sanitized clipboard writes for trusted game origins. Camera / microphone requests require enabling the preference and approving a native request. Downloads use a save dialog. External URLs are validated before reaching the OS browser. The local launcher has its own restricted content security policy and sender-validated IPC.

## References

- [Foundry client requirements](https://foundryvtt.com/article/requirements/)
- [Foundry rendering and client settings](https://foundryvtt.com/article/settings/)
- [Foundry V14 performance mode constants](https://foundryvtt.com/api/v14/variables/CONST.CANVAS_PERFORMANCE_MODES.html)
- [Foundry V14 ClientSettings API](https://foundryvtt.com/api/v14/classes/foundry.helpers.ClientSettings.html)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

Independent project; not affiliated with Foundry Gaming, LLC or Sqyre. Foundry Virtual Tabletop and Sqyre are their respective owners' names and trademarks.
