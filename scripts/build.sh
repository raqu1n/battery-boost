#!/usr/bin/env bash
# Build script for the Battery Boost GNOME Shell extension.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${PROJECT_ROOT}/src"
DIST_DIR="${PROJECT_ROOT}/dist"
UUID="$(sed -n 's/^[[:space:]]*"uuid":[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/metadata.json")"
SCHEMA_ID="$(sed -n 's/^[[:space:]]*"settings-schema":[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/metadata.json")"

if [[ -z "${UUID}" ]]; then
    echo "Could not read the extension UUID from metadata.json" >&2
    exit 1
fi
if [[ -z "${SCHEMA_ID}" ||
    ! -f "${SRC_DIR}/schemas/${SCHEMA_ID}.gschema.xml" ]]; then
    echo "metadata.json does not reference a matching schema file" >&2
    exit 1
fi

echo "Validating GSettings schema..."
glib-compile-schemas --strict --dry-run "${SRC_DIR}/schemas"

mkdir -p "${DIST_DIR}"

echo "Packing ${UUID}..."
gnome-extensions pack \
    --force \
    --extra-source=schemas \
    --out-dir="${DIST_DIR}" \
    "${SRC_DIR}"

ZIP_PATH="${DIST_DIR}/${UUID}.shell-extension.zip"
if [[ ! -f "${ZIP_PATH}" ]]; then
    echo "Expected package was not created: ${ZIP_PATH}" >&2
    exit 1
fi

echo "Built: ${ZIP_PATH}"
