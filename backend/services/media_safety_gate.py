import argparse
import hashlib
import json
import os
import random
import sqlite3
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone

from backend.services.storage_service import SCHEMA_VERSION, StorageService

REPORT_VERSION = 1
REQUIRED_DESTRUCTIVE_AUDITS = {'delete_asset', 'cleanup_assets', 'release_workflow', 'quarantine', 'gc_canary'}
REQUIRED_FAULT_POINTS = {'media_materialized', 'new_owner_established', 'document_committed', 'owner_promoted',
                         'partial_old_reference_released', 'quarantine_pending_and_moved', 'audit_recorded',
                         'clean_shutdown_and_restart_recovery', 'concurrent_owner_cas'}
def _redacted(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:16]


class MediaSafetyOracle:
    """Read-only independent liveness oracle; it does not call the production scanner."""
    def __init__(self, database_path, assets_dir):
        self.database_path = os.path.abspath(database_path)
        self.assets_dir = os.path.abspath(assets_dir)

    @staticmethod
    def _document_references(value):
        references = []
        stack = [value]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                for key, child in item.items():
                    if key in {'assetKey', 'mediaAssetKey'} and isinstance(child, str):
                        references.append(child)
                    elif key in {'assetKeys', 'mediaAssetKeys'} and isinstance(child, list):
                        references.extend(str(entry) for entry in child if entry)
                    else:
                        stack.append(child)
            elif isinstance(item, list):
                stack.extend(item)
        return set(references)

    def evaluate(self):
        violations = []
        connection = sqlite3.connect(f'file:{self.database_path}?mode=ro', uri=True)
        connection.row_factory = sqlite3.Row
        try:
            schema = int(connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])
            documents = [json.loads(row[0]) for row in connection.execute('SELECT value_json FROM documents')]
            document_keys = set().union(*(self._document_references(value) for value in documents)) if documents else set()
            owner_items = {row['asset_key'] for row in connection.execute('SELECT asset_key FROM media_asset_owner_items')}
            refs = {row['asset_key'] for row in connection.execute('SELECT asset_key FROM media_asset_refs')}
            assets = {row['asset_key']: dict(row) for row in connection.execute('SELECT * FROM assets')}
            candidates = {row[0] for row in connection.execute('SELECT asset_key FROM media_gc_candidate_provenance')}
            transitions = list(connection.execute("SELECT status, target_digest FROM media_asset_transitions WHERE status NOT IN ('completed','superseded')"))
        finally:
            connection.close()
        for key in sorted(document_keys - owner_items):
            violations.append({'kind': 'durable_reference_without_owner', 'identity': _redacted(key)})
        for key in sorted((owner_items | refs) & candidates):
            violations.append({'kind': 'owned_asset_is_gc_candidate', 'identity': _redacted(key)})
        for key in sorted(owner_items | refs):
            row = assets.get(key)
            path = os.path.abspath(os.path.join(self.assets_dir, *(row['relative_path'].split('/') if row else [])))
            if not row or not path.startswith(self.assets_dir + os.sep) or not os.path.isfile(path):
                violations.append({'kind': 'owned_asset_missing_evidence', 'identity': _redacted(key)})
        if transitions and any(key not in refs | owner_items for key in document_keys):
            violations.append({'kind': 'interrupted_transition_lost_required_reference', 'count': len(transitions)})
        return {'schemaVersion': schema, 'sources': ['workflowDocuments', 'ownerRows', 'assetMetadata', 'physicalFiles'],
                'scanResult': {'documentReferences': len(document_keys), 'ownerReferences': len(owner_items),
                               'assetMetadata': len(assets)},
                'violations': violations, 'invariantViolationCount': len(violations)}


