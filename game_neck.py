#!/usr/bin/env python3
# ====================================================================
#  TILT OF TIME  —  a native desktop neck-mobility game
#
#  Tilt your head left/right (gentle lateral neck flexion) to glide a
#  glowing lantern and catch the falling icons of human culture.
#  Built for a culture x humanities x technology conference stall.
#
#  SOLO or 2-PLAYER DUEL on a single webcam (split screen). Each player
#  tilts their own head to steer their own lantern.
#
#  Pure desktop app: OpenCV window + MediaPipe face tracking. No
#  browser, no server, no internet needed once installed.
#
#  Run:   ./play.sh        (or:  .venv/bin/python game_neck.py)
#  Keys:  1 solo   2 duel   SPACE start/again   F fullscreen
#         M mute   ESC/Q quit
# ====================================================================

import datetime
import json
import math
import os
import platform
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision
    _HAVE_MP = True
except Exception:
    _HAVE_MP = False

_HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(_HERE, "vendor", "face_landmarker.task")
LOGO_PATH = os.path.join(_HERE, "assets", "factsh_white.png")

# ---------------- Config ----------------
W, H = 1280, 720
ROUND_SECONDS = 60
FULL_TILT_DEG = 20.0       # head roll that pushes the lantern to the edge
SMOOTH = 0.30              # tilt smoothing (higher = snappier)
TILT_SIGN = 1              # flip to -1 if left/right feels reversed
WINS_NEEDED = 2            # duel is best-of-3: first to 2 round wins
WIN = "Tilt of Time"

GOOD = [
    ("🪔", "Diya"), ("🎭", "Theatre"), ("📜", "Manuscript"), ("🎶", "Music"),
    ("🪕", "Strings"), ("🏛️", "Heritage"), ("🧮", "Maths"), ("🔭", "Science"),
    ("🎨", "Art"), ("🪷", "Lotus"), ("🧵", "Craft"), ("💡", "Idea"),
    ("⚛️", "Physics"), ("🌏", "World"), ("📿", "Tradition"),
]
RARE = ("✨", "Spark!")
BAD = ["🌀", "💀", "🕳️"]
LANTERN = "🏮"

EMOJI_FONT = "/System/Library/Fonts/Apple Color Emoji.ttc"

# ---------------- Colours (BGR) ----------------
GOLD = (122, 210, 255)
GOLD_BRIGHT = (184, 233, 255)
CYAN = (255, 230, 70)
ORANGE = (70, 150, 255)
MAGENTA = (157, 77, 255)
INK = (245, 236, 255)

# Per-player palette: (accent for HUD/needle, glow for good icons, lantern glow)
PALETTES = [
    {"accent": CYAN,   "good": CYAN,   "lantern": GOLD,   "name": "PLAYER 1"},
    {"accent": ORANGE, "good": ORANGE, "lantern": ORANGE, "name": "PLAYER 2"},
]


# ====================================================================
#  Emoji sprites (rendered once, cached, with baked-in glow)
# ====================================================================
_sprite_cache = {}
_emoji_font_cache = {}


def _load_emoji_font(px):
    if px not in _emoji_font_cache:
        try:
            _emoji_font_cache[px] = ImageFont.truetype(EMOJI_FONT, px)
        except Exception:
            _emoji_font_cache[px] = None
    return _emoji_font_cache[px]


