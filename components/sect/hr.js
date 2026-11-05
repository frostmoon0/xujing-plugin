import { admitSectNpc, sectOccupancy } from './capacity.js'
/* 由 sect_system.js 拆分自动生成: hr.js */
import fs from 'fs'
import { Save_Path } from '../plugin.js'
import { getFake, saveFake, sectName, sectIdByName, sectAlive, sectCap, addPerson, removeFromSectMap, fakeJoinSect, sectVitality, sectStability, traitFlavor, logEvent, POS, drawName, personPower } from '../fake_data.js'
import { levelNameOf } from '../world_data.js'
import { absoluteWinRate } from '../fight.js'
import { playerLevel, playerPower, applyInjury, rand, clamp, CFG, posCnOf } from './utils.js'

/** 玩家所在宗门某设施等级(修炼/突破/挂机加成用; 0=无设施) */
export function getFacilityLevel (gid, uid, fac) {
  try {
    /* 无该群存档直接返回0, 避免在未启用天下大事的群意外创建 fake 档 */
    const file = `${Save_Path}/world/fake_${String(gid || '')}.json`
    if (!fs.existsSync(file)) return 0
    const f = getFake(gid)
    const p = f.players && f.players[String(uid)]
    if (!p) return 0
    const s = f.sects[p.sect]
    if (!s || !s.facilities) return 0
    return s.facilities[fac] || 0
  } catch (err) { return 0 }
}


export function playerLeaveBanLeft (f, uid, sid, now = Date.now()) {
  const all = f.sectLeaveBans || (f.sectLeaveBans = {})
  const bans = all[String(uid)]
  if (!bans) return 0
  const until = Number(bans[sid]) || 0
  if (until > now) return until - now
  if (bans[sid]) delete bans[sid]
  if (!Object.keys(bans).length) delete all[String(uid)]
  return 0
}

/** 真实玩家主动退出：立即生效；仅对原宗门记录7天禁入，其他宗门不受影响 */
export function leavePlayerSect (f, gid, uid, now = Date.now()) {
  uid = String(uid)
  const p = f.players && f.players[uid]
  if (!p || !p.sect) return { ok: false, msg: '你当前没有加入宗门' }
  const sid = p.sect
  const s = f.sects && f.sects[sid]
  const oldName = s ? s.name : '原宗门'
  /* 宗主退出时：有其他玩家则自动交给最早入宗者；否则取消玩家宗主标记，宗门继续按世界宗门运行 */
  if (p.pos === 'zongzhu' && s && String(s.owner) === uid) {
    const successors = Object.entries(f.players || {})
      .filter(([id, x]) => id !== uid && x && x.sect === sid)
      .sort((a, b) => (a[1].joinAt || 0) - (b[1].joinAt || 0))
    if (successors.length) {
      const [nextUid, next] = successors[0]
      next.pos = 'zongzhu'
      s.owner = nextUid
      logEvent(f, 'promote', `【继任】🌙 ${p.name} 退出【${oldName}】，${next.name} 自动继任宗主`, now, { major: true })
    } else {
      s.owner = null
      logEvent(f, 'leave', `【退宗】🌙 宗主 ${p.name} 退出【${oldName}】，宗门改由江湖自行运转`, now, { major: true })
    }
  }
  /* 退出者不再占用任何在途攻守名额 */
  for (const atk of (f.sectAttacks || [])) {
    if (atk.phase === 'done') continue
    for (const key of ['atkPlayers', 'defPlayers']) {
      if (Array.isArray(atk[key])) atk[key] = atk[key].filter(x => String(x) !== uid)
    }
  }
  delete f.players[uid]
  if (!f.sectLeaveBans) f.sectLeaveBans = {}
  if (!f.sectLeaveBans[uid]) f.sectLeaveBans[uid] = {}
  f.sectLeaveBans[uid][sid] = now + 7 * 86400000
  logEvent(f, 'leave', `【退宗】🌙 玩家 ${p.name} 退出【${oldName}】；7天内不得再回原宗，但可立即加入其他宗门`, now)
  saveFake(f, gid)
  return { ok: true, msg: `✅ 你已退出【${oldName}】。原宗门 7 天内不可再加入；其他宗门可立即加入` }
}

