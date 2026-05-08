// ARCMOCAP — monocular pose → BVH
// Pipeline: MediaPipe Pose → confidence-weighted blend → joint clamping
//           → One Euro smoothing → ground/root lock → BVH export

import { OneEuroFilter } from "./oneEuro.js";
import { exportBVH } from "./bvh.js";
import { Skeleton3D }  from "./skeleton3d.js";
import { LM, REST_POSE, JOINT_LIMITS } from "./skeletonDef.js";
import { calibrateSkeleton, solveFrame, worldToLocal, JOINT_ORDER, PARENT } from "./solver.js";
import { smoothQuatSeries } from "./quatSmooth.js";
import { q } from "./quat.js";

// MediaPipe is loaded dynamically below so we can catch import failures
let PoseLandmarker = null;
let FilesetResolver = null;

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);

const dropzone = $("dropzone"), fileInput = $("videoFile");
const video = $("video"), overlay = $("overlay");
const playBtn = $("playBtn"), scrub = $("scrub"), timeEl = $("time");
const fpsSlider = $("fps"), smoothSlider = $("smooth"),
      blendSlider = $("blend"), confSlider = $("conf");
const smoothVal = $("smoothVal"),
      blendVal = $("blendVal"), confVal = $("confVal");
const lockGround = $("lockGround"), lockRoot = $("lockRoot"),
      clampJoints = $("clampJoints"), levelFeet = $("levelFeet");
const vertSlider = $("vert"), vertVal = $("vertVal");
const captureBtn = $("captureBtn"), cancelBtn = $("cancelBtn");
const progress = $("progress"), progressFill = $("progressFill"),
      progressText = $("progressText");
const exportBVHBtn = $("exportBVH"), exportJSONBtn = $("exportJSON");
const statusEl = $("status"), statusText = $("statusText");
const previewPlay = $("previewPlay"), frameScrub = $("frameScrub");
const frameCounter = $("frameCounter");
const metaFrames = $("metaFrames"), metaDur = $("metaDur"), metaConf = $("metaConf");
const skeletonCanvas = $("skeletonCanvas"), overlayCtx = overlay.getContext("2d");

// ---------------- state ----------------
let landmarker = null;
let videoLoaded = false;
let capturing = false;
let cancelFlag = false;
let frames = [];      // captured & post-processed frames (raw positions)
let rawFrames = [];   // raw landmarker output (debug)
let solvedFrames = []; // FK-solved: { hipPos, local: {jointName: quat} }
let calibration = null;
let skel = null;

// ---------------- status ----------------
function setStatus(s, msg) {
  statusEl.classList.remove("ready","busy","err");
  if (s) statusEl.classList.add(s);
  statusText.textContent = msg;
}

// ---------------- model init ----------------
// Track last error so user can tap status to see it
let lastModelError = "";
let diagLog = [];

function diag(msg) {
  diagLog.push(`[${(performance.now()/1000).toFixed(2)}s] ${msg}`);
  console.log(msg);
}

async function loadMediaPipeLib() {
  // Local first (works in Brave/strict shields). CDN fallback only if local missing.
  const sources = [
    "./vendor/mediapipe/vision_bundle.mjs",
    "https://cdn.jsdelivr.net/npm/@mediapipe/[email protected]/vision_bundle.mjs",
    "https://unpkg.com/@mediapipe/[email protected]/vision_bundle.mjs",
  ];
  let lastErr = null;
  for (const src of sources) {
    try {
      const label = src.startsWith("./") ? "local" : src.split("/")[2];
      diag(`importing ${label}…`);
      const mod = await import(/* @vite-ignore */ src);
      if (mod.PoseLandmarker && mod.FilesetResolver) {
        PoseLandmarker = mod.PoseLandmarker;
        FilesetResolver = mod.FilesetResolver;
        diag(`✓ library loaded from ${label}`);
        return;
      }
      diag(`module loaded but missing exports from ${label}`);
    } catch (e) {
      lastErr = e;
      const label = src.startsWith("./") ? "local" : src.split("/")[2];
      diag(`✗ failed ${label}: ${(e.message||e).slice(0,60)}`);
    }
  }
  throw lastErr || new Error("no source worked");
}

