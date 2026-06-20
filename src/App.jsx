/**
 * SUPERMARKET SURVIVAL — Phase 5b (combat & physique avancés)
 * ------------------------------------------------------------
 * Stack : React Three Fiber + Rapier
 *
 * Nouveautés par rapport à la Phase 5 :
 *  1) PV DES ZOMBIES : 2 coups de sabre OU 1 balle pour tuer un zombie
 *     normal. Flash rouge quand un zombie encaisse un coup non létal.
 *  2) ZOMBIE-BOB (ex-policier, gilet pare-balles) : 1 sur 20.
 *     Insensible aux balles (elles ricochent sur le gilet, éclair blanc),
 *     se tue uniquement au sabre (2 coups).
 *  3) RAYONS POUSSABLES : si >= 5 zombies poussent une gondole, elle
 *     glisse lentement (repoussée par la masse). Les rayons sont devenus
 *     des corps kinematic ; leurs positions vivantes sont relues par la
 *     ligne de vue, les balles, la fouille et les indicateurs.
 *
 * Inchangé : loot/fouille, faim/famine, ligne de vue du sabre, HUD,
 * <Game> mémoïsé pour ne pas re-rendre la scène à chaque tick HUD.
 */

import React, {
  useRef, useState, useEffect, useCallback, useMemo, memo, Suspense,
  forwardRef, useImperativeHandle,
} from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Physics, RigidBody, CuboidCollider, CapsuleCollider } from '@react-three/rapier'
import { useGLTF, useAnimations } from '@react-three/drei'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import * as THREE from 'three'

const ZOMBIE_URL = '/zombie_lite.glb'
const ZOMBIE_MODEL_SCALE = 1.0       // le squelette fait déjà ~1,67 m -> pas de mise à l'échelle
const ZOMBIE_FEET_Y = -0.8          // pieds au sol (sous le centre de la capsule)
const ZOMBIE_MODEL_FACING = 0       // passe à Math.PI si le zombie marche "à reculons"
useGLTF.preload(ZOMBIE_URL, true)

const PLAYER_URL = '/player_lite.glb'
const PLAYER_MODEL_SCALE = 1.0      // squelette ~1,67 m
const PLAYER_FEET_Y = -0.8
const PLAYER_MODEL_FACING = 0       // passe à Math.PI si le joueur regarde "à l'envers"
useGLTF.preload(PLAYER_URL, true)

/* ---------------------------------------------------------------- */
/* Réglages de gameplay                                              */
/* ---------------------------------------------------------------- */
const PLAYER_SPEED = 6
const ZOMBIE_SPEED = 2.6

const ZOMBIE_HP = 2
const SABRE_DAMAGE = 1          // 2 coups de sabre pour tuer
const BULLET_DAMAGE = 2         // 1 balle pour tuer
const ARMORED_CHANCE = 0.05     // 1 zombie-bob sur 20

const SABRE_RANGE = 2.6
const SABRE_HALF_ANGLE = 1.0
const SABRE_COOLDOWN = 0.45
const SABRE_SWING_DURATION = 0.3

const PISTOL_COOLDOWN = 0.22
const BULLET_SPEED = 40
const BULLET_LIFE = 1.1
const BULLET_HIT_RADIUS = 0.6
const BULLET_POOL = 40

const CONTACT_RANGE = 1.25
const HIT_COOLDOWN = 0.8
const ZOMBIE_DAMAGE = 10
const MAX_ZOMBIES = 14
const ARENA = 24

/* Vagues */
const INTRO_DURATION = 2.0       // durée de l'annonce "VAGUE N"
const REST_DURATION = 4.0        // répit entre deux vagues
const WAVE_BASE = 6              // zombies dans la vague 1
const WAVE_GROWTH = 3            // zombies ajoutés à chaque vague
function waveCount(n) { return WAVE_BASE + (n - 1) * WAVE_GROWTH }

/* Rayons poussables */
const PUSH_RANGE = 1.1          // distance à laquelle un zombie "pousse"
const PUSH_THRESHOLD = 5        // nombre de zombies pour déclencher
const PUSH_SPEED = 1.0          // vitesse de glissement (unités/s)

/* Survie */
const HUNGER_MAX = 100
const HUNGER_DRAIN = 0.7
const STARVE_TICK = 0.5
const STARVE_DAMAGE = 3
const LOW_HUNGER = 20
const SLOW_FACTOR = 0.75

/* Loot */
const START_AMMO = 0
const START_HAS_PISTOL = false
const FOOD_HUNGER = 45
const FOOD_HEAL = 12
const AMMO_PICKUP = 8
const PISTOL_AMMO_BONUS = 6
const SEARCH_RANGE = 2.7
const SEARCH_TIME = 1.2
const SHELF_COOLDOWN = 18

const SHELVES = [
  { x: -9, z: -7, w: 7, d: 1.6 },
  { x: 9, z: -7, w: 7, d: 1.6 },
  { x: -9, z: 7, w: 7, d: 1.6 },
  { x: 9, z: 7, w: 7, d: 1.6 },
  { x: 0, z: -13, w: 1.6, d: 7 },
  { x: 0, z: 13, w: 1.6, d: 7 },
]

const WALLS = [
  { x: 0, z: -ARENA, w: ARENA * 2 + 2, d: 1 },
  { x: 0, z: ARENA, w: ARENA * 2 + 2, d: 1 },
  { x: -ARENA, z: 0, w: 1, d: ARENA * 2 + 2 },
  { x: ARENA, z: 0, w: 1, d: ARENA * 2 + 2 },
]

const raycaster = new THREE.Raycaster()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const camTarget = new THREE.Vector3()

/* ---------------------------------------------------------------- */
/* Helpers géométriques                                              */
/* ---------------------------------------------------------------- */
function distToRect(px, pz, cx, cz, hw, hd) {
  const dx = Math.max(Math.abs(px - cx) - hw, 0)
  const dz = Math.max(Math.abs(pz - cz) - hd, 0)
  return Math.hypot(dx, dz)
}

function segmentHitsRect(x1, z1, x2, z2, cx, cz, hw, hd) {
  const minx = cx - hw, maxx = cx + hw, minz = cz - hd, maxz = cz + hd
  let t0 = 0, t1 = 1
  const dx = x2 - x1, dz = z2 - z1
  const checks = [[-dx, x1 - minx], [dx, maxx - x1], [-dz, z1 - minz], [dz, maxz - z1]]
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const r = q / p
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r }
      else { if (r < t0) return false; if (r < t1) t1 = r }
    }
  }
  return true
}

// Ligne de vue bloquée par un rayon ? (positions vivantes)
function losBlocked(rects, x1, z1, x2, z2) {
  for (const s of rects) {
    if (segmentHitsRect(x1, z1, x2, z2, s.x, s.z, s.w / 2, s.d / 2)) return true
  }
  return false
}

