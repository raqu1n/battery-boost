# Codebase audit

This audit covers the runtime extension, D-Bus boundary, tests, build and
packaging scripts, metadata and schema, CI, and project documentation. It was
last updated on 2026-08-21.

## Corrected findings

1. **Rapid threshold requests were not safe at the hardware boundary.** The
   stale-result guards ignored old callbacks, but the older D-Bus method could
   still finish last and leave the hardware in the wrong mode. Threshold calls
   are now serialized and superseded queued calls are skipped, so the newest
   request is the final side effect.

2. **Battery selection stopped at the first present system battery.** An
   unsupported battery could hide a later threshold-capable battery. Discovery
   now prefers a supported battery and uses an unsupported one only to report a
   useful `threshold-unsupported` error.

3. **Unsupported or unavailable hardware could leave the toggle showing stale
   boost state.** The service now reports an unavailable threshold state, which
   the coordinator represents as boost off without issuing another D-Bus call.

4. **Transient UPower failures had no recovery path.** Root-proxy,
   enumeration, and device-inspection failures now retry at a low frequency.
   Repeated identical failures are not logged on every retry.

5. **An absent hot-removable battery could never become selectable in place.**
   Discovery now polls only while a system battery is known but absent. Normal
   operation remains signal-driven.

6. **UPower daemon restarts were not handled.** The root proxy's name-owner is
   monitored; stale device state is dropped when the daemon vanishes and
   discovery resumes when it returns.

7. **A 100% percentage update followed by a fully-charged state update could be
   missed.** A short-lived pending crossing now handles either D-Bus property
   ordering without treating repeated 100% updates as new charge cycles.

8. **Notification errors could become unhandled promise rejections and could
   interrupt rollback.** Rollback now happens first, and notification failures
   are contained and logged.

9. **Several extension tests pretended a GSettings signal returned the async
   handler's promise.** Production deliberately discards that promise, so the
   casts made the tests timing-dependent. Tests now wait for observable effects
   and exercise real signal semantics.

10. **The package omitted the MIT license notice.** The distributable now
    includes `LICENSE`, as required by the license text.

11. **The build deleted every extension zip in `dist/`.** Cleanup now targets
    only this extension's derived archive.

12. **CI did not validate the schema or the smoke-test script's syntax.** The
    main check now validates shell and JavaScript syntax, the GSettings schema,
    source and test types, tests, and coverage. CI also installs the official
    GNOME packaging tool and builds the distributable archive.

13. **CI used outdated action runtimes and an older Node release.** It now uses
    the current major releases of `actions/checkout` and `actions/setup-node`
    with Node 24, and declares read-only repository permissions.

14. **GNOME 50 documentation still gave X11 restart instructions.** GNOME 50
    no longer supports an X11 session, so installation instructions now use a
    logout/login restart only.

15. **The old deferred-findings list was stale and misnumbered.** Its valid
    items are resolved above and this document now records both fixes and
    deliberate design choices.

16. **Development dependencies were slightly stale and Node types did not match
    CI.** Vitest and its coverage provider are on the latest patch release, the
    Node type definitions now match the Node 24 CI runtime, and `npm audit`
    reports no known vulnerabilities. The package also declares the minimum
    supported Node release required by the toolchain.

## Reviewed and retained

- **GSettings state:** Keeping `boost-enabled` has a cost because the state is
  transient, but it intentionally provides a supported external control and
  inspection interface, reliable Quick Toggle binding, and restart
  reconciliation with UPower. This is product behavior rather than incidental
  persistence, so removing the schema would be a breaking interface change.

- **One selected battery:** The service now selects one threshold-capable
  system battery. Applying a toggle atomically to every battery would be a
  different product behavior with partial-failure semantics that need an
  explicit decision.

- **Lifecycle generations, cancellation, and operation serials:** These guards
  add code, but each closes a demonstrated race involving disable, hotplug,
  discovery, or user requests. They are not dead defensive scaffolding.

- **A single BatteryService lifecycle owner:** The class is the largest module,
  but splitting signal IDs, timers, proxies, and cancellation across helper
  objects would make cleanup harder to verify. Proxy construction and UI remain
  separate modules.

- **Local D-Bus XML and asserted proxy interfaces:** GJS generates these members
  at runtime, so the small typed boundary is necessary. XML-focused proxy tests
  protect behavior TypeScript cannot inspect.

- **High coverage thresholds and focused GNOME mocks:** The suite is larger than
  the UI, but it tests observable race and lifecycle behavior rather than GNOME
  internals. No skipped tests, dead helpers, or production `any` escapes remain.

- **No separate linter:** Strict TypeScript checks unused code and types, the
  validation command checks both script languages and the schema, and the suite
  enforces coverage. Adding a lint dependency and style policy would have little
  additional value at the current size; revisit this if the project grows.

- **Metadata-derived build values:** Reading the UUID and schema ID from
  `metadata.json` is more code than hard-coding them, but prevents packaging
  drift and validates that the referenced schema exists.

- **Small shared settings and logging modules:** They avoid duplicated literals
  and inconsistent diagnostics without introducing a framework or dependency.

## Product decisions still worth revisiting

1. Decide whether boost should apply to one supported battery or all supported
   system batteries on multi-battery laptops.
2. Decide whether disabling the extension should make a best-effort attempt to
   restore charge thresholds immediately. The current behavior preserves the
   user's active one-cycle boost and reconciles it when the extension is enabled
   again, but cannot auto-revert while disabled.
