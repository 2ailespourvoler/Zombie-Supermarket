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

const BOB_URL = '/bob_lite.glb'
const BOB_MODEL_SCALE = 1.0         // même rig que le zombie
const BOB_FEET_Y = -0.8
const BOB_MODEL_FACING = 0          // passe à Math.PI si Bob marche "à reculons"
useGLTF.preload(BOB_URL, true)

const FEMALE_URL = '/female_lite.glb'
const FEMALE_MODEL_SCALE = 1.0      // même rig
const FEMALE_FEET_Y = -0.8
const FEMALE_MODEL_FACING = 0       // passe à Math.PI si elle marche "à reculons"
useGLTF.preload(FEMALE_URL, true)

const FAT_URL = '/fat_zombie.glb'
const FAT_MODEL_SCALE = 1.20        // gros zombie : plus imposant que les autres
const FAT_FEET_Y = -0.95            // abaissé pour compenser la plus grande échelle (à ajuster si flotte/s'enfonce)
const FAT_MODEL_FACING = 0          // passe à Math.PI s'il marche "à reculons"
const FAT_DEATH_SPEED = 1.8         // accélère la chute (clip "death" natif = 4,7 s, trop long)
useGLTF.preload(FAT_URL, true)

const PLAYER_URL = '/player_lite.glb'
const PLAYER_MODEL_SCALE = 1.0      // squelette ~1,67 m
const PLAYER_FEET_Y = -0.8
const PLAYER_MODEL_FACING = 0       // passe à Math.PI si le joueur regarde "à l'envers"
useGLTF.preload(PLAYER_URL, true)

const SABRE_URL = '/sabre_lite.glb'
const PISTOL_URL = '/pistol_lite.glb'
const UZI_URL = '/uzi_lite.glb'
useGLTF.preload(SABRE_URL, true)
useGLTF.preload(PISTOL_URL, true)
useGLTF.preload(UZI_URL, true)
// Armes attachées à l'os RightHand (échelle monde 0,01) -> holder ×100 = repère en mètres.
const WEAPON_HOLDER_SCALE = 100
const SABRE_SCALE = 0.342           // dim native 1,9 -> ~0,65 m
const SABRE_POS = [-0.008, 0.086, -0.343] // main sur la poignée (décalage calculé)
const SABRE_ROT = [-1.350, -0.634, -0.779] // lame perpendiculaire au bras, pointée vers l'avant (calculé par PCA)
const PISTOL_SCALE = 0.182          // -> ~0,35 m (agrandi de 50 %)
const PISTOL_POS = [-0.010, 0.152, 0.012]   // manche dans la main (calculé, ancré haut de poignée)
const PISTOL_ROT = [-1.543, 1.502, 0.505]   // canon vers le sol, au-dessus de la main (calculé)
const MUZZLE_POS = [-0.022, 0.316, 0.039]   // bout du canon (pour le flash, calculé)
const UZI_SCALE = 0.26              // -> ~0,5 m
const UZI_POS = [-0.008, 0.128, 0.142]      // manche dans la main (calculé)
const UZI_ROT = [-1.760, 1.507, 0.656]      // canon vers le sol, au-dessus de la main (calculé)
const UZI_MUZZLE_POS = [-0.022, 0.359, 0.142]

/* ---------------------------------------------------------------- */
/* Réglages de gameplay                                              */
/* ---------------------------------------------------------------- */
const PLAYER_SPEED = 6
const ZOMBIE_SPEED = 2.6

const ZOMBIE_HP = 2
const SABRE_DAMAGE = 1          // 2 coups de sabre pour tuer
const BULLET_DAMAGE = 2         // 1 balle pour tuer
const ARMORED_CHANCE = 0.05     // 1 zombie-bob sur 20
const FAT_CHANCE = 0.10         // 10 % de gros zombies
const FAT_SPEED_MUL = 0.5       // gros zombie = lent (vitesse réduite de moitié)
const FAT_HP = 4                // 2 balles pour tuer (BULLET_DAMAGE=2 -> 4/2 = 2 tirs)
const FAT_SABRE_DAMAGE = 2      // 2 coups de sabre pour tuer (4/2 = 2 coups)

const SABRE_RANGE = 2.6
const SABRE_HALF_ANGLE = 1.0
const SABRE_COOLDOWN = 0.45
const SABRE_SWING_DURATION = 0.3

const PISTOL_COOLDOWN = 0.22
const UZI_COOLDOWN = 0.07           // tir rapide en rafale
const UZI_BULLET_SPREAD = 0.07      // légère dispersion (rad)
const UZI_AMMO_BONUS = 150          // munitions fournies avec l'Uzi
const BULLET_SPEED = 40
const BULLET_LIFE = 1.1
const BULLET_HIT_RADIUS = 0.6
const BULLET_POOL = 40

const CONTACT_RANGE = 1.25
const HIT_COOLDOWN = 0.8
const ZOMBIE_DAMAGE = 10
const ARENA = 24

/* Vagues — arrivée continue, rythmée par le temps (la pression ne retombe jamais) */
const WAVE_DURATION = 45            // durée de la vague 1 (s) ; -2 s par vague ensuite
const WAVE_DUR_STEP = 2             // réduction de durée par vague
const WAVE_DUR_MIN = 20             // plancher de durée (s)
const WAVE_COUNT_BASE = 8           // nombre de zombies à la vague 1
const WAVE_COUNT_STEP = 2           // +2 zombies par vague
const WAVE_COUNT_MAX = 40           // plafond de zombies par vague
const WAVE_BURST_INTERVAL = 0.15    // temps entre 2 zombies d'une même vague (salve quasi groupée)
const BANNER_DURATION = 2.2         // durée d'affichage de l'annonce "VAGUE N"
const waveCount = (w) => Math.min(WAVE_COUNT_MAX, WAVE_COUNT_BASE + (w - 1) * WAVE_COUNT_STEP)
const waveDuration = (w) => Math.max(WAVE_DUR_MIN, WAVE_DURATION - (w - 1) * WAVE_DUR_STEP)

/* Vue rapprochée 3ᵉ personne (touche V) — par-dessus l'épaule droite */
const OTS_BACK = 1.2        // recul derrière le joueur (m)
const OTS_UP = 1.5          // hauteur au-dessus du centre du joueur (≈1 m au-dessus de l'épaule)
const OTS_RIGHT = 0.6       // décalage vers l'épaule droite
const OTS_LOOK_AHEAD = 8    // distance du point visé devant le joueur
const OTS_LOOK_UP = 1.1     // hauteur du point visé
const OTS_TURN_SMOOTH = 7   // amorti de la rotation (plus haut = plus réactif)
const OTS_POS_SMOOTH = 12   // amorti de la position

/* Marqueur de build affiché à l'écran (pour vérifier quel déploiement est en ligne) */
const BUILD_TAG = 'build : vue épaule (V)'

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
const SHELF_USES = 1            // fouilles possibles par boutique avant épuisement (pénurie)
const MARKET_FOOD = 10         // faim rendue par une gondole de supermarché (peu)
const DETONATE_TIME = 1.15     // délai (s) entre l'explosion de la sortie et la victoire

/* Objectif de mission (Palier 4) : objets de recherche cachés dans les gondoles des supermarchés.
   Les galeries, elles, contiennent une CLÉ au sol qui ouvre leur porte. */
const QUEST_ITEMS = {
  dynamite: { id: 'dynamite', label: 'Caisse de dynamite', emoji: '🧨' },
  meds: { id: 'meds', label: 'Grosse boîte de médicaments', emoji: '💊' },
}
const QUEST_ORDER = ['dynamite', 'meds']
const objectiveDone = (c) => QUEST_ORDER.every((id) => c[id])
const KEY_PICKUP_RANGE = 1.7   // distance de ramassage de la clé (galerie)

/* Galerie marchande : couloir central, devantures de chaque côté */
const CORRIDOR_HW = 6            // demi-largeur du couloir jouable (x ∈ [-6, 6])
const CORRIDOR_HL = 22           // demi-longueur (z ∈ [-22, 22])
const WALL_H = 3.4               // hauteur des murs / devantures
const PLAYER_START_Z = CORRIDOR_HL - 4   // départ légèrement avancé, avant le 1er banc (z=15)
const FUSE_TIME = 3.0            // compte à rebours (s) avant l'explosion de la sortie
const BLAST_RADIUS = 5.5         // rayon de la déflagration (dégâts si trop proche)
const BLAST_DAMAGE = 55          // dégâts au centre de l'explosion

/* Arène finale (Palier 5) */
const ARENA_HALF = 6.5           // demi-côté du carré (agrandi de 30 %)
const ARENA_CENTER_Z = 0         // centre de l'arène (le projecteur pointe ici)
const BOSS_URL = '/boss.glb'
const BOSS_MODEL_SCALE = 1.7     // taille du boss
const BOSS_FEET_Y = -1.5         // cale les pieds au sol (à ajuster si flotte/s'enfonce)
const BOSS_HP_1 = 40             // phase 1 (arme à feu) : ~20 balles (BULLET_DAMAGE=2)
const BOSS_HP_2 = 12             // phase 2 (sabre) : ~12 coups (SABRE_DAMAGE=1)
const BOSS_SPEED_MUL = 0.9       // boss actif (court vers le joueur)
const BOSS_DODGE_SPEED = 8       // vitesse de l'esquive latérale (roulade)
const BOSS_DODGE_TIME = 0.6      // durée de l'esquive
const BOSS_DODGE_CD = 2.2        // délai entre deux esquives
const BOSS_ROAR_CD = 6           // délai entre deux hurlements
const BOSS_RECOIL_SPEED = 5      // recul quand il encaisse une balle
const BOSS_RECOIL_TIME = 0.18
const SHOP_TYPES = ['pharmacie', 'armurerie', 'epicerie', 'boulangerie']
const STORE_SLOTS = [-18, -12, -6, 0, 6, 12, 18]   // centres z des devantures
const STORE_W = 5.4              // largeur d'une devanture (le long de z)
const DOOR_W = 1.8               // largeur de la porte vitrée
const SIGN_W = 3.8               // largeur de l'enseigne (ratio 4:1 -> hauteur SIGN_W/4)

/* Zones du supermarché : traversée successive, une seule active à la fois.
   type: 'galerie' (couloir + devantures, on y trouve une CLÉ au sol)
   ou 'supermarche' (espace ouvert + gondoles, on y trouve un OBJET DE MISSION) */
const ZONES = [
  { name: "Galerie d'entrée", type: 'galerie' },
  { name: 'Supermarché 1', type: 'supermarche', quest: 'dynamite' },
  { name: 'Galerie 2', type: 'galerie' },
  { name: 'Supermarché 2', type: 'supermarche', quest: 'meds' },
  { name: 'Galerie de sortie', type: 'galerie', exit: true },   // on fait sauter la porte -> arène
  { name: 'Arène finale', type: 'arene' },                       // combat final : boss
]
const DOOR_TRIGGER_HW = 2.2      // demi-largeur de la porte du fond (zone de passage)

/* Disposition des îlots de gondoles dans une zone "supermarché" */
const MARKET_BLOCK_W = 2.6       // largeur d'un îlot (X)
const MARKET_BLOCK_D = 1.3       // profondeur d'un îlot (Z)
const MARKET_BLOCKS = [
  { x: -3.6, z: -13 }, { x: 3.6, z: -13 },
  { x: -3.6, z: -6.5 }, { x: 3.6, z: -6.5 },
  { x: -3.6, z: 0 }, { x: 3.6, z: 0 },
  { x: -3.6, z: 6.5 }, { x: 3.6, z: 6.5 },
  { x: -3.6, z: 13 }, { x: 3.6, z: 13 },
]

