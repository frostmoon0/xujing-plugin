import { hasBloodFeud, temperCaptiveWeights } from './survival.js'
import { canAdmitSectNpc, admitSectNpc, sectOccupancy } from './capacity.js'
import { addWarKarma } from './war_journal.js'
import { defenderOf, warReceipt } from './war_state.js'
import { extractWarLoot, depositWarLoot } from './war_loot.js'
import { withImmediateSaveContext } from '../deferred_save.js'
/* 由 sect_system.js 拆分自动生成: captive.js */
import { getFake, saveFake, sectName, sectAlive, sectCap, removeFromSectMap, killPerson, logEvent, getNick } from '../fake_data.js'
import { addItem, addItemToBag, getBag, saveBag, isBound, MATERIAL_TPL, ITEM_TPL, EQUIP_TPL, itemIcon } from '../equip_data.js'
import xujing_data from '../xujing_data.js'
import { playerMoney, applyInjury, rand, clamp, atkLog, getVault, ensureCapSub, CFG, posCnOf, playerPower } from './utils.js'
import { addMineEvent } from './economy.js'
import { winnerOfCoalition, coalitionShares } from './diplomacy.js'
import { Wanhun } from '../wanhun_data.js'

function removeCaptivesFromPools (atk, fakes = [], players = []) {
  const c = atk.captives || {}
  const fakeSet = new Set(fakes.map(String))
  const playerSet = new Set(players.map(String))
  c.fakes = (c.fakes || []).filter(n => !fakeSet.has(String(n)))
  c.players = (c.players || []).filter(uid => !playerSet.has(String(uid)))
  for (const side of [c.byAtk, c.byDef, ...Object.values(c.byShare || {})]) {
    if (!side) continue
    side.fakes = (side.fakes || []).filter(n => !fakeSet.has(String(n)))
    side.players = (side.players || []).filter(uid => !playerSet.has(String(uid)))
  }
  c.recruitRefused = (c.recruitRefused || []).filter(n => !fakeSet.has(String(n)))
}

/** 俘虏物品摘要: 每个具体物品都带品质/物品图标 */
function lootItemsText (items) {
  return Object.entries(items || {}).map(([name, count]) => `${itemIcon(name)}${name}×${count}`).join('、')
}

/** 胜方宗门"气质画像": 由宗主/太上/副宗及门人性格+正邪汇总 残暴/仁慈/贪婪 三轴(0~1), 驱动战俘处置; 散修胜则随机浮动 */
export function victorDisposition (f, winSect) {
  if (!winSect || !f.sects[winSect]) {
    /* 散修/无宗胜方: 无性格数据, 用随机浮动模拟每场不同气质 */
    return {
      cruelty: clamp(0.15 + Math.random() * 0.35, 0, 1),
      mercy: clamp(0.1 + Math.random() * 0.35, 0, 1),
      greed: clamp(0.15 + Math.random() * 0.3, 0.05, 1),
      evil: Math.random() < 0.3, core: []
    }
  }
  const sm = f.sectMap[winSect] || {}
  const names = [sm.zongzhu, ...(sm.fuzong || []), ...(sm.taishang || [])].filter(Boolean)
  const ps = names.map(n => f.roster[n]).filter(Boolean)
  const all = ps.length ? ps : sectAlive(f, winSect)
  if (!all.length) return { cruelty: 0.2, mercy: 0.15, greed: 0.2, evil: false, core: [] }
  let cruelty = 0.1, mercy = 0.1, greed = 0.15, evil = false
  for (const p of all) {
    const t = p.trait || ''
    if (t === '嗜杀') { cruelty += 0.25; mercy -= 0.1; greed += 0.1 }
    else if (t === '好斗') { cruelty += 0.12; mercy -= 0.05 }
    else if (t === '善良') { mercy += 0.3; cruelty -= 0.15; greed -= 0.1 }
    else if (t === '平和') { mercy += 0.12; cruelty -= 0.06; greed -= 0.05 }
    if (p.path === '魔道') { cruelty += 0.12; greed += 0.08; evil = true }
    if (p.act === '贪玩') { mercy += 0.06; cruelty -= 0.03 }
  }
  return { cruelty: clamp(cruelty, 0, 1), mercy: clamp(mercy, 0, 1), greed: clamp(greed, 0.05, 1), evil, core: all }
}

/** 自动处置玩家战俘(胜方无玩家宗主/散修): 随机组合 放/搜刮再放/关天牢(胜方有宗)/重伤惩戒
 *  只处置胜方抓的战俘(败方人); 胜方自己人被对方擒的(byDef/byAtk 另一侧)不处置——那是待解救的自己人
 *  shareList: 联盟按输出分给某宗门的玩家份额(传则只处置该份额并同步清理) */
export async function autoDisposePlayerCaptives (f, gid, atk, winSect, now, shareList = null) {
  const jailedUids = new Set() // 关天牢的玩家: 保留被俘标记(锁定)
  /* 新格式按抓人方精确处置; 旧格式(无子池, 重启前在途战争)回退处置总池, 避免卡俘虏 */
  const hasSub = !!(atk.captives && atk.captives.byAtk)
  ensureCapSub(atk)
  const list = shareList
    ? [...shareList]
    : (hasSub ? [...(atk.result === 'win' ? atk.captives.byAtk.players : atk.captives.byDef.players)] : [...((atk.captives && atk.captives.players) || [])])
  if (!list.length) return
  const defSect = atk.result === 'lose' ? atk.atkSect : (defenderOf(f, atk))
  const sname = winSect && f.sects[winSect] ? sectName(f, winSect) : (atk.rogueName || '散修')
  const jails = (winSect && f.sects[winSect]) ? ((f.sectJails = f.sectJails || {}), (f.sectJails[winSect] = f.sectJails[winSect] || [])) : null
  let disposed = 0
  for (const uid of list) {
    const pp = f.players && f.players[uid]
    /* 无宗门玩家(散修)不在 f.players, 同样处置(搜刮/天牢只依赖玩家真实档案), 名字取群昵称 */
    const pname = (pp && pp.name) || await getNick(gid, uid)
    atk.autoPlayerDisposals ||= {}
    const decision = atk.autoPlayerDisposals[`${winSect}:${uid}`] ||= { roll: Math.random(), injury: rand([1, 2]), done: false }
    if (decision.done) { if (decision.jailed) jailedUids.add(String(uid)); continue }
    captiveCheckpoint(f, gid)
    const roll = decision.roll
    if (roll < 0.3) {
      atkLog(atk, `【释放】${pname} 被释放`, now)
      logEvent(f, 'captive', `【释放】玩家 ${pname} 战败被俘后被释放`, now, { who: [pname], sect: defSect })
    } else if (roll < 0.65) {
      const t = await lootPlayerCaptive(f, gid, uid, winSect, 0.3, { receipt: `${warReceipt(atk)}:auto:${winSect}:${uid}:loot` })
      const n = Object.values(t.items).reduce((a, b) => a + b, 0)
      applyInjury(f, uid, decision.injury, now, gid, `${warReceipt(atk)}:auto:injury:${uid}`)
      atkLog(atk, `【搜刮释放】${pname} 被搜刮${n}件物品${t.stones ? `、${t.stones}灵石` : ''}后释放`, now)
      logEvent(f, 'captive', `【搜刮释放】玩家 ${pname} 被搜刮${n}件物品${t.stones ? `、${t.stones}灵石` : ''}后释放`, now, { who: [pname], sect: defSect })
    } else if (roll < 0.75 && jails) {
      /* 无限期关押前扒除全部非绑定财物入胜方宗门宝库 */
      await lootPlayerCaptive(f, gid, uid, winSect, 1, { toVault: true, receipt: `${warReceipt(atk)}:auto:${winSect}:${uid}:confine` })
      if (!jails.some(x => String(x.uid) === String(uid))) jails.push({ uid: String(uid), name: pname, at: now, atkId: atk.id })
      decision.jailed = true
      jailedUids.add(String(uid))
      await markPlayerCaptive(gid, uid, `${sname}·天牢`, 3600)
      applyInjury(f, uid, decision.injury, now, gid, `${warReceipt(atk)}:auto:injury:${uid}`)
      atkLog(atk, `【收押】${pname} 被关入【${sname}】天牢`, now)
      logEvent(f, 'captive', `【收押】玩家 ${pname} 被关入【${sname}】天牢（无限期，可越狱）`, now, { who: [pname], sect: defSect })
    } else {
      applyInjury(f, uid, 3, now, gid, `${warReceipt(atk)}:auto:injury:${uid}`)
      atkLog(atk, `【惩戒】${pname} 被重伤惩戒`, now)
      logEvent(f, 'captive', `【惩戒】玩家 ${pname} 战败被俘后被重伤惩戒`, now, { who: [pname], sect: defSect })
    }
    decision.done = true
    removeCaptivesFromPools(atk, [], [uid])
    captiveCheckpoint(f, gid)
    disposed++
  }
  /* 记录自动处置摘要(供播报文案使用; 已处置的从总池移除后仍能提示; 按实际处置数) */
  if (disposed > 0) atk.disposedNote = `${disposed} 名被俘玩家已由对方处置`
  /* 处置完成 → 解除被俘状态(禁动作解除; 关天牢的保留标记锁定) + 从俘虏池移除(总池保留胜方被擒的自己人待解救) */
  for (const uid of list) { if (jailedUids.has(String(uid))) continue; try { await unmarkPlayerCaptive(gid, uid) } catch (err) { } }
  removeCaptivesFromPools(atk, [], list)
}

