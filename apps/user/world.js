/* ============================================================
 * 修仙世界界域与宗门经济系统 - 指令与流程
 * #去[大区] / #去[大区]强行 / #去[大区]传送
 * #交易 @玩家 金额(同区,按区税率扣税)
 * #互动 @道侣(同区,灵石消耗按区税率扣税)
 * #宗门繁荣 / #税率
 * 每30分钟静默结算繁荣度与税率; 每分钟推进界壁跨越结算
 * ============================================================ */
import { plugin } from '../../model/api/api.js'
import schedule from 'node-schedule'
import xujing_data from '../../components/xujing_data.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import {
  REGIONS, REGION_KEYS, SECTS, BOSS_TITLE,
  regionKeyOf, regionNameOf, getWorld, saveWorld, activeWorldGroups,
  getLoc, setLoc, getMoving, setMoving,
  bossOf, addTax, getRate, collectorSects, settleEconomy, dueSettle, dropRealms, taxFor,
  getSeal, sealBlocksTravel, clearSeal,
  FORCE_SUCCESS, FORCE_MIN, FORCE_DROP_MAX, TELEPORT_COST
} from '../../components/world_data.js'
import { playerSectName, getFake } from '../../components/fake_data.js'
import { teleportPass } from '../../components/teleport_pass.js'
import { itemIcon } from '../../components/equip_data.js'
import { tickShenyou } from '../../components/shenyou_data.js'
/** 互动消耗灵石 */
const INTERACT_COST = 50
const TOKEN_TRAVEL_BLOCK_MSG = `🏮 ${itemIcon('登仙令')}登仙令正在争夺中，你不能携令跨区躲避抢夺！只有拥有${itemIcon('定仙游')}【定仙游】才能跨区。`

/** 灭门判定: 宗门名 → 是否存活(未灭门); 不在伪玩家世界的名字视为存活 */
function aliveFnFor (gid) {
  const f2 = getFake(gid)
  return (name) => {
    for (const sid of Object.keys(f2.sects || {})) if (f2.sects[sid].name === name) return !f2.sects[sid].wipeAt
    return true
  }
}

export class world extends plugin {
  constructor () {
    super({
      name: '修仙世界',
      dsc: '界域移动/宗门经济/动态税率',
      event: 'message',
      priority: 200,
      rule: [
        { reg: '^[#＃]?去(中州|东海|西域|北境|南疆)$', fnc: 'go' },
        { reg: '^[#＃]?去(中州|东海|西域|北境|南疆)(强行|强闯|跨越|界壁)$', fnc: 'goForce' },
        { reg: '^[#＃]?去(中州|东海|西域|北境|南疆)(传送|传送阵|传送门)$', fnc: 'goTeleport' },
        { reg: '^[#＃]?[0-9]+$', fnc: 'goPick' },
        { reg: '^[#＃]?交易(?!玩法|说明|攻略).*$', fnc: 'tradeGold' },
        { reg: '^[#＃]?互动.*$', fnc: 'interact' },
        { reg: '^[#＃]?(宗门繁荣|宗门排行)$', fnc: 'sectRank' },
        { reg: '^[#＃]?(宗门占领|占领情况|宗门领地|宗门版图)$', fnc: 'sectOccupy' },
        { reg: '^[#＃]?(税率|当前税率)$', fnc: 'taxRate' },
        { reg: '^[#＃]?(全区税率|天下税率|各区税率|查看大区税率)$', fnc: 'allTaxRate' }
      ]
    })
    /* 世界推进: 每分钟处理界壁跨越结果 + 到点结算宗门经济(静默)
       防重复注册: 插件重复加载时只保留一个定时器 */
    if (!global.__xujingWorldTick__) {
      global.__xujingWorldTick__ = true
      schedule.scheduleJob('* * * * *', () => { worldTick().catch(err => logger.error('[修仙世界]推进异常:' + (err && err.stack))) })
    }
  }

  /** 群成员校验(目标必须在本群) */
  async inGroup (e, uid) {
    try {
      const mm = await e.group.getMemberMap()
      for (const m of mm) if (String(m[1].user_id) === String(uid)) return true
      return false
    } catch (err) { return true }
  }