def make_sprite(emoji, size, glow_bgr, glow_strength=1.0):
    """Return a BGRA numpy sprite for an emoji, with a soft coloured glow."""
    key = (emoji, size, glow_bgr, glow_strength)
    if key in _sprite_cache:
        return _sprite_cache[key]

    pad = int(size * 0.6)
    canvas = size + pad * 2
    # Apple Color Emoji only has bitmap strikes at 48/64/96/160 px; 160 is
    # sharpest. Render there, then scale down to the requested size.
    STRIKE = 160
    font = _load_emoji_font(STRIKE)

    rgba = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    if font is not None:
        tmp = Image.new("RGBA", (STRIKE + 40, STRIKE + 40), (0, 0, 0, 0))
        d = ImageDraw.Draw(tmp)
        c = (STRIKE + 40) // 2
        try:
            d.text((c, c), emoji, font=font, anchor="mm", embedded_color=True)
        except Exception:
            pass
        tmp = tmp.resize((size, size), Image.LANCZOS)
        rgba.paste(tmp, (pad, pad), tmp)

    arr = np.array(rgba)  # RGBA
    if arr[:, :, 3].sum() == 0:
        bgra = np.zeros((canvas, canvas, 4), np.uint8)
        cv2.circle(bgra, (canvas // 2, canvas // 2), size // 2, (*glow_bgr, 255), -1)
        _sprite_cache[key] = bgra
        return bgra

    alpha = arr[:, :, 3].astype(np.float32) / 255.0
    glow = cv2.GaussianBlur(alpha, (0, 0), sigmaX=size * 0.18)
    glow = np.clip(glow * 1.6 * glow_strength, 0, 1)

    bgr = arr[:, :, [2, 1, 0]].astype(np.float32)
    out = np.zeros((canvas, canvas, 4), np.float32)
    for c in range(3):
        out[:, :, c] = glow_bgr[c] * glow
    out[:, :, 3] = glow * 200
    ea = alpha[:, :, None]
    out[:, :, :3] = bgr * ea + out[:, :, :3] * (1 - ea)
    out[:, :, 3] = np.maximum(out[:, :, 3], alpha * 255)

    bgra = np.clip(out, 0, 255).astype(np.uint8)
    _sprite_cache[key] = bgra
    return bgra


def blit(dst, sprite, cx, cy):
    """Alpha-composite a BGRA sprite centred at (cx, cy) onto a BGR image."""
    sh, sw = sprite.shape[:2]
    x0 = int(cx - sw / 2)
    y0 = int(cy - sh / 2)
    x1, y1 = x0 + sw, y0 + sh
    dx0, dy0 = max(0, x0), max(0, y0)
    dx1, dy1 = min(dst.shape[1], x1), min(dst.shape[0], y1)
    if dx0 >= dx1 or dy0 >= dy1:
        return
    sx0, sy0 = dx0 - x0, dy0 - y0
    sx1, sy1 = sx0 + (dx1 - dx0), sy0 + (dy1 - dy0)
    src = sprite[sy0:sy1, sx0:sx1]
    a = src[:, :, 3:4].astype(np.float32) / 255.0
    roi = dst[dy0:dy1, dx0:dx1].astype(np.float32)
    dst[dy0:dy1, dx0:dx1] = (src[:, :, :3] * a + roi * (1 - a)).astype(np.uint8)


def put_text(img, text, org, scale, color, thick=2, center=False, glow=True):
    font = cv2.FONT_HERSHEY_DUPLEX
    if center:
        (tw, th), _ = cv2.getTextSize(text, font, scale, thick)
        org = (int(org[0] - tw / 2), int(org[1] + th / 2))
    if glow:
        cv2.putText(img, text, org, font, scale, (0, 0, 0), thick + 4, cv2.LINE_AA)
    cv2.putText(img, text, org, font, scale, color, thick, cv2.LINE_AA)


def load_logo(path, height):
    """Load the FACTS-H logo, trim its transparent border, return a BGRA sprite."""
    im = Image.open(path).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w = max(1, int(im.width * height / im.height))
    im = im.resize((w, height), Image.LANCZOS)
    arr = np.array(im)                     # RGBA
    return arr[:, :, [2, 1, 0, 3]].copy()  # -> BGRA for our blit()


def make_background():
    bg = np.zeros((H, W, 3), np.uint8)
    yy, xx = np.mgrid[0:H, 0:W]
    cx, cy = W / 2, H * 0.38
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    t = np.clip(d / (H * 1.05), 0, 1)
    top = np.array([58, 15, 26], np.float32)
    bot = np.array([18, 5, 7], np.float32)
    for c in range(3):
        bg[:, :, c] = (top[c] * (1 - t) + bot[c] * t).astype(np.uint8)
    rng = random.Random(7)
    for _ in range(160):
        x, y = rng.randint(0, W - 1), rng.randint(0, H - 1)
        b = rng.randint(60, 200)
        s = 1 if rng.random() < 0.85 else 2
        cv2.circle(bg, (x, y), s, (b, b, min(255, b + 30)), -1)
    overlay = bg.copy()
    mcx, mcy = W // 2, int(H * 0.42)
    R = int(min(W, H) * 0.42)
    for i in range(12):
        ang = i * math.pi / 6
        ex = int(mcx + math.cos(ang) * R * 0.5)
        ey = int(mcy + math.sin(ang) * R * 0.5)
        cv2.ellipse(overlay, (ex, ey), (int(R * 0.5), int(R * 0.16)),
                    math.degrees(ang), 0, 360, GOLD, 1, cv2.LINE_AA)
    cv2.circle(overlay, (mcx, mcy), int(R * 0.28), GOLD, 1, cv2.LINE_AA)
    cv2.circle(overlay, (mcx, mcy), int(R * 0.9), GOLD, 1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.06, bg, 0.94, 0, bg)
    return bg


# ====================================================================
#  Session stats — accumulated across the day for the stall.
#  Persisted to disk; auto-resets when the calendar date changes.
# ====================================================================
class SessionStats:
    def __init__(self, path):
        self.path = path
        self.data = self._blank()
        self._load()

    @staticmethod
    def _today():
        try:
            return datetime.date.today().isoformat()
        except Exception:
            return "session"

    def _blank(self):
        return {"date": self._today(), "plays": 0, "rounds": 0, "matches": 0,
                "threads": 0, "tilts": 0, "range_sum": 0.0, "range_n": 0,
                "best": 0, "top": []}

    def _load(self):
        try:
            with open(self.path) as f:
                d = json.load(f)
            if d.get("date") == self._today():     # ignore yesterday's file
                self.data = {**self._blank(), **d}
        except Exception:
            pass

    def save(self):
        try:
            with open(self.path, "w") as f:
                json.dump(self.data, f)
        except Exception:
            pass

    def add_player(self, p):
        d = self.data
        d["plays"] += 1
        d["threads"] += int(p.score)
        d["tilts"] += int(p.full_tilts)
        d["range_sum"] += float(p.max_range)
        d["range_n"] += 1
        d["best"] = max(d["best"], int(p.score))
        top = d["top"] + [int(p.score)]
        d["top"] = sorted(top, reverse=True)[:5]

    def add_round(self):
        self.data["rounds"] += 1

    def add_match(self):
        self.data["matches"] += 1

    def reset(self):
        self.data = self._blank()
        self.save()

    @property
    def avg_range(self):
        d = self.data
        return d["range_sum"] / d["range_n"] if d["range_n"] else 0.0


# ====================================================================
#  Sound — short synthesized tones, played via the OS audio player.
#  No extra dependency: WAVs are generated with numpy + the stdlib, then
#  played by afplay (macOS) / paplay|aplay (Linux) / winsound (Windows).
# ====================================================================
class Sound:
    # name -> (frequency Hz, duration s, harmonics)
    SPECS = {
        "beep3": (523.25, 0.14, (1, 2)),    # C5
        "beep2": (587.33, 0.14, (1, 2)),    # D5
        "beep1": (659.25, 0.16, (1, 2)),    # E5  (rising 3-2-1)
        "go":    (783.99, 0.32, (1, 2, 3)),  # G5  brighter & longer
    }

    # C-major pentatonic, ~1.5 octaves — catch pitch rises with the combo
    CATCH_SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.7, 1318.5]

    def __init__(self):
        self.ok = False
        self.paths = {}
        self.catch_notes = []
        self._cmd = None
        self._win = platform.system() == "Windows"
        self._amb_on = False
        self._amb_proc = None
        self._amb_thread = None
        try:
            self._setup()
            self.ok = True
        except Exception as e:
            print("Sound disabled:", e)

    def _setup(self):
        rate = 44100
        d = os.path.join(tempfile.gettempdir(), "tot_sounds")
        os.makedirs(d, exist_ok=True)
        # countdown beeps
        for name, (freq, dur, harm) in self.SPECS.items():
            self._add(d, name, self._tone(freq, dur, rate, harm), rate)
        # catch plucks (one per scale note)
        for i, f in enumerate(self.CATCH_SCALE):
            name = f"catch{i}"
            self._add(d, name, self._tone(f, 0.13, rate, (1, 2, 3), decay=9.0), rate)
            self.catch_notes.append(name)
        # rare sparkle + glitch-void thunk
        self._add(d, "rare", self._shimmer(rate), rate)
        self._add(d, "bad", self._thunk(rate), rate)
        # soft ambient pad — a seamless loop for the play state
        self._add(d, "ambient", self._ambient(rate, 16.0), rate)
        if not self._win:
            for cmd in (("afplay",), ("paplay",), ("aplay", "-q")):
                if shutil.which(cmd[0]):
                    self._cmd = list(cmd)
                    break
            if self._cmd is None:
                raise RuntimeError("no audio player (afplay/paplay/aplay) found")

    def _add(self, d, name, samples, rate):
        p = os.path.join(d, name + ".wav")
        self._write(p, samples, rate)
        self.paths[name] = p

    @staticmethod
    def _tone(freq, dur, rate, harm, decay=5.0):
        t = np.linspace(0, dur, int(rate * dur), endpoint=False)
        w = sum(np.sin(2 * np.pi * freq * h * t) / h for h in harm)
        env = np.exp(-t * decay) * np.clip(t / 0.004, 0, 1)  # soft attack, decay
        return w * env * 0.4

    @staticmethod
    def _shimmer(rate):
        """Three quick bell notes ascending — a sparkle for the rare ✨."""
        notes = [1046.5, 1318.5, 1568.0]
        dur = 0.36
        t = np.linspace(0, dur, int(rate * dur), endpoint=False)
        out = np.zeros_like(t)
        for i, f in enumerate(notes):
            start = i * 0.06
            env = np.clip((t - start) / 0.004, 0, 1) * np.exp(-np.maximum(t - start, 0) * 7)
            out += (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * env * 0.3
        return out

    @staticmethod
    def _thunk(rate):
        """A short descending buzz — the glitch-void scramble."""
        dur = 0.22
        t = np.linspace(0, dur, int(rate * dur), endpoint=False)
        fdrop = np.linspace(170, 70, len(t))           # pitch falls
        phase = 2 * np.pi * np.cumsum(fdrop) / rate
        saw = 2 * ((phase / (2 * np.pi)) % 1.0) - 1.0   # sawtooth = buzzy
        env = np.exp(-t * 9.0) * np.clip(t / 0.003, 0, 1)
        return saw * env * 0.45

    @staticmethod
    def _ambient(rate, dur):
        """A soft, slowly-swelling drone that loops seamlessly.

        Every partial and the amplitude LFO are snapped to an integer number of
        cycles over `dur`, so the buffer is exactly periodic — no click at the
        loop point.
        """
        n = int(rate * dur)
        t = np.arange(n) / rate
        base = 1.0 / dur

        def snap(f):
            return round(f / base) * base

        # a calm low chord: root, fifth, octave, soft upper
        partials = [(110.0, 0.5), (164.81, 0.4), (220.0, 0.35), (329.63, 0.16)]
        out = np.zeros(n)
        for f, a in partials:
            fs = snap(f)
            out += a * np.sin(2 * np.pi * fs * t)
            out += 0.5 * a * np.sin(2 * np.pi * snap(fs * 1.003) * t)  # gentle detune
        lfo = 0.6 + 0.4 * np.sin(2 * np.pi * snap(0.05) * t)            # slow swell
        out *= lfo
        out /= (np.max(np.abs(out)) + 1e-9)
        return out * 0.16  # soft bed

    @staticmethod
    def _write(path, samples, rate):
        data = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
        with wave.open(path, "wb") as wv:
            wv.setnchannels(1)
            wv.setsampwidth(2)
            wv.setframerate(rate)
            wv.writeframes(data)

    def play(self, name):
        if not self.ok:
            return
        p = self.paths.get(name)
        if not p:
            return
        try:
            if self._win:
                import winsound
                winsound.PlaySound(p, winsound.SND_FILENAME | winsound.SND_ASYNC)
            else:
                subprocess.Popen(self._cmd + [p],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

    # ---- looping ambient bed (idempotent start/stop) ----
    def start_ambient(self):
        if not self.ok or self._amb_on:
            return
        path = self.paths.get("ambient")
        if not path:
            return
        self._amb_on = True
        try:
            if self._win:
                import winsound
                winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_LOOP)
            else:
                self._amb_thread = threading.Thread(target=self._amb_loop, args=(path,), daemon=True)
                self._amb_thread.start()
        except Exception:
            self._amb_on = False

    def _amb_loop(self, path):
        while self._amb_on:
            try:
                self._amb_proc = subprocess.Popen(
                    self._cmd + [path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self._amb_proc.wait()
            except Exception:
                break

    def stop_ambient(self):
        if not self._amb_on:
            return
        self._amb_on = False
        try:
            if self._win:
                import winsound
                winsound.PlaySound(None, winsound.SND_PURGE)
            else:
                p = self._amb_proc
                if p and p.poll() is None:
                    p.terminate()
        except Exception:
            pass


# ====================================================================
#  Head-tilt tracker (multi-face)
# ====================================================================
class Detection:
    __slots__ = ("roll", "cx", "points")

    def __init__(self, roll, cx, points):
        self.roll = roll
        self.cx = cx
        self.points = points


class Tracker:
    def __init__(self, max_faces=2):
        self.mode = None
        self._ts = 0
        if _HAVE_MP and os.path.exists(MODEL_PATH):
            try:
                bo = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
                opts = mp_vision.FaceLandmarkerOptions(
                    base_options=bo,
                    running_mode=mp_vision.RunningMode.VIDEO,
                    num_faces=max_faces)
                self.landmarker = mp_vision.FaceLandmarker.create_from_options(opts)
                self.mode = "mp"
            except Exception as e:
                print("MediaPipe init failed, using OpenCV fallback:", e)
        if self.mode is None:
            base = cv2.data.haarcascades
            self.face = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
            self.eyes = cv2.CascadeClassifier(base + "haarcascade_eye.xml")
            self.mode = "haar"

    def detect(self, frame_rgb):
        """Return a list of Detection (one per visible face)."""
        out = []
        if self.mode == "mp":
            self._ts += 33
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
            res = self.landmarker.detect_for_video(mp_image, self._ts)
            for lm in res.face_landmarks:
                a, b = lm[33], lm[263]
                roll = math.degrees(math.atan2(b.y - a.y, b.x - a.x))
                cx = sum(p.x for p in lm) / len(lm)
                out.append(Detection(roll, cx, [(p.x, p.y) for p in lm]))
        else:
            gray = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2GRAY)
            faces = self.face.detectMultiScale(gray, 1.2, 5, minSize=(110, 110))
            for (fx, fy, fw, fh) in faces:
                roi = gray[fy:fy + fh, fx:fx + fw]
                eyes = self.eyes.detectMultiScale(roi, 1.1, 6, minSize=(25, 25))
                if len(eyes) >= 2:
                    eyes = sorted(eyes, key=lambda e: e[2] * e[3], reverse=True)[:2]
                    c = sorted((fx + ex + ew / 2, fy + ey + eh / 2) for ex, ey, ew, eh in eyes)
                    roll = math.degrees(math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]))
                    out.append(Detection(roll, (fx + fw / 2) / W,
                                         [((fx + fw / 2) / W, (fy + fh / 2) / H)]))
        return out


# ====================================================================
#  Items / particles
# ====================================================================
class Item:
    __slots__ = ("x", "y", "vy", "kind", "sprite", "name", "seed", "sway", "dead")

    def __init__(self, x, vy, kind, sprite, name):
        self.x, self.y, self.vy = x, -0.06, vy
        self.kind, self.sprite, self.name = kind, sprite, name
        self.seed = random.uniform(0, 10)
        self.sway = random.uniform(1, 3)
        self.dead = False


class Particle:
    __slots__ = ("x", "y", "vx", "vy", "life", "color", "size")

    def __init__(self, x, y, color):
        a = random.uniform(0, math.tau)
        sp = random.uniform(60, 320)
        self.x, self.y = x, y
        self.vx, self.vy = math.cos(a) * sp, math.sin(a) * sp - 60
        self.life = random.uniform(0.5, 1.0)
        self.color = color
        self.size = random.uniform(2, 6)


# ====================================================================
#  Player — owns an arena (a horizontal slice of the screen)
# ====================================================================
class Player:
    def __init__(self, idx, x_lo, x_hi, sprites):
        self.idx = idx
        self.x_lo, self.x_hi = x_lo, x_hi
        self.cx = (x_lo + x_hi) / 2
        self.half = (x_hi - x_lo) / 2
        self.pal = PALETTES[idx]
        self.good_sprites = sprites["good"]
        self.rare_sprite = sprites["rare"]
        self.bad_sprites = sprites["bad"]
        self.lantern = sprites["lantern"]
        self.sfx = lambda *a, **k: None   # set by Game; plays catch sounds
        self.reset()

    def reset(self):
        self.px = self.cx
        self.roll_s = 0.0
        self.items = []
        self.particles = []
        self.score = 0
        self.combo = 1
        self.best_combo = 1
        self.combo_timer = 0.0
        self.spawn_timer = random.uniform(0, 0.4)
        self.glow = 0.0
        self.toast = ""
        self.toast_t = 0.0
        self.shake = 0.0
        self.center = 0.0
        self.calib_samples = []
        self.full_tilts = 0
        self.tilt_side = 0
        self.max_range = 0.0
        self.visible = False
        self.norm = 0.0

    def set_center(self):
        self.center = float(np.median(self.calib_samples)) if self.calib_samples else 0.0

    def _steer(self, raw_roll, visible, track_range=True):
        self.visible = visible
        if visible:
            rel = (raw_roll - self.center) * TILT_SIGN
            self.roll_s += (rel - self.roll_s) * SMOOTH
            if track_range:
                ad = abs(rel)
                if ad > self.max_range:
                    self.max_range = min(ad, 45)
        self.norm = max(-1.0, min(1.0, self.roll_s / FULL_TILT_DEG))
        self.px = self.cx + self.norm * self.half * 0.92

    def update_idle(self, raw_roll, visible):
        """Move the lantern only (used during the pre-round countdown)."""
        self._steer(raw_roll, visible, track_range=False)

    def _ai_steer(self, dt):
        """Auto-pilot for attract-mode demo: chase good icons, dodge voids."""
        targets = [it for it in self.items if it.kind != "bad" and it.y < 0.8]
        desired = self.cx
        if targets:
            tgt = min(targets, key=lambda it: 0.82 - it.y)   # closest to lantern
            desired = tgt.x
        for it in self.items:                                # swerve from voids
            if it.kind == "bad" and abs(it.x - self.px) < 0.07 and it.y > 0.5:
                desired = self.x_lo + 0.06 if self.px > self.cx else self.x_hi - 0.06
        desired = min(self.x_hi - 0.02, max(self.x_lo + 0.02, desired))
        self.px += (desired - self.px) * min(1.0, dt * 6.0)
        self.norm = max(-1.0, min(1.0, (self.px - self.cx) / (self.half * 0.92)))
        self.roll_s = self.norm * FULL_TILT_DEG

    def update_demo(self, dt, elapsed):
        self._ai_steer(dt)
        self._simulate(dt, elapsed)

    def update(self, dt, elapsed, raw_roll, visible):
        self._steer(raw_roll, visible)
        self._simulate(dt, elapsed)

    def _simulate(self, dt, elapsed):
        side = 1 if self.norm > 0.7 else (-1 if self.norm < -0.7 else 0)
        if side != 0 and side != self.tilt_side:
            self.full_tilts += 1
            self.tilt_side = side
        elif side == 0:
            self.tilt_side = 0

        difficulty = 1 + elapsed / 30.0
        self.spawn_timer -= dt
        if self.spawn_timer <= 0:
            self._spawn(elapsed, difficulty)
            self.spawn_timer = max(0.5, 1.05 / difficulty)

        if self.combo_timer > 0:
            self.combo_timer -= dt
            if self.combo_timer <= 0:
                self.combo = 1

        lx, ly = self.px * W, 0.82 * H
        for it in self.items:
            it.y += it.vy * dt
            it.x += math.sin((elapsed + it.seed) * it.sway) * 0.0006
            it.x = min(self.x_hi - 0.02, max(self.x_lo + 0.02, it.x))
            if math.hypot((it.x - self.px) * W, it.y * H - ly) < 70:
                self._collect(it)
                it.dead = True
            elif it.y > 1.12:
                if it.kind == "good" and self.combo > 1:
                    self.combo = 1
                    self.combo_timer = 0
                it.dead = True
        self.items = [i for i in self.items if not i.dead]

        for p in self.particles:
            p.x += p.vx * dt
            p.y += p.vy * dt
            p.vy += 520 * dt
            p.life -= dt
        self.particles = [p for p in self.particles if p.life > 0]

        if self.glow > 0:
            self.glow -= dt * 3
        if self.shake > 0:
            self.shake *= 0.85
            if self.shake < 0.4:
                self.shake = 0
        if self.toast_t > 0:
            self.toast_t -= dt

    def _spawn(self, elapsed, difficulty):
        x = random.uniform(self.x_lo + 0.04, self.x_hi - 0.04)
        vy = random.uniform(0.16, 0.22) * difficulty
        bad_chance = min(0.28, 0.1 + elapsed / 240)
        r = random.random()
        if r < bad_chance:
            self.items.append(Item(x, vy, "bad", random.choice(self.bad_sprites), ""))
        elif r < bad_chance + 0.05:
            self.items.append(Item(x, vy, "rare", self.rare_sprite, RARE[1]))
        else:
            spr, name = random.choice(self.good_sprites)
            self.items.append(Item(x, vy, "good", spr, name))

    def _collect(self, it):
        self.glow = 1.0
        cx, cy = it.x * W, it.y * H
        if it.kind == "bad":
            self.score = max(0, self.score - 3)
            self.combo = 1
            self.combo_timer = 0
            self.shake = 14
            self._burst(cx, cy, 22, MAGENTA)
            self._say("scrambled!")
            self.sfx("bad")
        else:
            val = 5 if it.kind == "rare" else 1
            self.combo = min(99, self.combo + 1)
            self.best_combo = max(self.best_combo, self.combo)
            self.combo_timer = 2.2
            self.score += val * max(1, self.combo // 3 + 1)
            self._burst(cx, cy, 40 if it.kind == "rare" else 16,
                        GOLD_BRIGHT if it.kind == "rare" else self.pal["good"])
            self._say(it.name if it.name else "")
            self.sfx("rare" if it.kind == "rare" else "good", self.combo)

    def _burst(self, x, y, n, color):
        for _ in range(n):
            self.particles.append(Particle(x, y, color))

    def step_particles(self, dt):
        for p in self.particles:
            p.x += p.vx * dt
            p.y += p.vy * dt
            p.vy += 520 * dt
            p.life -= dt
        self.particles = [p for p in self.particles if p.life > 0]

    def _say(self, text):
        if text:
            self.toast = text
            self.toast_t = 0.9


# ====================================================================
#  Game
# ====================================================================
def build_sprites(palette):
    return {
        "good": [(make_sprite(e, 84, palette["good"]), n) for e, n in GOOD],
        "rare": make_sprite(RARE[0], 92, GOLD_BRIGHT, 1.4),
        "bad": [make_sprite(e, 84, MAGENTA, 1.1) for e in BAD],
        "lantern": make_sprite(LANTERN, 110, palette["lantern"], 1.3),
    }


class Game:
    def __init__(self):
        self.bg = make_background()
        self.tracker = Tracker(max_faces=2)
        self.sprite_sets = [build_sprites(PALETTES[0]), build_sprites(PALETTES[1])]
        self.snd = Sound()
        self.stats = SessionStats(".tot_session.json")
        try:
            self.logo_big = load_logo(LOGO_PATH, 128)
            self.logo_small = load_logo(LOGO_PATH, 52)
        except Exception as e:
            print("FACTS-H logo not loaded:", e)
            self.logo_big = self.logo_small = None
        self.muted = False
        self.cd_last_beep = None
        self.best = self._load_best()
        self.mode = 1            # selected on the title screen
        self.players = []
        self.state = "title"
        self.time_left = ROUND_SECONDS
        self.over_msg = ""
        self.start_time = 0.0
        self.elapsed = 0.0
        self.calib_remaining = 0.0
        self.win_text = ""
        self.round_wins = [0, 0]   # duel: round wins per player
        self.round_num = 1
        self.round_result = ""     # banner for the just-finished round
        self.cd = 0.0              # pre-round countdown timer
        self.idle_t = 0.0          # seconds with no face present (attract mode)
        self.demo_elapsed = 0.0

    def _load_best(self):
        try:
            with open(".tot_best", "r") as f:
                return int(f.read().strip() or 0)
        except Exception:
            return 0

    def _save_best(self):
        try:
            with open(".tot_best", "w") as f:
                f.write(str(self.best))
        except Exception:
            pass

    def new_match(self, mode):
        """Start a fresh match (resets the best-of-3 tally)."""
        self.mode = mode
        self.round_wins = [0, 0]
        self.round_num = 1
        self.win_text = ""
        self._setup_round()

    def next_round(self):
        """Advance to the next round of the current duel match (keeps tally)."""
        self.round_num += 1
        self._setup_round()

    def start_demo(self):
        """Attract mode: a self-running AI demo to draw a crowd when idle."""
        self.demo_player = Player(0, 0.04, 0.96, self.sprite_sets[0])
        # demo is silent (no sfx) so the stall isn't constantly beeping
        self.players = [self.demo_player]
        self.demo_elapsed = 0.0
        self.idle_t = 0.0
        self.state = "demo"

    def to_title(self):
        self.players = []
        self.idle_t = 0.0
        self.state = "title"

    def _play_sfx(self, kind, combo=0):
        """Play a catch sound (respects mute). Called from Player._collect."""
        if self.muted:
            return
        if kind == "good":
            notes = self.snd.catch_notes
            if notes:
                self.snd.play(notes[min(len(notes) - 1, max(0, combo - 1))])
        elif kind == "rare":
            self.snd.play("rare")
        elif kind == "bad":
            self.snd.play("bad")

    def _setup_round(self):
        if self.mode == 2:
            self.players = [
                Player(0, 0.0, 0.49, self.sprite_sets[0]),
                Player(1, 0.51, 1.0, self.sprite_sets[1]),
            ]
        else:
            self.players = [Player(0, 0.04, 0.96, self.sprite_sets[0])]
        for p in self.players:
            p.sfx = self._play_sfx
        self.elapsed = 0.0
        self.time_left = ROUND_SECONDS
        self.over_msg = ""
        self.round_result = ""
        self.calib_remaining = 2.0
        self.state = "calib"

    # --- assign each detected face to a player by which arena it sits in ---
    def _assign(self, detections):
        assigned = [None] * len(self.players)
        if self.mode == 1:
            if detections:
                assigned[0] = max(detections, key=lambda d: 1)  # the (single) face
                # prefer the largest/most central if several
                assigned[0] = min(detections, key=lambda d: abs(d.cx - 0.5))
        else:
            left = [d for d in detections if d.cx < 0.5]
            right = [d for d in detections if d.cx >= 0.5]
            if left:
                assigned[0] = min(left, key=lambda d: abs(d.cx - 0.25))
            if right:
                assigned[1] = min(right, key=lambda d: abs(d.cx - 0.75))
        return assigned

    def update(self, dt, detections):
        if self.state == "demo":
            self.demo_elapsed += dt
            self.players[0].update_demo(dt, min(self.demo_elapsed, 24.0))
            return

        assigned = self._assign(detections)
        if self.state == "calib":
            for p, det in zip(self.players, assigned):
                if det is not None:
                    p.visible = True
                    p.calib_samples.append(det.roll)
                else:
                    p.visible = False
            self.calib_remaining -= dt
            if self.calib_remaining <= 0:
                for p in self.players:
                    p.set_center()
                self.cd = 3.0
                self.cd_last_beep = None
                self.state = "countdown"
            return

        if self.state == "countdown":
            for p, det in zip(self.players, assigned):
                p.update_idle(det.roll if det else 0.0, det is not None)
            # beep once each time the displayed value changes (3,2,1,GO)
            cur = int(math.ceil(self.cd)) if self.cd > 0 else 0
            if cur != self.cd_last_beep:
                self.cd_last_beep = cur
                if not self.muted:
                    self.snd.play({3: "beep3", 2: "beep2", 1: "beep1"}.get(cur, "go"))
            self.cd -= dt
            if self.cd <= -0.5:          # 3..2..1..GO!, then play
                self.start_time = time.time()
                self.state = "play"
            return

        if self.state == "play":
            self.elapsed += dt
            self.time_left = ROUND_SECONDS - (time.time() - self.start_time)
            for p, det in zip(self.players, assigned):
                p.update(dt, self.elapsed,
                         det.roll if det else 0.0, det is not None)
            if self.time_left <= 0:
                self._finish()
            return

        if self.state in ("over", "round_over"):
            for p in self.players:
                p.step_particles(dt)

    def _finish(self):
        top = max(p.score for p in self.players)
        if top > self.best:
            self.best = top
            self._save_best()
        if self.mode == 2:
            a, b = self.players[0].score, self.players[1].score
            if a == b:
                self.round_result = f"Round {self.round_num}: draw - replay"
                winner = None
            else:
                winner = 0 if a > b else 1
                self.round_wins[winner] += 1
                self.round_result = f"Round {self.round_num}: {PALETTES[winner]['name']} takes it"
            if max(self.round_wins) >= WINS_NEEDED:
                champ = 0 if self.round_wins[0] > self.round_wins[1] else 1
                self.win_text = f"{PALETTES[champ]['name']} WINS THE MATCH!"
                self.state = "over"
                burst_players = self.players
            else:
                self.state = "round_over"
                # celebrate the round winner (or everyone on a draw)
                burst_players = self.players if winner is None else [self.players[winner]]
        else:
            self.over_msg = solo_message(self.players[0], self.best)
            self.state = "over"
            burst_players = self.players
        for p in burst_players:
            p._burst(p.cx * W, H * 0.4, 50, p.pal["good"])

        # session stats: every finished round counts its player(s)
        for p in self.players:
            self.stats.add_player(p)
        self.stats.add_round()
        if self.mode == 2 and self.state == "over":   # a duel match concluded
            self.stats.add_match()
        self.stats.save()

    # ---- rendering ----
    def render(self, frame_bgr):
        img = self.bg.copy()
        if self.state in ("play", "over", "round_over", "countdown", "demo"):
            if self.mode == 2 and self.state != "demo":
                self._divider(img)
            for p in self.players:
                self._render_player(img, p)
        if self.state in ("calib", "play", "countdown"):
            self._draw_preview(img, frame_bgr)
        return img

    def _divider(self, img):
        x = W // 2
        cv2.line(img, (x, 0), (x, H), (90, 70, 120), 2, cv2.LINE_AA)
        for gy in range(0, H, 24):
            cv2.circle(img, (x, gy), 1, GOLD, -1)

    def _render_player(self, img, p):
        ox = oy = 0
        if p.shake > 0:
            ox = int(random.uniform(-p.shake, p.shake))
            oy = int(random.uniform(-p.shake, p.shake))
        for it in p.items:
            blit(img, it.sprite, it.x * W + ox, it.y * H + oy)
        for pa in p.particles:
            a = max(0.0, min(1.0, pa.life))
            cv2.circle(img, (int(pa.x + ox), int(pa.y + oy)), int(pa.size),
                       tuple(int(c * a) for c in pa.color), -1, cv2.LINE_AA)
        lx, ly = int(p.px * W + ox), int(0.82 * H + oy)
        self._light_pool(img, lx, ly, 120, p.pal["lantern"], 0.5 + p.glow * 0.4)
        blit(img, p.lantern, lx, ly)

    def _light_pool(self, img, cx, cy, r, color, strength):
        x0, y0 = max(0, cx - r), max(0, cy - r)
        x1, y1 = min(W, cx + r), min(H, cy + r)
        if x0 >= x1 or y0 >= y1:
            return
        yy, xx = np.mgrid[y0:y1, x0:x1]
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        m = np.clip(1 - d / r, 0, 1)[:, :, None] * strength
        roi = img[y0:y1, x0:x1].astype(np.float32)
        col = np.array(color, np.float32)
        img[y0:y1, x0:x1] = np.clip(roi + (col - roi) * m * 0.8, 0, 255).astype(np.uint8)

    def _draw_preview(self, img, frame_bgr):
        pw, ph = (220, 124) if self.mode == 2 else (200, 150)
        small = cv2.resize(frame_bgr, (pw, ph))
        if self.state in ("play", "calib"):
            for pts in self.tracker_last_points:
                for (nx, ny) in pts:
                    cv2.circle(small, (int(nx * pw), int(ny * ph)), 1, CYAN, -1)
        if self.mode == 2:
            # top-centre, below the TIME box, clear of both score corners
            x0, y0 = W // 2 - pw // 2, 92
        else:
            x0, y0 = W - pw - 18, H - ph - 18
        img[y0:y0 + ph, x0:x0 + pw] = small
        cv2.rectangle(img, (x0, y0), (x0 + pw, y0 + ph), GOLD, 2)
        put_text(img, "YOU", (x0 + 8, y0 + 22), 0.6, GOLD_BRIGHT, 1)

    tracker_last_points = []


# ====================================================================
#  Screens / HUD
# ====================================================================
def draw_title(img, g):
    put_text(img, "TILT OF TIME", (W // 2, int(H * 0.22)), 2.4, GOLD_BRIGHT, 4, center=True)
    put_text(img, "Bend your neck. Gather the threads of human culture.",
             (W // 2, int(H * 0.31)), 0.85, INK, 1, center=True)
    # mode cards
    solo_col = CYAN if g.mode == 1 else (150, 150, 160)
    duel_col = ORANGE if g.mode == 2 else (150, 150, 160)
    put_text(img, "[ 1 ]  SOLO", (W // 2 - 240, int(H * 0.46)), 1.3, solo_col, 2, center=True)
    put_text(img, "one player, full screen", (W // 2 - 240, int(H * 0.52)), 0.6, INK, 1, center=True, glow=False)
    put_text(img, "[ 2 ]  DUEL", (W // 2 + 240, int(H * 0.46)), 1.3, duel_col, 2, center=True)
    put_text(img, "two players, split screen race", (W // 2 + 240, int(H * 0.52)), 0.6, INK, 1, center=True, glow=False)

    lines = [
        "Tilt your head LEFT & RIGHT to glide your lantern",
        "Catch culture icons & build combos  -  dodge the glitch-voids",
    ]
    for i, t in enumerate(lines):
        put_text(img, t, (W // 2, int(H * 0.63) + i * 36), 0.75, INK, 1, center=True)

    sel = "SOLO" if g.mode == 1 else "DUEL"
    put_text(img, f"Press 1 or 2 to choose,  SPACE to start  ({sel})",
             (W // 2, int(H * 0.78)), 1.0, GOLD, 2, center=True)
    sub = f"Stall high score: {g.best} threads" if g.best else ""
    put_text(img, sub, (W // 2, int(H * 0.85)), 0.7, GOLD, 1, center=True)
    put_text(img, "S session stats   F fullscreen   M mute   ESC quit",
             (W // 2, int(H * 0.93)), 0.6, (160, 160, 170), 1, center=True)


def draw_logo(img, g):
    """FACTS-H Lab brand mark — large top-left on menus, small bottom-left in play."""
    if g.state in ("title", "demo", "stats", "over", "round_over"):
        spr = g.logo_big
        if spr is not None:
            sh, sw = spr.shape[:2]
            blit(img, spr, 26 + sw // 2, 26 + sh // 2)
            put_text(img, "FACTS-H Lab", (26 + sw // 2, 26 + sh + 14),
                     0.5, (200, 200, 210), 1, center=True, glow=False)
    elif g.state in ("play", "countdown"):
        spr = g.logo_small
        if spr is not None:
            sh, sw = spr.shape[:2]
            blit(img, spr, 16 + sw // 2, H - 80)  # sits just above the tilt meter


def draw_stats(img, g):
    """End-of-day session totals for the stall."""
    d = g.stats.data
    put_text(img, "SESSION STATS", (W // 2, int(H * 0.13)), 1.8, GOLD_BRIGHT, 3, center=True)
    put_text(img, str(d["date"]), (W // 2, int(H * 0.20)), 0.7, (190, 190, 200), 1, center=True, glow=False)

    tiles = [
        ("Plays", str(d["plays"]), CYAN),
        ("Threads woven", str(d["threads"]), GOLD_BRIGHT),
        ("Total tilts", str(d["tilts"]), ORANGE),
        ("Avg neck range", f"{int(round(g.stats.avg_range))} deg", CYAN),
        ("Duel matches", str(d["matches"]), ORANGE),
        ("Best score", str(d["best"]), GOLD_BRIGHT),
    ]
    for i, (lbl, val, col) in enumerate(tiles):
        cx = W // 2 + (i % 3 - 1) * 320
        cy = int(H * 0.37) + (i // 3) * int(H * 0.20)
        put_text(img, val, (cx, cy), 1.8, col, 3, center=True)
        put_text(img, lbl, (cx, cy + 36), 0.6, (190, 190, 200), 1, center=True, glow=False)

    top = d["top"]
    if top:
        line = "TOP SCORES   " + "    ".join(f"{i + 1}. {s}" for i, s in enumerate(top))
        put_text(img, line, (W // 2, int(H * 0.80)), 0.7, GOLD, 1, center=True)
    put_text(img, "SPACE  back        R  reset session        ESC  quit",
             (W // 2, int(H * 0.91)), 0.85, GOLD_BRIGHT, 2, center=True)


def draw_demo(img, g):
    """Overlay for the self-running attract-mode demo."""
    put_text(img, "TILT OF TIME", (W // 2, int(H * 0.16)), 1.9, GOLD_BRIGHT, 3, center=True)
    put_text(img, "a neck-mobility game - tilt your head to play",
             (W // 2, int(H * 0.24)), 0.8, INK, 1, center=True)
    put_text(img, "DEMO", (W // 2, int(H * 0.31)), 0.6, (180, 180, 190), 1, center=True, glow=False)
    pulse = 0.5 + 0.5 * math.sin(g.demo_elapsed * 3.0)
    scale = 1.05 + 0.18 * pulse
    put_text(img, "STEP UP  -  PRESS SPACE TO PLAY",
             (W // 2, int(H * 0.85)), scale, GOLD_BRIGHT, 2, center=True)


def draw_calib(img, g):
    title = "Find your range" if g.mode == 1 else "Both players: find your range"
    put_text(img, title, (W // 2, int(H * 0.34)), 1.5, GOLD_BRIGHT, 3, center=True)
    put_text(img, "Sit tall, look straight ahead, breathe...",
             (W // 2, int(H * 0.44)), 0.95, INK, 1, center=True)
    bw, bh = 460, 16
    x0, y0 = W // 2 - bw // 2, int(H * 0.54)
    cv2.rectangle(img, (x0, y0), (x0 + bw, y0 + bh), (90, 70, 60), 1)
    p = 1 - max(0.0, g.calib_remaining) / 2.0
    cv2.rectangle(img, (x0, y0), (x0 + int(bw * p), y0 + bh), CYAN, -1)
    # per-player readiness
    for i, pl in enumerate(g.players):
        cx = W // 2 + (i - (len(g.players) - 1) / 2) * 280
        col = pl.pal["accent"] if pl.visible else (120, 120, 130)
        msg = "ready" if pl.visible else "show your face"
        put_text(img, f"{pl.pal['name']}: {msg}", (int(cx), int(H * 0.66)),
                 0.7, col, 2, center=True)


def _hud_box(img, cx, label, value, col):
    put_text(img, label, (cx, 36), 0.55, (200, 200, 210), 1, center=True, glow=False)
    put_text(img, value, (cx, 74), 1.2, col, 2, center=True)


def _match_pips(img, cx, y, wins, color):
    """Draw WINS_NEEDED pips, filled for rounds won."""
    span = (WINS_NEEDED - 1) * 24
    for i in range(WINS_NEEDED):
        x = int(cx - span / 2 + i * 24)
        if i < wins:
            cv2.circle(img, (x, y), 7, color, -1, cv2.LINE_AA)
        else:
            cv2.circle(img, (x, y), 7, (120, 120, 130), 1, cv2.LINE_AA)


def draw_hud(img, g):
    if g.mode == 1:
        p = g.players[0]
        _hud_box(img, W // 2 - 220, "SCORE", str(p.score), GOLD_BRIGHT)
        tcol = MAGENTA if g.time_left <= 10 else CYAN
        _hud_box(img, W // 2, "TIME", str(max(0, int(math.ceil(g.time_left)))), tcol)
        _hud_box(img, W // 2 + 220, "COMBO", f"x{p.combo}", GOLD_BRIGHT)
        _tilt_meter(img, p, W // 2)
        _toast(img, p, W // 2)
    else:
        p1, p2 = g.players
        _hud_box(img, int(W * 0.16), "P1 SCORE", str(p1.score), p1.pal["accent"])
        _hud_box(img, int(W * 0.16) + 170, "COMBO", f"x{p1.combo}", GOLD_BRIGHT)
        _hud_box(img, int(W * 0.84), "P2 SCORE", str(p2.score), p2.pal["accent"])
        _hud_box(img, int(W * 0.84) - 170, "COMBO", f"x{p2.combo}", GOLD_BRIGHT)
        tcol = MAGENTA if g.time_left <= 10 else GOLD_BRIGHT
        _hud_box(img, W // 2, "TIME", str(max(0, int(math.ceil(g.time_left)))), tcol)
        _match_pips(img, int(W * 0.16), 98, g.round_wins[0], p1.pal["accent"])
        _match_pips(img, int(W * 0.84), 98, g.round_wins[1], p2.pal["accent"])
        put_text(img, f"ROUND {g.round_num}  -  best of 3", (W // 2, H - 12),
                 0.55, (190, 190, 200), 1, center=True, glow=False)
        _tilt_meter(img, p1, int(W * 0.25), width=int(W * 0.42))
        _tilt_meter(img, p2, int(W * 0.75), width=int(W * 0.42))
        _toast(img, p1, int(W * 0.25))
        _toast(img, p2, int(W * 0.75))

    for p in g.players:
        if not p.visible:
            put_text(img, "show your face", (int(p.cx * W), int(H * 0.5)),
                     0.8, MAGENTA, 2, center=True)


def _tilt_meter(img, p, cx, width=620):
    bw, bh = width, 14
    x0 = cx - bw // 2
    y0 = H - 46
    cv2.rectangle(img, (x0, y0), (x0 + bw, y0 + bh), (60, 50, 70), 1)
    cv2.line(img, (cx, y0 - 3), (cx, y0 + bh + 3), (120, 120, 140), 1)
    nx = int(cx + p.norm * (bw // 2 - 6))
    cv2.rectangle(img, (nx - 4, y0 - 5), (nx + 4, y0 + bh + 5), p.pal["accent"], -1)


def _toast(img, p, cx):
    if p.toast_t > 0 and p.toast:
        put_text(img, p.toast, (cx, int(H * 0.4)), 1.0, GOLD_BRIGHT, 2, center=True)


def draw_over(img, g):
    if g.mode == 1:
        p = g.players[0]
        put_text(img, "Round Complete", (W // 2, int(H * 0.18)), 1.5, GOLD_BRIGHT, 3, center=True)
        put_text(img, str(p.score), (W // 2, int(H * 0.38)), 4.2, GOLD_BRIGHT, 6, center=True)
        put_text(img, "threads woven", (W // 2, int(H * 0.48)), 0.8, (200, 200, 210), 1, center=True)
        stats = [(f"{int(round(p.max_range))} deg", "neck range"),
                 (f"x{p.best_combo}", "best combo"),
                 (str(p.full_tilts), "full tilts")]
        for i, (num, lbl) in enumerate(stats):
            cx = W // 2 + (i - 1) * 230
            put_text(img, num, (cx, int(H * 0.60)), 1.3, CYAN, 2, center=True)
            put_text(img, lbl, (cx, int(H * 0.66)), 0.6, (190, 190, 200), 1, center=True, glow=False)
        put_text(img, g.over_msg, (W // 2, int(H * 0.78)), 0.85, GOLD, 1, center=True)
    else:
        p1, p2 = g.players
        win_col = GOLD_BRIGHT
        if "PLAYER 1" in g.win_text:
            win_col = p1.pal["accent"]
        elif "PLAYER 2" in g.win_text:
            win_col = p2.pal["accent"]
        put_text(img, g.win_text, (W // 2, int(H * 0.18)), 2.0, win_col, 4, center=True)
        put_text(img, f"Match  {g.round_wins[0]} - {g.round_wins[1]}  (best of 3)",
                 (W // 2, int(H * 0.27)), 0.85, GOLD, 1, center=True)
        for p, side in ((p1, 0.27), (p2, 0.73)):
            put_text(img, p.pal["name"], (int(W * side), int(H * 0.40)), 1.0, p.pal["accent"], 2, center=True)
            put_text(img, str(p.score), (int(W * side), int(H * 0.54)), 3.0, GOLD_BRIGHT, 5, center=True)
            put_text(img, f"best combo x{p.best_combo}   neck {int(round(p.max_range))} deg",
                     (int(W * side), int(H * 0.62)), 0.6, (200, 200, 210), 1, center=True, glow=False)
        cv2.line(img, (W // 2, int(H * 0.34)), (W // 2, int(H * 0.66)), (90, 70, 120), 1)
    put_text(img, "SPACE  play again      1/2  change mode      ESC  quit",
             (W // 2, int(H * 0.92)), 0.9, GOLD_BRIGHT, 2, center=True)


def draw_round_over(img, g):
    """Intermediate duel screen between rounds of a best-of-3 match."""
    p1, p2 = g.players
    res_col = GOLD_BRIGHT
    if "PLAYER 1" in g.round_result:
        res_col = p1.pal["accent"]
    elif "PLAYER 2" in g.round_result:
        res_col = p2.pal["accent"]
    put_text(img, g.round_result, (W // 2, int(H * 0.20)), 1.6, res_col, 3, center=True)

    # match tally with pips
    put_text(img, "MATCH", (W // 2, int(H * 0.32)), 0.7, (200, 200, 210), 1, center=True, glow=False)
    _match_pips(img, int(W * 0.42), int(H * 0.32) + 4, g.round_wins[0], p1.pal["accent"])
    _match_pips(img, int(W * 0.58), int(H * 0.32) + 4, g.round_wins[1], p2.pal["accent"])

    for p, side in ((p1, 0.27), (p2, 0.73)):
        put_text(img, p.pal["name"], (int(W * side), int(H * 0.46)), 0.9, p.pal["accent"], 2, center=True)
        put_text(img, str(p.score), (int(W * side), int(H * 0.58)), 2.6, GOLD_BRIGHT, 4, center=True)
    cv2.line(img, (W // 2, int(H * 0.40)), (W // 2, int(H * 0.64)), (90, 70, 120), 1)

    need = WINS_NEEDED
    status = f"First to {need} wins the match"
    put_text(img, status, (W // 2, int(H * 0.74)), 0.7, GOLD, 1, center=True)
    put_text(img, "SPACE  next round      1/2  quit to menu      ESC  quit",
             (W // 2, int(H * 0.88)), 0.9, GOLD_BRIGHT, 2, center=True)


def draw_countdown(img, g):
    if g.mode == 2:
        p1, p2 = g.players
        yr = int(H * 0.34)                     # below the top-centre preview box
        put_text(img, f"ROUND {g.round_num}", (W // 2, yr), 1.3, GOLD, 2, center=True)
        _match_pips(img, int(W * 0.40), yr + 4, g.round_wins[0], p1.pal["accent"])
        _match_pips(img, int(W * 0.60), yr + 4, g.round_wins[1], p2.pal["accent"])
    if g.cd > 0:
        n = int(math.ceil(g.cd))
        pulse = g.cd - math.floor(g.cd)        # 1 -> 0 across each second
        scale = 4.5 + pulse * 2.5              # pops big, then settles
        put_text(img, str(n), (W // 2, int(H * 0.55)), scale, GOLD_BRIGHT, 8, center=True)
    else:
        put_text(img, "GO!", (W // 2, int(H * 0.55)), 6.5, CYAN, 10, center=True)
    put_text(img, "tilt your head to move your lantern",
             (W // 2, int(H * 0.74)), 0.7, (200, 200, 210), 1, center=True, glow=False)


def solo_message(p, best):
    s = p.score
    if s >= 80:
        m = "Maestro of motion - culture flows through your spine!"
    elif s >= 50:
        m = "Wonderful range and rhythm. Your neck is dancing."
    elif s >= 25:
        m = "Lovely work - limber and curious."
    else:
        m = "A gentle start. Every tilt counts toward a happier neck."
    if s >= best and best > 0:
        m += "   New stall high score!"
    return m


# ====================================================================
#  Main loop
# ====================================================================
def main():
    cap = cv2.VideoCapture(0)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    if not cap.isOpened():
        print("ERROR: could not open the webcam. Close other camera apps (Zoom/"
              "Photo Booth/FaceTime) and try again. On macOS you may also run:\n"
              "  sudo killall VDCAssistant AppleCameraAssistant")
        sys.exit(1)

    g = Game()
    print(f"[Tilt of Time] tracker = {g.tracker.mode}  (mediapipe present: {_HAVE_MP})")

    cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WIN, W, H)
    fullscreen = False
    last = time.time()

    while True:
        ok, frame = cap.read()
        if not ok:
            continue
        frame = cv2.flip(frame, 1)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        detections = g.tracker.detect(rgb)
        g.tracker_last_points = [d.points for d in detections]

        now = time.time()
        dt = min(0.05, now - last)
        last = now

        # idle tracking for attract mode
        face_present = len(detections) > 0
        if face_present:
            g.idle_t = 0.0
        else:
            g.idle_t += dt

        if g.state in ("calib", "countdown", "play", "over", "round_over", "demo"):
            g.update(dt, detections)

        # attract-mode flow: idle title -> demo; someone steps up -> back to title
        if g.state == "title" and g.idle_t > 6.0:
            g.start_demo()
        elif g.state == "demo" and face_present:
            g.to_title()
        elif g.state in ("over", "round_over") and g.idle_t > 20.0:
            g.to_title()

        # soft ambient bed only while actually playing (and not muted)
        if g.state == "play" and not g.muted:
            g.snd.start_ambient()
        else:
            g.snd.stop_ambient()

        img = g.render(frame)
        if g.state == "title":
            draw_title(img, g)
        elif g.state == "stats":
            draw_stats(img, g)
        elif g.state == "demo":
            draw_demo(img, g)
        elif g.state == "calib":
            draw_calib(img, g)
        elif g.state == "countdown":
            draw_countdown(img, g)
        elif g.state == "play":
            draw_hud(img, g)
        elif g.state == "round_over":
            draw_round_over(img, g)
        elif g.state == "over":
            draw_over(img, g)

        draw_logo(img, g)
        cv2.imshow(WIN, img)

        k = cv2.waitKey(1) & 0xFF
        if k != 255:
            g.idle_t = 0.0          # any key press counts as activity
        if k in (27, ord('q')):
            break
        elif k == ord('1'):
            g.mode = 1
            if g.state in ("over", "round_over", "demo"):
                g.to_title()
        elif k == ord('2'):
            g.mode = 2
            if g.state in ("over", "round_over", "demo"):
                g.to_title()
        elif k in (32, 13):
            if g.state == "stats":
                g.to_title()
            elif g.state in ("title", "over", "demo"):
                g.new_match(g.mode)
            elif g.state == "round_over":
                g.next_round()
        elif k in (ord('s'), ord('S')):
            if g.state == "stats":
                g.to_title()
            elif g.state in ("title", "over", "round_over", "demo"):
                g.state = "stats"
        elif k in (ord('r'), ord('R')):
            if g.state == "stats":
                g.stats.reset()
        elif k in (ord('f'), ord('F')):
            fullscreen = not fullscreen
            cv2.setWindowProperty(WIN, cv2.WND_PROP_FULLSCREEN,
                                  cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL)
        elif k in (ord('m'), ord('M')):
            g.muted = not g.muted

        if cv2.getWindowProperty(WIN, cv2.WND_PROP_VISIBLE) < 1:
            break

    g.snd.stop_ambient()
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
