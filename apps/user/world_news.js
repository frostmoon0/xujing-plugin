import { sectMemberCapacity, sectOccupancy } from '../../components/sect/capacity.js'
/* ============================================================
 * 天下大事 · 伪玩家宗门世界 - 指令与流程 (每群独立世界)
 * #天下大事 / #查看天下大事: 查本群江湖最近24小时事件
 * #天下宗门: 查看本群宗门名单/职位/地盘
 * 每分钟推进所有活跃群 fakeTick; 每3分钟批量保存；每日12:30 各自群播报
 * ============================================================ */
import { plugin } from '../../model/api/api.js'
import path from 'path'
import schedule from 'node-schedule'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import {
  getFake, saveFake, activeFakeGroups, fakeTick,
  sectName, sectIdByName, recentEvents, POS, personPower, realmPowerOf, sectCulture,
  getNick, isFakeCaptive, raidJailList
} from '../../components/fake_data.js'
import { groupPetRank, getActivePetInfo } from '../../components/pet_data.js'
import { qualityNameOf } from '../../components/pet_species.js'
import { levelNameOf, regionNameOf, REGIONS } from '../../components/world_data.js'
import { facilityMaintPerHr, estimateWinRate, escapeRateOf, sectJailList, warTargetTxt } from '../../components/sect_system.js'
import { getBoss } from '../../components/boss_data.js'
import { allRaids, allJails } from '../../components/raid_data.js'
import { getTotalAttr, GONGFA_TPL, itemIcon } from '../../components/equip_data.js'
import xujing_data from '../../components/xujing_data.js'
import { buildWealthRank } from '../../components/wealth_rank.js'
import { Plugin_Name, Plugin_Path } from '../../components/plugin.js'
import { backupSaves } from '../../components/save_backup.js'
import { cleanupSaveFiles } from '../../components/save_cleanup.js'
import { flushDeferredSaves } from '../../components/deferred_save.js'

/** 事件时间格式: 月-日 时:分 */
function fmtTime (t) {
  const d = new Date(t)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 伪玩家背包物品件数(兼容旧数字格式与当前 { count } 格式) */
function itemCount (raw) {
  const value = raw && typeof raw === 'object' ? raw.count : raw
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

/** 战争时间范围: 总览和序号详情使用同一套起止时间显示 */
function fmtWarTime (a) {
  const start = Number(a && a.start) || 0
  const end = a && a.phase === 'done' ? (Number(a.endAt) || 0) : 0
  if (!start) return end ? fmtTime(end) : '时间未知'
  return `${fmtTime(start)} → ${end ? fmtTime(end) : '进行中'}`
}

/* 同一群的 fakeTick 必须串行，避免每分钟调度重入覆盖 fake_{gid}.json */
const fakeTickInFlight = new Set()
/** 单群发送 */
function sendToGroup (gid, msg) {
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.sendMsg) g.sendMsg(msg)
  } catch (err) { }
}
/** 宗门关系文本(盟友+敌对, 已灭门/重建的跳过) */
function sectRelTxt (f, id) {
  const s = f.sects[id]
  const al = ((s && s.allies) || []).map(aid => sectName(f, aid)).filter(n => n && n !== '未知')
  const en = ((s && s.enemies) || []).map(eid => sectName(f, eid)).filter(n => n && n !== '未知')
  return `盟友：${al.length ? al.join('、') : '无'}　敌对：${en.length ? en.join('、') : '无'}`
}
/** 长文本转图片, 失败回退纯文字(防呆) */
async function replyLines (e, title, lines) {
  const full = [title, ...lines]
  let img = null
  try { img = await textToImg(full.join('\n')) } catch (err) { }
  if (img) e.reply(img)
  else e.reply(full.join('\n'))
}

export class world_news extends plugin {
  constructor () {
    super({
      name: '天下大事',
      dsc: '伪玩家宗门世界/事件播报',
      event: 'message',
      priority: 280,
      rule: [
        { reg: '^[#＃]?(天下大事|查看天下大事|今日大事)$', fnc: 'worldNews' },
        { reg: '^[#＃]?(天下战争|战争状态|战争记录|战争史|战争详情|战报)\s*([0-9０-９]*)$', fnc: 'warList' },
        { reg: '^[#＃]?(天下宗门|宗门名单|宗门概况)$', fnc: 'sectList' },
        { reg: '^[#＃]?(查宗门|查看宗门|宗门详情|宗门内部|宗门情报)\\s*(\\S*)\\s*$', fnc: 'sectDetail' },
        { reg: '^[#＃]?(查人|修士详情|人物详情)\\s*(\\S*)\\s*$', fnc: 'personInfo' },
        { reg: '^[#＃]?(伪玩家宠物榜|伪玩家灵兽榜|伪玩家宠物排行|伪玩家灵兽排行)$', fnc: 'fakePetRank' },
        { reg: '^[#＃]?(战力榜|江湖强者|天下强者|强者榜)$', fnc: 'powerRank' },
        { reg: '^[#＃]?(天下灵石|财富榜|灵石榜)$', fnc: 'wealthRank' },
        { reg: '^[#＃]?(江湖交易|天下交易|交易大事|江湖买卖)$', fnc: 'tradeNews' },
        { reg: '^[#＃]?(天下小事|江湖琐事|琐事)\\s*$', fnc: 'smallNews' },
        { reg: '^[#＃]?(天下天牢|天牢详情|查看天下天牢|全天牢)$', fnc: 'jailListCmd' }
      ]
    })
    /* 每分钟推进所有活跃群: 攻打结算/事件生成/每日结算；存档每3分钟批量落盘 */
    if (!global.__xujingFakeTick__) {
      global.__xujingFakeTick__ = true
      schedule.scheduleJob('*/3 * * * *', () => {
        try {
          const r = flushDeferredSaves()
          if (r.saved || r.failed) logger.mark(`[天下大事]批量保存: 成功${r.saved}项，失败${r.failed}项，待处理${r.pending}项`)
        } catch (err) { logger.error('[天下大事]批量保存异常:' + (err && err.stack)) }
      })
      schedule.scheduleJob('* * * * *', () => {
        for (const gid of activeFakeGroups()) {
          if (fakeTickInFlight.has(gid)) continue
          fakeTickInFlight.add(gid)
          Promise.resolve(fakeTick(gid))
            .catch(err => logger.error('[天下大事]推进异常:' + (err && err.stack)))
            .finally(() => fakeTickInFlight.delete(gid))
        }
      })
    }
    /* 每半小时自动备份存档(保留最近100份, 超出删最旧); 注册后立即备份一次 */
    if (!global.__xujingBackupTick__) {
      global.__xujingBackupTick__ = true
      schedule.scheduleJob('*/30 * * * *', () => {
        try {
          const r = backupSaves()
          logger.mark(`[存档备份]${r ? r.msg : '未知结果'}`)
        } catch (err) { logger.error('[存档备份]异常:' + (err && err.stack)) }
      })
      try {
        const r = backupSaves()
        logger.mark(`[存档备份]${r ? r.msg : '未知结果'}`)
      } catch (err) { logger.error('[存档备份]异常:' + (err && err.stack)) }
    }
    /* 每日清理插件存档中的无用历史索引与残留临时文件,不触碰D盘半小时备份 */
    if (!global.__xujingSaveCleanupTick__) {
      global.__xujingSaveCleanupTick__ = true
      schedule.scheduleJob('17 4 * * *', () => {
        try {
          const r = cleanupSaveFiles()
          logger.mark(`[存档清理]删除 ${r.removed} 个残留文件,释放 ${Math.round(r.bytes / 1024)}KB`)
        } catch (err) { logger.error('[存档清理]异常:' + (err && err.stack)) }
      })
      try {
        const r = cleanupSaveFiles()
        logger.mark(`[存档清理]删除 ${r.removed} 个残留文件,释放 ${Math.round(r.bytes / 1024)}KB`)
      } catch (err) { logger.error('[存档清理]异常:' + (err && err.stack)) }
    }
  }
  async worldNews (e) {
    try {
      const gid = String(e.group_id || '')
      if (!gid) { e.reply('需在群内查看'); return true }
      const f = getFake(gid)
      const evs = recentEvents(f, 48, true)
      if (!evs.length) {
        e.reply('📜 江湖风平浪静，最近 48 小时无大事发生（天下太平）。')
        return true
      }
      /* 玩家真实事件(洗劫/被捕等)加 🌙 标识; 最多显示100条带序号 */
      const shown = evs.slice(0, 100)
      const lines = shown.map((x, i) => `${i + 1}. [${fmtTime(x.t)}] ${x.type === 'player' ? '🌙 ' : ''}${x.txt}`)
      if (evs.length > 100) lines.push('', `…共 ${evs.length} 条，仅显示最新 100 条`)
      await replyLines(e, '📜 天下大事（近48小时，随时可查）', lines)
      return true
    } catch (err) {
      logger.error('[天下大事]异常:' + (err && err.stack))
      e.reply('📜 查询天下大事出错了，请稍后再试')
      return true
    }
  }

