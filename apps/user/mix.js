import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import fs from 'fs'
import path from 'path'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import { Plugin_Name, Plugin_Path } from '../../components/plugin.js'
import xujing_data from '../../components/xujing_data.js'
import Yanghun from '../../components/yanghun_data.js'
import { DEPLOY_MATS } from '../../components/dynasty_data.js'
import { addItem, addItemToBag, consumeItem, consumeBagItem, getBag, getItemAttr, saveBag, hasDingxianyou, ITEM_TPL, MATERIAL_TPL, QUALITY, EQUIP_TPL, rollEquipAttr, rollRandomColorEquip, fmtAttr, ownedRedWeapons, craftRainbow, renameRainbow, rainbowInfoLines, itemIcon, yaodanName, rollYaodanTierFromRemnant } from '../../components/equip_data.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { PUPPET_INITIAL_COST, PUPPET_UPGRADE_COSTS } from '../../components/puppet_data.js'

/** 打造材料选择(彩装红装胚子 / 彩武红武器): 候选多时弹列表由玩家选择 */
const pendingCraftColor = {}


/** 丹药配方: 丹药名 -> { mats:[{name,count}] } (只用药材herb,不用矿物; 非彩色药材: 星霜草4/青鸾草4/望舒花5/月华芝5/凤栖花6) */
const RECIPES = {
  '惊鸿丹': { mats: [{ name: '望舒花', count: 1 }, { name: '星霜草', count: 2 }] },
  '聚宝丹': { mats: [{ name: '凤栖花', count: 1 }, { name: '青鸾草', count: 2 }] },
  '灵犀丹': { mats: [{ name: '月华芝', count: 1 }, { name: '星霜草', count: 2 }] },
  '行运丹': { mats: [{ name: '望舒花', count: 1 }, { name: '月华芝', count: 1 }] },
  '同心丹': { mats: [{ name: '月华芝', count: 1 }, { name: '青鸾草', count: 2 }] },
  '玉甲丹': { mats: [{ name: '凤栖花', count: 1 }, { name: '月华芝', count: 1 }] },
  '凝露丹': { mats: [{ name: '凤栖花', count: 1 }, { name: '星霜草', count: 2 }] },
  '慧心丹': { mats: [{ name: '凤栖花', count: 1 }, { name: '望舒花', count: 1 }] },
  '摄魂丹': { mats: [{ name: '望舒花', count: 1 }, { name: '青鸾草', count: 2 }] },
  '还魂丹': { mats: [{ name: '玄阴玉', count: 2 }, { name: '镇魂晶', count: 1 }, { name: '血煞髓', count: 1 }, { name: '云裳仙蕊', count: 1 }] }
}

/** 定仙游配方: 神游蛊×1 + 万魂窟三种核心材料各×5 */
const DINGXIANYOU_RECIPE = {
    mats: [
        { name: '神游蛊', count: 1 },
        { name: '玄阴玉', count: 5 },
        { name: '镇魂晶', count: 5 },
        { name: '血煞髓', count: 5 }
    ]
}

/** 万魂幡配方: 残卷×5 + 两种基础材料各×20 + 成长性特殊彩武×1 */
const WANHUN_RECIPE = {
    mats: [
        { name: '万魂幡残卷', count: 5 },
        { name: '阴魂砂', count: 20 },
        { name: '游魂骨', count: 20 },
        { name: '成长性特殊彩武', count: 1, quality: 7, icon: '🌈' }
    ]
}

/** 丹药品质(用于配方图展示): 红6 惊鸿丹/灵犀丹/玉甲丹/慧心丹/摄魂丹, 金5 聚宝丹/行运丹/同心丹/凝露丹 */
const PILL_QUALITY = { '惊鸿丹': 6, '灵犀丹': 6, '玉甲丹': 6, '慧心丹': 6, '摄魂丹': 6, '还魂丹': 6, '聚宝丹': 5, '行运丹': 5, '同心丹': 5, '凝露丹': 5 }

/** 红装制造配方: 所有矿物各1(不含彩色造梦神玉) → 随机部位随机属性红装 */
const RED_ORE = ['月魄石', '星璇石', '流光玉', '织云石', '凤羽玉']//5种非彩色矿物

