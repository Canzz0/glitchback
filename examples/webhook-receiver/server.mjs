// Backend ekibi için örnek webhook alıcısı. İmzayı doğrular ve raporu yazdırır.
// Çalıştırma: BACKEND_WEBHOOK_SECRET=... node examples/webhook-receiver/server.mjs
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.BACKEND_WEBHOOK_SECRET || "";

// İmza, zaman damgası + gövde üzerinden atılır: yakalanan bir istek 5 dakika sonra tekrar gönderilemez.
function verify(rawBody, timestamp, header) {
  if (!SECRET) return true; // imza kapalıysa herkese açık; üretimde SECRET tanımlayın
  if (!header || !timestamp) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = "sha256=" + createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!verify(body, req.headers["x-bugloop-timestamp"], req.headers["x-bugloop-signature"])) { res.writeHead(401).end("bad signature"); return; }
    const payload = JSON.parse(body);
    console.log(`[${payload.event}] ${payload.data.triage.area} → ${payload.issue_url}`);
    console.log("  mesaj:", payload.data.report.user_message);
    res.writeHead(200).end("ok");
  });
}).listen(9000, () => console.log("webhook alıcısı http://localhost:9000"));