/** 伪玩家战俘自动处置: 依胜方气质(残暴/仁慈/贪婪) × 与被俘者关系(羁绊/仇怨) × 俘虏自身性格 逐人动态判定
 *  处置: 放走 / 搜刮再放 / 收编入宗(胜方有宗且未满员) / 搜刮再杀 / 处决 / 关天牢(胜方有宗) / 送矿山(胜方有宗); 权重全由性格与关系推导, 非固定概率表
 *  只处置胜方抓的战俘(败方人); 胜方自己人被对方擒的不处置(待解救)
 *  shareList: 联盟按输出分给某宗门的伪玩家份额(传则只处置该份额并同步清理) */
export async function disposeFakeCaptives (f, gid, atk, winSect, now = Date.now(), shareList = null) {
  /* 新格式按抓人方精确处置; 旧格式(无子池)回退处置总池 */
  const hasSub = !!(atk.captives && atk.captives.byAtk)
  ensureCapSub(atk)
  const list = shareList
    ? [...shareList]
    : (hasSub ? [...(atk.result === 'win' ? atk.captives.byAtk.fakes : atk.captives.byDef.fakes)] : [...((atk.captives && atk.captives.fakes) || [])])
  if (!list.length) return
  const disp = victorDisposition(f, winSect)
  const sname = winSect && f.sects[winSect] ? sectName(f, winSect) : (atk.rogueName || '散修')
  const defSect = defenderOf(f, atk)
  const coreNames = disp.core.map(x => x.name)
  const canJail = !!winSect && !!f.sects[winSect] // 有宗门胜方才能关天牢/送矿山
  for (const n of [...list]) {
    const p = f.roster[n]
    if (!p || !p.alive) { removeCaptivesFromPools(atk, [n], []); continue }
    const canRecruit = !!winSect && canAdmitSectNpc(f, winSect, n)
    const r = p.relations || {}
    /* 羁绊: 胜方核心成员里有其 道侣/师父/徒弟/知己/挚友/手足/亲族 */
    const bonded = coreNames.some(cn => cn === r.master || cn === r.spouse ||
      (r.confidants || []).includes(cn) || (r.friends || []).includes(cn) ||
      (r.siblings || []).includes(cn) || (r.kin || []).includes(cn) ||
      (r.disciples || []).includes(cn))
    /* 仇怨: 与胜方核心成员互为仇人 */
    const hated = coreNames.some(cn => (r.enemies || []).includes(cn)) ||
      coreNames.some(cn => { const c = f.roster[cn]; return c && c.relations && (c.relations.enemies || []).includes(n) })
    /* 俘虏自身: 嗜杀/好斗危险(胜方忌惮), 善良/平和温和(胜方心软) */
    const danger = p.trait === '嗜杀' ? 0.25 : (p.trait === '好斗' ? 0.12 : 0)
    const mild = p.trait === '善良' ? 0.18 : (p.trait === '平和' ? 0.1 : 0)
    /* 各处置倾向(动态加权): 有羁绊大放走, 有仇大处决, 残暴多杀/多关押, 仁慈多放, 贪婪多搜刮/多送矿 */
    let w = {
      free: clamp(0.15 + disp.mercy + (bonded ? 0.6 : 0) + mild - disp.cruelty * 0.5 - (hated ? 0.15 : 0), 0.01, 0.95),
      robFree: clamp(0.15 + disp.greed * 0.6 + disp.mercy * 0.3 - disp.cruelty * 0.3 - (hated ? 0.1 : 0), 0.01, 0.9),
      recruit: canRecruit ? clamp(0.06 + disp.mercy * 0.25 + (bonded ? 0.55 : 0) + mild - (hated ? 0.3 : 0), 0.01, 0.8) : 0,
      robKill: clamp(0.08 + disp.greed * 0.5 + disp.cruelty * 0.55 + (hated ? 0.35 : 0) + danger - disp.mercy - (bonded ? 0.5 : 0), 0.01, 0.9),
      kill: clamp(0.04 + disp.cruelty * 0.5 + danger + (hated ? 0.3 : 0) - disp.mercy - (bonded ? 0.5 : 0) - mild * 0.5, 0.01, 0.85),
      /* 关天牢: 残暴/有仇/危险俘虏倾向关押威慑; 仁慈/羁绊少关押 */
      jail: canJail ? clamp(0.05 + disp.cruelty * 0.4 + (hated ? 0.2 : 0) + danger * 0.4 - disp.mercy * 0.3 - (bonded ? 0.3 : 0), 0.01, 0.7) : 0,
      /* 送矿山: 贪婪/残暴/危险俘虏倾向押去挖矿(安全奴役); 仁慈/羁绊少送 */
      mine: canJail ? clamp(0.05 + disp.greed * 0.5 + disp.cruelty * 0.2 + danger * 0.5 - disp.mercy * 0.4 - (bonded ? 0.4 : 0), 0.01, 0.7) : 0
    }
    w = temperCaptiveWeights(w, { bloodFeud: disp.core.some(c => hasBloodFeud(c, p) || hasBloodFeud(p, c)), cruelty: disp.cruelty })
    const total = w.free + w.robFree + w.recruit + w.robKill + w.kill + w.jail + w.mine
    let rr = Math.random() * total
    let act = 'free'
    for (const k of ['free', 'robFree', 'recruit', 'robKill', 'kill', 'jail', 'mine']) { rr -= w[k]; if (rr <= 0) { act = k; break } }
    if (act === 'free') {
      logEvent(f, 'captive', `【释放】${sname} 释放战俘 ${n}`, now, { who: [n], sect: defSect })
      atkLog(atk, `【释放】${n} 被释放`, now)
    } else if (act === 'robFree') {
      lootFakeCaptive(f, gid, p, winSect)
      logEvent(f, 'captive', `【搜刮释放】${sname} 搜刮战俘 ${n} 后释放`, now, { who: [n], sect: defSect })
      atkLog(atk, `【搜刮】${n} 被搜刮后释放`, now)
    } else if (act === 'recruit') {
      /* 已有玩家主人的仆从不能被宗门战俘收编成弟子，避免仆从+宗门双重身份 */
      if (p.servantOf) {
        logEvent(f, 'captive', `【释放】${sname} 发现战俘 ${n} 已有主人，未予收编`, now, { who: [n], sect: defSect })
        atkLog(atk, `【收编跳过】${n} 已是玩家仆从，保持原归属`, now)
        continue
      }
      /* 收编: 叛离原宗拜入胜方, 忠诚重头再来 */
      const oldSect = p.sect
      if (oldSect) removeFromSectMap(f, oldSect, n)
      if (!admitSectNpc(f, p, winSect)) { logEvent(f, 'captive', `【释放】${sname} 门人已满，释放 ${n}`, now, { who: [n] }); removeCaptivesFromPools(atk, [n], []); continue }
      // 收编任职不改变NPC实际修为。
      p.joinAt = now
      if (f.sectMap[winSect]) { if (!f.sectMap[winSect].dizi) f.sectMap[winSect].dizi = []; if (!f.sectMap[winSect].dizi.includes(n)) f.sectMap[winSect].dizi.push(n) }
      p.loyalty = Math.floor((Number(p.loyalty) || 60) * 0.35)
      logEvent(f, 'join', `【收编】${sname} 收编战俘 ${n} 弃暗投明，拜入宗门`, now, { who: [n], sect: winSect })
      atkLog(atk, `【收编】${n} 归顺${sname}，拜入宗门`, now)
    } else if (act === 'robKill') {
      lootFakeCaptive(f, gid, p, winSect)
      killPerson(f, p, `【处决】${sname} 搜刮后处决战俘 ${n}`, now)
      logEvent(f, 'captive', `【处决】${sname} 搜刮战俘 ${n} 后将其处决`, now, { who: [n], sect: defSect })
      atkLog(atk, `【搜刮处决】${n} 被搜刮后处决`, now)
    } else if (act === 'jail') {
      /* 关入天牢前扒除全部非绑定财物，统一入胜方宗门宝库 */
      lootFakeCaptive(f, gid, p, winSect)
      /* 关进胜方宗门天牢(无限期, 可越狱) */
      f.sectJails = f.sectJails || {}
      f.sectJails[winSect] = f.sectJails[winSect] || []
      f.sectJails[winSect].push({ name: n, at: now })
      logEvent(f, 'captive', `【收押】${sname} 将战俘 ${n} 关入宗门天牢（无限期，可越狱）`, now, { who: [n], sect: defSect })
      atkLog(atk, `【收押】${n} 被关入${sname}天牢`, now)
    } else if (act === 'mine') {
      /* 押送矿山前扒除全部非绑定财物，统一入胜方宗门宝库 */
      lootFakeCaptive(f, gid, p, winSect)
      /* 押送矿山挖矿：脱离原宗门并进入独立矿工状态，产出入胜方宗门宝库 */
      if (p.sect) removeFromSectMap(f, p.sect, n)
      p.mineOf = winSect
      p.mineSince = now
      p.servantOf = null
      p.servantSince = 0
      p.sect = null
      p.pos = null
      p.status = 'mine'
      f.sectMines = f.sectMines || {}
      f.sectMines[winSect] = f.sectMines[winSect] || []
      if (!f.sectMines[winSect].some(x => x.name === n)) f.sectMines[winSect].push({ name: n, at: now, outStones: 0, outMats: {}, colorHit: 0 })
      logEvent(f, 'captive', `【送矿】${sname} 将战俘 ${n} 押送矿山挖矿`, now, { who: [n], sect: defSect })
      atkLog(atk, `【送矿】${n} 被押送矿山挖矿`, now)
    } else {
      killPerson(f, p, `【处决】${sname} 处决战俘 ${n}`, now)
      logEvent(f, 'captive', `【处决】${sname} 处决战俘 ${n}`, now, { who: [n], sect: defSect })
      atkLog(atk, `【处决】${n} 被处决`, now)
    }
  }
  removeCaptivesFromPools(atk, list, [])
}


