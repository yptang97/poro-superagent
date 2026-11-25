import { expect, test } from "bun:test";

import { ensureProxyEnv, proxyFromRegistryText } from "../src/proxy-env.ts";

const registry = (lines: string): string =>
  `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n${lines}\n`;

test("an enabled bare host:port proxy becomes an http URL, and http=/https= prefers https", () => {
  expect(
    proxyFromRegistryText(registry("    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7897")),
  ).toBe("http://127.0.0.1:7897");
  expect(
    proxyFromRegistryText(
      registry(
        "    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=10.0.0.1:3128;https=10.0.0.2:8443",
      ),
    ),
  ).toBe("http://10.0.0.2:8443");
  expect(
    proxyFromRegistryText(
      registry("    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    https=10.0.0.2:8443"),
    ),
  ).toBe("http://10.0.0.2:8443");
});

test("a disabled, missing or socks-only proxy yields nothing rather than a broken connection", () => {
  expect(
    proxyFromRegistryText(registry("    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7897")),
  ).toBe(undefined);
  expect(proxyFromRegistryText(registry("    ProxyEnable    REG_DWORD    0x1"))).toBe(undefined);
  expect(
    proxyFromRegistryText(
      registry("    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    socks=127.0.0.1:1080"),
    ),
  ).toBe(undefined);
  expect(proxyFromRegistryText("")).toBe(undefined);
});

test("the environment is filled only when no proxy variable is set, and an existing one is never overwritten", () => {
  let reads = 0;
  const read = () => {
    reads += 1;
    return "http://127.0.0.1:7897";
  };
  const empty: NodeJS.ProcessEnv = {};
  ensureProxyEnv(empty, read);
  expect(empty["HTTPS_PROXY"]).toBe("http://127.0.0.1:7897");
  expect(reads).toBe(1);

  for (const name of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const env: NodeJS.ProcessEnv = { [name]: "http://user:proxy" };
    ensureProxyEnv(env, read);
    expect(env[name]).toBe("http://user:proxy");
    expect(env["HTTPS_PROXY"]).toBe(name === "HTTPS_PROXY" ? "http://user:proxy" : undefined);
  }
  expect(reads).toBe(1);

  const none: NodeJS.ProcessEnv = {};
  ensureProxyEnv(none, () => undefined);
  expect(none["HTTPS_PROXY"]).toBe(undefined);
});
