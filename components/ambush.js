/* ============================================================
 * 伏击玩法 · 核心逻辑 (状态机)
 * #伏击 → 10分钟准备 → 0~30分钟随机触发事件
 * 路过者(该大区真实伪玩家): 劫修/肥羊/结伴/重伤逃命者/赶路人/高人(稀有)
 *   全部给"模糊暗示"文本(不点破类型), 文本多变体
 * 抉择: #伏击打(偷袭·先手) / #伏击试探(现身) / #伏击放
 * 打赢后: 显示猎物全部信息(真实数据) + 反应(求饶/鱼死网破/跪献/诈降)
 * 处置: 全放/搜刮再放/全杀/搜刮再杀/收服(仆从≤2)/勒索
 *   搜刮=目标真实身家60~100%, 20%暗袋(有真实珍贵物才触发), 劫修/宗门弟子被杀可问出真实情报
 * 世界联动: 杀宗门弟子→宗门敌视; 放走/勒索/收服→不记仇; 连续伏击→风声紧(结伴变多)
 * 仆从(收服的真实伪玩家, ≤2): 伏击打输有概率救场, 开始伏击有概率从仆从真实灵石献礼
 * 状态存 redis xujing:ambush:{gid}:{uid} (JSON, EX1小时兜底)
 * ============================================================ */
import { getFake, saveFake, personPower, getNick, killPerson, logEvent, sectName, removeFromSectMap, sectAlive, withFakeLock } from './fake_data.js'
import { playerPower, applyInjury } from './sect_system.js'
import { absoluteWinRate, MAX_WIN_RATE } from './fight.js'
import { getWorld, getLoc, regionNameOf, DEFAULT_REGION, levelNameOf } from './world_data.js'
import { addItem, addItemToBag, isBound, getBag, saveBag, GONGFA_TPL, MATERIAL_TPL, itemIcon } from './equip_data.js'
import { Wanhun } from './wanhun_data.js'
import { forceLock, unlock } from './interact.js'
import xujing_data from './xujing_data.js'

const AMBUSH_KEY = (gid, uid) => `xujing:ambush:${gid}:${uid}`
const SERVANT_KEY = (gid, uid) => `xujing:ambush-servant:${gid}:${uid}`
/** 准备时长(分钟) */
export const AMBUSH_PREP_MIN = 10
/** 触发延迟(分钟, 0~30 随机) */
export const AMBUSH_FIRE_MIN = [0, 30]
/** 触发后等待玩家抉择(分钟) */
export const AMBUSH_ASK_MIN = 3
/** 打赢后等待处置(分钟) */
export const AMBUSH_DISP_MIN = 5
/** 仆从上限 */
export const AMBUSH_SERVANT_MAX = 2

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)]
/** 稀有材料(红/彩)名单——情报/暗袋只认真实存在这些才触发 */
const RARE_MATS = ['凤栖花', '凤羽玉', '云裳仙蕊', '造梦神玉']

/** @玩家发消息(伏击触发/结果播报) */
function atPlayer (gid, uid, text) {
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.sendMsg) g.sendMsg([segment.at(Number(uid)), text])
  } catch (err) { }
}
/** 玩家灵石增减(读写 UserHome) */
async function playerMoney (gid, uid, delta) {
  try {
    const filename = `${gid}.json`
    const home = await xujing_data.getQQYUserHome(String(uid), null, filename, false)
    if (!home[String(uid)]) home[String(uid)] = {}
    home[String(uid)].money = Math.max(0, (Number(home[String(uid)].money) || 0) + delta)
    await xujing_data.getQQYUserHome(String(uid), home, filename, true)
    return delta
  } catch (err) { return 0 }
}
/** 伪玩家背包物品件数(兼容旧数字格式与当前 { count } 格式) */
function itemCount (raw) {
  const value = raw && typeof raw === 'object' ? raw.count : raw
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}
function itemGroups (raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.list) && raw.list.length) {
    return raw.list
      .map(group => ({ count: itemCount(group), attr: group && group.attr ? group.attr : null }))
      .filter(group => group.count > 0)
  }
  return [{ count: itemCount(raw), attr: raw && typeof raw === 'object' ? raw.attr || null : null }]
}
function pBagCount (p) {
  const b = (p && p.bag && p.bag.items) ? p.bag.items : {}
  return Object.values(b).reduce((sum, raw) => sum + itemCount(raw), 0)
}
/** 伤势中文 */
function injCn (lv) { return lv >= 3 ? '重伤' : (lv === 2 ? '中伤' : '轻伤') }
/** 玩家宗门名(散修返回 null) */
function mySectName (f, uid) {
  try {
    const pp = f.players && f.players[String(uid)]
    return (pp && pp.sect && f.sects[pp.sect]) ? f.sects[pp.sect].name : null
  } catch (err) { return null }
}
/** 目标真实背包里的珍贵物(功法书/稀有材料)——暗袋只认真实存在才触发 */
function preciousOf (p) {
  const b = (p && p.bag && p.bag.items) ? p.bag.items : {}
  return Object.keys(b).filter(n => GONGFA_TPL[n] || (MATERIAL_TPL[n] && RARE_MATS.includes(n)))
}

