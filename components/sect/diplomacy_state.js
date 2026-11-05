/** 双边外交的唯一写入入口；旧 allies/enemies 是兼容投影。无存档/Redis依赖。 */
export const DIPLOMACY_TERM = 6 * 3600000
const pairKey = (a, b) => JSON.stringify([String(a), String(b)].sort())
const valid = (f, a, b) => a && b && a !== b && f.sects?.[a] && f.sects?.[b]

function project (f, r) {
  for (const [sid, other] of [[r.a, r.b], [r.b, r.a]]) {
    const s = f.sects[sid]
    s.allies = [...new Set(s.allies || [])].filter(id => id !== other && id !== sid && !!f.sects[id])
    s.enemies = [...new Set(s.enemies || [])].filter(id => id !== other && id !== sid && !!f.sects[id])
    if (r.status === 'allied') s.allies.push(other)
    if (r.status === 'hostile') s.enemies.push(other)
  }
}

export function diplomacyPair (f, a, b, now = Date.now()) {
  if (!valid(f, a, b)) return null
  f.diplomacyPairs ||= {}
  const key = pairKey(a, b)
  if (!f.diplomacyPairs[key]) {
    const sa = f.sects[a], sb = f.sects[b]
    const fighting = (f.sectAttacks || []).some(w => ['prep', 'fight', 'retreat', 'settling'].includes(w.phase) &&
      ((w.atkSect === a && (w.defSect || (w.targetType === 'sect' ? w.target : f.areas?.[w.target])) === b) ||
       (w.atkSect === b && (w.defSect || (w.targetType === 'sect' ? w.target : f.areas?.[w.target])) === a)))
    const hostile = fighting || (sa.enemies || []).includes(b) || (sb.enemies || []).includes(a)
    const allied = !hostile && ((sa.allies || []).includes(b) || (sb.allies || []).includes(a))
    f.diplomacyPairs[key] = { a, b, status: hostile ? 'hostile' : allied ? 'allied' : 'neutral', since: now, changedAt: now, allyUntil: allied ? now + DIPLOMACY_TERM : 0, truceUntil: 0, breakUntil: 0, trust: 0, grievance: 0, reason: '旧档关系归一' }
  }
  return f.diplomacyPairs[key]
}

export function hasTruce (f, a, b, now = Date.now()) {
  return !!(valid(f, a, b) && (f.diplomacyPairs?.[pairKey(a, b)]?.truceUntil || 0) > now)
}

export function setDiplomacyRelation (f, a, b, status, now = Date.now(), reason = '', { truce = false } = {}) {
  const r = diplomacyPair(f, a, b, now)
  if (!r || !['allied', 'hostile', 'neutral'].includes(status)) return false
  if (status === 'hostile' && hasTruce(f, a, b, now)) return false
  const previous = r.status
  if (previous !== status) {
    r.status = status; r.since = now; r.changedAt = now
    if (status === 'allied') { r.allyUntil = now + DIPLOMACY_TERM; r.trust = Math.min(100, r.trust + 10) }
    if (previous === 'allied') { r.breakUntil = now + DIPLOMACY_TERM; r.trust = Math.max(-100, r.trust - 20) }
    if (status === 'hostile') r.grievance = Math.min(100, r.grievance + 20)
  }
  if (truce) { r.truceUntil = Math.max(r.truceUntil || 0, now + DIPLOMACY_TERM); r.grievance = Math.max(0, r.grievance - 10) }
  r.reason = reason || r.reason
  project(f, r)
  return true
}

export function normalizeDiplomacy (f, now = Date.now()) {
  const before = JSON.stringify([f.diplomacyPairs, Object.values(f.sects || {}).map(s => [s.allies, s.enemies])])
  f.diplomacyPairs ||= {}
  for (const [key, r] of Object.entries(f.diplomacyPairs)) if (!r || !valid(f, r.a, r.b)) delete f.diplomacyPairs[key]
  const ids = Object.keys(f.sects || {})
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) project(f, diplomacyPair(f, ids[i], ids[j], now))
  for (const sid of ids) for (const field of ['allies', 'enemies']) f.sects[sid][field] = [...new Set(f.sects[sid][field] || [])].filter(id => id !== sid && !!f.sects[id])
  return before !== JSON.stringify([f.diplomacyPairs, Object.values(f.sects || {}).map(s => [s.allies, s.enemies])])
}

export function forgetSectDiplomacy (f, sid) {
  for (const [key, r] of Object.entries(f.diplomacyPairs || {})) if (r.a === sid || r.b === sid) delete f.diplomacyPairs[key]
  for (const s of Object.values(f.sects || {})) for (const field of ['allies', 'enemies']) s[field] = (s[field] || []).filter(id => id !== sid)
  for (const [key, offer] of Object.entries(f.peaceOffers || {})) if (offer.from === sid || offer.to === sid) delete f.peaceOffers[key]
}

export function recordDiplomacyAid (f, a, b, now = Date.now()) {
  const r = diplomacyPair(f, a, b, now)
  if (r) { r.trust = Math.min(100, r.trust + 5); r.lastAidAt = now }
}