function buildStorefronts(zoneIdx) {
  const zone = ZONES[zoneIdx] || {}
  let arr = []
  if (zone.type === 'supermarche') {
    // points de fouille = îlots de gondoles (side 0)
    arr = MARKET_BLOCKS.map((b) => ({
      x: b.x, z: b.z, side: 0, w: MARKET_BLOCK_W, d: MARKET_BLOCK_D,
      type: SHOP_TYPES[Math.floor(Math.random() * SHOP_TYPES.length)],
    }))
  } else {
    // points de fouille = devantures le long des deux murs
    for (const side of [-1, 1]) for (const z of STORE_SLOTS) {
      arr.push({ x: side * CORRIDOR_HW, z, side, type: SHOP_TYPES[Math.floor(Math.random() * SHOP_TYPES.length)] })
    }
  }
  // objet de mission caché dans une gondole (supermarché uniquement ; les galeries ont une clé au sol)
  if (zone.type === 'supermarche' && zone.quest && arr.length) {
    arr[Math.floor(Math.random() * arr.length)].quest = QUEST_ITEMS[zone.quest]
  }
  return arr
}

const FOND_SEG_W = (CORRIDOR_HW + 1) - DOOR_TRIGGER_HW   // largeur d'un demi-mur du fond
const FOND_SEG_X = DOOR_TRIGGER_HW + FOND_SEG_W / 2       // centre x de chaque demi-mur
const WALLS = [
  { x: -FOND_SEG_X, z: -CORRIDOR_HL, w: FOND_SEG_W, d: 1 },  // fond gauche
  { x: FOND_SEG_X, z: -CORRIDOR_HL, w: FOND_SEG_W, d: 1 },   // fond droit (ouverture au centre = porte)
  { x: 0, z: CORRIDOR_HL, w: CORRIDOR_HW * 2 + 2, d: 1 },    // entrée
  { x: -CORRIDOR_HW, z: 0, w: 1, d: CORRIDOR_HL * 2 + 2 },   // mur gauche
  { x: CORRIDOR_HW, z: 0, w: 1, d: CORRIDOR_HL * 2 + 2 },    // mur droit
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
    uziShot() { ensure(); noise({ dur: 0.05, gain: 0.5, type: 'highpass', f: 1200, sweepTo: 600 }); blip({ type: 'square', f0: 220, f1: 70, dur: 0.045, gain: 0.18 }) },
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
    explosion() { ensure(); noise({ dur: 0.7, gain: 0.6, type: 'lowpass', f: 900, sweepTo: 120 }); blip({ type: 'sine', f0: 90, f1: 30, dur: 0.7, gain: 0.4 }); blip({ type: 'square', f0: 60, f1: 25, dur: 0.5, gain: 0.3 }) },
    roar() { ensure(); blip({ type: 'sawtooth', f0: 160, f1: 60, dur: 0.7, gain: 0.34 }); blip({ type: 'square', f0: 90, f1: 45, dur: 0.7, gain: 0.22 }); noise({ dur: 0.5, gain: 0.2, type: 'lowpass', f: 700 }) },
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
function FollowCamera({ target, aimRef, modeRef, shakeRef }) {
  const { camera } = useThree()
  const camYaw = useRef(0)
  useFrame((state, dt) => {
    const p = target.current
    if (modeRef && modeRef.current === 'shoulder') {
      // rotation amortie (chemin le plus court)
      const tgt = aimRef ? aimRef.current : 0
      let dd = tgt - camYaw.current
      dd = Math.atan2(Math.sin(dd), Math.cos(dd))
      camYaw.current += dd * Math.min(1, dt * OTS_TURN_SMOOTH)
      const y = camYaw.current
      const fx = Math.sin(y), fz = Math.cos(y)   // avant
      const rx = Math.cos(y), rz = -Math.sin(y)  // droite
      // caméra : derrière + au-dessus + décalée vers l'épaule droite
      camTarget.set(
        p.x - fx * OTS_BACK + rx * OTS_RIGHT,
        p.y + OTS_UP,
        p.z - fz * OTS_BACK + rz * OTS_RIGHT,
      )
      camera.position.lerp(camTarget, Math.min(1, dt * OTS_POS_SMOOTH))
      camera.lookAt(
        p.x + fx * OTS_LOOK_AHEAD + rx * OTS_RIGHT,
        p.y + OTS_LOOK_UP,
        p.z + fz * OTS_LOOK_AHEAD + rz * OTS_RIGHT,
      )
      return
    }
    camTarget.set(p.x, p.y + 14, p.z + 11)
    camera.position.lerp(camTarget, 0.1)
    // secousse pendant l'explosion de la sortie
    if (shakeRef && shakeRef.current && shakeRef.current.active) {
      const k = Math.min(1, (state.clock.elapsedTime - shakeRef.current.t) / DETONATE_TIME)
      const amp = (1 - k) * 0.7
      camera.position.x += (Math.random() - 0.5) * amp
      camera.position.y += (Math.random() - 0.5) * amp
      camera.position.z += (Math.random() - 0.5) * amp
    }
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

/* Lampe industrielle suspendue : source + cône de lumière visible */
function LightCone({ x, z }) {
  return (
    <group position={[x, 0, z]}>
      <pointLight position={[0, 8.5, 0]} intensity={0.95} distance={17} color="#ffe6b8" />
      <mesh position={[0, 4.5, 0]}>
        <coneGeometry args={[2.7, 8.6, 24, 1, true]} />
        <meshBasicMaterial color="#ffe6b8" transparent opacity={0.06} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 8.8, 0]}>
        <cylinderGeometry args={[0.34, 0.5, 0.4, 12]} />
        <meshStandardMaterial color="#2a2f3a" metalness={0.5} roughness={0.6} />
      </mesh>
    </group>
  )
}

/* Éclairage de l'arène : entrepôt sombre mais lisible, plusieurs cônes de lumière */
function ArenaLights() {
  const lamps = [[-3.4, -3.6], [3.4, -3.6], [-3.4, 3.6], [3.4, 3.6]]
  return (
    <>
      <ambientLight intensity={0.22} />
      <hemisphereLight args={['#3a4256', '#0a0a10', 0.28]} />
      <spotLight position={[0, 17, ARENA_CENTER_Z]} angle={0.7} penumbra={0.5} intensity={2.2} distance={46} castShadow color="#fff2d8" shadow-mapSize-width={1024} shadow-mapSize-height={1024} />
      {lamps.map(([x, z], i) => <LightCone key={i} x={x} z={ARENA_CENTER_Z + z} />)}
    </>
  )
}

/* Un côté de barrière anti-émeute (le long de X ; le parent l'oriente) */
function BarrierSide({ length }) {
  const n = Math.max(2, Math.round(length / 1.0))
  return (
    <group>
      {[1.0, 0.55].map((y, k) => (
        <mesh key={k} position={[0, y, 0]}><boxGeometry args={[length, 0.06, 0.06]} /><meshStandardMaterial color="#9aa3ad" metalness={0.6} roughness={0.5} /></mesh>
      ))}
      {Array.from({ length: n + 1 }).map((_, k) => {
        const x = -length / 2 + k * (length / n)
        return <mesh key={k} position={[x, 0.62, 0]}><boxGeometry args={[0.05, 1.2, 0.05]} /><meshStandardMaterial color="#8a929c" metalness={0.6} roughness={0.5} /></mesh>
      })}
      <mesh position={[0, 0.06, 0]}><boxGeometry args={[length, 0.12, 0.35]} /><meshStandardMaterial color="#6b7280" metalness={0.5} roughness={0.6} /></mesh>
    </group>
  )
}

/* Carré de barrières de l'arène (côté = half*2) */
function ArenaBarriers({ half }) {
  const L = half * 2
  return (
    <group position={[0, 0, ARENA_CENTER_Z]}>
      {[-half, half].map((z, i) => (
        <RigidBody key={'ns' + i} type="fixed" colliders={false} position={[0, 0, z]}>
          <CuboidCollider args={[half, 0.7, 0.1]} position={[0, 0.7, 0]} />
          <BarrierSide length={L} />
        </RigidBody>
      ))}
      {[-half, half].map((x, i) => (
        <RigidBody key={'ew' + i} type="fixed" colliders={false} position={[x, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <CuboidCollider args={[half, 0.7, 0.1]} position={[0, 0.7, 0]} />
          <BarrierSide length={L} />
        </RigidBody>
      ))}
    </group>
  )
}

function Arena() {
  const FLOOR_W = CORRIDOR_HW * 2 + 1    // sol dallé arrêté au bord des murs (vide sombre au-delà)
  const FLOOR_L = CORRIDOR_HL * 2 + 1
  const tileTex = useMemo(() => {
    const TILE_M = 0.65                 // côté du carreau (mètres)
    const px = 256
    const c = document.createElement('canvas'); c.width = c.height = px
    const g = c.getContext('2d')
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, px, px)        // carreau blanc
    const lw = Math.max(2, Math.round(px * 0.022))           // joint ~2 %
    g.fillStyle = '#d2d2d8'                                   // gris clair
    g.fillRect(0, 0, px, lw)                                  // joint haut
    g.fillRect(0, 0, lw, px)                                  // joint gauche
    const tex = new THREE.CanvasTexture(c)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(FLOOR_W / TILE_M, FLOOR_L / TILE_M)       // carreaux carrés de 0,65 m
    tex.anisotropy = 8
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [FLOOR_W, FLOOR_L])

  return (
    <>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[40, 0.5, 40]} position={[0, -0.5, 0]} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[FLOOR_W, FLOOR_L]} />
          <meshStandardMaterial map={tileTex} roughness={0.85} metalness={0} />
        </mesh>
      </RigidBody>

      {WALLS.map((w, i) => (
        <RigidBody key={'w' + i} type="fixed" colliders={false} position={[w.x, WALL_H / 2, w.z]}>
          <CuboidCollider args={[w.w / 2, WALL_H / 2, w.d / 2]} />
          <mesh receiveShadow castShadow>
            <boxGeometry args={[w.w, WALL_H, w.d]} />
            <meshStandardMaterial color="#222633" roughness={0.95} metalness={0} />
          </mesh>
        </RigidBody>
      ))}
    </>
  )
}

/* ---------------------------------------------------------------- */
/* Décor : bancs + bacs à plantes (fixes, alignés au centre)         */
/* ---------------------------------------------------------------- */
const BENCH_ZS = [-15, -7, 7, 15]   // 4 blocs ; le centre (z≈0) reste libre pour le départ du joueur

function Planter({ z }) {
  return (
    <group position={[0, 0, z]}>
      <mesh castShadow receiveShadow position={[0, 0.25, 0]}>
        <boxGeometry args={[0.7, 0.5, 0.7]} />
        <meshStandardMaterial color="#6f4a34" roughness={0.9} metalness={0} />
      </mesh>
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[0.6, 0.06, 0.6]} />
        <meshStandardMaterial color="#2e211a" roughness={1} metalness={0} />
      </mesh>
      <mesh castShadow position={[0, 0.76, 0]}>
        <icosahedronGeometry args={[0.34, 0]} />
        <meshStandardMaterial color="#3f7d3a" roughness={1} metalness={0} flatShading />
      </mesh>
      <mesh castShadow position={[0.18, 0.62, 0.1]}>
        <icosahedronGeometry args={[0.22, 0]} />
        <meshStandardMaterial color="#4c9043" roughness={1} metalness={0} flatShading />
      </mesh>
      <mesh castShadow position={[-0.16, 0.64, -0.12]}>
        <icosahedronGeometry args={[0.2, 0]} />
        <meshStandardMaterial color="#357036" roughness={1} metalness={0} flatShading />
      </mesh>
    </group>
  )
}

function BenchBlock({ z }) {
  const wood = '#7c5a3a'
  const metal = '#2b2f3a'
  return (
    <RigidBody type="fixed" colliders={false} position={[0, 0, z]}>
      {/* un seul collider couvrant bancs + bacs : îlot infranchissable */}
      <CuboidCollider args={[0.5, 0.5, 1.85]} position={[0, 0.5, 0]} />
      {/* pieds métal */}
      {[-0.85, 0.85].map((zz, i) => (
        <mesh key={i} castShadow receiveShadow position={[0, 0.22, zz]}>
          <boxGeometry args={[0.92, 0.44, 0.12]} />
          <meshStandardMaterial color={metal} roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
      {/* assise double face */}
      <mesh castShadow receiveShadow position={[0, 0.46, 0]}>
        <boxGeometry args={[0.9, 0.08, 2.2]} />
        <meshStandardMaterial color={wood} roughness={0.85} metalness={0} />
      </mesh>
      {/* dossier central */}
      <mesh castShadow receiveShadow position={[0, 0.72, 0]}>
        <boxGeometry args={[0.1, 0.42, 2.2]} />
        <meshStandardMaterial color={wood} roughness={0.85} metalness={0} />
      </mesh>
      {/* bacs à plantes aux deux bouts, dans le sens de la galerie */}
      <Planter z={1.45} />
      <Planter z={-1.45} />
    </RigidBody>
  )
}

function BenchRow() {
  return <>{BENCH_ZS.map((z) => <BenchBlock key={z} z={z} />)}</>
}

/* ---------------------------------------------------------------- */
/* Rayons poussables (kinematic, déplacés par <Game>)               */
/* ---------------------------------------------------------------- */
const GONDOLA_URL = '/gondola_lite.glb'
const GONDOLA_W = 1.38     // largeur native (X, axe de pavage)
const GONDOLA_H = 1.90     // hauteur native (Y)
const GONDOLA_D = 1.43     // profondeur native (Z) — déjà double face
const GONDOLA_BASE = 0.95  // distance origine -> base (pour poser au sol)
const GONDOLA_FACE = 0     // oriente la façade (0 ou Math.PI si inversé)
useGLTF.preload(GONDOLA_URL, true)
useGLTF.preload(BOSS_URL, true)

/* Pave un rayon (w×d) de travées de gondole (rangée simple, modèle déjà double face) */
function GondolaModel({ w, d }) {
  const { scene } = useGLTF(GONDOLA_URL, true)
  const layout = useMemo(() => {
    const runLen = Math.max(w, d)
    const runRotY = w >= d ? 0 : Math.PI / 2
    const count = Math.max(1, Math.round(runLen / GONDOLA_W))
    const bayW = runLen / count
    const scale = bayW / GONDOLA_W
    const localY = GONDOLA_BASE * scale - 0.6   // pose la base au sol (RigidBody à y=0,6)
    const offs = []
    for (let j = 0; j < count; j++) offs.push(-runLen / 2 + bayW * (j + 0.5))
    return { runRotY, scale, localY, offs }
  }, [w, d])

  const clones = useMemo(() => layout.offs.map(() => {
    const c = scene.clone(true)
    c.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true
        o.material = o.material.clone()
        o.material.metalness = 0
      }
    })
    return c
  }), [scene, layout])

  return (
    <group rotation={[0, layout.runRotY, 0]} position={[0, layout.localY, 0]}>
      {layout.offs.map((off, k) => (
        <group key={k} position={[off, 0, 0]} rotation={[0, GONDOLA_FACE, 0]} scale={layout.scale}>
          <primitive object={clones[k]} />
        </group>
      ))}
    </group>
  )
}

/* Clé à ramasser au sol (galeries) : brille, tourne, se prend en s'approchant */
function KeyPickup({ pos, pickedRef }) {
  const g = useRef()
  useFrame((s) => {
    if (!g.current) return
    g.current.visible = !(pickedRef && pickedRef.current)   // disparaît une fois en poche
    g.current.rotation.y = s.clock.elapsedTime * 2
    g.current.position.y = 1.0 + Math.sin(s.clock.elapsedTime * 3) * 0.12
  })
  const mat = <meshStandardMaterial color="#fde047" emissive="#f59e0b" emissiveIntensity={1.5} metalness={0.6} roughness={0.3} toneMapped={false} />
  return (
    <group ref={g} position={[pos.x, 1.0, pos.z]}>
      <mesh><torusGeometry args={[0.16, 0.05, 8, 20]} />{mat}</mesh>
      <mesh position={[0, -0.28, 0]}><boxGeometry args={[0.06, 0.34, 0.06]} />{mat}</mesh>
      <mesh position={[0.09, -0.42, 0]}><boxGeometry args={[0.14, 0.06, 0.06]} />{mat}</mesh>
      <pointLight color="#f59e0b" intensity={2} distance={3.5} />
    </group>
  )
}

/* Zone "supermarché" : îlots de gondoles (obstacles fixes que l'on fouille) */
function Supermarket({ spots }) {
  return (
    <group>
      {spots.map((s, i) => (
        <RigidBody key={i} type="fixed" colliders={false} position={[s.x, 0.6, s.z]}>
          <CuboidCollider args={[(s.w || MARKET_BLOCK_W) / 2, 0.95, (s.d || MARKET_BLOCK_D) / 2]} position={[0, 0.3, 0]} />
          <GondolaModel w={s.w || MARKET_BLOCK_W} d={s.d || MARKET_BLOCK_D} />
        </RigidBody>
      ))}
    </group>
  )
}

/* Enseigne : charge /signs/<type>.png, avec un visuel provisoire en attendant */
const SHOP_COLORS = { pharmacie: '#16a34a', armurerie: '#7f1d1d', epicerie: '#b45309', boulangerie: '#a16207' }
function makeSignPlaceholder(type) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256
  const g = c.getContext('2d')
  g.fillStyle = SHOP_COLORS[type] || '#334155'; g.fillRect(0, 0, 1024, 256)
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 10; g.strokeRect(20, 20, 984, 216)
  g.fillStyle = '#ffffff'; g.font = 'bold 110px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(type.toUpperCase(), 512, 138)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8
  return t
}
function ShopSign({ type, width }) {
  const placeholder = useMemo(() => makeSignPlaceholder(type), [type])
  const [map, setMap] = useState(placeholder)
  useEffect(() => {
    let alive = true
    new THREE.TextureLoader().load(
      `/signs/${type}.png`,
      (t) => { if (alive) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; setMap(t) } },
      undefined,
      () => {},   // 404 -> on garde le provisoire
    )
    return () => { alive = false }
  }, [type])
  return (
    <mesh>
      <planeGeometry args={[width, width / 4]} />
      <meshBasicMaterial map={map} toneMapped={false} />
    </mesh>
  )
}

