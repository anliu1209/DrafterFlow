# DrafterFlow — container image.
# Host-agnostic: runs as-is on Render (free), a VPS, or any Docker host.
FROM python:3.13-slim

# Runtime shared libs required by the manylinux wheels (scipy/OpenBLAS -> libgomp1,
# opencv-python-headless -> libglib2.0-0). No compiler needed: all deps have wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Bind all interfaces so Render / a reverse proxy can reach the app. Local dev can
# override with DF_HOST=127.0.0.1. Render sets PORT itself; this is just a default.
ENV DF_HOST=0.0.0.0
ENV PORT=8000
EXPOSE 8000

CMD ["python", "server.py"]
