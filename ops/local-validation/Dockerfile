# Linux x64 browser/native-tool environment for the same validation entrypoint as CI.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac

USER root
ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/opt/java/openjdk \
    CLOUDSDK_PYTHON=/usr/bin/python3 \
    CLOUDSDK_CORE_DISABLE_PROMPTS=1 \
    NEXT_TELEMETRY_DISABLED=1
ENV PATH="/opt/java/openjdk/bin:${PATH}"

RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl ffmpeg git python3 xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Vendor archives and checksums are pinned; never use host Node, Java or credentials.
RUN curl --fail --location --silent --show-error \
      https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz -o /tmp/node.tar.xz \
 && echo 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de  /tmp/node.tar.xz' | sha256sum --check \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && npm install --global pnpm@12.11.2

RUN curl --fail --location --silent --show-error \
      'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz' -o /tmp/java.tar.gz \
 && echo 'ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94  /tmp/java.tar.gz' | sha256sum --check \
 && mkdir -p /opt/java/openjdk \
 && tar -xzf /tmp/java.tar.gz -C /opt/java/openjdk --strip-components=1 \
 && rm /tmp/java.tar.gz

# Use Google's signed package repository for the versioned CLI package.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends gnupg \
 && curl --fail --location --silent --show-error https://packages.cloud.google.com/apt/doc/apt-key.gpg -o /tmp/google-cloud.gpg \
 && gpg --dearmor --output /usr/share/keyrings/cloud.google.gpg /tmp/google-cloud.gpg \
 && echo 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update \
 && CLOUDSDK_SKIP_PY_COMPILATION=1 apt-get install --yes --no-install-recommends google-cloud-cli=588.0.0-0 \
 && rm -rf /var/lib/apt/lists/* /tmp/google-cloud.gpg \
 && mkdir -p /root/.cache \
 && ln -s /ms-playwright /root/.cache/ms-playwright

WORKDIR /workspace
