// 前端 admin store 逻辑回归（无 UI）：筛选/分页/竞态/快照语义。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { setCsrfToken } from '../../src/admin/api'
import { buildQuotaPatch, quotaBaseline } from '../../src/admin/quotaPatch'
import { useAdminStore } from '../../src/admin/store'
import type { AdminUser } from '../../src/admin/types'

interface RecordedReq { url: string, method: string, body?: unknown }

const USER = (id: string, status: 'active' | 'disabled' = 'active'): AdminUser => ({
  id, name: `u-${id}`, note: null, status, createdAt: 0,
  docs: 0, totalKeys: 0, activeKeys: 0, lastUsedAt: null, keyPrefix: null,
  quota: { docs: 100, docMb: 10, exportsPerDay: 200 },
  quotaCustom: { docs: null, docMb: null, exportsPerDay: null },
})

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let requests: RecordedReq[] = []
let handler: (req: RecordedReq) => Response | Promise<Response>

beforeEach(() => {
  requests = []
  handler = () => jsonRes({})
  ;(globalThis as { fetch?: unknown }).fetch = (input: string | URL, init?: { method?: string, body?: unknown }) => {
    const req: RecordedReq = {
      url: typeof input === 'string' ? input : (input as URL).toString(),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    requests.push(req)
    return handler(req)
  }
  setActivePinia(createPinia())
  setCsrfToken('t')
})

afterEach(() => {
})

describe('admin store：筛选/分页统一状态', () => {
  it('setFilters 变更筛选时重置 page/选择/详情并带参拉取', async () => {
    const store = useAdminStore()
    handler = req => {
      if (req.url.includes('/users?')) return jsonRes({ users: [USER('a')], total: 1, page: 1, pageSize: 20 })
      if (req.url.includes('/keys')) return jsonRes({ keys: [] })
      return jsonRes({})
    }
    await store.setFilters({ statusFilter: 'disabled' })
    expect(store.page).toBe(1)
    const usersReq = requests.find(r => r.url.includes('/users?'))
    expect(usersReq?.url).toContain('status=disabled')
    // 自动选中首个用户
    expect(store.detailUser?.id).toBe('a')

    store.page = 3
    await store.setFilters({ query: '  bob ' })
    expect(store.page).toBe(1)
    expect(store.query).toBe('bob')
    expect(requests.filter(r => r.url.includes('/users?')).at(-1)?.url).toContain('q=bob')
  })

  it('并发翻页时过期响应被丢弃，不覆盖新选择', async () => {
    const store = useAdminStore()
    let release!: () => void
    handler = req => {
      if (!req.url.includes('/users?')) return jsonRes({ keys: [] })
      if (req.url.includes('page=1')) {
        // 慢请求：等手动释放
        return new Promise<Response>(res => {
          release = () => res(jsonRes({ users: [USER('stale')], total: 1, page: 1, pageSize: 20 }))
        })
      }
      return jsonRes({ users: [USER('fresh')], total: 2, page: 2, pageSize: 20 })
    }
    const p1 = store.loadUsers() // page=1 慢
    await store.setPage(2) // page=2 快，先完成
    expect(store.users[0]?.id).toBe('fresh')
    release!()
    await p1
    expect(store.users[0]?.id).toBe('fresh') // 旧响应不覆盖
  })

  it('loadUsers 失败保留上次真实数据，不产生半状态', async () => {
    const store = useAdminStore()
    let fail = false
    handler = req => {
      if (req.url.includes('/users?')) {
        if (fail) return jsonRes({ error: 'boom' }, 500)
        return jsonRes({ users: [USER('a')], total: 1, page: 1, pageSize: 20 })
      }
      return jsonRes({ keys: [] })
    }
    await store.loadUsers()
    expect(store.users[0]?.id).toBe('a')
    fail = true
    await expect(store.loadUsers()).rejects.toThrow()
    expect(store.users[0]?.id).toBe('a')
    expect(store.usersTotal).toBe(1)
    expect(store.usersLoading).toBe(false)
  })
})

describe('admin store：操作快照语义', () => {
  function seedStore() {
    const store = useAdminStore()
    store.detailUser = USER('u1')
    store.selectedUserId = 'u1'
    store.users = [USER('u1')] as never
    return store
  }

  it('createKey 用调用时快照的 userId；后续刷新失败仍返回结果', async () => {
    const store = seedStore()
    handler = req => {
      if (req.method === 'POST' && req.url.includes('/keys')) {
        return jsonRes({ id: 'k1', key: 'pk_x', prefix: 'pk_x', duplicated: false })
      }
      if (req.url.includes('/overview')) return jsonRes({ error: 'boom' }, 500)
      if (req.url.includes('/users?')) return jsonRes({ users: [USER('u1')], total: 1, page: 1, pageSize: 20 })
      return jsonRes({ keys: [] })
    }
    const res = await store.createKey(null, 'rid-1')
    const post = requests.find(r => r.method === 'POST' && r.url.includes('/keys'))
    expect(post?.url).toContain('/users/u1/keys')
    expect(post?.body).toMatchObject({ requestId: 'rid-1' })
    expect(res.refreshFailed).toBe(true)
    expect(res.key).toBe('pk_x') // 创建成功不被刷新失败吞掉
  })

  it('createKey：选中用户在当前页外时 keys 仍刷新为该用户新 Key 列表', async () => {
    const store = useAdminStore()
    // u-off 不在当前 users 页里（跨页选中/新建用户直选场景）
    store.detailUser = USER('u-off')
    store.selectedUserId = 'u-off'
    store.users = [USER('p2-a'), USER('p2-b')] as never
    store.keys = []
    handler = req => {
      if (req.method === 'POST' && req.url.includes('/keys')) {
        return jsonRes({ id: 'k9', key: 'pk_x', prefix: 'pk_x', duplicated: false })
      }
      if (req.url.endsWith('/keys') && req.method === 'GET') {
        const uid = req.url.match(/\/users\/([^/]+)\/keys/)?.[1]
        if (uid !== 'u-off') return jsonRes({ keys: [] })
        return jsonRes({ keys: [{ id: 'k9', label: 'Agent-X', prefix: 'pk_x', revokedAt: null, createdAt: 1, lastUsedAt: null }] })
      }
      if (req.url.includes('/overview')) return jsonRes({})
      if (req.url.includes('/users?')) return jsonRes({ users: [USER('p2-a'), USER('p2-b')], total: 2, page: 2, pageSize: 20 })
      return jsonRes({})
    }
    await store.createKey('Agent-X', 'rid-2')
    // 页外选中用户创建后，keys 必须立即是新 Key 列表而非旧空值
    expect(store.keys.map(k => k.label)).toEqual(['Agent-X'])
    expect(store.detailUser?.id).toBe('u-off')
  })

  it('createKey：创建期间详情被切走则不把旧用户 keys 写入新详情', async () => {
    const store = useAdminStore()
    store.detailUser = USER('u-old')
    store.selectedUserId = 'u-old'
    store.keys = []
    handler = req => {
      if (req.method === 'POST' && req.url.includes('/keys')) {
        // 模拟创建响应到达前用户已切到 u-new
        store.detailUser = USER('u-new')
        return jsonRes({ id: 'k9', key: 'pk_x', prefix: 'pk_x', duplicated: false })
      }
      if (req.url.endsWith('/keys') && req.method === 'GET') {
        return jsonRes({ keys: [{ id: 'kX', label: 'Wrong-User-Key', prefix: 'pk_x', revokedAt: null, createdAt: 1, lastUsedAt: null }] })
      }
      if (req.url.includes('/overview')) return jsonRes({})
      if (req.url.includes('/users?')) return jsonRes({ users: [USER('u-new')], total: 1, page: 1, pageSize: 20 })
      return jsonRes({})
    }
    await store.createKey(null, 'rid-3')
    expect(store.detailUser?.id).toBe('u-new')
    // 新详情面板不应展示 u-old 的 Key
    expect(store.keys.some(k => k.label === 'Wrong-User-Key')).toBe(false)
  })

  it('createUser 重置筛选/搜索并直选新用户', async () => {
    const store = useAdminStore()
    store.query = 'zzz'
    store.statusFilter = 'disabled'
    store.page = 4
    handler = req => {
      if (req.method === 'POST' && req.url.endsWith('/users')) {
        return jsonRes({ user: USER('new1') })
      }
      if (req.url.includes('/users?')) return jsonRes({ users: [USER('new1')], total: 1, page: 1, pageSize: 20 })
      if (req.url.includes('/overview')) return jsonRes({})
      return jsonRes({ keys: [] })
    }
    const user = await store.createUser('new1', null)
    expect(store.query).toBe('')
    expect(store.statusFilter).toBe('all')
    expect(store.page).toBe(1)
    expect(store.detailUser?.id).toBe('new1')
    expect(store.selectedUserId).toBe(user.id)
  })

  it('setUserStatus：keys 刷新 5xx 仍返回成功并标记 refreshFailed', async () => {
    const store = seedStore()
    handler = req => {
      if (req.url.includes('/status')) return jsonRes({ ok: true, status: 'disabled' })
      if (req.url.endsWith('/keys') && req.method === 'GET') return jsonRes({ error: 'boom' }, 500)
      if (req.url.includes('/users?')) return jsonRes({ users: [USER('u1', 'disabled')], total: 1, page: 1, pageSize: 20 })
      if (req.url.includes('/overview')) return jsonRes({})
      return jsonRes({})
    }
    const res = await store.setUserStatus('u1', 'disabled')
    expect(res.ok).toBe(true) // POST 已成功，刷新失败不回滚
    expect(res.refreshFailed).toBe(true)
    expect(store.detailUser?.status).toBe('disabled')
  })

  it('setFilters 拉取失败保留旧列表/详情/keys', async () => {
    const store = useAdminStore()
    let fail = false
    handler = req => {
      if (req.url.includes('/users?')) {
        if (fail) return jsonRes({ error: 'boom' }, 500)
        return jsonRes({ users: [USER('a')], total: 1, page: 1, pageSize: 20 })
      }
      if (req.url.endsWith('/keys') && req.method === 'GET') {
        return jsonRes({ keys: [{ id: 'k1', label: 'Keep-Me', prefix: 'pk_x', revokedAt: null, createdAt: 1, lastUsedAt: null }] })
      }
      return jsonRes({})
    }
    await store.loadUsers()
    expect(store.detailUser?.id).toBe('a')
    expect(store.keys[0]?.label).toBe('Keep-Me')

    fail = true
    await expect(store.setFilters({ statusFilter: 'disabled' })).rejects.toThrow()
    // 失败不得清空旧列表/选择/详情/keys
    expect(store.users[0]?.id).toBe('a')
    expect(store.detailUser?.id).toBe('a')
    expect(store.keys[0]?.label).toBe('Keep-Me')
    expect(store.statusFilter).toBe('disabled') // 筛选意图保留，用户可重试
  })

  it('setUserStatus 立即更新 detailUser 状态（停用后详情可恢复）', async () => {
    const store = seedStore()
    handler = req => {
      if (req.url.includes('/status')) return jsonRes({ ok: true, status: 'disabled' })
      if (req.url.includes('/users?')) return jsonRes({ users: [], total: 0, page: 1, pageSize: 20 })
      if (req.url.includes('/overview')) return jsonRes({})
      return jsonRes({ keys: [] })
    }
    await store.setUserStatus('u1', 'disabled')
    expect(store.detailUser?.status).toBe('disabled')
    expect(store.detailUser?.id).toBe('u1') // 详情保留，可执行恢复
  })
})

// 配额补丁：baseline 保留 custom 原值（null=继承），不回填 effective
describe('quotaPatch：null 继承语义', () => {
  it('quotaBaseline 保留 custom 原值（含 null），不用 effective 回填', () => {
    const base = quotaBaseline({ docs: null, docMb: 25, exportsPerDay: null })
    expect(base).toEqual({ docs: null, docMb: 25, exportsPerDay: null })
  })

  it('未改动继承字段不产生 patch；显式填默认数字→显式值；清空→null 恢复继承', () => {
    const custom = { docs: null, docMb: 25, exportsPerDay: null }
    const base = quotaBaseline(custom)
    // 表单=custom 原值：全部未动 → 空 patch（继承不误写 override）
    expect(buildQuotaPatch({ docs: null, docMb: 25, exportsPerDay: null }, base)).toEqual({})
    // 继承字段输入等于全局默认 100 → 显式 override 为 100（不再是 null）
    expect(buildQuotaPatch({ docs: 100, docMb: 25, exportsPerDay: null }, base)).toEqual({ quotaDocs: 100 })
    // 自定义字段清空 → 显式 null 恢复继承
    expect(buildQuotaPatch({ docs: null, docMb: null, exportsPerDay: null }, base)).toEqual({ quotaDocMb: null })
    // 三项全清 → 全部显式 null（恢复默认操作）
    expect(buildQuotaPatch({ docs: null, docMb: null, exportsPerDay: null }, { docs: 5, docMb: 25, exportsPerDay: 50 })).toEqual({
      quotaDocs: null, quotaDocMb: null, quotaExportsPerDay: null,
    })
  })
})