/** 真实玩家加入宗门：只拦截退出后7天内回到原宗门，其他宗门可立即加入 */
export function joinPlayerSect (f, gid, uid, name, sectNameArg, now = Date.now()) {
  uid = String(uid)
  if (f.players && f.players[uid]) return { ok: false, msg: '你已有宗门，请先 #退出宗门' }
  const sid = sectIdByName(f, String(sectNameArg || '').trim())
  if (!sid) return { ok: false, msg: `没有找到宗门【${sectNameArg || ''}】，请先 #天下宗门 查看` }
  const s = f.sects && f.sects[sid]
  if (!s || s.wipeAt) return { ok: false, msg: '该宗门已覆灭，无法加入' }
  const left = playerLeaveBanLeft(f, uid, sid, now)
  if (left > 0) return { ok: false, msg: `你退出【${s.name}】后仍在禁入期，还需 ${Math.ceil(left / 86400000)} 天；可立即加入其他宗门` }
  if (sectOccupancy(f, sid) >= sectCap(f, sid)) return { ok: false, msg: '宗门已满员，无法加入' }
  if (!f.players) f.players = {}
  f.players[uid] = { name: name || uid, sect: sid, pos: 'dizi', joinAt: now, contribution: 0 }
  logEvent(f, 'join', `【入宗】🌙 玩家 ${name || uid} 拜入【${s.name}】为弟子`, now, { major: true })
  saveFake(f, gid)
  return { ok: true, msg: `🏯 你已拜入【${s.name}】为弟子！` }
}

/* ---------- 任命/传位/问退位/夺权 ---------- */
/** 职位晋升所需入宗天数: 执事3 / 副宗7 / 太上·宗主15 (防跳槽速成高层; 仅限玩家, 伪玩家不受此限) */
export const DAYS_NEED = { zhishi: 3, fuzong: 7, taishang: 15, zongzhu: 15 }

/** 玩家本次入宗天数(入宗 joinAt 起算) */
export function sectDays (f, uid) {
  const p = f.players && f.players[String(uid)]
  if (!p || !p.joinAt) return 0
  return Math.floor((Date.now() - p.joinAt) / 86400000)
}

/** 入宗天数门槛校验: 晋升/当宗主都要求入宗满一定天数 */
export function chkSectDays (f, uid, toPos) {
  const need = DAYS_NEED[toPos]
  if (!need) return { ok: true }
  const d = sectDays(f, uid)
  if (d < need) {
    const cn = (CFG.PROMO[toPos] && CFG.PROMO[toPos].cn) || toPos
    return { ok: false, msg: `${cn}需入宗满 ${need} 天（你本次入宗仅 ${d} 天）` }
  }
  return { ok: true }
}

export async function canPromote (gid, f, uid, toPos) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '对方不是宗门成员' }
  const need = CFG.PROMO[toPos]
  if (!need) return { ok: false, msg: '职位不存在' }
  const dchk = chkSectDays(f, uid, toPos)
  if (!dchk.ok) return { ok: false, msg: dchk.msg }
  if ((p.contribution || 0) < need.contrib) return { ok: false, msg: `${need.cn}需贡献 ≥ ${need.contrib}（当前 ${p.contribution || 0}）` }
  if (need.level) {
    const lv = await playerLevel(gid, uid)
    if (lv < need.level) return { ok: false, msg: `${need.cn}需修为 ≥ ${levelNameOf(need.level)}（当前 ${levelNameOf(lv)}）` }
  }
  return { ok: true }
}

