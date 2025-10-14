# Use official Python runtime
FROM python:3.10-slim

WORKDIR /app

# Copy only requirements first (for caching layers)
COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Copy the whole project
COPY . .

# Move into the folder where manage.py is located
WORKDIR /app/videocall_project/videocall_project/

# Collect static files (optional for Django)
RUN python manage.py collectstatic --noinput || true

# Run Daphne with Django ASGI (Cloud Run expects PORT env)
CMD ["daphne", "-b", "0.0.0.0", "-p", "8080", "videocall_project.asgi:application"]
