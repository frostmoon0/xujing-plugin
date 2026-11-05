/* 秘境游戏时钟：夜间关闭指令的 1~6 点不消耗进行中秘境的时间。
 * 检查点随秘境存档持久化；读档补偿，因此停机跨夜也不会直接超时结算。
 * 只顺延秘境内部计时，不改封海、丹药等外部世界状态。
 */
function shiftTimes (obj, fields, delta) {
  if (!obj) return
  for (const field of fields) {
    const value = Number(obj[field])
    if (Number.isFinite(value) && value > 0) obj[field] = value + delta
  }
}

export function syncRealmNightClock (st, now = Date.now()) {
  if (!st || !['barrier', 'explore'].includes(st.phase)) return { changed: false, paused: 0 }
  const hadClock = Number(st.nightClockAt) > 0
  // 旧档探索用开场时间；屏障阶段用最早入场时间，缺失时从本次读取开始。
  const starts = Object.values(st.teams || {}).map(t => Number(t.startedAt)).filter(t => t > 0)
  const previous = hadClock ? Number(st.nightClockAt) : Number(st.startAt) || (starts.length ? Math.min(...starts) : now)
  if (now < previous) return { changed: false, paused: 0 }
  let paused = 0
  const day = new Date(previous)
  day.setHours(0, 0, 0, 0)
  while (day.getTime() < now) {
    const start = new Date(day); start.setHours(1, 0, 0, 0)
    const end = new Date(day); end.setHours(6, 0, 0, 0)
    const from = Math.max(previous, start.getTime())
    const to = Math.min(now, end.getTime())
    // 已在夜间开始前结束的旧秘境不能因补偿而复活。
    if (st.phase === 'explore' && Number(st.endAt) > 0 && st.endAt <= from) break
    if (to > from) {
      const delta = to - from
      shiftTimes(st, ['endAt', 'ambushAt', 'ambushChoiceEnd'], delta)
      for (const t of Object.values(st.teams || {})) {
        shiftTimes(t, ['nextActionAt', 'lastActionAt', 'arrivalAt', 'lastBarrierHit', 'exposedUntil', 'encounterLockUntil'], delta)
      }
      for (const rec of Object.values(st.barrier?.auto || {})) shiftTimes(rec, ['lastHit'], delta)
      paused += delta
    }
    day.setDate(day.getDate() + 1)
  }
  st.nightClockAt = now
  if (paused > 0) st.nightResumePending = true
  return { changed: !hadClock || paused > 0, paused }
}
