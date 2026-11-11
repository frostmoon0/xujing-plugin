import { wearPlayerTaichu, taichuBattleReceipt } from '../../components/taichu_combat.js'
//随便写的,大佬勿喷 初版@鸢:随机娶群友，指定娶群友
import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import fs from 'fs'
import path from 'path'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import Config from '../../model/Config.js'
import moment from "moment"
import command from '../../components/command.js'
import xujing_data from '../../components/xujing_data.js'
import { getBag, getEquipLevelRand, PARTS, QUALITY, EQUIP_TPL, ITEM_TPL, ITEM_PRICE, equipPrice, addItem, consumeItem, getItemAttr, fmtAttr, realmPowerDiff, afterTax, taxSect, GONGFA_TPL, gongfaPrice, gongfaSellPrice, fmtGongfaFx, getGongfaFx, getLearnedGongfa, isGongfaLearned, learnGongfa, setActiveGongfa, tryGiveSecretKey, ARRAY_MATS, itemIcon } from '../../components/equip_data.js'
import { canLearnPuppetTechnique, isPuppetTechnique, puppetTechniqueInfo } from '../../components/puppet_data.js'
import { canAddResident as checkRoom, cleanOverCapacity } from '../../components/house.js'
import { fightWinRate, fightBestOf5, buildFightRecord, makeDamageFn, getBuffs } from '../../components/fight.js'
import { getSubThreshold, accumMax } from './duel_exercise.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { raidOpen } from '../../components/raid_data.js'
import { getStock, buyStock, restockIn, shopSaleTax, recordActive } from '../../components/shop_data.js'
import { logPlayerTrade, logPlayerEvent, playerTitle, getNick, playerSectName, getFake, saveFake } from '../../components/fake_data.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
/*修仙世界: 摆摊收入纳入动态税率*/  
import { REGIONS, REGION_KEYS, getWorld, getLoc, getRate, addTax, saveWorld, bossOf, regionNameOf, taxFor } from '../../components/world_data.js'

/** 随机帮助背景图(与配方台/拍卖行一致) */
const rodom = () => {
    try {
        const imageDir = path.join(Plugin_Path, 'resources', 'help', 'imgs')
        if (!fs.existsSync(imageDir)) return ''
        const list = fs.readdirSync(imageDir)
        if (!list.length) return ''
        return list.length === 1 ? list[0] : list[Math.floor(Math.random() * list.length)]
    } catch (err) { return '' }
}

// 逛街选择状态: user_id -> { mode, time, part, list }
const streetState = {}

/** 其他大区同商店库存+补货时间(售罄提示用): 返回行数组 */
async function otherRegionsStock (gid, shop, me, kind) {
  const lines = []
  for (const r of REGION_KEYS) {
    if (r === me) continue
    if (REGIONS[r] && REGIONS[r].special) continue // 特殊大区(简月王朝)无商铺
    const stock = await getStock(gid, shop, r)
    const inStr = await restockIn(gid, shop, r)
    const nm = regionNameOf(r)
    if (kind === 'dange') {
      const d = ['修为丹', '破障丹'].map(n => {
        const c = Number(stock[n]) || 0
        return `${itemIcon(n)}${n}${c > 0 ? '剩' + c + '颗' : '🈳'}`
      }).join(' · ')
      lines.push(`· ${nm}丹阁：${d}（${inStr}补货）`)
    } else if (kind === 'qige') {
      const ks = Object.keys(stock)
      lines.push(`· ${nm}器阁：${ks.length ? ks.map(n => `${itemIcon(n)}${n}×${stock[n]}`).join('、') : '🈳 本批售罄'}（${inStr}补货）`)
    } else {
      const ks = Object.keys(stock).sort((a, b) => (GONGFA_TPL[b].quality || 0) - (GONGFA_TPL[a].quality || 0))
      lines.push(`· ${nm}藏宝阁：${ks.length ? ks.map(n => `${itemIcon(n)}《${n}》×${stock[n]}`).join('、') : '🈳 本批售罄'}（${inStr}补货）`)
    }
  }
  return lines
}

/** 冷却时间格式化(精确到秒,如 4分10秒) */
const fmtCD = (sec) => {
    sec = Math.max(0, Math.ceil(Number(sec) || 0))
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return m > 0 ? `${m}分${s}秒` : `${s}秒`
}
/** 距离当天结束的秒数(用于每日限制) */
const secondsUntilMidnight = () => {
    const now = new Date()
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    return Math.max(1, Math.floor((midnight - now) / 1000))
}
/** 加成取最好: 自己房子 与 所有主人(娶/纳此人的人)的房子 中该字段的最大值 */
const bestBonus = (housejson, homejson, xqjson, uid, key) => {
    let best = Number((housejson[uid] && housejson[uid][key]) || 0)
    for (const master of Object.keys(homejson)) {
        if (String(master) === String(uid)) continue
        const m = homejson[master] || {}
        const isMaster = String(m.s) === String(uid) ||
            ((xqjson[master] && Array.isArray(xqjson[master].shuangxiu)) && xqjson[master].shuangxiu.map(String).includes(String(uid)))
        if (isMaster) {
            const v = Number((housejson[master] && housejson[master][key]) || 0)
            if (v > best) best = v
        }
    }
    return best
}
import { Plugin_Name, Plugin_Path, Save_Path } from '../../components/plugin.js'
import { getGroupMemberSnapshot, cleanupGroupSave } from '../../components/group_cleanup.js'
let Magnification = await command.getConfig("duel_cfg", "Magnification");

const giftpath = `plugins/${Plugin_Name}/resources/qylp/giftthing.json`
const housepath = `plugins/${Plugin_Name}/resources/qylp/house.json`
const inpapath = `plugins/${Plugin_Name}/resources/qylp/inpa.json`
const bagpath = `${Save_Path}/bag`
const currentTime = moment(new Date()).format('YYYY-MM-DD HH:mm:ss')
let cdTime = Number(await command.getConfig("wife_cfg", "sjcd")) * 60;//随机娶群友冷却
let cdTime2 = Number(await command.getConfig("wife_cfg", "qqcd")) * 60;//强娶冷却
let cdTime4 = Number(await command.getConfig("wife_cfg", "bbcd")) * 60;//抱抱冷却
let cdTime5 = Number(await command.getConfig("wife_cfg", "ggcd")) * 60;//逛街冷却
let cdTime6 = Number(await command.getConfig("wife_cfg", "qlpcd")) * 60;//抢老婆冷却
let cdTime7 = Number(await command.getConfig("wife_cfg", "poorcd")) * 60;//低保冷却
let cdTime9 = Number(await command.getConfig("wife_cfg", "fkcd") || 120) * 60;//双修冷却(默认120分钟=2小时)
let qqwife = await command.getConfig("wife_cfg", "qqwife");//强娶概率
let sjwife = await command.getConfig("wife_cfg", "sjwife");//随机概率
let gifttime = await command.getConfig("wife_cfg", "gifttime");//逛街换地上限
/* 限时秘境：每天一个，day: 0周日~6周六，晚上20:00-24:00开放 */
const SECRET_REALMS = {
    '青云秘境': { day: 1, min: 500, max: 1200, emoji: '🌿', desc: '采仙草' },
    '玄晶秘境': { day: 2, min: 500, max: 1200, emoji: '💎', desc: '挖灵石' },
    '丹火秘境': { day: 3, min: 500, max: 1200, emoji: '🔥', desc: '炼丹药' },
    '镜湖秘境': { day: 4, min: 500, max: 1200, emoji: '🐟', desc: '钓灵鱼' },
    '天机秘境': { day: 5, min: 500, max: 1200, emoji: '🔮', desc: '探天机' },
    '太虚秘境': { day: 6, min: 1000, max: 2500, emoji: '🌌', desc: '太虚寻宝' },
    '瑶池秘境': { day: 0, min: 1500, max: 3500, emoji: '✨', desc: '瑶池仙缘' }
}
/** 每日秘境(限时秘境/灵宝盒)奖励池·写死: 只含当前道具, 后续在装备/材料/功法模板新增的道具不会自动进入秘境池;
 *  万魂窟专属材料不在此池(仅由万魂窟掉落)。 */
