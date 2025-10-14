# Use official Python runtime
FROM python:3.10-slim

# Set working directory inside the container
WORKDIR /app

# Copy everything into the container
COPY . .

# Change directory where manage.py and requirements.txt are located
WORKDIR /app/videocall_project/videocall_project/

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Collect static files (optional, for Django)
RUN python manage.py collectstatic --noinput || true

# Start Daphne on Cloud Run's PORT (fallback to 8000 locally)
CMD exec daphne -b 0.0.0.0 -p ${PORT:-8000} videocall_project.asgi:application