  /* ---- 发起跨区: 显示方式选择(可回复数字1/2直接选) ---- */
  async go (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const m = String(e.msg || '').match(/去(中州|东海|西域|北境|南疆)/)
    const key = m ? regionKeyOf(m[1]) : null
    if (!key) return true
    const w = getWorld(e.group_id)
    const cur = getLoc(w, e.user_id)
    const pass = teleportPass(e.user_id, String(e.group_id))
    const seal = sealBlocksTravel(w, e.user_id, cur, key, { allowDingxianyou: pass.free })
    if (seal) {
      e.reply(`🌊【${REGIONS[seal.region].name}】已被${seal.ownerName || seal.owner}的镇海珠封锁，无法进出！`)
      return true
    }
    if (cur !== key && pass.blocked) {
      e.reply(TOKEN_TRAVEL_BLOCK_MSG)
      return true
    }
    /* 交互压栈: 压到栈顶(优先回复), 不终止下层交互(逛街/渡劫/换装/赠送等被埋后仍可恢复) */
    await forceLock(e.group_id, e.user_id, 'go')
    /* 数字选择待选状态(60秒有效): 回复 1/2 直接选 */
    await redis.set(`xujing:world-go:${e.group_id}:${e.user_id}`, JSON.stringify({ to: key }), { EX: 60 })
    /* 传送阵费用归离开的大区；拥有定仙游可免费瞬移 */
    const curBoss = bossOf(w, cur)
    const teleportText = pass.free
      ? `${itemIcon(pass.reason)}${pass.reason}跨区瞬移（免费，瞬间到达）`
      : `宗门传送阵（消耗 ${TELEPORT_COST} 灵石，瞬间到达，费用归${REGIONS[cur].name}${curBoss || '各占领宗门（按小区分税）'}）`
    e.reply([
      `🗺️ 前往【${REGIONS[key].name}】请选择方式：`,
      '',
      `1. 强行跨越界壁（成功率80%，耗时${FORCE_MIN}分钟，失败随机掉落0~${FORCE_DROP_MAX}个境界）`,
      `2. ${teleportText}`,
      '',
      `请回复 #去${REGIONS[key].name}强行 / #去${REGIONS[key].name}传送，或直接回复 1 或 2`
    ].join('\n'))
    return true
  }

  /* ---- 数字选择: 1=强行 2=传送(仅当有待选状态且跨区在栈顶) ---- */
  async goPick (e) {
    const key = `xujing:world-go:${e.group_id}:${e.user_id}`
    const raw = await redis.get(key)
    if (!raw) {
      /* 待选状态过期/丢失: 摘除残留的跨区锁, 避免堵住后续交互 */
      await unlock(e.group_id, e.user_id, 'go')
      return false
    }
    /* 校验: 仅当跨区选择在栈顶才处理(被逛街/渡劫/换装/赠送埋住则让位, 保留待选状态等回到栈顶再恢复) */
    if (!(await isCurrent(e.group_id, e.user_id, 'go'))) {
      return false
    }
    /* 不在此处加状态锁守卫: 登仙令持令者倒计时内必须能跨区逃跑(统一 Proxy 已放行 go/goPick), 不能误拦 */
    let st = null
    try { st = JSON.parse(raw) } catch (err) { }
    if (!st || !st.to) { await redis.del(key); await unlock(e.group_id, e.user_id, 'go'); return false }
    const num = parseInt(String(e.msg || '').replace(/[^\d]/g, ''))
    // 无效数字(非1/2)或超时: 静默不提示, 保留待选状态等玩家回复
    if (num !== 1 && num !== 2) return true
    await redis.del(key)
    await unlock(e.group_id, e.user_id, 'go')
    const regionName = REGIONS[st.to].name
    return num === 1 ? await this.goForce(e, regionName) : await this.goTeleport(e, regionName)
  }

