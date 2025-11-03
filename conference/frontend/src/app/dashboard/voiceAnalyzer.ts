// ======================================================
// src/app/dashboard/voiceAnalyzer.ts
// Audio processing utilities for speaker verification
// Now uses backend API (SpeechBrain ECAPA-TDNN) instead of YAMNet
// ======================================================

export type Embedding = Float32Array;

const TARGET_SR = 16000;

/**
 * Resample Float32Array audio to target sample rate (linear interpolation).
 */
function resampleLinear(input: Float32Array, inSR: number, outSR: number): Float32Array {
  if (inSR === outSR) return input;
  const ratio = inSR / outSR;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

/**
 * Convert AudioBuffer -> mono Float32 waveform (uses first channel or mixes down) and resample to 16k.
 */
export async function audioBufferToMono16k(audioBuffer: AudioBuffer): Promise<Float32Array> {
  // mixdown to mono if needed
  let mono: Float32Array;
  if (audioBuffer.numberOfChannels === 1) {
    mono = audioBuffer.getChannelData(0);
  } else {
    const ch0 = audioBuffer.getChannelData(0);
    const chCount = audioBuffer.numberOfChannels;
    mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      let sum = 0;
      for (let c = 0; c < chCount; c++) sum += audioBuffer.getChannelData(c)[i];
      mono[i] = sum / chCount;
    }
  }
  const inSR = audioBuffer.sampleRate;
  const mono16k = resampleLinear(mono, inSR, TARGET_SR);
  return mono16k;
}

/**
 * Convert a Blob (audio/webm or audio/wav) into an AudioBuffer using AudioContext.decodeAudioData.
 */
export async function blobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  if (!window.AudioContext && !(window as any).webkitAudioContext) {
    throw new Error('Web Audio API not available in this browser');
  }
  if (!audioContextForDecoding) {
    audioContextForDecoding = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  const arrayBuffer = await blob.arrayBuffer();
  return await audioContextForDecoding.decodeAudioData(arrayBuffer);
}

let audioContextForDecoding: AudioContext | null = null;

/**
 * Cosine similarity between two embeddings (Float32Array).
 * returns value in [-1, 1]
 * 
 * NOTE: This is kept for potential frontend fallback, but the main
 * similarity computation now happens on the backend.
 */
export function cosineSimilarityEmbedding(a: Embedding, b: Embedding): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Initialize model - No longer needed as we use backend API
 * Kept for backward compatibility
 */
export async function initModel(): Promise<void> {
  console.log('✅ Using backend API for speaker verification (no frontend model needed)');
  return Promise.resolve();
}

/**
 * Get embedding from audio buffer - No longer needed as we use backend API
 * Kept for backward compatibility, but now just returns empty array
 */
export async function getEmbeddingFromAudioBuffer(audioBuffer: AudioBuffer): Promise<Embedding> {
  console.warn('getEmbeddingFromAudioBuffer is deprecated - use backend API instead');
  return new Float32Array(0);
}
