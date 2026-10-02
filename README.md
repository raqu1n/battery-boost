# Battery Boost

A GNOME Shell extension that adds a **Battery Boost** toggle to the Quick Settings menu. 
It lets you temporarily disable your laptop's configured healthy charge limit for a one-time 100% charge.
Once the current charging cycle ends, either the AC is unplugged or the battery reaches 100%, the extensions returns to the configured charge limit.


## Requirements

- GNOME Shell 50+
- A laptop whose battery charge thresholds are supported by UPower
- UPower running with permission to change charge thresholds

Verify UPower support with:

```bash
upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep charge-threshold-supported
```

## Build from source

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

Then restart GNOME Shell.

## Usage

1. Open the system menu (top-right corner).
2. Click **Battery Boost** to charge to 100% for one cycle.
3. The toggle automatically turns off and the configured limit is restored when:
   - you unplug the AC adapter, or
   - the battery reaches 100%.

External changes follow the same validation, rollback, notification, and
auto-revert behavior as changes made with the Quick Settings toggle.

## Building the zip

```bash
npm ci
./scripts/build.sh
```

The build compiles the TypeScript modules under `src/` to readable JavaScript,
validates the GSettings schema, and produces
`dist/battery-boost@raqu1n.github.io.shell-extension.zip`.