/* Devantures de magasins le long des deux murs du couloir */
function Storefronts({ storefronts }) {
  return (
    <group>
      {storefronts.map((s, i) => {
        const faceX = s.x - s.side * 0.55          // face intérieure (vers le couloir)
        const ry = s.side > 0 ? -Math.PI / 2 : Math.PI / 2  // tourne la devanture vers le couloir
        return (
          <group key={i} position={[faceX, 0, s.z]} rotation={[0, ry, 0]}>
            {/* panneau de façade (vitrine) */}
            <mesh position={[0, WALL_H / 2, 0]}>
              <boxGeometry args={[STORE_W, WALL_H, 0.1]} />
              <meshStandardMaterial color="#1b2430" metalness={0} roughness={0.9} />
            </mesh>
            {/* porte vitrée */}
            <mesh position={[0, 1.1, 0.08]}>
              <boxGeometry args={[DOOR_W, 2.2, 0.06]} />
              <meshStandardMaterial color="#9fd8e6" transparent opacity={0.35} metalness={0.1} roughness={0.1} />
            </mesh>
            {/* cadre de porte */}
            <mesh position={[0, 2.25, 0.09]}>
              <boxGeometry args={[DOOR_W + 0.2, 0.12, 0.08]} />
              <meshStandardMaterial color="#0f172a" />
            </mesh>
            {/* enseigne lumineuse au-dessus de la porte (inclinée vers la caméra) */}
            <group position={[0, 2.8, 0.12]} rotation={[-0.4, 0, 0]}>
              <ShopSign type={s.type} width={SIGN_W} />
            </group>
          </group>
        )
      })}
    </group>
  )
}

function LootIndicators({ storefronts, indicatorsRef }) {
  return (
    <group>
      {storefronts.map((s, i) => (
        <mesh key={i} ref={(el) => (indicatorsRef.current[i] = el)} position={[s.x - s.side * 1.1, 1.5, s.z]}>
          <octahedronGeometry args={[0.28, 0]} />
          <meshStandardMaterial color="#fbbf24" emissive="#f59e0b" emissiveIntensity={1.4} />
        </mesh>
      ))}
    </group>
  )
}

function makeDoorLabel(text, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128
  const g = c.getContext('2d')
  g.clearRect(0, 0, 512, 128)
  g.fillStyle = color; g.font = 'bold 84px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, 256, 68)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4
  return t
}
/* Porte au fond du couloir : verrouillée (rouge) -> ouverte (verte). Collider présent seulement fermée. */
function ZoneDoor({ open, isExit }) {
  const gate = useRef()
  const label = useMemo(() => makeDoorLabel(isExit ? 'SORTIE' : 'ACCÈS', isExit ? '#22c55e' : '#38bdf8'), [isExit])
  const shown = isExit ? false : open   // la sortie ne se lève pas : on la fait exploser
  const barCol = isExit ? '#dc2626' : (open ? '#22c55e' : '#dc2626')
  const nBars = 7
  useFrame((state, dt) => {
    if (gate.current) {
      const targetY = shown ? WALL_H + 0.4 : 1.25   // la grille se relève à l'ouverture
      gate.current.position.y += (targetY - gate.current.position.y) * Math.min(1, dt * 4)
    }
  })
  return (
    <group position={[0, 0, -CORRIDOR_HL + 0.4]}>
      {/* montants + linteau + colliders latéraux */}
      <RigidBody type="fixed" colliders={false}>
        {[-1, 1].map((s) => (
          <mesh key={s} position={[s * (DOOR_TRIGGER_HW + 0.15), WALL_H / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.3, WALL_H, 0.5]} />
            <meshStandardMaterial color="#1b2430" metalness={0.2} roughness={0.8} />
          </mesh>
        ))}
        <mesh position={[0, WALL_H - 0.15, 0]}>
          <boxGeometry args={[DOOR_TRIGGER_HW * 2 + 0.6, 0.3, 0.5]} />
          <meshStandardMaterial color="#1b2430" />
        </mesh>
        <CuboidCollider args={[0.15, WALL_H / 2, 0.25]} position={[DOOR_TRIGGER_HW + 0.15, WALL_H / 2, 0]} />
        <CuboidCollider args={[0.15, WALL_H / 2, 0.25]} position={[-(DOOR_TRIGGER_HW + 0.15), WALL_H / 2, 0]} />
      </RigidBody>

      {/* collider bloquant : fermé (accès) ou toujours (sortie, jusqu'à l'explosion) */}
      <RigidBody type="fixed" colliders={false}>
        {(isExit || !open) && <CuboidCollider args={[DOOR_TRIGGER_HW, 1.25, 0.12]} position={[0, 1.25, 0]} />}
      </RigidBody>

      {isExit ? (
        /* Porte de sortie renforcée (à faire sauter à la dynamite) */
        <group position={[0, 1.25, 0.05]}>
          <mesh castShadow><boxGeometry args={[DOOR_TRIGGER_HW * 2, 2.5, 0.24]} /><meshStandardMaterial color="#3a3f4b" metalness={0.6} roughness={0.4} /></mesh>
          {[-0.7, 0.7].map((yy, k) => (
            <mesh key={k} position={[0, yy, 0.14]}><boxGeometry args={[DOOR_TRIGGER_HW * 2, 0.3, 0.02]} /><meshStandardMaterial color="#eab308" emissive="#eab308" emissiveIntensity={0.4} /></mesh>
          ))}
        </group>
      ) : (
        /* Grille coulissante (se relève à l'ouverture) */
        <group ref={gate} position={[0, open ? WALL_H + 0.4 : 1.25, 0.05]}>
          {[1.15, -1.15].map((yy, k) => (
            <mesh key={k} position={[0, yy, 0]}><boxGeometry args={[DOOR_TRIGGER_HW * 2, 0.12, 0.12]} /><meshStandardMaterial color="#64748b" metalness={0.7} roughness={0.4} /></mesh>
          ))}
          {Array.from({ length: nBars }).map((_, k) => {
            const x = -DOOR_TRIGGER_HW + (k + 0.5) * (DOOR_TRIGGER_HW * 2 / nBars)
            return (
              <mesh key={k} position={[x, 0, 0]} castShadow>
                <boxGeometry args={[0.08, 2.4, 0.08]} />
                <meshStandardMaterial color="#94a3b8" metalness={0.7} roughness={0.4} />
              </mesh>
            )
          })}
        </group>
      )}

      {/* barre d'état + libellé */}
      <mesh position={[0, WALL_H + 0.02, 0.28]}>
        <boxGeometry args={[DOOR_TRIGGER_HW * 2, 0.16, 0.05]} />
        <meshStandardMaterial color={barCol} emissive={barCol} emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
      <mesh position={[0, WALL_H + 0.45, 0.28]}>
        <planeGeometry args={[2.4, 0.6]} />
        <meshBasicMaterial map={label} transparent toneMapped={false} />
      </mesh>
    </group>
  )
}

