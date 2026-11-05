/**
 * The incoming-message chime. Synthesized with WebAudio (no asset to ship or
 * cache-bust) and throttled so a burst — a busy group, a reconnect replay —
 * plays once instead of machine-gunning.
 *
 * Browsers only let audio start after a user gesture, so the AudioContext is
 * created/resumed on the first click or key press (installSoundUnlock). Until
 * then a chime is silently skipped; once unlocked it keeps working while the
 * tab is in the background.
 */

const SOUND_KEY = 'wa_sound';
const THROTTLE_MS = 1500;

let ctx: AudioContext | null = null;
let lastPlayed = 0;

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== '0'; // on by default
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable — stays at the default */
  }
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** Create/resume the AudioContext on the first user gesture (autoplay policy). */
export function installSoundUnlock(): void {
  const unlock = () => {
    const c = context();
    if (c?.state === 'suspended') void c.resume().catch(() => {});
    if (c?.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

/**
 * Two short rising tones. Returns whether it actually played (so callers can
 * mark their system notification silent and avoid a double sound).
 */
export function playChime(opts: { force?: boolean } = {}): boolean {
  if (!opts.force && !soundEnabled()) return false;
  const now = Date.now();
  if (!opts.force && now - lastPlayed < THROTTLE_MS) return true; // already chimed for this burst
  const c = context();
  if (!c || c.state !== 'running') return false;
  lastPlayed = now;
  const t0 = c.currentTime;
  for (const [freq, at] of [
    [880, 0],
    [1320, 0.12],
  ] as const) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.18);
    osc.connect(gain).connect(c.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.2);
  }
  return true;
}
