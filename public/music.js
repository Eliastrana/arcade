// Chiptune music for Slagbrødrene, played with the browser's own synthesiser (no audio files).
// Two original tracks in an old-console adventure style:
//   "title"  - a heroic, marching fanfare for the title screen and the lobby (A minor, 116 bpm, light drums)
//   "battle" - an all-out action fight tune for the match (D minor, 174 bpm): galloping bass, power-chord stabs,
//              doubled lead, drum fills and cymbal crashes
// Voices: pulse waves (lead, thickening layer, arpeggio, chord stabs), a triangle bass, and noise and sines for drums.

const SEMITONE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const FLATS = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
const midi = name => {
  const m = /^([A-G][#b]?)(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[2]) + 1) + SEMITONE[FLATS[m[1]] || m[1]];
};
const hz = name => 440 * 2 ** ((midi(name) - 69) / 12);
const transpose = (name, semitones) => {
  const n = midi(name) + semitones;
  const names = Object.keys(SEMITONE);
  return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
};

const STEPS_PER_BAR = 16;

// "E5:4 A4:2 r:2" -> [{ step, note, len }]; every bar must add up to 16 sixteenth-note steps.
function parseMelody(bars) {
  const events = [];
  bars.forEach((bar, index) => {
    let step = index * STEPS_PER_BAR;
    for (const token of bar.trim().split(/\s+/)) {
      const [note, length] = token.split(':');
      const len = Number(length);
      if (note !== 'r') events.push({ step, note, len });
      step += len;
    }
    if (step !== (index + 1) * STEPS_PER_BAR) throw new Error(`bar ${index + 1} has ${step - index * STEPS_PER_BAR} steps, not 16`);
  });
  return events;
}

// ---------------------------------------------------------------------------------------------------------------- title
const TITLE = {
  bpm: 116,
  melody: [
    // A: the theme
    'E5:4 A4:2 C5:2 E5:4 D5:2 C5:2',      // Am
    'C5:4 F4:2 A4:2 C5:4 B4:2 A4:2',      // F
    'G4:4 C5:2 E5:2 G5:4 F5:2 E5:2',      // C
    'D5:6 B4:2 G4:4 B4:4',                // G
    'E5:4 A4:2 C5:2 E5:4 A5:4',           // Am
    'A5:4 G5:2 F5:2 E5:4 C5:4',           // F
    'D5:4 G5:4 F5:2 E5:2 D5:4',           // G
    'E5:8 G#4:2 B4:2 E5:4',               // E
    // B: the answer, a little higher
    'D5:2 F5:2 A5:4 F5:2 D5:2 A4:4',      // Dm
    'C5:2 E5:2 A5:4 E5:2 C5:2 A4:4',      // Am
    'A4:2 C5:2 F5:4 C5:2 A4:2 F4:4',      // F
    'G4:2 C5:2 E5:4 G5:4 E5:4',           // C
    'F5:4 E5:2 D5:2 F5:4 A5:4',           // Dm
    'E5:4 D5:2 C5:2 E5:4 A4:4',           // Am
    'B4:4 E5:4 G#5:4 B5:4',               // E
    'E5:8 r:8',                           // E (breathe)
  ],
  chords: [
    ['A3', 'C4', 'E4'], ['F3', 'A3', 'C4'], ['C4', 'E4', 'G4'], ['G3', 'B3', 'D4'],
    ['A3', 'C4', 'E4'], ['F3', 'A3', 'C4'], ['G3', 'B3', 'D4'], ['E3', 'G#3', 'B3'],
    ['D4', 'F4', 'A4'], ['A3', 'C4', 'E4'], ['F3', 'A3', 'C4'], ['C4', 'E4', 'G4'],
    ['D4', 'F4', 'A4'], ['A3', 'C4', 'E4'], ['E3', 'G#3', 'B3'], ['E3', 'G#3', 'B3'],
  ],
  roots: [['A2', 'E3'], ['F2', 'C3'], ['C3', 'G3'], ['G2', 'D3'], ['A2', 'E3'], ['F2', 'C3'], ['G2', 'D3'], ['E2', 'B2'],
    ['D3', 'A3'], ['A2', 'E3'], ['F2', 'C3'], ['C3', 'G3'], ['D3', 'A3'], ['A2', 'E3'], ['E2', 'B2'], ['E2', 'B2']],
  style: 'march',
  levels: { lead: 0.085, arp: 0.032, bass: 0.15, stab: 0 },
};

// --------------------------------------------------------------------------------------------------------------- battle
const BATTLE = {
  bpm: 174,
  melody: [
    // A: the charge
    'D5:2 F5:2 A5:2 D6:2 C6:2 A5:2 F5:2 A5:2',        // Dm
    'D6:4 C6:2 Bb5:2 A5:4 F5:4',                      // Dm
    'Bb5:2 D6:2 F6:2 D6:2 Bb5:4 D6:2 C6:2',           // Bb
    'E6:4 D6:2 C6:2 G5:4 C6:4',                       // C
    'D5:2 F5:2 A5:2 D6:2 F6:4 E6:2 D6:2',             // Dm
    'D6:4 C6:2 Bb5:2 A5:2 Bb5:2 D6:4',                // Bb
    'C6:2 E6:2 G6:2 E6:2 C6:2 E6:2 G6:4',             // C
    'A5:2 C#6:2 E6:2 A6:2 G6:4 E6:2 C#6:2',           // A
    // B: the clash
    'G5:2 Bb5:2 D6:2 G6:2 F6:2 D6:2 Bb5:2 D6:2',      // Gm
    'G6:4 F6:2 D6:2 Bb5:4 D6:4',                      // Gm
    'A5:2 D6:2 F6:2 A6:2 G6:2 F6:2 D6:2 F6:2',        // Dm
    'A6:4 G6:2 F6:2 D6:8',                            // Dm
    'Bb5:2 D6:2 F6:2 Bb6:2 A6:2 F6:2 D6:2 F6:2',      // Bb
    'C6:2 E6:2 G6:2 C7:2 Bb6:2 G6:2 E6:4',            // C
    'A5:2 C#6:2 E6:2 A6:2 E6:2 C#6:2 A5:2 C#6:2',     // A
    'E6:2 D6:2 C#6:2 A5:2 A5:8',                      // A (and round again)
  ],
  chords: [
    ['D4', 'F4', 'A4'], ['D4', 'F4', 'A4'], ['Bb3', 'D4', 'F4'], ['C4', 'E4', 'G4'],
    ['D4', 'F4', 'A4'], ['Bb3', 'D4', 'F4'], ['C4', 'E4', 'G4'], ['A3', 'C#4', 'E4'],
    ['G3', 'Bb3', 'D4'], ['G3', 'Bb3', 'D4'], ['D4', 'F4', 'A4'], ['D4', 'F4', 'A4'],
    ['Bb3', 'D4', 'F4'], ['C4', 'E4', 'G4'], ['A3', 'C#4', 'E4'], ['A3', 'C#4', 'E4'],
  ],
  roots: [['D3'], ['D3'], ['Bb2'], ['C3'], ['D3'], ['Bb2'], ['C3'], ['A2'],
    ['G2'], ['G2'], ['D3'], ['D3'], ['Bb2'], ['C3'], ['A2'], ['A2']],
  style: 'action',
  levels: { lead: 0.07, arp: 0.02, bass: 0.17, stab: 0.05 },
};

export const SONGS = { title: TITLE, battle: BATTLE };

// Turn a song into "what happens on each sixteenth step", once.
function compile(song) {
  const action = song.style === 'action';
  const bars = song.melody.length;
  const total = bars * STEPS_PER_BAR;
  const steps = Array.from({ length: total }, () => []);
  for (const e of parseMelody(song.melody)) {
    steps[e.step].push({ voice: 'lead', freq: hz(e.note), len: e.len });
    if (action) steps[e.step].push({ voice: 'lead2', freq: hz(e.note) / 2, len: e.len });   // an octave below, thin and buzzy
  }
  song.chords.forEach((chord, bar) => {
    const base = bar * STEPS_PER_BAR;
    if (action) {                                                   // sixteenth-note arpeggio
      const order = [0, 1, 2, 1];
      for (let i = 0; i < STEPS_PER_BAR; i++) steps[base + i].push({ voice: 'arp', freq: hz(chord[order[i % 4]]), len: 1 });
      for (const s of bar % 2 ? [0, 6, 10] : [0, 6, 8, 14]) steps[base + s].push({ voice: 'stab', notes: [chord[0], chord[1], chord[2]], len: 2 });
    } else {                                                        // eighth-note arpeggio
      const order = [0, 1, 2, 1, 0, 1, 2, 1];
      order.forEach((tone, i) => steps[base + i * 2].push({ voice: 'arp', freq: hz(chord[tone]), len: 2 }));
    }
  });
  song.roots.forEach(([root, fifth], bar) => {
    const base = bar * STEPS_PER_BAR;
    if (action) {
      // a gallop: long-short-short on every beat, jumping an octave on the last hit of beats 2 and 4
      for (let beat = 0; beat < 4; beat++) {
        [[0, 2], [2, 1], [3, 1]].forEach(([offset, len], hit) => {
          const jump = hit === 2 && beat % 2 === 1;
          steps[base + beat * 4 + offset].push({ voice: 'bass', freq: hz(jump ? transpose(root, 12) : root), len });
        });
      }
      for (const s of bar % 2 ? [0, 4, 8, 10, 12] : [0, 6, 8, 14]) steps[base + s].push({ voice: 'kick' });
      for (const s of [4, 12]) steps[base + s].push({ voice: 'snare' });
      for (let s = 0; s < STEPS_PER_BAR; s++) steps[base + s].push({ voice: 'hat', accent: s % 4 === 2, soft: s % 2 === 1 });
      if (bar % 8 === 0) steps[base].push({ voice: 'crash' });                                    // cymbal on each section start
      if (bar % 8 === 7) for (let s = 8; s < STEPS_PER_BAR; s++) steps[base + s].push({ voice: 'snare', roll: (s - 8) / 7 });   // build-up roll
    } else {
      const pattern = [root, root, fifth, root, root, root, fifth, root];
      pattern.forEach((note, i) => steps[base + i * 2].push({ voice: 'bass', freq: hz(note), len: 2 }));
      for (const s of [0, 8]) steps[base + s].push({ voice: 'kick', soft: true });
      for (const s of [4, 12]) steps[base + s].push({ voice: 'snare', soft: true });
      for (let s = 0; s < STEPS_PER_BAR; s += 2) steps[base + s].push({ voice: 'hat', accent: s % 4 === 2, soft: true });
    }
  });
  return steps;
}

// ------------------------------------------------------------------------------------------------------------- voices
const waves = new WeakMap();             // per audio context: duty -> PeriodicWave
function pulseWave(ctx, duty) {
  let byDuty = waves.get(ctx);
  if (!byDuty) waves.set(ctx, byDuty = new Map());
  if (!byDuty.has(duty)) {
    const n = 48, real = new Float32Array(n), imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = 2 * Math.sin(k * Math.PI * duty) / (k * Math.PI);
    byDuty.set(duty, ctx.createPeriodicWave(real, imag));
  }
  return byDuty.get(duty);
}
const noises = new WeakMap();
function noiseBuffer(ctx) {
  if (!noises.has(ctx)) {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noises.set(ctx, buffer);
  }
  return noises.get(ctx);
}

function envelope(ctx, out, t, peak, length, attack = 0.004) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(peak, t + attack);
  gain.gain.setValueAtTime(peak, t + Math.max(attack, length * 0.7));
  gain.gain.linearRampToValueAtTime(0.0001, t + length);
  gain.connect(out);
  return gain;
}

function tone(ctx, out, t, freq, length, level, shape) {
  const osc = ctx.createOscillator();
  if (shape === 'triangle') osc.type = 'triangle';
  else osc.setPeriodicWave(pulseWave(ctx, shape));
  osc.frequency.setValueAtTime(freq, t);
  osc.connect(envelope(ctx, out, t, level, length));
  osc.start(t); osc.stop(t + length + 0.02);
}

function noiseHit(ctx, out, t, length, level, highpass) {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass'; filter.frequency.value = highpass;
  source.connect(filter);
  filter.connect(envelope(ctx, out, t, level, length, 0.001));
  source.start(t, Math.random() * 0.5, length + 0.02);
}

function play(ctx, out, e, t, stepSeconds, levels) {
  const length = Math.max(0.03, (e.len || 1) * stepSeconds * 0.9);
  switch (e.voice) {
    case 'lead': tone(ctx, out, t, e.freq, length * 1.05, levels.lead, 0.5); break;
    case 'lead2': tone(ctx, out, t, e.freq, length * 1.05, levels.lead * 0.55, 0.125); break;
    case 'arp': tone(ctx, out, t, e.freq, length, levels.arp, 0.25); break;
    case 'bass': tone(ctx, out, t, e.freq, length, levels.bass, 'triangle'); break;
    case 'stab':                                         // a short, wide chord hit
      for (const note of e.notes) { tone(ctx, out, t, hz(note), length * 1.1, levels.stab, 0.5); tone(ctx, out, t, hz(note) * 1.006, length * 1.1, levels.stab * 0.6, 0.25); }
      break;
    case 'kick': {
      const level = e.soft ? 0.18 : 0.34;
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      osc.connect(envelope(ctx, out, t, level, 0.16, 0.002));
      osc.start(t); osc.stop(t + 0.18);
      break;
    }
    case 'snare': {
      const level = (e.soft ? 0.05 : 0.12) * (e.roll === undefined ? 1 : 0.6 + 0.9 * e.roll);   // a roll gets louder as it builds
      noiseHit(ctx, out, t, e.roll === undefined ? 0.13 : 0.07, level, 1200);
      tone(ctx, out, t, 190, 0.06, level * 0.45, 'triangle');
      break;
    }
    case 'hat': noiseHit(ctx, out, t, e.accent ? 0.05 : 0.025, (e.accent ? 0.05 : 0.03) * (e.soft ? 0.5 : 1), 7000); break;
    case 'crash': noiseHit(ctx, out, t, 1.1, 0.07, 3000); break;
  }
}

// ------------------------------------------------------------------------------------------------------------ player
const LOOKAHEAD = 0.25;                          // seconds of music scheduled in advance
let context = null, master = null, current = null, wanted = null;
let muted = false;
try { muted = localStorage.getItem('brawl-music') === 'off'; } catch { /* storage unavailable */ }
const VOLUME = 0.35;
const DIM = 0.4;                    // how loud the music is while a menu is open, compared with normal
let dimmed = false;
const level = () => muted ? 0 : VOLUME * (dimmed ? DIM : 1);

function audioContext() {
  if (!context) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    context = new Context();
    const compressor = context.createDynamicsCompressor();
    master = context.createGain();
    master.gain.value = level();
    master.connect(compressor); compressor.connect(context.destination);
  }
  return context;
}

