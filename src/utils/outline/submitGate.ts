// 提交/确认等大纲写动作的纯判定（可离线测）。上传中或失败必须阻塞，
// 只读/冲突/保存中/保存失败同样阻塞；dirty 由 drain 先冲刷，不在这里拦。
export interface OutlineActionState {
  busy: boolean
  readonly: boolean
  uploadsPending: number
  saveStatus: string
}

export function outlineActionBlocked(s: OutlineActionState): boolean {
  return s.busy || s.readonly || s.uploadsPending > 0 || s.saveStatus === 'conflict' || s.saveStatus === 'saving' || s.saveStatus === 'offline'
}