/** 万阵核心配方: 四种红色阵法材料 + 30万灵石 → 1万阵核心 */
const ARRAY_CORE_RECIPE = [
    { name: '天衍阵纹', count: 1 },
    { name: '乾坤阵晶', count: 1 },
    { name: '太虚阵砂', count: 1 },
    { name: '九幽阵髓', count: 1 }
]
const ARRAY_CORE_COST = 300000

/** 彩装制造: 6 造梦神玉(彩矿) + 1 随机红装 → 随机彩装(品质7, 属性=红装×3; 独一无二一套6件) */
const COLOR_ORE = '造梦神玉'
const COLOR_EQUIPS = ['攻势·武器', '攻势·头盔', '攻势·胸甲', '攻势·裤子', '攻势·鞋子', '攻势·戒指']

/** 随机帮助背景图 */
const rodom = () => {
    const imageDir = path.join(Plugin_Path, 'resources', 'help', 'imgs')
    if (!fs.existsSync(imageDir)) return ''
    const list = fs.readdirSync(imageDir)
    if (!list.length) return ''
    return list.length === 1 ? list[0] : list[Math.floor(Math.random() * list.length)]
}

export class MIX extends plugin {
    constructor() {
        super({
            name: '娶群友',
            dsc: '娶群友',
            event: 'message',
            priority: 66,
            rule: [{
                reg: "^[#＃]?(配方台|虚境合成台)$",
                fnc: 'mixbox'
            },
            {
                reg: '^[#＃]?(合成|炼制|打造)定仙游$',
                fnc: 'craftDingxianyou'
            },
            {
                reg: '^[#＃]?(合成|炼制|打造)(万阵核心|阵法核心)$',
                fnc: 'craftArrayCore'
            },
            {
                // 防呆: 数量可在丹药名前后, 可有可无空格(#合成慧心丹3 / #合成慧心丹 3 / #合成3慧心丹)
                reg: "^[#＃]?合成\\s*(\\d+\\s*)?(惊鸿丹|聚宝丹|灵犀丹|行运丹|同心丹|玉甲丹|凝露丹|慧心丹|摄魂丹|还魂丹)(\\s*\\d+)?$",
                fnc: 'mixCraft'
            },
            {
                // 数量可直接写在命令后，也兼容空格及半角/全角括号: 制造红装50 / 制造红装 50 / 制造红装（50）
                reg: '^[#＃]?(制造红装|打造红装|合成红装|锻造红装|炼造红装)(?:\\s*(?:[（(]\\s*\\d+\\s*[）)]|\\d+))?$',
                fnc: 'craftRedEquip'
            },
            {
                // 可选红装胚子(按名称)或直接按列表序号: #制造彩装 / #制造彩装 霓裳剑 / #制造彩装5
                reg: '^[#＃]?(制造彩装|打造彩装|合成彩装|锻造彩装|炼造彩装)(?:\\s*(\\d+)|\\s+(\\S+))?$',
                fnc: 'craftColorEquip'
            },
            {
                // 可选红武器名或直接按列表序号: #铸造特殊彩武 / #铸造特殊彩武 朱雀扇 / #铸造特殊彩武3
                reg: '^[#＃]?(铸造特殊彩武|打造特殊彩武|合成特殊彩武|特殊彩武)(?:\\s*(\\d+)|\\s+(\\S+))?$',
                fnc: 'craftRainbow'
            },
            {
                reg: '^[#＃]?彩武命名\\s*(\\S*)$',
                fnc: 'nameRainbow'
            },
            {
                reg: '^[#＃]?(我的彩武|彩武信息|我的神兵|神兵信息|七彩神兵信息)$',
                fnc: 'rainbowInfo'
            },
            {
                // 残丹凝练妖丹: 5个残丹合成1颗随机品质(1~7阶)妖丹, 数量可省略(默认1)
                reg: '^[#＃]?(合成妖丹|凝炼妖丹|凝聚妖丹)\\s*(\\d+)?\\s*$',
                fnc: 'craftYaodan'
            },
            {
                // 打造彩装材料选择数字; 无待选状态时放行给其他插件
                reg: '^[#＃]?[0-9]+$',
                fnc: 'mixNumber'
            }
            ]
        })
    }