async function initModel() {
  setStatus("busy", "loading library");
  lastModelError = "";

  try {
    if (!PoseLandmarker) await loadMediaPipeLib();
  } catch (e) {
    lastModelError = "library load failed: " + (e.message || e);
    diag(lastModelError);
    setStatus("err", "tap to see error · retry");
    return;
  }

  // Local model path first (works under strict CSP/Brave). Google CDN as fallback.
  const modelUrls = [
    "./models/pose_landmarker_lite.task",
    "./models/pose_landmarker_full.task",
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  ];

  // WASM resolver: local first, then CDN
  const wasmSources = [
    "./vendor/mediapipe/wasm",
    "https://cdn.jsdelivr.net/npm/@mediapipe/[email protected]/wasm",
  ];

  try {
    let fileset = null;
    let wasmErr = null;
    for (const wasmPath of wasmSources) {
      try {
        const label = wasmPath.startsWith("./") ? "local-wasm" : "cdn-wasm";
        setStatus("busy", `loading ${label}`);
        diag(`resolving ${label}…`);
        fileset = await FilesetResolver.forVisionTasks(wasmPath);
        diag(`✓ ${label} ready`);
        break;
      } catch (e) {
        wasmErr = e;
        diag(`✗ wasm at ${wasmPath}: ${(e.message||e).slice(0,60)}`);
      }
    }
    if (!fileset) throw wasmErr || new Error("wasm not loadable");

    let lastErr = null;
    for (const modelAssetPath of modelUrls) {
      const isLocal = modelAssetPath.startsWith("./");
      const modelLabel = (isLocal ? "local-" : "cdn-") +
        (modelAssetPath.includes("_lite") ? "lite" : "full");
      for (const delegate of ["GPU", "CPU"]) {
        try {
          setStatus("busy", `${modelLabel}/${delegate.toLowerCase()}`);
          diag(`trying ${modelLabel}/${delegate}…`);

          // Quick HEAD probe for local URLs so we skip 404s fast
          if (isLocal) {
            const probe = await fetch(modelAssetPath, { method: "HEAD" });
            if (!probe.ok) {
              diag(`  (local model not present, skipping)`);
              continue;
            }
          }

          landmarker = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath, delegate },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputSegmentationMasks: false,
          });
          diag(`✓ landmarker created (${modelLabel}/${delegate})`);
          setStatus("ready", `model ready · ${modelLabel}/${delegate.toLowerCase()}`);
          if (videoLoaded) captureBtn.disabled = false;
          return;
        } catch (e) {
          lastErr = e;
          diag(`✗ ${modelLabel}/${delegate}: ${(e.message||e).slice(0,80)}`);
        }
      }
    }
    throw lastErr || new Error("all init paths failed");
  } catch (e) {
    console.error("model init failed:", e);
    lastModelError = (e && e.message) ? e.message : String(e);
    setStatus("err", "tap to see error · retry");
  }
}

// Tap status to retry / view error
statusEl.addEventListener("click", () => {
  const log = diagLog.join("\n");
  if (statusEl.classList.contains("err")) {
    alert("DIAGNOSTIC LOG:\n\n" + log + "\n\n--- LAST ERROR ---\n" + (lastModelError || "unknown") +
      "\n\nTapping OK will retry.");
    initModel();
  } else {
    alert("DIAGNOSTIC LOG:\n\n" + log);
  }
});
statusEl.style.cursor = "pointer";

// Backup diag button (some users miss the small status indicator)
const diagBtn = document.getElementById("modelDiag");
if (diagBtn) diagBtn.addEventListener("click", () => statusEl.click());

// ---------------- file loading ----------------
let videoSrcUrl = null;

function loadVideoFile(file) {
  if (!file) return;
  if (videoSrcUrl) URL.revokeObjectURL(videoSrcUrl);
  videoSrcUrl = URL.createObjectURL(file);
  video.src = videoSrcUrl;
  // Mirror to preview video element so overlay mode can show the source
  const pv = document.getElementById("previewVideo");
  if (pv) pv.src = videoSrcUrl;
  video.onloadedmetadata = () => {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    videoLoaded = true;
    playBtn.disabled = false;
    scrub.disabled = false;
    captureBtn.disabled = !landmarker;
    timeEl.textContent = `0.00 / ${video.duration.toFixed(2)}`;
    setStatus("ready", "video loaded · ready to capture");
  };
}

fileInput.addEventListener("change", (e) => loadVideoFile(e.target.files[0]));
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault(); dropzone.classList.remove("over");
  loadVideoFile(e.dataTransfer.files[0]);
});

// ---------------- video transport ----------------
playBtn.addEventListener("click", () => {
  if (video.paused) { video.play(); playBtn.textContent = "❚❚ pause"; }
  else { video.pause(); playBtn.textContent = "▶ play"; }
});
video.addEventListener("timeupdate", () => {
  scrub.value = (video.currentTime / video.duration) * 100;
  timeEl.textContent = `${video.currentTime.toFixed(2)} / ${video.duration.toFixed(2)}`;
});
scrub.addEventListener("input", (e) => {
  video.currentTime = (e.target.value / 100) * video.duration;
});

// Slider readouts
const bind = (s, v, fmt = (x) => x) => {
  v.textContent = fmt(s.value);
  s.addEventListener("input", () => v.textContent = fmt(s.value));
};
bind(smoothSlider, smoothVal);
bind(blendSlider, blendVal);
bind(confSlider, confVal);
bind(vertSlider, vertVal);
const heightSlider = $("charHeight"), heightValEl = $("charHeightVal");
bind(heightSlider, heightValEl, (v) => parseFloat(v).toFixed(2) + " m");

// Segmented controls (FPS, aspect)
function bindSeg(id, onChange) {
  document.querySelectorAll(`#${id} button`).forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(`#${id} button`).forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      onChange(b.dataset.val);
    });
  });
}
bindSeg("fpsSeg", (v) => { fpsSlider.value = v; });
bindSeg("aspectSeg", (v) => {
  const wrap = document.getElementById("preview3d");
  if (!wrap) return;
  wrap.classList.remove("aspect-9-16","aspect-16-9","aspect-1-1");
  wrap.classList.add("aspect-" + v.replace(":", "-"));
  if (skel) skel._resize();
});

// Device → horizontal FOV (degrees)
// Computed from sensor width & focal length: FOV = 2 * atan(sw / (2*f))
// iPhone main wide ~ 26mm equiv → ~73° horiz on 4:3, ~63° on 16:9.
// We give *vertical-shoot effective* H-FOV values which is what we actually project with.
const DEVICE_HFOV = {
  "iphone15-main":      67,   // 26mm equiv main, vertical shoot
  "iphone15-ultrawide": 106,  // 13mm ultrawide
  "iphone15-tele3x":    24,   // 77mm tele
  "iphone15-tele5x":    16,   // 120mm tele
  "iphone-front":       72,   // 23mm equiv front
  "generic-50":         40,   // 50mm full-frame ≈ 40° H
  "generic-35":         54,
};
let currentHFOV = DEVICE_HFOV["iphone15-main"];

