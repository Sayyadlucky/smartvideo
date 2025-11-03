from django.urls import re_path as url, path
from .views import RedirectToAngular, voice_enroll, voice_enroll_batch, voice_verify
from django.views.static import serve
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    # Voice API endpoints
    path('api/voice/enroll', voice_enroll, name='voice-enroll'),
    path('api/voice/enroll-batch', voice_enroll_batch, name='voice-enroll-batch'),
    path('api/voice/verify', voice_verify, name='voice-verify'),
    
    # Angular app (catch-all, must be last)
    url(r'', view=RedirectToAngular.as_view(), name='ang-app')
]
