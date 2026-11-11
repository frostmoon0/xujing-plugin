/* ============================================================
 * 遗蜕秘境 - 指令与流程
 * #进入秘境 / #攻击屏障 / #撤离 / #秘境状态 / #使用遗蜕古钥 / #秘境开关 / #秘境刷新
 * 公开秘境: 定时刷新, 大区破界, 多队同场
 * 专属秘境: #使用遗蜕古钥 开启, 仅本队可入, 无破界直接探索, 不会遇到其他玩家队
 * 探索和伪玩家行动均由系统 tick 驱动; 玩家只在收到节点后回复数字。
 * ============================================================ */
import { plugin } from '../../model/api/api.js'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import schedule from 'node-schedule'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import { Plugin_Name, Plugin_Path } from '../../components/plugin.js'
import {
  getRealm, saveRealm, getRealmCfg, realmCfgRefresh,
  getPrivateRealm, getPrivateRealms, savePrivateRealm, openPrivateRealm, activePrivateRealms,
  TERRAINS, DIFFS, BARRIERS, activeRealmGroups, partyIdOf, partyInfoOf,
  spawnRealm, attackBarrier, fakeAttackBarrier, breakBarrier, stopBarrierAuto,
  enterRealm, leaveTeam, teamOf, advanceTeams, advanceFakeArrivals, driveFakeTeams, syncPlayerTeam,
  resolveNode, resolveDisposal, menuText, rollEvent, applyEvent, settleAll, actionDelay, REALM_QUALITY_WEIGHTS, planSplit, fmtRewards, refreshRealmNode,
  isNight, reconcileFakeBusy, withRealmLock, autoPickForPlayer, beginAmbush, processAmbushRound, replaceRealmPlayerIds
} from '../../components/realm_data.js'
import { SECRET_KEY, consumeItem, addItem, QUALITY, itemIcon } from '../../components/equip_data.js'
import { getFake, sectName, withFakeLock } from '../../components/fake_data.js'
import { realmNpcTeamIdentity } from '../../components/realm_narrative.js'
import { forceLock, isCurrent, unlock, currentInteract } from '../../components/interact.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { getWorld, getLoc, regionNameOf } from '../../components/world_data.js'

const NODE_TIMEOUT_MIN = 5
const AMBUSH_MINUTES = 2.5 // 出口围剿: 公开秘境探索最后2.5分钟触发
const cfgPath = () => `./plugins/${Plugin_Name}/config/xujing.config.yaml`
function sendToGroup (gid, msg) { try { const g = Bot.pickGroup(gid); if (g?.sendMsg) g.sendMsg(msg) } catch (err) {} }
async function notifyAt (gid, uid, text) {
  try {
    const g = Bot.pickGroup(gid)
    if (g?.sendMsg) g.sendMsg([segment.at(Number(uid)), `\n${await formatRealmPush(gid, text)}`])
  } catch (err) {}
}
function isInRegion (gid, uid, region) { try { return getLoc(getWorld(gid), uid) === region } catch (err) { return false } }

/** 用户在哪个秘境(公开或专属)的队伍里 */
function realmOfUser (gid, uid) {
  const p = getPrivateRealms(gid).find(x => ['barrier', 'explore'].includes(x.phase) && teamOf(x, uid))
  if (p) return p
  const pub = getRealm(gid)
  if (teamOf(pub, uid)) return pub
  return null
}

/** 随机帮助背景图(与功法图鉴/配方台一致) */
function rodom () {
  try {
    const imageDir = path.join(Plugin_Path, 'resources', 'help', 'imgs')
    if (!fs.existsSync(imageDir)) return ''
    const list = fs.readdirSync(imageDir)
    if (!list.length) return ''
    return list.length === 1 ? list[0] : list[Math.floor(Math.random() * list.length)]
  } catch (err) { return '' }
}

/** 当前时间 MM月DD日 HH:mm */
function fmtDateTime () {
  const n = new Date()
  return `${n.getMonth() + 1}月${n.getDate()}日 ${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`
}

/** 阶别配色: 黄=金 玄=蓝 地=紫 天=彩 */
const DIFF_Q = { huang: 5, xuan: 3, di: 4, tian: 7 }

/** 群成员昵称映射: uid -> 群名片/昵称（查询失败时绝不回退显示 QQ 号） */
async function memberNamesOf (gid) {
  const names = new Map()
  try {
    const memberMap = await Bot.pickGroup(gid).getMemberMap()
    for (const entry of memberMap || []) {
      const info = entry[1]
      const name = String(info?.card || info?.nickname || '').trim()
      if (info?.user_id && name) names.set(String(info.user_id), name)
    }
  } catch (err) { }
  return names
}

