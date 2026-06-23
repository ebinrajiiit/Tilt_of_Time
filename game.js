// ====================================================================
//  TILT OF TIME — a neck-mobility game for the culture x humanities x
//  technology conference stall.
//
//  Tilt your head left/right (lateral neck flexion) to glide a glowing
//  lantern and catch falling icons of human culture. Built on Google
//  MediaPipe FaceLandmarker — runs fully in the browser, no install.
// ====================================================================

// Library is vendored locally (see vendor/) so the game runs fully offline —
// no dependence on conference Wi-Fi or firewalls.
import {
  FaceLandmarker,
  FilesetResolver,
} from "./vendor/vision_bundle.mjs";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $("game");
const ctx = canvas.getContext("2d");
const video = $("cam");
const pCanvas = $("previewCanvas");
const pCtx = pCanvas.getContext("2d");

const screens = {
  loading: $("loading"),
  start: $("startScreen"),
  calib: $("calibScreen"),
  over: $("overScreen"),
  error: $("errorScreen"),
};

// ---------- Config ----------
const ROUND_SECONDS = 60;
const FULL_TILT_DEG = 20;        // head roll that pushes lantern to the edge
const SMOOTH = 0.28;             // tilt smoothing (higher = snappier)

// Cultural / humanities / tech icons to collect, each with a name shown on catch.
const GOOD = [
  { e: "🪔", n: "Diya · light" },
  { e: "🎭", n: "Theatre · drama" },
  { e: "📜", n: "Manuscript" },
  { e: "🎶", n: "Music" },
  { e: "🪕", n: "Strings" },
  { e: "🏛️", n: "Heritage" },
  { e: "🧮", n: "Mathematics" },
  { e: "🔭", n: "Science" },
  { e: "🎨", n: "Art" },
  { e: "🪷", n: "Lotus" },
  { e: "🧵", n: "Craft" },
  { e: "💡", n: "Idea" },
  { e: "⚛️", n: "Physics" },
  { e: "🌏", n: "World" },
  { e: "📿", n: "Tradition" },
];
const RARE = { e: "✨", n: "Spark of genius!", value: 5 };
const BAD = ["🌀", "💀", "🕳️"]; // glitch-voids

// ---------- State ----------
let landmarker = null;
let running = false;
let lastVideoTime = -1;

let rollDeg = 0;       // raw head roll (degrees)
let rollSmooth = 0;    // smoothed
let faceVisible = false;

const game = {
  player: { x: 0.5, y: 0.82, glow: 0 },
  items: [],
  particles: [],
  stars: [],
  score: 0,
  combo: 1,
  comboTimer: 0,
  bestCombo: 1,
  timeLeft: ROUND_SECONDS,
  spawnTimer: 0,
  elapsed: 0,
  fullTilts: 0,
  tiltSide: 0,        // -1 left, 1 right, 0 center (for counting full tilts)
  maxRange: 0,
};

let best = Number(localStorage.getItem("tot_best") || 0);
let soundOn = true;
let audioCtx = null;

// ====================================================================
//  Audio (tiny synth — no files needed)
// ====================================================================
function blip(freq, dur = 0.08, type = "sine", gain = 0.15) {
  if (!soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g); g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur);
  } catch (e) { /* ignore */ }
}
const sndCatch = (c) => blip(420 + Math.min(c, 12) * 60, 0.09, "triangle", 0.18);
const sndRare = () => { blip(880, 0.12, "sine", 0.2); setTimeout(() => blip(1320, 0.14, "sine", 0.2), 90); };
const sndBad = () => blip(120, 0.18, "sawtooth", 0.18);

// ====================================================================
//  Setup
// ====================================================================
async function init() {
  if (window.__totWatchdog) clearTimeout(window.__totWatchdog); // module loaded OK
  resize();
  window.addEventListener("resize", resize);
  seedStars();

  $("startBtn").addEventListener("click", () => startCalibration());
  $("againBtn").addEventListener("click", () => startCalibration());
  $("retryBtn").addEventListener("click", () => location.reload());
  $("soundBtn").addEventListener("click", toggleSound);

  showBest();

  try {
    setLoading("Awakening the camera spirits…");
    await setupCamera();
    setLoading("Summoning the vision model…");
    await setupLandmarker();
    show("start");
    renderLoop(); // start the draw/track loop (idle until round runs)
  } catch (err) {
    console.error(err);
    $("errorText").textContent = err && err.message ? err.message : String(err);
    show("error");
  }
}

