import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BatteryToggle = GObject.registerClass(
class BatteryToggle extends QuickToggle {
    _init(): void {
        super._init({
            title: _('Battery Boost'),
            iconName: 'battery-full-symbolic',
            toggleMode: true,
        });
    }

    bindSettings(settings: Gio.Settings, settingsKey: string): void {
        settings.bind(settingsKey, this, 'checked',
            Gio.SettingsBindFlags.DEFAULT);
    }
});

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends SystemIndicator {
    _init(): void {
        super._init();
    }

    addBatteryToggle(settings: Gio.Settings, settingsKey: string): void {
        const toggle = new BatteryToggle();
        toggle.bindSettings(settings, settingsKey);
        this.quickSettingsItems.push(toggle);
    }

    destroy(): void {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export function createBatteryIndicator(
    settings: Gio.Settings,
    settingsKey: string
): SystemIndicator {
    const indicator = new BatteryIndicator();
    indicator.addBatteryToggle(settings, settingsKey);
    return indicator;
}