  /* ---- #天下战争 [序号]: 完整总览(进行中活动+进行中战争+近期历史) / 序号查看详细战报 ---- */
  async warList (e) {
    try {
      const gid = String(e.group_id || '')
      if (!gid) { e.reply('需在群内查看'); return true }
      const f = getFake(gid)
      const m = String(e.msg || '').match(/(天下战争|战争状态|战争记录|战争史|战争详情|战报)\s*([0-9０-９]*)/)
      const idx = (m && m[2]) ? parseInt(String(m[2]).replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)), 10) : 0
      const wars = (f.sectAttacks || []).slice(-100).reverse() // 最近100场(含进行中), 倒序
      const atkName = (a) => a.snapshot?.attacker || (a.atkSect ? sectName(f, a.atkSect) : (a.teamName ? `散修小队【${a.teamName}】` : (a.rogueName || '散修')))
      /* 目标(打的是啥): 宗门战=宗门名, 地盘争夺=小区名; 统一带 小区+宗门名 完整显示 */
      const targetTxt = (a) => warTargetTxt(f, a)
      /* 守方(谁在守): 宗门战=目标宗门, 地盘争夺=占领该小区的宗门(无主=无主之地) */
      const defName = a => a.snapshot?.defender || (a.targetType === 'sect' ? sectName(f, a.target) : (f.areas?.[a.target] ? sectName(f, f.areas[a.target]) : '无主之地'))
      /* 玩家显示一律用群名片/昵称(getNick, 取不到回退QQ号), 不直接显示QQ号 */
      const playerNames = async (uids) => {
        const names = []
        for (const u of (uids || [])) names.push(await getNick(gid, u))
        return names.join('、')
      }
      const fmtList = (arr) => arr.length ? (arr.length > 20 ? arr.slice(0, 20).join('、') + ` 等 ${arr.length} 人` : arr.join('、')) : '无'
      /* 进行中战争(最新在前) + 近期历史(近24h已结束) — 连续编号: 进行中1,2,3… → 历史接着4,5,6… */
      const live = wars.filter(a => a.phase !== 'done')
      const hist = []
      for (const a of wars) {
        if (a.phase === 'done' && a.endAt && Date.now() - a.endAt < 86400000) hist.push(a)
        if (hist.length >= 50) break
      }
      const warIdxList = [...live, ...hist] // 连续编号列表(查询用)

