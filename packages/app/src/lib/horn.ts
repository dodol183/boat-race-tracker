// A horn-like beep for signals, from the device speaker (only after the person turns sound on).
let ctx: AudioContext | null = null;

export function enableSound(): boolean {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export function horn(long = false) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 440;
  gain.gain.value = 0.25;
  osc.connect(gain).connect(ctx.destination);
  const t = ctx.currentTime;
  osc.start(t);
  osc.stop(t + (long ? 1.2 : 0.5));
}