/* ---------------------------------------------------------------- */
/* Sons procéduraux (Web Audio, aucun fichier externe)               */
/* ---------------------------------------------------------------- */
const Sfx = (() => {
  let ctx = null
  let master = null
  let muted = false
  let lastHurt = 0
  const BASE = 0.3

  function ensure() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return null
        ctx = new AC()
        master = ctx.createGain()
        master.gain.value = muted ? 0 : BASE
        master.connect(ctx.destination)
      }
      if (ctx.state === 'suspended') ctx.resume()
    } catch (e) { /* audio indisponible */ }
    return ctx
  }

  function blip({ type = 'sine', f0, f1, dur = 0.15, gain = 0.5, attack = 0.005 }) {
    if (!ctx || muted) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(f0, t)
    if (f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g); g.connect(master)
    osc.start(t); osc.stop(t + dur + 0.02)
  }

  function noise({ dur = 0.15, gain = 0.5, type = 'lowpass', f = 1000, q = 1, sweepTo }) {
    if (!ctx || muted) return
    const t = ctx.currentTime
    const n = Math.floor(ctx.sampleRate * dur)
    const buf = ctx.createBuffer(1, n, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource(); src.buffer = buf
    const filt = ctx.createBiquadFilter(); filt.type = type; filt.frequency.setValueAtTime(f, t); filt.Q.value = q
    if (sweepTo !== undefined) filt.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(filt); filt.connect(g); g.connect(master)
    src.start(t); src.stop(t + dur)
  }

  return {
    ensure,
    setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : BASE },
    shoot() { ensure(); noise({ dur: 0.12, gain: 0.6, type: 'lowpass', f: 1800, sweepTo: 300 }); blip({ type: 'square', f0: 150, f1: 50, dur: 0.1, gain: 0.22 }) },
    sabre() { ensure(); noise({ dur: 0.18, gain: 0.3, type: 'bandpass', f: 2400, q: 1.2, sweepTo: 600 }) },
    death() { ensure(); blip({ type: 'sawtooth', f0: 200, f1: 50, dur: 0.22, gain: 0.28 }); noise({ dur: 0.14, gain: 0.2, type: 'lowpass', f: 800 }) },
    hurt() { ensure(); const now = ctx ? ctx.currentTime : 0; if (now - lastHurt < 0.15) return; lastHurt = now; blip({ type: 'square', f0: 220, f1: 110, dur: 0.18, gain: 0.3 }) },
    ricochet() { ensure(); blip({ type: 'triangle', f0: 3000, f1: 1200, dur: 0.12, gain: 0.22 }); noise({ dur: 0.05, gain: 0.18, type: 'highpass', f: 3000 }) },
    groan() { ensure(); blip({ type: 'sawtooth', f0: 85 + Math.random() * 35, f1: 55, dur: 0.5, gain: 0.16 }) },
    pickup(kind) {
      ensure()
      if (kind === 'pistol') { blip({ type: 'square', f0: 400, f1: 800, dur: 0.12, gain: 0.28 }); setTimeout(() => blip({ type: 'square', f0: 800, f1: 1200, dur: 0.12, gain: 0.28 }), 90) }
      else if (kind === 'ammo') { blip({ type: 'square', f0: 600, f1: 900, dur: 0.1, gain: 0.24 }) }
      else { blip({ type: 'sine', f0: 500, f1: 760, dur: 0.16, gain: 0.28 }) }
    },
    waveStart() { ensure(); blip({ type: 'sawtooth', f0: 150, f1: 320, dur: 0.5, gain: 0.3 }) },
    waveCleared() { ensure(); blip({ type: 'sine', f0: 520, f1: 780, dur: 0.18, gain: 0.3 }); setTimeout(() => blip({ type: 'sine', f0: 780, f1: 1040, dur: 0.22, gain: 0.3 }), 140) },
    gameOver() { ensure(); blip({ type: 'sawtooth', f0: 300, f1: 55, dur: 0.85, gain: 0.32 }) },
  }
})()

/* ---------------------------------------------------------------- */
/* Hook clavier                                                      */
/* ---------------------------------------------------------------- */
function useKeyboard() {
  const keys = useRef({})
  useEffect(() => {
    const down = (e) => { keys.current[e.code] = true }
    const up = (e) => { keys.current[e.code] = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])
  return keys
}

/* ---------------------------------------------------------------- */
/* Caméra                                                            */
/* ---------------------------------------------------------------- */
function FollowCamera({ target }) {
  const { camera } = useThree()
  useFrame(() => {
    const p = target.current
    camTarget.set(p.x, p.y + 14, p.z + 11)
    camera.position.lerp(camTarget, 0.1)
    camera.lookAt(p.x, p.y + 0.5, p.z)
  })
  return null
}

/* ---------------------------------------------------------------- */
/* Lumières + décor fixe (sol + murs)                                */
/* ---------------------------------------------------------------- */
function Lights() {
  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={['#8899aa', '#1a1a22', 0.4]} />
      <directionalLight
        position={[15, 25, 10]}
        intensity={0.9}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
      />
    </>
  )
}

function Arena() {
  return (
    <>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[40, 0.5, 40]} position={[0, -0.5, 0]} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[80, 80]} />
          <meshStandardMaterial color="#3a3a42" />
        </mesh>
      </RigidBody>

      {WALLS.map((w, i) => (
        <RigidBody key={'w' + i} type="fixed" colliders={false} position={[w.x, 1, w.z]}>
          <CuboidCollider args={[w.w / 2, 1, w.d / 2]} />
          <mesh receiveShadow>
            <boxGeometry args={[w.w, 2, w.d]} />
            <meshStandardMaterial color="#26262e" />
          </mesh>
        </RigidBody>
      ))}
    </>
  )
}

/* ---------------------------------------------------------------- */
/* Rayons poussables (kinematic, déplacés par <Game>)               */
/* ---------------------------------------------------------------- */
function Shelves({ bodiesRef }) {
  return (
    <group>
      {SHELVES.map((s, i) => (
        <RigidBody
          key={i}
          ref={(el) => (bodiesRef.current[i] = el)}
          type="kinematicPosition"
          colliders={false}
          position={[s.x, 0.6, s.z]}
        >
          <CuboidCollider args={[s.w / 2, 0.6, s.d / 2]} />
          <mesh castShadow receiveShadow>
            <boxGeometry args={[s.w, 1.2, s.d]} />
            <meshStandardMaterial color="#6b7280" />
          </mesh>
        </RigidBody>
      ))}
    </group>
  )
}

function LootIndicators({ indicatorsRef }) {
  return (
    <group>
      {SHELVES.map((s, i) => (
        <mesh key={i} ref={(el) => (indicatorsRef.current[i] = el)} position={[s.x, 1.7, s.z]}>
          <octahedronGeometry args={[0.28, 0]} />
          <meshStandardMaterial color="#fbbf24" emissive="#f59e0b" emissiveIntensity={1.4} />
        </mesh>
      ))}
    </group>
  )
}

