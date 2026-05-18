plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    // Reverse-domain id aligned with the AppAuth redirect scheme
    // below + the iOS bundle id. The previous `com.example.ethiolink`
    // was the `flutter create` placeholder; renaming here lets the
    // Cognito hosted UI redirect back to a scheme the platform
    // associates with us alone.
    namespace = "com.ethiolink.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "com.ethiolink.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        //
        // `flutter_appauth ^12.0.0` requires Android 7.0 (API 24) at
        // minimum. `flutter.minSdkVersion` resolves to the Flutter
        // SDK's current floor (currently 21 on the stable channel),
        // so we override it here with `maxOf(flutter.minSdkVersion,
        // 24)` to keep the plugin's requirement satisfied without
        // dropping below Flutter's own floor if it ever lifts past
        // 24. Set explicitly rather than via a `local.properties`
        // override so CI / fresh checkouts pick the right value.
        minSdk = maxOf(flutter.minSdkVersion, 24)
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        // AppAuth (the `flutter_appauth` plugin) needs the OAuth
        // redirect scheme baked into the generated AndroidManifest
        // as the `intent-filter` data scheme. The plugin's manifest
        // references `${appAuthRedirectScheme}`, which has to be
        // supplied here. We use the reverse-domain id
        // `com.ethiolink.app` to match the
        // `COGNITO_REDIRECT_URI=com.ethiolink.app:/oauthredirect`
        // value in `mobile/env/dev.json` (and the matching prod /
        // staging files). The reverse-domain shape is the OAuth-for-
        // native-apps best practice (RFC 8252 §7.1) — it's claimed
        // by exactly one app on the device, so the Cognito redirect
        // routes to us without colliding with anything else. AppAuth
        // contributes its own `RedirectUriReceiverActivity` with the
        // correct launchMode / theme; do NOT redeclare that activity
        // in `AndroidManifest.xml` — overriding it dropped AppAuth's
        // stored-state plumbing and surfaced `AppAuth: No stored
        // state - unable to handle response`.
        manifestPlaceholders["appAuthRedirectScheme"] = "com.ethiolink.app"
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

flutter {
    source = "../.."
}
