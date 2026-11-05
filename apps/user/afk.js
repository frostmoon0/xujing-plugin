import { withGameLock } from '../../components/game_lock.js'
//自动挂机:沉默满N小时(默认1天)再发言,自动结算挂机灵石(每天最多2400)+挂机灵力(每天最多300)
//不足N小时只记录时间不提示;结算按挂机时长比例;灵力溢出走累积池(最多200),再多消散
//使用全局消息监听 Bot.on('message') 实现,与插件规则系统完全独立,不会拦截任何其他指令
//支持手动结算指令: #挂机结算 / #结算挂机 / #领取挂机 / #挂机收益
import { BotApi, plugin } from '../../model/api/api.js'
import command from '../../components/command.js'
import xujing_data from '../../components/xujing_data.js'
import { getSubThreshold, accumMax } from './duel_exercise.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { afterTax, getGongfaFx } from '../../components/equip_data.js'

/* 挂机配置缓存:1分钟刷新一次,guoba改配置后最多1分钟生效
   配置缺失时自动用默认值(默认开启/默认1天提示/默认2400灵石/默认300灵力),避免旧配置导致功能失效 */
let afkCfg = { time: 0, notice: 'T', groups: [], hour: 24, money: 2400, lp: 300 }
async function getAfkCfg() {
    if (Date.now() - afkCfg.time > 60000) {
        try {
            const notice = await command.getConfig("wife_cfg", "afk_notice")
            const groups = await command.getConfig("wife_cfg", "afk_group")
            const hour = await command.getConfig("wife_cfg", "afk_hour")
            const money = await command.getConfig("wife_cfg", "afk_money")
            const lp = await command.getConfig("wife_cfg", "afk_lp")
            afkCfg = {
                time: Date.now(),
                // 配置缺失时用默认值,避免功能被静默关闭
                notice: notice === undefined || notice === null ? 'T' : notice,
                groups: (groups || []).map(String),
                hour: Number(hour) || 24,
                money: Number(money) || 2400,
                lp: Number(lp) || 300
            }
        } catch (err) {
            // 读取失败保持默认值(默认开启)
            console.log('读取自动挂机配置失败:', err.message)
        }
    }
    return afkCfg
}

