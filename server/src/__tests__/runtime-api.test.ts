import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeApiCandidateUrls,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
} from "../runtime-api.js";

async function deliveredCandidatesContainReachableJsonApi(serializedCandidates: string): Promise<boolean> {
  const candidates = JSON.parse(serializedCandidates) as string[];
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await fetch(`${candidate}/api/health`, {
          redirect: "manual",
          signal: AbortSignal.timeout(1_000),
        });
        return response.status === 200 && response.headers.get("content-type")?.includes("application/json") === true;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

describe("runtime API discovery", () => {
  it("keeps the primary runtime URL on the plaintext listener when a public base URL exists", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "https://paperclip.example.com/base/path",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
      }),
    ).toBe("http://198.51.100.10:3102");
  });

  it("prefers the loopback bind host over allowed hostnames for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: ["192.168.1.50"],
        bindHost: "127.0.0.1",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("builds ordered callback candidates from explicit, allowed, bind, and interface hosts", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: null,
        allowedHostnames: ["198.51.100.10", "runtime-host.example.test", "203.0.113.42"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {
          en0: [
            {
              address: "203.0.113.42",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "203.0.113.42/24",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
          ],
          lo0: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
              netmask: "255.0.0.0",
              cidr: "127.0.0.1/8",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "http://198.51.100.10:3102",
      "http://runtime-host.example.test:3102",
      "http://203.0.113.42:3102",
    ]);
  });

  it("tries the preferred API URL before derived callback candidates", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        preferredApiUrl: "https://agent-entry.example.test/base/path",
        authPublicBaseUrl: "https://paperclip.example.test/app",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "https://agent-entry.example.test",
      "https://paperclip.example.test",
      "http://198.51.100.10:3102",
    ]);
  });

  it("keeps loopback candidates on http when the public origin uses https", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        preferredApiUrl: "https://paperclip.example.test",
        authPublicBaseUrl: "https://paperclip.example.test",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        port: 3100,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "https://paperclip.example.test",
      "http://127.0.0.1:3100",
    ]);
  });

  it("delivers at least one candidate that reaches the plaintext JSON API", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener address");

      const preFixArtifact = JSON.stringify([
        `https://localhost:${address.port}`,
        `https://127.0.0.1:${address.port}`,
      ]);
      expect(await deliveredCandidatesContainReachableJsonApi(preFixArtifact)).toBe(false);

      const deliveredArtifact = JSON.stringify(
        buildRuntimeApiCandidateUrls({
          preferredApiUrl: `https://localhost:${address.port}`,
          authPublicBaseUrl: `https://localhost:${address.port}`,
          allowedHostnames: [],
          bindHost: "127.0.0.1",
          port: address.port,
          networkInterfacesMap: {},
        }),
      );
      expect(await deliveredCandidatesContainReachableJsonApi(deliveredArtifact)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("adds host.docker.internal when the explicit base URL is loopback", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "http://127.0.0.1:3102",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "http://127.0.0.1:3102",
      "http://host.docker.internal:3102",
    ]);
  });

  it("prefers usable interface hosts and skips link-local addresses", () => {
    expect(
      collectReachableInterfaceHosts({
        networkInterfacesMap: {
          en0: [
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
            {
              address: "192.168.6.178",
              family: "IPv4",
              internal: false,
              netmask: "255.255.252.0",
              cidr: "192.168.6.178/22",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fd7a:115c:a1e0::8a3a:a11d",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff::",
              cidr: "fd7a:115c:a1e0::8a3a:a11d/48",
              mac: "00:00:00:00:00:00",
              scopeid: 0,
            },
          ],
          en1: [
            {
              address: "169.254.10.20",
              family: "IPv4",
              internal: false,
              netmask: "255.255.0.0",
              cidr: "169.254.10.20/16",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "192.168.6.178",
      "fd7a:115c:a1e0::8a3a:a11d",
    ]);
  });
});
