/** 战争身份、名单与历史快照。纯数据操作，不读取存档或 Redis。 */
export const ACTIVE_WAR_PHASES = new Set(['prep', 'fight', 'retreat', 'settling'])
export const ACTOR_FIELDS = { fake: ['atkFakes', 'defFakes'], player: ['atkPlayers', 'defPlayers'] }

export function warActorOwner (f, kind, id) {
  const fields = ACTOR_FIELDS[kind] || []
  return (f.sectAttacks || []).filter(a => ACTIVE_WAR_PHASES.has(a.phase))
    .slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0) || Number(a.id) - Number(b.id))
    .find(a => fields.some(field => (a[field] || []).some(n => String(n) === String(id)))) || null
}

export function warActorAvailable (f, kind, id, war = null) {
  const owner = warActorOwner(f, kind, id)
  return !owner || (war && String(owner.id) === String(war.id))
}

export function defenderOf (f, war) {
  if (Object.hasOwn(war, 'defSect')) return war.defSect
  return war.targetType === 'sect' ? war.target : (f.areas?.[war.target] || null)
}

export function initWarState (f, war, now = Date.now()) {
  if (!Object.hasOwn(war, 'defSect')) war.defSect = war.targetType === 'sect' ? war.target : (f.areas?.[war.target] || null)
  war.snapshot ||= {
    attacker: f.sects?.[war.atkSect]?.name || war.teamName || war.rogueName || '散修',
    defender: f.sects?.[war.defSect]?.name || f.sectDeadNames?.[war.defSect] || '无主之地',
    target: war.targetType === 'sect' ? (f.sects?.[war.target]?.name || f.sectDeadNames?.[war.target] || '未知宗门') : war.target,
    region: war.targetType === 'sect' ? (f.sects?.[war.target]?.region || 'center') : null
  }
  war.actors ||= {}
  war.roundHistory ||= []
  for (const kind of ['fake', 'player']) {
    for (const [index, field] of ACTOR_FIELDS[kind].entries()) {
      war[field] = [...new Set((war[field] || []).map(String))]
      for (const id of war[field]) {
        const p = kind === 'fake' ? f.roster?.[id] : f.players?.[id]
        const key = `${kind}:${id}`
        war.actors[key] ||= { kind, id, side: index === 0 ? 'atk' : 'def', sect: war.actorSects?.[key] || p?.sect || null, name: p?.name || id, joinedAt: now, rounds: 0, contribution: 0 }
      }
    }
  }
  return war
}

/** 老档的重复兵力只归最早的一场；不创建第二份战力，也不改生命/资产。 */
export function reconcileWarActors (f, war) {
  war.defFakes = (war.defFakes || []).filter(id => !(war.atkFakes || []).includes(String(id)))
  war.defPlayers = (war.defPlayers || []).filter(id => !(war.atkPlayers || []).includes(String(id)))
  for (const [kind, fields] of Object.entries(ACTOR_FIELDS)) {
    for (const field of fields) war[field] = (war[field] || []).filter(id => warActorAvailable(f, kind, id, war))
  }
}

export function recordWarExit (war, kind, id, reason, now = Date.now()) {
  const actor = war.actors?.[`${kind}:${id}`]
  if (actor) { actor.leftAt = now; actor.exitReason = reason }
}

export async function creditWarRound (f, war, fakePower, playerPower, now = Date.now()) {
  initWarState(f, war, now)
  const record = { round: war.round, at: now, atk: 0, def: 0, actors: [] }
  for (const actor of Object.values(war.actors)) {
    const field = `${actor.side}${actor.kind === 'fake' ? 'Fakes' : 'Players'}`
    if (!(war[field] || []).includes(actor.id)) continue
    const power = Math.max(0, Number(actor.kind === 'fake' ? fakePower(f.roster?.[actor.id]) : await playerPower(actor.id)) || 0)
    actor.rounds++
    actor.contribution += power
    record[actor.side] += power
    record.actors.push({ key: `${actor.kind}:${actor.id}`, power })
  }
  war.roundHistory.push(record)
  return record
}

/** 夜间 1~6 点顺延战争的响应/回合时间；旧档从最近已知阶段时间补齐。 */
export function syncWarClock (war, now = Date.now()) {
  if (!ACTIVE_WAR_PHASES.has(war.phase)) return false
  const previous = Number(war.clockAt) || Number(war.start) || now
  if (now < previous) return false
  const day = new Date(previous); day.setHours(0, 0, 0, 0)
  let paused = 0
  while (day.getTime() < now) {
    const start = new Date(day); start.setHours(1, 0, 0, 0)
    const end = new Date(day); end.setHours(6, 0, 0, 0)
    paused += Math.max(0, Math.min(now, +end) - Math.max(previous, +start))
    day.setDate(day.getDate() + 1)
  }
  for (const field of ['prepEnd', 'nextRound', 'warNoticeAt', 'retreatAt']) if (Number(war[field]) > 0) war[field] += paused
  war.clockAt = now
  war.pausedMs = (Number(war.pausedMs) || 0) + paused
  return paused > 0
}

export function resolveWarReference (f, raw, predicate = () => true) {
  const text = String(raw || '').trim().replace(/^[#＃]/, '')
  const wars = (f.sectAttacks || []).filter(a => ACTIVE_WAR_PHASES.has(a.phase) && predicate(a))
  if (!text) return wars.length === 1 ? wars[0] : null
  return wars.find(a => String(a.id) === text || a.target === text || f.sects?.[a.target]?.name === text || a.snapshot?.target === text) || null
}

/** 存档重开后可复用数字战役号，收据仍必须隔离新旧战争。 */
export const warReceipt = war => `war:${war.id}:${war.start || 'legacy'}`

/** 同一结算重试使用相同的命运，避免半途失败后重掷俘虏/死亡。 */
export function warRoll (war, key) {
  let hash = 2166136261
  for (const ch of `${warReceipt(war)}:${key}`) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619) }
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d); hash ^= hash >>> 15
  return (hash >>> 0) / 4294967296
}

export function warCaptiveOwner (f, kind, id) {
  const field = kind === 'fake' ? 'fakes' : 'players'
  return (f.sectAttacks || []).find(a => {
    const c = a.captives || {}
    return [c, c.byAtk, c.byDef, ...Object.values(c.byShare || {})].some(pool => (pool?.[field] || []).some(value => String(value) === String(id)))
  }) || null
}

export function hasWarCaptives (war) {
  const c = war.captives || {}
  return [c, c.byAtk, c.byDef, ...Object.values(c.byShare || {})].some(pool => (pool?.fakes?.length || 0) + (pool?.players?.length || 0) > 0)
}
