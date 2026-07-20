# DeviceRobot

DeviceRobot is a Windows-first, local Android AI testing workspace. The initial scaffold provides a localhost-only Agent, a React status UI, shared action contracts, a deterministic test DSL, SQLite migrations, and the boundaries required for future ADB, Appium, scrcpy, and source-aware AI integrations.

## Current status

The repository currently implements the workspace foundation only. Device discovery, screen control, source analysis, AI execution, and test reporting are represented by typed interfaces and are intentionally not simulated.

## Requirements

- Windows 10 or Windows 11
- Node.js 24 or newer
- pnpm 11

## Get started

```powershell
pnpm install
pnpm dev
```

Development starts:

- Local Agent: `http://127.0.0.1:43110`
- Vite Web UI: `http://127.0.0.1:5173`

The Vite server proxies `/api` to the Local Agent. A production build is served by the Agent from its localhost endpoint.

## Verification

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Or run the complete gate:

```powershell
pnpm verify
```

## Workspace

| Area                   | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `apps/web`             | React/Vite operator interface              |
| `apps/agent`           | Fastify localhost Agent and SQLite runtime |
| `packages/contracts`   | Shared REST and Agent action contracts     |
| `packages/test-dsl`    | Versioned deterministic test suite schema  |
| `packages/device-core` | Device automation abstraction              |
| `packages/ai-core`     | Model and execution policy abstraction     |
| `packages/config`      | Runtime paths and shared configuration     |
| `docs`                 | Architecture, delivery plan, and decisions |

Runtime data is stored under `%LOCALAPPDATA%\AIMobileTester` and is not committed.

## Security baseline

- The Agent only listens on `127.0.0.1`.
- Non-loopback hosts and cross-origin browser requests are rejected.
- AI output must validate against a structured ActionPlan before execution.
- High-risk ADB actions require approval unless a project is explicitly trusted.
- No telemetry is implemented or enabled.

## License

This repository is private and currently marked `UNLICENSED`. No open-source license has been granted.
