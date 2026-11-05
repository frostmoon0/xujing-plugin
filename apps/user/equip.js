import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import Config from '../../model/Config.js'
import xujing_data from '../../components/xujing_data.js'
import { PARTS, QUALITY, EQUIP_TPL, ITEM_TPL, MATERIAL_TPL, getBag, saveBag, consumeBagItem, getTotalAttr, getEquipLevel, fmtEquip, fmtAttr, getItemAttr, getBagEquipEntries, autoEquipBest, equipTake, unequipReturn, equipSellPrice, gongfaSellPrice, GONGFA_TPL, fmtGongfaFx, getLearnedGongfa, isRainbowRef, getRainbowByRef, fmtRainbow, attrPower, itemIcon } from '../../components/equip_data.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { cleanOverCapacity } from '../../components/house.js'
/*修仙世界: 我的信息显示所在大区 / 出售装备按所在大区动态税率*/  
import { REGIONS, getWorld, getLoc, getRate, addTax, saveWorld, bossOf, regionNameOf, taxFor } from '../../components/world_data.js'
import { playerSectName, getFake, sectName, sectAlive, POS } from '../../components/fake_data.js'
import { getVault, sectRegion, injuryInfo } from '../../components/sect_system.js'
import { allRaids } from '../../components/raid_data.js'
import { calcCombatPower, getBuffs } from '../../components/fight.js'
import { getActivePetInfo } from '../../components/pet_data.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { rollRedReward, addDismantleMats, RED_DISMANTLE_COLOR_ORE, colorDismantleReward } from '../../components/equip_dismantle.js'
import { Wanhun, getWanhunPanel } from '../../components/wanhun_data.js'
import Yanghun from '../../components/yanghun_data.js'
import { getZhenhai, rankName as zhenhaiRankName, ZHENHAI_NAME } from '../../components/zhenhai_data.js'
const pendingChoice = {}
const pendingSellMode = {}
const SELL_CHOICE_TIMEOUT = 5 * 60 * 1000

function sellKey (e) { return `${e.group_id}:${e.user_id}` }
function pendingSellIsAll (e) {
    const key = sellKey(e)
    const pending = pendingSellMode[key]
    if (!pending || Date.now() - pending.time > SELL_CHOICE_TIMEOUT) {
        delete pendingSellMode[key]
        return false
    }
    return pending.mode === 'all'
}
function setPendingSellMode (e, mode) {
    pendingSellMode[sellKey(e)] = { mode, time: Date.now() }
}
function clearPendingSellMode (e) {
    delete pendingSellMode[sellKey(e)]
}

/** 将信息按板块均衡分到左右两区, 中间区占两列、背包区占三列 */
function splitInfoColumns (lines) {
    const sections = []
    let section = []
    for (const line of lines) {
        if (/^━━━/.test(line) && section.length) {
            sections.push(section)
            section = []
        }
        section.push(line)
    }
    if (section.length) sections.push(section)
    const columns = [[], [], []]
    const lengths = [0, 0]
    for (const current of sections) {
        const isBag = current.some(line => String(line).startsWith('━━━🎒 背包'))
        const index = isBag ? 2 : (lengths[0] <= lengths[1] ? 0 : 1)
        columns[index].push(...current)
        if (!isBag) {
            lengths[index] += current.reduce((sum, line) => sum + String(line).split('\n').length, 0)
        }
    }
    return columns.map(column => column.join('\n'))
}
function takeRedOne (items, name) {
  const it = items[name]
  if (!it || (it.count || 0) < 1) return true
  if (it.list && it.list.length) {
    it.list[0].count -= 1
    if (it.list[0].count <= 0) it.list.shift()
    if (it.list.length) it.attr = it.list[0].attr
    else delete it.list
  }
  it.count -= 1
  if (it.count <= 0) { delete items[name]; return true }
  return false
}
/** 材料入背包 */
function addMat (items, name, count) {
    addDismantleMats(items, { [name]: count })
}
/** 材料品质图标 */
function matIcon (name) {
  const q = MATERIAL_TPL[name] && MATERIAL_TPL[name].quality
  return (q && QUALITY[q]) ? QUALITY[q].icon : ''
}

export class equip extends plugin {
    constructor() {
        super({
            name: '武器装备',
            dsc: '武器、装备与背包系统',
            event: 'message',
            priority: 60,
            rule: [
                { reg: '^(@[^\\s#＃@]+)?\\s*[#＃]?\\s*(我的信息|我的老婆|家庭信息|全部信息|我的背包|我的(老公|对象))$', fnc: 'myinfo' },
                { reg: '^[#＃]?更换(武器|头盔|胸甲|裤子|鞋子|戒指)(.*)$', fnc: 'changeEquip' },
                { reg: '^[#＃]?脱下(武器|头盔|胸甲|裤子|鞋子|戒指|全部)$', fnc: 'takeoff' },
                { reg: '^[#＃]?(一键穿戴|一键装备|一键穿上|自动穿戴|穿最好的)$', fnc: 'autoequip' },
                { reg: '^[#＃]?(一键出售功法|出售功法|卖掉功法|出售功法书)(.*)$', fnc: 'sellGongfa' },
                { reg: '^[#＃]?(一键出售装备|出售装备|卖掉装备)(.*)$', fnc: 'sellEquip' },
                { reg: '^[#＃]?一键出售(.*)$', fnc: 'sellAll' },
                { reg: '^[#＃]?(分解红装)$', fnc: 'dismantleRed' },
                { reg: '^[#＃]?(分解彩装)$', fnc: 'dismantleColor' },
                { reg: '^[#＃]?(一键分解红装|全部分解红装)$', fnc: 'dismantleRedAll' },
                { reg: '^[#＃]?[0-9]+$', fnc: 'chooseEquip' }
            ]
        })
    }

    /** 获取群成员昵称 */
    async getNick(e, uid) {
        try {
            const memberMap = await e.group.getMemberMap();
            for (let aaa of memberMap) {
                if (String(aaa[1].user_id) == String(uid)) {
                    return aaa[1].card || aaa[1].nickname || ''
                }
            }
        } catch { }
        return ''
    }

