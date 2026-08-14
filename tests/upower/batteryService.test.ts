import {beforeEach, describe, expect, it, vi} from 'vitest';

import {Cancellable} from '../mocks/gio.js';
import {
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
    } as const,
    createUPowerProxy: proxyMocks.createUPowerProxy,
    createUPowerDeviceProxy: proxyMocks.createUPowerDeviceProxy,
}));

import {
    BatteryService,
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
        typeof vi.fn<(thresholdEnabled: boolean) => void>
    >;
    onChargeCycleEnded: ReturnType<typeof vi.fn<() => void>>;
}

function createCallbacks(): TestCallbacks {
    return {
        onThresholdChanged: vi.fn<(thresholdEnabled: boolean) => void>(),
        onChargeCycleEnded: vi.fn<() => void>(),
    };
}

async function startWithDevice(
    deviceProxy = new FakeUPowerDeviceProxy()
): Promise<ServiceHarness> {
    const rootProxy = new FakeUPowerProxy();
    rootProxy.EnumerateDevicesAsync.mockResolvedValue([['/battery']]);
    proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
    proxyMocks.createUPowerDeviceProxy.mockResolvedValue(deviceProxy);
    const callbacks = createCallbacks();
    const service = new BatteryService(callbacks);

    service.start();
    await vi.waitFor(() => {
        expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(
            deviceProxy.ChargeThresholdEnabled);
    });

    return {service, rootProxy, deviceProxy, callbacks};
}

describe('BatteryService discovery and lifecycle', () => {
    beforeEach(() => {
        proxyMocks.createUPowerProxy.mockReset();
        proxyMocks.createUPowerDeviceProxy.mockReset();
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
        const service = new BatteryService(callbacks);

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

    it('reports a root proxy failure while the service is active', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        proxyMocks.createUPowerProxy.mockRejectedValue('UPower is offline');
        const service = new BatteryService(createCallbacks());

        service.start();

        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                '[BatteryBoost] Failed to connect to UPower: UPower is offline');
        });
    });

    it('reports enumeration failures without attempting device proxies', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockRejectedValue(
            new Error('enumeration denied'));
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        const service = new BatteryService(createCallbacks());

        service.start();

        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                '[BatteryBoost] EnumerateDevices failed: enumeration denied');
        });
        expect(proxyMocks.createUPowerDeviceProxy).not.toHaveBeenCalled();
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
        const service = new BatteryService(callbacks);

        service.start();

        await vi.waitFor(() => {
            expect(callbacks.onThresholdChanged).toHaveBeenCalledWith(true);
        });
        expect(consoleDebug).toHaveBeenCalledWith(
            '[BatteryBoost] Could not inspect /broken: device disappeared');
        expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledTimes(2);
    });

    it('ignores a proxy that completes after its device was removed', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([[]]);
        const pendingDevice = deferred<FakeUPowerDeviceProxy>();
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockReturnValue(
            pendingDevice.promise);
        const callbacks = createCallbacks();
        const service = new BatteryService(callbacks);
        service.start();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });

        rootProxy.emit('DeviceAdded', '/pending-battery');
        rootProxy.emit('DeviceRemoved', '/pending-battery');
        const removedDevice = new FakeUPowerDeviceProxy();
        pendingDevice.resolve(removedDevice);

        await vi.waitFor(() => {
            expect(proxyMocks.createUPowerDeviceProxy).toHaveBeenCalledOnce();
        });
        await Promise.resolve();
        expect(removedDevice.connect).not.toHaveBeenCalled();
        expect(callbacks.onThresholdChanged).not.toHaveBeenCalled();
    });

    it('handles hotplug replacement and releases every connected signal on stop', async () => {
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync
            .mockResolvedValueOnce([[]])
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
        const service = new BatteryService(callbacks);
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

        expect(firstBattery.disconnect).toHaveBeenCalledWith(17);
        expect(replacement.disconnect).toHaveBeenCalledWith(17);
        expect(rootProxy.disconnectSignal).toHaveBeenCalledTimes(2);
        const cancellable = proxyMocks.createUPowerProxy.mock.calls[0][0];
        expect(cancellable.cancelled).toBe(true);
    });

    it('suppresses inspection errors from a device removed while initializing', async () => {
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(
            () => {});
        const rootProxy = new FakeUPowerProxy();
        rootProxy.EnumerateDevicesAsync.mockResolvedValue([[]]);
        const pendingDevice = deferred<FakeUPowerDeviceProxy>();
        proxyMocks.createUPowerProxy.mockResolvedValue(rootProxy);
        proxyMocks.createUPowerDeviceProxy.mockReturnValue(
            pendingDevice.promise);
        const service = new BatteryService(createCallbacks());
        service.start();
        await vi.waitFor(() => {
            expect(rootProxy.EnumerateDevicesAsync).toHaveBeenCalledOnce();
        });

        rootProxy.emit('DeviceAdded', '/pending-battery');
        rootProxy.emit('DeviceRemoved', '/pending-battery');
        pendingDevice.reject(new Error('removed during inspection'));
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleDebug).not.toHaveBeenCalled();
    });

    it('does not attach a root proxy that resolves after stop', async () => {
        const pendingRoot = deferred<FakeUPowerProxy>();
        proxyMocks.createUPowerProxy.mockReturnValue(pendingRoot.promise);
        const service = new BatteryService(createCallbacks());
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
});

