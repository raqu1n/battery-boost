import type Gio from 'gi://Gio';

import {beforeEach, describe, expect, it} from 'vitest';

import {
    Cancellable,
    DBUS_SYSTEM,
    proxyWrapperRecords,
} from '../mocks/gio.js';
import {
    createUPowerDeviceProxy,
    createUPowerProxy,
} from '../../src/upower/proxies.js';

describe('UPower proxy factories', () => {
    beforeEach(() => {
        for (const record of proxyWrapperRecords)
            record.newAsync.mockReset();
    });

    it('defines wrappers for the root and device UPower interfaces', () => {
        expect(proxyWrapperRecords).toHaveLength(2);
        expect(proxyWrapperRecords[0].interfaceXml).toContain(
            'interface name="org.freedesktop.UPower"');
        expect(proxyWrapperRecords[0].interfaceXml).toContain(
            'method name="EnumerateDevices"');
        expect(proxyWrapperRecords[1].interfaceXml).toContain(
            'interface name="org.freedesktop.UPower.Device"');
        expect(proxyWrapperRecords[1].interfaceXml).toContain(
            'method name="EnableChargeThreshold"');
        expect(proxyWrapperRecords[1].interfaceXml).toContain(
            'property name="ChargeThresholdSupported"');
    });

    it('creates the root proxy on the system bus', async () => {
        const cancellable = new Cancellable() as unknown as Gio.Cancellable;
        const expectedProxy = {kind: 'root-proxy'};
        proxyWrapperRecords[0].newAsync.mockResolvedValue(expectedProxy);

        await expect(createUPowerProxy(cancellable)).resolves.toBe(
            expectedProxy);
        expect(proxyWrapperRecords[0].newAsync).toHaveBeenCalledWith(
            DBUS_SYSTEM,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
            cancellable
        );
    });

    it('creates a device proxy for the requested object path', async () => {
        const expectedProxy = {kind: 'device-proxy'};
        proxyWrapperRecords[1].newAsync.mockResolvedValue(expectedProxy);

        await expect(createUPowerDeviceProxy(
            '/org/freedesktop/UPower/devices/battery_BAT1',
            null
        )).resolves.toBe(expectedProxy);
        expect(proxyWrapperRecords[1].newAsync).toHaveBeenCalledWith(
            DBUS_SYSTEM,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/battery_BAT1',
            null
        );
    });

    it('propagates asynchronous proxy construction failures', async () => {
        const failure = new Error('system bus unavailable');
        proxyWrapperRecords[0].newAsync.mockRejectedValue(failure);

        const cancellable = new Cancellable() as unknown as Gio.Cancellable;
        await expect(createUPowerProxy(cancellable)).rejects.toBe(failure);
    });
});
