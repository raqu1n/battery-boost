import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import type GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const SETTINGS_KEY = 'boost-enabled';
const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
const UPOWER_OBJECT_PATH = '/org/freedesktop/UPower';
const BATTERY_DEVICE_TYPE = 2;

const DeviceState = Object.freeze({
    CHARGING: 1,
    DISCHARGING: 2,
    FULLY_CHARGED: 4,
} as const);

const UPowerIface = `
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg type="ao" direction="out"/>
    </method>
    <signal name="DeviceAdded">
      <arg type="o"/>
    </signal>
    <signal name="DeviceRemoved">
      <arg type="o"/>
    </signal>
  </interface>
</node>`;

const UPowerDeviceIface = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <method name="EnableChargeThreshold">
      <arg type="b" direction="in"/>
    </method>
    <property name="Type" type="u" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="ChargeThresholdEnabled" type="b" access="read"/>
    <property name="ChargeThresholdSupported" type="b" access="read"/>
  </interface>
</node>`;

type UPowerSignal = 'DeviceAdded' | 'DeviceRemoved';

interface UPowerProxy {
    EnumerateDevicesAsync(
        cancellable: Gio.Cancellable | null
    ): Promise<[string[]]>;
    connectSignal(
        signal: UPowerSignal,
        callback: (
            proxy: UPowerProxy,
            sender: string,
            parameters: [string]
        ) => void
    ): number;
    disconnectSignal(handlerId: number): void;
}

interface UPowerDeviceProxy {
    readonly Type: number;
    readonly PowerSupply: boolean;
    readonly State: number;
    readonly Percentage: number;
    readonly IsPresent: boolean;
    readonly ChargeThresholdEnabled: boolean;
    readonly ChargeThresholdSupported: boolean;

    EnableChargeThresholdRemote(
        enabled: boolean,
        callback: (result: unknown, error: unknown | null) => void
    ): void;
    connect(
        signal: 'g-properties-changed',
        callback: (
            proxy: UPowerDeviceProxy,
            changed: GLib.Variant
        ) => void
    ): number;
    disconnect(handlerId: number): void;
}

interface AsyncProxyConstructor<T> {
    newAsync(
        connection: Gio.DBusConnection,
        busName: string,
        objectPath: string,
        cancellable: Gio.Cancellable | null
    ): Promise<T>;
}

type SettingsConstructor<T> = new(settings: Gio.Settings) => T;

function makeAsyncProxy<T>(interfaceXml: string): AsyncProxyConstructor<T> {
    // makeProxyWrapper() creates members from XML at runtime, which TypeScript
    // cannot infer. Keep that assertion at this boundary and type all uses.
    return Gio.DBusProxy.makeProxyWrapper(interfaceXml) as unknown as
        AsyncProxyConstructor<T>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const UPowerProxy = makeAsyncProxy<UPowerProxy>(UPowerIface);
const UPowerDeviceProxy = makeAsyncProxy<UPowerDeviceProxy>(
    UPowerDeviceIface);

const BatteryToggle = GObject.registerClass(
class BatteryToggle extends QuickToggle {
    _init(settings?: unknown): void {
        super._init({
            title: _('Battery Boost'),
            iconName: 'battery-full-symbolic',
            toggleMode: true,
        });

        (settings as Gio.Settings).bind(SETTINGS_KEY, this, 'checked',
            Gio.SettingsBindFlags.DEFAULT);
    }
}) as unknown as SettingsConstructor<QuickToggle>;

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends SystemIndicator {
    _init(settings?: unknown): void {
        super._init();

        this.quickSettingsItems.push(
            new BatteryToggle(settings as Gio.Settings));
    }

    destroy(): void {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
}) as unknown as SettingsConstructor<SystemIndicator>;

export default class BatteryBoostExtension extends Extension {
    private _settings: Gio.Settings | null = null;
    private _settingsChangedId: number | null = null;
    private _cancellable: Gio.Cancellable | null = null;
    private _operationSerial = 0;
    private _deviceSerial = 0;
    private _upowerProxy: UPowerProxy | null = null;
    private _deviceProxy: UPowerDeviceProxy | null = null;
    private _devicePath: string | null = null;
    private _previousState: number | null = null;
    private _previousPercentage: number | null = null;
    private _indicator: SystemIndicator | null = null;
    private _deviceAddedId: number | null = null;
    private _deviceRemovedId: number | null = null;
    private _deviceChangedId: number | null = null;

    enable(): void {
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect(
            `changed::${SETTINGS_KEY}`, () => this._onModeChanged());

        this._cancellable = new Gio.Cancellable();
        this._operationSerial = 0;
        this._deviceSerial = 0;
        this._upowerProxy = null;
        this._deviceProxy = null;
        this._devicePath = null;
        this._previousState = null;
        this._previousPercentage = null;

        this._indicator = new BatteryIndicator(this._settings);
        Main.panel.statusArea.quickSettings!.addExternalIndicator(
            this._indicator);

        void this._setupUPower();
    }

    disable(): void {
        const cancellable = this._cancellable;
        this._cancellable = null;
        cancellable?.cancel();

        this._operationSerial++;
        this._deviceSerial++;

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._unwatchDevice();
        this._unwatchUPower();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    private async _setupUPower(): Promise<void> {
        const cancellable = this._cancellable;
        if (!cancellable)
            return;

        try {
            const proxy = await UPowerProxy.newAsync(
                Gio.DBus.system,
                UPOWER_BUS_NAME,
                UPOWER_OBJECT_PATH,
                cancellable
            );

            if (this._cancellable !== cancellable)
                return;

            this._upowerProxy = proxy;
            this._deviceAddedId = proxy.connectSignal(
                'DeviceAdded', (_proxy, _sender, [devicePath]) => {
                    if (!this._deviceProxy)
                        void this._tryDevice(devicePath, cancellable);
                });
            this._deviceRemovedId = proxy.connectSignal(
                'DeviceRemoved', (_proxy, _sender, [devicePath]) => {
                    if (devicePath === this._devicePath) {
                        this._unwatchDevice();
                    } else if (!this._deviceProxy) {
                        // Invalidate a proxy that may still be initializing for
                        // the removed path.
                        this._deviceSerial++;
                    }

                    if (!this._deviceProxy)
                        void this._findBatteryDevice(cancellable);
                });

            await this._findBatteryDevice(cancellable);
        } catch (error) {
            if (this._cancellable !== cancellable)
                return;

            console.error(
                `[BatteryBoost] Failed to connect to UPower: ${errorMessage(error)}`);
        }
    }

    private _unwatchUPower(): void {
        if (this._upowerProxy) {
            if (this._deviceAddedId)
                this._upowerProxy.disconnectSignal(this._deviceAddedId);
            if (this._deviceRemovedId)
                this._upowerProxy.disconnectSignal(this._deviceRemovedId);
        }

        this._deviceAddedId = null;
        this._deviceRemovedId = null;
        this._upowerProxy = null;
    }

    private async _findBatteryDevice(
        cancellable: Gio.Cancellable | null = this._cancellable
    ): Promise<void> {
        const upowerProxy = this._upowerProxy;
        if (!upowerProxy || this._deviceProxy ||
            this._cancellable !== cancellable)
            return;

        try {
            const [devicePaths] = await upowerProxy.EnumerateDevicesAsync(
                cancellable);

            if (this._upowerProxy !== upowerProxy ||
                this._cancellable !== cancellable || this._deviceProxy)
                return;

            for (const devicePath of devicePaths) {
                if (await this._tryDevice(devicePath, cancellable))
                    break;
            }
        } catch (error) {
            if (this._upowerProxy !== upowerProxy ||
                this._cancellable !== cancellable)
                return;

            console.error(
                `[BatteryBoost] EnumerateDevices failed: ${errorMessage(error)}`);
        }
    }

    private async _tryDevice(
        devicePath: string,
        cancellable: Gio.Cancellable | null = this._cancellable
    ): Promise<boolean> {
        if (this._deviceProxy || this._cancellable !== cancellable)
            return false;

        const deviceSerial = this._deviceSerial;

        try {
            const proxy = await UPowerDeviceProxy.newAsync(
                Gio.DBus.system,
                UPOWER_BUS_NAME,
                devicePath,
                cancellable
            );

            if (this._cancellable !== cancellable ||
                deviceSerial !== this._deviceSerial || this._deviceProxy)
                return false;

            if (proxy.Type !== BATTERY_DEVICE_TYPE ||
                !proxy.PowerSupply || !proxy.IsPresent)
                return false;

            this._deviceProxy = proxy;
            this._devicePath = devicePath;
            this._previousState = proxy.State;
            this._previousPercentage = proxy.Percentage;
            this._deviceChangedId = proxy.connect(
                'g-properties-changed', (_proxy, changed) => {
                    this._onDeviceChanged(changed);
                });

            this._syncFromUPower();
            return true;
        } catch (error) {
            if (this._cancellable !== cancellable ||
                deviceSerial !== this._deviceSerial)
                return false;

            console.debug(
                `[BatteryBoost] Could not inspect ${devicePath}: ${errorMessage(error)}`);
            return false;
        }
    }

    private _unwatchDevice(): void {
        this._deviceSerial++;

        if (this._deviceProxy && this._deviceChangedId)
            this._deviceProxy.disconnect(this._deviceChangedId);

        if (this._deviceProxy)
            this._operationSerial++;

        this._deviceChangedId = null;
        this._deviceProxy = null;
        this._devicePath = null;
        this._previousState = null;
        this._previousPercentage = null;
    }

    private _onDeviceChanged(changed: GLib.Variant): void {
        const deviceProxy = this._deviceProxy;
        if (!deviceProxy)
            return;

        if (changed.lookup_value('IsPresent', null) &&
            !deviceProxy.IsPresent) {
            this._unwatchDevice();
            void this._findBatteryDevice();
            return;
        }

        const stateChanged = !!changed.lookup_value('State', null);
        const percentageChanged = !!changed.lookup_value('Percentage', null);
        const state = deviceProxy.State;
        const percentage = deviceProxy.Percentage;

        const disconnected = stateChanged &&
            this._previousState !== DeviceState.DISCHARGING &&
            state === DeviceState.DISCHARGING;
        const fullyCharged = percentageChanged &&
            this._previousPercentage !== null &&
            this._previousPercentage < 100.0 && percentage >= 100.0 &&
            (state === DeviceState.CHARGING ||
                state === DeviceState.FULLY_CHARGED);

        // Always advance the baseline so auto-revert only reacts to transitions
        // that happen while boost mode is active.
        if (stateChanged)
            this._previousState = state;
        if (percentageChanged)
            this._previousPercentage = percentage;

        if (changed.lookup_value('ChargeThresholdEnabled', null))
            this._syncFromUPower();

        if (!this._settings?.get_boolean(SETTINGS_KEY))
            return;

        if (disconnected || fullyCharged)
            this._settings.set_boolean(SETTINGS_KEY, false);
    }

    private _syncFromUPower(): void {
        if (!this._deviceProxy)
            return;

        this._setBoostEnabledWithoutApplying(
            !this._deviceProxy.ChargeThresholdEnabled);
    }

    private async _onModeChanged(): Promise<void> {
        const settings = this._settings;
        if (!settings)
            return;

        const boostEnabled = settings.get_boolean(SETTINGS_KEY);
        const operationSerial = ++this._operationSerial;

        try {
            await this._setThresholdEnabled(!boostEnabled);
        } catch (error) {
            if (this._settings !== settings ||
                operationSerial !== this._operationSerial)
                return;

            console.error(
                `[BatteryBoost] Failed to set threshold: ${errorMessage(error)}`);
            this._notify(_('Failed to change battery charge limit'));
            this._setBoostEnabledWithoutApplying(!boostEnabled);
            return;
        }

        if (this._settings !== settings ||
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

    private _setThresholdEnabled(enabled: boolean): Promise<void> {
        const proxy = this._deviceProxy;

        if (!proxy)
            return Promise.reject(new Error(_('No battery found')));
        if (!proxy.ChargeThresholdSupported) {
            return Promise.reject(new Error(
                _('Battery charge thresholds are not supported')));
        }

        return new Promise<void>((resolve, reject) => {
            try {
                proxy.EnableChargeThresholdRemote(enabled, (_result, error) => {
                    if (error)
                        reject(error);
                    else
                        resolve();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    private _notify(message: string): void {
        Main.notify(_('Battery Boost'), message);
    }
}
