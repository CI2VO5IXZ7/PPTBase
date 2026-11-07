// 大纲 REST 路由：鉴权/角色判断在这里，领域写入逻辑全部在 outline/service.ts。
// 角色语义：owner=API Key(Agent)，edit=文档编辑令牌(网页用户)，view=只读令牌。

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'

import { docLinks, outlineLinks, resolveDocAccess, type DocAccess } from '../auth'
import type { AppConfig } from '../config'
import type { Db, DocumentRow } from '../db'
import type { DocService } from '../docs/service'
import { AppError } from '../errors'
import type { OutlineService } from '../outline/service'
import {
  outlineApprovalSchema,
  outlineCompleteSchema,
  outlineConfirmTicketSchema,
  outlineFeedbackSchema,
  outlineInitSchema,
  outlineOpsSchema,
  outlinePatchSchema,
  parseBody,
} from '../outline/schema'

interface OutlineRoutesDeps {
  db: Db
  config: AppConfig
  service: OutlineService
  docService: DocService
}

function docId(req: FastifyRequest): string {
  return (req.params as { id: string }).id
}

// 一次性确认凭证请求头：缺凭证直接 403（编辑令牌本体不是确认凭证）
function confirmToken(req: FastifyRequest): string {
  const header = req.headers['x-confirm-token']
  const token = Array.isArray(header) ? header[0] : header
  if (!token) throw AppError.forbidden('确认/撤销确认需要一次性确认凭证（用户动作）')
  return token
}

// 网页确认会话请求头：原样透传给服务层校验（缺会话时服务层报 403，
// 保持「无大纲 404 先于会话 403」的既有错误顺序）
function confirmSessionHeader(req: FastifyRequest): string | undefined {
  const header = req.headers['x-confirm-session']
  const token = Array.isArray(header) ? header[0] : header
  return token || undefined
}

// 网页确认会话只签发给真实浏览器页面：同源 POST 时浏览器强制携带 Origin，
// 其 origin 必须等于 publicBaseUrl 的 origin；缺失/`null`/非法/跨源一律 403。
// 边界（plan 5.3）：这是「Agent 经常规 MCP/REST 路径不能顺手代确认」的产品
// 工作流保障——常规 Agent 请求不带浏览器 Origin；令牌不是实名审批身份，
// 不宣称抵御持完整凭证者自行伪造 Origin 头模拟用户。
function assertWebOrigin(req: FastifyRequest, config: AppConfig): void {
  const raw = req.headers.origin
  const origin = Array.isArray(raw) ? raw[0] : raw
  let expected: string | undefined
  try {
    expected = new URL(config.publicBaseUrl).origin
  }
  catch { /* publicBaseUrl 非法时按永不匹配处理 */ }
  let actual: string | undefined
  if (origin) {
    try {
      actual = new URL(origin).origin
    }
    catch { /* 非法 Origin（含 `*`、`null`）视为不匹配 */ }
  }
  if (!expected || !actual || actual !== expected) {
    throw AppError.forbidden('确认会话仅限网页端同源页面申请')
  }
}

// owner（API Key/Agent）不需要从本接口拿编辑令牌：编辑链接只经
// create_outline/建文档响应一次性下发给用户。GET 不再向 owner 回吐
// 编辑令牌，防止 Agent 凭链接中的可复用令牌冒充网页用户动作。
function linksFor(access: DocAccess, config: AppConfig, row: DocumentRow) {
  if (access.role === 'view') return {}
  const links = docLinks(config, row)
  const outline = outlineLinks(config, row)
  return { viewUrl: links.viewUrl, outlineViewUrl: outline.outlineViewUrl }
}

