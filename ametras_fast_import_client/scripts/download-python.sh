#!/usr/bin/env bash
#
# Download a standalone Python runtime for bundling into the Electron app.
# Uses python-build-standalone (astral-sh/python-build-standalone).
#
# Usage:
#   bash scripts/download-python.sh              # auto-detect platform
#   bash scripts/download-python.sh darwin arm64  # explicit
#   bash scripts/download-python.sh win32 x64
#   bash scripts/download-python.sh linux x64
#
# The runtime is placed at: python-runtime/<electron-platform>-<electron-arch>/
# electron-builder picks it up via extraResources.

set -euo pipefail

PYTHON_VERSION="3.12.13"
RELEASE_TAG="20260414"
BASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}"

# Map Electron platform+arch to python-build-standalone target triple
resolve_target() {
  local platform="$1" arch="$2"
  case "${platform}-${arch}" in
    darwin-arm64)  echo "aarch64-apple-darwin" ;;
    darwin-x64)    echo "x86_64-apple-darwin" ;;
    win32-x64)     echo "x86_64-pc-windows-msvc" ;;
    linux-x64)     echo "x86_64-unknown-linux-gnu" ;;
    *)
      echo "Unsupported platform: ${platform}-${arch}" >&2
      exit 1
      ;;
  esac
}

# Auto-detect platform and arch from the current OS
detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux)  echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win32" ;;
    *) echo "unknown" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64)  echo "x64" ;;
    *) echo "unknown" ;;
  esac
}

PLATFORM="${1:-$(detect_platform)}"
ARCH="${2:-$(detect_arch)}"
HOST_PLATFORM="$(detect_platform)"
HOST_ARCH="$(detect_arch)"
TARGET=$(resolve_target "$PLATFORM" "$ARCH")

FILENAME="cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${TARGET}-install_only_stripped.tar.gz"
URL="${BASE_URL}/${FILENAME}"
DEST_DIR="python-runtime/${PLATFORM}-${ARCH}"

echo "==> Downloading Python ${PYTHON_VERSION} for ${PLATFORM}-${ARCH}"
echo "    Target: ${TARGET}"
echo "    URL: ${URL}"

# Clean previous download
rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"

# Download
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

echo "==> Downloading..."
curl -fSL --retry 5 --retry-delay 10 --retry-connrefused --progress-bar -o "$TMPFILE" "$URL"

# Extract — python-build-standalone tarballs have a python/ top-level dir
echo "==> Extracting..."
tar xzf "$TMPFILE" -C "${DEST_DIR}" --strip-components=1

# Strip unnecessary files to minimize bundle size
echo "==> Stripping unnecessary files..."
cd "${DEST_DIR}"

# Remove pip, ensurepip, test suites, idle, tkinter, docs, and build-only files.
#
# Platform-portable removals (safe to run everywhere). These either match
# a Windows-only path (capital "Lib/", "Scripts", "DLLs/", "libs") or use
# the lib/python*/... pattern which only matches the Linux/macOS layout
# where the stdlib lives at lib/python3.X/ — no risk of collision with
# Windows' capital Lib/ here.
rm -rf \
  bin/2to3 \
  bin/2to3-* \
  bin/idle3 \
  bin/idle3.* \
  bin/pip \
  bin/pip3 \
  bin/pip3.* \
  bin/pydoc3 \
  bin/pydoc3.* \
  bin/python*-config \
  Scripts \
  libs \
  tcl \
  DLLs/_tkinter.pyd \
  DLLs/tcl*.dll \
  DLLs/tk*.dll \
  lib/python*/site-packages \
  lib/python*/ensurepip \
  lib/python*/idlelib \
  lib/python*/tkinter \
  lib/python*/turtledemo \
  lib/python*/test \
  lib/python*/unittest/test \
  lib/python*/lib2to3 \
  lib/python*/pydoc_data \
  lib/python*/distutils \
  lib/python*/venv \
  lib/python*/config-* \
  lib/python*/__pycache__/doctest.* \
  lib/python*/__pycache__/pydoc.* \
  Lib/site-packages \
  Lib/ensurepip \
  Lib/idlelib \
  Lib/tkinter \
  Lib/turtledemo \
  Lib/test \
  Lib/unittest/test \
  Lib/lib2to3 \
  Lib/pydoc_data \
  Lib/msilib \
  Lib/venv \
  share \
  include \
  lib/pkgconfig \
  2>/dev/null || true

# Tcl/Tk shared libraries (Linux/macOS only). These patterns MUST NOT run
# on Windows: NTFS is case-insensitive by default, so `lib/thread*` would
# resolve into `Lib/` and delete `Lib/threading.py` — a critical stdlib
# module that `logging` imports at startup. The Windows-side Tcl artifacts
# are removed above via `tcl`, `DLLs/tcl*.dll`, `DLLs/tk*.dll`, `Lib/tkinter`.
if [ "$PLATFORM" != "win32" ]; then
  rm -rf \
    lib/itcl* \
    lib/tcl* \
    lib/tk* \
    lib/thread* \
    lib/libtcl* \
    2>/dev/null || true
fi

# Remove GUI-only Windows helper
rm -f pythonw.exe 2>/dev/null || true

# Remove .pyc files (the engine doesn't need them)
find . -name "*.pyc" -delete 2>/dev/null || true
find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

cd - > /dev/null

# No pre-signing needed on macOS.
# The afterSign hook in package.json runs codesign --force --deep --sign -
# on the whole .app bundle after electron-builder finishes, which re-signs
# all nested Mach-O binaries (including these) in one consistent pass.

# Verify the binary exists
if [ "$PLATFORM" = "win32" ]; then
  PYTHON_BIN="${DEST_DIR}/python.exe"
else
  PYTHON_BIN="${DEST_DIR}/bin/python3"
fi

if [ ! -e "$PYTHON_BIN" ]; then
  echo "ERROR: Python binary not found at ${PYTHON_BIN}" >&2
  exit 1
fi

if [ "$PLATFORM" = "$HOST_PLATFORM" ] && [ "$ARCH" = "$HOST_ARCH" ]; then
  VERSION=$("$PYTHON_BIN" --version 2>&1)
  echo "==> Verified: ${VERSION}"

  # Smoke-test the critical stdlib modules the import engine needs. If the
  # strip step accidentally removed one of these (it has happened — see the
  # case-insensitive lib/thread* bug), shipping the runtime would mean every
  # standalone import dies at startup with an opaque ModuleNotFoundError.
  # Fail the build instead.
  echo "==> Smoke-testing stdlib imports..."
  if ! "$PYTHON_BIN" -c "import threading, logging, json, csv, socket, ssl, urllib.request, xmlrpc.client, http.client, concurrent.futures, queue, dataclasses, typing, collections, io, re, os, sys, time" 2>&1; then
    echo "ERROR: bundled Python is missing a critical stdlib module — check the rm -rf strip patterns above." >&2
    exit 1
  fi
  echo "==> All critical stdlib modules importable."
else
  echo "==> Verified: found runtime binary at ${PYTHON_BIN} (execution skipped on ${HOST_PLATFORM}-${HOST_ARCH})"
fi

SIZE=$(du -sh "${DEST_DIR}" | cut -f1)
echo "==> Done. Runtime at ${DEST_DIR} (${SIZE})"
