# Voice Recognition Feature Implementation

## Overview
Added voice recognition functionality to the video call application that:
- Records a baseline voice sample during the initial screen
- Analyzes voice characteristics in real-time during calls
- Displays voice match percentage below gaze status

## Implementation Details

### 1. Voice Analyzer Module (`voiceAnalyzer.ts`)
**Features:**
- Voice feature extraction using Web Audio API
- Pitch detection using autocorrelation
- Spectral centroid calculation
- Zero-crossing rate analysis
- Simplified MFCC (Mel-frequency cepstral coefficients)
- Voice matching algorithm with weighted comparison

**Key Functions:**
- `startBaselineRecording()` - Captures initial voice sample
- `stopBaselineRecording()` - Finalizes baseline with averaged features
- `collectBaselineSample()` - Collects voice samples during recording
- `startVoiceMonitoring()` - Monitors voice in real-time during calls
- `stopVoiceMonitoring()` - Stops voice analysis

### 2. Dashboard Component Updates (`dashboard.ts`)
**Added:**
- Voice status in Participant interface
- Voice recording state management
- `startVoiceRecording()` - Initiates 5-second voice sample recording
- `stopVoiceRecording()` - Finalizes voice baseline
- `handleVoiceStatus()` - Updates local voice status
- Voice monitoring integration with microphone toggle
- WebSocket message handling for `voice_update` events

**Integration Points:**
- Voice recording on initial name/terms screen
- Voice monitoring starts when microphone is enabled
- Voice status broadcast via WebSocket
- Voice status display in participant tiles

### 3. UI Updates (`dashboard.html`)
**Initial Screen:**
- Voice recording section with progress bar
- "Start Recording" button
- "Re-record" button for retaking samples
- Visual feedback during 5-second recording

**Call Screen:**
- Voice match percentage display below gaze status
- Purple-colored voice indicator (🎤)
- Voice status in participant list sidebar

### 4. Backend Updates (`consumers.py`)
**Added:**
- `voice_status` message type handler
- `voice_update` group event broadcaster
- Voice status propagation to all participants

## Usage Flow

1. **Initial Screen:**
   - User enters name
   - User accepts terms & conditions
   - User clicks "Start Recording"
   - Speaks clearly for 5 seconds
   - System captures voice baseline
   - User clicks "Join Room"

2. **During Call:**
   - User enables microphone
   - Voice monitoring starts automatically
   - System compares ongoing voice with baseline
   - Match percentage displayed (e.g., "85%", "N/A")
   - Updates broadcast to all participants every 500ms

## Voice Analysis Algorithm

**Features Analyzed:**
1. **Pitch** (30% weight) - Fundamental frequency detection
2. **Volume** (10% weight) - RMS amplitude
3. **Spectral Centroid** (15% weight) - Frequency distribution
4. **Zero-Crossing Rate** (10% weight) - Signal complexity
5. **MFCC** (35% weight) - Voice timbre characteristics

**Match Calculation:**
- Compares current features with baseline averages
- Weighted difference calculation
- Converts to similarity percentage (0-100%)
- Displays as "XX%" or "N/A" if no baseline

## Technical Notes

- Uses Web Audio API (native browser support)
- No external dependencies required
- Real-time analysis at ~2 FPS (500ms intervals)
- Voice Activity Detection filters out silence
- Baseline requires minimum speaking volume

## Future Enhancements

- [ ] Add voice authentication threshold alerts
- [ ] Store baseline in localStorage for persistence
- [ ] Add visual waveform during recording
- [ ] Implement speaker identification for multiple users
- [ ] Add voice quality indicators
- [ ] Export voice analytics data

## Testing Checklist

- [ ] Voice recording on initial screen works
- [ ] Progress bar displays correctly
- [ ] Baseline creation successful with clear speech
- [ ] Voice monitoring starts with microphone
- [ ] Match percentage updates in real-time
- [ ] Voice status displays on video tiles
- [ ] Voice status shows in participant sidebar
- [ ] WebSocket broadcasts voice updates
- [ ] Multiple participants see each other's voice status
- [ ] Voice monitoring stops when mic is disabled
