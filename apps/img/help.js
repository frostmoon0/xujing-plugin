import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import fs from 'fs'
import path from 'path'
import lodash from 'lodash'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import cfg from '../../../../lib/config/config.js'
import Config from '../../model/Config.js'
import { Cfg, Common, Data, Version, Plugin_Name, Plugin_Path } from '../../components/index.js'
import { ITEM_TPL, MATERIAL_TPL, QUALITY, WANHUN_ONLY_MATS, getItemSource, fmtAttrRange, itemIcon, yaodanName } from '../../components/equip_data.js'

export class xujing_help extends plugin {
  constructor() {
    super({
      /** 功能名称 */
      name: '虚境插件_帮助',
      /** 功能描述 */
      dsc: '',
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 2000,
      rule: [
        {
          /** 命令正则匹配 */
          reg: '^[#＃]?(xujing|虚境)(帮助|版本)$',
          /** 执行方法 */
          fnc: 'message'
        },
        {
          /** 命令正则匹配 */
          reg: '^[#＃]?虚境管理帮助$',
          /** 执行方法 */
          fnc: 'adminHelp',
          /** 权限:仅主人可用 */
          auth: 'master'
        },
        {
          /** 命令正则匹配 */
          reg: '^[#＃]?(游戏)(规则|帮助|版本)$',
          /** 执行方法 */
          fnc: 'message2'
        },
        {
          /** 命令正则匹配 */
          reg: '^[#＃]?虚境(赞助|发电)$',
          /** 执行方法 */
          fnc: 'sponsor'
        },
        {
          /** 命令正则匹配 */
          reg: '^[#＃]?(道具目录|道具大全|道具图鉴|所有道具|道具列表)$',
          /** 执行方法 */
          fnc: 'itemList'
        }
      ]
    });
  }
  async sponsor(e) {
    e.reply('感谢支持！如果喜欢这个插件，请继续使用~')
  }

