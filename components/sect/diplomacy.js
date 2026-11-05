import { commonTerritoryThreat } from './ai_strategy.js'
import { diplomacyPair, setDiplomacyRelation, normalizeDiplomacy, hasTruce, recordDiplomacyAid } from './diplomacy_state.js'
import { defenderOf, initWarState, warActorAvailable } from './war_state.js'
import { planWarDeployment, commitWarDeployment, releaseWarFake, withHomeReserve } from './war_roster.js'
/* 由 sect_system.js 拆分自动生成: diplomacy.js */
import { sectName, sectIdByName, sectAlive, sectPower, personPower, logEvent, saveFake } from '../fake_data.js'
import { getWorld, getLoc, regionNameOf, DEFAULT_REGION } from '../world_data.js'
import { playerPower, willFight, getVault, atkLog, pick, clamp, uniqueIdList, markSectWar, markAreaRaid, sectRegion, regionOfArea, CFG, warTargetTxt, targetRawTxt } from './utils.js'

/* ---------- 宣战 / 议和 ---------- */
export function declareWar (f, gid, id, targetName) {
  normalizeDiplomacy(f)
  const sid = sectIdByName(f, targetName)
  if (!sid) return { ok: false, msg: '没有找到该宗门' }
  if (sid === id) return { ok: false, msg: '不能向自己宣战' }
  const s = f.sects[id]
  if (hasTruce(f, id, sid)) return { ok: false, msg: '双方仍在议和停战期' }
  if ((s.allies || []).includes(sid)) return { ok: false, msg: '对方是你的盟友，不可宣战（可 #退盟 解除结盟）' }
  if (s.enemies.includes(sid)) return { ok: false, msg: '双方已是对敌状态' }
  setDiplomacyRelation(f, id, sid, 'hostile', Date.now(), '主动宣战')
  logEvent(f, 'attack', `【宣战】${sectName(f, id)} 正式向 ${sectName(f, sid)} 宣战！`, Date.now(), { major: true })
  saveFake(f, gid)
  return { ok: true, msg: `⚔️ 已向【${sectName(f, sid)}】宣战，双方互为敌人！` }
}

/** 双方同意后中立停战；俘虏互放，保留战争维护与攻打冷却。 */
export function ceasefireBetween (f, gid, first, second, now = Date.now()) {
  let stopped = 0
  for (const war of f.sectAttacks || []) {
    if (!['prep', 'fight'].includes(war.phase)) continue
    const def = defenderOf(f, war)
    if (!((war.atkSect === first && def === second) || (war.atkSect === second && def === first))) continue
    initWarState(f, war, now)
    for (const field of ['atkFakes', 'defFakes']) for (const name of war[field] || []) releaseWarFake(f, war, name, '议和', now)
    for (const uid of war.captives?.players || []) { try { Promise.resolve(redis.del(`xujing:captive:${gid}:${uid}`)).catch(() => {}) } catch (err) {} }
    war.captives = { fakes: [], players: [] }
    war.phase = 'done'; war.result = 'peace'; war.endAt = now
    war.withdrawals = []
    markSectWar(f, war.atkSect, now); markSectWar(f, def, now)
    if (war.targetType === 'area') markAreaRaid(f, war.target, now)
    if (f.sects[war.atkSect]) f.sects[war.atkSect].atkCdUntil = now + (war.by === 'ai' ? CFG.FAKE_ATK_CD : CFG.PLAYER_ATK_CD) * 60000
    atkLog(war, '【议和】双方罢兵，互放俘虏，领地保持战前归属', now)
    stopped++
  }
  setDiplomacyRelation(f, first, second, 'neutral', now, '议和', { truce: true })
  return stopped
}

