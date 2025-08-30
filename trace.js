// trace.js
// Face tracking with preview window and camera centering functionality

const { spawn } = require("child_process");
const addon = require("bindings")("faceaddon");
const http = require('http');

// ---- Config ----
const config = require('./config');
const DEVICE = config.camera.device;
const FPS_CANDIDATES = config.camera.fps.split(",").map(s => +s) || [30];
const SIZE_CANDIDATES = config.camera.sizes.split(",");
const PIXFMT_CANDIDATES = config.camera.pixelFormats.split(",");
const SHOW_VIEWER = config.display.showViewer;
const CAMERA_IP = config.cameraControl.ip;
const ENABLE_CAMERA_CONTROL = config.cameraControl.enabled;

// ---- Tiny IOU tracker for stable IDs ----
class TinyTracker {
  constructor(iouThresh = config.tracking.iouThreshold, ttl = config.tracking.trackTTL) {
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

// ---- Minimal RGBA box drawer ----
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

// ---- Draw center crosshair ----
function drawCenterCrosshair(buf, W, H) {
  const centerX = Math.floor(W / 2);
  const centerY = Math.floor(H / 2);
  const { crosshairSize, crosshairThickness, crosshairColor } = config.display;
  
  // Horizontal line
  drawRectRGBA(buf, W, H, centerX - crosshairSize, centerY - crosshairThickness/2, crosshairSize * 2, crosshairThickness, 1, crosshairColor.r, crosshairColor.g, crosshairColor.b, crosshairColor.a);
  // Vertical line
  drawRectRGBA(buf, W, H, centerX - crosshairThickness/2, centerY - crosshairSize, crosshairThickness, crosshairSize * 2, 1, crosshairColor.r, crosshairColor.g, crosshairColor.b, crosshairColor.a);
}

// ---- Draw target vector arrow ----
function drawTargetVector(buf, W, H, pan, tilt, faceCenterX, faceCenterY) {
  const centerX = Math.floor(W / 2);
  const centerY = Math.floor(H / 2);
  
  // Calculate arrow length based on pan/tilt magnitude
  const arrowLength = Math.min(50, Math.max(20, Math.sqrt(pan * pan + tilt * tilt) * 100));
  
  // Calculate arrow direction (point TOWARD the face, not camera movement)
  // Convert face position to normalized offset and invert to point toward face
  const offsetX = (faceCenterX - centerX) / centerX;
  const offsetY = (faceCenterY - centerY) / centerY;
  const arrowPan = -offsetX;  // Point toward face (invert offset)
  const arrowTilt = -offsetY; // Point toward face (invert offset)
  
  // Calculate arrow end point
  const arrowEndX = centerX + arrowPan * arrowLength;
  const arrowEndY = centerY + arrowTilt * arrowLength;
  
  // Draw arrow shaft (blue line from center to arrow end)
  drawArrowLine(buf, W, H, centerX, centerY, arrowEndX, arrowEndY, 3, 0, 0, 255, 255);
  
  // Draw arrow head
  drawArrowHead(buf, W, H, arrowEndX, arrowEndY, arrowPan, arrowTilt, 8, 0, 0, 255, 255);
  
  // Draw text showing pan/tilt values
  drawText(buf, W, H, 10, 30, `Pan: ${pan.toFixed(2)} Tilt: ${tilt.toFixed(2)}`, 255, 255, 255, 255);
  drawText(buf, W, H, 10, 50, `Arrow: Pan: ${arrowPan.toFixed(2)} Tilt: ${arrowTilt.toFixed(2)}`, 0, 255, 255, 255);
}

// ---- Draw arrow line ----
function drawArrowLine(buf, W, H, x1, y1, x2, y2, thickness, r, g, b, a) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.sqrt(dx * dx + dy * dy);
  
  if (distance === 0) return;
  
  const stepX = dx / distance;
  const stepY = dy / distance;
  
  for (let i = 0; i <= distance; i++) {
    const x = Math.round(x1 + stepX * i);
    const y = Math.round(y1 + stepY * i);
    
    // Draw thick line
    for (let tx = -thickness/2; tx <= thickness/2; tx++) {
      for (let ty = -thickness/2; ty <= thickness/2; ty++) {
        const px = x + tx;
        const py = y + ty;
        if (px >= 0 && px < W && py >= 0 && py < H) {
          const index = ((py * W + px) << 2);
          buf[index] = r;
          buf[index + 1] = g;
          buf[index + 2] = b;
          buf[index + 3] = a;
        }
      }
    }
  }
}

// ---- Draw arrow head ----
function drawArrowHead(buf, W, H, x, y, dirX, dirY, size, r, g, b, a) {
  // Normalize direction
  const length = Math.sqrt(dirX * dirX + dirY * dirY);
  if (length === 0) return;
  
  const normX = dirX / length;
  const normY = dirY / length;
  
  // Perpendicular vector for arrow head
  const perpX = -normY;
  const perpY = normX;
  
  // Arrow head points
  const tipX = x;
  const tipY = y;
  const leftX = x - normX * size + perpX * size/2;
  const leftY = y - normY * size + perpY * size/2;
  const rightX = x - normX * size - perpX * size/2;
  const rightY = y - normY * size - perpY * size/2;
  
  // Draw arrow head triangle
  drawTriangle(buf, W, H, tipX, tipY, leftX, leftY, rightX, rightY, r, g, b, a);
}

// ---- Draw triangle ----
function drawTriangle(buf, W, H, x1, y1, x2, y2, x3, y3, r, g, b, a) {
  // Simple triangle filling using line drawing
  const points = [
    {x: Math.round(x1), y: Math.round(y1)},
    {x: Math.round(x2), y: Math.round(y2)},
    {x: Math.round(x3), y: Math.round(y3)}
  ];
  
  // Sort points by Y coordinate
  points.sort((a, b) => a.y - b.y);
  
  // Fill triangle
  for (let y = points[0].y; y <= points[2].y; y++) {
    let x1, x2;
    
    if (y <= points[1].y) {
      // Upper part of triangle
      x1 = interpolate(points[0].x, points[0].y, points[1].x, points[1].y, y);
      x2 = interpolate(points[0].x, points[0].y, points[2].x, points[2].y, y);
    } else {
      // Lower part of triangle
      x1 = interpolate(points[1].x, points[1].y, points[2].x, points[2].y, y);
      x2 = interpolate(points[0].x, points[0].y, points[2].x, points[2].y, y);
    }
    
    // Draw horizontal line
    const startX = Math.min(x1, x2);
    const endX = Math.max(x1, x2);
    
    for (let x = startX; x <= endX; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) {
        const index = ((y * W + x) << 2);
        buf[index] = r;
        buf[index + 1] = g;
        buf[index + 2] = b;
        buf[index + 3] = a;
      }
    }
  }
}

