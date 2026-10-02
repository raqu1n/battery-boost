import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
    {
        ignores: ['build/**', 'coverage/**', 'dist/**', 'node_modules/**'],
    },
    {
        files: ['**/*.ts'],
        extends: [js.configs.recommended, tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
        },
    },
    {
        files: ['scripts/check-upower.js', 'eslint.config.js'],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
            },
        },
    },
]);
