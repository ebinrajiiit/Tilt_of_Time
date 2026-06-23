// ====================================================================
//  TILT OF TIME — browser edition (feature-parity with the desktop app)
//
//  Tilt your head left/right to glide a glowing lantern and catch the
//  falling icons of human culture. Solo or 2-player split-screen duel
//  (best-of-3). Built for a culture x humanities x technology stall.
//  A FACTS-H Lab installation.
//
//  Runs fully in the browser via Google MediaPipe FaceLandmarker.
//  Everything (assets, model, wasm) is vendored for offline use.
// ====================================================================

import { FaceLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";

// ---------------- Config ----------------
const W = 1280, H = 720;
const ROUND_SECONDS = 60;
const FULL_TILT_DEG = 20;
const SMOOTH = 0.30;
const TILT_SIGN = -1;         // -1 = mirror-natural steering (tilt right -> lantern right)
const WINS_NEEDED = 2;        // duel is best-of-3

const GOOD = [
  ["🪔", "Diya"], ["🎭", "Theatre"], ["📜", "Manuscript"], ["🎶", "Music"],
  ["🪕", "Strings"], ["🏛️", "Heritage"], ["🧮", "Maths"], ["🔭", "Science"],
  ["🎨", "Art"], ["🪷", "Lotus"], ["🧵", "Craft"], ["💡", "Idea"],
  ["⚛️", "Physics"], ["🌏", "World"], ["📿", "Tradition"],
];
const RARE = ["✨", "Spark!"];
const BAD = ["🌀", "💀", "🕳️"];
const LANTERN = "🏮";

const GOLD = "#ffd27a", GOLD_BRIGHT = "#ffe9b8", CYAN = "#46e6ff",
      ORANGE = "#ff9f46", MAGENTA = "#ff4d9d", INK = "#f4ecff", DIM = "#bcbcc8";
const PALETTES = [
  { accent: CYAN, good: CYAN, lantern: GOLD, name: "PLAYER 1" },
  { accent: ORANGE, good: ORANGE, lantern: ORANGE, name: "PLAYER 2" },
];
const CATCH_SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.7, 1318.5];

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const canvas = $("game"), ctx = canvas.getContext("2d");
const video = $("cam");

// ---------------- Utils ----------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const rand = (a, b) => a + Math.random() * (b - a);
const choice = (arr) => arr[(Math.random() * arr.length) | 0];

function text(str, x, y, size, color, { align = "center", weight = 800, glow = true, blur = 16 } = {}) {
  ctx.font = `${weight} ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = "middle";
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
  ctx.shadowBlur = 0;
}
function emoji(e, x, y, size, glow, blur) {
  ctx.font = `${size}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = blur; }
  ctx.fillText(e, x, y); ctx.shadowBlur = 0;
}

// ---------------- Audio (Web Audio API) ----------------
class Sound {
  constructor() { this.ctx = null; this.master = null; this.muted = false; this.ambOn = false; this.ambNodes = []; }
  _ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.9; this.master.connect(this.ctx.destination);
  }
  resume() { this._ensure(); if (this.ctx.state === "suspended") this.ctx.resume(); }
  _tone(freq, dur, { type = "sine", gain = 0.16, when = 0, slideTo = null } = {}) {
    if (this.muted) return;
    this._ensure();
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  beep(n) { const f = { 3: 523.25, 2: 587.33, 1: 659.25 }[n]; if (f) this._tone(f, 0.16, { type: "triangle", gain: 0.18 }); }
  go() { this._tone(783.99, 0.34, { type: "triangle", gain: 0.2 }); this._tone(1175, 0.34, { gain: 0.12 }); }
  catchPluck(combo) { const f = CATCH_SCALE[Math.min(CATCH_SCALE.length - 1, Math.max(0, combo - 1))]; this._tone(f, 0.13, { type: "triangle", gain: 0.16 }); }
  rare() { [1046.5, 1318.5, 1568].forEach((f, i) => this._tone(f, 0.3, { gain: 0.14, when: i * 0.06 })); }
  bad() { this._tone(170, 0.22, { type: "sawtooth", gain: 0.18, slideTo: 70 }); }
  startAmbient() {
    if (this.muted || this.ambOn) return;
    this._ensure(); this.ambOn = true;
    const t = this.ctx.currentTime;
    const bus = this.ctx.createGain(); bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.10, t + 1.5); bus.connect(this.master);
    const oscs = [];
    for (const f of [110, 164.81, 220, 329.63]) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = "sine"; o.frequency.value = f; g.gain.value = f < 250 ? 0.5 : 0.18;
      o.connect(g); g.connect(bus); o.start(); oscs.push(o);
    }
    const lfo = this.ctx.createOscillator(), lg = this.ctx.createGain();
    lfo.frequency.value = 0.06; lg.gain.value = 0.035; lfo.connect(lg); lg.connect(bus.gain); lfo.start();
    this.ambNodes = [bus, lfo, ...oscs];
  }
  stopAmbient() {
    if (!this.ambOn) return; this.ambOn = false;
    const nodes = this.ambNodes; this.ambNodes = [];
    if (!this.ctx) return;
    const t = this.ctx.currentTime, bus = nodes[0];
    try { bus.gain.cancelScheduledValues(t); bus.gain.linearRampToValueAtTime(0.0001, t + 0.6); } catch (e) {}
    setTimeout(() => nodes.forEach((n) => { try { n.stop && n.stop(); } catch (e) {} }), 700);
  }
}
const snd = new Sound();

