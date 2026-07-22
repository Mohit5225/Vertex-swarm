import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Loader2, Terminal } from 'lucide-react'
import type { ToolExecutionNode } from '../lib/agentRunBlocks'
import { getVsCodeApi } from '../lib/vscode'
import {
  extractCommandTags,
  extractTerminalOutput,
  extractTerminalPayload,
  resolveTerminalTitle,
  shouldShowTerminalOutput,
} from '../lib/terminalOutput'
import { requestTerminalOutput } from '../lib/terminalOutputPoll'

interface Props {
  node: ToolExecutionNode
  defaultExpanded?: boolean
  isLive?: boolean
}

const outputPreview = (text: string, maxLines = 3) => {
  const lines = text.trim().split('\n').filter(Boolean)
  if (lines.length <= maxLines) {
    return text.trim()
  }
  return lines.slice(-maxLines).join('\n')
}

const TerminalToolCard: React.FC<Props> = ({
  node,
  defaultExpanded = true,
  isLive = false,
}) => {
  const isRunning = isLive || node.state === 'running'
  const [expanded, setExpanded] = useState(defaultExpanded || isRunning)
  const [polledOutput, setPolledOutput] = useState('')
  const outputRef = useRef<HTMLPreElement>(null)

  const payload = useMemo(() => extractTerminalPayload(node), [node])

  const staticOutput = useMemo(
    () => extractTerminalOutput(node.resultDebug),
    [node.resultDebug]
  )

  const outputText = polledOutput || staticOutput
  const title = resolveTerminalTitle(node)
  const tags = extractCommandTags(payload.command, payload.cwd)
  const durationMs =
    node.completedAt && node.startedAt ? node.completedAt - node.startedAt : undefined
  const resolvedExitCode =
    typeof payload.exitCode === 'number' ? payload.exitCode : null
  const showOutput = expanded || isRunning
  const showOutputPanel = shouldShowTerminalOutput(payload.action)

  useEffect(() => {
    if (isRunning) {
      setExpanded(true)
    }
  }, [isRunning])

  useEffect(() => {
    if (!isRunning || !payload.jobId) {
      return
    }

    let cancelled = false

    const poll = async () => {
      while (!cancelled) {
        const result = await requestTerminalOutput(payload.jobId as string)
        if (cancelled) {
          return
        }
        if (result.content) {
          setPolledOutput(result.content)
        }
        if (result.status && result.status !== 'running') {
          return
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
    }

    void poll()

    return () => {
      cancelled = true
    }
  }, [isRunning, payload.jobId])

  useEffect(() => {
    if (!showOutput || !outputRef.current) {
      return
    }

    outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [outputText, showOutput, isRunning])

  const handleShowTerminal = () => {
    getVsCodeApi()?.postMessage({
      type: 'show-terminal',
      payload: { terminalName: payload.terminalName },
    })
  }

  const collapsedPreview =
    !showOutput && outputText ? outputPreview(outputText) : ''

  return (
    <div className="terminal-tool-card">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="terminal-tool-header"
        aria-expanded={showOutput}
      >
        <span
          className={`terminal-tool-chevron ${showOutput ? 'terminal-tool-chevron--open' : ''}`}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </span>

        <Terminal className="h-3.5 w-3.5 shrink-0 text-[var(--vs-text-tertiary)]" />

        <span className="terminal-tool-title-wrap min-w-0 flex-1">
          {payload.purpose ? (
            <span className="terminal-tool-purpose" title={payload.purpose}>
              {payload.purpose}
            </span>
          ) : null}
          <span className="terminal-tool-title" title={title}>
            {title}
          </span>
        </span>

        <span
          className={`terminal-tool-mode ${payload.userVisible ? 'terminal-tool-mode--visible' : 'terminal-tool-mode--background'}`}
        >
          {payload.userVisible ? 'Visible' : 'Background'}
        </span>

        {tags.length > 0 ? (
          <span className="terminal-tool-tags">{tags.join(', ')}</span>
        ) : null}

        <span className="terminal-tool-meta">
          {isRunning ? (
            <Loader2 className="h-3 w-3 animate-spin text-[var(--vs-accent)]" />
          ) : null}
          {resolvedExitCode !== null ? (
            <span
              className={`terminal-tool-exit ${resolvedExitCode === 0 ? 'terminal-tool-exit--ok' : 'terminal-tool-exit--error'}`}
            >
              exit {resolvedExitCode}
            </span>
          ) : null}
          {durationMs !== undefined ? (
            <span className="terminal-tool-duration">
              {(durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}
        </span>
      </button>

      {collapsedPreview ? (
        <div className="terminal-tool-preview">
          <pre>{collapsedPreview}</pre>
        </div>
      ) : null}

      {showOutput && showOutputPanel ? (
        <div className="terminal-tool-body">
          {payload.command && payload.purpose ? (
            <div className="terminal-tool-command-row">
              <code>{payload.command}</code>
            </div>
          ) : null}

          {!payload.userVisible ? (
            <div className="terminal-tool-subheader">
              <span>
                Background process
                {typeof payload.pid === 'number' ? ` · PID ${payload.pid}` : ''}
              </span>
            </div>
          ) : null}

          <pre ref={outputRef} className="terminal-tool-output">
            {outputText ||
              (isRunning ? 'Waiting for output…' : 'No output captured.')}
          </pre>

          {payload.userVisible ? (
            <div className="terminal-tool-footer">
              <button
                type="button"
                onClick={handleShowTerminal}
                className="terminal-tool-open"
              >
                <Terminal className="h-3 w-3" />
                Open in terminal panel
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default TerminalToolCard
