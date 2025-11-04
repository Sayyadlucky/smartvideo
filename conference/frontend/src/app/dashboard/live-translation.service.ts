import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

type TransformersModule = {
  pipeline: (...args: any[]) => Promise<any>;
};

declare global {
  interface Window {
    transformers?: TransformersModule;
  }
}

export interface TranslationUpdate {
  channel: string;
  originalText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  timestamp: number;
  confidence?: number;
}

export interface TranslationSessionOptions {
  targetLanguage?: string;
  chunkMillis?: number;
}

interface TranslationSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  options: Required<TranslationSessionOptions>;
  active: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class LiveTranslationService {
  private sessions = new Map<string, TranslationSession>();
  private translationSubject = new BehaviorSubject<TranslationUpdate | null>(null);
  private audioContext: AudioContext | null = null;

  private transformersModulePromise: Promise<TransformersModule> | null = null;
  private asrPipelinePromise: Promise<any> | null = null;
  private translatorPipelinePromise: Promise<any> | null = null;

  constructor(private readonly ngZone: NgZone) {}

  get translations$(): Observable<TranslationUpdate | null> {
    return this.translationSubject.asObservable();
  }

  async startSession(channel: string, stream: MediaStream, options: TranslationSessionOptions = {}): Promise<void> {
    if (this.sessions.has(channel)) {
      return;
    }

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      throw new Error('No audio track available for translation session.');
    }

    const sessionStream = new MediaStream();
    audioTracks.forEach(track => sessionStream.addTrack(track));

    const preferredMime = 'audio/webm;codecs=opus';
    const fallbackMime = 'audio/ogg;codecs=opus';
    let mimeType: string | undefined = undefined;
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(preferredMime)) {
      mimeType = preferredMime;
    } else if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(fallbackMime)) {
      mimeType = fallbackMime;
    }

    const recorder = new MediaRecorder(sessionStream, {
      mimeType,
    });

    const session: TranslationSession = {
      recorder,
      stream: sessionStream,
      options: {
        targetLanguage: options.targetLanguage ?? 'en',
        chunkMillis: options.chunkMillis ?? 2000,
      },
      active: true,
    };

    recorder.ondataavailable = (evt) => {
      if (!evt.data || !evt.data.size || !session.active) {
        return;
      }
      // Run heavy work off the Angular zone so it doesn't trigger change detection repeatedly.
      this.ngZone.runOutsideAngular(() => {
        this.processChunk(channel, evt.data, session.options).catch(err => {
          console.error('[LiveTranslationService] chunk processing failed', err);
        });
      });
    };

    recorder.onstop = () => {
      session.active = false;
      session.stream.getTracks().forEach(track => track.stop());
      this.sessions.delete(channel);
    };

    this.sessions.set(channel, session);
    recorder.start(session.options.chunkMillis);
  }

  stopSession(channel: string): void {
    const session = this.sessions.get(channel);
    if (!session) {
      return;
    }
    session.active = false;
    try {
      if (session.recorder.state !== 'inactive') {
        session.recorder.stop();
      }
    } catch (err) {
      console.warn('[LiveTranslationService] failed to stop recorder', err);
    }
    session.stream.getTracks().forEach(track => track.stop());
    this.sessions.delete(channel);
  }

  stopAll(): void {
    Array.from(this.sessions.keys()).forEach(key => this.stopSession(key));
  }

  isActive(channel: string): boolean {
    return this.sessions.has(channel);
  }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  private async ensureTransformersModule(): Promise<TransformersModule> {
    if (this.transformersModulePromise) {
      return this.transformersModulePromise;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('Transformers module can only be loaded in the browser.');
    }

    if (window.transformers) {
      this.transformersModulePromise = Promise.resolve(window.transformers);
      return window.transformers;
    }

    this.transformersModulePromise = new Promise<TransformersModule>((resolve, reject) => {
      const resolveIfReady = (attemptsLeft: number) => {
        const mod = window.transformers;
        if (mod) {
          resolve(mod);
          return true;
        }
        if (attemptsLeft <= 0) {
          return false;
        }
        setTimeout(() => resolveIfReady(attemptsLeft - 1), 25);
        return true;
      };

      const existing = document.querySelector<HTMLScriptElement>('script[data-transformers]');
      if (existing?.dataset['loaded'] === 'true') {
        if (!resolveIfReady(10)) {
          this.transformersModulePromise = null;
          reject(new Error('Transformers runtime not ready after script load.'));
        }
        return;
      }

      const script = existing ?? document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.15.1/dist/transformers.min.js';
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.dataset['transformers'] = 'true';

      const cleanup = () => {
        script.removeEventListener('load', handleLoad);
        script.removeEventListener('error', handleError);
      };

      const handleLoad = () => {
        cleanup();
        script.dataset['loaded'] = 'true';
        if (!resolveIfReady(20)) {
          this.transformersModulePromise = null;
          reject(new Error('Transformers global not available after script load.'));
        }
      };

      const handleError = () => {
        cleanup();
        this.transformersModulePromise = null;
        reject(new Error('Failed to load transformers runtime.'));
      };

      script.addEventListener('load', handleLoad);
      script.addEventListener('error', handleError);

      if (!existing) {
        document.head.appendChild(script);
      }
    });

    return this.transformersModulePromise;
  }

  private async loadAsrPipeline(): Promise<any> {
    if (!this.asrPipelinePromise) {
      this.asrPipelinePromise = (async () => {
        const { pipeline } = await this.ensureTransformersModule();
        return pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
          quantized: true,
        });
      })();
    }
    return this.asrPipelinePromise;
  }

  private async loadTranslatorPipeline(): Promise<any> {
    if (!this.translatorPipelinePromise) {
      this.translatorPipelinePromise = (async () => {
        const { pipeline } = await this.ensureTransformersModule();
        return pipeline('translation', 'Xenova/m2m100_418M', {
          quantized: true,
        });
      })();
    }
    return this.translatorPipelinePromise;
  }

  private async processChunk(channel: string, blob: Blob, options: Required<TranslationSessionOptions>): Promise<void> {
    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = this.getAudioContext();
    // decodeAudioData requires a copy of the buffer in some browsers
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      console.warn('[LiveTranslationService] decodeAudioData failed, skipping chunk', err);
      return;
    }

    const monoData = this.downmixToMono(audioBuffer);
    if (!monoData.length) {
      return;
    }

    const pcm16k = this.resampleTo16k(monoData, audioBuffer.sampleRate);
    if (!pcm16k.length) {
      return;
    }

    const asr = await this.loadAsrPipeline();
    const asrInput = {
      data: pcm16k,
      sampling_rate: 16000,
    };
    const transcription = await asr(asrInput, {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
    });

    const rawText = (transcription?.text ?? '').trim();
    if (!rawText) {
      return;
    }

    const detectedLang = (transcription?.language ?? 'en').toLowerCase();
    let translatedText = rawText;
    const targetLanguage = (options.targetLanguage || 'en').toLowerCase();

    if (detectedLang !== targetLanguage) {
      const translator = await this.loadTranslatorPipeline();
      const translated = await translator(rawText, {
        src_lang: detectedLang,
        tgt_lang: targetLanguage,
      });
      translatedText = Array.isArray(translated)
        ? (translated[0]?.translation_text ?? translated[0]?.generated_text ?? rawText)
        : (translated?.translation_text ?? translated?.generated_text ?? rawText);
    }

    this.translationSubject.next({
      channel,
      originalText: rawText,
      translatedText,
      sourceLanguage: detectedLang,
      targetLanguage,
      timestamp: Date.now(),
      confidence: transcription?.language_score ?? transcription?.chunks?.[0]?.score,
    });
  }

  private downmixToMono(buffer: AudioBuffer): Float32Array {
    const channelCount = buffer.numberOfChannels;
    if (channelCount === 0) {
      return new Float32Array();
    }

    if (channelCount === 1) {
      const channelData = buffer.getChannelData(0);
      return new Float32Array(channelData);
    }

    const length = buffer.length;
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let c = 0; c < channelCount; c++) {
        sum += buffer.getChannelData(c)[i] || 0;
      }
      data[i] = sum / channelCount;
    }
    return data;
  }

  private resampleTo16k(input: Float32Array, originalSampleRate: number): Float32Array {
    if (originalSampleRate === 16000) {
      return new Float32Array(input);
    }
    if (originalSampleRate <= 0) {
      return new Float32Array();
    }

    const sampleRatio = originalSampleRate / 16000;
    const newLength = Math.floor(input.length / sampleRatio);
    if (!Number.isFinite(newLength) || newLength <= 0) {
      return new Float32Array();
    }

    const output = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const pos = i * sampleRatio;
      const leftIndex = Math.floor(pos);
      const rightIndex = Math.min(leftIndex + 1, input.length - 1);
      const interp = pos - leftIndex;
      output[i] = input[leftIndex] * (1 - interp) + input[rightIndex] * interp;
    }
    return output;
  }
}
