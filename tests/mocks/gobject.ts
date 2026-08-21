import {vi} from 'vitest';

interface Initializable {
    _init?: (...args: unknown[]) => void;
}

type InitializableConstructor = new() => Initializable;

const blockedObjects = new WeakSet<object>();

export const registerClass = vi.fn(<T extends InitializableConstructor>(
    registeredClass: T
): T => {
    return new Proxy(registeredClass, {
        construct(target, args) {
            const instance = Reflect.construct(target, [], target) as
                Initializable;
            instance._init?.(...args);
            return instance;
        },
    });
});

export const signalHandlerBlock = vi.fn((object: object): void => {
    blockedObjects.add(object);
});
export const signalHandlerUnblock = vi.fn((object: object): void => {
    blockedObjects.delete(object);
});

export function isSignalHandlerBlocked(object: object): boolean {
    return blockedObjects.has(object);
}

const GObject = {
    registerClass,
    signal_handler_block: signalHandlerBlock,
    signal_handler_unblock: signalHandlerUnblock,
};

export default GObject;