export async function appointTo (f, gid, fromUid, targetUid, toPos) {
  const me = f.players[String(fromUid)]
  if (!me) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[me.sect]
  if (!s) return { ok: false, msg: '宗门不存在' }
  if (me.pos !== 'zongzhu') return { ok: false, msg: '只有宗主可以任命' }
  const tp = f.players[String(targetUid)]
  if (!tp || tp.sect !== me.sect) return { ok: false, msg: '对方不是你宗门成员' }
  const posCn = { zhishi: '执事', fuzong: '副宗主', taishang: '太上长老' }[toPos]
  if (!posCn) return { ok: false, msg: '可任命：执事 / 副宗主 / 太上长老' }
  if (toPos === 'fuzong') {
    const cnt = Object.values(f.players || {}).filter(x => x && x.sect === me.sect && x.pos === 'fuzong').length
    if (cnt >= 2) return { ok: false, msg: '副宗主已满（2人）' }
  }
  if (toPos === 'zhishi') {
    const cap = (s.facilities && s.facilities.yanwu >= 3) ? 5 : 3
    const cnt = Object.values(f.players || {}).filter(x => x && x.sect === me.sect && x.pos === 'zhishi').length
    if (cnt >= cap) return { ok: false, msg: `执事已满（${cap}人，演武场≥3级可扩至5人）` }
  }
  if (toPos === 'taishang') {
    const taiCount = Object.values(f.players || {}).filter(x => x && x.sect === me.sect && x.pos === 'taishang').length +
      ((f.sectMap[me.sect] && f.sectMap[me.sect].taishang) || []).length
    if (taiCount >= POS.taishang.max) return { ok: false, msg: '太上长老席位已满（2席，玩家与伪玩家共享）' }
  }
  /* 入宗天数门槛(被任命者): 宗主任命 太上/副宗主 不用等时间; 执事任命与 #晋升 自然晋升(autoPromote)仍要时间(防跳槽速成高层) */
  if (toPos !== 'taishang' && toPos !== 'fuzong') {
    const dchk = chkSectDays(f, targetUid, toPos)
    if (!dchk.ok) return { ok: false, msg: dchk.msg }
  }
  /* 玩家宗主可直接任命, 任命权不与副宗主/太上共享 */
  tp.pos = toPos
  saveFake(f, gid)
  logEvent(f, 'promote', `【任命】🌙 玩家 ${me.name} 任命 ${tp.name} 为${posCn}`)
  return { ok: true, msg: `✅ 已任命 ${tp.name} 为${posCn}` }
}

/** 伪玩家宗主宗门: 玩家满足条件后自动晋升(相当于伪玩家宗主认可) */
export async function autoPromote (f, gid, uid, toPos) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[p.sect]
  if (!s) return { ok: false, msg: '宗门不存在' }
  if (s.owner) return { ok: false, msg: '现任宗主是玩家，请宗主 #任命 晋升' }
  const sm = f.sectMap[p.sect] || {}
  if (!sm.zongzhu) return { ok: false, msg: '宗主空缺，无法晋升' }
  const posCn = { zhishi: '执事', fuzong: '副宗主', taishang: '太上长老' }[toPos]
  if (!posCn) return { ok: false, msg: '可晋升：执事 / 副宗主 / 太上长老' }
  /* 职位人数上限(与任命一致) */
  if (toPos === 'fuzong') {
    const cnt = Object.values(f.players || {}).filter(x => x && x.sect === p.sect && x.pos === 'fuzong').length
    if (cnt >= 2) return { ok: false, msg: '副宗主已满（2人）' }
  }
  if (toPos === 'zhishi') {
    const cap = (s.facilities && s.facilities.yanwu >= 3) ? 5 : 3
    const cnt = Object.values(f.players || {}).filter(x => x && x.sect === p.sect && x.pos === 'zhishi').length
    if (cnt >= cap) return { ok: false, msg: `执事已满（${cap}人，演武场≥3级可扩至5人）` }
  }
  if (toPos === 'taishang') {
    const taiCount = Object.values(f.players || {}).filter(x => x && x.sect === p.sect && x.pos === 'taishang').length +
      ((f.sectMap[p.sect] && f.sectMap[p.sect].taishang) || []).length
    if (taiCount >= POS.taishang.max) return { ok: false, msg: '太上长老席位已满（2席，玩家与伪玩家共享）' }
  }
  const chk = await canPromote(gid, f, uid, toPos)
  if (!chk.ok) return { ok: false, msg: chk.msg }
  p.pos = toPos
  saveFake(f, gid)
  logEvent(f, 'promote', `【晋升】🌙 ${p.name} 在【${sectName(f, p.sect)}】表现出众，被擢升为${posCn}！`)
  return { ok: true, msg: `✅ 你已晋升为${posCn}！` }
}

