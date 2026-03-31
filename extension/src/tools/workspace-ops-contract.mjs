const SUPPORTED_ACTIONS = new Set([
  'list_dir',
  'search_text',
  'read_file',
  'edit_file',
  'create_file',
  'delete_path',
  'rename_path',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringCandidate(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return undefined;
}

export function normalizeWorkspaceOpsAction(value) {
  if (typeof value !== 'string') {
    throw new Error('workspace_ops.action must be a string.');
  }

  const normalized = value.trim();
  if (!SUPPORTED_ACTIONS.has(normalized)) {
    throw new Error(`Unsupported workspace_ops action: ${normalized}`);
  }

  return normalized;
}

export function parseWorkspaceOpsMode(value) {
  if (value !== 'preview' && value !== 'apply') {
    throw new Error(`workspace_ops.mode must be "preview" or "apply", received: ${String(value)}`);
  }

  return value;
}

export function extractWorkspaceOpsRequest(rawArgs) {
  if (!isPlainObject(rawArgs)) {
    throw new Error('workspace_ops args must be an object.');
  }

  const payload = isPlainObject(rawArgs.payload) ? rawArgs.payload : rawArgs;
  const action = normalizeWorkspaceOpsAction(rawArgs.action);
  const requestId = readStringCandidate(
    rawArgs.request_id,
    rawArgs.requestId,
    payload.request_id,
    payload.requestId
  );

  if (!requestId) {
    throw new Error('workspace_ops.request_id is required.');
  }

  const mode = parseWorkspaceOpsMode(rawArgs.mode ?? payload.mode);
  const expectedHash = readStringCandidate(
    rawArgs.expected_hash,
    rawArgs.expectedHash,
    payload.expected_hash,
    payload.expectedHash
  );
  const expectedVersion = readStringCandidate(
    rawArgs.expected_version,
    rawArgs.expectedVersion,
    payload.expected_version,
    payload.expectedVersion
  );

  return {
    action,
    requestId,
    mode,
    payload,
    expectedHash,
    expectedVersion,
  };
}

export function buildConflictResult({
  request,
  context,
  startMs,
  errorCode,
  summary,
  conflict,
}) {
  return {
    tool_name: 'workspace_ops',
    tool_call_id: context.tool_call_id,
    session_id: context.session_id,
    chat_id: context.chat_id,
    message_id: context.message_id,
    request_id: request.requestId,
    action: request.action,
    status: 'error',
    content: summary,
    summary,
    data: {
      request_id: request.requestId,
      action: request.action,
      mode: request.mode,
    },
    conflict,
    error_code: errorCode,
    execution_time_ms: Date.now() - startMs,
  };
}