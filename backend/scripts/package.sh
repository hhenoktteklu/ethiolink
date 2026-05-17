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
#     package.json         — minimal `{name, version, type:module,
#                            dependencies}`. The `type:module` flag
#                            is what tells Node 20 to parse the
#                            ESM-emitted handlers as modules.
#     lambdas/
#       auth/sync.js
#       businesses/create.js
#       ...
#     shared/
#       config/...
#       domains/...
#       ...
#     db/
#       migrate.mjs        — used by the `maintenance-db-migrate`
#       migrations/0001_*.sql
#       ...                  Lambda at runtime.
#     node_modules/
#       @aws-sdk/...
#       pg/...
#       luxon/...
#       aws-jwt-verify/...
#
# What does NOT land in the zip:
#   dist/tests/            — test files compiled by tsc are
#                            stripped after compilation.
#   node_modules/<devDep>/ — `npm install --omit=dev` excludes them.
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
# node_modules in `backend/node_modules` untouched.
#
# Lockfile handling:
#   This repo uses npm workspaces, so the only `package-lock.json`
#   lives at the repo root and describes the hoisted dependency
#   graph for EVERY workspace (`backend`, `mobile`, `admin`). It is
#   NOT a 1:1 match for `backend/package.json` and therefore can't
#   drive `npm ci` against a freestanding `backend/dist/package.json`
#   — `npm ci` would error with "EUSAGE" because the lockfile
#   doesn't reference the same root-level package.
#
#   Instead we synthesize a minimal manifest with just the backend
#   runtime `dependencies` (plus `"type":"module"` for the ESM
#   runtime) and run `npm install --omit=dev --no-package-lock`.
#   The version ranges are inherited verbatim from
#   `backend/package.json`, which itself was resolved against the
#   root lockfile during development — drift between dev resolution
#   and prod resolution is bounded to the patch range
#   `^MAJOR.MINOR.PATCH` allows. For the MVP that trade-off is
#   acceptable; the next operator who needs full determinism should
#   either commit a backend-local lockfile or generate one in CI
#   before this step (`npm install --package-lock-only`).
#
# `package.json` (with `type: module`) MUST stay in the zip so the
# Lambda runtime (Node 20) parses the ESM-emitted handlers as
# modules. Without it, Node defaults to CJS and every cold-start
# `await loadSecretsThenConfig()` throws `SyntaxError`.

echo "==> Generating minimal dist/package.json"
# Read backend/package.json's `name`, `version`, and `dependencies`,
# add `type: module`, drop everything else (`scripts`,
# `devDependencies`, etc.) — `node -p` is already a prerequisite
# (the runtime), so no extra tool dependency.
node -e '
const pkg = require("./package.json");
const out = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: "module",
  dependencies: pkg.dependencies ?? {},
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
' > "${DIST_DIR}/package.json"

echo "==> Installing production node_modules into dist/"
(
    cd "${DIST_DIR}"
    npm install --omit=dev --no-package-lock --no-audit --no-fund --ignore-scripts
)

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
    # `package.json` (with `"type":"module"`) must be in the zip —
    # without it Node treats the bundle as CJS and the ESM-emitted
    # handlers fail to parse. `db/` carries the migration runner's
    # `.mjs` + `.sql` assets read at runtime by the
    # `maintenance-db-migrate` Lambda.
    zip -Xrq "${ZIP_PATH}" package.json lambdas shared node_modules db
)

# -----------------------------------------------------------------------------
# 5. Report.
# -----------------------------------------------------------------------------

ZIP_SIZE_BYTES="$(stat -c%s "${ZIP_PATH}" 2>/dev/null || stat -f%z "${ZIP_PATH}")"
ZIP_SIZE_MB="$(awk -v b="${ZIP_SIZE_BYTES}" 'BEGIN { printf "%.1f", b / 1048576 }')"

echo "==> Done"
echo "    ${ZIP_PATH}"
echo "    size: ${ZIP_SIZE_BYTES} bytes (${ZIP_SIZE_MB} MiB)"
