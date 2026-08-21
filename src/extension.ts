import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createBatteryIndicator} from './ui/batteryIndicator.js';
import {BatteryService} from './upower/batteryService.js';
import {SETTINGS_KEY} from './settings.js';
import {logError} from './utils.js';

function modeErrorMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'no-battery')
            return _('No battery found');
        if (error.code === 'threshold-unsupported')
            return _('Battery charge thresholds are not supported');
    }

    return _('Failed to change battery charge limit');
}

export default class BatteryBoostExtension extends Extension {
    private _settings: Gio.Settings | null = null;
    private _settingsChangedId: number | null = null;
    private _indicator: ReturnType<typeof createBatteryIndicator> | null = null;
    private _batteryService: BatteryService | null = null;
    private _operationSerial = 0;

    enable(): void {
        this._settings = this.getSettings();

        try {
            this._settingsChangedId = this._settings.connect(
                `changed::${SETTINGS_KEY}`, () => {
                    void this._onModeChanged();
                });
            this._operationSerial = 0;

            this._batteryService = new BatteryService({
                onThresholdChanged: thresholdEnabled => {
                    this._setBoostEnabledWithoutApplying(!thresholdEnabled);
                },
                onChargeCycleEnded: () => this._onChargeCycleEnded(),
            });

            this._indicator = createBatteryIndicator(this._settings);
            const quickSettings = Main.panel.statusArea.quickSettings;
            if (!quickSettings)
                throw new Error('Quick Settings is unavailable');

            quickSettings.addExternalIndicator(this._indicator);
            this._batteryService.start();
        } catch (error) {
            this.disable();
            logError('Failed to enable extension', error);
            throw error;
        }
    }

    disable(): void {
        this._operationSerial++;

        const batteryService = this._batteryService;
        this._batteryService = null;
        try {
            batteryService?.stop();
        } catch (error) {
            logError('Failed to stop battery service', error);
        }

        const settings = this._settings;
        const settingsChangedId = this._settingsChangedId;
        this._settings = null;
        this._settingsChangedId = null;
        if (settings && settingsChangedId !== null) {
            try {
                settings.disconnect(settingsChangedId);
            } catch (error) {
                logError('Failed to disconnect settings', error);
            }
        }

        const indicator = this._indicator;
        this._indicator = null;
        if (indicator) {
            try {
                indicator.destroy();
            } catch (error) {
                logError('Failed to destroy battery indicator', error);
            }
        }
    }

    private _onChargeCycleEnded(): void {
        const settings = this._settings;
        if (!settings)
            return;

        try {
            if (settings.get_boolean(SETTINGS_KEY))
                settings.set_boolean(SETTINGS_KEY, false);
        } catch (error) {
            logError('Failed to end battery boost', error);
            this._notify(_('Failed to change battery charge limit'));
        }
    }

    private async _onModeChanged(): Promise<void> {
        const settings = this._settings;
        const batteryService = this._batteryService;
        if (!settings || !batteryService)
            return;

        let boostEnabled: boolean;
        try {
            boostEnabled = settings.get_boolean(SETTINGS_KEY);
        } catch (error) {
            logError('Failed to read battery boost setting', error);
            return;
        }

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

            logError('Failed to set threshold', error);
            this._notify(modeErrorMessage(error));
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
        const settings = this._settings;
        if (!settings)
            return;

        try {
            if (settings.get_boolean(SETTINGS_KEY) === enabled)
                return;
        } catch (error) {
            logError('Failed to read battery boost setting', error);
            return;
        }

        this._operationSerial++;

        const handlerId = this._settingsChangedId;
        let blockedHandlerId: number | null = null;

        try {
            if (handlerId !== null) {
                GObject.signal_handler_block(settings, handlerId);
                blockedHandlerId = handlerId;
            }
            settings.set_boolean(SETTINGS_KEY, enabled);
        } catch (error) {
            logError('Failed to synchronize battery boost setting', error);
        } finally {
            if (blockedHandlerId !== null) {
                try {
                    GObject.signal_handler_unblock(settings, blockedHandlerId);
                } catch (error) {
                    logError('Failed to unblock settings handler', error);
                }
            }
        }
    }

    private _notify(message: string): void {
        Main.notify(_('Battery Boost'), message);
    }
}
