/* ============================================================
 * 境界硬上限: 仙帝第499重(level 567)
 * 统一出口, 供玩家突破/伪玩家境界/战力换算/存档读取共用。
 * 超过上限的旧档在读取/写回时收敛到上限, 避免战力继续溢出。
 * ============================================================ */

/** 仙帝巅峰等级(17 大境界 × 4 小阶 = 68) */
export const XIANDI_BASE_LEVEL = 68
/** 仙帝之后的最高重数 */
export const XIANDI_MAX_CHONG = 499
/** 境界硬上限等级: 68 + 499 = 567 */
export const REALM_MAX_LEVEL = XIANDI_BASE_LEVEL + XIANDI_MAX_CHONG
/** 上限境界名 */
export const MAX_LEVEL_NAME = `仙帝第${XIANDI_MAX_CHONG}重`

/** 把任意等级收敛到 [0, REALM_MAX_LEVEL] 的整数 */
export function clampLevel (level) {
  const n = Math.floor(Number(level) || 0)
  return Math.max(0, Math.min(REALM_MAX_LEVEL, n))
}

/** 是否已到境界上限 */
export function isAtRealmCap (level) {
  return (Number(level) || 0) >= REALM_MAX_LEVEL
}

/**
 * 收敛一份 battle 存档(uid -> { level, levelname, ... })。
 * 只处理超过上限的档, 不动正常档; 原地修改。
 * @returns {boolean} 是否有档被收敛(调用方可用于决定是否立即落盘)
 */
export function normalizeBattleLevels (battle) {
  if (!battle || typeof battle !== 'object') return false
  let changed = false
  for (const uid of Object.keys(battle)) {
    const u = battle[uid]
    if (!u || typeof u !== 'object') continue
    if ((Number(u.level) || 0) > REALM_MAX_LEVEL) {
      u.level = REALM_MAX_LEVEL
      u.levelname = MAX_LEVEL_NAME
      changed = true
    }
  }
  return changed
}
