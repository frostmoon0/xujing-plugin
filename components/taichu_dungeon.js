import { randomUUID } from 'node:crypto'
import { isTaichuEnabled } from './taichu_equipment.js'

export const TAICHU_ENTRY_COST = Object.freeze({ normal: 20000, hard: 50000, extreme: 100000 })
export const TAICHU_DIFFICULTIES = Object.freeze({
  normal: { name: '普通', power: 65000, reward: 1 },
  hard: { name: '困难', power: 150000, reward: 2 },
  extreme: { name: '绝境', power: 300000, reward: 3 }
})
export const TAICHU_ROUTES = Object.freeze({ forge: '铸兵', soul: '镇魂', tide: '沧溟' })
const STAGES = ['route', 'array', 'array', 'array', 'guardian', 'guardian', 'guardian', 'remnant', 'remnant', 'remnant', 'array', 'array', 'guardian', 'guardian', 'boss', 'boss', 'boss', 'boss']
const ELEMENTS = { wood: '青木', fire: '赤火', water: '玄水' }
const THREATS = { shield: ['护盾', 'break'], charge: ['蓄力', 'interrupt'], summon: ['召唤', 'attack'], mark: ['标记', 'guard'] }
const PART_LOOT = {
  forge: [['断界', '断界刃胚'], ['承天', '承天残纹']],
  soul: [['镇神', '镇神骨'], ['寂轮', '寂轮心核']],
  tide: [['无相', '无相丝'], ['踏虚', '踏虚晶核']]
}
const ORDINARY = { forge: ['凤羽玉', '月魄石', '天衍阵纹'], soul: ['镇魂晶', '幽冥木', '乾坤阵晶'], tide: ['海眼寒铁', '织云石', '流光玉'] }
const enabled = options => options?.enabled ?? isTaichuEnabled()
const bounded = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0))
const pick = (arr, rng) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(rng() * arr.length)))]
const add = (items, name, count) => { if (count > 0) items[name] = (items[name] || 0) + count }

function makeNode (step, rng = Math.random, route = 'forge') {
  const kind = STAGES[step]
  if (kind === 'route') return { kind, hint: '队长选择的路线决定镇守和最终战能力；所有队员行动后出发。' }
  if (kind === 'array') {
    const answer = pick(Object.keys(ELEMENTS), rng)
    return { kind, answer, hint: `石碑写明：先断${ELEMENTS[answer]}供能，余纹自息。请按线索选择供能。` }
  }
  if (kind === 'remnant') return { kind, hint: '搜索会消耗精力；休整消耗本趟补给；封存可在败退时保留材料。' }
  const offset = route === 'soul' ? 1 : route === 'tide' ? 2 : 0
  const threat = Object.keys(THREATS)[((kind === 'boss' ? step - 14 : step - 4) + offset) % 4]
  return { kind, threat, hint: `${kind === 'boss' ? '太初殿' : '分殿镇守'}：敌人正在${THREATS[threat][0]}，需${({ break: '破盾', interrupt: '打断', attack: '清除召唤物', guard: '护持标记' })[THREATS[threat][1]]}。` }
}

export function createTaichuRun (input, options = {}) {
  if (!enabled(options)) throw new Error('太初古墟尚未开放')
  const difficulty = input?.difficulty || 'normal'
  if (!TAICHU_DIFFICULTIES[difficulty]) throw new Error('未知难度')
  if (!Array.isArray(input?.members) || input.members.length < 1 || input.members.length > 3) throw new Error('队伍人数必须为1～3人')
  const members = {}
  for (const raw of input.members) {
    const id = String(raw.id || '')
    if (!id || members[id]) throw new Error('队伍成员重复或缺少身份')
    members[id] = { id, name: String(raw.name || id), kind: raw.kind === 'fake' ? 'fake' : 'player', power: Math.max(0, Number(raw.power) || 0), energy: 100, supplies: 4, loot: {}, sealed: {}, treasure: 0 }
  }
  const leader = String(input.leader || '')
  if (!members[leader]) throw new Error('队长必须在队伍中')
  const now = Number(input.now) || Date.now()
  return { version: 1, id: randomUUID(), gid: String(input.gid), leader, members, difficulty, phase: 'active', step: 0, node: makeNode(0), votes: {}, route: null, instability: 0, resolve: 6, bossDamage: 0, dingxuUsed: false, startedAt: now, expiresAt: now + 6 * 3600000, updatedAt: now, log: [], settlements: {}, claimed: {} }
}

export function taichuRunActive (run, now = Date.now()) { return run?.phase === 'active' && now < run.expiresAt }

