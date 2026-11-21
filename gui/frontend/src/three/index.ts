// three/ 对外出口：只暴露剧场主组件与喂入数据的类型（内部模块不对外，防止绕过契约）。
export { ForensicTheater } from './ForensicTheater'
export type { ForensicTheaterProps } from './ForensicTheater'
export type { HoloHudData } from './HoloPanels'
