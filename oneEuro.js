// One Euro Filter — Casiez, Roussel, Vogel (CHI 2012)
// Adaptive low-pass filter for noisy signals.

class LowPass {
  constructor(alpha, init = 0) {
    this.a = alpha;
    this.y = init;
    this.s = init;
    this.initialized = false;
  }
  setAlpha(a) { this.a = a; }
  filter(x) {
    if (!this.initialized) { this.s = x; this.initialized = true; return x; }
    this.s = this.a * x + (1 - this.a) * this.s;
    this.y = x;
    return this.s;
  }
  hatxprev() { return this.s; }
}

export class OneEuroFilter {
  /**
   * @param {number} freq    nominal sample rate (Hz)
   * @param {number} mincutoff minimum cutoff freq
   * @param {number} beta    cutoff slope (responsiveness vs smoothness)
   * @param {number} dcutoff cutoff for derivative
   */
  constructor(freq, mincutoff = 1.0, beta = 0.0, dcutoff = 1.0) {
    this.freq = freq;
    this.mincutoff = mincutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
    this.x = new LowPass(this._alpha(mincutoff));
    this.dx = new LowPass(this._alpha(dcutoff));
    this.lastTime = null;
  }
  _alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }
  filter(x, t) {
    if (this.lastTime !== null && t > this.lastTime) {
      this.freq = 1.0 / (t - this.lastTime);
    }
    this.lastTime = t;
    const prev = this.x.initialized ? this.x.hatxprev() : x;
    const dx = (x - prev) * this.freq;
    const edx = this.dx.filter(dx, t);
    this.dx.setAlpha(this._alpha(this.dcutoff));
    const cutoff = this.mincutoff + this.beta * Math.abs(edx);
    this.x.setAlpha(this._alpha(cutoff));
    return this.x.filter(x);
  }
}