/* ============ 路过者模糊文本(多变体, 暗示不点破) ============ */
const PASSER_TXT = {
  rogue: [
    '你听到一阵阴冷的风声，一道黑影疾掠而过，衣袂带起浓重血腥气……',
    '远处传来一声压抑的狞笑，那人影脚步虚浮却煞气冲天，腰间隐隐有刀光……',
    '一个独行客步履匆匆，气息阴鸷，瞥向你这边时眼底掠过一丝凶光……',
    '夜色里有人影贴着山壁走，兜帽压得极低，袖口似乎沾着什么暗红的痕迹……',
    '前方传来几声压抑的咳嗽，一个佝偻身影缓缓走近，周围空气莫名冷了几分……',
    '你鼻尖捕捉到一丝铁锈般的腥味，一个蒙面身影低头急行，脚步轻得几乎无声……',
    '那人走路带风，却偏偏没有一点脚步声，像是猎食的野兽在接近……',
    '一个披着破斗篷的身影驻足张望，手按在腰间鼓囊囊的凶器上，警惕地扫视四周……',
    '山道那头传来“铮”的一声轻响，似是利刃出鞘又归鞘，随即一个身影大摇大摆走来……',
    '一个满脸戾气的汉子扛着把豁口弯刀，边走边舔嘴角，眼里满是不怀好意……',
    '你隐约听到细碎的金属碰撞声，来人脚步虚浮，却让林间的鸟雀都噤了声……',
    '一个瘦削身影贴着道旁枯树停了停，黑暗中似乎有一双眼睛直直望向你的方向……',
    '远处传来一声短促的惨叫，随即归于死寂，一个身影提着东西快步走来……',
    '那人的衣衫下摆沾满泥点与暗渍，手指甲缝里都是陈年血垢，浑身上下透着一股邪气……',
    '一个独行夜客哼着不成调的曲子走来，曲调却阴恻恻的，听着让人脊背发凉……',
    '你看到一个人影蹲在路边水洼旁，掬水洗着手，那水洼竟渐渐泛红……',
    '来人脚步极快，时快时慢，像是随时准备暴起伤人，浑身绷得像根弓弦……',
    '一个披头散发的修士迎面走来，衣襟半敞，胸口纹着古怪的暗红图腾……',
    '你听见一声极轻的“咻”，一支飞针扎进了你身旁的树干——那人在试探有没有埋伏……',
    '一个黑袍人停在岔路口，缓缓扫视四周，目光冰冷得像两柄刀子……',
    '那人腰间挂着好几个鼓囊囊的布袋，走几步就要回头看一眼，满身戒备……',
    '一个邋遢汉子啃着根骨头路过，骨头上还带着肉丝，他舔了舔嘴角冲山林嘿嘿一笑……',
    '前方有人影晃动，你听见“唰唰”的磨刀声，一下一下，在寂静中格外渗人……',
    '一个身材矮小的身影快步走过，动作却利落得像条蛇，无声无息地贴着阴影……',
    '那人的影子在月光下拉得很长，手里把玩着一枚暗器，忽明忽暗……',
    '你闻到一股刺鼻的草药味混着血腥味，一个黑袍人捂着胸口走过，眼里却满是狠厉……',
    '一个背刀客在山道边歇脚，腰间那柄刀却始终没离手，警觉得反常……',
    '那人路过时突然驻足，侧耳听了片刻，嘴角勾起一抹冷笑，又继续前行……',
    '一个浑身酒气的醉汉摇摇晃晃走来，可那步伐竟暗合某种杀伐步法，绝非寻常醉鬼……',
    '你看到黑影一闪，那人的身形竟快得像鬼魅，眨眼便掠过了你的藏身点……'
  ],
  sheep: [
    '一道身影慢悠悠走来，背着鼓鼓的行囊，走路都带着钱袋的叮当声……',
    '那人穿着上好的绸缎衣裳，腰间玉佩晃眼，行囊沉甸甸的，像揣了不少家当……',
    '一个圆脸身影哼着小调赶路，包袱鼓得快要撑破，浑然不觉周围动静……',
    '你听到细细的灵石碰撞声，来人步履轻快、神色悠闲，像是出门踏青的富家子……',
    '一个衣着光鲜的修士信步走来，手上戴满各色戒指，走一步身上就叮当作响……',
    '那人赶路还不忘啃着灵果，另一只手捧着本账册翻看，一看就是个富得流油的主……',
    '一个白白胖胖的身影吃力地扛着个大箱子，走走停停，累得直喘却笑得合不拢嘴……',
    '你听到一串清脆的铃铛声，来人腰上挂着一排小锦囊，走路都带风……',
    '一个锦衣修士牵着头驮满货物的灵驴路过，灵驴都累得直打响鼻……',
    '那人脚上踩着云纹靴，腰间别着把镶宝短剑，浑身上下写着“我有钱”三个字……',
    '一个笑眯眯的胖修士边走边数手里的灵石，数完塞回怀里，又掏出来数一遍……',
    '你闻到一股淡淡的丹药香气，来人怀里揣着好几个精致的丹瓶，走路叮当作响……',
    '一个富态身影坐着软轿赶路，轿夫累得满头大汗，他却惬意地摇着扇子……',
    '那人身披锦缎斗篷，身后跟着几个挑夫，担子里全是大包小包的货物……',
    '一个衣着考究的修士驻足歇脚，掏出个镶金水壶喝水，连壶嘴都是金的……',
    '你听到“咕噜咕噜”的灵石滚动声，一个胖修士边走边往储物袋里塞着什么……',
    '那人手里把玩着一枚温润的玉珏，一看就价值不菲，他却毫不在意随手抛接……',
    '一个戴满珠翠的修士施施然走来，每一步都透着“财大气粗”的从容……',
    '你看到来人腰间鼓鼓囊囊，走几步就要停下来拍拍钱袋，生怕丢了似的……',
    '一个圆滚滚的身影扛着个沉甸甸的包裹，累得直喘，眼里却满是得意……',
    '那人穿着金丝滚边的长袍，连鞋面都绣着暗纹，一看就是世家子弟出游……',
    '一个富家翁模样的修士坐着牛车路过，车上堆满瓜果布匹，好不快活……',
    '你听到几声清脆的碰撞声，那人怀里像揣了只小狐狸似的，鼓出一大块……',
    '一个白白净净的修士边走边啃灵参，啃得满嘴生香，像在啃萝卜……',
    '那人腰间挂着三四个储物袋，走路时叮当乱响，像棵挂满果子的树……',
    '一个锦衣少年公子摇着折扇路过，扇面上都镶着碎金，走路带风……',
    '你看到来人怀里露出一角布帛，像是银票或契约，鼓鼓囊囊塞了一怀……',
    '一个胖修士赶路还牵着只灵鹤，灵鹤脖子上都挂着颗夜明珠……',
    '那人用镶玉的烟杆点了口灵烟，悠闲地吐着烟圈，全无防备……',
    '一个衣着华丽的身影背着个大包袱，走两步就歇一歇，却始终笑呵呵的……'
  ],
  group: [
    '你听到一阵说笑声由远及近，两三道人影结伴而行，脚步杂沓……',
    '前方传来交谈声，听得出是几个人同行，时而有笑声，人多势众……',
    '一小队人结伴赶路，谈天说地，偶尔停下指点沿途风景，好不热闹……',
    '几道身影簇拥着走来，说说笑笑，显然是结伴的熟识，不好惹……',
    '你听到几个人在争论什么功法心得，声音此起彼伏，显然不是一人……',
    '前方人影绰绰，约莫有三四人，勾肩搭背地走着，笑声爽朗……',
    '一小群修士结伴而行，有人背着琴，有人拎着酒壶，好不快活……',
    '你听到脚步杂沓、衣袂猎猎，听得出是好几个人同行，气势不小……',
    '几个人影边走边分食着干粮，有说有笑，气氛热闹得很……',
    '前方传来几声吆喝，像是一伙人在互相招呼，听声音就有四五人……',
    '一小队人排着队走过，领头的手里提着灯笼，后面跟着两三个……',
    '你听到有人喊“等等我”，随即是一阵笑声，显然不是孤身上路……',
    '几道身影并排走来，有高有矮，边走边聊，浑然不觉天色已暗……',
    '前方人影晃动，像是好几个人在争论该走哪条路，声音嘈杂……',
    '一小群修士扛着猎到的野兽路过，说说笑笑，满载而归……',
    '你听到一个嗓门洪亮的声音讲着故事，周围不时爆发出哄笑声……',
    '几个少年修士结伴而行，叽叽喳喳，像群出笼的小雀儿……',
    '前方有火光晃动，像是有人举着火把，隐约可见三四道人影……',
    '一小队人脚步整齐地走来，像是结伴赶远路的，边走边互相照应……',
    '你听到“来来来，喝一口”的劝酒声，几个人围着个酒葫芦分饮……',
    '几道身影相互搀扶着走来，有人哼着歌，有人应和着，好不热闹……',
    '前方传来一片衣料摩擦声和脚步声，显然是几个人挤挤挨挨地赶路……',
    '一小群修士边走边采路边的灵草，你一句我一句地品评着……',
    '你听到有人抱怨“怎么还没到”，立刻有人笑着回嘴，一唱一和……',
    '几个身影在岔路口商量着什么，指指点点，分明是结伴同行……',
    '前方人影三三两两，有人背着包裹，有人拎着鱼篓，像是赶集的……',
    '一小队人簇拥着一辆独轮车走来，车上堆满杂物，热热闹闹……',
    '你听到几下击掌，随即是一阵哄笑，像是一伙人在玩闹……',
    '几个修士边走边切磋拳脚，你来我往，笑声不断……',
    '前方传来一片招呼声，“前面有家客栈！”“走走走！”——显然是群人同行……'
  ],
  wounded: [
    '一道踉跄的身影跌跌撞撞而来，浑身血污，喘息粗重，像是刚逃过大难……',
    '那人衣衫破碎、血迹斑斑，捂着胸口跌跌撞撞地跑，身后扬起一路尘土……',
    '你闻到浓重的血腥味，一个身影扶着路边的树直喘气，脚步虚浮得随时要倒……',
    '有人跌跌撞撞从山道那头奔来，衣上染血，边跑边回头，满脸惊惶……',
    '一个身影踉跄着扑倒在路旁，挣扎着爬起来，袖口滴着血，脚步散乱……',
    '你听到急促的喘息声由远及近，一个满身尘土的身影跌撞而来，步履蹒跚……',
    '那人一只手捂着腹部，指缝间渗出暗红，脸色惨白，每走一步都像要摔倒……',
    '一个衣衫褴褛的身影拖着脚步走来，背后的衣料破开一大片，露出的伤口触目惊心……',
    '你看到有人跌跌撞撞地从林间冲出，一跤摔在地上，又连滚带爬地往前挪……',
    '那人的半边衣袖都被染透了，脸上血污混着汗水，眼神却死死盯着前路……',
    '一个身影弓着腰，一步一瘸地挪动，每一次呼吸都带着压抑的痛哼……',
    '你听到“咕咚”一声闷响，一个身影栽倒在路边，挣扎了半天才爬起来……',
    '有人踉跄着奔来，身后拖出一道长长的血痕，脚步虚浮得像踩在棉花上……',
    '那人捂着肩膀跌撞前行，肩头的衣料破了个大口子，露出翻卷的血肉……',
    '一个面色惨白的身影扶着山壁一步步挪动，指节因用力而发白……',
    '你看到来人衣摆被撕得稀烂，满身尘土与血污，像刚从狼窝里逃出来……',
    '一个身影踉跄着跑过，气若游丝，脚下一软差点栽进路沟里……',
    '那人步履蹒跚，边走边咳，咳得直不起腰，指缝间竟有血丝……',
    '你听到一声压抑的痛呼，一个身影扶着树干喘息，半天才直起身……',
    '有人跌跌撞撞地奔来，怀里死死护着个包裹，浑身是伤却不敢停……',
    '那人的半张脸都被血污糊住，只露出一双惊惶的眼睛，跌撞着往前跑……',
    '一个身影三步一跌、五步一停地走来，身后的脚印都带着血渍……',
    '你看到来人一只手拄着根断枝当拐杖，另一只手按着腰，疼得直龇牙……',
    '一个满身泥泞血污的身影爬上路来，膝盖和手肘都磨破了皮……',
    '那人跌跌撞撞地跑过，脚下拌蒜，好几次险些摔倒，却又咬牙撑住……',
    '你听到粗重的喘息和压抑的呻吟，一个身影扶着路碑歇脚，肩头一片殷红……',
    '一个衣衫尽破的身影踉跄而来，走得摇摇晃晃，像风中的残烛……',
    '有人一边跑一边回头张望，神色惊恐，身上的伤口还在往外渗血……',
    '那人的脚步沉重而凌乱，每一步都像踩在刀尖上，却仍拼命往前挪……',
    '你看到一个身影瘫坐在路旁，浑身是血，喘息如牛，听到动静猛地一颤……'
  ],
  passer: [
    '一个普通修士背着简单的行囊，风尘仆仆地赶路，看起来就是个寻常路人……',
    '你看到一个衣衫朴素的行脚修士，步履不紧不慢，腰间只挂了个旧旧的储物袋……',
    '一个风尘仆仆的身影埋头赶路，行囊单薄，看起来没什么油水……',
    '有人扛着包袱匆匆而过，衣着朴素，一看就是常年在外奔波的苦修士……',
    '一个灰扑扑的身影快步走过，脚步匆匆，像是有急事赶路……',
    '你看到个背着手的老实人晃悠着走来，包袱瘪瘪的，一脸倦容……',
    '一个穿着洗得发白的旧袍子的修士埋头赶路，连头都不抬……',
    '那人挎着个打了补丁的包袱，边走边啃干硬的馒头，吃得很省……',
    '一个风尘仆仆的行脚客路过，草鞋都磨破了边，脚趾头露在外面……',
    '你看到一个背着药篓的采药人匆匆而过，篓子里只有几根寻常灵草……',
    '一个皮肤黝黑的汉子扛着锄头路过，一看就是常年在外奔波的苦哈哈……',
    '那人走路低着头，心事重重，身上那件袍子洗得发白……',
    '一个瘦瘦小小的修士扛着根扁担路过，两头挂着破旧的行李……',
    '你看到个蓬头垢面的落魄客，怀里抱个破瓦罐，一副潦倒模样……',
    '一个老实巴交的身影赶路，走几步就擦擦汗，包袱里八成没什么值钱的……',
    '那人穿着打满补丁的短褐，腰里别着把豁口的柴刀，寻常得不能再寻常……',
    '一个风尘仆仆的身影埋头赶路，偶尔抬头看看天色，又继续低头走……',
    '你看到一个背着旧行囊的修士，行囊里露出几本书角，像是赶考的书生……',
    '那人挎着个破包袱，手里拄着根竹杖，走得一步三晃，却透着股踏实……',
    '一个灰衣修士慢悠悠走着，嘴里哼着不成调的乡野小曲，悠闲得很……',
    '你看到个挑着担子的脚夫路过，担子里是些柴火山货，值不了几个钱……',
    '那人蹲在路边掬水解渴，喝完抹抹嘴又赶路，行囊就一个小小的包裹……',
    '一个风尘仆仆的修士背着把旧剑，剑鞘都磨得发亮，像是走了很远的路……',
    '你看到个愁眉苦脸的身影赶路，边走边叹气，包袱瘪瘪的……',
    '一个衣着朴素的修士停下买了块干粮，掰开分着吃，看着就寒酸……',
    '那人背个鼓囊囊却轻飘飘的麻袋，走几步就颠一颠，像装的都是衣裳……',
    '一个老实巴交的身影远远避开路中央，贴着道边走，小心翼翼的……',
    '你看到一个背着篓子的老农模样的修士，篓子里是些山货野果……',
    '那人挎着个旧褡裢，边走边数着指头算账，看着就是个精打细算的穷人……',
    '一个风尘仆仆的身影埋头赶路，身后的脚印一深一浅，走得有些累了……'
  ],
  master: [
    '一个灰袍老者负手缓行，气息内敛得如同常人，步履却暗合某种韵律……',
    '你心头莫名一紧——来人步履从容，浑然看不出深浅，像是一潭平静深水……',
    '一个其貌不扬的老者信步走来，全无防备之态，可你直觉此人绝不简单……',
    '有人施施然而来，衣衫朴素，目光却清澈如渊，给人一种说不出的压迫感……',
    '那老者手里拄着根寻常竹杖，可你竟看不出他的境界，像是被云雾笼着……',
    '一个佝偻老者缓缓走过，步伐极慢，却每一步都恰好避开了路面的坑洼……',
    '你隐约感到一股若有若无的威压，可定睛看去，来人明明只是个寻常老者……',
    '那人负手而行，衣袂不扬，山风路过他身边时竟像绕道而行……',
    '一个慈眉善目的老者路过，朝山林方向笑了笑——你竟有种被看穿的错觉……',
    '来人步履沉稳，气息绵长，浑身上下找不出一丝破绽，反而让人心里发毛……',
    '那老者赶路竟不沾尘土，走过的路面连个脚印都没留下……',
    '你看到个樵夫打扮的老者扛着柴担走过，可那柴担轻若无物，脚步却重若千钧……',
    '一个貌不惊人的修士缓步而来，你越是凝神去看，越是觉得看不清他的虚实……',
    '那人随手折了根草茎剔着牙，可你分明感到他随手一拂，草屑便避开了他周身……',
    '一个白发老者负手观云，驻足片刻又继续前行，那片刻间你竟屏住了呼吸……',
    '来人衣着简朴、形容枯槁，可那双眼睛却亮得惊人，像是藏着一片星空……',
    '你感到空气微微凝滞，随即一个布衣老者不紧不慢地走过，气势浑然天成……',
    '那老者赶路时偶尔停下来看看路边的野花，动作轻缓，却透着说不出的从容……',
    '一个平平无奇的老人路过，可你心跳莫名加速，像是面对着一头沉睡的巨兽……',
    '来人脚步轻得几乎无声，连落叶都不曾被惊动，这份修为绝非等闲……',
    '你看到个喂马的老头在路边歇脚，可那马竟驯服得不敢抬头看他……',
    '一个布衣老者缓缓走来，气势内敛，你却连他呼吸的节奏都捕捉不到……',
    '那人负手立于道旁，看了会儿山景，你竟觉得那山都矮了三分……',
    '一个其貌不扬的身影缓步而过，衣角无风自动，透着股说不出的玄妙……',
    '你感到一股温和却不容抗拒的力量扫过心头，随即一个老者淡然走过……',
    '那老者弯腰拾起一片落叶，端详片刻又放下，动作行云流水，深不可测……',
    '一个白发道人拄杖而行，杖尖落地竟不闻声响，如踏虚境……',
    '来人面色平和，可你竟不由自主地屏息，仿佛惊扰了什么了不得的存在……',
    '一个寻常打扮的老者路过，他看你藏身处时微微一笑——你后背瞬间发凉……',
    '那人负手缓缓走来，步伐不快，你却觉得整条山道都在随着他的节奏呼吸……'
  ]
}
/* 打赢后猎物反应文本(多变体) */
const REACT_TXT = {
  beg: [
    '他瘫软在地连连求饶：“大侠饶命！我愿交出全部身家，只求留我一命！”',
    '他“扑通”跪倒，涕泗横流：“我上有老下有小……求你放过我，我什么都给你！”',
    '他脸色煞白，颤抖着举起双手：“别杀我！我愿意做牛做马，只求活命！”',
    '他带着哭腔告饶：“大哥！我身上值钱的都给你，千万别动手！”'
  ],
  fish: [
    '他猛地吐出一口血，狞笑着扑向你：“想搜我的身？那就陪我一起死吧！”',
    '他双目赤红，嘶吼一声：“我得不到的，你也别想得到！”说着竟要自爆丹田……',
    '他拼尽最后一口气反扑，眼中满是疯狂：“我活不成，你也别想好过！”',
    '他惨然一笑，将身上东西尽数掷入悬崖：“宁可毁掉，也不便宜你！”'
  ],
  kneel: [
    '他吓得跪地磕头，主动献上全部身家：“大侠，这些都给你，别杀我！”',
    '他双手奉上储物袋，趴在地上发抖：“大爷饶命！东西全在这儿了，分文不留！”',
    '他腿一软跪倒在地，把身上值钱的都掏出来堆成一堆：“全、全给你，求放过！”',
    '他筛糠似的抖着，将随身物件一股脑捧到你面前：“您行行好，放我条活路！”'
  ],
  feint: [
    '他“扑通”跪下求饶，眼神却闪烁不定……（小心有诈！）',
    '他谄笑着伏低做小，一只手却悄悄摸向袖中的暗器……（小心有诈！）',
    '他嘴上求饶，目光却不时瞟向你的破绽……（小心有诈！）',
    '他佯装瘫软，指尖却轻轻扣住了什么……（小心有诈！）'
  ]
}
const KIND_CN = { rogue: '劫修', sheep: '肥羊', group: '结伴的修士', wounded: '重伤逃命者', passer: '赶路人', master: '高人' }

