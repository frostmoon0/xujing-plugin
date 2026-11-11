import { wearPlayerTaichu, taichuBattleReceipt } from '../../components/taichu_combat.js'
import { withGameLock } from '../../components/game_lock.js'
/* ============================================================
 * 洗劫藏宝阁(隐藏玩法) - 指令与流程
 * 触发: #洗劫藏宝阁 / #夜袭宝阁 → 风险告知图 → #确认洗劫 → #洗劫 <1-20> 选档
 * 30分钟洗劫(每5分钟合并播报图片) → 随时 #终止洗劫 / 时间到 → 10分钟逃亡 → 到手
 * PVP: #围剿 @x (洗劫/逃亡中均可, 可连环); 惩罚: 扣背包0~20件(穿身不扣)/天牢0~2小时
 * ============================================================ */
import { BotApi, plugin } from '../../model/api/api.js'
import fs from 'fs'
import path from 'path'
import schedule from 'node-schedule'
import moment from 'moment'
import { Plugin_Name, Plugin_Path } from '../../components/plugin.js'
import xujing_data from '../../components/xujing_data.js'
import { getBag, addItem, tryGiveSecretKey, itemIcon } from '../../components/equip_data.js'
import { getBuffs, calcCombatPower, fightWinRate, fightBestOf5, makeDamageFn } from '../../components/fight.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import {
  raidOpen, RAID_LEVELS, RAID_GUARDS, pickGuards, guardChangeInfo, guardMul, guardPowerFor, guardFight,
  genSegmentLoots, sumLootValue, lootIcon, penaltyCount, deductRandomItems, raidLootCap, isColorfulGf, colorfulGuardBoost, realmNameOf,
  countRare, countColor, RARE_CAP, COLOR_CAP,
  getRaid, setRaid, delRaid, allRaids, setJail, getJailRemain, markRaidHappened, setGuardChangeAt
} from '../../components/raid_data.js'
import { logPlayerEvent } from '../../components/fake_data.js'

const RAID_MIN = 30 // 洗劫时长(分钟)
const ESCAPE_MIN = 10 // 逃亡时长(分钟)
const BC_INTERVAL = 5 // 播报间隔(分钟)

/* ---------- 群播报缓冲: 所有事件(战报/被抓/逃亡/围剿)累计到 5 分钟合并渲染一张图 ---------- */
const bcastPool = {} // gid -> { lines: [], firstAt: ts }
const lastFlush = {} // gid -> ts

/** 事件入队(不立即发送, 到 5 分钟统一发); 首次事件把 lastFlush 视为 5 分钟前, 保证立即首刷 */
function pushBcast (gid, text) {
  if (!bcastPool[gid]) {
    bcastPool[gid] = { lines: [], firstAt: Date.now() }
    if (lastFlush[gid] === undefined) lastFlush[gid] = Date.now() - BC_INTERVAL * 60 * 1000
  }
  bcastPool[gid].lines.push(text)
}

/** 立即冲刷该群缓冲为一张图(5分钟到或兜底时调用) */
async function flushBcast (gid) {
  const p = bcastPool[gid]
  if (!p || !p.lines.length) return
  bcastPool[gid] = null
  lastFlush[gid] = Date.now()
  const lines = ['🌙 藏宝阁洗劫 · 战况汇总', '', ...p.lines, '', '30 分钟洗劫结束将进入逃亡，随时 #终止洗劫']
  const img = await textToImg(lines.join('\n'))
  if (img) sendGroup(gid, img)
  else sendGroup(gid, lines.join('\n'))
}

/* 群昵称缓存(10分钟失效): gid:uid -> {name, at} */
const nickCache = {}

/** 获取群昵称(定时任务无e对象, 用Bot.pickGroup; 取不到回退QQ号) */
async function getNick (gid, uid) {
  const k = `${gid}:${uid}`
  const c = nickCache[k]
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.name
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.getMemberMap) {
      const mm = await g.getMemberMap()
      for (const m of mm) {
        if (String(m[1].user_id) === String(uid)) {
          const n = m[1].card || m[1].nickname || ''
          nickCache[k] = { name: n, at: Date.now() }
          return n
        }
      }
    }
  } catch (err) { }
  nickCache[k] = { name: String(uid), at: Date.now() }
  return String(uid)
}