    /** #我的信息(与#我的老婆公用):转发返回全部信息,老婆优先级最高 */
    async myinfo(e) {
        const user_id = e.user_id
        if (!e.group_id) {
            e.reply('请在群内使用该指令')
            return true
        }
        /* 支持 #我的信息 @别人 / 先@再#我的信息 查看对方信息(带防呆) */
        let atId = e.at
        if (!atId) {
            const m = String(e.msg || '').match(/@(\d+)/)
            if (m) atId = m[1]
        }
        let target = user_id
        let isSelf = true
        if (atId && String(atId) !== String(user_id)) {
            if (e.atme || e.atall) {
                e.reply('不可以这样哦~')
                return true
            }
            /* 防呆: 只能查看本群成员 */
            let inGroup = false
            try {
                const mm = await e.group.getMemberMap()
                for (const m of mm) {
                    if (String(m[1].user_id) === String(atId)) { inGroup = true; break }
                }
            } catch (err) { inGroup = true }
            if (!inGroup) {
                e.reply('对方不在本群，无法查看~')
                return true
            }
            target = atId
            isSelf = false
        }
        const filename = `${e.group_id}.json`
        try {
            /* 先静默结算自己的养魂阵；查看他人时只读，避免因查看替他人扣费 */
            let yanghunStatus = null
            try {
                yanghunStatus = isSelf
                    ? await Yanghun.status(target, e.group_id)
                    : { text: Yanghun.statusText(target, e.group_id) }
            } catch (err) { }
            const battlejson = await xujing_data.getQQYUserBattle(target, null, false, `${e.group_id}.json`)
            const homejson = await xujing_data.getQQYUserHome(target, null, filename, false)
            const housejson = await xujing_data.getQQYUserHouse(target, null, filename, false)
            const inpajson = await xujing_data.getQQYUserxiaoqie(target, null, filename, false)
            const b = battlejson[target]
            const h = homejson[target]
            const hs = housejson[target]
            const bag = getBag(target, e.group_id)
            const attr = getTotalAttr(bag)
            const equipLv = getEquipLevel(bag)
            const items = bag.items || {}
            /* 完整战力(境界+装备+功法+丹药, 与战斗同源) */
            const buff = await getBuffs(target, e.group_id)
            const combat = calcCombatPower(Number(b.level) || 0, bag, buff, e.group_id, target)
            const petInfo = getActivePetInfo(e.group_id, target)
            const sx = (inpajson[target] && inpajson[target].shuangxiu) || []
            const sxTime = (inpajson[target] && inpajson[target].shuangxiu_time) || 0
            /* 双修道侣显示昵称(取不到昵称才回退QQ号) */
            const sxNames = sx.length ? await Promise.all(sx.map(async (uid) => (await this.getNick(e, uid)) || String(uid))) : []
            /* 背包装备数: 按实际件数(穿上已扣count, count即背包未穿件数) */
            const equipCount = Object.keys(items).filter(n => EQUIP_TPL[n]).reduce((sum, n) => sum + ((items[n] && items[n].count) || 0), 0)
            /* 展示前顺带清理超员小妾 + 无房子自动补小破屋(仅查看自己时清理,看别人只读不修改) */
            let prunedNote = ''
            if (isSelf) {
                try {
                    const { removed: pruned, houseChanged } = cleanOverCapacity(homejson, housejson, inpajson)
                    if (pruned > 0) {
                        await xujing_data.getQQYUserxiaoqie(target, inpajson, filename, true)
                        prunedNote = `\n⚠️ 已自动清理${pruned}名超员小妾（房子容量不足）`
                    }
                    if (houseChanged) {
                        await xujing_data.getQQYUserHouse(target, housejson, filename, true)
                    }
                } catch (err) { }
            }
            // 全部信息合并成一张图片发送(不再用合并转发; 道侣头像不再单独展示)
            const loveTitle = isSelf ? '你的道侣' : 'ta 的道侣'
            const singleMsg = isSelf ? '现在的你还是一位单身贵族，没有道侣哦\n快用 #娶群友 找一个吧~' : 'ta 还是一位单身贵族，没有道侣~'
            /* 顶部显示被查看者名字 */
            const selfName = (await this.getNick(e, target)) || String(target)
            const textLines = [`👤 ${selfName}`]
            if (h && h.s !== 0) {
                const wname = await this.getNick(e, h.s)
                textLines.push(`💞 ${loveTitle}：${wname || h.s}`)
                textLines.push(`好感度：${h.love}`)
            } else {
                textLines.push(`💞 ${singleMsg}`)
            }
            textLines.push('')
            textLines.push('━━━✨ 境界 ✨━━━')
            textLines.push(`📍 所在大区：${regionNameOf(getLoc(getWorld(e.group_id), target))}`)
            textLines.push(`境界：${b.levelname}`)
            const atkMult = Number(buff.atk) || 1
            const petPart = petInfo ? ` + 灵兽${petInfo.power}` : ''
            textLines.push(`战力：${combat.power}（境界${combat.realmPower} + 装备${combat.equipPower}${petPart}${atkMult > 1 ? ` ×功法/丹药倍率${atkMult}` : ''}）`)
            textLines.push(petInfo
              ? `出战的灵兽：${petInfo.name}（${petInfo.stage}）· 战力 ${petInfo.power}（#收回宠物 收回）`
              : `出战的灵兽：无（#宠物出战 派灵兽助战）`)
            textLines.push(`灵力：${b.experience}${(b.accum || 0) > 0 ? `（累积+${b.accum}，突破后并入）` : ''}`)
            textLines.push(`灵石：${h.money}`)
            textLines.push(`业力：${Number(h.karma) || 0}`)
            const wanhunPanel = getWanhunPanel(target, e.group_id)
            textLines.push('━━━🔮 法宝 ━━━')
            textLines.push(wanhunPanel.text)
            const zhenhai = getZhenhai(bag)
            if (zhenhai) {
                const cd = Math.max(0, Number(zhenhai.cooldownUntil) - Date.now())
                textLines.push(`🔮${ZHENHAI_NAME}（${zhenhaiRankName(zhenhai.rank)}）${cd > 0 ? `｜冷却 ${Math.ceil(cd / 60000)} 分钟` : '｜已就绪'}`)
            }
            /* 养魂阵: 上方已静默补算, 仅显示当前状态 */
            if (yanghunStatus) textLines.push('', yanghunStatus.text)
            /* 宗门情况 */
            const sInfo = this.sectInfo(target, e.group_id)
            if (sInfo) textLines.push('', sInfo)
            textLines.push('')
            textLines.push('━━━🏠 住所 ━━━')
            textLines.push(`名字：${hs.name}`)
            textLines.push(`可居住人数：${Number(hs.space) === -1 ? '无上限' : (hs.space || 0) + '人'}`)
            textLines.push(`价值：${hs.price}灵石`)
            textLines.push(`好感倍率：${hs.loveup}`)
            textLines.push(`挂机/摆摊加成：${hs.work}%`)
            textLines.push(`修炼加成：${hs.cultivate}%`)
            textLines.push('')
            textLines.push('━━━🛌 双修 ━━━')
            textLines.push(`双修道侣：${sxNames.length ? sxNames.join('、') : '无'}`)
            textLines.push(`已发起双修：${sxTime} 次${prunedNote}`)
            textLines.push('')
            textLines.push('━━━⚔ 装备 ⚔━━━')
            textLines.push(this.equippedStr(bag))
            textLines.push(`装备战力：${attr.power}（等效+${equipLv}个小境界）`)
            textLines.push(`攻击+${attr.atk} 防御+${attr.def} 生命+${attr.hp}`)
            textLines.push(`背包装备：${equipCount} 件`)
            textLines.push('')
            textLines.push('━━━🎒 背包 ━━━')
            textLines.push(this.bagStr(bag))
            const gfInfo = await this.gongfaInfo(target)
            if (gfInfo && gfInfo[0]) textLines.push('', gfInfo[0])
            const stInfo = await this.statusInfo(target)
            if (stInfo && stInfo[0]) textLines.push('', stInfo[0])
            /* 当前状态板块(负伤/被俘/宗门战争/洗劫/伏击/仆从) */
            const curState = await this.stateInfo(target, e.group_id)
            if (curState) textLines.push('', curState)
            /* 七等分宽图：左侧占两列、中间占两列、背包占三列，渲染失败回退纯文字 */
            const [column1Content, column2Content, column3Content] = splitInfoColumns(textLines)
            const infoImg = await textToImg(textLines.join('\n'), undefined, {
                columns: 7,
                column1Content,
                column2Content,
                column3Content
            })
            if (infoImg) e.reply(infoImg)
            else e.reply(textLines.join('\n'))
        } catch (err) {
            e.reply(`查询失败：${err.message}`)
        }
        return true
    }