export function abdicateTo (f, gid, fromUid, targetUid) {
  const me = f.players[String(fromUid)]
  if (!me || me.pos !== 'zongzhu') return { ok: false, msg: '只有宗主可以传位' }
  const tp = f.players[String(targetUid)]
  if (!tp || tp.sect !== me.sect) return { ok: false, msg: '对方不是你宗门成员' }
  const dchk = chkSectDays(f, targetUid, 'zongzhu')
  if (!dchk.ok) return { ok: false, msg: dchk.msg }
  tp.pos = 'zongzhu'
  me.pos = 'dizi'
  const s = f.sects[me.sect]
  s.owner = String(targetUid)
  logEvent(f, 'promote', `【传位】🌙 玩家 ${me.name} 将【${sectName(f, me.sect)}】宗主之位传给 ${tp.name}`, Date.now(), { major: true })
  saveFake(f, gid)
  return { ok: true, msg: `🏯 你已将宗主之位传给 ${tp.name}，自任弟子` }
}

export async function askAbdicate (f, gid, uid) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[p.sect]
  if (s.owner) return { ok: false, msg: '现任宗主是玩家，无需问退位（可 #传位）' }
  const dchk = chkSectDays(f, uid, 'zongzhu')
  if (!dchk.ok) return { ok: false, msg: dchk.msg }
  const zzName = f.sectMap[p.sect] && f.sectMap[p.sect].zongzhu
  const zz = zzName ? f.roster[zzName] : null
  if (!zz || !zz.alive) return { ok: false, msg: '宗主空缺，无需问退位' }
  const myLv = await playerLevel(gid, uid)
  const zzLv = Number(zz.level) || 0
  let prob = 0.25
  if (zz.trait === '平和' || zz.trait === '善良') prob += 0.2
  if (zzLv < 20) prob += 0.15
  if (myLv >= zzLv) prob += 0.3
  if (myLv >= zzLv + 4) prob += 0.2
  const ok = Math.random() < prob
  if (ok) {
    s.owner = String(uid)
    p.pos = 'zongzhu'
    removeFromSectMap(f, p.sect, zzName)
    zz.status = 'scatter'
    zz.sect = null
    zz.pos = null
    logEvent(f, 'promote', `【禅让】🌙 ${zzName} 见 ${p.name} 资质出众，禅让宗主之位！`, Date.now(), { major: true })
    saveFake(f, gid)
    return { ok: true, msg: `🏯 ${zzName} 见你资质出众，将宗主之位禅让于你！你成为【${sectName(f, p.sect)}】宗主` }
  }
  return { ok: false, msg: `${zzName} 拒绝了你的请求（性格${zz.trait}，修为高深），24小时后再试` }
}

/** 玩家是否还在群里(退群/失联则不在; 查询失败保守视为在群, 不误夺权) */
export async function playerInGroup (gid, uid) {
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.getMemberMap) {
      const mm = await g.getMemberMap()
      for (const m of mm) {
        if (String(m[1].user_id) === String(uid)) return true
      }
      return false
    }
  } catch (err) { }
  return true
}