  /** #道具目录:渲染所有道具+获得方式图片(背景图用帮助背景图,无获取途径显示未知) */
  async itemList(e) {
    const groups = []
    /* 丹药 */
    groups.push({
      title: '💊 丹药',
      list: Object.keys(ITEM_TPL).map(name => {
        const source = getItemSource(name)
        return {
          name,
          icon: ITEM_TPL[name].icon || '💊',
          qCls: '',
          attr: ITEM_TPL[name].desc || '',
          source,
          sourceCls: source === '未知' ? 'unknown' : ''
        }
      })
    })
    /* 法宝/神物(定仙游/万魂幡/七彩神兵) */
    const artifactList = [
      {
        name: '定仙游', icon: itemIcon('定仙游'), qCls: 'q7',
        attr: '法宝：装备后生命+10%；拥有即生效 万魂窟撤退100%成功、免费跨区传送',
        source: `配方台合成(${itemIcon('神游蛊')}神游蛊×1+${itemIcon('玄阴玉')}玄阴玉×5+${itemIcon('镇魂晶')}镇魂晶×5+${itemIcon('血煞髓')}血煞髓×5)`,
        sourceCls: ''
      },
      {
        name: '万魂幡', icon: itemIcon('万魂幡'), qCls: 'q7',
        attr: '法宝：装备后收魂、主/副魂战力生效；可祭出百鬼助战/聚魂护体，最高九阶',
        source: `#打造万魂幡(${itemIcon('万魂幡残卷')}万魂幡残卷×5+🌈成长性特殊彩武×1+${itemIcon('阴魂砂')}阴魂砂×20+${itemIcon('游魂骨')}游魂骨×20)`,
        sourceCls: ''
      },
      {
        name: '七彩神兵', icon: itemIcon('七彩神兵'), qCls: 'q7',
        attr: '武器：成长型绑定神兵(初始攻击1,每1小时成长,满成长2000~3000)',
        source: `#铸造特殊彩武(${itemIcon('云裳仙蕊')}云裳仙蕊×6+1件${QUALITY[6].icon}红武器)`,
        sourceCls: ''
      }
    ]
    groups.push({ title: '🦋 法宝 · 神物', list: artifactList })
    /* 装备按品质归纳(同品质获取方式一致,不列具体装备名): 白/绿/蓝/紫/金/红/彩 */
    const QUALITY_SOURCE = {
      1: '器阁购买200灵石 · 新手礼包(新手6件)',
      2: '器阁购买1000灵石',
      3: '器阁购买4000灵石',
      4: '器阁购买12000灵石',
      5: '虚境秘境探索(平日10%/周六日20%) · 藏宝阁拍卖(2.5万~6万起拍)',
      6: '#制造红装(5种矿物各1合成) · 拍卖行/藏宝阁(1%概率上架)',
      7: `#制造彩装(${itemIcon('造梦神玉')}造梦神玉×6+1件${QUALITY[6].icon}红装 随机合成)`
    }
    const equipList = [1, 2, 3, 4, 5, 6, 7].map(q => {
      const qd = QUALITY[q] || { icon: '', name: '品质' }
      const source = QUALITY_SOURCE[q]
      const attr = q <= 4
        ? '属性固定'
        : `武器${fmtAttrRange('weapon', q)} / 防具${fmtAttrRange('chest', q)}`
      return {
        name: `${qd.name}品质`,
        icon: qd.icon || '',
        qCls: `q${q}`,
        attr,
        source,
        sourceCls: source === '未知' ? 'unknown' : ''
      }
    })
    groups.push({ title: '⚔️ 装备（按品质 · 白/绿/蓝/紫/金/红/彩）', list: equipList })
    /* 秘境材料(药材/矿物): 按品质归纳(剔除万魂窟专属材料, 单独一组) */
    const materialList = [4, 5, 6, 7].map(q => {
      const qd = QUALITY[q] || { icon: '', name: '品质' }
      const pool = Object.keys(MATERIAL_TPL).filter(k => MATERIAL_TPL[k].quality === q && !WANHUN_ONLY_MATS.has(k))
      const herbs = pool.filter(k => MATERIAL_TPL[k].type === 'herb')
      const ores = pool.filter(k => MATERIAL_TPL[k].type === 'ore')
      return {
        name: `${qd.name}材料`,
        icon: qd.icon || '',
        qCls: `q${q}`,
        attr: `药材：${herbs.map(k => `${itemIcon(k)}${k}`).join('、') || '无'} / 矿物：${ores.map(k => `${itemIcon(k)}${k}`).join('、') || '无'}`,
        source: '虚境秘境探索(爆率随境界提升,渡劫期吃满,周六日更高)',
        sourceCls: ''
      }
    })
    groups.push({ title: '🌿 秘境材料（药材/矿物 · 紫/金/红/彩）', list: materialList })
    /* 万魂窟材料(白~彩, 万魂窟专属): 无主幽魂/万魂幡残卷单列, 其余按品质归纳 */
    const wanhunList = [{
      name: '无主幽魂', icon: itemIcon('无主幽魂'), qCls: 'q1',
      attr: '幽魂本体(吸收获得,绑定)',
      source: '万魂窟探索中随机遇到幽魂 · 回复1吸收获得',
      sourceCls: ''
    }]
    for (const q of [1, 2, 3, 4, 5, 6, 7]) {
      const qd = QUALITY[q] || { icon: '', name: '品质' }
      const pool = Object.keys(MATERIAL_TPL).filter(k => MATERIAL_TPL[k].quality === q && WANHUN_ONLY_MATS.has(k) && k !== '万魂幡残卷')
      if (!pool.length) continue
      const herbs = pool.filter(k => MATERIAL_TPL[k].type === 'herb')
      const ores = pool.filter(k => MATERIAL_TPL[k].type === 'ore')
      wanhunList.push({
        name: `${qd.name}材料`,
        icon: qd.icon || '',
        qCls: `q${q}`,
        attr: `药材：${herbs.map(k => `${itemIcon(k)}${k}`).join('、') || '无'} / 矿物：${ores.map(k => `${itemIcon(k)}${k}`).join('、') || '无'}`,
        source: `西域万魂窟探索掉落(消耗1${itemIcon('魂石')}魂石 · #探索万魂窟)`,
        sourceCls: ''
      })
    }
    wanhunList.push({
      name: '万魂幡残卷', icon: itemIcon('万魂幡残卷'), qCls: 'q7',
      attr: '万魂幡核心材料(绑定)',
      source: '万魂窟探索30分钟后掉落, 停留越久概率越高',
      sourceCls: ''
    })
    groups.push({ title: '🕯️ 万魂窟材料（白~彩 · 西域万魂窟专属）', list: wanhunList })
    /* 残丹+妖丹(品质对应阶数): 妖丹=世界Boss掉落/残丹凝练; 残丹仅遗蜕秘境掉落, 傀儡打造/升级材料同组 */
    const yaodanList = [{
      name: '残丹', icon: itemIcon('残丹'), qCls: 'q1',
      attr: '品质白色 · 凝练妖丹的材料(5个合成1颗随机品质妖丹)',
      source: '仅遗蜕秘境(公开/专属)探索掉落 · #合成妖丹',
      sourceCls: ''
    }]
    for (const q of [1, 2, 3, 4, 5, 6, 7]) {
      const qd = QUALITY[q] || { icon: '', name: '品质' }
      const name = yaodanName(q)
      yaodanList.push({
        name,
        icon: itemIcon(name),
        qCls: `q${q}`,
        attr: `品质${qd.name} · 傀儡打造/升级材料`,
        source: '世界Boss掉落(每只Boss掉1枚,归伤害最高者;1/2/3/4档分别出1~3/2~4/3~6/6~7阶) · 或5个残丹#合成妖丹随机凝练',
        sourceCls: ''
      })
    }
    groups.push({ title: '🎖️ 妖丹（世界Boss掉落 · 5残丹可#合成妖丹）', list: yaodanList })
    const bg = await rodom()
    const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
    const img = await puppeteer.screenshot(`${Plugin_Name}/itemlist/index`, {
      tplFile: path.join(Plugin_Path, 'resources', 'itemlist', 'index.html'),
      pluResPath: resPath,
      _res_path: resPath,
      saveId: `itemlist-${Date.now()}`,
      bg,
      groups
    })
    if (img) e.reply(img)
    else e.reply('图片渲染失败，请检查 puppeteer~')
    return true
  }

