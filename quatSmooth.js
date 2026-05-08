// SLERP-based smoothing for rotation sequences.
// We adapt the One Euro Filter idea to quaternions: low-pass via SLERP
// between previous smoothed value and current sample, with cutoff
// adapted by the angular velocity between consecutive samples.

import { q } from "./quat.js";

function angleBetween(a, b) {
  let d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
  if (d < 0) d = -d;
  d = Math.min(1, Math.max(-1, d));
  return 2 * Math.acos(d);
}

function alphaFromCutoff(cutoff, freq) {
  const tau = 1.0 / (2 * Math.PI * cutoff);
  const te = 1.0 / freq;
  return 1.0 / (1.0 + tau / te);
}

export class QuatOneEuro {
  constructor(freq, mincutoff = 1.0, beta = 0.0, dcutoff = 1.0) {
    this.freq = freq;
    this.mincutoff = mincutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
    this.prev = null;       // smoothed previous
    this.prevDeriv = 0;     // smoothed angular velocity (rad/s)
    this.lastT = null;
  }
  filter(qq, t) {
    if (this.prev === null) {
      this.prev = qq.slice();
      this.lastT = t;
      return qq;
    }
    if (t > this.lastT) this.freq = 1.0 / (t - this.lastT);
    this.lastT = t;

    const angularDist = angleBetween(this.prev, qq);
    const rawDeriv = angularDist * this.freq;

    // Smooth derivative
    const aD = alphaFromCutoff(this.dcutoff, this.freq);
    const smoothDeriv = aD * rawDeriv + (1 - aD) * this.prevDeriv;
    this.prevDeriv = smoothDeriv;

    const cutoff = this.mincutoff + this.beta * Math.abs(smoothDeriv);
    const alpha = alphaFromCutoff(cutoff, this.freq);
    // SLERP from prev to current sample by alpha
    const out = q.slerp(this.prev, qq, alpha);
    this.prev = out;
    return out;
  }
}

// Smooth a sequence of quaternions in time. `series` is array of quats,
// `dt` is time step.
export function smoothQuatSeries(series, fps, mincutoff = 1.0, beta = 0.5) {
  const filt = new QuatOneEuro(fps, mincutoff, beta);
  const out = new Array(series.length);
  for (let i = 0; i < series.length; i++) {
    out[i] = filt.filter(series[i], i / fps);
  }
  return out;
}
