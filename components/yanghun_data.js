import { withGameLock } from './game_lock.js'
import fs from 'fs'
import path from 'path'
import { Save_Path } from './plugin.js'
import xujing_data from './xujing_data.js'
import { getBag, saveBag, itemIcon } from './equip_data.js'
import Wanhun from './wanhun_data.js'

const SAVE_DIR = path.join(Save_Path, 'yanghun')
const HOUR = 60 * 60 * 1000
const FEE = 10000
const MAX_LEVEL = 10

/** 运行费用按阶级递增：一至十阶启动及每小时各 1万、2万……10万 灵石 */
function feeOf (level) {
  return FEE * Math.max(1, Math.floor(Number(level) || 1))
}
const BASE_COST = {
  '万阵核心': 1,
  '无主幽魂': 1,
  '万魂帝晶': 5,
  '阴魂砂': 20,
  '游魂骨': 20,
  '鬼火草': 10,
  '幽冥木': 10
}
/** 升级倍率：升至目标等级时按此倍数放大一阶基准材料（不含万阵核心），即 2×(目标等级-1) */
const UPGRADE_SCALE = {
  2: 2,
  3: 4,
  4: 6,
  5: 8,
  6: 10,
  7: 12,
  8: 14,
  9: 16,
  10: 18
}

function ensureDir () {
  if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true })
}

/** 后台仅结算真实群号的独立存档，全局兼容档仍可按需读取。 */
export function activeYanghunGroups () {
  try {
    if (!fs.existsSync(SAVE_DIR)) return []
    return fs.readdirSync(SAVE_DIR, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^yanghun_\d+\.json$/.test(entry.name))
      .map(entry => entry.name.slice('yanghun_'.length, -'.json'.length))
  } catch (err) { return [] }
}

function fileOf (gid) {
  return path.join(SAVE_DIR, `yanghun_${String(gid || 'global')}.json`)
}

function emptyGroup (gid) {
  return { gid: String(gid || 'global'), users: {} }
}

function readGroup (gid) {
  ensureDir()
  const file = fileOf(gid)
  let data = emptyGroup(gid)
  try {
    if (fs.existsSync(file)) data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    data = emptyGroup(gid)
  }
  if (!data.users || typeof data.users !== 'object') data.users = {}
  return data
}

function saveGroup (gid, data) {
  ensureDir()
  const file = fileOf(gid)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(data, null, '\t'))
  fs.renameSync(temp, file)
}

function normalizeState (state) {
  if (!state || typeof state !== 'object') return null
  state.level = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number(state.level) || 1)))
  state.running = state.running === true
  state.progressMs = Math.max(0, Math.min(HOUR - 1, Math.floor(Number(state.progressMs) || 0)))
  state.lastRunAt = Math.max(0, Number(state.lastRunAt) || 0)
  state.createdAt = Math.max(0, Number(state.createdAt) || 0)
  if (!state.createdAt) state.createdAt = Date.now()
  if (state.running && !state.lastRunAt) state.lastRunAt = state.createdAt
  return state
}

function stateOf (gid, uid, create = false) {
  const data = readGroup(gid)
  const key = String(uid)
  const state = normalizeState(data.users[key])
  if (state) {
    data.users[key] = state
    return { data, state }
  }
  if (!create) return { data, state: null }
  const fresh = normalizeState({ level: 1, running: false, progressMs: 0, lastRunAt: 0, createdAt: Date.now() })
  data.users[key] = fresh
  return { data, state: fresh }
}

function withLock (uid, gid, fn) { return withGameLock(gid, fn) }

function countOf (bag, name) {
  return Number(bag.items?.[name]?.count) || 0
}

function scaledCost (level) {
  const scale = UPGRADE_SCALE[Math.max(2, Math.floor(Number(level) || 1))] ?? 1
  return Object.fromEntries(Object.entries(BASE_COST)
    .filter(([name]) => name !== '万阵核心')
    .map(([name, count]) => [name, count * scale]))
}

function hasCost (bag, cost) {
  return Object.entries(cost).every(([name, count]) => countOf(bag, name) >= count)
}

function takeCost (bag, cost) {
  for (const [name, count] of Object.entries(cost)) {
    const item = bag.items[name]
    item.count -= count
    if (item.count <= 0) delete bag.items[name]
  }
}

function fmtCost (cost) {
  return Object.entries(cost).map(([name, count]) => `${itemIcon(name)}${name}×${count}`).join('、')
}

function formatRemain (ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000)
  const seconds = Math.floor((Math.max(0, ms) % 60000) / 1000)
  return `${minutes}分${seconds}秒`
}

function formatTime (timestamp) {
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  } catch (err) {
    return '稍后'
  }
}

async function homeOf (uid, gid) {
  const filename = `${gid}.json`
  const home = await xujing_data.getQQYUserHome(uid, null, filename, false)
  if (!home[uid]) home[uid] = { money: 0, karma: 0 }
  return { home, user: home[uid], filename }
}

