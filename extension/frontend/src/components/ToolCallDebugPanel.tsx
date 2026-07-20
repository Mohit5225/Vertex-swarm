import React from 'react'
import type { ToolExecutionNode } from '../lib/agentRunBlocks'

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const formatPayload = (value: unknown) => {
  if (typeof value === 'undefined') {
    return '(not captured)'
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || '(empty)'
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const formatRequest = (requestDebug: unknown) => {
  const record = asRecord(requestDebug)
  if (!record) {
    return formatPayload(requestDebug)
  }

  const args = asRecord(record.args)
  if (args) {
    return formatPayload(args)
  }

  return formatPayload(record)
}

const formatResult = (resultDebug: unknown) => {
  const record = asRecord(resultDebug)
  if (!record) {
    return formatPayload(resultDebug)
  }

  const content =
    typeof record.content === 'string' && record.content.trim()
      ? record.content
      : undefined
  const data = record.data

  if (content && typeof data !== 'undefined') {
    return `${content}\n\n--- data ---\n${JSON.stringify(data, null, 2)}`
  }

  if (content) {
    return content
  }

  return formatPayload(record)
}

const SCROLL_PANEL_CLASS =
  'h-[17.5rem] overflow-auto overscroll-contain rounded-md border border-white/[0.06] bg-black/25 px-2.5 py-2 [scrollbar-width:thin] [scrollbar-color:rgba(143,163,196,0.45)_transparent]'

const ToolCallDebugPanel: React.FC<{ node: ToolExecutionNode }> = ({ node }) => {
  const meta = [node.toolName, node.action, node.state].filter(Boolean).join(' · ')

  return (
    <div className="space-y-2">
      {meta ? (
        <p className="text-[10px] font-medium uppercase tracking-wider text-[#6f81a1]">
          {meta}
        </p>
      ) : null}

      <div>
        <div className="mb-1 text-[10px] font-medium text-[#91a0bb]">Sent to extension</div>
        <pre className={`${SCROLL_PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#c6d2e7]`}>
          {formatRequest(node.requestDebug)}
        </pre>
      </div>

      <div>
        <div className="mb-1 text-[10px] font-medium text-[#91a0bb]">Captured output</div>
        <pre className={`${SCROLL_PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#c6d2e7]`}>
          {node.state === 'running' && !node.resultDebug
            ? '(waiting for result…)'
            : formatResult(node.resultDebug)}
        </pre>
      </div>
    </div>
  )
}

export default ToolCallDebugPanel
