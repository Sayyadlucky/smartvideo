// src/app/dashboard/dashboard.ts (refactor — stable media, clearer state)
import {
  Component,
  OnInit,
  OnDestroy,
  HostListener,
  Directive,
  ElementRef,
  Input,
  ViewChild,
  ViewChildren,
  QueryList,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SignalingService } from './signaling.service';
import { Subscription } from 'rxjs';
import { SrcObjectDirective } from './src-object.directive';
import { DragDropModule } from '@angular/cdk/drag-drop';
import * as faceapi from 'face-api.js';

/**
 * Goals of this refactor
 * - One participant object per remote channel, always keyed by channel id
 * - "videoOn" is a pure UI-derived flag (from tracks + cam), never trusted from server
 * - Mic toggle never touches video state; Cam toggle never touches mic state
 * - ontrack always reuses the same MediaStream per participant and only adds/removes tracks
 * - replaceTrack for senders instead of remove/add to avoid renegotiation churn
 * - Clear separation: local state helpers, peer signaling helpers, participant store helpers
 */

type MicState = 'on' | 'off';
type CamState = 'on' | 'off';

interface Participant {
  name: string;
  mic: MicState;
  cam: CamState;
  videoOn: boolean; // derived: cam === 'on' && has enabled video track
  initials: string;
  isYou?: boolean;
  channel: string;
  stream?: MediaStream | null;
  handRaised?: boolean;
}


interface ChatMessage { by: string; text: string; }

// Gaze tracking state (moved inside component for better encapsulation)
interface GazeState {
  baseline: { x: number; y: number } | null;
  calibrationFrames: number;
  maxCalibrationFrames: number;
  gazeHistory: string[];
  maxHistory: number;
  lastDirection: string;
  consecutiveCount: number;
  calibrationBuffer?: { x: number; y: number }[];
  stdDev: { x: number; y: number } | null;
  hysteresisThreshold: number;
  headPoseHistory: { pitch: number; yaw: number; roll: number }[];
  blinkHistory: boolean[];
  patternHistory: string[];
  lastBlinkTime: number;
  blinkCount: number;
  rapidMovementCount: number;
  prolongedAwayCount: number;
}

@Directive({ selector: 'video[appSrcObject],audio[appSrcObject]', standalone: true })
export class MediaSrcObjectDirective {
  @Input() muted: boolean = false;
  constructor(private el: ElementRef<HTMLVideoElement | HTMLAudioElement>) {}
  @Input() set appSrcObject(stream: MediaStream | undefined | null) {
    const media = this.el.nativeElement as HTMLMediaElement;
    media.autoplay = true;
    (media as any).playsInline = true;
    (media as any).srcObject = stream ?? null;
    (media as any).muted = this.muted;

    if (stream) {
      media.play().catch((e: any) => {
        if (e?.name === 'NotAllowedError') {
          const oneClick = () => { media.play().catch(() => {}); document.removeEventListener('click', oneClick); };
          document.addEventListener('click', oneClick, { once: true });
        }
      });
    }
  }
}

// ====== Peer state ======

type PeerState = {
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  polite: boolean;
  audioSender: RTCRtpSender;
  videoSender: RTCRtpSender;
  remoteChan: string;
  isSettingRemoteAnswerPending: boolean;
};

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, MediaSrcObjectDirective, SrcObjectDirective, DragDropModule],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.scss'],
  providers: [SignalingService],
})
export class Dashboard implements OnInit, OnDestroy {
  // ====== UI state ======
  isDesktop = window.innerWidth >= 1024;
  chatCollapsed = true;
  participants: Participant[] = [];
  chatMessages: ChatMessage[] = [];
  chatText = '';
  tileColsManual: number | null = null;
  public roomName = 'testroom';
  activeTab: 'participants' | 'alerts' | 'chat' = 'chat' ;
  isNameUpdated = false;
  @ViewChild('chatScroll') chatScroll!: ElementRef;
  @ViewChildren('videoTile') videoTiles!: QueryList<ElementRef<HTMLVideoElement>>;
  @ViewChildren('canvasTile') canvasTiles!: QueryList<ElementRef<HTMLCanvasElement>>;


  // ====== Signaling ======
  private signalingSub: Subscription | null = null;
  private myServerChan: string | null = null;
  private myPolite: boolean = true;

  // ====== Stores ======
  private participantsMap = new Map<string, Participant>(); // key: channel id; '__you__' for local
  private peers = new Map<string, PeerState>(); // key: remote channel id
  private iceQueue = new Map<string, RTCIceCandidateInit[]>(); // queued ICE per remote channel

  // ====== Local media ======
  private localVideoTrack: MediaStreamTrack | null = null;
  private localAudioTrack: MediaStreamTrack | null = null;
  private localPreviewStream: MediaStream = new MediaStream(); // stable instance
  userName: any;
  termsCheckbox: any;