function setLoading(t) { $("loadingText").textContent = t; }

async function setupCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera API unavailable. Open the game via http://localhost (not file://) in Chrome or Edge.");
  }
  let stream;
  try {
    const ask = navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), 12000)
    );
    stream = await Promise.race([ask, timeout]);
  } catch (e) {
    if (e && e.name === "TimeoutError") {
      throw new Error("The camera did not respond (it's likely stuck or held by another app). Fix: quit all other camera apps & browser tabs, then either reload — or unplug/replug the webcam, or restart the browser. On a Mac laptop camera, fully quitting and reopening the browser usually frees it.");
    }
    // Translate the cryptic DOMException names into stall-friendly guidance.
    const name = e && e.name ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error("Camera permission was blocked. Click the camera icon in the address bar → Allow, then reload. (Also check macOS: System Settings → Privacy & Security → Camera → your browser.)");
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      throw new Error("The camera is busy — another app is using it. Close Zoom / Teams / Photo Booth / other browser tabs that use the camera, then reload.");
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
      throw new Error("No camera was found. Make sure a webcam is connected and enabled, then reload.");
    }
    throw new Error((name ? name + ": " : "") + (e.message || "Could not start the camera.") + " — close other camera apps and reload.");
  }
  video.srcObject = stream;
  await new Promise((res) => {
    if (video.readyState >= 2) { video.play(); return res(); }
    video.onloadedmetadata = () => { video.play(); res(); };
  });
  pCanvas.width = 168; pCanvas.height = 126;
}

async function setupLandmarker() {
  const filesetResolver = await FilesetResolver.forVisionTasks("./vendor/wasm");
  const opts = (delegate) => ({
    baseOptions: {
      modelAssetPath: "./vendor/face_landmarker.task",
      delegate,
    },
    runningMode: "VIDEO",
    numFaces: 1,
  });
  try {
    landmarker = await FaceLandmarker.createFromOptions(filesetResolver, opts("GPU"));
  } catch (e) {
    // Some machines/GPUs reject the GPU delegate — fall back to CPU so it still runs.
    console.warn("GPU delegate failed, retrying on CPU:", e);
    landmarker = await FaceLandmarker.createFromOptions(filesetResolver, opts("CPU"));
  }
}

// ====================================================================
//  Head-tilt detection
// ====================================================================
function track() {
  if (!landmarker || video.readyState < 2) return;
  const now = performance.now();
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, now);
  if (res && res.faceLandmarks && res.faceLandmarks.length) {
    const lm = res.faceLandmarks[0];
    // Outer eye corners: 33 (right eye), 263 (left eye). Roll = tilt of that line.
    const a = lm[33], b = lm[263];
    // video is mirrored on display; raw landmark x grows left->right in the
    // camera frame, so invert dy sign to match the user's natural tilt.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let deg = Math.atan2(dy, dx) * (180 / Math.PI);
    // When sitting upright the eye-line is ~horizontal (deg ~ 0).
    rollDeg = deg;
    faceVisible = true;
    drawPreview(lm);
  } else {
    faceVisible = false;
    drawPreview(null);
  }
}

function drawPreview(lm) {
  pCtx.save();
  pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
  pCtx.drawImage(video, 0, 0, pCanvas.width, pCanvas.height);
  if (lm) {
    pCtx.fillStyle = "rgba(70,230,255,0.9)";
    for (const pt of lm) {
      pCtx.beginPath();
      pCtx.arc(pt.x * pCanvas.width, pt.y * pCanvas.height, 0.7, 0, 7);
      pCtx.fill();
    }
    // eye-line
    const a = lm[33], b = lm[263];
    pCtx.strokeStyle = "rgba(255,210,122,0.95)";
    pCtx.lineWidth = 2;
    pCtx.beginPath();
    pCtx.moveTo(a.x * pCanvas.width, a.y * pCanvas.height);
    pCtx.lineTo(b.x * pCanvas.width, b.y * pCanvas.height);
    pCtx.stroke();
  }
  pCtx.restore();
}