def _verify_release_evidence(repo_root, evidence_path, executor):
    if os.path.getsize(evidence_path) > 64 * 1024:
        raise RuntimeError('Media asset safety gate failed: oversized evidence manifest')
    with open(evidence_path, encoding='utf-8') as source:
        evidence = json.load(source)
    allowed = {'fixtureVersion', 'executionTests', 'matrixCoverage', 'destructiveAudits', 'faultPoints'}
    if set(evidence) != allowed:
        raise RuntimeError('Media asset safety gate failed: unknown evidence fields')
    executions = {}
    for test_id, command in evidence.get('executionTests', {}).items():
        resolved = [sys.executable if value == '{python}' else value for value in command]
        result = executor(resolved, cwd=repo_root, capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'Media asset safety gate failed: execution evidence {test_id}')
        executions[test_id] = {'commandDigest': _redacted(json.dumps(resolved)), 'exitCode': result.returncode}
    def require(category):
        result = {}
        for name, test_ids in evidence.get(category, {}).items():
            if not test_ids or any(test_id not in executions for test_id in test_ids):
                raise RuntimeError(f'Media asset safety gate failed: missing execution evidence {name}')
            result[name] = test_ids
        return result
    audits, faults = require('destructiveAudits'), require('faultPoints')
    if set(audits) != REQUIRED_DESTRUCTIVE_AUDITS or set(faults) != REQUIRED_FAULT_POINTS:
        raise RuntimeError('Media asset safety gate failed: incomplete mandatory evidence baseline')
    return evidence['fixtureVersion'], executions, require('matrixCoverage'), audits, faults


def _load_regression_seeds(repo_root, seed_path=None):
    path = seed_path or os.path.join(repo_root, 'tests', 'fixtures', 'media-safety-regression-seeds.json')
    with open(path, encoding='utf-8') as source:
        fixture = json.load(source)
    seeds = fixture.get('seeds')
    if fixture.get('version') != 1 or not isinstance(seeds, list) or not seeds or not all(isinstance(seed, int) for seed in seeds):
        raise RuntimeError('Media asset safety gate failed: invalid regression seed fixture')
    return seeds