  /* ---- 强行跨越界壁(5分钟, 80%成功) ---- */
  async goForce (e, regionName = null) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const m = regionName ? null : String(e.msg || '').match(/去(中州|东海|西域|北境|南疆)/)
    const key = regionName ? regionKeyOf(regionName) : (m ? regionKeyOf(m[1]) : null)
    if (!key) return true
    const uid = e.user_id
    const w = getWorld(e.group_id)
    if (getLoc(w, uid) === key) { e.reply(`你本就在【${REGIONS[key].name}】，无需跨越~`); return true }
    if (getMoving(w, uid)) { e.reply('你已在跨越界壁途中，稍安勿躁~'); return true }
    const pass = teleportPass(uid, String(e.group_id))
    if (pass.blocked) { e.reply(TOKEN_TRAVEL_BLOCK_MSG); return true }
    const seal = sealBlocksTravel(w, uid, getLoc(w, uid), key, { allowDingxianyou: false })
    if (seal) {
      e.reply(`🌊【${REGIONS[seal.region].name}】已被镇海珠封锁，无法强行跨越！`)
      return true
    }
    /* 交互压栈: 压到栈顶, 不终止下层交互, 避免之后数字回复错路由 */
    await forceLock(e.group_id, e.user_id, 'go')
    setMoving(w, uid, { to: key, end: Date.now() + FORCE_MIN * 60 * 1000, from: String(e.group_id) })
    e.reply(`🌌 你开始强行跨越界壁前往【${REGIONS[key].name}】！\n预计 ${FORCE_MIN} 分钟后见分晓（成功率80%），期间无法进行任何动作……`)
    return true
  }

  /* ---- 宗门传送阵(2000灵石, 瞬间到达; 费用交给离开的大区) ---- */
  async goTeleport (e, regionName = null) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const m = regionName ? null : String(e.msg || '').match(/去(中州|东海|西域|北境|南疆)/)
    const key = regionName ? regionKeyOf(regionName) : (m ? regionKeyOf(m[1]) : null)
    if (!key) return true
    const uid = e.user_id
    const w = getWorld(e.group_id)
    const cur = getLoc(w, uid)
    if (cur === key) { e.reply(`你本就在【${REGIONS[key].name}】，无需传送~`); return true }
    if (getMoving(w, uid)) { e.reply('你正在跨越界壁途中，无法使用传送阵~'); return true }
    const gid = String(e.group_id)
    const pass = teleportPass(uid, gid)
    if (pass.blocked) { e.reply(TOKEN_TRAVEL_BLOCK_MSG); return true }
    const seal = sealBlocksTravel(w, uid, cur, key, { allowDingxianyou: pass.free })
    if (seal) {
      e.reply(`🌊【${REGIONS[seal.region].name}】已被镇海珠封锁，无法传送！`)
      return true
    }
    /* 交互压栈: 压到栈顶, 不终止下层交互, 避免之后数字回复错路由 */
    await forceLock(e.group_id, e.user_id, 'go')
    const filename = `${gid}.json`
    const home = await xujing_data.getQQYUserHome(uid, null, filename, false)
    const cost = pass.free ? 0 : TELEPORT_COST
    const money = Number(home[uid].money) || 0
    if (money < cost) { e.reply(`传送阵需 ${cost} 灵石，你只有 ${money}~`); return true }
    if (cost > 0) {
      home[uid].money = money - cost
      await xujing_data.getQQYUserHome(uid, home, filename, true)
      addTax(w, cur, cost)//传送费归离开的大区
    }
    setLoc(w, uid, key)
    saveWorld(w)
    const curBoss = bossOf(w, cur)
    if (pass.free) {
      e.reply(`🚀 ${itemIcon(pass.reason)}${pass.reason}发动！你已瞬间抵达【${REGIONS[key].name}】（本次跨区无需消耗灵石）`)
    } else {
      e.reply(`🚀 传送阵启动！你已瞬间抵达【${REGIONS[key].name}】（花费 ${cost} 灵石，已交予${REGIONS[cur].name}${curBoss || '各占领宗门（按小区分税）'}）`)
    }
    return true
  }

  /* ---- 交易: 双方同区, 按区税率扣税 ---- */
  async tradeGold (e) {
    if (!e.group_id) { e.reply('交易需在群内进行~'); return true }
    if (!e.at) { e.reply('请@交易对象，如：#交易 @玩家 5000'); return true }
    if (String(e.at) === String(e.user_id)) { e.reply('不能和自己交易~'); return true }
    if (!(await this.inGroup(e, e.at))) { e.reply('对方不在本群，无法交易~'); return true }
    const m = String(e.msg || '').match(/(\d+)\s*$/)
    const amount = m ? Math.floor(Number(m[1])) : NaN
    if (!Number.isFinite(amount) || amount <= 0) { e.reply('请输入交易金额，如：#交易 @玩家 5000'); return true }
    const uid = e.user_id
    const gid = String(e.group_id)
    const w = getWorld(e.group_id)
    const myLoc = getLoc(w, uid)
    const tgtLoc = getLoc(w, e.at)
    if (myLoc !== tgtLoc) {
      e.reply(`你们不在同一大区！你位于【${regionNameOf(myLoc)}】，对方位于【${regionNameOf(tgtLoc)}】，请先同行再交易~`)
      return true
    }
    const filename = `${gid}.json`
    const home = await xujing_data.getQQYUserHome(uid, null, filename, false)
    if (!home[e.at]) home[e.at] = { s: 0, wait: 0, money: 100, love: 0 }
    const myMoney = Number(home[uid].money) || 0
    if (myMoney < amount) { e.reply(`灵石不足，你只有 ${myMoney}~`); return true }
    const rate = taxFor(w, myLoc, playerSectName(gid, uid))
    const tax = Math.floor(amount * rate / 100)
    const toTarget = amount - tax
    home[uid].money = myMoney - amount
    home[e.at].money = (Number(home[e.at].money) || 0) + toTarget
    await xujing_data.getQQYUserHome(uid, home, filename, true)
    addTax(w, myLoc, tax)
    saveWorld(w)
    const boss = bossOf(w, myLoc)
    const owner = boss ? `${REGIONS[myLoc].name}${boss}` : `${REGIONS[myLoc].name}各占领宗门（按小区分税）`
    e.reply(`💰 交易成功！\n本次交易金额 ${amount} 灵石，税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}。\n对方到账 ${toTarget} 灵石，你剩余 ${home[uid].money} 灵石`)
    return true
  }

  /* ---- 互动: 道侣, 消耗灵石并按区税率扣税 ---- */
  async interact (e) {
    if (!e.group_id) { e.reply('互动需在群内进行~'); return true }
    if (!e.at) { e.reply('请@你的道侣互动，如：#互动 @道侣'); return true }
    if (!(await this.inGroup(e, e.at))) { e.reply('对方不在本群~'); return true }
    const uid = e.user_id
    const gid = String(e.group_id)
    const filename = `${gid}.json`
    const home = await xujing_data.getQQYUserHome(uid, null, filename, false)
    if (!home[uid] || !home[uid].s || String(home[uid].s) !== String(e.at)) {
      e.reply('对方不是你的道侣哦~'); return true
    }
    const w = getWorld(e.group_id)
    const myLoc = getLoc(w, uid)
    const tgtLoc = getLoc(w, e.at)
    if (myLoc !== tgtLoc) {
      e.reply(`你们不在同一大区！你位于【${regionNameOf(myLoc)}】，道侣位于【${regionNameOf(tgtLoc)}】，先同行再互动~`)
      return true
    }
    const myMoney = Number(home[uid].money) || 0
    if (myMoney < INTERACT_COST) { e.reply(`互动需 ${INTERACT_COST} 灵石，你只有 ${myMoney}~`); return true }
    const rate = taxFor(w, myLoc, playerSectName(gid, uid))
    const tax = Math.floor(INTERACT_COST * rate / 100)
    const loveGain = Math.round(5 + Math.random() * 5)
    home[uid].money = myMoney - INTERACT_COST
    home[uid].love = (Number(home[uid].love) || 0) + loveGain
    await xujing_data.getQQYUserHome(uid, home, filename, true)
    addTax(w, myLoc, tax)
    saveWorld(w)
    const boss = bossOf(w, myLoc)
    const owner = boss ? `${REGIONS[myLoc].name}${boss}` : `${REGIONS[myLoc].name}各占领宗门（按小区分税）`
    e.reply(`💞 互动成功！道侣好感 +${loveGain}\n互动开销 ${INTERACT_COST} 灵石，税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}`)
    return true
  }

  /* ---- 宗门繁荣排行(渲染图片) ---- */
  async sectRank (e) {
    const w = getWorld(e.group_id)
    const alive = aliveFnFor(e.group_id)
    const bossOfRegion = {}
    for (const k of Object.keys(REGIONS)) {
      const b = bossOf(w, k, alive)
      if (b) bossOfRegion[b] = (bossOfRegion[b] || []).concat(REGIONS[k].name)
    }
    /* 动态宗门列表(重建/改名后的宗门也纳入排行) */
    const dynNames = new Set([...SECTS, ...Object.values(w.sectMap || {}), ...Object.keys(w.prosperity || {})])
    const sorted = [...dynNames].sort((a, b) => (Number(w.prosperity[b]) || 0) - (Number(w.prosperity[a]) || 0))
    const lines = ['🏯 宗门繁荣度排行', '']
    sorted.forEach((s, i) => {
      const regions = (bossOfRegion[s] || []).join('、')
      lines.push(`${i + 1}. ${s}：${Number(w.prosperity[s]) || 0}${regions ? `　（${BOSS_TITLE}：${regions}）` : ''}`)
    })
    lines.push('', '每 30 分钟结算一次：税收 100 灵石 = 1 繁荣，高繁荣衰减更快')
    /* 长列表渲染成图片, 渲染失败回退纯文字 */
    const img = await textToImg(lines.join('\n'))
    if (img) e.reply(img)
    else e.reply(lines.join('\n'))
    return true
  }

  /* ---- 宗门占领分布(渲染图片) ---- */
  async sectOccupy (e) {
    const w = getWorld(e.group_id)
    const alive = aliveFnFor(e.group_id)
    const lines = ['🏯 宗门占领分布', '']
    for (const k of REGION_KEYS) {
      if (REGIONS[k].special) continue // 特殊大区(简月王朝)不入宗门占领
      const boss = bossOf(w, k, alive)
      lines.push(`━━━ ${REGIONS[k].name} ━━━${boss ? `　${BOSS_TITLE}：${boss}` : '　（无霸主）'}`)
      for (const area of REGIONS[k].areas) {
        const s = w.sectMap[area]
        lines.push(`　${area}：${s ? (alive(s) ? s : '无主（原宗已灭）') : '无主'}`)
      }
      lines.push('')
    }
    /* 各宗小区数统计(灭门宗门不计) */
    const cnt = {}
    for (const k of REGION_KEYS) for (const a of REGIONS[k].areas) {
      const s = w.sectMap[a]
      if (s && alive(s)) cnt[s] = (cnt[s] || 0) + 1
    }
    lines.push('━━━ 各宗领地 ━━━')
    for (const s of SECTS) lines.push(`${s}：${cnt[s] || 0} 块领地`)
    /* 渲染成图片, 失败回退纯文字 */
    const img = await textToImg(lines.join('\n'))
    if (img) e.reply(img)
    else e.reply(lines.join('\n'))
    return true
  }

  /* ---- 当前大区税率 ---- */
  async taxRate (e) {
    const w = getWorld(e.group_id)
    const alive = aliveFnFor(e.group_id)
    const loc = getLoc(w, e.user_id)
    const mySect = playerSectName(String(e.group_id), e.user_id)
    const rate = taxFor(w, loc, mySect, alive)
    const base = getRate(w, loc)
    const boss = bossOf(w, loc, alive)
    const owner = boss ? `${boss}（${BOSS_TITLE}）` : '该区各占领宗门（按小区分税）'
    const half = rate < base ? `\n（你所属【${mySect}】是本区一方霸主，税率减半！）` : ''
    e.reply(`📍 你当前位于【${REGIONS[loc].name}】\n当前税率：${rate}%${half}\n税收归属：${owner}`)
    return true
  }

  /* ---- 全区税率: 五大区一览 ---- */
  async allTaxRate (e) {
    const w = getWorld(e.group_id)
    const alive = aliveFnFor(e.group_id)
    const lines = []
    for (const k of REGION_KEYS) {
      if (REGIONS[k].special) continue // 特殊大区(简月王朝)不入全区税率
      const boss = bossOf(w, k, alive)
      const sects = collectorSects(w, k, alive)
      const owner = boss ? `${boss}（${BOSS_TITLE}）` : (sects.join('、') || '无主') + '（按小区分税）'
      let pro = 0
      if (boss) pro = Number(w.prosperity[boss]) || 0
      else pro = sects.length ? Math.round(sects.reduce((a, s) => a + (Number(w.prosperity[s]) || 0), 0) / sects.length) : 0
      lines.push(`━━━ ${REGIONS[k].name} ━━━\n税率：${getRate(w, k)}% · 归属：${owner}\n繁荣：${pro}`)
    }
    const img = await textToImg(lines.join('\n'))
    if (img) e.reply(img)
    else e.reply('💰 全区税率\n' + lines.join('\n'))
    return true
  }
}

