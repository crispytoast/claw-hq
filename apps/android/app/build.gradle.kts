plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.clawhq"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.clawhq"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.4.1"
    }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            isMinifyEnabled = false
            // Debug-signed release for v0.4 sideload — proper signing comes later.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }

    packaging {
        resources.excludes += "META-INF/{AL2.0,LGPL2.1}"
    }

    sourceSets {
        getByName("main") {
            kotlin.srcDirs("src/main/kotlin")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Firebase: programmatic init from /api/push/init, no google-services plugin.
    // BOM keeps versions aligned.
    implementation(platform("com.google.firebase:firebase-bom:33.5.1"))
    implementation("com.google.firebase:firebase-messaging-ktx")
    // Tasks-await bridge so we can co-routine the registration token fetch.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")
}