def _run_production_sequences(seeds):
    runs, violations = [], []
    for seed in seeds:
        generator = random.Random(seed)
        operations = [generator.choice(['save', 'replace', 'undo', 'delete', 'restart']) for _ in range(16)]
        with tempfile.TemporaryDirectory(prefix='cainflow-media-property-') as root:
            service = StorageService(os.path.join(root, 'data', 'cainflow.db'), os.path.join(root, 'data', 'assets'),
                                     os.path.join(root, 'data', 'temp'), os.path.join(root, 'exports'))
            service.initialize()
            service._safety_status.update({'state': 'healthy', 'reason': 'gate', 'recoveryConditions': []})
            service._write_safety_status(service._safety_status)
            epoch = service.get_storage_safety_status()['storageEpoch']
            assets = [service.put_asset(f'media:property:{seed}:{index}', f'{seed}:{index}'.encode(),
                                        'image/png', 'media') for index in range(3)]
            generation = 0
            tombstoned = False
            reference_keys = []
            for revision, operation in enumerate(operations, 1):
                if operation == 'restart':
                    service.mark_clean_shutdown()
                    service = StorageService(service.database_path, service.assets_dir, service.temp_dir, service.exports_dir)
                    service.initialize()
                    continue
                if tombstoned and operation == 'delete':
                    operation = 'undo'
                keys = [] if operation == 'delete' else [assets[generator.randrange(len(assets))]['asset_key']]
                intent = 'delete' if operation == 'delete' else ('undo' if tombstoned or operation == 'undo' else 'save')
                service.record_media_workflow_revision('property-workflow', revision, epoch, [{
                    'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': keys}])
                outcome = service.replace_media_owner_references(
                    workflow_id='property-workflow', owner_type='workflow-node', owner_id='node',
                    operation_id=f'{seed}:{revision}', idempotency_key=f'{seed}:{revision}', intent=intent,
                    expected_generation=generation, document_revision=revision, storage_epoch=epoch, asset_keys=keys)
                if outcome['status'] != 'committed':
                    violations.append({'seed': seed, 'step': revision, 'kind': 'production_transition_not_committed'})
                else:
                    generation = outcome['generation']
                    tombstoned = operation == 'delete'
                    reference_keys = keys
                owner = service.get_media_owner_reference_list('property-workflow', 'workflow-node', 'node')
                if (owner or {}).get('assetKeys', []) != reference_keys:
                    violations.append({'seed': seed, 'step': revision, 'kind': 'production_owner_model_mismatch'})
            revision = len(operations) + 1
            contenders = [assets[generator.randrange(len(assets))]['asset_key'] for _ in range(2)]
            service.record_media_workflow_revision('race-workflow', revision, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': contenders}])
            barrier, results, errors = threading.Barrier(2, timeout=10), [], []
            def contend(index):
                try:
                    contender = StorageService(service.database_path, service.assets_dir, service.temp_dir,
                                               service.exports_dir, transition_fault_injector=lambda stage: barrier.wait()
                                               if stage == 'new_owner_established' else None)
                    results.append(contender.replace_media_owner_references(
                        workflow_id='race-workflow', owner_type='workflow-node', owner_id='node',
                        operation_id=f'race:{seed}:{index}', idempotency_key=f'race:{seed}:{index}', intent='save',
                        expected_generation=0, document_revision=revision, storage_epoch=epoch,
                        asset_keys=contenders))
                except Exception as error:
                    errors.append(type(error).__name__)
            threads = [threading.Thread(target=contend, args=(index,)) for index in range(2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join(15)
            if errors or sorted(item['status'] for item in results) != ['committed', 'stale']:
                violations.append({'seed': seed, 'kind': 'production_concurrent_cas_mismatch'})
            oracle = MediaSafetyOracle(service.database_path, service.assets_dir).evaluate()
            violations.extend({'seed': seed, **item} for item in oracle['violations'])
        runs.append({'seed': seed, 'operations': operations})
    return runs, violations


def run_release_gate(database_path, assets_dir, output_path, utc_now=None, seeds=None,
                     repo_root=None, evidence_path=None, seed_path=None, _evidence_executor=None):
    oracle = MediaSafetyOracle(database_path, assets_dir).evaluate()
    repo_root = os.path.abspath(repo_root or os.path.join(os.path.dirname(__file__), '..', '..'))
    evidence_path = evidence_path or os.path.join(repo_root, 'tests', 'fixtures', 'media-safety-gate.json')
    fixture_version, executions, matrix_evidence, destructive_audits, fault_points = _verify_release_evidence(
        repo_root, evidence_path, _evidence_executor or subprocess.run)
    seeds = list(seeds) if seeds is not None else _load_regression_seeds(repo_root, seed_path)
    if oracle['schemaVersion'] != SCHEMA_VERSION:
        raise RuntimeError('Media asset safety gate failed: unknown schema')
    property_runs, property_violations = _run_production_sequences(seeds)
    report = {
        'reportVersion': REPORT_VERSION, 'fixtureVersion': fixture_version,
        'schemaVersion': oracle['schemaVersion'],
        'generatedAtUtc': (utc_now or (lambda: datetime.now(timezone.utc).isoformat()))(),
        'matrixCoverage': matrix_evidence, 'executionEvidence': executions,
        'faultPoints': fault_points, 'destructiveAuditCoverage': destructive_audits,
        'randomSeeds': seeds, 'propertySequenceDigests': [
            hashlib.sha256(json.dumps(run, sort_keys=True).encode()).hexdigest()[:16] for run in property_runs],
        'scanResult': oracle['scanResult'], 'invariantViolationCount': oracle['invariantViolationCount'],
        'propertyInvariantViolationCount': len(property_violations),
        'violations': oracle['violations'] + property_violations,
    }
    directory = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(directory, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2, sort_keys=True)
    if report['invariantViolationCount'] or report['propertyInvariantViolationCount']:
        raise RuntimeError('Media asset safety gate failed')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='cainflow-media-safety-') as root:
        service = StorageService(os.path.join(root, 'data', 'cainflow.db'), os.path.join(root, 'data', 'assets'),
                                 os.path.join(root, 'data', 'temp'), os.path.join(root, 'exports'))
        service.initialize()
        asset = service.put_asset('media:release-fixture', b'release-fixture', 'image/png', 'media')
        epoch = service.get_storage_safety_status()['storageEpoch']
        workflow = {'workflowId': 'release-fixture', 'mediaOwnershipRevision': 1, 'nodes': [
            {'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': [asset['asset_key']]}]}
        service.put_document('session', {'workflows': [workflow]})
        service.record_media_workflow_revision('release-fixture', 1, epoch, [{
            'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': [asset['asset_key']]}])
        service.replace_media_owner_references(workflow_id='release-fixture', owner_type='workflow-node', owner_id='node',
            operation_id='release', idempotency_key='release', expected_generation=0,
            document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']])
        run_release_gate(service.database_path, service.assets_dir, arguments.output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
