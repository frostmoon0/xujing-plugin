export const VAULT_EQUIP_PRICES = [0, 2, 4, 6, 8, 12, 20, 36]
export const VAULT_PILL_PRICES = {
  修为丹: 1, 破障丹: 2,
  聚宝丹: 3, 惊鸿丹: 3, 灵犀丹: 3, 行运丹: 3, 同心丹: 3,
  玉甲丹: 3, 凝露丹: 3, 慧心丹: 3, 摄魂丹: 3
}
export const SECT_DUTY_HOUR = 3600000
export const SECT_DUTY_DAILY = 12
export const PLAYER_DUTY_ACTIVE_MS = 2 * SECT_DUTY_HOUR
export const VAULT_ROUND_MS = 30 * 60000
export const VAULT_DAILY_CULTIVATION_BUDGET = 6

/** 无偿取用的灵石再次上供时视为归还，避免反复存取刷贡献。 */
export function donationCredit (drawn, amount) {
  const returned = Math.min(Math.max(0, Number(drawn) || 0), amount)
  return { drawn: Math.max(0, (Number(drawn) || 0) - returned), contribution: Math.floor((amount - returned) / 100) }
}

export function dutyDay (now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 只累计连续、可履职的分钟；首次升级和停机不追溯发放。上供贡献不受此限。 */
export function accrueSectDuty (p, sid, now, eligible) {
  const day = dutyDay(now)
  let d = p.sectDuty
  if (!d || d.sect !== sid || d.joinAt !== (Number(p.joinAt) || 0)) {
    p.sectDuty = { sect: sid, joinAt: Number(p.joinAt) || 0, day, earned: d?.day === day ? Number(d.earned) || 0 : 0, progress: 0, at: now, eligible: !!eligible }
    return 0
  }
  const elapsed = now - (Number(d.at) || now)
  if (d.day !== day) { d.day = day; d.earned = 0 }
  if (d.eligible && eligible && elapsed > 0 && elapsed <= 2 * 60000) d.progress = (Number(d.progress) || 0) + elapsed
  const hours = Math.floor((Number(d.progress) || 0) / SECT_DUTY_HOUR)
  const gain = Math.max(0, Math.min(hours, SECT_DUTY_DAILY - (Number(d.earned) || 0)))
  d.progress = Math.max(0, Number(d.progress) || 0) % SECT_DUTY_HOUR
  d.earned = (Number(d.earned) || 0) + gain
  d.at = now; d.eligible = !!eligible
  p.contribution = Math.max(0, Number(p.contribution) || 0) + gain
  return gain
}

export function dutyEarnedToday (p, now = Date.now()) {
  return p?.sectDuty?.day === dutyDay(now) ? Math.min(SECT_DUTY_DAILY, Number(p.sectDuty.earned) || 0) : 0
}

export function vaultPriceText () {
  return `修为丹=${VAULT_PILL_PRICES.修为丹}｜破障丹=${VAULT_PILL_PRICES.破障丹}｜增益丹=3｜白/绿/蓝/紫/金/红/彩装备=${VAULT_EQUIP_PRICES.slice(1).join('/')}贡献`
}
