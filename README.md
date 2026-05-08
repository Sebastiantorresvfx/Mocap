# ARCMOCAP

Browser-only monocular motion capture. Drop in a video, get a BVH file.

## ⚠️ Setup before deploying

The MediaPipe library is bundled locally so the app works under strict
browser shields (Brave, etc). **You must also download the pose model
file manually** before pushing to GitHub Pages:

```bash
cd mocap-studio
mkdir -p models
curl -L -o models/pose_landmarker_lite.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
```

That's ~3MB. After that, the `models/` folder is part of the repo and
the app finds it automatically.

The app has a CDN fallback for non-Brave browsers, so it'll still work
in Safari/Chrome/Firefox even if you skip this step. **Brave users will
hit the same CORS block as before unless the model is local.**

## Deploy

1. `git init`, commit, push to a GitHub repo.
2. Settings → Pages → Source: `main` / `(root)`.
3. `https://YOUR_USER.github.io/REPO/`

No build step, no package.json.

## Pipeline

1. MediaPipe Pose Landmarker (lite or full) → 33 landmarks per frame
2. Confidence-weighted blend toward standing rest pose
3. Anatomical joint clamping (no hyperextension)
4. One Euro Filter smoothing
5. Ground plane lock + optional root translation lock
6. BVH export — 21-joint humanoid, Z-X-Y Euler rotations

Opens in Blender, Maya, Cascadeur, MotionBuilder.

## File structure

```
mocap-studio/
├── .nojekyll
├── index.html
├── style.css
├── app.js
├── skeletonDef.js
├── oneEuro.js
├── bvh.js
├── skeleton3d.js
├── vendor/mediapipe/        ← bundled library (~19 MB)
│   ├── vision_bundle.mjs
│   └── wasm/
└── models/                  ← you create this
    └── pose_landmarker_lite.task
```

## Honest limitations

- Monocular depth is ill-posed. Toward/away-from-camera motion is
  inferred, not measured.
- Hands/fingers: poor (Pose tracks wrists only).
- Fast spins, loose clothing, multiple people: degrades.
- Root translation locked off by default — single-camera distance
  is unreliable.

## License

MIT.
