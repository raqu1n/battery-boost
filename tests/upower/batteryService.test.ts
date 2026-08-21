import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {Cancellable} from '../mocks/gio.js';
import {resetTimeouts, runNextTimeout} from '../mocks/glib.js';
import {
    FakeChangedProperties,
    FakeUPowerDeviceProxy,
    FakeUPowerProxy,
    deferred,
} from '../helpers/upowerFakes.js';

const proxyMocks = vi.hoisted(() => ({
    createUPowerProxy: vi.fn(),
    createUPowerDeviceProxy: vi.fn(),
}));

vi.mock(import('../../src/upower/proxies.js'), () => ({
    BATTERY_DEVICE_TYPE: 2 as const,
    DeviceState: {
        CHARGING: 1,
        DISCHARGING: 2,
        FULLY_CHARGED: 4,
        PENDING_CHARGE: 5,
    } as const,
    createUPowerProxy: proxyMocks.createUPowerProxy,
    createUPowerDeviceProxy: proxyMocks.createUPowerDeviceProxy,
}));

import {
    BatteryService,
    BatteryServiceError,
    type BatteryServiceCallbacks,
} from '../../src/upower/batteryService.js';

interface ServiceHarness {
    service: BatteryService;
    rootProxy: FakeUPowerProxy;
    deviceProxy: FakeUPowerDeviceProxy;
    callbacks: TestCallbacks;
}

interface TestCallbacks extends BatteryServiceCallbacks {
    onThresholdChanged: ReturnType<
        typeof vi.fn<(thresholdEnabled: boolean | null) => void>
    >;
    onChargeCycleEnded: ReturnType<typeof vi.fn<() => void>>;
}

function createCallbacks(): TestCallbacks {
    return {
        onThresholdChanged: vi.fn<(
            thresholdEnabled: boolean | null
        ) => void>(),
        onChargeCycleEnded: vi.fn<() => void>(),
    };
}

const liveServices = new Set<BatteryService>();

function createService(callbacks: BatteryServiceCallbacks): BatteryService {
    const service = new BatteryService(callbacks);
    liveServices.add(service);
    return service;
}

afterEach(() => {
    for (const service of liveServices)
        service.stop();
    liveServices.clear();
});

async function startWithDevice(
    deviceProxy = new FakeUPowerDeviceProxy()
): Promise<ServiceHarness> {
    const rootProxy = new FakeUPowerProxy();
    rootProxy.EnumerateDevicesAsync.mockResolvedValue([['/battery']]);
    proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
    proxyMocks.createUPowerDeviceProxy.mockResolvedValue(deviceProxy);
    const callbacks = createCallbacks();
    const service = createService(callbacks);

    service.start();
    await vi.waitFor(() => {
        expect(deviceProxy.connect).toHaveBeenCalledWith(
            'g-properties-changed',
            expect.any(Function)
        );
    });

    if (deviceProxy.ChargeThresholdSupported) {
        expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(
            deviceProxy.ChargeThresholdEnabled);
    } else {
        expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(null);
    }

    return {service, rootProxy, deviceProxy, callbacks};
}

