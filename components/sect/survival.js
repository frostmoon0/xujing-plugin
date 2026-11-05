/** 普通争执不等于血仇；只承认明确杀亲或灭门对象。 */
export function hasBloodFeud (a, b) {
  if (!a || !b) return false
  const life = b.lifeAt ?? b.joinAt ?? 0
  const saved = a.bloodEnemies?.[b.name]
  if (saved !== undefined && saved === life) return true
  return (a.vendetta?.culprit || []).includes(b.name) &&
    (a.enemyLives?.[b.name] === undefined || a.enemyLives[b.name] === life)
}
export function defeatDeathRate (level, { crush = false, bloodFeud = false, base = 5, ceiling = 50 } = {}) {
  const normal = Math.max(0.5, base * (1 - 0.9 * Math.min(68, Math.max(1, Number(level) || 1)) / 68))
  return Math.min(ceiling, normal * (bloodFeud ? 3 : crush ? 2.5 : 1))
}
export function temperCaptiveWeights (weights, { bloodFeud = false, cruelty = 0 } = {}) {
  if (bloodFeud) return weights
  // 无血仇时优先释放、收编或关押；残暴宗门仍可能处决。
  const factor = cruelty >= 0.4 ? 0.35 : 0.1
  const mineFactor = cruelty >= 0.4 ? 0.6 : 0.25
  const spared = weights.kill * (1 - factor) + weights.robKill * (1 - factor) + (weights.mine || 0) * (1 - mineFactor)
  return { ...weights, free: (weights.free || 0) + spared, kill: weights.kill * factor, robKill: weights.robKill * factor, mine: (weights.mine || 0) * mineFactor }
}
