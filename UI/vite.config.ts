import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    // 固定端口 5173：默认行为是端口被占就自动换一个，这里关掉，方便 native 侧按固定地址连接
    port: 5173,
    strictPort: true,
  },
  build: {
    // 产物文件名固定，不带内容 hash：这堆文件不是放到 CDN 上给浏览器缓存的，
    // 是编进 exe 的资源（见 scripts/gen-dist-rc.mjs），缓存那套没意义，
    // 而带 hash 会让 dist/assets/ 下的名字每次构建都变，Resource.rc 跟着一遍遍重写。
    // chunkFileNames 留 [name]：将来分了包也不至于几个 chunk 抢同一个文件名
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
