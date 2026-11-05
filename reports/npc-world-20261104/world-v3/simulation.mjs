import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = path.dirname(fileURLToPath(import.meta.url))
const sandbox = path.resolve(root, '../..')
if (!path.basename(sandbox).startsWith('xujing-autoworld-')) throw new Error('Run only from an isolated xujing-autoworld-* plugin mirror')
const out = path.join(sandbox, 'output')
const seed = Number(process.argv[2] || 104)
const hours = Number(process.argv[3] || 24)
const mode = process.argv[4] || 'baseline'
const label = `seed-${seed}-${hours}h${mode === 'baseline' ? '' : '-' + mode}`
const originalDate = Date
const start = +new originalDate('2026-11-04T06:00:00+08:00')
let clock = start
global.Date = class extends originalDate {
  constructor (...args) { super(...(args.length ? args : [clock])) }
  static now () { return clock }
}
let rng = seed >>> 0
Math.random = () => { rng = (rng + 0x6D2B79F5) >>> 0; let t = rng; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }

const real = Object.fromEntries(['existsSync', 'readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'readdirSync', 'openSync', 'fsyncSync', 'closeSync'].map(k => [k, fs[k].bind(fs)]))
const disk = new Map()
const dataRoot = path.join(sandbox, 'data')
const normalize = name => path.resolve(String(name))
const virtual = name => typeof name !== 'number' && normalize(name).startsWith(dataRoot + path.sep)
global.__simDiskWrite = (file, data) => { disk.set(normalize(file), { data }); return true }
fs.existsSync = file => virtual(file) ? disk.has(normalize(file)) || [...disk.keys()].some(k => k.startsWith(normalize(file) + path.sep)) : real.existsSync(file)
fs.readFileSync = (file, options) => {
  if (!virtual(file)) return real.readFileSync(file, options)
  const item = disk.get(normalize(file)); if (!item) { const error = new Error(`ENOENT ${file}`); error.code = 'ENOENT'; throw error }
  const value = item.text ?? JSON.stringify(item.data)
  return options ? value : Buffer.from(value)
}
fs.writeFileSync = (file, value, options) => virtual(file) ? disk.set(normalize(file), { text: String(value) }) : real.writeFileSync(file, value, options)
fs.mkdirSync = (file, options) => virtual(file) || normalize(file) === dataRoot ? undefined : real.mkdirSync(file, options)
fs.renameSync = (from, to) => { if (!virtual(from)) return real.renameSync(from, to); disk.set(normalize(to), disk.get(normalize(from))); disk.delete(normalize(from)) }
fs.unlinkSync = file => virtual(file) ? disk.delete(normalize(file)) : real.unlinkSync(file)
fs.readdirSync = (dir, options) => {
  if (!virtual(dir) && normalize(dir) !== dataRoot) return real.readdirSync(dir, options)
  return [...new Set([...disk.keys()].filter(k => k.startsWith(normalize(dir) + path.sep)).map(k => k.slice(normalize(dir).length + 1).split(path.sep)[0]))]
}

// Exact positive-directory cache for the isolated adapter; invalidate on removal/rename.
const originalResolve = path.resolve
const stableCwd = process.cwd(), resolvedPaths = new Map()
path.resolve = function (...args) {
  if (args.length !== 1 || typeof args[0] !== 'string' || process.cwd() !== stableCwd) return originalResolve(...args)
  if (resolvedPaths.has(args[0])) return resolvedPaths.get(args[0])
  const result = originalResolve(args[0]); if (resolvedPaths.size > 4096) resolvedPaths.clear()
  resolvedPaths.set(args[0], result); return result
}
const petDirectory = path.join(sandbox, 'data', path.basename(root), 'save', 'pet')
const originalExists = fs.existsSync, originalUnlink = fs.unlinkSync, originalRename = fs.renameSync
let petDirectoryKnown = false
const resolvedKey = file => typeof file === 'string' ? path.resolve(file) : null
fs.existsSync = file => {
  if (resolvedKey(file) !== petDirectory) return originalExists(file)
  if (petDirectoryKnown) return true
  const exists = originalExists(file); if (exists) petDirectoryKnown = true; return exists
}
fs.unlinkSync = file => { if (resolvedKey(file)?.startsWith(petDirectory + path.sep)) petDirectoryKnown = false; return originalUnlink(file) }
fs.renameSync = (from, to) => {
  if (resolvedKey(from)?.startsWith(petDirectory + path.sep) || resolvedKey(to)?.startsWith(petDirectory + path.sep)) petDirectoryKnown = false
  return originalRename(from, to)
}

// Only the persistence adapter and event observer change. All gameplay source is unchanged.
registerHooks({ load (url, context, next) {
  if (url.endsWith('/components/json_store.js')) return { format: 'module', shortCircuit: true, source: 'export function writeJsonAtomic(file,data) { return globalThis.__simDiskWrite(file,data) }' }
  const loaded = next(url, context)
  if (url.endsWith('/components/fake_data.js')) {
    let source = String(loaded.source).replace(/\r\n/g, '\n').replace('export function logEvent (f, type, txt, t = Date.now(), opts = {}) {', 'export function logEvent (f, type, txt, t = Date.now(), opts = {}) {\n  globalThis.__simObserve?.(f, type, txt, t, opts)')
    source = source.replaceAll('f.roster[name] = p', 'globalThis.__simBirth?.(f, name, p.status); f.roster[name] = p; globalThis.__simRosterChanged?.()').replace('delete f.roster[p.name]', 'delete f.roster[p.name]; globalThis.__simRosterChanged?.()')
    source = source.replace('return Object.values(f && f.roster ? f.roster : {}).reduce((sum, p) => p && p.alive ? sum + (Number(p.money) || 0) : sum, 0)', 'if (globalThis.__simTotalMoney) return globalThis.__simTotalMoney(f); return Object.values(f && f.roster ? f.roster : {}).reduce((sum, p) => p && p.alive ? sum + (Number(p.money) || 0) : sum, 0)')
    const measured = source.replace('export function killPerson (f, p, txt, t = Date.now(), opts = {}) {\n  if (!p || !p.alive) return', 'export function killPerson (f, p, txt, t = Date.now(), opts = {}) {\n  if (!p || !p.alive) return\n  globalThis.__simDeath?.(p, txt, t)')
    return { ...loaded, source: measured }
  }
  if (mode === 'no-war' && url.endsWith('/components/sect/tick.js')) return { ...loaded, source: String(loaded.source).replace('if (await spawnAiSectAttacks(f, gid, now))', 'if (false)') }
  return loaded
} })

const values = new Map(); const hashes = new Map(); const deadlines = new Map()
function expired (key) { if ((deadlines.get(key) || Infinity) <= clock) { values.delete(key); hashes.delete(key); deadlines.delete(key) } }
global.redis = {
  async get (key) { expired(key); return values.get(key) ?? null },
  async set (key, value, options = {}) { values.set(key, String(value)); if (options.EX) deadlines.set(key, clock + options.EX * 1000); return 'OK' },
  async del (...keys) { for (const key of keys.flat()) { values.delete(key); hashes.delete(key); deadlines.delete(key) } },
  async hSet (key, field, value) { const hash = hashes.get(key) || {}; if (typeof field === 'object') Object.assign(hash, field); else hash[field] = String(value); hashes.set(key, hash) },
  async hGetAll (key) { expired(key); return hashes.get(key) || {} },
  async keys (pattern) { const re = new RegExp('^' + pattern.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'); return [...values.keys(), ...hashes.keys()].filter(k => re.test(k)) },
  async ttl (key) { expired(key); return values.has(key) ? deadlines.has(key) ? Math.ceil((deadlines.get(key) - clock) / 1000) : -1 : -2 },
  async incr (key) { const v = Number(values.get(key) || 0) + 1; values.set(key, String(v)); return v },
  async decr (key) { const v = Number(values.get(key) || 0) - 1; values.set(key, String(v)); return v },
  async expire (key, seconds) { deadlines.set(key, clock + seconds * 1000) }
}
process.on('uncaughtException', e => { real.writeFileSync(path.join(out, label + '.fatal.txt'), String(e.stack || e)); process.exit(1) })
process.on('unhandledRejection', e => { real.writeFileSync(path.join(out, label + '.fatal.txt'), String(e?.stack || e)); process.exit(1) })
const errors = new Map()
const noteError = (...args) => { const text = args.map(x => x?.stack || String(x)).join(' ').slice(0, 1400); errors.set(text, (errors.get(text) || 0) + 1) }
console.log = (...args) => { if (args.some(x => /异常|失败|error/i.test(String(x)))) noteError(...args) }
global.logger = { error: noteError, warn: noteError, info () {}, mark () {}, debug () {} }
global.segment = { at: qq => ({ type: 'at', qq }), image: x => x }
let notifications = 0
global.Bot = { pickGroup: () => ({ sendMsg: async () => { notifications++ }, pickMember: () => ({ info: {} }) }) }

const events = []; const tags = {}; const deaths = []; const births = []; let observing = false
global.__simDeath = (p, reason, t) => { if (!observing) return; deaths.push({ minute: Math.round((clock-start)/60000), name: p.name, level: p.level, pos: p.pos, sect: p.sect, reason, tag: String(reason).match(/【([^】]+)】/)?.[1] || String(reason), caller: (new Error().stack.split('\n')[3] || '').trim() }) }
global.__simBirth = (f, name, kind) => { if (!observing || f.roster[name]) return; births.push({ minute: Math.round((clock-start)/60000), name, kind, caller: (new Error().stack.split('\n')[3] || '').trim() }) }
const important = new Set(['结盟', '断交', '议和', '开宗', '灭门', '夺权', '退位', '叛宗', '叛逃', '复仇', '回防', '撤兵'])
global.__simObserve = (f, type, txt, t, opts) => {
  if (!observing || opts.onlyPerson) return
  const tag = String(txt).match(/【([^】]+)】/)?.[1] || type
  tags[tag] = (tags[tag] || 0) + 1
  if (important.has(tag)) events.push({ minute: Math.round((clock - start) / 60000), t, tag, type, text: txt })
}
const fake = await import('./components/fake_data.js')
const world = await import('./components/world_data.js')
const war = await import('./components/sect/war.js')
const { npcCanAct } = await import('./components/npc_action.js')
const { flushDeferredSaves } = await import('./components/deferred_save.js')
const gid = `autoworld_${seed}`
const f = fake.getFake(gid)
const w = world.getWorld(gid)
// Cache only roster enumeration, never prices/quantities/power. Objects remain live.
const nativeObjectValues = Object.values
let moneyRoster = null, moneyTotal = 0, moneyDirty = true, integerMoney = true
const trackedMoney = new WeakSet()
function rebuildMoney () {
  moneyTotal = 0; integerMoney = true; moneyRoster = f.roster
  for (const actor of nativeObjectValues(f.roster)) {
    if (!actor || typeof actor !== 'object') continue
    if (actor.alive) { moneyTotal += Number(actor.money) || 0; if (!Number.isSafeInteger(Number(actor.money) || 0)) integerMoney = false }
    if (trackedMoney.has(actor)) continue
    trackedMoney.add(actor)
    let value = actor.money, alive = actor.alive
    const contribution = () => alive ? Number(value) || 0 : 0
    Object.defineProperty(actor, 'money', { enumerable: true, configurable: true, get: () => value, set: next => {
      const previous = contribution(); value = next
      if (!Number.isSafeInteger(Number(value) || 0)) integerMoney = false
      if (moneyRoster === f.roster && f.roster[actor.name] === actor) moneyTotal += contribution() - previous
      else moneyDirty = true
    } })
    Object.defineProperty(actor, 'alive', { enumerable: true, configurable: true, get: () => alive, set: next => {
      const previous = contribution(); alive = next; moneyTotal += contribution() - previous
    } })
  }
  moneyDirty = false
}
globalThis.__simTotalMoney = state => {
  if (state !== f) return nativeObjectValues(state?.roster || {}).reduce((n,p)=>p?.alive?n+(Number(p.money)||0):n,0)
  if (moneyDirty || moneyRoster !== f.roster) rebuildMoney()
  if (!integerMoney || !Number.isSafeInteger(moneyTotal)) return nativeObjectValues(f.roster).reduce((n,p)=>p?.alive?n+(Number(p.money)||0):n,0)
  return moneyTotal
}

let rosterObject = null, rosterEntries = null
let enumerationHits = 0, enumerationMisses = 0
globalThis.__simRosterChanged = () => { rosterEntries = null; moneyDirty = true }
Object.values = object => {
  if (object !== f.roster) return nativeObjectValues(object)
  if (object !== rosterObject || !rosterEntries) {
    rosterObject = object; rosterEntries = nativeObjectValues(object); enumerationMisses++
  } else enumerationHits++
  return rosterEntries.slice() // Fresh array, same order, same live actor references.
}

if (Object.keys(f.players || {}).length || Object.values(f.sects).some(s => s.owner)) throw new Error('fresh world unexpectedly has players')
const originalCohort = new Map(Object.values(f.roster).filter(p => p.alive).map(p => [p.name, p.lifeAt ?? p.joinAt ?? 0]))
const areas = Object.values(world.REGIONS).flatMap(r => r.areas)
const battles = new Map(); const knownNames = {}; const snapshots = []; const breaches = []; let mapChanges = 0; let previousOwners = { ...f.areas }
function capture (minute) {
  const counts = {}; const members = {}
  for (const sid of Object.values(f.areas)) if (sid) counts[sid] = (counts[sid] || 0) + 1
  for (const p of Object.values(f.roster)) if (p.alive && p.sect) members[p.sect] = (members[p.sect] || 0) + 1
  const factions = Object.entries(f.sects).map(([id, s]) => {
    knownNames[id] = s.name
    return { id, name: s.name, capacity: fake.sectCap(f, id), facilities: { ...s.facilities }, land: counts[id] || 0, members: members[id] || 0, money: Math.round(s.vault?.stones || 0), power: fake.sectPower(f, id), allies: [...(s.allies || [])], enemies: [...(s.enemies || [])], wiped: !!s.wipeAt }
  })
  const living = Object.values(f.roster).filter(p => p.alive)
  const levels = living.map(p => p.level || 0).sort((a, b) => a - b)
  const growth = { meanLevel: levels.reduce((a,b)=>a+b,0) / Math.max(1,levels.length), medianLevel: levels[Math.floor(levels.length / 2)] || 0, maxLevel: levels.at(-1) || 0, originalSurvivors: living.filter(p => originalCohort.get(p.name) === (p.lifeAt ?? p.joinAt ?? 0)).length }
  snapshots.push({ minute, growth, alive: Object.values(f.roster).filter(p => p.alive).length, factions, owners: areas.map(a => f.areas[a] || null), contradictoryRelations: factions.flatMap(s => s.allies.filter(id => s.enemies.includes(id)).map(id => [s.id,id])), ongoing: f.sectAttacks.filter(a => a.phase !== 'done').length, population: Object.keys(f.roster).length })
}
capture(0); observing = true
const wall = performance.now()
const totalMinutes = Math.round(hours * 60)
for (let minute = 1; minute <= totalMinutes; minute++) {
  clock = start + minute * 60000
  if (world.dueSettle(w)) world.settleEconomy(w, name => { const sid = Object.keys(f.sects).find(id => f.sects[id].name === name); return !sid || !f.sects[sid].wipeAt })
  await fake.fakeTick(gid)
  for (const a of f.sectAttacks) {
    if (!battles.has(a.id)) {
      const view = structuredClone(a)
      const pa = await war.computeAtkPower(f, gid, view); const pd = await war.computeDefPower(f, gid, view)
      battles.set(a.id, { id: a.id, start: Math.round((a.start - start) / 60000), atk: a.atkSect, def: a.defSect, target: a.target, targetType: a.targetType, actualPower: pa, initialDefense: pd, actualCount: a.atkFakes.length, tactic: a.kind, snapshot: structuredClone(a.snapshot) })
    }
    const b = battles.get(a.id)
    if (a.phase === 'done' && !b.result) Object.assign(b, { result: a.result, end: minute, rounds: a.round, loot: a.loot || 0, reason: (a.log || []).at(-1)?.txt || '' })
  }
  for (const area of areas) if ((previousOwners[area] || null) !== (f.areas[area] || null)) mapChanges++
  previousOwners = { ...f.areas }
  // Cheap invariants; capture the first occurrence of each failure.
  if (minute % 10 === 0) {
    const owners = new Set()
    for (const a of f.sectAttacks.filter(a => a.phase !== 'done')) for (const name of [...a.atkFakes, ...a.defFakes]) {
      if (owners.has(name) && breaches.length < 30) breaches.push({ minute, type: 'duplicate-army', name }); owners.add(name)
    }
    for (const id of Object.keys(f.sects)) {
      const members = fake.sectAlive(f, id)
      if (members.length > fake.sectCap(f, id) && members.some(p => npcCanAct(f, p, clock) && !['zongzhu','fuzong','taishang'].includes(p.pos)) && breaches.length < 30) breaches.push({ minute, type: 'unsettled-overcapacity', id })
    }
    for (const [id, s] of Object.entries(f.sects)) if ((s.vault?.stones || 0) < 0 && breaches.length < 30) breaches.push({ minute, type: 'negative-vault', id })
    if (minute % 60 === 0) capture(minute)
  }
  if (minute % 3 === 0) flushDeferredSaves()
  if (minute % 1440 === 0) real.writeFileSync(path.join(out, label + '.partial.json'), JSON.stringify({ hour: minute/60, snapshots, deaths: deaths.length, births: births.length, errors: [...errors], breaches }))
  if (minute % 360 === 0) process.stdout.write(JSON.stringify({ progress: label, hour: minute / 60, seconds: Math.round((performance.now() - wall) / 1000), battles: battles.size, factions: Object.keys(f.sects).length, people: Object.values(f.roster).filter(p => p.alive).length }) + '\n')
}
if (snapshots.at(-1).minute !== totalMinutes) capture(totalMinutes)
observing = false
const records = [...battles.values()]
const summary = {
  seed, hours, mode, deaths: deaths.length, births: births.length, deathCauses: Object.fromEntries([...new Set(deaths.map(x=>x.tag))].map(tag=>[tag,deaths.filter(x=>x.tag===tag).length])), elapsedSeconds: Math.round((performance.now() - wall) / 1000),
  initialFactions: snapshots[0].factions.length, finalFactions: snapshots.at(-1).factions.length, initialPeople: snapshots[0].alive, finalPeople: snapshots.at(-1).alive,
  wars: records.length, areaWars: records.filter(b => b.targetType === 'area').length, headquartersWars: records.filter(b => b.targetType === 'sect').length,
  won: records.filter(b => b.result === 'win').length, lost: records.filter(b => b.result === 'lose').length, peace: records.filter(b => b.result === 'peace').length, abort: records.filter(b => b.result === 'abort').length,
  pending: records.filter(b => !b.result).length, mapChanges, tags, errors: [...errors].map(([text, count]) => ({ text, count })), breaches, notifications,
  lowStrengthStarts: records.filter(b => b.initialDefense > 0 && b.actualPower < b.initialDefense * 0.85).map(b => ({ id: b.id, ratio: +(b.actualPower / b.initialDefense).toFixed(3), result: b.result, targetType: b.targetType })),
  finalLeaders: snapshots.at(-1).factions.slice().sort((a,b) => b.land-a.land).slice(0,5)
}
const result = { metadata: { seed, hours, mode, start, stepMinutes: 1, gameplay: 'same gameplay with exact roster enumeration cache and bounded 32-bit simulation RNG', enumerationHits, enumerationMisses, adapters: 'in-memory atomic JSON and Redis; event-only observer; deterministic time/random', excludes: 'no real players, no player-triggered actions, no public/private realms without enabled whitelist', cadence: mode === 'develop' ? 'AI 4h cooldown and postwar development/rest' : mode, initialPrelude: 'existing new-save 3-hour history prelude, excluded from counters' }, summary, areas, knownNames, snapshots, events, deaths, births, battles: records }
real.writeFileSync(path.join(out, label + '.json'), JSON.stringify(result, null, 2))
process.stdout.write(JSON.stringify({ complete: label, summary }) + '\n')
