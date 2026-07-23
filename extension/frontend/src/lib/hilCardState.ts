import { type SessionEvent } from '../store/chatStore'
import { type HilAnswer, type HilCardState, type HilQuestion } from './hilTypes'

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const parseQuestions = (value: unknown): HilQuestion[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const questions: HilQuestion[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) {
      continue
    }
    const questionId = record.question_id
    const prompt = record.prompt
    const options = record.options
    if (typeof questionId !== 'string' || typeof prompt !== 'string' || !Array.isArray(options)) {
      continue
    }
    const parsedOptions = options
      .map((option) => {
        const opt = asRecord(option)
        if (!opt || typeof opt.id !== 'string' || typeof opt.label !== 'string') {
          return null
        }
        return { id: opt.id, label: opt.label }
      })
      .filter((option): option is { id: string; label: string } => option !== null)

    if (parsedOptions.length < 2) {
      continue
    }

    questions.push({
      question_id: questionId,
      prompt,
      options: parsedOptions,
      allow_custom: record.allow_custom !== false,
      allow_skip: record.allow_skip !== false,
    })
  }

  return questions
}

const parseAnswers = (value: unknown): HilAnswer[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const answers: HilAnswer[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record || typeof record.question_id !== 'string' || typeof record.type !== 'string') {
      continue
    }
    if (record.type === 'option' && typeof record.option_id === 'string') {
      answers.push({
        question_id: record.question_id,
        type: 'option',
        option_id: record.option_id,
      })
    } else if (record.type === 'custom' && typeof record.text === 'string') {
      answers.push({
        question_id: record.question_id,
        type: 'custom',
        text: record.text,
      })
    } else if (record.type === 'skipped') {
      answers.push({ question_id: record.question_id, type: 'skipped' })
    }
  }
  return answers
}

export const cardFromHilQuestionEvent = (event: SessionEvent): HilCardState | null => {
  if (event.type !== 'hil_question') {
    return null
  }
  const metadata = event.metadata ?? {}
  const hilSessionId =
    typeof metadata.hil_session_id === 'string' ? metadata.hil_session_id : event.id
  const questions = parseQuestions(metadata.questions)
  if (questions.length === 0) {
    return null
  }
  return {
    hilSessionId,
    agentLabel: typeof metadata.agent_label === 'string' ? metadata.agent_label : 'Agent',
    questions,
    status: 'pending',
  }
}

export const applyHilResolvedEvent = (
  cards: Map<string, HilCardState>,
  event: SessionEvent
): HilCardState | null => {
  if (event.type !== 'hil_resolved') {
    return null
  }
  const metadata = event.metadata ?? {}
  const hilSessionId =
    typeof metadata.hil_session_id === 'string' ? metadata.hil_session_id : ''
  if (!hilSessionId) {
    return null
  }
  const existing = cards.get(hilSessionId)
  if (!existing) {
    return null
  }
  const updated: HilCardState = {
    ...existing,
    status: 'resolved',
    answers: parseAnswers(metadata.answers),
  }
  cards.set(hilSessionId, updated)
  return updated
}

export const labelForHilAnswer = (
  question: HilQuestion | undefined,
  answer: HilAnswer | undefined
): string => {
  if (!answer) {
    return '—'
  }
  if (answer.type === 'skipped') {
    return 'Skipped'
  }
  if (answer.type === 'custom') {
    return answer.text.trim() || 'Custom answer'
  }
  const option = question?.options.find((entry) => entry.id === answer.option_id)
  return option?.label ?? answer.option_id
}
