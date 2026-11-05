/** 指令与数字菜单共用业务入口；调用者持有 withFakeLock，选项只保存固定编号。 */
import { sectName, sectIdByName, sectAlive, saveFake, personPower } from '../fake_data.js'
import { getWorld, getLoc, REGIONS, regionNameOf } from '../world_data.js'
import { CFG, getVault, regionOfArea, sectRegion, playerPower, warTargetTxt, atkLog } from './utils.js'
import { ATK_KINDS, startSectAttack, startRogueAttack, rogueTeamOf, respondDefend, joinSectFight, quitRogueParticipation, joinRogueParticipation, sectForceAdjust, sectServantRally, abortSectAttack, computeAtkPower, computeDefPower, notifyDefender } from './war.js'
import { declareWar, makePeace, allyAssist } from './diplomacy.js'
import { handleCaptives, pendingCaptivesForSect } from './captive.js'
import { defenderOf, warActorOwner, initWarState, syncWarClock } from './war_state.js'
import { planWarDeployment } from './war_roster.js'

export const CAPTIVE_ACTIONS = ['全杀', '搜刮再杀', '全放', '搜刮再放', '收编', '关天牢', '送矿山']
const aliases = { 攻: '参战', 宗门攻打: '攻打', 攻打宗门: '攻打', 宗门宣战: '宣战', 添兵: '派兵', 宗门驰援: '派兵', 驰援功法: '派兵', 驰援: '派兵', 仆从集结: '集结仆从', 盟友驰援: '盟友助战', 驰援盟友: '盟友助战', 驰援帮忙: '盟友助战', 罢兵: '议和', 终止攻打: '撤退', 停止攻打: '撤退', 收兵: '撤退', 撤军: '撤退', 退出参战: '退战', 退出攻打: '退战', 退出战斗: '退战', 退出防守: '退战', 退出守御: '退战', 参与攻打: '参战', 加入攻打: '参战', 宗门防守: '参战', 加入防守: '参战' }
export const WAR_VERBS = [...new Set(['攻打预估', '宗门兵力', '防守策略', '战法', '守', '不守', '参战', '退战', '派兵', '减兵', '撤兵', '集结仆从', '盟友助战', '撤退', '宣战', '议和', '同意议和', '拒绝议和', '处置俘虏', '攻打', ...Object.keys(aliases)])].sort((a, b) => b.length - a.length)

