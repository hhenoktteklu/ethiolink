#!/usr/bin/env bash
# EthioLink Mobile — post-`flutter create` iOS configurator.
#
# The iOS platform tree (`mobile/ios/`) is gitignored — operators
# regenerate it locally with `flutter create .` (same convention
# as the other native targets). This script layers the EthioLink-
# specific overrides on top of the freshly-generated files, the
# iOS analogue of the committed Android `appAuthRedirectScheme`
# override in `android/app/build.gradle.kts`.
#
# It is idempotent: safe to run after every `flutter create .` or
# `flutter clean` that touches the iOS scaffold. Re-running makes
# no further changes once the config is in place.
#
# What it sets:
#   1. PRODUCT_BUNDLE_IDENTIFIER = com.ethiolink.app   (Runner
#      target; RunnerTests keeps the `.RunnerTests` suffix). Must
#      match the reverse-domain Cognito redirect scheme + the
#      Android applicationId.
#   2. Info.plist CFBundleURLTypes entry registering the
#      `com.ethiolink.app` URL scheme so iOS routes the Cognito
#      redirect (`com.ethiolink.app:/oauthredirect`) + logout
#      (`com.ethiolink.app:/logout`) back into the app.
#   3. Podfile `platform :ios, '13.0'` floor — flutter_appauth
#      ^12.0.0 requires iOS 13 minimum. Bumps the line if a
#      generated Podfile set a lower value.
#
# What it does NOT do:
#   * Add any ASWebAuthenticationSession entitlement — none is
#     needed. flutter_appauth on iOS 13+ uses
#     ASWebAuthenticationSession via the AppAuth-iOS SDK with no
#     Info.plist privacy key or capability beyond the URL scheme
#     above.
#   * Touch signing / provisioning — that's developer-account
#     specific and stays in Xcode.
#
# Usage (run from the mobile/ directory after `flutter create .`):
#   bash scripts/configure_ios.sh
#
# Requires macOS tooling: /usr/libexec/PlistBuddy (ships with
# Xcode command-line tools) + perl + sed. No-ops with a clear
# error on non-macOS hosts that lack PlistBuddy.

set -euo pipefail

# Resolve the mobile dir from the script location so it works
# from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
IOS_DIR="${MOBILE_DIR}/ios"
PLIST="${IOS_DIR}/Runner/Info.plist"
PBXPROJ="${IOS_DIR}/Runner.xcodeproj/project.pbxproj"
PODFILE="${IOS_DIR}/Podfile"

BUNDLE_ID="com.ethiolink.app"
URL_SCHEME="com.ethiolink.app"
URL_NAME="app.ethiolink.callback"
MIN_IOS="13.0"

echo "==> EthioLink iOS configurator"
echo "    iOS dir : ${IOS_DIR}"

if [[ ! -d "${IOS_DIR}" ]]; then
    echo "Error: ${IOS_DIR} not found. Run 'flutter create .' from the" \
         "mobile/ directory first to generate the iOS scaffold." >&2
    exit 1
fi

PLISTBUDDY="/usr/libexec/PlistBuddy"
if [[ ! -x "${PLISTBUDDY}" ]]; then
    echo "Error: ${PLISTBUDDY} not found. This script requires macOS" \
         "with the Xcode command-line tools installed." >&2
    exit 127
fi

# ---------------------------------------------------------------------------
# 1. Bundle identifier.
# ---------------------------------------------------------------------------
#
# `flutter create` seeds PRODUCT_BUNDLE_IDENTIFIER from --org (or
# the com.example default). Rewrite every occurrence to
# com.ethiolink.app, preserving the `.RunnerTests` suffix on the
# test target so the two targets keep distinct bundle ids.

