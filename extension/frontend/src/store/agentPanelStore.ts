import { create } from 'zustand'
import { type AgentPanelTarget } from '../lib/subagentTrace'

interface AgentPanelStore {
  open: boolean
  target: AgentPanelTarget | null
  openPanel: (target: AgentPanelTarget) => void
  closePanel: () => void
}

export const useAgentPanelStore = create<AgentPanelStore>((set) => ({
  open: false,
  target: null,
  openPanel: (target) => set({ open: true, target }),
  closePanel: () => set({ open: false, target: null }),
}))