    /** #配方台: 展示全部丹药、法宝配方并渲染图片 */
    async mixbox(e) {
        /* 材料可能来自 MATERIAL_TPL，也可能是 ITEM_TPL(如神游蛊) */
        const mat = (name, count, override = {}) => {
            const material = MATERIAL_TPL[name]
            const item = ITEM_TPL[name]
            const quality = override.quality || material?.quality || (name === '灵石' ? 1 : 7)
            return {
                name,
                quality,
                icon: override.icon || (name === '灵石' ? '💰' : (material ? QUALITY[quality].icon : (item?.icon || '🔹'))),
                count
            }
        }
        const potionFormulas = Object.keys(RECIPES).map(pillName => ({
            mats: RECIPES[pillName].mats.map(m => mat(m.name, m.count)),
            result: {
                name: pillName,
                quality: PILL_QUALITY[pillName] || 5,
                icon: ITEM_TPL[pillName]?.icon || '💊',
                count: 1,
                desc: ITEM_TPL[pillName]?.desc || ''
            }
        }))
        const artifactFormulas = [
            {
                kind: 'artifact',
                mats: DINGXIANYOU_RECIPE.mats.map(m => mat(m.name, m.count)),
                result: {
                    name: '定仙游',
                    quality: 7,
                    icon: '🦋',
                    count: 1,
                    desc: '装备后生命+10%；拥有即生效：阴魂撤退100%、免费跨区传送'
                }
            },
            {
                kind: 'artifact',
                mats: WANHUN_RECIPE.mats.map(m => mat(m.name, m.count, m)),
                result: {
                    name: '万魂幡',
                    quality: 7,
                    icon: '🏴',
                    count: 1,
                    desc: '禁忌法宝；需要成长性特殊彩武，装备后可在万魂窟收魂'
                }
            },
            {
                kind: 'artifact',
                mats: [
                    ...Object.entries(PUPPET_INITIAL_COST.materials).map(([name, count]) => mat(name, count)),
                    mat('灵石', '50万', { quality: 1, icon: '💰' })
                ],
                result: {
                    name: '傀儡',
                    quality: 1,
                    icon: '⚪',
                    count: 1,
                    desc: '需🌈傀儡术下篇；每阶均需🌈万阵核心×5。升级材料见傀儡面板，祭出每30分钟自动消耗1万灵石。'
                }
            }
        ]
        const arrayFormulas = [{
            kind: 'array',
            mats: [
                ...ARRAY_CORE_RECIPE.map(m => mat(m.name, m.count)),
                mat('灵石', '30万', { quality: 1, icon: '💰' })
            ],
            result: {
                name: '万阵核心',
                quality: 7,
                icon: '🔮',
                count: 1,
                desc: '四种红色阵法材料各1 + 30万灵石；布置任何阵法消耗1枚'
            }
        }]
        const arrayDeployFormulas = [{
            kind: 'array-deploy',
            name: '血炼大阵',
            mats: Object.entries(DEPLOY_MATS).map(([name, count]) => mat(name, count)),
            result: { name: '血炼大阵', quality: 7, icon: '🩸', count: 1, desc: '学会后布置屠城；每次布置消耗1枚万阵核心及对应材料' }
        }, {
            kind: 'array-deploy',
            name: '一阶养魂阵',
            mats: Object.entries(Yanghun.BASE_COST).map(([name, count]) => mat(name, count)),
            result: { name: '一阶养魂阵', quality: 7, icon: '🌀', count: 1, desc: '养魂阵每小时产出魂魄；布置时消耗1枚万阵核心' }
        }]
        const bg = await rodom()
        /* 红装制造材料(所有矿物各1, 不含彩色造梦神玉) */
        const redMats = RED_ORE.map(n => ({
            name: n,
            quality: MATERIAL_TPL[n].quality,
            icon: QUALITY[MATERIAL_TPL[n].quality].icon,
            count: 1
        }))
        /* 彩装制造材料(6造梦神玉 + 1红装) */
        const colorMats = [
            mat(COLOR_ORE, 6),
            { name: '红装×1', quality: 6, icon: QUALITY[6].icon, count: 1 }
        ]
        /* 特殊彩武制造材料(6彩色药材 + 1红武器) */
        const rainbowMats = [
            mat('云裳仙蕊', 6),
            { name: '红武器', quality: 6, icon: QUALITY[6].icon, count: 1 }
        ]
        /* 妖丹凝练(残丹×5 → 随机品质妖丹): 与丹药RECIPES无关, 走 #合成妖丹 专属指令 */
        const yaodanFormulas = [{
            mats: [mat('残丹', 5)],
            result: {
                name: '随机品质妖丹',
                quality: 5,
                icon: '🎖️',
                count: 1,
                desc: '5个残丹凝成1颗妖丹，随机1~7阶（低阶更常见）'
            },
            tip: '#合成妖丹（可带数量，如 #合成妖丹 3）'
        }]
        const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
        const img = await puppeteer.screenshot(`${Plugin_Name}/recipe/index`, {
            tplFile: path.join(Plugin_Path, 'resources', 'qylp', 'recipe.html'),
            pluResPath: resPath,
            _res_path: resPath,
            saveId: `recipe-${Date.now()}`,
            bg,
            potionFormulas,
            artifactFormulas,
            arrayFormulas,
            arrayDeployFormulas,
            redMats,
            colorMats,
            rainbowMats,
            yaodanFormulas
        })
        if (img) e.reply([img])
        else e.reply('图片渲染失败，请检查 puppeteer~')
        return true
    }

