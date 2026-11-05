import { withGameLock } from '../../components/game_lock.js'
/* ============================================================
 * 世界Boss系统 - 指令与流程
 * #攻击boss(持续讨伐·自动攻击) / #停止攻击 / #boss状态 / #抢夺登仙令 / #抢夺登仙令 @x / #boss白名单
 * 每分钟推进: 自动讨伐/生成/逃跑/重生/登仙令结算/10分钟播报
 * 渲染策略: 刷新/死亡/抢夺等短播报→文字; boss状态与掉落明细→图片
 * ============================================================ */
import { plugin } from '../../model/api/api.js'
import schedule from 'node-schedule'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { addItem, tryGiveSecretKey, itemIcon } from '../../components/equip_data.js'
import {
  getBoss, saveBoss, activeBossGroups, isNight, spawnBoss, scheduleBossSoon, attackHit, distributeLoot,
  startToken, firstGrab, stealGrab, settleToken, GRAB_CD, BOSS_SOON_DELAY,
  addAutoAtk, delAutoAtk,
  MAX_SPAWN_PER_CYCLE, CYCLE_MS, BCAST_MIN,
  FLEE_MIN, FIRST_SPAWN_MIN, NEXT_SPAWN_MIN, ATTACK_CD,
  NIGHT_START, NIGHT_END
} from '../../components/boss_data.js'
import { regionNameOf, getLoc, getWorld } from '../../components/world_data.js'
import { logPlayerEvent, logBossEvent, getNick } from '../../components/fake_data.js'

/* ---------- 播报文案 ---------- */
const randText = (arr) => arr[Math.floor(Math.random() * arr.length)]
/** 刷新/重生时间落在夜间(1~6点)时, 推迟到当天 6点后 随机30~90分钟(避免6点整刷) */
function shiftOutOfNight (ts) {
  const d = new Date(ts)
  const h = d.getHours()
  if (h >= NIGHT_START && h < NIGHT_END) {
    d.setHours(NIGHT_END, 0, 0, 0)
    return d.getTime() + randMin([30, 90])
  }
  return ts
}
const SPAWN_TEXTS = [
  '🐲 {region}方向传来惊天咆哮！【{name}】现世，快去讨伐！',
  '🌪️ 有人发现{region}妖气冲天，竟是【{name}】出没！',
  '⚡ {region}深处雷云翻涌，【{name}】破界而出！',
  '🌑 {region}上空乌云蔽日，【{name}】悄然苏醒……',
  '💀 {region}大地震颤，一头【{name}】从地底爬出！',
  '🕳️ 天象异变！{region}出现巨大漩涡，【{name}】现身！',
  '🔥 {region}燃起冲天妖火，【{name}】怒吼现世！',
  '❄️ 一股寒气席卷{region}，【{name}】从极寒中走出！',
  '🌊 {region}惊涛拍岸，【{name}】踏浪而来！',
  '🎆 星陨如雨！{region}降下异象，【{name}】在此显圣！'
]
const DEATH_TEXTS = [
  '🎉 {region}方向传来震天欢呼！【{name}】已被众道友联手讨伐！',
  '💥 伴随一声哀嚎，【{name}】轰然倒地，宝物散落一地！',
  '🌟 众志成城！{region}的【{name}】终于伏诛！',
  '🗡️ 一场恶战落幕，{region}的【{name}】被彻底消灭！',
  '🌠 星辰为之黯淡，{region}最强的【{name}】倒在血泊之中！'
]
const TOKEN_TEXTS = [
  `🏮 ${itemIcon('登仙令')}登仙令于{region}现世！输入 #抢夺登仙令 抢先夺取！`,
  `📜 传说中能渡劫飞升的${itemIcon('登仙令')}登仙令，此刻静静躺在{region}的地上……`,
  `✨ 光芒闪烁！一枚${itemIcon('登仙令')}登仙令掉落在{region}！输入 #抢夺登仙令 抢夺！`,
  `💫 天降机缘！{region}出现一枚${itemIcon('登仙令')}登仙令！先到先得！`,
  `🔮 有人看到{region}地上落着${itemIcon('登仙令')}登仙令！快去 #抢夺登仙令！`
]
const FLEE_TEXTS = [
  '🏃 {region}的【{name}】见势不妙，带着伤势逃之夭夭！',
  '💨 一道黑影闪过，{region}的【{name}】遁入了虚境！',
  '🌫️ 烟雾弥漫，【{name}】趁着混乱逃离了{region}……'
]
const FLEE_FINAL_TEXTS = [
  '🏳️ 连续三次讨伐未果！{region}的【{name}】彻底遁走，再也不会回来了……',
  '💨 一声长啸，{region}的【{name}】身影淡去，此后再无踪迹！',
  '🌌 {region}恢复平静，【{name}】历经三次围剿仍全身而退，彻底逃离！'
]
const SECURE_TEXTS = [
  `🏮 ${itemIcon('登仙令')}登仙令已收入囊中！持令者彻底远遁而去~`,
  `🌙 时间到！${itemIcon('登仙令')}登仙令随之远遁，落入胜者之手！`,
  `✨ 尘埃落定，${itemIcon('登仙令')}登仙令归于持令者，自此远遁无踪！`
]

