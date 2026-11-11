export const INJURY_PCT = [0, 20, 40, 60]
export const INJURY_RECOVER = [0, 30, 120, 480]

/** 真人、NPC及所有玩法共用伤势衰减；只计算，不写存档。 */
export function injuryState (injury, now = Date.now()) {
  const level = Math.trunc(Number(injury?.level) || 0)
  const empty = { level: 0, pct: 0, remainMin: 0, totalMin: 0 }
  if (level < 1 || level > 3) return empty
  const total = INJURY_RECOVER[level] * 60000
  const elapsed = Math.max(0, now - (Number(injury.at) || 0))
  if (elapsed >= total) return empty
  const effective = Math.max(1, Math.ceil(level * (1 - elapsed / total)))
  return { level: effective, pct: INJURY_PCT[effective], remainMin: Math.ceil((total - elapsed) / 60000), totalMin: INJURY_RECOVER[level] }
}

export function injuredPower (power, injury, now = Date.now()) {
  return Math.max(0, Math.round(power * (1 - injuryState(injury, now).pct / 100)))
}