    /** #合成[丹药名] [数量]: 按配方扣除药材,批量合成丹药(默认1颗,上限99) */
    async mixCraft(e) {
        const id = e.user_id
        const m = String(e.msg || '').match(/(惊鸿丹|聚宝丹|灵犀丹|行运丹|同心丹|玉甲丹|凝露丹|慧心丹|摄魂丹|还魂丹)/)
        const pillName = m ? m[1] : null
        if (!pillName || !RECIPES[pillName]) {
            e.reply('请指定要合成的丹药，如：#合成聚宝丹（发送 #配方台 查看配方，可 #合成聚宝丹 5 批量合成）')
            return true
        }
        /* 解析数量(默认1, 上限99) */
        const numM = String(e.msg || '').match(/(\d+)/)
        const want = numM ? Math.min(99, Math.max(1, parseInt(numM[1]))) : 1
        const recipe = RECIPES[pillName]
        const bag = getBag(id, e.group_id)
        /* 配方异常防呆 */
        for (const mat of recipe.mats) {
            if (!MATERIAL_TPL[mat.name]) {
                e.reply('配方异常，请重新发送 #配方台 查看~')
                return true
            }
        }
        /* 材料不足提示(合成want个所需 vs 持有) */
        const lack = recipe.mats.filter(mat => ((bag.items[mat.name] && bag.items[mat.name].count) || 0) < mat.count * want)
        if (lack.length) {
            const needStr = recipe.mats.map(mat => `${QUALITY[MATERIAL_TPL[mat.name].quality].icon}${mat.name}×${mat.count * want}`).join(' + ')
            const haveStr = recipe.mats.map(mat => `${QUALITY[MATERIAL_TPL[mat.name].quality].icon}${mat.name}×${(bag.items[mat.name] && bag.items[mat.name].count) || 0}`).join(' ')
            e.reply(`材料不足！合成${pillName}×${want}需要 ${needStr}（你持有：${haveStr}）\n先去虚境秘境收集药材吧~`)
            return true
        }
        /* 扣材料 + 加丹药 */
        for (const mat of recipe.mats) consumeItem(id, mat.name, mat.count * want, null, e.group_id)
        addItem(id, pillName, want, null, e.group_id)
        e.reply(`🧪 合成成功！消耗 ${recipe.mats.map(mat => `${QUALITY[MATERIAL_TPL[mat.name].quality].icon}${mat.name}×${mat.count * want}`).join(' + ')}，获得 ${ITEM_TPL[pillName].icon}${pillName}×${want}（${ITEM_TPL[pillName].desc}）`)
        return true
    }

