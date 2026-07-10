# Battery Boost

A GNOME Shell extension that adds a **Battery Boost** toggle to the Quick Settings menu. It lets you switch your laptop's battery charge limit between the healthy 80% limit and a one-time 100% charge.

When 100% boost is active, the extension automatically switches back to the healthy 80% limit once the current charging cycle ends — either when you unplug the AC adapter or the battery reaches 100%.

## Requirements

- GNOME Shell 45 or later
- A laptop whose battery charge thresholds are supported by UPower
- UPower running with permission to change charge thresholds

Verify UPower support with:

```bash
upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep charge-threshold-supported
```

## Installation

### From the pre-built zip

```bash
gnome-extensions install battery-health-toggle@batteryhealth-widget.shell-extension.zip
gnome-extensions enable battery-health-toggle@batteryhealth-widget
```

Then restart GNOME Shell:

- **Wayland:** log out and log back in
- **X11:** press `Alt+F2`, type `r`, press Enter

### From source

```bash
cd battery-health-toggle@batteryhealth-widget
glib-compile-schemas schemas/

mkdir -p ~/.local/share/gnome-shell/extensions
cp -r "$(pwd)" ~/.local/share/gnome-shell/extensions/

gnome-extensions enable battery-health-toggle@batteryhealth-widget
```

Then restart GNOME Shell as described above.

## Building the zip

```bash
gnome-extensions pack battery-health-toggle@batteryhealth-widget
```

This produces `battery-health-toggle@batteryhealth-widget.shell-extension.zip`.

## Usage

1. Open the system menu (top-right corner).
2. Click **Battery Boost** to charge to 100% for one cycle.
3. The toggle automatically turns off and the limit returns to 80% when:
   - you unplug the AC adapter, or
   - the battery reaches 100%.

## Development

Watch logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

The extension source lives in `battery-health-toggle@batteryhealth-widget/`.

## License

MIT
