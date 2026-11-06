// 配额表单的补丁构建：输入框展示生效值（自定义 ?? 全局默认），
// 但只有管理员实际改动的字段才进入 PATCH —— 未动字段不发送（服务端 undefined=不修改），
// 既不会把「继承默认」误写成显式 override；清空输入（null）才显式表达「恢复继承」。
export interface QuotaValues {
  docs: number | null
  docMb: number | null
  exportsPerDay: number | null
}

export interface QuotaPatch {
  quotaDocs?: number | null
  quotaDocMb?: number | null
  quotaExportsPerDay?: number | null
}

export function quotaBaseline(custom: QuotaValues, effective: QuotaValues & { docs: number, docMb: number, exportsPerDay: number }): QuotaValues {
  return {
    docs: custom.docs ?? effective.docs,
    docMb: custom.docMb ?? effective.docMb,
    exportsPerDay: custom.exportsPerDay ?? effective.exportsPerDay,
  }
}

export function buildQuotaPatch(form: QuotaValues, baseline: QuotaValues): QuotaPatch {
  const patch: QuotaPatch = {}
  if (form.docs !== baseline.docs) patch.quotaDocs = form.docs
  if (form.docMb !== baseline.docMb) patch.quotaDocMb = form.docMb
  if (form.exportsPerDay !== baseline.exportsPerDay) patch.quotaExportsPerDay = form.exportsPerDay
  return patch
}