function storeSoul (uid, gid, amount) {
  const bag = getBag(uid, gid)
  const artifact = bag.artifacts?.wanhun
  if (!artifact || artifact.equipped !== true) return 0
  const capacity = Wanhun.capacity(artifact.rank)
  const current = Math.max(0, Number(artifact.souls) || 0)
  const stored = Math.max(0, Math.min(Math.floor(Number(amount) || 0), capacity - current))
  if (!stored) return 0
  artifact.souls = current + stored
  artifact.totalSouls = (Number(artifact.totalSouls) || 0) + stored
  saveBag(uid, bag, gid)
  return stored
}

/** 结算正在运行的阵法；每个完整小时独立扣费，费用不足则静默暂停并丢弃未支付进度。 */
async function settleUnlocked (uid, gid, at = Date.now()) {
  const { data, state } = stateOf(gid, uid, false)
  if (!state || !state.running) return { state, hours: 0, stored: 0, paused: false }
  const start = Number(state.lastRunAt) || at
  const elapsed = Math.max(0, state.progressMs + Math.max(0, at - start))
  const hours = Math.floor(elapsed / HOUR)
  if (!hours) return { state, hours: 0, stored: 0, paused: false }

  const { home, user, filename } = await homeOf(uid, gid)
  const fee = feeOf(state.level)
  let paid = 0
  let stored = 0
  for (let i = 0; i < hours; i++) {
    if ((Number(user.money) || 0) < fee) break
    user.money = (Number(user.money) || 0) - fee
    paid++
    stored += storeSoul(uid, gid, state.level)
  }
  if (paid < hours) {
    /* 未支付的小时不形成欠费；已付部分结算，剩余未付进度清零并暂停。 */
    state.running = false
    state.progressMs = 0
    state.lastRunAt = 0
  } else {
    state.progressMs = elapsed - hours * HOUR
    state.lastRunAt = at
  }
  await xujing_data.getQQYUserHome(uid, home, filename, true)
  saveGroup(gid, data)
  return { state, hours: paid, stored, paused: paid < hours }
}

async function settle (uid, gid, at = Date.now()) {
  return withLock(uid, gid, () => settleUnlocked(uid, gid, at))
}

