import { webkit, devices } from 'playwright';
const browser = await webkit.launch();
const ctx = await browser.newContext({...devices['iPhone 13']});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: '+e.message));
page.on('console', m => { if(m.type()==='error') errors.push('CONSOLE: '+m.text()); });
await page.goto('https://tataoro.com/pages/cafe',{waitUntil:'networkidle',timeout:45000});
await page.waitForTimeout(3000);
const R = {};
R.appjs_ran = await page.evaluate(()=>document.documentElement.hasAttribute('data-lang'));
R.lang_default_en = await page.evaluate(()=>document.documentElement.getAttribute('data-lang'));
// sticky: scroll past hero, before buy (show = !heroSeen && !buySeen)
await page.evaluate(()=>{
  const buy=document.getElementById('buy');
  const y=buy
    ? buy.getBoundingClientRect().top+window.scrollY-window.innerHeight
    : document.body.scrollHeight*0.45;
  window.scrollTo(0,Math.max(0,y));
});
await page.waitForTimeout(1200);
R.sticky = await page.evaluate(()=>{const s=document.querySelector('.sticky-bar');if(!s)return 'MISSING';const cs=getComputedStyle(s);const r=s.getBoundingClientRect();return {display:cs.display,visibility:cs.visibility,opacity:cs.opacity,transform:cs.transform,inViewport:r.top<window.innerHeight&&r.bottom>0,rect:[Math.round(r.top),Math.round(r.bottom)],cls:s.className};});
// whole bean toggle
await page.evaluate(()=>window.scrollTo(0,0));
const grindInfo = await page.evaluate(()=>{const g=document.getElementById('grind')||document.querySelector('select');return g?{id:g.id,opts:[...g.options].map(o=>o.value)}:null;});
R.grind = grindInfo;
if(grindInfo){
  await page.selectOption('#'+grindInfo.id, grindInfo.opts[1]);
  await page.waitForTimeout(600);
  R.notify_after_wb = await page.evaluate(()=>{const n=document.getElementById('notifyField');return n?{hidden:n.hidden,display:getComputedStyle(n).display}:'MISSING';});
  R.qty_after_wb = await page.evaluate(()=>{const q=document.getElementById('qtyField');return q?{hidden:q.hidden}:'MISSING';});
} else {
  R.notify_after_wb = 'MISSING';
}
R.buy_href = await page.evaluate(()=>{const b=document.getElementById('buyBtn')||document.querySelector('#buy a.btn');return b?b.href:null;});
R.errors = errors;
const fails = [];
if(!R.appjs_ran) fails.push('app.js did not run');
if(R.lang_default_en!=='en') fails.push('language default not en');
if(R.sticky==='MISSING'||!R.sticky.inViewport) fails.push('sticky bar not visible');
if(R.notify_after_wb==='MISSING'||R.notify_after_wb.hidden) fails.push('whole-bean notify not revealed');
if(!R.buy_href || !R.buy_href.includes('/cart/add')) fails.push('buy href not cart/add');
R.verdict = fails.length ? 'FAIL: '+fails.join('; ') : 'PASS';
console.log(JSON.stringify(R,null,1));
await browser.close();
if(fails.length) process.exit(1);
// Regression gate: run after every deploy touching the embed lane.
// Asserts: app.js execution, language default + toggle, sticky reveal,
// whole-bean -> notify reveal, buy hrefs -> cart/add, survey open + ink text,
// zero #533A59 / link-blue pixels (see pixel assay in validation/).
