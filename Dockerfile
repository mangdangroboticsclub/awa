# OpenClaw AWA Worker — Production Image
#
# Multi-stage build:
#   1. builder — installs native deps (isolated-vm) and npm packages
#   2. runtime — minimal image with Chromium + app code
#
# See:
#   - docker-compose.yml  — local stack (worker + GCS emulator)
#   - .devcontainer/      — dev container for VS Code

# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /build

# Install build tools for isolated-vm native addon
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --production

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-slim

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime system dependencies:
#   - Chromium (system Chromium as fallback)
#   - Playwright system libraries
RUN apt-get update && apt-get install -y \
    chromium \
    wget \
    ca-certificates \
    procps \
    libgconf-2-4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libnss3 \
    libxss1 \
    libasound2 \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright system deps
RUN npx playwright install-deps chromium 2>/dev/null || true

ENV DEBIAN_FRONTEND=dialog

WORKDIR /app

# Copy production node_modules from builder
COPY --from=builder /build/node_modules ./node_modules

# Switch to node user to install Playwright browsers into its own cache
# (system Chromium has --remote-debugging-pipe compatibility issues;
#  the bundled version works reliably in this container)
USER node
RUN mkdir -p /home/node/.cache/ms-playwright && \
    npx playwright install chromium 2>&1

# Copy application code
COPY package.json ./
COPY src/ ./src/

# Port exposed by the worker HTTP server
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
    CMD curl -sf http://localhost:8080/healthz || exit 1

# Run as non-root user
USER node

CMD ["node", "src/server.js"]