/** 风声紧: 该大区近期多次被伏击(1小时内) */
function heatOf (f, loc) {
  const h = (f.ambushHeat && f.ambushHeat[loc]) || null
  if (!h) return 0
  return (Date.now() - (h.at || 0) < 3600000) ? (h.c || 0) : 0
}
function heatAdd (f, loc) {
  if (!f.ambushHeat) f.ambushHeat = {}
  const h = f.ambushHeat[loc] || { c: 0, at: 0 }
  if (Date.now() - (h.at || 0) > 3600000) h.c = 0
  h.c = (h.c || 0) + 1
  h.at = Date.now()
  f.ambushHeat[loc] = h
}

/** 生成路过者(该大区在世真实伪玩家): 劫修/肥羊/结伴/重伤逃命/赶路/高人; 无目标返回 null
 *  exclude: 排除名单(玩家仆从/同宗门门人, 避免伏击自己人)
 *  myPw: 玩家当前战力, 用于类型匹配实力(肥羊=富且弱, 劫修=凶且强) */
export function genPassers (f, loc, exclude = null, myPw = 0) {
  const ex = exclude || new Set()
  const pool = Object.values(f.roster).filter(p => p && p.alive && !p.servantOf && p.status !== 'mine' && !p.mineOf && (p.loc || DEFAULT_REGION) === loc && !ex.has(p.name))
  if (!pool.length) return null
  const heat = heatOf(f, loc)
  /* 风声紧(≥3次) → 结伴概率翻倍(世界会躲落单) */
  const groupW = heat >= 3 ? 0.4 : 0.2
  const table = [
    ['rogue', 0.3], ['sheep', 0.25], ['group', groupW], ['wounded', 0.15], ['passer', 0.07], ['master', 0.03]
  ]
  const total = table.reduce((s, x) => s + x[1], 0)
  let r = Math.random() * total
  let kind = 'passer'
  for (const [k, w] of table) { r -= w; if (r <= 0) { kind = k; break } }
  const txtPool = PASSER_TXT[kind] || PASSER_TXT.passer
  const txt = txtPool[Math.floor(Math.random() * txtPool.length)]
  const pick = arr => arr[Math.floor(Math.random() * arr.length)]
  if (kind === 'rogue') {
    const evil = pool.filter(p => p.path === '魔道' || p.trait === '嗜杀' || p.trait === '好斗')
    /* 劫修: 凶悍且对玩家有威胁的优先(真"劫修"不是菜鸡, 低境界别去惹) */
    const strong = evil.filter(p => personPower(p) >= myPw * 0.7)
    const cand = strong.length ? strong : evil
    const p = pick(cand.length ? cand : pool)
    return { kind, names: [p.name], txt }
  }
  if (kind === 'sheep') {
    const rich = pool.filter(p => (Number(p.money) || 0) >= 500)
    /* 肥羊: 富且明显弱于玩家的优先(真"肥羊"好欺负, 不是高手) */
    const weak = rich.filter(p => personPower(p) < myPw * 0.6)
    const cand = weak.length ? weak : rich
    const p = pick(cand.length ? cand : pool)
    return { kind, names: [p.name], txt }
  }
  if (kind === 'group') {
    /* 结伴: 从普通修士(排除该大区最强25%, 高手不与弱者为伴)中随机选2~3人,
     *  避免随机撞上"该大区最强3人团"导致高境界玩家被结伴碾压(战力失控) */
    const sorted = pool.slice().sort((a, b) => personPower(b) - personPower(a))
    const skip = Math.max(1, Math.floor(pool.length * 0.25))
    const base = sorted.slice(skip)
    const cand = base.length ? base : pool
    const n = Math.min(cand.length, rand(2, 3))
    const shuffled = cand.slice().sort(() => Math.random() - 0.5)
    return { kind, names: shuffled.slice(0, n).map(p => p.name), txt }
  }
  if (kind === 'wounded') {
    /* 重伤逃命者: 弱散修(无宗门 + 该大区低修为者) */
    const weak = pool.filter(p => !p.sect && (Number(p.level) || 1) <= 15)
    const p = pick(weak.length ? weak : pool)
    return { kind, names: [p.name], txt, weak: true }
  }
  if (kind === 'passer') {
    /* 赶路人: 穷鬼(灵石少 + 背包空) */
    const poor = pool.filter(p => (Number(p.money) || 0) < 500 && pBagCount(p) <= 2)
    const p = pick(poor.length ? poor : pool)
    return { kind, names: [p.name], txt }
  }
  /* master 高人: 该大区战力最强者(稀有) */
  const best = pool.slice().sort((a, b) => personPower(b) - personPower(a))[0]
  const p = best || pick(pool)
  return { kind, names: [p.name], txt }
}

