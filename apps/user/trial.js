import { trialWeek, rotateTrialPeriods, settleTrialPeriods } from '../../components/trial_periods.js'
import { writeJsonAtomic } from '../../components/json_store.js'
import { withGameLock } from '../../components/game_lock.js'
// 幻境试炼: 挑战幻境守卫比拼伤害输出,日榜+周榜(周六零点换期，00:05发奖),记录每日最佳/本周累计
// 日榜按日期归档；每天00:05结算，周榜周六换期结算。
// 规范: 长文本回复一律用合并转发(forward)包裹展示,避免刷屏;短提示才直接 e.reply
import { BotApi, plugin } from '../../model/api/api.js'
import fs from 'fs'
import path from 'path'
import schedule from 'node-schedule'
import command from '../../components/command.js'
import moment from 'moment'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import { Plugin_Name, Plugin_Path, Save_Path } from '../../components/plugin.js'
import xujing_data from '../../components/xujing_data.js'
import Config from '../../model/Config.js'
import { getBag, grantItemOnce } from '../../components/equip_data.js'
import { calcDamage, calcCombatPower, realmPower, getBuffs, fightDesc } from '../../components/fight.js'
import { getSubThreshold } from './duel_exercise.js'

const dirpath = `${Save_Path}`
const filename = `trial.json`
const trialPath = () => `${dirpath}/${filename}`


/* 试炼配置缓存:1分钟刷新一次,guoba改配置后最多1分钟生效
   配置缺失时自动用默认值(默认开启/默认5分钟冷却/默认10回合) */
let trialCfg = { time: 0, notice: 'T', groups: [], cd: 2, rounds: 10 }
async function getTrialCfg() {
    if (Date.now() - trialCfg.time > 60000) {
        try {
            const notice = await command.getConfig("trial_cfg", "trial_notice")
            const groups = await command.getConfig("trial_cfg", "trial_group")
            const cd = await command.getConfig("trial_cfg", "trial_cd")
            const rounds = await command.getConfig("trial_cfg", "trial_rounds")
            trialCfg = {
                time: Date.now(),
                // 配置缺失时用默认值,避免功能被静默关闭
                notice: notice === undefined || notice === null ? 'T' : notice,
                groups: (groups || []).map(String),
                cd: Math.min(2, Math.max(1, Number(cd) || 2)),
                rounds: Math.min(30, Math.max(3, Number(rounds) || 10))
            }
        } catch (err) {
            console.log('读取幻境试炼配置失败:', err.message)
        }
    }
    return trialCfg
}

