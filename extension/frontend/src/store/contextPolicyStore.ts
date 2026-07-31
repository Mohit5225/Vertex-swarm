import { create } from 'zustand'
import type { ContextPolicyData } from '../lib/contextPolicyTypes'
import { DEFAULT_CONTEXT_POLICY } from '../lib/contextPolicy'

interface ContextPolicyState {
  policy: ContextPolicyData
  setPolicy: (policy: ContextPolicyData) => void
}

export const useContextPolicyStore = create<ContextPolicyState>((set) => ({
  policy: DEFAULT_CONTEXT_POLICY,
  setPolicy: (policy) => set({ policy }),
}))