/** 玩家境界/战力信息 */
async function playerInfo (gid, uid) {
  const battlejson = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
  const u = battlejson[uid] || {}
  const level = Number(u.level) || 0
  const bag = getBag(uid, gid)
  const buff = await getBuffs(uid, gid)
  const { power } = calcCombatPower(level, bag, buff, gid, uid)
  return { level, levelname: u.levelname || '无灵力', bag, buff, power }
}

/** 守卫伤害函数(按守卫战力模拟) */
function guardDmgFn (guardPower) {
  return () => Math.round(guardPower / 2 * (0.85 + Math.random() * 0.3))
}

/** 守卫追捕判定(胜则继续/逃亡成功, 败则被抓); 抢到彩色功法后, 后续守卫难度翻倍 */
async function guardCatch (gid, st) {
  const pi = await playerInfo(gid, st.uid)
  const rareBoost = colorfulGuardBoost(st)
  // 围剿接手后的守卫削弱(第一次×0.8, 之后每次×0.89); 老存档无 guardMult 按 1 处理
  const guardMult = Number(st.guardMult) || 1
  const guardPower = guardPowerFor(pi.power, st.level, st.guardCount, st.inChange, rareBoost, guardMult)
  const dmgMe = makeDamageFn(pi.level, st.uid, 0.15, pi.buff, gid)
  const res = guardFight(pi.power, guardPower, dmgMe, guardDmgFn(guardPower), pi.buff.def)
  wearPlayerTaichu(gid, st.uid, `raid-guard:${st.start}:${st.phase}:${st.lastBcast || st.start}`)
  return { caught: res.winner === 'opp', res, guardPower, myPower: pi.power }
}

/** 被抓惩罚: 按所抢档位价值扣物品(低档上限低/运气好可能不扣; 守卫抓才有天牢) */
async function applyPenalty (gid, st, byGuard, attackerUid = '') {
  const n = penaltyCount(st.level)
  const deducted = n > 0 ? deductRandomItems(st.uid, gid, n) : []
  const msgs = []
  if (byGuard) {
    const jailMin = Math.floor(Math.random() * 121) // 0~120分钟
    await setJail(st.uid, jailMin, gid)
    msgs.push(`守卫将你打入藏宝阁天牢 ${jailMin} 分钟（期间无法进行任何动作）！`)
  }
  if (deducted.length) {
    msgs.push(`你被搜走了：${deducted.map(d => `${lootIcon(d.name)}${d.name}×${d.count}`).join('、')}`)
    if (attackerUid) {
      // 被玩家击败: 战利品归攻击者
      for (const d of deducted) addItem(attackerUid, d.name, d.count, d.attr || null, gid)
      const aname = await getNick(gid, attackerUid)
      msgs.push(`这些物品落入了 ${aname || attackerUid} 手中！`)
    }
  } else {
    msgs.push('你运气不错，背包里没被搜走东西……')
  }
  return msgs
}

/** 逃亡/洗劫成功 → 战利品到手 */
async function grantLoot (gid, st) {
  if (st.loots && st.loots.length) {
    for (const l of st.loots) addItem(st.uid, l.name, l.count, null, gid)
  }
  /* 遗蜕古钥: 洗劫得手后按彩级概率产, 每日每群最多2把 */
  try { if (await tryGiveSecretKey(gid, st.uid)) { const got = await getNick(gid, st.uid); sendGroup(gid, `🗝️ ${got} 洗劫藏宝阁时顺走一把${itemIcon('遗蜕古钥')}【遗蜕古钥】！`) } } catch (err) { }
  await markRaidHappened(gid, moment().format('YYYY-MM-DD'))
}