function memberNameOf (names, uid) { return names.get(String(uid)) || '无名修士' }

/** 替换秘境推送中带结构标记的玩家 QQ 号；找不到群名片时使用安全占位名。 */
async function formatRealmPush (gid, text) {
  const names = await memberNamesOf(gid)
  return replaceRealmPlayerIds(text, names)
}

/** 场内队伍展示行(公开/专属共用) */
async function teamRows (st, gid) {
  const rows = []
  const teams = Object.values(st.teams || {}).filter(t => !t.dead && (t.members || []).length && (t.kind === 'fake' || st.phase === 'barrier' || t.entered !== false))
  const fakeWorld = getFake(gid)
  const memberNames = await memberNamesOf(gid)
  for (const t of teams) {
    let action
    if (t.node) action = t.node.title
    else if (t.arrivalAt && Date.now() < t.arrivalAt) action = `🛣️ 赶路（约${Math.max(1, Math.ceil((t.arrivalAt - Date.now()) / 60000))}分钟后到达）`
    else if (t.kind === 'fake' && st.phase === 'barrier') action = '⚔️ 正在破除入口禁制'
    else if (t.kind === 'fake' && t.entered === false) action = '🚪 守在入口，等待入境'
    else if (t.kind === 'fake' && t.ambush === 'fight') action = '守住出口，留意过往修士'
    else if (t.kind === 'fake' && t.ambush === 'flee') action = '收拢行装，寻找离场时机'
    else if (t.kind === 'fake' && t.injured) action = '调息疗伤，准备继续探路'
    else if (t.kind === 'fake' && t.hidden) action = '隐匿气息，继续探路'
    else if (t.kind === 'fake') action = '稍作休整，准备继续深入'
    else action = '⏳ 等待行动'
    let name = t.name
    let tag = `${(t.members || []).length}人`
    let members = ''
    if (t.kind === 'fake') {
      const persons = (t.members || []).map(n => fakeWorld.roster?.[n] || { name: n })
      const identity = realmNpcTeamIdentity(persons, { leader: t.leader, sectNameOf: sid => sectName(fakeWorld, sid) })
      name = identity.name
      tag = persons.length === 1 ? '独行' : `${identity.sectName ? '同门' : '结伴'} · ${persons.length}人`
      if (persons.length > 1) members = `同行：${persons.map(p => p.name).join('、')}`
    }
    const lootPlan = planSplit(t)
    const memberLoot = (t.members || []).map(uid => {
      const part = lootPlan.find(x => String(x.uid) === String(uid))
      const items = part?.items || []
      const label = t.kind === 'fake' ? (fakeWorld.roster?.[uid]?.name || '无名散修') : memberNameOf(memberNames, uid)
      return `${label}：${items.length ? fmtRewards(items) : '暂无收获'}`
    }).join('；')
    rows.push({ name, tag, members, kind: t.kind, action, loot: memberLoot || '暂无收获' })
  }
  return rows
}

