#!/usr/bin/env bash
# EthioLink — backend Lambda deployment-package builder.
#
# Produces a single zip at `backend/dist/lambda.zip` containing
# every compiled Lambda handler, the shared modules they import,
# and the production-only node_modules tree. The Terraform Lambda
# module references this exact path via `var.package_zip_path`;
# re-running this script after a code change updates the zip and
# `terraform apply` rolls each function to the new
# `source_code_hash`.
#
# Why one big zip:
#   The 49 handlers share ~95% of their dependency tree. A
#   per-handler zip would duplicate it 49 times; the smaller
#   surface area for the deploy pipeline (one upload, one hash,
#   one cache-invalidation cycle) is the lever that matters during
#   MVP. The first per-function cold-start budget violation is the
#   trigger to split — at that point each handler gets its own
#   esbuild-bundled zip and this script grows a `--handler=NAME`
#   flag.
#
# What lands in the zip:
#   dist/
#     lambdas/
#       auth/sync.js
#       businesses/create.js
#       ...
#     shared/
#       config/...
#       domains/...
#       ...
#     node_modules/
#       @aws-sdk/...
#       pg/...
#       luxon/...
#       aws-jwt-verify/...
#
# What does NOT land in the zip:
#   dist/tests/            — test files compiled by tsc are
#                            stripped after compilation.
#   node_modules/<devDep>/ — `npm ci --omit=dev` excludes them.
#   package.json           — not needed at runtime (the JS files
#                            don't import it).
#
# Invocation:
#   cd backend && ./scripts/package.sh
#   # or, from the repo root:
#   bash backend/scripts/package.sh
#
# Required tools on PATH: node, npm, npx (for tsc), zip.

set -euo pipefail

# Resolve repo-root + backend-dir from the script location so the
# script works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${BACKEND_DIR}/dist"
ZIP_PATH="${DIST_DIR}/lambda.zip"

echo "==> Backend package builder"
echo "    Backend dir : ${BACKEND_DIR}"
echo "    Dist dir    : ${DIST_DIR}"
echo "    Zip target  : ${ZIP_PATH}"

cd "${BACKEND_DIR}"

# -----------------------------------------------------------------------------
# 1. Clean previous build output.
# -----------------------------------------------------------------------------

if [[ -d "${DIST_DIR}" ]]; then
    echo "==> Removing previous dist/"
    rm -rf "${DIST_DIR}"
fi

# -----------------------------------------------------------------------------
# 2. Compile TypeScript -> dist/.
# -----------------------------------------------------------------------------

echo "==> Compiling TypeScript"
npx tsc --project tsconfig.json

# Drop the test tree — the tsconfig `include` pulls it in, but
# tests have no place in a production zip.
if [[ -d "${DIST_DIR}/tests" ]]; then
    echo "==> Pruning compiled tests from dist/"
    rm -rf "${DIST_DIR}/tests"
fi

# -----------------------------------------------------------------------------
# 3. Install production-only node_modules into dist/.
# -----------------------------------------------------------------------------
#
# A fresh, minimal install inside dist/ keeps the zip free of
# devDependencies (tsx, @types/*) and leaves the development-side
# node_modules in `backend/node_modules` untouched. Using `npm ci`
# guarantees the exact versions from `package-lock.json`.

echo "==> Installing production node_modules into dist/"
cp package.json package-lock.json "${DIST_DIR}/"
(
    cd "${DIST_DIR}"
    npm ci --omit=dev --no-audit --no-fund --ignore-scripts
)

# The original package.json + lockfile pulled in dev metadata we
# don't want bloating the zip. Strip them, then write back a
# minimal `{"type":"module"}` manifest so the Lambda runtime
# (Node 20) treats the compiled handlers as ES modules — top-
# level `await` in the source TypeScript compiles to top-level
# `await` in the emitted .js, which Node ONLY accepts under an
# ESM manifest. Without this file the runtime falls back to CJS
# and every cold-start `await loadSecretsThenConfig()` would
# throw `SyntaxError: Unexpected reserved word`.
rm -f "${DIST_DIR}/package.json" "${DIST_DIR}/package-lock.json"
printf '{"type":"module"}\n' > "${DIST_DIR}/package.json"

# -----------------------------------------------------------------------------
# 3b. Copy db/ into dist/ for the migration Lambda.
# -----------------------------------------------------------------------------
#
# The `maintenance-db-migrate` Lambda imports
# `backend/db/migrate.mjs` (the same runner the local `npm run
# db:migrate` CLI uses). tsc does not process `.mjs` files, so we
# copy them in verbatim. The migration `.sql` files are read by
# the runner at runtime; they also need to be in the bundle.

echo "==> Copying db/ into dist/ for the migration Lambda"
cp -r db "${DIST_DIR}/"

# -----------------------------------------------------------------------------
# 4. Zip dist/ in place.
# -----------------------------------------------------------------------------

echo "==> Building zip"
(
    cd "${DIST_DIR}"
    # `-X` strips extra file attributes (timestamps, UIDs) so the
    # zip's content hash is stable across machines that build the
    # same source tree. `-r` recurses; `-q` is quiet.
    #
    # `package.json` (the minimal `{"type":"module"}` manifest
    # written above) must be in the zip — without it Node treats
    # the bundle as CJS and the ESM-emitted handlers fail to
    # parse.
    zip -Xrq "${ZIP_PATH}" package.json lambdas shared node_modules
)

# -----------------------------------------------------------------------------
# 5. Report.
# -----------------------------------------------------------------------------

ZIP_SIZE_BYTES="$(stat -c%s "${ZIP_PATH}" 2>/dev/null || stat -f%z "${ZIP_PATH}")"
ZIP_SIZE_MB="$(awk -v b="${ZIP_SIZE_BYTES}" 'BEGIN { printf "%.1f", b / 1048576 }')"

echo "==> Done"
echo "    ${ZIP_PATH}"
echo "    size: ${ZIP_SIZE_BYTES} bytes (${ZIP_SIZE_MB} MiB)"