export class raid extends plugin {
  constructor () {
    super({
      name: '藏宝阁洗劫',
      dsc: '洗劫藏宝阁隐藏玩法',
      event: 'message',
      priority: 55,
      rule: [
        { reg: '^[#＃]?(洗劫藏宝阁|夜袭宝阁|夜探宝阁)$', fnc: 'raidStart' },
        { reg: '^[#＃]?确认洗劫$', fnc: 'raidConfirm' },
        { reg: '^[#＃]?(洗劫|夜袭|夜探)\\s*([0-9]{1,2})$', fnc: 'raidBegin' },
        { reg: '^[#＃]?终止洗劫$', fnc: 'raidStop' },
        /* 抓捕神游蛊 归属南疆蛊虫系统, 此处不得拦截(负向前瞻排除) */
        { reg: '^[#＃]?(围剿|缉拿|抓捕(?!神游蛊))(.*)$', fnc: 'raidBesiege' },
        { reg: '^[#＃]?洗劫状态$', fnc: 'raidStatus' },
        { reg: '^[#＃]?设置换防\\s*(\\d+)\\s*分钟?$', fnc: 'setGuardChange', auth: 'master' },
        { reg: '^[#＃]?清除换防$', fnc: 'clearGuardChange', auth: 'master' }
      ]
    })
    /* 每分钟推进: 洗劫/逃亡计时、5分钟播报、守卫追捕、战利品结算
       防重复注册: 插件若被重复加载/实例化多次, 只保留一个定时器, 避免重复广播/重复抓人 */
    if (!global.__xujingRaidTick__) {
      global.__xujingRaidTick__ = true
      schedule.scheduleJob('* * * * *', () => { raidTick().catch(err => logger.error('[洗劫]推进异常:' + (err && err.stack))) })
    }
  }

  /* ---- 触发: 风险告知图 + 确认 ---- */
  async raidStart (e) {
    if (!e.group_id) { e.reply('洗劫藏宝阁需在群内进行~'); return true }
    if (!raidOpen()) {
      e.reply('🌙 藏宝阁守卫森严，此刻无从下手……每晚 20:30~24:00 才能行动（隐藏玩法，自己找入口~）')
      return true
    }
    const uid = e.user_id
    const gid = String(e.group_id)
    const jailSec = await getJailRemain(uid)
    if (jailSec > 0) {
      e.reply(`⛓️ 你身陷藏宝阁天牢，还需 ${Math.floor(jailSec / 60)} 分 ${jailSec % 60} 秒才能行动……`)
      return true
    }
    const cur = await getRaid(gid, uid)
    if (cur && (cur.phase === 'raid' || cur.phase === 'escape')) {
      e.reply(`你正在${cur.phase === 'raid' ? '洗劫' : '逃亡'}中，发送 #洗劫状态 查看~`)
      return true
    }
    /* 守卫换防提示 */
    const gc = guardChangeInfo()
    const guardMsg = gc.inChange
      ? '⚠️ 侍卫正值换防！守卫松懈，此时强抢胜算更高！'
      : `侍卫戒备森严……距下次换防还有约 ${gc.nextMin} 分钟，可考虑等换防再动手`
    /* 风险告知图 */
    const lines = [
      '🌙 洗劫藏宝阁 · 风险告知',
      `开放时间：每晚 20:30~24:00\n洗劫 30 分钟 + 逃亡 10 分钟，可随时 #终止洗劫`,
      `\n${guardMsg}`,
      '',
      '📦 共 20 档难度（自不量力也可强闯，风险自担）：'
    ]
    RAID_LEVELS.forEach((lv, i) => {
      const g = RAID_GUARDS[i] || []
      lines.push(`${i + 1}. ${lv.name}（守卫×${lv.power} · 建议${realmNameOf(lv.req)}）\n   值守：${g.join('、')}（1~3人随机）`)
    })
    lines.push('',
      '⚔️ 惩罚须知：',
      '· 被守卫抓到：洗劫所得尽数散落 + 按所抢档位价值随机掉落背包物品（低档掉落上限低，运气好可能不掉；穿身装备不掉，一件一件按样数掉）+ 天牢 0~2 小时（禁止一切动作）',
      '· 被其他玩家围剿击败：背包随机掉落物品归围剿者，且洗劫抢到的东西也会被对方全部拿走（可螳螂捕蝉黄雀在后）',
      '· 当天洗劫过 → 次日拍卖行系统好货减少（起拍价不变）',
      '',
      '回复 #确认洗劫 查看 20 档明细并开始')
    /* 默认不分页, 全部内容渲染成一张长图 */
    const img = await textToImg(lines.join('\n'))
    if (img) e.reply(img)
    else e.reply(lines.join('\n'))
    return true
  }

