/**
 * 配置入口契约：左侧栏一行 + 整页 `main`，组合包页只留介绍文档。
 *
 * 覆盖：
 *   1. `sidebar.panellist` 与 `main` 两个槽位都注册，id/key 同为 zotero-reader
 *   2. 菜单行带 label 与按 owner.size 渲染的图标
 *   3. `plugins.bundle.config` 不再注册配置表单
 *   4. 详情文档已声明（meta.detail）且文件存在，package.json 发布 docs
 *
 * 全部本地：只读源码与清单，不启动 host。
 *
 * 用法：node test/check-panel-slots.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const zh = JSON.parse(fs.readFileSync(path.join(root, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(fs.readFileSync(path.join(root, 'locale', 'en.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

check("PANEL_ID 统一为 'zotero-reader'", /const PANEL_ID = 'zotero-reader'/.test(src))

check('注册 sidebar.panellist，id 用 PANEL_ID',
  /name: 'sidebar\.panellist',\r?\n\s*id: PANEL_ID/.test(src))

check('注册 main，key 用 PANEL_ID',
  /name: 'main',\r?\n\s*key: PANEL_ID/.test(src))

check('菜单行有 label，且 order 固定',
  /label: \(\) => t\('nav'\)/.test(src) && /order: 21/.test(src))

check('图标是接收 owner.size 的组件',
  src.includes('(owner = {}) => h(ZoteroPanelIcon, { size: owner.size ?? 16 })')
  && src.includes('function ZoteroPanelIcon({ size } = {})'))

check('组合包页不再注册配置表单',
  !/name: 'plugins\.bundle\.config'/.test(src))

check('配置页仍挂在整页外框里（表单本身未改）',
  src.includes("h('div', { className: 'zr-panel-page' }")
  && src.includes('h(PluginConfigPage, { t, view })'))

check('中英文 nav / configTitle 齐全',
  src.includes("nav: 'Zotero 伴读'") && src.includes("nav: 'Zotero Paper Reader'")
  && src.includes("configTitle: 'Zotero 伴读设置'") && src.includes("configTitle: 'Zotero Paper Reader settings'"))

check('详情文档已声明（zh/en meta.detail）',
  zh.meta?.detail === 'docs/DETAIL.zh.md' && en.meta?.detail === 'docs/DETAIL.md')

check('详情文档实际存在',
  fs.existsSync(path.join(root, 'docs', 'DETAIL.zh.md'))
  && fs.existsSync(path.join(root, 'docs', 'DETAIL.md')))

check('package.json 发布 docs', Array.isArray(pkg.files) && pkg.files.includes('docs'))

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`)
process.exit(failed === 0 ? 0 : 1)