// ---- Interpolate helper ----
function interpolate(x1, y1, x2, y2, y) {
  if (y2 === y1) return x1;
  return x1 + (x2 - x1) * (y - y1) / (y2 - y1);
}

// ---- Simple text drawing ----
function drawText(buf, W, H, x, y, text, r, g, b, a) {
  // Very simple text drawing - just draw colored rectangles for each character
  const charWidth = 8;
  const charHeight = 12;
  
  for (let i = 0; i < text.length; i++) {
    const charX = x + i * charWidth;
    const charY = y;
    
    // Draw a simple rectangle for each character
    drawRectRGBA(buf, W, H, charX, charY, charWidth - 1, charHeight, 1, r, g, b, a);
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

// ---- Camera Control Functions ----
function sendCameraCommand(panSpeed, tiltSpeed) {
    if (!ENABLE_CAMERA_CONTROL) {
        console.log(`Camera control disabled. Would send: pan=${panSpeed.toFixed(2)}, tilt=${tiltSpeed.toFixed(2)}`);
        return;
    }
    
    const url = `http://${CAMERA_IP}/ctrl/pt?action=pt&pan_speed=${panSpeed}&tilt_speed=${tiltSpeed}`;
    http.get(url, (res) => {
        // Optionally handle response
        res.resume();
    }).on('error', (e) => {
        console.error(`Camera command error: ${e.message}`);
    });
}

function stopCamera() {
    if (!ENABLE_CAMERA_CONTROL) {
        console.log(`Camera control disabled. Would send: STOP command`);
        return;
    }
    
    const url = `http://${CAMERA_IP}/ctrl/pt?action=stop`;
    http.get(url, (res) => {
        // Optionally handle response
        res.resume();
    }).on('error', (e) => {
        console.error(`Camera stop command error: ${e.message}`);
    });
}

function calculatePanTilt(face, frameWidth, frameHeight) {
    const centerX = frameWidth / 2;
    const centerY = frameHeight / 2;
    const faceCenterX = face.x + face.w / 2;
    const faceCenterY = face.y + face.h / 2;
    
    // Offset: -1 (left/top) to 1 (right/bottom)
    const offsetX = (faceCenterX - centerX) / centerX;
    const offsetY = (faceCenterY - centerY) / centerY;
    
    // Scale offset to speed using configurable gain
    const gain = config.cameraControl.panTiltGain;
    return {
        pan: Math.max(-1, Math.min(1, offsetX * gain)),
        tilt: Math.max(-1, Math.min(1, offsetY * gain)),
    };
}

function trackFace(face, frameWidth, frameHeight) {
    if (!face) return;
    const { pan, tilt } = calculatePanTilt(face, frameWidth, frameHeight);
    
    // Check if face is centered (within dead zone)
    if (Math.abs(pan) <= config.cameraControl.deadZone && Math.abs(tilt) <= config.cameraControl.deadZone) {
        // Face is centered - stop the camera
        stopCamera();
        console.log(`Face centered - stopping camera`);
    } else {
        // Face is off-center - send movement command
        // Send -1 to 1 values directly to camera API
        const panSpeed = pan;      // -1 to 1 (negative = left, positive = right)
        const tiltSpeed = -tilt;   // Invert tilt (-1 to 1, negative = up, positive = down)
        sendCameraCommand(panSpeed, tiltSpeed);
        console.log(`Tracking: pan=${pan.toFixed(2)}, tilt=${tilt.toFixed(2)} (speed: panSpeed=${panSpeed.toFixed(2)}, tiltSpeed=${tiltSpeed.toFixed(2)})`);
    }
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
  console.log(`Camera control: ${ENABLE_CAMERA_CONTROL ? 'ENABLED' : 'DISABLED'}`);
  if (ENABLE_CAMERA_CONTROL) {
    console.log(`Camera IP: ${CAMERA_IP}`);
  }
  
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  let viewer = null;
  const tracker = new TinyTracker();

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
          
          // Draw center crosshair
          drawCenterCrosshair(frameCopy, W, H);
          
          // Draw face boxes and track the largest face
          let largestFace = null;
          let maxArea = 0;
          
                     for (const d of dets) {
             const area = d.box.w * d.box.h;
             if (area > maxArea) {
               maxArea = area;
               largestFace = d.box;
             }
             const { faceBoxColor, faceBoxThickness } = config.display;
             drawRectRGBA(frameCopy, W, H, d.box.x, d.box.y, d.box.w, d.box.h, faceBoxThickness, faceBoxColor.r, faceBoxColor.g, faceBoxColor.b, faceBoxColor.a);
           }
          
          // Track the largest face and draw target vector
          if (largestFace) {
            const { pan, tilt } = calculatePanTilt(largestFace, W, H);
            const faceCenterX = largestFace.x + largestFace.w / 2;
            const faceCenterY = largestFace.y + largestFace.h / 2;
            
            // Draw target vector arrow
            drawTargetVector(frameCopy, W, H, pan, tilt, faceCenterX, faceCenterY);
            
            // Send tracking commands
            trackFace(largestFace, W, H);
          }
          
          if (SHOW_VIEWER && viewer && !viewer.killed && !viewer.stdin.destroyed) {
            viewer.stdin.write(frameCopy);
          }
          
          if (id % fps === 0) {
            console.log(`[${size} @ ${fps}fps ${pixfmt}] Frame ${id}: ${res.length} face(s)`);
          }
        })
        .catch((err) => console.error("detect error:", err))
        .finally(() => { busy = false; });
    }
  });

  process.on("SIGINT", () => {
    console.log("\nStopping camera and exiting...");
    if (ENABLE_CAMERA_CONTROL) {
      stopCamera();
    }
    try { ff.kill("SIGINT"); } catch {}
    if (viewer && !viewer.killed) { try { viewer.kill("SIGINT"); } catch {} }
    process.exit(0);
  });
}

// ---- Main execution ----
console.log("=== Face Tracker with Camera Control ===");
console.log("Press Ctrl+C to exit");

const combos = [];
for (const fps of FPS_CANDIDATES) {
  for (const size of SIZE_CANDIDATES) {
    for (const pixfmt of PIXFMT_CANDIDATES) {
      combos.push({ size, fps, pixfmt });
    }
  }
}
startNextCombo(combos);

// Export functions for external use
module.exports = { 
  trackFace, 
  calculatePanTilt, 
  sendCameraCommand,
  stopCamera,
  TinyTracker,
  drawRectRGBA,
  drawCenterCrosshair,
  drawTargetVector
};
