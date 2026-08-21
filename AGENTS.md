# AGENTS.md — Battery Boost

This file documents the project for coding agents. It is based on the actual source files; update it when the architecture or workflow changes.

## Project overview

Battery Boost is a GNOME Shell extension that adds a Quick Settings toggle to temporarily disable a laptop's configured charge limit and charge to 100%. It targets GNOME Shell 50, uses modern ES modules, and communicates with the system's UPower service over D-Bus.

Key facts:

- **Extension UUID:** `battery-boost@raqu1n.github.io`
- **Language:** TypeScript compiled to JavaScript (GNOME Shell / GJS)
- **Settings schema:** `org.gnome.shell.extensions.battery-boost`
- **GNOME Shell version:** 50
- **License:** MIT
- **Repository root:** `/home/malte/repos/batteryhealth-widget`
- **Extension source directory:** `src/`

## Files and code organization

```
batteryhealth-widget/
├── AGENTS.md                                    # This file
├── README.md                                    # Project-level overview and install instructions
├── LICENSE                                      # MIT license text
├── findings.md                                  # Deferred code-review findings
├── .gitignore                                   # Ignore build artifacts, editors, OS files
├── .github/workflows/ci.yml                     # Automated checks on pushes and pull requests
├── package.json                                 # TypeScript scripts and development dependencies
├── package-lock.json                            # Locked development dependency versions
├── tsconfig.json                                # Strict TypeScript compiler configuration
├── tsconfig.test.json                           # Type-checking for tests and test configuration
├── vitest.config.ts                             # Unit test aliases, coverage, and thresholds
├── ambient.d.ts                                 # GJS and GNOME Shell ambient type imports
├── scripts/
│   ├── build.sh                                 # Compile, validate schema, and pack zip
│   └── check-upower.js                          # Generated-proxy UPower smoke test
├── src/                                         # Extension source
│   ├── extension.ts                             # Settings and lifecycle coordinator
│   ├── settings.ts                              # Shared GSettings key constants
│   ├── utils.ts                                 # Shared error formatting and logging
│   ├── metadata.json                            # Extension manifest
│   ├── schemas/
│   │   └── org.gnome.shell.extensions.battery-boost.gschema.xml
│   ├── ui/
│   │   └── batteryIndicator.ts                  # Quick Toggle and System Indicator
│   └── upower/
│       ├── batteryService.ts                    # Discovery, monitoring, and thresholds
│       └── proxies.ts                           # Typed D-Bus proxy construction
├── tests/                                       # Vitest unit tests and GNOME/GJS fakes
│   ├── helpers/                                 # Reusable UPower test doubles
│   ├── mocks/                                   # Aliased gi:// and resource:/// modules
│   ├── ui/                                      # Quick Settings UI tests
│   ├── upower/                                  # Proxy and battery service tests
│   └── extension.test.ts                        # Extension coordinator tests
├── build/                                       # Generated staging directory (ignored by git)
├── coverage/                                    # Generated coverage reports (ignored by git)
└── dist/                                        # Packaged distributable (ignored by git)
```

### Runtime modules

- **`extension.ts`:** Exports `BatteryBoostExtension`, coordinates GSettings, UI, notifications, and the battery service, and owns GNOME Shell extension lifecycle.
- **`ui/batteryIndicator.ts`:** Defines the `BatteryToggle` and `BatteryIndicator` GObject classes and exports a small indicator factory.
- **`upower/proxies.ts`:** Contains UPower D-Bus XML, explicit interfaces for runtime-generated proxy members, and asynchronous proxy factories.
- **`upower/batteryService.ts`:** Owns UPower discovery, serialized battery hotplug handling, property monitoring, charge-cycle transitions, and threshold operations.
- **`settings.ts`:** Defines the extension's GSettings key once for the coordinator and UI.
- **`utils.ts`:** Keeps error formatting and diagnostic logging consistent across runtime modules.

Behavior and ownership:

- **D-Bus:** `UPowerProxy` and `UPowerDeviceProxy` wrap the `org.freedesktop.UPower` and `org.freedesktop.UPower.Device` interfaces. Proxy construction and device enumeration are asynchronous so UPower discovery does not block GNOME Shell's main thread.
- **UI:** `BatteryToggle` extends `QuickToggle` and binds its checked state bidirectionally to GSettings; `BatteryIndicator` hosts it in GNOME's Quick Settings menu.
- **Lifecycle:** `BatteryBoostExtension.enable()` creates the service and indicator; `disable()` stops the service, disconnects settings, and destroys the indicator.
- **State:** Settings key `boost-enabled` is a boolean. `false` means the configured charge limit is active; `true` means the one-cycle 100% boost is active.
- **UI sync:** `BatteryToggle` uses a bidirectional `Gio.Settings.bind()` binding for `boost-enabled` and `checked`.
- **Auto-revert:** When boost is active, the extension reverts to `false` automatically on a **transition** to AC disconnected (battery state changes into discharging) or on a transition to 100% charge. It does not revert merely because the current state is discharging or already at 100%.
- **Hotplug:** The extension watches UPower `DeviceAdded` and `DeviceRemoved` signals and safely switches battery proxies.
- **Async safety:** `BatteryService` uses one lifecycle cancellable, serialized discovery, a device-generation guard, and threshold-operation invalidation. The extension has a settings-operation guard, so callbacks from removed devices, earlier clicks, or a disabled extension cannot overwrite newer state.
- **Types:** GJS and GNOME Shell declarations come from `@girs`. The members generated dynamically by `Gio.DBusProxy.makeProxyWrapper()` are described by local `UPowerProxy` and `UPowerDeviceProxy` interfaces.

