#!/usr/bin/env bash
# Build script for the Battery Boost GNOME Shell extension.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${PROJECT_ROOT}/src"
BUILD_DIR="${PROJECT_ROOT}/build"
DIST_DIR="${PROJECT_ROOT}/dist"
METADATA="$(node --input-type=module -e '
    import fs from "node:fs";

    const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof metadata.uuid !== "string" ||
        typeof metadata["settings-schema"] !== "string") {
        process.exit(1);
    }

    process.stdout.write(`${metadata.uuid}\t${metadata["settings-schema"]}`);
' "${SRC_DIR}/metadata.json")"
IFS=$'\t' read -r UUID SCHEMA_ID <<< "${METADATA}"
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

if [[ ! -f "${BUILD_DIR}/extension.js" ]]; then
    echo "Build did not produce extension.js" >&2
    exit 1
fi

mkdir -p "${BUILD_DIR}/schemas" "${DIST_DIR}"
cp "${SRC_DIR}/metadata.json" "${BUILD_DIR}/metadata.json"
cp "${SCHEMA_PATH}" "${BUILD_DIR}/schemas/"

rm -f "${DIST_DIR}/${UUID}.shell-extension.zip"

EXTRA_SOURCES=()
while IFS= read -r source_file; do
    EXTRA_SOURCES+=("--extra-source=${source_file}")
done < <(
    find "${BUILD_DIR}" -mindepth 1 -type d \
        -printf '%P\n' | sort
)
while IFS= read -r source_file; do
    EXTRA_SOURCES+=("--extra-source=${source_file}")
done < <(
    find "${BUILD_DIR}" -mindepth 1 -maxdepth 1 -type f \
        ! -name 'extension.js' ! -name 'metadata.json' \
        -printf '%f\n' | sort
)

echo "Packing ${UUID}..."
gnome-extensions pack \
    --force \
    "${EXTRA_SOURCES[@]}" \
    --out-dir="${DIST_DIR}" \
    "${BUILD_DIR}"

ZIP_PATH="${DIST_DIR}/${UUID}.shell-extension.zip"
if [[ ! -f "${ZIP_PATH}" ]]; then
    echo "Expected package was not created: ${ZIP_PATH}" >&2
    exit 1
fi

echo "Built: ${ZIP_PATH}"
