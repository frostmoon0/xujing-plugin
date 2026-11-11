/* ============================================================
 * 虚境灵兽(宠物)系统 - 指令与流程
 * #搜寻宠物/搜寻灵兽 → 0~30分钟 → 遇宠(回复1抓/2放走) → 捕抓/放走
 * #灵兽袋 / #宠物详情N / #宠物改名N / #放生N / #宠物目录 / #赠送宠物
 * 数字指令走斥驳路由(own-state + isCurrent + yield)
 * priority=50 (wanhun45 之后, equip60 之前)
 * ============================================================ */
import { plugin } from '../../model/api/api.js'
import schedule from 'node-schedule'
import moment from 'moment'
import path from 'path'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import { getWorld, getLoc } from '../../components/world_data.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { speciesMeta, qualityNameOf, PET_QUALITY } from '../../components/pet_species.js'
import { Plugin_Name, Plugin_Path } from '../../components/plugin.js'
import xujing_data from '../../components/xujing_data.js'
import { getBag } from '../../components/equip_data.js'
import { getBuffs, calcCombatPower } from '../../components/fight.js'
import {
  getPetState, savePetState, activePetGroups,
  startSearch, searchStatus, resolveEncounter, settlePet,
  petBagText, petDetailText, catalogText, releasePet, renamePet, giftPet,
  deployPet, recallPet, activePetOf, petPower, canBattle, groupPetRank,
  tickPetGroup, encounterText, guideText, stageNameOf,
  redWindowText, rainbowWindowText, settlePlayerSearch, PET_SEARCH_CMD_REG
} from '../../components/pet_data.js'

/* ---------- 群内@通知 / 群发 ---------- */
function notifyAt (gid, uid, text) {
  try {
    const group = Bot.pickGroup(gid)
    if (group && group.sendMsg) group.sendMsg([segment.at(Number(uid)), `\n${text}`])
  } catch (err) { }
}
function sendGroup (gid, text) {
  try {
    const group = Bot.pickGroup(gid)
    if (group && group.sendMsg) group.sendMsg(text)
  } catch (err) { }
}
function pickText (list) {
  return list[Math.floor(Math.random() * list.length)]
}

/* 品质显示色(1白~7彩) */
const QUALITY_COLOR = { 1: '#cfcfcf', 2: '#7be07b', 3: '#5aa8ff', 4: '#b06aff', 5: '#ffd34d', 6: '#ff5a5a', 7: '#ff69d9' }
/** 品质样式: 红/彩用渐变流光(彩), 其余纯色 */
function qualityStyle (q) {
  if (q === 6) return 'background:linear-gradient(135deg,#ff5f6d 0%,#ff9a3d 40%,#ffd75c 70%,#ff9a5f 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:#ff5a5a;filter:drop-shadow(0 0 5px rgba(255,100,70,.4))'
  if (q === 7) return 'background:linear-gradient(135deg,#ff5f6d,#ffd75c,#7cf0a0,#6fc7ff,#d9a8ff,#ff8fd8);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:#ff69d9;filter:drop-shadow(0 0 5px rgba(255,150,255,.45))'
  return `color:${QUALITY_COLOR[q] || '#cfcfcf'}`
}

/** 渲染灵兽榜图片(专属面板, 暗色灵气风) */
async function renderPetRank ({ list, title = '🐾 虚境 · 灵兽榜', sub = '谁家灵兽 · 可冠群雄', date = '', foot = '', stats = null }) {
  const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
  return await puppeteer.screenshot(`${Plugin_Name}/rank/pet`, {
    tplFile: path.join(Plugin_Path, 'resources', 'rank', 'pet.html'),
    pluResPath: resPath,
    _res_path: resPath,
    saveId: `pet-rank-${date}`,
    rankTitle: title,
    rankSub: sub,
    rankDate: date,
    rankFoot: foot,
    rankStats: stats || null,
    rankList: list.map((it, i) => {
      const rank = i + 1
      return {
        rank,
        medal: ['🥇', '🥈', '🥉'][i] || `${rank}`,
        cls: rank === 1 ? 'first' : rank === 2 ? 'second' : rank === 3 ? 'third' : '',
        nick: it.nick,
        name: it.name,
        quality: it.quality,
        qualityIcon: (PET_QUALITY[it.quality] && PET_QUALITY[it.quality].icon) || '',
        qualityStyle: qualityStyle(it.quality),
        qualityColor: QUALITY_COLOR[it.quality] || '#cfcfcf',
        bloodline: it.bloodline,
        stage: it.stage,
        canBattle: it.canBattle,
        power: it.power,
        maxPower: it.maxPower,
        progress: it.progress,
        hatch: it.hatch
      }
    })
  })
}

