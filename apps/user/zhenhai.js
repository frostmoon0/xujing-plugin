import { withGameLock } from '../../components/game_lock.js'
import { plugin } from '../../model/api/api.js'
import xujing_data from '../../components/xujing_data.js'
import { getBag, saveBag, consumeBagItems, itemIcon } from '../../components/equip_data.js'
import { getWorld, saveWorld, getLoc, setSeal, clearSeal, getSeal, regionNameOf, REGION_KEYS, REGIONS } from '../../components/world_data.js'
import { calcCombatPower, getBuffs } from '../../components/fight.js'
import { getFake, logEvent } from '../../components/fake_data.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import {
  ZHENHAI_NAME, ZHENHAI_ICON, ZHENHAI_RECIPES, ZHENHAI_TIERS,
  getZhenhai, createZhenhai, tierInfo, rankName, cooldownLeft, canActivate,
  sealMaxHp
} from '../../components/zhenhai_data.js'

const ATTACK_CD = 60 * 1000

function moneyOf (home, uid) {
  return Number(home && home[uid] && home[uid].money) || 0
}
async function readHome (uid, gid) {
  const file = `${gid}.json`
  const home = await xujing_data.getQQYUserHome(uid, null, file, false)
  if (!home[uid]) home[uid] = { money: 0 }
  return { home, file }
}
async function takeMoney (uid, gid, amount) {
  const { home, file } = await readHome(uid, gid)
  const have = moneyOf(home, uid)
  if (have < amount) return { ok: false, have, need: amount }
  home[uid].money = have - amount
  await xujing_data.getQQYUserHome(uid, home, file, true)
  return { ok: true, have, left: home[uid].money }
}
function lackMats (bag, mats) {
  return Object.entries(mats || {}).filter(([name, count]) => ((bag.items[name] && bag.items[name].count) || 0) < count)
}
function prepareMats (bag, mats) {
  const next = { items: bag.items || {} }
  return consumeBagItems(next, mats) ? next.items : null
}
function fmtMats (mats) {
  return Object.entries(mats || {}).map(([name, count]) => `${itemIcon(name)}${name}×${count}`).join('、')
}
function hpBar (hp, max) {
  const ratio = Math.max(0, Math.min(1, Number(hp) / Math.max(1, Number(max))))
  const filled = Math.round(ratio * 12)
  return `${'█'.repeat(filled)}${'▒'.repeat(12 - filled)} ${Math.ceil(ratio * 100)}%（${Math.max(0, Math.round(hp))}/${Math.round(max)}）`
}
function remainText (until) {
  const ms = Math.max(0, Number(until) - Date.now())
  const min = Math.ceil(ms / 60000)
  return min >= 60 ? `${Math.floor(min / 60)}小时${min % 60}分` : `${min}分钟`
}

export class zhenhai extends plugin {
  constructor () {
    super({
      name: '镇海珠',
      dsc: '镇海珠打造/升级/封海/破封',
      event: 'message',
      priority: 59,
      rule: [
        { reg: '^[#＃]?打造镇海珠$', fnc: 'craft' },
        { reg: '^[#＃]?升级镇海珠$', fnc: 'upgrade' },
        { reg: '^[#＃]?镇海珠封海$', fnc: 'seal' },
        { reg: '^[#＃]?镇海珠收海$', fnc: 'unseal' },
        { reg: '^[#＃]?镇海珠(状态|信息)?$', fnc: 'status' },
        { reg: '^[#＃]?(镇海珠玩法|镇海珠攻略|镇海珠说明|镇海珠指南|封海玩法|封海攻略)$', fnc: 'guide' },
        { reg: '^[#＃]?封海状态$', fnc: 'sealStatus' },
        { reg: '^[#＃]?攻击封印$', fnc: 'attackSeal' }
      ]
    })
  }

