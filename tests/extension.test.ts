import type Gio from 'gi://Gio';

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
    isSignalHandlerBlocked,
    signalHandlerBlock,
    signalHandlerUnblock,
} from './mocks/gobject.js';
import {addExternalIndicator, notify} from './mocks/main.js';
import {deferred} from './helpers/upowerFakes.js';

interface ServiceCallbacks {
    onThresholdChanged(thresholdEnabled: boolean): void;
    onChargeCycleEnded(): void;
}

const batteryServiceMock = vi.hoisted(() => {
    class MockBatteryService {
        readonly callbacks: ServiceCallbacks;
        readonly start = vi.fn();
        readonly stop = vi.fn();
        readonly setThresholdEnabled = vi.fn<
            (enabled: boolean) => Promise<boolean>
        >();

        constructor(callbacks: ServiceCallbacks) {
            this.callbacks = callbacks;
            batteryServiceMock.instances.push(this);
        }
    }

    return {
        MockBatteryService,
        instances: [] as MockBatteryService[],
    };
});

const indicatorMock = vi.hoisted(() => ({
    createBatteryIndicator: vi.fn(),
}));

vi.mock('../src/upower/batteryService.js', () => ({
    BatteryService: batteryServiceMock.MockBatteryService,
}));

vi.mock('../src/ui/batteryIndicator.js', () => ({
    createBatteryIndicator: indicatorMock.createBatteryIndicator,
}));

import BatteryBoostExtension from '../src/extension.js';

class FakeSettings {
    value: boolean;
    readonly changedHandlerId = 41;
    private _changedCallback: (() => unknown) | null = null;

    constructor(initialValue: boolean) {
        this.value = initialValue;
    }

    connect = vi.fn((signal: string, callback: () => unknown): number => {
        expect(signal).toBe('changed::boost-enabled');
        this._changedCallback = callback;
        return this.changedHandlerId;
    });

    disconnect = vi.fn((handlerId: number): void => {
        expect(handlerId).toBe(this.changedHandlerId);
        this._changedCallback = null;
    });

    get_boolean = vi.fn((_key: string): boolean => this.value);

    set_boolean = vi.fn((_key: string, value: boolean): void => {
        const changed = this.value !== value;
        this.value = value;

        if (changed && !isSignalHandlerBlocked(this))
            void this._changedCallback?.();
    });

    emitChanged(): unknown {
        if (!this._changedCallback)
            throw new Error('Settings change handler is not connected');

        return this._changedCallback();
    }

    captureChangedCallback(): () => unknown {
        if (!this._changedCallback)
            throw new Error('Settings change handler is not connected');

        return this._changedCallback;
    }
}

interface FakeIndicator {
    destroy: ReturnType<typeof vi.fn<() => void>>;
}

interface ExtensionHarness {
    extension: BatteryBoostExtension;
    settings: FakeSettings;
    service: InstanceType<typeof batteryServiceMock.MockBatteryService>;
    indicator: FakeIndicator;
}

function enableExtension(initialSetting = false): ExtensionHarness {
    const settings = new FakeSettings(initialSetting);
    const indicator: FakeIndicator = {destroy: vi.fn()};
    indicatorMock.createBatteryIndicator.mockReturnValue(indicator);
    const extension = new BatteryBoostExtension({} as never);
    vi.spyOn(extension, 'getSettings').mockReturnValue(
        settings as unknown as Gio.Settings);

    extension.enable();

    const service = batteryServiceMock.instances[0];
    if (!service)
        throw new Error('BatteryService was not constructed');

    return {extension, settings, service, indicator};
}