export async function seizePower (f, gid, uid) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[p.sect]
  if (!s) return { ok: false, msg: '宗门不存在' }
  /* 现任宗主是玩家: 若其已不在群里(退群/失联), 宗门成员可直接夺权继任(无任何条件, 直接变宗主) */
  if (s.owner) {
    if (!(await playerInGroup(gid, s.owner))) {
      const oldOwner = s.owner
      const op = f.players[oldOwner]
      const oldName = op && op.name ? op.name : '原宗主'
      s.owner = String(uid)
      p.pos = 'zongzhu'
      if (op && op.sect === p.sect) op.pos = 'dizi' /* 原宗主降为弟子(已不在群) */
      logEvent(f, 'promote', `【夺权】🌙 ${p.name} 见宗主 ${oldName} 久不在群，强势夺权继任【${sectName(f, p.sect)}】宗主！`, Date.now(), { major: true })
      saveFake(f, gid)
      return { ok: true, msg: `⚔️ 原宗主已不在群中，你直接夺权继任【${sectName(f, p.sect)}】宗主！` }
    }
    return { ok: false, msg: '现任宗主是玩家，不能夺权（可 #传位）' }
  }
  const dchk = chkSectDays(f, uid, 'zongzhu')
  if (!dchk.ok) return { ok: false, msg: dchk.msg }
  if ((p.contribution || 0) < 300) return { ok: false, msg: `夺权需贡献 ≥ 300（当前 ${p.contribution || 0}）` }
  const zzName = f.sectMap[p.sect] && f.sectMap[p.sect].zongzhu
  const zz = zzName ? f.roster[zzName] : null
  if (!zz || !zz.alive) return { ok: false, msg: '宗主空缺，无需夺权' }
  const myPw = await playerPower(f, gid, uid)
  const zzPw = personPower(zz)
  if (myPw < zzPw * 1.2) return { ok: false, msg: `你战力不足（需 ≥ 宗主×1.2：${Math.ceil(zzPw * 1.2)}，当前 ${myPw}）` }
  const rate = absoluteWinRate(myPw, zzPw * 1.2, 5) / 100
  const ok = Math.random() < rate
  if (ok) {
    s.owner = String(uid)
    p.pos = 'zongzhu'
    removeFromSectMap(f, p.sect, zzName)
    zz.status = 'scatter'
    zz.sect = null
    zz.pos = null
    logEvent(f, 'promote', `【夺权】🌙 ${p.name} 强势夺权，取代${zzName}成为【${sectName(f, p.sect)}】宗主！`, Date.now(), { major: true })
    saveFake(f, gid)
    return { ok: true, msg: `⚔️ 夺权成功！你击败 ${zzName}，继任【${sectName(f, p.sect)}】宗主！` }
  }
  applyInjury(f, uid, rand([1, 2]))
  saveFake(f, gid)
  return { ok: false, msg: `夺权失败！你被 ${zzName} 击败（轻伤），来日再战` }
}


/* ---------- 综合推进(每分钟, 由 fakeTick 调用) ---------- */
/** 每小时@玩家宗主: 有散修想加入宗门(待审批的累积申请) */
export function notifyJoinReqs (f, gid, now = Date.now()) {
  try {
    const reqs = f.sectJoinReqs || {}
    for (const sid of Object.keys(reqs)) {
      const list = reqs[sid]
      if (!Array.isArray(list) || !list.length) continue
      const s = f.sects[sid]
      if (!s || !s.owner) continue
      const last = (f.sectJoinNotify && f.sectJoinNotify[sid]) || 0
      if (now - last < 3600000) continue // 1小时最多@一次
      f.sectJoinNotify = f.sectJoinNotify || {}
      f.sectJoinNotify[sid] = now
      const names = list.map(x => x && x.name).filter(Boolean)
      if (!names.length) continue
      const g = Bot.pickGroup(gid)
      if (g && g.sendMsg) {
        g.sendMsg([segment.at(Number(s.owner)), `\n🏯【入宗申请】${names.length} 名散修想拜入【${s.name}】：${names.join('、')}\n回复 #同意入宗 全部接纳；#同意入宗 名字 单独接纳；#拒绝入宗 婉拒`])
      }
    }
  } catch (err) { }
}