const SECRET_GOLD_EQUIP = ['流金剑', '月华扇', '金花冠', '月华冠', '金缕衣', '月纹软甲', '金缕裙', '月纹裤', '金缕绣鞋', '月纹靴', '金玉戒', '月华戒']
const SECRET_MATS = {
    4: ['星霜草', '青鸾草', '月魄石', '星璇石'],
    5: ['望舒花', '月华芝', '流光玉', '织云石'],
    6: ['凤栖花', '凤羽玉', '天衍阵纹', '乾坤阵晶', '太虚阵砂', '九幽阵髓'],
    7: ['云裳仙蕊', '造梦神玉']
}
const SECRET_RED_GONGFA = ['红莲神功', '凤凰涅槃诀', '鸾音真诀', '不灭玉身', '冥蝶手', '万象归元', '璇玑衍算']
/** 秘境掉落: 先判定是否爆出, 再判定件数(周六日概率更高; 惊鸿丹不爆; 材料爆率随境界提升,渡劫期起吃满) */
export const rollSecretDrops = async (id, weekend, gid = 'global') => {
    const drops = []
    // 聚宝丹: 1小时内增加幸运值(灵石不算; 掉落概率与数量均提升)
    let dropBuff = 1
    try { if (await redis.get(`xujing:baolv-buff:${id}`)) dropBuff = 2 } catch (err) { }
    // 功法幸运加成(与聚宝丹取最高,彩色2.4)
    try { const gfx = await getGongfaFx(id); if (gfx && gfx.lucky) dropBuff = Math.max(dropBuff, gfx.lucky) } catch (err) { }
    // 境界系数: 境界编号1~17(每4级一境), 渡劫期(第9境, level≥33)起爆率吃满(系数1)
    const battlejson = await xujing_data.getQQYUserBattle(id, null, false, `${gid}.json`)
    const level = Number((battlejson[id] && battlejson[id].level) || 0)
    const realmN = Math.floor((level - 1) / 4) + 1
    const factor = Math.min(1, Math.max(0, realmN) / 9)
    // 1. 金色装备: 爆率 平日10% / 周六日20%(×境界系数, 聚宝丹翻倍), 爆出后随机 1~3 件
    if (Math.random() < Math.min(1, (weekend ? 0.2 : 0.1) * factor * dropBuff)) {
        const golds = SECRET_GOLD_EQUIP
        if (golds.length) {
            const n = Math.max(1, Math.floor((1 + Math.floor(Math.random() * 3)) * dropBuff))
            const got = []
            for (let i = 0; i < n; i++) {
                const gn = golds[Math.floor(Math.random() * golds.length)]
                addItem(id, gn, 1, null, gid)
                got.push(gn)
            }
            drops.push(`🟡金色装备：${got.map(n => `${itemIcon(n)}${n}`).join('、')}`)
        }
    }
    // 2. 丹药: 只爆修为丹/破障丹(惊鸿丹不爆), 逐颗独立抽取(不再一种×N; 爆率×境界系数, 聚宝丹翻倍)
    if (Math.random() < Math.min(1, (weekend ? 0.6 : 0.4) * factor * dropBuff)) {
        const pills = ['修为丹', '破障丹']
        const n = Math.max(1, Math.floor((1 + Math.floor(Math.random() * 3)) * dropBuff))
        const got = {}
        for (let i = 0; i < n; i++) {
            const name = pills[Math.floor(Math.random() * pills.length)]
            got[name] = (got[name] || 0) + 1
        }
        for (const [name, cnt] of Object.entries(got)) {
            addItem(id, name, cnt, null, gid)
            drops.push(`${itemIcon(name)}${name}×${cnt}`)
        }
    }
    // 3. 秘境材料(药材/矿物): 按品质分档, 逐件独立抽取(不再一种×N); 彩(品质7)每次固定1件, 不受聚宝丹翻倍
    const matRate = weekend
        ? { 4: 0.5, 5: 0.18, 6: 0.05, 7: 0.01 }
        : { 4: 0.35, 5: 0.1, 6: 0.03, 7: 0.005 }
    for (const q of [4, 5, 6, 7]) {
        if (Math.random() < Math.min(1, matRate[q] * factor * dropBuff)) {
            const pool = SECRET_MATS[q] || []
            if (!pool.length) continue
            const maxN = q === 4 ? 3 : (q === 5 ? 2 : 1)
            const n = q === 7 ? 1 : Math.max(1, Math.floor((1 + Math.floor(Math.random() * maxN)) * dropBuff))
            const got = {}
            for (let i = 0; i < n; i++) {
                const mn = pool[Math.floor(Math.random() * pool.length)]
                got[mn] = (got[mn] || 0) + 1
            }
            for (const [mn, cnt] of Object.entries(got)) {
                addItem(id, mn, cnt, null, gid)
                drops.push(`${itemIcon(mn)}${mn}×${cnt}`)
            }
        }
    }
    /* 阵法材料各自概率与原本单个彩材(云裳仙蕊/造梦神玉)相同; 四种合计为两倍单个彩材池概率 */
    const arrayRate = matRate[7] * 2
    if (Math.random() < Math.min(1, arrayRate * factor * dropBuff)) {
        const mn = ARRAY_MATS[Math.floor(Math.random() * ARRAY_MATS.length)]
        addItem(id, mn, 1, null, gid)
        drops.push(`${itemIcon(mn)}${mn}×1`)
    }
    // 4. 红色功法书: 极低概率掉落(0.3%,受境界与幸运加成)
    if (Math.random() < Math.min(1, 0.003 * factor * dropBuff)) {
        const reds = SECRET_RED_GONGFA
        if (reds.length) {
            const gn = reds[Math.floor(Math.random() * reds.length)]
            addItem(id, gn, 1, null, gid)
            drops.push(`${itemIcon(gn)}${gn}（红色功法书）`)
        }
    }
    // 5. (彩功法不进每日秘境奖励池: 太阴月华诀只能通过藏宝阁洗劫获得)
    // 6. 遗蜕古钥: 每日秘境产(彩级概率, 每日每群最多2把)
    try { if (await tryGiveSecretKey(gid, id)) drops.push(`${itemIcon('遗蜕古钥')}遗蜕古钥`) } catch (err) { }
    return drops
}
const WEEKDAY_CN = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' }
export class qqy extends plugin {
    constructor() {
        super({
            name: '娶群友',
            dsc: '娶群友',
            event: 'message',
            priority: 66,
            rule: [{
                reg: "^[#＃]?(娶群友|娶老婆|娶群友老婆|娶群主|找老公)$",
                fnc: 'wife'
            },
            {
                reg: '^[#＃]?(强娶|娶|嫁|嫁人|嫁老公|嫁群友)$',
                fnc: 'wife2'
            },
            {
                reg: '^[#＃]?抢老婆$',
                fnc: 'ntr'
            },
            {
                reg: '^[#＃]?(抢劫|打劫|抢钱)$',
                fnc: 'Robbery'
            },
            {
                reg: '^[#＃]?我愿意$',
                fnc: 'yy'
            },
            {
                reg: '^[#＃]?我拒绝$',
                fnc: 'jj'
            },
            {
                reg: '^[#＃]?(闹离婚|甩掉|分手)(.*)$',
                fnc: 'breakup'
            },
            {
                reg: '^[#＃]?(设置老婆|扶正)\s*([0-9０-９]*)$',
                fnc: 'setWife'
            },
            {
                reg: '^[#＃]?摆摊$',
                fnc: 'stall'
            },
            {
                reg: '^[#＃]?(青云|玄晶|丹火|镜湖|天机|太虚|瑶池)秘境\\s*[0-9０-９]*$',
                fnc: 'realm'
            },
            {
                reg: '^[#＃]?(使用宝盒|宝盒|使用灵宝盒|开宝盒|开启宝盒)(.*)$',
                fnc: 'openBox'
            },
            {
                reg: '^[#＃]?住所改名',
                fnc: 'namedhouse'
            },
            {
                reg: '^[#＃]?看房$',
                fnc: 'gethouse'
            },
            {
                reg: '^[#＃]?(升级房子|升级住所|买房).*$',
                fnc: 'buyhouse'
            },
            {
                reg: '^[#＃]?逛街$',
                fnc: 'gift'
            },
            {
                reg: '^[#＃]?(去)?丹阁$',
                fnc: 'dangeShow'
            },
            {
                reg: '^[#＃]?(去)?器阁$',
                fnc: 'qigeShow'
            },
            {
                reg: '^[#＃]?(去)?藏宝阁$',
                fnc: 'cangbaogeShow'
            },
            {
                reg: '^[#＃]?(去逛逛|去逛街|随意逛逛)$',
                fnc: 'streetRandom'
            },
            {
                reg: '^[#＃]?(进去看看|去下一个地方)$',
                fnc: 'streetRandom'
            },
            {
                reg: '^[#＃]?[0-9]+(\\s*[x×*]?\\s*[0-9]+)?$',
                fnc: 'streetChoose'
            },
            {
                reg: '^[#＃]?(拥抱|抱抱)(.*)$',
                fnc: 'touch'
            },
            {
                // 涩涩/双修 必须带 # 才触发
                reg: '^[#＃](涩涩|双修|开始双修)$',
                fnc: 'fk'
            },
            {
                reg: '^[#＃]?(群cp|cp列表)$',
                fnc: 'cplist'
            },
            {
                reg: '^[#＃]?领取低保$',
                fnc: 'poor'
            },
            {
                reg: '^[#＃]?上交存款[0-9]{1,}$',
                fnc: 'Transfer_money'
            },
            {
                reg: '^[#＃]?(虚境)(时间重置|重置时间)$',
                fnc: 'delREDIS'
            },
            {
                reg: '^[#＃]?虚境(清除|清理)无效存档$',
                fnc: 'delerrdata'
            },
            // ===== 功法系统 =====
            {
                reg: '^[#＃]?功法图鉴$',
                fnc: 'gongfaAll'
            },
            {
                reg: '^[#＃]?功法$',
                fnc: 'gongfaStatus'
            },
            {
                reg: '^[#＃]?(修炼|学习|学会|习得)功法\\s*(.*)$',
                fnc: 'gongfaLearn'
            },
            {
                reg: '^[#＃]?(运转|装备|激活|使用)功法\\s*(.*)$',
                fnc: 'gongfaRun'
            },
            {
                reg: '^[#＃]?取消功法$',
                fnc: 'gongfaClear'
            },
            {
                reg: '^[#＃]?(卖|出售|售卖)功法\\s*(.*)$',
                fnc: 'gongfaSell'
            }
            ]
        })
    }
    //指定强娶/娶
    async wife2(e) {
        if (await this.is_jinbi(e) == true) return
        console.log(e)
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var inpajson = await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, false)
        if (!e.at && !e.atme) {
            e.reply(`请at你的情人哦`)
            return
        }
        if (e.atme || e.atall) {
            e.reply(`不可以这样！`)
            return
        }
        if (homejson[e.user_id].money <= 0) {
            e.reply(`灵石都没了,你不能娶老婆`)
            return
        }
        let she_he = await this.people(e, 'sex', e.at)//用is_she函数判断下这个人是男是女  
        let name = await this.people(e, 'nickname', e.at)//用is_she函数获取昵称
        let iswife_list = await this.is_wife(e, e.at)
        if (iswife_list.length > 0) {
            let msg = `已经人喜欢${she_he}了哦！让${she_he}先处理一下！\n喜欢${she_he}的人有：`
            for (let i of iswife_list) {
                msg = msg + `\n${i}`
            }
            msg = msg + `\n你可以使用'#抢老婆@...'哦！`
            e.reply(msg)
            return
        }
        //-------------------------------------------------------------------
        var battlejson = await xujing_data.getQQYUserBattle(id, battlejson, false, `${e.group_id}.json`)
        let UserPAF = battlejson[id].Privilege
        let lastTime = await redis.ttl(`xujing:whois-my-wife2-cd:${e.group_id}:${e.user_id}`);
        if (lastTime !== -2 && !UserPAF) {
            e.reply([
                segment.at(e.user_id), "\n",
                `冷却中：${fmtCD(lastTime)}`
            ]);
            return
        }
        let sex = await Bot.pickFriend(e.user_id).sex
        let ex = ''
        if (sex == 'male') {
            ex = '小姐'
        }
        else if (sex == 'female') {
            ex = '先生'
        }
        if (e.msg.includes("强娶")) {
            if (homejson[id].money <= 50) {
                e.reply(`灵石不足,你只剩下${homejson[id].money}灵石了...等自动挂机赚点灵石吧!`)
                return
            }
            if(homejson[id].s == e.at || ((inpajson[id].shuangxiu) || []).includes(e.at))
              return e.reply(`对方已经属于你了哦`)
            var gailv = Math.round(Math.random() * 9);
            if (gailv < qqwife || UserPAF) {
                // 容量检查(满员直接拒绝,不花冷却)
                const check = await this.canAddResident(e, id)
                if (!check.ok) {
                    e.reply(`你的房子住不下啦（${check.cap === Infinity ? '已住满' : `上限${check.cap}人`}），升级房子扩大可居住人数后再${homejson[id].s ? '纳妾' : '娶妻'}吧~`)
                    return
                }
                e.reply([
                    segment.at(id), "\n",
                    segment.image(`https://q1.qlogo.cn/g?b=qq&s=0&nk=${id}`), "\n",
                    `恭喜你！`, "\n",
                    `在茫茫人海中，你成功强娶到了${name}!`,
                    "\n", segment.image(`https://q1.qlogo.cn/g?b=qq&s=0&nk=${e.at}`), "\n",
                ])
                await redis.set(`xujing:whois-my-wife2-cd:${e.group_id}:${e.user_id}`, currentTime, {
                    EX: cdTime2
                });
                // 统一加入成员: 有老婆→纳妾 / 无老婆→娶妻
                const type = await this.applyMarry(homejson, inpajson, id, e.at)
                // 强娶成功写入天下大事(结为道侣)
                try {
                    const nick = await getNick(e.group_id, e.user_id)
                    logPlayerEvent(e.group_id, `【姻缘】散修 ${nick} 强娶 ${name} 结为道侣`)
                } catch (err) { }
                if (type === 'concubine') e.reply(`你已经有老婆了,你可以纳妾!?,这位${name}就成功被你纳入了!`)
            }
            else if (gailv >= qqwife) {
                // 罚款翻倍(加50出场费后总扣款仍<1000): 基础100~450 → 翻倍200~900
                var sbcf = Math.min(900, Math.round(Math.random() * 350 + 100) * 2)
                homejson[id].money -= sbcf
                e.reply(`很遗憾,你没能成功将${she_he}娶走,${she_he}报警,你被罚款${sbcf}`)
                await redis.set(`xujing:whois-my-wife2-cd:${e.group_id}:${e.user_id}`, currentTime, {
                    EX: cdTime2
                });
            }
            homejson[id].money -= 50
            await xujing_data.getQQYUserHome(id, homejson, filename, true)
            await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
            return
        }
        e.reply([
            segment.at(e.at), "\n",
            segment.image(`https://q1.qlogo.cn/g?b=qq&s=0&nk=${e.at}`), "\n",
            segment.at(id), "\n",
            segment.image(`https://q1.qlogo.cn/g?b=qq&s=0&nk=${id}`), "\n",
            `向你求婚：‘亲爱的${ex}您好！`, "\n",
            `在茫茫人海中，能够与${ex}相遇相知相恋，我深感幸福，守护你是我今生的选择，我想有个自己的家，一个有你的家,嫁给我好吗？’`, "\n",
            segment.at(e.at), "\n",
            `那么这位${ex}，你愿意嫁给ta吗？at并发送【我愿意】或者【我拒绝】，回应${she_he}哦！`,
        ])
        homejson[id].wait = e.at
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        return true;
    }
    //双修(与道侣双修获得灵力,冷却2小时,灵力减半)
    async fk(e){
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var inpajson = await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, false)
        var inpathing = JSON.parse(fs.readFileSync(inpapath, "utf8"));//读取双修剧情
        if(!homejson[id].s) return e.reply(`你没有老婆，也没有双修对象，先去娶一个吧~`)
        // 双修冷却(默认2小时)
        let lastTime = await redis.ttl(`xujing:wife-fk-cd:${e.group_id}:${id}`);
        if (lastTime !== -2) {
            e.reply([segment.at(id), "\n", `冷却中：${fmtCD(lastTime)}`])
            return
        }
        await redis.set(`xujing:wife-fk-cd:${e.group_id}:${id}`, currentTime, { EX: cdTime9 })
        // 双修人数 = 老婆(若有) + 小妾数; shuangxiu 只存小妾(不把老婆写入,避免列表污染与显示虚高)
        const xqList = Array.isArray(inpajson[id].shuangxiu) ? inpajson[id].shuangxiu : []
        const xqClean = homejson[id].s ? xqList.filter(x => String(x) !== String(homejson[id].s)) : xqList
        var ren = (homejson[id].s ? 1 : 0) + xqClean.length
        // 双修获得灵力(道侣越多灵力越多,灵力减半),享受修炼系统的房子修炼加成(取最好:自己+主人)
        var battlejson = await xujing_data.getQQYUserBattle(id, null, false, `${e.group_id}.json`)
        var exp = Math.round(ren * (10 + Math.random() * 20) / 2)
        /* 双修加成: 房子修炼加成 / 灵犀丹(×2) / 功法双修特效 同时只取最高一种生效(不叠加) */
        let mul = 1
        try {
            const housejson = await xujing_data.getQQYUserHouse(id, null, filename, false)
            const cb = bestBonus(housejson, homejson, inpajson, id, 'cultivate')
            if (cb > 0) mul = Math.max(mul, 1 + cb / 100)
        } catch { }
        try { if (await redis.get(`xujing:lingxi-buff:${id}`)) mul = Math.max(mul, 2) } catch (err) { }
        try { const gfx = await getGongfaFx(id); if (gfx && gfx.love > 1) mul = Math.max(mul, gfx.love) } catch (err) { }
        exp = Math.round(exp * mul)
        /* 双修灵力同样进累积池: 主灵力填到当前境界上限,溢出进入累积池(上限=当前境界灵力5%),再溢出消散 */
        battlejson[id].accum = Number(battlejson[id].accum) || 0
        const needNext = getSubThreshold(battlejson[id].level + 1)
        let gainMain = 0
        if (battlejson[id].experience < needNext) {
            gainMain = Math.min(exp, needNext - battlejson[id].experience)
        }
        let gainAccum = 0
        let gainLost = 0//消散的灵力
        if (exp > gainMain) {
            const space = accumMax(battlejson[id].level) - battlejson[id].accum
            if (space > 0) {
                gainAccum = Math.min(exp - gainMain, space)
            }
            gainLost = exp - gainMain - gainAccum
            battlejson[id].accum += gainAccum
        }
        battlejson[id].experience += gainMain
        const totalGain = gainMain + gainAccum
        const gainNote = gainLost > 0 ? `（其中${gainLost}点灵力消散了）` : ''
        inpajson[id].shuangxiu_time++
        let wifename = await this.people(e, "nickname", homejson[id].s)
        let username = await this.people(e, "nickname", id)
        const testKeys = Object.keys(inpathing.test)
        let inpajq = inpathing.test[testKeys[Math.floor(Math.random() * testKeys.length)]]
        inpajq = inpajq.replace(/user/g, username)
        inpajq = inpajq.replace(/wife1/g, wifename)
        let msg = [inpajq, `你与${ren}位道侣进行双修，获得${totalGain}点灵力${gainNote}！\n当前灵力：${battlejson[id].experience}${battlejson[id].accum > 0 ? `（累积+${battlejson[id].accum}，突破后并入）` : ''}`]
        await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
        await xujing_data.getQQYUserBattle(id, battlejson, true, `${e.group_id}.json`)
        Config.getforwardMsg(msg, e)
    }
    //抢老婆
    async ntr(e) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        if (e.atme || e.atall) {
            e.reply(`6🙂`)
            return
        }
        if (!e.at) {
            e.reply(`你想抢谁的老婆呢?at出来!`)
            return
        }
        if (!homejson[e.at] || homejson[e.at].s == 0) {
            e.reply("虽然但是,对方在这里没有老婆啊!(￣_,￣ ),要不你俩试试?")
            return
        }
        if (homejson[id].s != 0) {
            e.reply(`你已经有老婆了还抢别人的???`)
            return
        }
        if (homejson[id].money <= 0) {
            e.reply(`灵石都没有你还有脸抢老婆?`)
            return
        }
        var battlejson = await xujing_data.getQQYUserBattle(id, battlejson, false, `${e.group_id}.json`)
        let UserPAF = battlejson[id].Privilege
        let lastTime = await redis.ttl(`xujing:wife-ntr-cd:${e.group_id}:${e.user_id}`);
        if (lastTime !== -2 && !UserPAF) {
            e.reply([
                segment.at(e.user_id), "\n",
                `冷却中：${fmtCD(lastTime)}`
            ]);
            return
        }
        // 成功率与灵石无关:只看对方老婆的好感度(好感越高越难抢)
        var good = Math.round(100 - homejson[e.at].love / 100)
        var gailv = Math.round(Math.random() * 99)
        if (UserPAF) return await this.ntrT()//有权能直接抢走
        //这里用了和决斗一样的数据
        let is_win = await this.duel(e)
        if (is_win) {
            setTimeout(() => {
                e.reply(`你的灵石数为：${homejson[id].money},\n对方的灵石数为：${homejson[e.at].money},\n对方老婆对对方的好感度为：${homejson[e.at].love},决斗赢了,你的成功率为：${good}+10%`)
            }, 2000);
            good += 10
        }
        else {
            setTimeout(() => {
                e.reply(`你的灵石数为：${homejson[id].money},\n对方的灵石数为：${homejson[e.at].money},\n对方老婆对对方的好感度为：${homejson[e.at].love},决斗输了,你的成功率为：${good}-10%`)
            }, 2000);
            good -= 10
        }
        if (homejson[e.at].love >= 5000) {
            setTimeout(() => {
                e.reply(`他们之间已是休戚与共,伉俪情深,你是无法夺走他老婆的!`)
            }, 3000);
            await this.ntrF(e, e.user_id, e.at)
        }
        else if (good > gailv)
            await this.ntrT(e, e.user_id, e.at)
        else
            await this.ntrF(e, e.user_id, e.at)
        await redis.set(`xujing:wife-ntr-cd:${e.group_id}:${e.user_id}`, currentTime, {
            EX: cdTime6
        });
        return true;
    }
    //抢劫/打劫: 5分钟冷却,目标需有2000+灵石,成功抢走500~1000灵石
    async Robbery(e) {
        var id = e.user_id
        var at = e.at
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        if (e.atme || e.atall) {
            e.reply(`6🙂`)
            return true
        }
        if (!e.at) {
            e.reply(`想抢谁呢？@出来！如：#抢劫 @群友`)
            return true
        }
        /* 修仙世界: 抢劫须在同一大区(与交易/赠送/互动一致) */
        const world = getWorld(e.group_id)
        const myLoc = getLoc(world, id)
        const tgtLoc = getLoc(world, at)
        if (myLoc !== tgtLoc) {
            e.reply(`你们不在同一大区！你位于【${regionNameOf(myLoc)}】，对方位于【${regionNameOf(tgtLoc)}】，请先同行再抢劫~`)
            return true
        }
        /* 同门弟子禁止互抢(同宗门不可自相残杀) */
        const mySect = playerSectName(e.group_id, id)
        const tgtSect = playerSectName(e.group_id, at)
        if (mySect && mySect === tgtSect) {
            e.reply(`你们是同门弟子（【${mySect}】），宗门之内禁止自相残杀~`)
            return true
        }
        // 5分钟冷却
        let lastTime = await redis.ttl(`xujing:wife-Robbery-cd:${e.group_id}:${e.user_id}`);
        if (lastTime !== -2) {
            e.reply([
                segment.at(e.user_id), "\n",
                `抢劫冷却中：${fmtCD(lastTime)}`
            ]);
            return true
        }
        // 每天同一人只能被同一个人抢成功一次
        const robDailyKey = `xujing:rob:${e.group_id}:${e.user_id}:${at}`
        if (await redis.get(robDailyKey)) {
            e.reply([segment.at(e.user_id), `\n今天已经抢劫过对方了，明天再来吧~`])
            return true
        }
        // 目标灵石不足2000不能抢
        let targetMoney = (homejson[at] && Number(homejson[at].money)) || 0
        if (targetMoney < 2000) {
            e.reply(`对方灵石不足2000，抢了也没油水~`)
            return true
        }
        //读取双方存档,统一走战斗系统(与御前决斗同一套胜率/伤害公式)
        var battlejson = await xujing_data.getQQYUserBattle(id, null, false, `${e.group_id}.json`)
        var battlejson = await xujing_data.getQQYUserBattle(at, battlejson, false, `${e.group_id}.json`)
        let level = Number(battlejson[id].level) || 0
        let level2 = Number(battlejson[at].level) || 0
        //攻击/防御/生命/暴击/爆伤增益
        const myBuffs = await getBuffs(id, e.group_id)
        const oppBuffs = await getBuffs(at, e.group_id)
        const { win, myEquip, oppEquip } = fightWinRate(level, level2, id, at, Magnification, myBuffs, oppBuffs, e.group_id)
        const myDmg = makeDamageFn(level, id, 0.15, myBuffs, e.group_id)
        const oppDmg = makeDamageFn(level2, at, 0.15, oppBuffs, e.group_id)
        //一律五局三胜,管理员不加成(一视同仁,照常抢劫)
        const result = fightBestOf5(win, { dmgMe: myDmg, dmgOpp: oppDmg, defMe: myBuffs.def })
        const wearReceipt = taichuBattleReceipt(e, 'marriage-duel')
        wearPlayerTaichu(e.group_id, id, wearReceipt)
        wearPlayerTaichu(e.group_id, at, wearReceipt)
        const extra = '胜者可抢走对方500~1000灵石！'
        const myNick = (e.sender && (e.sender.card || e.sender.nickname)) || '你'
        const oppName = (await this.people(e, 'nickname', at)) || '对方'
        const msgs = buildFightRecord({
            myName: myNick,
            oppName,
            myId: e.user_id,
            oppId: at,
            myLevel: battlejson[id].levelname || '无灵力',
            oppLevel: battlejson[at].levelname || '无灵力',
            myEquip,
            oppEquip,
            win,
            result,
            extra
        })
        if (result.winner === 'me') {
            // 抢劫成功: 抢走500~1000灵石(不超过对方持有)
            var robbed = Math.round(500 + Math.random() * 500)
            if (robbed > targetMoney) robbed = targetMoney
            homejson[at].money = targetMoney - robbed
            let gain = afterTax(robbed)
            // 功法: 抢劫灵石加成(揽金诀×1.8 / 冥蝶手×2.5 / 太阴月华诀×3)
            try { const gfx = await getGongfaFx(id); if (gfx && gfx.rob) gain = Math.floor(gain * gfx.rob) } catch (err) { }
            homejson[id].money = (Number(homejson[id].money) || 0) + gain
            // 记录每日配对限制(当天结束失效)
            await redis.set(robDailyKey, '1', { EX: secondsUntilMidnight() })
        }
        // 战斗记录 + 结果 合并渲染成一张图片(不再分开发)
        const fightText = msgs.map(n => String((n && n.message) || '')).filter(Boolean).join('\n\n')
        const resultText = result.winner === 'me'
            ? `💰 抢劫成功！你抢走了 ${robbed} 灵石\n当前灵石：${homejson[id].money}`
            : `😵 抢劫失败！你被对方揍了一顿...\n5分钟后可以再试~`
        const img = await textToImg(`${fightText}\n\n${resultText}`)
        if (img) e.reply(img)
        else e.reply([segment.at(e.user_id), `\n${resultText}`])
        // 5分钟冷却(成功/失败都进入冷却)
        await redis.set(`xujing:wife-Robbery-cd:${e.group_id}:${e.user_id}`, currentTime, {
            EX: 300
        });
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        return true;
    }
    //抢老婆失败时调用
    async ntrF(e, jia, yi, key = 'ntr') {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        if (key == 'ntr') {
            var pcj = Math.round((homejson[yi].love / 10) + (homejson[jia].money / 3) + 100)//赔偿金
            setTimeout(() => {
                e.reply([
                    segment.at(jia), "\n",
                    `对方报警,你需要赔偿${pcj}灵石,;灵石不足将会被关禁闭`, "\n",
                ])
            }, 4000);
        }
        var jbtime = (pcj - homejson[jia].money) * 10//禁闭时间

        if (homejson[jia].money < pcj) {
            homejson[yi].money += afterTax(homejson[jia].money)
            homejson[jia].money = 0
            await redis.set(`xujing:wife-jinbi-cd:${e.group_id}:${jia}`, currentTime, {
                EX: jbtime
            });
            setTimeout(() => {
                e.reply(`恭喜你,你的灵石不足,因此赔光了还被关禁闭${jbtime / 60}分`)
            }, 5000);
        }
        if (homejson[jia].money >= pcj) {
            homejson[yi].money += afterTax(pcj)
            homejson[jia].money -= pcj
            setTimeout(() => {
                e.reply(`你成功清赔款${pcj}灵石!`)
            }, 6000);
        }
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
    }
    //抢老婆成功时调用
    async ntrT(e, jia, yi, key = 'ntr') {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var inpajson = await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, false)
        if (key == 'ntr') {
            // 抢之前检查抢的人(jia)房子容量: 能容纳新老婆
            const check = await this.canAddResident(e, jia)
            if (!check.ok) {
                e.reply(`你的房子住不下啦（${check.cap === Infinity ? '已住满' : `上限${check.cap}人`}），升级房子扩大可居住人数后再抢老婆吧~`)
                return
            }
            if ((homejson[jia].money > (homejson[yi].love * 1.5)) && (homejson[jia].money > homejson[yi].money))
                e.reply([
                    segment.at(yi), "\n",
                    `很遗憾!由于你老婆对你的好感并不是很高,对方又太有钱了!你的老婆被人抢走了!!!`
                ])
            else {
                e.reply([
                    segment.at(yi), "\n",
                    `很遗憾!由于你的疏忽,你的老婆被人抢走了!!!`
                ])
            }
            homejson[jia].s = homejson[yi].s
            homejson[jia].love = 6
            homejson[yi].s = 0
            homejson[yi].love = 0
            /* 被抢者老婆没了: 从小妾按先来后到补位 */
            const stolenWife = await this.promoteWife(yi, homejson, inpajson, filename)
            if (stolenWife) {
                const wname = await this.people(e, 'nickname', stolenWife)
                e.reply(`已从小妾中按先来后到补位,${wname}成为你的新老婆~`)
            }
            /* 抢老婆成功写入天下大事 */
            try {
                const jiaNick = await getNick(e.group_id, jia)
                const yiNick = await getNick(e.group_id, yi)
                logPlayerEvent(e.group_id, `【姻缘】散修 ${jiaNick} 抢走了散修 ${yiNick} 的道侣`)
            } catch (err) { }
        }
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
    }
    //愿意
    async yy(e) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var inpajson = await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, false)
        if (e.atme || e.atall) {
            e.reply(`6🙂`)
            return
        }
        if (!e.at) {
            e.reply(`请at你愿意嫁给的人哦(˵¯͒〰¯͒˵)`)
            return
        }
        id = e.at
        if (homejson[id].wait == 0) {
            e.reply(`对方还未向任何人求婚呢,就不要捣乱了`)
            return
        }
        if (homejson[id].wait !== e.user_id) {
            e.reply(`你不是${homejson[id].wait},就不要捣乱了`)
            return
        }
        const hasWife = !!homejson[id].s && Number(homejson[id].s) !== 0
        if (hasWife) {
            // 对方已有老婆→自己成为小妾(检查对方房子容量)
            const check = await this.canAddResident(e, id)
            if (!check.ok) {
                e.reply(`对方房子住不下啦（${check.cap === Infinity ? '已住满' : `上限${check.cap}人`}），无法成为小妾~`)
            } else {
                await this.applyMarry(homejson, inpajson, id, e.user_id)
                e.reply(`对方已经有老婆了,所以你成为了对方的小妾!!!`)
            }
            homejson[id].wait = 0
        } else {
            // 双方都无老婆→双向娶妻,双方房子都要能容纳新成员
            const checkA = await this.canAddResident(e, id)
            const checkB = await this.canAddResident(e, e.user_id)
            if (!checkA.ok || !checkB.ok) {
                e.reply(`你们中有人的房子住不下啦，无法结为夫妻~（请先升级房子扩大可居住人数）`)
                homejson[id].wait = 0
            } else {
                e.reply([
                    segment.at(e.user_id), "\n",
                    segment.at(id), "\n",
                    '相亲相爱幸福永，同德同心幸福长。愿你俩情比海深！祝福你们新婚愉快，幸福美满，激情永在，白头偕老！',
                ])
                homejson[id].s = e.user_id
                homejson[id].wait = 0
                homejson[id].money += afterTax(20)
                homejson[id].love = Math.round(Math.random() * (100 - 60) + 60)
                id = e.user_id
                homejson[id].s = e.at
                homejson[id].wait = 0
                homejson[id].money += afterTax(20)
                homejson[id].love = Math.round(Math.random() * (100 - 60) + 60)
                e.reply(`既然你们是两情相愿,你们现在的老婆就是彼此啦,给你们发了红包哦`)
            }
        }
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
        return true;
    }
    //拒绝
    async jj(e) {
        var id = e.at
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        if (e.atme || e.atall) {
            e.reply(`6🙂`)
            return
        }
        if (!e.at) {
            e.reply(`请at你想拒绝的人哦(˵¯͒〰¯͒˵)`)
            return
        }
        if (homejson[id].wait == 0) {
            e.reply(`对方还未向任何人求婚呢,就不要捣乱了`)
            return
        }
        if (homejson[id].wait !== e.user_id) {
            e.reply(`你不是${homejson[id].wait},就不要捣乱了`)
            return
        }
        e.reply([
            segment.at(id), "\n",
            '天涯何处无芳草，何必单恋一枝花，下次再努力点吧！(˵¯͒〰¯͒˵)',
        ])
        homejson[id].wait = 0
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        return true;
    }
    //随机娶
    async wife(e) {
        if (await this.is_jinbi(e) == true) return
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var inpajson = await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, false)
        if (homejson[id].money <= 30) {
            e.reply(`灵石不足,你只剩下${homejson[id].money}灵石了...等自动挂机赚点灵石吧!`)
            return
        }
        var battlejson = await xujing_data.getQQYUserBattle(id, battlejson, false, `${e.group_id}.json`)
        let UserPAF = battlejson[id].Privilege
        let lastTime = await redis.ttl(`xujing:whois-my-wife-cd:${e.group_id}:${e.user_id}`);
        if (lastTime !== -2 && !UserPAF) {
            e.reply([
                segment.at(e.user_id), "\n",
                `冷却中：${fmtCD(lastTime)}`
            ]);
            return
        }
        let sex = 'female'
        let msg1 = ''
        if (await Bot.pickFriend(e.user_id).sex == 'female') {
            msg1 = '系统检测到您为男性，'
        }
        else {
            msg1 = '系统检测到您为女性，'
        }
        if (e.msg.includes('娶') || e.msg.includes('老婆')) {
            sex = 'female'
            msg1 = msg1 + '正在按照您的要求寻找老婆！'
        }
        else {
            sex = 'male'
            msg1 = msg1 + '正在按照您的要求寻找老公！'
        }
        //e.reply(msg1)
        let memberMap = await e.group.getMemberMap();
        let arrMember = Array.from(memberMap.values());
        //读取memberMap中的值，赋值给一个数组arrMember
        //FILTER 函数基于布尔值 (True/False) 数组筛选数组
        //只读取sex属性为sex的
        var femaleList = arrMember.filter(item => {
            return item.sex == sex
        })
        //异性过少则读取无性别
        if (femaleList.length < 2) {
            const unknownList = arrMember.filter(item => {
                return item.sex == 'unknown'
            })
            unknownList.map(item => {
                femaleList.push(item)
            })
        }
        //写个过滤器删掉bot和发起人
        femaleList = femaleList.filter(item => { return item.user_id != e.user_id })
        femaleList = femaleList.filter(item => { return item.user_id != Bot.uin })
        // 空列表直接提示,避免随机到 undefined 崩溃
        if (!femaleList.length) {
            e.reply('群里暂时没有可以娶的对象~')
            return true
        }
        var gailv = Math.round(Math.random() * 9);
        const random = Math.floor(Math.random() * femaleList.length)
        let wife = femaleList[random];
        let msg = []
        if (gailv < sjwife || UserPAF) {
            /* 1. 容量检查: 满员直接拒绝(不产生"娶到"假消息,不扣钱) */
            const check = await this.canAddResident(e, id)
            if (!check.ok) {
                e.reply(`你的房子住不下啦（${check.cap === Infinity ? '已住满' : `上限${check.cap}人`}），升级房子扩大可居住人数后再${homejson[id].s ? '纳妾' : '娶妻'}吧~`)
                await redis.set(`xujing:whois-my-wife-cd:${e.group_id}:${e.user_id}`, currentTime, {
                    EX: cdTime
                });
                return true
            }
            /* 2. 写入: 有老婆→纳妾(双修人更多) / 无老婆→娶妻 */
            const hasWife = !!homejson[id].s && Number(homejson[id].s) !== 0
            if (hasWife) {
                inpajson[id].shuangxiu.push(wife.user_id)
            } else {
                homejson[id].s = wife.user_id
                homejson[id].money -= 30
                homejson[id].love = Math.round(Math.random() * (70 - 1) + 1)
            }
            /* 3. 构建成功消息 */
            let sexStr = wife.sex == 'male' ? '男' : '女'
            let she_he = await this.people(e, 'sex', wife.user_id)
            let name = await this.people(e, 'nickname', wife.user_id)
            msg = [
                segment.at(e.user_id), "\n",
                `${name}答应了你哦！(*/ω＼*)`, "\n",
                `今天你的${sexStr}朋友是`, "\n",
                segment.image(`https://q1.qlogo.cn/g?b=qq&s=0&nk=${wife.user_id}`), "\n",
                `【${name}】 (${wife.user_id}) `, "\n",
                `来自【${e.group_name}】`, "\n",
                `要好好对待${she_he}哦！${hasWife ? '\n(你已有老婆,对方成为你的小妾,可一起双修)' : ''}`,
            ]
            await redis.set(`xujing:whois-my-wife-cd:${e.group_id}:${e.user_id}`, currentTime, {
                EX: cdTime
            });
        }
        else if (gailv >= sjwife) {
            var dsp = Math.round(Math.random() * (20 - 10) + 10)
            msg = [
                segment.at(e.user_id), "\n",
                `好遗憾，你谁也没娶到,${dsp}灵石打水漂了!`
            ]
            homejson[id].money -= dsp
            await redis.set(`xujing:whois-my-wife-cd:${e.group_id}:${e.user_id}`, currentTime, {
                EX: cdTime
            });
        }
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
        e.reply(msg);
        return true;
    }
    //主动分手/甩掉对方(支持甩老婆/甩双修对象, 可带@)
    async breakup(e) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var inpajson = await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, false)
        if (!e.at && (e.msg.includes("分手") || e.msg.includes("闹离婚"))) {
            // 不带@的分手/闹离婚 → 甩自己老婆
            if (homejson[id].s == 0) {//如果json中不存在该用户或者老婆s为0
                e.reply(`醒醒,你根本在这里没有老婆!!`)
                return
            }
            let she_he = await this.people(e, 'sex', homejson[id].s)//用is_she函数判断下这个人是男是女
            homejson[id].s = 0
            homejson[id].love = 0
            const newWife = await this.promoteWife(id, homejson, inpajson, filename)
            if (newWife) {
                const wname = await this.people(e, 'nickname', newWife)
                e.reply(`成功分手!,${she_he}对你的好感荡然无存!已从小妾中按先来后到补位,${wname}成为你的新老婆~`)
            } else {
                await xujing_data.getQQYUserHome(id, homejson, filename, true)
                e.reply(`成功分手!,${she_he}对你的好感荡然无存!现在你可以去娶下一个老婆了(呸!渣男..￣へ￣)`)
            }
            return
        }
        if (!e.at) {
            e.reply(`请顺带at你想要甩掉的人(怎么会有强娶这种设定?(っ °Д °;)っ)`)
            return
        }
        if (e.atme || e.atall) {
            e.reply(`6🙂`)
            return
        }
        var cnm = e.user_id
        let she_he = await this.people(e, 'sex', e.at)
        /* 情况1: e.at 是我的老婆 → 甩掉老婆(老婆也会从小妾补位新老婆) */
        if (homejson[e.at] && homejson[e.at].s === cnm) {
            homejson[e.at].s = 0
            homejson[e.at].love = 0
            await this.promoteWife(e.at, homejson, inpajson, filename)
            await xujing_data.getQQYUserHome(e.at, homejson, filename, true)
            e.reply(`成功把${she_he}甩掉!,并表示不要再来纠缠你了.${she_he}差点哭死...,`)
            return
        }
        /* 情况2: e.at 是我的双修对象(小妾) → 从我的小妾列表移除 */
        const myXq = (inpajson[id] && Array.isArray(inpajson[id].shuangxiu)) ? inpajson[id].shuangxiu : []
        if (myXq.map(String).includes(String(e.at))) {
            inpajson[id].shuangxiu = myXq.filter(x => String(x) !== String(e.at))
            await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
            e.reply(`成功把${she_he}从你的双修队伍中移除！`)
            return
        }
        e.reply(`${she_he}不是你的老婆，也不是你的双修对象~`)
        return true;
    }
    //摆摊
    async stall(e) {
        if (await this.is_jinbi(e) == true) return
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var battlejson = await xujing_data.getQQYUserBattle(id, battlejson, false, `${e.group_id}.json`)
        let UserPAF = battlejson[id].Privilege
        let lastTime = await redis.ttl(`xujing:wife-stall-cd:${e.group_id}:${e.user_id}`);
        if (lastTime !== -2 && !UserPAF) {
            e.reply([segment.at(e.user_id), "\n", `冷却中：${fmtCD(lastTime)}`])
            return
        }
        await redis.set(`xujing:wife-stall-cd:${e.group_id}:${e.user_id}`, currentTime, { EX: 60 * 60 })
        var housejson = await xujing_data.getQQYUserHouse(id, housejson, filename, false)
        let workBonus = bestBonus(housejson, homejson, {}, id, 'work')
        let get = Math.round((Math.random() * 300 + 200) * (1 + workBonus / 100))
        /* 修仙世界: 摆摊收入按所在大区动态税率扣税(税收计入宗门繁荣度) */
        const world = getWorld(e.group_id)
        const loc = getLoc(world, id)
        const rate = taxFor(world, loc, playerSectName(e.group_id, id))
        const tax = Math.floor(get * rate / 100)
        const getTax = get - tax
        homejson[id].money += getTax
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        addTax(world, loc, tax)
        saveWorld(world)
        const boss = bossOf(world, loc)
        const owner = boss ? `${REGIONS[loc].name}${boss}` : `${REGIONS[loc].name}各占领宗门`
        e.reply(`🏪 摆摊收摊！今天赚了${getTax}灵石（税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}）！${workBonus > 0 ? `(房子挂机/摆摊加成${workBonus}%)` : ''}`)
        /* 摆摊不记录信息(用户要求不留摆摊记录) */
        return true
    }
    //限时秘境：每天开放一个，当天可探索3次(可一次次刷,也可 #秘境名 3 一次刷完)
    async realm(e) {
        if (await this.is_jinbi(e) == true) return
        const name = e.msg.replace(/[#＃\s\d]/g, '')
        const cfg = SECRET_REALMS[name]
        if (!cfg) return
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        const now = new Date()
        const day = now.getDay()
        const hour = now.getHours()
        if (hour < 20) {
            e.reply(`${cfg.emoji} ${name}仅在${WEEKDAY_CN[cfg.day]}的晚上20:00-24:00开放，现在太早了哦~`)
            return
        }
        if (day !== cfg.day) {
            e.reply(`${cfg.emoji} ${name}仅在${WEEKDAY_CN[cfg.day]}的晚上20:00-24:00开放，今天进不了哦~`)
            return
        }
        const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
        const rkey = `xujing:secret:${id}:${dayKey}`
        const MAX_DAILY = 3
        const used = Number(await redis.get(rkey)) || 0
        if (used >= MAX_DAILY) {
            e.reply(`${cfg.emoji} ${name}今天已探索完${MAX_DAILY}次，明天再来吧~`)
            return
        }
        // 解析次数(默认1次; 防呆: 0/负数/非数字→1次, 超剩余→按剩余并提示)
        const remain = MAX_DAILY - used
        let want = 1
        const numM = String(e.msg || '').match(/(\d+)/)
        if (numM) {
            const t = parseInt(numM[1])
            want = t >= 1 ? t : 1
        }
        if (want > remain) {
            e.reply(`${cfg.emoji} 你请求探索${want}次，但今天最多还能探索${remain}次，已按${remain}次进行~`)
            want = remain
        }
        const n = want
        /* 探索 n 次(灵石+掉落累计) */
        var housejson = await xujing_data.getQQYUserHouse(id, housejson, filename, false)
        let workBonus = bestBonus(housejson, homejson, {}, id, 'work')
        const weekend = (day === 0 || day === 6)
        let totalMoney = 0
        const allDrops = []
        for (let i = 0; i < n; i++) {
            // 灵石奖励翻1倍(扣20%税)
            const get = Math.round((Math.random() * (cfg.max - cfg.min) + cfg.min) * 2 * (1 + workBonus / 100))
            const getTax = afterTax(get)
            homejson[id].money += getTax
            totalMoney += getTax
            const drops = await rollSecretDrops(id, weekend, e.group_id)
            allDrops.push(...drops)
        }
        await redis.set(rkey, String(used + n), { EX: 24 * 60 * 60 })
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        /* 秘境重宝写入天下大事: 金色装备/红彩材料/红彩功法 */
        const rare = allDrops.filter(d => /金色装备|🔴|🌈|📕/.test(d))
        if (rare.length) {
            try {
                const nick = await getNick(e.group_id, id)
                logPlayerEvent(e.group_id, `【机缘】散修 ${nick} 于${name}寻得 ${rare.join('、')}，天降重宝！`)
            } catch (err) { }
        }
        let msg = `${cfg.emoji} 探索${name}×${n}成功！${workBonus > 0 ? `(房子挂机/摆摊加成${workBonus}%)` : ''}`
        msg += `\n🎁 获得：${totalMoney}灵石`
        if (allDrops.length) msg += `、${allDrops.join('、')}`
        msg += `\n今日剩余探索：${MAX_DAILY - used - n}次`
        e.reply(msg)
        return true
    }
    /** 使用灵宝盒(支持一次开多个): 每个相当于一次秘境探索(幻境12点结算前3名奖励) */
    async openBox(e) {
        const id = e.user_id
        const m = String(e.msg || '').match(/(\d+)/)
        const n = m ? Math.max(1, parseInt(m[1])) : 1//没输数量默认开1个,不限制上限
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['灵宝盒']) ? bag.items['灵宝盒'].count : 0
        if (have < n) {
            e.reply(`灵宝盒不够啦！开${n}个需要${n}个，你只有${have}个~`)
            return true
        }
        consumeItem(id, '灵宝盒', n, null, e.group_id)
        const now = new Date()
        const weekend = (now.getDay() === 0 || now.getDay() === 6)
        const allDrops = []
        for (let i = 0; i < n; i++) {
            const drops = await rollSecretDrops(id, weekend, e.group_id)
            allDrops.push(...drops)
        }
        e.reply(allDrops.length
            ? `🎁 开启灵宝盒×${n}！获得丰厚奖励：\n${allDrops.join('、')}`
            : `🎁 开启灵宝盒×${n}！可惜这次什么也没开出，明天再来吧~`)
        return true
    }
    //看房
    async gethouse(e) {
        /* 看房时顺带清理超员旧档 */
        const pruned = await this.pruneOverCapacity(e)
        var housething = JSON.parse(fs.readFileSync(housepath, "utf8"));//读取文件
        var msg = []
        msg.push(`欢迎光临,请过目(使用 #升级房子 一级一级升级,不能跨级)${pruned > 0 ? `\n⚠️ 已清理${pruned}名超员小妾` : ''}:`)
        var house = []
        for (let i of Object.keys(housething)) {
            const sp = Number(housething[i].space)
            const capText = sp === -1 ? '无上限' : `${sp}人`
            msg.push(`id: ${i}\n${housething[i].name}\n可居住人数: ${capText}\n价格: ${housething[i].price}\n好感增幅: ${housething[i].loveup}\n挂机/摆摊加成: ${housething[i].work}%\n抱抱加成: ${housething[i].hug}%\n修炼加成: ${housething[i].cultivate}%\n`)
        }
        Config.getforwardMsg(msg,e)
        return true
    }
    //升级房子: 一级一级升级,不能跨级(可@帮别人升级,由自己付费)
    async buyhouse(e) {
        var housething = JSON.parse(fs.readFileSync(housepath, "utf8"));//读取文件
        var buyer = e.user_id
        var id = e.at || e.user_id//目标(默认自己)
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(buyer, null, filename, false)
        var housejson = await xujing_data.getQQYUserHouse(id, null, filename, false)
        // 当前等级: 优先 level 字段, 兼容旧存档按名字匹配
        let curLevel = Number(housejson[id].level) || 0
        if (!curLevel) {
            for (const k of Object.keys(housething)) {
                if (housething[k].name === housejson[id].name) { curLevel = Number(k); break }
            }
        }
        const maxLevel = Object.keys(housething).length
        if (curLevel >= maxLevel) {
            e.reply('已是最高等级的住所，无法再升级啦~')
            return true
        }
        const target = curLevel + 1
        const tpl = housething[target]
        if (!tpl) {
            e.reply('无法升级到目标等级~')
            return true
        }
        if (homejson[buyer].money < tpl.price) {
            e.reply(`灵石不足，升级到【${tpl.name}】需要 ${tpl.price} 灵石~`)
            return true
        }
        // 扣款 + 升级(替换为该等级完整属性)
        homejson[buyer].money -= tpl.price
        housejson[id].level = target
        housejson[id].name = tpl.name
        housejson[id].space = tpl.space
        housejson[id].price = tpl.price
        housejson[id].loveup = tpl.loveup
        housejson[id].work = tpl.work
        housejson[id].hug = tpl.hug
        housejson[id].cultivate = tpl.cultivate
        await xujing_data.getQQYUserHome(buyer, homejson, filename, true)
        await xujing_data.getQQYUserHouse(id, housejson, filename, true)
        /* 升级后超员清理(旧档可能原本就超员) */
        const pruned = await this.pruneOverCapacity(e)
        const capText = Number(tpl.space) === -1 ? '无上限' : `${tpl.space}人`
        e.reply(`✅ 升级成功！${id} 的住所升级为【${tpl.name}】(Lv.${target})\n可居住人数${capText} 好感×${tpl.loveup} 挂机/摆摊+${tpl.work}% 抱抱+${tpl.hug}% 修炼+${tpl.cultivate}%\n本次消费 ${tpl.price} 灵石${pruned > 0 ? `\n(清理了${pruned}名超员小妾)` : ''}`)
        return true;
    }
    //住所改名
    async namedhouse(e) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var housejson = await xujing_data.getQQYUserHouse(id, housejson, filename, false)
        var msg = e.msg.replace(/(住所改名|#)/g, "").replace(/[\n|\r]/g, "，").trim()
        var shifu = Math.max(500, Math.round((housejson[id].price || 500) * 0.05))//改名费=房价5%,最低500
        if (homejson[id].money < shifu) {
            e.reply(`灵石不足,需要${shifu}灵石`)
            return
        }
        homejson[id].money -= shifu
        housejson[id].name = msg
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        await xujing_data.getQQYUserHouse(id, housejson, filename, true)
        e.reply(`改名"${msg}"成功`)
        return true;
    }
    //逛街(打开集市菜单无冷却,冷却在随机事件上)
    async gift(e) {
        if (await this.is_jinbi(e) == true) return
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var placejson = await xujing_data.getQQYUserPlace(id, placejson, filename, false)
        if (placejson[id].place !== "home") {
            e.reply([
                segment.at(id), "\n",
                `你不在家,不能进行逛街,当前位置为：${placejson[id].place}`
            ])
            return
        }
        /* 交互压栈: 压到栈顶(优先回复), 不终止下层交互(渡劫等被埋后仍可恢复) */
        await forceLock(e.group_id, id, 'street')
        // 显示集市菜单
        streetState[id] = { mode: 'menu', time: Date.now() }
        e.reply([
            segment.at(id), "\n",
            `🏮 虚境集市\n`,
            `请回复数字选择去处：\n`,
            `1. 🏯 丹阁（购买丹药）\n`,
            `2. ⚔️ 器阁（购买武器装备）\n`,
            `3. 💎 藏宝阁（奇珍异宝）\n`,
            `4. 🌍 随意逛逛（随机事件）\n`,
            `\n（回复对应数字即可）`
        ])
        return true;
    }

    /** 数字选择:处理集市的数字回复 */
    async streetChoose(e) {
        const st = streetState[e.user_id]
        if (!st || Date.now() - st.time > 5 * 60 * 1000) {
            /* 逛街状态过期/丢失: 摘除自己的锁(可能在栈顶也可能被埋), 让后续交互正常路由 */
            await unlock(e.group_id, e.user_id, 'street')
            delete streetState[e.user_id]
            return false
        }
        /* 校验: 仅当逛街在栈顶才处理(被渡劫/换装埋住则让位, 保留逛街状态等回到栈顶再恢复) */
        if (!(await isCurrent(e.group_id, e.user_id, 'street'))) {
            return false
        }
        /* 状态锁复查: 洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态下禁止用数字买东西/逛街
           (统一 Proxy 拦截文字指令但放行裸数字, 这里堵住"先开菜单→再被锁→数字绕锁"的漏洞) */
        if (await guardActionLocked(e)) {
            await unlock(e.group_id, e.user_id, 'street')
            delete streetState[e.user_id]
            return true
        }
        // 解析"序号 [数量]": 支持 1 / 1 5 / 1x5 / 1×5 / 1*5
        const parts = e.msg.replace('#', '').trim().split(/[x×*\s]+/).filter(Boolean)
        const num = parseInt(parts[0])
        let count = parts.length > 1 ? parseInt(parts[1]) : 1
        if (!(count >= 1)) count = 1
        if (count > 99) count = 99
        if (st.mode === 'menu') {
            if (num === 1) return await this.dangeShow(e)
            if (num === 2) return await this.qigeShow(e)
            if (num === 3) return await this.cangbaogeShow(e)
            if (num === 4) return await this.streetRandom(e)
            e.reply('请输入 1~4 选择去处')
            return true
        }
        if (st.mode === 'dange') return await this.dangeBuy(e, num, count)
        if (st.mode === 'qige') return await this.qigeBuy(e, num, count)
        // 藏宝阁:购买功法(支持数量),0 返回集市
        if (st.mode === 'cangbaoge') return await this.cangbaogeBuy(e, num, count)
        // 未知模式:不吞其他插件的数字指令
        return false
    }

    /** 返回集市菜单 */
    async backToMenu(e) {
        streetState[e.user_id] = { mode: 'menu', time: Date.now() }
        e.reply(`🏮 已返回虚境集市\n1. 🏯 丹阁（丹药）\n2. ⚔️ 器阁（装备）\n3. 💎 藏宝阁\n4. 🌍 随意逛逛（随机事件）\n\n回复数字选择`)
        return true
    }

    /** 丹阁:显示丹药(动态补货,售罄等补货) */
    async dangeShow(e) {
        const id = e.user_id
        /* 交互压栈: 直接进入也压street锁,否则数字购买无法路由(同#逛街) */
        await forceLock(e.group_id, id, 'street')
        const filename = e.group_id + `.json`
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        const bag = getBag(id, e.group_id)
        streetState[id] = { mode: 'dange', time: Date.now() }
        const names = ['修为丹', '破障丹']
        /* 按玩家所在大区取库存 */
        const rg = getLoc(getWorld(e.group_id), id)
        const rgName = regionNameOf(rg)
        const stock = await getStock(e.group_id, 'dange', rg)
        const money = (homejson[id] && homejson[id].money) || 0
        const inStr = await restockIn(e.group_id, 'dange', rg)
        const allSold = !Object.values(stock).some(v => Number(v) > 0)
        const lines = [
            `🏯 丹阁·${rgName}（当前灵石：${money}）`,
            `回复"序号"或"序号 数量"购买：`,
            ''
        ]
        if (allSold) {
            /* 本区售罄 */
            lines.push(`🈳 （${rgName}）的丹药已售罄！`)
        } else {
            names.forEach((n, i) => {
                const have = (bag.items && bag.items[n]) ? bag.items[n].count : 0
                const left = Number(stock[n]) || 0
                const leftStr = left > 0 ? `剩${left}颗` : '🈳已售罄'
                lines.push(`${i + 1}. ${ITEM_TPL[n].icon}${n} ${ITEM_PRICE[n]}灵石（${ITEM_TPL[n].desc}）${leftStr}，你持有${have}颗`)
            })
        }
        /* 本区补货时间(有货无货都显示) */
        lines.push('', `⏳ 本区下次补货约 ${inStr}`)
        /* 其他大区库存+补货时间(有货无货都显示) */
        lines.push('', '其他大区丹阁：')
        lines.push(...await otherRegionsStock(e.group_id, 'dange', rg, 'dange'))
        lines.push('0. 返回')
        const img = await textToImg(lines.join('\n'))
        if (img) e.reply(img)
        else e.reply(lines.join('\n'))
        return true
    }

    /** 丹阁:购买丹药(支持数量,扣库存售罄等补货) */
    async dangeBuy(e, num, count = 1) {
        const id = e.user_id
        const filename = e.group_id + `.json`
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        if (num === 0) return await this.backToMenu(e)
        const names = ['修为丹', '破障丹']
        const name = names[num - 1]
        if (!name) {
            e.reply('请输入 1~2 选择丹药，0 返回')
            return true
        }
        const price = ITEM_PRICE[name]
        const money = (homejson[id] && homejson[id].money) || 0
        const total = price * count
        if (money < total) {
            e.reply(`灵石不足！${itemIcon(name)}${name}×${count}需要${total}灵石，你只有${money}灵石，先等自动挂机赚点灵石吧~`)
            return true
        }
        /* 按玩家所在大区扣库存(售罄/不足提示) */
        const rg = getLoc(getWorld(e.group_id), id)
        const res = await buyStock(e.group_id, 'dange', name, count, rg)
        if (!res.ok) {
            const inStr = await restockIn(e.group_id, 'dange', rg)
            if (res.soldout) e.reply(`🈳 （${regionNameOf(rg)}）丹阁的${itemIcon(name)}${name}已售罄！约 ${inStr} 补货，到时再来吧~`)
            else e.reply('购买失败，请稍后再试~')
            return true
        }
        const n = res.count
        const total2 = price * n
        homejson[id].money -= total2
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        addItem(id, name, n, null, e.group_id)
        const stax = shopSaleTax(e.group_id, rg, total2, playerSectName(e.group_id, id))
        logPlayerTrade(e.group_id, `【丹阁·${regionNameOf(rg)}】${playerTitle(e.group_id, id, e.nickname)} 购得 ${itemIcon(name)}${name} ×${n}（-${total2}灵石，税率${stax.rate}%扣税${stax.tax}，上交${stax.owner}）`)
        recordActive(e.group_id, id, rg)
        e.reply(`购买成功！已获得 ${itemIcon(name)}${name} ×${n}，剩余灵石 ${homejson[id].money}（税率 ${stax.rate}%，扣税 ${stax.tax} 灵石，上交${stax.owner}）`)
        return true
    }

    /** 器阁:显示当前库存装备(动态补货,随机抽部位上架,没抽中的不显示) */
    async qigeShow(e) {
        const id = e.user_id
        /* 交互压栈: 直接进入也压street锁,否则数字购买无法路由(同#逛街) */
        await forceLock(e.group_id, id, 'street')
        const filename = e.group_id + `.json`
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        /* 按玩家所在大区取库存 */
        const rg = getLoc(getWorld(e.group_id), id)
        const rgName = regionNameOf(rg)
        const stock = await getStock(e.group_id, 'qige', rg)
        const names = Object.keys(stock)
        const money = (homejson[id] && homejson[id].money) || 0
        streetState[id] = { mode: 'qige', list: names, time: Date.now() }
        const inStr = await restockIn(e.group_id, 'qige', rg)
        if (!names.length) {
            /* 本批售罄: 提示 + 其他大区数量/补货时间(图片) */
            const lines = [
                `⚔️ 器阁·${rgName}（当前灵石 ${money}）`,
                `🈳 （${rgName}）器阁的本批货物已售罄！`,
                '看看其他大区的器阁：',
                ...await otherRegionsStock(e.group_id, 'qige', rg, 'qige'),
                '',
                `⏳ 本区下次补货约 ${inStr}`,
                '0. 返回'
            ]
            const img = await textToImg(lines.join('\n'))
            if (img) e.reply(img)
            else e.reply(lines.join('\n'))
            return true
        }
        const msgArr = [`⚔️ 器阁·${rgName} · 本批货物（当前灵石 ${money}，回复"序号"或"序号 数量"购买，0 返回）`]
        names.forEach((n, i) => {
            const t = EQUIP_TPL[n]
            const q = QUALITY[t.quality]
            const left = Number(stock[n]) || 0
            msgArr.push(`${i + 1}. ${q.icon}${n}（${PARTS[t.type]}）剩${left}件\n${fmtAttr(getItemAttr(null, n))}\n价格：${equipPrice(n)}灵石`)
        })
        msgArr.push(`\n⏳ 本区下次补货约 ${inStr}`)
        /* 其他大区库存+补货时间(有货无货都显示) */
        msgArr.push('', '其他大区器阁：', ...await otherRegionsStock(e.group_id, 'qige', rg, 'qige'))
        Config.getforwardMsg(msgArr, e)
        return true
    }

    /** 器阁:购买装备(支持数量,扣库存) */
    async qigeBuy(e, num, count = 1) {
        const st = streetState[e.user_id]
        const id = e.user_id
        const filename = e.group_id + `.json`
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        if (num === 0) return await this.backToMenu(e)
        const name = st.list[num - 1]
        if (!name) {
            e.reply(`请输入 1~${st.list.length} 选择装备，0 返回`)
            return true
        }
        const price = equipPrice(name)
        const money = (homejson[id] && homejson[id].money) || 0
        const total = price * count
        if (money < total) {
            e.reply(`灵石不足！${itemIcon(name)}${name}×${count}需要${total}灵石，你只有${money}灵石，先等自动挂机赚点灵石吧~`)
            return true
        }
        /* 按玩家所在大区扣库存(售罄/不足提示) */
        const rg = getLoc(getWorld(e.group_id), id)
        const res = await buyStock(e.group_id, 'qige', name, count, rg)
        if (!res.ok) {
            const inStr = await restockIn(e.group_id, 'qige', rg)
            if (res.soldout) e.reply(`🈳 （${regionNameOf(rg)}）器阁的${itemIcon(name)}${name}已售罄！约 ${inStr} 补货，到时再来吧~`)
            else e.reply('购买失败，请稍后再试~')
            return true
        }
        const n = res.count
        const total2 = price * n
        homejson[id].money -= total2
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        const ret = addItem(id, name, n, null, e.group_id)
        const stax = shopSaleTax(e.group_id, rg, total2, playerSectName(e.group_id, id))
        logPlayerTrade(e.group_id, `【器阁·${regionNameOf(rg)}】${playerTitle(e.group_id, id, e.nickname)} 购得 ${itemIcon(name)}${name} ×${n}（-${total2}灵石，税率${stax.rate}%扣税${stax.tax}，上交${stax.owner}）`)
        recordActive(e.group_id, id, rg)
        e.reply(`购买成功！已获得 ${itemIcon(name)}${name} ×${n}（${fmtAttr(getItemAttr(ret.bag, name))}），剩余灵石 ${homejson[id].money}（税率 ${stax.rate}%，扣税 ${stax.tax} 灵石，上交${stax.owner}）（若比你当前装备更强会自动穿上）`)
        return true
    }

    /** 藏宝阁:功法商店(动态补货,只售本批库存功法) */
    async cangbaogeShow(e) {
        const id = e.user_id
        /* 交互压栈: 直接进入也压street锁,否则数字购买无法路由(同#逛街) */
        await forceLock(e.group_id, id, 'street')
        const filename = e.group_id + '.json'
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        const money = (homejson[id] && homejson[id].money) || 0
        /* 按玩家所在大区取库存 */
        const rg = getLoc(getWorld(e.group_id), id)
        const rgName = regionNameOf(rg)
        const stock = await getStock(e.group_id, 'cangbaoge', rg)
        const list = Object.keys(stock).sort((a, b) => GONGFA_TPL[b].quality - GONGFA_TPL[a].quality || a.localeCompare(b))
        streetState[id] = { mode: 'cangbaoge', list, time: Date.now() }
        const learned = await getLearnedGongfa(id)
        const active = await redis.get(`xujing:gongfa-active:${id}`)
        const inStr = await restockIn(e.group_id, 'cangbaoge', rg)
        const lines = [
            `💎 藏宝阁·${rgName} · 功法（当前灵石 ${money}）`,
            `回复"序号"或"序号 数量"购买功法书，0 返回`,
            ''
        ]
        if (!list.length) {
            /* 本批售罄: 提示 + 其他大区数量/补货时间 */
            lines.push(`🈳 （${rgName}）藏宝阁的本批功法已售罄！`)
            lines.push('看看其他大区的藏宝阁：')
            lines.push(...await otherRegionsStock(e.group_id, 'cangbaoge', rg, 'cangbaoge'))
        } else {
            list.forEach((n, i) => {
                const g = GONGFA_TPL[n]
                const q = QUALITY[g.quality]
                lines.push(`${i + 1}. ${q.icon}《${n}》 ${gongfaPrice(n)}灵石 剩${stock[n]}本\n    ${fmtGongfaFx(g.fx)}`)
            })
        }
        lines.push('', `已学会 ${Object.keys(learned).length} 本`)
        if (active) lines.push(`当前运转：${QUALITY[GONGFA_TPL[active].quality].icon}《${active}》`)
        else lines.push('当前未运转任何功法')
        lines.push('', '卖回：#卖功法 <名> <数量>')
        lines.push('', `⏳ 本区下次补货约 ${inStr}`)
        /* 其他大区库存+补货时间(有货无货都显示) */
        lines.push('', '其他大区藏宝阁：')
        lines.push(...await otherRegionsStock(e.group_id, 'cangbaoge', rg, 'cangbaoge'))
        /* 隐藏玩法入口暗示(仅20:30~24:00显示) */
        if (raidOpen()) lines.push('', '……今夜月黑风高，宝阁深处似有异动……')
        const img = await textToImg(lines.join('\n'))
        if (img) e.reply(img)
        else e.reply(lines.join('\n'))
        return true
    }

    /** 藏宝阁:购买功法书(扣库存,售罄等补货) */
    async cangbaogeBuy(e, num, count = 1) {
        const st = streetState[e.user_id]
        const id = e.user_id
        const filename = e.group_id + '.json'
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        if (num === 0) return await this.backToMenu(e)
        const name = st.list[num - 1]
        if (!name) {
            e.reply(`请输入 1~${st.list.length} 选择功法，0 返回`)
            return true
        }
        const price = gongfaPrice(name)
        const money = (homejson[id] && homejson[id].money) || 0
        const total = price * count
        if (money < total) {
            e.reply(`灵石不足！${itemIcon(name)}《${name}》×${count}需要${total}灵石，你只有${money}灵石~`)
            return true
        }
        /* 按玩家所在大区扣库存(售罄/不足提示) */
        const rg = getLoc(getWorld(e.group_id), id)
        const res = await buyStock(e.group_id, 'cangbaoge', name, count, rg)
        if (!res.ok) {
            const inStr = await restockIn(e.group_id, 'cangbaoge', rg)
            if (res.soldout) e.reply(`🈳 （${regionNameOf(rg)}）藏宝阁的《${name}》已售罄！约 ${inStr} 补货，到时再来吧~`)
            else e.reply('购买失败，请稍后再试~')
            return true
        }
        const n = res.count
        const total2 = price * n
        homejson[id].money -= total2
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        addItem(id, name, n, null, e.group_id)
        const stax = shopSaleTax(e.group_id, rg, total2, playerSectName(e.group_id, id))
        logPlayerTrade(e.group_id, `【藏宝阁·${regionNameOf(rg)}】${playerTitle(e.group_id, id, e.nickname)} 购得 功法${itemIcon(name)}《${name}》×${n}（-${total2}灵石，税率${stax.rate}%扣税${stax.tax}，上交${stax.owner}）`)
        recordActive(e.group_id, id, rg)
        e.reply(`✅ 购买成功！获得功法${itemIcon(name)}《${name}》×${n}，剩余灵石 ${homejson[id].money}（税率 ${stax.rate}%，扣税 ${stax.tax} 灵石，上交${stax.owner}）\n使用 #修炼功法 ${name} 学会，再 #运转功法 ${name} 激活`)
        return true
    }

    /** #功法: 我的功法库 */
    async gongfaStatus(e) {
        const id = e.user_id
        const learned = await getLearnedGongfa(id)
        const active = await redis.get(`xujing:gongfa-active:${id}`)
        const lines = ['📖 我的功法库']
        const names = Object.keys(learned)
        if (!names.length) {
            lines.push('你还没学会任何功法，去 #去藏宝阁 买一本功法书吧~')
        } else {
            names.sort((a, b) => GONGFA_TPL[b].quality - GONGFA_TPL[a].quality)
            for (const n of names) {
                const g = GONGFA_TPL[n]
                const q = QUALITY[g.quality]
                const isActive = n === active
                lines.push(`${q.icon}《${n}》${isActive ? ' ✅运转中' : ''}\n    ${fmtGongfaFx(g.fx)}`)
            }
        }
        if (active) lines.push(`\n当前运转：《${active}》`)
        else lines.push('\n当前未运转任何功法（#运转功法 <名> 激活）')
        /* 渲染图片(与宗门面板/玩法大全一致), 失败回退纯文本 */
        let img = null
        try { img = await textToImg(lines.join('\n')) } catch (err) { }
        if (img) e.reply(img)
        else e.reply(lines.join('\n'))
        return true
    }

    /** #功法图鉴: 全部31种(双列HTML图片渲染,失败回退文本) */
    async gongfaAll(e) {
        const id = e.user_id
        const learned = await getLearnedGongfa(id)
        const active = await redis.get(`xujing:gongfa-active:${id}`)
        /* 按品质分组, 供双列模板渲染 */
        const groups = []
        for (let q = 1; q <= 7; q++) {
            const arr = Object.keys(GONGFA_TPL).filter(n => GONGFA_TPL[n].quality === q)
            if (!arr.length) continue
            arr.sort((a, b) => a.localeCompare(b))
            groups.push({
                quality: q,
                icon: QUALITY[q].icon,
                name: QUALITY[q].name,
                list: arr.map(n => ({
                    name: n,
                    quality: q,
                    fx: GONGFA_TPL[n].puppetChapter ? '仅用于解锁对应傀儡阶段，不提供额外战斗加成' : fmtGongfaFx(GONGFA_TPL[n].fx),
                    mark: n === active ? '运转中' : (learned[n] ? '已学' : '')
                }))
            })
        }
        /* 双列图片渲染 */
        const bg = rodom()
        const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
        try {
            const img = await puppeteer.screenshot(`${Plugin_Name}/gongfa/index`, {
                tplFile: path.join(Plugin_Path, 'resources', 'qylp', 'gongfa.html'),
                pluResPath: resPath,
                _res_path: resPath,
                saveId: `gongfa-${Date.now()}`,
                bg,
                groups
            })
            if (img) { e.reply(img); return true }
        } catch (err) {
            logger.error(`[虚境] 功法图鉴渲染失败: ${err && err.message}`)
        }
        /* 渲染失败回退纯文本 */
        const lines = ['📜 功法图鉴（共31种）']
        for (const g of groups) {
            lines.push(`\n${g.icon} ${g.name}功法（${g.list.length}本）`)
            for (const it of g.list) lines.push(`《${it.name}》${it.mark ? ' [' + it.mark + ']' : ''}\n    ${it.fx}`)
        }
        lines.push('', '金及以下可去 #去藏宝阁 购买；红/彩可于虚境秘境极低概率获得')
        e.reply(lines.join('\n'))
        return true
    }

    /** #修炼功法 <名>: 消耗功法书学会 */
    async gongfaLearn(e) {
        const m = String(e.msg || '').replace(/^[#＃]?(修炼|学习|学会|习得)功法\s*/, '').trim()
        const id = e.user_id
        if (!m) {
            e.reply('用法：#修炼功法 <功法名>\n例：#修炼功法 鸿运诀')
            return true
        }
        const name = Object.keys(GONGFA_TPL).find(n => n === m || m.includes(n))
        if (!name) { e.reply(`没有找到功法《${m}》，#功法图鉴 查看全部`); return true }
        if (isPuppetTechnique(name)) {
            const gate = await canLearnPuppetTechnique(id, name)
            if (!gate.ok) { e.reply(gate.msg); return true }
        }
        if (await isGongfaLearned(id, name)) { e.reply(`你已学会《${name}》啦~`); return true }
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items[name]) ? bag.items[name].count : 0
        if (have < 1) { e.reply(`背包里没有《${name}》功法书，先去 #去藏宝阁 购买吧~`); return true }
        consumeItem(id, name, 1, null, e.group_id)
        await learnGongfa(id, name)
        if (isPuppetTechnique(name)) {
            const info = puppetTechniqueInfo(name)
            e.reply(`📖 修炼成功！你学会了🌈功法《${name}》\n本篇仅用于解锁傀儡${info.minRank}～${info.maxRank}阶，不占用当前运转功法位，也不提供额外战斗加成。`)
        } else {
            e.reply(`📖 修炼成功！你学会了功法《${name}》\n使用 #运转功法 ${name} 激活它`)
        }
        return true
    }

    /** #运转功法 <名>: 激活(同时只能运转一本) */
    async gongfaRun(e) {
        const m = String(e.msg || '').replace(/^[#＃]?(运转|装备|激活|使用)功法\s*/, '').trim()
        const id = e.user_id
        if (!m) { e.reply('用法：#运转功法 <功法名>'); return true }
        const name = Object.keys(GONGFA_TPL).find(n => n === m || m.includes(n))
        if (!name) { e.reply(`没有找到功法《${m}》，#功法图鉴 查看全部`); return true }
        if (isPuppetTechnique(name)) {
            e.reply(`《${name}》是傀儡术篇章，学习后直接解锁对应傀儡阶段，无需运转，也不占用当前功法位。`)
            return true
        }
        if (!(await isGongfaLearned(id, name))) { e.reply(`你还没学会《${name}》，先 #修炼功法 ${name}`); return true }
        await setActiveGongfa(id, name)
        e.reply(`⚡ 已运转功法《${name}》！效果生效：\n${fmtGongfaFx(GONGFA_TPL[name].fx)}`)
        return true
    }

    /** #取消功法: 停止运转 */
    async gongfaClear(e) {
        await setActiveGongfa(e.user_id, '')
        e.reply('已停止运转当前功法（当前无功法加成）')
        return true
    }

    /** #卖功法 <名> <数量>: 功法书半价卖回藏宝阁(已扣税) */
    async gongfaSell(e) {
        const m = String(e.msg || '').replace(/^[#＃]?(卖|出售|售卖)功法\s*/, '').trim()
        const id = e.user_id
        const filename = e.group_id + '.json'
        if (!m) { e.reply('用法：#卖功法 <功法名> <数量>，例：#卖功法 鸿运诀'); return true }
        let count = 1
        let name = m
        const nm = m.match(/^(.+?)\s*([0-9]+)$/)
        if (nm) { name = nm[1].trim(); count = Math.max(1, parseInt(nm[2]) || 1) }
        const g = Object.keys(GONGFA_TPL).find(n => n === name || name.includes(n))
        if (!g) { e.reply(`没有找到功法《${name}》`); return true }
        if (isPuppetTechnique(g)) {
            e.reply(`《${g}》是傀儡术篇章，不能卖回；重复功法请使用 #分解傀儡术 ${g}，可得功法残卷。`)
            return true
        }
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items[g]) ? bag.items[g].count : 0
        if (have < count) { e.reply(`背包里只有 ${have} 本《${g}》功法书`); return true }
        const price = gongfaSellPrice(g) * count
        consumeItem(id, g, count, null, e.group_id)
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        const gain = afterTax(price)
        homejson[id].money = (Number(homejson[id].money) || 0) + gain
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        e.reply(`💰 已卖回${itemIcon(g)}《${g}》×${count}，获得 ${gain} 灵石（已扣20%税，上交给${taxSect()}宗门）`)
        return true
    }

    /** 随机事件(逛街冷却在这里,逛集市不冷却) */
    async streetRandom(e) {
        const id = e.user_id
        const filename = e.group_id + `.json`
        const battlejson = await xujing_data.getQQYUserBattle(id, null, false, `${e.group_id}.json`)
        let UserPAF = battlejson[id].Privilege
        let lastTime = await redis.ttl(`xujing:wife-gift-cd:${e.group_id}:${id}`);
        if (lastTime !== -2 && !UserPAF) {
            e.reply([
                segment.at(e.user_id), "\n",
                `随机事件冷却中：${fmtCD(lastTime)}`
            ]);
            return true
        }
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        if (!homejson[id]) homejson[id] = { s: 0, wait: 0, money: 0, love: 0 }
        const housejson = await xujing_data.getQQYUserHouse(id, null, filename, false)
        const giftthing = JSON.parse(fs.readFileSync(giftpath, "utf8"))
        // 随机地点
        const placeid = Math.round(Math.random() * (Object.keys(giftthing.placename).length - 1))
        const placeName = giftthing.placename[placeid]
        let startMsg = (giftthing.start[placeid + 1] || '你们随意逛了逛')
        // 随机事件
        let eventMsg = '你们随便逛了逛，什么也没发生'
        let money = 0, love = 0
        const modle = giftthing[placeName]
        if (modle) {
            const eid = Math.round(Math.random() * (Object.keys(modle).length - 1) + 1)
            const ev = modle[eid]
            if (ev) {
                eventMsg = ev.msg
                money = ev.money || 0
                let loveUp = 1 + bestBonus(housejson, homejson, {}, id, 'loveup')
                /* 功法: 好感加成(双修/好感倍率, 随机事件好感也吃加成) */
                try { const gfx = await getGongfaFx(id); if (gfx && gfx.love) loveUp *= gfx.love } catch (err) { }
                love = Math.round((ev.love || 0) * loveUp)
            }
        }
        // 没有道侣时替换文案,避免出现"你的老婆"
        if (!homejson[id].s) {
            startMsg = startMsg.replace(/你和你的老婆/g, '你独自一人')
            eventMsg = eventMsg.replace(/你的老婆/g, '你自己')
        }
        homejson[id].money += afterTax(money)
        homejson[id].love += love
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        // 随机事件才设置冷却,逛集市(丹阁/器阁/藏宝阁)无冷却
        await redis.set(`xujing:wife-gift-cd:${e.group_id}:${id}`, currentTime, {
            EX: cdTime5
        });
        /* 随机事件结束后离开集市: 释放逛街锁 */
        delete streetState[id]
        await unlock(e.group_id, id, 'street')
        const msgArr = [
            `🌍 你们漫无目的地逛街`,
            `${startMsg}\n${eventMsg}`,
            `灵石 ${money >= 0 ? '+' : ''}${money}，好感 ${love >= 0 ? '+' : ''}${love}\n当前灵石：${homejson[id].money}，好感：${homejson[id].love}\n回复 #逛街 回到集市`
        ]
        Config.getforwardMsg(msgArr, e)
        return true
    }
    //抱抱
    async touch(e) {
        if (await this.is_jinbi(e) == true) return
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var housejson = await xujing_data.getQQYUserHouse(id, housejson, filename, false)
        if (e.atme || e.atall) {
            e.reply(`不可以这样！`)
            return
        }
        if (homejson[id].s == 0) {//如果json中不存在该用户或者老婆s为0
            e.reply(`醒醒,你还在这里没有老婆!!`)
            return
        }
        if (e.at && e.at != homejson[id].s) {
            e.reply(`醒醒,这不是你老婆!!!`)
            return
        }
        var battlejson = await xujing_data.getQQYUserBattle(id, battlejson, false, `${e.group_id}.json`)
        let UserPAF = battlejson[id].Privilege
        let lastTime = await redis.ttl(`xujing:wife-touch-cd:${e.group_id}:${e.user_id}`);
        if (lastTime !== -2 && !UserPAF) {
            e.reply([
                segment.at(e.user_id), "\n",
                `冷却中：${fmtCD(lastTime)}`
            ]);
            return
        }
        await redis.set(`xujing:wife-touch-cd:${e.group_id}:${e.user_id}`, currentTime, {
            EX: cdTime4
        });
        let hugBonus = bestBonus(housejson, homejson, {}, id, 'hug')
        const loveup = bestBonus(housejson, homejson, {}, id, 'loveup')
        let loveGain = Math.round((Math.random() * 30 + 45) * (1 + loveup) * (1 + hugBonus / 100))
        /* 功法: 好感加成(双修/好感倍率) */
        try { const gfx = await getGongfaFx(id); if (gfx && gfx.love) loveGain = Math.round(loveGain * gfx.love) } catch (err) { }
        homejson[id].love += loveGain
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        e.reply(`恭喜你,你老婆对你的好感上升到了${homejson[id].love}!${hugBonus > 0 ? `(房子抱抱加成${hugBonus}%)` : ''}`)
        return true;
    }
    //查看本群所有cp
    async cplist(e) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        let msg = [`群全部cp:`]
        let memberMap = await e.group.getMemberMap();
        let arrMember = Array.from(memberMap.values());
        let idlist = []
        let namelist = []
        for (let i = 0; i < arrMember.length; i++) {
            idlist[i] = arrMember[i].user_id
            namelist[arrMember[i].user_id] = arrMember[i].nickname
            if (arrMember[i].card !== '')
                namelist[arrMember[i].user_id] = arrMember[i].card
        }
        //我这里的做法是，把user_id和nickname格外取出来，因为arrMember里面是按照顺序排列的，不能使用arrMember[id]
        for (let i of Object.keys(homejson)) {
            const myId = Number(i)
            const wifeId = Number(homejson[i].s) || 0
            // 必须有老婆(s有效且非0、非自己),且老婆和本人都必须在群里
            if (wifeId !== 0 && wifeId !== myId && idlist.includes(wifeId) && idlist.includes(myId)) {
                var she_he = await this.people(e, 'sex', myId)
                msg.push([
                    `[${namelist[i]}]`,
                    segment.image(`https://q1.qlogo.cn/g?b=qq&s=0&nk=${myId}`),
                    `和${she_he}的老婆[${namelist[wifeId]}]`,
                    segment.image(`https://q1.qlogo.cn/g?b=qq&s=0&nk=${wifeId}`)
                ])
            }
        }
        // 转发发送
        let forwardMsg = msg
        Config.getforwardMsg(forwardMsg, e)
        return true;
    }
    //500以内可以领取低保
    async poor(e) {
        var id = e.user_id
        var battlejson = await xujing_data.getQQYUserBattle(id, battlejson, false, `${e.group_id}.json`)
        let UserPAF = battlejson[id].Privilege
        let lastTime = await redis.ttl(`xujing:wife-poor-cd:${e.group_id}:${id}`);
        if (lastTime !== -2 && !UserPAF) {
            e.reply([
                segment.at(id), "\n",
                `冷却中：${fmtCD(lastTime)}`
            ]);
            return
        }
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        if (homejson[id].money < 500) {
            /* 修仙世界: 低保按所在大区动态税率扣税(税收计入宗门繁荣度) */
            const world = getWorld(e.group_id)
            const loc = getLoc(world, id)
            const rate = taxFor(world, loc, playerSectName(e.group_id, id))
            const tax = Math.floor(500 * rate / 100)
            const net = 500 - tax
            homejson[id].money += net
            await xujing_data.getQQYUserHome(id, homejson, filename, true)
            addTax(world, loc, tax)
            saveWorld(world)
            const boss = bossOf(world, loc)
            const owner = boss ? `${REGIONS[loc].name}${boss}` : `${REGIONS[loc].name}各占领宗门`
            e.reply(`成功领取500灵石（税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}，到账${net}）`)
            await redis.set(`xujing:wife-poor-cd:${e.group_id}:${id}`, currentTime, {
                EX: cdTime7
            });
            return
        }
        if (homejson[id].money >= 500) {
            e.reply(`这就是有钱人的嘴脸吗`)
        }
        return true
    }
    //转账功能
    async Transfer_money(e) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var housejson = await xujing_data.getQQYUserHouse(id, housejson, filename, false)
        if (homejson[id].s == 0) {
            e.reply([
                segment.at(id), "\n",
                `你暂时在这里没有老婆哦,不用上交了`
            ])
            return
        }
        if (homejson[id].money <= 0) {
            e.reply([
                segment.at(id), "\n",
                `你自己已经很穷了,上交个啥?`
            ])
            return
        }
        var msg = e.msg.replace(/(上交存款|#)/g, "").replace(/[\n|\r]/g, "，").trim()
        var id2 = homejson[id].s
        homejson = await xujing_data.getQQYUserHome(id2, homejson, filename, false)  //给老婆创建存档
        /* 修仙世界: 上交存款属应税行为, 双方须在同一大区, 按所在大区动态税率扣税(税收计入宗门繁荣度) */
        const world = getWorld(e.group_id)
        const myLoc = getLoc(world, id)
        const tgtLoc = getLoc(world, id2)
        if (myLoc !== tgtLoc) {
            e.reply(`你们不在同一大区！你位于【${regionNameOf(myLoc)}】，道侣位于【${regionNameOf(tgtLoc)}】，请先同行再上交~`)
            return true
        }
        const rate = taxFor(world, myLoc, playerSectName(e.group_id, id))
        var yingfu = Math.round(msg)
        var shifu = Math.round(yingfu * 1.1)
        /* 功法: 好感加成(双修/好感倍率, 上交存款增加的好感也吃加成) */
        let gongfaLove = 1
        try { const gfx = await getGongfaFx(id); if (gfx && gfx.love) gongfaLove = gfx.love } catch (err) { }
        e.reply([
            segment.at(id), "\n",
            `您本次应付需要${yingfu}灵石,实付需要${shifu}（税率 ${rate}%）`
        ])
        setTimeout(() => {
            if (homejson[id].money < shifu) {
                e.reply([
                    segment.at(id), "\n",
                    `你的灵石不足,上交失败`
                ])
                return
            }
            else if (homejson[id].money >= shifu) {
                const tax = Math.floor(yingfu * rate / 100)
                const net = yingfu - tax
                e.reply([
                    segment.at(id), "\n",
                    `上交成功\n`,
                    `老婆对你的好感上升了${Math.round(yingfu / 10)}`,
                ])
                homejson[id].money -= shifu
                homejson[id2].money += net
                homejson[id].love += Math.round((yingfu / 10) * (1 + bestBonus(housejson, homejson, {}, id, 'loveup')) * gongfaLove)
                xujing_data.getQQYUserHome(id, homejson, filename, true)
                xujing_data.getQQYUserHome(id2, homejson, filename, true)
                addTax(world, myLoc, tax)
                saveWorld(world)
            }
        }, 1500)
        return true;
    }
    //清除所有人的本插件redis数据或者指定某个人的
    async delREDIS(e) {
        if (e.isMaster) {
            let cddata = await redis.keys(`xujing:*:${e.group_id}:*`, (err, data) => { });
            if (e.at) {
                cddata = await redis.keys(`xujing:*:${e.group_id}:${e.at}`, (err, data) => { });
                /* 修炼/突破冷却 key 是 duel:* 前缀(不带群号),单独按用户清 */
                let dueldata = await redis.keys(`duel:*:${e.at}`, (err, data) => { });
                cddata = cddata.concat(dueldata);
                e.reply(`成功重置${e.at}的时间`)
            }
            else {
                /* 清除本群所有 xujing:* 冷却 + 全部 duel:* 冷却 */
                let dueldata = await redis.keys(`duel:*:*`, (err, data) => { });
                cddata = cddata.concat(dueldata);
                e.reply(`成功清除本群所有人的的时间`)
            }
            await redis.del(cddata);
            return true;
        }
    }
    //下面的都是函数,调用时需使用awiat等待以免异步执行---------------------------------------------------------//
    //看看你是哪些人的老婆函数
    async is_wife(e, id) {
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        let wifelist = []//看看这个Id是哪些人的老婆
        for (let i of Object.keys(homejson)) {//读取json里面的对象名
            if (homejson[i].s == id)//如果有人的老婆是是这个id
                wifelist.push(i)
        }
        return wifelist
    }
    //群成员资料函数
    async people(e, keys, id) {
        let memberMap = await e.group.getMemberMap();
        let arrMember = Array.from(memberMap.values());
        var this_one = arrMember.filter(item => {
            return item.user_id == id
            //用过滤器返回了user_id==id的人
        })
        var lp = this_one[0]
        if (!lp) {//成员不在群里(可能已退群),返回默认值避免报错
            if (keys == 'sex') return '他'
            if (keys == 'nickname') return String(id)
            return ''
        }
        if (keys == 'sex') {
            var she_he = '她'
            if (lp.sex == 'male')
                she_he = '他'
            return she_he
        }
        if (keys == 'nickname') {
            var name = lp.nickname
            if (lp.card !== '')
                name = lp.card
            return name
        }

    }
    //看看你是不是在关禁闭
    async is_jinbi(e) {
        let jinbi = await redis.ttl(`xujing:wife-jinbi-cd:${e.group_id}:${e.user_id}`);
        if (jinbi !== -2) {
            e.reply([
                segment.at(e.user_id), "\n",
                `你已经被关进禁闭室了!!!时间到了自然放你出来\n你还需要被关${fmtCD(jinbi)}`
            ])
            return true
        }
        return false
    }
    /** #设置老婆 [序号]: 无参显示后宫(老婆+小妾带序号), 有参把小妾扶正为老婆(原老婆降为小妾) */
    async setWife(e) {
        if (!e.group_id) { e.reply('请在群内使用~'); return true }
        const id = e.user_id
        const gid = String(e.group_id)
        const filename = e.group_id + `.json`
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        const inpajson = await xujing_data.getQQYUserxiaoqie(id, null, filename, false)
        const xq = (inpajson[id] && Array.isArray(inpajson[id].shuangxiu)) ? inpajson[id].shuangxiu : []
        const wife = Number(homejson[id].s) || 0
        /* 序号(支持全角数字) */
        const m = String(e.msg || '').match(/(设置老婆|扶正)\s*([0-9０-９]*)/)
        const no = (m && m[2]) ? parseInt(String(m[2]).replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)), 10) : 0
        /* 无参: 显示后宫列表 */
        if (!no) {
            const lines = [`💍 我的后宫`]
            lines.push(`👰 老婆：${(wife && wife !== Number(id)) ? (await getNick(gid, wife)) : '无'}`)
            if (!xq.length) {
                lines.push(`💃 小妾：（无）`)
            } else {
                for (let i = 0; i < xq.length; i++) lines.push(`💃 小妾${i + 1}：${await getNick(gid, xq[i])}`)
            }
            lines.push('', '回复 #设置老婆 序号，把小妾扶正为老婆（原老婆降为小妾）')
            e.reply(lines.join('\n'))
            return true
        }
        /* 有参: 扶正小妾 */
        if (!xq.length) { e.reply('你还没有小妾，无法设置~'); return true }
        const idx = no - 1
        if (idx < 0 || idx >= xq.length) { e.reply(`序号不存在，你只有 ${xq.length} 名小妾~`); return true }
        const selected = xq[idx]
        const oldWife = Number(homejson[id].s) || 0
        /* 没有老婆: 直接扶正 */
        if (!oldWife || oldWife === Number(id)) {
            inpajson[id].shuangxiu = xq.filter((x, i) => i !== idx)
            homejson[id].s = selected
            homejson[id].love = Math.round(Math.random() * 30 + 10)
            await xujing_data.getQQYUserHome(id, homejson, filename, true)
            await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
            const wname = await getNick(gid, selected)
            e.reply([segment.at(id), `\n💍 ${wname} 已成为你的老婆！`])
            return true
        }
        /* 有老婆: 交换(原老婆放回被选中小妾的位置, 其他小妾顺序不变) */
        const rest = xq.filter((x, i) => i !== idx).filter(x => String(x) !== String(oldWife))
        rest.splice(idx, 0, String(oldWife))
        inpajson[id].shuangxiu = rest
        homejson[id].s = selected
        homejson[id].love = Math.round(Math.random() * 30 + 10)
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
        const wname = await getNick(gid, selected)
        const oname = await getNick(gid, oldWife)
        e.reply([segment.at(id), `\n💍 ${wname} 已扶正为老婆！\n${oname} 降为小妾~`])
        return true
    }
    /** 老婆没了时,从小妾里按先来后到(数组顺序)补一位当老婆; 返回新老婆QQ或null */
    async promoteWife(id, homejson, inpajson, filename) {
        const xq = (inpajson[id] && Array.isArray(inpajson[id].shuangxiu)) ? inpajson[id].shuangxiu : []
        if (!xq.length) return null
        const newWife = xq.shift()
        homejson[id].s = newWife
        homejson[id].love = 0
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, true)
        return newWife
    }
    //判断好感度是否双方都小于等于0,是则拆散,单向老婆则只失去老婆
    async is_fw(e, homejson) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var homejson = await xujing_data.getQQYUserHome(id, homejson, filename, false)
        var inpajson = await xujing_data.getQQYUserxiaoqie(id, inpajson, filename, false)
        /*let id2 = homejson[id].s
        if(homejson[id2].s == id && (homejson[id2].love <= 0||homejson[id].love <= 0)){
            e.reply(`很遗憾,由于你们有一方对对方的好感太低,你们的感情走到了尽头`)
            homejson[id].love = 0
            homejson[id].s = 0
            homejson[id2].love = 0
            homejson[id2].s = 0
                return true;
        }
        */
        if (homejson[id].love <= 0) {
            homejson[id].love = 0
            homejson[id].s = 0
            const newWife = await this.promoteWife(id, homejson, inpajson, filename)
            if (newWife) {
                const wname = await this.people(e, 'nickname', newWife)
                e.reply(`很遗憾,你老婆甩了你,已从小妾中按先来后到补位,${wname}成为你的新老婆~`)
            } else {
                await xujing_data.getQQYUserHome(id, homejson, filename, true)
                e.reply(`很遗憾,由于你老婆对你的好感太低,你老婆甩了你`)
            }
            return true;
        }
        return false;
    }
    //判断行为次数是否上限
    async is_MAXEX(e, keys) {
        var id = e.user_id
        var filename = e.group_id + `.json`
        var placejson = await xujing_data.getQQYUserPlace(id, placejson, filename, false)
        if (placejson[e.user_id].placetime >= gifttime && keys == 'gift') {
            e.reply(`单次逛街行动上限,你回了家`)
            placejson[id].place = "home"
            placejson[id].placetime = 0
            await xujing_data.getQQYUserPlace(id, placejson, filename, true)
            return true
        }
        else return false;
    }
    //抢老婆决斗(五局三胜+合并转发,与御前决斗同一套战斗系统)
    async duel(e) {
        console.log("用户命令：", e.msg);
        let user_id = e.user_id;
        let user_id2 = e.at; //获取当前at的那个人
        var battlejson = await xujing_data.getQQYUserBattle(user_id, null, false, `${e.group_id}.json`)
        var battlejson = await xujing_data.getQQYUserBattle(user_id2, battlejson, false, `${e.group_id}.json`)
        let level = Number(battlejson[user_id].level) || 0
        let level2 = Number(battlejson[user_id2].level) || 0
        let user_id2_nickname = null
        for (let msg of e.message) { //赋值给user_id2_nickname
            if (msg.type === 'at') {
                user_id2_nickname = msg.text//获取at的那个人的昵称
                break;
            }
        }
        //五局三胜:单局胜率与御前决斗一致
        const myNick = (e.sender && (e.sender.card || e.sender.nickname)) || '你'
        if (!user_id2_nickname) user_id2_nickname = '对方'
        //攻击/防御/生命/暴击/爆伤增益
        const myBuffs = await getBuffs(user_id, e.group_id)
        const oppBuffs = await getBuffs(user_id2, e.group_id)
        const { win, myEquip, oppEquip } = fightWinRate(level, level2, user_id, user_id2, Magnification, myBuffs, oppBuffs, e.group_id)
        const myDmg = makeDamageFn(level, user_id, 0.15, myBuffs, e.group_id)
        const oppDmg = makeDamageFn(level2, user_id2, 0.15, oppBuffs, e.group_id)
        //一律五局三胜,管理员不加成(一视同仁,照常抢老婆)
        const result = fightBestOf5(win, { dmgMe: myDmg, dmgOpp: oppDmg, defMe: myBuffs.def })
        const wearReceipt = taichuBattleReceipt(e, 'marriage-duel')
        wearPlayerTaichu(e.group_id, user_id, wearReceipt)
        wearPlayerTaichu(e.group_id, user_id2, wearReceipt)
        const extra = '胜者将获得抢夺资格！'
        //构建战斗合并转发记录
        const msgs = buildFightRecord({
            myName: myNick,
            oppName: user_id2_nickname,
            myId: user_id,
            oppId: user_id2,
            myLevel: battlejson[user_id].levelname || '无灵力',
            oppLevel: battlejson[user_id2].levelname || '无灵力',
            myEquip,
            oppEquip,
            win,
            result,
            extra
        })
        await BotApi.User.battleForward({ e, msgs })
        return result.winner === 'me'
    }
    // 删除错误存档: 先确认成员快照，再按存档 schema 精确清理
    async delerrdata(e) {
        const gid = String(e && e.group_id || '')
        if (!/^\d+$/.test(gid) || !e || !e.group) {
            e?.reply?.('❌ 只能在有效群聊中执行清理，未执行任何删除。')
            return true
        }
        const snapshot = await getGroupMemberSnapshot(e.group)
        if (!snapshot.ok) {
            const reason = snapshot.error && snapshot.error.message ? `（${snapshot.error.message}）` : ''
            globalThis.logger?.warn?.(`[虚境存档清理] 群${gid}成员快照不可用${reason}`)
            e.reply(`❌ 无法确认本群成员列表${reason}，为防止误删，本次未执行任何清理。`)
            return true
        }
        let blacklisted = []
        try {
            blacklisted = await xujing_data.getBlacklist()
        } catch (err) {
            globalThis.logger?.warn?.(`[虚境存档清理] 群${gid}读取黑名单失败: ${err && err.message}`)
        }
        try {
            const report = await cleanupGroupSave({
                gid,
                memberIds: snapshot.ids,
                blacklistIds: blacklisted,
                redis: global.redis
            })
            const failed = report.errors.length
            const extra = [
                report.fake.removed + report.fake.referencesCleared > 0 ? `宗门/伪玩家引用${report.fake.removed + report.fake.referencesCleared}条` : '',
                report.bags > 0 ? `背包${report.bags}个` : '',
                report.redis > 0 ? `临时状态${report.redis}项` : '',
                failed > 0 ? `⚠️ ${failed}项失败（未覆盖原文件）` : ''
            ].filter(Boolean)
            e.reply(`清除本群无效/错误存档${failed ? '部分完成' : '成功'},\n本次共清除无效存档${report.home.removed}个(退群+拉黑),\n删除错误的老婆${report.home.referencesCleared}位,\n清理其他存档数据${report.other.removed + report.other.referencesCleared}条,\n${extra.length ? extra.join('，') : '未发现其它失效记录'}。`)
            if (failed) globalThis.logger?.warn?.(`[虚境存档清理] 群${gid}完成但有${failed}项失败: ${report.errors.join(' | ')}`)
            else globalThis.logger?.mark?.(`[虚境存档清理] 群${gid}完成: ${JSON.stringify(report)}`)
        } catch (err) {
            globalThis.logger?.error?.(`[虚境存档清理] 群${gid}失败: ${err && err.stack}`)
            e.reply('❌ 清理存档失败，未完成的存档保持原样，请稍后重试。')
        }
        return true
    }
    //超员清理(共享逻辑): 无房子自动补小破屋, 超过房子容量的删除多余小妾(保留老婆/去重), 返回删除总数
    async pruneOverCapacity(e) {
        const filename = e.group_id + `.json`
        const homejson = await xujing_data.getQQYUserHome(e.user_id, null, filename, false)
        const inpajson = await xujing_data.getQQYUserxiaoqie(e.user_id, null, filename, false)
        const housejson = await xujing_data.getQQYUserHouse(e.user_id, null, filename, false)
        const { removed, houseChanged } = cleanOverCapacity(homejson, housejson, inpajson)
        if (removed > 0) {
            await xujing_data.getQQYUserxiaoqie(e.user_id, inpajson, filename, true)
        }
        if (houseChanged) {
            await xujing_data.getQQYUserHouse(e.user_id, housejson, filename, true)
        }
        return removed
    }
    /** 统一容量检查: 该用户房子是否还能增加 1 位成员(老婆/小妾), 返回 { ok, cap, cur } */
    async canAddResident(e, uid) {
        const filename = e.group_id + `.json`
        const homejson = await xujing_data.getQQYUserHome(uid, null, filename, false)
        const inpajson = await xujing_data.getQQYUserxiaoqie(uid, null, filename, false)
        const housejson = await xujing_data.getQQYUserHouse(uid, null, filename, false)
        return checkRoom(homejson, inpajson, housejson, uid)
    }
    /**
     * 统一加入成员(调用方需先 canAddResident 检查): 有老婆→纳妾 / 无老婆→娶妻
     * @returns {'concubine'|'wife'} 加入类型
     */
    async applyMarry(homejson, inpajson, id, partner, loveMax = 40) {
        const hasWife = !!homejson[id].s && Number(homejson[id].s) !== 0
        if (hasWife) {
            inpajson[id].shuangxiu.push(partner)
            return 'concubine'
        }
        homejson[id].s = partner
        homejson[id].love = Math.round(Math.random() * (loveMax - 10) + 10)
        return 'wife'
    }
}