describe('BatteryBoostExtension lifecycle and synchronization', () => {
    beforeEach(() => {
        batteryServiceMock.instances.length = 0;
        indicatorMock.createBatteryIndicator.mockReset();
    });

    it('connects settings, creates the UI and service, and starts monitoring', () => {
        const harness = enableExtension();

        expect(harness.settings.connect).toHaveBeenCalledWith(
            'changed::boost-enabled',
            expect.any(Function)
        );
        expect(indicatorMock.createBatteryIndicator).toHaveBeenCalledWith(
            harness.settings
        );
        expect(addExternalIndicator).toHaveBeenCalledWith(harness.indicator);
        expect(harness.service.start).toHaveBeenCalledOnce();
    });

    it('cleans up resources when enabling the UI fails', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const settings = new FakeSettings(false);
        const extension = new BatteryBoostExtension({} as never);
        vi.spyOn(extension, 'getSettings').mockReturnValue(
            settings as unknown as Gio.Settings);
        indicatorMock.createBatteryIndicator.mockImplementationOnce(() => {
            throw new Error('indicator setup failed');
        });

        expect(() => extension.enable()).toThrow('indicator setup failed');

        const service = batteryServiceMock.instances[0];
        expect(service?.stop).toHaveBeenCalledOnce();
        expect(settings.disconnect).toHaveBeenCalledWith(
            settings.changedHandlerId
        );
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining(
                '[BatteryBoost] Failed to enable extension: Error: indicator setup failed'
            )
        );
    });

    it('synchronizes an external threshold change without applying it again', () => {
        const harness = enableExtension(false);

        harness.service.callbacks.onThresholdChanged(false);

        expect(signalHandlerBlock).toHaveBeenCalledWith(
            harness.settings,
            harness.settings.changedHandlerId
        );
        expect(harness.settings.set_boolean).toHaveBeenCalledWith(
            'boost-enabled',
            true
        );
        expect(signalHandlerUnblock).toHaveBeenCalledWith(
            harness.settings,
            harness.settings.changedHandlerId
        );
        expect(harness.service.setThresholdEnabled).not.toHaveBeenCalled();

        harness.service.callbacks.onThresholdChanged(false);
        expect(harness.settings.set_boolean).toHaveBeenCalledOnce();
    });

    it('always unblocks the settings handler when synchronization fails', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const harness = enableExtension(false);
        harness.settings.set_boolean.mockImplementationOnce(() => {
            throw new Error('settings backend failed');
        });

        expect(() => harness.service.callbacks.onThresholdChanged(false))
            .not.toThrow();
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining(
                '[BatteryBoost] Failed to synchronize battery boost setting: Error: settings backend failed'
            )
        );
        expect(signalHandlerBlock).toHaveBeenCalledWith(
            harness.settings,
            harness.settings.changedHandlerId
        );
        expect(signalHandlerUnblock).toHaveBeenCalledWith(
            harness.settings,
            harness.settings.changedHandlerId
        );
    });

    it('ends boost only when a cycle event arrives while boost is active', () => {
        const harness = enableExtension(true);

        harness.service.callbacks.onChargeCycleEnded();
        harness.service.callbacks.onChargeCycleEnded();

        expect(harness.settings.set_boolean).toHaveBeenCalledOnce();
        expect(harness.settings.set_boolean).toHaveBeenCalledWith(
            'boost-enabled',
            false
        );
    });

    it('stops monitoring and releases settings and UI resources on disable', () => {
        const harness = enableExtension();
        const queuedSettingsCallback = harness.settings
            .captureChangedCallback();

        harness.extension.disable();

        expect(harness.service.stop).toHaveBeenCalledOnce();
        expect(harness.settings.disconnect).toHaveBeenCalledWith(
            harness.settings.changedHandlerId
        );
        expect(harness.indicator.destroy).toHaveBeenCalledOnce();

        harness.service.callbacks.onThresholdChanged(false);
        harness.service.callbacks.onChargeCycleEnded();
        queuedSettingsCallback();
        expect(harness.settings.set_boolean).not.toHaveBeenCalled();
        expect(harness.service.setThresholdEnabled).not.toHaveBeenCalled();
    });

    it('can be disabled safely before it has been enabled', () => {
        const extension = new BatteryBoostExtension({} as never);

        expect(() => extension.disable()).not.toThrow();
    });
});