  /** #全部玩法:转发返回所有玩法说明 */
  async allPlays(e) {
    const msgArr = [
      `🎮 虚境插件 · 玩法指南\n发送 #虚境帮助 可查看指令列表`,
      `【⚡ 境界系统】\n从炼气期一路修炼到仙帝，共17个大境界（每境分初期/中期/后期/巅峰）\n\n· #修炼 / #锻炼 / #晨练：修炼获得灵力，灵力攒满了就能突破下一阶\n· #突破：冲击突破，越往后成功率越低（吃破障丹可大幅提升成功率）\n· 境界越高，突破所需灵力越多，仙帝巅峰要50万灵力\n· 境界上限：仙帝第499重（到顶后不可再突破）\n· 查看：#我的等级 / #我的境界 / #决斗境界列表（看所有境界）`,
      `【⚔️ 装备系统】\n装备分6个部位：武器/头盔/胸甲/裤子/鞋子/戒指，品质从白到红（红最强）\n\n· 穿戴：#更换武器 装备名（不写名字可回复数字选）；#一键穿戴 自动穿最优\n· 脱下：#脱下武器 / #脱下全部\n· 卖掉：#一键出售 3（同时卖蓝色及以下装备和功法书，红装/红彩功法不可卖，按所在大区税率扣税）\n· 红装：#制造红装（用5种矿物各1个合成，随机部位随机属性）\n· 阵法核心：${itemIcon('天衍阵纹')}天衍阵纹/${itemIcon('乾坤阵晶')}乾坤阵晶/${itemIcon('太虚阵砂')}太虚阵砂/${itemIcon('九幽阵髓')}九幽阵髓各1+30万灵石合成${itemIcon('万阵核心')}万阵核心，布置阵法消耗1枚\n· 查看：#我的信息 看装备和背包`,
      `【💊 丹药】\n#服用丹药 [丹名] [数量]（不写丹名默认修为丹）\n#一键服用增益丹：一键吃所有增益丹各1颗（攻/防/血/暴击/爆伤/幸运/双修/挂机，持续1小时）\n· 修为丹：+200灵力；破障丹：突破成功率90%\n· 惊鸿丹：攻击+20% 1小时；玉甲丹：防御+20% 1小时\n· 凝露丹：生命+20% 1小时；慧心丹：暴击率+30% 1小时\n· 摄魂丹：爆伤+50% 1小时；聚宝丹：幸运(掉落提升) 1小时\n· 灵犀丹：双修收益翻倍 1小时；行运丹：挂机收益翻倍 1小时\n· 同心丹：好感度+1000\n· 仙帝丹：玩家不可服用；赠予伪玩家后自动服用，直升仙帝第10重（配方台合成，30万灵石）\n\n丹阁可购买修为丹/破障丹；#配方台 查看全部合成配方（#合成丹药名 数量 批量合成）`,
      `【🌿 秘境材料】
探索秘境会掉落药材和矿物（品质紫~彩）

· 药材（${itemIcon('望舒花')}望舒花/${itemIcon('星霜草')}星霜草等）：用来合成${itemIcon('惊鸿丹')}惊鸿丹
· 矿物（${itemIcon('月魄石')}月魄石/${itemIcon('流光玉')}流光玉等）：用来制造红色装备
· #使用宝盒：开启${itemIcon('灵宝盒')}灵宝盒直接获得丰厚奖励`,
      `【🤺 决斗】\n#决斗 @群友 和群友打一架（五局三胜）\n\n胜率看双方的境界和装备，输的人会被禁言\n每天对同一个人最多赢2次；抢老婆之前也要先决斗赢`,
      `【🌌 幻境试炼】\n#幻境试炼 挑战幻境守卫，比谁打出的伤害高（每天2次，0点重置）\n#幻境排行 / #幻境周榜 / #境界榜 看各类排行榜（图片）\n每天0点自动结算发奖`,
      `【🌌 遗蜕秘境】\n白名单群随机现世，随机大区/地形/难度，屏障破碎后探索30~120分钟；对应大区可直接攻击屏障，探索由系统推进\n#进入秘境：每位队员单独发送；#秘境状态：查看状态；#撤离：按贡献结算离场\n队伍会遇到玩家和伪玩家，可搜刮30%/全搜；击杀玩家只将其遣返本场，击杀伪玩家则让其身死道消，可用万魂幡吸魂\n彩色与简月舆图/血炼阵图合并为特殊彩奖励：每场命中后最多10件，天阶15%、地阶10%、玄阶7%、黄阶7%概率命中\n红功法可在遗蜕秘境极低概率获得；彩功法只能通过藏宝阁洗劫获得\n红色阵法材料（天衍阵纹/乾坤阵晶/太虚阵砂/九幽阵髓）可从遗蜕秘境、每日秘境、藏宝阁洗劫获得；四种各1+30万灵石可合成万阵核心，布置阵法消耗1枚`,
      `【❤️ 娶群友/婚姻】\n· #娶群友：随机娶一位群友\n· #娶 @群友 / #嫁 @群友：向指定的人求婚（对方回 #我愿意 / #我拒绝）\n· #强娶 @群友：强行娶走（看运气）\n· #抢老婆：把别人的老婆抢过来（需先决斗赢）\n· 相处：#抱抱 加好感 / #双修 一起修炼得灵力\n· 闹掰：#闹离婚 / #分手 离婚；#甩掉 @某人 甩掉双修对象\n· #群cp：看看群里谁和谁在一起了`,
      `【🏠 房子】\n· #看房：看自己住的房子\n· #升级房子：花灵石升级（可@帮别人升），加成和能住的人越来越多\n· #住所改名xxx：给房子起个名字\n\n房子等级越高，修炼/挂机/摆摊/好感的加成越高，能住的老婆+小妾也越多`,
      `【💰 赚钱】\n· #摆摊：摆摊赚灵石\n· #挂机结算：结算自动挂机收益（灵石+灵力）\n· #抢劫 @群友：抢走对方灵石（每天同一人只能抢一次）\n\n限时秘境：每天20:00-24:00开放（周一青云~周日瑶池），周六日爆率更高`,
      `【🏮 逛街集市】\n#逛街 进入虚境集市（也能直接 #丹阁/#去丹阁、#器阁/#去器阁、#藏宝阁/#去藏宝阁、#去逛逛）\n· 丹阁/器阁/藏宝阁按你所在大区独立补货（数量时间各区不一），售罄会提示其他大区库存与补货时间\n· 丹阁：购买${itemIcon('修为丹')}修为丹/${itemIcon('破障丹')}破障丹\n· 器阁：购买白~紫品质装备\n· 藏宝阁：购买功法（金及以下，买卖列表为图片）\n· 逛逛：随机事件，可能获得灵石或好感`,
      `【📖 功法】\n功法共31种（白绿蓝紫金红彩），带攻击/防御/生命/暴击/爆伤等属性加成，也有幸运/挂机/抢劫/双修/突破等玩法特效，一个功法可有多种效果\n· #去藏宝阁：购买功法书（金及以下）\n· #修炼功法 <名>：消耗功法书学会\n· #运转功法 <名>：激活（同时只能运转一本，傀儡术篇章无需运转）\n· #功法：看我的功法库  ·  #功法图鉴：看全部31种（图片）\n· 🌈傀儡术下/中/上篇按顺序学习，仅解锁傀儡阶位，不提供额外战斗效果；重复篇章可用 #分解傀儡术下篇 [数量] 分解，获得对应数量的🌈功法残卷\n· #傀儡列表 / #打造傀儡 / #装备傀儡 序号 / #祭出傀儡：管理傀儡法宝（祭出后傀儡战力按3倍计入）\n· #卖功法 <名> <数量>：功法书半价卖回\n红功法可在虚境秘境极低概率获得；傀儡术篇章从秘境探索小事件成功奖励和成功屠皇城获得\n红色阵法材料（天衍阵纹/乾坤阵晶/太虚阵砂/九幽阵髓）可从遗蜕秘境、每日秘境、藏宝阁洗劫获得；四种各1+30万灵石可合成万阵核心，布置阵法消耗1枚`,
      `【🏪 交易系统】\n拍卖：\n· #虚境拍卖行：查看本群拍卖（同 #拍卖行 / #虚境拍卖会 / #拍卖会）\n· #虚境上架 道具名 数量 起拍价 [一口价] [时长]：挂上去卖（时长不填随机3~24小时）\n· #虚境出价 编号 金额：出价竞拍（编号看拍卖行列表）\n· #虚境一口价 编号：按一口价直接买断\n· #虚境下架 编号：把商品撤下来\n· 无人出价可能随机提前下架；成交结算按卖家所在大区税率扣税\n· 藏宝阁每天随机上架3~10件好物（含金装/丹药/材料），上架时长也随机\n\n赠送：\n· #虚境赠送 @群友 道具/灵石 数量：送给群友（同大区按区税率扣税）\n· 写法很自由：#虚境送 / #虚境赠 / #送 / #赠 / #送金币 / #送钱 / #送东西 都行，顺序随意、可免空格`,
      `【🏮 藏宝阁洗劫】\n每晚20:30-24:00 开放夜袭！\n· #洗劫藏宝阁：夜袭藏宝阁\n· #确认洗劫：看20档难度明细（档位越高宝贝越好守卫越强）\n· #洗劫 1-20：选档开抢\n· #终止洗劫：提前收手转逃亡（10分钟）\n· #围剿 @正在洗劫的人：螳螂捕蝉黄雀在后，抢他的战利品\n· #洗劫状态：看当前进度；昨天被洗劫过的话今天藏宝阁好货会变少`,
      `【🌍 修仙世界·宗门经济】\n五大大区（中州/东海/西域/北境/南疆）由8大宗门占领，有霸主的大区税收全归霸主！\n· #去中州（或 东海/西域/北境/南疆）：跨区旅行，可回复 1 强行跨越 / 2 传送阵 直接选\n· 强行跨越：80%成功，5分钟到达，失败随机掉0~3境界\n· 传送阵：2000灵石瞬间到达，费用交给【离开】的大区\n· #交易 @玩家 金额 / #互动 @道侣：需同一大区，按该区动态税率扣税\n· 霸主宗门弟子（玩家+伪玩家）在自己霸主的大区活动，税率减半！\n· #宗门繁荣 / #宗门占领 / #税率 / #全区税率：查看经济状况（税率10%~50%随繁荣度浮动）\n· #虚境地图：查看整个虚境全图（含简月王朝）`,
      `【🏮 简月王朝（凡人王朝）】\n修仙界之下的一方凡人疆域（在南疆以南），不可占领、不可攻打，只产【云裳仙蕊】！\n· #王朝小区：查看9座凡间城池（人口/库存/产出/状态/本宗好感）\n· #进入王朝：须先到南疆，再消耗【简月舆图】永久解锁进入（图可于遗蜕秘境特殊彩奖励获得）\n· 城池每小时按概率产1朵云裳仙蕊（皇城10%/其余5%）：50%按宗门好感加权送入宗门宝库，否则入城池库存\n· 屠城：装备【万魂幡】+ 学会【血炼大阵】后 #屠城 城名 布置读阵30分钟，读阵中每分钟消耗1万灵石；余额不足自动停止并销毁大阵，需重新布置；读满=收魂(1人1魂)+洗劫干净库存，城池进6~88小时废墟，本宗在该城好感下降\n· #学习血炼阵：消耗【血炼阵图】学会（阵图可于遗蜕秘境特殊彩奖励获得）；布置需无主幽魂×5、阴魂砂×20、游魂骨×20、万阵核心×1\n· #阻止屠城 城名：身在王朝且有宗门者可代表本宗阻止他人读阵，该城对本宗好感+10\n· #王朝好感 城名：查看宗门好感明细（宗门好感越高越容易收到云裳仙蕊）\n· #虚境地图：查看整个虚境全图（含简月王朝）`,
      `【📜 天下大事·宗门江湖】\n100位伪玩家（有正邪善恶、魔修嗜杀）分布于宗门，每天发生0~200起千奇百怪的事件！每个群都有各自独立的江湖，互不干扰\n· #天下大事：查看本群最近24小时江湖动态（同 #查看天下大事）\n· #天下宗门：看各宗宗主/长老/弟子名单和地盘\n· #宗门详情 宗门名：看宗门内部全员（修为/正邪/性格/战绩）\n· #查人 名字：看单个修士详情（战力/装备/功法/丹药/关系）\n· #战力榜：看本群伪玩家战力排行前20（同 #江湖强者）\n· #天下灵石：看本群玩家灵石财富排行前20（同 #财富榜/#灵石榜）\n· #江湖交易：看伪修士在丹阁/器阁/藏宝阁的购买记录（伪玩家会自己买装备丹药，每5分钟限购1件，交易计入补货活跃）\n· 伪玩家和玩家一样生活：摆摊正常交税、跨大区远行（去中州/南疆等地）、买装备丹药、穿装备运转功法服丹药（加成算进战力）、挂机/领低保、炼丹/秘境、双修/上交/夺爱/情变、互赠/打劫/灭口、结仇拜师娶道侣（只发生在伪玩家之间，不影响真实玩家）\n· 宗门会被攻打、有人会叛逃成散修、灭门后换名重建慢慢招徒`,
      `【🏯 玩家宗门系统】\n加入宗门当主人，能创建宗门/当宗主太上/攻打宗门！\n· 伪玩家宗主宗门：达标后 #晋升 [执事/副宗/太上] 自动擢升\n· 玩家宗主宗门：宗主可直接 #任命（不用条件），副宗任命需达标\n· 晋升条件：贡献（#上供 攒）+ 修为 + 入宗天数，详见 #宗门玩法\n· 宗主/太上无需贡献点：可 #取用宝库 [灵石/物品名] [数量] 随时取用宗门金库的灵石/材料/丹药\n· #迁宗 [大区]：宗主/副宗/太上把宗门总部迁往新大区（宝库扣20万灵石、须到新址奠基、旧区地盘保留、24小时冷却）\n· #天下矿山：查看本群所有宗门矿山（含伪玩家宗门，战俘挖矿产出入宗门宝库）`,
      `【🐲 世界Boss】\n每群有各自独立的世界Boss，随机大区现世，本群共同讨伐！\n· #攻击boss：与Boss同大区，发送一次即自动持续讨伐（每20秒一次，无需反复发送；#停止攻击 退出）\n· #boss刷新：主人专用，安排当前群下一只Boss约1分钟后刷新（已有Boss现世/逃亡中不覆盖）\n· #boss状态：看血量与伤害排行（每10分钟自动播报）\n· 击杀后按伤害占比分赃，并掉落${itemIcon('登仙令')}【登仙令】\n· #抢夺登仙令：抢先夺令；@持令者 可继续争夺（同区），1分钟内没人抢到就收入囊中\n· 1小时没打死Boss会逃遁：逃跑后带着残血复活（按逃跑时长回血，每小时15%），3次没杀彻底则消失；凌晨1~6点暂停`,
      `【👑 管理命令】\n仅管理员可用：#虚境管理帮助 看完整清单\n· 发放：#虚境灵力/修为/道具/金币/好感/房子/双修/挂机 @群友 数量\n· 全群发放：#一键虚境道具 道具名 数量（当前群全部玩家）\n· 扣除：#虚境扣除灵力/修为/道具/金币/好感/房子/双修/挂机 @群友 数量\n· #虚境查看 @群友 / #虚境配置 / #虚境设置/回收权能`
    ]
    Config.getforwardMsg(msgArr, e)
    return true
  }

