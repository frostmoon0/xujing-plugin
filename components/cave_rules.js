/** 玩家与伪玩家共用的万魂窟规则；不依赖存档或角色模块。 */
export const GHOST_ENCOUNTER_CHANCE = 0.08
export const CAVE_PROTECTION_MS = 10 * 60000
export const CAVE_LOST_MS = 10 * 3600000
export function caveEncounterDelay (random = Math.random) {
  return 30000 + Math.floor(random() * 90001)
}

/** 阴魂只随探索时长增强，不随探索者变强。 */
export function caveEnemyPower (minutes) {
  const elapsed = Math.max(0, Number(minutes) || 0)
  const scale = power => Math.round(power * 0.8)
  if (elapsed < 45) {
    const progress = elapsed / 45
    return scale(500 + 34500 * progress * progress)
  }
  if (elapsed < 60) return scale(35000 + 5000 * (elapsed - 45) / 15)
  if (elapsed < 80) return scale(40000 + 10000 * (elapsed - 60) / 20)
  return scale(50000 + (elapsed - 80) * 1000)
}