  /** #镇海珠玩法 / #镇海珠攻略 */
  async guide (e) {
    const tierLines = ZHENHAI_TIERS.slice(1).map(t =>
      `${t.rank}阶·${t.name}：封海${t.durationMin}分钟｜封印血量=${t.hits}×使用者战力｜冷却${t.cooldownHours}小时｜${t.rank === 1 ? '定仙游可穿' : '定仙游失效'}`
    )
    const recipeLine = (label, r) => `${label}：${fmtMats(r.mats)} + 💰${r.money}灵石`
    const recipeLines = [
      recipeLine('打造1阶', ZHENHAI_RECIPES.craft),
      ...Object.keys(ZHENHAI_RECIPES).filter(k => k !== 'craft').map(k => recipeLine(`升${k}阶`, ZHENHAI_RECIPES[k]))
    ]
    const text = [
      `━━━ ${ZHENHAI_ICON} ${ZHENHAI_NAME}玩法 ━━━`,
      '【定位】',
      '· 世界级控制法宝，不参与战力计算；拥有即生效，不占装备栏。',
      '· 使用 #镇海珠封海 封锁你当前所在的正常大区；简月王朝不可封锁。',
      '',
      '【五阶】',
      ...tierLines.map(x => `· ${x}`),
      '· 封印血量 = 阶位基础次数 × 使用者当前战力，阶位越高越硬。',
      '',
      '【封海规则】',
      '· 你本人不受限制，可自由进出、传送、强行跨越。',
      '· 其他玩家不可进、不可出：传送阵、定仙游、强行跨越、秘境入场自动跨区、南疆—简月王朝边境全部拦截。',
      '· 1阶定仙游仍可穿；2阶起定仙游失效。',
      '· 高阶封海可覆盖低阶；同阶比较双方使用者当前战力，高者覆盖。',
      '· 封海期间镇海海眼不刷新，避免封海者垄断自己的升级材料。',
      '',
      '【封印血条】',
      '· 被封大区内的非主人玩家可 #攻击封印，每人每分钟 1 次。',
      '· 每次伤害 = 攻击者综合战力 ±10%；血量归零立即破封。',
      '· 主人不能攻击自己的封印；区外玩家无法攻击。',
      '',
      '【材料】',
      '· 5 种材料在东海所有秘境都会掉落：镇海砂、龙宫珊瑚、海眼寒铁、潮汐月华、沧溟珠泪。',
      '· 东海秘境每件正常掉落约 45% 判为镇海材料，且每个事件至少保底 1 件。',
      '· 藏宝阁、万魂窟、宗门、商店、Boss 均不产出这些材料。',
      '',
      '【配方】',
      ...recipeLines.map(x => `· ${x}`),
      '',
      '【指令】',
      '· #打造镇海珠 / #升级镇海珠',
      '· #镇海珠封海 / #镇海珠收海',
      '· #攻击封印 / #镇海珠状态 / #封海状态',
      '',
      '【注意】',
      '· 镇海珠绑定，不可赠送、拍卖、被搜刮。',
      `· 封海冷却从开启时计算；被提前击破或主动收海，冷却照常。`
    ].join('\n')
    try {
      const img = await textToImg(text)
      if (img) { e.reply(img); return true }
    } catch (err) { }
    e.reply(text)
    return true
  }

  /** 玩家当前战力(含功法/丹药/灵兽等) */
  async powerOf (uid, gid) {
    try {
      const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
      const level = Number(battle?.[uid]?.level) || 0
      if (level <= 0) return 0
      const bag = getBag(uid, gid)
      const buff = await getBuffs(uid, gid)
      return calcCombatPower(level, bag, buff, gid, uid).power
    } catch (err) { return 0 }
  }

  async craft (e) {
    return withGameLock(e.group_id, () => this.craftUnlocked(e))
  }

  async craftUnlocked (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = String(e.group_id)
    const bag = getBag(e.user_id, gid)
    if (getZhenhai(bag)) { e.reply(`你已经拥有${ZHENHAI_ICON}${ZHENHAI_NAME}了。`); return true }
    const recipe = ZHENHAI_RECIPES.craft
    const lack = lackMats(bag, recipe.mats)
    if (lack.length) {
      e.reply(`材料不足！打造${ZHENHAI_NAME}需要：${fmtMats(recipe.mats)} + 💰${recipe.money}灵石\n${lack.map(([n, c]) => `${itemIcon(n)}${n}还差${c - ((bag.items[n] && bag.items[n].count) || 0)}`).join('、')}\n（材料仅东海秘境掉落）`)
      return true
    }
    const prepared = prepareMats(bag, recipe.mats)
    if (!prepared) { e.reply('材料状态已变化，请重新检查背包。'); return true }
    const paid = await takeMoney(e.user_id, gid, recipe.money)
    if (!paid.ok) { e.reply(`灵石不足！打造${ZHENHAI_NAME}需要 ${recipe.money} 灵石，你只有 ${paid.have}。`); return true }
    bag.items = prepared
    createZhenhai(bag)
    saveBag(e.user_id, bag, gid)
    e.reply(`🔮 打造成功！获得${ZHENHAI_ICON}${ZHENHAI_NAME}（1阶·镇浪）。\n拥有即生效：使用 #镇海珠封海 可封锁你当前所在的大区。`)
    return true
  }

  async upgrade (e) {
    return withGameLock(e.group_id, () => this.upgradeUnlocked(e))
  }