### `metadata.json`

Standard GNOME Shell extension manifest:

- `uuid`, `name`, `description`, `url`
- `shell-version`: supported GNOME Shell release (`50`)
- `settings-schema`: links the extension to its GSettings schema

### `schemas/org.gnome.shell.extensions.battery-boost.gschema.xml`

Defines one key:

```xml
<key name="boost-enabled" type="b">
  <default>false</default>
</key>
```

After editing the XML, validate it by running `./scripts/build.sh`.

## Technology stack

- **Authoring language:** TypeScript with strict checking
- **Runtime:** GNOME Shell / GJS executing generated JavaScript
- **Module system:** ES modules (`import Gio from 'gi://Gio';`)
- **UI toolkit:** GNOME Shell Quick Settings API (`SystemIndicator`, `QuickToggle`)
- **D-Bus:** UPower system bus (`org.freedesktop.UPower`)
- **Configuration:** GSettings via XML schema
- **Type definitions:** `@girs/gjs` and `@girs/gnome-shell`
- **Build:** TypeScript compiler (`tsc`)
- **Tests:** Vitest with Node-based GNOME/GJS boundary mocks
- **Coverage:** Vitest V8 provider with enforced project thresholds
- **Packaging:** `gnome-extensions pack`
- **Validation:** Bash syntax checking, strict TypeScript checks, coverage-enforced tests, and GitHub Actions CI

## Build process

The extension ships as generated JavaScript because GNOME Shell does not execute TypeScript. The build script compiles TypeScript into `build/`, validates the GSettings schema, copies only the runtime assets into that staging directory, and packages it.

### Local install

```bash
npm ci
./scripts/build.sh
gnome-extensions install dist/battery-boost@raqu1n.github.io.shell-extension.zip
gnome-extensions enable battery-boost@raqu1n.github.io
```

Restart GNOME Shell after installing:

- Wayland: log out and back in
- X11: press `Alt+F2`, type `r`, press Enter

### Build distributable zip

```bash
npm ci
./scripts/build.sh
```

This produces `dist/battery-boost@raqu1n.github.io.shell-extension.zip`.

Run `npm run typecheck` for a strict type check without emitting JavaScript. Use
`npm run check` for the full local validation and `npm run test:upower` for the
optional generated-proxy smoke test against the local UPower service.

## Testing instructions

The project has a unit suite for logic and lifecycle behavior. Run automated validation first, then test the generated extension manually:

1. Install locked development dependencies: `npm ci`.
2. Type-check source and tests: `npm run typecheck`.
3. Run all unit tests: `npm test`.
4. Enforce and inspect coverage: `npm run test:coverage`.
5. Build the extension: `./scripts/build.sh`.
6. Install the produced zip and enable it.
7. Open the system menu and verify the "Battery Boost" toggle appears.
8. Click the toggle and confirm the setting changes via GSettings:
   ```bash
   gsettings get org.gnome.shell.extensions.battery-boost boost-enabled
   ```
9. Verify the underlying UPower state:
   ```bash
   upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep charge-threshold
   ```
10. If supported, confirm that maximum mode reverts to healthy after unplugging AC or reaching 100%.
11. Watch logs during testing:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

Only hardware and UPower versions that expose `ChargeThresholdSupported` and `EnableChargeThreshold` can exercise the core feature.

The unit tests alias `gi://` and `resource:///` imports to focused fakes. Tests should assert observable extension behavior and boundary interactions rather than duplicating GNOME Shell internals. Coverage thresholds are 90% statements, 80% branches, 100% functions, and 90% lines.

## Code style guidelines

- Use GNOME Shell extension ES module imports (e.g. `import Gio from 'gi://Gio';`).
- Indent with 4 spaces.
- Use `const` and `let`; avoid `var`.
- Keep strict TypeScript enabled and prefer explicit return types for methods.
- Avoid `any`; isolate assertions at dynamic GJS boundaries such as D-Bus proxy construction and `GObject.registerClass()`.
- Prefix private instance properties with `_` (e.g. `this._settings`).
- Use `gettext as _` for translatable strings.
- Handle D-Bus and proxy errors with `try/catch` and log with `console.error('[BatteryBoost] ...')`.
- Use `signal_handler_block` / `signal_handler_unblock` when updating GSettings to avoid recursive change handlers.

## Security considerations

- The extension operates on the **system D-Bus** (`Gio.DBus.system`) with UPower. It calls `EnableChargeThreshold` to change hardware charge limits.
- The extension does not persist passwords, store secrets, or execute arbitrary commands.
- The only writable state is the single GSettings key `boost-enabled` and the UPower threshold.
- The zip distributable should not include unrelated files such as `.git`, editor backups, or environment files. `gnome-extensions pack` generally handles this, but verify the contents of generated zips when adding new files.

## Notes for agents

- `package.json` describes development tooling only. The extension manifest remains `src/metadata.json` and the GSettings schema remains the settings source of truth.
- GitHub Actions runs `npm ci` and `npm run check` on pushes and pull requests.
- Source files live in `src/`.
- Deferred review items are documented in `findings.md`; do not treat them as fixed.
- Run `npm run typecheck` after TypeScript changes.
- Run `npm test` after behavioral changes; use `npm run test:coverage` when adding new logic.
- Run `npm run test:upower` on a GNOME/UPower host when changing D-Bus proxy behavior.
- Regenerate the distributable zip with `./scripts/build.sh` after any source change.
- `build/`, `coverage/`, and `dist/` are ignored by git and created on demand.
