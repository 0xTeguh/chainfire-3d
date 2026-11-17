// Deterministic pseudo-random helpers built on mulberry32.
// Written fresh for the CHAINFIRE 3D rebuild. No wall clock, no Math.random.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(rng, min, max) {
  if (max < min) {
    const swap = min;
    min = max;
    max = swap;
  }
  return min + rng() * (max - min);
}

export function pick(rng, arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const index = Math.floor(rng() * arr.length);
  return arr[Math.min(index, arr.length - 1)];
}

export function shuffleInPlace(rng, arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// Small deterministic value-noise helper: sum of sines with seeded phases.
// Used for terrain height and other smooth seeded variation.
export function makeNoise(rng, octaves) {
  const phases = [];
  const freqs = [];
  const amps = [];
  for (let i = 0; i < octaves; i += 1) {
    phases.push(rng() * Math.PI * 2);
    freqs.push(0.03 + rng() * 0.05 + i * 0.045);
    amps.push(1 / (i + 1));
  }
  return function noise(x, z) {
    let v = 0;
    let total = 0;
    for (let i = 0; i < octaves; i += 1) {
      v += Math.sin(x * freqs[i] + phases[i]) * Math.cos(z * freqs[i] * 0.8 + phases[i] * 1.7) * amps[i];
      total += amps[i];
    }
    return v / total;
  };
}