/** 玩家宗主处理散修入宗申请: accept=true 接纳(指定名字/全部), false 婉拒 */
export function answerSectJoin (f, gid, uid, accept, nameArg) {
  const p = f.players && f.players[String(uid)]
  if (!p || !['zongzhu', 'fuzong', 'taishang'].includes(p.pos)) return { ok: false, msg: '只有宗主/副宗主/太上长老可以处理入宗申请' }
  const sid = p.sect
  const s = f.sects[sid]
  if (!s || !s.owner) return { ok: false, msg: '只有玩家宗门核心职位可以处理入宗申请' }
  const reqs = f.sectJoinReqs || {}
  const list = (reqs[sid] || []).filter(x => x && x.name)
  if (!list.length) return { ok: false, msg: '当前没有待审批的散修入宗申请' }
  let matched = list
  const arg = String(nameArg || '').trim()
  if (arg && arg !== '全部') {
    const exact = list.filter(x => x.name === arg)
    const partial = !exact.length ? list.filter(x => x.name.includes(arg)) : []
    if (!exact.length && partial.length > 1) return { ok: false, msg: `找到多个名字匹配，请发送完整名字（当前待审批：${list.map(x => x.name).join('、')}）` }
    if (exact.length) matched = exact
    else if (partial.length === 1) matched = partial
    else return { ok: false, msg: `没有找到叫「${arg}」的入宗申请（当前待审批：${list.map(x => x.name).join('、')}）` }
  }
  const names = matched.map(x => x.name)
  const remain = list.filter(x => !matched.includes(x))
  const now = Date.now()
  if (accept) {
    const cap = Math.max(0, sectCap(f, sid) - sectOccupancy(f, sid))
    const accepted = cap > 0 ? names.slice(0, cap) : []
    if (!accepted.length) {
      reqs[sid] = remain
      saveFake(f, gid)
      return { ok: false, msg: `【${s.name}】已满员（${sectCap(f, sid)}人），无法接纳` }
    }
    for (const n of accepted) {
      const np = f.roster[n]
      if (np && np.alive && np.sect) continue // 已被其他宗门收走则跳过
      if (np && np.alive && np.status === 'scatter') {
        /* 散修转正: 直接收入本宗为弟子 */
        if (!admitSectNpc(f, np, sid)) continue
        // 收编任职不改变NPC实际修为。
        if (f.sectMap[sid] && !f.sectMap[sid].dizi.includes(n)) f.sectMap[sid].dizi.push(n)
      } else {
        addPerson(f, n, sid, 'dizi', 1)
      }
    }
    reqs[sid] = remain.concat(names.slice(accepted.length).map(n => ({ name: n, wantAt: now })))
    logEvent(f, 'join', `【收编】🌙 玩家宗主 ${p.name} 接纳散修 ${accepted.join('、')} 拜入【${s.name}】`)
    saveFake(f, gid)
    return { ok: true, msg: `✅ 已接纳 ${accepted.join('、')} 拜入【${s.name}】！${names.length > accepted.length ? `（${names.length - accepted.length} 人因满员暂缓）` : ''}` }
  } else {
    reqs[sid] = remain
    logEvent(f, 'join', `【婉拒】🌙 玩家宗主 ${p.name} 婉拒散修 ${names.join('、')} 入宗`)
    saveFake(f, gid)
    return { ok: true, msg: `你已婉拒 ${names.join('、')} 的入宗申请` }
  }
}

/** 玩家宗主/副宗 踢伪玩家弟子出宗: 转散修 + 2天内不主动入宗; 好斗/嗜杀/魔修被逐怀恨在心与旧门结仇 */
export function kickFakeFromSect (f, gid, sid, name, now = Date.now()) {
  const p = f.roster[name]
  if (!p || !p.alive) return { ok: false, msg: '查无此人' }
  if (p.sect !== sid || p.status !== 'sect') return { ok: false, msg: '对方不是你宗门弟子' }
  const sname = sectName(f, sid)
  removeFromSectMap(f, sid, name)
  p.status = 'scatter'; p.sect = null; p.pos = null
  if (!f.kickBans) f.kickBans = {}
  f.kickBans[name] = now + 2 * 86400000 // 2天内不主动入宗
  /* 性格: 好斗/嗜杀/魔修被逐 → 怀恨在心, 与旧日同门结仇(以后自动避开此宗) */
  const vengeful = p.trait === '好斗' || p.trait === '嗜杀' || p.path === '魔道'
  if (vengeful) {
    if (!p.relations) p.relations = {}
    if (!p.relations.enemies) p.relations.enemies = []
    for (const x of sectAlive(f, sid)) {
      if (!p.relations.enemies.includes(x.name)) p.relations.enemies.push(x.name)
    }
    logEvent(f, 'leave', `【结怨】${sname} 将弟子 ${name} 逐出宗门，${name} 怀恨在心，与旧日同门结下仇怨`, now)
  } else {
    logEvent(f, 'leave', `【逐出】${sname} 将弟子 ${name} 逐出宗门，2日内不得再入`, now)
  }
  saveFake(f, gid)
  return { ok: true, msg: `🗡️ 已将 ${name} 逐出【${sname}】${vengeful ? '，其怀恨在心' : ''}，2天内不能主动入宗` }
}

