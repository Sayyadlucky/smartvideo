# Use official Python runtime
FROM python:3.10-slim

# Set working directory in container
WORKDIR /app

# Copy requirements first
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the whole project
COPY . .

# Collect static files (ignore errors if no static)
RUN python manage.py collectstatic --noinput || true

# Expose Cloud Run default port
EXPOSE 8080

# Run Daphne (ASGI server) on Cloud Run-compatible port
CMD ["daphne", "-b", "0.0.0.0", "-p", "8080", "videocall_project.asgi:application"]