/* ---------- 玩家被俘状态(redis): 被俘期间禁动作, 处置/4小时后自动解除兜底 ---------- */
export const captiveKey = (gid, uid) => `xujing:captive:${String(gid)}:${String(uid)}`

/* 营救中(#拯救): 施救者 redis 标记, 30分钟; 到期由 settleSectJails 释放被救者 */
export const rescueKey = (gid, uid) => `xujing:rescuing:${String(gid)}:${String(uid)}`

export const RESCUE_MS = 30 * 60000

/** 记录玩家被俘(胜方宗门名; 默认4小时自动解除兜底; 天牢场景传更长EX, 由 settleSectJails 每分钟刷新保持锁定) */
export async function markPlayerCaptive (gid, uid, sname, exSec = 4 * 3600) {
  try { await redis.set(captiveKey(gid, uid), String(sname || '敌人'), { EX: exSec }) } catch (err) { }
}

/** 解除玩家被俘(处置完成时调用) */
export async function unmarkPlayerCaptive (gid, uid) {
  try { await redis.del(captiveKey(gid, uid)) } catch (err) { }
}

/** 查询玩家被俘(api.js 拦截用): 返回胜方宗门名或 null */
export async function captiveOf (gid, uid) {
  // 持久化俘虏池/天牢为事实来源；Redis 丢失或过期不能获得自由。
  const f = getFake(gid); const id = String(uid)
  for (const [sid, arr] of Object.entries(f.sectJails || {})) if (arr.some(x => String(x.uid) === id)) return `${sectName(f, sid)}·天牢`
  for (const war of f.sectAttacks || []) {
    const c = war.captives || {}
    if ([c, c.byAtk, c.byDef, ...Object.values(c.byShare || {})].some(pool => (pool?.players || []).some(x => String(x) === id))) return '战场俘虏'
  }
  // 没有事实记录的残留缓存不能把已获释者重新锁住。
  try { if (await redis.get(captiveKey(gid, uid))) await unmarkPlayerCaptive(gid, uid) } catch (err) { }
  return null
}

/** 关押宗门灭门后，其关押的各宗俘虏全部获释；其他盟友的份额不受影响。 */
export async function liberateDestroyedCaptor (f, gid, sid, now = Date.now()) {
  for (const other of f.sectAttacks || []) {
    const c = other.captives
    if (!c) continue
    const held = { fakes: new Set(c.byShare?.[sid]?.fakes || []), players: new Set((c.byShare?.[sid]?.players || []).map(String)) }
    const ownSide = other.atkSect === sid ? c.byAtk : defenderOf(f, other) === sid ? c.byDef : null
    const legacy = !c.byAtk && !c.byDef && ((other.result === 'win' && other.atkSect === sid) || (other.result === 'lose' && defenderOf(f, other) === sid))
    const pool = ownSide || (legacy ? c : null)
    if (pool) {
      const reservedF = new Set(); const reservedP = new Set()
      if (other.atkSect === sid) for (const [owner, share] of Object.entries(c.byShare || {})) {
        if (owner === sid) continue
        for (const name of share.fakes || []) reservedF.add(name)
        for (const uid of share.players || []) reservedP.add(String(uid))
      }
      for (const name of pool.fakes || []) if (!reservedF.has(name)) held.fakes.add(name)
      for (const uid of pool.players || []) if (!reservedP.has(String(uid))) held.players.add(String(uid))
    }
    if (!held.fakes.size && !held.players.size) continue
    removeCaptivesFromPools(other, [...held.fakes], [...held.players])
    for (const uid of held.players) await unmarkPlayerCaptive(gid, uid)
    atkLog(other, `【获释】关押宗门覆灭，${held.fakes.size} 名门人和 ${held.players.size} 名玩家重获自由`, now)
  }
}


/** 玩家被擒瞬间: 立即标记被俘(redis 禁动作) + @通知本人; 处置仍等战争结算
 *  by: 'def'=被守方擒(攻方人, 攻方胜时属自己人待解救) / 'atk'=被攻方擒(守方人, 攻方胜时属战俘待处置) */
export async function capturePlayerNow (f, gid, atk, uid, now, sname, by = 'atk') {
  ensureCapSub(atk)
  if (!atk.captives.players.includes(uid)) atk.captives.players.push(uid)
  if (!(atk.capturedUids || []).includes(uid)) (atk.capturedUids = atk.capturedUids || []).push(uid)
  const sub = by === 'def' ? atk.captives.byDef : atk.captives.byAtk
  if (!sub.players.includes(uid)) sub.players.push(uid)
  await markPlayerCaptive(gid, uid, sname || '敌军')
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.sendMsg) g.sendMsg([segment.at(Number(uid)), `\n⛓️ 你已被【${sname || '敌军'}】俘虏，无法行动！等待战争结束处置（#战争详情 可查看战况）`])
  } catch (err) { }
}

/** 大胜凯旋 → 解救被俘成员 (骑砍2式: 俘虏跟着抓他的人走, 只有打败关押方才能救回)
 *  - winSects: 本场胜方阵营的全部宗门(联盟胜利时包含发起方与所有参战盟友), 不只贡献最高者
 *  - 本场(other.id===atkId): 被擒的本宗人是被本场守方(败方 defSect)擒的 → 打赢即获救
 *  - 他场: 抓人方 = 该场 winSects 的对手; 仅当抓人方===本场败方 defSect 才救(你打败了抓你人的宗门, 他扣押的俘虏全部释放)
 *  - 抓人方≠defSect(打不相干的仗) 或 未结算(abort/进行中无对手) → 不救, 需另寻仗打/处置 */
