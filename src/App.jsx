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
  useRef, useState, useEffect, useCallback, memo,
  forwardRef, useImperativeHandle,
} from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Physics, RigidBody, CuboidCollider, CapsuleCollider } from '@react-three/rapier'
import * as THREE from 'three'

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
function Player({ posRef, registry, killZombies, bulletsRef, shelfRectsRef, ammoRef, hasPistolRef, hungerRef, onWeapon, onAmmo, playing }) {
  const body = useRef()
  const visual = useRef()
  const sabreVis = useRef()
  const sabreSwing = useRef()
  const pistolVis = useRef()
  const muzzle = useRef()
  const keys = useKeyboard()
  const { camera } = useThree()

  const yaw = useRef(0)
  const aim = useRef(new THREE.Vector3())
  const weaponRef = useRef('sabre')
  const lastUse = useRef(-10)
  const swingStart = useRef(-10)
  const lastShot = useRef(-10)
  const mouseHeld = useRef(false)
  const spaceHeld = useRef(false)

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

    const now = state.clock.elapsedTime
    const weapon = weaponRef.current
    const firing = mouseHeld.current || spaceHeld.current
    const cd = weapon === 'sabre' ? SABRE_COOLDOWN : PISTOL_COOLDOWN

    if (firing && now - lastUse.current > cd) {
      const fx = Math.sin(yaw.current)
      const fz = Math.cos(yaw.current)

      if (weapon === 'sabre') {
        lastUse.current = now
        swingStart.current = now
        const cosHalf = Math.cos(SABRE_HALF_ANGLE)
        const kills = []
        registry.current.forEach((z, id) => {
          const vx = z.pos.x - t.x
          const vz = z.pos.z - t.z
          const d = Math.hypot(vx, vz)
          if (d < SABRE_RANGE && d > 0.001) {
            const dot = (vx / d) * fx + (vz / d) * fz
            if (dot > cosHalf && !losBlocked(shelfRectsRef.current, t.x, t.z, z.pos.x, z.pos.z)) {
              z.hp -= SABRE_DAMAGE        // 1 dégât : 2 coups pour tuer
              z.hitFlash = now
              if (z.hp <= 0) kills.push(id)
            }
          }
        })
        if (kills.length) killZombies(kills)
      } else if (ammoRef.current > 0) {
        lastUse.current = now
        lastShot.current = now
        bulletsRef.current?.fire(t.x + fx * 0.7, t.z + fz * 0.7, fx, fz)
        ammoRef.current -= 1
        onAmmo(ammoRef.current)
      }
    }

    if (sabreVis.current) sabreVis.current.visible = weapon === 'sabre'
    if (pistolVis.current) pistolVis.current.visible = weapon === 'pistol'
    if (sabreSwing.current) {
      const p = (now - swingStart.current) / SABRE_SWING_DURATION
      sabreSwing.current.rotation.y = p < 1 ? THREE.MathUtils.lerp(-1.1, 1.1, p) : -0.35
      sabreSwing.current.rotation.x = p < 1 ? -0.35 : 0.1
    }
    if (muzzle.current) muzzle.current.visible = now - lastShot.current < 0.05
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
        <mesh castShadow>
          <capsuleGeometry args={[0.4, 0.9, 8, 16]} />
          <meshStandardMaterial color="#3b82f6" />
        </mesh>
        <mesh position={[0, 0.9, 0]} castShadow>
          <sphereGeometry args={[0.28, 16, 16]} />
          <meshStandardMaterial color="#dbeafe" />
        </mesh>

        <group ref={sabreVis}>
          <group ref={sabreSwing} position={[0.35, 0.25, 0.2]}>
            <mesh position={[0, 0, 0.75]} castShadow>
              <boxGeometry args={[0.07, 0.07, 1.4]} />
              <meshStandardMaterial color="#e5e7eb" emissive="#93c5fd" emissiveIntensity={0.45} />
            </mesh>
          </group>
        </group>

        <group ref={pistolVis} visible={false} position={[0.3, 0.15, 0.3]}>
          <mesh position={[0, -0.08, 0]} castShadow>
            <boxGeometry args={[0.12, 0.2, 0.14]} />
            <meshStandardMaterial color="#1f2937" />
          </mesh>
          <mesh position={[0, 0.04, 0.18]} castShadow>
            <boxGeometry args={[0.1, 0.1, 0.36]} />
            <meshStandardMaterial color="#374151" />
          </mesh>
          <mesh ref={muzzle} position={[0, 0.04, 0.42]} visible={false}>
            <sphereGeometry args={[0.16, 8, 8]} />
            <meshStandardMaterial color="#fff7ae" emissive="#fde047" emissiveIntensity={3} transparent opacity={0.9} />
          </mesh>
        </group>
      </group>
    </RigidBody>
  )
}

