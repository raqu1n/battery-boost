import {vi} from 'vitest';

interface Initializable {
    _init?: (...args: unknown[]) => void;
}

type InitializableConstructor = new() => Initializable;

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

export const signalHandlerBlock = vi.fn();
export const signalHandlerUnblock = vi.fn();

const GObject = {
    registerClass,
    signal_handler_block: signalHandlerBlock,
    signal_handler_unblock: signalHandlerUnblock,
};

export default GObject;
