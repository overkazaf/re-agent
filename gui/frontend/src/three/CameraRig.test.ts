import { describe, expect, it } from 'vitest'
import {
  CAMERA_PRESETS,
  CAMERA_PRESET_LIST,
  HOME_POS,
  HOME_TARGET,
  computeCameraTelemetry,
  formatCameraTelemetry,
  hasOpenModalDialog,
  isEditableEventTarget,
  resolveTheaterShortcut,
} from './CameraRig'
import { zoneOf } from './contract'
import { sceneActions } from '../store/scene'

describe('CAMERA_PRESETS', () => {
  it('defines 4 calibrated presets with finite coordinates and matching HOME exports', () => {
    expect(CAMERA_PRESET_LIST.map((p) => p.key)).toEqual(['overview', 'tactical', 'hyp', 'radar'])
    expect(CAMERA_PRESET_LIST.map((p) => p.shortcut)).toEqual(['1', '2', '3', '4'])

    expect(CAMERA_PRESETS.overview.position).toEqual([0, 72, 124])
    expect(CAMERA_PRESETS.overview.target).toEqual([0, 3, -6])
    expect(HOME_POS).toEqual(CAMERA_PRESETS.overview.position)
    expect(HOME_TARGET).toEqual(CAMERA_PRESETS.overview.target)

    expect(CAMERA_PRESETS.tactical.position).toEqual([68, 38, 86])
    expect(CAMERA_PRESETS.tactical.target).toEqual([0, 6, -12])

    expect(CAMERA_PRESETS.radar.position).toEqual([0, 148, 22])
    expect(CAMERA_PRESETS.radar.target).toEqual([0, 0, -8])

    for (const preset of CAMERA_PRESET_LIST) {
      expect(preset.position).toHaveLength(3)
      expect(preset.target).toHaveLength(3)
      for (const n of [...preset.position, ...preset.target]) {
        expect(Number.isFinite(n)).toBe(true)
      }
    }
  })

  it('frames the HYP tower close-up around HYP zone center and radar overhead at steep elevation', () => {
    const hypZone = zoneOf('HYP').center
    const hyp = CAMERA_PRESETS.hyp
    expect(hyp.target[0]).toBe(hypZone[0])
    expect(hyp.target[2]).toBe(hypZone[2])
    expect(hyp.target[1]).toBeGreaterThan(0)
    const hypTel = computeCameraTelemetry(hyp.position, hyp.target)
    expect(hypTel.distance).toBeGreaterThan(20)
    expect(hypTel.distance).toBeLessThan(65)

    const radarTel = computeCameraTelemetry(CAMERA_PRESETS.radar.position, CAMERA_PRESETS.radar.target)
    expect(radarTel.elevationDeg).toBeGreaterThan(75)
  })
})

describe('computeCameraTelemetry & formatCameraTelemetry', () => {
  it('computes cardinal azimuths cleanly in [0, 360)', () => {
    expect(computeCameraTelemetry([0, 0, 100], [0, 0, 0]).azimuthDeg).toBeCloseTo(0, 5)
    expect(computeCameraTelemetry([100, 0, 0], [0, 0, 0]).azimuthDeg).toBeCloseTo(90, 5)
    expect(computeCameraTelemetry([0, 0, -100], [0, 0, 0]).azimuthDeg).toBeCloseTo(180, 5)
    expect(computeCameraTelemetry([-100, 0, 0], [0, 0, 0]).azimuthDeg).toBeCloseTo(270, 5)
  })

  it('computes elevation and Euclidean distance accurately', () => {
    const t45 = computeCameraTelemetry([0, 10, 10], [0, 0, 0])
    expect(t45.elevationDeg).toBeCloseTo(45, 5)
    expect(t45.distance).toBeCloseTo(Math.SQRT2 * 10, 5)

    const overhead = computeCameraTelemetry([0, 120, 0], [0, 0, 0])
    expect(overhead.elevationDeg).toBeCloseTo(90, 5)
    expect(overhead.distance).toBeCloseTo(120, 5)

    const degenerate = computeCameraTelemetry([5, 5, 5], [5, 5, 5])
    expect(degenerate).toEqual({ azimuthDeg: 0, elevationDeg: 0, distance: 0 })
  })

  it('formats crisp padded telemetry strings including wrap-around and negative elevation', () => {
    expect(formatCameraTelemetry({ azimuthDeg: 38.2, elevationDeg: 30.6, distance: 141.7 })).toBe(
      'AZ 038° · EL 31° · D 142',
    )
    expect(formatCameraTelemetry({ azimuthDeg: 359.7, elevationDeg: 4.2, distance: 99.4 })).toBe(
      'AZ 000° · EL 04° · D 99',
    )
    expect(formatCameraTelemetry({ azimuthDeg: 180, elevationDeg: -6.1, distance: 50 })).toBe(
      'AZ 180° · EL -06° · D 50',
    )
  })
})