describe('BatteryService discovery and lifecycle', () => {
    beforeEach(() => {
        proxyMocks.createUPowerProxy.mockReset();
        proxyMocks.createUPowerDeviceProxy.mockReset();
        resetTimeouts();
    });

    it('discovers the first present power-supply battery without starting twice', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([
            ['/mouse', '/peripheral-battery', '/absent-battery', '/battery'],
        ]);
        const mouse = new FakeUPowerDeviceProxy({type: 6});
        const peripheralBattery = new FakeUPowerDeviceProxy({
            powerSupply: false,
        });
        const absentBattery = new FakeUPowerDeviceProxy({present: false});
        const battery = new FakeUPowerDeviceProxy({
            thresholdEnabled: false,
        });
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockImplementation(async (
            path: string
        ) => {
            const devices = new Map([
                ['/mouse', mouse],
                ['/peripheral-battery', peripheralBattery],
                ['/absent-battery', absentBattery],
                ['/battery', battery],
            ]);
            const device = devices.get(path);
            if (!device)
                throw new Error(`Unexpected device path: ${path}`);
            return device;
        });
        const callbacks = createCallbacks();
        const service = createService(callbacks);

        service.start();
        service.start();

        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(false);
        });
        expect(proxyMocks.createUPowerProxy).toHaveBeenCalledTimes(1);
        expect(proxyMocks.createUPowerDeviceProxy.mock.calls.map(
            ([path]) => path)).toEqual([
            '/mouse',
            '/peripheral-battery',
            '/absent-battery',
            '/battery',
        ]);
        expect(battery.connect).toHaveBeenCalledWith(
            'g-properties-changed',
            expect.any(Function)
        );
        const cancellable = proxyMocks.createUPowerProxy.mock.calls[0][0];
        expect(cancellable).toBeInstanceOf(Cancellable);
        expect(cancellable.cancelled).toBe(false);

        rootProxy.emit('DeviceAdded', '/ignored-after-discovery');
        expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledTimes(4);
    });

    it('prefers a threshold-capable battery over an earlier unsupported one', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([
            ['/unsupported', '/supported'],
        ]);
        const unsupported = new FakeUPowerDeviceProxy({
            thresholdSupported: false,
        });
        const supported = new FakeUPowerDeviceProxy({
            thresholdEnabled: false,
        });
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockImplementation(async path =>
            path === '/unsupported' ? unsupported : supported);
        const callbacks = createCallbacks();
        const service = createService(callbacks);

        service.start();

        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(false);
        });
        expect(unsupported.connect).not.toHaveBeenCalled();
        expect(supported.connect).toHaveBeenCalledOnce();
    });

    it('reports an unavailable state for an unsupported battery', async () => {
        const harness = await startWithDevice(new FakeUPowerDeviceProxy({
            thresholdSupported: false,
        }));

        expect(harness.callbacks.onThresholdChanged).toHaveBeenCalledOnce();
        expect(harness.callbacks.onThresholdChanged).toHaveBeenCalledWith(null);
    });

    it('retries a root proxy failure while the service is active', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const rootProxy = new FakeUPowerProxy();
        proxyMocks.createUPowerProxy
            .mockRejectedValueOnce('UPower is offline')
            .mockResolvedValueOnce(rootProxy);
        const service = createService(createCallbacks());

        service.start();

        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                '[BatteryBoost] Failed to connect to UPower: UPower is offline');
        });

        runNextTimeout();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });
    });

    it('retries enumeration failures without attempting stale device proxies', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync
            .mockRejectedValueOnce(new Error('enumeration denied'))
            .mockRejectedValueOnce(new Error('enumeration denied'))
            .mockResolvedValueOnce([[]]);
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        const service = createService(createCallbacks());

        service.start();

        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                expect.stringContaining(
                    '[BatteryBoost] EnumerateDevices failed: Error: enumeration denied'
                )
            );
        });
        expect(proxyMocks.createUPowerDeviceProxy).not.toHaveBeenCalled();

        runNextTimeout();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledTimes(2);
        });
        expect(consoleError).toHaveBeenCalledOnce();

        runNextTimeout();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledTimes(3);
        });
        expect(consoleError).toHaveBeenCalledOnce();
    });

    it('polls while a battery bay is absent and finds it when present', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([['/battery']]);
        const battery = new FakeUPowerDeviceProxy({present: false});
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockResolvedValue(battery);
        const callbacks = createCallbacks();
        const service = createService(callbacks);

        service.start();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });
        expect(battery.connect).not.toHaveBeenCalled();
        expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(null);

        battery.IsPresent = true;
        runNextTimeout();

        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(true);
        });
        expect(battery.connect).toHaveBeenCalledOnce();
    });

    it('drops stale devices and rediscovers after UPower restarts', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([['/battery']]);
        const first = new FakeUPowerDeviceProxy();
        const replacement = new FakeUPowerDeviceProxy({
            thresholdEnabled: false,
        });
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(replacement);
        const callbacks = createCallbacks();
        const service = createService(callbacks);

        service.start();
        await vi.waitFor(() => {
            expect(first.connect).toHaveBeenCalledOnce();
        });

        rootProxy.emitNameOwner(null);
        expect(first.disconnect).toHaveBeenCalledWith(first.changedHandlerId);
        rootProxy.emitNameOwner('org.freedesktop.UPower.new-owner');

        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenLastCalledWith(false);
        });
        expect(replacement.connect).toHaveBeenCalledOnce();
    });

    it('continues discovery after an individual device cannot be inspected', async () => {
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(
            () => {});
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([
            ['/broken', '/battery'],
        ]);
        const battery = new FakeUPowerDeviceProxy();
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy
            .mockRejectedValueOnce(new Error('device disappeared'))
            .mockResolvedValueOnce(battery);
        const callbacks = createCallbacks();
        const service = createService(callbacks);

        service.start();

        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(true);
        });
        expect(consoleDebug).toHaveBeenCalledWith(
            expect.stringContaining(
                '[BatteryBoost] Could not inspect /broken: Error: device disappeared'
            )
        );
        expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledTimes(2);
    });

    it('ignores a proxy that completes after its device was removed', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([['/pending-battery']])
            .mockResolvedValue([[]]);
        const pendingDevice = deferred<FakeUPowerDeviceProxy>();
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockReturnValue(
            pendingDevice.promise);
        const callbacks = createCallbacks();
        const service = createService(callbacks);
        service.start();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });

        rootProxy.emit('DeviceAdded', '/pending-battery');
        await vi.waitFor(() => {
            expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledOnce();
        });
        rootProxy.emit('DeviceRemoved', '/pending-battery');
        const removedDevice = new FakeUPowerDeviceProxy();
        pendingDevice.resolve(removedDevice);

        await Promise.resolve();
        expect(removedDevice.connect).not.toHaveBeenCalled();
        expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(null);
    });

    it('handles hotplug replacement and releases every connected signal on stop', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([['/first']])
            .mockResolvedValueOnce([['/replacement']]);
        const firstBattery = new FakeUPowerDeviceProxy({
            thresholdEnabled: false,
        });
        const replacement = new FakeUPowerDeviceProxy({
            thresholdEnabled: true,
        });
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockImplementation(
            async (path: string) => path === '/first'
                ? firstBattery
                : replacement
        );
        const callbacks = createCallbacks();
        const service = createService(callbacks);
        service.start();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });

        rootProxy.emit('DeviceAdded', '/first');
        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(false);
        });
        rootProxy.emit('DeviceRemoved', '/first');
        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenLastCalledWith(true);
        });

        service.stop();
        service.stop();

        expect(firstBattery.disconnect).toHaveBeenCalledWith(
            firstBattery.changedHandlerId
        );
        expect(replacement.disconnect).toHaveBeenCalledWith(
            replacement.changedHandlerId
        );
        expect(rootProxy.disconnectSignal).toHaveBeenCalledTimes(2);
        const cancellable = proxyMocks.createUPowerProxy.mock.calls[0][0];
        expect(cancellable.cancelled).toBe(true);
    });

    it('suppresses inspection errors from a device removed while initializing', async () => {
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(
            () => {});
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([['/pending-battery']])
            .mockResolvedValue([[]]);
        const pendingDevice = deferred<FakeUPowerDeviceProxy>();
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockReturnValue(
            pendingDevice.promise);
        const service = createService(createCallbacks());
        service.start();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });

        rootProxy.emit('DeviceAdded', '/pending-battery');
        await vi.waitFor(() => {
            expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledOnce();
        });
        rootProxy.emit('DeviceRemoved', '/pending-battery');
        pendingDevice.reject(new Error('removed during inspection'));
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleDebug).not.toHaveBeenCalled();
    });

    it('does not attach a root proxy that resolves after stop', async () => {
        const pendingRoot = deferred<FakeUPowerProxy>();
        proxyMocks.createUPowerProxy.mockReturnValue(pendingRoot.promise);
        const service = createService(createCallbacks());
        service.start();
        const cancellable = proxyMocks.createUPowerProxy.mock.calls[0][0];

        service.stop();
        const rootProxy = new FakeUPowerProxy();
        pendingRoot.resolve(rootProxy);
        await Promise.resolve();
        await Promise.resolve();

        expect(cancellable.cancelled).toBe(true);
        expect(rootProxy.connectSignal).not.toHaveBeenCalled();
        expect(rootProxy.EnumerateDevicesAsync).not.toHaveBeenCalled();
    });

    it('serializes discovery requests raised during initial enumeration', async () => {
        const rootProxy = new FakeUPowerProxy();
        const pendingEnumeration = deferred<[string[]]>();
        const device = new FakeUPowerDeviceProxy();
        rootProxy.EnumerateDevicesAsync.mockReturnValueOnce(
            pendingEnumeration.promise).mockResolvedValueOnce([
            ['/added-battery'],
        ]);
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockResolvedValue(device);
        const service = createService(createCallbacks());

        service.start();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });

        rootProxy.emit('DeviceAdded', '/added-battery');
        expect(proxyMocks.createUPowerDeviceProxy).not.toHaveBeenCalled();

        pendingEnumeration.resolve([[]]);
        await vi.waitFor(() => {
            expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledOnce();
        });
        expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledWith(
            '/added-battery',
            expect.any(Cancellable)
        );
    });

    it('continues discovery when a candidate cannot be monitored', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([['/broken', '/battery']]);
        const broken = new FakeUPowerDeviceProxy();
        broken.connect.mockImplementationOnce(() => {
            throw new Error('signal connection failed');
        });
        const working = new FakeUPowerDeviceProxy();
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy
            .mockResolvedValueOnce(broken)
            .mockResolvedValueOnce(working);
        const callbacks = createCallbacks();
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(
            () => {});
        const service = createService(callbacks);

        service.start();

        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(true);
        });
        expect(consoleDebug).toHaveBeenCalledWith(
            expect.stringContaining(
                '[BatteryBoost] Could not monitor /broken: Error: signal connection failed'
            )
        );
        expect(working.connect).toHaveBeenCalledOnce();
    });

    it('contains callback failures from device signals', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([['/battery']]);
        const device = new FakeUPowerDeviceProxy();
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockResolvedValue(device);
        const callbacks = createCallbacks();
        callbacks.onThresholdChanged.mockImplementation(() => {
            throw new Error('UI synchronization failed');
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const service = createService(callbacks);

        service.start();
        await vi.waitFor(() => {
            expect(device.connect).toHaveBeenCalledOnce();
        });

        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining(
                '[BatteryBoost] Failed to synchronize threshold state: Error: UI synchronization failed'
            )
        );
        device.ChargeThresholdEnabled = false;
        expect(() => device.emitChanged('ChargeThresholdEnabled'))
            .not.toThrow();
    });
});