/* ---------------------------------------------------------------- */
/* Balles                                                            */
/* ---------------------------------------------------------------- */
const Bullets = forwardRef(function Bullets({ registry, killZombies, shelfRectsRef, playing }, ref) {
  const meshes = useRef([])
  const active = useRef([])

  useImperativeHandle(ref, () => ({
    fire(x, z, dx, dz) {
      if (active.current.length >= BULLET_POOL) return
      active.current.push({ x, z, dx, dz, life: BULLET_LIFE })
    },
  }), [])

  useFrame((state, dt) => {
    const arr = active.current
    if (playing) {
      const now = state.clock.elapsedTime
      for (let i = arr.length - 1; i >= 0; i--) {
        const b = arr[i]
        b.x += b.dx * BULLET_SPEED * dt
        b.z += b.dz * BULLET_SPEED * dt
        b.life -= dt
        let dead = b.life <= 0 || Math.abs(b.x) > ARENA || Math.abs(b.z) > ARENA

        if (!dead) {
          for (const s of shelfRectsRef.current) {
            if (Math.abs(b.x - s.x) < s.w / 2 && Math.abs(b.z - s.z) < s.d / 2) { dead = true; break }
          }
        }

        if (!dead) {
          let hitId = null
          registry.current.forEach((z, id) => {
            if (hitId !== null) return
            const ddx = z.pos.x - b.x
            const ddz = z.pos.z - b.z
            if (ddx * ddx + ddz * ddz < BULLET_HIT_RADIUS * BULLET_HIT_RADIUS) hitId = id
          })
          if (hitId !== null) {
            const e = registry.current.get(hitId)
            if (e) {
              if (e.armored) {
                e.armorSpark = now            // ricochet sur le gilet, aucun dégât
                Sfx.ricochet()
              } else {
                e.hp -= BULLET_DAMAGE
                e.hitFlash = now
                if (e.hp <= 0) killZombies([hitId])
              }
            }
            dead = true                       // la balle est consommée dans tous les cas
          }
        }

        if (dead) arr.splice(i, 1)
      }
    }

    const m = meshes.current
    for (let i = 0; i < BULLET_POOL; i++) {
      const mesh = m[i]
      if (!mesh) continue
      if (i < arr.length) {
        mesh.visible = true
        mesh.position.set(arr[i].x, 0.9, arr[i].z)
      } else {
        mesh.visible = false
      }
    }
  })

  return (
    <group>
      {Array.from({ length: BULLET_POOL }).map((_, i) => (
        <mesh key={i} ref={(el) => (meshes.current[i] = el)} visible={false}>
          <sphereGeometry args={[0.13, 8, 8]} />
          <meshStandardMaterial color="#fde047" emissive="#fde047" emissiveIntensity={2.5} />
        </mesh>
      ))}
    </group>
  )
})

/* ---------------------------------------------------------------- */
/* Joueur                                                            */
/* ---------------------------------------------------------------- */
/* Modèle 3D animé du joueur (GLB Meshy) */
function PlayerModel({ locomotionRef, attackRef }) {
  const { scene, animations } = useGLTF(PLAYER_URL, true)
  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene)
    c.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false } })
    return c
  }, [scene])
  const group = useRef()
  const { actions } = useAnimations(animations, group)
  const baseName = useRef(null)        // 'idle' | 'run'
  const attackName = useRef(null)
  const attackEnd = useRef(0)
  const lastTrigger = useRef(0)

  const playBase = (name) => {
    if (baseName.current === name) return
    const nextClip = name === 'run' ? 'run' : 'walk'
    const prevClip = baseName.current === 'run' ? 'run' : 'walk'
    const next = actions[nextClip]
    const prev = actions[prevClip]
    if (next) {
      next.reset()
      if (name === 'idle') { next.fadeIn(0.15).play(); next.paused = true; next.time = 0 } // pose figée (pas de clip idle)
      else { next.paused = false; next.timeScale = 1; next.fadeIn(0.15).play() }
      if (prev && prev !== next) prev.fadeOut(0.15)
    }
    baseName.current = name
  }

  useEffect(() => {
    playBase('idle')
    if (actions.slash) actions.slash.setLoop(THREE.LoopOnce, 1)
    if (actions.shoot) actions.shoot.setLoop(THREE.LoopOnce, 1)
    return () => Object.values(actions).forEach((a) => a && a.stop())
  }, [actions])

  useFrame((state) => {
    const now = state.clock.elapsedTime

    // nouvelle attaque déclenchée ?
    if (attackRef.current.id !== lastTrigger.current) {
      lastTrigger.current = attackRef.current.id
      const name = attackRef.current.name      // 'slash' | 'shoot'
      const a = actions[name]
      if (a) {
        a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; a.timeScale = 1
        a.fadeIn(0.06).play()
        const baseClip = baseName.current === 'run' ? 'run' : 'walk'
        if (actions[baseClip]) actions[baseClip].fadeOut(0.06)
        attackName.current = name
        attackEnd.current = now + a.getClip().duration
      }
    }

    if (attackName.current && now >= attackEnd.current) {
      const a = actions[attackName.current]
      if (a) a.fadeOut(0.12)
      attackName.current = null
      baseName.current = null            // force la reprise
      playBase(locomotionRef.current)
    }

    if (!attackName.current) playBase(locomotionRef.current)
  })

  return (
    <group ref={group} position={[0, PLAYER_FEET_Y, 0]} rotation={[0, PLAYER_MODEL_FACING, 0]} scale={PLAYER_MODEL_SCALE}>
      <primitive object={cloned} />
    </group>
  )
}

