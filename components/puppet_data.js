import fs from 'fs'
import path from 'path'
import xujing_data from './xujing_data.js'
import { Plugin_Name, Save_Path } from './plugin.js'
import {
  getBag, saveBag, addItemToBag, consumeBagItem, itemIcon,
  getLearnedGongfa, isGongfaLearned
} from './equip_data.js'

export const PUPPET_TECHNIQUES = {
  '傀儡术下篇': { chapter: 'lower', minRank: 1, maxRank: 2, quality: 7, bound: true },
  '傀儡术中篇': { chapter: 'middle', minRank: 3, maxRank: 5, quality: 7, bound: true },
  '傀儡术上篇': { chapter: 'upper', minRank: 6, maxRank: 7, quality: 7, bound: true }
}

export const PUPPET_CHAPTERS = ['傀儡术下篇', '傀儡术中篇', '傀儡术上篇']
export const PUPPET_TECHNIQUE_FRAGMENT = '功法残卷'

/** 解析重复傀儡术分解指令，兼容“分解傀儡术下篇”和“分解傀儡术 傀儡术下篇”。 */
export function parsePuppetTechniqueDismantleCmd (msg) {
  const m = String(msg || '').trim().match(/^[#＃]?分解傀儡术\s*(?:傀儡术)?(下篇|中篇|上篇)(?:\s*(\d+))?$/)
  if (!m) return null
  return { name: `傀儡术${m[1]}`, amount: m[2] ? Math.max(1, Number(m[2]) || 1) : 1 }
}

/** 傀儡品质与功法篇章的解锁关系: 下篇1~2阶, 中篇3~5阶, 上篇6~7阶。 */
export const PUPPET_RANK_NAMES = ['', '一阶', '二阶', '三阶', '四阶', '五阶', '六阶', '七阶']
export const PUPPET_RANK_ICONS = ['', '⚪', '🟢', '🔵', '🟣', '🟡', '🔴', '🌈']

/** 一阶随机初始战力与每次升阶的随机增量。最终统一封顶7000。 */
export const PUPPET_POWER_RANGES = {
  1: [400, 800],
  2: [400, 600],
  3: [550, 750],
  4: [700, 900],
  5: [900, 1150],
  6: [1050, 1350],
  7: [1200, 1600]
}
export const PUPPET_MAX_POWER = 7000
/** 祭出后计入绝对战力的倍率；战力加成已翻倍（原1.5倍）。 */
export const PUPPET_POWER_MULTIPLIER = 3

/**
 * 一阶打造配方。万阵核心已是成品，因此只额外收取制作4个核心所需的四种阵材各4个，
 * 不重复收取制作这些核心时已经支付过的灵石。
 */
export const PUPPET_INITIAL_COST = {
  materials: {
    万阵核心: 5,
    天衍阵纹: 4,
    乾坤阵晶: 4,
    太虚阵砂: 4,
    九幽阵髓: 4,
    无主幽魂: 1,
    摄魂铁: 20,
    万魂帝晶: 1,
    造梦神玉: 1,
    一阶妖丹: 1
  },
  money: 500000
}

/** 升级配方按材料品质递进；key为升级后的阶位；每阶升级需对应阶数的妖丹×1。 */
export const PUPPET_UPGRADE_COSTS = {
  2: { materials: { 无主幽魂: 5, 摄魂铁: 50, 阴魂石: 30, 万阵核心: 5, 二阶妖丹: 1 }, money: 0 },
  3: { materials: { 无主幽魂: 8, 摄魂铁: 60, 阴魂石: 50, 玄阴玉: 30, 万阵核心: 5, 三阶妖丹: 1 }, money: 0 },
  4: { materials: { 无主幽魂: 12, 摄魂铁: 70, 阴魂石: 70, 玄阴玉: 50, 镇魂晶: 30, 万阵核心: 5, 四阶妖丹: 1 }, money: 0 },
  5: { materials: { 无主幽魂: 16, 摄魂铁: 80, 阴魂石: 80, 玄阴玉: 70, 镇魂晶: 50, 血煞髓: 30, 万阵核心: 5, 五阶妖丹: 1 }, money: 0 },
  6: { materials: { 无主幽魂: 25, 摄魂铁: 100, 阴魂石: 100, 玄阴玉: 90, 镇魂晶: 70, 血煞髓: 50, 万魂帝晶: 30, 万阵核心: 5, 六阶妖丹: 1 }, money: 0 },
  7: { materials: { 无主幽魂: 40, 摄魂铁: 120, 阴魂石: 120, 玄阴玉: 110, 镇魂晶: 90, 血煞髓: 70, 万魂帝晶: 50, 造梦神玉: 20, 万阵核心: 5, 七阶妖丹: 1 }, money: 0 }
}

/** 打造时随机/自选的固有战斗被动；数值已整体翻倍（原攻击/防御/生命3%~15%、暴击2%~10%、爆伤5%~26%）。 */
export const PUPPET_PASSIVES = {
  atk: { name: '傀儡战意', desc: '攻击提升', icon: '⚔️', field: 'atk', values: [0.06, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3] },
  def: { name: '玄甲护身', desc: '防御提升', icon: '🛡️', field: 'def', values: [0.06, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3] },
  hp: { name: '生机核心', desc: '生命提升', icon: '💚', field: 'hp', values: [0.06, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3] },
  crit: { name: '机巧会心', desc: '暴击提升', icon: '⚡', field: 'crit', values: [0.04, 0.06, 0.08, 0.1, 0.12, 0.16, 0.2] },
  cdmg: { name: '破魂机锋', desc: '爆伤提升', icon: '💥', field: 'cdmg', values: [0.1, 0.16, 0.22, 0.28, 0.36, 0.44, 0.52] }
}
export const PUPPET_PASSIVE_KEYS = Object.keys(PUPPET_PASSIVES)
export const PUPPET_PASSIVE_CORE = '傀儡被动晶核'

export const PUPPET_DEPLOY_COST_PER_RANK = 10000
const DEPLOY_INTERVAL = 30 * 60 * 1000
const BAG_DIR = path.join(Save_Path, 'bag')
const PUPPET_ID_PREFIX = 'puppet-'

function now () { return Date.now() }
function randomInt (min, max, rand = Math.random) { return min + Math.floor(rand() * (max - min + 1)) }
function clampRank (rank) { return Math.max(1, Math.min(7, Math.floor(Number(rank) || 1))) }
export function puppetDeployCost (rank) { return clampRank(rank) * PUPPET_DEPLOY_COST_PER_RANK }
function clampPower (power) { return Math.max(0, Math.min(PUPPET_MAX_POWER, Math.floor(Number(power) || 0))) }
function countOf (bag, name) { return Number(bag?.items?.[name]?.count) || 0 }
/** 傀儡被动晶核数量(存于 bag.artifacts.puppetCores 数字, 不占背包物品, #傀儡晶核 查看)。 */
export function puppetCoreCount (bag) {
  if (!bag || typeof bag !== 'object') return 0
  /* 兼容旧逻辑/缓存命中时仍可能写入 bag.items 的晶核，读取时即时迁移，避免打造看不到晶核。 */
  const legacy = bag.items?.[PUPPET_PASSIVE_CORE]
  if (legacy !== undefined) {
    const n = Math.max(0, Math.floor(Number(legacy?.count ?? legacy) || 0))
    bag.artifacts = bag.artifacts || {}
    bag.artifacts.puppetCores = Math.max(0, Math.floor(Number(bag.artifacts.puppetCores) || 0)) + n
    delete bag.items[PUPPET_PASSIVE_CORE]
  }
  return Math.max(0, Math.floor(Number(bag.artifacts?.puppetCores) || 0))
}
/** 消耗晶核, 不足返回 false; 调用方负责保存。 */
export function takePuppetCore (bag, n = 1) {
  n = Math.max(0, Math.floor(Number(n) || 0))
  const have = puppetCoreCount(bag)
  if (!n || have < n) return false
  bag.artifacts.puppetCores = have - n
  return true
}
/** 增加晶核, 返回当前数量; 调用方负责保存。 */
export function givePuppetCore (bag, n = 1) {
  n = Math.max(0, Math.floor(Number(n) || 0))
  if (!n || !bag) return puppetCoreCount(bag)
  bag.artifacts = bag.artifacts || {}
  bag.artifacts.puppetCores = puppetCoreCount(bag) + n
  return bag.artifacts.puppetCores
}
function cloneCost (cost) {
  return {
    materials: Object.fromEntries(Object.entries(cost?.materials || {}).map(([name, count]) => [name, Math.max(0, Math.floor(Number(count) || 0))])),
    money: Math.max(0, Math.floor(Number(cost?.money) || 0))
  }
}
function costText (cost) {
  const mats = Object.entries(cost?.materials || {}).map(([name, count]) => `${itemIcon(name)}${name}×${count}`)
  if (Number(cost?.money) > 0) mats.push(`${itemIcon('灵石')}灵石×${Number(cost.money).toLocaleString()}`)
  return mats.join('、')
}
function notify (gid, uid, text) {
  try {
    const group = globalThis.Bot?.pickGroup?.(gid)
    if (group?.sendMsg) {
      const at = globalThis.segment?.at?.(Number(uid))
      group.sendMsg(at ? [at, `\n${text}`] : text)
    }
  } catch (err) { }
}
function normalizePassive (passive) {
  if (PUPPET_PASSIVES[passive]) return passive
  const hit = PUPPET_PASSIVE_KEYS.find(key => PUPPET_PASSIVES[key].name === passive)
  return hit || ''
}
function ensurePuppet (puppet) {
  if (!puppet || typeof puppet !== 'object') return null
  puppet.id = String(puppet.id || `${PUPPET_ID_PREFIX}${now()}-${Math.floor(Math.random() * 10000)}`)
  puppet.name = String(puppet.name || '无名傀儡').replace(/[#＃]/g, '').slice(0, 8) || '无名傀儡'
  puppet.rank = clampRank(puppet.rank)
  puppet.power = clampPower(puppet.power)
  puppet.passive = normalizePassive(puppet.passive) || PUPPET_PASSIVE_KEYS[0]
  if (!Array.isArray(puppet.powerHistory) || !puppet.powerHistory.length) puppet.powerHistory = [{ rank: puppet.rank, power: puppet.power }]
  if (!puppet.lastCost || typeof puppet.lastCost !== 'object') puppet.lastCost = cloneCost(puppet.rank === 1 ? PUPPET_INITIAL_COST : PUPPET_UPGRADE_COSTS[puppet.rank])
  puppet.equipped = puppet.equipped === true
  puppet.deployed = puppet.deployed === true
  puppet.deployedUntil = Number(puppet.deployedUntil) || 0
  puppet.nextChargeAt = Number(puppet.nextChargeAt) || puppet.deployedUntil || 0
  if (!puppet.deployed) {
    puppet.deployedUntil = 0
    puppet.nextChargeAt = 0
  }
  return puppet
}
function ensurePuppetArray (bag) {
  bag.artifacts = bag.artifacts || {}
  if (!Array.isArray(bag.artifacts.puppets)) bag.artifacts.puppets = []
  const seen = new Set()
  bag.artifacts.puppets = bag.artifacts.puppets.map(ensurePuppet).filter(p => {
    if (!p || seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })
  let equipped = false
  for (const puppet of bag.artifacts.puppets) {
    if (!puppet.equipped) continue
    if (equipped) puppet.equipped = false
    else equipped = true
  }
  return bag.artifacts.puppets
}
function currentOfBag (bag) {
  return ensurePuppetArray(bag).find(p => p.equipped) || null
}
function randomPassive (rand = Math.random) { return PUPPET_PASSIVE_KEYS[Math.floor(rand() * PUPPET_PASSIVE_KEYS.length)] }
function requiredChapter (rank) {
  const r = clampRank(rank)
  return r <= 2 ? '傀儡术下篇' : (r <= 5 ? '傀儡术中篇' : '傀儡术上篇')
}
function chapterLearnedFromSet (learned, name) { return !!learned?.[name] }
async function chapterGate (uid, rank) {
  const chapter = requiredChapter(rank)
  const learned = await getLearnedGongfa(uid)
  return { ok: chapterLearnedFromSet(learned, chapter), chapter, learned }
}
async function homeOf (uid, gid) {
  return await xujing_data.getQQYUserHome(uid, null, `${gid}.json`, false)
}
async function moneyOf (uid, gid) {
  const home = await homeOf(uid, gid)
  return { home, money: Number(home?.[uid]?.money) || 0 }
}
async function takeMoney (uid, gid, amount, home = null) {
  amount = Math.max(0, Math.floor(Number(amount) || 0))
  if (!amount) return true
  const data = home || await homeOf(uid, gid)
  if (!data[uid] || (Number(data[uid].money) || 0) < amount) return false
  data[uid].money = (Number(data[uid].money) || 0) - amount
  await xujing_data.getQQYUserHome(uid, data, `${gid}.json`, true)
  return true
}
async function giveMoney (uid, gid, amount) {
  amount = Math.max(0, Math.floor(Number(amount) || 0))
  if (!amount) return
  const data = await homeOf(uid, gid)
  if (!data[uid]) data[uid] = { money: 0 }
  data[uid].money = (Number(data[uid].money) || 0) + amount
  await xujing_data.getQQYUserHome(uid, data, `${gid}.json`, true)
}
function hasMaterialCost (bag, cost) {
  return Object.entries(cost?.materials || {}).every(([name, count]) => countOf(bag, name) >= count)
}
function takeMaterialCost (bag, cost) {
  for (const [name, count] of Object.entries(cost?.materials || {})) {
    if (!consumeBagItem(bag, name, count)) return false
  }
  return true
}
function addMaterialRefund (bag, cost) {
  for (const [name, count] of Object.entries(cost?.materials || {})) {
    const refund = Math.floor((Number(count) || 0) / 2)
    if (refund > 0) addItemToBag(bag, name, refund, null, false)
  }
}
function idOf () { return `${PUPPET_ID_PREFIX}${now()}-${Math.floor(Math.random() * 1000000)}` }

/** 计算某只傀儡当前阶段的固定被动效果；未祭出时返回中性buff。 */
export function getPuppetBattleBuff (bag) {
  const puppet = currentOfBag(bag)
  if (!puppet || !puppet.deployed || !puppet.nextChargeAt || puppet.nextChargeAt <= now()) return { atk: 1, def: 1, hp: 1, crit: 0, cdmg: 0 }
  const passive = PUPPET_PASSIVES[puppet.passive]
  const value = passive?.values?.[clampRank(puppet.rank) - 1] || 0
  const buff = { atk: 1, def: 1, hp: 1, crit: 0, cdmg: 0 }
  if (passive?.field === 'crit' || passive?.field === 'cdmg') buff[passive.field] = value
  else if (passive?.field) buff[passive.field] = 1 + value
  return buff
}

/** 只有有效祭出中的傀儡才加入绝对战力。 */
export function getPuppetPower (bag) {
  const puppet = currentOfBag(bag)
  if (!puppet || !puppet.deployed || !puppet.nextChargeAt || puppet.nextChargeAt <= now()) return 0
  return Math.round(clampPower(puppet.power) * PUPPET_POWER_MULTIPLIER)
}

export function puppetPassiveText (puppet) {
  const p = puppet && PUPPET_PASSIVES[puppet.passive]
  if (!p) return '未知被动'
  const value = p.values[clampRank(puppet.rank) - 1] || 0
  return `${p.icon}${p.name}（${p.desc}+${Math.round(value * 100)}%）`
}

export function puppetRankName (rank) { return PUPPET_RANK_NAMES[clampRank(rank)] }
export function puppetPowerRangeText (rank) {
  const r = clampRank(rank); const range = PUPPET_POWER_RANGES[r]
  return r === 1 ? `${range[0]}～${range[1]}` : `前阶+${range[0]}～${range[1]}`
}

/** 法宝一览单行：只显示已装备的傀儡，写上被动效果；未装备返回空。 */
export function puppetArtifactLine (bag) {
  const puppet = currentOfBag(bag)
  if (!puppet) return ''
  const active = !!(puppet.deployed && puppet.nextChargeAt > now())
  const base = `${PUPPET_RANK_ICONS[clampRank(puppet.rank)]}${puppet.name}（${puppetRankName(puppet.rank)}·战力${puppet.power}）`
  return `法宝：${base}｜被动：${puppetPassiveText(puppet)}（${active ? '生效中' : '未祭出'}）`
}

/** 供功法入口识别，避免傀儡术被当作普通功法运转。 */
export function isPuppetTechnique (name) { return !!PUPPET_TECHNIQUES[name] }
export function puppetTechniqueInfo (name) { return PUPPET_TECHNIQUES[name] || null }
export function puppetChapterForRank (rank) { return requiredChapter(rank) }
export async function canLearnPuppetTechnique (uid, name) {
  const info = PUPPET_TECHNIQUES[name]
  if (!info) return { ok: true }
  const learned = await getLearnedGongfa(uid)
  const index = PUPPET_CHAPTERS.indexOf(name)
  if (index > 0 && !learned[PUPPET_CHAPTERS[index - 1]]) {
    return { ok: false, msg: `学习${name}前必须先学会${PUPPET_CHAPTERS[index - 1]}。` }
  }
  return { ok: true }
}

/** 选择/解析傀儡。名字重复时拒绝模糊匹配，避免误操作。 */
export function resolvePuppet (bag, target = '', allowCurrent = false) {
  const list = ensurePuppetArray(bag)
  const raw = String(target || '').trim().replace(/^[#＃]/, '')
  if (!raw && allowCurrent) {
    const current = list.find(p => p.equipped)
    return current ? { puppet: current, index: list.indexOf(current) } : { puppet: null, index: -1, msg: '当前没有装备傀儡。' }
  }
  if (!raw) return { puppet: null, index: -1, msg: '请提供傀儡序号或名字。' }
  if (/^\d+$/.test(raw)) {
    const index = Number(raw) - 1
    if (index < 0 || index >= list.length) return { puppet: null, index: -1, msg: `傀儡序号应为1～${list.length}。` }
    return { puppet: list[index], index }
  }
  const exact = list.filter(p => p.name === raw)
  if (exact.length === 1) return { puppet: exact[0], index: list.indexOf(exact[0]) }
  if (exact.length > 1) return { puppet: null, index: -1, msg: `有多只傀儡都叫“${raw}”，请改用序号。` }
  const partial = list.filter(p => p.name.includes(raw))
  if (partial.length === 1) return { puppet: partial[0], index: list.indexOf(partial[0]) }
  if (partial.length > 1) return { puppet: null, index: -1, msg: `找到多只匹配“${raw}”的傀儡，请改用序号。` }
  return { puppet: null, index: -1, msg: `没有找到傀儡“${raw}”。` }
}

/** 生成一阶初始战力或基于前阶追加随机战力。 */
export function rollPuppetPower (rank, previous = 0, rand = Math.random) {
  const r = clampRank(rank); const range = PUPPET_POWER_RANGES[r]
  if (r === 1) return randomInt(range[0], range[1], rand)
  return clampPower(Number(previous) + randomInt(range[0], range[1], rand))
}

/** 取得玩家傀儡列表并惰性修复旧/异常字段。 */
export function getPuppets (uid, gid = 'global') {
  const bag = getBag(uid, gid)
  ensurePuppetArray(bag)
  return bag.artifacts.puppets
}

export function currentPuppet (uid, gid = 'global') { return currentOfBag(getBag(uid, gid)) }
export function hasDeployedPuppet (bag) { return !!(currentOfBag(bag)?.deployed) }

/** 装备互斥：关闭万魂幡/定仙游及其他傀儡，但祭出中的傀儡必须先手动收回。 */
export function disablePuppets (bag) {
  let changed = false
  for (const puppet of ensurePuppetArray(bag)) {
    if (puppet.equipped || puppet.deployed) changed = true
    puppet.equipped = false
    puppet.deployed = false
    puppet.deployedUntil = 0
    puppet.nextChargeAt = 0
  }
  return changed
}

export async function craftPuppet (uid, gid = 'global', passive = '') {
  const gate = await chapterGate(uid, 1)
  if (!gate.ok) return { ok: false, msg: `打造傀儡前需要先学会${gate.chapter}，请使用 #修炼功法 ${gate.chapter}。` }
  const bag = getBag(uid, gid)
  const cost = cloneCost(PUPPET_INITIAL_COST)
  const chosen = normalizePassive(passive)
  if (passive && !chosen) return { ok: false, msg: `没有找到被动“${passive}”，可选：${PUPPET_PASSIVE_KEYS.map(k => PUPPET_PASSIVES[k].name).join('、')}。` }
  if (chosen && puppetCoreCount(bag) < 1) return { ok: false, msg: `自选被动需要${itemIcon(PUPPET_PASSIVE_CORE)}${PUPPET_PASSIVE_CORE}×1（分解傀儡可获得，#傀儡晶核 查看）。` }
  const lack = Object.entries(cost.materials).filter(([name, count]) => countOf(bag, name) < count)
  let moneyData
  try { moneyData = await moneyOf(uid, gid) } catch (err) { return { ok: false, msg: '灵石存档暂时无法读取，请稍后再试。' } }
  if (lack.length || moneyData.money < cost.money) {
    const lackText = lack.map(([name, count]) => `${itemIcon(name)}${name}×${count - countOf(bag, name)}`).join('、')
    return { ok: false, msg: `打造一阶傀儡材料不足，需要：${costText(cost)}${lackText ? `；还缺${lackText}` : ''}${moneyData.money < cost.money ? `；灵石还缺${(cost.money - moneyData.money).toLocaleString()}` : ''}。` }
  }
  if (!takeMaterialCost(bag, cost)) return { ok: false, msg: '材料状态已变化，请重新检查背包后再打造。' }
  if (chosen && !takePuppetCore(bag, 1)) return { ok: false, msg: '被动晶核状态已变化，请重新检查后打造。' }
  try {
    if (!(await takeMoney(uid, gid, cost.money, moneyData.home))) return { ok: false, msg: '灵石状态已变化，请重新检查后再打造。' }
  } catch (err) { return { ok: false, msg: '灵石扣除失败，本次打造未完成，请稍后再试。' } }
  const puppet = {
    id: idOf(), name: '无名傀儡', rank: 1, power: rollPuppetPower(1), passive: chosen || randomPassive(),
    powerHistory: [{ rank: 1, power: 0 }], equipped: false, deployed: false,
    deployedUntil: 0, nextChargeAt: 0, lastCost: cost, craftedAt: now()
  }
  puppet.powerHistory[0].power = puppet.power
  ensurePuppetArray(bag).push(puppet)
  saveBag(uid, bag, gid)
  return { ok: true, puppet, msg: `⚪一阶傀儡打造成功！序号${ensurePuppetArray(bag).indexOf(puppet) + 1}，初始战力${puppet.power}，固有被动：${puppetPassiveText(puppet)}。\n已消耗：${costText(cost)}${chosen ? `；${itemIcon(PUPPET_PASSIVE_CORE)}${PUPPET_PASSIVE_CORE}×1` : ''}\n可用 #傀儡命名 ${ensurePuppetArray(bag).indexOf(puppet) + 1} <名字> 改名。` }
}

export async function upgradePuppet (uid, gid = 'global', target = '') {
  const bag = getBag(uid, gid)
  const hit = resolvePuppet(bag, target, !target)
  if (!hit.puppet) return { ok: false, msg: hit.msg || '当前没有可升级的傀儡。' }
  const puppet = hit.puppet
  const nextRank = clampRank(puppet.rank) + 1
  if (nextRank > 7) return { ok: false, msg: `${puppet.name}已经是七阶，不能继续升级。` }
  const gate = await chapterGate(uid, nextRank)
  if (!gate.ok) return { ok: false, msg: `升级到${puppetRankName(nextRank)}前需要先学会${gate.chapter}，请使用 #修炼功法 ${gate.chapter}。` }
  const cost = cloneCost(PUPPET_UPGRADE_COSTS[nextRank])
  if (!hasMaterialCost(bag, cost)) return { ok: false, msg: `升级${puppet.name}到${puppetRankName(nextRank)}材料不足，需要：${costText(cost)}。` }
  let moneyData
  try { moneyData = await moneyOf(uid, gid) } catch (err) { return { ok: false, msg: '灵石存档暂时无法读取，请稍后再试。' } }
  if (moneyData.money < cost.money) return { ok: false, msg: `升级${puppet.name}需要${cost.money.toLocaleString()}灵石，你当前只有${moneyData.money.toLocaleString()}灵石。` }
  if (!takeMaterialCost(bag, cost)) return { ok: false, msg: '材料状态已变化，请重新检查后再升级。' }
  try {
    if (!(await takeMoney(uid, gid, cost.money, moneyData.home))) return { ok: false, msg: '灵石状态已变化，请重新检查后再升级。' }
  } catch (err) { return { ok: false, msg: '灵石扣除失败，本次升级未完成。' } }
  puppet.rank = nextRank
  puppet.power = rollPuppetPower(nextRank, puppet.power)
  puppet.powerHistory = Array.isArray(puppet.powerHistory) ? puppet.powerHistory : []
  puppet.powerHistory.push({ rank: nextRank, power: puppet.power })
  puppet.lastCost = cost
  saveBag(uid, bag, gid)
  return { ok: true, puppet, msg: `${PUPPET_RANK_ICONS[puppet.rank]}${puppetRankName(puppet.rank)}傀儡升级成功！${puppet.name}当前战力${puppet.power}，固有被动：${puppetPassiveText(puppet)}。\n本次消耗：${costText(cost)}` }
}

export function renamePuppet (uid, gid = 'global', target, name) {
  const bag = getBag(uid, gid)
  const hit = resolvePuppet(bag, target)
  if (!hit.puppet) return { ok: false, msg: hit.msg }
  const next = String(name || '').trim().replace(/[#＃]/g, '').slice(0, 8)
  if (!next) return { ok: false, msg: '名字不能为空，用法：#傀儡命名 <序号或名字> <新名字>（最多8字）。' }
  hit.puppet.name = next
  saveBag(uid, bag, gid)
  return { ok: true, msg: `✅ 已将第${hit.index + 1}只傀儡改名为【${next}】。` }
}

export function equipPuppet (uid, gid = 'global', target) {
  const bag = getBag(uid, gid)
  const hit = resolvePuppet(bag, target)
  if (!hit.puppet) return { ok: false, msg: hit.msg }
  const puppet = hit.puppet
  const current = currentOfBag(bag)
  if (current?.deployed) return { ok: false, msg: `当前${current.name}正在祭出中，请先使用 #收回傀儡 再切换法宝。` }
  if (bag.artifacts?.wanhun?.deployed) return { ok: false, msg: '万魂幡正在祭出中，请先收回万魂幡再切换法宝。' }
  for (const p of ensurePuppetArray(bag)) p.equipped = false
  if (bag.artifacts?.wanhun) {
    bag.artifacts.wanhun.equipped = false
    bag.artifacts.wanhun.deployed = false
    bag.artifacts.wanhun.aidUntil = 0
  }
  if (bag.artifacts?.dingxianyou) bag.artifacts.dingxianyou.equipped = false
  puppet.equipped = true
  saveBag(uid, bag, gid)
  return { ok: true, msg: `已装备${PUPPET_RANK_ICONS[puppet.rank]}${puppetRankName(puppet.rank)}${puppet.name}（战力${puppet.power}，${puppetPassiveText(puppet)}）。可使用 #祭出傀儡 激活战力。` }
}

export function unequipPuppet (uid, gid = 'global') {
  const bag = getBag(uid, gid)
  const puppet = currentOfBag(bag)
  if (!puppet) return { ok: false, msg: '当前没有装备傀儡。' }
  if (puppet.deployed) return { ok: false, msg: `${puppet.name}正在祭出中，请先使用 #收回傀儡。` }
  puppet.equipped = false
  saveBag(uid, bag, gid)
  return { ok: true, msg: `已卸下${puppet.name}。` }
}

async function chargeDeployment (uid, gid, puppet, bag, notifyOnStop = true) {
  if (!puppet?.deployed) return { changed: false, active: false, charged: 0, due: 0 }
  const t = now()
  const next = Number(puppet.nextChargeAt) || t
  if (t < next) return { changed: false, active: true, charged: 0, due: 0 }
  const due = Math.max(1, Math.floor((t - next) / DEPLOY_INTERVAL) + 1)
  let data
  try { data = await moneyOf(uid, gid) } catch (err) { return { changed: false, active: true, charged: 0, due, error: true } }
  const cost = puppetDeployCost(puppet.rank)
  const affordable = Math.floor(data.money / cost)
  const charged = Math.min(due, affordable)
  if (charged > 0) {
    data.home[uid].money = data.money - charged * cost
    try { await xujing_data.getQQYUserHome(uid, data.home, `${gid}.json`, true) } catch (err) { return { changed: false, active: true, charged: 0, due, error: true } }
    puppet.nextChargeAt = next + charged * DEPLOY_INTERVAL
    puppet.deployedUntil = puppet.nextChargeAt
  }
  let stopped = false
  if (charged < due) {
    puppet.deployed = false
    puppet.deployedUntil = 0
    puppet.nextChargeAt = 0
    stopped = true
  }
  saveBag(uid, bag, gid)
  if (stopped && notifyOnStop) notify(gid, uid, `💰${puppet.name}祭出续费失败，灵石不足${cost.toLocaleString()}，已自动收回。`)
  return { changed: charged > 0 || stopped, active: !stopped, charged, due, stopped }
}

/** 读取战力前的懒推进；后台定时器也会调用同一函数。 */
export async function tickPuppet (uid, gid = 'global', notifyOnStop = true) {
  const bag = getBag(uid, gid)
  const puppet = currentOfBag(bag)
  if (!puppet?.deployed) return { changed: false, active: false, charged: 0, due: 0 }
  return await chargeDeployment(uid, gid, puppet, bag, notifyOnStop)
}

export async function deployPuppet (uid, gid = 'global') {
  const bag = getBag(uid, gid)
  const puppet = currentOfBag(bag)
  if (!puppet) return { ok: false, msg: '请先装备一只傀儡。' }
  if (puppet.deployed) {
    await chargeDeployment(uid, gid, puppet, bag, true)
    return puppet.deployed ? { ok: false, msg: `${puppet.name}已经祭出中，当前还剩${Math.max(0, Math.ceil((puppet.nextChargeAt - now()) / 60000))}分钟。` } : { ok: false, msg: `${puppet.name}续费失败，已自动收回。` }
  }
  const cost = puppetDeployCost(puppet.rank)
  let data
  try { data = await moneyOf(uid, gid) } catch (err) { return { ok: false, msg: '灵石存档暂时无法读取，请稍后再试。' } }
  if (data.money < cost) return { ok: false, msg: `祭出${puppet.name}立即需要${cost.toLocaleString()}灵石，你当前只有${data.money.toLocaleString()}灵石。` }
  try {
    if (!(await takeMoney(uid, gid, cost, data.home))) return { ok: false, msg: '灵石状态已变化，请稍后再祭出。' }
  } catch (err) { return { ok: false, msg: '灵石扣除失败，暂时无法祭出。' } }
  puppet.deployed = true
  puppet.nextChargeAt = now() + DEPLOY_INTERVAL
  puppet.deployedUntil = puppet.nextChargeAt
  saveBag(uid, bag, gid)
  return { ok: true, msg: `⚔️${puppet.name}已祭出！立即消耗${cost.toLocaleString()}灵石，持续30分钟；当前战力额外+${Math.round(puppet.power * PUPPET_POWER_MULTIPLIER)}（基础${puppet.power}×${PUPPET_POWER_MULTIPLIER}），${puppetPassiveText(puppet)}。灵石充足时每30分钟按${cost.toLocaleString()}灵石自动续费。` }
}

export function recallPuppet (uid, gid = 'global') {
  const bag = getBag(uid, gid)
  const puppet = currentOfBag(bag)
  if (!puppet) return { ok: false, msg: '当前没有装备傀儡。' }
  if (!puppet.deployed) return { ok: false, msg: `${puppet.name}当前没有祭出。` }
  puppet.deployed = false
  puppet.deployedUntil = 0
  puppet.nextChargeAt = 0
  saveBag(uid, bag, gid)
  return { ok: true, msg: `已收回${puppet.name}，未使用完的时间不退还灵石。` }
}

export async function dismantlePuppet (uid, gid = 'global', target) {
  const bag = getBag(uid, gid)
  const hit = resolvePuppet(bag, target)
  if (!hit.puppet) return { ok: false, msg: hit.msg }
  const puppet = hit.puppet
  if (puppet.equipped || puppet.deployed) return { ok: false, msg: `请先收回并卸下${puppet.name}，再进行分解。` }
  const cost = cloneCost(puppet.lastCost || PUPPET_INITIAL_COST)
  const list = ensurePuppetArray(bag)
  list.splice(hit.index, 1)
  addMaterialRefund(bag, cost)
  givePuppetCore(bag, 1)
  saveBag(uid, bag, gid)
  try { await giveMoney(uid, gid, Math.floor(cost.money / 2)) } catch (err) {
    return { ok: true, msg: `已分解${puppet.name}，材料及${itemIcon(PUPPET_PASSIVE_CORE)}被动晶核已返还；灵石退款写入失败，请联系管理员核对。` }
  }
  const refund = Object.fromEntries(Object.entries(cost.materials).map(([name, count]) => [name, Math.floor(count / 2)]).filter(([, count]) => count > 0))
  const text = Object.entries(refund).map(([name, count]) => `${itemIcon(name)}${name}×${count}`).concat(Math.floor(cost.money / 2) > 0 ? [`${itemIcon('灵石')}灵石×${Math.floor(cost.money / 2).toLocaleString()}`] : []).join('、')
  return { ok: true, msg: `🔨已分解${puppet.name}（${puppetRankName(puppet.rank)}），返还本阶成本的一半：${text || '无材料返还'}、${itemIcon(PUPPET_PASSIVE_CORE)}${PUPPET_PASSIVE_CORE}×1。数量1的材料按向下取整返还0。` }
}

export async function dismantlePuppetTechnique (uid, gid = 'global', name, amount = 1) {
  const info = PUPPET_TECHNIQUES[name]
  if (!info) return { ok: false, msg: `不是傀儡术篇章：${name || ''}` }
  if (!(await isGongfaLearned(uid, name))) return { ok: false, msg: `你还没有学会《${name}》，不能把它当重复功法分解。` }
  const bag = getBag(uid, gid)
  const have = countOf(bag, name)
  const count = Math.max(1, Math.min(have, Math.floor(Number(amount) || 1)))
  if (have < 1) return { ok: false, msg: `你没有多余的${itemIcon(name)}《${name}》功法书。` }
  if (!consumeBagItem(bag, name, count)) return { ok: false, msg: '功法书状态已变化，请稍后再试。' }
  addItemToBag(bag, PUPPET_TECHNIQUE_FRAGMENT, count, null, false)
  saveBag(uid, bag, gid)
  return { ok: true, msg: `📜已分解${itemIcon(name)}《${name}》×${count}，获得${itemIcon(PUPPET_TECHNIQUE_FRAGMENT)}${PUPPET_TECHNIQUE_FRAGMENT}×${count}。` }
}

export function puppetPanel (uid, gid = 'global') {
  const bag = getBag(uid, gid)
  const list = ensurePuppetArray(bag)
  const current = list.find(p => p.equipped)
  const lines = ['━━━ 🤖 傀儡法宝 ━━━']
  if (!list.length) lines.push('尚未打造傀儡（学会🌈傀儡术下篇后可打造）')
  for (const [i, puppet] of list.entries()) {
    const left = puppet.deployed && puppet.nextChargeAt > now() ? `，祭出剩${Math.ceil((puppet.nextChargeAt - now()) / 60000)}分` : ''
    lines.push(`${i + 1}. ${puppet.equipped ? '✅' : '　'}${PUPPET_RANK_ICONS[clampRank(puppet.rank)]}${puppet.name}（${puppetRankName(puppet.rank)}，战力${puppet.power}，${puppetPassiveText(puppet)}${puppet.deployed ? '，祭出中' : ''}${left}）`)
  }
  lines.push(current ? `当前装备：${current.name}${current.deployed ? '（祭出中）' : ''}` : '当前未装备傀儡')
  lines.push('━━━ 打造与升级材料 ━━━', `一阶打造：${costText(PUPPET_INITIAL_COST)}`)
  for (let rank = 2; rank <= 7; rank++) lines.push(`${puppetRankName(rank)}升级：${costText(PUPPET_UPGRADE_COSTS[rank])}`)
  lines.push(`祭出费用：${itemIcon('灵石')}按当前阶位计费，${puppetDeployCost(1).toLocaleString()}～${puppetDeployCost(7).toLocaleString()}灵石／30分钟（每升一阶增加${PUPPET_DEPLOY_COST_PER_RANK.toLocaleString()}灵石），自动续费至余额不足。`)
  return { text: lines.join('\n'), puppets: list, current }
}

export function puppetTechniquePanel (uid) {
  return getLearnedGongfa(uid).then(learned => {
    const lines = ['━━━ 📜 傀儡术 ━━━']
    for (const name of PUPPET_CHAPTERS) {
      const info = PUPPET_TECHNIQUES[name]
      lines.push(`${learned[name] ? '✅' : '⬜'}${itemIcon(name)}《${name}》：${learned[name] ? `已学，开放${info.minRank}～${info.maxRank}阶` : '未学'}`)
    }
    lines.push('三篇功法仅用于解锁傀儡阶段，不占当前运转功法位，也不提供额外战斗加成。')
    return lines.join('\n')
  })
}

export function availablePassiveLines () {
  return PUPPET_PASSIVE_KEYS.map((key, i) => `${i + 1}. ${puppetPassiveText({ rank: 1, passive: key })}（高阶会随阶位增强）`)
}

/** #傀儡晶核: 显示拥有的晶核数量与用途/被动效果(晶核不占背包物品位)。 */
export function puppetCorePanel (uid, gid = 'global') {
  const bag = getBag(uid, gid)
  const count = puppetCoreCount(bag)
  const lines = ['━━━ 🌈 傀儡被动晶核 ━━━']
  lines.push(count > 0
    ? `拥有：${itemIcon(PUPPET_PASSIVE_CORE)}${PUPPET_PASSIVE_CORE}×${count}`
    : `你还没有${itemIcon(PUPPET_PASSIVE_CORE)}${PUPPET_PASSIVE_CORE}（分解傀儡固定返还1枚）。`)
  lines.push('用途：打造傀儡时消耗1枚，可自选固有战斗被动；不消耗则随机获得。')
  lines.push('被动效果（随傀儡阶位增强）：')
  lines.push(...availablePassiveLines())
  lines.push('打造时持有晶核会先让你选择被动，回复 0 为随机、不消耗晶核。')
  return { text: lines.join('\n'), count }
}

/** 后台自动续费：只扫描已经存在的群/玩家背包，不主动创建新档。 */
async function tickAllDeployments () {
  try {
    if (!fs.existsSync(BAG_DIR)) return
    for (const gid of fs.readdirSync(BAG_DIR)) {
      const dir = path.join(BAG_DIR, gid)
      if (!fs.statSync(dir).isDirectory()) continue
      for (const file of fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name))) {
        const uid = file.slice(0, -5)
        try { await tickPuppet(uid, gid, true) } catch (err) { }
      }
    }
  } catch (err) { }
}
if (!global.__xujingPuppetTick__) {
  global.__xujingPuppetTick__ = true
  setInterval(() => { tickAllDeployments().catch(() => {}) }, 15000).unref()
}

export const _test = {
  cloneCost,
  costText,
  ensurePuppet,
  requiredChapter,
  addMaterialRefund,
  randomInt,
  clampPower,
  normalizePassive
}

export default {
  PUPPET_TECHNIQUES,
  PUPPET_CHAPTERS,
  PUPPET_TECHNIQUE_FRAGMENT,
  PUPPET_INITIAL_COST,
  PUPPET_UPGRADE_COSTS,
  PUPPET_POWER_MULTIPLIER,
  PUPPET_PASSIVES,
  PUPPET_PASSIVE_CORE,
  PUPPET_DEPLOY_COST_PER_RANK,
  puppetDeployCost,
  rollPuppetPower,
  getPuppets,
  currentPuppet,
  getPuppetPower,
  getPuppetBattleBuff,
  puppetPanel,
  puppetCorePanel,
  puppetCoreCount,
  takePuppetCore,
  givePuppetCore,
  puppetTechniquePanel,
  craftPuppet,
  upgradePuppet,
  renamePuppet,
  equipPuppet,
  unequipPuppet,
  deployPuppet,
  recallPuppet,
  dismantlePuppet,
  dismantlePuppetTechnique,
  tickPuppet,
  resolvePuppet,
  canLearnPuppetTechnique,
  isPuppetTechnique,
  disablePuppets
}