/* ---------------------------------------------------------------- */
/* Zombie (normal ou blindé)                                         */
/* ---------------------------------------------------------------- */
function Zombie({ id, spawn, armored, posRef, registry, onDamage, playing }) {
  const body = useRef()
  const visual = useRef()
  const bodyMesh = useRef()
  const vestMesh = useRef()
  const entry = useRef({
    pos: new THREE.Vector3(spawn[0], 1, spawn[1]),
    lastHit: -10, hp: ZOMBIE_HP, armored, hitFlash: -10, armorSpark: -10,
  })

  useEffect(() => {
    registry.current.set(id, entry.current)
    return () => { registry.current.delete(id) }
  }, [id, registry])

  useFrame((state) => {
    if (!body.current) return
    const t = body.current.translation()
    entry.current.pos.set(t.x, t.y, t.z)
    const now = state.clock.elapsedTime

    if (playing) {
      const dx = posRef.current.x - t.x
      const dz = posRef.current.z - t.z
      const d = Math.hypot(dx, dz)
      const vy = body.current.linvel().y
      if (d > 0.001) {
        body.current.setLinvel({ x: (dx / d) * ZOMBIE_SPEED, y: vy, z: (dz / d) * ZOMBIE_SPEED }, true)
        if (visual.current) visual.current.rotation.y = Math.atan2(dx, dz)
      }
      if (d < CONTACT_RANGE && now - entry.current.lastHit > HIT_COOLDOWN) {
        entry.current.lastHit = now
        onDamage(ZOMBIE_DAMAGE)
      }
    } else {
      const vy = body.current.linvel().y
      body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
    }

    // feedback de dégâts (flash rouge) / ricochet (flash blanc sur le gilet)
    if (bodyMesh.current) {
      const f = now - entry.current.hitFlash < 0.12
      bodyMesh.current.material.emissive.setRGB(f ? 0.9 : 0, 0, 0)
    }
    if (vestMesh.current) {
      const s = now - entry.current.armorSpark < 0.12
      const v = s ? 0.9 : 0
      vestMesh.current.material.emissive.setRGB(v, v, v)
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
            {/* ex-policier */}
            <mesh ref={bodyMesh} castShadow>
              <capsuleGeometry args={[0.42, 0.85, 8, 16]} />
              <meshStandardMaterial color="#27384d" />
            </mesh>
            {/* gilet pare-balles */}
            <mesh ref={vestMesh} position={[0, 0.05, 0]} castShadow>
              <boxGeometry args={[0.82, 0.62, 0.52]} />
              <meshStandardMaterial color="#0f0f12" />
            </mesh>
            {/* tête */}
            <mesh position={[0, 0.88, 0.08]} castShadow>
              <sphereGeometry args={[0.26, 12, 12]} />
              <meshStandardMaterial color="#8a96a3" />
            </mesh>
            {/* casquette */}
            <mesh position={[0, 1.04, 0.02]} castShadow>
              <boxGeometry args={[0.5, 0.12, 0.5]} />
              <meshStandardMaterial color="#10131a" />
            </mesh>
          </>
        ) : (
          <>
            <mesh ref={bodyMesh} castShadow>
              <capsuleGeometry args={[0.4, 0.8, 8, 16]} />
              <meshStandardMaterial color="#5b7d3a" />
            </mesh>
            <mesh position={[0, 0.8, 0.1]} castShadow>
              <sphereGeometry args={[0.26, 12, 12]} />
              <meshStandardMaterial color="#7d9b54" />
            </mesh>
            <mesh position={[0, 0.15, 0.45]} rotation={[1.2, 0, 0]} castShadow>
              <boxGeometry args={[0.55, 0.16, 0.16]} />
              <meshStandardMaterial color="#46602e" />
            </mesh>
          </>
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
  const elapsed = useRef(0)

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

  useEffect(() => { countRef.current = zombies.length }, [zombies])

  const killZombies = useCallback((ids) => {
    setZombies((zs) => zs.filter((z) => !ids.includes(z.id)))
    onKill(ids.length)
  }, [onKill])

  const grantLoot = useCallback(() => {
    let type
    if (!hasPistolRef.current) {
      const r = Math.random()
      type = r < 0.45 ? 'pistol' : (r < 0.72 ? 'food' : 'ammo')
    } else {
      type = Math.random() < 0.6 ? 'food' : 'ammo'
    }
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
      /* Vagues */
      elapsed.current += dt
      spawnTimer.current += dt
      const interval = Math.max(0.9, 2.4 - elapsed.current * 0.02)
      if (spawnTimer.current >= interval && countRef.current < MAX_ZOMBIES) {
        spawnTimer.current = 0
        const a = Math.random() * Math.PI * 2
        const r = 14 + Math.random() * 5
        const armored = Math.random() < ARMORED_CHANCE
        setZombies((zs) => [...zs, { id: idRef.current++, spawn: [Math.cos(a) * r, Math.sin(a) * r], armored }])
      }

      /* Faim + famine */
      hungerRef.current = Math.max(0, hungerRef.current - HUNGER_DRAIN * dt)
      if (hungerRef.current <= 0) {
        starveTimer.current += dt
        if (starveTimer.current >= STARVE_TICK) { starveTimer.current = 0; onDamage(STARVE_DAMAGE) }
      } else {
        starveTimer.current = 0
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
        onSurvival({ hunger: hungerRef.current, search: searchProgress.current, prompt: promptRef.current })
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
          posRef={playerPos}
          registry={registry}
          onDamage={onDamage}
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

function HUD({ health, hunger, score, weapon, ammo, hasPistol, search, prompt, toast }) {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', color: '#fff', fontFamily: 'system-ui' }}>
      <div style={{ position: 'absolute', top: 20, left: 20 }}>
        <Gauge label="SANTÉ" value={health} color={health > 50 ? '#22c55e' : health > 25 ? '#eab308' : '#ef4444'} />
        <Gauge label="FAIM" value={hunger} color={hunger > 50 ? '#f59e0b' : hunger > 20 ? '#fb923c' : '#ef4444'} />
      </div>

      <div style={{ position: 'absolute', top: 20, right: 24, textAlign: 'right' }}>
        <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.7 }}>ZOMBIES ABATTUS</div>
        <div style={{ fontSize: 34, fontWeight: 700 }}>{score}</div>
      </div>

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
    </div>
  )
}

function GameOver({ score, onRestart }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, background: '#000000aa', color: '#fff', fontFamily: 'system-ui' }}>
      <div style={{ fontSize: 54, fontWeight: 800, letterSpacing: 2, color: '#ef4444' }}>VOUS ÊTES MORT</div>
      <div style={{ fontSize: 20, opacity: 0.85 }}>Zombies abattus : <b>{score}</b></div>
      <button onClick={onRestart} style={{ marginTop: 8, padding: '12px 28px', fontSize: 16, fontWeight: 700, color: '#fff', background: '#ef4444', border: 'none', borderRadius: 10, cursor: 'pointer' }}>
        REJOUER
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- */
/* App                                                               */
/* ---------------------------------------------------------------- */
export default function App() {
  const [gameState, setGameState] = useState('playing')
  const [health, setHealth] = useState(100)
  const [score, setScore] = useState(0)
  const [weapon, setWeapon] = useState('sabre')
  const [ammo, setAmmo] = useState(START_AMMO)
  const [hasPistol, setHasPistol] = useState(START_HAS_PISTOL)
  const [survival, setSurvival] = useState({ hunger: HUNGER_MAX, search: 0, prompt: false })
  const [toast, setToast] = useState(null)
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

  const restart = () => {
    setHealth(100)
    setScore(0)
    setWeapon('sabre')
    setAmmo(START_AMMO)
    setHasPistol(START_HAS_PISTOL)
    setSurvival({ hunger: HUNGER_MAX, search: 0, prompt: false })
    setToast(null)
    setGameState('playing')
    setGameKey((k) => k + 1)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0a0d', cursor: 'crosshair' }}>
      <Canvas shadows camera={{ position: [0, 14, 11], fov: 50 }}>
        <color attach="background" args={['#0d0d12']} />
        <fog attach="fog" args={['#0d0d12', 22, 58]} />
        <Physics gravity={[0, -20, 0]}>
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
      />
      {gameState === 'gameover' && <GameOver score={score} onRestart={restart} />}
    </div>
  )
}