const deviceSel = document.getElementById("device");
const fovSlider = document.getElementById("fov");
const fovVal    = document.getElementById("fovVal");
const customFovWrap = document.getElementById("customFovWrap");
deviceSel.addEventListener("change", () => {
  if (deviceSel.value === "custom") {
    customFovWrap.style.display = "";
    currentHFOV = +fovSlider.value;
  } else {
    customFovWrap.style.display = "none";
    currentHFOV = DEVICE_HFOV[deviceSel.value] ?? 67;
  }
  if (skel) { skel.setHFOV(currentHFOV); skel.showFrame(skel.frameIdx); }
});
fovSlider.addEventListener("input", () => {
  fovVal.textContent = fovSlider.value + "°";
  if (deviceSel.value === "custom") {
    currentHFOV = +fovSlider.value;
    if (skel) { skel.setHFOV(currentHFOV); skel.showFrame(skel.frameIdx); }
  }
});

// Initialize aspect default
document.getElementById("preview3d")?.classList.add("aspect-9-16");

// ---------------- capture pipeline ----------------
captureBtn.addEventListener("click", startCapture);
cancelBtn.addEventListener("click", () => { cancelFlag = true; });

async function startCapture() {
  if (!landmarker || !videoLoaded || capturing) return;
  capturing = true;
  cancelFlag = false;
  captureBtn.hidden = true;
  cancelBtn.hidden = false;
  progress.hidden = false;

  // iOS Safari/Brave will not decode video frames during programmatic seeks
  // unless the video has been played at least once. Play+pause to prime it.
  try {
    video.muted = true;
    video.playsInline = true;
    await video.play();
    video.pause();
    video.currentTime = 0;
    await new Promise(r => setTimeout(r, 100));
  } catch (e) {
    console.warn("video prime failed:", e);
  }

  const fps = +fpsSlider.value;
  const dt = 1.0 / fps;
  const dur = video.duration;
  const total = Math.floor(dur * fps);

  rawFrames = [];
  frames = [];

  const minCutoff = 1.0 - 0.95 * (+smoothSlider.value);   // ~1.0..0.05
  const beta = 0.05 + (+smoothSlider.value) * 0.5;        // adaptive
  const filters = LM.NAMES.map(() => ({
    x: new OneEuroFilter(fps, minCutoff, beta, 1.0),
    y: new OneEuroFilter(fps, minCutoff, beta, 1.0),
    z: new OneEuroFilter(fps, minCutoff, beta, 1.0),
  }));

  setStatus("busy", "capturing");

  let stuckFrames = 0;
  let lastVideoTime = -1;

  for (let i = 0; i < total; i++) {
    if (cancelFlag) break;

    const t = i * dt;
    await seekVideo(t);

    // detect stuck seek: video time isn't advancing
    if (Math.abs(video.currentTime - lastVideoTime) < 1e-4 && i > 0) {
      stuckFrames++;
      if (stuckFrames >= 3) {
        diag(`✗ video seek stuck at t=${video.currentTime.toFixed(3)}s (frame ${i})`);
        setStatus("err", "video seek failed · tap status for log");
        break;
      }
    } else {
      stuckFrames = 0;
    }
    lastVideoTime = video.currentTime;

    let result;
    try {
      result = landmarker.detectForVideo(video, performance.now() + i);
    } catch (e) {
      diag(`✗ detect frame ${i}: ${(e.message||e).slice(0,80)}`);
      setStatus("err", "detect failed · tap status for log");
      break;
    }

    let lms = null;
    if (result && result.landmarks && result.landmarks.length > 0) {
      lms = result.landmarks[0];
    }
    rawFrames.push(lms);

    const frame = processFrame(lms, filters, i, dt);
    frames.push(frame);

    progressFill.style.width = `${(i / total) * 100}%`;
    progressText.textContent = `processing frame ${i + 1} / ${total}`;

    // yield to the browser every few frames so the UI updates
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  // Post-process: fill rest blend, joint limits, ground/root lock
  postProcess(frames);

  capturing = false;
  captureBtn.hidden = false;
  cancelBtn.hidden = true;
  progress.hidden = true;

  if (frames.length > 0) {
    setStatus("ready", `captured ${frames.length} frames`);
    enableExport();
    initSkeletonPreview();
  } else {
    setStatus("err", "no frames captured");
  }
}

function seekVideo(t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeek);
      resolve();
    };
    const onSeek = () => finish();
    video.addEventListener("seeked", onSeek);
    video.currentTime = Math.min(t, video.duration - 0.001);
    // iOS Safari sometimes never fires `seeked` reliably — fall back after 500ms
    setTimeout(finish, 500);
  });
}

