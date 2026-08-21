import {vi} from 'vitest';

type RootSignal = 'DeviceAdded' | 'DeviceRemoved';
type RootSignalCallback = (
    proxy: FakeUPowerProxy,
    sender: string,
    parameters: [string]
) => void;

type NameOwnerCallback = (proxy: FakeUPowerProxy) => void;

type DeviceChangedCallback = (
    proxy: FakeUPowerDeviceProxy,
    changed: FakeChangedProperties
) => void;

interface ThresholdOperation {
    resolve(result: []): void;
    reject(error: unknown): void;
}

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
    g_name_owner: string | null = 'org.freedesktop.UPower.owner';
    private readonly _signals = new Map<
        RootSignal,
        {handlerId: number; callback: RootSignalCallback}
    >();
    private _nextSignalId = 1;
    private _nameOwnerConnection: {
        handlerId: number;
        callback: NameOwnerCallback;
    } | null = null;

    EnumerateDevicesAsync = vi.fn(
        async (
            cancellable: {cancelled: boolean} | null = null
        ): Promise<[string[]]> => {
            if (cancellable?.cancelled)
                throw new Error('Operation cancelled');

            return [[]];
        }
    );

    connectSignal = vi.fn((
        signal: RootSignal,
        callback: RootSignalCallback
    ): number => {
        const handlerId = this._nextSignalId++;
        this._signals.set(signal, {handlerId, callback});
        return handlerId;
    });

    connect = vi.fn((
        _signal: 'notify::g-name-owner',
        callback: NameOwnerCallback
    ): number => {
        const handlerId = this._nextSignalId++;
        this._nameOwnerConnection = {handlerId, callback};
        return handlerId;
    });

    disconnect = vi.fn((handlerId: number): void => {
        if (this._nameOwnerConnection?.handlerId === handlerId)
            this._nameOwnerConnection = null;
    });

    disconnectSignal = vi.fn((handlerId: number): void => {
        for (const [signal, connection] of this._signals) {
            if (connection.handlerId === handlerId)
                this._signals.delete(signal);
        }
    });

    emit(signal: RootSignal, devicePath: string): void {
        const connection = this._signals.get(signal);
        if (!connection)
            throw new Error(`Signal ${signal} is not connected`);

        connection.callback(this, 'org.freedesktop.UPower', [devicePath]);
    }

    emitNameOwner(owner: string | null): void {
        this.g_name_owner = owner;
        this._nameOwnerConnection?.callback(this);
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
    readonly changedHandlerId = 17;
    readonly thresholdOperations: ThresholdOperation[] = [];
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

    EnableChargeThresholdAsync = vi.fn((_enabled: boolean): Promise<[]> => {
        if (this.throwWhenSettingThreshold)
            throw this.throwWhenSettingThreshold;

        const operation = deferred<[]>();
        this.thresholdOperations.push(operation);
        return operation.promise;
    });

    connect = vi.fn((
        _signal: 'g-properties-changed',
        callback: DeviceChangedCallback
    ): number => {
        this._changedCallback = callback;
        return this.changedHandlerId;
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
        const operation = this.thresholdOperations[callbackIndex];
        if (!operation)
            throw new Error(`Threshold operation ${callbackIndex} is missing`);

        if (error === null)
            operation.resolve([]);
        else
            operation.reject(error);
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
