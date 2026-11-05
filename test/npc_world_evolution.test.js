import { resolveSectAttacks } from '../components/sect/war.js'
import { REGIONS } from '../components/world_data.js'
import { spawnAiSectAttacks } from '../components/sect/war.js'
import { joinPlayerSect } from '../components/sect/hr.js'
import { disposeFakeCaptives } from '../components/sect/captive.js'
import { fillSects } from '../components/sect/economy.js'
import { sectMemberCapacity, canAdmitSectNpc, admitSectNpc } from '../components/sect/capacity.js'
import { hasBloodFeud, defeatDeathRate, temperCaptiveWeights } from '../components/sect/survival.js'
import { addPerson, fakeJoinSect, overCapSettle } from '../components/fake_data.js'
import { planAiCoalition } from '../components/sect/war.js'
import { assessSectDevelopment } from '../components/sect/ai_strategy.js'
import { poachFakeFromSect } from '../components/sect/hr.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Save_Path } from '../components/plugin.js'
import { npcCanAct, resolveNpcEncounter } from '../components/npc_action.js'
import { npcConflict, genMurder, rebuildSettle, cleanSectMaps, getFake } from '../components/fake_data.js'
import { finishSectDissolutions } from '../components/sect/succession.js'
import { normalizeDiplomacy, setDiplomacyRelation, hasTruce, diplomacyPair, forgetSectDiplomacy, DIPLOMACY_TERM } from '../components/sect/diplomacy_state.js'
import { aiDiplomacy, ceasefireBetween, breakAlly } from '../components/sect/diplomacy.js'
import { startSectAttack, startRogueAttack, deploymentPower, computeDefPower } from '../components/sect/war.js'
import { withHomeReserve } from '../components/sect/war_roster.js'
import puppeteer from '../model/robot/puppeteer/puppeteer.js'
let seq = 0
const gids = []
const cache = new Map()
global.logger ||= { error () {}, warn () {}, info () {} }
global.Bot = { pickGroup: () => ({ sendMsg: async () => true }) }
global.segment = { at: qq => ({ type: 'at', qq }) }
global.redis = { async get(k) { return cache.get(k) ?? null }, async set(k,v) { cache.set(k,String(v)); return 'OK' }, async del(k) { cache.delete(k) }, async keys() { return [] } }
test.before(() => test.mock.method(puppeteer, 'screenshot', async () => false))
function fixture () {
  const gid = `npc_v2_${process.pid}_${++seq}`; gids.push(gid)
  const person = (name, sect) => ({ name, sect, alive: true, status: 'sect', pos: 'dizi', loc: 'center', level: 12, joinAt: 1, lifeAt: 1, money: 1000, loyalty: 80, trait: '平和', path: '正道', relations: { enemies: [], friends: [] }, bag: { items: {}, equipped: {}, artifacts: {} } })
  return { gid, pool: [], poolBans: {}, sectSeq: 10, major: [], minor: [], byPerson: {}, trades: [], players: {}, targetCd: {}, sectAttacks: [], areas: { 天墉城: 'b' }, areaDef: {}, roster: { 甲: person('甲','a'), 乙: person('乙','b') }, sectMap: Object.fromEntries(['a','b','c'].map(id=>[id,{ zongzhu:null,taishang:[],fuzong:[],zhishi:[],dizi:[]} ])), sects: Object.fromEntries(['a','b','c'].map(id=>[id,{ name:id,region:'center',owner:null,allies:[],enemies:[],facilities:{},vault:{stones:100000,mats:{},pills:{}} }])) }
}
test.after(() => { for (const gid of gids) for (const name of [`world/fake_${gid}.json`,`world/world_${gid}.json`]) for (const suffix of ['', '.bak']) fs.rmSync(path.join(Save_Path,name+suffix),{force:true}) })
for (const kind of ['realm','travel','war','share-captive','jail','raid-jail','mine']) test(`活动资格排除${kind}`, () => {
 const f=fixture(), p=f.roster.甲
 if(kind==='realm') p.realmBusy={}
 if(kind==='travel') p.fakeTravel={}
 if(kind==='war') f.sectAttacks=[{phase:'fight',atkFakes:['甲']}]
 if(kind==='share-captive') f.sectAttacks=[{phase:'done',captives:{byShare:{b:{fakes:['甲']}}}}]
 if(kind==='jail') f.sectJails={b:[{name:'甲'}]}
 if(kind==='raid-jail') f.raidJail=[{name:'甲',until:Date.now()+60000}]
 if(kind==='mine') f.sectMines={b:[{name:'甲'}]}
 assert.equal(npcCanAct(f,p),false)
})
test('明显不敌不交战、不抢钱、不杀人', () => { const f=fixture();const r=resolveNpcEncounter(f,[f.roster.甲],f.roster.乙,p=>p.name==='甲'?1:100);assert.equal(r.reason,'outmatched');assert.equal(f.roster.乙.money,1000);assert.equal(f.roster.乙.injury,undefined) })
test('异地目标不能隔空受伤',()=>{const f=fixture();f.roster.乙.loc='east';assert.equal(resolveNpcEncounter(f,[f.roster.甲],f.roster.乙,()=>100).ok,false)})
test('失败不转移财物，攻击者负伤',t=>{t.mock.method(Math,'random',()=>0.99);const f=fixture();const r=npcConflict(f,[f.roster.甲],f.roster.乙,Date.now(),{lethal:true});assert.equal(r.won,false);assert.equal(f.roster.乙.money,1000);assert.equal(f.roster.甲.injury.level,2)})
test('获胜可不致死，重复攻击受限',t=>{t.mock.method(Math,'random',()=>0.5);const f=fixture();f.roster.甲.level=100;const r=npcConflict(f,[f.roster.甲],f.roster.乙,Date.now(),{lethal:true});assert.equal(r.won,true);assert.equal(r.killed,false);assert.ok(f.roster.乙.injury);assert.equal(npcConflict(f,[f.roster.甲],f.roster.乙,Date.now()).ok,false)})
test('恶人真实获胜后仍可能杀人',t=>{t.mock.method(Math,'random',()=>0);const f=fixture();f.roster.甲.level=100;f.roster.甲.trait='嗜杀';const r=npcConflict(f,[f.roster.甲],f.roster.乙,Date.now(),{lethal:true});assert.equal(r.killed,true);assert.equal(f.roster.乙,undefined)})
test('仇杀生成器不越级强杀',t=>{t.mock.method(Math,'random',()=>0);const f=fixture();f.roster.甲.trait='嗜杀';f.roster.乙.level=100;genMurder(f,Date.now());assert.ok(f.roster.乙.alive);assert.equal(f.roster.乙.money,1000)})
test('普通门人继任保留地盘、修为和ID',()=>{const f=fixture();f.areas.天墉城='a';rebuildSettle(f);assert.equal(f.sectMap.a.zongzhu,'甲');assert.equal(f.roster.甲.level,12);assert.equal(f.areas.天墉城,'a');assert.equal(f.sects.a.wipeAt,undefined)})
test('暂时被俘的在世宗主不被替换',()=>{const f=fixture();f.roster.甲.pos='zongzhu';f.sectMap.a.zongzhu='甲';f.roster.甲.realmBusy={};cleanSectMaps(f);rebuildSettle(f);assert.equal(f.sectMap.a.zongzhu,'甲');assert.equal(f.sects.a.wipeAt,undefined)})
test('全员脱不开身仍不判灭门',()=>{const f=fixture();f.roster.甲.fakeTravel={};rebuildSettle(f);assert.equal(f.sects.a.wipeAt,undefined);assert.equal(f.sectMap.a.zongzhu,null)})
test('真人成员身份不由AI核心空缺清除',()=>{const f=fixture();f.players['1']={sect:'a',pos:'dizi'};rebuildSettle(f);assert.equal(f.players['1'].sect,'a');assert.equal(f.sectMap.a.zongzhu,null)})
test('旧式已覆灭标记不自动复活换名',()=>{const f=fixture();f.sects.a.wipeAt=1;f.sects.a.rebuildAt=1;rebuildSettle(f);assert.equal(f.sects.a.name,'a');assert.equal(f.sects.a.wipeAt,1)})
test('空宗自然消亡先释放后除名，不凭空生成宗主',async()=>{const f=fixture();delete f.roster.乙;rebuildSettle(f);let released=false;await finishSectDissolutions(f,f.gid,Date.now(),{liberate:async()=>{released=true},unmark:async()=>{},forget:forgetSectDiplomacy});assert.ok(released);assert.equal(f.sects.b,undefined);assert.equal(f.areas.天墉城,undefined);assert.equal(Object.keys(f.roster).length,1)})
test('演化后空世界重载不重置历史',()=>{const f=fixture();f.preRan=true;f.worldLifecycleVersion=2;f.sects={};f.roster={};fs.mkdirSync(path.join(Save_Path,'world'),{recursive:true});fs.writeFileSync(path.join(Save_Path,'world',`fake_${f.gid}.json`),JSON.stringify(f));assert.equal(Object.keys(getFake(f.gid).roster).length,0)})
test('旧档单边敌友冲突归一为双边敌对',()=>{const f=fixture();f.sects.a.allies=['b'];f.sects.b.enemies=['a'];normalizeDiplomacy(f);assert.deepEqual(f.sects.a.allies,[]);assert.deepEqual(f.sects.a.enemies,['b']);assert.deepEqual(f.sects.b.enemies,['a']);assert.equal(normalizeDiplomacy(f),false)})
test('盟约观察期内AI不随机退盟，手动退盟仍可用',t=>{t.mock.method(Math,'random',()=>0);const f=fixture();setDiplomacyRelation(f,'a','b','allied');aiDiplomacy(f,f.gid);assert.ok(f.sects.a.allies.includes('b'));f.players['1']={sect:'a',pos:'zongzhu'};assert.equal(breakAlly(f,f.gid,'1','b').ok,true);assert.ok(!f.sects.a.allies.includes('b'))})
test('停战跨目标，第三方不受保护，序列化后仍有效',()=>{const f=fixture();const now=Date.now();ceasefireBetween(f,f.gid,'a','b',now);assert.ok(hasTruce(JSON.parse(JSON.stringify(f)),'b','a',now+1));assert.equal(hasTruce(f,'c','b',now+1),false);assert.equal(hasTruce(f,'a','b',now+DIPLOMACY_TERM),false);assert.equal(setDiplomacyRelation(f,'a','b','hostile',now+1),false)})
test('总部和小区入口都不能绕过双边停战',async()=>{const f=fixture();ceasefireBetween(f,f.gid,'a','b');for(const target of ['b','天墉城']){const r=await startSectAttack(f,f.gid,'a',target,'ai');assert.equal(r.ok,false);assert.match(r.msg,/停战/)}assert.equal(f.sectAttacks.length,0)})
test('小队成员所属宗门停战也要检查',async()=>{const f=fixture();f.players['1']={sect:'a'};f.rogueTeams={'1':{leader:'1',members:['1','2'],name:'队'}};ceasefireBetween(f,f.gid,'a','b');const r=await startRogueAttack(f,f.gid,'1','b');assert.equal(r.ok,false);assert.match(r.msg,/停战/)})
test('实际可派阵容不足时不扣钱不宣战',async()=>{const f=fixture();f.roster.甲.level=1;f.roster.乙.level=100;const before=f.sects.a.vault.stones;const r=await startSectAttack(f,f.gid,'a','b','ai',{count:1});assert.equal(r.ok,false);assert.match(r.msg,/实际可派/);assert.equal(f.sects.a.vault.stones,before);assert.equal(f.sectAttacks.length,0);assert.deepEqual(f.sects.a.enemies,[])})
test('AI留守使用真实人员，玩家手动调兵不被强制留守',()=>{const f=fixture();f.roster.丙={...f.roster.甲,name:'丙',level:20};f.roster.丁={...f.roster.甲,name:'丁',level:30};const all=[f.roster.甲,f.roster.丙,f.roster.丁];assert.equal(withHomeReserve(f,'a',all).length,2);f.sects.a.owner='1';assert.equal(withHomeReserve(f,'a',all).length,3)})
test('预估和真实防守复用同一阵型公式',async()=>{const f=fixture();f.sects.b.facilities.hushan=2;const war={id:12,phase:'prep',atkSect:'a',defSect:'b',target:'b',targetType:'sect',atkFakes:[],defFakes:['乙'],atkPlayers:[],defPlayers:[]};f.sectAttacks=[war];assert.equal(await computeDefPower(f,f.gid,war),deploymentPower(f,'b',[f.roster.乙],[],{defense:true,target:'b'}))})
test('宗门除名清除双方关系与成对记忆',()=>{const f=fixture();setDiplomacyRelation(f,'a','b','allied');forgetSectDiplomacy(f,'b');delete f.sects.b;normalizeDiplomacy(f);assert.deepEqual(f.sects.a.allies,[]);assert.ok(!Object.values(f.diplomacyPairs).some(r=>r.a==='b'||r.b==='b'))})

