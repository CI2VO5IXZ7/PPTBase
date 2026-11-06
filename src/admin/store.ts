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

// loadUsers 并发序号：筛选/翻页快速连发时，丢弃过期响应，防止旧闭包覆盖新选择
let usersReqSeq = 0

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

    // 筛选/搜索/页控统一入口：query/statusFilter 变更重置页码与详情选择，再统一拉取
    async setFilters(patch: { query?: string, statusFilter?: 'all' | 'active' | 'disabled' }) {
      if (patch.query !== undefined) this.query = patch.query.trim()
      if (patch.statusFilter !== undefined) this.statusFilter = patch.statusFilter
      this.page = 1
      this.selectedUserId = null
      this.detailUser = null
      this.keys = []
      await this.loadUsers()
    },

    async loadUsers() {
      const seq = ++usersReqSeq
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
        if (seq !== usersReqSeq) return // 过期响应：不覆盖更新的状态
        this.users = res.users
        this.usersTotal = res.total
        // 已选用户如在新数据中出现则同步详情对象；跨页选中保留详情，不清空
        const fresh = res.users.find(u => u.id === this.detailUser?.id)
        if (fresh) this.detailUser = fresh
        if (!this.detailUser && res.users.length) {
          await this.selectUser(res.users[0].id)
        }
        else if (!res.users.length && !this.detailUser) {
          this.keys = []
        }
      }
      finally {
        // 失败时保留上次真实数据（users/usersTotal 不动），不制造半状态
        if (seq === usersReqSeq) this.usersLoading = false
      }
    },

    async setPage(page: number) {
      this.page = page
      await this.loadUsers()
    },

    async selectUser(id: string) {
      if (this.detailUser?.id === id) return
      this.selectedUserId = id
      this.detailUser = this.users.find(u => u.id === id) ?? this.detailUser
      await this.loadKeys()
    },

    async loadKeys() {
      const userId = this.detailUser?.id
      if (!userId) {
        this.keys = []
        return
      }
      this.keysLoading = true
      try {
        const res = await api<{ keys: AdminKey[] }>(`/users/${userId}/keys`)
        // 期间详情被切换则丢弃本次结果
        if (this.detailUser?.id === userId) this.keys = res.keys
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
      // 快照 detailUser.id：创建/刷新期间翻页或换选不影响本次 Key 落属用户
      const userId = this.detailUser?.id
      if (!userId) throw new Error('未选择用户')
      const res = await api<{ id: string, key?: string, prefix: string, duplicated: boolean }>(
        `/users/${userId}/keys`,
        { method: 'POST', body: { label, requestId } },
      )
      // 明文 Key 一旦返回就必须能展示：列表/概览刷新失败只降级为告警，不吞掉创建成功。
      // 先刷用户列表再刷 keys：选中用户在当前页外时并行 loadKeys 可能拿到旧 detail 竞态，
      // 导致 keys 停留在旧空状态；串行后仅当详情仍是本操作用户才刷其 Key 列表。
      const settled = await Promise.allSettled([
        (async () => {
          try {
            await this.loadUsers()
          }
          finally {
            // 即使用户列表刷新失败，也刷新本操作用户的 keys——创建结果必须可见
            if (this.detailUser?.id === userId) await this.loadKeys()
          }
        })(),
        this.loadOverview(),
      ])
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
      // 详情面板立即反映新状态（停用后立即显示「恢复」而非残留操作按钮）
      if (this.detailUser?.id === userId) {
        this.detailUser = { ...this.detailUser, status: res.status as 'active' | 'disabled' }
        await this.loadKeys()
      }
      // 筛选列表刷新失败不清详情——detailUser 是本次操作的真实快照
      await Promise.allSettled([this.loadUsers(), this.loadOverview()])
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
