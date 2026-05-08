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

    // perspective camera
    this.hFov = 67;            // horizontal field of view (degrees)
    this.camDist = 3.0;        // metres from origin
    this.yaw = 0;
    this.pitch = -0.05;
    this.panY = 0;

    // video element used in overlay mode (set externally)
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
  setHFOV(deg) { this.hFov = deg; }

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
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this.yaw   += dx * 0.01;
      this.pitch += dy * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
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
        const dx = e.touches[0].clientX - tdx, dy = e.touches[0].clientY - tdy;
        tdx = e.touches[0].clientX; tdy = e.touches[0].clientY;
        this.yaw += dx * 0.01; this.pitch += dy * 0.01;
        this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
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
    this.yaw = 0;
    this.pitch = -0.05;
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
      // Place camera so character vertically fills ~70% of frame at given FOV.
      // Vertical FOV from horizontal FOV + aspect ratio.
      const aspect = this.W / this.H;
      const hFovRad = this.hFov * Math.PI / 180;
      const vFovRad = 2 * Math.atan(Math.tan(hFovRad / 2) / aspect);
      this.camDist = (height * 0.7) / (2 * Math.tan(vFovRad / 2));
      this.camDist = Math.max(this.camDist, maxR * 1.5 + 1.0);
    }
  }

  _project(p) {
    // Yaw + pitch rotation around origin (character pivot)
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    let x = p[0]*cy - p[2]*sy;
    let z = p[0]*sy + p[2]*cy;
    let y = p[1];
    const y2 = y*cp - z*sp;
    const z2 = y*sp + z*cp;
    y = y2; z = z2;
    // Camera at (0, 0, camDist), looking toward -z
    const cz = this.camDist - z;
    if (cz < 0.01) return [0, 0, cz];
    const hFovRad = this.hFov * Math.PI / 180;
    const f = (this.W / 2) / Math.tan(hFovRad / 2);
    const sx = (this.W / 2) + (x * f) / cz;
    const sy2 = (this.H / 2) - (y * f) / cz + this.panY;
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
    // We need to mirror that math so the bones land on the person.
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

    // bones
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255, 91, 31, 0.95)";
    ctx.lineWidth = 3;
    for (const [a, b] of LM.CONNECTIONS) {
      const pa = frame.raw2d[a], pb = frame.raw2d[b];
      if (!pa || !pb) continue;
      if (pa.score < 0.3 && pb.score < 0.3) continue;
      const [ax, ay] = proj(pa), [bx, by] = proj(pb);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // joints
    for (let j = 0; j < 33; j++) {
      const p = frame.raw2d[j];
      if (!p) continue;
      const [x, y] = proj(p);
      ctx.fillStyle = `rgba(247, 201, 72, ${Math.max(0.3, p.score)})`;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
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
    for (const [a, b] of LM.CONNECTIONS) {
      const pa = pts[a], pb = pts[b];
      const avgZ = (pa[2] + pb[2]) / 2;
      const shade = Math.max(0.35, Math.min(1, 1 - avgZ * 0.5));
      ctx.strokeStyle = `rgba(255, 91, 31, ${shade})`;
      ctx.lineWidth = 3 * shade;
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
    }

    for (let j = 0; j < 33; j++) {
      const p = pts[j];
      const c = frame.points[j].score;
      const r = 2 + c * 2.5;
      const shade = Math.max(0.4, Math.min(1, 1 - p[2] * 0.5));
      ctx.fillStyle = `rgba(247, 201, 72, ${shade})`;
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
