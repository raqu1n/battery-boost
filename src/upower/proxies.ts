import Gio from 'gi://Gio';
import type GLib from 'gi://GLib';

const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
const UPOWER_OBJECT_PATH = '/org/freedesktop/UPower';

export const BATTERY_DEVICE_TYPE = 2;

export const DeviceState = Object.freeze({
    CHARGING: 1,
    DISCHARGING: 2,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
} as const);

const UPowerIface = `
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg type="ao" direction="out"/>
    </method>
    <signal name="DeviceAdded">
      <arg type="o"/>
    </signal>
    <signal name="DeviceRemoved">
      <arg type="o"/>
    </signal>
  </interface>
</node>`;

const UPowerDeviceIface = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <method name="EnableChargeThreshold">
      <arg type="b" direction="in"/>
    </method>
    <property name="Type" type="u" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="ChargeThresholdEnabled" type="b" access="read"/>
    <property name="ChargeThresholdSupported" type="b" access="read"/>
  </interface>
</node>`;

type UPowerSignal = 'DeviceAdded' | 'DeviceRemoved';

export interface UPowerProxy {
    EnumerateDevicesAsync(
        cancellable: Gio.Cancellable | null
    ): Promise<[string[]]>;
    connectSignal(
        signal: UPowerSignal,
        callback: (
            proxy: UPowerProxy,
            sender: string,
            parameters: [string]
        ) => void
    ): number;
    disconnectSignal(handlerId: number): void;
}

export interface UPowerDeviceProxy {
    readonly Type: number;
    readonly PowerSupply: boolean;
    readonly State: number;
    readonly Percentage: number;
    readonly IsPresent: boolean;
    readonly ChargeThresholdEnabled: boolean;
    readonly ChargeThresholdSupported: boolean;

    EnableChargeThresholdRemote(
        enabled: boolean,
        callback: (result: unknown, error: unknown | null) => void
    ): void;
    connect(
        signal: 'g-properties-changed',
        callback: (
            proxy: UPowerDeviceProxy,
            changed: GLib.Variant
        ) => void
    ): number;
    disconnect(handlerId: number): void;
}

interface AsyncProxyConstructor<T> {
    newAsync(
        connection: Gio.DBusConnection,
        busName: string,
        objectPath: string,
        cancellable: Gio.Cancellable | null
    ): Promise<T>;
}

function makeAsyncProxy<T>(interfaceXml: string): AsyncProxyConstructor<T> {
    // makeProxyWrapper() creates members from XML at runtime, which TypeScript
    // cannot infer. Keep that assertion at this boundary and type all uses.
    return Gio.DBusProxy.makeProxyWrapper(interfaceXml) as unknown as
        AsyncProxyConstructor<T>;
}

const UPowerProxyConstructor = makeAsyncProxy<UPowerProxy>(UPowerIface);
const UPowerDeviceProxyConstructor = makeAsyncProxy<UPowerDeviceProxy>(
    UPowerDeviceIface);

export function createUPowerProxy(
    cancellable: Gio.Cancellable
): Promise<UPowerProxy> {
    return UPowerProxyConstructor.newAsync(
        Gio.DBus.system,
        UPOWER_BUS_NAME,
        UPOWER_OBJECT_PATH,
        cancellable
    );
}

export function createUPowerDeviceProxy(
    devicePath: string,
    cancellable: Gio.Cancellable | null
): Promise<UPowerDeviceProxy> {
    return UPowerDeviceProxyConstructor.newAsync(
        Gio.DBus.system,
        UPOWER_BUS_NAME,
        devicePath,
        cancellable
    );
}