export async function rescueCaptivesOf (f, gid, winSects, now = Date.now(), defSect = null, atkId = null) {
  const winnerIds = new Set((Array.isArray(winSects) ? winSects : [winSects]).filter(Boolean).map(String))
  if (!winnerIds.size) return
  const displayId = [...winnerIds].find(id => f.sects && f.sects[id]) || [...winnerIds][0]
  const winName = sectName(f, displayId)
  for (const other of (f.sectAttacks || [])) {
    /* 判定该场"抓人方" = 该场胜方阵营的对手; 胜利方永远不可能俘虏胜利方的人 */
    let captor = null
    const otherTarget = defenderOf(f, other)
    if (String(other.id) === String(atkId)) {
      captor = defSect
    } else if (other.atkSect && winnerIds.has(String(other.atkSect))) {
      captor = otherTarget
    } else if (otherTarget && winnerIds.has(String(otherTarget))) {
      captor = other.atkSect
    }
    if (!captor || String(captor) !== String(defSect)) continue
    ensureCapSub(other)
    /* 本场结算时按实际阵营子池直接释放：
       win 的 byDef 是攻方(含联盟成员)被守方抓到的人，lose 的 byAtk 是守方被攻方抓到的人。
       不能再依赖 p.sect===winSect——小区易主/灭门或联盟胜方变更后，个人宗门字段可能已变化，
       正是这类记录此前无法被清理、最终变成孤儿俘虏的原因。 */
    const currentBattle = String(other.id) === String(atkId)
    const rescueSide = currentBattle
      ? (other.result === 'win' ? other.captives.byDef : other.captives.byAtk)
      : null
    const cf = rescueSide ? (rescueSide.fakes || []) : ((other.captives && other.captives.fakes) || [])
    const cp = rescueSide ? (rescueSide.players || []) : ((other.captives && other.captives.players) || [])
    if (!cf.length && !cp.length) continue
    let ch = false
    for (const n of [...cf]) {
      const p = f.roster[n]
      const rescued = currentBattle || (p && p.alive && winnerIds.has(String(p.sect)))
      if (rescued) {
        removeCaptivesFromPools(other, [n], [])
        if (p && p.alive) logEvent(f, 'captive', `【解救】${winName} 大胜凯旋，营救被俘弟子 ${n} 归宗`, now, { who: [n], sect: p.sect })
        ch = true
      }
    }
    for (const uid of [...cp]) {
      const pp = f.players && f.players[uid]
      const rescued = currentBattle || (pp && winnerIds.has(String(pp.sect)))
      if (rescued) {
        removeCaptivesFromPools(other, [], [uid])
        if (pp) {
          try { await unmarkPlayerCaptive(gid, uid) } catch (err) { }
          logEvent(f, 'captive', `【解救】${winName} 大胜凯旋，营救被俘玩家 ${pp.name} 归来`, now, { who: [pp.name], sect: pp.sect })
          try {
            const g = Bot.pickGroup(gid)
            if (g && g.sendMsg) g.sendMsg([segment.at(Number(uid)), `\n🎉 你的宗门【${winName}】大胜凯旋，已将你从敌军手中解救！`])
          } catch (err) { }
        }
        ch = true
      }
    }
    if (ch) { try { saveFake(f, gid) } catch (err) { } }
  }
}

/** 修复历史结算记录中的孤儿俘虏:
 *  - win 的 byDef 是攻方(含联盟盟友)被守方抓到的胜方成员, 战后应立即获释
 *  - lose 的 byAtk 是守方被攻方抓到的胜方成员, 战后应立即获释
 *  旧版本因联盟胜方/小区归属变化可能漏掉这些记录; 每次 sectTick 兜底清理, 不重复播报。 */
export async function repairSettledCaptives (f, gid) {
  let changed = false
  for (const atk of (f.sectAttacks || [])) {
    if (!atk || atk.phase !== 'done' || (atk.result !== 'win' && atk.result !== 'lose')) continue
    /* 旧版无 byAtk/byDef 子池时, 总池语义仍是待处置敌方俘虏，不能把它误当成胜方被擒者清掉。 */
    const c = atk.captives
    if (!c || !c.byAtk || !c.byDef) continue
    const side = atk.result === 'win' ? c.byDef : c.byAtk
    const fakes = [...(side.fakes || [])]
    const players = [...(side.players || [])]
    if (!fakes.length && !players.length) continue
    removeCaptivesFromPools(atk, fakes, players)
    for (const uid of players) {
      try { await unmarkPlayerCaptive(gid, uid) } catch (err) { }
    }
    changed = true
  }
  return changed
}

/* ============ 宗门天牢(战俘收押) ============ */
/** 查看宗门天牢名单 */
export function sectJailList (f, sectId) {
  return ((f.sectJails || {})[sectId]) || []
}

/** 从天牢释放某人(按名字或uid; 玩家同时解除被俘标记) */
export async function releaseSectJail (f, gid, sectId, name) {
  const arr = sectJailList(f, sectId)
  const i = arr.findIndex(x => x.name === name || String(x.uid) === String(name))
  if (i < 0) return { ok: false, msg: '宗门天牢里没有这个人' }
  const x = arr[i]
  arr.splice(i, 1)
  if (!arr.length) delete f.sectJails[sectId]
  if (x.uid) { try { await unmarkPlayerCaptive(gid, x.uid) } catch (err) { } }
  saveFake(f, gid)
  return { ok: true, msg: '✅ 已将其释放出天牢' }
}

/** 越狱成功率: 关押越久越容易, 满24小时(86400000ms)百分百成功 */
export function escapeRateOf (at, now = Date.now()) {
  return Math.min(1, Math.max(0, (now - (at || now)) / 86400000))
}

/** 天牢无限期关押(每分钟, sectTick 调用):
 *  - 玩家: 由 #越狱 指令触发越狱, 这里仅持续刷新其被俘标记(保持锁定)
 *  - 伪玩家: 30分钟冷却自动尝试越狱, 成功率=escapeRateOf(满24小时必成)
 *  - 天牢里已死/消失的伪玩家直接清出 */
export async function settleSectJails (f, gid, now) {
  let changed = false
  /* 营救到期(#拯救): 30分钟到点自动释放被救者出狱并清理施救者标记 */
  try {
    const keys = await redis.keys(rescueKey(gid, '*'))
    for (const k of keys || []) {
      let o = null
      try { o = JSON.parse(await redis.get(k) || 'null') } catch (err) { }
      if (!o || !o.t || !o.until || now < o.until) continue
      const arr = (f.sectJails || {})[o.sid]
      if (arr) {
        const i = arr.findIndex(x => String(x.uid) === String(o.t))
        if (i >= 0) {
          const x = arr[i]
          arr.splice(i, 1)
          if (!arr.length) delete f.sectJails[o.sid]
          try { await unmarkPlayerCaptive(gid, o.t) } catch (err) { }
          logEvent(f, 'captive', `【获救】${x.name} 被同伴救出【${o.s || '天牢'}】，重获自由`, now, { who: [x.name] })
          changed = true
        }
      }
      try { await redis.del(k) } catch (err) { }
    }
  } catch (err) { }
  for (const sid of Object.keys(f.sectJails || {})) {
    const arr = f.sectJails[sid]
    if (!arr || !arr.length) { delete f.sectJails[sid]; changed = true; continue }
    const sname = sectName(f, sid)
    const remain = []
    for (const x of arr) {
      /* 玩家: 刷新被俘标记(EX 1小时, 每分钟刷), 越狱由玩家 #越狱 触发 */
      if (x.uid) {
        try { await markPlayerCaptive(gid, x.uid, `${sname}·天牢`, 3600) } catch (err) { }
        remain.push(x)
        continue
      }
      /* 伪玩家: 30分钟冷却尝试越狱 */
      const p = f.roster[x.name]
      if (!p || !p.alive) { changed = true; continue } // 已死/消失 → 清出天牢
      if (now < (x.lastEscapeAt || 0)) { remain.push(x); continue }
      const rate = escapeRateOf(x.at, now)
      if (Math.random() < rate) {
        logEvent(f, 'captive', `【越狱】${sname} 天牢中的 ${x.name} 成功越狱，重获自由（共关押约 ${Math.max(1, Math.round((now - x.at) / 60000))} 分钟）`, now, { who: [x.name], sect: sid })
        changed = true
      } else {
        x.lastEscapeAt = now + 30 * 60000
        logEvent(f, 'captive', `【越狱失败】${sname} 天牢中的 ${x.name} 尝试越狱被守卫发现，押回牢房`, now, { who: [x.name], sect: sid })
        remain.push(x)
      }
    }
    if (remain.length) f.sectJails[sid] = remain
    else delete f.sectJails[sid]
  }
  if (changed) { try { saveFake(f, gid) } catch (err) { } }
}

