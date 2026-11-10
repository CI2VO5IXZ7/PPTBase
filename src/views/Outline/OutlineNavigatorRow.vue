<template>
  <li :class="{ active: activeId === item.blockId }">
    <button
      type="button"
      class="nav-entry"
      :style="{ paddingLeft: `${8 + item.depth * 12}px` }"
      @click="$emit('navigate', item.blockId)"
    >
      {{ item.label }}
    </button>
    <ul v-if="item.children.length" class="nav-children">
      <OutlineNavigatorRow
        v-for="child in item.children"
        :key="child.blockId"
        :item="child"
        :active-id="activeId"
        @navigate="id => $emit('navigate', id)"
      />
    </ul>
  </li>
</template>

<script lang="ts" setup>
import type { NavItem } from '@/utils/outline/navigatorTree'

defineProps<{ item: NavItem, activeId: string | null }>()
defineEmits<{ navigate: [blockId: string] }>()
</script>

<script lang="ts">
export default { name: 'OutlineNavigatorRow' }
</script>

<style scoped>
.nav-entry {
  display: block; width: 100%; text-align: left; border: none; background: transparent;
  font-size: 12px; padding: 6px 8px; cursor: pointer; color: #333;
}
.nav-entry:hover { background: #eef2ff; }
li.active > .nav-entry {
  background: #e0e7ff; font-weight: 600; border-left: 3px solid #6366f1;
}
.nav-children { list-style: none; margin: 0; padding: 0; }
</style>