/** 玩家战力(境界+装备+buff, 与决斗/幻境同源) */
async function playerPowerOf (gid, uid) {
  try {
    const battlejson = await xujing_data.getQQYUserBattle(uid, null, false, `${String(gid)}.json`)
    const level = Number((battlejson[uid] || {}).level) || 0
    const bag = getBag(uid, gid)
    const buff = await getBuffs(uid, gid)
    const { power } = calcCombatPower(level, bag, buff, gid, uid)
    return power || 0
  } catch (err) {
    return 0
  }
}

/** 宠物显示名 */
function petDisplayName (pet) {
  if (pet.customName) return pet.customName
  const meta = speciesMeta(pet.speciesId)
  return meta ? meta.species.name : pet.speciesId
}

/* ---------- 数字待选状态(斥驳路由用): 出战选宠等 ---------- */
const pending = new Map()
function keyOf (e) { return `${e.group_id}:${e.user_id}` }

export class pet extends plugin {
  constructor () {
    super({
      name: '灵兽宠物',
      dsc: '灵兽搜寻/捕抓/养成/图鉴',
      event: 'message',
      priority: 50,
      rule: [
        { reg: PET_SEARCH_CMD_REG, fnc: 'searchPet' },
        { reg: '^[#＃]?(搜寻状态|搜寻进度)$', fnc: 'searchStatus' },
        { reg: '^[#＃]?(灵兽袋|宠物袋|我的灵兽|我的宠物)$', fnc: 'petBag' },
        { reg: '^[#＃]?(宠物图鉴|宠物目录|灵兽图鉴|灵兽目录|灵兽大全)(.*)$', fnc: 'petCatalog' },
        { reg: '^[#＃]?(宠物详情|灵宠详情|灵兽详情)\\s*(\\d+)$', fnc: 'petDetail' },
        { reg: '^[#＃]?(宠物改名|宠物命名)\\s*(\\d+)\\s*(\\S+)$', fnc: 'petRename' },
        { reg: '^[#＃]?(放生|释放)\\s*(\\d+)$', fnc: 'petRelease' },
        { reg: '^[#＃]?(赠送宠物|宠物赠送|送宠物)(.*)$', fnc: 'petGift' },
        { reg: '^[#＃]?(宠物出战|灵宠出战|灵兽出战)\\s*(\\d+)?$', fnc: 'petDeploy' },
        { reg: '^[#＃]?(收回宠物|收回灵兽|收回)$', fnc: 'petRecall' },
        { reg: '^[#＃]?(灵兽玩法|宠物玩法|灵兽攻略)$', fnc: 'petGuide' },
        { reg: '^[#＃]?(宠物榜|灵兽榜|灵宠榜|宠物排行|灵兽排行)$', fnc: 'petRank' },
        { reg: '^[#＃]?[0-9]+$', fnc: 'petPick' }
      ]
    })
    /* 每分钟推进: 搜寻到点遇宠 / 孵化破壳 / 成长晋级 / 红彩窗口
       防重复注册: 插件重复加载时只保留一个定时器 */
    if (!global.__xujingPetTick__) {
      global.__xujingPetTick__ = true
      schedule.scheduleJob('* * * * *', () => { petTick().catch(err => logger.error('[灵兽]推进异常:' + (err && err.stack))) })
    }
  }