/** 构建秘境总览数据(公开+专属), 供图片模板/纯文本回退共用 */
async function buildRealmOverview (gid) {
  const realms = []
  const renderOne = async (st, isPrivate) => {
    if (!st || !['barrier', 'explore'].includes(st.phase)) return
    const diff = DIFFS[st.diff] || {}
    const terrain = TERRAINS[st.terrain]
    const item = {
      cardCls: isPrivate ? 'private' : 'public',
      label: isPrivate ? `🗝️ 专属秘境${st.privateId ? `·${String(st.privateId).slice(-4)}` : ''}` : '公开秘境',
      title: st.title,
      diffQ: DIFF_Q[st.diff] || 5,
      diffName: diff.name || st.diff,
      diffRealm: diff.realm ? `建议${diff.realm}` : '',
      region: regionNameOf(st.region),
      isBarrier: st.phase === 'barrier',
      isExplore: st.phase === 'explore',
      exploreLeft: 0,
      barrierName: (terrain && BARRIERS[terrain.barrier]) ? BARRIERS[terrain.barrier].name : '',
      barrierPct: 0,
      barrierHp: '',
      barrierMax: '',
      autoPlayers: '',
      desc: st.desc || '',
      rewards: [],
      teams: await teamRows(st, gid)
    }
    if (st.phase === 'barrier') {
      const hp = st.barrier?.hp || 0; const max = st.barrier?.maxHp || 0
      item.barrierPct = max ? Math.round(hp / max * 100) : 0
      item.barrierHp = hp.toLocaleString()
      item.barrierMax = max.toLocaleString()
      if (st.barrier?.auto) {
        const names = await memberNamesOf(gid)
        item.autoPlayers = Object.keys(st.barrier.auto).map(uid => memberNameOf(names, uid)).join('、')
      }
    } else {
      item.exploreLeft = Math.max(0, Math.ceil((st.endAt - Date.now()) / 60000))
    }
    /* 掉落品质概率：按阶别配置的品质权重展示 */
    const qualityWeights = REALM_QUALITY_WEIGHTS[st.diff] || REALM_QUALITY_WEIGHTS.tian
    const weightTotal = Object.values(qualityWeights).reduce((sum, weight) => sum + weight, 0)
    item.rewards = Object.entries(qualityWeights)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([quality, weight]) => {
        const q = Number(quality)
        return { q, icon: QUALITY[q]?.icon || '⚪', name: QUALITY[q]?.name || `品质${q}`, pct: Math.round(weight / weightTotal * 10000) / 100 }
      })
    realms.push(item)
  }
  const pub = getRealm(gid)
  await renderOne(pub, false)
  for (const priv of getPrivateRealms(gid)) await renderOne(priv, true)
  return { realms, count: realms.length, empty: !realms.length }
}

/** 纯文本回退 */
function buildRealmText (data) {
  const lines = ['🌌 虚境 · 天下秘境']
  if (data.empty) { lines.push('', '当前没有现世的秘境。'); return lines.join('\n') }
  for (const r of data.realms) {
    lines.push('', `${r.label} ${r.title}（${r.diffName}${r.diffRealm ? '·' + r.diffRealm : ''}）`)
    lines.push(`📍 ${r.region}`)
    if (r.isBarrier) {
      lines.push(`🛡️ ${r.barrierName} ${r.barrierPct}% · ${r.barrierHp}/${r.barrierMax}`)
      if (r.autoPlayers) lines.push(`⚔️ 玩家持续破界：${r.autoPlayers}（每20秒自动攻击）`)
    } else {
      lines.push(`⏳ 等待行动 · 剩余 ${r.exploreLeft} 分钟`)
    }
    if (r.rewards.length) lines.push(`🎁 品质掉落：${r.rewards.map(x => `${x.icon}${x.name} ${x.pct}%`).join('、')}`)
    if (!r.teams.length) { lines.push('👥 场内暂无队伍'); continue }
    for (const t of r.teams) {
      lines.push(`· ${t.name}（${t.tag}）—— ${t.action}`)
      if (t.members) lines.push(`  ${t.members}`)
      lines.push(`  🎁 当前收获：${t.loot}`)
    }
  }
  lines.push('', '#进入秘境 · #攻击屏障 · #撤离 · #使用遗蜕古钥')
  return lines.join('\n')
}

export class realm extends plugin {
  constructor () {
    super({
      name: '遗蜕秘境', dsc: '遗蜕秘境探索/破界/PvP夺宝/专属秘境', event: 'message', priority: 42,
      rule: [
        { reg: '^[#＃]?天下秘境$', fnc: 'realmAll' },
        { reg: '^[#＃]?秘境状态$', fnc: 'status' },
        { reg: '^[#＃]?(进入秘境|进入遗蜕秘境)$', fnc: 'enter' },
        { reg: '^[#＃]?(攻击屏障|破界|攻打屏障)$', fnc: 'atkBarrier' },
        { reg: '^[#＃]?(停止攻击屏障|停止破界)$', fnc: 'stopBarrier' },
        { reg: '^[#＃]?(撤离|离开秘境)$', fnc: 'quit' },
        { reg: '^[#＃]?(使用遗蜕古钥|使用古钥|开启专属秘境|开启遗蜕秘境)$', fnc: 'useKey' },
        { reg: '^[#＃]?秘境开关\\s*(开|关|开启|关闭)\\s*$', fnc: 'toggle', auth: 'master' },
        { reg: '^[#＃]?秘境刷新$', fnc: 'forceSpawn', auth: 'master' },
        { reg: '^[#＃]?[0-9]+$', fnc: 'pick' }
      ]
    })
    if (!global.__xujingRealmTick__) {
      global.__xujingRealmTick__ = true
      schedule.scheduleJob('* * * * *', () => { realmTick().catch(err => logger.error('[遗蜕秘境]推进异常:' + (err && err.stack))) })
    }
  }

