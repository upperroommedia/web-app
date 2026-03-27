ARG NODE_VERSION=22
ARG PNPM_VERSION=10.10.0
ARG PLAYWRIGHT_VERSION=1.58.0
ARG YT_DLP_VERSION=2026.03.03
ARG DENO_VERSION=2.2.7

FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /workspace

RUN npm install -g pnpm@${PNPM_VERSION}

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/browser-fallback/package.json apps/browser-fallback/package.json

RUN pnpm install --frozen-lockfile --filter @upperroom/browser-fallback... --ignore-scripts
RUN rm -rf packages/contracts/node_modules

COPY packages/contracts ./packages/contracts
COPY apps/browser-fallback ./apps/browser-fallback

RUN pnpm --dir apps/browser-fallback build

FROM node:${NODE_VERSION}-bookworm-slim AS production
ARG PNPM_VERSION
ARG PLAYWRIGHT_VERSION
ARG YT_DLP_VERSION
ARG DENO_VERSION

ENV NODE_ENV=production
WORKDIR /workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip ffmpeg curl unzip tar \
    && rm -rf /var/lib/apt/lists/*

RUN export DENO_INSTALL=/usr/local \
    && curl -fsSL https://deno.land/install.sh | sh -s -- v${DENO_VERSION} \
    && deno --version

RUN python3 -m pip install --break-system-packages --no-cache-dir "yt-dlp[default]==${YT_DLP_VERSION}" \
    && echo "yt-dlp version: $(yt-dlp --version)"

RUN npm install -g pnpm@${PNPM_VERSION}
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright install --with-deps chromium

COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/.npmrc ./.npmrc
COPY --from=build --chown=node:node /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build --chown=node:node /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/apps/browser-fallback ./apps/browser-fallback

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /workspace/apps/browser-fallback
USER node

CMD ["pnpm", "start"]