function stopCurrent(fade = 0.5) {
  if (!current) return;
  const old = current; current = null;
  clearInterval(old.timer);
  if (old.audio) setTimeout(() => { old.audio.pause(); old.audio.removeAttribute('src'); }, (fade + 0.2) * 1000);
  const now = context.currentTime;
  old.gain.gain.cancelScheduledValues(now);
  old.gain.gain.setValueAtTime(old.gain.gain.value, now);
  old.gain.gain.linearRampToValueAtTime(0, now + fade);
  setTimeout(() => old.gain.disconnect(), (fade + 0.4) * 1000);
}

// Your own audio files, by track name. If the file is not there (for example a fresh copy from GitHub, where the
// files are left out on purpose), the built-in tune plays instead.
const FILES = { title: '/music/menu.mp3' };

function startFile(name, url) {
  const ctx = audioContext();
  const audio = new Audio(url);
  audio.loop = true; audio.preload = 'auto';
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.8);
  ctx.createMediaElementSource(audio).connect(gain);
  gain.connect(master);
  const player = { name, gain, audio, timer: 0 };
  const begin = () => audio.play().catch(() => {});           // refused until the first click; unlock() tries again
  audio.addEventListener('error', () => { if (current === player) { stopCurrent(0.05); startSynth(name); } });
  begin();
  current = player;
}

