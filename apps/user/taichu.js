import { plugin } from '../../model/api/api.js'
import { withGameLock } from '../../components/game_lock.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { isTaichuEnabled, taichuExplorationEffects, wearTaichuLoadout } from '../../components/taichu_equipment.js'
import { TAICHU_EQUIPMENT, TAICHU_RECIPES } from '../../components/taichu_data.js'
import { craftTaichu, repairTaichu, craftTaichuFragment, makeTaichuSupply, patchTaichu } from '../../components/taichu_crafting.js'
import { createTaichuRun, joinTaichuRun, actTaichuRun, retreatTaichuRun, supplyTaichuRun, taichuChoices, taichuRunView, findPlayerTaichuRun, getTaichuSettlement, commitTaichuSettlement, TAICHU_ENTRY_COST } from '../../components/taichu_dungeon.js'
import { readTaichuStore } from '../../components/taichu_store.js'
import { commitTaichuPlayerTransaction, recoverTaichuPlayerTransactions, taichuPlayerSnapshot } from '../../components/taichu_player.js'
import { addItemToBag, consumeBagItems, fmtItems, itemIcon } from '../../components/equip_data.js'
import { getFake } from '../../components/fake_data.js'
import { sameRegion } from '../../components/sect/helpers.js'
import { getWorld, getLoc } from '../../components/world_data.js'
import { calcCombatPower, getBuffs } from '../../components/fight.js'

