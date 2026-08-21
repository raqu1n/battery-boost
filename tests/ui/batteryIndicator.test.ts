import type Gio from 'gi://Gio';

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {createBatteryIndicator} from '../../src/ui/batteryIndicator.js';

interface TestToggle {
    initializationProperties: Record<string, unknown>;
    destroyed: boolean;
}

interface TestIndicator {
    quickSettingsItems: TestToggle[];
    destroyed: boolean;
    destroy(): void;
}

function asSettings(bind: ReturnType<typeof vi.fn>): Gio.Settings {
    return {bind} as unknown as Gio.Settings;
}

describe('createBatteryIndicator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('constructs the toggle, binds it to the requested setting, and destroys it', () => {
        const bind = vi.fn();

        const indicator = createBatteryIndicator(
            asSettings(bind)
        ) as unknown as TestIndicator;

        expect(indicator.quickSettingsItems).toHaveLength(1);
        const [toggle] = indicator.quickSettingsItems;
        expect(toggle.initializationProperties).toEqual({
            title: 'Battery Boost',
            iconName: 'battery-full-symbolic',
            toggleMode: true,
        });
        expect(bind).toHaveBeenCalledWith(
            'boost-enabled',
            toggle,
            'checked',
            0
        );

        indicator.destroy();

        expect(toggle.destroyed).toBe(true);
        expect(indicator.destroyed).toBe(true);
    });

    it('surfaces a settings binding failure', () => {
        const bind = vi.fn(() => {
            throw new Error('schema key is unavailable');
        });

        expect(() => createBatteryIndicator(
            asSettings(bind)
        )).toThrow('schema key is unavailable');
    });
});
