import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def text(path):
    return (ROOT / path).read_text(encoding="utf-8")


def main():
    build = text("android/app/build.gradle")
    manifest = text("android/app/src/main/AndroidManifest.xml")
    workflow = text(".github/workflows/android-apk.yml")
    service = text("android/app/src/main/java/com/livre/conductor/LocationService.java")
    notification_store = text("android/app/src/main/java/com/livre/conductor/TripNotificationStore.java")
    activity = text("android/app/src/main/java/com/livre/conductor/MainActivity.java")
    js = text("js/app.js")

    assert "applicationId 'com.livre.conductor'" in build
    assert "versionCode 3" in build and "versionName '2.0.0'" in build
    assert "signingConfig signingConfigs.release" in build
    assert 'android.permission.POST_NOTIFICATIONS' in manifest
    assert 'android.permission.ACCESS_BACKGROUND_LOCATION' in manifest
    assert 'android.permission.FOREGROUND_SERVICE_LOCATION' in manifest
    assert 'android:foregroundServiceType="location"' in manifest
    assert 'trip_horn' in service
    assert 'notified_trip_ids' in notification_store
    assert 'trip_id' in service and 'trip_id' in activity
    assert 'setAppVisible' in activity and 'clearSession' in activity
    assert 'ANDROID_KEYSTORE_BASE64' in workflow
    assert 'assembleRelease' in workflow and 'apksigner' in workflow
    assert 'sha256sum' in workflow
    assert 'const NATIVE_SHELL' in js
    assert 'window.AndroidGps.clearSession' in js
    assert 'window.AndroidGps.setAppVisible' in js
    raw = ROOT / 'android/app/src/main/res/raw/trip_horn.wav'
    assert raw.exists() and raw.stat().st_size > 1000

    if len(sys.argv) == 1:
        print("verified source; APK not checked")
        return
    apk = pathlib.Path(sys.argv[1]).resolve()
    assert apk.is_file() and apk.stat().st_size > 100_000
    print(f"verified source and APK exists: {apk}")


if __name__ == '__main__':
    main()
