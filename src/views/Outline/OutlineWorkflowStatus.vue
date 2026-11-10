<template>
  <div class="workflow-status" role="status">
    <div class="row">
      <span class="label">确认</span>
      <span v-if="approval?.valid" class="ok">已确认（稿 c{{ approval.contentVersion }}）</span>
      <span v-else-if="approval" class="warn">已过时，请重新确认</span>
      <span v-else class="muted">未确认</span>
    </div>
    <div class="row">
      <span class="label">制作来源</span>
      <span v-if="!generation" class="muted">尚未开始</span>
      <span v-else-if="generation.stale" class="warn">已失效（不等价于导出完成）</span>
      <span v-else class="ok">有效（确认稿 c{{ generation.contentVersion }}）</span>
    </div>
    <p v-if="approval?.valid && generation?.stale" class="hint">
      确认与制作来源已分叉；已有幻灯片不会自动跟随大纲改正文。
    </p>
  </div>
</template>

<script lang="ts" setup>
defineProps<{
  approval?: { valid: boolean, contentVersion?: number } | null
  generation?: { stale: boolean, contentVersion?: number } | null
}>()
</script>

<style scoped>
.workflow-status { font-size: 12px; display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
.row { display: flex; gap: 8px; align-items: baseline; }
.label { color: #666; min-width: 64px; }
.ok { color: #059669; }
.warn { color: #d97706; }
.muted { color: #9ca3af; }
.hint { margin: 4px 0 0; color: #6b7280; font-size: 11px; line-height: 1.4; }
</style>
