import { readFileSync } from "node:fs";
import WebSocket from "ws";
const base = "http://localhost:8440", token = process.env.AXIS_ADMIN_TOKEN;
const admin = async (method, path, body) => (await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
// 24 kHz from the speech engine, sent as a device would send it: 16 kHz.
const src = readFileSync("/tmp/utt24.pcm"); const a = new Int16Array(src.buffer, src.byteOffset, src.length >> 1);
const out = new Int16Array(Math.floor(a.length * 16000 / 24000));
for (let i = 0; i < out.length; i++) { const at = i * 1.5, l = Math.floor(at), r = Math.min(a.length - 1, l + 1); out[i] = a[l] + (a[r] - a[l]) * (at - l); }
const pcm = Buffer.from(out.buffer);
const { code } = await admin("POST", "/admin/pairing-codes");
const capabilities = ["mic", "screen"];
const paired = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, type: "probe", version: "0.1.0", capabilities, name: "Talk probe" }) }).then((r) => r.json());
console.log("setting:", JSON.stringify((await admin("PATCH", `/admin/settings/device/${paired.clientId}`, { values: { voiceMode: "realtime" } })).values ?? "?").slice(0, 120));
const socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/client`);
await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
const t0 = Date.now(); const seen = []; let done; const finished = new Promise((r) => (done = r));
socket.on("message", (data, isBinary) => {
  if (isBinary) return seen.push(`+${Date.now() - t0} <audio ${data.length}>`);
  const m = JSON.parse(data.toString());
  if (m.t === "turn") { seen.push(`+${Date.now() - t0} turn:${m.state}${m.doing ? `:${m.doing}` : ""}${m.detail ? ` (${m.detail})` : ""}`); if (m.state === "idle" || m.state === "error") done(); }
  else if (m.t === "transcript") seen.push(`+${Date.now() - t0} heard: ${m.text}`);
  else if (m.t === "reply.text") seen.push(`+${Date.now() - t0} reply${m.final ? " (final)" : ""}: ${m.text.slice(0, 120)}`);
  else if (m.t === "error") seen.push(`+${Date.now() - t0} error: ${m.message}`);
  else if (m.t === "command") socket.send(JSON.stringify({ t: "command.result", id: m.id, ok: false }));
});
socket.send(JSON.stringify({ t: "hello", protocol: 1, clientId: paired.clientId, token: paired.token, type: "probe", version: "0.1.0", capabilities, settingsVersion: 0, maxFrameBytes: 16384, audioBufferMs: 60000 }));
await new Promise((r) => setTimeout(r, 1500));
const turnId = `talk-${Date.now()}`;
socket.send(JSON.stringify({ t: "audio.start", turnId, format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }, trigger: "tap" }));
for (let at = 0; at < pcm.length; at += 3200) socket.send(pcm.subarray(at, at + 3200));
socket.send(JSON.stringify({ t: "audio.end", turnId, reason: "silence" }));
const sent = Date.now() - t0;
await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
console.log(`utterance ${(pcm.length / 32000).toFixed(1)} s, sent at +${sent}`);
console.log(seen.join("\n"));
socket.close();
await admin("DELETE", `/admin/clients/${paired.clientId}`);