function Player({ posRef, registry, killZombies, bulletsRef, shelfRectsRef, ammoRef, hasPistolRef, hungerRef, onWeapon, onAmmo, playing }) {
  const body = useRef()
  const visual = useRef()
  const keys = useKeyboard()
  const { camera } = useThree()

  const yaw = useRef(0)
  const aim = useRef(new THREE.Vector3())
  const weaponRef = useRef('sabre')
  const lastUse = useRef(-10)
  const mouseHeld = useRef(false)
  const spaceHeld = useRef(false)
  const locomotionRef = useRef('idle')
  const attackRef = useRef({ id: 0, name: 'slash' })

  const triggerAttack = (name) => { attackRef.current = { id: attackRef.current.id + 1, name } }

  useEffect(() => {
    const setWeapon = (w) => {
      if (w === 'pistol' && !hasPistolRef.current) return
      if (weaponRef.current !== w) { weaponRef.current = w; onWeapon(w) }
    }
    const onKeyDown = (e) => {
      if (e.code === 'Digit1' || e.code === 'Numpad1') setWeapon('sabre')
      else if (e.code === 'Digit2' || e.code === 'Numpad2') setWeapon('pistol')
      if (e.code === 'Space') spaceHeld.current = true
    }
    const onKeyUp = (e) => { if (e.code === 'Space') spaceHeld.current = false }
    const onPointerDown = (e) => { if (e.button === 0) mouseHeld.current = true }
    const onPointerUp = (e) => { if (e.button === 0) mouseHeld.current = false }
    let lastWheel = 0
    const onWheel = () => {
      const now = performance.now()
      if (now - lastWheel < 200) return
      lastWheel = now
      setWeapon(weaponRef.current === 'sabre' ? 'pistol' : 'sabre')
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('wheel', onWheel)
    onWeapon(weaponRef.current)
    onAmmo(ammoRef.current)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('wheel', onWheel)
    }
  }, [onWeapon, onAmmo, ammoRef, hasPistolRef])

  useFrame((state) => {
    if (!body.current) return
    const t = body.current.translation()
    posRef.current.set(t.x, t.y, t.z)

    if (!playing) {
      const vy = body.current.linvel().y
      body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
      return
    }

    raycaster.setFromCamera(state.pointer, camera)
    if (raycaster.ray.intersectPlane(groundPlane, aim.current)) {
      const dx = aim.current.x - t.x
      const dz = aim.current.z - t.z
      if (dx * dx + dz * dz > 0.04) yaw.current = Math.atan2(dx, dz)
    }
    if (visual.current) visual.current.rotation.y = yaw.current

    const k = keys.current
    let mx = 0, mz = 0
    if (k['KeyW'] || k['KeyZ'] || k['ArrowUp']) mz -= 1
    if (k['KeyS'] || k['ArrowDown']) mz += 1
    if (k['KeyA'] || k['KeyQ'] || k['ArrowLeft']) mx -= 1
    if (k['KeyD'] || k['ArrowRight']) mx += 1
    const len = Math.hypot(mx, mz)
    const vy = body.current.linvel().y
    let speed = PLAYER_SPEED
    if (hungerRef.current < LOW_HUNGER) speed *= SLOW_FACTOR
    if (len > 0) {
      body.current.setLinvel({ x: (mx / len) * speed, y: vy, z: (mz / len) * speed }, true)
    } else {
      body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
    }
    locomotionRef.current = len > 0 ? 'run' : 'idle'

    const now = state.clock.elapsedTime
    const weapon = weaponRef.current
    const firing = mouseHeld.current || spaceHeld.current
    const cd = weapon === 'sabre' ? SABRE_COOLDOWN : PISTOL_COOLDOWN

    if (firing && now - lastUse.current > cd) {
      const fx = Math.sin(yaw.current)
      const fz = Math.cos(yaw.current)

      if (weapon === 'sabre') {
        lastUse.current = now
        Sfx.sabre()
        triggerAttack('slash')
        const cosHalf = Math.cos(SABRE_HALF_ANGLE)
        const kills = []
        registry.current.forEach((z, id) => {
          const vx = z.pos.x - t.x
          const vz = z.pos.z - t.z
          const d = Math.hypot(vx, vz)
          if (d < SABRE_RANGE && d > 0.001) {
            const dot = (vx / d) * fx + (vz / d) * fz
            if (dot > cosHalf && !losBlocked(shelfRectsRef.current, t.x, t.z, z.pos.x, z.pos.z)) {
              z.hp -= SABRE_DAMAGE
              z.hitFlash = now
              if (z.hp <= 0) kills.push(id)
            }
          }
        })
        if (kills.length) killZombies(kills)
      } else if (ammoRef.current > 0) {
        lastUse.current = now
        bulletsRef.current?.fire(t.x + fx * 0.7, t.z + fz * 0.7, fx, fz)
        Sfx.shoot()
        triggerAttack('shoot')
        ammoRef.current -= 1
        onAmmo(ammoRef.current)
      }
    }
  })

  return (
    <RigidBody
      ref={body}
      type="dynamic"
      position={[0, 0.9, 0]}
      colliders={false}
      enabledRotations={[false, false, false]}
      mass={3}
      linearDamping={0.5}
    >
      <CapsuleCollider args={[0.45, 0.4]} />
      <group ref={visual}>
        <PlayerModel locomotionRef={locomotionRef} attackRef={attackRef} />
      </group>
    </RigidBody>
  )
}

/* ---------------------------------------------------------------- */
/* Zombie (normal ou blindé)                                         */
/* ---------------------------------------------------------------- */
/* Modèle 3D animé du zombie (GLB Meshy) */
function ZombieModel({ gait, speedMul, stateRef, entryRef }) {
  const { scene, animations } = useGLTF(ZOMBIE_URL, true)
  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene)
    c.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.frustumCulled = false        // évite la disparition du mesh skinné pendant l'anim
        o.material = o.material.clone() // matière propre par instance (flash individuel)
      }
    })
    return c
  }, [scene])
  const mats = useMemo(() => {
    const arr = []
    cloned.traverse((o) => { if (o.isMesh) arr.push(o.material) })
    return arr
  }, [cloned])

  const group = useRef()
  const { actions } = useAnimations(animations, group)
  const current = useRef(null)

  useEffect(() => {
    const a = actions[gait]
    if (a) { a.reset(); a.timeScale = speedMul; a.fadeIn(0.2).play() }
    current.current = gait
    if (actions.death) { actions.death.setLoop(THREE.LoopOnce, 1); actions.death.clampWhenFinished = true }
    return () => { Object.values(actions).forEach((act) => act && act.stop()) }
  }, [actions, gait, speedMul])

  useFrame((state) => {
    const desired = stateRef.current === 'death' ? 'death'
      : stateRef.current === 'attack' ? 'grab'
        : gait
    if (desired !== current.current && actions[desired]) {
      const next = actions[desired]
      const prev = actions[current.current]
      next.reset()
      if (desired === 'death') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; next.fadeIn(0.12).play() }
      else { next.timeScale = desired === 'grab' ? 1 : speedMul; next.fadeIn(0.15).play() }
      if (prev && prev !== next) prev.fadeOut(0.15)
      current.current = desired
    }
    const f = state.clock.elapsedTime - entryRef.current.hitFlash < 0.12
    for (const m of mats) m.emissive.setRGB(f ? 0.5 : 0, 0, 0)
  })

  return (
    <group ref={group} position={[0, ZOMBIE_FEET_Y, 0]} rotation={[0, ZOMBIE_MODEL_FACING, 0]} scale={ZOMBIE_MODEL_SCALE}>
      <primitive object={cloned} />
    </group>
  )
}

