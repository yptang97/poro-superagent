/** Bun reads HTTPS_PROXY for fetch and for our WebSocket, but never the Windows system proxy; fill the variable in. */
const asProxyUrl = (server: string | undefined): string | undefined => {
  if (!server) return undefined;
  const parts = server
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const named = (key: string): string | undefined =>
    parts
      .find((part) => part.toLowerCase().startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim() || undefined;
  const chosen = named("https") ?? named("http") ?? parts.find((part) => !part.includes("="));
  if (!chosen) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(chosen) ? chosen : `http://${chosen}`;
};

export const proxyFromRegistryText = (text: string): string | undefined => {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(text);
  if (!enabled || Number.parseInt(enabled[1] ?? "0", 16) === 0) return undefined;
  return asProxyUrl(/ProxyServer\s+REG_SZ\s+(\S.*)/i.exec(text)?.[1]);
};

export const readWindowsProxy = (): string | undefined => {
  if (process.platform !== "win32") return undefined;
  try {
    const r = Bun.spawnSync(["reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return r.exitCode === 0 ? proxyFromRegistryText(r.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
};

export const ensureProxyEnv = (
  env: NodeJS.ProcessEnv = process.env,
  read: () => string | undefined = readWindowsProxy,
): void => {
  if (env["HTTPS_PROXY"] || env["https_proxy"] || env["ALL_PROXY"] || env["all_proxy"]) return;
  const proxy = read();
  if (proxy) env["HTTPS_PROXY"] = proxy;
};
