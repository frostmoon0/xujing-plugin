/**
 * 万魂窟掉落表(从 wanhun_data 抽出的中立模块)
 * 用途: 玩家万魂窟与伪玩家万魂窟共用同一套掉落规则, 避免 fake_data 与 wanhun_data 循环依赖。
 */
export const CAVE_BASE_MATERIALS = ['阴魂砂', '游魂骨', '鬼火草', '幽冥木', '摄魂铁', '阴魂石']
export const CAVE_BASE_WEIGHTS = [5, 4, 3, 2, 2, 1]
export const CAVE_COLOR_MATERIALS = ['万魂幡残卷', '万魂帝晶']
export const CAVE_ADVANCED_MATERIALS = ['玄阴玉', '镇魂晶', '血煞髓']

export function caveDropCount (minutes, rand = Math.random) {
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (elapsed < 30) return 1 + Math.floor(rand() * 4)
  if (elapsed < 50) return 4 + Math.floor(rand() * 5)
  return 4 + Math.floor(rand() * 9)
}

export function caveAdvancedChance (name, minutes) {
  if (!CAVE_ADVANCED_MATERIALS.includes(name)) return 0
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (elapsed < 30) return 0.005
  const base = { 玄阴玉: 0.02, 镇魂晶: 0.015, 血煞髓: 0.01 }[name]
  const cap = { 玄阴玉: 0.1, 镇魂晶: 0.08, 血煞髓: 0.05 }[name]
  return Math.min(cap, base + Math.floor((elapsed - 30) / 10) * 0.015)
}

export function wanhunScrollChance (minutes) {
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (elapsed < 30) return 0.02 / 6
  return Math.min(0.25 / 6, (0.05 + Math.floor((elapsed - 30) / 10) * 0.01) / 6)
}

export function caveColorChance (name, minutes) {
  if (!CAVE_COLOR_MATERIALS.includes(name)) return 0
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (name === '万魂幡残卷') return wanhunScrollChance(elapsed)
  if (elapsed < 50) return 0.005
  if (name === '万魂帝晶') return Math.min(0.2, 0.03 + Math.floor((elapsed - 50) / 10) * 0.01)
  return Math.min(0.1, 0.005 + Math.floor((elapsed - 50) / 10) * 0.005)
}

export function caveRollOne (minutes, rand = Math.random) {
  for (const name of CAVE_COLOR_MATERIALS) {
    if (rand() < caveColorChance(name, minutes)) return name
  }
  for (const name of CAVE_ADVANCED_MATERIALS) {
    if (rand() < caveAdvancedChance(name, minutes)) return name
  }
  const total = CAVE_BASE_WEIGHTS.reduce((sum, w) => sum + w, 0)
  let roll = rand() * total
  for (let i = 0; i < CAVE_BASE_MATERIALS.length; i++) {
    roll -= CAVE_BASE_WEIGHTS[i]
    if (roll < 0) return CAVE_BASE_MATERIALS[i]
  }
  return CAVE_BASE_MATERIALS[CAVE_BASE_MATERIALS.length - 1]
}

export function rollCaveLoot (minutes, rand = Math.random) {
  const rewards = {}
  const drops = caveDropCount(minutes, rand)
  for (let i = 0; i < drops; i++) {
    const name = caveRollOne(minutes, rand)
    rewards[name] = (rewards[name] || 0) + 1
  }
  return rewards
}
