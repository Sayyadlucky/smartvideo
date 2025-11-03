import torchaudio

# Monkey patch torchaudio to add list_audio_backends if missing
if not hasattr(torchaudio, 'list_audio_backends'):
    def list_audio_backends():
        # Return a default list of backends
        return ['soundfile']  # Assuming soundfile is available
    torchaudio.list_audio_backends = list_audio_backends

# Now import speechbrain
import speechbrain
