plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.example.ethiolink"
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
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.example.ethiolink"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        // AppAuth (the `flutter_appauth` plugin) needs the OAuth
        // redirect scheme baked into the generated AndroidManifest
        // as the `intent-filter` data scheme. The plugin's manifest
        // references `${appAuthRedirectScheme}`, which has to be
        // supplied here. We use `ethiolink` to match the
        // `COGNITO_REDIRECT_URI=ethiolink://auth/callback` value
        // in `mobile/env/dev.json` (and the matching prod / staging
        // files). Single value for now — when prod splits to a
        // different scheme we can promote this to a flavor.
        manifestPlaceholders["appAuthRedirectScheme"] = "ethiolink"
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