// ====================================================================
//  Calibration — quick + friendly
// ====================================================================
let calibCenter = 0;
async function startCalibration() {
  show("calib");
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();

  const setStep = (icon, text) => { $("calibIcon").textContent = icon; $("calibStep").textContent = text; };
  const fill = (p) => { $("calibFill").style.width = p + "%"; };

  // Phase 1: capture neutral center
  setStep("🧘", "Sit tall, look straight ahead, breathe…");
  let samples = [];
  await collectFor(1600, () => { if (faceVisible) samples.push(rollDeg); }, fill, 0, 50);
  calibCenter = samples.length ? median(samples) : 0;

  // Phase 2: playful range check
  setStep("🙆", "Now gently tilt one ear toward your shoulder…");
  await collectFor(1400, () => {}, fill, 50, 100);

  setStep("🌟", "Beautiful. Let's play!");
  await wait(600);
  startRound();
}

function collectFor(ms, onTick, fill, from, to) {
  return new Promise((res) => {
    const start = performance.now();
    const id = setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / ms);
      onTick();
      fill(from + (to - from) * p);
      if (p >= 1) { clearInterval(id); res(); }
    }, 40);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

// ====================================================================
//  Round lifecycle
// ====================================================================
function startRound() {
  Object.assign(game, {
    items: [], particles: [],
    score: 0, combo: 1, comboTimer: 0, bestCombo: 1,
    timeLeft: ROUND_SECONDS, spawnTimer: 0, elapsed: 0,
    fullTilts: 0, tiltSide: 0, maxRange: 0,
  });
  game.player.x = 0.5;
  hideAll();
  $("hud").classList.remove("hidden");
  running = true;
  roundClock();
}

function roundClock() {
  if (!running) return;
  game.timeLeft -= 1;
  $("time").textContent = Math.max(0, game.timeLeft);
  $("time").parentElement.classList.toggle("urgent", game.timeLeft <= 10);
  if (game.timeLeft <= 0) { endRound(); return; }
  setTimeout(roundClock, 1000);
}

function endRound() {
  running = false;
  $("hud").classList.add("hidden");
  if (game.score > best) { best = game.score; localStorage.setItem("tot_best", best); }

  $("finalScore").textContent = game.score;
  $("statRange").textContent = Math.round(game.maxRange) + "°";
  $("statBest").textContent = "x" + game.bestCombo;
  $("statTilts").textContent = game.fullTilts;
  $("overMessage").textContent = endMessage();
  show("over");
  burst(0.5, 0.4, 60, "255,210,122");
}

function endMessage() {
  const s = game.score;
  let base;
  if (s >= 80) base = "Maestro of motion — culture flows through your spine! 🌟";
  else if (s >= 50) base = "Wonderful range and rhythm. Your neck is dancing. 🎶";
  else if (s >= 25) base = "Lovely work — limber and curious. 🪔";
  else base = "A gentle start. Every tilt counts toward a happier neck. 🌱";
  if (game.score >= best && best > 0) base += "  New stall high score!";
  return base;
}

// ====================================================================
//  Game logic
// ====================================================================
function update(dt) {
  // --- smoothed tilt -> player position ---
  const rel = rollDeg - calibCenter;
  rollSmooth += (rel - rollSmooth) * SMOOTH;
  const norm = clamp(rollSmooth / FULL_TILT_DEG, -1, 1); // -1..1
  game.player.x = 0.5 + norm * 0.46;

  // tilt meter needle
  $("tiltNeedle").style.left = (50 + norm * 48) + "%";

  // track range + count full tilts (exercise gamification)
  const absDeg = Math.abs(rel);
  if (absDeg > game.maxRange) game.maxRange = Math.min(absDeg, 45);
  const side = norm > 0.7 ? 1 : norm < -0.7 ? -1 : 0;
  if (side !== 0 && side !== game.tiltSide) {
    if (game.tiltSide === 0 || side !== game.tiltSide) game.fullTilts++;
    game.tiltSide = side;
  } else if (side === 0) {
    game.tiltSide = 0;
  }

  // --- spawning, ramps up over the round ---
  game.elapsed += dt;
  const difficulty = 1 + game.elapsed / 30; // gets ~2x by end
  game.spawnTimer -= dt;
  if (game.spawnTimer <= 0) {
    spawnItem(difficulty);
    game.spawnTimer = Math.max(0.42, 0.95 / difficulty);
  }

  // --- combo decay ---
  if (game.comboTimer > 0) { game.comboTimer -= dt; if (game.comboTimer <= 0) game.combo = 1; }
  updateHUD();

  // --- items ---
  const px = game.player.x, py = game.player.y;
  for (const it of game.items) {
    it.y += it.vy * dt;
    it.x += Math.sin((game.elapsed + it.seed) * it.sway) * 0.0006;
    it.rot += it.spin * dt;
    // collision (normalized space, aspect-corrected roughly)
    const dxp = (it.x - px) * canvas.width;
    const dyp = (it.y - py) * canvas.height;
    if (Math.hypot(dxp, dyp) < it.r * canvas.height + 36) {
      collect(it);
      it.dead = true;
    } else if (it.y > 1.1) {
      if (it.kind === "good") loseCombo();
      it.dead = true;
    }
  }
  game.items = game.items.filter((i) => !i.dead);

  // --- particles ---
  for (const p of game.particles) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.9 * dt; p.life -= dt;
  }
  game.particles = game.particles.filter((p) => p.life > 0);

  // player glow fade
  if (game.player.glow > 0) game.player.glow -= dt * 3;

  // stars drift
  for (const st of game.stars) { st.y += st.v * dt; if (st.y > 1) { st.y = 0; st.x = Math.random(); } }
}

