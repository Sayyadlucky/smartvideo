// src/app/dashboard/dashboard.ts (refactor — stable media, clearer state)
import {
  Component,
  OnInit,
  OnDestroy,
  HostListener,
  Directive,
  ElementRef,
  Input,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SignalingService } from './signaling.service';
import { Subscription } from 'rxjs';
import { SrcObjectDirective } from './src-object.directive';
import { DragDropModule } from '@angular/cdk/drag-drop';

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
  activeTab: 'participants' | 'chat' = 'chat';

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

  constructor(private signaling: SignalingService) {}

  // ====== Lifecycle ======
  async ngOnInit(): Promise<void> {
    console.log('DASHBOARD BUILD MARKER v8 — stable-media');
    // Create a single stable preview stream instance
    this.localPreviewStream = new MediaStream();

    this.participantsMap.set('__you__', this.makeLocalParticipant('You'));
    this.syncParticipantsArray();

    // connect to signaling server
    this.signaling.connect(this.roomName);
    this.signalingSub = this.signaling.messages$.subscribe((msg: any) => this.onSignal(msg));
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
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
      ],
    });

    const at = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const vt = pc.addTransceiver('video', { direction: 'sendrecv' });

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
        if (text) { const by = payload.by ?? 'Guest'; this.chatMessages = [...this.chatMessages, { by, text }]; }
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
    this.peers.forEach(({ pc }) => { try { pc.close(); } catch {} });
    this.peers.clear();
    this.participantsMap.forEach((_p, ch) => { if (ch !== '__you__') this.participantsMap.delete(ch); });
    this.syncParticipantsArray();
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

// Optional debug hook for attaching raw video elements (manual testing)
function attachDebugVideo(stream: MediaStream, chan: string) {
  const vid = document.createElement('video');
  vid.autoplay = true; (vid as any).playsInline = true; (vid as any).srcObject = stream as any; vid.muted = false;
  vid.style.width = '200px'; vid.style.border = '2px solid red'; document.body.appendChild(vid);
  console.log('✅ Attached debug video for', chan, 'stream:', stream);
}
