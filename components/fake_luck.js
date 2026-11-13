/** 气运只影响既有事件的概率，不直接发放修为、战力或资源。 */
export const FAKE_LUCK_TIERS = [
  { name: '平常', weight: 6000, bonus: 0, survival: 1 },
  { name: '小吉', weight: 2200, bonus: 2, survival: 0.95 },
  { name: '顺遂', weight: 1000, bonus: 4, survival: 0.88 },
  { name: '福缘', weight: 500, bonus: 6, survival: 0.78 },
  { name: '鸿运', weight: 200, bonus: 9, survival: 0.65 },
  { name: '天眷', weight: 80, bonus: 12, survival: 0.5 },
  { name: '气运之子', weight: 20, bonus: 15, survival: 0.35 }
]
/** 只随当前生涯保存，随机独立抽取；不按名字绑定、不设名额，也不随遗产转移。 */
export function ensureFakeLuck (p, random = Math.random) {
  if (Number.isInteger(p.luckTier) && p.luckTier >= 1 && p.luckTier <= 7) return p.luckTier
  let roll = random() * FAKE_LUCK_TIERS.reduce((sum, x) => sum + x.weight, 0)
  p.luckTier = FAKE_LUCK_TIERS.findIndex(x => (roll -= x.weight) < 0) + 1 || 7
  return p.luckTier
}
export function fakeLuckOf (p) { return FAKE_LUCK_TIERS[Math.max(0, Math.min(6, (Number(p?.luckTier) || 1) - 1))] || FAKE_LUCK_TIERS[0] }
export function luckyChance (chance, p, scale = 100) {
  if (!(chance > 0) || chance >= scale) return chance
  return Math.max(chance, Math.min(scale * 0.99, chance + fakeLuckOf(p).bonus / 100 * scale))
}
export function luckyDeathRate (chance, p) { return Math.max(0, chance) * fakeLuckOf(p).survival }
export function pickLuckyFake (people, random = Math.random) {
  const weight = p => 1 + fakeLuckOf(p).bonus / 10
  let roll = random() * people.reduce((sum, p) => sum + weight(p), 0)
  return people.find(p => (roll -= weight(p)) < 0) || people.at(-1)
}