if [[ -f "${PBXPROJ}" ]]; then
    echo "==> Setting PRODUCT_BUNDLE_IDENTIFIER -> ${BUNDLE_ID}"
    perl -i -pe \
        's/(PRODUCT_BUNDLE_IDENTIFIER = )[^;]*?(\.RunnerTests)?;/"${1}'"${BUNDLE_ID}"'".(defined $2 ? $2 : "").";"/ge' \
        "${PBXPROJ}"
    # Report what we ended up with (deduplicated).
    grep -o 'PRODUCT_BUNDLE_IDENTIFIER = [^;]*;' "${PBXPROJ}" | sort -u | sed 's/^/    /'
else
    echo "Warning: ${PBXPROJ} not found — skipping bundle id. Re-run" \
         "'flutter create .' if the Xcode project is missing." >&2
fi

# ---------------------------------------------------------------------------
# 2. Info.plist CFBundleURLTypes.
# ---------------------------------------------------------------------------
#
# Idempotent: only insert the URL type when the scheme isn't
# already present anywhere in CFBundleURLTypes.

if [[ -f "${PLIST}" ]]; then
    echo "==> Ensuring CFBundleURLTypes registers ${URL_SCHEME}"
    # Create the CFBundleURLTypes array if missing.
    if ! "${PLISTBUDDY}" -c "Print :CFBundleURLTypes" "${PLIST}" >/dev/null 2>&1; then
        "${PLISTBUDDY}" -c "Add :CFBundleURLTypes array" "${PLIST}"
    fi
    # Insert our entry only if the scheme isn't already there.
    if "${PLISTBUDDY}" -c "Print :CFBundleURLTypes" "${PLIST}" 2>/dev/null \
        | grep -q "${URL_SCHEME}"; then
        echo "    scheme already present — no change"
    else
        "${PLISTBUDDY}" -c "Add :CFBundleURLTypes:0 dict" "${PLIST}"
        "${PLISTBUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLName string ${URL_NAME}" "${PLIST}"
        "${PLISTBUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "${PLIST}"
        "${PLISTBUDDY}" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${URL_SCHEME}" "${PLIST}"
        echo "    added CFBundleURLTypes entry for ${URL_SCHEME}"
    fi
else
    echo "Warning: ${PLIST} not found — skipping URL scheme. Re-run" \
         "'flutter create .' if Info.plist is missing." >&2
fi

# ---------------------------------------------------------------------------
# 3. Podfile iOS deployment-target floor.
# ---------------------------------------------------------------------------
#
# flutter_appauth ^12 requires iOS 13. Modern Flutter scaffolds
# already default to 13+, but older Podfiles set 11/12 — bump
# any lower value. We only rewrite a commented-or-active
# `platform :ios, '<x>'` line; if the Podfile leaves the
# platform line commented (Flutter's default), CocoaPods uses the
# Flutter min, which is >= 13 on the SDK line this project
# requires (Flutter 3.38.1+). We still uncomment + pin for an
# explicit floor.

if [[ -f "${PODFILE}" ]]; then
    echo "==> Pinning Podfile iOS platform floor -> ${MIN_IOS}"
    # Replace an active `platform :ios, 'x'` line.
    if grep -Eq "^\s*platform :ios" "${PODFILE}"; then
        perl -i -pe "s/^\s*platform :ios, '[^']*'/platform :ios, '${MIN_IOS}'/" "${PODFILE}"
    elif grep -Eq "^\s*#\s*platform :ios" "${PODFILE}"; then
        # Uncomment + pin the commented default line.
        perl -i -pe "s/^\s*#\s*platform :ios, '[^']*'/platform :ios, '${MIN_IOS}'/" "${PODFILE}"
    fi
    grep -E "platform :ios" "${PODFILE}" | head -1 | sed 's/^/    /'
else
    echo "Warning: ${PODFILE} not found — skipping platform floor." >&2
fi

echo "==> Done. Next:"
echo "    cd ${MOBILE_DIR}/ios && pod install && cd .."
echo "    flutter run -d \"iPhone 17\" --dart-define-from-file=env/dev.json"
