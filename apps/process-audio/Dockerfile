# Use Node 22 across both runtime profiles. Hetzner still needs the yt-dlp JS runtime,
# while Cloud Run only uses the storage-backed trim/transcode path.
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.10.0
ARG PROCESS_AUDIO_RUNTIME_PROFILE=hetzner
ARG YT_DLP_VERSION=2026.07.04
ARG FFMPEG_VERSION=8.1
ARG FFMPEG_BUILD_BASE_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION=1.3.1
ARG DENO_VERSION=2.9.1
ARG DEBIAN_MIRROR=https://mirrors.edge.kernel.org/debian
ARG DEBIAN_SECURITY_MIRROR=https://security.debian.org/debian-security
ARG DEBIAN_UPDATES_MIRROR=https://mirrors.edge.kernel.org/debian
ARG TARGETOS=linux
ARG TARGETARCH=amd64

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-bookworm AS build
ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG DEBIAN_UPDATES_MIRROR
ARG TARGETOS
ARG TARGETARCH
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

# Copy the workspace packages used by process-audio. Preserve the package-local
# node_modules workspace links created by pnpm install so contracts can still
# resolve @upperroom/shared when we compile inside the image.
COPY packages/contracts ./packages/contracts
COPY packages/shared ./packages/shared
COPY apps/process-audio ./apps/process-audio

# Build the two local workspace packages that process-audio imports at runtime,
# then build the service itself. This avoids depending on generated JS artifacts
# being checked into git for Cloud Run images.
RUN pnpm --dir packages/shared build \
    && pnpm --dir packages/contracts build \
    && pnpm --dir apps/process-audio build

# ---------- Production stage ----------
FROM node:${NODE_VERSION}-bookworm-slim AS production
ARG PROCESS_AUDIO_RUNTIME_PROFILE
ARG YT_DLP_VERSION
ARG FFMPEG_VERSION
ARG FFMPEG_BUILD_BASE_URL
ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION
ARG DENO_VERSION
ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG DEBIAN_UPDATES_MIRROR
ARG TARGETOS
ARG TARGETARCH
ENV NODE_ENV=production
ENV PROCESS_AUDIO_RUNTIME_PROFILE=${PROCESS_AUDIO_RUNTIME_PROFILE}
ENV PROCESS_AUDIO_YT_DLP_VERSION=${YT_DLP_VERSION}
ENV PROCESS_AUDIO_FFMPEG_VERSION=${FFMPEG_VERSION}
WORKDIR /workspace

# Install common runtime dependencies for all profiles.
RUN apt-get update -o Acquire::Retries=3 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::By-Hash "yes";\n' > /etc/apt/apt.conf.d/99byhash \
    && printf "deb %s bookworm main\n" "$DEBIAN_MIRROR" > /etc/apt/sources.list \
    && printf "deb %s bookworm-security main\n" "$DEBIAN_SECURITY_MIRROR" >> /etc/apt/sources.list \
    && printf "deb %s bookworm-updates main\n" "$DEBIAN_UPDATES_MIRROR" >> /etc/apt/sources.list \
    && apt-get update -o Acquire::Retries=3 -o Acquire::https::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends curl tar xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN if [ "${PROCESS_AUDIO_RUNTIME_PROFILE}" = "hetzner" ]; then \
      apt-get update -o Acquire::Retries=3 -o Acquire::https::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
      && apt-get install -y --no-install-recommends python3 python3-pip unzip aria2 \
      && rm -rf /var/lib/apt/lists/* \
      && export DENO_INSTALL=/usr/local \
      && curl -fsSL https://deno.land/install.sh | sh -s -- v${DENO_VERSION} \
      && deno --version \
      && python3 -m pip install --break-system-packages --no-cache-dir \
          "yt-dlp[default]==${YT_DLP_VERSION}" \
          "bgutil-ytdlp-pot-provider==${BGUTIL_YTDLP_POT_PROVIDER_VERSION}" \
      && echo "yt-dlp version: $(yt-dlp --version)" \
      && echo "aria2 version: $(aria2c --version | head -n 1)" \
      && python3 -m pip show bgutil-ytdlp-pot-provider; \
    else \
      echo "Skipping yt-dlp/browser runtime dependencies for ${PROCESS_AUDIO_RUNTIME_PROFILE} profile"; \
    fi

RUN detected_arch="$(dpkg --print-architecture)" \
    && resolved_os="${TARGETOS:-linux}" \
    && case "${resolved_os}/${detected_arch}" in \
      linux/amd64) ffmpeg_archive="ffmpeg-n${FFMPEG_VERSION}-latest-linux64-gpl-${FFMPEG_VERSION}.tar.xz" ;; \
      linux/arm64) ffmpeg_archive="ffmpeg-n${FFMPEG_VERSION}-latest-linuxarm64-gpl-${FFMPEG_VERSION}.tar.xz" ;; \
      *) echo "Unsupported FFmpeg target platform: ${resolved_os}/${detected_arch}" >&2; exit 1 ;; \
    esac \
    && echo "Installing FFmpeg archive: ${ffmpeg_archive} for ${resolved_os}/${detected_arch}" \
    && curl -fsSL "${FFMPEG_BUILD_BASE_URL}/${ffmpeg_archive}" -o /tmp/ffmpeg.tar.xz \
    && mkdir -p /opt/ffmpeg \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
    && ffmpeg_dir="$(find /tmp -maxdepth 1 -type d -name 'ffmpeg-*' | head -n 1)" \
    && test -n "$ffmpeg_dir" \
    && cp -a "${ffmpeg_dir}/bin" /opt/ffmpeg/bin \
    && rm -rf /tmp/ffmpeg.tar.xz "$ffmpeg_dir" \
    && ln -sf /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg \
    && ln -sf /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe \
    && ffmpeg -version | head -n 1 \
    && ffprobe -version | head -n 1

# Copy the prepared workspace from the build stage
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/.npmrc ./.npmrc
COPY --from=build --chown=node:node /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build --chown=node:node /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/apps/process-audio ./apps/process-audio

# Keep Google OAuth token fetches uncompressed. On the Hetzner runtime, gtoken's
# node-fetch transport can intermittently fail compressed token responses with
# ERR_STREAM_PREMATURE_CLOSE, which blocks deferred YouTube queue recovery.
RUN node -e "const fs = require('node:fs'); const file = '/workspace/node_modules/gtoken/build/src/index.js'; const needle = \"headers: { 'Content-Type': 'application/x-www-form-urlencoded' },\"; const replacement = \"headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Encoding': 'identity' },\"; let source = fs.readFileSync(file, 'utf8'); if (!source.includes(replacement)) { if (!source.includes(needle)) { throw new Error('Unable to patch gtoken token request headers'); } source = source.replace(needle, replacement); fs.writeFileSync(file, source); }"

# The final image should not depend on pnpm's workspace symlink layout surviving
# multi-stage copies. Flatten the two local workspace packages into the app-local
# node_modules tree so Node can resolve exported subpaths reliably at runtime.
RUN mkdir -p /workspace/apps/process-audio/node_modules/@upperroom \
    && rm -rf /workspace/apps/process-audio/node_modules/@upperroom/contracts \
              /workspace/apps/process-audio/node_modules/@upperroom/shared \
    && cp -a /workspace/packages/contracts /workspace/apps/process-audio/node_modules/@upperroom/contracts \
    && cp -a /workspace/packages/shared /workspace/apps/process-audio/node_modules/@upperroom/shared

WORKDIR /workspace/apps/process-audio
USER node

# Start the app
CMD ["node", "./dist/index.js"]