      /* ---------- 有序号: 详细战报(多详细有多详细) ---------- */
      if (idx) {
        if (!warIdxList.length) { e.reply('⚔️ 暂无战争记录'); return true }
        const fixed = ['战争详情', '战报'].includes(m?.[1])
        if (fixed ? !wars.some(a => Number(a.id) === idx) : (idx < 1 || idx > warIdxList.length)) { e.reply(fixed ? '该固定战役编号不存在，请查看 #天下战争' : `请输入 1~${warIdxList.length} 之间的序号`); return true }
        const a = fixed ? wars.find(a => Number(a.id) === idx) : warIdxList[idx - 1]
        const durMin = a.phase === 'done' ? Math.max(0, Math.round((a.endAt - a.start) / 60000)) : Math.max(0, Math.round((Date.now() - a.start) / 60000))
        const est = await estimateWinRate(f, gid, a)
        const estTxt = est.pct === null ? '（无有效战力对比）' : `攻方 ${est.pct}%（战力 ${est.atk} vs ${est.def}）`
        const atkFakes = (a.atkFakes || []).map(n => (f.roster[n] && f.roster[n].name) || n)
        const defFakes = (a.defFakes || []).map(n => (f.roster[n] && f.roster[n].name) || n)
        const capFakes = (((a.captives || {}).fakes) || []).map(n => (f.roster[n] && f.roster[n].name) || n)
        const capPlayers = []
        for (const u of (((a.captives || {}).players) || [])) capPlayers.push(await getNick(gid, u))
        const atkPN = await playerNames(a.atkPlayers)
        const defPN = await playerNames(a.defPlayers)
        /* ---- 双方得失统计: 胜方收获 / 败方损失(战死/远遁/受伤/被俘) ---- */
        const win = a.phase === 'done' && a.result === 'win'
        const logArr = (a.log || []).map(l => l.txt)
        const nTag = (tag) => logArr.filter(t => t.includes(tag)).length
        const capF = ((a.captives || {}).fakes) || []
        const capP = ((a.captives || {}).players) || []
        const deadN = nTag('【战死】')
        const fledN = nTag('【远遁】')
        const hurtN = nTag('【受伤】')
        const capN = capF.length + capP.length
        const lossTxt = `战死 ${deadN} · 远遁 ${fledN} · 受伤 ${hurtN} · 被俘 ${capN}`
        const disN = { loot: nTag('【搜刮】'), coopt: nTag('【收编】'), jail: nTag('【收押】'), kill: nTag('【处决】'), free: nTag('【释放】'), punish: nTag('【惩戒】') }
        const disArr = []
        if (disN.loot) disArr.push(`搜刮${disN.loot}`)
        if (disN.coopt) disArr.push(`收编${disN.coopt}`)
        if (disN.jail) disArr.push(`关押${disN.jail}`)
        if (disN.kill) disArr.push(`处决${disN.kill}`)
        if (disN.free) disArr.push(`释放${disN.free}`)
        if (disN.punish) disArr.push(`惩戒${disN.punish}`)
        const disTxt = disArr.length ? `｜处置俘虏：${disArr.join('·')}` : ''
        const lines = [
          `战争 #${idx}`,
          '━━━━━━━━━━━━━━',
          `进攻方：${atkName(a)}（${a.kind || '正面强攻'}）`,
          `发起者：${a.by === 'ai' ? '伪玩家宗主' : (a.by === 'rogue' ? `散修队长${a.teamName ? `【${a.teamName}】` : ''}` : '玩家宗主')}`,
          `目标：${targetTxt(a)}（${a.targetType === 'sect' ? '宗门战' : `地盘争夺·守方${defName(a)}`}）`,
          `状态：${a.phase === 'done' ? (a.result === 'win' ? '✅ 攻占成功' : '❌ 攻打失败') : '⏳ 进行中'}`,
          `时间：${fmtWarTime(a)}（${durMin} 分钟｜${a.round || 0} 轮）`,
          `系统单轮优势估算：${estTxt}`,
          `士气：攻方 ${Math.max(0, Math.round(a.moraleA))}% ｜ 守方 ${Math.max(0, Math.round(a.moraleD))}%`,
          '━━━━━━━━━━━━━━',
          `参战·攻方：门人 ${fmtList(atkFakes)}`,
          `参战·守方：门人 ${fmtList(defFakes)}`,
          `参战玩家：${(a.atkPlayers || []).length || (a.defPlayers || []).length ? `攻方🌙${atkPN || '无'}｜守方🌙${defPN || '无'}` : '无'}`,
          `俘虏：${fmtList(capFakes)}${capPlayers.length ? ' + 🌙' + capPlayers.join('、') : ''}（${capFakes.length} 门人 + ${capPlayers.length} 玩家）`,
          `战利品：${a.loot ? `掠夺 ${a.loot} 灵石（${a.rogue ? '按人头分给参战散修' : '充入宗门宝库'}）` : '无'}`,
          ...(a.phase === 'done' ? [
            '━━━ 双方得失 ━━━',
            ...(win ? [
              `🏆 攻方收获：占领【${targetTxt(a)}】${a.loot ? `＋掠夺 ${a.loot} 灵石${a.rogue ? '（散修平分）' : '（充入宗门宝库）'}` : ''}${disTxt}`,
              `💀 守方损失：${a.targetType === 'sect' ? '宗门被覆灭' : `失去【${targetTxt(a)}】`}${a.loot ? `＋宝库被掠夺 ${a.loot} 灵石` : ''}｜${lossTxt}`
            ] : [
              `🏆 守方收获：守住【${targetTxt(a)}】＋宝库安然无恙${disTxt}`,
              `💀 攻方损失：攻打失败${lossTxt}`
            ])
          ] : []),
          '━━━━━ 战报明细 ━━━━━'
        ]
        const log = (a.log || [])
        if (!log.length) lines.push('（暂无详细战报记录）')
        else for (const l of log) lines.push(`[${fmtTime(l.t)}] ${l.txt}`)
        await replyLines(e, `⚔️ 战争详情 #${a.id}`, lines)
        return true
      }

