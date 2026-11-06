// 配额表单的补丁构建：输入框值为「自定义原值」——继承字段为 null，placeholder 展示生效值。
// 只有管理员实际改动的字段才进入 PATCH（未动字段不发送，服务端 undefined=不修改）；
// 填入等于全局默认的数字 → 显式 override；清空输入（null）→ 显式恢复继承。
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

// baseline 只取 custom 原值（保留 null 继承），绝不用 effective 回填——
// 否则「输入等于默认值」会被误判为未改动，无法显式写死当前默认。
export function quotaBaseline(custom: QuotaValues): QuotaValues {
  return { docs: custom.docs, docMb: custom.docMb, exportsPerDay: custom.exportsPerDay }
}

export function buildQuotaPatch(form: QuotaValues, baseline: QuotaValues): QuotaPatch {
  const patch: QuotaPatch = {}
  if (form.docs !== baseline.docs) patch.quotaDocs = form.docs
  if (form.docMb !== baseline.docMb) patch.quotaDocMb = form.docMb
  if (form.exportsPerDay !== baseline.exportsPerDay) patch.quotaExportsPerDay = form.exportsPerDay
  return patch
}
