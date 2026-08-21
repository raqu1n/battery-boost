import Gio from 'gi://Gio';
import type GLib from 'gi://GLib';

import {
    BATTERY_DEVICE_TYPE,
    DeviceState,
    createUPowerDeviceProxy,
    createUPowerProxy,
    type UPowerDeviceProxy,
    type UPowerProxy,
} from './proxies.js';
import {logDebug, logError} from '../utils.js';

export type BatteryServiceErrorCode =
    | 'no-battery'
    | 'threshold-unsupported';

export class BatteryServiceError extends Error {
    constructor(readonly code: BatteryServiceErrorCode) {
        super(code);
        this.name = 'BatteryServiceError';
    }
}

export interface BatteryServiceCallbacks {
    onThresholdChanged(thresholdEnabled: boolean): void;
    onChargeCycleEnded(): void;
}

function isChargingState(state: number): boolean {
    return state === DeviceState.CHARGING ||
        state === DeviceState.PENDING_CHARGE ||
        state === DeviceState.FULLY_CHARGED;
}

export class BatteryService {
    private readonly _callbacks: BatteryServiceCallbacks;
    private _cancellable: Gio.Cancellable | null = null;
    private _thresholdOperation = 0;
    private _deviceGeneration = 0;
    private _discoveryPromise: Promise<void> | null = null;
    private _discoveryQueued = false;
    private readonly _pendingDevicePaths = new Set<string>();
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
        if (this._cancellable !== null)
            return;

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        void this._setupUPower(cancellable);
    }

    stop(): void {
        const cancellable = this._cancellable;
        this._cancellable = null;
        cancellable?.cancel();

        this._thresholdOperation++;
        this._discoveryPromise = null;
        this._discoveryQueued = false;
        this._pendingDevicePaths.clear();
        this._unwatchDevice();
        this._unwatchUPower();
    }

    setThresholdEnabled(enabled: boolean): Promise<boolean> {
        const proxy = this._deviceProxy;
        const cancellable = this._cancellable;
        const operation = ++this._thresholdOperation;

        if (!proxy)
            return Promise.reject(new BatteryServiceError('no-battery'));
        if (!proxy.ChargeThresholdSupported) {
            return Promise.reject(new BatteryServiceError(
                'threshold-unsupported'));
        }

        return new Promise<boolean>((resolve, reject) => {
            try {
                proxy.EnableChargeThresholdRemote(enabled, (_result, error) => {
                    if (operation !== this._thresholdOperation ||
                        proxy !== this._deviceProxy ||
                        cancellable !== this._cancellable) {
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

    private _isActive(cancellable: Gio.Cancellable): boolean {
        return this._cancellable === cancellable;
    }

    private async _setupUPower(cancellable: Gio.Cancellable): Promise<void> {
        try {
            const proxy = await createUPowerProxy(cancellable);

            if (!this._isActive(cancellable))
                return;

            this._upowerProxy = proxy;
            this._deviceAddedId = proxy.connectSignal(
                'DeviceAdded', (_proxy, _sender, [devicePath]) => {
                    if (!this._deviceProxy)
                        this._queueDiscovery(cancellable, devicePath);
                });
            this._deviceRemovedId = proxy.connectSignal(
                'DeviceRemoved', (_proxy, _sender, [devicePath]) => {
                    this._pendingDevicePaths.delete(devicePath);

                    if (devicePath === this._devicePath) {
                        this._unwatchDevice();
                    } else if (!this._deviceProxy) {
                        // Invalidate a candidate that may still be initializing
                        // for the removed path.
                        this._deviceGeneration++;
                    }

                    if (!this._deviceProxy)
                        this._queueDiscovery(cancellable);
                });

            this._queueDiscovery(cancellable);
        } catch (error) {
            if (!this._isActive(cancellable))
                return;

            this._unwatchUPower();
            logError('Failed to connect to UPower', error);
        }
    }

    private _unwatchUPower(): void {
        const proxy = this._upowerProxy;
        const deviceAddedId = this._deviceAddedId;
        const deviceRemovedId = this._deviceRemovedId;

        this._deviceAddedId = null;
        this._deviceRemovedId = null;
        this._upowerProxy = null;

        if (!proxy)
            return;

        if (deviceAddedId !== null) {
            try {
                proxy.disconnectSignal(deviceAddedId);
            } catch (error) {
                logError('Failed to disconnect DeviceAdded signal', error);
            }
        }

        if (deviceRemovedId !== null) {
            try {
                proxy.disconnectSignal(deviceRemovedId);
            } catch (error) {
                logError('Failed to disconnect DeviceRemoved signal', error);
            }
        }
    }

    private _queueDiscovery(
        cancellable: Gio.Cancellable,
        devicePath?: string
    ): void {
        if (!this._isActive(cancellable) || this._deviceProxy)
            return;

        if (devicePath)
            this._pendingDevicePaths.add(devicePath);

        if (this._discoveryPromise) {
            this._discoveryQueued = true;
            return;
        }

        const discovery = this._findBatteryDevice(cancellable);
        this._discoveryPromise = discovery;

        void discovery.then(() => {
            this._finishDiscovery(cancellable, discovery);
        });
    }

    private _finishDiscovery(
        cancellable: Gio.Cancellable,
        discovery: Promise<void>
    ): void {
        if (this._discoveryPromise !== discovery)
            return;

        this._discoveryPromise = null;
        const queued = this._discoveryQueued;
        this._discoveryQueued = false;

        if (queued)
            this._queueDiscovery(cancellable);
    }

    private async _findBatteryDevice(
        cancellable: Gio.Cancellable
    ): Promise<void> {
        const upowerProxy = this._upowerProxy;
        if (!upowerProxy || this._deviceProxy ||
            !this._isActive(cancellable))
            return;

        try {
            const requestedDevicePaths = [...this._pendingDevicePaths];
            this._pendingDevicePaths.clear();

            for (const devicePath of requestedDevicePaths) {
                if (await this._tryDevice(devicePath, cancellable))
                    return;

                if (this._upowerProxy !== upowerProxy ||
                    !this._isActive(cancellable) || this._deviceProxy)
                    return;
            }

            const [devicePaths] = await upowerProxy.EnumerateDevicesAsync(
                cancellable);

            if (this._upowerProxy !== upowerProxy ||
                !this._isActive(cancellable) || this._deviceProxy)
                return;

            for (const devicePath of devicePaths) {
                if (await this._tryDevice(devicePath, cancellable))
                    return;

                if (this._upowerProxy !== upowerProxy ||
                    !this._isActive(cancellable) || this._deviceProxy)
                    return;
            }
        } catch (error) {
            if (this._upowerProxy !== upowerProxy ||
                !this._isActive(cancellable))
                return;

            logError('EnumerateDevices failed', error);
        }
    }

    private async _tryDevice(
        devicePath: string,
        cancellable: Gio.Cancellable
    ): Promise<boolean> {
        if (this._deviceProxy || !this._isActive(cancellable))
            return false;

        const deviceGeneration = this._deviceGeneration;

        try {
            const proxy = await createUPowerDeviceProxy(
                devicePath,
                cancellable
            );

            if (!this._isActive(cancellable) ||
                deviceGeneration !== this._deviceGeneration ||
                this._deviceProxy)
                return false;

            if (proxy.Type !== BATTERY_DEVICE_TYPE ||
                !proxy.PowerSupply || !proxy.IsPresent)
                return false;

            const changedId = proxy.connect(
                'g-properties-changed', (changedProxy, changed) => {
                    this._onDeviceChanged(changedProxy, changed);
                });

            if (!this._isActive(cancellable) ||
                deviceGeneration !== this._deviceGeneration ||
                this._deviceProxy) {
                proxy.disconnect(changedId);
                return false;
            }

            this._deviceProxy = proxy;
            this._devicePath = devicePath;
            this._previousState = proxy.State;
            this._previousPercentage = proxy.Percentage;
            this._deviceChangedId = changedId;

            this._emitThresholdState();
            return true;
        } catch (error) {
            if (!this._isActive(cancellable) ||
                deviceGeneration !== this._deviceGeneration)
                return false;

            logDebug(`Could not inspect ${devicePath}`, error);
            return false;
        }
    }

    private _unwatchDevice(): void {
        this._deviceGeneration++;

        const proxy = this._deviceProxy;
        const changedId = this._deviceChangedId;
        this._deviceProxy = null;
        this._deviceChangedId = null;
        this._devicePath = null;
        this._previousState = null;
        this._previousPercentage = null;

        if (proxy)
            this._thresholdOperation++;

        if (!proxy || changedId === null)
            return;

        try {
            proxy.disconnect(changedId);
        } catch (error) {
            logError('Failed to disconnect from battery device', error);
        }
    }

    private _onDeviceChanged(
        deviceProxy: UPowerDeviceProxy,
        changed: GLib.Variant
    ): void {
        if (this._deviceProxy !== deviceProxy)
            return;

        try {
            this._handleDeviceChanged(changed);
        } catch (error) {
            logError('Failed to handle battery update', error);
        }
    }

    private _handleDeviceChanged(changed: GLib.Variant): void {
        const deviceProxy = this._deviceProxy;
        if (!deviceProxy)
            return;

        if (changed.lookup_value('IsPresent', null) &&
            !deviceProxy.IsPresent) {
            this._unwatchDevice();
            const cancellable = this._cancellable;
            if (cancellable)
                this._queueDiscovery(cancellable);
            return;
        }

        const stateChanged = !!changed.lookup_value('State', null);
        const percentageChanged = !!changed.lookup_value('Percentage', null);
        const previousState = this._previousState;
        const previousPercentage = this._previousPercentage;
        const state = deviceProxy.State;
        const percentage = deviceProxy.Percentage;

        const disconnected = stateChanged &&
            previousState !== DeviceState.DISCHARGING &&
            state === DeviceState.DISCHARGING;
        const fullyCharged = previousPercentage !== null &&
            previousPercentage < 100.0 && percentage >= 100.0 &&
            ((percentageChanged && isChargingState(state)) ||
                (stateChanged && state === DeviceState.FULLY_CHARGED));

        // Always advance the baseline so cycle events represent transitions.
        if (stateChanged)
            this._previousState = state;
        if (percentageChanged)
            this._previousPercentage = percentage;

        if (changed.lookup_value('ChargeThresholdEnabled', null))
            this._emitThresholdState();

        if (disconnected || fullyCharged) {
            try {
                this._callbacks.onChargeCycleEnded();
            } catch (error) {
                logError('Failed to end battery charge cycle', error);
            }
        }
    }

    private _emitThresholdState(): void {
        const deviceProxy = this._deviceProxy;
        if (!deviceProxy)
            return;

        try {
            this._callbacks.onThresholdChanged(
                deviceProxy.ChargeThresholdEnabled);
        } catch (error) {
            logError('Failed to synchronize threshold state', error);
        }
    }
}
