#!/usr/bin/env bash
# Build script for the Battery Boost GNOME Shell extension.

set -euo pipefail

UUID="battery-health-toggle@batteryhealth-widget"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${PROJECT_ROOT}/src"
BUILD_DIR="${PROJECT_ROOT}/build/${UUID}"
DIST_DIR="${PROJECT_ROOT}/dist"
ZIP_NAME="${UUID}.shell-extension.zip"

echo "Building ${UUID}..."

# Clean previous build
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# Copy source files
cp -r "${SRC_DIR}"/* "${BUILD_DIR}/"

# Compile GSettings schema
if [ -f "${BUILD_DIR}/schemas/org.gnome.shell.extensions.battery-health-toggle.gschema.xml" ]; then
    echo "Compiling GSettings schema..."
    glib-compile-schemas "${BUILD_DIR}/schemas/"
fi

# Create distributable zip
mkdir -p "${DIST_DIR}"
rm -f "${DIST_DIR}/${ZIP_NAME}"

echo "Packing extension..."
gnome-extensions pack \
    --force \
    --extra-source=schemas \
    --extra-source=stylesheet.css \
    --out-dir="${DIST_DIR}" \
    "${BUILD_DIR}"

echo "Built: ${DIST_DIR}/${ZIP_NAME}"