/* ============ 仆从系统(收服的真实伪玩家, ≤2) ============ */
async function servantList (gid, uid) {
  try {
    const f = getFake(gid)
    const raw = await redis.get(SERVANT_KEY(gid, uid))
    let list = []
    try { list = raw ? JSON.parse(raw) : [] } catch (err) { list = [] }
    if (!Array.isArray(list)) list = []
    const byName = new Map(list.map(x => [x.name, x]))
    /* 世界存档 servantOf 是唯一事实来源：Redis 丢失/过期时自动重建，不让已收服仆从凭空消失 */
    for (const p of Object.values(f.roster || {})) {
      if (p && p.alive && p.servantOf === String(uid) && !byName.has(p.name)) byName.set(p.name, { name: p.name, since: p.servantSince || Date.now() })
    }
    const valid = [...byName.values()].filter(x => {
      const p = f.roster[x.name]
      return p && p.alive && p.servantOf === String(uid)
    })
    /* 每次读取都重写为永久键，顺便移除旧版7天TTL */
    await servantSave(gid, uid, valid)
    return valid
  } catch (err) { return [] }
}
async function servantSave (gid, uid, list) {
  await redis.set(SERVANT_KEY(gid, uid), JSON.stringify(list))
}
/** 收服: 目标真实存在且在世, 仆从≤2 */
export async function servantAdd (gid, uid, targets, nick, world = null) {
  const list = await servantList(gid, uid)
  const f = world || getFake(gid)
  const taken = []
  for (const target of targets) {
    const p = f.roster && f.roster[target.name]
    if (!p || !p.alive) continue
    if (list.length >= AMBUSH_SERVANT_MAX) break
    if (list.some(x => x.name === p.name)) continue
    /* 已归属其他玩家的仆从不可被再次收服/换主 */
    if (p.servantOf && p.servantOf !== String(uid)) continue
    /* 收服: 脱离原宗门(身份归玩家仆从), 不再当原宗弟子/参战 — 仆从忠于玩家 */
    if (p.sect && f.sects[p.sect]) {
      removeFromSectMap(f, p.sect, p.name)
      logEvent(f, 'leave', `【收服】${p.name} 脱离【${sectName(f, p.sect)}】，归顺玩家${nick || '修士'}为仆从`, Date.now(), { who: [p.name] })
    }
    p.sect = null; p.status = 'scatter'; p.pos = null
    p.servantOf = String(uid)
    p.servantSince = Date.now()
    list.push({ name: p.name, since: p.servantSince })
    taken.push(p.name)
  }
  saveFake(f, gid)
  await servantSave(gid, uid, list)
  return { taken, msg: taken.length ? `你收服了 ${taken.join('、')} 为仆从（你现有仆从 ${list.length}/${AMBUSH_SERVANT_MAX}）！` : `仆从已满（${AMBUSH_SERVANT_MAX} 名）或目标已是你仆从~` }
}
/** 驱散仆从: 释放某仆从离开(腾出位置), 恢复自由身 */
export async function servantDismiss (gid, uid, name) {
  const list = await servantList(gid, uid)
  if (!list.length) return { ok: false, msg: '你还没有仆从~' }
  const hit = list.find(s => s.name === name || s.name.includes(name) || name.includes(s.name))
  if (!hit) {
    const names = list.map(s => s.name).join('、')
    return { ok: false, msg: `仆从里没有【${name}】（你现有仆从：${names || '无'}）~` }
  }
  const f = getFake(gid)
  const p = f.roster[hit.name]
  if (p) {
    p.servantOf = null // 恢复自由身
    p.servantSince = 0
    logEvent(f, 'leave', `【驱散】仆从 ${p.name} 被主人驱逐，恢复自由身`, Date.now(), { who: [p.name] })
  }
  const left = list.filter(s => s.name !== hit.name)
  await servantSave(gid, uid, left)
  saveFake(f, gid)
  return { ok: true, msg: `🔓 你驱散了仆从【${hit.name}】，它恢复自由身（腾出位置，可再收服新仆从）~` }
}
/** 救场: 打输时仆从出现挡下(50%), 返回仆从名或 null */
export async function servantRescue (gid, uid) {
  const list = await servantList(gid, uid)
  if (!list.length) return null
  const f = getFake(gid)
  const available = list.filter(x => {
    const p = f.roster[x.name]
    return p && p.alive && p.servantOf === String(uid) && p.status !== 'mine' && !p.mineOf
  })
  if (!available.length || Math.random() >= 0.5) return null
  return available[Math.floor(Math.random() * available.length)].name
}
/** 献礼: 开始伏击时仆从有概率从自己真实灵石献礼, 返回文案或 null */
export async function servantGift (gid, uid) {
  const list = await servantList(gid, uid)
  if (!list.length || Math.random() >= 0.3) return null
  const s = list[Math.floor(Math.random() * list.length)]
  const f = getFake(gid)
  const p = f.roster[s.name]
  if (!p || !p.alive || p.status === 'mine' || p.mineOf) return null
  const amt = Math.max(1, Math.round((Number(p.money) || 0) * (0.05 + Math.random() * 0.1)))
  if (amt <= 0) return null
  p.money = Math.max(0, (Number(p.money) || 0) - amt)
  saveFake(f, gid)
  await playerMoney(gid, uid, amt)
  return `你的仆从【${p.name}】前来献上 ${amt} 灵石（从其私囊中）`
}
/** 仆从状态查看(显示真实位置/境界/近况) */
export async function servantStatus (gid, uid) {
  const list = await servantList(gid, uid)
  const f = getFake(gid)
  if (!list.length) return { ok: true, msg: '你还没有收服任何仆从（伏击打赢后可选 #伏击处置 收服，最多 2 名）~' }
  const lines = list.map(s => {
    const p = f.roster[s.name]
    if (!p || !p.alive || p.servantOf !== String(uid)) return `　· ${s.name}（已不知所踪）`
    if (p.status === 'mine' || p.mineOf) return `　· ${p.name}｜${levelNameOf(p.level)}｜被押矿山服役中｜暂时无法救场/献礼/参战`
    const sect = p.sect ? sectName(f, p.sect) : '散修'
    const loc = regionNameOf(p.loc || DEFAULT_REGION)
    /* 最近真实行为(从 byPerson 取最近一条) */
    const acts = (f.byPerson && f.byPerson[p.name]) || []
    const last = acts.length ? acts[acts.length - 1] : null
    let lastTxt = '暂无记载'
    if (last && last.txt) {
      const t = String(last.txt).replace(/【[^】]*】\s*/, '')
      lastTxt = t.length > 26 ? t.slice(0, 26) + '…' : t
    }
    return `　· ${p.name}｜${levelNameOf(p.level)}｜${sect}｜【${loc}】｜战力 ${personPower(p)}\n　　身家 ${Number(p.money) || 0} 灵石｜近况：${lastTxt}`
  })
  return { ok: true, msg: `🔗 你的仆从（${list.length}/${AMBUSH_SERVANT_MAX}）：\n${lines.join('\n')}\n仆从是你收服的真实修士，平日照常修炼/摆摊/游历，你伏击遇险时会赶来救场，偶尔献上灵石~\n#驱散仆从 [名字] 可释放仆从腾出位置` }
}