  async message(e) {
    return await help(e, 'help');
  }
  async message2(e) {
    return await help(e, 'help');
  }
  /** #虚境管理帮助:与主面板相同渲染,仅显示管理员命令 */
  async adminHelp(e) {
    if (!e.isMaster) {
      e.reply('凡人，休得僭越！此命令仅管理员可用~')
      return true
    }
    return await help(e, 'help', 'admin')
  }
}

async function help(e, key, mode = 'all') {
  let { diyCfg, sysCfg } = await Data.importCfg(key)

  // custom 变量原为 dead code(恒为空对象), 直接移除
  let helpConfig = lodash.defaults(diyCfg.helpCfg || {}, sysCfg.helpCfg)
  let helpList = diyCfg.helpList || sysCfg.helpList
  let helpGroup = []

  lodash.forEach(helpList, (group) => {
    // 管理帮助:只显示管理员分组
    if (mode === 'admin') {
      if (group.auth && group.auth === 'master') {
        helpGroup.push(group)
      }
      return true
    }
    // 普通帮助:始终隐藏管理分组(管理指令仅在 #虚境管理帮助 显示)
    if (group.auth && group.auth === 'master') {
      return true
    }

    helpGroup.push(group)
  })

  // 管理帮助:替换标题
  if (mode === 'admin') {
    helpConfig = lodash.defaults({
      title: '虚境·管理帮助',
      subTitle: 'xujing-yue-plugin · 仅管理员可用'
    }, helpConfig)
  }

  let bg = await rodom()
  let colCount = 2;
  return await Common.render('help/index', {
    helpCfg: helpConfig,
    helpGroup,
    bg,
    colCount,
    // element: 'default'
  }, {
    e,
    scale: 2.0
  })
}

const rodom = async function () {
  const imageDir = path.join(Plugin_Path, 'resources', 'help', 'imgs')
  if (!fs.existsSync(imageDir)) {
    return ''
  }
  var image = fs.readdirSync(imageDir)
  var list_img = [];
  for (let val of image) {
    list_img.push(val)
  }
  var imgs = list_img.length == 1 ? list_img[0] : list_img[lodash.random(0, list_img.length - 1)];
  return imgs;
}