/** 玩家 #越狱: 30分钟冷却; 成功率=关押时长/24h(满24小时100%); 成功即解除被俘标记 */
export async function playerEscape (f, gid, uid, now = Date.now()) {
  const suid = String(uid)
  for (const sid of Object.keys(f.sectJails || {})) {
    const arr = f.sectJails[sid] || []
    const i = arr.findIndex(x => String(x.uid) === suid)
    if (i < 0) continue
    const x = arr[i]
    const sname = sectName(f, sid)
    if (now < (x.lastEscapeAt || 0)) {
      const cdMin = Math.ceil((x.lastEscapeAt - now) / 60000)
      return { ok: false, msg: `⛓️ 越狱失败后需等待 ${cdMin} 分钟才能再次尝试（关押越久成功率越高，满24小时必成）` }
    }
    const rate = escapeRateOf(x.at, now)
    if (Math.random() < rate) {
      arr.splice(i, 1)
      if (!arr.length) delete f.sectJails[sid]
      try { await unmarkPlayerCaptive(gid, uid) } catch (err) { }
      logEvent(f, 'captive', `【越狱】${sname} 天牢中的 ${x.name} 成功越狱，重获自由（共关押约 ${Math.max(1, Math.round((now - x.at) / 60000))} 分钟）`, now, { who: [x.name], sect: sid })
      saveFake(f, gid)
      return { ok: true, msg: `🔓 越狱成功！你成功逃出【${sname}】天牢，重获自由` }
    }
    x.lastEscapeAt = now + 30 * 60000
    logEvent(f, 'captive', `【越狱失败】${sname} 天牢中的 ${x.name} 尝试越狱被守卫发现，押回牢房`, now, { who: [x.name], sect: sid })
    saveFake(f, gid)
    const pct = Math.round(rate * 100)
    return { ok: false, msg: `⛓️ 越狱失败！被守卫发现押回牢房（当前成功率约 ${pct}%，关押越久成功率越高，满24小时必成；30分钟后可再试）` }
  }
  return { ok: false, msg: '你不在任何宗门天牢里' }
}

/* ============ 玩家营救被关同伴(#拯救) ============ */
/** 查询是否正在营救(api.js 拦截用): 返回 '宗门名·救援' 或 null
 *  到期不清理标记——由 settleSectJails 释放被救者后统一删除 */
export async function rescuingOf (gid, uid) {
  try {
    const raw = await redis.get(rescueKey(gid, uid))
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || !o.until || o.until <= Date.now()) return null
    return `${o.s}·救援`
  } catch (err) { return null }
}

/** #拯救: 玩家花30分钟营救被关天牢的同伴(期间施救者只能查看信息)
 *  到期后由 settleSectJails 每分钟检查并释放被救者出狱 */
export async function startRescue (f, gid, uid, tUid) {
  const suid = String(uid)
  const st = String(tUid || '').trim()
  if (!st) return { ok: false, msg: '用法：#拯救 @被关玩家（花30分钟把他从天牢救出来）' }
  if (suid === st) return { ok: false, msg: '你不在天牢里，救谁呢' }
  /* 施救者不能已在营救中 / 自己被俘关押 */
  const busy = await rescuingOf(gid, uid)
  if (busy) return { ok: false, msg: '⛏️ 你正在营救同伴，30分钟内脱不开身' }
  try { const cap = await captiveOf(gid, uid); if (cap) return { ok: false, msg: '⛓️ 你身陷囹圄，先自救（#越狱）或等救援吧' } } catch (err) { }
  /* 目标必须正被关在本群某个宗门天牢里 */
  let jailSect = null
  for (const sid of Object.keys(f.sectJails || {})) {
    if ((f.sectJails[sid] || []).some(x => String(x.uid) === st)) { jailSect = sid; break }
  }
  if (!jailSect) return { ok: false, msg: '被关的玩家不在天牢里（可能已释放/越狱/换人）' }
  const sname = sectName(f, jailSect)
  try {
    await redis.set(rescueKey(gid, uid), JSON.stringify({ s: sname, t: st, sid: jailSect, until: Date.now() + RESCUE_MS }))
  } catch (err) {
    return { ok: false, msg: '营救启动失败，请稍后再试' }
  }
  return { ok: true, msg: `⛏️ 你已开始营救【${sname}】天牢中的同伴，约需30分钟（期间你只能查看信息，被救者出狱后自动解除）` }
}

/* ============ 搜刮战俘(真实数据, 绑定道具不搜) ============ */
/** 搜刮伪玩家战俘: 灵石+背包全部(排除绑定) → 胜方宗门宝库(灵石→stones, 丹药→pills, 材料→mats, 装备→equips) */
export function lootFakeCaptive (f, gid, p, winSect) {
  const take = { stones: 0, mats: {}, pills: {}, equips: {} }
  const vault = winSect && f.sects[winSect] ? getVault(f, winSect) : null
  if (!vault) return take
  const entries = extractWarLoot(p.bag || {}, 1)
  depositWarLoot(vault, entries)
  for (const entry of entries) {
    const field = MATERIAL_TPL[entry.name] ? 'mats' : ITEM_TPL[entry.name] ? 'pills' : 'equips'
    take[field][entry.name] = (take[field][entry.name] || 0) + entry.count
  }
  take.stones = Math.max(0, Number(p.money) || 0); p.money = 0; vault.stones += take.stones
  return take
}

function captiveCheckpoint (f, gid) {
  if (withImmediateSaveContext(() => saveFake(f, gid)) === false) throw new Error('俘虏事务保存失败')
}

/** 扣款和背包转移各自带收据；同一战役重试时重放原清单，保留装备属性。 */
export async function lootPlayerCaptive (f, gid, uid, winSect, ratio, options = {}) {
  uid = String(uid)
  const owner = !options.toVault && f.sects[winSect]?.owner ? String(f.sects[winSect].owner) : null
  const vault = winSect && f.sects[winSect] ? getVault(f, winSect) : null
  if (!owner && !vault) return { items: {}, stones: 0 }
  const receipt = options.receipt || `legacy:${Date.now()}:${uid}:${Math.random()}`
  const bag = getBag(uid, gid)
  bag.warLootReceipts ||= {}
  let plan = bag.warLootReceipts[receipt]
  if (!plan) {
    const entries = extractWarLoot(bag, ratio)
    plan = bag.warLootReceipts[receipt] = { entries, owner, winSect, at: Date.now() }
    saveBag(uid, bag, gid)
  }
  const m = await playerMoney(gid, uid)
  const user = m.home[uid]
  user.warLootReceipts ||= {}
  if (!Object.hasOwn(user.warLootReceipts, receipt)) {
    const amount = Math.floor(Math.max(0, m.money) * ratio)
    user.money = m.money - amount; user.warLootReceipts[receipt] = amount
    await xujing_data.getQQYUserHome(uid, m.home, m.filename, true)
  }
  const stones = user.warLootReceipts[receipt]
  if (plan.owner && plan.owner !== uid) {
    const targetBag = getBag(plan.owner, gid)
    targetBag.warLootReceived ||= {}
    if (!targetBag.warLootReceived[receipt]) {
      for (const it of plan.entries) addItemToBag(targetBag, it.name, it.count, it.attr, false)
      targetBag.warLootReceived[receipt] = true
      saveBag(plan.owner, targetBag, gid)
    }
  }
  const targetVault = f.sects[plan.winSect] ? getVault(f, plan.winSect) : null
  if (!targetVault) throw new Error('战利品接收宗门不存在，暂缓转移')
  targetVault.warLootReceived ||= {}
  if (!targetVault.warLootReceived[receipt]) {
    if (!plan.owner || plan.owner === uid) depositWarLoot(targetVault, plan.entries)
    targetVault.stones += stones
    targetVault.warLootReceived[receipt] = true
    captiveCheckpoint(f, gid)
  }
  const items = {}
  for (const it of plan.entries) items[it.name] = (items[it.name] || 0) + it.count
  return { items, stones }
}