/** 挂机时长格式化,如 2小时5分钟 / 45分钟 */
function fmtAfkTime(hours) {
    hours = Math.max(0, hours)
    const h = Math.floor(hours)
    const m = Math.floor((hours - h) * 60)
    return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`
}

/** 秒格式化,如 4分10秒 */
function fmtCD(sec) {
    sec = Math.max(0, Math.ceil(Number(sec) || 0))
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return m > 0 ? `${m}分${s}秒` : `${s}秒`
}
/** 加成取最好: 自己房子 与 所有主人(娶/纳此人的人)的房子 中该字段的最大值 */
function bestBonus(housejson, homejson, xqjson, uid, key) {
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

//结算挂机收益(自动/手动共用)
//返回 { settled:true, finalGet, workBonus, silenceSec, hours, money } / { settled:false, cdSec, first } / null
async function settleAfk(gid, uid) { return withGameLock(gid, () => settleAfkUnlocked(gid, uid)) }
async function settleAfkUnlocked(gid, uid) {
    const cfg = await getAfkCfg()
    if (cfg.notice !== 'T') return null
    const now = Date.now()
    const msgKey = `xujing:afk:${gid}:${uid}`        //最后发言时间
    const setKey = `xujing:afk-set:${gid}:${uid}`    //最后结算时间

    const lastMsg = await redis.get(msgKey)
    const lastSet = await redis.get(setKey)

    //首次:只记录时间,不结算不提示
    if (!lastMsg) {
        await redis.set(msgKey, String(now))
        await redis.set(setKey, String(now))
        return { settled: false, first: true }
    }

    //更新本次发言时间
    await redis.set(msgKey, String(now))

    //沉默时长(用于2小时提示判断)
    const silenceSec = (now - Number(lastMsg)) / 1000
    if (!(silenceSec > 0)) return { settled: false }

    //兼容旧档: 老玩家没有结算记录,先初始化结算时间,本次不结算
    if (!lastSet) {
        await redis.set(setKey, String(now))
        return { settled: false, first: true }
    }

    //不够5分钟不结算
    const setSec = (now - Number(lastSet)) / 1000
    if (!(setSec > 0) || setSec < 5 * 60) {
        return { settled: false, cdSec: Math.max(0, Math.ceil(5 * 60 - setSec)) }
    }

    //按距上次结算时长结算: 每满24小时一份, 挂机超过一天按天数累计(不再封顶在一天收益)
    const hours = setSec / 3600
    let get = Math.floor(cfg.money * hours / 24)
    //挂机灵力: 同样按天数累计(默认每天300)
    let lp = Math.floor(cfg.lp * hours / 24)
    // 行运丹: 1小时内挂机收益翻倍(灵石+灵力)
    let xingyunBuff = 1
    try { if (await redis.get(`xujing:xingyun-buff:${uid}`)) xingyunBuff = 2 } catch (err) { }
    // 功法: 挂机收益加成(与行运丹取最高,行运功×2/璇玑衍算×2/太阴月华诀×3)
    try { const gfx = await getGongfaFx(uid); if (gfx && gfx.afk) xingyunBuff = Math.max(xingyunBuff, gfx.afk) } catch (err) { }
    get = Math.floor(get * xingyunBuff)
    lp = Math.floor(lp * xingyunBuff)
    if (get <= 0 && lp <= 0) return { settled: false }

    //房子挂机/摆摊加成也生效(仅灵石,取最好:自己+主人)
    var filename = gid + `.json`
    var homejson = await xujing_data.getQQYUserHome(uid, null, filename, false)
    var housejson = await xujing_data.getQQYUserHouse(uid, null, filename, false)
    var xqjson = await xujing_data.getQQYUserxiaoqie(uid, null, filename, false)
    let workBonus = bestBonus(housejson, homejson, xqjson, uid, 'work')
    let finalGet = Math.round(get * (1 + workBonus / 100))
    homejson[uid].money += afterTax(finalGet)
    await xujing_data.getQQYUserHome(uid, homejson, filename, true)

    //挂机灵力: 主灵力填到当前境界上限, 溢出进累积池(最多200), 再多消散
    let lpGain = 0, lpLost = 0
    if (lp > 0) {
        const battlejson = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
        battlejson[uid] = battlejson[uid] || {}
        battlejson[uid].accum = Number(battlejson[uid].accum) || 0
        battlejson[uid].experience = Number(battlejson[uid].experience) || 0
        const needNext = getSubThreshold(Number(battlejson[uid].level) + 1)
        let gainMain = 0
        if (battlejson[uid].experience < needNext) {
            gainMain = Math.min(lp, needNext - battlejson[uid].experience)
        }
        let gainAccum = 0
        if (lp > gainMain) {
            const space = accumMax(battlejson[uid].level) - battlejson[uid].accum
            if (space > 0) gainAccum = Math.min(lp - gainMain, space)
            lpLost = lp - gainMain - gainAccum
            battlejson[uid].accum += gainAccum
        }
        battlejson[uid].experience += gainMain
        lpGain = gainMain + gainAccum
        await xujing_data.getQQYUserBattle(uid, battlejson, true, `${gid}.json`)
    }
    await redis.set(setKey, String(now))

    return { settled: true, finalGet, workBonus, silenceSec, hours, money: homejson[uid].money, lp: lpGain, lpLost }
}

//全局消息处理(收到的是原始消息事件,不经过插件规则系统)
async function afkHandle(event) {
    try {
        //只处理群聊消息
        if (!event || event.message_type !== 'group') return
        if (!event.group_id || !event.user_id) return
        //忽略机器人自己
        if (Bot && Bot.uin && String(event.user_id) === String(Bot.uin)) return

        const cfg = await getAfkCfg()
        //提示开关
        if (cfg.notice !== 'T') return
        //白名单群:只在这些群结算提示(群号统一转字符串比较)
        if (cfg.groups.length > 0 && !cfg.groups.map(String).includes(String(event.group_id))) return

        const r = await settleAfk(event.group_id, event.user_id)
        //满cfg.hour小时(默认1天)没说话才提示,不足则静默结算不提示
        if (r && r.settled && r.silenceSec >= cfg.hour * 3600) {
            const nick = (event.sender && (event.sender.card || event.sender.nickname)) || ''
            const afkText = `【${nick}】自动挂机结算！\n你已挂机${fmtAfkTime(r.silenceSec / 3600)}\n自动赚取${r.finalGet}灵石${r.workBonus > 0 ? `(房子挂机加成${r.workBonus}%)` : ''}\n自动修炼获得${r.lp || 0}灵力${r.lpLost > 0 ? `（${r.lpLost}点灵力消散了）` : ''}\n当前灵石:${r.money}`
            const afkImg = await textToImg(afkText)
            await Bot.pickGroup(event.group_id).sendMsg(afkImg || afkText)
        }
    } catch (err) {
        console.log('自动挂机结算失败:', err.message)
    }
}

//手动结算挂机收益指令
//结算规则与自动一致: 距上次结算不足5分钟不结算,挂机收益按天比例结算
//手动结算必定提示结果(与自动不同: 自动只有沉默满2小时才提示)
export class afksettle extends plugin {
    constructor() {
        super({
            name: '挂机结算',
            dsc: '手动结算挂机灵石',
            event: 'message',
            priority: 200,
            rule: [
                { reg: '^[#＃]?(挂机结算|结算挂机|领取挂机|挂机收益)$', fnc: 'manual' }
            ]
        })
    }
    async manual(e) {
        try {
            if (!e.group_id) {
                e.reply('请在群内使用该指令~')
                return true
            }
            const cfg = await getAfkCfg()
            if (cfg.notice !== 'T') {
                e.reply('挂机功能未开启~')
                return true
            }
            //白名单群:只在这些群结算
            if (cfg.groups.length > 0 && !cfg.groups.map(String).includes(String(e.group_id))) {
                e.reply('本群未开启挂机功能~')
                return true
            }
            const r = await settleAfk(e.group_id, e.user_id)
            if (!r) {
                e.reply('挂机功能未开启~')
                return true
            }
            if (r.first) {
                e.reply('已开始记录你的挂机时间，下次发送 #挂机结算 即可结算收益~')
                return true
            }
            if (!r.settled) {
                if (r.cdSec > 0) {
                    e.reply(`结算太频繁了，还需等待${fmtCD(r.cdSec)}再结算~`)
                } else {
                    e.reply('暂时没有可结算的挂机收益~')
                }
                return true
            }
            e.reply([
                `【挂机结算】\n`,
                `你已挂机${fmtAfkTime(r.hours)}\n`,
                `获得${r.finalGet}灵石${r.workBonus > 0 ? `(房子挂机加成${r.workBonus}%)` : ''}\n`,
                `挂机修炼获得${r.lp || 0}灵力${r.lpLost > 0 ? `（${r.lpLost}点灵力消散了）` : ''}\n`,
                `当前灵石:${r.money}`
            ])
        } catch (err) {
            console.log('挂机手动结算失败:', err.message)
            e.reply('结算失败，请稍后再试~')
        }
        return true
    }
}

//注册全局消息监听(Bot未就绪则定时重试,注册成功后停止)
let afkRegistered = false
let afkTry = 0
function registerAfk() {
    if (afkRegistered) return
    afkTry++
    if (afkTry > 30) {
        console.log('[自动挂机] 全局消息监听注册失败(Bot未就绪,放弃)')
        return
    }
    try {
        if (Bot && typeof Bot.on === 'function') {
            Bot.on('message', afkHandle)
            afkRegistered = true
            console.log('[自动挂机] 全局消息监听已注册')
            return
        }
    } catch (e) { }
    setTimeout(registerAfk, 3000)
}
registerAfk()
