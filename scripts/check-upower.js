import Gio from 'gi://Gio';

import {
    BATTERY_DEVICE_TYPE,
    createUPowerDeviceProxy,
    createUPowerProxy,
} from '../build/upower/proxies.js';

const cancellable = new Gio.Cancellable();

try {
    const upower = await createUPowerProxy(cancellable);
    const [devicePaths] = await upower.EnumerateDevicesAsync(cancellable);

    let batteryCount = 0;
    for (const devicePath of devicePaths) {
        const device = await createUPowerDeviceProxy(
            devicePath,
            cancellable
        );

        if (device.Type !== BATTERY_DEVICE_TYPE ||
            !device.PowerSupply || !device.IsPresent)
            continue;

        batteryCount++;
        print(`${devicePath}: threshold support=${device.ChargeThresholdSupported}`);
    }

    if (batteryCount === 0)
        print('UPower is available, but no present system battery was found.');
} catch (error) {
    printerr(`UPower smoke test failed: ${error}`);
    throw error;
}
