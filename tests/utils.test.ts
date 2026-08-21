import {describe, expect, it, vi} from 'vitest';

import {errorMessage, logDebug, logError} from '../src/utils.js';

describe('runtime error utilities', () => {
    it('formats error-like values without losing their message', () => {
        expect(errorMessage(new Error('permission denied')))
            .toBe('permission denied');
        expect(errorMessage({message: 'UPower is offline'}))
            .toBe('UPower is offline');
        expect(errorMessage('unknown failure')).toBe('unknown failure');
    });

    it('includes diagnostic details in error and debug logs', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(
            () => {});
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(
            () => {});

        logError('threshold update failed', new Error('permission denied'));
        logDebug('device inspection failed', {message: 'device disappeared'});

        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining(
                '[BatteryBoost] threshold update failed: Error: permission denied'
            )
        );
        expect(consoleDebug).toHaveBeenCalledWith(
            '[BatteryBoost] device inspection failed: device disappeared'
        );
    });
});