export function makePeace (f, gid, id, targetName, response = 'offer') {
  normalizeDiplomacy(f)
  const sid = sectIdByName(f, targetName)
  if (!sid || !f.sects[id]) return { ok: false, msg: '没有找到该宗门' }
  if (sid === id) return { ok: false, msg: '不能和自己议和' }
  const s = f.sects[id]; const ds = f.sects[sid]; const now = Date.now()
  f.peaceOffers ||= {}
  const incomingKey = `${sid}:${id}`
  const incoming = f.peaceOffers[incomingKey]
  if (response !== 'reject' && (f.sectAttacks || []).some(w => w.phase === 'settling' && [w.atkSect, defenderOf(f, w)].includes(id) && [w.atkSect, defenderOf(f, w)].includes(sid))) return { ok: false, msg: '战事正在结算，无法议和' }
  if (response === 'reject') {
    if (!incoming || incoming.expires <= now) return { ok: false, msg: '没有对方发来的有效议和请求' }
    delete f.peaceOffers[incomingKey]; saveFake(f, gid)
    return { ok: true, msg: '已拒绝议和，战争继续。' }
  }
  let proposer = id; let receiver = sid; let comp = 0
  if (response === 'accept') {
    if (!incoming || incoming.expires <= now) return { ok: false, msg: '没有对方发来的有效议和请求' }
    proposer = sid; receiver = id; comp = incoming.comp
  } else {
    if (!(s.enemies || []).includes(sid)) return { ok: false, msg: '双方并非敌对，无需议和' }
    if (Object.values(f.sectAttacks || {}).some(a => a.phase === 'settling' && [a.atkSect, defenderOf(f, a)].includes(id) && [a.atkSect, defenderOf(f, a)].includes(sid))) return { ok: false, msg: '战事正在结算，无法议和' }
    if ((s.peaceCdUntil || 0) > now) return { ok: false, msg: '本宗议和冷却中（24小时）' }
    if (sectPower(f, id) < sectPower(f, sid) * 0.6) comp = Math.floor(getVault(f, id).stones * 0.05)
    if (ds.owner) {
      f.peaceOffers[`${id}:${sid}`] = { from: id, to: sid, comp, at: now, expires: now + 30 * 60000 }
      saveFake(f, gid)
      return { ok: true, msg: `已向【${ds.name}】提出议和${comp ? `（赔款 ${comp} 灵石）` : ''}。对方高层须在30分钟内 #同意议和 ${s.name} 或 #拒绝议和 ${s.name}；同意前战争继续。` }
    }
  }
  if ((getVault(f, proposer).stones || 0) < comp) return { ok: false, msg: '求和方当前赔款不足，尚未停战' }
  getVault(f, proposer).stones -= comp; getVault(f, receiver).stones += comp
  const stopped = ceasefireBetween(f, gid, id, sid, now)
  f.sects[proposer].peaceCdUntil = now + 24 * 3600000
  delete f.peaceOffers[incomingKey]; delete f.peaceOffers[`${id}:${sid}`]
  logEvent(f, 'attack', `【议和】${s.name} 与 ${ds.name} 停战，结束 ${stopped} 场战事${comp ? `（赔款 ${comp} 灵石）` : ''}`, now)
  saveFake(f, gid)
  return { ok: true, msg: `已与【${ds.name}】议和，结束 ${stopped} 场战事，双方互放本场俘虏${comp ? `（赔款 ${comp} 灵石）` : ''}。` }
}


/* ---------- AI 宗门外交(主动结盟/议和) ---------- */
/** AI 宗门主动外交: 每10分钟尝试——
 *  ①结盟: 随机挑未结盟/非敌对的 AI 宗门对, 按意愿(文化/正邪/同大区/强弱攀附)结盟
 *  ②议和: 敌对 AI 对中, 明显弱势方或平和/善良宗主主动求和(弱势方赔款5%宝库)
 *  ③断交: 已结盟的 AI 对中, 好斗/嗜杀/魔修宗主或强弱悬殊时更易撕毁盟约
 *  返回是否有变更(供 sectTick 保存) */
