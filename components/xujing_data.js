import fs from 'fs'
import path from 'path'
import { Plugin_Name, Plugin_Path, Save_Path } from './plugin.js'
import { normalizeBattleLevels } from './realm_cap.js'
// 存档统一存放于 Yunzai 本体 data 目录(如 C:/Users/Administrator/Desktop/Yunzai-Bot/data/xujing-yue-plugin/save)
const dirpath = `${Save_Path}`
const QQYpath = `${Save_Path}/qylp`
const QQYhomepath = `${Save_Path}/qylp/UserHome`
const QQYincapath = `${Save_Path}/qylp/UserYinPa`
const QQYplacepath = `${Save_Path}/qylp/UserPlace`
const QQYhousepath = `${Save_Path}/qylp/UserHouse`
const QQYbattlepath = `${Save_Path}/battle`
// ===== 存档自动迁移(兜底) =====
// 旧版存档在插件目录内(data 根目录 / data/save),若未手动搬移,启动时自动迁移到 Yunzai 本体 data 目录
function migrateOldSave() {
    const oldRoot = path.join(Plugin_Path, 'data')
    const saveRoot = `${Save_Path}`
    const list = [
        [`${oldRoot}/battle.json`, `${saveRoot}/battle.json`],
        [`${oldRoot}/UserData`, `${saveRoot}/UserData`],
        [`${oldRoot}/qylp`, `${saveRoot}/qylp`],
        [`${oldRoot}/save/battle.json`, `${saveRoot}/battle.json`],
        [`${oldRoot}/save/UserData`, `${saveRoot}/UserData`],
        [`${oldRoot}/save/qylp`, `${saveRoot}/qylp`],
        [`${oldRoot}/save/bag`, `${saveRoot}/bag`],
        [`${oldRoot}/bag`, `${saveRoot}/bag`]
    ]
    try {
        if (!fs.existsSync(saveRoot)) {
            fs.mkdirSync(saveRoot, { recursive: true })
        }
        for (const [src, dest] of list) {
            if (fs.existsSync(src) && !fs.existsSync(dest)) {
                fs.renameSync(src, dest)
                console.log(`[虚境插件] 存档迁移: ${src} -> ${dest}`)
            }
        }
    } catch (err) {
        console.log(`[虚境插件] 存档自动迁移失败:`, err)
    }
}
migrateOldSave()
//这两个函数都是用来读取和保存json数据的
async function getUser(id, json, Template, filename, is_save) {
    /*if (filename.indexOf(".json") == -1) {//如果文件名不包含.json
        filename = filename + ".json";//添加.json
    }*/
    if (!is_save) {
        if (!fs.existsSync(dirpath)) {//如果文件夹不存在
            fs.mkdirSync(dirpath);//创建文件夹
        }
        if (!fs.existsSync(dirpath + "/" + filename)) {//如果文件不存在
            fs.writeFileSync(dirpath + "/" + filename, JSON.stringify({//创建文件
            }));
        }
        var json = JSON.parse(fs.readFileSync(dirpath + "/" + filename, "utf8"));//读取文件
        if (!json.hasOwnProperty(id)) {//如果json中不存在该用户
            json[id] = Template
        }
        return json;
    }
    else {
        fs.writeFileSync(dirpath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        return json;
    }
}
async function getUser2(user_id, json, dirname, is_save) {
    if (is_save) {
        let filename = `${user_id}.json`;
        fs.writeFileSync(dirpath + `/${dirname}/` + filename, JSON.stringify(json, null, "\t"));
    }
    else {
        let filename = `${user_id}.json`;
        if (!fs.existsSync(dirpath)) {//如果文件夹不存在
            fs.mkdirSync(dirpath);//创建文件夹
        }
        //如果文件不存在，创建文件
        if (!fs.existsSync(dirpath + `/${dirname}/` + filename)) {
            fs.writeFileSync(dirpath + `/${dirname}/` + filename, JSON.stringify({
            }));
        }
        //读取文件
        var json = JSON.parse(fs.readFileSync(dirpath + `/${dirname}/` + filename, "utf8"));
        return json
    }
}
// 修为灵力按群存档(2026-08-09): filename 形如 {群号}.json, 默认 global.json(旧全局档/兜底)
// 兼容: 玩家首次在某群访问时,若该群没有数据而 global.json 有,自动迁移旧数据过来(数据不丢)
async function getQQYUserBattle(id, json, is_save, filename = 'global.json') {
    if (typeof filename !== 'string' || !filename.endsWith('.json')) filename = 'global.json'
    if (!is_save) {
        if (!fs.existsSync(QQYbattlepath)) {//如果文件夹不存在
            fs.mkdirSync(QQYbattlepath, { recursive: true });//创建文件夹
        }
        const file = `${QQYbattlepath}/${filename}`
        if (!fs.existsSync(file)) {//如果文件不存在
            fs.writeFileSync(file, JSON.stringify({//创建文件
            }));
        }
        var json = JSON.parse(fs.readFileSync(file, 'utf8'));//读取文件
        /* 境界硬上限: 仙帝第499重; 超过的旧档/异常档读取时即收敛并落盘 */
        var capChanged = normalizeBattleLevels(json)
        if (!json.hasOwnProperty(id)) {//如果json中不存在该用户
            var battleTemplate = {//创建该用户
                "experience": 0,
                "level": 0,
                "levelname": '无灵力',
                "Privilege": 0,
            };
            json[id] = battleTemplate
            // 兼容旧全局档: 该群首次访问时自动迁移旧数据
            if (filename !== 'global.json') {
                try {
                    const gfile = `${QQYbattlepath}/global.json`
                    if (fs.existsSync(gfile)) {
                        const gjson = JSON.parse(fs.readFileSync(gfile, 'utf8'))
                        if (gjson[id]) json[id] = gjson[id]
                    }
                } catch (err) { }
            }
            fs.writeFileSync(file, JSON.stringify(json, null, "\t"));//写入文件
        } else if (capChanged) {
            /* 有超上限档: 读取时立即落盘, 避免旧档一直停留在异常重数 */
            fs.writeFileSync(file, JSON.stringify(json, null, "\t"));
        }
        return json;
    }
    else {
        normalizeBattleLevels(json)
        fs.writeFileSync(`${QQYbattlepath}/${filename}`, JSON.stringify(json, null, "\t"));//写入文件
        return json;
    }
}
async function getQQYUserPlace(id, json, filename, is_save) {
    if (!is_save) {
        if (!fs.existsSync(QQYpath)) {//如果文件夹不存在
            fs.mkdirSync(QQYpath);//创建文件夹
        }
        if (!fs.existsSync(QQYplacepath)) {//如果文件夹不存在
            fs.mkdirSync(QQYplacepath);//创建文件夹
        }
        if (!fs.existsSync(QQYplacepath + "/" + filename)) {//如果文件不存在
            fs.writeFileSync(QQYplacepath + "/" + filename, JSON.stringify({//创建文件
            }));
        }
        var json = JSON.parse(fs.readFileSync(QQYplacepath + "/" + filename, "utf8"));//读取文件
        if (!json.hasOwnProperty(id)) {//如果json中不存在该用户
            let place_template = {
                "place": "home",
                "placetime": 0
            }
            json[id] = place_template
            fs.writeFileSync(QQYplacepath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        }
        return json;
    }
    else {
        fs.writeFileSync(QQYplacepath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        return json;
    }
}
async function getQQYUserxiaoqie(id, json, filename, is_save){
    if (!is_save) {
        if (!fs.existsSync(QQYpath)) {//如果文件夹不存在
            fs.mkdirSync(QQYpath);//创建文件夹
        }
        if (!fs.existsSync(QQYincapath)) {//如果文件夹不存在
            fs.mkdirSync(QQYincapath);//创建文件夹
        }
        if (!fs.existsSync(QQYincapath + "/" + filename)) {//如果文件不存在
            fs.writeFileSync(QQYincapath + "/" + filename, JSON.stringify({//创建文件
            }));
        }
        var json = JSON.parse(fs.readFileSync(QQYincapath + "/" + filename, "utf8"));//读取文件
        if (!json.hasOwnProperty(id)) {//如果json中不存在该用户
            let place_template = {
                "shuangxiu": [],
                "shuangxiu_time": 0
            }
            json[id] = place_template
            fs.writeFileSync(QQYincapath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        }
        // 兼容旧存档: fuck/fucktime/kun -> shuangxiu/shuangxiu_time
        if (json[id].fuck !== undefined && json[id].shuangxiu === undefined) {
            json[id].shuangxiu = json[id].fuck
            json[id].shuangxiu_time = json[id].fucktime || 0
            delete json[id].fuck
            delete json[id].fucktime
            delete json[id].kun
            fs.writeFileSync(QQYincapath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        }
        return json;
    }
    else {
        fs.writeFileSync(QQYincapath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        return json;
    }
}
async function getQQYUserHome(id, json, filename, is_save) {
    if (!is_save) {
        if (!fs.existsSync(QQYpath)) {//如果文件夹不存在
            fs.mkdirSync(QQYpath);//创建文件夹
        }
        if (!fs.existsSync(QQYhomepath)) {//如果文件夹不存在
            fs.mkdirSync(QQYhomepath);//创建文件夹
        }
        let needWrite = false
        if (!fs.existsSync(QQYhomepath + "/" + filename)) {//如果文件不存在
            fs.writeFileSync(QQYhomepath + "/" + filename, JSON.stringify({}));//创建文件
        }
        var json = JSON.parse(fs.readFileSync(QQYhomepath + "/" + filename, "utf8"));//读取文件
        if (!json.hasOwnProperty(id)) {//如果json中不存在该用户
            json[id] = {
                "s": 0,
                "wait": 0,
                "money": 100,
                "love": 0,
                "karma": 0
            }
            needWrite = true
        }
        // 仅新建用户时写盘: 避免只读操作也整文件写回(性能 + 并发丢更新)
        // money2/love2 二进制由启动兼容处理统一取高清理, 运行时不再“取低”压回旧值(防数据丢失)
        if (needWrite) {
            fs.writeFileSync(QQYhomepath + "/" + filename, JSON.stringify(json, null, "\t"))
        }
        return json;
    }
    else {
        // 写入二进制: 同步本文件所有用户(否则只有操作者的money2/love2更新,
        // 其他被加钱/扣钱的人读取时会被下方"冲突取高"逻辑用旧二进制覆盖回旧值)
        for (const uid of Object.keys(json)) {
            const u = json[uid]
            if (!u || typeof u !== 'object') continue
            if (Number.isFinite(Number(u.money))) u.money2 = Number(u.money).toString(2)
            if (Number.isFinite(Number(u.love))) u.love2 = Number(u.love).toString(2)
        }
        fs.writeFileSync(QQYhomepath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        return json;
    }
}
async function getQQYUserHomeData(filename = 'global.json') {
    if (typeof filename !== 'string' || !filename.endsWith('.json')) filename = 'global.json'
    const file = `${QQYhomepath}/${filename}`
    if (!fs.existsSync(file)) return {}
    try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'))
        return json && typeof json === 'object' && !Array.isArray(json) ? json : {}
    } catch (err) {
        return {}
    }
}

async function getQQYUserHouse(id, json, filename, is_save) {
    if (!is_save) {
        if (!fs.existsSync(QQYpath)) {//如果文件夹不存在
            fs.mkdirSync(QQYpath);//创建文件夹
        }
        if (!fs.existsSync(QQYhousepath)) {//如果文件夹不存在
            fs.mkdirSync(QQYhousepath);//创建文件夹
        }
        if (!fs.existsSync(QQYhousepath + "/" + filename)) {//如果文件不存在
            fs.writeFileSync(QQYhousepath + "/" + filename, JSON.stringify({//创建文件
            }));
        }
        var json = JSON.parse(fs.readFileSync(QQYhousepath + "/" + filename, "utf8"));//读取文件
        if (!json.hasOwnProperty(id)) {//如果json中不存在该用户
            let house_template = {
                "name": "小破屋",
                "space": 2,//0级房子可居住人数(老婆+小妾)
                "price": 500,
                "loveup": 0,
                "work": 0,
                "hug": 0,
                "cultivate": 0
            }
            json[id] = house_template
            fs.writeFileSync(QQYhousepath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        } else {
            // 兜底修正: 小破屋(0级)固定可居住2人, 纠正旧档遗留的错误 space(曾为6/0/缺失)
            const h = json[id]
            if (h && (h.name === '小破屋' || !h.level || Number(h.level) === 0) && !(Number(h.space) === 2)) {
                h.space = 2
                if (!h.name) h.name = '小破屋'
                fs.writeFileSync(QQYhousepath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
            }
        }
        return json;
    }
    else {
        fs.writeFileSync(QQYhousepath + "/" + filename, JSON.stringify(json, null, "\t"));//写入文件
        return json;
    }
}

/* ===== 拉黑名单(存redis, 内存缓存10秒, 避免每条指令都读redis; 屏蔽被拉黑用户的指令, 防开小号刷屏) ===== */
const BLACKLIST_KEY = 'xujing:blacklist'
let _blCache = null
let _blCacheAt = 0
async function getBlacklist() {
    if (_blCache && Date.now() - _blCacheAt < 10000) return _blCache
    try {
        const txt = await redis.get(BLACKLIST_KEY)
        const arr = txt ? JSON.parse(txt) : []
        _blCache = Array.isArray(arr) ? arr.map(String) : []
    } catch (err) {
        _blCache = _blCache || []
    }
    _blCacheAt = Date.now()
    return _blCache
}
async function saveBlacklist(arr) {
    _blCache = [...new Set((arr || []).map(String))]
    _blCacheAt = Date.now()
    await redis.set(BLACKLIST_KEY, JSON.stringify(_blCache))
}
async function isBlacklisted(qq) {
    if (!qq) return false
    const list = await getBlacklist()
    return list.includes(String(qq))
}
async function addBlacklist(qq) {
    if (!qq) return false
    const list = await getBlacklist()
    if (!list.includes(String(qq))) {
        list.push(String(qq))
        await saveBlacklist(list)
        return true
    }
    return false
}
async function removeBlacklist(qq) {
    if (!qq) return false
    const list = await getBlacklist()
    const next = list.filter(x => x !== String(qq))
    if (next.length !== list.length) {
        await saveBlacklist(next)
        return true
    }
    return false
}
async function addPlayerKarma(gid, uid, amount = 1) {
    amount = Math.max(0, Math.floor(Number(amount) || 0))
    if (!amount) return 0
    const filename = `${gid}.json`
    const home = await getQQYUserHome(uid, null, filename, false)
    if (!home[uid]) return 0
    home[uid].karma = (Number(home[uid].karma) || 0) + amount
    await getQQYUserHome(uid, home, filename, true)
    return home[uid].karma
}

export default { getUser, getQQYUserBattle, getQQYUserPlace, getQQYUserxiaoqie, getQQYUserHome, getQQYUserHomeData, getQQYUserHouse, getUser2, getBlacklist, isBlacklisted, addBlacklist, removeBlacklist, addPlayerKarma }