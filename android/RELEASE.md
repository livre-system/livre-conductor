# Livre Conductor release

The operational Android artifact is always the signed `release` APK. Debug builds are for development only.

Required release identity:

- applicationId: `com.livre.conductor`
- versionCode: `3`
- versionName: `2.0.0`

The release keystore is intentionally outside the repository. Local builds use these environment variables:

- `ANDROID_KEYSTORE_PATH`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

GitHub Actions uses the equivalent GitHub Actions secrets and reconstructs the keystore only in the runner's temporary directory. Never commit the keystore, passwords, APK signing secrets, or a release APK to this repository.

The workflow publishes the signed APK and its SHA-256 as a workflow artifact named `livre-conductor-v2.0.0-release`. A future updater can use the same immutable versioned artifact plus a signed/HTTPS update manifest; the first release deliberately does not add an in-app installer.

The native service keeps one foreground service for both location and background trip polling. JavaScript GPS is disabled inside the native shell, so the same location is not sent through both GPS paths.