/** 单群发送 */
function sendToGroup (gid, msg) {
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.sendMsg) g.sendMsg(msg)
  } catch (err) { }
}

export class boss extends plugin {
  constructor () {
    super({
      name: '世界boss',
      dsc: '世界Boss讨伐/登仙令抢夺',
      event: 'message',
      priority: 300,
      rule: [
        { reg: '^(@[^\\s#＃@]+)?\\s*[#＃]?\\s*(抢夺登仙令|抢登仙令)(\\s*@.*)?$', fnc: 'grabToken' },
        { reg: '^[#＃]?(攻击boss|攻打boss|讨伐boss|围殴boss|打boss)$', fnc: 'attackBoss' },
        { reg: '^[#＃]?(停止攻击|停止讨伐|退出讨伐|停止打boss)$', fnc: 'stopAutoAtk' },
        { reg: '^[#＃]?(boss刷新|刷新boss|boss一会刷新)$', fnc: 'scheduleBoss', auth: 'master' },
        { reg: '^[#＃]?(boss状态|Boss状态|世界boss|boss详情)$', fnc: 'bossStatus' }
      ]
    })
    /* 每分钟推进所有活跃群(每群独立Boss) */
    if (!global.__xujingBossTick__) {
      global.__xujingBossTick__ = true
      schedule.scheduleJob('* * * * *', () => { bossTickAll().catch(err => logger.error('[世界boss]推进异常:' + (err && err.stack))) })
    }
  }

