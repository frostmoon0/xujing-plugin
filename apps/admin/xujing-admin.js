import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import fs from "fs";
import chalk from "chalk"
import schedule from "node-schedule";
import { Plugin_Name, Save_Path } from '../../components/plugin.js'
import xujing_data from '../../components/xujing_data.js'
import { addItem, consumeItem, EQUIP_TPL, ITEM_TPL, MATERIAL_TPL, getBag, itemIcon } from '../../components/equip_data.js'
import { getLevelName } from '../user/duel_exercise.js'
import { REALM_MAX_LEVEL, XIANDI_MAX_CHONG } from '../../components/realm_cap.js'
import { delJail, allJails } from '../../components/raid_data.js'
//项目路径
//如果报错请删除Yunzai/data/目录中xujing文件夹
const dirpath = `${Save_Path}/`;//文件夹路径(Yunzai本体data目录)
var filename = `battle`;//文件名
if (filename.indexOf(".json") == -1) {//如果文件名不包含.json
	filename = filename + ".json";//添加.json
}
let Template = {//创建该用户
    "experience": 0,
    "level": 0,
    "levelname": '无灵力',
    "Privilege": 0,
};

/** 解析数量(防呆): 全角数字转半角, 提取第一组数字(支持千分位逗号/带单位), 无效或<=0返回0 */
function parseCount(str) {
    if (str == null) return 0
    const s = String(str).replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    const m = s.match(/-?\d[\d,]*/)
    if (!m) return 0
    const n = Math.floor(Number(m[0].replace(/,/g, '')))
    return Number.isFinite(n) && n > 0 ? n : 0
}