export function aiDiplomacy (f, gid, now = Date.now()) {
  let changed = normalizeDiplomacy(f, now)
  f.targetCd ||= {}
  const touched = new Set()
  const keyOf = (a, b) => JSON.stringify([a, b].sort())
  const aiIds = Object.keys(f.sects).filter(id => {
    const s = f.sects[id]
    return s && !s.owner && !s.wipeAt && sectAlive(f, id).length > 0
  })
  if (aiIds.length < 2) return false
  const zzOf = (id) => {
    const sm = f.sectMap[id]
    return sm && sm.zongzhu ? (f.roster[sm.zongzhu] || null) : null
  }
  const peaceLike = (zz) => zz && (zz.trait === '平和' || zz.trait === '善良')
  const warLike = (zz) => zz && (zz.trait === '好斗' || zz.trait === '嗜杀' || zz.path === '魔道')
  const regionOfS = (id) => (f.sects[id] && f.sects[id].region) || ''

  /* ① 结盟: 世界外交是稀有的, 每10分钟最多促成一对 */
  if (Math.random() < 0.5) {
    const pairs = []
    for (let i = 0; i < aiIds.length; i++) {
      for (let j = i + 1; j < aiIds.length; j++) {
        const a = aiIds[i], b = aiIds[j]
        const sa = f.sects[a], sb = f.sects[b]
        const relation = diplomacyPair(f, a, b, now)
        if ((sa.allies || []).includes(b) || (sa.enemies || []).includes(b) || relation.breakUntil > now) continue
        if ((f.targetCd['ally:' + [a, b].sort().join('&')] || 0) > now) continue // 刚断交的短时不复盟
        if ((sb.allies || []).length >= 2 || (sa.allies || []).length >= 2) continue
        pairs.push([a, b])
      }
    }
    if (pairs.length) {
      const [a, b] = pick(pairs)
      const za = zzOf(a), zb = zzOf(b)
      let want = 0.4
      if (peaceLike(za)) want += 0.25
      if (peaceLike(zb)) want += 0.25
      if (warLike(za)) want -= 0.2
      if (warLike(zb)) want -= 0.2
      const memory = diplomacyPair(f, a, b, now)
      want += memory.trust / 500 - memory.grievance / 500 - ((f.sects[a].grudges?.[b] || 0) + (f.sects[b].grudges?.[a] || 0)) / 500
      if ((f.sects[a].enemies || []).some(id => (f.sects[b].enemies || []).includes(id))) want += 0.15
      const threat = commonTerritoryThreat(f, a, b)
      if (threat && !(f.sects[a].allies || []).includes(threat) && !(f.sects[b].allies || []).includes(threat)) want += 0.3
      if (za && zb && za.path === zb.path) want += 0.15
      if (regionOfS(a) && regionOfS(a) === regionOfS(b)) want += 0.15
      const pa = sectPower(f, a), pb = sectPower(f, b)
      if (pa > 0 && pb > 0) {
        if (pa < pb * 0.5) want += 0.15 // 弱宗攀附强宗
        if (pb < pa * 0.5) want += 0.15
      }
      want = clamp(want, 0, 0.9)
      if (Math.random() < want) {
        const sa = f.sects[a], sb = f.sects[b]
        if (!sa.allies) sa.allies = []
        if (!sb.allies) sb.allies = []
        if (sa.allies.length >= 2 || sb.allies.length >= 2) {
          enforceAllianceLimit(f, a)
          enforceAllianceLimit(f, b)
        } else {
          setDiplomacyRelation(f, a, b, 'allied', now, 'AI结盟')
          touched.add(keyOf(a, b))
          enforceAllianceLimit(f, a)
          enforceAllianceLimit(f, b)
          logEvent(f, 'attack', `【结盟】${sectName(f, a)} 与 ${sectName(f, b)} 缔结盟约，同气连枝、共御外敌！`, now, { major: true })
          changed = true
        }
      }
    }
  }

  /* ② 议和: 敌对 AI 对中, 弱势方或平和/善良宗主主动求和 */
  if (Math.random() < 0.5) {
    const hostile = []
    for (let i = 0; i < aiIds.length; i++) {
      for (let j = i + 1; j < aiIds.length; j++) {
        const a = aiIds[i], b = aiIds[j]
        if (!touched.has(keyOf(a, b)) && (f.sects[a].enemies || []).includes(b) && !(f.sectAttacks || []).some(w => w.phase === 'settling' && [w.atkSect, defenderOf(f, w)].includes(a) && [w.atkSect, defenderOf(f, w)].includes(b))) hostile.push([a, b])
      }
    }
    if (hostile.length) {
      const [a, b] = pick(hostile)
      const pa = sectPower(f, a), pb = sectPower(f, b)
      const za = zzOf(a), zb = zzOf(b)
      let pleader = null
      let comp = 0
      if (pa < pb * 0.6) { pleader = a; comp = Math.floor((getVault(f, a).stones || 0) * 0.05) }
      else if (pb < pa * 0.6) { pleader = b; comp = Math.floor((getVault(f, b).stones || 0) * 0.05) }
      else if (peaceLike(za) && Math.random() < 0.35) pleader = a
      else if (peaceLike(zb) && Math.random() < 0.35) pleader = b
      if (pleader) {
        const other = pleader === a ? b : a
        const sa = f.sects[pleader], so = f.sects[other]
        if (comp > 0 && (getVault(f, pleader).stones || 0) >= comp) {
          getVault(f, pleader).stones -= comp
          getVault(f, other).stones = (getVault(f, other).stones || 0) + comp
        }
        ceasefireBetween(f, gid, pleader, other, now)
        touched.add(keyOf(pleader, other))
        logEvent(f, 'attack', `【议和】${sectName(f, pleader)} 主动向 ${sectName(f, other)} 求和停战${comp ? `（赔款 ${comp} 灵石）` : ''}`, now)
        changed = true
      }
    }
  }

  /* ③ 断交: 已结盟的宗门对(含玩家宗门——AI 盟友可因性格/强弱单方撕盟; 双方皆玩家宗门由玩家 #退盟 决定), 好斗/嗜杀/魔修宗主更想独吞好处; 强弱悬殊也易脱身 */
  if (Math.random() < 0.5) {
    const allied = []
    const allIds = Object.keys(f.sects).filter(id => {
      const s = f.sects[id]
      return s && !s.wipeAt && sectAlive(f, id).length > 0
    })
    for (let i = 0; i < allIds.length; i++) {
      for (let j = i + 1; j < allIds.length; j++) {
        const a = allIds[i], b = allIds[j]
        const relation = diplomacyPair(f, a, b, now)
        if (touched.has(keyOf(a, b)) || relation.allyUntil > now || !(f.sects[a].allies || []).includes(b)) continue
        if (f.sects[a].owner && f.sects[b].owner) continue // 双方皆玩家宗门: 不自动断盟
        allied.push([a, b])
      }
    }
    if (allied.length) {
      const [a, b] = pick(allied)
      const za = zzOf(a), zb = zzOf(b)
      const memory = diplomacyPair(f, a, b, now)
      let want = 0.18 - memory.trust / 500 + memory.grievance / 500
      if (warLike(za)) want += 0.15
      if (warLike(zb)) want += 0.15
      if (peaceLike(za)) want -= 0.12
      if (peaceLike(zb)) want -= 0.12
      const pa = sectPower(f, a), pb = sectPower(f, b)
      if (pa > 0 && pb > 0) {
        if (pa < pb * 0.5) want += 0.1 // 弱宗怕被强宗当炮灰, 主动脱身
        if (pb < pa * 0.5) want += 0.1
      }
      want = clamp(want, 0, 0.9)
      if (Math.random() < want) {
        const sa = f.sects[a], sb = f.sects[b]
        setDiplomacyRelation(f, a, b, 'neutral', now, 'AI断交')
        touched.add(keyOf(a, b))
        /* 断交后互不敌对、各自为政; 记入盟约破碎冷却, 短期不再复盟 */
        f.targetCd['ally:' + [a, b].sort().join('&')] = now + 6 * 3600000
        logEvent(f, 'attack', `【断交】${sectName(f, a)} 与 ${sectName(f, b)} 盟约作废、各自为政！`, now, { major: true })
        changed = true
      }
    }
  }
  return changed
}


