# 3D 取证剧场（3D Forensic Theater）设计

- **日期**: 2026-11-21
- **分支**: `feat/3d-forensic-theater`
- **状态**: 设计已确认，待实施
- **目标**: 把取证/审计过程以全面 3D 化方式动态呈现；把「假设 → 实验 → 验证 → 审计」
  收敛为空间中的引导式主线；解决现有功能点散、交互不顺的问题。

## 已确认的三个关键决策

| 决策点 | 选择 |
| --- | --- |
| 3D 技术路线 | **全面 3D 化**（three.js / R3F，面板群进 3D 空间，切换 = 运镜） |
| 主线交互形态 | **引导式主线**（向导 + 摄像机沿 9 阶段骨架飞行，可跳过可回退） |
| 与经典界面关系 | **3D 为主 + 经典回退**（TopBar 切换，现有组件全保留，e2e 分阶段迁移） |

## 1. 技术架构与分层

**新增依赖**: `three` + `@react-three/fiber` + `@react-three/drei`。
three ≈ 150KB gzip，GitHub Pages demo 可承受；WKWebView（macOS）与浏览器均支持 WebGL。

```
┌─ DOM HUD 层（React，永远在最上）────────────┐
│  TopBar / 向导卡片 / 审批弹窗 / 输入框 / toast  │
├─ WebGL 场景层（R3F canvas，铺满中下层）──────┤
│  3D 面板群 / 证据 DAG / 相位主线路径 / 粒子    │
├─ 数据层（不变）────────────────────────────┤
│  store/sessions + lib/api + demo/backend     │
└─────────────────────────────────────────────┘
```

- **DOM HUD 层**: 审批门、prompt 输入、向导表单保持 DOM（文字输入、无障碍、
  焦点管理最可靠），现有 ApprovalDialog / PromptInput 零改动复用。
- **WebGL 层**: 只负责空间、节点、运镜、粒子。90ms tick 数据在场景内做
  **节流聚合**（约 250ms 批量更新 instanced 属性）。不把 DOM 面板贴成纹理 —
  转录流和五维仪表在 3D 模式下是「全息柱面摘要」，完整内容回经典视图看。
- **摄像机**: 默认斜 45° 俯瞰；滚轮缩放、右键平移、点空白回全局；
  点节点/区域 = drei CameraControls 平滑运镜（约 600ms ease）。
- **主题**: 4 套 CRT 主题 CSS 变量映射为 three 材质参数（线框色、辉光强度、
  雾色），切主题即时生效。

## 2. 3D 空间布局（「作战室」）

9 阶段 RE 工作流是空间骨架（TRI 近景入口 → AUD 深处审计拱门）：

```
         AUD 审计拱门（孤立高台，冷光，-Z 深处）
   VER 验证台 ←─┴─→ DEL 交付坞
         EXP 实验平台（中景）
   HYP 假设塔(左) ─┼─ SCR 勘查屏(右)
         TRI 三角洲（入口，+Z 用户视点）
```

- **主线路径**: 发光能量脊 TRI→AUD，当前阶段脉冲最亮；已完成段实心、
  未到段虚线。即 RE HUD 的 3D 化。
- **证据 DAG**: 从假设塔向上生长。`ev_NNN` 发光多面体、`H-NN` 塔顶棱镜；
  支持边（绿）光束、矛盾边（红）锯齿闪烁；被拒假设半透明 + 降悬浮高度；
  节点随置信度缩放，验证通过迸发粒子。
- **会话区**: 多 session = 多条平行主线并排悬浮；侧栏选中即运镜。
- **面板群**: TRANSCRIPT 摘要柱、TELE 遥测条、QUEUE 计数环为中低空
  全息仪表，点击放大展开（DOM 弹层）。
- **空态**: 无 session 时只剩 TRI 入口呼吸光（呼应 `░ NO SIGNAL ░`）。

## 3. 引导式主线交互（解决「散」的核心）

入口收敛两处：主线路径上 HYP 塔发亮 +「+ 假设」浮标；TopBar 下沿 HUD 建议条。

向导流（DOM HUD 卡片 + 摄像机同步飞行）：

1. **提出假设**（飞抵 HYP 塔）: 描述 + 可证伪预测必填；可挂靠场景中发光
   ev_NNN（点选连出预览光束）；确认后塔上即时生长 H-NN 草稿态棱镜。
2. **配置实验**（滑向 EXP 平台）: 实验类型卡片（static_probe / sandbox_trace /
   artifact_replay）；沙箱选择可视化 /goal 契约 scope（可写路径、网络开关），
   不可用项灰化并解释 —— 即「引导配置」；预填命令模板可编辑。
3. **运行期**: 摄像机留 EXP，产出滚动于摘要柱。PASSED → 绿粒子迸发 +
   新 ev_NNN 铸造飞入 DAG；FAILED → 红色回流沿主线倒流回 HYP 塔，
   向导卡变体「修正假设」（预填原描述+预测+失败证据链接）。
4. **验证**（VER 台）: verify_artifact 向导，产物路径从实验结果自动带入。
5. **审计签发**（AUD 拱门）: SubmitReview；通过后主线定格金色「已归档」。

- **HUD 建议条**: 常驻 TopBar 下沿，按 RE 阶段 + 假设栈状态推荐下一步
  （"H-003 未配实验 → [去配置]"），点击 = 飞行 + 打开对应向导。可关闭。
- 每步可跳过、可回退 — 向导是扶手不是漏斗。中断/审批门优先级高于向导，
  照旧走 DOM ApprovalDialog。

## 4. 数据流、降级与测试

```
Wails Go ──┬─► store/sessions (zustand) ──► DOM HUD（不变）
demo 后端 ──┤          │
            └─► store/scene.ts ──► R3F 场景
                 (派生: 节点坐标、相位进度、建议条决策、摄像机目标)
```

- `store/scene.ts` 是唯一派生层；向导动作直接调现有 actions/api
  （MutateHypothesis / RunHypothesisExperiment / RunVerification / SubmitReview），
  成功后 tick 回流驱动场景 — 不发明第二套数据路径；demo 沙箱共享 store
  自动获得全部 3D 能力。
- **降级链**: WebGL 不可用 / prefers-reduced-motion / 连续掉帧（<30fps 超 5s）
  → 顶栏提示并自动切回经典视图（可手动再进）。向导 API 失败 → toast +
  节点红闪 + 停在原步可重试。
- **测试**: scene.ts 派生逻辑纯函数单测；Playwright e2e 加 3D 用例
  （进入 3D → 假设向导 → mock 实验 → 断言 DOM HUD 节点计数与经典视图一致）；
  test:e2e-demo 走 demo 后端同路径；每主题截 3 帧视觉回归 + README 更新。

## 实施分期（每期独立可合，经典视图始终可用）

1. 场景骨架 + 摄像机 + 主题材质（无可交互内容）
2. 证据 DAG 节点生长 + 主线相位脊
3. 向导流 ①②③（假设 + 实验 + 修正回流）
4. 向导流 ④⑤ + HUD 建议条 + 降级链
5. e2e 补齐 + README / 截图更新
