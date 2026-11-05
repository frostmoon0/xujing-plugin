const pad = n => String(n).padStart(2, '0')
export function trialDay (at = Date.now()) {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 周六零点开始统计新一期；00:05 发放上一期奖励。 */
export function trialWeek (at = Date.now()) {
  const d = new Date(at)
  d.setDate(d.getDate() - (d.getDay() + 1) % 7)
  return trialDay(d)
}

/** 换日/换周只归档，不删除尚未结算的成绩；兼容旧周一周期。 */
export function rotateTrialPeriods (data, today = trialDay(), week = trialWeek()) {
  data.dailyArchive ||= {}
  data.weeklyArchive ||= {}
  data.dailyPaid ||= {}
  data.weeklyPaid ||= {}
  data.groups ||= {}
  data.weekGroups ||= {}
  if (data.weekSchema !== 2) {
    if (data.week) {
      const old = new Date(`${data.date || data.week}T12:00:00`)
      if (Number.isFinite(old.getTime())) data.week = trialWeek(old)
    }
    data.weekSchema = 2
  }
  if (data.date && data.date !== today) {
    if (Object.keys(data.groups).length) data.dailyArchive[data.date] = data.groups
    data.groups = {}
  }
  if (data.week && data.week !== week) {
    if (Object.keys(data.weekGroups).length) data.weeklyArchive[data.week] = data.weekGroups
    data.weekGroups = {}
  }
  data.date = today
  data.week = week
  return data
}

/** 发奖回调须同步且按 receipt 幂等；失败的群不记已结算，下次可重试。 */
export function settleTrialPeriods (data, groups, grant, { today = trialDay(), week = trialWeek(), daily = true, weekly = true } = {}) {
  rotateTrialPeriods(data, today, week)
  const notices = []
  const settle = (kind, before, enabled) => {
    if (!enabled) return
    const archive = data[`${kind}Archive`]
    const paid = data[`${kind}Paid`]
    for (const period of Object.keys(archive).sort()) {
      if (period >= before) continue
      paid[period] ||= {}
      for (const gid of groups.map(String)) {
        if (paid[period][gid] || !archive[period][gid]) continue
        const ranked = Object.entries(archive[period][gid]).sort((a, b) =>
          (Number(b[1][kind === 'daily' ? 'dmg' : 'total']) || 0) - (Number(a[1][kind === 'daily' ? 'dmg' : 'total']) || 0))
        for (const [i, [uid]] of ranked.entries()) {
          const boxes = kind === 'daily' ? ([5, 4, 3, 2, 1][i] || 0) : (i === 0 ? 20 : i === 1 ? 15 : i === 2 ? 10 : i < 10 ? 5 : 1)
          if (boxes) grant(gid, uid, '灵宝盒', boxes, `trial:${kind}:${period}:${uid}:box`)
          if (kind === 'daily') grant(gid, uid, '修为丹', 1, `trial:${kind}:${period}:${uid}:pill`)
        }
        paid[period][gid] = true
        notices.push({ kind, period, gid })
      }
    }
    // 仅清理已全部发完的旧榜；保留最近三十期及所有待结算记录。
    const old = Object.keys(archive).sort().slice(0, -30)
    for (const period of old) {
      if (Object.keys(archive[period]).every(gid => paid[period]?.[gid])) {
        delete archive[period]; delete paid[period]
      }
    }
  }
  settle('daily', today, daily)
  settle('weekly', week, weekly)
  return notices
}
