// Runtime E2E — real Chrome + the real built bundle (dist/) + a faithful fake
// Wails bridge. The shim mirrors gui/events.go + gui/dto.go exactly: one
// "gui:event" channel via window.runtime, EventEnvelope shapes, Go zero-value
// marshaling (pointers → null, slices → []), 90ms tick cadence while running,
// queued prompts, and the synchronous approval gate. Console errors, page
// errors, and failed requests fail the run; every step screenshots to
// e2e-artifacts/.
//
//   node scripts/e2e-runtime.mjs          # after `npm run build`
//
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'dist')
const ARTIFACTS = resolve(HERE, '..', 'e2e-artifacts')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 4619

// ---------- static server ----------

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
  if (path === '/') path = '/index.html'
  const file = join(DIST, path)
  if (!existsSync(file) || !file.startsWith(DIST)) {
    res.writeHead(404)
    res.end('nope')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

// ---------- the shim, injected before any app code ----------

function installShim() {
  const sessions = new Map() // id → runtime
  let seq = 0
  let approvalSeq = 0
  const listeners = new Map()

  const runtime = {
    EventsOn(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(cb)
      return () => runtime.EventsOff(name)
    },
    EventsOff(...names) {
      for (const n of names) listeners.delete(n)
    },
  }
  window.runtime = runtime

  function deliver(envelope) {
    const cbs = listeners.get('gui:event')
    if (!cbs) return
    // Go → WebView delivery is async with jitter; never same-tick
    for (const cb of cbs) setTimeout(() => cb(envelope), 1 + Math.random() * 6)
  }

  // Go marshals core's TokenUsage with omitempty on every field: a zero value
  // crosses the bridge as `{}`, not `{input:0,...}`. The fake must reproduce
  // that (the TS contract's full shape is what the frontend WISHES it got).
  const zeroUsage = () => ({})
  const usedUsage = (u) => {
    const out = {}
    if (u.input) out.input = u.input
    if (u.output) out.output = u.output
    if (u.thinking) out.thinking = u.thinking
    if (u.cacheRead) out.cacheRead = u.cacheRead
    if (u.cacheWrite) out.cacheWrite = u.cacheWrite
    if (u.costUsd) out.costUsd = u.costUsd
    return out
  }
  const flow = (over = {}) => ({
    stage: 'idle', turn: 0, provider: 'mock', model: 'mock-1', endpoint: 'mock://local',
    messages: 0, sentTokens: 0, usage: zeroUsage(), pendingCalls: 0, activeTool: '',
    toolStartedAt: 0, toolMs: 0, toolsOk: 0, toolsFailed: 0, toolRuns: [], replyChars: 0,
    compactedDrop: 0, compactedElide: 0, hasCompacted: false, plan: null, planKind: '',
    error: '', frame: Math.floor(Math.random() * 9999), packets: [], since: Date.now(),
    ...over,
  })
  const hud = (over = {}) => ({
    phase: 'idle', frame: '▂▃▅▂', elapsedMs: 0, stats: zeroUsage(), spark: [],
    route: null, queueCount: 0, planDisplay: 'auto', thinkDisplay: 'auto',
    ...over,
  })
  const tickOf = (s, over = {}) => ({
    flow: flow(over.flow ?? {}),
    hud: hud({ queueCount: s.queue.length, ...(over.hud ?? {}) }),
    re: null,
    plan: over.plan ?? null,
  })
  // full-shape LoopEvent (Go marshals every field)
  const loopEvent = (over = {}) => ({
    type: '', turn: 0, provider: 'mock', phase: '', model: 'mock-1', endpoint: 'mock://local',
    messages: 0, tokens: 0, tools: 0, ms: 0, ok: false, toolCalls: 0, textChars: 0,
    error: '', tokensBefore: 0, tokensAfter: 0, droppedMessages: 0, elidedToolResults: 0,
    progress: null, snapshot: null, text: '', usage: null, reason: '', name: '', args: null, preview: '',
    ...over,
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // nap: sleep that returns early with `true` when Interrupt() marks the turn
  // aborted — the fake's stand-in for a real ctx cancel, armed for the whole
  // turn (a real turnCancel is valid from the moment runTurn starts)
  function nap(s, ms) {
    return new Promise((res) => {
      if (s.aborted) {
        res(true)
        return
      }
      let done = false
      const finish = (val) => {
        if (done) return
        done = true
        s.abortNotify = null
        res(val)
      }
      const t = setTimeout(() => finish(false), ms)
      s.abortNotify = () => {
        clearTimeout(t)
        finish(true)
      }
    })
  }

  // unwind a turn mid-flight: ticker off, busy false, idle lifecycle, queue
  // stops draining — the same early-exit runTurn's interrupted path takes
  function finishAborted(s) {
    stopTicker(s)
    s.busy = false
    s.stage = 'idle'
    s.activeTool = ''
    s.toolStartedAt = 0
    emitNotice(s.id, 'info', 'interrupted')
    emitLifecycle(s.id, 'idle')
    emitTick(s.id, tickOf(s, { flow: { stage: 'error', turn: s.turn }, hud: { queueCount: s.queue.length } }))
  }

  function emitLoop(id, events) { deliver({ sessionId: id, kind: 'loop', ts: Date.now(), data: events }) }
  function emitTick(id, t) { deliver({ sessionId: id, kind: 'tick', ts: Date.now(), data: t }) }
  function emitLifecycle(id, state) { deliver({ sessionId: id, kind: 'lifecycle', ts: Date.now(), data: { state } }) }
  function emitNotice(id, level, text) { deliver({ sessionId: id, kind: 'notice', ts: Date.now(), data: { level, text } }) }

  function startTicker(s) {
    const t0 = Date.now()
    s.ticker = setInterval(() => {
      const runs = s.toolRun
        ? [{ id: 1, name: s.toolRun.name, argsText: s.toolRun.argsText, preview: s.toolRun.preview, status: s.toolRun.status, startedAt: s.toolRun.startedAt, finishedAt: s.toolRun.finishedAt, ms: s.toolRun.finishedAt ? s.toolRun.finishedAt - s.toolRun.startedAt : 0, ok: s.toolRun.status === 'done' }]
        : []
      emitTick(s.id, tickOf(s, {
        flow: {
          stage: s.stage, turn: s.turn, activeTool: s.activeTool, toolStartedAt: s.toolStartedAt,
          toolsOk: s.toolsOk, toolsFailed: s.toolsFailed, messages: s.messages,
          toolRuns: runs,
          plan: s.planSnapshot ? { done: s.planDone, total: s.planTotal, source: 'agent' } : null,
          usage: usedUsage(s.usageTotals),
        },
        hud: { elapsedMs: Date.now() - t0, phase: s.stage, stats: usedUsage(s.usageTotals) },
        plan: s.planSnapshot ?? null,
      }))
    }, 90)
  }
  function stopTicker(s) { if (s.ticker) { clearInterval(s.ticker); s.ticker = null } }

  // One scripted turn — mirrors the smoke story: plan → gated run_command →
  // reply. gate=false turns run in echo mode. Queued prompts drain after.
  async function runTurn(s, prompt) {
    s.busy = true
    s.aborted = false
    s.turn += 1
    s.stage = 'send'
    s.messages += 2
    emitLifecycle(s.id, 'running')
    startTicker(s)
    emitNotice(s.id, 'info', `turn ${s.turn} started`)

    emitLoop(s.id, [loopEvent({ type: 'wire', phase: 'send', messages: s.messages, tokens: 8200 })])
    s.stage = 'think'
    if (await nap(s, 140)) {
      finishAborted(s)
      return
    }
    emitLoop(s.id, [
      loopEvent({ type: 'progress', progress: { kind: 'thinking', text: 'cross-referencing JNI_OnLoad callers — license gate likely in nativeInit()', tool: '', status: '', usage: null, plan: null, planNote: '' } }),
      loopEvent({ type: 'progress', progress: { kind: 'thinking', text: 'dispatcher at entry0+0x8f4c: flattened switch on state var v3', tool: '', status: '', usage: null, plan: null, planNote: '' } }),
    ])
    if (await nap(s, 120)) {
      finishAborted(s)
      return
    }

    // plan snapshot (smoke story steps 1-3) — pending steps omit zero fields
    // the way Go's omitempty does
    s.planSnapshot = {
      steps: [
        { text: 'Publish smoke plan', status: 'completed', id: 'p1', startedAt: Date.now(), completedAt: Date.now() },
        { text: 'Approval-gated command writes artifact', status: 'in_progress', id: 'p2', startedAt: Date.now(), completedAt: 0 },
        { text: 'Confirm final reply', status: 'pending' },
      ],
      source: 'agent', note: '', updatedAt: Date.now(),
    }
    emitLoop(s.id, [
      loopEvent({ type: 'plan', snapshot: s.planSnapshot }),
      loopEvent({ type: 'progress', progress: { kind: 'plan', text: '', tool: '', status: '', usage: null, plan: s.planSnapshot.steps.slice(0, 1), planNote: 'GUI smoke: plan events' } }),
    ])
    await sleep(120)

    // slow window for the stop-button scenario: a long "tool planning" stretch
    // that only ends early when Interrupt fires
    if (s.slowNext) {
      s.slowNext = false
      s.stage = 'calls'
      if (await nap(s, 4000)) {
        finishAborted(s)
        return
      }
    }

    const gated = s.gateNext
    s.gateNext = false
    s.stage = 'tool'
    s.activeTool = 'run_command'
    s.toolStartedAt = Date.now()
    s.toolRun = { name: 'run_command', argsText: 'curl --version > smoke-ok.txt', preview: '', status: 'running', startedAt: Date.now(), finishedAt: 0 }
    emitLoop(s.id, [loopEvent({ type: 'tool_start', name: 'run_command', args: { command: 'curl --version > smoke-ok.txt' }, preview: 'curl --version > smoke-ok.txt' })])

    let decision = 'allow'
    if (gated) {
      approvalSeq += 1
      const requestID = `apr-${String(approvalSeq).padStart(4, '0')}`
      s.pending = requestID
      await sleep(100)
      deliver({
        sessionId: s.id, kind: 'approval', ts: Date.now(),
        data: { requestID, toolName: 'run_command', risk: 'exec', summary: `run command: ${prompt.slice(0, 40)}`, argsPreview: 'curl --version > smoke-ok.txt' },
      })
      decision = await new Promise((res) => { s.gateResolve = res })
      s.pending = null
    }
    await sleep(150)

    const allowed = decision === 'allow' || decision === 'allow-always'
    s.activeTool = ''
    s.toolStartedAt = 0
    s.toolRun = { name: 'run_command', argsText: 'curl --version > smoke-ok.txt', preview: allowed ? 'curl 8.4.0 (x86_64-apple-darwin)' : '', status: allowed ? 'done' : 'failed', startedAt: Date.now() - 150, finishedAt: Date.now() }
    if (allowed) {
      s.toolsOk += 1
      emitLoop(s.id, [loopEvent({ type: 'tool_end', name: 'run_command', ok: true, ms: 132, preview: 'curl 8.4.0 (x86_64-apple-darwin)' })])
    } else {
      s.toolsFailed += 1
      emitLoop(s.id, [loopEvent({ type: 'tool_end', name: 'run_command', ok: false, ms: 3, preview: '', error: 'denied by operator' })])
    }
    await sleep(100)

    // resolve the plan and reply — a mock provider reports zero usage, which
    // crosses the wire as `{}` (omitempty); deny must NOT complete the plan
    if (allowed) {
      s.planDone = 3
      s.planSnapshot = {
        steps: [
          { text: 'Publish smoke plan', status: 'completed', id: 'p1', startedAt: Date.now(), completedAt: Date.now() },
          { text: 'Approval-gated command writes artifact', status: 'completed', id: 'p2', startedAt: Date.now(), completedAt: Date.now() },
          { text: 'Confirm final reply', status: 'completed', id: 'p3', startedAt: Date.now(), completedAt: Date.now() },
        ],
        source: 'agent', note: '', updatedAt: Date.now(),
      }
    } else {
      s.planSnapshot = {
        steps: [
          { text: 'Publish smoke plan', status: 'completed', id: 'p1', startedAt: Date.now(), completedAt: Date.now() },
          { text: 'Approval-gated command writes artifact', status: 'in_progress', id: 'p2', startedAt: Date.now(), completedAt: 0 },
          { text: 'Confirm final reply', status: 'pending' },
        ],
        source: 'agent', note: 'blocked: command denied', updatedAt: Date.now(),
      }
    }
    s.stage = 'write'
    const reply = gated
      ? allowed
        ? 'Smoke complete — the approved command wrote smoke-ok.txt and the plan advanced.'
        : 'Aborted — the command was denied, nothing was written.'
      : `Mock reply: ${prompt}`
    emitLoop(s.id, [
      loopEvent({ type: 'plan', snapshot: s.planSnapshot }),
      loopEvent({ type: 'reply', text: reply, textChars: reply.length, ok: true, usage: usedUsage(s.usageTotals) }),
    ])
    s.stage = 'done'
    await sleep(80)

    stopTicker(s)
    s.busy = false
    s.stage = 'idle'
    emitLifecycle(s.id, 'idle')
    emitTick(s.id, tickOf(s, { flow: { stage: 'done', turn: s.turn, toolsOk: s.toolsOk, toolsFailed: s.toolsFailed, messages: s.messages } }))

    // drain the queue like guiQueue does
    if (s.queue.length > 0) {
      const next = s.queue.shift()
      emitNotice(s.id, 'info', `running queued prompt`)
      emitTick(s.id, tickOf(s, { flow: { stage: 'idle' }, hud: { queueCount: s.queue.length } }))
      await runTurn(s, next)
    }
  }

  const BUILTIN = ['/help', '/theme', '/workflow', '/phase', '/model', '/planner', '/executor', '/think', '/tasks', '/queue', '/compact', '/sessions', '/new']

  window.go = {
    main: {
      App: {
        async StartSession(opts) {
          await sleep(40)
          seq += 1
          const id = `s-${seq}`
          const info = {
            id, workspace: opts.workspace || '.', role: opts.role || 'auto',
            workflow: opts.workflow || '', planner: 'mock-planner', executor: 'mock-executor',
            lifecycle: 'idle',
          }
          const s = { id, info, busy: false, queue: [], stage: 'idle', turn: 0, messages: 0, toolsOk: 0, toolsFailed: 0, activeTool: '', toolStartedAt: 0, planSnapshot: null, planDone: 0, planTotal: 0, toolRun: null, usageTotals: {}, ticker: null, pending: null, gateResolve: null, gateNext: false, aborted: false, abortNotify: null, slowNext: false }
          sessions.set(id, s)
          // manager emits a state-change tick right after Start
          emitTick(id, tickOf(s))
          return info
        },
        async ResumeSession(id) {
          await sleep(30)
          if (!sessions.has(id)) throw `no such session: ${id}`
          return sessions.get(id).info
        },
        async ListSessions() {
          await sleep(20)
          return []
        },
        async CloseSession(id) {
          await sleep(20)
          const s = sessions.get(id)
          if (!s) throw `no such session: ${id}`
          if (s.gateResolve) { s.gateResolve('deny'); s.gateResolve = null }
          stopTicker(s)
          if (s.busy) emitLifecycle(id, 'closed')
          sessions.delete(id)
        },
        async SendPrompt(id, text) {
          const s = sessions.get(id)
          if (!s) throw `no such session: ${id}`
          if (s.busy) {
            s.queue.push(text)
            emitNotice(id, 'info', `queued #${s.queue.length} for the next turn`)
            emitTick(id, tickOf(s, { flow: { stage: s.stage, turn: s.turn, activeTool: s.activeTool }, hud: { queueCount: s.queue.length } }))
            return
          }
          void runTurn(s, text)
        },
        async SendCommand(id, line) {
          await sleep(25)
          if (!sessions.has(id)) throw `no such session: ${id}`
          return { ok: true, notices: [{ level: 'info', text: `[mock] command ${line} acknowledged` }] }
        },
        async Approve(id, requestID, decision) {
          const s = sessions.get(id)
          if (!s || s.pending !== requestID || !s.gateResolve) throw `no pending approval ${requestID}`
          const res = s.gateResolve
          s.gateResolve = null
          res(decision)
        },
        async Interrupt(id) {
          const s = sessions.get(id)
          if (!s) throw `no such session: ${id}`
          // a gated turn unwinds through its gate decision; any other point
          // in the turn through the abort flag + notify the naps race on
          if (s.gateResolve) {
            const res = s.gateResolve
            s.gateResolve = null
            res('deny')
            return true
          }
          if (s.busy) {
            s.aborted = true
            if (s.abortNotify) s.abortNotify()
            return true
          }
          return false
        },
        async GetState(id) {
          const s = sessions.get(id)
          if (!s) throw `no such session: ${id}`
          return tickOf(s)
        },
        async Completions(line) {
          await sleep(15)
          const words = line.trim().split(/\s+/)
          if (words.length > 1 || /\s$/.test(line)) return []
          const frag = words[0] || '/'
          const hits = BUILTIN.filter((c) => c.startsWith(frag))
          return (hits.length > 0 ? hits : BUILTIN).map((c) => `${c} `)
        },
        async GetThemes() {
          await sleep(10)
          return ['deck', 'amber', 'matrix', 'mono']
        },
      },
    },
  }

  // test control surface
  window.__reTest = {
    gateOn(id) { const s = sessions.get(id); if (s) s.gateNext = true },
    emit(envelope) { deliver(envelope) },
    floodLoop(id, n) {
      const events = []
      for (let i = 0; i < n; i += 1) {
        events.push(loopEvent({ type: 'progress', progress: { kind: 'status', text: `flood ${i}`, tool: '', status: '', usage: null, plan: null, planNote: '' } }))
      }
      emitLoop(id, events)
    },
    turnGated(id) { const s = sessions.get(id); if (s) s.gateNext = true },
    slowNext(id) { const s = sessions.get(id); if (s) s.slowNext = true },
  }
}

// ---------- driver ----------

mkdirSync(ARTIFACTS, { recursive: true })

async function waitFor(page, text, timeout = 8000) {
  // substring match (unquoted text=) — panel titles carry decorations like "SESSIONS · 2"
  await page.waitForSelector(`text=${text}`, { timeout })
}

let stepNo = 0
async function step(name, fn, page) {
  stepNo += 1
  const label = `S${stepNo} ${name}`
  try {
    await fn()
    console.log(`  ✓ ${label}`)
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`)
    await page.screenshot({ path: join(ARTIFACTS, `fail-S${stepNo}-${name.replace(/\W+/g, '-')}.png`), fullPage: true }).catch(() => {})
    throw err
  }
}

// error collectors at module scope so the abort handler can dump them
const consoleErrors = []
const consoleWarnings = []
const pageErrors = []

async function main() {
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res))
  console.log(`serving ${DIST} on http://127.0.0.1:${PORT}`)

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
    else if (m.type() === 'warning') consoleWarnings.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))
  page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`))

  const shot = (name) => page.screenshot({ path: join(ARTIFACTS, `${String(stepNo + 1).padStart(2, '0')}-${name}.png`) })

  await page.addInitScript(installShim)
  await page.goto(`http://127.0.0.1:${PORT}/`)

  // S1 boot
  await step('boot reaches shell', async () => {
    await waitFor(page, 'SESSIONS')
    await page.waitForSelector('textarea', { timeout: 8000 })
  }, page)
  await shot('boot-shell')

  // S2 create session
  let sid1
  await step('create session via dialog', async () => {
    await page.getByTitle('new session').click()
    await waitFor(page, 'workspace')
    await page.getByPlaceholder('/abs/path/to/workspace').fill('/tmp/0xaf-e2e-ws-alpha')
    await page.getByRole('button', { name: 'start session' }).click()
    await waitFor(page, 'session s-1 started')
    await waitFor(page, '0xaf-e2e-ws-alpha') // sidebar entry (basename)
    await waitFor(page, 'NO SIGNAL', 2500).catch(() => {}) // pre-tick state, optional
  }, page)
  await shot('session-created')

  // S3 prompt → stream → approval
  await step('prompt streams and gates on approval', async () => {
    await page.evaluate(() => window.__reTest.turnGated('s-1'))
    await page.locator('textarea').fill('find the license check')
    await page.keyboard.press('Enter')
    await waitFor(page, 'running') // PromptInput footer
    await waitFor(page, 'cross-referencing JNI_OnLoad callers') // think line → transcript
    await waitFor(page, 'TOOL APPROVAL')
    await waitFor(page, 'run_command')
    await waitFor(page, 'curl --version > smoke-ok.txt')
    const focused = await page.evaluate(() => document.activeElement?.textContent)
    if (focused !== 'deny') throw new Error(`deny not focused, active=${focused}`)
  }, page)
  await shot('approval-gate')

  // S4 queue a second prompt while running
  await step('queued prompt shows hint bar', async () => {
    await page.locator('textarea').fill('also check section entropy')
    await page.keyboard.press('Enter')
    await waitFor(page, 'queued (1)')
  }, page)
  await shot('queue-hint')

  // S5 allow → artifact reply → idle → queue drains
  await step('allow resolves, turn completes, queue drains', async () => {
    await page.getByRole('button', { name: 'allow', exact: true }).click()
    await waitFor(page, 'Smoke complete — the approved command wrote smoke-ok.txt')
    await waitFor(page, 'Mock reply: also check section entropy', 15000) // queue drained
    await waitFor(page, '○ idle')
  }, page)
  await shot('turn-complete')

  // S6 slash command via palette — production Completions returns bare lines
  // (no descriptions), so the palette items are just '/help ' strings
  await step('slash palette and command notice', async () => {
    await page.locator('textarea').fill('/help')
    await page.getByText('/help', { exact: false }).first().waitFor({ timeout: 8000 })
    await page.keyboard.press('Enter') // applies completion → '/help '
    const value = await page.locator('textarea').inputValue()
    if (!value.startsWith('/help')) throw new Error(`completion not applied, value=${value}`)
    await page.keyboard.press('Enter') // sends
    await waitFor(page, '[mock] command /help acknowledged')
  }, page)
  await shot('slash-command')

  // S7 second session + buffer isolation
  await step('second session, buffers isolated', async () => {
    await page.getByTitle('new session').click()
    await waitFor(page, 'workspace')
    await page.getByPlaceholder('/abs/path/to/workspace').fill('/tmp/0xaf-e2e-ws-beta')
    await page.getByRole('button', { name: 'start session' }).click()
    await waitFor(page, 'session s-2 started')
    // active = s-2 → transcript must NOT contain s-1's reply
    const betaText = await page.locator('body').textContent()
    if (betaText.includes('Smoke complete')) throw new Error('s-1 buffer leaked into s-2 view')
    // switch back to s-1 → reply visible again
    await page.getByText('0xaf-e2e-ws-alpha', { exact: true }).click()
    await waitFor(page, 'Smoke complete — the approved command wrote smoke-ok.txt')
    // and to s-2 again
    await page.getByText('0xaf-e2e-ws-beta', { exact: true }).click()
  }, page)
  await shot('buffer-isolation')

  // S8 deny path with Esc
  await step('Esc denies the approval', async () => {
    await page.evaluate(() => window.__reTest.turnGated('s-2'))
    await page.locator('textarea').fill('trigger the gate')
    await page.keyboard.press('Enter')
    await waitFor(page, 'TOOL APPROVAL')
    await page.keyboard.press('Escape')
    await waitFor(page, 'Aborted — the command was denied')
    await waitFor(page, '○ idle')
    const overlayGone = (await page.locator('text=TOOL APPROVAL').count()) === 0
    if (!overlayGone) throw new Error('approval overlay still visible after deny')
  }, page)
  await shot('deny-esc')

  // S9 close session, active reseats
  await step('close session reseats active', async () => {
    const row = page.locator('div', { has: page.getByText('0xaf-e2e-ws-beta', { exact: true }) }).last()
    await row.getByTitle('close session').click()
    await waitFor(page, 'session s-2 closed')
    await waitFor(page, 'Smoke complete — the approved command wrote smoke-ok.txt') // reseat → s-1
  }, page)
  await shot('session-closed')

  // S10 theme switch
  await step('theme switch applies data-theme', async () => {
    await page.locator('label:has-text("theme") select').selectOption('amber')
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    if (theme !== 'amber') throw new Error(`data-theme=${theme}`)
  }, page)
  await shot('theme-amber')

  // S11 flood: one 600-event batch must not crash (LOOP_LIMIT 500 ring)
  await step('600-event batch survives ring cap', async () => {
    await page.evaluate(() => window.__reTest.floodLoop('s-1', 600))
    await page.waitForTimeout(600)
    await waitFor(page, 'flood 599') // newest survived
  }, page)
  await shot('flood-capped')

  // S12 stop button interrupts a slow turn mid-flight (the approval overlay
  // would block the footer while a gate is up, so this uses the long non-gated
  // window instead)
  await step('stop button interrupts the turn', async () => {
    await page.evaluate(() => window.__reTest.slowNext('s-1'))
    await page.locator('textarea').fill('stoppable turn')
    await page.keyboard.press('Enter')
    await waitFor(page, '■ stop')
    await page.getByTitle('abort the current turn (queue survives)').click()
    await waitFor(page, 'interrupted')
    await waitFor(page, '○ idle')
  }, page)
  await shot('stop-interrupt')

  // verdict
  await browser.close()
  server.close()

  console.log('\n──── runtime e2e summary ────')
  console.log(`console errors:   ${consoleErrors.length}${consoleErrors.length ? '\n  ' + consoleErrors.join('\n  ') : ''}`)
  console.log(`console warnings: ${consoleWarnings.length}${consoleWarnings.length ? '\n  ' + consoleWarnings.slice(0, 10).join('\n  ') : ''}`)
  console.log(`page errors:      ${pageErrors.length}${pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : ''}`)

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    console.error('FAIL: console/page errors present')
    process.exit(1)
  }
  console.log('PASS: all steps green, no console/page errors')
}

main().catch((err) => {
  console.error(`\nE2E aborted: ${err.message}`)
  if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`)
  if (consoleErrors.length) console.error(`console errors:\n  ${consoleErrors.join('\n  ')}`)
  process.exit(1)
})