test('玩家挖角高手保留实际修为与生涯标记',t=>{t.mock.method(Math,'random',()=>0);const f=fixture();f.sects.a.owner='1';f.roster.乙.level=68;f.roster.乙.loyalty=0;f.roster.乙.trait='好斗';f.sectMap.b.dizi=['乙'];const r=poachFakeFromSect(f,f.gid,'a','乙');assert.equal(r.ok,true,r.msg);assert.equal(f.roster.乙.level,68);assert.equal(f.roster.乙.lifeAt,1);assert.equal(f.roster.乙.sect,'a')})
test('玩家可以主动承担弱势出兵风险',async()=>{const f=fixture();f.sects.a.owner='1';f.roster.甲.level=1;f.roster.乙.level=100;const r=await startSectAttack(f,f.gid,'a','b','player',{count:1});assert.equal(r.ok,true,r.msg)})

test('钱不够保留储备时经营，不开战也不凭空补钱',()=>{const f=fixture();f.sects.a.vault.stones=100;const r=assessSectDevelopment(f,'a',Date.now(),{attackCost:100,reserveCost:100});assert.equal(r.phase,'develop');assert.equal(f.sects.a.vault.stones,100)})
test('战败后休养8小时，守方同样按自己的胜负判断',()=>{const f=fixture(),now=Date.now();f.sectAttacks=[{phase:'done',result:'win',atkSect:'b',defSect:'a',endAt:now}];assert.equal(assessSectDevelopment(f,'a',now+7*3600000).phase,'recover');assert.equal(assessSectDevelopment(f,'a',now+8*3600000).ready,true)})
test('战胜后整顿4小时，期满可扩张',()=>{const f=fixture(),now=Date.now();f.sectAttacks=[{phase:'done',result:'win',atkSect:'a',defSect:'b',endAt:now}];assert.equal(assessSectDevelopment(f,'a',now+3*3600000).ready,false);assert.equal(assessSectDevelopment(f,'a',now+4*3600000).ready,true)})
test('中重伤过多先恢复，期满自然恢复行动资格',()=>{const f=fixture(),now=Date.now();f.roster.甲.injury={level:2,at:now};assert.equal(assessSectDevelopment(f,'a',now).phase,'recover');assert.equal(assessSectDevelopment(f,'a',now+120*60000).ready,true)})
test('发展状态重算不改变开始时间，不抢真人决策',()=>{const f=fixture(),now=Date.now();assessSectDevelopment(f,'a',now);assessSectDevelopment(f,'a',now+60000);assert.equal(f.sects.a.aiStrategy.since,now);f.sects.a.owner='1';assert.equal(assessSectDevelopment(f,'a',now).phase,'player')})

