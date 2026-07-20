# ADR 0004: AI-requested APK installation

- Status: Accepted
- Date: 2026-07-21

## Decision

AI conversations may propose an `app.install` action only by referencing the opaque `artifactId` of an APK that the Local Agent has already staged and validated. A model must never provide a local path, an ADB argument list, or raw shell input.

The Agent recomputes the policy for every returned ActionPlan. An installation always requires an explicit user confirmation, including for trusted projects. The confirmation must show the target device, package name, version, SHA-256, and installation options before the existing APK installer is called.

## Consequences

- The conversation layer supplies only the current conversation's staged APK metadata to the model.
- An ActionPlan that refers to an unavailable artifact is rejected before execution.
- Model-provided `requiresApproval` is informational only; the Agent derives the effective authorization state from policy.
- The existing APK-install audit remains the authoritative record for the command result. Future conversation history will reference that audit rather than duplicate untrusted ADB output.
