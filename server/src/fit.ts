import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * Shrinks a picture to fit a small screen, as a baseline JPEG: what a board
 * can decode quickly and receive over its socket in a few frames.
 *
 * Decoding a file that came from elsewhere is the risky part, so it runs in a
 * worker thread of its own that is stopped after `timeoutMs`, never on Axis's
 * main loop. Pictures larger than `maxPixels` are refused before decoding
 * (PNG by its header, JPEG by the decoder's own limit). PNG and JPEG only.
 */

const require = createRequire(import.meta.url);
const LIBS = { pngjs: require.resolve("pngjs"), jpegjs: require.resolve("jpeg-js") };

export interface Fitted {
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface FitOptions {
  /** The box to fit in, in pixels. The picture keeps its shape and is never stretched past twice its size. */
  width: number;
  height: number;
  quality?: number;
  maxPixels?: number;
  timeoutMs?: number;
}

export const FIT_TYPES = ["image/png", "image/jpeg"];

// Runs in the worker. Plain JavaScript, since a worker started from a string is not compiled.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { PNG } = require(workerData.libs.pngjs);
const jpeg = require(workerData.libs.jpegjs);
const job = workerData.job;
try {
  const bytes = Buffer.from(job.bytes);
  let src;
  if (job.mime === "image/png") {
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error("not a PNG");
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    if (!w || !h || w * h > job.maxPixels) throw new Error("the picture is too large (" + w + "x" + h + ")");
    const png = PNG.sync.read(bytes);
    src = { data: png.data, width: png.width, height: png.height };
  } else {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: job.maxPixels / 1e6, maxMemoryUsageInMB: 256 });
    src = { data: img.data, width: img.width, height: img.height };
  }
  const scale = Math.min(job.width / src.width, job.height / src.height, 2);
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
  const out = Buffer.alloc(w * h * 4);
  // Each output pixel is the average of the source pixels under it (one pixel when enlarging).
  // Transparent parts are laid on black, the colour of the screen around the picture.
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / scale), y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / scale), x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) / scale)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4, a = src.data[i + 3] / 255;
          r += src.data[i] * a; g += src.data[i + 1] * a; b += src.data[i + 2] * a; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data: out, width: w, height: h }, job.quality);
  parentPort.postMessage({ ok: true, jpeg: encoded.data, width: w, height: h });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
}
`;

export function fitToJpeg(bytes: Buffer, mime: string, options: FitOptions): Promise<Fitted> {
  if (!FIT_TYPES.includes(mime)) return Promise.reject(new Error(`a ${mime} picture cannot be shrunk for a small screen`));
  const job = {
    bytes,
    mime,
    width: options.width,
    height: options.height,
    quality: options.quality ?? 80,
    maxPixels: options.maxPixels ?? 16_000_000,
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { libs: LIBS, job } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("shrinking the picture took too long"));
    }, options.timeoutMs ?? 15_000);
    worker.once("message", (result: { ok: boolean; jpeg?: Uint8Array; width?: number; height?: number; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (result.ok) resolve({ jpeg: Buffer.from(result.jpeg!), width: result.width!, height: result.height! });
      else reject(new Error(result.error ?? "the picture could not be read"));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
