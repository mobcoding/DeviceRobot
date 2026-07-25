import { AGENT_HOST, AGENT_PORT } from "@device-robot/config";

import { createAgentApp } from "./app.js";

const { app, scrcpyStreamService } = await createAgentApp({
  logger:
    process.env.NODE_ENV === "development"
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          transport: { target: "pino-pretty", options: { colorize: true } },
        }
      : { level: process.env.LOG_LEVEL ?? "info" },
  serveWeb: process.env.NODE_ENV !== "development",
});

let shuttingDown = false;

function isRecoverableScrcpyTransportError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === "ERR_STREAM_DESTROYED";
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "Stopping DeviceRobot Agent");
  await app.close();
}

function handleRecoverableScrcpyTransportError(error: Error, origin: string): void {
  app.log.warn(
    { err: error, origin },
    "A scrcpy transport closed while a video stream was being released",
  );
  void scrcpyStreamService.dispose().catch((disposeError: unknown) => {
    app.log.error({ err: disposeError }, "Unable to release the failed scrcpy stream");
  });
}

function handleFatalProcessError(error: unknown, origin: string): void {
  if (isRecoverableScrcpyTransportError(error)) {
    handleRecoverableScrcpyTransportError(error, origin);
    return;
  }

  app.log.fatal(
    { err: error, origin },
    "DeviceRobot Agent encountered an unrecoverable process error",
  );
  void shutdown(origin).finally(() => {
    process.exitCode = 1;
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

process.on("unhandledRejection", (reason) => {
  handleFatalProcessError(reason, "unhandledRejection");
});
process.on("uncaughtException", (error, origin) => {
  handleFatalProcessError(error, origin);
});

try {
  await app.listen({ host: AGENT_HOST, port: AGENT_PORT });
  app.log.info({ url: `http://${AGENT_HOST}:${AGENT_PORT}` }, "DeviceRobot Agent started");
} catch (error) {
  app.log.fatal({ error }, "DeviceRobot Agent failed to start");
  await app.close();
  process.exitCode = 1;
}
