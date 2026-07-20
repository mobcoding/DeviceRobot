# Architecture

## Runtime shape

```text
React Web UI
    | REST / SSE / WebSocket
    v
Fastify Local Agent (127.0.0.1:43110)
    |-- repository analysis and Gradle builds
    |-- OpenAI-compatible orchestration
    |-- Appium + UiAutomator2 workers
    |-- adbkit and scrcpy transports
    `-- SQLite, evidence, and HTML reports
             |
             v
         USB Android devices
```

The first release is a standalone Windows application. It has no account system, central server, shared database, or public network listener.

## Package boundaries

- `contracts` owns wire-safe schemas. All external inputs are parsed before entering domain code.
- `test-dsl` owns the versioned, deterministic test suite representation.
- `device-core` defines device operations without choosing an ADB or Appium implementation.
- `ai-core` defines model providers and policy decisions without granting direct execution rights.
- `config` owns stable runtime paths and network defaults.
- `agent` composes infrastructure and is the only component allowed to access local devices and secrets.
- `web` renders real Agent state and never stores model or Git credentials.

## Security boundary

Source files, screenshots, UI trees, model output, ADB output, and repository build scripts are untrusted inputs. The Local Agent validates schemas, applies project trust policy, escapes report content, and records future execution evidence. Model credentials will be stored through Windows DPAPI, not browser storage or SQLite plaintext fields.

## Persistence

SQLite is the system of record for local project metadata, conversations, test suites, and runs. Large evidence remains on disk and is referenced by path and checksum. Schema changes are versioned and applied transactionally.