function Zombie({ id, spawn, armored, gait, speedMul, dying, posRef, registry, onDamage, onRemove, playing }) {
  const body = useRef()
  const visual = useRef()
  const bodyMesh = useRef()
  const vestMesh = useRef()
  const stateRef = useRef('walk')
  const entry = useRef({
    pos: new THREE.Vector3(spawn[0], 1, spawn[1]),
    lastHit: -10, hp: ZOMBIE_HP, armored, hitFlash: -10, armorSpark: -10, dying: false,
  })

  useEffect(() => {
    registry.current.set(id, entry.current)
    return () => { registry.current.delete(id) }
  }, [id, registry])

  // passage en mort : sort du registre (le combat l'ignore), puis suppression différée
  useEffect(() => {
    if (!dying) return
    entry.current.dying = true
    stateRef.current = 'death'
    registry.current.delete(id)
    const ms = armored ? 200 : 2300   // le bob (placeholder) part vite, le modèle joue sa mort
    const tmr = setTimeout(() => onRemove(id), ms)
    return () => clearTimeout(tmr)
  }, [dying, armored, id, onRemove, registry])

  useFrame((state) => {
    if (!body.current) return
    const t = body.current.translation()
    entry.current.pos.set(t.x, t.y, t.z)
    const now = state.clock.elapsedTime

    if (dying || !playing) {
      const vy = body.current.linvel().y
      body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
    } else {
      const dx = posRef.current.x - t.x
      const dz = posRef.current.z - t.z
      const d = Math.hypot(dx, dz)
      const vy = body.current.linvel().y
      if (d > 0.001) {
        const sp = ZOMBIE_SPEED * speedMul
        body.current.setLinvel({ x: (dx / d) * sp, y: vy, z: (dz / d) * sp }, true)
        if (visual.current) visual.current.rotation.y = Math.atan2(dx, dz)
      }
      stateRef.current = d < CONTACT_RANGE ? 'attack' : 'walk'
      if (d < CONTACT_RANGE && now - entry.current.lastHit > HIT_COOLDOWN) {
        entry.current.lastHit = now
        onDamage(ZOMBIE_DAMAGE)
        Sfx.hurt()
      }
    }

    // flash du placeholder blindé (le modèle GLB gère le sien)
    if (armored) {
      if (bodyMesh.current) {
        const f = now - entry.current.hitFlash < 0.12
        bodyMesh.current.material.emissive.setRGB(f ? 0.9 : 0, 0, 0)
      }
      if (vestMesh.current) {
        const s = now - entry.current.armorSpark < 0.12
        const v = s ? 0.9 : 0
        vestMesh.current.material.emissive.setRGB(v, v, v)
      }
    }
  })

  return (
    <RigidBody
      ref={body}
      type="dynamic"
      position={[spawn[0], 1, spawn[1]]}
      colliders={false}
      enabledRotations={[false, false, false]}
      mass={armored ? 1.6 : 1}
      linearDamping={0.5}
    >
      <CapsuleCollider args={[0.4, 0.4]} />
      <group ref={visual}>
        {armored ? (
          <>
            {/* ex-policier (placeholder en attendant son GLB) */}
            <mesh ref={bodyMesh} castShadow>
              <capsuleGeometry args={[0.42, 0.85, 8, 16]} />
              <meshStandardMaterial color="#27384d" />
            </mesh>
            <mesh ref={vestMesh} position={[0, 0.05, 0]} castShadow>
              <boxGeometry args={[0.82, 0.62, 0.52]} />
              <meshStandardMaterial color="#0f0f12" />
            </mesh>
            <mesh position={[0, 0.88, 0.08]} castShadow>
              <sphereGeometry args={[0.26, 12, 12]} />
              <meshStandardMaterial color="#8a96a3" />
            </mesh>
            <mesh position={[0, 1.04, 0.02]} castShadow>
              <boxGeometry args={[0.5, 0.12, 0.5]} />
              <meshStandardMaterial color="#10131a" />
            </mesh>
          </>
        ) : (
          <ZombieModel gait={gait} speedMul={speedMul} stateRef={stateRef} entryRef={entry} />
        )}
      </group>
    </RigidBody>
  )
}