// ---------------- Logo ----------------
const logo = new Image();
let logoReady = false;
logo.onload = () => { logoReady = true; };
logo.src = "./assets/factsh_white.png";

// ---------------- Background (prerendered once) ----------------
let bgCanvas = null;
function buildBackground() {
  bgCanvas = document.createElement("canvas"); bgCanvas.width = W; bgCanvas.height = H;
  const c = bgCanvas.getContext("2d");
  const g = c.createRadialGradient(W / 2, H * 0.38, 50, W / 2, H * 0.5, H);
  g.addColorStop(0, "#1a0f3a"); g.addColorStop(1, "#070512");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // deterministic stars
  let seed = 7; const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 160; i++) {
    const x = rng() * W, y = rng() * H, b = 120 + rng() * 120, s = rng() < 0.85 ? 1 : 2;
    c.fillStyle = `rgba(${b},${b},${Math.min(255, b + 30)},1)`; c.fillRect(x, y, s, s);
  }
  // faint mandala
  c.save(); c.translate(W / 2, H * 0.42); c.globalAlpha = 0.06; c.strokeStyle = GOLD; c.lineWidth = 1.2;
  const R = Math.min(W, H) * 0.42;
  for (let i = 0; i < 12; i++) {
    c.rotate(Math.PI / 6);
    c.beginPath(); c.ellipse(R * 0.5, 0, R * 0.5, R * 0.16, 0, 0, Math.PI * 2); c.stroke();
  }
  c.beginPath(); c.arc(0, 0, R * 0.28, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.arc(0, 0, R * 0.9, 0, Math.PI * 2); c.stroke();
  c.restore();
}

// ---------------- Tracking ----------------
let landmarker = null, lastVideoTime = -1, lastDetections = [];
async function setupCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    throw new Error("Camera API unavailable. Use Chrome/Edge over HTTPS or localhost.");
  let stream;
  try {
    const ask = navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
    const to = new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), 15000));
    stream = await Promise.race([ask, to]);
  } catch (e) {
    const n = e && e.name;
    if (n === "TimeoutError") throw new Error("The camera didn't respond — close other camera apps/tabs and reload.");
    if (n === "NotAllowedError" || n === "SecurityError") throw new Error("Camera permission was blocked. Allow it in the address bar, then reload.");
    if (n === "NotReadableError") throw new Error("The camera is busy — close Zoom/Teams/other tabs, then reload.");
    if (n === "NotFoundError") throw new Error("No camera found — connect a webcam and reload.");
    throw new Error((n ? n + ": " : "") + (e.message || "Could not start the camera."));
  }
  video.srcObject = stream;
  await new Promise((res) => { if (video.readyState >= 2) { video.play(); res(); } else video.onloadedmetadata = () => { video.play(); res(); }; });
}
async function setupLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks("./vendor/wasm");
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: "./vendor/face_landmarker.task", delegate },
    runningMode: "VIDEO", numFaces: 2,
  });
  try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch (e) { console.warn("GPU delegate failed, using CPU:", e); landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU")); }
}
function detect(now) {
  if (!landmarker || video.readyState < 2) return lastDetections;
  if (video.currentTime === lastVideoTime) return lastDetections;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, now);
  const out = [];
  if (res && res.faceLandmarks) {
    for (const lm of res.faceLandmarks) {
      // mirror x (1-x) so steering & sides feel like a mirror
      const a = lm[33], b = lm[263];
      const roll = Math.atan2(b.y - a.y, (1 - b.x) - (1 - a.x)) * 180 / Math.PI;
      let sx = 0; for (const p of lm) sx += 1 - p.x;
      out.push({ roll, cx: sx / lm.length, points: lm });
    }
  }
  lastDetections = out;
  return out;
}

// ---------------- Items / particles ----------------
class Item {
  constructor(x, vy, kind, e, name) {
    this.x = x; this.y = -0.06; this.vy = vy; this.kind = kind; this.e = e; this.name = name;
    this.seed = rand(0, 10); this.sway = rand(1, 3); this.dead = false;
  }
}
class Particle {
  constructor(x, y, color) {
    const a = rand(0, Math.PI * 2), sp = rand(60, 320);
    this.x = x; this.y = y; this.vx = Math.cos(a) * sp; this.vy = Math.sin(a) * sp - 60;
    this.life = rand(0.5, 1.0); this.color = color; this.size = rand(2, 6);
  }
}

