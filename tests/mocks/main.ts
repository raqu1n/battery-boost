import {vi} from 'vitest';

export const addExternalIndicator = vi.fn();
export const notify = vi.fn();

export const panel = {
    statusArea: {
        quickSettings: {
            addExternalIndicator,
        },
    },
};
