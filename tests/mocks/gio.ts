import {vi} from 'vitest';

export class Cancellable {
    cancelled = false;

    cancel(): void {
        this.cancelled = true;
    }
}

export const DBUS_SYSTEM = Object.freeze({kind: 'system-bus'});

export class ThemedIcon {
    readonly name: string;

    constructor(properties: {name: string}) {
        this.name = properties.name;
    }
}

export interface ProxyWrapperRecord {
    interfaceXml: string;
    newAsync: ReturnType<typeof vi.fn>;
}

export const proxyWrapperRecords: ProxyWrapperRecord[] = [];

export const makeProxyWrapper = vi.fn((interfaceXml: string) => {
    const record: ProxyWrapperRecord = {
        interfaceXml,
        newAsync: vi.fn(),
    };
    proxyWrapperRecords.push(record);
    return record;
});

const Gio = {
    Cancellable,
    ThemedIcon,
    DBus: {
        system: DBUS_SYSTEM,
    },
    DBusProxy: {
        makeProxyWrapper,
    },
    SettingsBindFlags: {
        DEFAULT: 0,
    },
};

export default Gio;