export function outlineRoutes({ db, config, service, docService }: OutlineRoutesDeps): FastifyPluginAsync {
  return app => {
    // 初始化：仅 API Key 所有者；已存在返回 existing:true
    app.post('/api/docs/:id/outline', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role !== 'owner') throw AppError.notFound()
      const body = parseBody(outlineInitSchema, req.body, '初始化请求')
      return service.init(access, docId(req), body)
    })

    app.get('/api/docs/:id/outline', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      const { row } = docService.getDoc(docId(req))
      return { ...service.get(access, docId(req)), ...linksFor(access, config, row) }
    })

    // 网页 steps 写入（编辑令牌或 Key），CAS 由 service 校验
    app.patch('/api/docs/:id/outline', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能修改大纲')
      const body = parseBody(outlinePatchSchema, req.body, '大纲 steps 请求')
      return service.applySteps(access, docId(req), body)
    })

    // 结构化区块/线程操作
    app.post('/api/docs/:id/outline/ops', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能修改大纲')
      const body = parseBody(outlineOpsSchema, req.body, '大纲操作请求')
      return service.applyOps(access, docId(req), body)
    })

    // 提交反馈：网页用户动作（编辑令牌），Agent 不能代提交
    app.post('/api/docs/:id/outline/feedback', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能提交反馈')
      if (access.role === 'owner') throw AppError.forbidden('提交反馈需使用文档编辑令牌（用户动作）')
      const body = parseBody(outlineFeedbackSchema, req.body, '提交反馈请求')
      return service.submitFeedback(access, docId(req), body)
    })

    app.get('/api/docs/:id/outline/feedback', req => {
      resolveDocAccess(db, config, req, docId(req))
      const query = req.query as { status?: string, cursor?: string, limit?: string }
      return service.listFeedback(docId(req), {
        status: query.status,
        cursor: query.cursor !== undefined ? Number(query.cursor) : undefined,
        limit: query.limit !== undefined ? Number(query.limit) : undefined,
      })
    })

    app.get('/api/docs/:id/outline/feedback/:submissionId', req => {
      resolveDocAccess(db, config, req, docId(req))
      return service.getFeedback(docId(req), (req.params as { submissionId: string }).submissionId)
    })

    // Agent 报告本轮处理完成：仅 API Key
    app.post('/api/docs/:id/outline/feedback/:submissionId/complete', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role !== 'owner') throw AppError.notFound()
      const body = parseBody(outlineCompleteSchema, req.body, '完成反馈请求')
      return service.completeFeedback(access, docId(req), (req.params as { submissionId: string }).submissionId, body)
    })

    // 确认/撤销确认：真人用户动作。编辑令牌只允许读/写大纲内容，不能确认；
    // 三段凭证链：同源网页会话（本接口 + Origin 门禁）→ 一次性确认票
    // （X-Confirm-Session + action 绑定）→ approve/revoke（X-Confirm-Token）。
    // Agent 持 #t= 编辑链接可写大纲，但常规 MCP/REST 调用不带浏览器 Origin，
    // 拿不到会话也就领不到票。边界见 assertWebOrigin 注释。
    app.post('/api/docs/:id/outline/approval/session', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能申请确认会话')
      if (access.role === 'owner') throw AppError.forbidden('申请确认会话需使用文档编辑令牌（用户动作）')
      assertWebOrigin(req, config)
      return service.mintConfirmSession(docId(req))
    })

    app.post('/api/docs/:id/outline/approval/ticket', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能申请确认凭证')
      if (access.role === 'owner') throw AppError.forbidden('申请确认凭证需使用文档编辑令牌（用户动作）')
      const body = parseBody(outlineConfirmTicketSchema, req.body, '确认凭证请求')
      return service.mintConfirmTicket(docId(req), body.action, confirmSessionHeader(req))
    })

    app.post('/api/docs/:id/outline/approval', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能确认大纲')
      if (access.role === 'owner') throw AppError.forbidden('确认大纲需使用文档编辑令牌（用户动作）')
      const ticket = confirmToken(req)
      const body = parseBody(outlineApprovalSchema, req.body, '确认请求')
      return service.approve(access, docId(req), body, ticket)
    })

    app.delete('/api/docs/:id/outline/approval', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能撤销确认')
      if (access.role === 'owner') throw AppError.forbidden('撤销确认需使用文档编辑令牌（用户动作）')
      return service.revokeApproval(access, docId(req), confirmToken(req))
    })

    // Agent 依据有效确认开始制作：仅 API Key
    app.post('/api/docs/:id/outline/generation', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role !== 'owner') throw AppError.notFound()
      const body = (req.body ?? {}) as { requestId?: unknown }
      if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 128)) {
        throw AppError.validation('requestId 必须是 1~128 字符的字符串')
      }
      return service.beginGeneration(access, docId(req), body.requestId as string | undefined)
    })
    return Promise.resolve()
  }
}
