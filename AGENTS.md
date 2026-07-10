# AGENTS.md — Battery Boost

This file documents the project for AI coding agents. It is based on the actual source files; update it when the architecture or workflow changes.

## Project overview

Battery Boost is a GNOME Shell extension that adds a Quick Settings toggle to switch a laptop's battery charge limit between 80% ("healthy") and 100% ("maximum"). It targets GNOME Shell 45 and later, uses modern ES modules, and communicates with the system's UPower service over D-Bus.

Key facts:

- **Extension UUID:** `battery-health-toggle@batteryhealth-widget`
- **Language:** JavaScript (GNOME Shell / GJS), CSS
- **Settings schema:** `org.gnome.shell.extensions.battery-health-toggle`
- **Minimum GNOME Shell version:** 45
- **License:** MIT
- **Repository root:** `/home/malte/repos/batteryhealth-widget`
- **Extension source directory:** `battery-health-toggle@batteryhealth-widget/`

## Files and code organization

```
battery-health-widget/
├── AGENTS.md                                    # This file
├── battery-health-toggle@batteryhealth-widget/  # Extension source
│   ├── extension.js                             # Main extension logic
│   ├── metadata.json                            # Extension manifest
│   ├── stylesheet.css                           # Extension-specific styles
│   ├── README.md                                # User-facing documentation
│   └── schemas/
│       ├── gschemas.compiled                    # Compiled binary schema
│       └── org.gnome.shell.extensions.battery-health-toggle.gschema.xml
└── battery-health-toggle@batteryhealth-widget.shell-extension.zip
                                                 # Packaged distributable
```

### `extension.js`

Single-file extension. Exports a default class `BatteryBoostExtension` extending `Extension` from `resource:///org/gnome/shell/extensions/extension.js`.

Main parts:

- **D-Bus proxies:** `UPowerProxy` and `UPowerDeviceProxy` wrap the `org.freedesktop.UPower` and `org.freedesktop.UPower.Device` interfaces.
- **UI:** `BatteryToggle` extends `QuickToggle`; a `SystemIndicator` hosts it in GNOME's Quick Settings menu.
- **Lifecycle:** `enable()` sets up the indicator, D-Bus proxy, and settings listener; `disable()` tears everything down.
- **State:** Settings key `boost-enabled` is a boolean. `false` means the healthy 80% charge limit is active; `true` means the one-cycle 100% boost is active.
- **Binding:** `BatteryToggle` binds the `boost-enabled` setting directly to its `checked` property via `Gio.Settings.bind()`.
- **Auto-revert:** When boost is active, the extension reverts to `false` automatically when AC power is disconnected or the battery reaches 100%.

### `metadata.json`

Standard GNOME Shell extension manifest:

- `uuid`, `name`, `description`, `version`
- `shell-version`: supported GNOME Shell releases (`45` through `50`)
- `settings-schema`: links the extension to its GSettings schema

### `schemas/org.gnome.shell.extensions.battery-health-toggle.gschema.xml`

Defines one key:

```xml
<key name="boost-enabled" type="b">
  <default>false</default>
</key>
```

After editing the XML, recompile the schema with `glib-compile-schemas schemas/`.

### `stylesheet.css`

Placeholder stylesheet. Currently contains no rules. Add custom styling here if needed.

## Technology stack

- **Runtime:** GNOME Shell / GJS
- **Module system:** ES modules (`import Gio from 'gi://Gio';`)
- **UI toolkit:** GNOME Shell Quick Settings API (`SystemIndicator`, `QuickToggle`)
- **D-Bus:** UPower system bus (`org.freedesktop.UPower`)
- **Configuration:** GSettings via XML schema
- **Packaging:** `gnome-extensions pack`

## Build process

There is no build step that compiles JavaScript. The extension ships as JavaScript source.

### Local install

```bash
cd battery-health-toggle@batteryhealth-widget
glib-compile-schemas schemas/
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r "$(pwd)" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable battery-health-toggle@batteryhealth-widget
```

Restart GNOME Shell after installing:

- Wayland: log out and back in
- X11: press `Alt+F2`, type `r`, press Enter

### Build distributable zip

```bash
gnome-extensions pack battery-health-toggle@batteryhealth-widget
```

This produces `battery-health-toggle@batteryhealth-widget.shell-extension.zip` in the repository root. The zip in the repository was created this way.

## Testing instructions

The project has no automated test suite. Validation is manual:

1. Install the extension locally.
2. Open the system menu and verify the "Battery Boost" toggle appears.
3. Click the toggle and confirm the setting changes via GSettings:
   ```bash
   gsettings get org.gnome.shell.extensions.battery-health-toggle boost-enabled
   ```
4. Verify the underlying UPower state:
   ```bash
   upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep charge-threshold
   ```
5. If supported, confirm that maximum mode reverts to healthy after unplugging AC or reaching 100%.
6. Watch logs during testing:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

Only hardware and UPower versions that expose `ChargeThresholdSupported` and `EnableChargeThreshold` can exercise the core feature.

## Code style guidelines

- Use GNOME Shell extension ES module imports (e.g. `import Gio from 'gi://Gio';`).
- Indent with 4 spaces.
- Use `const` and `let`; avoid `var`.
- Prefix private instance properties with `_` (e.g. `this._settings`).
- Use `gettext as _` for translatable strings.
- Handle D-Bus and proxy errors with `try/catch` and log with `console.error('[BatteryHealth] ...')`.
- Use `signal_handler_block` / `signal_handler_unblock` when updating GSettings to avoid recursive change handlers.

## Security considerations

- The extension operates on the **system D-Bus** (`Gio.DBus.system`) with UPower. It calls `EnableChargeThreshold` to change hardware charge limits.
- The extension does not persist passwords, store secrets, or execute arbitrary commands.
- The only writable state is the single GSettings key `charge-mode` and the UPower threshold.
- The zip distributable should not include unrelated files such as `.git`, editor backups, or environment files. `gnome-extensions pack` generally handles this, but verify the contents of generated zips when adding new files.

## Notes for agents

- There is no `package.json`, `Cargo.toml`, `pyproject.toml`, or similar manifest. The source of truth is `metadata.json` plus the GSettings schema.
- The repository has no CI configuration yet.
- The existing `gschemas.compiled` binary is checked in; regenerate it with `glib-compile-schemas schemas/` after any schema XML change.
- The zip file at the repository root is the release artifact. Rebuild it with `gnome-extensions pack` before distributing.
