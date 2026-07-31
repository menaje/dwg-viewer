#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu
umask 077

DOTNET_VERSION=9.0.316
ACADSHARP_VERSION=3.6.51

usage() {
  echo "usage: $0 NEW_BUILD_DIRECTORY NEW_ADAPTER_PATH" >&2
  exit 2
}

fail() {
  echo "$1" >&2
  exit 1
}

checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 512 "$1" | awk '{print $1}'
  elif command -v sha512sum >/dev/null 2>&1; then
    sha512sum "$1" | awk '{print $1}'
  else
    fail "a SHA-512 tool (shasum or sha512sum) is required"
  fi
}

verified_download() {
  url=$1
  destination=$2
  expected=$3
  curl --fail --location --silent --show-error "$url" --output "$destination"
  actual=$(checksum "$destination")
  [ "$actual" = "$expected" ] || fail "checksum mismatch for downloaded .NET SDK"
}

shell_quote() {
  escaped=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "$escaped"
}

[ "$#" -eq 2 ] || usage

build_root=$1
adapter_output=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
adapter_parent=$(dirname -- "$adapter_output")

[ ! -e "$build_root" ] || fail "build directory already exists"
[ ! -e "$adapter_output" ] || fail "adapter output already exists"
[ -d "$adapter_parent" ] || fail "adapter output parent does not exist"

for required_tool in curl tar awk sed; do
  command -v "$required_tool" >/dev/null 2>&1 \
    || fail "required build tool is missing: $required_tool"
done

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    sdk_rid=osx-arm64
    sdk_sha512=bc4645bca4d263a1fd08848a1178c2c878a57b394c540b5e97dae3a443f5dec8893d09cc194b0d0adac7e9b9d7b18341a7651411999ce12ef9083ca9936c16f3
    ;;
  Darwin-x86_64)
    sdk_rid=osx-x64
    sdk_sha512=c46c685163856f5bb728c5d58e5788f354cb06e2094d893903292ed985d11586ff51e8b97c38169b9bb82301c32a43249546e23ce9ed4259d1802ba898933c72
    ;;
  Linux-aarch64)
    sdk_rid=linux-arm64
    sdk_sha512=408324fd4ee828cafa17926e33c12cc48460699b58a8322c8a1891ef81eddec0c72df12fa7afa86f5e22fa26bc3750c0fb60481bd167e4b808d5cfb951df0638
    ;;
  Linux-x86_64)
    sdk_rid=linux-x64
    sdk_sha512=5a8558afd648c14a835e00ae08fa556083f50e3ada164d3e73293fcd4850b0519a27c11f2dae95a9bbe4af432be33bf14451ef11ba69527e34f9cf3077a1c2b5
    ;;
  *)
    fail "supported platforms are macOS/Linux on arm64 or x86_64"
    ;;
esac

mkdir -m 700 "$build_root"
runtime_root="$build_root/dotnet"
cli_home="$build_root/cli-home"
nuget_packages="$build_root/nuget-packages"
publish_root="$build_root/publish"
archive="$build_root/dotnet-sdk.tar.gz"

mkdir -m 700 "$runtime_root" "$cli_home" "$nuget_packages" "$publish_root"

echo "Preparing checksum-pinned .NET SDK $DOTNET_VERSION ($sdk_rid)"
verified_download \
  "https://builds.dotnet.microsoft.com/dotnet/Sdk/$DOTNET_VERSION/dotnet-sdk-$DOTNET_VERSION-$sdk_rid.tar.gz" \
  "$archive" \
  "$sdk_sha512"
tar -xzf "$archive" -C "$runtime_root"
rm "$archive"

echo "Restoring locked ACadSharp $ACADSHARP_VERSION dependency"
DOTNET_ROOT="$runtime_root" \
DOTNET_CLI_HOME="$cli_home" \
DOTNET_CLI_TELEMETRY_OPTOUT=1 \
DOTNET_NOLOGO=1 \
NUGET_PACKAGES="$nuget_packages" \
  "$runtime_root/dotnet" restore "$script_dir/ACadSharpAdapter.csproj" \
    --locked-mode

echo "Publishing process-isolated ACadSharp inspection adapter"
DOTNET_ROOT="$runtime_root" \
DOTNET_CLI_HOME="$cli_home" \
DOTNET_CLI_TELEMETRY_OPTOUT=1 \
DOTNET_NOLOGO=1 \
NUGET_PACKAGES="$nuget_packages" \
  "$runtime_root/dotnet" publish "$script_dir/ACadSharpAdapter.csproj" \
    --configuration Release \
    --no-restore \
    --output "$publish_root"

runtime_quoted=$(shell_quote "$runtime_root")
dotnet_quoted=$(shell_quote "$runtime_root/dotnet")
dll_quoted=$(shell_quote "$publish_root/ACadSharpAdapter.dll")
{
  printf '#!/bin/sh\n'
  printf 'export DOTNET_ROOT=%s\n' "$runtime_quoted"
  printf 'export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1\n'
  printf 'exec %s %s "$@"\n' "$dotnet_quoted" "$dll_quoted"
} >"$adapter_output"
chmod 700 "$adapter_output"

printf 'ACadSharp %s adapter: %s\n' "$ACADSHARP_VERSION" "$adapter_output"
