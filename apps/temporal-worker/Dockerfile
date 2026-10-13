ARG NODE_VERSION=22
ARG PNPM_VERSION=12.11.2
FROM node:${NODE_VERSION}-bookworm AS build
ARG PNPM_VERSION
WORKDIR /workspace
ENV CI=true
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches ./patches
COPY apps/temporal-worker/package.json apps/temporal-worker/package.json
COPY apps/process-audio/package.json apps/process-audio/package.json
COPY functions/package.json functions/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/orchestration/package.json packages/orchestration/package.json
COPY function-kits/firestore-send-email/package.json function-kits/firestore-send-email/package.json
COPY function-kits/firestore-algolia-search/package.json function-kits/firestore-algolia-search/package.json
# Installation is constrained to the worker and real provider adapter dependencies.
RUN pnpm install --frozen-lockfile --filter @upperroom/temporal-worker... --filter ./functions... --ignore-scripts
RUN pnpm rebuild @swc/core
COPY . .
RUN pnpm --dir packages/shared build && pnpm --dir packages/contracts build && pnpm --dir packages/orchestration build
RUN pnpm --dir function-kits/firestore-send-email build
RUN pnpm --dir apps/temporal-worker build
# Keep build/test CLIs out of the serving image; preserve workspace runtime links.
RUN pnpm install --prod --offline --frozen-lockfile --filter @upperroom/temporal-worker... --filter ./functions... --ignore-scripts
# Check the final production layout, after pruning, rather than trusting the
# development tree's protobuf identity for Temporal CLI/Cloud JSON replay.
RUN node scripts/check-temporal-history-runtime.mjs
RUN node apps/process-audio/scripts/patch-google-oauth-transport.cjs

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG TEMPORAL_IMAGE_BUILD_ID
LABEL org.opencontainers.image.revision=${TEMPORAL_IMAGE_BUILD_ID}
RUN printf '%s' "${TEMPORAL_IMAGE_BUILD_ID}" | grep -Eq '^[0-9a-f]{40}$' \
    && printf '%s\n' "${TEMPORAL_IMAGE_BUILD_ID}" > /etc/temporal-worker-build-id \
    && chmod 0444 /etc/temporal-worker-build-id
ARG YT_DLP_VERSION=2026.08.19
ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION=1.3.2
ARG DENO_VERSION=2.9.5
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_RELEASE=autobuild-2026-10-12-13-12
ARG FFMPEG_BUILD=n8.1.3-18-g46d899d7a0
ENV NODE_ENV=production PORT=8080
ENV FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe YTDLP_PATH=/usr/local/bin/yt-dlp
ENV TEMPORAL_WORKFLOW_BUNDLE=/workspace/apps/temporal-worker/lib/workflow-bundle.js
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip xz-utils python3 python3-pip aria2 tini \
    && python3 -m pip install --break-system-packages --no-cache-dir "yt-dlp[default]==${YT_DLP_VERSION}" "bgutil-ytdlp-pot-provider==${BGUTIL_YTDLP_POT_PROVIDER_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
# Versioned release assets and publisher-reported SHA256 digests, checked before extraction.
# Digests: GitHub release API for Deno v2.9.5 and BtbN autobuild-2026-10-12-13-12.
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in amd64) deno_arch=x86_64; ffmpeg_arch=linux64; deno_sha=8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530; ffmpeg_sha=5b9d661315095a781ac8e285f788db059076cd41f17fec8b7d78a7b32afa7bbd ;; arm64) deno_arch=aarch64; ffmpeg_arch=linuxarm64; deno_sha=6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0; ffmpeg_sha=33faed5564d12c53ee210442f4e6f2ab80adc23a8430399e041dad692cbb18a4 ;; *) exit 1 ;; esac \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${deno_arch}-unknown-linux-gnu.zip" -o /tmp/deno.zip \
    && echo "${deno_sha}  /tmp/deno.zip" | sha256sum --check --strict \
    && unzip /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip \
    && deno --version | head -n 1 | grep -F "deno ${DENO_VERSION}" \
    && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/ffmpeg-${FFMPEG_BUILD}-${ffmpeg_arch}-gpl-8.1.tar.xz" -o /tmp/ffmpeg.tar.xz \
    && echo "${ffmpeg_sha}  /tmp/ffmpeg.tar.xz" | sha256sum --check --strict \
    && mkdir /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 \
    && cp /tmp/ffmpeg/bin/ffmpeg /tmp/ffmpeg/bin/ffprobe /usr/local/bin/ \
    && rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz \
    && ffmpeg -version | head -n 1 | grep -F "${FFMPEG_VERSION}" \
    && yt-dlp --version | grep -Fx "${YT_DLP_VERSION}"
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/function-kits ./function-kits
COPY --from=build --chown=node:node /workspace/functions ./functions
COPY --from=build --chown=node:node /workspace/apps/process-audio ./apps/process-audio
COPY --from=build --chown=node:node /workspace/apps/temporal-worker ./apps/temporal-worker
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/temporal-worker/lib/apps/temporal-worker/src/index.js"]
