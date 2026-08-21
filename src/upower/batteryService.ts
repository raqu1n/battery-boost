import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    BATTERY_DEVICE_TYPE,
    DeviceState,
    createUPowerDeviceProxy,
    createUPowerProxy,
    type UPowerDeviceProxy,
    type UPowerProxy,
} from './proxies.js';
import {logDebug, logError} from '../utils.js';

const DISCOVERY_RETRY_SECONDS = 30;

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
    onThresholdChanged(thresholdEnabled: boolean | null): void;
    onChargeCycleEnded(): void;
}

interface DeviceCandidate {
    path: string;
    proxy: UPowerDeviceProxy;
}

interface DeviceInspection {
    candidate: DeviceCandidate | null;
    failed: boolean;
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
    private _thresholdQueue: Promise<void> = Promise.resolve();
    private _deviceGeneration = 0;
    private _discoveryPromise: Promise<void> | null = null;
    private _discoveryQueued = false;
    private _retryId: number | null = null;
    private _connectionFailureReported = false;
    private _enumerationFailureReported = false;
    private readonly _inspectionFailuresReported = new Set<string>();
    private _upowerProxy: UPowerProxy | null = null;
    private _deviceProxy: UPowerDeviceProxy | null = null;
    private _devicePath: string | null = null;
    private _previousState: number | null = null;
    private _previousPercentage: number | null = null;
    private _fullChargePending = false;
    private _nameOwnerChangedId: number | null = null;
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
        this._connectionFailureReported = false;
        this._enumerationFailureReported = false;
        this._inspectionFailuresReported.clear();
        this._cancelRetry();
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

        const request = this._thresholdQueue.then(async () => {
            if (operation !== this._thresholdOperation ||
                proxy !== this._deviceProxy ||
                cancellable !== this._cancellable)
                return false;

            try {
                await proxy.EnableChargeThresholdAsync(enabled);
            } catch (error) {
                if (operation !== this._thresholdOperation ||
                    proxy !== this._deviceProxy ||
                    cancellable !== this._cancellable)
                    return false;

                throw error;
            }

            return operation === this._thresholdOperation &&
                proxy === this._deviceProxy &&
                cancellable === this._cancellable;
        });

