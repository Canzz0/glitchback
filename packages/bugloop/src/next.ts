/**
 * Next.js App Router endpoint. `npx bugloop init` creates:
 *
 *   // app/api/bugloop/route.ts
 *   export { GET, POST, OPTIONS } from "bugloop/next";
 *   export const runtime = "nodejs";
 */
import { configFromEnv } from "./server/config.ts";
import { createHandler, type Handler } from "./server/handler.ts";

let handler: Handler | null = null;

/** Built on the first request, so `next build` never needs the env vars. */
async function handle(req: Request): Promise<Response> {
  try {
    handler ??= createHandler(configFromEnv(process.env));
  } catch (err) {
    console.error("[bugloop] configuration error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "bugloop_misconfigured" }, { status: 500 });
  }
  // Route handlers never see the TCP peer. On Vercel the platform sets x-real-ip itself and
  // drops any value the client sent, so it is the one header that can be trusted there.
  const ip = process.env.VERCEL ? req.headers.get("x-real-ip")?.trim() || undefined : undefined;
  return handler(req, { trustedIp: ip });
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
