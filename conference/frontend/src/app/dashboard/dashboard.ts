
// src/app/dashboard/dashboard.ts (refactor — stable media, clearer state)
import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  HostListener,
  Directive,
  ElementRef,
  Input,
  ViewChild,
  NgZone,
  ChangeDetectorRef, 
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SignalingService } from './signaling.service';
import { Subscription } from 'rxjs';
import { SrcObjectDirective } from './src-object.directive';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { NotepadComponent } from './notepad.component';
import {
  startGazeTracking,
  stopGazeTracking,
  startCalibration,
  GazeStatus
} from './gazeTracker';
// Add near other imports at top of file
import { initModel, blobToAudioBuffer, Embedding } from './voiceAnalyzer';
import { VoiceService } from './voice.service';
import { HttpClientModule } from '@angular/common/http';

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
  gaze: string;
  voice: string; // Voice match percentage
}

interface ChatMessage { by: string; text: string; }

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
  imports: [CommonModule, FormsModule, MediaSrcObjectDirective, SrcObjectDirective, DragDropModule, NotepadComponent, HttpClientModule],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.scss'],
  providers: [SignalingService, VoiceService],
})
export class Dashboard implements OnInit, OnDestroy, AfterViewInit {
  // ==============voice detection helper==============
  private _pendingChunks: Blob[] = [];
  private _lastVerifyTime = 0;
  private _lastMatchPct = 0;
  private readonly VAD_THRESHOLD = 0.03;
  private readonly SPEECH_MIN_FRAMES = 0.2;
  private readonly BATCH_WINDOW_MS = 10000;

  enrollmentInProgress = false;
  isEnrollmentComplete = true;
  isRecording = false;
  currentPrompt = '';
  takeIndex = 0;
  totalTakes = 3;
  prompts: string[] = [
    "Please read aloud: 'I confirm my identity and consent to voice authentication for secure access to this platform.'",
    "Please read aloud: 'My voice signature is unique and will be used to verify my identity during this session.'",
    "Please read aloud: 'I understand that voice biometrics enhance security and protect against unauthorized access.'"
  ];
  recordedSamples: Blob[] = [];
  statusMessage = 'Click "Start Enrollment" to begin.';
  progressPercent = 0;
 
  // ====== UI state ======
  isDesktop = window.innerWidth >= 1024;
  chatCollapsed = true;
  participants: Participant[] = [];
  chatMessages: ChatMessage[] = [];
  chatText = '';
  tileColsManual: number | null = null;
  public roomName = 'testroom';
  activeTab: 'participants' | 'chat' = 'chat';
  isNameUpdated = false;
  @ViewChild('chatScroll') chatScroll!: ElementRef;
  @ViewChild('enrollmentVideo') enrollmentVideo?: ElementRef<HTMLVideoElement>;
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
  monitorLoopRunning: boolean = false;
  gazeThresholds: { horizontal: any; vertical: any; } | undefined;
  isNotesOpen: boolean = false;
  
  // Voice recognition state
  isRecordingVoice: boolean = false;
  voiceRecordingProgress: number = 0;
  hasVoiceBaseline: boolean = false;
  isVoiceMonitoring: boolean = false;
  voice: string = 'N/A';
  
