const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function getHostname(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }

  const hostname = getHostname(host);
  return hostname !== undefined && loopbackHosts.has(hostname.toLowerCase());
}

export function isAllowedOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
): boolean {
  if (origin === undefined) {
    return true;
  }

  if (requestHost === undefined || !isLoopbackHost(requestHost)) {
    return false;
  }

  try {
    const parsedOrigin = new URL(origin);
    return (
      (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
      isLoopbackHost(parsedOrigin.host)
    );
  } catch {
    return false;
  }
}