test('玩家和NPC统一最高70，旧八级设施也不能突破',()=>{const f=fixture();f.sects.a.facilities.yanwu=8;for(let i=0;i<97;i++) f.roster['门人'+i]={...f.roster.甲,name:'门人'+i};assert.equal(sectMemberCapacity(f,'a'),70);assert.equal(canAdmitSectNpc(f,'a'),false);f.sects.a.owner='1';assert.equal(sectMemberCapacity(f,'a'),70)})
test('批量入宗只接纳剩余名额，保留未接纳者归属和修为',()=>{const f=fixture();for(let i=0;i<18;i++)f.roster['门人'+i]={...f.roster.甲,name:'门人'+i};const a={...f.roster.乙,name:'新甲',level:68},b={...f.roster.乙,name:'新乙',level:69};f.roster[a.name]=a;f.roster[b.name]=b;assert.equal(admitSectNpc(f,a,'a'),true);assert.equal(admitSectNpc(f,b,'a'),false);assert.equal(a.level,68);assert.equal(b.sect,'b');assert.equal(b.level,69)})
test('底层新增与散修入宗都不能突破容量',()=>{const f=fixture();for(let i=0;i<19;i++)f.roster['门人'+i]={...f.roster.甲,name:'门人'+i};assert.equal(addPerson(f,'新人','a','dizi',1),null);f.roster.游侠={...f.roster.乙,name:'游侠',sect:null,status:'scatter'};assert.equal(fakeJoinSect(f,'游侠','a'),null);assert.equal(f.roster.游侠.status,'scatter')})
test('同一成员重复接纳不占新名额或降职',()=>{const f=fixture();f.roster.甲.pos='zongzhu';assert.equal(admitSectNpc(f,f.roster.甲,'a'),true);assert.equal(f.roster.甲.pos,'zongzhu')})
test('普通争执不再把战败死亡率设为50%',()=>{assert.ok(defeatDeathRate(36)<5);assert.ok(defeatDeathRate(36,{crush:true})<10);assert.ok(defeatDeathRate(36,{bloodFeud:true})<15);assert.ok(defeatDeathRate(68,{crush:true})<defeatDeathRate(1,{crush:true}))})
test('血仇校验人物生涯，不把普通仇人当死仇',()=>{const f=fixture(),a=f.roster.甲,b=f.roster.乙;a.relations.enemies=['乙'];assert.equal(hasBloodFeud(a,b),false);a.bloodEnemies={乙:1};assert.equal(hasBloodFeud(a,b),true);b.lifeAt=2;assert.equal(hasBloodFeud(a,b),false)})
test('AI无血仇减少处决倾向，真实血仇保留',()=>{const w={kill:0.4,robKill:0.5,free:0.3};assert.ok(temperCaptiveWeights(w).kill<w.kill);assert.equal(temperCaptiveWeights(w,{bloodFeud:true}),w);assert.ok(temperCaptiveWeights(w,{cruelty:0.6}).kill>temperCaptiveWeights(w).kill)})
function coalitionFixture(){const f=fixture();f.roster.甲.level=14;f.roster.乙.level=29;f.roster.丙={...f.roster.甲,name:'丙',sect:'c'};for(let i=0;i<12;i++)f.areas['地盘'+i]='b';setDiplomacyRelation(f,'a','c','allied');return f}
test('联合出兵只计算真实可派AI盟友，真人宗主不被代派',t=>{t.mock.method(Math,'random',()=>0);const f=coalitionFixture();const plans=planAiCoalition(f,f.gid,'a','b','center');assert.equal(plans.length,1);assert.deepEqual(plans[0].plan.units.map(x=>x.name),['丙']);f.sects.c.owner='3';assert.deepEqual(planAiCoalition(f,f.gid,'a','b','center'),[])})
test('弱宗可以用真实合军通过最终风险复核',async t=>{t.mock.method(Math,'random',()=>0);const f=coalitionFixture();const plans=planAiCoalition(f,f.gid,'a','b','center');const r=await startSectAttack(f,f.gid,'a','b','ai',{coalitionPlans:plans,tactic:'正面强攻'});assert.equal(r.ok,true,r.msg);assert.deepEqual(new Set(r.atk.atkFakes),new Set(['甲','丙']));assert.equal(r.atk.actorSects['fake:丙'],'c');assert.ok(r.atk.coalition.c)})
test('盟友预算在提交前变化则整场取消，不扣主宗费用',async t=>{t.mock.method(Math,'random',()=>0);const f=coalitionFixture();f.roster.丙.loc='east';const plans=planAiCoalition(f,f.gid,'a','b','center');assert.equal(plans.length,1);const before=f.sects.a.vault.stones;f.sects.c.vault.stones=0;const r=await startSectAttack(f,f.gid,'a','b','ai',{coalitionPlans:plans});assert.equal(r.ok,false);assert.equal(f.sects.a.vault.stones,before);assert.equal(f.sectAttacks.length,0)})
test('有双边停战的盟友不能参加联合攻打',t=>{t.mock.method(Math,'random',()=>0);const f=coalitionFixture();setDiplomacyRelation(f,'c','b','neutral',Date.now(),'停战',{truce:true});assert.deepEqual(planAiCoalition(f,f.gid,'a','b','center'),[])})
test('联军支援者同样需要战后休养',()=>{const f=fixture(),now=Date.now();f.sectAttacks=[{phase:'done',atkSect:'b',defSect:'c',coalition:{a:{}},result:'lose',endAt:now}];assert.equal(assessSectDevelopment(f,'a',now+7*3600000).phase,'recover')})