// ---------------- Player ----------------
class Player {
  constructor(idx, xlo, xhi) {
    this.idx = idx; this.xlo = xlo; this.xhi = xhi;
    this.cx = (xlo + xhi) / 2; this.half = (xhi - xlo) / 2; this.pal = PALETTES[idx];
    this.sfx = () => {};
    this.reset();
  }
  reset() {
    this.px = this.cx; this.rollS = 0; this.items = []; this.particles = [];
    this.score = 0; this.combo = 1; this.bestCombo = 1; this.comboTimer = 0;
    this.spawnTimer = rand(0, 0.4); this.glow = 0; this.toast = ""; this.toastT = 0; this.shake = 0;
    this.center = 0; this.calib = []; this.fullTilts = 0; this.tiltSide = 0; this.maxRange = 0;
    this.visible = false; this.norm = 0;
  }
  setCenter() { this.center = this.calib.length ? median(this.calib) : 0; }
  steer(roll, visible, trackRange = true) {
    this.visible = visible;
    if (visible) {
      const rel = (roll - this.center) * TILT_SIGN;
      this.rollS += (rel - this.rollS) * SMOOTH;
      if (trackRange) { const ad = Math.abs(rel); if (ad > this.maxRange) this.maxRange = Math.min(ad, 45); }
    }
    this.norm = clamp(this.rollS / FULL_TILT_DEG, -1, 1);
    this.px = this.cx + this.norm * this.half * 0.92;
  }
  idle(roll, visible) { this.steer(roll, visible, false); }
  aiSteer(dt) {
    const targets = this.items.filter((it) => it.kind !== "bad" && it.y < 0.8);
    let desired = this.cx;
    if (targets.length) desired = targets.reduce((a, b) => (0.82 - a.y < 0.82 - b.y ? a : b)).x;
    for (const it of this.items)
      if (it.kind === "bad" && Math.abs(it.x - this.px) < 0.07 && it.y > 0.5)
        desired = this.px > this.cx ? this.xlo + 0.06 : this.xhi - 0.06;
    desired = clamp(desired, this.xlo + 0.02, this.xhi - 0.02);
    this.px += (desired - this.px) * Math.min(1, dt * 6);
    this.norm = clamp((this.px - this.cx) / (this.half * 0.92), -1, 1);
    this.rollS = this.norm * FULL_TILT_DEG;
  }
  update(dt, elapsed, roll, visible) { this.steer(roll, visible); this.simulate(dt, elapsed); }
  updateDemo(dt, elapsed) { this.aiSteer(dt); this.simulate(dt, elapsed); }
  simulate(dt, elapsed) {
    const side = this.norm > 0.7 ? 1 : this.norm < -0.7 ? -1 : 0;
    if (side !== 0 && side !== this.tiltSide) { this.fullTilts++; this.tiltSide = side; }
    else if (side === 0) this.tiltSide = 0;

    const diff = 1 + elapsed / 30;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) { this.spawn(elapsed, diff); this.spawnTimer = Math.max(0.5, 1.05 / diff); }
    if (this.comboTimer > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0) this.combo = 1; }

    const lx = this.px * W, ly = 0.82 * H;
    for (const it of this.items) {
      it.y += it.vy * dt;
      it.x += Math.sin((elapsed + it.seed) * it.sway) * 0.0006;
      it.x = clamp(it.x, this.xlo + 0.02, this.xhi - 0.02);
      if (Math.hypot(it.x * W - lx, it.y * H - ly) < 70) { this.collect(it); it.dead = true; }
      else if (it.y > 1.12) { if (it.kind === "good" && this.combo > 1) { this.combo = 1; this.comboTimer = 0; } it.dead = true; }
    }
    this.items = this.items.filter((i) => !i.dead);

    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.life -= dt; }
    this.particles = this.particles.filter((p) => p.life > 0);

    if (this.glow > 0) this.glow -= dt * 3;
    if (this.shake > 0) { this.shake *= 0.85; if (this.shake < 0.4) this.shake = 0; }
    if (this.toastT > 0) this.toastT -= dt;
  }
  spawn(elapsed, diff) {
    const x = rand(this.xlo + 0.04, this.xhi - 0.04), vy = rand(0.16, 0.22) * diff;
    const badChance = Math.min(0.28, 0.1 + elapsed / 240), r = Math.random();
    if (r < badChance) this.items.push(new Item(x, vy, "bad", choice(BAD), ""));
    else if (r < badChance + 0.05) this.items.push(new Item(x, vy, "rare", RARE[0], RARE[1]));
    else { const g = choice(GOOD); this.items.push(new Item(x, vy, "good", g[0], g[1])); }
  }
  collect(it) {
    this.glow = 1; const cx = it.x * W, cy = it.y * H;
    if (it.kind === "bad") {
      this.score = Math.max(0, this.score - 3); this.combo = 1; this.comboTimer = 0; this.shake = 14;
      this.burst(cx, cy, 22, MAGENTA); this.say("scrambled!"); this.sfx("bad");
    } else {
      const val = it.kind === "rare" ? 5 : 1;
      this.combo = Math.min(99, this.combo + 1); this.bestCombo = Math.max(this.bestCombo, this.combo); this.comboTimer = 2.2;
      this.score += val * Math.max(1, (this.combo / 3 | 0) + 1);
      this.burst(cx, cy, it.kind === "rare" ? 40 : 16, it.kind === "rare" ? GOLD_BRIGHT : this.pal.good);
      this.say(it.name); this.sfx(it.kind === "rare" ? "rare" : "good", this.combo);
    }
  }
  burst(x, y, n, color) { for (let i = 0; i < n; i++) this.particles.push(new Particle(x, y, color)); }
  stepParticles(dt) { for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.life -= dt; } this.particles = this.particles.filter((p) => p.life > 0); }
  say(t) { if (t) { this.toast = t; this.toastT = 0.9; } }
}

