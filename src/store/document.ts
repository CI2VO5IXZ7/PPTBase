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
  outlineUrl: string
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
    outlineUrl: '',
    lastRemoteSummary: [],
  }),

  getters: {
    readonly(state) {
      return state.role === 'view'
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
    setOutlineInfo(hasOutline: boolean, outlineUrl: string) {
      this.hasOutline = hasOutline
      this.outlineUrl = outlineUrl
    },
    setLastRemoteSummary(summary: string[]) {
      this.lastRemoteSummary = summary
    },
  },
})