test('旧档超员转为散修，保留修为装备关系，战场人物暂不迁移',()=>{const f=fixture();f.roster.甲.level=60;f.sects.a.facilities.yanwu=5;for(let i=0;i<97;i++)f.roster['门人'+i]={...f.roster.甲,name:'门人'+i,level:60};const p=f.roster.门人0;f.sectAttacks=[{id:1,phase:'fight',atkFakes:[p.name],defFakes:[]}];const before=Object.keys(f.roster).length;overCapSettle(f);assert.equal(Object.keys(f.roster).length,before);assert.equal(p.sect,'a');const departed=Object.values(f.roster).filter(x=>x.status==='scatter');assert.equal(departed.length,28);assert.equal(departed[0].level,60);assert.equal(Object.values(f.roster).filter(x=>x.sect==='a').length,70)})

test('普通俘虏减少处决和送矿，减少的权重转为释放',()=>{const w={free:0.2,recruit:0.2,robFree:0.1,kill:0.2,robKill:0.2,mine:0.1,jail:0.1};const z=temperCaptiveWeights(w);assert.ok(z.free>w.free);assert.ok(z.mine<w.mine);assert.ok(Math.abs(Object.values(w).reduce((a,b)=>a+b,0)-Object.values(z).reduce((a,b)=>a+b,0))<1e-9)})
test('全世界满399人时不补建无宗主空壳',()=>{const f=fixture();for(let i=0;i<397;i++)f.roster['散修'+i]={...f.roster.甲,name:'散修'+i,status:'scatter',sect:null};assert.equal(fillSects(f),0);assert.equal(Object.keys(f.sects).length,3)})
test('自动整批收编逐人复核容量，满员后活人释放',async t=>{t.mock.method(Math,'random',()=>0.8);const f=fixture();f.roster.甲.pos='zongzhu';f.sectMap.a.zongzhu='甲';for(let i=0;i<18;i++)f.roster['门人'+i]={...f.roster.甲,name:'门人'+i,pos:'dizi'};const names=['俘甲','俘乙','俘丙'];for(const n of names)f.roster[n]={...f.roster.乙,name:n,level:68,relations:{friends:['甲'],enemies:[]}};const w={id:55,phase:'done',result:'win',atkSect:'a',defSect:'b',targetType:'sect',target:'b',atkFakes:[],defFakes:[],atkPlayers:[],defPlayers:[],captives:{fakes:[...names],players:[],byAtk:{fakes:[...names],players:[]},byDef:{fakes:[],players:[]}},log:[]};f.sectAttacks=[w];await disposeFakeCaptives(f,f.gid,w,'a',Date.now());assert.equal(Object.values(f.roster).filter(x=>x.alive&&x.sect==='a').length,20);for(const n of names){assert.equal(f.roster[n].alive,true);assert.equal(f.roster[n].level,68)}assert.deepEqual(w.captives.fakes,[])})