/** 将指定俘虏的全部非绑定财物扒入宗门宝库，返回播报用摘要 */
async function lootCaptivesToVault (f, gid, sectId, fakes = [], players = [], atk = {}) {
  const out = []
  for (const n of fakes) {
    const p = f.roster[n]
    if (!p || !p.alive) continue
    const t = lootFakeCaptive(f, gid, p, sectId)
    const count = Object.values(t.mats).reduce((a, b) => a + b, 0) +
      Object.values(t.pills).reduce((a, b) => a + b, 0) +
      Object.values(t.equips).reduce((a, b) => a + b, 0)
    const items = [lootItemsText(t.mats), lootItemsText(t.pills), lootItemsText(t.equips)].filter(Boolean).join('、')
    if (count || t.stones) out.push(`${n}（${items || '无物品'}${t.stones ? `、💰灵石×${t.stones}` : ''}）`)
  }
  for (const uid of players) {
    const pp = f.players[uid]
    const t = await lootPlayerCaptive(f, gid, uid, sectId, 1, { toVault: true, receipt: `${warReceipt(atk)}:manual:${sectId}:${uid}:confine` })
    const itemText = lootItemsText(t.items)
    if (itemText || t.stones > 0) out.push(`${pp?.name || uid}（${itemText || '无物品'}${t.stones ? `、💰灵石×${t.stones}` : ''}）`)
  }
  return out
}

/** 处置俘虏: 全杀/搜刮再杀/全放/搜刮再放/关天牢(胜方宗主/副宗/太上)
 *  只处置胜方抓的战俘(败方人); 胜方自己人被对方擒的不处置(待解救) */
/** 玩家主动收编成功率(俘虏愿降概率): 依据俘虏性格/魔修/原宗已灭/忠诚 — 愿降则拜入宗门, 拒降保留继续处置 */
export function recruitRateOf (f, p) {
  let r = 0.55
  if (p.trait === '平和') r += 0.2
  else if (p.trait === '善良') r += 0.15
  else if (p.trait === '好斗') r -= 0.15
  else if (p.trait === '嗜杀') r -= 0.3
  if (p.path === '魔道') r -= 0.15
  /* 原宗门已被灭/名存实亡 → 无家可归, 更愿归顺 */
  const old = p.sect ? f.sects[p.sect] : null
  if (!p.sect || !old || old.wipeAt) r += 0.25
  /* 忠诚越高越难收服 */
  r -= (Number(p.loyalty) || 60) / 100 * 0.2
  return clamp(r, 0.1, 0.9)
}

/* 同一场战争中拒绝过一次收编的俘虏，不再重复进行随机劝降 */
function markRecruitRefused (atk, name) {
  const c = atk.captives || (atk.captives = {})
  if (!Array.isArray(c.recruitRefused)) c.recruitRefused = []
  if (!c.recruitRefused.includes(name)) c.recruitRefused.push(name)
}

export function canPlayerControlCaptives (f, sectId) {
  const s = f.sects && f.sects[sectId]
  if (!s) return false
  if (s.owner) {
    const ownerId = String(s.owner)
    if (f.players && f.players[ownerId]) return true
  }
  const playerLeaders = Object.values(f.players || {}).filter(p => p && p.sect === sectId && ['zongzhu', 'fuzong', 'taishang'].includes(p.pos))
  return playerLeaders.length > 0
}

export function chooseAiCaptiveAction (f, sectId) {
  const s = f.sects && f.sects[sectId]
  if (!s) return '全放'
  const alive = sectAlive(f, sectId).length
  const free = sectCap(f, sectId) - alive
  if (free > 0 && Math.random() < 0.6) return '收编'
  if (Math.random() < 0.45) return '关天牢'
  if (Math.random() < 0.75) return '全杀'
  return '搜刮再放'
}


function captivePoolForSect (f, atk, sectId) {
  if (!atk || atk.phase !== 'done' || !['win', 'lose'].includes(atk.result) || !atk.captives) return null
  const c = atk.captives
  const share = c.byShare && c.byShare[sectId]
  const shareHas = !!(share && ((share.fakes || []).length || (share.players || []).length))
  let controls = false
  if (atk.result === 'win') controls = atk.atkSect === sectId || winnerOfCoalition(atk) === sectId || shareHas
  else if (atk.result === 'lose') {
    const defSect = defenderOf(f, atk)
    controls = defSect === sectId
  }
  if (!controls) return null
  if (atk.result === 'win' && Object.keys(c.byShare || {}).length && !shareHas) return null
  const hasSub = !!(c.byAtk || c.byDef)
  const side = hasSub ? (atk.result === 'win' ? (c.byAtk || {}) : (c.byDef || {})) : c
  /* 联盟份额确实有俘虏时才优先使用；空份额必须回退实际抓人方池 */
  return { pool: shareHas ? share : side, share: shareHas ? share : null, hasSub }
}

/** 找本宗下一场可处置战争；送矿/面板优先仍有存活伪玩家的批次 */
export function pendingCaptivesForSect (f, sectId, preferLiveFake = false) {
  const eligible = (f.sectAttacks || []).map(atk => {
    const info = captivePoolForSect(f, atk, sectId)
    if (!info || !((info.pool.fakes || []).length || (info.pool.players || []).length)) return null
    return { atk, info }
  }).filter(Boolean)
  if (!eligible.length) return null
  const hit = preferLiveFake
    ? eligible.find(x => (x.info.pool.fakes || []).some(n => f.roster[n] && f.roster[n].alive)) || eligible[0]
    : eligible[0]
  return { atk: hit.atk, fakes: [...(hit.info.pool.fakes || [])], players: [...(hit.info.pool.players || [])] }
}

