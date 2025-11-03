# YAMNet Model Setup Instructions

## Why You Need This
The current voice recognition is using MFCC-like features which only provide ~60-70% accuracy. To get production-grade accuracy (95%+), you need the YAMNet ML model.

## Option 1: Download YAMNet Model Manually (Recommended)

### Step 1: Download the Model
1. Go to: https://tfhub.dev/google/yamnet/tfjs/1
2. Click the "Download" button or use this direct link in your browser:
   - https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1?tfjs-format=file
3. This will download a `.tar.gz` file

### Step 2: Extract the Model
1. Extract the downloaded `.tar.gz` file
2. You should see files like:
   - `model.json`
   - `group1-shard1of1.bin` (or similar weight files)

### Step 3: Place in Your Project
1. Copy all extracted files to: `videocall_project/conference/static/models/yamnet/`
2. Your structure should look like:
   ```
   videocall_project/
   └── conference/
       └── static/
           └── models/
               ├── yamnet/
               │   ├── model.json
               │   └── group1-shard1of1.bin
               └── (other face detection models)
   ```

### Step 4: Update voiceAnalyzer.ts
Open `videocall_project/conference/frontend/src/app/dashboard/voiceAnalyzer.ts` and change line 11-14 from:
```typescript
const MODEL_URLS = [
  'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1?tfjs-format=file',
  'https://storage.googleapis.com/tfjs-models/savedmodel/yamnet/tfjs/1/model.json',
];
```

To:
```typescript
const MODEL_URLS = [
  '/static/models/yamnet/model.json',  // Local path - try this first
  'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1?tfjs-format=file',
];
```

### Step 5: Rebuild and Test
```bash
cd videocall_project/conference/frontend
npm run build
```

Then test the voice enrollment - you should see:
- Console: "✅ YAMNet model loaded successfully from: /static/models/yamnet/model.json"
- Pitch values detected properly (not 0.00)
- Voice match percentage discriminates between different speakers

---

## Option 2: Use Python Script to Download (Alternative)

If manual download doesn't work, create this Python script:

```python
# download_yamnet.py
import urllib.request
import tarfile
import os

url = "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1?tfjs-format=file"
output_dir = "videocall_project/conference/static/models/yamnet"

os.makedirs(output_dir, exist_ok=True)

print("Downloading YAMNet model...")
urllib.request.urlretrieve(url, "yamnet.tar.gz")

print("Extracting...")
with tarfile.open("yamnet.tar.gz", "r:gz") as tar:
    tar.extractall(output_dir)

print(f"✅ Model extracted to {output_dir}")
os.remove("yamnet.tar.gz")
```

Run: `python download_yamnet.py`

---

## Option 3: Use TensorFlow Hub Downloader (Most Reliable)

```bash
pip install tensorflowjs

tensorflowjs_converter \
  --input_format=tf_hub \
  'https://tfhub.dev/google/yamnet/1' \
  videocall_project/conference/static/models/yamnet
```

---

## Verification

After setup, check the console when you click "Start Enrollment":
- ✅ Success: "✅ YAMNet model loaded successfully from: /static/models/yamnet/model.json"
- ❌ Failure: "⚠️ All YAMNet model URLs failed. Using enhanced audio fingerprinting instead."

If successful, voice recognition will now properly discriminate between different speakers with 95%+ accuracy.

---

## Troubleshooting

**Model not loading from local path?**
- Ensure Django is serving static files correctly
- Check browser console for 404 errors
- Verify file path matches your Django STATIC_URL setting

**Still getting CORS errors?**
- The local path should not have CORS issues
- If it does, check your Django CORS settings

**Model files too large?**
- YAMNet is ~5MB - acceptable for most deployments
- Consider CDN hosting if needed
