# DeviceRobot

DeviceRobot is a Windows-first, local Android AI testing workspace. The current foundation provides a localhost-only Agent, real ADB device discovery and single-device controls, scrcpy streaming and manual takeover, APK installation, a React operator UI, shared action contracts, a deterministic test DSL, SQLite migrations, and the boundaries required for source-aware AI integrations.

## Current status

The repository discovers locally connected Android devices through ADB and reports authorized, unauthorized, offline, USB, TCP, and emulator states using real device data. For an authorized device, the device workspace provides a live scrcpy stream, manual input, directory browsing, installed-package management, a bounded read-only Logcat viewer, and audited structured controls. APK files can be selected from the application manager or dropped onto the live screen; the Agent stages the file, validates its format and size, calculates SHA-256, reads package metadata with `aapt`, asks for installation confirmation, and records the result. It also diagnoses the local Appium, UiAutomator2, Java, and Android SDK runtime, and starts or stops an Appium server restricted to `127.0.0.1:4723`. Source analysis, AI execution, DSL test-case execution, and test reporting remain future work.

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

Connect an Android phone with USB debugging enabled, accept the authorization prompt on the phone, and open the **Devices** workspace. DeviceRobot refreshes the device list every three seconds and also supports manual refresh. The Agent uses `ADB_PATH` when set; otherwise it resolves `adb` from `PATH`.

The control console only permits structured actions. It does not expose arbitrary ADB Shell commands or app-data clearing. APK installation uses fixed ADB arguments after local validation and explicit confirmation. Completed and failed device actions and APK installations are stored in the local SQLite audit trail.

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
- AI-requested APK installs can only reference a locally staged artifact and always require explicit approval.
- Logcat is read through a fixed, bounded ADB command; arbitrary Shell filters and arguments are not exposed.
- Direct device controls use an allowlisted action schema and are persisted to a local audit trail.
- No telemetry is implemented or enabled.

## License

This repository is private and currently marked `UNLICENSED`. No open-source license has been granted.
