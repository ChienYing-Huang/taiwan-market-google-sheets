const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
process.env.TZ='Asia/Taipei';
const fixture=path.join(__dirname,'fixtures');
const base=fs.existsSync(fixture)?fixture:__dirname;
const source=process.argv[2]||path.join(__dirname,'../src/Code.gs');
const read=n=>fs.readFileSync(path.join(base,n),'utf8');
const NativeDate=Date;
class TestDate extends NativeDate {constructor(...args){super(...(args.length?args:['2026-09-16T20:00:00+08:00']));}}
function context(){
 const cache=new Map(), requests=[];
 const c={console,Date:TestDate,Utilities:{
  sleep(){},formatDate(d,tz,f){const vals=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const get=k=>vals.find(p=>p.type===k).value;return f.replace('yyyy',get('year')).replace('MM',get('month')).replace('dd',get('day'));}
 },CacheService:{getScriptCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v)})}};
 c.UrlFetchApp={fetch(url){requests.push(url);let name;
  if(url.includes('holidaySchedule')) name='holidays-2026.json';
  else if(url.includes('FMTQIK')) name='volume-sep.json';
  else if(url.includes('MI_5MINS_HIST')) {if(url.includes('202608')) return {getResponseCode:()=>307};name='twse-sep.json';}
  else throw new Error('Unexpected URL '+url);
  return {getResponseCode:()=>200,getContentText:()=>read(name)};
 }};
 vm.createContext(c);vm.runInContext(fs.readFileSync(source,'utf8'),c);
 c.requests=requests;return c;
}
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name);}
test('09-16 successful September data survives unavailable August (HTTP 307)',()=>{
 const c=context(),r=c.fetchTwseTaiex_();
 assert.equal(r.date,'2026-09-16');assert.equal(r.close,45848.90);assert.equal(r.volume,8352608);
 assert.ok(!c.requests.some(u=>u.includes('202608')));
});
test('exact-date repair 09-16 OHLC and volume',()=>{
 const c=context(),r=c.fetchTwseTaiexForDate_('2026-09-16');
 assert.deepEqual([r.open,r.high,r.low,r.close,r.volume],[45546.56,46077.82,45546.56,45848.90,8352608]);
 assert.throws(()=>c.fetchTwseTaiexForDate_('2026-09-19'),/找不到/);
});
test('307 and invalid JSON retry then official alternate endpoint',()=>{
 const c=context(),original=c.UrlFetchApp.fetch;let n=0;
 c.UrlFetchApp.fetch=url=>{if(url.includes('/rwd/')&&url.includes('MI_5MINS_HIST')){n++;return n===1?{getResponseCode:()=>307}:{getResponseCode:()=>200,getContentText:()=>'<html>blocked</html>'};}return original(url);};
 assert.equal(c.fetchTwseTaiexForDate_('2026-09-16').close,45848.90);assert.equal(n,2);
 assert.ok(c.requests.some(u=>u.includes('/indicesReport/')));
});
test('total failure is surfaced, never silently use previous-month stale data',()=>{
 const c=context();let n=0;c.UrlFetchApp.fetch=()=>{n++;return {getResponseCode:()=>503};};
 assert.throws(()=>c.fetchTwseTaiex_(),/加權指數擷取失敗/);assert.equal(n,4);
});
test('nested tables accepted; wrong-month rows rejected',()=>{
 const c=context(),json=JSON.parse(read('twse-sep.json'));
 c.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({tables:[json]})});
 assert.equal(c.fetchTwseIndexRows_('20260901').length,json.data.length);
 assert.throws(()=>c.fetchTwseIndexRows_('20260801'),/日期或 OHLC 驗證失敗/);
});
test('empty current month alone allows previous month lookup',()=>{
 const c=context(),json=JSON.parse(read('twse-sep.json'));let seen=[];
 const aug={...json,data:[['115/08/31','45000','46000','44000','45500']]};
 c.UrlFetchApp.fetch=url=>{seen.push(url);return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(url.includes('202608')?aug:{...json,data:[]})};};
 c.fetchTwseTradeVolume_=()=>1;
 assert.equal(c.fetchTwseTaiex_().date,'2026-08-31');assert.equal(seen.length,2);
});
test('seasonal ATM reference changes on September settlement day',()=>{
 const c=context();c.findMarketRecordForDate_=(date,product)=>({close:product.includes('台指')?46445:46288});
 assert.equal(c.inferTxoExpiryDate_('202609'),'2026-09-16');
 for(const d of ['2026-05-04','2026-09-15']) assert.equal(c.getOptionAtmContext_(d).atmStrike,46450);
 for(const d of ['2026-04-30','2026-09-16','2026-09-17','2026-10-01']) assert.equal(c.getOptionAtmContext_(d).atmStrike,46300);
});
test('listed strike fallback uses raw reference, equal distance picks higher, missing sides rejected',()=>{
 const c=context(),rows=[46400,46500].flatMap(strike=>['Call','Put'].map(side=>({strike,side})));
 assert.equal(c.selectListedAtmStrike_(rows,{atmStrike:46450,atmReferencePrice:46445}),46400);
 assert.equal(c.selectListedAtmStrike_(rows,{atmStrike:46450,atmReferencePrice:46450}),46500);
 assert.throws(()=>c.selectListedAtmStrike_(rows.filter(r=>r.side==='Call'),{atmStrike:46450,atmReferencePrice:46445}),/皆有掛牌/);
 assert.throws(()=>c.selectListedAtmStrike_(rows,{atmStrike:50000,atmReferencePrice:50001}),/超出/);
});
const outputs=[];
for(const day of ['16','17']) test('official 09-'+day+' full option page: OI, ATM, IV and historical path',()=>{
 const c=context(),date='2026-09-'+day,html=read('options-09'+day+'.html');
 c.fetchHtmlWithCacheBust_=()=>html;
 const spot=c.fetchTwseTaiexForDate_(date);
 c.findMarketRecordForDate_=(d,product)=>{assert.equal(d,date);assert.ok(product.includes('大盤'));return {close:spot.close};};
 const r=c.fetchTaifexOptionOiFromWebsite_();
 assert.equal(r.date,date);assert.deepEqual([r.monthly.contract,r.weeklyWednesday.contract,r.weeklyFriday.contract],['202610','202609W4','202609F3']);
 assert.deepEqual([r.monthly.atmStrike,r.weeklyWednesday.atmStrike,r.weeklyFriday.atmStrike],day==='17'?[46300,46300,46300]:[45800,45850,45850]);
 if(day==='17'){
  assert.equal(r.atmComplete,true);
  assert.deepEqual([r.monthly.callLastPrice,r.monthly.putLastPrice],[1530,1190]);
  assert.deepEqual([r.weeklyWednesday.callLastPrice,r.weeklyWednesday.putLastPrice],[478,444]);
  assert.deepEqual([r.weeklyFriday.callLastPrice,r.weeklyFriday.putLastPrice],[217,239]);
  assert.deepEqual([r.monthly.callStrike,r.monthly.putStrike,r.weeklyWednesday.callStrike,r.weeklyWednesday.putStrike,r.weeklyFriday.callStrike,r.weeklyFriday.putStrike],[47000,40000,52000,45000,48200,46000]);
 }
 c.fetchTaifexOptionsHistoricalHtml_=()=>html;
 const history=c.fetchTaifexOptionOiMaximaForDate_(date);
 assert.equal(history.monthly.atmStrike,r.monthly.atmStrike);
 outputs.push({date,spot,options:r});
});
console.log(JSON.stringify({tests:count,results:outputs},null,2));
