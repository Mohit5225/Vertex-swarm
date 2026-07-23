import React, { useMemo, useState } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { getVsCodeApi } from '../lib/vscode'
import { labelForHilAnswer } from '../lib/hilCardState'
import { type HilAnswer, type HilCardState } from '../lib/hilTypes'

interface Props {
  card: HilCardState
}

const HilQuestionCard: React.FC<Props> = ({ card }) => {
  const isResolved = card.status === 'resolved'
  const [pageIndex, setPageIndex] = useState(0)
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [draftAnswers, setDraftAnswers] = useState<HilAnswer[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  const total = card.questions.length
  const currentQuestion = card.questions[pageIndex]
  const resolvedAnswersById = useMemo(() => {
    const map = new Map<string, HilAnswer>()
    for (const answer of card.answers ?? []) {
      map.set(answer.question_id, answer)
    }
    return map
  }, [card.answers])

  const hasSelection =
    (useCustom && customText.trim().length > 0) ||
    (!useCustom && selectedOptionId !== null)

  const resetPageInput = () => {
    setSelectedOptionId(null)
    setCustomText('')
    setUseCustom(false)
  }

  const submitAll = (answers: HilAnswer[]) => {
    if (isSubmitting || isResolved) {
      return
    }

    const api = getVsCodeApi()
    if (!api) {
      return
    }

    setIsSubmitting(true)
    api.postMessage({
      type: 'hil-respond',
      payload: {
        hil_session_id: card.hilSessionId,
        answers,
      },
    })
  }

  const goNext = () => {
    if (!currentQuestion || isResolved || isSubmitting) {
      return
    }

    let answer: HilAnswer | null = null
    if (useCustom && currentQuestion.allow_custom !== false) {
      const text = customText.trim()
      if (!text) {
        return
      }
      answer = { question_id: currentQuestion.question_id, type: 'custom', text }
    } else if (selectedOptionId) {
      answer = {
        question_id: currentQuestion.question_id,
        type: 'option',
        option_id: selectedOptionId,
      }
    } else {
      return
    }

    const nextAnswers = [...draftAnswers, answer]
    setDraftAnswers(nextAnswers)
    resetPageInput()

    if (pageIndex + 1 >= total) {
      submitAll(nextAnswers)
      return
    }

    setPageIndex(pageIndex + 1)
  }

  const skipQuestion = () => {
    if (!currentQuestion || isResolved || isSubmitting || currentQuestion.allow_skip === false) {
      return
    }

    const nextAnswers: HilAnswer[] = [
      ...draftAnswers,
      { question_id: currentQuestion.question_id, type: 'skipped' },
    ]
    setDraftAnswers(nextAnswers)
    resetPageInput()

    if (pageIndex + 1 >= total) {
      submitAll(nextAnswers)
      return
    }

    setPageIndex(pageIndex + 1)
  }

  if (!currentQuestion && !isResolved) {
    return null
  }

  return (
    <div className="relative z-10 my-4 overflow-hidden rounded-[22px] bg-[var(--vs-raised)] px-5 py-5 shadow-[0_18px_48px_rgba(0,0,0,0.38),inset_0_1px_0_var(--vs-edge-light)]">
      {isResolved ? (
        <div className="space-y-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--vs-text-tertiary)]">
            {card.agentLabel} · answered
          </p>
          {card.questions.map((question) => {
            const answer = resolvedAnswersById.get(question.question_id)
            return (
              <div key={question.question_id} className="space-y-2">
                <p className="text-[15px] leading-7 text-[var(--vs-text-secondary)]">
                  {question.prompt}
                </p>
                <div className="rounded-2xl bg-white/[0.06] px-4 py-3 text-[15px] font-medium text-[var(--vs-text-primary)]">
                  {labelForHilAnswer(question, answer)}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <>
          <div className="mb-5 flex items-start justify-between gap-4">
            <p className="min-w-0 flex-1 text-[15px] leading-7 text-[var(--vs-text-primary)]">
              <span className="text-[var(--vs-text-tertiary)]">[{card.agentLabel}]</span>{' '}
              {currentQuestion.prompt}
            </p>

            {total > 1 ? (
              <div
                className="flex shrink-0 items-center gap-1 pt-0.5 text-[12px] text-[var(--vs-text-tertiary)]"
                aria-label={`Question ${pageIndex + 1} of ${total}`}
              >
                <ChevronLeft size={14} strokeWidth={1.75} className="opacity-35" />
                <span className="tabular-nums">
                  {pageIndex + 1} of {total}
                </span>
                <ChevronRight size={14} strokeWidth={1.75} className="opacity-35" />
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            {currentQuestion.options.map((option, index) => {
              const isSelected = !useCustom && selectedOptionId === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    setUseCustom(false)
                    setSelectedOptionId(option.id)
                  }}
                  className={`group flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition ${
                    isSelected
                      ? 'bg-[var(--vs-accent-muted)] text-[var(--vs-text-primary)] ring-1 ring-[var(--vs-accent)]/35'
                      : 'bg-white/[0.03] text-[var(--vs-text-secondary)] hover:bg-white/[0.06] hover:text-[var(--vs-text-primary)]'
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-[12px] font-medium tabular-nums transition ${
                      isSelected
                        ? 'bg-[var(--vs-accent)]/20 text-[var(--vs-accent-bright)]'
                        : 'bg-white/[0.06] text-[var(--vs-text-tertiary)] group-hover:text-[var(--vs-text-secondary)]'
                    }`}
                  >
                    {index + 1}
                  </span>
                  <span className="flex-1 text-[14px] leading-6">{option.label}</span>
                  {isSelected ? (
                    <ArrowRight
                      size={16}
                      strokeWidth={1.75}
                      className="shrink-0 text-[var(--vs-accent-bright)]"
                    />
                  ) : (
                    <span className="h-4 w-4 shrink-0" />
                  )}
                </button>
              )
            })}
          </div>

          {currentQuestion.allow_custom !== false ? (
            <div className="mt-1.5 space-y-2">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  setUseCustom(true)
                  setSelectedOptionId(null)
                }}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition ${
                  useCustom
                    ? 'bg-white/[0.06] text-[var(--vs-text-primary)] ring-1 ring-white/10'
                    : 'text-[var(--vs-text-secondary)] hover:bg-white/[0.04] hover:text-[var(--vs-text-primary)]'
                }`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                  <Pencil size={13} strokeWidth={1.75} />
                </span>
                <span className="text-[14px]">Something else</span>
              </button>

              {useCustom ? (
                <textarea
                  value={customText}
                  onChange={(event) => setCustomText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && customText.trim()) {
                      event.preventDefault()
                      goNext()
                    }
                  }}
                  rows={2}
                  autoFocus
                  placeholder="Type your answer..."
                  className="w-full resize-none rounded-2xl bg-white/[0.04] px-4 py-3 text-[14px] leading-6 text-[var(--vs-text-primary)] outline-none ring-1 ring-white/[0.08] placeholder:text-[var(--vs-text-tertiary)] focus:ring-[var(--vs-accent)]/40"
                />
              ) : null}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-end gap-2">
            {currentQuestion.allow_skip !== false ? (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={skipQuestion}
                className="cursor-pointer rounded-full bg-white/[0.08] px-5 py-2 text-[13px] font-medium text-[var(--vs-text-secondary)] transition hover:bg-white/[0.12] hover:text-[var(--vs-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Skip
              </button>
            ) : null}
            {hasSelection ? (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={goNext}
                className="primary-btn inline-flex cursor-pointer items-center gap-1.5 px-5 py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pageIndex + 1 >= total ? 'Submit' : 'Continue'}
                <ArrowRight size={14} strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

export default HilQuestionCard