// ---------------- Session stats (localStorage) ----------------
const Stats = {
  data: null,
  today() { return new Date().toISOString().slice(0, 10); },
  blank() { return { date: this.today(), plays: 0, rounds: 0, matches: 0, threads: 0, tilts: 0, rangeSum: 0, rangeN: 0, best: 0, top: [] }; },
  load() {
    try { const d = JSON.parse(localStorage.getItem("tot_session")); this.data = d && d.date === this.today() ? Object.assign(this.blank(), d) : this.blank(); }
    catch (e) { this.data = this.blank(); }
  },
  save() { try { localStorage.setItem("tot_session", JSON.stringify(this.data)); } catch (e) {} },
  addPlayer(p) {
    const d = this.data; d.plays++; d.threads += p.score; d.tilts += p.fullTilts;
    d.rangeSum += p.maxRange; d.rangeN++; d.best = Math.max(d.best, p.score);
    d.top = [...d.top, p.score].sort((a, b) => b - a).slice(0, 5);
  },
  addRound() { this.data.rounds++; },
  addMatch() { this.data.matches++; },
  reset() { this.data = this.blank(); this.save(); },
  avgRange() { const d = this.data; return d.rangeN ? d.rangeSum / d.rangeN : 0; },
};

// ====================================================================
//  Game
// ====================================================================
const Game = {
  state: "loading", mode: 1, players: [],
  roundWins: [0, 0], roundNum: 1, roundResult: "", winText: "", overMsg: "",
  cd: 0, cdLastBeep: null, timeLeft: ROUND_SECONDS, startTime: 0, elapsed: 0,
  calibRemaining: 0, demoElapsed: 0, idle: 0,

  playSfx(kind, combo = 0) {
    if (snd.muted) return;
    if (kind === "good") snd.catchPluck(combo);
    else if (kind === "rare") snd.rare();
    else if (kind === "bad") snd.bad();
  },

  newMatch(mode) { this.mode = mode; this.roundWins = [0, 0]; this.roundNum = 1; this.winText = ""; this.setupRound(); },
  nextRound() { this.roundNum++; this.setupRound(); },
  setupRound() {
    this.players = this.mode === 2
      ? [new Player(0, 0.0, 0.49), new Player(1, 0.51, 1.0)]
      : [new Player(0, 0.04, 0.96)];
    for (const p of this.players) p.sfx = (k, c) => this.playSfx(k, c);
    this.elapsed = 0; this.timeLeft = ROUND_SECONDS; this.overMsg = ""; this.roundResult = "";
    this.calibRemaining = 2.0; this.state = "calib";
  },
  startDemo() { this.players = [new Player(0, 0.04, 0.96)]; this.demoElapsed = 0; this.idle = 0; this.state = "demo"; },
  toTitle() { this.players = []; this.idle = 0; this.state = "title"; },

  assign(dets) {
    const a = [null, null].slice(0, this.players.length);
    if (this.mode === 1) { if (dets.length) a[0] = dets.reduce((x, y) => (Math.abs(x.cx - 0.5) < Math.abs(y.cx - 0.5) ? x : y)); }
    else {
      const L = dets.filter((d) => d.cx < 0.5), R = dets.filter((d) => d.cx >= 0.5);
      if (L.length) a[0] = L.reduce((x, y) => (Math.abs(x.cx - 0.25) < Math.abs(y.cx - 0.25) ? x : y));
      if (R.length) a[1] = R.reduce((x, y) => (Math.abs(x.cx - 0.75) < Math.abs(y.cx - 0.75) ? x : y));
    }
    return a;
  },

  update(dt, dets) {
    if (this.state === "demo") { this.demoElapsed += dt; this.players[0].updateDemo(dt, Math.min(this.demoElapsed, 24)); return; }
    const a = this.assign(dets);
    if (this.state === "calib") {
      this.players.forEach((p, i) => { if (a[i]) { p.visible = true; p.calib.push(a[i].roll); } else p.visible = false; });
      this.calibRemaining -= dt;
      if (this.calibRemaining <= 0) { this.players.forEach((p) => p.setCenter()); this.cd = 3.0; this.cdLastBeep = null; this.state = "countdown"; }
      return;
    }
    if (this.state === "countdown") {
      this.players.forEach((p, i) => p.idle(a[i] ? a[i].roll : 0, !!a[i]));
      const cur = this.cd > 0 ? Math.ceil(this.cd) : 0;
      if (cur !== this.cdLastBeep) { this.cdLastBeep = cur; if (cur > 0) snd.beep(cur); else snd.go(); }
      this.cd -= dt;
      if (this.cd <= -0.5) { this.startTime = performance.now() / 1000; this.state = "play"; }
      return;
    }
    if (this.state === "play") {
      this.elapsed += dt; this.timeLeft = ROUND_SECONDS - (performance.now() / 1000 - this.startTime);
      this.players.forEach((p, i) => p.update(dt, this.elapsed, a[i] ? a[i].roll : 0, !!a[i]));
      if (this.timeLeft <= 0) this.finish();
      return;
    }
    if (this.state === "over" || this.state === "round_over") this.players.forEach((p) => p.stepParticles(dt));
  },

  finish() {
    let burstP = this.players;
    if (this.mode === 2) {
      const a = this.players[0].score, b = this.players[1].score;
      let winner = null;
      if (a === b) this.roundResult = `Round ${this.roundNum}: draw - replay`;
      else { winner = a > b ? 0 : 1; this.roundWins[winner]++; this.roundResult = `Round ${this.roundNum}: ${PALETTES[winner].name} takes it`; }
      if (Math.max(...this.roundWins) >= WINS_NEEDED) {
        const champ = this.roundWins[0] > this.roundWins[1] ? 0 : 1;
        this.winText = `${PALETTES[champ].name} WINS THE MATCH!`; this.state = "over";
      } else { this.state = "round_over"; burstP = winner === null ? this.players : [this.players[winner]]; }
    } else { this.overMsg = soloMessage(this.players[0]); this.state = "over"; }
    for (const p of burstP) p.burst(p.cx * W, H * 0.4, 50, p.pal.good);
    // session stats
    for (const p of this.players) Stats.addPlayer(p);
    Stats.addRound();
    if (this.mode === 2 && this.state === "over") Stats.addMatch();
    Stats.save();
  },
};

