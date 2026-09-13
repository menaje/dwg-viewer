#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Anonymous, read-only observation of existing public delivery; never publishes.

Requires Python 3.9+. Writes only to a newly created output directory. Downloads
are inspected in memory, never extracted or executed. A receipt is an observation,
not consumer admission, installation qualification or migration authorization.
"""
import argparse
import base64
import hashlib
import io
import json
import re
import platform
import subprocess
import tarfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY = "menaje/2d-cad-viewer"
# Public historical locator retained in already shipped VSIX/package manifests.
DELIVERY_REPOSITORIES = {REPOSITORY, "menaje/dwg-viewer"}
ROOT = Path(__file__).resolve().parent.parent
HOSTS = {"github.com", "api.github.com", "raw.githubusercontent.com",
         "release-assets.githubusercontent.com", "codeload.github.com"}
LIMIT = 256 * 1024 * 1024
TARGETS = {"linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def safe_url(url):
    value = urllib.parse.urlsplit(url)
    require(value.scheme == "https" and value.hostname in HOSTS and
            not value.username and not value.password and value.port in (None, 443),
            "unsupported anonymous delivery URL")


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        safe_url(url)
        return super().redirect_request(request, response, code, message, headers, url)


def download(url):
    safe_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": "viewer-continuity-check"})
    with urllib.request.build_opener(Redirects).open(request, timeout=60) as response:
        data = response.read(LIMIT + 1)
        require(len(data) <= LIMIT, "download exceeds inspection limit")
        return data


def identity(data):
    return {"bytes": len(data), "sha256": sha256(data)}


def verify_identity(data, expected):
    require(len(data) == expected["bytes"] and sha256(data) == expected["sha256"],
            "exact artifact size/SHA-256 mismatch")


def checksum_entries(data):
    entries = {}
    for line in data.decode().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64}) [ *](.+)", line)
        require(match is not None, "invalid checksum entry")
        digest, name = match.groups()
        safe_name(name)
        require(name not in entries, "duplicate checksum entry")
        entries[name] = digest
    require(entries, "empty checksums")
    return entries


def safe_name(name):
    require(name and not name.startswith("/") and "\\" not in name and
            all(part not in ("", ".", "..") for part in name.split("/")),
            "unsafe archive/asset path")


def tar_files(data):
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            safe_name(member.name.rstrip("/"))
            if member.isdir():
                continue
            require(member.isfile() and member.name not in files,
                    "archive links or duplicate files forbidden")
            total += member.size
            require(total <= LIMIT, "expanded archive exceeds inspection limit")
            files[member.name] = archive.extractfile(member).read()
    return files


def package_content_sha256(files):
    digest = hashlib.sha256()
    require(files and all(name.startswith("package/") for name in files), "package root required")
    for name, data in sorted(files.items()):
        digest.update(name.removeprefix("package/").encode() + b"\0")
        digest.update(str(len(data)).encode() + b"\0" + data + b"\0")
    return digest.hexdigest()


def gzip_os_explanation(data, expected_sha256):
    """Compare a copy only; never normalize an artifact or excuse a raw mismatch."""
    if len(data) < 10 or data[:3] != b"\x1f\x8b\x08":
        return None
    copy = bytearray(data)
    for value in range(256):
        if value == data[9]:
            continue
        copy[9] = value
        if sha256(copy) == expected_sha256:
            return {"offset": 9, "observedByte": data[9], "expectedHashRecreatedWithByte": value,
                    "rawMismatchRemains": True}
    return None


def source_archive(data, converter, version, target):
    files = tar_files(data)
    prefix = f"dwg-viewer-libredwg-0.14-{target}/"
    require(all(name.startswith(prefix) for name in files), "unexpected GPL archive root")
    files = {name.removeprefix(prefix): value for name, value in files.items()}
    manifest = json.loads(files["manifest.json"])
    require(manifest["package_version"] == version and
            manifest["binary_license"] == "GPL-3.0-or-later" and
            manifest["corresponding_source"] == "included", "source manifest identity mismatch")
    checksums = checksum_entries(files["SHA256SUMS"])
    require(set(checksums) == set(files) - {"SHA256SUMS"}, "source checksum coverage mismatch")
    for name, expected in checksums.items():
        require(sha256(files[name]) == expected, "source internal checksum mismatch")
    records = manifest["files"]
    require(len({item["path"] for item in records}) == len(records) and
            {item["path"] for item in records} == set(files) - {"SHA256SUMS", "manifest.json"},
            "source manifest coverage mismatch")
    for item in records:
        verify_identity(files[item["path"]], {"bytes": item["size_bytes"], "sha256": item["sha256"]})
    executable = "bin/libredwg-adapter" + (".exe" if target == "win32-x64" else "")
    require(files[executable] == converter, "corresponding source archive contains different binary")
    # Use the existing reviewed packager's pins; no second license/source authority.
    packager = (ROOT / "adapters/libredwg/package.mjs").read_text()
    for name, constant in [("source/libredwg-0.14.tar.xz", "LIBREDWG_SOURCE_SHA256"),
                           ("LICENSES/GPL-3.0-or-later.txt", "GPL_3_0_SHA256"),
                           ("LICENSES/MPL-2.0.txt", "MPL_2_0_SHA256")]:
        expected = re.search(r"export const " + constant + r'\s*=\s*"([a-f0-9]{64})"', packager)[1]
        require(sha256(files[name]) == expected, "reviewed source/license pin mismatch")
    for name in ("libredwg_adapter.c", "build.sh", "package.mjs"):
        require("source/dwg-viewer/adapters/libredwg/" + name in files, "adapter source/build input missing")
    return {"result": "PASS", "checkedFiles": len(files), "binaryMatches": True}


def observe_release(tag, output):
    def tag_refs():
        lines = subprocess.check_output(["git", "ls-remote", f"https://github.com/{REPOSITORY}.git",
                                         f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"],
                                        timeout=60, text=True).splitlines()
        refs = dict(line.split()[::-1] for line in lines)
        require(f"refs/tags/{tag}" in refs, "public tag reference missing")
        return refs
    refs = tag_refs()
    base = f"https://github.com/{REPOSITORY}/releases/download/{tag}/"
    metadata = json.loads(download(f"https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}"))
    require(metadata["tag_name"] == tag and not metadata["draft"], "release identity mismatch")
    directory = output / tag
    directory.mkdir()
    assets = {}
    observations = []
    for asset in metadata["assets"]:
        name = asset["name"]
        safe_name(name)
        require("/" not in name and name not in assets and asset["browser_download_url"] == base + name,
                "unexpected release asset locator")
        data = download(base + name)
        require(asset.get("digest", "").startswith("sha256:"), "release API digest unavailable")
        verify_identity(data, {"bytes": asset["size"], "sha256": asset["digest"][7:]})
        (directory / name).write_bytes(data)
        assets[name] = data
        observations.append({"url": base + name, **identity(data)})
    sums = checksum_entries(assets["SHA256SUMS"])
    require(set(sums) == set(assets) - {"SHA256SUMS"}, "release checksum coverage mismatch")
    for name, expected in sums.items():
        require(sha256(assets[name]) == expected, "release checksum mismatch")
    result = {"tag": tag, "releaseId": metadata["id"], "immutableObserved": metadata.get("immutable"),
              "tagReferences": refs, "anonymousAssets": observations, "result": "PASS"}
    if re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        version = tag[1:]
        vsix = assets[f"dwg-viewer-vscode-{version}.vsix"]
        with zipfile.ZipFile(io.BytesIO(vsix)) as archive:
            names = archive.namelist()
            require(len(names) == len(set(names)) and sum(x.file_size for x in archive.infolist()) <= LIMIT,
                    "VSIX duplicate entries or expansion limit")
            require(not any("/native/" in n or n.endswith((".exe", ".node", ".dll", ".dylib", ".so"))
                            for n in names), "unexpected native payload in MPL VSIX")
            manifest = json.loads(archive.read("extension/package.json"))
            require(manifest["version"] == version and manifest["publisher"] == "menaje" and
                    manifest["name"] == "dwg-viewer-vscode" and manifest["license"] == "MPL-2.0" and
                    not manifest.get("extensionDependencies"), "VSIX identity/dependency mismatch")
            catalog = json.loads(archive.read("extension/dist/engine-assets.json"))
            require(catalog["repository"] in DELIVERY_REPOSITORIES and catalog["releaseTag"] == tag and
                    catalog["viewerVersion"] == version and set(catalog["targets"]) == TARGETS,
                    "embedded catalog identity mismatch")
            readme = archive.read(next(n for n in names if n.lower() == "extension/readme.md")).decode()
            require(f"https://github.com/{catalog['repository']}" in readme, "packaged source link missing")
        result["embeddedRepository"] = catalog["repository"]
        result["embeddedCacheSchema"] = catalog["engine"]["cacheSchema"]
        result["installedClientUrls"] = []
        result["platformSources"] = {}
        for target, item in catalog["targets"].items():
            converter = assets[item["asset"]]
            source = assets[item["sourceAsset"]]
            verify_identity(converter, {"bytes": item["size"], "sha256": item["sha256"]})
            verify_identity(source, {"bytes": item["sourceSize"], "sha256": item["sourceSha256"]})
            for name in (item["asset"], item["sourceAsset"]):
                installed_url = f"https://github.com/{catalog['repository']}/releases/download/{tag}/{name}"
                received = download(installed_url) if catalog["repository"] != REPOSITORY else assets[name]
                verify_identity(received, identity(assets[name]))
                result["installedClientUrls"].append({"url": installed_url, **identity(received)})
            result["platformSources"][target] = source_archive(source, converter, version, target)
        # Download the exact tag's preferred source, separately from release assets.
        source_url = f"https://github.com/{catalog['repository']}/archive/refs/tags/{tag}.tar.gz"
        source = download(source_url)
        preferred = tar_files(source)
        roots = {name.split("/")[0] for name in preferred}
        require(len(roots) == 1, "MPL tag source archive root mismatch")
        prefix = roots.pop() + "/"
        for name in ("apps/vscode-extension/src/extension.ts", "apps/vscode-extension/package.json",
                     "apps/vscode-extension/scripts/build-webview.mjs", "LICENSE", "NOTICE"):
            require(prefix + name in preferred, "MPL preferred source/build input missing")
        require(json.loads(preferred[prefix + "apps/vscode-extension/package.json"])["version"] == version,
                "MPL tag source version mismatch")
        (directory / "tag-source.tar.gz").write_bytes(source)
        result["mplTagSource"] = {"url": source_url, **identity(source), "preferredSourceFilesPresent": True}
    else:
        family = "viewer-core" if tag.startswith("viewer-core-") else "viewer-webgl"
        manifest_url = f"https://raw.githubusercontent.com/{REPOSITORY}/{tag}/compatibility/{family}.json"
        manifest_bytes = download(manifest_url)
        manifest = json.loads(manifest_bytes)
        (directory / "tag-compatibility.json").write_bytes(manifest_bytes)
        result["tagManifest"] = {"url": manifest_url, **identity(manifest_bytes)}
        result["packages"] = []
        for item in manifest["distribution"]["artifacts"].values():
            data = assets[item["file"]]
            historical_url = manifest["distribution"]["releaseUrl"].replace("/releases/tag/", "/releases/download/") + "/" + item["file"]
            require(any(historical_url == f"https://github.com/{repo}/releases/download/{tag}/{item['file']}"
                        for repo in DELIVERY_REPOSITORIES), "unexpected historical package locator")
            if historical_url != base + item["file"]:
                verify_identity(download(historical_url), identity(data))
            files = tar_files(data)
            package = json.loads(files["package/package.json"])
            content = package_content_sha256(files)
            matches = sha256(data) == item["sha256"] and ("bytes" not in item or len(data) == item["bytes"])
            content_matches = content == item["contentSha256"] if "contentSha256" in item else None
            result["packages"].append({"file": item["file"], "url": historical_url, "package": package["name"],
                "version": package["version"], "expected": item, "observed": {**identity(data),
                "contentSha256": content, "integrity": "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()},
                "rawMatches": matches, "contentMatches": content_matches,
                "gzipHeaderComparison": gzip_os_explanation(data, item["sha256"]) if not matches else None})
            if not matches or content_matches is False:
                result["result"] = "HOLD"
    require(tag_refs() == refs, "tag changed during observation")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new directory outside the checkout")
    parser.add_argument("--tags", nargs="+", default=["v0.1.7", "v0.1.8", "viewer-core-v0.1.0",
                        "viewer-core-v0.1.1", "viewer-core-v0.1.2", "viewer-core-v0.1.3", "viewer-webgl-v0.1.1"])
    args = parser.parse_args()
    require(all(re.fullmatch(r"(?:v|viewer-(?:core|webgl)-v)\d+\.\d+\.\d+", t) for t in args.tags)
            and len(set(args.tags)) == len(args.tags), "unique exact historical tags required")
    require(not args.output.resolve().is_relative_to(ROOT), "observations must stay outside source checkout")
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "viewer-delivery-observation/1", "repository": REPOSITORY,
              "observedAt": datetime.now(timezone.utc).isoformat(),
              "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "scriptSha256": sha256(Path(__file__).read_bytes()), "authentication": "anonymous",
              "python": platform.python_version(),
              "releases": [], "migrationReadiness": "HOLD",
              "limitations": ["Selected tags only; no VS Code UI or installation/update/rollback qualification",
                              "No registry access, consumer admission or artifact attestation verification",
                              "Source payload checks do not establish reproducible builds or new licensing rights"]}
    for tag in args.tags:
        try:
            observation = observe_release(tag, args.output)
        except Exception as error:
            # Never include redirect URLs, environment, credentials or local paths.
            observation = {"tag": tag, "result": "HOLD", "errorClass": type(error).__name__}
            if isinstance(error, ValueError):
                observation["reason"] = str(error)
        report["releases"].append(observation)
        print(f"{tag}: {observation['result']}", flush=True)
        (args.output / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")
    return 0 if all(r["result"] == "PASS" for r in report["releases"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
