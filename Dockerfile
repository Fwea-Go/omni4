FROM node:20-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ARG COMMIT_SHA="unknown"
LABEL org.opencontainers.image.source="https://github.com/Fwea-Go/omni4" \
      org.opencontainers.image.revision="$COMMIT_SHA" \
      org.opencontainers.image.title="fwea-audio-encoder" \
      org.opencontainers.image.description="FFmpeg-based profanity cleaner encoder"

RUN useradd -m appuser
RUN mkdir -p /app/tmp && chown -R appuser:appuser /app/tmp
ENV TMPDIR=/app/tmp

# Install deps first (better caching)
COPY --chown=appuser:appuser package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev || npm install --omit=dev

# App code
COPY --chown=appuser:appuser . .

# Drop privileges: run as non-root user
USER appuser
ENV PORT=3000

# Container health check (requires /health endpoint in server.js)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sS --connect-timeout 2 --max-time 4 "http://localhost:${PORT:-3000}/health" | grep -q '"ok":true' || exit 1

EXPOSE 3000
CMD ["node", "server.js"]
