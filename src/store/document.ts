import { defineStore } from 'pinia'

export type DocRole = 'owner' | 'edit' | 'view' | ''
export type SaveStatus = 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict'

export interface DocumentState {
  docId: string
  token: string
  role: DocRole
  version: number
  saveStatus: SaveStatus
  viewUrl: string
  hasOutline: boolean
  lastRemoteSummary: string[]
}

export const useDocumentStore = defineStore('document', {
  state: (): DocumentState => ({
    docId: '',
    token: '',
    role: '',
    version: 0,
    saveStatus: 'saved',
    viewUrl: '',
    hasOutline: false,
    lastRemoteSummary: [],
  }),

  getters: {
    readonly(state) {
      return state.role === 'view'
    },
    // 大纲页签链接按当前凭证即时构造；令牌只在内存，不落存储
    outlineUrl(state) {
      if (!state.docId || !state.hasOutline) return ''
      const mode = state.role === 'view' ? '&mode=view' : ''
      return `/?doc=${state.docId}&tab=outline${mode}#t=${state.token}`
    },
  },

  actions: {
    setCredentials(docId: string, token: string) {
      this.docId = docId
      this.token = token
    },
    setRole(role: DocRole) {
      this.role = role
    },
    setVersion(version: number) {
      this.version = version
    },
    setSaveStatus(saveStatus: SaveStatus) {
      this.saveStatus = saveStatus
    },
    setViewUrl(viewUrl: string) {
      this.viewUrl = viewUrl
    },
    setHasOutline(hasOutline: boolean) {
      this.hasOutline = hasOutline
    },
    setLastRemoteSummary(summary: string[]) {
      this.lastRemoteSummary = summary
    },
  },
})