/* ---------- 结盟 / 联合攻打 / 贡献分配 ---------- */
/** 记录某参战宗门(含盟友)投入的战力与人数到 atk.coalition */
export async function recordCoalition (f, gid, atk, sid) {
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  let count = 0
  let power = 0
  if (f.sects[sid]) {
    for (const q of sectAlive(f, sid)) {
      if (!(atk.atkFakes || []).includes(q.name)) continue
      if (tRegion && (q.loc || DEFAULT_REGION) !== tRegion) continue
      count++
      power += personPower(q)
    }
  }
  for (const u of (atk.atkPlayers || [])) {
    const pp = f.players && f.players[u]
    if (pp && pp.sect === sid) { count++; power += await playerPower(f, gid, u) }
  }
  if (!atk.coalition) atk.coalition = {}
  const history = Object.values(atk.actors || {}).filter(a => a.side === 'atk' && a.sect === sid && a.contribution > 0)
  atk.coalition[sid] = (atk.roundHistory?.length || history.length) ? { count: history.length, power: history.reduce((n, a) => n + a.contribution, 0) } : { count, power }
}

/** 结算前重算联盟贡献(含中途加入/退出的盟友) */
export async function recomputeCoalition (f, gid, atk) {
  const members = new Set([atk.atkSect, ...Object.keys(atk.coalition || {})].filter(Boolean))
  for (const sid of members) {
    if (!f.sects[sid] || f.sects[sid].wipeAt) { if (atk.coalition) delete atk.coalition[sid]; continue }
    await recordCoalition(f, gid, atk, sid)
  }
}

