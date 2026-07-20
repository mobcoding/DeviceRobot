# ADR 0002: Device automation stack

- Status: Accepted
- Date: 2026-07-20

## Decision

Use Appium with UiAutomator2 for semantic UI automation, adbkit for device and shell operations, and scrcpy for live video and manual input.

## Consequences

- AI actions can use stable selectors and deterministic waits instead of coordinates.
- Raw ADB remains available for device-level operations and trusted projects.
- Each concurrently selected device receives an isolated worker and Appium port allocation.
- ws-scrcpy-style projects may be used as references but are not production runtime dependencies.