    /** 宗门情况板块: 玩家所属宗门概况(未加入则提示) */
    sectInfo(uid, gid) {
        try {
            const posCn = (pos) => (POS[pos] && POS[pos].cn) || pos || '弟子'
            const f = getFake(gid)
            const p = f.players && f.players[String(uid)]
            if (!p || !p.sect) return '━━━🏯 宗门 ━━━\n尚未加入宗门（#创建宗门 或 由宗门邀请加入）'
            const sid = p.sect
            const s = f.sects && f.sects[sid]
            if (!s) return '━━━🏯 宗门 ━━━\n所属宗门已不存在（可能被灭门/重建）'
            const sm = f.sectMap[sid] || {}
            const owner = s.owner ? (f.players[s.owner] || null) : null
            const fac = s.facilities || {}
            const v = getVault(f, sid)
            const areas = Object.keys(f.areas || {}).filter(a => f.areas[a] === sid)
            const lines = [
                '━━━🏯 宗门 ━━━',
                `宗门：${sectName(f, sid)}（${regionNameOf(sectRegion(f, sid))}）`,
                `我的身份：${posCn(p.pos)}　贡献：${p.contribution || 0}`,
                `宗主：${owner ? `🌙${owner.name}（玩家）` : (sm.zongzhu || '（空缺·副宗代掌）')}`,
                `门人：${sectAlive(f, sid).length} 人　宝库灵石：${v ? (v.stones || 0) : 0}`,
                `设施：演武场${fac.yanwu || 0}/护山阵${fac.hushan || 0}/灵脉${fac.lingmai || 0}级`,
                `地盘：${areas.length ? areas.join('、') : '无'}${areas.length ? '（#天下小区 查看）' : '（#攻打 夺取）'}`
            ]
            return lines.join('\n')
        } catch (err) {
            return '━━━🏯 宗门 ━━━\n宗门信息获取失败'
        }
    }

    /** 功法信息板块: 当前运转功法+效果+已学数量 */
    async gongfaInfo(uid) {
        try {
            const learned = await getLearnedGongfa(uid)
            const active = await redis.get(`xujing:gongfa-active:${uid}`)
            const names = Object.keys(learned || {})
            let lines = [`━━━📖 功法 ━━━`]
            if (!names.length) {
                lines.push('尚未学会任何功法，去 #藏宝阁 买一本功法书吧~')
            } else {
                names.sort((a, b) => (GONGFA_TPL[b].quality || 0) - (GONGFA_TPL[a].quality || 0))
                lines.push(`已学 ${names.length} 本：${names.map(n => {
                    const q = QUALITY[GONGFA_TPL[n].quality] || { icon: '' }
                    return `${q.icon}${n}`
                }).join('、')}`)
            }
            if (active && GONGFA_TPL[active]) {
                const q = QUALITY[GONGFA_TPL[active].quality] || { icon: '' }
                lines.push(`\n✅ 当前运转：${q.icon}《${active}》`)
                lines.push(`   效果：${fmtGongfaFx(GONGFA_TPL[active].fx)}`)
                lines.push('\n#运转功法 <名> 可切换 · #取消功法 停止')
            } else {
                lines.push('\n当前未运转功法（#运转功法 <名> 激活）')
            }
            return [lines.join('\n')]
        } catch (err) {
            return ['━━━📖 功法 ━━━\n功法信息获取失败']
        }
    }

    /** 状态板块: 丹药buff生效情况(含剩余时间) */
    async statusInfo(uid) {
        const buffs = [
            { key: 'xujing:atk-buff', name: '惊鸿丹', desc: '攻击+20%' },
            { key: 'xujing:def-buff', name: '玉甲丹', desc: '防御+20%' },
            { key: 'xujing:hp-buff', name: '凝露丹', desc: '生命+20%' },
            { key: 'xujing:crit-buff', name: '慧心丹', desc: '暴击+30%' },
            { key: 'xujing:cdmg-buff', name: '摄魂丹', desc: '爆伤+50%' },
            { key: 'xujing:baolv-buff', name: '聚宝丹', desc: '幸运提升' },
            { key: 'xujing:lingxi-buff', name: '灵犀丹', desc: '双修收益翻倍' },
            { key: 'xujing:xingyun-buff', name: '行运丹', desc: '挂机收益翻倍' }
        ]
        const active = []
        for (const b of buffs) {
            try {
                const ttl = await redis.ttl(`${b.key}:${uid}`)
                if (ttl > 0) {
                    const h = Math.floor(ttl / 3600)
                    const m = Math.floor((ttl % 3600) / 60)
                    active.push(`· ${itemIcon(b.name)}${b.name}（${b.desc}，剩 ${h}时${m}分）`)
                }
            } catch (err) { }
        }
        const lines = ['━━━💊 状态 ━━━']
        if (active.length) lines.push(...active)
        else lines.push('当前无丹药加成，去 #丹阁 或 #配方台 获取丹药吧~')
        lines.push('', '（丹药效果持续1小时，到期自然失效）')
        return [lines.join('\n')]
    }

    /** 当前状态板块: 负伤/被俘/宗门战争/洗劫/伏击/仆从 (#我的信息 显示) */
    async stateInfo(uid, gid) {
        const lines = []
        const f = getFake(gid)
        /* 负伤(宗门/散修通用) */
        try {
            const pp = f.players && f.players[String(uid)]
            const injSrc = (pp && pp.injury) || (f.injuries && f.injuries[String(uid)]) || null
            if (injSrc && injSrc.level) {
                const inj = injuryInfo({ injury: injSrc }, Date.now())
                if (inj.level > 0) lines.push(`⚠️ 伤势：${['', '轻伤', '中伤', '重伤'][inj.level]}（战力-${inj.pct}%，还需 ${inj.remainMin} 分钟恢复）`)
            }
        } catch (err) { }
        /* 被俘(redis) */
        try {
            const cap = await redis.get(`xujing:captive:${gid}:${uid}`)
            if (cap) lines.push(`⛓️ 被俘中：被【${cap}】扣押（无法行动，等战争处置或 #拯救）`)
        } catch (err) { }
        /* 宗门战争: 本宗攻打/被攻打, 玩家参战 */
        try {
            const p = f.players && f.players[String(uid)]
            const atks = f.sectAttacks || []
            if (p && p.sect) {
                const def = atks.filter(a => a.phase !== 'done' && ((a.targetType === 'sect' && a.target === p.sect) || (a.targetType === 'area' && f.areas[a.target] === p.sect)))
                const atk = atks.filter(a => a.phase !== 'done' && a.atkSect === p.sect)
                if (def.length) lines.push(`⚔️ 宗门防守中：本宗正被攻打 ${def.length} 处（#驰援 / #集结仆从 可调兵）`)
                if (atk.length) lines.push(`🗡️ 宗门攻伐中：本宗正攻打 ${atk.length} 处（#驰援 / #集结仆从 可增援）`)
            }
            if (atks.some(a => a.phase !== 'done' && (a.atkPlayers || []).map(String).includes(String(uid)))) lines.push('⚔️ 你正随军攻打中')
            if (atks.some(a => a.phase !== 'done' && (a.defPlayers || []).map(String).includes(String(uid)))) lines.push('🛡️ 你正参与守城中')
        } catch (err) { }
        /* 洗劫藏宝阁 */
        try {
            const raids = await allRaids()
            const mine = raids.find(r => String(r.gid) === String(gid) && String(r.uid) === String(uid))
            if (mine) lines.push(`💰 洗劫藏宝阁中（${mine.st.phase === 'escape' ? '得手后逃亡' : '正在搬运'}，#洗劫状态 查看）`)
        } catch (err) { }
        /* 伏击中 */
        try {
            const amb = await redis.get(`xujing:ambush:${gid}:${uid}`)
            if (amb) {
                const st = JSON.parse(amb)
                const ph = { prep: '埋伏准备中', ready: '蹲守猎物中', waiting: '有情况待抉择', won: '已制服猎物待处置' }[st.phase] || '伏击中'
                lines.push(`🪤 伏击中：${ph}（#伏击状态 查看）`)
            }
        } catch (err) { }
        /* 仆从 */
        try {
            const raw = await redis.get(`xujing:ambush-servant:${gid}:${uid}`)
            const list = raw ? JSON.parse(raw) : []
            const alive = list.filter(x => { const p2 = f.roster[x.name]; return p2 && p2.alive && p2.servantOf === String(uid) })
            if (alive.length) lines.push(`🔗 仆从 ${alive.length} 名（#我的仆从 查看；#集结仆从 可带仆从打仗）`)
        } catch (err) { }
        /* 万魂窟与失魂 */
        try {
            const cave = await Wanhun.caveStatus(uid, gid)
            if (cave !== '当前不在万魂窟。') lines.push(`🕯️ ${cave}`)
        } catch (err) { }
        if (!lines.length) return null
        return ['━━━📡 当前状态 ━━━', ...lines].join('\n')
    }

