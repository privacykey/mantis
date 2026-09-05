import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
});

async function probe(status: number, dashboardHosts = "") {
  let receivedHost: string | undefined;
  server = createServer((req, res) => {
    receivedHost = req.headers.host;
    res.writeHead(status);
    res.end();
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  await run(process.execPath, [resolve("docker/healthcheck.mjs")], {
    env: { ...process.env, PORT: String(address.port), DASHBOARD_HOSTS: dashboardHosts },
  });
  return { receivedHost, port: address.port };
}

describe("container health probe", () => {
  it("uses the first dashboard hostname for a split deployment", async () => {
    const result = await probe(200, " dash.example, second.example ");
    expect(result.receivedHost).toBe("dash.example");
  });

  it("uses the loopback host for a default deployment", async () => {
    const result = await probe(200);
    expect(result.receivedHost).toBe(`127.0.0.1:${result.port}`);
  });

  it("fails when the server reports an unhealthy database", async () => {
    await expect(probe(503)).rejects.toMatchObject({ code: 1 });
  });
});
