#!/usr/bin/env bash
# build_apk.sh [--debug] [--install]: Kagetsu Tohya as one Android APK, with everything the site publishes inside it
# (index.html, css/, js/, data/: the same files as the desktop program). Writes android/out/Kagetsu-Tohya-android.apk.
#   --debug    the page can be inspected from chrome://inspect on the computer (USB debugging)
#   --install  installs it on the connected phone or emulator (adb install -r keeps the saves)
# Needs the Android SDK (ANDROID_HOME, default ~/Library/Android/sdk) with platform android-36 and build-tools 35+,
# and a JDK. No Gradle. The version is the desktop program's (desktop/package.json).
#
# The signing key is made once, in android/keystore (not in the repository). Keep a copy of it: an APK signed with
# another key cannot update the installed app (Android would have to remove it, and the saves with it).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
web="$(cd "$here/.." && pwd)"
debug=0; install=0
for a in "$@"; do
    case "$a" in
        --debug) debug=1 ;;
        --install) install=1 ;;
        *) echo "unknown argument: $a" >&2; exit 2 ;;
    esac
done

[ -f "$web/data/manifest.json" ] || { echo "no game data in $web/data: run tools/extract.py first (README)" >&2; exit 1; }

sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
bt="$sdk/build-tools/$(ls "$sdk/build-tools" | sort -V | tail -1)"
jar="$sdk/platforms/android-36/android.jar"
[ -f "$jar" ] || { echo "no $jar (sdkmanager 'platforms;android-36')" >&2; exit 1; }
out="$here/out"
work="$out/work"
apk="$out/Kagetsu-Tohya-android.apk"
rm -rf "$work"; mkdir -p "$work/classes" "$work/stage/assets/www"

# The signing key, made once.
ks="$here/keystore/kagetsu.jks"
if [ ! -f "$ks" ]; then
    mkdir -p "$here/keystore"
    keytool -genkeypair -keystore "$ks" -storepass kagetsu -keypass kagetsu -alias kagetsu -keyalg RSA \
        -keysize 3072 -validity 36500 -dname "CN=Kagetsu Tohya browser port" >/dev/null
    echo "made the signing key: $ks (keep a copy of it)"
fi

# The version: the desktop program's, 1.0.8 -> version code 10008 (each part below 100).
name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$web/desktop/package.json")
IFS=. read -r major minor patch <<< "$name"
code=$(( major * 10000 + minor * 100 + patch ))

# Resources, manifest -> base.apk
"$bt/aapt2" compile --dir "$here/res" -o "$work/res.zip"
link=("$bt/aapt2" link -o "$work/base.apk" -I "$jar" --manifest "$here/AndroidManifest.xml" "$work/res.zip"
      --min-sdk-version 26 --target-sdk-version 36 --version-code "$code" --version-name "$name")
[ "$debug" = 1 ] && link+=(--debug-mode)
"${link[@]}"

# Java -> classes.dex
# (the folder's name has a space in it: the file lists are arrays)
sources=(); while IFS= read -r -d '' f; do sources+=("$f"); done < <(find "$here/src" -name '*.java' -print0)
javac -nowarn --release 11 -cp "$jar" -d "$work/classes" "${sources[@]}" 2>&1 | grep -v 'warning: \[options\]' || true
classes=(); while IFS= read -r -d '' f; do classes+=("$f"); done < <(find "$work/classes" -name '*.class' -print0)
[ "${#classes[@]}" -gt 0 ] || { echo "javac failed" >&2; exit 1; }
"$bt/d8" --release --min-api 26 --lib "$jar" --output "$work" "${classes[@]}"

# The game: assets/www holds what the site publishes, as desktop/package.json's extraResources has it. Linked, not
# copied (zip follows the links), and stored, not compressed, so the app can read any file from any byte (the music
# player seeks; the pictures and sound are compressed already).
for f in index.html css js data; do ln -s "$web/$f" "$work/stage/assets/www/$f"; done
cp "$work/base.apk" "$work/unsigned.apk"
(cd "$work" && zip -q -X "unsigned.apk" classes.dex)
(cd "$work/stage" && zip -q -X -0 -r "../unsigned.apk" assets -x '*.DS_Store' -x '*/.*')

"$bt/zipalign" -f -p 4 "$work/unsigned.apk" "$work/aligned.apk"
"$bt/apksigner" sign --v1-signing-enabled false --ks "$ks" --ks-pass pass:kagetsu --ks-key-alias kagetsu --key-pass pass:kagetsu \
    --out "$apk" "$work/aligned.apk"
rm -rf "$work"
echo "$name ($code): $(ls -lh "$apk" | awk '{print $5}')  $apk"

if [ "$install" = 1 ]; then
    "$sdk/platform-tools/adb" install -r "$apk"
fi
