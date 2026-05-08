# ARCMOCAP

Browser-only monocular motion capture. Drop in a video, get a BVH file.
No backend, no upload, no install — runs entirely in the browser using
MediaPipe Pose.

## What it actually does

**Pipeline:**
1. **MediaPipe Pose (full)** — 33 body landmarks per frame with confidence
2. **Confidence-weighted blend toward rest pose** — low-confidence joints
   are pulled toward a known-good standing pose. Hides flicker, hides
   occlusions, eliminates the "AI mocap" jitter look.
3. **Anatomical joint clamping** — elbows and knees can't hyperextend or
   fold backward.
4. **One Euro Filter smoothing** — adaptive low-pass per joint axis. Smooth
   when slow, responsive when fast. Standard in VR/AR tracking.
5. **Ground plane lock** — feet pinned to y=0. No vertical drift, no foot
   sliding from depth ambiguity.
6. **Root translation lock** *(optional)* — character stays in place,
   motion is captured as pure rotation. The single biggest quality win.
7. **BVH export** — full humanoid hierarchy (21 joints), Z-X-Y Euler
   rotations, opens in Blender / Maya / Cascadeur / MotionBuilder.

## What you'll actually get

**Good for:** stylized animation, previs, indie games, reference, VTubing,
gesture studies, dance, martial arts forms — anything where the character
is roughly standing/grounded and you want plausible, smooth motion.

**Honest limitations** (these are physics, not bugs to fix):
- Single-camera 3D depth is ill-posed. Motions toward/away from the camera
  are inferred, not measured.
- Fast spins where the body briefly faces away will degrade.
- Hand/finger detail is poor — MediaPipe Pose tracks wrists, not fingers.
- Loose clothing, multiple people, or unusual angles hurt accuracy.
- Root translation (walking across a room) is locked off by default
  because monocular distance is unreliable. You can turn it on, but
  expect drift.

## Deploying to GitHub Pages

1. Create a new repo (e.g. `arcmocap`).
2. Drop all files at the repo root.
3. Settings → Pages → Source: `main` / `(root)` → Save.
4. Wait ~1 min, visit `https://YOUR_USER.github.io/arcmocap/`.

That's it. No build step. No package.json. Pure ES modules + CDN.

### Or: serve locally for testing

```bash
cd mocap-studio
python3 -m http.server 8080
# open http://localhost:8080
```

Use any static server. Must be served over HTTP(S), not `file://`,
because ES modules + the MediaPipe WASM loader need proper origins.

## Files

| file              | purpose                                                  |
|-------------------|----------------------------------------------------------|
| `index.html`      | UI                                                       |
| `style.css`       | styles                                                   |
| `app.js`          | main controller, capture loop, post-processing           |
| `skeletonDef.js`  | MediaPipe landmark indices + standing rest pose          |
| `oneEuro.js`      | One Euro Filter (adaptive smoothing)                     |
| `bvh.js`          | BVH hierarchy + per-frame rotation export                |
| `skeleton3d.js`   | 3D preview (orbit/zoom, no external 3D library)          |

## Controls

- **FPS sample** — frames per second extracted from the source video.
  Higher = smoother but slower capture.
- **Smoothing** — One Euro Filter strength. ~0.5 is a good start.
- **Rest blend** — how strongly low-confidence joints get pulled toward
  the standing rest pose. Higher = cleaner but less expressive.
- **Confidence floor** — anything below this is treated as low-confidence.
- **Lock to ground plane** — pins lowest foot to y=0 each frame.
- **Lock root translation** — keeps hips at origin every frame.
  Captures pure rotation, ideal for character animation.
- **Anatomical joint limits** — prevents impossible elbow/knee bends.

## License

MIT. Do whatever you want.