function soloMessage(p) {
  const s = p.score; let m;
  if (s >= 80) m = "Maestro of motion - culture flows through your spine!";
  else if (s >= 50) m = "Wonderful range and rhythm. Your neck is dancing.";
  else if (s >= 25) m = "Lovely work - limber and curious.";
  else m = "A gentle start. Every tilt counts toward a happier neck.";
  if (s >= Stats.data.best && Stats.data.best > 0) m += "   New stall high score!";
  return m;
}

// ====================================================================
//  Rendering
// ====================================================================
function render(now) {
  ctx.drawImage(bgCanvas, 0, 0);
  const g = Game;
  if (["play", "over", "round_over", "countdown", "demo"].includes(g.state)) {
    if (g.mode === 2 && g.state !== "demo") drawDivider();
    for (const p of g.players) renderPlayer(p);
  }
  if (["calib", "play", "countdown"].includes(g.state)) drawPreview(g);

  if (g.state === "title") drawTitle();
  else if (g.state === "demo") drawDemo();
  else if (g.state === "stats") drawStats();
  else if (g.state === "calib") drawCalib();
  else if (g.state === "countdown") drawCountdown();
  else if (g.state === "play") drawHud();
  else if (g.state === "round_over") drawRoundOver();
  else if (g.state === "over") drawOver();
  drawLogo();
}

