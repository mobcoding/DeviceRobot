# Delivery plan

## Product target

Deliver a Windows 10/11 standalone tool that understands local or Git-hosted Android projects, builds or accepts an APK, operates locally connected Android 8–16 devices, generates deterministic tests through an OpenAI-compatible model, executes them with bounded locator healing, and exports offline HTML reports.

## Delivery stages

1. **Workspace foundation** — localhost Agent, Web UI, contracts, test DSL, SQLite, CI, and Windows-oriented configuration.
2. **Device control** — adbkit discovery, authorization diagnostics, APK/file/logcat operations, scrcpy streaming, and manual takeover.
3. **Repository intelligence** — local/Git sources, Gradle variants, XML View, Compose, Manifest, Navigation, Kotlin, and Java indexing.
4. **Build pipeline** — managed SDK components, Gradle Wrapper execution, APK metadata and checksums, uploaded APK fallback.
5. **AI testing** — OpenAI-compatible text/vision providers, evidence-backed business maps, reviewed test generation, structured ActionPlans, and trusted-project policy.
6. **Execution** — isolated Appium/UiAutomator2 workers, per-case app data clearing, evidence capture, cancellation, and at most two locator healing attempts.
7. **Parallel runs and reports** — immediate execution on all selected devices, matrix and sharding modes, failure isolation, and offline HTML report ZIP files.
8. **Windows packaging** — NSIS installer with pinned runtimes, startup management, upgrades, diagnostics, and opt-in SDK downloads.

## Fixed boundaries

- Native Android only in the first release: XML View, Jetpack Compose, and system permission dialogs.
- No WebView, iOS, cross-application business flows, SaaS tenancy, or central service.
- Generated tests are reviewed by default; trusted projects may enable automatic execution and unrestricted AI ADB commands.
- Every test case clears the target application's data before launch.
- The product does not impose a device concurrency cap or queue selected devices.
- Reports are delivered as offline HTML ZIP files; PDF and JUnit are not in scope.