/* Effet d'explosion de la porte de sortie */
function Explosion({ stateRef }) {
  const fire = useRef(), ring = useRef(), flash = useRef(), light = useRef()
  useFrame((s) => {
    const st = stateRef.current
    const active = !!(st && st.active)
    const k = active ? Math.min(1, (s.clock.elapsedTime - st.t) / DETONATE_TIME) : 1
    if (fire.current) {
      fire.current.visible = active
      fire.current.scale.setScalar(0.6 + k * 6)
      fire.current.children.forEach((m) => { if (m.material) m.material.opacity = Math.max(0, 1 - k) })
    }
    if (ring.current) {
      const rk = Math.min(1, k * 1.5)
      ring.current.visible = active
      ring.current.scale.set(1 + rk * 9, 1 + rk * 9, 1)
      if (ring.current.material) ring.current.material.opacity = Math.max(0, 1 - rk)
    }
    if (flash.current) {
      const fk = Math.min(1, k / 0.18)
      flash.current.visible = active && fk < 1
      flash.current.scale.setScalar(1 + fk * 8)
      if (flash.current.material) flash.current.material.opacity = Math.max(0, 1 - fk)
    }
    if (light.current) light.current.intensity = active ? Math.max(0, (1 - k) * 22) : 0
  })
  const addBlend = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }
  return (
    <group position={[0, 1.4, -CORRIDOR_HL + 0.7]}>
      <group ref={fire} visible={false}>
        <mesh><sphereGeometry args={[0.5, 20, 20]} /><meshBasicMaterial color="#ffd27f" opacity={1} {...addBlend} /></mesh>
        <mesh><sphereGeometry args={[0.36, 20, 20]} /><meshBasicMaterial color="#ff6a1f" opacity={1} {...addBlend} /></mesh>
        <mesh><sphereGeometry args={[0.22, 16, 16]} /><meshBasicMaterial color="#ffffff" opacity={1} {...addBlend} /></mesh>
      </group>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.0, 0]} visible={false}>
        <torusGeometry args={[0.6, 0.14, 8, 40]} />
        <meshBasicMaterial color="#ffb04a" opacity={1} {...addBlend} />
      </mesh>
      <mesh ref={flash} visible={false}>
        <sphereGeometry args={[0.6, 16, 16]} />
        <meshBasicMaterial color="#ffffff" opacity={1} {...addBlend} />
      </mesh>
      <pointLight ref={light} color="#ff8833" intensity={0} distance={26} />
    </group>
  )
}


/* Couleurs des traçantes (réutilisées chaque frame, sans réallocation) */
const TRACER_COLORS = {
  uzi:    { core: new THREE.Color('#fff0c0'), glow: new THREE.Color('#ff3b1f') }, // orange -> rouge
  pistol: { core: new THREE.Color('#fff8d0'), glow: new THREE.Color('#fde047') }, // jaune
}

const Bullets = forwardRef(function Bullets({ registry, killZombies, shelfRectsRef, playing }, ref) {
  const meshes = useRef([])
  const active = useRef([])

  useImperativeHandle(ref, () => ({
    fire(x, z, dx, dz, kind = 'pistol') {
      if (active.current.length >= BULLET_POOL) return
      active.current.push({ x, z, dx, dz, ang: Math.atan2(dx, dz), kind, life: BULLET_LIFE })
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
              } else if (e.boss) {
                e.spark = now                       // éclat sur le gilet
                e.recoilUntil = now + BOSS_RECOIL_TIME
                e.recoilVX = b.dx * BOSS_RECOIL_SPEED
                e.recoilVZ = b.dz * BOSS_RECOIL_SPEED
                if (e.phase === 1) {
                  e.hp -= BULLET_DAMAGE
                  e.hitFlash = now
                  if (e.hp <= 0) { e.phase = 2; e.hp = BOSS_HP_2 }   // phase 2 : au sabre
                } else {
                  Sfx.ricochet()                     // phase 2 : les balles ricochent (aucun dégât)
                }
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
      const grp = m[i]
      if (!grp) continue
      if (i < arr.length) {
        const b = arr[i]
        grp.visible = true
        grp.position.set(b.x, 0.9, b.z)
        grp.rotation.y = b.ang
        const col = TRACER_COLORS[b.kind] || TRACER_COLORS.pistol
        const core = grp.children[0]?.material
        const glow = grp.children[1]?.material
        if (core) { core.color.copy(col.core); core.emissive.copy(col.glow) }
        if (glow) glow.color.copy(col.glow)
      } else {
        grp.visible = false
      }
    }
  })

  return (
    <group>
      {Array.from({ length: BULLET_POOL }).map((_, i) => (
        <group key={i} ref={(el) => (meshes.current[i] = el)} visible={false}>
          {/* cœur lumineux, allongé dans le sens du tir (+Z) */}
          <mesh>
            <boxGeometry args={[0.05, 0.05, 0.55]} />
            <meshStandardMaterial color="#fff0c0" emissive="#ff3b1f" emissiveIntensity={3} toneMapped={false} />
          </mesh>
          {/* halo additif diffus */}
          <mesh>
            <boxGeometry args={[0.15, 0.15, 1.0]} />
            <meshBasicMaterial color="#ff3b1f" transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
})

/* ---------------------------------------------------------------- */
/* Joueur                                                            */
/* ---------------------------------------------------------------- */
/* Modèle 3D animé du joueur (GLB Meshy) + armes attachées à la main */
function PlayerModel({ locomotionRef, attackRef, weaponRef }) {
  const { scene, animations } = useGLTF(PLAYER_URL, true)
  const sabreGltf = useGLTF(SABRE_URL, true)
  const pistolGltf = useGLTF(PISTOL_URL, true)
  const uziGltf = useGLTF(UZI_URL, true)

  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene)
    c.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; o.material = o.material.clone(); o.material.metalness = 0; o.material.roughness = 1 } })
    return c
  }, [scene])
  const handBone = useMemo(() => {
    let b = null
    cloned.traverse((o) => { if (o.name === 'RightHand') b = o })
    return b
  }, [cloned])

  const group = useRef()
  const { actions } = useAnimations(animations, group)
  const baseName = useRef(null)
  const attackName = useRef(null)
  const attackEnd = useRef(0)
  const lastTrigger = useRef(0)
  const muzzleUntil = useRef(0)
  const rig = useRef(null)

  const playBase = (name) => {
    if (baseName.current === name) return
    const nextClip = name === 'run' ? 'run' : 'walk'
    const prevClip = baseName.current === 'run' ? 'run' : 'walk'
    const next = actions[nextClip]
    const prev = actions[prevClip]
    if (next) {
      next.reset()
      if (name === 'idle') { next.fadeIn(0.15).play(); next.paused = true; next.time = 0 }
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

  // attache les armes à l'os de la main
  useEffect(() => {
    const sScene = sabreGltf.scene
    const pScene = pistolGltf.scene
    const uScene = uziGltf.scene
    if (!handBone || !sScene || !pScene || !uScene) return
    const holder = new THREE.Group()
    holder.scale.setScalar(WEAPON_HOLDER_SCALE)

    const sabre = sScene.clone(true)
    sabre.scale.setScalar(SABRE_SCALE)
    sabre.position.set(...SABRE_POS)
    sabre.rotation.set(...SABRE_ROT)
    sabre.traverse((o) => { if (o.isMesh) o.castShadow = true })

    const pistol = pScene.clone(true)
    pistol.scale.setScalar(PISTOL_SCALE)
    pistol.position.set(...PISTOL_POS)
    pistol.rotation.set(...PISTOL_ROT)
    pistol.traverse((o) => { if (o.isMesh) o.castShadow = true })

    const uzi = uScene.clone(true)
    uzi.scale.setScalar(UZI_SCALE)
    uzi.position.set(...UZI_POS)
    uzi.rotation.set(...UZI_ROT)
    uzi.traverse((o) => { if (o.isMesh) o.castShadow = true })

    const mkMuzzle = (pos) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 8, 8),
        new THREE.MeshStandardMaterial({ color: '#fff7ae', emissive: new THREE.Color('#fde047'), emissiveIntensity: 3, transparent: true, opacity: 0.9 }),
      )
      m.position.set(...pos); m.visible = false
      return m
    }
    const muzzle = mkMuzzle(MUZZLE_POS)
    const uziMuzzle = mkMuzzle(UZI_MUZZLE_POS)

    holder.add(sabre); holder.add(pistol); holder.add(uzi); holder.add(muzzle); holder.add(uziMuzzle)
    handBone.add(holder)
    rig.current = { sabre, pistol, uzi, muzzle, uziMuzzle }
    return () => { handBone.remove(holder); rig.current = null }
  }, [handBone, sabreGltf.scene, pistolGltf.scene, uziGltf.scene])

  useFrame((state) => {
    const now = state.clock.elapsedTime

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
      if (name === 'shoot') muzzleUntil.current = now + 0.06
    }

    if (attackName.current && now >= attackEnd.current) {
      const a = actions[attackName.current]
      if (a) a.fadeOut(0.12)
      attackName.current = null
      baseName.current = null
      playBase(locomotionRef.current)
    }
    if (!attackName.current) playBase(locomotionRef.current)

    // armes : visibilité selon l'arme + flash
    const r = rig.current
    if (r) {
      const w = weaponRef.current
      r.sabre.visible = w === 'sabre'
      r.pistol.visible = w === 'pistol'
      r.uzi.visible = w === 'uzi'
      const flash = now < muzzleUntil.current
      r.muzzle.visible = w === 'pistol' && flash
      r.uziMuzzle.visible = w === 'uzi' && flash
    }
  })

  return (
    <group ref={group} position={[0, PLAYER_FEET_Y, 0]} rotation={[0, PLAYER_MODEL_FACING, 0]} scale={PLAYER_MODEL_SCALE}>
      <primitive object={cloned} />
    </group>
  )
}