    /** 当前穿戴文本 */
    equippedStr(bag) {
        const equipped = bag.equipped || {}
        const equippedAttr = bag.equippedAttr || {}
        let lines = []
        for (const part of Object.keys(PARTS)) {
            const name = equipped[part]
            if (name && EQUIP_TPL[name]) {
                const ea = equippedAttr[part]
                lines.push(`${PARTS[part]}：${fmtEquip(name, 1, (ea && Object.keys(ea).length) ? ea : getItemAttr(bag, name))}`)
            } else if (isRainbowRef(name)) {
                const w = getRainbowByRef(bag, name)
                lines.push(w ? `${PARTS[part]}：${fmtRainbow(w)}（绑定）` : `${PARTS[part]}：未装备`)
            } else {
                lines.push(`${PARTS[part]}：未装备`)
            }
        }
        return lines.join('\n') + '\n'
    }

    /** 背包文本:丹药 + 装备(每件一行,精确到件; 穿上的那件不重复显示) */
    bagStr(bag) {
        const items = bag.items || {}
        const keys = Object.keys(items)
        let msg = ''
        // 丹药(道具)
        const pills = keys.filter(n => ITEM_TPL[n])
        if (pills.length) {
            msg += `💊 丹药：\n`
            for (const n of pills) {
                msg += `${ITEM_TPL[n].icon}${n} ×${items[n].count}（${ITEM_TPL[n].desc}）\n`
            }
        }
        // 秘境材料(药材/矿物)
        const mats = keys.filter(n => MATERIAL_TPL[n])
        if (mats.length) {
            msg += `🌿 材料：\n`
            for (const n of mats) {
                const m = MATERIAL_TPL[n]
                msg += `${QUALITY[m.quality].icon}${n} ×${items[n].count}\n`
            }
        }        // 功法书(未修炼): 修炼后从背包消耗
        const gongfas = keys.filter(n => GONGFA_TPL[n])
        if (gongfas.length) {
            msg += `\n📖 功法书：\n`
            for (const n of gongfas) {
                const gq = GONGFA_TPL[n].quality || 0
                msg += `${QUALITY[gq].icon}《${n}》×${items[n].count}（#修炼功法 ${n}）\n`
            }
        }        // 装备: 每件一行(精确到件)。背包只含未穿件(穿上那件已从背包扣掉), 全部照常显示
        const shown = getBagEquipEntries(bag)
        if (shown.length) {
            const groups = {}
            for (const item of shown) {
                const t = EQUIP_TPL[item.name]
                groups[t.quality] = groups[t.quality] || []
                groups[t.quality].push(fmtEquip(item.name, 1, item.attr))
            }
            for (const q of Object.keys(groups).map(Number).sort((a, b) => b - a)) {
                if (!QUALITY[q]) continue
                msg += `\n${QUALITY[q].icon} 品质：\n${groups[q].join('\n')}\n`
            }
        }
        // 成长型彩虹神兵(绑定,不可赠送/出售/拍卖): 只显示未穿戴的
        if (bag.rainbows && bag.rainbows.length) {
            const equippedRefs = Object.values(bag.equipped || {})
            const rws = bag.rainbows.filter(w => !equippedRefs.includes('rainbow:' + w.id))
            if (rws.length) {
                msg += `\n🌈 成长神兵（绑定）：\n`
                for (const w of rws) msg += `${fmtRainbow(w)}\n`
            }
        }
        return msg
    }