  /* ---- 确认: 显示档位选择 + 换防倒计时 ---- */
  async raidConfirm (e) {
    if (!raidOpen()) { e.reply('藏宝阁此刻守卫森严，20:30~24:00 再来~'); return true }
    const gc = guardChangeInfo()
    const guardMsg = gc.inChange
      ? '⚠️ 守卫正值换防！难度降低，此时强抢胜算更高！'
      : `守卫戒备……距下次换防约 ${gc.nextMin} 分钟`
    const lines = [
      '🌙 确认洗劫 · 选择难度档位',
      guardMsg,
      '',
      '📢 操作：回复 #洗劫 <数字> 开抢（如：#洗劫 12）',
      '',
      '━━ 20 档难度 ━━'
    ]
    RAID_LEVELS.forEach((lv, i) => lines.push(`${i + 1}. ${lv.name}　守卫×${lv.power}　建议${realmNameOf(lv.req)}`))
    lines.push('', '档位越高，宝贝越好、守卫越强、被抓越惨！')
    /* 默认不分页, 全部内容渲染成一张长图 */
    const img = await textToImg(lines.join('\n'))
    if (img) e.reply(img)
    else e.reply(lines.join('\n'))
    return true
  }

  /* ---- 开始洗劫 ---- */
  async raidBegin (e) {
    const m = String(e.msg || '').match(/([0-9]{1,2})/)
    const lvl = m ? parseInt(m[1]) : 0
    if (lvl < 1 || lvl > RAID_LEVELS.length) { e.reply(`请输入 1~${RAID_LEVELS.length} 选择难度档位`); return true }
    if (!e.group_id) { e.reply('需在群内洗劫~'); return true }
    if (!raidOpen()) { e.reply('此刻守卫森严，20:30~24:00 才能行动~'); return true }
    const uid = e.user_id
    const gid = String(e.group_id)
    const jailSec = await getJailRemain(uid)
    if (jailSec > 0) {
      e.reply(`⛓️ 你身陷藏宝阁天牢，还需 ${Math.floor(jailSec / 60)} 分 ${jailSec % 60} 秒才能行动……`)
      return true
    }
    const cur = await getRaid(gid, uid)
    if (cur && (cur.phase === 'raid' || cur.phase === 'escape')) { e.reply('你已在行动中，发送 #洗劫状态 查看~'); return true }
    const pi = await playerInfo(gid, uid)
    const guards = pickGuards(lvl)
    const gc = guardChangeInfo()
    const st = {
      uid, gid, level: lvl, levelName: RAID_LEVELS[lvl - 1].name,
      phase: 'raid', start: Date.now(),
      raidEnd: Date.now() + RAID_MIN * 60 * 1000,
      guardNames: guards.names, guardCount: guards.count,
      inChange: gc.inChange,
      guardMult: 1, // 全新洗劫: 守卫满强度(围剿接手后才削弱)
      pLevel: pi.level,
      loots: [], pending: [], value: 0, lootTotal: 0, rareCnt: 0, colorCnt: 0, rareFlag: false, lastBcast: Date.now(),
      myPower: pi.power
    }
    await setRaid(gid, uid, st)
    try {
      const nm = await getNick(gid, uid)
      logPlayerEvent(gid, `【洗劫】散修 ${nm} 夜袭藏宝阁，潜入【${st.levelName}】`)
    } catch (err) { }
    const guardLine = `值守守卫：${guards.names.join('、')}（${guards.count}人${gc.inChange ? '，正值换防·松懈' : ''}）`
    e.reply([segment.at(uid), `\n🌙 你已潜入【${st.levelName}】开始洗劫！\n${guardLine}\n（你的战力 ${pi.power}，守卫强度×${RAID_LEVELS[lvl - 1].power}）\n每 5 分钟播报一次战况，30 分钟结束进入逃亡\n随时可 #终止洗劫`])
    return true
  }

