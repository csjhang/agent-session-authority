import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MockEffectSink } from "./sink.js";
import type { AcceptRequest, FaultMode, SinkSnapshot } from "./types.js";

function read_json(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}
export interface SinkServer { sink: MockEffectSink; server: http.Server; url: string; port: number; close(): Promise<void>; }
export async function start_sink_server(sink: MockEffectSink = new MockEffectSink(), port = 0, host = process.env.ASA_SINK_HOST ?? "127.0.0.1"): Promise<SinkServer> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, commitCount: sink.getCommitCount() });
      if (req.method === "GET" && url.pathname === "/ledger") return send(res, 200, { ledger: sink.exportLedger(), commitCount: sink.getCommitCount() });
      if (req.method === "GET" && url.pathname === "/observations") return send(res, 200, { observations: sink.getObservationLog() });
      if (req.method === "GET" && url.pathname === "/snapshot") return send(res, 200, sink.snapshot());
      if (req.method === "POST" && url.pathname === "/accept") { const result = await sink.accept((await read_json(req)) as AcceptRequest); return send(res, result.accepted || result.suppressed ? 200 : 400, result); }
      if (req.method === "POST" && url.pathname === "/fault") { const body = (await read_json(req)) as { mode?: FaultMode; delayMs?: number }; if (!body.mode) return send(res, 400, { error: "mode required" }); sink.setFaultMode(body.mode, body.delayMs); return send(res, 200, { ok: true, mode: sink.getFaultMode() }); }
      if (req.method === "POST" && url.pathname === "/restore") { const body = (await read_json(req)) as SinkSnapshot; sink.restore(body); return send(res, 200, { ok: true, commitCount: sink.getCommitCount() }); }
      send(res, 404, { error: "not found" });
    } catch (e) { send(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("failed to bind sink server");
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return { sink, server, url: `http://${displayHost}:${addr.port}`, port: addr.port, close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}
