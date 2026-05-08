// Quaternion math + small vector helpers
// Quaternions stored as [x, y, z, w]

export const v = {
  sub: (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]],
  add: (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
  scale: (a, s) => [a[0]*s, a[1]*s, a[2]*s],
  dot: (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
  cross: (a, b) => [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1e-12;
    return [a[0]/l, a[1]/l, a[2]/l];
  },
};

export const q = {
  identity: () => [0, 0, 0, 1],

  // Quaternion from axis (unit) + angle (rad)
  fromAxisAngle: (axis, angle) => {
    const h = angle * 0.5;
    const s = Math.sin(h);
    return [axis[0]*s, axis[1]*s, axis[2]*s, Math.cos(h)];
  },

  // Quaternion that rotates `from` (unit) to `to` (unit). Both must be normalized.
  fromTo: (from, to) => {
    const d = v.dot(from, to);
    if (d > 0.999999) return [0, 0, 0, 1];
    if (d < -0.999999) {
      // 180° flip — rotate around any axis perpendicular to `from`
      let perp = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const axis = v.norm(v.cross(from, perp));
      return q.fromAxisAngle(axis, Math.PI);
    }
    const c = v.cross(from, to);
    const w = 1 + d;
    return q.normalize([c[0], c[1], c[2], w]);
  },

  // Hamilton product: a then b applied = q.mul(b, a)? Convention: result rotates by `a` first then `b` when used as q.mul(b,a)*v. We use the standard r = a*b means apply b first then a.
  mul: (a, b) => [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
  ],

  conj: (a) => [-a[0], -a[1], -a[2], a[3]],

  // Inverse for unit quaternions = conjugate
  inv: (a) => [-a[0], -a[1], -a[2], a[3]],

  normalize: (a) => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1e-12;
    return [a[0]/l, a[1]/l, a[2]/l, a[3]/l];
  },

  // Rotate a vector by a quaternion
  rotate: (qq, vec) => {
    // r = q * (vec, 0) * q^-1, optimized form:
    const [x, y, z, w] = qq;
    const [vx, vy, vz] = vec;
    const ix =  w*vx + y*vz - z*vy;
    const iy =  w*vy + z*vx - x*vz;
    const iz =  w*vz + x*vy - y*vx;
    const iw = -x*vx - y*vy - z*vz;
    return [
      ix*w + iw*-x + iy*-z - iz*-y,
      iy*w + iw*-y + iz*-x - ix*-z,
      iz*w + iw*-z + ix*-y - iy*-x,
    ];
  },

  // Spherical linear interpolation
  slerp: (a, b, t) => {
    let cosTheta = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
    let bb = b;
    if (cosTheta < 0) {
      bb = [-b[0], -b[1], -b[2], -b[3]];
      cosTheta = -cosTheta;
    }
    if (cosTheta > 0.9995) {
      // Linear blend, then renormalize
      return q.normalize([
        a[0] + t*(bb[0]-a[0]),
        a[1] + t*(bb[1]-a[1]),
        a[2] + t*(bb[2]-a[2]),
        a[3] + t*(bb[3]-a[3]),
      ]);
    }
    const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)));
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1-t)*theta) / sinTheta;
    const wb = Math.sin(t*theta) / sinTheta;
    return [
      wa*a[0] + wb*bb[0],
      wa*a[1] + wb*bb[1],
      wa*a[2] + wb*bb[2],
      wa*a[3] + wb*bb[3],
    ];
  },

  // Convert to ZXY Euler angles (degrees) — for BVH export
  // Order matches BVH channel order Zrotation Xrotation Yrotation
  toEulerZXY: (qq) => {
    const [x, y, z, w] = qq;
    // Build rotation matrix (row-major)
    const xx = x*x, yy = y*y, zz = z*z;
    const xy = x*y, xz = x*z, yz = y*z;
    const wx = w*x, wy = w*y, wz = w*z;
    const m00 = 1 - 2*(yy + zz);
    const m01 = 2*(xy - wz);
    const m02 = 2*(xz + wy);
    const m10 = 2*(xy + wz);
    const m11 = 1 - 2*(xx + zz);
    const m12 = 2*(yz - wx);
    const m20 = 2*(xz - wy);
    const m21 = 2*(yz + wx);
    const m22 = 1 - 2*(xx + yy);
    // Extract intrinsic ZXY: R = Rz * Rx * Ry
    // R12 = -sin(x); singularity when |R12|≈1
    const sx = -Math.max(-1, Math.min(1, m12));
    const xrad = Math.asin(sx);
    let yrad, zrad;
    if (Math.abs(m12) < 0.9999) {
      yrad = Math.atan2(m02, m22);
      zrad = Math.atan2(m10, m11);
    } else {
      yrad = 0;
      zrad = Math.atan2(-m01, m00);
    }
    const D = 180 / Math.PI;
    return [zrad * D, xrad * D, yrad * D];
  },
};