// MediaPipe gives normalized 0..1 image coords + z (depth in image-plane meters,
// with hip-midpoint as origin and roughly the same scale as x).
// We convert to a centered, Y-up coordinate system in meters-ish.
function processFrame(lms, filters, frameIdx, dt) {
  const out = {
    points: new Array(33),     // {x,y,z,score} in centered/scaled world space
    raw2d: null,               // [{x,y,score}, ...] normalized image coords (for overlay)
    rest: false,
  };
  if (!lms) {
    for (let j = 0; j < 33; j++) {
      out.points[j] = { x: REST_POSE[j][0], y: REST_POSE[j][1], z: REST_POSE[j][2], score: 0 };
    }
    out.rest = true;
    return out;
  }

  // Save raw 2D normalized coords for overlay view
  out.raw2d = lms.map(p => ({ x: p.x, y: p.y, score: p.visibility ?? 1.0 }));

  // Hip midpoint as origin
  const lh = lms[LM.LEFT_HIP], rh = lms[LM.RIGHT_HIP];
  const hipX = (lh.x + rh.x) / 2;
  const hipY = (lh.y + rh.y) / 2;
  const hipZ = (lh.z + rh.z) / 2;

  // Scale: shoulder-to-hip distance for normalization
  const ls = lms[LM.LEFT_SHOULDER], rs = lms[LM.RIGHT_SHOULDER];
  const shX = (ls.x + rs.x) / 2;
  const shY = (ls.y + rs.y) / 2;
  let torso = Math.hypot(shX - hipX, shY - hipY);
  if (torso < 0.05) torso = 0.05;
  const scale = 0.5 / torso;

  const t = frameIdx * dt;
  for (let j = 0; j < 33; j++) {
    const p = lms[j];
    const score = p.visibility ?? 1.0;
    // Convert: x right, y up (flip), z forward
    const x = (p.x - hipX) * scale;
    const y = -(p.y - hipY) * scale;
    const z = (p.z - hipZ) * scale;
    // Smooth
    const sx = filters[j].x.filter(x, t);
    const sy = filters[j].y.filter(y, t);
    const sz = filters[j].z.filter(z, t);
    out.points[j] = { x: sx, y: sy, z: sz, score };
  }
  return out;
}

