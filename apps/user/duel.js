import { wearPlayerTaichu, taichuBattleReceipt } from '../../components/taichu_combat.js'
import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import fs from "fs";
import command from '../../components/command.js'
import xujing_data from '../../components/xujing_data.js'
import { Plugin_Name } from '../../components/plugin.js'
import { fightWinRate, fightBestOf5, buildFightRecord, makeDamageFn, getBuffs } from '../../components/fight.js'
import { textToImg } from '../../components/common-lib/reply-img.js'
import { logPlayerEvent, getNick } from '../../components/fake_data.js'
//项目路径
let duelCD = {};
//如果报错请删除Yunzai本体 data/xujing-yue-plugin/save 目录中文件battle.json
var Template = {//创建该用户
	"experience": 0,
	"accum": 0,
	"level": 0,
	"levelname": '无灵力',
	"Privilege": 0,
};
let Magnification = await command.getConfig("duel_cfg", "Magnification");
let Cooling_time = await command.getConfig("duel_cfg", "Cooling_time");

export class duel extends plugin {//决斗
	constructor() {
		super({
			/** 功能名称 */
			name: '决斗',
			/** 功能描述 */
			dsc: '',
			event: 'message',
			/** 优先级，数字越小等级越高 */
			priority: 1000,
			rule: [
				{
					/** 命令正则匹配 */
					reg: '^[#＃]?(决斗)', //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'duel'
				},
				{
					/** 命令正则匹配 */
					reg: "^#*(设置)战斗力意义系数(.*)$", //匹配消息正则，命令正则
					/** 执行方法 */
					fnc: 'Magnification_',
					/** 权限:仅主人可用 */
					auth: 'master'
				}
			]
		})
	}
	/**
	 * 
	 */
	//e.msg 用户的命令消息
	async Magnification_(e) {
		if (!e.isMaster) {
			e.reply('凡人，休得僭越!')
			return
		}
		let msg = e.msg.replace(/设置|战斗力意义系数|#/g, "").trim()
		const val = Number(msg)
		if (!Number.isFinite(val) || val < 1 || val > 50) {
			e.reply(`请输入 1~50 之间的数值，例如：#设置战斗力意义系数 8`)
			return
		}
		Magnification = val
		e.reply(`战斗力意义系数设置成功：${val}（每个小境界/装备加成影响${val}%胜率）`)
		return
	}
	/**
	 * 
	 */
	//e.msg 用户的命令消息
	async duel(e) {
		console.log("用户命令：", e.msg);
		let user_id = e.user_id;
		let user_id2 = e.at; //获取当前at的那个人
		if (!e.at && !e.atme) {//没有@的人
			e.reply('不知道你要与谁决斗哦，请@你想决斗的人~');
			return true;
		}
		//--------------------------------------------------- 存档按群后统一走数据层读取本群修为
		const json = await xujing_data.getQQYUserBattle(user_id, null, false, `${e.group_id}.json`)
		if (!json.hasOwnProperty(user_id2)) {//如果json中不存在该用户
			json[user_id2] = { ...Template }//浅拷贝,避免共享同一对象引用
		}
		//一律五局三胜,管理员不加成(一视同仁)
		let level = json[user_id].level
		let level2 = json[user_id2].level
		if (user_id == user_id2) { //判定是否为提出者
			if (e.sender.role == "owner" || e.sender.role == "admin") {
				e.reply(`请不要这样，我也很难的啦！`)
			}
			try { e.group.muteMember(e.user_id, 60) } catch (err) { console.log('禁言失败:', err.message) }
			e.reply([segment.at(e.user_id), `\n...好吧，成全你`]);
			return true;
		}//判定是否为Bot
		if (e.atme) {//@的人是bot
			if (e.sender.role == "owner" || e.sender.role == "admin") {
				e.reply(`请不要这样，我也很难的啦！`)
			}
			try { e.group.muteMember(e.user_id, 60) } catch (err) { console.log('禁言失败:', err.message) }
			e.reply([segment.at(e.user_id), `\n你什么意思？举办了`]);
			return true
		}
		if (duelCD[e.user_id]) { //判定是否在冷却中
			e.reply(`你刚刚发起了一场决斗，请耐心一点，等待${Cooling_time}秒后再次决斗吧！`);
			return true;
		}
		let user_id2_nickname = null
		for (let msg of e.message) { //赋值给user_id2_nickname
			if (msg.type === 'at') {
				user_id2_nickname = msg.text//获取at的那个人的昵称
				break;
			}
		}
		//每天对同一人赢满2次就不能再发起决斗(防止一直欺负同一个人,输了不计入,按天自动清零)
		const now = new Date()
		const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
		const dkey = `xujing:duel-daily:${user_id}:${user_id2}:${dateKey}`
		const winCnt = Number(await redis.get(dkey)) || 0
		if (winCnt >= 2) {
			e.reply(`今天你已赢过 ${user_id2_nickname || '对方'} ${winCnt} 次啦，适可而止，明天再来吧~`)
			return true
		}
		duelCD[user_id] = true;
		duelCD[user_id] = setTimeout(() => {//冷却时间
			if (duelCD[user_id]) {
				delete duelCD[user_id];
			}
		}, Cooling_time * 1000);
		//计算实时经验的影响,等级在1-13级之间
		//  随机加成部分    +      等级加成部分 
		if (!level)
			level = 0
		if (!level2)
			level2 = 0

		const myNick = (e.sender && (e.sender.card || e.sender.nickname)) || '你'
		if (!user_id2_nickname) user_id2_nickname = '对方'
		//攻击/防御/生命/暴击/爆伤增益(惊鸿丹/霓裳丹/芙蓉丹/明眸丹/倾城丹)
		const myBuffs = await getBuffs(user_id, e.group_id)
		const oppBuffs = await getBuffs(user_id2, e.group_id)
		//五局三胜:单局胜率与装备等效
		const { win, myEquip, oppEquip } = fightWinRate(level, level2, user_id, user_id2, Magnification, myBuffs, oppBuffs, e.group_id)
		let random_time = Math.round(Math.random() * 2) + 1//禁言时间
		let random_time2 = Math.round(Math.random() * 4) + 1//禁言时间
		//双方每回合伤害(与幻境试炼同一套战力/伤害体系)
		const myDmg = makeDamageFn(level, user_id, 0.15, myBuffs, e.group_id)
		const oppDmg = makeDamageFn(level2, user_id2, 0.15, oppBuffs, e.group_id)

		//一律五局三胜,管理员不加成(没有禁言系统的群也照常决斗)
		const result = fightBestOf5(win, { dmgMe: myDmg, dmgOpp: oppDmg, defMe: myBuffs.def })
        const wearReceipt = taichuBattleReceipt(e, 'duel')
        wearPlayerTaichu(e.group_id, user_id, wearReceipt)
        wearPlayerTaichu(e.group_id, user_id2, wearReceipt)
		const canMute = !!(e.group && e.group.is_admin && typeof e.group.muteMember === 'function')
		//越阶击败(爆冷)写入天下大事
		try {
			if (result.winner === 'me' && level < level2) {
				const wNick = await getNick(e.group_id, user_id)
				const lNick = await getNick(e.group_id, user_id2)
				logPlayerEvent(e.group_id, `【论剑】散修 ${wNick} 越阶击败散修 ${lNick}，一战成名！`)
			} else if (result.winner === 'opp' && level2 < level) {
				const wNick = await getNick(e.group_id, user_id2)
				const lNick = await getNick(e.group_id, user_id)
				logPlayerEvent(e.group_id, `【论剑】散修 ${wNick} 越阶击败散修 ${lNick}，一战成名！`)
			}
		} catch (err) { }

		//构建战斗合并转发记录
		const msgs = buildFightRecord({
			myName: myNick,
			oppName: user_id2_nickname,
			myId: user_id,
			oppId: user_id2,
			myLevel: json[user_id].levelname,
			oppLevel: json[user_id2].levelname,
			myEquip,
			oppEquip,
			win,
			result,
			extra: '',
			footer: result.winner === 'me'
				? `${user_id2_nickname}接受惩罚，${canMute ? `已被禁言${random_time}分钟！` : '本群无禁言能力，免除禁言！'}`
				: `你接受惩罚，${canMute ? `已被禁言${random_time2}分钟！` : '本群无禁言能力，免除禁言！'}`
		})

		//战斗记录合并渲染成一张图片(替代合并转发)
		const fightText = msgs.map(n => String((n && n.message) || '')).filter(Boolean).join('\n\n')
		const img = await textToImg(fightText)

		//延迟3秒:禁言败者(有禁言能力的群才执行) + 发送战斗记录
		setTimeout(async () => {
			if (canMute) {
				try {
					if (result.winner === 'me') {
						e.group.muteMember(user_id2, random_time * 60)
					} else {
						e.group.muteMember(user_id, random_time2 * 60)
					}
				} catch (err) {
					console.log('禁言失败:', err.message)
				}
			}
			if (img) await e.reply(img)
			else await BotApi.User.battleForward({ e, msgs })
		}, 3000)

		//每天对同一人赢满3次的计数(仅获胜时+1,首次设置过期,当天有效)
		if (result.winner === 'me') {
			const winCntNow = Number(await redis.get(dkey)) || 0
			if (winCntNow === 0) {
				await redis.set(dkey, '1', { EX: 24 * 60 * 60 })
			} else {
				await redis.incr(dkey)
			}
		}

		console.log(`发起者：${user_id}被动者： ${user_id2}随机时间：${random_time}分钟`); //输出日志
		await xujing_data.getQQYUserBattle(user_id, json, true, `${e.group_id}.json`)
		return true; //返回true 阻挡消息不再往下}
	}
}