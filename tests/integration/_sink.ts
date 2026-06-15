import { createServer, type Server } from "node:http";

// A real local HTTP sink that records the requests it receives. Used to assert
// genuine outbound behavior (SSRF gating through the real undici dispatcher,
// HMAC signing, payload escaping, retry-queue delivery) WITHOUT mocking fetch —
// mocking the global fetch would bypass safe-post's dispatcher, which is exactly
// the thing under test. The sink binds to 127.0.0.1, so tests that want delivery
// must set ALLOW_PRIVATE_WEBHOOKS=1; tests asserting an SSRF block leave it off.

export type SinkRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type Sink = {
  url: string;
  requests: SinkRequest[];
  close: () => Promise<void>;
};

export type SinkOpts = {
  /** Status to respond with (default 200). */
  status?: number;
  /** Body to respond with (default "{}"). */
  body?: string;
  /** If set, respond 302 with this Location instead (to exercise redirect:manual). */
  redirectTo?: string;
};

export async function startSink(opts: SinkOpts = {}): Promise<Sink> {
  const requests: SinkRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
      }
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (opts.redirectTo) {
        res.writeHead(302, { location: opts.redirectTo });
        res.end();
        return;
      }
      res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
      res.end(opts.body ?? "{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