function reactionInjuryLevel (fakePower, playerPowerValue, baseLevel = 2) {
  const ratio = (Number(fakePower) || 0) / Math.max(1, Number(playerPowerValue) || 1)
  if (ratio < 0.2) return 0
  if (ratio < 0.45) return Math.min(1, baseLevel)
  if (ratio < 0.8) return Math.min(2, baseLevel)
  return Math.min(3, baseLevel)
}

async function reactionInjury (f, gid, uid, targets, baseLevel = 2) {
  const pw = await playerPower(f, gid, uid)
  const fakePw = targets.reduce((sum, p) => sum + personPower(p), 0)
  const level = reactionInjuryLevel(fakePw, pw, baseLevel)
  if (level > 0) applyInjury(f, String(uid), level, Date.now(), gid)
  return level
}

/* ============ 战斗(偷袭先手 / 正常) ============ */
async function doFight (st, key, gid, uid, sneak) {
  const f = getFake(gid)
  const nick = await getNick(gid, uid)
  const targets = st.names.map(n => f.roster[n]).filter(p => p && p.alive)
  if (!targets.length) { await redis.del(key); return { ok: false, msg: '目标早已走远……' } }
  heatAdd(f, st.loc)
  const whoTxt = `【${st.names.join('、')}】`
  let myPw = await playerPower(f, gid, uid)
  /* 重伤逃命者: 目标真实重伤(负伤自动扣战力), 不再硬扣半血(真实数据, 不是壳子) */
  let tPw = 0
  for (const p of targets) {
    if (st.weak && !(p.injury && p.injury.level)) p.injury = { level: 3, at: Date.now() }
    tPw += Math.round(personPower(p))
  }
  /* 伏击战斗统一使用双方绝对战力比；偷袭先手额外+10%，最终上限允许100%，保底5% */
  let winRate = absoluteWinRate(myPw, tPw, 5)
  if (sneak) winRate = Math.min(MAX_WIN_RATE, winRate + 10)
  const win = Math.random() * 100 < winRate
  const rateTxt = `评估胜率约 ${Math.round(winRate)}%`
  /* ---- 输 ---- */
  if (!win) {
    const rescuer = await servantRescue(gid, uid)
    if (rescuer) {
      const rp = f.roster[rescuer]
      const rLoc = (rp && rp.loc) ? regionNameOf(rp.loc) : ''
      saveFake(f, gid)
      await redis.del(key)
      logEvent(f, 'player', `【伏击】🌙 ${nick} 伏击${whoTxt}落了下风，仆从【${rescuer}】从${rLoc || '他乡'}赶来救场！`, Date.now(), { major: true })
      return { ok: true, msg: `⚔️ 你落了下风（${rateTxt}）！千钧一发之际，一道身影从${rLoc ? '【' + rLoc + '】' : '远处'}掠出——你的仆从【${rescuer}】出手拦住了${whoTxt}！你得以全身而退……` }
    }
    const lootedBack = await robPlayer(gid, uid, targets, f)
    const injLv = rand(1, 2)
    applyInjury(f, String(uid), injLv, Date.now(), gid)
    saveFake(f, gid)
    await redis.del(key)
    const lostTxt = [lootedBack.lostMoney > 0 ? `${lootedBack.lostMoney} 灵石` : '', lootedBack.lostItems.length ? `背包里的 ${lootedBack.lostItems.map(it => `${itemIcon(it.name)}${it.name}×${it.count}`).join('、')}` : ''].filter(Boolean).join('、') || '一点灵石'
    logEvent(f, 'player', `【伏击】🌙 ${nick} 伏击${whoTxt}反被制服，被搜刮走${lostTxt}并受了${injCn(injLv)}`, Date.now(), { major: true })
    return { ok: true, msg: `⚔️ 你扑了上去（${rateTxt}），却反被 ${whoTxt} 教训！被搜刮走 ${lostTxt}，还受了${injCn(injLv)}（战力-${['', 20, 40, 60][injLv]}%，${['', 30, 120, 480][injLv]}分钟恢复）……` }
  }
  /* ---- 赢 ---- */
  /* 制服目标: 给其真实负伤(轻/中伤), 放走/处置后带伤休养 — 不再"被打败还活蹦乱跳" */
  for (const p of targets) {
    if (!(p.injury && p.injury.level)) p.injury = { level: rand(1, 2), at: Date.now() }
  }
  st.phase = 'won'
  st.dispAt = Date.now() + AMBUSH_DISP_MIN * 60000
  const posCn = { zongzhu: '宗主', fuzong: '副宗', taishang: '太上', zhishi: '执事', dizi: '弟子' }
  const infoLines = targets.map(p => {
    const sect = p.sect ? sectName(f, p.sect) : '散修'
    const pos = p.pos ? posCn[p.pos] || '' : ''
    const pathTxt = p.path === '魔道' ? '魔道' : '正道'
    const bagN = pBagCount(p)
    return `　· ${p.name}｜${levelNameOf(p.level)}｜${sect}${pos ? '·' + pos : ''}｜${pathTxt}·${p.trait || '平凡'}｜战力 ${personPower(p)}｜身家 ${Number(p.money) || 0} 灵石${bagN ? ' + ' + bagN + ' 件物品' : ''}`
  })
  const reaction = rollReaction(st.kind, f, uid, targets)
  st.reaction = reaction
  let reactMsg = ''
  if (reaction === 'fish') {
    const injLv = await reactionInjury(f, gid, uid, targets, 3)
    st.injured = injLv
    st.looted = { money: 0, items: [], destoyed: true }
    reactMsg = injLv > 0
      ? `\n💥 ${pickOne(REACT_TXT.fish)}（你受了${injCn(injLv)}，他趁乱自爆，把身上所有东西都毁掉了！）`
      : `\n💥 ${pickOne(REACT_TXT.fish)}（对方试图自爆，但境界差距过大，未能伤到你！）`
  } else if (reaction === 'beg') {
    reactMsg = `\n🙏 ${pickOne(REACT_TXT.beg)}`
  } else if (reaction === 'kneel') {
    reactMsg = `\n🫨 ${pickOne(REACT_TXT.kneel)}`
  } else if (reaction === 'feint') {
    reactMsg = `\n😏 ${pickOne(REACT_TXT.feint)}`
  }
  /* 赢不立刻记仇——按处置方式决定(放/收服/勒索不结怨) */
  await redis.set(key, JSON.stringify(st), { EX: 3600 })
  logEvent(f, 'player', `【伏击】🌙 ${nick} 伏击得手，制服了${whoTxt}！`, Date.now(), { major: true })
  saveFake(f, gid)
  /* 打赢即压栈(打断当前交互): 处置数字 1~7 可路由到伏击。必须在 won 状态保存成功后再压栈,
     否则状态保存失败会留下孤儿锁(栈顶是 ambush 但 ambushWonOf 读不到 won), 吞掉所有数字, 只能 #取消伏击 解锁 */
  try { await forceLock(gid, uid, 'ambush') } catch (err) { }
  return {
    ok: true,
    msg: `⚔️ 你${sneak ? '偷袭得手' : '正面制住'}了${whoTxt}（${rateTxt}）！\n━━ 猎物信息 ━━\n${infoLines.join('\n')}${reactMsg}\n如何处置？\n直接回复 1~7（或 #伏击处置1~7）：1全放 2搜刮再放 3全杀 4杀了再搜 5搜刮再杀 6收服 7勒索`
  }
}

/** 反杀后搜刮玩家: 灵石10~30% + 背包物品最多30%(排除绑定); 赃物真实落到打赢的伪玩家身上(不是壳子)
 *  winners: 反杀玩家的伪玩家(多人时战力最高的搜刮); f: 存档对象(传 doFight 的 f, 保证个人事迹写入同一存档) */
