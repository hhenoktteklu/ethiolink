// EthioLink — legacy MainActivity stub.
//
// The Android package id was renamed to `com.ethiolink.app` to
// align the OAuth redirect scheme with current best practice
// (reverse-domain custom scheme — `com.ethiolink.app:/oauthredirect`).
// The real `MainActivity` lives at
// `mobile/android/app/src/main/kotlin/com/ethiolink/app/MainActivity.kt`.
//
// This file is left behind only because the sandbox that performed
// the rename could not unlink the original. It declares no symbols,
// so the Kotlin compiler emits no class and Gradle's source set
// keeps the `com.ethiolink.app.MainActivity` referenced by the
// manifest as the sole entrypoint. Operators with a regular file
// system are free to `git rm` this file.

package com.example.ethiolink
