# Use official Python runtime
FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Copy project files
COPY . .

# Move into the directory where manage.py exists
WORKDIR /app/videocall_project/videocall_project

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Collect static files
RUN python manage.py collectstatic --noinput

# Run Daphne with Cloud Run's expected $PORT
CMD exec daphne -b 0.0.0.0 -p ${PORT:-8080} videocall_project.asgi:application
