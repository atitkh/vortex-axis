// Measures real response times through a running Axis: pairs a throwaway
// client, sends typed turns to the configured agent, and removes the client.
//
//   AXIS_URL=http://localhost:8440 AXIS_ADMIN_TOKEN=... node scripts/latency-probe.mjs [turns]
//
// Each turn goes to the real agent and lands in the shared conversation.
import WebSocket from "ws";

const base = (process.env.AXIS_URL || "http://localhost:8440").replace(/\/$/, "");
const token = process.env.AXIS_ADMIN_TOKEN;
const turns = Number(process.argv[2] || 3);
if (!token) throw new Error("set AXIS_ADMIN_TOKEN");

const admin = async (method, path) => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.json();
};

const { code } = await admin("POST", "/admin/pairing-codes");
const capabilities = ["speaker", "screen"];
const paired = await fetch(`${base}/v1/pair`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, type: "probe", version: "0.1.0", capabilities, name: "Latency probe" }),
}).then((r) => r.json());

const socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/client`);
await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
const listeners = new Set();
socket.on("message", (data, isBinary) => {
  const message = isBinary ? { t: "<audio>", bytes: data.length } : JSON.parse(data.toString());
  for (const listener of listeners) listener(message);
});
const send = (message) => socket.send(JSON.stringify(message));
const waitFor = (test, ms = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    const listener = (message) => {
      if (!test(message)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(message);
    };
    listeners.add(listener);
  });

const results = [];
try {
  send({
    t: "hello", protocol: 1, clientId: paired.clientId, token: paired.token, type: "probe", version: "0.1.0",
    capabilities, settingsVersion: 0, maxFrameBytes: 16384, audioBufferMs: 60000,
  });
  await waitFor((m) => m.t === "status");

  for (let i = 1; i <= turns; i++) {
    const turnId = `probe-${Date.now()}-${i}`;
    const marks = {};
    const started = Date.now();
    const mark = (name) => (marks[name] ??= Date.now() - started);
    let rate = 24000;
    let audioBytes = 0;
    const listener = (m) => {
      if (m.t === "reply.text" && m.turnId === turnId) mark("firstText");
      if (m.t === "speak.start" && m.turnId === turnId) rate = m.format.sampleRate;
      if (m.t === "<audio>") {
        mark("firstAudio");
        audioBytes += m.bytes;
      }
      if (m.t === "turn" && m.turnId === turnId && m.state === "error") marks.error = m.detail;
    };
    listeners.add(listener);
    send({ t: "text", turnId, text: "This is a timing check. Reply with one short sentence saying it works." });
    const end = await waitFor(
      (m) => (m.t === "speak.end" && m.turnId === turnId) || (m.t === "turn" && m.turnId === turnId && m.state === "error"),
      130000,
    );
    mark("lastAudio");
    listeners.delete(listener);
    if (end.t === "speak.end") {
      // Nothing is played here, so report at once and let the turn close.
      send({ t: "playback", turnId, state: "finished" });
      await waitFor((m) => m.t === "turn" && m.turnId === turnId && m.state === "idle").catch(() => {});
    }
    results.push({ ...marks, audioSeconds: Math.round((audioBytes / 2 / rate) * 10) / 10 });
    console.log(`turn ${i}:`, JSON.stringify(results.at(-1)));
  }
} finally {
  socket.close();
  await admin("DELETE", `/admin/clients/${paired.clientId}`).catch(() => {});
}

const ok = results.filter((r) => !r.error && r.firstAudio !== undefined);
const median = (key) => {
  const values = ok.map((r) => r[key]).sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : undefined;
};
console.log(`median over ${ok.length} good turn(s): first text ${median("firstText")} ms, first audio ${median("firstAudio")} ms`);
process.exit(ok.length === results.length ? 0 : 1);