function drawDivider() {
  ctx.strokeStyle = "rgba(138,108,255,0.5)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.fillStyle = GOLD; for (let y = 0; y < H; y += 24) ctx.fillRect(W / 2 - 1, y, 2, 2);
}
function lightPool(x, y, r, color, strength) {
  const grd = ctx.createRadialGradient(x, y, 4, x, y, r);
  grd.addColorStop(0, color + Math.round(clamp(strength, 0, 1) * 130).toString(16).padStart(2, "0"));
  grd.addColorStop(1, color + "00");
  ctx.fillStyle = grd; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
function renderPlayer(p) {
  let ox = 0, oy = 0;
  if (p.shake > 0) { ox = rand(-p.shake, p.shake); oy = rand(-p.shake, p.shake); }
  for (const it of p.items) {
    const gc = it.kind === "bad" ? MAGENTA : it.kind === "rare" ? GOLD_BRIGHT : p.pal.good;
    emoji(it.e, it.x * W + ox, it.y * H + oy, 74, gc, it.kind === "rare" ? 28 : 18);
  }
  for (const pa of p.particles) {
    ctx.globalAlpha = clamp(pa.life, 0, 1); ctx.fillStyle = pa.color;
    ctx.beginPath(); ctx.arc(pa.x + ox, pa.y + oy, pa.size, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const lx = p.px * W + ox, ly = 0.82 * H + oy;
  lightPool(lx, ly, 110, p.pal.lantern, 0.5 + p.glow * 0.4);
  emoji(LANTERN, lx, ly, 92, p.pal.lantern, 22 + p.glow * 30);
}
function drawPreview(g) {
  const duel = g.mode === 2;
  const pw = duel ? 220 : 200, ph = duel ? 124 : 150;
  const x0 = duel ? W / 2 - pw / 2 : W - pw - 18;
  const y0 = duel ? 92 : H - ph - 18;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip();
  ctx.translate(x0 + pw, y0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, pw, ph);
  if (g.state === "play" || g.state === "calib") {
    ctx.fillStyle = CYAN;
    for (const d of lastDetections) for (const pt of d.points) { ctx.beginPath(); ctx.arc(pt.x * pw, pt.y * ph, 1, 0, 7); ctx.fill(); }
  }
  ctx.restore();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.strokeRect(x0, y0, pw, ph);
  text("YOU", x0 + 28, y0 + 16, 15, GOLD_BRIGHT, { glow: false });
}
function drawLogo() {
  if (!logoReady) return;
  const g = Game;
  if (["title", "demo", "stats", "over", "round_over"].includes(g.state)) {
    const s = 128; ctx.drawImage(logo, 26, 26, s, s);
    text("FACTS-H Lab", 26 + s / 2, 26 + s + 12, 15, DIM, { glow: false });
  } else if (["play", "countdown"].includes(g.state)) {
    const s = 52; ctx.drawImage(logo, 16, H - 16 - s, s, s);
  }
}

// ---- screens ----
function drawTitle() {
  text("TILT OF TIME", W / 2, H * 0.22, 78, GOLD_BRIGHT, { blur: 26 });
  text("Bend your neck. Gather the threads of human culture.", W / 2, H * 0.31, 24, INK);
  const solo = Game.mode === 1 ? CYAN : "#9a9aa6", duel = Game.mode === 2 ? ORANGE : "#9a9aa6";
  text("[ 1 ]  SOLO", W / 2 - 240, H * 0.46, 36, solo);
  text("one player, full screen", W / 2 - 240, H * 0.52, 15, INK, { glow: false });
  text("[ 2 ]  DUEL", W / 2 + 240, H * 0.46, 36, duel);
  text("two players, best-of-3 race", W / 2 + 240, H * 0.52, 15, INK, { glow: false });
  text("Tilt your head LEFT & RIGHT to glide your lantern", W / 2, H * 0.62, 21, INK);
  text("Catch culture icons & build combos  -  dodge the glitch-voids", W / 2, H * 0.67, 21, INK);
  text(`Press 1 or 2, then SPACE to start   (${Game.mode === 1 ? "SOLO" : "DUEL"})`, W / 2, H * 0.78, 28, GOLD);
  if (Stats.data.best) text(`Stall high score: ${Stats.data.best} threads`, W / 2, H * 0.84, 18, GOLD);
  text("S session stats    F fullscreen    M mute", W / 2, H * 0.93, 15, "#9a9aa6", { glow: false });
}
function drawDemo() {
  text("TILT OF TIME", W / 2, H * 0.16, 60, GOLD_BRIGHT, { blur: 24 });
  text("a neck-mobility game - tilt your head to play", W / 2, H * 0.24, 22, INK);
  text("DEMO", W / 2, H * 0.31, 15, DIM, { glow: false });
  const pulse = 0.5 + 0.5 * Math.sin(Game.demoElapsed * 3);
  text("STEP UP  -  PRESS SPACE TO PLAY", W / 2, H * 0.85, 30 + pulse * 6, GOLD_BRIGHT);
}
function drawCalib() {
  const t = Game.mode === 1 ? "Find your range" : "Both players: find your range";
  text(t, W / 2, H * 0.34, 46, GOLD_BRIGHT, { blur: 22 });
  text("Sit tall, look straight ahead, breathe...", W / 2, H * 0.44, 24, INK);
  const bw = 460, x0 = W / 2 - bw / 2, y0 = H * 0.54;
  ctx.strokeStyle = "#5a4a3c"; ctx.strokeRect(x0, y0, bw, 16);
  ctx.fillStyle = CYAN; ctx.fillRect(x0, y0, bw * (1 - Math.max(0, Game.calibRemaining) / 2), 16);
  Game.players.forEach((p, i) => {
    const cx = W / 2 + (i - (Game.players.length - 1) / 2) * 280;
    text(`${p.pal.name}: ${p.visible ? "ready" : "show your face"}`, cx, H * 0.66, 18, p.visible ? p.pal.accent : "#7a7a86");
  });
}
function pips(cx, y, wins, color) {
  for (let i = 0; i < WINS_NEEDED; i++) {
    const x = cx - (WINS_NEEDED - 1) * 12 + i * 24;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7);
    if (i < wins) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = "#7a7a86"; ctx.lineWidth = 1; ctx.stroke(); }
  }
}
function drawCountdown() {
  const g = Game;
  if (g.mode === 2) {
    const yr = H * 0.34;
    text(`ROUND ${g.roundNum}`, W / 2, yr, 34, GOLD);
    pips(W * 0.40, yr + 4, g.roundWins[0], g.players[0].pal.accent);
    pips(W * 0.60, yr + 4, g.roundWins[1], g.players[1].pal.accent);
  }
  if (g.cd > 0) { const n = Math.ceil(g.cd), pulse = g.cd - Math.floor(g.cd); text(String(n), W / 2, H * 0.55, (4.5 + pulse * 2.5) * 26, GOLD_BRIGHT, { blur: 30 }); }
  else text("GO!", W / 2, H * 0.55, 170, CYAN, { blur: 34 });
  text("tilt your head to move your lantern", W / 2, H * 0.74, 18, DIM, { glow: false });
}
function hudBox(cx, label, val, col) { text(label, cx, 34, 14, DIM, { glow: false }); text(val, cx, 70, 32, col); }
function tiltMeter(p, cx, width) {
  const bw = width, x0 = cx - bw / 2, y0 = H - 46;
  ctx.strokeStyle = "#46324a"; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, bw, 14);
  ctx.strokeStyle = "#78788c"; ctx.beginPath(); ctx.moveTo(cx, y0 - 3); ctx.lineTo(cx, y0 + 17); ctx.stroke();
  const nx = cx + p.norm * (bw / 2 - 6);
  ctx.fillStyle = p.pal.accent; ctx.fillRect(nx - 4, y0 - 5, 8, 24);
}
function toast(p, cx) { if (p.toastT > 0 && p.toast) text(p.toast, cx, H * 0.4, 30, GOLD_BRIGHT); }
function drawHud() {
  const g = Game;
  if (g.mode === 1) {
    const p = g.players[0];
    hudBox(W / 2 - 220, "SCORE", String(p.score), GOLD_BRIGHT);
    hudBox(W / 2, "TIME", String(Math.max(0, Math.ceil(g.timeLeft))), g.timeLeft <= 10 ? MAGENTA : CYAN);
    hudBox(W / 2 + 220, "COMBO", "x" + p.combo, GOLD_BRIGHT);
    tiltMeter(p, W / 2, 620); toast(p, W / 2);
  } else {
    const [p1, p2] = g.players;
    hudBox(W * 0.16, "P1 SCORE", String(p1.score), p1.pal.accent);
    hudBox(W * 0.16 + 170, "COMBO", "x" + p1.combo, GOLD_BRIGHT);
    hudBox(W * 0.84, "P2 SCORE", String(p2.score), p2.pal.accent);
    hudBox(W * 0.84 - 170, "COMBO", "x" + p2.combo, GOLD_BRIGHT);
    hudBox(W / 2, "TIME", String(Math.max(0, Math.ceil(g.timeLeft))), g.timeLeft <= 10 ? MAGENTA : GOLD_BRIGHT);
    pips(W * 0.16, 98, g.roundWins[0], p1.pal.accent);
    pips(W * 0.84, 98, g.roundWins[1], p2.pal.accent);
    text(`ROUND ${g.roundNum}  -  best of 3`, W / 2, H - 12, 15, DIM, { glow: false });
    tiltMeter(p1, W * 0.25, W * 0.42); tiltMeter(p2, W * 0.75, W * 0.42);
    toast(p1, W * 0.25); toast(p2, W * 0.75);
  }
  for (const p of g.players) if (!p.visible) text("show your face", p.cx * W, H * 0.5, 22, MAGENTA);
}
function drawRoundOver() {
  const g = Game, [p1, p2] = g.players;
  let rc = GOLD_BRIGHT;
  if (g.roundResult.includes("PLAYER 1")) rc = p1.pal.accent; else if (g.roundResult.includes("PLAYER 2")) rc = p2.pal.accent;
  text(g.roundResult, W / 2, H * 0.2, 42, rc, { blur: 22 });
  text("MATCH", W / 2, H * 0.32, 18, DIM, { glow: false });
  pips(W * 0.42, H * 0.32 + 4, g.roundWins[0], p1.pal.accent);
  pips(W * 0.58, H * 0.32 + 4, g.roundWins[1], p2.pal.accent);
  [[p1, 0.27], [p2, 0.73]].forEach(([p, s]) => { text(p.pal.name, W * s, H * 0.46, 26, p.pal.accent); text(String(p.score), W * s, H * 0.58, 70, GOLD_BRIGHT); });
  text(`First to ${WINS_NEEDED} wins the match`, W / 2, H * 0.74, 19, GOLD);
  text("SPACE  next round      1/2  menu      M  mute", W / 2, H * 0.88, 24, GOLD_BRIGHT);
}
function drawOver() {
  const g = Game;
  if (g.mode === 1) {
    const p = g.players[0];
    text("Round Complete", W / 2, H * 0.18, 44, GOLD_BRIGHT, { blur: 22 });
    text(String(p.score), W / 2, H * 0.38, 130, GOLD_BRIGHT, { blur: 30 });
    text("threads woven", W / 2, H * 0.48, 20, DIM, { glow: false });
    [[Math.round(p.maxRange) + "°", "neck range"], ["x" + p.bestCombo, "best combo"], [String(p.fullTilts), "full tilts"]]
      .forEach(([n, l], i) => { const cx = W / 2 + (i - 1) * 230; text(n, cx, H * 0.6, 36, CYAN); text(l, cx, H * 0.66, 15, DIM, { glow: false }); });
    text(g.overMsg, W / 2, H * 0.78, 21, GOLD);
  } else {
    const [p1, p2] = g.players;
    let wc = GOLD_BRIGHT;
    if (g.winText.includes("PLAYER 1")) wc = p1.pal.accent; else if (g.winText.includes("PLAYER 2")) wc = p2.pal.accent;
    text(g.winText, W / 2, H * 0.18, 56, wc, { blur: 26 });
    text(`Match  ${g.roundWins[0]} - ${g.roundWins[1]}  (best of 3)`, W / 2, H * 0.27, 22, GOLD);
    [[p1, 0.27], [p2, 0.73]].forEach(([p, s]) => {
      text(p.pal.name, W * s, H * 0.4, 26, p.pal.accent); text(String(p.score), W * s, H * 0.54, 84, GOLD_BRIGHT);
      text(`best combo x${p.bestCombo}   neck ${Math.round(p.maxRange)}°`, W * s, H * 0.62, 15, DIM, { glow: false });
    });
  }
  text("SPACE  play again      1/2  change mode      M  mute", W / 2, H * 0.91, 22, GOLD_BRIGHT);
}
function drawStats() {
  const d = Stats.data;
  text("SESSION STATS", W / 2, H * 0.13, 48, GOLD_BRIGHT, { blur: 22 });
  text(String(d.date), W / 2, H * 0.2, 18, DIM, { glow: false });
  const tiles = [["Plays", String(d.plays), CYAN], ["Threads woven", String(d.threads), GOLD_BRIGHT], ["Total tilts", String(d.tilts), ORANGE],
    ["Avg neck range", Math.round(Stats.avgRange()) + "°", CYAN], ["Duel matches", String(d.matches), ORANGE], ["Best score", String(d.best), GOLD_BRIGHT]];
  tiles.forEach(([l, v, c], i) => { const cx = W / 2 + ((i % 3) - 1) * 320, cy = H * 0.37 + ((i / 3) | 0) * H * 0.2; text(v, cx, cy, 48, c); text(l, cx, cy + 36, 15, DIM, { glow: false }); });
  if (d.top.length) text("TOP SCORES   " + d.top.map((s, i) => `${i + 1}. ${s}`).join("    "), W / 2, H * 0.8, 18, GOLD);
  text("SPACE  back        R  reset session        M  mute", W / 2, H * 0.91, 22, GOLD_BRIGHT);
}

