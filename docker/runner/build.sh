#!/usr/bin/env bash
# Builds binlight-runner:rea-<version> for linux/amd64.
# Uses a local Ghidra zip if present (BINLIGHT_GHIDRA_ZIP, default
# ~/Applications/ghidra.zip), otherwise downloads the release. Either way the
# SHA-256 is checked here and again inside the build.
set -euo pipefail

REA_VERSION="6.7.0"
GHIDRA_ZIP_NAME="ghidra_12.1.4_PUBLIC_20260921.zip"
GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/${GHIDRA_ZIP_NAME}"
GHIDRA_SHA256="ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db"
IMAGE="binlight-runner:rea-${REA_VERSION}"

here="$(cd "$(dirname "$0")" && pwd)"
dist="${HOME}/.binlight/ghidra-dist"
mkdir -p "$dist"
staged="${dist}/${GHIDRA_ZIP_NAME}"

sha256() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1 || sha256sum "$1" | cut -d' ' -f1; }

if [[ ! -f "$staged" ]] || [[ "$(sha256 "$staged")" != "$GHIDRA_SHA256" ]]; then
  local_zip="${BINLIGHT_GHIDRA_ZIP:-${HOME}/Applications/ghidra.zip}"
  if [[ -f "$local_zip" ]]; then
    echo "Using local Ghidra zip: $local_zip"
    ln -f "$local_zip" "$staged" 2>/dev/null || cp "$local_zip" "$staged"
  else
    echo "Downloading $GHIDRA_URL"
    curl -fL --retry 3 -o "${staged}.part" "$GHIDRA_URL"
    mv "${staged}.part" "$staged"
  fi
fi

actual="$(sha256 "$staged")"
if [[ "$actual" != "$GHIDRA_SHA256" ]]; then
  echo "Ghidra zip checksum mismatch: expected $GHIDRA_SHA256, got $actual ($staged)" >&2
  rm -f "$staged"
  exit 1
fi
echo "Ghidra zip verified: $GHIDRA_SHA256"

docker buildx build \
  --platform linux/amd64 \
  --load \
  --build-context "ghidra-dist=${dist}" \
  --build-arg "REA_VERSION=${REA_VERSION}" \
  --build-arg "GHIDRA_ZIP=${GHIDRA_ZIP_NAME}" \
  --build-arg "GHIDRA_SHA256=${GHIDRA_SHA256}" \
  -t "$IMAGE" \
  "$here"

echo "Built $IMAGE"
