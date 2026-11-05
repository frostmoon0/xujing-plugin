/** 玩家与NPC宗门成员合计统一最高70人，已有真人不自动迁移。 */
export function sectMemberCapacity (f, sid) {
  const grade = Math.max(0, Math.trunc(Number(f.sects?.[sid]?.facilities?.yanwu) || 0))
  return Math.min(70, 20 + grade * 10)
}
export function sectNpcCount (f, sid) {
  return Object.values(f.roster || {}).filter(p => p?.alive && p.status === 'sect' && p.sect === sid).length
}
export function sectOccupancy (f, sid) {
  return sectNpcCount(f, sid) + Object.values(f.players || {}).filter(p => p?.sect === sid).length
}
export function canAdmitSectNpc (f, sid, name = null) {
  const s = f.sects?.[sid]
  if (!s || s.wipeAt || !f.sectMap?.[sid]) return false
  const p = name && f.roster?.[name]
  if (p?.alive && p.status === 'sect' && p.sect === sid) return true
  return sectOccupancy(f, sid) < sectMemberCapacity(f, sid)
}
export function admitSectNpc (f, p, sid) {
  if (!p?.alive || p.servantOf || !canAdmitSectNpc(f, sid, p.name)) return false
  if (p.status === 'sect' && p.sect === sid) return true
  const old = f.sectMap?.[p.sect]
  if (old) {
    if (old.zongzhu === p.name) old.zongzhu = null
    for (const key of ['dizi', 'zhishi', 'fuzong', 'taishang']) old[key] = (old[key] || []).filter(n => n !== p.name)
  }
  p.sect = sid; p.pos = 'dizi'; p.status = 'sect'
  const map = f.sectMap[sid]; map.dizi ||= []
  if (!map.dizi.includes(p.name)) map.dizi.push(p.name)
  return true
}