/* ---------------------------------------------------------------- */
/* Logique de jeu (mémoïsée)                                         */
/* ---------------------------------------------------------------- */
const Game = memo(function Game({ playing, onDamage, onHeal, onKill, onWeapon, onAmmo, onPistol, onSurvival, onPickup }) {
  const playerPos = useRef(new THREE.Vector3(0, 0.9, 0))
  const registry = useRef(new Map())
  const bulletsRef = useRef()
  const indicatorsRef = useRef([])
  const shelfBodies = useRef([])
  const shelfRects = useRef(SHELVES.map((s) => ({ x: s.x, z: s.z, w: s.w, d: s.d })))
  const keys = useKeyboard()

  const [zombies, setZombies] = useState([])
  const idRef = useRef(1)
  const countRef = useRef(0)
  const spawnTimer = useRef(0)

  // Système de vagues
  const waveRef = useRef(1)
  const phaseRef = useRef('intro')      // 'intro' | 'active' | 'rest'
  const phaseTimer = useRef(0)
  const quotaRef = useRef(waveCount(1))  // zombies à faire apparaître cette vague
  const spawnedRef = useRef(0)
  const killedRef = useRef(0)            // tués cette vague

  const hungerRef = useRef(HUNGER_MAX)
  const ammoRef = useRef(START_AMMO)
  const hasPistolRef = useRef(START_HAS_PISTOL)
  const shelfStates = useRef(SHELVES.map(() => ({ available: true, cooldownUntil: 0 })))
  const searchProgress = useRef(0)
  const promptRef = useRef(false)
  const starveTimer = useRef(0)
  const prevX = useRef(0)
  const prevZ = useRef(0)
  const lastPush = useRef(0)
  const groanTimer = useRef(0)
  const nextGroan = useRef(3)

  useEffect(() => { countRef.current = zombies.filter((z) => !z.dying).length }, [zombies])
  useEffect(() => { if (playing) Sfx.waveStart() }, [])

  const beginWave = (n) => {
    waveRef.current = n
    quotaRef.current = waveCount(n)
    spawnedRef.current = 0
    killedRef.current = 0
    phaseRef.current = 'intro'
    phaseTimer.current = 0
    Sfx.waveStart()
  }

  // coup fatal : on marque "mourant" (le corps joue sa mort), score compté tout de suite
  const killZombies = useCallback((ids) => {
    killedRef.current += ids.length
    onKill(ids.length)
    Sfx.death()
    ids.forEach((id) => { const e = registry.current.get(id); if (e) e.dying = true; registry.current.delete(id) })
    setZombies((zs) => zs.map((z) => (ids.includes(z.id) ? { ...z, dying: true } : z)))
  }, [onKill])

  const removeZombie = useCallback((id) => {
    setZombies((zs) => zs.filter((z) => z.id !== id))
  }, [])

  const grantLoot = useCallback(() => {
    let type
    if (!hasPistolRef.current) {
      const r = Math.random()
      type = r < 0.45 ? 'pistol' : (r < 0.72 ? 'food' : 'ammo')
    } else {
      type = Math.random() < 0.6 ? 'food' : 'ammo'
    }
    Sfx.pickup(type)
    if (type === 'pistol') {
      hasPistolRef.current = true
      ammoRef.current += PISTOL_AMMO_BONUS
      onPistol(true)
      onAmmo(ammoRef.current)
      onPickup('🔫 Pistolet trouvé ! +' + PISTOL_AMMO_BONUS + ' munitions')
    } else if (type === 'ammo') {
      ammoRef.current += AMMO_PICKUP
      onAmmo(ammoRef.current)
      onPickup('Munitions +' + AMMO_PICKUP)
    } else {
      hungerRef.current = Math.min(HUNGER_MAX, hungerRef.current + FOOD_HUNGER)
      onHeal(FOOD_HEAL)
      onPickup('🍖 Nourriture (+faim, +santé)')
    }
  }, [onPistol, onAmmo, onHeal, onPickup])

  useFrame((state, dt) => {
    const now = state.clock.elapsedTime

    if (playing) {
      /* --- Machine à états des vagues --- */
      const phase = phaseRef.current
      if (phase === 'intro') {
        phaseTimer.current += dt
        if (phaseTimer.current >= INTRO_DURATION) {
          phaseRef.current = 'active'
          spawnTimer.current = 0
        }
      } else if (phase === 'active') {
        const wave = waveRef.current
        const interval = Math.max(0.5, 1.6 - wave * 0.08)
        if (spawnedRef.current < quotaRef.current) {
          spawnTimer.current += dt
          if (spawnTimer.current >= interval && countRef.current < MAX_ZOMBIES) {
            spawnTimer.current = 0
            spawnedRef.current += 1
            const a = Math.random() * Math.PI * 2
            const r = 14 + Math.random() * 5
            const armoredChance = Math.min(0.2, 0.04 + wave * 0.015)
            const armored = Math.random() < armoredChance
            const gait = Math.random() < 0.5 ? 'limp' : 'unsteady'
            const speedMul = 0.85 + Math.random() * 0.3
            setZombies((zs) => [...zs, { id: idRef.current++, spawn: [Math.cos(a) * r, Math.sin(a) * r], armored, gait, speedMul }])
          }
        }
        // vague terminée : tous apparus ET plus aucun en vie
        if (spawnedRef.current >= quotaRef.current && countRef.current === 0) {
          phaseRef.current = 'rest'
          phaseTimer.current = 0
          Sfx.waveCleared()
        }
      } else if (phase === 'rest') {
        phaseTimer.current += dt
        if (phaseTimer.current >= REST_DURATION) {
          beginWave(waveRef.current + 1)
        }
      }

      /* Faim + famine */
      hungerRef.current = Math.max(0, hungerRef.current - HUNGER_DRAIN * dt)
      if (hungerRef.current <= 0) {
        starveTimer.current += dt
        if (starveTimer.current >= STARVE_TICK) { starveTimer.current = 0; onDamage(STARVE_DAMAGE) }
      } else {
        starveTimer.current = 0
      }

      /* Grognements d'ambiance */
      groanTimer.current += dt
      if (groanTimer.current >= nextGroan.current && countRef.current > 0) {
        groanTimer.current = 0
        nextGroan.current = 2.5 + Math.random() * 3.5
        Sfx.groan()
      }

      /* Vitesse joueur (annule la fouille s'il bouge) */
      const px = playerPos.current.x, pz = playerPos.current.z
      const moveSpeed = Math.hypot(px - prevX.current, pz - prevZ.current) / Math.max(dt, 1e-4)
      prevX.current = px
      prevZ.current = pz

      /* Rayons poussables : on déplace les positions vivantes */
      for (let i = 0; i < shelfRects.current.length; i++) {
        const rect = shelfRects.current[i]
        let count = 0, ax = 0, az = 0
        registry.current.forEach((z) => {
          const d = distToRect(z.pos.x, z.pos.z, rect.x, rect.z, rect.w / 2, rect.d / 2)
          if (d < PUSH_RANGE) { count++; ax += z.pos.x; az += z.pos.z }
        })
        if (count >= PUSH_THRESHOLD) {
          ax /= count; az /= count
          let dx = rect.x - ax, dz = rect.z - az
          const L = Math.hypot(dx, dz) || 1
          rect.x = THREE.MathUtils.clamp(rect.x + (dx / L) * PUSH_SPEED * dt, -ARENA + 2, ARENA - 2)
          rect.z = THREE.MathUtils.clamp(rect.z + (dz / L) * PUSH_SPEED * dt, -ARENA + 2, ARENA - 2)
        }
      }

      /* Réapprovisionnement des rayons */
      for (let i = 0; i < shelfStates.current.length; i++) {
        const st = shelfStates.current[i]
        if (!st.available && now >= st.cooldownUntil) st.available = true
      }

      /* Fouille du rayon le plus proche */
      let target = -1, best = Infinity
      for (let i = 0; i < shelfRects.current.length; i++) {
        if (!shelfStates.current[i].available) continue
        const s = shelfRects.current[i]
        const d = distToRect(px, pz, s.x, s.z, s.w / 2, s.d / 2)
        if (d < SEARCH_RANGE && d < best) { best = d; target = i }
      }
      promptRef.current = target !== -1

      if (target !== -1 && keys.current['KeyE'] && moveSpeed < 1.0) {
        searchProgress.current += dt / SEARCH_TIME
        if (searchProgress.current >= 1) {
          grantLoot()
          const st = shelfStates.current[target]
          st.available = false
          st.cooldownUntil = now + SHELF_COOLDOWN
          searchProgress.current = 0
        }
      } else {
        searchProgress.current = 0
      }

      if (now - lastPush.current > 0.05) {
        lastPush.current = now
        const ph = phaseRef.current
        const wave = waveRef.current
        let banner = null
        let countdown = 0
        if (ph === 'intro') banner = 'VAGUE ' + wave
        else if (ph === 'rest') { banner = 'VAGUE ' + wave + ' SURVÉCUE'; countdown = Math.ceil(REST_DURATION - phaseTimer.current) }
        const remaining = Math.max(0, quotaRef.current - killedRef.current)
        onSurvival({
          hunger: hungerRef.current,
          search: searchProgress.current,
          prompt: promptRef.current,
          wave, phase: ph, banner, countdown, remaining,
        })
      }
    }

    /* Synchronise les corps kinematic des rayons (toujours) */
    for (let i = 0; i < shelfBodies.current.length; i++) {
      const b = shelfBodies.current[i]
      const rect = shelfRects.current[i]
      if (b && rect) b.setNextKinematicTranslation({ x: rect.x, y: 0.6, z: rect.z })
    }

    /* Indicateurs de butin (suivent les rayons) */
    for (let i = 0; i < indicatorsRef.current.length; i++) {
      const ind = indicatorsRef.current[i]
      const rect = shelfRects.current[i]
      if (!ind || !rect) continue
      const avail = shelfStates.current[i].available
      ind.visible = avail
      if (avail) {
        ind.position.set(rect.x, 1.7 + Math.sin(now * 3 + i) * 0.12, rect.z)
        ind.rotation.y = now * 1.5
      }
    }
  })

  return (
    <>
      <FollowCamera target={playerPos} />
      <Lights />
      <Arena />
      <Shelves bodiesRef={shelfBodies} />
      <LootIndicators indicatorsRef={indicatorsRef} />
      <Bullets ref={bulletsRef} registry={registry} killZombies={killZombies} shelfRectsRef={shelfRects} playing={playing} />
      <Player
        posRef={playerPos}
        registry={registry}
        killZombies={killZombies}
        bulletsRef={bulletsRef}
        shelfRectsRef={shelfRects}
        ammoRef={ammoRef}
        hasPistolRef={hasPistolRef}
        hungerRef={hungerRef}
        onWeapon={onWeapon}
        onAmmo={onAmmo}
        playing={playing}
      />
      {zombies.map((z) => (
        <Zombie
          key={z.id}
          id={z.id}
          spawn={z.spawn}
          armored={z.armored}
          gait={z.gait}
          speedMul={z.speedMul}
          dying={z.dying}
          posRef={playerPos}
          registry={registry}
          onDamage={onDamage}
          onRemove={removeZombie}
          playing={playing}
        />
      ))}
    </>
  )
})