/** 玩家宗主/副宗 招揽散修伪玩家入宗(名字精确/模糊匹配) */
export function recruitFakeToSect (f, gid, sid, nameArg) {
  const arg = String(nameArg || '').trim()
  if (!arg) return { ok: false, msg: '用法：#拉人入宗 [伪玩家名]（散修或其它宗门弟子均可招揽）' }
  const s = f.sects[sid]
  if (!s) return { ok: false, msg: '宗门不存在' }
  if (sectOccupancy(f, sid) >= sectCap(f, sid)) return { ok: false, msg: `【${s.name}】已满员（${sectCap(f, sid)}人），无法招人` }
  const now = Date.now()
  const sc = Object.values(f.roster).filter(p => p.alive && p.status === 'scatter')
  const exact = sc.filter(p => p.name === arg)
  const cand = exact.length ? exact : sc.filter(p => p.name.includes(arg))
  if (!cand.length) return { ok: false, msg: `没有找到叫「${arg}」的散修（#天下宗门 看名单）` }
  if (cand.length > 1 && !exact.length) return { ok: false, msg: `找到多个名字匹配，请发送完整名字（${cand.slice(0, 5).map(p => p.name).join('、')}…）` }
  const p = cand[0]
  /* 宗门里有仇人 → 不愿入宗 */
  const enemies = new Set((p.relations && p.relations.enemies) || [])
  if (enemies.size && sectAlive(f, sid).some(x => enemies.has(x.name))) {
    return { ok: false, msg: `${p.name} 与【${s.name}】中有人有仇，不愿入宗` }
  }
  /* 性格接受度: 温和/勤恳高, 魔修/贪玩/懒散低 */
  const accT = { 善良: 0.85, 平和: 0.85, 好斗: 0.6, 嗜杀: 0.35 }[p.trait] ?? 0.7
  const accA = { 苦修: 1.2, 勤勉: 1.1, 普通: 1, 懒散: 0.5, 贪玩: 0.4 }[p.act] ?? 1
  const acc = accT * accA * (p.path === '魔道' ? 0.5 : 1)
  if (Math.random() > acc) {
    return { ok: false, msg: `${p.name}（${p.trait}·${p.act}${p.path === '魔道' ? '·魔修' : ''}）婉拒了你的招揽，不愿入宗` }
  }
  const ev = fakeJoinSect(f, p.name, sid)
  if (!ev) return { ok: false, msg: `${p.name} 无法入宗（已满员/已有宗门）` }
  logEvent(f, 'join', `【招揽】🌙 玩家宗主招揽散修 ${p.name} 拜入【${s.name}】`)
  saveFake(f, gid)
  return { ok: true, msg: `🎉 已招揽散修 ${p.name} 拜入【${s.name}】` }
}

