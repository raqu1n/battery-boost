import {fileURLToPath} from 'node:url';

import {defineConfig} from 'vitest/config';

function testFile(relativePath: string): string {
    return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
    test: {
        environment: 'node',
        clearMocks: true,
        restoreMocks: true,
        include: ['tests/**/*.test.ts'],
        alias: {
            'gi://Gio': testFile('./tests/mocks/gio.ts'),
            'gi://GLib': testFile('./tests/mocks/glib.ts'),
            'gi://GObject': testFile('./tests/mocks/gobject.ts'),
            'resource:///org/gnome/shell/extensions/extension.js':
                testFile('./tests/mocks/extensionApi.ts'),
            'resource:///org/gnome/shell/ui/main.js':
                testFile('./tests/mocks/main.ts'),
            'resource:///org/gnome/shell/ui/quickSettings.js':
                testFile('./tests/mocks/quickSettings.ts'),
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary'],
            include: ['src/**/*.ts'],
            thresholds: {
                statements: 90,
                branches: 80,
                functions: 100,
                lines: 90,
            },
        },
    },
});
