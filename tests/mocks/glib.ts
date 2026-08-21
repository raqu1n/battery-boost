import {vi} from 'vitest';

interface Timeout {
    id: number;
    callback: () => boolean;
}

let nextTimeoutId = 1;
const timeouts = new Map<number, Timeout>();

export const timeoutAddSeconds = vi.fn((
    _priority: number,
    _interval: number,
    callback: () => boolean
): number => {
    const id = nextTimeoutId++;
    timeouts.set(id, {id, callback});
    return id;
});

export const sourceRemove = vi.fn((id: number): boolean =>
    timeouts.delete(id));

export function runNextTimeout(): void {
    const timeout = timeouts.values().next().value as Timeout | undefined;
    if (!timeout)
        throw new Error('No GLib timeout is pending');

    timeouts.delete(timeout.id);
    timeout.callback();
}

export function resetTimeouts(): void {
    timeouts.clear();
    nextTimeoutId = 1;
}

const GLib = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    timeout_add_seconds: timeoutAddSeconds,
    Source: {
        remove: sourceRemove,
    },
};

export default GLib;
