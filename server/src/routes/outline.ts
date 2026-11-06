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

function linksFor(access: DocAccess, config: AppConfig, row: DocumentRow) {
  const links = docLinks(config, row)
  const outline = outlineLinks(config, row)
  return {
    ...(access.role === 'owner' ? { editUrl: links.editUrl, outlineEditUrl: outline.outlineEditUrl } : {}),
    ...(access.role !== 'view' ? { viewUrl: links.viewUrl, outlineViewUrl: outline.outlineViewUrl } : {}),
  }
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

    // 确认/撤销确认：用户动作（编辑令牌），Agent 不能代确认
    app.post('/api/docs/:id/outline/approval', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能确认大纲')
      if (access.role === 'owner') throw AppError.forbidden('确认大纲需使用文档编辑令牌（用户动作）')
      const body = parseBody(outlineApprovalSchema, req.body, '确认请求')
      return service.approve(access, docId(req), body)
    })

    app.delete('/api/docs/:id/outline/approval', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role === 'view') throw AppError.forbidden('只读链接不能撤销确认')
      if (access.role === 'owner') throw AppError.forbidden('撤销确认需使用文档编辑令牌（用户动作）')
      return service.revokeApproval(access, docId(req))
    })

    // Agent 依据有效确认开始制作：仅 API Key
    app.post('/api/docs/:id/outline/generation', req => {
      const access = resolveDocAccess(db, config, req, docId(req))
      if (access.role !== 'owner') throw AppError.notFound()
      const body = (req.body ?? {}) as { requestId?: string }
      return service.beginGeneration(access, docId(req), typeof body.requestId === 'string' ? body.requestId : undefined)
    })
    return Promise.resolve()
  }
}