export function joinTaichuRun (run, raw, options = {}) {
  if (!enabled(options)) return { ok: false, message: '太初古墟尚未开放' }
  if (!taichuRunActive(run, options.now ?? Date.now()) || run.step !== 0 || Object.keys(run.votes).length) return { ok: false, message: '队伍已经出发，不能加入' }
  const id = String(raw.id || '')
  if (!id || run.members[id] || Object.keys(run.members).length >= 3) return { ok: false, message: '已在队伍中或队伍已满' }
  run.members[id] = { id, name: String(raw.name || id), kind: raw.kind === 'fake' ? 'fake' : 'player', power: Math.max(0, Number(raw.power) || 0), energy: 100, supplies: 4, loot: {}, sealed: {}, treasure: 0 }
  return { ok: true, message: '加入古墟队伍，尚未出发' }
}

export function taichuChoices (run) {
  if (run?.phase !== 'active') return []
  switch (run.node?.kind) {
    case 'route': return Object.entries(TAICHU_ROUTES).map(([key, label]) => ({ key, label }))
    case 'array': return [...Object.entries(ELEMENTS).map(([key, label]) => ({ key: `disarm:${key}`, label: `拆解${label}` })), { key: 'suppress', label: '耗材镇压' }, { key: 'force', label: '强破' }]
    case 'remnant': return [{ key: 'search', label: '搜索' }, { key: 'rest', label: '休整' }, { key: 'seal', label: '封存' }, { key: 'leave', label: '撤离' }]
    default: return [{ key: 'attack', label: '攻击' }, { key: 'break', label: '破盾' }, { key: 'interrupt', label: '打断' }, { key: 'guard', label: '护持' }]
  }
}

function mistake (run, votes) {
  if (!run.dingxuUsed && votes.some(v => v.setCount >= 6)) {
    run.dingxuUsed = true
    return '定墟抵消了一次失控。'
  }
  run.instability++
  run.resolve--
  return '失控＋1，队伍稳定度－1。'
}

function ordinaryLoot (run, member, rng, multiplier = 1) {
  const base = TAICHU_DIFFICULTIES[run.difficulty].reward * multiplier
  const count = Math.max(1, Math.floor(base * (1 + bounded(member.treasure, 0, 0.25))))
  add(member.loot, pick(ORDINARY[run.route] || ORDINARY.forge, rng), count)
}

function resolveRound (run, rng) {
  const votes = Object.values(run.votes)
  const kind = run.node.kind
  const messages = []
  if (kind === 'route') {
    run.route = run.votes[run.leader].action
    messages.push(`队伍进入${TAICHU_ROUTES[run.route]}路线。`)
  } else if (kind === 'array') {
    if (votes.some(v => v.action === 'force' || (v.action.startsWith('disarm:') && v.action !== `disarm:${run.node.answer}`))) messages.push(mistake(run, votes))
    else messages.push('阵纹拆解成功，保留了稳定度。')
    for (const member of Object.values(run.members)) ordinaryLoot(run, member, rng)
  } else if (kind === 'remnant') {
    for (const v of votes) {
      const member = run.members[v.id]
      if (v.action === 'search') ordinaryLoot(run, member, rng, 4)
      if (v.action === 'seal') {
        let capacity = v.setCount >= 4 ? 12 : 10
        for (const [name, count] of Object.entries(member.loot)) {
          const take = Math.min(count, capacity)
          add(member.sealed, name, take)
          member.loot[name] -= take
          if (!member.loot[name]) delete member.loot[name]
          capacity -= take
          if (!capacity) break
        }
      }
    }
    if (votes.some(v => v.action === 'leave')) { run.phase = 'left'; messages.push('队伍提前撤离，未封存材料遗失。') }
    else messages.push('残殿处置完成。')
  } else {
    const needed = THREATS[run.node.threat][1]
    const countered = votes.some(v => v.action === needed)
    const enemy = TAICHU_DIFFICULTIES[run.difficulty].power * votes.length * (1 + run.instability * 0.06)
    const strength = votes.reduce((sum, v) => sum + v.power, 0) / enemy
    const damage = votes.reduce((sum, v) => sum + (v.action === 'attack' ? 1 : v.action === needed ? 0.8 : 0.25) * (v.action === 'break' ? 1 + v.array : 1), 0) / votes.length
    if (!countered) messages.push(mistake(run, votes))
    if (strength < 0.55) { run.resolve--; messages.push('敌人过强，队伍稳定度－1。') }
    if (kind === 'boss') {
      run.bossDamage += Math.min(4, strength * damage * (countered ? 1 : 0.3))
      messages.push(`太初殿阶段${run.step - 13}/4，攻坚进度${Math.min(100, Math.round(run.bossDamage / 2.2 * 100))}%。`)
    } else {
      if (countered && strength >= 0.55) for (const member of Object.values(run.members)) ordinaryLoot(run, member, rng, 2)
      messages.push(countered ? '镇守机制已处理。' : '镇守机制未处理。')
    }
  }
  if (run.resolve <= 0) { run.phase = 'failed'; messages.push('队伍失去稳定，败退出古墟，未封存材料遗失。') }
  if (run.phase === 'active') {
    run.step++
    if (run.step >= STAGES.length) {
      run.phase = run.bossDamage >= 2.2 ? 'cleared' : 'failed'
      messages.push(run.phase === 'cleared' ? '太初古墟通关，全部战利品可领取。' : '太初殿攻坚不足，败退，仅保留封存材料。')
      if (run.phase === 'cleared') {
        // 核心抽取结果在通关时固定，之后读面板和领奖都不会重掷。
        run.coreDrop = pick(PART_LOOT[run.route], rng)
      }
    } else run.node = makeNode(run.step, rng, run.route)
  }
  run.votes = {}
  return messages.join('\n')
}

