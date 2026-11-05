import { npcCanAct } from '../npc_action.js'

/** 保留在世成员的宗门身份；只有职位空缺才选继承人，不创造人物/修为。 */
export function settleSectSuccession (f, now, { powerOf, removeFromSect, log }) {
  let changed = false
  for (const [sid, s] of Object.entries(f.sects || {})) {
    // 旧式覆灭标记有历史歧义：不自动复活，不沿用原编号重建。
    if (!s || s.wipeAt || s.dissolvedAt) continue
    const players = Object.entries(f.players || {}).filter(([, p]) => p?.sect === sid)
    if (s.owner || players.length) continue // 混合宗门的真人任职由玩家管理。
    const members = Object.values(f.roster || {}).filter(p => p.alive && p.sect === sid && p.status === 'sect')
    const sm = f.sectMap[sid] ||= { zongzhu: null, taishang: [], fuzong: [], zhishi: [], dizi: [] }
    if (!members.length) {
      s.wipeAt = now; s.rebuildAt = 0; s.dissolvedAt = now
      f.worldLifecycleVersion = 2
      log('wipe', `【消亡】${s.name} 已无在世门人，宗门传承断绝`, now, { major: true, sect: sid })
      changed = true
      continue
    }
    const leader = members.find(p => p.name === sm.zongzhu)
    if (leader) continue // 秘境/在途/被俘仍是在世宗主，不另立新主。
    // 旧名册若遗漏仍在世的宗主，先恢复索引，不抢走他的职位。
    const existing = members.find(p => p.pos === 'zongzhu')
    if (existing) { sm.zongzhu = existing.name; changed = true; continue }
    const available = members.filter(p => npcCanAct(f, p, now))
    if (!available.length) continue // 全员暂时脱不开身，也不判灭门。
    const rank = { fuzong: 4, taishang: 3, zhishi: 2, dizi: 1 }
    available.sort((a, b) => (rank[b.pos] || 0) - (rank[a.pos] || 0) || powerOf(b) - powerOf(a) || (b.loyalty || 0) - (a.loyalty || 0) || (a.joinAt || 0) - (b.joinAt || 0))
    const p = available[0]
    removeFromSect(sid, p.name)
    p.pos = 'zongzhu'; sm.zongzhu = p.name
    s.succession = { at: now, leader: p.name, previous: s.succession?.leader || null }
    log('promote', `【继任】${p.name} 继任${s.name}宗主`, now, { who: [p.name], sect: sid, major: true })
    changed = true
  }
  return changed
}

/** 空宗门自然消亡的清理可重试；先完成俘虏释放，再除名。 */
export async function finishSectDissolutions (f, gid, now, { liberate, unmark, forget }) {
  let changed = false
  for (const [sid, s] of Object.entries(f.sects || {})) {
    if (!s?.dissolvedAt) continue
    await liberate(f, gid, sid, now)
    for (const x of f.sectJails?.[sid] || []) if (x.uid) await unmark(gid, x.uid)
    for (const x of [...(f.sectJails?.[sid] || []), ...(f.sectMines?.[sid] || [])]) {
      const p = f.roster?.[x.name]
      if (p?.alive) {
        if (p.mineOf === sid || p.status === 'mine') { p.mineOf = null; p.status = p.sect && f.sects[p.sect] && p.sect !== sid ? 'sect' : 'scatter' }
        if (p.sect === sid) { p.sect = null; p.pos = null; p.status = 'scatter' }
      }
    }
    if (f.sectJails) delete f.sectJails[sid]
    if (f.sectMines) delete f.sectMines[sid]
    for (const [area, owner] of Object.entries(f.areas || {})) if (owner === sid) { delete f.areas[area]; if (f.areaDef) delete f.areaDef[area] }
    forget(f, sid)
    ;(f.sectDeadNames ||= {})[sid] = s.name
    delete f.sectMap[sid]; delete f.sects[sid]
    changed = true
  }
  return changed
}
