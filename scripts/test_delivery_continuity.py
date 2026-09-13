# SPDX-License-Identifier: MPL-2.0
import hashlib
import importlib.util
import io
import gzip
import json
import tempfile
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("continuity", Path(__file__).with_name("check-delivery-continuity.py"))
continuity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(continuity)


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as result:
        for name, data, kind in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.size = len(data)
            result.addfile(item, io.BytesIO(data))
    return output.getvalue()


class ContinuityTests(unittest.TestCase):
    def test_identity_rejects_replaced_bytes_and_size(self):
        original = b"original"
        continuity.verify_identity(original, continuity.identity(original))
        for data in (b"modified", original + b"x"):
            with self.assertRaises(ValueError):
                continuity.verify_identity(data, continuity.identity(original))

    def test_checksum_rejects_empty_duplicate_and_traversal(self):
        digest = "0" * 64
        for data in (b"", b"invalid", f"{digest}  ../file".encode(),
                     f"{digest}  file\n{digest}  file".encode()):
            with self.assertRaises(ValueError):
                continuity.checksum_entries(data)
        self.assertEqual(continuity.checksum_entries(f"{digest} *file\n".encode()), {"file": digest})

    def test_tar_rejects_links_duplicates_traversal_and_expansion(self):
        for entries in ([('package/file', b'', tarfile.SYMTYPE)],
                        [('package/file', b'', tarfile.REGTYPE)] * 2,
                        [('../file', b'', tarfile.REGTYPE)]):
            with self.assertRaises(ValueError):
                continuity.tar_files(archive(entries))
        with patch.object(continuity, "LIMIT", 2):
            with self.assertRaises(ValueError):
                continuity.tar_files(archive([('package/file', b'123', tarfile.REGTYPE)]))

    def test_content_digest_ignores_container_order_but_detects_payload_change(self):
        a = archive([('package/b', b'b', tarfile.REGTYPE), ('package/a', b'a', tarfile.REGTYPE)])
        b = archive([('package/a', b'a', tarfile.REGTYPE), ('package/b', b'b', tarfile.REGTYPE)])
        expected = hashlib.sha256(b'a\x001\x00a\x00b\x001\x00b\x00').hexdigest()
        self.assertEqual(continuity.package_content_sha256(continuity.tar_files(a)), expected)
        self.assertEqual(continuity.package_content_sha256(continuity.tar_files(b)), expected)
        self.assertNotEqual(continuity.package_content_sha256({'package/a': b'changed'}), expected)

    def test_anonymous_redirects_fail_closed(self):
        for url in ('http://github.com/file', 'https://example.org/file',
                    'https://token@github.com/file', 'https://github.com:444/file'):
            with self.assertRaises(ValueError):
                continuity.safe_url(url)
        continuity.safe_url('https://release-assets.githubusercontent.com/file?temporary-signature=value')

    def test_source_archive_cannot_pass_missing_payload(self):
        with self.assertRaises((ValueError, KeyError)):
            continuity.source_archive(archive([('wrong/file', b'', tarfile.REGTYPE)]), b'', '0.1.8', 'linux-x64')

    def test_header_comparison_recreates_hash_without_mutation(self):
        data = gzip.compress(b'package contents', mtime=0)
        changed = bytearray(data)
        changed[9] = 19 if data[9] != 19 else 3
        before = bytes(data)
        result = continuity.gzip_os_explanation(data, continuity.sha256(changed))
        self.assertEqual(result['expectedHashRecreatedWithByte'], changed[9])
        self.assertTrue(result['rawMismatchRemains'])
        self.assertEqual(data, before)

    def test_historical_package_locator_and_missing_content_pin_are_explicit(self):
        tag = 'viewer-core-v0.1.0'
        name = 'menaje-viewer-core-0.1.0.tgz'
        payload = archive([('package/package.json', json.dumps({'name': '@menaje/viewer-core',
                           'version': '0.1.0'}).encode(), tarfile.REGTYPE)])
        sums = f'{continuity.sha256(payload)}  {name}\n'.encode()
        base = f'https://github.com/{continuity.REPOSITORY}/releases/download/{tag}/'
        old_url = f'https://github.com/menaje/dwg-viewer/releases/download/{tag}/{name}'
        metadata = {'id': 1, 'tag_name': tag, 'draft': False, 'immutable': False,
                    'assets': [{'name': n, 'size': len(b), 'digest': 'sha256:' + continuity.sha256(b),
                                'browser_download_url': base + n} for n, b in [(name, payload), ('SHA256SUMS', sums)]]}
        manifest = {'distribution': {'releaseUrl': f'https://github.com/menaje/dwg-viewer/releases/tag/{tag}',
                    'artifacts': {'viewerCore': {'file': name, 'sha256': continuity.sha256(payload)}}}}
        responses = {base + name: payload, base + 'SHA256SUMS': sums, old_url: payload,
                     f'https://api.github.com/repos/{continuity.REPOSITORY}/releases/tags/{tag}': json.dumps(metadata).encode(),
                     f'https://raw.githubusercontent.com/{continuity.REPOSITORY}/{tag}/compatibility/viewer-core.json': json.dumps(manifest).encode()}
        with tempfile.TemporaryDirectory() as directory, patch.object(continuity, 'download', side_effect=responses.__getitem__) as get, \
                patch.object(continuity.subprocess, 'check_output', return_value=f'{"a" * 40}\trefs/tags/{tag}\n'):
            result = continuity.observe_release(tag, Path(directory))
            self.assertEqual(result['result'], 'PASS')
            self.assertIsNone(result['packages'][0]['contentMatches'])
            self.assertEqual(result['packages'][0]['url'], old_url)
            get.assert_any_call(old_url)


if __name__ == '__main__':
    unittest.main()