  /* ---- #boss刷新: 主人安排当前群下一只Boss约1分钟后出现 ---- */
  async scheduleBoss (e) {
    if (!e.group_id) { e.reply('需在群内安排刷新~'); return true }
    const gid = String(e.group_id)
    const st = getBoss(gid)
    if (!scheduleBossSoon(st, BOSS_SOON_DELAY)) {
      e.reply(st.region ? `当前已有【${st.typeName}】在【${regionNameOf(st.region)}】现世，不能重复安排。` : '当前Boss正在逃亡冷却中，不能重复安排。')
      return true
    }
    saveBoss(st, gid)
    e.reply(`✅ 已安排当前群下一只世界Boss约1分钟后刷新；发送 #boss状态 可查看倒计时。`)
    return true
  }
  /* ---- #攻击boss: 加入持续讨伐(自动攻击, 发送一次不用管, 无前摇后摇) ---- */
  async attackBoss (e) {
    if (!e.group_id) { e.reply('需在群内讨伐~'); return true }
    const gid = String(e.group_id)
    const st = getBoss(gid)
    if (!st.region) { e.reply('当前没有现世的世界Boss，等待刷新吧~'); return true }
    const w = getWorld(gid)
    if (getLoc(w, e.user_id) !== st.region) {
      e.reply(`【${st.typeName}】出没于【${regionNameOf(st.region)}】，你不在该大区，无法讨伐！先去 #去${regionNameOf(st.region)} ~`)
      return true
    }
    const uid = String(e.user_id)
    if (st.auto && st.auto[uid]) {
      e.reply([segment.at(e.user_id), `\n⚔️ 你已在持续讨伐【${st.typeName}】中！（#boss状态 查看进度，#停止攻击 退出）`])
      return true
    }
    /* 加入持续讨伐 + 立即打一下(无前摇) */
    addAutoAtk(st, e.user_id, e.group_id)
    const { dmg, level } = await attackHit(st, e.user_id, e.group_id)
    const pct = Math.max(0, Math.round(st.hp / st.maxHp * 100))
    if (st.hp <= 0) {
      /* 首击即击杀 */
      await killBoss(st, gid)
      e.reply([segment.at(e.user_id), `\n⚔️ 你一击毙命（${dmg} 伤害）！【${st.typeName}】轰然倒地！`])
      return true
    }
    saveBoss(st, gid)
    e.reply([segment.at(e.user_id), `\n⚔️ 你已加入持续讨伐！首击对【${st.typeName}】造成 ${dmg} 伤害（剩余 ${pct}%）\n已开启自动攻击（每20秒一次），发送一次即可，无需反复操作\n#boss状态 查看进度 · #停止攻击 退出`])
    return true
  }

  /* ---- #停止攻击: 退出持续讨伐 ---- */
  async stopAutoAtk (e) {
    if (!e.group_id) { e.reply('请在群内操作~'); return true }
    const gid = String(e.group_id)
    const st = getBoss(gid)
    const uid = String(e.user_id)
    if (!st.auto || !st.auto[uid]) { e.reply('你当前没有在持续讨伐中~'); return true }
    delAutoAtk(st, uid)
    saveBoss(st, gid)
    e.reply([segment.at(e.user_id), `\n🛑 你已退出持续讨伐！已造成的 ${st.damage[uid] || 0} 伤害仍会计入分赃`])
    return true
  }

