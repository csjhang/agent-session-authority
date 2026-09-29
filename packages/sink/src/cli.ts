#!/usr/bin/env node
import { MockEffectSink } from "./sink.js";
import { start_sink_server } from "./server.js";

const port = Number(process.env.ASA_SINK_PORT ?? process.argv[2] ?? "8787");
const sink = new MockEffectSink();
const srv = await start_sink_server(sink, port);
console.log(`asa mock effect sink listening on ${srv.url}`);
console.log("POST /accept {effectId,actionDigest,...}");
console.log("GET  /ledger | /ledger?format=agent-effect | /health | /observations | /snapshot");
console.log("POST /fault {mode,delayMs?}  modes: none|timeout|resend|lost_reply|delay");
console.log("POST /fence {fenceEpoch?,runtimeGeneration?,scopeId?,holder?}");
console.log("POST /restore <snapshot>");