/* ---------------------------------------------------------------- */
/* Interface                                                         */
/* ---------------------------------------------------------------- */
function Gauge({ label, value, color }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      <div style={{ width: 220, height: 16, background: '#ffffff22', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: '100%', borderRadius: 8, background: color, transition: 'width 0.12s' }} />
      </div>
    </div>
  )
}

function WeaponSlot({ keyLabel, name, sub, active, danger, locked }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8,
      background: active ? '#3b82f6' : '#ffffff14',
      border: active ? '1px solid #93c5fd' : '1px solid transparent',
      opacity: locked ? 0.35 : (active ? 1 : 0.6),
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, width: 16, height: 16, lineHeight: '16px', textAlign: 'center', borderRadius: 4, background: '#00000040' }}>{keyLabel}</span>
      <span style={{ fontWeight: 600 }}>{name}</span>
      <span style={{ fontWeight: 700, color: danger ? '#fca5a5' : '#fde047' }}>{locked ? '—' : sub}</span>
    </div>
  )
}

function HUD({ health, hunger, score, weapon, ammo, hasPistol, search, prompt, toast, wave, banner, countdown, remaining, playing, muted, onToggleMute }) {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', color: '#fff', fontFamily: 'system-ui' }}>
      <style>{`@keyframes waveIn{from{opacity:0;transform:translate(-50%,-50%) scale(0.85)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}`}</style>

      <div style={{ position: 'absolute', top: 20, left: 20 }}>
        <Gauge label="SANTÉ" value={health} color={health > 50 ? '#22c55e' : health > 25 ? '#eab308' : '#ef4444'} />
        <Gauge label="FAIM" value={hunger} color={hunger > 50 ? '#f59e0b' : hunger > 20 ? '#fb923c' : '#ef4444'} />
      </div>

      {/* Indicateur de vague (haut-centre) */}
      {playing && (
        <div style={{ position: 'absolute', top: 18, left: '50%', transform: 'translateX(-50%)', textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: 4, fontWeight: 700, color: '#fbbf24' }}>VAGUE {wave}</div>
          {banner === null && (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{remaining} zombie{remaining > 1 ? 's' : ''} restant{remaining > 1 ? 's' : ''}</div>
          )}
        </div>
      )}

      <div style={{ position: 'absolute', top: 20, right: 24, textAlign: 'right' }}>
        <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.7 }}>ZOMBIES ABATTUS</div>
        <div style={{ fontSize: 34, fontWeight: 700 }}>{score}</div>
      </div>

      {/* Bannière d'annonce de vague */}
      {playing && banner && (
        <div key={`${wave}-${banner}`} style={{
          position: 'absolute', top: '42%', left: '50%', transform: 'translate(-50%, -50%)',
          textAlign: 'center', animation: 'waveIn 0.4s ease',
        }}>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 'clamp(34px, 6vw, 60px)', fontWeight: 800, letterSpacing: 3, color: '#f8f4ea', textShadow: '0 2px 20px #000' }}>{banner}</div>
          {countdown > 0 && (
            <div style={{ fontSize: 18, opacity: 0.8, marginTop: 8 }}>Prochaine vague dans {countdown}…</div>
          )}
        </div>
      )}

      <div style={{ position: 'absolute', bottom: 56, left: 20, display: 'flex', gap: 10 }}>
        <WeaponSlot keyLabel="1" name="Sabre" sub="∞" active={weapon === 'sabre'} />
        <WeaponSlot keyLabel="2" name="Pistolet" sub={ammo} danger={ammo === 0} active={weapon === 'pistol'} locked={!hasPistol} />
      </div>

      {toast && (
        <div style={{ position: 'absolute', top: 90, left: '50%', transform: 'translateX(-50%)', padding: '8px 18px', background: '#000000bb', borderRadius: 10, fontWeight: 600, fontSize: 15 }}>{toast}</div>
      )}

      {search > 0 ? (
        <div style={{ position: 'absolute', bottom: 110, left: '50%', transform: 'translateX(-50%)', textAlign: 'center' }}>
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 6 }}>Fouille en cours…</div>
          <div style={{ width: 200, height: 12, background: '#ffffff22', borderRadius: 6, overflow: 'hidden', margin: '0 auto' }}>
            <div style={{ width: `${search * 100}%`, height: '100%', background: '#fbbf24' }} />
          </div>
        </div>
      ) : prompt ? (
        <div style={{ position: 'absolute', bottom: 110, left: '50%', transform: 'translateX(-50%)', fontSize: 14, opacity: 0.85 }}>
          Maintenir <b>E</b> pour fouiller le rayon
        </div>
      ) : null}

      <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', fontSize: 13, opacity: 0.55 }}>
        ZQSD bouger · souris viser · clic/Espace attaquer · 1 / 2 changer d'arme · E fouiller
      </div>

      <button onClick={onToggleMute} title={muted ? 'Activer le son' : 'Couper le son'} style={{
        position: 'absolute', bottom: 16, right: 20, pointerEvents: 'auto',
        width: 40, height: 40, borderRadius: 20, border: '1px solid #ffffff22',
        background: '#00000055', color: '#fff', fontSize: 18, cursor: 'pointer',
      }}>{muted ? '🔇' : '🔊'}</button>
    </div>
  )
}

function Panel({ title, children }) {
  return (
    <div style={{ flex: '1 1 260px', minWidth: 240, textAlign: 'left', background: '#ffffff0d', border: '1px solid #ffffff14', borderRadius: 12, padding: '16px 20px' }}>
      <div style={{ fontSize: 12, letterSpacing: 3, opacity: 0.6, marginBottom: 10, color: '#fbbf24' }}>{title}</div>
      <div style={{ fontSize: 14.5, lineHeight: 1.7, opacity: 0.9 }}>{children}</div>
    </div>
  )
}

