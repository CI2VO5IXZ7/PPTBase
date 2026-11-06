<template>
  <div class="source-attribution">
    演示文稿渲染与在线编辑基于
    <a href="https://github.com/pipipi-pikachu/PPTist" target="_blank" rel="noopener noreferrer">PPTist</a>
    （pipipi-pikachu · AGPL-3.0）
  </div>
</template>

<style lang="scss" scoped>
.source-attribution {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #999;
  text-align: center;
  padding: 0 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  a {
    color: inherit;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}
</style>
