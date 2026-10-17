plugins {
    id("com.android.application")
}

android {
    namespace = "jp.jphacks.sensorlink"
    compileSdk = 36
    defaultConfig {
        applicationId = "jp.jphacks.sensorlink"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        ndk { abiFilters += "arm64-v8a" } // keeps the OpenCV natives to one ABI
    }
    buildTypes {
        release { signingConfig = signingConfigs.getByName("debug") }
    }
}

dependencies {
    implementation("com.google.ar:core:1.50.0")
    implementation("org.opencv:opencv:4.10.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

