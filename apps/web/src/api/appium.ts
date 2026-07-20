import { appiumRuntimeSchema, type AppiumRuntime } from "@device-robot/contracts";

async function runtimeResponseError(response: Response): Promise<Error> {
  const payload = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const message = typeof payload?.error === "string" ? payload.error : "Appium 请求失败";
  return new Error(`${message}（HTTP ${response.status}）`);
}

async function fetchRuntime(path: string, options: RequestInit = {}): Promise<AppiumRuntime> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/appium/runtime${path}`, {
      headers: { Accept: "application/json" },
      ...options,
    });
  } catch {
    throw new Error("无法连接本地 Agent，无法读取 Appium 运行环境。");
  }

  if (!response.ok) {
    throw await runtimeResponseError(response);
  }

  return appiumRuntimeSchema.parse(await response.json());
}

export async function fetchAppiumRuntime(signal?: AbortSignal): Promise<AppiumRuntime> {
  return await fetchRuntime("", signal === undefined ? {} : { signal });
}

export async function startAppiumRuntime(): Promise<AppiumRuntime> {
  return await fetchRuntime("/start", { method: "POST" });
}

export async function stopAppiumRuntime(): Promise<AppiumRuntime> {
  return await fetchRuntime("/stop", { method: "POST" });
}