      /* ---------- 无序号: 完整总览 ---------- */
      /* 进行中的其他活动: 世界boss + 洗劫藏宝阁(信息类, 随时可看) */
      let bossLine = ''
      try {
        const b = getBoss(gid)
        if (b && b.typeName && (b.hp || 0) > 0 && Date.now() < (b.end || 0)) {
          const pct = b.maxHp ? Math.max(0, Math.round((b.hp / b.maxHp) * 100)) : 100
          bossLine = `🐲 世界boss：${b.typeName} 剩余血量 ${pct}%（#boss状态 查看伤害排行）`
        }
      } catch (err) { }
      let raidActive = []
      try {
        const raids = await allRaids()
        raidActive = raids.filter(r => String(r.gid) === gid && r.st && (r.st.phase === 'raid' || r.st.phase === 'escape'))
      } catch (err) { }
      if (!live.length && !hist.length && !bossLine && !raidActive.length) {
        e.reply('🕊️ 天下太平，当前没有战争，也无近期战争记录')
        return true
      }
      const lines = []
      /* ---- 进行中的活动 ---- */
      if (bossLine || raidActive.length) {
        lines.push('🎪 进行中的活动', '')
        if (bossLine) lines.push(bossLine)
        if (raidActive.length) lines.push(`🌙 洗劫藏宝阁：${raidActive.length} 名玩家正在洗劫/逃亡中（#洗劫状态 查看）`)
        lines.push('')
      }
      /* ---- 进行中的宗门战争(连续编号: 1,2,3…) ---- */
      if (live.length) {
        lines.push(`⚔️ 进行中的战争（${live.length} 场，回复 #天下战争 序号 查看详细战报）`, '')
        for (let li = 0; li < live.length; li++) {
          const a = live[li]
          const atkFakeN = (a.atkFakes || []).length
          const defFakeN = (a.defFakes || []).length
          const atkP = (a.atkPlayers || []).length
          const defP = (a.defPlayers || []).length
          const est = await estimateWinRate(f, gid, a)
          const estTxt = est.pct === null ? '' : `｜单轮优势估算 攻方 ${est.pct}%`
          lines.push(
            `━━━ 序号 ${li + 1} · 固定战役 #${a.id} ━━━`,
            `攻方：${atkName(a)}${a.atkSect ? `（弟子${atkFakeN}人` : `（玩家${atkP}人`}${atkP ? ` + 🌙玩家${atkP}人` : ''}）${estTxt}`,
            `守方：${defName(a)}（${defFakeN ? `弟子${defFakeN}人` : '暂无守军'}${defP ? ` + 🌙玩家${defP}人` : ''}）`,
            `目标：${targetTxt(a)}（${a.targetType === 'sect' ? '宗门战' : '地盘争夺'}）｜战法：${a.kind || '正面强攻'}`
          )
          if (a.phase === 'prep') {
            const remain = Math.max(0, Math.ceil((a.prepEnd - Date.now()) / 60000))
            lines.push(`⏳ 准备期：还剩 ${remain} 分钟（发起于 ${fmtTime(a.start)}，攻方灵石${a.cost || 0}）`)
          } else {
            lines.push(`⚔️ 战斗中：第 ${a.round} 轮｜士气 攻方${Math.max(0, Math.round(a.moraleA))}% vs 守方${Math.max(0, Math.round(a.moraleD))}%`)
          }
          if (atkP || defP) lines.push(`👥 参战玩家：${atkP ? `攻方🌙${await playerNames(a.atkPlayers)}` : ''}${atkP && defP ? ' ｜ ' : ''}${defP ? `守方🌙${await playerNames(a.defPlayers)}` : ''}`)
          lines.push('')
        }
      }
      /* ---- 近期战争史(近24h, 接续进行中编号) ---- */
      if (hist.length) {
        lines.push(`📜 近期战争史（近24小时 · ${hist.length} 场，回复 #天下战争 序号 查看详细战报）`)
        for (let i = 0; i < hist.length; i++) {
          const a = hist[i]
          const r = a.result === 'win' ? '✅ 攻占' : '❌ 败退'
          const cps = (a.captives && ((a.captives.fakes || []).length + (a.captives.players || []).length)) || 0
          const loot = a.loot ? `｜掠夺${a.loot}灵石` : ''
          const dur = `（${Math.max(0, Math.round((a.endAt - a.start) / 60000))}分钟/${a.round || 0}轮${cps ? `｜俘虏${cps}人` : ''}${loot}）`
          lines.push(`${live.length + i + 1}. [${fmtWarTime(a)}] ${atkName(a)} ${r}【${targetTxt(a)}】${dur}`)
        }
      }
      lines.push('', '💡 #天下战争 [序号] 查看该场详细战报（进行中+近24小时历史，按上面序号）')
      await replyLines(e, '⚔️ 天下战争', lines)
      return true
    } catch (err) {
      logger.error('[天下战争]异常:' + (err && err.stack))
      e.reply('查询天下战争出错了，请稍后再试')
      return true
    }
  }

  /* ---- #天下宗门: 本群宗门名单/职位/地盘 ---- */
  async sectList (e) {
    const gid = String(e.group_id || '')
    if (!gid) { e.reply('需在群内查看'); return true }
    const f = getFake(gid)
    const regionOfSect = (id) => {
      const s = f.sects[id]
      if (s && s.region) return s.region
      const cnt = {}
      for (const [area, o] of Object.entries(f.areas || {})) {
        if (o !== id) continue
        for (const k of Object.keys(REGIONS)) if (REGIONS[k].areas.includes(area)) cnt[k] = (cnt[k] || 0) + 1
      }
      let best = 'center'
      let bn = 0
      for (const [k, n] of Object.entries(cnt)) if (n > bn) { best = k; bn = n }
      return best
    }
    const lines = []
    const now = Date.now()
    for (const id of Object.keys(f.sects)) {
      const s = f.sects[id]
      if (s.wipeAt) continue // 灭门中不显示(等待散修重建)
      const sm = f.sectMap[id] || {}
      const owner = s.owner ? (f.players[s.owner] || null) : null
      const zz = owner
        ? `🌙 ${owner.name}（玩家宗主${owner.contribution ? ` 贡献${owner.contribution}` : ''}）`
        : (sm.zongzhu ? `${sm.zongzhu}（${f.roster[sm.zongzhu] ? levelNameOf(f.roster[sm.zongzhu].level) : '?'}）` : '（空缺·由副宗主代掌）')
      const areas = Object.keys(f.areas).filter(a => f.areas[a] === id).join('、') || '无地盘'
      const truceUntil = (f.targetCd || {})['sect:' + id] || 0
      let protection = ''
      if (truceUntil > now) {
        const remainMin = Math.max(0, Math.ceil((truceUntil - now) / 60000))
        const rh = Math.floor(remainMin / 60)
        const rm = remainMin % 60
        protection = `保护期：剩 ${rh > 0 ? `${rh}小时${rm}分` : `${rm}分钟`}（休战中，期间不可被攻打）`
      }
      /* 玩家成员(带🌙): 同宗玩家按职位并入显示(宗主已单独显示, 不重复) */
      const playerAt = (pos) => Object.values(f.players || {}).filter(p => p && p.sect === id && p.pos === pos).map(p => `🌙${p.name}`)
      const fz = [...sm.fuzong, ...playerAt('fuzong')].join('、') || '（空缺）'
      const ts = [...sm.taishang, ...playerAt('taishang')].join('、') || '（空缺）'
      const zs = [...sm.zhishi, ...playerAt('zhishi')].join('、') || '（空缺）'
      const dz = [...sm.dizi, ...playerAt('dizi')].join('、') || '（无弟子）'
      lines.push(
        `━━━ ${s.name}${owner ? ' 🌙' : ''} ━━━`,
        `所在大区：${regionNameOf(regionOfSect(id))}`,
        `成员：${sectOccupancy(f, id)}/${sectMemberCapacity(f, id)}`,
        `太上长老：${ts}`,
        `宗主：${zz}`,
        `副宗主：${fz}`,
        `执事：${zs}`,
        `弟子：${dz}`,
        `地盘：${areas}`,
        ...(protection ? [`🛡️ ${protection}`] : []),
        `文化：${sectCulture(f, id).desc}`,
        `关系：${sectRelTxt(f, id)}`
      )
    }
    await replyLines(e, '🏯 天下宗门', lines)
    return true
  }

  /* ---- #宗门详情 [宗门名]: 本群宗门内部全员 ---- */
  async sectDetail (e) {
    const gid = String(e.group_id || '')
    if (!gid) { e.reply('需在群内查看'); return true }
    const f = getFake(gid)
    const m = String(e.msg || '').match(/(查宗门|查看宗门|宗门详情|宗门内部|宗门情报)\s*(\S*)/)
    const name = (m && m[2]) ? m[2] : ''
    if (!name) { e.reply('用法：#宗门详情 宗门名（#天下宗门 查看所有宗门）'); return true }
    const id = sectIdByName(f, name)
    if (!id) { e.reply(`没有找到宗门【${name}】，发 #天下宗门 看看有哪些`); return true }
    if (f.sects[id] && f.sects[id].wipeAt) { e.reply(`【${name}】已灭门，废墟之上等待新的开宗者……（#天下宗门 看现存宗门）`); return true }
    const sm = f.sectMap[id]
    const memberLine = (n) => {
      const p = f.roster[n]
      if (!p) return `${n}（已不在世）`
      return `${n}（${levelNameOf(p.level)} ${p.path}·${p.trait}${p.kills ? ` 战绩${p.kills}` : ''}${p.path === '魔道' ? ' ⚠️' : ''}）`
    }
    const lines = [`━━━ ${sectName(f, id)} ━━━`]
    /* 玩家成员(带🌙): 同宗玩家按职位并入 */
    const playerAt = (pos) => Object.values(f.players || {}).filter(p => p && p.sect === id && p.pos === pos).map(p => `🌙${p.name}`)
    lines.push(`太上长老：${[...sm.taishang.map(memberLine), ...playerAt('taishang')].join('\n　') || '（空缺）'}`)
    lines.push(`宗主：${[...(sm.zongzhu ? [memberLine(sm.zongzhu)] : []), ...playerAt('zongzhu')].join('\n　') || '（空缺·由副宗主代掌）'}`)
    lines.push(`副宗主：${[...sm.fuzong.map(memberLine), ...playerAt('fuzong')].join('\n　') || '（空缺）'}`)
    lines.push(`执事：${[...sm.zhishi.map(memberLine), ...playerAt('zhishi')].join('\n　') || '（空缺）'}`)
    lines.push(`弟子：${[...sm.dizi.map(memberLine), ...playerAt('dizi')].join('\n　') || '（无弟子）'}`)
    const areas = Object.keys(f.areas).filter(a => f.areas[a] === id).join('、') || '无地盘'
    lines.push(`地盘：${areas}`)
    lines.push(`文化：${sectCulture(f, id).desc}`)
    lines.push(`关系：${sectRelTxt(f, id)}`)
    /* 设施等级与每小时维护费(与 real 扣费一致: 玩家宗主×15/伪玩家×10, 含药园; 宝库不足自动降级) */
    const sectFacs = f.sects[id] && f.sects[id].facilities
    if (sectFacs) {
      const F = [['yanwu', '演武场'], ['hushan', '护山阵'], ['lingmai', '灵脉'], ['yaoyuan', '药园']]
      const parts = []
      let maint = 0
      for (const [k, cn] of F) {
        const lv = sectFacs[k] || 0
        if (lv <= 0) continue
        parts.push(`${cn}${lv}级`)
        maint += facilityMaintPerHr(f, id, k, lv)
      }
      lines.push(`设施：${parts.length ? parts.join('、') : '（未建造）'}${maint > 0 ? `\n维护费：每小时约 ${maint} 灵石（宝库不足自动降级）` : ''}`)
    }
    /* 宗门天牢: 谁被关押、剩余时间 */
    const jails = (f.sectJails || {})[id] || []
    if (jails.length) {
      const n2 = Date.now()
      lines.push(`⛓️ 天牢：${jails.map(x => `${x.name}（剩余 ${Math.max(0, Math.ceil(((x.until || 0) - n2) / 60000))} 分钟）`).join('、')}`)
    }
    /* 战况: 本宗正在攻打/被攻打 */
    const atks = (f.sectAttacks || []).filter(a => a.phase !== 'done')
    const atkList = atks.filter(a => a.atkSect === id)
    const defList = atks.filter(a => (a.targetType === 'sect' && a.target === id) || (a.targetType === 'area' && f.areas[a.target] === id))
    if (atkList.length) lines.push('⚔️ 正在攻打：' + atkList.map(a => `${warTargetTxt(f, a)}（${a.kind}${a.phase === 'fight' ? ` 第${a.round}轮` : ' 准备中'}）`).join('、'))
    if (defList.length) lines.push('🛡️ 正在被攻打：' + defList.map(a => `${sectName(f, a.atkSect)}${a.phase === 'fight' ? ` 第${a.round}轮` : ' 准备中'}`).join('、'))
    /* 宗门保护期(休战): 被攻打结束后按激烈程度 12~24 小时, 期间不可被攻打 */
    const truceUntil = (f.targetCd || {})['sect:' + id] || 0
    if (truceUntil > Date.now()) {
      const remainMin = Math.max(0, Math.ceil((truceUntil - Date.now()) / 60000))
      const rh = Math.floor(remainMin / 60)
      const rm = remainMin % 60
      lines.push(`🛡️ 保护期：剩 ${rh > 0 ? `${rh}小时${rm}分` : `${rm}分钟`}（休战中，期间不可被攻打）`)
    }
    /* 宗门事迹: 小境界突破不单独播报, 大境界突破和其他行为保留 */
    const minors = (f.bySect[id] || [])
      .filter(ev => !(ev.type === 'break' && ev.major === false && String(ev.txt || '').includes('【突破】')))
      .slice().reverse()
    if (minors.length) {
      lines.push('', `── 宗门事迹（共${minors.length}条） ──`)
      for (const ev of minors) lines.push(`[${fmtTime(ev.t)}] ${ev.type === 'player' ? '🌙 ' : ''}${ev.txt}`)
    }
    lines.push('', '发 #查人 名字 可看修士详情')
    await replyLines(e, `🏯 ${sectName(f, id)} 内部详情`, lines)
    return true
  }

  /* ---- #查人 [名字]: 本群伪玩家详情 ---- */
  async personInfo (e) {
    const gid = String(e.group_id || '')
    if (!gid) { e.reply('需在群内查看'); return true }
    const f = getFake(gid)
    const m = String(e.msg || '').match(/(查人|修士详情|人物详情)\s*(\S*)/)
    const name = (m && m[2]) ? m[2] : ''
    if (!name) { e.reply('用法：#查人 名字'); return true }
    const p = f.roster[name]
    if (!p) {
      const history = (f.byPerson && f.byPerson[name]) || []
      const deathEvent = history.slice().reverse().find(ev => ev && ev.type === 'death')
      const dead = (f.deathRecords && f.deathRecords[name]) || (deathEvent ? { t: deathEvent.t, txt: deathEvent.txt } : null)
      if (dead) {
        const deadSect = dead.sect || '散修'
        const deadLevel = dead.level ? levelNameOf(dead.level) : '境界不详'
        const acts = history.slice(-100).reverse()
        const lines = [
          `状态：已陨落`,
          `生前身份：${deadSect}${dead.pos && POS[dead.pos] ? `（${POS[dead.pos].cn}）` : ''}`,
          `生前修为：${deadLevel}${dead.path ? ` · ${dead.path}` : ''}${dead.trait ? ` · ${dead.trait}` : ''}`,
          `陨落时间：${fmtTime(dead.t || 0)}`,
          `死因：${dead.txt ? dead.txt : '旧档未保存具体死亡事件'}`
        ]
        if (acts.length) {
          lines.push('', `── 生平事迹（共${acts.length}条） ──`)
          for (const ev of acts) lines.push(`[${fmtTime(ev.t)}] ${ev.txt}`)
        }
        await replyLines(e, `💀 ${name} 的人物档案`, lines)
        return true
      }
      if ((f.pool || []).includes(name) || (f.poolPriority || []).includes(name)) e.reply(`👤 ${name} 尚未入世，正在名字池中等待入世……`)
      else e.reply(`查无此人【${name}】（#天下宗门 看各宗名单）`)
      return true
    }
    const sectTxt = p.status === 'sect' && p.sect ? `${sectName(f, p.sect)}（${POS[p.pos] ? POS[p.pos].cn : '弟子'}）` : '散修（游历江湖）'
    const r = p.relations || {}
    const relParts = []
    if (r.master) relParts.push(`师：${r.master}`)
    if (r.spouse) relParts.push(`道侣：${r.spouse}`)
    if ((r.disciples || []).length) relParts.push(`徒：${r.disciples.join('、')}`)
    /* 师兄师姐师弟师妹: 与师父的其他弟子互为同门师兄弟 */
    if (r.master && f.roster[r.master] && (f.roster[r.master].relations || {}).disciples) {
      const xd = f.roster[r.master].relations.disciples.filter(n => n !== name && f.roster[n] && f.roster[n].alive)
      if (xd.length) relParts.push(`师兄弟：${xd.join('、')}`)
    }
    if ((r.siblings || []).length) relParts.push(`手足：${r.siblings.join('、')}`)
    if ((r.confidants || []).length) relParts.push(`知己：${r.confidants.join('、')}`)
    /* 仇人只显示在世者(玩家仇人 player:uid 保留; 已陨落/离宗者不再显示) */
    const aliveEnemies = (r.enemies || []).filter(n => String(n).startsWith('player:') || (f.roster[n] && f.roster[n].alive))
    if (aliveEnemies.length) relParts.push(`仇：${aliveEnemies.join('、')}`)
    if ((r.friends || []).length) relParts.push(`友：${r.friends.join('、')}`)
    const relTxt = relParts.length ? relParts.join(' · ') : '孑然一身'
    /* 战力 = 玩家同口径换算: (境界战力 + 装备战力 + 出战灵兽战力) × 功法攻击倍率 + 丹药 */
    const power = personPower(p)
    const realm = realmPowerOf(p.level)
    const equip = getTotalAttr(p.bag || {}).power
    const petInfo = getActivePetInfo(gid, p.name, 'fake')
    const petPart = petInfo ? ` + 灵兽${petInfo.power}` : ''
    let gfAtk = 1
    const gfa = p.activeGongfa && GONGFA_TPL[p.activeGongfa]
    if (gfa && gfa.fx) gfAtk += Number(gfa.fx.atk) || 0
    const pillOn = p.pill && p.pill.until > Date.now()
    const eq = (p.bag && p.bag.equipped) || {}
    const eqParts = []
    if (eq.weapon) eqParts.push(`武器 ${itemIcon(eq.weapon)}${eq.weapon}`)
    if (eq.helmet) eqParts.push(`头盔 ${itemIcon(eq.helmet)}${eq.helmet}`)
    if (eq.chest) eqParts.push(`衣甲 ${itemIcon(eq.chest)}${eq.chest}`)
    if (eq.pants) eqParts.push(`护腿 ${itemIcon(eq.pants)}${eq.pants}`)
    if (eq.shoes) eqParts.push(`战靴 ${itemIcon(eq.shoes)}${eq.shoes}`)
    if (eq.ring) eqParts.push(`戒指 ${itemIcon(eq.ring)}${eq.ring}`)
    const eqTxt = eqParts.length ? eqParts.join('、') : '（未穿戴）'
    const gf = p.learnedGongfa || []
    const gfTxt = gf.length
      ? gf.map(n => n === p.activeGongfa ? `${itemIcon(n)}《${n}》（运转中）` : `${itemIcon(n)}《${n}》`).join('、')
      : '（未学功法）'
    let pillTxt = ''
    if (p.pill && p.pill.until > Date.now()) {
      const d = new Date(p.pill.until)
      const pad = n => String(n).padStart(2, '0')
      const fxTxt = { 惊鸿丹: '攻击+20%', 玉甲丹: '防御+20%', 凝露丹: '生命+20%', 慧心丹: '暴击率+30%', 摄魂丹: '爆伤+50%', 灵犀丹: '双修收益翻倍', 行运丹: '挂机收益翻倍', 聚宝丹: '幸运提升', 同心丹: '道侣好感+1000' }[p.pill.name] || '药效中'
      pillTxt = `服下${itemIcon(p.pill.name)}${p.pill.name}（${fxTxt}，持续至 ${pad(d.getHours())}:${pad(d.getMinutes())}）`
    }
    /* 全部信息: 灵石/灵力/大区/背包/入世等 */
    const money = Number(p.money) || 0
    const exp = Number(p.exp) || 0
    const locTxt = regionNameOf(p.loc || 'center')
    const bagItems = (p.bag && p.bag.items) || {}
    const itemParts = Object.keys(bagItems)
      .filter(n => itemCount(bagItems[n]) > 0)
      .sort()
      .map(n => `${itemIcon(n)}${n} ×${itemCount(bagItems[n])}`)
    const bagTxt = itemParts.length ? itemParts.join('、') : '（空空如也）'
    const lines = [
      `宗门：${sectTxt}`,
      ...(isFakeCaptive(f, p.name) ? ['⛓️ 状态：被俘中（等待处置）'] : []),
      `道途：${p.path} · 性格：${p.trait} · 行为：${p.act || '普通'}${p.path === '魔道' ? '（⚠️魔修）' : ''}`,
      `忠诚：${p.loyalty >= 0 ? p.loyalty : '—'}${p.vendetta ? `（${p.vendetta.sectName || '故宗'}覆灭之仇未报）` : ''}`,
      ...(Number(p.fightCount) > 0 || Number(p.absentStreak) > 0 ? [`参战：出战 ${p.fightCount || 0} 次${Number(p.absentStreak) > 0 ? ` · 连续避战 ${p.absentStreak} 次` : ''}${p.lastFightAt ? ` · 最近 ${fmtTime(p.lastFightAt)}` : ''}`] : []),
      ...(Number(p.sin) > 0 ? [`业障：${p.sin}${p.sin >= 8 ? '（杀孽深重）' : (p.sin >= 3 ? '（因果缠身）' : '')}`] : []),
      `所在大区：${locTxt}`,
      `修为：${levelNameOf(p.level)}`,
      `战力：${power}（境界${realm} + 装备${equip}${petPart} ×功法倍率${gfAtk}${pillOn ? ' +丹药5' : ''}）`,
      `出战灵兽：${petInfo ? `${petInfo.name}（${petInfo.stage}）· 战力 ${petInfo.power}` : '无（尚无出战灵兽）'}`,
      `灵石：${money}`,
      `灵力：${exp}${(Number(p.accum) || 0) > 0 ? `（累计池+${Number(p.accum)}，突破后并入）` : ''}`,
      `装备：${eqTxt}`,
      `背包：${bagTxt}`,
      `功法：${gfTxt}`,
      ...(pillTxt ? [`丹药：${pillTxt}`] : []),
      `关系：${relTxt}`,
      `战绩：击杀 ${p.kills} 人`,
      `入世：${fmtTime(p.joinAt)}`,
      `状态：在世`
    ]
    /* 参战记录(攻防相关, 显示最近20条) */
    const WAR_RE = /攻打|守|战|出征|攻占|败退|拉锯|宣战|开战|俘虏|远遁|调兵|护城|处决|释放|搜刮|城破|迎战/
    const wars = (f.byPerson[p.name] || []).filter(x => WAR_RE.test(x.txt)).slice(-20).reverse()
    if (wars.length) {
      lines.push('', `── 参战记录（${wars.length}条） ──`)
      for (const ev of wars) lines.push(`[${fmtTime(ev.t)}] ${ev.type === 'player' ? '🌙 ' : ''}${ev.txt}`)
    }
    /* 此人事迹(全部行为动作: 大事+小事, 显示最近100条) */
    const acts = (f.byPerson[p.name] || []).slice(-100).reverse()
    if (acts.length) {
      lines.push('', `── 生平事迹（共${acts.length}条） ──`)
      for (const ev of acts) lines.push(`[${fmtTime(ev.t)}] ${ev.type === 'player' ? '🌙 ' : ''}${ev.txt}`)
    }
    await replyLines(e, `👤 ${p.name} 的详细信息`, lines)
    return true
  }

  /* ---- #伪玩家宠物榜: 独立 fake pet 存档, 不混入真实玩家灵兽榜 ---- */
  async fakePetRank (e) {
    const gid = String(e.group_id || '')
    if (!gid) { e.reply('需在群内查看'); return true }
    const ranked = groupPetRank(gid, 20, 'fake')
    if (!ranked.length) { e.reply('🐾 伪玩家尚无灵兽上榜，江湖仍在结缘'); return true }
    const lines = ranked.map((x, i) => {
      const status = x.canBattle ? '可出战' : '尚幼'
      return `${i + 1}. ${x.uid}｜${qualityNameOf(x.quality)}【${x.name}】·${x.stage}·${status}｜战力 ${x.power}（大成 ${x.maxPower}）`
    })
    await replyLines(e, '🐾 伪玩家灵兽榜（独立榜单）', [
      ...lines,
      '',
      '伪玩家灵兽与真实玩家灵兽分开搜寻、捕获、养成及红彩天机；战力仍计入伪玩家自身战力。'
    ])
    return true
  }

  /* ---- #战力榜: 本群伪玩家战力排行 ---- */
  async powerRank (e) {
    const gid = String(e.group_id || '')
    if (!gid) { e.reply('需在群内查看'); return true }
    const f = getFake(gid)
    const all = Object.values(f.roster).filter(p => p.alive)
    if (!all.length) { e.reply('⚔️ 江湖尚无修士'); return true }
    const ranked = all.map(p => ({ p, power: personPower(p) }))
      .sort((a, b) => b.power - a.power || (Number(b.p.level) || 0) - (Number(a.p.level) || 0))
    const shown = ranked.slice(0, 20)
    const lines = shown.map((x, i) => {
      const p = x.p
      const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
      const pos = p.status === 'sect' && p.pos && POS[p.pos] ? POS[p.pos].cn : ''
      return `${i + 1}. ${p.name}（${who}${pos ? '·' + pos : ''}）战力 ${x.power}｜${levelNameOf(p.level)}${p.path === '魔道' ? ' ⚠️' : ''}`
    })
    if (ranked.length > 20) lines.push('', `…共 ${ranked.length} 人，仅显示前 20`)
    await replyLines(e, '⚔️ 天下战力榜（本群）', lines)
    return true
  }

  /* ---- #天下灵石: 本群真实玩家财富排行(图片, 失败回退纯文本) ---- */
  async wealthRank (e) {
    try {
      const gid = String(e.group_id || '')
      if (!gid) { e.reply('需在群内查看'); return true }
      if (!e.group || typeof e.group.getMemberMap !== 'function') {
        e.reply('暂时无法读取群成员，请稍后再试')
        return true
      }
      /* 只读已存在的家庭存档，避免查看榜单时给全群成员批量建档 */
      const homeData = await xujing_data.getQQYUserHomeData(`${gid}.json`)
      const all = buildWealthRank(homeData, await e.group.getMemberMap())
      if (!all.length) {
        e.reply('💰 本群暂无灵石记录，快去 #摆摊 或 #挂机结算赚取第一桶金')
        return true
      }
      const shown = all.slice(0, 10)
      /* 图片渲染: 复用排行结构, 独立金色财富主题模板(前三名奖牌高亮) */
      const d = new Date()
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
      try {
        const img = await puppeteer.screenshot(`${Plugin_Name}/wealth/index`, {
          tplFile: path.join(Plugin_Path, 'resources', 'wealth', 'index.html'),
          pluResPath: resPath,
          _res_path: resPath,
          saveId: `wealth-${Date.now()}`,
          rankTitle: '天下灵石',
          rankSub: '虚境 · 本群财富排行',
          rankValueLabel: '灵石',
          rankDate: dateStr,
          rankFoot: `共 ${all.length} 位玩家上榜 · 仅显示前 ${shown.length} 名 · 发送 #天下灵石`,
          rankShowLevel: false,
          rankList: shown.map((x, i) => ({
            rank: i + 1,
            medal: ['🥇', '🥈', '🥉'][i] || `${i + 1}`,
            cls: i === 0 ? 'first' : i === 1 ? 'second' : i === 2 ? 'third' : '',
            uid: x.uid,
            nick: x.nick,
            levelname: '',
            dmg: x.money.toLocaleString(),
            power: 0,
            exp: 0,
            need: 0
          }))
        })
        if (img) { e.reply(img); return true }
      } catch (err) {
        logger.error('[天下灵石]渲染失败:' + (err && err.stack))
      }
      /* 回退纯文本 */
      const lines = shown.map((x, i) => `${i + 1}. ${x.nick}：${x.money.toLocaleString()} 灵石`)
      if (all.length > shown.length) lines.push('', `…共 ${all.length} 位玩家上榜，仅显示前 ${shown.length} 名`)
      await replyLines(e, '💰 天下灵石（本群财富榜）', lines)
      return true
    } catch (err) {
      logger.error('[天下灵石]异常:' + (err && err.stack))
      e.reply('查询天下灵石出错了，请稍后再试')
      return true
    }
  }

  /* ---- #江湖交易: 本群伪玩家三阁交易记录 ---- */
  async tradeNews (e) {
    const gid = String(e.group_id || '')
    if (!gid) { e.reply('需在群内查看'); return true }
    const f = getFake(gid)
    const cut = Date.now() - 24 * 3600000
    const trades = (f.trades || []).filter(x => x.t >= cut).slice().reverse()
    if (!trades.length) {
      e.reply('🏪 江湖买卖兴隆，最近 24 小时暂无交易（三阁货物正等伪修士光顾）')
      return true
    }
    const shown = trades.slice(0, 100)
    /* 玩家真实交易(三阁购买)加 🌙 标识(按 player 标记, 玩家称谓为散修); 带序号 */
    const lines = shown.map((x, i) => `${i + 1}. [${fmtTime(x.t)}] ${x.player ? '🌙 ' : ''}${x.txt}`)
    if (trades.length > 100) lines.push('', `…共 ${trades.length} 条，仅显示最新 100 条`)
    await replyLines(e, '🏪 江湖交易（近24小时，随时可查）', lines)
    return true
  }

  /* ---- #天下小事: 本群全部小事(按名字/宗门筛选已融合到 #查人/#宗门详情) ---- */
  async smallNews (e) {
    try {
      const gid = String(e.group_id || '')
      if (!gid) { e.reply('需在群内查看'); return true }
      const f = getFake(gid)
      const cut = Date.now() - 24 * 3600000
      const evs = (f.minor || []).filter(x => x.t >= cut).sort((a, b) => b.t - a.t)
      if (!evs.length) {
        e.reply('🍃 江湖风平浪静，最近 24 小时无琐事')
        return true
      }
      const lines0 = evs.map(x => `[${fmtTime(x.t)}] ${x.type === 'player' ? '🌙 ' : ''}${x.txt}`)
      const shown = lines0.slice(0, 100)
      const lines = shown.map((s, i) => `${i + 1}. ${s}`)
      if (lines0.length > 100) lines.push('', `…共 ${lines0.length} 条，仅显示最新 100 条`)
      await replyLines(e, '🍃 天下小事（近24小时，随时可查）', lines)
      return true
    } catch (err) {
      logger.error('[天下小事]异常:' + (err && err.stack))
      e.reply('🍃 查询天下小事出错了，请稍后再试')
      return true
    }
  }

  /* ---- #天下天牢: 全江湖天牢总览(藏宝阁天牢 + 各宗门天牢) ---- */
  async jailListCmd (e) {
    try {
      const gid = String(e.group_id || '')
      if (!gid) { e.reply('需在群内查看'); return true }
      const f = getFake(gid)
      const now = Date.now()
      const lines = []

      /* ── 藏宝阁天牢(洗劫被抓): 玩家(redis) + 伪玩家(存档) ── */
      lines.push('🏛️ 藏宝阁天牢')
      const vaultRows = []
      /* 玩家(真实) */
      let realJails = []
      try { realJails = await allJails() } catch (err) { }
      for (const j of realJails) {
        const nm = await getNick(j.gid || gid, j.uid)
        vaultRows.push({ kind: '玩家', name: nm, at: j.at || 0, until: j.expireAt })
      }
      /* 伪玩家(存档) */
      for (const j of raidJailList(f, now)) {
        vaultRows.push({ kind: '伪玩家', name: j.name, at: j.at || 0, until: j.until })
      }
      vaultRows.sort((a, b) => a.at - b.at)
      if (!vaultRows.length) {
        lines.push('　（空无一人，江湖太平）')
      } else {
        for (const x of vaultRows) {
          const dur = Math.max(0, Math.round((now - x.at) / 60000))
          const left = Math.max(0, Math.round((x.until - now) / 60000))
          lines.push(`　· [${x.kind}] ${x.name}　${fmtTime(x.at)} 入狱（已关 ${dur} 分钟 · 剩 ${left} 分钟）`)
        }
      }

      /* ── 各宗门天牢(战俘收押, 无限期可越狱) ── */
      lines.push('', '⛩️ 宗门天牢')
      let jailTotal = 0
      const sids = Object.keys(f.sectJails || {})
      if (!sids.length) {
        lines.push('　（天下宗门均未设狱，四海升平）')
      } else {
        for (const sid of sids) {
          const arr = sectJailList(f, sid)
          if (!arr.length) continue
          const sname = sectName(f, sid)
          lines.push(`　【${sname}】`)
          for (const x of arr) {
            jailTotal++
            const nm = x.uid ? await getNick(gid, x.uid) : (x.name || '未知')
            const dur = Math.max(0, Math.round((now - (x.at || now)) / 60000))
            const esc = Math.round(escapeRateOf(x.at || now, now) * 100)
            lines.push(`　　· ${nm}　${fmtTime(x.at)} 收押（已关 ${dur} 分钟 · 越狱率 ${esc}%）`)
          }
        }
      }
      if (!vaultRows.length && !jailTotal) lines.push('', '（全天牢空无一人，天下太平）')
      lines.push('', '💡 藏宝阁天牢：洗劫被抓，刑满自动释放；宗门天牢：战俘收押，可越狱（越狱率随关押时间提升，满24小时必成）')

      await replyLines(e, '⛓️ 天下天牢（全江湖关押总览）', lines)
      return true
    } catch (err) {
      logger.error('[天下天牢]异常:' + (err && err.stack))
      e.reply('⛓️ 查询天下天牢出错了，请稍后再试')
      return true
    }
  }

}
