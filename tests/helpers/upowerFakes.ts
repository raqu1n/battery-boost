import {vi} from 'vitest';

type RootSignal = 'DeviceAdded' | 'DeviceRemoved';
type RootSignalCallback = (
    proxy: FakeUPowerProxy,
    sender: string,
    parameters: [string]
) => void;

type DeviceChangedCallback = (
    proxy: FakeUPowerDeviceProxy,
    changed: FakeChangedProperties
) => void;

type ThresholdCallback = (result: unknown, error: unknown | null) => void;

export class FakeChangedProperties {
    private readonly _changedNames: Set<string>;

    constructor(changedNames: string[]) {
        this._changedNames = new Set(changedNames);
    }

    lookup_value(name: string): object | null {
        return this._changedNames.has(name) ? {} : null;
    }
}

export class FakeUPowerProxy {
    private readonly _signals = new Map<RootSignal, RootSignalCallback>();
    private _nextSignalId = 1;

    EnumerateDevicesAsync = vi.fn(
        async (): Promise<[string[]]> => [[]]
    );

    connectSignal = vi.fn((
        signal: RootSignal,
        callback: RootSignalCallback
    ): number => {
        this._signals.set(signal, callback);
        return this._nextSignalId++;
    });

    disconnectSignal = vi.fn((_handlerId: number): void => {});

    emit(signal: RootSignal, devicePath: string): void {
        const callback = this._signals.get(signal);
        if (!callback)
            throw new Error(`Signal ${signal} is not connected`);

        callback(this, 'org.freedesktop.UPower', [devicePath]);
    }
}

export interface FakeDeviceOptions {
    type?: number;
    powerSupply?: boolean;
    state?: number;
    percentage?: number;
    present?: boolean;
    thresholdEnabled?: boolean;
    thresholdSupported?: boolean;
}

export class FakeUPowerDeviceProxy {
    Type: number;
    PowerSupply: boolean;
    State: number;
    Percentage: number;
    IsPresent: boolean;
    ChargeThresholdEnabled: boolean;
    ChargeThresholdSupported: boolean;
    throwWhenSettingThreshold: unknown | null = null;
    readonly thresholdCallbacks: ThresholdCallback[] = [];
    private _changedCallback: DeviceChangedCallback | null = null;

    constructor(options: FakeDeviceOptions = {}) {
        this.Type = options.type ?? 2;
        this.PowerSupply = options.powerSupply ?? true;
        this.State = options.state ?? 1;
        this.Percentage = options.percentage ?? 50;
        this.IsPresent = options.present ?? true;
        this.ChargeThresholdEnabled = options.thresholdEnabled ?? true;
        this.ChargeThresholdSupported = options.thresholdSupported ?? true;
    }

    EnableChargeThresholdRemote = vi.fn((
        _enabled: boolean,
        callback: ThresholdCallback
    ): void => {
        if (this.throwWhenSettingThreshold)
            throw this.throwWhenSettingThreshold;

        this.thresholdCallbacks.push(callback);
    });

    connect = vi.fn((
        _signal: 'g-properties-changed',
        callback: DeviceChangedCallback
    ): number => {
        this._changedCallback = callback;
        return 17;
    });

    disconnect = vi.fn((_handlerId: number): void => {
        this._changedCallback = null;
    });

    emitChanged(...changedNames: string[]): void {
        if (!this._changedCallback)
            throw new Error('Device property signal is not connected');

        this._changedCallback(
            this,
            new FakeChangedProperties(changedNames)
        );
    }

    completeThreshold(
        callbackIndex: number,
        error: unknown | null = null
    ): void {
        const callback = this.thresholdCallbacks[callbackIndex];
        if (!callback)
            throw new Error(`Threshold callback ${callbackIndex} is missing`);

        callback([], error);
    }
}

export interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });

    return {
        promise,
        resolve: resolvePromise,
        reject: rejectPromise,
    };
}
