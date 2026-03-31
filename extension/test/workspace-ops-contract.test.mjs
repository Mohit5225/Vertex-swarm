import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeWorkspaceOpsAction,
  parseWorkspaceOpsMode,
  extractWorkspaceOpsRequest,
  buildConflictResult,
} from '../src/tools/workspace-ops-contract.mjs';

test('normalizeWorkspaceOpsAction accepts workspace_ops actions only', () => {
  assert.equal(normalizeWorkspaceOpsAction('edit_file'), 'edit_file');
  assert.throws(() => normalizeWorkspaceOpsAction('legacy_tool'));
});

test('parseWorkspaceOpsMode accepts preview and apply only', () => {
  assert.equal(parseWorkspaceOpsMode('preview'), 'preview');
  assert.equal(parseWorkspaceOpsMode('apply'), 'apply');
  assert.throws(() => parseWorkspaceOpsMode('dry-run'));
});

test('extractWorkspaceOpsRequest pulls idempotency and concurrency fields', () => {
  const request = extractWorkspaceOpsRequest({
    action: 'rename_path',
    request_id: 'req_123',
    mode: 'apply',
    payload: {
      oldPath: 'old.ts',
      newPath: 'new.ts',
      expected_version: 'fnv1a-abc',
    },
  });

  assert.deepEqual(request, {
    action: 'rename_path',
    requestId: 'req_123',
    mode: 'apply',
    payload: {
      oldPath: 'old.ts',
      newPath: 'new.ts',
      expected_version: 'fnv1a-abc',
    },
    expectedHash: undefined,
    expectedVersion: 'fnv1a-abc',
  });
});

test('buildConflictResult returns a structured conflict payload', () => {
  const result = buildConflictResult({
    request: {
      action: 'edit_file',
      requestId: 'req_99',
      mode: 'apply',
      payload: {},
    },
    context: {
      tool_call_id: 'tc_99',
      session_id: 'session_99',
      chat_id: 'chat_99',
      message_id: 'message_99',
    },
    startMs: 1000,
    errorCode: 'HASH_CONFLICT',
    summary: 'Concurrency conflict for src/app.ts.',
    conflict: {
      target: 'src/app.ts',
      expected_version: 'fnv1a-aaaa',
      current_version: 'fnv1a-bbbb',
    },
  });

  assert.equal(result.tool_name, 'workspace_ops');
  assert.equal(result.request_id, 'req_99');
  assert.equal(result.action, 'edit_file');
  assert.equal(result.status, 'error');
  assert.equal(result.summary, 'Concurrency conflict for src/app.ts.');
  assert.deepEqual(result.conflict, {
    target: 'src/app.ts',
    expected_version: 'fnv1a-aaaa',
    current_version: 'fnv1a-bbbb',
  });
  assert.equal(result.error_code, 'HASH_CONFLICT');
  assert.equal(result.execution_time_ms >= 0, true);
});