    /** #合成妖丹 [数量]: 5个残丹 → 1颗随机品质妖丹(低阶更常见), 默认1颗上限99颗 */
    async craftYaodan(e) {
        const id = e.user_id
        const gid = e.group_id
        const numM = String(e.msg || '').match(/(\d+)/)
        const want = numM ? Math.min(99, Math.max(1, parseInt(numM[1], 10))) : 1
        const need = want * 5
        /* 单次读档内校验+扣除+入包, 一次保存(参照制造红装原子写法, 避免逐次读改写) */
        const bag = getBag(id, gid)
        const have = (bag.items && bag.items['残丹'] && bag.items['残丹'].count) || 0
        if (have < need) {
            e.reply(`材料不足！合成${want}颗妖丹需要 ${itemIcon('残丹')}残丹×${need}（你持有 ${have}）\n残丹只在遗蜕秘境(公开/专属)探索掉落~`)
            return true
        }
        if (!consumeBagItem(bag, '残丹', need)) {
            e.reply('材料状态已变化，请重新检查背包后再合成~')
            return true
        }
        const got = {}
        for (let i = 0; i < want; i++) {
            const tier = rollYaodanTierFromRemnant()
            const name = yaodanName(tier)
            got[name] = (got[name] || 0) + 1
        }
        for (const [name, count] of Object.entries(got)) addItemToBag(bag, name, count, null, false)
        saveBag(id, bag, gid)
        const gotTxt = Object.entries(got).map(([name, count]) => `${itemIcon(name)}${name}×${count}`).join('、')
        e.reply(`🧪 凝练成功！消耗 ${itemIcon('残丹')}残丹×${need}，获得 ${gotTxt}${want > 1 ? '' : '（5残丹=1颗随机品质妖丹，低阶更常见~）'}`)
        return true
    }

    /** #合成万阵核心: 四种红色阵法材料各1 + 30万灵石 → 1万阵核心 */
    async craftArrayCore(e) {
        const id = e.user_id
        const gid = e.group_id
        const bag = getBag(id, gid)
        const lack = ARRAY_CORE_RECIPE.filter(({ name, count }) => ((bag.items[name] && bag.items[name].count) || 0) < count)
        if (lack.length) {
            const need = ARRAY_CORE_RECIPE.map(({ name, count }) => `${itemIcon(name)}${name}×${count}`).join('、')
            const have = ARRAY_CORE_RECIPE.map(({ name }) => `${itemIcon(name)}${name}×${(bag.items[name] && bag.items[name].count) || 0}`).join('、')
            e.reply(`材料不足！合成万阵核心需要：${need}\n你当前拥有：${have}；另需30万灵石~`)
            return true
        }
        const filename = `${gid}.json`
        const home = await xujing_data.getQQYUserHome(id, null, filename, false)
        const money = Number(home[id] && home[id].money) || 0
        if (money < ARRAY_CORE_COST) {
            e.reply(`灵石不足！合成万阵核心需要 ${ARRAY_CORE_COST.toLocaleString()} 灵石，你当前只有 ${money.toLocaleString()} 灵石~`)
            return true
        }
        for (const { name, count } of ARRAY_CORE_RECIPE) {
            if (!consumeBagItem(bag, name, count)) {
                e.reply('材料状态已变化，请重新检查背包后再合成~')
                return true
            }
        }
        home[id].money = money - ARRAY_CORE_COST
        await xujing_data.getQQYUserHome(id, home, filename, true)
        saveBag(id, bag, gid)
        addItem(id, '万阵核心', 1, null, gid)
        e.reply('🔮 万阵核心合成成功！四种红色阵法材料与30万灵石已消耗；以后布置任何阵法均需消耗1枚万阵核心。')
        return true
    }

    /** #合成定仙游: 神游蛊×1 + 玄阴玉/镇魂晶/血煞髓各×5, 法宝拥有即生效 */
    async craftDingxianyou(e) {
        const id = e.user_id
        const gid = e.group_id
        const bag = getBag(id, gid)
        if (hasDingxianyou(bag)) {
            e.reply('你已经拥有定仙游，不能重复合成~')
            return true
        }
        const recipe = [
            { name: '神游蛊', count: 1 },
            { name: '玄阴玉', count: 5 },
            { name: '镇魂晶', count: 5 },
            { name: '血煞髓', count: 5 }
        ]
        const lack = recipe.filter(({ name, count }) => ((bag.items[name] && bag.items[name].count) || 0) < count)
        if (lack.length) {
            const need = recipe.map(({ name, count }) => `${itemIcon(name)}${name}×${count}`).join('、')
            const have = recipe.map(({ name }) => `${itemIcon(name)}${name}×${(bag.items[name] && bag.items[name].count) || 0}`).join('、')
            e.reply(`材料不足！合成定仙游需要：${need}\n你当前拥有：${have}`)
            return true
        }
        for (const { name, count } of recipe) {
            const item = bag.items[name]
            item.count -= count
            if (item.count <= 0) delete bag.items[name]
        }
        bag.artifacts = bag.artifacts || {}
        bag.artifacts.dingxianyou = { owned: true, equipped: false, craftedAt: Date.now() }
        saveBag(id, bag, gid)
        e.reply('🦋 定仙游合成成功！\n请使用 #装备定仙游 开启生命+10%装备效果。拥有定仙游即可触发两个被动：万魂窟阴魂撤退100%成功、免费跨区传送。')
        return true
    }