  /** #秘境状态 / #天下秘境: 同一视图, 渲染本群所有现世秘境(公开+专属)及各队伍当前行为 */
  async status (e) { return this.renderRealmOverview(e) }
  async realmAll (e) { return this.renderRealmOverview(e) }

  async renderRealmOverview (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id)
    const cfg = await getRealmCfg()
    if (!cfg.group.includes(gid)) return false
    const data = await buildRealmOverview(gid)
    /* 图片渲染, 失败回退纯文本 */
    const bg = rodom()
    const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
    try {
      const img = await puppeteer.screenshot(`${Plugin_Name}/realm/index`, {
        tplFile: path.join(Plugin_Path, 'resources', 'realm', 'index.html'),
        pluResPath: resPath,
        _res_path: resPath,
        saveId: `realm-${Date.now()}`,
        bg,
        sub: (data.count ? `${data.count} 座秘境现世` : '暂无秘境') + ' · ' + fmtDateTime(),
        empty: data.empty,
        realms: data.realms
      })
      if (img) { e.reply(img); return true }
    } catch (err) {
      logger.error('[遗蜕秘境]渲染失败:' + (err && err.message))
    }
    e.reply(buildRealmText(data))
    return true
  }

  async enter (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id); const cfg = await getRealmCfg()
    /* 专属秘境(遗蜕古钥)不受 realm_cfg.group 白名单限制; 公开秘境仍受白名单控制 */
    const partyId = partyIdOf(gid, e.user_id)
    const p = getPrivateRealms(gid).find(x => ['barrier', 'explore'].includes(x.phase) && (
      partyId === x.ownerPartyId || Object.values(x.teams || {}).some(t => t.kind === 'player' && (t.partyMembers || []).map(String).includes(String(e.user_id)))
    ))
    if (p) {
      const r = await withRealmLock(gid, async () => await withFakeLock(gid, async () => {
        const current = getPrivateRealm(gid, p.privateId)
        return current ? enterRealm(current, gid, e.user_id) : null
      }))
      if (r?.ok) { e.reply([segment.at(e.user_id), `\n🗝️ ${r.msg}`]); return true }
      if (r?.msg) { e.reply([segment.at(e.user_id), `\n${r.msg}`]); return true }
      return false
    }
    /* 公开秘境: 受开关与白名单控制 */
    if (!cfg.group.includes(gid)) return false
    const ok = cfg.enable === 'T' || cfg.enable === true
    if (!ok) return false
    const st = getRealm(gid)
    if (!['barrier', 'explore'].includes(st.phase)) return false
    const r = await withRealmLock(gid, async () => await withFakeLock(gid, async () => enterRealm(getRealm(gid), gid, e.user_id)))
    if (!r?.ok) {
      if (r?.msg) { e.reply([segment.at(e.user_id), `\n${r.msg}`]); return true }
      return false
    }
    e.reply([segment.at(e.user_id), `\n🌌 ${r.msg}`]); return true
  }

  async atkBarrier (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id); const cfg = await getRealmCfg()
    if (!cfg.group.includes(gid)) return false
    const st = getRealm(gid)
    if (st.phase !== 'barrier' || !isInRegion(gid, e.user_id, st.region)) return false
    const r = await withRealmLock(gid, async () => await withFakeLock(gid, async () => {
      const current = getRealm(gid)
      if (current.phase !== 'barrier' || !isInRegion(gid, e.user_id, current.region)) return null
      const key = `xujing:realm-barrier:${gid}:${e.user_id}`
      try { const ttl = await redis.ttl(key); if (ttl > 0) return { cd: ttl }; await redis.set(key, 1, { EX: 2 }) } catch (err) {}
      if (current.barrier?.auto?.[String(e.user_id)]) return { already: true }
      const b = await attackBarrier(current, e.user_id, gid)
      saveRealm(current, gid)
      if (b.broke) { const broken = await breakBarrier(current, gid); return { broke: true, dmg: b.dmg, reward: broken.reward, hero: broken.hero } }
      return b
    }))
    if (!r) return false
    if (r.cd) { e.reply([segment.at(e.user_id), `\n🛡️ 攻击冷却：${r.cd}秒。`]); return true }
    if (r.already) { e.reply([segment.at(e.user_id), '\n⚔️ 正在自动破界，每20秒攻击一次。']); return true }
    if (r.broke) {
      e.reply([segment.at(e.user_id), '\n💥 屏障已破，探索开始。发送 #进入秘境 入场。'])
      await bcastBarrierBroke(getRealm(gid), r.hero)
    }
    else e.reply([segment.at(e.user_id), `\n⚔️ 已开始自动破界，首击伤害${r.dmg}，屏障剩余${Math.round(r.hp / r.maxHp * 100)}%。\n每20秒攻击一次；#停止攻击屏障 退出。`])
    return true
  }

  async stopBarrier (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id); const cfg = await getRealmCfg()
    if (!cfg.group.includes(gid)) return false
    const st = getRealm(gid)
    if (st.phase !== 'barrier' || !st.barrier?.auto?.[String(e.user_id)]) return false
    await withRealmLock(gid, async () => { const current = getRealm(gid); stopBarrierAuto(current, e.user_id) })
    e.reply([segment.at(e.user_id), '\n🛑 已停止自动攻击屏障。']); return true
  }

  async quit (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id); const cfg = await getRealmCfg()
    const st = realmOfUser(gid, e.user_id)
    if (!st || !['barrier', 'explore'].includes(st.phase)) return false
    /* 专属秘境(遗蜕古钥)不受 realm_cfg.group 白名单限制, 否则非白名单群用钥进入后 #撤离 会静默失败 */
    if (!st.private && !cfg.group.includes(gid)) return false
    const r = await withRealmLock(gid, async () => await withFakeLock(gid, async () => await leaveTeam(st.private ? getPrivateRealm(gid, st.privateId) : getRealm(gid), gid, e.user_id)))
    if (!r?.ok) return false
    await unlock(gid, e.user_id, 'realm').catch(() => {})
    const settlement = await formatRealmPush(gid, r.msgs.join('、'))
    e.reply([segment.at(e.user_id), `\n🏃 已${r.barrier ? '退出入场队伍' : '撤离秘境'}${settlement ? `，结算获得：${settlement}` : '。'}`]); return true
  }

  async useKey (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id); const cfg = await getRealmCfg()
    /* 钥匙可用条件 = 自动刷新开关开启(enable=T); 不是白名单 */
    if (!(cfg.enable === 'T' || cfg.enable === true)) { e.reply('秘境已关闭，暂不能使用古钥。'); return true }
    const uid = e.user_id
    const result = await withRealmLock(gid, async () => await withFakeLock(gid, async () => {
      /* 队长或单人使用；检查、扣钥、建档必须处于同一组锁内。 */
      const party = partyInfoOf(gid, uid)
      if (party && String(uid) !== String(party.leader)) return { ok: false, msg: `请由队长使用${itemIcon(SECRET_KEY)}遗蜕古钥。` }
      if (!consumeItem(uid, SECRET_KEY, 1, null, gid)) return { ok: false, msg: `缺少${itemIcon(SECRET_KEY)}遗蜕古钥。来源：世界Boss、藏宝阁洗劫、每日秘境、万魂窟。` }
      const result = await openPrivateRealm(gid, cfg, uid, party ? `party:${party.id}` : `solo:${uid}`, party ? party.members : [uid])
      if (!result.ok) addItem(uid, SECRET_KEY, 1, null, gid)
      return result
    }))
    if (!result.ok) { e.reply(result.msg); return true }
    const info = result.info
    const names = await memberNamesOf(gid)
    sendToGroup(gid, replaceRealmPlayerIds(`🗝️ ${itemIcon(SECRET_KEY)}遗蜕古钥开启专属秘境：${info.title}\n🆔 秘境编号：${String(info.privateId).slice(-4)}\n📍 ${regionNameOf(info.region)} · ${info.diffName}（建议${info.realm}）\n📜 ${result.st.desc}（探索${info.exploreMin}分钟）`, names))
    e.reply([segment.at(uid), `\n🗝️ 专属秘境【${info.title}】已开启，队长已入场。队员各自发送 #进入秘境 加入。\n仅本队可入，探索${info.exploreMin}分钟。`])
    return true
  }

  async toggle (e) {
    const m = String(e.msg || '').match(/(开|关|开启|关闭)\s*$/)
    const on = m && (m[1] === '开' || m[1] === '开启')
    try {
      const all = YAML.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}; if (!all.realm_cfg) all.realm_cfg = {}; all.realm_cfg.enable = on ? 'T' : 'F'; fs.writeFileSync(cfgPath(), YAML.stringify(all)); realmCfgRefresh(); e.reply(`✅ 遗蜕秘境已${on ? '开启' : '关闭'}（进行中的秘境继续）`)
    } catch (err) { logger.error('[遗蜕秘境]开关写入失败:' + (err && err.stack)); e.reply('❌ 配置保存失败。') }
    return true
  }

  async forceSpawn (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id); const cfg = await getRealmCfg()
    if (!(cfg.enable === 'T' || cfg.enable === true)) { e.reply('请先开启秘境开关。'); return true }
    if (!cfg.group.map(String).includes(gid)) { e.reply('本群未加入秘境白名单。'); return true }
    const info = await withRealmLock(gid, async () => { const st = getRealm(gid); if (st.phase !== 'idle') return null; const r = await spawnRealm(st, gid, cfg); saveRealm(st, gid); return r })
    if (!info) { e.reply('当前已有公开秘境，请结束后再刷新。'); return true }
    await bcastSpawn(gid, info); return true
  }

  async pick (e) {
    if (!e.group_id) return false
    const gid = String(e.group_id); const uid = String(e.user_id)
    if (!(await isCurrent(gid, uid, 'realm'))) {
      /* 转让队长后: 新队长不是秘境锁持有者, 但其队伍在秘境有待处理节点时接管(把秘境锁从旧队长迁到新队长) */
      const cur = await currentInteract(gid, uid)
      if (cur) return false
      const st = realmOfUser(gid, uid)
      const t = st && teamOf(st, uid)
      const party = t && partyInfoOf(gid, uid)
      if (!st || !t || !(t.node || t.ambushNode)) return false
      const resuming = st.nightResumePending && String(t.leader) === uid
      if (!resuming && (!party || String(party.leader) !== uid || String(t.leader) === uid)) return false
      if (!resuming) await unlock(gid, String(t.leader), 'realm').catch(() => {})
      await forceLock(gid, uid, 'realm')
    }
    /* 状态锁复查: 洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态下禁止用数字探索秘境 (skipRealm: 秘境自身数字决策豁免秘境锁) */
    if (await guardActionLocked(e, undefined, { skipRealm: true })) return true
    const out = await withRealmLock(gid, async () => await withFakeLock(gid, async () => {
      const st = realmOfUser(gid, uid)
      if (!st) return null
      const t = teamOf(st, uid)
      if (!t) return null
      /* 出口围剿表态: 菜单优先于探索节点(1参与围剿 / 2悄悄溜走) */
      if (t.ambushNode) {
        const n = Number(String(e.msg || '').replace(/[^\d]/g, ''))
        if (n !== 1 && n !== 2) return null
        t.ambush = n === 1 ? 'fight' : 'flee'
        t.ambushNode = null
        if (st.private) savePrivateRealm(st, gid)
        else saveRealm(st, gid)
        return { r: { valid: true, msgs: [t.ambush === 'fight' ? '已选择留守围剿。' : '已选择突围，等待离场结果。'] }, leader: t.leader }
      }
      if (!t.node) return null
      /* 同步当前队长(#转让队长后把决策权交给新队长, 后续节点/结算都指向他) */
      const party = partyInfoOf(gid, uid)
      const leader = party ? String(party.leader) : String(t.leader)
      if (String(t.leader) !== leader) {
        t.leader = leader
        t.partyLeader = leader
        if (st.private) savePrivateRealm(st, gid)
        else saveRealm(st, gid)
      }
      if (String(t.leader) !== uid) return null
      const n = Number(String(e.msg || '').replace(/[^\d]/g, '')); const cfg = await getRealmCfg(); const node = t.node
      const r = node.type === 'disposal' ? await resolveDisposal(st, gid, t, n, cfg) : await resolveNode(st, gid, t, node, n, cfg)
      if (st.private) savePrivateRealm(st, gid)
      else saveRealm(st, gid)
      return { r, leader: t.leader }
    }))
    if (!out) { await unlock(gid, uid, 'realm').catch(() => {}); return false }
    if (!out.r.valid) {
      await forceLock(gid, uid, 'realm')
      const names = await memberNamesOf(gid)
      e.reply([segment.at(e.user_id), `\n${out.r.msgs.map(line => replaceRealmPlayerIds(line, names)).join('\n')}`])
      return true
    }
    await unlock(gid, uid, 'realm').catch(() => {})
    if (out.r.msgs.length) {
      const names = await memberNamesOf(gid)
      e.reply([segment.at(e.user_id), `\n${out.r.msgs.map(line => replaceRealmPlayerIds(line, names)).join('\n')}`])
    }
    if (out.r.disposalFor) { await forceLock(gid, out.r.disposalFor.leaderUid, 'realm'); notifyAt(gid, out.r.disposalFor.leaderUid, out.r.disposalFor.text) }
    return true
  }
}