function start(name) {
  const ctx = audioContext();
  if (!ctx) return;
  stopCurrent();
  if (FILES[name]) startFile(name, FILES[name]); else startSynth(name);
}

function startSynth(name) {
  const ctx = audioContext();
  const song = SONGS[name];
  const steps = compile(song);
  const stepSeconds = 60 / song.bpm / 4;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.6);
  gain.connect(master);
  const player = { name, gain, timer: 0, index: 0, time: ctx.currentTime + 0.08 };
  player.timer = setInterval(() => {
    while (player.time < ctx.currentTime + LOOKAHEAD) {
      for (const e of steps[player.index]) play(ctx, gain, e, player.time, stepSeconds, song.levels);
      player.index = (player.index + 1) % steps.length;
      player.time += stepSeconds;
    }
  }, 40);
  current = player;
}

export const music = {
  /** Choose the track that should be playing ('title', 'battle', or null for silence). Safe to call every frame. */
  set(name) {
    if (name === wanted) return;
    wanted = name;
    if (!name) { if (context) stopCurrent(); return; }
    start(name);
  },
  /** Browsers only allow sound after a click or key press; the first one wakes the music up. */
  unlock() {
    if (context?.state === 'suspended') context.resume().catch(() => {});
    if (current?.audio?.paused) current.audio.play().catch(() => {});
  },
  get muted() { return muted; },
  setMuted(value) {
    muted = !!value;
    try { localStorage.setItem('brawl-music', muted ? 'off' : 'on'); } catch { /* storage unavailable */ }
    if (master) master.gain.setTargetAtTime(level(), context.currentTime, 0.08);
  },
  /** Turn the music down while a menu is open, and back up when it closes. Safe to call every frame. */
  dim(value) {
    if (value === dimmed) return;
    dimmed = value;
    if (master) master.gain.setTargetAtTime(level(), context.currentTime, 0.3);     // eases over about a second, like the menu's fade-in
  },
};

for (const type of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(type, () => music.unlock(), { passive: true });

/** For tests: render the first few seconds of a song offline and report how loud it is. */
export async function renderForTest(name, seconds = 8) {
  const song = SONGS[name], steps = compile(song), stepSeconds = 60 / song.bpm / 4;
  const rate = 22050, offline = new OfflineAudioContext(1, rate * seconds, rate);
  const out = offline.createGain(); out.connect(offline.destination);
  for (let i = 0, t = 0.05; t < seconds && i < steps.length * 4; i++, t += stepSeconds) {
    for (const e of steps[i % steps.length]) play(offline, out, e, t, stepSeconds, song.levels);
  }
  const data = (await offline.startRendering()).getChannelData(0);
  let peak = 0, sum = 0, bad = 0;
  for (const v of data) { if (!Number.isFinite(v)) bad++; peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  return { bars: song.melody.length, peak: +peak.toFixed(3), rms: +Math.sqrt(sum / data.length).toFixed(4), bad, seconds: +(song.melody.length * 16 * stepSeconds).toFixed(1) };
}
