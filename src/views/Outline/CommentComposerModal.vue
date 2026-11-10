<template>
  <Modal
    :visible="visible"
    :width="480"
    :close-button="true"
    @update:visible="v => !v && $emit('cancel')"
  >
    <h3 class="title">添加批注</h3>
    <TextArea v-model:value="text" :rows="5" placeholder="批注内容" />
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
import TextArea from '@/components/TextArea.vue'
import { OUTLINE_LIMITS } from '@/utils/outline/schema'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ submit: [text: string], cancel: [] }>()

const text = ref('')
const error = ref('')

watch(() => props.visible, v => {
  if (v) { text.value = ''; error.value = '' }
})

function submit() {
  const t = text.value.trim()
  if (!t) { error.value = '请输入批注内容'; return }
  if (t.length > OUTLINE_LIMITS.maxCommentChars) {
    error.value = `最多 ${OUTLINE_LIMITS.maxCommentChars} 字`
    return
  }
  emit('submit', t)
}
</script>

<style scoped>
.title { margin: 0 0 12px; font-size: 16px; }
.err { color: #dc2626; font-size: 12px; }
.actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
.btn { font-size: 13px; padding: 4px 12px; border: 1px solid #d4d4d4; border-radius: 4px; background: #fff; cursor: pointer; }
.btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
</style>
