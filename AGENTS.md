# AGENTS.md — Battery Boost

Concise project notes for coding agents. Keep these aligned with the source and workflow.

## Project

- Battery Boost is a GNOME Shell Quick Settings extension that temporarily disables a laptop's charge limit and charges to 100%.
- Runtime: GNOME Shell/GJS ES modules; authoring language: strict TypeScript, compiled to JavaScript.
- Extension UUID: `battery-boost@raqu1n.github.io`; see `src/metadata.json` for supported Shell versions.
- UPower is accessed over the system D-Bus. Settings schema: `org.gnome.shell.extensions.battery-boost`.
- Node.js 22.12+ is required for development and builds.

## Layout

```text
src/extension.ts                Lifecycle, settings, and UI coordination
src/ui/batteryIndicator.ts      Quick Settings toggle and indicator
src/upower/batteryService.ts    Battery discovery, monitoring, and thresholds
src/upower/proxies.ts           Typed UPower D-Bus proxy factories
src/settings.ts, src/utils.ts   Shared settings key and logging helpers
src/metadata.json               GNOME extension manifest
src/schemas/                    GSettings schema source
ambient.d.ts                    GJS and GNOME Shell ambient types
tests/                          Vitest tests and GNOME/GJS boundary mocks
scripts/build.sh                Compile, validate schema, and package extension
scripts/check-upower.js         Optional generated-proxy smoke test
.github/workflows/ci.yml        CI validation workflow
package.json                    Development commands and dependencies
tsconfig*.json                  Strict source and test TypeScript configuration
vitest.config.ts                Test aliases and coverage thresholds
eslint.config.js                Lint rules
build/, coverage/, dist/        Generated and ignored output
```

## Runtime behavior and invariants

- `extension.ts` owns lifecycle: enable creates the service and indicator; disable stops the service, disconnects settings, and destroys the indicator.
- `BatteryToggle` binds `checked` bidirectionally to the public `boost-enabled` GSettings key.
- `boost-enabled=false` means the configured charge limit is active; `true` requests one boost cycle. External writes must use the same apply, rollback, error-handling, and auto-revert path as UI changes.
- Auto-revert only on a transition to AC-disconnected/discharging or to 100% charge, not just because the battery is already in either state.
- Inspect all batteries as needed, but monitor one present, threshold-capable battery at a time. An unsupported battery may be retained for reporting; never broadcast threshold writes to every battery.
- Follow UPower owner and hotplug changes; retry transient setup/enumeration failures and poll while a known system battery is absent.
- Preserve async safety: serialized discovery and last-request-wins threshold writes; lifecycle cancellation and device/operation guards prevent stale results changing current state.
- Stopping invalidates an in-flight threshold result but may not cancel the underlying generated D-Bus hardware call.

## Development and validation

- Install locked dependencies with `npm ci`.
- `npm run check` runs shell/schema checks, source and test type checks, ESLint, and coverage-enforced tests.
- Focused commands: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:coverage`.
- Coverage gates: 90% statements, 80% branches, 100% functions, and 90% lines.
- `./scripts/build.sh` compiles TypeScript, validates the schema, stages runtime files, and creates `dist/battery-boost@raqu1n.github.io.shell-extension.zip`.
- Install and enable the built extension with `gnome-extensions install dist/battery-boost@raqu1n.github.io.shell-extension.zip` and `gnome-extensions enable battery-boost@raqu1n.github.io`.
- After installation, verify the toggle in a GNOME session; threshold behavior requires compatible hardware.
- `npm run test:upower` optionally checks generated proxies against local GJS/UPower; hardware validation requires a battery exposing charge-threshold support.
- CI installs with `npm ci` and runs `npm run check`. Run the build after runtime or schema changes.
- Vitest mocks GNOME/GJS boundaries. Prefer tests of observable behavior and boundary interactions over duplicating GNOME internals.

## Working conventions

- Keep the schema key `boost-enabled` stable: it is a public control surface; renaming/removing it is a breaking change.
- Use GNOME Shell ES module imports, four-space indentation, `const`/`let`, strict types, and avoid `any` except at dynamic GJS boundaries.
- Prefix private instance properties with `_`; use `gettext as _` for translatable strings and shared logging helpers for errors.
- Keep generated output out of source changes. Ensure the distributable contains only runtime assets, not development files or secrets.
- After TypeScript behavior changes, run type checks and tests; after schema changes, validate/build; after runtime changes, rebuild the package.

## Security

- The extension calls UPower's `EnableChargeThreshold` over the system D-Bus, which changes hardware charging behavior.
- It stores no credentials and executes no arbitrary commands; writable state is limited to the extension setting and UPower threshold.
