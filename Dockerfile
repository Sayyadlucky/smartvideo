# Use official Python runtime
FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Copy project files
COPY . .

# Change directory into the folder where manage.py exists
WORKDIR /app/videocall_project/videocall_project/

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Collect static files (if needed)
RUN python manage.py collectstatic --noinput

# Run Daphne with Cloud Run-compatible port
CMD exec daphne -b 0.0.0.0 -p ${PORT:-8080} myproject.asgi:application