test('真人与NPC合计占名额，满员不再接纳任一身份',()=>{const f=fixture();for(let i=0;i<19;i++)f.players[String(i)]={name:'真人'+i,sect:'a',pos:'dizi'};assert.equal(canAdmitSectNpc(f,'a'),false);assert.equal(joinPlayerSect(f,f.gid,'新玩家','新人','a').ok,false)})
test('超员只疏散NPC，保留既有真人身份',()=>{const f=fixture();for(let i=0;i<20;i++)f.players[String(i)]={name:'真人'+i,sect:'a',pos:'dizi'};overCapSettle(f);assert.equal(Object.keys(f.players).length,20);assert.equal(f.roster.甲.status,'scatter')})

test('真人占满名额时散修自动入宗也被统一拦截',()=>{const f=fixture();for(let i=0;i<19;i++)f.players[String(i)]={sect:'a',pos:'dizi'};f.roster.游侠={...f.roster.乙,name:'游侠',status:'scatter',sect:null};assert.equal(fakeJoinSect(f,'游侠','a'),null);assert.equal(f.roster.游侠.status,'scatter')})

test('自动调度会实际联合盟友争夺霸主领地',async t=>{t.mock.method(Math,'random',()=>0);const f=coalitionFixture();for(const r of Object.values(REGIONS))for(const area of r.areas)f.areas[area]='b';const ok=await spawnAiSectAttacks(f,f.gid,Date.now());assert.equal(ok,true);const w=f.sectAttacks.find(w=>w.atkSect==='a');assert.ok(w);assert.ok(w.coalition.c);assert.ok(w.atkFakes.includes('甲'));assert.ok(w.atkFakes.includes('丙'))})

test('联合军队能完成真实战斗结算，盟友保留参战记录',async t=>{const base=+new Date('2026-11-05T12:00:00+08:00');t.mock.method(Date,'now',()=>base);t.mock.method(Math,'random',()=>0);const f=coalitionFixture();const plans=planAiCoalition(f,f.gid,'a','b','center',base);const r=await startSectAttack(f,f.gid,'a','b','ai',{coalitionPlans:plans,tactic:'正面强攻'});assert.equal(r.ok,true,r.msg);for(let minute=10;minute<=240&&r.atk.phase!=='done';minute+=10)await resolveSectAttacks(f,f.gid,base+minute*60000);assert.equal(r.atk.phase,'done');assert.ok(r.atk.actors['fake:丙'].rounds>0);assert.equal(r.atk.actorSects['fake:丙'],'c')})