export async function handleCaptives (f, gid, atkSect, act, targetName = null, forceAi = false, actorUid = null, warId = null) {
  if (!forceAi && !canPlayerControlCaptives(f, atkSect)) {
    const aiAct = chooseAiCaptiveAction(f, atkSect)
    const aiResult = await handleCaptives(f, gid, atkSect, aiAct, targetName, true, null, warId)
    return { ok: true, msg: `⚠️ 当前宗门暂无玩家宗主，俘虏由伪玩家内定处理：${aiAct}${aiResult && aiResult.msg ? `\n${aiResult.msg}` : ''}` }
  }
  const attacks = f.sectAttacks || []
  /* 送矿优先选择至少有一名仍存活伪玩家的战争，避免失效旧记录挡住后续有效俘虏 */
  const eligible = attacks.filter(a => {
    if (warId != null && String(a.id) !== String(warId)) return false
    const info = captivePoolForSect(f, a, atkSect)
    if (a.phase !== 'done' || !info) return false
    return !!((info.pool.fakes || []).length || (info.pool.players || []).length)
  })
  const atk = targetName
    ? eligible.find(a => {
        const info = captivePoolForSect(f, a, atkSect)
        return (info.pool.fakes || []).some(n => n === targetName || (f.roster[n] && f.roster[n].name === targetName)) ||
          (info.pool.players || []).some(uid => String(uid) === String(targetName) || (f.players[uid]?.name || a.actors?.[`player:${uid}`]?.name) === targetName)
      }) || eligible[0]
    : ((act === '送矿山' || act === '送往矿山' || act === '收编')
      ? eligible.find(a => {
          const info = captivePoolForSect(f, a, atkSect)
          return (info.pool.fakes || []).some(n => {
            const p = f.roster[n]
            return p && p.alive && p.status !== 'mine' && !p.mineOf
          })
        }) || eligible[0]
      : eligible[0])
  if (!atk) return { ok: false, msg: '没有待处置的俘虏' }
  const now = Date.now()
  const c = atk.captives
  const info = captivePoolForSect(f, atk, atkSect)
  if (!info) return { ok: false, msg: '这场战争没有本宗可处置的俘虏' }
  const jailedUids = new Set() // 关天牢的玩家: 保留被俘标记(锁定)
  ensureCapSub(atk)
  const pool = info.pool
  const share = info.share
  const hasSub = info.hasSub
  let cf = [...(pool.fakes || [])]
  let cp = [...(pool.players || [])]
  /* 清理旧战争中已经死亡/消失的伪玩家，避免收编操作落到空名字上 */
  const staleFakes = cf.filter(n => !f.roster[n] || !f.roster[n].alive)
  if (staleFakes.length) {
    cf = cf.filter(n => !staleFakes.includes(n))
    c.fakes = (c.fakes || []).filter(n => !staleFakes.includes(n))
    const caught = atk.result === 'win' ? c.byAtk : c.byDef
    if (caught) caught.fakes = (caught.fakes || []).filter(n => !staleFakes.includes(n))
    if (share) share.fakes = (share.fakes || []).filter(n => !staleFakes.includes(n))
  }
  /* 指定某人单独处置: 只留该俘虏(伪玩家按名字, 玩家按名字) */
  if (targetName) {
    const fcf = cf.filter(n => n === targetName || (f.roster[n] && f.roster[n].name === targetName))
    const fcp = cp.filter(u => String(u) === String(targetName) || (f.players[u]?.name || atk.actors?.[`player:${u}`]?.name) === targetName)
    if (!fcf.length && !fcp.length) return { ok: false, msg: `俘虏里没有【${targetName}】` }
    cf = fcf; cp = fcp
  }
  const sname = sectName(f, atkSect)
  /* 被抓者原属宗门(守方/攻方), 记录写入其个人/宗门事迹 */
  const defSect = atk.result === 'lose' ? atk.atkSect : (defenderOf(f, atk))
  const lootTxt = []
  const mineRejects = []
  const mineSent = []
  const doLoot = act === '搜刮再杀' || act === '搜刮再放'
  if (act === '关天牢' || act === '送矿山' || act === '送往矿山') {
    /* 关押/送矿前没收全部非绑定财物；玩家战俘不能送矿，避免提前没收 */
    const confinedLoot = await lootCaptivesToVault(
      f, gid, atkSect, cf, act === '关天牢' ? cp : [], atk
    )
    if (confinedLoot.length) lootTxt.push(`没收财物：${confinedLoot.join('、')}`)
  }
  if (doLoot) {
    /* 搜刮全部: 伪玩家全搜刮进宝库; 玩家随机0~30% */
    for (const n of cf) {
      const p = f.roster[n]
      if (p && p.alive) {
        const t = lootFakeCaptive(f, gid, p, atkSect)
        lootTxt.push(`${n}（${[lootItemsText(t.mats), lootItemsText(t.pills), lootItemsText(t.equips)].filter(Boolean).join('、') || '无物品'}${t.stones ? `、💰灵石×${t.stones}` : ''}）`)
      }
    }
    for (const uid of cp) {
      const pp = f.players[uid]
      const t = await lootPlayerCaptive(f, gid, uid, atkSect, 0.3, { receipt: `${warReceipt(atk)}:manual:${atkSect}:${uid}:loot` })
      const n = Object.values(t.items).reduce((a, b) => a + b, 0)
      if (n > 0 || t.stones > 0) lootTxt.push(`${pp?.name || uid}（${lootItemsText(t.items) || '无物品'}${t.stones ? `、💰灵石×${t.stones}` : ''}）`)
    }
    atkLog(atk, `【搜刮】${sname} 搜刮战俘财物：${lootTxt.join('、') || '一无所获'}`, now)
  }
  /* 收编: 伪玩家逐个劝降, 每名俘虏在本场战争中只进行一次; 愿降拜入宗门; 拒降保留供其他处置 — 玩家战俘不可收编 */
  const recruitDone = []
  const recruitRefused = []
  const refusedBefore = new Set((c.recruitRefused || []).map(String))
  if (act === '收编') {
    if (!cf.length && cp.length) return { ok: false, msg: `❌ 收编失败：当前只有 ${cp.length} 名玩家战俘，玩家不能收编；请使用全杀、全放、搜刮再放或关天牢` }
    if (!cf.length) return { ok: false, msg: '❌ 收编失败：当前批次的伪玩家战俘已死亡或失联，失效记录已清理' }
    if (cf.length && sectOccupancy(f, atkSect) >= sectCap(f, atkSect)) {
      return { ok: false, msg: `宗门已满员（${sectOccupancy(f, atkSect)}/${sectCap(f, atkSect)}），无法再收编战俘` }
    }
    if (cp.length) recruitRefused.push(`玩家战俘不可收编（${cp.map(u => (f.players[u] && f.players[u].name) || u).join('、')}，请用 全杀/搜刮再杀/全放/搜刮再放/关天牢 处置）`)
    for (const n of [...cf]) {
      const p = f.roster[n]
      if (!p || !p.alive) continue
      if (refusedBefore.has(String(n))) {
        recruitRefused.push(`${n} 已拒绝过收编，不再重复劝降`)
        continue
      }
      if (p.servantOf) { recruitRefused.push(`${n}（已有主人，不可收编入宗）`); continue }
      if (sectOccupancy(f, atkSect) >= sectCap(f, atkSect)) { recruitRefused.push(`${n}（宗门已满员，未能收编）`); break }
      if (Math.random() < recruitRateOf(f, p)) {
        /* 收编成功: 叛离原宗拜入本宗, 忠诚重头再来 */
        const oldSect = p.sect
        if (oldSect) removeFromSectMap(f, oldSect, n)
        if (!admitSectNpc(f, p, atkSect)) { recruitRefused.push(`${n}（宗门已满员）`); continue }
        // 收编任职不改变NPC实际修为。
        p.joinAt = now
        if (f.sectMap[atkSect]) { if (!f.sectMap[atkSect].dizi) f.sectMap[atkSect].dizi = []; if (!f.sectMap[atkSect].dizi.includes(n)) f.sectMap[atkSect].dizi.push(n) }
        p.loyalty = Math.floor((Number(p.loyalty) || 60) * 0.35)
        recruitDone.push(n)
        logEvent(f, 'join', `【收编】${sname} 收编战俘 ${n} 弃暗投明，拜入宗门`, now, { who: [n], sect: atkSect })
        atkLog(atk, `【收编】${n} 归顺${sname}，拜入宗门`, now)
      } else {
        markRecruitRefused(atk, n)
        recruitRefused.push(`${n} 宁死不降（本场战争不再重复劝降）`)
        atkLog(atk, `【劝降】${n} 宁死不降，本场不再重复劝降`, now)
      }
    }
    if (recruitDone.length) logEvent(f, 'attack', `【收编】${sname} 收编 ${recruitDone.length} 名战俘入宗`, now, { major: true })
    if (recruitDone.length === 0) {
      saveFake(f, gid)
      return { ok: false, msg: `❌ 本次没有收编成功：${recruitRefused.join('；') || '俘虏拒绝归顺'}。拒绝者仍保留在俘虏名单，但本场不能再次收编，请改用其他处置方式` }
    }
    /* 收编成功的纳入本次处置(末尾从池移除); 拒降的保留池中待其他处置 */
    cf = recruitDone.slice()
    cp = []
  }
  if (act === '送矿山' || act === '送往矿山') {
    /* 伪玩家战俘送入宗门矿山挖矿(玩家战俘不可送, 保留待处置) */
    if (!f.sectMines) f.sectMines = {}
    if (!f.sectMines[atkSect]) f.sectMines[atkSect] = []
    const sent = []
    const stale = []
    for (const n of cf) {
      const p = f.roster[n]
      if (!p || !p.alive) { stale.push(n); continue }
      /* 上次异常可能已完成矿工状态但尚未来得及清理俘虏池；重试时恢复为成功 */
      if (p.status === 'mine' || p.mineOf) {
        if (p.mineOf === atkSect) {
          if (!f.sectMines[atkSect].some(x => x.name === n)) f.sectMines[atkSect].push({ name: n, at: p.mineSince || now, outStones: 0, outMats: {}, colorHit: 0 })
          sent.push(n)
          mineSent.push(n)
        } else stale.push(n)
        continue
      }
      /* 送矿前解除原宗门身份，建立独立矿工状态；避免继续作为原宗弟子活动/参战/叛逃 */
      if (p.sect) removeFromSectMap(f, p.sect, n)
      p.mineOf = atkSect
      p.mineSince = now
      p.servantOf = null
      p.servantSince = 0
      p.sect = null
      p.pos = null
      p.status = 'mine'
      if (!f.sectMines[atkSect].some(x => x.name === n)) f.sectMines[atkSect].push({ name: n, at: now, outStones: 0, outMats: {}, colorHit: 0 })
      sent.push(n)
      mineSent.push(n)
      addMineEvent(f, { t: now, type: 'enter', sect: atkSect, name: n, at: now, duration: 0, stones: 0, mats: {}, txt: `【送矿】${sname} 将战俘 ${n} 押入矿山` })
      logEvent(f, 'captive', `【送矿】${sname} 将战俘 ${n} 送入矿山挖矿`, now, { who: [n], sect: defSect })
      atkLog(atk, `【送矿】${n} 被押送矿山挖矿`, now)
    }
    if (cp.length) mineRejects.push(`玩家战俘不可送入矿山（${cp.map(u => (f.players[u] && f.players[u].name) || u).join('、')}，请用 全杀/搜刮再杀/全放/搜刮再放/关天牢 处置）`)
    if (sent.length) logEvent(f, 'attack', `【送矿】${sname} 将 ${sent.length} 名战俘押送矿山挖矿`, now, { major: true })
    atkLog(atk, `【送矿】${sent.length} 名门人战俘被押送矿山`, now)
    /* 清理已死亡/已从人物表消失的陈旧俘虏，避免永远挡住后续战争 */
    const removed = [...sent, ...stale]
    c.fakes = (c.fakes || []).filter(n => !removed.includes(n))
    const caught = atk.result === 'win' ? c.byAtk : c.byDef
    if (caught) caught.fakes = (caught.fakes || []).filter(n => !removed.includes(n))
    if (share) share.fakes = (share.fakes || []).filter(n => !removed.includes(n))
    if (!sent.length) {
      saveFake(f, gid)
      const why = cp.length
        ? `当前只有 ${cp.length} 名玩家战俘，玩家不能送矿山`
        : (stale.length ? `这批 ${stale.length} 名伪玩家战俘已死亡或不存在，失效记录已清理` : '当前没有可送入矿山的伪玩家战俘')
      return { ok: false, msg: `❌ 送矿失败：${why}。请重新 #处置俘虏 查看下一批` }
    }
    cf = []; cp = []
  }
  if (act === '全杀' || act === '搜刮再杀') {
    // 先兑现每人的外部收据，再在同一世界档提交处决；失败可重试原俘虏。
    if (!forceAi && actorUid) {
      for (const n of cf) {
        const p = f.roster[n]
        if (!p?.alive) continue
        await addWarKarma(gid, actorUid, 1, `${warReceipt(atk)}:manual:karma:${n}`)
        Wanhun.captureSoul(actorUid, gid, p.level, 1, `${warReceipt(atk)}:manual:soul:${n}`)
      }
    }
    for (const n of cf) {
      const p = f.roster[n]
      if (p && p.alive) killPerson(f, p, `【处决】${sname} 处决战俘 ${n}`, now)
      logEvent(f, 'captive', `【处决】${sname} 处决战俘 ${n}`, now, { who: [n], sect: defSect })
    }
    for (const uid of cp) {
      const pp = f.players[uid] || { name: atk.actors?.[`player:${uid}`]?.name || String(uid) }
      {
        applyInjury(f, uid, 3, now, gid, `${warReceipt(atk)}:manual:injury:${uid}:${act}`)
        logEvent(f, 'captive', `【处决】${sname} 处决玩家战俘 ${pp.name}（重伤惩戒）`, now, { who: [pp.name], sect: defSect })
      }
    }
    logEvent(f, 'attack', `【处决】${sname} 处置战俘：全部处决！双方结下深仇`, now, { major: true })
    atkLog(atk, `【处决】${sname} 处决全部战俘（${cf.length} 门人 + ${cp.length} 玩家）`, now)
  } else if (act === '全放') {
    for (const n of cf) logEvent(f, 'captive', `【释放】${sname} 释放战俘 ${n}`, now, { who: [n], sect: defSect })
    for (const uid of cp) {
      const pp = f.players[uid]
      if (pp) logEvent(f, 'captive', `【释放】${sname} 释放玩家战俘 ${pp.name}`, now, { who: [pp.name], sect: defSect })
    }
    logEvent(f, 'attack', `【释放】${sname} 宽宏大量，释放全部战俘`, now)
    atkLog(atk, `【释放】${sname} 释放全部战俘`, now)
  } else if (act === '关天牢') {
    /* 玩家+伪玩家战俘都关进宗门天牢(无限期); 可越狱, 关押越久成功率越高, 满24小时必成 */
    if (!f.sectJails) f.sectJails = {}
    if (!f.sectJails[atkSect]) f.sectJails[atkSect] = []
    for (const uid of cp) {
      const pp = f.players[uid] || { name: atk.actors?.[`player:${uid}`]?.name || String(uid) }
      if (!f.sectJails[atkSect].some(x => String(x.uid) === String(uid))) f.sectJails[atkSect].push({ uid: String(uid), name: pp.name, at: now, atkId: atk.id })
      jailedUids.add(String(uid))
      await markPlayerCaptive(gid, uid, `${sname}·天牢`, 3600)
      applyInjury(f, uid, 2, now, gid, `${warReceipt(atk)}:manual:injury:${uid}:${act}`)
      logEvent(f, 'captive', `【收押】玩家 ${pp.name} 被关入【${sname}】天牢（无限期，可越狱）`, now, { who: [pp.name], sect: defSect })
    }
    for (const n of cf) {
      const p = f.roster[n]
      if (p && p.alive) {
        if (!f.sectJails[atkSect].some(x => x.name === n)) f.sectJails[atkSect].push({ name: n, at: now, atkId: atk.id })
        logEvent(f, 'captive', `【收押】${sname} 将战俘 ${n} 关入天牢（无限期，可越狱）`, now, { who: [n], sect: defSect })
      }
    }
    logEvent(f, 'attack', `【收押】${sname} 将 ${cp.length + cf.length} 名战俘关入宗门天牢`, now, { major: true })
    atkLog(atk, `【收押】${cp.length} 名玩家 + ${cf.length} 名门人战俘被关入${sname}天牢`, now)
  } else if (act === '搜刮再放') {
    /* 搜刮再放 */
    for (const n of cf) {
      const p = f.roster[n]
      if (p && p.alive) logEvent(f, 'captive', `【搜刮释放】${sname} 搜刮战俘 ${n} 后释放`, now, { who: [n], sect: defSect })
    }
    for (const uid of cp) {
      const pp = f.players[uid]
      if (pp) logEvent(f, 'captive', `【搜刮释放】${sname} 搜刮玩家战俘 ${pp.name} 后释放`, now, { who: [pp.name], sect: defSect })
    }
    logEvent(f, 'attack', `【搜刮释放】${sname} 搜刮战俘财物后将其释放，双方结下仇怨`, now, { major: true })
    atkLog(atk, `【搜刮】${sname} 搜刮战俘财物后释放`, now)
  }
  const capPlayers = [...cp] // 处置前备份(解除被俘状态用)
  const capFakes = [...cf]
  cf.length = 0
  cp.length = 0
  /* 处置成功的伪玩家从总池和所有攻守/联盟子池移除；拒绝者不在 capFakes 中，继续留池 */
  removeCaptivesFromPools(atk, capFakes, capPlayers)
  /* 玩家被处置完成 → 解除被俘状态(redis; 关天牢的保留标记锁定) */
  for (const uid of capPlayers) { if (jailedUids.has(String(uid))) continue; try { await unmarkPlayerCaptive(gid, uid) } catch (err) { } }
  saveFake(f, gid)
  const tail = []
  if (act === '收编') {
    if (recruitDone.length) tail.push(`收编入宗：${recruitDone.join('、')}`)
    if (recruitRefused.length) tail.push(`未收编：${recruitRefused.join('；')}`)
    if (recruitRefused.length) tail.push('拒绝者本场不可再次收编，请继续 #处置俘虏（或 #处置俘虏 [名字] 全杀/全放/搜刮再放/关天牢 单独处置）')
  } else if (act === '送矿山' || act === '送往矿山') {
    tail.push(`已送入矿山 ${mineSent.length} 人：${mineSent.join('、')}`)
    if (mineRejects.length) tail.push(mineRejects.join('；'))
    tail.push('矿工每小时产出灵石/矿物入宗门宝库，#宗门矿山 可立即查看名单')
  }
  return { ok: true, msg: `✅ 处置完成${lootTxt.length ? '：' + lootTxt.join('；') : ''}${tail.length ? '\n' + tail.join('\n') : ''}` }
}
