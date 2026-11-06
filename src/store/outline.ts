// 大纲工作区状态：与 PPT version 完全分离
import { defineStore } from 'pinia'
import type { OutlineThread } from '@/types/outline'
import type { OutlineState } from '@/services/outline'

export type OutlineSaveStatus = 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict'

export interface OutlineStoreState {
  docId: string
  role: 'owner' | 'edit' | 'view' | ''
  version: number
  contentVersion: number
  content: Record<string, unknown> | null
  threads: OutlineThread[]
  status: OutlineState['status'] | null
  saveStatus: OutlineSaveStatus
  // 冲突/失败时保留的本地未提交 steps，供用户恢复
  pendingSteps: Record<string, unknown>[]
  conflictRemote: { version: number } | null
  lastError: string
}

export const useOutlineStore = defineStore('outline', {
  state: (): OutlineStoreState => ({
    docId: '',
    role: '',
    version: 0,
    contentVersion: 0,
    content: null,
    threads: [],
    status: null,
    saveStatus: 'saved',
    pendingSteps: [],
    conflictRemote: null,
    lastError: '',
  }),
  getters: {
    readonly(state) {
      return state.role === 'view'
    },
    openThreads(state) {
      return state.threads.filter(t => t.status === 'open').length
    },
    submittedDirty(state) {
      // 最新已提交/确认版本与当前版本是否偏离
      return state.status?.approval ? !state.status.approval.valid : false
    },
  },
  actions: {
    load(state: OutlineState) {
      this.docId = state.docId
      this.role = state.role
      this.version = state.version
      this.contentVersion = state.contentVersion
      this.content = state.content
      this.threads = state.threads
      this.status = state.status
      this.saveStatus = 'saved'
      this.conflictRemote = null
    },
    setVersions(version: number, contentVersion: number) {
      this.version = version
      this.contentVersion = contentVersion
    },
    setSaveStatus(status: OutlineSaveStatus) {
      this.saveStatus = status
    },
    queueSteps(steps: Record<string, unknown>[]) {
      this.pendingSteps.push(...steps)
      if (this.saveStatus === 'saved') this.saveStatus = 'dirty'
    },
    clearPending(count: number) {
      this.pendingSteps.splice(0, count)
    },
    setConflict(remoteVersion: number) {
      this.saveStatus = 'conflict'
      this.conflictRemote = { version: remoteVersion }
    },
  },
})
