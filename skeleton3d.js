// Minimal 3D skeleton viewer — no external 3D library.
// Orthographic projection with orbit + zoom, draws bones & joints.

import { LM } from "./skeletonDef.js";

export class Skeleton3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.frames = [];
    this.frameIdx = 0;

    // camera
    this.yaw = 0.4;
    this.pitch = -0.15;
    this.zoom = 1.0;
    this.panY = 0;

    this._bindInput();
    this._resize();
    window.addEventListener("resize", () => this._resize());
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
    this.canvas.addEventListener("mousedown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
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
      e.preventDefault();
      this.zoom *= (1 - e.deltaY * 0.001);
      this.zoom = Math.max(0.3, Math.min(3, this.zoom));
      this.showFrame(this.frameIdx);
    }, { passive: false });

    // touch
    let tdx = 0, tdy = 0, pinchDist = 0;
    this.canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) { tdx = e.touches[0].clientX; tdy = e.touches[0].clientY; }
      else if (e.touches.length === 2) {
        pinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
      }
    });
    this.canvas.addEventListener("touchmove", (e) => {
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
        this.zoom *= d / (pinchDist || d);
        this.zoom = Math.max(0.3, Math.min(3, this.zoom));
        pinchDist = d;
      }
      this.showFrame(this.frameIdx);
    }, { passive: false });
  }

  setFrames(frames) {
    this.frames = frames;
    // Auto-frame: front-on view, scaled so the character fits cleanly
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
      const height = Math.max(0.1, maxY - minY);
      // zoom so character height ~70% of viewport
      this.zoom = 0.7 / Math.max(height, maxR * 1.5);
    }
  }

  _project(p) {
    // yaw rotation around Y, then pitch around X
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    let x = p[0]*cy - p[2]*sy;
    let z = p[0]*sy + p[2]*cy;
    let y = p[1]*cp - z*sp;
    z = p[1]*sp + z*cp;
    // orthographic
    const s = (this.H * 0.35) * this.zoom;
    return [
      this.W / 2 + x * s,
      this.H * 0.55 - y * s + this.panY,
      z
    ];
  }

  showFrame(i) {
    if (!this.frames.length) return;
    this.frameIdx = i;
    const frame = this.frames[i];
    const ctx = this.ctx;
    ctx.fillStyle = "#0a0908";
    ctx.fillRect(0, 0, this.W, this.H);

    // ground grid
    this._drawGround();

    // collect projected points
    const pts = frame.points.map(p => this._project([p.x, p.y, p.z]));

    // bones
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

    // joints
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
