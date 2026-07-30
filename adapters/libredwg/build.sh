#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu

usage() {
  echo "usage: LIBREDWG_PREFIX=/path/to/prefix $0 OUTPUT" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
[ -n "${LIBREDWG_PREFIX:-}" ] || usage

output=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pkg_config=${PKG_CONFIG:-pkg-config}
cc=${CC:-cc}

[ ! -e "$output" ] || {
  echo "refusing to overwrite adapter output: $output" >&2
  exit 1
}

if [ -x "$LIBREDWG_PREFIX/bin/pkg-config" ]; then
  pkg_config="$LIBREDWG_PREFIX/bin/pkg-config"
fi

PKG_CONFIG_PATH="$LIBREDWG_PREFIX/lib/pkgconfig:$LIBREDWG_PREFIX/lib64/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export PKG_CONFIG_PATH

"$pkg_config" --atleast-version=0.13.4 libredwg
cflags=$("$pkg_config" --cflags libredwg)
libs=$("$pkg_config" --libs libredwg)

# pkg-config output is intentionally split into compiler arguments.
# shellcheck disable=SC2086
"$cc" -std=c11 -O3 -DNDEBUG -Wall -Wextra -Wpedantic \
  $cflags "$script_dir/libredwg_adapter.c" $libs -o "$output"