  /* ---- #搜寻宠物 ---- */
  async searchPet (e) {
    if (!e.group_id) { e.reply('请在群内搜寻灵兽~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const state = getPetState(gid)
    /* 定时器可能因重启/延迟漏掉到期点，命令进来时先惰性结算，避免旧搜寻被新指令覆盖 */
    settlePlayerSearch(state, gid, uid)
    /* 若有未处理遇宠: 无条件抢占回复权, 玩家可重新回数字而不失灵 */
    const enc = state.encounter[uid]
    if (enc && enc.expireAt > Date.now()) {
      await forceLock(gid, uid, 'pet')
      e.reply(searchStatus(state, uid))
      return true
    }
    const region = getLoc(getWorld(gid), uid)
    const r = startSearch(state, uid, region)
    e.reply(r.msg)
    return true
  }

  /* ---- #搜寻状态 ---- */
  async searchStatus (e) {
    if (!e.group_id) { e.reply('请在群内查看~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const state = getPetState(gid)
    settlePlayerSearch(state, gid, uid)
    const enc = state.encounter[uid]
    if (enc && enc.expireAt > Date.now()) {
      /* 无条件抢占 'pet' 锁, 确保数字回复走本系统(遇宠数字被吃后可恢复) */
      await forceLock(gid, uid, 'pet')
    }
    e.reply(searchStatus(state, uid))
    return true
  }

  /* ---- #灵兽袋 ---- */
  async petBag (e) {
    if (!e.group_id) { e.reply('请在群内查看~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const state = getPetState(gid)
    for (const p of (state.bag[uid] || [])) settlePet(p)
    const text = petBagText(state, uid)
    try {
      const img = await textToImg(text)
      if (img) { e.reply(img); return true }
    } catch (err) { }
    e.reply(text)
    return true
  }

  /* ---- #宠物图鉴 / #宠物目录 ---- */
  async petCatalog (e) {
    if (!e.group_id) { e.reply('请在群内查看~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const m = String(e.msg || '').match(/(?:宠物图鉴|宠物目录|灵兽图鉴|灵兽目录|灵兽大全)(.*)$/)
    const filter = (m && m[1] ? m[1] : '').trim()
    const state = getPetState(gid)
    const text = catalogText(state, uid, filter)
    try {
      const img = await textToImg(text)
      if (img) { e.reply(img); return true }
    } catch (err) { }
    e.reply(text)
    return true
  }

  /* ---- #宠物详情 N ---- */
  async petDetail (e) {
    if (!e.group_id) { e.reply('请在群内查看~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const m = String(e.msg || '').match(/(\d+)/)
    const idx = m ? Number(m[1]) : 0
    const state = getPetState(gid)
    const bag = state.bag[uid] || []
    const pet = bag[idx - 1]
    if (!pet) { e.reply(`序号超出范围，发送 #灵兽袋 查看你的宠物（共 ${bag.length} 只）~`); return true }
    settlePet(pet)
    const text = petDetailText(pet)
    try {
      const img = await textToImg(text)
      if (img) { e.reply(img); return true }
    } catch (err) { }
    e.reply(text)
    return true
  }

  /* ---- #宠物改名 N 名字 ---- */
  async petRename (e) {
    if (!e.group_id) { e.reply('请在群内操作~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const m = String(e.msg || '').match(/宠物(?:改名|命名)\s*(\d+)\s*(\S+)/)
    if (!m) return true
    const state = getPetState(gid)
    const r = renamePet(state, uid, Number(m[1]), m[2])
    e.reply(r.msg)
    return true
  }

  /* ---- #放生 N ---- */
  async petRelease (e) {
    if (!e.group_id) { e.reply('请在群内操作~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const m = String(e.msg || '').match(/(\d+)/)
    const state = getPetState(gid)
    const r = releasePet(state, uid, m ? Number(m[1]) : 0)
    e.reply(r.msg)
    return true
  }

  /* ---- #赠送宠物 @玩家 序号 ---- */
  async petGift (e) {
    if (!e.group_id) { e.reply('请在群内赠送~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const msg = String(e.msg || '').replace(/^[#＃]/, '').trim()
    const m = msg.match(/(?:赠送宠物|宠物赠送|送宠物)\s*(.*)$/)
    if (!m) return true
    const nums = (m[1].match(/\d+/g) || []).map(Number)
    /* 目标: 优先 @(segment.at), 否则若有两个数字取第一个为目标 */
    let target = e.at || (nums.length >= 2 ? nums[0] : null)
    const idx = nums.length ? nums[nums.length - 1] : 0
    if (!target) { e.reply('请@要赠送的玩家，如：#赠送宠物 @玩家 1'); return true }
    if (String(target) === String(uid)) { e.reply('不能送给自己~'); return true }
    try {
      const mm = await e.group.getMemberMap()
      let found = false
      for (const x of mm) if (String(x[1].user_id) === String(target)) found = true
      if (!found) { e.reply('对方不在本群，无法赠送~'); return true }
    } catch (err) { }
    const state = getPetState(gid)
    const r = giftPet(state, uid, String(target), idx)
    e.reply(r.msg)
    return true
  }

  /* ---- #宠物出战 [N] ---- */
  async petDeploy (e) {
    if (!e.group_id) { e.reply('请在群内操作~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const state = getPetState(gid)
    const m = String(e.msg || '').match(/(\d+)/)
    /* 带序号: 直接出战 */
    if (m) {
      const r = deployPet(state, uid, Number(m[1]))
      e.reply(r.msg)
      return true
    }
    /* 不带序号: 弹可出战列表, 回复数字选择(走斥驳路由) */
    if (state.encounter[uid] && state.encounter[uid].expireAt > Date.now()) {
      e.reply('你还有一只未定夺的灵兽，先回复 1 捕获 / 2 放走 处理它吧~')
      return true
    }
    const bag = state.bag[uid] || []
    for (const p of bag) settlePet(p)
    const ready = bag.map((p, i) => ({ idx: i + 1, p })).filter(x => canBattle(x.p.stage))
    if (!ready.length) { e.reply('你没有可出战的灵兽（幼崽/灵蛋不可出战，须至少年~）'); return true }
    await forceLock(gid, uid, 'pet')
    pending.set(keyOf(e), { type: 'deploy', list: ready, at: Date.now() })
    const lines = ready.map(x => `${x.idx}. ${qualityNameOf(x.p.quality)}【${petDisplayName(x.p)}】· ${stageNameOf(x.p.stage)} · 战力 ${petPower(x.p)}`)
    e.reply(`⚔️ 请回复序号选择出战的灵兽（5 分钟内有效）：\n${lines.join('\n')}`)
    return true
  }

  /* ---- #收回宠物 ---- */
  async petRecall (e) {
    if (!e.group_id) { e.reply('请在群内操作~'); return true }
    const gid = String(e.group_id)
    const uid = e.user_id
    const state = getPetState(gid)
    const r = recallPet(state, uid)
    e.reply(r.msg)
    return true
  }

  /* ---- #灵兽玩法 ---- */
  async petGuide (e) {
    const text = guideText()
    try {
      const img = await textToImg(text)
      if (img) { e.reply(img); return true }
    } catch (err) { }
    e.reply(text)
    return true
  }

  /* ---- #宠物榜 ---- */
  async petRank (e) {
    if (!e.group_id) { e.reply('请在群内查看灵兽榜~'); return true }
    const gid = String(e.group_id)
    const data = groupPetRank(gid, 20)
    if (!data.length) { e.reply('本群还没有灵兽上榜，快 #搜寻宠物 觅一只灵兽吧~'); return true }
    /* 群昵称映射 */
    const nickMap = {}
    try {
      const mm = await e.group.getMemberMap()
      for (const m of mm) nickMap[String(m[1].user_id)] = m[1].card || m[1].nickname || String(m[1].user_id)
    } catch (err) { }
    const list = data.map(d => ({ ...d, nick: nickMap[String(d.uid)] || String(d.uid) }))
    /* 品质统计 */
    const counts = [1, 2, 3, 4, 5, 6, 7].map(q => ({ q, count: list.filter(d => d.quality === q).length })).filter(s => s.count > 0)
    const stats = counts.map(s => ({ name: `${PET_QUALITY[s.q].name}${PET_QUALITY[s.q].icon}`, count: s.count }))
    const img = await renderPetRank({
      list,
      date: moment().format('YYYY-MM-DD'),
      stats,
      foot: '发送 #宠物出战 让灵兽上榜 · #宠物目录 览天下灵兽 · Powered by xujing-yue-plugin'
    })
    if (img) e.reply(img)
    else e.reply('灵兽榜渲染失败，请稍后再试~')
    return true
  }

  /* ---- 数字: 遇宠 1抓/2放 · 出战选宠 的斥驳路由 ---- */
  async petPick (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id)
    const uid = e.user_id
    const k = keyOf(e)
    const n = Number(String(e.msg || '').replace(/[^0-9]/g, ''))
    const state = getPetState(gid)
    const enc = state.encounter[uid]

    /* 遇宠过期残留兜底: 若 tick 未及清理, 摘掉 pet 锁避免堵栈 */
    if (enc && enc.expireAt <= Date.now()) {
      await unlock(gid, uid, 'pet')
    }

    /* 遇宠优先: 遇宠直接压栈打断当前交互(逛街/渡劫等), 数字回复优先处理遇宠; 处理完弹回下层 */
    if (enc && enc.expireAt > Date.now()) {
      if (await guardActionLocked(e, undefined, { skipBattle: true })) {
        await unlock(gid, uid, 'pet')
        return true
      }
      pending.delete(k)
      await forceLock(gid, uid, 'pet')
      if (n !== 1 && n !== 2) { e.reply('请回复 1 捕获 / 2 放走~'); return true }
      let playerPower = 0
      if (enc.mode === 'parent') playerPower = await playerPowerOf(gid, uid)
      const r = resolveEncounter(state, uid, n, Date.now(), playerPower)
      await unlock(gid, uid, 'pet')
      e.reply(r.msg)
      return true
    }

    /* 出战选宠待选(斥驳: own-state + isCurrent + yield) */
    const st = pending.get(k)
    if (st && st.type === 'deploy') {
      if (Date.now() - st.at > 5 * 60 * 1000) {
        /* 选宠状态过期/丢失: 摘除自己的锁, 让后续交互正常路由 */
        await unlock(gid, uid, 'pet')
        pending.delete(k)
        return false
      }
      /* 校验: 仅当 pet 在栈顶才处理(被其它交互埋住则让位, 保留选宠状态等回到栈顶再恢复) */
      if (!(await isCurrent(gid, uid, 'pet'))) { return false }
      /* 状态锁复查: 洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态下禁止用数字换宠出战(战斗中换出战灵兽=玩家自身操作, skipBattle 豁免战斗玩法锁, 惩罚锁照拦) */
      if (await guardActionLocked(e, undefined, { skipBattle: true })) return true
      const item = st.list[n - 1]
      if (!item) { e.reply(`请输入 1~${st.list.length} 选择出战的灵兽~`); return true }
      pending.delete(k)
      await unlock(gid, uid, 'pet')
      const r = deployPet(state, uid, item.idx)
      e.reply(r.msg)
      return true
    }

    return false // 非本系统数字 → 让路给其它系统(逛街/装备/万魂窟等)
  }
}

/* ---------- 每分钟推进 ---------- */
async function petTick () {
  for (const gid of activePetGroups()) {
    try {
      const state = getPetState(gid)
      const notices = tickPetGroup(state, gid, Date.now())
      if (notices.length) savePetState(state)
      for (const n of notices) {
        if (n.type === 'encounter') {
          /* 遇宠: 直接压栈打断当前交互(逛街/渡劫等), 玩家可直接回复数字(1抓/2放) */
          try {
            await forceLock(gid, n.uid, 'pet')
          } catch (err) { }
          notifyAt(gid, n.uid, encounterText(n.enc))
        } else if (n.type === 'encounter-expire') {
          /* 遇宠过期: 摘除 pet 锁(可能在栈顶也可能被埋), 避免堵栈, 让下层交互浮上 */
          try { await unlock(gid, n.uid, 'pet') } catch (err) { }
          notifyAt(gid, n.uid, pickText([
            '你未及应答，那只灵兽已悄然隐去，机缘稍纵即逝……重新搜寻吧。',
            '寻兽符上的灵光渐渐熄灭，方才那道兽息已经远去。此缘既散，改日再觅。',
            '山风卷过，遇兽之地只余几片落叶。你迟了一步，那只灵兽已不知去向……',
            '你迟迟未作决定，灵兽的气息终于从神念中淡去。机缘不候人，重新启程吧。'
          ]))
        } else if (n.type === 'hatched') {
          notifyAt(gid, n.uid, pickText([
            `🥚 蛋壳寸寸龟裂，一道灵光冲天而起！【${petDisplayName(n.pet)}】破壳而出，睁着懵懂的眼眸，好奇地打量这方天地~`,
            `🥚 一声清脆裂响传来，灵蛋上的纹路尽数亮起！【${petDisplayName(n.pet)}】终于破壳，幼小的灵息在你身边舒展开来。`,
            `🥚 灵气在蛋壳周围盘旋三匝，随后轰然散开。【${petDisplayName(n.pet)}】破壳而出，从今日起正式踏入成长之路。`,
            `🥚 蛋壳化作星星点点的灵光，一只小小身影从中探出头来——【${petDisplayName(n.pet)}】，见过主人。`
          ]))
        } else if (n.type === 'upgraded') {
          notifyAt(gid, n.uid, pickText([
            `🌟 【${petDisplayName(n.pet)}】周身灵光大盛，气息节节攀升，一声长啸，已臻【${stageNameOf(n.pet.stage)}】之境！${n.pet.stage === '成年' ? '如今终于可随你并肩征战了！' : ''}`,
            `🌟 灵兽袋中传来一声长鸣，【${petDisplayName(n.pet)}】血脉翻涌，形神更进一步，踏入【${stageNameOf(n.pet.stage)}】！`,
            `🌟 【${petDisplayName(n.pet)}】周身旧鳞褪去、新羽初生，灵压已非昨日可比——恭喜，成长至【${stageNameOf(n.pet.stage)}】！`,
            `🌟 一道灵光贯穿天灵，【${petDisplayName(n.pet)}】终于破开瓶颈，晋入【${stageNameOf(n.pet.stage)}】。你的陪伴没有白费。`
          ]))
        } else if (n.type === 'red-window') {
          sendGroup(gid, redWindowText(n.region))
        } else if (n.type === 'rainbow-window') {
          sendGroup(gid, rainbowWindowText(n.region))
        }
      }
    } catch (err) {
      logger.error('[灵兽]群推进失败:' + (err && err.message))
    }
  }
}
