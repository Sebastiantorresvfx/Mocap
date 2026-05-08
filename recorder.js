// MP4 recorder for the OpenPose skeleton view.
// Uses WebCodecs VideoEncoder + mp4-muxer (locally bundled).
//
// Strategy: render each frame to an offscreen canvas, encode to H.264,
// mux into a fragmented MP4. All in-browser, no server.

import { Muxer, ArrayBufferTarget } from "./vendor/mp4/mp4-muxer.mjs";

export async function recordSkeletonMP4({
  width, height, fps, frameCount,
  drawFrame,            // function(ctx, frameIdx) -> draw the skeleton/overlay onto ctx
  onProgress,           // function(0..1)
  withVideoUnderlay,    // bool — draw the source video as background
  videoEl,              // <video> element (only if withVideoUnderlay)
  videoFps,             // capture fps (used to map skeleton frame → video time)
}) {
  if (!("VideoEncoder" in window)) {
    throw new Error("WebCodecs VideoEncoder not supported in this browser. Try Chrome on desktop.");
  }

  // Even dimensions only (H.264 requirement)
  const W = Math.floor(width  / 2) * 2;
  const H = Math.floor(height / 2) * 2;

  // Offscreen canvas we draw each frame onto
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });

  // Pick a workable codec config. avc1.42E01F = baseline profile level 3.1,
  // widely supported. Try AVC first; fall back to bitrate adjustments if hw rejects.
  const tryConfigs = [
    { codec: "avc1.42E01F", bitrate: 4_000_000 },   // baseline 3.1
    { codec: "avc1.4D401F", bitrate: 4_000_000 },   // main 3.1
    { codec: "avc1.42001E", bitrate: 4_000_000 },   // baseline 3.0
  ];

  let chosen = null;
  for (const cfg of tryConfigs) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        ...cfg, width: W, height: H, framerate: fps,
      });
      if (support.supported) {
        chosen = support.config;
        break;
      }
    } catch (e) { /* keep trying */ }
  }
  if (!chosen) throw new Error("No supported H.264 encoder configuration found.");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width: W,
      height: H,
      frameRate: fps,
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { console.error("Encoder error:", e); },
  });
  encoder.configure(chosen);

  // Helper: project the source video aspect to the canvas (object-fit: contain)
  function drawVideoBackground(idx) {
    if (!withVideoUnderlay || !videoEl || !videoEl.videoWidth) return;
    const vAR = videoEl.videoWidth / videoEl.videoHeight;
    const cAR = W / H;
    let dw = W, dh = H, dx = 0, dy = 0;
    if (vAR > cAR) { dh = W / vAR; dy = (H - dh) / 2; }
    else            { dw = H * vAR; dx = (W - dw) / 2; }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    try { ctx.drawImage(videoEl, dx, dy, dw, dh); } catch {}
  }

  function seekVideoTo(t) {
    return new Promise((resolve) => {
      if (!videoEl) return resolve();
      let done = false;
      const onSeek = () => { if (done) return; done = true; videoEl.removeEventListener("seeked", onSeek); resolve(); };
      videoEl.addEventListener("seeked", onSeek);
      videoEl.currentTime = Math.min(t, videoEl.duration - 0.001);
      setTimeout(() => { if (!done) { done = true; resolve(); } }, 500);
    });
  }

  for (let i = 0; i < frameCount; i++) {
    if (withVideoUnderlay && videoEl) {
      await seekVideoTo(i / videoFps);
      drawVideoBackground(i);
    } else {
      ctx.fillStyle = "#0a0908";
      ctx.fillRect(0, 0, W, H);
    }
    // Caller draws the skeleton (and any background grid) on top
    drawFrame(ctx, i, W, H);

    // Encode this frame
    const timestamp = Math.round((i / fps) * 1_000_000);   // µs
    const vf = new VideoFrame(canvas, { timestamp, duration: Math.round(1_000_000 / fps) });
    // Keyframe every 1s for scrubbability
    encoder.encode(vf, { keyFrame: i % Math.max(1, fps) === 0 });
    vf.close();

    if (onProgress) onProgress((i + 1) / frameCount);

    // Yield occasionally so UI updates
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const buf = muxer.target.buffer;
  return new Blob([buf], { type: "video/mp4" });
}
