<template>
  <aside class="comments-panel">
    <div class="panel-head">
      <span>批注 ({{ filtered.length }})</span>
      <select v-model="filter" class="filter">
        <option value="all">全部</option>
        <option value="open">未解决</option>
        <option value="resolved">已解决</option>
        <option value="detached">已脱离</option>
      </select>
    </div>
    <button v-if="!readonly" class="new-btn" @click="addDocComment">＋ 文档级批注</button>
    <div class="threads">
      <div v-for="t in filtered" :key="t.id" :class="['thread', t.status, { detached: t.detached }]">
        <div class="anchor-desc">{{ anchorDesc(t) }}</div>
        <div v-for="c in t.messages" :key="c.id" class="comment">
          <div class="meta">{{ c.author === 'agent' ? 'Agent' : '用户' }} · {{ formatTime(c.createdAt) }}</div>
          <div class="body">{{ c.content }}</div>
        </div>
        <div class="thread-actions" v-if="!readonly">
          <input v-model="replies[t.id]" class="reply" placeholder="回复…" @keyup.enter="reply(t)" />
          <button v-if="t.status !== 'resolved'" class="btn small" @click="setStatus(t, 'resolved')">解决</button>
          <button v-if="t.status === 'resolved'" class="btn small" @click="setStatus(t, 'open')">重开</button>
        </div>
      </div>
      <div v-if="!filtered.length" class="empty">暂无批注</div>
    </div>
  </aside>
</template>

<script lang="ts" setup>
import { computed, reactive, ref } from 'vue'
import type { OutlineThread } from '@/types/outline'

const props = defineProps<{ threads: OutlineThread[], readonly: boolean }>()
const emit = defineEmits<{ op: [op: Record<string, unknown>] }>()

const filter = ref('all')
const replies = reactive<Record<string, string>>({})

const filtered = computed(() => props.threads.filter(t => filter.value === 'all' || (filter.value === 'detached' ? t.detached : !t.detached && t.status === filter.value)))

const anchorDesc = (t: OutlineThread) => {
  const a = t.anchor
  if (t.detached) return `（已脱离）${a.quote?.text ?? a.blockId ?? '文档'}`
  switch (a.kind) {
    case 'document': return '整个文档'
    case 'block': return `区块 ${a.blockId}`
    case 'image': return `图片 ${a.blockId}`
    case 'textRange': return `选区 "${(a.quote?.text ?? '').slice(0, 30)}…"`
    default: return '未知锚点'
  }
}

const formatTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const reply = (t: OutlineThread) => {
  const text = replies[t.id]?.trim()
  if (!text) return
  emit('op', { op: 'replyComment', threadId: t.id, content: text })
  replies[t.id] = ''
}

const setStatus = (t: OutlineThread, status: 'resolved' | 'open') =>
  emit('op', { op: 'setThreadStatus', threadId: t.id, status })

const addDocComment = () => {
  const content = window.prompt('批注内容')
  if (!content) return
  emit('op', { op: 'addComment', anchor: { kind: 'document' }, content })
}
</script>

<style lang="scss" scoped>
.comments-panel { display: flex; flex-direction: column; height: 100%; }
.panel-head { padding: 10px 12px; border-bottom: 1px solid #e5e5e5; display: flex; justify-content: space-between; align-items: center; font-size: 14px; font-weight: 600; }
.filter { font-size: 12px; }
.new-btn { margin: 10px 12px 0; font-size: 12px; padding: 4px 8px; border: 1px dashed #d4d4d4; border-radius: 4px; background: #fff; cursor: pointer; }
.threads { flex: 1; overflow-y: auto; padding: 10px; }
.thread { border: 1px solid #e5e5e5; border-radius: 6px; padding: 8px; margin-bottom: 8px; font-size: 13px;
  &.resolved { opacity: 0.7; }
  &.detached { border-style: dashed; }
}
.anchor-desc { font-size: 11px; color: #888; margin-bottom: 6px; }
.comment .meta { font-size: 11px; color: #888; }
.comment .body { margin: 2px 0 6px; }
.reply { width: 100%; font-size: 12px; padding: 4px 6px; border: 1px solid #e5e5e5; border-radius: 4px; margin-top: 4px; }
.btn.small { font-size: 11px; padding: 2px 8px; margin-top: 4px; margin-left: 4px; }
.empty { text-align: center; color: #999; font-size: 13px; margin-top: 20px; }
</style>
