import { createServer, type IncomingMessage } from "node:http";
import { configFromEnv, triageChain } from "./config.ts";
import { createHandler } from "./handler.ts";

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return "too_large";
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Standalone server for sites that are not Next.js (or have no Node backend).
 * Any path accepts reports; GET returns a health check.
 */
export function serve(port: number) {
  const cfg = configFromEnv(process.env);
  const handler = createHandler(cfg);
  if (!cfg.allowedOrigins) {
    console.warn("[patchback] PATCHBACK_ALLOWED_ORIGINS is not set: only pages served from this same host can send reports.");
  }

  const server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else if (v !== undefined) headers.set(k, v);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
      const body = hasBody ? await readBody(req) : undefined;
      if (body === "too_large") {
        res.writeHead(413, { "Content-Type": "application/json" }).end('{"error":"too_large"}');
        return;
      }
      const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: body && body.length ? new Uint8Array(body) : undefined,
      });
      const response = await handler(request, { ip: req.socket.remoteAddress });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error("[patchback] request failed:", err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"internal"}');
    }
  });

  server.listen(port, () => {
    const target = cfg.github ? `GitHub ${cfg.github.repo}` : "console (no PATCHBACK_GITHUB_TOKEN)";
    console.log(`[patchback] listening on :${port} · reports → ${target} · triage: ${triageChain(cfg)}`);
  });
  return server;
}