function postProcess(frames) {
  const blendAmt = +blendSlider.value;
  const confFloor = +confSlider.value;
  const lockG = lockGround.checked;
  const lockR = lockRoot.checked;
  const clamp = clampJoints.checked;
  const vertAmt = +vertSlider.value;

  // Foot leveling: detect planted feet (low velocity + near ground) and
  // force heel/ankle/toe to share the same Y. This kills the monocular
  // "floating heel" artifact where the network pushes heel-Y up because
  // it conflates depth with vertical position.
  if (levelFeet.checked && frames.length >= 3) {
    levelPlantedFeet(frames);
  }

  // Compute foot Y baseline across all frames (lowest reliable Y)
  let groundY = Infinity;
  for (const f of frames) {
    if (f.rest) continue;
    const ly = f.points[LM.LEFT_FOOT_INDEX].y;
    const ry = f.points[LM.RIGHT_FOOT_INDEX].y;
    const c1 = f.points[LM.LEFT_FOOT_INDEX].score;
    const c2 = f.points[LM.RIGHT_FOOT_INDEX].score;
    if (c1 > 0.5 && ly < groundY) groundY = ly;
    if (c2 > 0.5 && ry < groundY) groundY = ry;
  }
  if (!isFinite(groundY)) groundY = -1.0;

  let totalConf = 0, totalCount = 0;

  for (const f of frames) {
    // 1. Blend low-confidence joints toward rest pose
    for (let j = 0; j < 33; j++) {
      const p = f.points[j];
      const rest = REST_POSE[j];
      let w = 0;
      if (p.score < confFloor) {
        // strong pull toward rest
        w = blendAmt + (1 - blendAmt) * (1 - p.score / confFloor);
      } else {
        // gentle pull at chosen blend amount
        w = blendAmt * (1 - (p.score - confFloor) / (1 - confFloor + 0.001));
      }
      w = Math.min(0.95, Math.max(0, w));
      p.x = p.x * (1 - w) + rest[0] * w;
      p.y = p.y * (1 - w) + rest[1] * w;
      p.z = p.z * (1 - w) + rest[2] * w;
      totalConf += p.score; totalCount++;
    }

    // 2. Lock root translation: re-center hips at origin
    if (lockR) {
      const lh = f.points[LM.LEFT_HIP], rh = f.points[LM.RIGHT_HIP];
      const cx = (lh.x + rh.x) / 2;
      const cz = (lh.z + rh.z) / 2;
      for (let j = 0; j < 33; j++) {
        f.points[j].x -= cx;
        f.points[j].z -= cz;
      }
    }

    // 3. Lock ground plane: shift so feet sit at y=0
    if (lockG) {
      const ly = f.points[LM.LEFT_FOOT_INDEX].y;
      const ry = f.points[LM.RIGHT_FOOT_INDEX].y;
      const minY = Math.min(ly, ry);
      const dy = -minY;   // bring lowest foot to 0
      for (let j = 0; j < 33; j++) f.points[j].y += dy;
    }

    // 4. Anatomical joint angle limits — applied as bone-length preservation
    //    + cone limits on knees/elbows (no hyperextension)
    if (clamp) applyJointLimits(f);

    // 5. Verticality lock: damp Z toward rest pose Z, then re-align spine
    //    with world up. This kills the "leaning toward camera" artifact
    //    from monocular depth ambiguity.
    if (vertAmt > 0.001) applyVerticality(f, vertAmt);
  }

  // Final pass: scale all coordinates to real-world meters based on
  // user-supplied character height. Uses median detected head-to-foot
  // distance to be robust against outlier frames.
  const targetHeight = +heightSlider.value;
  const detectedHeights = [];
  for (const f of frames) {
    if (f.rest) continue;
    let topY = -Infinity, botY = Infinity;
    for (let j = 0; j < 33; j++) {
      const s = f.points[j].score;
      if (s < 0.4) continue;
      const y = f.points[j].y;
      if (y > topY) topY = y;
      if (y < botY) botY = y;
    }
    if (isFinite(topY) && isFinite(botY)) detectedHeights.push(topY - botY);
  }
  detectedHeights.sort((a, b) => a - b);
  const detected = detectedHeights.length
    ? detectedHeights[Math.floor(detectedHeights.length / 2)]
    : 1.7;
  const scale = targetHeight / Math.max(detected, 0.01);
  for (const f of frames) {
    for (let j = 0; j < 33; j++) {
      f.points[j].x *= scale;
      f.points[j].y *= scale;
      f.points[j].z *= scale;
    }
  }

  // ---------- Constrained FK solve + rotation smoothing ----------
  // This is what makes hands and feet trace true arcs: we treat the
  // smoothed positions as targets, then solve joint rotations on a
  // rigid skeleton. End-effector motion becomes mathematically arc-shaped
  // because the bones can't stretch.
  calibration = calibrateSkeleton(frames, +heightSlider.value);
  diag(`✓ skeleton calibrated · scale ${calibration.scale.toFixed(3)}`);

  const solvedRaw = frames.map(f => solveFrame(f, calibration));

  // Smooth each joint's WORLD quaternion across time, then convert to
  // parent-relative for output. Smoothing in world space prevents
  // child rotations from inheriting parent jitter.
  const fps = +fpsSlider.value;
  const smoothed = solvedRaw.map(s => ({ hipPos: s.hipPos.slice(), world: {} }));
  for (const name of JOINT_ORDER) {
    const series = solvedRaw.map(s => s.world[name] || q.identity());
    const sm = smoothQuatSeries(series, fps,
      /*mincutoff*/ 1.0 - 0.95 * (+smoothSlider.value),
      /*beta*/      0.5);
    for (let i = 0; i < smoothed.length; i++) smoothed[i].world[name] = sm[i];
  }
  // Smooth hip positions (3 channels) using the existing OneEuroFilter
  const hipFilters = [
    new OneEuroFilter(fps, 1.0 - 0.95 * (+smoothSlider.value), 0.5),
    new OneEuroFilter(fps, 1.0 - 0.95 * (+smoothSlider.value), 0.5),
    new OneEuroFilter(fps, 1.0 - 0.95 * (+smoothSlider.value), 0.5),
  ];
  for (let i = 0; i < smoothed.length; i++) {
    const t = i / fps;
    smoothed[i].hipPos[0] = hipFilters[0].filter(smoothed[i].hipPos[0], t);
    smoothed[i].hipPos[1] = hipFilters[1].filter(smoothed[i].hipPos[1], t);
    smoothed[i].hipPos[2] = hipFilters[2].filter(smoothed[i].hipPos[2], t);
  }
  // Convert world → local for each frame
  solvedFrames = smoothed.map(s => ({
    hipPos: s.hipPos,
    world:  s.world,
    local:  worldToLocal(s.world),
  }));
  diag(`✓ solved ${solvedFrames.length} frames with rigid bones`);

  // Rebuild MediaPipe-landmark positions from the solved rigid skeleton
  // via forward kinematics. This way the 3D preview and overlay show
  // the cleaned skeleton (rigid bones, true arcs), not the noisy raw
  // detector output.
  for (let i = 0; i < frames.length; i++) {
    rebuildLandmarksFromSolved(frames[i], solvedFrames[i], calibration);
  }

  // meta
  const avgConf = totalCount ? totalConf / totalCount : 0;
  metaFrames.textContent = frames.length;
  metaDur.textContent = (frames.length / +fpsSlider.value).toFixed(2) + "s";
  metaConf.textContent = avgConf.toFixed(3);
}

