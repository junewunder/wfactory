// The owner's page (.tracker/view.html): the state as data in a page that draws it. __DATA__
// and __TITLE__ are filled in by view.ts.
export const VIEW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__: tracker</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mute:#6b6a65;--line:#e4e1d8;--card:#fff;--done:#3d8b5a;--you:#c0622b;--ready:#3b6fb6;--wait:#b9b5aa;--bad:#b3261e;--prog:#7a5cb8}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--fg:#ecebe6;--mute:#9a988f;--line:#33322e;--card:#22221f;--wait:#55534c}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:980px;margin:0 auto;padding:24px 18px 80px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:4px}
.mute{color:var(--mute)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.q h3{margin:0 0 6px;font-size:16px}.opt{margin:6px 0 6px 4px}.opt b{display:inline-block;min-width:1.4em}.def{font-size:12px;border:1px solid var(--you);color:var(--you);border-radius:4px;padding:0 4px;margin-left:4px}
button{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:4px;padding:1px 7px;cursor:pointer;margin-left:6px}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--line);margin:4px 0}.bar span{display:block;height:100%}
.g{cursor:pointer}.g .row{display:flex;justify-content:space-between;gap:10px}.units{display:none;margin-top:8px}.g.open .units{display:block}
.u{padding:6px 0;border-top:1px solid var(--line)}.u small{display:block;color:var(--mute)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.s-done{background:var(--done)}.s-you{background:var(--you)}.s-ready{background:var(--ready)}.s-waiting,.s-resource{background:var(--wait)}.s-broken,.s-stuck,.s-interrupted{background:var(--bad)}.s-doing,.s-review{background:var(--prog)}.s-dropped,.s-parked{background:transparent;border:1px solid var(--wait)}
.legend span{margin-right:12px;font-size:13px}.log div{font-size:13px;padding:2px 0}.dec.replaced{text-decoration:line-through;opacity:.6}
.ci-failed,.ci-cut,.ci-never{color:var(--bad)}
input[type=search]{font:inherit;width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
</style></head><body><main id="app"></main>
<script>
const D=__DATA__;
const $=(h)=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstChild};
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const code=(s)=>esc(s).replace(/\`([^\`]+)\`/g,'<code>$1</code>');
const COL={done:'var(--done)',you:'var(--you)',ready:'var(--ready)',waiting:'var(--wait)',resource:'var(--wait)',broken:'var(--bad)',stuck:'var(--bad)',interrupted:'var(--bad)',doing:'var(--prog)',review:'var(--prog)'};
const NAMES={done:'done',broken:'broken again',you:'waiting on you',stuck:'stuck',interrupted:'interrupted',doing:'in progress',review:'in review',ready:'ready',resource:'waiting on a resource',waiting:'waiting on other work',parked:'parked',dropped:'dropped'};
const KEY='tracker-seen:'+D.title;const seen=localStorage.getItem(KEY)||'';
function copy(t,b){navigator.clipboard.writeText(t).then(()=>{b.textContent='copied';setTimeout(()=>b.textContent='copy answer',1500)})}
const app=document.getElementById('app');
const all=D.groups.flatMap(g=>g.units.filter(u=>!u.gate));const done=all.filter(u=>u.s==='done').length;
app.append($('<div><h1>'+esc(D.title)+'</h1><div class="mute">'+done+' of '+all.length+' done · built '+D.built.replace('T',' ').slice(0,16)+' UTC</div></div>'));
// needs you
const nyou=D.questions.length+D.gates.length+D.broken.length+D.interrupted.length+D.stuck.length;
app.append($('<h2>Needs you'+(nyou?' ('+nyou+')':'')+'</h2>'));
if(!nyou)app.append($('<p class="mute">Nothing is waiting on you.</p>'));
for(const q of D.questions){
  const c=$('<div class="card q"></div>');
  c.append($('<h3>'+esc(q.title)+'</h3>'));
  if(q.context)c.append($('<div>'+code(q.context)+'</div>'));
  if(q.example)c.append($('<pre>'+esc(q.example)+'</pre>'));
  for(const o of q.options){const d=$('<div class="opt"><b>'+esc(o.key)+')</b> <strong>'+esc(o.label)+'</strong>'+(o.key===q.default?'<span class="def">default</span>':'')+': '+code(o.changes)+(o.effects?'<div class="mute">→ '+esc(o.effects)+'</div>':'')+'</div>');
    const b=$('<button>copy answer</button>');b.onclick=()=>copy('just answer '+q.id+' '+o.key,b);d.append(b);c.append(d)}
  if(q.blocks.length)c.append($('<div class="mute">Blocks '+q.blocks.length+': '+esc(q.blocks.slice(0,5).join('; '))+(q.blocks.length>5?' …':'')+'</div>'));
  c.append($('<div class="mute">'+esc(q.id)+(q.asked?' · asked '+String(q.asked.at).slice(0,10)+' by '+esc(q.asked.by):'')+'</div>'));
  app.append(c)}
for(const g of D.gates){const c=$('<div class="card"><b>Gate: '+esc(g.title)+'</b>'+(g.detail?'<div>'+code(g.detail)+'</div>':'')+'<div class="mute">When it\\'s fine, tell an agent, or run <code>just pass '+esc(g.id)+'</code></div></div>');app.append(c)}
for(const [k,l] of [['broken','Broken again'],['interrupted','Interrupted'],['stuck','Stuck']])for(const u of D[k])app.append($('<div class="card"><span class="dot s-'+k+'"></span><b>'+esc(u.title)+'</b> <span class="mute">('+esc(u.id)+')</span><div>'+code(u.label)+'</div></div>'));
// since you last looked
const fresh=D.log.filter(l=>l.at>seen);
app.append($('<h2>Since you last looked'+(seen?' ('+seen.replace('T',' ').slice(0,16)+')':'')+'</h2>'));
const lg=$('<div class="log"></div>');
for(const l of (seen?fresh:D.log.slice(-25)).slice(-80).reverse())lg.append($('<div><span class="mute">'+l.at.slice(5,16).replace('T',' ')+' '+esc(l.actor)+'</span> '+code(l.text)+'</div>'));
if(!lg.children.length)lg.append($('<div class="mute">Nothing new.</div>'));
app.append(lg);
const mark=$('<button>mark all as seen</button>');mark.onclick=()=>{localStorage.setItem(KEY,D.built);location.reload()};app.append(mark);
// groups
app.append($('<h2>Groups</h2>'));
app.append($('<div class="legend">'+['done','you','ready','doing','waiting','broken'].map(k=>'<span><span class="dot s-'+k+'"></span>'+NAMES[k]+'</span>').join('')+'</div>'));
for(const g of D.groups){
  const us=g.units.filter(u=>!u.gate);const n=us.length||1;const c={};for(const u of us)c[u.s]=(c[u.s]||0)+1;
  const bar=['done','doing','review','ready','you','broken','stuck','interrupted','resource','waiting'].filter(k=>c[k]).map(k=>'<span title="'+c[k]+' '+NAMES[k]+'" style="width:'+(100*c[k]/n)+'%;background:'+COL[k]+'"></span>').join('');
  const el=$('<div class="card g"><div class="row"><b>'+esc(g.title)+'</b><span class="mute">'+(c.done||0)+' / '+us.length+(g.host?' · '+esc(g.host):'')+'</span></div><div class="bar">'+bar+'</div>'+(g.ci?'<div class="ci ci-'+g.ci.s+'"><small>CI: '+code(g.ci.text)+'</small></div>':'')+'<div class="units"></div></div>');
  const box=el.querySelector('.units');
  for(const u of g.units){const d=$('<div class="u"><span class="dot s-'+u.s+'"></span>'+(u.gate?'Gate: ':'')+esc(u.title)+' <span class="mute">('+esc(u.id)+')</span><small>'+code(u.label)+'</small></div>');
    if(u.detail)d.append($('<small>'+code(u.detail)+'</small>'));if(u.evidence&&u.s==='done')d.append($('<small>Evidence: '+code(u.evidence)+'</small>'));for(const n of u.notes)d.append($('<small>Note: '+code(n)+'</small>'));box.append(d)}
  el.onclick=(e)=>{if(!e.target.closest('.units'))el.classList.toggle('open')};app.append(el)}
// decisions
app.append($('<h2>Decisions</h2>'));
const s=$('<input type="search" placeholder="search decisions">');app.append(s);
const dl=$('<div></div>');app.append(dl);
function drawD(){dl.innerHTML='';const t=s.value.toLowerCase();for(const d of D.decisions){const txt=(d.title+' '+d.why+' '+(d.q||'')).toLowerCase();if(t&&!txt.includes(t))continue;
  dl.append($('<div class="card dec'+(d.replaced?' replaced':'')+'"><b>'+code(d.title)+'</b><div>'+code(d.why)+'</div><div class="mute">'+(d.by==='owner'?'you':'agent '+esc(d.by))+', '+d.at.slice(0,10)+(d.replaced?' · '+esc(d.replaced):'')+(d.q?' · answers: '+esc(d.q):'')+' · '+esc(d.id)+'</div></div>'))}
  if(!dl.children.length)dl.append($('<p class="mute">No decisions'+(t?' match':' yet')+'.</p>'))}
s.oninput=drawD;drawD();
</script></body></html>
`;