  /* ---- 终止洗劫 → 进入逃亡 ---- */
  async raidStop (e) {
    const gid = String(e.group_id || '')
    const uid = e.user_id
    const st = await getRaid(gid, uid)
    if (!st) { e.reply('你当前没有进行中的洗劫~'); return true }
    if (st.phase !== 'raid') { e.reply('你已不在洗劫阶段~'); return true }
    st.phase = 'escape'
    st.escapeEnd = Date.now() + ESCAPE_MIN * 60 * 1000
    await setRaid(gid, uid, st)
    const val = sumLootValue(st.loots)
    const rareNote = st.rareFlag ? `\n⚠️ 你抢到了彩色功法，${st.guardNames.join('、')} 暴怒，后续守卫难度翻倍！` : ''
    e.reply([segment.at(uid), `\n🏃 你终止洗劫，带着战利品开始逃亡！（价值约 ${val} 灵石）${rareNote}\n10 分钟内躲过值守守卫追杀即可到手，逃亡中也可能被他人围剿！`])
    return true
  }

  /* ---- 状态 ---- */
  async raidStatus (e) {
    const gid = String(e.group_id || '')
    const uid = e.user_id
    const st = await getRaid(gid, uid)
    if (!st) { e.reply('你当前没有进行中的洗劫~'); return true }
    const now = Date.now()
    const lines = [`🌙 你的洗劫状态`]
    if (st.phase === 'raid') {
      const left = Math.max(0, Math.ceil((st.raidEnd - now) / 60000))
      lines.push(`· 阶段：洗劫中（剩余 ${left} 分钟）`)
    } else if (st.phase === 'escape') {
      const left = Math.max(0, Math.ceil((st.escapeEnd - now) / 60000))
      lines.push(`· 阶段：逃亡中（剩余 ${left} 分钟）`)
    } else {
      lines.push(`· 阶段：${st.phase}`)
    }
    lines.push(`· 地点：${RAID_LEVELS[st.level - 1] ? RAID_LEVELS[st.level - 1].name : st.levelName}`)
    if (st.loots && st.loots.length) lines.push(`· 已得：${st.loots.map(l => `${lootIcon(l.name)}${l.name}×${l.count}`).join('、')}`)
    else lines.push('· 已得：暂无所获……')
    lines.push('', '回复 #终止洗劫 提前收手转逃亡 · #围剿 @他人 可抢其战利品')
    const img = await textToImg(lines.join('\n'))
    if (img) e.reply(img)
    else e.reply(lines.join('\n'))
    return true
  }

  /* ---- 管理员: 把下一次侍卫换防一次性提前到N分钟后(用后自动恢复每日排程) ---- */
  async setGuardChange (e) {
    const m = String(e.msg || '').match(/设置换防\s*(\d+)\s*分钟?/)
    const min = m ? parseInt(m[1]) : 0
    if (!(min >= 1 && min <= 120)) {
      e.reply('请输入 1~120 分钟：如 #设置换防 2（把下一次换防提前到 2 分钟后，一次性，3 分钟换防窗口，用后自动恢复每日排程）')
      return true
    }
    const startMs = Date.now() + min * 60 * 1000
    setGuardChangeAt(startMs)
    const t = new Date(startMs)
    const hh = String(t.getHours()).padStart(2, '0')
    const mm = String(t.getMinutes()).padStart(2, '0')
    e.reply(`⚠️ 已把下一次侍卫换防提前到 ${min} 分钟后（${hh}:${mm} 开始，换防窗口 3 分钟，守卫松懈难度降低；一次性，用后自动恢复每日排程）~`)
    return true
  }

  /* ---- 管理员: 清除换防覆盖(恢复正常每日seed排程) ---- */
  async clearGuardChange (e) {
    setGuardChangeAt(0)
    e.reply('✅ 已清除换防覆盖，恢复每日正常排程~')
    return true
  }

