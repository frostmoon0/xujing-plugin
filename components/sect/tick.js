import { finishSectDissolutions } from './succession.js'
import { normalizeDiplomacy, forgetSectDiplomacy } from './diplomacy_state.js'
/* 由 sect_system.js 拆分自动生成: tick.js */
import { saveFake, getFake, learnSectGongfa } from '../fake_data.js'
import { getWorld, saveWorld } from '../world_data.js'
import { healPlayers } from './utils.js'
import { taxShareToVault, hourlyAreaOutput, autoRefine, fillSects, maintFacilities, fakeBuildFacilities, yaoyuanOutput, mineTick, syncWorldSectMap, payPlayerSectSalaries } from './economy.js'
import { aiDiplomacy } from './diplomacy.js'
import { resolveSectAttacks, spawnAiSectAttacks } from './war.js'
import { settleSectJails, repairSettledCaptives, liberateDestroyedCaptor, unmarkPlayerCaptive } from './captive.js'
import { notifyJoinReqs } from './hr.js'

export async function sectTick (f, gid, now = Date.now()) {
  let changed = normalizeDiplomacy(f, now)
  try { if (await finishSectDissolutions(f, gid, now, { liberate: liberateDestroyedCaptor, unmark: unmarkPlayerCaptive, forget: forgetSectDiplomacy })) changed = true } catch (err) { console.log('[宗门系统]自然消亡清理异常:', err?.stack) }
  try { if (await resolveSectAttacks(f, gid, now)) changed = true } catch (err) { console.log('[宗门系统]攻打推进异常:', err && err.stack) }
  try { if (await repairSettledCaptives(f, gid)) changed = true } catch (err) { console.log('[宗门系统]历史俘虏修复异常:', err && err.stack) }
  if (healPlayers(f)) changed = true
  try { settleSectJails(f, gid, now) } catch (err) { }
  /* 每半小时: 税收分成 + 小区产出 + 自动炼丹 + 伪玩家补齐宗门 */
  if (now - (f.lastAreaOut || 0) >= 1800000) {
    f.lastAreaOut = now
    try {
      const w = getWorld(gid)
      /* 同步小区税收归属(易主/覆灭/重建后 w.sectMap 与 f.areas 对齐), 避免税给错宗门 */
      try { syncWorldSectMap(f, w) } catch (err) { console.log('[宗门系统]税收归属同步异常:', err && err.stack) }
      taxShareToVault(f, w)
      hourlyAreaOutput(f, now, w)
      saveWorld(w)
      autoRefine(f)
      try { if (learnSectGongfa(f, now)) changed = true } catch (err) { console.log('[宗门系统]功法学习异常:', err && err.stack) }
      /* 每小时@玩家宗主: 有散修想加入宗门(1小时最多提醒一次) */
      notifyJoinReqs(f, gid, now)
    } catch (err) { console.log('[宗门系统]产出异常:', err && err.stack) }
    try { if (fillSects(f, now) > 0) changed = true } catch (err) { }
    changed = true
  }
  /* 被打小区按恢复期结束/上次产出独立计时, 每分钟检查, 不等全群半小时批次。 */
  if (Object.keys(f.areaRaidAt || {}).length) {
    try {
      if (hourlyAreaOutput(f, now, getWorld(gid), { raidedOnly: true })) changed = true
    } catch (err) { console.log('[宗门系统]小区恢复产出异常:', err && err.stack) }
  }
  /* 每小时: 设施维护费(不足掉级) + 伪玩家宗门自动建设设施 + 药园产出 + 矿山战俘挖矿 */
  if (now - (f.lastMaint || 0) >= 3600000) {
    f.lastMaint = now
    try { maintFacilities(f, now); fakeBuildFacilities(f, now); yaoyuanOutput(f, now); mineTick(f, now) } catch (err) { console.log('[宗门系统]设施维护异常:', err && err.stack) }
    changed = true
  }
  /* 每小时: 玩家主导宗门向每名弟子自动发放500灵石俸禄; 伪玩家宗门不发 */
  try {
    const salary = await payPlayerSectSalaries(f, gid, now)
    if (salary.changed) changed = true
  } catch (err) { console.log('[宗门系统]弟子俸禄异常:', err && err.stack) }
  /* 每10分钟: AI 宗门外交(主动结盟/议和; 结盟宗门可一起攻打, 打赢按输出给贡献最高者) */
  if (now - (f.lastDiplomacy || 0) >= 600000) {
    f.lastDiplomacy = now
    try { if (aiDiplomacy(f, gid, now)) changed = true } catch (err) { console.log('[宗门系统]AI外交异常:', err && err.stack) }
  }
  /* 每分钟检查: AI(伪玩家)攻打；不限并发, 各宗门按自身 1 小时攻打冷却独立行动 */
  const strategyBefore = JSON.stringify(Object.values(f.sects || {}).map(s => s.aiStrategy))
  try { if (await spawnAiSectAttacks(f, gid, now)) changed = true } catch (err) { console.log('[宗门系统]AI攻打异常:', err && err.stack) }
  if (strategyBefore !== JSON.stringify(Object.values(f.sects || {}).map(s => s.aiStrategy))) changed = true
  if (changed) saveFake(f, gid)
}

