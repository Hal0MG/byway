// Sounds: soft interface sounds (hover, click, open, close) and ambient music on the globe, all made in the browser
// with Web Audio, so there are no audio files and nothing to license. Settings per device (localStorage "sound"):
// effects and music on or off, each with its own volume. Browsers only allow sound after the first click or key
// press, so nothing plays before that.

const SOUND_DEFAULTS = { fx: true, fxVol: 0.5, music: true, musicVol: 0.35 };
let soundPrefs = (() => {
  try {
    return { ...SOUND_DEFAULTS, ...JSON.parse(localStorage.getItem("sound") || "{}") };
  } catch {
    return { ...SOUND_DEFAULTS };
  }
})();
function setSoundPrefs(p) {
  soundPrefs = { ...soundPrefs, ...p };
  try {
    localStorage.setItem("sound", JSON.stringify(soundPrefs));
  } catch {}
  if (audio) {
    audio.fx.gain.setTargetAtTime(soundPrefs.fx ? soundPrefs.fxVol : 0, audio.ctx.currentTime, 0.05);
    audio.musicBus.gain.setTargetAtTime(soundPrefs.music ? soundPrefs.musicVol : 0, audio.ctx.currentTime, 0.3);
  }
  musicWanted();
}

let audio = null; // { ctx, fx, musicBus, reverb } once the first gesture has happened
function audioReady() {
  if (audio) return audio;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -18;
  master.ratio.value = 3;
  master.connect(ctx.destination);
  // a soft room: two seconds of decaying noise as the impulse response
  const reverb = ctx.createConvolver();
  const len = Math.round(ctx.sampleRate * 2.6);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2;
  }
  reverb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  reverb.connect(wet).connect(master);
  const fx = ctx.createGain();
  fx.gain.value = soundPrefs.fx ? soundPrefs.fxVol : 0;
  fx.connect(master);
  const fxSend = ctx.createGain();
  fxSend.gain.value = 0.25;
  fx.connect(fxSend).connect(reverb);
  const musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(master);
  const musicSend = ctx.createGain();
  musicSend.gain.value = 0.9;
  musicBus.connect(musicSend).connect(reverb);
  audio = { ctx, fx, musicBus, reverb };
  return audio;
}

// One soft voice: a sine (plus an optional bell partial) with a quick attack and an exponential fade.
function tone(out, freq, { at = 0, dur = 0.25, vol = 0.2, type = "sine", partial = 0, glide = 0 } = {}) {
  const { ctx } = audio;
  const t = ctx.currentTime + at;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(out);
  const voices = [[freq, 1], ...(partial ? [[freq * partial, 0.25]] : [])];
  for (const [f, level] of voices) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(f * glide, t + dur);
    const lg = ctx.createGain();
    lg.gain.value = level;
    o.connect(lg).connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}
