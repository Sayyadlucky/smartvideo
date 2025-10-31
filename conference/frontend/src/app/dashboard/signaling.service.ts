import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

interface SignalMessage {
  type: string;
  [key: string]: any;
}

@Injectable({ providedIn: 'root' })
export class SignalingService {
  private ws: WebSocket | null = null;
  private messagesSubject = new Subject<SignalMessage>();
  public messages$ = this.messagesSubject.asObservable();

  private room?: string;

  private buildUrl(room: string): string {
    // If you want to override manually, set window.__SIGNALING_URL__ before Angular boots
    const override = (window as any).__SIGNALING_URL__ as string | undefined;

    if (override) {
      return `${override.replace(/\/$/, '')}/${encodeURIComponent(room)}/`;
    }

    // Derive from page’s location
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/ws/signaling/${encodeURIComponent(room)}/`;
  }

  connect(room: string): void {
    this.room = room;
    const url = this.buildUrl(room);

    console.log('[SignalingService] connecting →', url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[SignalingService] ✅ WebSocket connected');
    };

    this.ws.onmessage = (ev) => {
      try {
        const data: SignalMessage = JSON.parse(ev.data);
        this.messagesSubject.next(data);
      } catch (err) {
        console.error('[SignalingService] JSON parse error', err, ev.data);
      }
    };

    this.ws.onclose = () => {
      console.warn('[SignalingService] WebSocket closed, attempting reconnect…');
      setTimeout(() => this.reconnect(), 1000);
    };

    this.ws.onerror = (err) => {
      console.error('[SignalingService] WebSocket error', err);
      this.ws?.close();
    };
  }

  private reconnect(): void {
    if (this.room) this.connect(this.room);
  }

  getSocket(): WebSocket | null {
    return this.ws; // or whatever your private WS variable is called
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  sendMessage(msg: SignalMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SignalingService] sendMessage failed, socket not open', 'readyState:', this.ws?.readyState);
      return;
    }
    try {
      console.log('[SignalingService] 📨 Sending message:', msg.type, msg);
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[SignalingService] sendMessage error', err, msg);
    }
  }
}