export const Yanghun = {
  HOUR,
  FEE,
  feeOf,
  MAX_LEVEL,
  BASE_COST,
  getState (uid, gid = 'global') {
    return stateOf(gid, uid, false).state
  },
  async build (uid, gid = 'global') {
    return withLock(uid, gid, async () => {
      const current = stateOf(gid, uid, false)
      if (current.state) return { ok: false, msg: '你已经布置了养魂阵，请勿重复布置。' }
      const bag = getBag(uid, gid)
      if (!hasCost(bag, BASE_COST)) return { ok: false, msg: `布置一阶养魂阵需要：${fmtCost(BASE_COST)}。` }
      takeCost(bag, BASE_COST)
      saveBag(uid, bag, gid)
      const data = current.data
      data.users[String(uid)] = normalizeState({ level: 1, running: false, progressMs: 0, lastRunAt: 0, createdAt: Date.now() })
      saveGroup(gid, data)
      return { ok: true, msg: `一阶养魂阵布置成功！当前处于停止状态。已消耗：${fmtCost(BASE_COST)}。请使用 #运行养魂阵 开始养魂。` }
    })
  },
  async upgrade (uid, gid = 'global') {
    return withLock(uid, gid, async () => {
      const current = stateOf(gid, uid, false)
      if (!current.state) return { ok: false, msg: '你还没有养魂阵，请先使用 #布置养魂阵。' }
      await settleUnlocked(uid, gid)
      const latest = stateOf(gid, uid, false)
      const state = latest.state
      if (!state) return { ok: false, msg: '养魂阵不存在。' }
      if (state.level >= MAX_LEVEL) return { ok: false, msg: '养魂阵已经达到最高十阶。' }
      const targetLevel = state.level + 1
      const cost = scaledCost(targetLevel)
      const bag = getBag(uid, gid)
      if (!hasCost(bag, cost)) return { ok: false, msg: `养魂阵升至${targetLevel}阶需要：${fmtCost(cost)}。` }
      takeCost(bag, cost)
      saveBag(uid, bag, gid)
      state.level = targetLevel
      latest.data.users[String(uid)] = state
      saveGroup(gid, latest.data)
      return { ok: true, msg: `养魂阵已升级至${targetLevel}阶！每小时产出${targetLevel}魂。已消耗：${fmtCost(cost)}。` }
    })
  },
  async run (uid, gid = 'global') {
    return withLock(uid, gid, async () => {
      const current = stateOf(gid, uid, false)
      if (!current.state) return { ok: false, msg: '你还没有养魂阵，请先使用 #布置养魂阵。' }
      if (current.state.running) return { ok: false, msg: '养魂阵已经在运行中。' }
      const state = current.state
      const fee = feeOf(state.level)
      const { home, user, filename } = await homeOf(uid, gid)
      if ((Number(user.money) || 0) < fee) return { ok: false, msg: `运行养魂阵需要先支付${fee}灵石，你当前灵石不足。` }
      user.money = (Number(user.money) || 0) - fee
      state.running = true
      state.lastRunAt = Date.now()
      await xujing_data.getQQYUserHome(uid, home, filename, true)
      current.data.users[String(uid)] = state
      saveGroup(gid, current.data)
      return { ok: true, msg: `养魂阵已开始运行，立即消耗${fee}灵石。当前${state.level}阶，每小时产出${state.level}魂；运行满1小时后结算。` }
    })
  },
  async stop (uid, gid = 'global') {
    return withLock(uid, gid, async () => {
      const current = stateOf(gid, uid, false)
      if (!current.state) return { ok: false, msg: '你还没有养魂阵。' }
      if (!current.state.running) return { ok: false, msg: '养魂阵当前没有运行。' }
      const at = Date.now()
      const result = await settleUnlocked(uid, gid, at)
      const latest = stateOf(gid, uid, false)
      const state = latest.state
      if (!state.running) {
        if (result.paused) return { ok: true, msg: '养魂阵因灵石不足已暂停，未支付的时间不再累计。' }
        return { ok: false, msg: '养魂阵当前没有运行。' }
      }
      state.progressMs = Math.max(0, state.progressMs + at - state.lastRunAt)
      state.running = false
      state.lastRunAt = 0
      latest.data.users[String(uid)] = state
      saveGroup(gid, latest.data)
      return { ok: true, msg: `养魂阵已停止。本次结算${result.hours}小时，获得${result.stored}魂；未满一小时进度已保留（当前${formatRemain(state.progressMs)}）。` }
    })
  },
  async destroy (uid, gid = 'global') {
    return withLock(uid, gid, async () => {
      const current = stateOf(gid, uid, false)
      if (!current.state) return { ok: false, msg: '你还没有养魂阵。' }
      await settleUnlocked(uid, gid)
      const latest = stateOf(gid, uid, false)
      delete latest.data.users[String(uid)]
      saveGroup(gid, latest.data)
      return { ok: true, msg: '养魂阵已摧毁，已投入的材料和未满一小时进度不返还。' }
    })
  },
  async status (uid, gid = 'global') {
    await settle(uid, gid)
    const state = this.getState(uid, gid)
    if (!state) {
      return { state: null, text: '━━━🌀 养魂阵 ━━━\n尚未布置养魂阵（#布置养魂阵 建造）' }
    }
    const progress = state.running
      ? Math.max(0, state.progressMs + Date.now() - state.lastRunAt)
      : state.progressMs
    const remain = Math.max(0, HOUR - (progress % HOUR))
    const lines = [
      '━━━🌀 养魂阵 ━━━',
      `阵法：${state.level}阶养魂阵`,
      `状态：${state.running ? '运行中' : '已停止'}`,
      `效果：每小时产出${state.level}魂（需已装备万魂幡且有容量才能存入）`,
      `运行费用：启动及每小时各${feeOf(state.level)}灵石`
    ]
    if (state.running) {
      lines.push(`本次进度：${formatRemain(progress % HOUR)} / 60分钟`, `预计下次结算：${formatTime(Date.now() + remain)}`)
    } else {
      lines.push(`已保留进度：${formatRemain(progress)} / 60分钟`, '使用 #运行养魂阵 可继续运行')
    }
    lines.push('#停止养魂阵 暂停 · #升级养魂阵 提升 · #摧毁养魂阵 拆除')
    return { state, text: lines.join('\n') }
  },
  async settle (uid, gid = 'global', at = Date.now()) {
    return settle(uid, gid, at)
  },
  async settleAll (at = Date.now()) {
    ensureDir()
    let result = { groups: 0, users: 0 }
    for (const gid of activeYanghunGroups()) {
      const data = readGroup(gid)
      result.groups++
      for (const uid of Object.keys(data.users || {})) {
        result.users++
        try { await settle(uid, gid, at) } catch (err) { }
      }
    }
    return result
  },
  costFor (level) {
    return scaledCost(level)
  },
  statusText (uid, gid = 'global') {
    const state = this.getState(uid, gid)
    if (!state) return '━━━🌀 养魂阵 ━━━\n尚未布置养魂阵（#布置养魂阵 建造）'
    const progress = state.running
      ? Math.max(0, state.progressMs + Date.now() - state.lastRunAt)
      : state.progressMs
    const remain = Math.max(0, HOUR - (progress % HOUR))
    const lines = [
      '━━━🌀 养魂阵 ━━━',
      `阵法：${state.level}阶养魂阵`,
      `状态：${state.running ? '运行中' : '已停止'}`,
      `进度：${formatRemain(progress % HOUR)} / 60分钟`,
      state.running ? `下次结算：${formatRemain(remain)}` : '使用 #运行养魂阵 可继续运行'
    ]
    return lines.join('\n')
  }
}

export default Yanghun