  /* ---- 围剿(洗劫/逃亡中均可, 可连环) ---- */
  async raidBesiege (e) {
    if (!e.group_id) { e.reply('需在群内围剿~'); return true }
    if (!raidOpen()) { e.reply('此刻守卫森严，无人可围剿~'); return true }
    if (!e.at) { e.reply('围剿谁呢？@出来！如：#围剿 @正在洗劫的人'); return true }
    const gid = String(e.group_id)
    const atkUid = e.user_id
    const tgtUid = e.at
    if (String(atkUid) === String(tgtUid)) { e.reply('围剿自己？不存在的~'); return true }
    const tst = await getRaid(gid, tgtUid)
    if (!tst || (tst.phase !== 'raid' && tst.phase !== 'escape')) {
      e.reply('对方现在并没有在洗劫/逃亡中~')
      return true
    }
    /* 战斗 */
    const atk = await playerInfo(gid, atkUid)
    const tgt = await playerInfo(gid, tgtUid)
    const { win } = fightWinRate(atk.level, tgt.level, atkUid, tgtUid, 8, atk.buff, tgt.buff, gid)
    const dmgMe = makeDamageFn(atk.level, atkUid, 0.15, atk.buff, gid)
    const dmgOpp = makeDamageFn(tgt.level, tgtUid, 0.15, tgt.buff, gid)
    // defMe 应为攻击者自己的防御(受伤减免), 原先误传成对方的防御
    const result = fightBestOf5(win, { dmgMe, dmgOpp, defMe: atk.buff.def })
    const wearReceipt = taichuBattleReceipt(e, 'raid-pvp')
    wearPlayerTaichu(gid, atkUid, wearReceipt)
    wearPlayerTaichu(gid, tgtUid, wearReceipt)
    const atkName = await getNick(gid, atkUid)
    const tgtName = await getNick(gid, tgtUid)
    if (result.winner === 'opp') {
      e.reply([segment.at(atkUid), `\n你围剿失败！${tst.guardNames.join('、')}把你也轰了出去~`])
      pushBcast(gid, `⚔️ ${atkName} 围剿 ${tgtName} 失败，被守卫轰了出去！`)
      return true
    }
    /* 围剿成功: 目标被击败 → 扣物品给攻击者; 攻击者接手战利品并进入逃亡 */
    const penMsgs = await applyPenalty(gid, tst, false, atkUid)
    const stolen = tst.loots || []
    await delRaid(gid, tgtUid)
    /* 攻击者接手战利品, 进入10分钟逃亡(螳螂捕蝉黄雀在后); 若攻击者自己也在洗劫/逃亡则合并自身战利品
       (修复: 原先只合并 phase==='raid' 的战利品, 逃亡中再围剿他人会丢掉自己已缴获的战利品 → 搜刮的东西进不了背包) */
    const mySt = await getRaid(gid, atkUid)
    const ownLoots = (mySt && (mySt.phase === 'raid' || mySt.phase === 'escape') && mySt.loots) || []
    const allLoots = [...ownLoots, ...stolen]
    /* 守卫削弱: 第一次围剿接手守卫×0.8, 之后连环每次×0.89(黄雀更易得手); 老存档无 guardMult 按 1 算 */
    const _gMult = Number(tst.guardMult) || 1
    const guardMult = _gMult >= 1 ? 0.8 : Number((_gMult * 0.89).toFixed(2))
    const newSt = {
      uid: atkUid, gid, level: tst.level, levelName: tst.levelName,
      phase: 'escape', start: Date.now(), escapeEnd: Date.now() + ESCAPE_MIN * 60 * 1000,
      guardNames: tst.guardNames, guardCount: tst.guardCount, inChange: tst.inChange,
      guardMult,
      loots: allLoots, pending: [], value: ((mySt && mySt.value) || 0) + (tst.value || 0),
      lootTotal: allLoots.reduce((s, l) => s + l.count, 0),
      rareCnt: Math.min(RARE_CAP, countRare(allLoots)),
      colorCnt: Math.min(COLOR_CAP, countColor(allLoots)),
      rareFlag: allLoots.some(l => isColorfulGf(l.name)),
      lastBcast: Date.now(), myPower: atk.power
    }
    await setRaid(gid, atkUid, newSt)
    const lootStr = stolen.length ? stolen.map(l => `${lootIcon(l.name)}${l.name}×${l.count}`).join('、') : '（对方暂无战利品）'
    const rareNote2 = newSt.rareFlag ? `\n⚠️ 战利品中有彩色功法，${tst.guardNames.join('、')} 暴怒，后续守卫难度翻倍！` : ''
    e.reply([segment.at(atkUid), `\n🐦 螳螂捕蝉，黄雀在后！你围剿成功！\n缴获：${lootStr}\n${penMsgs.join('\n')}${rareNote2}\n🏃 你接手战利品，进入 10 分钟逃亡！`])
    pushBcast(gid, `🐦 ${atkName} 围剿 ${tgtName} 成功，夺走其战利品！（缴获：${lootStr}）`)
    /* 被抓的人即时@告知(不走5分钟合并, 立即单独发): 战利品被夺走 + 背包被搜走 */
    notifyAt(gid, tgtUid, `⛓️ 你被 ${atkName} 围剿击败！${stolen.length ? `洗劫所得尽数被夺走：${lootStr}` : '洗劫行动被强行终止，一无所获！'}\n${penMsgs.join('\n')}`)
    return true
  }
}