/** 散修队成员名单(非散修队/队长时为 [uid]) */
function partyMembers (gid, uid) {
  try {
    const f = getFake(gid)
    for (const t of Object.values(f.rogueTeams || {})) if (String(t.leader) === String(uid)) return (t.members || []).map(String)
  } catch (err) { }
  return [String(uid)]
}

async function bcastSpawn (gid, info) {
  const text = `🌌 ${info.title} 现世\n📍 ${regionNameOf(info.region)} · ${info.diffName}（建议${info.realm}）\n🛡️ 屏障强度 ${info.barrierHp.toLocaleString()}（${info.barrierName}）\n📜 ${info.desc}\n\n前往${regionNameOf(info.region)}：#攻击屏障 参与破界，#进入秘境 入场。
破界后探索${info.exploreMin}分钟。`
  sendToGroup(gid, await formatRealmPush(gid, text))
}

/** 屏障破碎群提示 */
async function bcastBarrierBroke (st, hero) {
  const text = `💥 【${st.title}】屏障已破，探索开始。\n📍 ${regionNameOf(st.region)} · 探索剩余 ${st.exploreMin} 分钟\n${hero ? `🏆 首功：${hero} 完成破界。\n` : ''}#进入秘境 参加探索。`
  sendToGroup(String(st.gid), await formatRealmPush(String(st.gid), text))
}