/* ---------- 每分钟推进: 界壁跨越结算 + 宗门经济结算(静默, 遍历所有活跃群) ---------- */
async function worldTick () {
  try {
    const gids = activeWorldGroups()
    if (!gids.length) return
    const now = Date.now()
    for (const gid of gids) {
      try {
        const w = getWorld(gid)
        tickShenyou(gid, true, now)
        let changed = false
        /* 0. 镇海珠封海到期解除 */
        const activeSeal = getSeal(w)
        if (activeSeal && Number(activeSeal.until) <= now) {
          w.seal = null
          changed = true
          try {
            Bot.pickGroup(gid).sendMsg(`🌊【${regionNameOf(activeSeal.region)}】的镇海珠封锁已到期解除。`)
          } catch (err) { }
        }
        /* 1. 界壁跨越到点结算 */
        for (const uid of Object.keys(w.moving || {})) {
          const mv = w.moving[uid]
          if (!mv || now < mv.end) continue
          delete w.moving[uid]
          changed = true
          const seal = sealBlocksTravel(w, uid, getLoc(w, uid), mv.to)
          if (seal) {
            try {
              Bot.pickGroup(gid).sendMsg([segment.at(typeof uid === 'string' ? Number(uid) : uid), `\n🌊 界壁被【${regionNameOf(seal.region)}】的镇海珠封锁，跨界失败，你被挡了回来。`])
            } catch (err) { }
            continue
          }
          const toName = regionNameOf(mv.to)
          try {
            if (Math.random() < FORCE_SUCCESS) {
              w.playerLoc[String(uid)] = mv.to
              Bot.pickGroup(gid).sendMsg([segment.at(typeof uid === 'string' ? Number(uid) : uid), `\n🌌 界壁跨越成功！你已抵达【${toName}】`])
            } else {
              const drop = await dropRealms(mv.from, uid, FORCE_DROP_MAX)
              Bot.pickGroup(gid).sendMsg([segment.at(typeof uid === 'string' ? Number(uid) : uid), `\n💥 强行跨越失败！界壁反噬${drop > 0 ? `，掉落了 ${drop} 个境界` : '，侥幸无碍'}……`])
            }
          } catch (err) {
            logger.error('[修仙世界]跨越结算失败:', err && err.message)
          }
        }
        /* 2. 每30分钟宗门经济结算(静默, 灭门宗门地盘视为无主) */
        if (dueSettle(w)) {
          settleEconomy(w, aliveFnFor(gid))//内部已保存
        } else if (changed) {
          saveWorld(w)
        }
      } catch (err) {
        logger.error('[修仙世界]群推进异常:', err && err.stack)
      }
    }
  } catch (err) {
    logger.error('[修仙世界]tick异常:', err && err.stack)
  }
}
