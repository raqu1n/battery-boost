# Battery Boost

A GNOME Shell extension that adds a **Battery Boost** toggle to the Quick Settings menu. It lets you temporarily disable your laptop's configured healthy charge limit for a one-time 100% charge.

When 100% boost is active, the extension automatically restores the configured charge limit once the current charging cycle ends — either when you unplug the AC adapter or the battery reaches 100%.

## Requirements

- GNOME Shell 50
- A laptop whose battery charge thresholds are supported by UPower
- UPower running with permission to change charge thresholds
- Node.js 22.12 or newer and npm when building from source

Verify UPower support with:

```bash
upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep charge-threshold-supported
```

## Installation

### From the pre-built zip

```bash
gnome-extensions install battery-boost@raqu1n.github.io.shell-extension.zip
gnome-extensions enable battery-boost@raqu1n.github.io
```

Then log out and back in to restart GNOME Shell.

### From source

Install the development dependencies and build the extension:

```bash
npm ci
./scripts/build.sh
```

Then install the produced zip:

```bash
gnome-extensions install dist/battery-boost@raqu1n.github.io.shell-extension.zip
gnome-extensions enable battery-boost@raqu1n.github.io
```

Then restart GNOME Shell as described above.

## Building the zip

```bash
npm ci
./scripts/build.sh
```

The build compiles the TypeScript modules under `src/` to readable JavaScript,
validates the GSettings schema, and produces
`dist/battery-boost@raqu1n.github.io.shell-extension.zip`.

For a strict type check without emitting JavaScript:

```bash
npm run typecheck
```

Run the unit test suite or include a coverage report with:

```bash
npm test
npm run test:coverage
```

Run the complete local check, including shell-script syntax validation, strict
schema validation, strict type-checking, and coverage-enforced tests:

```bash
npm run check
```

On a GNOME system with UPower available, run the generated-proxy smoke test:

```bash
npm run test:upower
```

## Usage

1. Open the system menu (top-right corner).
2. Click **Battery Boost** to charge to 100% for one cycle.
3. The toggle automatically turns off and the configured limit is restored when:
   - you unplug the AC adapter, or
   - the battery reaches 100%.

The boost can also be controlled and inspected through its supported GSettings
interface:

```bash
gsettings set org.gnome.shell.extensions.battery-boost boost-enabled true
gsettings get org.gnome.shell.extensions.battery-boost boost-enabled
gsettings set org.gnome.shell.extensions.battery-boost boost-enabled false
```

External changes follow the same validation, rollback, notification, and
auto-revert behavior as changes made with the Quick Settings toggle.

## Development

Watch logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

The TypeScript extension source lives in `src/`, split into the extension
coordinator, Quick Settings UI, and UPower service modules. Generated JavaScript
is placed in `build/` and is not committed.

Unit tests live in `tests/`. They run in Node.js with focused mocks for the
GNOME Shell, GJS, GSettings, and D-Bus boundaries; hardware behavior still needs
the manual checks described in `AGENTS.md`.
