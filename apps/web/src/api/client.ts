export type ResponseSchema<T> = {
  parse(value: unknown): T;
};

export async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return new Error(typeof payload?.error === "string" ? payload.error : fallback);
}

export async function requestJson<T>(
  url: string,
  init: RequestInit | undefined,
  schema: ResponseSchema<T>,
  fallback: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("无法连接本地 Agent。请确认 Agent 正在运行。");
  }
  if (!response.ok) {
    throw await responseError(response, fallback);
  }
  return schema.parse(await response.json());
}