// ====================================================================
//  Main loop + input + boot
// ====================================================================
let lastT = performance.now();
function loop() {
  const now = performance.now();
  let dt = (now - lastT) / 1000; lastT = now; if (dt > 0.05) dt = 0.05;
  const dets = detect(now);

  const facePresent = dets.length > 0;
  Game.idle = facePresent ? 0 : Game.idle + dt;

  if (["calib", "countdown", "play", "over", "round_over", "demo"].includes(Game.state)) Game.update(dt, dets);
  if (Game.state === "title" && Game.idle > 6) Game.startDemo();
  else if (Game.state === "demo" && facePresent) Game.toTitle();
  else if ((Game.state === "over" || Game.state === "round_over") && Game.idle > 20) Game.toTitle();

  if (Game.state === "play" && !snd.muted) snd.startAmbient(); else snd.stopAmbient();

  render(now);
  requestAnimationFrame(loop);
}

function onKey(k) {
  snd.resume();
  Game.idle = 0;
  const g = Game;
  if (k === "1") { g.mode = 1; if (["over", "round_over", "demo"].includes(g.state)) g.toTitle(); }
  else if (k === "2") { g.mode = 2; if (["over", "round_over", "demo"].includes(g.state)) g.toTitle(); }
  else if (k === " " || k === "Enter") {
    if (g.state === "stats") g.toTitle();
    else if (["title", "over", "demo"].includes(g.state)) g.newMatch(g.mode);
    else if (g.state === "round_over") g.nextRound();
  } else if (k === "s" || k === "S") {
    if (g.state === "stats") g.toTitle();
    else if (["title", "over", "round_over", "demo"].includes(g.state)) g.state = "stats";
  } else if ((k === "r" || k === "R") && g.state === "stats") Stats.reset();
  else if (k === "f" || k === "F") { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); }
  else if (k === "m" || k === "M") toggleMute();
}
function toggleMute() { snd.muted = !snd.muted; $("soundBtn").textContent = snd.muted ? "🔈" : "🔊"; if (!snd.muted) snd.resume(); }

window.addEventListener("keydown", (e) => { if ([" ", "Enter"].includes(e.key)) e.preventDefault(); onKey(e.key); });
canvas.addEventListener("pointerdown", () => onKey(" "));  // tap to advance (touch stalls)
$("soundBtn").addEventListener("click", toggleMute);
$("retryBtn").addEventListener("click", () => location.reload());

function resize() {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width = W * s + "px"; canvas.style.height = H * s + "px";
}
window.addEventListener("resize", resize);

window.TOT = { Game, Stats, snd, render };  // exposed for debugging/automation

async function boot() {
  buildBackground(); resize(); Stats.load();
  try {
    $("loadingText").textContent = "Awakening the camera spirits…";
    await setupCamera();
    $("loadingText").textContent = "Summoning the vision model…";
    await setupLandmarker();
    if (window.__totWatchdog) clearTimeout(window.__totWatchdog);
    $("loading").classList.add("hidden");
    Game.state = "title";
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    if (window.__totWatchdog) clearTimeout(window.__totWatchdog);
    $("errText").textContent = err && err.message ? err.message : String(err);
    $("loading").classList.add("hidden"); $("error").classList.remove("hidden");
  }
}
boot();