  // MediaRecorder-based voice
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];
  private verificationTimer: any = null;
  private readonly RECORD_MS = 4000; // 2-second chunks
  private readonly ENROLL_SAMPLES = 3;
  private readonly VERIFICATION_WINDOW = 3;
  private verificationScores: number[] = [];
  private ngZone: NgZone;
  
  // Face capture during enrollment
  enrollmentCameraStream: MediaStream | null = null;
  showEnrollmentCamera: boolean = false;
  facePositionCorrect: boolean = true;
  facePositionMessage: string = '';
  currentReadingText: string = '';
  private faceDetectionInterval: any = null;
  enrollmentSuccessCount: number = 0;
  
  // Professional reading texts for each sample
  private readonly READING_TEXTS = [
    "Please read aloud: 'I confirm my identity and consent to voice authentication for secure access to this platform.'",
    "Please read aloud: 'My voice signature is unique and will be used to verify my identity during this session.'",
    "Please read aloud: 'I understand that voice biometrics enhance security and protect against unauthorized access.'"
  ];
  private _batchStartTime: number | undefined;
  private chunks: BlobPart[] = [];

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
    // Show only remote participants if there are others in the room
    // Show yourself only if you're alone
    const remotes = this.participants.filter(p => !p.isYou);
    if (remotes.length > 0) {
      return remotes; // Show only others when not alone
    }
    return this.participants; // Show yourself when alone
  }

  get canUseRecorder(): boolean {
    return !!this.mediaRecorder && this.enrollmentInProgress;
  }

  //========= GazeTracking ==============
  private gazeSocket?: WebSocket;
  private isGazeTracking = false;
  
  //========= Fullscreen ==============
  private escPressCount = 0;
  private escPressTimer: any = null;
  private hasShownEscAlert = false;
  private isInFullscreen = false;
  private fullscreenChangeHandler: (() => void) | null = null;
  
  //========= Permissions ==============
  showPermissionPopup = false;
  permissionStatus = {
    camera: false,
    microphone: false
  };

  constructor(
    private signaling: SignalingService, 
    ngZone: NgZone,
    private voiceService: VoiceService,
    private cdr: ChangeDetectorRef
  ) {
    this.ngZone = ngZone;
    // try to init model early (non-blocking)
    initModel().catch(err => console.warn('Model init (background) failed:', err));
  }

  // ====== Lifecycle ======
  async ngOnInit(): Promise<void> {
    await this.checkMediaPermissions();
  }
  
  ngAfterViewInit(): void {
    // Setup enrollment video element when it becomes available
    if (this.enrollmentVideo?.nativeElement && this.enrollmentCameraStream) {
      const video = this.enrollmentVideo.nativeElement;
      video.srcObject = this.enrollmentCameraStream;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.play().catch(err => console.warn('Video play error:', err));
    }
  }

  joinRoom(){
    // Create a single stable preview stream instance
    this.localPreviewStream = new MediaStream();

    this.participantsMap.set('__you__', this.makeLocalParticipant(this.userName));
    this.syncParticipantsArray();

    // connect to signaling server
    this.signaling.connect(this.roomName);
    this.signalingSub = this.signaling.messages$.subscribe((msg: any) => this.onSignal(msg));
    
    // Setup fullscreen listener
    this.setupFullscreenListener();
    
    // Enter fullscreen mode
    this.enterFullscreen();
  }
  ngOnDestroy(): void {
    try { this.sendSig({ type: 'bye' }); } catch {}
    stopGazeTracking();
    this.stopAllStreams();
    this.signalingSub?.unsubscribe();
    this.signaling.disconnect();

    this.peers.forEach(st => { try { st.pc.close(); } catch {} });
    this.peers.clear();

    this.stopAndClearLocalTracks();

    this.participantsMap.clear();
    this.iceQueue.clear();
    
    // Remove fullscreen listener
    this.removeFullscreenListener();
  }

  private handleGazeStatus(status: GazeStatus) {
    const me = this.participantsMap.get('__you__');
    if (me) {
      const updated = { ...me, gaze: status };
      this.participantsMap.set('__you__', updated);
      this.syncParticipantsArray();
    }
  }

  @HostListener('window:beforeunload') onBeforeUnload() { 
    try { 
      this.sendSig({ type: 'bye' }); 
      stopGazeTracking();
      this.signaling.disconnect();
    } catch {} 
  }
  
  @HostListener('window:resize') onResize() { 
    this.isDesktop = window.innerWidth >= 1024; 
  }
  
  @HostListener('document:keydown.escape')
  onEscapeKey() {
    if (!this.isNameUpdated) return; // Only handle ESC when in call
    
    // Only handle ESC when NOT in fullscreen (browser handles it in fullscreen)
    if (this.isInFullscreen) return;
    
    this.escPressCount++;
    
    if (this.escPressCount === 1 && !this.hasShownEscAlert) {
      // First ESC press - show alert
      alert('You are not allowed to pres ESC key, If you do so it will notify interviewer immidiately.');
      this.hasShownEscAlert = true;
      
      // Reset counter after 2 seconds
      if (this.escPressTimer) clearTimeout(this.escPressTimer);
      this.escPressTimer = setTimeout(() => {
        this.escPressCount = 0;
      }, 2000);
    } else if (this.escPressCount >= 2) {
      // Second ESC press - exit fullscreen
      this.exitFullscreen();
      this.escPressCount = 0;
      if (this.escPressTimer) clearTimeout(this.escPressTimer);
    }
  }
  
  private setupFullscreenListener() {
    this.fullscreenChangeHandler = () => {
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      
      const wasFullscreen = this.isInFullscreen;
      this.isInFullscreen = isCurrentlyFullscreen;
      
      // Detect when user exits fullscreen via ESC key
      if (wasFullscreen && !isCurrentlyFullscreen && this.isNameUpdated) {
        this.escPressCount++;
        
        if (this.escPressCount === 1 && !this.hasShownEscAlert) {
          // First ESC press - show alert and re-enter fullscreen
          alert('Press ESC again to exit fullscreen');
          this.hasShownEscAlert = true;
          this.enterFullscreen();
          
          // Reset counter after 2 seconds
          if (this.escPressTimer) clearTimeout(this.escPressTimer);
          this.escPressTimer = setTimeout(() => {
            this.escPressCount = 0;
          }, 2000);
        } else if (this.escPressCount >= 2) {
          // Second ESC press - allow exit
          this.escPressCount = 0;
          if (this.escPressTimer) clearTimeout(this.escPressTimer);
          // Don't re-enter fullscreen, let it exit
        }
      }
    };
    
    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('mozfullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('MSFullscreenChange', this.fullscreenChangeHandler);
  }
  
  private removeFullscreenListener() {
    if (this.fullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('mozfullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('MSFullscreenChange', this.fullscreenChangeHandler);
      this.fullscreenChangeHandler = null;
    }
  }

  // ====== Utilities ======
  private sendSig(payload: any & { to?: string }) { 
    this.signaling.sendMessage({ ...payload }); 
  }

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
      gaze: '',
      voice: 'N/A',
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
    
    // Use existing stream if available, otherwise it will be set when tracks arrive
    const existingStream = prev?.stream ?? null;
  
    const next: Participant = {
      name: (row?.name ?? prev?.name ?? 'Guest'),
      mic: nextMic,
      cam: nextCam,
      videoOn: existingStream ? this.computeVideoOn(nextCam, existingStream) : false,
      initials: this.initialsFromName(row?.name ?? prev?.name ?? 'Guest'),
      isYou: false,
      channel: prev?.channel ?? ch, // ✅ stick to the first channel we saw
      stream: existingStream,
      gaze: row?.gaze ?? prev?.gaze ?? '',
      voice: row?.voice ?? prev?.voice ?? 'N/A',
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
        await pc.setLocalDescription(await pc.createOffer());
        this.sendSig({ type: 'offer', offer: pc.localDescription, to: remoteChan });
      } catch (err) {
        console.error('Negotiation error:', err);
      } finally {
        st.makingOffer = false;
      }
    };
   

    // ontrack: always reuse the same MediaStream per participant
    pc.ontrack = (ev: RTCTrackEvent) => {
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
          gaze: '',
          voice: 'N/A',
        };
      }
    
      // Always reuse the same MediaStream
      const ms = this.ensureParticipantStream(remoteChan);
    
      const already = ms.getTracks().some(t => t.id === ev.track.id);
      if (!already) ms.addTrack(ev.track);
    
      // DON'T override cam/mic state from server - only update if we don't have it yet
      // The server's participant_updated messages are the source of truth for cam/mic state
      const updated: Participant = {
        name: pPrev.name,
        initials: pPrev.initials,
        isYou: pPrev.isYou,
        channel: pPrev.channel,
        handRaised: pPrev.handRaised,
        gaze: pPrev.gaze,
        voice: pPrev.voice,
        stream: ms,
        // Only update mic/cam if they were at default 'off' (meaning we haven't received server state yet)
        mic: pPrev.mic !== 'off' ? pPrev.mic : (ms.getAudioTracks().length > 0 ? 'on' : 'off'),
        cam: pPrev.cam !== 'off' ? pPrev.cam : (ms.getVideoTracks().length > 0 ? 'on' : 'off'),
        // videoOn should be based on the cam state from server, not just presence of tracks
        videoOn: this.computeVideoOn(pPrev.cam, ms),
      };
    
      this.participantsMap.set(remoteChan, updated);
      this.syncParticipantsArray();
    };
    

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.sendSig({ type: 'ice_candidate', ice_candidate: candidate.toJSON?.() ?? candidate, to: remoteChan });
    };

    pc.onconnectionstatechange = () => { 
      if (pc.connectionState === 'failed') {
        console.error('Connection failed for', remoteChan);
      }
    };

    this.peers.set(remoteChan, st);
    return st;
  }

  private async renegotiate(remoteChan: string) {
    const st = this.peers.get(remoteChan); if (!st) return;
    const pc = st.pc;
    if (st.makingOffer || pc.signalingState !== 'stable') return;
    try {
      st.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      this.sendSig({ type: 'offer', offer: pc.localDescription, to: remoteChan });
    } catch (err) {
      console.error('Renegotiation error:', err);
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
            
            // Trigger renegotiation to send our current tracks to existing participants
            setTimeout(() => this.renegotiate(ch), 100);
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
          
          // Trigger renegotiation to send our current tracks to the new participant
          setTimeout(() => this.renegotiate(ch), 100);
          
          this.monitorSelfVideo();
        }
        break;
      }

      case 'participant_left': {
        const ch = msg.channel; if (!ch) break;
        this.participantsMap.delete(ch);
        const st = this.peers.get(ch); if (st) { try { st.pc.close(); } catch {} this.peers.delete(ch); }
        this.syncParticipantsArray();
        this.monitorSelfVideo();
        break;
      }

      case 'participant_updated': {
        const row = msg.participant; const ch = this.participantChan(row); if (!ch) return;
        if (this.myServerChan && ch === this.myServerChan) return; // skip self
        
        // Get previous state to detect cam/mic changes
        const prev = this.participantsMap.get(ch);
        const prevCam = prev?.cam;
        const prevMic = prev?.mic;
        
        // Update participant state
        this.upsertParticipantFromPayload(row);
        
        // Get updated state
        const updated = this.participantsMap.get(ch);
        const camChanged = updated && prevCam !== updated.cam;
        const micChanged = updated && prevMic !== updated.mic;
        
        // If cam or mic state changed, trigger renegotiation to update tracks
        if (camChanged || micChanged) {
          console.log(`🔄 Participant ${ch} changed cam:${prevCam}→${updated?.cam} mic:${prevMic}→${updated?.mic}, renegotiating...`);
          setTimeout(() => this.renegotiate(ch), 100);
        }
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
          if (st.ignoreOffer) return;

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

      case "gaze_update": {
        const ch = msg.channel;
        const g = msg.gaze;
      
        if (ch && this.participantsMap.has(ch)) {
          const p = this.participantsMap.get(ch)!;
          this.participantsMap.set(ch, { ...p, gaze: g });
          this.syncParticipantsArray();
        } else {
          const p = this.participants.find(pp => pp.name === msg.user);
          if (p) {
            p.gaze = g;
            this.syncParticipantsArray();
          }
        }
        break;
      }

      case "voice_update": {
        const ch = msg.channel;
        const v = msg.voice;
      
        if (ch && this.participantsMap.has(ch)) {
          const p = this.participantsMap.get(ch)!;
          this.participantsMap.set(ch, { ...p, voice: v });
          this.syncParticipantsArray();
        } else {
          const p = this.participants.find(pp => pp.name === msg.user);
          if (p) {
            p.voice = v;
            this.syncParticipantsArray();
          }
        }
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

  async updateNameFirst(){
    if(!this.userName){
      alert("Please Enter User Name");
      return;
    }
    if(!this.termsCheckbox){
      alert("Please accept Terms & Conditions");
      return;
    }
    
    // Check if voice baseline was recorded
    if (!this.hasVoiceBaseline) {
      alert("Please record your voice sample first");
      return;
    }
    
    this.isNameUpdated = true;
    this.joinRoom();
  }

  // ============ Voice Integration (MediaRecorder-based) ============

  private isSecureContext(): boolean {
    const origin = window.location.origin;
    return origin.startsWith('https://') || origin.includes('localhost') || origin.includes('127.0.0.1');
  }

  private async requestMicrophone(): Promise<MediaStream> {
    if (!this.isSecureContext()) {
      throw new Error('Microphone requires secure origin (https) or localhost');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Browser does not support getUserMedia');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
      this.mediaStream = stream;
      this.permissionStatus.microphone = true;
      return stream;
    } catch (err: any) {
      this.permissionStatus.microphone = false;
      if (err && err.name === 'NotAllowedError') throw new Error('Microphone permission denied, please allow mic access in the browser');
      if (err && err.name === 'NotFoundError') throw new Error('No microphone found');
      throw new Error(err?.message || 'Could not get microphone');
    }
  }

  private stopAllStreams(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.mediaRecorder) {
      try { this.mediaRecorder.stop(); } catch (_) {}
      this.mediaRecorder = null;
    }
    this.isRecordingVoice = false;
    this.isVoiceMonitoring = false;
  }

  // ---------------- Enrollment (baseline) flows ----------------

  // public async startEnrollment(): Promise<void> {
  //   try {
  //     if (this.isRecordingVoice) return;
      
  //     // ensure model loaded
  //     await initModel();
      
  //     // Start camera for face capture
  //     await this.startEnrollmentCamera();
      
  //     // request mic
  //     await this.requestMicrophone();

  //     // prepare MediaRecorder capturing 2s segments
  //     this.audioChunks = [];
  //     const options: MediaRecorderOptions = { 
  //        mimeType: 'audio/webm;codecs=opus',
  //        audioBitsPerSecond: 128000,
  //     };
  //     this.mediaRecorder = new MediaRecorder(this.mediaStream as MediaStream, options);

  //     this.mediaRecorder.ondataavailable = (ev: BlobEvent) => {
  //       if (ev.data && ev.data.size > 0) this.audioChunks.push(ev.data);
  //     };

  //     this.mediaRecorder.onstop = async () => {
  //       if (this.audioChunks.length === 0) return;
  //       const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
  //       this.audioChunks = [];
        
  //       // Send to backend for enrollment
  //       this.voiceService.enrollVoice(blob, this.roomName, this.userName).subscribe({
  //         next: (response) => {
  //           if (response.success) {
  //             this.enrollmentSuccessCount++;
  //             this.voiceRecordingProgress++;
  //             console.log('✅ Enrollment sample captured:', this.voiceRecordingProgress);
  //           } else {
  //             console.error('❌ Enrollment failed:', response.message);
  //             alert('Failed to enroll voice sample: ' + response.message);
  //           }
  //         },
  //         error: (err) => {
  //           console.error('❌ Enrollment API error:', err);
  //           alert('Failed to enroll voice sample. Please try again.');
  //         }
  //       });
  //     };

  //     // Start simple loop: start recorder, wait RECORD_MS, stop, repeat until user clicks Record
  //     this.isRecordingVoice = true;
  //     this.showEnrollmentCamera = true;
  //     this.enrollmentSuccessCount = 0;
      
  //     // Set initial reading text
  //     this.updateReadingText();
      
  //     console.log('Enrollment started — click Record (2s) to capture a sample');
  //   } catch (err: any) {
  //     alert('Could not start enrollment: ' + (err.message || err));
  //     this.isRecordingVoice = false;
  //     this.stopAllStreams();
  //     this.stopEnrollmentCamera();
  //   }
  // }

  async startEnrollment(): Promise<void> {
    if (this.enrollmentInProgress) {
      return;
    }

    this.stopStream();
    this.enrollmentInProgress = true;
    this.isEnrollmentComplete = false;
    this.isRecording = false;
    this.takeIndex = 0;
    this.recordedSamples = [];
    this.chunks = [];
    this.currentPrompt = '';
    this.hasVoiceBaseline = false;
    this.statusMessage = 'Preparing microphone...';
    this.progressPercent = 0;
    this.cdr.markForCheck();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaStream = stream;
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      this.mediaRecorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        if (this.chunks.length === 0) {
          this.ngZone.run(() => {
            this.statusMessage = 'No audio captured. Please try again.';
            this.cdr.markForCheck();
          });
          this.chunks = [];
          return;
        }

        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        this.recordedSamples.push(blob);
        this.chunks = [];

        const samplesCollected = this.recordedSamples.length;

        this.ngZone.run(() => {
          this.progressPercent = Math.round((samplesCollected / this.totalTakes) * 100);
          this.cdr.markForCheck();
        });

        if (samplesCollected >= this.totalTakes) {
          await this.finalizeEnrollment();
          return;
        }

        this.ngZone.run(() => {
          this.takeIndex = samplesCollected;
          this.currentPrompt = this.prompts[samplesCollected];
          this.statusMessage = 'Click "Record" again, then Read the next text.';
          this.cdr.markForCheck();
        });
      };

      this.currentPrompt = this.prompts[0];
      this.statusMessage = 'Click "Record, then Read the text aloud.';
      this.cdr.markForCheck();
    } catch (error) {
      console.error('Mic access error', error);
      this.statusMessage = 'Microphone access failed.';
      this.enrollmentInProgress = false;
      this.stopStream();
      this.cdr.markForCheck();
    }
  }

  async handleRecordClick(): Promise<void> {
    if (!this.enrollmentInProgress || !this.mediaRecorder) {
      return;
    }

    if (this.isRecording) {
      this.isRecording = false;
      try {
        this.mediaRecorder.stop();
        this.statusMessage = 'Processing recording...';
      } catch (error) {
        console.error('MediaRecorder stop error', error);
        this.statusMessage = 'Unable to stop recording. Please try again.';
      }
      this.cdr.markForCheck();
      return;
    }

    this.isRecording = true;
    this.chunks = [];
    try {
      this.mediaRecorder.start();
      this.statusMessage = 'Recording... speak clearly.';
    } catch (error) {
      console.error('MediaRecorder start error', error);
      this.isRecording = false;
      this.statusMessage = 'Unable to start recording.';
    }
    this.cdr.markForCheck();
  }

  async finalizeEnrollment(): Promise<void> {
    let timeoutId: number | undefined;
    const controller = new AbortController();

    try {
      this.enrollmentInProgress = false;
      this.statusMessage = 'Uploading samples for enrollment...';
      this.cdr.markForCheck();

      const form = new FormData();
      this.recordedSamples.forEach((blob, index) => {
        form.append('files', blob, `sample${index + 1}.webm`);
      });
      form.append('room', this.roomName || 'default');
      form.append('username', this.userName || 'guest');

      const headers: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        headers['X-CSRFToken'] = csrfToken;
      }

      timeoutId = window.setTimeout(() => controller.abort(), 20000);

      const response = await fetch('/video-call/api/voice/enroll-batch', {
        method: 'POST',
        body: form,
        headers,
        credentials: 'same-origin',
        signal: controller.signal,
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      let result: any = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (response.ok && result?.success) {
        this.statusMessage = 'Enrollment complete! Voice profile ready.';
        this.progressPercent = 100;
        this.hasVoiceBaseline = true;
      } else {
        const message = result?.message ?? response.statusText ?? 'Unknown error';
        this.statusMessage = `Enrollment failed: ${message}`;
        this.hasVoiceBaseline = false;
      }
    } catch (error) {
      console.error('Enrollment error', error);
      this.statusMessage = 'Enrollment failed (network or server issue).';
      this.hasVoiceBaseline = false;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.stopStream();
      this.isEnrollmentComplete = true;
      this.isRecording = false;
      this.currentPrompt = '';
      this.takeIndex = 0;
      this.recordedSamples = [];
      this.cdr.markForCheck();
    }
  }

  private stopStream(): void {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    } catch (error) {
      console.warn('MediaRecorder stop warning:', error);
    } finally {
      this.mediaRecorder = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    this.chunks = [];
    this.isRecording = false;
  }

  private getCsrfToken(): string | null {
    if (typeof document === 'undefined') {
      return null;
    }
    const match = document.cookie.match(/(^|;)\s*csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[2]) : null;
  }

  public async captureBaselineSample(): Promise<void> {
    if (!this.isRecordingVoice || !this.mediaRecorder) {
      alert('Please start enrollment first');
      return;
    }
    try {
      await new Promise(r => setTimeout(r, 300)); // allow mic to stabilize
      this.mediaRecorder.start();
      // stop after configured ms
      setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
          // Update reading text for next sample
          setTimeout(() => this.updateReadingText(), 500);
        }
      }, this.RECORD_MS);
    } catch (err) {
      console.error('MediaRecorder start error:', err);
    }
  }

  public finishEnrollment(): void {
    if (!this.isRecordingVoice) return;

    if (this.voiceRecordingProgress < this.ENROLL_SAMPLES) {
      alert(`Please record at least ${this.ENROLL_SAMPLES} samples (currently ${this.voiceRecordingProgress})`);
      return;
    }
    
    // Check if all samples were successful
    if (this.enrollmentSuccessCount < this.ENROLL_SAMPLES) {
      alert(`Please wait for all samples to be processed successfully (${this.enrollmentSuccessCount}/${this.ENROLL_SAMPLES} completed)`);
      return;
    }

    // Backend has already stored and averaged the embeddings
    this.hasVoiceBaseline = true;

    // Cleanup and stop mic
    this.isRecordingVoice = false;
    this.voiceRecordingProgress = 0;
    this.enrollmentSuccessCount = 0;
    try { this.mediaStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
    this.mediaStream = null;
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try { this.mediaRecorder.stop(); } catch (_) {}
    }
    this.mediaRecorder = null;
    
    // Stop enrollment camera
    this.stopEnrollmentCamera();
  }

  // ---------------- Verification (monitoring) flows ----------------

  public async startVerification(): Promise<void> {
    try {
      if (!this.hasVoiceBaseline) {
        alert('No baseline enrolled. Please enroll first.');
        return;
      }
      await initModel();
      await this.requestMicrophone();

      // setup MediaRecorder for continuous periodic recordings
      this.mediaRecorder = new MediaRecorder(this.mediaStream as MediaStream, { mimeType: 'audio/webm;codecs=opus' });
      this.mediaRecorder.ondataavailable = async (ev: BlobEvent) => {
        try {
          // --- 1️⃣ Skip if mic muted or no data ---
          if (!this.localAudioTrack || !this.localAudioTrack.enabled) return;
          if (!ev.data || ev.data.size < 2000) return;

          // --- 2️⃣ Decode audio and run RMS + speech activity detection ---
          const arrayBuffer = await ev.data.arrayBuffer();
          const audioCtx = new AudioContext();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const samples = audioBuffer.getChannelData(0);
          const rms = Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length);
          audioCtx.close();

          // Helper: detect if person is actually speaking (short-term energy)
          const windowSize = 1024;
          let activeFrames = 0;
          for (let i = 0; i < samples.length; i += windowSize) {
            const slice = samples.subarray(i, i + windowSize);
            const frameRms = Math.sqrt(slice.reduce((s, x) => s + x * x, 0) / slice.length);
            if (frameRms > 0.03) activeFrames++;
          }
          const speechActive = activeFrames > samples.length / windowSize * 0.2; // ≥20% active frames

          if (!speechActive || rms < 0.015) {
            console.log(`🤫 Silence or no speech (RMS=${rms.toFixed(4)}) — skipping verification`);
            return;
          }

          // --- 3️⃣ Accumulate chunks for ~10 seconds before sending ---
          const now = Date.now();
          if (!this._pendingChunks) this._pendingChunks = [];
          if (!this._batchStartTime) this._batchStartTime = now;

          this._pendingChunks.push(ev.data);
          const durationSinceBatch = now - this._batchStartTime;

          if (durationSinceBatch < 10000) {
            // keep accumulating for up to 10 seconds
            return;
          }

          // --- 4️⃣ Throttle based on last match confidence ---
          const lastSent = this._lastVerifyTime || 0;
          const elapsed = now - lastSent;
          let interval = 5000; // base interval
          if (this._lastMatchPct > 85) interval = 8000; // confident speaker
          else if (this._lastMatchPct < 65) interval = 3000; // low confidence → verify more often

          if (elapsed < interval) {
            console.log(`⏱️ Skipping verify — only ${Math.round(elapsed / 1000)}s since last`);
            return;
          }

          // --- 5️⃣ Send combined blob for verification ---
          const combinedBlob = new Blob(this._pendingChunks, { type: 'audio/webm' });
          this._pendingChunks = [];
          this._batchStartTime = now;
          this._lastVerifyTime = now;

          console.log(`🎤 Sending ${Math.round(durationSinceBatch / 1000)}s of speech for verification...`);

          this.voiceService.verifyVoice(combinedBlob, this.roomName, this.userName).subscribe({
            next: (response) => {
              if (response.success && response.percentage !== undefined) {
                const pct = response.percentage;
                this._lastMatchPct = pct;

                // Rolling weighted average
                this.verificationScores.push(pct);
                if (this.verificationScores.length > this.VERIFICATION_WINDOW)
                  this.verificationScores.shift();

                const weights = this.verificationScores.map((_, i, arr) => (i + 1) / arr.length);
                const avg = Math.round(
                  this.verificationScores.reduce((a, b, i) => a + b * weights[i], 0)
                );

                this.ngZone.run(() => {
                  this.voice = response.status === 'high_confidence' ? 'Match' : 'Unmatch';
                  console.log('🎤 Voice match:', this.voice, `(Status: ${response.status})`);

                  const me = this.participantsMap.get('__you__');
                  if (me) {
                    this.participantsMap.set('__you__', { ...me, voice: this.voice });
                    this.syncParticipantsArray();
                  }

                  this.sendSig({
                    type: 'voice_update',
                    user: this.userName,
                    voice: this.voice,
                    ts: Date.now(),
                  });
                });

                if (avg < 65) {
                  console.warn('⚠️ Possible mismatch detected — avg:', avg + '%');
                }
              } else {
                console.error('❌ Verification failed:', response.message);
              }
            },
            error: (err) => {
              console.error('❌ Verification API error:', err);
            },
          });
        } catch (err) {
          console.error('Error analyzing chunk:', err);
        }
      };



      // Start periodic recording loop — start MediaRecorder, stop after ms, then restart.
      this.isVoiceMonitoring = true;
      await new Promise(r => setTimeout(r, 300));
      this.mediaRecorder.start();
      // We will use interval to restart recording to ensure contiguous segments (works cross-browser)
      this.verificationTimer = setInterval(() => {
        if (!this.mediaRecorder) return;
        if (this.mediaRecorder.state === 'recording') {
          try { this.mediaRecorder.stop(); } catch (_) {}
          // restart after tiny gap to allow dataavailable to fire
          setTimeout(() => {
            if (this.mediaRecorder && this.isVoiceMonitoring) {
              try { this.mediaRecorder.start(); } catch (_) {}
            }
          }, 150);
        } else {
          try { this.mediaRecorder.start(); } catch (err) { console.warn('recorder start err', err); }
        }
      }, this.RECORD_MS + 200);

      alert('Verification started — speak to verify your voice.');
    } catch (err: any) {
      alert('Could not start verification: ' + (err.message || err));
      this.stopVerification();
    }
  }

  public stopVerification(): void {
   try {
    this.mediaRecorder?.stop();
  } catch (_) {}

  if (this.mediaStream) {
    this.mediaStream.getTracks().forEach(t => {
      try { t.stop(); } catch {}
    });
    this.mediaStream = null;
  }

  if (this.verificationTimer) {
    clearInterval(this.verificationTimer);
    this.verificationTimer = null;
  }

  this.mediaRecorder = null;
  this.verificationScores = [];
  this.voice = 'N/A';
  this.isVoiceMonitoring = false;
  console.log('Verification stopped');

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
        
        // Automatically start voice monitoring if baseline exists
        if (this.hasVoiceBaseline && !this.isVoiceMonitoring) {
          await this.startVerification();
        }
      } catch (e: any) { 
        alert('Microphone access denied: ' + (e?.message || '')); 
        return; 
      }
    } else {
      // Stop voice monitoring if it's running
      if (this.isVoiceMonitoring) {
        this.stopVerification();
      }
      
      this.localAudioTrack?.stop();
      this.localAudioTrack = null;
    }
    
    // Update local preview and participant state
    this.refreshLocalPreview();
    this.participantsMap.set('__you__', { ...me, mic: next });
    this.syncParticipantsArray();
    
    // Notify server and trigger renegotiation for all peers
    this.sendSig({ type: 'mic_toggle', mic: next });
    this.peers.forEach((_st, ch) => this.renegotiate(ch));
  }

  async toggleCam(): Promise<void> {
    const me = this.participantsMap.get('__you__'); if (!me) return;
    const next: CamState = me.cam === 'on' ? 'off' : 'on';
    
    if (next === 'on') {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.localVideoTrack = s.getVideoTracks()[0] || null;
        
        if (this.localVideoTrack) {
          this.localVideoTrack.enabled = true;
          
          // Handle camera track ending (user stops from browser/system)
          this.localVideoTrack.onended = () => {
            this.localVideoTrack = null;
            this.refreshLocalPreview();
            
            const me2 = this.participantsMap.get('__you__');
            if (me2) {
              this.participantsMap.set('__you__', { ...me2, cam: 'off', videoOn: false });
              this.syncParticipantsArray();
            }
            
            this.sendSig({ type: 'cam_toggle', cam: 'off' });
            this.peers.forEach((_st, ch) => this.renegotiate(ch));
            
            // Stop gaze tracking when camera stops
            this.monitorLoopRunning = false;
            stopGazeTracking();
            this.isGazeTracking = false;
          };
        }
      } catch (e: any) { 
        alert('Camera access error: ' + (e?.message || '')); 
        return; 
      }
    } else {
      // Turn off camera
      this.localVideoTrack?.stop();
      this.localVideoTrack = null;
      
      // Stop gaze tracking
      this.monitorLoopRunning = false;
      stopGazeTracking();
      this.isGazeTracking = false;
    }
    
    // Update local preview and participant state
    this.refreshLocalPreview();
    this.participantsMap.set('__you__', { ...me, cam: next, videoOn: next === 'on', stream: this.localPreviewStream });
    this.syncParticipantsArray();
    
    // Notify server and trigger renegotiation for all peers
    this.sendSig({ type: 'cam_toggle', cam: next });
    this.peers.forEach((_st, ch) => this.renegotiate(ch));

    // Start gaze tracking when camera turns ON
    if (next === 'on') {
      this.monitorSelfVideo();
    }
  }

  private monitorSelfVideo(): void {
    const ws = this.signaling.getSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
    const tryAttach = () => {
      const selfVideo = document.querySelector('video[data-chan="__you__"]') as HTMLVideoElement | null;
      if (selfVideo && document.body.contains(selfVideo)) {
        startGazeTracking(
          selfVideo,
          ws,
          this.userName,
          (status) => {
            this.handleGazeStatus(status);
            this.sendSig({
              type: 'gaze_status',
              user: this.userName,
              gaze: status,
              ts: Date.now(),
            });
          },
          this.gazeThresholds
        );
      } else {
        setTimeout(tryAttach, 500);
      }
    };
    tryAttach();
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
    
    // Stop local media tracks
    if (this.you?.stream) {
      this.you.stream.getTracks().forEach(track => track.stop());
    }
    
    // Close all peer connections
    this.peers.forEach(({ pc }) => { try { pc.close(); } catch {} });
    this.peers.clear();
    
    // Clear participants
    this.participantsMap.forEach((_p, ch) => { if (ch !== '__you__') this.participantsMap.delete(ch); });
    this.participantsMap.delete('__you__');
    this.syncParticipantsArray();
    
    // Exit fullscreen
    this.exitFullscreen();
    
    // Reset fullscreen alert state
    this.hasShownEscAlert = false;
    this.escPressCount = 0;

    this.isNameUpdated = false; 
  }

  raiseHand(): void {
    const me = this.participantsMap.get('__you__'); if (!me) return;
    const next = !me.handRaised; this.participantsMap.set('__you__', { ...me, handRaised: next });
    this.syncParticipantsArray();
    this.sendSig({ type: 'hand_toggle', handRaised: next });
  }

  startNotes(): void {
    this.isNotesOpen = true;
  }

  closeNotes(): void {
    this.isNotesOpen = false;
  }

  async runGazeSession() {
    const thresholds = await startCalibration();
    
    const ws = this.signaling.getSocket();
    const selfVideo = document.querySelector('video[data-chan="__you__"]') as HTMLVideoElement | null;
    
    if (!selfVideo || !ws) {
      alert('Please turn on your camera first');
      return;
    }
  
    startGazeTracking(selfVideo, ws, this.userName, (status) => {
      this.handleGazeStatus(status);
      this.sendSig({
        type: 'gaze_status',
        user: this.userName,
        gaze: status,
        ts: Date.now(),
      });
    }, thresholds);
  }
  
  

  get shouldShowSelfVideo(): boolean {
    // Show PiP if you have a self video stream
    // and there are other participants (so you’re not alone in the call)
    return !!this.you?.videoOn && !!this.you?.stream && this.gridParticipants.length > 0;
  }

  trackByParticipant(index: number, item: Participant): string { return item.channel; }
  
  // ====== Permission Methods ======
  async checkMediaPermissions(): Promise<void> {
    try {
      // Check if permissions API is available
      if (navigator.permissions) {
        const cameraPermission = await navigator.permissions.query({ name: 'camera' as PermissionName });
        const micPermission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        
        this.permissionStatus.camera = cameraPermission.state === 'granted';
        this.permissionStatus.microphone = micPermission.state === 'granted';
        
        // Show popup if either permission is not granted
        if (!this.permissionStatus.camera || !this.permissionStatus.microphone) {
          this.showPermissionPopup = true;
        }
      } else {
        // Fallback: Try to access media to check permissions
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          stream.getTracks().forEach(track => track.stop());
          this.permissionStatus.camera = true;
          this.permissionStatus.microphone = true;
        } catch (err) {
          this.showPermissionPopup = true;
        }
      }
    } catch (error) {
      // If permission check fails, show the popup
      this.showPermissionPopup = true;
    }
  }
  
  async requestPermissions(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: true, 
        audio: true 
      });
      
      // Permissions granted, stop the stream
      stream.getTracks().forEach(track => track.stop());
      
      this.permissionStatus.camera = true;
      this.permissionStatus.microphone = true;
      this.showPermissionPopup = false;
      
      alert('Permissions granted! You can now join the call.');
    } catch (error: any) {
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        alert('Camera and microphone access denied. Please enable them in your browser settings to use this app.');
      } else if (error.name === 'NotFoundError') {
        alert('No camera or microphone found. Please connect a device and try again.');
      } else {
        alert('Error accessing camera/microphone: ' + error.message);
      }
    }
  }
  
  closePermissionPopup(): void {
    this.showPermissionPopup = false;
  }
  
  // ====== Fullscreen Methods ======
  private enterFullscreen(): void {
    const elem = document.documentElement;
    if (elem.requestFullscreen) {
      elem.requestFullscreen().catch(err => {
        console.error('Fullscreen request failed:', err);
      });
    } else if ((elem as any).webkitRequestFullscreen) {
      (elem as any).webkitRequestFullscreen();
    } else if ((elem as any).mozRequestFullScreen) {
      (elem as any).mozRequestFullScreen();
    } else if ((elem as any).msRequestFullscreen) {
      (elem as any).msRequestFullscreen();
    }
  }
  
  private exitFullscreen(): void {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if ((document as any).webkitExitFullscreen) {
      (document as any).webkitExitFullscreen();
    } else if ((document as any).mozCancelFullScreen) {
      (document as any).mozCancelFullScreen();
    } else if ((document as any).msExitFullscreen) {
      (document as any).msExitFullscreen();
    }
  }
  
  // ====== Gradient Generator for Tiles ======
  getGradientForParticipant(channel: string): string {
    // Lighter, more transparent gradients with opacity
    const gradients = [
      'linear-gradient(135deg, rgba(102, 126, 234, 0.4) 0%, rgba(118, 75, 162, 0.4) 100%)',
      'linear-gradient(135deg, rgba(240, 147, 251, 0.4) 0%, rgba(245, 87, 108, 0.4) 100%)',
      'linear-gradient(135deg, rgba(79, 172, 254, 0.4) 0%, rgba(0, 242, 254, 0.4) 100%)',
      'linear-gradient(135deg, rgba(67, 233, 123, 0.4) 0%, rgba(56, 249, 215, 0.4) 100%)',
      'linear-gradient(135deg, rgba(250, 112, 154, 0.4) 0%, rgba(254, 225, 64, 0.4) 100%)',
      'linear-gradient(135deg, rgba(48, 207, 208, 0.4) 0%, rgba(51, 8, 103, 0.4) 100%)',
      'linear-gradient(135deg, rgba(168, 237, 234, 0.4) 0%, rgba(254, 214, 227, 0.4) 100%)',
      'linear-gradient(135deg, rgba(255, 154, 158, 0.4) 0%, rgba(254, 207, 239, 0.4) 100%)',
      'linear-gradient(135deg, rgba(255, 236, 210, 0.4) 0%, rgba(252, 182, 159, 0.4) 100%)',
      'linear-gradient(135deg, rgba(255, 110, 127, 0.4) 0%, rgba(191, 233, 255, 0.4) 100%)',
    ];
    
    // Generate consistent index based on channel string
    let hash = 0;
    for (let i = 0; i < channel.length; i++) {
      hash = ((hash << 5) - hash) + channel.charCodeAt(i);
      hash = hash & hash;
    }
    const index = Math.abs(hash) % gradients.length;
    return gradients[index];
  }
  
  // ====== Face Capture Methods for Enrollment ======
  
  private async startEnrollmentCamera(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 }, 
        audio: false 
      });
      this.enrollmentCameraStream = stream;
      this.permissionStatus.camera = true;
      
      // Start basic face position checking (simplified without face-api.js)
      this.startFacePositionCheck();
    } catch (err: any) {
      this.permissionStatus.camera = false;
      throw new Error('Camera access denied for enrollment: ' + (err?.message || ''));
    }
  }
  
  private stopEnrollmentCamera(): void {
    if (this.enrollmentCameraStream) {
      this.enrollmentCameraStream.getTracks().forEach(track => track.stop());
      this.enrollmentCameraStream = null;
    }
    
    if (this.faceDetectionInterval) {
      clearInterval(this.faceDetectionInterval);
      this.faceDetectionInterval = null;
    }
    
    this.showEnrollmentCamera = false;
    this.facePositionCorrect = true;
    this.facePositionMessage = '';
  }
  
  private startFacePositionCheck(): void {
    // Simple position check - in production, you'd use face-api.js or similar
    // For now, we'll just show the overlay and assume position is correct
    this.facePositionCorrect = true;
    this.facePositionMessage = '';
    
    // Simulate basic face detection check every 2 seconds
    this.faceDetectionInterval = setInterval(() => {
      // In a real implementation, you would:
      // 1. Get video element
      // 2. Run face detection
      // 3. Check if face is centered in oval
      // 4. Update facePositionCorrect and facePositionMessage
      
      // For now, we'll just keep it as correct
      this.facePositionCorrect = true;
    }, 2000);
  }
  
  private updateReadingText(): void {
    // Update reading text based on current progress
    const textIndex = Math.min(this.voiceRecordingProgress, this.READING_TEXTS.length - 1);
    this.currentReadingText = this.READING_TEXTS[textIndex];
  }
  
  // Getter to check if finish button should be enabled
  get canFinishEnrollment(): boolean {
    return this.enrollmentSuccessCount >= this.ENROLL_SAMPLES;
  }
}

// Optional debug hook for attaching raw video elements (manual testing)
function attachDebugVideo(stream: MediaStream, chan: string) {
  const vid = document.createElement('video');
  vid.autoplay = true; (vid as any).playsInline = true; (vid as any).srcObject = stream as any; vid.muted = false;
  vid.style.width = '200px'; vid.style.border = '2px solid red'; document.body.appendChild(vid);
  console.log('✅ Attached debug video for', chan, 'stream:', stream);
}