export function actTaichuRun (run, actorId, action, actor = {}, options = {}) {
  if (!enabled(options)) return { ok: false, message: '太初古墟尚未开放', wear: 0 }
  const now = options.now ?? Date.now()
  if (run?.phase === 'active' && now >= run.expiresAt) { run.phase = 'failed'; run.updatedAt = now }
  if (!taichuRunActive(run, now)) return { ok: false, message: '本趟古墟已结束，请领取结算', wear: 0 }
  const id = String(actorId), member = run.members[id]
  if (!member) return { ok: false, message: '你不在本趟队伍中', wear: 0 }
  if (run.votes[id]) return { ok: false, message: '本轮已行动，等待队友', wear: 0 }
  if (!taichuChoices(run).some(choice => choice.key === action)) return { ok: false, message: '无效选择，请查看古墟进度', wear: 0 }
  const bonuses = actor.bonuses || {}
  const kind = run.node.kind
  let cost = kind === 'route' ? 0 : kind === 'array' ? (action === 'force' ? 4 : 10) : kind === 'remnant' ? (action === 'search' ? 8 : 0) : action === 'guard' ? 3 : 6
  if (kind === 'array' && action.startsWith('disarm:')) cost = Math.max(1, Math.ceil(cost * (1 - bounded(bonuses.lightness, 0, 0.25))))
  const consume = {}
  if (action === 'suppress') consume['天衍阵纹'] = Math.max(1, Math.ceil(4 * (1 - bounded(bonuses.seal, 0, 0.25))))
  for (const [name, count] of Object.entries(consume)) if ((Number(actor.materials?.[name]) || 0) < count) return { ok: false, message: `镇压需要${name}×${count}`, wear: 0 }
  if (member.energy < cost) return { ok: false, message: '精力不足；可在残殿休整，或使用补给行动', wear: 0 }
  if (action === 'rest' && member.supplies < 1) return { ok: false, message: '本趟补给已耗尽', wear: 0 }
  member.energy -= cost
  if (action === 'rest') { member.supplies--; member.energy = Math.min(100, member.energy + 30) }
  member.power = Math.max(0, Number(actor.power ?? member.power) || 0)
  member.treasure = bounded(bonuses.treasure, 0, 0.25)
  const wear = kind === 'route' || kind === 'remnant' ? 0 : kind === 'array' && action === 'force' ? 10 : 6
  run.votes[id] = { id, action, power: member.power, array: bounded(bonuses.array, 0, 0.5), setCount: bounded(bonuses.setCount, 0, 6) }
  run.updatedAt = now
  let message = `${member.name}已行动，精力${member.energy}/100，补给${member.supplies}。`
  if (Object.keys(run.votes).length === Object.keys(run.members).length) message += `\n${resolveRound(run, options.rng || Math.random)}`
  else message += '\n等待其他队员行动。'
  run.log.push({ t: now, actor: id, action, message })
  if (run.log.length > 80) run.log.splice(0, run.log.length - 80)
  return { ok: true, message, wear: wear + (run.phase === 'failed' ? 15 : 0), consume }
}

export function supplyTaichuRun (run, id, options = {}) {
  if (!enabled(options) || !taichuRunActive(run, options.now ?? Date.now())) return { ok: false, message: '古墟未开放或本趟已结束' }
  const member = run.members[String(id)]
  if (!member || run.votes[String(id)]) return { ok: false, message: '不在队伍中或本轮已行动' }
  if (member.supplies < 1 || member.energy >= 100) return { ok: false, message: '没有补给或精力已满' }
  member.supplies--
  member.energy = Math.min(100, member.energy + 30)
  return { ok: true, message: `使用本趟补给，精力${member.energy}/100，补给剩余${member.supplies}` }
}