describe('BatteryBoostExtension mode changes', () => {
    beforeEach(() => {
        batteryServiceMock.instances.length = 0;
        indicatorMock.createBatteryIndicator.mockReset();
    });

    it.each([
        {
            boostEnabled: true,
            thresholdEnabled: false,
            notification: 'Battery boost enabled: charging to 100%',
        },
        {
            boostEnabled: false,
            thresholdEnabled: true,
            notification: 'Battery boost ended — configured limit restored',
        },
    ])('applies and reports a successful mode change: $notification', async ({
        boostEnabled,
        thresholdEnabled,
        notification,
    }) => {
        const harness = enableExtension(boostEnabled);
        harness.service.setThresholdEnabled.mockResolvedValue(true);

        await harness.settings.emitChanged();

        expect(harness.service.setThresholdEnabled).toHaveBeenCalledWith(
            thresholdEnabled);
        expect(notify).toHaveBeenCalledWith('Battery Boost', notification);
    });

    it('rolls back the setting and reports a current operation failure', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const harness = enableExtension(true);
        harness.service.setThresholdEnabled.mockRejectedValue(
            'permission denied');

        await harness.settings.emitChanged();

        expect(consoleError).toHaveBeenCalledWith(
            '[BatteryBoost] Failed to set threshold: permission denied');
        expect(notify).toHaveBeenCalledWith(
            'Battery Boost',
            'Failed to change battery charge limit'
        );
        expect(harness.settings.set_boolean).toHaveBeenCalledWith(
            'boost-enabled',
            false
        );
        expect(signalHandlerBlock).toHaveBeenCalledWith(
            harness.settings,
            harness.settings.changedHandlerId
        );
        expect(signalHandlerUnblock).toHaveBeenCalledWith(
            harness.settings,
            harness.settings.changedHandlerId
        );
    });

    it('does not notify or roll back when the service marks an operation stale', async () => {
        const harness = enableExtension(true);
        harness.service.setThresholdEnabled.mockResolvedValue(false);

        await harness.settings.emitChanged();

        expect(notify).not.toHaveBeenCalled();
        expect(harness.settings.set_boolean).not.toHaveBeenCalled();
    });

    it('ignores an earlier operation after a newer setting change', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const harness = enableExtension(true);
        const earlier = deferred<boolean>();
        const current = deferred<boolean>();
        harness.service.setThresholdEnabled
            .mockReturnValueOnce(earlier.promise)
            .mockReturnValueOnce(current.promise);

        const earlierChange = harness.settings.emitChanged() as Promise<void>;
        harness.settings.value = false;
        const currentChange = harness.settings.emitChanged() as Promise<void>;
        current.resolve(true);
        await currentChange;
        earlier.reject(new Error('late failure'));
        await earlierChange;

        expect(consoleError).not.toHaveBeenCalled();
        expect(harness.settings.set_boolean).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledWith(
            'Battery Boost',
            'Battery boost ended — configured limit restored'
        );
    });

    it('ignores a pending operation that fails after disable', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const harness = enableExtension(true);
        const pending = deferred<boolean>();
        harness.service.setThresholdEnabled.mockReturnValue(pending.promise);
        const modeChange = harness.settings.emitChanged() as Promise<void>;

        harness.extension.disable();
        pending.reject(new Error('cancelled'));
        await modeChange;

        expect(consoleError).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(harness.settings.set_boolean).not.toHaveBeenCalled();
        expect(harness.service.stop).toHaveBeenCalledOnce();
    });

    it('does not notify when a successful operation completes after disable', async () => {
        const harness = enableExtension(true);
        const pending = deferred<boolean>();
        harness.service.setThresholdEnabled.mockReturnValue(pending.promise);
        const modeChange = harness.settings.emitChanged() as Promise<void>;

        harness.extension.disable();
        pending.resolve(true);
        await modeChange;

        expect(notify).not.toHaveBeenCalled();
        expect(harness.settings.set_boolean).not.toHaveBeenCalled();
    });
});