/* ---------- 每分钟推进逻辑 ---------- */
async function raidTick () {
  try {
    const raids = await allRaids()
    const now = Date.now()
    /* 洗劫/逃亡阶段推进: 所有事件(战报/被抓/逃亡/围剿)累计入队, 5分钟统一渲染一张图 */
    for (const { gid, uid } of raids) {
      await withGameLock(gid, async () => {
      const st = await getRaid(gid, uid)
      if (!st) return
      const uname = await getNick(gid, uid)
      if (st.phase === 'raid') {
        /* 洗劫阶段推进 */
        if (now >= st.raidEnd) {
          /* 30分钟到 → 进入逃亡 */
          st.phase = 'escape'
          st.escapeEnd = now + ESCAPE_MIN * 60 * 1000
          await setRaid(gid, uid, st)
          const val = sumLootValue(st.loots)
          const rareNote = st.rareFlag ? '，⚠️ 因抢到彩色功法，后续守卫难度翻倍！' : ''
          pushBcast(gid, `🌙 ${st.guardNames.join('、')} 归来，${uname} 结束洗劫带着战利品开始逃亡！（价值约 ${val} 灵石${rareNote}）`)
          notifyAt(gid, uid, `🌙 ${st.guardNames.join('、')} 归来！你结束洗劫带着战利品开始逃亡！（价值约 ${val} 灵石${rareNote}）\n10 分钟内躲过守卫追杀即可到手！`)
        } else if (now - st.lastBcast >= BC_INTERVAL * 60 * 1000) {
          /* 每5分钟: 结算片段战利品(随机性+整场上限50件+红彩≤5/彩色≤1+富贵险中求) + 守卫追捕判定 */
          const budget = Math.max(0, raidLootCap(st.level) - (st.lootTotal || 0))
          const seg = genSegmentLoots(st.level, st.pLevel, budget, RARE_CAP - (st.rareCnt || 0), COLOR_CAP - (st.colorCnt || 0))
          if (seg.length) {
            st.pending.push(...seg)
            st.loots.push(...seg)
            st.value += sumLootValue(seg)
            st.lootTotal = (st.lootTotal || 0) + seg.reduce((s, l) => s + l.count, 0)
            st.rareCnt = Math.min(RARE_CAP, (st.rareCnt || 0) + countRare(seg))
            st.colorCnt = Math.min(COLOR_CAP, (st.colorCnt || 0) + countColor(seg))
            if (!st.rareFlag && seg.some(l => isColorfulGf(l.name))) {
              st.rareFlag = true
              pushBcast(gid, `🌈 ${uname} 在【${st.levelName}】抢到了${itemIcon('太阴月华诀')}彩色功法（太阴月华诀）！${st.guardNames.join('、')} 暴怒，后续守卫难度翻倍！`)
            }
          }
          /* 守卫追捕 */
          const ch = await guardCatch(gid, st)
          if (ch.caught) {
            const msgs = await applyPenalty(gid, st, true)
            await delRaid(gid, uid)
            logPlayerEvent(gid, `【被捕】散修 ${uname} 洗劫藏宝阁被守卫抓获，押入天牢`)
            pushBcast(gid, `⛓️ 洗劫被抓！\n${st.guardNames.join('、')} 追上了 ${uname}，将其拿下！\n${msgs.join('\n')}\n（洗劫所得尽数散落）`)
            notifyAt(gid, uid, `⛓️ 洗劫被抓！\n${st.guardNames.join('、')} 追上了你，将你拿下！\n${msgs.join('\n')}\n（洗劫所得尽数散落）`)
            return
          }
          st.lastBcast = now
          await setRaid(gid, uid, st)
          /* 本片段归入战报(空手也播报: 显示空手而归) */
          pushBcast(gid, seg.length
            ? `⚔️ ${uname} 在【${st.levelName}】抢到：${seg.map(l => `${lootIcon(l.name)}${l.name}×${l.count}`).join('、')}`
            : `⚔️ ${uname} 在【${st.levelName}】空手而归……`)
        }
      } else if (st.phase === 'escape') {
        /* 逃亡阶段推进 */
        if (now >= st.escapeEnd) {
          /* 逃亡成功 → 战利品到手 */
          await grantLoot(gid, st)
          await delRaid(gid, uid)
          logPlayerEvent(gid, `【洗劫】散修 ${uname} 洗劫藏宝阁得手，满载而归`)
          const val = sumLootValue(st.loots)
          const lootStr = st.loots.length ? st.loots.map(l => `${lootIcon(l.name)}${l.name}×${l.count}`).join('、') : '空手而归'
          pushBcast(gid, `🏁 ${uname} 逃亡成功！战利品到手：${lootStr}（价值约 ${val} 灵石）`)
          notifyAt(gid, uid, `🏁 逃亡成功！战利品到手：${lootStr}（价值约 ${val} 灵石）`)
        } else if (now - (st.lastBcast || st.start) >= BC_INTERVAL * 60 * 1000) {
          /* 逃亡中每5分钟守卫追捕判定 */
          const ch = await guardCatch(gid, st)
          if (ch.caught) {
            const msgs = await applyPenalty(gid, st, true)
            await delRaid(gid, uid)
            logPlayerEvent(gid, `【被捕】散修 ${uname} 逃亡失败，被守卫擒拿归案`)
            pushBcast(gid, `⛓️ 逃亡失败！${st.guardNames.join('、')} 将 ${uname} 擒拿归案！\n${msgs.join('\n')}`)
            notifyAt(gid, uid, `⛓️ 逃亡失败！${st.guardNames.join('、')} 将你擒拿归案！\n${msgs.join('\n')}`)
          } else {
            st.lastBcast = now
            await setRaid(gid, uid, st)
          }
        }
      }
      })
    }
    /* 统一冲刷: 距上次冲刷满 5 分钟才合并渲染一张图发送(首次事件立即发) */
    for (const gid of Object.keys(bcastPool)) {
      const p = bcastPool[gid]
      if (!p || !p.lines.length) continue
      const sinceLast = now - (lastFlush[gid] || 0)
      const sinceFirst = now - p.firstAt
      if (sinceLast >= BC_INTERVAL * 60 * 1000 || sinceFirst >= BC_INTERVAL * 60 * 1000) {
        try { await flushBcast(gid) } catch (err) { logger.error('[洗劫]汇总发送失败:' + (err && err.message)) }
      }
    }
  } catch (err) {
    logger.error('[洗劫]tick异常:' + (err && err.stack))
  }
}

/** 群内@指定用户即时提示(关键事件: 被抓/开始逃亡/逃亡成功, 不走5分钟合并, 立即单独发) */
function notifyAt (gid, uid, text) {
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.sendMsg) {
      /* 关键: raidTick/allRaids 拿到的 uid 是字符串(redis key 解析), 而 icqq 的 segment.at()
         传字符串会走"频道AT"(qq:0+id)分支, 群聊里@无效 → 必须转成数字 */
      const at = segment.at(typeof uid === 'string' ? Number(uid) : uid)
      g.sendMsg([at, `\n${text}`])
    }
  } catch (err) {
    logger.error('[洗劫]@提示发送失败:' + (err && err.message))
  }
}

/** 群发消息(定时任务用) */
function sendGroup (gid, msg) {
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.sendMsg) g.sendMsg(msg)
  } catch (err) {
    logger.error('[洗劫]群发失败:' + (err && err.message))
  }
}