/** 群内推送文本，渲染成图片（失败回退纯文本） */
async function sendRealmGroupText (gid, text) {
  if (!text || !text.trim()) return
  const safeText = await formatRealmPush(gid, text)
  const img = await textToImg(safeText)
  sendToGroup(gid, img || safeText)
}

/** 夜间 Redis 交互会过期；恢复时重发尚待决策的菜单。 */
async function resumeNightChoices (st, gid) {
  if (!st.nightResumePending) return
  for (const t of Object.values(st.teams || {})) {
    if (t.kind !== 'player' || t.dead || !t.members.length) continue
    syncPlayerTeam(st, gid, t)
    const node = t.ambushNode || t.node
    if (!node) continue
    if (node.type === 'beast' || node.type === 'trial') await refreshRealmNode(st, gid, t, node)
    await forceLock(gid, t.leader, 'realm')
    await notifyAt(gid, t.leader, `🌅 探索已恢复，倒计时已顺延。请继续选择：\n${menuText(node)}`)
  }
  st.nightResumePending = false
  if (st.private) savePrivateRealm(st, gid)
  else saveRealm(st, gid)
}

/** 探索推进(公开与专属共用) */
async function processExplore (st, gid, cfg, now, extra) {
  if (now >= st.endAt) {
    const result = await settleAll(st, gid, cfg)
    const names = await memberNamesOf(gid)
    const text = result.msgs.map(line => replaceRealmPlayerIds(line, names)).join('\n')
    const img = await textToImg(text)
    sendToGroup(gid, img || text)
    return
  }
  /* 出口围剿(仅公开秘境): 探索最后5分钟触发, 不再推进探索节点 */
  if (!st.private) {
    if (!st.ambushAt && now >= st.endAt - AMBUSH_MINUTES * 60000) {
      const pending = await beginAmbush(st, gid, now)
      sendToGroup(gid, `⚔️ ${st.title} 出口围剿开始。\n队长选择留守围剿或突围离场；突围失败将损失30%本场战利品。`)
      for (const p of pending) { await forceLock(gid, p.team.leader, 'realm'); notifyAt(gid, p.team.leader, menuText(p.node)) }
      if (st.private) savePrivateRealm(st, gid)
      else saveRealm(st, gid)
      return
    }
    if (st.ambushAt) {
      const msgs = await processAmbushRound(st, gid, now)
      if (msgs.length) await sendRealmGroupText(gid, msgs.join('\n'))
      if (st.private) savePrivateRealm(st, gid)
      else saveRealm(st, gid)
      return
    }
  }
  for (const t of Object.values(st.teams)) if (t.node && now - (t.lastActionAt || 0) > NODE_TIMEOUT_MIN * 60000) {
    const targetId = t.node.data && t.node.data.target
    if (targetId && st.teams[targetId] && st.teams[targetId].engagedBy === t.id) delete st.teams[targetId].engagedBy
    /* 伪玩家队节点由 driveFakeTeams 即时处理, 不进超时代选 */
    if (t.kind !== 'player') { t.lastActionAt = now; continue }
    /* 玩家队超时未回复: 系统代选保守决策并@队长播报, 不丢指令、不挂起 */
    syncPlayerTeam(st, gid, t)
    const idx = autoPickForPlayer(t.node)
    const r = t.node.type === 'disposal' ? await resolveDisposal(st, gid, t, idx, cfg) : await resolveNode(st, gid, t, t.node, idx, cfg)
    if (r.msgs.length) notifyAt(gid, t.leader, `⏳ 选择超时，已自动处理：\n${r.msgs.join('\n')}`)
  }
  advanceFakeArrivals(st, gid, now)
  const fakeResult = await driveFakeTeams(st, gid, cfg)
  if (fakeResult.msgs.length) await sendRealmGroupText(gid, fakeResult.msgs.join('\n'))
  for (const p of fakeResult.pushes) { await forceLock(gid, p.leaderUid, 'realm'); notifyAt(gid, p.leaderUid, p.text) }
  const pending = await advanceTeams(st, gid, cfg)
  for (const p of pending) { await forceLock(gid, p.team.leader, 'realm'); notifyAt(gid, p.team.leader, menuText(p.node)) }
  const ev = rollEvent(st, cfg)
  if (ev) { const applied = await applyEvent(st, gid, ev); sendToGroup(gid, `⚠️ ${ev.text}`); if (applied.msgs.length) await sendRealmGroupText(gid, applied.msgs.join('\n')); for (const p of applied.pushes) { await forceLock(gid, p.team.leader, 'realm'); notifyAt(gid, p.team.leader, menuText(p.node)) } }
  if (st.private) savePrivateRealm(st, gid)
  else saveRealm(st, gid)
}

