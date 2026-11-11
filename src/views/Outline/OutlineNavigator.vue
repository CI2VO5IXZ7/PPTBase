<template>
  <nav class="outline-nav" aria-label="大纲导航">
    <div class="nav-head">
      <span>导航</span>
      <span class="nav-actions">
        <button type="button" class="close-drawer" @click="emit('close')">关闭</button>
        <button type="button" class="fold" @click="collapsed = !collapsed">{{ collapsed ? '展开' : '折叠' }}</button>
      </span>
    </div>
    <ul v-if="!collapsed && items.length" class="nav-tree">
      <template v-for="item in items" :key="item.blockId">
        <NavRow :item="item" :active-id="activeBlockId" @navigate="id => $emit('navigate', id)" />
      </template>
    </ul>
    <p v-else-if="!collapsed" class="empty">（暂无结构）</p>
  </nav>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import NavRow from './OutlineNavigatorRow.vue'
import { navigatorTree } from '@/utils/outline/navigatorTree'

const props = defineProps<{
  content: Record<string, unknown> | null
  activeBlockId: string | null
  escapeCloses?: boolean
}>()
const emit = defineEmits<{ navigate: [blockId: string], close: [] }>()

const collapsed = ref(false)
const items = computed(() => navigatorTree(props.content))

const onKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || !props.escapeCloses) return
  emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<style lang="scss" scoped>
.outline-nav {
  width: 220px; flex-shrink: 0; border-right: 1px solid #e5e5e5;
  display: flex; flex-direction: column; min-height: 0; background: #fafafa;
}
.nav-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 12px; font-size: 13px; font-weight: 600; border-bottom: 1px solid #eee;
}
.nav-actions { display: flex; gap: 8px; align-items: center; }
.fold, .close-drawer { border: none; background: none; cursor: pointer; font-size: 12px; color: #2563eb; }
.close-drawer { display: none; }
.nav-tree { list-style: none; margin: 0; padding: 8px 0; overflow-y: auto; flex: 1; }
.empty { font-size: 12px; color: #999; padding: 12px; }
@media (max-width: 860px) {
  .outline-nav {
    position: fixed; left: 0; top: 0; bottom: 0; z-index: 19;
    box-shadow: 2px 0 8px rgba(0,0,0,.12);
  }
  .close-drawer { display: inline; }
}
</style>
