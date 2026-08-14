import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

type BatteryToggleConstructor = new(
    settings: Gio.Settings,
    settingsKey: string
) => QuickToggle;

type BatteryIndicatorConstructor = new(
    settings: Gio.Settings,
    settingsKey: string
) => SystemIndicator;

const BatteryToggle = GObject.registerClass(
class BatteryToggle extends QuickToggle {
    _init(settings?: unknown, settingsKey?: unknown): void {
        super._init({
            title: _('Battery Boost'),
            iconName: 'battery-full-symbolic',
            toggleMode: true,
        });

        (settings as Gio.Settings).bind(settingsKey as string, this, 'checked',
            Gio.SettingsBindFlags.DEFAULT);
    }
}) as unknown as BatteryToggleConstructor;

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends SystemIndicator {
    _init(settings?: unknown, settingsKey?: unknown): void {
        super._init();

        this.quickSettingsItems.push(new BatteryToggle(
            settings as Gio.Settings,
            settingsKey as string
        ));
    }

    destroy(): void {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
}) as unknown as BatteryIndicatorConstructor;

export function createBatteryIndicator(
    settings: Gio.Settings,
    settingsKey: string
): SystemIndicator {
    return new BatteryIndicator(settings, settingsKey);
}