describe('BatteryService battery transitions', () => {
    beforeEach(() => {
        proxyMocks.createUPowerProxy.mockReset();
        proxyMocks.createUPowerDeviceProxy.mockReset();
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

    it('emits threshold changes and replaces a battery that becomes absent', async () => {
        const harness = await startWithDevice();
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
        expect(harness.deviceProxy.disconnect).toHaveBeenCalledWith(17);
    });
});

describe('BatteryService threshold operations', () => {
    beforeEach(() => {
        proxyMocks.createUPowerProxy.mockReset();
        proxyMocks.createUPowerDeviceProxy.mockReset();
    });

    it('rejects when no battery is available', async () => {
        const service = new BatteryService(createCallbacks());

        await expect(service.setThresholdEnabled(true)).rejects.toThrow(
            'No battery found');
    });

    it('rejects unsupported charge thresholds without making a remote call', async () => {
        const harness = await startWithDevice(new FakeUPowerDeviceProxy({
            thresholdSupported: false,
        }));

        await expect(harness.service.setThresholdEnabled(false)).rejects
            .toThrow('Battery charge thresholds are not supported');
        expect(harness.deviceProxy.EnableChargeThresholdRemote)
            .not.toHaveBeenCalled();
    });

    it('resolves true after the current remote operation succeeds', async () => {
        const harness = await startWithDevice();

        const operation = harness.service.setThresholdEnabled(false);
        expect(harness.deviceProxy.EnableChargeThresholdRemote)
            .toHaveBeenCalledWith(false, expect.any(Function));
        harness.deviceProxy.completeThreshold(0);

        await expect(operation).resolves.toBe(true);
    });

    it('propagates asynchronous and synchronous remote failures', async () => {
        const harness = await startWithDevice();
        const remoteFailure = new Error('permission denied');

        const asynchronous = harness.service.setThresholdEnabled(false);
        harness.deviceProxy.completeThreshold(0, remoteFailure);
        await expect(asynchronous).rejects.toBe(remoteFailure);

        harness.deviceProxy.throwWhenSettingThreshold = 'D-Bus disconnected';
        await expect(harness.service.setThresholdEnabled(true)).rejects.toBe(
            'D-Bus disconnected');
    });

    it('marks an earlier operation stale when a newer request starts', async () => {
        const harness = await startWithDevice();

        const earlier = harness.service.setThresholdEnabled(false);
        const current = harness.service.setThresholdEnabled(true);
        harness.deviceProxy.completeThreshold(0);
        harness.deviceProxy.completeThreshold(1);

        await expect(earlier).resolves.toBe(false);
        await expect(current).resolves.toBe(true);
    });

    it('marks a pending operation stale when the service stops', async () => {
        const harness = await startWithDevice();

        const operation = harness.service.setThresholdEnabled(false);
        harness.service.stop();
        harness.deviceProxy.completeThreshold(0, new Error('cancelled'));

        await expect(operation).resolves.toBe(false);
    });
});