export async function robPlayer (gid, uid, winners = [], f = null) {
  let lostMoney = 0
  const lostItems = []
  try {
    const filename = `${gid}.json`
    const home = await xujing_data.getQQYUserHome(String(uid), null, filename, false)
    const h = home[String(uid)] || {}
    const cur = Number(h.money) || 0
    if (cur > 0) {
      lostMoney = Math.max(1, Math.round(cur * (0.1 + Math.random() * 0.2)))
      h.money = Math.max(0, cur - lostMoney)
      await xujing_data.getQQYUserHome(String(uid), home, filename, true)
    }
  } catch (err) { }
  try {
    const bag = getBag(String(uid), gid)
    if (bag && bag.items) {
      const names = Object.keys(bag.items).filter(n => !isBound(n))
      const total = names.reduce((sum, name) => sum + itemCount(bag.items[name]), 0)
      if (total > 0) {
        let toLose = Math.max(1, Math.floor(total * 0.3))
        const order = names.slice().sort(() => Math.random() - 0.5)
        for (const n of order) {
          if (toLose <= 0) break
          const it = bag.items[n]
          const cnt = Number(it && it.count) || 1
          const take = Math.min(cnt, toLose)
          lostItems.push({ name: n, count: take })
          it.count = cnt - take
          toLose -= take
          if (it.count <= 0) delete bag.items[n]
        }
        saveBag(String(uid), bag, gid)
      }
    }
  } catch (err) { }
  /* 赃物真实落到打赢的伪玩家身上: 灵石入身家, 物品入背包, 记个人事迹(#查人 可见) */
  if (winners.length && (lostMoney > 0 || lostItems.length)) {
    const p = winners.slice().sort((a, b) => personPower(b) - personPower(a))[0]
    if (lostMoney > 0) p.money = (Number(p.money) || 0) + lostMoney
    if (lostItems.length) {
      if (!p.bag) p.bag = { items: {}, equipped: {} }
      if (!p.bag.items) p.bag.items = {}
      for (const it of lostItems) addItemToBag(p.bag, it.name, it.count, null, false)
    }
    try {
      const nick = await getNick(gid, uid)
      const fake = f || getFake(gid)
      const lootTxt = lostItems.map(it => `${itemIcon(it.name)}${it.name}×${it.count}`).join('、')
      logEvent(fake, 'player', `【反杀】${p.name} 反杀伏击者 ${nick}，搜刮得${lootTxt}${lostMoney > 0 ? `、${lostMoney}灵石` : ''}`, Date.now(), { who: [p.name] })
      saveFake(fake, gid)
    } catch (err) { }
  }
  return { lostMoney, lostItems }
}

/** 打赢后伪玩家的反应(按类型加权) */
/** 打赢后伪玩家的反应(按类型加权); 若目标把该玩家记为仇人(relations.enemies 含 player:{uid}) → 更拼命: 鱼死网破↑、跪降↓、求饶↓ */
export function rollReaction (kind, f = null, uid = null, targets = null) {
  const table = {
    rogue: [['fish', 0.35], ['beg', 0.25], ['feint', 0.25], ['kneel', 0.15]],
    sheep: [['kneel', 0.45], ['beg', 0.3], ['feint', 0.15], ['fish', 0.1]],
    group: [['beg', 0.4], ['feint', 0.25], ['fish', 0.2], ['kneel', 0.15]],
    wounded: [['kneel', 0.5], ['beg', 0.35], ['feint', 0.1], ['fish', 0.05]],
    passer: [['kneel', 0.35], ['beg', 0.35], ['feint', 0.15], ['fish', 0.15]],
    master: [['fish', 0.4], ['feint', 0.3], ['beg', 0.2], ['kneel', 0.1]]
  }
  const list = (table[kind] || table.group).map(([n, w]) => [n, w])
  /* 记仇影响行为: 目标伪玩家是玩家的仇人 → 更拼命(记仇不是壳子) */
  const playerKey = uid ? `player:${String(uid)}` : null
  const hates = targets && targets.some(p => p && p.relations && p.relations.enemies && playerKey && p.relations.enemies.includes(playerKey))
  if (hates) {
    for (const it of list) {
      const n = it[0]
      if (n === 'fish') it[1] += 0.25
      else if (n === 'feint') it[1] += 0.1
      else if (n === 'kneel') it[1] = Math.max(0.01, it[1] - 0.2)
      else if (n === 'beg') it[1] = Math.max(0.01, it[1] - 0.15)
    }
  }
  const r = Math.random()
  let acc = 0
  for (const [name, p] of list) { acc += p; if (r < acc) return name }
  return 'beg'
}

/** 玩家结仇: 被玩家搜刮/杀的目标伪玩家个人把玩家记为仇人(影响其伏击反应/行为, 不是壳子) + 宗门敌视 */
function markSectHate (f, gid, uid, targets, nick) {
  const myName = mySectName(f, uid)
  const foe = myName || nick
  const playerKey = `player:${String(uid)}`
  for (const p of targets) {
    /* 个人记仇: 该伪玩家把玩家记为仇人 */
    if (p.relations) {
      if (!p.relations.enemies) p.relations.enemies = []
      if (!p.relations.enemies.includes(playerKey)) {
        p.relations.enemies.push(playerKey)
        logEvent(f, 'player', `【结仇】${p.name} 记恨伏击者 ${nick}，寻机报复`, Date.now(), { who: [p.name] })
      }
    }
    /* 宗门敌视 */
    if (!p.sect || !f.sects[p.sect]) continue
    const s = f.sects[p.sect]
    if (!s.enemies) s.enemies = []
    if (!s.enemies.includes(foe)) {
      s.enemies.push(foe)
      logEvent(f, 'player', `【结怨】${s.name} 因门下受害，对 ${foe} 结下仇怨`, Date.now(), { major: true })
    }
  }
}

/** 真实情报: 被杀的宗门弟子(30%)供出自家真实富宝库/囤料; 无真实数据不触发 */
async function intelOf (f, p, gid, uid) {
  try {
    if (!p.sect || !f.sects[p.sect] || !f.sects[p.sect].vault) return null
    if (Math.random() >= 0.3) return null
    const v = f.sects[p.sect].vault
    const stones = Number(v.stones) || 0
    const matN = Object.keys(v.mats || {}).length
    const sname = sectName(f, p.sect)
    if (stones >= 50000) return `其临死供出：【${sname}】宝库积攒了 ${stones} 灵石，肥得很！`
    if (matN >= 5) return `其临死供出：【${sname}】囤积了大量稀有材料！`
    return null
  } catch (err) { return null }
}

/** 开始伏击: 10分钟准备 */
export async function startAmbush (gid, uid) {
  const key = AMBUSH_KEY(gid, uid)
  const raw = await redis.get(key)
  if (raw) {
    const st = JSON.parse(raw)
    if (st.phase === 'prep' || st.phase === 'ready' || st.phase === 'waiting' || st.phase === 'won') {
      return { ok: false, msg: '你已有一次伏击在进行中，先处理完（或 #取消伏击）再来~' }
    }
  }
  const f = getFake(gid)
  const w = getWorld(gid)
  const loc = getLoc(w, uid)
  const pool = Object.values(f.roster).filter(p => p && p.alive && !p.servantOf && p.status !== 'mine' && !p.mineOf && (p.loc || DEFAULT_REGION) === loc)
  if (!pool.length) return { ok: false, msg: `${regionNameOf(loc)} 空无一人，无处可伏击~` }
  const st = { phase: 'prep', gid, uid, loc, startedAt: Date.now(), prepEnd: Date.now() + AMBUSH_PREP_MIN * 60000 }
  await redis.set(key, JSON.stringify(st), { EX: 3600 })
  let msg = `你已藏身于【${regionNameOf(loc)}】山道旁的灌木丛中，屏息凝神……${AMBUSH_PREP_MIN} 分钟后或有猎物经过（#取消伏击 可撤退）`
  const gift = await servantGift(gid, uid)
  if (gift) msg += `\n${gift}`
  return { ok: true, msg }
}

/** 取消伏击 */
export async function cancelAmbush (gid, uid) {
  const key = AMBUSH_KEY(gid, uid)
  const raw = await redis.get(key)
  if (!raw) return { ok: false, msg: '你当前没有伏击~' }
  await redis.del(key)
  /* 取消伏击: 若之前打赢压过处置锁, 一并摘除避免堵栈 */
  try { await unlock(gid, uid, 'ambush') } catch (err) { }
  return { ok: true, msg: '你撤出埋伏点，收好家伙离去~' }
}

/** 查询待处置的猎物(打赢后): 有则返回状态对象, 无则 null (供裸数字回复路由, 不与其他数字指令冲突) */
export async function ambushWonOf (gid, uid) {
  try {
    const raw = await redis.get(AMBUSH_KEY(String(gid), String(uid)))
    if (!raw) return null
    const st = JSON.parse(raw)
    return (st && st.phase === 'won') ? st : null
  } catch (err) { return null }
}

/** 查询玩家是否有进行中的伏击(任意阶段): 返回当前阶段(prep/ready/waiting/won), 无则 null
 *  供全局行动拦截使用(打boss同款锁: 伏击中不退出不允许其他行动指令) */