    /** #制造红装(数量): 消耗所有非彩色矿物各1, 随机部位随机属性红装(品质6) */
    async craftRedEquip(e) {
        const id = e.user_id
        const bag = getBag(id, e.group_id)
        const numM = String(e.msg || '').match(/(?:制造红装|打造红装|合成红装|锻造红装|炼造红装)\s*(?:[（(]\s*(\d+)\s*[）)]|(\d+))\s*$/)
        const rawWant = numM ? parseInt(numM[1] || numM[2], 10) : 1
        if (!Number.isInteger(rawWant) || rawWant < 1) {
            e.reply('制造数量必须是大于 0 的整数~')
            return true
        }
        const want = Math.min(99, rawWant)
        const needStr = RED_ORE.map(n => `${QUALITY[MATERIAL_TPL[n].quality].icon}${n}×${want}`).join('+')
        // 材料不足提示(列出持有情况, 整批不执行)
        const lack = RED_ORE.filter(n => ((bag.items[n] && bag.items[n].count) || 0) < want)
        if (lack.length) {
            const have = RED_ORE.map(n => `${QUALITY[MATERIAL_TPL[n].quality].icon}${n}×${(bag.items[n] && bag.items[n].count) || 0}`).join(' ')
            e.reply(`材料不足！制造红装×${want}需要 ${needStr}（你持有：${have}）\n先去虚境秘境收集矿物吧~`)
            return true
        }
        // 扣矿物(单次读档内完成, 避免重读覆盖)
        for (const n of RED_ORE) {
            if (!consumeBagItem(bag, n, want)) {
                e.reply('材料状态已变化，请重新检查背包后再制造~')
                return true
            }
        }
        // 每件独立随机红装(品质6)与属性; 不自动穿戴, 入包后由玩家 #更换 自行选择
        const reds = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 6)
        const results = []
        for (let i = 0; i < want; i++) {
            const name = reds[Math.floor(Math.random() * reds.length)]
            const attr = rollEquipAttr(EQUIP_TPL[name].type, 6)
            addItemToBag(bag, name, 1, attr, false)
            results.push(`${QUALITY[6].icon}${name}（${fmtAttr(attr)}）`)
        }
        saveBag(id, bag, e.group_id)
        e.reply(`⚒️ 打造成功！消耗 ${needStr}，获得红装×${want}\n${results.join('\n')}\n已放入背包（未自动穿戴），可发送 #更换<部位> 选择要穿哪一件~`)
        return true
    }

    /** #制造彩装[序号] 或 #制造彩装 [红装名]: 6造梦神玉(彩矿) + 1红装 → 随机彩装(品质7)。
     *  按列表序号直接选(如 #制造彩装3); 不带序号弹出带序号的列表(1件也弹)。 */
    async craftColorEquip(e) {
        const id = e.user_id
        const gid = e.group_id
        const bag = getBag(id, gid)
        const haveOre = (bag.items[COLOR_ORE] && bag.items[COLOR_ORE].count) || 0
        if (haveOre < 6) {
            e.reply(`材料不足！制造彩装需要 ${QUALITY[7].icon}造梦神玉×6（你持有：${haveOre}）`)
            return true
        }
        /* 该部位的候选红装(品质6, 背包中的未穿件) */
        const redNames = Object.keys(bag.items || {}).filter(n => EQUIP_TPL[n] && EQUIP_TPL[n].quality === 6 && (bag.items[n].count || 0) > 0)
        if (!redNames.length) {
            e.reply('制造彩装还需要 1 件红装（🔴品质6），先去虚境秘境或拍卖行获取吧~')
            return true
        }
        const m = String(e.msg || '').match(/^[#＃]?(?:制造彩装|打造彩装|合成彩装|锻造彩装|炼造彩装)(?:\s*(\d+)|\s+(\S+))?\s*$/)
        const wantNum = m && m[1] ? parseInt(m[1], 10) : null
        const wantName = m && m[2] ? m[2].trim() : ''
        const list = redNames.map((name, i) => ({
            name,
            label: `${QUALITY[6].icon}${name} ×${bag.items[name].count}（${fmtAttr(bag.items[name].list?.[0]?.attr || bag.items[name].attr || {})}）`
        }))
        /* 按序号直接选 */
        if (wantNum) {
            if (wantNum < 1 || wantNum > list.length) {
                e.reply(`序号超出范围，可用红装：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
                return true
            }
            return this.doCraftColor(e, bag, list[wantNum - 1].name)
        }
        /* 按名称直接选 */
        if (wantName) {
            const exact = list.filter(x => x.name === wantName)
            const partial = !exact.length ? list.filter(x => x.name.includes(wantName)) : []
            if (exact.length === 1) return this.doCraftColor(e, bag, exact[0].name)
            if (partial.length === 1) return this.doCraftColor(e, bag, partial[0].name)
            e.reply(`背包里找不到红装「${wantName}」，可用红装：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
            return true
        }
        /* 不带序号/名称: 弹列表选择(1件也弹) */
        await forceLock(e.group_id, id, 'craft-color')
        pendingCraftColor[id] = { type: 'color', list, time: Date.now() }
        e.reply(`请发送数字选择要用哪一件红装作胚子（消耗该红装×1 + ${QUALITY[7].icon}造梦神玉×6）：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
        return true
    }

    /** 实际执行彩装打造(红装胚子已确定) */
    async doCraftColor(e, bag, red) {
        const id = e.user_id
        const gid = e.group_id
        /* 先生成产物，模板异常时不应先扣除材料 */
        const colorEquip = rollRandomColorEquip(COLOR_EQUIPS)
        if (!colorEquip) {
            e.reply('彩装模板异常，请联系管理员检查彩装配置~')
            return true
        }
        /* 单次读取、单次保存，避免连续重读背包时覆盖穿戴中的彩装。
         * 先同时校验造梦神玉与红装胚子都足够, 再统一扣除 —— 避免其中一种不足时另一种已被扣掉
         * (单实例缓存下, 半截扣除会留在内存并被下次保存落盘, 造成材料凭空消失) */
        const oreIt = bag.items && bag.items[COLOR_ORE]
        const redIt = bag.items && bag.items[red]
        if (!oreIt || (Number(oreIt.count) || 0) < 6 || !redIt || (Number(redIt.count) || 0) < 1) {
            e.reply('材料状态已变化，请重新检查背包后再制造~')
            return true
        }
        consumeBagItem(bag, COLOR_ORE, 6)
        consumeBagItem(bag, red, 1)
        const { name: colorName, attr } = colorEquip
        /* 不自动穿戴: 新彩装入包后由玩家 #更换 决定是否替换当前穿着 */
        addItemToBag(bag, colorName, 1, attr, false)
        saveBag(id, bag, gid)
        e.reply(`🌈 锻造成功！消耗 ${QUALITY[7].icon}造梦神玉×6 + ${QUALITY[6].icon}${red}×1，获得 ${QUALITY[7].icon}${colorName}（${fmtAttr(attr)}）—— 已放入背包（未自动穿戴），可发送 #更换${EQUIP_TPL[colorName].type} 选择是否穿上~`)
        return true
    }

    /** 打造材料选择数字回调(彩装/彩武共用) */
    async mixNumber(e) {
        const pc = pendingCraftColor[e.user_id]
        if (!pc || Date.now() - pc.time > 5 * 60 * 1000) {
            delete pendingCraftColor[e.user_id]
            await unlock(e.group_id, e.user_id, 'craft-color')
            await unlock(e.group_id, e.user_id, 'craft-rainbow')
            return false
        }
        const lockName = pc.type === 'rainbow' ? 'craft-rainbow' : 'craft-color'
        /* 校验: 仅当对应打造交互在栈顶才处理(被其它交互埋住则让位, 保留打造待选状态等回到栈顶再恢复) */
        if (!(await isCurrent(e.group_id, e.user_id, lockName))) {
            return false
        }
        /* 状态锁复查: 洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态下禁止用数字打造/合成 */
        if (await guardActionLocked(e)) return true
        const n = parseInt(String(e.msg || '').replace(/\D/g, ''), 10)
        const idx = n - 1
        if (isNaN(n) || idx < 0 || idx >= pc.list.length) {
            e.reply(`请输入 1~${pc.list.length} 之间的数字`)
            return true
        }
        const name = pc.list[idx].name
        delete pendingCraftColor[e.user_id]
        await unlock(e.group_id, e.user_id, lockName)
        if (pc.type === 'rainbow') {
            const r = craftRainbow(e.user_id, e.group_id, name)
            e.reply(r.msg)
        } else {
            return this.doCraftColor(e, getBag(e.user_id, e.group_id), name)
        }
        return true
    }

    /** #铸造特殊彩武[序号] 或 #铸造特殊彩武 [红武器名]: 6云裳仙蕊 + 1红武器 → 成长型绑定彩虹武器。
     *  按列表序号直接选(如 #铸造特殊彩武2); 不带序号弹出带序号的列表(1把也弹)。 */
    async craftRainbow(e) {
        const m = String(e.msg || '').match(/(铸造特殊彩武|打造特殊彩武|合成特殊彩武|特殊彩武)(?:\s*(\d+)|\s+(\S+))?\s*$/)
        const wantNum = m && m[2] ? parseInt(m[2], 10) : null
        const redName = m && m[3] ? m[3].trim() : ''
        const id = e.user_id
        const gid = e.group_id
        const bag = getBag(id, gid)
        const herbIt = bag.items && bag.items['云裳仙蕊']
        const haveHerb = herbIt ? (Number(herbIt.count) || 0) : 0
        if (haveHerb < 6) {
            e.reply(`铸造彩武需要 ${QUALITY[7].icon}云裳仙蕊×6（你只有 ${haveHerb} 个），先去虚境秘境收集吧~`)
            return true
        }
        const owned = ownedRedWeapons(bag)
        if (!owned.length) {
            e.reply('铸造彩武还需要 1 件红色武器（🔴霓裳剑/朱雀扇），去虚境秘境或拍卖行获取吧~')
            return true
        }
        const list = owned.map((name, i) => {
            const isEq = bag.equipped && bag.equipped.weapon === name
            const attr = isEq
                ? (bag.equippedAttr && bag.equippedAttr.weapon) || getItemAttr(bag, name)
                : getItemAttr(bag, name)
            return { name, label: `${QUALITY[6].icon}${name}${isEq ? '（已装备）' : ''}（${fmtAttr(attr)}）` }
        })
        const doCraft = red => {
            const r = craftRainbow(id, gid, red)
            e.reply(r.msg)
            return true
        }
        /* 按序号直接选 */
        if (wantNum) {
            if (wantNum < 1 || wantNum > list.length) {
                e.reply(`序号超出范围，可用红武器：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
                return true
            }
            return doCraft(list[wantNum - 1].name)
        }
        /* 按名称直接选 */
        if (redName) {
            const exact = list.filter(x => x.name === redName)
            const partial = !exact.length ? list.filter(x => x.name.includes(redName)) : []
            if (exact.length === 1) return doCraft(exact[0].name)
            if (partial.length === 1) return doCraft(partial[0].name)
            e.reply(`背包里找不到红武器「${redName}」，可用红武器：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
            return true
        }
        /* 不带序号/名称: 弹列表选择(1把也弹) */
        await forceLock(e.group_id, id, 'craft-rainbow')
        pendingCraftColor[id] = { type: 'rainbow', list, time: Date.now() }
        e.reply(`请发送数字选择要用哪一把红武器铸造彩武（消耗该红武器×1 + ${QUALITY[7].icon}云裳仙蕊×6）：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
        return true
    }

    /** #彩武命名 <名字>: 给彩虹武器改名(最多8字) */
    async nameRainbow(e) {
        const m = String(e.msg || '').match(/彩武命名\s*(\S*)/)
        const name = (m && m[1]) ? m[1].trim() : ''
        const r = renameRainbow(e.user_id, e.group_id, name)
        e.reply(r.msg)
        return true
    }

    /** #我的彩武: 查看成长型彩虹武器信息 */
    async rainbowInfo(e) {
        const bag = getBag(e.user_id, e.group_id)
        e.reply(rainbowInfoLines(bag).join('\n'))
        return true
    }
}