function StartScreen({ onPlay }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 22, color: '#f3ead7',
      fontFamily: 'system-ui', textAlign: 'center', padding: 24,
      background: 'radial-gradient(ellipse at center, #0d0d1299 0%, #07070b 80%)',
    }}>
      <div style={{ maxWidth: 720 }}>
        <div style={{ fontSize: 13, letterSpacing: 6, opacity: 0.6, marginBottom: 10 }}>SURVIE · MORTS-VIVANTS</div>
        <h1 style={{ margin: 0, fontFamily: 'Georgia, serif', fontSize: 'clamp(40px, 8vw, 76px)', fontWeight: 800, letterSpacing: 2, lineHeight: 1, color: '#f8f4ea' }}>
          SUPERMARKET<br />SURVIVAL
        </h1>
        <div style={{ width: 90, height: 3, background: '#ef4444', margin: '18px auto' }} />
        <p style={{ margin: 0, fontSize: 17, opacity: 0.8, lineHeight: 1.5 }}>
          Survivez aux vagues de morts-vivants dans un supermarché abandonné.<br />
          Fouillez les rayons pour vous armer et vous nourrir. Ne mourez pas de faim.
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center', maxWidth: 720 }}>
        <Panel title="COMMANDES">
          Déplacement — ZQSD<br />
          Viser — Souris<br />
          Attaquer — Clic / Espace<br />
          Changer d'arme — 1 / 2<br />
          Fouiller — E (maintenir)
        </Panel>
        <Panel title="SURVIE">
          Sabre — 2 coups, illimité<br />
          Pistolet — 1 balle, à trouver<br />
          Zombie-bob (gilet) — sabre uniquement<br />
          Faim — fouillez pour manger
        </Panel>
      </div>

      <button onClick={onPlay} style={{
        marginTop: 6, padding: '16px 48px', fontSize: 18, fontWeight: 800, letterSpacing: 2,
        color: '#fff', background: '#ef4444', border: 'none', borderRadius: 12, cursor: 'pointer',
        boxShadow: '0 6px 24px #ef444455',
      }}>
        JOUER
      </button>
    </div>
  )
}

function GameOver({ score, onRestart, onMenu }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, background: '#000000aa', color: '#fff', fontFamily: 'system-ui' }}>
      <div style={{ fontSize: 54, fontWeight: 800, letterSpacing: 2, color: '#ef4444' }}>VOUS ÊTES MORT</div>
      <div style={{ fontSize: 20, opacity: 0.85 }}>Zombies abattus : <b>{score}</b></div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <button onClick={onRestart} style={{ padding: '12px 28px', fontSize: 16, fontWeight: 700, color: '#fff', background: '#ef4444', border: 'none', borderRadius: 10, cursor: 'pointer' }}>
          REJOUER
        </button>
        <button onClick={onMenu} style={{ padding: '12px 28px', fontSize: 16, fontWeight: 700, color: '#f3ead7', background: '#ffffff14', border: '1px solid #ffffff22', borderRadius: 10, cursor: 'pointer' }}>
          MENU
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- */
/* App                                                               */
/* ---------------------------------------------------------------- */
export default function App() {
  const [gameState, setGameState] = useState('menu')
  const [health, setHealth] = useState(100)
  const [score, setScore] = useState(0)
  const [weapon, setWeapon] = useState('sabre')
  const [ammo, setAmmo] = useState(START_AMMO)
  const [hasPistol, setHasPistol] = useState(START_HAS_PISTOL)
  const [survival, setSurvival] = useState({ hunger: HUNGER_MAX, search: 0, prompt: false, wave: 1, banner: 'VAGUE 1', countdown: 0, remaining: WAVE_BASE })
  const [toast, setToast] = useState(null)
  const [muted, setMuted] = useState(false)
  const [gameKey, setGameKey] = useState(0)
  const toastTimer = useRef(null)

  const handleDamage = useCallback((d) => {
    setHealth((h) => {
      const nh = Math.max(0, h - d)
      if (nh <= 0) setGameState('gameover')
      return nh
    })
  }, [])
  const handleHeal = useCallback((a) => setHealth((h) => Math.min(100, h + a)), [])
  const handleKill = useCallback((n) => setScore((s) => s + n), [])
  const handleWeapon = useCallback((w) => setWeapon(w), [])
  const handleAmmo = useCallback((n) => setAmmo(n), [])
  const handlePistol = useCallback((v) => setHasPistol(v), [])
  const handleSurvival = useCallback((s) => setSurvival(s), [])
  const handlePickup = useCallback((text) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1600)
  }, [])
  const toggleMute = () => setMuted((m) => { const nm = !m; Sfx.setMuted(nm); return nm })

  useEffect(() => { if (gameState === 'gameover') Sfx.gameOver() }, [gameState])

  const resetState = () => {
    setHealth(100)
    setScore(0)
    setWeapon('sabre')
    setAmmo(START_AMMO)
    setHasPistol(START_HAS_PISTOL)
    setSurvival({ hunger: HUNGER_MAX, search: 0, prompt: false, wave: 1, banner: 'VAGUE 1', countdown: 0, remaining: WAVE_BASE })
    setToast(null)
    setGameKey((k) => k + 1)
  }
  const startGame = () => { Sfx.ensure(); resetState(); setGameState('playing') }
  const gotoMenu = () => { resetState(); setGameState('menu') }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0a0d', cursor: gameState === 'playing' ? 'crosshair' : 'default' }}>
      <Canvas shadows camera={{ position: [0, 14, 11], fov: 50 }}>
        <color attach="background" args={['#0d0d12']} />
        <fog attach="fog" args={['#0d0d12', 22, 58]} />
        <Physics gravity={[0, -20, 0]}>
          <Suspense fallback={null}>
            <Game
              key={gameKey}
              playing={gameState === 'playing'}
              onDamage={handleDamage}
              onHeal={handleHeal}
              onKill={handleKill}
              onWeapon={handleWeapon}
              onAmmo={handleAmmo}
              onPistol={handlePistol}
              onSurvival={handleSurvival}
              onPickup={handlePickup}
            />
          </Suspense>
        </Physics>
      </Canvas>
      <HUD
        health={health}
        hunger={survival.hunger}
        score={score}
        weapon={weapon}
        ammo={ammo}
        hasPistol={hasPistol}
        search={survival.search}
        prompt={survival.prompt}
        toast={toast}
        wave={survival.wave}
        banner={survival.banner}
        countdown={survival.countdown}
        remaining={survival.remaining}
        playing={gameState === 'playing'}
        muted={muted}
        onToggleMute={toggleMute}
      />
      {gameState === 'menu' && <StartScreen onPlay={startGame} />}
      {gameState === 'gameover' && <GameOver score={score} onRestart={startGame} onMenu={gotoMenu} />}
    </div>
  )
}
