// src/app/dashboard/dashboard.ts
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

type MicState = 'on' | 'off';
type CamState = 'on' | 'off';

interface Participant {
  name: string;
  mic: MicState;
  cam: CamState;
  videoOn: boolean;
  initials: string;
  isYou?: boolean;
  channel: string;
  stream?: MediaStream | null;
  handRaised?: boolean;
}

interface ChatMessage { by: string; text: string; }

@Directive({
  selector: 'video[appSrcObject],audio[appSrcObject]',
  standalone: true,
})
export class MediaSrcObjectDirective {
  @Input() muted: boolean = false;
  constructor(private el: ElementRef<HTMLVideoElement | HTMLAudioElement>) {}
  @Input() set appSrcObject(stream: MediaStream | undefined | null) {
    console.log("🎥 appSrcObject set for", this.el.nativeElement.tagName, "stream:", !!stream, "tracks:", stream?.getTracks().length);
    const media = this.el.nativeElement as HTMLMediaElement;
    media.autoplay = true;
    (media as any).playsInline = true;
    (media as any).srcObject = stream ?? null;
    (media as any).muted = this.muted;

    if (stream) {
      media.play().catch((e: any) => {
        if (e?.name === 'NotAllowedError') {
          const oneClick = () => {
            media.play().catch(() => {});
            document.removeEventListener('click', oneClick);
          };
          document.addEventListener('click', oneClick, { once: true });
        }
      });
    }
  }
}

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
  isDesktop = window.innerWidth >= 1024;
  chatCollapsed = true;
  participants: Participant[] = [];
  chatMessages: ChatMessage[] = [];
  chatText = '';
  tileColsManual: number | null = null;
  public roomName = 'testroom';
  activeTab: 'participants' | 'chat' = 'chat';

  private signalingSub: Subscription | null = null;
  private myServerChan: string | null = null;
  private myPolite: boolean = true;

  private participantsMap = new Map<string, Participant>();
  private peers = new Map<string, PeerState>();
  private iceQueue = new Map<string, RTCIceCandidateInit[]>();

  private localVideoTrack: MediaStreamTrack | null = null;
  private localAudioTrack: MediaStreamTrack | null = null;
  private localPreviewStream = new MediaStream();

  get you(): Participant | undefined { return this.participantsMap.get('__you__'); }
  get tileCount(): number { return this.participants.length; }
  get tileCols(): number {
    if (this.tileColsManual) return this.tileColsManual;
    return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(this.tileCount || 1))));
  }

  get layoutCount(): number { return this.participants.length; }

  get fullParticipant(): Participant | undefined {
    const remotes = this.participants.filter(p => !p.isYou);
    if (remotes.length === 0 && this.you?.videoOn) return this.you;
    return remotes.find(p => p.videoOn);
  }

  get gridParticipants(): Participant[] {
    const remotes = this.participants.filter(p => !p.isYou);
    const self = this.you;

    if (remotes.length === 0 && self) {
      return [self];
    }

    return remotes;
  }

  constructor(private signaling: SignalingService) {}

  async ngOnInit(): Promise<void> {
    console.log("DASHBOARD BUILD MARKER v7 name-fix");
    this.participantsMap.set('__you__', {
      name: 'You',
      mic: 'off',
      cam: 'off',
      videoOn: false,
      initials: this.initialsFromName('You'),
      isYou: true,
      channel: '__you__',
      stream: this.localPreviewStream,
      handRaised: false,
    });
    this.syncParticipantsArray();
  
    // connect to signaling server
    this.signaling.connect(this.roomName);
    this.signalingSub = this.signaling.messages$.subscribe((msg: any) => this.onSignal(msg));
  
  }
  
  @HostListener('window:resize')
  onResize() {
    this.isDesktop = window.innerWidth >= 1024;
  }

  private isScreenSharing(p: any): boolean {
    return !!(p?.isSharing ?? p?.screenOn ?? p?.isPresenting ?? p?.screenShareOn ?? p?.sharingScreen ?? p?.presenting);
  }

  get shouldShowSelfVideo(): boolean {
    return this.you?.videoOn ?? false;
  }

  ngOnDestroy(): void {
    try { this.sendSig({ type: 'bye' }); } catch {}
    this.signalingSub?.unsubscribe();
    this.signaling.disconnect();

    this.peers.forEach(st => { try { st.pc.close(); } catch {} });
    this.peers.clear();

    this.localVideoTrack?.stop();
    this.localAudioTrack?.stop();
    this.localPreviewStream.getTracks().forEach(t => t.stop());

    this.participantsMap.clear();
    this.iceQueue.clear();
  }

  @HostListener('window:beforeunload')
  onBeforeUnload() { try { this.sendSig({ type: 'bye' }); } catch {} }

  // ========== Utilities ==========

  private sendSig(payload: any & { to?: string }) {
    const out = { ...payload };
    this.signaling.sendMessage(out);
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

  private queueIce(remoteChan: string, cand: RTCIceCandidateInit) {
    const q = this.iceQueue.get(remoteChan) ?? [];
    q.push(cand);
    this.iceQueue.set(remoteChan, q);
  }

  private async flushIce(remoteChan: string) {
    const st = this.peers.get(remoteChan);
    if (!st || !st.pc.remoteDescription) return;
    const q = this.iceQueue.get(remoteChan);
    if (!q?.length) return;
    for (const c of q) {
      try { await st.pc.addIceCandidate(c); } catch {}
    }
    this.iceQueue.delete(remoteChan);
  }

  private syncParticipantsArray() {
    this.participants = Array.from(this.participantsMap.values())
      .filter(p => p.channel !== '__you__')
      .concat(this.you ? [this.you] : []);
    console.log("🔄 syncParticipantsArray:", this.participants.map(p => ({ name: p.name, stream: !!p.stream, videoOn: p.videoOn, tracks: p.stream?.getTracks().length })));
  }

  private upsertParticipantFromPayload(row: any) {
    const ch = this.participantChan(row); if (!ch) return;
    const prev = this.participantsMap.get(ch);
    const payloadVideoOn = typeof row?.videoOn === 'boolean' ? row.videoOn : undefined;
    const payloadCamOn = row?.cam === 'on';
    const streamHasVideo = prev?.stream ? prev.stream.getVideoTracks().length > 0 : false;
    const fallbackVideoOn = prev?.videoOn ?? false;
    const next: Participant = {
      name: (row?.name ?? prev?.name ?? 'Guest'),
      mic: (row?.mic as MicState) ?? prev?.mic ?? 'off',
      cam: (row?.cam as CamState) ?? prev?.cam ?? 'off',
      videoOn: payloadVideoOn !== undefined ? payloadVideoOn : (payloadCamOn ? true : (streamHasVideo ? true : fallbackVideoOn)),
      initials: this.initialsFromName(row?.name ?? prev?.name ?? 'Guest'),
      isYou: false,
      channel: ch,
      stream: prev?.stream,
      handRaised: (typeof row?.handRaised === 'boolean') ? row.handRaised : (prev?.handRaised ?? false),
    };
    this.participantsMap.set(ch, next);
    this.syncParticipantsArray();
  }

  private refreshLocalPreview() {
    this.localPreviewStream = new MediaStream();
    if (this.localVideoTrack) this.localPreviewStream.addTrack(this.localVideoTrack);
    // Do not add audio track to preview stream to prevent local echo

    const me = this.participantsMap.get('__you__');
    if (me) {
      const hasVideo = !!this.localVideoTrack;
      this.participantsMap.set('__you__', { ...me, stream: hasVideo ? this.localPreviewStream : null, videoOn: hasVideo });
    }

    this.peers.forEach(st => {
      st.audioSender.replaceTrack(this.localAudioTrack);
      st.videoSender.replaceTrack(this.localVideoTrack);
    });

    this.syncParticipantsArray();
  }

  // ========== Peer creation & negotiation ==========

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

    if (this.localAudioTrack) st.audioSender.replaceTrack(this.localAudioTrack);
    if (this.localVideoTrack) st.videoSender.replaceTrack(this.localVideoTrack);

    pc.ontrack = (ev: RTCTrackEvent) => {
      console.log("📡 ontrack from", remoteChan, ev);
      console.log("➡️ streams length =", ev.streams?.length, "track kind =", ev.track?.kind);
      ev.track.enabled = true;

      let remoteStream: MediaStream;

      if (ev.streams && ev.streams[0]) {
        // Browser provided a MediaStream directly
        remoteStream = ev.streams[0];
      } else {
        // Fallback: create new MediaStream with track
        console.warn("⚠️ no ev.streams[0], creating new MediaStream with track");
        remoteStream = new MediaStream([ev.track]);
      }

      // --- merge additional tracks if we already have a stream for this peer ---
      const prev = this.participantsMap.get(remoteChan);
      if (prev?.stream) {
        // avoid duplicates: only add if track not already present
        const already = prev.stream.getTracks().find(t => t.id === ev.track.id);
        if (!already) {
          const existingTracks = prev.stream.getTracks();
          remoteStream = new MediaStream([...existingTracks, ev.track]);
          // Add onended listener to update flags when track ends
          ev.track.onended = () => {
            const p = this.participantsMap.get(remoteChan);
            if (p) {
              if (ev.track.kind === 'video') {
                this.participantsMap.set(remoteChan, { ...p, videoOn: false, cam: 'off' });
              } else if (ev.track.kind === 'audio') {
                this.participantsMap.set(remoteChan, { ...p, mic: 'off' });
              }
              this.syncParticipantsArray();
            }
          };
        } else {
          // If already present, use the existing stream
          remoteStream = prev.stream;
        }
        console.log("🔄 Added track to existing stream for", remoteChan, ev.track.kind);

        // update mic/cam flags
        const updated: Participant = {
          ...prev,
          mic: remoteStream.getAudioTracks().length > 0 ? 'on' : 'off',
          cam: remoteStream.getVideoTracks().length > 0 ? 'on' : 'off',
          videoOn: remoteStream.getVideoTracks().length > 0,
          stream: remoteStream,
        };
        this.participantsMap.set(remoteChan, updated);
        console.log("📡 ontrack: updated participant", remoteChan, "stream:", !!updated.stream, "videoOn:", updated.videoOn, "tracks:", updated.stream?.getTracks().length);
      } else {
        // first time we see this peer → new participant entry
        // Add onended listener to the track
        ev.track.onended = () => {
          const p = this.participantsMap.get(remoteChan);
          if (p) {
            if (ev.track.kind === 'video') {
              this.participantsMap.set(remoteChan, { ...p, videoOn: false, cam: 'off' });
            } else if (ev.track.kind === 'audio') {
              this.participantsMap.set(remoteChan, { ...p, mic: 'off' });
            }
            this.syncParticipantsArray();
          }
        };
        const next: Participant = {
          name: prev?.name ?? 'Guest',
          mic: remoteStream.getAudioTracks().length > 0 ? 'on' : 'off',
          cam: remoteStream.getVideoTracks().length > 0 ? 'on' : 'off',
          videoOn: remoteStream.getVideoTracks().length > 0,
          initials: prev?.initials ?? 'G',
          isYou: false,
          channel: remoteChan,
          stream: remoteStream,
          handRaised: prev?.handRaised ?? false,
        };
        this.participantsMap.set(remoteChan, next);
      }

      this.syncParticipantsArray();
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      console.log("ICE → sending candidate to", remoteChan, candidate);
      this.sendSig({
        type: 'ice_candidate',
        ice_candidate: candidate.toJSON?.() ?? candidate,
        to: remoteChan,
      });
    };

    pc.onconnectionstatechange = () => {
      console.log("pc.connectionState for", remoteChan, "=", pc.connectionState);
    };

    // Disabled onnegotiationneeded to avoid offers on join; offers only when media is turned on
    // pc.onnegotiationneeded = async () => {
    //   if (st!.makingOffer || pc.signalingState !== 'stable') return;
    //   try {
    //     st!.makingOffer = true;
    //     console.log('onnegotiationneeded -> creating offer for', remoteChan);
    //     await pc.setLocalDescription(await pc.createOffer());
    //     this.sendSig({ type: 'offer', offer: pc.localDescription, to: remoteChan });
    //   } catch (err) {
    //     console.error('onnegotiationneeded error', err);
    //   } finally {
    //     st!.makingOffer = false;
    //   }
    // };

    this.peers.set(remoteChan, st);
    return st;
  }

  private async renegotiate(remoteChan: string) {
    const st = this.peers.get(remoteChan);
    if (!st) return;
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

  // ========== Incoming signaling ==========

  private onSignal(msg: any) {
    if (!msg) return;

    if (msg.type === 'welcome') {
      this.myServerChan = msg.channel || msg.myServerChan || null;
      this.myPolite = !!msg.polite;
      console.log('welcome received, myServerChan:', this.myServerChan, 'polite:', this.myPolite);
      const myName = this.you?.name || 'You';
      // ✅ safe to send now
      this.sendSig({ type: 'name_update', name: myName });
      console.log("✔️ Received welcome. My channel =", this.myServerChan, "Polite =", this.myPolite);
      return;
    }

    switch (msg.type) {
      case 'participants': {
        const list: any[] = msg.participants || [];
        list.forEach(row => {
          const ch = this.participantChan(row);
          // 🚫 skip my own server-side entry
          if (ch && this.myServerChan && ch === this.myServerChan) return;

          this.upsertParticipantFromPayload(row);
          if (ch && this.myServerChan && ch !== this.myServerChan) {
            this.getOrCreatePeer(ch);
          }
        });
        break;
      }

      case 'participant_joined': {
        const row = msg.participant;
        const ch = this.participantChan(row);
        // 🚫 skip self
        if (ch && this.myServerChan && ch === this.myServerChan) return;

        if (ch && this.myServerChan) {
          this.upsertParticipantFromPayload(row);
          this.getOrCreatePeer(ch);
        }
        break;
      }

      case 'participant_left': {
        const ch = msg.channel;
        if (ch) {
          this.participantsMap.delete(ch);
          const st = this.peers.get(ch);
          if (st) { try { st.pc.close(); } catch {} this.peers.delete(ch); }
          this.syncParticipantsArray();
        }
        break;
      }

      case 'participant_updated': {
        const row = msg.participant;
        const ch = this.participantChan(row);
        // 🚫 skip self
        if (ch && this.myServerChan && ch === this.myServerChan) return;

        this.upsertParticipantFromPayload(row);
        break;
      }

      case 'chat_message': {
        const payload = msg.message ?? {};
        const text = payload.text ?? '';
        if (text) {
          const by = payload.by ?? 'Guest';
          this.chatMessages = [...this.chatMessages, { by, text }];
        }
        break;
      }

      case 'offer': {
        if (!this.messageIsForMe(msg)) return;
        const from = this.senderChan(msg); if (!from) return;
        const offer = this.asOffer(msg);   if (!offer) return;

        const st = this.getOrCreatePeer(from);
        const pc = st.pc;

        (async () => {
          const offerCollision = (st.makingOffer || pc.signalingState !== 'stable');
          st.ignoreOffer = !st.polite && offerCollision;
          if (st.ignoreOffer) {
            console.log('ignoring offer from', from);
            return;
          }

          try {
            if (pc.signalingState !== 'stable') {
              console.log('rollback before applying remote offer');
              await pc.setLocalDescription({ type: 'rollback' });
            }
            await pc.setRemoteDescription(offer);
            st.audioSender.replaceTrack(this.localAudioTrack);
            st.videoSender.replaceTrack(this.localVideoTrack);
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
        const st = this.peers.get(from);   if (!st) return;
        const pc = st.pc;

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

  // ========== UI actions ==========

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
    if (me) {
      this.participantsMap.set('__you__', { ...me, name: v, initials: this.initialsFromName(v) });
      this.syncParticipantsArray();
    }
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
      this.localAudioTrack?.stop();
      this.localAudioTrack = null;
    }
    this.refreshLocalPreview();
    this.participantsMap.set('__you__', { ...me, mic: next });
    this.syncParticipantsArray();
    this.sendSig({ type: 'mic_toggle', mic: next });
  }

  async toggleCam(): Promise<void> {
    const me = this.participantsMap.get('__you__'); if (!me) return;
    const next: CamState = me.cam === 'on' ? 'off' : 'on';
    if (next === 'on') {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.localVideoTrack = s.getVideoTracks()[0] || null;
        if (this.localVideoTrack) this.localVideoTrack.enabled = true;
        if (this.localVideoTrack) {
          this.localVideoTrack.onended = () => {
            this.localVideoTrack = null;
            this.refreshLocalPreview();
            this.sendSig({ type: 'cam_toggle', cam: 'off' });
            const me2 = this.participantsMap.get('__you__');
            if (me2) {
              this.participantsMap.set('__you__', { ...me2, cam: 'off', videoOn: false });
              this.syncParticipantsArray();
            }
            this.peers.forEach((_st, ch) => this.renegotiate(ch));
          };
        }
      } catch (e: any) { alert('Camera access error: ' + (e?.message || e)); return; }
    } else {
      this.localVideoTrack?.stop();
      this.localVideoTrack = null;
    }
    this.refreshLocalPreview();
    this.participantsMap.set('__you__', { ...me, cam: next, videoOn: next === 'on', stream: this.localPreviewStream });
    this.syncParticipantsArray();
    this.sendSig({ type: 'cam_toggle', cam: next });
    this.peers.forEach((_st, ch) => this.renegotiate(ch));
  }

  async shareScreen(): Promise<void> {
    try {
      const screenStream: MediaStream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;
      this.localVideoTrack?.stop();
      this.localVideoTrack = screenTrack;
      this.refreshLocalPreview();
      screenTrack.onended = () => {
        this.localVideoTrack = null;
        this.refreshLocalPreview();
        this.sendSig({ type: 'cam_toggle', cam: 'off' });
        const me = this.participantsMap.get('__you__');
        if (me) {
          this.participantsMap.set('__you__', { ...me, cam: 'off', videoOn: false });
          this.syncParticipantsArray();
        }
        this.peers.forEach((_st, ch) => this.renegotiate(ch));
      };
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
    const next = !me.handRaised;
    this.participantsMap.set('__you__', { ...me, handRaised: next });
    this.syncParticipantsArray();
    this.sendSig({ type: 'hand_toggle', handRaised: next });
  }

  trackByParticipant(index: number, item: Participant): string {
    return item.channel;
  }
  
}

function attachDebugVideo(stream: MediaStream, chan: string) {
  const vid = document.createElement("video");
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = false;
  (vid as HTMLVideoElement).srcObject = stream as any;
  vid.style.width = "200px";
  vid.style.border = "2px solid red";
  document.body.appendChild(vid);

  console.log("✅ Attached debug video for", chan, "stream:", stream);
}