/** 联盟中贡献最高者(战力优先, 人次次之, 平局归发起方) */
export function winnerOfCoalition (atk) {
  const c = atk.coalition || {}
  let best = atk.atkSect
  let bestScore = -1
  for (const [sid, info] of Object.entries(c)) {
    const score = (Number(info && info.power) || 0) * 10000 + (Number(info && info.count) || 0)
    if (score > bestScore) { bestScore = score; best = sid }
  }
  return best
}

/** 联盟各宗门输出(贡献)列表(战力降序) + 总和; 用于战利品/俘虏按输出比例分配 */
export function coalitionShares (atk) {
  const c = atk.coalition || {}
  const list = []
  for (const [sid, info] of Object.entries(c)) {
    const power = Number(info && info.power) || 0
    if (power > 0) list.push({ sid, power })
  }
  list.sort((a, b) => b.power - a.power)
  const total = list.reduce((a, x) => a + x.power, 0)
  return { list, total }
}

/** 守方被俘(byAtk)按联盟输出占比分给各宗门 → atk.captives.byShare[sid]={fakes,players}
 *  无联盟/散修(coalition 空)返回空对象, 由调用方回退旧逻辑 */
export function shareCaptivesByOutput (atk) {
  const shares = {}
  const { list, total } = coalitionShares(atk)
  if (!list.length || total <= 0) return shares
  const byAtk = atk.captives && atk.captives.byAtk
  if (!byAtk) return shares
  const fakes = [...(byAtk.fakes || [])]
  const players = [...(byAtk.players || [])]
  const totalN = fakes.length + players.length
  if (!totalN) return shares
  for (const { sid } of list) shares[sid] = { fakes: [], players: [] }
  /* 配额: 按输出占比分配人数, 余数给输出最高者 */
  const quota = {}
  let assigned = 0
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    const n = i === list.length - 1 ? totalN - assigned : Math.floor(totalN * it.power / total)
    quota[it.sid] = n
    assigned += n
  }
  /* 按配额依次填入(先伪玩家后玩家; 输出高者优先排前) */
  const put = (kind, item) => {
    for (const { sid } of list) {
      if ((shares[sid].fakes.length + shares[sid].players.length) >= quota[sid]) continue
      if (kind === 'f') shares[sid].fakes.push(item)
      else shares[sid].players.push(item)
      return
    }
    if (list[0]) {
      if (kind === 'f') shares[list[0].sid].fakes.push(item)
      else shares[list[0].sid].players.push(item)
    }
  }
  for (const n of fakes) put('f', n)
  for (const u of players) put('p', u)
  return shares
}

