import Gio from 'gi://Gio';
import type GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    BATTERY_DEVICE_TYPE,
    DeviceState,
    createUPowerDeviceProxy,
    createUPowerProxy,
    type UPowerDeviceProxy,
    type UPowerProxy,
} from './proxies.js';

export interface BatteryServiceCallbacks {
    onThresholdChanged(thresholdEnabled: boolean): void;
    onChargeCycleEnded(): void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class BatteryService {
    private readonly _callbacks: BatteryServiceCallbacks;
    private _cancellable: Gio.Cancellable | null = null;
    private _operationSerial = 0;
    private _deviceSerial = 0;
    private _upowerProxy: UPowerProxy | null = null;
    private _deviceProxy: UPowerDeviceProxy | null = null;
    private _devicePath: string | null = null;
    private _previousState: number | null = null;
    private _previousPercentage: number | null = null;
    private _deviceAddedId: number | null = null;
    private _deviceRemovedId: number | null = null;
    private _deviceChangedId: number | null = null;

    constructor(callbacks: BatteryServiceCallbacks) {
        this._callbacks = callbacks;
    }

    start(): void {
        if (this._cancellable)
            return;

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        void this._setupUPower(cancellable);
    }

    stop(): void {
        const cancellable = this._cancellable;
        this._cancellable = null;
        cancellable?.cancel();

        this._operationSerial++;
        this._deviceSerial++;
        this._unwatchDevice();
        this._unwatchUPower();
    }

    setThresholdEnabled(enabled: boolean): Promise<boolean> {
        const proxy = this._deviceProxy;
        const operationSerial = ++this._operationSerial;

        if (!proxy)
            return Promise.reject(new Error(_('No battery found')));
        if (!proxy.ChargeThresholdSupported) {
            return Promise.reject(new Error(
                _('Battery charge thresholds are not supported')));
        }

        return new Promise<boolean>((resolve, reject) => {
            try {
                proxy.EnableChargeThresholdRemote(enabled, (_result, error) => {
                    if (operationSerial !== this._operationSerial ||
                        proxy !== this._deviceProxy) {
                        resolve(false);
                    } else if (error) {
                        reject(error);
                    } else {
                        resolve(true);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    private async _setupUPower(cancellable: Gio.Cancellable): Promise<void> {
        try {
            const proxy = await createUPowerProxy(cancellable);

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
            const proxy = await createUPowerDeviceProxy(
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

            this._emitThresholdState();
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

        // Always advance the baseline so cycle events represent transitions.
        if (stateChanged)
            this._previousState = state;
        if (percentageChanged)
            this._previousPercentage = percentage;

        if (changed.lookup_value('ChargeThresholdEnabled', null))
            this._emitThresholdState();

        if (disconnected || fullyCharged)
            this._callbacks.onChargeCycleEnded();
    }

    private _emitThresholdState(): void {
        if (this._deviceProxy) {
            this._callbacks.onThresholdChanged(
                this._deviceProxy.ChargeThresholdEnabled);
        }
    }
}
