# Use Node 22 (required by yt-dlp JS runtime) with Debian-slim (required for glibc DNS in ffmpeg)
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.10.0
ARG PLAYWRIGHT_VERSION=1.58.0
ARG YT_DLP_VERSION=2026.03.03
ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION=1.3.1
ARG DENO_VERSION=2.2.7
ARG DEBIAN_MIRROR=https://mirrors.edge.kernel.org/debian
ARG DEBIAN_SECURITY_MIRROR=https://security.debian.org/debian-security
ARG DEBIAN_UPDATES_MIRROR=https://mirrors.edge.kernel.org/debian

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-bookworm AS build
ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG DEBIAN_UPDATES_MIRROR
WORKDIR /workspace

# Install build dependencies (needed for native modules during npm install)
RUN apt-get update -o Acquire::Retries=3 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::By-Hash "yes";\n' > /etc/apt/apt.conf.d/99byhash \
    && printf "deb %s bookworm main\n" "$DEBIAN_MIRROR" > /etc/apt/sources.list \
    && printf "deb %s bookworm-security main\n" "$DEBIAN_SECURITY_MIRROR" >> /etc/apt/sources.list \
    && printf "deb %s bookworm-updates main\n" "$DEBIAN_UPDATES_MIRROR" >> /etc/apt/sources.list \
    && apt-get update -o Acquire::Retries=3 -o Acquire::https::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@${PNPM_VERSION}

# Copy workspace manifests first so dependency installation can be cached
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/process-audio/package.json apps/process-audio/package.json

# Install only the process-audio workspace and its dependencies.
# Ignore lifecycle scripts here because the root workspace postinstall expects
# local tooling that is not needed inside this image build.
RUN pnpm install --frozen-lockfile --filter @upperroom/process-audio... --ignore-scripts

# Remove workspace-local node_modules symlinks from the shared packages before
# copying full source trees into the same paths. Keep the app's node_modules so
# pnpm workspace links remain available during `tsc`.
RUN rm -rf packages/shared/node_modules packages/contracts/node_modules

# Copy the workspace packages used by process-audio
COPY packages/contracts ./packages/contracts
COPY packages/shared ./packages/shared
COPY apps/process-audio ./apps/process-audio

# Build only the service. It imports checked-in JS/types from workspace
# packages, so rebuilding broader monorepo packages inside the image is
# unnecessary and pulls in browser-only transitive deps.
RUN pnpm --dir apps/process-audio build

# ---------- Production stage ----------
FROM node:${NODE_VERSION}-bookworm-slim AS production
ARG PLAYWRIGHT_VERSION
ARG YT_DLP_VERSION
ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION
ARG DENO_VERSION
ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG DEBIAN_UPDATES_MIRROR
ENV NODE_ENV=production
WORKDIR /workspace

# Install runtime dependencies:
# - python3, make, g++: needed for native Node modules (protobufjs, etc.)
# - python3-pip: installs plugin-capable yt-dlp + PO token plugin
# - ffmpeg: includes ffmpeg + ffprobe (dynamically linked, supports DNS)
# - tar: extract persisted Chromium profile archives
# - curl + unzip: install Deno, the preferred yt-dlp JS runtime
RUN apt-get update -o Acquire::Retries=3 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::By-Hash "yes";\n' > /etc/apt/apt.conf.d/99byhash \
    && printf "deb %s bookworm main\n" "$DEBIAN_MIRROR" > /etc/apt/sources.list \
    && printf "deb %s bookworm-security main\n" "$DEBIAN_SECURITY_MIRROR" >> /etc/apt/sources.list \
    && printf "deb %s bookworm-updates main\n" "$DEBIAN_UPDATES_MIRROR" >> /etc/apt/sources.list \
    && apt-get update -o Acquire::Retries=3 -o Acquire::https::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends python3 python3-pip make g++ ffmpeg curl unzip tar \
    && rm -rf /var/lib/apt/lists/*

RUN export DENO_INSTALL=/usr/local \
    && curl -fsSL https://deno.land/install.sh | sh -s -- v${DENO_VERSION} \
    && deno --version

# Install plugin-capable yt-dlp and the bgutil PO token provider plugin.
# The plugin talks to an external bgutil provider over HTTP, configured via
# YTDLP_POT_PROVIDER_BASE_URL at runtime.
RUN python3 -m pip install --break-system-packages --no-cache-dir \
       "yt-dlp[default]==${YT_DLP_VERSION}" \
       "bgutil-ytdlp-pot-provider==${BGUTIL_YTDLP_POT_PROVIDER_VERSION}" \
    && echo "yt-dlp version: $(yt-dlp --version)" \
    && python3 -m pip show bgutil-ytdlp-pot-provider

RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright install --with-deps chromium

# Install pnpm and copy the prepared workspace from the build stage
RUN npm install -g pnpm@${PNPM_VERSION}
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/.npmrc ./.npmrc
COPY --from=build --chown=node:node /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build --chown=node:node /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/apps/process-audio ./apps/process-audio

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /workspace/apps/process-audio
USER node

# Start the app
CMD ["pnpm", "start"]
