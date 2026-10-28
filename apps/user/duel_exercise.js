import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import fs from "fs";
import cfg from '../../../../lib/config/config.js'
import moment from "moment"
import command from '../../components/command.js'
import { Plugin_Name, Save_Path } from '../../components/plugin.js'
import xujing_data from '../../components/xujing_data.js'
import Config from '../../model/Config.js'
import { getBag, consumeItem, addItem, ITEM_PRICE, getGongfaFx, itemIcon } from '../../components/equip_data.js'
import { buyStock, restockIn, shopSaleTax, recordActive } from '../../components/shop_data.js'
import { logPlayerTrade, logPlayerEvent, playerTitle, getNick, playerSectName } from '../../components/fake_data.js'
import { getWorld, getLoc, regionNameOf } from '../../components/world_data.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { getFacilityLevel } from '../../components/sect_system.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { REALM_MAX_LEVEL, XIANDI_MAX_CHONG } from '../../components/realm_cap.js'

/** 冷却时间格式化(精确到秒,如 4分10秒) */
const fmtCD = (sec) => {
    sec = Math.max(0, Math.ceil(Number(sec) || 0))
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return m > 0 ? `${m}分${s}秒` : `${s}秒`
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
const currentTime = moment(new Date()).format('YYYY-MM-DD HH:mm:ss')
//项目路径
const dirpath = `${Save_Path}/`;//文件夹路径(Yunzai本体data目录)
var filename = `battle`;//文件名
if (filename.indexOf(".json") == -1) {//如果文件名不包含.json
    filename = filename + ".json";//添加.json
}
let Template = {//创建该用户
    "experience": 0,
    "accum": 0,
    "level": 0,
    "levelname": '无灵力',
    "Privilege": 0,
};

// 冷却从配置读取(config/xujing.config.yaml duel_cfg, 单位分钟), 默认与旧硬编码一致: 修炼/突破均30分钟
let cdtime_exercise = Number(await command.getConfig("duel_cfg", "cdtime_exercise") || 30) * 60 //修炼冷却(分钟→秒)
let cdtime_break = Number(await command.getConfig("duel_cfg", "cdtime_break") || 30) * 60//突破冷却(分钟→秒)

/* 境界体系 */
const REALMS = ['炼气期', '筑基期', '金丹期', '元婴期', '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '人仙', '天仙', '金仙', '大罗金仙', '九天玄仙', '罗天上仙', '仙君', '仙帝']
const STAGES = ['初期', '中期', '后期', '巅峰']
const STAGE_COUNT = 4//每个大境界的子境界数
const REALM_COUNT = REALMS.length
const MAX_LEVEL = REALM_COUNT * STAGE_COUNT//最后一个大境界的巅峰级数(68)
/* 仙帝之后每重所需经验(随仙帝巅峰按比例上调, 保持后期难度) */
const IMMORTAL_STEP = 5000
/* 吃破障丹后固定突破成功率(%) */
const PILL_RATE = 90
/** 大境界n(1开始)的巅峰累计灵力; 化神期(n>=5)起每重所需灵力翻倍(元婴巅峰2000 + 2×原跨度);
 *  成仙(人仙 n=10)起: 人仙巅峰12万(原4万翻3倍), 之后每大境界需求×1.5(境界越高需要越多),
 *  仙帝(n=17)巅峰约205万 */
const getRealmPeak = (n) => {
    const base = 100 * n * (n + 1)
    if (n < 5) return base//炼气~元婴 原公式
    if (n < 10) return 2000 + (base - 2000) * 2//化神~渡劫 翻倍跨度
    /* 成仙(人仙)起: 指数增长, 每大境界×1.5 */
    return Math.round(120000 * Math.pow(1.5, n - 10))
}
/** 基础突破成功率：初始25%，每突破一个大境界-1%，最低5% */
const getBreakRate = (level) => {
    const realmIndex = Math.min(REALM_COUNT - 1, Math.max(0, Math.floor((level - 1) / STAGE_COUNT)))
    return Math.max(5, 20 - realmIndex)
}
/** 执行突破(支持连破N重: 前 pills 重用破障丹成功率90%, 其余基础成功率, 失败即停) */
const doBreakN = async (e, json, user_id, levels, pills) => {
    json[user_id].level = Number(json[user_id].level) || 0
    /* 境界硬上限: 仙帝第499重, 到顶后不再突破 */
    if (json[user_id].level >= REALM_MAX_LEVEL) {
        e.reply([segment.at(user_id), `\n🚫 你已修至仙帝第${XIANDI_MAX_CHONG}重，此界境界上限已满，无法再突破。`])
        return true
    }
    /* 渡劫飞升: 本次突破将进入人仙(level 37)需消耗1枚登仙令; 无则提示且不进冷却 */
    const willAscend = json[user_id].level < 37 && json[user_id].level + levels >= 37
    if (willAscend) {
        const bag = getBag(user_id, e.group_id)
        const have = (bag.items && bag.items['登仙令']) ? bag.items['登仙令'].count : 0
        if (have < 1) {
            e.reply([segment.at(user_id), `\n🌠 渡劫飞升需消耗 1 枚 ${itemIcon('登仙令')}【登仙令】！`])
            return true
        }
    }
    /* 真正执行突破时才进入冷却 */
    redis.set(`duel:break-cd:${user_id}`, currentTime, { EX: cdtime_break }).catch(() => { })
    if (json[user_id].experience < 1) {
        json[user_id].experience = 0
    }
    /* 累积灵力并入主灵力 */
    json[user_id].accum = Number(json[user_id].accum) || 0
    let mergedAccum = 0
    if (json[user_id].accum > 0) {
        mergedAccum = json[user_id].accum
        json[user_id].experience += json[user_id].accum
        json[user_id].accum = 0
    }
    /* 功法: 突破成功率加成(破晓诀+8% / 鸾音真诀+8% / 太阴月华诀+10%) */
    let breakBonus = 0
    try { const gfx = await getGongfaFx(user_id); if (gfx && gfx.break) breakBonus = gfx.break } catch (err) { }
    /* 宗门演武场: 突破成功率 +2%/级 */
    let sectBreakBonus = 0
    try { sectBreakBonus = getFacilityLevel(e.group_id, user_id, 'yanwu') * 2 } catch (err) { }
    /* 逐级判定: 前 pills 重用90%, 其余基础成功率, 失败即停 */
    let broke = 0
    for (let i = 0; i < levels; i++) {
        if (json[user_id].level >= REALM_MAX_LEVEL) break
        const rate = Math.min(100, (i < pills ? PILL_RATE : getBreakRate(json[user_id].level)) + breakBonus + sectBreakBonus)
        if (Math.random() * 100 > rate) break
        /* 渡劫飞升: 突破成功进入人仙时消耗1枚登仙令 */
        if (json[user_id].level === 36) consumeItem(user_id, '登仙令', 1, null, e.group_id)
        json[user_id].level++
        broke++
    }
    json[user_id].levelname = getLevelName(json[user_id].level)
    await xujing_data.getQQYUserBattle(user_id, json, true, `${e.group_id}.json`)
    /* 突破里程碑写入天下大事: 进入大乘期及以上的大境界(渡劫/飞升等) */
    if (broke > 0) {
      const newLv = json[user_id].level
      const newRealm = Math.floor((newLv - 1) / STAGE_COUNT)
      const oldRealm = Math.floor((newLv - broke - 1) / STAGE_COUNT)
      if (newRealm > oldRealm && newRealm >= 7) {
        try {
          const nick = await getNick(e.group_id, user_id)
          logPlayerEvent(e.group_id, `【突破】散修 ${nick} 突破至${getLevelName(newLv)}，修为惊天动地！`)
        } catch (err) { }
      }
    }
    if (broke <= 0) {
        e.reply([segment.at(user_id), `\n💔 突破失败，请努力修行（当前境界：${json[user_id].levelname}）`])
    } else {
        e.reply([segment.at(user_id),
            `\n🎉 突破成功！${levels > 1 ? `连破 ${broke} 重` : '境界提升'}，当前境界：${json[user_id].levelname}${mergedAccum > 0 ? `\n累积灵力+${mergedAccum}已并入` : ''}`])
    }
    return true
}
/** 突破到 level 级所需的累计灵力 */
export const getSubThreshold = (level) => {
    if (level <= 0) return 0
    if (level > MAX_LEVEL) return getRealmPeak(REALM_COUNT) + (level - MAX_LEVEL) * IMMORTAL_STEP
    const i = Math.floor((level - 1) / STAGE_COUNT)//大境界索引 0-16
    const step = (level - 1) % STAGE_COUNT + 1//子境界步进 1-4：初期/中期/后期/巅峰
    const prev = i === 0 ? 0 : getRealmPeak(i)
    const peak = getRealmPeak(i + 1)
    return Math.round(prev + (peak - prev) * step / STAGE_COUNT)
}
/** 根据等级获取境界名 */
export const getLevelName = (level) => {
    level = Math.max(0, Math.floor(Number(level) || 0))
    if (level <= 0) return '无灵力'
    if (level > REALM_MAX_LEVEL) level = REALM_MAX_LEVEL
    if (level > MAX_LEVEL) return `仙帝第${level - MAX_LEVEL}重`
    const i = Math.floor((level - 1) / STAGE_COUNT)
    const j = (level - 1) % STAGE_COUNT
    return REALMS[i] + STAGES[j]
}
/** 灵气累积池上限: 当前境界灵力阈值的 5%(原固定200; 境界越高池子越大) */
export const accumMax = (level) => Math.max(1, Math.round(getSubThreshold(Math.max(1, Number(level) || 1)) * 0.05))
export class duel_exercise extends plugin {//修炼
    constructor() {
        super({
            /** 功能名称 */
            name: '修炼',
            /** 功能描述 */
            dsc: '',
            event: 'message',
            /** 优先级，数字越小等级越高 */
            priority: 1000,
            rule: [
                {
                    /** 命令正则匹配 */
                    reg: "^[#＃]?(一键服用增益丹|一键增益|一键吃增益丹)$", //一键服用所有增益丹(各1颗, 1小时buff)
                    /** 执行方法 */
                    fnc: 'oneClickPill'
                },
                {
                    /** 命令正则匹配 */
                    reg: "^[#＃]?(吃什么丹药|服用什么丹药|使用什么丹药|吃丹药|服用丹药|使用丹药|服丹药|用丹药|吃\\s*[^#＃\\s]+丹|服\\s*[^#＃\\s]+丹|用\\s*[^#＃\\s]+丹|服用\\s*[^#＃\\s]+丹|使用\\s*[^#＃\\s]+丹).*$", //丹药统一入口(可指定丹药名/带空格),多种说法防呆
                    /** 执行方法 */
                    fnc: 'takePill'
                },
                {
                    /** 命令正则匹配 */
                    reg: "^#(发起|开始)?(晨练|早|锻炼|早睡|睡觉|修炼(?!玩法|说明|攻略))(?!玩法|说明|攻略)(.*)$", //匹配消息正则，命令正则(排除#修炼玩法等说明)  
                    /** 执行方法 */
                    fnc: 'exercise'
                },
                {
                    /** 命令正则匹配 */
                    reg: "^[#＃]?突破.*$", //渡劫
                    /** 执行方法 */
                    fnc: 'break'
                },
                {
                    /** 命令正则匹配 */
                    reg: "^#跳过$", //匹配消息正则，命令正则
                    /** 执行方法 */
                    fnc: 'skipBreak'
                },
                {
                    /** 命令正则匹配 */
                    reg: "^[#＃]?[0-9]+$", //渡劫确认后回复数字选择: 1=吃丹药 2=直接突破
                    /** 执行方法 */
                    fnc: 'breakChoose'
                },
                {
                    /** 命令正则匹配 */
                    reg: "^#(决斗|修仙)境界列表$", //匹配消息正则，命令正则
                    /** 执行方法 */
                    fnc: 'list'
                }
            ]
        })
    }
    /**
     * 
     */
    async list(e) {
        // 信息类: 渲染成图片展示(避免刷屏), 渲染失败回退合并转发
        const msgArr = []
        for (let i = 0; i < REALM_COUNT; i++) {
            msgArr.push(`${REALMS[i]}（${STAGES.join('、')}）`)
        }
        msgArr.push(`仙帝之后：仙帝第N重（上限第${XIANDI_MAX_CHONG}重）`)
        const img = await textToImg(msgArr.join('\n'))
        if (img) e.reply(img)
        else Config.getforwardMsg(msgArr, e)
        return true
    }
    /**
     * 
     */
    async break(e) {
        console.log("用户命令：", e.msg);
        let user_id = e.user_id;
        /* #突破1(吃破障丹) / #突破2(直接突破): 解析消息里的参数, 命中则跳过序号选择 */
        const dm = String(e.msg).match(/突破\s*([12])\s*$/)
        const direct = dm ? Number(dm[1]) : 0
        const json = await xujing_data.getQQYUserBattle(user_id, null, false, `${e.group_id}.json`)

        /* 境界硬上限: 仙帝第499重(先于冷却判断, 到顶后直接提示) */
        if ((Number(json[user_id].level) || 0) >= REALM_MAX_LEVEL) {
            e.reply([segment.at(user_id), `\n🚫 你已修至仙帝第${XIANDI_MAX_CHONG}重，此界境界上限已满，无法再突破。`])
            return true
        }

        let lastTime_break = await redis.ttl(`duel:break-cd:${e.user_id}`);
        if (lastTime_break !== -2) {//&& !masterList.includes(e.user_id)
            let tips = [
                segment.at(e.user_id), "\n",
                `你刚刚进行了一次突破!(*/ω＼*)`, "\n",
                `冷却中：${fmtCD(lastTime_break)}`
            ]
            e.reply(tips);
            return
        }
        /* 计算突破下一级所需的累计灵力 */
        const need = getSubThreshold(json[user_id].level + 1)
        if (json[user_id].experience < need) {
            e.reply(`修为不足,还差${need - json[user_id].experience}点灵力,请再接再厉`)
            return
        }
        /* 渡劫飞升: 下一级为人仙(level 37)需消耗登仙令; 背包无令则提示并拦截 */
        if (json[user_id].level === 36) {
            const bag = getBag(user_id, e.group_id)
            const ling = (bag.items && bag.items['登仙令']) ? bag.items['登仙令'].count : 0
            if (ling < 1) {
                e.reply([segment.at(user_id), `\n🌠 渡劫飞升需消耗 1 枚 ${itemIcon('登仙令')}【登仙令】！`])
                return true
            }
        }
        /* 交互压栈: 压到栈顶(优先回复), 不终止下层交互 */
        await forceLock(e.group_id, e.user_id, 'break')
        /* 记录待突破状态，等待回复 1/2 或 #吃丹药/#跳过(冷却在真正执行突破时才生效,钱不够不会白白冷却) */
        await redis.set(`duel:break-pending:${e.user_id}`, '1', { EX: 120 })
        /* #突破1 / #突破2: 直接执行, 无需再回复序号 */
        if (direct === 1) return await this.pillBreak(e)
        if (direct === 2) return await this.skipBreak(e)
        /* 显示突破确认面板(复用 breakPanelText) */
        e.reply(await this.breakPanelText(e, json, user_id))
        return
    }

    /** 突破确认面板(回复1吃破障丹/回复2直接突破; 灵石不足时也会退回此面板; 显示功法突破加成) */
    async breakPanelText(e, json, user_id) {
        const baseRate = getBreakRate(json[user_id].level)
        /* 功法: 突破成功率加成(破晓诀+8% / 鸾音真诀+8% / 太阴月华诀+10%) */
        let breakBonus = 0
        try { const gfx = await getGongfaFx(user_id); if (gfx && gfx.break) breakBonus = gfx.break } catch (err) { }
        const targetName = getLevelName(json[user_id].level + 1)
        const bag = getBag(user_id, e.group_id)
        const pillCount = (bag.items && bag.items['破障丹']) ? bag.items['破障丹'].count : 0
        const lingCount = (bag.items && bag.items['登仙令']) ? bag.items['登仙令'].count : 0
        return [
            segment.at(user_id), "\n",
            `⚔️ 突破确认`, "\n",
            `当前境界：${json[user_id].levelname}`, "\n",
            `目标境界：${targetName}`, "\n",
            `基础成功率：${baseRate}%${breakBonus > 0 ? `（功法加成+${breakBonus}%）` : ''}（每突破一大境界-1%）`, "\n",
            `服用${itemIcon('破障丹')}破障丹成功率：${PILL_RATE}%${breakBonus > 0 ? `（功法加成+${breakBonus}%）` : ''}`, "\n",
            `你的${itemIcon('破障丹')}破障丹：${pillCount}颗`, "\n",
            ...(json[user_id].level === 36 ? [`渡劫飞升需消耗${itemIcon('登仙令')}登仙令：${lingCount}枚`, "\n"] : []),
            `回复【1】服用${itemIcon('破障丹')}破障丹提升成功率（或直接发 #突破1）`, "\n",
            `回复【2】直接尝试突破（或直接发 #突破2）`
        ]
    }
    /** 吃丹药突破(破障丹,成功率提升至90%; 背包无丹自动购买,灵石不足退回1/2面板) */
    async pillBreak(e) {
        let user_id = e.user_id
        const pending = await redis.get(`duel:break-pending:${e.user_id}`)
        if (!pending) {
            e.reply(`请先发送 #突破 开启突破哦（也可直接 #服用${itemIcon('破障丹')}破障丹）`)
            return
        }
        /* 栈顶守卫: 渡劫被其它交互埋住时, 不允许直接吃丹触发被埋的突破(须先完成当前交互或重发 #突破) */
        if (!(await isCurrent(e.group_id, e.user_id, 'break'))) {
            e.reply(`你正在进行其他操作，请先完成后（或发送 #突破 重新开始）再突破哦~`)
            return
        }
        const json = await xujing_data.getQQYUserBattle(user_id, null, false, `${e.group_id}.json`)
        /* 从背包扣1颗破障丹; 背包没有则自动购买(丹阁价,需有库存), 灵石不足/售罄退回1/2面板 */
        let bought = ''
        if (!consumeItem(user_id, '破障丹', 1, null, e.group_id)) {
            const filename = `${e.group_id}.json`
            const homejson = await xujing_data.getQQYUserHome(user_id, null, filename, false)
            const price = ITEM_PRICE['破障丹'] || 1000
            const money = (homejson[user_id] && Number(homejson[user_id].money)) || 0
            const panelText = (await this.breakPanelText(e, json, user_id)).filter(x => typeof x === 'string').join('')
            if (money < price) {
                /* 灵石不足: 保留突破状态, 退回 1/2 选择面板(合并为单条消息,避免刷屏) */
                e.reply([segment.at(user_id), `\n💰 灵石不足（购买${itemIcon('破障丹')}破障丹需${price}灵石，你只有${money}灵石）\n${panelText}`])
                return true
            }
            /* 自动购买并服用(按玩家所在大区扣丹阁库存,售罄则等补货) */
            const rg = getLoc(getWorld(e.group_id), user_id)
            const res = await buyStock(e.group_id, 'dange', '破障丹', 1, rg)
            if (!res.ok) {
                const inStr = await restockIn(e.group_id, 'dange', rg)
                if (res.soldout) e.reply([segment.at(user_id), `\n🈳 （${regionNameOf(rg)}）丹阁的${itemIcon('破障丹')}破障丹已售罄！约 ${inStr} 补货，到时再来突破吧~\n${panelText}`])
                else e.reply([segment.at(user_id), `\n❌ 购买${itemIcon('破障丹')}破障丹失败，请稍后再试~\n${panelText}`])
                return true
            }
            homejson[user_id].money = money - price
            await xujing_data.getQQYUserHome(user_id, homejson, filename, true)
            addItem(user_id, '破障丹', 1, null, e.group_id)
            consumeItem(user_id, '破障丹', 1, null, e.group_id)
            const stax = shopSaleTax(e.group_id, rg, price, playerSectName(e.group_id, user_id))
            recordActive(e.group_id, user_id, rg)
            logPlayerTrade(e.group_id, `【丹阁·${regionNameOf(rg)}】${playerTitle(e.group_id, user_id, e.nickname)} 自动购得 ${itemIcon('破障丹')}破障丹 ×1（-${price}灵石，税率${stax.rate}%扣税${stax.tax}，上交${stax.owner}）`)
            bought = `（背包无${itemIcon('破障丹')}破障丹，已自动购买消耗${price}灵石，税率 ${stax.rate}% 扣税 ${stax.tax} 灵石，上交${stax.owner}）`
        }
        await redis.del(`duel:break-pending:${e.user_id}`)
        await unlock(e.group_id, e.user_id, 'break')
        e.reply([segment.at(user_id), `\n💊 服用${itemIcon('破障丹')}破障丹成功${bought}，突破成功率提升至${PILL_RATE}%！`])
        /* 渡劫过程延迟3秒再出结果 */
        setTimeout(() => {
            doBreakN(e, json, user_id, 1, 1)
        }, 3000)
        return true
    }

    /** 跳过丹药直接突破(基础成功率) */
    async skipBreak(e) {
        let user_id = e.user_id
        const pending = await redis.get(`duel:break-pending:${e.user_id}`)
        if (!pending) {
            e.reply('请先发送 #突破 开启突破哦')
            return
        }
        /* 栈顶守卫: 渡劫被其它交互埋住时, 不允许直接跳过触发被埋的突破 */
        if (!(await isCurrent(e.group_id, e.user_id, 'break'))) {
            e.reply(`你正在进行其他操作，请先完成后（或发送 #突破 重新开始）再突破哦~`)
            return
        }
        await redis.del(`duel:break-pending:${e.user_id}`)
        await unlock(e.group_id, e.user_id, 'break')
        const json = await xujing_data.getQQYUserBattle(user_id, null, false, `${e.group_id}.json`)
        const rate = getBreakRate(json[user_id].level)
        e.reply(`开始突破，基础成功率${rate}%`)
        /* 渡劫过程延迟3秒再出结果 */
        setTimeout(() => {
            doBreakN(e, json, user_id, 1, 0)
        }, 3000)
        return true
    }

    /** 渡劫选择: 回复 1=吃破障丹 2=直接突破(无待突破则放行给其他数字指令,避免冲突) */
    async breakChoose(e) {
        const pending = await redis.get(`duel:break-pending:${e.user_id}`)
        if (!pending) {
            /* 待突破标志已过期/丢失: 摘除残留的渡劫锁, 避免堵住后续交互 */
            await unlock(e.group_id, e.user_id, 'break')
            return false
        }
        /* 校验: 仅当渡劫在栈顶才处理(被逛街/换装埋住则让位, 保留待突破状态等回到栈顶再恢复) */
        if (!(await isCurrent(e.group_id, e.user_id, 'break'))) {
            return false
        }
        /* 状态锁复查: 洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态下禁止用数字突破 */
        if (await guardActionLocked(e)) return true
        const num = parseInt(e.msg.replace(/[^\d]/g, ''))
        if (num === 1) return await this.pillBreak(e)
        if (num === 2) return await this.skipBreak(e)
        e.reply(`请输入 1（吃${itemIcon('破障丹')}破障丹）或 2（直接突破）哦~`)
        return true
    }
    /** 丹药统一入口: 指定丹药名(惊鸿丹/破障丹/修为丹/聚宝丹/灵犀丹/行运丹/同心丹), 不写丹名统一吃修为丹(渡劫吃破障丹请回复 1/2 选择) */
    async takePill(e) {
        const raw = String(e.msg || '')
        /* 仙帝丹玩家不可服用(可自由交易), 只有伪玩家会自动服用 */
        if (raw.includes('仙帝丹')) {
            e.reply('👑 玩家无法服用仙帝丹，只有伪玩家会自动服用~（#伪玩家送 名字 仙帝丹 数量）')
            return true
        }
        /* 按消息内容识别指定丹药名(防呆, 名称可带可不带空格/前后) */
        if (raw.includes('惊鸿丹')) return await this.pillBuff(e)
        if (raw.includes('破障丹')) return await this.pillBreak(e)
        if (raw.includes('聚宝丹')) return await this.pillBaoLv(e)
        if (raw.includes('灵犀丹')) return await this.pillLingxi(e)
        if (raw.includes('行运丹')) return await this.pillXingyun(e)
        if (raw.includes('同心丹')) return await this.pillTongxin(e)
        if (raw.includes('玉甲丹')) return await this.pillDef(e)
        if (raw.includes('凝露丹')) return await this.pillHp(e)
        if (raw.includes('慧心丹')) return await this.pillCrit(e)
        if (raw.includes('摄魂丹')) return await this.pillCdmg(e)
        /* 修为丹 / 未指定 → 统一吃修为丹 */
        return await this.pillCultivate(e)
    }

    /** #一键服用增益丹: 背包里所有战斗/生活增益丹各服1颗(惊鸿/玉甲/凝露/慧心/摄魂/聚宝/灵犀/行运), 各1小时buff; 没有的跳过 */
    async oneClickPill(e) {
        const user_id = e.user_id
        const bag = getBag(user_id, e.group_id)
        const pills = [
            ['惊鸿丹', 'xujing:atk-buff', '攻击+20%'],
            ['玉甲丹', 'xujing:def-buff', '防御+20%'],
            ['凝露丹', 'xujing:hp-buff', '生命+20%'],
            ['慧心丹', 'xujing:crit-buff', '暴击率+30%'],
            ['摄魂丹', 'xujing:cdmg-buff', '爆伤+50%'],
            ['聚宝丹', 'xujing:baolv-buff', '幸运提升'],
            ['灵犀丹', 'xujing:lingxi-buff', '双修收益翻倍'],
            ['行运丹', 'xujing:xingyun-buff', '挂机收益翻倍']
        ]
        const taken = []
        const lack = []
        for (const [name, key, fx] of pills) {
            const have = (bag.items && bag.items[name]) ? bag.items[name].count : 0
            if (have < 1) { lack.push(`${itemIcon(name)}${name}`); continue }
            if (!consumeItem(user_id, name, 1, null, e.group_id)) { lack.push(`${itemIcon(name)}${name}`); continue }
            await redis.set(key + ':' + user_id, '1', { EX: 60 * 60 })
            taken.push(`${itemIcon(name)}${name}(${fx})`)
        }
        const msg = []
        if (taken.length) msg.push(`💊 一键增益完成！已服用：${taken.join('、')}（各持续1小时）`)
        if (lack.length) msg.push(`📭 背包不足未服用：${lack.join('、')}`)
        e.reply([segment.at(user_id), '\n' + (msg.length ? msg.join('\n') : '背包里没有任何增益丹~')])
        return true
    }

    /** 服用惊鸿丹: 攻击力+20%,持续1小时(丹阁不售,活动/特殊途径获得) */
    async pillBuff(e) {
        let user_id = e.user_id
        const bag = getBag(user_id, e.group_id)
        const have = (bag.items && bag.items['惊鸿丹']) ? bag.items['惊鸿丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('惊鸿丹')}惊鸿丹啦（丹阁不售，可通过活动/特殊途径获得）~`)
            return
        }
        if (!consumeItem(user_id, '惊鸿丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('惊鸿丹')}惊鸿丹啦（丹阁不售，可通过活动/特殊途径获得）~`)
            return
        }
        await redis.set(`xujing:atk-buff:${user_id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(user_id), `\n💫 服用${itemIcon('惊鸿丹')}惊鸿丹成功！攻击力+20%，持续1小时（再次服用刷新持续时间）！`])
        return true
    }

    /** 服用聚宝丹: 1小时内增加幸运值(副本/宝盒掉落概率提升,灵石不算) */
    async pillBaoLv(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['聚宝丹']) ? bag.items['聚宝丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('聚宝丹')}聚宝丹啦（配方台合成）~`)
            return
        }
        if (!consumeItem(id, '聚宝丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('聚宝丹')}聚宝丹啦~`)
            return
        }
        await redis.set(`xujing:baolv-buff:${id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(id), `\n🟠 服用${itemIcon('聚宝丹')}聚宝丹成功！1小时内增加幸运值（副本/宝盒掉落概率提升，灵石不算，再次服用刷新持续时间）！`])
        return true
    }

    /** 服用灵犀丹: 1小时内双修收益翻倍 */
    async pillLingxi(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['灵犀丹']) ? bag.items['灵犀丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('灵犀丹')}灵犀丹啦（配方台合成）~`)
            return
        }
        if (!consumeItem(id, '灵犀丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('灵犀丹')}灵犀丹啦~`)
            return
        }
        await redis.set(`xujing:lingxi-buff:${id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(id), `\n💗 服用${itemIcon('灵犀丹')}灵犀丹成功！1小时内双修收益翻倍（再次服用刷新持续时间）！`])
        return true
    }

    /** 服用行运丹: 1小时内挂机收益翻倍 */
    async pillXingyun(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['行运丹']) ? bag.items['行运丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('行运丹')}行运丹啦（配方台合成）~`)
            return
        }
        if (!consumeItem(id, '行运丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('行运丹')}行运丹啦~`)
            return
        }
        await redis.set(`xujing:xingyun-buff:${id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(id), `\n🍀 服用${itemIcon('行运丹')}行运丹成功！1小时内挂机收益翻倍（再次服用刷新持续时间）！`])
        return true
    }

    /** 服用同心丹: 每颗与道侣好感度+1000(支持 #服用丹药 同心丹 N 一次吃N颗, 上限99) */
    async pillTongxin(e) {
        const id = e.user_id
        /* 解析数量(默认1, 上限99) */
        const m = e.msg.match(/(\d+)/)
        const want = m ? Math.min(99, Math.max(1, parseInt(m[1]))) : 1
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['同心丹']) ? bag.items['同心丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('同心丹')}同心丹啦（配方台合成）~`)
            return
        }
        const use = Math.min(want, have)
        if (!consumeItem(id, '同心丹', use, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('同心丹')}同心丹啦~`)
            return
        }
        const filename = `${e.group_id}.json`
        const homejson = await xujing_data.getQQYUserHome(id, null, filename, false)
        const gain = 1000 * use
        homejson[id].love = (Number(homejson[id].love) || 0) + gain
        await xujing_data.getQQYUserHome(id, homejson, filename, true)
        e.reply([segment.at(id), `\n💞 服用${itemIcon('同心丹')}同心丹×${use}成功！与道侣好感度+${gain}（当前好感 ${homejson[id].love}）`])
        return true
    }

    /** 服用玉甲丹: 1小时内防御+20% */
    async pillDef(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['玉甲丹']) ? bag.items['玉甲丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('玉甲丹')}玉甲丹啦（配方台合成）~`)
            return
        }
        if (!consumeItem(id, '玉甲丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('玉甲丹')}玉甲丹啦~`)
            return
        }
        await redis.set(`xujing:def-buff:${id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(id), `\n🛡️ 服用${itemIcon('玉甲丹')}玉甲丹成功！1小时内防御+20%（决斗/幻境受伤减免，再次服用刷新持续时间）！`])
        return true
    }

    /** 服用凝露丹: 1小时内生命+20% */
    async pillHp(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['凝露丹']) ? bag.items['凝露丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('凝露丹')}凝露丹啦（配方台合成）~`)
            return
        }
        if (!consumeItem(id, '凝露丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('凝露丹')}凝露丹啦~`)
            return
        }
        await redis.set(`xujing:hp-buff:${id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(id), `\n🌸 服用${itemIcon('凝露丹')}凝露丹成功！1小时内生命+20%（决斗/幻境生存提升，再次服用刷新持续时间）！`])
        return true
    }

    /** 服用慧心丹: 1小时内暴击率+30% */
    async pillCrit(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['慧心丹']) ? bag.items['慧心丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('慧心丹')}慧心丹啦（配方台合成）~`)
            return
        }
        if (!consumeItem(id, '慧心丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('慧心丹')}慧心丹啦~`)
            return
        }
        await redis.set(`xujing:crit-buff:${id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(id), `\n⚡ 服用${itemIcon('慧心丹')}慧心丹成功！1小时内暴击率+30%（会心一击，再次服用刷新持续时间）！`])
        return true
    }

    /** 服用摄魂丹: 1小时内爆伤+50% */
    async pillCdmg(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const have = (bag.items && bag.items['摄魂丹']) ? bag.items['摄魂丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('摄魂丹')}摄魂丹啦（配方台合成）~`)
            return
        }
        if (!consumeItem(id, '摄魂丹', 1, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('摄魂丹')}摄魂丹啦~`)
            return
        }
        await redis.set(`xujing:cdmg-buff:${id}`, '1', { EX: 60 * 60 })
        e.reply([segment.at(id), `\n💥 服用${itemIcon('摄魂丹')}摄魂丹成功！1小时内爆伤+50%（暴击伤害大幅提升，再次服用刷新持续时间）！`])
        return true
    }

    /** 服用修为丹: 每颗固定+200灵力(支持 #服用丹药 N 一次吃N颗, 上限99) */
    async pillCultivate(e) {
        let user_id = e.user_id
        /* 解析数量(默认1, 上限99) */
        const m = e.msg.match(/(\d+)/)
        const want = m ? Math.min(99, Math.max(1, parseInt(m[1]))) : 1
        const json = await xujing_data.getQQYUserBattle(user_id, null, false, `${e.group_id}.json`)
        json[user_id].accum = Number(json[user_id].accum) || 0
        const bag = getBag(user_id, e.group_id)
        const have = (bag.items && bag.items['修为丹']) ? bag.items['修为丹'].count : 0
        if (have <= 0) {
            e.reply(`背包里没有${itemIcon('修为丹')}修为丹啦！去 #逛街 购买吧~`)
            return
        }
        const use = Math.min(want, have)
        if (!consumeItem(user_id, '修为丹', use, null, e.group_id)) {
            e.reply(`背包里没有${itemIcon('修为丹')}修为丹啦！去 #逛街 购买吧~`)
            return
        }
        /* 每日修为丹收益递减: 每100颗降一档, 每档收益再减半(200→100→50→25→…→最低1点), 次日重置(防吃丹速通) */
        const d0 = new Date()
        const today = `${d0.getFullYear()}-${d0.getMonth() + 1}-${d0.getDate()}`
        if (json[user_id].pillDate !== today) { json[user_id].pillDate = today; json[user_id].pillToday = 0 }
        const before = Number(json[user_id].pillToday) || 0
        const pillRateOf = (i) => Math.max(1, Math.round(200 / Math.pow(2, Math.floor((i - 1) / 100))))
        let rawGain = 0, degraded = 0
        for (let i = before + 1; i <= before + use; i++) {
            const r = pillRateOf(i)
            if (r < 200) degraded++
            rawGain += r
        }
        json[user_id].pillToday = before + use
        const needNext = getSubThreshold(json[user_id].level + 1)
        let gainMain = 0
        if (json[user_id].experience < needNext) {
            gainMain = Math.min(rawGain, needNext - json[user_id].experience)
        }
        let gainAccum = 0
        let gainLost = 0
        if (rawGain > gainMain) {
            const space = accumMax(json[user_id].level) - json[user_id].accum
            if (space > 0) gainAccum = Math.min(rawGain - gainMain, space)
            gainLost = rawGain - gainMain - gainAccum
            json[user_id].accum += gainAccum
        }
        json[user_id].experience += gainMain
        const totalGain = gainMain + gainAccum
        let gainNote = gainLost > 0 ? `（其中${gainLost}点灵力消散了）` : ''
        if (degraded) {
            gainNote += `（今日第${before + 1}颗起收益递减，明日重置）`
        }
        await xujing_data.getQQYUserBattle(user_id, json, true, `${e.group_id}.json`)
        e.reply([segment.at(user_id),
            `\n💊 服用${itemIcon('修为丹')}修为丹×${use}成功，获得${totalGain}点灵力${gainNote}！\n你的灵力:${json[user_id].experience}${json[user_id].accum > 0 ? `（累积+${json[user_id].accum}，突破后并入）` : ''}\n你的境界:${json[user_id].levelname}`])
        return true
    }

    /**
     * 
     */
    async exercise(e) {
        console.log("用户命令：", e.msg);
        let user_id = e.user_id;
        let lastTime_exercise = await redis.ttl(`duel:exercise-cd:${e.user_id}`);
        //let masterList = cfg.masterQQ
        if (lastTime_exercise !== -2) {//&& !masterList.includes(e.user_id)
            let tips = [
                segment.at(e.user_id), "\n",
                `你刚刚进行了一次锻炼!(*/ω＼*)`, "\n",
                `冷却中：${fmtCD(lastTime_exercise)}`
            ]
            e.reply(tips);
            return
        }

        const json = await xujing_data.getQQYUserBattle(user_id, null, false, `${e.group_id}.json`)
        /* 兼容旧存档 */
        json[user_id].accum = Number(json[user_id].accum) || 0

        await redis.set(`duel:exercise-cd:${e.user_id}`, currentTime, {
            EX: cdtime_exercise
        });
        const date = new Date();
        let hours = date.getHours()
        /* 房子修炼加成(取最好:自己+主人) */
        let cultivateBonus = 0
        try {
            const housefile = `${e.group_id}.json`
            const housejson = await xujing_data.getQQYUserHouse(user_id, null, housefile, false)
            const homejson = await xujing_data.getQQYUserHome(user_id, null, housefile, false)
            const xqjson = await xujing_data.getQQYUserxiaoqie(user_id, null, housefile, false)
            cultivateBonus = bestBonus(housejson, homejson, xqjson, user_id, 'cultivate')
        } catch { }
        //修炼灵力随机1~20,房子有修炼加成
        /* 宗门演武场: 修炼灵力 +8%/级 */
        let sectCultivate = 0
        try { sectCultivate = getFacilityLevel(e.group_id, user_id, 'yanwu') * 8 } catch (err) { }
        const rawGain = Math.round((1 + 19 * Math.random()) * (1 + cultivateBonus / 100) * (1 + sectCultivate / 100))
        /* 累积灵力(单独存放,不参与主灵力): 主灵力填到当前境界上限,溢出灵力进入累积池(上限=当前境界灵力5%),突破后并入
           累积已满不拒绝修炼,溢出的灵力会消散 */
        const needNext = getSubThreshold(json[user_id].level + 1)
        let gainMain = 0
        if (json[user_id].experience < needNext) {
            gainMain = Math.min(rawGain, needNext - json[user_id].experience)
        }
        let gainAccum = 0
        let gainLost = 0//消散的灵力
        if (rawGain > gainMain) {
            const space = accumMax(json[user_id].level) - json[user_id].accum
            if (space > 0) {
                gainAccum = Math.min(rawGain - gainMain, space)
            }
            gainLost = rawGain - gainMain - gainAccum
            json[user_id].accum += gainAccum
        }
        const totalGain = gainMain + gainAccum
        /* 显示文本: 获得总量 + 消散提示 + 累积灵力 */
        const gainNote = gainLost > 0 ? `（其中${gainLost}点灵力消散了）` : ''
        const expShow = () => `${json[user_id].experience}${json[user_id].accum > 0 ? `（累积+${json[user_id].accum}，突破后并入）` : ''}`
        //早上好
        if (e.msg.includes('早') || e.msg.includes('晨练')) {
            if (hours >= 6 && hours <= 8) {
                json[user_id].experience += gainMain
                e.reply([segment.at(user_id),
                `\n恭喜你获得了${totalGain}点灵力${gainNote},一日之计在于晨，清晨修炼效果更好哦！\n你的灵力为:${expShow()}\n你的境界为${json[user_id].levelname}`]);
            }
            else {
                json[user_id].experience += gainMain
                e.reply([segment.at(user_id),
                `\n现在一点也不早了，你只获得了${totalGain}点灵力${gainNote}。\n你的灵力为:${expShow()}\n你的境界为${json[user_id].levelname}`]);
            }
            return
        }
        //正常情(睡觉已移除, 统一按修炼结算)
        else if (hours >= 6 && hours <= 8) {
            json[user_id].experience += gainMain
            e.reply([segment.at(user_id),
            `\n🎉恭喜你获得了${totalGain}点灵力${gainNote},一日之计在于晨，清晨修炼效果更好哦！\n你的灵力为:${expShow()}\n你的境界为${json[user_id].levelname}`]);//发送消息
        } else if (hours >= 8 && hours <= 20) {
            json[user_id].experience += gainMain
            e.reply([segment.at(user_id),
            `\n🎉恭喜你获得了${totalGain}点灵力${gainNote}！\n你的灵力为:${expShow()}\n你的境界为${json[user_id].levelname}`]);//发送消息
        } else {
            json[user_id].experience += gainMain
            e.reply([segment.at(user_id),
            `\n由于熬夜，你只获得了${totalGain}点灵力${gainNote}！\n你的灵力为:${expShow()}\n你的境界为${json[user_id].levelname}`]);//发送消息
        }
        await xujing_data.getQQYUserBattle(user_id, json, true, `${e.group_id}.json`)
        return true;
    }
}