  async upgradeUnlocked (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = String(e.group_id)
    const bag = getBag(e.user_id, gid)
    const art = getZhenhai(bag)
    if (!art) { e.reply(`你还没有${ZHENHAI_NAME}，先 #打造镇海珠。`); return true }
    const rank = Number(art.rank) || 1
    if (rank >= 5) { e.reply(`${ZHENHAI_NAME}已是5阶·镇海，无法继续升级。`); return true }
    const w = getWorld(gid)
    const s = getSeal(w)
    if (s && String(s.owner) === String(e.user_id) && Number(s.until) > Date.now()) {
      e.reply('你的封海仍在生效，收海后才能升级镇海珠。'); return true
    }
    const next = rank + 1
    const recipe = ZHENHAI_RECIPES[next]
    const lack = lackMats(bag, recipe.mats)
    if (lack.length) {
      e.reply(`材料不足！升级到${tierInfo(next).name}需要：${fmtMats(recipe.mats)} + 💰${recipe.money}灵石\n${lack.map(([n, c]) => `${itemIcon(n)}${n}还差${c - ((bag.items[n] && bag.items[n].count) || 0)}`).join('、')}`)
      return true
    }
    const prepared = prepareMats(bag, recipe.mats)
    if (!prepared) { e.reply('材料状态已变化，请重新检查背包。'); return true }
    const paid = await takeMoney(e.user_id, gid, recipe.money)
    if (!paid.ok) { e.reply(`灵石不足！升级需要 ${recipe.money} 灵石，你只有 ${paid.have}。`); return true }
    bag.items = prepared
    art.rank = next
    saveBag(e.user_id, bag, gid)
    e.reply(`🔮 升级成功！${ZHENHAI_NAME}现在是${rankName(next)}。`)
    return true
  }

  async seal (e) {
    return withGameLock(e.group_id, () => this.sealUnlocked(e))
  }

  async sealUnlocked (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = String(e.group_id)
    const w = getWorld(gid)
    const bag = getBag(e.user_id, gid)
    const art = getZhenhai(bag)
    const usable = canActivate(art)
    if (!usable.ok) { e.reply(usable.msg); return true }
    const loc = getLoc(w, e.user_id)
    if (!REGION_KEYS.includes(loc) || (REGIONS[loc] && REGIONS[loc].special)) {
      e.reply('简月王朝不可封锁，请到正常大区再封海。'); return true
    }
    const tier = tierInfo(art.rank)
    const old = getSeal(w)
    const now = Date.now()
    if (old && Number(old.until) > now) {
      if (String(old.owner) === String(e.user_id)) { e.reply('你已经在封海中了。'); return true }
      const oldRank = Number(old.tier) || 1
      let canOverride = false
      if (art.rank > oldRank) canOverride = true
      else if (art.rank === oldRank) {
        const myPower = await this.powerOf(e.user_id, gid)
        const oldPower = await this.powerOf(old.owner, gid)
        canOverride = myPower > oldPower
        if (!canOverride) {
          e.reply(`【${regionNameOf(old.region)}】已被同阶${ZHENHAI_NAME}封锁（主人战力 ${oldPower}，你 ${myPower}），无法压制。`)
          return true
        }
      }
      if (!canOverride) {
        e.reply(`【${regionNameOf(old.region)}】已被${rankName(oldRank)}${ZHENHAI_NAME}封锁，你的阶位不足，无法压制。`)
        return true
      }
    }
    const paid = await takeMoney(e.user_id, gid, tier.cost)
    if (!paid.ok) { e.reply(`封海需要 ${tier.cost} 灵石，你只有 ${paid.have}。`); return true }
    const ownerPower = Math.max(10000, await this.powerOf(e.user_id, gid))
    const maxHp = sealMaxHp(art.rank, ownerPower)
    const ownerName = e.sender?.card || e.sender?.nickname || e.nickname || String(e.user_id)
    const seal = {
      region: loc,
      tier: art.rank,
      owner: String(e.user_id),
      ownerName: String(ownerName),
      startedAt: now,
      until: now + tier.durationMin * 60000,
      hp: maxHp,
      maxHp,
      power: ownerPower,
      lastAttack: {}
    }
    setSeal(w, seal)
    art.cooldownUntil = now + tier.cooldownHours * 3600000
    art.lastSealAt = now
    art.sealCount = (Number(art.sealCount) || 0) + 1
    saveBag(e.user_id, bag, gid)
    try {
      logEvent(getFake(gid), 'seal', `【镇海珠】${ownerName} 在【${regionNameOf(loc)}】封海（${rankName(art.rank)}），持续${tier.durationMin}分钟，封印血量${maxHp}`, now, { major: true, region: loc })
    } catch (err) { }
    e.reply(`🌊 封海成功！【${regionNameOf(loc)}】已被${ZHENHAI_ICON}${ZHENHAI_NAME}封锁。\n阶位：${rankName(art.rank)}｜持续：${tier.durationMin}分钟｜冷却：${tier.cooldownHours}小时\n封印血量：${maxHp}（按使用者战力 ${ownerPower} × ${tier.hits} 计算）\n除你以外，任何人不可进出；区内玩家可 #攻击封印 破封。`)
    return true
  }