export function retreatTaichuRun (run, id, options = {}) {
  if (!enabled(options) || !taichuRunActive(run, options.now ?? Date.now()) || !run.members[String(id)]) return { ok: false, message: '无法撤离' }
  // 任一成员可要求全队安全退出；未封存材料仍按规则遗失。
  run.phase = 'left'
  run.updatedAt = options.now ?? Date.now()
  return { ok: true, message: '全队撤离，仅保留已封存材料' }
}

export function taichuWeek (now = Date.now()) {
  const date = new Date(now + 8 * 3600000)
  const day = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - day)
  return date.toISOString().slice(0, 10)
}

export function getTaichuSettlement (run, actorId, ledger = {}, now = Date.now(), options = {}) {
  if (!enabled(options) || !run || run.phase === 'active') return null
  const id = String(actorId), member = run.members[id]
  if (!member) return null
  run.settlements ||= {}
  if (run.settlements[id]) return structuredClone(run.settlements[id])
  const week = taichuWeek(now)
  let previous = ledger[id]
  if (!previous || previous.week !== week) previous = ledger[id] = { week, coreCount: 0, receipts: {}, pending: {} }
  previous.pending ||= {}
  // 计划生成时预留额度，防止同一成员多个已结束队伍同时预览后超领。
  const pending = Object.values(previous.pending).filter(value => value === week).length
  const coreEligible = run.phase === 'cleared' && previous.coreCount + pending < 2
  const items = { ...member.sealed }
  if (run.phase === 'cleared') for (const [name, count] of Object.entries(member.loot)) add(items, name, count)
  if (coreEligible && run.coreDrop) {
    add(items, '太初印', 1)
    add(items, `${run.coreDrop[0]}图谱碎片`, 2 * TAICHU_DIFFICULTIES[run.difficulty].reward)
    add(items, run.coreDrop[1], 1)
    if (run.difficulty !== 'normal') add(items, `${run.coreDrop[1]}碎片`, TAICHU_DIFFICULTIES[run.difficulty].reward)
  }
  if (coreEligible) previous.pending[run.id] = week
  const result = { receipt: `taichu:${run.id}:${id}`, items, route: run.phase === 'cleared' ? run.route : null, coreEligible, week, phase: run.phase }
  run.settlements[id] = result
  return structuredClone(result)
}

export function commitTaichuSettlement (run, actorId, ledger = {}, now = Date.now(), options = {}) {
  if (!enabled(options)) return false
  const id = String(actorId), result = getTaichuSettlement(run, id, ledger, now, options)
  if (!result) return false
  run.claimed ||= {}
  if (run.claimed[id] || ledger[id]?.receipts?.[run.id]) return false
  let entry = ledger[id]
  if (!entry) entry = ledger[id] = { week: result.week, coreCount: 0, receipts: {} }
  entry.receipts ||= {}
  entry.pending ||= {}
  if (result.coreEligible && entry.week === result.week) entry.coreCount++
  delete entry.pending[run.id]
  entry.receipts[run.id] = result.receipt
  run.claimed[id] = result.receipt
  return true
}

export function findPlayerTaichuRun (store, actorId, { includeEnded = false, now = Date.now() } = {}) {
  const id = String(actorId)
  for (const run of Object.values(store?.runs || {})) {
    if (run?.members?.[id] && run.phase === 'active' && now >= run.expiresAt) { run.phase = 'failed'; run.updatedAt = now; run.votes = {} }
  }
  const runs = Object.values(store?.runs || {}).filter(run => run?.members?.[id] && (run.phase === 'active' || (includeEnded && !run.claimed?.[id])))
  return runs.sort((a, b) => (Number(b.phase === 'active') - Number(a.phase === 'active')) || b.startedAt - a.startedAt)[0] || null
}

export function taichuRunView (run) {
  if (!run) return '暂无太初古墟队伍'
  const rows = [`太初古墟｜${TAICHU_DIFFICULTIES[run.difficulty]?.name || run.difficulty}｜${TAICHU_ROUTES[run.route] || '待择路'}`, `进度${Math.min(18, run.step + 1)}/18｜${({ active: '探索中', cleared: '已通关', failed: '已败退', left: '已撤离' })[run.phase]}`, `失控${run.instability}｜稳定度${run.resolve}/6｜定墟${run.dingxuUsed ? '已用' : '未用'}`]
  for (const member of Object.values(run.members)) rows.push(`${member.name}：精力${member.energy}，补给${member.supplies}${run.votes[member.id] ? '，已行动' : ''}`)
  if (run.phase === 'active') rows.push(run.node.hint, ...taichuChoices(run).map((choice, index) => `${index + 1}. ${choice.label}`))
  else rows.push('本趟结束，请领取古墟结算。')
  return rows.join('\n')
}
