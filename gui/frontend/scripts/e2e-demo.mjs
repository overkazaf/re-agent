// Demo Environment E2E — exercises BOTH:
//   1) Standalone browser mode served from a subpath (/gui-demo/index.html)
//      with NO window.go / window.runtime: verifies all 5 interactive cases
//      (welcome+approval allow/deny, 9-phase RE workflow+picker+/audit,
//      multi-session+queue+interrupt, slash commands+theme+settings+resume,
//      embedded xterm demo shell).
//   2) Desktop Wails mode enter/exit isolation: real desktop sessions stay
//      intact when entering and exiting Demo Sandbox.
//
//   node scripts/e2e-demo.mjs   # after `make gui-demo-build`
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(HERE, '..', '..', '..', 'docs')
const ARTIFACTS = resolve(HERE, '..', 'e2e-artifacts')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 4620

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
}

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (path === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  if (path.endsWith('/')) path += 'index.html'
  const file = join(DOCS_ROOT, path)
  if (!existsSync(file) || !file.startsWith(DOCS_ROOT)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

mkdirSync(ARTIFACTS, { recursive: true })

async function waitFor(page, text, timeout = 12000) {
  await page.waitForSelector(`text=${text}`, { timeout })
}

let stepNo = 0
async function step(name, fn, page) {
  stepNo += 1
  const label = `D${stepNo} ${name}`
  try {
    await fn()
    console.log(`  ✓ ${label}`)
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`)
    await page.screenshot({ path: join(ARTIFACTS, `fail-D${stepNo}-${name.replace(/\W+/g, '-')}.png`), fullPage: true }).catch(() => {})
    throw err
  }
}

const consoleErrors = []
const pageErrors = []

async function main() {
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res))
  console.log(`serving ${DOCS_ROOT} on http://127.0.0.1:${PORT}/gui-demo/index.html`)

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))
  page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`))

  const shot = (name) => page.screenshot({ path: join(ARTIFACTS, `demo-${String(stepNo).padStart(2, '0')}-${name}.png`) })

  // ---------- Part 1: Standalone Browser Demo Sandbox ----------
  await page.goto(`http://127.0.0.1:${PORT}/gui-demo/index.html`)

  await step('auto-boots into Demo Sandbox without Wails bridge', async () => {
    await waitFor(page, '◈ DEMO')
    await waitFor(page, 'CASE 1/5')
    await waitFor(page, 'WEB SANDBOX')
    await waitFor(page, 'welcome')
  }, page)
  await shot('case1-boot')

  await step('Case 1: fill prompt + triage chall.js + approval deny then allow', async () => {
    // Test ⚡ 填入 fills textarea without sending
    await page.getByRole('button', { name: '⚡ 填入' }).click()
    const filled = await page.locator('textarea').inputValue()
    if (!filled.includes('chall.js')) throw new Error(`unexpected fill value: ${filled}`)
    await page.keyboard.press('Enter')
    await waitFor(page, '0xaf{warmup_deck}')
    await waitFor(page, '○ idle')

    // Trigger Step 2 approval gate via auto button
    await page.getByRole('button', { name: /▶ 自动触发/ }).click()
    await waitFor(page, '╭─ TOOL APPROVAL ─╮')
    await page.getByRole('button', { name: 'deny-always', exact: true }).waitFor({ state: 'visible', timeout: 8000 })

    // Test deny branch first
    await page.keyboard.press('Escape')
    await waitFor(page, '执行已被安全审批门拦截')
    await waitFor(page, '○ idle')

    // Trigger again and click allow branch
    await page.getByRole('button', { name: /2\.触发审批门/ }).click()
    await page.getByRole('button', { name: /▶ 自动触发/ }).click()
    await waitFor(page, '╭─ TOOL APPROVAL ─╮')
    await page.getByRole('button', { name: 'allow', exact: true }).click()
    await waitFor(page, '验证通过并已归档')
    await waitFor(page, '下一场景 →')
  }, page)
  await shot('case1-complete')

  await step('Case 2: codex-sol+ds+glm-5.3 RE workflow + sandbox + arbitrator + /audit + SVG graphs', async () => {
    await page.getByRole('button', { name: '下一场景 →' }).click()
    await waitFor(page, 'CASE 2/5')
    await waitFor(page, 'reverse-lab')

    // Open native REPickerDialog via Coach Bar
    await page.getByRole('button', { name: /▶ 打开选择器/ }).click()
    await waitFor(page, 'Embedded / IoT firmware image')
    await page.getByText('Firmware blob', { exact: true }).click()
    await page.getByRole('button', { name: /Firmware survey/ }).click()
    await page.getByRole('button', { name: 'start RE session' }).click()

    // Firmware survey prompt runs deepseek planning + codex static carve → H:3, E:4, ▸DYN
    await waitFor(page, 'H:3')
    await waitFor(page, 'E:4')
    await waitFor(page, '▸DYN')
    await waitFor(page, '○ idle')

    // Step 3: sandbox block (cap=network) + runtime contradiction + cascade + H-004 → ▸VER
    await page.getByRole('button', { name: /▶ 自动执行/ }).click()
    await waitFor(page, 'flag{demo_reverse_lab_flag}')
    await waitFor(page, '▸VER')
    await waitFor(page, '○ idle')

    // Step 4: isolated glm-5.3 /audit → unlocks WRI [9/9]
    await page.getByRole('button', { name: /▶ 运行 \/audit/ }).click()
    await waitFor(page, '▸WRI')
    await waitFor(page, '[9/9]')
    await waitFor(page, 'glm-5.3')

    // Step 5: Evidence-cited Writeup generation → archives notes/writeup.md & completes all 5 steps
    await page.getByRole('button', { name: /▶ 生成 Writeup/ }).click()
    await waitFor(page, '逆向分析与证据溯源报告：carrier.bin')
    await waitFor(page, '下一场景 →')
    await waitFor(page, '○ idle')

    // Open interactive Governance & Provenance Graph (Pipeline SVG view)
    await page.getByRole('button', { name: '◈ 机制图谱' }).click()
    await waitFor(page, 'PLANNER · codex-sol')
    await waitFor(page, 'EXECUTOR · ds')
    await waitFor(page, 'AUDITOR · glm-5.3')
    await waitFor(page, 'GATE 1 · 能力沙箱')
    await waitFor(page, 'HOST ARBITRATOR')
    await waitFor(page, '✦ 逆向过程总结：')

    // Verify Graph Zoom (+) and True Edge-to-Edge Fullscreen (⛶ 全屏放大)
    await page.getByLabel('放大图谱').click()
    await waitFor(page, '125%')
    await page.getByRole('button', { name: '⛶ 全屏放大' }).click()
    await waitFor(page, 'FULLSCREEN GRAPH')
    const fsRect = await page.locator('[data-fullscreen-stage="graph"]').boundingBox()
    if (!fsRect || fsRect.width < 1430 || fsRect.height < 890) {
      throw new Error(`graph fullscreen is not edge-to-edge 100vw×100vh: ${JSON.stringify(fsRect)}`)
    }
    await page.getByRole('button', { name: '✕ 退出全屏' }).click()

    // Verify Cognitive Process Replay (step through frames & thought playback, then return to LIVE)
    await page.getByRole('button', { name: '▶ 回放思考过程' }).click()
    await waitFor(page, '💭 思考与决策回放：')
    await page.getByRole('button', { name: /反证折半与级/ }).click()
    await waitFor(page, 'Commits to a story')
    await shot('case2-graph-replay')
    await page.getByRole('button', { name: '● 回到实时 (LIVE)' }).click()

    // Inspect Gate 1 Sandbox telemetry & Arbitrator telemetry by clicking SVG nodes
    await page.locator('svg').getByText('GATE 1 · 能力沙箱', { exact: true }).click()
    await waitFor(page, '实时沙箱动作日志')
    await waitFor(page, 'cap=network')
    await page.locator('svg').getByText('HOST ARBITRATOR', { exact: true }).click()
    await waitFor(page, 'runtime-contradiction')
    await shot('case2-graph-pipeline')

    // Switch to live Provenance Citation DAG SVG view
    await page.getByRole('button', { name: /☍ 实时因果证据图谱/ }).click()
    await waitFor(page, 'AUDIT & DELIVERY VERDICT')
    await waitFor(page, 'Auditor Seat: glm-5.3')
    await waitFor(page, 'H-004 [ACTIVE]')
    await waitFor(page, 'H-002 [REJECTED]')
    await page.locator('svg').getByText('H-004 [ACTIVE]', { exact: true }).click()
    await waitFor(page, '双视角交叉验证支撑')
    await shot('case2-graph-dag')

    // Switch to Summary & Writeup Studio tab (6-stage article alignment + templates)
    await page.getByRole('button', { name: '✎ 过程总结与 Writeup 工坊' }).click()
    await waitFor(page, '◈ 文章六大核心环节认知对齐')
    await waitFor(page, '已完成 6 / 6 环节')
    await waitFor(page, '✦ 逆向过程总结语句')
    await shot('case2-writeup-studio')

    // Verify Scientific RE Workbench: Create Hypothesis + Run Real Experiment -> Mints immutable ev_NNN
    await page.getByRole('button', { name: '🧪 假设实验与验证台' }).click()
    await waitFor(page, '⚖ 科学逆向取证铁律：')
    await page.getByRole('button', { name: '⚡ 填入正向实验示例' }).click()
    await page.getByRole('button', { name: '▶ 创建假设并立即实跑实验入账' }).click()
    await waitFor(page, '已创建假设 H-005 并完成实跑实验')
    await waitFor(page, 'exp_01 [PASSED]')
    await shot('case2-hypothesis-workbench')

    // Also verify Evidence-Cited Operator Review Sign-off (append-only audit_finding)
    await page.getByRole('button', { name: /⚖ 宿主仲裁与审查签章/ }).click()
    await page.getByLabel('review summary').fill('人工复核 H-005 明文前缀实验记录无误')
    await page.getByRole('button', { name: /✓ 签发不可篡改审查记录/ }).click()
    await waitFor(page, '审查结论已追加写入只读账本')
    await page.getByRole('button', { name: 'close', exact: true }).click()

    // Return to 5-panel Dashboard cleanly
    await page.getByRole('button', { name: '▣ 五维仪表' }).click()

    // Verify Binary Forensic Radar (Binary Terrain + True Fullscreen + Static vs Dynamic Evidence Alignment)
    await page.getByRole('button', { name: '◫ 二进制解剖' }).click()
    await waitFor(page, 'BINARY FORENSIC RADAR')
    await waitFor(page, 'SECTIONS')
    await waitFor(page, '.packed_stub')
    await waitFor(page, 'PATCH #1')
    await page.getByRole('button', { name: '⛶ 全屏放大' }).click()
    const terrainFsRect = await page.locator('[data-fullscreen-stage="terrain"]').boundingBox()
    if (!terrainFsRect || terrainFsRect.width < 1430 || terrainFsRect.height < 890) {
      throw new Error(`terrain fullscreen is not edge-to-edge 100vw×100vh: ${JSON.stringify(terrainFsRect)}`)
    }
    await page.getByRole('button', { name: '✕ 退出全屏' }).click()
    await page.getByRole('button', { name: /HEX 查看/ }).click()
    await waitFor(page, '[hexdump]')
    await page.getByRole('button', { name: /带入假设向导/ }).click()
    await waitFor(page, '假设 · 建立')
    const prefilledClaim = await page.getByLabel('hypothesis claim').inputValue()
    if (!prefilledClaim.trim()) throw new Error('expected prefilled claim from binary terrain hotspot')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /⇄ 动静证据对齐/ }).click()
    await waitFor(page, '假设双视角交叉核验')
    await waitFor(page, '双视角交叉确认')
    await shot('case2-binary-terrain-alignment')
    await page.getByRole('button', { name: '▣ 五维仪表' }).click()

    // Verify LedgerPanel + clickable H:N opens LedgerDetailDialog with hypotheses & evidence cross-links
    await waitFor(page, 'LEDGER')
    await page.getByTitle('点击查看假设栈明细').click()
    await waitFor(page, 'EVIDENCE LEDGER & HYPOTHESIS STACK')
    await waitFor(page, 'H-004')
    await page.getByRole('button', { name: 'ev_008', exact: true }).first().click()
    await waitFor(page, 'flag{demo_reverse_lab_flag}')
    await page.getByRole('button', { name: 'close', exact: true }).click()
  }, page)
  await shot('case2-re-complete')

  await step('Case 3: multi-session switch + mid-turn queue + ■ stop interrupt', async () => {
    await page.getByRole('button', { name: '下一场景 →' }).click()
    await waitFor(page, 'CASE 3/5')
    await waitFor(page, 'android-sign')
    await waitFor(page, 'elf-packer')

    // Switch to android-sign & see pre-seeded JNI analysis
    await page.getByText('android-sign', { exact: true }).click()
    await waitFor(page, 'JNI_OnLoad')

    // Auto-run queue pair on elf-packer
    await page.getByRole('button', { name: /▶ 演示排队/ }).click()
    await waitFor(page, 'queued (1)')
    await waitFor(page, '排队追问已自动执行', 18000)
    await waitFor(page, '○ idle', 15000)

    // Auto-run interrupt demo
    await page.getByRole('button', { name: /▶ 演示中断/ }).click()
    await waitFor(page, 'interrupted')
    await waitFor(page, '○ idle')
  }, page)
  await shot('case3-multi-queue-stop')

  await step('Case 4: direct /decode + /theme amber + settings + resume', async () => {
    await page.getByRole('button', { name: '下一场景 →' }).click()
    await waitFor(page, 'CASE 4/5')

    await page.getByRole('button', { name: /▶ 运行 \/decode/ }).click()
    await waitFor(page, 'flag{demo_reverse_lab_flag}')

    await page.getByRole('button', { name: /▶ 切 amber 主题/ }).click()
    await waitFor(page, 'theme=amber')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'amber', { timeout: 5000 })

    // Open settings via Coach Bar and save
    await page.getByRole('button', { name: /▶ 打开 ⚙ 设置/ }).click()
    await waitFor(page, 'CONFIG')
    await waitFor(page, 'max turns')
    await page.getByRole('button', { name: 'save', exact: true }).click()
    await waitFor(page, '已保存')
    await shot('case4-role-config')
    await page.getByRole('button', { name: 'close', exact: true }).click()

    // Also verify ResumeDialog lists and restores historical sessions
    await page.getByTitle('resume saved session').click()
    await waitFor(page, 'a9f3c1e2')
    await page.getByRole('button', { name: /a9f3c1e2/ }).click()
    await waitFor(page, '历史复盘：welcome/chall.js')
  }, page)
  await shot('case4-commands-amber')

  await step('Case 5: embedded xterm demo shell + interactive node chall.js + return', async () => {
    await page.getByRole('button', { name: '◈ 场景库' }).click()
    await waitFor(page, '内置 PTY 终端与双屏协同')
    await page.getByText('内置 PTY 终端与双屏协同', { exact: true }).click()
    await waitFor(page, 'CASE 5/5')

    await page.getByRole('button', { name: /▶ 打开 \+ sh/ }).click()
    await waitFor(page, 'SHELL demo-sh-')

    // Auto-type `node chall.js '0xaf{warmup_deck}'` into xterm
    await page.getByRole('button', { name: /▶ 自动输入验证/ }).click()
    await waitFor(page, '本地终端校验完成', 10000)

    // Switch back to agent dashboard while shell stays alive in sidebar
    await page.getByRole('button', { name: /▶ 切回仪表盘/ }).click()
    await page.locator('textarea:not(.xterm-helper-textarea)').waitFor({ state: 'visible', timeout: 5000 })
    await waitFor(page, 'SHELLS · 1')
  }, page)
  await shot('case5-shell-return')

  await step('Layout: collapse panes, fold individual panels, resize handles, reset', async () => {
    // Collapse sidebar & right rail & transcript, then restore
    await page.getByRole('button', { name: '◧ 侧栏' }).click()
    await page.getByTitle('展开左侧会话栏').first().waitFor({ state: 'visible', timeout: 3000 })
    await page.getByRole('button', { name: '◨ 右栏' }).click()
    await page.getByTitle('展开右侧 RE / 队列 / 通知栏').first().waitFor({ state: 'visible', timeout: 3000 })
    await page.getByRole('button', { name: '⬓ 转录' }).click()
    await page.getByTitle('展开转录流').first().waitFor({ state: 'visible', timeout: 3000 })

    // Fold FLOW panel box individually
    await page.getByLabel('collapse flow').click()
    await page.getByLabel('expand flow').waitFor({ state: 'visible', timeout: 3000 })
    await page.getByLabel('expand flow').click()

    // Reset layout restores all panes
    await page.getByTitle('重置所有窗口尺寸并全部展开').click()
    await waitFor(page, 'SESSIONS · 1')
    await waitFor(page, 'RE WORKFLOW')
  }, page)
  await shot('layout-resizable-collapsible')

  // ---------- Part 1.5: 3D Forensic Theater — wizard chain + view toggle + fallback ----------
  const tPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  tPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[3d] ${m.text()}`) })
  tPage.on('pageerror', (e) => pageErrors.push(`[3d] ${String(e?.stack ?? e)}`))
  // noFallback=1：无头 Chrome 软件渲染帧率必低于 30fps，关掉自动降级哨兵保证用例确定性
  await tPage.goto(`http://127.0.0.1:${PORT}/gui-demo/index.html?demo=1&noFallback=1`)

  await step('theater: demo boots with 3D canvas + e2e debug hook', async () => {
    await waitFor(tPage, '◈ DEMO')
    await tPage.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 })
    // R3F 的 effect 在 canvas 可见之后才装钩子 —— 轮询而不是一次性读取
    await tPage.waitForFunction(
      () => typeof window.__theaterDebug?.zoneScreenPos === 'function',
      undefined,
      { timeout: 10000 },
    )
    const pos = await tPage.evaluate(() => window.__theaterDebug?.zoneScreenPos?.('HYP'))
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      throw new Error(`zoneScreenPos broken: ${JSON.stringify(pos)}`)
    }
    // Verify 3D Theater true edge-to-edge fullscreen without losing canvas
    await tPage.getByRole('button', { name: '⛶ 全屏剧场' }).click()
    const thFsRect = await tPage.locator('[data-fullscreen-stage="theater"]').boundingBox()
    if (!thFsRect || thFsRect.width < 1430 || thFsRect.height < 890) {
      throw new Error(`theater fullscreen is not edge-to-edge 100vw×100vh: ${JSON.stringify(thFsRect)}`)
    }
    await tPage.getByRole('button', { name: '✕ 退出全屏' }).click()
  }, tPage)
  await tPage.screenshot({ path: join(ARTIFACTS, 'theater-01-boot.png') })

  await step('theater: jump to Case 2 via launcher and start RE session (seeds re + hyps)', async () => {
    await tPage.getByRole('button', { name: '◈ 场景库' }).click()
    await tPage.getByText('CASE 2', { exact: true }).click()
    await waitFor(tPage, 'CASE 2/5')
    await waitFor(tPage, 'reverse-lab')
    // Case 2 step 1: RE picker → Firmware blob → start RE session
    await tPage.getByRole('button', { name: /▶ 打开选择器/ }).click()
    await waitFor(tPage, 'Embedded / IoT firmware image')
    await tPage.getByText('Firmware blob', { exact: true }).click()
    await tPage.getByRole('button', { name: /Firmware survey/ }).click()
    await tPage.getByRole('button', { name: 'start RE session' }).click()
    await waitFor(tPage, 'H:3')
    await waitFor(tPage, '▸DYN')
    await waitFor(tPage, '○ idle')
  }, tPage)

  await step('theater: suggestion bar routes into experiment wizard', async () => {
    await tPage.getByRole('button', { name: /去处理/ }).waitFor({ state: 'visible', timeout: 10000 })
    await tPage.getByRole('button', { name: /去处理/ }).click()
    await tPage.getByText(/实验 · H-/).waitFor({ state: 'visible', timeout: 8000 })
    await tPage.getByLabel('experiment command').waitFor({ state: 'visible', timeout: 5000 })
  }, tPage)
  await tPage.screenshot({ path: join(ARTIFACTS, 'theater-02-experiment-wizard.png') })

  await step('theater: back-nav prefills claim (revise flow) and re-advances', async () => {
    await tPage.getByRole('button', { name: '← 上一步' }).click()
    await tPage.getByLabel('falsifiable prediction').waitFor({ state: 'visible', timeout: 8000 })
    const claim = await tPage.getByLabel('hypothesis claim').inputValue()
    if (claim.trim().length < 10) throw new Error(`claim not prefilled from existing hyp: "${claim}"`)
    // demo 场景生成的 H-001 没带「可证伪预测：」note，需现场补写预测（必填项）
    await tPage.getByLabel('falsifiable prediction').fill('动态重放 chall.js 应输出 accepted')
    await tPage.getByRole('button', { name: /提交假设 · 配置实验/ }).click()
    await tPage.getByText(/实验 · H-/).waitFor({ state: 'visible', timeout: 8000 })
  }, tPage)

  await step('theater: passing experiment auto-advances to verification', async () => {
    await tPage.getByLabel('experiment command').fill('node chall.js 0xaf{warmup_deck}')
    await tPage.getByLabel('experiment expected').fill('accepted')
    await tPage.getByRole('button', { name: /运行实验并实跑取证/ }).click()
    await waitFor(tPage, '验证 · 产物重放')
  }, tPage)

  await step('theater: verify_artifact → review wizard → archive closes wizard', async () => {
    await tPage.getByLabel('verify artifact path').fill('notes/solve.md')
    await tPage.getByLabel('case 1 command').fill('node chall.js 0xaf{warmup_deck}')
    await tPage.getByLabel('case 1 expected').fill('accepted')
    await tPage.getByRole('button', { name: /实跑 verify_artifact 签发验证凭证/ }).click()
    // 通过后展示统计条；1.5s 自动进审计，手动按钮「▸ 进入审计 →」兜底
    await tPage.getByRole('button', { name: /进入审计/ }).waitFor({ state: 'visible', timeout: 12000 }).catch(() => {})
    await waitFor(tPage, '审计 · 审查签章')
    await tPage.getByText('SUPPORT 核准支撑').click()
    await tPage.getByRole('button', { name: /ev_0/ }).first().click()
    await tPage.getByLabel('review summary').fill('静态解码与动态重放记录核对一致，结论闭环')
    await tPage.getByRole('button', { name: /提交审查/ }).click()
    await tPage.getByRole('button', { name: /完成归档/ }).waitFor({ state: 'visible', timeout: 12000 })
    await tPage.getByRole('button', { name: /完成归档/ }).click()
    await tPage.getByText('审计 · 审查签章').waitFor({ state: 'hidden', timeout: 8000 })
  }, tPage)
  await tPage.screenshot({ path: join(ARTIFACTS, 'theater-03-archived.png') })

  await step('theater: view toggle round-trip classic ↔ 3D', async () => {
    await tPage.getByRole('button', { name: '▣ 经典视图' }).click()
    await waitFor(tPage, '◈ 机制图谱') // classic-only graph toggle appears
    await tPage.locator('canvas').first().waitFor({ state: 'hidden', timeout: 8000 })
    await tPage.getByRole('button', { name: '◈ 3D 剧场' }).click()
    await tPage.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 })
  }, tPage)

  const rmPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  rmPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[rm] ${m.text()}`) })
  rmPage.on('pageerror', (e) => pageErrors.push(`[rm] ${String(e?.stack ?? e)}`))
  await rmPage.emulateMedia({ reducedMotion: 'reduce' })
  await rmPage.goto(`http://127.0.0.1:${PORT}/gui-demo/index.html?demo=1`)

  await step('theater: reduced-motion preference auto-falls back to classic', async () => {
    await waitFor(rmPage, '◈ DEMO')
    await waitFor(rmPage, '减弱动效') // fallback toast text
    await rmPage.getByRole('button', { name: '◈ 3D 剧场' }).waitFor({ state: 'visible', timeout: 8000 })
    await rmPage.locator('canvas').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {
      /* canvas 可能仍挂载在 DOM 但视图已切经典 — 按钮状态为准 */
    })
  }, rmPage)

  // ---------- Part 2: Desktop Wails Mode Enter & Exit Isolation ----------
  const deskPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  deskPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[desk] ${m.text()}`) })
  deskPage.on('pageerror', (e) => pageErrors.push(`[desk] ${String(e?.stack ?? e)}`))

  await deskPage.addInitScript(() => {
    const listeners = new Map()
    window.runtime = {
      EventsOn(name, cb) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(cb)
      },
      EventsOff() {},
    }
    const tick = {
      flow: {
        stage: 'idle', turn: 0, provider: 'real-planner', model: 'real-1', endpoint: 'real://local',
        messages: 0, sentTokens: 0, usage: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        pendingCalls: 0, activeTool: '', toolStartedAt: 0, toolMs: 0, toolsOk: 0, toolsFailed: 0, toolRuns: [],
        replyChars: 0, compactedDrop: 0, compactedElide: 0, hasCompacted: false, plan: null, planKind: '',
        error: '', frame: 0, packets: [], since: Date.now(),
      },
      hud: {
        phase: 'idle', frame: '', elapsedMs: 0,
        stats: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        spark: [], route: { planner: 'real-planner', executor: 'real-exec', active: 'real-planner' },
        queueCount: 0, planDisplay: 'auto', thinkDisplay: 'auto',
      },
      re: null,
      plan: null,
    }
    window.go = {
      main: {
        App: {
          async StartSession(opts) {
            return { id: 'real-1', workspace: opts.workspace || '/real/ws', role: 'auto', workflow: 'auto', planner: 'real-planner', executor: 'real-exec', lifecycle: 'idle' }
          },
          async ResumeSession() { throw new Error('none') },
          async ListSessions() { return [] },
          async CloseSession() {},
          async SendPrompt() {},
          async Interrupt() { return false },
          async SendCommand() { return { ok: true, notices: [] } },
          async Approve() {},
          async GetState() { return tick },
          async GetSettings() { return { role: 'auto', provider: '', plannerProvider: 'real-planner', executorProvider: 'real-exec', researcherProvider: '', providerNames: ['real-planner'], providers: [], maxTurns: 30, compactionStrategy: 'summary', mcpServerCount: 0 } },
          async SetSettings() {},
          async Completions() { return [] },
          async GetThemes() { return ['deck', 'amber', 'matrix', 'mono'] },
          async RESampleTypes() { return [] },
          async HomeDir() { return '/real/ws' },
          async PickDirectory() { return '/real/ws' },
          async ShellStart() { return { id: 'real-sh-1', cwd: '/real/ws', pid: 99 } },
          async ShellWrite() {},
          async ShellResize() {},
          async ShellStop() {},
          async ShellList() { return [] },
          async ListWorkspaceFiles() { return [] },
          async AnalyzeBinaryTerrain() { throw new Error('no binary') },
        },
      },
    }
  })

  await deskPage.goto(`http://127.0.0.1:${PORT}/gui-demo/index.html`)

  await step('Desktop mode: starts normally, enters Demo Sandbox, exits & restores real session', async () => {
    await waitFor(deskPage, 'SESSIONS · 0')
    await waitFor(deskPage, '▷ 演示环境')
    // Must NOT auto-enter demo when real Wails bridge exists
    if ((await deskPage.locator('text=◈ DEMO').count()) > 0) {
      throw new Error('auto-entered demo mode despite real Wails bridge')
    }

    // Create a real desktop session
    await deskPage.getByTitle('new session').click()
    await deskPage.getByPlaceholder('默认使用 $HOME（输入绝对路径或选择目录）').fill('/tmp/my-real-project')
    await deskPage.getByRole('button', { name: 'start session' }).click()
    await waitFor(deskPage, 'my-real-project')

    // Enter Demo Sandbox from TopBar
    await deskPage.getByRole('button', { name: '▷ 演示环境' }).click()
    await waitFor(deskPage, '0xAF-Re 演示环境 · 常见 Case 场景库')
    await deskPage.getByText('入门解谜 + 工具审批门', { exact: true }).last().click()
    await waitFor(deskPage, '◈ DEMO')
    await waitFor(deskPage, 'welcome')
    if ((await deskPage.locator('text=my-real-project').count()) > 0) {
      throw new Error('real desktop session leaked into Demo Sandbox')
    }

    // Exit Demo Sandbox → real session restored cleanly
    await deskPage.getByRole('button', { name: '✕ 退出' }).click()
    await waitFor(deskPage, 'my-real-project')
    await waitFor(deskPage, '▷ 演示环境')
    if ((await deskPage.locator('text=◈ DEMO').count()) > 0) {
      throw new Error('Demo Coach Bar still visible after exit')
    }
  }, deskPage)

  await browser.close()
  server.close()

  console.log('\n──── demo e2e summary ────')
  console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? '\n  ' + consoleErrors.join('\n  ') : ''}`)
  console.log(`page errors:    ${pageErrors.length}${pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : ''}`)

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    console.error('FAIL: console/page errors present')
    process.exit(1)
  }
  console.log('PASS: all demo sandbox & desktop isolation checks green')
}

main().catch((err) => {
  console.error(`\nDemo E2E aborted: ${err.message}`)
  if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`)
  if (consoleErrors.length) console.error(`console errors:\n  ${consoleErrors.join('\n  ')}`)
  process.exit(1)
})
