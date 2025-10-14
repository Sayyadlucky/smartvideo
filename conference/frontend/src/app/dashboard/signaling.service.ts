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

  connect(room: string): void {
    this.room = room;
    const url = `wss://127.0.0.1:8000/ws/signaling/${room}/`;

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

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  sendMessage(msg: SignalMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SignalingService] sendMessage failed, socket not open');
      return;
    }
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[SignalingService] sendMessage error', err, msg);
    }
  }
}
