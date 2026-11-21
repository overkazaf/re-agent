// Theater 自动降级链（Task D）：WebGL 不可用 / prefers-reduced-motion /
// 持续掉帧 → 回调触发，集成层据此切回经典视图并 toast 提示。
// 哨兵有冷却时间：自动降级后用户仍可手动再进 3D（30s 内不再自动踢出）。
import { useEffect, useRef } from 'react'

/** 真实可用的 WebGL 上下文（webgl2 优先，退化 webgl）。 */
export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface TheaterFallbackReason {
  kind: 'no-webgl' | 'reduced-motion' | 'low-fps'
}

const COOLDOWN_MS = 30_000
const FPS_FLOOR = 30
const LOW_FPS_WINDOW_MS = 5_000

/**
 * 挂载在 theater 模式下：
 * - 立即检查 WebGL / reduced-motion，不满足直接回调
 * - rAF 采样帧率，<30fps 持续 5s 才回调（避免瞬时抖动误杀）
 * - 冷却期内（自动降级后 30s）不再触发
 * 返回清理函数。unmount 即停止哨兵。
 */
export function useTheaterFallback(onFallback: (reason: TheaterFallbackReason) => void): void {
  const cbRef = useRef(onFallback)
  cbRef.current = onFallback

  useEffect(() => {
    let cooledUntil = 0
    let raf = 0
    let windowStart = 0
    let frames = 0

    if (!hasWebGL()) {
      cbRef.current({ kind: 'no-webgl' })
      return
    }
    if (prefersReducedMotion()) {
      cbRef.current({ kind: 'reduced-motion' })
      return
    }

    const tick = (t: number) => {
      if (t >= cooledUntil) {
        if (windowStart === 0) windowStart = t
        frames += 1
        const elapsed = t - windowStart
        if (elapsed >= LOW_FPS_WINDOW_MS) {
          const fps = (frames * 1000) / elapsed
          if (fps < FPS_FLOOR) {
            cooledUntil = t + COOLDOWN_MS
            cbRef.current({ kind: 'low-fps' })
          }
          windowStart = t
          frames = 0
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
}
