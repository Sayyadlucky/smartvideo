# TODO: Complete Speaker Verification Implementation

## 🚨 CRITICAL - Must Complete Before Testing

### 1. Fix dashboard.ts - Replace YAMNet calls with Backend API

**File:** `videocall_project/conference/frontend/src/app/dashboard/dashboard.ts`

#### Change 1: Update `startEnrollment()` method's `mediaRecorder.onstop` callback (Line ~934)

**Find:**
```typescript
this.mediaRecorder.onstop = async () => {
  if (this.audioChunks.length === 0) return;
  const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
  this.audioChunks = [];
  try {
    const audioBuffer = await blobToAudioBuffer(blob);
    const emb = await getEmbeddingFromAudioBuffer(audioBuffer);
    this.baselineEmbeddings.push(emb);
    this.voiceRecordingProgress = this.baselineEmbeddings.length;
    console.log('Enrollment sample captured:', this.voiceRecordingProgress);
  } catch (err) {
    console.error('Enrollment capture failed:', err);
  }
};
```

**Replace with:**
```typescript
this.mediaRecorder.onstop = async () => {
  if (this.audioChunks.length === 0) return;
  const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
  this.audioChunks = [];
  
  // Send to backend for enrollment
  this.voiceService.enrollVoice(blob, this.roomName, this.userName).subscribe({
    next: (response) => {
      if (response.success) {
        this.voiceRecordingProgress++;
        console.log('✅ Enrollment sample captured:', this.voiceRecordingProgress);
      } else {
        console.error('❌ Enrollment failed:', response.message);
        alert('Failed to enroll voice sample: ' + response.message);
      }
    },
    error: (err) => {
      console.error('❌ Enrollment API error:', err);
      alert('Failed to enroll voice sample. Please try again.');
    }
  });
};
```

#### Change 2: Update `startVerification()` method's `mediaRecorder.ondataavailable` callback (Line ~1028)

**Find:**
```typescript
this.mediaRecorder.ondataavailable = async (ev: BlobEvent) => {
  if (ev.data && ev.data.size > 0) {
    try {
      const blob = ev.data;
      const audioBuffer = await blobToAudioBuffer(blob);
      const emb = await getEmbeddingFromAudioBuffer(audioBuffer);
      const sim = cosineSimilarityEmbedding(emb, this.baselineEmbedding as Embedding);
      const sim01 = (sim + 1) / 2;
      const pct = Math.round(sim01 * 100);
      
      this.verificationScores.push(pct);
      if (this.verificationScores.length > this.VERIFICATION_WINDOW) this.verificationScores.shift();
      const avg = Math.round(this.verificationScores.reduce((a, b) => a + b, 0) / this.verificationScores.length);
      
      this.ngZone.run(() => {
        this.voice = `${avg}%`;
        console.log('Voice match:', this.voice);
      });
      
      if (avg > 85) {
        // likely same speaker
      } else if (avg < 65) {
        // likely different speaker
      }
    } catch (err) {
      console.error('Verification chunk error:', err);
    }
  }
};
```

**Replace with:**
```typescript
this.mediaRecorder.ondataavailable = async (ev: BlobEvent) => {
  if (ev.data && ev.data.size > 0) {
    const blob = ev.data;
    
    // Send to backend for verification
    this.voiceService.verifyVoice(blob, this.roomName, this.userName).subscribe({
      next: (response) => {
        if (response.success && response.percentage !== undefined) {
          const pct = response.percentage;
          
          // Rolling window smoothing
          this.verificationScores.push(pct);
          if (this.verificationScores.length > this.VERIFICATION_WINDOW) {
            this.verificationScores.shift();
          }
          const avg = Math.round(
            this.verificationScores.reduce((a, b) => a + b, 0) / 
            this.verificationScores.length
          );
          
          // Use NgZone to trigger Angular change detection for UI update
          this.ngZone.run(() => {
            this.voice = `${avg}%`;
            console.log('🎤 Voice match:', this.voice, `(Status: ${response.status})`);
          });
          
          // Threshold triggers
          if (avg > 85) {
            // High confidence - same speaker
          } else if (avg < 65) {
            // Suspicious - different speaker detected
            console.warn('⚠️ SUSPICIOUS: Different speaker detected! Match:', avg + '%');
          }
        } else {
          console.error('❌ Verification failed:', response.message);
        }
      },
      error: (err) => {
        console.error('❌ Verification API error:', err);
      }
    });
  }
};
```

#### Change 3: Simplify `finishEnrollment()` method (Line ~960)

**Find:**
```typescript
public finishEnrollment(): void {
  if (!this.isRecordingVoice) return;

  if (this.baselineEmbeddings.length < this.ENROLL_SAMPLES) {
    alert(`Please record at least ${this.ENROLL_SAMPLES} samples (currently ${this.baselineEmbeddings.length})`);
    return;
  }

  // Average embeddings
  const dim = this.baselineEmbeddings[0].length;
  const avg = new Float32Array(dim);
  for (const emb of this.baselineEmbeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= this.baselineEmbeddings.length;

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
  norm = Math.sqrt(norm) + 1e-12;
  for (let i = 0; i < dim; i++) avg[i] = avg[i] / norm;

  this.baselineEmbedding = avg;
  this.hasVoiceBaseline = true;

  // cleanup and stop mic
  this.isRecordingVoice = false;
  try { this.mediaStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  this.mediaStream = null;
  if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
    try { this.mediaRecorder.stop(); } catch (_) {}
  }
  this.mediaRecorder = null;

  // store baseline in localStorage (optional)
  try {
    localStorage.setItem('voiceBaseline', JSON.stringify(Array.from(avg)));
  } catch (e) {
    console.warn('Could not persist baseline locally', e);
  }

  alert('Baseline enrolled successfully!');
}
```

