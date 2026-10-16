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