function spawnItem(difficulty) {
  const badChance = Math.min(0.28, 0.1 + game.elapsed / 240);
  const isBad = Math.random() < badChance;
  const x = 0.08 + Math.random() * 0.84;
  if (isBad) {
    game.items.push(mkItem(x, BAD[(Math.random() * BAD.length) | 0], "bad", difficulty));
  } else if (Math.random() < 0.06) {
    game.items.push(mkItem(x, RARE.e, "rare", difficulty));
  } else {
    const g = GOOD[(Math.random() * GOOD.length) | 0];
    const it = mkItem(x, g.e, "good", difficulty);
    it.name = g.n;
    game.items.push(it);
  }
}

function mkItem(x, e, kind, difficulty) {
  return {
    x, y: -0.05, e, kind,
    vy: (0.16 + Math.random() * 0.06) * difficulty,
    r: 0.04, rot: 0, spin: (Math.random() - 0.5) * 2,
    seed: Math.random() * 10, sway: 1 + Math.random() * 2,
    dead: false, name: "",
  };
}

function collect(it) {
  game.player.glow = 1;
  if (it.kind === "bad") {
    sndBad();
    game.score = Math.max(0, game.score - 3);
    game.combo = 1; game.comboTimer = 0;
    burst(it.x, it.y, 22, "255,77,157");
    shake(10);
    flashToast("✦ scrambled! ✦");
  } else {
    const val = it.kind === "rare" ? RARE.value : 1;
    game.combo = Math.min(99, game.combo + 1);
    game.bestCombo = Math.max(game.bestCombo, game.combo);
    game.comboTimer = 2.2;
    const gained = val * Math.max(1, Math.floor(game.combo / 3) + 1);
    game.score += gained;
    if (it.kind === "rare") { sndRare(); burst(it.x, it.y, 40, "255,233,184"); flashToast(RARE.n); }
    else { sndCatch(game.combo); burst(it.x, it.y, 16, "70,230,255"); if (it.name) flashToast(it.name); }
    popHud("score");
  }
}

function loseCombo() {
  if (game.combo > 1) { game.combo = 1; game.comboTimer = 0; }
}

// ====================================================================
//  Effects
// ====================================================================
function burst(x, y, n, rgb) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 0.05 + Math.random() * 0.25;
    game.particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.05,
      life: 0.5 + Math.random() * 0.5, max: 1, rgb,
      size: 2 + Math.random() * 4,
    });
  }
}
let shakeAmt = 0;
function shake(v) { shakeAmt = v; }

function flashToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
}
function popHud(id) { const el = $(id); el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }

function updateHUD() {
  $("score").textContent = game.score;
  $("combo").textContent = "x" + game.combo;
}

