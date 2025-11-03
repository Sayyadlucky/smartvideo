from django.shortcuts import render
from django.views import View
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework import status
from .speaker_verification import enroll_voice, enroll_voice_batch, verify_voice
import logging

logger = logging.getLogger(__name__)


class RedirectToAngular(View):

    def get(self, request, *args, **kwargs):
        return render(request, 'index.html')


@api_view(['POST'])
def voice_enroll(request):
    """
    API endpoint for voice enrollment
    Accepts audio file and user info, extracts and stores embedding
    """
    try:
        # Get audio file from request
        audio_file = request.FILES.get('audio')
        if not audio_file:
            return Response(
                {"success": False, "message": "No audio file provided"},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Get user info
        room = request.data.get('room', 'default')
        username = request.data.get('username', 'guest')
        
        # Read audio bytes
        audio_bytes = audio_file.read()
        
        # Enroll voice
        result = enroll_voice(audio_bytes, room, username)
        
        if result['success']:
            return Response(result, status=status.HTTP_200_OK)
        else:
            return Response(result, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
            
    except Exception as e:
        logger.error(f"Voice enrollment error: {e}")
        return Response(
            {"success": False, "message": f"Server error: {str(e)}"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['POST'])
def voice_enroll_batch(request):
    """
    API endpoint for batched voice enrollment.
    Accepts multiple audio files, aggregates embeddings, and stores baseline once.
    """
    try:
        audio_files = request.FILES.getlist('files')
        if not audio_files:
            return Response(
                {"success": False, "message": "No audio samples provided"},
                status=status.HTTP_400_BAD_REQUEST
            )

        room = request.data.get('room', 'default')
        username = request.data.get('username', 'guest')

        audio_payloads = [f.read() for f in audio_files if f]
        if not audio_payloads:
            return Response(
                {"success": False, "message": "Unable to read audio samples"},
                status=status.HTTP_400_BAD_REQUEST
            )

        result = enroll_voice_batch(audio_payloads, room, username)
        status_code = status.HTTP_200_OK if result.get('success') else status.HTTP_500_INTERNAL_SERVER_ERROR
        return Response(result, status=status_code)
    except Exception as exc:
        logger.error(f"Voice enrollment batch error: {exc}")
        return Response(
            {"success": False, "message": f"Server error: {str(exc)}"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['POST'])
def voice_verify(request):
    """
    API endpoint for voice verification
    Accepts audio file and user info, compares with stored baseline
    """
    try:
        # Get audio file from request
        audio_file = request.FILES.get('audio')
        if not audio_file:
            return Response(
                {"success": False, "message": "No audio file provided"},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Get user info
        room = request.data.get('room', 'default')
        username = request.data.get('username', 'guest')
        
        # Read audio bytes
        audio_bytes = audio_file.read()
        
        # Verify voice
        result = verify_voice(audio_bytes, room, username)
        
        if result['success']:
            return Response(result, status=status.HTTP_200_OK)
        else:
            return Response(result, status=status.HTTP_400_BAD_REQUEST)
            
    except Exception as e:
        logger.error(f"Voice verification error: {e}")
        return Response(
            {"success": False, "message": f"Server error: {str(e)}"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
