import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

// config 檔在 docs/.vitepress/，往上兩層是 repo 根。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_BLOB_BASE = 'https://github.com/CarlLee1983/StoreWeave/blob/main/'
// 帶 scheme（http:、mailto:）或 // 開頭的是外部連結；/ 開頭是站內絕對路徑；# 是頁內錨點。
const NON_RELATIVE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i

/**
 * 把「解析後落在 docs/ 之外」的相對連結改成 GitHub blob 連結；
 * 其餘連結原樣回傳，交給 VitePress 的 linkPlugin 與失效連結檢查。
 */
function rewriteOutsideDocsLink(href: string, relativePath: string): string {
  if (NON_RELATIVE_RE.test(href)) return href
  const match = /^([^?#]*)([?#].*)?$/.exec(href)
  const pathname = match?.[1] ?? href
  const suffix = match?.[2] ?? ''
  if (pathname === '') return href
  const dir = path.posix.dirname(relativePath)
  const resolved = path.posix.join(dir, pathname)
  if (resolved !== '..' && !resolved.startsWith('../')) return href
  // resolved 以 docs/ 為根；再往上走一層就是 repo 根。
  const repoPath = path.posix.normalize(`docs/${resolved}`)
  if (repoPath.startsWith('../')) return href
  // 繞一圈回到 docs 內（例如 ../docs/x.md）：交給站內失效連結檢查。
  if (repoPath.startsWith('docs/')) return href
  // 存在檢查用解碼後的路徑；輸出的 URL 保留原始（未解碼）路徑。
  const decodedRepoPath = path.posix.normalize(`docs/${path.posix.join(dir, decodeURI(pathname))}`)
  if (!fs.existsSync(path.join(REPO_ROOT, decodedRepoPath))) {
    throw new Error(`docs 外的連結目標不存在：${href}（來源頁 ${relativePath}）`)
  }
  const hadTrailingSlash = pathname.endsWith('/') && !repoPath.endsWith('/')
  return `${REPO_BLOB_BASE}${repoPath}${hadTrailingSlash ? '/' : ''}${suffix}`
}

export default defineConfig({
  title: 'StoreWeave',
  description: 'StoreWeave 架構、決策與開發文件',
  lang: 'zh-Hant-TW',
  base: '/StoreWeave/',
  themeConfig: {
    nav: [
      { text: '文件首頁', link: '/' },
      { text: '動手學', link: '/learn/', activeMatch: '^/learn/' },
      { text: '架構', link: '/architecture', activeMatch: '^/architecture' },
      { text: '決策紀錄', link: '/adr/README' },
    ],
    sidebar: {
      '/learn/': [
        {
          text: '從零開發自己的產品',
          items: [
            { text: '開發者學習路線', link: '/learn/from-zero/' },
            { text: '01 平台給了什麼', link: '/learn/from-zero/platform-map' },
            { text: '02 寫出第一個模組', link: '/learn/from-zero/first-module' },
            { text: '03 接上頁面與 Release', link: '/learn/from-zero/pages-and-release' },
            { text: '04 權限與發布邊界', link: '/learn/from-zero/permissions-and-publishing' },
            { text: '05 測試與交付', link: '/learn/from-zero/test-and-ship' },
          ],
        },
        {
          text: '使用既有能力',
          items: [
            { text: '學習路徑', link: '/learn/' },
            { text: '01 啟動第一個網站', link: '/learn/getting-started' },
            { text: '02 用現有功能打造 Blog', link: '/learn/build-a-blog' },
            { text: '03 延伸自己的功能', link: '/learn/extending-a-feature' },
            { text: '04 動手寫第一個 Extension', link: '/learn/extension-lab' },
          ],
        },
        { text: '查閱原理與契約', items: [
          { text: '架構導讀', link: '/architecture' },
          { text: '模組開發', link: '/module-development' },
          { text: 'Extension 開發', link: '/extension-development' },
        ] },
      ],
      '/architecture': [
        {
          text: '理解 StoreWeave',
          items: [
            { text: '動手學：從啟動到 Blog', link: '/learn/' },
            { text: '架構導讀', link: '/architecture' },
            { text: '01 平台、產品與 Release', link: '/architecture/platform-and-products' },
            { text: '02 請求如何讀寫資料', link: '/architecture/requests' },
            { text: '03 事件與背景工作', link: '/architecture/events-and-jobs' },
            { text: '04 模組邊界與資料責任', link: '/architecture/modules-and-data' },
            { text: '05 介面與後台資料流', link: '/architecture/interfaces-and-admin' },
            { text: '06 程式碼地圖', link: '/architecture/code-map' },
          ],
        },
      ],
    },
    outline: { level: 2, label: '本頁內容' },
    outlineTitle: '本頁內容',
    returnToTopLabel: '回到頂端',
    sidebarMenuLabel: '文件導覽',
    darkModeSwitchLabel: '外觀',
    lightModeSwitchTitle: '切換為淺色模式',
    darkModeSwitchTitle: '切換為深色模式',
    skipToContentLabel: '跳到主要內容',
    docFooter: { prev: '上一頁', next: '下一頁' },
  },
  // 只略過 localhost 範例網址；其餘站內失效連結都要讓建置失敗。
  ignoreDeadLinks: 'localhostLinks',
  markdown: {
    config(md) {
      // config 在 VitePress 內建 linkPlugin 之後執行，所以這裡拿到的是 linkPlugin 的 rule；
      // 先改寫 href 再交給它，連結就不會進入站內失效連結檢查。
      const original = md.renderer.rules.link_open!
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const href = token.attrGet('href')
        if (href && env.relativePath) {
          token.attrSet('href', rewriteOutsideDocsLink(href, env.relativePath))
        }
        return original(tokens, idx, options, env, self)
      }
    },
  },
})
