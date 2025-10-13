import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
import videocall.routing

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'videocall_project.settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(
            videocall.routing.websocket_urlpatterns
        )
    ),
})
