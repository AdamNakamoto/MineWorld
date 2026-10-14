// Little synthesized sounds (no audio files): digging, placing, hits, a coin for every $MINE earned.

let ctx = null, muted = false;
try { muted = localStorage.getItem("mwc:muted") === "1"; } catch {}
const ac = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

function noise(dur, freq, gain, q = 1) {
  if (muted) return;
  const a = ac();
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}
function tone(freq, dur, gain, type = "square", slide = 0) {
  if (muted) return;
  const a = ac();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, a.currentTime + dur);
  g.gain.setValueAtTime(gain, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}

export const sfx = {
  dig: (hard) => noise(0.08, hard ? 1400 : 500, 0.25, 0.8),
  broke: (hard) => noise(0.18, hard ? 900 : 350, 0.45, 0.6),
  place: () => noise(0.1, 300, 0.4, 1.2),
  swing: () => noise(0.06, 2400, 0.08, 0.5),
  hit: () => { noise(0.08, 700, 0.4); tone(180, 0.08, 0.08, "square", 0.5); },
  hurt: () => tone(220, 0.25, 0.12, "sawtooth", 0.5),
  coin: () => { tone(988, 0.08, 0.06); setTimeout(() => tone(1319, 0.16, 0.06), 70); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.15, 0.06), i * 80)),
  get muted() { return muted; },
  toggle() { muted = !muted; try { localStorage.setItem("mwc:muted", muted ? "1" : "0"); } catch {} return muted; },
  unlock() { if (!muted) ac().resume?.(); },
};