  /* ---- #boss状态(渲染图片) ---- */
  async bossStatus (e) {
    if (!e.group_id) { e.reply('需在群内查看~'); return true }
    const gid = String(e.group_id)
    const st = getBoss(gid)
    if (!st.region) {
      const next = Number(st.fleeEnd) > Date.now()
        ? st.fleeEnd
        : (Number(st.forceSpawnAt) > Date.now() ? st.forceSpawnAt : st.nextSpawn)
      const wait = next > Date.now() ? `预计${new Date(next).toLocaleString('zh-CN', { hour12: false })}刷新（约${Math.ceil((next - Date.now()) / 60000)}分钟后）` : '正在等待系统安排刷新时间'
      e.reply(`当前没有现世的世界Boss，${wait}。`)
      return true
    }
    const remainMin = Math.max(0, Math.ceil((st.end - Date.now()) / 60000))
    const pct = Math.max(0, Math.round(st.hp / st.maxHp * 100))
    const barLen = 20
    const filled = Math.round(pct / 100 * barLen)
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled))
    const lines = [
      `🐲 世界Boss · ${st.typeName}`,
      '',
      `📍 出没大区：${regionNameOf(st.region)}`,
      `⏳ 剩余存在时间：${remainMin} 分钟`
    ]
    const autoN = Object.keys(st.auto || {}).length
    if (autoN > 0) lines.push(`⚔️ 持续讨伐中：${autoN} 位道友（#停止攻击 退出）`)
    lines.push(
      '',
      `血量：${pct}%`,
      `${bar} ${st.hp.toLocaleString()}/${st.maxHp.toLocaleString()}`,
      '',
      '━━━ 伤害排行 ━━━'
    )
    const rank = Object.keys(st.damage).sort((a, b) => st.damage[b] - st.damage[a]).slice(0, 10)
    if (!rank.length) lines.push('（暂无玩家出手，快来 #攻击boss！）')
    else {
      for (let i = 0; i < rank.length; i++) {
        const uid = rank[i]
        const nick = await getNick(gid, uid)
        lines.push(`${i + 1}. ${nick}：${st.damage[uid].toLocaleString()} 伤害`)
      }
    }
    lines.push('', '回复 #攻击boss 加入持续讨伐（每20秒自动攻击）· 1小时未击杀将逃遁')
    const img = await textToImg(lines.join('\n'))
    if (img) e.reply(img)
    else e.reply(lines.join('\n'))
    return true
  }

  /* ---- #抢夺登仙令(第一个/ @持令者) : 支持 @玩家 在指令前或后 ---- */
  async grabToken (e) {
    if (!e.group_id) { e.reply('需在群内使用~'); return true }
    /* @了玩家 → 从TA手上抢夺(委托 stealToken) */
    if (e.at) return this.stealToken(e)
    const gid = String(e.group_id)
    const st = getBoss(gid)
    if (!st.token) { e.reply(`当前没有现世的${itemIcon('登仙令')}登仙令~`); return true }
    const res = firstGrab(st, e.user_id, e.group_id)
    if (!res.ok) { e.reply(res.msg); return true }
    saveBoss(st, gid)
    e.reply([segment.at(e.user_id), `\n🏮 你抢到了${itemIcon('登仙令')}登仙令！1 分钟后你将远遁；争夺期间不能携令跨区，只有拥有${itemIcon('定仙游')}【定仙游】才能跨区转移。其他道友可在同一大区 @你 继续抢夺！`])
    return true
  }

  /* ---- #抢夺登仙令 @持令者 ---- */
  async stealToken (e) {
    if (!e.group_id) { e.reply('需在群内使用~'); return true }
    if (!e.at) { e.reply(`请@${itemIcon('登仙令')}登仙令持有者抢夺，如：#抢夺登仙令 @他`); return true }
    const gid = String(e.group_id)
    const st = getBoss(gid)
    if (!st.token || !st.token.holder) { e.reply(`当前没有可抢夺的${itemIcon('登仙令')}登仙令~`); return true }
    if (String(st.token.holder) !== String(e.at)) { e.reply(`对方不是${itemIcon('登仙令')}登仙令持有者，无法从他手上抢夺~`); return true }
    /* 抢夺失败冷却(20秒) */
    const gcd = await redis.ttl(`xujing:boss-grab-cd:${e.user_id}`)
    if (gcd !== -2 && gcd !== -1) { e.reply(`抢夺失败后需等待，还剩 ${gcd} 秒~`); return true }
    const res = await stealGrab(st, e.user_id, e.group_id)
    if (!res.ok) { e.reply(res.msg); return true }
    saveBoss(st, gid)
    const left = Math.max(0, Math.ceil((st.token.end - Date.now()) / 1000))
    e.reply([segment.at(e.user_id), `\n⚔️ 抢夺成功！你夺走了${itemIcon('登仙令')}登仙令！\n剩余 ${left} 秒后远遁；争夺期间不能携令跨区，只有拥有${itemIcon('定仙游')}【定仙游】才能跨区转移。其他道友可在同一大区继续抢夺！`])
    return true
  }
}

