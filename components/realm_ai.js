/** 秘境AI只选择现有动作；战力、掉落及结算规则由秘境模块提供。 */
export function realmLootValue (team) {
  return (team.pool || []).reduce((sum, item) => {
    const count = Math.max(0, Number(item.count) || 0)
    return sum + (item.currency || item.name === '灵石' ? count / 1000 : count * (Math.max(1, Number(item.quality) || 1) ** 2 + 2))
  }, 0)
}

export function realmFightMargin (team, actor = {}) {
  let margin = actor.trait === '好斗' || actor.trait === '嗜杀' ? 1.1 : 1.25
  if ((team.lives ?? 3) <= 1) margin += 0.35
  else if (team.lives === 2) margin += 0.1
  if (realmLootValue(team) >= 40) margin += 0.15
  return margin
}

export function realmWantsFight (team, actor = {}, revenge = false) {
  return revenge || actor.path === '魔道' || ['嗜杀', '好斗'].includes(actor.trait) || actor.act === '贪玩'
}

/** 每次决策使用当前战力；性格只影响优势幅度，不使明显不敌者主动送死。 */
export function realmNpcChoice (team, node, actor = {}, context = {}) {
  const power = Math.max(0, Number(context.power) || 0)
  const required = Math.max(1, Number(context.requiredPower ?? node.data?.requiredPower ?? node.data?.enemyPower) || Infinity)
  const safeWin = power >= required * ((team.lives ?? 3) <= 1 ? 1.2 : 1)
  let choice = 2
  switch (node.type) {
    case 'treasure': choice = 1; break
    case 'fake':
    case 'player':
      choice = !context.friendly && realmWantsFight(team, actor, context.revenge) &&
        Number.isFinite(context.opponentPower) && power >= context.opponentPower * realmFightMargin(team, actor) ? 1 : (node.type === 'player' ? 2 : 3)
      break
    case 'canwu':
    case 'dushi': choice = safeWin ? 1 : ((team.lives ?? 3) <= 1 ? 3 : 2); break
    case 'chuangguan':
    case 'trial': choice = safeWin ? 1 : 2; break
    case 'beast': choice = safeWin ? 1 : 3; break
    case 'duojie': choice = safeWin ? 1 : 2; break
    case 'jueze': choice = (actor.path === '魔道' || actor.trait === '嗜杀') && (team.lives ?? 3) > 1 ? 3 : 1; break
    case 'maze': choice = 3; break
    case 'spring':
    case 'scroll': choice = 1; break
    case 'jiemi':
    case 'elder':
    case 'contest': choice = 2; break
  }
  return node.choices?.some(c => c.n === choice) ? choice : (node.choices?.[0]?.n ?? choice)
}

export function realmNpcShouldLeave (team, power, threatPower, remainingMs, now = Date.now()) {
  const loot = realmLootValue(team)
  if (loot <= 0) return false
  if ((team.lives ?? 3) <= 1 || (Number(team.injured) || 0) >= 3) return true
  if (team.exposedUntil > now && threatPower > power * 1.5 && (loot >= 12 || now - (team.startedAt || now) >= 5 * 60000)) return true
  return remainingMs <= 5 * 60000 && threatPower > power * 1.2
}

export function realmNpcAmbush (team, actor = {}, power, opponents = []) {
  if (!opponents.length || ['平和', '善良'].includes(actor.trait) || actor.act === '懒散') return 'flee'
  if ((team.lives ?? 3) <= 1 || (Number(team.injured) || 0) >= 2 || realmLootValue(team) >= 60) return 'flee'
  const strongest = Math.max(...opponents.map(x => Number(x.power) || 0))
  const margin = realmWantsFight(team, actor) ? 1.3 : 1.6
  return power >= strongest * margin && opponents.some(x => realmLootValue(x.team) > 0) ? 'fight' : 'flee'
}
