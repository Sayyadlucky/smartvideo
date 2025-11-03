# Troubleshooting Guide - Speaker Verification

## Common Issues and Solutions

### 1. Numpy Import Error

**Error:**
```
ImportError: Error importing numpy: you should not try to import numpy from its source directory
```

**Solution:**
```bash
# Uninstall and reinstall numpy
pip uninstall -y numpy
pip install numpy

# If that doesn't work, try:
pip install --force-reinstall numpy
```

### 2. SpeechBrain Model Download Issues

**Error:**
```
Failed to download model from HuggingFace
```

**Solution:**
- Ensure you have internet connection
- Model will download automatically on first use (~200MB)
- Check firewall/proxy settings
- Manually download if needed:
  ```bash
  python -c "from speechbrain.pretrained import EncoderClassifier; EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb')"
  ```

### 3. PyTorch Installation Issues

**Error:**
```
Could not find a version that satisfies the requirement torch
```

**Solution:**
```bash
# For CPU-only (recommended for development):
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# For GPU (if you have CUDA):
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118
```

### 4. Audio Format Conversion Errors

**Error:**
```
Failed to process audio: unsupported format
```

**Solution:**
- Ensure ffmpeg is installed (required by torchaudio)
- Windows: Download from https://ffmpeg.org/download.html
- Add ffmpeg to PATH
- Or install via: `pip install ffmpeg-python`

### 5. CORS Errors in Frontend

**Error:**
```
Access to XMLHttpRequest blocked by CORS policy
```

**Solution:**
Add to `videocall_project/videocall_project/settings.py`:
```python
CORS_ALLOWED_ORIGINS = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
]

INSTALLED_APPS = [
    ...
    'corsheaders',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    ...
]
```

Then install: `pip install django-cors-headers`

### 6. HttpClient Not Found in Angular

**Error:**
```
NullInjectorError: No provider for HttpClient
```

**Solution:**
Already fixed in dashboard.ts by adding HttpClientModule to imports.
If issue persists, check `app.config.ts`:
```typescript
import { provideHttpClient } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    // ... other providers
  ]
};
```

### 7. Model Loading Too Slow

**Issue:**
First request takes 30+ seconds

**Solution:**
- This is normal - model downloads and loads on first use
- Subsequent requests will be fast (model cached in memory)
- For production, pre-download model during deployment

### 8. Low Similarity Scores

**Issue:**
Same speaker getting < 50% match

**Possible Causes:**
- Background noise
- Poor microphone quality
- Different recording conditions (enrollment vs verification)
- Audio codec issues

**Solutions:**
- Use quiet environment for enrollment
- Ensure same microphone for enrollment and verification
- Increase enrollment samples (change ENROLL_SAMPLES to 5)
- Adjust audio settings (echoCancellation, noiseSuppression)

### 9. Memory Issues

**Error:**
```
MemoryError: Unable to allocate array
```

**Solution:**
- Reduce batch size in speaker_verification.py
- Use CPU instead of GPU (already configured)
- Increase system RAM
- Clear old baselines: Call `clear_all_baselines()` periodically

### 10. WebM Audio Not Supported

**Error:**
```
Failed to load audio: unsupported format
```

**Solution:**
- Ensure torchaudio is installed with ffmpeg backend
- Try different audio format in MediaRecorder:
  ```typescript
  const options = { mimeType: 'audio/wav' }; // instead of audio/webm
  ```

## Testing Commands

### Test Backend Endpoints

**Enrollment:**
```bash
curl -X POST http://localhost:8000/api/voice/enroll \
  -F "audio=@test_audio.webm" \
  -F "room=testroom" \
  -F "username=testuser"
```

**Verification:**
```bash
curl -X POST http://localhost:8000/api/voice/verify \
  -F "audio=@test_audio.webm" \
  -F "room=testroom" \
  -F "username=testuser"
```

### Check Model Loading

```python
python manage.py shell

from conference.speaker_verification import get_model
model = get_model()
print("Model loaded successfully!")
```

### Check Dependencies

```bash
pip list | grep -E "speech|torch|numpy"
```

Expected output:
```
numpy                 1.24.x
scipy                 1.10.x
speechbrain           0.5.x
torch                 2.0.x
torchaudio            2.0.x
```

## Performance Optimization

### 1. Pre-load Model on Server Start

Add to `videocall_project/conference/apps.py`:
```python
from django.apps import AppConfig

class ConferenceConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'conference'
    
    def ready(self):
        # Pre-load speaker verification model
        from .speaker_verification import get_model
        try:
            get_model()
            print("✅ Speaker verification model pre-loaded")
        except Exception as e:
            print(f"⚠️ Failed to pre-load model: {e}")
```

### 2. Batch Processing

For multiple users, process in batches to reduce memory usage.

### 3. Model Caching

Model is already cached in memory after first load.

## Debugging Tips

### Enable Verbose Logging

Add to `settings.py`:
```python
LOGGING = {
    'version': 1,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
        },
    },
    'loggers': {
        'conference.speaker_verification': {
            'handlers': ['console'],
            'level': 'DEBUG',
        },
    },
}
```

### Check Audio Quality

```python
# In Django shell
from conference.speaker_verification import audio_bytes_to_tensor
import io

with open('test_audio.webm', 'rb') as f:
    audio_bytes = f.read()
    
tensor = audio_bytes_to_tensor(audio_bytes)
print(f"Audio shape: {tensor.shape}")
print(f"Sample rate: 16000 (expected)")
```

### Monitor Memory Usage

```python
import psutil
import os

process = psutil.Process(os.getpid())
print(f"Memory usage: {process.memory_info().rss / 1024 / 1024:.2f} MB")
```

## Contact & Support

For additional help:
1. Check Django logs: `python manage.py runserver` output
2. Check browser console: F12 → Console tab
3. Check network tab: F12 → Network tab → Filter by "voice"
4. Review implementation docs: SPEAKER_VERIFICATION_IMPLEMENTATION_SUMMARY.md
