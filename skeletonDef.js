// MediaPipe Pose 33 landmark definitions
// https://developers.google.com/mediapipe/solutions/vision/pose_landmarker

export const LM = {
  NOSE: 0,
  LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
  NAMES: [
    "Nose","LeftEyeInner","LeftEye","LeftEyeOuter",
    "RightEyeInner","RightEye","RightEyeOuter",
    "LeftEar","RightEar","MouthLeft","MouthRight",
    "LeftShoulder","RightShoulder","LeftElbow","RightElbow",
    "LeftWrist","RightWrist","LeftPinky","RightPinky",
    "LeftIndex","RightIndex","LeftThumb","RightThumb",
    "LeftHip","RightHip","LeftKnee","RightKnee",
    "LeftAnkle","RightAnkle","LeftHeel","RightHeel",
    "LeftFootIndex","RightFootIndex"
  ],
  CONNECTIONS: [
    // face
    [0,2],[2,5],[5,8],[0,1],[1,4],[4,7],
    [9,10],
    // shoulders -> arms
    [11,12],
    [11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
    [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
    // torso
    [11,23],[12,24],[23,24],
    // legs
    [23,25],[25,27],[27,29],[27,31],[29,31],
    [24,26],[26,28],[28,30],[28,32],[30,32],
  ],

  // Canonical OpenPose BODY_25 colors, mapped onto MediaPipe's 33 landmarks.
  // The palette is HSV-based: hue rotates around the body, with red at the
  // spine and rainbow gradients down each limb.
  // Reference: OpenPose getColors() output for BODY_25.
  COLORED_CONNECTIONS: [
    // ---- Spine / torso (reds and oranges) ----
    [11, 12, "#ff0000"],   // shoulder line — red
    [11, 23, "#ff5500"],   // L shoulder → L hip
    [12, 24, "#ff5500"],   // R shoulder → R hip
    [23, 24, "#ff0000"],   // hip line — red

    // ---- Face / head (magenta/pinks/purples) ----
    [0, 2,  "#ff00aa"],    // nose → left eye
    [2, 5,  "#dd00ff"],
    [5, 8,  "#aa00ff"],    // → left ear
    [0, 1,  "#ff0099"],    // nose → right eye area
    [1, 4,  "#ff00cc"],
    [4, 7,  "#cc00ff"],    // → right ear
    [9, 10, "#ff0077"],    // mouth

    // ---- LEFT side of CHARACTER (image-right when facing camera) ----
    // OpenPose convention: orange → yellow → green-yellow as you go down
    // upper body, then green for legs.
    // MediaPipe LEFT_* = character's left = image-right when person faces camera.
    [11, 13, "#ff8800"],   // L shoulder → L elbow (orange)
    [13, 15, "#ffaa00"],   // L elbow → L wrist (yellow-orange)
    [15, 17, "#ffcc00"],   // L wrist → L pinky
    [15, 19, "#ffdd00"],   // L wrist → L index
    [15, 21, "#ffee00"],   // L wrist → L thumb
    [17, 19, "#ffd500"],

    // L leg: yellow-green to green
    [23, 25, "#aaff00"],   // L hip → L knee
    [25, 27, "#55ff00"],   // L knee → L ankle
    [27, 29, "#00ff00"],   // L ankle → L heel
    [27, 31, "#00ff44"],   // L ankle → L toe
    [29, 31, "#00ff22"],

    // ---- RIGHT side of CHARACTER (image-left) ----
    // Cool side: cyan → blue → purple
    [12, 14, "#00ffaa"],   // R shoulder → R elbow (teal)
    [14, 16, "#00ffff"],   // R elbow → R wrist (cyan)
    [16, 18, "#00ddff"],
    [16, 20, "#00bbff"],
    [16, 22, "#0099ff"],
    [18, 20, "#00ccff"],

    // R leg: blue → indigo → purple
    [24, 26, "#0066ff"],   // R hip → R knee
    [26, 28, "#0033ff"],   // R knee → R ankle
    [28, 30, "#3300ff"],   // R ankle → R heel
    [28, 32, "#5500ff"],   // R ankle → R toe
    [30, 32, "#4400ff"],
  ],

  // Per-landmark joint dot colors — match the bone palette
  JOINT_COLORS: [
    // 0..10 face
    "#ff0066",   // 0 nose (red-pink)
    "#ff00aa",   // 1 R eye inner
    "#ff0099",   // 2 L eye inner (image-right of nose)
    "#ff00cc",
    "#ff00bb",
    "#dd00ff",
    "#aa00ff",
    "#ff0099",   // 7 L ear
    "#cc00ff",   // 8 R ear
    "#ff0077",   // 9 mouth left
    "#ff0088",   // 10 mouth right
    // 11..16 shoulders/elbows/wrists
    "#ff8800",   // 11 L shoulder (orange)
    "#00ffaa",   // 12 R shoulder (teal)
    "#ffaa00",   // 13 L elbow
    "#00ffff",   // 14 R elbow
    "#ffcc00",   // 15 L wrist
    "#00ddff",   // 16 R wrist
    // 17..22 hand fingers
    "#ffdd00", "#00ccff", "#ffe200", "#00bbff", "#ffee00", "#0099ff",
    // 23..32 hips/knees/ankles/feet
    "#ff5500",   // 23 L hip
    "#ff5500",   // 24 R hip
    "#aaff00",   // 25 L knee
    "#0066ff",   // 26 R knee
    "#55ff00",   // 27 L ankle
    "#0033ff",   // 28 R ankle
    "#00ff00",   // 29 L heel
    "#3300ff",   // 30 R heel
    "#00ff44",   // 31 L toe
    "#5500ff",   // 32 R toe
  ],
};

// Standing rest pose in our centered Y-up coordinate system.
// Hips at origin. Roughly ~1m torso scale.
// Built so that y=0 is at the feet after ground lock.
export const REST_POSE = (() => {
  const r = new Array(33);
  // hips
  r[LM.LEFT_HIP]  = [-0.1, 0, 0];
  r[LM.RIGHT_HIP] = [ 0.1, 0, 0];
  // spine / shoulders
  r[LM.LEFT_SHOULDER]  = [-0.18, 0.5, 0];
  r[LM.RIGHT_SHOULDER] = [ 0.18, 0.5, 0];
  // head
  r[LM.NOSE]            = [0, 0.78, 0.05];
  r[LM.LEFT_EYE_INNER]  = [-0.025, 0.80, 0.04];
  r[LM.LEFT_EYE]        = [-0.04,  0.80, 0.04];
  r[LM.LEFT_EYE_OUTER]  = [-0.06,  0.80, 0.04];
  r[LM.RIGHT_EYE_INNER] = [ 0.025, 0.80, 0.04];
  r[LM.RIGHT_EYE]       = [ 0.04,  0.80, 0.04];
  r[LM.RIGHT_EYE_OUTER] = [ 0.06,  0.80, 0.04];
  r[LM.LEFT_EAR]        = [-0.08, 0.78, 0];
  r[LM.RIGHT_EAR]       = [ 0.08, 0.78, 0];
  r[LM.MOUTH_LEFT]      = [-0.025, 0.74, 0.05];
  r[LM.MOUTH_RIGHT]     = [ 0.025, 0.74, 0.05];
  // arms — rest at sides
  r[LM.LEFT_ELBOW]  = [-0.22, 0.22, 0];
  r[LM.LEFT_WRIST]  = [-0.24, -0.05, 0];
  r[LM.LEFT_PINKY]  = [-0.27, -0.10, 0];
  r[LM.LEFT_INDEX]  = [-0.23, -0.12, 0];
  r[LM.LEFT_THUMB]  = [-0.22, -0.08, 0.02];
  r[LM.RIGHT_ELBOW] = [ 0.22, 0.22, 0];
  r[LM.RIGHT_WRIST] = [ 0.24, -0.05, 0];
  r[LM.RIGHT_PINKY] = [ 0.27, -0.10, 0];
  r[LM.RIGHT_INDEX] = [ 0.23, -0.12, 0];
  r[LM.RIGHT_THUMB] = [ 0.22, -0.08, 0.02];
  // legs
  r[LM.LEFT_KNEE]       = [-0.1, -0.5, 0];
  r[LM.LEFT_ANKLE]      = [-0.1, -0.95, 0];
  r[LM.LEFT_HEEL]       = [-0.1, -0.98, -0.04];
  r[LM.LEFT_FOOT_INDEX] = [-0.1, -1.00, 0.10];
  r[LM.RIGHT_KNEE]       = [ 0.1, -0.5, 0];
  r[LM.RIGHT_ANKLE]      = [ 0.1, -0.95, 0];
  r[LM.RIGHT_HEEL]       = [ 0.1, -0.98, -0.04];
  r[LM.RIGHT_FOOT_INDEX] = [ 0.1, -1.00, 0.10];
  return r;
})();

export const JOINT_LIMITS = {}; // reserved for future per-joint cones
