#!/usr/bin/env bash
#
# Compila la TWA de PetSeñal, la firma y copia el APK a frontend/descargar/.
#
# Requisitos (ya instalados en PocketDev): JDK 17, Gradle 8.14.3, Android SDK 36
# y build-tools 35.0.0 con aapt2 ARM64.
#
# Uso:
#     cd android
#     bash build.sh
#
set -euo pipefail

cd "$(dirname "$0")"

KEYSTORE="${PETSENAL_KEYSTORE:-petsenal-release.keystore}"
KEYSTORE_PROPS="${PETSENAL_KEYSTORE_PROPS:-keystore.properties}"
BUILD_TOOLS="${BUILD_TOOLS:-${ANDROID_HOME:-/root/android-sdk}/build-tools/35.0.0}"
OUT_DIR="app/build/outputs/apk/release"
UNSIGNED="$OUT_DIR/app-release-unsigned.apk"
ALIGNED="$OUT_DIR/petsenal-release-aligned.apk"
SIGNED="$OUT_DIR/petsenal-release.apk"
DESTINO="../frontend/descargar/petsenal.apk"

if [ ! -f "$KEYSTORE" ]; then
  echo "ERROR: no encontré el keystore '$KEYSTORE'." >&2
  echo "Sin él no se puede firmar. Lee signing-key-info.txt." >&2
  exit 1
fi

if [ ! -f "$KEYSTORE_PROPS" ]; then
  echo "ERROR: no encontré '$KEYSTORE_PROPS' (contraseñas del keystore)." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$KEYSTORE_PROPS"
set +a

echo "==> Compilando APK sin firmar..."
gradle assembleRelease --console=plain --no-daemon

echo "==> Alineando..."
"$BUILD_TOOLS/zipalign" -p -f 4 "$UNSIGNED" "$ALIGNED"

echo "==> Firmando con $KEYSTORE (alias $alias)..."
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$alias" \
  --ks-pass "pass:$storePassword" \
  --key-pass "pass:$keyPassword" \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --out "$SIGNED" \
  "$ALIGNED"

echo "==> Verificando firma..."
"$BUILD_TOOLS/apksigner" verify --print-certs "$SIGNED"

mkdir -p "$(dirname "$DESTINO")"
cp "$SIGNED" "$DESTINO"

echo "==> Listo: $DESTINO"
"$BUILD_TOOLS/aapt2" dump badging "$DESTINO" | grep -E "^package|launchable-activity|application-label:"