function rebuildLandmarksFromSolved(frame, solved, calib) {
  // Forward kinematics from solved world quaternions + bone lengths.
  // World axis convention: each joint's local +Y is "down the bone toward
  // the next joint" (what qLookRotation builds in solver.js).
  const L = calib.lengths;
  const W = solved.world;
  const hip = solved.hipPos;

  // Helper: position of joint = parent_position + parent_world_q * (0, +bone_len, 0)
  // Wait — our convention puts +Y as the bone direction. So child position =
  // parent_pos + rotate(parent_q, [0, bone_len, 0]). But for limbs, bone
  // length goes from parent down to child where the "down" direction is
  // already encoded in the local frame.
  //
  // Simpler: each joint world quat already encodes where its +Y points
  // (the direction of its outgoing bone). So:
  //   childPos = parentJointPos + rotate(parent_world_q, [0, L_to_child, 0])
  // But the child position is what the parent's bone produces — we use
  // the *parent's* world q to project the parent's bone length.

  // Build the chain manually.
  // Hip world position = hip
  // Spine joint world position = hip + W.Hips * (0, torso*0.4, 0)
  // Actually our offsets in BVH put Spine at (0, torso*0.4, 0) from hip,
  // Chest at (0, torso*0.6, 0) from Spine. Let's mirror that.
  const offsetsM = {
    Spine:         [0, L.torso * 0.5, 0],
    Chest:         [0, L.torso * 0.5, 0],
    Neck:          [0, L.neck, 0],
    Head:          [0, L.head, 0],

    LeftShoulder:  [-L.clav_L, 0, 0],
    LeftArm:       [0, 0, 0],
    LeftForeArm:   [0, L.upperArm_L, 0],
    LeftHand:      [0, L.foreArm_L, 0],

    RightShoulder: [L.clav_R, 0, 0],
    RightArm:      [0, 0, 0],
    RightForeArm:  [0, L.upperArm_R, 0],
    RightHand:     [0, L.foreArm_R, 0],

    LeftUpLeg:     [-L.pelvis_L, 0, 0],
    LeftLeg:       [0, L.thigh_L, 0],
    LeftFoot:      [0, L.shin_L, 0],
    LeftToe:       [0, L.foot_L, 0],

    RightUpLeg:    [L.pelvis_R, 0, 0],
    RightLeg:      [0, L.thigh_R, 0],
    RightFoot:     [0, L.shin_R, 0],
    RightToe:      [0, L.foot_R, 0],
  };

  // Compute world positions of each named joint by walking the hierarchy
  const pos = { Hips: hip.slice() };
  const order = JOINT_ORDER;
  for (const name of order) {
    if (name === "Hips") continue;
    const parent = PARENT[name];
    const offsetLocal = offsetsM[name] || [0, 0, 0];
    const parentQ = W[parent] || q.identity();
    const offWorld = q.rotate(parentQ, offsetLocal);
    pos[name] = [
      pos[parent][0] + offWorld[0],
      pos[parent][1] + offWorld[1],
      pos[parent][2] + offWorld[2],
    ];
  }

  // Map joint world positions onto the 33 MediaPipe landmark slots
  // so the existing 3D preview / overlay code keeps working.
  // (We only fill the ones that matter; rest stay where they were.)
  const setP = (lmIdx, p) => {
    frame.points[lmIdx].x = p[0];
    frame.points[lmIdx].y = p[1];
    frame.points[lmIdx].z = p[2];
  };
  setP(LM.LEFT_HIP,        pos.LeftUpLeg);
  setP(LM.RIGHT_HIP,       pos.RightUpLeg);
  setP(LM.LEFT_SHOULDER,   pos.LeftArm);
  setP(LM.RIGHT_SHOULDER,  pos.RightArm);
  setP(LM.LEFT_ELBOW,      pos.LeftForeArm);
  setP(LM.RIGHT_ELBOW,     pos.RightForeArm);
  setP(LM.LEFT_WRIST,      pos.LeftHand);
  setP(LM.RIGHT_WRIST,     pos.RightHand);
  setP(LM.LEFT_KNEE,       pos.LeftLeg);
  setP(LM.RIGHT_KNEE,      pos.RightLeg);
  setP(LM.LEFT_ANKLE,      pos.LeftFoot);
  setP(LM.RIGHT_ANKLE,     pos.RightFoot);
  setP(LM.LEFT_FOOT_INDEX, pos.LeftToe);
  setP(LM.RIGHT_FOOT_INDEX,pos.RightToe);
  setP(LM.NOSE,            pos.Head);
}

function levelPlantedFeet(frames) {
  const SIDES = [
    { ankle: LM.LEFT_ANKLE,  heel: LM.LEFT_HEEL,  toe: LM.LEFT_FOOT_INDEX  },
    { ankle: LM.RIGHT_ANKLE, heel: LM.RIGHT_HEEL, toe: LM.RIGHT_FOOT_INDEX },
  ];

  for (const side of SIDES) {
    // 1. Collect ankle Y trajectory + estimate ground level (5th percentile)
    const ankleYs = frames.map(f => f.points[side.ankle].y);
    const sorted = [...ankleYs].sort((a, b) => a - b);
    const groundY = sorted[Math.floor(sorted.length * 0.05)];

    // 2. Compute per-frame ankle vertical velocity (smoothed)
    const vel = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const a = ankleYs[Math.max(0, i - 1)];
      const b = ankleYs[Math.min(frames.length - 1, i + 1)];
      vel[i] = Math.abs(b - a);
    }

    // Threshold: ankle is within 12% of the foot's vertical range above
    // ground AND velocity is low → planted.
    const range = sorted[sorted.length - 1] - groundY;
    const heightThreshold = groundY + range * 0.15;
    const velThreshold = Math.max(0.01, range * 0.05);

    // 3. Build planted mask + smooth it (require 2+ consecutive frames)
    const planted = new Array(frames.length).fill(false);
    for (let i = 0; i < frames.length; i++) {
      if (ankleYs[i] <= heightThreshold && vel[i] <= velThreshold) {
        planted[i] = true;
      }
    }
    // erode/dilate: drop singletons, keep runs ≥ 2 frames
    const cleaned = [...planted];
    for (let i = 0; i < frames.length; i++) {
      if (planted[i] && !planted[i-1] && !planted[i+1]) cleaned[i] = false;
    }

    // 4. For each planted frame, level heel/ankle/toe to the same Y.
    //    Use the lowest of the three (closest to floor), keep X/Z intact.
    for (let i = 0; i < frames.length; i++) {
      if (!cleaned[i]) continue;
      const f = frames[i];
      const h = f.points[side.heel];
      const a = f.points[side.ankle];
      const t = f.points[side.toe];
      const floorY = Math.min(h.y, t.y);
      // Heel and toe go to the same Y (the floor for that frame).
      // Ankle stays a small offset above (~ankle bone length).
      const ankleOffset = Math.max(0.04, (a.y - floorY) * 0.5);
      h.y = floorY;
      t.y = floorY;
      a.y = floorY + ankleOffset;
    }
  }
}