/* ---------- 击杀流程: 分赃 + 播报 + 登仙令现世 + 排下次刷新(本群) ---------- */
async function killBoss (st, gid) {
  const region = st.region
  const name = st.typeName
  const results = await distributeLoot(st, gid)
  /* 遗蜕古钥: 参与讨伐者按彩级概率产, 每日每群最多2把 */
  for (const r of results) { try { if (await tryGiveSecretKey(gid, r.uid)) { const got = await getNick(gid, r.uid); sendToGroup(gid, `🗝️ ${got} 从【${name}】身上搜出一把${itemIcon('遗蜕古钥')}【遗蜕古钥】！`) } } catch (err) { } }
  /* 死亡播报 */
  sendToGroup(gid, randText(DEATH_TEXTS).replace(/\{region\}/g, regionNameOf(region)).replace(/\{name\}/g, name))
  /* 写入天下大事: 讨伐功臣(按伤害前三) */
  try {
    const top = Object.keys(st.damage).sort((a, b) => (st.damage[b] || 0) - (st.damage[a] || 0)).slice(0, 3)
    if (top.length) {
      const nicks = []
      for (const uid of top) nicks.push(await getNick(gid, uid))
      logPlayerEvent(gid, `【讨伐】散修 ${nicks.join('、')} 等道友联手讨伐【${name}】，终将诛灭！`)
    } else {
      logPlayerEvent(gid, `【讨伐】众道友联手讨伐【${name}】得手！`)
    }
  } catch (err) { }
  /* 掉落明细(图片) */
  const lootLines = ['🎁 世界Boss讨伐 · 战利品分配', '']
  for (const r of results) {
    const nick = await getNick(gid, r.uid)
    lootLines.push(`${nick}：${r.got.map(name => `${itemIcon(name)}${name}`).join('、')}`)
  }
  const lootImg = await textToImg(lootLines.join('\n'))
  if (lootImg) sendToGroup(gid, lootImg)
  /* 妖丹: 整场只掉1枚, 已并入伤害最高者的战利品, 单独播报 */
  const yaodan = results.flatMap(r => (r.got || []).map(n => ({ uid: r.uid, name: n }))).find(x => x.name.endsWith('阶妖丹'))
  if (yaodan) {
    try {
      const nick = await getNick(gid, yaodan.uid)
      sendToGroup(gid, `🎖️ ${nick} 从【${name}】体内挖出一枚${itemIcon(yaodan.name)}${yaodan.name}！`)
    } catch (err) { }
  }
  /* 登仙令现世 */
  sendToGroup(gid, randText(TOKEN_TEXTS).replace(/\{region\}/g, regionNameOf(region)))
  /* 状态重置 + 排下次 */
  st.region = null
  st.hp = 0
  st.maxHp = 0
  st.typeName = ''
  st.damage = {}
  st.attackGid = {}
  st.auto = {} // 持续讨伐结束(无后摇)
  st.fleeHpRatio = 0
  st.fleeAt = 0
  startToken(st, region)
  scheduleNext(st)
  saveBoss(st, gid)
}

/* ---------- 排下次刷新(2天周期≥1≤3次) ---------- */
function scheduleNext (st) {
  const now = Date.now()
  if (st.spawnCount >= MAX_SPAWN_PER_CYCLE || now - st.cycleStart >= CYCLE_MS) {
    st.cycleStart = now
    st.spawnCount = 0
    st.nextSpawn = now + randMin(FIRST_SPAWN_MIN)
  } else {
    st.nextSpawn = now + randMin(NEXT_SPAWN_MIN)
  }
}
function randMin ([a, b]) { return (a + Math.floor(Math.random() * (b - a + 1))) * 60000 }

