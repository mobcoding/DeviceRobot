# ADR 0001: Standalone localhost Agent

- Status: Accepted
- Date: 2026-07-20

## Decision

Run the product as a per-user Windows Agent that binds only to `127.0.0.1:43110` and serves the Web UI from the same origin in production.

## Consequences

- Device and repository access remains local.
- API keys never need to enter browser storage.
- Team synchronization and public remote access are not part of the first release.
- Host, Origin, CSRF, and local malicious-site protections remain required even on loopback.