function Player({ posRef, bodyRef, registry, killZombies, bulletsRef, shelfRectsRef, ammoRef, uziAmmoRef, hasPistolRef, hasUziRef, hungerRef, onWeapon, onAmmo, onUziAmmo, playing, aimRef }) {
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
  const gpSwitchPrev = useRef(false)

  const triggerAttack = (name) => { attackRef.current = { id: attackRef.current.id + 1, name } }

  const setWeapon = useCallback((w) => {
    if (w === 'pistol' && !hasPistolRef.current) return
    if (w === 'uzi' && !hasUziRef.current) return
    if (weaponRef.current !== w) { weaponRef.current = w; onWeapon(w) }
  }, [onWeapon, hasPistolRef, hasUziRef])
  const cycleWeapon = useCallback(() => {
    const list = ['sabre']
    if (hasPistolRef.current) list.push('pistol')
    if (hasUziRef.current) list.push('uzi')
    const i = list.indexOf(weaponRef.current)
    setWeapon(list[(i + 1) % list.length])
  }, [setWeapon, hasPistolRef, hasUziRef])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Digit1' || e.code === 'Numpad1') setWeapon('sabre')
      else if (e.code === 'Digit2' || e.code === 'Numpad2') setWeapon('pistol')
      else if (e.code === 'Digit3' || e.code === 'Numpad3') setWeapon('uzi')
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
      cycleWeapon()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('wheel', onWheel)
    onWeapon(weaponRef.current)
    onAmmo(ammoRef.current)
    onUziAmmo(uziAmmoRef.current)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('wheel', onWheel)
    }
  }, [setWeapon, cycleWeapon, onWeapon, onAmmo, onUziAmmo])

  useFrame((state) => {
    if (!body.current) return
    const t = body.current.translation()
    posRef.current.set(t.x, t.y, t.z)

    if (!playing) {
      const vy = body.current.linvel().y
      body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
      return
    }

    // manette : premier pad connecté
    const pads = navigator.getGamepads ? navigator.getGamepads() : []
    let gp = null
    for (let i = 0; i < pads.length; i++) { if (pads[i]) { gp = pads[i]; break } }
    const DZ = 0.22

    // déplacement — clavier (numérique) ou stick gauche (analogique)
    const k = keys.current
    let mx = 0, mz = 0
    if (k['KeyW'] || k['KeyZ'] || k['ArrowUp']) mz -= 1
    if (k['KeyS'] || k['ArrowDown']) mz += 1
    if (k['KeyA'] || k['KeyQ'] || k['ArrowLeft']) mx -= 1
    if (k['KeyD'] || k['ArrowRight']) mx += 1
    if (gp) {
      const lx = gp.axes[0] || 0, lz = gp.axes[1] || 0
      if (Math.hypot(lx, lz) > DZ) { mx = lx; mz = lz }
    }
    let mag = Math.hypot(mx, mz)
    if (mag > 1) { mx /= mag; mz /= mag; mag = 1 }

    // orientation — face au déplacement si on bouge, sinon visée (souris / stick droit) à l'arrêt
    if (mag > 0.1) {
      yaw.current = Math.atan2(mx, mz)
    } else {
      raycaster.setFromCamera(state.pointer, camera)
      if (raycaster.ray.intersectPlane(groundPlane, aim.current)) {
        const dx = aim.current.x - t.x
        const dz = aim.current.z - t.z
        if (dx * dx + dz * dz > 0.04) yaw.current = Math.atan2(dx, dz)
      }
      if (gp) {
        const rx = gp.axes[2] || 0, rz = gp.axes[3] || 0
        if (Math.hypot(rx, rz) > DZ) yaw.current = Math.atan2(rx, rz)
      }
    }
    if (visual.current) visual.current.rotation.y = yaw.current
    if (aimRef) aimRef.current = yaw.current

    // vitesse
    const vy = body.current.linvel().y
    let speed = PLAYER_SPEED
    if (hungerRef.current < LOW_HUNGER) speed *= SLOW_FACTOR
    if (mag > 0.001) {
      body.current.setLinvel({ x: mx * speed, y: vy, z: mz * speed }, true)
    } else {
      body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
    }
    locomotionRef.current = mag > 0.1 ? 'run' : 'idle'

    // changement d'arme à la manette (RB ou Y), sur front montant
    if (gp) {
      const sw = !!(gp.buttons[5]?.pressed || gp.buttons[3]?.pressed)
      if (sw && !gpSwitchPrev.current) cycleWeapon()
      gpSwitchPrev.current = sw
    }

    const now = state.clock.elapsedTime
    const weapon = weaponRef.current
    const gpFire = !!(gp && ((gp.buttons[7]?.value || 0) > 0.3 || gp.buttons[0]?.pressed))
    const firing = mouseHeld.current || spaceHeld.current || gpFire
    const cd = weapon === 'sabre' ? SABRE_COOLDOWN : weapon === 'uzi' ? UZI_COOLDOWN : PISTOL_COOLDOWN

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
              if (z.boss) {
                if (z.phase === 2) { z.hp -= SABRE_DAMAGE; z.hitFlash = now; if (z.hp <= 0) kills.push(id) }
                // phase 1 : le sabre ne fait rien au boss
              } else {
                z.hp -= z.fat ? FAT_SABRE_DAMAGE : SABRE_DAMAGE
                z.hitFlash = now
                if (z.hp <= 0) kills.push(id)
              }
            }
          }
        })
        if (kills.length) killZombies(kills)
      } else if (weapon === 'uzi') {
        if (uziAmmoRef.current > 0) {
          lastUse.current = now
          const ang = Math.atan2(fx, fz) + (Math.random() * 2 - 1) * UZI_BULLET_SPREAD   // dispersion rafale
          const sfx = Math.sin(ang), sfz = Math.cos(ang)
          bulletsRef.current?.fire(t.x + sfx * 0.7, t.z + sfz * 0.7, sfx, sfz, 'uzi')
          Sfx.uziShot()
          triggerAttack('shoot')
          uziAmmoRef.current -= 1
          onUziAmmo(uziAmmoRef.current)
        }
      } else if (ammoRef.current > 0) {
        lastUse.current = now
        bulletsRef.current?.fire(t.x + fx * 0.7, t.z + fz * 0.7, fx, fz, 'pistol')
        Sfx.shoot()
        triggerAttack('shoot')
        ammoRef.current -= 1
        onAmmo(ammoRef.current)
      }
    }
  })

  return (
    <RigidBody
      ref={(el) => { body.current = el; if (bodyRef) bodyRef.current = el }}
      type="dynamic"
      position={[0, 0.9, PLAYER_START_Z]}
      colliders={false}
      enabledRotations={[false, false, false]}
      mass={3}
      linearDamping={0.5}
    >
      <CapsuleCollider args={[0.45, 0.4]} />
      <group ref={visual}>
        <PlayerModel locomotionRef={locomotionRef} attackRef={attackRef} weaponRef={weaponRef} />
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
        o.material.metalness = 0        // Meshy exporte metallic=1 -> rendu noir sans HDR
        o.material.roughness = 1
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

/* Modèle 3D animé de "Bob" (ex-policier blindé) */
function BobModel({ gait, speedMul, stateRef, entryRef }) {
  const { scene, animations } = useGLTF(BOB_URL, true)
  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene)
    c.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.frustumCulled = false
        o.material = o.material.clone()
        o.material.metalness = 0
        o.material.roughness = 1
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
    const f = state.clock.elapsedTime - entryRef.current.hitFlash < 0.12   // touché sabre -> rouge
    const s = state.clock.elapsedTime - entryRef.current.armorSpark < 0.12 // ricochet balle -> blanc
    for (const m of mats) {
      if (s) m.emissive.setRGB(0.8, 0.8, 0.8)
      else m.emissive.setRGB(f ? 0.5 : 0, 0, 0)
    }
  })

  return (
    <group ref={group} position={[0, BOB_FEET_Y, 0]} rotation={[0, BOB_MODEL_FACING, 0]} scale={BOB_MODEL_SCALE}>
      <primitive object={cloned} />
    </group>
  )
}

/* Modèle 3D animé du zombie femme */
function FemaleModel({ gait, speedMul, stateRef, entryRef }) {
  const { scene, animations } = useGLTF(FEMALE_URL, true)
  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene)
    c.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.frustumCulled = false
        o.material = o.material.clone()
        o.material.metalness = 0
        o.material.roughness = 1
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
    <group ref={group} position={[0, FEMALE_FEET_Y, 0]} rotation={[0, FEMALE_MODEL_FACING, 0]} scale={FEMALE_MODEL_SCALE}>
      <primitive object={cloned} />
    </group>
  )
}

/* Modèle 3D animé du gros zombie (lent, imposant) */
function FatZombieModel({ gait, speedMul, stateRef, entryRef }) {
  const { scene, animations } = useGLTF(FAT_URL, true)
  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene)
    c.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.frustumCulled = false
        o.material = o.material.clone()
        o.material.metalness = 0
        o.material.roughness = 1
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
    // pas de clip "grab" pour le gros zombie -> il continue de marcher en attaquant
    const desired = stateRef.current === 'death' ? 'death' : gait
    if (desired !== current.current && actions[desired]) {
      const next = actions[desired]
      const prev = actions[current.current]
      next.reset()
      if (desired === 'death') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; next.timeScale = FAT_DEATH_SPEED; next.fadeIn(0.12).play() }
      else { next.timeScale = speedMul; next.fadeIn(0.15).play() }
      if (prev && prev !== next) prev.fadeOut(0.15)
      current.current = desired
    }
    const f = state.clock.elapsedTime - entryRef.current.hitFlash < 0.12
    for (const m of mats) m.emissive.setRGB(f ? 0.5 : 0, 0, 0)
  })

  return (
    <group ref={group} position={[0, FAT_FEET_Y, 0]} rotation={[0, FAT_MODEL_FACING, 0]} scale={FAT_MODEL_SCALE}>
      <primitive object={cloned} />
    </group>
  )
}

/* Modèle 3D animé du BOSS (clips : run/block/attack/dodge/skill) + éclat sur coup */
function BossModel({ stateRef, entryRef }) {
  const { scene, animations } = useGLTF(BOSS_URL, true)
  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene)
    c.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; o.material = o.material.clone(); o.material.metalness = 0; o.material.roughness = 1 }
    })
    return c
  }, [scene])
  const mats = useMemo(() => { const a = []; cloned.traverse((o) => { if (o.isMesh) a.push(o.material) }); return a }, [cloned])
  const group = useRef()
  const spark = useRef()
  const { actions } = useAnimations(animations, group)
  const current = useRef(null)

  useEffect(() => {
    const a = actions['run']; if (a) { a.reset(); a.play() }
    current.current = 'run'
    return () => { Object.values(actions).forEach((x) => x && x.stop()) }
  }, [actions])

  useFrame((state) => {
    const s = stateRef.current
    const clip = s === 'attack' ? 'attack' : s === 'dodge' ? 'dodge' : s === 'skill' ? 'skill' : (s === 'block' || s === 'death') ? 'block' : 'run'
    if (clip !== current.current && actions[clip]) {
      const next = actions[clip], prev = actions[current.current]
      next.reset()
      const once = clip === 'attack' || clip === 'dodge' || clip === 'skill'
      if (once) { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true }
      else { next.setLoop(THREE.LoopRepeat, Infinity) }
      next.fadeIn(0.12).play()
      if (prev && prev !== next) prev.fadeOut(0.12)
      current.current = clip
    }
    const now = state.clock.elapsedTime
    const hit = now - entryRef.current.hitFlash < 0.12
    for (const m of mats) m.emissive.setRGB(hit ? 0.5 : 0, 0, 0)
    if (spark.current) {
      const sk = now - (entryRef.current.spark || -10)
      const on = sk < 0.14
      spark.current.visible = on
      if (on) spark.current.scale.setScalar(0.15 + sk * 3)
    }
  })

  return (
    <group ref={group} position={[0, BOSS_FEET_Y, 0]} scale={BOSS_MODEL_SCALE}>
      <primitive object={cloned} />
      <mesh ref={spark} position={[0, 1.0, 0.28]} visible={false}>
        <sphereGeometry args={[0.12, 8, 8]} />
        <meshBasicMaterial color="#fff2b0" transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}


