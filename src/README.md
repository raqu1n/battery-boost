# Battery Boost

A GNOME Shell extension that adds a **Battery Boost** toggle to quickly switch your laptop's battery charge limit between **80% (healthy)** and **100% (maximum)**.

When you enable **Battery Boost**, the extension automatically reverts to the healthy 80% limit once the current charging cycle ends — either when you unplug the AC adapter or the battery reaches 100%.

## Requirements

- GNOME Shell 45 or later
- A laptop whose battery charge thresholds are supported by UPower.
- UPower running with permission to change thresholds (this is the default on modern distributions).

You can verify support with:

```bash
upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep charge-threshold-supported
```

## Installation

### Local install

```bash
# Compile the GSettings schema
cd battery-health-toggle@batteryhealth-widget
glib-compile-schemas schemas/

# Install the extension
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r "$(pwd)" ~/.local/share/gnome-shell/extensions/

# Enable it
gnome-extensions enable battery-health-toggle@batteryhealth-widget
```

Restart GNOME Shell (Wayland: log out/in; X11: `Alt+F2`, `r`, `Enter`).

## Usage

- Open the system menu (top-right corner).
- Click **Battery Boost** to charge to 100% for one cycle.
- The extension automatically switches back to the healthy 80% limit when:
  - you unplug the AC adapter, or
  - the battery reaches 100%.


## Development

Watch logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Build a distributable zip:

```bash
gnome-extensions pack battery-health-toggle@batteryhealth-widget
```

## License

MIT
