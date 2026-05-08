// Minimal 3D skeleton viewer — no external 3D library.
// Two render modes:
//   "3d"      — orthographic 3D with orbit/zoom
//   "overlay" — flat 2D projection onto the source video using
//               the raw normalized image coords from MediaPipe

import { LM } from "./skeletonDef.js";

export class Skeleton3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.frames = [];
    this.frameIdx = 0;
    this.mode = "overlay";

    // 3D view lens — selectable. Lens focal length → horizontal FOV
    // (full-frame equivalent): 35mm≈54°, 50mm≈40°, 85mm≈24°.
    // Lower FOV = less perspective distortion, more telephoto-flat look.
    this.hFov = 54;            // default 35mm
    this.camDist = 3.0;
    this.yaw = 0;
    this.pitch = -0.05;
    this.panY = 0;

    this.videoEl = null;

    this._bindInput();
    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  setMode(mode) {
    this.mode = mode;
    if (this.frames.length) this.showFrame(this.frameIdx);
  }

  setVideoElement(el) { this.videoEl = el; }
  // 3D view lens selector — adjusts FOV + compensates camera distance
  // so the on-screen character size stays roughly constant across lenses.
  setLens(focalMm) {
    // Approximate horizontal FOV for full-frame equivalents
    const fovTable = { 24: 73, 28: 66, 35: 54, 50: 40, 85: 24, 135: 15 };
    const newFov = fovTable[focalMm] ?? 40;
    const oldFov = this.hFov;
    // Keep apparent size: camDist scales as tan(oldFov/2) / tan(newFov/2)
    const ratio = Math.tan((oldFov * Math.PI / 180) / 2) /
                  Math.tan((newFov * Math.PI / 180) / 2);
    this.camDist *= ratio;
    this.hFov = newFov;
    if (this.frames.length) this.showFrame(this.frameIdx);
  }
  setHFOV(_deg) { /* device picker is for overlay context only */ }

  // Draw a single frame onto an arbitrary 2D context at given size.
  // mode: "overlay" (2D bones using raw2d) or "3d" (perspective projection).
  // Used by the MP4 recorder.
  drawFrameToContext(ctx, W, H, frameIdx, mode) {
    const frame = this.frames[frameIdx];
    if (!frame) return;
    if (mode === "overlay") this._drawOverlayBones(ctx, W, H, frame);
    else                    this._draw3DBones(ctx, W, H, frame);
  }

  _drawOverlayBones(ctx, W, H, frame) {
    if (!frame.raw2d) return;
    let drawW = W, drawH = H, offX = 0, offY = 0;
    if (this.videoEl && this.videoEl.videoWidth) {
      const vAR = this.videoEl.videoWidth / this.videoEl.videoHeight;
      const cAR = W / H;
      if (vAR > cAR) { drawW = W; drawH = W / vAR; offY = (H - drawH) / 2; }
      else            { drawH = H; drawW = H * vAR; offX = (W - drawW) / 2; }
    }
    const proj = (p) => [offX + p.x * drawW, offY + p.y * drawH];
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    for (const [a, b, color] of LM.COLORED_CONNECTIONS) {
      const pa = frame.raw2d[a], pb = frame.raw2d[b];
      if (!pa || !pb) continue;
      if (pa.score < 0.3 && pb.score < 0.3) continue;
      const [ax, ay] = proj(pa), [bx, by] = proj(pb);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    for (let j = 0; j < 33; j++) {
      const p = frame.raw2d[j];
      if (!p) continue;
      const [x, y] = proj(p);
      ctx.fillStyle = LM.JOINT_COLORS[j] || "#fff";
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _draw3DBones(ctx, W, H, frame) {
    const oldW = this.W, oldH = this.H;
    this.W = W; this.H = H;
    const pts = frame.points.map(p => this._project([p.x, p.y, p.z]));
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    for (const [a, b, color] of LM.COLORED_CONNECTIONS) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[a][0], pts[a][1]);
      ctx.lineTo(pts[b][0], pts[b][1]);
      ctx.stroke();
    }
    for (let j = 0; j < 33; j++) {
      ctx.fillStyle = LM.JOINT_COLORS[j] || "#fff";
      ctx.beginPath();
      ctx.arc(pts[j][0], pts[j][1], 5, 0, Math.PI * 2);
      ctx.fill();
    }
    this.W = oldW; this.H = oldH;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = r.width;
    this.H = r.height;
    if (this.frames.length) this.showFrame(this.frameIdx);
  }

  _bindInput() {
    let dragging = false, lx = 0, ly = 0;
    this.canvas.addEventListener("mousedown", (e) => {
      if (this.mode !== "3d") return;
      dragging = true; lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener("mouseup", () => dragging = false);
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx;
      lx = e.clientX; ly = e.clientY;
      this.yaw += dx * 0.01;
      // pitch is locked
      this.showFrame(this.frameIdx);
    });
    this.canvas.addEventListener("wheel", (e) => {
      if (this.mode !== "3d") return;
      e.preventDefault();
      this.camDist *= (1 + e.deltaY * 0.001);
      this.camDist = Math.max(0.5, Math.min(20, this.camDist));
      this.showFrame(this.frameIdx);
    }, { passive: false });

    // touch
    let tdx = 0, tdy = 0, pinchDist = 0;
    this.canvas.addEventListener("touchstart", (e) => {
      if (this.mode !== "3d") return;
      if (e.touches.length === 1) { tdx = e.touches[0].clientX; tdy = e.touches[0].clientY; }
      else if (e.touches.length === 2) {
        pinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
      }
    });
    this.canvas.addEventListener("touchmove", (e) => {
      if (this.mode !== "3d") return;
      e.preventDefault();
      if (e.touches.length === 1) {
        const dx = e.touches[0].clientX - tdx;
        tdx = e.touches[0].clientX; tdy = e.touches[0].clientY;
        this.yaw += dx * 0.01;
        // pitch is locked
      } else if (e.touches.length === 2) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        this.camDist *= (pinchDist || d) / d;
        this.camDist = Math.max(0.5, Math.min(20, this.camDist));
        pinchDist = d;
      }
      this.showFrame(this.frameIdx);
    }, { passive: false });
  }

  setFrames(frames) {
    this.frames = frames;
    this.pitch = 0;            // truly horizontal — no down-tilt
    if (frames.length) {
      let minY = Infinity, maxY = -Infinity, maxR = 0;
      for (const f of frames) {
        for (const p of f.points) {
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
          const r = Math.hypot(p.x, p.z);
          if (r > maxR) maxR = r;
        }
      }
      const height = Math.max(0.5, maxY - minY);
      this.targetY = minY + height * 0.6;
      const aspect = this.W / this.H;
      const hFovRad = this.hFov * Math.PI / 180;
      const vFovRad = 2 * Math.atan(Math.tan(hFovRad / 2) / aspect);
      this.camDist = (height * 0.75) / (2 * Math.tan(vFovRad / 2));
      this.camDist = Math.max(this.camDist, maxR * 1.5 + 1.0);

      // Auto-orient: detect which way the character faces and set default
      // yaw so the camera looks at their FRONT.
      // Facing direction = cross product of (right shoulder - left shoulder)
      // with up vector, projected onto XZ plane.
      const f0 = frames[Math.floor(frames.length / 2)] || frames[0];
      const ls = f0.points[11], rs = f0.points[12]; // 11=LEFT_SHOULDER, 12=RIGHT_SHOULDER
      if (ls && rs) {
        // Shoulder vector L→R in XZ plane
        const sx = rs.x - ls.x, sz = rs.z - ls.z;
        // Facing = perpendicular to shoulder vector, pointing forward.
        // In our coord system, when person faces camera: shoulders span X axis,
        // facing direction is -Z (toward camera placed at +Z).
        // Forward vector = (sz, 0, -sx) normalized
        const fx = sz, fz = -sx;
        const fl = Math.hypot(fx, fz) || 1;
        const fxn = fx / fl, fzn = fz / fl;
        // Camera sits at (0, 0, camDist) looking at origin (toward -Z).
        // We want character's facing to point at +Z (so they look at camera).
        // Required yaw rotates facing vector to (0, 0, 1).
        // atan2(fxn, fzn) gives the angle facing makes with +Z.
        // We rotate by -that to align.
        this.yaw = -Math.atan2(fxn, fzn);
      } else {
        this.yaw = 0;
      }
    }
  }

  _project(p) {
    // Translate so target is at origin (camera looks at chest height)
    const tx = p[0], ty = p[1] - (this.targetY ?? 0), tz = p[2];
    // Yaw rotation around Y
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const x = tx*cy - tz*sy;
    let z = tx*sy + tz*cy;
    // Pitch (locked at 0 for now but math kept for future)
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const y2 = ty*cp - z*sp;
    const z2 = ty*sp + z*cp;
    const y = y2;
    z = z2;
    // Camera at (0, 0, camDist) looking toward -z, target now at origin
    const cz = this.camDist - z;
    if (cz < 0.01) return [0, 0, cz];
    const hFovRad = this.hFov * Math.PI / 180;
    const f = (this.W / 2) / Math.tan(hFovRad / 2);
    const sx = (this.W / 2) + (x * f) / cz;
    const sy2 = (this.H / 2) - (y * f) / cz;
    return [sx, sy2, cz];
  }

  showFrame(i) {
    if (!this.frames.length) return;
    this.frameIdx = i;
    if (this.mode === "overlay") this._renderOverlay(i);
    else this._render3D(i);
  }

  _renderOverlay(i) {
    const frame = this.frames[i];
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);

    if (!frame.raw2d) return;

    // Compute the rect where the video is actually drawn (object-fit: contain).
    let drawW = this.W, drawH = this.H, offX = 0, offY = 0;
    if (this.videoEl && this.videoEl.videoWidth) {
      const vAR = this.videoEl.videoWidth / this.videoEl.videoHeight;
      const cAR = this.W / this.H;
      if (vAR > cAR) {
        drawW = this.W;
        drawH = this.W / vAR;
        offY = (this.H - drawH) / 2;
      } else {
        drawH = this.H;
        drawW = this.H * vAR;
        offX = (this.W - drawW) / 2;
      }
    }

    const proj = (p) => [offX + p.x * drawW, offY + p.y * drawH];

    // Bones with OpenPose limb colors
    ctx.lineCap = "round";
    ctx.lineWidth = 4;
    for (const [a, b, color] of LM.COLORED_CONNECTIONS) {
      const pa = frame.raw2d[a], pb = frame.raw2d[b];
      if (!pa || !pb) continue;
      if (pa.score < 0.3 && pb.score < 0.3) continue;
      const [ax, ay] = proj(pa), [bx, by] = proj(pb);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Joints with OpenPose dot palette
    for (let j = 0; j < 33; j++) {
      const p = frame.raw2d[j];
      if (!p) continue;
      const [x, y] = proj(p);
      ctx.fillStyle = LM.JOINT_COLORS[j] || "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _render3D(i) {
    const frame = this.frames[i];
    const ctx = this.ctx;
    ctx.fillStyle = "#0a0908";
    ctx.fillRect(0, 0, this.W, this.H);

    this._drawGround();

    const pts = frame.points.map(p => this._project([p.x, p.y, p.z]));

    ctx.lineCap = "round";
    for (const [a, b, color] of LM.COLORED_CONNECTIONS) {
      const pa = pts[a], pb = pts[b];
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
    }

    for (let j = 0; j < 33; j++) {
      const p = pts[j];
      const c = frame.points[j].score;
      const r = 3 + c * 2;
      ctx.fillStyle = LM.JOINT_COLORS[j] || "#ffffff";
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawGround() {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(80, 70, 55, 0.35)";
    ctx.lineWidth = 1;
    const N = 10;
    const range = 1.5;
    for (let i = -N; i <= N; i++) {
      const a = this._project([-range, 0, i * range / N]);
      const b = this._project([ range, 0, i * range / N]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      const c = this._project([i * range / N, 0, -range]);
      const d = this._project([i * range / N, 0,  range]);
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
    }
  }
}
