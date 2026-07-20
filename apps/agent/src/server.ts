import { AGENT_HOST, AGENT_PORT } from "@device-robot/config";

import { createAgentApp } from "./app.js";

const { app } = await createAgentApp({
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

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "Stopping DeviceRobot Agent");
  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: AGENT_HOST, port: AGENT_PORT });
  app.log.info({ url: `http://${AGENT_HOST}:${AGENT_PORT}` }, "DeviceRobot Agent started");
} catch (error) {
  app.log.fatal({ error }, "DeviceRobot Agent failed to start");
  await app.close();
  process.exitCode = 1;
}
