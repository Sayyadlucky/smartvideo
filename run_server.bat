@echo off
set DJANGO_SETTINGS_MODULE=videocall_project.settings
python -m daphne -e ssl:8000:privateKey=cert/localhost+2-key.pem:certKey=cert/localhost+2.pem videocall_project.videocall_project.asgi:application
pause