export function enforceAllianceLimit (f, sid) {
  const s = f.sects && f.sects[sid]
  if (!s) return false
  s.allies = uniqueIdList(s.allies).filter(id => !!f.sects[id] && id !== sid)
  if (s.allies.length <= 2) return false
  const extra = s.allies.slice(2)
  for (const oid of extra) {
    const os = f.sects[oid]
    if (!os) continue
    setDiplomacyRelation(f, sid, oid, hasTruce(f, sid, oid) ? 'neutral' : 'hostile', Date.now(), '盟友超额解除')
    logEvent(f, 'attack', `【反目成仇】${sectName(f, sid)} 与 ${sectName(f, oid)} 盟友超出 2 个上限，双方反目成仇！`, Date.now(), { major: true })
  }
  return true
}

/** 结盟: 双方互为盟友(不限制宗门类型, 玩家/伪玩家宗门皆可); 宗主/副宗可发起 */
export function allySect (f, gid, uid, targetName) {
  const p = f.players && f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') return { ok: false, msg: '只有宗主/副宗主/太上长老可以结盟' }
  normalizeDiplomacy(f)
  const sid = p.sect
  const tsid = sectIdByName(f, targetName)
  if (!tsid) return { ok: false, msg: '没有找到该宗门' }
  if (tsid === sid) return { ok: false, msg: '不能和自己结盟' }
  const s = f.sects[sid]
  const ts = f.sects[tsid]
  if (!s || !ts) return { ok: false, msg: '宗门不存在' }
  if ((s.enemies || []).includes(tsid)) return { ok: false, msg: '双方正在敌对，请先 #议和 再结盟' }
  if (!s.allies) s.allies = []
  if (s.allies.includes(tsid)) return { ok: false, msg: '你们已经是盟友了' }
  if (s.allies.length >= 2) return { ok: false, msg: '本宗已达盟友上限（2个），请先 #退盟 解除或反目成仇后再结新盟' }
  if (!ts.allies) ts.allies = []
  if (ts.allies.length >= 2) return { ok: false, msg: `【${sectName(f, tsid)}】已达盟友上限（2个），无法再结盟` }
  setDiplomacyRelation(f, sid, tsid, 'allied', Date.now(), '玩家结盟')
  enforceAllianceLimit(f, sid)
  enforceAllianceLimit(f, tsid)
  logEvent(f, 'attack', `【结盟】${sectName(f, sid)} 与 ${sectName(f, tsid)} 结为盟友，同气连枝！`, Date.now(), { major: true })
  saveFake(f, gid)
  return { ok: true, msg: `🤝 【${sectName(f, sid)}】与【${sectName(f, tsid)}】已结盟！可 #盟友助战 [目标] 一起攻打` }
}

/** 解除结盟 */
export function breakAlly (f, gid, uid, targetName) {
  const p = f.players && f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') return { ok: false, msg: '只有宗主/副宗主/太上长老可以解除结盟' }
  normalizeDiplomacy(f)
  const sid = p.sect
  const tsid = sectIdByName(f, targetName)
  if (!tsid) return { ok: false, msg: '没有找到该宗门' }
  const s = f.sects[sid]
  const ts = f.sects[tsid]
  if (!s || !ts) return { ok: false, msg: '宗门不存在' }
  if (!s.allies || !s.allies.includes(tsid)) return { ok: false, msg: '你们并未结盟' }
  setDiplomacyRelation(f, sid, tsid, 'neutral', Date.now(), '玩家退盟')
  logEvent(f, 'attack', `【退盟】${sectName(f, sid)} 与 ${sectName(f, tsid)} 解除结盟`, Date.now())
  saveFake(f, gid)
  return { ok: true, msg: '你们已解除结盟' }
}