// A breath of filtered noise (sheets opening and closing).
function whoosh(out, { up = true, dur = 0.32, vol = 0.12 } = {}) {
  const { ctx } = audio;
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(up ? 500 : 2400, t);
  bp.frequency.exponentialRampToValueAtTime(up ? 2400 : 500, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(out);
  src.start(t);
}

// The interface sounds, quiet and short, in the spirit of a console's home menu.
const SFX = {
  hover: (o) => tone(o, 2093, { dur: 0.06, vol: 0.05, partial: 1.5 }),
  click: (o) => {
    tone(o, 1046.5, { dur: 0.22, vol: 0.12, partial: 2.76 });
    tone(o, 1568, { at: 0.035, dur: 0.18, vol: 0.06 });
  },
  toggle: (o) => tone(o, 1318.5, { dur: 0.14, vol: 0.1, partial: 2 }),
  open: (o) => {
    whoosh(o, { up: true });
    tone(o, 784, { at: 0.05, dur: 0.35, vol: 0.06, partial: 2 });
  },
  close: (o) => {
    whoosh(o, { up: false, dur: 0.25, vol: 0.08 });
    tone(o, 659, { dur: 0.2, vol: 0.05, glide: 0.8 });
  },
  done: (o) => [784, 988, 1175, 1568].forEach((f, i) => tone(o, f, { at: i * 0.07, dur: 0.6, vol: 0.07, partial: 2 })),
  error: (o) => tone(o, 311, { dur: 0.3, vol: 0.1, type: "triangle", glide: 0.85 }),
};
let lastSfx = 0;
function sfx(name) {
  if (!soundPrefs.fx || !audio || audio.ctx.state !== "running") return;
  const now = performance.now();
  if (name === "hover" && now - lastSfx < 45) return; // a sweep across a row of buttons isn't a drum roll
  lastSfx = now;
  SFX[name]?.(audio.fx);
}

// ---------- ambient music for the globe ----------
// Slow chords on soft detuned pads through a gently moving filter, a low root, and now and then a bell note from the
// chord's scale with an echo. Generated as it plays, so it never loops the same way.
const CHORDS = [
  [48, [0, 7, 11, 14, 16]], // Cmaj9
  [45, [0, 7, 10, 14, 15]], // Am9
  [41, [0, 7, 11, 14, 16]], // Fmaj9
  [43, [0, 7, 9, 14, 16]], // G6/9
];
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
const music = { on: false, timer: null, step: 0, sparkle: null, nodes: new Set() };
function padChord(root, intervals, at, dur) {
  const { ctx, musicBus } = audio;
  const t = ctx.currentTime + at;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(600, t);
  filter.frequency.linearRampToValueAtTime(1500, t + dur * 0.5);
  filter.frequency.linearRampToValueAtTime(700, t + dur + 3);
  filter.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.07, t + 3);
  g.gain.setValueAtTime(0.07, t + dur);
  g.gain.linearRampToValueAtTime(0.0001, t + dur + 3.5);
  filter.connect(g).connect(musicBus);
  const notes = [root - 12, ...intervals.map((i) => root + 12 + i)];
  for (const [k, n] of notes.entries()) {
    for (const det of k === 0 ? [0] : [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = k === 0 ? "sine" : "triangle";
      o.frequency.value = midiHz(n);
      o.detune.value = det;
      const lg = ctx.createGain();
      lg.gain.value = k === 0 ? 0.9 : 0.22;
      o.connect(lg).connect(filter);
      o.start(t);
      o.stop(t + dur + 4);
      music.nodes.add(o);
      o.onended = () => music.nodes.delete(o);
    }
  }
}
function sparkle(root, intervals) {
  const { ctx, musicBus } = audio;
  const pick = intervals[Math.floor(Math.random() * intervals.length)];
  const n = root + 24 + pick + (Math.random() < 0.3 ? 12 : 0);
  const echo = ctx.createDelay(1);
  echo.delayTime.value = 0.42;
  const fb = ctx.createGain();
  fb.gain.value = 0.38;
  echo.connect(fb).connect(echo);
  const g = ctx.createGain();
  g.gain.value = 0.5;
  g.connect(musicBus);
  g.connect(echo);
  echo.connect(musicBus);
  tone(g, midiHz(n), { dur: 2.4, vol: 0.05, partial: 3 });
}
function musicTick() {
  if (!music.on) return;
  const [root, iv] = CHORDS[music.step % CHORDS.length];
  padChord(root, iv, 0.05, 9);
  music.step++;
  clearInterval(music.sparkle);
  music.sparkle = setInterval(() => Math.random() < 0.55 && sparkle(root, iv), 1400);
  music.timer = setTimeout(musicTick, 9000);
}
function musicStart() {
  if (music.on || !audioReady()) return;
  music.on = true;
  audio.musicBus.gain.cancelScheduledValues(audio.ctx.currentTime);
  audio.musicBus.gain.setTargetAtTime(soundPrefs.musicVol, audio.ctx.currentTime, 1.2);
  musicTick();
}
function musicStop() {
  if (!music.on) return;
  music.on = false;
  clearTimeout(music.timer);
  clearInterval(music.sparkle);
  if (!audio) return;
  const t = audio.ctx.currentTime;
  audio.musicBus.gain.cancelScheduledValues(t);
  audio.musicBus.gain.setTargetAtTime(0, t, 0.6);
  // the pads already scheduled fade out with the bus, then stop
  setTimeout(() => {
    if (music.on) return;
    for (const o of music.nodes) o.stop();
    music.nodes.clear();
  }, 3000);
}
// Music plays on the globe (and the welcome screen) when it's switched on and the page is visible.
function musicWanted() {
  const want = soundPrefs.music && !document.hidden && audio?.ctx.state === "running" &&
    (document.body.dataset.view === "home" || !!document.getElementById("welcome"));
  if (want) musicStart();
  else musicStop();
}

// ---------- wiring ----------
// The first gesture unlocks audio. Hover sounds only with a real mouse (not taps), on things you can press.
const PRESSABLE = 'button, a[href], [role="button"], [role="tab"], [role="radio"], summary, select, label.chip, .chip, [data-act]';
function unlockAudio() {
  const a = audioReady();
  if (!a) return;
  if (a.ctx.state !== "running") a.ctx.resume().then(musicWanted);
  else musicWanted();
}
addEventListener("pointerdown", unlockAudio, { capture: true });
addEventListener("keydown", unlockAudio, { capture: true });
document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const el = e.target.closest?.(PRESSABLE);
  if (!el || el.disabled || el.contains(e.relatedTarget)) return;
  sfx("hover");
});
document.addEventListener("click", (e) => {
  const el = e.target.closest?.(PRESSABLE);
  if (!el || el.disabled) return;
  // pressing a switch or radio gets the lighter toggle sound
  sfx(el.matches('[role="radio"], [role="tab"], [aria-pressed], .chip') ? "toggle" : "click");
}, { capture: true });
document.addEventListener("visibilitychange", () => {
  if (!audio) return;
  if (document.hidden) {
    musicStop();
    audio.ctx.suspend();
  } else audio.ctx.resume().then(musicWanted);
});
new MutationObserver(musicWanted).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