        this._thresholdQueue = request.then(
            () => undefined,
            () => undefined
        );
        return request;
    }

    private _isActive(cancellable: Gio.Cancellable): boolean {
        return this._cancellable === cancellable;
    }

    private async _setupUPower(cancellable: Gio.Cancellable): Promise<void> {
        if (!this._isActive(cancellable) || this._upowerProxy)
            return;

        try {
            const proxy = await createUPowerProxy(cancellable);

            if (!this._isActive(cancellable))
                return;

            this._upowerProxy = proxy;
            this._nameOwnerChangedId = proxy.connect(
                'notify::g-name-owner', changedProxy => {
                    this._onNameOwnerChanged(changedProxy, cancellable);
                });
            this._deviceAddedId = proxy.connectSignal(
                'DeviceAdded', (_proxy, _sender, _parameters) => {
                    if (this._deviceProxy?.ChargeThresholdSupported)
                        return;

                    if (this._deviceProxy)
                        this._unwatchDevice();
                    else
                        this._deviceGeneration++;

                    this._queueDiscovery(cancellable);
                });
            this._deviceRemovedId = proxy.connectSignal(
                'DeviceRemoved', (_proxy, _sender, [devicePath]) => {
                    if (devicePath === this._devicePath) {
                        this._unwatchDevice();
                    } else if (!this._deviceProxy) {
                        this._deviceGeneration++;
                    }

                    if (!this._deviceProxy)
                        this._queueDiscovery(cancellable);
                });

            this._connectionFailureReported = false;
            this._cancelRetry();
            if (proxy.g_name_owner !== null)
                this._queueDiscovery(cancellable);
        } catch (error) {
            if (!this._isActive(cancellable))
                return;

            this._unwatchUPower();
            if (!this._connectionFailureReported) {
                logError('Failed to connect to UPower', error);
                this._connectionFailureReported = true;
            }
            this._scheduleRetry(cancellable);
        }
    }

    private _onNameOwnerChanged(
        proxy: UPowerProxy,
        cancellable: Gio.Cancellable
    ): void {
        if (proxy !== this._upowerProxy || !this._isActive(cancellable))
            return;

        this._deviceGeneration++;
        this._cancelRetry();
        this._unwatchDevice();

        if (proxy.g_name_owner !== null) {
            this._queueDiscovery(cancellable);
        } else {
            this._emitThresholdState();
        }
    }

    private _unwatchUPower(): void {
        const proxy = this._upowerProxy;
        const nameOwnerChangedId = this._nameOwnerChangedId;
        const deviceAddedId = this._deviceAddedId;
        const deviceRemovedId = this._deviceRemovedId;

        this._nameOwnerChangedId = null;
        this._deviceAddedId = null;
        this._deviceRemovedId = null;
        this._upowerProxy = null;

        if (!proxy)
            return;

        if (nameOwnerChangedId !== null) {
            try {
                proxy.disconnect(nameOwnerChangedId);
            } catch (error) {
                logError('Failed to disconnect UPower owner signal', error);
            }
        }

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

    private _scheduleRetry(cancellable: Gio.Cancellable): void {
        if (this._retryId !== null || !this._isActive(cancellable))
            return;

        this._retryId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            DISCOVERY_RETRY_SECONDS,
            () => {
                this._retryId = null;
                if (this._isActive(cancellable)) {
                    if (this._upowerProxy) {
                        if (this._deviceProxy)
                            this._unwatchDevice();
                        else
                            this._deviceGeneration++;
                        this._queueDiscovery(cancellable);
                    } else {
                        void this._setupUPower(cancellable);
                    }
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    private _cancelRetry(): void {
        if (this._retryId === null)
            return;

        GLib.Source.remove(this._retryId);
        this._retryId = null;
    }

    private _queueDiscovery(cancellable: Gio.Cancellable): void {
        if (!this._isActive(cancellable) || this._deviceProxy)
            return;

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

        const deviceGeneration = this._deviceGeneration;
        let fallbackCandidate: DeviceCandidate | null = null;
        let inspectionFailed = false;
        let absentCandidateFound = false;

        let devicePaths: string[];
        try {
            [devicePaths] = await upowerProxy.EnumerateDevicesAsync(cancellable);
        } catch (error) {
            if (!this._canContinueDiscovery(
                upowerProxy, cancellable, deviceGeneration))
                return;

            if (!this._enumerationFailureReported) {
                logError('EnumerateDevices failed', error);
                this._enumerationFailureReported = true;
            }
            this._emitThresholdState();
            this._scheduleRetry(cancellable);
            return;
        }

        if (!this._canContinueDiscovery(
            upowerProxy, cancellable, deviceGeneration))
            return;

        this._cancelRetry();
        this._enumerationFailureReported = false;

        for (const devicePath of devicePaths) {
            const inspection = await this._inspectDevice(
                devicePath, cancellable, deviceGeneration);
            inspectionFailed ||= inspection.failed;

            if (!this._canContinueDiscovery(
                upowerProxy, cancellable, deviceGeneration))
                return;

            const candidate = inspection.candidate;
            if (!candidate)
                continue;
            if (!candidate.proxy.IsPresent) {
                absentCandidateFound = true;
            } else if (candidate.proxy.ChargeThresholdSupported) {
                if (this._watchDevice(
                    candidate, cancellable, deviceGeneration)) {
                    this._cancelRetry();
                    return;
                }
                inspectionFailed = true;
            } else {
                fallbackCandidate ??= candidate;
            }
        }

        if (fallbackCandidate) {
            if (this._watchDevice(
                fallbackCandidate, cancellable, deviceGeneration)) {
                if (inspectionFailed)
                    this._scheduleRetry(cancellable);
                return;
            }
            inspectionFailed = true;
        }

        this._emitThresholdState();
        if (inspectionFailed || absentCandidateFound)
            this._scheduleRetry(cancellable);
    }

    private _canContinueDiscovery(
        upowerProxy: UPowerProxy,
        cancellable: Gio.Cancellable,
        deviceGeneration: number
    ): boolean {
        return this._upowerProxy === upowerProxy &&
            this._isActive(cancellable) &&
            this._deviceGeneration === deviceGeneration &&
            !this._deviceProxy;
    }

    private async _inspectDevice(
        devicePath: string,
        cancellable: Gio.Cancellable,
        deviceGeneration: number
    ): Promise<DeviceInspection> {
        try {
            const proxy = await createUPowerDeviceProxy(
                devicePath,
                cancellable
            );

            if (!this._isActive(cancellable) ||
                deviceGeneration !== this._deviceGeneration ||
                this._deviceProxy)
                return {candidate: null, failed: false};

            if (proxy.Type !== BATTERY_DEVICE_TYPE || !proxy.PowerSupply)
                return {candidate: null, failed: false};

            return {
                candidate: {path: devicePath, proxy},
                failed: false,
            };
        } catch (error) {
            if (!this._isActive(cancellable) ||
                deviceGeneration !== this._deviceGeneration)
                return {candidate: null, failed: false};

            if (!this._inspectionFailuresReported.has(devicePath)) {
                logDebug(`Could not inspect ${devicePath}`, error);
                this._inspectionFailuresReported.add(devicePath);
            }
            return {candidate: null, failed: true};
        }
    }

    private _watchDevice(
        candidate: DeviceCandidate,
        cancellable: Gio.Cancellable,
        deviceGeneration: number
    ): boolean {
        const {path, proxy} = candidate;
        if (!proxy.IsPresent)
            return false;

        try {
            const changedId = proxy.connect(
                'g-properties-changed', (changedProxy, changed) => {
                    this._onDeviceChanged(changedProxy, changed);
                });

            if (!this._isActive(cancellable) ||
                deviceGeneration !== this._deviceGeneration ||
                this._deviceProxy || !proxy.IsPresent) {
                proxy.disconnect(changedId);
                return false;
            }

            this._deviceProxy = proxy;
            this._devicePath = path;
            this._previousState = proxy.State;
            this._previousPercentage = proxy.Percentage;
            this._fullChargePending = false;
            this._deviceChangedId = changedId;

            this._inspectionFailuresReported.delete(path);
            this._emitThresholdState();
            return true;
        } catch (error) {
            if (this._isActive(cancellable) &&
                deviceGeneration === this._deviceGeneration &&
                !this._inspectionFailuresReported.has(path)) {
                logDebug(`Could not monitor ${path}`, error);
                this._inspectionFailuresReported.add(path);
            }
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
        this._fullChargePending = false;

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
            this._rediscoverDevice();
            return;
        }

        if (changed.lookup_value('ChargeThresholdSupported', null)) {
            if (!deviceProxy.ChargeThresholdSupported) {
                this._rediscoverDevice();
                return;
            }
            this._emitThresholdState();
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
        const reachedFullPercentage = previousPercentage !== null &&
            previousPercentage < 100.0 && percentage >= 100.0;
        const fullyCharged =
            (percentageChanged && reachedFullPercentage &&
                isChargingState(state)) ||
            (stateChanged && isChargingState(state) &&
                (reachedFullPercentage || this._fullChargePending));

        if (percentageChanged && reachedFullPercentage && !fullyCharged)
            this._fullChargePending = true;
        if ((percentageChanged && percentage < 100.0) ||
            disconnected || fullyCharged)
            this._fullChargePending = false;

        if (stateChanged)
            this._previousState = state;
        if (percentageChanged || reachedFullPercentage)
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

    private _rediscoverDevice(): void {
        this._unwatchDevice();
        const cancellable = this._cancellable;
        if (cancellable)
            this._queueDiscovery(cancellable);
    }

    private _emitThresholdState(): void {
        const deviceProxy = this._deviceProxy;

        try {
            this._callbacks.onThresholdChanged(
                deviceProxy?.ChargeThresholdSupported
                    ? deviceProxy.ChargeThresholdEnabled
                    : null);
        } catch (error) {
            logError('Failed to synchronize threshold state', error);
        }
    }
}