function applyVerticality(f, amount) {
  // Step A: damp each joint's Z toward its rest-pose Z.
  // amount=0 → pure raw depth, amount=1 → fully flat at rest Z.
  for (let j = 0; j < 33; j++) {
    const p = f.points[j];
    const restZ = REST_POSE[j][2];
    p.z = p.z * (1 - amount) + restZ * amount;
  }

  // Step B: rotate the whole skeleton so spine (hip-mid → shoulder-mid)
  // points along world +Y. This corrects the "leaning toward camera"
  // tilt left over from monocular depth ambiguity. Apply at full strength
  // when amount > 0 — the slider controls the Z-damp, this is a hard fix.
  const lh = f.points[LM.LEFT_HIP], rh = f.points[LM.RIGHT_HIP];
  const ls = f.points[LM.LEFT_SHOULDER], rs = f.points[LM.RIGHT_SHOULDER];
  const hipMid  = [(lh.x+rh.x)/2, (lh.y+rh.y)/2, (lh.z+rh.z)/2];
  const shMid   = [(ls.x+rs.x)/2, (ls.y+rs.y)/2, (ls.z+rs.z)/2];
  const spine   = [shMid[0]-hipMid[0], shMid[1]-hipMid[1], shMid[2]-hipMid[2]];
  const spineLen = Math.hypot(spine[0], spine[1], spine[2]);
  if (spineLen < 1e-4) return;

  // Compute the rotation that takes current spine direction to world up (0,1,0)
  const sn = [spine[0]/spineLen, spine[1]/spineLen, spine[2]/spineLen];
  const up = [0, 1, 0];
  // axis = sn × up
  const ax = [sn[1]*up[2]-sn[2]*up[1], sn[2]*up[0]-sn[0]*up[2], sn[0]*up[1]-sn[1]*up[0]];
  const axLen = Math.hypot(ax[0], ax[1], ax[2]);
  if (axLen < 1e-4) return;        // already vertical
  const axisN = [ax[0]/axLen, ax[1]/axLen, ax[2]/axLen];
  const cosA = sn[0]*up[0] + sn[1]*up[1] + sn[2]*up[2];
  const angle = Math.atan2(axLen, cosA);
  // Apply only a fraction of the rotation, scaled by the verticality slider
  const theta = angle * amount;
  const c = Math.cos(theta), s = Math.sin(theta), C = 1 - c;
  const [kx, ky, kz] = axisN;
  // Rodrigues rotation, applied around hipMid as pivot
  const R = [
    c + kx*kx*C,    kx*ky*C - kz*s, kx*kz*C + ky*s,
    ky*kx*C + kz*s, c + ky*ky*C,    ky*kz*C - kx*s,
    kz*kx*C - ky*s, kz*ky*C + kx*s, c + kz*kz*C,
  ];
  for (let j = 0; j < 33; j++) {
    const p = f.points[j];
    const dx = p.x - hipMid[0], dy = p.y - hipMid[1], dz = p.z - hipMid[2];
    p.x = hipMid[0] + R[0]*dx + R[1]*dy + R[2]*dz;
    p.y = hipMid[1] + R[3]*dx + R[4]*dy + R[5]*dz;
    p.z = hipMid[2] + R[6]*dx + R[7]*dy + R[8]*dz;
  }
}

function applyJointLimits(f) {
  // Prevent elbow/knee hyperextension: clamp the angle at the joint to [10°, 170°]
  const limbs = [
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
    [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
    [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
  ];
  for (const [a, b, c] of limbs) {
    const A = f.points[a], B = f.points[b], C = f.points[c];
    const v1 = sub(A, B), v2 = sub(C, B);
    const l1 = len(v1), l2 = len(v2);
    if (l1 < 1e-4 || l2 < 1e-4) continue;
    const cosA = dot(v1, v2) / (l1 * l2);
    // Clamp cos to [cos(170), cos(10)]
    const minCos = Math.cos(170 * Math.PI / 180);   // ~ -0.985
    const maxCos = Math.cos(10  * Math.PI / 180);   // ~  0.985
    if (cosA > maxCos) {
      // straighten too much — pull C slightly to bend
      const perp = perpInPlane(v1, v2);
      C.x = B.x + v2[0] * (1 - 0.05) + perp[0] * 0.05 * l2;
      C.y = B.y + v2[1] * (1 - 0.05) + perp[1] * 0.05 * l2;
      C.z = B.z + v2[2] * (1 - 0.05) + perp[2] * 0.05 * l2;
    } else if (cosA < minCos) {
      // hyperflexion (folded backward)
      C.x = B.x - v1[0] / l1 * l2 * 0.99;
      C.y = B.y - v1[1] / l1 * l2 * 0.99;
      C.z = B.z - v1[2] / l1 * l2 * 0.99;
    }
  }
}

function sub(a,b){ return [a.x-b.x, a.y-b.y, a.z-b.z]; }
function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function len(a){ return Math.hypot(a[0],a[1],a[2]); }
function perpInPlane(v1, v2) {
  // rough perpendicular via cross with up
  const up = [0,1,0];
  const c = [
    v1[1]*up[2]-v1[2]*up[1],
    v1[2]*up[0]-v1[0]*up[2],
    v1[0]*up[1]-v1[1]*up[0],
  ];
  const l = Math.hypot(c[0],c[1],c[2]) || 1;
  return [c[0]/l, c[1]/l, c[2]/l];
}

// ---------------- preview overlay (2D on video) ----------------
function drawOverlay(lms) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lms) return;
  const W = overlay.width, H = overlay.height;
  overlayCtx.strokeStyle = "rgba(255, 91, 31, 0.85)";
  overlayCtx.lineWidth = 2;
  for (const [a, b] of LM.CONNECTIONS) {
    overlayCtx.beginPath();
    overlayCtx.moveTo(lms[a].x * W, lms[a].y * H);
    overlayCtx.lineTo(lms[b].x * W, lms[b].y * H);
    overlayCtx.stroke();
  }
  overlayCtx.fillStyle = "#f7c948";
  for (const p of lms) {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x * W, p.y * H, 3, 0, Math.PI * 2);
    overlayCtx.fill();
  }
}

