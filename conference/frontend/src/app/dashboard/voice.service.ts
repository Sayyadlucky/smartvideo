import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export interface EnrollResponse {
  success: boolean;
  message: string;
  user_key?: string;
}

export interface VerifyResponse {
  success: boolean;
  message: string;
  similarity?: number;
  percentage?: number;
  status?: string;
}

@Injectable({
  providedIn: 'root'
})
export class VoiceService {
  private readonly API_BASE = 'video-call/api/voice';

  constructor(private http: HttpClient) {}

  /**
   * Enroll a voice sample
   */
  enrollVoice(audioBlob: Blob, room: string, username: string): Observable<EnrollResponse> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');
    formData.append('room', room);
    formData.append('username', username);

    return this.http.post<EnrollResponse>(`${this.API_BASE}/enroll`, formData).pipe(
      catchError(error => {
        console.error('Enrollment error:', error);
        return throwError(() => new Error(error.error?.message || 'Enrollment failed'));
      })
    );
  }

  /**
   * Verify a voice sample against stored baseline
   * (Assumes client-side has already filtered silence / noise)
   */
  verifyVoice(audioBlob: Blob, room: string, username: string): Observable<VerifyResponse> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');
    formData.append('room', room);
    formData.append('username', username);

    return this.http.post<VerifyResponse>(`${this.API_BASE}/verify`, formData).pipe(
      catchError(error => {
        console.error('Verification error:', error);
        return throwError(() => new Error(error.error?.message || 'Verification failed'));
      })
    );
  }
}