describe('keyboard shortcut guards & resolver', () => {
  it('maps 1-4, R, Space, and Esc when unblocked', () => {
    const open = { editable: false, modalOpen: false, hasFocus: false }
    expect(resolveTheaterShortcut({ key: '1' }, open)).toEqual({ kind: 'preset', preset: 'overview' })
    expect(resolveTheaterShortcut({ key: '2' }, open)).toEqual({ kind: 'preset', preset: 'tactical' })
    expect(resolveTheaterShortcut({ key: '3' }, open)).toEqual({ kind: 'preset', preset: 'hyp' })
    expect(resolveTheaterShortcut({ key: '4' }, open)).toEqual({ kind: 'preset', preset: 'radar' })
    expect(resolveTheaterShortcut({ key: 'r' }, open)).toEqual({ kind: 'reset' })
    expect(resolveTheaterShortcut({ key: 'R' }, open)).toEqual({ kind: 'reset' })
    expect(resolveTheaterShortcut({ key: ' ' }, open)).toEqual({ kind: 'toggle-orbit' })
    expect(resolveTheaterShortcut({ key: ' ', repeat: true }, open)).toBeNull()
    expect(resolveTheaterShortcut({ key: 'Escape' }, open)).toBeNull()
    expect(resolveTheaterShortcut({ key: 'Escape' }, { ...open, hasFocus: true })).toEqual({
      kind: 'clear-focus',
    })
  })

  it('ignores shortcuts inside editable controls, when modals are open, or with modifier keys', () => {
    const open = { editable: false, modalOpen: false, hasFocus: true }
    expect(resolveTheaterShortcut({ key: '1' }, { ...open, editable: true })).toBeNull()
    expect(resolveTheaterShortcut({ key: ' ' }, { ...open, modalOpen: true })).toBeNull()
    expect(resolveTheaterShortcut({ key: 'r' }, { ...open, modalOpen: true })).toBeNull()
    expect(resolveTheaterShortcut({ key: '1', metaKey: true }, open)).toBeNull()
    expect(resolveTheaterShortcut({ key: '2', ctrlKey: true }, open)).toBeNull()
    expect(resolveTheaterShortcut({ key: '3', altKey: true }, open)).toBeNull()
    expect(resolveTheaterShortcut({ key: '4', defaultPrevented: true }, open)).toBeNull()
  })

  it('detects editable targets and open modal dialogs safely', () => {
    expect(isEditableEventTarget(null)).toBe(false)
    expect(isEditableEventTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableEventTarget({ tagName: 'textarea' })).toBe(true)
    expect(isEditableEventTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableEventTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableEventTarget({ tagName: 'SPAN', closest: () => ({}) })).toBe(true)
    expect(isEditableEventTarget({ tagName: 'CANVAS', closest: () => null })).toBe(false)

    expect(hasOpenModalDialog(null)).toBe(false)
    expect(hasOpenModalDialog({ querySelector: () => null })).toBe(false)
    expect(hasOpenModalDialog({ querySelector: () => ({}) as Element })).toBe(true)
  })
})

describe('scene store tactical camera & layer actions', () => {
  it('updates presets, layer toggles, autoOrbit, and resets cleanly', () => {
    sceneActions.resetCamera()
    const basePresetNonce = sceneActions.cameraPresetNonce
    const baseFocusNonce = sceneActions.focusNonce

    sceneActions.setCameraPreset('tactical')
    expect(sceneActions.cameraPreset).toBe('tactical')
    expect(sceneActions.cameraPresetNonce).toBe(basePresetNonce + 1)

    // Re-selecting same preset still bumps nonce so camera re-frames after manual drag.
    sceneActions.setCameraPreset('tactical')
    expect(sceneActions.cameraPresetNonce).toBe(basePresetNonce + 2)

    sceneActions.toggleAutoOrbit()
    expect(sceneActions.autoOrbit).toBe(true)
    sceneActions.setAutoOrbit(false)
    expect(sceneActions.autoOrbit).toBe(false)

    const g0 = sceneActions.showGrid
    sceneActions.toggleGrid()
    expect(sceneActions.showGrid).toBe(!g0)
    sceneActions.toggleGrid()
    expect(sceneActions.showGrid).toBe(g0)

    const h0 = sceneActions.showHoloPanels
    sceneActions.toggleHoloPanels()
    expect(sceneActions.showHoloPanels).toBe(!h0)
    sceneActions.toggleHoloPanels()
    expect(sceneActions.showHoloPanels).toBe(h0)

    const l0 = sceneActions.showLabels
    sceneActions.toggleLabels()
    expect(sceneActions.showLabels).toBe(!l0)
    sceneActions.toggleLabels()
    expect(sceneActions.showLabels).toBe(l0)

    sceneActions.setFocus({ kind: 'zone', zone: 'HYP' })
    sceneActions.setAutoOrbit(true)
    sceneActions.resetCamera()
    expect(sceneActions.cameraPreset).toBe('overview')
    expect(sceneActions.focus).toEqual({ kind: 'global' })
    expect(sceneActions.autoOrbit).toBe(false)
    expect(sceneActions.focusNonce).toBeGreaterThan(baseFocusNonce)
  })
})
