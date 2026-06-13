#!/usr/bin/env bash
# Builds a debug-signed APK for sideload distribution via GitHub Releases.
# Output:  apps/android/app/build/outputs/apk/release/app-release.apk
# JDK 17 + Android SDK required (set ANDROID_HOME or local.properties).
set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${JAVA_HOME:-}" ]]; then
  # Pick up Frank's local JDK 17 if no JAVA_HOME is set.
  for d in /home/jesse/.local/tools/jdk-17* /opt/jdk-17* /usr/lib/jvm/temurin-17*; do
    if [[ -x "$d/bin/javac" ]]; then export JAVA_HOME="$d"; break; fi
  done
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "JDK 17 not found. Set JAVA_HOME to a JDK 17 install." >&2
  exit 1
fi
echo "Using JAVA_HOME=$JAVA_HOME"

./gradlew --no-daemon :app:assembleRelease

OUT="app/build/outputs/apk/release/app-release.apk"
if [[ -f "$OUT" ]]; then
  echo
  echo "APK: $(realpath "$OUT")"
  echo "Install on a phone connected via adb with:"
  echo "  adb install -r $(realpath "$OUT")"
fi