function Zombie({ id, spawn, armored, fat, female, boss, gait, speedMul, dying, posRef, registry, onDamage, onRemove, playing }) {
  const body = useRef()
  const visual = useRef()
  const stateRef = useRef('walk')
  const entry = useRef({
    pos: new THREE.Vector3(spawn[0], 1, spawn[1]),
    lastHit: -10, hp: boss ? BOSS_HP_1 : fat ? FAT_HP : ZOMBIE_HP, armored, fat, boss, phase: boss ? 1 : 0,
    hitFlash: -10, armorSpark: -10, spark: -10, dying: false,
    recoilUntil: 0, recoilVX: 0, recoilVZ: 0, dodgeUntil: 0, dodgeVX: 0, dodgeVZ: 0, nextDodge: 2, nextRoar: 4,
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
    const ms = boss ? 3400 : fat ? 2800 : 2300   // laisse le corps jouer sa mort avant suppression
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
    } else if (boss) {
      /* --- IA du boss : actif, esquive, hurle, recule sur coup --- */
      const e = entry.current
      const dx = posRef.current.x - t.x
      const dz = posRef.current.z - t.z
      const d = Math.hypot(dx, dz) || 1
      const nx = dx / d, nz = dz / d
      const vy = body.current.linvel().y
      if (visual.current) visual.current.rotation.y = Math.atan2(nx, nz)

      if (now < e.recoilUntil) {
        body.current.setLinvel({ x: e.recoilVX, y: vy, z: e.recoilVZ }, true)
        stateRef.current = 'block'
      } else if (now < e.dodgeUntil) {
        body.current.setLinvel({ x: e.dodgeVX, y: vy, z: e.dodgeVZ }, true)
        stateRef.current = 'dodge'
      } else if (now >= e.nextDodge && d > 2 && d < 14) {
        // roulade latérale d'esquive
        const side = Math.random() < 0.5 ? 1 : -1
        e.dodgeVX = -nz * side * BOSS_DODGE_SPEED
        e.dodgeVZ = nx * side * BOSS_DODGE_SPEED
        e.dodgeUntil = now + BOSS_DODGE_TIME
        e.nextDodge = now + BOSS_DODGE_CD + Math.random() * 1.5
        stateRef.current = 'dodge'
      } else if (now >= e.nextRoar) {
        e.nextRoar = now + BOSS_ROAR_CD + Math.random() * 2.5
        e.roarUntil = now + 1.0
        Sfx.roar()
        stateRef.current = 'skill'
        body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
      } else if (now < (e.roarUntil || 0)) {
        stateRef.current = 'skill'
        body.current.setLinvel({ x: 0, y: vy, z: 0 }, true)
      } else if (d < CONTACT_RANGE * 1.5) {
        stateRef.current = 'attack'
        const sp = ZOMBIE_SPEED * BOSS_SPEED_MUL * 0.4
        body.current.setLinvel({ x: nx * sp, y: vy, z: nz * sp }, true)
        if (now - e.lastHit > HIT_COOLDOWN) { e.lastHit = now; onDamage(ZOMBIE_DAMAGE * 2); Sfx.hurt() }
      } else {
        stateRef.current = 'run'
        const sp = ZOMBIE_SPEED * BOSS_SPEED_MUL
        body.current.setLinvel({ x: nx * sp, y: vy, z: nz * sp }, true)
      }
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
        onDamage(boss ? ZOMBIE_DAMAGE * 2 : ZOMBIE_DAMAGE)
        Sfx.hurt()
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
      mass={boss ? 4 : fat ? 2.2 : armored ? 1.6 : 1}
      linearDamping={0.5}
      ccd={fat || boss}
    >
      <CapsuleCollider args={boss ? [0.9, 0.6] : fat ? [0.38, 0.62] : [0.4, 0.4]} />
      <group ref={visual}>
        {boss ? (
          <BossModel stateRef={stateRef} entryRef={entry} />
        ) : fat ? (
          <FatZombieModel gait={gait} speedMul={speedMul} stateRef={stateRef} entryRef={entry} />
        ) : armored ? (
          <BobModel gait={gait} speedMul={speedMul} stateRef={stateRef} entryRef={entry} />
        ) : female ? (
          <FemaleModel gait={gait} speedMul={speedMul} stateRef={stateRef} entryRef={entry} />
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
const Game = memo(function Game({ playing, onDamage, onHeal, onKill, onWeapon, onAmmo, onUziAmmo, onPistol, onUzi, onSurvival, onPickup, onWin }) {
  const playerPos = useRef(new THREE.Vector3(0, 0.9, PLAYER_START_Z))   // départ à l'entrée
  const playerBody = useRef()
  const registry = useRef(new Map())
  const bulletsRef = useRef()
  const indicatorsRef = useRef([])
  const shelfBodies = useRef([])
  const shelfRects = useRef([])   // couloir ouvert : pas d'obstacle central (LOS/balles)
  const keys = useKeyboard()

  const [zombies, setZombies] = useState([])
  const idRef = useRef(1)
  const countRef = useRef(0)
  const spawnTimer = useRef(0)

  // Système de vagues — N zombies répartis sur une durée, puis vague suivante
  const waveRef = useRef(1)
  const waveTimer = useRef(0)
  const spawnedThisWave = useRef(0)
  const bannerUntil = useRef(BANNER_DURATION)

  const hungerRef = useRef(HUNGER_MAX)
  const ammoRef = useRef(START_AMMO)
  const uziAmmoRef = useRef(0)
  const hasPistolRef = useRef(START_HAS_PISTOL)
  const hasUziRef = useRef(false)

  // --- Zones (Palier 1) ---
  const [zoneIndex, setZoneIndex] = useState(0)
  const storefronts = useMemo(() => buildStorefronts(zoneIndex), [zoneIndex])
  const storefrontsRef = useRef(storefronts)
  // clé cachée au sol dans les galeries non finales (position aléatoire)
  const zoneKey = useMemo(() => {
    const zone = ZONES[zoneIndex]
    if (!zone || zone.type !== 'galerie' || zone.exit) return null
    const x = (Math.random() * 2 - 1) * (CORRIDOR_HW - 1.6)
    const z = -CORRIDOR_HL + 5 + Math.random() * (CORRIDOR_HL * 2 - 12)
    return { x, z }
  }, [zoneIndex])
  const shelfStates = useRef(storefronts.map(() => ({ available: true, uses: SHELF_USES })))
  const [doorOpen, setDoorOpen] = useState(false)
  const doorOpenRef = useRef(false)
  const zoneBannerRef = useRef('')
  const transitioningRef = useRef(false)
  const firstZone = useRef(true)

  // --- Objectif mission (Palier 2) : objets de quête récupérés ---
  const collectedRef = useRef({})
  const hasKeyRef = useRef(false)                       // le joueur a ramassé la clé de la galerie
  const fuseRef = useRef({ active: false, t: 0, lastBeep: 0 })  // mèche de la sortie (compte à rebours)
  const explosionRef = useRef({ active: false, t: 0 })  // explosion de la porte de sortie
  const wonRef = useRef(false)
  const bossIdRef = useRef(null)      // id du boss dans le registre
  const bossSeenRef = useRef(false)   // le boss a été enregistré au moins une fois

  const searchProgress = useRef(0)
  const promptRef = useRef(null)
  const starveTimer = useRef(0)
  const prevX = useRef(0)
  const prevZ = useRef(0)
  const lastPush = useRef(0)
  const groanTimer = useRef(0)
  const nextGroan = useRef(3)

  const aimYaw = useRef(0)
  const viewMode = useRef('tps')   // 'tps' (vue de dessus) ou 'shoulder' (par-dessus l'épaule, touche V)
  const pendingBanner = useRef(false)

  useEffect(() => { countRef.current = zombies.filter((z) => !z.dying).length }, [zombies])
  useEffect(() => { if (playing) Sfx.waveStart() }, [])

  // bascule de vue avec la touche V
  useEffect(() => {
    const onKey = (e) => { if (e.code === 'KeyV') viewMode.current = viewMode.current === 'shoulder' ? 'tps' : 'shoulder' }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // refs synchronisées avec la zone active
  useEffect(() => { storefrontsRef.current = storefronts }, [storefronts])
  useEffect(() => { doorOpenRef.current = doorOpen }, [doorOpen])

  // changement de zone : reset vagues + boutiques + porte, téléport à l'entrée, bannière
  useEffect(() => {
    shelfStates.current = storefronts.map(() => ({ available: true, uses: SHELF_USES }))
    setDoorOpen(false)              // porte fermée à l'arrivée (clé / objet / dynamite selon la zone)
    hasKeyRef.current = false
    fuseRef.current = { active: false, t: 0, lastBeep: 0 }
    explosionRef.current = { active: false, t: 0 }
    transitioningRef.current = false
    if (firstZone.current) { firstZone.current = false; return }
    setZombies([]); registry.current.clear(); countRef.current = 0
    waveRef.current = 1; waveTimer.current = 0; spawnedThisWave.current = 0; spawnTimer.current = 0
    searchProgress.current = 0
    bossIdRef.current = null
    bossSeenRef.current = false
    const arena = ZONES[zoneIndex].type === 'arene'
    const startZ = arena ? ARENA_CENTER_Z + 3 : PLAYER_START_Z
    playerBody.current?.setTranslation({ x: 0, y: 0.9, z: startZ }, true)
    playerBody.current?.setLinvel({ x: 0, y: 0, z: 0 }, true)
    if (arena) {
      // apparition du boss au centre de l'arène
      const bid = idRef.current++
      bossIdRef.current = bid
      setZombies([{ id: bid, spawn: [0, ARENA_CENTER_Z - 3], boss: true, gait: 'limp', speedMul: BOSS_SPEED_MUL }])
    }
    zoneBannerRef.current = ZONES[zoneIndex].name.toUpperCase()
    pendingBanner.current = true
    Sfx.waveStart()
  }, [zoneIndex, storefronts])

  const advanceZone = useCallback(() => {
    setZoneIndex((zi) => Math.min(ZONES.length - 1, zi + 1))
  }, [])

  // coup fatal : on marque "mourant" (le corps joue sa mort), score compté tout de suite
  const killZombies = useCallback((ids) => {
    onKill(ids.length)
    Sfx.death()
    ids.forEach((id) => { const e = registry.current.get(id); if (e) e.dying = true; registry.current.delete(id) })
    setZombies((zs) => zs.map((z) => (ids.includes(z.id) ? { ...z, dying: true } : z)))
  }, [onKill])

  const removeZombie = useCallback((id) => {
    setZombies((zs) => zs.filter((z) => z.id !== id))
  }, [])

  const grantLoot = useCallback((shop) => {
    if (shop === 'armurerie') {
      if (!hasPistolRef.current) {
        hasPistolRef.current = true
        ammoRef.current += PISTOL_AMMO_BONUS + AMMO_PICKUP
        onPistol(true)
        onAmmo(ammoRef.current)
        Sfx.pickup('pistol')
        onPickup('🔫 Armurerie : pistolet + munitions !')
      } else if (!hasUziRef.current) {
        hasUziRef.current = true
        uziAmmoRef.current += UZI_AMMO_BONUS
        onUzi(true)
        onUziAmmo(uziAmmoRef.current)
        Sfx.pickup('pistol')
        onPickup('💥 Armurerie : Uzi + ' + UZI_AMMO_BONUS + ' balles !')
      } else {
        ammoRef.current += AMMO_PICKUP + 6
        uziAmmoRef.current += 80
        onAmmo(ammoRef.current)
        onUziAmmo(uziAmmoRef.current)
        Sfx.pickup('ammo')
        onPickup('🔫 Armurerie : munitions (pistolet + Uzi)')
      }
    } else if (shop === 'pharmacie') {
      onHeal(45)
      Sfx.pickup('food')
      onPickup('💊 Pharmacie : +45 santé')
    } else if (shop === 'epicerie') {
      hungerRef.current = Math.min(HUNGER_MAX, hungerRef.current + FOOD_HUNGER)
      onHeal(FOOD_HEAL)
      Sfx.pickup('food')
      onPickup('🛒 Épicerie : +faim, +santé')
    } else { // boulangerie
      hungerRef.current = Math.min(HUNGER_MAX, hungerRef.current + 28)
      Sfx.pickup('food')
      onPickup('🥖 Boulangerie : +faim')
    }
  }, [onPistol, onUzi, onAmmo, onUziAmmo, onHeal, onPickup])

  useFrame((state, dt) => {
    const now = state.clock.elapsedTime
    if (pendingBanner.current) { bannerUntil.current = now + BANNER_DURATION; pendingBanner.current = false }

    if (playing) {
      /* --- Vagues : toute la salve arrive groupée, vague suivante au nettoyage --- */
      const wave = waveRef.current
      const count = waveCount(wave)
      const duration = waveDuration(wave)

      waveTimer.current += dt
      spawnTimer.current += dt

      // salve : on lâche les `count` zombies en rafale rapide (quasi ensemble), en ligne
      if (spawnedThisWave.current < count && (spawnedThisWave.current === 0 || spawnTimer.current >= WAVE_BURST_INTERVAL)) {
        spawnTimer.current = 0
        const lane = spawnedThisWave.current
        spawnedThisWave.current += 1
        const armoredChance = Math.min(0.22, 0.04 + wave * 0.015)
        const armored = Math.random() < armoredChance
        const fat = !armored && Math.random() < FAT_CHANCE
        const female = !armored && !fat && Math.random() < 0.5
        const gait = fat ? 'limp' : (Math.random() < 0.5 ? 'limp' : 'unsteady')
        const speedMul = fat
          ? FAT_SPEED_MUL
          : 0.85 + Math.random() * 0.3 + Math.min(0.4, wave * 0.02)
        const arena = ZONES[zoneIndex].type === 'arene'
        let sx, endZ
        if (arena) {
          // autour de l'arène : apparition aux deux extrémités du couloir (nord et sud)
          const fromNorth = Math.random() < 0.5
          endZ = fromNorth ? -(CORRIDOR_HL - 1.5) : (CORRIDOR_HL - 1.5)
          sx = (Math.random() * 2 - 1) * (CORRIDOR_HW - 1.4)
        } else {
          endZ = -(CORRIDOR_HL - 1.5)   // fond du couloir
          // répartis sur la largeur (effet "ligne de zombies") + léger aléa
          const frac = count > 1 ? lane / (count - 1) : 0.5
          sx = (frac * 2 - 1) * (CORRIDOR_HW - 1.4) + (Math.random() * 0.7 - 0.35)
        }
        setZombies((zs) => [...zs, { id: idRef.current++, spawn: [sx, endZ], armored, fat, female, gait, speedMul }])
      }

      // vague suivante au bout du temps défini (durée), indépendamment des zombies restants
      if (waveTimer.current >= duration) {
        waveTimer.current -= duration
        waveRef.current += 1
        spawnedThisWave.current = 0
        spawnTimer.current = 0
        zoneBannerRef.current = ''   // les vagues suivantes affichent "VAGUE N"
        bannerUntil.current = now + BANNER_DURATION
        Sfx.waveStart()
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

      /* Entrée "fouiller / interagir" (clavier + manette) */
      const padSearch = (() => {
        const ps = navigator.getGamepads ? navigator.getGamepads() : []
        for (let i = 0; i < ps.length; i++) { if (ps[i]) return !!ps[i].buttons[2]?.pressed }
        return false
      })()
      const eDown = keys.current['KeyE'] || padSearch

      const zoneDef = ZONES[zoneIndex]
      const objDone = objectiveDone(collectedRef.current)

      /* Mèche allumée : compte à rebours, bips, puis explosion + dégâts de proximité */
      if (fuseRef.current.active) {
        const el = now - fuseRef.current.t
        const secLeft = Math.ceil(FUSE_TIME - el)
        if (secLeft !== fuseRef.current.lastBeep && secLeft > 0) { fuseRef.current.lastBeep = secLeft; Sfx.pickup('ammo') }
        if (el >= FUSE_TIME) {
          fuseRef.current.active = false
          explosionRef.current = { active: true, t: now }
          Sfx.explosion()
          const dExpl = Math.hypot(px, pz - (-CORRIDOR_HL + 0.4))   // distance à la porte
          if (dExpl < BLAST_RADIUS) {
            const dmg = Math.round(BLAST_DAMAGE * (1 - dExpl / BLAST_RADIUS))
            if (dmg > 0) { onDamage(dmg); onPickup("🔥 Le souffle de l'explosion vous touche !") }
          }
        }
      }

      /* Explosion terminée -> on passe à l'arène finale */
      if (explosionRef.current.active && !transitioningRef.current && now - explosionRef.current.t >= DETONATE_TIME) {
        transitioningRef.current = true
        advanceZone()
      }

      /* Arène : victoire quand le boss est abattu */
      if (ZONES[zoneIndex].type === 'arene' && bossIdRef.current != null) {
        if (registry.current.get(bossIdRef.current)) bossSeenRef.current = true
        else if (bossSeenRef.current && !wonRef.current) { wonRef.current = true; onWin() }
      }

      /* Zone d'interaction avec la porte du fond */
      const nearDoor = pz < -CORRIDOR_HL + 3.0 && Math.abs(px) < DOOR_TRIGGER_HW + 0.8
      const canUseKey = nearDoor && !zoneDef.exit && zoneDef.type === 'galerie' && !doorOpenRef.current && hasKeyRef.current
      const canDetonate = nearDoor && zoneDef.exit && objDone && !explosionRef.current.active && !fuseRef.current.active

      /* Franchissement d'un accès ouvert (zones non finales) */
      const atDoor = pz < -CORRIDOR_HL + 1.6 && Math.abs(px) < DOOR_TRIGGER_HW
      if (atDoor && !transitioningRef.current && doorOpenRef.current && !zoneDef.exit) {
        transitioningRef.current = true
        advanceZone()
      }

      /* Ramassage de la clé au sol (galerie) -> clé en poche */
      if (zoneKey && !hasKeyRef.current && Math.hypot(px - zoneKey.x, pz - zoneKey.z) < KEY_PICKUP_RANGE) {
        hasKeyRef.current = true
        Sfx.pickup('pistol')
        onPickup('🔑 Clé récupérée — utilisez-la sur la grille au fond (E)')
      }

      /* Utiliser la clé sur la grille (galerie) */
      if (canUseKey && eDown) {
        setDoorOpen(true)
        Sfx.pickup('ammo')
        onPickup('🔓 Grille ouverte !')
      }
      /* Amorcer la dynamite sur la porte de sortie (mèche de 3 s) */
      if (canDetonate && eDown) {
        fuseRef.current = { active: true, t: now, lastBeep: 0 }
        Sfx.pickup('ammo')
        onPickup('🧨 Dynamite amorcée — éloignez-vous, ça va sauter !')
      }

      /* Fouille du point le plus proche (désactivée si on interagit avec la porte) */
      const fronts = storefrontsRef.current
      let target = -1, best = Infinity
      if (!canUseKey && !canDetonate) {
        for (let i = 0; i < fronts.length; i++) {
          if (!shelfStates.current[i] || !shelfStates.current[i].available) continue
          const s = fronts[i]
          const doorX = s.x - s.side * 0.6
          const hw = s.side === 0 ? (s.w || MARKET_BLOCK_W) / 2 : 0.9
          const hd = s.side === 0 ? (s.d || MARKET_BLOCK_D) / 2 : 0.4
          const d = distToRect(px, pz, doorX, s.z, hw, hd)
          if (d < SEARCH_RANGE && d < best) { best = d; target = i }
        }
      }

      /* Prompt contextuel */
      promptRef.current = canDetonate ? 'detonate' : canUseKey ? 'key' : (target !== -1 ? 'search' : null)

      if (target !== -1 && eDown && moveSpeed < 1.0) {
        searchProgress.current += dt / SEARCH_TIME
        if (searchProgress.current >= 1) {
          const s = fronts[target]
          if (zoneDef.type === 'supermarche') {          // gondole : seulement un peu de nourriture
            hungerRef.current = Math.min(HUNGER_MAX, hungerRef.current + MARKET_FOOD)
            Sfx.pickup('food')
            onPickup('🍎 Un peu de nourriture')
          } else {
            grantLoot(s.type)
          }
          if (s.quest) {                                  // objet de mission -> collecté + ouvre la porte
            collectedRef.current[s.quest.id] = true
            setDoorOpen(true)
            Sfx.pickup('pistol')
            onPickup(s.quest.emoji + ' ' + s.quest.label + ' récupérée — la porte du fond s\'ouvre !')
          }
          const st = shelfStates.current[target]
          st.uses -= 1
          if (st.uses <= 0) st.available = false          // épuisée définitivement (pénurie)
          searchProgress.current = 0
        }
      } else {
        searchProgress.current = 0
      }

      if (now - lastPush.current > 0.05) {
        lastPush.current = now
        const w = waveRef.current
        const banner = now < bannerUntil.current ? (zoneBannerRef.current || ('VAGUE ' + w)) : null
        const countdown = Math.max(0, Math.ceil(waveDuration(w) - waveTimer.current))
        onSurvival({
          hunger: hungerRef.current,
          search: searchProgress.current,
          prompt: promptRef.current,
          wave: w, phase: 'active', banner, countdown, remaining: countRef.current,
          zone: zoneIndex, zoneName: ZONES[zoneIndex].name, zoneCount: ZONES.length,
          doorOpen: doorOpenRef.current, isExit: !!ZONES[zoneIndex].exit,
          quest: QUEST_ORDER.map((id) => ({ label: QUEST_ITEMS[id].label, emoji: QUEST_ITEMS[id].emoji, done: !!collectedRef.current[id] })),
          doorHint: zoneDef.exit
            ? (objDone ? 'faites sauter la porte à la dynamite (E)' : 'réunissez les objets de mission')
            : zoneDef.type === 'galerie'
              ? (hasKeyRef.current ? 'clé en poche — ouvrez la grille au fond (E)' : 'trouvez la CLÉ (cachée dans la galerie)')
              : `trouvez ${QUEST_ITEMS[zoneDef.quest] ? QUEST_ITEMS[zoneDef.quest].label : "l'objet"} (fouillez les gondoles)`,
          hasKey: hasKeyRef.current,
          fuse: fuseRef.current.active ? Math.max(0, Math.ceil(FUSE_TIME - (now - fuseRef.current.t))) : null,
          boss: (() => {
            const be = bossIdRef.current != null ? registry.current.get(bossIdRef.current) : null
            return be ? { hp: be.hp, max: be.phase === 1 ? BOSS_HP_1 : BOSS_HP_2, phase: be.phase } : null
          })(),
          objDone,
        })
      }
    }

    /* Indicateurs de butin (devant les portes disponibles) */
    for (let i = 0; i < indicatorsRef.current.length; i++) {
      const ind = indicatorsRef.current[i]
      const s = storefrontsRef.current[i]
      if (!ind || !s || !shelfStates.current[i]) continue
      const avail = shelfStates.current[i].available
      ind.visible = avail
      if (avail) {
        const iy = s.side === 0 ? 2.3 : 1.5
        ind.position.set(s.x - s.side * 1.1, iy + Math.sin(now * 3 + i) * 0.12, s.z)
        ind.rotation.y = now * 1.5
      }
    }
  })

  return (
    <>
      <FollowCamera target={playerPos} aimRef={aimYaw} modeRef={viewMode} shakeRef={explosionRef} />
      {ZONES[zoneIndex].type === 'arene' ? (
        <>
          <ArenaLights />
          <Arena />
          <ArenaBarriers half={ARENA_HALF} />
        </>
      ) : (
        <>
          <Lights />
          <Arena />
          {ZONES[zoneIndex].type === 'supermarche' ? (
            <Supermarket spots={storefronts} />
          ) : (
            <>
              <BenchRow />
              <Storefronts storefronts={storefronts} />
              {zoneKey && !doorOpen && <KeyPickup pos={zoneKey} pickedRef={hasKeyRef} />}
            </>
          )}
          <ZoneDoor open={doorOpen} isExit={!!ZONES[zoneIndex].exit} />
          {ZONES[zoneIndex].exit && <Explosion stateRef={explosionRef} />}
          <LootIndicators storefronts={storefronts} indicatorsRef={indicatorsRef} />
        </>
      )}
      <Bullets ref={bulletsRef} registry={registry} killZombies={killZombies} shelfRectsRef={shelfRects} playing={playing} />
      <Player
        posRef={playerPos}
        bodyRef={playerBody}
        registry={registry}
        killZombies={killZombies}
        bulletsRef={bulletsRef}
        shelfRectsRef={shelfRects}
        ammoRef={ammoRef}
        uziAmmoRef={uziAmmoRef}
        hasPistolRef={hasPistolRef}
        hasUziRef={hasUziRef}
        hungerRef={hungerRef}
        onWeapon={onWeapon}
        onAmmo={onAmmo}
        onUziAmmo={onUziAmmo}
        playing={playing}
        aimRef={aimYaw}
      />
      {zombies.map((z) => (
        <Zombie
          key={z.id}
          id={z.id}
          spawn={z.spawn}
          armored={z.armored}
          fat={z.fat}
          female={z.female}
          boss={z.boss}
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

function HUD({ health, hunger, score, weapon, ammo, hasPistol, uziAmmo, hasUzi, search, prompt, toast, wave, banner, countdown, remaining, zoneName, zone, zoneCount, doorOpen, isExit, quest, doorHint, hasKey, fuse, boss, objDone, playing, muted, onToggleMute }) {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', color: '#fff', fontFamily: 'system-ui' }}>
      <style>{`@keyframes waveIn{from{opacity:0;transform:translate(-50%,-50%) scale(0.85)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}`}</style>

      <div style={{ position: 'absolute', top: 20, left: 20 }}>
        <Gauge label="SANTÉ" value={health} color={health > 50 ? '#22c55e' : health > 25 ? '#eab308' : '#ef4444'} />
        <Gauge label="FAIM" value={hunger} color={hunger > 50 ? '#f59e0b' : hunger > 20 ? '#fb923c' : '#ef4444'} />
      </div>

      {/* Indicateur de vague + zone (haut-centre) */}
      {playing && (
        <div style={{ position: 'absolute', top: 18, left: '50%', transform: 'translateX(-50%)', textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: 4, fontWeight: 700, color: '#fbbf24' }}>VAGUE {wave}</div>
          {banner === null && (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
              {remaining} zombie{remaining > 1 ? 's' : ''} · vague {wave + 1} dans {countdown}s
            </div>
          )}
          <div style={{ fontSize: 12, letterSpacing: 2, marginTop: 6, color: '#93c5fd' }}>
            ZONE {(zone ?? 0) + 1}/{zoneCount} · {zoneName}
          </div>
          {quest && quest.length > 0 && (
            <div style={{ fontSize: 12, marginTop: 3, fontWeight: 600, color: objDone ? '#22c55e' : '#e5e7eb' }}>
              🎯 {quest.map((q) => `${q.done ? '✅' : '⬜'} ${q.emoji} ${q.label}`).join('   ')}
            </div>
          )}
          <div style={{ fontSize: 12, marginTop: 2, fontWeight: 600, color: doorOpen ? '#22c55e' : '#f87171' }}>
            {doorOpen
              ? (isExit ? '🚪 SORTIE ouverte — foncez au fond !' : '🔓 Porte ouverte — foncez au fond !')
              : '🔒 ' + (isExit ? 'SORTIE verrouillée — ' : 'Objectif : ') + (doorHint || '')}
          </div>
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
        </div>
      )}

      <div style={{ position: 'absolute', bottom: 56, left: 20, display: 'flex', gap: 10 }}>
        <WeaponSlot keyLabel="1" name="Sabre" sub="∞" active={weapon === 'sabre'} />
        <WeaponSlot keyLabel="2" name="Pistolet" sub={ammo} danger={ammo === 0} active={weapon === 'pistol'} locked={!hasPistol} />
        <WeaponSlot keyLabel="3" name="Uzi" sub={uziAmmo} danger={uziAmmo === 0} active={weapon === 'uzi'} locked={!hasUzi} />
      </div>

      {toast && (
        <div style={{ position: 'absolute', top: 90, left: '50%', transform: 'translateX(-50%)', padding: '8px 18px', background: '#000000bb', borderRadius: 10, fontWeight: 600, fontSize: 15 }}>{toast}</div>
      )}

      {fuse != null && fuse > 0 && (
        <div style={{ position: 'absolute', top: '32%', left: '50%', transform: 'translateX(-50%)', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 96, fontWeight: 900, color: '#f97316', textShadow: '0 0 30px #f9731688, 0 4px 12px #000', lineHeight: 1 }}>{fuse}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#fca5a5', letterSpacing: 2, textShadow: '0 2px 8px #000' }}>ÉLOIGNEZ-VOUS !</div>
        </div>
      )}

      {boss && (
        <div style={{ position: 'absolute', top: 52, left: '50%', transform: 'translateX(-50%)', width: 'min(72vw, 560px)', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 2, color: boss.phase === 1 ? '#fca5a5' : '#fdba74', marginBottom: 4, textShadow: '0 2px 8px #000' }}>
            BOSS · {boss.phase === 1 ? 'PHASE 1 — ARME À FEU 🔫' : 'PHASE 2 — SABRE ⚔️'}
          </div>
          <div style={{ height: 16, background: '#00000066', borderRadius: 8, overflow: 'hidden', border: '1px solid #ffffff33' }}>
            <div style={{ width: `${Math.max(0, Math.min(100, (boss.hp / boss.max) * 100))}%`, height: '100%', background: boss.phase === 1 ? 'linear-gradient(90deg,#ef4444,#b91c1c)' : 'linear-gradient(90deg,#f97316,#c2410c)', transition: 'width 0.12s' }} />
          </div>
        </div>
      )}

      {search > 0 ? (
        <div style={{ position: 'absolute', bottom: 110, left: '50%', transform: 'translateX(-50%)', textAlign: 'center' }}>
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 6 }}>Fouille en cours…</div>
          <div style={{ width: 200, height: 12, background: '#ffffff22', borderRadius: 6, overflow: 'hidden', margin: '0 auto' }}>
            <div style={{ width: `${search * 100}%`, height: '100%', background: '#fbbf24' }} />
          </div>
        </div>
      ) : prompt ? (
        <div style={{ position: 'absolute', bottom: 110, left: '50%', transform: 'translateX(-50%)', fontSize: 14, opacity: 0.9 }}>
          {prompt === 'search'
            ? <>Maintenir <b>E</b> / <b>X</b> pour fouiller</>
            : prompt === 'key'
              ? <>Appuyez sur <b>E</b> / <b>X</b> pour utiliser la clé 🔑</>
              : <>Appuyez sur <b>E</b> / <b>X</b> pour faire sauter la porte 💥</>}
        </div>
      ) : null}

      <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', fontSize: 13, opacity: 0.55 }}>
        ZQSD / stick bouger · souris / stick droit viser · clic / Espace / RT attaquer · 1 / 2 / 3 / RB changer d'arme · E / X fouiller
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
          Fouillez les magasins (armurerie, pharmacie, épicerie, boulangerie) pour vous armer et vous nourrir. Ne mourez pas de faim.
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center', maxWidth: 720 }}>
        <Panel title="COMMANDES">
          Déplacement — ZQSD / stick gauche<br />
          Viser — Souris / stick droit<br />
          Attaquer — Clic / Espace / RT<br />
          Changer d'arme — 1 / 2 / 3 / RB<br />
          Fouiller — E / X (maintenir)
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

function WinScreen({ score, onRestart, onMenu }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, background: '#02140aee', color: '#fff', fontFamily: 'system-ui' }}>
      <div style={{ fontSize: 54, fontWeight: 800, letterSpacing: 2, color: '#22c55e' }}>ÉVASION RÉUSSIE !</div>
      <div style={{ fontSize: 20, opacity: 0.9 }}>Vous avez trouvé la sortie du supermarché.</div>
      <div style={{ fontSize: 20, opacity: 0.85 }}>Zombies abattus : <b>{score}</b></div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <button onClick={onRestart} style={{ padding: '12px 28px', fontSize: 16, fontWeight: 700, color: '#052e16', background: '#22c55e', border: 'none', borderRadius: 10, cursor: 'pointer' }}>
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
  const [uziAmmo, setUziAmmo] = useState(0)
  const [hasUzi, setHasUzi] = useState(false)
  const [survival, setSurvival] = useState({ hunger: HUNGER_MAX, search: 0, prompt: null, wave: 1, banner: 'VAGUE 1', countdown: WAVE_DURATION, remaining: 0, zone: 0, zoneName: ZONES[0].name, zoneCount: ZONES.length, doorOpen: false, isExit: false, quest: QUEST_ORDER.map((id) => ({ label: QUEST_ITEMS[id].label, emoji: QUEST_ITEMS[id].emoji, done: false })), doorHint: 'trouvez la CLÉ (cachée dans la galerie)', hasKey: false, fuse: null, boss: null, objDone: false })
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
  const handleUziAmmo = useCallback((n) => setUziAmmo(n), [])
  const handleUzi = useCallback((v) => setHasUzi(v), [])
  const handleSurvival = useCallback((s) => setSurvival(s), [])
  const handleWin = useCallback(() => setGameState('win'), [])
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
    setUziAmmo(0)
    setHasUzi(false)
    setSurvival({ hunger: HUNGER_MAX, search: 0, prompt: null, wave: 1, banner: 'VAGUE 1', countdown: WAVE_DURATION, remaining: 0, zone: 0, zoneName: ZONES[0].name, zoneCount: ZONES.length, doorOpen: false, isExit: false, quest: QUEST_ORDER.map((id) => ({ label: QUEST_ITEMS[id].label, emoji: QUEST_ITEMS[id].emoji, done: false })), doorHint: 'trouvez la CLÉ (cachée dans la galerie)', hasKey: false, fuse: null, boss: null, objDone: false })
    setToast(null)
    setGameKey((k) => k + 1)
  }
  const startGame = () => { Sfx.ensure(); resetState(); setGameState('playing') }
  const gotoMenu = () => { resetState(); setGameState('menu') }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0a0d', cursor: gameState === 'playing' ? 'crosshair' : 'default' }}>
      <Canvas shadows camera={{ position: [0, 14, 11], fov: 30 }}>
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
              onUziAmmo={handleUziAmmo}
              onPistol={handlePistol}
              onUzi={handleUzi}
              onSurvival={handleSurvival}
              onPickup={handlePickup}
              onWin={handleWin}
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
        uziAmmo={uziAmmo}
        hasUzi={hasUzi}
        search={survival.search}
        prompt={survival.prompt}
        toast={toast}
        wave={survival.wave}
        banner={survival.banner}
        countdown={survival.countdown}
        remaining={survival.remaining}
        zoneName={survival.zoneName}
        zone={survival.zone}
        zoneCount={survival.zoneCount}
        doorOpen={survival.doorOpen}
        isExit={survival.isExit}
        quest={survival.quest}
        doorHint={survival.doorHint}
        hasKey={survival.hasKey}
        fuse={survival.fuse}
        boss={survival.boss}
        objDone={survival.objDone}
        playing={gameState === 'playing'}
        muted={muted}
        onToggleMute={toggleMute}
      />
      {gameState === 'menu' && <StartScreen onPlay={startGame} />}
      {gameState === 'gameover' && <GameOver score={score} onRestart={startGame} onMenu={gotoMenu} />}
      {gameState === 'win' && <WinScreen score={score} onRestart={startGame} onMenu={gotoMenu} />}
      <div style={{ position: 'fixed', left: 8, bottom: 6, fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.4)', pointerEvents: 'none', userSelect: 'none' }}>
        {BUILD_TAG}
      </div>
    </div>
  )
}