describe('BatteryService battery transitions', () => {
    beforeEach(() => {
        proxyMocks.createUPowerProxy.mockReset();
        proxyMocks.createUPowerDeviceProxy.mockReset();
        resetTimeouts();
    });

    it('emits one cycle event only when state transitions into discharging', async () => {
        const harness = await startWithDevice(new FakeUPowerDeviceProxy({
            state: 1,
        }));

        harness.deviceProxy.State = 2;
        harness.deviceProxy.emitChanged('State');
        harness.deviceProxy.emitChanged('State');

        expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledOnce();

        harness.deviceProxy.State = 1;
        harness.deviceProxy.emitChanged('State');
        expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledOnce();
    });

    it('requires an upward crossing to 100% while charging or fully charged', async () => {
        const harness = await startWithDevice(new FakeUPowerDeviceProxy({
            state: 1,
            percentage: 99,
        }));

        harness.deviceProxy.Percentage = 100;
        harness.deviceProxy.emitChanged('Percentage');
        harness.deviceProxy.emitChanged('Percentage');
        expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledOnce();

        harness.deviceProxy.Percentage = 99;
        harness.deviceProxy.emitChanged('Percentage');
        harness.deviceProxy.State = 2;
        harness.deviceProxy.Percentage = 100;
        harness.deviceProxy.emitChanged('Percentage');
        expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledOnce();

        harness.deviceProxy.Percentage = 99;
        harness.deviceProxy.emitChanged('Percentage');
        harness.deviceProxy.State = 4;
        harness.deviceProxy.Percentage = 100;
        harness.deviceProxy.emitChanged('Percentage');
        expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledTimes(2);
    });

    it('handles a full-state update that arrives after the percentage update',
        async () => {
            const harness = await startWithDevice(new FakeUPowerDeviceProxy({
                state: 0,
                percentage: 99,
            }));

            harness.deviceProxy.Percentage = 100;
            harness.deviceProxy.emitChanged('Percentage');
            expect(harness.callbacks.onChargeCycleEnded).not.toHaveBeenCalled();

            harness.deviceProxy.State = 4;
            harness.deviceProxy.emitChanged('State');

            expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledOnce();
            harness.deviceProxy.emitChanged('State');
            expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledOnce();
        });

    it('treats a percentage crossing during pending charge as completion',
        async () => {
            const harness = await startWithDevice(new FakeUPowerDeviceProxy({
                state: 5,
                percentage: 99,
            }));

            harness.deviceProxy.Percentage = 100;
            harness.deviceProxy.emitChanged('Percentage');

            expect(harness.callbacks.onChargeCycleEnded).toHaveBeenCalledOnce();
        });

    it('emits threshold changes and replaces a battery that becomes absent', async () => {
        const harness = await startWithDevice();
        const staleCallback = harness.deviceProxy.connect.mock.calls[0][1];
        const replacement = new FakeUPowerDeviceProxy({
            thresholdEnabled: false,
        });
        harness.rootProxy.EnumerateDevicesAsync.mockResolvedValue([
            ['/replacement'],
        ]);
        proxyMocks.createUPowerDeviceProxy.mockResolvedValue(replacement);

        harness.deviceProxy.ChargeThresholdEnabled = false;
        harness.deviceProxy.emitChanged('ChargeThresholdEnabled');
        expect(harness.callbacks.onThresholdChanged).toHaveBeenLastCalledWith(
            false);

        harness.deviceProxy.IsPresent = false;
        harness.deviceProxy.emitChanged('IsPresent');

        await vi.waitFor(() => {
            expect(replacement.connect).toHaveBeenCalledOnce();
        });
        expect(harness.deviceProxy.disconnect).toHaveBeenCalledWith(
            harness.deviceProxy.changedHandlerId
        );

        replacement.State = 2;
        staleCallback(
            harness.deviceProxy,
            new FakeChangedProperties(['State'])
        );
        expect(harness.callbacks.onChargeCycleEnded).not.toHaveBeenCalled();
    });
});