/* ---------- 每分钟推进(单群) ---------- */
async function bossTick (gid) {
  try {
    const st = getBoss(gid)
    const now = Date.now()
    let changed = false
    /* 夜间(1~6点)不刷: 落在夜间的下次刷新/逃跑重生时间, 推迟到当天6点后随机30~90分钟(避免6点整刷) */
    const ns2 = shiftOutOfNight(st.nextSpawn)
    if (ns2 !== st.nextSpawn) { st.nextSpawn = ns2; changed = true }
    const fe2 = shiftOutOfNight(st.fleeEnd)
    if (fe2 !== st.fleeEnd) { st.fleeEnd = fe2; changed = true }
    if (changed) saveBoss(st, gid)
    /* 夜间暂停所有计时 */
    if (isNight()) return
    /* 1. Boss在场: 自动讨伐推进 / 超时→逃跑(3次未击杀→彻底逃走) / 10分钟播报 */
    if (st.region) {
      /* 持续讨伐: 每人每20秒自动攻击一次(每分钟最多3次), 立即生效无前摇 */
      if (st.auto && Object.keys(st.auto).length) {
        const w = getWorld(gid)
        let atkCnt = 0
        for (const uid of Object.keys(st.auto)) {
          const rec = st.auto[uid]
          if (!rec || !rec.gid) continue
          if (getLoc(w, uid) !== st.region) continue//不在同大区, 待命
          const since = now - (rec.lastHit || 0)
          const hits = Math.min(3, Math.max(1, Math.floor(since / (ATTACK_CD * 1000))))
          for (let i = 0; i < hits; i++) await attackHit(st, uid, rec.gid)
          rec.lastHit = now
          atkCnt++
        }
        if (atkCnt > 0) {
          changed = true
          if (st.hp <= 0) {
            /* 自动讨伐击杀: 立即分赃+播报+登仙令(无后摇) */
            await killBoss(st, gid)
          }
        }
      }
      if (st.region && now >= st.end) {
        st.fleeCount = (st.fleeCount || 0) + 1
        if (st.fleeCount >= 3) {
          /* 第3次: 彻底逃走, 不再重生 */
          sendToGroup(gid, randText(FLEE_FINAL_TEXTS).replace(/\{region\}/g, regionNameOf(st.region)).replace(/\{name\}/g, st.typeName))
          /* 写入天下大事: 连续讨伐未果彻底遁走 */
          try {
            logPlayerEvent(gid, `【逃遁】连续三次围剿未果，【${st.typeName}】彻底遁走，不知所踪`)
          } catch (err) { }
          st.region = null
          st.hp = 0
          st.maxHp = 0
          st.typeName = ''
          st.damage = {}
          st.attackGid = {}
          st.auto = {} // 持续讨伐随Boss消失结束
          st.fleeHpRatio = 0
          st.fleeAt = 0
          st.fleeEnd = 0
          scheduleNext(st)
        } else {
          sendToGroup(gid, randText(FLEE_TEXTS).replace(/\{region\}/g, regionNameOf(st.region)).replace(/\{name\}/g, st.typeName))
          /* 记录剩余血量比例与逃跑时间: 重生时保留残血并按逃跑时长回血 */
          st.fleeHpRatio = st.maxHp > 0 ? (st.hp / st.maxHp) : 0
          st.fleeAt = now
          st.region = null
          st.hp = 0
          st.maxHp = 0
          st.damage = {}
          st.attackGid = {}
          st.auto = {} // 持续讨伐随Boss消失结束
          st.fleeEnd = now + randMin(FLEE_MIN)
        }
        changed = true
      } else if (st.region && now - st.lastBcast >= BCAST_MIN * 60000) {
        /* 10分钟播报(简洁文字) */
        const pct = Math.max(0, Math.round(st.hp / st.maxHp * 100))
        const remainMin = Math.max(0, Math.ceil((st.end - now) / 60000))
        const autoN = Object.keys(st.auto || {}).length
        sendToGroup(gid, `🐲 【${st.typeName}】在【${regionNameOf(st.region)}】肆虐中！剩余血量 ${pct}%，存在 ${remainMin} 分钟后逃遁${autoN ? `\n⚔️ ${autoN} 位道友正在持续讨伐！` : ''}\n（#boss状态 查看伤害排行）`)
        st.lastBcast = now
        changed = true
      }
    }
    /* 2. 主人临时安排的单次刷新: 不受周期次数/旧 nextSpawn 影响，只生成这一只Boss */
    const forceDue = !st.region && !st.fleeEnd && Number(st.forceSpawnAt) > 0 && now >= st.forceSpawnAt
    if (forceDue) {
      st.forceSpawnAt = 0
      st.spawnCount = Math.min(MAX_SPAWN_PER_CYCLE, (Number(st.spawnCount) || 0) + 1)
      const info = await spawnBoss(st, gid)
      sendToGroup(gid, randText(SPAWN_TEXTS).replace(/\{region\}/g, regionNameOf(info.target)).replace(/\{name\}/g, info.name))
      try { logBossEvent(gid, `【出世】天象异变！【${info.name}】现身${regionNameOf(info.target)}！（临时安排刷新）`) } catch (err) { }
      changed = true
    }
    /* 3. 逃跑冷却结束→随机大区重生(保留同一Boss与逃遁计数) */
    if (!st.region && st.fleeEnd && now >= st.fleeEnd) {
      st.fleeEnd = 0
      const info = await spawnBoss(st, gid, null, true)
      const hpPct = Math.max(1, Math.round(st.hp / st.maxHp * 100))
      sendToGroup(gid, `${randText(SPAWN_TEXTS).replace(/\{region\}/g, regionNameOf(info.target)).replace(/\{name\}/g, info.name)}（伤势未愈归来，当前血量 ${hpPct}%）`)
      try { logBossEvent(gid, `【出世】天象异变！【${info.name}】在${regionNameOf(info.target)}重现！（伤势未愈归来，血量 ${hpPct}%）`) } catch (err) { }
      changed = true
    }
    /* 4. 无Boss无逃跑: 到点生成(2天周期≥1≤3次)；已有临时预约时等待预约时间 */
    if (!st.region && !st.fleeEnd && !st.forceSpawnAt && now >= st.nextSpawn) {
      if (st.spawnCount >= MAX_SPAWN_PER_CYCLE || now - st.cycleStart >= CYCLE_MS) {
        st.cycleStart = now
        st.spawnCount = 0
        st.nextSpawn = now + randMin(FIRST_SPAWN_MIN)
      } else {
        st.spawnCount++
        const info = await spawnBoss(st, gid)
        sendToGroup(gid, randText(SPAWN_TEXTS).replace(/\{region\}/g, regionNameOf(info.target)).replace(/\{name\}/g, info.name))
        try { logBossEvent(gid, `【出世】天象异变！【${info.name}】现身${regionNameOf(info.target)}！`) } catch (err) { }
      }
      changed = true
    }
    /* 4. 登仙令倒计时: 结束收入囊中 */
    if (st.token && st.token.holder) {
      const res = settleToken(st)
      if (res) {
        addItem(res.holder, '登仙令', 1, null, res.gid || gid)
        const holderNick = await getNick(gid, res.holder)
        sendToGroup(gid, `${randText(SECURE_TEXTS)}（${itemIcon('登仙令')}登仙令已入 ${holderNick} 背包）`)
        /* 写入天下大事: 登仙令归属 */
        try {
          logPlayerEvent(gid, `【登仙令】散修 ${holderNick} 夺得${itemIcon('登仙令')}登仙令，远遁飞升而去`)
        } catch (err) { }
        changed = true
      }
    } else if (st.token && !st.token.holder && now >= st.token.end) {
      st.token = null // 无人认领, 消失
      changed = true
    }
    if (changed) saveBoss(st, gid)
  } catch (err) {
    logger.error('[世界boss]tick异常:', err && err.stack)
  }
}

/* ---------- 每分钟推进(所有活跃群, 每群独立Boss) ---------- */
async function bossTickAll () {
  for (const gid of activeBossGroups()) {
    try { await withGameLock(gid, () => bossTick(gid)) } catch (err) { logger.error('[世界boss]推进异常:' + (err && err.stack)) }
  }
}
