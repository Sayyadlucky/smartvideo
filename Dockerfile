# Use official Python runtime
FROM python:3.10-slim

WORKDIR /app

# Copy only requirements first (for caching layers)
COPY videocall_project/videocall_project/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Now copy the rest of the code
COPY . .

# Set working directory where manage.py lives
WORKDIR /app/videocall_project/videocall_project/

RUN python manage.py collectstatic --noinput || true

CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "videocall_project.asgi:application"]
