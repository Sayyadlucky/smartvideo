// ================================================
// src/app/dashboard/gazeTracker.ts
// Ultra-smooth gaze tracker with on-screen/off-screen detection
// ================================================

import { FaceMesh } from "@mediapipe/face_mesh";

/**
 * vNext – production-ready gaze tracking:
 *  • 9-point calibration & quadratic regression
 *  • Adaptive smoothing + Kalman filtering
 *  • Resolution-independent mapping
 *  • Reliable on/off-screen detection (3 s timeout)
 *  • Debug overlay (toggle with `debug` flag)
 */

export type GazeStatus =
  | "CENTER"
  | "LEFT"
  | "RIGHT"
  | "UP"
  | "DOWN"
  | "offscreen";

export type CalibrationMap = Record<
  string,
  { horiz: number; vert: number }
>;

// ======================================================
// =============== Internal State =======================
// ======================================================

let faceMesh: FaceMesh | null = null;
let running = false;
let rafId: number | null = null;

let overlayCanvas: HTMLCanvasElement | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;

// Debug flag (controls dot & text; border always visible)
let debug = true;

// History smoothing (discrete)
const DISCRETE_SMOOTH_WIN = 5;
const gazeHistory: GazeStatus[] = [];
let stableGaze: GazeStatus = "CENTER";
let lastDiscreteStatus: GazeStatus = "CENTER";

// Adaptive smoothing
let emaH = 0.5,
  emaV = 0.5,
  lastH = 0.5,
  lastV = 0.5,
  avgSpeed = 8;
const MIN_ALPHA = 0.03;
const MAX_ALPHA = 0.25;

// Calibration & model
type QuadModel = { coeffX: number[]; coeffY: number[] } | null;
let model: QuadModel = null;

type Sample = { h: number; v: number; x: number; y: number; w: number; ts: number };
const samples: Sample[] = [];

let calScaleH = 1;
let calScaleV = 1;
let deviceRatio = 1;

// Output interpolation
type OutPt = { x: number; y: number; t: number };
let lastOut: OutPt | null = null;
let lastTarget: OutPt | null = null;

// ======================================================
// =============== Kalman & Camera Model ================
// ======================================================

const cameraModel = {
  width: 640,
  height: 480,
  fx: 1,
  fy: 1,
  cx: 0.5,
  cy: 0.5,
  tiltX: 0.0,
  tiltY: 0.0,
  roll: 0,
  homography: null as number[][] | null,
};

let kalmanX = [0.5, 0.5, 0, 0];
let kalmanP = eye(4, 1e-2);
let kalmanQbase = [
  [1e-6, 0, 0, 0],
  [0, 1e-6, 0, 0],
  [0, 0, 2e-4, 0],
  [0, 0, 0, 2e-4],
];
let kalmanR = [
  [2e-4, 0],
  [0, 2e-4],
];
let lastKalmanT = 0;

function updateIntrinsicsFromCamera() {
  const { width, height } = cameraModel;
  const fx = 0.9 * Math.min(width, height);
  cameraModel.fx = fx;
  cameraModel.fy = fx;
  cameraModel.cx = width / 2;
  cameraModel.cy = height / 2;
}

function setCameraFromVideo(videoEl: HTMLVideoElement) {
  const w = videoEl.videoWidth || videoEl.clientWidth || 640;
  const h = videoEl.videoHeight || videoEl.clientHeight || 480;
  cameraModel.width = Math.max(2, w);
  cameraModel.height = Math.max(2, h);
  updateIntrinsicsFromCamera();
}

// ======================================================
// =============== Kalman Gaze Step ======================
// ======================================================