/** 盟友助战: 盟友宗门派兵协助盟友攻打目标, 贡献计入联盟(打赢归贡献最高者); count>0 时限定派出人数 */
export async function allyAssist (f, gid, uid, rawTarget, count = 0) {
  count = Math.max(0, Math.floor(Number(count) || 0))
  const p = f.players && f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') return { ok: false, msg: '只有宗主/副宗主/太上长老可以派兵助战' }
  const sid = p.sect
  const s = f.sects[sid]
  if (!s) return { ok: false, msg: '宗门不存在' }
  rawTarget = String(rawTarget || '').trim()
  const atks = (f.sectAttacks || []).filter(a => {
    if (!a || (a.phase !== 'prep' && a.phase !== 'fight')) return false
    if (a.atkSect === sid || !(s.allies || []).includes(a.atkSect)) return false
    return defenderOf(f, a) !== sid
  })
  let atk = null
  const idMatch = atks.find(a => String(a.id) === String(rawTarget).replace(/^[#＃]/, ''))
  const tReg = regionOfArea(rawTarget)
  if (rawTarget) {
    if (idMatch) atk = idMatch
    else if (tReg) {
      atk = atks.find(a => a.targetType === 'area' && a.target === rawTarget)
    } else {
      const tsid = sectIdByName(f, rawTarget)
      if (tsid) atk = atks.find(a => a.targetType === 'sect' && a.target === tsid)
    }
    if (!atk) return { ok: false, msg: `没有找到盟友正在攻打${targetRawTxt(f, rawTarget)}` }
  } else if (atks.length > 1) {
    const lines = atks.map(a => {
      const n = (a.atkFakes || []).length + (a.atkPlayers || []).length
      return `　· 进攻${warTargetTxt(f, a)} · 参战 ${n} 人`
    })
    const first = atks[0]
    const firstName = first.targetType === 'area' ? first.target : sectName(f, first.target)
    return { ok: false, needChoice: true, msg: `⚔️ 当前有 ${atks.length} 处盟友战事：\n${lines.join('\n')}\n请指定：#盟友助战 [目标名] [人数]（如 #盟友助战 ${firstName} 3）` }
  } else {
    atk = atks[0]
  }
  if (atk && hasTruce(f, sid, defenderOf(f, atk))) return { ok: false, msg: '本宗与目标仍在议和停战期，不能派兵助攻' }
  if (!atk) return { ok: false, msg: rawTarget ? `没有找到盟友正在攻打${targetRawTxt(f, rawTarget)}` : '当前没有盟友正在进行的攻打' }
  const now = Date.now()
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  const taiSet = new Set((f.sectMap[sid] && f.sectMap[sid].taishang) || [])
  const field = []
  const away = []
  for (const q of sectAlive(f, sid)) {
    if ((atk.atkFakes || []).includes(q.name) || taiSet.has(q.name) || !warActorAvailable(f, 'fake', q.name, atk) || q.fakeTravel || !willFight(q, false, f)) continue
    if ((q.loc || DEFAULT_REGION) === tRegion) field.push(q)
    else away.push(q)
  }
  /* 盟友驰援也支持跨区调兵，费用由助战宗门宝库承担；count>0 时限定总派出人数(先派在场免费门人) */
  const vault = getVault(f, sid)
  const plan = planWarDeployment(f, gid, sid, tRegion, [...field, ...away].filter(q => warActorAvailable(f, 'fake', q.name, atk)), count, atk)
  const canDeploy = plan.units.length
  const fieldUse = plan.units.map(x => f.roster[x.name])
  commitWarDeployment(f, sid, atk, 'atk', plan)
  initWarState(f, atk)
  /* 本方门人(在目标大区或已由宝库调回)参战 */
  for (const q of fieldUse) {
    if (!(atk.atkFakes || []).includes(q.name)) atk.atkFakes.push(q.name)
  }
  const joinedPlayers = [] // 真人成员使用 #参战 自行报名。
  const joined = fieldUse.length + joinedPlayers.length
  if (!joined) return { ok: false, msg: count > 0
    ? `【${sectName(f, sid)}】可派出的门人不足 ${count} 人（在场 ${field.length} 人，宝库可跨区调 ${canDeploy} 人）`
    : `【${sectName(f, sid)}】暂无可驰援前线的门人或玩家（门人需在目标大区，或宝库有 ${CFG.SECT_DEPLOY_COST} 灵石/人的调兵费用）` }
  recordDiplomacyAid(f, sid, atk.atkSect, now)
  /* 记录贡献 */
  await recordCoalition(f, gid, atk, sid)
  const info = atk.coalition[sid] || { count: 0, power: 0 }
  atkLog(atk, `【助战】${sectName(f, sid)} 派 ${info.count} 人（战力${info.power}）助 ${sectName(f, atk.atkSect)} 攻打${warTargetTxt(f, atk)}`, now)
  logEvent(f, 'attack', `【助战】${sectName(f, sid)} 派 ${info.count} 人助 ${sectName(f, atk.atkSect)} 攻打${warTargetTxt(f, atk)}！`, now)
  saveFake(f, gid)
  return { ok: true, msg: `⚔️ 【${sectName(f, sid)}】已派 ${info.count} 人（战力${info.power}）协助盟友攻打！\n打赢后贡献最高者将获得地盘` }
}

/** AI 盟友自动助战: 盟友宗门(无玩家宗主, 由 AI 自主)自动派本大区门人加入盟友的攻打
 *  贡献计入 atk.coalition → 结算时 recomputeCoalition 重算 → 打赢按输出(贡献)最高者得地盘/战利品 */
export async function aiAllyAssist (f, gid, atk, now = Date.now()) {
  if (!atk || !atk.atkSect || !f.sects[atk.atkSect]) return
  const allies = (f.sects[atk.atkSect].allies) || []
  if (!allies.length) return
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  for (const sid of allies) {
    const s = f.sects[sid]
    if (!s || s.owner || s.wipeAt || hasTruce(f, sid, defenderOf(f, atk), now)) continue // 只 AI 盟友自动; 玩家宗主宗门由玩家 #盟友助战
    if (atk.coalition && atk.coalition[sid]) continue // 已加入
    const busy = (f.sectAttacks || []).some(a => a.phase !== 'done' && (a.atkSect === sid || defenderOf(f, a) === sid))
    if (busy) continue // 自己也有在途攻打, 不分身
    const taiSet = new Set((f.sectMap[sid] && f.sectMap[sid].taishang) || [])
    let cnt = 0
    const legal = new Set(planWarDeployment(f, gid, sid, tRegion, withHomeReserve(f, sid, sectAlive(f, sid).filter(q => (q.loc || DEFAULT_REGION) === tRegion), atk), 0, atk).units.map(x => x.name))
    for (const q of sectAlive(f, sid)) {
      if (!legal.has(q.name)) continue
      if ((atk.atkFakes || []).includes(q.name) || taiSet.has(q.name) || !warActorAvailable(f, 'fake', q.name, atk) || q.fakeTravel) continue
      if ((q.loc || DEFAULT_REGION) !== tRegion) continue
      if (!willFight(q, false, f)) continue
      if (!(atk.atkFakes || []).includes(q.name)) { atk.atkFakes.push(q.name); cnt++ }
    }
    if (!cnt) continue
    recordDiplomacyAid(f, sid, atk.atkSect, now)
    initWarState(f, atk)
    await recordCoalition(f, gid, atk, sid)
    const info = atk.coalition[sid] || { count: 0, power: 0 }
    atkLog(atk, `【驰援】盟军【${sectName(f, sid)}】派 ${info.count} 人（战力${info.power}）助阵`, now)
    logEvent(f, 'attack', `【驰援】${sectName(f, sid)} 盟军派 ${info.count} 人助 ${sectName(f, atk.atkSect)} 攻打${warTargetTxt(f, atk)}！`, now)
  }
}