**Replace with:**
```typescript
public finishEnrollment(): void {
  if (!this.isRecordingVoice) return;

  if (this.voiceRecordingProgress < this.ENROLL_SAMPLES) {
    alert(`Please record at least ${this.ENROLL_SAMPLES} samples (currently ${this.voiceRecordingProgress})`);
    return;
  }

  // Backend has already stored and averaged the embeddings
  this.hasVoiceBaseline = true;

  // Cleanup and stop mic
  this.isRecordingVoice = false;
  this.voiceRecordingProgress = 0;
  try { this.mediaStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  this.mediaStream = null;
  if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
    try { this.mediaRecorder.stop(); } catch (_) {}
  }
  this.mediaRecorder = null;

  alert('✅ Voice baseline enrolled successfully! You can now join the call.');
}
```

#### Change 4: Remove unused variables (Line ~136-138)

**Find and DELETE:**
```typescript
private baselineEmbeddings: Embedding[] = [];
private baselineEmbedding: Embedding | null = null;
```

---

## 📦 Additional Setup Required

### 2. Ensure HttpClientModule is Imported

**File:** `videocall_project/conference/frontend/src/app/app.config.ts` (or main module)

Add:
```typescript
import { provideHttpClient } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    // ... other providers
  ]
};
```

---

## 🧪 Testing Steps

### Backend Testing

1. **Install Dependencies:**
   ```bash
   cd videocall_project
   pip install -r requirements.txt
   ```

2. **Start Django Server:**
   ```bash
   python manage.py runserver
   ```

3. **Test Enrollment Endpoint:**
   ```bash
   curl -X POST http://localhost:8000/api/voice/enroll \
     -F "audio=@test_audio.webm" \
     -F "room=testroom" \
     -F "username=testuser"
   ```

4. **Test Verification Endpoint:**
   ```bash
   curl -X POST http://localhost:8000/api/voice/verify \
     -F "audio=@test_audio.webm" \
     -F "room=testroom" \
     -F "username=testuser"
   ```

### Frontend Testing

1. **Build Angular App:**
   ```bash
   cd videocall_project/conference/frontend
   ng build
   ```

2. **Test Enrollment Flow:**
   - Open browser to http://localhost:8000
   - Enter username
   - Click "Start Enrollment"
   - Click "Record (2s)" 3 times
   - Click "Finish"
   - Verify success message

3. **Test Verification Flow:**
   - Join the call
   - Click "Start Voice Monitor"
   - Speak continuously
   - Verify percentage updates in real-time
   - Check console for match percentages

4. **Test Different Speaker:**
   - Have someone else speak
   - Verify percentage drops below 65%
   - Check console for suspicious activity warning

---

## ✅ Completion Checklist

- [ ] Updated `startEnrollment()` mediaRecorder.onstop callback
- [ ] Updated `startVerification()` mediaRecorder.ondataavailable callback
- [ ] Simplified `finishEnrollment()` method
- [ ] Removed unused variables (baselineEmbeddings, baselineEmbedding)
- [ ] Added HttpClientModule to app config
- [ ] Installed backend dependencies
- [ ] Tested enrollment endpoint
- [ ] Tested verification endpoint
- [ ] Tested full enrollment flow in UI
- [ ] Tested verification flow in UI
- [ ] Tested with different speaker
- [ ] Verified threshold detection works
- [ ] No TypeScript errors in dashboard.ts
- [ ] No console errors in browser

---

## 📝 Notes

- The backend handles all embedding extraction and similarity computation
- Frontend only sends audio blobs and receives percentages
- In-memory storage means baselines are lost on server restart
- For production, implement database storage in speaker_verification.py
- Adjust thresholds based on testing results

---

## 🆘 Troubleshooting

**Issue:** "Cannot find name 'getEmbeddingFromAudioBuffer'"
- **Solution:** Complete Change 1 and Change 2 above

**Issue:** "Cannot find name 'cosineSimilarityEmbedding'"
- **Solution:** Complete Change 2 above

**Issue:** "No provider for HttpClient"
- **Solution:** Add HttpClientModule to app config (see step 2)

**Issue:** Backend returns 500 error
- **Solution:** Check if SpeechBrain dependencies are installed correctly

**Issue:** Model download fails
- **Solution:** Ensure internet connection, model will download on first use

---

## 🎯 Expected Results

After completing all changes:
- ✅ No TypeScript errors
- ✅ Enrollment sends audio to backend
- ✅ Backend stores baseline embeddings
- ✅ Verification returns real-time percentages
- ✅ UI displays match percentage (e.g., "🎤 85%")
- ✅ Console shows verification logs
- ✅ Suspicious activity detected when different speaker
