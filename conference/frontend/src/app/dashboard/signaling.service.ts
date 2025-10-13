import { Injectable, NgZone } from '@angular/core';
import { Subject, Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class SignalingService {
  private ws: WebSocket | null = null;
  private messagesSubject = new Subject<any>();
  public messages$: Observable<any> = this.messagesSubject.asObservable();

  private reconnectDelay = 2000; // ms
  private roomName: string | null = null;

  constructor(private zone: NgZone) {}

  /**
   * Connect to signaling server with a given roomName
   */
  connect(roomName: string) {
    this.roomName = roomName;
    const url = this.buildWsUrl(roomName);

    console.log('[SignalingService] Connecting to', url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[SignalingService] ✅ WebSocket connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.zone.run(() => {
          this.messagesSubject.next(msg);
        });
      } catch (e) {
        console.warn('[SignalingService] Failed to parse message', e);
      }
    };

    this.ws.onclose = (ev) => {
      console.warn('[SignalingService] ❌ WebSocket closed', ev.code, ev.reason);
      this.ws = null;

      // Auto-reconnect
      if (this.roomName) {
        setTimeout(() => {
          console.log('[SignalingService] 🔄 Reconnecting…');
          this.connect(this.roomName!);
        }, this.reconnectDelay);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[SignalingService] WebSocket error', err);
    };
  }

  /**
   * Build correct WS URL depending on http/https
   */
  private buildWsUrl(roomName: string): string {
    const loc = window.location;
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${scheme}//${loc.host}`;
    return `${base}/ws/signaling/${roomName}/`;
  }

  /**
   * Send a signaling message
   */
  sendMessage(msg: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SignalingService] Cannot send, WebSocket not open', msg);
      return;
    }
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      console.error('[SignalingService] Send error', e);
    }
  }

  /**
   * Disconnect cleanly
   */
  disconnect() {
    if (this.ws) {
      console.log('[SignalingService] Closing WebSocket');
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.roomName = null;
  }
}
