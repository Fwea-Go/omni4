# ---- Base image --------------------------------------------------------------
FROM node:20-slim

# ---- System deps (ffmpeg, curl) ---------------------------------------------
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---- App metadata ------------------------------------------------------------
WORKDIR /app
ARG COMMIT_SHA="unknown"
LABEL org.opencontainers.image.source="https://github.com/Fwea-Go/omni4" \
      org.opencontainers.image.revision="$COMMIT_SHA" \
      org.opencontainers.image.title="fwea-audio-encoder" \
      org.opencontainers.image.description="FFmpeg-based profanity cleaner encoder"

# ---- Dedicated non-root user -------------------------------------------------
RUN useradd -m -u 10001 appuser \
  && mkdir -p /app/tmp \
  && chown -R appuser:appuser /app
ENV TMPDIR=/app/tmp

# ---- Install node deps first (better caching) --------------------------------
ENV NODE_ENV=production
COPY --chown=appuser:appuser package*.json ./
# Prefer npm ci when lockfile exists; fallback to npm install when it doesn't
RUN (npm ci --omit=dev || npm install --omit=dev) \
  && npm cache clean --force

# ---- Copy app code -----------------------------------------------------------
COPY --chown=appuser:appuser . .

# ---- Runtime env -------------------------------------------------------------
USER appuser
ENV PORT=3000
# Helpful FFmpeg diagnostics (logs written to /app/tmp)
ENV FFREPORT=file=/app/tmp/ffmpeg-report-%p-%t.log:level=32

# ---- Healthcheck -------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" | grep -q '"ok":true' || exit 1

# ---- Ports & Entrypoint ------------------------------------------------------
EXPOSE 3000
CMD ["node", "server.js"]
