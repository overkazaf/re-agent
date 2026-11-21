// 视觉 QA：捕获 3D 剧场在多个关键时刻/主题下的截图（非 e2e 门禁，供人工检视）。
//   node scripts/visual-qa.mjs            # 输出到 e2e-artifacts/visual/
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(HERE, '..', '..', '..', 'docs')
const OUT = resolve(HERE, '..', 'e2e-artifacts', 'visual')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 4622
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
  if (path.endsWith('/')) path += 'index.html'
  const file = join(DOCS_ROOT, path)
  if (!existsSync(file) || !file.startsWith(DOCS_ROOT)) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

mkdirSync(OUT, { recursive: true })
await new Promise((res) => server.listen(PORT, '127.0.0.1', res))

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 200)}`))
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 200)}`)
})

const waitFor = (text, timeout = 15000) => page.waitForSelector(`text=${text}`, { timeout })
const settle = (ms = 1600) => page.waitForTimeout(ms)
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) })

await page.goto(`http://127.0.0.1:${PORT}/gui-demo/index.html?demo=1&noFallback=1`)
await waitFor('◈ DEMO')
await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 })
await settle()
await shot('01-overview-deck')

// 切到 Case 2 并跑到 H:3 E:4 DYN
await page.getByRole('button', { name: '◈ 场景库' }).click()
await page.getByText('CASE 2', { exact: true }).click()
await waitFor('CASE 2/5')
await page.getByRole('button', { name: /▶ 打开选择器/ }).click()
await waitFor('Embedded / IoT firmware image')
await page.getByText('Firmware blob', { exact: true }).click()
await page.getByRole('button', { name: /Firmware survey/ }).click()
await page.getByRole('button', { name: 'start RE session' }).click()
await waitFor('H:3')
await waitFor('○ idle')
// 点画布左上空白区回全局视角（画布约 x261..1183 / y125..580），等运镜沉降
await page.mouse.click(320, 165)
await settle(2200)
await shot('02-dag-overview')

// 打开实验向导（建议条）
await page.getByRole('button', { name: /去处理/ }).click()
await settle(1600)
await shot('03-wizard-experiment')
await page.keyboard.press('Escape')
await settle(800)

// 主题轮换（各自回全局视角取景）
for (const theme of ['amber', 'matrix', 'mono']) {
  await page.locator('select').selectOption(theme)
  await page.mouse.click(320, 165)
  await settle(1600)
  await shot(`04-overview-${theme}`)
}
await page.locator('select').selectOption('deck')
await settle(600)

// 经典视图对照
await page.getByRole('button', { name: '▣ 经典视图' }).click()
await settle(900)
await shot('05-classic-view')

await browser.close()
server.close()
console.log(`visual QA screenshots -> ${OUT}`)
