#!/usr/bin/env bash
# Builds ../../src/libraw.js + libraw.wasm from LibRaw with emscripten.
# Single-threaded on purpose (no SharedArrayBuffer / COOP+COEP needed): imagefast parallelizes across files
# with its worker pool. wasm SIMD + native wasm exceptions (LibRaw uses C++ exceptions for I/O errors).
# Needs emsdk >= 4.0 on PATH: https://emscripten.org/docs/getting_started/downloads.html
set -euo pipefail
cd "$(dirname "$0")"
LIBRAW_VERSION="${LIBRAW_VERSION:-0.22.1}"
SRC="LibRaw-$LIBRAW_VERSION"
command -v emcc >/dev/null || { echo "emcc not found - install emsdk and 'source emsdk_env.sh'" >&2; exit 1; }
[ -d "$SRC" ] || curl -sL "https://www.libraw.org/data/$SRC.tar.gz" | tar xz

# USE_JPEG: lossy DNG + Kodak; USE_ZLIB: deflate DNG. No LCMS (we only need sRGB previews), no DNG SDK (JXL DNG 1.7 unsupported).
FLAGS="-O3 -flto -msimd128 -fwasm-exceptions -DNDEBUG -DLIBRAW_NOTHREADS -DUSE_ZLIB -DUSE_JPEG -DUSE_JPEG8 -sUSE_ZLIB=1 -sUSE_LIBJPEG=1 -w"

pushd "$SRC" >/dev/null
OBJS=$(make -f Makefile.dist -pn lib/libraw.a 2>/dev/null | sed -n 's/^LIB_OBJECTS = //p')
mkdir -p object lib
emmake make -f Makefile.dist $OBJS CC=emcc CXX=em++ CFLAGS="$FLAGS -I." -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
emar rcs lib/libraw.a $OBJS
popd >/dev/null

em++ $FLAGS -I"$SRC" wrapper.cpp "$SRC/lib/libraw.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLibRaw -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=2MB \
  -sFILESYSTEM=0 -sEXPORTED_FUNCTIONS=_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString \
  -o ../../src/libraw.js
# imagefast/raw passes the wasm URL via locateFile, so drop the glue's own one: otherwise bundlers emit the 1 MB binary twice.
sed -i.bak 's|new URL("libraw.wasm",import.meta.url).href|"libraw.wasm"|' ../../src/libraw.js && rm -f ../../src/libraw.js.bak
ls -la ../../src/libraw.js ../../src/libraw.wasm
