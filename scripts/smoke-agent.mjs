import { createServer } from "node:net";
import { AGENT_HOST, AGENT_PORT } from "../packages/config/dist/index.js";
import { createAgentApp } from "../apps/agent/dist/app.js";

async function provePortIsReleased() {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(AGENT_PORT, AGENT_HOST, resolve);
  });

  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

const { app } = await createAgentApp({ serveWeb: true });

try {
  await app.listen({ host: AGENT_HOST, port: AGENT_PORT });

  const healthResponse = await fetch(`http://${AGENT_HOST}:${AGENT_PORT}/api/v1/system/health`);
  const health = await healthResponse.json();
  const webResponse = await fetch(`http://${AGENT_HOST}:${AGENT_PORT}/`);
  const html = await webResponse.text();

  if (!healthResponse.ok || health.status !== "ok") {
    throw new Error(`Health smoke test failed: ${JSON.stringify(health)}`);
  }

  if (!webResponse.ok || !html.includes("<title>DeviceRobot</title>")) {
    throw new Error("Production Web UI smoke test failed");
  }

  process.stdout.write(`${JSON.stringify({ health, webStatus: webResponse.status })}\n`);
} finally {
  await app.close();
}

await provePortIsReleased();
process.stdout.write("PORT_RELEASED=true\n");
