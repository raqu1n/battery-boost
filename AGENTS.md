# AGENTS.md — Battery Boost

This file documents the project for AI coding agents. It is based on the actual source files; update it when the architecture or workflow changes.

## Project overview

Battery Boost is a GNOME Shell extension that adds a Quick Settings toggle to temporarily disable a laptop's configured charge limit and charge to 100%. It targets GNOME Shell 50, uses modern ES modules, and communicates with the system's UPower service over D-Bus.

Key facts:

- **Extension UUID:** `battery-boost@maltehegel.github.io`
- **Language:** TypeScript compiled to JavaScript (GNOME Shell / GJS)
- **Settings schema:** `org.gnome.shell.extensions.battery-boost`
- **GNOME Shell version:** 50
- **License:** MIT
- **Repository root:** `/home/malte/repos/batteryhealth-widget`
- **Extension source directory:** `src/`

## Files and code organization

```
battery-health-widget/
├── AGENTS.md                                    # This file
├── README.md                                    # Project-level overview and install instructions
├── .gitignore                                   # Ignore build artifacts, editors, OS files
├── package.json                                 # TypeScript scripts and development dependencies
├── package-lock.json                            # Locked development dependency versions
├── tsconfig.json                                # Strict TypeScript compiler configuration
├── ambient.d.ts                                 # GJS and GNOME Shell ambient type imports
├── scripts/
│   └── build.sh                                 # Compile, validate schema, and pack zip
├── src/                                         # Extension source
│   ├── extension.ts                             # Main extension logic
│   ├── metadata.json                            # Extension manifest
│   └── schemas/
│       └── org.gnome.shell.extensions.battery-boost.gschema.xml
├── build/                                       # Generated staging directory (ignored by git)
└── dist/                                        # Packaged distributable (ignored by git)
```

### `extension.ts`

Single-file TypeScript extension. It is compiled to readable JavaScript and exports a default class `BatteryBoostExtension` extending `Extension` from `resource:///org/gnome/shell/extensions/extension.js`.

Main parts:

- **D-Bus proxies:** `UPowerProxy` and `UPowerDeviceProxy` wrap the `org.freedesktop.UPower` and `org.freedesktop.UPower.Device` interfaces. Proxy construction and device enumeration are asynchronous so UPower discovery does not block GNOME Shell's main thread.
- **UI:** `BatteryToggle` extends `QuickToggle` and binds its checked state bidirectionally to GSettings; `BatteryIndicator` hosts it in GNOME's Quick Settings menu.
- **Lifecycle:** `enable()` sets up the indicator, D-Bus proxy, and settings listener; `disable()` tears everything down.
- **State:** Settings key `boost-enabled` is a boolean. `false` means the configured charge limit is active; `true` means the one-cycle 100% boost is active.
- **UI sync:** `BatteryToggle` uses a bidirectional `Gio.Settings.bind()` binding for `boost-enabled` and `checked`.
- **Auto-revert:** When boost is active, the extension reverts to `false` automatically on a **transition** to AC disconnected (battery state changes into discharging) or on a transition to 100% charge. It does not revert merely because the current state is discharging or already at 100%.
- **Hotplug:** The extension watches UPower `DeviceAdded` and `DeviceRemoved` signals and safely switches battery proxies.
- **Async safety:** UPower discovery uses a lifecycle cancellable and device serial guard. Each threshold operation has a serial guard so callbacks from removed devices, earlier clicks, or a disabled extension cannot overwrite newer state.
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
- **Packaging:** `gnome-extensions pack`

## Build process

The extension ships as generated JavaScript because GNOME Shell does not execute TypeScript. The build script compiles TypeScript into `build/`, validates the GSettings schema, copies only the runtime assets into that staging directory, and packages it.

### Local install

```bash
npm ci
./scripts/build.sh
gnome-extensions install dist/battery-boost@maltehegel.github.io.shell-extension.zip
gnome-extensions enable battery-boost@maltehegel.github.io
```

Restart GNOME Shell after installing:

- Wayland: log out and back in
- X11: press `Alt+F2`, type `r`, press Enter

### Build distributable zip

```bash
npm ci
./scripts/build.sh
```

This produces `dist/battery-boost@maltehegel.github.io.shell-extension.zip`.

Run `npm run typecheck` for a strict type check without emitting JavaScript.

## Testing instructions

The project has no runtime test suite. Start validation with the static check, then test manually:

1. Type-check the extension: `npm run typecheck`.
2. Build the extension: `./scripts/build.sh`.
3. Install the produced zip and enable it.
4. Open the system menu and verify the "Battery Boost" toggle appears.
5. Click the toggle and confirm the setting changes via GSettings:
   ```bash
   gsettings get org.gnome.shell.extensions.battery-boost boost-enabled
   ```
6. Verify the underlying UPower state:
   ```bash
   upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep charge-threshold
   ```
7. If supported, confirm that maximum mode reverts to healthy after unplugging AC or reaching 100%.
8. Watch logs during testing:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

Only hardware and UPower versions that expose `ChargeThresholdSupported` and `EnableChargeThreshold` can exercise the core feature.

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
- The repository has no CI configuration yet.
- Source files live in `src/`.
- Run `npm run typecheck` after TypeScript changes.
- Regenerate the distributable zip with `./scripts/build.sh` after any source change.
- `build/` and `dist/` are ignored by git and created on demand by the build script.