async function realmTick () {
  const cfg = await getRealmCfg(); const enabled = cfg.enable === 'T' || cfg.enable === true; const configuredGroups = (cfg.group || []).map(String); const now = Date.now()
  /* 公开秘境: 白名单群 + 已有存档群 */
  const publicGroups = [...new Set([...configuredGroups, ...activeRealmGroups()])]
  for (const gid of publicGroups) {
    try {
      await withRealmLock(gid, async () => await withFakeLock(gid, async () => {
        const st = getRealm(gid)
        if (st.phase !== 'idle' && isNight(new Date(now))) { saveRealm(st, gid); return }
        await resumeNightChoices(st, gid)
        reconcileFakeBusy(gid, st)
        if (st.phase === 'idle') {
          if (!enabled || !configuredGroups.includes(gid) || (isNight() && cfg.night_stop !== 'F') || now < st.nextSpawn) return
          const info = await spawnRealm(st, gid, cfg); saveRealm(st, gid); await bcastSpawn(gid, info); return
        }
        if (st.phase === 'barrier') {
          let broke = false
          for (const t of Object.values(st.teams)) if (t.kind === 'fake' && fakeAttackBarrier(st, t, gid, now)) broke = true
          if (!broke && st.barrier?.auto) {
            for (const uid of Object.keys(st.barrier.auto)) {
              if (!isInRegion(gid, uid, st.region)) continue
              const rec = st.barrier.auto[uid]
              if (now - (rec.lastHit || 0) < 20000) continue
              const hit = await attackBarrier(st, uid, gid, true)
              if (hit.broke) { broke = true; break }
            }
          }
          if (broke) { const broken = await breakBarrier(st, gid); await bcastBarrierBroke(st, broken.hero) }
          else saveRealm(st, gid)
          return
        }
        if (st.phase === 'explore') await processExplore(st, gid, cfg, now)
      }))
    } catch (err) { logger.error('[遗蜕秘境]公开单群推进异常:' + (err && err.stack)) }
  }
  /* 专属秘境: 无刷新/无破界, 只推进探索与结算 */
  for (const ref of activePrivateRealms()) {
    try {
      await withRealmLock(ref.gid, async () => await withFakeLock(ref.gid, async () => {
        const st = getPrivateRealm(ref.gid, ref.id)
        if (!st || st.phase !== 'explore') return
        if (isNight(new Date(now))) { savePrivateRealm(st, ref.gid); return }
        await resumeNightChoices(st, ref.gid)
        reconcileFakeBusy(ref.gid, st)
        await processExplore(st, ref.gid, cfg, now)
      }))
    } catch (err) { logger.error(`[遗蜕秘境]专属秘境${ref.gid}/${ref.id}推进异常:` + (err && err.stack)) }
  }
}