export async function ambushActiveOf (gid, uid) {
  try {
    const raw = await redis.get(AMBUSH_KEY(String(gid), String(uid)))
    if (!raw) return null
    const st = JSON.parse(raw)
    return (st && st.phase && ['prep', 'ready', 'waiting', 'won'].includes(st.phase)) ? st.phase : null
  } catch (err) { return null }
}

/** 已伏击时长文本: 优先取 startedAt; 旧存档无该字段时按 prepEnd - 准备时长倒推 */
function ambushElapsedOf (st, now = Date.now()) {
  const since = Number(st && st.startedAt) || ((Number(st && st.prepEnd) || 0) - AMBUSH_PREP_MIN * 60000) || now
  const sec = Math.max(0, Math.floor((now - since) / 1000))
  if (sec < 60) return `${sec}秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${m}分${s}秒` : `${m}分钟`
}

/** 查看伏击状态 */
export async function ambushStatus (gid, uid) {
  const raw = await redis.get(AMBUSH_KEY(gid, uid))
  if (!raw) return { ok: false, msg: '你当前没有伏击（#伏击 开始）~' }
  const st = JSON.parse(raw)
  const locTxt = regionNameOf(st.loc)
  const dur = ambushElapsedOf(st)
  if (st.phase === 'prep') {
    const left = Math.max(0, Math.ceil((st.prepEnd - Date.now()) / 60000))
    return { ok: true, msg: `🪤 已伏击 ${dur}｜你正埋伏于【${locTxt}】，再 ${left} 分钟后开始蹲守~` }
  }
  if (st.phase === 'ready') {
    return { ok: true, msg: `🪤 已伏击 ${dur}｜你已埋伏于【${locTxt}】，正静候猎物经过（随机 0~30 分钟内出现）~` }
  }
  if (st.phase === 'waiting') {
    return { ok: true, msg: `🔍 已伏击 ${dur}｜有情况出现了！回复 #伏击打（偷袭）／ #伏击试探（现身）／ #伏击放` }
  }
  if (st.phase === 'won') {
    return { ok: true, msg: `⚔️ 已伏击 ${dur}｜你已制服猎物！直接回复 1~7 处置（或 #伏击处置1~7）：1全放 2搜刮再放 3全杀 4杀了再搜 5搜刮再杀 6收服 7勒索` }
  }
  return { ok: false, msg: '伏击状态异常~' }
}

/** 玩家抉择: act = 'hit'(偷袭) | 'let'(放走) | 'talk'(现身试探) */
export async function ambushAct (gid, uid, act) {
  const key = AMBUSH_KEY(gid, uid)
  const raw = await redis.get(key)
  if (!raw) return { ok: false, msg: '你当前没有待抉择的伏击（#伏击 开始）~' }
  const st = JSON.parse(raw)
  if (st.phase !== 'waiting') return { ok: false, msg: '现在没有待抉择的目标~' }
  const f = getFake(gid)
  const nick = await getNick(gid, uid)
  const targets = st.names.map(n => f.roster[n]).filter(p => p && p.alive)
  if (!targets.length) { await redis.del(key); return { ok: false, msg: '目标早已走远……' } }
  const whoTxt = `【${st.names.join('、')}】`
  /* ---- 放走: 不结怨, 对方感恩 ---- */
  if (act === 'let') {
    heatAdd(f, st.loc)
    saveFake(f, gid)
    await redis.del(key)
    logEvent(f, 'player', `【伏击】🌙 ${nick} 伏击遇人却按兵不动，目送人影远去（对方心生感激）`, Date.now(), { major: true })
    return { ok: true, msg: '你压住杀心，目送人影消失在道路尽头……（那人回头望了一眼，似有感激之色）埋伏结束。' }
  }
  /* ---- 现身试探: 随机三岔口 ---- */
  if (act === 'talk') {
    const rTalk = Math.random()
    if (rTalk < 0.35) {
      /* 破财消灾: 对方求饶, 塞给你一笔真实买路钱 */
      let extort = 0
      for (const p of targets) {
        const amt = Math.max(1, Math.round((Number(p.money) || 0) * (0.1 + Math.random() * 0.1)))
        p.money = Math.max(0, (Number(p.money) || 0) - amt)
        extort += amt
      }
      if (extort > 0) await playerMoney(gid, uid, extort)
      heatAdd(f, st.loc)
      saveFake(f, gid)
      await redis.del(key)
      logEvent(f, 'player', `【伏击】🌙 ${nick} 现身拦路，${whoTxt}破财消灾（${extort} 灵石）`, Date.now(), { major: true })
      return { ok: true, msg: `你现身拦路，那人吓得连声告饶，塞给你 ${extort} 灵石买路，仓皇而去~` }
    } else if (rTalk < 0.6) {
      /* 吓跑 */
      heatAdd(f, st.loc)
      saveFake(f, gid)
      await redis.del(key)
      logEvent(f, 'player', `【伏击】🌙 ${nick} 现身拦路，${whoTxt}吓得转身就跑`, Date.now(), { major: true })
      return { ok: true, msg: '你现身拦路，对方见你拔刀，转身就跑没影了……埋伏结束。' }
    }
    /* 恼怒动手: 无先手, 继续走战斗 */
    return doFight(st, key, gid, uid, false)
  }
  /* ---- 偷袭(先手) ---- */
  return doFight(st, key, gid, uid, true)
}