// ====================================================================
//  Rendering
// ====================================================================
function render() {
  const W = canvas.width, H = canvas.height;
  ctx.save();
  if (shakeAmt > 0) {
    ctx.translate((Math.random() - 0.5) * shakeAmt, (Math.random() - 0.5) * shakeAmt);
    shakeAmt *= 0.85; if (shakeAmt < 0.3) shakeAmt = 0;
  }

  // background gradient + vignette
  const g = ctx.createRadialGradient(W / 2, H * 0.35, 50, W / 2, H * 0.5, H);
  g.addColorStop(0, "#1a0f3a");
  g.addColorStop(1, "#070512");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // stars
  for (const st of game.stars) {
    ctx.globalAlpha = st.a;
    ctx.fillStyle = "#bcd2ff";
    ctx.fillRect(st.x * W, st.y * H, st.s, st.s);
  }
  ctx.globalAlpha = 1;

  // mandala-ish rotating background glyph (subtle culture motif)
  drawMandala(W / 2, H * 0.42, Math.min(W, H) * 0.42, game.elapsed * 0.05);

  if (running) {
    // items
    for (const it of game.items) drawItem(it, W, H);
    // particles
    for (const p of game.particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = `rgb(${p.rgb})`;
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, p.size, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // player lantern
    drawPlayer(W, H);
  }

  ctx.restore();

  // "no face" hint
  if (running && !faceVisible) {
    ctx.fillStyle = "rgba(255,77,157,0.95)";
    ctx.font = "600 22px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Show your face to the camera ☺", W / 2, H * 0.5);
  }
}

function drawItem(it, W, H) {
  const x = it.x * W, y = it.y * H;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(it.rot * 0.15);
  const glowColor = it.kind === "bad" ? "rgba(255,77,157,0.6)"
    : it.kind === "rare" ? "rgba(255,233,184,0.9)" : "rgba(70,230,255,0.5)";
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = it.kind === "rare" ? 30 : 18;
  ctx.font = `${Math.round(it.r * H * 1.6)}px serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(it.e, 0, 0);
  ctx.restore();
}

function drawPlayer(W, H) {
  const x = game.player.x * W, y = game.player.y * H;
  const glow = 18 + game.player.glow * 40;
  ctx.save();
  // light pool beneath
  const lg = ctx.createRadialGradient(x, y, 4, x, y, 90);
  lg.addColorStop(0, "rgba(255,210,122,0.5)");
  lg.addColorStop(1, "rgba(255,210,122,0)");
  ctx.fillStyle = lg;
  ctx.fillRect(x - 90, y - 90, 180, 180);
  // tilt the lantern with your head for a lovely connected feel
  ctx.translate(x, y);
  ctx.rotate(clamp(rollSmooth / FULL_TILT_DEG, -1, 1) * 0.4);
  ctx.shadowColor = "rgba(255,210,122,0.95)";
  ctx.shadowBlur = glow;
  ctx.font = "64px serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("🏮", 0, 0);
  ctx.restore();
}

function drawMandala(cx, cy, r, rot) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = "#ffd27a";
  ctx.lineWidth = 1.2;
  const petals = 12;
  for (let i = 0; i < petals; i++) {
    ctx.rotate((Math.PI * 2) / petals);
    ctx.beginPath();
    ctx.ellipse(r * 0.5, 0, r * 0.5, r * 0.16, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// ====================================================================
//  Main loop
// ====================================================================
let lastT = performance.now();
function renderLoop() {
  const now = performance.now();
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.05) dt = 0.05; // clamp big gaps

  track();
  if (running) update(dt);
  render();
  requestAnimationFrame(renderLoop);
}

// ====================================================================
//  Helpers / UI
// ====================================================================
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
}

function seedStars() {
  game.stars = [];
  for (let i = 0; i < 120; i++) {
    game.stars.push({
      x: Math.random(), y: Math.random(),
      s: Math.random() < 0.85 ? 1 : 2,
      a: 0.2 + Math.random() * 0.6,
      v: 0.005 + Math.random() * 0.02,
    });
  }
}

function show(name) { hideAll(); screens[name].classList.remove("hidden"); }
function hideAll() { Object.values(screens).forEach((s) => s.classList.add("hidden")); }

function showBest() {
  $("bestLine").textContent = best > 0 ? `Stall high score: ${best} threads` : "";
}

function toggleSound() {
  soundOn = !soundOn;
  $("soundBtn").textContent = soundOn ? "🔊" : "🔈";
  if (soundOn && audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}

// keyboard: F = fullscreen (handy at the stall)
window.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
});

init();
