import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SignalingService {
  private socket?: WebSocket;
  private url = `wss://127.0.0.1:8000/ws/signaling/testroom/`;

  public messages$ = new Subject<any>();

  join(roomName: string, displayName: string) {
    this.url = `wss://127.0.0.1:8000/ws/signaling/${roomName}/`;
    this.socket = new WebSocket(this.url);

    this.socket.onopen = () => {
      console.log('WebSocket connected');
      this.send({ type: 'join', name: displayName });
    };

    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.messages$.next(msg);
      } catch (e) {
        console.error('bad ws msg', e);
      }
    };

    this.socket.onclose = () => console.log('WebSocket disconnected');
    this.socket.onerror = (err) => console.error('WebSocket error', err);
  }

  send(data: any) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }
}