describe('BatteryService threshold operations', () => {
    beforeEach(() => {
        proxyMocks.createUPowerProxy.mockReset();
        proxyMocks.createUPowerDeviceProxy.mockReset();
        resetTimeouts();
    });

    it('rejects when no battery is available', async () => {
        const service = createService(createCallbacks());

        const operation = service.setThresholdEnabled(true);
        await expect(operation).rejects.toBeInstanceOf(BatteryServiceError);
        await expect(operation).rejects.toMatchObject({
            code: 'no-battery',
        });
    });

    it('rejects unsupported charge thresholds without making a remote call', async () => {
        const harness = await startWithDevice(new FakeUPowerDeviceProxy({
            thresholdSupported: false,
        }));

        await expect(harness.service.setThresholdEnabled(false)).rejects
            .toMatchObject({code: 'threshold-unsupported'});
        expect(harness.deviceProxy.EnableChargeThresholdAsync)
            .not.toHaveBeenCalled();
    });

    it('resolves true after the current remote operation succeeds', async () => {
        const harness = await startWithDevice();

        const operation = harness.service.setThresholdEnabled(false);
        await vi.waitFor(() => {
            expect(harness.deviceProxy.EnableChargeThresholdAsync)
                .toHaveBeenCalledWith(false);
        });
        harness.deviceProxy.completeThreshold(0);

        await expect(operation).resolves.toBe(true);
    });

    it('propagates asynchronous and synchronous remote failures', async () => {
        const harness = await startWithDevice();
        const remoteFailure = new Error('permission denied');

        const asynchronous = harness.service.setThresholdEnabled(false);
        await vi.waitFor(() => {
            expect(harness.deviceProxy.EnableChargeThresholdAsync)
                .toHaveBeenCalledOnce();
        });
        harness.deviceProxy.completeThreshold(0, remoteFailure);
        await expect(asynchronous).rejects.toBe(remoteFailure);

        harness.deviceProxy.throwWhenSettingThreshold = 'D-Bus disconnected';
        await expect(harness.service.setThresholdEnabled(true)).rejects.toBe(
            'D-Bus disconnected');
    });

    it('marks an earlier operation stale when a newer request starts', async () => {
        const harness = await startWithDevice();

        const earlier = harness.service.setThresholdEnabled(false);
        await vi.waitFor(() => {
            expect(harness.deviceProxy.EnableChargeThresholdAsync)
                .toHaveBeenCalledWith(false);
        });
        const current = harness.service.setThresholdEnabled(true);
        expect(harness.deviceProxy.EnableChargeThresholdAsync)
            .toHaveBeenCalledOnce();
        harness.deviceProxy.completeThreshold(0);
        await expect(earlier).resolves.toBe(false);

        await vi.waitFor(() => {
            expect(harness.deviceProxy.EnableChargeThresholdAsync)
                .toHaveBeenCalledWith(true);
        });
        harness.deviceProxy.completeThreshold(1);

        await expect(current).resolves.toBe(true);
    });

    it('marks a pending operation stale when the service stops', async () => {
        const harness = await startWithDevice();

        const operation = harness.service.setThresholdEnabled(false);
        await vi.waitFor(() => {
            expect(harness.deviceProxy.EnableChargeThresholdAsync)
                .toHaveBeenCalledOnce();
        });
        harness.service.stop();
        harness.deviceProxy.completeThreshold(0, new Error('cancelled'));

        await expect(operation).resolves.toBe(false);
    });
});
