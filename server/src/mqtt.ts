import { connect as tcpConnect, type Socket } from "node:net";

/**
 * A small MQTT 3.1.1 client: enough to publish states, keep a "last will" and
 * listen for commands. Everything is at quality of service 0, which is what a
 * home broker on the same network needs; a message lost in a reconnect is
 * made good by publishing the state again on connect. No dependency.
 */

export interface MqttOptions {
  /** `mqtt://user:password@host:1883` */
  url: string;
  clientId: string;
  /** Published by the broker, retained, if this client goes away without saying so. */
  will?: { topic: string; payload: string };
  log?: (line: string) => void;
  keepAliveSeconds?: number;
}

type Handler = (topic: string, payload: string) => void;

/** A length the way MQTT writes it: seven bits a byte, the top bit meaning "more". */
function varint(length: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return Buffer.from(bytes);
}

function text(value: string): Buffer {
  const body = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
}

function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body]);
}

/** True when `topic` matches `filter`, with MQTT's `+` (one level) and `#` (the rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const want = filter.split("/"), have = topic.split("/");
  for (let i = 0; i < want.length; i++) {
    if (want[i] === "#") return true;
    if (i >= have.length || (want[i] !== "+" && want[i] !== have[i])) return false;
  }
  return want.length === have.length;
}

export class MqttClient {
  private socket: Socket | undefined;
  private pending = Buffer.alloc(0);
  private readonly subscriptions = new Map<string, Handler>();
  private readonly connectListeners: Array<() => void> = [];
  private ping: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private retryMs = 1000;
  private packetId = 0;
  private stopped = false;
  connected = false;

  constructor(private readonly options: MqttOptions) {}

  /** Called every time the broker accepts the connection, the first time and after each reconnect. */
  onConnect(listener: () => void): void {
    this.connectListeners.push(listener);
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    if (this.socket && this.connected) this.socket.write(packet(14, 0, Buffer.alloc(0)));
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
  }

  publish(topic: string, payload: string, retain = false): void {
    if (!this.connected || !this.socket) return;
    this.socket.write(packet(3, retain ? 1 : 0, Buffer.concat([text(topic), Buffer.from(payload)])));
  }

  /** Listens on a topic filter. Kept across reconnects. */
  subscribe(filter: string, handler: Handler): void {
    this.subscriptions.set(filter, handler);
    if (this.connected) this.sendSubscribe([filter]);
  }

  private sendSubscribe(filters: string[]): void {
    if (!filters.length || !this.socket) return;
    const id = Buffer.alloc(2);
    id.writeUInt16BE((this.packetId = (this.packetId % 65535) + 1));
    this.socket.write(packet(8, 2, Buffer.concat([id, ...filters.flatMap((f) => [text(f), Buffer.from([0])])])));
  }

  private open(): void {
    const url = new URL(this.options.url);
    const keepAlive = this.options.keepAliveSeconds ?? 30;
    const socket = tcpConnect({ host: url.hostname, port: Number(url.port || 1883) });
    this.socket = socket;
    this.pending = Buffer.alloc(0);

    socket.on("connect", () => {
      const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
      const will = this.options.will;
      // Clean session; a will that is retained; a name and password when given.
      const flags = 0x02 | (will ? 0x04 | 0x20 : 0) | (password ? 0x40 : 0) | (user ? 0x80 : 0);
      const keep = Buffer.alloc(2);
      keep.writeUInt16BE(keepAlive);
      socket.write(
        packet(
          1,
          0,
          Buffer.concat([
            text("MQTT"),
            Buffer.from([4, flags]),
            keep,
            text(this.options.clientId),
            ...(will ? [text(will.topic), text(will.payload)] : []),
            ...(user ? [text(user)] : []),
            ...(password ? [text(password)] : []),
          ]),
        ),
      );
    });
    socket.on("data", (chunk) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.read();
    });
    socket.on("error", (error) => this.options.log?.(`mqtt: ${error.message}`));
    socket.on("close", () => {
      clearInterval(this.ping);
      const was = this.connected;
      this.connected = false;
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) return;
      if (was) this.options.log?.("mqtt: connection lost, reconnecting");
      this.retry = setTimeout(() => this.open(), this.retryMs);
      this.retry.unref();
      this.retryMs = Math.min(30_000, this.retryMs * 2);
    });
    socket.setTimeout(keepAlive * 2000, () => socket.destroy());

    clearInterval(this.ping);
    this.ping = setInterval(() => this.connected && socket.write(packet(12, 0, Buffer.alloc(0))), (keepAlive * 1000) / 2);
    this.ping.unref();
  }

  /** Takes whole packets off the front of what has arrived. */
  private read(): void {
    for (;;) {
      if (this.pending.length < 2) return;
      let length = 0, shift = 0, at = 1;
      for (;;) {
        if (at >= this.pending.length) return;
        const byte = this.pending[at++]!;
        length += (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80)) break;
        if (shift > 21) return void this.socket?.destroy();
      }
      if (this.pending.length < at + length) return;
      const type = this.pending[0]! >> 4;
      const body = this.pending.subarray(at, at + length);
      this.pending = this.pending.subarray(at + length);

      if (type === 2) {
        // CONNACK: the second byte is zero when the broker let us in.
        if (body[1] !== 0) {
          this.options.log?.(`mqtt: the broker refused the connection (code ${body[1]})`);
          this.socket?.destroy();
          return;
        }
        this.connected = true;
        this.retryMs = 1000;
        this.sendSubscribe([...this.subscriptions.keys()]);
        for (const listener of this.connectListeners) listener();
      } else if (type === 3) {
        const topicLength = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + topicLength).toString();
        const payload = body.subarray(2 + topicLength).toString();
        for (const [filter, handler] of this.subscriptions) {
          if (topicMatches(filter, topic)) {
            try {
              handler(topic, payload);
            } catch (error) {
              this.options.log?.(`mqtt: handling ${topic} failed: ${(error as Error).message}`);
            }
          }
        }
      }
      // SUBACK and PINGRESP need no answer.
    }
  }
}