const pending = new Map()
const identity = e => `${e.group_id}:${e.user_id}`
const difficulty = { 普通: 'normal', 困难: 'hard', 绝境: 'extreme' }
const text = e => String(e.msg || '').replace(/^[#＃]/, '').trim()
const gate = e => !!e.group_id && isTaichuEnabled()
const parts = { 武器: 'weapon', 头盔: 'helmet', 头冠: 'helmet', 胸甲: 'chest', 上衣: 'chest', 裤子: 'pants', 鞋子: 'shoes', 戒指: 'ring' }
async function withTaichuLock (gid, fn) {
  return withGameLock(gid, async () => { await recoverTaichuPlayerTransactions(gid); return fn() })
}

async function snapshot (gid, uid) {
  const actor = await taichuPlayerSnapshot(gid, uid)
  actor.power = calcCombatPower(actor.level, actor.bag, await getBuffs(uid, gid), gid, uid).power
  return actor
}

async function prompt (e, run) {
  const choices = taichuChoices(run)
  if (run.phase === 'active' && choices.length) {
    pending.set(identity(e), { id: run.id, step: run.step, keys: choices.map(c => c.key) })
    await forceLock(e.group_id, e.user_id, 'taichu')
  } else {
    pending.delete(identity(e))
    await unlock(e.group_id, e.user_id, 'taichu')
  }
  await e.reply(`${taichuRunView(run)}${run.phase === 'active' ? '\n回复数字选择；也可 #古墟行动 动作名。队员用 #古墟状态 查看新节点。\n#古墟补给 恢复精力；#撤离古墟 全队撤退。' : '\n#领取古墟奖励'}`)
}

function workshop (e) {
  const f = getFake(String(e.group_id))
  const p = f.players?.[String(e.user_id)]
  const sect = p && f.sects?.[p.sect]
  if (!sect || (sect.wipeAt && sect.wipeAt <= Date.now())) return { ok: false, msg: '请先加入拥有天工坊的宗门。' }
  const region = sameRegion(e, f, p.sect)
  if (!region.ok) return region
  return { ok: true, level: Number(sect.facilities?.tiangong) || 0, contribution: Number(p.contribution) || 0 }
}

export class taichu extends plugin {
  constructor () {
    super({ name: '太初古墟', dsc: '太初古墟与装备维护', event: 'message', priority: 59, rule: [
      { reg: '^[#＃]?太初玩法$', fnc: 'taichuGuide' },
      { reg: '^[#＃]?太初配方.*$', fnc: 'taichuRecipes' },
      { reg: '^[#＃]?进入古墟(?:\\s*(普通|困难|绝境))?$', fnc: 'taichuStart' },
      { reg: '^[#＃]?加入古墟.*$', fnc: 'taichuJoin' },
      { reg: '^[#＃]?古墟状态$', fnc: 'taichuStatus' },
      { reg: '^[#＃]?古墟行动\\s*.+$', fnc: 'taichuAct' },
      { reg: '^[#＃]?撤离古墟$', fnc: 'taichuLeave' },
      { reg: '^[#＃]?领取古墟奖励$', fnc: 'taichuClaim' },
      { reg: '^[#＃]?打造太初\\s*.+$', fnc: 'taichuCraft' },
      { reg: '^[#＃]?修理太初\\s*.+$', fnc: 'taichuRepair' },
      { reg: '^[#＃]?合成古墟\\s*.+$', fnc: 'taichuFragment' },
      { reg: '^[#＃]?制作(古墟补给|太初修补包)$', fnc: 'taichuMakeSupply' },
      { reg: '^[#＃]?修补太初\\s*.+$', fnc: 'taichuPatch' },
      { reg: '^[#＃]?古墟补给$', fnc: 'taichuSupply' },
      { reg: '^[#＃]?[0-9]+$', fnc: 'taichuPick' }
    ] })
  }

  async taichuGuide (e) {
    if (!gate(e)) return false
    await e.reply('太初古墟：1～3人，普通/困难/绝境。\n#进入古墟 普通（灵石20000，困难50000，绝境100000，含本趟补给）\n其他成员在择路前 #加入古墟 @队长，同大区且每人独立付费。\n#古墟状态 查看线索并回复数字，全员完成选择后推进。\n先选铸兵/镇魂/沧溟路线，判断阵纹、处理镇守与最终Boss；精力、补给贯穿全程。残殿可搜索、休整、封存或撤离。失败保留已封存收获。每周每人最多两次核心奖励。\n#古墟补给 恢复精力；#撤离古墟 全队撤退\n#领取古墟奖励\n#太初配方 [装备名]\n#打造太初 断界（需路线通关、材料及本宗天工坊）\n#修理太初 武器（或装备实例ID）\n#合成古墟 断界图谱（同名碎片10合1）\n#制作古墟补给 / #制作太初修补包\n#修补太初 武器（非战斗阶段恢复200耐久）\n附魔最高Ⅴ级，仅强化本件原生属性或指定古墟行动；随装备交易、搜刮、继承保留。太初装备耐久为0时属性、附魔及套装计数失效。')
    return true
  }

  async taichuRecipes (e) {
    if (!gate(e)) return false
    const query = text(e).replace(/^太初配方/, '').trim()
    const rows = Object.entries(TAICHU_RECIPES).filter(([name]) => !query || name.includes(query)).map(([name, r]) => `${itemIcon(name)}${name}\n${fmtItems(r.materials)}\n胚子：${r.base}；灵石${r.stones}；贡献${r.contribution}；路线${r.route}`)
    await e.reply(rows.join('\n\n') || '没有这个太初配方。')
    return true
  }

  async taichuStart (e) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      await recoverTaichuPlayerTransactions(e.group_id)
      if (await guardActionLocked(e)) return true
      const state = structuredClone(readTaichuStore(e.group_id))
      if (findPlayerTaichuRun(state, String(e.user_id), { includeEnded: true })) { await e.reply('请先完成或领取上一趟古墟结算。'); return true }
      const diff = difficulty[text(e).replace(/^进入古墟/, '').trim()] || 'normal'
      const a = await snapshot(e.group_id, e.user_id)
      const fee = TAICHU_ENTRY_COST[diff]
      if (a.money < fee) { await e.reply(`入场需要${fee}灵石。`); return true }
      const result = createTaichuRun({ gid: String(e.group_id), leader: String(e.user_id), members: [{ id: String(e.user_id), name: e.sender?.card || e.sender?.nickname || '修士', kind: 'player', power: a.power }], difficulty: diff })
      if (result.ok === false) { await e.reply(result.message || result.msg); return true }
      const run = result.run || result
      run.region = getLoc(getWorld(e.group_id), e.user_id)
      state.runs[run.id] = run
      await commitTaichuPlayerTransaction(e.group_id, { uid: String(e.user_id), money: a.money - fee, store: state })
      await prompt(e, run)
      return true
    })
  }

  async taichuJoin (e) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      if (await guardActionLocked(e)) return true
      const state = structuredClone(readTaichuStore(e.group_id))
      if (findPlayerTaichuRun(state, String(e.user_id), { includeEnded: true })) { await e.reply('请先领取上一趟结算。'); return true }
      const leader = String((e.at && (Array.isArray(e.at) ? e.at[0] : e.at)) || (e.message || []).find(m => m.type === 'at')?.qq || text(e).replace(/^加入古墟/, '').trim())
      const run = findPlayerTaichuRun(state, leader)
      if (!run || String(run.leader) !== leader) { await e.reply('请指定正在古墟择路的队长：#加入古墟 @队长'); return true }
      if (run.region !== getLoc(getWorld(e.group_id), e.user_id)) { await e.reply('需要与队长位于同一大区。'); return true }
      const a = await snapshot(e.group_id, e.user_id)
      const fee = TAICHU_ENTRY_COST[run.difficulty]
      if (a.money < fee) { await e.reply(`入场需要${fee}灵石。`); return true }
      const result = joinTaichuRun(run, { id: String(e.user_id), name: e.sender?.card || e.sender?.nickname || '修士', kind: 'player', power: a.power })
      if (!result.ok) { await e.reply(result.message || result.msg); return true }
      await commitTaichuPlayerTransaction(e.group_id, { uid: String(e.user_id), money: a.money - fee, store: state })
      await prompt(e, run)
      return true
    })
  }

  async taichuStatus (e) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      const state = readTaichuStore(e.group_id)
      const run = findPlayerTaichuRun(state, String(e.user_id), { includeEnded: true })
      if (run) await prompt(e, run)
      else { pending.delete(identity(e)); await unlock(e.group_id, e.user_id, 'taichu'); await e.reply('当前没有古墟行程。#进入古墟 普通') }
      return true
    })
  }

  async taichuPick (e) {
    if (!gate(e) || !await isCurrent(e.group_id, e.user_id, 'taichu')) return false
    const choice = pending.get(identity(e))
    if (!choice) { await unlock(e.group_id, e.user_id, 'taichu'); return false }
    const action = choice.keys[Number(text(e)) - 1]
    if (!action) { await e.reply('请选择菜单中的数字。'); return true }
    return this.perform(e, action, choice)
  }

  async taichuAct (e) {
    if (!gate(e)) return false
    const raw = text(e).replace(/^古墟行动/, '').trim()
    const aliases = { 铸兵: 'forge', 镇魂: 'soul', 沧溟: 'tide', 镇压: 'suppress', 强破: 'force', 攻击: 'attack', 破盾: 'break', 打断: 'interrupt', 防守: 'guard', 搜索: 'search', 休整: 'rest', 封存: 'seal', 撤离: 'leave', 拆木: 'disarm:wood', 拆火: 'disarm:fire', 拆水: 'disarm:water' }
    return this.perform(e, aliases[raw] || raw)
  }

  async taichuLeave (e) {
    if (!gate(e)) return false
    return this.perform(e, 'retreat')
  }

  async perform (e, action, choice = null) {
    return withTaichuLock(e.group_id, async () => {
      if (await guardActionLocked(e, undefined, { skipTaichu: true })) return true
      const state = structuredClone(readTaichuStore(e.group_id))
      const uid = String(e.user_id)
      const run = findPlayerTaichuRun(state, uid, { includeEnded: true })
      if (!run) { await unlock(e.group_id, uid, 'taichu'); await e.reply('当前没有古墟行程。'); return true }
      if (choice && (choice.id !== run.id || choice.step !== run.step)) { await e.reply('节点已推进，请按新菜单选择。'); await prompt(e, run); return true }
      const messageId = String(e.message_id || e.messageId || '')
      if (messageId && run.processedMessages?.includes(messageId)) { await prompt(e, run); return true }
      const a = await snapshot(e.group_id, uid)
      // 入场补给耗尽后可实际消耗背包中的古墟补给继续恢复，不凭空补充。
      if (action === 'supply' && run.members[uid]?.supplies < 1) {
        if (!consumeBagItems(a.bag, { 古墟补给: 1 })) { await e.reply('本趟补给耗尽，背包也没有古墟补给。'); return true }
        run.members[uid].supplies++
      }
      const result = action === 'retreat' ? retreatTaichuRun(run, uid) : action === 'supply' ? supplyTaichuRun(run, uid) : actTaichuRun(run, uid, action, { power: a.power, bonuses: taichuExplorationEffects(a.bag), materials: Object.fromEntries(Object.entries(a.bag.items || {}).map(([name, it]) => [name, Number(it?.count ?? it) || 0])) })
      if (!result.ok) { await e.reply(result.message || result.msg); await prompt(e, run); return true }
      if (result.consume && !consumeBagItems(a.bag, result.consume)) { await e.reply('材料不足，行动未执行。'); return true }
      if (result.wear) wearTaichuLoadout(a.bag, result.wear, { receipt: `${run.id}:${run.step}:${uid}:${messageId || Date.now()}` })
      if (messageId) run.processedMessages = [...(run.processedMessages || []), messageId].slice(-200)
      await commitTaichuPlayerTransaction(e.group_id, { uid, bag: a.bag, store: state })
      await e.reply(result.message || result.msg || '行动已完成。')
      await prompt(e, run)
      return true
    })
  }

  async taichuClaim (e) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      const state = structuredClone(readTaichuStore(e.group_id))
      const uid = String(e.user_id)
      const run = findPlayerTaichuRun(state, uid, { includeEnded: true })
      if (!run) { await e.reply('没有待领取的古墟结算。'); return true }
      const result = getTaichuSettlement(run, uid, state.ledger)
      if (!result || result.ok === false) { await e.reply(result?.message || result?.msg || '行程结束后才能领取。'); return true }
      const a = await taichuPlayerSnapshot(e.group_id, uid)
      a.bag.rewardReceipts ||= {}
      if (!a.bag.rewardReceipts[result.receipt]) {
        for (const [name, count] of Object.entries(result.items || {})) addItemToBag(a.bag, name, count, null, false)
        a.bag.taichu ||= {}
        a.bag.taichu.routeClears ||= {}
        if (result.route) a.bag.taichu.routeClears[result.route] = (a.bag.taichu.routeClears[result.route] || 0) + 1
        a.bag.rewardReceipts[result.receipt] = Date.now()
      }
      commitTaichuSettlement(run, uid, state.ledger)
      await commitTaichuPlayerTransaction(e.group_id, { uid, bag: a.bag, store: state })
      pending.delete(identity(e)); await unlock(e.group_id, uid, 'taichu')
      await e.reply(`古墟结算：${fmtItems(result.items) || '没有可带回的战利品'}。`)
      return true
    })
  }

  async service (e, repair) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      if (await guardActionLocked(e)) return true
      const station = workshop(e)
      if (!station.ok) { await e.reply(station.msg); return true }
      const a = await taichuPlayerSnapshot(e.group_id, e.user_id)
      const actor = { money: a.money, contribution: station.contribution }
      const input = text(e).replace(repair ? /^修理太初/ : /^打造太初/, '').trim()
      const name = Object.keys(TAICHU_EQUIPMENT).find(n => n === input || n.replace('太初·', '') === input)
      const result = repair ? repairTaichu(a.bag, parts[input] || input, { workshopLevel: station.level, actor }) : craftTaichu(a.bag, name || input, { workshopLevel: station.level, actor })
      if (!result.ok) { await e.reply(result.msg || result.message); return true }
      await commitTaichuPlayerTransaction(e.group_id, { uid: String(e.user_id), bag: a.bag, money: actor.money, contribution: actor.contribution })
      await e.reply(result.msg || result.message || '服务完成。')
      return true
    })
  }

  async taichuCraft (e) { return this.service(e, false) }
  async taichuRepair (e) { return this.service(e, true) }

  async taichuFragment (e) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      if (await guardActionLocked(e)) return true
      const a = await taichuPlayerSnapshot(e.group_id, e.user_id)
      const result = craftTaichuFragment(a.bag, text(e).replace(/^合成古墟/, '').trim())
      if (result.ok) await commitTaichuPlayerTransaction(e.group_id, { uid: String(e.user_id), bag: a.bag })
      await e.reply(result.msg)
      return true
    })
  }

  async taichuMakeSupply (e) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      if (await guardActionLocked(e)) return true
      const name = text(e).replace(/^制作/, '')
      const station = workshop(e)
      if (name === '太初修补包' && !station.ok) { await e.reply(station.msg); return true }
      const a = await taichuPlayerSnapshot(e.group_id, e.user_id)
      const actor = { money: a.money, contribution: station.contribution || 0 }
      const result = makeTaichuSupply(a.bag, name, { actor, workshopLevel: station.level || 0 })
      if (result.ok) await commitTaichuPlayerTransaction(e.group_id, { uid: String(e.user_id), bag: a.bag, money: actor.money, ...(station.ok ? { contribution: actor.contribution } : {}) })
      await e.reply(result.msg)
      return true
    })
  }

  async taichuPatch (e) {
    if (!gate(e)) return false
    return withTaichuLock(e.group_id, async () => {
      if (await guardActionLocked(e, undefined, { skipTaichu: true })) return true
      const state = readTaichuStore(e.group_id)
      const run = findPlayerTaichuRun(state, String(e.user_id))
      if (run && !['route', 'array', 'remnant'].includes(run.node.kind)) { await e.reply('请在古墟非战斗阶段使用修补包。'); return true }
      const a = await taichuPlayerSnapshot(e.group_id, e.user_id)
      const raw = text(e).replace(/^修补太初/, '').trim()
      const result = patchTaichu(a.bag, parts[raw] || raw)
      if (result.ok) await commitTaichuPlayerTransaction(e.group_id, { uid: String(e.user_id), bag: a.bag })
      await e.reply(result.msg)
      return true
    })
  }

  async taichuSupply (e) {
    if (!gate(e)) return false
    return this.perform(e, 'supply')
  }
}