/** 玩家宗主/副宗 挖角他宗弟子: 成功率按 忠诚度×性格×羁绊×宗门兴衰×新老弟子 */
export function poachFakeFromSect (f, gid, sid, nameArg) {
  const arg = String(nameArg || '').trim()
  if (!arg) return { ok: false, msg: '用法：#挖角 [伪玩家名]（挖其他宗门弟子；招散修用 #拉人入宗）' }
  const s = f.sects[sid]
  if (!s) return { ok: false, msg: '宗门不存在' }
  if (sectOccupancy(f, sid) >= sectCap(f, sid)) return { ok: false, msg: `【${s.name}】已满员（${sectCap(f, sid)}人），无法收人` }
  const now = Date.now()
  /* 目标: 其他宗门在世成员(宗主/太上不挖: 一宗之魂挖不动; 副宗位高但非根基, 忠诚极低才可能被挖——凡事不绝对), 自家不挖 */
  const all = Object.values(f.roster).filter(p => p.alive && p.status === 'sect' && p.sect !== sid && p.pos !== 'zongzhu' && p.pos !== 'taishang')
  const exact = all.filter(p => p.name === arg)
  const cand = exact.length ? exact : all.filter(p => p.name.includes(arg))
  if (!cand.length) return { ok: false, msg: `没有找到叫「${arg}」的他宗弟子（#天下宗门 看名单；宗主/太上不挖）` }
  if (cand.length > 1 && !exact.length) return { ok: false, msg: `找到多个名字匹配，请发送完整名字（${cand.slice(0, 5).map(p => p.name).join('、')}…）` }
  const p = cand[0]
  const oldSid = p.sect
  const oldName = sectName(f, oldSid)
  /* 灭门仇家/仇人在本宗 → 不愿入 */
  const enemies = new Set((p.relations && p.relations.enemies) || [])
  if (enemies.size && sectAlive(f, sid).some(x => enemies.has(x.name))) {
    return { ok: false, msg: `${p.name} 与【${s.name}】中有人有仇，不愿加入` }
  }
  /* 基础: 忠诚度越低越容易被挖 (100-忠诚)/100 */
  const loy = Number(p.loyalty) >= 0 ? (p.loyalty || 0) : 60
  /* 副宗身份: 身居高位, 忠诚≥40 根本挖不动; 仅忠诚极低(离心)才可能被挖, 且仍有额外难度(×0.4) */
  let chance
  if (p.pos === 'fuzong') {
    if (loy >= 40) return { ok: false, msg: `${p.name} 身为【${oldName}】副宗主，身居高位，婉拒了你的挖角` }
    chance = (100 - loy) / 100 * 0.4
  } else {
    chance = (100 - loy) / 100
  }
  /* 性格: 好斗/贪玩/魔修容易被前程打动; 苦修/平和/善良难挖 */
  const tMul = { 好斗: 1.35, 嗜杀: 1.2, 善良: 0.55, 平和: 0.6 }[p.trait] ?? 1
  const aMul = { 苦修: 0.5, 勤勉: 0.8, 普通: 1, 懒散: 1.2, 贪玩: 1.35 }[p.act] ?? 1
  chance *= tMul * aMul * (p.path === '魔道' ? 1.3 : 1)
  /* 同宗羁绊: 有羁绊难挖(×0.4) */
  const r = p.relations || {}
  const bonded = [].concat(r.master ? [r.master] : [], r.spouse ? [r.spouse] : [], r.confidants || [], r.siblings || [], r.disciples || [], r.friends || [])
    .some(n => f.roster[n] && f.roster[n].alive && f.roster[n].sect === oldSid)
  if (bonded) chance *= 0.4
  /* 新弟子(<48h)还没扎根: 容易挖(×1.2) */
  if (now - (p.joinAt || now) < 48 * 3600000) chance *= 1.2
  /* 宗门兴衰: 旧宗兴旺难挖(×0.6), 衰落好挖(×1.5); 我方兴旺更有吸引力(×1.2) */
  chance *= sectStability(f, oldSid)
  const myV = sectVitality(f, sid)
  chance *= myV >= 60 ? 1.2 : (myV <= 25 ? 0.7 : 1)
  if (Math.random() > Math.min(0.95, chance)) {
    return { ok: false, msg: `${p.name}（${p.trait}·${p.act}）${traitFlavor(p)}，婉拒了你的挖角，对【${oldName}】忠心耿耿` }
  }
  /* 成功: 脱离旧宗入本宗为弟子(忠诚减半重新开始) */
  removeFromSectMap(f, oldSid, p.name)
  if (!admitSectNpc(f, p, sid)) return { ok: false, msg: '宗门已满员，无法接纳' }
  // 收编任职不改变NPC实际修为。
  p.joinAt = now
  p.loyalty = Math.max(10, Math.round(loy * 0.5))
  if (f.sectMap[sid] && !f.sectMap[sid].dizi.includes(p.name)) f.sectMap[sid].dizi.push(p.name)
  /* 被挖者与旧宗结怨(性格) */
  const vengeful = p.trait === '好斗' || p.trait === '嗜杀' || p.path === '魔道'
  if (vengeful) {
    if (!p.relations) p.relations = {}
    if (!p.relations.enemies) p.relations.enemies = []
    for (const x of sectAlive(f, oldSid)) {
      if (!p.relations.enemies.includes(x.name)) p.relations.enemies.push(x.name)
    }
    logEvent(f, 'betray', `【挖角】${p.name} 被挖角离开【${oldName}】转投【${s.name}】，${traitFlavor(p)}，与旧日同门结下仇怨`, now, { who: [p.name], sect: sid })
  } else {
    logEvent(f, 'betray', `【挖角】${p.name} 被【${s.name}】许以重利挖走，离开【${oldName}】转投新宗`, now, { who: [p.name], sect: sid })
  }
  saveFake(f, gid)
  return { ok: true, msg: `🎯 成功挖角！${p.name}（${p.trait}·${p.act}）离开【${oldName}】，拜入【${s.name}】为弟子${vengeful ? '（与旧宗结怨）' : ''}` }
}
