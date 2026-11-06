import { defineStore } from 'pinia'

import { api, onUnauthorized, setCsrfToken } from './api'
import type { AdminKey, AdminUser, Overview } from './types'

interface AdminState {
  ready: boolean
  authed: boolean
  sessionExpiresAt: number | null
  overview: Overview | null
  users: AdminUser[]
  usersTotal: number
  page: number
  pageSize: number
  usersLoading: boolean
  query: string
  statusFilter: 'all' | 'active' | 'disabled'
  selectedUserId: string | null
  detailUser: AdminUser | null
  keys: AdminKey[]
  keysLoading: boolean
}

export const useAdminStore = defineStore('admin', {
  state: (): AdminState => ({
    ready: false,
    authed: false,
    sessionExpiresAt: null,
    overview: null,
    users: [],
    usersTotal: 0,
    page: 1,
    pageSize: 20,
    usersLoading: false,
    query: '',
    statusFilter: 'all',
    selectedUserId: null,
    detailUser: null,
    keys: [],
    keysLoading: false,
  }),

  actions: {
    bind() {
      onUnauthorized(() => {
        this.authed = false
        this.users = []
        this.keys = []
        this.selectedUserId = null
        this.detailUser = null
      })
    },

    async checkSession() {
      try {
        const res = await api<{ authenticated: boolean, csrfToken: string, expiresAt: number }>('/session')
        setCsrfToken(res.csrfToken)
        this.sessionExpiresAt = res.expiresAt
        this.authed = true
        this.ready = true
        // 数据加载失败只提示、不影响已建立的会话（401 由 api 层统一打回登录页）
        this.refresh().catch(() => {})
        return
      }
      catch {
        this.authed = false
      }
      this.ready = true
    },

    async login(password: string) {
      const res = await api<{ csrfToken: string, expiresAt: number }>('/login', {
        method: 'POST',
        body: { password },
      })
      setCsrfToken(res.csrfToken)
      this.sessionExpiresAt = res.expiresAt
      this.authed = true
      await this.refresh()
    },

    async logout() {
      try {
        await api('/logout', { method: 'POST', body: {} })
      }
      finally {
        this.authed = false
      }
    },

    async refresh() {
      await Promise.all([this.loadOverview(), this.loadUsers()])
    },

    async loadOverview() {
      this.overview = await api<Overview>('/overview')
    },

    async loadUsers() {
      this.usersLoading = true
      try {
        const res = await api<{ users: AdminUser[], total: number, page: number, pageSize: number }>('/users', {
          query: {
            q: this.query || undefined,
            status: this.statusFilter === 'all' ? undefined : this.statusFilter,
            page: String(this.page),
            pageSize: String(this.pageSize),
          },
        })
        this.users = res.users
        this.usersTotal = res.total
        // 已选用户如在新数据中出现则同步详情对象（未出现的跨页选中保留）
        const fresh = res.users.find(u => u.id === this.detailUser?.id)
        if (fresh) this.detailUser = fresh
        if (this.selectedUserId && !res.users.some(u => u.id === this.selectedUserId)) {
          this.selectedUserId = null
        }
        if (!this.detailUser && res.users.length) {
          await this.selectUser(res.users[0].id)
        }
        else if (!res.users.length && !this.detailUser) {
          this.keys = []
        }
      }
      finally {
        this.usersLoading = false
      }
    },

    async setPage(page: number) {
      this.page = page
      await this.loadUsers()
    },

    async selectUser(id: string) {
      if (this.selectedUserId === id) return
      this.selectedUserId = id
      this.detailUser = this.users.find(u => u.id === id) ?? this.detailUser
      await this.loadKeys()
    },

    async loadKeys() {
      if (!this.selectedUserId) {
        this.keys = []
        return
      }
      this.keysLoading = true
      try {
        const res = await api<{ keys: AdminKey[] }>(`/users/${this.selectedUserId}/keys`)
        this.keys = res.keys
      }
      finally {
        this.keysLoading = false
      }
    },

    async createUser(name: string, note: string | null) {
      const res = await api<{ user: AdminUser }>('/users', {
        method: 'POST',
        body: { name, note },
      })
      // 新用户是 active：若在「已停用」筛选/搜索下创建，会被过滤掉造成空详情——
      // 清掉筛选并回到第一页再刷新，保证新用户可见可选
      this.statusFilter = 'all'
      this.query = ''
      this.page = 1
      await Promise.allSettled([this.loadUsers(), this.loadOverview()])
      // 无论新用户在不在当前页，详情都直接选中它，可立即创建 Key
      this.detailUser = res.user
      this.selectedUserId = res.user.id
      this.keys = []
      await this.loadKeys()
      return res.user
    },

    async createKey(label: string | null, requestId: string) {
      const res = await api<{ id: string, key?: string, prefix: string, duplicated: boolean }>(
        `/users/${this.detailUser!.id}/keys`,
        { method: 'POST', body: { label, requestId } },
      )
      // 明文 Key 一旦返回就必须能展示：列表/概览刷新失败只降级为告警，不吞掉创建成功
      const settled = await Promise.allSettled([this.loadKeys(), this.loadOverview(), this.loadUsers()])
      const refreshFailed = settled.some(r => r.status === 'rejected')
      return { ...res, refreshFailed }
    },

    async revokeKey(keyId: string) {
      const res = await api<{ ok: boolean, alreadyRevoked: boolean }>(`/keys/${keyId}/revoke`, {
        method: 'POST',
        body: {},
      })
      await Promise.all([this.loadKeys(), this.loadOverview()])
      return res
    },

    async setUserStatus(userId: string, status: 'active' | 'disabled') {
      const res = await api<{ ok: boolean, status: string }>(`/users/${userId}/status`, {
        method: 'POST',
        body: { status },
      })
      await Promise.all([this.loadUsers(), this.loadOverview()])
      return res
    },

    async saveQuota(userId: string, patch: { quotaDocs?: number | null, quotaDocMb?: number | null, quotaExportsPerDay?: number | null }) {
      const res = await api<{ user: AdminUser }>(`/users/${userId}`, {
        method: 'PATCH',
        body: patch as Record<string, unknown>,
      })
      await this.loadUsers()
      this.detailUser = res.user
      return res.user
    },
  },
})
