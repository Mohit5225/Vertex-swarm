export interface HilOption {
  id: string
  label: string
}

export interface HilQuestion {
  question_id: string
  prompt: string
  options: HilOption[]
  allow_custom?: boolean
  allow_skip?: boolean
}

export type HilAnswer =
  | { question_id: string; type: 'option'; option_id: string }
  | { question_id: string; type: 'custom'; text: string }
  | { question_id: string; type: 'skipped' }

export interface HilCardState {
  hilSessionId: string
  agentLabel: string
  context?: string
  questions: HilQuestion[]
  status: 'pending' | 'resolved'
  answers?: HilAnswer[]
}