    /** #更换武器/头盔/胸甲/裤子/鞋子/戒指 */
    async changeEquip(e) {
        const m = e.msg.match(/^[#＃]?更换(武器|头盔|胸甲|裤子|鞋子|戒指)(.*)$/)
        if (!m) return
        const partCN = m[1]
        const nameArg = (m[2] || '').trim()
        const part = Object.keys(PARTS).find(p => PARTS[p] === partCN)
        const bag = getBag(e.user_id, e.group_id)
        const items = bag.items || {}
        // 未指定名字: 列出该部位可装备(同名多属性按属性分组各占一个序号),发数字选择
        if (!nameArg) {
            let list = []
            for (const n of Object.keys(items)) {
                const t = EQUIP_TPL[n]
                if (!t || t.type !== part) continue
                const it = items[n]
                const groups = (it && Array.isArray(it.list) && it.list.length)
                    ? it.list.map(g => ({ name: n, attr: g.attr || {}, count: g.count }))
                    : [{ name: n, attr: (it && it.attr) || {}, count: it ? it.count : 0 }]
                for (const g of groups) {
                    if ((g.count || 0) <= 0) continue
                    /* 精确到件: 同属性多件也各占一个序号 */
                    for (let i = 0; i < g.count; i++) {
                        list.push({ ref: g.name + '#' + list.length, name: g.name, attr: g.attr, label: fmtEquip(g.name, 1, g.attr), quality: t.quality || 0 })
                    }
                }
            }
            /* 彩虹武器加入武器选择(每把独立,品质按7彩) */
            if (part === 'weapon' && bag.rainbows && bag.rainbows.length) {
                for (const w of bag.rainbows) {
                    list.push({ ref: 'rainbow:' + w.id, name: 'rainbow:' + w.id, attr: null, label: fmtRainbow(w), quality: 7 })
                }
            }
            if (!list.length) {
                e.reply(`你的背包里没有可更换的${partCN}`)
                return true
            }
            /* 交互抢占: 直接终止旧交互(逛街/渡劫), 转为换装选择 */
            await forceLock(e.group_id, e.user_id, 'equip')
            /* 品质高优先, 同品质按属性战力从高到低(同名多属性也分开排) */
            list.sort((a, b) => {
                if (b.quality !== a.quality) return b.quality - a.quality
                return attrPower(b.attr || {}) - attrPower(a.attr || {})
            })
            pendingChoice[e.user_id] = { part, partCN, list, time: Date.now() }
            const cur = bag.equipped?.[part] || ''
            /* 当前穿着属性: 用 equippedAttr(穿上的那组), 不用 getItemAttr(已穿不在背包会对金/红装重新随机=显示假属性) */
            const curAttr = (cur && !isRainbowRef(cur)) ? (bag.equippedAttr?.[part] || getItemAttr(bag, cur)) : null
            let msg = `当前${partCN}：${cur ? (isRainbowRef(cur) ? fmtRainbow(getRainbowByRef(bag, cur)) : fmtEquip(cur, 1, curAttr)) : '未装备'}\n请发送数字选择要穿戴的${partCN}（同名装备按属性分开选）：\n`
            list.forEach((it, i) => {
                msg += `${i + 1}. ${it.label}\n`
            })
            msg += `\n（回复对应数字即可穿戴，或发送 #更换${partCN} 装备名）`
            e.reply(msg)
            return true
        }
        // 精确匹配(普通装备 + 彩虹武器按名字)
        let found = null
        if (items[nameArg] && EQUIP_TPL[nameArg] && EQUIP_TPL[nameArg].type === part) {
            found = nameArg
        } else if (part === 'weapon' && bag.rainbows && bag.rainbows.length) {
            const rw = bag.rainbows.filter(w => w.name === nameArg)
            if (rw.length === 1) found = 'rainbow:' + rw[0].id
            else if (rw.length > 1) { e.reply('找到多把同名彩虹武器，请发送完整名字~'); return true }
            else {
                const rp = bag.rainbows.filter(w => w.name.includes(nameArg))
                if (rp.length === 1) found = 'rainbow:' + rp[0].id
                else if (rp.length > 1) { e.reply('找到多把彩虹武器，请发送完整名字~'); return true }
            }
        }
        if (!found) {
            const partial = Object.keys(items).filter(n => n.includes(nameArg) && EQUIP_TPL[n] && EQUIP_TPL[n].type === part)
            if (partial.length === 1) {
                found = partial[0]
            } else if (partial.length > 1) {
                e.reply(`找到多个符合条件的装备：${partial.map(n => `${itemIcon(n)}${n}`).join('、')}，请发送完整装备名`)
                return true
            }
        }
        if (!found || (found && !isRainbowRef(found) && (!EQUIP_TPL[found] || EQUIP_TPL[found].type !== part))) {
            e.reply(`背包里没有叫「${nameArg}」的${partCN}`)
            return true
        }
        // 穿装备: 脱下旧的还回背包1件, 穿上新的从背包扣1件(彩虹武器不涉及背包)
        // 注意: 同名换装(old===found 如 月华戒→月华戒另一件)也必须先脱下还回, 否则旧属性组凭空消失(丢装备)
        bag.equipped = bag.equipped || {}
        bag.equippedAttr = bag.equippedAttr || {}
        const old = bag.equipped[part]
        if (old && !isRainbowRef(old)) unequipReturn(bag, part)
        let takeAttr = null
        if (found && !isRainbowRef(found)) {
            takeAttr = equipTake(bag, part, found)
            if (!takeAttr) {
                e.reply(`背包里没有可穿的「${nameArg}」了~`)
                return true
            }
        } else if (isRainbowRef(found)) {
            bag.equipped[part] = found
        }
        saveBag(e.user_id, bag, e.group_id)
        const total = getTotalAttr(bag)
        const equipLv = getEquipLevel(bag)
        let msg
        if (isRainbowRef(found)) {
            const w = getRainbowByRef(bag, found)
            msg = `成功装备 ${fmtRainbow(w)}！`
        } else {
            const t = EQUIP_TPL[found]
            const q = QUALITY[t.quality]
            msg = `成功装备 ${q.icon}${found}！\n${fmtAttr(takeAttr || getItemAttr(bag, found))}`
        }
        if (old && old !== found) msg += `\n（替换下了 ${isRainbowRef(old) ? '🌈' + (getRainbowByRef(bag, old) || {}).name : itemIcon(old) + old}）`
        msg += `\n当前总战力：${total.power}（等效+${equipLv}个小境界）`
        e.reply(msg)
        return true
    }

    /** #脱下:手动脱下指定部位(脱了不会自动穿回,想裸体也方便) */
    async takeoff(e) {
        const m = e.msg.match(/^[#＃]?脱下(武器|头盔|胸甲|裤子|鞋子|戒指|全部)$/)
        if (!m) return
        const partCN = m[1]
        const bag = getBag(e.user_id, e.group_id)
        bag.equipped = bag.equipped || {}
        let off = []
        if (partCN === '全部') {
            for (const part of Object.keys(PARTS)) {
                if (bag.equipped[part]) {
                    off.push(isRainbowRef(bag.equipped[part]) ? `🌈${(getRainbowByRef(bag, bag.equipped[part]) || {}).name}` : itemIcon(bag.equipped[part]) + bag.equipped[part])
                    unequipReturn(bag, part)
                }
            }
        } else {
            const part = Object.keys(PARTS).find(p => PARTS[p] === partCN)
            if (!bag.equipped[part]) {
                e.reply(`你现在没有装备${partCN}`)
                return true
            }
            off.push(isRainbowRef(bag.equipped[part]) ? `🌈${(getRainbowByRef(bag, bag.equipped[part]) || {}).name}` : itemIcon(bag.equipped[part]) + bag.equipped[part])
            unequipReturn(bag, part)
        }
        saveBag(e.user_id, bag, e.group_id)
        const total = getTotalAttr(bag)
        let msg = off.length
            ? `已脱下：${off.join('、')}\n当前总战力：${total.power}`
            : `你现在没有穿戴任何装备`
        e.reply(msg)
        return true
    }

    /** #数字选择:上一步列出装备后,用户直接发数字穿戴 */
    async chooseEquip(e) {
        /* 一键出售功法: 当前交互锁为 sellgf 时优先处理数字 */
        if (await isCurrent(e.group_id, e.user_id, 'sellgf')) {
            if (await guardActionLocked(e)) return true
            return await this.sellGongfa(e)
        }
        /* 一键出售: 当前交互锁为 sell 时优先处理数字 */
        if (await isCurrent(e.group_id, e.user_id, 'sell')) {
            if (await guardActionLocked(e)) return true
            return pendingSellIsAll(e) ? await this.sellAll(e) : await this.sellEquip(e)
        }
        /* 分解红装: 仅当 dismantle 在栈顶才处理数字(被其它交互埋住则让位, 避免误分解被埋的红装) */
        if (await isCurrent(e.group_id, e.user_id, 'dismantle')) {
            if (await guardActionLocked(e)) return true
            return await this.dismantleRedPick(e)
        }
        /* 分解彩装: 仅当 dismantle-color 在栈顶才处理数字(被其它交互埋住则让位, 保留待分解状态) */
        if (await isCurrent(e.group_id, e.user_id, 'dismantle-color')) {
            if (await guardActionLocked(e)) return true
            return await this.dismantleColorPick(e)
        }
        const pc = pendingChoice[e.user_id]
        // 无待选择列表或超时(5分钟),不处理(放行给其他功能,必须返回false否则会吞掉其他插件的数字指令)
        if (!pc || Date.now() - pc.time > 5 * 60 * 1000) {
            /* 换装状态过期/丢失: 摘除自己的锁, 让后续交互正常路由 */
            await unlock(e.group_id, e.user_id, 'equip')
            delete pendingChoice[e.user_id]
            return false
        }
        /* 校验: 仅当换装在栈顶才处理(被逛街/渡劫埋住则让位, 保留换装状态等回到栈顶再恢复) */
        if (!(await isCurrent(e.group_id, e.user_id, 'equip'))) {
            return false
        }
        /* 状态锁复查: 洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态下禁止用数字换装(战斗中换装=玩家自身操作, skipBattle 豁免战斗玩法锁, 天牢/被俘/失魂等惩罚锁照拦) */
        if (await guardActionLocked(e, undefined, { skipBattle: true })) return true
        const num = parseInt(e.msg.replace('#', ''))
        const idx = num - 1
        if (isNaN(num) || idx < 0 || idx >= pc.list.length) {
            e.reply(`请输入 1~${pc.list.length} 之间的数字`)
            return true
        }
        const entry = pc.list[idx]
        const found = entry.name
        delete pendingChoice[e.user_id]
        await unlock(e.group_id, e.user_id, 'equip')
        // 穿上: 脱下旧的还回背包1件, 穿上新的从背包扣1件(彩虹武器不涉及背包)
        // 注意: 同名换装(old===found)也必须先脱下还回, 否则旧属性组凭空消失(丢装备)
        const bag = getBag(e.user_id, e.group_id)
        bag.equipped = bag.equipped || {}
        bag.equippedAttr = bag.equippedAttr || {}
        const old = bag.equipped[pc.part]
        if (old && !isRainbowRef(old)) unequipReturn(bag, pc.part)
        let takeAttr = null
        if (found && !isRainbowRef(found)) {
            /* 穿选中的具体属性组(同名多属性已在列表分开, 不再固定取第一组) */
            takeAttr = equipTake(bag, pc.part, found, entry.attr || null)
            if (!takeAttr) {
                e.reply(`背包里没有可穿的「${entry.label}」了~`)
                return true
            }
        } else if (isRainbowRef(found)) {
            bag.equipped[pc.part] = found
        }
        saveBag(e.user_id, bag, e.group_id)
        const total = getTotalAttr(bag)
        const equipLv = getEquipLevel(bag)
        let msg
        if (isRainbowRef(found)) {
            const w = getRainbowByRef(bag, found)
            msg = `成功装备 ${fmtRainbow(w)}！`
        } else {
            const t = EQUIP_TPL[found]
            const q = QUALITY[t.quality]
            msg = `成功装备 ${q.icon}${found}！\n${fmtAttr(takeAttr || getItemAttr(bag, found))}`
        }
        if (old && old !== found) msg += `\n（替换下了 ${isRainbowRef(old) ? '🌈' + (getRainbowByRef(bag, old) || {}).name : itemIcon(old) + old}）`
        msg += `\n当前总战力：${total.power}（等效+${equipLv}个小境界）`
        e.reply(msg)
        return true
    }

    /** #分解红装: 弹出选择(序号)分解背包里哪件红装 */
    async dismantleRed(e) {
        await unlock(e.group_id, e.user_id, 'dismantle')
        const bag = getBag(e.user_id, e.group_id)
        const items = bag.items || {}
        const list = Object.keys(items)
            .filter(n => EQUIP_TPL[n] && EQUIP_TPL[n].quality === 6 && (items[n].count || 0) > 0)
            .sort()
            .map(n => ({ name: n, count: items[n].count }))
        if (!list.length) {
            e.reply('你背包里没有可分解的红装（🔴品质6，穿在身上的不算）~')
            return true
        }
        await forceLock(e.group_id, e.user_id, 'dismantle')
        pendingChoice[e.user_id] = { type: 'dismantle', list: list.map(x => ({ name: x.name })), time: Date.now() }
        let msg = '🔴 请发送数字选择要分解的红装（每次分解 1 件，穿在身上的不分解）：\n'
        list.forEach((it, i) => {
            msg += `${i + 1}. 🔴${it.name} ×${it.count}\n`
        })
        msg += `\n回复对应数字即可分解；或 #一键分解红装 全部拆掉`
        e.reply(msg)
        return true
    }

    /** 数字选择分解红装(由 chooseEquip 转发) */
    async dismantleRedPick(e) {
        const pc = pendingChoice[e.user_id]
        if (!pc || pc.type !== 'dismantle' || Date.now() - pc.time > 5 * 60 * 1000) {
            delete pendingChoice[e.user_id]
            await unlock(e.group_id, e.user_id, 'dismantle')
            return false
        }
        const num = parseInt(e.msg.replace('#', ''))
        const idx = num - 1
        if (isNaN(num) || idx < 0 || idx >= pc.list.length) {
            e.reply(`请输入 1~${pc.list.length} 之间的数字`)
            return true
        }
        const name = pc.list[idx].name
        delete pendingChoice[e.user_id]
        await unlock(e.group_id, e.user_id, 'dismantle')
        const bag = getBag(e.user_id, e.group_id)
        const items = bag.items || {}
        if (!items[name] || (items[name].count || 0) < 1) {
            e.reply(`背包里没有可分解的「${name}」了~`)
            return true
        }
        takeRedOne(items, name)
        const r = rollRedReward()
        for (const [m, c] of Object.entries(r.mats)) addMat(items, m, c)
        saveBag(e.user_id, bag, e.group_id)
        const matTxt = Object.entries(r.mats).map(([m, c]) => `${matIcon(m)}${m}×${c}`).join('、')
        e.reply(`🔨 已分解 🔴${name} ×1\n返还材料：${matTxt}${r.color ? `\n✨ 额外获得 🌈${RED_DISMANTLE_COLOR_ORE}×1！` : ''}`)
        return true
    }

    /** #分解彩装: 弹出选择(序号)分解背包里哪件彩装 */
    async dismantleColor(e) {
        const bag = getBag(e.user_id, e.group_id)
        const list = getBagEquipEntries(bag)
            .filter(entry => EQUIP_TPL[entry.name] && EQUIP_TPL[entry.name].quality === 7)
            .map(entry => ({
                name: entry.name,
                attr: entry.attr || {},
                label: fmtEquip(entry.name, 1, entry.attr || {})
            }))
        if (!list.length) {
            e.reply('你背包里没有可分解的彩装（🌈品质7，穿在身上的不算）~')
            return true
        }
        await forceLock(e.group_id, e.user_id, 'dismantle-color')
        pendingChoice[e.user_id] = { type: 'dismantle-color', list, time: Date.now() }
        let msg = '🌈 请发送数字选择要分解的彩装（每次分解1件，返还制造材料的一半）：\n'
        list.forEach((it, i) => {
            msg += `${i + 1}. ${it.label}\n`
        })
        e.reply(msg)
        return true
    }

    /** 数字选择分解彩装(由 chooseEquip 转发) */
    async dismantleColorPick(e) {
        const pc = pendingChoice[e.user_id]
        if (!pc || pc.type !== 'dismantle-color' || Date.now() - pc.time > 5 * 60 * 1000) {
            delete pendingChoice[e.user_id]
            await unlock(e.group_id, e.user_id, 'dismantle-color')
            return false
        }
        /* 校验: 仅当 dismantle-color 在栈顶才处理(被其它交互埋住则让位, 保留待分解状态等回到栈顶再恢复) */
        if (!(await isCurrent(e.group_id, e.user_id, 'dismantle-color'))) {
            return false
        }
        const num = parseInt(String(e.msg || '').replace('#', ''), 10)
        const idx = num - 1
        if (isNaN(num) || idx < 0 || idx >= pc.list.length) {
            e.reply(`请输入 1~${pc.list.length} 之间的数字`)
            return true
        }
        const entry = pc.list[idx]
        delete pendingChoice[e.user_id]
        await unlock(e.group_id, e.user_id, 'dismantle-color')
        const bag = getBag(e.user_id, e.group_id)
        const items = bag.items || {}
        if (!consumeBagItem(bag, entry.name, 1, entry.attr)) {
            e.reply(`背包里没有可分解的「${entry.label}」了~`)
            return true
        }
        const reward = colorDismantleReward()
        addDismantleMats(items, reward)
        saveBag(e.user_id, bag, e.group_id)
        const matTxt = Object.entries(reward).map(([name, count]) => `${matIcon(name)}${name}×${count}`).join('、')
        e.reply(`🔨 已分解 ${entry.label}\n返还材料：${matTxt}`)
        return true
    }

    /** #一键分解红装: 分解背包里所有红装 */
    async dismantleRedAll(e) {
        const bag = getBag(e.user_id, e.group_id)
        const items = bag.items || {}
        const names = Object.keys(items).filter(n => EQUIP_TPL[n] && EQUIP_TPL[n].quality === 6 && (items[n].count || 0) > 0)
        if (!names.length) {
            e.reply('你背包里没有可分解的红装（🔴品质6，穿在身上的不算）~')
            return true
        }
        const reward = {}
        let color = 0
        let done = 0
        for (const name of names) {
            const cnt = items[name].count || 0
            for (let i = 0; i < cnt; i++) {
                const r = rollRedReward()
                for (const [m, c] of Object.entries(r.mats)) reward[m] = (reward[m] || 0) + c
                color += r.color
            }
            delete items[name]
            done += cnt
        }
        for (const [m, c] of Object.entries(reward)) addMat(items, m, c)
        saveBag(e.user_id, bag, e.group_id)
        const matTxt = Object.entries(reward).map(([m, c]) => `${matIcon(m)}${m}×${c}`).join('、')
        e.reply(`🔨 已一键分解 🔴红装 ×${done}\n返还材料：${matTxt}${color ? `\n✨ 额外获得 🌈${RED_DISMANTLE_COLOR_ORE}×${color}！` : ''}`)
        return true
    }

    /** #一键穿戴:穿上背包里所有部位最好的装备 */
    async autoequip(e) {
        const user_id = e.user_id
        const bag = getBag(user_id, e.group_id)
        const changed = autoEquipBest(bag)
        saveBag(user_id, bag, e.group_id)
        const total = getTotalAttr(bag)
        const equipLv = getEquipLevel(bag)
        // 长文本用合并转发包裹(避免刷屏)
        const msgArr = [
            `✨ 已一键穿上背包中最好的装备！`,
            changed.length ? `本次新穿戴：${changed.map(name => `${itemIcon(name)}${name}`).join('、')}` : `（你已经穿着当前最优装备）`,
            this.equippedStr(bag),
            `装备战力：${total.power}（等效+${equipLv}个小境界）`
        ]
        Config.getforwardMsg(msgArr, e)
        return true
    }

    /** #一键出售 N: 同时出售 N 品质及以下的未穿戴装备和功法书; 红装/红彩功法不可出售 */
    async sellAll(e) {
        await unlock(e.group_id, e.user_id, 'sell')//先释放旧的出售占用
        const m = String(e.msg || '').match(/([1-7])/)
        const maxQ = m ? parseInt(m[1]) : 0
        if (maxQ >= 6) {
            clearPendingSellMode(e)
            e.reply('红色装备、红/彩色功法不可出售哦~ 请选择 1~5')
            return true
        }
        if (maxQ < 1 || maxQ > 5) {
            setPendingSellMode(e, 'all')
            await forceLock(e.group_id, e.user_id, 'sell')//建立出售交互(压栈选择, 不终止下层交互)
            e.reply(`请选择要出售的品质（同时出售该品质及以下的未穿戴装备和功法书，红色装备/红彩功法不可出售）：
1. ⚪ 白色及以下
2. 🟢 绿色及以下
3. 🔵 蓝色及以下
4. 🟣 紫色及以下
5. 🟡 黄色/金色及以下
直接回复数字选择~（去逛街/换装等会取消出售）`)
            return true
        }
        clearPendingSellMode(e)
        const id = e.user_id
        const filename = `${e.group_id}.json`
        const bag = getBag(id, e.group_id)
        const items = bag.items || {}
        let total = 0
        const sold = []//{kind,name,count,price}
        for (const name of Object.keys(items)) {
            const equip = EQUIP_TPL[name]
            const gongfa = GONGFA_TPL[name]
            if (equip) {
                if ((equip.quality || 0) > maxQ) continue
                const it = items[name]
                const groups = (it.list && it.list.length) ? it.list.slice() : [{ count: it.count, attr: it.attr }]
                let cnt = 0; let sub = 0
                const remain = []//红装组保留
                for (const g of groups) {
                    const count = Number(g.count) || 0
                    const p = equipSellPrice(name, g.attr)
                    if (p <= 0) { remain.push({ count, attr: g.attr }); continue }
                    sub += p * count
                    cnt += count
                }
                if (cnt <= 0) continue
                total += sub
                sold.push({ kind: 'equip', name, count: cnt, price: sub })
                if (remain.length) {
                    it.list = remain
                    it.count = remain.reduce((s, g) => s + g.count, 0)
                    it.attr = remain[0].attr
                } else delete items[name]
            } else if (gongfa) {
                if ((gongfa.quality || 0) > maxQ) continue
                const p = gongfaSellPrice(name)
                if (p <= 0) continue//红/彩功法(0价)不卖
                const cnt = Number(items[name].count) || 0
                if (cnt <= 0) continue
                total += p * cnt
                sold.push({ kind: 'gongfa', name, count: cnt, price: p * cnt })
                delete items[name]
            }
        }
        if (!sold.length) {
            e.reply('背包里没有可出售的装备或功法书~（已穿戴的不卖，红装/红彩功法不可出售）')
            return true
        }
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        /* 修仙世界: 一键出售按所在大区动态税率扣税(税收计入宗门繁荣度) */
        const world = getWorld(e.group_id)
        const loc = getLoc(world, id)
        const rate = taxFor(world, loc, playerSectName(e.group_id, id))
        const tax = Math.floor(total * rate / 100)
        const sellNet = total - tax
        homejson[id].money = (Number(homejson[id].money) || 0) + sellNet
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        addTax(world, loc, tax)
        saveWorld(world)
        saveBag(id, bag, e.group_id)
        await unlock(e.group_id, e.user_id, 'sell')//出售完成释放交互占用
        const boss = bossOf(world, loc)
        const owner = boss ? `${REGIONS[loc].name}${boss}` : `${REGIONS[loc].name}各占领宗门`
        const lines = sold.map(s => {
            const tpl = s.kind === 'equip' ? EQUIP_TPL[s.name] : GONGFA_TPL[s.name]
            const q = QUALITY[tpl.quality]
            return s.kind === 'equip'
                ? `${q.icon}${s.name} ×${s.count}（${Math.floor(s.price * (100 - rate) / 100)}灵石）`
                : `${q.icon}《${s.name}》 ×${s.count}（${Math.floor(s.price * (100 - rate) / 100)}灵石）`
        })
        /* 结算文本渲染成图片(失败回退纯文本) */
        const sellText = `💰 一键出售成功！装备和功法书共获得 ${sellNet} 灵石（税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}）：\n${lines.join('\n')}`
        let sellImg = null
        try { sellImg = await textToImg(sellText) } catch (err) { }
        if (sellImg) e.reply([segment.at(id), sellImg])
        else e.reply([segment.at(id), `\n${sellText}`])
        return true
    }

    /** #一键出售 N: 出售 N 品质(1白 2绿 3蓝 4紫 5黄)及以下的未穿戴装备换成灵石; 红色(6)不可出售 */
    async sellEquip(e) {
        await unlock(e.group_id, e.user_id, 'sell')//先释放旧的出售占用
        clearPendingSellMode(e)
        const m = String(e.msg || '').match(/([1-6])/)
        const maxQ = m ? parseInt(m[1]) : 0
        if (maxQ === 6) {
            e.reply('红色装备(6)不可出售哦~ 请选择 1~5')
            return true
        }
        if (maxQ < 1 || maxQ > 5) {
            await forceLock(e.group_id, e.user_id, 'sell')//建立出售交互(压栈选择, 不终止下层交互)
            e.reply(`请选择要出售的品质（出售该品质及以下的未穿戴装备，红色不可出售）：\n1. ⚪ 白色及以下\n2. 🟢 绿色及以下\n3. 🔵 蓝色及以下\n4. 🟣 紫色及以下\n5. 🟡 黄色及以下\n直接回复数字选择~（去逛街/换装等会取消出售）`)
            return true
        }
        const id = e.user_id
        const filename = `${e.group_id}.json`
        const bag = getBag(id, e.group_id)
        const items = bag.items || {}
        let total = 0
        const sold = []//{name,count,price}
        for (const name of Object.keys(items)) {
            const t = EQUIP_TPL[name]
            if (!t || (t.quality || 0) > maxQ) continue
            const it = items[name]
            const groups = (it.list && it.list.length) ? it.list.slice() : [{ count: it.count, attr: it.attr }]
            let cnt = 0, sub = 0
            const remain = []//不可售组(红装 p<=0)保留; 背包全是未穿件, 全部可卖
            for (const g of groups) {
                const p = equipSellPrice(name, g.attr)
                if (p <= 0) { remain.push({ count: g.count, attr: g.attr }); continue }
                sub += p * g.count
                cnt += g.count
            }
            if (cnt <= 0) continue
            total += sub
            sold.push({ name, count: cnt, price: sub })
            /* 只删卖掉的组, 红装组保留(背包全是未穿件, 不存在穿着的要保护) */
            if (remain.length) {
                it.list = remain
                it.count = remain.reduce((s, g) => s + g.count, 0)
                it.attr = remain[0].attr
            } else {
                delete items[name]
            }
        }
        if (!sold.length) {
            e.reply('背包里没有可出售的装备~（已穿戴的不卖，红色不可出售）')
            return true
        }
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        /* 修仙世界: 一键出售按所在大区动态税率扣税(税收计入宗门繁荣度) */
        const world = getWorld(e.group_id)
        const loc = getLoc(world, id)
        const rate = taxFor(world, loc, playerSectName(e.group_id, id))
        const tax = Math.floor(total * rate / 100)
        const sellNet = total - tax
        homejson[id].money = (Number(homejson[id].money) || 0) + sellNet
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        addTax(world, loc, tax)
        saveWorld(world)
        saveBag(id, bag, e.group_id)
        await unlock(e.group_id, e.user_id, 'sell')//出售完成释放交互占用
        const boss = bossOf(world, loc)
        const owner = boss ? `${REGIONS[loc].name}${boss}` : `${REGIONS[loc].name}各占领宗门`
        const lines = sold.map(s => {
            const q = QUALITY[EQUIP_TPL[s.name].quality]
            return `${q.icon}${s.name} ×${s.count}（${Math.floor(s.price * (100 - rate) / 100)}灵石）`
        })
        /* 结算文本渲染成图片(失败回退纯文本) */
        const sellText = `💰 一键出售成功！共获得 ${sellNet} 灵石（税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}）：\n${lines.join('\n')}`
        let sellImg = null
        try { sellImg = await textToImg(sellText) } catch (err) { }
        if (sellImg) e.reply([segment.at(id), sellImg])
        else e.reply([segment.at(id), `\n${sellText}`])
        return true
    }

    /** #一键出售功法 N: 出售 N 品质(1白 2绿 3蓝 4紫 5金)及以下的功法书换成灵石; 红/彩(6/7)不可出售 */
    async sellGongfa(e) {
        await unlock(e.group_id, e.user_id, 'sellgf')//先释放旧的出售占用
        const m = String(e.msg || '').match(/([1-7])/)
        const maxQ = m ? parseInt(m[1]) : 0
        if (maxQ >= 6) {
            e.reply('红色/彩色功法(6/7)不可出售哦~ 请选择 1~5')
            return true
        }
        if (maxQ < 1 || maxQ > 5) {
            await forceLock(e.group_id, e.user_id, 'sellgf')//建立出售交互(压栈选择, 不终止下层交互)
            e.reply(`请选择要出售的品质（出售该品质及以下的功法书，红/彩不可出售）：\n1. ⚪ 白色及以下\n2. 🟢 绿色及以下\n3. 🔵 蓝色及以下\n4. 🟣 紫色及以下\n5. 🟡 金色及以下\n直接回复数字选择~（去逛街/换装等会取消出售）`)
            return true
        }
        const id = e.user_id
        const filename = `${e.group_id}.json`
        const bag = getBag(id, e.group_id)
        const items = bag.items || {}
        let total = 0
        const sold = []//{name,count,price}
        for (const name of Object.keys(items)) {
            const t = GONGFA_TPL[name]
            if (!t || (t.quality || 0) > maxQ) continue
            const p = gongfaSellPrice(name)
            if (p <= 0) continue//红/彩(0价)不卖
            const cnt = Number(items[name].count) || 0
            if (cnt <= 0) continue
            total += p * cnt
            sold.push({ name, count: cnt, price: p * cnt })
            delete items[name]
        }
        if (!sold.length) {
            e.reply('背包里没有可出售的功法书~（红/彩不可出售）')
            return true
        }
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        /* 修仙世界: 一键出售按所在大区动态税率扣税(税收计入宗门繁荣度) */
        const world = getWorld(e.group_id)
        const loc = getLoc(world, id)
        const rate = taxFor(world, loc, playerSectName(e.group_id, id))
        const tax = Math.floor(total * rate / 100)
        const sellNet = total - tax
        homejson[id].money = (Number(homejson[id].money) || 0) + sellNet
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        addTax(world, loc, tax)
        saveWorld(world)
        saveBag(id, bag, e.group_id)
        await unlock(e.group_id, e.user_id, 'sellgf')//出售完成释放交互占用
        const boss = bossOf(world, loc)
        const owner = boss ? `${REGIONS[loc].name}${boss}` : `${REGIONS[loc].name}各占领宗门`
        const lines = sold.map(s => {
            const q = QUALITY[GONGFA_TPL[s.name].quality]
            return `${q.icon}《${s.name}》 ×${s.count}（${Math.floor(s.price * (100 - rate) / 100)}灵石）`
        })
        /* 结算文本渲染成图片(失败回退纯文本) */
        const sellText = `💰 一键出售功法成功！共获得 ${sellNet} 灵石（税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}）：\n${lines.join('\n')}`
        let sellImg = null
        try { sellImg = await textToImg(sellText) } catch (err) { }
        if (sellImg) e.reply([segment.at(id), sellImg])
        else e.reply([segment.at(id), `\n${sellText}`])
        return true
    }
}
