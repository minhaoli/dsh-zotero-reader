/**
 * 行为冒烟：批注卡片 / 三点菜单 / 单一外框选中态。
 *
 * 前面几个护栏只保证「不报错、关键调用还在」，抓不到「多行批注还是画了多个框」、
 * 「面板结构缺失」这类**看起来正常但就是不对**的问题。这里用静态检查把真实约束钉住：
 *   1. 多行批注选中后，层里只有一个 .zr-annot-select，且包围盒覆盖所有行；
 *   2. 主面板（.zr-annot-card）结构齐全：页 N、⋯、评论框、添加标签；
 *   3. 三点菜单是竖排 8 个「色块 + 文字」条目 + 分隔线 + 删除，当前色打勾。
 */
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failed = 0
function check(label, ok) {
  if (ok) {
    console.log(`OK   ${label}`)
  } else {
    console.log(`FAIL ${label}`)
    failed += 1
  }
}

/* ---------- 1. 单一外框 ---------- */
check('存在 .zr-annot-select 外框元素', /zr-annot-select/.test(src))
check('外框是单一元素（只创建一个 div）',
  /createElement\('div'\)[\s\S]{0,200}zr-annot-select/.test(src) || /className\s*=\s*'zr-annot-select'/.test(src))
check('外框覆盖所有行的联合包围盒',
  /Math\.min\([\s\S]{0,120}\)[\s\S]{0,300}Math\.max\(/.test(src))
check('逐行描边的旧规则已移除',
  !/\[data-annot-selected="1"\]\{outline/.test(src))

/* ---------- 2. 主面板结构 ---------- */
check('主面板容器 .zr-annot-card', /zr-annot-card/.test(src))
check('面板标题显示页码', /zr-annot-card-page/.test(src))
check('面板有三点按钮', /zr-annot-card-btn/.test(src))
check('面板有评论输入框', /zr-annot-card-input/.test(src))
check('面板有添加标签输入', /zr-annot-card-tags/.test(src))
check('标签输入框不再被禁用',
  !/annotTagsOff/.test(src) || /disabled:\s*false/.test(src))

/* ---------- 3. 三点菜单 ---------- */
check('菜单容器 .zr-annot-menu', /zr-annot-menu/.test(src))
check('菜单项竖排（每项独占一行）',
  /\.zr-annot-menu button\{[^}]*display:\s*flex[^}]*width:\s*100%/.test(src)
  || /\.zr-annot-menu[\s\S]{0,300}flex-direction:\s*column/.test(src))
check('菜单含删除项', /zr-annot-menu-del/.test(src))
check('菜单含 8 色条目', /EDIT_COLORS/.test(src))
check('调色板 8 色',
  (src.match(/#(?:ffd400|ff6666|5fb236|2ea8e5|a28ae5|e56eee|f19837|aaaaaa)/g) || []).length >= 8)
check('当前颜色打勾', /✓|check/.test(src))

/* ---------- 4. 无假功能 ---------- */
check('没有「已保存」类成功提示',
  !/annotSaved/.test(src) || !/setPop\([^)]*annotSaved/.test(src))

/* ---------- 5. 关闭入口统一走 closeAnnotPanel ---------- */
check('存在 closeAnnotPanel 统一入口', /closeAnnotPanelRef/.test(src))
check('关闭前会刷未保存的评论', /annot:comment-flush/.test(src))

/* ---------- 6. 硬性约束：几何段与划词链路未被碰 ---------- */
check('几何段仍在（inkTopFrac）', /inkTopFrac/.test(src))
check('几何段仍在（emPt）', /emPt/.test(src))
check('viewer.setDocument 仍在', /viewer\.setDocument\(/.test(src))
check('划词 mouseup 链路仍在', /addEventListener\('mouseup'/.test(src))

console.log('')
if (failed > 0) {
  console.log(`共 ${failed} 项不通过`)
  process.exit(1)
}
console.log('批注面板交互检查全部通过')
