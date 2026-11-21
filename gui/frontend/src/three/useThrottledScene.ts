// useThrottledScene — 90ms tick 会在 store 层高频更换 scene 引用；
// 场景树以 ≤4Hz（默认 250ms）消费：间隔不足时返回旧引用，
// 打点之间的重渲染被吞掉，trailing 定时器保证最终状态不丢。
import { useEffect, useRef, useState } from 'react'
import type { SceneState } from './contract'
import { useSceneStore } from '../store/scene'

export function useThrottledScene(ms = 250): SceneState {
  const scene = useSceneStore().scene
  const latest = useRef(scene)
  latest.current = scene
  const committed = useRef(scene)
  const lastAt = useRef(0)
  const timer = useRef<number | null>(null)
  const [, bump] = useState(0)

  useEffect(() => {
    if (scene === committed.current) return
    const commit = () => {
      timer.current = null
      committed.current = latest.current
      lastAt.current = Date.now()
      bump((n) => n + 1)
    }
    const wait = ms - (Date.now() - lastAt.current)
    if (wait <= 0) {
      commit()
    } else if (timer.current === null) {
      timer.current = window.setTimeout(commit, wait)
    }
  }, [scene, ms])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  return committed.current
}