  // ====== Gaze tracking state ======
  private gazeState: GazeState = {
    baseline: null,
    calibrationFrames: 0,
    maxCalibrationFrames: 60,
    gazeHistory: [],
    maxHistory: 15,
    lastDirection: '',
    consecutiveCount: 0,
    calibrationBuffer: [],
    stdDev: null,
    hysteresisThreshold: 3,
    headPoseHistory: [],
    blinkHistory: [],
    patternHistory: [],
    lastBlinkTime: 0,
    blinkCount: 0,
    rapidMovementCount: 0,
    prolongedAwayCount: 0,
  };

  // ====== Derived getters ======
  get you(): Participant | undefined { return this.participantsMap.get('__you__'); }
  get tileCount(): number { return this.participants.length; }
  get tileCols(): number { if (this.tileColsManual) return this.tileColsManual; return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(this.tileCount || 1)))); }
  get layoutCount(): number { return this.participants.length; }

  get fullParticipant(): Participant | undefined {
    const remotes = this.participants.filter(p => !p.isYou);
    if (remotes.length === 0 && this.you?.videoOn) return this.you;
    return remotes.find(p => p.videoOn);
  }

  get gridParticipants(): Participant[] {
    const remotes = this.participants.filter(p => !p.isYou);
    const self = this.you;
    if (remotes.length === 0 && self) return [self];
    return remotes;
  }
  suspiciousEvents: { time: string, message: string }[] = [];
  lastSuspiciousEvent: { [key: string]: number } = {}; // store last times
  suspiciousCooldown = 5000; // 5 seconds per message type
  
  constructor(private signaling: SignalingService) {}

  private updateBaseline(landmarks: faceapi.FaceLandmarks68) {
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
  
    const pupil = {
      x: (leftEye[1].x + leftEye[2].x + rightEye[1].x + rightEye[2].x) / 4,
      y: (leftEye[4].y + rightEye[4].y) / 2,
    };
  
    const eyeXmin = Math.min(leftEye[0].x, rightEye[3].x);
    const eyeXmax = Math.max(leftEye[3].x, rightEye[0].x);
    const eyeYtop = (leftEye[1].y + rightEye[1].y) / 2;
    const eyeYbottom = (leftEye[5].y + rightEye[5].y) / 2;
  
    this.gazeState.calibrationBuffer!.push({
      x: (pupil.x - eyeXmin) / (eyeXmax - eyeXmin),
      y: (pupil.y - eyeYtop) / (eyeYbottom - eyeYtop),
    });
  
    if (this.gazeState.calibrationBuffer!.length >= this.gazeState.maxCalibrationFrames) {
      this.gazeState.baseline = {
        x: this.gazeState.calibrationBuffer!.reduce((a, p) => a + p.x, 0) / this.gazeState.calibrationBuffer!.length,
        y: this.gazeState.calibrationBuffer!.reduce((a, p) => a + p.y, 0) / this.gazeState.calibrationBuffer!.length,
      };
    }
  }
    

  private estimateGazeCalibrated(landmarks: faceapi.FaceLandmarks68): string {
    if (!this.gazeState.baseline) return "Calibrating...";
  
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
  
    // Pupil estimate: inner corners + lower eyelids
    const pupil = {
      x: (leftEye[1].x + leftEye[2].x + rightEye[1].x + rightEye[2].x) / 4,
      y: (leftEye[4].y + rightEye[4].y) / 2,
    };
  
    // Eye box (for normalization)
    const eyeXmin = Math.min(leftEye[0].x, rightEye[3].x);
    const eyeXmax = Math.max(leftEye[3].x, rightEye[0].x);
    const eyeYtop = (leftEye[1].y + rightEye[1].y) / 2;   // upper eyelids
    const eyeYbottom = (leftEye[5].y + rightEye[5].y) / 2; // lower eyelids
  
    // Normalize pupil within eye box
    const normX = (pupil.x - eyeXmin) / (eyeXmax - eyeXmin);
    const normY = (pupil.y - eyeYtop) / (eyeYbottom - eyeYtop);
  
    const dx = normX - this.gazeState.baseline.x;
    const dy = normY - this.gazeState.baseline.y;
  
    // Adaptive thresholds (tuned smaller for stricter eye-only detection)
    const thrX = (this.gazeState.stdDev?.x ?? 0.03) * 2.5;
    const thrY = (this.gazeState.stdDev?.y ?? 0.03) * 2.5;
  
    let direction = "Looking Forward";
  
    if (dx < -thrX) direction = "Looking Left";
    else if (dx > thrX) direction = "Looking Right";
    else if (dy < -thrY) direction = "Looking Up";
    else if (dy > thrY) direction = "Looking Down";
  
    return direction;
  }
  
  
  // 🔍 Check suspiciousness with stricter rules
  private checkSuspiciousGaze(finalGaze: string) {
    const now = performance.now();
  
    // Track history
    this.gazeState.gazeHistory.push(finalGaze);
    if (this.gazeState.gazeHistory.length > this.gazeState.maxHistory) {
      this.gazeState.gazeHistory.shift();
    }
  
    // If gaze is away (not forward), track duration
    if (finalGaze !== "Looking Forward" && finalGaze !== "Calibrating...") {
      if (finalGaze === this.gazeState.lastDirection) {
        this.gazeState.consecutiveCount++;
      } else {
        this.gazeState.lastDirection = finalGaze;
        this.gazeState.consecutiveCount = 1;
      }
  
      // Require ~10 frames (~1 sec @10fps) before firing
      if (this.gazeState.consecutiveCount > 10) {
        this.sendSuspiciousEvent(`⚠️ Candidate ${finalGaze} (sustained)`);
        this.gazeState.consecutiveCount = 0;
      }
    } else {
      this.gazeState.consecutiveCount = 0;
      this.gazeState.lastDirection = "Looking Forward";
    }
  
    // Rapid gaze changes = suspicious
    if (this.gazeState.gazeHistory.length >= 5) {
      const last5 = this.gazeState.gazeHistory.slice(-5);
      const unique = new Set(last5);
      if (unique.size >= 3) {
        this.sendSuspiciousEvent("⚠️ Rapid eye movement detected");
      }
    }
  }
  
  

  private smoothGaze(newGaze: string): string {
    this.gazeState.gazeHistory.push(newGaze);
    if (this.gazeState.gazeHistory.length > this.gazeState.maxHistory) {
      this.gazeState.gazeHistory.shift();
    }
    const counts = this.gazeState.gazeHistory.reduce((a, g) => {
      a[g] = (a[g] || 0) + 1;
      return a;
    }, {} as Record<string, number>);
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // ====== Lifecycle ======
  async ngOnInit(): Promise<void> {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.sendSuspiciousEvent('⚠️ Candidate switched tab/window');
      }
    });
  }

  sendSuspiciousEvent(message: string) {
    const now = Date.now();
    const last = this.lastSuspiciousEvent[message] || 0;
  if (now - last < this.suspiciousCooldown) return;  
    this.lastSuspiciousEvent[message] = now;
  
    const event = {
      time: new Date().toLocaleTimeString(),
      message
    };
    this.suspiciousEvents.unshift({
      time: new Date().toLocaleTimeString(),
      message
    });
  
    // Limit list length (keep only last 20)
    if (this.suspiciousEvents.length > 30) {
      this.suspiciousEvents.pop();
    }
  }

  async ngAfterViewInit() {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/static/models'),
      faceapi.nets.faceExpressionNet.loadFromUri('/static/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/static/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/static/models'), // ✅ for gaze
    ]);
    this.startFaceMonitoring();

    document.addEventListener('keydown', e => {
      this.sendSuspiciousEvent(`Key pressed: ${e.key}`);
    });

    document.addEventListener('paste', () => {
      this.sendSuspiciousEvent('⚠️ Paste action detected');
    });
  }

  // async startFaceMonitoring() {
  //   const videoEl = document.querySelector('video'); // candidate’s video element
  //   if (!videoEl) return;
  
  //   const detect = async () => {
  //     const detections = await faceapi.detectAllFaces(videoEl, new faceapi.TinyFaceDetectorOptions())
  //                                     .withFaceExpressions();
  
  //     if (detections.length > 1) {
  //       this.sendSuspiciousEvent('⚠️ Multiple faces detected');
  //     } else if (detections.length === 0) {
  //       this.sendSuspiciousEvent('No face detected');
  //     }
  
  //     // Example: check if expression = looking away (low "neutral" + high "surprised")
  //     if (detections[0]?.expressions?.surprised > 0.6) {
  //       this.sendSuspiciousEvent('Candidate looking away / distracted');
  //     }
  
  //     requestAnimationFrame(detect);
  //   };
  
  //   detect();
  // }
  async startFaceMonitoring() {
    const videos = () =>
      Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-role="tile"]'));
    const canvases = () =>
      Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas[data-role="overlay"]'));
  
    // --- Pair video + canvas by data-chan ---
    const pairByChan = () => {
      const vs = videos();
      const cs = canvases();
      const map = new Map<string, { v: HTMLVideoElement; c: HTMLCanvasElement }>();
      vs.forEach(v => {
        const chan = v.getAttribute('data-chan') || '';
        const c = cs.find(x => x.getAttribute('data-chan') === chan);
        if (chan && c) map.set(chan, { v, c });
      });
      return map;
    };
  
    // --- Keep canvas synced with video size ---
    const syncCanvasSize = (v: HTMLVideoElement, c: HTMLCanvasElement) => {
      const w = v.offsetWidth || v.clientWidth || v.getBoundingClientRect().width || 0;
      const h = v.offsetHeight || v.clientHeight || v.getBoundingClientRect().height || 0;
      if (!w || !h) return;
  
      if (c.width !== Math.round(w)) c.width = Math.round(w);
      if (c.height !== Math.round(h)) c.height = Math.round(h);
  
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      c.style.position = 'absolute';
      c.style.top = '0';
      c.style.left = '0';
      c.style.pointerEvents = 'none';
      c.style.zIndex = '50';
    };
  
    const ro = new ResizeObserver(() => {
      pairByChan().forEach(({ v, c }) => syncCanvasSize(v, c));
    });
    pairByChan().forEach(({ v, c }) => {
      syncCanvasSize(v, c);
      ro.observe(v);
    });
  
    // --- Throttle detection (~8–10 fps) ---
    let lastT = 0;
    const targetDt = 120;
  
    const loop = async (t: number) => {
      if (t - lastT >= targetDt) {
        lastT = t;
        const pairs = pairByChan();
  
        for (const { v: videoEl, c: canvasEl } of pairs.values()) {
          const tile = videoEl.closest('.tile') as HTMLElement | null;
          const ctx = canvasEl.getContext('2d');
          if (!ctx) continue;
  
          // 🚫 If video is off or not ready → clear + hide canvas
          const chan = videoEl.getAttribute('data-chan') || '';
          const participant = this.participantsMap.get(chan);
          if (!participant?.videoOn || videoEl.readyState < 2) {
            ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
            canvasEl.style.display = 'none';
            tile?.classList.remove('suspicious');
            continue;
          } else {
            canvasEl.style.display = 'block'; // show overlay when active
          }
  
          // 🔹 Sync size this frame
          syncCanvasSize(videoEl, canvasEl);
  
          // 🔹 Run detections
          const detections = await faceapi
            .detectAllFaces(
              videoEl,
              new faceapi.TinyFaceDetectorOptions({ inputSize: 192, scoreThreshold: 0.5 })
            )
            .withFaceLandmarks()
            .withFaceExpressions();
  
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  
          const resized = faceapi.resizeResults(detections, {
            width: canvasEl.width,
            height: canvasEl.height,
          });
          faceapi.draw.drawDetections(canvasEl, resized);
          faceapi.draw.drawFaceExpressions(canvasEl, resized);
  
          if (detections.length !== 1) {
            if (detections.length > 1) this.sendSuspiciousEvent("⚠️ Multiple faces detected");
            else this.sendSuspiciousEvent("⚠️ No face detected");
            tile?.classList.add("suspicious");
          } else {
            tile?.classList.remove("suspicious");
  
            const expr = detections[0].expressions;
            const dom = Object.entries(expr).reduce((a, b) => (a[1] > b[1] ? a : b));
            this.sendSuspiciousEvent(`Expression: ${dom[0]}`);
  
            // 👀 Gaze tracking
            const landmarks = detections[0].landmarks as faceapi.FaceLandmarks68;
            if (!this.gazeState.baseline) {
              this.updateBaseline(landmarks);
            } else {
              if (landmarks) {
                const rawGaze = this.estimateGazeCalibrated(landmarks);
                const finalGaze = this.smoothGaze(rawGaze);
  
                this.checkSuspiciousGaze(finalGaze);
  
                if (finalGaze !== "Looking Forward" && finalGaze !== "Calibrating...") {
                  this.sendSuspiciousEvent(`⚠️ Candidate ${finalGaze}`);
                }
  
                ctx.fillStyle = "red";
                ctx.font = "16px Arial";
                ctx.fillText(`Gaze: ${finalGaze}`, 10, 20);
              }
            }
          }
        }
      }
      requestAnimationFrame(loop);
    };
  
    requestAnimationFrame(loop);
  }
  
  
  joinRoom(){
    console.log('DASHBOARD BUILD MARKER v8 — stable-media');
    // Create a single stable preview stream instance
    this.localPreviewStream = new MediaStream();

    this.participantsMap.set('__you__', this.makeLocalParticipant(this.userName));
    this.syncParticipantsArray();

    // connect to signaling server
    this.signaling.connect(this.roomName);
    this.signalingSub = this.signaling.messages$.subscribe((msg: any) => this.onSignal(msg));

    // Start face monitoring after view is rendered
    setTimeout(() => this.startFaceMonitoring(), 100);
  }
  ngOnDestroy(): void {
    try { this.sendSig({ type: 'bye' }); } catch {}
    this.signalingSub?.unsubscribe();
    this.signaling.disconnect();

    this.peers.forEach(st => { try { st.pc.close(); } catch {} });
    this.peers.clear();

    this.stopAndClearLocalTracks();

    this.participantsMap.clear();
    this.iceQueue.clear();
  }

  @HostListener('window:beforeunload') onBeforeUnload() { try { this.sendSig({ type: 'bye' }); } catch {} }
  @HostListener('window:resize') onResize() { this.isDesktop = window.innerWidth >= 1024; }

  // ====== Utilities ======
  private sendSig(payload: any & { to?: string }) { this.signaling.sendMessage({ ...payload }); }

  private initialsFromName(name: string): string {
    const parts = (name || '').trim().split(/\s+/);
    const letters = parts.slice(0, 2).map(s => (s[0] || '').toUpperCase());
    return letters.join('') || '?';
  }

  private participantChan(row: any): string | undefined { return row?.channel; }
  private asOffer(msg: any): RTCSessionDescriptionInit | null { return (msg?.offer && msg.offer.type && msg.offer.sdp) ? msg.offer : null; }
  private asAnswer(msg: any): RTCSessionDescriptionInit | null { return (msg?.answer && msg.answer.type && msg.answer.sdp) ? msg.answer : null; }
  private asCandidate(msg: any): RTCIceCandidateInit | null { return msg?.ice_candidate || null; }
  private senderChan(msg: any): string | undefined { return msg?.sender_channel || msg?.from; }
  private messageIsForMe(msg: any): boolean { return msg?.to ? msg.to === this.myServerChan : true; }

  // ====== Participants store helpers ======
  private syncParticipantsArray() {
    // locals last, so self is at the end
    this.participants = Array.from(this.participantsMap.values())
      .filter(p => p.channel !== '__you__')
      .concat(this.you ? [this.you] : []);

    // Debug view
    console.log('🔄 syncParticipantsArray:', this.participants.map(p => ({
      name: p.name,
      stream: !!p.stream,
      videoOn: p.videoOn,
      tracks: p.stream?.getTracks().length,
    })));
  }

  private makeLocalParticipant(name: string): Participant {
    return {
      name,
      mic: 'off',
      cam: 'off',
      videoOn: false,
      initials: this.initialsFromName(name),
      isYou: true,
      channel: '__you__',
      stream: null, // preview stream will be attached when camera turns on
      handRaised: false,
    };
  }

  private computeVideoOn(cam: CamState, stream?: MediaStream | null): boolean {
    if (cam !== 'on' || !stream) return false;
    const vt = stream.getVideoTracks();
    return vt.length > 0 && vt.some(t => t.enabled !== false);
  }

  private upsertParticipantFromPayload(row: any) {
    const ch = this.participantChan(row);
    if (!ch) return;
  
    // 🚫 Skip self
    if (this.myServerChan && ch === this.myServerChan) return;
  
    // 🚫 Deduplicate by name (fallback if server sends multiple channels)
    const existingByName = Array.from(this.participantsMap.values())
      .find(p => p.name === row?.name && !p.isYou);
  
    const prev = existingByName ?? this.participantsMap.get(ch);
  
    const nextCam: CamState = (row?.cam as CamState) ?? prev?.cam ?? 'off';
    const nextMic: MicState = (row?.mic as MicState) ?? prev?.mic ?? 'off';
  
    const next: Participant = {
      name: (row?.name ?? prev?.name ?? 'Guest'),
      mic: nextMic,
      cam: nextCam,
      videoOn: this.computeVideoOn(nextCam, prev?.stream),
      initials: this.initialsFromName(row?.name ?? prev?.name ?? 'Guest'),
      isYou: false,
      channel: prev?.channel ?? ch, // ✅ stick to the first channel we saw
      stream: prev?.stream ?? null,
      handRaised: (typeof row?.handRaised === 'boolean')
        ? row.handRaised
        : (prev?.handRaised ?? false),
    };
  
    this.participantsMap.set(next.channel, next);
    this.syncParticipantsArray();
  }
  
  

  private ensureParticipantStream(ch: string): MediaStream {
    const p = this.participantsMap.get(ch);
    if (p?.stream) return p.stream;
    const ms = new MediaStream();
    if (p) { const updated = { ...p, stream: ms, videoOn: this.computeVideoOn(p.cam, ms) }; this.participantsMap.set(ch, updated); }
    return ms;
  }

  // ====== Local media helpers ======
  private stopAndClearLocalTracks() {
    try { this.localVideoTrack?.stop(); } catch {}
    try { this.localAudioTrack?.stop(); } catch {}
    this.localVideoTrack = null;
    this.localAudioTrack = null;
    this.localPreviewStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    this.localPreviewStream = new MediaStream();

    // update local participant
    const me = this.participantsMap.get('__you__');
    if (me) {
      const updated: Participant = { ...me, cam: 'off', mic: 'off', stream: null, videoOn: false };
      this.participantsMap.set('__you__', updated);
      this.syncParticipantsArray();
    }
  }

  private refreshLocalPreview() {
    // Keep a stable stream instance; remove then add tracks to it
    const next = new MediaStream();
    if (this.localVideoTrack) next.addTrack(this.localVideoTrack);
    // intentionally not adding audio to preview to avoid echo

    this.localPreviewStream = next;

    const me = this.participantsMap.get('__you__');
    if (me) {
      const hasCam = this.localVideoTrack != null;
      const updated: Participant = {
        ...me,
        stream: hasCam ? this.localPreviewStream : null,
        videoOn: this.computeVideoOn(hasCam ? 'on' : 'off', hasCam ? this.localPreviewStream : null),
        cam: hasCam ? 'on' : 'off',
      };
      this.participantsMap.set('__you__', updated);
    }

    // Keep senders wired with replaceTrack
    this.peers.forEach(st => {
      try { st.audioSender.replaceTrack(this.localAudioTrack); } catch {}
      try { st.videoSender.replaceTrack(this.localVideoTrack); } catch {}
    });

    this.syncParticipantsArray();
  }

  // ====== Peer creation & negotiation ======
  private getOrCreatePeer(remoteChan: string): PeerState {
    let st = this.peers.get(remoteChan);
    if (st) return st;

    const pc = new RTCPeerConnection({
      iceServers: [
        // Google STUN (optional fallback)
        { urls: "stun:stun.l.google.com:19302" },
        // Your own STUN
        { urls: "stun:smartvid.live:3478" },
        // Your TURN with UDP/TCP/TLS
        {
          urls: [
            "turn:smartvid.live:3478?transport=udp",
            "turn:smartvid.live:5349?transport=tcp",
            "turns:smartvid.live:5349?transport=tcp"
          ],
          username: "test",
          credential: "test123"
        }
      ],
    });

    const at = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const vt = pc.addTransceiver('video', { direction: 'sendrecv' });

    const h264Codecs = RTCRtpSender.getCapabilities('video')?.codecs
  .filter(c => c.mimeType.toLowerCase() === 'video/h264')
  .filter(c => !c.sdpFmtpLine || c.sdpFmtpLine.includes("42e01f"));

    if (h264Codecs?.length && vt.setCodecPreferences) {
      vt.setCodecPreferences(h264Codecs);
      console.log("🎥 Forcing baseline H.264 codec:", h264Codecs);
    } else {
      console.warn("⚠️ H.264 baseline not available, using defaults");
    }

    st = {
      pc,
      makingOffer: false,
      ignoreOffer: false,
      polite: this.myPolite,
      audioSender: at.sender,
      videoSender: vt.sender,
      remoteChan,
      isSettingRemoteAnswerPending: false,
    };

    // Wire current local tracks
    try { st.audioSender.replaceTrack(this.localAudioTrack); } catch {}
    try { st.videoSender.replaceTrack(this.localVideoTrack); } catch {}

    pc.onnegotiationneeded = async () => {
      // Prevent glare / re-entrancy
      if (st.makingOffer || pc.signalingState !== 'stable') return;
      try {
        st.makingOffer = true;
        console.log('🧭 onnegotiationneeded → createOffer for', remoteChan);
        await pc.setLocalDescription(await pc.createOffer());
        this.sendSig({ type: 'offer', offer: pc.localDescription, to: remoteChan });
      } catch (err) {
        console.error('onnegotiationneeded error', err);
      } finally {
        st.makingOffer = false;
      }
    };
 

    // ontrack: always reuse the same MediaStream per participant
    pc.ontrack = (ev: RTCTrackEvent) => {
      console.log('📡 ontrack from', remoteChan, ev);
    
      // Always ensure we have a participant entry
      let pPrev = this.participantsMap.get(remoteChan);
    
      if (!pPrev) {
        // If no entry yet, create a shell participant with "Unknown"
        pPrev = {
          name: 'Unknown',
          initials: '?',
          mic: 'off',
          cam: 'off',
          videoOn: false,
          channel: remoteChan,
          isYou: false,
          stream: null,
          handRaised: false,
        };
      }
    
      // Always reuse the same MediaStream
      const ms = this.ensureParticipantStream(remoteChan);
    
      const already = ms.getTracks().some(t => t.id === ev.track.id);
      if (!already) ms.addTrack(ev.track);
    
      // Merge with existing participant info (name from server if it came earlier)
      const updated: Participant = {
        ...pPrev,
        stream: ms,
        mic: ms.getAudioTracks().length > 0 ? 'on' : 'off',
        cam: ms.getVideoTracks().length > 0 ? 'on' : 'off',
        videoOn: this.computeVideoOn(
          ms.getVideoTracks().length > 0 ? 'on' : 'off',
          ms
        ),
      };
    
      this.participantsMap.set(remoteChan, updated);
      this.syncParticipantsArray();
    };
    

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.sendSig({ type: 'ice_candidate', ice_candidate: candidate.toJSON?.() ?? candidate, to: remoteChan });
    };

    pc.onconnectionstatechange = () => { console.log('pc.connectionState for', remoteChan, '=', pc.connectionState); };

    this.peers.set(remoteChan, st);
    return st;
  }

  private async renegotiate(remoteChan: string) {
    const st = this.peers.get(remoteChan); if (!st) return;
    const pc = st.pc;
    if (st.makingOffer || pc.signalingState !== 'stable') return;
    try {
      st.makingOffer = true;
      console.log('manual renegotiate for', remoteChan);
      await pc.setLocalDescription(await pc.createOffer());
      this.sendSig({ type: 'offer', offer: pc.localDescription, to: remoteChan });
    } catch (err) {
      console.error('renegotiate error', err);
    } finally {
      st.makingOffer = false;
    }
  }

  private queueIce(remoteChan: string, cand: RTCIceCandidateInit) {
    const q = this.iceQueue.get(remoteChan) ?? []; q.push(cand); this.iceQueue.set(remoteChan, q);
  }
  private async flushIce(remoteChan: string) {
    const st = this.peers.get(remoteChan);
    if (!st || !st.pc.remoteDescription) return;
    const q = this.iceQueue.get(remoteChan); if (!q?.length) return;
    for (const c of q) { try { await st.pc.addIceCandidate(c); } catch {} }
    this.iceQueue.delete(remoteChan);
  }

  // ====== Incoming signaling ======
  private onSignal(msg: any) {
    if (!msg) return;

    if (msg.type === 'welcome') {
      this.myServerChan = msg.channel || msg.myServerChan || null;
      this.myPolite = !!msg.polite;
      const myName = this.you?.name || 'You';
      this.sendSig({ type: 'name_update', name: myName });
      console.log('✔️ Received welcome. My channel =', this.myServerChan, 'Polite =', this.myPolite);
      return;
    }

    switch (msg.type) {
      case 'participants': {
        const list: any[] = msg.participants || [];
        list.forEach(row => {
          const ch = this.participantChan(row); if (!ch) return;
          if (this.myServerChan && ch === this.myServerChan) return;
          if (!this.participantsMap.has(ch)) {
            this.upsertParticipantFromPayload(row);
            this.getOrCreatePeer(ch);
          }
        });
        break;
      }

      case 'participant_joined': {
        const row = msg.participant; const ch = this.participantChan(row); if (!ch) return;
        if (this.myServerChan && ch === this.myServerChan) return; // skip self
        if (!this.participantsMap.has(ch)) {
          this.upsertParticipantFromPayload(row);
          this.getOrCreatePeer(ch);
        }
        break;
      }

      case 'participant_left': {
        const ch = msg.channel; if (!ch) break;
        this.participantsMap.delete(ch);
        const st = this.peers.get(ch); if (st) { try { st.pc.close(); } catch {} this.peers.delete(ch); }
        this.syncParticipantsArray();
        break;
      }

      case 'participant_updated': {
        const row = msg.participant; const ch = this.participantChan(row); if (!ch) return;
        if (this.myServerChan && ch === this.myServerChan) return; // skip self
        this.upsertParticipantFromPayload(row);
        break;
      }

      case 'chat_message': {
        const payload = msg.message ?? {}; const text = payload.text ?? '';
        if (text) { const by = payload.by ?? 'Guest'; this.chatMessages = [...this.chatMessages, { by, text }]; setTimeout(() => this.scrollToBottom(), 0); }
        break;
      }

      case 'offer': {
        if (!this.messageIsForMe(msg)) return;
        const from = this.senderChan(msg); if (!from) return;
        const offer = this.asOffer(msg); if (!offer) return;
        const st = this.getOrCreatePeer(from); const pc = st.pc;

        (async () => {
          const offerCollision = (st.makingOffer || pc.signalingState !== 'stable');
          st.ignoreOffer = !st.polite && offerCollision;
          if (st.ignoreOffer) { console.log('ignoring offer from', from); return; }

          try {
            if (pc.signalingState !== 'stable') {
              await pc.setLocalDescription({ type: 'rollback' });
            }
            await pc.setRemoteDescription(offer);
            try { st.audioSender.replaceTrack(this.localAudioTrack); } catch {}
            try { st.videoSender.replaceTrack(this.localVideoTrack); } catch {}
            await pc.setLocalDescription(await pc.createAnswer());
            this.sendSig({ type: 'answer', answer: pc.localDescription, to: from });
            await this.flushIce(from);
          } catch (err) {
            console.error('error handling offer', err);
          }
        })();
        break;
      }

      case 'answer': {
        if (!this.messageIsForMe(msg)) return;
        const from = this.senderChan(msg); if (!from) return;
        const answer = this.asAnswer(msg); if (!answer) return;
        const st = this.peers.get(from); if (!st) return; const pc = st.pc;
        (async () => {
          try {
            st.isSettingRemoteAnswerPending = true;
            await pc.setRemoteDescription(answer);
            await this.flushIce(from);
          } catch (err) {
            console.error('error applying answer', err);
          } finally {
            st.isSettingRemoteAnswerPending = false;
          }
        })();
        break;
      }

      case 'ice_candidate': {
        if (!this.messageIsForMe(msg)) return;
        const from = this.senderChan(msg); if (!from) return;
        const cand = this.asCandidate(msg); if (!cand) return;
        const st = this.peers.get(from);
        if (!st) { this.queueIce(from, cand); return; }
        (async () => {
          try {
            if (st.pc.remoteDescription) await st.pc.addIceCandidate(cand);
            else this.queueIce(from, cand);
          } catch (e) {
            if (!st.ignoreOffer) console.error('error adding ICE', e);
          }
        })();
        break;
      }
    }
  }

  // ====== UI actions ======
  toggleChat(): void { this.chatCollapsed = !this.chatCollapsed; }
  closeChat(): void { this.chatCollapsed = true; }

  sendChat(): void {
    const text = this.chatText.trim(); if (!text) return;
    const by = this.you?.name || 'You';
    this.chatMessages = [...this.chatMessages, { by, text }];
    this.sendSig({ type: 'chat', by, text });
    this.chatText = '';
    setTimeout(() => this.scrollToBottom(), 0);
  }

  private scrollToBottom(): void {
    if (this.chatScroll) {
      this.chatScroll.nativeElement.scrollTop = this.chatScroll.nativeElement.scrollHeight;
    }
  }

  updateNameFirst(){
    if(!this.userName){
      alert("Please Enter User Name");
      return;
    }
    if(!this.termsCheckbox){
      alert("Please Enter User Name");
      return;
    }
    this.isNameUpdated = true;
    this.joinRoom();
  }

  updateName(e: Event): void {
    const v = (e.target as HTMLInputElement).value.trim() || 'You';
    const me = this.participantsMap.get('__you__');
    if (me) { this.participantsMap.set('__you__', { ...me, name: v, initials: this.initialsFromName(v) }); this.syncParticipantsArray(); }
    this.sendSig({ type: 'name_update', name: v });
  }

  async toggleMic(): Promise<void> {
    const me = this.participantsMap.get('__you__'); if (!me) return;
    const next: MicState = me.mic === 'on' ? 'off' : 'on';

    if (next === 'on') {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.localAudioTrack = s.getAudioTracks()[0] || null;
      } catch { alert('Microphone access denied.'); return; }
    } else {
      try { this.localAudioTrack?.stop(); } finally { this.localAudioTrack = null; }
    }

    // Update senders only; do not touch video flags
    this.peers.forEach(st => { try { st.audioSender.replaceTrack(this.localAudioTrack); } catch {} });

    // Update local participant mic flag only
    this.participantsMap.set('__you__', { ...me, mic: next });
    this.syncParticipantsArray();
    this.sendSig({ type: 'mic_toggle', mic: next });
  }

  async toggleCam(): Promise<void> {
    const me = this.participantsMap.get('__you__'); if (!me) return;
    const turningOn = me.cam === 'off';

    if (turningOn) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.localVideoTrack = s.getVideoTracks()[0] || null;
        if (this.localVideoTrack) {
          this.localVideoTrack.enabled = true;
          this.localVideoTrack.onended = () => {
            this.localVideoTrack = null;
            this.refreshLocalPreview();
            this.participantsMap.set('__you__', { ...this.participantsMap.get('__you__')!, cam: 'off' });
            this.syncParticipantsArray();
            this.sendSig({ type: 'cam_toggle', cam: 'off' });
            this.peers.forEach((_st, ch) => this.renegotiate(ch));
          };
        }
      } catch (e: any) { alert('Camera access error: ' + (e?.message || e)); return; }
    } else {
      try { this.localVideoTrack?.stop(); } finally { this.localVideoTrack = null; }
    }

    // Update preview stream + senders and derive UI flags
    this.refreshLocalPreview();

    const me2 = this.participantsMap.get('__you__')!;
    const nextCam: CamState = turningOn ? 'on' : 'off';
    const updated: Participant = {
      ...me2,
      cam: nextCam,
      videoOn: this.computeVideoOn(nextCam, me2.stream),
    };
    this.participantsMap.set('__you__', updated);
    this.syncParticipantsArray();

    this.sendSig({ type: 'cam_toggle', cam: nextCam });
    this.peers.forEach((_st, ch) => this.renegotiate(ch));
  }

  async shareScreen(): Promise<void> {
    try {
      const screenStream: MediaStream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0]; if (!screenTrack) return;

      try { this.localVideoTrack?.stop(); } catch {}
      this.localVideoTrack = screenTrack;

      // when screen share ends, fall back to camera-off state
      screenTrack.onended = () => {
        this.localVideoTrack = null;
        this.refreshLocalPreview();
        const me = this.participantsMap.get('__you__'); if (me) {
          this.participantsMap.set('__you__', { ...me, cam: 'off', videoOn: false });
          this.syncParticipantsArray();
        }
        this.sendSig({ type: 'cam_toggle', cam: 'off' });
        this.peers.forEach((_st, ch) => this.renegotiate(ch));
      };

      this.refreshLocalPreview();
      const me = this.participantsMap.get('__you__'); if (me) {
        const up = { ...me, cam: 'on', videoOn: this.computeVideoOn('on', this.localPreviewStream) } as Participant;
        this.participantsMap.set('__you__', up);
        this.syncParticipantsArray();
      }

      this.sendSig({ type: 'cam_toggle', cam: 'on' });
      this.peers.forEach((_st, ch) => this.renegotiate(ch));
    } catch { alert('Screen share failed.'); }
  }

  cycleLayout(): void {
    if (this.tileColsManual == null) this.tileColsManual = 1;
    else if (this.tileColsManual < 4) this.tileColsManual += 1;
    else this.tileColsManual = null;
  }

  leaveCall(): void {
    this.sendSig({ type: 'bye' });
    // 3. Stop your local media tracks
    if (this.you?.stream) {
      this.you.stream.getTracks().forEach(track => track.stop());
    }
    this.peers.forEach(({ pc }) => { try { pc.close(); } catch {} });
    this.peers.clear();
    this.participantsMap.forEach((_p, ch) => { if (ch !== '__you__') this.participantsMap.delete(ch); });
    this.participantsMap.delete('__you__');
    this.syncParticipantsArray();

    this.isNameUpdated = false; 
  }

  raiseHand(): void {
    const me = this.participantsMap.get('__you__'); if (!me) return;
    const next = !me.handRaised; this.participantsMap.set('__you__', { ...me, handRaised: next });
    this.syncParticipantsArray();
    this.sendSig({ type: 'hand_toggle', handRaised: next });
  }

  get shouldShowSelfVideo(): boolean {
    // Show PiP if you have a self video stream
    // and there are other participants (so you’re not alone in the call)
    return !!this.you?.videoOn && !!this.you?.stream && this.gridParticipants.length > 0;
  }

  trackByParticipant(index: number, item: Participant): string { return item.channel; }
}





