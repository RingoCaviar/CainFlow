import json
import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace

from backend.services.media_safety_gate import MediaSafetyOracle, run_release_gate
from backend.services.diagnostic_service import DiagnosticService
from backend.services.storage_service import StorageService


class MediaSafetyGateTests(unittest.TestCase):
    @staticmethod
    def successful_evidence(*_args, **_kwargs):
        return SimpleNamespace(returncode=0)

    def make_service(self, root):
        service = StorageService(os.path.join(root, 'data', 'cainflow.db'), os.path.join(root, 'data', 'assets'),
                                 os.path.join(root, 'data', 'temp'), os.path.join(root, 'exports'))
        service.initialize()
        return service

    def test_independent_oracle_reads_documents_owners_metadata_and_files(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_asset('media:a', b'a', 'image/png', 'media')
            epoch = service.get_storage_safety_status()['storageEpoch']
            workflow = {'workflowId': 'wf', 'mediaOwnershipRevision': 1, 'nodes': [
                {'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': [asset['asset_key']]}]}
            service.put_document('session', {'workflows': [workflow]})
            service.record_media_workflow_revision('wf', 1, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': [asset['asset_key']]}])
            service.replace_media_owner_references(workflow_id='wf', owner_type='workflow-node', owner_id='node',
                operation_id='op', idempotency_key='op', expected_generation=0, document_revision=1,
                storage_epoch=epoch, asset_keys=[asset['asset_key']])
            report = MediaSafetyOracle(service.database_path, service.assets_dir).evaluate()
            self.assertEqual(0, report['invariantViolationCount'])
            self.assertEqual({'workflowDocuments', 'ownerRows', 'assetMetadata', 'physicalFiles'}, set(report['sources']))

    def test_oracle_blocks_owned_gc_candidate_and_missing_required_reference(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_asset('media:a', b'a', 'image/png', 'media')
            with service._connect() as database:
                database.execute("INSERT INTO media_gc_candidate_provenance VALUES(?, 'wf', 1)", (asset['asset_key'],))
                database.execute("INSERT INTO media_asset_owners VALUES('wf','workflow-node','node',1,1,0,1)")
                database.execute("INSERT INTO media_asset_owner_items VALUES('wf','workflow-node','node',0,?)", (asset['asset_key'],))
            report = MediaSafetyOracle(service.database_path, service.assets_dir).evaluate()
            self.assertGreater(report['invariantViolationCount'], 0)
            self.assertIn('owned_asset_is_gc_candidate', {item['kind'] for item in report['violations']})

    def test_release_report_is_machine_readable_redacted_and_reproducible(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            output = os.path.join(root, 'report.json')
            report = run_release_gate(service.database_path, service.assets_dir, output,
                utc_now=lambda: '2026-09-10T00:00:00Z', seeds=[17, 29],
                _evidence_executor=self.successful_evidence)
            with open(output, encoding='utf-8') as source:
                persisted = json.load(source)
            self.assertEqual(report, persisted)
            self.assertEqual([17, 29], report['randomSeeds'])
            self.assertIn('schemaVersion', report)
            self.assertIn('faultPoints', report)
            self.assertIn('matrixCoverage', report)
            serialized = json.dumps(report)
            self.assertNotRegex(serialized, r'https?://|private-media-bytes|private prompt|credential|[A-Z]:\\')

    def test_diagnostic_sentinels_do_not_reach_database_logs_or_exports(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            log_dir, export_dir = os.path.join(root, 'logs'), service.exports_dir
            diagnostics = DiagnosticService(log_dir, budget_bytes=24 * 1024, canvas_budget_bytes=3 * 1024,
                                            segment_bytes=4 * 1024, record_bytes=1024, retention_days=14)
            sentinels = ['bare-base64-media-sentinel', 'private prompt sentinel', r'C:\Users\release-secret',
                         'credential-secret', 'https://media.invalid/a?X-Signature=full-secret-signature']
            diagnostics.record({'requestId': 'sentinel', 'request': {'body': {
                'inputImage': sentinels[0], 'negative_prompt': sentinels[1], 'filePath': sentinels[2],
                'api_key': sentinels[3], 'sourceUrl': sentinels[4]}}, 'error': {'message': 'request failed'}}, force=True)
            surfaces = [service.database_path]
            surfaces.extend(os.path.join(path, name) for path, _, names in os.walk(log_dir) for name in names)
            surfaces.extend(os.path.join(path, name) for path, _, names in os.walk(export_dir) for name in names)
            chunks = []
            for path in surfaces:
                with open(path, 'rb') as source:
                    chunks.append(source.read())
            combined = b''.join(chunks)
            for sentinel in sentinels:
                self.assertNotIn(sentinel.encode(), combined)

    def test_unknown_schema_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            with service._connect() as database:
                database.execute("UPDATE meta SET value='999' WHERE key='schema_version'")
            with self.assertRaises(RuntimeError):
                run_release_gate(service.database_path, service.assets_dir, os.path.join(root, 'report.json'),
                                 _evidence_executor=self.successful_evidence)

    def test_missing_destructive_audit_evidence_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            evidence = os.path.join(root, 'evidence.json')
            with open(evidence, 'w', encoding='utf-8') as output:
                json.dump({'fixtureVersion': 1, 'requiredTests': {},
                           'destructiveAudits': {'delete_asset': ['missing.py', 'marker']}}, output)
            with self.assertRaises((RuntimeError, FileNotFoundError)):
                run_release_gate(service.database_path, service.assets_dir, os.path.join(root, 'report.json'),
                                 repo_root=root, evidence_path=evidence,
                                 _evidence_executor=self.successful_evidence)

    def test_regression_seeds_are_loaded_from_the_versioned_fixture(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            seed_path = os.path.join(root, 'seeds.json')
            with open(seed_path, 'w', encoding='utf-8') as output:
                json.dump({'version': 1, 'seeds': [41]}, output)
            report = run_release_gate(service.database_path, service.assets_dir, os.path.join(root, 'report.json'),
                                      seed_path=seed_path, _evidence_executor=self.successful_evidence)
            self.assertEqual([41], report['randomSeeds'])

    def test_evidence_manifest_unknown_fields_and_size_limits_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            evidence = os.path.join(root, 'evidence.json')
            with open(evidence, 'w', encoding='utf-8') as output:
                json.dump({'fixtureVersion': 1, 'executionTests': {}, 'matrixCoverage': {},
                           'destructiveAudits': {}, 'faultPoints': {}, 'unknown': True}, output)
            with self.assertRaisesRegex(RuntimeError, 'unknown evidence fields'):
                run_release_gate(service.database_path, service.assets_dir, os.path.join(root, 'report.json'),
                                 evidence_path=evidence, _evidence_executor=self.successful_evidence)
            with open(evidence, 'w', encoding='utf-8') as output:
                output.write(' ' * (64 * 1024 + 1))
            with self.assertRaisesRegex(RuntimeError, 'oversized evidence manifest'):
                run_release_gate(service.database_path, service.assets_dir, os.path.join(root, 'report.json'),
                                 evidence_path=evidence, _evidence_executor=self.successful_evidence)

    def test_oracle_preserves_case_distinct_asset_identities_and_windows_style_sentinel_is_redacted(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            lower = service.put_asset('media:case', b'lower', 'image/png', 'media')
            upper = service.put_asset('media:CASE', b'upper', 'image/png', 'media')
            self.assertNotEqual(lower['relative_path'], upper['relative_path'])
            report = MediaSafetyOracle(service.database_path, service.assets_dir).evaluate()
            self.assertEqual(0, report['invariantViolationCount'])
            self.assertNotIn(r'C:\Users\release-secret', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
