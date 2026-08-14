#!/usr/bin/env bash
# Build script for the Battery Boost GNOME Shell extension.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${PROJECT_ROOT}/src"
BUILD_DIR="${PROJECT_ROOT}/build"
DIST_DIR="${PROJECT_ROOT}/dist"
UUID="$(sed -n 's/^[[:space:]]*"uuid":[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/metadata.json")"
SCHEMA_ID="$(sed -n 's/^[[:space:]]*"settings-schema":[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/metadata.json")"
SCHEMA_PATH="${SRC_DIR}/schemas/${SCHEMA_ID}.gschema.xml"

if [[ -z "${UUID}" ]]; then
    echo "Could not read the extension UUID from metadata.json" >&2
    exit 1
fi
if [[ -z "${SCHEMA_ID}" || ! -f "${SCHEMA_PATH}" ]]; then
    echo "metadata.json does not reference a matching schema file" >&2
    exit 1
fi

echo "Validating GSettings schema..."
glib-compile-schemas --strict --dry-run "${SRC_DIR}/schemas"

echo "Compiling TypeScript..."
rm -rf "${BUILD_DIR}"
npm --prefix "${PROJECT_ROOT}" run build

RUNTIME_FILES=(
    "extension.js"
    "ui/batteryIndicator.js"
    "upower/batteryService.js"
    "upower/proxies.js"
)
for runtime_file in "${RUNTIME_FILES[@]}"; do
    if [[ ! -f "${BUILD_DIR}/${runtime_file}" ]]; then
        echo "TypeScript did not produce build/${runtime_file}" >&2
        exit 1
    fi
done

mkdir -p "${BUILD_DIR}/schemas" "${DIST_DIR}"
cp "${SRC_DIR}/metadata.json" "${BUILD_DIR}/metadata.json"
cp "${SCHEMA_PATH}" "${BUILD_DIR}/schemas/"

echo "Packing ${UUID}..."
gnome-extensions pack \
    --force \
    --extra-source=schemas \
    --extra-source=ui \
    --extra-source=upower \
    --out-dir="${DIST_DIR}" \
    "${BUILD_DIR}"

ZIP_PATH="${DIST_DIR}/${UUID}.shell-extension.zip"
if [[ ! -f "${ZIP_PATH}" ]]; then
    echo "Expected package was not created: ${ZIP_PATH}" >&2
    exit 1
fi

echo "Built: ${ZIP_PATH}"
