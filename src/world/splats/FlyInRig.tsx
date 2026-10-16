import { useLayoutEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { canTransition, useApp, useWorld } from '../../app/store.ts'
import { logEvent } from '../../data/repo.ts'
import type { Pose } from '../../domain/types.ts'
import { setOrbitHandoff } from '../camera/flyTo.ts'
import { getDiorama, type DioramaInstance } from './Diorama.tsx'
import {
  FLIGHT,
  cameraOnPath,
  cameraOnReturn,
  contentMatrix,
  flightScale,
  newFlightState,
  planFlight,
  stepFlight,
  type CameraPose,
  type FlightPlan,
  type FlightState,
} from './flyIn.ts'
import { getSplatStage } from './sparkRegistry.ts'

// Drives the camera and the lifted diorama during 'entering' and 'exiting' (mounted by the
// camera rig for those modes; the same instance spans entering → exiting when Esc interrupts
// a fly-in). The flight itself is module state, so it survives the 'interior' leg in between,
// when InteriorRig owns the camera.

interface Flight {
  plan: FlightPlan | null
  state: FlightState
  /** SparkRenderer.lodSplatScale wanted by the flight (SparkLayer applies it). */
  lodScale: number
  logged: boolean
  /** Seconds spent waiting for the diorama / its proxy before departure. */
  hold: number
}

const flight: Flight = { plan: null, state: newFlightState(), lodScale: 1, logged: false, hold: 0 }

/** Wait at most this long for the focused diorama's proxy before departing without it (s). */
const PROXY_HOLD_SECONDS = 4
/** Give up if the focused memory has no diorama after this long (s). */
const MISSING_HOLD_SECONDS = 1.5

export function flightLodScale(): number {
  return flight.lodScale
}

/** The flight in progress (or parked in the interior), if any. */
export function currentFlight(): FlightPlan | null {
  return flight.plan
}

export function currentFlightPhase(): FlightState['phase'] {
  return flight.state.phase
}

// ─── promises for the dev hooks ──────────────────────────────────────────────────────

type Waiter = { resolve: () => void; reject: (e: Error) => void }
let arriveWaiters: Waiter[] = []
let exitWaiters: Waiter[] = []

function settle(list: Waiter[], err?: Error): void {
  for (const w of list) {
    if (err) w.reject(err)
    else w.resolve()
  }
}

function resolveArrive(err?: Error): void {
  const list = arriveWaiters
  arriveWaiters = []
  settle(list, err)
}

function resolveExit(err?: Error): void {
  const list = exitWaiters
  exitWaiters = []
  settle(list, err)
}

/**
 * Enter a memory's diorama. Resolves at rest inside (after the crossfade to the interior, or
 * on the proxy when there is no interior). Rejects when the memory cannot be entered.
 */
export function flyIn(id: string): Promise<void> {
  const app = useApp.getState()
  const rec = useWorld.getState().nodes.get(id)
  if (!rec?.splat) return Promise.reject(new Error(`flyIn: ${id} is not a memory with a volumetric scene`))
  if (app.mode === 'interior' && app.focusedId === id) return Promise.resolve()
  if (!canTransition(app.mode, 'entering') || app.mode === 'entering') {
    return Promise.reject(new Error(`flyIn: cannot enter from mode '${app.mode}'`))
  }
  const p = new Promise<void>((resolve, reject) => arriveWaiters.push({ resolve, reject }))
  app.select(id)
  app.focus(id)
  app.setMode('entering')
  return p
}

/** Leave the diorama. Resolves once the camera is back in orbit at the memory. */
export function flyOut(): Promise<void> {
  const app = useApp.getState()
  if (app.mode !== 'entering' && app.mode !== 'interior' && app.mode !== 'exiting') return Promise.resolve()
  const p = new Promise<void>((resolve, reject) => exitWaiters.push({ resolve, reject }))
  if (app.mode !== 'exiting') app.setMode('exiting')
  return p
}

// ─── the flight ─────────────────────────────────────────────────────────────────────

const _m = new Matrix4()
const _pose: CameraPose = { position: new Vector3(), quaternion: new Quaternion() }
const _centre = new Vector3()

/** The block's entry pose, or the crop centre seen head-on when it is unusable. */
function entryPoseOf(inst: DioramaInstance): Pose {
  const e = inst.block.entryPose
  if (e && Array.isArray(e.position) && e.position.length === 3 && e.position.every(Number.isFinite)) return e
  const c = inst.fit?.centre
  return { position: c ? [c.x, c.y, c.z] : [0, 0, 0], quaternion: [0, 0, 0, 1] }
}

function depart(inst: DioramaInstance, camera: CameraPose): FlightPlan | null {
  const stage = getSplatStage()
  if (!stage || !inst.fit) return null
  inst.content.updateWorldMatrix(true, false)
  inst.fitGroup.updateMatrix()
  inst.content.getWorldPosition(_centre)
  const plan = planFlight({
    id: inst.id,
    base: inst.content.matrixWorld,
    fit: inst.fitGroup.matrix,
    entry: entryPoseOf(inst),
    camera,
    centre: _centre,
  })
  inst.lift(stage)
  inst.setContentMatrix(contentMatrix(plan, 1, _m))
  return plan
}

/** Exit finished (or there was nothing to reverse): back to orbit at the memory. */
function finish(): void {
  const plan = flight.plan
  const inst = getDiorama(plan?.id)
  if (inst) {
    inst.blendTarget = 0
    if (inst.lifted) inst.restore()
  }
  flight.plan = null
  flight.state = newFlightState()
  flight.lodScale = 1
  flight.logged = false
  flight.hold = 0
  const app = useApp.getState()
  if (plan) setOrbitHandoff(plan.centre)
  if (app.mode === 'exiting' || app.mode === 'entering') {
    if (app.mode === 'entering') app.setMode('exiting')
    app.setMode('orbit')
  }
  app.focus(null)
  resolveArrive(new Error('flight ended before arriving'))
  resolveExit()
}

export function FlyInRig() {
  const camera = useThree((s) => s.camera)

  // The flight owns the camera now; a fresh one starts with no hold time.
  useLayoutEffect(() => {
    flight.hold = 0
    camera.up.set(0, 1, 0)
  }, [camera])

  // Priority −2 with the other camera writers, before NodeLayer (−1) reads the view.
  useFrame((_, dt) => {
    const app = useApp.getState()
    if (app.mode !== 'entering' && app.mode !== 'exiting') return
    const dir = app.mode === 'entering' ? 'in' : 'out'

    if (!flight.plan) {
      if (dir === 'out') return finish()
      const inst = getDiorama(app.focusedId)
      flight.hold += dt
      if (!inst) {
        if (flight.hold > MISSING_HOLD_SECONDS) {
          resolveArrive(new Error(`flyIn: no diorama for ${app.focusedId}`))
          app.setMode('exiting')
        }
        return
      }
      // Hold at the departure pose until the tier manager has focused it and the proxy is in
      // (or failed, or took too long). With neither a crop nor a proxy the fit waits for the
      // interior's bounds.
      const waiting = inst.tier !== 'focused' || inst.proxyPending || (!inst.fit && inst.interiorPending)
      if (waiting && flight.hold < (inst.fit ? PROXY_HOLD_SECONDS : FLIGHT.interiorWaitSeconds)) return
      const plan = depart(inst, { position: camera.position, quaternion: camera.quaternion })
      if (!plan) {
        resolveArrive(new Error(`flyIn: ${inst.id} has nothing to show`))
        app.setMode('exiting')
        return
      }
      flight.plan = plan
      flight.state = newFlightState()
      flight.logged = false
    }

    const plan = flight.plan
    const inst = getDiorama(plan.id)
    if (!inst) {
      // The memory vanished mid-flight (deleted, or its scene detached): snap out.
      if (dir === 'in') app.setMode('exiting')
      return finish()
    }
    const s = flight.state
    if (dir === 'out' && (s.phase === 'arrive' || s.phase === 'inside')) {
      s.returnFrom.position.copy(camera.position)
      s.returnFrom.quaternion.copy(camera.quaternion)
    }
    const ev = stepFlight(s, {
      dir,
      dt,
      seconds: plan.seconds,
      interiorReady: inst.interiorReady,
      interiorPending: inst.interiorPending,
      blend: inst.blend,
    })
    inst.blendTarget = s.blendTarget
    inst.setContentMatrix(contentMatrix(plan, flightScale(s.u, plan.growth), _m))
    if (s.phase === 'return') cameraOnReturn(plan, s, _pose)
    else cameraOnPath(plan, s.u, _pose)
    camera.position.copy(_pose.position)
    camera.quaternion.copy(_pose.quaternion)
    camera.updateMatrixWorld()
    flight.lodScale = s.phase === 'approach' || s.phase === 'retreat' ? FLIGHT.tweenLodScale : 1

    if (ev === 'inside') {
      if (!flight.logged) {
        flight.logged = true
        void logEvent('enter', plan.id).catch((e) => console.warn('[splats] enter event', e))
      }
      app.setMode('interior')
      resolveArrive()
    } else if (ev === 'out') {
      finish()
    }
  }, -2)

  return null
}