  async unseal (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = String(e.group_id)
    const w = getWorld(gid)
    const s = getSeal(w)
    if (!s || Number(s.until) <= Date.now()) { e.reply('当前没有封海。'); return true }
    if (String(s.owner) !== String(e.user_id)) { e.reply('只有封海主人才能收海。'); return true }
    clearSeal(w)
    try { logEvent(getFake(gid), 'seal', `【镇海珠】${s.ownerName || s.owner} 收回了【${regionNameOf(s.region)}】的封海`, Date.now(), { major: true, region: s.region }) } catch (err) { }
    e.reply(`🌊 已收回【${regionNameOf(s.region)}】的封海，冷却照常。`)
    return true
  }

  async status (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = String(e.group_id)
    const bag = getBag(e.user_id, gid)
    const art = getZhenhai(bag)
    if (!art) { e.reply(`你还没有${ZHENHAI_NAME}。材料仅东海秘境掉落，使用 #打造镇海珠。`); return true }
    const left = cooldownLeft(art)
    const lines = [`${ZHENHAI_ICON}${ZHENHAI_NAME}｜${rankName(art.rank)}`, `冷却：${left > 0 ? `${Math.ceil(left / 60000)} 分钟` : '已就绪'}`, `保护：绑定，不可赠送/拍卖/被搜刮`]
    const s = getSeal(getWorld(gid))
    if (s && String(s.owner) === String(e.user_id) && Number(s.until) > Date.now()) {
      lines.push(`当前封海：【${regionNameOf(s.region)}】剩余 ${remainText(s.until)}`, `封印血量：${hpBar(s.hp, s.maxHp)}`)
    }
    e.reply(lines.join('\n'))
    return true
  }

  async sealStatus (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const s = getSeal(getWorld(String(e.group_id)))
    if (!s || Number(s.until) <= Date.now()) { e.reply('当前没有封海。'); return true }
    e.reply(`🌊 【${regionNameOf(s.region)}】镇海珠封锁中\n主人：${s.ownerName || s.owner}｜阶位：${rankName(s.tier)}\n剩余：${remainText(s.until)}\n封印血量：${hpBar(s.hp, s.maxHp)}\n区内玩家可 #攻击封印 破封。`)
    return true
  }

  async attackSeal (e) {
    return withGameLock(e.group_id, () => this.attackSealUnlocked(e))
  }

  async attackSealUnlocked (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = String(e.group_id)
    const w = getWorld(gid)
    const s = getSeal(w)
    if (!s || Number(s.until) <= Date.now()) { e.reply('当前没有封海。'); return true }
    if (String(s.owner) === String(e.user_id)) { e.reply('这是你自己的封印，无需攻击。'); return true }
    if (getLoc(w, e.user_id) !== s.region) { e.reply(`你不在【${regionNameOf(s.region)}】，无法攻击封印。`); return true }
    const now = Date.now()
    const last = Number(s.lastAttack && s.lastAttack[String(e.user_id)]) || 0
    if (now - last < ATTACK_CD) { e.reply(`⏳ 攻击封印冷却中，还需 ${Math.ceil((ATTACK_CD - (now - last)) / 1000)} 秒。`); return true }
    const power = await this.powerOf(e.user_id, gid)
    if (power <= 0) { e.reply('你当前没有战力，无法攻击封印。'); return true }
    const dmg = Math.max(1, Math.round(power * (0.9 + Math.random() * 0.2)))
    s.lastAttack = s.lastAttack || {}
    s.lastAttack[String(e.user_id)] = now
    s.hp = Math.max(0, Number(s.hp) - dmg)
    if (s.hp <= 0) {
      clearSeal(w)
      try { logEvent(getFake(gid), 'seal', `【镇海珠】${regionNameOf(s.region)}的封海被 ${e.nickname || e.user_id} 击破！`, now, { major: true, region: s.region }) } catch (err) { }
      e.reply(`💥 封印破碎！【${regionNameOf(s.region)}】的封海已解除。`)
      return true
    }
    saveWorld(w)
    e.reply(`⚔️ 你攻击了封印，造成 ${dmg} 伤害。\n${hpBar(s.hp, s.maxHp)}`)
    return true
  }
}
