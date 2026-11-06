// 前端 admin store 逻辑回归（无 UI）：筛选/分页/竞态/快照语义。
// 通过 stub fetch + window.location.origin 在 node 环境跑真实 Pinia store。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { setCsrfToken } from '../../src/admin/api'
import { useAdminStore } from '../../src/admin/store'

interface RecordedReq { url: string, method: string, body?: unknown }

const USER = (id: string, status = 'active') => ({
  id, name: `u-${id}`, note: null, status,
  docs: 0, docsMb: 0, exportsToday: 0,
  quotaDocs: null, quotaDocMb: null, quotaExportsPerDay: null,
  effQuotaDocs: 100, effQuotaDocMb: 10, effQuotaExportsPerDay: 200,
  activeKeys: 0, totalKeys: 0, createdAt: 0, lastKeyUsedAt: null,
})

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let requests: RecordedReq[] = []
let handler: (req: RecordedReq) => Response | Promise<Response>

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { location: { origin: 'http://admin.test' } }
  requests = []
  handler = () => jsonRes({})
  ;(globalThis as { fetch?: unknown }).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
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
  delete (globalThis as { window?: unknown }).window
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
    let release!: (r: Response) => void
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
    store.detailUser = USER('u1') as never
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
