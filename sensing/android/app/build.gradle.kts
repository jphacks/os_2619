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
        ndk { abiFilters += "arm64-v8a" } // keeps the OpenCV/MediaPipe natives to one ABI
    }
    buildTypes {
        release { signingConfig = signingConfigs.getByName("debug") }
    }
    androidResources { noCompress += "task" }
}

dependencies {
    implementation("com.google.ar:core:1.50.0")
    implementation("com.google.mediapipe:tasks-vision:0.10.21")
    implementation("org.opencv:opencv:4.10.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

// MediaPipe models are fetched once into assets instead of being committed.
val models = mapOf(
    "hand_landmarker.task" to "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "pose_landmarker_lite.task" to "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
)
val fetchModels by tasks.registering {
    val dir = file("src/main/assets")
    outputs.dir(dir)
    doLast {
        dir.mkdirs()
        models.forEach { (name, url) ->
            val f = File(dir, name)
            if (!f.exists()) uri(url).toURL().openStream().use { s -> f.outputStream().use { s.copyTo(it) } }
        }
    }
}
tasks.named("preBuild") { dependsOn(fetchModels) }