// ---------------- 3D preview ----------------
function initSkeletonPreview() {
  if (!skel) skel = new Skeleton3D(skeletonCanvas);
  const pv = document.getElementById("previewVideo");
  skel.setVideoElement(pv);
  skel.setHFOV(currentHFOV);
  skel.setFrames(frames);
  frameScrub.disabled = false;
  previewPlay.disabled = false;
  frameScrub.max = frames.length - 1;
  frameScrub.value = 0;

  // Default to overlay mode
  document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('.view-btn[data-view="overlay"]')?.classList.add("active");
  document.getElementById("preview3d").classList.add("mode-overlay");
  skel.setMode("overlay");

  // Prime the preview video — must be playable for seek to work on iOS
  if (pv) {
    pv.muted = true;
    pv.playsInline = true;
    const startSync = () => {
      syncPreviewVideo(0);
      skel.showFrame(0);
    };
    if (pv.readyState >= 2) {
      // already have current frame data
      pv.play().then(() => pv.pause()).catch(() => {}).finally(startSync);
    } else {
      pv.addEventListener("loadeddata", () => {
        pv.play().then(() => pv.pause()).catch(() => {}).finally(startSync);
      }, { once: true });
      pv.load();
    }
  } else {
    skel.showFrame(0);
  }
  frameCounter.textContent = `1 / ${frames.length}`;
}

function syncPreviewVideo(frameIdx) {
  const pv = document.getElementById("previewVideo");
  if (!pv) return;
  const fps = +fpsSlider.value;
  const t = frameIdx / fps;
  if (!pv.duration) return;
  try {
    pv.currentTime = Math.min(Math.max(t, 0), pv.duration - 0.001);
  } catch (e) {
    console.warn("preview seek failed:", e);
  }
}

// View toggle buttons
document.querySelectorAll(".view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    const wrap = document.getElementById("preview3d");
    const hint = document.getElementById("hintOverlay");
    if (view === "overlay") {
      wrap.classList.add("mode-overlay");
      if (hint) hint.textContent = "skeleton overlaid on source video";
      if (skel) skel.setMode("overlay");
    } else {
      wrap.classList.remove("mode-overlay");
      if (hint) hint.textContent = "drag sideways to orbit · pinch to dolly";
      if (skel) skel.setMode("3d");
    }
  });
});

// Lens toggle (only relevant in 3D mode)
document.querySelectorAll("#lensToggle button").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll("#lensToggle button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (skel) {
      skel.setLens(+btn.dataset.lens);
      skel.showFrame(skel.frameIdx);
    }
  });
});
frameScrub.addEventListener("input", (e) => {
  if (!skel) return;
  const i = +e.target.value;
  syncPreviewVideo(i);
  skel.showFrame(i);
  frameCounter.textContent = `${i + 1} / ${frames.length}`;
});
let previewing = false, previewRAF = null;
previewPlay.addEventListener("click", () => {
  if (!skel) return;
  previewing = !previewing;
  previewPlay.textContent = previewing ? "❚❚ pause" : "▶ preview";
  if (previewing) {
    let last = performance.now();
    let i = +frameScrub.value;
    const fps = +fpsSlider.value;
    const step = (now) => {
      if (!previewing) return;
      const elapsed = now - last;
      if (elapsed >= 1000 / fps) {
        i = (i + 1) % frames.length;
        syncPreviewVideo(i);
        skel.showFrame(i);
        frameScrub.value = i;
        frameCounter.textContent = `${i + 1} / ${frames.length}`;
        last = now;
      }
      previewRAF = requestAnimationFrame(step);
    };
    previewRAF = requestAnimationFrame(step);
  } else {
    cancelAnimationFrame(previewRAF);
  }
});

// ---------------- export ----------------
function enableExport() {
  exportBVHBtn.disabled = false;
  exportJSONBtn.disabled = false;
}
exportBVHBtn.addEventListener("click", () => {
  const fps = +fpsSlider.value;
  if (!solvedFrames.length || !calibration) return;
  const bvh = exportBVH(solvedFrames, fps, calibration);
  download(bvh, "mocap.bvh", "text/plain");
});
exportJSONBtn.addEventListener("click", () => {
  const fps = +fpsSlider.value;
  const json = JSON.stringify({
    fps, frameCount: frames.length,
    landmarkNames: LM.NAMES,
    frames: frames.map(f => ({
      points: f.points.map(p => [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5), +p.score.toFixed(3)])
    })),
  });
  download(json, "mocap.json", "application/json");
});
function download(text, name, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------- boot ----------------
initModel();