/** 处置猎物核心逻辑(由 ambushDispose 统一加群锁) */
async function ambushDisposeUnlocked (gid, uid, action) {
  const key = AMBUSH_KEY(gid, uid)
  const raw = await redis.get(key)
  if (!raw) return { ok: false, msg: '当前没有待处置的猎物~' }
  const st = JSON.parse(raw)
  if (st.phase !== 'won') return { ok: false, msg: '当前没有待处置的猎物~' }
  const f = getFake(gid)
  const nick = await getNick(gid, uid)
  const targets = st.names.map(n => f.roster[n]).filter(p => p && p.alive)
  const whoTxt = `【${st.names.join('、')}】`
  const reaction = st.reaction || 'beg'
  const kneel = reaction === 'kneel'
  const killFirst = action === '杀了再搜' || action === '先杀再搜' || action === '全杀再搜'
  const doLoot = action === '搜刮再放' || action === '搜刮再杀' || killFirst || kneel
  const doKill = action === '全杀' || action === '搜刮再杀' || killFirst
  /* 诈降偷袭: 一搜刮就暴起反扑(先杀后搜无此风险——目标已死) */
  if (!killFirst && reaction === 'feint' && doLoot) {
    const injLv = await reactionInjury(f, gid, uid, targets, 2)
    saveFake(f, gid)
    await redis.del(key)
    const woundTxt = injLv ? `受了${injCn(injLv)}` : '但境界差距过大，未能伤到你'
    logEvent(f, 'player', `【伏击】🌙 ${nick} 搜刮${whoTxt}时遭其诈降偷袭，${woundTxt}，猎物趁机逃走`, Date.now(), { major: true })
    return { ok: true, msg: `⚔️ 你正要搜刮，他却暴起偷袭！${injLv ? `你受了${injCn(injLv)}` : '但境界差距过大，未能伤到你'}，猎物趁机连滚带爬逃走了……埋伏结束。` }
  }
  /* 收服为仆 */
  if (action === '收服' || action === '收为仆从') {
    const sr = await servantAdd(gid, uid, targets, nick, f)
    for (const p of targets) {
      if (p.relations) { if (!p.relations.enemies) p.relations.enemies = []; const i = p.relations.enemies.indexOf(nick); if (i >= 0) p.relations.enemies.splice(i, 1) }
    }
    saveFake(f, gid)
    await redis.del(key)
    logEvent(f, 'player', `【伏击】🌙 ${nick} 收服${whoTxt}为仆从`, Date.now(), { major: true })
    return { ok: true, msg: `🔗 ${sr.msg} 他低头认主，从此鞍前马后~` }
  }
  /* 勒索放走: 收真实买路财(20~40%), 不动身上东西, 不记仇 */
  if (action === '勒索' || action === '勒索放走') {
    let extort = 0
    for (const p of targets) {
      const amt = Math.max(1, Math.round((Number(p.money) || 0) * (0.2 + Math.random() * 0.2)))
      p.money = Math.max(0, (Number(p.money) || 0) - amt)
      extort += amt
    }
    if (extort > 0) await playerMoney(gid, uid, extort)
    for (const p of targets) {
      if (p.relations) { if (!p.relations.enemies) p.relations.enemies = []; const i = p.relations.enemies.indexOf(nick); if (i >= 0) p.relations.enemies.splice(i, 1) }
    }
    saveFake(f, gid)
    await redis.del(key)
    logEvent(f, 'player', `【伏击】🌙 ${nick} 勒索${whoTxt}（${extort} 灵石）后放走`, Date.now(), { major: true })
    return { ok: true, msg: `🤝 你收了 ${extort} 灵石买路钱，将其放走——和气生财，对方不记仇~` }
  }
  /* 先杀后搜: 直接斩杀再搜身 — 目标已死, 无诈降反扑风险 */
  let intel = ''
  if (killFirst) {
    for (const p of targets) {
      const info = await intelOf(f, p, gid, uid)
      if (info) intel = `\n🗣️ ${info}`
      killPerson(f, p, `被伏击者 ${nick} 先杀后搜斩杀`, Date.now())
    }
    markSectHate(f, gid, uid, targets, nick)
  }
  /* 搜刮(目标真实身家 60~100%, 20%暗袋有真实珍贵物才触发) */
  let lootMoney = 0
  let gotItems = []
  let hiddenTxt = ''
  if (doLoot) {
    for (const p of targets) {
      const real = Number(p.money) || 0
      let take = Math.round(real * (0.6 + Math.random() * 0.4))
      const precious = preciousOf(p)
      const foundHidden = precious.length && Math.random() < 0.2
      if (foundHidden) take = real
      if (take > 0) { lootMoney += take; p.money = real - take }
      if (p.bag && p.bag.items) {
        for (const it of Object.keys(p.bag.items)) {
          if (isBound(it)) continue
          const raw = p.bag.items[it]
          const groups = itemGroups(raw)
          let count = 0
          for (const group of groups) {
            try {
              addItem(String(uid), it, group.count, group.attr, gid)
              count += group.count
            } catch (err) { }
          }
          if (count > 0) gotItems.push(`${itemIcon(it)}${it}×${count}`)
        }
        if (foundHidden) hiddenTxt = `\n🎒 你从其贴身暗袋里翻出 ${precious.map(n => `${itemIcon(n)}${n}`).join('、')}——竟是藏起来的宝贝！`
        p.bag.items = {}
      }
    }
    if (lootMoney > 0) await playerMoney(gid, uid, lootMoney)
  }
  /* 杀 */
  if (doKill && !killFirst) {
    for (const p of targets) {
      const info = await intelOf(f, p, gid, uid)
      if (info) intel = `\n🗣️ ${info}`
      killPerson(f, p, `被伏击者 ${nick} 击杀`, Date.now())
    }
    markSectHate(f, gid, uid, targets, nick)
  } else if (doLoot && !killFirst) {
    markSectHate(f, gid, uid, targets, nick)
  }
  /* 玩家亲手处决伪玩家：每击杀1名业力+1（仅记录展示，无其他效果） */
  let soulTxt = ''
  if (doKill && targets.length) {
    try {
      const souls = targets.map(p => Wanhun.captureSoul(uid, gid, p.level))
      const gained = souls.reduce((sum, r) => sum + (r.gained || 0), 0)
      const overflow = souls.reduce((sum, r) => sum + (r.overflow || 0), 0)
      if (gained > 0) soulTxt = `\n🕯️ 万魂幡收取魂魄 ${gained} 魂${overflow > 0 ? `（${overflow}魂因容量已满消散）` : ''}。`
      else if (souls.some(r => r.reason === '未装备')) soulTxt = '\n🕯️ 你未装备万魂幡，无法收取魂魄。'
    } catch (err) { }
    try { await xujing_data.addPlayerKarma(gid, uid, targets.length) } catch (err) { }
  }
  saveFake(f, gid)
  await redis.del(key)
  let gotTxt
  if (kneel) gotTxt = `已收下其主动献上的 ${lootMoney} 灵石${gotItems.length ? '、' + gotItems.join('、') : ''}`
  else if (!doLoot) gotTxt = '分文未取'
  else if (lootMoney === 0 && !gotItems.length) gotTxt = reaction === 'fish' ? '分文未得（其身家已自爆毁尽）' : '分文未取'
  else gotTxt = `搜刮得 ${lootMoney} 灵石${gotItems.length ? '、' + gotItems.join('、') : ''}`
  const endTxt = doKill ? '斩草除根，一个不留' : '将其释放，扬长而去'
  const head = killFirst ? `🏴 你刀起头落，斩杀${whoTxt}后再搜身` : `🏴 你处置了${whoTxt}`
  logEvent(f, 'player', `【伏击】🌙 ${nick} 处置猎物${whoTxt}：${gotTxt}，${endTxt}`, Date.now(), { major: true })
  return { ok: true, msg: `${head}：${gotTxt}。${endTxt}~${hiddenTxt}${intel}${soulTxt}` }
}

/** 处置猎物按群串行执行，避免 fakeTick 用旧快照覆盖击杀结果 */
export async function ambushDispose (gid, uid, action) {
  return withFakeLock(gid, () => ambushDisposeUnlocked(gid, uid, action))
}

/** 推进单个伏击核心逻辑(由 ambushTickOne 统一加群锁) */
async function ambushTickOneUnlocked (st, now = Date.now()) {
  const { gid, uid } = st
  if (st.phase === 'prep' && now >= st.prepEnd) {
    st.phase = 'ready'
    st.fireAt = now + rand(AMBUSH_FIRE_MIN[0], AMBUSH_FIRE_MIN[1]) * 60000
    await redis.set(AMBUSH_KEY(gid, uid), JSON.stringify(st), { EX: 3600 })
    atPlayer(gid, uid, '\n🪤 你已埋伏就绪！猎物随时可能出现……')
    return
  }
  if (st.phase === 'ready' && now >= st.fireAt) {
    const f = getFake(gid)
    /* 排除玩家自己的仆从 + 同宗门门人(避免伏击自己人) */
    const exclude = new Set()
    try { for (const s of await servantList(gid, uid)) exclude.add(s.name) } catch (err) { }
    const pp = f.players && f.players[String(uid)]
    if (pp && pp.sect) { for (const q of sectAlive(f, pp.sect)) exclude.add(q.name) }
    const myPw = await playerPower(f, gid, uid)
    const passers = genPassers(f, st.loc, exclude, myPw)
    if (!passers) {
      await redis.del(AMBUSH_KEY(gid, uid))
      atPlayer(gid, uid, '\n🌙 你蹲守许久，此路竟无一人经过……你收好家伙悻悻离去。')
      return
    }
    st.kind = passers.kind
    st.names = passers.names
    if (passers.weak) {
      st.weak = true
      /* 重伤逃命者: 目标真实重伤(负伤自动扣战力), 无论打/放/超时都带伤 — 真实数据, 不是壳子 */
      for (const n of passers.names) {
        const tp = f.roster[n]
        if (tp && !(tp.injury && tp.injury.level)) tp.injury = { level: 3, at: now }
      }
      saveFake(f, gid)
    }
    st.askAt = now + AMBUSH_ASK_MIN * 60000
    st.phase = 'waiting'
    await redis.set(AMBUSH_KEY(gid, uid), JSON.stringify(st), { EX: 3600 })
    atPlayer(gid, uid, `\n🔍 有情况出现了！\n${passers.txt}\n来者身份不明，你看不清是谁……\n回复：#伏击打（偷袭）／ #伏击试探（现身）／ #伏击放`)
    return
  }
  if (st.phase === 'waiting' && now >= st.askAt) {
    await redis.del(AMBUSH_KEY(gid, uid))
    atPlayer(gid, uid, '\n🌙 你犹豫片刻，人影已消失在道路尽头……埋伏结束。')
    return
  }
  if (st.phase === 'won' && now >= (st.dispAt || 0)) {
    /* 超时未处置: 自动搜刮释放(诈降偷袭的目标直接放走, 免得反被偷袭) */
    try {
      const f = getFake(gid)
      const targets = st.names.map(n => f.roster[n]).filter(p => p && p.alive)
      if (st.reaction !== 'feint') {
        let lootMoney = 0
        for (const p of targets) {
          const real = Number(p.money) || 0
          const take = Math.round(real * (0.6 + Math.random() * 0.4))
          if (take > 0) { lootMoney += take; p.money = real - take }
          if (p.bag && p.bag.items) {
            for (const it of Object.keys(p.bag.items)) {
              if (isBound(it)) continue
              const raw = p.bag.items[it]
              for (const group of itemGroups(raw)) {
                try { addItem(String(uid), it, group.count, group.attr, gid) } catch (err) { }
              }
            }
            p.bag.items = {}
          }
        }
        if (lootMoney > 0) await playerMoney(gid, uid, lootMoney)
      }
      saveFake(f, gid)
    } catch (err) { }
    await redis.del(AMBUSH_KEY(gid, uid))
    /* 处置超时自动放走: 摘除伏击处置锁, 避免堵栈 */
    try { await unlock(gid, uid, 'ambush') } catch (err) { }
    atPlayer(gid, uid, '\n⏰ 你处置猎物犹豫过久，随手搜刮一番后将其放走……')
    return
  }
}

/** 推进单个伏击按群串行执行，避免超时释放覆盖处置击杀 */
export async function ambushTickOne (st, now = Date.now()) {
  return withFakeLock(st && st.gid, () => ambushTickOneUnlocked(st, now))
}

/** 推进所有伏击(每分钟由定时器调用) */
export async function ambushTick () {
  try {
    const keys = await redis.keys('xujing:ambush:*')
    if (!keys || !keys.length) return
    const now = Date.now()
    for (const k of keys) {
      try {
        const raw = await redis.get(k)
        if (!raw) continue
        const st = JSON.parse(raw)
        if (!st || !st.uid || !st.gid) continue
        await ambushTickOne(st, now)
      } catch (err) { }
    }
  } catch (err) { }
}
