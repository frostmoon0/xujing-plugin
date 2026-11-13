const LISTS = ['disciples', 'enemies', 'friends', 'confidants', 'siblings', 'kin']
const SOCIAL = ['friends', 'confidants', 'siblings', 'kin']
const lifeOf = p => p?.lifeAt ?? p?.joinAt ?? 0
export function ensureFakeRelations (p) {
  const r = p.relations && typeof p.relations === 'object' ? p.relations : (p.relations = {})
  for (const key of LISTS) r[key] = [...new Set((Array.isArray(r[key]) ? r[key] : []).filter(n => typeof n === 'string' && n && n !== p.name))]
  for (const key of ['spouse', 'master']) if (typeof r[key] !== 'string' || r[key] === p.name) r[key] = null
  return r
}
export function rememberFakeRelation (a, b) {
  ;(a.relationLives ||= {})[b.name] = lifeOf(b)
  ;(b.relationLives ||= {})[a.name] = lifeOf(a)
}
function validReference (f, p, name) {
  const q = f.roster?.[name]
  if (!q?.alive || name === p.name) return false
  const saved = p.relationLives?.[name]
  if (saved !== undefined) return saved === lifeOf(q)
  const death = f.deathRecords?.[name]?.t
  return !(death && lifeOf(q) > death && lifeOf(p) <= death)
}
/** 保留双方认可且身份有效的旧关系；不将单向残留猜测成新关系。 */
export function repairFakeRelations (f) {
  const people = Object.values(f.roster || {}).filter(p => p?.alive)
  const before = JSON.stringify(people.map(p => [p.relations, p.relationLives, p.enemyLives, p.bloodEnemies, p.vendetta]))
  for (const p of people) ensureFakeRelations(p)
  const accepted = new Map(people.map(p => {
    const r = p.relations
    return [p.name, {
      ...Object.fromEntries(SOCIAL.map(key => [key, r[key].filter(n => validReference(f, p, n) && validReference(f, f.roster[n], p.name) && (f.roster[n].relations[key] || []).includes(p.name))])),
      master: validReference(f, p, r.master) && validReference(f, f.roster[r.master], p.name) && f.roster[r.master].relations.disciples.includes(p.name) ? r.master : null,
      spouse: validReference(f, p, r.spouse) && validReference(f, f.roster[r.spouse], p.name) && f.roster[r.spouse].relations.spouse === p.name ? r.spouse : null,
      disciples: r.disciples.filter(n => validReference(f, p, n) && validReference(f, f.roster[n], p.name) && f.roster[n].relations.master === p.name)
    }]
  }))
  for (const p of people) {
    Object.assign(p.relations, accepted.get(p.name))
    p.relations.enemies = p.relations.enemies.filter(n => n.startsWith('player:') || validReference(f, p, n) && (p.enemyLives?.[n] === undefined || p.enemyLives[n] === lifeOf(f.roster[n])))
    for (const field of ['enemyLives', 'bloodEnemies']) for (const n of Object.keys(p[field] || {})) {
      if (!p.relations.enemies.includes(n)) delete p[field][n]
    }
    if (p.vendetta) {
      p.vendetta.culprit = [...new Set(p.vendetta.culprit || [])].filter(n => p.relations.enemies.includes(n) && validReference(f, p, n))
      if (!p.vendetta.culprit.length) p.vendetta = null
    }
    const refs = new Set([p.relations.master, p.relations.spouse, ...SOCIAL.flatMap(key => p.relations[key]), ...p.relations.disciples].filter(Boolean))
    for (const n of Object.keys(p.relationLives || {})) if (!refs.has(n)) delete p.relationLives[n]
    for (const n of refs) rememberFakeRelation(p, f.roster[n])
  }
  return before !== JSON.stringify(people.map(p => [p.relations, p.relationLives, p.enemyLives, p.bloodEnemies, p.vendetta]))
}
export function forgetFakeRelations (f, name) {
  for (const p of Object.values(f.roster || {})) {
    if (!p?.alive) continue
    const r = ensureFakeRelations(p)
    for (const key of ['spouse', 'master']) if (r[key] === name) r[key] = null
    for (const key of LISTS) r[key] = r[key].filter(n => n !== name)
    for (const field of ['relationLives', 'enemyLives', 'bloodEnemies']) if (p[field]) delete p[field][name]
    if (p.vendetta) {
      p.vendetta.culprit = (p.vendetta.culprit || []).filter(n => n !== name)
      if (!p.vendetta.culprit.length) p.vendetta = null
    }
  }
}
export function canFakeRomance (a, b) {
  if (!a?.alive || !b?.alive || a.name === b.name) return false
  const ar = ensureFakeRelations(a), br = ensureFakeRelations(b)
  return ar.master !== b.name && br.master !== a.name && !ar.disciples.includes(b.name) && !br.disciples.includes(a.name) &&
    !ar.siblings.includes(b.name) && !br.siblings.includes(a.name) && !ar.kin.includes(b.name) && !br.kin.includes(a.name) &&
    !ar.enemies.includes(b.name) && !br.enemies.includes(a.name)
}
export function setFakeSpouses (f, a, b) {
  for (const p of Object.values(f.roster || {})) {
    if (!p?.alive) continue
    const r = ensureFakeRelations(p)
    if (p === a || p === b || r.spouse === a.name || r.spouse === b.name) r.spouse = null
  }
  a.relations.spouse = b.name; b.relations.spouse = a.name
  rememberFakeRelation(a, b)
}
export function addFakeEnemy (a, b, blood = false) {
  const r = ensureFakeRelations(a)
  if (a.name === b.name) return
  if (!r.enemies.includes(b.name)) r.enemies.push(b.name)
  ;(a.enemyLives ||= {})[b.name] = lifeOf(b)
  if (blood) (a.bloodEnemies ||= {})[b.name] = lifeOf(b)
}
export function clearFakeFeud (a, b) {
  for (const [p, q] of [[a, b], [b, a]]) {
    ensureFakeRelations(p).enemies = p.relations.enemies.filter(n => n !== q.name)
    if (p.enemyLives) delete p.enemyLives[q.name]
    if (p.bloodEnemies) delete p.bloodEnemies[q.name]
    if (p.vendetta) {
      p.vendetta.culprit = (p.vendetta.culprit || []).filter(n => n !== q.name)
      if (!p.vendetta.culprit.length) p.vendetta = null
    }
  }
}
