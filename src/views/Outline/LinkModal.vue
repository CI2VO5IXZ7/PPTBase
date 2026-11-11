<template>
  <Modal :visible="visible" :width="480" :close-button="true" @update:visible="v => !v && $emit('cancel')">
    <h3 class="title">插入链接</h3>
    <input v-model="href" class="input" type="url" placeholder="https://…" @keyup.enter="submit" />
    <p v-if="error" class="err">{{ error }}</p>
    <div class="actions">
      <button type="button" class="btn" @click="$emit('cancel')">取消</button>
      <button type="button" class="btn primary" @click="submit">确定</button>
    </div>
  </Modal>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { normalizeHttpsHref } from '@/utils/outline/linkHref'

const props = defineProps<{ visible: boolean, initialHref?: string }>()
const emit = defineEmits<{ submit: [href: string], cancel: [] }>()

const href = ref('')
const error = ref('')

watch(() => props.visible, v => {
  if (v) {
    const initial = props.initialHref ? normalizeHttpsHref(props.initialHref) : null
    href.value = initial && initial.ok ? initial.href : 'https://'
    error.value = ''
  }
})

function submit() {
  const result = normalizeHttpsHref(href.value)
  if (!result.ok) {
    error.value = result.error
    return
  }
  emit('submit', result.href)
}
</script>

<style scoped>
.title { margin: 0 0 12px; font-size: 16px; }
.input { width: 100%; font-size: 14px; padding: 8px; border: 1px solid #d4d4d4; border-radius: 4px; box-sizing: border-box; }
.err { color: #dc2626; font-size: 12px; }
.actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
.btn { font-size: 13px; padding: 4px 12px; border: 1px solid #d4d4d4; border-radius: 4px; background: #fff; cursor: pointer; }
.btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
</style>
