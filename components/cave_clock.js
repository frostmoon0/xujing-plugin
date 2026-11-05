export function caveNight (at = Date.now()) {
  const hour = new Date(at).getHours()
  return hour >= 1 && hour < 6
}

/** 玩家万魂窟在关服的 1～6 点暂停；检查点落在窟内存档，重启也不重复补时。 */
export function syncCaveNightClock (cave, at = Date.now()) {
  if (!cave?.inCave) return false
  const hadClock = Number(cave.nightClockAt) > 0
  const previous = Number(cave.nightClockAt) || Number(cave.enteredAt) || at
  if (at < previous) return false
  const day = new Date(previous)
  day.setHours(0, 0, 0, 0)
  let paused = 0
  while (day.getTime() < at) {
    const start = new Date(day); start.setHours(1, 0, 0, 0)
    const end = new Date(day); end.setHours(6, 0, 0, 0)
    paused += Math.max(0, Math.min(at, end.getTime()) - Math.max(previous, start.getTime()))
    day.setDate(day.getDate() + 1)
  }
  if (paused) {
    for (const key of ['enteredAt', 'protectionUntil', 'nextEncounterAt', 'nextRealmDropAt']) {
      if (Number(cave[key]) > 0) cave[key] = Number(cave[key]) + paused
    }
  }
  cave.nightClockAt = at
  return !hadClock || paused > 0
}
