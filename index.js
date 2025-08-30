// index.js — macOS webcam → RGBA → async libfacedetection → live viewer with boxes
const { spawn } = require("child_process");
const addon = require("bindings")("faceaddon");

// ---- Config (override via env if you like) ----
const DEVICE = process.env.CAM_DEVICE ?? "0"; // list devices: ffmpeg -f avfoundation -list_devices true -i ""
const FPS_CANDIDATES = (process.env.CAM_FPS ?? "50").split(",").map(s => +s) || [50];
const SIZE_CANDIDATES = (process.env.CAM_SIZES ?? "1280x720,848x480,1920x1080").split(",");
const PIXFMT_CANDIDATES = (process.env.CAM_PIXF ?? "nv12,uyvy422,yuyv422,yuv420p").split(",");
const SHOW_VIEWER = (process.env.SHOW_VIEWER ?? "1") !== "0"; // needs ffplay

// ---- Tiny IOU tracker for stable IDs ----
class TinyTracker {
  constructor(iouThresh = 0.3, ttl = 30) {
    this.iouThresh = iouThresh; this.ttl = ttl; this.nextId = 1; this.tracks = new Map();
  }
  static iou(a, b) {
    const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const inter = ix * iy, uni = a.w*a.h + b.w*b.h - inter;
    return uni ? inter / uni : 0;
  }
  update(dets) {
    for (const t of this.tracks.values()) t.age++;
    const used = new Set();
    for (const det of dets) {
      let bestId = 0, best = this.iouThresh;
      for (const [id, t] of this.tracks) {
        if (used.has(id)) continue;
        const i = TinyTracker.iou(t.box, det.box);
        if (i > best) { best = i; bestId = id; }
      }
      if (bestId) {
        const t = this.tracks.get(bestId);
        t.box = det.box; t.age = 0; used.add(bestId);
        det.id = bestId;
      } else {
        const id = this.nextId++;
        this.tracks.set(id, { box: det.box, age: 0 });
        det.id = id;
      }
    }
    for (const [id, t] of [...this.tracks]) if (t.age > this.ttl) this.tracks.delete(id);
    return dets;
  }
}

// ---- Minimal RGBA box drawer (t px thick) ----
function drawRectRGBA(buf, W, H, x, y, w, h, t = 3, r = 0, g = 255, b = 0, a = 255) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  x = clamp(x | 0, 0, W - 1);
  y = clamp(y | 0, 0, H - 1);
  w = clamp(w | 0, 1, W - x);
  h = clamp(h | 0, 1, H - y);
  const line = (yy, xx0, xx1) => {
    for (let xx = xx0; xx < xx1; ++xx) {
      const i = ((yy * W + xx) << 2);
      buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = a;
    }
  };
  for (let k = 0; k < t; ++k) { line(y + k, x, x + w); line(y + h - 1 - k, x, x + w); }
  for (let yy = y; yy < y + h; ++yy) {
    for (let k = 0; k < t; ++k) {
      let iL = ((yy * W + (x + k)) << 2), iR = ((yy * W + (x + w - 1 - k)) << 2);
      buf[iL] = r; buf[iL+1] = g; buf[iL+2] = b; buf[iL+3] = a;
      buf[iR] = r; buf[iR+1] = g; buf[iR+2] = b; buf[iR+3] = a;
    }
  }
}

// ---- Viewer (ffplay) ----
function spawnViewer(W, H, fps) {
  const p = spawn("ffplay", [
    "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${W}x${H}`,
    "-framerate", String(fps),
    "-i", "pipe:"
  ], { stdio: ["pipe", "inherit", "inherit"] });
  p.on("error", () => console.error("ffplay not found (brew install ffmpeg). Running headless."));
  return p;
}

// ---- Capture with fallback combos ----
function startNextCombo(list) {
  const next = list.shift();
  if (!next) {
    console.error("\nNo working combo. Check camera index (ffmpeg -f avfoundation -list_devices true -i \"\") and permissions.");
    process.exit(1);
  }
  startCapture(next.size, next.fps, next.pixfmt, () => startNextCombo(list));
}

function startCapture(size, fps, pixfmt, onFail) {
  const [W, H] = size.split("x").map(Number);
  const FRAME_BYTES = W * H * 4;
  const args = [
    "-hide_banner", "-nostats", "-loglevel", "info",
    "-f", "avfoundation",
    "-framerate", String(fps),
    "-pixel_format", pixfmt,
    "-video_size", size,
    "-i", DEVICE,
    "-vf", "format=rgba",
    "-pix_fmt", "rgba",
    "-f", "rawvideo",
    "-"
  ];
  console.log(`\nSpawning ffmpeg: ffmpeg ${args.join(" ")}`);
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  let viewer = null;
  const tracker = new TinyTracker(0.3, 30);

  let accum = Buffer.alloc(0);
  let opened = false, failed = false, busy = false, frameId = 0;

  ff.stderr.on("data", (d) => {
    const s = d.toString(); process.stderr.write(s);
    if (s.includes("Input #0") || s.includes("Stream #0")) opened = true;
    if (/not supported by the device|Error opening input/.test(s)) failed = true;
  });

  ff.on("exit", (code) => {
    if (!opened || failed || code) {
      console.warn(`ffmpeg exited (code ${code ?? "?"}) for ${size} @ ${fps}fps pixfmt=${pixfmt}`);
      if (viewer && !viewer.killed) { try { viewer.kill("SIGINT"); } catch {} }
      onFail();
    }
  });

  ff.stdout.on("data", (chunk) => {
    opened = true;
    if (!viewer && SHOW_VIEWER) viewer = spawnViewer(W, H, fps);

    accum = Buffer.concat([accum, chunk]);
    while (accum.length >= FRAME_BYTES) {
      const view = accum.subarray(0, FRAME_BYTES);
      accum = accum.subarray(FRAME_BYTES);

      if (busy) continue;                // drop for low latency
      const frameCopy = Buffer.allocUnsafe(FRAME_BYTES);
      view.copy(frameCopy);

      busy = true;
      const id = ++frameId;

      addon.detectAndRecognizeAsync(frameCopy, W, H, W * 4, "rgba")
        .then((res) => {
          // track + draw
          const dets = tracker.update(res.map(d => ({ box: d.box, score: d.score })));
          for (const d of dets) drawRectRGBA(frameCopy, W, H, d.box.x, d.box.y, d.box.w, d.box.h, 3, 0, 255, 0, 255);
          if (SHOW_VIEWER && viewer && !viewer.killed && !viewer.stdin.destroyed) {
            viewer.stdin.write(frameCopy);
          }
          if (id % fps === 0) console.log(`[${size} @ ${fps}fps ${pixfmt}] Frame ${id}: ${res.length} face(s)`);
        })
        .catch((err) => console.error("detect error:", err))
        .finally(() => { busy = false; });
    }
  });

  process.on("SIGINT", () => {
    try { ff.kill("SIGINT"); } catch {}
    if (viewer && !viewer.killed) { try { viewer.kill("SIGINT"); } catch {} }
    process.exit(0);
  });
}

// ---- Build combos and go ----
const combos = [];
for (const fps of FPS_CANDIDATES) {
  for (const size of SIZE_CANDIDATES) {
    for (const pixfmt of PIXFMT_CANDIDATES) {
      combos.push({ size, fps, pixfmt });
    }
  }
}
startNextCombo(combos);
