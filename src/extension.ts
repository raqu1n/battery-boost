import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createBatteryIndicator} from './ui/batteryIndicator.js';
import {BatteryService} from './upower/batteryService.js';

const SETTINGS_KEY = 'boost-enabled';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default class BatteryBoostExtension extends Extension {
    private _settings: Gio.Settings | null = null;
    private _settingsChangedId: number | null = null;
    private _indicator: ReturnType<typeof createBatteryIndicator> | null = null;
    private _batteryService: BatteryService | null = null;
    private _operationSerial = 0;

    enable(): void {
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect(
            `changed::${SETTINGS_KEY}`, () => this._onModeChanged());
        this._operationSerial = 0;

        this._batteryService = new BatteryService({
            onThresholdChanged: thresholdEnabled => {
                this._setBoostEnabledWithoutApplying(!thresholdEnabled);
            },
            onChargeCycleEnded: () => this._onChargeCycleEnded(),
        });

        this._indicator = createBatteryIndicator(
            this._settings,
            SETTINGS_KEY
        );
        Main.panel.statusArea.quickSettings!.addExternalIndicator(
            this._indicator);

        this._batteryService.start();
    }

    disable(): void {
        this._operationSerial++;

        const batteryService = this._batteryService;
        this._batteryService = null;
        batteryService?.stop();

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    private _onChargeCycleEnded(): void {
        if (this._settings?.get_boolean(SETTINGS_KEY))
            this._settings.set_boolean(SETTINGS_KEY, false);
    }

    private async _onModeChanged(): Promise<void> {
        const settings = this._settings;
        const batteryService = this._batteryService;
        if (!settings || !batteryService)
            return;

        const boostEnabled = settings.get_boolean(SETTINGS_KEY);
        const operationSerial = ++this._operationSerial;

        try {
            const applied = await batteryService.setThresholdEnabled(
                !boostEnabled);

            if (!applied)
                return;
        } catch (error) {
            if (this._settings !== settings ||
                this._batteryService !== batteryService ||
                operationSerial !== this._operationSerial)
                return;

            console.error(
                `[BatteryBoost] Failed to set threshold: ${errorMessage(error)}`);
            this._notify(_('Failed to change battery charge limit'));
            this._setBoostEnabledWithoutApplying(!boostEnabled);
            return;
        }

        if (this._settings !== settings ||
            this._batteryService !== batteryService ||
            operationSerial !== this._operationSerial)
            return;

        this._notify(boostEnabled
            ? _('Battery boost enabled: charging to 100%')
            : _('Battery boost ended — configured limit restored'));
    }

    private _setBoostEnabledWithoutApplying(enabled: boolean): void {
        if (!this._settings ||
            this._settings.get_boolean(SETTINGS_KEY) === enabled)
            return;

        this._operationSerial++;

        const handlerId = this._settingsChangedId;
        if (handlerId)
            GObject.signal_handler_block(this._settings, handlerId);

        try {
            this._settings.set_boolean(SETTINGS_KEY, enabled);
        } finally {
            if (handlerId)
                GObject.signal_handler_unblock(this._settings, handlerId);
        }
    }

    private _notify(message: string): void {
        Main.notify(_('Battery Boost'), message);
    }
}
