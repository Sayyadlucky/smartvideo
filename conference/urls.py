from django.urls import re_path as url
from .views import RedirectToAngular
from django.views.static import serve
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    url(r'', view=RedirectToAngular.as_view(), name='ang-app')
]