export function parseWarCommand (msg) {
  const raw = String(msg || '').replace(/^[#＃]/, '').trim().replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
  const verb = WAR_VERBS.find(v => raw.startsWith(v))
  if (!verb) return null
  const args = raw.slice(verb.length).trim().split(/\s+/).filter(Boolean)
  return { verb: aliases[verb] || (verb === '撤兵' ? (args.length ? '减兵' : '撤退') : verb), args }
}

export function isWarCommander (f, uid) {
  const p = f.players?.[String(uid)]
  return !!(p && f.sects?.[p.sect] && ['zongzhu', 'fuzong', 'taishang'].includes(p.pos))
}

function menu (kind, title, options, extra = {}) {
  if (!options.length) return { ok: false, msg: '当前没有可选目标或战事' }
  return { ok: true, menu: { kind, options, ...extra }, msg: `${title}\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n回复数字选择，0 取消（5分钟内有效）。` }
}

function relatedWars (f, uid, verb) {
  const p = f.players?.[String(uid)]
  return (f.sectAttacks || []).filter(a => ['prep', 'fight'].includes(a.phase)).filter(a => {
    if (verb === '退战') return [...(a.atkPlayers || []), ...(a.defPlayers || [])].includes(String(uid))
    if (verb === '盟友助战') return p && (f.sects[p.sect]?.allies || []).includes(a.atkSect) && defenderOf(f, a) !== p.sect
    if (verb === '守') return p && defenderOf(f, a) === p.sect
    if (verb === '不守') return p && defenderOf(f, a) === p.sect && a.phase === 'prep' && !a.defenderDecided
    if (verb === '参战' && a.by === 'rogue' && String(rogueTeamOf(f, uid)?.leader) === String(a.rogue)) return true
    if (a.rogue === String(uid)) return verb === '撤退' || verb === '战法'
    if (!p) return false
    if (verb === '参战') return a.atkSect === p.sect || defenderOf(f, a) === p.sect || !!a.coalition?.[p.sect]
    return a.atkSect === p.sect || defenderOf(f, a) === p.sect || (verb !== '撤退' && verb !== '战法' && !!a.coalition?.[p.sect])
  })
}

function targetOptions (f, uid, verb) {
  const p = f.players?.[String(uid)]
  const party = rogueTeamOf(f, uid)
  const sects = Object.entries(f.sects || {}).filter(([id, s]) => !s.wipeAt && id !== p?.sect && sectAlive(f, id).length).map(([id, s]) => ({ value: s.name, sectId: id, label: `宗门【${s.name}】（${regionNameOf(s.region)}，攻破即灭门）` }))
  if (verb !== '攻打' && verb !== '攻打预估') return sects
  if (party || !p) return sects
  const areas = Object.values(REGIONS).flatMap(r => r.areas || []).filter(name => f.areas?.[name] !== p.sect).map(name => ({ value: name, label: `小区【${name}】（${sectName(f, f.areas?.[name]) || '无主'}）` }))
  return [...areas, ...sects]
}

export async function warPreview (f, gid, uid, target, count = 0) {
  // 预估不调用宣战，不吃丹、不消费、不创建战争。
  const copy = structuredClone(f)
  const p = copy.players?.[String(uid)]
  const area = regionOfArea(target)
  const sid = area ? null : sectIdByName(copy, target)
  if (!area && !sid) return { ok: false, msg: '目标不存在' }
  const region = area || sectRegion(copy, sid)
  const defSect = sid || copy.areas?.[target] || null
  const party = rogueTeamOf(copy, uid)
  const members = party?.members || (!p ? [String(uid)] : [])
  let cost = 0; let plan = { units: [], cost: 0 }; let power = 0
  if (members.length) {
    for (const id of members) if (!warActorOwner(copy, 'player', id) && getLoc(getWorld(gid), id) === region) power += await playerPower(copy, gid, id)
  } else {
    cost = CFG.ATK_BASE + (sectAlive(copy, p.sect).length + Object.values(copy.players || {}).filter(x => x?.sect === p.sect).length) * CFG.ATK_PER
    const tai = new Set(copy.sectMap?.[p.sect]?.taishang || [])
    plan = planWarDeployment(copy, gid, p.sect, region, sectAlive(copy, p.sect).filter(x => !tai.has(x.name)), count, null, Math.max(0, getVault(copy, p.sect).stones - cost))
    power = plan.units.reduce((sum, x) => sum + personPower(copy.roster[x.name]), 0)
  }
  const war = { id: 'preview', atkSect: members.length ? null : p?.sect, targetType: area ? 'area' : 'sect', target: area ? target : sid, defSect, atkFakes: [], atkPlayers: [], defFakes: [], defPlayers: [], moraleA: 100, moraleD: 100, bonus: 0, phase: 'prep' }
  if (defSect) {
    const guards = planWarDeployment(copy, gid, defSect, region, sectAlive(copy, defSect), 0)
    war.defFakes = guards.units.map(x => x.name)
    for (const unit of guards.units) copy.roster[unit.name].loc = region
  }
  war.atkFakes = plan.units.map(x => x.name)
  for (const unit of plan.units) copy.roster[unit.name].loc = region
  war.atkPlayers = members.filter(id => !warActorOwner(copy, 'player', id) && getLoc(getWorld(gid), id) === region)
  power = await computeAtkPower(copy, gid, war)
  const defense = await computeDefPower(copy, gid, war)
  const chance = power + defense > 0 ? Math.round(100 * power / (power + defense)) : 0
  return { ok: true, msg: `攻打预估：【${target}】\n可派门人 ${plan.units.length}，小队玩家 ${members.length}\n发起费 ${cost}、调兵费 ${plan.cost} 灵石\n攻方基础战力约 ${Math.round(power)}，守方按可调兵力估算约 ${defense}\n当前单轮优势约 ${chance}%（并非整场获胜率；丹药、援军、伤亡和战法会改变结果）。\n${area ? '攻占小区更换归属。' : '宗门总部被攻破即灭门。'}\n实际发起时重新检查冷却、位置、兵力和预算。` }
}

/** menuState 由数字选择带回；所有权限、战事与名单在这里再次检查。 */
async function runWarCommandUnlocked (f, gid, uid, command, menuState = null, nick = '玩家') {
  uid = String(uid)
  let { verb, args = [] } = command
  const p = f.players?.[uid]
  const guardOnly = verb === '守' && p && !isWarCommander(f, uid)
  if (guardOnly) verb = '参战'
  if (command.expectedSectId && sectIdByName(f, args[0]) !== command.expectedSectId) return { ok: false, msg: '菜单目标已改名或覆灭，请重新选择' }
  if (verb === '宗门兵力') {
    if (!p) return { ok: false, msg: '你不是宗门成员' }
    const rows = sectAlive(f, p.sect).map(q => `${q.name}：${warActorOwner(f, 'fake', q.name) ? `战场 #${warActorOwner(f, 'fake', q.name).id}` : q.realmBusy ? '秘境中' : q.fakeTravel ? '跨区在途' : '待命'}（${regionNameOf(q.loc || 'center')}）`)
    return { ok: true, msg: `【${sectName(f, p.sect)}】兵力\n${rows.join('\n') || '暂无门人'}\n真人成员须 #参战 自行报名。` }
  }
  if (verb === '攻打预估') {
    if (!args[0]) return menu('target', '选择预估目标', targetOptions(f, uid, verb), { verb })
    return warPreview(f, gid, uid, args[0], Number(args[1]) || 0)
  }
  if (['防守策略', '宣战', '议和', '同意议和', '拒绝议和', '处置俘虏', '守', '不守', '派兵', '减兵', '集结仆从', '盟友助战'].includes(verb) && !isWarCommander(f, uid)) return { ok: false, msg: '只有宗主/副宗主/太上长老可以下令' }
  if (verb === '防守策略') {
    if (!args[0]) return menu('policy', `当前策略：${f.sects[p.sect].defensePolicy || '稳守'}\n选择离线防守策略`, [{ value: '稳守', label: '稳守：无人回应时自动组织守军' }, { value: '保人', label: '保人：无人回应时弃守；总部被破仍灭门' }], { verb })
    if (!['稳守', '保人'].includes(args[0])) return { ok: false, msg: '防守策略可选：稳守 / 保人。' }
    f.sects[p.sect].defensePolicy = args[0]; saveFake(f, gid)
    return { ok: true, msg: `离线防守策略已设为【${args[0]}】。当前已决定的战事不变。` }
  }
  if (['攻打', '宣战', '议和', '同意议和', '拒绝议和'].includes(verb)) {
    if (!args[0]) return menu('target', `选择${verb}目标`, targetOptions(f, uid, verb), { verb })
    if (verb === '宣战') return declareWar(f, gid, p.sect, args[0])
    if (verb !== '攻打') return makePeace(f, gid, p.sect, args[0], verb === '同意议和' ? 'accept' : verb === '拒绝议和' ? 'reject' : 'offer')
    const party = rogueTeamOf(f, uid)
    if (!party && p && !isWarCommander(f, uid)) return { ok: false, msg: '只有宗门高层或玩家小队队长可以发起攻打' }
    const region = regionOfArea(args[0]) || sectRegion(f, sectIdByName(f, args[0]))
    if (region && getLoc(getWorld(gid), uid) !== region) return { ok: false, msg: `请先前往目标所在【${regionNameOf(region)}】` }
    const r = party || !p ? await startRogueAttack(f, gid, uid, args[0], nick) : await startSectAttack(f, gid, p.sect, args[0], 'player', { count: Number(args[1]) || 0 })
    if (r.ok) { try { await notifyDefender(f, gid, r.atk) } catch (err) {} }
    return r
  }
  if (verb === '处置俘虏') {
    let action = args.find(x => CAPTIVE_ACTIONS.includes(x) || x === '送往矿山')
    if (!action && /^\d+$/.test(args[0] || '')) action = CAPTIVE_ACTIONS[Number(args[0]) - 1]
    if (!action) {
      const pending = pendingCaptivesForSect(f, p.sect, true)
      if (!pending) return { ok: false, msg: '当前没有待处置俘虏' }
      return menu('captive', `战役 #${pending.atk.id} 俘虏：${[...pending.fakes, ...pending.players.map(id => f.players?.[id]?.name || id)].join('、')}`, CAPTIVE_ACTIONS.map(value => ({ value, label: value })), { verb, warId: pending.atk.id, sect: p.sect })
    }
    if (menuState?.sect && menuState.sect !== p.sect) return { ok: false, msg: '你的宗门身份已改变，请重新打开菜单' }
    const name = args.find(x => x !== action && !/^\d+$/.test(x)) || null
    return handleCaptives(f, gid, p.sect, action, name, false, uid, menuState?.warId)
  }
  const wars = relatedWars(f, uid, verb).filter(a => !guardOnly || defenderOf(f, a) === p.sect)
  const raw = menuState?.warId ?? args[0]
  let war = raw ? wars.find(a => String(a.id) === String(raw).replace(/^[#＃]/, '') || a.target === raw || a.snapshot?.target === raw || f.sects?.[a.target]?.name === raw) : null
  if (!war && raw) return { ok: false, msg: '该战事已结束或你没有相应权限，请重新选择' }
  if (!war) return menu('war', `选择${verb}的战场`, wars.map(a => ({ value: String(a.id), label: `#${a.id} ${warTargetTxt(f, a)}（${a.phase === 'prep' ? '准备期' : '交战中'}）` })), { verb })
  initWarState(f, war); syncWarClock(war)
  if (war.phase === 'prep' && Date.now() >= war.prepEnd && !(new Date().getHours() >= 1 && new Date().getHours() < 6)) return { ok: false, msg: '准备期已到，正在等待战场推进，请稍后再操作' }
  if (verb === '参战' && war.by === 'rogue') return joinRogueParticipation(f, gid, uid, String(war.id))
  if (verb === '参战') return joinSectFight(f, gid, uid, guardOnly ? 'def' : 'auto', false, String(war.id))
  if (verb === '退战' && war.by === 'rogue') return quitRogueParticipation(f, gid, uid, String(war.id))
  if (verb === '退战') return p ? joinSectFight(f, gid, uid, (war.atkPlayers || []).includes(uid) ? 'atk' : 'def', true, String(war.id)) : quitRogueParticipation(f, gid, uid, String(war.id))
  if (verb === '守' && (war.phase !== 'prep' || war.defenderDecided)) return joinSectFight(f, gid, uid, 'def', false, String(war.id))
  if (verb === '守' || verb === '不守') return respondDefend(f, gid, uid, verb === '守', String(war.id))
  if (verb === '撤退') {
    if (war.rogue !== uid && !isWarCommander(f, uid)) return { ok: false, msg: '只有本方宗门高层或小队队长可以下令撤退' }
    return abortSectAttack(f, gid, war, Date.now(), nick, defenderOf(f, war) === p?.sect ? 'def' : 'atk')
  }
  if (verb === '战法') {
    if ((war.atkSect !== p?.sect || !isWarCommander(f, uid)) && war.rogue !== uid) return { ok: false, msg: '只有进攻方宗门高层或小队队长可以选择战法' }
    if (war.phase !== 'prep') return { ok: false, msg: '开战后不能更改战法' }
    if (!args[1]) return menu('tactic', `战役 #${war.id}：选择战法`, ATK_KINDS.map(k => ({ value: k.key, label: `${k.key}（战力${k.bonus >= 0 ? '+' : ''}${Math.round(k.bonus * 100)}%${k.key === '两宗合围' ? '，需盟友实际参战' : ''}）` })), { verb, warId: war.id })
    const kind = ATK_KINDS.find(k => k.key === args[1])
    if (!kind) return { ok: false, msg: '没有这种战法' }
    if (kind.key === '两宗合围' && !Object.values(war.actors).some(a => a.side === 'atk' && a.sect && a.sect !== war.atkSect && war[`atk${a.kind === 'fake' ? 'Fakes' : 'Players'}`].includes(a.id))) return { ok: false, msg: '两宗合围需要盟友兵力实际入场' }
    war.kind = kind.key; war.bonus = kind.bonus; atkLog(war, `【战法】改用${kind.key}`); saveFake(f, gid)
    return { ok: true, msg: `战役 #${war.id} 已改用【${kind.key}】。` }
  }
  let count = Number(args[1]) || 0
  if (!count) return { ok: true, menu: { kind: 'amount', verb, warId: war.id }, msg: `战役 #${war.id}：回复要${verb}的人数（1~999），0 取消。` }
  if (!Number.isInteger(count) || count < 1 || count > 999) return { ok: false, msg: '人数须为1~999的整数' }
  if (verb === '盟友助战' || (verb === '派兵' && war.atkSect !== p?.sect && war.coalition?.[p?.sect])) return allyAssist(f, gid, uid, String(war.id), count)
  if (verb === '集结仆从') return sectServantRally(f, gid, uid, String(war.id), count)
  if (verb === '派兵' || verb === '减兵') return sectForceAdjust(f, gid, uid, String(war.id), verb === '减兵' ? -count : count)
  return { ok: false, msg: '未知战争操作' }
}

export function commandFromWarChoice (state, number) {
  if (state.kind === 'amount') return { verb: state.verb, args: [String(state.warId), String(number)] }
  const option = state.options?.[number - 1]
  if (!option) return null
  return { verb: state.verb, expectedSectId: option.sectId, args: state.kind === 'tactic' ? [String(state.warId), option.value] : [option.value] }
}

/** 数字菜单跨步骤保留身份；换宗后须重新打开，不能把旧选择解释成另一阵营。 */
export async function runWarCommand (f, gid, uid, command, menuState = null, nick = '玩家') {
  const actorSect = f.players?.[String(uid)]?.sect || null
  if (menuState && Object.hasOwn(menuState, 'actorSect') && menuState.actorSect !== actorSect) return { ok: false, msg: '你的宗门身份已改变，请重新打开战争菜单' }
  const result = await runWarCommandUnlocked(f, gid, uid, command, menuState, nick)
  if (result.menu) result.menu.actorSect = actorSect
  return result
}