function kalmanStepGaze(
  xm: number,
  ym: number,
  nowMs: number,
  cal?: CalibrationMap
) {
  const { xn, yn } = measurementToNormalized(xm, ym);
  const { xw, yw } = warpEdgeNonlinearity(xn, yn, cal);

  const depthComp = (cameraModel.width / cameraModel.fx) * 0.001;
  const xp = xw + depthComp * (xw - 0.5);
  const yp = yw + depthComp * (yw - 0.5);

  const dt =
    lastKalmanT === 0
      ? 1 / 60
      : Math.min(0.1, Math.max(1 / 240, (nowMs - lastKalmanT) / 1000));
  lastKalmanT = nowMs;

  const F = [
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const H = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ];

  const edgeX = Math.min(1, Math.abs(xp - 0.5) * 2);
  const edgeY = Math.min(1, Math.abs(yp - 0.5) * 2);
  const qScaleX = 0.3 + 0.7 * edgeX;
  const qScaleY = 0.3 + 0.7 * edgeY;
  const Qs = [
    [kalmanQbase[0][0] * qScaleX, 0, 0, 0],
    [0, kalmanQbase[1][1] * qScaleY, 0, 0],
    [0, 0, kalmanQbase[2][2] * qScaleX, 0],
    [0, 0, 0, kalmanQbase[3][3] * qScaleY],
  ];

  kalmanX = matMulVecNum(F, kalmanX);
  const Ft = transpose(F);
  kalmanP = matAddNum(matMulFFNum(matMulFFNum(F, kalmanP), Ft), Qs);

  const z = [xp, yp];
  const HX = matMulVecNum(H, kalmanX);
  const innov = [z[0] - HX[0], z[1] - HX[1]];
  const Ht = transpose(H);
  const S = matAddNum(matMulFFNum(matMulFFNum(H, kalmanP), Ht), kalmanR);
  const K = matMulFFNum(matMulFFNum(kalmanP, Ht), inv2(S));
  kalmanX = matAddVec(kalmanX, matMulVecNum(K, innov));

  const I = eye(4, 1);
  const KH = matMulFFNum(K, H);
  const IKH = matSubNum(I, KH);
  const term1 = matMulFFNum(matMulFFNum(IKH, kalmanP), transpose(IKH));
  const term2 = matMulFFNum(matMulFFNum(K, kalmanR), transpose(K));
  kalmanP = matAddNum(term1, term2);

  // return { xk: clamp01(kalmanX[0]), yk: clamp01(kalmanX[1]) };
  return {
    xk: Math.max(-0.5, Math.min(1.5, kalmanX[0])),
    yk: Math.max(-0.5, Math.min(1.5, kalmanX[1])),
  };
  
}

// ======================================================
// ========== Measurement & Tilt Normalization ==========
// ======================================================

function measurementToNormalized(xm: number, ym: number) {
  const { width, height, fx, fy, cx, cy, tiltX, tiltY, roll, homography } =
    cameraModel;
  const u = xm * (width - 1);
  const v = ym * (height - 1);
  let uDeskew = u,
    vDeskew = v;

  if (homography) {
    const denom =
      homography[2][0] * u + homography[2][1] * v + homography[2][2];
    const s = Math.abs(denom) < 1e-9 ? (denom >= 0 ? 1e-9 : -1e-9) : denom;
    uDeskew =
      (homography[0][0] * u + homography[0][1] * v + homography[0][2]) / s;
    vDeskew =
      (homography[1][0] * u + homography[1][1] * v + homography[1][2]) / s;
  } else if (tiltX || tiltY || roll) {
    const x = (u - cx) / fx;
    const y = (v - cy) / fy;
    const ray = [x, y, 1];
    const Rz = rotZ(-roll),
      Rx = rotX(-tiltX),
      Ry = rotY(-tiltY);
    const R = matMulFFNum(matMulFFNum(Rz, Rx), Ry);
    const r = matMulVecNum(R, ray);
    const Xp = r[0] / r[2];
    const Yp = r[1] / r[2];
    uDeskew = fx * Xp + cx;
    vDeskew = fy * Yp + cy;
  }
  return { xn: uDeskew / (width - 1), yn: vDeskew / (height - 1) };
}

// ======================================================
// =============== Edge Warp (Non-linear) ================
// ======================================================

function warpEdgeNonlinearity(x: number, y: number, cal?: CalibrationMap) {
  const { leftTh, rightTh } = computeThresholds(cal || {});
  const L = clamp01(leftTh);
  const R = clamp01(rightTh);
  if (R - L <= 1e-6) return { xw: x, yw: y };

  let t = (x - L) / (R - L);
  t = clamp01(t);
  const a0 = 0.0,
    a1 = 0.25,
    a2 = 0.75,
    a3 = 1.0;
  const k = 0.07;
  let xw: number;
  if (t < 1 / 3) {
    const u = t / (1 / 3);
    xw = a0 * (1 - u) + a1 * u;
  } else if (t < 2 / 3) {
    const u = (t - 1 / 3) / (1 / 3);
    xw = a1 * (1 - u) + a2 * u;
  } else {
    const u = (t - 2 / 3) / (1 / 3);
    xw = a2 * (1 - u) + a3 * u;
  }
  xw += (t - 0.5) * k * (1 - Math.abs(t - 0.5));
  return { xw: clamp01(xw), yw: y };
}

