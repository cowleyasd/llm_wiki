import { create } from "zustand"
import type { DeepWikiQueryRecord } from "@/lib/deepwiki-channel"

interface DeepWikiState {
  records: DeepWikiQueryRecord[]
  panelOpen: boolean
  setRecords: (records: DeepWikiQueryRecord[]) => void
  addRecord: (record: DeepWikiQueryRecord) => void
  updateRecord: (id: string, patch: Partial<DeepWikiQueryRecord>) => void
  setPanelOpen: (open: boolean) => void
}

export const useDeepWikiStore = create<DeepWikiState>((set) => ({
  records: [],
  panelOpen: false,
  setRecords: (records) => set({ records }),
  addRecord: (record) => set((s) => ({ records: [...s.records, record], panelOpen: true })),
  updateRecord: (id, patch) =>
    set((s) => ({ records: s.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}))