/** 解析 虚境道具/扣除道具 参数: 支持 "灵宝盒 100"(空格) 与 "灵宝盒100"(粘连) 两种写法 */
function parseItemInput(msg) {
    const allNames = [...Object.keys(ITEM_TPL), ...Object.keys(MATERIAL_TPL), ...Object.keys(EQUIP_TPL)].sort((a, b) => b.length - a.length)
    const parts = msg.split(/\s+/)
    // 空格分隔: 第一段即道具名
    if (parts[0] && (EQUIP_TPL[parts[0]] || ITEM_TPL[parts[0]] || MATERIAL_TPL[parts[0]])) {
        return { name: parts[0], count: parseCount(parts[1]) || 1 }
    }
    // 粘连写法: 道具名后直接跟数量(如 灵宝盒100), 按道具名最长前缀匹配
    const matched = allNames.find(n => n && msg.startsWith(n))
    if (matched) {
        const rest = msg.slice(matched.length).trim()
        return { name: matched, count: parseCount(rest) || 1 }
    }
    return { name: parts[0] || '', count: 1 }
}
//配置一些有意思的参数
export class duel_setmaster extends plugin {//设置开挂
	constructor() {
		super({
			/** 功能名称 */
			name: '虚境管理',
			/** 功能描述 */
			dsc: '',
			event: 'message',
			/** 优先级，数字越小等级越高 */
			priority: 1000,
			rule: [
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(设置|回收)权能$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'master',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?道具.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveItem',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?一键虚境(给)?道具.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveItemAll',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?灵力.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveExp',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?修为.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveLevel',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除道具.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductItem',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除灵力.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductExp',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除修为.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductLevel',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?灵石.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveMoney',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除灵石.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductMoney',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?好感.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveLove',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除好感.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductLove',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?房子.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveHouse',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除房子.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductHouse',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?双修.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveShuangxiu',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除双修.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductShuangxiu',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境(给)?挂机.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'giveAfk',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境扣除挂机.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'deductAfk',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境查看.*$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'viewInfo',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境拉黑列表$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'blacklistList',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?虚境拉黑(@.*)?$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'blacklistAdd',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?(取消|解除|移除)(虚境)?拉黑(@.*)?$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'blacklistDel',
					/** 权限:仅主人可用 */
					auth: 'master',
				},
				{
					/** 命令正则匹配 */
					reg: "^[#＃]?一键释放(所有人|全部)?(@.*)?$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'freeJail',
					/** 权限:仅主人可用 */
					auth: 'master',
				}
			]
		})
	}
	/**
	 * 
	 */
	//e.msg 用户的命令消息
	async master(e) {
		console.log("用户命令：", e.msg);
		if (!e.group.is_admin) { //检查是否为管理员
			e.reply('我不是群管理员，不能设置开挂啦~');
			return true;
		}
		if (!e.at) {
			e.reply('不知道你要设置谁为开挂哦~');
			return true;
		}
		if (!e.isMaster) {
			e.group.muteMember(e.user_id, 60);
			e.reply([segment.at(e.user_id), `\n凡人，休得僭越！`]);
			return true
		}
		let user_id2 = e.at; //获取当前at的那个人
		let user_id2_nickname = null
		for (let msg of e.message) { //赋值给user_id2_nickname
			if (msg.type === 'at') {
				user_id2_nickname = msg.text//获取at的那个人的昵称
				break;
			}
		}
		const json = await xujing_data.getQQYUserBattle(user_id2, null, false, `${e.group_id}.json`)
		if (!json.hasOwnProperty(user_id2)) {//如果json中不存在该用户
			json[user_id2] = Template
		}
		if (e.msg.includes("设置")) {
			json[user_id2].Privilege = 1
			await xujing_data.getQQYUserBattle(user_id2, json, true, `${e.group_id}.json`)
			logger.info(chalk.green(`${user_id2}被赋予权能`)); //输出日志
			e.reply([segment.at(e.user_id),
			`设置权能成功\n🎉恭喜${user_id2_nickname}成为特权者`]);//发送消息
			return true; //返回true 阻挡消息不再往下}
		} else {
			json[user_id2].Privilege = 0
			await xujing_data.getQQYUserBattle(user_id2, json, true, `${e.group_id}.json`)
			logger.info(chalk.gray(`${user_id2}被移除权能`)); //输出日志
			e.reply([segment.at(e.user_id),
			`移除权能成功\n${user_id2_nickname}权能已被收回`]);//发送消息
			return true; //返回true 阻挡消息不再往下
		}
	}
	/**
	 * #一键释放所有人 / #一键释放 @某人: 结束天牢状态
	 *  - @某人: 只释放被@的用户
	 *  - 不带@: 释放全部在牢用户
	 */
	async freeJail(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		// @某人 → 只释放该用户
		if (e.at) {
			await delJail(e.at)
			e.reply([segment.at(e.user_id), `\n✅ 已释放 ${e.at}，天牢状态已解除！`])
			return true
		}
		// 不带@ → 释放全部
		const list = await allJails()
		if (!list.length) {
			e.reply('当前没有人在天牢中~')
			return true
		}
		for (const it of list) await delJail(it.uid)
		e.reply([segment.at(e.user_id), `\n✅ 已一键释放全部 ${list.length} 人，天牢状态已清空！`])
		return true
	}
	/** 取消息纯文本(去掉at等段) */
	getText(e) {
		return (e.message || []).filter(m => m.type === 'text').map(m => m.text).join('').trim()
	}
	/** #虚境道具 @群友 道具名 数量 */
	async giveItem(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放道具的群友，如：#虚境道具 @群友 修为丹 10')
			return true
		}
		const msg = this.getText(e).replace(/^[#＃]?\s*虚境(给)?道具/, '').trim()
		const { name, count } = parseItemInput(msg)
		if (!name) {
			e.reply('请指定道具名，如：#虚境道具 @群友 修为丹 10')
			return true
		}
		if (!EQUIP_TPL[name] && !ITEM_TPL[name] && !MATERIAL_TPL[name]) {
			const all = [...Object.keys(ITEM_TPL), ...Object.keys(MATERIAL_TPL), ...Object.keys(EQUIP_TPL)].join('、')
			e.reply(`没有这个道具哦~ 可发放：${all}`)
			return true
		}
		const ret = addItem(e.at, name, count, null, e.group_id)
		if (!ret) {
			e.reply('发放失败，请检查道具名~')
			return true
		}
		const icon = itemIcon(name)
		e.reply([segment.at(e.user_id), `\n✅ 已向 ${e.at} 发放 ${icon}${name} ×${count}`])
		return true
	}
	/** #一键虚境道具 道具名 数量: 给当前群全部玩家发放道具(排除系统账号0) */
	async giveItemAll(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		const msg = this.getText(e).replace(/^[#＃]?\s*一键虚境(给)?道具/, '').trim()
		const { name, count } = parseItemInput(msg)
		if (!name) {
			e.reply('请指定道具名，如：#一键虚境道具 修为丹 10')
			return true
		}
		if (!EQUIP_TPL[name] && !ITEM_TPL[name] && !MATERIAL_TPL[name]) {
			const all = [...Object.keys(ITEM_TPL), ...Object.keys(MATERIAL_TPL), ...Object.keys(EQUIP_TPL)].join('、')
			e.reply(`没有这个道具哦~ 可发放：${all}`)
			return true
		}
		// 当前群所有真实玩家(排除系统账号0)
		const battlejson = await xujing_data.getQQYUserBattle('0', null, false, `${e.group_id}.json`)
		const uids = Object.keys(battlejson).filter(k => k !== '0')
		if (!uids.length) {
			e.reply('当前群还没有玩家~')
			return true
		}
		let ok = 0
		for (const uid of uids) {
			if (addItem(uid, name, count, null, e.group_id)) ok++
		}
		const icon = itemIcon(name)
		e.reply([segment.at(e.user_id), `\n✅ 已向本群全部 ${ok}/${uids.length} 名玩家发放 ${icon}${name} ×${count}`])
		return true
	}
	/** #虚境灵力 @群友 数量 */
	async giveExp(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放灵力的群友，如：#虚境灵力 @群友 500')
			return true
		}
		const exp = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境(给)?灵力/, ''))
		if (!exp) {
			e.reply('请输入灵力数量，如：#虚境灵力 @群友 500')
			return true
		}
		const json = await xujing_data.getQQYUserBattle(e.at, null, false, `${e.group_id}.json`)
		json[e.at].experience = (Number(json[e.at].experience) || 0) + exp
		await xujing_data.getQQYUserBattle(e.at, json, true, `${e.group_id}.json`)
		e.reply([segment.at(e.user_id), `\n✅ 已向 ${e.at} 发放 ${exp} 点灵力（当前灵力：${json[e.at].experience}）`])
		return true
	}
	/** #虚境修为 @群友 等级数 */
	async giveLevel(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放修为的群友，如：#虚境修为 @群友 3')
			return true
		}
		const lv = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境(给)?修为/, ''))
		if (!lv) {
			e.reply('请输入修为等级数，如：#虚境修为 @群友 3')
			return true
		}
		const json = await xujing_data.getQQYUserBattle(e.at, null, false, `${e.group_id}.json`)
		const before = Number(json[e.at].level) || 0
		const target = Math.min(REALM_MAX_LEVEL, before + lv)
		const added = target - before
		json[e.at].level = target
		json[e.at].levelname = getLevelName(target)
		await xujing_data.getQQYUserBattle(e.at, json, true, `${e.group_id}.json`)
		e.reply([segment.at(e.user_id), `\n✅ 已为 ${e.at} 提升 ${added} 级修为（当前境界：${json[e.at].levelname}）${added < lv ? `\n⚠️ 此界境界上限为仙帝第${XIANDI_MAX_CHONG}重，剩余 ${lv - added} 级未生效` : ''}`])
		return true
	}
	/** #虚境扣除道具 @群友 道具名 数量 */
	async deductItem(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除道具的群友，如：#虚境扣除道具 @群友 修为丹 10')
			return true
		}
		const msg = this.getText(e).replace(/^[#＃]?\s*虚境扣除道具/, '').trim()
		const { name, count } = parseItemInput(msg)
		if (!name) {
			e.reply('请指定道具名，如：#虚境扣除道具 @群友 修为丹 10')
			return true
		}
		if (!EQUIP_TPL[name] && !ITEM_TPL[name] && !MATERIAL_TPL[name]) {
			const all = [...Object.keys(ITEM_TPL), ...Object.keys(MATERIAL_TPL), ...Object.keys(EQUIP_TPL)].join('、')
			e.reply(`没有这个道具哦~ 可扣除：${all}`)
			return true
		}
		if (!consumeItem(e.at, name, count, null, e.group_id)) {
			e.reply('扣除失败，对方背包里没有足够的该道具~')
			return true
		}
		const icon = itemIcon(name)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除 ${icon}${name} ×${count}`])
		return true
	}
	/** #虚境扣除灵力 @群友 数量 */
	async deductExp(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除灵力的群友，如：#虚境扣除灵力 @群友 500')
			return true
		}
		const exp = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境扣除灵力/, ''))
		if (!exp) {
			e.reply('请输入灵力数量，如：#虚境扣除灵力 @群友 500')
			return true
		}
		const json = await xujing_data.getQQYUserBattle(e.at, null, false, `${e.group_id}.json`)
		const cur = Number(json[e.at].experience) || 0
		if (cur <= 0) {
			e.reply('对方当前没有灵力可扣除~')
			return true
		}
		const deduct = Math.min(exp, cur)
		json[e.at].experience = cur - deduct
		await xujing_data.getQQYUserBattle(e.at, json, true, `${e.group_id}.json`)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除 ${deduct} 点灵力${deduct < exp ? `（灵力不足，实际扣除${deduct}）` : ''}（当前灵力：${json[e.at].experience}）`])
		return true
	}
	/** #虚境扣除修为 @群友 等级数 */
	async deductLevel(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除修为的群友，如：#虚境扣除修为 @群友 3')
			return true
		}
		const lv = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境扣除修为/, ''))
		if (!lv) {
			e.reply('请输入修为等级数，如：#虚境扣除修为 @群友 3')
			return true
		}
		const json = await xujing_data.getQQYUserBattle(e.at, null, false, `${e.group_id}.json`)
		const cur = Number(json[e.at].level) || 0
		if (cur <= 0) {
			e.reply('对方当前没有修为等级可扣除~')
			return true
		}
		const deduct = Math.min(lv, cur)
		json[e.at].level = cur - deduct
		json[e.at].levelname = getLevelName(json[e.at].level)
		await xujing_data.getQQYUserBattle(e.at, json, true, `${e.group_id}.json`)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除 ${deduct} 级修为${deduct < lv ? `（修为不足，实际扣除${deduct}级）` : ''}（当前境界：${json[e.at].levelname}）`])
		return true
	}
	/** #虚境金币 @群友 数量 */
	async giveMoney(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放灵石的群友，如：#虚境金币 @群友 10000')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境(扣除)?金币/, ''))
		if (!amount) {
			e.reply('请输入灵石数量，如：#虚境金币 @群友 10000')
			return true
		}
		const filename = `${e.group_id}.json`
		const homejson = await xujing_data.getQQYUserHome(e.at, null, filename, false)
		homejson[e.at].money = (Number(homejson[e.at].money) || 0) + amount
		await xujing_data.getQQYUserHome(e.at, homejson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已向 ${e.at} 发放 ${amount} 灵石（当前灵石：${homejson[e.at].money}）`])
		return true
	}
	/** #虚境扣除金币 @群友 数量 */
	async deductMoney(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除灵石的群友，如：#虚境扣除金币 @群友 10000')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境扣除金币/, ''))
		if (!amount) {
			e.reply('请输入灵石数量，如：#虚境扣除金币 @群友 10000')
			return true
		}
		const filename = `${e.group_id}.json`
		const homejson = await xujing_data.getQQYUserHome(e.at, null, filename, false)
		const cur = Number(homejson[e.at].money) || 0
		if (cur <= 0) {
			e.reply('对方当前没有灵石可扣除~')
			return true
		}
		const deduct = Math.min(amount, cur)
		homejson[e.at].money = cur - deduct
		await xujing_data.getQQYUserHome(e.at, homejson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除 ${deduct} 灵石${deduct < amount ? `（灵石不足，实际扣除${deduct}）` : ''}（当前灵石：${homejson[e.at].money}）`])
		return true
	}
	/** #虚境好感 @群友 数量 */
	async giveLove(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放好感的群友，如：#虚境好感 @群友 100')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境(扣除)?好感/, ''))
		if (!amount) {
			e.reply('请输入好感数量，如：#虚境好感 @群友 100')
			return true
		}
		const filename = `${e.group_id}.json`
		const homejson = await xujing_data.getQQYUserHome(e.at, null, filename, false)
		homejson[e.at].love = (Number(homejson[e.at].love) || 0) + amount
		await xujing_data.getQQYUserHome(e.at, homejson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已向 ${e.at} 发放 ${amount} 点好感（当前好感：${homejson[e.at].love}）`])
		return true
	}
	/** #虚境扣除好感 @群友 数量 */
	async deductLove(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除好感的群友，如：#虚境扣除好感 @群友 100')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境扣除好感/, ''))
		if (!amount) {
			e.reply('请输入好感数量，如：#虚境扣除好感 @群友 100')
			return true
		}
		const filename = `${e.group_id}.json`
		const homejson = await xujing_data.getQQYUserHome(e.at, null, filename, false)
		const cur = Number(homejson[e.at].love) || 0
		if (cur <= 0) {
			e.reply('对方当前没有好感可扣除~')
			return true
		}
		const deduct = Math.min(amount, cur)
		homejson[e.at].love = cur - deduct
		await xujing_data.getQQYUserHome(e.at, homejson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除 ${deduct} 点好感${deduct < amount ? `（好感不足，实际扣除${deduct}）` : ''}（当前好感：${homejson[e.at].love}）`])
		return true
	}
	/** 读取房子配置 */
	loadHouses() {
		try {
			return JSON.parse(fs.readFileSync(`plugins/${Plugin_Name}/resources/qylp/house.json`, 'utf8'))
		} catch (err) {
			console.log('读取房子配置失败:', err.message)
			return {}
		}
	}
	/** 设置某人为指定等级的房子 */
	async setHouseLevel(e, uid, lv) {
		const houses = this.loadHouses()
		const tpl = houses[lv]
		if (!tpl) return null
		const filename = `${e.group_id}.json`
		const housejson = await xujing_data.getQQYUserHouse(uid, null, filename, false)
		housejson[uid].name = tpl.name
		housejson[uid].space = tpl.space
		housejson[uid].price = tpl.price
		housejson[uid].loveup = tpl.loveup
		housejson[uid].work = tpl.work
		housejson[uid].hug = tpl.hug
		housejson[uid].cultivate = tpl.cultivate
		await xujing_data.getQQYUserHouse(uid, housejson, filename, true)
		return tpl
	}
	/** #虚境房子 @群友 等级 */
	async giveHouse(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放房子的群友，如：#虚境房子 @群友 3')
			return true
		}
		const lv = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境(扣除)?房子/, ''))
		if (!lv || lv > 8) {
			e.reply('请输入房子等级(1~8)，如：#虚境房子 @群友 3')
			return true
		}
		const tpl = await this.setHouseLevel(e, e.at, lv)
		if (!tpl) {
			e.reply('房子等级无效~')
			return true
		}
		e.reply([segment.at(e.user_id), `\n✅ 已为 ${e.at} 发放 Lv.${lv} ${tpl.name}（可居住${Number(tpl.space) === -1 ? '无上限' : tpl.space + '人'} 好感×${tpl.loveup} 挂机/摆摊+${tpl.work}% 抱抱+${tpl.hug}% 修炼+${tpl.cultivate}%）`])
		return true
	}
	/** #虚境扣除房子 @群友 等级 */
	async deductHouse(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除房子的群友，如：#虚境扣除房子 @群友 2')
			return true
		}
		const lv = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境扣除房子/, ''))
		if (!lv) {
			e.reply('请输入要降级的数量，如：#虚境扣除房子 @群友 2')
			return true
		}
		const filename = `${e.group_id}.json`
		const housejson = await xujing_data.getQQYUserHouse(e.at, null, filename, false)
		const houses = this.loadHouses()
		let curLevel = 0
		for (const k of Object.keys(houses)) {
			if (houses[k].name === housejson[e.at].name) {
				curLevel = Number(k)
				break
			}
		}
		if (!curLevel) {
			e.reply('对方当前房子无法识别等级（小破屋或自定义名），无法扣除~')
			return true
		}
		const target = Math.max(1, curLevel - lv)
		const tpl = await this.setHouseLevel(e, e.at, target)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除 ${curLevel - target} 级房子（→ Lv.${target} ${tpl.name}）`])
		return true
	}
	/** #虚境双修 @群友 数量 */
	async giveShuangxiu(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放双修次数的群友，如：#虚境双修 @群友 10')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境(扣除)?双修/, ''))
		if (!amount) {
			e.reply('请输入双修次数，如：#虚境双修 @群友 10')
			return true
		}
		const filename = `${e.group_id}.json`
		const inpajson = await xujing_data.getQQYUserxiaoqie(e.at, null, filename, false)
		inpajson[e.at].shuangxiu_time = (Number(inpajson[e.at].shuangxiu_time) || 0) + amount
		await xujing_data.getQQYUserxiaoqie(e.at, inpajson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已向 ${e.at} 发放 ${amount} 次双修（当前：${inpajson[e.at].shuangxiu_time}次）`])
		return true
	}
	/** #虚境扣除双修 @群友 数量 */
	async deductShuangxiu(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除双修次数的群友，如：#虚境扣除双修 @群友 10')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境扣除双修/, ''))
		if (!amount) {
			e.reply('请输入双修次数，如：#虚境扣除双修 @群友 10')
			return true
		}
		const filename = `${e.group_id}.json`
		const inpajson = await xujing_data.getQQYUserxiaoqie(e.at, null, filename, false)
		const cur = Number(inpajson[e.at].shuangxiu_time) || 0
		if (cur <= 0) {
			e.reply('对方当前没有双修次数可扣除~')
			return true
		}
		const deduct = Math.min(amount, cur)
		inpajson[e.at].shuangxiu_time = cur - deduct
		await xujing_data.getQQYUserxiaoqie(e.at, inpajson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除 ${deduct} 次双修${deduct < amount ? `（不足，实际扣除${deduct}）` : ''}（当前：${inpajson[e.at].shuangxiu_time}次）`])
		return true
	}
	/** #虚境挂机 @群友 数量(挂机收益以灵石形式发放) */
	async giveAfk(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要发放挂机收益的群友，如：#虚境挂机 @群友 1000')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境(扣除)?挂机/, ''))
		if (!amount) {
			e.reply('请输入挂机收益(灵石)，如：#虚境挂机 @群友 1000')
			return true
		}
		const filename = `${e.group_id}.json`
		const homejson = await xujing_data.getQQYUserHome(e.at, null, filename, false)
		homejson[e.at].money = (Number(homejson[e.at].money) || 0) + amount
		await xujing_data.getQQYUserHome(e.at, homejson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已向 ${e.at} 发放挂机收益 ${amount} 灵石（当前灵石：${homejson[e.at].money}）`])
		return true
	}
	/** #虚境扣除挂机 @群友 数量 */
	async deductAfk(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要扣除挂机收益的群友，如：#虚境扣除挂机 @群友 1000')
			return true
		}
		const amount = parseCount(this.getText(e).replace(/^[#＃]?\s*虚境扣除挂机/, ''))
		if (!amount) {
			e.reply('请输入挂机收益(灵石)，如：#虚境扣除挂机 @群友 1000')
			return true
		}
		const filename = `${e.group_id}.json`
		const homejson = await xujing_data.getQQYUserHome(e.at, null, filename, false)
		const cur = Number(homejson[e.at].money) || 0
		if (cur <= 0) {
			e.reply('对方当前没有灵石可扣除~')
			return true
		}
		const deduct = Math.min(amount, cur)
		homejson[e.at].money = cur - deduct
		await xujing_data.getQQYUserHome(e.at, homejson, filename, true)
		e.reply([segment.at(e.user_id), `\n✅ 已从 ${e.at} 扣除挂机收益 ${deduct} 灵石${deduct < amount ? `（不足，实际扣除${deduct}）` : ''}（当前灵石：${homejson[e.at].money}）`])
		return true
	}
	/** #虚境拉黑 @某人: 拉黑屏蔽其指令(防开小号刷屏) */
	async blacklistAdd(e) {
		if (!e.at) {
			e.reply('请@要拉黑的人，如：#虚境拉黑 @某人')
			return true
		}
		const ok = await xujing_data.addBlacklist(e.at)
		e.reply(ok ? `已拉黑 ${e.at}，其指令将被屏蔽~` : `${e.at} 已在拉黑名单中`)
		return true
	}
	/** #虚境取消拉黑 @某人 */
	async blacklistDel(e) {
		if (!e.at) {
			e.reply('请@要解除拉黑的人，如：#虚境取消拉黑 @某人')
			return true
		}
		const ok = await xujing_data.removeBlacklist(e.at)
		e.reply(ok ? `已解除拉黑 ${e.at}` : `${e.at} 不在拉黑名单中`)
		return true
	}
	/** #虚境拉黑列表 */
	async blacklistList(e) {
		const list = await xujing_data.getBlacklist()
		if (!list.length) {
			e.reply('拉黑名单为空~')
			return true
		}
		e.reply(`🔨 虚境拉黑名单（${list.length}人）：\n${list.join('\n')}`)
		return true
	}
	/** #虚境查看 @群友: 查看某人全部数值 */
	async viewInfo(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越！')
			return true
		}
		if (!e.at) {
			e.reply('请@要查看的群友，如：#虚境查看 @群友')
			return true
		}
		const uid = e.at
		const filename = `${e.group_id}.json`
		const battlejson = await xujing_data.getQQYUserBattle(uid, null, false, filename)
		const homejson = await xujing_data.getQQYUserHome(uid, null, filename, false)
		const housejson = await xujing_data.getQQYUserHouse(uid, null, filename, false)
		const inpajson = await xujing_data.getQQYUserxiaoqie(uid, null, filename, false)
		const bag = getBag(uid, e.group_id)
		const items = bag.items || {}
		const equipped = bag.equipped || {}
		const bagList = Object.keys(items).map(n => `${itemIcon(n)}${n}×${items[n].count}`)
		const equips = Object.values(equipped).filter(Boolean)
		e.reply([
			segment.at(e.user_id), "\n",
			`━━━ 📊 ${uid} 数据 ━━━\n`,
			`【境界】${battlejson[uid].levelname}\n`,
			`灵力：${battlejson[uid].experience}${(battlejson[uid].accum || 0) > 0 ? `（累积+${battlejson[uid].accum}）` : ''}\n`,
			`【灵石】${homejson[uid].money}\n`,
			`【好感】${homejson[uid].love}\n`,
			`【房子】${housejson[uid].name}（容量${housejson[uid].space}）\n`,
			`好感×${housejson[uid].loveup} 挂机/摆摊+${housejson[uid].work}% 抱抱+${housejson[uid].hug}% 修炼+${housejson[uid].cultivate}%\n`,
			`【双修】${inpajson[uid].shuangxiu_time || 0} 次\n`,
			`【装备】${equips.length ? equips.join('、') : '无'}\n`,
			`【背包】${bagList.length ? bagList.join('、') : '空'}\n`,
			`【权能】${battlejson[uid].Privilege == 1 ? '特权者' : '普通'}`
		])
		return true
	}
}