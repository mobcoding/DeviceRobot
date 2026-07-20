# ADR 0003: Structured AI actions

- Status: Accepted
- Date: 2026-07-20

## Decision

Models produce schema-validated ActionPlans. Models never receive a direct process, shell, Appium, or ADB handle.

## Consequences

- Every action passes through policy and audit layers.
- A conversation turn is limited to 20 actions and two replanning attempts.
- Locator healing may replace a locator at most twice but cannot change the action, assertion, or test data.
- Source comments and model-visible repository text are treated as untrusted data, not instructions.
