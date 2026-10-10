import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


privacy = module('privacy', 'audit-publication.py')
catalog = module('catalog', 'merge-catalog.py')


class PublicationTests(unittest.TestCase):
    def test_private_addresses_and_credentials_are_detected_without_returning_values(self):
        samples = ['person' + '@' + 'private.invalid', '/home/' + 'someone/file',
                   '192.' + '168.1.20', 'token = "' + 'a' * 32 + '"',
                   '-----BEGIN ' + 'PRIVATE KEY-----', 'https://user:' + 'password' + '@' + 'host.invalid']
        for sample in samples:
            with self.subTest(sample=sample):
                hits = privacy.scan_text(sample)
                self.assertTrue(hits)
                self.assertNotIn(sample, str(hits))

    def test_public_fixture_and_license_addresses_are_allowed(self):
        self.assertEqual([], privacy.scan_text('/Users/AuthenticateByName /Users/New test@example.com bot@users.noreply.github.com licensing@fsf.org http://127.0.0.1:8096'))

    def test_assembly_versions_are_allowed_but_private_hosts_are_not(self):
        assembly = 'System.Text.Json, Version=' + '10.' + '0.0.0, Culture=neutral, PublicKeyToken=abc'
        self.assertEqual([], privacy.scan_text(assembly))
        self.assertTrue(privacy.scan_text('http://' + '10.' + '0.0.0'))

    def test_zip_members_and_dotnet_strings_are_scanned(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('Plugin.dll', ('token = "' + 'z' * 32 + '"').encode('utf-16le'))
            hits, count = privacy.audit(path)
            self.assertEqual(1, count)
            self.assertTrue(any(hit[0].endswith(':Plugin.dll') and hit[1] == 'embedded credential' for hit in hits))

    def test_catalog_merge_preserves_concurrent_versions_and_other_plugins(self):
        version = lambda v, abi='12.1.0.0': {'version': v, 'targetAbi': abi, 'checksum': v}
        current = [{'guid': 'plugin', 'versions': [version('1.2.0.0'), version('1.1.0.0')]}, {'guid': 'other', 'versions': []}]
        incoming = [{'guid': 'plugin', 'versions': [version('1.1.1.0'), {**version('1.1.0.0'), 'checksum': 'stale'}, version('1.1.0.0', '12.2.0.0')]}]
        merged = catalog.merge_catalog(current, incoming)
        self.assertEqual(['1.2.0.0', '1.1.1.0', '1.1.0.0', '1.1.0.0'], [v['version'] for v in merged[0]['versions']])
        self.assertEqual('1.1.0.0', merged[0]['versions'][2]['checksum'])
        self.assertEqual('other', merged[1]['guid'])
        self.assertEqual(merged, catalog.merge_catalog(merged, incoming))


if __name__ == '__main__':
    unittest.main()
