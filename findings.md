# Deferred findings

These findings were identified during the code-base review and intentionally
remain unchanged for now.

1. Battery discovery selects the first present power-supply battery without
   checking `ChargeThresholdSupported`. On systems with multiple batteries,
   an unsupported battery can prevent a later supported battery from being
   selected.

2. Initial UPower, enumeration, and device-inspection failures do not trigger
   a retry. The service can remain active without a usable UPower connection
   until the extension is reloaded.

4. Absent batteries that are not currently selected are not monitored for an
   in-place `IsPresent` transition back to present.
