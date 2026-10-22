# syntax=docker/dockerfile:1
# check=skip=FromPlatformFlagConstDisallowed
#
# Binlight analysis runner: REA + Ghidra 12.1.4 + JDK 21 for linux/amd64.
# Ghidra ships its native decompiler only for linux_x86_64 / win_x86_64, so on
# Apple Silicon this runs under emulation (slow but reliable).
# Build with docker/runner/build.sh; it supplies the verified Ghidra zip as the
# `ghidra-dist` build context. The server runs it with --network none,
# a non-root user, a read-only root filesystem and the target mounted read-only.

FROM --platform=linux/amd64 node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS node

FROM --platform=linux/amd64 eclipse-temurin:21-jdk-noble@sha256:107215954359f1ab0be058a247d7c64ed6e69c71c1682d471d38ef751ec8e964

ARG REA_VERSION=6.7.0
ARG GHIDRA_ZIP=ghidra_12.1.4_PUBLIC_20260921.zip
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && node --version && npm --version

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/*

# The zip is bind-mounted for this step only, so it never lands in a layer.
RUN --mount=type=bind,from=ghidra-dist,source=${GHIDRA_ZIP},target=/tmp/ghidra.zip \
    echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum -c - \
 && unzip -q /tmp/ghidra.zip -d /opt \
 && mv /opt/ghidra_12.1.4_PUBLIC /opt/ghidra \
 && test -x /opt/ghidra/Ghidra/Features/Decompiler/os/linux_x86_64/decompile

# --ignore-scripts: Frida's install script downloads binaries; phase 0 does not use Frida.
RUN npm install -g --ignore-scripts "rea-agents@${REA_VERSION}" \
 && npm cache clean --force \
 && test "$(rea --version)" = "${REA_VERSION}"

# A real non-root user: Ghidra needs a user name (REA's launcher clears
# JAVA_TOOL_OPTIONS, so -Duser.name cannot be injected). The server mounts a
# per-session named volume at /work; Docker seeds it from this directory, so
# it starts owned by binlight. REA's bridge socket must live on a Linux
# filesystem: chmod on a socket fails on a macOS bind mount.
RUN useradd --uid 10001 --user-group --home-dir /work --no-create-home --shell /usr/sbin/nologin binlight \
 && mkdir -p /work/tmp \
 && chown -R binlight:binlight /work

ENV GHIDRA_INSTALL_DIR=/opt/ghidra \
    HOME=/work \
    TMPDIR=/work/tmp
WORKDIR /work
USER binlight

LABEL org.opencontainers.image.title="binlight-runner" \
      dev.binlight.rea-version="${REA_VERSION}" \
      dev.binlight.ghidra-sha256="${GHIDRA_SHA256}"

ENTRYPOINT ["rea"]
CMD ["--mcp"]