// ======================================================
// =============== Rotation Utilities ===================
// ======================================================

function rotX(a: number) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}
function rotY(a: number) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}
function rotZ(a: number) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

// ======================================================
// =============== Overlay & Drawing ====================
// ======================================================

function ensureOverlay() {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement("canvas");
    overlayCanvas.id = "gaze-overlay";
    Object.assign(overlayCanvas.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "999999",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
    } as CSSStyleDeclaration);
    document.body.appendChild(overlayCanvas);
    overlayCtx = overlayCanvas.getContext("2d");
  } else if (!overlayCtx) {
    overlayCtx = overlayCanvas.getContext("2d");
  }
}

function resizeOverlay() {
  if (!overlayCanvas || !overlayCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.floor(window.innerWidth);
  const cssH = Math.floor(window.innerHeight);
  const reqW = Math.floor(cssW * dpr);
  const reqH = Math.floor(cssH * dpr);
  if (overlayCanvas.width !== reqW || overlayCanvas.height !== reqH) {
    overlayCanvas.width = reqW;
    overlayCanvas.height = reqH;
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

// ------------------ Dot & Debug Text -------------------

function drawDot(xNorm: number, yNorm: number) {
  if (!debug || !overlayCtx) return;
  const ctx = overlayCtx;
  const x = xNorm * window.innerWidth;
  const y = yNorm * window.innerHeight;

  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,0,0,0.25)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,0,0,0.9)";
  ctx.fill();
}

function drawDebugText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string
) {
  if (!debug) return;
  ctx.save();
  ctx.font = "22px Arial";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ======================================================
// ============ Presence Detection (core) ===============
// ======================================================

let lastOnScreenTime = Date.now();
let faceDetected = false;
let currentPresence: GazeStatus = "offscreen";
let lastBorderDraw = 0;
let lastGazeBroadcast = 0;
const GAZE_BROADCAST_THROTTLE = 150; // ms - broadcast every 150ms

/**
 * Compute current gaze point in screen space.
 * Uses unclamped coordinates so it can go off-screen.
 */
function computeGazeDot(lm: any, cal?: CalibrationMap) {
  const feat = featuresFromLandmarks(lm);
  if (!feat) return { x: -1, y: -1 };
  const { h, v } = feat;
  const { hs, vs } = adaptiveSmooth(h, v);
  const { xNorm, yNorm } = mapToScreen(hs, vs, cal);
  const now = performance.now();
  const { xk, yk } = kalmanStepGaze(xNorm, yNorm, now, cal);
  const { xo, yo } = interpolateOut(xk, yk, now);
  return {
    x: xo * window.innerWidth,
    y: yo * window.innerHeight,
  };
}

/**
 * Updates gaze presence state:
 * - “CENTER” when dot inside screen + margin
 * - “offscreen” if dot outside > 3 s or no face
 */
export function updateGazePresence(
  lm: any | null,
  cal: CalibrationMap | undefined,
  callback: (status: GazeStatus) => void
) {
  const now = Date.now();
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;
  const margin = 0.10; // 10 % relaxed boundary

  // ---- No face ----
  if (!lm) {
    if (faceDetected) {
      faceDetected = false;
      lastOnScreenTime = now;
    }
    if (now - lastOnScreenTime > 3000) {
      if (currentPresence !== "offscreen") {
        currentPresence = "offscreen";
        drawPresenceBorder("offscreen");
      }
      // Continuous broadcast with throttling
      if (now - lastGazeBroadcast >= GAZE_BROADCAST_THROTTLE) {
        callback("offscreen");
        lastGazeBroadcast = now;
      }
    }
    return;
  }

  faceDetected = true;

  const { x, y } = computeGazeDot(lm, cal);
  const inside =
    x >= -screenW * margin &&
    x <= screenW * (1 + margin) &&
    y >= -screenH * margin &&
    y <= screenH * (1 + margin);

    if (inside) {
      lastOnScreenTime = now;
      const feat = lm && featuresFromLandmarks(lm);
      let status: GazeStatus = "CENTER";
    
      if (feat && cal?.["top-center"]) {
        const topCal = cal["top-center"].vert;
        const margin = 0.02;
        const pupilDistUp = feat.upRatio > 0.6;
        if (feat.v < topCal - margin && pupilDistUp) {
          status = "UP";
        }
      }
    
      if (currentPresence !== status) {
        currentPresence = status;
        drawPresenceBorder("CENTER");
      }
      
      // Continuous broadcast with throttling
      if (now - lastGazeBroadcast >= GAZE_BROADCAST_THROTTLE) {
        callback(status);
        lastGazeBroadcast = now;
      }
    } else if (now - lastOnScreenTime > 3000) {
    if (currentPresence !== "offscreen") {
      currentPresence = "offscreen";
      drawPresenceBorder("offscreen");
    }
    // Continuous broadcast with throttling
    if (now - lastGazeBroadcast >= GAZE_BROADCAST_THROTTLE) {
      callback("offscreen");
      lastGazeBroadcast = now;
    }
  }
}

/**
 * Draws persistent border for presence state.
 */
function drawPresenceBorder(status: GazeStatus) {
  if (!overlayCtx || !overlayCanvas) return;
  const now = performance.now();
  if (now - lastBorderDraw < 200) return;
  lastBorderDraw = now;

  const ctx = overlayCtx;
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.save();
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  ctx.lineWidth = 10;
  ctx.strokeStyle =
    status === "offscreen"
      ? "rgba(255,0,0,0.6)"
      : "rgba(0,255,0,0.6)";
  ctx.strokeRect(5, 5, w - 10, h - 10);

  ctx.font = "20px Arial";
  ctx.fillStyle = status === "offscreen" ? "red" : "lime";
  ctx.fillText(status === "offscreen" ? "OFFSCREEN" : "ONSCREEN", 20, 40);
  ctx.restore();
}

// ======================================================
// ============ Start / Stop Tracking ===================
// ======================================================

export async function startGazeTracking(
  videoEl: HTMLVideoElement,
  socket: WebSocket,
  userName: string,
  callback?: (status: GazeStatus) => void,
  calibrationThresholds?: CalibrationMap,
  debugMode: boolean = true // 👈 optional override
) {
  if (running) return;
  running = true;
  debug = debugMode;

  faceMesh = new FaceMesh({
    locateFile: (file: string) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  await faceMesh.initialize();

  ensureOverlay();
  resizeOverlay();
  window.addEventListener("resize", resizeOverlay);

  faceMesh.onResults((results: any) => {
    if (!overlayCtx || !overlayCanvas) return;
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (cameraModel.fx === 1) setCameraFromVideo(videoEl);

    if (!results.multiFaceLandmarks?.length) {
      updateGazePresence(null, calibrationThresholds, callback || (() => {}));
      return;
    }

    const lm = results.multiFaceLandmarks[0];
    (window as any).lastFaceLandmarks = lm;
    updateGazePresence(lm, calibrationThresholds, callback || (() => {}));
  });

  // Continuous tracking loop (~60 FPS internal)
  const loop = async () => {
    if (!running) return;
    if (videoEl.readyState >= 2 && faceMesh) {
      try {
        await faceMesh.send({ image: videoEl });
      } catch (e) {
        console.warn("FaceMesh error", e);
      }
    }
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

export function stopGazeTracking() {
  if (!running) return;
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  faceMesh?.close();
  faceMesh = null;
  window.removeEventListener("resize", resizeOverlay);

  gazeHistory.length = 0;
  model = null;
  samples.length = 0;
  emaH = emaV = lastH = lastV = 0.5;
  avgSpeed = 8;
  stableGaze = "CENTER";
  lastDiscreteStatus = "CENTER";
  calScaleH = calScaleV = 1;
  deviceRatio = 1;
  lastOut = lastTarget = null;

  kalmanX = [0.5, 0.5, 0, 0];
  kalmanP = eye(4, 1e-2);
  lastKalmanT = 0;
  lastGazeBroadcast = 0;
}

// ======================================================
// =============== Calibration (9-point) ================
// ======================================================

export async function startCalibration(): Promise<CalibrationMap> {
  emaH = emaV = lastH = lastV = 0.5;
  avgSpeed = 8;
  lastOut = lastTarget = null;

  const prevDisplay = overlayCanvas?.style.display;
  if (overlayCanvas) overlayCanvas.style.display = "none";

  const calCanvas = document.createElement("canvas");
  Object.assign(calCanvas.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(0,0,0,0.75)",
    zIndex: "999999",
    cursor: "none",
  } as CSSStyleDeclaration);
  document.body.appendChild(calCanvas);

  const dpr = window.devicePixelRatio || 1;
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  calCanvas.width = cssW * dpr;
  calCanvas.height = cssH * dpr;
  const cctx = calCanvas.getContext("2d")!;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  try {
    const fn =
      (calCanvas.requestFullscreen ||
        (calCanvas as any).webkitRequestFullscreen ||
        (calCanvas as any).mozRequestFullScreen ||
        (calCanvas as any).msRequestFullscreen) ??
      null;
    if (typeof fn === "function") await fn.call(calCanvas);
  } catch {
    /* ignore fullscreen errors */
  }

  const positions = [
    { name: "top-left", x: 0.2, y: 0.2 },
    { name: "top-center", x: 0.5, y: 0.2 },
    { name: "top-right", x: 0.8, y: 0.2 },
    { name: "mid-left", x: 0.2, y: 0.5 },
    { name: "center", x: 0.5, y: 0.5 },
    { name: "mid-right", x: 0.8, y: 0.5 },
    { name: "bottom-left", x: 0.2, y: 0.8 },
    { name: "bottom-center", x: 0.5, y: 0.8 },
    { name: "bottom-right", x: 0.8, y: 0.8 },
  ] as const;

  const samplesByPoint: Record<string, { h: number[]; v: number[] }> = {};
  positions.forEach((p) => (samplesByPoint[p.name] = { h: [], v: [] }));

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const start = performance.now();
    while (performance.now() - start < 2500) {
      cctx.clearRect(0, 0, cssW, cssH);
      cctx.beginPath();
      cctx.arc(p.x * cssW, p.y * cssH, Math.max(10, cssH * 0.015), 0, Math.PI * 2);
      cctx.fillStyle = "rgba(255,0,0,0.95)";
      cctx.fill();
      cctx.fillStyle = "#fff";
      cctx.font = "20px Arial";
      cctx.fillText(`Point ${i + 1}/9`, 24, 42);

      const lm = (window as any).lastFaceLandmarks;
      const feat = lm && featuresFromLandmarks(lm);
      if (feat) {
        samplesByPoint[p.name].h.push(feat.h);
        samplesByPoint[p.name].v.push(feat.v);
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  const cal: CalibrationMap = {};
  for (const k of Object.keys(samplesByPoint)) {
    const H = samplesByPoint[k].h.sort((a, b) => a - b);
    const V = samplesByPoint[k].v.sort((a, b) => a - b);
    const hm = H.length ? H[Math.floor(H.length / 2)] : 0.5;
    const vm = V.length ? V[Math.floor(V.length / 2)] : 0.5;
    cal[k] = { horiz: hm, vert: vm };
  }

  try {
    if (document.fullscreenElement) await (document as any).exitFullscreen();
  } catch {}
  calCanvas.remove();
  if (overlayCanvas) overlayCanvas.style.display = prevDisplay || "";

  lastOut = lastTarget = null;
  return cal;
}

// ======================================================
// ============== Utility Math Helpers ==================
// ======================================================

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}
function eye(n: number, scale = 1): number[][] {
  const M = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) M[i][i] = scale;
  return M;
}
function matAddNum(A: number[][], B: number[][]): number[][] {
  return A.map((r, i) => r.map((v, j) => v + B[i][j]));
}
function matSubNum(A: number[][], B: number[][]): number[][] {
  return A.map((r, i) => r.map((v, j) => v - B[i][j]));
}
function matMulFFNum(A: number[][], B: number[][], transB = false): number[][] {
  const aR = A.length,
    aC = A[0].length;
  const bR = transB ? B[0].length : B.length;
  const bC = transB ? B.length : B[0].length;
  const out = Array.from({ length: aR }, () => Array(bC).fill(0));
  for (let i = 0; i < aR; i++) {
    for (let k = 0; k < aC; k++) {
      const aik = A[i][k];
      for (let j = 0; j < bC; j++) {
        out[i][j] += aik * (transB ? B[j][k] : B[k][j]);
      }
    }
  }
  return out;
}
function matMulVecNum(A: number[][], x: number[]): number[] {
  return A.map((r) => r.reduce((sum, v, j) => sum + v * x[j], 0));
}
function matAddVec(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i]);
}
function transpose(A: number[][]): number[][] {
  const r = A.length,
    c = A[0].length;
  const T = Array.from({ length: c }, () => Array(r).fill(0));
  for (let i = 0; i < r; i++)
    for (let j = 0; j < c; j++) T[j][i] = A[i][j];
  return T;
}
function inv2(S: number[][]): number[][] {
  const a = S[0][0],
    b = S[0][1],
    c = S[1][0],
    d = S[1][1];
  const det = a * d - b * c || 1e-9;
  return [
    [d / det, -b / det],
    [-c / det, a / det],
  ];
}

// ======================================================
// ===================== Exports ========================
// ======================================================

export default {
  startGazeTracking,
  stopGazeTracking,
  startCalibration,
  updateGazePresence,
};


// ======================================================
// =============== Feature & Threshold Utils =============
// ======================================================

function featuresFromLandmarks(lm: any) {
  if (!lm || lm.length < 478) return null;

  const irisL = lm[468];
  const irisR = lm[473];
  const iris = {
    x: (irisL.x + irisR.x) / 2,
    y: (irisL.y + irisR.y) / 2,
  };

  const leftCorner = lm[33];
  const rightCorner = lm[263];
  const topLid = lm[159];
  const bottomLid = lm[145];

  const h = (iris.x - leftCorner.x) / (rightCorner.x - leftCorner.x);
  const v = (iris.y - topLid.y) / (bottomLid.y - topLid.y);

  // 👇 Simple “looking up” indicator
  const pupilBottomDist = bottomLid.y - iris.y;  // increases when looking up
  const baseline = bottomLid.y - topLid.y;       // total eye height
  const upRatio = pupilBottomDist / baseline;

  return { h: clamp01(h), v: clamp01(v), upRatio };
}




function computeThresholds(cal: CalibrationMap) {
  const leftTh =
    cal["top-left"]?.horiz ??
    cal["mid-left"]?.horiz ??
    cal["bottom-left"]?.horiz ??
    0.45;
  const rightTh =
    cal["top-right"]?.horiz ??
    cal["mid-right"]?.horiz ??
    cal["bottom-right"]?.horiz ??
    0.55;
  return { leftTh, rightTh };
}

// ======================================================
// =============== Adaptive Smoothing ===================
// ======================================================

function adaptiveSmooth(h: number, v: number) {
  const dh = Math.abs(h - lastH);
  const dv = Math.abs(v - lastV);
  const speed = Math.sqrt(dh * dh + dv * dv) * 1000;
  avgSpeed = 0.8 * avgSpeed + 0.2 * speed;

  const alpha = clamp01(
    MIN_ALPHA +
      (MAX_ALPHA - MIN_ALPHA) *
        Math.exp(-avgSpeed / 20)
  );

  emaH = emaH * (1 - alpha) + h * alpha;
  emaV = emaV * (1 - alpha) + v * alpha;
  lastH = h;
  lastV = v;

  return { hs: emaH, vs: emaV };
}

// ======================================================
// =============== Mapping & Interpolation ===============
// ======================================================

function mapToScreen(h: number, v: number, cal?: CalibrationMap) {
  // For simplicity, linear map with calibration bias
  const baseX =
    (h -
      (cal?.["mid-left"]?.horiz ?? 0.45)) /
    ((cal?.["mid-right"]?.horiz ?? 0.55) -
      (cal?.["mid-left"]?.horiz ?? 0.45));
  const baseY =
    (v -
      (cal?.["top-center"]?.vert ?? 0.35)) /
    ((cal?.["bottom-center"]?.vert ?? 0.45) -
      (cal?.["top-center"]?.vert ?? 0.35));

  // const xNorm = clamp01(baseX);
  // const yNorm = clamp01(baseY);
  // Allow off-screen range ±50%
  const xNorm = Math.max(-0.5, Math.min(1.5, baseX));
  const yNorm = Math.max(-0.5, Math.min(1.5, baseY));
  return { xNorm, yNorm };
}

function interpolateOut(x: number, y: number, now: number) {
  const target = { x, y, t: now };
  if (!lastOut) {
    lastOut = target;
    lastTarget = target;
    return { xo: x, yo: y };
  }

  const dt = (now - lastOut.t) / 1000;
  const rate = clamp(dt * 5, 0, 1);
  const xo = lastOut.x + (target.x - lastOut.x) * rate;
  const yo = lastOut.y + (target.y - lastOut.y) * rate;

  lastOut = { x: xo, y: yo, t: now };
  lastTarget = target;
  return { xo, yo };
}
