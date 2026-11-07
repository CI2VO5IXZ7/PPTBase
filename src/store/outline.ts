// 大纲工作区状态：与 PPT version 完全分离
import { defineStore } from 'pinia'
import type { OutlineSubmission, OutlineThread } from '@/types/outline'
import type { OutlineState } from '@/services/outline'

export type OutlineSaveStatus = 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict'

// 草稿在 sessionStorage 的兜底副本（按 docId）：整页跳转/刷新后内存 localDraft 丢失时可恢复
const draftKey = (docId: string) => `PPTIST_OUTLINE_DRAFT_${docId}`

export interface OutlineStoreState {
  docId: string
  role: 'owner' | 'edit' | 'view' | ''
  version: number
  contentVersion: number
  content: Record<string, unknown> | null
  threads: OutlineThread[]
  status: OutlineState['status'] | null
  saveStatus: OutlineSaveStatus
  // 冲突时保留的本地草稿（正文快照 + 未提交 steps），用户显式取回/放弃前不清空
  localDraft: { content: Record<string, unknown>, steps: Record<string, unknown>[], savedAt: number } | null
  conflictRemote: { version: number, contentVersion: number } | null
  // 反馈提交历史（GET /feedback 拉取）
  submissions: OutlineSubmission[]
  uploadsPending: number
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
    localDraft: null,
    conflictRemote: null,
    submissions: [],
    uploadsPending: 0,
    lastError: '',
  }),
  getters: {
    readonly(state) {
      // 失败即关闭：未初始化 role 一律视为只读
      return state.role !== 'owner' && state.role !== 'edit'
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
      // 内存无草稿时从 sessionStorage 兜底恢复（整页跳转后仍有入口取回）
      if (!this.localDraft && state.docId) {
        try {
          const raw = sessionStorage.getItem(draftKey(state.docId))
          if (raw) this.localDraft = JSON.parse(raw)
        }
        catch { /* 损坏数据忽略 */ }
      }
    },
    setVersions(version: number, contentVersion: number) {
      this.version = version
      this.contentVersion = contentVersion
    },
    setSaveStatus(status: OutlineSaveStatus) {
      this.saveStatus = status
    },
    setSubmissions(submissions: OutlineSubmission[]) {
      this.submissions = submissions
    },
    setUploadsPending(n: number) {
      this.uploadsPending = n
    },
    // 冲突保护：保存本地正文与未提交 steps；任何时刻可显式取回/放弃
    stashDraft(content: Record<string, unknown>, steps: Record<string, unknown>[]) {
      this.localDraft = { content, steps, savedAt: Date.now() }
      if (this.docId) {
        try { sessionStorage.setItem(draftKey(this.docId), JSON.stringify(this.localDraft)) }
        catch { /* 存储不可用/超限不阻塞同步流程 */ }
      }
    },
    dropDraft() {
      this.localDraft = null
      if (this.docId) sessionStorage.removeItem(draftKey(this.docId))
    },
    setConflict(remoteVersion: number, contentVersion: number) {
      this.saveStatus = 'conflict'
      this.conflictRemote = { version: remoteVersion, contentVersion }
    },
  },
})
