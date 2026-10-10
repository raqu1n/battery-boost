import {vi} from 'vitest';

export const addExternalIndicator = vi.fn();
export const notify = vi.fn();
export const showOSD = vi.fn();

export const osdWindowManager = {
    showAll: showOSD,
};

export const panel = {
    statusArea: {
        quickSettings: {
            addExternalIndicator,
        },
    },
};