/** 秒格式化,如 4分10秒 */
const fmtCD = (sec) => {
    sec = Math.max(0, Math.ceil(Number(sec) || 0))
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

/** 读取试炼数据(容错坏档) */
function readTrial() {
    if (!fs.existsSync(dirpath)) fs.mkdirSync(dirpath, { recursive: true })
    if (!fs.existsSync(trialPath())) {
        fs.writeFileSync(trialPath(), JSON.stringify({ date: '', groups: {}, week: '', weekGroups: {}, lastGroups: {} }))
    }
    let data
    try { data = JSON.parse(fs.readFileSync(trialPath(), 'utf8')) } catch (err) {
        return { date: '', groups: {}, week: '', weekGroups: {}, lastGroups: {} }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { date: '', groups: {}, week: '', weekGroups: {}, lastGroups: {} }
    const before = JSON.stringify(data)
    rotateTrialPeriods(data)
    if (JSON.stringify(data) !== before) writeJsonAtomic(trialPath(), data)
    return data
}
function saveTrial(data) {
    if (!fs.existsSync(dirpath)) fs.mkdirSync(dirpath, { recursive: true })
    writeJsonAtomic(trialPath(), data)
}

/** 读取某用户境界 */
async function getUserLevel(user_id, gid = 'global') {
    try {
        const battlejson = await xujing_data.getQQYUserBattle(user_id, null, false, `${gid}.json`)
        const u = battlejson[user_id] || {}
        return { level: Number(u.level) || 0, levelname: u.levelname || '无灵力' }
    } catch (err) {
        return { level: 0, levelname: '无灵力' }
    }
}

/** 获取昵称(优先群名片) */
function getNick(e, user_id) {
    return (e.sender && (e.sender.card || e.sender.nickname)) || String(user_id)
}

/** 获取某群排行榜(按伤害降序,取前N) */
function getGroupRank(data, gid, n = 10) {
    return Object.entries((data.groups && data.groups[gid]) || {})
        .sort((a, b) => (Number(b[1].dmg) || 0) - (Number(a[1].dmg) || 0))
        .slice(0, n)
}

/** 周榜周期从周六零点开始。 */
function getWeekStart () { return trialWeek() }

/** 获取某群周榜(按本周总输出降序,取前N) */
function getGroupWeekRank(data, gid, n = 10) {
    return Object.entries((data.weekGroups && data.weekGroups[gid]) || {})
        .sort((a, b) => (Number(b[1].total) || 0) - (Number(a[1].total) || 0))
        .slice(0, n)
}

/** 获取某群境界榜(按境界等级降序,同境界比灵力,取前N) */
async function getGroupRealmRank(e, gid, n = 20) {
    const battlejson = await xujing_data.getQQYUserBattle(e.user_id, null, false, `${gid}.json`)
    const memberMap = await e.group.getMemberMap()
    const list = []
    const stats = {}//各大境界人数统计
    for (const aaa of memberMap) {
        const uid = String(aaa[1].user_id)
        const u = battlejson[uid]
        if (u && Number(u.level) > 0) {
            const level = Number(u.level) || 0
            const exp = Number(u.experience) || 0
            /* 大境界名(去掉 初期/中期/后期/巅峰 子境界) */
            const realmName = String(u.levelname || '').replace(/[初期中期后期巅峰]$/, '')
            stats[realmName] = (stats[realmName] || 0) + 1
            /* 完整战力(境界+装备+功法+丹药, 与战斗同源); 无背包档不建档 */
            let power = realmPower(level)
            try {
                if (fs.existsSync(`${dirpath}/bag/${gid}/${uid}.json`)) {
                    const bag = getBag(uid, gid)
                    const buff = await getBuffs(uid, gid)
                    power = calcCombatPower(level, bag, buff, gid, uid).power
                }
            } catch (err) { }
            list.push({
                uid,
                nick: aaa[1].card || aaa[1].nickname || uid,
                levelname: u.levelname || '无灵力',
                level,
                dmg: exp,//灵力(作为榜值)
                power,//完整战力(含所有加成)
                exp,//当前灵力
                need: getSubThreshold(level + 1)//下一级所需灵力
            })
        }
    }
    list.sort((a, b) => b.level - a.level || b.dmg - a.dmg)
    return { list: list.slice(0, n), stats }
}

/** 渲染排行榜图片(定时任务无 e,直接返回图片段供群发送)
 *  境界榜额外支持: exp/need → 灵力进度条, stats → 各大境界人数统计 */
async function renderRankImage({ date, list, title = '🌌 幻境试炼 · 伤害排行榜', sub = '虚境幻境 · 守卫溃败之日', valueLabel = '伤害', stats = null, foot = '' }) {
    const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
    return await puppeteer.screenshot(`${Plugin_Name}/rank/index`, {
        tplFile: path.join(Plugin_Path, 'resources', 'rank', 'index.html'),
        pluResPath: resPath,
        _res_path: resPath,
        saveId: `rank-${date}`,
        rankTitle: title,
        rankSub: sub,
        rankValueLabel: valueLabel,
        rankDate: date,
        rankFoot: foot,
        rankStats: stats ? Object.entries(stats)
            .sort((a, b) => (REALM_ORDER.indexOf(a[0]) - REALM_ORDER.indexOf(b[0])) || b[1] - a[1])
            .map(([name, count]) => ({ name, count })) : null,
        rankList: list.map((item, i) => {
            // 兼容 entries 格式([uid, info]) 与对象格式({uid, nick, levelname, dmg, power} 境界榜)
            const [uid, it] = Array.isArray(item) ? item : [item.uid, item]
            const rank = i + 1
            return {
                rank,
                medal: ['🥇', '🥈', '🥉'][i] || `${rank}`,
                cls: rank === 1 ? 'first' : rank === 2 ? 'second' : rank === 3 ? 'third' : '',
                uid,
                nick: (it && it.nick) || String(uid),
                levelname: (it && it.levelname) || '无灵力',
                dmg: Number(it && (it.total || it.dmg)) || 0,//周榜用 total,日榜用 dmg
                power: Number(it && it.power) || 0,
                exp: Number(it && it.exp) || 0,
                need: Number(it && it.need) || 0,
                progress: (() => {
                    const exp = Number(it && it.exp) || 0
                    const need = Number(it && it.need) || 0
                    if (need <= 0) return 0
                    const p = Math.round(exp / need * 100)
                    return Math.max(0, Math.min(100, p))
                })()
            }
        })
    })
}

/** 大境界排序(境界榜统计用): 与 duel_exercise 的 REALMS 一致 */
const REALM_ORDER = ['炼气期', '筑基期', '金丹期', '元婴期', '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '人仙', '天仙', '金仙', '大罗金仙', '九天玄仙', '罗天上仙', '仙君', '仙帝']

export class trial extends plugin {
    constructor() {
        super({
            name: '幻境试炼',
            dsc: '挑战幻境守卫比拼伤害输出,每日0点排行榜',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: '^[#＃]?(幻境试炼|幻境挑战|虚境幻境)$',
                    fnc: 'trial'
                },
                {
                    reg: '^[#＃]?幻境排行$',
                    fnc: 'rank'
                },
                {
                    reg: '^[#＃]?幻境周榜$',
                    fnc: 'rankWeek'
                },
                {
                    reg: '^[#＃]?(境界榜|幻境境界榜|境界排行)$',
                    fnc: 'realmRank'
                },
                {
                    reg: '^[#＃]?幻境试炼测试$',
                    fnc: 'testRank'
                }
            ]
        })
    }

    /** 幻境试炼: 挑战守卫,记录当日最高输出 */
    async trial(e) {
        try {
            if (!e.group_id) {
                e.reply('幻境试炼需在群内进行~')
                return true
            }
            const user_id = e.user_id
            const gid = String(e.group_id)
            const cfg = await getTrialCfg()
            // 每日次数检查(一天最多2次,0点重置)
            const daily = Math.min(2, Math.max(1, Number(cfg.cd) || 2))
            const today = moment().format('YYYY-MM-DD')
            const dayKey = `xujing:trial-day:${gid}:${user_id}:${today}`
            const used = Number(await redis.get(dayKey)) || 0
            if (used >= daily) {
                e.reply([segment.at(user_id), `\n你今天的幻境试炼次数已用完（${used}/${daily}），明天0点重置后再来挑战吧~`])
                return true
            }
            const { level, levelname } = await getUserLevel(user_id, gid)
            const bag = getBag(user_id, gid)
            const buff = await getBuffs(user_id, gid)
            const { power } = calcCombatPower(level, bag, buff, gid, user_id)
            // 模拟 cfg.rounds 回合攻击(与决斗同一套战力/伤害体系)
            const rounds = []
            let total = 0
            for (let r = 1; r <= cfg.rounds; r++) {
                const { dmg } = calcDamage(level, bag, 0.2, buff, gid, user_id)
                rounds.push(dmg)
                total += dmg
            }
            // 记录当日最佳(每群独立排名)
            const data = readTrial()
            const weekKey = getWeekStart()
            rotateTrialPeriods(data, today, weekKey)
            data.groups[gid] = data.groups[gid] || {}
            const uid = String(user_id)
            const prev = data.groups[gid][uid]
            const isRecord = !prev || total > (Number(prev.dmg) || 0)
            if (isRecord) {
                data.groups[gid][uid] = {
                    dmg: total,
                    nick: getNick(e, user_id),
                    levelname,
                    power,
                    time: moment().format('HH:mm:ss')
                }
            }
            // 本期累计；上一期成绩由 rotateTrialPeriods 归档，等待发奖。
            data.weekGroups = data.weekGroups || {}
            data.weekGroups[gid] = data.weekGroups[gid] || {}
            const wu = data.weekGroups[gid][uid]
            data.weekGroups[gid][uid] = {
                total: (wu ? Number(wu.total) || 0 : 0) + total,
                best: Math.max(wu ? Number(wu.best) || 0 : 0, total),
                nick: getNick(e, user_id),
                levelname,
                power,
                time: moment().format('HH:mm:ss')
            }
            saveTrial(data)
            // 记录今日挑战次数(一天最多2次,当天结束过期)
            await redis.incr(dayKey)
            const _now = new Date()
            const _mid = new Date(_now); _mid.setHours(24, 0, 0, 0)
            await redis.expire(dayKey, Math.max(1, Math.floor((_mid - _now) / 1000)))
            // 今日剩余次数(incr 后 = used+1)
            const left = Math.max(0, daily - (used + 1))
            // 结果播报(长文本自动合并渲染成图片)
            const lines = rounds.map((d, i) => `第${i + 1}轮 · ${fightDesc(i, d, '你', '幻境守卫')}`)
            const msgArr = [
                `🌌 幻境试炼开启！\n你（${levelname} · 战力${power}）直面【幻境守卫】\n一场恶战就此展开！`,
                ...lines,
                `━━━━━━━━━━━━\n总输出：${total} 点伤害\n${isRecord ? '🎉 刷新今日最佳，荣登幻境榜！' : `今日最佳仍为 ${prev.dmg} 点伤害，再接再厉！`}\n今日剩余次数：${left}/${daily}（0点重置）\n发送 #幻境排行 看日榜 / #幻境周榜 看周榜`
            ]
            Config.getforwardMsg(msgArr, e)
        } catch (err) {
            console.log('幻境试炼失败:', err.message)
            e.reply('幻境试炼出现异常，请稍后再试~')
        }
        return true
    }

    /** 今日日榜(图片) */
    async rank(e) {
        try {
            if (!e.group_id) {
                e.reply('请在群内查看排行~')
                return true
            }
            const gid = String(e.group_id)
            const data = readTrial()
            const today = moment().format('YYYY-MM-DD')
            if (data.date !== today) {
                e.reply('今天还没有人挑战幻境试炼，快来抢榜首吧！')
                return true
            }
            const list = getGroupRank(data, gid, 10)
            if (!list.length) {
                e.reply('今天还没有人挑战幻境试炼，快来抢榜首吧！')
                return true
            }
            const img = await renderRankImage({ date: today, list, title: '🌌 幻境试炼 · 日榜', sub: '虚境幻境 · 守卫溃败之日', valueLabel: '伤害' })
            if (img) e.reply(img)
            else e.reply('图片渲染失败，请稍后再试~')
        } catch (err) {
            console.log('幻境排行失败:', err.message)
            e.reply('排行读取失败，请稍后再试~')
        }
        return true
    }

    /** 本周周榜(图片) */
    async rankWeek(e) {
        try {
            if (!e.group_id) {
                e.reply('请在群内查看排行~')
                return true
            }
            const gid = String(e.group_id)
            const data = readTrial()
            const weekKey = getWeekStart()
            if (data.week !== weekKey) {
                e.reply('本周还没有人挑战幻境试炼，快来抢榜首吧！')
                return true
            }
            const list = getGroupWeekRank(data, gid, 10)
            if (!list.length) {
                e.reply('本周还没有人挑战幻境试炼，快来抢榜首吧！')
                return true
            }
            const img = await renderRankImage({ date: `本周（${data.week} 起）`, list, title: '🌌 幻境试炼 · 周榜', sub: '虚境幻境 · 本周总输出', valueLabel: '伤害' })
            if (img) e.reply(img)
            else e.reply('图片渲染失败，请稍后再试~')
        } catch (err) {
            console.log('幻境周榜失败:', err.message)
            e.reply('排行读取失败，请稍后再试~')
        }
        return true
    }

    /** 境界排行榜(图片): 按本群境界等级排序,同境界比灵力,含灵力进度/境界人数统计 */
    async realmRank(e) {
        try {
            if (!e.group_id) {
                e.reply('请在群内查看排行~')
                return true
            }
            const gid = String(e.group_id)
            const { list, stats } = await getGroupRealmRank(e, gid, 20)
            if (!list.length) {
                e.reply('本群还没有修仙者上榜，快修炼冲击境界榜吧！')
                return true
            }
            const img = await renderRankImage({
                date: moment().format('YYYY-MM-DD'),
                list,
                title: '🌌 虚境 · 境界排行榜',
                sub: '虚境幻境 · 修行之道',
                valueLabel: '灵力',
                stats,
                foot: '发送 #修炼 提升境界 · 同境界比灵力 · Powered by xujing-yue-plugin'
            })
            if (img) e.reply(img)
            else e.reply('图片渲染失败，请稍后再试~')
        } catch (err) {
            console.log('境界榜失败:', err.message)
            e.reply('排行读取失败，请稍后再试~')
        }
        return true
    }

    /** 测试: 在当前群渲染排行榜图片(调试用) */
    async testRank(e) {
        try {
            if (!e.group_id) {
                e.reply('请在群内测试~')
                return true
            }
            const gid = String(e.group_id)
            const data = readTrial()
            const today = moment().format('YYYY-MM-DD')
            const list = getGroupRank(data, gid, 10)
            if (!list.length) {
                e.reply('今天还没有试炼数据，无法渲染图片~')
                return true
            }
            const img = await renderRankImage({ date: today, list })
            if (img) e.reply(img)
            else e.reply('图片渲染失败，请检查 puppeteer~')
        } catch (err) {
            console.log('幻境试炼测试失败:', err.message)
            e.reply('图片渲染失败，请稍后再试~')
        }
        return true
    }
}

// 每天23点(晚上11点): 向白名单群提示今天幻境即将结算
schedule.scheduleJob('0 0 23 * * *', async () => {
    try {
        const cfg = await getTrialCfg()
        if (cfg.notice !== 'T') return
        for (const gid of cfg.groups) {
            try {
                await Bot.pickGroup(gid).sendMsg('🌌 幻境即将结算！')
            } catch (err) { console.log(`[幻境试炼]群${gid}预告失败:`, err.message) }
        }
        console.log('[幻境试炼]23点结算预告已发送')
    } catch (err) {
        console.log('[幻境试炼]23点预告失败:', err.message)
    }
})

/** 先同步完成读档、发奖和保存；通知在保存后发送，避免等待网络时覆盖新榜单。 */
async function settleStoredTrials (options = {}) {
    const cfg = await getTrialCfg()
    if (cfg.notice !== 'T') return
    const notices = []
    for (const gid of cfg.groups) {
        try {
            const batch = await withGameLock(gid, () => {
                // 排队后重新读全局榜单；锁内不等待网络，不覆盖其他群刚提交的成绩。
                const data = readTrial()
                try {
                    return settleTrialPeriods(data, [gid], (g, uid, name, count, receipt) => {
                        grantItemOnce(uid, name, count, g, receipt)
                    }, options)
                } finally { saveTrial(data) }
            })
            notices.push(...batch)
        } catch (err) { console.log(`[幻境试炼]群${gid}发奖失败，保留待结算记录:`, err.message) }
    }
    for (const n of notices) {
        try { await Bot.pickGroup(n.gid).sendMsg(n.kind === 'daily' ? '🌟 幻境日榜奖励已发放。' : '🌟 幻境周榜奖励已发放。') } catch (err) { console.log('[幻境试炼]结算通知失败:', err.message) }
    }
}

// 每日补发已归档的日榜和周榜；周榜仅在周六进入下一期后可领取。
schedule.scheduleJob('0 5 0 * * *', () => settleStoredTrials().catch(err => console.log('[幻境试炼]日结算失败:', err.message)))
schedule.scheduleJob('0 5 0 * * 6', () => settleStoredTrials({ daily: false, weekly: true }).catch(err => console.log('[幻境试炼]周结算失败:', err.message)))
