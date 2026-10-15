# loch.js — cross-platform POC

One TypeScript / Three.js frontend, built as an offline PWA with Vite and packaged for Windows, Linux and macOS with Tauri 2. LOX files are parsed locally in the browser; no upload or backend. Drag/drop or open a `.lox` file; orbit with left drag / one finger, pan with right drag / two fingers, zoom with wheel / pinch. Use the toggles, Fit view and altitude legend. Includes a generated native-format demo cave.

## Development

Requires Node.js 22+ and npm. `npm install && npm test && npm run dev`. Production site: `npm run build && npm run preview`. Serve the `dist` directory over HTTPS for PWA installation (localhost is also accepted). After first successful load, install the app via your browser and reopen offline.

Desktop: install Rust, platform [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/), and `npm install`. Run `npm run tauri dev`; bundle with `npm run tauri build`. Linux AppImage/DEB requires WebKitGTK 4.1 etc. Windows packages need WebView2 (provided or installed by Windows/installer). macOS builds need Xcode command-line tools.

Desktop builds use their bundled frontend without a PWA service worker. On launch, the native app removes any service workers and cached pages left by older desktop versions and reloads once if needed. Updating or reinstalling therefore recovers from the old desktop PWA cache automatically. Browser and Android PWA builds retain offline caching.

## CI and publishing

`.github/workflows/ci.yml` tests/builds web and the three desktop systems on PRs and pushes. `main` pushes deploy GitHub Pages (enable **Settings → Pages → Source: GitHub Actions**); `v*` tags attach `.exe`, `.msi`, `.deb`, `.AppImage`, `.dmg` release assets. The macOS `.app` is delivered inside the DMG and stored as a workflow artifact. Unsigned desktop binaries may trigger operating-system security prompts. GitHub Pages path is inferred from `GITHUB_REPOSITORY`.

CI identifies builds as `<last-version>-<short-commit>`, using the latest reachable `v*` version tag without its `v` prefix and seven commit characters (for example `0.1-abcdef1`). Before the first version tag, the package version is used. Installer filenames end in that build ID, for example `loch.js_0.1.0_x64-setup_0.1-abcdef1.exe`. Artifact archives are named `desktop-<platform>-<build-id>` and `web-pwa-<build-id>`. Compare the short commit with the About dialog opened by clicking `loch.js`.

## LOX notes and limitations

Parser follows Therion [`loch/lxFile.h`](https://github.com/therion/therion/blob/master/loch/lxFile.h) and [`loch/lxFile.cxx`](https://github.com/therion/therion/blob/master/loch/lxFile.cxx): little-endian 16-byte chunk headers `(type, recordsBytes, count, blobBytes)`; stations (2) with 64-bit XYZ, shots (3), scraps (4) containing indexed 3D points and triangles. Surveys (1), surface terrain (5), and surface imagery (6) are safely skipped; this POC does **not** display surface data, stations/labels or LRUD-generated walls. Centerline excludes surface, hidden and splay shots. Source coordinates are locally recentered for floating-point precision. Smooth shading is calculated from shared indexed vertex normals within each scrap; separate scraps do not share normals, and surfaces with duplicated/non-welded vertices may show seams.

Generated sample: `python scripts/generate-sample.py` — synthetic geometry in genuine LOX record layout, not a model exported by Therion. Test against actual Therion exports before production; large files are parsed on the UI thread and can cause delays or high RAM use. No cross-platform runtime/browser checks, notarization, signing or release publication can be claimed until GitHub runners are executed.

**Reproducibility:** The package-lock could not be generated in the offline build environment. CI currently runs `npm install`; commit a lockfile and change this to `npm ci` once registry access is available.
