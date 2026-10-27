(() => {
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const nf = new Intl.NumberFormat('sv-SE');
const kr = n => (n ? nf.format(Math.round(n)) + ' kr' : '');
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('sv-SE') : '';
const fmtStamp = iso => iso ? new Date(iso).toLocaleString('sv-SE', {dateStyle:'short', timeStyle:'short'}) : '';
const clone = o => JSON.parse(JSON.stringify(o));

const APP_VERSION = '2026-10-27.3';
let boxes = [], ready = false, lastBackup = null;
let household = [], me = '', notes = [], recentOwners = [];
let places = [], currentPlace = 'all';
let voiceLang = (navigator.language || '').toLowerCase().startsWith('sv') ? 'sv-SE' : 'en-US';
let view = {name: 'home'}, query = '';

/* ---------- IndexedDB ---------- */
let idb;
function openDB(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('boxes-app', 2);
    r.onupgradeneeded = () => { const d = r.result; for (const [n, o] of [['boxes', {keyPath: 'id'}], ['photos'], ['meta'], ['notes', {keyPath: 'id'}]]) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn){
  return new Promise((res, rej) => {
    const t = idb.transaction(store, mode), req = fn(t.objectStore(store));
    let out; if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const dbAll = () => tx('boxes', 'readonly', s => s.getAll());
/* the *Raw versions only touch the phone; the normal ones also mark the change for syncing */
const dbPutRaw = b => tx('boxes', 'readwrite', s => s.put(b));
const dbDelRaw = id => tx('boxes', 'readwrite', s => s.delete(id));
const phPutRaw = (k, b) => tx('photos', 'readwrite', s => s.put(b, k));
const phDelRaw = k => tx('photos', 'readwrite', s => s.delete(k));
const metaPutRaw = (k, v) => tx('meta', 'readwrite', s => s.put(v, k));
const dbPut = b => dbPutRaw(b).then(r => { markDirty('b:' + b.id); return r; });
const dbDel = id => dbDelRaw(id).then(r => { markDirty('b:' + id); return r; });
const phPut = (k, b) => phPutRaw(k, b).then(r => { markDirty('p:' + k); return r; });
const phGet = k => tx('photos', 'readonly', s => s.get(k));
const phDel = k => phDelRaw(k).then(r => { markDirty('p:' + k); return r; });
const metaGet = k => tx('meta', 'readonly', s => s.get(k));
const SYNC_META = ['places', 'household', 'trash', 'boxOrder', 'move'];
const metaPut = (k, v) => metaPutRaw(k, v).then(r => { if (SYNC_META.includes(k)) markDirty('m:' + k); if (k === 'me') markMe(); return r; });
const noteAll = () => tx('notes', 'readonly', s => s.getAll());
const notePut = n => tx('notes', 'readwrite', s => s.put(n));
const noteDel = id => tx('notes', 'readwrite', s => s.delete(id));

/* ---------- helpers ---------- */
let toastTimer;
const toastHost = () => { const d = document.getElementById('sheet'); return d && d.open ? d : document.body; };
function toast(msg){
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role','status'); t.textContent = msg;
  toastHost().appendChild(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3800);
}
function age(dateStr){
  if (!dateStr) return '';
  const d = new Date(dateStr), n = new Date();
  let m = (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth());
  if (n.getDate() < d.getDate()) m--;
  if (m < 1) return 'under a month';
  const y = Math.floor(m / 12), r = m % 12;
  if (!y) return m + ' mo';
  return y + ' yr' + (r ? ' ' + r + ' mo' : '');
}
const boxValue = b => (b.items || []).reduce((s, i) => s + (+i.value || 0), 0);
const byCode = (a, b) => (parseInt(a.code.slice(2)) || 0) - (parseInt(b.code.slice(2)) || 0);
let numbering = 'place';
function nextCode(pid, skip = 0){
  const pool = boxes.filter(b => !b.loose && (numbering === 'account' || !pid || b.placeId === pid));
  const max = pool.reduce((m, b) => Math.max(m, parseInt(String(b.code).replace(/\D/g, '')) || 0), 0);
  return 'B-' + String(max + 1 + skip).padStart(3, '0');
}
function qrSvg(text, cell = 4){
  try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({cellSize: cell, margin: 0, scalable: true}); }
  catch { return ''; }
}
const labelText = b => { const l = b.label || (b.labelGone ? '' : 'id:' + b.id); return l.startsWith('id:') ? 'BOXES:id:' + l.slice(3) : l ? 'STRG:L:' + l : 'BOXES:id:' + b.id; };
const findBox = id => boxes.find(b => b.id === id);
/* ---------- storage places: places hold boxes, and items can sit in a place without a box ---------- */
const findPlace = id => places.find(p => p.id === id);
const placeName = id => (findPlace(id) || {}).name || '';
const realBoxes = () => boxes.filter(b => !b.loose);
const boxesIn = pid => boxes.filter(b => !b.loose && (pid === 'all' || b.placeId === pid));
const looseOf = pid => boxes.find(b => b.loose && b.placeId === pid);
const childBoxes = id => boxes.filter(b => !b.loose && b.parentId === id);
const topBoxesIn = pid => boxesIn(pid).filter(b => !b.parentId || !findBox(b.parentId));
function boxChain(b){ const out = []; let x = b, guard = 0; while (x && x.parentId && guard++ < 10){ x = findBox(x.parentId); if (x) out.unshift(x); } return out; }
function descendants(id){ const out = []; const walk = i => childBoxes(i).forEach(c => { out.push(c); walk(c.id); }); walk(id); return out; }
function autoBoxName(b){
  const names = (b.items || []).map(i => i.name).filter(Boolean).concat(childBoxes(b.id).map(c => c.name));
  if (!names.length) return (typeof lang !== 'undefined' && lang === 'sv') ? 'Ny låda' : 'New box';
  const head = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${head} +${names.length - 2}` : head;
}
const byName = (a, c) => a.name.localeCompare(c.name, 'sv');
function ensureLoose(pid){
  let l = looseOf(pid);
  if (!l){ l = {id: newId(), loose: true, placeId: pid, code: '—', name: 'Not in a box', items: [], createdAt: new Date().toISOString()}; putBox(l); }
  return findBox(l.id);
}
function addPlace(name){
  name = (name || '').trim(); if (!name) return null;
  const hit = places.find(p => p.name.toLowerCase() === name.toLowerCase()); if (hit) return hit;
  const p = {id: newId(), name: name[0].toUpperCase() + name.slice(1), createdAt: new Date().toISOString()};
  places.push(p); metaPut('places', places).catch(() => {}); return p;
}
function setPlace(pid){
  if (pid !== 'all' && !findPlace(pid)) return;
  currentPlace = pid; metaPut('currentPlace', pid).catch(() => {});
}
const scopePlace = () => currentPlace !== 'all' ? currentPlace : (places.length === 1 ? places[0].id : null);
const saveErr = e => (e && e.name === 'QuotaExceededError') ? 'The phone is out of storage space for Storrrage.' : e && e.message ? e.message : 'Couldn’t save that change. Try again.';


/* ---------- icon guessing for items without photos ---------- */
// Most specific first. A leading "=" means the word must match on its own (avoids "car" in "scarf").
const ICONS = [
  ['🎄', ['christmas','xmas','advent','julpynt','juldekor','julgran','tomte','=jul','julbelysning']],
  ['🎃', ['halloween','pumpkin','pumpa']],
  ['🛏️', ['sleeping bag','sovsäck','duvet','täcke','pillow','kudde','bedding','sängkläder','mattress','madrass','lakan','=sheets']],
  ['⛺', ['tent','tält']],
  ['🥾', ['boot','känga','kängor','stövel','stövlar']],
  ['👟', ['shoe','sneaker','=sko','=skor','gympaskor','sandal']],
  ['🧥', ['jacket','coat','jacka','=rock','parka','overall','fleece','raincoat','regnkläder']],
  ['👗', ['dress','klänning','skirt','kjol']],
  ['🧣', ['scarf','halsduk','mitten','vante','vantar','glove','handske','mössa','beanie']],
  ['🧢', ['=cap','=caps','keps','=hat','=hats','hatt']],
  ['👕', ['shirt','tröja','tröjor','clothes','clothing','kläder','sweater','hoodie','byxor','trousers','=pants','jeans','sock','strumpor','underwear','pyjamas']],
  ['🎿', ['=ski','=skis','skid','slalom','pjäx','snowboard']],
  ['⛸️', ['skate','skridsko']],
  ['🛷', ['sled','pulka','kälke','stjärtlapp']],
  ['🚲', ['bike','bicycle','cykel','cykl']],
  ['🛴', ['scooter','sparkcykel']],
  ['🏒', ['hockey','innebandy','klubba']],
  ['🎾', ['tennis','racket','badminton','padel']],
  ['⚽', ['football','soccer','fotboll','=ball','=balls','=boll','bollar']],
  ['🎣', ['fishing','fiske','=rod']],
  ['🏋️', ['dumbbell','hantel','hantlar','vikter','kettlebell','=weights','yoga']],
  ['👶', ['baby','bebis','barnvagn','stroller','=pram','spjälsäng','=crib','skötväska']],
  ['🧸', ['toy','leksak','teddy','gosedjur','nalle','plush','=doll','=dolls','docka','dockor','lego','duplo','=brio']],
  ['🎮', ['playstation','xbox','nintendo','console','konsol','video game','tv-spel']],
  ['🎲', ['board game','brädspel','sällskapsspel','puzzle','pussel','=spel','=game','=games','dice','kortlek','playing cards']],
  ['📚', ['book','=bok','böcker','novel','=roman','magazine','tidning','comic','serie']],
  ['📁', ['document','dokument','binder','pärm','pärmar','papers','papper','folder','receipt','kvitto','deklaration']],
  ['📷', ['camera','kamera','photo album','fotoalbum','=album','photograph','=foton']],
  ['💿', ['=cd','=cds','=dvd','dvd:er','vinyl','=record','=records','=skiva','=skivor','blu-ray']],
  ['🎸', ['guitar','gitarr','=bass','=bas','elbas']],
  ['🎹', ['keyboard','piano','synth']],
  ['🥁', ['drum','trumma','trummor']],
  ['🎻', ['violin','fiol','instrument','ukulele','flute','flöjt']],
  ['📺', ['=tv','television','tv-apparat','monitor','skärm','screen']],
  ['💻', ['laptop','computer','dator','=pc','macbook','ipad','tablet','surfplatta']],
  ['🖨️', ['printer','skrivare','scanner']],
  ['📱', ['phone','telefon','=mobil','mobiltelefon','iphone']],
  ['🎧', ['headphone','hörlur']],
  ['🔊', ['speaker','högtalare','stereo','amplifier','förstärkare','radio']],
  ['🔌', ['cable','kabel','sladd','charger','laddare','adapter','extension cord','grenuttag']],
  ['🕯️', ['candle','stearinljus','värmeljus','ljusstake','candlestick']],
  ['💡', ['lamp','lampa','lampor','=light','=lights','bulb','glödlampa','lantern','lykta','slinga']],
  ['🔩', ['screw','skruv','=nail','=nails','=spik','bolt','=bult','=mutter','beslag']],
  ['🛠️', ['tool','verktyg','drill','borrmaskin','skruvdragare','=saw','=såg','hammer','hammare','wrench','screwdriver','skruvmejsel','sander']],
  ['🪜', ['ladder','stege']],
  ['🧶', ['yarn','=garn','knitting','stickning','sewing','symaskin','fabric','=tyg']],
  ['🎨', ['paint','målarfärg','brush','pensel','canvas','=art','craft','pyssel','easel']],
  ['🛋️', ['sofa','soffa','couch','armchair','fåtölj']],
  ['🪑', ['chair','=stol','=stolar','table','=bord','skrivbord','furniture','möbel','möbler','stool','=pall','shelf','hylla','hyllor','bench','bänk']],
  ['🪞', ['mirror','spegel']],
  ['🖼️', ['frame','=ram','=ramar','painting','tavla','tavlor','poster']],
  ['🍽️', ['plate','tallrik','=dish','=dishes','servis','porslin','=china','cutlery','bestick','=glas','wine glass','vinglas','=bowl','=skål','skålar','=mug','=mugs','mugg','=kopp','koppar','=cup','=cups']],
  ['🍳', ['=pan','stekpanna','=pot','=pots','kastrull','gryta','kitchen','=kök','köksgrej','blender','mixer','toaster','brödrost','våffeljärn','coffee maker','kaffebryggare']],
  ['🧳', ['suitcase','resväska','luggage','=bag','=bags','väska','väskor','backpack','ryggsäck']],
  ['🏕️', ['camping','=camp','friluft','outdoor','=stove','stormkök']],
  ['🌱', ['garden','trädgård','=plant','=plants','växt','kruka','krukor','=hose','vattenslang','seeds','frön']],
  ['🧹', ['vacuum','dammsugare','broom','kvast','=mop','mopp','cleaning','städ']],
  ['🚗', ['=car','=bil','=tire','=tires','=tyre','=tyres','däck','roof box','takbox','car seat','bilbarnstol']],
  ['🧴', ['shampoo','=soap','tvål','toiletries','hygien']],
  ['🎁', ['gift','present','=paket','wrapping','presentpapper']],
  ['🎈', ['party','kalas','=fest','balloon','ballong','birthday','födelsedag']],
  ['🧺', ['basket','=korg','korgar','laundry','tvätt']],
  ['⏰', ['clock','klocka','=watch']],
  ['💍', ['jewelry','jewellery','smycke','smycken','=ring','=rings']],
  ['🏆', ['trophy','pokal','medal','medalj']],
  ['✉️', ['letter','=brev','=card','=cards','=kort','vykort','postcard']],
];
function matchIcon(text){
  const t = ' ' + (text || '').toLowerCase() + ' ';
  if (!t.trim()) return '';
  const tokens = t.split(/[^a-zåäöéü0-9:-]+/).filter(Boolean);
  for (const [icon, keys] of ICONS)
    for (const k of keys)
      if (k[0] === '=' ? tokens.includes(k.slice(1)) : t.includes(k)) return icon;
  return '';
}
// default picture for a thing: a few items popping up out of an open box
const DEFAULT_ITEM_ICON = '<svg class="itemico" viewBox="0 0 64 64" aria-hidden="true"><path d="M15 8.5l2 4M32 4v4.5M49 8.5l-2 4" stroke="#F97F26" stroke-width="2.6" stroke-linecap="round" fill="none"/><rect x="12" y="30" width="40" height="7" rx="2" fill="#6F4A24"/><g transform="rotate(-9 32 26)"><rect x="26.5" y="11" width="12" height="25" rx="2" fill="#6C4CC9"/><rect x="28.5" y="13" width="2.2" height="21" rx="1" fill="#A49CD6"/></g><circle cx="19" cy="26.5" r="7.5" fill="#F97F26"/><path d="M12.5 24.5c4 2.2 9 2.2 13 0" stroke="#FFF7EA" stroke-width="1.8" fill="none" stroke-linecap="round"/><g transform="rotate(10 45 25)"><rect x="40" y="18" width="10.5" height="13" rx="2.2" fill="#3D8BFD"/><path d="M50.5 21.5h1.6a3 3 0 0 1 0 6h-1.6" stroke="#3D8BFD" stroke-width="2.2" fill="none"/></g><path d="M10 33h44l-2.5 24.5a3 3 0 0 1-3 2.5H15.5a3 3 0 0 1-3-2.5z" fill="#B5824A"/><path d="M10 33L3 26.5h12.5L19 33z" fill="#C99A62"/><path d="M54 33l7-6.5H48.5L45 33z" fill="#C99A62"/><rect x="10" y="33" width="44" height="3.2" fill="#8C5E2E"/><rect x="23.5" y="42" width="17" height="9.5" rx="1.6" fill="#FFF7EA"/><path d="M26.3 45.4h11.4M26.3 48.3h7.4" stroke="#2F1160" stroke-width="1.5" stroke-linecap="round"/></svg>';
const guessIcon = it => (it && it.icon) || matchIcon(it.name) || matchIcon(it.category) || DEFAULT_ITEM_ICON;

/* ---------- search: synonyms, Swedish/English, related things ---------- */
// Words that mean the same thing. A match on any of them counts as a direct match.
const SYN = [
  ['black','svart','svarta'],['white','vit','vita','vitt'],['grey','gray','grå','gråa','grått'],['blue','blå','blåa','blått'],
  ['red','röd','röda','rött'],['green','grön','gröna','grönt'],['yellow','gul','gula','gult'],['pink','rosa'],['purple','lila'],
  ['brown','brun','bruna','brunt'],['beige'],['orange'],['multicolour','multicolor','flerfärgad','randig','rutig','striped'],
  ['winter','vinter'],['summer','sommar'],['spring/autumn','spring','autumn','fall','vår','höst'],['all year','året runt'],
  ['shared','gemensam','gemensamt','gemensamma','delad'],['size','storlek','strl'],
  ['jacket','jacka','coat','rock','parka'],['boot','boots','känga','kängor','stövel','stövlar'],['shoe','shoes','sko','skor'],
  ['tent','tält'],['sleeping bag','sovsäck'],['bike','bicycle','cykel'],['book','books','bok','böcker'],['toy','toys','leksak','leksaker'],
  ['lamp','lampa','lampor'],['drill','borrmaskin','borr','skruvdragare'],['tools','verktyg'],['plate','plates','tallrik','tallrikar'],
  ['glass','glasses','glas'],['pillow','kudde','kuddar'],['duvet','täcke'],['blanket','filt','filtar'],['curtain','gardin','gardiner'],
  ['rug','carpet','matta','mattor'],['helmet','hjälm'],['gloves','handskar','vantar'],['hat','mössa','hatt'],['trousers','pants','byxor'],
  ['sweater','tröja','tröjor'],['dress','klänning'],['skates','skridskor'],['skis','skidor'],['sled','pulka','kälke'],
  ['suitcase','resväska'],['backpack','ryggsäck'],['stroller','barnvagn'],['christmas','jul'],['decorations','pynt','dekorationer'],
];
// Collective words, e.g. "verktyg" finds anything that looks like a tool. These count as related matches.
const GROUP_NAMES = [
  [['clothes','clothing','kläder','klädd'], ['🧥','👗','🧣','🧢','👕','🥾','👟']],
  [['shoes','footwear','skor','skodon'], ['🥾','👟']],
  [['outerwear','ytterkläder'], ['🧥','🧣','🧢']],
  [['toys','toy','leksaker','leksak'], ['🧸','🎲','🎮']],
  [['games','spel'], ['🎲','🎮']],
  [['kids','children','barn','barnsaker','bebis','baby'], ['👶','🧸']],
  [['electronics','elektronik','tech','teknik'], ['📺','💻','🖨️','📱','🎧','🔊','🔌','📷','🎮']],
  [['tools','tool','verktyg'], ['🛠️','🔩','🪜']],
  [['kitchen','kök','köksgrejer','kitchenware','husgeråd'], ['🍽️','🍳']],
  [['sports','sport','sportgrejer','träning','exercise'], ['🎿','⛸️','🛷','🚲','🛴','🏒','🎾','⚽','🎣','🏋️']],
  [['winter','vinter','vintergrejer'], ['🎿','⛸️','🛷','🧣']],
  [['camping','outdoor','friluftsliv','friluft','hiking','vandring'], ['⛺','🏕️','🛏️','🎣']],
  [['furniture','möbler','möbel'], ['🛋️','🪑','🪞','🖼️']],
  [['christmas','xmas','jul','julgrejer','julsaker'], ['🎄']],
  [['music','musik','instrument','instruments'], ['🎸','🎹','🥁','🎻','💿']],
  [['decorations','decor','dekoration','dekor','inredning','pynt'], ['🖼️','🪞','🕯️','💡','🎄','🎃']],
  [['books','böcker','litteratur'], ['📚']],
  [['papers','documents','dokument','papper'], ['📁']],
  [['garden','trädgård'], ['🌱']],
  [['car','bil','bilgrejer'], ['🚗']],
  [['party','fest','kalas'], ['🎈','🎁']],
  [['bags','väskor','luggage','bagage'], ['🧳']],
  [['bedding','sängkläder','textiles','textil'], ['🛏️']],
];
const STOP = new Set(['the','a','an','my','our','any','some','for','of','in','to','with','and','is','are','we','do','have','has','got',
  'anything','something','stuff','things','thing','where','och','min','mitt','mina','vår','vårt','våra','en','ett','till','för','med',
  'i','på','något','nåt','någon','några','har','vi','det','den','de','är','var','finns','saker','sak','grejer','grej','prylar','alla']);
function stems(tok){
  const out = [tok];
  if (tok.endsWith("'s")) out.push(tok.slice(0, -2));
  for (const suf of ['arna','erna','orna','na','et','en','ar','er','or','es','s','n','e','a'])
    if (tok.endsWith(suf) && tok.length - suf.length >= 4) out.push(tok.slice(0, -suf.length));
  return [...new Set(out)];
}
function itemHay(it, b){
  const unit = b.shelf && ((findPlace(b.placeId) || {}).units || []).find(u => u.id === b.shelf.u);
  const hay = [it.name, it.category, it.notes, (it.tags || []).join(' '), itemOwner(it), it.spot, placeName(b.placeId), it.size ? 'size storlek ' + it.size : '',
    it.loanTo, it.status ? (STATUS_KEYS[it.status] ? tr(STATUS_KEYS[it.status]) : it.status) : '', it.out ? tr('outTag') : '', unit ? unit.name : '', b.moveRoom,
    it.color, it.season, it.brand, it.model, it.serial, b.loose || b.autoName ? '' : b.name, b.loose ? '' : b.code, b.location].filter(Boolean).join(' ').toLowerCase();
  return {hay, toks: new Set(hay.split(/[^a-zåäöéü0-9.-]+/).filter(Boolean))};
}
const typoLimit = w => w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;
function nearWord(s, words){
  const lim = typoLimit(s); if (!lim) return false;
  for (const w of words){ if (Math.abs(w.length - s.length) > lim) continue; if (lev(s, w) <= lim) return true; if (w.length > s.length + 1 && lev(s, w.slice(0, s.length)) <= Math.max(1, lim - 1) && s.length >= 4) return true; }
  return false;
}
function tokScore(tok, H, icon){
  const ss = stems(tok);
  // short words match whole words or the start of a word ("jul" finds "Julkulor"), longer words match anywhere
  const lit = w => w.length <= 3 ? (H.toks.has(w) || [...H.toks].some(t => t.startsWith(w))) : H.hay.includes(w);
  if (ss.some(lit)) return 2;
  for (const g of SYN) if (ss.some(s => g.includes(s)) && g.some(lit)) return 2;
  // small typing mistakes: "tält" ~ "tålt", "skidjaka" ~ "skidjacka"
  if (ss.some(s => nearWord(s, H.toks))) return 2;
  for (const g of SYN) if (ss.some(s => nearWord(s, g)) && g.some(lit)) return 2;
  for (const [names, icons] of GROUP_NAMES) if (ss.some(s => names.includes(s)) && icons.includes(icon)) return 1;
  const ti = ss.map(matchIcon).find(Boolean);
  if (ti && ti === icon) return 1;
  return 0;
}
function queryTokens(q){
  return q.toLowerCase().replace(/['’]s(?=\s|$)/g, '').split(/[^a-zåäöéü0-9.-]+/).filter(t => t && !STOP.has(t));
}
function searchItems(q, opts = {}){
  if (typeof opts === 'string') opts = {boxId: opts};
  const toks = queryTokens(q), exact = [], related = [];
  if (!toks.length) return {exact, related};
  for (const b of boxes){
    if (opts.boxId && b.id !== opts.boxId) continue;
    if (opts.placeId && b.placeId !== opts.placeId) continue;
    if (opts.placeIds && opts.placeIds.size && !opts.placeIds.has(b.placeId)) continue;
    if (opts.boxIds && opts.boxIds.size && !opts.boxIds.has(b.id)) continue;
    for (const it of (b.items || [])){
      const H = itemHay(it, b), icon = guessIcon(it);
      let min = 2;
      for (const t of toks){ const s = tokScore(t, H, icon); if (s < min) min = s; if (!min) break; }
      if (min === 2) exact.push([it, b]); else if (min === 1) related.push([it, b]);
    }
  }
  return {exact, related};
}

// "Did you mean …?" when nothing matches
function searchSuggestions(q, max = 6){
  const toks = queryTokens(q); if (!toks.length) return [];
  const vocab = new Map();
  boxes.forEach(b => { (b.items || []).forEach(i => [i.name, i.category, ...(i.tags || []), i.brand].filter(Boolean).forEach(v => { const k = String(v).toLowerCase(); if (!vocab.has(k)) vocab.set(k, String(v)); })); if (!b.loose && b.name) vocab.set(b.name.toLowerCase(), b.name); });
  const scored = [];
  for (const [k, v] of vocab){
    const words = k.split(/[^a-zåäöéü0-9]+/).filter(Boolean);
    let best = 99;
    for (const t of toks) for (const w of words.concat([k])){ const d = lev(t, w.slice(0, Math.max(t.length, Math.min(w.length, t.length + 2)))); best = Math.min(best, d / Math.max(3, t.length)); }
    if (best <= 0.5) scored.push([best, v]);
  }
  return scored.sort((x, y) => x[0] - y[0]).slice(0, max).map(x => x[1]);
}

/* ---------- persistence ---------- */
function putBox(box, quiet){
  box.updatedAt = new Date().toISOString();
  if (box.autoName && !box.loose) box.name = autoBoxName(box);
  const i = boxes.findIndex(b => b.id === box.id);
  if (i < 0) boxes.push(box); else boxes[i] = box;
  if (!itemEdit || (box.id !== itemEdit.boxId && !(box.items || []).some(i => i.id === itemEdit.itemId))) dbPut(clone(box)).catch(e => toast(saveErr(e)));
  if (!quiet) render();
}
function removeBox(id){
  boxes = boxes.filter(b => b.id !== id);
  dbDel(id).catch(e => toast(saveErr(e)));
  render();
}

/* ---------- photos ---------- */
async function shrink(file, max){
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  if (bmp.close) bmp.close();
  return cv;
}
const toBlob = (cv, type, q) => new Promise(r => cv.toBlob(r, type, q));
// Photos: longest side 1600 px (sharp enough to read labels and serial numbers when zoomed),
// saved as WebP, which is roughly a third smaller than JPEG at the same quality. JPEG if WebP isn't supported.
const PHOTO_MAX = 1600, PHOTO_QUALITY = .78;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const imageSignature = async blob => {
  const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  return h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff
    || h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47
    || String.fromCharCode(...h.slice(0, 4)) === 'RIFF' && String.fromCharCode(...h.slice(8, 12)) === 'WEBP'
    || String.fromCharCode(...h.slice(0, 3)) === 'GIF';
};
async function validateImageUpload(file){
  if (!file || !file.size || file.size > MAX_UPLOAD_BYTES) throw new Error(tr(file && file.size > MAX_UPLOAD_BYTES ? 'uploadTooLarge' : 'uploadImageOnly'));
  if (!await imageSignature(file)) throw new Error(tr('uploadImageOnly'));
}
async function validatePdfUpload(file){
  if (!file || !file.size || file.size > MAX_UPLOAD_BYTES) throw new Error(tr(file && file.size > MAX_UPLOAD_BYTES ? 'uploadTooLarge' : 'uploadPdfOnly'));
  if (file.type && file.type !== 'application/pdf') throw new Error(tr('uploadPdfOnly'));
  const h = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...h) !== '%PDF-') throw new Error(tr('uploadPdfOnly'));
}
async function storeUpload(file){
  if (await imageSignature(file)){
    const photo = await storePhoto(file);
    return {ref: photo.ref, type: photo.type};
  }
  await validatePdfUpload(file);
  const ref = newId();
  await phPut(ref, file.slice(0, file.size, 'application/pdf'));
  return {ref, type: 'application/pdf'};
}
async function validateAudioUpload(file){
  if (!file || !file.size || file.size > MAX_UPLOAD_BYTES) throw new Error(tr('uploadTooLarge'));
  const h = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const type = (file.type || '').split(';')[0].toLowerCase();
  const valid = type === 'audio/webm' && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3
    || type === 'audio/ogg' && String.fromCharCode(...h.slice(0, 4)) === 'OggS'
    || type === 'audio/mpeg' && (String.fromCharCode(...h.slice(0, 3)) === 'ID3' || h[0] === 0xff && (h[1] & 0xe0) === 0xe0)
    || type === 'audio/mp4' && String.fromCharCode(...h.slice(4, 8)) === 'ftyp'
    || type === 'audio/wav' && String.fromCharCode(...h.slice(0, 4)) === 'RIFF' && String.fromCharCode(...h.slice(8, 12)) === 'WAVE';
  if (!valid) throw new Error(tr('uploadUnsafeType'));
}
function backupDataBlob(value, limit = MAX_UPLOAD_BYTES){
  if (typeof value !== 'string' || value.length > Math.ceil(limit * 1.4)) throw new Error(tr('uploadTooLarge'));
  const match = /^data:([a-z0-9.+/-]+)(?:;codecs=[a-z0-9.-]+)?;base64,([a-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) throw new Error(tr('uploadUnsafeType'));
  const type = match[1].toLowerCase(), allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'];
  if (!allowed.includes(type)) throw new Error(tr('uploadUnsafeType'));
  const raw = atob(match[2]), bytes = new Uint8Array(raw.length);
  if (!raw.length || raw.length > limit) throw new Error(tr('uploadTooLarge'));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], {type});
}
async function normalizePhoto(file){
  await validateImageUpload(file);
  const cv = await shrink(file, PHOTO_MAX);
  let blob = await toBlob(cv, 'image/webp', PHOTO_QUALITY);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(cv, 'image/jpeg', .8);
  if (!blob) throw new Error(tr('uploadImageOnly'));
  return blob;
}
async function storePhoto(file){
  const takenAt = new Date(file.lastModified || Date.now()).toISOString();
  const blob = await normalizePhoto(file);
  const ref = newId();
  await phPut(ref, blob);
  return {ref, type: blob.type, takenAt, addedAt: new Date().toISOString()};
}
const urls = new Map();
async function photoURL(ref){
  if (urls.has(ref)) return urls.get(ref);
  let b = await phGet(ref).catch(() => null);
  if (!b) b = await cloudPhoto(ref).catch(() => null);
  if (!b) return '';
  const u = URL.createObjectURL(b); urls.set(ref, u); return u;
}
function hydrate(root = document){
  root.querySelectorAll('img[data-ph]:not([src])').forEach(async img => {
    const fail = () => { img.remove(); };
    img.onerror = fail;
    img.onload = () => { if (img.parentElement) img.parentElement.classList.add('hasimg'); };
    const u = await photoURL(img.dataset.ph); if (u) img.src = u; else fail();
  });
}
function refInUse(ref){
  return trash.some(t => (t.item.photos || []).some(p => p.ref === ref) || (t.item.files || []).some(f => f.ref === ref)) || boxes.some(b => (b.photo && b.photo.ref === ref) || (b.documents || []).some(d => d.ref === ref) || (b.items || []).some(i => (i.photos || []).some(p => p.ref === ref) || (i.files || []).some(f => f.ref === ref)));
}
function unlinkDocuments(itemIds){
  const ids = new Set(itemIds);
  boxes.filter(b => (b.documents || []).some(d => ids.has(d.itemId))).forEach(b => {
    const updated = clone(b);
    updated.documents.forEach(d => { if (ids.has(d.itemId)) delete d.itemId; });
    putBox(updated, true);
  });
}
/* deleted items stay in the trash for 30 days (photos too) */
let trash = [];
const TRASH_DAYS = 30;
function toTrash(list){
  const at = new Date().toISOString();
  const ids = [];
  list.forEach(([it, b]) => { const e = {id: newId(), item: clone(it), boxId: b.id, code: b.loose ? '' : b.code, boxName: b.loose ? '' : b.name, placeId: b.placeId, deletedAt: at}; trash.unshift(e); ids.push(e.id); });
  metaPut('trash', trash).catch(() => {});
  return ids;
}
function untrash(ids){ trash = trash.filter(t => !ids.includes(t.id)); metaPut('trash', trash).catch(() => {}); }
function purgeTrash(){
  const lim = Date.now() - TRASH_DAYS * 864e5, old = trash.filter(t => Date.parse(t.deletedAt) < lim);
  if (!old.length) return;
  trash = trash.filter(t => !old.includes(t)); metaPut('trash', trash).catch(() => {});
  unlinkDocuments(old.map(t => t.item.id));
  old.forEach(t => { (t.item.photos || []).forEach(p => dropPhoto(p.ref)); (t.item.files || []).forEach(f => dropPhoto(f.ref)); });
}
function restoreTrash(id){
  const t = trash.find(x => x.id === id); if (!t) return;
  track('trash_restore');
  let b = findBox(t.boxId);
  if (!b) b = ensureLoose(findPlace(t.placeId) ? t.placeId : places[0].id);
  const nb = clone(b); nb.items = (nb.items || []).filter(i => i.id !== t.item.id).concat(t.item); putBox(nb, true);
  untrash([id]);
  toast(tr('restoredTo', t.item.name, b.loose ? placeName(b.placeId) : b.code));
}
function trashSheet(){
  const days = t => Math.max(0, TRASH_DAYS - Math.floor((Date.now() - Date.parse(t.deletedAt)) / 864e5));
  openSheet(`<h3>${ICON.trash} ${tr('trash')}</h3><p class="hint">${tr('trashHint')}</p>
    ${trash.length ? `<div class="trashlist">${trash.map(t => `<div class="trow"><span class="lthumb"><span class="ticon">${guessIcon(t.item)}</span></span>
      <span class="ttx"><b>${esc(t.item.name || tr('unnamed'))}</b><small>${esc([t.code ? t.code + ' ' + t.boxName : tr('notInBox'), placeName(t.placeId)].filter(Boolean).join(' · '))} · ${esc(tr('daysLeft', days(t)))}</small></span>
      <button class="btn quiet small" data-tr="${esc(t.id)}">${tr('restoreItem')}</button></div>`).join('')}</div>` : `<p class="hint center">${tr('trashEmpty')}</p>`}
    <div class="sheet-foot">${trash.length ? `<button class="btn danger" id="trEmpty">${tr('emptyTrash')}</button>` : ''}<button class="btn" id="trX">${tr('close')}</button></div>`);
  sheet.querySelector('.sheet').onclick = e => { const b = e.target.closest('[data-tr]'); if (b){ restoreTrash(b.dataset.tr); render(); trashSheet(); } };
  $('#trX').onclick = closeSheet;
  if ($('#trEmpty')) $('#trEmpty').onclick = () => askConfirm(tr('emptyTrashQ', trash.length), tr('emptyTrash')).then(y => { if (!y) return; const all = trash; trash = []; metaPut('trash', trash).catch(() => {}); unlinkDocuments(all.map(t => t.item.id)); all.forEach(t => { (t.item.photos || []).forEach(p => dropPhoto(p.ref)); (t.item.files || []).forEach(f => dropPhoto(f.ref)); }); trashSheet(); });
}
function dropPhoto(ref){
  if (!ref) return;
  setTimeout(() => {
    if (refInUse(ref) || (batch && batch.refs.has(ref))) return;
    phDel(ref).catch(() => {});
    if (urls.has(ref)){ URL.revokeObjectURL(urls.get(ref)); urls.delete(ref); }
  }, 300);
}
/* ---------- full-screen photo viewer with pinch and double-tap zoom ---------- */
const viewer = document.createElement('dialog');
viewer.id = 'viewer';
viewer.innerHTML = '<div class="vwrap"><img id="vImg" alt=""></div><button class="vclose">×</button><p class="vhint"></p>';
document.body.appendChild(viewer);
(() => {
  const img = viewer.querySelector('#vImg'), wrap = viewer.querySelector('.vwrap');
  let sc = 1, x = 0, y = 0, start = null, lastTap = 0, down = null;
  const pts = new Map();
  const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${sc})`; };
  const reset = () => { sc = 1; x = 0; y = 0; apply(); };
  const dist = () => { const [p, q] = [...pts.values()]; return Math.hypot(p.x - q.x, p.y - q.y); };
  const begin = () => {
    if (pts.size === 2) start = {d: dist(), sc};
    else if (pts.size === 1){ const p = [...pts.values()][0]; start = {px: p.x, py: p.y, x, y}; }
  };
  wrap.addEventListener('pointerdown', e => {
    wrap.setPointerCapture(e.pointerId); pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pts.size === 1) down = {x: e.clientX, y: e.clientY, t: Date.now()};
    begin();
  });
  wrap.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pts.size === 2 && start && start.d){ sc = Math.min(6, Math.max(1, start.sc * dist() / start.d)); if (sc === 1){ x = 0; y = 0; } apply(); }
    else if (pts.size === 1 && sc > 1 && start && start.px !== undefined){ x = start.x + e.clientX - start.px; y = start.y + e.clientY - start.py; apply(); }
  });
  const up = e => {
    pts.delete(e.pointerId); begin();
    if (pts.size === 0 && down && Date.now() - down.t < 250 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 10){
      if (Date.now() - lastTap < 320){ if (sc > 1) reset(); else { sc = 2.5; apply(); } lastTap = 0; }
      else lastTap = Date.now();
    }
  };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  viewer.querySelector('.vclose').onclick = () => viewer.close();
  window.openViewer = async ref => {
    viewer.querySelector('.vclose').setAttribute('aria-label', tr('closePhoto')); viewer.querySelector('.vhint').textContent = tr('zoomHint');
    const u = await photoURL(ref); if (!u) return;
    img.src = u; reset(); pts.clear(); viewer.showModal();
  };
})();
const imgTag = (ref, cls, alt = '') => `<img class="${cls}" data-ph="${esc(ref)}" alt="${esc(alt)}">`;

/* ---------- language: Swedish or English for the whole app (item names never change) ---------- */
let lang = (navigator.language || '').toLowerCase().startsWith('sv') ? 'sv' : 'en';
const STR = {
  en: {
    space: 'PLACES', places_n: n => n === 1 ? '1 PLACE' : `${n} PLACES`, boxes_n: n => n === 1 ? '1 BOX' : `${n} BOXES`, items_n: n => n === 1 ? '1 ITEM' : `${n} ITEMS`,
    box_n: n => `BOX ${n}`, allPlaces: 'All places', addPlace: '+ Place', notInBox: 'Not in a box', notInBoxShort: 'not in a box',
    emptyPlace: 'Tap + to add a box, or something that isn’t in a box, like a bike.', addItem: 'Add item', addSeveral: 'Add several', addThingChoice: 'Add thing', addMultipleChoice: 'Add multiple', addBoxChoice: 'Add box', item: 'item', items: 'items',
    editBox: 'Edit box', label: 'Label', findStuff: 'FIND YOUR STUFF!', typeKeyword: 'Type keyword', searchIn: 'Search in', everywhere: 'Everywhere', allOf: p => `All of ${p}`,
    boxesH: 'Boxes', similar: 'Similar things', noMatch: q => `Nothing matches “${q}”. Try another word, in Swedish or English.`, nothingHere: 'Nothing stored here yet.',
    welcome: 'Keep track of what’s stored where: boxes, things, photos and receipts. Find anything by searching or just asking.', yourName: 'Your name', getStarted: 'Get started',
    noAccount: 'No account needed for now. Everything stays on this phone.', writeName: 'Write your name first.',
    storrrage: 'STORRRAGE', profile: 'Profile', settings: 'Settings', notifications: 'Notifications', premium: 'Premium', version: v => `Storrrage version ${v}`,
    household: 'People in the household', addName: 'Add a name', add: 'Add', you: '(you)', remove: 'Remove', householdHint: 'Used for “whose is it” on items, and when talking to Storrrage (“Elsa’s boots”).', noOne: 'No one added yet.',
    aiAssistant: 'AI assistant', off: 'Off', storagePlaces: 'Places', editPlace: n => `Edit ${n}`, foldSpace: n => `Collapse ${n}`, unfoldSpace: n => `Expand ${n}`, changePlaceIcon: n => `Choose an icon for ${n}`, backupNow: 'Back up now', never: 'Never', restore: 'Restore from backup', insurance: 'Insurance report',
    labelsAll: 'Labels for all boxes', scanLabel: 'Scan a box label', language: 'Language', usage: mb => `Everything is stored only on this phone. Storrrage uses about ${mb} MB.`,
    dueIntro: 'You haven’t used these for a while. Still worth keeping, or time to sell?', lastUsedOn: d => `Last used ${d}`, usedRecently: 'Used it recently', markSale: 'Mark for sale',
    nothingDue: 'Nothing needs your attention. On an item, set “Remind me if unused” to get a nudge when you haven’t used it in a while.',
    prem1: 'Share storage with your household', prem2: 'Sell on Blocket, Tradera and Vinted', prem3: 'Login and sync between phones', premLater: 'Coming later. Everything you use now is free.',
    whatIsIt: 'What is it?', whereIs: 'Where it is', addDetail: 'Add details', lastUsed: 'Last time used', remind: 'Remind me if unused', noRemind: 'No reminder',
    remindM: m => m === 12 ? 'After 1 year' : m === 24 ? 'After 2 years' : `After ${m} months`, notify: d => `notify ${d}`,     attachments: 'Attachments', addAttach: '+ Add receipt, warranty or manual', documents: 'Documents & receipts', addDocument: '+ Add document or recipe', noDocuments: 'No documents yet.', linkToItem: 'Link to item', notLinked: 'Not linked to an item', linkedDocuments: 'Linked documents', document: 'Document',
    tags: 'Tags', registered: (d, by) => `Registered ${d}${by ? ` by ${by}` : ''}.`, storedSince: d => `Stored since ${d}.`, changed: d => `Last changed ${d}.`,
    delItem: 'Delete item', done: 'Done', save: 'Save', saveAnother: 'Save + add another', saved: 'Saved.', savedNext: n => `${n} saved. Add the next one.`, nameFirst: 'Give it a name first.',
    f_size: 'Size', f_brand: 'Brand', f_value: 'Price / value (kr)', f_model: 'Model', f_qty: 'Quantity', f_owner: 'Whose & status', f_color: 'Colour', f_season: 'Season', f_serial: 'Serial number',
    f_category: 'Category', f_spot: 'Where exactly', f_notes: 'Notes', whose: 'Whose is it', status: 'Status', loanTo: 'Lent to whom', shared: 'Shared',
    st_store: 'In storage', st_loan: 'On loan', st_sale: 'For sale', st_sold: 'Sold', st_given: 'Given away', st_throw: 'Throw away', st_custom: 'Other…',
    customStatus: 'Enter a status',
    addTo: p => `Add to ${p}`, addBoxOrItem: 'Add box or item', boxStorage: 'Box', itemNoBox: 'Item without a box', severalPhotos: 'Several items from photos', cancel: 'Cancel', close: 'Close', ok: 'OK',
    moveX: n => `Move ${n}`, to: 'To', move: 'Move', movedTo: w => `Moved to ${w}.`, rename: 'Rename', del: 'Delete', edit: 'Edit', moveToPlace: 'Move to place', emptyFirst: 'Empty this place to delete it.',
    delQ: n => `Delete “${n}”? This can’t be undone.`, delNoteQ: 'Delete this voice note?', rmPhotoQ: 'Remove this photo?', rmQ: n => `Remove “${n}”?`, rmTagQ: n => `Remove the tag “${n}”?`,
    newPlace: 'New place', newPlaceHint: 'For example Basement, Vinden or Garaget', renameX: n => `Rename ${n}`, newTag: 'Add a tag', tagHint: 'For example hiking or winter',
    backupBanner: d => d ? `Last backup was ${d}. Everything is stored only on this phone, so keep a copy somewhere else.` : 'You haven’t made a backup yet. Everything is stored only on this phone, so keep a copy somewhere else.',
    voiceNotes: 'Voice notes', voiceNotesBox: 'Voice notes for this box', menu: 'Menu', allSettings: 'All settings', usedNoted: 'Noted. The reminder starts over.', markedSale: 'Marked for sale.',
    placesHint: 'For example the basement storage unit, the attic, the garage or the summer house. Only a name is stored, never an address.', placeNameHint: 'Name, e.g. Vinden',
    fileMissing: 'That file is missing.', savingPhoto: 'Saving photo…', savingDocument: 'Saving document…', unnamed: 'Unnamed',
    batchTitle: 'Add several items', batchWhere: w => `They’ll go into ${w}.`, modeEach: 'One photo per item', modeEachHint: 'Take or pick a photo of each thing.',
    modeMulti: 'Several items in one photo', modeMultiHint: 'Lay things out and take one photo. Each thing becomes its own item.',
    batchAI: 'AI will suggest names and details from the photos. You check them before adding.', batchNoAI: 'Turn on the AI assistant to get names and details suggested automatically. Without it you name each item yourself.',
    batchPrivacy: 'Photos are sent to the AI service to be recognised.', thinking: 'Recognising…', aiFailed: e => `Couldn’t recognise: ${e}`, addN: n => n === 1 ? 'Add 1 item' : `Add ${n} items`,
    batchAdded: n => n === 1 ? 'Added 1 item.' : `Added ${n} items.`, namePh: 'Name', include: 'Include', morePhotos: '+ More photos', noneYet: 'No photos yet.', batchFound: n => n === 1 ? 'Found 1 thing.' : `Found ${n} things.`,
  },
  sv: {
    space: 'PLATSER', places_n: n => n === 1 ? '1 PLATS' : `${n} PLATSER`, boxes_n: n => n === 1 ? '1 LÅDA' : `${n} LÅDOR`, items_n: n => n === 1 ? '1 SAK' : `${n} SAKER`,
    box_n: n => `LÅDA ${n}`, allPlaces: 'Alla platser', addPlace: '+ Plats', notInBox: 'Utan låda', notInBoxShort: 'utan låda',
    emptyPlace: 'Tryck på + för att lägga till en låda, eller något som inte ligger i en låda, som en cykel.', addItem: 'Lägg till sak', addSeveral: 'Lägg till flera', addThingChoice: 'Lägg till sak', addMultipleChoice: 'Lägg till flera', addBoxChoice: 'Lägg till låda', item: 'sak', items: 'saker',
    editBox: 'Ändra låda', label: 'Etikett', findStuff: 'HITTA DINA GREJER!', typeKeyword: 'Skriv ett sökord', searchIn: 'Sök i', everywhere: 'Överallt', allOf: p => `Hela ${p}`,
    boxesH: 'Lådor', similar: 'Liknande saker', noMatch: q => `Inget matchar ”${q}”. Prova ett annat ord, på svenska eller engelska.`, nothingHere: 'Inget sparat här än.',
    welcome: 'Håll koll på vad som förvaras var: lådor, saker, foton och kvitton. Hitta allt genom att söka eller bara fråga.', yourName: 'Ditt namn', getStarted: 'Kom igång',
    noAccount: 'Inget konto behövs just nu. Allt stannar på den här telefonen.', writeName: 'Skriv ditt namn först.',
    storrrage: 'STORRRAGE', profile: 'Profil', settings: 'Inställningar', notifications: 'Notiser', premium: 'Premium', version: v => `Storrrage version ${v}`,
    household: 'Personer i hushållet', addName: 'Lägg till ett namn', add: 'Lägg till', you: '(du)', remove: 'Ta bort', householdHint: 'Används för ”vems är det” på saker, och när du pratar med Storrrage (”Elsas kängor”).', noOne: 'Ingen tillagd än.',
    aiAssistant: 'AI-assistent', off: 'Av', storagePlaces: 'Platser', editPlace: n => `Ändra ${n}`, foldSpace: n => `Fäll ihop ${n}`, unfoldSpace: n => `Visa ${n}`, changePlaceIcon: n => `Välj ikon för ${n}`, backupNow: 'Säkerhetskopiera nu', never: 'Aldrig', restore: 'Återställ från säkerhetskopia', insurance: 'Försäkringsrapport',
    labelsAll: 'Etiketter för alla lådor', scanLabel: 'Skanna en etikett', language: 'Språk', usage: mb => `Allt sparas bara på den här telefonen. Storrrage använder ungefär ${mb} MB.`,
    dueIntro: 'Du har inte använt de här på ett tag. Värda att behålla, eller dags att sälja?', lastUsedOn: d => `Senast använd ${d}`, usedRecently: 'Använt nyligen', markSale: 'Markera till salu',
    nothingDue: 'Inget behöver din uppmärksamhet. Välj ”Påminn om oanvänd” på en sak för att få en knuff när du inte använt den på ett tag.',
    prem1: 'Dela förvaring med hushållet', prem2: 'Sälj på Blocket, Tradera och Vinted', prem3: 'Inloggning och synk mellan telefoner', premLater: 'Kommer senare. Allt du använder nu är gratis.',
    whatIsIt: 'Vad är det?', whereIs: 'Var den finns', addDetail: 'Lägg till detaljer', lastUsed: 'Senast använd', remind: 'Påminn om oanvänd', noRemind: 'Ingen påminnelse',
    remindM: m => m === 12 ? 'Efter 1 år' : m === 24 ? 'Efter 2 år' : `Efter ${m} månader`, notify: d => `påminnelse ${d}`,     attachments: 'Bilagor', addAttach: '+ Lägg till kvitto, garanti eller manual', documents: 'Dokument och kvitton', addDocument: '+ Lägg till dokument eller recept', noDocuments: 'Inga dokument än.', linkToItem: 'Koppla till sak', notLinked: 'Inte kopplat till någon sak', linkedDocuments: 'Kopplade dokument', document: 'Dokument',
    tags: 'Taggar', registered: (d, by) => `Registrerad ${d}${by ? ` av ${by}` : ''}.`, storedSince: d => `Förvaras sedan ${d}.`, changed: d => `Senast ändrad ${d}.`,
    delItem: 'Ta bort sak', done: 'Klar', save: 'Spara', saveAnother: 'Spara + lägg till nästa', saved: 'Sparat.', savedNext: n => `${n} sparad. Lägg till nästa.`, nameFirst: 'Ge den ett namn först.',
    f_size: 'Storlek', f_brand: 'Märke', f_value: 'Pris / värde (kr)', f_model: 'Modell', f_qty: 'Antal', f_owner: 'Vems & status', f_color: 'Färg', f_season: 'Säsong', f_serial: 'Serienummer',
    f_category: 'Kategori', f_spot: 'Var exakt', f_notes: 'Anteckningar', whose: 'Vems är det', status: 'Status', loanTo: 'Utlånad till', shared: 'Gemensam',
    st_store: 'I förrådet', st_loan: 'Utlånad', st_sale: 'Till salu', st_sold: 'Såld', st_given: 'Bortskänkt', st_throw: 'Slängas', st_custom: 'Annat…',
    customStatus: 'Skriv en egen status',
    addTo: p => `Lägg till i ${p}`, addBoxOrItem: 'Lägg till låda eller sak', boxStorage: 'Låda', itemNoBox: 'Sak utan låda', severalPhotos: 'Flera saker från foton', cancel: 'Avbryt', close: 'Stäng', ok: 'OK',
    moveX: n => `Flytta ${n}`, to: 'Till', move: 'Flytta', movedTo: w => `Flyttad till ${w}.`, rename: 'Byt namn', del: 'Ta bort', edit: 'Ändra', moveToPlace: 'Flytta till plats', emptyFirst: 'Töm platsen för att kunna ta bort den.',
    delQ: n => `Ta bort ”${n}”? Det går inte att ångra.`, delNoteQ: 'Ta bort röstanteckningen?', rmPhotoQ: 'Ta bort fotot?', rmQ: n => `Ta bort ”${n}”?`, rmTagQ: n => `Ta bort taggen ”${n}”?`,
    newPlace: 'Ny plats', newPlaceHint: 'Till exempel Källaren, Vinden eller Garaget', renameX: n => `Byt namn på ${n}`, newTag: 'Lägg till en tagg', tagHint: 'Till exempel vandring eller vinter',
    backupBanner: d => d ? `Senaste säkerhetskopian gjordes ${d}. Allt sparas bara på den här telefonen, så spara en kopia någon annanstans.` : 'Du har inte gjort någon säkerhetskopia än. Allt sparas bara på den här telefonen, så spara en kopia någon annanstans.',
    voiceNotes: 'Röstanteckningar', voiceNotesBox: 'Röstanteckningar för lådan', menu: 'Meny', allSettings: 'Alla inställningar', usedNoted: 'Noterat. Påminnelsen börjar om.', markedSale: 'Markerad till salu.',
    placesHint: 'Till exempel källarförrådet, vinden, garaget eller sommarstugan. Bara ett namn sparas, aldrig en adress.', placeNameHint: 'Namn, t.ex. Vinden',
    fileMissing: 'Filen saknas.', savingPhoto: 'Sparar foto…', savingDocument: 'Sparar dokument…', unnamed: 'Namnlös',
    batchTitle: 'Lägg till flera saker', batchWhere: w => `De hamnar i ${w}.`, modeEach: 'Ett foto per sak', modeEachHint: 'Ta eller välj ett foto av varje sak.',
    modeMulti: 'Flera saker på ett foto', modeMultiHint: 'Lägg ut sakerna och ta ett foto. Varje sak blir en egen post.',
    batchAI: 'AI föreslår namn och detaljer utifrån fotona. Du kollar dem innan de läggs till.', batchNoAI: 'Slå på AI-assistenten för att få namn och detaljer föreslagna automatiskt. Utan den namnger du varje sak själv.',
    batchPrivacy: 'Fotona skickas till AI-tjänsten för att kännas igen.', thinking: 'Känner igen…', aiFailed: e => `Kunde inte känna igen: ${e}`, addN: n => n === 1 ? 'Lägg till 1 sak' : `Lägg till ${n} saker`,
    batchAdded: n => n === 1 ? 'La till 1 sak.' : `La till ${n} saker.`, namePh: 'Namn', include: 'Ta med', morePhotos: '+ Fler foton', noneYet: 'Inga foton än.', batchFound: n => n === 1 ? 'Hittade 1 sak.' : `Hittade ${n} saker.`,
  },
};
Object.assign(STR.en, {moreBoxes: n => `+ ${n} more boxes`});
Object.assign(STR.en, {whereYouAre: 'Where you are', moreDetails: 'More details', openBoxNow: 'Open box', closePhoto: 'Close photo', zoomHint: 'Pinch or double-tap to zoom',
  h_stopVoice: 'Stop the voice note first.', h_noRec: 'Recording isn’t available in this browser.', h_micBlocked: 'Microphone access is blocked. Allow it for Storrrage in Chrome’s site settings.',
  h_aiBusy: 'Still thinking about the last thing you said.', h_boxLabels: 'Box labels', h_printHint: 'Print this page, cut out the labels and tape them to the boxes.',
  h_addBoxesFirst: 'Add some boxes first.', h_building: 'Building the report…', h_nothingBackup: 'Nothing to back up yet.', h_preparingBackup: 'Preparing backup…', h_restoring: 'Restoring…',
  rp_title: 'Storage inventory', rp_item: 'Item', rp_value: 'Est. value', rp_stored: 'Stored since', rp_registered: 'Registered', rp_photos: 'Photos', rp_photo: 'Photo', rp_empty: 'Empty.',
  rp_packed: (d, n, v) => `Packed ${d}. ${n} items, ${v}.`, rp_generated: (d, b, n, v) => `Generated ${d}. ${b} boxes, ${n} items, estimated total value ${v}.`,
  rp_note: '“Registered” is when the item was entered in the inventory. Photo times come from the image file.', rp_ready: 'Insurance report ready',
  joinConfirmQ: 'Join this household? Everyone in it will see your things. Only join with a code from someone you know.'});
Object.assign(STR.sv, {whereYouAre: 'Var du är', moreDetails: 'Fler detaljer', openBoxNow: 'Öppen låda', closePhoto: 'Stäng bilden', zoomHint: 'Nyp eller dubbeltryck för att zooma',
  h_stopVoice: 'Stoppa röstanteckningen först.', h_noRec: 'Inspelning fungerar inte i den här webbläsaren.', h_micBlocked: 'Mikrofonen är blockerad. Tillåt den för Storrrage i Chromes webbplatsinställningar.',
  h_aiBusy: 'Tänker fortfarande på det du sa senast.', h_boxLabels: 'Lådetiketter', h_printHint: 'Skriv ut sidan, klipp ut etiketterna och tejpa fast dem på lådorna.',
  h_addBoxesFirst: 'Lägg till några lådor först.', h_building: 'Gör rapporten…', h_nothingBackup: 'Det finns inget att säkerhetskopiera än.', h_preparingBackup: 'Förbereder säkerhetskopian…', h_restoring: 'Återställer…',
  rp_title: 'Förrådsinventering', rp_item: 'Sak', rp_value: 'Uppskattat värde', rp_stored: 'Förvarad sedan', rp_registered: 'Registrerad', rp_photos: 'Foton', rp_photo: 'Foto', rp_empty: 'Tom.',
  rp_packed: (d, n, v) => `Packad ${d}. ${n} saker, ${v}.`, rp_generated: (d, b, n, v) => `Skapad ${d}. ${b} lådor, ${n} saker, uppskattat totalvärde ${v}.`,
  rp_note: '”Registrerad” är när saken lades in i inventeringen. Fototiderna kommer från bildfilen.', rp_ready: 'Försäkringsrapporten är klar',
  joinConfirmQ: 'Gå med i hushållet? Alla i det ser dina saker. Gå bara med via en kod från någon du känner.'});
Object.assign(STR.sv, {moreBoxes: n => `+ ${n} lådor till`});
Object.assign(STR.en, {
    aiSuggest: 'Suggest from photo', testTag: 'TEST', aiLooking: 'Looking at the photo…', aiNothing: 'The AI didn’t recognise anything in the photo.',
    aiSuggestH: 'Suggestions from the photo', aiSuggestHint: 'Tick what you want to use. Ticked details replace what’s there now.', aiNow: v => `now: ${v}`, apply: 'Use selected', aiApplied: n => n === 1 ? 'Updated 1 detail.' : `Updated ${n} details.`, aiNeedPhoto: 'Add a photo first.',
    rmPhoto: 'Remove photo',
    addPhoto: 'Add photo',
    editBoxH: 'Edit box',
    newBox: 'New box',
    name: 'Name',
    boxNamePh: 'Winter clothes',
    storagePlace: 'Place',
    whereInPlace: 'Where in that place',
    wherePh: 'Back wall, top shelf',
    boxPhoto: 'Photo of the box',
    delBox: 'Delete box',
    saveBox: 'Save box',
    addBox: 'Add box',
    waitPhoto: 'Wait for the photo to finish saving.',
    nameBox: 'Give the box a name.',
    whoPhone: 'Who uses this phone?',
    whoPhoneHint: 'Lets “my” and “mina” mean this person when you talk to Storrrage. It also records who registered each item.',
    notSet: 'Not set',
    scanH: 'Scan a box label',
    pointCam: 'Point the camera at the QR code on the box.',
    typeCode: 'Or type the box code',
    openBox: 'Open box',
    noCam: 'The camera isn’t available here. Type the code from the label instead.',
    camBlocked: 'Camera access was blocked. Type the code from the label instead, or allow the camera for this app in Chrome’s site settings.',
    offline: 'Offline. Everything you do is saved on this phone.',
    shareTo: 'Share to Drive, email or another app',
    saveToPhone: 'Save to phone (Downloads)',
    savedDl: 'Saved to your Downloads folder.',
    shareFail: 'Sharing didn’t work. Use Save to phone instead.',
    labelsAllH: 'Labels for all boxes',
    talkH: 'Talk to Storrrage',
    send: 'Send',
    pause: 'Act on what I said after a pause of',
    whatSay: 'What can I say?',
    noSignal: 'Using it without signal',
    noSignalTxt: 'Chrome’s speech recognition usually needs signal. Without it, tap the text box and use the microphone on your keyboard instead. Your keyboard can recognise speech offline once you’ve downloaded the language in its voice input settings (menu names vary between phones). Or record a voice note and deal with it later.',
    noSR: 'Speech recognition isn’t available in this browser. Use the microphone on your keyboard in the box below instead.',
    readAloud: 'Read answers out loud',
    aiIntro: 'With AI on, you can talk freely. Storrrage understands follow-ups like “it”, “those boxes” or “back to the watermelons”, and asks about details that matter. It can also recognise things in photos when you add several items. Without signal, or if the AI fails, it falls back to the simple commands.',
    provider: 'Provider',
    gemFree: 'Google Gemini (free, for testing)',
    claudePaid: 'Claude (paid)',
    simpleOnly: 'Simple commands only. Nothing is sent anywhere.',
    testOnly: 'Use made-up test items only.',
    freeTier: 'On Google’s free tier, what you send may be used to improve Google’s products and can be read by people. Don’t send your real inventory until you switch to a paid option.',
    apiKey: 'API key',
    checkKey: 'Check the key',
    checkToChoose: 'Check the key to choose',
    aiSends: 'When you talk, Storrrage sends what you said, the last part of the conversation, and the names and details of your places, boxes and items. When you add several items from photos, those photos are sent too. Voice notes are never sent.',
    pasteKey: 'Paste the key first.',
    checking: 'Checking…',
    works: 'Works.',
    pasteToTurnOn: 'Paste the API key to turn AI on.',
    aiIsOff: 'AI is off.',
    cantSave: 'Couldn’t save the setting on this phone.',
    getGem: 'Get a free key: open aistudio.google.com, sign in with a Google account, and choose “Get API key”.',
    getClaude: 'Get a key: open console.anthropic.com, add a small prepaid amount under Billing, then create a key under API keys.',
    keyLocal: 'The key is stored only on this phone and isn’t included in backups.'
});
Object.assign(STR.sv, {
    aiSuggest: 'Föreslå från foto', testTag: 'TEST', aiLooking: 'Tittar på fotot…', aiNothing: 'AI:n kände inte igen något på fotot.',
    aiSuggestH: 'Förslag från fotot', aiSuggestHint: 'Bocka för det du vill använda. Ifyllda detaljer ersätter det som står nu.', aiNow: v => `nu: ${v}`, apply: 'Använd valda', aiApplied: n => n === 1 ? 'Uppdaterade 1 detalj.' : `Uppdaterade ${n} detaljer.`, aiNeedPhoto: 'Lägg till ett foto först.',
    rmPhoto: 'Ta bort foto',
    addPhoto: 'Lägg till foto',
    editBoxH: 'Ändra låda',
    newBox: 'Ny låda',
    name: 'Namn',
    boxNamePh: 'Vinterkläder',
    storagePlace: 'Plats',
    whereInPlace: 'Var på platsen',
    wherePh: 'Bakre väggen, översta hyllan',
    boxPhoto: 'Foto av lådan',
    delBox: 'Ta bort låda',
    saveBox: 'Spara låda',
    addBox: 'Lägg till låda',
    waitPhoto: 'Vänta tills fotot har sparats.',
    nameBox: 'Ge lådan ett namn.',
    whoPhone: 'Vem använder den här telefonen?',
    whoPhoneHint: 'Gör att ”min” och ”my” betyder den här personen när du pratar med Storrrage. Det visar också vem som registrerade varje sak.',
    notSet: 'Inte vald',
    scanH: 'Skanna en etikett',
    pointCam: 'Rikta kameran mot QR-koden på lådan.',
    typeCode: 'Eller skriv lådans kod',
    openBox: 'Öppna låda',
    noCam: 'Kameran är inte tillgänglig här. Skriv koden från etiketten i stället.',
    camBlocked: 'Kameran blockerades. Skriv koden från etiketten i stället, eller tillåt kameran för appen i Chromes webbplatsinställningar.',
    offline: 'Offline. Allt du gör sparas på den här telefonen.',
    shareTo: 'Dela till Drive, e-post eller en annan app',
    saveToPhone: 'Spara på telefonen (Hämtade filer)',
    savedDl: 'Sparad i mappen Hämtade filer.',
    shareFail: 'Delningen fungerade inte. Använd Spara på telefonen i stället.',
    labelsAllH: 'Etiketter för alla lådor',
    talkH: 'Prata med Storrrage',
    send: 'Skicka',
    pause: 'Agera på det jag sa efter en paus på',
    whatSay: 'Vad kan jag säga?',
    noSignal: 'Använda utan täckning',
    noSignalTxt: 'Chromes taligenkänning behöver oftast täckning. Utan den, tryck i textrutan och använd mikrofonen på tangentbordet i stället. Tangentbordet kan känna igen tal offline när du har laddat ner språket i dess inställningar för röstinmatning (menyernas namn varierar mellan telefoner). Eller spela in en röstanteckning och ta hand om den senare.',
    noSR: 'Taligenkänning finns inte i den här webbläsaren. Använd mikrofonen på tangentbordet i rutan nedan i stället.',
    readAloud: 'Läs upp svaren',
    aiIntro: 'Med AI på kan du prata fritt. Storrrage förstår uppföljningar som ”den”, ”de lådorna” eller ”tillbaka till vattenmelonerna”, och frågar om detaljer som spelar roll. Den kan också känna igen saker på foton när du lägger till flera. Utan täckning, eller om AI:n fallerar, används de enkla kommandona.',
    provider: 'Leverantör',
    gemFree: 'Google Gemini (gratis, för test)',
    claudePaid: 'Claude (betald)',
    simpleOnly: 'Bara enkla kommandon. Inget skickas någonstans.',
    testOnly: 'Använd bara påhittade testsaker.',
    freeTier: 'På Googles gratisnivå kan det du skickar användas för att förbättra Googles produkter och läsas av människor. Skicka inte din riktiga inventering förrän du bytt till ett betalt alternativ.',
    apiKey: 'API-nyckel',
    checkKey: 'Kontrollera nyckeln',
    checkToChoose: 'Kontrollera nyckeln för att välja',
    aiSends: 'När du pratar skickar Storrrage det du sa, den senaste delen av samtalet och namn och detaljer för dina platser, lådor och saker. När du lägger till flera saker från foton skickas de fotona också. Röstanteckningar skickas aldrig.',
    pasteKey: 'Klistra in nyckeln först.',
    checking: 'Kontrollerar…',
    works: 'Fungerar.',
    pasteToTurnOn: 'Klistra in API-nyckeln för att slå på AI.',
    aiIsOff: 'AI är av.',
    cantSave: 'Kunde inte spara inställningen på telefonen.',
    getGem: 'Skaffa en gratis nyckel: öppna aistudio.google.com, logga in med ett Google-konto och välj ”Get API key”.',
    getClaude: 'Skaffa en nyckel: öppna console.anthropic.com, fyll på ett litet belopp under Billing och skapa en nyckel under API keys.',
    keyLocal: 'Nyckeln sparas bara på den här telefonen och ingår inte i säkerhetskopior.'
});
Object.assign(STR.en, {
  inside: 'Inside', topLevel: p => `${p}, directly`, nameOptional: 'Leave empty to name it after what’s inside', boxInBox: 'Box inside this box', boxesInside: 'Boxes inside',
  addHereBox: b => `Add to ${b}`, notes: 'Notes', recent: 'Recently viewed', favorites: 'Favorites', fav: 'Favorite', unfav: 'Remove favorite',
  viewLarge: 'Large tiles', viewSmall: 'Small tiles', viewList: 'List', select: 'Select', selected: n => `${n} selected`, moveSel: 'Move to…', delSel: 'Delete',
  delSelQ: n => n === 1 ? 'Delete 1 item? This can’t be undone.' : `Delete ${n} items? This can’t be undone.`, movedN: (n, w) => `Moved ${n} to ${w}.`, deletedN: n => `Deleted ${n}.`,
  didYouMean: 'Did you mean', share: 'Share where it is', copied: 'Copied. Paste it in a message.', shareCopy: 'Share a copy of this place', shareCopyHint: 'The other person opens Storrrage and chooses Restore from backup. They get their own copy; it doesn’t stay in sync until login and sharing arrive.',
  icon: 'Picture', numbering: 'Box numbers', numPlace: 'Separate for each place (B-001 in every place)', numAccount: 'One series for all places',
  export: 'Export a list', exportH: 'Export a list of your things', exportHint: 'Neatly organised in rows: place, box, item and details.', excel: 'Excel (.xlsx)', word: 'Word (.doc)', pdf: 'PDF', scope: 'What to include', exportAll: 'Everything', loadingLib: 'Preparing the file…', needNet: 'This needs signal the first time.',
  backupHint: d => d ? `Last backup ${d}.` : 'No backup yet.', backupDo: 'Back up', addNav: 'Add', whichPlace: 'Add to which place?', nameNeeded: 'Every item needs a name.', discarded: 'Discarded: the item had no name.',
  col_place: 'Place', col_box: 'Box', col_inbox: 'Inside', col_item: 'Item', col_cat: 'Category', col_brand: 'Brand', col_model: 'Model', col_size: 'Size', col_color: 'Colour', col_owner: 'Whose', col_status: 'Status', col_qty: 'Qty', col_value: 'Value (kr)', col_stored: 'Stored since', col_used: 'Last used', col_tags: 'Tags', col_notes: 'Notes', col_serial: 'Serial no.',
  listTitle: 'Storage list', total: 'Total',
});
Object.assign(STR.sv, {
  inside: 'Inuti', topLevel: p => `${p}, direkt`, nameOptional: 'Lämna tomt så får den namn efter innehållet', boxInBox: 'Låda i den här lådan', boxesInside: 'Lådor inuti',
  addHereBox: b => `Lägg till i ${b}`, notes: 'Anteckningar', recent: 'Nyligen visade', favorites: 'Favoriter', fav: 'Favorit', unfav: 'Ta bort favorit',
  viewLarge: 'Stora rutor', viewSmall: 'Små rutor', viewList: 'Lista', select: 'Välj', selected: n => `${n} valda`, moveSel: 'Flytta till…', delSel: 'Ta bort',
  delSelQ: n => n === 1 ? 'Ta bort 1 sak? Det går inte att ångra.' : `Ta bort ${n} saker? Det går inte att ångra.`, movedN: (n, w) => `Flyttade ${n} till ${w}.`, deletedN: n => `Tog bort ${n}.`,
  didYouMean: 'Menade du', share: 'Dela var den finns', copied: 'Kopierat. Klistra in i ett meddelande.', shareCopy: 'Dela en kopia av platsen', shareCopyHint: 'Mottagaren öppnar Storrrage och väljer Återställ från säkerhetskopia. Hen får en egen kopia; den synkas inte förrän inloggning och delning finns.',
  icon: 'Bild', numbering: 'Lådnummer', numPlace: 'Egen serie per plats (B-001 på varje plats)', numAccount: 'En serie för alla platser',
  export: 'Exportera en lista', exportH: 'Exportera en lista över dina saker', exportHint: 'Snyggt uppställt i rader: plats, låda, sak och detaljer.', excel: 'Excel (.xlsx)', word: 'Word (.doc)', pdf: 'PDF', scope: 'Vad ska med', exportAll: 'Allt', loadingLib: 'Förbereder filen…', needNet: 'Det här behöver täckning första gången.',
  backupHint: d => d ? `Senaste säkerhetskopia ${d}.` : 'Ingen säkerhetskopia än.', backupDo: 'Säkerhetskopiera', addNav: 'Lägg till', whichPlace: 'Lägg till på vilken plats?', nameNeeded: 'Varje sak behöver ett namn.', discarded: 'Slängd: saken hade inget namn.',
  col_place: 'Plats', col_box: 'Låda', col_inbox: 'Inuti', col_item: 'Sak', col_cat: 'Kategori', col_brand: 'Märke', col_model: 'Modell', col_size: 'Storlek', col_color: 'Färg', col_owner: 'Vems', col_status: 'Status', col_qty: 'Antal', col_value: 'Värde (kr)', col_stored: 'Förvaras sedan', col_used: 'Senast använd', col_tags: 'Taggar', col_notes: 'Anteckningar', col_serial: 'Serienr',
  listTitle: 'Förrådslista', total: 'Totalt',
});
Object.assign(STR.en, {showAll: 'Show all', dragLooseHint: 'Hold a round marker and drag it into a zone to show where it stands.', addZone: 'Add zone', zoneExists: 'There’s already a zone with that name.',
  doorSide: 'Where is the door?', doorHint: 'The map is drawn from the door inwards. Pick the side the door is on.', door_top: 'Top', door_bottom: 'Bottom', door_left: 'Left', door_right: 'Right'});
STR.en.doorHint = 'Pick the side the door is on, and where the far end is. They’re shown as markers around the map.'; STR.en.doorSide = 'Door and far end';
Object.assign(STR.sv, {showAll: 'Visa alla', dragLooseHint: 'Håll in en rund markör och dra in den i en zon för att visa var den står.', addZone: 'Lägg till zon', zoneExists: 'Det finns redan en zon med det namnet.',
  doorSide: 'Var är dörren?', doorHint: 'Kartan ritas från dörren och inåt. Välj vilken sida dörren sitter på.', door_top: 'Uppe', door_bottom: 'Nere', door_left: 'Vänster', door_right: 'Höger'});
STR.sv.doorHint = 'Välj vilken sida dörren sitter på, och var längst in är. Det visas som markeringar runt kartan.'; STR.sv.doorSide = 'Dörr och längst in';
Object.assign(STR.en, {dragHint: 'Hold a box or a round marker and drag it onto a stack or into a zone.', back: 'Back', switchSpace: 'Choose place', shelf: 'Grid', map: 'Map', door: 'Door', farIn: 'Far end', noZone: 'No zone', placement: 'Placement',
  placementHint: 'Where the box stands: its zone (a spot in this place, like a shelf or by the door) and stack.', zone: 'Zone', zoneHint: 'A zone marks a spot in this place, e.g. a shelf or by the door',
  stack: 'Stack', newStack: 'A new stack', level: 'Level', onTop: 'On top', atBottom: 'At the bottom', stackOf: (n, codes) => codes ? `Stack ${n}: on ${codes}` : `Stack ${n}`, closerDoor: 'Move up', furtherIn: 'Move down'});
Object.assign(STR.sv, {dragHint: 'Håll in en låda eller rund markör och dra den till en stapel eller zon.', back: 'Tillbaka', switchSpace: 'Välj plats', shelf: 'Rutnät', map: 'Karta', door: 'Dörren', farIn: 'Längst in', noZone: 'Utan zon', placement: 'Placering',
  placementHint: 'Var lådan står: zonen (en del av platsen, som en hylla eller vid dörren) och stapeln.', zone: 'Zon', zoneHint: 'En zon markerar en del av platsen, t.ex. en hylla eller vid dörren',
  stack: 'Stapel', newStack: 'En ny stapel', level: 'Nivå', onTop: 'Överst', atBottom: 'Längst ner', stackOf: (n, codes) => codes ? `Stapel ${n}: ovanpå ${codes}` : `Stapel ${n}`, closerDoor: 'Flytta upp', furtherIn: 'Flytta ner'});
Object.assign(STR.en, {collections: 'Tags', collection: 'Tag', inBoxes: n => n === 1 ? 'in 1 place' : `in ${n} places`, showOnMap: 'Show on map', insideBox: 'inside',
  toCollection: 'Tag', collHint: 'Things with the same tag are shown together, even when they’re in different boxes.', collPh: 'For example Christmas or Winter', addedToColl: (n, t) => `Added ${n} to #${t}.`,
  isHere: 'is here', openItem: 'Open item', foundIn: 'Found in'});
Object.assign(STR.sv, {collections: 'Taggar', collection: 'Tagg', inBoxes: n => n === 1 ? 'på 1 ställe' : `på ${n} ställen`, showOnMap: 'Visa på kartan', insideBox: 'inuti',
  toCollection: 'Tagg', collHint: 'Saker med samma tagg visas tillsammans, även om de ligger i olika lådor.', collPh: 'Till exempel Jul eller Vinter', addedToColl: (n, t) => `La till ${n} i #${t}.`,
  isHere: 'ligger här', openItem: 'Öppna saken', foundIn: 'Hittad i'});
Object.assign(STR.en, {list: 'List', takeOut: 'Take out', putBack: 'Put back', outTag: 'Out', outSince: d => `out since ${d}`, backBy: d => `back by ${d}`, outSection: 'Out of storage right now',
  outUntil: 'Out until (optional)', tookOut: (n, w) => `${n} taken out of ${w}. Its place is kept.`, putBackDone: (n, w) => `${n} is back in ${w}.`, deletedX: n => `${n} deleted.`, undo: 'Undo', more: 'More',
  quickAddPh: w => `Add to ${w}…`, boxEmpty: 'Nothing here yet.', backQ: 'Is this back in storage?', stillOut: 'Still out', isBack: 'It’s back',
  adLabel: 'Ad · test slot', adTitle: 'Storrrage without ads', adText: 'Premium removes ads and lets your household share storage.', readMore: 'Read more', adsSetting: 'Show ad slots (test)', swipeHint: 'Swipe right to take out or put back, left to delete.'});
Object.assign(STR.sv, {list: 'Lista', takeOut: 'Ta ut', putBack: 'Ställ tillbaka', outTag: 'Framme', outSince: d => `framme sedan ${d}`, backBy: d => `tillbaka ${d}`, outSection: 'Framme just nu',
  outUntil: 'Framme till (valfritt)', tookOut: (n, w) => `${n} är framme från ${w}. Platsen sparas.`, putBackDone: (n, w) => `${n} är tillbaka i ${w}.`, deletedX: n => `${n} borttagen.`, undo: 'Ångra', more: 'Mer',
  quickAddPh: w => `Lägg till i ${w}…`, boxEmpty: 'Inget här än.', backQ: 'Är den tillbaka i förrådet?', stillOut: 'Fortfarande framme', isBack: 'Den är tillbaka',
  adLabel: 'Annons · testplats', adTitle: 'Storrrage utan reklam', adText: 'Premium tar bort reklam och låter hushållet dela förvaring.', readMore: 'Läs mer', adsSetting: 'Visa annonsplatser (test)', swipeHint: 'Svep höger för att ta ut eller ställa tillbaka, vänster för att ta bort.'});
Object.assign(STR.en, {addShort: 'Item', severalShort: 'Several', subShort: 'Box inside', recentSearches: 'Recent searches', clear: 'Clear', pickIcon: 'Change icon', pickIconHint: 'Used when the item has no photo. Automatic picks one from the name.', autoIcon: 'Automatic'});
Object.assign(STR.sv, {addShort: 'Sak', severalShort: 'Flera', subShort: 'Låda inuti', recentSearches: 'Senaste sökningar', clear: 'Rensa', pickIcon: 'Byt ikon', pickIconHint: 'Visas när saken inte har något foto. Automatisk väljer efter namnet.', autoIcon: 'Automatisk'});
Object.assign(STR.en, {
  askOut: n => `Taking ${n} out?`, yesTemp: 'Yes, for a while', yesGone: 'Yes, for good', no: 'No',
  allOutAlready: 'Everything is already out.', allBackAlready: 'Everything is already back.', tookOutN: (n, w) => `Took out ${n} from ${w}. Their places are kept.`, putBackN: (n, w) => `Put back ${n} in ${w}.`,
  boxOutDone: c => `${c} is out. Its place on the map is kept.`, boxBackDone: c => `${c} is back in place.`, takeOutBox: 'Take out the whole box', putBackBox: 'Put the box back', boxIsOut: 'The whole box is out',
  outOfN: (o, n) => `${o} of ${n} out`, takeOutAll: 'Take out all', putBackAll: 'Put all back',
  today: 'today', yesterday: 'yesterday', daysAgo: n => `${n} days ago`, weeksAgo: n => n === 1 ? '1 week ago' : `${n} weeks ago`, monthsAgo: n => n === 1 ? '1 month ago' : `${n} months ago`, yearsAgo: n => n === 1 ? '1 year ago' : `${n} years ago`,
  checked: 'checked', neverChecked: 'never checked', openedApp: 'opened in the app', changedAgo: 'changed',
  checkQ: 'Is everything in this box still right?', checkYes: '✓ Yes, all correct', checkNo: 'Something changed', checkedThanks: 'Thanks! Marked as checked today.', checkFix: 'Update what changed below, then mark it as checked.',
  checkedYear: (c, n) => `${c} of ${n} boxes checked or updated this year`,
  nudgeCollOut: c => `It’s that time of year. Taking out ${c}?`, nudgeCollBack: c => `Is ${c} back in storage?`, nudgePattern: (n, d) => `You usually take out ${n} about every ${d} days. Taking it out now?`, nudgeYearly: n => `You took out ${n} around this time last year. Again?`,
  notNow: 'Not now', suggestions: 'Suggestions'});
Object.assign(STR.sv, {
  askOut: n => `Tar du ut ${n}?`, yesTemp: 'Ja, tillfälligt', yesGone: 'Ja, för gott', no: 'Nej',
  allOutAlready: 'Allt är redan framme.', allBackAlready: 'Allt är redan tillbaka.', tookOutN: (n, w) => `Tog ut ${n} från ${w}. Platserna sparas.`, putBackN: (n, w) => `Ställde tillbaka ${n} i ${w}.`,
  boxOutDone: c => `${c} är framme. Platsen på kartan sparas.`, boxBackDone: c => `${c} är tillbaka på sin plats.`, takeOutBox: 'Ta ut hela lådan', putBackBox: 'Ställ tillbaka lådan', boxIsOut: 'Hela lådan är framme',
  outOfN: (o, n) => `${o} av ${n} framme`, takeOutAll: 'Ta ut alla', putBackAll: 'Ställ tillbaka alla',
  today: 'i dag', yesterday: 'i går', daysAgo: n => `för ${n} dagar sedan`, weeksAgo: n => n === 1 ? 'för 1 vecka sedan' : `för ${n} veckor sedan`, monthsAgo: n => n === 1 ? 'för 1 månad sedan' : `för ${n} månader sedan`, yearsAgo: n => n === 1 ? 'för 1 år sedan' : `för ${n} år sedan`,
  checked: 'kontrollerad', neverChecked: 'aldrig kontrollerad', openedApp: 'öppnad i appen', changedAgo: 'ändrad',
  checkQ: 'Stämmer allt i lådan fortfarande?', checkYes: '✓ Ja, allt stämmer', checkNo: 'Något har ändrats', checkedThanks: 'Tack! Markerad som kontrollerad i dag.', checkFix: 'Uppdatera det som ändrats nedan, och markera sedan som kontrollerad.',
  checkedYear: (c, n) => `${c} av ${n} lådor kontrollerade eller uppdaterade i år`,
  nudgeCollOut: c => `Det är den tiden på året. Tar du ut ${c}?`, nudgeCollBack: c => `Är ${c} tillbaka i förrådet?`, nudgePattern: (n, d) => `Du brukar ta ut ${n} ungefär var ${d}:e dag. Tar du ut den nu?`, nudgeYearly: n => `Du tog ut ${n} runt den här tiden förra året. Igen?`,
  notNow: 'Inte nu', suggestions: 'Förslag'});
Object.assign(STR.en, {sortBy: 'Sort', sort_manual: 'My order', sort_az: 'A–Z', sort_changed: 'Last changed', sort_added: 'Last added', sort_used: 'Last used',
  listDragHint: 'Hold a box or a thing to drag it – up, down or into another box.', editItem: 'Edit', trash: 'Deleted', trashHint: 'Deleted things are kept here for 30 days, then they’re gone for good.',
  daysLeft: n => n === 1 ? '1 day left' : `${n} days left`, restoreItem: 'Restore', trashEmpty: 'Nothing deleted.', emptyTrash: 'Empty now', emptyTrashQ: n => `Delete ${n} thing${n === 1 ? '' : 's'} for good?`,
  restoredTo: (n, w) => `${n} is back in ${w}.`, inTrash: 'Kept in Deleted for 30 days.', remindDate: 'Or pick a date', toCalendar: 'Add to calendar',
  outNow: 'Out now', allBoxes: 'All boxes', allItems: 'All things', itemsH: 'Things', nothingOut: 'Nothing is out right now.'});
Object.assign(STR.sv, {sortBy: 'Sortera', sort_manual: 'Egen ordning', sort_az: 'A–Ö', sort_changed: 'Senast ändrad', sort_added: 'Senast tillagd', sort_used: 'Senast använd',
  listDragHint: 'Håll in en låda eller sak för att dra den – upp, ner eller till en annan låda.', editItem: 'Ändra', trash: 'Borttaget', trashHint: 'Borttagna saker sparas här i 30 dagar, sedan försvinner de för gott.',
  daysLeft: n => n === 1 ? '1 dag kvar' : `${n} dagar kvar`, restoreItem: 'Ta tillbaka', trashEmpty: 'Inget borttaget.', emptyTrash: 'Töm nu', emptyTrashQ: n => `Ta bort ${n} ${n === 1 ? 'sak' : 'saker'} för gott?`,
  restoredTo: (n, w) => `${n} är tillbaka i ${w}.`, inTrash: 'Sparas i Borttaget i 30 dagar.', remindDate: 'Eller välj datum', toCalendar: 'Lägg i kalendern',
  outNow: 'Framme nu', allBoxes: 'Alla lådor', allItems: 'Alla saker', itemsH: 'Saker', nothingOut: 'Inget är framme just nu.'});
function tr(k, ...a){ const v = (STR[lang] && STR[lang][k] !== undefined) ? STR[lang][k] : STR.en[k]; return typeof v === 'function' ? v(...a) : (v ?? k); }
const SEASON_SV = {Winter: 'Vinter', Summer: 'Sommar', 'Spring/autumn': 'Vår/höst', 'All year': 'Året runt'};
const STATUS_KEYS = {'In storage': 'st_store', 'On loan': 'st_loan', 'For sale': 'st_sale', 'Sold': 'st_sold', 'Given away': 'st_given', 'Throw away': 'st_throw'};
const showColor = c => !c ? '' : lang === 'sv' ? cap(COLOR_SV[c] || c) : c;
const showSeason = s => !s ? '' : lang === 'sv' ? (SEASON_SV[s] || s) : s;
const showStatus = s => !s ? '' : STATUS_KEYS[s] ? tr(STATUS_KEYS[s]) : s;
const showOwner = o => (Array.isArray(o) ? o : [o]).filter(Boolean).map(n => n === 'Shared' ? tr('shared') : n).join(', ');
const ownerNames = it => [...new Set((Array.isArray(it.owners) ? it.owners : it.owner ? [it.owner] : []).map(n => String(n || '').trim()).filter(Boolean))];
const itemOwner = it => showOwner(ownerNames(it));
function setItemOwners(it, names){
  const input = Array.isArray(names) ? names : String(names || '').split(/[;,]/);
  const clean = [...new Set(input.map(n => {
    const name = String(n || '').trim();
    return name && (name.toLowerCase() === 'shared' || name.toLowerCase() === tr('shared').toLowerCase()) ? 'Shared' : name;
  }).filter(Boolean))];
  if (clean.length){ it.owners = clean; it.owner = clean[0]; recordRecentOwners(clean); }
  else { delete it.owners; delete it.owner; }
}
const statusOptions = selected => `<option value="">${tr('status')}…</option>${Object.keys(STATUS_KEYS).map(s => `<option value="${esc(s)}" ${selected === s ? 'selected' : ''}>${tr(STATUS_KEYS[s])}</option>`).join('')}${selected && !STATUS_KEYS[selected] ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : ''}<option value="__custom__">${tr('st_custom')}</option>`;
// map typed Swedish values back to the stored (English) value
const fromColor = v => { if (!v) return ''; const s = v.trim().toLowerCase(); const en = Object.keys(COLOR_SV).find(k => k.toLowerCase() === s || COLOR_SV[k] === s); return en || findColor(s) || cap(v.trim()); };
const fromSeason = v => { if (!v) return ''; const s = v.trim().toLowerCase(); return Object.keys(SEASON_SV).find(k => k.toLowerCase() === s || SEASON_SV[k].toLowerCase() === s) || cap(v.trim()); };
/* ---------- small in-app dialogs ---------- */
function askText(title, {placeholder = '', value = '', ok} = {}){
  return new Promise(res => {
    let done = false; const fin = v => { if (done) return; done = true; res(v); };
    openSheet(`<h3>${esc(title)}</h3><input class="input" id="atIn" value="${esc(value)}" placeholder="${esc(placeholder)}" autocapitalize="sentences" enterkeyhint="done">
      <div class="sheet-foot" style="margin-top:14px"><button class="btn quiet" id="atX">${tr('cancel')}</button><button class="btn primary" id="atOk">${esc(ok || tr('ok'))}</button></div>`, () => fin(null));
    const go = () => { const v = $('#atIn').value.trim(); fin(v || null); closeSheet(); };
    $('#atOk').onclick = go; $('#atX').onclick = () => { fin(null); closeSheet(); };
    $('#atIn').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    setTimeout(() => { const el = $('#atIn'); if (el){ el.focus(); el.select(); } }, 60);
  });
}
function askChoice(text, yes, no){
  return new Promise(res => {
    let done = false; const fin = v => { if (done) return; done = true; res(v); };
    openSheet(`<p style="margin:0 0 16px">${esc(text)}</p><div class="sheet-foot"><button class="btn quiet" id="chNo">${esc(no)}</button><button class="btn primary" id="chYes">${esc(yes)}</button></div>`, () => fin(false));
    $('#chYes').onclick = () => { fin(true); closeSheet(); }; $('#chNo').onclick = () => { fin(false); closeSheet(); };
  });
}
function askConfirm(text, ok){
  ok = ok || tr('del');
  return new Promise(res => {
    let done = false; const fin = v => { if (done) return; done = true; res(v); };
    openSheet(`<p style="margin:0 0 16px">${esc(text)}</p><div class="sheet-foot"><button class="btn quiet" id="acX">${tr('cancel')}</button><button class="btn danger" id="acOk">${esc(ok)}</button></div>`, () => fin(false));
    $('#acOk').onclick = () => { fin(true); closeSheet(); }; $('#acX').onclick = () => { fin(false); closeSheet(); };
  });
}
function logoSVG(){
  return `<svg viewBox="0 0 512 512" aria-hidden="true" class="logosvg"><rect width="512" height="512" rx="96" fill="#2F1160"/><rect x="107" y="62" width="298" height="6" fill="#CFC8EA"/><rect x="107" y="139.2" width="298" height="6" fill="#CFC8EA"/><rect x="107" y="216.4" width="298" height="6" fill="#CFC8EA"/><rect x="107" y="293.6" width="298" height="6" fill="#CFC8EA"/><rect x="107" y="370.8" width="298" height="6" fill="#CFC8EA"/><rect x="107" y="448" width="298" height="6" fill="#CFC8EA"/><rect x="122" y="72" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M122 88.1V78a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V88.1z" fill="#E8B677"/><rect x="150.2" y="94.8" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="213.3" y="72" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M213.3 88.1V78a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V88.1z" fill="#E8B677"/><rect x="241.5" y="94.8" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="304.7" y="72" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M304.7 88.1V78a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V88.1z" fill="#E8B677"/><rect x="332.8" y="94.8" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="122" y="149.2" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M122 165.3V155.2a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V165.3z" fill="#E8B677"/><rect x="150.2" y="172" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="213.3" y="149.2" width="85.3" height="67.2" rx="6" fill="#3F2270"/><path d="M213.3 165.3V155.2a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V165.3z" fill="#472A7C"/><rect x="241.5" y="172" width="29" height="8.7" rx="4.4" fill="#2A0F55"/><rect x="304.7" y="149.2" width="85.3" height="67.2" rx="6" fill="#3F2270"/><path d="M304.7 165.3V155.2a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V165.3z" fill="#472A7C"/><rect x="332.8" y="172" width="29" height="8.7" rx="4.4" fill="#2A0F55"/><rect x="122" y="226.4" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M122 242.5V232.4a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V242.5z" fill="#E8B677"/><rect x="150.2" y="249.2" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="213.3" y="226.4" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M213.3 242.5V232.4a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V242.5z" fill="#E8B677"/><rect x="241.5" y="249.2" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="304.7" y="226.4" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M304.7 242.5V232.4a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V242.5z" fill="#E8B677"/><rect x="332.8" y="249.2" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="122" y="303.6" width="85.3" height="67.2" rx="6" fill="#3F2270"/><path d="M122 319.7V309.6a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V319.7z" fill="#472A7C"/><rect x="150.2" y="326.4" width="29" height="8.7" rx="4.4" fill="#2A0F55"/><rect x="213.3" y="303.6" width="85.3" height="67.2" rx="6" fill="#3F2270"/><path d="M213.3 319.7V309.6a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V319.7z" fill="#472A7C"/><rect x="241.5" y="326.4" width="29" height="8.7" rx="4.4" fill="#2A0F55"/><rect x="304.7" y="303.6" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M304.7 319.7V309.6a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V319.7z" fill="#E8B677"/><rect x="332.8" y="326.4" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="122" y="380.8" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M122 396.9V386.8a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V396.9z" fill="#E8B677"/><rect x="150.2" y="403.6" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="213.3" y="380.8" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M213.3 396.9V386.8a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V396.9z" fill="#E8B677"/><rect x="241.5" y="403.6" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="304.7" y="380.8" width="85.3" height="67.2" rx="6" fill="#D49A55"/><path d="M304.7 396.9V386.8a6 6 0 0 1 6-6h73.3a6 6 0 0 1 6 6V396.9z" fill="#E8B677"/><rect x="332.8" y="403.6" width="29" height="8.7" rx="4.4" fill="#7A4E22"/><rect x="104" y="56" width="12" height="412" rx="3" fill="#F2F0FA"/><rect x="108.2" y="65" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="77" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="89" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="101" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="113" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="125" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="137" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="149" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="161" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="173" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="185" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="197" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="209" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="221" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="233" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="245" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="257" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="269" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="281" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="293" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="305" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="317" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="329" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="341" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="353" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="365" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="377" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="389" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="401" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="413" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="425" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="437" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="108.2" y="449" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="396" y="56" width="12" height="412" rx="3" fill="#F2F0FA"/><rect x="400.2" y="65" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="77" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="89" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="101" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="113" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="125" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="137" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="149" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="161" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="173" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="185" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="197" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="209" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="221" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="233" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="245" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="257" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="269" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="281" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="293" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="305" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="317" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="329" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="341" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="353" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="365" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="377" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="389" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="401" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="413" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="425" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="437" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/><rect x="400.2" y="449" width="3.6" height="6" rx="1.5" fill="#B9B1DC"/></svg>`;
}
const app = $('#app');
const ICON = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 11.5h3V21h5.5v-6h3v6H19v-9.5h3z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="4.5"/><path d="M3.5 21c.6-4.6 4.1-7.5 8.5-7.5s7.9 2.9 8.5 7.5z"/></svg>',
  mic: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>',
  pin: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  starO: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.2 2.7 5.5 6 .9-4.4 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.4-4.2 6-.9z"/></svg>',
  chat: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/></svg>',
  scan: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>',
  install: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M12 7v7M9 11.5l3 3 3-3"/></svg>',
  chart: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/></svg>',
  logout: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10"/></svg>',
  login: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M9 8l4 4-4 4M4 12h9"/></svg>',
  lend: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/></svg>',
  truck: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
  barcode: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12M7 6v12M10 6v8M13 6v12M16 6v8M19 6v12M10 17h0M16 17h0"/></svg>',
  cloud: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5h10.5a4 4 0 0 0 .6-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 18.5z"/></svg>',
  trash: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/></svg>',
  grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l1.6 2.5H20a1.5 1.5 0 0 1 1.5 1.5v10.5A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 4 6.5h3.4zm3 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/></svg>',
  box: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M4.5 9v10a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V9M9.5 13h5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c5 0 8.7 4.2 10 7-1.3 2.8-5 7-10 7S3.3 14.8 2 12c1.3-2.8 5-7 10-7zm0 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13.7 2 .5 2.6 1.6.7 2.2-1.5 2.2 2.2-1.5 2.2.7 1.6 2.6.5v3.2l-2.6.5-.7 1.6 1.5 2.2-2.2 2.2-2.2-1.5-1.6.7-.5 2.6h-3.2l-.5-2.6-1.6-.7-2.2 1.5-2.2-2.2 1.5-2.2-.7-1.6L2 13.6v-3.2l2.6-.5.7-1.6-1.5-2.2 2.2-2.2 2.2 1.5 1.6-.7.5-2.7zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5a6.5 6.5 0 0 1 6.5 6.5v4.5l2 3.5h-17l2-3.5V9A6.5 6.5 0 0 1 12 2.5zM9.5 19h5a2.5 2.5 0 0 1-5 0z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.5 2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17.2l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>',
};
/* a whole, closed box – same style as the item icon, with the box number on its label */
const boxArt = num => `<svg class="boxart" viewBox="0 0 64 64" aria-hidden="true"><path d="M10 25h44v28.5a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3z" fill="#B5824A"/><rect x="7" y="16" width="50" height="11" rx="2.2" fill="#C99A62"/><rect x="10" y="27" width="44" height="2.6" fill="#8C5E2E"/><rect x="28.5" y="16" width="7" height="11" fill="#E6C894"/><rect x="16" y="34" width="32" height="15" rx="2" fill="#FFF7EA"/><text x="32" y="45.4" text-anchor="middle" font-family="Montserrat,Poppins,Arial,sans-serif" font-weight="800" font-size="${String(num).length > 3 ? 8.5 : 11}" fill="#5A3FB8">${esc(num)}</text></svg>`;
const boxNum = b => b.code.replace(/^B-/, '');

/* reminders: "haven't used this in a while" */
/* a reminder as a calendar event the phone's calendar can import */
function calendarFile(it, b){
  const d = notifyAt(it); if (!d) return;
  const ymd = d.replace(/-/g, ''), nxt = new Date(d); nxt.setDate(nxt.getDate() + 1);
  const icsEsc = v => String(v || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, ' ');
  const txt = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Storrrage//EN', 'BEGIN:VEVENT', 'UID:' + it.id + '-' + ymd + '@storrrage', 'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z',
    'DTSTART;VALUE=DATE:' + ymd, 'DTEND;VALUE=DATE:' + nxt.toISOString().slice(0, 10).replace(/-/g, ''), 'SUMMARY:' + icsEsc('Storrrage: ' + it.name), 'DESCRIPTION:' + icsEsc(whereText(it, b)),
    'BEGIN:VALARM', 'TRIGGER:PT9H', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(it.name), 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  deliver(`${(it.name || 'reminder').replace(/[^\wåäöÅÄÖ-]+/g, '_')}.ics`, new Blob([txt], {type: 'text/calendar'}), it.name);
}
function addMonths(dateStr, m){ const d = new Date(dateStr); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); }
function notifyAt(it){ if (it.remindAt) return it.remindAt; const m = +it.remindMonths || 0; if (!m) return ''; return addMonths(it.lastUsed || it.storedOn || today(), m); }
const isDue = it => { const n = notifyAt(it); return !!n && n <= today(); };
const dueItems = (filter = () => true) => boxes.filter(filter).flatMap(b => (b.items || []).filter(isDue).map(it => [it, b]));
const dueCount = filter => dueItems(filter).length;
const dot = on => on ? '<i class="dot" aria-hidden="true"></i>' : '';

/* navigation with the phone's back button */
/* Back always goes one step UP the hierarchy (item → box → box it's in → place → all places),
   no matter how you got there. The phone's back button does the same. */
function parentView(v){
  v = v || view;
  if (v.name === 'item' || v.name === 'batch'){ const b = findBox(v.boxId); if (!b) return {name: 'home', place: currentPlace}; return b.loose ? {name: 'home', place: b.placeId} : {name: 'box', boxId: b.id}; }
  if (v.name === 'box'){ const b = findBox(v.boxId); if (!b) return {name: 'home', place: currentPlace}; if (!b.loose && b.parentId && findBox(b.parentId)) return {name: 'box', boxId: b.parentId}; return {name: 'home', place: b.placeId}; }
  if (v.name === 'mapfocus') return v.back || {name: 'home', place: v.place};
  if (v.name === 'collection') return {name: 'search'};
  if (v.name === 'profile' && v.sub) return {name: 'profile'};
  if (v.name === 'search' || v.name === 'profile' || v.name === 'settings' || v.name === 'move' || v.name === 'loans') return {name: 'home', place: currentPlace};
  if (v.name === 'home' && places.length > 1 && (v.place || currentPlace) !== 'all') return {name: 'home', place: 'all'};
  return null;
}
let armed = false;
/* Back goes to where you came from (a history stack). If there is nothing to go back to, it goes one step up the hierarchy. */
let backStack = [];
const sameView = (a, b) => a && b && a.name === b.name && a.boxId === b.boxId && a.itemId === b.itemId && (a.place || '') === (b.place || '') && a.sub === b.sub && a.tag === b.tag;
function viewValid(v){
  if (!v) return false;
  if (v.name === 'box' || v.name === 'batch') return !!findBox(v.boxId);
  if (v.name === 'item'){ const b = findBox(v.boxId); return !!(b && (b.items || []).some(i => i.id === v.itemId)); }
  if (v.name === 'home' || v.name === 'mapfocus') return !v.place || v.place === 'all' || !!findPlace(v.place);
  return v.name !== 'welcome';
}
function pushBack(){ if (!view || view.name === 'welcome') return; const v = Object.assign({}, view); delete v.asked; backStack.push(v); if (backStack.length > 40) backStack.shift(); }
function prevView(){ for (let i = backStack.length - 1; i >= 0; i--) if (viewValid(backStack[i]) && !sameView(backStack[i], view)) return backStack[i]; return null; }
function goBack(){
  for (let i = backStack.length - 1; i >= 0; i--) if (viewValid(backStack[i]) && !sameView(backStack[i], view)){ go(backStack[i], {backIndex: i}); return true; }
  return goUp();
}
function arm(){ if (armed || !(prevView() || parentView() || (placeView === 'racks' && rkMode === 'tidy'))) return; try { history.pushState({guard: 1}, ''); armed = true; } catch {} }
async function go(v, options = {}){
  if (sameView(v, view)) return true;
  if (view.name === 'item' && !(await prepareItemLeave())){ arm(); return false; }
  if (options.pushBack) pushBack();
  if (options.backIndex !== undefined) backStack = backStack.slice(0, options.backIndex);
  if (options.navigation){
    if (v.name === 'box'){ const b = findBox(v.boxId); if (b && currentPlace !== b.placeId) setPlace(b.placeId); remember('box', v.boxId); touchOpened(b); if (view.name === 'search' && v.hl) v.fromSearch = true; }
    if (v.name === 'item' && v.itemId !== itemDraft) remember('item', v.itemId, v.boxId);
    if (v.name !== 'search') query = '';
  }
  leaveItemPage();
  if (typeof presenceSoon === 'function') presenceSoon();
  if (v.name !== view.name) track('view', {v: v.name});
  quickAddFor = null;
  if (selecting && !(v.name === view.name && v.boxId === view.boxId && v.tag === view.tag)) selecting = null;
  if ((v.name === 'home' || v.name === 'mapfocus') && v.place) setPlace(v.place);
  view = v;
  if (v.name === 'item' && itemDraft !== v.itemId){ const [it, b] = curItem(); itemEdit = it ? {boxId: v.boxId, itemId: v.itemId, original: clone(it), boxUpdatedAt: b.updatedAt, removedRefs: new Set()} : null; }
  if (v.name !== 'search') query = view.name === 'search' ? query : '';
  render(); window.scrollTo(0, 0); arm();
}
function goUp(){ const p = parentView(); if (!p) return false; go(p); return true; }
function navigate(v){
  go(v, {pushBack: !sameView(v, view), navigation: true});
}
window.addEventListener('popstate', () => {
  armed = false;
  const vw = document.getElementById('viewer');
  if (vw && vw.open){ vw.close(); arm(); return; }
  if (sheet.open){ closeSheet(); arm(); return; }
  if (view.name === 'home' && placeView === 'racks' && rkMode === 'tidy'){ rkMode = 'shelves'; render(); arm(); return; }
  if (goBack()) arm();
});
function goHome(pid){ navigate({name: 'home', place: pid || 'all'}); }
function openSpace(){ goHome(currentPlace !== 'all' ? currentPlace : null); }
function openBox(id){
  const b = findBox(id); if (!b) return;
  navigate({name: 'box', boxId: id});
}
function showSearch(q){ query = q || ''; if (view.name !== 'search') navigate({name: 'search'}); else render(); const s = $('#q'); if (s && s.value !== query) s.value = query; }

const possessive = () => {
  if (!me) return lang === 'sv' ? 'MIN' : 'MY';
  const n = me.toUpperCase();
  return lang === 'sv' ? (/[SXZ]$/.test(n) ? n : n + 'S') : (n.endsWith('S') ? n + '’' : n + '’S');
};
function crumbs(parts, sub){
  const short = l => { l = String(l); return l.length > 26 ? l.slice(0, 24).trimEnd() + '…' : l; };
  return `<nav class="crumbs" aria-label="${esc(tr('whereYouAre'))}">${parts.map(p => p.nav ? `<button data-nav='${esc(JSON.stringify(p.nav))}' title="${esc(p.label)}">${esc(short(p.label))}</button>` : `<span title="${esc(p.label)}">${esc(short(p.label))}</span>`).join('<span class="sep"> - </span>')}</nav>${sub ? `<p class="tagline">${sub}</p>` : ''}`;
}
const crumbSpace = () => ({label: possessive(), nav: {name: 'home', place: 'all'}});
const crumbPlace = pid => ({label: placeName(pid).toUpperCase(), nav: {name: 'home', place: pid}});
const boxLabel = b => tr('box_n', parseInt(b.code.slice(2)));
const counts = (...a) => a.filter(Boolean).join(' - ');

function render(){
  if (!ready){ app.innerHTML = '<p class="status">…</p>'; return; }
  document.documentElement.lang = lang;
  document.body.classList.toggle('onboarding', view.name === 'welcome');
  document.body.classList.toggle('itemview', view.name === 'item' || view.name === 'batch');
  if (view.name === 'welcome') return renderWelcome();
  if ((view.name === 'box' || view.name === 'batch') && !findBox(view.boxId)) view = {name: 'home'};
  if (view.name === 'item' && !(findBox(view.boxId) && (findBox(view.boxId).items || []).some(i => i.id === view.itemId))) view = {name: 'home'};
  if (view.name === 'box') renderBox(findBox(view.boxId));
  else if (view.name === 'item') renderItem();
  else if (view.name === 'batch') renderBatch();
  else if (view.name === 'search') renderSearch();
  else if (view.name === 'collection') renderCollection(view.tag);
  else if (view.name === 'mapfocus') renderPlace(view.place, true);
  else if (view.name === 'profile') renderProfile();
  else if (view.name === 'settings') renderSettings();
  else if (view.name === 'move') renderMove();
  else if (view.name === 'loans') renderLoans();
  else if (currentPlace !== 'all' && findPlace(currentPlace)) renderPlace(currentPlace);
  else renderSpace();
  const tab = view.name === 'search' ? 'search' : ['profile', 'settings', 'move', 'loans'].includes(view.name) ? '' : 'home';
  if (!['box', 'search', 'collection'].includes(view.name)) document.body.classList.remove('selecting');
  document.querySelectorAll('.tabbar [data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === tab); const l = b.querySelector('.tl'); if (l) l.textContent = tr('tab_' + b.dataset.tab); });
  { const at = document.querySelector('.tabbar .addtab'); if (at) at.classList.toggle('nudge', ready && view.name !== 'welcome' && !boxes.some(b => (b.items || []).length) && !realBoxes().some(b => !b.kit)); }
  document.body.dataset.view = view.name;
  { const f = $('#talkBtn'); if (f && !f.dataset.pill){ f.dataset.pill = 1; f.classList.add('pill'); f.insertAdjacentHTML('beforeend', `<span class="fabtxt"></span>`); } const ft = f && f.querySelector('.fabtxt'); if (ft) ft.textContent = tr('askAI'); }
  const pdot = $('#menuDot'); if (pdot) pdot.hidden = !dueCount() && !outItems().some(([it]) => outOverdue(it)) && !realBoxes().some(boxOutLate) && !nudges().length && !attention();
  topbarUpdate();
  hydrate(app); hydrateNotes(app);
}
STR.en.tab_home = 'Home'; STR.en.tab_search = 'Search'; STR.en.tab_profile = 'Profile'; STR.en.tab_add = 'Add'; STR.sv.tab_add = 'Lägg till';
STR.sv.tab_home = 'Hem'; STR.sv.tab_search = 'Sök'; STR.sv.tab_profile = 'Profil';

/* tiles */
const addTile = (act, label, extra = '') => `<button class="tile add" data-act="${act}" ${extra} aria-label="${esc(label)}"><span class="add-sign">+</span><span class="add-label">${esc(tr('addNav'))}</span></button>`;
function boxTile(b){ return shelfTile(b); }
function itemTile(it, b, caption){
  const p = (it.photos || [])[0];
  const sel = selecting && selecting.has('i:' + b.id + ':' + it.id);
  const hl = view.name === 'box' && view.hl === it.id;
  return `<button class="itile${sel ? ' sel' : ''}${hl ? ' hl' : ''}${isOut(it) ? ' out' : ''}" data-item="${esc(it.id)}" data-box="${esc(b.id)}" data-lp="item:${esc(b.id)}:${esc(it.id)}">
    <span class="timg">${p ? imgTag(p.ref, '') : ''}<span class="ticon${p ? ' fb' : ''}">${guessIcon(it)}</span>${it.isNew ? `<span class="newrib">${tr('newTag')}</span>` : ''}${dot(isDue(it))}${it.fav ? '<span class="favstar">★</span>' : ''}${selecting ? `<span class="selbox">${sel ? '✓' : ''}</span>` : ''}</span>
    <span class="ttext"><span class="tname">${esc(it.name || tr('unnamed'))}</span>${caption ? `<span class="tcap">${caption}</span>` : ''}</span></button>`;
}
const whereCaption = b => b.loose ? `${esc(placeName(b.placeId))}` : `${ICON.box}${esc(b.code)} · ${esc(placeName(b.placeId))}`;
const PLACE_ICONS = ['🚪','🔒','🏠','🏡','🏚️','🚗','🛖','🗄️','🏢','⛵','🧳','🪜','🔑','🏗️'];
function placeIcon(p){
  if (p.icon) return p.icon;
  const n = p.name.toLowerCase();
  if (/garage|garag/.test(n)) return '🚗'; if (/vind|attic|loft/.test(n)) return '🏠'; if (/sommar|summer|stuga|cottage|landet/.test(n)) return '🏡';
  if (/garderob|wardrobe|closet|klädkammare/.test(n)) return '🗄️'; if (/bod|shed/.test(n)) return '🛖'; if (/förråd|storage|unit/.test(n)) return '🔒';
  if (/båt|boat/.test(n)) return '⛵'; if (/kontor|office/.test(n)) return '🏢'; return '🚪';
}
let viewMode = 'grid';
const viewCls = () => viewMode === 'grid' ? '' : ' ' + viewMode;
let shelfMode = 'grid';
const shelfCls = () => '';
function viewToggle(kind){
  const cur = kind === 'shelf' ? shelfMode : viewMode, attr = kind === 'shelf' ? 'data-shelfmode' : 'data-viewmode';
  const b = (m, ic, l) => `<button class="${cur === m ? 'on' : ''}" ${attr}="${m}" aria-label="${esc(l)}" title="${esc(l)}">${ic}</button>`;
  return `<div class="vtoggle">${b('grid', '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>', tr('viewLarge'))}${b('small', '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="9.5" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="3" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><rect x="16" y="9.5" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><rect x="9.5" y="16" width="5" height="5" rx="1"/><rect x="16" y="16" width="5" height="5" rx="1"/></svg>', tr('viewSmall'))}${b('list', '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="3" rx="1"/><rect x="3" y="10.5" width="18" height="3" rx="1"/><rect x="3" y="17" width="18" height="3" rx="1"/></svg>', tr('viewList'))}</div>`;
}
function placeContent(pid, heading){
  const bx = topBoxesIn(pid).sort(byCode), loose = looseOf(pid), li = loose ? [...(loose.items || [])].sort(byName) : [];
  const p = findPlace(pid);
  return `${heading ? `<h2 class="placehead"><button data-goplace="${esc(pid)}"><span class="picon">${placeIcon(p)}</span>${esc(placeName(pid))}</button></h2>` : ''}
    <div class="grid${viewCls()}">${bx.map(boxTile).join('')}${addTile('addhere', tr('addNav'), `data-pid="${esc(pid)}"`)}</div>
    ${li.length ? `<h2 class="section">${tr('notInBox')}</h2><div class="igrid${viewCls()}">${li.map(it => itemTile(it, loose, it.spot ? esc(it.spot) : '')).join('')}</div>` : ''}
    ${!bx.length && !li.length && !heading ? `<p class="hint center">${tr('emptyPlace')}</p>` : ''}`;
}
let recents = [], favoriteOrder = [];
function remember(kind, id, boxId){
  recents = [{k: kind, id, boxId}].concat(recents.filter(r => !(r.k === kind && r.id === id))).slice(0, 12);
  metaPut('recent', recents).catch(() => {});
}
function topStrips(pid){
  const f = favEntries(pid), r = recentEntries(pid);
  const row = (title, list, favorites = false) => list.length ? `<div class="mini"><span class="minih">${title}</span><div class="strip mini${favorites ? ' favorites' : ''}"${favorites ? ' data-fav-strip' : ''}>${list.map(([kind, x, b]) => {
    const key = kind === 'box' ? `b:${x.id}` : `i:${b.id}:${x.id}`;
    const tile = kind === 'box' ? shelfTile(x) : itemTile(x, b);
    return favorites ? tile.replace('<button ', `<button data-fav-order="${esc(key)}" `).replace(/ data-lp="[^"]*"/, '') : tile;
  }).join('')}</div></div>` : '';
  return row('★ ' + tr('favorites'), f, true) + row(tr('recent'), r);
}
function stripRow(title, entries){
  if (!entries.length) return '';
  return `<h2 class="section">${esc(title)}</h2><div class="strip">${entries.map(([kind, x, b]) => kind === 'box' ? shelfTile(x) : itemTile(x, b, b.loose ? esc(placeName(b.placeId)) : esc(b.code))).join('')}</div>`;
}
function recentEntries(pid){
  return recents.map(r => {
    if (r.k === 'box'){ const b = findBox(r.id); return b && !b.loose && (!pid || b.placeId === pid) ? ['box', b] : null; }
    const b = findBox(r.boxId), it = b && (b.items || []).find(i => i.id === r.id); return it && (!pid || b.placeId === pid) ? ['item', it, b] : null;
  }).filter(Boolean).slice(0, 8);
}
function favEntries(pid){
  const out = [];
  boxes.forEach(b => { if (pid && b.placeId !== pid) return; if (!b.loose && b.fav) out.push(['box', b]); (b.items || []).forEach(it => { if (it.fav) out.push(['item', it, b]); }); });
  const order = new Map(favoriteOrder.map((key, i) => [key, i]));
  const key = entry => entry[0] === 'box' ? `b:${entry[1].id}` : `i:${entry[2].id}:${entry[1].id}`;
  return out.sort((a, b) => (order.get(key(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(key(b)) ?? Number.MAX_SAFE_INTEGER));
}
let placeView = 'shelf';
function topbarUpdate(){
  const sw = $('#spaceBtn'), bk = $('#backBtn'), lg = $('#logoBtn'); if (!sw) return;
  const pid = view.name === 'box' || view.name === 'item' || view.name === 'batch' ? (findBox(view.boxId) || {}).placeId : (places.length === 1 ? places[0].id : currentPlace);
  const p = pid && pid !== 'all' ? findPlace(pid) : null;
  sw.innerHTML = p ? `<span class="picon">${placeIcon(p)}</span><span class="sname">${esc(p.name)}</span><span class="caret">▾</span>` : `<span class="sname">${tr('allPlaces')}</span><span class="caret">▾</span>`;
  const up = prevView() || parentView();
  bk.hidden = !up; lg.hidden = false;
  bk.setAttribute('aria-label', tr('back'));
}
function spaceSheet(){
  const cnt = pid => { const bx = boxes.filter(b => b.placeId === pid); return [bx.filter(b => !b.loose).length, bx.reduce((s, b) => s + (b.items || []).length, 0)]; };
  openSheet(`<h3>${tr('switchSpace')}</h3><div class="spaces">
    ${places.length > 1 ? `<button class="spacerow${currentPlace === 'all' ? ' on' : ''}" data-sp="all"><span class="picon big">🗺️</span><span><b>${tr('allPlaces')}</b><small>${tr('boxes_n', realBoxes().length).toLowerCase()} · ${tr('items_n', boxes.reduce((s, b) => s + (b.items || []).length, 0)).toLowerCase()}</small></span></button>` : ''}
    ${places.map(p => { const [nb, ni] = cnt(p.id); return `<button class="spacerow${currentPlace === p.id || places.length === 1 ? ' on' : ''}" data-sp="${esc(p.id)}"><span class="picon big">${placeIcon(p)}</span><span><b>${esc(p.name)}</b><small>${tr('boxes_n', nb).toLowerCase()} · ${tr('items_n', ni).toLowerCase()}</small></span>${dot(dueCount(b => b.placeId === p.id))}</button>`; }).join('')}
    <button class="spacerow add" data-sp="new"><span class="picon big">＋</span><span><b>${tr('newPlace')}</b></span></button></div>`);
  sheet.querySelector('.spaces').onclick = e => {
    const t = e.target.closest('[data-sp]'); if (!t) return;
    if (t.dataset.sp === 'new') return askText(tr('newPlace'), {placeholder: tr('newPlaceHint'), ok: tr('add')}).then(n => { const p = n && addPlace(n); if (p) goHome(p.id); });
    closeSheet(); goHome(t.dataset.sp === 'all' ? null : t.dataset.sp);
  };
  let lpT; sheet.querySelector('.spaces').addEventListener('pointerdown', e => { const t = e.target.closest('[data-sp]'); if (!t || ['all', 'new'].includes(t.dataset.sp)) return; lpT = setTimeout(() => lpMenu('place:' + t.dataset.sp), 550); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => sheet.querySelector('.spaces').addEventListener(ev, () => clearTimeout(lpT)));
}
function shelfTile(b){
  const n = (b.items || []).length + childBoxes(b.id).length;
  const sel = selecting && selecting.has('b:' + b.id);
  return `<button class="itile btile${b.fav ? ' fav' : ''}${sel ? ' sel' : ''}${b.out ? ' out' : ''}" data-open="${esc(b.id)}" data-lp="box:${esc(b.id)}">
    <span class="timg">${boxArt(boxNum(b))}${b.isNew ? `<span class="newrib">${tr('newTag')}</span>` : ''}<span class="bcount">${n}</span>${presenceBadge(b.id)}${tileFresh(b)}${b.fav ? '<span class="favstar">★</span>' : ''}${b.out ? `<span class="boxouttag">↗</span>` : ''}${dot(dueCount(x => x.id === b.id || x.parentId === b.id))}</span>
    <span class="ttext"><span class="tname">${esc(b.name || boxLabel(b))}</span></span></button>`;
}
/* the freshness dot only shows when a box is about to stop being "fresh" (not checked for ~5 months) */
const PLUS_SVG = '<svg class="plusic" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></svg>';
const tileFresh = b => { const d = freshDays(b); return d !== Infinity && d > 150 ? freshDot(b) : ''; };
function shelfTileOld(b){
  const n = (b.items || []).length + childBoxes(b.id).length;
  const sel = selecting && selecting.has('b:' + b.id);
  const where = [b.location, b.stack ? `${tr('stack')} ${b.stack}` : '', b.level > 1 ? `${tr('level')} ${b.level}` : ''].filter(Boolean).join(' · ');
  return `<button class="stile${b.fav ? ' fav' : ''}${sel ? ' sel' : ''}${b.out ? ' out' : ''}" data-open="${esc(b.id)}" data-lp="box:${esc(b.id)}">${freshDot(b)}${b.out ? `<span class="boxouttag"><span class="oarrow">↗</span><span class="otext"> ${tr('outTag')}</span></span>` : ''}<span class="scode"><span class="sico">${ICON.box}</span>${esc(b.code.replace('B-', ''))}</span><span class="sname">${esc(b.name)}</span>${where ? `<span class="swhere">${esc(where)}</span>` : ''}<span class="scount">${n}</span>${dot(dueCount(x => x.id === b.id || x.parentId === b.id))}</button>`;
}
function looseItems(pid){ const l = looseOf(pid); return l ? [...(l.items || [])].sort(byName) : []; }
function tokenHTML(it, l, opts = {}){
  const p = (it.photos || [])[0];
  return `<button class="ltoken${opts.big ? ' big' : ''}" data-tid="${esc(it.id)}" data-item="${esc(it.id)}" data-box="${esc(l.id)}" ${opts.lp === false ? '' : `data-lp="item:${esc(l.id)}:${esc(it.id)}"`}>
    <span class="lcirc">${p ? imgTag(p.ref, '') : ''}<span class="ticon${p ? ' fb' : ''}">${guessIcon(it)}</span>${dot(isDue(it))}</span><span class="lname">${esc(it.name)}</span>${opts.cap ? `<span class="lcap">${esc(opts.cap)}</span>` : ''}</button>`;
}
/* "not in a box": its own row of round markers you can scroll through */
function looseCarousel(pid, opts = {}){
  const l = looseOf(pid), li = looseItems(pid).filter(opts.filter || (() => true));
  if (!li.length && !opts.always) return '';
  return `<section class="lcarousel" data-unplace="${opts.dropTarget ? '1' : ''}"><div class="lhead"><b>${tr('notInBox')}</b>${l && li.length >= 6 ? `${li.some(i => i.isNew) ? `<span class="newrib inline">${tr('newTag')}</span>` : ''}<button class="linkbtn" data-open="${esc(l.id)}">${tr('showAll')} ›</button>` : ''}<span class="zcount">${tr('items_n', li.length).toLowerCase()}</span></div>
    ${opts.hint ? `<p class="maphint">${opts.hint}</p>` : ''}
    <div class="lstrip">${li.map(it => itemTile(it, l, opts.showZone && it.zone ? esc(it.zone) : '')).join('')}
      <button class="itile add" data-act="addloose" data-pid="${esc(pid)}"><span class="timg">${PLUS_SVG}</span><span class="ttext"><span class="tname">${tr('newThing')}</span></span></button></div></section>`;
}
function shelfHTML(pid, folded = false){
  const bx = topBoxesIn(pid).sort(byCode), visibleBoxes = folded ? bx.slice(0, 8) : bx;
  return `<div class="shelf">${visibleBoxes.map(shelfTile).join('')}${folded ? '' : `<button class="itile add" data-act="newboxin" data-pid="${esc(pid)}" aria-label="${esc(tr('addNav'))}"><span class="timg">${PLUS_SVG}</span><span class="ttext"><span class="tname">${tr('addNav')}</span></span></button>`}</div>
    ${folded ? '' : looseCarousel(pid, {showZone: true})}`;
}
function placeHead(pid){
  const nB = boxesIn(pid).length, nI = boxes.filter(b => b.placeId === pid).reduce((s, b) => s + (b.items || []).length, 0);
  return `<div class="phead"><div><p class="tagline">${counts(tr('boxes_n', nB), tr('items_n', nI))}${esc(valueLine(b => b.placeId === pid).toUpperCase())}</p></div>
    <div class="seg small"><button class="${placeView === 'shelf' ? 'on' : ''}" data-pview="shelf">${tr('shelf')}</button><button class="${placeView === 'list' ? 'on' : ''}" data-pview="list">${tr('list')}</button><button class="${placeView === 'map' ? 'on' : ''}" data-pview="map">${tr('map')}</button><button class="rktab${placeView === 'racks' ? ' on' : ''}" data-pview="racks">${tr('rk_view')}<sup>test</sup></button></div></div>`;
}
function renderSpace(){
  const nB = realBoxes().length, nI = boxes.reduce((s, b) => s + (b.items || []).length, 0);
  app.innerHTML = `<div class="phead"><p class="tagline">${counts(tr('places_n', places.length), tr('boxes_n', nB), tr('items_n', nI))}${esc(valueLine(() => true).toUpperCase())}</p></div>
    ${installBanner()}${moveBanner()}${topStrips()}
    ${places.map(p => { const pb = boxesIn(p.id).length, pi = boxes.filter(b => b.placeId === p.id).reduce((s, b) => s + (b.items || []).length, 0);
      const boxCount = topBoxesIn(p.id).length, canFold = boxCount > 8, isFolded = canFold && foldedPlaces.has(p.id);
      return `<section class="spacesec card${isFolded ? ' space-folded' : ''}" data-place-card="${esc(p.id)}">${isFolded ? '' : nudgeBar(p.id)}<div class="spacehead-row">
        <button class="space-icon" data-goplace="${esc(p.id)}" aria-label="${esc(p.name)}">${placeIcon(p)}</button>
        <button class="spacehead" data-goplace="${esc(p.id)}"><span class="spacehead-info"><b>${esc(p.name)}</b><small>${tr('boxes_n', pb).toLowerCase()} · ${tr('items_n', pi).toLowerCase()}</small></span></button>
        ${canFold ? `<button class="space-fold-btn" data-space-fold="${esc(p.id)}" aria-expanded="${!isFolded}" aria-label="${esc(tr(isFolded ? 'unfoldSpace' : 'foldSpace', p.name))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${isFolded ? 'm6 9 6 6 6-6' : 'm6 15 6-6 6 6'}"/></svg></button>` : ''}
        <button class="space-edit-btn" data-place-edit="${esc(p.id)}" aria-label="${esc(tr('editPlace', p.name))}">⋯</button>
      </div>${shelfHTML(p.id, isFolded)}${isFolded && boxCount > 8 ? `<button class="fold-more" data-space-fold="${esc(p.id)}">${esc(tr('moreBoxes', boxCount - 8))}</button>` : ''}</section>`; }).join('')}
    ${notesHTML(notes.filter(n => !n.boxId || !findBox(n.boxId)), tr('voiceNotes'))}
    ${backupBanner()}`;
}
let placePress = null, placeDrag = null, suppressPlaceClick = false;
app.addEventListener('pointerdown', e => {
  const row = e.target.closest('.spacehead-row'), card = row && row.closest('[data-place-card]');
  if (!row || e.target.closest('[data-place-edit], [data-space-fold]') || !card || places.length < 2 || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.stopImmediatePropagation();
  const press = placePress = {row, card, x: e.clientX, y: e.clientY, pointerId: e.pointerId};
  press.timer = setTimeout(() => {
    if (placePress !== press || !row.isConnected) return;
    const r = row.getBoundingClientRect(), ghost = row.cloneNode(true);
    ghost.classList.add('place-drag-ghost');
    Object.assign(ghost.style, {left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'});
    document.body.appendChild(ghost);
    document.body.classList.add('reordering-places');
    card.classList.add('place-dragging');
    placeDrag = {card, ghost, row, pointerId: press.pointerId, dy: press.y - r.top};
    placePress = null;
    row.setPointerCapture(press.pointerId);
    if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
  }, 300);
});
document.addEventListener('pointermove', e => {
  if (placePress && !placeDrag){
    if (e.pointerId !== placePress.pointerId) return;
    if (Math.hypot(e.clientX - placePress.x, e.clientY - placePress.y) > 12){
      clearTimeout(placePress.timer); placePress = null;
    }
    return;
  }
  const d = placeDrag; if (!d || e.pointerId !== d.pointerId) return;
  e.preventDefault();
  d.ghost.style.top = `${e.clientY - d.dy}px`;
  d.ghost.style.visibility = 'hidden';
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-place-card]');
  d.ghost.style.visibility = '';
  if (!target || target === d.card) return;
  const r = target.getBoundingClientRect();
  const before = e.clientY < r.top + r.height / 2;
  if ((before && d.card.nextElementSibling === target) || (!before && d.card.previousElementSibling === target)) return;
  app.insertBefore(d.card, before ? target : target.nextSibling);
}, {passive: false});
document.addEventListener('pointerup', async e => {
  if (placePress && e.pointerId === placePress.pointerId){ clearTimeout(placePress.timer); placePress = null; return; }
  const d = placeDrag; if (!d || e.pointerId !== d.pointerId) return;
  placeDrag = null; d.ghost.remove(); d.card.classList.remove('place-dragging'); document.body.classList.remove('reordering-places');
  lpFired = true;
  setTimeout(() => { lpFired = false; }, 0);
  suppressPlaceClick = true;
  setTimeout(() => { suppressPlaceClick = false; }, 600);
  const ordered = [...app.querySelectorAll('[data-place-card]')].map(el => findPlace(el.dataset.placeCard)).filter(Boolean);
  if (ordered.length === places.length && ordered.some((p, i) => p.id !== places[i].id)){
    places = ordered;
    render();
    await metaPut('places', places).catch(err => toast(saveErr(err)));
  }
  requestAnimationFrame(() => {
    const card = [...app.querySelectorAll('[data-place-card]')].find(el => el.dataset.placeCard === d.card.dataset.placeCard);
    if (card) card.scrollIntoView({behavior: 'smooth', block: 'center'});
  });
});
document.addEventListener('pointercancel', e => {
  if (placePress && e.pointerId === placePress.pointerId){ clearTimeout(placePress.timer); placePress = null; }
  const d = placeDrag; if (!d || e.pointerId !== d.pointerId) return;
  placeDrag = null; d.ghost.remove(); document.body.classList.remove('reordering-places');
  render();
});
function nudgeBar(pid){ const n = nudges(pid)[0]; return n ? nudgeCard(n, true) : ''; }
function renderPlace(pid, focus){
  if (!focus && placeView === 'racks') rkPlacePending(pid);
  const what = focus ? [...(view.hlBoxes || []).map(findBox).filter(Boolean).map(b => (view.hlBoxes.length === 1 ? `${b.code} ${b.name}` : b.code)), ...looseItems(pid).filter(i => (view.hlItems || []).includes(i.id)).map(i => i.name)] : [];
  app.innerHTML = `${focus ? `<div class="findhint"><span>${ICON.pin} <b>${esc(what.join(', '))}</b></span></div>` : placeHead(pid)}
    ${focus ? '' : installBanner() + moveBanner()}
    ${focus || placeView === 'map' || placeView === 'racks' ? '' : topStrips(pid)}
    ${focus ? '' : nudgeBar(pid)}
    ${focus || placeView === 'map' ? mapHTML(pid) : placeView === 'racks' ? racksHTML(pid) : placeView === 'list' ? listHTML(pid) : shelfHTML(pid)}
    ${focus ? '' : (([c, n]) => n ? `<p class="freshsum">${freshDot({checkedAt: c === n ? today() : null, updatedAt: null})} ${esc(tr('checkedYear', c, n))}</p>` : '')(checkedThisYear(pid))}
    ${notesHTML(notes.filter(n => !n.boxId || !findBox(n.boxId)), tr('voiceNotes'))}
    ${backupBanner()}`;
  if (focus) scrollToHighlight();
}
let selecting = null;
function renderBox(b){
  if (b.isNew) setTimeout(() => { const nb = clone(findBox(b.id)); if (nb && nb.isNew){ delete nb.isNew; putBox(nb, true); } }, 1500);
  const items = [...(b.items || [])].sort(byName), kids = b.loose ? [] : childBoxes(b.id).sort(byCode);
  const chain = b.loose ? [] : boxChain(b);
  const path = [placeName(b.placeId), ...chain.map(x => x.code)].join(' › ');
  const where = [b.location, b.stack ? `${tr('stack')} ${b.stack}` : '', b.level ? `${tr('level')} ${b.level}` : ''].filter(Boolean).join(' · ');
  const hlIt = view.hl && items.find(i => i.id === view.hl);
  const nOut = items.filter(isOut).length;
  const askOut = hlIt && view.fromSearch && !view.asked && !isOut(hlIt);
  const needCheck = !b.loose && items.length && daysSince(b.checkedAt || b.createdAt) > 60 && view.checkReady && !view.checkDismissed;
  if (!b.loose && items.length && !view.checkReady && daysSince(b.checkedAt || b.createdAt) > 60){ clearTimeout(window._ckT); const vid = b.id; window._ckT = setTimeout(() => { if (view.name === 'box' && view.boxId === vid){ view.checkReady = true; render(); } }, 25000); }
  app.innerHTML = `${b.out ? `<div class="findhint outhint"><span>↗ <b>${tr('boxIsOut')}</b> · ${esc(tr('outSince', b.out.since))}${b.out.until ? ' · ' + esc(tr('backBy', b.out.until)) : ''}</span><button class="btn primary small" data-act="boxback">↩ ${tr('putBackBox')}</button></div>` : ''}
    ${askOut ? `<div class="askout"><span>${esc(tr('askOut', hlIt.name))}</span><span class="fhbtns"><button class="btn primary small" data-askout="temp">${tr('yesTemp')}</button><button class="btn quiet small" data-askout="gone">${tr('yesGone')}</button><button class="btn quiet small" data-askout="no">${tr('no')}</button></span></div>` : ''}
    ${hlIt ? `<div class="findhint"><span>🔎 <b>${esc(hlIt.name)}</b> ${tr('isHere')}</span><span class="fhbtns"><button class="btn primary small" data-item="${esc(hlIt.id)}" data-box="${esc(b.id)}" data-open-item="1">${tr('openItem')}</button><button class="btn quiet small" data-mapbox="${esc(b.id)}" data-mapitem="${esc(b.loose ? hlIt.id : '')}" aria-label="${esc(tr('showOnMap'))}">${ICON.pin}</button></span></div>` : ''}
    ${presenceNote(b.id)}
    <div class="bhead">
      ${b.loose ? `<h1 class="btitle"><span class="bname">${tr('notInBox')}</span></h1>` : `<h1 class="btitle"><span class="bcode">${esc(b.code)}</span><span class="bname">${esc(b.name)}</span></h1>`}
      <p class="bpath"><button data-goplace="${esc(b.placeId)}">${esc(path)}</button>${where ? ` · ${esc(where)}` : ''} · ${tr('items_n', items.length).toLowerCase()}${nOut ? ` · <b class="outsum">↗ ${esc(tr('outOfN', nOut, items.length))}</b>` : ''}</p>
      ${b.status ? `<p class="bstatus">${esc(showStatus(b.status))}</p>` : ''}
      ${b.loose ? '' : `<p class="bfresh">${freshDot(b)} ${esc(freshText(b))}</p>`}
    </div>
    ${needCheck ? `<div class="checkbar"><span>${tr('checkQ')}</span><span class="fhbtns"><button class="btn primary small" data-act="checkyes">${tr('checkYes')}</button><button class="btn quiet small" data-act="checkno">${tr('checkNo')}</button></span></div>` : ''}
    ${b.loose ? `<div class="boxbar">${items.length ? `<button class="btn quiet small" data-act="selectmode">${tr('select')}</button>` : ''}${viewToggle()}</div>` : `<div class="boxbar">
      <button class="qr" data-act="label" aria-label="${esc(tr('label'))} ${esc(b.code)}">${qrSvg(labelText(b), 2)}</button>
      <button class="btn quiet small" data-act="editbox">${tr('editBox')}</button>
      <button class="btn quiet small" data-act="placement">${tr('placement')}</button>
      <button class="btn quiet small iconly" data-mapbox="${esc(b.id)}" aria-label="${esc(tr('showOnMap'))}">${ICON.pin}</button>
      <button class="btn quiet small" data-act="favbox" aria-pressed="${b.fav ? 'true' : 'false'}">${b.fav ? '★' : '☆'}</button>
      ${b.out ? '' : `<button class="btn quiet small" data-act="boxout" aria-label="${esc(tr('takeOutBox'))}">↗</button>`}
      ${items.length ? `<button class="btn quiet small" data-act="selectmode">${tr('select')}</button>` : ''}
      ${viewToggle()}
    </div>`}
    ${kids.length ? `<div class="kids${shelfCls()}">${kids.map(shelfTile).join('')}</div>` : ''}
    ${viewMode === 'list' ? rowsHTML(items.map(it => [it, b])) + `<p class="swipehint">${tr('swipeHint')}</p>` : ''}
    ${viewMode === 'list' ? '' : `<div class="igrid${viewCls()}">${items.map(it => itemTile(it, b)).join('')}${items.length || selecting ? '' : `<button class="itile add" data-act="addinbox"><span class="timg">${PLUS_SVG}</span><span class="ttext"><span class="tname">${tr('addNav')}</span></span></button>`}</div>`}
    ${(items.length || viewMode === 'list') && !selecting ? `<div class="addrow"><button class="btn quiet small" data-act="addinbox">${PLUS_SVG} ${tr('addNav')}</button></div>` : ''}
    ${boxDocumentsHTML(b)}
    ${notesHTML(notes.filter(n => n.boxId === b.id), tr('voiceNotesBox'))}
    ${selBar(['tag', 'move', 'del'])}`;
  document.body.classList.toggle('selecting', !!selecting);
  if (hlIt) scrollToHighlight();
}
app.addEventListener('click', async e => {
  const open = e.target.closest('[data-doc-open]');
  if (open){
    const b = findBox(open.dataset.docBox), doc = b && (b.documents || []).find(d => d.id === open.dataset.docOpen);
    if (doc) await openFile(doc);
    return;
  }
  const remove = e.target.closest('[data-doc-remove]');
  if (!remove) return;
  const b = findBox(remove.dataset.docBox), doc = b && (b.documents || []).find(d => d.id === remove.dataset.docRemove);
  if (!doc || !(await askConfirm(tr('rmQ', doc.name), tr('remove')))) return;
  const updated = clone(b);
  updated.documents = (updated.documents || []).filter(d => d.id !== doc.id);
  putBox(updated, true); dropPhoto(doc.ref); render();
});
app.addEventListener('change', async e => {
  const link = e.target.closest('[data-doc-link]');
  if (link){
    const b = findBox(view.boxId), doc = b && (b.documents || []).find(d => d.id === link.dataset.docLink);
    if (!doc) return;
    const updated = clone(b), target = updated.documents.find(d => d.id === doc.id);
    if (link.value) target.itemId = link.value; else delete target.itemId;
    putBox(updated);
    return;
  }
  const input = e.target.closest('[data-doc-file]');
  if (!input) return;
  const files = [...input.files]; input.value = ''; input.value = '';
  if (!files.length) return;
  toast(tr('savingDocument'));
  const boxId = input.dataset.docBox;
  for (const file of files){
    try {
      const {ref, type} = await storeUpload(file);
      const b = findBox(boxId);
      if (!b){ dropPhoto(ref); continue; }
      const updated = clone(b);
      updated.documents = (updated.documents || []).concat({id: newId(), ref, name: file.name.replace(/\.[^.]+$/, '') || tr('document'), type, addedAt: new Date().toISOString()});
      putBox(updated, true);
    } catch (err){ toast(saveErr(err)); }
  }
  render();
});
/* placement: which zone, which stack, on top or at the bottom */

/* ---------- the map: boxes AND loose things, in zones and stacks ---------- */
function mapEntities(pid){
  const out = topBoxesIn(pid).map(b => ({k: 'b:' + b.id, kind: 'box', b, zone: (b.location || '').trim(), stack: +b.stack || 0, level: +b.level || 0, sort: b.code}));
  const l = looseOf(pid);
  (l ? (l.items || []) : []).forEach(it => out.push({k: 'i:' + it.id, kind: 'item', it, l, zone: (it.zone || '').trim(), stack: +it.stack || 0, level: +it.level || 0, sort: '~' + (it.name || '')}));
  return out;
}
function zonesOf(pid){
  const p = findPlace(pid), used = new Set(mapEntities(pid).map(e => e.zone));
  const mine = (p.zones || []).filter(Boolean);
  const rank = z => /dörr|door|entr|ingång|främre|front|närmast/i.test(z) ? 0 : /längst in|far|back|bakre|inre|innerst/i.test(z) ? 2 : 1;
  const rest = [...used].filter(z => z && !mine.includes(z)).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y, 'sv'));
  const order = [...rest.filter(z => rank(z) === 0), ...mine, ...rest.filter(z => rank(z) === 1), ...rest.filter(z => rank(z) === 2)];
  order.push('');
  return order;
}
function stacksIn(pid, zone){
  const ents = mapEntities(pid).filter(e => e.zone === zone), st = {}; let auto = 100000;
  ents.sort((x, y) => x.sort.localeCompare(y.sort, 'sv')).forEach(e => { const s = e.stack > 0 ? e.stack : auto++; (st[s] = st[s] || []).push(e); });
  return Object.keys(st).map(Number).sort((x, y) => x - y).map(k => ({key: k < 100000 ? k : null, ents: st[k].sort((x, y) => x.level - y.level || x.sort.localeCompare(y.sort, 'sv')), boxes: st[k].filter(e => e.kind === 'box').map(e => e.b)}));
}
function crate(b, ci){
  const n = (b.items || []).length + childBoxes(b.id).length;
  const hl = view.name === 'mapfocus' && (view.hlBoxes || []).includes(b.id);
  return `<button class="crate${b.fav ? ' fav' : ''}${hl ? ' hl' : ''}${b.out ? ' out' : ''}" data-open="${esc(b.id)}" data-ek="b:${esc(b.id)}" data-ci="${ci}"><span class="ccode"><span class="sico">${ICON.box}</span>${esc(b.code.replace('B-', ''))}</span><span class="cname">${esc(b.name)}</span><span class="ccount">${n}</span>${dot(dueCount(x => x.id === b.id))}</button>`;
}
function mtoken(it, l, ci){
  const p = (it.photos || [])[0];
  const hl = view.name === 'mapfocus' && (view.hlItems || []).includes(it.id);
  return `<button class="mtoken${hl ? ' hl' : ''}${isOut(it) ? ' out' : ''}" data-item="${esc(it.id)}" data-box="${esc(l.id)}" data-ek="i:${esc(it.id)}" data-ci="${ci}"><span class="lcirc">${p ? imgTag(p.ref, '') : ''}<span class="ticon${p ? ' fb' : ''}">${guessIcon(it)}</span>${dot(isDue(it))}</span><span class="lname">${esc(it.name)}</span></button>`;
}
const OPP = {top: 'bottom', bottom: 'top', left: 'right', right: 'left'};
const doorOf = p => p.door || 'top', farOf = p => (p.far && p.far !== doorOf(p)) ? p.far : OPP[doorOf(p)];
const DOOR_ARROWS = {top: ['↑', '↓'], bottom: ['↓', '↑'], left: ['←', '→'], right: ['→', '←']};
function mapHTML(pid){
  // the door and the far end are only markers on the sides you choose; the map itself always looks the same
  const p = findPlace(pid), door = doorOf(p), far = farOf(p), zs = zonesOf(pid);
  const named = zs.filter(Boolean), [closer, further] = ['↑', '↓'];
  const zoneHTML = z => {
    const st = stacksIn(pid, z), nb = st.reduce((s, c) => s + c.ents.filter(e => e.kind === 'box').length, 0), ni = st.reduce((s, c) => s + c.ents.filter(e => e.kind === 'item').length, 0);
    const i = named.indexOf(z), empty = !nb && !ni;
    return `<section class="zone${z ? '' : ' nozone'}" data-zone="${esc(z)}"><div class="zhead"><button class="zname" ${z ? `data-zrename="${esc(z)}"` : 'disabled'}>${z ? esc(z) : tr('noZone')}</button><span class="zcount">${[nb ? tr('boxes_n', nb).toLowerCase() : '', ni ? tr('items_n', ni).toLowerCase() : ''].filter(Boolean).join(' · ')}</span>
      ${z ? `<button class="zbtn" data-zmove="${esc(z)}" data-dir="-1" ${i <= 0 ? 'disabled' : ''} aria-label="${esc(tr('closerDoor'))}">${closer}</button><button class="zbtn" data-zmove="${esc(z)}" data-dir="1" ${i < 0 || i >= named.length - 1 ? 'disabled' : ''} aria-label="${esc(tr('furtherIn'))}">${further}</button>` : ''}
      ${z && empty ? `<button class="zbtn" data-zdel="${esc(z)}" aria-label="${esc(tr('del'))}">×</button>` : ''}</div>
      <div class="stacks">${st.map((c, si) => `<div class="stack" data-si="${si}">${c.ents.map((e, ci) => e.kind === 'box' ? crate(e.b, ci) : mtoken(e.it, e.l, ci)).join('')}</div>`).join('')}
        ${z ? `<button class="crate add" data-act="addzone" data-zone="${esc(z)}" aria-label="${esc(tr('addTo', z))}">+</button>` : ''}</div></section>`;
  };
  const mark = (side, kind) => kind === 'door'
    ? `<button class="mapmark door side-${side}" data-act="doorside">🚪 ${tr('door')} <span class="doorsw">⟳</span></button>`
    : `<button class="mapmark far side-${side}" data-act="doorside">${tr('farIn')} <span class="doorsw">⟳</span></button>`;
  return `<div class="map vert"><p class="maphint">${tr('dragHint')}</p>
      <div class="mapgrid">${mark(door, 'door')}${mark(far, 'far')}<div class="mapbody">${zs.map(zoneHTML).join('')}</div></div>
      <button class="btn quiet block addzone" data-act="newzone">+ ${tr('addZone')}</button></div>`;
}
/* drop: put the thing at an exact place in a stack, or as a new stack */
function applyDrop(ek, pid, target){
  const ents = mapEntities(pid), ent = ents.find(e => e.k === ek); if (!ent) return;
  const fromZone = ent.zone, toZone = target.zone;
  const layout = z => stacksIn(pid, z).map(c => c.ents.map(e => e.k));
  let to = layout(toZone);
  if (target.newAt !== undefined) to.splice(Math.min(target.newAt, to.length), 0, ['@']);
  else { const s = to[target.s]; if (!s) return; s.splice(Math.min(target.k, s.length), 0, '@'); }
  const clean = L => L.map(s => s.filter(k => k !== ek)).filter(s => s.length).map(s => s.map(k => k === '@' ? ek : k));
  const touched = [[toZone, clean(to)]];
  if (fromZone !== toZone) touched.push([fromZone, clean(layout(fromZone))]);
  const pos = new Map();
  touched.forEach(([zone, L]) => L.forEach((s, i) => s.forEach((k, j) => pos.set(k, {zone, stack: i + 1, level: j + 1}))));
  const l = looseOf(pid);
  snapshot([...[...pos.keys()].filter(k => k.startsWith('b:')).map(k => k.slice(2)), l && l.id].filter(Boolean));
  let nl = null;
  for (const [k, ps] of pos){
    if (k.startsWith('b:')){
      const x = findBox(k.slice(2)); if (!x) continue;
      if ((x.location || '') === ps.zone && +x.stack === ps.stack && +x.level === ps.level) continue;
      const nx = clone(x); nx.location = ps.zone; nx.stack = ps.stack; nx.level = ps.level; putBox(nx, true);
    } else {
      nl = nl || clone(l); const x = nl.items.find(i => i.id === k.slice(2)); if (!x) continue;
      if (ps.zone) x.zone = ps.zone; else delete x.zone; x.stack = ps.stack; x.level = ps.level;
    }
  }
  if (nl) putBox(nl, true);
  const p = pos.get(ek), name = ek.startsWith('b:') ? findBox(ek.slice(2)).code : (ent.it.name || '');
  toast(`${name} → ${p.zone || tr('noZone')}, ${tr('stack').toLowerCase()} ${p.stack}${p.level > 1 ? `, ${tr('level').toLowerCase()} ${p.level}` : ''}`);
  render();
}
let drag = null;
function dragHit(x, y){
  const el = document.elementFromPoint(x, y); if (!el) return null;
  const zoneEl = el.closest('.zone[data-zone]'); if (!zoneEl) return drag && drag.last && Math.hypot(x - drag.last.x, y - drag.last.y) < 30 ? drag.last.hit : null;
  const zone = zoneEl.dataset.zone, stacksEl = zoneEl.querySelector('.stacks');
  const stacks = [...zoneEl.querySelectorAll('.stack[data-si]')];
  // which stack: the one whose column the finger is over (a little slack on each side)
  const sEl = stacks.find(s => { const r = s.getBoundingClientRect(); return x >= r.left - 5 && x <= r.right + 5; });
  if (sEl){
    const kids = [...sEl.children], rects = kids.map(c => c.getBoundingClientRect());
    // kids[0] is the bottom one; k = how many are below the finger
    const k = rects.filter(r => r.top + r.height / 2 > y).length;
    const sr = sEl.getBoundingClientRect();
    const ly = k >= kids.length ? (rects.length ? rects[rects.length - 1].top - 3 : sr.bottom - 3) : rects[k].bottom + 0.5;
    return {zone, s: +sEl.dataset.si, k, line: {x: sr.left - 4, y: ly, w: sr.width + 8, h: 3}};
  }
  const n = stacks.filter(s => { const r = s.getBoundingClientRect(); return r.left + r.width / 2 < x; }).length;
  const sr = (stacksEl || zoneEl).getBoundingClientRect();
  const lx = stacks[n] ? stacks[n].getBoundingClientRect().left - 6 : stacks[n - 1] ? stacks[n - 1].getBoundingClientRect().right + 3 : sr.left + 6;
  return {zone, newAt: n, line: {x: lx, y: sr.top + 4, w: 3, h: Math.max(40, sr.height - 10)}};
}
function endDrag(drop){
  if (!drag) return;
  const d = drag; drag = null;
  d.ghost.remove(); d.line.remove(); d.src.classList.remove('dragging');
  document.body.classList.remove('dragging-on');
  cancelAnimationFrame(d.raf);
  try { d.src.releasePointerCapture && d.pointerId != null && d.src.releasePointerCapture(d.pointerId); } catch {}
  if (drop && d.target) applyDrop(d.ek, d.pid, d.target);
}
function startDrag(src, e){
  const r = src.getBoundingClientRect();
  const ghost = src.cloneNode(true); ghost.classList.add('ghost');
  Object.assign(ghost.style, {left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'});
  const line = document.createElement('div'); line.className = 'dropline'; line.hidden = true;
  document.body.append(ghost, line); src.classList.add('dragging'); document.body.classList.add('dragging-on');
  const ek = src.dataset.ek, pid = currentPlace !== 'all' ? currentPlace : (ek.startsWith('b:') ? findBox(ek.slice(2)).placeId : findBox(src.dataset.box).placeId);
  drag = {ek, pid, src, ghost, line, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, target: null, moved: false, last: null};
  try { if (e.pointerId != null) src.setPointerCapture(e.pointerId); } catch {}
  if (navigator.vibrate) navigator.vibrate(12);
  const tb = ($('.topbar') || {getBoundingClientRect: () => ({bottom: 0})}).getBoundingClientRect().bottom;
  const loop = () => {
    if (!drag) return;
    if (drag.moved){
      const top = tb + 40, bottom = innerHeight - 62 - 40;
      if (drag.y < top) window.scrollBy(0, -Math.min(14, (top - drag.y) / 3));
      else if (drag.y > bottom) window.scrollBy(0, Math.min(14, (drag.y - bottom) / 3));
      const st = document.elementFromPoint(drag.x, drag.y), sc = st && (st.closest('.stacks') || st.closest('.map.horiz .mapbody'));
      if (sc){ const sr = sc.getBoundingClientRect(); if (drag.x < sr.left + 26) sc.scrollLeft -= 6; else if (drag.x > sr.right - 26) sc.scrollLeft += 6; }
      updateDrag();
    }
    drag.raf = requestAnimationFrame(loop);
  };
  drag.raf = requestAnimationFrame(loop);
}
function updateDrag(){
  const d = drag; if (!d) return;
  d.ghost.style.transform = `translate3d(${d.x - d.sx}px, ${d.y - d.sy}px, 0) scale(1.08)`;
  const hit = dragHit(d.x, d.y);
  if (hit) d.last = {x: d.x, y: d.y, hit};
  const changed = JSON.stringify(hit && [hit.zone, hit.s, hit.k, hit.newAt]) !== JSON.stringify(d.target && [d.target.zone, d.target.s, d.target.k, d.target.newAt]);
  d.target = hit;
  if (hit){ Object.assign(d.line.style, {left: hit.line.x + 'px', top: hit.line.y + 'px', width: hit.line.w + 'px', height: hit.line.h + 'px'}); if (changed && navigator.vibrate) navigator.vibrate(5); }
  d.line.hidden = !hit;
}
const HOLD_MS = 180, SLOP = 12;
let press = null;
app.addEventListener('pointerdown', e => {
  const c = e.target.closest('.map [data-ek]'); if (!c || e.button > 0) return;
  press = {c, x: e.clientX, y: e.clientY, pointerId: e.pointerId, t: setTimeout(() => { if (!press) return; startDrag(press.c, {clientX: press.x, clientY: press.y, pointerId: press.pointerId}); }, HOLD_MS)};
});
document.addEventListener('pointermove', e => {
  if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP){ clearTimeout(press.t); press = null; return; }
  if (!drag) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
  if (drag.moved) updateDrag();
}, {passive: true});
document.addEventListener('touchmove', e => { if (drag || press) { if (drag) e.preventDefault(); } }, {passive: false});
document.addEventListener('pointerup', () => {
  if (press) clearTimeout(press.t);
  if (drag){
    const d = drag;
    lpFired = true; setTimeout(() => { lpFired = false; }, 400);
    if (!d.moved){ endDrag(false); lpMenu(d.ek.startsWith('b:') ? 'box:' + d.ek.slice(2) : `item:${d.src.dataset.box}:${d.ek.slice(2)}`); }
    else endDrag(true);
  }
  press = null;
});
document.addEventListener('pointercancel', () => { if (press) clearTimeout(press.t); press = null; if (drag) endDrag(false); });
function doorSheet(pid){
  const p = findPlace(pid);
  const draw = () => {
    const door = doorOf(p), far = farOf(p);
    const grid = (kind, cur, block) => { const o = (k, ic) => `<button class="btn ${cur === k ? 'primary' : 'quiet'}" data-${kind}="${k}" ${block === k ? 'disabled' : ''}>${ic} ${tr('door_' + k)}</button>`;
      return `<div class="doorgrid"><span></span>${o('top', '↑')}<span></span>${o('left', '←')}<span class="doorc">${kind === 'door' ? '🚪' : '⬚'}</span>${o('right', '→')}<span></span>${o('bottom', '↓')}<span></span></div>`; };
    openSheet(`<h3>${tr('doorSide')}</h3><p class="hint">${tr('doorHint')}</p>
      <div class="field"><span>🚪 ${tr('door')}</span>${grid('door', door, null)}</div>
      <div class="field"><span>${tr('farIn')}</span>${grid('far', far, door)}</div>
      <div class="sheet-foot"><button class="btn primary" id="dsX">${tr('done')}</button></div>`);
    sheet.querySelectorAll('.doorgrid').forEach(g => g.onclick = e => {
      const t = e.target.closest('[data-door],[data-far]'); if (!t || t.disabled) return;
      if (t.dataset.door){ p.door = t.dataset.door; if (farOf(p) === p.door || !p.far) p.far = OPP[p.door]; }
      else p.far = t.dataset.far;
      metaPut('places', places).catch(() => {}); render(); draw();
    });
    $('#dsX').onclick = closeSheet;
  };
  draw();
}
async function renameZone(pid, z){
  const n = await askText(tr('renameX', z), {value: z, ok: tr('save')}); if (!n || n === z) return render();
  const p = findPlace(pid);
  if (zonesOf(pid).includes(n)){ toast(tr('zoneExists')); return render(); }
  p.zones = zonesOf(pid).filter(Boolean).map(x => x === z ? n : x); metaPut('places', places).catch(() => {});
  topBoxesIn(pid).filter(b => (b.location || '').trim() === z).forEach(b => { const nb = clone(b); nb.location = n; putBox(nb, true); });
  const l = looseOf(pid); if (l && (l.items || []).some(i => i.zone === z)){ const nl = clone(l); nl.items.forEach(i => { if (i.zone === z) i.zone = n; }); putBox(nl, true); }
  render();
}
async function addZone(pid){
  const n = await askText(tr('addZone'), {placeholder: tr('zoneHint'), ok: tr('add')}); if (!n) return render();
  const p = findPlace(pid), cur = zonesOf(pid).filter(Boolean);
  if (cur.includes(n)){ toast(tr('zoneExists')); return render(); }
  p.zones = cur.concat(n); metaPut('places', places).catch(() => {}); render();
}
function deleteZone(pid, z){ const p = findPlace(pid); p.zones = zonesOf(pid).filter(x => x && x !== z); metaPut('places', places).catch(() => {}); render(); }
/* placement from a menu (same rules as dragging) */
function placementSheet(boxId){
  const b = findBox(boxId); if (!b || b.loose) return;
  const pid = b.placeId, ek = 'b:' + b.id, zs = zonesOf(pid).filter(Boolean);
  const label = e => e.kind === 'box' ? e.b.code : e.it.name;
  const stackOpts = zone => `<option value="new">${tr('newStack')}</option>` + stacksIn(pid, zone).map((c, i) => { const others = c.ents.filter(e => e.k !== ek); if (!others.length) return '';
    return `<option value="${i}" ${c.ents.some(e => e.k === ek) ? 'selected' : ''}>${esc(tr('stackOf', i + 1, others.map(label).join(', ')))}</option>`; }).join('');
  openSheet(`<h3>${tr('placement')} · ${esc(b.code)}</h3><p class="hint">${tr('placementHint')}</p>
    <label class="field"><span>${tr('zone')}</span><input id="plZone" list="zlist" value="${esc(b.location || '')}" placeholder="${esc(tr('zoneHint'))}"><datalist id="zlist">${zs.map(z => `<option value="${esc(z)}">`).join('')}</datalist></label>
    <label class="field"><span>${tr('stack')}</span><select id="plStack">${stackOpts((b.location || '').trim())}</select></label>
    <div class="field" id="plLevelF"><span>${tr('level')}</span><div class="seg small"><button class="on" data-lv="top">${tr('onTop')}</button><button data-lv="bottom">${tr('atBottom')}</button></div></div>
    <div class="sheet-foot"><button class="btn quiet" id="plX">${tr('cancel')}</button><button class="btn primary" id="plOk">${tr('save')}</button></div>`);
  let lv = 'top', zoneShown = (b.location || '').trim();
  const syncLevel = () => { $('#plLevelF').hidden = $('#plStack').value === 'new'; };
  const refresh = () => { const z = $('#plZone').value.trim(); if (z === zoneShown) return; zoneShown = z; const keep = $('#plStack').value; $('#plStack').innerHTML = stackOpts(z); if ([...$('#plStack').options].some(o => o.value === keep)) $('#plStack').value = keep; syncLevel(); };
  $('#plZone').addEventListener('change', refresh); $('#plZone').addEventListener('input', () => { clearTimeout(refresh.t); refresh.t = setTimeout(refresh, 400); });
  $('#plStack').addEventListener('change', syncLevel); syncLevel();
  sheet.querySelector('#plLevelF').onclick = e => { const t = e.target.closest('[data-lv]'); if (!t) return; lv = t.dataset.lv; sheet.querySelectorAll('[data-lv]').forEach(x => x.classList.toggle('on', x === t)); };
  $('#plX').onclick = closeSheet;
  $('#plOk').onclick = () => {
    const zone = $('#plZone').value.trim(), sv = $('#plStack').value, st = stacksIn(pid, zone);
    const p = findPlace(pid); if (zone && !zonesOf(pid).includes(zone)){ p.zones = zonesOf(pid).filter(Boolean).concat(zone); metaPut('places', places).catch(() => {}); }
    closeSheet();
    if (sv === 'new') applyDrop(ek, pid, {zone, newAt: st.length});
    else applyDrop(ek, pid, {zone, s: +sv, k: lv === 'top' ? st[+sv].ents.length : 0});
  };
}

function moveZone(pid, zone, dir){
  const p = findPlace(pid), order = zonesOf(pid).filter(Boolean), i = order.indexOf(zone), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]]; p.zones = order; metaPut('places', places).catch(() => {}); render();
}
const searchScope = {places: new Set(), boxes: new Set()};
function scopeChips(){
  if (places.length < 2 && realBoxes().length < 2) return '';
  const P = searchScope.places, B = searchScope.boxes;
  const one = P.size === 1 ? [...P][0] : (places.length === 1 ? places[0].id : null);
  return `<div class="scope"><span class="lab">${tr('searchIn')}</span><div class="chips">
    ${places.length > 1 ? `<button class="chipbtn${!P.size ? ' on' : ''}" data-scope="all">${tr('everywhere')}</button>${places.map(p => `<button class="chipbtn${P.has(p.id) ? ' on' : ''}" data-scope="p:${esc(p.id)}">${esc(p.name)}</button>`).join('')}` : ''}
    </div>${one && boxesIn(one).length > 1 ? `<div class="chips"><button class="chipbtn small${!B.size ? ' on' : ''}" data-scope="allboxes">${esc(tr('allOf', placeName(one)))}</button>${boxesIn(one).sort(byCode).map(b => `<button class="chipbtn small${B.has(b.id) ? ' on' : ''}" data-scope="b:${esc(b.id)}">${esc(b.code)} ${esc(b.name)}</button>`).join('')}</div>` : ''}</div>`;
}
let recentQ = [];
function rememberQuery(q){ q = (q || '').trim(); if (q.length < 2) return; { const r = searchItems(q); track('search', {hits: r.exact.length ? 'yes' : r.related.length ? 'similar' : 'none', words: q.split(/\s+/).length}); } recentQ = [q, ...recentQ.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8); metaPut('recentQ', recentQ).catch(() => {}); }
function rowsOrTiles(entries){
  const bx = entries.filter(e => e[0] === 'box').map(e => e[1]), its = entries.filter(e => e[0] === 'item').map(e => [e[1], e[2]]);
  return `${bx.length ? `<div class="shelf${shelfCls()}">${bx.map(shelfTile).join('')}</div>` : ''}${its.length ? (viewMode === 'list' ? rowsHTML(its, {where: true}) : `<div class="igrid${viewCls()}">${its.map(([it, b]) => itemTile(it, b, whereCaption(b))).join('')}</div>`) : ''}`;
}
let searchQuick = null;
let searchOpen = false, askOpen = false;
const looksLikeQuestion = t => /\?\s*$/.test(t) || /^(var|vart|vad|hur|när|vem|har|finns|kan|visa|öppna|lägg|ta|flytta|where|what|how|when|who|do|is|are|can|show|open|add|put|move|take)\b/i.test((t || '').trim());
function scopeChip(){
  if (places.length < 2 && realBoxes().length < 2) return '';
  const P = searchScope.places, B = searchScope.boxes;
  const label = B.size ? (B.size === 1 ? (findBox([...B][0]) || {}).code || '' : tr('boxes_n', B.size).toLowerCase()) : P.size === 1 ? placeName([...P][0]) : places.length > 1 ? tr('everywhere') : placeName(places[0].id);
  return `<button class="chipbtn${P.size || B.size ? ' on' : ''}" id="scopeBtn">📍 ${esc(label)} ▾</button>`;
}
function scopeSheet(){
  openSheet(`<h3>${tr('searchIn')}</h3><div id="scopeBody">${scopeChips().replace(/<span class="lab">.*?<\/span>/, '')}</div><div class="sheet-foot"><button class="btn primary" id="scX">${tr('ok')}</button></div>`);
  const wire = () => sheet.querySelectorAll('[data-scope]').forEach(c => c.onclick = () => {
    const P = searchScope.places, B = searchScope.boxes, v = c.dataset.scope;
    if (v === 'all'){ P.clear(); B.clear(); } else if (v === 'allboxes') B.clear();
    else if (v.startsWith('p:')){ const id = v.slice(2); P.has(id) ? P.delete(id) : P.add(id); B.clear(); }
    else if (v.startsWith('b:')){ const id = v.slice(2); B.has(id) ? B.delete(id) : B.add(id); }
    $('#scopeBody').innerHTML = scopeChips().replace(/<span class="lab">.*?<\/span>/, ''); wire();
  });
  wire();
  $('#scX').onclick = () => { closeSheet(); render(); };
}
function quickChipsInner(){ return quickChips().replace(/^<div class="chips quick">/, '').replace(/<\/div>$/, ''); }
function quickChips(){
  const nOut = outItems().length + realBoxes().filter(b => b.out).length, nLoose = boxes.filter(b => b.loose).reduce((s, b) => s + (b.items || []).length, 0);
  const c = (k, label, n) => `<button class="chipbtn${searchQuick === k ? ' on' : ''}" data-quick="${k}">${label}${n !== undefined ? ` <small>${n}</small>` : ''}</button>`;
  return `<div class="chips quick">${c('out', '↗ ' + tr('outNow'), nOut)}${c('loose', tr('notInBox'), nLoose)}${c('boxes', tr('allBoxes'), realBoxes().length)}${c('items', tr('allItems'), boxes.reduce((s, b) => s + (b.items || []).length, 0))}</div>`;
}
function renderSearch(){
  const nB = realBoxes().length, nI = boxes.reduce((s, b) => s + (b.items || []).length, 0);
  const q = query.trim(), P = searchScope.places, B = searchScope.boxes;
  const inScope = b => (!P.size || P.has(b.placeId)) && (!B.size || B.has(b.id));
  let body = '';
  if (!q && (P.size || B.size)){
    const all = boxes.filter(inScope).flatMap(b => (b.items || []).map(it => [it, b])).sort((x, y) => byName(x[0], y[0]));
    body = all.length ? `<div class="igrid">${all.map(([it, b]) => itemTile(it, b, whereCaption(b))).join('')}</div>` : `<p class="hint center">${tr('nothingHere')}</p>`;
  }
  if (q && !searchQuick){
    const {exact, related} = searchItems(q, {placeIds: P, boxIds: B});
    const boxHits = searchQuick ? [] : realBoxes().filter(b => { if (!inScope(b)) return false; const unit = b.shelf && ((findPlace(b.placeId) || {}).units || []).find(u => u.id === b.shelf.u); const h = [b.code, b.code.replace('B-', ''), b.name, b.location, b.notes, placeName(b.placeId), b.moveRoom, b.out ? tr('outTag') : '', unit ? unit.name : '', ...(b.documents || []).map(d => d.name)].join(' ').toLowerCase(); return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => h.includes(w)); }).sort(byCode);
    body = `${exact.length ? (viewMode === 'list' && !selecting ? rowsHTML(exact, {where: true}) : `<div class="igrid${viewCls()}">${exact.map(([it, b]) => itemTile(it, b, whereCaption(b))).join('')}</div>`) : ''}
      ${boxHits.length ? `<h2 class="section">${tr('boxesH')}</h2><div class="shelf${shelfCls()}">${boxHits.map(shelfTile).join('')}</div>` : ''}
      ${related.length ? `<h2 class="section">${tr('similar')}</h2><div class="igrid${viewCls()}">${related.map(([it, b]) => itemTile(it, b, whereCaption(b))).join('')}</div>` : ''}
      ${!exact.length && !related.length && !boxHits.length ? `<p class="hint center">${esc(tr('noMatch', q))}</p>${(sg => sg.length ? `<div class="didyou"><span class="lab">${tr('didYouMean')}</span><div class="chips">${sg.map(s => `<button class="chipbtn" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>` : '')(searchSuggestions(q))}` : ''}`;
  }
  if (searchQuick){
    const qq = q.toLowerCase(), hitIt = ([it, b]) => !q || itemHay(it, b).hay.includes(qq) || (it.name || '').toLowerCase().includes(qq);
    const hitBox = b => !q || [b.code, b.name, b.location, b.notes].some(v => (v || '').toLowerCase().includes(qq));
    let its = [], bx = [];
    if (searchQuick === 'out'){ its = outItems(inScope); bx = realBoxes().filter(b => b.out && inScope(b)); }
    if (searchQuick === 'loose') its = boxes.filter(b => b.loose && inScope(b)).flatMap(b => (b.items || []).map(it => [it, b]));
    if (searchQuick === 'boxes') bx = realBoxes().filter(inScope).sort(byCode);
    if (searchQuick === 'items') its = boxes.filter(inScope).flatMap(b => (b.items || []).map(it => [it, b]));
    its = its.filter(hitIt).sort((x, y) => byName(x[0], y[0])); bx = bx.filter(hitBox);
    body = `${bx.length ? `${its.length ? `<h2 class="section">${tr('boxesH')}</h2>` : ''}<div class="shelf">${bx.map(shelfTile).join('')}</div>` : ''}
      ${its.length ? `${bx.length ? `<h2 class="section">${tr('itemsH')}</h2>` : ''}${viewMode === 'list' && !selecting ? rowsHTML(its, {where: true}) : `<div class="igrid${viewCls()}">${its.map(([it, b]) => itemTile(it, b, whereCaption(b))).join('')}</div>`}` : ''}
      ${!its.length && !bx.length ? `<p class="hint center">${searchQuick === 'out' ? tr('nothingOut') : tr('nothingHere')}</p>` : ''}`;
  }
  if (!q && !P.size && !B.size && !searchQuick){
    body = `${recentQ.length ? `<div class="recentq"><div class="rqhead"><span class="lab">${tr('recentSearches')}</span><button class="linkbtn" data-act="clearrq">${tr('clear')}</button></div><div class="chips">${recentQ.map(s => `<button class="chipbtn" data-suggest="${esc(s)}">🔎 ${esc(s)}</button>`).join('')}</div></div>` : ''}
      ${(r => r.length ? `<h2 class="section">${tr('recent')}</h2>` + rowsOrTiles(r) : '')(recentEntries())}`;
  }
  const had = $('#q'), focused = had && document.activeElement === had, pos = had ? had.selectionStart : 0;
  app.innerHTML = `<div class="headrow"><div class="headtext">${crumbs([{label: tr('findStuff')}], counts(tr('boxes_n', nB), tr('items_n', nI)))}</div></div>
    <div class="sbar"><input class="input search" id="q" type="search" placeholder="${esc(tr('searchOrAsk'))}" value="${esc(query)}" autocomplete="off" enterkeyhint="search">${SR ? `<button class="micin" id="micBtn" aria-label="${esc(tr('tapTalk'))}">${ICON.mic}</button>` : ''}</div>
    ${q.length >= 2 ? `<button class="askbtn" id="askGo"><span class="spark">✨</span><span>${esc(tr('askAbout', q))}</span><small>beta</small></button>` : ''}
    <div class="chips quick">${quickChipsInner()}${scopeChip()}</div>
    ${askOpen ? `<div class="askpanel"><div class="askhead"><b>✨ Storrrage</b><small>beta · ${ai.provider === 'off' ? tr('simpleMode') : 'AI'}</small><button class="linkbtn" id="askX" aria-label="${esc(tr('close'))}">✕</button></div><div class="vlog chat" id="vlog"></div><div class="vlive" id="vLive" hidden></div></div>` : ''}
    ${collectionChips(q)}
    ${(q || P.size || B.size) && !selecting && /itile/.test(body) ? `<div class="selrow"><button class="btn quiet small" data-act="selectmode">${tr('select')}</button></div>` : ''}
    <div id="results">${body}</div>
    ${selBar(['tag', 'move', 'del'])}`;
  document.body.classList.toggle('selecting', !!selecting);
  if ($('#scopeBtn')) $('#scopeBtn').onclick = scopeSheet;
  const s = $('#q');
  const ask = text => { text = (text || '').trim(); if (!text) return; askOpen = true; query = ''; track('ask', {from: 'search'}); render(); handleBatch(text); };
  if ($('#askGo')) $('#askGo').onclick = () => ask(q);
  if ($('#micBtn')) $('#micBtn').onclick = () => { track('voice'); if (!askOpen){ askOpen = true; render(); } listen(); };
  if ($('#askX')) $('#askX').onclick = () => { askOpen = false; stopListening(); if (window.speechSynthesis) speechSynthesis.cancel(); render(); };
  if ($('#vlog')){ drawLog(); $('#vlog').addEventListener('click', e => { const b = e.target.closest('[data-vact]'); if (!b) return; const l = voiceLog[+b.dataset.vact]; if (l && l.action){ const run = l.action.run; l.action = null; drawLog(); run(); } }); }
  s.addEventListener('keydown', e => { if (e.key === 'Enter' && looksLikeQuestion(s.value)){ e.preventDefault(); e.stopImmediatePropagation(); ask(s.value); } }, true);
  if (focused){ s.focus(); try { s.setSelectionRange(pos, pos); } catch {} }
  let tmr; s.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { query = s.value; render(); }, 150); });
  bindSearchExtras();
}
function bindSearchExtras(){
  const P = searchScope.places, B = searchScope.boxes;
  app.querySelectorAll('[data-quick]').forEach(c => c.onclick = () => { track('search_quick', {f: c.dataset.quick}); searchQuick = searchQuick === c.dataset.quick ? null : c.dataset.quick; render(); });
  app.querySelectorAll('[data-suggest]').forEach(c => c.onclick = () => { query = c.dataset.suggest; rememberQuery(query); render(); });
  const s = $('#q');
  if (s) s.addEventListener('keydown', e => { if (e.key === 'Enter'){ rememberQuery(s.value); s.blur(); } });
  app.querySelectorAll('[data-scope]').forEach(c => c.onclick = () => {
    const v = c.dataset.scope;
    if (v === 'all'){ P.clear(); B.clear(); }
    else if (v === 'allboxes') B.clear();
    else if (v.startsWith('p:')){ const id = v.slice(2); P.has(id) ? P.delete(id) : P.add(id); B.clear(); }
    else if (v.startsWith('b:')){ const id = v.slice(2); B.has(id) ? B.delete(id) : B.add(id); }
    render();
  });
}
const PLACE_SUG = {sv: ['Källaren', 'Förrådet', 'Garaget', 'Vinden', 'Hemma'], en: ['Basement', 'Storage unit', 'Garage', 'Attic', 'Home'], da: ['Kælderen', 'Depotrummet', 'Garagen', 'Loftet', 'Hjemme'], nb: ['Kjelleren', 'Boden', 'Garasjen', 'Loftet', 'Hjemme'], fi: ['Kellari', 'Varasto', 'Autotalli', 'Ullakko', 'Koti']};
const KITS = {
  basement: {zones: ['zoneLeft', 'zoneBack', 'zoneRight'], boxes: [['kitXmas', 0], ['kitEaster', 0], ['kitTools', 1], ['kitCamping', 1], ['kitSport', 1], ['kitKidsClothes', 2], ['kitBooks', 2], ['kitCables', 2], ['kitKitchen', 0], ['kitMisc', 1]]},
};
function applyKit(pid){
  const p = findPlace(pid); if (!p) return;
  const k = KITS.basement, zones = k.zones.map(z => tr(z));
  p.zones = [...new Set([...(p.zones || []), ...zones])]; metaPut('places', places).catch(() => {});
  const now = new Date().toISOString();
  k.boxes.forEach(([nameKey, zi]) => putBox({id: newId(), code: nextCode(pid), name: tr(nameKey), placeId: pid, location: zones[zi], items: [], kit: true, createdAt: now, updatedAt: now, checkedAt: now}, true));
  track('start_kit');
}
function renderWelcome(){
  const step = view.step || 1;
  const head = `<div class="langsw">${langSwitch()}</div><div class="logobig">${logoSVG()}</div><h1>Storrrage</h1>`;
  if (step === 2){
    const sug = PLACE_SUG[lang] || PLACE_SUG.en;
    app.innerHTML = `<div class="welcome">${head}
      <div class="wcard"><h2>${esc(tr('hiName', me))}</h2><p class="hint">${tr('placeQ')}</p>
      <input class="input" id="wPlace" placeholder="${esc(sug[0])}" autocapitalize="sentences">
      <div class="chips center">${sug.map(n => `<button class="chipbtn" data-sug="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <p class="hint" style="margin-top:6px">${tr('kitQ')}</p>
      <button class="btn primary block kitbtn" id="wKit"><b>${tr('kitYes')}</b><small>${tr('kitYesSub')}</small></button>
      <button class="btn block" id="wEmpty">${tr('kitNo')}</button></div></div>`;
    app.querySelectorAll('[data-sug]').forEach(c => c.onclick = () => { $('#wPlace').value = c.dataset.sug; app.querySelectorAll('[data-sug]').forEach(x => x.classList.toggle('on', x === c)); });
    const finish = kit => {
      const n = $('#wPlace').value.trim() || sug[0];
      let p = places.find(x => !x.inbox && boxesIn(x.id).length === 0 && !(looseOf(x.id) || {items: []}).items.length) || null;
      if (p){ p.name = n; } else { p = {id: newId(), name: n, createdAt: new Date().toISOString()}; places.push(p); }
      metaPut('places', places).catch(() => {});
      if (kit) applyKit(p.id);
      metaPut('onboarded', true).catch(() => {});
      currentPlace = p.id; metaPut('currentPlace', p.id).catch(() => {});
      navigate({name: 'home', place: p.id}, true);
      if (kit) setTimeout(() => toast(tr('kitDone')), 300);
    };
    $('#wKit').onclick = () => finish(true); $('#wEmpty').onclick = () => finish(false);
    return;
  }
  app.innerHTML = `<div class="welcome">${head}
    <p class="slogan">${tr('slogan')}</p>
    ${pendingJoinCode ? `<div class="wcard"><h2>${tr('invitedTitle')}</h2><p class="hint">${tr('invitedIntro')}</p>${loginForm(true)}</div>`
    : `<div class="wcard">
      <button class="btn primary block" id="wNew">${tr('startNew')}</button>
      <div class="wform" id="wNewF" hidden><p class="hint">${tr('nameQ')}</p><input class="input" id="wName" placeholder="${esc(tr('yourName'))}" autocapitalize="words" autocomplete="given-name"><button class="btn primary block" id="wGo">${tr('next')}</button></div>
      <p class="hint" id="wNewHint">${tr('startNewHint')}</p></div>
    <div class="wor"><span>${tr('or')}</span></div>
    <div class="wcard">
      <button class="btn block" id="wLog">${tr('logInOrCreate')}</button>
      <div class="wform" id="wLogF" hidden>${loginForm(true)}</div>
      <p class="hint" id="wLogHint">${tr('loginHint')}</p></div>`}</div>`;
  wireLogin();
  if (pendingJoinCode) return;
  $('#wNew').onclick = () => { $('#wNew').hidden = true; $('#wNewHint').hidden = true; $('#wNewF').hidden = false; $('#wName').focus(); };
  $('#wLog').onclick = () => { $('#wLog').hidden = true; $('#wLogHint').hidden = true; $('#wLogF').hidden = false; $('#clEmail').focus(); };
  const go = () => {
    const n = $('#wName').value.trim(); if (!n){ $('#wName').focus(); return toast(tr('writeName')); }
    me = addPerson(n); metaPut('me', me).catch(() => {});
    view = {name: 'welcome', step: 2}; render();
  };
  $('#wGo').onclick = go; $('#wName').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}
/* The selected language follows the device unless another language is chosen. */
let langPref = 'auto';
const LANGS = [['sv', 'Svenska'], ['en', 'English'], ['da', 'Dansk'], ['nb', 'Norsk'], ['fi', 'Suomi']];
const VOICE = {sv: 'sv-SE', en: 'en-US', da: 'da-DK', nb: 'nb-NO', fi: 'fi-FI'};
const phoneLang = () => {
  for (const raw of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])){
    const l = String(raw).toLowerCase();
    if (l.startsWith('sv')) return 'sv'; if (l.startsWith('da')) return 'da'; if (l.startsWith('nb') || l.startsWith('nn') || l.startsWith('no')) return 'nb'; if (l.startsWith('fi')) return 'fi'; if (l.startsWith('en')) return 'en';
  }
  return 'en';
};
const langSwitch = () => {
  const active = LANGS.find(x => x[0] === lang) || LANGS[1];
  const currentValue = langPref === 'auto' ? 'auto' : active[0];
  return `<select class="langsel" data-lang-select aria-label="Language / Språk"><option value="${currentValue}" selected>${active[1]}</option>${LANGS.filter(([k]) => k !== active[0]).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>`;
};
document.addEventListener('change', e => { const s = e.target.closest && e.target.closest('[data-lang-select]'); if (!s) return; setLang(s.value); if (sheet.open && sheet.querySelector('[data-lang-select]')) menuSheet(); });
function setLang(l){
  langPref = LANGS.some(x => x[0] === l) ? l : 'auto';
  lang = langPref === 'auto' ? phoneLang() : langPref;
  metaPut('langPref', langPref).catch(() => {}); metaPut('lang', lang).catch(() => {});
  if (typeof saveLangToAccount === 'function') saveLangToAccount();
  voiceLang = VOICE[lang] || 'en-US'; metaPut('voiceLang', voiceLang).catch(() => {});
  render();
}
window.addEventListener('languagechange', () => { if (langPref === 'auto' && phoneLang() !== lang) setLang('auto'); });
document.addEventListener('click', e => { const b = e.target.closest('[data-lang-ui]'); if (b){ setLang(b.dataset.langUi); if (sheet.open && sheet.querySelector('[data-lang-ui]')) menuSheet(); } });

function renderProfile(){
  const sub = view.sub || '', due = dueItems();
  const back = [{label: tr('profile').toUpperCase(), nav: {name: 'profile'}}];
  if (!sub){
    const nN = due.length + outItems().filter(([it]) => outOverdue(it)).length + realBoxes().filter(boxOutLate).length + nudges().length + attention();
    app.innerHTML = `${crumbs([{label: tr('profile').toUpperCase()}])}
      <div class="fl" style="margin-top:14px"><input id="pfName" value="${esc(me)}" placeholder="${esc(tr('yourName'))}" autocapitalize="words"><label>${tr('yourName')}</label></div>
      <p class="proof">${tr('nameShown')}</p>
      ${cloud.session ? `<div class="fl"><input value="${esc(cloud.email || '')}" disabled><label class="always">${tr('loginEmail')}</label></div>
        <div class="pfacts">${pfacts()}</div>
        <label class="check"><input type="checkbox" id="pfMail" ${prof.notify_email ? 'checked' : ''}> ${tr('mailReminders')}</label>
        <div class="fl" id="pfAltWrap" ${prof.notify_email ? '' : 'hidden'}><input id="pfAlt" type="email" inputmode="email" value="${esc(prof.contact_email || '')}" placeholder="${esc(cloud.email || '')}"><label class="always">${tr('otherEmail')}</label></div>
        <p class="proof">${tr('mailHint')}</p>`
      : `<div class="loginbox">${accountPitch()}${loginForm()}</div>`}
      <div class="list">
        <button class="row" data-sub="notifications">${ICON.bell}<span>${tr('notifications')}</span>${nN ? `<b class="count">${nN}</b>` : ''}</button>
        <button class="row" data-sub="premium">${ICON.star}<span>${tr('premium')}</span></button>
      </div>
      ${cloud.session ? `<div class="list"><button class="btn block" id="pfOut">${tr('logout')}</button><button class="btn danger block" id="pfOutAll">${tr('logoutAll')}</button></div><p class="proof">${tr('logoutAllHint')}</p>` : ''}`;
    if ($('#pfOut')){ $('#pfOut').onclick = () => askConfirm(tr('logoutQ'), tr('logout')).then(y => { if (y) logout(false); }); $('#pfOutAll').onclick = () => askConfirm(tr('logoutAllQ'), tr('logoutAll')).then(y => { if (y) logout(true); }); }
    wireLogin();
    $('#pfName').addEventListener('change', e => { const n = e.target.value.trim(); if (!n) return; me = addPerson(n); metaPut('me', me).catch(() => {}); });
    if ($('#pfMail')){
      $('#pfMail').onchange = e => { prof.notify_email = e.target.checked; $('#pfAltWrap').hidden = !prof.notify_email; saveProfile(); };
      $('#pfAlt').onchange = e => { prof.contact_email = e.target.value.trim() || null; saveProfile(); };
    }
    return;
  }
  if (sub === 'notifications'){
    const late = outItems().filter(([it]) => outOverdue(it));
    const lateBoxes = realBoxes().filter(boxOutLate), sug = nudges();
    app.innerHTML = `${crumbs([...back, {label: tr('notifications').toUpperCase()}])}
      ${sug.length ? `<h2 class="section">${tr('suggestions')}</h2>${sug.map(n => nudgeCard(n)).join('')}` : ''}
      ${warrantySoon().length ? `<h2 class="section">${tr('warrantyH')}</h2><div class="dues">${warrantySoon().map(([it, b]) => `<div class="due">${itemTile(it, b, whereCaption(b))}<div class="dueact"><span class="hint">${esc(tr('warrantyLeft', daysTo(it.warranty)))}</span></div></div>`).join('')}</div>` : ''}
      ${loanOld().length ? `<h2 class="section">${tr('loansOld')}</h2><div class="dues">${loanOld().map(([it, b]) => `<div class="due">${itemTile(it, b, whereCaption(b))}<div class="dueact"><span class="hint">${esc((it.loanTo || '') + ' · ' + tr('lentSince', loanDays(it)))}</span><button class="btn quiet small" data-m="loans">${tr('loansTitle')}</button></div></div>`).join('')}</div>` : ''}
      ${lateBoxes.length ? `<h2 class="section">${tr('backQ')}</h2><div class="shelf">${lateBoxes.map(shelfTile).join('')}</div>` : ''}
      ${late.length ? `<h2 class="section">${tr('backQ')}</h2><div class="dues">${late.map(([it, b]) => `<div class="due">${itemTile(it, b, whereCaption(b))}
        <div class="dueact"><span class="hint">${esc(tr('backBy', it.out.until))}</span><button class="btn primary small" data-backok="${esc(b.id)}:${esc(it.id)}">↩ ${tr('isBack')}</button><button class="btn quiet small" data-more="${esc(b.id)}:${esc(it.id)}">${tr('stillOut')}</button></div></div>`).join('')}</div>` : ''}
      ${due.length ? `<p class="hint">${tr('dueIntro')}</p>
        <div class="dues">${due.map(([it, b]) => `<div class="due">${itemTile(it, b, whereCaption(b))}
          <div class="dueact"><span class="hint">${esc(tr('lastUsedOn', it.lastUsed || it.storedOn || ''))}</span>
          <button class="btn quiet small" data-used="${esc(b.id)}:${esc(it.id)}">${tr('usedRecently')}</button>
          <button class="btn quiet small" data-sell="${esc(b.id)}:${esc(it.id)}">${tr('markSale')}</button></div></div>`).join('')}</div>`
      : attention() || sug.length || late.length || lateBoxes.length ? '' : `<p class="hint">${tr('nothingDue')}</p>`}`;
    return;
  }
  if (sub === 'premium'){
    app.innerHTML = `${crumbs([...back, {label: tr('premium').toUpperCase()}])}
      <div class="list"><div class="row static">${ICON.star}<span>${tr('prem1')}</span></div>
      <div class="row static">${ICON.star}<span>${tr('prem2')}</span></div>
      <div class="row static">${ICON.star}<span>${tr('prem3')}</span></div></div>
      <p class="hint center">${tr('premLater')}</p>`;
  }
}
/* settings: one place for everything that isn't profile or household */
let theme = 'system';
function applyTheme(){
  const r = document.documentElement;
  if (theme === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', theme);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? '#17151F' : '#FFFFFF';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function renderSettings(){
  const seg = (cur, opts, attr) => `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" ${attr}="${v}">${l}</button>`).join('')}</div>`;
  app.innerHTML = `${crumbs([{label: tr('settings').toUpperCase()}])}
    <div class="field" style="margin-top:14px"><span>${tr('appearance')}</span>${seg(theme, [['light', tr('light')], ['dark', tr('dark')], ['system', tr('auto')]], 'data-theme-set')}</div>
    <div class="list">
      <button class="row" data-m="ai"><span>${tr('aiAssistant')}</span><em>${ai.provider === 'off' ? tr('off') : esc(AI_LABEL[ai.provider])}</em></button>
      <button class="row" data-m="export"><span>${tr('export')}</span><em>Excel · Word · PDF</em></button>
      <button class="row" data-m="report"><span>${tr('insurance')}</span></button>
      <button class="row" data-m="labels"><span>${tr('labelsAll')}</span></button>
      <button class="row" data-m="blanklabels"><span>${tr('blankLabels')}</span></button>
    </div>
    <div class="field"><span>${tr('numbering')}</span><select class="input" id="numSel"><option value="place" ${numbering === 'place' ? 'selected' : ''}>${tr('numPlace')}</option><option value="account" ${numbering === 'account' ? 'selected' : ''}>${tr('numAccount')}</option></select></div>
    <label class="check"><input type="checkbox" id="notifChk" ${notifOn && 'Notification' in window && Notification.permission === 'granted' ? 'checked' : ''}> ${tr('notifSetting')}</label><p class="proof">${tr('notifHint')}</p>
    <label class="check"><input type="checkbox" id="statsChk" ${statsOn ? 'checked' : ''}> ${tr('statsSetting')}</label><p class="proof">${tr('statsHint')}</p>
    <label class="check"><input type="checkbox" id="adsChk" ${adsPreview ? 'checked' : ''}> ${tr('adsSetting')}</label>
    <details class="more"><summary>${tr('advanced')}</summary><div class="list"><button class="row" data-m="import"><span>${tr('restore')}</span></button></div><p class="proof">${tr('restoreHint')}</p></details>
    <p class="proof center" id="usage"></p>`;
  app.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => { theme = b.dataset.themeSet; metaPutRaw('theme', theme).catch(() => {}); applyTheme(); track('theme', {v: theme}); render(); });
  $('#notifChk').onchange = async e => { if (e.target.checked){ const ok = await turnOnNotifications(); e.target.checked = ok; if (ok) toast(tr('notifOnToast')); } else { notifOn = false; metaPutRaw('notifOn', false).catch(() => {}); } };
  $('#statsChk').onchange = e => { statsOn = e.target.checked; metaPutRaw('statsOn', statsOn).catch(() => {}); if (!statsOn) evq = []; };
  $('#adsChk').onchange = e => { adsPreview = e.target.checked; metaPut('adsPreview', adsPreview).catch(() => {}); };
  $('#numSel').onchange = e => { numbering = e.target.value; metaPut('numbering', numbering).catch(() => {}); };
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(est => { const el = $('#usage'); if (el && est.usage) el.textContent = tr(cloud.hid ? 'usageSync' : 'usage', Math.max(1, Math.round(est.usage / 1048576))); }).catch(() => {});
}
/* ---------- item page: name under the photo, place as a field, optional details ---------- */
let itemDraft = null, itemEdit = null, itemLeavePending = false, flushItem = null, shownOpt = new Set(), shownFor = null;
function itemLocation(id){ return boxes.find(b => (b.items || []).some(i => i.id === id)) || null; }
function itemRefs(it){ return [...(it.photos || []), ...(it.files || [])].map(x => x.ref).filter(Boolean); }
function persistEditedBoxes(state, currentBoxId){
  itemEdit = null;
  [state.boxId, currentBoxId].filter((id, i, all) => id && all.indexOf(id) === i).forEach(id => {
    const b = findBox(id); if (b) putBox(clone(b), true);
  });
}
function itemEditChanged(){
  if (!itemEdit) return false;
  const b = itemLocation(itemEdit.itemId), it = b && b.items.find(i => i.id === itemEdit.itemId);
  if (!it) return true;
  const original = clone(itemEdit.original), current = clone(it);
  delete original.updatedAt; delete current.updatedAt;
  return b.id !== itemEdit.boxId || JSON.stringify(original) !== JSON.stringify(current);
}
function commitItemEdit(){
  if (!itemEdit) return;
  const state = itemEdit, b = itemLocation(state.itemId), it = b && b.items.find(i => i.id === state.itemId);
  const currentRefs = new Set(it ? itemRefs(it) : []);
  const removedRefs = new Set(state.removedRefs);
  if (it) itemRefs(state.original).filter(ref => !currentRefs.has(ref)).forEach(ref => removedRefs.add(ref));
  if (state.isNew) itemDraft = null;
  persistEditedBoxes(state, b && b.id);
  [...removedRefs].filter(ref => !currentRefs.has(ref)).forEach(dropPhoto);
}
function discardItemEdit(){
  if (!itemEdit) return;
  const state = itemEdit, originalRefs = new Set(itemRefs(state.original));
  const currentBox = itemLocation(state.itemId), current = currentBox && currentBox.items.find(i => i.id === state.itemId);
  const newRefs = new Set(current ? itemRefs(current).filter(ref => !originalRefs.has(ref)) : []);
  for (const ref of state.removedRefs) if (!originalRefs.has(ref)) newRefs.add(ref);
  if (state.isNew){
    if (currentBox){ const removed = clone(currentBox); removed.items = removed.items.filter(i => i.id !== state.itemId); putBox(removed, true); }
    unlinkDocuments([state.itemId]);
    itemDraft = null;
  } else if (currentBox && currentBox.id !== state.boxId){
    const movedFrom = clone(currentBox); movedFrom.items = movedFrom.items.filter(i => i.id !== state.itemId); putBox(movedFrom, true);
  }
  const origin = state.isNew ? null : findBox(state.boxId);
  if (origin){
    const restored = clone(origin), index = restored.items.findIndex(i => i.id === state.itemId);
    if (index < 0) restored.items.push(clone(state.original)); else restored.items[index] = clone(state.original);
    putBox(restored, true);
    if (state.boxUpdatedAt !== undefined && findBox(state.boxId)) findBox(state.boxId).updatedAt = state.boxUpdatedAt;
  } else if (state.isNew && currentBox && state.boxUpdatedAt !== undefined){
    const restored = findBox(currentBox.id); if (restored) restored.updatedAt = state.boxUpdatedAt;
  }
  itemEdit = null;
  newRefs.forEach(dropPhoto);
}
function askItemSaveDecision(){
  return new Promise(resolve => {
    let done = false;
    const finish = choice => { if (done) return; done = true; resolve(choice); };
    openSheet(`<p style="margin:0 0 16px">${esc(tr('itemSaveQ'))}</p><div class="sheet-foot">
      <button class="btn quiet" data-itemleave="stay">${esc(tr('keepEditing'))}</button>
      <button class="btn danger" data-itemleave="discard">${esc(tr('discardChanges'))}</button>
      <button class="btn primary" data-itemleave="save">${esc(tr('saveChanges'))}</button></div>`, () => finish('stay'));
    sheet.querySelectorAll('[data-itemleave]').forEach(button => button.onclick = () => { finish(button.dataset.itemleave); closeSheet(); });
  });
}
async function prepareItemLeave(){
  if (!itemEdit || itemEdit.itemId !== view.itemId) return true;
  if (itemLeavePending) return false;
  if (flushItem) flushItem();
  if (!itemEditChanged()){ discardItemEdit(); flushItem = null; return true; }
  itemLeavePending = true;
  try {
    const choice = await askItemSaveDecision();
    if (choice === 'stay') return false;
    if (choice === 'discard') discardItemEdit();
    else {
      const [it] = curItem();
      if (!(it && (it.name || '').trim())){ toast(tr('nameFirst')); return false; }
      commitItemEdit();
    }
    flushItem = null;
    return true;
  } finally { itemLeavePending = false; }
}
function dropEditedAttachment(ref){
  if (itemEdit && itemEdit.itemId === view.itemId){ itemEdit.removedRefs.add(ref); return; }
  dropPhoto(ref);
}
function leaveItemPage(){
  const v = view;
  if (v.name === 'item' && flushItem){ try { flushItem(); } catch {} }
  flushItem = null;
  if (v.name !== 'item' || itemDraft !== v.itemId) return;
  const b = findBox(v.boxId), it = b && (b.items || []).find(i => i.id === v.itemId);
  if (it && !(it.name || '').trim()){ const nb = clone(b); nb.items = nb.items.filter(i => i.id !== it.id); putBox(nb, true); unlinkDocuments([it.id]); (it.photos || []).forEach(p => dropPhoto(p.ref)); (it.files || []).forEach(f => dropPhoto(f.ref)); if ((it.photos || []).length) toast(tr('discarded')); }
  itemDraft = null;
}
async function newItem(boxId, replace){
  if (view.name === 'item' && !(await prepareItemLeave())) return;
  leaveItemPage();
  const b = findBox(boxId); if (!b) return;
  const it = {id: newId(), name: '', category: '', value: '', storedOn: today(), notes: '', photos: [], tags: [], addedAt: new Date().toISOString(), addedBy: me || ''};
  itemDraft = it.id;
  itemEdit = {boxId, itemId: it.id, original: clone(it), boxUpdatedAt: b.updatedAt, removedRefs: new Set(), isNew: true};
  const nb = clone(b); nb.items = (nb.items || []).concat(it); putBox(nb, true);
  if (!replace) pushBack();
  view = {name: 'item', boxId, itemId: it.id};
  render(); window.scrollTo(0, 0); arm();
  setTimeout(() => { const n = $('#fName'); if (n) n.focus(); }, 80);
}
function itemSheet(boxId, itemId){ if (itemId) navigate({name: 'item', boxId, itemId}); else newItem(boxId); }
const OPT = ['size', 'brand', 'value', 'warranty', 'model', 'qty', 'owner', 'color', 'season', 'serial', 'category', 'spot', 'notes'];
const STATUSES = Object.keys(STATUS_KEYS);
function curItem(){ const b = findBox(view.boxId); const it = b && (b.items || []).find(i => i.id === view.itemId); return it ? [it, b] : [null, null]; }
function saveItem(mut, rerender){
  const [it, b] = curItem(); if (!it) return;
  const nb = clone(b), x = nb.items.find(i => i.id === it.id);
  mut(x); x.updatedAt = new Date().toISOString();
  putBox(nb, !rerender);
}
function hasVal(it, k){ return k === 'owner' ? !!(ownerNames(it).length || it.status || it.loanTo) : (it[k] !== undefined && it[k] !== null && String(it[k]).trim() !== ''); }
function finishItem(again){
  if (flushItem) flushItem();
  const [it, b] = curItem(); if (!it) return;
  if (!(it.name || '').trim()){ const nm = $('#fName'); if (nm){ nm.focus(); nm.classList.add('need'); } return toast(tr('nameFirst')); }
  flushItem = null;
  commitItemEdit();
  itemDraft = null;
  track('item_save', {photo: !!(it.photos || []).length, fields: Object.keys(it).length});
  toast(again ? tr('savedNext', it.name) : tr('saved'));
  if (again) return newItem(b.id, true);
  goBack();
}
async function cancelNewItem(){
  if (flushItem) flushItem();
  const [it, b] = curItem(); if (!it || itemDraft !== it.id) return;
  const hasDetails = Object.entries(it).some(([k, v]) => {
    if (['id', 'addedAt', 'addedBy', 'updatedAt', 'isNew'].includes(k)) return false;
    if (k === 'storedOn') return !!v && v !== today();
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return Object.keys(v).length > 0;
    return v !== null && v !== undefined && v !== false && v !== '';
  });
  if (hasDetails && !(await askConfirm(tr('discardNewItemQ'), tr('del')))) return;
  if (itemEdit && itemEdit.isNew) discardItemEdit();
  else {
    const nb = clone(b); nb.items = (nb.items || []).filter(x => x.id !== it.id); putBox(nb, true); unlinkDocuments([it.id]);
    [...(it.photos || []), ...(it.files || [])].forEach(p => dropPhoto(p.ref));
    itemDraft = null; itemEdit = null;
  }
  flushItem = null;
  goBack();
}
function cancelItem(){
  const [it] = curItem(); if (!it) return;
  if (itemDraft === it.id) return cancelNewItem();
  if (flushItem) flushItem();
  discardItemEdit();
  flushItem = null;
  goBack();
}
function moveItemTo(boxId, itemId, sel){
  const isCurrentItem = view.name === 'item' && view.itemId === itemId;
  if (isCurrentItem && itemEdit){ if (flushItem) flushItem(); flushItem = null; commitItemEdit(); }
  const b = findBox(boxId), it = b && (b.items || []).find(i => i.id === itemId); if (!it) return null;
  const destId = sel.startsWith('loose:') ? ensureLoose(sel.slice(6)).id : sel;
  if (destId === b.id) return b;
  snapshot([b.id, destId]);
  const from = clone(findBox(b.id)); from.items = from.items.filter(i => i.id !== itemId); putBox(from, true);
  const to = clone(findBox(destId)), moved = Object.assign(clone(it), {updatedAt: new Date().toISOString()}); if (!to.loose){ delete moved.spot; delete moved.zone; delete moved.stack; delete moved.level; }
  to.items = (to.items || []).concat(moved); putBox(to, true);
  if (isCurrentItem){
    view = {name: 'item', boxId: destId, itemId};
    const current = findBox(destId), movedItem = current && current.items.find(i => i.id === itemId);
    itemEdit = movedItem ? {boxId: destId, itemId, original: clone(movedItem), boxUpdatedAt: current.updatedAt, removedRefs: new Set()} : null;
  }
  toast(tr('movedTo', to.loose ? placeName(to.placeId) : to.code));
  return to;
}
function moveTargetsHTML(cur){
  const opt = (x, depth) => `<option value="${esc(x.id)}" ${x.id === cur.id ? 'selected' : ''}>${'\u2003'.repeat(depth)}${esc(placeName(x.placeId))} · ${esc(x.code)} ${esc(x.name)}</option>` + childBoxes(x.id).sort(byCode).map(c => opt(c, depth + 1)).join('');
  return places.map(p => `<optgroup label="${esc(p.name)}"><option value="loose:${esc(p.id)}" ${cur.loose && cur.placeId === p.id ? 'selected' : ''}>${esc(p.name)}, ${tr('notInBoxShort')}</option>
    ${topBoxesIn(p.id).sort(byCode).map(x => opt(x, 0)).join('')}</optgroup>`).join('');
}
function renderItem(){
  { const [it0, b0] = curItem(); if (it0 && it0.isNew) setTimeout(() => { const nb = clone(findBox(b0.id)), x = nb && (nb.items || []).find(i => i.id === it0.id); if (x && x.isNew){ delete x.isNew; putBox(nb, true); } }, 1500); }
  const [it, b] = curItem();
  if (shownFor !== it.id){ shownOpt = new Set(); shownFor = it.id; }
  const isNew = itemDraft === it.id;
  const show = k => hasVal(it, k) || shownOpt.has(k);
  const n = notifyAt(it), due = isDue(it), photos = it.photos || [];
  const linkedDocs = boxes.flatMap(owner => (owner.documents || []).filter(doc => doc.itemId === it.id).map(doc => ({doc, owner})));
  const input = (k, opts = {}) => `<div class="fl"><input data-f="${k}" value="${esc(opts.value !== undefined ? opts.value : (it[k] ?? ''))}" placeholder="${esc(tr('f_' + k))}" ${opts.attrs || ''}><label>${esc(tr('f_' + k))}</label></div>`;
  let status = it.status || '', loanTo = it.loanTo || '';
  const legacy = /^On loan \((.+)\)$/.exec(status); if (legacy){ status = 'On loan'; loanTo = loanTo || legacy[1]; }
  const field = k => {
    if (!show(k)) return '';
    if (k === 'value' || k === 'qty') return input(k, {attrs: `type="number" inputmode="numeric" min="${k === 'qty' ? 1 : 0}"`});
    if (k === 'brand') return input(k, {attrs: 'list="brands"'});
    if (k === 'color') return input(k, {value: showColor(it.color), attrs: 'list="colours"'});
    if (k === 'season') return input(k, {value: showSeason(it.season), attrs: 'list="seasons"'});
    if (k === 'serial') return input(k, {attrs: 'autocapitalize="characters"'});
    if (k === 'warranty') return input(k, {attrs: 'type="date"'}) + (it.warranty ? `<p class="wnote${daysTo(it.warranty) <= 30 ? ' soon' : ''}">${esc(tr('warrantyLeft', daysTo(it.warranty)))}</p>` : '');
    if (k === 'spot') return b.loose ? input(k) : '';
    if (k === 'notes') return `<div class="fl"><textarea data-f="notes" placeholder="${esc(tr('f_notes'))}">${esc(it.notes || '')}</textarea><label>${tr('f_notes')}</label></div>`;
    if (k === 'owner') return `<div class="fl group"><label class="always">${tr('f_owner')}</label>
      <div class="pair"><input data-f="owners" value="${esc(itemOwner(it))}" placeholder="${esc(tr('whose'))}" list="people" autocapitalize="words">
      <select data-f="status" aria-label="${esc(tr('status'))}">${statusOptions(status)}</select></div>
      ${status === 'On loan' ? `<input class="sub" data-f="loanTo" value="${esc(loanTo)}" placeholder="${esc(tr('loanTo'))}" list="people" autocapitalize="words">${loanFields(it)}` : ''}</div>`;
    return input(k);
  };
  const addable = OPT.filter(k => !show(k) && (k !== 'spot' || b.loose));
  const crumbParts = [crumbSpace(), crumbPlace(b.placeId)].concat(b.loose ? [] : [{label: b.code, nav: {name: 'box', boxId: b.id}}]);
  app.innerHTML = `${crumbs(crumbParts)}
    ${presenceNote(b.id, it.id)}
    <div class="hero">
      ${photos.length ? `<button class="heroimg" data-viewph="${esc(photos[0].ref)}">${imgTag(photos[0].ref, '')}</button>` : `<button class="heroimg empty" data-act="pickicon" aria-label="${esc(tr('pickIcon'))}"><span class="ticon">${guessIcon(it)}</span><span class="iconedit">${tr('pickIcon')}</span></button>`}
      <label class="cam" aria-label="${esc(tr('takePhoto'))}" title="${esc(tr('takePhoto'))}">${ICON.camera}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" capture="environment" id="fCamera" hidden></label>
      <label class="cam gallery" aria-label="${esc(tr('pickPhoto'))}" title="${esc(tr('pickPhoto'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM5 5h14v9l-3.5-3.5-4.5 5.5-3-3L5 17Zm3.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" id="fPhoto" multiple hidden></label>
    </div>
    ${photos.length ? `<div class="thumbs">${photos.map((p, i) => `<span class="th"><button data-viewph="${esc(p.ref)}">${imgTag(p.ref, '')}</button><button class="x" data-rmph="${i}" aria-label="${esc(tr('remove'))}">×</button></span>`).join('')}</div>` : ''}
    ${isOut(it) ? `<p class="outline"><span>↗ ${tr('outTag')} · ${esc(tr('outSince', it.out.since))}${it.out.until ? ' · ' + esc(tr('backBy', it.out.until)) : ''}</span><button class="linkbtn" data-act="itemback">↩ ${tr('putBack')}</button></p>` : ''}
    <div class="titlerow"><textarea class="title" id="fName" rows="1" placeholder="${esc(tr('whatIsIt'))}" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" required>${esc(it.name)}</textarea>
      ${isOut(it) ? '' : `<button class="iconbtn outbtn" data-act="itemout" aria-label="${esc(tr('takeOut'))}" title="${esc(tr('takeOut'))}">↗</button>`}<button class="iconbtn star" data-act="favitem" aria-label="${esc(it.fav ? tr('unfav') : tr('fav'))}" aria-pressed="${it.fav ? 'true' : 'false'}">${it.fav ? '★' : '☆'}</button></div>
    ${ai.provider !== 'off' && photos.length ? `<div class="aisug"><button class="btn quiet small" data-act="aisuggest" ${navigator.onLine ? '' : 'disabled'}>✨ ${tr('aiSuggest')}</button><span class="testtag">${tr('testTag')}</span></div>` : ''}
    <div class="whereline"><button class="pinbtn" data-mapbox="${esc(b.id)}" data-mapitem="${esc(b.loose ? it.id : '')}" aria-label="${esc(tr('showOnMap'))}">${ICON.pin}</button><span class="wtxt">${esc(b.loose ? placeName(b.placeId) + ' · ' + tr('notInBoxShort') : `${placeName(b.placeId)} · ${b.code} ${b.name}`)}</span><button class="linkbtn" data-act="moveitem2">${tr('move')}</button></div>
    <button class="linkbtn barcodebtn" data-act="scanbarcode">${ICON.barcode} ${tr('scanBarcode')}${it.ean ? ` <small>${esc(it.ean)}</small>` : ''}</button>
    ${OPT.map(field).join('')}
    ${addable.length ? `<div class="adddet"><span class="lab">${tr('addDetail')}</span><div class="chips">${addable.map(k => `<button class="chipbtn" data-addopt="${k}">+ ${esc(tr('f_' + k))}</button>`).join('')}</div></div>` : ''}
    <div class="fl"><input data-f="lastUsed" type="date" value="${esc(it.lastUsed || '')}"><label class="always">${tr('lastUsed')}</label></div>
    ${remindFields(it)}
    ${n ? `<p class="notifyrow"><span class="notify${due ? ' due' : ''}">${esc(tr('notify', n))}${dot(due)}</span><button class="linkbtn" data-act="ics">${tr('toCalendar')}</button></p>` : ''}
    <div class="fl att"><label class="always">${tr('attachments')}</label>
      ${(it.files || []).map((f, i) => `<div class="attrow"><span>${esc(f.name)}</span><button data-viewfile="${i}" aria-label="${esc(f.name)}">${ICON.eye}</button><button class="x" data-rmfile="${i}" aria-label="${esc(tr('remove'))}">×</button></div>`).join('')}
      <div><label class="addfile">${tr('addAttach')}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" id="fFile" hidden></label></div></div>
    ${linkedDocs.length ? `<div class="fl att"><label class="always">${tr('linkedDocuments')}</label>${linkedDocs.map(({doc, owner}) => `<div class="attrow"><span>${esc(doc.name)} · ${esc(owner.loose ? placeName(owner.placeId) : `${owner.code} ${owner.name}`)}</span><button data-doc-open="${esc(doc.id)}" data-doc-box="${esc(owner.id)}" aria-label="${esc(doc.name)}">${ICON.eye}</button></div>`).join('')}</div>` : ''}
    <div class="tags"><span class="lab">${tr('tags')}</span>${(it.tags || []).map((t, i) => `<span class="tag"><button class="tagopen" data-coll="${esc(String(t).toLowerCase())}">${esc(t)}</button><button class="tagx" data-rmtag="${i}" aria-label="${esc(tr('remove'))}">×</button></span>`).join('')}<button class="tag plus" data-act="addtag" aria-label="${esc(tr('newTag'))}">+</button></div>
    <button class="btn quiet block" data-act="sharewhere">${tr('share')}</button>
    ${adSlot('card')}
    <p class="proof">${[it.addedAt ? tr('registered', fmtStamp(it.addedAt), it.addedBy) : '', (it.storedOn || it.addedAt) ? tr('storedSince', it.storedOn || fmtDate(it.addedAt)) : '', it.updatedAt ? tr('changed', fmtStamp(it.updatedAt)) : ''].filter(Boolean).map(esc).join(' ')}</p>
    ${isNew ? '' : `<button class="btn danger block" data-act="delitem">${tr('delItem')}</button>`}
    <div class="donebar${isNew ? ' newitembar' : ' edititembar'}"><button class="btn quiet" data-act="cancelitem">${tr('cancel')}</button>${isNew ? `<button class="btn quiet" data-act="saveagain">${tr('saveAnother')}</button>` : ''}<button class="btn primary" data-act="done">${tr('save')}</button></div>
    <datalist id="people">${ownerSuggestions(b.placeId, it).map(p => `<option value="${esc(p === 'Shared' ? tr('shared') : p)}">`).join('')}</datalist>
    <datalist id="colours">${COLORS.map(c => `<option value="${esc(showColor(c))}">`).join('')}</datalist>
    <datalist id="seasons">${SEASONS.map(c => `<option value="${esc(showSeason(c))}">`).join('')}</datalist>
    <datalist id="brands">${recentValues('brand').map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;
  const timers = {};
  const conv = (k, v) => {
    v = typeof v === 'string' ? v.trim() : v;
    if (k === 'owners' && v) return String(v).split(/[,;]+/).map(n => n.trim()).filter(Boolean).map(n => n.toLowerCase() === tr('shared').toLowerCase() || n.toLowerCase() === 'shared' ? 'Shared' : addPerson(cap(n)));
    if (k === 'loanTo' && v) return addPerson(cap(v));
    if (k === 'color') return fromColor(v);
    if (k === 'season') return fromSeason(v);
    if (k === 'size' && v){ const c = cleanSize(v); return c.ok ? c.v : v; }
    return v;
  };
  const commit = (k, v) => saveItem(x => {
    if (k === 'name'){ v = (v || '').trim(); if (v) x.name = cap(v); return; }
    if (k === 'value' || k === 'qty'){ if (v === '' || isNaN(+v)) delete x[k]; else x[k] = Math.max(0, +v); return; }
    if (k === 'remindMonths'){ if (+v) x.remindMonths = +v; else delete x.remindMonths; return; }
    v = conv(k, v);
    if (k === 'owners'){
      setItemOwners(x, v);
      return;
    }
    if (k === 'status' && v !== 'On loan'){ delete x.loanTo; delete x.loanSince; }
    if (k === 'status' && v === 'On loan'){ if (!x.loanSince) x.loanSince = today(); if (!x.loanDue) x.loanDue = addDays(x.loanSince, 30); }
    if (k === 'status' && v !== 'On loan') delete x.loanDue;
    if (v === '' || v == null) delete x[k]; else x[k] = v;
  }, false);
  const RERENDER = ['remindMonths', 'remindAt', 'lastUsed', 'status', 'warranty', 'loanSince', 'loanDue'];
  flushItem = () => {
    Object.keys(timers).forEach(k => clearTimeout(timers[k]));
    const [x] = curItem(); if (!x) return;
    const nm2 = $('#fName'); if (nm2 && nm2.value.trim() && nm2.value.trim() !== x.name) commit('name', nm2.value);
    app.querySelectorAll('[data-f]').forEach(el => {
      const k = el.dataset.f, [y] = curItem(); if (!y) return;
      const cur = k === 'color' ? showColor(y.color) : k === 'season' ? showSeason(y.season) : k === 'owners' ? itemOwner(y) : String(y[k] ?? (k === 'remindMonths' ? 0 : ''));
      if (String(el.value) !== cur) commit(k, el.value);
    });
  };
  app.querySelectorAll('[data-f]').forEach(el => {
    const k = el.dataset.f;
    el.addEventListener('input', () => { if (el.tagName === 'SELECT' || k === 'owners') return; clearTimeout(timers[k]); timers[k] = setTimeout(() => commit(k, el.value), 700); });
    el.addEventListener('change', async () => {
      clearTimeout(timers[k]);
      if (k === 'status' && el.value === '__custom__'){
        const custom = await askText(tr('customStatus'), {value: status && !STATUS_KEYS[status] ? status : '', placeholder: tr('customStatus'), ok: tr('save')});
        if (custom && custom.trim()) commit('status', custom.trim());
        render();
        return;
      }
      if (RERENDER.includes(k)){
        flushItem(); render();
        if (k === 'remindAt' && el.value) reminderPermissionNudge();
      } else commit(k, el.value);
    });
  });
  const nm = $('#fName');
  const fitName = () => { nm.style.height = 'auto'; nm.style.height = nm.scrollHeight + 'px'; };
  requestAnimationFrame(fitName);
  nm.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); nm.blur(); } });
  nm.addEventListener('input', () => { if (/\n/.test(nm.value)) nm.value = nm.value.replace(/\s*\n\s*/g, ' '); fitName(); clearTimeout(timers.name); timers.name = setTimeout(() => commit('name', nm.value), 600); });
  nm.addEventListener('change', () => { clearTimeout(timers.name); commit('name', nm.value); });
  if (app.querySelector('[data-where]')) app.querySelector('[data-where]').addEventListener('change', e => { if (flushItem) flushItem(); moveItemTo(view.boxId, view.itemId, e.target.value); render(); });
  const addPhotos = async e => {
    const files = [...e.target.files]; e.target.value = ''; if (!files.length) return; toast(tr('savingPhoto'));
    const target = {boxId: view.boxId, itemId: view.itemId};
    if (flushItem) flushItem();
    const added = [];
    for (const f of files){ try { added.push(await storePhoto(f)); } catch (err){ toast(saveErr(err)); } }
    if (!added.length) return;
    const b = itemLocation(target.itemId), it = b && (b.items || []).find(x => x.id === target.itemId);
    if (!it){ added.forEach(p => dropPhoto(p.ref)); toast(tr('photoUploadCancelled')); return; }
    const nb = clone(b), item = nb.items.find(x => x.id === target.itemId);
    item.photos = (item.photos || []).concat(added); item.updatedAt = new Date().toISOString(); putBox(nb, true);
    if (view.name === 'item' && view.boxId === b.id && view.itemId === target.itemId) render();
  };
  $('#fPhoto').addEventListener('change', addPhotos);
  $('#fCamera').addEventListener('change', addPhotos);
  $('#fFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const target = {boxId: view.boxId, itemId: view.itemId};
      if (flushItem) flushItem();
      const {ref, type} = await storeUpload(f);
      const b = itemLocation(target.itemId), it = b && (b.items || []).find(x => x.id === target.itemId);
      if (!it){ dropPhoto(ref); toast(tr('photoUploadCancelled')); return; }
      const nb = clone(b), item = nb.items.find(x => x.id === target.itemId);
      item.files = (item.files || []).concat({ref, name: f.name.replace(/\.[^.]+$/, '') || tr('attachments'), type, addedAt: new Date().toISOString()});
      item.updatedAt = new Date().toISOString(); putBox(nb, true);
      if (view.name === 'item' && view.boxId === b.id && view.itemId === target.itemId) render();
    } catch (err){ toast(saveErr(err)); }
  });
}
async function openFile(f){
  const blob = await phGet(f.ref).catch(() => null); if (!blob) return toast(tr('fileMissing'));
  if (await imageSignature(blob)) return openViewer(f.ref);
  try { await validatePdfUpload(blob); } catch { return toast(tr('uploadUnsafeType')); }
  const u = URL.createObjectURL(blob);
  window.open(u, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
/* ---------- batch: several items from photos, with AI recognition when it's on ---------- */
let batch = null;
function openBatch(boxId){
  if (batch){ const previous = batch; batch = null; previous.refs.forEach(dropPhoto); }
  batch = {boxId, mode: null, rows: [], busy: 0, refs: new Set()};
  navigate({name: 'batch', boxId});
}
const blobToB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(b); });
function visionPrompt(mode){
  const l = lang === 'sv' ? 'Swedish' : 'English';
  return `You look at a photo of things someone is putting into storage, for a home inventory app.
${mode === 'multi' ? 'The photo shows SEVERAL separate things. Return each separate thing as its own item, max 20. Group many identical small things into one item (for example "Batteries, about 20").' : 'The photo shows ONE main thing. Return exactly one item for it.'}
Return ONLY JSON: {"items":[{"name":"","category":"","color":"","brand":"","model":"","size":"","text_seen":"","condition":"","value_sek":null,"box_2d":[ymin,xmin,ymax,xmax]}]}
- name: short and specific, in ${l}, for example "${lang === 'sv' ? 'Röd skidjacka' : 'Red ski jacket'}".
- category: one or two words in ${l}.
- color: one of Black, White, Grey, Blue, Red, Green, Yellow, Pink, Purple, Brown, Beige, Multicolour, or "".
- brand, model, size: only if clearly visible on a logo, tag or label, otherwise "".
- text_seen: other useful printed text such as a serial number or a book title, otherwise "".
- condition: in ${l}, a few words, or "".
- value_sek: a rough second-hand value in Swedish kronor, or null if unsure.
- box_2d: the item's position, with coordinates normalised to 0-1000.`;
}
async function recogniseRow(rows, ref, mode){
  const blob = await phGet(ref);
  const cv = await shrink(blob, 1024), small = await toBlob(cv, 'image/jpeg', .8);
  const text = await callAI(visionPrompt(mode), mode === 'multi' ? 'List the separate things in this photo.' : 'What is this?', {images: [{mime: 'image/jpeg', data: await blobToB64(small)}], timeout: 60000});
  const s = String(text || '').replace(/```(?:json)?/gi, ''), i = s.indexOf('{'), j = s.lastIndexOf('}');
  const out = JSON.parse(s.slice(i, j + 1)); return Array.isArray(out.items) ? out.items : [];
}
async function cropRef(ref, box, session){
  if (!Array.isArray(box) || box.length !== 4) return null;
  const blob = await phGet(ref), bmp = await createImageBitmap(blob);
  let [y0, x0, y1, x1] = box.map(v => Math.max(0, Math.min(1000, +v || 0)) / 1000);
  if (y1 <= y0 || x1 <= x0) { bmp.close && bmp.close(); return null; }
  const pw = (x1 - x0) * .08, ph = (y1 - y0) * .08;
  x0 = Math.max(0, x0 - pw); y0 = Math.max(0, y0 - ph); x1 = Math.min(1, x1 + pw); y1 = Math.min(1, y1 + ph);
  const sx = x0 * bmp.width, sy = y0 * bmp.height, sw = (x1 - x0) * bmp.width, sh = (y1 - y0) * bmp.height;
  if (sw < 24 || sh < 24) { bmp.close && bmp.close(); return null; }
  const cv = document.createElement('canvas'); cv.width = Math.round(sw); cv.height = Math.round(sh);
  cv.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, cv.width, cv.height); bmp.close && bmp.close();
  const out = await toBlob(cv, 'image/webp', PHOTO_QUALITY) || await toBlob(cv, 'image/jpeg', .8);
  const r = newId(); await phPut(r, out);
  if (batch !== session){ await phDel(r); return null; }
  session.refs.add(r); return r;
}
function fieldsFromAI(x){
  const f = {};
  if (x.category) f.category = String(x.category).trim();
  if (x.color){ const c = fromColor(String(x.color)); if (COLORS.includes(c)) f.color = c; }
  if (x.brand) f.brand = String(x.brand).trim();
  if (x.model) f.model = String(x.model).trim();
  if (x.size){ const c = cleanSize(String(x.size)); if (c.ok) f.size = c.v; }
  const notes = [x.text_seen, x.condition].map(v => String(v || '').trim()).filter(Boolean);
  if (notes.length) f.notes = notes.join('. ');
  if (x.value_sek !== null && x.value_sek !== undefined && !isNaN(+x.value_sek) && +x.value_sek > 0) f.value = Math.round(+x.value_sek);
  return f;
}
async function addBatchFiles(files, mode){
  if (!batch) return;
  const session = batch;
  session.mode = mode;
  const useAI = aiReady();
  for (const file of files){
    let p; try { p = await storePhoto(file); } catch (e){ if (batch !== session) return; toast(saveErr(e)); continue; }
    if (batch !== session){ await phDel(p.ref); return; }
    session.refs.add(p.ref);
    const row = {id: newId(), name: '', photos: [p], fields: {}, include: true, status: useAI ? 'thinking' : 'ready', src: p.ref};
    session.rows.push(row); render();
    if (!useAI) continue;
    session.busy++;
    try {
      const found = await recogniseRow(session.rows, p.ref, mode);
      if (batch !== session) return;
      if (mode === 'multi' && found.length > 1){
        const at = session.rows.indexOf(row), made = [];
        for (const x of found){
          if (batch !== session) return;
          const c = await cropRef(p.ref, x.box_2d, session);
          if (batch !== session) return;
          made.push({id: newId(), name: cap(String(x.name || '').trim()), photos: c ? [{ref: c, takenAt: p.takenAt, addedAt: p.addedAt}, p] : [p], fields: fieldsFromAI(x), include: true, status: 'ready', src: p.ref});
        }
        session.rows.splice(at, 1, ...made);
        toast(tr('batchFound', made.length));
      } else if (found.length){
        row.name = cap(String(found[0].name || '').trim()); row.fields = fieldsFromAI(found[0]); row.status = 'ready';
      } else row.status = 'ready';
    } catch (e){ if (batch !== session) return; row.status = 'failed'; row.err = aiErrorText(e); }
    finally { session.busy--; if (batch === session && view.name === 'batch') render(); }
  }
}
function renderBatch(){
  if (!batch || batch.boxId !== view.boxId) batch = {boxId: view.boxId, mode: null, rows: [], busy: 0, refs: new Set()};
  const b = findBox(batch.boxId);
  const where = b.loose ? `${placeName(b.placeId)}, ${tr('notInBoxShort')}` : `${b.code} ${b.name}`;
  const crumbParts = [crumbSpace(), crumbPlace(b.placeId)].concat(b.loose ? [] : [{label: b.code, nav: {name: 'box', boxId: b.id}}]);
  const rows = batch.rows, n = rows.filter(r => r.include && r.status !== 'thinking').length;
  const missing = rows.some(r => r.include && r.status !== 'thinking' && !(r.name || '').trim());
  const detail = f => [showColor(f.color), f.brand, f.size && (lang === 'sv' ? 'stl ' : 'size ') + f.size, f.value && kr(f.value), f.category].filter(Boolean).map(esc).join(' · ');
  app.innerHTML = `${crumbs(crumbParts)}
    <h2 class="pagetitle">${tr('batchTitle')}</h2>
    <p class="hint">${esc(tr('batchWhere', where))}</p>
    <p class="hint">${aiReady() ? tr('batchAI') + (ai.provider === 'gemini' ? ' ' + tr('batchPrivacy') : '') : tr('batchNoAI')}</p>
    ${!rows.length ? `<div class="choice col">
      <label class="btn primary big">${ICON.camera}<span>${tr('modeEach')}</span><small>${tr('modeEachHint')}</small><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden data-batchmode="each"></label>
      <label class="btn primary big">${ICON.box}<span>${tr('modeMulti')}</span><small>${tr('modeMultiHint')}</small><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden data-batchmode="multi"></label></div>`
    : `<div class="brows">${rows.map((r, i) => `<div class="brow${r.include ? '' : ' off'}">
        <button class="bthumb" data-viewph="${esc(r.photos[0].ref)}">${imgTag(r.photos[0].ref, '')}</button>
        <div class="bmain">${r.status === 'thinking' ? `<p class="hint">${tr('thinking')}</p>` : `<input class="input" data-bname="${i}" value="${esc(r.name)}" placeholder="${esc(tr('namePh'))}" autocapitalize="sentences">
          ${detail(r.fields) ? `<p class="bdet">${detail(r.fields)}</p>` : ''}${r.status === 'failed' ? `<p class="hint">${esc(tr('aiFailed', r.err || ''))}</p>` : ''}`}</div>
        <label class="binc"><input type="checkbox" data-binc="${i}" ${r.include ? 'checked' : ''}><span>${tr('include')}</span></label></div>`).join('')}</div>
      <label class="btn quiet block morebtn">${tr('morePhotos')}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden data-batchmode="${batch.mode || 'each'}"></label>`}
    <div class="donebar"><button class="btn quiet" data-act="batchcancel">${tr('cancel')}</button><button class="btn primary" data-act="batchadd" ${n && !batch.busy && !missing ? '' : 'disabled'}>${tr('addN', n)}</button></div>${missing && n ? `<p class="hint needname">${tr('nameNeeded')}</p>` : ''}`;
  app.querySelectorAll('[data-batchmode]').forEach(inp => inp.addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addBatchFiles(f, inp.dataset.batchmode); }));
  app.querySelectorAll('[data-bname]').forEach(inp => { inp.classList.toggle('need', !inp.value.trim()); inp.addEventListener('input', () => {
    const r = batch.rows[+inp.dataset.bname]; if (r) r.name = inp.value; inp.classList.toggle('need', !inp.value.trim());
    const miss = batch.rows.some(x => x.include && x.status !== 'thinking' && !(x.name || '').trim()), btn = app.querySelector('[data-act=batchadd]');
    if (btn) btn.disabled = miss || !batch.rows.some(x => x.include && x.status !== 'thinking') || !!batch.busy;
    const h = app.querySelector('.needname'); if (h) h.hidden = !miss;
  }); });
  app.querySelectorAll('[data-binc]').forEach(c => c.addEventListener('change', () => { const r = batch.rows[+c.dataset.binc]; if (r){ r.include = c.checked; render(); } }));
}
function finishBatch(add){
  if (!batch) return;
  const session = batch, b = findBox(session.boxId), used = new Set();
  let count = 0;
  if (add && b){
    const nb = clone(b), now = new Date().toISOString();
    session.rows.forEach(r => {
      if (!r.include || r.status === 'thinking') return;
      if (!(r.name || '').trim()) return;
      const it = Object.assign({id: newId(), name: cap((r.name || '').trim()), category: '', value: '', storedOn: today(), notes: '', photos: r.photos, tags: [], addedAt: now, addedBy: me || ''}, r.fields);
      nb.items = (nb.items || []).concat(it); r.photos.forEach(p => used.add(p.ref)); count++;
    });
    snapshot([b.id]); putBox(nb, true);
  }
  const refs = [...session.refs];
  batch = null;
  refs.forEach(r => { if (!used.has(r)) dropPhoto(r); });
  if (count) toast(tr('batchAdded', count));
  if (!goUp()) go({name: 'home', place: currentPlace});
}

/* ---------- test: recognise a single item from its photo ---------- */
async function suggestFromPhoto(){
  if (flushItem) flushItem();
  const [it] = curItem(); if (!it) return;
  const p = (it.photos || [])[0]; if (!p) return toast(tr('aiNeedPhoto'));
  if (!aiReady()) return aiSheet();
  const btn = app.querySelector('[data-act=aisuggest]'); if (btn){ btn.disabled = true; btn.textContent = tr('aiLooking'); }
  let found;
  try { found = (await recogniseRow(null, p.ref, 'single'))[0]; }
  catch (e){ toast(aiErrorText(e)); render(); return; }
  if (!found){ toast(tr('aiNothing')); render(); return; }
  const sug = Object.assign({name: cap(String(found.name || '').trim())}, fieldsFromAI(found));
  const shown = k => k === 'color' ? showColor(sug[k]) : k === 'value' ? kr(sug[k]) : sug[k];
  const cur = k => k === 'color' ? showColor(it[k]) : k === 'value' ? (it[k] ? kr(it[k]) : '') : (it[k] || '');
  const keys = ['name', 'category', 'color', 'brand', 'model', 'size', 'value', 'notes'].filter(k => sug[k] !== undefined && sug[k] !== '' && String(sug[k]) !== String(it[k] ?? ''));
  if (!keys.length){ toast(tr('aiNothing')); render(); return; }
  const label = k => k === 'name' ? tr('namePh') : tr('f_' + k);
  openSheet(`<h3>✨ ${tr('aiSuggestH')} <span class="testtag">${tr('testTag')}</span></h3>
    <p class="hint">${tr('aiSuggestHint')}</p>
    <div class="sugs">${keys.map(k => `<label class="sug"><input type="checkbox" data-sk="${k}" ${cur(k) ? '' : 'checked'}>
      <span><b>${esc(label(k))}</b><br>${esc(shown(k))}${cur(k) ? `<br><small>${esc(tr('aiNow', cur(k)))}</small>` : ''}</span></label>`).join('')}</div>
    <div class="sheet-foot"><button class="btn quiet" id="sgX">${tr('cancel')}</button><button class="btn primary" id="sgOk">${tr('apply')}</button></div>`, () => render());
  $('#sgX').onclick = closeSheet;
  $('#sgOk').onclick = () => {
    const pick = [...sheet.querySelectorAll('[data-sk]:checked')].map(c => c.dataset.sk);
    if (pick.length) saveItem(x => { pick.forEach(k => { x[k] = sug[k]; }); if (pick.some(k => !['name', 'notes', 'value'].includes(k))) shownOpt = new Set([...shownOpt, ...pick]); });
    toast(tr('aiApplied', pick.length)); closeSheet();
  };
}

/* ---------- sharing ---------- */
function whereText(it, b){
  const chain = b.loose ? [] : [...boxChain(b), b].map(x => `${x.code} ${x.name}`);
  const parts = [placeName(b.placeId), ...chain].filter(Boolean).join(' › ');
  return `${it.name}: ${parts}${b.loose ? ` (${tr('notInBoxShort')}${it.spot ? ', ' + it.spot : ''})` : ''}`;
}
async function shareWhere(it, b){
  const text = whereText(it, b) + ' (Storrrage)';
  try { if (navigator.share){ await navigator.share({text}); return; } } catch (e){ if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast(tr('copied')); } catch { toast(text); }
}
async function sharePlaceCopy(pid){
  const p = findPlace(pid); if (!p) return;
  toast(tr('loadingLib'));
  const bx = boxes.filter(b => b.placeId === pid), photos = {};
  const refs = bx.flatMap(b => [b.photo && b.photo.ref, ...(b.documents || []).map(d => d.ref), ...(b.items || []).flatMap(i => [...(i.photos || []).map(x => x.ref), ...(i.files || []).map(f => f.ref)])]).filter(Boolean);
  for (const ref of refs){ const blob = await phGet(ref).catch(() => null); if (blob) photos[ref] = await blobToDataURL(blob); }
  const json = JSON.stringify({app: 'boxes', version: 3, kind: 'place-copy', exportedAt: new Date().toISOString(), places: [p], boxes: bx, photos, household});
  deliver(`storrrage-${p.name.toLowerCase().replace(/[^a-z0-9åäö]+/g, '-')}-${today()}.json`, new Blob([json], {type: 'application/json'}), tr('shareCopy'));
  setTimeout(() => { const h = sheet.querySelector('.hint'); if (h) h.insertAdjacentHTML('afterend', `<p class="proof">${esc(tr('shareCopyHint'))}</p>`); }, 50);
}

/* ---------- export to Excel, Word or PDF ---------- */
const loadScript = src => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load')); document.head.appendChild(s); });
function exportRows(pid){
  const rows = [];
  const order = places.filter(p => !pid || p.id === pid);
  for (const p of order){
    const bx = boxes.filter(b => b.placeId === p.id).sort((x, y) => (x.loose ? -1 : 0) - (y.loose ? -1 : 0) || byCode(x, y));
    for (const b of bx) for (const it of [...(b.items || [])].sort(byName)){
      const parent = !b.loose && b.parentId && findBox(b.parentId);
      rows.push({
        [tr('col_place')]: p.name, [tr('col_box')]: b.loose ? tr('notInBox') : `${b.code} ${b.name}`, [tr('col_inbox')]: parent ? `${parent.code} ${parent.name}` : '',
        [tr('col_item')]: it.name, [tr('col_cat')]: it.category || '', [tr('col_brand')]: it.brand || '', [tr('col_model')]: it.model || '', [tr('col_size')]: it.size || '',
        [tr('col_color')]: showColor(it.color), [tr('col_owner')]: itemOwner(it), [tr('col_status')]: [showStatus(it.status), it.loanTo].filter(Boolean).join(' '),
        [tr('col_qty')]: it.qty || '', [tr('col_value')]: it.value ? +it.value : '', [tr('col_stored')]: it.storedOn || '', [tr('col_used')]: it.lastUsed || '',
        [tr('col_serial')]: it.serial || '', [tr('col_tags')]: (it.tags || []).join(', '), [tr('col_notes')]: it.notes || '',
      });
    }
  }
  return rows;
}
function exportSheet(){
  openSheet(`<h3>${tr('exportH')}</h3><p class="hint">${tr('exportHint')}</p>
    <label class="field"><span>${tr('scope')}</span><select id="exScope"><option value="">${tr('exportAll')}</option>${places.map(p => `<option value="${esc(p.id)}" ${scopePlace() === p.id && places.length > 1 ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <div class="menu"><button class="btn quiet" data-ex="xlsx">${tr('excel')}</button><button class="btn quiet" data-ex="doc">${tr('word')}</button><button class="btn quiet" data-ex="pdf">${tr('pdf')}</button>
    <button class="btn quiet" data-ex="report">${tr('insurance')}</button><button class="btn" data-ex="x">${tr('close')}</button></div>
    <p class="proof">${tr('needNet')}</p>`);
  sheet.querySelector('.menu').onclick = async e => {
    const t = e.target.closest('[data-ex]'); if (!t) return; const k = t.dataset.ex;
    if (k === 'x') return closeSheet();
    if (k === 'report') return insuranceReport();
    const pid = $('#exScope').value || null, rows = exportRows(pid);
    if (!rows.length) return toast(tr('nothingHere'));
    const base = `storrrage-${tr('listTitle').toLowerCase().replace(/\s+/g, '-')}-${today()}`;
    toast(tr('loadingLib'));
    try {
      if (k === 'xlsx'){
        await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        const ws = XLSX.utils.json_to_sheet(rows), cols = Object.keys(rows[0]);
        ws['!cols'] = cols.map(c => ({wch: Math.min(40, Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)) + 2)}));
        ws['!autofilter'] = {ref: XLSX.utils.encode_range({s: {r: 0, c: 0}, e: {r: rows.length, c: cols.length - 1}})};
        ws['!freeze'] = {xSplit: 0, ySplit: 1};
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, tr('listTitle').slice(0, 31));
        const out = XLSX.write(wb, {bookType: 'xlsx', type: 'array'});
        deliver(base + '.xlsx', new Blob([out], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), tr('excel'));
      } else if (k === 'doc'){
        const cols = Object.keys(rows[0]).filter(c => rows.some(r => r[c] !== '' && r[c] != null));
        const groups = {}; rows.forEach(r => { const g = r[tr('col_place')]; (groups[g] = groups[g] || []).push(r); });
        const total = rows.reduce((s, r) => s + (+r[tr('col_value')] || 0), 0);
        const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(tr('listTitle'))}</title>
          <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
          <style>@page{size:A4 landscape;margin:1.5cm}body{font-family:Calibri,Arial,sans-serif;font-size:9pt}h1{font-size:16pt;color:#2F1160}h2{font-size:12pt;color:#2F1160;margin-top:14pt}
          table{border-collapse:collapse;width:100%}th{background:#2F1160;color:#fff;text-align:left;padding:3pt}td{border-bottom:1px solid #ccc;padding:3pt;vertical-align:top}</style></head><body>
          <h1>${esc(tr('listTitle'))}</h1><p>${esc(fmtStamp(new Date().toISOString()))}. ${rows.length} ${esc(tr('items'))}${total ? `, ${esc(tr('total'))} ${esc(kr(total))}` : ''}.</p>
          ${Object.entries(groups).map(([g, rs]) => `<h2>${esc(g)}</h2><table><tr>${cols.filter(c => c !== tr('col_place')).map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rs.map(r => `<tr>${cols.filter(c => c !== tr('col_place')).map(c => `<td>${esc(c === tr('col_value') && r[c] ? kr(r[c]) : r[c])}</td>`).join('')}</tr>`).join('')}</table>`).join('')}</body></html>`;
        deliver(base + '.doc', new Blob(['\ufeff' + html], {type: 'application/msword'}), tr('word'));
      } else if (k === 'pdf'){
        await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
        const doc = new window.jspdf.jsPDF({orientation: 'landscape', unit: 'pt', format: 'a4'});
        const keep = [tr('col_box'), tr('col_item'), tr('col_cat'), tr('col_brand'), tr('col_size'), tr('col_color'), tr('col_owner'), tr('col_status'), tr('col_qty'), tr('col_value'), tr('col_stored')];
        const total = rows.reduce((s, r) => s + (+r[tr('col_value')] || 0), 0);
        doc.setFontSize(16); doc.setTextColor(47, 17, 96); doc.text(tr('listTitle'), 40, 40);
        doc.setFontSize(9); doc.setTextColor(90); doc.text(`${fmtStamp(new Date().toISOString())}. ${rows.length} ${tr('items')}${total ? `, ${tr('total')} ${kr(total)}` : ''}.`, 40, 56);
        let y = 72;
        const groups = {}; rows.forEach(r => { const g = r[tr('col_place')]; (groups[g] = groups[g] || []).push(r); });
        for (const [g, rs] of Object.entries(groups)){
          doc.setFontSize(12); doc.setTextColor(47, 17, 96); doc.text(g, 40, y + 14);
          doc.autoTable({startY: y + 20, head: [keep], body: rs.map(r => keep.map(c => c === tr('col_value') && r[c] ? kr(r[c]) : String(r[c] ?? ''))),
            styles: {fontSize: 8, cellPadding: 3}, headStyles: {fillColor: [47, 17, 96]}, alternateRowStyles: {fillColor: [245, 244, 251]}, margin: {left: 40, right: 40}});
          y = doc.lastAutoTable.finalY + 16;
        }
        deliver(base + '.pdf', doc.output('blob'), tr('pdf'));
      }
    } catch (err){ toast(tr('needNet')); }
  };
}

/* ---------- select several items in a box: move or delete together ---------- */
/* ---------- show on the map: highlight boxes (and loose things) ---------- */
function showOnMap(boxIds, itemIds, back){
  const first = (boxIds || []).map(findBox).find(Boolean) || null;
  let pid = first ? first.placeId : null;
  if (!pid && (itemIds || []).length){ const hit = boxes.find(b => b.loose && (b.items || []).some(i => itemIds.includes(i.id))); pid = hit && hit.placeId; }
  if (!pid) return;
  // a box inside another box is shown by highlighting the outermost box on the map
  const top = id => { let b = findBox(id), g = 0; while (b && b.parentId && findBox(b.parentId) && g++ < 10) b = findBox(b.parentId); return b ? b.id : id; };
  setPlace(pid);
  navigate({name: 'mapfocus', place: pid, hlBoxes: [...new Set((boxIds || []).map(top))], hlItems: itemIds || [], back: back || clone(view)});
}
function scrollToHighlight(){ setTimeout(() => { const el = app.querySelector('.hl'); if (el) el.scrollIntoView({block: 'center', behavior: 'smooth'}); }, 60); }

/* ---------- collections: one tag on several things, across boxes ---------- */
function collectionsAll(){
  const m = new Map();
  boxes.forEach(b => (b.items || []).forEach(it => (it.tags || []).forEach(t => { const k = String(t).toLowerCase(); if (!m.has(k)) m.set(k, []); m.get(k).push([it, b]); })));
  return [...m.entries()].map(([tag, list]) => ({tag, list, boxes: new Set(list.map(([, b]) => b.id)).size})).sort((x, y) => y.list.length - x.list.length || x.tag.localeCompare(y.tag, 'sv'));
}
const tagLabel = t => cap(String(t));
function collectionChips(filter){
  const cs = collectionsAll().filter(c => !filter || c.tag.includes(filter.toLowerCase()) || nearWord(filter.toLowerCase(), [c.tag]));
  if (!cs.length) return '';
  return `<div class="colls"><span class="lab">${tr('collections')}</span><div class="chips">${cs.slice(0, 20).map(c => `<button class="chipbtn coll" data-coll="${esc(c.tag)}">#${esc(tagLabel(c.tag))} <small>${c.list.length}</small></button>`).join('')}</div></div>`;
}
function renderCollection(tag){
  const c = collectionsAll().find(x => x.tag === tag);
  if (!c){ app.innerHTML = `<p class="hint center">${tr('nothingHere')}</p>`; return; }
  const byBox = new Map(); c.list.forEach(([it, b]) => { if (!byBox.has(b.id)) byBox.set(b.id, []); byBox.get(b.id).push(it); });
  const groups = [...byBox.entries()].map(([id, its]) => [findBox(id), its]).sort((x, y) => placeName(x[0].placeId).localeCompare(placeName(y[0].placeId), 'sv') || (x[0].loose ? 1 : 0) - (y[0].loose ? 1 : 0) || byCode(x[0], y[0]));
  const placesIn = [...new Set(groups.map(([b]) => b.placeId))];
  app.innerHTML = `<div class="bhead"><p class="tagline">${tr('collection').toUpperCase()}</p><h1 class="btitle"><span class="bname">#${esc(tagLabel(tag))}</span></h1>
      <p class="bpath">${tr('items_n', c.list.length).toLowerCase()} · ${tr('inBoxes', groups.length)}</p></div>
    <div class="boxbar">${placesIn.map(pid => `<button class="btn primary small" data-mapcoll="${esc(pid)}">${ICON.pin} ${tr('showOnMap')}${placesIn.length > 1 ? ' · ' + esc(placeName(pid)) : ''}</button>`).join('')}
      <button class="btn quiet small" data-act="collout">↗ ${tr('takeOutAll')}</button><button class="btn quiet small" data-act="collback">↩ ${tr('putBackAll')}</button>
      <button class="btn quiet small" data-act="selectmode">${tr('select')}</button>${viewToggle()}</div>
    ${groups.map(([b, its]) => `<section class="cgroup"><button class="cghead" data-open="${esc(b.id)}"><span class="cgcode${b.loose ? ' loose' : ''}">${b.loose ? '' : `<span class="sico">${ICON.box}</span>` + esc(b.code.replace('B-', ''))}</span><span class="cgtext"><b>${b.loose ? tr('notInBox') : esc(b.name)}</b><small>${esc(boxWhere(b))}</small></span><span class="chev">›</span></button>
      ${viewMode === 'list' && !selecting ? rowsHTML(its.sort(byName).map(it => [it, b])) : `<div class="igrid${viewCls()}">${its.sort(byName).map(it => itemTile(it, b)).join('')}</div>`}</section>`).join('')}
    ${selBar(['tag', 'move', 'del'])}`;
  document.body.classList.toggle('selecting', !!selecting);
}
function boxWhere(b){
  if (b.loose) return [placeName(b.placeId), b.zone].filter(Boolean).join(' › ');
  const chain = boxChain(b);
  const top = chain[0] || b;
  return [placeName(b.placeId), top.location, top.stack ? `${tr('stack')} ${top.stack}` : '', top.level ? `${tr('level')} ${top.level}` : '', chain.length ? `${tr('insideBox')} ${chain.map(x => x.code).join(' › ')}` : ''].filter(Boolean).join(' · ');
}

/* ---------- select several things anywhere: add to a collection, move, delete ---------- */
function selBar(acts){
  if (!selecting) return '';
  const n = selecting.size;
  return `<div class="donebar selbar"><span class="selcount">${tr('selected', n)}</span><button class="btn quiet" data-act="selcancel">${tr('cancel')}</button>
    ${acts.includes('tag') ? `<button class="btn quiet" data-act="seltag" ${n ? '' : 'disabled'}>#&nbsp;${tr('toCollection')}</button>` : ''}
    ${acts.includes('move') ? `<button class="btn quiet" data-act="selmove" ${n ? '' : 'disabled'}>${tr('moveSel')}</button>` : ''}
    ${acts.includes('del') ? `<button class="btn danger" data-act="seldel" ${n ? '' : 'disabled'}>${tr('delSel')}</button>` : ''}</div>`;
}
function selectedItems(){ return [...(selecting || [])].filter(k => k.startsWith('i:')).map(k => { const [, bid, iid] = k.split(':'); const b = findBox(bid), it = b && (b.items || []).find(i => i.id === iid); return it ? [it, b] : null; }).filter(Boolean); }
async function selTag(){
  const sel = selectedItems(); if (!sel.length) return;
  const existing = collectionsAll().map(c => c.tag);
  openSheet(`<h3>#&nbsp;${tr('toCollection')} (${sel.length})</h3><p class="hint">${tr('collHint')}</p>
    <input class="input" id="ctIn" list="ctList" placeholder="${esc(tr('collPh'))}" autocapitalize="sentences"><datalist id="ctList">${existing.map(t => `<option value="${esc(tagLabel(t))}">`).join('')}</datalist>
    ${existing.length ? `<div class="chips" style="margin-top:8px">${existing.slice(0, 12).map(t => `<button class="chipbtn" data-ct="${esc(t)}">#${esc(tagLabel(t))}</button>`).join('')}</div>` : ''}
    <div class="sheet-foot" style="margin-top:14px"><button class="btn quiet" id="ctX">${tr('cancel')}</button><button class="btn primary" id="ctOk">${tr('add')}</button></div>`);
  sheet.querySelectorAll('[data-ct]').forEach(c => c.onclick = () => { $('#ctIn').value = tagLabel(c.dataset.ct); });
  $('#ctX').onclick = closeSheet;
  const go = () => {
    const tag = $('#ctIn').value.trim().toLowerCase().replace(/^#/, ''); if (!tag) return $('#ctIn').focus();
    const byBox = new Map(); sel.forEach(([it, b]) => { if (!byBox.has(b.id)) byBox.set(b.id, []); byBox.get(b.id).push(it.id); });
    snapshot([...byBox.keys()]);
    for (const [bid, ids] of byBox){ const nb = clone(findBox(bid)); nb.items.forEach(i => { if (ids.includes(i.id)) i.tags = [...new Set([...(i.tags || []), tag])]; }); putBox(nb, true); }
    selecting = null; closeSheet(); toast(tr('addedToColl', sel.length, tagLabel(tag)));
    navigate({name: 'collection', tag});
  };
  $('#ctOk').onclick = go; $('#ctIn').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  setTimeout(() => $('#ctIn') && $('#ctIn').focus(), 60);
}
async function selMove(){
  const sel = selectedItems(); if (!sel.length) return;
  const ref = sel[0][1];
  openSheet(`<h3>${tr('moveSel')} (${sel.length})</h3><label class="field"><span>${tr('to')}</span><select id="mvTo">${moveTargetsHTML(ref)}</select></label>
    <div class="sheet-foot"><button class="btn quiet" id="mvX">${tr('cancel')}</button><button class="btn primary" id="mvGo">${tr('move')}</button></div>`);
  $('#mvX').onclick = closeSheet;
  $('#mvGo').onclick = () => {
    const v = $('#mvTo').value, destId = v.startsWith('loose:') ? ensureLoose(v.slice(6)).id : v;
    const byBox = new Map(); sel.forEach(([it, b]) => { if (b.id === destId) return; if (!byBox.has(b.id)) byBox.set(b.id, []); byBox.get(b.id).push(it.id); });
    if (byBox.size){
      snapshot([...byBox.keys(), destId]);
      const to = clone(findBox(destId)); let n = 0;
      for (const [bid, ids] of byBox){
        const from = clone(findBox(bid)), moving = from.items.filter(i => ids.includes(i.id));
        from.items = from.items.filter(i => !ids.includes(i.id)); putBox(from, true);
        to.items = (to.items || []).concat(moving.map(m => { const x = clone(m); x.updatedAt = new Date().toISOString(); if (!to.loose){ delete x.spot; delete x.zone; delete x.stack; delete x.level; } return x; })); n += moving.length;
      }
      putBox(to, true); toast(tr('movedN', n, to.loose ? placeName(to.placeId) : to.code));
    }
    selecting = null; closeSheet(); render();
  };
}
async function selDelete(){
  const sel = selectedItems(); if (!sel.length) return;
  if (!(await askConfirm(tr('delSelQ', sel.length)))) return render();
  const byBox = new Map(); sel.forEach(([it, b]) => { if (!byBox.has(b.id)) byBox.set(b.id, []); byBox.get(b.id).push(it.id); });
  snapshot([...byBox.keys()]);
  let gone = [];
  for (const [bid, ids] of byBox){ const nb = clone(findBox(bid)); toTrash(nb.items.filter(i => ids.includes(i.id)).map(i => [i, nb])); gone = gone.concat(nb.items.filter(i => ids.includes(i.id))); nb.items = nb.items.filter(i => !ids.includes(i.id)); putBox(nb, true); }
  toast(tr('deletedN', gone.length) + ' ' + tr('inTrash')); selecting = null; render();
}

/* ---------- list rows (OurGroceries style): swipe right = out/back, swipe left = delete, ••• = more ---------- */
const isOut = it => !!(it && it.out);
const outOverdue = it => isOut(it) && it.out.until && it.out.until <= today();
const outItems = (filter = () => true) => boxes.filter(filter).flatMap(b => (b.items || []).filter(isOut).map(it => [it, b]));
function itemSub(it, b, showWhere){
  const bits = [it.size && (lang === 'sv' ? 'stl ' : 'size ') + it.size, itemOwner(it), showColor(it.color), it.brand, it.category].filter(Boolean);
  if (isOut(it)) bits.unshift(tr('outSince', it.out.since) + (it.out.until ? ' · ' + tr('backBy', it.out.until) : ''));
  if (showWhere) bits.push(b.loose ? placeName(b.placeId) : b.code);
  return bits.join(' · ') || (it.notes ? it.notes.slice(0, 60) : '');
}
function rowHTML(it, b, opts = {}){
  const p = (it.photos || [])[0];
  return `<div class="lrow-wrap" data-sw="${esc(b.id)}:${esc(it.id)}">
    <div class="lrow-bg"><span class="swl">${isOut(it) ? '↩ ' + tr('putBack') : '↗ ' + tr('takeOut')}</span><span class="swr">${tr('del')} 🗑</span></div>
    <div class="lrow${isOut(it) ? ' out' : ''}${outOverdue(it) ? ' late' : ''}${view.hl === it.id ? ' hl' : ''}" data-item="${esc(it.id)}" data-box="${esc(b.id)}">
      <span class="lthumb">${p ? imgTag(p.ref, '') : ''}<span class="ticon${p ? ' fb' : ''}">${guessIcon(it)}</span></span>
      <span class="ltext"><span class="lt">${esc(it.name || tr('unnamed'))}</span>${(s => s ? `<span class="ls">${esc(s)}</span>` : '')(itemSub(it, b, opts.where))}</span>
      ${isOut(it) ? `<span class="outtag">${tr('outTag')}</span>` : ''}${dot(isDue(it) || outOverdue(it))}
      <button class="lstar${it.fav ? ' on' : ''}" data-favtoggle="${esc(b.id)}:${esc(it.id)}" aria-pressed="${it.fav ? 'true' : 'false'}" aria-label="${esc(it.fav ? tr('unfav') : tr('fav'))}">${it.fav ? ICON.star : ICON.starO}</button>
      <button class="lmore" data-more="${esc(b.id)}:${esc(it.id)}" aria-label="${esc(tr('more'))}">•••</button>
    </div></div>`;
}
function rowsHTML(list, opts = {}){ return `<div class="lrows">${list.map(([it, b]) => rowHTML(it, b, opts)).join('')}</div>`; }
function groupHeader(b){
  const items = b.items || [], n = items.length, nOut = items.filter(isOut).length;
  const chain = b.loose ? [] : boxChain(b);
  const inside = [...childBoxes(b.id).map(c => c.name || c.code), ...items.map(i => i.name)].filter(Boolean).join(', ');
  const icon = b.loose ? `<span class="lgh-ico loose">${DEFAULT_ITEM_ICON}</span>` : `<span class="lgh-ico">${boxArt(boxNum(b))}</span>`;
  return `<div class="lgroup-h${b.loose ? ' loose' : ''}${b.out ? ' out' : ''}" data-gid="${esc(b.id)}"><button class="lgh-main" data-open="${esc(b.id)}">
      ${icon}<span class="lgh-text"><span class="lgh-name">${b.loose ? tr('notInBox') : esc((chain.length ? chain.map(boxNum).join(' › ') + ' › ' : '') + (b.name || boxLabel(b)))}</span><span class="lgh-in">${esc(inside || tr('boxEmpty'))}</span></span>
      <span class="lgh-count">${b.out ? '↗ ' : ''}${n}${nOut ? ` · ↗${nOut}` : ''}</span></button>
    <button class="lgh-add" data-quickadd="${esc(b.id)}" aria-label="${esc(tr('addItem'))}">${PLUS_SVG}</button><button class="lgh-fold${folded.has(b.id) ? ' shut' : ''}" data-fold="${esc(b.id)}" aria-expanded="${!folded.has(b.id)}" aria-label="${esc(folded.has(b.id) ? tr('unfold') : tr('fold'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div>`;
}
let quickAddFor = null;
function quickAddRow(b){
  if (quickAddFor !== b.id) return '';
  return `<div class="qadd"><input class="input" id="qaIn" data-qa="${esc(b.id)}" placeholder="${esc(tr('quickAddPh', b.loose ? tr('notInBox').toLowerCase() : b.code))}" autocapitalize="sentences" enterkeyhint="done"><button class="btn primary" data-act="qadone">${tr('done')}</button></div>`;
}
/* the whole place as one grouped list */
/* sorting the list: your own order (drag), A–Ö, last changed, last added, last used */
let listSort = 'manual', boxOrder = {}, folded = new Set(), foldedPlaces = new Set();
function saveFolded(){ metaPutRaw('folded', [...folded]).catch(() => {}); }
function saveFoldedPlaces(){ metaPutRaw('foldedPlaces', [...foldedPlaces]).catch(err => toast(saveErr(err))); }
const SORTS = ['manual', 'az', 'changed', 'added', 'used'];
const itStamp = (it, k) => k === 'changed' ? (it.updatedAt || it.addedAt || '') : k === 'added' ? (it.addedAt || it.storedOn || '') : k === 'used' ? [it.lastUsed || '', it.out ? it.out.since : '', ...(it.outLog || []).map(l => l.out || '')].sort().pop() || '' : '';
function sortItems(list){
  if (listSort === 'manual') return list;
  if (listSort === 'az') return [...list].sort(byName);
  return [...list].sort((x, y) => itStamp(y, listSort).localeCompare(itStamp(x, listSort)) || byName(x, y));
}
function orderedGroups(pid){
  const groups = boxesIn(pid).sort((x, y) => byCode(x, y));
  const order = []; const walk = b => { order.push(b); childBoxes(b.id).sort(byCode).forEach(walk); };
  groups.filter(b => !b.parentId || !findBox(b.parentId)).forEach(walk);
  const loose = looseOf(pid);
  let all = order.concat(loose && (loose.items || []).length ? [loose] : []);
  if (listSort === 'manual'){
    const saved = boxOrder[pid] || [], pos = id => { const i = saved.indexOf(id); return i < 0 ? 1e6 : i; };
    all = all.map((b, i) => [b, i]).sort((x, y) => (pos(x[0].id) - pos(y[0].id)) || (x[1] - y[1])).map(x => x[0]);
  } else if (listSort === 'az') all.sort((x, y) => (x.loose ? 1 : 0) - (y.loose ? 1 : 0) || String(x.name || '').localeCompare(String(y.name || ''), 'sv'));
  else { const best = b => [b.updatedAt && listSort === 'changed' ? b.updatedAt : '', ...(b.items || []).map(it => itStamp(it, listSort))].sort().pop() || ''; all.sort((x, y) => best(y).localeCompare(best(x))); }
  return all;
}
function sortBar(){
  const ids = orderedGroups(currentPlace).map(b => b.id), anyOpen = ids.some(i => !folded.has(i));
  return `<div class="sortbar"><span class="lab">${tr('sortBy')}</span><button class="linkbtn foldall" data-foldall="${anyOpen ? 1 : 0}">${anyOpen ? tr('foldAll') : tr('unfoldAll')}</button><div class="chips">${SORTS.map(k => `<button class="chipbtn small${listSort === k ? ' on' : ''}" data-sort="${k}">${tr('sort_' + k)}</button>`).join('')}</div></div>`;
}
function listHTML(pid){
  const all = orderedGroups(pid);
  const outs = outItems(b => b.placeId === pid);
  return `${sortBar()}<div class="lgroups" data-lpid="${esc(pid)}">${all.map(b => folded.has(b.id) ? `<section class="lgroup folded" data-gid="${esc(b.id)}">${groupHeader(b)}</section>` : `<section class="lgroup" data-gid="${esc(b.id)}">${groupHeader(b)}${rowsHTML(sortItems([...(b.items || [])].filter(it => !isOut(it))).map(it => [it, b]))}${quickAddRow(b)}
      ${!(b.items || []).filter(it => !isOut(it)).length && quickAddFor !== b.id ? `<p class="lempty">${tr('boxEmpty')}</p>` : ''}</section>`).join('')}</div>
    ${all.length > 1 || all.some(b => (b.items || []).length > 1) ? `<p class="swipehint">${tr('listDragHint')}</p>` : ''}
    ${!all.length ? `<p class="hint center">${tr('emptyPlace')}</p>` : ''}
    <div class="lgroup-actions"><button class="btn quiet small" data-act="addhere" data-pid="${esc(pid)}">${PLUS_SVG} ${tr('addBoxOrItem')}</button></div>
    ${quickAddFor && findBox(quickAddFor) && findBox(quickAddFor).loose && !(findBox(quickAddFor).items || []).length && findBox(quickAddFor).placeId === pid ? `<section class="lgroup">${groupHeader(findBox(quickAddFor))}${quickAddRow(findBox(quickAddFor))}</section>` : ''}
    ${outs.length ? `<section class="lgroup outsec"><div class="lgroup-h outh"><span class="lgh-main static"><span class="lgh-name">↗ ${tr('outSection')}</span><span class="lgh-count">${outs.length}</span></span></div>${rowsHTML(outs.sort((x, y) => byName(x[0], y[0])), {where: true})}</section>` : ''}
    ${adSlot('banner')}`;
}
function ensureLooseId(pid){ const l = looseOf(pid); return l ? l.id : 'new:' + pid; }

/* out / back */
function deleteWithUndo(boxId, itemId){
  const b = findBox(boxId), it = b && (b.items || []).find(i => i.id === itemId); if (!it) return;
  snapshot([b.id]);
  const tids = toTrash([[it, b]]);
  const nb = clone(b); nb.items = nb.items.filter(i => i.id !== itemId); putBox(nb);
  toastAction(tr('deletedX', it.name), tr('undo'), () => { untrash(tids); undoApply(); render(); });
}
let toastAct = null;
function toastAction(msg, label, fn, after){
  document.querySelectorAll('.toast').forEach(t => t.remove());
  if (toastAct && toastAct.after) toastAct.after();
  const t = document.createElement('div'); t.className = 'toast act'; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span><button class="linkbtn">${esc(label)}</button>`;
  toastHost().appendChild(t);
  const me = toastAct = {after};
  t.querySelector('button').onclick = () => { me.after = null; t.remove(); fn(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.remove(); if (me.after) me.after(); me.after = null; }, 5000);
}
function rowMenu(boxId, itemId){
  const b = findBox(boxId), it = b && (b.items || []).find(i => i.id === itemId); if (!it) return;
  openSheet(`<h3>${esc(it.name)}</h3><p class="hint">${esc(b.loose ? placeName(b.placeId) + ', ' + tr('notInBoxShort') : `${b.code} ${b.name}`)}</p><div class="menu">
    <button class="btn quiet" id="rmOpen">${tr('editItem')}</button>
    ${isOut(it) ? `<button class="btn quiet" id="rmBack">↩ ${tr('putBack')}</button>` : `<button class="btn quiet" id="rmOut">↗ ${tr('takeOut')}</button>`}
    <label class="field"><span>${tr('outUntil')}</span><input type="date" id="rmUntil" value="${esc(it.out && it.out.until || '')}" min="${today()}"></label>
    <button class="btn quiet" id="rmMove">${tr('move')}</button>
    <button class="btn quiet" id="rmColl"># ${tr('toCollection')}</button>
    <button class="btn danger" id="rmDel">${tr('del')}</button><button class="btn" id="rmX">${tr('close')}</button></div>`);
  $('#rmOpen').onclick = () => { closeSheet(); navigate({name: 'item', boxId, itemId}); };
  if ($('#rmBack')) $('#rmBack').onclick = () => { closeSheet(); setOut(boxId, itemId, false); };
  if ($('#rmOut')) $('#rmOut').onclick = () => { const u = $('#rmUntil').value; closeSheet(); setOut(boxId, itemId, true, u); };
  $('#rmUntil').onchange = e => { const u = e.target.value; closeSheet(); setOut(boxId, itemId, true, u); };
  $('#rmMove').onclick = () => moveItemSheet(boxId, itemId);
  $('#rmColl').onclick = () => { selecting = new Set([`i:${boxId}:${itemId}`]); selTag(); };
  $('#rmDel').onclick = () => { closeSheet(); deleteWithUndo(boxId, itemId); };
  $('#rmX').onclick = closeSheet;
}
/* swipe handling */
let swipe = null;
app.addEventListener('pointerdown', e => {
  const row = e.target.closest('.lrow'); if (!row || e.target.closest('.lmore') || e.button > 0 || selecting) return;
  swipe = {row, wrap: row.parentElement, x: e.clientX, y: e.clientY, dx: 0, on: false, id: e.pointerId};
});
document.addEventListener('pointermove', e => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (!swipe.on){
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)){ swipe = null; return; }
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3){ swipe.on = true; swipe.wrap.classList.add('swiping'); try { swipe.row.setPointerCapture(swipe.id); } catch {} }
    else return;
  }
  swipe.dx = dx;
  swipe.row.style.transform = `translate3d(${dx}px,0,0)`;
  swipe.wrap.classList.toggle('sw-right', dx > 0); swipe.wrap.classList.toggle('sw-left', dx < 0);
  swipe.wrap.classList.toggle('armed', Math.abs(dx) > 90);
}, {passive: true});
document.addEventListener('touchmove', e => { if (swipe && swipe.on) e.preventDefault(); }, {passive: false});
const endSwipe = () => {
  if (!swipe) return;
  const s = swipe; swipe = null;
  if (!s.on) return;
  lpFired = true; setTimeout(() => { lpFired = false; }, 350);
  const [boxId, itemId] = s.wrap.dataset.sw.split(':');
  const done = Math.abs(s.dx) > 90;
  s.row.style.transition = 'transform .18s ease';
  if (done && s.dx > 0){ s.row.style.transform = 'translate3d(100%,0,0)'; setTimeout(() => { const it = (findBox(boxId).items || []).find(i => i.id === itemId); setOut(boxId, itemId, !isOut(it)); }, 160); }
  else if (done){ s.row.style.transform = 'translate3d(-100%,0,0)'; setTimeout(() => deleteWithUndo(boxId, itemId), 160); }
  else { s.row.style.transform = ''; setTimeout(() => { s.wrap.classList.remove('swiping', 'sw-left', 'sw-right', 'armed'); s.row.style.transition = ''; }, 200); }
};
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', () => { if (swipe && swipe.on){ swipe.dx = 0; endSwipe(); } swipe = null; });

/* drag in the list: long-press a box header to move the whole box up/down, or an item to move it (also into another box) */
let ldrag = null, ldragT = null;
app.addEventListener('pointerdown', e => {
  if (placeView !== 'list' || selecting || e.button > 0) return;
  const src = e.target.closest('.lrow, .lgroup-h'); if (!src || !src.closest('.lgroups') || e.target.closest('.lmore,.lstar,.lgh-add')) return;
  const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
  clearTimeout(ldragT);
  const cancel = ev => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) clearTimeout(ldragT); };
  document.addEventListener('pointermove', cancel, {passive: true});
  const off = () => { clearTimeout(ldragT); document.removeEventListener('pointermove', cancel); document.removeEventListener('pointerup', off); document.removeEventListener('pointercancel', off); };
  document.addEventListener('pointerup', off); document.addEventListener('pointercancel', off);
  ldragT = setTimeout(() => { off(); if (swipe && swipe.on) return; swipe = null; startListDrag(src, x0, y0, id); }, 220);
});
function startListDrag(src, x, y, pid){
  const isGroup = src.classList.contains('lgroup-h');
  const el = isGroup ? src.closest('.lgroup') : src.closest('.lrow-wrap');
  const r = el.getBoundingClientRect();
  const ghost = el.cloneNode(true); ghost.classList.add('ldrag-ghost');
  if (isGroup) ghost.classList.add('ldrag-group-ghost');
  Object.assign(ghost.style, {width: r.width + 'px', left: r.left + 'px', top: r.top + 'px'});
  document.body.appendChild(ghost); el.classList.add('ldrag-src');
  const line = document.createElement('div'); line.className = 'ldrop-line'; document.body.appendChild(line);
  ldrag = {isGroup, el, ghost, line, dy: y - r.top, y, target: null, pid};
  lpFired = true; if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
  document.body.classList.add('ldragging');
  if (isGroup) document.body.classList.add('ldragging-groups');
  moveListDrag(x, y);
}
function moveListDrag(x, y){
  const d = ldrag; if (!d) return;
  d.y = y; d.ghost.style.top = (y - d.dy) + 'px';
  d.ghost.style.visibility = 'hidden'; const under = document.elementFromPoint(x, y); d.ghost.style.visibility = '';
  d.target = null; d.line.style.display = 'none';
  if (!under) return;
  const show = (el, after) => { const r = el.getBoundingClientRect(); Object.assign(d.line.style, {display: 'block', left: r.left + 'px', width: r.width + 'px', top: ((after ? r.bottom : r.top) - 1) + 'px'}); };
  if (d.isGroup){
    const g = under.closest('.lgroups .lgroup'); if (!g || g === d.el) return;
    const r = g.getBoundingClientRect(), after = y > r.top + r.height / 2;
    d.target = {gid: g.dataset.gid, after}; show(g, after);
  } else {
    const row = under.closest('.lgroups .lrow-wrap'), g = under.closest('.lgroups .lgroup');
    if (row && row !== d.el){ const r = row.getBoundingClientRect(), after = y > r.top + r.height / 2; d.target = {gid: row.closest('.lgroup').dataset.gid, row: row.dataset.sw.split(':')[1], after}; show(row, after); }
    else if (g){ const h = g.querySelector('.lgroup-h'); d.target = {gid: g.dataset.gid, row: null}; show(h, true); }
  }
  // scroll near the edges
  const H = window.innerHeight; clearInterval(d.scroll);
  if (y < 110 || y > H - 140) d.scroll = setInterval(() => { window.scrollBy(0, y < 110 ? -8 : 8); }, 16);
}
function endListDrag(){
  const d = ldrag; if (!d) return; ldrag = null;
  clearInterval(d.scroll); d.ghost.remove(); d.line.remove(); d.el.classList.remove('ldrag-src'); document.body.classList.remove('ldragging');
  document.body.classList.remove('ldragging-groups');
  setTimeout(() => { lpFired = false; }, 300);
  const t = d.target; if (!t) return;
  track('drag', {what: d.isGroup ? 'box' : 'item'});
  const pid = currentPlace;
  if (d.isGroup){
    const ids = orderedGroups(pid).map(b => b.id), from = d.el.dataset.gid;
    const rest = ids.filter(i => i !== from); let at = rest.indexOf(t.gid); if (at < 0) return; if (t.after) at++;
    rest.splice(at, 0, from); boxOrder[pid] = rest; metaPut('boxOrder', boxOrder).catch(() => {});
    if (listSort !== 'manual'){ listSort = 'manual'; metaPut('listSort', listSort).catch(() => {}); }
    return render();
  }
  const [fromBox, itemId] = d.el.dataset.sw.split(':');
  let destBox = t.gid;
  if (destBox !== fromBox){ const to = moveItemTo(fromBox, itemId, destBox); if (!to) return; destBox = to.id; }
  if (t.row && t.row !== itemId){
    const nb = clone(findBox(destBox)), list = nb.items || [], i = list.findIndex(x => x.id === itemId); if (i < 0) return render();
    const [it] = list.splice(i, 1); let at = list.findIndex(x => x.id === t.row); if (at < 0) at = list.length; else if (t.after) at++;
    list.splice(at, 0, it); nb.items = list; putBox(nb, true);
    if (listSort !== 'manual'){ listSort = 'manual'; metaPut('listSort', listSort).catch(() => {}); }
  }
  render();
}
document.addEventListener('pointermove', e => { if (ldrag) moveListDrag(e.clientX, e.clientY); }, {passive: true});
document.addEventListener('touchmove', e => { if (ldrag) e.preventDefault(); }, {passive: false});
document.addEventListener('pointerup', () => { if (ldrag) endListDrag(); });
document.addEventListener('pointercancel', () => { if (ldrag) endListDrag(); });
document.addEventListener('contextmenu', e => { if (ldrag || (placeView === 'list' && e.target.closest && e.target.closest('.lgroups'))) e.preventDefault(); });

/* quick add: type a name, Enter, type the next */
/* tapping anywhere outside the quick-add row saves what was typed and closes it */
document.addEventListener('pointerdown', e => {
  if (!quickAddFor || e.target.closest('.qadd') || e.target.closest('[data-quickadd]')) return;
  const i = $('#qaIn'); if (i && i.value.trim()) quickAdd(i.dataset.qa, i.value);
  quickAddFor = null; if (i) i.blur();
  setTimeout(() => { if (!quickAddFor && $('.qadd')) render(); }, 0);
}, true);
function quickAdd(boxId, name){
  name = (name || '').trim(); if (!name) return;
  track('item_add', {via: 'quick'});
  let b = findBox(boxId); if (!b) return;
  const it = {id: newId(), name: cap(name), category: '', value: '', storedOn: today(), notes: '', photos: [], tags: [], addedAt: new Date().toISOString(), addedBy: me || ''};
  const nb = clone(b); nb.items = (nb.items || []).concat(it); putBox(nb);
  setTimeout(() => { const i = $('#qaIn'); if (i){ i.focus(); } }, 30);
}
document.addEventListener('keydown', e => {
  const i = e.target.closest && e.target.closest('#qaIn'); if (!i || e.key !== 'Enter') return;
  e.preventDefault(); const v = i.value; i.value = ''; quickAdd(i.dataset.qa, v);
});

/* ad slots (test): only a house ad for Premium until there's an ad partner */
let adsPreview = true;
function adSlot(kind){
  if (!adsPreview) return '';
  return `<aside class="adslot ad-${kind}" aria-label="${esc(tr('adLabel'))}"><span class="adtag">${tr('adLabel')}</span>
    <div class="admain"><span class="adlogo">${logoSVG()}</span><span class="adtext"><b>${tr('adTitle')}</b><small>${tr('adText')}</small></span>
    <button class="btn quiet small" data-sub="premium">${tr('readMore')}</button></div></aside>`;
}

function iconSheet(){
  const [it] = curItem(); if (!it) return;
  if (flushItem) flushItem();
  const all = [...new Set(ICONS.map(x => x[0]))];
  const auto = matchIcon(it.name) || matchIcon(it.category) || DEFAULT_ITEM_ICON;
  openSheet(`<h3>${tr('pickIcon')}</h3><p class="hint">${tr('pickIconHint')}</p>
    <button class="btn ${it.icon ? 'quiet' : 'primary'} block" data-ic="">${auto} ${tr('autoIcon')}</button>
    <div class="iconpick big">${all.map(e => `<button class="${it.icon === e ? 'on' : ''}" data-ic="${e}">${e}</button>`).join('')}</div>
    <div class="sheet-foot"><button class="btn" id="icX">${tr('close')}</button></div>`);
  sheet.querySelectorAll('[data-ic]').forEach(btn => btn.onclick = () => { const v = btn.dataset.ic; saveItem(x => { if (v) x.icon = v; else delete x.icon; }, true); closeSheet(); });
  $('#icX').onclick = closeSheet;
}

/* ---------- out: single items, whole boxes, whole collections; with a history so patterns can be learned ---------- */
function markOut(x, out, until){
  x.outLog = x.outLog || [];
  if (out){
    if (!x.out) x.outLog.push({out: today()});
    x.out = {since: (x.out && x.out.since) || today()}; if (until) x.out.until = until;
  } else {
    if (x.out){ const last = x.outLog[x.outLog.length - 1]; if (last && !last.back) last.back = today(); else x.outLog.push({out: x.out.since, back: today()}); }
    delete x.out; x.lastUsed = today();
  }
  if (x.outLog.length > 30) x.outLog = x.outLog.slice(-30);
  x.updatedAt = new Date().toISOString();
}
function setOut(boxId, itemId, out, until){
  const b = findBox(boxId); if (!b) return;
  snapshot([b.id]);
  const nb = clone(b), x = nb.items.find(i => i.id === itemId); if (!x) return;
  markOut(x, out, until); putBox(nb);
  toastAction(out ? tr('tookOut', x.name, b.loose ? placeName(b.placeId) : b.code) : tr('putBackDone', x.name, b.loose ? placeName(b.placeId) : b.code), tr('undo'), () => { undoApply(); render(); });
}
function setOutMany(list, out, until, label){
  const byBox = new Map(); list.forEach(([it, b]) => { if (isOut(it) === out) return; if (!byBox.has(b.id)) byBox.set(b.id, []); byBox.get(b.id).push(it.id); });
  if (!byBox.size) return toast(out ? tr('allOutAlready') : tr('allBackAlready'));
  snapshot([...byBox.keys()]); let n = 0;
  for (const [bid, ids] of byBox){ const nb = clone(findBox(bid)); nb.items.forEach(i => { if (ids.includes(i.id)){ markOut(i, out, until); n++; } }); putBox(nb, true); }
  render();
  toastAction(out ? tr('tookOutN', n, label) : tr('putBackN', n, label), tr('undo'), () => { undoApply(); render(); });
}
function setBoxOut(boxId, out, until){
  const b = findBox(boxId); if (!b || b.loose) return;
  snapshot([b.id]);
  const nb = clone(b);
  if (out){ nb.out = {since: (b.out && b.out.since) || today()}; if (until) nb.out.until = until; } else { delete nb.out; nb.checkedAt = new Date().toISOString(); }
  putBox(nb);
  toastAction(out ? tr('boxOutDone', b.code) : tr('boxBackDone', b.code), tr('undo'), () => { undoApply(); render(); });
}
const boxOutLate = b => b.out && b.out.until && b.out.until <= today();

/* ---------- freshness: when a box was last checked, opened in the app, or changed ---------- */
const daysSince = d => d ? Math.floor((Date.now() - new Date(d)) / 864e5) : Infinity;
function freshDays(b){ return Math.min(daysSince(b.checkedAt), daysSince(b.updatedAt)); }
function freshLevel(b){ const d = freshDays(b); return d === Infinity ? 0 : d <= 90 ? 4 : d <= 180 ? 3 : d <= 365 ? 2 : 1; }
const freshDot = b => `<i class="fresh f${freshLevel(b)}" title="${esc(freshText(b))}"></i>`;
function ago(d){
  const n = daysSince(d); if (n === Infinity) return '';
  if (n === 0) return tr('today'); if (n === 1) return tr('yesterday');
  if (n < 14) return tr('daysAgo', n); if (n < 60) return tr('weeksAgo', Math.round(n / 7));
  if (n < 365) return tr('monthsAgo', Math.round(n / 30)); return tr('yearsAgo', Math.round(n / 365));
}
function freshText(b){
  return [b.checkedAt ? `✓ ${tr('checked')} ${ago(b.checkedAt)}` : tr('neverChecked'), b.openedAt ? `${tr('openedApp')} ${ago(b.openedAt)}` : '', b.updatedAt ? `${tr('changedAgo')} ${ago(b.updatedAt)}` : ''].filter(Boolean).join(' · ');
}
function checkedThisYear(pid){ const bx = realBoxes().filter(b => !pid || b.placeId === pid); return [bx.filter(b => freshDays(b) <= 365).length, bx.length]; }
function touchOpened(b){ if (!b || b.loose) return; b.openedAt = new Date().toISOString(); dbPut(clone(b)).catch(() => {}); }
function checkBox(boxId){
  const b = findBox(boxId); if (!b) return;
  b.checkedAt = new Date().toISOString(); dbPut(clone(b)).catch(() => {});
  toast(tr('checkedThanks')); render();
}

/* ---------- seasonal and learned nudges ---------- */
const SEASON_RULES = [
  {re: /^(jul|julpynt|christmas|xmas)$/, out: [11, 12], back: [1], icon: '🎄'},
  {re: /^(påsk|easter)$/, out: [3, 4], back: [4, 5], icon: '🐣'},
  {re: /^(halloween)$/, out: [10], back: [11], icon: '🎃'},
  {re: /^(vinter|winter|ski|skidor|vinterkläder)$/, out: [11, 12], back: [4], icon: '❄️'},
  {re: /^(sommar|summer|sommarkläder|camping)$/, out: [5, 6], back: [9], icon: '☀️'},
];
let nudgeSnooze = {};
const snoozed = key => nudgeSnooze[key] && nudgeSnooze[key] >= today();
function snooze(key, days){ const d = new Date(); d.setDate(d.getDate() + (days || 21)); nudgeSnooze[key] = d.toISOString().slice(0, 10); metaPut('nudgeSnooze', nudgeSnooze).catch(() => {}); }
function nudges(pid){
  const month = new Date().getMonth() + 1, out = [];
  for (const c of collectionsAll()){
    const list = c.list.filter(([, b]) => !pid || b.placeId === pid); if (!list.length) continue;
    const rule = SEASON_RULES.find(r => r.re.test(c.tag)); if (!rule) continue;
    const anyIn = list.some(([it]) => !isOut(it)), anyOut = list.some(([it]) => isOut(it));
    if (rule.out.includes(month) && anyIn) out.push({key: `out:${c.tag}:${month}`, kind: 'collOut', tag: c.tag, icon: rule.icon});
    if (rule.back.includes(month) && anyOut) out.push({key: `back:${c.tag}:${month}`, kind: 'collBack', tag: c.tag, icon: rule.icon});
  }
  // learned: things you take out regularly (the extra bed once a month), or around the same time every year
  boxes.forEach(b => { if (pid && b.placeId !== pid) return; (b.items || []).forEach(it => {
    if (isOut(it) || !(it.outLog || []).length) return;
    const outs = it.outLog.map(e => e.out).filter(Boolean).sort();
    const last = outs[outs.length - 1];
    if (outs.length >= 2){
      const gaps = outs.slice(1).map((d, i) => (new Date(d) - new Date(outs[i])) / 864e5), avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      if (avg >= 5 && daysSince(last) >= avg * 0.9) out.push({key: `pat:${it.id}:${last}`, kind: 'pattern', it, b, every: Math.round(avg)});
    }
    const sameMonthBefore = outs.some(d => new Date(d).getMonth() + 1 === month && new Date(d).getFullYear() < new Date().getFullYear());
    if (sameMonthBefore && daysSince(last) > 200) out.push({key: `yr:${it.id}:${month}`, kind: 'yearly', it, b});
  }); });
  const seen = new Set();
  return out.filter(n => !snoozed(n.key) && !seen.has(n.key) && seen.add(n.key));
}
function nudgeCard(n, compact){
  const coll = n.tag ? '#' + tagLabel(n.tag) : '';
  const text = n.kind === 'collOut' ? tr('nudgeCollOut', coll) : n.kind === 'collBack' ? tr('nudgeCollBack', coll)
    : n.kind === 'pattern' ? tr('nudgePattern', n.it.name, n.every) : tr('nudgeYearly', n.it.name);
  const yes = n.kind === 'collOut' ? tr('takeOutAll') : n.kind === 'collBack' ? tr('putBackAll') : tr('takeOut');
  return `<div class="nudge${compact ? ' compact' : ''}"><span class="nico">${n.icon || guessIcon(n.it)}</span><span class="ntext">${esc(text)}</span>
    <span class="nbtns"><button class="btn primary small" data-nudge="${esc(n.key)}" data-ny="1">${esc(yes)}</button><button class="btn quiet small" data-nudge="${esc(n.key)}">${tr('notNow')}</button></span></div>`;
}
function doNudge(key, yes, pid){
  const n = nudges().find(x => x.key === key);
  if (!yes || !n){ snooze(key); return render(); }
  snooze(key, 60);
  const c = n.tag && collectionsAll().find(x => x.tag === n.tag);
  if (n.kind === 'collOut') return setOutMany(c.list, true, null, '#' + tagLabel(n.tag));
  if (n.kind === 'collBack') return setOutMany(c.list, false, null, '#' + tagLabel(n.tag));
  setOut(n.b.id, n.it.id, true);
}

/* ---------- sheets: add, move, long press ---------- */
function addHereSheet(pid, boxId, includeBatch = true){
  const b = boxId && findBox(boxId);
  const intoBox = b && !b.loose;
  openSheet(`<h3>${esc(intoBox ? tr('addInto', `${b.code} ${b.name}`) : tr('addTo', placeName(pid)))}</h3>
    <div class="choice addchoices">${intoBox ? `<button class="btn primary big addopt" id="adItem"><span class="aoi">${DEFAULT_ITEM_ICON}</span><span>${tr('addThingChoice')}</span></button><button class="btn primary big addopt" id="adBox"><span class="aoi">${boxArt('')}</span><span>${tr('addBoxChoice')}</span></button>${includeBatch ? `<button class="btn primary big addopt" id="adBatch"><span class="aoi">${ICON.camera}</span><span>${tr('addMultipleChoice')}</span></button>` : ''}`
      : `<button class="btn primary big addopt" id="adItem"><span class="aoi">${DEFAULT_ITEM_ICON}</span><span>${tr('itemNoBox')}</span></button><button class="btn primary big addopt" id="adBox"><span class="aoi">${boxArt('')}</span><span>${tr('addBoxChoice')}</span></button>${includeBatch ? `<button class="btn primary big addopt" id="adBatch"><span class="aoi">${ICON.camera}</span><span>${tr('addMultipleChoice')}</span></button>` : ''}`}</div>
    <div class="sheet-foot" style="margin-top:12px"><button class="btn quiet" id="adX">${tr('cancel')}</button></div>`);
  $('#adBox').onclick = () => { closeSheet(); boxSheet(null, pid, intoBox ? b.id : null); };
  $('#adItem').onclick = () => { closeSheet(); newItem(b ? b.id : ensureLoose(pid).id); };
  if (includeBatch) $('#adBatch').onclick = () => { closeSheet(); openBatch(b ? b.id : ensureLoose(pid).id); };
  $('#adX').onclick = closeSheet;
}
function ensureInbox(){
  let p = places.find(x => x.inbox);
  if (!p){ p = {id: newId(), name: tr('unsorted'), icon: '📥', inbox: true, createdAt: new Date().toISOString()}; places.push(p); metaPut('places', places).catch(() => {}); }
  return p;
}
function addNavSheet(initialPid){
  const v = view;
  if ((v.name === 'box' || v.name === 'item' || v.name === 'batch') && findBox(v.boxId)){ const b = findBox(v.boxId); if (!b.loose) return addHereSheet(b.placeId, b.id); }
  const storagePlaces = places.filter(p => !p.inbox);
  const currentBox = (v.name === 'box' || v.name === 'item') && findBox(v.boxId);
  const recentPlace = recents.map(r => findPlace((r.k === 'box' ? findBox(r.id) : findBox(r.boxId))?.placeId)).find(p => p && !p.inbox);
  let pid = currentBox ? currentBox.placeId : initialPid || scopePlace() || recentPlace?.id || storagePlaces[0]?.id || 'inbox';
  const isInbox = id => id === 'inbox' || !!findPlace(id)?.inbox;
  if (!storagePlaces.some(p => p.id === pid) && !isInbox(pid)) pid = recentPlace?.id || storagePlaces[0]?.id || 'inbox';
  const chips = () => storagePlaces.length > 6
    ? `<select class="add-place-select" aria-label="${esc(tr('where'))}">${storagePlaces.map(p => `<option value="${esc(p.id)}"${pid === p.id ? ' selected' : ''}>${esc(placeIcon(p) + ' ' + p.name)}</option>`).join('')}<option value="inbox"${isInbox(pid) ? ' selected' : ''}>📥 ${tr('noPlaceYet')}</option></select>`
    : `${storagePlaces.map(p => `<button class="chipbtn${pid === p.id ? ' on' : ''}" data-ap="${esc(p.id)}">${placeIcon(p)} ${esc(p.name)}</button>`).join('')}<button class="chipbtn${isInbox(pid) ? ' on' : ''}" data-ap="inbox">📥 ${tr('noPlaceYet')}</button>`;
  openSheet(`<div class="addnav-sheet"><h3>${tr('addWhat')}</h3>
    <div class="choice addchoices"><button class="btn primary big addopt" id="adBox"><span class="aoi">${boxArt('')}</span><span>${tr('addBoxChoice')}</span></button><button class="btn primary big addopt" id="adItem"><span class="aoi">${DEFAULT_ITEM_ICON}</span><span>${tr('itemNoBox')}</span></button><button class="btn primary big addopt" id="adBatch"><span class="aoi">${ICON.camera}</span><span>${tr('addMultipleChoice')}</span></button></div>
    <span class="lab" style="display:block;margin-top:14px">${tr('where')}</span><div class="chips addplaces" id="adPlaces">${chips()}</div>
    <div class="sheet-foot" style="margin-top:12px"><button class="btn" id="adX">${tr('cancel')}</button></div></div>`);
  $('#adPlaces').innerHTML = chips();
  $('#adPlaces').onclick = e => { const c = e.target.closest('[data-ap]'); if (!c) return; pid = c.dataset.ap; $('#adPlaces').innerHTML = chips(); };
  const placeSelect = $('#adPlaces select');
  if (placeSelect) placeSelect.onchange = () => { pid = placeSelect.value; };
  const target = () => pid === 'inbox' ? ensureInbox().id : pid;
  $('#adBox').onclick = () => { const p = target(); closeSheet(); boxSheet(null, p, null); };
  $('#adItem').onclick = () => { const p = target(); closeSheet(); newItem(ensureLoose(p).id); };
  $('#adBatch').onclick = () => { const p = target(); closeSheet(); openBatch(ensureLoose(p).id); };
  $('#adX').onclick = closeSheet;
}
function moveItemSheet(boxId, itemId){
  const b = findBox(boxId), it = b && (b.items || []).find(i => i.id === itemId); if (!it) return;
  openSheet(`<h3>${esc(tr('moveX', it.name || tr('unnamed')))}</h3><label class="field"><span>${tr('to')}</span><select id="mvTo">${moveTargetsHTML(b)}</select></label>
    <div class="sheet-foot"><button class="btn quiet" id="mvX">${tr('cancel')}</button><button class="btn primary" id="mvGo">${tr('move')}</button></div>`);
  $('#mvX').onclick = closeSheet;
  $('#mvGo').onclick = () => { moveItemTo(boxId, itemId, $('#mvTo').value); closeSheet(); render(); };
}
async function deleteItem(boxId, itemId){
  const b = findBox(boxId), it = b && (b.items || []).find(i => i.id === itemId); if (!it) return;
  if (!(await askConfirm(tr('delQ', it.name || tr('unnamed'))))) return;
  if (view.name === 'item' && view.itemId === itemId){ itemEdit = null; flushItem = null; itemDraft = null; }
  toTrash([[it, b]]);
  const cur = findBox(boxId); const nb = clone(cur); nb.items = nb.items.filter(i => i.id !== itemId); putBox(nb, true);
  toast(tr('inTrash'));
  if (view.name === 'item'){ goBack(); } else render();
}
function lpMenu(key){
  const [kind, a, c] = key.split(':');
  if (kind === 'place'){
    const p = findPlace(a); if (!p) return;
    const n = boxes.filter(b => b.placeId === p.id).reduce((s, b) => s + (b.loose ? 0 : 1) + (b.items || []).length, 0);
    openSheet(`<h3>${placeIcon(p)} ${esc(p.name)}</h3><div class="menu">
      <div class="field"><span>${tr('icon')}</span><div class="iconpick">${PLACE_ICONS.map(ic => `<button class="${placeIcon(p) === ic ? 'on' : ''}" data-icon="${ic}">${ic}</button>`).join('')}</div></div>
      <button class="btn quiet" id="lpRen">${tr('rename')}</button>
      <button class="btn quiet" id="lpShare">${tr('shareCopy')}</button>
      ${places.length > 1 && !n ? `<button class="btn danger" id="lpDel">${tr('del')}</button>` : `<p class="hint">${n ? tr('emptyFirst') : ''}</p>`}
      <button class="btn" id="lpX">${tr('close')}</button></div>`);
    sheet.querySelector('.iconpick').onclick = e => { const t = e.target.closest('[data-icon]'); if (!t) return; p.icon = t.dataset.icon; metaPut('places', places).catch(() => {}); sheet.querySelectorAll('[data-icon]').forEach(x => x.classList.toggle('on', x === t)); render(); };
    $('#lpRen').onclick = async () => { const nn = await askText(tr('renameX', p.name), {value: p.name, ok: tr('save')}); if (nn){ p.name = nn; metaPut('places', places).catch(() => {}); } render(); };
    $('#lpShare').onclick = () => sharePlaceCopy(p.id);
    if ($('#lpDel')) $('#lpDel').onclick = () => { places = places.filter(x => x.id !== p.id); boxes.filter(b => b.loose && b.placeId === p.id).forEach(b => removeBox(b.id)); if (currentPlace === p.id) setPlace('all'); metaPut('places', places).catch(() => {}); closeSheet(); render(); };
  } else if (kind === 'box'){
    const b = findBox(a); if (!b) return;
    openSheet(`<h3>${esc(b.code)} ${esc(b.name)}</h3><div class="menu">
      <button class="btn quiet" id="lpEdit">${tr('edit')}</button>
      <button class="btn quiet" id="lpFav">${b.fav ? '★ ' + tr('unfav') : '☆ ' + tr('fav')}</button>
      <button class="btn quiet" id="lpPlace">${tr('placement')}</button>
      <label class="field"><span>${tr('moveToPlace')}</span><select id="lpMove">${places.map(p => `<option value="${esc(p.id)}" ${p.id === b.placeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <button class="btn danger" id="lpDel">${tr('del')}</button><button class="btn" id="lpX">${tr('close')}</button></div>`);
    $('#lpEdit').onclick = () => { closeSheet(); boxSheet(b.id); };
    $('#lpFav').onclick = () => { const nb = clone(b); nb.fav = !b.fav; putBox(nb); closeSheet(); };
    $('#lpPlace').onclick = () => placementSheet(b.id);
    $('#lpMove').onchange = e => {
      const to = e.target.value; snapshot([b.id, ...descendants(b.id).map(x => x.id)]);
      const nb = clone(b); nb.placeId = to; nb.parentId = null;
      if (numbering === 'place' && realBoxes().some(x => x.placeId === to && x.code === nb.code && x.id !== nb.id)) nb.code = nextCode(to);
      putBox(nb, true); descendants(b.id).forEach(d => { const nd = clone(d); nd.placeId = to; putBox(nd, true); });
      toast(tr('movedTo', placeName(to))); closeSheet(); render();
    };
    $('#lpDel').onclick = () => { boxSheet(b.id); setTimeout(() => { const d = $('#bDel'); if (d) d.click(); }, 30); };
  } else if (kind === 'item'){
    const b = findBox(a), it = b && (b.items || []).find(i => i.id === c); if (!it) return;
    openSheet(`<h3>${esc(it.name || tr('unnamed'))}</h3><div class="menu">
      <button class="btn quiet" id="lpEdit">${tr('edit')}</button><button class="btn quiet" id="lpMove">${tr('move')}</button>
      <button class="btn quiet" id="lpFav">${it.fav ? '★ ' + tr('unfav') : '☆ ' + tr('fav')}</button>
      <button class="btn quiet" id="lpShare">${tr('share')}</button>
      <button class="btn danger" id="lpDel">${tr('del')}</button><button class="btn" id="lpX">${tr('close')}</button></div>`);
    $('#lpEdit').onclick = () => { closeSheet(); navigate({name: 'item', boxId: b.id, itemId: it.id}); };
    $('#lpMove').onclick = () => moveItemSheet(b.id, it.id);
    $('#lpFav').onclick = () => { const nb = clone(b); const x = nb.items.find(i => i.id === it.id); x.fav = !it.fav; putBox(nb); closeSheet(); };
    $('#lpShare').onclick = () => { closeSheet(); shareWhere(it, b); };
    $('#lpDel').onclick = () => { closeSheet(); deleteItem(b.id, it.id); };
  }
  if ($('#lpX')) $('#lpX').onclick = closeSheet;
}
let lpTimer = null, lpFired = false, lpStart = null;
app.addEventListener('pointerdown', e => {
  lpFired = false;
  const t = e.target.closest('[data-lp]'); if (!t) return;
  lpStart = {x: e.clientX, y: e.clientY};
  clearTimeout(lpTimer); lpTimer = setTimeout(() => { lpFired = true; setTimeout(() => { lpFired = false; }, 800); if (navigator.vibrate) navigator.vibrate(15); lpMenu(t.dataset.lp); }, 550);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => app.addEventListener(ev, () => clearTimeout(lpTimer)));
app.addEventListener('pointermove', e => { if (lpStart && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 10) clearTimeout(lpTimer); });
app.addEventListener('contextmenu', e => { if (e.target.closest('[data-lp], [data-fav-order], .crate, .ltoken, .mtoken')) e.preventDefault(); });

let favoritePress = null, favoriteDrag = null, suppressFavoriteClick = false;
app.addEventListener('pointerdown', e => {
  const tile = e.target.closest('[data-fav-order]'), strip = tile && tile.closest('[data-fav-strip]');
  if (!tile || !strip || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.stopImmediatePropagation();
  const press = favoritePress = {tile, strip, x: e.clientX, y: e.clientY, pointerId: e.pointerId};
  press.timer = setTimeout(() => {
    if (favoritePress !== press || !tile.isConnected) return;
    favoriteDrag = {tile, strip, pointerId: press.pointerId, moved: false};
    tile.classList.add('fav-dragging');
    tile.setPointerCapture(press.pointerId);
    favoritePress = null;
    if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
  }, 300);
});
document.addEventListener('pointermove', e => {
  if (favoritePress && !favoriteDrag){
    if (e.pointerId !== favoritePress.pointerId) return;
    if (Math.hypot(e.clientX - favoritePress.x, e.clientY - favoritePress.y) > 10){
      clearTimeout(favoritePress.timer); favoritePress = null;
    }
    return;
  }
  if (!favoriteDrag || e.pointerId !== favoriteDrag.pointerId) return;
  e.preventDefault();
  const {tile, strip} = favoriteDrag, rect = strip.getBoundingClientRect();
  if (e.clientX < rect.left + 28) strip.scrollLeft -= 8;
  else if (e.clientX > rect.right - 28) strip.scrollLeft += 8;
  const target = [...strip.querySelectorAll('[data-fav-order]')].find(x => x !== tile && e.clientX < x.getBoundingClientRect().left + x.getBoundingClientRect().width / 2);
  if (target !== tile.nextElementSibling) {
    strip.insertBefore(tile, target || null);
    favoriteDrag.moved = true;
  }
});
function finishFavoriteDrag(e, cancelled = false){
  if (favoritePress && e.pointerId === favoritePress.pointerId){ clearTimeout(favoritePress.timer); favoritePress = null; }
  const drag = favoriteDrag;
  if (!drag || e.pointerId !== drag.pointerId) return;
  favoriteDrag = null;
  drag.tile.classList.remove('fav-dragging');
  if (cancelled){ render(); return; }
  if (!drag.moved) return;
  const movedKeys = [...drag.strip.querySelectorAll('[data-fav-order]')].map(x => x.dataset.favOrder);
  const movedSet = new Set(movedKeys);
  let next = 0;
  favoriteOrder = favEntries().map(([kind, x, b]) => {
    const key = kind === 'box' ? `b:${x.id}` : `i:${b.id}:${x.id}`;
    return movedSet.has(key) ? movedKeys[next++] : key;
  });
  suppressFavoriteClick = true;
  setTimeout(() => { suppressFavoriteClick = false; }, 500);
  metaPutRaw('favoriteOrder', favoriteOrder).catch(() => toast(tr('cantSave')));
  render();
}
document.addEventListener('pointerup', e => finishFavoriteDrag(e));
document.addEventListener('pointercancel', e => finishFavoriteDrag(e, true));

function backupBanner(){ return ''; }
function backupBannerOld(){
  const items = boxes.reduce((s, b) => s + (b.items || []).length, 0);
  if (!items) return '';
  const days = lastBackup ? (Date.now() - new Date(lastBackup)) / 864e5 : Infinity;
  if (days < 30) return '';
  return `<p class="backuphint"><span>${esc(tr('backupHint', lastBackup ? fmtDate(lastBackup) : ''))}</span> <button class="linkbtn" data-act="backup">${tr('backupDo')}</button></p>`;
}
function itemRow(it, b){
  const p = (it.photos || [])[0];
  const img = p ? imgTag(p.ref, 'thumb') : `<span class="thumb none icon" aria-hidden="true">${guessIcon(it)}</span>`;
  const sub = [itemOwner(it), it.size, showColor(it.color), it.category].filter(Boolean).join(', ');
  return `<li><button class="item" data-item="${esc(it.id)}" data-box="${esc(b.id)}">${img}<span class="item-main"><span class="item-name">${esc(it.name)}</span><span class="item-sub">${esc(sub)}</span></span></button></li>`;
}
function notesHTML(list, title){
  if (!list.length) return '';
  return `<section class="notes"><h2 class="section">${esc(title)}</h2>${list.map(n => `<div class="note">
    <audio controls preload="none" data-note="${esc(n.id)}"></audio>
    <span class="hint">${esc(fmtStamp(n.createdAt))}, ${n.duration} s${n.by ? `, ${esc(n.by)}` : ''}</span>
    <button class="linkbtn" data-notedel="${esc(n.id)}">${tr('del')}</button></div>`).join('')}</section>`;
}
function boxDocumentsHTML(b){
  if (b.loose) return '';
  const docs = b.documents || [];
  const items = boxes.flatMap(owner => (owner.items || []).map(it => ({it, owner})))
    .sort((a, z) => a.it.name.localeCompare(z.it.name, lang));
  const options = doc => `<option value="">${tr('notLinked')}</option>${items.map(({it, owner}) => `<option value="${esc(it.id)}" ${doc.itemId === it.id ? 'selected' : ''}>${esc(it.name)} · ${esc(placeName(owner.placeId))}${owner.loose ? '' : ` · ${esc(owner.code)}`}</option>`).join('')}`;
  return `<section class="boxdocuments"><h2 class="section">${tr('documents')}</h2>
    ${docs.length ? docs.map(doc => `<div class="docrow">
      <button class="docopen" data-doc-open="${esc(doc.id)}" data-doc-box="${esc(b.id)}">${ICON.eye}<span>${esc(doc.name)}</span></button>
      <select data-doc-link="${esc(doc.id)}" aria-label="${esc(tr('linkToItem'))}">${options(doc)}</select>
      <button class="x" data-doc-remove="${esc(doc.id)}" data-doc-box="${esc(b.id)}" aria-label="${esc(tr('remove'))}">×</button>
    </div>`).join('') : `<p class="hint">${tr('noDocuments')}</p>`}
    <label class="btn quiet small docadd">${tr('addDocument')}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" data-doc-file data-doc-box="${esc(b.id)}" hidden multiple></label>
  </section>`;
}
const noteUrls = new Map();
function hydrateNotes(root){
  root.querySelectorAll('audio[data-note]').forEach(a => {
    const n = notes.find(x => x.id === a.dataset.note); if (!n || !n.blob) return;
    if (!noteUrls.has(n.id)) noteUrls.set(n.id, URL.createObjectURL(n.blob));
    a.src = noteUrls.get(n.id);
  });
}
function placesSheet(){
  openSheet(`<h3>${tr('storagePlaces')}</h3>
    <p class="hint">${tr('placesHint')}</p>
    <div id="plList"></div>
    <div class="vtype"><input class="input" id="plName" placeholder="${esc(tr('placeNameHint'))}" autocapitalize="sentences"><button class="btn primary" id="plAdd">${tr('add')}</button></div>
    <div class="sheet-foot"><button class="btn primary" id="plClose">${tr('done')}</button></div>`);
  const draw = () => {
    $('#plList').innerHTML = places.map(p => {
      const n = boxes.filter(b => b.placeId === p.id).reduce((s, b) => s + (b.loose ? 0 : 1) + (b.items || []).length, 0);
      return `<div class="prow"><span>${esc(p.name)}</span><span><button class="linkbtn" data-plren="${esc(p.id)}">${tr('rename')}</button>${places.length > 1 && !n ? ` <button class="linkbtn" data-pldel="${esc(p.id)}">${tr('remove')}</button>` : ''}</span></div>`;
    }).join('');
  };
  draw();
  const add = () => { const p = addPlace($('#plName').value); $('#plName').value = ''; if (p){ draw(); render(); } };
  $('#plAdd').onclick = add;
  $('#plName').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  $('#plList').onclick = e => {
    const r = e.target.closest('[data-plren]'), d = e.target.closest('[data-pldel]');
    if (r){ const p = findPlace(r.dataset.plren); askText(tr('renameX', p.name), {value: p.name, ok: tr('save')}).then(n => { if (n){ p.name = n; metaPut('places', places).catch(() => {}); } render(); placesSheet(); }); }
    if (d){ places = places.filter(p => p.id !== d.dataset.pldel); boxes.filter(b => b.loose && b.placeId === d.dataset.pldel).forEach(b => removeBox(b.id)); if (currentPlace === d.dataset.pldel) setPlace('all'); metaPut('places', places).catch(() => {}); draw(); render(); }
  };
  $('#plClose').onclick = closeSheet;
}
async function deleteNote(id){
  if (!(await askConfirm(tr('delNoteQ')))) return;
  notes = notes.filter(n => n.id !== id);
  if (noteUrls.has(id)){ URL.revokeObjectURL(noteUrls.get(id)); noteUrls.delete(id); }
  await noteDel(id).catch(e => toast(saveErr(e))); updateStatus(); render();
}
function settingsAction(k){
  if (k === 'import') return $('#importFile').click();
  if (k === 'backup') return backup();
  if (k === 'people') return peopleSheet();
  if (k === 'report') return insuranceReport();
  if (k === 'labels') return realBoxes().length ? labels(realBoxes()) : toast(lang === 'sv' ? 'Lägg till några lådor först.' : 'Add some boxes first.');
  if (k === 'places') return placesSheet();
  if (k === 'ai') return aiSheet();
  if (k === 'scan') return scanSheet();
  if (k === 'export') return exportSheet();
  if (k === 'trash') return trashSheet();
  if (k === 'blanklabels') return blankLabels();
  if (k === 'move'){ closeSheet(); return navigate({name: 'move'}); }
  if (k === 'loans'){ closeSheet(); return navigate({name: 'loans'}); }
  if (k === 'cloud') return cloudSheet();
  if (k === 'login') return cloudSheet();
  if (k === 'feedback') return feedbackSheet();
  if (k === 'admin') return adminSheet();
  if (k === 'install') return installApp();
}

app.addEventListener('click', e => {
  if (suppressPlaceClick && e.target.closest('[data-place-card]')){ e.preventDefault(); e.stopImmediatePropagation(); suppressPlaceClick = false; return; }
  if (suppressFavoriteClick && e.target.closest('[data-fav-order]')){ e.preventDefault(); e.stopImmediatePropagation(); suppressFavoriteClick = false; return; }
  if (lpFired){ lpFired = false; e.preventDefault(); return; }
  const pe = e.target.closest('[data-place-edit]'); if (pe){ e.preventDefault(); e.stopPropagation(); return lpMenu('place:' + pe.dataset.placeEdit); }
  const pv = e.target.closest('[data-pview]'); if (pv){ placeView = pv.dataset.pview; track('place_view', {v: placeView}); metaPut('placeView', placeView).catch(() => {}); return render(); }
  const zm = e.target.closest('[data-zmove]'); if (zm) return moveZone(currentPlace, zm.dataset.zmove, +zm.dataset.dir);
  const zr = e.target.closest('[data-zrename]'); if (zr) return renameZone(currentPlace, zr.dataset.zrename);
  const zd = e.target.closest('[data-zdel]'); if (zd) return deleteZone(currentPlace, zd.dataset.zdel);
  const sm = e.target.closest('[data-shelfmode]'); if (sm){ shelfMode = sm.dataset.shelfmode; metaPut('shelfMode', shelfMode).catch(() => {}); return render(); }
  const vm = e.target.closest('[data-viewmode]'); if (vm){ viewMode = vm.dataset.viewmode; metaPut('viewMode', viewMode).catch(() => {}); return render(); }
  const mb = e.target.closest('[data-mapbox]'); if (mb){ const bx = findBox(mb.dataset.mapbox); if (bx && bx.loose) return showOnMap([], [mb.dataset.mapitem].filter(Boolean)); return showOnMap([mb.dataset.mapbox]); }
  const mc = e.target.closest('[data-mapcoll]'); if (mc){ const c = collectionsAll().find(x => x.tag === view.tag); if (!c) return; const inP = c.list.filter(([, b]) => b.placeId === mc.dataset.mapcoll); return showOnMap(inP.filter(([, b]) => !b.loose).map(([, b]) => b.id), inP.filter(([, b]) => b.loose).map(([it]) => it.id)); }
  const co = e.target.closest('[data-coll]'); if (co){ if (flushItem) flushItem(); return navigate({name: 'collection', tag: co.dataset.coll}); }
  const ao = e.target.closest('[data-askout]'); if (ao){ const k = ao.dataset.askout, itId = view.hl, bid = view.boxId; view.asked = true; if (k === 'temp') return setOut(bid, itId, true); if (k === 'gone') return deleteWithUndo(bid, itId); return render(); }
  const nu = e.target.closest('[data-nudge]'); if (nu) return doNudge(nu.dataset.nudge, !!nu.dataset.ny);
  const bo = e.target.closest('[data-backok]'); if (bo){ const [bid, iid] = bo.dataset.backok.split(':'); return setOut(bid, iid, false); }
  const sf = e.target.closest('[data-space-fold]'); if (sf){ const id = sf.dataset.spaceFold; foldedPlaces.has(id) ? foldedPlaces.delete(id) : foldedPlaces.add(id); saveFoldedPlaces(); return render(); }
  const fo = e.target.closest('[data-fold]'); if (fo){ const id = fo.dataset.fold; folded.has(id) ? folded.delete(id) : folded.add(id); saveFolded(); return render(); }
  const fa = e.target.closest('[data-foldall]'); if (fa){ const ids = orderedGroups(currentPlace).map(b => b.id); if (fa.dataset.foldall === '1') ids.forEach(i => folded.add(i)); else ids.forEach(i => folded.delete(i)); saveFolded(); track('fold_all'); return render(); }
  const so = e.target.closest('[data-sort]'); if (so){ listSort = so.dataset.sort; track('sort', {by: listSort}); metaPut('listSort', listSort).catch(() => {}); return render(); }
  const ft = e.target.closest('[data-favtoggle]'); if (ft){ const [bid, iid] = ft.dataset.favtoggle.split(':'); const nb = clone(findBox(bid)), x = nb && nb.items.find(i => i.id === iid); if (!x) return; x.fav = !x.fav; putBox(nb); return; }
  const mo = e.target.closest('[data-more]'); if (mo){ const [bid, iid] = mo.dataset.more.split(':'); return rowMenu(bid, iid); }
  const qa = e.target.closest('[data-quickadd]'); if (qa){ let id = qa.dataset.quickadd; if (id.startsWith('new:')) id = ensureLoose(id.slice(4)).id; quickAddFor = quickAddFor === id ? null : id; render(); setTimeout(() => { const i = $('#qaIn'); if (i) i.focus(); }, 40); return; }
  const t = e.target.closest('[data-nav],[data-goplace],[data-open],[data-item],[data-act],[data-notedel],[data-sub],[data-m],[data-viewph],[data-rmph],[data-viewfile],[data-rmfile],[data-rmtag],[data-used],[data-sell],[data-addopt]'); if (!t) return;
  const d = t.dataset;
  if (d.nav){ let v = JSON.parse(d.nav); if (v.name === 'home') v = {name: 'home', place: v.place || 'all'};
    for (let i = backStack.length - 1; i >= 0; i--) if (sameView(backStack[i], v)) return go(backStack[i], {backIndex: i});
    if (v.name === 'home') return goHome(v.place === 'all' ? null : v.place); return navigate(v); }
  if (d.goplace) return goHome(d.goplace === 'all' ? null : d.goplace);
  if (selecting && (d.item || d.open) && !d.openItem){ const key = d.item ? `i:${d.box}:${d.item}` : `b:${d.open}`; if (d.open) return; selecting.has(key) ? selecting.delete(key) : selecting.add(key); return render(); }
  if (d.open) return openBox(d.open);
  if (view.name === 'search' && query) rememberQuery(query);
  if (d.item) return navigate({name: 'item', boxId: d.box, itemId: d.item});
  if (d.notedel) return deleteNote(d.notedel);
  if (d.sub) return navigate({name: 'profile', sub: d.sub});
  if (d.m) return settingsAction(d.m);
  if (d.viewph) return openViewer(d.viewph);
  if (d.addopt){ if (flushItem) flushItem(); shownOpt.add(d.addopt); render(); setTimeout(() => { const el = app.querySelector(`[data-f="${d.addopt}"]`); if (el) el.focus(); }, 50); return; }
  if (d.rmph !== undefined){ const [it] = curItem(); const p = it.photos[+d.rmph]; askConfirm(tr('rmPhotoQ'), tr('remove')).then(y => { if (!y) return; saveItem(x => { x.photos = x.photos.filter(q => q.ref !== p.ref); }, true); dropEditedAttachment(p.ref); }); return; }
  if (d.viewfile !== undefined){ const [it] = curItem(); return openFile(it.files[+d.viewfile]); }
  if (d.rmfile !== undefined){ const [it] = curItem(); const f = it.files[+d.rmfile]; askConfirm(tr('rmQ', f.name), tr('remove')).then(y => { if (!y) return; saveItem(x => { x.files = x.files.filter(q => q.ref !== f.ref); }, true); dropEditedAttachment(f.ref); }); return; }
  if (d.rmtag !== undefined){ const [it] = curItem(); const tg = it.tags[+d.rmtag]; askConfirm(tr('rmTagQ', tg), tr('remove')).then(y => { if (y) saveItem(x => { x.tags = x.tags.filter(q => q !== tg); }, true); }); return; }
  if (d.used || d.sell){
    const [bid, iid] = (d.used || d.sell).split(':'); const b = findBox(bid); if (!b) return;
    const nb = clone(b), x = nb.items.find(i => i.id === iid); if (!x) return;
    if (d.used) x.lastUsed = today(); else x.status = 'For sale';
    x.updatedAt = new Date().toISOString(); putBox(nb); toast(d.used ? tr('usedNoted') : tr('markedSale'));
    return;
  }
  const b = findBox(view.boxId);
  switch (d.act){
    case 'addplace': askText(tr('newPlace'), {placeholder: tr('newPlaceHint'), ok: tr('add')}).then(n => { const p = n && addPlace(n); if (p) goHome(p.id); }); break;
    case 'addhere': addNavSheet(d.pid || scopePlace() || places[0].id); break;
    case 'additem': newItem(b.id); break;
    case 'batch': openBatch(b.id); break;
    case 'batchcancel': finishBatch(false); break;
    case 'batchadd': finishBatch(true); break;
    case 'editbox': boxSheet(b.id); break;
    case 'label': labelMenu(b); break;
    case 'boxphoto': openViewer(b.photo.ref); break;
    case 'backup': backup(); break;
    case 'moveitem': moveItemSheet(view.boxId, view.itemId); break;
    case 'delitem': deleteItem(view.boxId, view.itemId); break;
    case 'aisuggest': suggestFromPhoto(); break;
    case 'done': finishItem(false); break;
    case 'favitem': if (flushItem) flushItem(); saveItem(x => { x.fav = !x.fav; }, true); break;
    case 'sharewhere': { if (flushItem) flushItem(); const [it2, b2] = curItem(); if (it2) shareWhere(it2, b2); break; }
    case 'favbox': { const nb = clone(b); nb.fav = !b.fav; putBox(nb); break; }
    case 'selectmode': selecting = new Set(); render(); break;
    case 'selcancel': selecting = null; render(); break;
    case 'selmove': selMove(); break;
    case 'seldel': selDelete(); break;
    case 'seltag': selTag(); break;
    case 'checkyes': checkBox(b.id); break;
    case 'checkno': view.checkDismissed = true; render(); toast(tr('checkFix')); break;
    case 'boxout': setBoxOut(b.id, true); break;
    case 'boxback': setBoxOut(b.id, false); break;
    case 'collout': { const c = collectionsAll().find(x => x.tag === view.tag); if (c) setOutMany(c.list, true, null, '#' + tagLabel(c.tag)); break; }
    case 'collback': { const c = collectionsAll().find(x => x.tag === view.tag); if (c) setOutMany(c.list, false, null, '#' + tagLabel(c.tag)); break; }
    case 'clearrq': recentQ = []; metaPut('recentQ', recentQ).catch(() => {}); render(); break;
    case 'pickicon': iconSheet(); break;
    case 'install': installApp(); break;
    case 'movestart': case 'movenew': case 'moveadd': case 'movelabels': case 'moverooms': case 'moveend': moveAction(d.act); break;
    case 'gomove': navigate({name: 'move'}); break;
    case 'scanbarcode': scanItemBarcode(); break;
    case 'newboxin': addNavSheet(d.pid || scopePlace()); break;
    case 'noinstall': try { sessionStorage.setItem('noInstall', '1'); } catch {} render(); break;
    case 'ics': { if (flushItem) flushItem(); const [it3, b3] = curItem(); if (it3) calendarFile(it3, b3); break; }
    case 'moveitem2': if (flushItem) flushItem(); moveItemSheet(view.boxId, view.itemId); break;
    case 'itemout': if (flushItem) flushItem(); setOut(view.boxId, view.itemId, true); break;
    case 'itemback': if (flushItem) flushItem(); setOut(view.boxId, view.itemId, false); break;
    case 'qadone': { const i = $('#qaIn'); if (i && i.value.trim()) quickAdd(i.dataset.qa, i.value); quickAddFor = null; render(); break; }
    case 'addinbox': addHereSheet(b.placeId, b.id); break;
    case 'placement': placementSheet(b.id); break;
    case 'doorside': doorSheet(currentPlace); break;
    case 'newzone': addZone(currentPlace); break;
    case 'addloose': newItem(ensureLoose(d.pid || currentPlace).id); break;
    case 'addzone': boxSheet(null, currentPlace !== 'all' ? currentPlace : places[0].id, null, d.zone); break;
    case 'saveagain': finishItem(true); break;
    case 'cancelitem': cancelItem(); break;
    case 'addtag': if (flushItem) flushItem(); askText(tr('newTag'), {placeholder: tr('tagHint'), ok: tr('add')}).then(tg => { if (tg) saveItem(x => { x.tags = [...new Set([...(x.tags || []), tg.toLowerCase()])]; }, true); }); break;
  }
});
document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  if (b.dataset.tab === 'add') return addNavSheet();
  if (b.dataset.tab === 'home') return goHome(currentPlace !== 'all' ? currentPlace : null);
  if (b.dataset.tab === 'search'){ navigate({name: 'search'}); return; }
  navigate({name: 'profile'});
});
/* the dot on the menu button: something needs attention */
$('#logoBtn').innerHTML = logoSVG();
$('#logoBtn').onclick = () => goHome(null);
$('#backBtn').onclick = () => goBack();
$('#spaceBtn').onclick = () => spaceSheet();
$('#menuBtn').onclick = () => menuSheet();
$('#talkBtn').onclick = () => voiceSheet();

/* ---------- sheets ---------- */
const sheet = $('#sheet');
let onSheetClose = null;
function openSheet(html, onClose){
  if (sheet.open){ const f = onSheetClose; onSheetClose = null; sheet.close(); if (f) f(); }
  sheet.innerHTML = `<div class="sheet">${html}</div>`;
  onSheetClose = onClose || null;
  sheet.showModal();
  const ae = document.activeElement; if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && sheet.contains(ae)) ae.blur();
}
function closeSheet(){ if (sheet.open) sheet.close(); }
sheet.addEventListener('close', () => { if (sheet.open) return; const f = onSheetClose; onSheetClose = null; if (f) f(); });
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function photoState(initial, multiple){
  let accepting = true;
  const st = {photos: clone(initial), added: [], removed: [], busy: false};
  const draw = () => {
    const w = $('#phwrap');
    w.innerHTML = `<div class="photos">${st.photos.map((p, i) => `<div class="ph">${imgTag(p.ref, '')}<button data-rm="${i}" aria-label="${tr('rmPhoto')}">×</button></div>`).join('')}
      ${multiple || !st.photos.length ? `<label class="addph">${tr('addPhoto')}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" ${multiple ? 'multiple' : ''}></label>` : ''}</div>`;
    hydrate(w);
  };
  st.mount = () => {
    draw();
    $('#phwrap').addEventListener('change', async e => {
      if (!e.target.files) return;
      const files = [...e.target.files]; e.target.value = ''; if (!files.length) return; st.busy = true;
      $('#phwrap').insertAdjacentHTML('beforeend', `<p class="hint">${tr('savingPhoto')}</p>`);
      for (const f of files){
        try {
          const p = await storePhoto(f);
          if (!accepting){ dropPhoto(p.ref); continue; }
          st.photos.push(p); st.added.push(p.ref);
        }
        catch (err) { toast(saveErr(err)); }
      }
      st.busy = false; if (accepting) draw();
    });
    $('#phwrap').addEventListener('click', e => {
      const im = e.target.closest('img[data-ph]'); if (im) return openViewer(im.dataset.ph);
      const rm = e.target.closest('[data-rm]'); if (!rm) return;
      const [p] = st.photos.splice(+rm.dataset.rm, 1);
      if (st.added.includes(p.ref)){ st.added = st.added.filter(r => r !== p.ref); dropPhoto(p.ref); } else st.removed.push(p.ref);
      draw();
    });
  };
  st.commit = () => { accepting = false; st.removed.forEach(dropPhoto); st.added = []; st.removed = []; };
  st.discard = () => { accepting = false; st.added.forEach(dropPhoto); st.added = []; };
  return st;
}

function boxSheet(id, presetPid, presetParent, presetZone, presetShelf){
  const existing = id ? findBox(id) : null;
  const b = existing ? clone(existing) : {id: newId(), code: '', name: '', location: '', notes: '', items: [], createdAt: new Date().toISOString(), placeId: presetPid || scopePlace() || places[0].id, parentId: presetParent || null, autoName: true};
  if (presetParent && findBox(presetParent)) b.placeId = findBox(presetParent).placeId;
  if (!existing) b.code = nextCode(b.placeId);
  if (!existing && presetZone) b.location = presetZone;
  if (!existing && presetShelf) b.shelf = presetShelf;
  const bt = b.boxType || 'moving', bd = b.boxDims || RK_TYPES.moving;
  const ps = photoState(b.photo ? [b.photo] : [], false);
  const banned = existing ? new Set([existing.id, ...descendants(existing.id).map(x => x.id)]) : new Set();
  const parentOpts = pid => `<option value="">${esc(tr('topLevel', placeName(pid)))}</option>` + boxesIn(pid).filter(x => !banned.has(x.id)).sort(byCode).map(x => `<option value="${esc(x.id)}" ${x.id === b.parentId ? 'selected' : ''}>${esc(x.code)} ${esc(x.name)}</option>`).join('');
  let saved = false;
  openSheet(`<h3>${existing ? tr('editBoxH') : tr('newBox')} <span class="chip" id="bCode">${esc(b.code)}</span></h3>
    <label class="field compact"><span>${tr('name')}</span><input id="bName" value="${esc(b.autoName ? '' : b.name)}" placeholder="${esc(tr('nameOptional'))}"></label>
    <div class="row2">
      <label class="field"><span>${tr('storagePlace')}</span><select id="bPlace">${places.map(p => `<option value="${esc(p.id)}" ${p.id === b.placeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field"><span>${tr('inside')}</span><select id="bParent">${parentOpts(b.placeId)}</select></label>
    </div>
    <label class="field"><span>${tr('zone')}</span><input id="bLoc" list="bzones" value="${esc(b.location)}" placeholder="${esc(tr('zoneHint'))}"><datalist id="bzones">${zonesOf(b.placeId).filter(Boolean).map(z => `<option value="${esc(z)}">`).join('')}</datalist></label>
    <label class="field"><span>${tr('status')}</span><select id="bStatus">${statusOptions(b.status || '')}</select><input id="bCustomStatus" value="${esc(b.status && !STATUS_KEYS[b.status] ? b.status : '')}" placeholder="${esc(tr('customStatus'))}" ${b.status && !STATUS_KEYS[b.status] ? '' : 'hidden'}></label>
    <label class="field"><span>${tr('rk_boxType')}</span><select id="bType">${['moving', 'banana', 'small', 'custom'].map(k => `<option value="${k}" ${bt === k ? 'selected' : ''}>${tr('rk_bt_' + k)}</option>`).join('')}</select></label>
    <div class="rkdims" id="bDims" ${bt === 'custom' ? '' : 'hidden'}>${['w', 'h', 'd'].map(k => `<label class="field"><span>${tr('rk_' + k)} (cm)</span><input id="bD${k}" type="number" inputmode="numeric" value="${esc(bd[k])}"></label>`).join('')}</div>
    <label class="field"><span>${tr('notes')}</span><textarea id="bNotes">${esc(b.notes)}</textarea></label>
    <div class="field"><span>${tr('boxPhoto')}</span><div id="phwrap"></div></div>
    <div class="sheet-foot">
      ${existing ? `<button class="btn danger" id="bDel">${tr('delBox')}</button><span class="spacer"></span>` : ''}
      <button class="btn quiet" id="bCancel">${tr('cancel')}</button>
      <button class="btn primary" id="bSave">${existing ? tr('saveBox') : tr('addBox')}</button>
    </div>`, () => { if (!saved) ps.discard(); });
  ps.mount();
  $('#bPlace').onchange = e => { const pid = e.target.value; $('#bParent').innerHTML = parentOpts(pid); if (!existing){ b.code = nextCode(pid); $('#bCode').textContent = b.code; } };
  $('#bStatus').onchange = e => {
    const custom = $('#bCustomStatus');
    custom.hidden = e.target.value !== '__custom__' && (!e.target.value || !!STATUS_KEYS[e.target.value]);
    if (e.target.value === '__custom__'){ custom.hidden = false; custom.focus(); }
  };
  $('#bCancel').onclick = closeSheet;
  let typeSet = !!b.boxTypeSet;
  $('#bType').onchange = e => { typeSet = true; $('#bDims').hidden = e.target.value !== 'custom'; };
  $('#bSave').onclick = () => {
    if (ps.busy) return toast(tr('waitPhoto'));
    b.boxType = $('#bType').value; if (typeSet) b.boxTypeSet = true;
    if (b.boxType === 'custom'){ const v = k => parseInt($('#bD' + k).value, 10); const dm = {w: v('w'), h: v('h'), d: v('d')}; if (!(dm.w > 0 && dm.h > 0 && dm.d > 0 && dm.w < 400 && dm.h < 400 && dm.d < 400)) return toast(tr('rk_badSize')); b.boxDims = dm; }
    if (existing && $('#bPlace').value !== existing.placeId) delete b.shelf;
    const name = $('#bName').value.trim();
    const newPlace = $('#bPlace').value, parent = $('#bParent').value || null;
    if (existing && newPlace !== existing.placeId && numbering === 'place' && realBoxes().some(x => x.placeId === newPlace && x.code === b.code && x.id !== b.id)) b.code = nextCode(newPlace);
    b.autoName = !name; b.name = name || autoBoxName(b);
    const zoneWas = (b.location || '').trim();
    b.location = $('#bLoc').value.trim(); b.notes = $('#bNotes').value.trim(); b.placeId = newPlace; b.parentId = parent;
    b.status = $('#bStatus').value === '__custom__' ? $('#bCustomStatus').value.trim() : $('#bStatus').value;
    if (!b.status) delete b.status;
    if (parent) delete b.shelf;
    if (!existing || zoneWas !== b.location){ const others = mapEntities(newPlace).filter(e => e.k !== 'b:' + b.id && e.zone === b.location); b.stack = Math.max(0, ...others.map(e => e.stack)) + 1; b.level = 1; }
    b.photo = ps.photos[0] || null;
    ps.commit(); saved = true;
    if (existing && existing.placeId !== newPlace) descendants(existing.id).forEach(d => { const nd = clone(d); nd.placeId = newPlace; putBox(nd, true); });
    putBox(b);
    if (parent){ const pb = findBox(parent); if (pb && pb.autoName) putBox(clone(pb), true); }
    closeSheet();
    if (!existing){ openBox(b.id); toast(`${b.code} ✓`); } else render();
  };
  if (existing) $('#bDel').onclick = async () => {
    const n = (existing.items || []).length;
    if (!(await askConfirm(tr('delQ', `${existing.code} ${existing.name}${n ? ` (${n} ${n === 1 ? tr('item') : tr('items')})` : ''}`)))) return boxSheet(existing.id);
    saved = true; ps.discard();
    const kids = childBoxes(existing.id);
    kids.forEach(k => { const nk = clone(k); nk.parentId = existing.parentId || null; putBox(nk, true); });
    removeBox(existing.id);
    if (existing.photo) dropPhoto(existing.photo.ref);
    (existing.documents || []).forEach(d => dropPhoto(d.ref));
    toTrash((existing.items || []).map(i => [i, existing]));
    if (existing.parentId){ const pb = findBox(existing.parentId); if (pb && pb.autoName) putBox(clone(pb), true); }
    toast(`${existing.code} ✕`);
    if (view.name === 'box' && (view.boxId === existing.id)) view = existing.parentId ? {name: 'box', boxId: existing.parentId} : {name: 'home', place: existing.placeId};
    render();
  };
}
/* ---------- item details: owner, size, colour and more, depending on what the item is ---------- */
const KINDS = {
  clothes: ['🧥','👗','🧣','🧢','👕'], shoes: ['🥾','👟'], kids: ['👶','🧸'],
  sports: ['🎿','⛸️','🛷','🚲','🛴','🏒','🎾','⚽','🎣','🏋️'],
  tech: ['📺','💻','🖨️','📱','🎧','🔊','🔌','📷','🎮'], tools: ['🛠️','🪜','🧹','🔩'], music: ['🎸','🎹','🥁','🎻'],
};
const KIND_FIELDS = {
  clothes: ['owner','size','color','season'], shoes: ['owner','size','color','season'], kids: ['owner','size','color'],
  sports: ['owner','size','brand'], tech: ['brand','model','serial'], tools: ['brand','model','serial'],
  music: ['owner','brand','model','serial'], other: ['owner','color','brand'],
};
const ALL_FIELDS = ['owner','size','color','season','brand','model','serial'];
const FIELD_LABEL = {owner: 'Whose is it', size: 'Size', color: 'Colour', season: 'Season', brand: 'Brand', model: 'Model', serial: 'Serial number'};
const COLORS = ['Black','White','Grey','Blue','Red','Green','Yellow','Pink','Purple','Brown','Beige','Multicolour'];
const SEASONS = ['Winter','Summer','Spring/autumn','All year'];
function kindOf(it){ const ic = guessIcon(it); for (const k in KINDS) if (KINDS[k].includes(ic)) return k; return 'other'; }
function recentValues(field, kind){
  const out = [];
  boxes.forEach(b => (b.items || []).forEach(i => { if (i[field] && (!kind || kindOf(i) === kind) && !out.includes(i[field])) out.push(i[field]); }));
  return out.slice(-6);
}
function chipsFor(field, kind){
  if (field === 'owner') return [...household, 'Shared'];
  if (field === 'color') return COLORS;
  if (field === 'season') return SEASONS;
  if (field === 'size') return [...new Set([...recentValues('size', kind), ...(kind === 'clothes' ? ['XS','S','M','L','XL','XXL'] : [])])];
  if (field === 'brand') return recentValues('brand');
  return [];
}
function detailsHTML(attrs, kind, moreOpen){
  const main = KIND_FIELDS[kind], rest = ALL_FIELDS.filter(f => !main.includes(f));
  const field = k => {
    const v = attrs[k] || '', chips = chipsFor(k, kind);
    return `<div class="field" data-f="${k}"><span>${FIELD_LABEL[k]}</span>
      <input data-attr="${k}" value="${esc(v)}" ${k === 'serial' ? 'autocapitalize="characters"' : ''} ${k === 'size' ? 'inputmode="text"' : ''}>
      ${chips.length || k === 'owner' ? `<div class="chips">${chips.map(c => `<button type="button" class="chipbtn${v.toLowerCase() === c.toLowerCase() ? ' on' : ''}" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}${k === 'owner' ? '<button type="button" class="chipbtn add" data-addperson>+ Person</button>' : ''}</div>` : ''}
    </div>`;
  };
  return main.map(field).join('') + `<details class="more" ${moreOpen ? 'open' : ''}><summary>${tr('moreDetails')}</summary>${rest.map(field).join('')}</details>`;
}
function addPerson(name){
  name = (name || '').trim(); if (!name) return '';
  const hit = household.find(h => h.toLowerCase() === name.toLowerCase()); if (hit) return hit;
  household.push(name); metaPut('household', household).catch(() => {}); return name;
}
function recordRecentOwners(names){
  const clean = names.filter(n => n !== 'Shared');
  if (!clean.length) return;
  recentOwners = [...new Set([...clean, ...recentOwners])].slice(0, 20);
  metaPutRaw('recentOwners', recentOwners).catch(() => {});
}
function ownerSuggestions(placeId, item){
  const local = [];
  boxes.filter(b => b.placeId === placeId).forEach(b => (b.items || []).forEach(it => ownerNames(it).forEach(n => { if (!local.includes(n)) local.push(n); })));
  return [...new Set([...local, ...ownerNames(item), ...recentOwners, ...household, 'Shared'])];
}

/* ---------- people in the household ---------- */
function peopleSheet(){
  openSheet(`<h3>${tr('household')}</h3>
    <p class="hint">${tr('householdHint')}</p>
    <div id="plist"></div>
    <div class="vtype"><input id="pName" placeholder="Name" autocapitalize="words"><button class="btn primary" id="pAdd">Add</button></div>
    <label class="field" style="margin-top:6px"><span>${tr('whoPhone')}</span><select id="pMe"></select></label>
    <p class="proof">${tr('whoPhoneHint')}</p>
    <div class="sheet-foot"><button class="btn primary" id="pClose">Done</button></div>`);
  const draw = () => {
    $('#plist').innerHTML = household.length ? household.map((n, i) => `<div class="prow"><span>${esc(n)}</span><button class="iconbtn" data-pdel="${i}">${tr('remove')}</button></div>`).join('') : `<p class="hint">${tr('noOne')}</p>`;
    $('#pMe').innerHTML = `<option value="">${tr('notSet')}</option>` + household.map(n => `<option ${n === me ? 'selected' : ''}>${esc(n)}</option>`).join('');
  };
  draw();
  const add = () => { const n = addPerson($('#pName').value); $('#pName').value = ''; if (n) draw(); };
  $('#pAdd').onclick = add;
  $('#pName').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  $('#plist').onclick = e => {
    const d = e.target.closest('[data-pdel]'); if (!d) return;
    const [n] = household.splice(+d.dataset.pdel, 1); if (n === me){ me = ''; metaPut('me', '').catch(() => {}); }
    metaPut('household', household).catch(() => {}); draw();
  };
  $('#pMe').onchange = e => { me = e.target.value; metaPut('me', me).catch(() => {}); };
  $('#pClose').onclick = closeSheet;
}

/* ---------- scanning ---------- */
function scanSheet(){
  let stream = null, raf = 0, done = false;
  const stop = () => { done = true; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach(t => t.stop()); };
  openSheet(`<h3>${tr('scanH')}</h3>
    <video id="cam" playsinline muted></video>
    <p class="hint" id="camMsg">${tr('pointCam')}</p>
    <label class="field"><span>${tr('typeCode')}</span><input id="codeIn" placeholder="B-014" autocapitalize="characters"></label>
    <div class="sheet-foot"><button class="btn quiet" id="sClose">${tr('close')}</button><button class="btn primary" id="sGo">${tr('openBox')}</button></div>`, stop);
  $('#sClose').onclick = closeSheet;
  const go = raw => {
    const m = String(raw).toUpperCase().match(/B-?\s*(\d+)/);
    const b = m && boxByNum(parseInt(m[1]));
    if (!b){ toast(lang === 'sv' ? `Ingen låda med koden ${raw}.` : `No box with code ${raw}.`); return false; }
    closeSheet(); openBox(b.id); return true;
  };
  $('#sGo').onclick = () => go($('#codeIn').value);
  $('#codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') go(e.target.value); });
  const video = $('#cam');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ video.hidden = true; $('#camMsg').textContent = tr('noCam'); return; }
  navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}}).then(s => {
    if (done){ s.getTracks().forEach(t => t.stop()); return; }
    stream = s; video.srcObject = s; video.play();
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d', {willReadFrequently: true});
    const tick = () => {
      if (done) return;
      if (video.readyState >= 2 && video.videoWidth){
        const w = 480, h = Math.round(w * video.videoHeight / video.videoWidth);
        cv.width = w; cv.height = h; ctx.drawImage(video, 0, 0, w, h);
        const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {inversionAttempts: 'dontInvert'});
        if (r && r.data && handleScan(r.data)) return;
        if (r && r.data && r.data.startsWith('BOXES:') && go(r.data.slice(6))) return;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }).catch(() => { video.hidden = true; $('#camMsg').textContent = tr('camBlocked'); });
}

/* ---------- voice: commands that work without AI, plus voice notes ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const VT = {
  en: {
    needBox: 'Which box? Say “open box” and its number first.',
    opened: '{box}, {name}. {things} in it.',
    noBox: 'There’s no box {n}.',
    added: 'Added {list} to {box}.',
    askBoth: '{name}: what size, and whose is it?', askSize: '{name}: what size?', askOwner: '{name}: whose is it?',
    gotIt: 'Got it: {list}.', skipped: 'OK, skipping that.', didntGet: 'I didn’t catch that. Say a size or a name, or “skip”.',
    found1: '{name} is in {where}.', foundN: 'I found {n}: {list}.', foundMany: 'I found {n}. The first ones: {list}.',
    relatedOnly: 'Nothing called that exactly, but similar things: {list}.',
    notFound: 'I couldn’t find {q}.', contents: '{box} has {things}: {list}.', contentsMore: '{box} has {things}, including {list}.',
    which: 'Which one: {list}?', one: '1 thing', many: '{n} things',
    empty: '{box} is empty.', removed: 'Removed {name} from {box}.', notInBox: 'I can’t find {q} in {box}.',
    moved: 'Moved {name} to {box}.', undone: 'Undone.', nothingUndo: 'There’s nothing to undo.',
    unknown: 'I didn’t get that. Try “add …”, “where is …” or “what’s in here”.',
    itemOutV: '{name} is out. Its place in {box} is kept.', itemBackV: '{name} is back in {box}.', alreadyOut: '{name} is already out.', alreadyBack: '{name} is already in place.',
    boxOutV: '{box} is out. Its place is kept.', boxBackV: '{box} is back in place.', allBackIn: 'Everything is back in {box}.', collOutV: 'Took out {n} things in #{c}.', collBackV: 'Everything in #{c} is back.',
    unknownAdd: 'Did you want to add “{text}” to {box}?', and: 'and', in: 'in', box: 'box {n}', size: 'size {v}',
    boxesCreated: 'Created {n} boxes in {place}: {list}. {first} is open now.',
    whichBox: 'Which box: {list}?', oddSize: 'Size {v} sounds unusual. What size is it?',
    updated: '{name}: {list}.', renamed: 'Renamed {old} to {name}.', ok: 'Okay.',
    confirmMany: 'Create {n} boxes? Say yes or no.',
    notInBox: 'not in a box', oneBox: '1 box', manyBoxes: '{n} boxes',
    addedLoose: 'Added {list} to {place}, not in a box.',
    askPlace: 'Which place: {list}?', didntGetPlace: 'Which place? Say one of {list}, or “new place” and a name.',
    placeSummary: '{place} has {boxes}.', boxList: 'They are {list}.', looseList: 'Not in a box: {list}.',
    inPlace: 'You’re in {place}: {boxes}, and {things} not in a box.',
    placeCreated: 'Added the storage place {place}. You’re there now.',
    boxCreated: 'Created {box}, {name}, in {place}. It’s open, so tell me what goes in it. Mark the box {code}, or print its label later.',
    elsewhere: 'Not in {place}, but elsewhere:',
  },
  sv: {
    needBox: 'Vilken låda? Säg “öppna låda” och numret först.',
    opened: '{box}, {name}. {things} i den.',
    noBox: 'Det finns ingen låda {n}.',
    added: 'La till {list} i {box}.',
    askBoth: '{name}: vilken storlek, och vems är det?', askSize: '{name}: vilken storlek?', askOwner: '{name}: vems är det?',
    gotIt: 'Okej: {list}.', skipped: 'Okej, hoppar över det.', didntGet: 'Det uppfattade jag inte. Säg en storlek eller ett namn, eller “hoppa över”.',
    found1: '{name} ligger i {where}.', foundN: 'Jag hittade {n}: {list}.', foundMany: 'Jag hittade {n}. De första: {list}.',
    relatedOnly: 'Inget som heter exakt så, men liknande saker: {list}.',
    notFound: 'Jag hittade inte {q}.', contents: '{box} innehåller {things}: {list}.', contentsMore: '{box} innehåller {things}, bland annat {list}.',
    which: 'Vilken av dem: {list}?', one: '1 sak', many: '{n} saker',
    empty: '{box} är tom.', removed: 'Tog bort {name} från {box}.', notInBox: 'Jag hittar inte {q} i {box}.',
    moved: 'Flyttade {name} till {box}.', undone: 'Ångrat.', nothingUndo: 'Det finns inget att ångra.',
    unknown: 'Det förstod jag inte. Prova “lägg till …”, “var är …” eller “vad finns i lådan”.',
    itemOutV: '{name} är framme. Platsen i {box} sparas.', itemBackV: '{name} är tillbaka i {box}.', alreadyOut: '{name} är redan framme.', alreadyBack: '{name} ligger redan på sin plats.',
    boxOutV: '{box} är framme. Platsen sparas.', boxBackV: '{box} är tillbaka på sin plats.', allBackIn: 'Allt är tillbaka i {box}.', collOutV: 'Tog ut {n} saker i #{c}.', collBackV: 'Allt i #{c} är tillbaka.',
    unknownAdd: 'Ville du lägga till “{text}” i {box}?', and: 'och', in: 'i', box: 'låda {n}', size: 'storlek {v}',
    boxesCreated: 'Skapade {n} lådor i {place}: {list}. {first} är öppen nu.',
    whichBox: 'Vilken låda: {list}?', oddSize: 'Storlek {v} låter konstigt. Vilken storlek är det?',
    updated: '{name}: {list}.', renamed: 'Bytte namn på {old} till {name}.', ok: 'Okej.',
    confirmMany: 'Skapa {n} lådor? Säg ja eller nej.',
    notInBox: 'utan låda', oneBox: '1 låda', manyBoxes: '{n} lådor',
    addedLoose: 'La till {list} i {place}, utan låda.',
    askPlace: 'Vilken plats: {list}?', didntGetPlace: 'Vilken plats? Säg {list}, eller “ny plats” och ett namn.',
    placeSummary: '{place} har {boxes}.', boxList: 'Det är {list}.', looseList: 'Utan låda: {list}.',
    inPlace: 'Du är i {place}: {boxes}, och {things} utan låda.',
    placeCreated: 'La till förvaringsplatsen {place}. Du är där nu.',
    boxCreated: 'Skapade {box}, {name}, i {place}. Den är öppen, så säg vad du lägger i den. Märk lådan {code}, eller skriv ut etiketten senare.',
    elsewhere: 'Inte i {place}, men på ett annat ställe:',
  },
};
const HELP = {
  en: ['I’m in the garage','New box winter clothes','Open box 14','Add red ski jacket and two pairs of boots','Add Elsa’s winter boots size 32','Add bike without a box','What’s in here?','Where is the tent?','Where is the tent in the attic?','Do we have anything for camping?','Move the sleeping bag to box 3','Move the bike to the attic','Remove the drill','New place summer house','Open box 3, add tent and sleeping bag, then where is the bike?','Undo'],
  sv: ['Jag är i garaget','Ny låda vinterkläder','Öppna låda 14','Lägg till röd skidjacka och två par kängor','Lägg till Elsas vinterkängor storlek 32','Lägg till cykel utan låda','Vad finns i lådan?','Var är tältet?','Var är tältet på vinden?','Har vi något för camping?','Flytta sovsäcken till låda 3','Flytta cykeln till vinden','Ta bort borrmaskinen','Ny plats sommarstugan','Öppna låda 3, lägg till tält och sovsäck, sen var är cykeln?','Ångra'],
};
const L = () => voiceLang.startsWith('sv') ? 'sv' : 'en';
const t = (k, v = {}) => VT[L()][k].replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
const things = n => n === 1 ? t('one') : t('many', {n});
const joinList = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' ' + t('and') + ' ' + a[a.length - 1];
const boxSpoken = b => t('box', {n: parseInt(b.code.slice(2))});
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const W = '[a-zåäöéü0-9]';
const wordRe = (w, flags = 'i') => new RegExp(`(^|[^a-zåäöéü0-9])${escRe(w)}(?!${W})`, flags);

const NUMW = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
  sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,ett:1,en:1,etta:1,ettan:1,två:2,tvåa:2,tvåan:2,tre:3,trea:3,trean:3,fyra:4,fyran:4,
  fem:5,femma:5,femman:5,sex:6,sexa:6,sexan:6,sju:7,sjua:7,sjuan:7,åtta:8,åttan:8,nio:9,nia:9,nian:9,tio:10,tia:10,tian:10,elva:11,tolv:12,
  tretton:13,fjorton:14,femton:15,sexton:16,sjutton:17,arton:18,nitton:19,tjugo:20};
const toNum = s => /^\d+$/.test(s) ? +s : (NUMW[s] || null);
const boxByNum = n => { const hits = realBoxes().filter(b => parseInt(b.code.slice(2)) === n); const here = (typeof curBox === 'function' && curBox() && curBox().placeId) || scopePlace(); return hits.find(b => b.placeId === here) || hits[0]; };
function boxRef(text){
  const low = text.toLowerCase();
  let m = low.match(/(?:^|[^a-zåäö])(?:box|boxen|låda|lådan|kartong|kartongen)\s*(?:nummer|number|nr\.?)?\s*-?\s*(\d+|[a-zåäö]+)(?![a-zåäö0-9])/);
  if (!m) m = low.match(/(?:^|[^a-zåäö])b\s*-?\s*(\d+)(?![0-9])/);
  if (!m) return null;
  const n = toNum(m[1]); if (!n) return null;
  return {n, box: boxByNum(n), match: m[0]};
}
const COLOR_WORDS = {Black:['black','svart','svarta'],White:['white','vit','vita','vitt'],Grey:['grey','gray','grå','gråa','grått'],
  Blue:['blue','blå','blåa','blått'],Red:['red','röd','röda','rött'],Green:['green','grön','gröna','grönt'],Yellow:['yellow','gul','gula','gult'],
  Pink:['pink','rosa'],Purple:['purple','lila'],Brown:['brown','brun','bruna','brunt'],Beige:['beige'],
  Multicolour:['multicoloured','multicolored','flerfärgad','flerfärgade','randig','randiga','rutig','rutiga']};
function findColor(text){ for (const [c, ws] of Object.entries(COLOR_WORDS)) if (ws.some(w => wordRe(w).test(text))) return c; return ''; }
function findOwner(text){
  for (const n of household) if (new RegExp(`(^|[^a-zåäöéü])${escRe(n.toLowerCase())}(?:['’]s|s)?(?!${W})`, 'i').test(text)) return n;
  if (me && /(^|\s)(my|mine|min|mitt|mina)(?=\s|$|[,.])/i.test(text)) return me;
  if (/(^|\s)(shared|gemensam|gemensamma|gemensamt|allas)(?=\s|$|[,.])/i.test(text)) return 'Shared';
  return '';
}
const SIZE_TOKEN = '([0-9]{1,3}(?:[.,]5)?|xxs|xs|s|m|l|xl|xxl)';
function extract(text){
  let s = ' ' + text.trim() + ' ';
  const out = {};
  const sm = s.match(/\s(?:(?:in|i)\s+)?(?:size|storlek|strl\.?|stl\.?)\s*(\d[\d.,]*\d|\d|xxs|xs|s|m|l|xl|xxl)(?=\s|$|[,.](?!\d))/i);
  if (sm){ const cs = cleanSize(sm[1]); if (cs.ok) out.size = cs.v; else out.sizeOdd = sm[1]; s = s.replace(sm[0], ' '); }
  out.owner = findOwner(s);
  if (!out.owner){
    // A name the app hasn't heard before: "… för Elsa" or "Elsa's …" (speech recognition capitalises names)
    const nm = s.match(/\s(?:for|för|till|åt)\s+([A-ZÅÄÖ][a-zåäöé]+)\s*$/) || s.match(/(?:^|\s)([A-ZÅÄÖ][a-zåäöé]+)['’]s\s/);
    if (nm) out.owner = addPerson(nm[1]);
  }
  if (out.owner && out.owner !== 'Shared'){
    const n = escRe(out.owner);
    s = s.replace(new RegExp(`\\s(?:for|för|till|åt|tillhör|belonging to)\\s+${n}(?=[\\s,.]|$)`, 'i'), ' ')
         .replace(new RegExp(`\\s${n}(?:['’]s|s)?(?=[\\s,.]|$)`, 'i'), ' ');
  }
  s = s.replace(/\s(?:my|min|mitt|mina|our|vår|vårt|våra)(?=\s)/gi, ' ');
  out.color = findColor(s);
  out.name = cap(s.replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an)\s+/i, ''));
  return out;
}
function splitItems(text){
  const parts = text.split(/\s*,\s*|\s+(?:and|och|samt|plus)\s+/i).filter(Boolean);
  const out = [];
  for (const p of parts){
    if (out.length && /^\S+$/.test(p) && findColor(p)) out[out.length - 1] += ' ' + t('and') + ' ' + p; // "black and white shirt"
    else if (out.length && findColor(out[out.length - 1].trim()) && /^\S+$/.test(out[out.length - 1].trim())) out[out.length - 1] += ' ' + t('and') + ' ' + p;
    else out.push(p);
  }
  return out;
}
function needsFor(it){
  const k = kindOf(it), need = [];
  if (['clothes','shoes','kids'].includes(k)){ if (!it.size) need.push('size'); if (!it.owner) need.push('owner'); }
  else if (k === 'sports' && !it.owner) need.push('owner');
  return need;
}

let voiceLog = [], pending = null, pendingQueue = [];
const undoStack = [];
const curBox = () => (view.name === 'box' || view.name === 'item') ? (b => b && !b.loose ? b : null)(findBox(view.boxId)) : null;
function snapshot(ids, created = []){ undoStack.push({restore: [...new Set(ids)].map(findBox).filter(Boolean).map(clone), remove: created}); if (undoStack.length > 20) undoStack.shift(); }
let replySource = 'simple';
function logLine(who, text, action){
  voiceLog.push({who, text, action, src: who === 'app' ? replySource : ''}); if (voiceLog.length > 40) voiceLog.shift();
  drawLog();
}
function drawLog(){
  const el = $('#vlog'); if (!el) return;
  el.innerHTML = voiceLog.map((l, i) => `<div class="vl ${l.who}">${l.src ? `<span class="src ${l.src}">${l.src === 'ai' ? 'AI' : 'Simple'}</span>` : ''}${esc(l.text)}${l.action ? `<br><button class="btn quiet" data-vact="${i}">${esc(l.action.label)}</button>` : ''}</div>`).join('')
    || `<p class="hint">${L() === 'sv' ? 'Tryck på mikrofonen och prata, eller skriv. Till exempel “öppna låda 3” eller “var är tältet?”.' : 'Tap the microphone and talk, or type. For example “open box 3” or “where is the tent?”.'}</p>`;
  el.scrollTop = el.scrollHeight;
}
let speakOn = true;
function say(text, action){
  text = cap(text);
  logLine('app', text, action);
  if (speakOn && window.speechSynthesis){
    try { const u = new SpeechSynthesisUtterance(text); u.lang = voiceLang; speechSynthesis.speak(u); } catch {}
  }
}
function updateCtx(){
  const el = $('#vCtx'); if (!el) return;
  const b = curBox(), pid = scopePlace();
  const sv = lang === 'sv';
  el.textContent = b ? `${tr('openBoxNow')}: ${b.code} ${b.name}${places.length > 1 ? ` (${placeName(b.placeId)})` : ''}`
    : pid ? (sv ? `I ${placeName(pid)}, ingen låda öppen. Det du lägger till hamnar utan låda.` : `In ${placeName(pid)}, no box open. Things you add go in as “not in a box”.`)
    : (sv ? 'Alla platser. Säg var du är, till exempel ”jag är i garaget”.' : 'All places. Say where you are, for example “I’m in the garage”.');
}

const CMD = {
  undo: /^(?:undo|ångra)\b/,
  newPlace: /^(?:new (?:storage )?place|add (?:a )?(?:new )?(?:storage )?place|create (?:a )?(?:new )?(?:storage )?place|ny (?:förvaringsplats|förvaring|plats)|lägg till (?:en )?(?:ny )?(?:förvaringsplats|plats)|skapa (?:en )?(?:ny )?(?:förvaringsplats|plats))\s+(.+)$/i,
  newBoxes: /^(?:(?:add|create|make|start|lägg till|skapa|starta)\s+)?(\d+|[a-zåäö]+)\s+(?:new\s+|nya\s+)?(?:boxes|lådor|kartonger)(?![a-zåäö])\s*(.*)$/i,
  rename: /^(?:rename|byt namn på|döp om)\s+(.+?)\s+(?:to|till)\s+(.+)$/i,
  setAttr: /^(?:change|set|make|ändra|sätt)\s+(?:the\s+)?(size|colou?r|owner|storlek(?:en)?|färg(?:en)?|ägare(?:n)?)\s+(?:of|on|for|på|för)\s+(.+?)\s+(?:to|till)\s+(.+)$/i,
  newBox: /^(?:new box|create (?:a )?(?:new )?box|make (?:a )?(?:new )?box|start (?:a )?(?:new )?box|add (?:a )?new box|ny låda|ny kartong|nytt? låda|skapa (?:en )?(?:ny )?(?:låda|kartong)|lägg till (?:en )?ny (?:låda|kartong)|starta (?:en )?ny (?:låda|kartong))(?![a-zåäö])\s*(.*)$/i,
  goPlace: /^(?:go to|switch to|i'?m (?:in|at|on)|i am (?:in|at|on)|we'?re (?:in|at)|we are (?:in|at)|gå till|byt till|jag är (?:i|på|vid|nere i|uppe på|uppe i)|vi är (?:i|på|vid))\s+(.+)$/i,
  open: /^(?:open|öppna|go to|gå till|show|visa)\s+/i,
  bareBox: /^(?:box|låda|lådan|kartong)\s*\S+$/i,
  contents: /^(?:what'?s|whats|what is|vad finns|vad är det|vad innehåller|vad ligger|list|lista|läs upp|read)\s*(.*)$/i,
  where: /^(?:where(?:'s| is| are| did (?:i|we) put)?|wheres|var (?:är|finns|ligger|la (?:jag|vi)|lade (?:jag|vi)|har (?:jag|vi) lagt)|find|hitta|leta(?: efter| upp)?|search(?: for)?|sök(?: efter)?|do we have|have we got|har vi|finns det)\s+(.+)$/i,
  move: /^(?:move|flytta)\s+(.+?)\s+(?:to|into|till|in i|out of|ut ur|ut i|ut)\s+(.+)$/i,
  remove: /^(?:remove|delete|ta bort|radera)\s+(.+)$/i,
  takeOut: /^(?:(?:jag|vi)\s+)?(?:tog|har tagit|tar|ta|plockade|plocka)\s+(?:ut|fram)\s+(.+)$|^(?:(?:i|we)\s+)?(?:took|take|taking|have taken)\s+out\s+(.+)$|^(?:(?:i|we)\s+)?(?:took|take|taking)\s+(.+?)\s+out$|^(?:tog|plockade|har)\s+(?:jag|vi)\s+(?:tagit\s+)?(?:ut|fram)\s+(.+)$/i,
  putBack: /^(?:(?:jag|vi)\s+)?(?:ställde|ställ|har ställt|la|lade|lägg|lagt)\s+tillbaka\s+(.+)$|^(.+?)\s+(?:är|ligger)\s+tillbaka(?:\s+i\s+(.+))?$|^(?:(?:i|we)\s+)?put\s+(.+?)\s+back$|^(?:(?:i|we)\s+)?put\s+back\s+(.+)$|^(.+?)\s+(?:is|are)\s+back(?:\s+in\s+(.+))?$|^(?:ställde|la|lade|har)\s+(?:jag|vi)\s+(?:ställt\s+|lagt\s+)?tillbaka\s+(.+)$/i,
  add: /^(?:add|put|lägg till|lägg in|lägg|stoppa in|in med|ny|nytt|new)\s+(.+)$/i,
};
const isCommand = low => Object.values(CMD).some(re => re.test(low));
const cleanQ = q => q.replace(/^(?:the|my|our|a|an|any|anything|something|min|mitt|mina|vår|vårt|våra|något|nåt|några|någon)\s+/gi, '').replace(/^(?:for|till|för)\s+/i, '').trim();
const LOOSE_RE = /\s(?:without (?:a )?box|not in a box|outside the box(?:es)?|loose|utan låda|utan kartong|löst|lösa|lös|inte i (?:en |någon )?låda|utanför lådorna)(?=[\s,.]|$)/i;

// Places people commonly call by different names, in Swedish and English.
const PLACE_SYN = [
  ['basement','cellar','källare','källaren','källarförråd','källarförrådet'],
  ['attic','loft','vind','vinden','vindsförråd','vindsförrådet'],
  ['garage','garaget'],
  ['summer house','summerhouse','cottage','sommarstuga','sommarstugan','landet'],
  ['storage unit','storage room','förråd','förrådet','förrådsutrymme','förrådsutrymmet'],
  ['shed','bod','boden','förrådsbod','förrådsboden','redskapsbod','redskapsboden'],
  ['wardrobe','closet','garderob','garderoben','klädkammare','klädkammaren'],
];
function placeIn(text){
  const low = ' ' + text.toLowerCase() + ' ';
  for (const p of places){
    const nm = p.name.toLowerCase();
    let vars = [nm, nm + 'n', nm + 'en', nm + 'et', nm.replace(/(en|et|n)$/, '')];
    for (const g of PLACE_SYN) if (vars.some(v => g.includes(v))) vars = vars.concat(g);
    vars = [...new Set(vars)].filter(v => v.length >= 3).sort((x, y) => y.length - x.length);
    for (const v of vars){
      const m = low.match(new RegExp(`\\s(?:(?:in|on|at|to|i|på|vid|till|ut i|ner i|nere i|uppe på|uppe i)\\s+)?(?:the\\s+)?${escRe(v)}(?=[\\s,.?!])`));
      if (m) return {place: p, match: m[0]};
    }
  }
  return null;
}
const stripPlace = (text, pm) => pm ? (' ' + text + ' ').replace(new RegExp(escRe(pm.match.trim()), 'i'), ' ').replace(/\s+/g, ' ').trim() : text;
const curPlaceId = () => (curBox() && curBox().placeId) || scopePlace();
const countBoxes = n => n === 1 ? t('oneBox') : t('manyBoxes', {n});
function whereShort(b){
  if (b.loose) return `${placeName(b.placeId)} (${t('notInBox')})`;
  return boxSpoken(b) + (places.length > 1 ? ` (${placeName(b.placeId)})` : '');
}
function whereLong(it, b){
  if (b.loose) return [placeName(b.placeId), t('notInBox'), it.spot].filter(Boolean).join(', ');
  return [boxSpoken(b), b.name].join(', ') + (places.length > 1 ? ` ${t('in')} ${placeName(b.placeId)}` : '') + (b.location ? ', ' + b.location : '');
}
function askPlace(run){
  pending = {type: 'place', run};
  say(t('askPlace', {list: joinList(places.map(p => p.name))}));
}
function answerPlace(raw){
  const pm = placeIn(raw) || (fuzzyPlace(raw) ? {place: fuzzyPlace(raw)} : null);
  if (!pm) return say(t('didntGetPlace', {list: joinList(places.map(p => p.name))}));
  const run = pending.run; pending = null; run(pm.place.id);
}

/* ---------- conversation context, yes/no, several boxes, editing by voice ---------- */
let recentBoxes = [], lastItems = [];
const YES_RE = /^(?:yes|yeah|yep|sure|ok(?:ay)?|do it|ja|japp|jo|absolut|gör det|precis|correct|right)(?![a-zåäö])/i;
const NO_RE = /^(?:no|nope|nah|cancel|stop|never mind|forget it|nej|nä+|avbryt|strunt i det|glöm det)(?![a-zåäö])/i;
const PRONOUN_RE = /^(?:it|they|them|those|these|that|this|den|det|de|dom|dem|dessa|denna|detta|den där|det där)$/i;
function rememberItems(list){ lastItems = list.map(([it, b]) => ({itemId: it.id, boxId: b.id})); }
function resolveLast(){
  return lastItems.map(r => { const b = findBox(r.boxId); const it = b && (b.items || []).find(i => i.id === r.itemId); return it ? [it, b] : null; }).filter(Boolean);
}
function lev(a, b){
  const m = a.length, n = b.length, d = Array.from({length: m + 1}, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++){
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) d[i][j] = Math.min(d[i][j], d[i-2][j-2] + 1);
  }
  return d[m][n];
}
// "Bass" → Basement: closest place name when an answer doesn't match exactly
function fuzzyPlace(raw){
  const w = raw.toLowerCase().replace(/[^a-zåäöé ]/g, '').replace(/^(?:the|in the|in|i|på)\s+/, '').trim();
  if (w.length < 3) return null;
  const namesOf = p => { const nm = p.name.toLowerCase(); const g = PLACE_SYN.find(x => x.includes(nm)); return [nm, ...(g || [])]; };
  const pre = places.filter(p => namesOf(p).some(n => n.startsWith(w.slice(0, 3))));
  if (pre.length === 1) return pre[0];
  let best = null, bd = 99;
  for (const p of places) for (const n of namesOf(p)){ const d = lev(w, n); if (d < bd){ bd = d; best = p; } }
  return bd <= 2 ? best : null;
}
// sizes: 38, 38.5, 128, M, XL. Rejects odd values like 4,400.
function cleanSize(s){
  const v = String(s).trim().toLowerCase().replace(/^(?:size|storlek|strl\.?)\s*/, '');
  if (/^(xxs|xs|s|m|l|xl|xxl|xxxl)$/.test(v)) return {ok: true, v: v.toUpperCase()};
  if (/^\d{1,3}(?:[.,]5)?$/.test(v)){ const n = parseFloat(v.replace(',', '.')); if (n >= 1 && n <= 200) return {ok: true, v: String(n)}; }
  return {ok: false, v};
}
function ownerFrom(p){
  const known = findOwner(' ' + p + ' '); if (known) return known;
  let m = p.match(/^(?:belongs? to|belonging to|owned by|for|tillhör|till|åt|för)\s+([A-Za-zÅÄÖåäöé]+)$/i);
  if (m) return addPerson(cap(m[1].replace(/['’]?s$/i, m[1].length > 3 ? '' : 's')));
  m = p.match(/^(?:it'?s|its|they'?re|theirs|det är|den är|de är)?\s*([A-Za-zÅÄÖåäöé]+)['’]s$/i) || p.match(/^([A-ZÅÄÖ][a-zåäöé]{2,})s$/);
  if (m && !findColor(m[1])) return addPerson(cap(m[1]));
  return '';
}
function parseAttrs(rest){
  const out = {tags: []};
  const pieces = (' ' + rest + ' ').split(/\s+(?:and|och|plus)\s+|,|\s+(?:they|it|de|den|det|dom)\s+(?:are|is|är|should be|ska vara)\s+/i).map(s => s.trim()).filter(Boolean);
  for (let p of pieces){
    p = p.replace(/^(?:they|it|de|den|det|dom)\s+(?:are|is|är|should be|ska vara)\s+/i, '').replace(/^(?:also|too|också|are|is|är|should be|ska vara|a|an)\s+/i, '').trim();
    if (!p) continue;
    const low = p.toLowerCase();
    let m;
    if ((m = low.match(/^(?:size|storlek|strl\.?)\s*(.+)$/))){ const s = cleanSize(m[1]); if (s.ok) out.size = s.v; else out.sizeOdd = m[1]; continue; }
    const col = findColor(low); if (col && low.split(/\s+/).length <= 2){ out.color = col; continue; }
    const own = ownerFrom(p); if (own){ out.owner = own; continue; }
    if (p.split(/\s+/).length <= 4) out.tags.push(low);
  }
  return out;
}
const COLOR_SV = {Black:'svart',White:'vit',Grey:'grå',Blue:'blå',Red:'röd',Green:'grön',Yellow:'gul',Pink:'rosa',Purple:'lila',Brown:'brun',Beige:'beige',Multicolour:'flerfärgad'};
const colorSpoken = c => c ? (L() === 'sv' ? (COLOR_SV[c] || c.toLowerCase()) : c.toLowerCase()) : '';
function describeAttrs(a){
  return [colorSpoken(a.color), a.size && t('size', {v: a.size}), a.owner, ...(a.tags || [])].filter(Boolean);
}
function resolveSubject(s){
  s = s.trim().replace(/[,.]$/, '');
  if (PRONOUN_RE.test(s)){ const r = resolveLast(); return r.length ? r : null; }
  const q = cleanQ(s.replace(/^(?:the|de|dom)\s+/i, ''));
  const cb = curBox(), pid = cb ? null : scopePlace();
  let res = searchItems(q, cb ? {boxId: cb.id} : pid ? {placeId: pid} : {});
  let list = res.exact.length ? res.exact : res.related;
  if (!list.length && (cb || pid)){ res = searchItems(q); list = res.exact.length ? res.exact : res.related; }
  if (list.length > 1){ const last = new Set(lastItems.map(x => x.itemId)); const pref = list.filter(([it]) => last.has(it.id)); if (pref.length) list = pref; }
  return list.length ? list : null;
}
function doEdit(subject, rest){
  const items = resolveSubject(subject); if (!items) return false;
  const pronoun = PRONOUN_RE.test(subject.trim());
  if (items.length > 1 && !pronoun){ askWhich({many: items}); return true; }
  const r = boxRef(rest), pm = placeIn(rest);
  if ((r || pm) && /^(?:in|i|on|på|at|vid)\s/i.test(rest.trim())){ doMove(subject, rest.replace(/^(?:in|i|on|på|at|vid)\s+/i, '')); return true; }
  const a = parseAttrs(rest);
  if (a.sizeOdd && !a.size){ say(t('oddSize', {v: a.sizeOdd})); return true; }
  const parts = describeAttrs(a); if (!parts.length) return false;
  snapshot(items.map(([, b]) => b.id));
  const byBox = {};
  for (const [it, b] of items){
    const nb = byBox[b.id] || (byBox[b.id] = clone(findBox(b.id)));
    const x = nb.items.find(i => i.id === it.id); if (!x) continue;
    if (a.color) x.color = a.color; if (a.size) x.size = a.size; if (a.owner) setItemOwners(x, [a.owner]);
    if (a.tags.length) x.tags = [...new Set([...(x.tags || []), ...a.tags])];
    x.updatedAt = new Date().toISOString();
  }
  Object.values(byBox).forEach(putBox);
  rememberItems(items);
  say(t('updated', {name: joinList(items.map(([it]) => it.name)), list: joinList(parts)}));
  return true;
}
function doRename(subject, name){
  const items = resolveSubject(subject); if (!items) return say(t('notFound', {q: cleanQ(subject)}));
  if (items.length > 1 && !PRONOUN_RE.test(subject.trim())) return askWhich({many: items});
  const [it, b] = items[0];
  snapshot([b.id]);
  const nb = clone(b); const x = nb.items.find(i => i.id === it.id); const old = x.name; x.name = cap(name.trim()); x.updatedAt = new Date().toISOString(); putBox(nb);
  rememberItems([[x, nb]]);
  say(t('renamed', {old, name: x.name}));
}
function doNewBoxes(n, rest, forcedPid, confirmed){
  if (n > 10 && !confirmed){ pending = {type: 'offer', run: () => doNewBoxes(n, rest, forcedPid, true)}; return say(t('confirmMany', {n})); }
  let name = (rest || '').trim();
  const pm = placeIn(name); if (pm) name = stripPlace(name, pm);
  name = name.replace(/^(?:called|named|som heter|med namnet|för|for|till|med|with|:)\s*/i, '').trim();
  const pid = forcedPid || (pm && pm.place.id) || curPlaceId();
  if (!pid) return askPlace(id => doNewBoxes(n, name, id, true));
  const made = [];
  for (let i = 0; i < n; i++){
    const b = {id: newId(), code: nextCode(pid), autoName: !name, name: cap(name) || (L() === 'sv' ? 'Ny låda' : 'New box'), location: '', notes: '', items: [], createdAt: new Date().toISOString(), placeId: pid};
    putBox(b); made.push(b);
  }
  snapshot([], made.map(b => b.id));
  recentBoxes = made.map(b => b.id);
  openBox(made[0].id); updateCtx();
  say(t('boxesCreated', {n, place: placeName(pid), list: joinList(made.map(b => b.code)), first: cap(boxSpoken(made[0]))}));
}
function askBox(options, run){
  pending = {type: 'box', options, run};
  say(t('whichBox', {list: joinList(options.map(id => findBox(id)).filter(Boolean).map(boxSpoken))}));
}
const ORD = {first: 0, second: 1, third: 2, fourth: 3, fifth: 4, första: 0, andra: 1, tredje: 2, fjärde: 3, femte: 4};
function answerBox(raw){
  const low = raw.toLowerCase(), opts = pending.options.map(findBox).filter(Boolean);
  let b = null; const r = boxRef(low);
  if (r) b = r.box;
  if (!b){ const w = low.match(/(\d+|[a-zåäö]+)/g) || []; for (const x of w){ if (ORD[x] !== undefined){ b = opts[ORD[x]]; break; } const n = toNum(x); if (n){ b = boxByNum(n); break; } } }
  if (!b) return say(t('whichBox', {list: joinList(opts.map(boxSpoken))}));
  const run = pending.run; pending = null; run(b.id);
}

function handle(text){
  const raw = normalizeSpeech(text.trim().replace(/[.!?]+$/, '')); if (!raw) return;
  const low = raw.toLowerCase();
  logLine('you', raw);
  if (CMD.undo.test(low)) return doUndo();
  if (pending && pending.type === 'offer'){
    const run = pending.run; pending = null;
    if (YES_RE.test(low)) return run();
    if (NO_RE.test(low)) return say(t('ok'));
  }
  if (pending && pending.type === 'box' && (!isCommand(low) || (boxRef(low) && raw.split(/\s+/).length <= 3))) return answerBox(raw);
  if (!pending && (NO_RE.test(low) || YES_RE.test(low)) && raw.split(/\s+/).length <= 3) return say(t('ok'));
  if (pending && pending.type !== 'place' && !isCommand(low) && placeIn(raw) && raw.trim().split(/\s+/).length <= 3){ pending = null; pendingQueue = []; return goPlace(placeIn(raw).place.id); }
  if (pending && !isCommand(low)) return pending.type === 'place' ? answerPlace(raw) : answerPending(raw);
  pending = null; if (!batching) pendingQueue = [];
  let m;
  if ((m = raw.match(CMD.newPlace))) return doNewPlace(m[1]);
  if ((m = raw.match(CMD.newBoxes)) && toNum(m[1].toLowerCase()) > 1) return doNewBoxes(toNum(m[1].toLowerCase()), m[2]);
  if ((m = raw.match(CMD.rename))) return doRename(m[1], m[2]);
  if ((m = raw.match(CMD.setAttr))){
    const k = m[1].toLowerCase(), v = m[3];
    const rest = /^(size|storlek)/.test(k) ? 'size ' + v : /^(owner|ägare)/.test(k) ? 'belongs to ' + v : v;
    if (doEdit(m[2], rest) !== false) return;
  }
  if ((m = raw.match(CMD.newBox))) return doNewBox(m[1]);
  if ((m = raw.match(CMD.goPlace)) && !boxRef(m[1])){
    const pm = placeIn(m[1]); if (pm) return goPlace(pm.place.id);
    return say(t('didntGetPlace', {list: joinList(places.map(p => p.name))}));
  }
  if (CMD.open.test(low) || CMD.bareBox.test(low)){
    const r = boxRef(low);
    if (r){ if (!r.box) return say(t('noBox', {n: r.n})); openBox(r.box.id); updateCtx(); return say(t('opened', {box: boxSpoken(r.box), name: r.box.name, things: things((r.box.items || []).length)})); }
    const pm = placeIn(raw); if (pm) return goPlace(pm.place.id);
  }
  if ((m = raw.match(CMD.contents))){
    const rest = m[1].trim(), rl = rest.toLowerCase();
    const pm = placeIn(rest);
    if (pm && !boxRef(rest)) return sayPlace(pm.place.id);
    if (!rest || /(here|this|inside|in it|här|den här|denna|lådan|box|låda|kartong|^b\s*-?\d)/.test(rl)){
      const r = boxRef(rest); if (r && !r.box) return say(t('noBox', {n: r.n}));
      const b = r ? r.box : curBox();
      if (!b){ const pid = scopePlace(); return pid ? sayPlace(pid) : askPlace(sayPlace); }
      if (r){ openBox(b.id); updateCtx(); }
      return sayContents(b);
    }
    return doFind(rest.replace(/^(?:in|i)\s+/i, ''));
  }
  if ((m = raw.match(CMD.where))) return doFind(m[1]);
  if ((m = raw.match(CMD.move))) return doMove(m[1], m[2]);
  if ((m = raw.match(CMD.takeOut))) return doOutVoice(m[1] || m[2] || m[3] || m[4], true);
  if ((m = raw.match(CMD.putBack))) return doOutVoice(m[1] || m[2] || m[4] || m[5] || m[6] || m[8], false, m[3] || m[7]);
  if ((m = raw.match(CMD.remove))) return doRemove(m[1]);
  if ((m = raw.match(CMD.add))) return doAdd(m[1]);
  // "back to the watermelons, they are big and brown" / "the watermelons are Rebecca's" / "it should be brown"
  if ((m = raw.match(/^(?:back to|tillbaka till|about|angående|om)\s+(.+?)\s*[,:]?\s+(?:they|it|de|den|det|dom)\s+(?:are|is|är|should be|ska vara)\s+(.+)$/i))
    || (m = raw.match(/^(?:(?:and|och)\s+)?(.+?)\s+(?:is|are|är|should be|ska vara|blir)\s+(.+)$/i))){
    if (doEdit(m[1], m[2]) !== false) return;
  }
  // "size 40", "brown", "it's Mark's" right after talking about an item → update that item
  if (lastItems.length && raw.split(/\s+/).length <= 6){
    const at = parseAttrs(raw.replace(/^(?:it'?s|its|they'?re|they are|it is|den är|det är|de är)\s+/i, ''));
    if (at.size || at.color || at.owner || at.sizeOdd){ if (doEdit('it', raw.replace(/^(?:it'?s|its|they'?re|they are|it is|den är|det är|de är)\s+(?=\S+['’]s$)/i, '')) !== false) return; }
  }
  const b = curBox(), pid = b ? null : scopePlace();
  if ((b || pid) && raw.length > 2){
    const run = () => doAdd(raw);
    pending = {type: 'offer', run};
    return say(t('unknownAdd', {text: raw, box: b ? boxSpoken(b) : placeName(pid)}), {label: L() === 'sv' ? 'Ja, lägg till' : 'Yes, add it', run: () => { pending = null; run(); }});
  }
  say(t('unknown'));
}
function sayContents(b){
  const items = b.items || [];
  if (!items.length) return say(t('empty', {box: boxSpoken(b)}));
  const names = items.map(i => i.name);
  if (names.length <= 8) return say(t('contents', {box: boxSpoken(b), things: things(names.length), list: joinList(names)}));
  say(t('contentsMore', {box: boxSpoken(b), things: things(names.length), list: joinList(names.slice(0, 6))}));
}
function sayPlace(pid){
  const bx = boxesIn(pid).sort(byCode), loose = looseOf(pid), li = loose ? (loose.items || []) : [];
  let s = t('placeSummary', {place: placeName(pid), boxes: countBoxes(bx.length)});
  if (bx.length) s += ' ' + t('boxList', {list: joinList(bx.slice(0, 8).map(b => `${boxSpoken(b)} ${b.name}`))});
  if (li.length) s += ' ' + t('looseList', {things: things(li.length), list: joinList(li.slice(0, 6).map(i => i.name))});
  say(s);
}
function goPlace(pid){
  setPlace(pid); navigate({name: 'home', place: pid}); updateCtx();
  const loose = looseOf(pid);
  say(t('inPlace', {place: placeName(pid), boxes: countBoxes(boxesIn(pid).length), things: things(loose ? (loose.items || []).length : 0)}));
}
function doNewPlace(name){
  name = name.replace(/^(?:called|named|som heter|med namnet|:)\s*/i, '').trim();
  const before = places.length, p = addPlace(name); if (!p) return say(t('unknown'));
  setPlace(p.id); navigate({name: 'home', place: p.id}); updateCtx();
  say(t(places.length > before ? 'placeCreated' : 'inPlace', {place: p.name, boxes: countBoxes(boxesIn(p.id).length), things: things(0)}));
}
function doNewBox(rest, forcedPid){
  let name = (rest || '').trim();
  const pm = placeIn(name); if (pm) name = stripPlace(name, pm);
  name = name.replace(/^(?:called|named|som heter|med namnet|för|for|till|med|with|:)\s*/i, '').trim();
  const pid = forcedPid || (pm && pm.place.id) || curPlaceId();
  if (!pid) return askPlace(id => doNewBox(name, id));
  const b = {id: newId(), code: nextCode(pid), autoName: !name, name: cap(name) || (L() === 'sv' ? 'Ny låda' : 'New box'), location: '', notes: '', items: [], createdAt: new Date().toISOString(), placeId: pid};
  snapshot([], [b.id]); putBox(b); recentBoxes = [b.id]; openBox(b.id); updateCtx();
  say(t('boxCreated', {box: boxSpoken(b), name: b.name, place: placeName(pid), code: b.code}));
}
function doFind(q){
  q = q.replace(/\?+$/, '');
  const pm = placeIn(q);
  if (pm) q = stripPlace(q, pm);
  q = cleanQ(q);
  const here = places.length > 1 ? ((curBox() && curBox().placeId) || (currentPlace !== 'all' ? currentPlace : null)) : null;
  const pid = pm ? pm.place.id : here;
  let res = searchItems(q, {placeId: pid}), elsewhere = false;
  if (!pm && pid && !res.exact.length && !res.related.length){ res = searchItems(q); elsewhere = res.exact.length + res.related.length > 0; }
  if (pm) setPlace(pid); else if (elsewhere) setPlace('all');
  showSearch(q);
  const {exact, related} = res;
  const pre = elsewhere ? t('elsewhere', {place: placeName(pid)}) + ' ' : '';
  const describe = ([it, b]) => `${it.name} ${t('in')} ${whereShort(b)}`;
  rememberItems((exact.length ? exact : related).slice(0, 4));
  if (exact.length === 1){ const [it, b] = exact[0]; return say(pre + t('found1', {name: it.name, where: whereLong(it, b)})); }
  if (exact.length > 1 && exact.length <= 4) return say(pre + t('foundN', {n: exact.length, list: joinList(exact.map(describe))}));
  if (exact.length > 4) return say(pre + t('foundMany', {n: exact.length, list: joinList(exact.slice(0, 3).map(describe))}));
  if (related.length) return say(pre + t('relatedOnly', {list: joinList(related.slice(0, 4).map(describe))}));
  say(t('notFound', {q}) + (pid && !pm ? '' : ''));
}
function findIn(q, opts){
  const {exact, related} = searchItems(cleanQ(q), opts || {});
  const list = exact.length ? exact : related;
  if (list.length > 1) return {many: list};
  return list[0] || null;
}
const askWhich = hit => say(t('which', {list: joinList(hit.many.slice(0, 4).map(([it, b]) => `${it.name} ${t('in')} ${whereShort(b)}`))}));
function doOutVoice(subject, out, where){
  subject = (subject || '').trim().replace(/[.!?]+$/, '');
  const everything = /^(allt|alla|everything|all|all of it|allting)$/i.test(subject);
  const r = boxRef(where || subject);
  // a whole box: "ta ut låda 3", "låda 3 är tillbaka", "allt är tillbaka i låda 3"
  if (r && r.box && (everything || /^(?:hela\s+|the\s+whole\s+|whole\s+)?(?:box|låda|lådan|kartong)/i.test(subject) || where)){
    const b = r.box;
    if (everything && !out){ if (b.out) setBoxOut(b.id, false); setOutMany((b.items || []).map(it => [it, b]), false, null, b.code); return say(t('allBackIn', {box: boxSpoken(b)})); }
    setBoxOut(b.id, out); return say(out ? t('boxOutV', {box: boxSpoken(b)}) : t('boxBackV', {box: boxSpoken(b)}));
  }
  // a whole collection: "ta ut hela #jul", "take out the christmas collection"
  const cm = subject.replace(/^(?:hela|samlingen|taggen|the|whole|collection|tag)\s+/i, '').replace(/\s+(?:collection|samlingen|tag|taggen)$/i, '').replace(/^#/, '').toLowerCase();
  const coll = collectionsAll().find(c => c.tag === cm || stems(cm).includes(c.tag) || stems(c.tag).includes(cm));
  if (coll && (/#|hela|samling|tagg|whole|collection|\btag\b/i.test(subject) || !findIn(subject))){ setOutMany(coll.list, out, null, '#' + tagLabel(coll.tag)); return say(out ? t('collOutV', {c: tagLabel(coll.tag), n: coll.list.length}) : t('collBackV', {c: tagLabel(coll.tag)})); }
  const pid = scopePlace();
  const hit = findIn(subject, curBox() ? {boxId: curBox().id} : pid ? {placeId: pid} : {}) || findIn(subject);
  if (!hit) return say(t('notFound', {q: cleanQ(subject)}));
  if (hit.many) return askWhich(hit);
  const [it, b] = hit;
  if (isOut(it) === out) return say(out ? t('alreadyOut', {name: it.name}) : t('alreadyBack', {name: it.name}));
  setOut(b.id, it.id, out); rememberItems([[it, b]]);
  say(out ? t('itemOutV', {name: it.name, box: whereShort(b)}) : t('itemBackV', {name: it.name, box: whereShort(b)}));
}
function doRemove(q){
  const b = curBox(), pid = b ? null : scopePlace();
  const opts = b ? {boxId: b.id} : pid ? {placeId: pid} : {};
  const lastR = PRONOUN_RE.test(cleanQ(q)) ? resolveLast() : [];
  const hit = lastR.length === 1 ? lastR[0] : lastR.length > 1 ? {many: lastR} : findIn(q, opts);
  if (!hit) return say(b ? t('notInBox', {q: cleanQ(q), box: boxSpoken(b)}) : t('notFound', {q: cleanQ(q)}));
  if (hit.many) return askWhich(hit);
  const [it, from] = hit;
  snapshot([from.id]); toTrash([[it, from]]);
  const nb = clone(from); nb.items = nb.items.filter(i => i.id !== it.id); putBox(nb);
  say(t('removed', {name: it.name, box: whereShort(from)}));
}
function doMove(q, target){
  const r = boxRef(target); let dest = null;
  if (r){ if (!r.box) return say(t('noBox', {n: r.n})); dest = r.box; }
  else {
    const pm = placeIn(target);
    const looseW = LOOSE_RE.test(' ' + target + ' ') || /^(?:the box|lådan|box|låda)$/i.test(target.trim());
    if (pm) dest = ensureLoose(pm.place.id);
    else if (looseW){ const pid = curPlaceId(); if (!pid) return say(t('unknown')); dest = ensureLoose(pid); }
    else return say(t('unknown'));
  }
  const cb = curBox();
  const lastM = PRONOUN_RE.test(cleanQ(q)) ? resolveLast() : [];
  const hit = lastM.length === 1 ? lastM[0] : (cb && findIn(q, {boxId: cb.id})) || findIn(q); if (!hit) return say(t('notFound', {q: cleanQ(q)}));
  if (hit.many) return askWhich(hit);
  const [it, from] = hit; if (from.id === dest.id) return say(t('moved', {name: it.name, box: whereShort(dest)}));
  snapshot([from.id, dest.id]);
  const a = clone(from); a.items = a.items.filter(i => i.id !== it.id); putBox(a);
  const d = clone(findBox(dest.id)); d.items = (d.items || []).concat(Object.assign(clone(it), {updatedAt: new Date().toISOString()})); putBox(d);
  rememberItems([[it, findBox(dest.id)]]);
  say(t('moved', {name: it.name, box: whereShort(dest)}));
}
function doAdd(text, forcedPid, forcedBoxId){
  let target = forcedBoxId ? findBox(forcedBoxId) : null, loose = false;
  const many = text.match(/\s(?:in|into|within|to|i|till|inuti)\s+(?:one of\s+|en av\s+)?(?:those|these|the|de|dom|dessa)\s+(?:\S+\s+){0,2}?(?:boxes|lådorna|lådor|kartongerna)(?=\s|$)/i);
  if (!target && many){
    text = text.replace(many[0], ' ').replace(/\s+/g, ' ').trim();
    const opts = recentBoxes.filter(findBox);
    if (opts.length > 1) return askBox(opts, id => doAdd(text, null, id));
    if (opts.length === 1) target = findBox(opts[0]);
  }
  const one = text.match(/\s(?:in|into|within|to|i|till)\s+(?:it|this box|that box|this one|den|den här|lådan|denna)(?=\s|$)/i);
  if (!target && one && curBox()){ target = curBox(); text = text.replace(one[0], ' ').trim(); }
  const tm = target ? null : text.match(/\s(?:to|in|into|within|i|till|ner i|ned i)\s+((?:box|boxen|låda|lådan|kartong|kartongen)\s*\S+|b\s*-?\s*\d+)\s*$/i);
  if (tm){ const r = boxRef(tm[1]); if (r && !r.box) return say(t('noBox', {n: r.n})); if (r){ target = r.box; text = text.slice(0, tm.index); } }
  if (LOOSE_RE.test(' ' + text + ' ')){ loose = true; text = (' ' + text + ' ').replace(LOOSE_RE, ' ').trim(); }
  const pm = placeIn(text); if (pm) text = stripPlace(text, pm);
  if (!target){
    const cb = curBox();
    if (cb && !loose && (!pm || pm.place.id === cb.placeId)) target = cb;
    else {
      const pid = forcedPid || (pm && pm.place.id) || (cb && cb.placeId) || scopePlace();
      if (!pid) return askPlace(id => doAdd(text + (loose ? ' ' + (L() === 'sv' ? 'utan låda' : 'without a box') : ''), id));
      target = ensureLoose(pid);
    }
  }
  if (!target.loose && view.boxId !== target.id){ openBox(target.id); updateCtx(); }
  const now = new Date().toISOString();
  const created = splitItems(text).map(part => {
    const a = extract(part);
    const it = {id: newId(), name: a.name, category: '', value: '', storedOn: today(), notes: '', photos: [], tags: [], addedAt: now, addedBy: me || ''};
    if (a.size) it.size = a.size; if (a.owner) setItemOwners(it, [a.owner]); if (a.color) it.color = a.color;
    return it;
  }).filter(it => it.name);
  if (!created.length) return say(t('unknown'));
  snapshot([target.id]);
  const nb = clone(findBox(target.id)); nb.items = (nb.items || []).concat(created); putBox(nb);
  let reply = target.loose ? t('addedLoose', {list: joinList(created.map(i => i.name)), place: placeName(target.placeId)}) : t('added', {list: joinList(created.map(i => i.name)), box: boxSpoken(target)});
  rememberItems(created.map(it => [it, findBox(target.id)]));
  const asks = created.map(it => ({boxId: target.id, itemId: it.id, name: it.name, need: needsFor(it)})).filter(p => p.need.length);
  if (batching){ pendingQueue = pendingQueue.concat(asks); return say(reply); }
  pendingQueue = asks;
  pending = pendingQueue.shift() || null;
  if (pending) reply += ' ' + askFor(pending);
  say(reply);
}
function askFor(p){ return t(p.need.length === 2 ? 'askBoth' : p.need[0] === 'size' ? 'askSize' : 'askOwner', {name: p.name}); }
function answerPending(raw){
  const p = pending, b = findBox(p.boxId), it = b && (b.items || []).find(i => i.id === p.itemId);
  if (!it){ pending = null; return say(t('unknown')); }
  const low = raw.toLowerCase();
  const next = () => { pending = pendingQueue.shift() || null; return pending ? ' ' + askFor(pending) : ''; };
  if (/^(skip|no|nope|doesn'?t matter|don'?t know|not sure|hoppa över|hoppa|nej|spelar ingen roll|vet inte|ingen aning|strunt)/.test(low)) return say(t('skipped') + next());
  const a = extract(raw), got = {};
  if (p.need.includes('size')){
    if (a.sizeOdd && !a.size) return say(t('oddSize', {v: a.sizeOdd}));
    const cand = a.size || (low.match(/(?:^|\s)(?:size|storlek|strl\.?)?\s*(\d[\d.,]*|xxs|xs|s|m|l|xl|xxl)(?=\s|$|[,.](?:\s|$))/i) || [])[1];
    if (cand){ const s = cleanSize(cand); if (s.ok) got.size = s.v; else return say(t('oddSize', {v: cand})); }
  }
  if (p.need.includes('owner')){
    let o = a.owner;
    if (!o){ const pm2 = raw.match(/(?:it'?s|its|they'?re|they are|belongs? to|tillhör|det är|den är|de är)\s+([A-Za-zÅÄÖåäöé]+?)(?:['’]s|s)?\s*[.!]?$/i); if (pm2 && !findColor(pm2[1]) && pm2[1].length > 1) o = addPerson(cap(pm2[1])); }
    if (!o){
      let rest = ' ' + low + ' ';
      if (got.size) rest = rest.replace(new RegExp('\\s' + escRe(got.size.toLowerCase()) + '(?=[\\s,.])'), ' ');
      rest = rest.replace(/\s(?:size|storlek|strl|it'?s|its|they'?re|they are|it is|den är|de är|det är|dom är|för|for|till|åt|and|och|is|är|belongs to|tillhör|hers|his)(?=[\s,.])/g, ' ').replace(/['’]s(?=\s)/g, ' ').replace(/[,.]/g, ' ').trim();
      const words = rest.split(/\s+/).filter(w => w && !findColor(w));
      if (words.length >= 1 && words.length <= 2 && !/\d/.test(rest)) o = addPerson(words.map(cap).join(' '));
    }
    if (o) got.owner = o;
  }
  if (a.color && !it.color) got.color = a.color;
  if (!Object.keys(got).length) return say(t('didntGet'));
  snapshot([b.id]);
  const nb = clone(b); Object.assign(nb.items.find(i => i.id === it.id), got, {updatedAt: new Date().toISOString()}); putBox(nb);
  const list = [got.size && t('size', {v: got.size}), got.owner, colorSpoken(got.color)].filter(Boolean);
  const still = p.need.filter(n => !got[n]);
  if (still.length){ pending = {...p, need: still}; return say(t('gotIt', {list: joinList(list)}) + ' ' + askFor(pending)); }
  say(t('gotIt', {list: joinList(list)}) + next());
}
function undoApply(){
  const snap = undoStack.pop(); pending = null; pendingQueue = [];
  if (!snap) return false;
  snap.restore.forEach(b => putBox(b));
  (snap.remove || []).forEach(id => { if (view.boxId === id) view = {name: 'home'}; removeBox(id); });
  updateCtx(); return true;
}
function doUndo(){ say(undoApply() ? t('undone') : t('nothingUndo')); }

/* listening: keeps listening through pauses, splits what was said into separate commands */
let recog = null, listening = false, heard = '', silenceTimer = null, listenStart = 0, finished = true, batching = false;
let silenceMs = 4000;
const SILENCE_CHOICES = [[2000, '2 s'], [4000, '4 s'], [7000, '7 s'], [0, 'When I tap']];
function setMic(state){
  const btn = $('#micBtn'); if (!btn) return;
  btn.classList.toggle('on', state === 'on');
  btn.setAttribute('aria-label', state === 'on' ? (L() === 'sv' ? 'Lyssnar… tryck när du är klar' : 'Listening… tap when you’re done') : (L() === 'sv' ? 'Tryck och prata' : 'Tap and speak'));
  if (state === 'on') showLive(L() === 'sv' ? 'Lyssnar…' : 'Listening…');
}
function showLive(text){ const el = $('#vLive'); if (!el) return; el.textContent = text; el.hidden = !text; }
function stopListening(){
  listening = false; finished = true; heard = ''; clearTimeout(silenceTimer);
  if (recog){ try { recog.abort(); } catch {} recog = null; }
  setMic('off'); showLive('');
}
function armSilence(first){
  clearTimeout(silenceTimer);
  if (!silenceMs) return;
  silenceTimer = setTimeout(finishListening, first ? Math.max(silenceMs, 10000) : silenceMs);
}
// When the phone offers several guesses, prefer one that makes sense as a command ("box", not "books").
function pickAlt(result){
  const alts = Array.from(result).map(a => a.transcript);
  const top = alts[0] || '';
  const boxy = a => /(^|\s)(box|boxen|låda|lådan|kartong)(?![a-zåäö])/i.test(a);
  if (!boxy(top) && /(^|\s)(books?|bocks|bucks|fox|låta|lada)(?![a-zåäö])/i.test(top)){ const alt = alts.find(boxy); if (alt) return alt; }
  return top;
}
function listen(){
  if (listening) return finishListening();
  if (rec) return toast(tr('h_stopVoice'));
  if (window.speechSynthesis) speechSynthesis.cancel();
  listening = true; finished = false; heard = ''; listenStart = Date.now();
  setMic('on'); showLive('…'); startRecog(); armSilence(true);
}
function startRecog(){
  const r = new SR(); recog = r;
  r.lang = voiceLang; r.interimResults = true; r.maxAlternatives = 5; r.continuous = false;
  let seg = '';
  r.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++){ const x = e.results[i]; if (x.isFinal) seg += ' ' + pickAlt(x); else interim += x[0].transcript; }
    showLive((heard + ' ' + seg + ' ' + interim).replace(/\s+/g, ' ').trim() || '…');
    armSilence(false);
  };
  r.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return; // just a pause; we restart below
    const msg = {
      'network': 'Speech recognition needs signal right now. Type in the box below instead (your keyboard’s microphone can work offline), or record a voice note.',
      'not-allowed': 'Microphone access is blocked. Allow it for Storrrage in Chrome’s site settings.',
      'service-not-allowed': 'Microphone access is blocked. Allow it for Storrrage in Chrome’s site settings.',
      'language-not-supported': 'This language isn’t available for speech recognition on this phone.',
    }[e.error];
    if (msg){ logLine('app', msg); listening = false; }
  };
  r.onend = () => {
    heard = (heard + ' ' + seg).replace(/\s+/g, ' ').trim(); recog = null;
    if (listening && Date.now() - listenStart < 120000){ try { startRecog(); return; } catch {} }
    listening = false; done();
  };
  try { r.start(); } catch { recog = null; listening = false; done(); }
}
function finishListening(){
  clearTimeout(silenceTimer);
  if (!listening) return;
  listening = false; setMic('off');
  if (recog){ try { recog.stop(); } catch { done(); } } else done();
}
function done(){
  if (finished) return; finished = true;
  clearTimeout(silenceTimer); setMic('off');
  const text = heard.trim(); heard = ''; showLive('');
  if (text) return handleBatch(text);
  // nothing heard: a quiet hint instead of a message in the conversation
  showLive(L() === 'sv' ? 'Hörde inget. Tryck och prata igen.' : 'Didn’t catch anything. Tap and speak again.');
  setTimeout(() => { if (!listening) showLive(''); }, 2500);
}
const vPlaceholder = () => L() === 'sv' ? 'Eller skriv, eller använd tangentbordets mikrofon' : 'Or type, or use your keyboard’s microphone';

/* fix common mishearings: "books 3" → "box 3", "låta 3" → "låda 3", "new books" → "new box" */
function normalizeSpeech(s){
  const nums = Object.keys(NUMW).join('|');
  const numAfter = `(?=\\s*-?\\s*(?:\\d|nummer|number|nr(?![a-zåäö])|(?:${nums})(?![a-zåäö])))`;
  let x = ' ' + s + ' ';
  x = x.replace(new RegExp(`(\\s)(?:books?|bocks|bucks|fox|box'?s|boxes|backs)\\s*${numAfter}`, 'gi'), '$1box ');
  x = x.replace(new RegExp(`(\\s)(?:låta|lada|loda)\\s*${numAfter}`, 'gi'), '$1låda ');
  x = x.replace(/^\s*(?:a\s+)?new\s+(?:books?|bocks|bucks|fox)(?![a-z])/i, ' new box');
  x = x.replace(/^\s*(?:create|make|start)\s+(?:a\s+)?(?:new\s+)?(?:books?|bocks|bucks|fox)(?![a-z])/i, ' new box');
  x = x.replace(/(\s(?:and|then)\s+)(?:a\s+)?new\s+(?:books?|bocks|fox)(?![a-z])/gi, '$1new box');
  return x.replace(/\s+/g, ' ').trim();
}
/* split one long utterance into separate commands */
const STARTERS = ['tog jag ut','tog vi ut','ställde jag tillbaka','ställde vi tillbaka','tog ut','ta ut','tog fram','ställ tillbaka','ställde tillbaka','lägg tillbaka','la tillbaka','took out','put back','öppna','lägg till','lägg in','ny låda','nytt låda','ny kartong','ny plats','ny förvaringsplats','skapa','ta bort','ta ut','plocka ut','flytta','var är','var finns','var ligger','vad finns','vad innehåller','har vi','finns det','jag är i','jag är på','vi är i','gå till','byt till','ångra',
  'open','add','put','new box','new place','create','remove','delete','take out','move','where is','where are',"where's",'where did',"what's in",'what is in','do we have',"i'm in",'i am in',"we're in",'go to','switch to','undo'];
function splitCommands(text){
  let parts = text.split(/\s*[.;!?]\s+|\s*,?\s+(?:och sen|och sedan|och så|sen|sedan|därefter|and then|then|after that)\s+/i);
  const re = new RegExp(`\\s*,?\\s+(?:(?:och|and)\\s+)?(?=(?:${STARTERS.map(escRe).join('|')})(?![a-zåäö']))`, 'i');
  parts = parts.flatMap(p => p.split(re)).map(s => s.trim().replace(/^(?:och|and)\s+/i, '').replace(/,$/, '').trim()).filter(Boolean);
  // "within those boxes, add socks" → the place phrase belongs to the next command
  const out = [];
  for (let i = 0; i < parts.length; i++){
    // "jag tog ut …": a lone "jag/vi/I/we" belongs to the command after it
    if (/^(?:jag|vi|i|we)$/i.test(parts[i]) && i + 1 < parts.length){ parts[i + 1] = parts[i] + ' ' + parts[i + 1]; continue; }
    if (/^(?:in|into|within|inside|i|inuti|till|to)\s/i.test(parts[i]) && i + 1 < parts.length){ parts[i + 1] = parts[i + 1] + ' ' + parts[i]; continue; }
    out.push(parts[i]);
  }
  return out;
}
function handleBatch(text){
  if (aiReady() && !(pending && pending.type === 'offer')) return aiTurn(normalizeSpeech(text));
  return ruleBatch(text);
}
function ruleBatch(text){
  const cmds = splitCommands(normalizeSpeech(text));
  if (cmds.length <= 1) return handle(cmds[0] || text);
  batching = true;
  try { cmds.forEach(c => handle(c)); }
  finally { batching = false; }
  if (!pending && pendingQueue.length){ pending = pendingQueue.shift(); say(askFor(pending)); }
}

/* voice notes */
let rec = null, recStart = 0, recTimer = null;
function updRecBtn(){
  const btn = $('#recBtn'); if (!btn) return;
  btn.classList.toggle('rec', !!rec);
  btn.textContent = rec ? `Stop and save (${Math.round((Date.now() - recStart) / 1000)} s)` : 'Record a voice note';
}
async function toggleRecord(){
  if (rec){ rec.stop(); return; }
  if (recog) stopListening();
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast(tr('h_noRec'));
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
  catch { return toast(tr('h_micBlocked')); }
  const chunks = [], boxId = curBox() ? curBox().id : null;
  const r = new MediaRecorder(stream); rec = r;
  r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  r.onstop = async () => {
    stream.getTracks().forEach(tr => tr.stop()); clearInterval(recTimer); rec = null; updRecBtn();
    const blob = new Blob(chunks, {type: r.mimeType || 'audio/webm'});
    const n = {id: newId(), boxId, createdAt: new Date().toISOString(), duration: Math.max(1, Math.round((Date.now() - recStart) / 1000)), blob, by: me || ''};
    try { await notePut(n); notes.push(n); updateStatus(); render(); const b = boxId && findBox(boxId); logLine('app', `Voice note saved${b ? ' to ' + b.code : ''} (${n.duration} s).`); }
    catch (e){ toast(saveErr(e)); }
  };
  r.start(); recStart = Date.now(); recTimer = setInterval(updRecBtn, 500); updRecBtn();
}

function voiceSheet(){
  openSheet(`<div class="chathead"><h3>${tr('talkH')}</h3><span class="chips" style="margin:0"><button type="button" class="chipbtn small" data-lang="sv-SE">SV</button><button type="button" class="chipbtn small" data-lang="en-US">EN</button></span></div>
    <p class="hint" id="vCtx"></p>
    <div class="vlog chat" id="vlog" aria-live="polite"></div>
    <div class="vlive" id="vLive" hidden></div>
    <div class="chatbar">${SR ? `<button class="micround" id="micBtn" aria-label="${esc(tr('tapTalk'))}">${ICON.mic}</button>` : ''}<input id="vText" class="input" enterkeyhint="send" autocomplete="off"><button class="btn primary" id="vSend" aria-label="${esc(tr('send'))}">➤</button></div>
    <p class="aistat" id="vAI"></p>
    <details class="more"><summary>${tr('whatSay')}</summary><ul class="help" id="vHelp"></ul><p class="hint"><b>${tr('noSignal')}</b> ${tr('noSignalTxt2')}</p>
      <label class="check"><input type="checkbox" id="vSpeak" ${speakOn ? 'checked' : ''}> ${tr('readAloud')}</label></details>
    <div class="sheet-foot"><button class="btn" id="vClose">${tr('close')}</button></div>`, () => { stopListening(); if (window.speechSynthesis) speechSynthesis.cancel(); });
  const drawLang = () => {
    sheet.querySelectorAll('[data-lang]').forEach(c => c.classList.toggle('on', c.dataset.lang === voiceLang));
    $('#vHelp').innerHTML = HELP[L()].map(h => `<li>“${esc(h)}”</li>`).join('');
    $('#vText').placeholder = tr('chatPh'); setMic('off'); drawLog();
  };
  drawLang(); updateCtx();
  const drawAI = () => { $('#vAI').innerHTML = ai.provider === 'off' ? `${tr('simpleMode')} · <button class="linkbtn" id="vAIset">${tr('aiOn')}</button>` : `✨ AI: ${esc(AI_LABEL[ai.provider])}${navigator.onLine ? '' : ' · ' + tr('offlineSimple')} · <button class="linkbtn" id="vAIset">${tr('settings')}</button>`; $('#vAIset').onclick = aiSheet; };
  drawAI();
  if (SR) $('#micBtn').onclick = () => { track('voice'); listen(); };
  const send = () => { const v = $('#vText'); const x = v.value; v.value = ''; if (x.trim()){ track('chat'); handleBatch(x); } };
  $('#vSend').onclick = send;
  $('#vText').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('#vSpeak').onchange = e => { speakOn = e.target.checked; metaPutRaw('speakOn', speakOn).catch(() => {}); if (!speakOn && window.speechSynthesis) speechSynthesis.cancel(); };
  sheet.querySelector('.chathead').addEventListener('click', e => {
    const c = e.target.closest('[data-lang]'); if (!c) return;
    voiceLang = c.dataset.lang; metaPut('voiceLang', voiceLang).catch(() => {}); stopListening(); drawLang();
  });
  $('#vlog').addEventListener('click', e => {
    const b = e.target.closest('[data-vact]'); if (!b) return;
    const l = voiceLog[+b.dataset.vact]; if (l && l.action){ const run = l.action.run; l.action = null; drawLog(); run(); }
  });
  $('#vClose').onclick = closeSheet;
}

/* status line: offline, voice notes waiting */
function updateStatus(){
  const el = $('#statusline'); if (!el) return;
  const parts = [];
  if (!navigator.onLine) parts.push(tr('offline'));
  if (notes.length) parts.push(`${notes.length} voice ${notes.length === 1 ? 'note' : 'notes'} waiting.`);
  el.textContent = parts.join(' '); el.hidden = !parts.length;
}
window.addEventListener('online', updateStatus); window.addEventListener('offline', updateStatus);

/* ---------- AI assistant: understands free speech, uses the conversation and the inventory ---------- */
let ai = {provider: 'off', key: '', model: ''};
let aiBusy = false;
const aiReady = () => ai.provider !== 'off' && ai.key && navigator.onLine;
const AI_LABEL = {gemini: 'Google Gemini', claude: 'Claude'};
const CLAUDE_MODELS = [['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fast, cheapest)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (smarter, costs more)']];

function aiSystemPrompt(){
  const lang = L() === 'sv' ? 'Swedish' : 'English';
  return `You are the voice assistant inside Storrrage, a home storage inventory app shared by a household. The user talks to you while packing, unpacking or searching in a storage place (basement, attic, garage and so on). Their speech is transcribed by the phone and can contain mishearings, for example "books" for "box" or "låta" for "låda". Interpret generously and sensibly.

Data model: storage places contain boxes (codes like B-007) and items that are "not in a box" (loose in the place). Items can have: name, owner, size, color, season, brand, model, serial, tags, spot (only for loose items: where exactly), category, notes, value (in SEK).

Each turn, work out what the user wants using the conversation so far and the current state, then return what to say and the actions to perform.
- Keep track of context. "It", "they", "those boxes", "the second one", "back to the watermelons" refer to things mentioned earlier in the conversation. If the user keeps talking about the same box or item, continue with it.
- Ask a short follow-up question when crucial identifying details are missing and the user hasn't given them: clothes and shoes need size and whose; kids' things need size or age and which child; electronics and tools need brand and model; sports gear needs whose and size. Ask at most two things at once. If the user skips or says it doesn't matter, move on.
- If it's unclear which box or place the user means, ask instead of guessing. If the user hasn't said where they are and it matters, ask which place.
- Never invent items, owners or details the user didn't say. Reject absurd values (for example shoe size 4400) by asking again.
- When the user asks where something is, answer from the inventory in "say" and add a search action so it shows on screen.
- Owners are first names. Known household members: ${household.join(', ') || 'none yet'}. ${me ? `The person using this phone is ${me}, so "my" and "mine" mean ${me}.` : ''}

Reply in ${lang}. Keep "say" short and natural for reading aloud, one or two sentences. Say box numbers as ${L() === 'sv' ? '"låda 7"' : '"box 7"'}.

Return ONLY a JSON object, no other text:
{"say": "...", "actions": [ ... ]}
Action types (use only these):
{"type":"create_place","name":"Vinden"}
{"type":"set_place","place":"<place id or name>"}
{"type":"create_box","code":"<next free code>","name":"Winter clothes","place":"<place id or name>","location":"optional, where in the place"}
{"type":"open_box","box":"B-012"}
{"type":"add_items","box":"B-012 or null","place":"<place id or name; required when box is null, the items then go in that place but not in a box>","items":[{"name":"Red ski jacket","owner":"Elsa","size":"128","color":"Red","tags":["warm"]}]}
{"type":"update_item","item":"<item id>","set":{"name":"","owner":"","size":"","color":"","season":"","brand":"","model":"","serial":"","spot":"","category":"","notes":""},"add_tags":["big"]}  (include only the fields that change)
{"type":"move_item","item":"<item id>","box":"B-003 or null","place":"<place when box is null>"}
{"type":"remove_item","item":"<item id>"}
{"type":"update_box","box":"B-003","set":{"name":"","location":""}}
{"type":"search","query":"tent"}
{"type":"take_out","item":"<item id>","until":"YYYY-MM-DD or omit"}  (the thing is taken out of storage for a while; its place is kept)
{"type":"put_back","item":"<item id>"}
{"type":"box_out","box":"B-003"} / {"type":"box_back","box":"B-003"}  (the whole box is carried out / back)
{"type":"undo"}
Use the next free box codes in order when creating boxes. Colors must be one of: Black, White, Grey, Blue, Red, Green, Yellow, Pink, Purple, Brown, Beige, Multicolour. Sizes look like 38, 38.5, 128, S, M, L, XL. Seasons: Winter, Summer, Spring/autumn, All year. If the user only asks something, return an empty actions list.`;
}
function itemForAI(i){
  const o = {id: i.id, name: i.name};
  for (const k of ['owner','size','color','season','brand','model','serial','spot','category']) if (i[k]) o[k] = i[k];
  if (i.tags && i.tags.length) o.tags = i.tags;
  if (i.out) o.out = i.out;
  return o;
}
function aiState(){
  const here = (curBox() && curBox().placeId) || scopePlace() || places[0].id;
  const codes = [0, 1, 2, 3, 4].map(i => nextCode(here, i));
  const cb = curBox();
  return {
    today: today(),
    current_place: scopePlace() ? placeName(scopePlace()) : (places.length > 1 ? 'not known (showing all places)' : placeName(places[0].id)),
    open_box: cb ? cb.code : null,
    recently_created_boxes: recentBoxes.map(findBox).filter(Boolean).map(b => b.code),
    recently_mentioned_items: resolveLast().map(([it, b]) => ({id: it.id, name: it.name, where: b.loose ? placeName(b.placeId) + ', not in a box' : b.code})),
    next_free_box_codes: codes,
    places: places.map(p => {
      const l = looseOf(p.id);
      return {id: p.id, name: p.name,
        boxes: boxesIn(p.id).sort(byCode).map(b => ({code: b.code, name: b.name, location: b.location || undefined, items: (b.items || []).map(itemForAI)})),
        not_in_a_box: (l ? (l.items || []) : []).map(itemForAI)};
    }),
  };
}
class AIError extends Error { constructor(status, body){ super('AI ' + status); this.status = status; this.body = body; } }
async function callAI(system, user, opts = {}){
  const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
  try {
    if (ai.provider === 'gemini'){
      const model = ai.model || 'gemini-flash-latest';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: ctrl.signal,
        headers: {'Content-Type': 'application/json', 'x-goog-api-key': ai.key},
        body: JSON.stringify({systemInstruction: {parts: [{text: system}]}, contents: [{role: 'user', parts: [...(opts.images || []).map(im => ({inline_data: {mime_type: im.mime, data: im.data}})), {text: user}]}],
          generationConfig: {responseMimeType: 'application/json', temperature: 0.2}}),
      });
      if (!r.ok) throw new AIError(r.status, await r.text());
      const j = await r.json();
      return ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: {'content-type': 'application/json', 'x-api-key': ai.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'},
      body: JSON.stringify({model: ai.model || CLAUDE_MODELS[0][0], max_tokens: 2000, system, messages: [{role: 'user', content: (opts.images || []).length ? [...opts.images.map(im => ({type: 'image', source: {type: 'base64', media_type: im.mime, data: im.data}})), {type: 'text', text: user}] : user}]}),
    });
    if (!r.ok) throw new AIError(r.status, await r.text());
    const j = await r.json();
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  } finally { clearTimeout(to); }
}
function parsePlan(text){
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('no json');
  const p = JSON.parse(s.slice(i, j + 1));
  return {say: String(p.say || ''), actions: Array.isArray(p.actions) ? p.actions : []};
}
function aiErrorText(e){
  if (e.name === 'AbortError') return 'The AI took too long to answer.';
  if (e.status === 429) return ai.provider === 'gemini' ? 'The free AI limit is used up for now. Try again in a minute, or pick another model in AI settings.' : 'Too many AI requests right now.';
  if (e.status === 400 || e.status === 401 || e.status === 403) return 'The AI key wasn’t accepted. Check it in AI settings.';
  if (e.status === 404) return 'That AI model isn’t available. Pick another one in AI settings.';
  if (e.status) return `The AI service answered with an error (${e.status}).`;
  return 'Couldn’t reach the AI service.';
}

/* apply what the AI decided, as one undo step */
const COLOR_SET = COLORS.reduce((m, c) => (m[c.toLowerCase()] = c, m), {});
function cleanItemFields(src, dst, isNew){
  const s = src || {};
  const str = v => (v === null || v === undefined) ? null : String(v).trim();
  const set = (k, v) => { if (v === null) return; if (v === '') { if (!isNew) delete dst[k]; } else dst[k] = v; };
  if (s.name !== undefined && str(s.name)) dst.name = cap(str(s.name));
  if (s.owner !== undefined){ const o = str(s.owner); setItemOwners(dst, o ? [o.toLowerCase() === 'shared' ? 'Shared' : addPerson(cap(o))] : []); }
  if (s.size !== undefined){ const z = str(s.size); if (!z) set('size', ''); else { const c = cleanSize(z); if (c.ok) dst.size = c.v; } }
  if (s.color !== undefined){ const c = str(s.color); set('color', c ? (COLOR_SET[c.toLowerCase()] || findColor(c) || cap(c)) : ''); }
  for (const k of ['season','brand','model','serial','spot','category','notes']) if (s[k] !== undefined) set(k, str(s[k]) || '');
  if (s.value !== undefined && s.value !== null && s.value !== '' && !isNaN(+s.value)) dst.value = Math.max(0, +s.value);
  if (Array.isArray(s.tags)) dst.tags = [...new Set([...(dst.tags || []), ...s.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean)])];
  return dst;
}
function applyPlan(actions){
  const before = new Map(), created = [], touched = [], codeMap = {};
  const keep = id => { if (!before.has(id)){ const b = findBox(id); if (b) before.set(id, clone(b)); } };
  const resolvePlace = v => { if (!v) return null; const s = String(v); return findPlace(s) || places.find(p => p.name.toLowerCase() === s.toLowerCase()) || (placeIn(s) || {}).place || fuzzyPlace(s); };
  const getBox = v => {
    if (!v) return null; const s = String(v).toLowerCase();
    if (codeMap[s]) return findBox(codeMap[s]);
    const b = realBoxes().find(x => x.code.toLowerCase() === s); if (b) return b;
    const n = parseInt(s.replace(/\D/g, '')); return n ? boxByNum(n) : null;
  };
  const findItem = id => { for (const b of boxes){ const it = (b.items || []).find(i => i.id === id); if (it) return [it, b]; } return null; };
  const hereId = () => { const c = curBox(); return (c && c.placeId) || scopePlace() || places[0].id; };
  for (const a of actions){
    try {
      switch (a.type){
        case 'create_place': { const p = addPlace(a.name); if (p) setPlace(p.id); break; }
        case 'set_place': { const p = resolvePlace(a.place); if (p){ setPlace(p.id); if (view.name === 'box') view = {name: 'home'}; } break; }
        case 'create_box': {
          const p = resolvePlace(a.place) || findPlace(hereId());
          const want = String(a.code || '').toUpperCase();
          const code = /^B-\d+$/.test(want) && !realBoxes().some(x => x.code === want && (numbering === 'account' || x.placeId === p.id)) ? want : nextCode(p.id);
          const b = {id: newId(), code, name: cap(String(a.name || '').trim()) || (L() === 'sv' ? 'Ny låda' : 'New box'), location: String(a.location || '').trim(), notes: '', items: [], createdAt: new Date().toISOString(), placeId: p.id};
          putBox(b); created.push(b.id); if (want) codeMap[want.toLowerCase()] = b.id;
          recentBoxes = (created.length === 1 ? [] : recentBoxes).concat(b.id).filter(id => created.includes(id));
          break;
        }
        case 'open_box': { const b = getBox(a.box); if (b) openBox(b.id); break; }
        case 'add_items': {
          let target = getBox(a.box);
          if (!target){ const p = resolvePlace(a.place) || findPlace(hereId()); target = ensureLoose(p.id); created.includes(target.id) || before.has(target.id) || keep(target.id); }
          else keep(target.id);
          const nb = clone(findBox(target.id)), now = new Date().toISOString();
          for (const x of (a.items || [])){
            if (!x || !String(x.name || '').trim()) continue;
            const it = cleanItemFields(x, {id: newId(), name: '', category: '', value: '', storedOn: today(), notes: '', photos: [], tags: [], addedAt: now, addedBy: me || ''}, true);
            nb.items = (nb.items || []).concat(it); touched.push([it, nb]);
          }
          putBox(nb); break;
        }
        case 'update_item': {
          const f = findItem(a.item); if (!f) break; keep(f[1].id);
          const nb = clone(findBox(f[1].id)), x = nb.items.find(i => i.id === a.item);
          cleanItemFields(a.set || {}, x, false);
          if (Array.isArray(a.add_tags)) cleanItemFields({tags: a.add_tags}, x, false);
          x.updatedAt = new Date().toISOString(); putBox(nb); touched.push([x, nb]); break;
        }
        case 'move_item': {
          const f = findItem(a.item); if (!f) break;
          let dest = getBox(a.box);
          if (!dest){ const p = resolvePlace(a.place) || findPlace(f[1].placeId); dest = ensureLoose(p.id); }
          if (dest.id === f[1].id) break;
          keep(f[1].id); keep(dest.id);
          const from = clone(findBox(f[1].id)); from.items = from.items.filter(i => i.id !== a.item); putBox(from);
          const to = clone(findBox(dest.id)), moved = Object.assign(clone(f[0]), {updatedAt: new Date().toISOString()});
          if (!to.loose){ delete moved.spot; delete moved.zone; delete moved.stack; delete moved.level; }
          to.items = (to.items || []).concat(moved); putBox(to); touched.push([moved, to]); break;
        }
        case 'remove_item': {
          const f = findItem(a.item); if (!f) break; keep(f[1].id);
          const nb = clone(findBox(f[1].id)); nb.items = nb.items.filter(i => i.id !== a.item); putBox(nb); break;
        }
        case 'update_box': {
          const b = getBox(a.box); if (!b) break; keep(b.id);
          const nb = clone(b); const s = a.set || {};
          if (s.name) nb.name = cap(String(s.name).trim());
          if (s.location !== undefined) nb.location = String(s.location || '').trim();
          if (s.place){ const p = resolvePlace(s.place); if (p) nb.placeId = p.id; }
          putBox(nb); break;
        }
        case 'search': { const q = String(a.query || '').trim(); if (q) showSearch(q); break; }
        case 'take_out': case 'put_back': {
          const f = findItem(a.item); if (!f) break; keep(f[1].id);
          const nb = clone(findBox(f[1].id)), x = nb.items.find(i => i.id === a.item); markOut(x, a.type === 'take_out', a.until); putBox(nb, true); touched.push([x, nb]); break;
        }
        case 'box_out': case 'box_back': {
          const b = getBox(a.box); if (!b) break; keep(b.id);
          const nb = clone(b); if (a.type === 'box_out') nb.out = {since: today()}; else delete nb.out; putBox(nb, true); break;
        }
        case 'undo': { undoApply(); break; }
      }
    } catch (e) { console.warn('AI action failed', a, e); }
  }
  if (before.size || created.length) undoStack.push({restore: [...before.values()], remove: created});
  if (undoStack.length > 20) undoStack.shift();
  if (touched.length) rememberItems(touched);
  updateCtx();
}
async function aiTurn(text){
  if (aiBusy) return toast(tr('h_aiBusy'));
  aiBusy = true;
  const history = voiceLog.slice(-14).map(l => (l.who === 'you' ? 'User: ' : 'Assistant: ') + l.text).join('\n');
  logLine('you', text);
  showLive(L() === 'sv' ? 'Tänker…' : 'Thinking…');
  try {
    const user = `Conversation so far:\n${history || '(nothing yet)'}\n\nCurrent state (JSON):\n${JSON.stringify(aiState())}\n\nThe user now said: "${text}"`;
    const plan = parsePlan(await callAI(aiSystemPrompt(), user));
    applyPlan(plan.actions);
    replySource = 'ai';
    try { say(plan.say || (L() === 'sv' ? 'Klart.' : 'Done.')); } finally { replySource = 'simple'; }
  } catch (e){
    voiceLog.pop(); drawLog();
    logLine('app', aiErrorText(e) + (L() === 'sv' ? ' Använder enkla kommandon.' : ' Using simple commands instead.'));
    ruleBatch(text);
  } finally { aiBusy = false; showLive(''); }
}

/* settings */
async function geminiModels(key){
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {headers: {'x-goog-api-key': key}});
  if (!r.ok) throw new AIError(r.status, await r.text());
  const j = await r.json();
  const ver = n => (n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
  return (j.models || []).map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini-[\d.]+-flash(?:-lite)?(?:-latest)?$|^gemini-flash(?:-lite)?-latest$/.test(n))
    .sort((a, b) => ver(b) - ver(a) || (a.includes('lite') ? 1 : 0) - (b.includes('lite') ? 1 : 0));
}
function aiSheet(){
  const draft = {...ai};
  openSheet(`<h3>${tr('aiAssistant')}</h3>
    <p class="hint">${tr('aiIntro')}</p>
    <div class="field"><span>${tr('provider')}</span><div class="chips" id="aiProv">
      <button type="button" class="chipbtn" data-p="off">${tr('off')}</button>
      <button type="button" class="chipbtn" data-p="gemini">${tr('gemFree')}</button>
      <button type="button" class="chipbtn" data-p="claude">${tr('claudePaid')}</button></div></div>
    <div id="aiBody"></div>
    <p class="proof" id="aiSaved"></p>
    <div class="sheet-foot"><button class="btn primary" id="aiDone">${tr('done')}</button></div>`);
  const persist = () => {
    const keyEl = $('#aiKey'), modelEl = $('#aiModel');
    if (draft.provider === 'off') ai = {provider: 'off', key: '', model: ''};
    else {
      const key = keyEl ? keyEl.value.trim() : '';
      if (!key){ $('#aiSaved').textContent = tr('pasteToTurnOn'); return; }
      ai = {provider: draft.provider, key, model: (modelEl && modelEl.value) || draft.model || ''};
      draft.model = ai.model;
    }
    metaPut('ai', ai).then(() => { $('#aiSaved').textContent = ai.provider === 'off' ? tr('aiIsOff') : `${tr('saved')} ${AI_LABEL[ai.provider]}${ai.model ? ' (' + ai.model + ')' : ''}.`; })
      .catch(() => { $('#aiSaved').textContent = tr('cantSave'); });
  };
  const draw = () => {
    sheet.querySelectorAll('[data-p]').forEach(c => c.classList.toggle('on', c.dataset.p === draft.provider));
    const body = $('#aiBody');
    if (draft.provider === 'off'){ body.innerHTML = `<p class="hint">${tr('simpleOnly')}</p>`; return; }
    const g = draft.provider === 'gemini';
    body.innerHTML = `
      ${g ? `<div class="banner" style="margin:0 0 14px"><span><b>${tr('testOnly')}</b> ${tr('freeTier')}</span></div>` : ''}
      <label class="field"><span>${tr('apiKey')}</span><input id="aiKey" type="password" autocomplete="off" value="${esc(draft.provider === ai.provider ? ai.key : '')}" placeholder="${g ? 'From aistudio.google.com' : 'From console.anthropic.com'}"></label>
      <p class="proof">${g ? tr('getGem') : tr('getClaude')} ${tr('keyLocal')}</p>
      <label class="field"><span>Model</span><select id="aiModel">${g ? (draft.model ? `<option>${esc(draft.model)}</option>` : `<option value="">${tr('checkToChoose')}</option>`) : CLAUDE_MODELS.map(([v, l]) => `<option value="${v}" ${v === (draft.model || CLAUDE_MODELS[0][0]) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn quiet" id="aiCheck">${tr('checkKey')}</button> <span class="hint" id="aiMsg"></span>
      <p class="proof" style="margin-top:14px">${tr('aiSends')}</p>`;
    $('#aiCheck').onclick = async () => {
      const key = $('#aiKey').value.trim(); if (!key) return toast(tr('pasteKey'));
      $('#aiMsg').textContent = tr('checking');
      try {
        if (g){
          const list = await geminiModels(key);
          if (!list.length) throw new Error('none');
          $('#aiModel').innerHTML = list.map(n => `<option ${n === draft.model ? 'selected' : ''}>${esc(n)}</option>`).join('');
        }
        const saved = {...ai}; ai = {provider: draft.provider, key, model: $('#aiModel').value};
        try { parsePlan(await callAI('Reply with JSON only.', 'Return {"say":"ok","actions":[]}', {timeout: 20000})); } finally { ai = saved; }
        $('#aiMsg').textContent = tr('works');
        persist();
      } catch (e){ $('#aiMsg').textContent = aiErrorText(e); }
    };
    $('#aiKey').addEventListener('input', persist);
    $('#aiModel').addEventListener('change', persist);
    if ($('#aiKey').value) persist();
  };
  draw();
  $('#aiProv').onclick = e => {
    const c = e.target.closest('[data-p]'); if (!c) return;
    draft.provider = c.dataset.p; if (draft.provider !== ai.provider) draft.model = '';
    draw(); if (draft.provider === 'off') persist(); else $('#aiSaved').textContent = '';
  };
  $('#aiDone').onclick = closeSheet;
}

/* ---------- files out ---------- */
function deliver(filename, blob, title, onDone){
  const file = new File([blob], filename, {type: blob.type});
  const canShare = !!(navigator.canShare && navigator.canShare({files: [file]}));
  openSheet(`<h3>${esc(title)}</h3><p class="hint">${esc(filename)}, ${(blob.size / 1048576).toFixed(1)} MB</p>
    <div class="menu" style="margin-top:12px">
      ${canShare ? `<button class="btn primary" id="fShare">${tr('shareTo')}</button>` : ''}
      <button class="btn ${canShare ? 'quiet' : 'primary'}" id="fSave">${tr('saveToPhone')}</button>
      <button class="btn quiet" id="fClose">Close</button></div>`);
  $('#fClose').onclick = closeSheet;
  $('#fSave').onclick = () => {
    const u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
    closeSheet(); toast(tr('savedDl')); if (onDone) onDone();
  };
  if (canShare) $('#fShare').onclick = async () => {
    try { await navigator.share({files: [file], title: filename}); closeSheet(); if (onDone) onDone(); }
    catch (e){ if (e.name !== 'AbortError') toast(tr('shareFail')); }
  };
}
function labels(list){
  const ls = [...list].sort(byCode).map(b => `<div class="l"><div class="q">${qrSvg(labelText(b), 6)}</div><div>${b.moveRoom ? `<div class="r">${esc(b.moveRoom)}</div>` : ''}<div class="c">${esc(b.code)}</div><div class="n">${esc(b.name)}</div></div></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(tr('h_boxLabels'))}</title><style>
    body{font-family:Arial,sans-serif;margin:12mm}.g{display:grid;grid-template-columns:1fr 1fr;gap:8mm}
    .l{border:1.5px dashed #888;padding:6mm;display:flex;gap:6mm;align-items:center;break-inside:avoid}
    .q{width:34mm;height:34mm;flex:none}.q svg{width:100%;height:100%}.c{font:900 30pt/1 Impact,Arial Black,sans-serif}.r{font:900 22pt/1.05 Arial Black,Arial,sans-serif;text-transform:uppercase;margin-bottom:2mm}.n{font-size:12pt;margin-top:2mm}
    p{color:#555}@media print{p{display:none}}</style></head><body><p>${esc(tr('h_printHint'))}</p><div class="g">${ls}</div></body></html>`;
  deliver(list.length === 1 ? `label-${list[0].code}.html` : 'box-labels.html', new Blob([html], {type: 'text/html'}), list.length === 1 ? `${tr('label')} ${list[0].code}` : tr('labelsAllH'));
}
async function thumbData(ref){
  try { const b = await phGet(ref); if (!b) return ''; return (await shrink(b, 360)).toDataURL('image/jpeg', .72); }
  catch { return ''; }
}
async function insuranceReport(){
  if (!boxes.length) return toast(tr('h_addBoxesFirst'));
  toast(tr('h_building'));
  const pi = b => places.findIndex(p => p.id === b.placeId);
  const all = [...boxes].filter(b => !b.loose || (b.items || []).length).sort((x, y) => pi(x) - pi(y) || (x.loose ? -1 : 0) - (y.loose ? -1 : 0) || byCode(x, y));
  const total = all.reduce((s, b) => s + boxValue(b), 0);
  let body = '';
  for (const b of all){
    let rows = '';
    for (const it of (b.items || [])){
      const imgs = [];
      for (const p of (it.photos || [])){ const d = await thumbData(p.ref); if (d) imgs.push(`<img src="${d}" alt=""><br><small>${esc(tr('rp_photo'))} ${esc(fmtStamp(p.takenAt))}</small>`); }
      rows += `<tr><td><b>${esc(it.name)}</b>${it.category ? `<br>${esc(it.category)}` : ''}${it.notes ? `<br><small>${esc(it.notes)}</small>` : ''}</td>
        <td>${esc(kr(it.value))}</td><td>${esc(it.storedOn)}</td><td>${esc(fmtStamp(it.addedAt))}</td><td class="ph">${imgs.join('<br>')}</td></tr>`;
    }
    const bimg = b.photo ? await thumbData(b.photo.ref) : '';
    body += `<section><h2>${b.loose ? `${esc(placeName(b.placeId))}: ${esc(tr('notInBoxShort'))}` : `${esc(b.code)} ${esc(b.name)}`}</h2><p>${esc([placeName(b.placeId), b.location].filter(Boolean).join(', '))}. ${esc(tr('rp_packed', fmtDate(b.createdAt), (b.items || []).length, kr(boxValue(b)) || '0 kr'))}</p>
      ${bimg ? `<img class="box" src="${bimg}" alt="">` : ''}
      ${rows ? `<table><tr><th>${esc(tr('rp_item'))}</th><th>${esc(tr('rp_value'))}</th><th>${esc(tr('rp_stored'))}</th><th>${esc(tr('rp_registered'))}</th><th>${esc(tr('rp_photos'))}</th></tr>${rows}</table>` : `<p>${esc(tr('rp_empty'))}</p>`}</section>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(tr('rp_title'))} ${today()}</title><style>
    body{font-family:Arial,sans-serif;margin:14mm;color:#111}h1{margin:0}table{border-collapse:collapse;width:100%;margin:8px 0 24px}
    th,td{border:1px solid #bbb;padding:6px;vertical-align:top;text-align:left;font-size:10pt}td.ph img{width:110px}img.box{width:200px}
    section{break-inside:avoid-page}small{color:#555}</style></head><body>
    <h1>${esc(tr('rp_title'))}</h1><p>${esc(tr('rp_generated', fmtStamp(new Date().toISOString()), all.filter(b => !b.loose).length, all.reduce((s, b) => s + (b.items || []).length, 0), kr(total) || '0 kr'))}</p>
    <p>${esc(tr('rp_note'))}</p>${body}</body></html>`;
  deliver(`storage-inventory-${today()}.html`, new Blob([html], {type: 'text/html'}), tr('rp_ready'));
}
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function backup(){
  if (!boxes.length && !notes.length) return toast(tr('h_nothingBackup'));
  toast(tr('h_preparingBackup'));
  const photos = {};
  const refs = boxes.flatMap(b => [b.photo && b.photo.ref, ...(b.documents || []).map(d => d.ref), ...(b.items || []).flatMap(i => [...(i.photos || []).map(p => p.ref), ...(i.files || []).map(f => f.ref)])]).filter(Boolean);
  for (const ref of refs){ const b = await phGet(ref).catch(() => null); if (b) photos[ref] = await blobToDataURL(b); }
  const notesOut = [];
  for (const n of notes) notesOut.push({...n, blob: undefined, audio: n.blob ? await blobToDataURL(n.blob) : ''});
  const json = JSON.stringify({app: 'boxes', version: 3, exportedAt: new Date().toISOString(), boxes, photos, household, places, notes: notesOut});
  deliver(`storrrage-backup-${today()}.json`, new Blob([json], {type: 'application/json'}), 'Backup ready', async () => {
    lastBackup = new Date().toISOString(); await metaPut('lastBackup', lastBackup).catch(() => {}); render();
  });
}
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    if (f.size > 100 * 1024 * 1024) throw new Error(tr('uploadTooLarge'));
    const data = JSON.parse(await f.text()); const list = Array.isArray(data) ? data : data.boxes;
    if (!Array.isArray(list)) throw 0;
    if (data.household !== undefined && (!Array.isArray(data.household) || !data.household.every(n => typeof n === 'string'))
      || data.places !== undefined && (!Array.isArray(data.places) || !data.places.every(p => p && typeof p.id === 'string' && typeof p.name === 'string'))
      || data.notes !== undefined && !Array.isArray(data.notes)) throw new Error(tr('backupInvalid'));
    const photoData = data.photos && typeof data.photos === 'object' && !Array.isArray(data.photos) ? data.photos : {};
    const safePhotos = new Map(), refMap = new Map(), prepared = [];
    const importRef = async (oldRef, allowPdf = false) => {
      if (!oldRef) return null;
      if (refMap.has(oldRef)){
        const existing = refMap.get(oldRef);
        if (!allowPdf && existing.type !== 'image/webp' && existing.type !== 'image/jpeg') throw new Error(tr('uploadImageOnly'));
        return existing;
      }
      if (typeof photoData[oldRef] !== 'string') return null;
      const raw = backupDataBlob(photoData[oldRef]), isImage = await imageSignature(raw);
      if (!isImage && !allowPdf) throw new Error(tr('uploadImageOnly'));
      let blob, type;
      if (isImage){ blob = await normalizePhoto(raw); type = blob.type; }
      else { await validatePdfUpload(raw); blob = raw.slice(0, raw.size, 'application/pdf'); type = 'application/pdf'; }
      const result = {ref: newId(), type};
      refMap.set(oldRef, result); safePhotos.set(result.ref, blob);
      return result;
    };
    for (const source of list){
      if (!source || typeof source.id !== 'string' || typeof source.code !== 'string' || findBox(source.id)) continue;
      if (source.items !== undefined && !Array.isArray(source.items) || source.documents !== undefined && !Array.isArray(source.documents)) throw new Error(tr('backupInvalid'));
      const b = clone(source);
      if (b.photo && b.photo.ref){
        const p = await importRef(b.photo.ref);
        if (p) b.photo.ref = p.ref; else delete b.photo;
      }
      b.documents = await Promise.all((b.documents || []).map(async d => {
        if (!d || !d.ref) return null;
        const p = await importRef(d.ref, true);
        return p ? {...d, ref: p.ref, type: p.type} : null;
      }));
      b.documents = b.documents.filter(Boolean);
      for (const it of b.items || []){
        if (!it || typeof it !== 'object') throw new Error(tr('backupInvalid'));
        if (it.photos !== undefined && !Array.isArray(it.photos) || it.files !== undefined && !Array.isArray(it.files)) throw new Error(tr('backupInvalid'));
        it.photos = await Promise.all((it.photos || []).map(async p => {
          if (!p || !p.ref) return null;
          const safe = await importRef(p.ref);
          return safe ? {...p, ref: safe.ref} : null;
        }));
        it.photos = it.photos.filter(Boolean);
        it.files = await Promise.all((it.files || []).map(async file => {
          if (!file || !file.ref) return null;
          const safe = await importRef(file.ref, true);
          return safe ? {...file, ref: safe.ref, type: safe.type} : null;
        }));
        it.files = it.files.filter(Boolean);
      }
      prepared.push(b);
    }
    const preparedNotes = [];
    for (const x of (data.notes || [])){
      if (!x || typeof x.id !== 'string' || notes.some(y => y.id === x.id) || typeof x.audio !== 'string' || !x.audio) continue;
      const audio = backupDataBlob(x.audio);
      await validateAudioUpload(audio);
      preparedNotes.push({id: x.id, boxId: x.boxId || null, createdAt: x.createdAt || new Date().toISOString(), duration: Math.max(0, +x.duration || 0), by: String(x.by || '').slice(0, 80), blob: audio});
    }
    toast(tr('h_restoring'));
    let n = 0;
    for (const [ref, blob] of safePhotos) await phPut(ref, blob);
    for (const b of prepared){ putBox(b); n++; }
    if (Array.isArray(data.household)) data.household.forEach(addPerson);
    if (Array.isArray(data.places)) data.places.forEach(p => { if (p && p.id && !findPlace(p.id)){ places.push(p); } }); metaPut('places', places).catch(() => {});
    boxes.forEach(b => { if (!b.placeId || !findPlace(b.placeId)){ b.placeId = places[0].id; dbPut(clone(b)).catch(() => {}); } });
    for (const nn of preparedNotes){ await notePut(nn); notes.push(nn); }
    const k = preparedNotes.length;
    updateStatus(); render();
    toast(n || k ? `Restored ${n} ${n === 1 ? 'box' : 'boxes'}${k ? ` and ${k} voice ${k === 1 ? 'note' : 'notes'}` : ''}.` : 'Everything in that backup is already here.');
  } catch (err){ toast(err instanceof Error && err.message ? err.message : tr('backupInvalid')); }
});
function menuSheet(){
  const nN = dueCount() + outItems().filter(([it]) => outOverdue(it)).length + realBoxes().filter(boxOutLate).length + nudges().length + attention();
  const row = (m, icon, label, extra = '') => `<button class="mrow" data-m="${m}"><span class="mi">${icon}</span><span class="ml">${label}</span>${extra}</button>`;
  openSheet(`<div class="menuhead"><h3>${tr('menu')}</h3>${langSwitch()}</div><div class="menu mlist">
    ${row('profile', ICON.user, esc(me || tr('profile')), nN ? `<b class="count">${nN}</b>` : '')}
    ${row('cloud', ICON.cloud, tr('cloudMenu'))}
    ${row('scan', ICON.scan, tr('scanLabel'))}
    ${row('feedback', ICON.chat, tr('feedback'))}
    ${canInstall() ? row('install', ICON.install, tr('installTitle')) : ''}
    ${row('loans', ICON.lend, tr('loansTitle'), loans().length ? `<b class="count${loanOld().length ? '' : ' muted'}">${loans().length}</b>` : '')}
    ${row('move', ICON.truck, tr('moveTitle'), move.active ? `<b class="count muted">${moveBoxes().filter(b => b.moveState !== 'unpacked').length}</b>` : '')}
    ${row('settings', ICON.gear, tr('settings'))}
    ${row('trash', ICON.trash, tr('trash'), trash.length ? `<b class="count muted">${trash.length}</b>` : '')}
    ${cloud.admin ? row('admin', ICON.chart, tr('adminTitle')) : ''}
    ${cloud.session ? row('logout', ICON.logout, tr('logout'), cloud.email ? `<small class="mmail">${esc(cloud.email)}</small>` : '') : row('cloud', ICON.login, tr('logIn'))}
    <p class="proof center" style="margin:10px 0 0">${tr('version', APP_VERSION)}</p></div>`);
  sheet.querySelector('.mlist').onclick = e => {
    const m = e.target.closest('[data-m]'); if (!m) return; const k = m.dataset.m;
    if (k === 'settings'){ closeSheet(); return navigate({name: 'settings'}); }
    if (k === 'profile'){ closeSheet(); return navigate({name: 'profile'}); }
    if (k === 'move'){ closeSheet(); return navigate({name: 'move'}); }
    if (k === 'loans'){ closeSheet(); return navigate({name: 'loans'}); }
    if (k === 'logout') return askConfirm(tr('logoutQ'), tr('logout')).then(y => { if (y) logout(false); });
    if (k === 'import') closeSheet();
    settingsAction(k);
  };
}

/* ====================================================================
   Cloud: login (e-mail link), household sync, anonymous usage statistics
   and feedback. The sync is NOT end-to-end encrypted today (cloud.plain):
   data and photos are stored in plain form, protected by Supabase access
   rules. The AES-GCM helpers below are kept for a possible later switch.
   ==================================================================== */
const SB_URL = 'https://lqzfkhactizvzfzmigcz.supabase.co';
const SB_KEY = 'sb_publishable_vn4-GzgYonITq3cV1S5euQ_-ophAXvW';
const APP_URL = location.origin + location.pathname;
let cloud = {};            // {session, hid, key, cursor, lastSync, email}
let cryptoKey = null, dirty = new Set(), syncing = false, syncTimer = null, syncErr = '';
let memberNames = {}, prof = {}, others = [], hhInfo = {}, pendingJoinCode = null;
async function askMyName(){ const n = await askText(tr('whatName'), {placeholder: tr('yourName'), ok: tr('save')}); if (n){ me = addPerson(n); metaPut('me', me).catch(() => {}); metaPutRaw('onboarded', true).catch(() => {}); render(); } }
const myId = () => cloud.session && cloud.session.user && cloud.session.user.id;
function markMe(){ if (myId()) markDirty('u:' + myId()); }

/* ---------- helpers ---------- */
function bytesToB64(u8){ let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToBytes(b64){ const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
const toUrl64 = b => b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl64 = b => { b = b.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; return b; };
async function saveCloud(){ await metaPutRaw('cloud', cloud).catch(() => {}); }

/* ---------- encryption helpers (AES-GCM 256). Not used for uploads today, only to read data from the old encrypted format ---------- */
async function loadKey(){ cryptoKey = cloud.key ? await crypto.subtle.importKey('raw', b64ToBytes(cloud.key), 'AES-GCM', false, ['encrypt', 'decrypt']) : null; }
async function newKey(){ const k = crypto.getRandomValues(new Uint8Array(32)); cloud.key = bytesToB64(k); await loadKey(); }
async function encBytes(u8){ const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, cryptoKey, u8)); const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out; }
async function decBytes(u8){ return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: u8.subarray(0, 12)}, cryptoKey, u8.subarray(12))); }
async function encJSON(o){ return bytesToB64(await encBytes(new TextEncoder().encode(JSON.stringify(o)))); }
async function decJSON(s){ return JSON.parse(new TextDecoder().decode(await decBytes(b64ToBytes(s)))); }
const toPayload = v => 'j:' + JSON.stringify(v);
async function fromPayload(p){ if (!p) return null; if (p.startsWith('j:')) return JSON.parse(p.slice(2)); if (!cryptoKey) await loadKey(); return cryptoKey ? decJSON(p) : null; }
async function encBlob(blob){
  const type = new TextEncoder().encode((blob.type || '').slice(0, 100)), data = new Uint8Array(await blob.arrayBuffer());
  const plain = new Uint8Array(1 + type.length + data.length); plain[0] = type.length; plain.set(type, 1); plain.set(data, 1 + type.length);
  return new Blob([await encBytes(plain)], {type: 'application/octet-stream'});
}
async function decBlob(ab){ const p = await decBytes(new Uint8Array(ab)); const n = p[0]; return new Blob([p.subarray(1 + n)], {type: new TextDecoder().decode(p.subarray(1, 1 + n))}); }

/* ---------- talking to Supabase ---------- */
async function sb(path, o = {}){
  const h = Object.assign({apikey: SB_KEY}, o.headers || {});
  if (o.auth !== false){ const t = await accessToken(); if (!t) throw new Error('auth'); h.Authorization = 'Bearer ' + t; }
  let body = o.body;
  if (body !== undefined && !(body instanceof Blob)){ h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(SB_URL + path, {method: o.method || 'GET', headers: h, body, keepalive: !!o.keepalive});
  if (r.status === 401 && o.auth !== false && !o.retried){ cloud.session.expires_at = 0; return sb(path, Object.assign({}, o, {retried: true})); }
  if (!r.ok){ const txt = await r.text().catch(() => ''); const e = new Error(r.status + ' ' + txt.slice(0, 200)); e.status = r.status; throw e; }
  if (o.raw) return r;
  const txt = await r.text(); return txt ? JSON.parse(txt) : null;
}
let refreshing = null;
async function accessToken(){
  const s = cloud.session; if (!s) return null;
  if (Date.now() / 1000 < (s.expires_at || 0) - 60) return s.access_token;
  if (!refreshing) refreshing = doRefresh(s).finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh(s){
  try {
    const n = await sb('/auth/v1/token?grant_type=refresh_token', {method: 'POST', auth: false, body: {refresh_token: s.refresh_token}});
    cloud.session = {access_token: n.access_token, refresh_token: n.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (n.expires_in || 3600), user: s.user};
    await saveCloud(); return cloud.session.access_token;
  } catch (e){
    // the login was revoked ("Log out everywhere" on another device): remove everything from this phone
    if ((e.status === 400 || e.status === 401) && /refresh|token|session/i.test(e.message)){ try { sessionStorage.setItem('wiped', '1'); } catch {} await wipeLocal(); location.replace(APP_URL); }
    return null;
  }
}
const rpc = (fn, args) => sb('/rest/v1/rpc/' + fn, {method: 'POST', body: args || {}});

/* ---------- login with a link in the e-mail ---------- */
async function sendLoginLink(email){
  await sb('/auth/v1/otp?redirect_to=' + encodeURIComponent(APP_URL + (lang === 'sv' ? '' : '?lang=' + lang)), {method: 'POST', auth: false, body: {email, create_user: true, data: {lang}}});
  track('login_link');
}
async function takeAuthFromUrl(){
  { const qs = new URLSearchParams(location.search); if (qs.get('lang')){ if (!location.hash) try { history.replaceState(null, '', APP_URL); } catch {} } if (qs.get('error_description')){ try { history.replaceState(null, '', APP_URL); } catch {} toast(tr('loginFailed') + ' ' + qs.get('error_description')); return; } }
  const h = location.hash.slice(1); if (!h) return;
  const p = new URLSearchParams(h);
  if (p.get('error_description')){ try { history.replaceState(null, '', APP_URL); } catch {} toast(tr('loginFailed') + ' ' + p.get('error_description')); return; }
  if (p.get('join')){ await metaPutRaw('pendingJoin', p.get('join')).catch(() => {}); try { history.replaceState(null, '', APP_URL); } catch {} return; }
  if (!p.get('access_token')) return;
  try { history.replaceState(null, '', APP_URL); } catch {}
  await completeLogin({access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_at: +p.get('expires_at') || Math.floor(Date.now() / 1000) + (+p.get('expires_in') || 3600)});
}
async function completeLogin(sess){
  cloud.session = sess;
  try { const u = await sb('/auth/v1/user'); cloud.session.user = {id: u.id}; cloud.email = u.email || ''; } catch {}
  saveLangToAccount();
  syncErr = '';
  await saveCloud();
  track('login');
  checkAdmin(); loadProfile(); markMe();
  toast(tr('loggedIn'));
  if (!cloud.hid) await connectAccount();
}
/* the 6-digit code from the e-mail: same as the link, but works inside the installed app (iPhone) */
async function verifyCode(email, code){
  const n = await sb('/auth/v1/verify', {method: 'POST', auth: false, body: {type: 'email', email, token: code}});
  await completeLogin({access_token: n.access_token, refresh_token: n.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (n.expires_in || 3600)});
}
/* the login e-mail is written in the language chosen in the app */
function saveLangToAccount(){ if (cloud.session) sb('/auth/v1/user', {method: 'PUT', body: {data: {lang}}}).catch(() => {}); }
const KEEP_META = ['folded', 'langPref', 'lang', 'theme', 'statsOn', 'statsNoticed', 'voiceLang', 'speakOn', 'viewMode', 'placeView', 'adsPreview', 'silenceMs', 'rkSize', 'rkMeasure', 'rkRules'];
async function wipeLocal(){
  for (const st of ['boxes', 'photos', 'notes']) await tx(st, 'readwrite', s => s.clear()).catch(() => {});
  const keys = await tx('meta', 'readonly', s => s.getAllKeys()).catch(() => []) || [];
  for (const k of keys) if (!KEEP_META.includes(k)) await tx('meta', 'readwrite', s => s.delete(k)).catch(() => {});
}
async function logout(everywhere){
  if (cloud.hid && navigator.onLine) await syncNow();
  if (dirty.size && !(await askConfirm(tr('unsyncedQ', dirty.size), tr('logout')))) return;
  try { await sb('/auth/v1/logout' + (everywhere ? '?scope=global' : ''), {method: 'POST'}); } catch {}
  track(everywhere ? 'logout_all' : 'logout');
  await flushEvents(true);
  await wipeLocal();
  try { sessionStorage.setItem('loggedOut', '1'); } catch {}
  location.replace(APP_URL);
}

/* ---------- household: create, invite, join ---------- */
/* after login: your account's storage comes to this device; what was only on this device is added to it */
async function connectAccount(){
  const pj = await metaGet('pendingJoin').catch(() => null);
  if (pj) return;                                            // the invite decides which household
  let mine = null;
  try { mine = await sb('/rest/v1/members?select=household_id,joined_at&user_id=eq.' + myId() + '&order=joined_at.asc'); } catch { return; }
  if (mine && mine[0]){
    const local = {places: clone(places), boxes: clone(boxes), household: clone(household), trash: clone(trash)};
    const nLocal = local.boxes.reduce((s, b) => s + (b.loose ? 0 : 1) + (b.items || []).length, 0);
    // put the phone's own things aside, bring in the account, then let the user decide
    for (const b of boxes) await dbDelRaw(b.id).catch(() => {});
    boxes = []; places = []; dirty = new Set(); await saveDirty();
    cloud.hid = mine[0].household_id; cloud.plain = true; cloud.cursor = null; cloud.lockedHid = null; await saveCloud();
    if (cloud.key) await loadKey();
    await pull(true);
    if (!me && memberNames[myId()]){ me = memberNames[myId()]; await metaPutRaw('me', me).catch(() => {}); await metaPutRaw('onboarded', true).catch(() => {}); }
    if (nLocal){
      const keep = await askChoice(tr('moveLocalQ', nLocal), tr('moveLocalYes'), tr('moveLocalNo'));
      if (keep){ await mergeLocal(local, true); toast(tr('mergedIntoAccount')); track('merge_local', {n: nLocal}); }
    }
    if (!places.length && local.places.length){ places = local.places.slice(0, 1); await metaPut('places', places); }
    markMe(); await syncNow();
  } else {
    try { await createHousehold(); } catch {}
  }
}
async function createHousehold(){
  cloud.hid = await rpc('create_household');
  cloud.plain = true; cloud.cursor = null; await saveCloud();
  markEverything(); markMe();
  track('household_create');
  await syncNow();
}
async function inviteLink(note){
  let code;
  try { code = await rpc('create_invite', {hid: cloud.hid, note: note ? toPayload(note) : null}); }
  catch (e){ if (e.status === 404 || /PGRST202|function/i.test(e.message)) code = await rpc('create_invite', {hid: cloud.hid}); else throw e; }
  return APP_URL + '#join=' + code;
}
async function joinFromLink(text){
  const m = /#join=([0-9a-f]+)(?:\.([\w-]+))?/.exec(text || ''); if (!m) return toast(tr('badInvite'));
  const pj = m[1] + (m[2] ? '.' + m[2] : '');
  if (!cloud.session){ await metaPutRaw('pendingJoin', pj).catch(() => {}); pendingJoinCode = pj; if (view.name === 'welcome') return render(); toast(tr('loginToJoin')); return cloudSheet(); }
  if (cloud.hid && boxes.some(b => !b.loose || (b.items || []).length) && !(await askConfirm(tr('switchHouseholdQ'), tr('join')))) return;
  if (!cloud.hid && !(await askConfirm(tr('joinConfirmQ'), tr('join')))) return;
  const keep = (boxes.some(b => (b.items || []).length) || realBoxes().length) ? await askChoice(tr('mergeQ'), tr('mergeYes'), tr('mergeNo')) : false;
  try {
    const hid = await rpc('join_household', {c: m[1]});
    cloud.hid = hid; cloud.lockedHid = null; cloud.key = m[2] ? fromUrl64(m[2]) : cloud.key; cloud.cursor = null; await loadKey(); await saveCloud();
    const mine = {places: clone(places), boxes: clone(boxes), household: clone(household), trash: clone(trash)};
    if (!keep){ for (const b of boxes) await dbDelRaw(b.id).catch(() => {}); boxes = []; }
    dirty = new Set(); await saveDirty();
    await pull(true);
    if (keep) await mergeLocal(mine);
    else if (!places.length){ places = mine.places.slice(0, 1); await metaPut('places', places); }
    markMe();
    track('household_join', {kept: keep});
    if (view.name === 'welcome'){ metaPutRaw('onboarded', true).catch(() => {}); view = {name: 'home', place: 'all'}; }
    toast(tr('joined'));
    await syncNow(); render(); loadProfile();
    if (!me) setTimeout(askMyName, 600);
  } catch (e){ toast(tr('joinFailed') + (e.status ? ' (' + e.status + ')' : '')); }
}
/* put what was on this phone into the household without overwriting the others */
async function mergeLocal(mine, markNew){
  const byName = new Map(places.map(p => [p.name.trim().toLowerCase(), p.id]));
  const remap = {};
  for (const p of mine.places){
    if (findPlace(p.id)) continue;
    const same = byName.get(p.name.trim().toLowerCase());
    if (same) remap[p.id] = same; else { places.push(p); byName.set(p.name.trim().toLowerCase(), p.id); }
  }
  for (const b0 of mine.boxes){
    if (findBox(b0.id)) continue;
    const b = clone(b0); if (remap[b.placeId]) b.placeId = remap[b.placeId];
    if (markNew){ if (!b.loose) b.isNew = true; (b.items || []).forEach(i => { if (b.loose) i.isNew = true; }); }
    if (b.loose){ const l = looseOf(b.placeId); if (l){ const nl = clone(l); nl.items = (nl.items || []).concat(b.items || []); putBox(nl, true); continue; } }
    else if (boxes.some(x => !x.loose && x.placeId === b.placeId && x.code === b.code)) b.code = nextCode(b.placeId);
    putBox(b, true);
  }
  household = [...new Set([...(household || []), ...(mine.household || [])])];
  trash = [...trash, ...mine.trash.filter(t => !trash.some(x => x.id === t.id))];
  await metaPut('places', places); await metaPut('household', household); await metaPut('trash', trash);
}

/* ---------- sync ---------- */
function markDirty(k){
  if (!cloud || !cloud.hid) return;
  dirty.add(k); saveDirty(); scheduleSync(2500);
}
let dirtyT; function saveDirty(){ clearTimeout(dirtyT); return new Promise(r => { dirtyT = setTimeout(() => { metaPutRaw('syncDirty', [...dirty]).catch(() => {}).then(r); }, 200); }); }
function markEverything(){
  boxes.forEach(b => dirty.add('b:' + b.id));
  SYNC_META.forEach(k => dirty.add('m:' + k));
  const refs = new Set(); const add = r => r && refs.add(r);
  boxes.forEach(b => { if (b.photo) add(b.photo.ref); (b.documents || []).forEach(d => add(d.ref)); (b.items || []).forEach(i => { (i.photos || []).forEach(p => add(p.ref)); (i.files || []).forEach(f => add(f.ref)); }); });
  trash.forEach(t => { (t.item.photos || []).forEach(p => add(p.ref)); (t.item.files || []).forEach(f => add(f.ref)); });
  refs.forEach(r => dirty.add('p:' + r));
  saveDirty();
}
function scheduleSync(ms){ clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms || 0); }
async function syncNow(){
  if (syncing || !cloud.hid || !cloud.session || !navigator.onLine) return;
  syncing = true;
  try {
    // one-time move from the old encrypted format: upload everything again in the new one
    if (!cloud.plain){ markEverything(); cloud.plain = true; await saveCloud(); }
    await push(); await pull(false);
    cloud.lastSync = new Date().toISOString(); syncErr = ''; await saveCloud();
  } catch (e){
    syncErr = e.message === 'auth' ? tr('loginAgain') : tr('syncFailed');
    if (e.status === 403 || /42501|row-level/.test(e.message)) syncErr = tr('notMember');
  } finally { syncing = false; updateCloudLine(); }
}
const metaVal = k => k === 'places' ? places : k === 'household' ? household : k === 'trash' ? trash : k === 'boxOrder' ? boxOrder : k === 'move' ? move : null;
async function push(){
  const keys = [...dirty]; if (!keys.length) return;
  const rows = [], done = [];
  for (const k of keys){
    const [t, id] = [k.slice(0, 1), k.slice(2)];
    if (t === 'p'){
      const blob = await phGet(id).catch(() => null), path = `/storage/v1/object/photos/${cloud.hid}/${encodeURIComponent(id)}`;
      try {
        if (blob) await sb(path, {method: 'POST', headers: {'x-upsert': 'true', 'Content-Type': blob.type || 'application/octet-stream'}, body: blob});
        else await sb(path, {method: 'DELETE'}).catch(e => { if (e.status !== 404 && e.status !== 400) throw e; });
        done.push(k);
      } catch (e){ if (e.status === 413) done.push(k); else throw e; }
      continue;
    }
    if (t === 'b'){ const b = findBox(id); rows.push({household_id: cloud.hid, id: k, kind: 'box', payload: b ? toPayload(b) : '', deleted: !b}); }
    if (t === 'u'){ if (id === myId()) rows.push({household_id: cloud.hid, id: k, kind: 'member', payload: toPayload({name: me || ''}), deleted: false}); }
    if (t === 'm'){ const v = metaVal(id); rows.push({household_id: cloud.hid, id: k, kind: 'meta', payload: toPayload(v ?? null), deleted: false}); }
    done.push(k);
  }
  for (let i = 0; i < rows.length; i += 200) await sb('/rest/v1/records', {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'}, body: rows.slice(i, i + 200)});
  done.forEach(k => { if (keys.includes(k)) dirty.delete(k); });
  await saveDirty();
}
async function pull(force){
  let changed = false;
  for (let page = 0; page < 50; page++){
    const q = `/rest/v1/records?select=id,kind,payload,deleted,updated_at,updated_by&household_id=eq.${cloud.hid}&order=updated_at.asc,id.asc&limit=500` + (cloud.cursor ? '&updated_at=gt.' + encodeURIComponent(cloud.cursor) : '');
    const rows = await sb(q); if (!rows || !rows.length) break;
    for (const r of rows){
      if (!force && dirty.has(r.id)) continue;   // a newer local change is waiting to go up
      try { await applyRecord(r); changed = true; if (!force && r.id.startsWith('b:')) noteHouseholdChange(r.updated_by, findBox(r.id.slice(2))); } catch {}
    }
    cloud.cursor = rows[rows.length - 1].updated_at; await saveCloud();
    if (rows.length < 500) break;
  }
  if (changed && ready) render();
  flushHouseholdChanges();
}
async function applyRecord(r){
  const t = r.id.slice(0, 1), id = r.id.slice(2);
  if (t === 'b'){
    if (r.deleted){ boxes = boxes.filter(b => b.id !== id); await dbDelRaw(id).catch(() => {}); return; }
    const b = await fromPayload(r.payload); if (!b) return; const i = boxes.findIndex(x => x.id === b.id);
    if (i < 0) boxes.push(b); else boxes[i] = b;
    await dbPutRaw(b);
  } else if (t === 'u'){
    const v = await fromPayload(r.payload); memberNames[id] = (v && v.name) || ''; await metaPutRaw('memberNames', memberNames);
  } else if (t === 'm'){
    const v = await fromPayload(r.payload); if (v == null) return;
    if (id === 'places') places = v; else if (id === 'household') household = v; else if (id === 'trash') trash = v; else if (id === 'boxOrder') boxOrder = v; else if (id === 'move') move = v; else return;
    await metaPutRaw(id, v);
  }
}
async function cloudPhoto(ref){
  if (!cloud.hid || !cloud.session || !navigator.onLine) return null;
  const r = await sb(`/storage/v1/object/authenticated/photos/${cloud.hid}/${encodeURIComponent(ref)}`, {raw: true});
  let blob = await r.blob();
  if (/octet-stream/.test(r.headers.get('content-type') || '')){ if (!cryptoKey) await loadKey(); if (cryptoKey) try { blob = await decBlob(await blob.arrayBuffer()); } catch {} }
  await phPutRaw(ref, blob);
  return blob;
}
async function cloudInit(){
  cloud = await metaGet('cloud').catch(() => null) || {};
  dirty = new Set(await metaGet('syncDirty').catch(() => null) || []);
  statsOn = (await metaGet('statsOn').catch(() => undefined)) !== false;
  evq = await metaGet('evq').catch(() => null) || [];
  memberNames = await metaGet('memberNames').catch(() => null) || {};
  await takeAuthFromUrl();
  await loadKey().catch(() => {});
  const pj = await metaGet('pendingJoin').catch(() => null); pendingJoinCode = pj || null;
  if (pj){
    if (cloud.session){ await metaPutRaw('pendingJoin', null).catch(() => {}); setTimeout(() => joinFromLink('#join=' + pj), 300); }
    else if (me || boxes.some(b => !b.loose)) setTimeout(() => { toast(tr('loginToJoin')); cloudSheet(); }, 300);
  }
  if (cloud.hid && cloud.session) scheduleSync(500);
  checkAdmin(); loadProfile(); presenceTick();
}
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); else { flushEvents(true); if (dirty.size) syncNow(); } });
window.addEventListener('online', () => scheduleSync(500));
window.addEventListener('hashchange', () => { if (location.hash.includes('join=')){ const h = location.hash; try { history.replaceState(null, '', APP_URL); } catch {} joinFromLink(h); } });

/* ---------- the "Household & sync" sheet ---------- */
function syncText(){
  if (!navigator.onLine) return tr('offlineSync');
  if (syncErr) return syncErr;
  if (syncing) return tr('syncing');
  if (dirty.size) return tr('waitingN', dirty.size);
  return cloud.lastSync ? tr('syncedAt', fmtStamp(cloud.lastSync)) : '';
}
function updateCloudLine(){ const el = $('#cloudLine'); if (el) el.textContent = syncText(); }
function loginForm(compact){
  return `<input class="input" id="clEmail" type="email" inputmode="email" autocomplete="email" placeholder="${esc(tr('yourEmail'))}" value="${esc(cloud.email || '')}">
    <button class="btn primary block" id="clSend" style="margin-top:8px">${tr('sendCode')}</button>${compact ? '' : `<p class="proof">${tr('loginHint')}</p>`}`;
}
function accountPitch(){
  return `<div class="pitch"><b>${tr('pitchTitle')}</b><ul>${['pitch1', 'pitch2', 'pitch3', 'pitch4'].map(k => `<li>${tr(k)}</li>`).join('')}</ul></div>`;
}
function codeSheet(email){
  openSheet(`<h3>📬 ${tr('checkMail')}</h3><p>${esc(tr('codeSent', email))} <button class="linkbtn" id="cdWrong">${tr('wrongAddress')}</button></p>
    <input class="input codein" id="cdIn" inputmode="numeric" autocomplete="one-time-code" placeholder="123456">
    ${navigator.clipboard && navigator.clipboard.readText ? `<button class="btn block icontext" id="cdPaste">📋 <span>${tr('pasteCode')}</span></button>` : ''}
    <button class="btn primary block" id="cdGo">${tr('logIn')}</button>
    <p class="hint">${tr('orTapLink')}</p>
    <div class="sheet-foot"><button class="btn" id="cdAgain">${tr('sendAgain')}</button><button class="btn" id="cdX">${tr('close')}</button></div>`);
  const go = async () => {
    const c = $('#cdIn').value.replace(/\D/g, ''); if (c.length < 6) return $('#cdIn').focus();
    $('#cdGo').disabled = true;
    try { await verifyCode(email, c); closeSheet(); location.replace(APP_URL); }
    catch (e){ $('#cdGo').disabled = false; toast(e.status === 403 || e.status === 400 ? tr('codeWrong') : tr('sendFailed')); }
  };
  $('#cdGo').onclick = go;
  const clean = v => (v || '').replace(/\D/g, '');
  $('#cdIn').addEventListener('input', e => { const d = clean(e.target.value); if (d !== e.target.value) e.target.value = d; if (e.inputType === 'insertFromPaste' && (d.length === 6 || d.length === 8)) go(); });
  if ($('#cdPaste')) $('#cdPaste').onclick = async () => { try { const d = clean(await navigator.clipboard.readText()); if (d.length >= 6){ $('#cdIn').value = d.slice(0, 10); go(); } else toast(tr('noCodeCopied')); } catch { $('#cdIn').focus(); toast(tr('pasteManually')); } };
  $('#cdIn').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#cdWrong').onclick = () => { closeSheet(); cloudSheet(); };
  $('#cdAgain').onclick = async () => { try { await sendLoginLink(email); toast(tr('sentAgain')); } catch (er){ toast(er.status === 429 ? tr('tooMany') : tr('sendFailed')); } };
  $('#cdX').onclick = closeSheet;
}
function sendErrorSheet(msg, status, detail){
  openSheet(`<h3>${tr('mailNotSent')}</h3><p>${esc(msg)}</p>${status || detail ? `<p class="proof">${esc(tr('errorCode'))}: ${esc(String(status || ''))} ${esc(detail)}</p>` : ''}
    <div class="sheet-foot"><button class="btn primary" id="seOk">${tr('ok')}</button></div>`);
  $('#seOk').onclick = closeSheet;
}
function wireLogin(){
  const b = $('#clSend'); if (!b) return;
  b.onclick = async () => {
    const e = $('#clEmail').value.trim(); if (!/^\S+@\S+\.\S+$/.test(e)){ $('#clEmail').focus(); return toast(tr('badEmail')); }
    if (!navigator.onLine) return toast(tr('offlineSend'));
    const label = b.textContent; b.disabled = true; b.textContent = tr('sending');
    try {
      await Promise.race([sendLoginLink(e), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), {status: 'timeout'})), 25000))]);
      cloud.email = e; await saveCloud(); b.disabled = false; b.textContent = label; codeSheet(e);
    } catch (er){
      b.disabled = false; b.textContent = label;
      const detail = er.status === 'timeout' ? '' : (String(er.message || '').match(/"(?:msg|message|error_description)":"([^"]+)"/) || [])[1] || '';
      track('login_send_fail', {status: String(er.status || 'net')});
      sendErrorSheet(er.status === 429 ? tr('tooMany') : er.status === 'timeout' ? tr('sendTimeout') : tr('sendFailed'), er.status, detail);
    }
  };
}
async function cloudSheet(){
  const placeRows = places.map(p => `<div class="prow"><span>${placeIcon(p)} ${esc(p.name)}</span><small>${tr('boxes_n', boxesIn(p.id).length).toLowerCase()}</small></div>`).join('');
  openSheet(`<h3>${ICON.cloud} ${tr('cloudMenu')}</h3>
    <h4 class="adh">${tr('yourAccount')}</h4>
    ${cloud.session ? `<div class="prow"><span>👤 ${esc(me || tr('you'))}</span><small>${esc(cloud.email || '')}</small></div>${cloud.hid ? `<p class="proof" id="cloudLine">${esc(syncText())}</p>` : ''}`
      : `${accountPitch()}${loginForm()}`}
    <h4 class="adh">${tr('peopleTitle')}</h4><p class="proof" style="margin-top:0">${tr('peopleHint')}</p>
    <div id="hhPeople"><p class="hint">…</p></div>
    <div class="vtype"><input class="input" id="hhName" placeholder="${esc(tr('addName'))}" autocapitalize="words"><button class="btn" id="hhAdd">${tr('add')}</button></div>
    <div id="clQR"></div>
    <h4 class="adh">${tr('storagePlaces')}</h4>${placeRows}<button class="btn block" data-m2="places">${tr('editPlaces')}</button>
    ${cloud.hid && cloud.session ? `<p class="hint" style="margin-top:14px">${tr('e2eNote')}</p><button class="btn block" id="clSync">${tr('syncNow')}</button><button class="btn block" id="clJoin">${tr('joinOther')}</button>` : ''}
    <div class="sheet-foot"><button class="btn" id="clX">${tr('close')}</button></div>`);
  let members = [], invites = [];
  const drawPeople = () => {
    const rows = [];
    members.filter(r => r.user_id !== myId()).forEach(r => rows.push(`<div class="prow"><span>👤 ${esc(memberNames[r.user_id] || tr('someone'))}</span><small class="online">${others.some(o => o.user_id === r.user_id) ? '● ' + tr('activeNow') : '✓ ' + tr('inAppTag')}</small></div>`));
    const memberSet = new Set(members.map(r => memberNames[r.user_id]).filter(Boolean));
    household.filter(n => n !== me && !memberSet.has(n)).forEach(n => {
      const inv = invites.find(i => i.who === n && !i.used_at && new Date(i.expires_at) > new Date());
      rows.push(`<div class="prow"><span>${esc(n)}</span><span class="pact">${inv ? `<small>${tr('invitePending')}</small>` : ''}<button class="linkbtn" data-inv="${esc(n)}">${inv ? tr('inviteAgain') : tr('inviteToApp')}</button><button class="linkbtn muted" data-pdel="${esc(n)}" aria-label="${esc(tr('remove'))}">✕</button></span></div>`);
    });
    $('#hhPeople').innerHTML = `<div class="prow"><span>👤 ${esc(me || tr('you'))} <small>${tr('youTag')}</small></span></div>` + rows.join('');
  };
  drawPeople();
  const add = () => { const n = addPerson($('#hhName').value); $('#hhName').value = ''; if (n) drawPeople(); };
  $('#hhAdd').onclick = add; $('#hhName').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  $('#hhPeople').onclick = async e => {
    const d = e.target.closest('[data-pdel]'); if (d){ household = household.filter(n => n !== d.dataset.pdel); metaPut('household', household).catch(() => {}); return drawPeople(); }
    const iv = e.target.closest('[data-inv]'); if (!iv) return;
    const who = iv.dataset.inv, box = $('#clQR');
    if (!cloud.session){ box.innerHTML = `<div class="invitebox"><b>${esc(tr('inviteFor', who))}</b><p class="hint">${tr('loginToInvite')}</p></div>`; const em = $('#clEmail'); if (em){ em.scrollIntoView({block: 'center'}); em.focus(); } return; }
    if (!cloud.hid){ box.innerHTML = `<div class="invitebox"><p class="hint">${tr('notSharedYet')}</p><button class="btn primary block" id="clConn">${tr('connectNow')}</button></div>`; $('#clConn').onclick = async () => { try { await connectAccount(); cloudSheet(); } catch { toast(tr('syncFailed')); } }; return; }
    iv.disabled = true; box.innerHTML = `<div class="invitebox"><p class="hint">${tr('creatingInvite')}</p></div>`; box.scrollIntoView({block: 'nearest'});
    try {
      const link = await inviteLink(who); track('invite');
      $('#clQR').innerHTML = `<div class="invitebox"><b>${esc(tr('inviteFor', who))}</b><button class="btn primary block" id="clShare">${tr('sendInvite')}</button>
        <div class="inviteqr">${qrSvg(link, 4)}</div><p class="hint center">${tr('inviteHint2')}</p><p class="proof center">${tr('inviteSafe')}</p></div>`;
      $('#clShare').onclick = () => { const txt = tr('inviteMsg', me || 'Storrrage'); if (navigator.share) navigator.share({title: 'Storrrage', text: txt, url: link}).catch(() => {}); else navigator.clipboard.writeText(txt + ' ' + link).then(() => toast(tr('copied'))).catch(() => {}); };
      $('#clQR').scrollIntoView({block: 'nearest'});
      await loadInvites(); drawPeople();
    } catch (er){ box.innerHTML = `<div class="invitebox"><b>${tr('inviteFailed')}</b><p class="proof">${esc(String(er.status || ''))} ${esc(String(er.message || '').slice(0, 160))}</p></div>`; }
    iv.disabled = false;
  };
  sheet.querySelector('[data-m2="places"]').onclick = () => placesSheet();
  $('#clX').onclick = closeSheet;
  wireLogin();
  if ($('#clJoin')) $('#clJoin').onclick = () => scanSheet();
  if ($('#clSync')) $('#clSync').onclick = async () => { $('#cloudLine').textContent = tr('syncing'); await syncNow(); render(); updateCloudLine(); };
  async function loadInvites(){
    try { const rows = await rpc('household_invites', {hid: cloud.hid}) || []; invites = []; for (const r of rows){ let who = ''; try { who = r.note ? await fromPayload(r.note) : ''; } catch {} invites.push(Object.assign({who}, r)); } } catch {}
  }
  if (cloud.hid && cloud.session){
    try { members = await sb('/rest/v1/members?select=user_id,role,joined_at&household_id=eq.' + cloud.hid) || []; hhInfo.n = members.length; } catch {}
    await loadInvites();
    if ($('#hhPeople')) drawPeople();
  }
}
async function drawInvites(){
  const el = $('#hhInvites'); if (!el) return;
  try {
    const rows = await rpc('household_invites', {hid: cloud.hid}) || [];
    const out = [];
    for (const r of rows){
      let who = ''; try { who = r.note ? await fromPayload(r.note) : ''; } catch {}
      const st = r.used_at ? `✓ ${tr('joinedOn', fmtDate(r.used_at))}${r.used_by && memberNames[r.used_by] && memberNames[r.used_by] !== who ? ' · ' + esc(memberNames[r.used_by]) : ''}` : new Date(r.expires_at) < new Date() ? tr('expired') : tr('waitingUntil', fmtStamp(r.expires_at));
      out.push(`<div class="prow"><span>${esc(who || tr('invite1'))}</span><small class="${r.used_at ? 'online' : ''}">${st}</small></div>`);
    }
    el.innerHTML = out.join('') || `<p class="hint">${tr('noInvites')}</p>`;
  } catch { el.innerHTML = `<p class="hint">${tr('noInvites')}</p>`; }
}
function pfacts(){
  const nI = boxes.reduce((s, b) => s + (b.items || []).length, 0);
  const rows = [];
  if (cloud.hid) rows.push([tr('household'), `${tr('membersN', hhInfo.n || 1)}${hhInfo.role === 'owner' ? ' · ' + tr('ownerTag') : ''}`]);
  else rows.push([tr('household'), tr('noHousehold')]);
  if (hhInfo.joined) rows.push([tr('memberSince'), fmtDate(hhInfo.joined)]);
  rows.push([tr('inStorage'), `${tr('places_n', places.length).toLowerCase()} · ${tr('boxes_n', realBoxes().length).toLowerCase()} · ${tr('items_n', nI).toLowerCase()}`]);
  if (cloud.lastSync) rows.push([tr('lastSynced'), fmtStamp(cloud.lastSync)]);
  return rows.map(([k, v]) => `<div class="prow"><span>${esc(k)}</span><small>${esc(v)}</small></div>`).join('');
}
/* ---------- profile on the server: only the e-mail reminder choice ---------- */
async function loadProfile(){
  if (!cloud.session) return;
  try { const r = await sb('/rest/v1/profiles?select=notify_email,contact_email&user_id=eq.' + myId()); prof = (r && r[0]) || {}; } catch {}
  try { const r = await sb('/rest/v1/members?select=role,joined_at,household_id&user_id=eq.' + myId()); const m = (r || []).find(x => x.household_id === (cloud.hid || cloud.lockedHid)); if (m){ hhInfo.role = m.role; hhInfo.joined = m.joined_at; } } catch {}
  if (view.name === 'profile') render();
}
async function saveProfile(){
  if (!cloud.session) return;
  try { await sb('/rest/v1/profiles', {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'}, body: {user_id: myId(), notify_email: !!prof.notify_email, contact_email: prof.contact_email || null}}); toast(tr('saved')); }
  catch { toast(tr('syncFailed')); }
}

/* ---------- who is here right now: lets you see if someone else is in the same box ---------- */
let presT = null, presSig = '';
async function presenceTick(){
  clearTimeout(presT);
  const inBox = view.name === 'box' || view.name === 'item';
  presT = setTimeout(presenceTick, inBox ? 12000 : 45000);
  if (!cloud.hid || !cloud.session || !navigator.onLine || document.visibilityState !== 'visible') return;
  try {
    await sb('/rest/v1/presence', {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'}, body: {household_id: cloud.hid, user_id: myId(), box_id: inBox ? view.boxId : null, item_id: view.name === 'item' ? view.itemId : null, seen_at: new Date().toISOString()}});
    const since = new Date(Date.now() - 40000).toISOString();
    others = await sb(`/rest/v1/presence?select=user_id,box_id,item_id&household_id=eq.${cloud.hid}&user_id=neq.${myId()}&seen_at=gt.${encodeURIComponent(since)}`) || [];
    const sig = JSON.stringify(others);
    if (sig !== presSig){
      presSig = sig;
      if (view.name === 'item'){ const old = app.querySelector('.presence'), [it, b] = curItem(); const html = it ? presenceNote(b.id, it.id) : ''; if (old) old.outerHTML = html || ''; else if (html){ const c = app.querySelector('.crumbs'); if (c) c.insertAdjacentHTML('afterend', html); } }
      else if (['box', 'home'].includes(view.name)) render();
      if (others.length) scheduleSync(200);
    }
  } catch {}
}
let presKick = null;
function presenceSoon(){ clearTimeout(presKick); presKick = setTimeout(presenceTick, 600); }
const whoName = uid => memberNames[uid] || tr('someone');
function presenceNote(boxId, itemId){
  const here = others.filter(o => o.box_id === boxId); if (!here.length) return '';
  const sameItem = itemId && here.filter(o => o.item_id === itemId);
  const names = [...new Set(here.map(o => whoName(o.user_id)))].join(', ');
  return `<p class="presence">✏️ ${esc(sameItem && sameItem.length ? tr('editingItem', [...new Set(sameItem.map(o => whoName(o.user_id)))].join(', ')) : tr('inThisBox', names))}</p>`;
}
const presenceBadge = boxId => { const h = others.filter(o => o.box_id === boxId); return h.length ? `<span class="herebadge" title="${esc(h.map(o => whoName(o.user_id)).join(', '))}">${esc((whoName(h[0].user_id)[0] || '•').toUpperCase())}</span>` : ''; };

/* ---------- anonymous usage statistics: what people do, never what they have ---------- */
let statsOn = true, evq = [], evT = null;
function deviceTag(){
  const month = new Date().toISOString().slice(0, 7);
  let d = null; try { d = JSON.parse(sessionStorage.getItem('sdev') || 'null'); } catch {}
  if (!d || d.m !== month){ d = {m: month, id: (cloud.dev && cloud.dev.m === month) ? cloud.dev.id : newId()}; cloud.dev = d; saveCloud(); try { sessionStorage.setItem('sdev', JSON.stringify(d)); } catch {} }
  return d.id;
}
function track(name, props){
  if (!statsOn) return;
  try {
    const clean = {}; Object.entries(props || {}).forEach(([k, v]) => { if (['string', 'number', 'boolean'].includes(typeof v)) clean[k] = typeof v === 'string' ? v.slice(0, 30) : v; });
    evq.push({name: String(name).slice(0, 40), props: clean, device: deviceTag(), app_version: APP_VERSION});
    if (evq.length > 300) evq = evq.slice(-300);
    clearTimeout(evT); evT = setTimeout(() => flushEvents(false), 20000);
  } catch {}
}
async function flushEvents(leaving){
  if (!statsOn || !evq.length) return;
  if (!navigator.onLine){ metaPutRaw('evq', evq).catch(() => {}); return; }
  const batch = evq; evq = [];
  try { await sb('/rest/v1/events', {method: 'POST', auth: false, keepalive: leaving, headers: {Prefer: 'return=minimal'}, body: batch}); metaPutRaw('evq', []).catch(() => {}); }
  catch { evq = batch.concat(evq).slice(-300); metaPutRaw('evq', evq).catch(() => {}); }
}
async function statsNotice(){
  if (await metaGet('statsNoticed').catch(() => false)) return;
  metaPutRaw('statsNoticed', true).catch(() => {});
  setTimeout(() => toastAction(tr('statsToast'), tr('statsWhat'), () => navigate({name: 'settings'})), 2500);
}

/* ---------- feedback ---------- */
function feedbackSheet(){
  openSheet(`<h3>${ICON.chat} ${tr('feedback')}</h3><p class="hint">${tr('feedbackIntro')}</p>
    <div class="chips" id="fbKind"><button class="chipbtn on" data-k="idea">💡 ${tr('fbIdea')}</button><button class="chipbtn" data-k="bug">🐞 ${tr('fbBug')}</button><button class="chipbtn" data-k="love">❤️ ${tr('fbLove')}</button></div>
    <textarea class="input" id="fbText" rows="5" maxlength="4000" placeholder="${esc(tr('fbPh'))}" style="margin-top:10px"></textarea>
    <label class="field"><span>${tr('fbContact')}</span><input class="input" id="fbContact" type="email" inputmode="email" placeholder="${esc(tr('optional'))}" value=""></label>
    <p class="proof">${tr('fbPrivacy')}</p>
    <div class="sheet-foot"><button class="btn quiet" id="fbX">${tr('cancel')}</button><button class="btn primary" id="fbSend">${tr('send')}</button></div>`);
  let kind = 'idea';
  $('#fbKind').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; kind = b.dataset.k; $('#fbKind').querySelectorAll('.chipbtn').forEach(x => x.classList.toggle('on', x === b)); };
  $('#fbX').onclick = closeSheet;
  $('#fbSend').onclick = async () => {
    const msg = $('#fbText').value.trim(); if (!msg) return $('#fbText').focus();
    $('#fbSend').disabled = true;
    try {
      await sb('/rest/v1/feedback', {method: 'POST', auth: false, headers: {Prefer: 'return=minimal'}, body: {message: msg, kind, screen: view.name + (view.name === 'home' ? ':' + placeView : ''), app_version: APP_VERSION, contact: $('#fbContact').value.trim() || null}});
      closeSheet(); toast(tr('fbThanks')); track('feedback', {kind});
    } catch { $('#fbSend').disabled = false; toast(navigator.onLine ? tr('sendFailed') : tr('offlineSend')); }
  };
}

Object.assign(STR.en, {cloudMenu: 'Account & sharing', cloudTitle: 'Share with your household', cloudIntro: 'Log in to use Storrrage on several phones and share with the people you live with. Only you and the people you invite can see what you store.',
  email: 'E-mail', emailWhy: 'Only used to log in. No password, no newsletters.', sendLink: 'Send login link', checkMail: 'Check your e-mail', linkSent: e => `We sent a login link to ${e}.`, linkSamePhone: 'Open the link on this phone. It can take a minute – check the spam folder too.',
  tooMany: 'Too many links sent just now – try again in a while.', sendFailed: 'Couldn’t send. Try again.', loginFailed: 'Login didn’t work.', loggedIn: 'You’re logged in.', loggedOut: 'Logged out. Your things are still on this phone.', loginAgain: 'Log in again to keep syncing.',
  loggedInAs: e => `Logged in as ${e}`, createHousehold: 'Start a household', createHint: 'Your things are uploaded to your household. Then you can invite others.', joinHousehold: 'Join with a QR code', joinHint: 'Scan the code on the other person’s phone.', logout: 'Log out', logoutQ: 'Log out? Your things stay on this phone but stop syncing.',
  householdCreated: 'Household created – now invite the others.', yourHousehold: 'Your household', membersN: n => n === 1 ? '1 member' : `${n} members`, e2eNote: 'Stored in your account on servers in the EU. Only you and the people you invite can see it.',
  invite: 'Invite someone', inviteHint: 'Let them scan this with the phone camera or inside Storrrage (☰ → Scan label).', shareLink: 'Share link instead', inviteSafe: 'The code works once, for 24 hours. The key is in the link itself and never passes our server.', inviteText: 'Join our storage in Storrrage', copied: 'Copied.',
  syncNow: 'Sync now', syncing: 'Syncing…', syncedAt: t => `Synced ${t}`, waitingN: n => `${n} changes waiting to sync`, offlineSync: 'Offline – syncs when you have signal.', syncFailed: 'Couldn’t sync right now.', notMember: 'You’re no longer in this household.',
  badInvite: 'That invite doesn’t look right.', loginToJoin: 'Log in first, then the invite is used automatically.', switchHouseholdQ: 'You’re already in a household. Switch to the new one?', join: 'Join',
  mergeQ: 'Bring along what’s already on this phone? Otherwise only the household’s things are kept here.', mergeYes: 'Yes, bring it', mergeNo: 'No', haveHousehold: 'Already have a household or an invite? Log in', joined: 'You’re in the household!', joinFailed: 'Couldn’t join. The code may be used or too old.',
  statsSetting: 'Share anonymous usage statistics', statsHint: 'Only what is used (e.g. “list view opened”), never what you own, names or places. Not linked to your account. Helps us make Storrrage better.',
  statsToast: 'Storrrage sends anonymous usage stats – never your things.', statsWhat: 'Settings',
  feedback: 'Give feedback', feedbackIntro: 'What’s good, what’s annoying, what’s missing? We read everything.', fbIdea: 'Idea', fbBug: 'Something’s wrong', fbLove: 'I like', fbPh: 'Write here…', fbContact: 'E-mail, if you want an answer', optional: 'optional',
  fbPrivacy: 'Sent without your account. App version and which screen you were on are included.', send: 'Send', fbThanks: 'Thanks! 💜', offlineSend: 'No signal – try again when you’re online.', ok: 'OK'});
Object.assign(STR.sv, {cloudMenu: 'Konto & delning', cloudTitle: 'Dela med ditt hushåll', cloudIntro: 'Logga in för att använda Storrrage på flera telefoner och dela med dem du bor med. Bara du och de du bjuder in kan se det du sparar.',
  email: 'E-post', emailWhy: 'Används bara för inloggning. Inget lösenord, inga nyhetsbrev.', sendLink: 'Skicka inloggningslänk', checkMail: 'Kolla din e-post', linkSent: e => `Vi har skickat en inloggningslänk till ${e}.`, linkSamePhone: 'Öppna länken på den här telefonen. Det kan ta en minut – kolla skräpposten också.',
  tooMany: 'För många länkar skickade just nu – försök igen om en stund.', sendFailed: 'Kunde inte skicka. Försök igen.', loginFailed: 'Inloggningen fungerade inte.', loggedIn: 'Du är inloggad.', loggedOut: 'Utloggad. Dina saker finns kvar på telefonen.', loginAgain: 'Logga in igen för att fortsätta synka.',
  loggedInAs: e => `Inloggad som ${e}`, createHousehold: 'Starta ett hushåll', createHint: 'Dina saker laddas upp till hushållet. Sedan kan du bjuda in andra.', joinHousehold: 'Gå med via QR-kod', joinHint: 'Skanna koden på den andras telefon.', logout: 'Logga ut', logoutQ: 'Logga ut? Dina saker finns kvar på telefonen men slutar synkas.',
  householdCreated: 'Hushållet är skapat – bjud in de andra.', yourHousehold: 'Ditt hushåll', membersN: n => n === 1 ? '1 medlem' : `${n} medlemmar`, e2eNote: 'Sparas i ditt konto på servrar i EU. Bara du och de du bjuder in kan se det.',
  invite: 'Bjud in någon', inviteHint: 'Låt dem skanna med telefonens kamera eller i Storrrage (☰ → Skanna etikett).', shareLink: 'Dela länk i stället', inviteSafe: 'Koden fungerar en gång i 24 timmar. Nyckeln ligger i själva länken och passerar aldrig vår server.', inviteText: 'Gå med i vår förvaring i Storrrage', copied: 'Kopierat.',
  syncNow: 'Synka nu', syncing: 'Synkar…', syncedAt: t => `Synkat ${t}`, waitingN: n => `${n} ändringar väntar på att synkas`, offlineSync: 'Offline – synkar när du har täckning.', syncFailed: 'Kunde inte synka just nu.', notMember: 'Du är inte längre med i det här hushållet.',
  badInvite: 'Inbjudan ser inte rätt ut.', loginToJoin: 'Logga in först, sedan används inbjudan automatiskt.', switchHouseholdQ: 'Du är redan med i ett hushåll. Byta till det nya?', join: 'Gå med',
  mergeQ: 'Ta med det som redan finns på den här telefonen? Annars behålls bara hushållets saker här.', mergeYes: 'Ja, ta med', mergeNo: 'Nej', haveHousehold: 'Har du redan ett hushåll eller en inbjudan? Logga in', joined: 'Du är med i hushållet!', joinFailed: 'Kunde inte gå med. Koden kan vara använd eller för gammal.',
  statsSetting: 'Dela anonym användningsstatistik', statsHint: 'Bara vad som används (t.ex. ”listvyn öppnades”), aldrig vad du äger, namn eller platser. Inte kopplat till ditt konto. Hjälper oss göra Storrrage bättre.',
  statsToast: 'Storrrage skickar anonym användningsstatistik – aldrig dina saker.', statsWhat: 'Inställningar',
  feedback: 'Tyck till', feedbackIntro: 'Vad är bra, vad stör, vad saknas? Vi läser allt.', fbIdea: 'Idé', fbBug: 'Något är fel', fbLove: 'Gillar', fbPh: 'Skriv här…', fbContact: 'E-post, om du vill ha svar', optional: 'valfritt',
  fbPrivacy: 'Skickas utan koppling till ditt konto. Appversion och vilken skärm du var på följer med.', send: 'Skicka', fbThanks: 'Tack! 💜', offlineSend: 'Ingen täckning – försök igen när du är online.', ok: 'OK'});


/* ---------- admin: statistics and feedback, only for accounts in the admins table ---------- */
async function checkAdmin(){ if (!cloud.session) return; try { cloud.admin = !!(await rpc('is_admin')); await saveCloud(); } catch { cloud.admin = false; } }
async function adminSheet(){
  openSheet(`<h3>📊 ${tr('adminTitle')}</h3><p class="hint">${tr('loading')}</p>`);
  let s, fb;
  try { [s, fb] = await Promise.all([rpc('admin_stats'), rpc('admin_feedback', {lim: 100})]); }
  catch { sheet.querySelector('.sheet').innerHTML = `<h3>📊 ${tr('adminTitle')}</h3><p class="hint">${tr('adminFail')}</p><div class="sheet-foot"><button class="btn" id="adX">${tr('close')}</button></div>`; $('#adX').onclick = closeSheet; return; }
  const num = (v, l) => `<div class="kpi"><b>${nf.format(v || 0)}</b><span>${esc(l)}</span></div>`;
  const bars = (rows, label, val) => { const max = Math.max(1, ...rows.map(val)); return `<div class="bars">${rows.map(r => `<div class="bar"><span class="bl">${esc(label(r))}</span><span class="bt"><i style="width:${Math.round(val(r) / max * 100)}%"></i></span><span class="bv">${nf.format(val(r))}</span></div>`).join('')}</div>`; };
  const EV = {open: tr('evOpen'), view: tr('evView'), item_add: tr('evItemAdd'), item_save: tr('evItemSave'), search: tr('evSearch'), search_quick: tr('evSearchQuick'), place_view: tr('evPlaceView'), sort: tr('evSort'), drag: tr('evDrag'), trash_restore: tr('evRestore'), feedback: tr('feedback'), login: tr('evLogin'), login_link: tr('evLoginLink'), household_create: tr('evHhCreate'), household_join: tr('evHhJoin'), invite: tr('evInvite')};
  const groups = {}; (s.details || []).forEach(d => { (groups[d.name] = groups[d.name] || []).push(d); });
  sheet.querySelector('.sheet').innerHTML = `<h3>📊 ${tr('adminTitle')}</h3>
    <div class="kpis">${num(s.active7, tr('active7'))}${num(s.active30, tr('active30'))}${num(s.accounts, tr('accounts'))}${num(s.households, tr('households'))}${num(s.shared, tr('sharedHh'))}${num(s.feedbackN, tr('feedback'))}</div>
    <h4 class="adh">${tr('perWeek')}</h4>${(s.weeks || []).length ? bars(s.weeks.slice(0, 12), r => fmtDate(r.week), r => r.active) : `<p class="hint">${tr('noData')}</p>`}
    <h4 class="adh">${tr('used30')}</h4>${(s.events || []).length ? bars(s.events, r => EV[r.name] || r.name, r => r.n) : `<p class="hint">${tr('noData')}</p>`}
    ${Object.entries(groups).map(([k, rows]) => `<h4 class="adh">${esc(EV[k] || k)}</h4>${bars(rows, r => r.value ?? '–', r => r.n)}`).join('')}
    <h4 class="adh">${tr('versions')}</h4>${bars(s.versions || [], r => r.app_version || '?', r => r.n)}
    <h4 class="adh">${tr('feedback')} (${(fb || []).length})</h4>
    <div class="fblist">${(fb || []).map(f => `<div class="fbrow"><small>${esc(fmtStamp(f.created_at))} · ${esc({idea: '💡', bug: '🐞', love: '❤️'}[f.kind] || f.kind || '')} · ${esc(f.screen || '')} · ${esc(f.app_version || '')}</small><p>${esc(f.message)}</p>${f.contact ? `<a href="mailto:${esc(f.contact)}">${esc(f.contact)}</a>` : ''}</div>`).join('') || `<p class="hint">${tr('noData')}</p>`}</div>
    <p class="proof">${tr('adminNote')}</p>
    <div class="sheet-foot"><button class="btn" id="adX">${tr('close')}</button></div>`;
  $('#adX').onclick = closeSheet;
}

/* ---------- install as an app (no app store needed) ---------- */
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (ready) render(); });
window.addEventListener('appinstalled', () => { installEvt = null; track('installed'); toast(tr('installedToast')); if (ready) render(); });
const canInstall = () => !isStandalone() && (installEvt || isIOS());
async function installApp(){
  if (installEvt){ installEvt.prompt(); const r = await installEvt.userChoice.catch(() => ({})); track('install_prompt', {result: r.outcome || '?'}); installEvt = null; render(); return; }
  openSheet(`<h3>📲 ${tr('installTitle')}</h3>${isIOS() ? `<ol class="steps"><li>${tr('iosStep1')}</li><li>${tr('iosStep2')}</li><li>${tr('iosStep3')}</li></ol><p class="hint">${tr('iosNote')}</p>`
    : `<ol class="steps"><li>${tr('andStep1')}</li><li>${tr('andStep2')}</li></ol>`}<div class="sheet-foot"><button class="btn primary" id="inOk">${tr('ok')}</button></div>`);
  $('#inOk').onclick = closeSheet;
}
function installBanner(){
  if (!canInstall() || view.name === 'welcome' || sessionStorage.getItem('noInstall')) return '';
  return `<div class="installbar"><span>📲 ${tr('installBanner')}</span><span class="fhbtns"><button class="btn primary small" data-act="install">${tr('install')}</button><button class="linkbtn" data-act="noinstall" aria-label="${esc(tr('close'))}">✕</button></span></div>`;
}

Object.assign(STR.en, {adminTitle: 'Statistics & feedback', loading: 'Loading…', adminFail: 'Couldn’t load. Are you logged in as admin?', active7: 'active phones, 7 days', active30: 'active phones, 30 days', accounts: 'accounts', households: 'households', sharedHh: 'shared households',
  perWeek: 'Active phones per week', used30: 'Used the last 30 days', versions: 'App versions (14 days)', noData: 'No data yet.', adminNote: 'Phones are counted with an anonymous id that changes every month. People who turned statistics off aren’t counted.',
  evOpen: 'App opened', evView: 'Screen changes', evItemAdd: 'Quick add', evItemSave: 'Item saved', evSearch: 'Searches', evSearchQuick: 'Search filters', evPlaceView: 'Shelf / list / map', evSort: 'Sorting', evDrag: 'Drag & drop', evRestore: 'Restored from Deleted', evLogin: 'Logins', evLoginLink: 'Login links sent', evHhCreate: 'Households created', evHhJoin: 'Joined a household', evInvite: 'Invites',
  installTitle: 'Install Storrrage', install: 'Install', installBanner: 'Install Storrrage as an app on your phone', installedToast: 'Storrrage is on your home screen.',
  iosStep1: 'Tap the Share button (square with an arrow) at the bottom of Safari.', iosStep2: 'Choose “Add to Home Screen”.', iosStep3: 'Tap “Add”. Then always open Storrrage from the home screen.', iosNote: 'On iPhone it has to be Safari. The installed app has its own storage, so log in and join the household inside the app.',
  andStep1: 'Tap ⋮ at the top right in Chrome.', andStep2: 'Choose “Install app” or “Add to Home screen”.'});
Object.assign(STR.sv, {adminTitle: 'Statistik & feedback', loading: 'Laddar…', adminFail: 'Kunde inte hämta. Är du inloggad som admin?', active7: 'aktiva telefoner, 7 dagar', active30: 'aktiva telefoner, 30 dagar', accounts: 'konton', households: 'hushåll', sharedHh: 'delade hushåll',
  perWeek: 'Aktiva telefoner per vecka', used30: 'Använt senaste 30 dagarna', versions: 'Appversioner (14 dagar)', noData: 'Ingen data än.', adminNote: 'Telefoner räknas med ett anonymt id som byts varje månad. De som stängt av statistiken räknas inte.',
  evOpen: 'Appen öppnad', evView: 'Byten av skärm', evItemAdd: 'Snabbtillägg', evItemSave: 'Sak sparad', evSearch: 'Sökningar', evSearchQuick: 'Sökfilter', evPlaceView: 'Hylla / lista / karta', evSort: 'Sortering', evDrag: 'Dra och släpp', evRestore: 'Tagits tillbaka från Borttaget', evLogin: 'Inloggningar', evLoginLink: 'Inloggningslänkar skickade', evHhCreate: 'Hushåll skapade', evHhJoin: 'Gått med i hushåll', evInvite: 'Inbjudningar',
  installTitle: 'Installera Storrrage', install: 'Installera', installBanner: 'Installera Storrrage som app på telefonen', installedToast: 'Storrrage finns nu på hemskärmen.',
  iosStep1: 'Tryck på Dela-knappen (fyrkant med pil) längst ner i Safari.', iosStep2: 'Välj ”Lägg till på hemskärmen”.', iosStep3: 'Tryck ”Lägg till”. Öppna sedan alltid Storrrage från hemskärmen.', iosNote: 'På iPhone måste det vara Safari. Den installerade appen har eget minne, så logga in och gå med i hushållet inne i appen.',
  andStep1: 'Tryck på ⋮ uppe till höger i Chrome.', andStep2: 'Välj ”Installera app” eller ”Lägg till på startskärmen”.'});



Object.assign(STR.en, {usageSync: n => `Storrrage uses about ${n} MB on this phone. Everything is also synced with your household.`, nameShown: 'Shown to the others in your household.', loginEmail: 'Logged in with', mailReminders: 'E-mail me reminders (things to bring back, things not used for a long time)', otherEmail: 'Send to another address (optional)',
  mailHint: 'Coming soon. The e-mail only says that something needs attention – what it is stays in the app.', loginForMore: 'Log in to share with your household and get reminders by e-mail.', logIn: 'Log in',
  appearance: 'Appearance', light: 'Light', dark: 'Dark', auto: 'Automatic', advanced: 'More', restoreHint: 'Only needed for old backup files. Your things are kept safe by syncing with your household.',
  inApp: 'In the app', youTag: '(you)', morePeople: 'Others in the household', morePeopleHint: 'People who don’t use the app but own things, e.g. kids. Pick them as owner of a thing.', editPlaces: 'Edit places', shareTitle: 'Share between phones',
  someone: 'Someone', activeNow: 'in the app now', inThisBox: n => `${n} is in this box right now.`, editingItem: n => `${n} has this thing open right now – wait a moment so your changes don’t clash.`,
  talkH: 'Talk or write to Storrrage', tapTalk: 'Tap and talk', chatPh: 'Write, e.g. “where is the tent?”', simpleMode: 'Simple commands, works offline', aiOn: 'Turn on AI', offlineSimple: 'offline – simple commands',
  whatSay: 'What can I say? (also without signal)', noSignal: 'Without signal:', noSignalTxt2: 'all the commands above work offline. If the microphone needs signal on your phone, use the microphone on your keyboard instead.'});
Object.assign(STR.sv, {usageSync: n => `Storrrage använder ungefär ${n} MB på telefonen. Allt synkas också med hushållet.`, nameShown: 'Visas för de andra i hushållet.', loginEmail: 'Inloggad med', mailReminders: 'Mejla mig påminnelser (saker som ska tillbaka, saker som inte använts på länge)', otherEmail: 'Skicka till en annan adress (valfritt)',
  mailHint: 'Kommer snart. Mejlet säger bara att något behöver kollas – vad det är stannar i appen.', loginForMore: 'Logga in för att dela med hushållet och få påminnelser via e-post.', logIn: 'Logga in',
  appearance: 'Utseende', light: 'Ljust', dark: 'Mörkt', auto: 'Automatiskt', advanced: 'Mer', restoreHint: 'Behövs bara för gamla säkerhetskopior. Dina saker skyddas nu av synken med hushållet.',
  inApp: 'I appen', youTag: '(du)', morePeople: 'Fler i hushållet', morePeopleHint: 'Personer som inte använder appen men äger saker, t.ex. barn. Välj dem som ägare på en sak.', editPlaces: 'Ändra platser', shareTitle: 'Dela mellan telefoner',
  someone: 'Någon', activeNow: 'i appen nu', inThisBox: n => `${n} är i den här lådan just nu.`, editingItem: n => `${n} har den här saken öppen just nu – vänta en stund så era ändringar inte krockar.`,
  talkH: 'Prata eller skriv med Storrrage', tapTalk: 'Tryck och prata', chatPh: 'Skriv, t.ex. ”var är tältet?”', simpleMode: 'Enkla kommandon, funkar offline', aiOn: 'Slå på AI', offlineSimple: 'offline – enkla kommandon',
  whatSay: 'Vad kan jag säga? (även utan täckning)', noSignal: 'Utan täckning:', noSignalTxt2: 'alla kommandon ovan fungerar offline. Om mikrofonen kräver täckning på din telefon, använd mikrofonen på tangentbordet i stället.'});

Object.assign(STR.en, {noPlaceYet: 'No place yet', unsorted: 'Unsorted', addWhat: 'Add', where: 'Where?', notLoggedIn: 'You’re not logged in. Log in to share with your household and get reminders.',
  household: 'Household', ownerTag: 'you started it', lockedHere: 'Locked on this phone – scan a QR code from another phone', noHousehold: 'Not shared yet', memberSince: 'Member since', inStorage: 'Stored', lastSynced: 'Last synced',
  inviteWho: 'Who? (optional, e.g. Anna)', invitesSent: 'Invites', joinedOn: d => `joined ${d}`, expired: 'expired', waitingUntil: t => `waiting · valid until ${t}`, invite1: 'Invite', noInvites: 'No invites yet.',
  unlockTitle: 'Unlock on this phone', unlockHint: 'You’re in a household, but the key only lives on your phones. On another phone in the household: ☰ → Household & sync → Invite someone. Then scan the code here.', scanQR: 'Scan QR code',
  whatName: 'What’s your name?', startNew: 'Start a new storage', loginWelcome: 'We’ll send a link to your e-mail. Open it on this phone and you’re in – no password.', invitedIntro: 'You’ve been invited to a household! Log in with your e-mail and you’ll come straight into it.'});
Object.assign(STR.sv, {noPlaceYet: 'Ingen plats än', unsorted: 'Osorterat', addWhat: 'Lägg till', where: 'Var?', notLoggedIn: 'Du är inte inloggad. Logga in för att dela med hushållet och få påminnelser.',
  household: 'Hushåll', ownerTag: 'du startade det', lockedHere: 'Låst på den här telefonen – skanna en QR-kod från en annan telefon', noHousehold: 'Inte delat än', memberSince: 'Medlem sedan', inStorage: 'Förvarat', lastSynced: 'Senast synkat',
  inviteWho: 'Vem? (valfritt, t.ex. Anna)', invitesSent: 'Inbjudningar', joinedOn: d => `gick med ${d}`, expired: 'gick ut', waitingUntil: t => `väntar · giltig till ${t}`, invite1: 'Inbjudan', noInvites: 'Inga inbjudningar än.',
  unlockTitle: 'Lås upp på den här telefonen', unlockHint: 'Du är med i ett hushåll, men nyckeln finns bara på era telefoner. På en annan telefon i hushållet: ☰ → Hushåll & synk → Bjud in någon. Skanna sedan koden här.', scanQR: 'Skanna QR-kod',
  whatName: 'Vad heter du?', startNew: 'Starta ett nytt förråd', loginWelcome: 'Vi skickar en länk till din e-post. Öppna den på den här telefonen så är du inne – inget lösenord.', invitedIntro: 'Du har blivit inbjuden till ett hushåll! Logga in med din e-post så kommer du direkt in i det.'});

Object.assign(STR.en, {cloudIntro: 'Log in with your e-mail to keep your storage in your account. Then you can use it on your computer and other phones, share it with your household and log out if your phone gets lost.',
  e2eNote: 'Stored in your account on servers in the EU. Only you and the people you invite can see it.', inviteSafe: 'The code works once, for 24 hours.', connectNow: 'Save in my account',
  joinOther: 'Join another household (QR)', mergedIntoAccount: 'What was on this phone was added to your account.', logoutQ: 'Log out? Your storage is removed from this device but stays in your account – log in again to get it back.',
  unsyncedQ: n => `${n} changes haven’t been saved to your account yet (no signal?). Log out anyway? They will be lost.`, logoutAll: 'Log out on all devices', logoutAllQ: 'Log out on all your devices? Use this if a phone is lost. Each device removes your storage the next time it’s online.',
  logoutAllHint: 'Lost a phone? Log in here or on your computer and choose “Log out on all devices”.', loggedOut: 'Logged out. Your storage is safe in your account.', wipedRemote: 'You were logged out from another device, so the storage was removed from this one.'});
Object.assign(STR.sv, {cloudIntro: 'Logga in med din e-post så sparas förrådet i ditt konto. Då kommer du åt det från datorn och andra telefoner, kan dela med hushållet och logga ut om telefonen kommer bort.',
  e2eNote: 'Sparas i ditt konto på servrar i EU. Bara du och de du bjuder in kan se det.', inviteSafe: 'Koden fungerar en gång i 24 timmar.', connectNow: 'Spara i mitt konto',
  joinOther: 'Gå med i ett annat hushåll (QR)', mergedIntoAccount: 'Det som fanns på telefonen lades till i ditt konto.', logoutQ: 'Logga ut? Förrådet tas bort från den här enheten men finns kvar i ditt konto – logga in igen så kommer det tillbaka.',
  unsyncedQ: n => `${n} ändringar har inte sparats i kontot än (ingen täckning?). Logga ut ändå? De försvinner då.`, logoutAll: 'Logga ut på alla enheter', logoutAllQ: 'Logga ut på alla dina enheter? Använd det om en telefon kommit bort. Varje enhet tar bort förrådet nästa gång den är online.',
  logoutAllHint: 'Tappat telefonen? Logga in här eller på datorn och välj ”Logga ut på alla enheter”.', loggedOut: 'Utloggad. Förrådet är tryggt i ditt konto.', wipedRemote: 'Du loggades ut från en annan enhet, så förrådet togs bort härifrån.'});

Object.assign(STR.en, {codeSent: e => `We sent an e-mail to ${e}. Enter the code from it here:`, wrongAddress: 'Wrong address?', orTapLink: 'Or tap the button in the e-mail (on this device).', sendAgain: 'Send again', sentAgain: 'Sent again.', codeWrong: 'The code is wrong or too old. Try again or send a new one.'});
Object.assign(STR.sv, {codeSent: e => `Vi har skickat ett mejl till ${e}. Skriv in koden från mejlet här:`, wrongAddress: 'Fel adress?', orTapLink: 'Eller tryck på knappen i mejlet (på den här enheten).', sendAgain: 'Skicka igen', sentAgain: 'Skickat igen.', codeWrong: 'Koden stämmer inte eller är för gammal. Försök igen eller skicka en ny.'});

Object.assign(STR.en, {slogan: 'Know what you have – and where it is.', startNew: 'Start my storage', startNewHint: 'New here? Just enter your name and start. No account needed – everything is saved on your phone.',
  or: 'or', loginHint: 'Already have an account, or want one? We e-mail you a code – no password. You can share with others and reach everything from your computer.', yourEmail: 'Your e-mail', sendCode: 'Send code',
  invitedTitle: 'You’re invited!', invitedIntro: 'Enter your e-mail and we’ll send you a code. Then you’re straight into the shared storage.',
  pitchTitle: 'Create a free account – all you need is your e-mail', pitch1: 'Share with the people you live with', pitch2: 'Reach everything from your computer and other phones', pitch3: 'Safe if your phone gets lost', pitch4: 'More features coming for account holders',
  fold: 'Fold', unfold: 'Unfold', foldAll: 'Fold all', unfoldAll: 'Unfold all'});
Object.assign(STR.sv, {slogan: 'Ha koll på allt du har – och var det finns.', startNew: 'Starta mitt förråd', startNewHint: 'Ny här? Skriv bara ditt namn och kör igång. Inget konto behövs – allt sparas på telefonen.',
  or: 'eller', loginHint: 'Har du redan ett konto, eller vill skapa ett? Vi mejlar en kod – inget lösenord. Då kan du dela med andra och nå allt från datorn.', yourEmail: 'Din e-post', sendCode: 'Skicka kod',
  invitedTitle: 'Du är inbjuden!', invitedIntro: 'Skriv din e-post så mejlar vi en kod. Sedan kommer du direkt in i det delade förrådet.',
  pitchTitle: 'Skapa ett gratis konto – det räcker med e-post', pitch1: 'Dela med dem du bor med', pitch2: 'Nå allt från datorn och andra telefoner', pitch3: 'Tryggt om telefonen kommer bort', pitch4: 'Fler funktioner på väg för kontoinnehavare',
  fold: 'Fäll ihop', unfold: 'Fäll ut', foldAll: 'Fäll ihop alla', unfoldAll: 'Fäll ut alla'});

Object.assign(STR.en, {badEmail: 'Check the e-mail address.', sending: 'Sending…', sendTimeout: 'The mail server didn’t answer in time. Try again in a minute.', mailNotSent: 'The e-mail wasn’t sent', errorCode: 'Details'});
Object.assign(STR.sv, {badEmail: 'Kolla e-postadressen.', sending: 'Skickar…', sendTimeout: 'Mejlservern svarade inte i tid. Försök igen om en minut.', mailNotSent: 'Mejlet skickades inte', errorCode: 'Detaljer'});

Object.assign(STR.en, {moveLocalQ: n => `This phone has boxes and things (${n}) that aren’t in your account. Move them into your account? They’ll be marked “New” so you can find them.`, moveLocalYes: 'Yes, move them in', moveLocalNo: 'No, remove them', newTag: 'New',
  logInOrCreate: 'Log in or create an account', yourAccount: 'Your account', peopleTitle: 'People in the household', peopleHint: 'Add everyone who has things here. Invite those who want to use the app themselves.',
  inAppTag: 'uses the app', invitePending: 'invited', inviteAgain: 'Invite again', inviteToApp: 'Invite', loginToInvite: 'Log in first – then you can invite.', inviteFor: n => `Invite ${n}`, sendInvite: 'Send invite',
  inviteHint2: 'Or let them scan the code with their phone camera.', inviteMsg: n => `${n} invites you to share our storage in Storrrage:`, storageWord: 'Storage'});
Object.assign(STR.sv, {moveLocalQ: n => `Telefonen har lådor och saker (${n} st) som inte finns i ditt konto. Flytta in dem i kontot? De markeras ”Ny” så du hittar dem.`, moveLocalYes: 'Ja, flytta in', moveLocalNo: 'Nej, ta bort dem', newTag: 'Ny',
  logInOrCreate: 'Logga in eller skapa konto', yourAccount: 'Ditt konto', peopleTitle: 'Personer i hushållet', peopleHint: 'Lägg till alla som har saker här. Bjud in dem som själva vill använda appen.',
  inAppTag: 'använder appen', invitePending: 'inbjuden', inviteAgain: 'Bjud in igen', inviteToApp: 'Bjud in', loginToInvite: 'Logga in först – sedan kan du bjuda in.', inviteFor: n => `Bjud in ${n}`, sendInvite: 'Skicka inbjudan',
  inviteHint2: 'Eller låt hen skanna koden med telefonens kamera.', inviteMsg: n => `${n} bjuder in dig att dela vårt förråd i Storrrage:`, storageWord: 'Förvaring'});

Object.assign(STR.en, {notSharedYet: 'Your storage isn’t saved in your account yet.', creatingInvite: 'Creating the invite…', inviteFailed: 'Couldn’t create the invite.'});
Object.assign(STR.sv, {notSharedYet: 'Ditt förråd är inte sparat i kontot än.', creatingInvite: 'Skapar inbjudan…', inviteFailed: 'Kunde inte skapa inbjudan.'});

Object.assign(STR.en, {pasteCode: 'Paste code', noCodeCopied: 'No code copied – copy the digits in the e-mail first.', pasteManually: 'Long-press the field and choose Paste.',
  nameQ: 'What’s your name?', next: 'Next', hiName: n => `Hi ${n}!`, placeQ: 'What do you call the place where you store things?', kitQ: 'How do you want to start?',
  kitYes: 'Start kit', kitYesSub: '10 common boxes along three walls – rename or remove as you like', kitNo: 'Start empty', kitDone: 'Your start kit is ready. Tap a box to fill it.',
  zoneLeft: 'Left wall', zoneBack: 'Back wall', zoneRight: 'Right wall',
  kitXmas: 'Christmas', kitEaster: 'Easter & holidays', kitTools: 'Tools', kitCamping: 'Camping', kitSport: 'Sports', kitKidsClothes: 'Kids’ clothes', kitBooks: 'Books', kitCables: 'Cables & electronics', kitKitchen: 'Kitchen & china', kitMisc: 'Miscellaneous'});
Object.assign(STR.sv, {pasteCode: 'Klistra in koden', noCodeCopied: 'Ingen kod kopierad – kopiera siffrorna i mejlet först.', pasteManually: 'Håll inne i fältet och välj Klistra in.',
  nameQ: 'Vad heter du?', next: 'Nästa', hiName: n => `Hej ${n}!`, placeQ: 'Vad kallar du platsen där du förvarar saker?', kitQ: 'Hur vill du börja?',
  kitYes: 'Startkit', kitYesSub: '10 vanliga lådor längs tre väggar – byt namn eller ta bort som du vill', kitNo: 'Börja tomt', kitDone: 'Ditt startkit är klart. Tryck på en låda för att fylla den.',
  zoneLeft: 'Vänster vägg', zoneBack: 'Bakre väggen', zoneRight: 'Höger vägg',
  kitXmas: 'Julpynt', kitEaster: 'Påsk & högtider', kitTools: 'Verktyg', kitCamping: 'Camping', kitSport: 'Sport', kitKidsClothes: 'Barnkläder', kitBooks: 'Böcker', kitCables: 'Sladdar & elektronik', kitKitchen: 'Kök & porslin', kitMisc: 'Diverse'});

Object.assign(STR.en, {newThing: 'New thing', askAI: 'Ask · beta', searchWord: 'Search', newBox: 'New box'});
Object.assign(STR.sv, {newThing: 'Ny sak', askAI: 'Fråga · beta', searchWord: 'Sök', newBox: 'Ny låda'});

Object.assign(STR.en, {searchOrAsk: 'Search, or ask Storrrage…', askAbout: q => `Ask Storrrage: “${q}”`});
Object.assign(STR.sv, {searchOrAsk: 'Sök, eller fråga Storrrage…', askAbout: q => `Fråga Storrrage: ”${q}”`});
/* ====================================================================
   Labels that can be re-used, barcodes on things, and moving house
   ==================================================================== */
/* ---- labels: a label belongs to a box, but can be moved to another one ---- */
const labelOf = b => b.label || (b.labelGone ? '' : 'id:' + b.id);
const boxByLabel = lid => boxes.find(b => !b.loose && labelOf(b) === lid);
let assignLabelTo = null;   // box id waiting for a label to be scanned
function newLabelId(){ const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; const r = crypto.getRandomValues(new Uint8Array(6)); r.forEach(x => s += a[x % a.length]); return s; }
function giveLabel(boxId, lid){
  boxes.filter(b => b.id !== boxId && labelOf(b) === lid).forEach(o => { const no = clone(o); delete no.label; if (lid === 'id:' + o.id) no.labelGone = true; putBox(no, true); });
  const nb = clone(findBox(boxId)); if (!nb) return;
  nb.label = lid; delete nb.labelGone; putBox(nb, true);
  track('label_assign');
  toast(tr('labelLinked', nb.code));
}
/* everything the camera can read on a box label */
function handleScan(data){
  data = String(data || '');
  if (data.includes('#join=')){ closeSheet(); joinFromLink(data); return true; }
  let lid = null;
  if (data.startsWith('STRG:L:')) lid = data.slice(7);
  else if (data.startsWith('BOXES:id:')) lid = 'id:' + data.slice(9);
  if (!lid) return false;
  closeSheet();
  if (assignLabelTo){ const to = assignLabelTo; assignLabelTo = null; giveLabel(to, lid); openBox(to); return true; }
  const b = boxByLabel(lid) || (lid.startsWith('id:') ? findBox(lid.slice(3)) : null);
  if (b && !(b.labelGone && labelOf(b) !== lid)){ openBox(b.id); return true; }
  newLabelSheet(lid);
  return true;
}
function newLabelSheet(lid){
  openSheet(`<h3>${ICON.scan} ${tr('newLabelH')}</h3><p class="hint">${tr('newLabelHint')}</p>
    <div class="menu"><button class="btn primary block" id="nlNew">${tr('newLabelBox')}</button>
    <button class="btn block" id="nlLink">${tr('newLabelLink')}</button></div>
    <div class="sheet-foot"><button class="btn" id="nlX">${tr('cancel')}</button></div>`);
  $('#nlX').onclick = closeSheet;
  $('#nlNew').onclick = async () => {
    closeSheet();
    const n = await askText(tr('boxNameQ'), {placeholder: tr('boxNamePh'), ok: tr('saveBox')}); if (n === null || n === undefined) return;
    const pid = scopePlace() || places.find(p => !p.inbox)?.id || ensureInbox().id, now = new Date().toISOString();
    const b = {id: newId(), code: nextCode(pid), name: (n || '').trim() || tr('unnamed'), placeId: pid, items: [], label: lid, createdAt: now, updatedAt: now, checkedAt: now};
    if (move.active){ b.moveState = 'created'; }
    putBox(b, true); track('label_newbox'); openBox(b.id);
  };
  $('#nlLink').onclick = () => pickBoxSheet(tr('newLabelLink'), id => { giveLabel(id, lid); openBox(id); });
}
function pickBoxSheet(title, cb, filter){
  const list = realBoxes().filter(filter || (() => true)).sort((x, y) => placeName(x.placeId).localeCompare(placeName(y.placeId)) || byCode(x, y));
  openSheet(`<h3>${esc(title)}</h3><input class="input" id="pbQ" placeholder="${esc(tr('typeKeyword'))}"><div class="pblist" id="pbL"></div><div class="sheet-foot"><button class="btn" id="pbX">${tr('cancel')}</button></div>`);
  const draw = () => { const q = $('#pbQ').value.trim().toLowerCase(); $('#pbL').innerHTML = list.filter(b => !q || (b.code + ' ' + b.name + ' ' + placeName(b.placeId)).toLowerCase().includes(q)).map(b => `<button class="prow pick" data-pb="${esc(b.id)}"><span><b>${esc(b.code)}</b> ${esc(b.name)}</span><small>${esc(placeName(b.placeId))}</small></button>`).join('') || `<p class="hint">${tr('nothingHere')}</p>`; };
  draw(); $('#pbQ').oninput = draw; $('#pbX').onclick = closeSheet;
  $('#pbL').onclick = e => { const p = e.target.closest('[data-pb]'); if (!p) return; closeSheet(); cb(p.dataset.pb); };
}
function labelMenu(b){
  openSheet(`<h3>${tr('label')} ${esc(b.code)}</h3><div class="labelprev">${qrSvg(labelText(b), 3)}</div>
    <div class="menu"><button class="btn primary block" id="lmPrint">${tr('printLabel')}</button>
    <button class="btn block" id="lmScan">${tr('useOtherLabel')}</button>
    ${labelOf(b) ? `<button class="btn block" id="lmMove">${tr('moveLabel')}</button>` : ''}</div>
    <p class="proof">${tr('labelMenuHint')}</p>
    <div class="sheet-foot"><button class="btn" id="lmX">${tr('close')}</button></div>`);
  $('#lmX').onclick = closeSheet;
  $('#lmPrint').onclick = () => { closeSheet(); labels([findBox(b.id)]); };
  $('#lmScan').onclick = () => { assignLabelTo = b.id; scanSheet(); };
  if ($('#lmMove')) $('#lmMove').onclick = () => { const lid = labelOf(findBox(b.id)); pickBoxSheet(tr('moveLabel'), id => { giveLabel(id, lid); openBox(id); }, x => x.id !== b.id); };
}
async function blankLabels(){
  const v = await askText(tr('blankHowMany'), {value: '12', placeholder: '12', ok: tr('printLabel')}); if (!v) return;
  const n = Math.max(1, Math.min(60, parseInt(v, 10) || 12));
  const ls = Array.from({length: n}, () => `<div class="l"><div class="q">${qrSvg('STRG:L:' + newLabelId(), 6)}</div><div class="w"><div class="ln"></div><div class="ln"></div></div></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Storrrage – ${esc(tr('h_boxLabels'))}</title><style>
    body{font-family:Arial,sans-serif;margin:12mm}.g{display:grid;grid-template-columns:1fr 1fr;gap:8mm}
    .l{border:1.5px dashed #888;padding:6mm;display:flex;gap:6mm;align-items:center;break-inside:avoid}
    .q{width:34mm;height:34mm;flex:none}.q svg{width:100%;height:100%}.w{flex:1}.ln{border-bottom:1.5px solid #999;height:12mm}
    p{color:#555}@media print{p{display:none}}</style></head><body><p>${esc(tr('blankPrintHint'))}</p><div class="g">${ls}</div></body></html>`;
  track('labels_blank', {n});
  deliver('storrrage-labels.html', new Blob([html], {type: 'text/html'}), tr('blankLabels'));
}

/* ---- barcodes on things: fill in name and brand ---- */
async function lookupBarcode(code){
  const tries = [
    async () => { const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands`); const j = await r.json(); const p = j && j.product; return p && p.product_name ? {name: p.product_name, brand: (p.brands || '').split(',')[0].trim()} : null; },
    async () => { const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`); const j = await r.json(); const p = j && j.items && j.items[0]; return p && p.title ? {name: p.title, brand: p.brand || '', model: p.model || ''} : null; }
  ];
  for (const t of tries){ try { const r = await t(); if (r) return r; } catch {} }
  return null;
}
function barcodeSheet(onCode){
  let stream = null, done = false, det = null;
  const stop = () => { done = true; if (stream) stream.getTracks().forEach(t => t.stop()); };
  openSheet(`<h3>${tr('scanBarcode')}</h3><video id="bcCam" playsinline muted></video><p class="hint" id="bcMsg">${tr('pointBarcode')}</p>
    <div class="vtype"><input class="input" id="bcIn" inputmode="numeric" placeholder="7310500000000"><button class="btn primary" id="bcGo">${tr('ok')}</button></div>
    <div class="sheet-foot"><button class="btn" id="bcX">${tr('close')}</button></div>`, stop);
  $('#bcX').onclick = closeSheet;
  const finish = code => { code = String(code || '').replace(/\D/g, ''); if (code.length < 6) return; stop(); closeSheet(); onCode(code); };
  $('#bcGo').onclick = () => finish($('#bcIn').value);
  $('#bcIn').addEventListener('keydown', e => { if (e.key === 'Enter') finish(e.target.value); });
  const video = $('#bcCam');
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices){ video.hidden = true; $('#bcMsg').textContent = tr('noBarcodeCam'); return; }
  try { det = new BarcodeDetector({formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']}); } catch { video.hidden = true; $('#bcMsg').textContent = tr('noBarcodeCam'); return; }
  navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}}).then(s => {
    if (done){ s.getTracks().forEach(t => t.stop()); return; }
    stream = s; video.srcObject = s; video.play();
    const tick = async () => {
      if (done) return;
      try { if (video.readyState >= 2){ const r = await det.detect(video); if (r && r[0] && r[0].rawValue){ finish(r[0].rawValue); return; } } } catch {}
      setTimeout(tick, 180);
    };
    tick();
  }).catch(() => { video.hidden = true; $('#bcMsg').textContent = tr('camBlocked'); });
}
function scanItemBarcode(){
  if (flushItem) flushItem();
  barcodeSheet(async code => {
    toast(tr('lookingUp'));
    const p = navigator.onLine ? await lookupBarcode(code) : null;
    saveItem(x => {
      x.ean = code;
      if (p){ if (!x.name || x.name === tr('unnamed')) x.name = p.name.slice(0, 80); if (p.brand && !x.brand) x.brand = p.brand.slice(0, 60); if (p.model && !x.model) x.model = p.model.slice(0, 60); }
    }, true);
    track('barcode', {found: !!p});
    toast(p ? tr('barcodeFound', p.name.slice(0, 40)) : tr('barcodeSaved'));
    render();
  });
}

/* ---- moving house: runs next to the normal storage, boxes get a room and a state ---- */
let move = {active: false, rooms: []};
const MOVE_STATES = ['created', 'packed', 'moved', 'unpacked'];
const DEFAULT_ROOMS = {sv: ['Kök', 'Vardagsrum', 'Sovrum', 'Barnrum', 'Badrum', 'Hall', 'Förråd'], en: ['Kitchen', 'Living room', 'Bedroom', 'Kids’ room', 'Bathroom', 'Hall', 'Storage'], da: ['Køkken', 'Stue', 'Soveværelse', 'Børneværelse', 'Badeværelse', 'Entré', 'Depot'], nb: ['Kjøkken', 'Stue', 'Soverom', 'Barnerom', 'Bad', 'Gang', 'Bod'], fi: ['Keittiö', 'Olohuone', 'Makuuhuone', 'Lastenhuone', 'Kylpyhuone', 'Eteinen', 'Varasto']};
const moveBoxes = () => realBoxes().filter(b => b.moveState);
function saveMove(){ metaPut('move', move).catch(() => {}); }
let moveFilter = '';
function renderMove(){
  if (!move.active){
    app.innerHTML = `${crumbs([{label: tr('moveTitle').toUpperCase()}])}<div class="moveintro"><div class="mvicon">${ICON.truck}</div><h2>${tr('moveIntroH')}</h2><p class="hint">${tr('moveIntro')}</p>
      <button class="btn primary block" data-act="movestart">${tr('moveStart')}</button></div>`;
    return;
  }
  const all = moveBoxes(), cnt = s => all.filter(b => b.moveState === s).length, done = cnt('unpacked');
  const list = all.filter(b => !moveFilter || (moveFilter === '-' ? !b.moveRoom : b.moveRoom === moveFilter)).sort((x, y) => MOVE_STATES.indexOf(x.moveState) - MOVE_STATES.indexOf(y.moveState) || byCode(x, y));
  const rooms = [...new Set([...(move.rooms || []), ...all.map(b => b.moveRoom).filter(Boolean)])];
  app.innerHTML = `${crumbs([{label: tr('moveTitle').toUpperCase()}])}
    <div class="moveprog"><div class="mpbar"><i style="width:${all.length ? Math.round(done / all.length * 100) : 0}%"></i></div>
      <div class="mpcounts">${MOVE_STATES.map(s => `<span class="mpc ${s}"><b>${cnt(s)}</b> ${tr('mv_' + s)}</span>`).join('')}</div></div>
    <div class="chips quick"><button class="chipbtn${!moveFilter ? ' on' : ''}" data-mvf="">${tr('allRooms')}</button>${rooms.map(r => `<button class="chipbtn${moveFilter === r ? ' on' : ''}" data-mvf="${esc(r)}">${esc(r)} <small>${all.filter(b => b.moveRoom === r).length}</small></button>`).join('')}</div>
    <div class="mvlist">${list.map(b => `<div class="mvrow ${b.moveState}"><button class="mvopen" data-open="${esc(b.id)}"><span class="mvico">${boxArt(boxNum(b))}</span><span class="mvtx"><b>${esc(b.name || b.code)}</b><small>${esc(b.code)} · ${(b.items || []).length} ${tr('items').toLowerCase()}</small></span></button>
      <button class="mvroom" data-mvroom="${esc(b.id)}">${esc(b.moveRoom || tr('pickRoom'))}</button>
      <button class="mvstate ${b.moveState}" data-mvnext="${esc(b.id)}">${tr('mv_' + b.moveState)}</button></div>`).join('') || `<p class="hint center">${tr('moveEmpty')}</p>`}</div>
    <div class="mvactions"><button class="btn primary block" data-act="movenew">${tr('moveNewBox')}</button>
      <button class="btn block" data-act="moveadd">${tr('moveAddExisting')}</button>
      <button class="btn block" data-act="movelabels">${tr('moveLabels')}</button>
      <button class="btn block" data-act="moverooms">${tr('editRooms')}</button>
      <button class="btn danger block" data-act="moveend">${tr('moveEnd')}</button></div>`;
  app.querySelectorAll('[data-mvf]').forEach(c => c.onclick = () => { moveFilter = c.dataset.mvf; render(); });
  app.querySelectorAll('[data-mvnext]').forEach(c => c.onclick = () => { const nb = clone(findBox(c.dataset.mvnext)); nb.moveState = MOVE_STATES[(MOVE_STATES.indexOf(nb.moveState) + 1) % MOVE_STATES.length]; putBox(nb); track('move_state', {s: nb.moveState}); });
  app.querySelectorAll('[data-mvroom]').forEach(c => c.onclick = () => roomPick(c.dataset.mvroom));
}
function roomPick(boxId){
  const b = findBox(boxId); const rooms = move.rooms || [];
  openSheet(`<h3>${tr('pickRoom')} – ${esc(b.code)}</h3><div class="chips">${rooms.map(r => `<button class="chipbtn${b.moveRoom === r ? ' on' : ''}" data-rp="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    <div class="vtype" style="margin-top:10px"><input class="input" id="rpNew" placeholder="${esc(tr('newRoom'))}"><button class="btn" id="rpAdd">${tr('add')}</button></div>
    <div class="sheet-foot"><button class="btn" id="rpX">${tr('close')}</button></div>`);
  const set = r => { const nb = clone(findBox(boxId)); nb.moveRoom = r; putBox(nb); closeSheet(); };
  sheet.querySelectorAll('[data-rp]').forEach(c => c.onclick = () => set(c.dataset.rp));
  $('#rpAdd').onclick = () => { const r = $('#rpNew').value.trim(); if (!r) return; if (!rooms.includes(r)){ move.rooms = [...rooms, r]; saveMove(); } set(r); };
  $('#rpX').onclick = closeSheet;
}
function moveAction(a){
  if (a === 'movestart'){ move = {active: true, rooms: DEFAULT_ROOMS[lang] || DEFAULT_ROOMS.en, startedAt: new Date().toISOString()}; saveMove(); track('move_start'); return render(); }
  if (a === 'movenew') return (async () => {
    const n = await askText(tr('boxNameQ'), {placeholder: tr('boxNamePh'), ok: tr('saveBox')}); if (n === null || n === undefined) return;
    const pid = scopePlace() || places.find(p => !p.inbox)?.id || ensureInbox().id, now = new Date().toISOString();
    const b = {id: newId(), code: nextCode(pid), name: (n || '').trim() || tr('unnamed'), placeId: pid, items: [], moveState: 'created', createdAt: now, updatedAt: now, checkedAt: now};
    putBox(b, true); render(); roomPick(b.id);
  })();
  if (a === 'moveadd') return pickBoxSheet(tr('moveAddExisting'), id => { const nb = clone(findBox(id)); nb.moveState = 'packed'; putBox(nb); }, b => !b.moveState);
  if (a === 'movelabels'){ const l = moveBoxes(); if (!l.length) return toast(tr('moveEmpty')); return labels(l); }
  if (a === 'moverooms') return (async () => { const v = await askText(tr('moveRooms'), {value: (move.rooms || []).join(', '), ok: tr('save')}); if (v === null || v === undefined) return; move.rooms = v.split(',').map(x => x.trim()).filter(Boolean); saveMove(); render(); })();
  if (a === 'moveend') return askConfirm(tr('moveEndQ'), tr('moveEnd')).then(y => { if (!y) return; moveBoxes().forEach(b => { const nb = clone(b); delete nb.moveState; delete nb.moveRoom; putBox(nb, true); }); move = {active: false, rooms: move.rooms}; saveMove(); track('move_end'); toast(tr('moveEnded')); render(); });
}
function moveBanner(){
  if (!move.active || !moveBoxes().length) return '';
  const all = moveBoxes(), done = all.filter(b => b.moveState === 'unpacked').length;
  return `<button class="movebanner" data-act="gomove">${ICON.truck}<span>${tr('moveOngoing', done, all.length)}</span><b>›</b></button>`;
}

Object.assign(STR.en, {editRooms: 'Edit rooms', labelLinked: c => `The label now belongs to ${c}.`, newLabelH: 'New label', newLabelHint: 'This label isn’t used yet. What should it belong to?', newLabelBox: 'Create a new box', newLabelLink: 'Link to an existing box', boxNameQ: 'What’s in the box?',
  printLabel: 'Print label', useOtherLabel: 'Use another label (scan it)', moveLabel: 'Move this label to another box', labelMenuHint: 'Labels can be moved between boxes. Pre-printed blank labels are linked the first time you scan them.',
  blankLabels: 'Blank labels', blankHowMany: 'How many blank labels?', blankPrintHint: 'Print, cut out and stick them on boxes. The first scan links each label to a box.',
  scanBarcode: 'Scan barcode', pointBarcode: 'Point the camera at the barcode.', noBarcodeCam: 'Barcode scanning isn’t available in this browser. Type the number instead.', lookingUp: 'Looking up the product…', barcodeFound: n => `Found: ${n}`, barcodeSaved: 'Barcode saved. No product info found – write the name yourself.',
  moveTitle: 'Moving', moveIntroH: 'Moving house?', moveIntro: 'Create boxes, then follow them from created to packed to moved to unpacked. Your normal storage keeps working as usual.', moveStart: 'Start a move',
  mv_packed: 'Packed', mv_moved: 'Moved', mv_unpacked: 'Unpacked', allRooms: 'All rooms', pickRoom: 'Choose room', newRoom: 'New room', moveEmpty: 'No boxes in the move yet.', moveNewBox: 'New moving box', moveAddExisting: 'Add existing boxes',
  moveLabels: 'Print labels for the move', moveRooms: 'Rooms (separate with commas)', moveEnd: 'Finish the move', moveEndQ: 'Finish the move? The boxes stay where they are, without room and moving status.', moveEnded: 'Move finished. Welcome home!', moveOngoing: (d, n) => `Moving: ${d} of ${n} boxes unpacked`});
Object.assign(STR.sv, {editRooms: 'Ändra rum', labelLinked: c => `Etiketten hör nu till ${c}.`, newLabelH: 'Ny etikett', newLabelHint: 'Den här etiketten används inte än. Vad ska den höra till?', newLabelBox: 'Skapa en ny låda', newLabelLink: 'Koppla till en befintlig låda', boxNameQ: 'Vad finns i lådan?',
  printLabel: 'Skriv ut etikett', useOtherLabel: 'Använd en annan etikett (skanna den)', moveLabel: 'Flytta etiketten till en annan låda', labelMenuHint: 'Etiketter kan flyttas mellan lådor. Förtryckta tomma etiketter kopplas första gången du skannar dem.',
  blankLabels: 'Tomma etiketter', blankHowMany: 'Hur många tomma etiketter?', blankPrintHint: 'Skriv ut, klipp och sätt på lådorna. Första skanningen kopplar etiketten till en låda.',
  scanBarcode: 'Skanna streckkod', pointBarcode: 'Rikta kameran mot streckkoden.', noBarcodeCam: 'Streckkodsläsning finns inte i den här webbläsaren. Skriv in numret i stället.', lookingUp: 'Söker produkten…', barcodeFound: n => `Hittade: ${n}`, barcodeSaved: 'Streckkoden sparad. Ingen produktinfo hittades – skriv namnet själv.',
  moveTitle: 'Flytt', moveIntroH: 'Ska du flytta?', moveIntro: 'Skapa lådor och följ dem från skapad till packad, flyttad och uppackad. Ditt vanliga förråd fungerar som vanligt under tiden.', moveStart: 'Starta en flytt',
  mv_packed: 'Packad', mv_moved: 'Flyttad', mv_unpacked: 'Uppackad', allRooms: 'Alla rum', pickRoom: 'Välj rum', newRoom: 'Nytt rum', moveEmpty: 'Inga lådor i flytten än.', moveNewBox: 'Ny flyttlåda', moveAddExisting: 'Lägg till befintliga lådor',
  moveLabels: 'Skriv ut etiketter för flytten', moveRooms: 'Rum (separera med komma)', moveEnd: 'Avsluta flytten', moveEndQ: 'Avsluta flytten? Lådorna stannar där de är, utan rum och flyttstatus.', moveEnded: 'Flytten är klar. Välkommen hem!', moveOngoing: (d, n) => `Flytt: ${d} av ${n} lådor uppackade`});

/* ---- warranties, total value and lending ---- */
const daysTo = d => Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
const warrantySoon = () => boxes.flatMap(b => (b.items || []).filter(it => it.warranty && daysTo(it.warranty) >= -7 && daysTo(it.warranty) <= 30).map(it => [it, b]));
const valueOf = filter => boxes.filter(filter).reduce((s, b) => s + (b.items || []).reduce((t, i) => t + (+i.value || 0) * Math.max(1, +i.qty || 1), 0), 0);
const valueLine = filter => { const v = valueOf(filter); return v ? ` · ${tr('worth', kr(v))}` : ''; };
const loans = () => boxes.flatMap(b => (b.items || []).filter(it => it.status === 'On loan').map(it => [it, b]));
const loanDays = it => { const s = it.loanSince || (it.updatedAt || '').slice(0, 10); return s ? -daysTo(s) : 0; };
const loanOld = () => loans().filter(([it]) => loanIsDue(it));
const attention = () => warrantySoon().length + loanOld().length;
function renderLoans(){
  const all = loans(), groups = new Map();
  all.forEach(e => { const k = (e[0].loanTo || '').trim() || tr('unknownPerson'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
  app.innerHTML = `${crumbs([{label: tr('loansTitle').toUpperCase()}])}<p class="hint" style="margin-top:10px">${tr('loansHint')}</p>
    ${all.length ? [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'sv')).map(([who, list]) => `<section class="loangrp"><h3>👤 ${esc(who)} <small>${list.length}</small></h3>
      ${list.map(([it, b]) => { const d = loanDays(it); return `<div class="loanrow${d > 30 ? ' old' : ''}"><button class="mvopen" data-item="${esc(it.id)}" data-box="${esc(b.id)}" data-open-item="1"><span class="mvtx"><b>${esc(it.name)}</b><small>${esc(tr('lentSince', d))} · ${esc(b.loose ? placeName(b.placeId) : b.code + ' ' + b.name)}</small></span></button>
        <button class="btn small" data-loanask="${esc(b.id)}:${esc(it.id)}">${tr('remindLoan')}</button><button class="btn primary small" data-loanback="${esc(b.id)}:${esc(it.id)}">${tr('gotBack')}</button></div>`; }).join('')}</section>`).join('')
      : `<p class="hint center">${tr('loansEmpty')}</p>`}`;
  app.querySelectorAll('[data-loanback]').forEach(c => c.onclick = () => { const [bid, iid] = c.dataset.loanback.split(':'); const nb = clone(findBox(bid)), x = nb.items.find(i => i.id === iid); if (!x) return; delete x.status; delete x.loanTo; delete x.loanSince; x.updatedAt = new Date().toISOString(); putBox(nb); track('loan_back'); toast(tr('putBackDone', x.name, nb.loose ? placeName(nb.placeId) : nb.code)); });
  app.querySelectorAll('[data-loanask]').forEach(c => c.onclick = () => { const [bid, iid] = c.dataset.loanask.split(':'); const x = (findBox(bid).items || []).find(i => i.id === iid); if (!x) return; const txt = tr('loanMsg', (x.loanTo || '').trim(), x.name, me); track('loan_remind'); if (navigator.share) navigator.share({text: txt}).catch(() => {}); else navigator.clipboard.writeText(txt).then(() => toast(tr('copied'))).catch(() => {}); });
  app.querySelectorAll('[data-open-item]').forEach(c => c.onclick = () => navigate({name: 'item', boxId: c.dataset.box, itemId: c.dataset.item}));
}
Object.assign(STR.en, {f_warranty: 'Warranty until', warrantyLeft: n => n < 0 ? `Warranty ended ${-n} days ago` : n === 0 ? 'Warranty ends today' : `Warranty ends in ${n} days`, warrantyH: 'Warranty ending soon', worth: v => `worth ${v}`,
  loansTitle: 'Lent out', loansHint: 'Things you’ve lent, by person. Set a thing’s status to “On loan” and write who has it.', loansEmpty: 'Nothing is lent out. 🎉', unknownPerson: 'Someone', lentSince: d => d <= 0 ? 'lent today' : d === 1 ? 'lent 1 day ago' : `lent ${d} days ago`,
  gotBack: 'Got it back', remindLoan: 'Remind', loanMsg: (who, item, me) => `Hi${who ? ' ' + who : ''}! Do you still have my ${item}? I’d like it back when you’re done 🙂${me ? ' /' + me : ''}`, loansOld: 'Lent out for over a month'});
Object.assign(STR.sv, {f_warranty: 'Garanti till', warrantyLeft: n => n < 0 ? `Garantin gick ut för ${-n} dagar sedan` : n === 0 ? 'Garantin går ut i dag' : `Garantin går ut om ${n} dagar`, warrantyH: 'Garanti går ut snart', worth: v => `värt ${v}`,
  loansTitle: 'Utlånat', loansHint: 'Saker du lånat ut, per person. Sätt status ”Utlånad” på en sak och skriv vem som har den.', loansEmpty: 'Inget är utlånat. 🎉', unknownPerson: 'Någon', lentSince: d => d <= 0 ? 'utlånad i dag' : d === 1 ? 'utlånad för 1 dag sedan' : `utlånad för ${d} dagar sedan`,
  gotBack: 'Fått tillbaka', remindLoan: 'Påminn', loanMsg: (who, item, me) => `Hej${who ? ' ' + who : ''}! Har du kvar min ${item}? Vill gärna ha tillbaka den när du är klar 🙂${me ? ' /' + me : ''}`, loansOld: 'Utlånat i över en månad'});

/* ---- notifications on the phone: reminders, warranty, loans, things that should be back ---- */
let notifOn = false, notified = {};
function alertsNow(){
  const out = [], t = today();
  boxes.forEach(b => (b.items || []).forEach(it => {
    const where = b.loose ? placeName(b.placeId) : `${b.code} ${b.name}`;
    if (isDue(it)) out.push({key: `due:${it.id}:${notifyAt(it)}`, title: tr('n_dueT'), body: tr('n_due', it.name), box: b.id, item: it.id});
    if (it.warranty){ const d = daysTo(it.warranty); if (d <= 30 && d >= -1) out.push({key: `w:${it.id}:${it.warranty}:${d <= 7 ? 7 : 30}`, title: tr('warrantyH'), body: `${it.name}: ${tr('warrantyLeft', d)}`, box: b.id, item: it.id}); }
    if (it.status === 'On loan' && loanIsDue(it)) out.push({key: `loan:${it.id}:${it.loanDue || ''}`, title: tr('loansTitle'), body: tr('n_loan', it.name, (it.loanTo || '').trim() || tr('unknownPerson')), box: b.id, item: it.id});
    if (isOut(it) && outOverdue(it)) out.push({key: `out:${it.id}:${it.out.until}`, title: tr('backQ'), body: tr('n_out', it.name, where), box: b.id, item: it.id});
  }));
  return out;
}
/* Rules (see NOTISER.md): nothing changed in the last 24 h triggers anything, at most one notification
   per check (several = one summary), at least 6 h between notifications, and none between 21 and 08. */
const NOTIF_GAP_H = 6, QUIET_FROM = 21, QUIET_TO = 8, GRACE_H = 24;
const quietNow = () => { const h = new Date().getHours(); return h >= QUIET_FROM || h < QUIET_TO; };
const recentlyChanged = it => it.updatedAt && (Date.now() - Date.parse(it.updatedAt)) < GRACE_H * 3600e3;
async function notifyAlerts(){
  if (!notifOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (quietNow()) return;
  const last = +(notified._last || 0);
  if (Date.now() - last < NOTIF_GAP_H * 3600e3) return;
  const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
  const byKey = new Map(boxes.flatMap(b => (b.items || []).map(it => [it.id, it])));
  const fresh = alertsNow().filter(a => !notified[a.key] && !recentlyChanged(byKey.get(a.item) || {}));
  if (fresh.length){
    const a = fresh[0], many = fresh.length > 1;
    const title = many ? 'Storrrage' : a.title, body = many ? tr('n_many', fresh.length, a.body) : a.body;
    const opts = {body, tag: 'storrrage', renotify: true, icon: 'icon-192.png', badge: 'icon-192.png', data: many ? {} : {box: a.box, item: a.item}};
    try { if (reg && reg.showNotification) await reg.showNotification(title, opts); else new Notification(title, opts); } catch {}
    fresh.forEach(x => { notified[x.key] = today(); });
    notified._last = Date.now();
  }
  if (fresh.length){ const keep = {_last: notified._last}; Object.entries(notified).forEach(([k, d]) => { if (k !== '_last' && daysSince(d) < 120) keep[k] = d; }); notified = keep; metaPutRaw('notified', notified).catch(() => {}); track('notified', {n: fresh.length}); }
}
async function turnOnNotifications(){
  if (!('Notification' in window)){ toast(tr('notifUnsupported')); return false; }
  let p = Notification.permission;
  if (p !== 'granted') p = await Notification.requestPermission().catch(() => 'denied');
  if (p !== 'granted'){ toast(tr('notifBlocked')); return false; }
  notifOn = true; metaPutRaw('notifOn', true).catch(() => {});
  try { const reg = await navigator.serviceWorker.ready; if (reg.periodicSync) await reg.periodicSync.register('storrrage-check', {minInterval: 12 * 3600 * 1000}); } catch {}
  track('notif_on');
  notifyAlerts();
  return true;
}
let reminderNudgesShown = 0;
async function reminderPermissionNudge(){
  if (notifOn && 'Notification' in window && Notification.permission === 'granted') return;
  let stored;
  try { stored = await metaGet('reminderNudgeCount'); }
  catch (err){ toast(saveErr(err)); return; }
  const count = Math.max(reminderNudgesShown, +stored || 0);
  if (count >= 2) return;
  reminderNudgesShown = count + 1;
  try { await metaPutRaw('reminderNudgeCount', reminderNudgesShown); }
  catch (err){ toast(saveErr(err)); }
  openSheet(`<h3>${tr('reminderNudgeTitle')}</h3><p class="hint">${tr('reminderNudgeText')}</p>
    <div class="sheet-foot"><button class="btn quiet" id="rnLater">${tr('close')}</button><button class="btn primary" id="rnEnable">${tr('reminderNudgeAction')}</button></div>`);
  $('#rnLater').onclick = closeSheet;
  $('#rnEnable').onclick = () => { closeSheet(); turnOnNotifications(); };
}
/* something changed by someone else in the household while the app was in the background */
let hhChanges = {};
function noteHouseholdChange(updatedBy, box){
  if (!updatedBy || updatedBy === myId() || !box || box.loose) return;
  const who = memberNames[updatedBy] || tr('someone');
  (hhChanges[who] = hhChanges[who] || new Set()).add(box.name || box.code);
}
async function flushHouseholdChanges(){
  const entries = Object.entries(hhChanges); hhChanges = {};
  if (!entries.length || !notifOn || document.visibilityState === 'visible' || Notification.permission !== 'granted' || quietNow()) return;
  if (Date.now() - (+(notified._hh || 0)) < 2 * 3600e3) return;
  const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
  const who = entries.map(e => e[0]).join(', '), list = [...new Set(entries.flatMap(e => [...e[1]]))];
  try { if (reg) await reg.showNotification('Storrrage', {body: tr('n_hh', who, list.slice(0, 3).join(', ') + (list.length > 3 ? ' …' : '')), tag: 'storrrage-hh', icon: 'icon-192.png'}); } catch {}
  notified._hh = Date.now(); metaPutRaw('notified', notified).catch(() => {});
}
navigator.serviceWorker?.addEventListener?.('message', e => { const d = e.data || {}; if (d.open && d.box) navigate(d.item ? {name: 'item', boxId: d.box, itemId: d.item} : {name: 'box', boxId: d.box}); });

/* ---- loans: since when, and when to ask for it back ---- */
const addDays = (d, n) => { const x = new Date((d || today()) + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const loanIsDue = it => it.loanDue ? it.loanDue <= today() : loanDays(it) > 30;
function loanFields(it){
  const since = it.loanSince || today(), due = it.loanDue || '';
  const opts = [[7, tr('w1')], [14, tr('w2')], [30, tr('m1')], [90, tr('m3')]];
  const cur = due ? Math.round((new Date(due) - new Date(since)) / 864e5) : null;
  return `<div class="fl"><input data-f="loanSince" type="date" value="${esc(since)}"><label class="always">${tr('loanSinceL')}</label></div>
    <div class="fl group"><label class="always">${tr('remindBack')}</label><div class="chips tight">${opts.map(([n, l]) => `<button class="chipbtn small${cur === n ? ' on' : ''}" data-loandue="${n}">${l}</button>`).join('')}<button class="chipbtn small${due && !opts.some(o => o[0] === cur) ? ' on' : ''}" data-loandue="pick">${tr('pickDate')}</button></div>
    ${due && !opts.some(o => o[0] === cur) || showLoanPick ? `<input data-f="loanDue" type="date" value="${esc(due)}" style="margin-top:8px">` : ''}${due ? `<p class="wnote">${esc(tr('remindOn', due))}</p>` : ''}</div>`;
}
let showLoanPick = false, showRemindPick = false;
function remindFields(it){
  const m = +(it.remindMonths || 0), at = it.remindAt || '';
  const opts = [[3, tr('remindM', 3)], [6, tr('remindM', 6)], [12, tr('remindM', 12)], [24, tr('remindM', 24)]];
  return `<div class="fl group"><label class="always">${tr('remind')}</label><div class="chips tight"><button class="chipbtn small${!m && !at ? ' on' : ''}" data-remind="0">${tr('noRemind')}</button>${opts.map(([v, l]) => `<button class="chipbtn small${m === v && !at ? ' on' : ''}" data-remind="${v}">${l}</button>`).join('')}<button class="chipbtn small${at ? ' on' : ''}" data-remind="pick">${tr('pickDate')}</button></div>
    ${at || showRemindPick ? `<input data-f="remindAt" type="date" value="${esc(at)}" style="margin-top:8px">` : ''}</div>`;
}
document.addEventListener('click', e => {
  const r = e.target.closest('[data-remind]'), l = e.target.closest('[data-loandue]');
  if (!r && !l) return;
  if (flushItem) flushItem();
  if (r){ const v = r.dataset.remind; if (v === 'pick'){ showRemindPick = true; saveItem(x => { delete x.remindMonths; }, true); return; } showRemindPick = false; saveItem(x => { delete x.remindAt; if (+v) x.remindMonths = +v; else delete x.remindMonths; }, true); if (+v) reminderPermissionNudge(); return; }
  const v = l.dataset.loandue;
  if (v === 'pick'){ showLoanPick = true; render(); return; }
  showLoanPick = false; saveItem(x => { x.loanDue = addDays(x.loanSince || today(), +v); }, true);
});

Object.assign(STR.en, {n_many: (n, first) => `${n} things need a look. First: ${first}`, notifTitle: 'Notifications', notifSetting: 'Notify me on this phone', notifHint: 'Reminders, warranties that end, things that should be back, and changes others in your household make.', notifBlocked: 'Notifications are blocked. Allow them for Storrrage in the phone’s settings.', notifUnsupported: 'This browser can’t show notifications.', notifOnToast: 'Notifications are on.',
  n_dueT: 'Time to check', n_due: n => `${n} hasn’t been used in a while. Keep it, or sell it?`, n_loan: (n, w) => `${w} still has your ${n}. Time to ask for it back?`, n_out: (n, w) => `Is ${n} back in ${w}?`, n_hh: (w, list) => `${w} made changes: ${list}`,
  loanSinceL: 'Lent since', remindBack: 'Remind me to ask for it back in', w1: '1 week', w2: '2 weeks', m1: '1 month', m3: '3 months', pickDate: 'Pick a date', remindOn: d => `Reminder on ${d}`, addInto: c => `Add to box ${c}`, boxInsideX: c => `Box inside ${c}`,
  uploadImageOnly: 'Choose a valid JPEG, PNG, WebP or GIF image.', uploadPdfOnly: 'Choose a valid PDF document.', uploadTooLarge: 'That file is too large. The limit is 25 MB per file.', uploadUnsafeType: 'This file type or content is not supported.', backupInvalid: 'That file isn’t a valid Storrrage backup.',
  takePhoto: 'Take a photo', pickPhoto: 'Choose from photos', photoUploadCancelled: 'The item was closed before the upload finished, so the file was not attached.', reminderNudgeTitle: 'Turn on reminders?', reminderNudgeText: 'This reminder is saved, but Storrrage cannot notify you until notifications are allowed on this phone.', reminderNudgeAction: 'Enable notifications',
  mv_created: 'Created — not packed'});
Object.assign(STR.sv, {n_many: (n, first) => `${n} saker behöver kollas. Först: ${first}`, notifTitle: 'Notiser', notifSetting: 'Skicka notiser till den här telefonen', notifHint: 'Påminnelser, garantier som går ut, saker som borde vara tillbaka och ändringar som andra i hushållet gör.', notifBlocked: 'Notiser är blockerade. Tillåt dem för Storrrage i telefonens inställningar.', notifUnsupported: 'Den här webbläsaren kan inte visa notiser.', notifOnToast: 'Notiser är på.',
  n_dueT: 'Dags att kolla', n_due: n => `${n} har inte använts på länge. Behålla eller sälja?`, n_loan: (n, w) => `${w} har fortfarande din ${n}. Dags att be om den tillbaka?`, n_out: (n, w) => `Är ${n} tillbaka i ${w}?`, n_hh: (w, list) => `${w} har gjort ändringar: ${list}`,
  loanSinceL: 'Utlånad sedan', remindBack: 'Påminn mig att be om den tillbaka om', w1: '1 vecka', w2: '2 veckor', m1: '1 månad', m3: '3 månader', pickDate: 'Välj datum', remindOn: d => `Påminnelse ${d}`, addInto: c => `Lägg till i lådan ${c}`, boxInsideX: c => `Låda inuti ${c}`,
  uploadImageOnly: 'Välj en giltig JPEG-, PNG-, WebP- eller GIF-bild.', uploadPdfOnly: 'Välj ett giltigt PDF-dokument.', uploadTooLarge: 'Filen är för stor. Gränsen är 25 MB per fil.', uploadUnsafeType: 'Filtypen eller innehållet stöds inte.', backupInvalid: 'Filen är inte en giltig Storrrage-säkerhetskopia.',
  takePhoto: 'Ta ett foto', pickPhoto: 'Välj bland foton', photoUploadCancelled: 'Saken stängdes innan uppladdningen blev klar, så filen bifogades inte.', reminderNudgeTitle: 'Aktivera påminnelser?', reminderNudgeText: 'Påminnelsen sparas, men Storrrage kan inte meddela dig förrän notiser är tillåtna på telefonen.', reminderNudgeAction: 'Aktivera notiser',
  mv_created: 'Skapad — inte packad'});

STR.da = {
  space: 'RUM', places_n: n => n === 1 ? '1 STED' : `${n} STEDER`, boxes_n: n => n === 1 ? '1 KASSE' : `${n} KASSER`, items_n: n => n === 1 ? '1 TING' : `${n} TING`, box_n: n => `KASSE ${n}`,
  allPlaces: 'Alle steder', addPlace: '+ Sted', notInBox: 'Ikke i en kasse', notInBoxShort: 'ikke i en kasse',
  emptyPlace: 'Tryk på + for at tilføje en kasse eller noget, der ikke ligger i en kasse, fx en cykel.',
  addItem: 'Tilføj ting', addSeveral: 'Tilføj flere', addThingChoice: 'Tilføj ting', addMultipleChoice: 'Tilføj flere', addBoxChoice: 'Tilføj kasse', item: 'ting', items: 'ting', editBox: 'Rediger kasse', label: 'Etiket',
  findStuff: 'FIND DINE TING!', typeKeyword: 'Skriv et søgeord', searchIn: 'Søg i', everywhere: 'Overalt', allOf: p => `Hele ${p}`,
  boxesH: 'Kasser', similar: 'Lignende ting', noMatch: q => `Intet matcher “${q}”. Prøv et andet ord.`, nothingHere: 'Der er intet her endnu.',
  welcome: 'Hold styr på, hvad der står hvor: kasser, ting, fotos og kvitteringer. Find alt ved at søge eller bare spørge.',
  yourName: 'Dit navn', getStarted: 'Kom i gang', noAccount: 'Ingen konto nødvendig. Alt bliver på telefonen.', writeName: 'Skriv dit navn først.',
  storrrage: 'STORRRAGE', profile: 'Profil', settings: 'Indstillinger', notifications: 'Notifikationer', premium: 'Premium',
  version: v => `Storrrage version ${v}`, household: 'Husstand', addName: 'Tilføj et navn', add: 'Tilføj', you: '(dig)', remove: 'Fjern',
  householdHint: 'Bruges til “hvis er det” på ting, og når du taler med Storrrage (“Elsas støvler”).', noOne: 'Ingen tilføjet endnu.',
  aiAssistant: 'AI-assistent', off: 'Fra', storagePlaces: 'Opbevaringssteder', backupNow: 'Tag backup nu', never: 'Aldrig',
  restore: 'Gendan fra backup', insurance: 'Forsikringsrapport', labelsAll: 'Etiketter til alle kasser', scanLabel: 'Scan en etiket', language: 'Sprog',
  usage: mb => `Alt gemmes kun på denne telefon. Storrrage bruger ca. ${mb} MB.`,
  dueIntro: 'Dem her har du ikke brugt i et stykke tid. Værd at beholde, eller tid til at sælge?', lastUsedOn: d => `Sidst brugt ${d}`,
  usedRecently: 'Brugt for nylig', markSale: 'Sæt til salg', nothingDue: 'Intet kræver din opmærksomhed. Sæt “Påmind mig hvis ubrugt” på en ting for at få et puf.',
  prem1: 'Del opbevaring med husstanden', prem2: 'Sælg på DBA, Tradera og Vinted', prem3: 'Login og synk mellem telefoner', premLater: 'Kommer senere. Alt du bruger nu er gratis.',
  whatIsIt: 'Hvad er det?', whereIs: 'Hvor den er', addDetail: 'Tilføj detaljer', lastUsed: 'Sidst brugt', remind: 'Påmind mig hvis ubrugt', noRemind: 'Ingen påmindelse',
  remindM: m => m === 12 ? 'Efter 1 år' : m === 24 ? 'Efter 2 år' : `Efter ${m} måneder`, notify: d => `påmind ${d}`,
  attachments: 'Bilag', addAttach: '+ Tilføj kvittering, garanti eller manual', tags: 'Tags',
  registered: (d, by) => `Registreret ${d}${by ? ` af ${by}` : ''}.`, storedSince: d => `Opbevaret siden ${d}.`, changed: d => `Sidst ændret ${d}.`,
  delItem: 'Slet ting', done: 'Færdig', save: 'Gem', saveAnother: 'Gem + tilføj en til', saved: 'Gemt.', savedNext: n => `${n} gemt. Tilføj den næste.`, nameFirst: 'Giv den et navn først.',
  f_size: 'Størrelse', f_brand: 'Mærke', f_value: 'Pris / værdi (kr)', f_model: 'Model', f_qty: 'Antal', f_owner: 'Ejer & status', f_color: 'Farve', f_season: 'Sæson',
  f_serial: 'Serienummer', f_category: 'Kategori', f_spot: 'Præcis hvor', f_notes: 'Noter', whose: 'Hvis er den', status: 'Status', loanTo: 'Lånt ud til', shared: 'Fælles',
  st_store: 'Opbevares', st_loan: 'Udlånt', st_sale: 'Til salg', st_sold: 'Solgt', st_given: 'Givet væk',
  addTo: p => `Tilføj til ${p}`, boxStorage: 'Kasse / opbevaring', itemNoBox: 'Ting uden kasse', severalPhotos: 'Flere ting fra fotos',
  cancel: 'Annuller', close: 'Luk', ok: 'OK', moveX: n => `Flyt ${n}`, to: 'Til', move: 'Flyt', movedTo: w => `Flyttet til ${w}.`, rename: 'Omdøb', del: 'Slet', edit: 'Rediger',
  moveToPlace: 'Flyt til sted', emptyFirst: 'Tøm stedet for at slette det.', delQ: n => `Slet “${n}”? Det kan ikke fortrydes.`, delNoteQ: 'Slet denne stemmenote?',
  rmPhotoQ: 'Fjern dette foto?', rmQ: n => `Fjern “${n}”?`, rmTagQ: n => `Fjern tagget “${n}”?`, newPlace: 'Nyt opbevaringssted', newPlaceHint: 'Fx Kælderen, Loftet eller Garagen',
  renameX: n => `Omdøb ${n}`, newTag: 'Ny', tagHint: 'Fx vandring eller vinter', voiceNotes: 'Stemmenoter', voiceNotesBox: 'Stemmenoter til denne kasse',
  menu: 'Menu', allSettings: 'Alle indstillinger', usedNoted: 'Noteret. Påmindelsen starter forfra.', markedSale: 'Sat til salg.',
  placesHint: 'Fx kælderrummet, loftet, garagen eller sommerhuset. Kun et navn gemmes, aldrig en adresse.', placeNameHint: 'Navn, fx Loftet',
  fileMissing: 'Filen mangler.', savingPhoto: 'Gemmer foto…', unnamed: 'Uden navn', batchTitle: 'Tilføj flere ting', batchWhere: w => `De kommer i ${w}.`,
  modeEach: 'Et foto pr. ting', modeEachHint: 'Tag eller vælg et foto af hver ting.', modeMulti: 'Flere ting på ét foto', modeMultiHint: 'Læg tingene frem og tag ét foto. Hver ting bliver sin egen.',
  batchAI: 'AI foreslår navne og detaljer ud fra fotoene. Du tjekker dem, før de tilføjes.', batchNoAI: 'Slå AI-assistenten til for at få forslag automatisk. Uden den navngiver du selv hver ting.',
  batchPrivacy: 'Fotos sendes til AI-tjenesten for at blive genkendt.', thinking: 'Genkender…', aiFailed: e => `Kunne ikke genkende: ${e}`,
  addN: n => n === 1 ? 'Tilføj 1 ting' : `Tilføj ${n} ting`, batchAdded: n => n === 1 ? 'Tilføjede 1 ting.' : `Tilføjede ${n} ting.`, namePh: 'Navn', include: 'Medtag',
  morePhotos: '+ Flere fotos', noneYet: 'Ingen fotos endnu.', batchFound: n => n === 1 ? 'Fandt 1 ting.' : `Fandt ${n} ting.`, aiSuggest: 'Foreslå ud fra foto', testTag: 'TEST',
  aiLooking: 'Kigger på fotoet…', aiNothing: 'AI’en genkendte intet på fotoet.', aiSuggestH: 'Forslag fra fotoet', aiSuggestHint: 'Sæt hak ved det, du vil bruge. Afkrydsede detaljer erstatter det nuværende.',
  aiNow: v => `nu: ${v}`, apply: 'Brug valgte', aiApplied: n => n === 1 ? 'Opdaterede 1 detalje.' : `Opdaterede ${n} detaljer.`, aiNeedPhoto: 'Tilføj et foto først.',
  rmPhoto: 'Fjern foto', addPhoto: 'Tilføj foto', editBoxH: 'Rediger kasse', newBox: 'Ny kasse', name: 'Navn', boxNamePh: 'Vintertøj', storagePlace: 'Opbevaringssted',
  whereInPlace: 'Hvor på stedet', wherePh: 'Bagvæggen, øverste hylde', boxPhoto: 'Foto af kassen', delBox: 'Slet kasse', saveBox: 'Gem kasse', addBox: 'Tilføj kasse',
  waitPhoto: 'Vent til fotoet er gemt.', nameBox: 'Giv kassen et navn.', whoPhone: 'Hvem bruger denne telefon?', whoPhoneHint: 'Så “min” og “mine” betyder denne person, når du taler med Storrrage. Det viser også, hvem der registrerede hver ting.',
  notSet: 'Ikke valgt', scanH: 'Scan en etiket', pointCam: 'Ret kameraet mod QR-koden på kassen.', typeCode: 'Eller skriv kassens kode', openBox: 'Åbn kasse',
  noCam: 'Kameraet er ikke tilgængeligt her. Skriv koden fra etiketten i stedet.', camBlocked: 'Kameraet blev blokeret. Skriv koden fra etiketten, eller tillad kameraet for appen i browserens indstillinger.',
  offline: 'Offline. Alt du gør gemmes på telefonen.', shareTo: 'Del til Drive, e-mail eller en anden app', saveToPhone: 'Gem på telefonen (Overførsler)', savedDl: 'Gemt i mappen Overførsler.',
  shareFail: 'Deling virkede ikke. Brug Gem på telefonen i stedet.', labelsAllH: 'Etiketter til alle kasser', talkH: 'Tal eller skriv med Storrrage', send: 'Send',
  pause: 'Handl på det jeg sagde efter en pause på', whatSay: 'Hvad kan jeg sige? (også uden dækning)', noSignal: 'Uden dækning:',
  noSR: 'Talegenkendelse findes ikke i denne browser. Brug mikrofonen på tastaturet i stedet.', readAloud: 'Læs svar højt',
  aiIntro: 'Med AI slået til kan du tale frit. Storrrage forstår opfølgninger og spørger om detaljer, der betyder noget. Uden dækning bruges de enkle kommandoer.',
  provider: 'Udbyder', gemFree: 'Google Gemini (gratis, til test)', claudePaid: 'Claude (betalt)', simpleOnly: 'Kun enkle kommandoer. Intet sendes nogen steder.', testOnly: 'Brug kun opdigtede testting.',
  freeTier: 'På Googles gratis niveau kan det, du sender, bruges til at forbedre Googles produkter og læses af mennesker. Send ikke din rigtige opbevaring, før du skifter til en betalt løsning.',
  apiKey: 'API-nøgle', checkKey: 'Tjek nøglen', checkToChoose: 'Tjek nøglen for at vælge',
  aiSends: 'Når du taler, sender Storrrage det du sagde, den seneste del af samtalen og navne og detaljer på dine steder, kasser og ting. Stemmenoter sendes aldrig.',
  pasteKey: 'Indsæt nøglen først.', checking: 'Tjekker…', works: 'Virker.', pasteToTurnOn: 'Indsæt API-nøglen for at slå AI til.', aiIsOff: 'AI er slået fra.', cantSave: 'Kunne ikke gemme indstillingen.',
  getGem: 'Få en gratis nøgle: åbn aistudio.google.com, log ind og vælg “Get API key”.', getClaude: 'Få en nøgle: åbn console.anthropic.com, indbetal et lille beløb under Billing og opret en nøgle under API keys.',
  keyLocal: 'Nøglen gemmes kun på denne telefon og er ikke med i backups.', inside: 'Indeni', topLevel: p => `${p}, direkte`, nameOptional: 'Lad stå tom for at navngive efter indholdet',
  boxInBox: 'Kasse i denne kasse', boxesInside: 'Kasser indeni', addHereBox: b => `Tilføj til ${b}`, notes: 'Noter', recent: 'Senest set', favorites: 'Favoritter', fav: 'Favorit', unfav: 'Fjern favorit',
  viewLarge: 'Store felter', viewSmall: 'Små felter', viewList: 'Liste', select: 'Vælg', selected: n => `${n} valgt`, moveSel: 'Flyt til…', delSel: 'Slet',
  delSelQ: n => n === 1 ? 'Slet 1 ting? Det kan ikke fortrydes.' : `Slet ${n} ting? Det kan ikke fortrydes.`, movedN: (n, w) => `Flyttede ${n} til ${w}.`, deletedN: n => `Slettede ${n}.`,
  didYouMean: 'Mente du', share: 'Del hvor den er', copied: 'Kopieret.', shareCopy: 'Del en kopi af dette sted', icon: 'Billede', numbering: 'Kassenumre',
  numPlace: 'Separat for hvert sted (B-001 på hvert sted)', numAccount: 'Én serie for alle steder', export: 'Eksportér en liste', exportH: 'Eksportér en liste over dine ting',
  exportHint: 'Pænt i rækker: sted, kasse, ting og detaljer.', excel: 'Excel (.xlsx)', word: 'Word (.doc)', pdf: 'PDF', scope: 'Hvad skal med', exportAll: 'Alt',
  loadingLib: 'Forbereder filen…', needNet: 'Det kræver dækning første gang.', backupHint: d => d ? `Seneste backup ${d}.` : 'Ingen backup endnu.', backupDo: 'Tag backup',
  addNav: 'Tilføj', whichPlace: 'Tilføj til hvilket sted?', nameNeeded: 'Alle ting skal have et navn.', discarded: 'Kasseret: tingen havde intet navn.',
  col_place: 'Sted', col_box: 'Kasse', col_inbox: 'Indeni', col_item: 'Ting', col_cat: 'Kategori', col_brand: 'Mærke', col_model: 'Model', col_size: 'Størrelse', col_color: 'Farve',
  col_owner: 'Ejer', col_status: 'Status', col_qty: 'Antal', col_value: 'Værdi (kr)', col_stored: 'Opbevaret siden', col_used: 'Sidst brugt', col_tags: 'Tags', col_notes: 'Noter', col_serial: 'Serienr.',
  listTitle: 'Opbevaringsliste', total: 'Total', showAll: 'Vis alle', dragLooseHint: 'Hold på en rund markør og træk den ind i en zone.', addZone: 'Tilføj zone', zoneExists: 'Der findes allerede en zone med det navn.',
  doorSide: 'Dør og bagende', doorHint: 'Vælg hvilken side døren er på, og hvor bagenden er.', door_top: 'Top', door_bottom: 'Bund', door_left: 'Venstre', door_right: 'Højre',
  dragHint: 'Hold på en kasse eller rund markør og træk den til en stabel eller zone.', back: 'Tilbage', switchSpace: 'Vælg sted', shelf: 'Gitter', map: 'Kort', door: 'Dør', farIn: 'Bagest',
  noZone: 'Ingen zone', placement: 'Placering', placementHint: 'Hvor kassen står: zonen (fx “Ved døren”, “Hylde 2”) og hvilken stabel.', zone: 'Zone', zoneHint: 'Fx Ved døren, Hylde 2, Bagest',
  stack: 'Stabel', newStack: 'En ny stabel', level: 'Niveau', onTop: 'Øverst', atBottom: 'Nederst', stackOf: (n, codes) => codes ? `Stabel ${n}: på ${codes}` : `Stabel ${n}`,
  closerDoor: 'Flyt op', furtherIn: 'Flyt ned', collections: 'Tags', collection: 'Tag', inBoxes: n => n === 1 ? 'på 1 sted' : `på ${n} steder`, showOnMap: 'Vis på kort',
  insideBox: 'indeni', toCollection: 'Tag', collHint: 'Ting med samme tag vises samlet, også når de ligger i forskellige kasser.', collPh: 'Fx Jul eller Vinter',
  addedToColl: (n, t) => `Føjede ${n} til #${t}.`, isHere: 'er her', openItem: 'Åbn ting', foundIn: 'Fundet i', list: 'Liste', takeOut: 'Tag frem', putBack: 'Læg tilbage', outTag: 'Fremme',
  outSince: d => `fremme siden ${d}`, backBy: d => `tilbage senest ${d}`, outSection: 'Fremme lige nu', outUntil: 'Fremme til (valgfrit)',
  tookOut: (n, w) => `${n} taget frem fra ${w}. Pladsen beholdes.`, putBackDone: (n, w) => `${n} er tilbage i ${w}.`, deletedX: n => `${n} slettet.`, undo: 'Fortryd', more: 'Mere',
  quickAddPh: w => `Tilføj til ${w}…`, boxEmpty: 'Intet her endnu.', backQ: 'Er den tilbage på plads?', stillOut: 'Stadig fremme', isBack: 'Den er tilbage',
  adLabel: 'Annonce · testplads', adTitle: 'Storrrage uden reklamer', adText: 'Premium fjerner reklamer.', readMore: 'Læs mere', adsSetting: 'Vis annoncepladser (test)',
  swipeHint: 'Swipe til højre for at tage frem eller lægge tilbage, til venstre for at slette.', addShort: 'Ting', severalShort: 'Flere', subShort: 'Kasse indeni',
  recentSearches: 'Seneste søgninger', clear: 'Ryd', pickIcon: 'Skift ikon', pickIconHint: 'Bruges når tingen ikke har et foto.', autoIcon: 'Automatisk',
  askOut: n => `Tager du ${n} frem?`, yesTemp: 'Ja, et stykke tid', yesGone: 'Ja, for altid', no: 'Nej', allOutAlready: 'Alt er allerede fremme.', allBackAlready: 'Alt er allerede tilbage.',
  tookOutN: (n, w) => `Tog ${n} frem fra ${w}. Pladserne beholdes.`, putBackN: (n, w) => `Lagde ${n} tilbage i ${w}.`, boxOutDone: c => `${c} er fremme. Pladsen på kortet beholdes.`, boxBackDone: c => `${c} er tilbage på plads.`,
  takeOutBox: 'Tag hele kassen frem', putBackBox: 'Sæt kassen tilbage', boxIsOut: 'Hele kassen er fremme', outOfN: (o, n) => `${o} af ${n} fremme`, takeOutAll: 'Tag alt frem', putBackAll: 'Læg alt tilbage',
  today: 'i dag', yesterday: 'i går', daysAgo: n => `for ${n} dage siden`, weeksAgo: n => n === 1 ? 'for 1 uge siden' : `for ${n} uger siden`, monthsAgo: n => n === 1 ? 'for 1 måned siden' : `for ${n} måneder siden`,
  yearsAgo: n => n === 1 ? 'for 1 år siden' : `for ${n} år siden`, checked: 'tjekket', neverChecked: 'aldrig tjekket', openedApp: 'åbnet i appen', changedAgo: 'ændret',
  checkQ: 'Er alt i kassen stadig rigtigt?', checkYes: '✓ Ja, alt passer', checkNo: 'Noget er ændret', checkedThanks: 'Tak! Markeret som tjekket i dag.', checkFix: 'Opdater det der er ændret, og markér den som tjekket.',
  checkedYear: (c, n) => `${c} af ${n} kasser tjekket eller opdateret i år`, nudgeCollOut: c => `Det er den tid på året. Tager du ${c} frem?`, nudgeCollBack: c => `Er ${c} tilbage på plads?`,
  nudgePattern: (n, d) => `Du plejer at tage ${n} frem ca. hver ${d}. dag. Gør du det nu?`, nudgeYearly: n => `Du tog ${n} frem omkring dette tidspunkt sidste år. Igen?`, notNow: 'Ikke nu', suggestions: 'Forslag',
  sortBy: 'Sortér', sort_manual: 'Egen rækkefølge', sort_az: 'A–Å', sort_changed: 'Senest ændret', sort_added: 'Senest tilføjet', sort_used: 'Senest brugt',
  listDragHint: 'Hold på en kasse eller ting for at trække den – op, ned eller til en anden kasse.', editItem: 'Rediger', trash: 'Slettet', trashHint: 'Slettede ting gemmes her i 30 dage.',
  daysLeft: n => n === 1 ? '1 dag tilbage' : `${n} dage tilbage`, restoreItem: 'Gendan', trashEmpty: 'Intet slettet.', emptyTrash: 'Tøm nu', emptyTrashQ: n => `Slet ${n} ting for altid?`,
  restoredTo: (n, w) => `${n} er tilbage i ${w}.`, inTrash: 'Gemmes i Slettet i 30 dage.', remindDate: 'Eller vælg en dato', toCalendar: 'Føj til kalender',
  outNow: 'Fremme nu', allBoxes: 'Alle kasser', allItems: 'Alle ting', itemsH: 'Ting', nothingOut: 'Intet er fremme lige nu.',
  cloudMenu: 'Konto & deling', cloudTitle: 'Del med din husstand', cloudIntro: 'Log ind med din e-mail, så gemmes dit opbevaringssted på kontoen. Så kan du bruge det på computeren og andre telefoner, dele med husstanden og logge ud, hvis telefonen bliver væk.',
  email: 'E-mail', emailWhy: 'Bruges kun til login. Ingen adgangskode, ingen nyhedsbreve.', sendLink: 'Send login-link', checkMail: 'Tjek din e-mail', linkSent: e => `Vi har sendt et login-link til ${e}.`,
  linkSamePhone: 'Åbn linket på denne telefon. Det kan tage et minut – tjek også spam.', tooMany: 'For mange links sendt lige nu – prøv igen om lidt.', sendFailed: 'Kunne ikke sende. Prøv igen.',
  loginFailed: 'Login virkede ikke.', loggedIn: 'Du er logget ind.', loggedOut: 'Logget ud. Dine ting er trygt gemt på kontoen.', loginAgain: 'Log ind igen for at fortsætte synkroniseringen.',
  loggedInAs: e => `Logget ind som ${e}`, joinHousehold: 'Deltag med en QR-kode', joinHint: 'Scan koden på den andens telefon.', logout: 'Log ud',
  logoutQ: 'Log ud? Dine ting fjernes fra denne enhed, men bliver på kontoen – log ind igen for at få dem tilbage.', yourHousehold: 'Din husstand', membersN: n => n === 1 ? '1 medlem' : `${n} medlemmer`,
  e2eNote: 'Gemt på din konto på servere i EU. Kun du og dem, du inviterer, kan se det.', invite: 'Invitér nogen', inviteHint: 'Lad dem scanne med telefonens kamera eller i Storrrage (☰ → Scan en etiket).',
  shareLink: 'Del link i stedet', inviteSafe: 'Koden virker én gang i 24 timer.', inviteText: 'Del vores opbevaring i Storrrage', syncNow: 'Synk nu', syncing: 'Synkroniserer…', syncedAt: t => `Synket ${t}`,
  waitingN: n => `${n} ændringer venter på at blive synket`, offlineSync: 'Offline – synker når du har dækning.', syncFailed: 'Kunne ikke synke lige nu.', notMember: 'Du er ikke længere med i denne husstand.',
  badInvite: 'Invitationen ser forkert ud.', loginToJoin: 'Log ind først, så bruges invitationen automatisk.', switchHouseholdQ: 'Du er allerede med i en husstand. Skift til den nye?', join: 'Deltag',
  mergeQ: 'Tag det med, som allerede ligger på telefonen?', mergeYes: 'Ja, tag det med', mergeNo: 'Nej', joined: 'Du er med i husstanden!', joinFailed: 'Kunne ikke deltage. Koden kan være brugt eller for gammel.',
  statsSetting: 'Del anonym brugsstatistik', statsHint: 'Kun hvad der bruges, aldrig hvad du ejer, navne eller steder. Ikke koblet til din konto.', statsToast: 'Storrrage sender anonym brugsstatistik – aldrig dine ting.', statsWhat: 'Indstillinger',
  feedback: 'Giv feedback', feedbackIntro: 'Hvad er godt, hvad irriterer, hvad mangler? Vi læser alt.', fbIdea: 'Idé', fbBug: 'Noget er galt', fbLove: 'Jeg kan lide', fbPh: 'Skriv her…', fbContact: 'E-mail, hvis du vil have svar', optional: 'valgfrit',
  fbPrivacy: 'Sendes uden din konto. Appversion og skærm følger med.', fbThanks: 'Tak! 💜', offlineSend: 'Ingen dækning – prøv igen, når du er online.', loading: 'Indlæser…',
  installTitle: 'Installér Storrrage', install: 'Installér', installBanner: 'Installér Storrrage som app på telefonen', installedToast: 'Storrrage ligger nu på hjemmeskærmen.',
  iosStep1: 'Tryk på Del-knappen nederst i Safari.', iosStep2: 'Vælg “Føj til hjemmeskærm”.', iosStep3: 'Tryk “Tilføj”. Åbn derefter altid Storrrage fra hjemmeskærmen.', iosNote: 'På iPhone skal det være Safari. Den installerede app har sin egen hukommelse, så log ind inde i appen.',
  andStep1: 'Tryk på ⋮ øverst til højre i Chrome.', andStep2: 'Vælg “Installér app” eller “Føj til startskærm”.', usageSync: n => `Storrrage bruger ca. ${n} MB på telefonen. Alt synkes også med din konto.`,
  nameShown: 'Vises for de andre i husstanden.', loginEmail: 'Logget ind med', mailReminders: 'Send mig påmindelser på e-mail', otherEmail: 'Send til en anden adresse (valgfrit)',
  mailHint: 'Kommer snart. Mailen siger kun, at noget skal tjekkes.', logIn: 'Log ind', appearance: 'Udseende', light: 'Lyst', dark: 'Mørkt', auto: 'Automatisk', advanced: 'Mere',
  restoreHint: 'Kun nødvendig for gamle backupfiler.', inApp: 'I appen', youTag: '(dig)', editPlaces: 'Rediger steder', shareTitle: 'Del mellem telefoner', someone: 'Nogen', activeNow: 'i appen nu',
  inThisBox: n => `${n} er i denne kasse lige nu.`, editingItem: n => `${n} har denne ting åben lige nu – vent lidt, så jeres ændringer ikke støder sammen.`,
  tapTalk: 'Tryk og tal', chatPh: 'Skriv, fx “hvor er teltet?”', simpleMode: 'Enkle kommandoer, virker offline', aiOn: 'Slå AI til', offlineSimple: 'offline – enkle kommandoer',
  noSignalTxt2: 'kommandoerne ovenfor virker offline. Kræver mikrofonen dækning, så brug mikrofonen på tastaturet.', noPlaceYet: 'Intet sted endnu', unsorted: 'Usorteret', addWhat: 'Tilføj', where: 'Hvor?',
  notLoggedIn: 'Du er ikke logget ind.', ownerTag: 'du startede den', noHousehold: 'Ikke delt endnu', memberSince: 'Medlem siden', inStorage: 'Opbevaret', lastSynced: 'Senest synket',
  inviteWho: 'Hvem? (valgfrit, fx Anna)', invitesSent: 'Invitationer', joinedOn: d => `deltog ${d}`, expired: 'udløbet', waitingUntil: t => `venter · gyldig til ${t}`, invite1: 'Invitation', noInvites: 'Ingen invitationer endnu.',
  scanQR: 'Scan QR-kode', whatName: 'Hvad hedder du?', startNew: 'Start mit opbevaringssted', loginWelcome: 'Vi sender en kode til din e-mail – ingen adgangskode.',
  invitedIntro: 'Skriv din e-mail, så sender vi en kode. Så kommer du direkte ind i det delte opbevaringssted.', connectNow: 'Gem på min konto', joinOther: 'Deltag i en anden husstand (QR)',
  mergedIntoAccount: 'Det der lå på telefonen blev føjet til din konto.', unsyncedQ: n => `${n} ændringer er ikke gemt på kontoen endnu. Log ud alligevel? De går tabt.`,
  logoutAll: 'Log ud på alle enheder', logoutAllQ: 'Log ud på alle dine enheder? Brug det, hvis en telefon er blevet væk.', logoutAllHint: 'Mistet telefonen? Log ind på computeren og vælg “Log ud på alle enheder”.',
  wipedRemote: 'Du blev logget ud fra en anden enhed, så dine ting blev fjernet herfra.', codeSent: e => `Vi har sendt en e-mail til ${e}. Skriv koden her:`, wrongAddress: 'Forkert adresse?',
  orTapLink: 'Eller tryk på knappen i mailen (på denne enhed).', sendAgain: 'Send igen', sentAgain: 'Sendt igen.', codeWrong: 'Koden er forkert eller for gammel. Prøv igen eller send en ny.',
  slogan: 'Hav styr på alt, du har – og hvor det er.', startNewHint: 'Ny her? Skriv bare dit navn og kom i gang. Ingen konto nødvendig – alt gemmes på telefonen.', or: 'eller',
  loginHint: 'Har du en konto, eller vil du oprette en? Vi mailer en kode – ingen adgangskode. Så kan du dele og nå alt fra computeren.', yourEmail: 'Din e-mail', sendCode: 'Send kode',
  invitedTitle: 'Du er inviteret!', pitchTitle: 'Opret en gratis konto – det kræver kun din e-mail', pitch1: 'Del med dem, du bor med', pitch2: 'Nå alt fra computeren og andre telefoner', pitch3: 'Trygt, hvis telefonen bliver væk', pitch4: 'Flere funktioner på vej',
  fold: 'Fold sammen', unfold: 'Fold ud', foldAll: 'Fold alle sammen', unfoldAll: 'Fold alle ud', badEmail: 'Tjek e-mailadressen.', sending: 'Sender…', sendTimeout: 'Mailserveren svarede ikke. Prøv igen om et minut.',
  mailNotSent: 'Mailen blev ikke sendt', errorCode: 'Detaljer', moveLocalQ: n => `Telefonen har kasser og ting (${n}), som ikke er på din konto. Flyt dem ind? De markeres “Ny”.`, moveLocalYes: 'Ja, flyt dem ind', moveLocalNo: 'Nej, fjern dem',
  logInOrCreate: 'Log ind eller opret konto', yourAccount: 'Din konto', peopleTitle: 'Personer i husstanden', peopleHint: 'Tilføj alle, der har ting her. Invitér dem, der selv vil bruge appen.',
  inAppTag: 'bruger appen', invitePending: 'inviteret', inviteAgain: 'Invitér igen', inviteToApp: 'Invitér', loginToInvite: 'Log ind først – så kan du invitere.', inviteFor: n => `Invitér ${n}`, sendInvite: 'Send invitation',
  inviteHint2: 'Eller lad dem scanne koden med telefonens kamera.', inviteMsg: n => `${n} inviterer dig til at dele vores opbevaring i Storrrage:`, storageWord: 'Opbevaring',
  notSharedYet: 'Dit opbevaringssted er ikke gemt på kontoen endnu.', creatingInvite: 'Opretter invitationen…', inviteFailed: 'Kunne ikke oprette invitationen.',
  pasteCode: 'Indsæt koden', noCodeCopied: 'Ingen kode kopieret – kopiér tallene i mailen først.', pasteManually: 'Hold fingeren på feltet og vælg Indsæt.', nameQ: 'Hvad hedder du?', next: 'Næste', hiName: n => `Hej ${n}!`,
  placeQ: 'Hvad kalder du stedet, hvor du opbevarer ting?', kitQ: 'Hvordan vil du starte?', kitYes: 'Startsæt', kitYesSub: '10 almindelige kasser langs tre vægge – omdøb eller fjern som du vil', kitNo: 'Start tomt',
  kitDone: 'Dit startsæt er klar. Tryk på en kasse for at fylde den.', zoneLeft: 'Venstre væg', zoneBack: 'Bagvæggen', zoneRight: 'Højre væg',
  kitXmas: 'Julepynt', kitEaster: 'Påske & højtider', kitTools: 'Værktøj', kitCamping: 'Camping', kitSport: 'Sport', kitKidsClothes: 'Børnetøj', kitBooks: 'Bøger', kitCables: 'Ledninger & elektronik', kitKitchen: 'Køkken & porcelæn', kitMisc: 'Diverse',
  newThing: 'Ny ting', askAI: 'Spørg · beta', searchWord: 'Søg', searchOrAsk: 'Søg, eller spørg Storrrage…', askAbout: q => `Spørg Storrrage: “${q}”`,
  tab_home: 'Hjem', tab_search: 'Søg', tab_profile: 'Profil', tab_add: 'Tilføj'
};

STR.fi = {
  space: 'TILA', places_n: n => n === 1 ? '1 PAIKKA' : `${n} PAIKKAA`, boxes_n: n => n === 1 ? '1 LAATIKKO' : `${n} LAATIKKOA`, items_n: n => n === 1 ? '1 TAVARA' : `${n} TAVARAA`, box_n: n => `LAATIKKO ${n}`,
  allPlaces: 'Kaikki paikat', addPlace: '+ Paikka', notInBox: 'Ei laatikossa', notInBoxShort: 'ei laatikossa',
  emptyPlace: 'Napauta + lisätäksesi laatikon tai jotain, mikä ei ole laatikossa, kuten pyörän.',
  addItem: 'Lisää tavara', addSeveral: 'Lisää useita', addThingChoice: 'Lisää tavara', addMultipleChoice: 'Lisää useita', addBoxChoice: 'Lisää laatikko', item: 'tavara', items: 'tavarat', editBox: 'Muokkaa laatikkoa', label: 'Tarra',
  findStuff: 'LÖYDÄ TAVARASI!', typeKeyword: 'Kirjoita hakusana', searchIn: 'Hae kohteesta', everywhere: 'Kaikkialta', allOf: p => `Koko ${p}`,
  boxesH: 'Laatikot', similar: 'Samankaltaiset', noMatch: q => `Mikään ei vastaa hakua ”${q}”. Kokeile toista sanaa.`, nothingHere: 'Täällä ei ole vielä mitään.',
  welcome: 'Pidä kirjaa siitä, mitä missäkin on: laatikot, tavarat, kuvat ja kuitit. Löydät kaiken hakemalla tai kysymällä.',
  yourName: 'Nimesi', getStarted: 'Aloita', noAccount: 'Tiliä ei tarvita. Kaikki pysyy puhelimessa.', writeName: 'Kirjoita ensin nimesi.',
  storrrage: 'STORRRAGE', profile: 'Profiili', settings: 'Asetukset', notifications: 'Ilmoitukset', premium: 'Premium',
  version: v => `Storrrage-versio ${v}`, household: 'Kotitalous', addName: 'Lisää nimi', add: 'Lisää', you: '(sinä)', remove: 'Poista',
  householdHint: 'Käytetään tavaran omistajana ja kun puhut Storrragelle (”Elsan saappaat”).', noOne: 'Ketään ei ole vielä lisätty.',
  aiAssistant: 'Tekoälyavustaja', off: 'Pois', storagePlaces: 'Säilytyspaikat', backupNow: 'Varmuuskopioi nyt', never: 'Ei koskaan',
  restore: 'Palauta varmuuskopiosta', insurance: 'Vakuutusraportti', labelsAll: 'Tarrat kaikille laatikoille', scanLabel: 'Skannaa laatikon tarra', language: 'Kieli',
  usage: mb => `Kaikki tallennetaan vain tähän puhelimeen. Storrrage käyttää noin ${mb} Mt.`,
  dueIntro: 'Näitä et ole käyttänyt vähään aikaan. Kannattaako säilyttää vai myydä?', lastUsedOn: d => `Viimeksi käytetty ${d}`,
  usedRecently: 'Käytetty äskettäin', markSale: 'Merkitse myyntiin', nothingDue: 'Mikään ei vaadi huomiota. Aseta tavaralle ”Muistuta, jos käyttämättä” saadaksesi muistutuksen.',
  prem1: 'Jaa säilytys kotitalouden kanssa', prem2: 'Myy Torissa, Traderalla ja Vintedissä', prem3: 'Kirjautuminen ja synkronointi puhelinten välillä', premLater: 'Tulossa myöhemmin. Kaikki mitä nyt käytät on ilmaista.',
  whatIsIt: 'Mikä se on?', whereIs: 'Missä se on', addDetail: 'Lisää tietoja', lastUsed: 'Viimeksi käytetty', remind: 'Muistuta, jos käyttämättä', noRemind: 'Ei muistutusta',
  remindM: m => m === 12 ? '1 vuoden kuluttua' : m === 24 ? '2 vuoden kuluttua' : `${m} kuukauden kuluttua`, notify: d => `muistutus ${d}`,
  attachments: 'Liitteet', addAttach: '+ Lisää kuitti, takuu tai ohje', tags: 'Tunnisteet',
  registered: (d, by) => `Rekisteröity ${d}${by ? `, ${by}` : ''}.`, storedSince: d => `Säilytetty ${d} alkaen.`, changed: d => `Muutettu viimeksi ${d}.`,
  delItem: 'Poista tavara', done: 'Valmis', save: 'Tallenna', saveAnother: 'Tallenna + lisää toinen', saved: 'Tallennettu.', savedNext: n => `${n} tallennettu. Lisää seuraava.`, nameFirst: 'Anna ensin nimi.',
  f_size: 'Koko', f_brand: 'Merkki', f_value: 'Hinta / arvo (kr)', f_model: 'Malli', f_qty: 'Määrä', f_owner: 'Omistaja & tila', f_color: 'Väri', f_season: 'Kausi',
  f_serial: 'Sarjanumero', f_category: 'Luokka', f_spot: 'Tarkka paikka', f_notes: 'Muistiinpanot', whose: 'Kenen se on', status: 'Tila', loanTo: 'Lainattu kenelle', shared: 'Yhteinen',
  st_store: 'Säilössä', st_loan: 'Lainassa', st_sale: 'Myynnissä', st_sold: 'Myyty', st_given: 'Annettu pois',
  addTo: p => `Lisää kohteeseen ${p}`, boxStorage: 'Laatikko / säilytys', itemNoBox: 'Tavara ilman laatikkoa', severalPhotos: 'Useita tavaroita kuvista',
  cancel: 'Peruuta', close: 'Sulje', ok: 'OK', moveX: n => `Siirrä ${n}`, to: 'Kohde', move: 'Siirrä', movedTo: w => `Siirretty: ${w}.`, rename: 'Nimeä uudelleen', del: 'Poista', edit: 'Muokkaa',
  moveToPlace: 'Siirrä paikkaan', emptyFirst: 'Tyhjennä paikka ennen poistamista.', delQ: n => `Poistetaanko ”${n}”? Tätä ei voi perua.`, delNoteQ: 'Poistetaanko tämä äänimuistio?',
  rmPhotoQ: 'Poistetaanko kuva?', rmQ: n => `Poistetaanko ”${n}”?`, rmTagQ: n => `Poistetaanko tunniste ”${n}”?`, newPlace: 'Uusi säilytyspaikka', newPlaceHint: 'Esimerkiksi Kellari, Ullakko tai Autotalli',
  renameX: n => `Nimeä ${n} uudelleen`, newTag: 'Uusi', tagHint: 'Esimerkiksi retkeily tai talvi', voiceNotes: 'Äänimuistiot', voiceNotesBox: 'Tämän laatikon äänimuistiot',
  menu: 'Valikko', allSettings: 'Kaikki asetukset', usedNoted: 'Merkitty. Muistutus alkaa alusta.', markedSale: 'Merkitty myyntiin.',
  placesHint: 'Esimerkiksi kellarivarasto, ullakko, autotalli tai mökki. Vain nimi tallennetaan, ei koskaan osoitetta.', placeNameHint: 'Nimi, esim. Ullakko',
  fileMissing: 'Tiedosto puuttuu.', savingPhoto: 'Tallennetaan kuvaa…', unnamed: 'Nimetön', batchTitle: 'Lisää useita tavaroita', batchWhere: w => `Ne menevät kohteeseen ${w}.`,
  modeEach: 'Yksi kuva per tavara', modeEachHint: 'Ota tai valitse kuva jokaisesta tavarasta.', modeMulti: 'Useita tavaroita yhdessä kuvassa', modeMultiHint: 'Aseta tavarat esille ja ota yksi kuva. Jokaisesta tulee oma tavaransa.',
  batchAI: 'Tekoäly ehdottaa nimiä ja tietoja kuvista. Tarkistat ne ennen lisäämistä.', batchNoAI: 'Ota tekoälyavustaja käyttöön saadaksesi ehdotuksia. Ilman sitä nimeät tavarat itse.',
  batchPrivacy: 'Kuvat lähetetään tekoälypalveluun tunnistettaviksi.', thinking: 'Tunnistetaan…', aiFailed: e => `Tunnistus epäonnistui: ${e}`,
  addN: n => n === 1 ? 'Lisää 1 tavara' : `Lisää ${n} tavaraa`, batchAdded: n => n === 1 ? 'Lisättiin 1 tavara.' : `Lisättiin ${n} tavaraa.`, namePh: 'Nimi', include: 'Ota mukaan',
  morePhotos: '+ Lisää kuvia', noneYet: 'Ei vielä kuvia.', batchFound: n => n === 1 ? 'Löytyi 1 tavara.' : `Löytyi ${n} tavaraa.`, aiSuggest: 'Ehdota kuvasta', testTag: 'TESTI',
  aiLooking: 'Katsotaan kuvaa…', aiNothing: 'Tekoäly ei tunnistanut kuvasta mitään.', aiSuggestH: 'Ehdotukset kuvasta', aiSuggestHint: 'Valitse mitä haluat käyttää. Valitut tiedot korvaavat nykyiset.',
  aiNow: v => `nyt: ${v}`, apply: 'Käytä valittuja', aiApplied: n => n === 1 ? 'Päivitettiin 1 tieto.' : `Päivitettiin ${n} tietoa.`, aiNeedPhoto: 'Lisää ensin kuva.',
  rmPhoto: 'Poista kuva', addPhoto: 'Lisää kuva', editBoxH: 'Muokkaa laatikkoa', newBox: 'Uusi laatikko', name: 'Nimi', boxNamePh: 'Talvivaatteet', storagePlace: 'Säilytyspaikka',
  whereInPlace: 'Missä kohtaa paikkaa', wherePh: 'Takaseinä, ylähylly', boxPhoto: 'Kuva laatikosta', delBox: 'Poista laatikko', saveBox: 'Tallenna laatikko', addBox: 'Lisää laatikko',
  waitPhoto: 'Odota, että kuva tallentuu.', nameBox: 'Anna laatikolle nimi.', whoPhone: 'Kuka käyttää tätä puhelinta?', whoPhoneHint: 'Silloin ”minun” tarkoittaa tätä henkilöä, kun puhut Storrragelle. Näkyy myös kuka lisäsi minkäkin tavaran.',
  notSet: 'Ei asetettu', scanH: 'Skannaa laatikon tarra', pointCam: 'Osoita kameralla laatikon QR-koodia.', typeCode: 'Tai kirjoita laatikon koodi', openBox: 'Avaa laatikko',
  noCam: 'Kamera ei ole käytettävissä. Kirjoita tarran koodi.', camBlocked: 'Kameran käyttö estettiin. Kirjoita tarran koodi tai salli kamera selaimen asetuksista.',
  offline: 'Ei yhteyttä. Kaikki tallentuu puhelimeen.', shareTo: 'Jaa Driveen, sähköpostiin tai muuhun sovellukseen', saveToPhone: 'Tallenna puhelimeen (Lataukset)', savedDl: 'Tallennettu Lataukset-kansioon.',
  shareFail: 'Jakaminen ei onnistunut. Tallenna puhelimeen.', labelsAllH: 'Tarrat kaikille laatikoille', talkH: 'Puhu tai kirjoita Storrragelle', send: 'Lähetä',
  pause: 'Toimi sanomani perusteella tauon jälkeen:', whatSay: 'Mitä voin sanoa? (myös ilman yhteyttä)', noSignal: 'Ilman yhteyttä:',
  noSR: 'Puheentunnistus ei ole käytettävissä tässä selaimessa. Käytä näppäimistön mikrofonia.', readAloud: 'Lue vastaukset ääneen',
  aiIntro: 'Kun tekoäly on päällä, voit puhua vapaasti. Storrrage ymmärtää jatkokysymyksiä ja kysyy tärkeistä yksityiskohdista. Ilman yhteyttä käytetään yksinkertaisia komentoja.',
  provider: 'Palveluntarjoaja', gemFree: 'Google Gemini (ilmainen, testaukseen)', claudePaid: 'Claude (maksullinen)', simpleOnly: 'Vain yksinkertaiset komennot. Mitään ei lähetetä.', testOnly: 'Käytä vain keksittyjä testitavaroita.',
  freeTier: 'Googlen ilmaisversiossa lähettämääsi voidaan käyttää Googlen tuotteiden parantamiseen ja ihmiset voivat lukea sen. Älä lähetä oikeaa varastoasi ennen maksullista vaihtoehtoa.',
  apiKey: 'API-avain', checkKey: 'Tarkista avain', checkToChoose: 'Tarkista avain valitaksesi',
  aiSends: 'Kun puhut, Storrrage lähettää sanomasi, keskustelun viimeisen osan sekä paikkojesi, laatikoidesi ja tavaroidesi nimet ja tiedot. Äänimuistioita ei koskaan lähetetä.',
  pasteKey: 'Liitä ensin avain.', checking: 'Tarkistetaan…', works: 'Toimii.', pasteToTurnOn: 'Liitä API-avain ottaaksesi tekoälyn käyttöön.', aiIsOff: 'Tekoäly on pois päältä.', cantSave: 'Asetusta ei voitu tallentaa.',
  getGem: 'Hanki ilmainen avain: avaa aistudio.google.com, kirjaudu ja valitse ”Get API key”.', getClaude: 'Hanki avain: avaa console.anthropic.com, lisää pieni summa kohdassa Billing ja luo avain kohdassa API keys.',
  keyLocal: 'Avain tallennetaan vain tähän puhelimeen eikä sitä sisällytetä varmuuskopioihin.', inside: 'Sisällä', topLevel: p => `${p}, suoraan`, nameOptional: 'Jätä tyhjäksi, niin nimi tulee sisällöstä',
  boxInBox: 'Laatikko tämän laatikon sisällä', boxesInside: 'Laatikot sisällä', addHereBox: b => `Lisää kohteeseen ${b}`, notes: 'Muistiinpanot', recent: 'Viimeksi katsotut', favorites: 'Suosikit', fav: 'Suosikki', unfav: 'Poista suosikeista',
  viewLarge: 'Suuret ruudut', viewSmall: 'Pienet ruudut', viewList: 'Lista', select: 'Valitse', selected: n => `${n} valittu`, moveSel: 'Siirrä…', delSel: 'Poista',
  delSelQ: n => n === 1 ? 'Poistetaanko 1 tavara? Tätä ei voi perua.' : `Poistetaanko ${n} tavaraa? Tätä ei voi perua.`, movedN: (n, w) => `Siirrettiin ${n} kohteeseen ${w}.`, deletedN: n => `Poistettiin ${n}.`,
  didYouMean: 'Tarkoititko', share: 'Jaa sijainti', copied: 'Kopioitu.', shareCopy: 'Jaa kopio tästä paikasta', icon: 'Kuva', numbering: 'Laatikkonumerot',
  numPlace: 'Oma sarja jokaiselle paikalle (B-001 joka paikassa)', numAccount: 'Yksi sarja kaikille paikoille', export: 'Vie lista', exportH: 'Vie lista tavaroistasi',
  exportHint: 'Siististi riveittäin: paikka, laatikko, tavara ja tiedot.', excel: 'Excel (.xlsx)', word: 'Word (.doc)', pdf: 'PDF', scope: 'Mitä otetaan mukaan', exportAll: 'Kaikki',
  loadingLib: 'Valmistellaan tiedostoa…', needNet: 'Vaatii yhteyden ensimmäisellä kerralla.', backupHint: d => d ? `Viimeisin varmuuskopio ${d}.` : 'Ei vielä varmuuskopiota.', backupDo: 'Varmuuskopioi',
  addNav: 'Lisää', whichPlace: 'Mihin paikkaan lisätään?', nameNeeded: 'Jokaisella tavaralla pitää olla nimi.', discarded: 'Hylätty: tavaralla ei ollut nimeä.',
  col_place: 'Paikka', col_box: 'Laatikko', col_inbox: 'Sisällä', col_item: 'Tavara', col_cat: 'Luokka', col_brand: 'Merkki', col_model: 'Malli', col_size: 'Koko', col_color: 'Väri',
  col_owner: 'Omistaja', col_status: 'Tila', col_qty: 'Määrä', col_value: 'Arvo (kr)', col_stored: 'Säilytetty alkaen', col_used: 'Viimeksi käytetty', col_tags: 'Tunnisteet', col_notes: 'Muistiinpanot', col_serial: 'Sarjanro',
  listTitle: 'Varastolista', total: 'Yhteensä', showAll: 'Näytä kaikki', dragLooseHint: 'Pidä pyöreää merkkiä painettuna ja vedä se vyöhykkeelle.', addZone: 'Lisää vyöhyke', zoneExists: 'Samanniminen vyöhyke on jo olemassa.',
  doorSide: 'Ovi ja perä', doorHint: 'Valitse millä puolella ovi on ja missä perä on.', door_top: 'Ylhäällä', door_bottom: 'Alhaalla', door_left: 'Vasemmalla', door_right: 'Oikealla',
  dragHint: 'Pidä laatikkoa tai pyöreää merkkiä painettuna ja vedä se pinoon tai vyöhykkeelle.', back: 'Takaisin', switchSpace: 'Valitse paikka', shelf: 'Ruudukko', map: 'Kartta', door: 'Ovi', farIn: 'Perällä',
  noZone: 'Ei vyöhykettä', placement: 'Sijoitus', placementHint: 'Missä laatikko on: vyöhyke (esim. ”Oven vieressä”, ”Hylly 2”) ja mikä pino.', zone: 'Vyöhyke', zoneHint: 'Esim. Oven vieressä, Hylly 2, Perällä',
  stack: 'Pino', newStack: 'Uusi pino', level: 'Taso', onTop: 'Päällimmäisenä', atBottom: 'Alimmaisena', stackOf: (n, codes) => codes ? `Pino ${n}: päällä ${codes}` : `Pino ${n}`,
  closerDoor: 'Siirrä ylös', furtherIn: 'Siirrä alas', collections: 'Tunnisteet', collection: 'Tunniste', inBoxes: n => n === 1 ? '1 paikassa' : `${n} paikassa`, showOnMap: 'Näytä kartalla',
  insideBox: 'sisällä', toCollection: 'Tunniste', collHint: 'Saman tunnisteen tavarat näytetään yhdessä, vaikka ne olisivat eri laatikoissa.', collPh: 'Esim. Joulu tai Talvi',
  addedToColl: (n, t) => `Lisättiin ${n} tunnisteeseen #${t}.`, isHere: 'on täällä', openItem: 'Avaa tavara', foundIn: 'Löytyy', list: 'Lista', takeOut: 'Ota esiin', putBack: 'Palauta', outTag: 'Esillä',
  outSince: d => `esillä ${d} alkaen`, backBy: d => `takaisin viimeistään ${d}`, outSection: 'Esillä juuri nyt', outUntil: 'Esillä asti (valinnainen)',
  tookOut: (n, w) => `${n} otettu esiin kohteesta ${w}. Paikka säilyy.`, putBackDone: (n, w) => `${n} on taas kohteessa ${w}.`, deletedX: n => `${n} poistettu.`, undo: 'Kumoa', more: 'Lisää',
  quickAddPh: w => `Lisää kohteeseen ${w}…`, boxEmpty: 'Täällä ei ole vielä mitään.', backQ: 'Onko se palautettu?', stillOut: 'Yhä esillä', isBack: 'Se on palautettu',
  adLabel: 'Mainos · testipaikka', adTitle: 'Storrrage ilman mainoksia', adText: 'Premium poistaa mainokset.', readMore: 'Lue lisää', adsSetting: 'Näytä mainospaikat (testi)',
  swipeHint: 'Pyyhkäise oikealle ottaaksesi esiin tai palauttaaksesi, vasemmalle poistaaksesi.', addShort: 'Tavara', severalShort: 'Useita', subShort: 'Laatikko sisään',
  recentSearches: 'Viimeisimmät haut', clear: 'Tyhjennä', pickIcon: 'Vaihda kuvake', pickIconHint: 'Käytetään, kun tavaralla ei ole kuvaa.', autoIcon: 'Automaattinen',
  askOut: n => `Otatko ${n} esiin?`, yesTemp: 'Kyllä, hetkeksi', yesGone: 'Kyllä, pysyvästi', no: 'Ei', allOutAlready: 'Kaikki on jo esillä.', allBackAlready: 'Kaikki on jo palautettu.',
  tookOutN: (n, w) => `Otettiin ${n} esiin kohteesta ${w}. Paikat säilyvät.`, putBackN: (n, w) => `Palautettiin ${n} kohteeseen ${w}.`, boxOutDone: c => `${c} on esillä. Paikka kartalla säilyy.`, boxBackDone: c => `${c} on taas paikallaan.`,
  takeOutBox: 'Ota koko laatikko esiin', putBackBox: 'Palauta laatikko', boxIsOut: 'Koko laatikko on esillä', outOfN: (o, n) => `${o}/${n} esillä`, takeOutAll: 'Ota kaikki esiin', putBackAll: 'Palauta kaikki',
  today: 'tänään', yesterday: 'eilen', daysAgo: n => `${n} päivää sitten`, weeksAgo: n => n === 1 ? '1 viikko sitten' : `${n} viikkoa sitten`, monthsAgo: n => n === 1 ? '1 kuukausi sitten' : `${n} kuukautta sitten`,
  yearsAgo: n => n === 1 ? '1 vuosi sitten' : `${n} vuotta sitten`, checked: 'tarkistettu', neverChecked: 'ei koskaan tarkistettu', openedApp: 'avattu sovelluksessa', changedAgo: 'muutettu',
  checkQ: 'Onko laatikon sisältö yhä oikein?', checkYes: '✓ Kyllä, kaikki oikein', checkNo: 'Jotain on muuttunut', checkedThanks: 'Kiitos! Merkitty tarkistetuksi tänään.', checkFix: 'Päivitä muuttuneet ja merkitse tarkistetuksi.',
  checkedYear: (c, n) => `${c}/${n} laatikkoa tarkistettu tai päivitetty tänä vuonna`, nudgeCollOut: c => `On taas se aika vuodesta. Otatko esiin: ${c}?`, nudgeCollBack: c => `Onko ${c} palautettu?`,
  nudgePattern: (n, d) => `Otat yleensä ${n} esiin noin ${d} päivän välein. Otatko nyt?`, nudgeYearly: n => `Otit ${n} esiin suunnilleen tähän aikaan viime vuonna. Taas?`, notNow: 'Ei nyt', suggestions: 'Ehdotukset',
  sortBy: 'Lajittele', sort_manual: 'Oma järjestys', sort_az: 'A–Ö', sort_changed: 'Viimeksi muutettu', sort_added: 'Viimeksi lisätty', sort_used: 'Viimeksi käytetty',
  listDragHint: 'Pidä laatikkoa tai tavaraa painettuna vetääksesi sen – ylös, alas tai toiseen laatikkoon.', editItem: 'Muokkaa', trash: 'Poistetut', trashHint: 'Poistetut tavarat säilyvät täällä 30 päivää.',
  daysLeft: n => n === 1 ? '1 päivä jäljellä' : `${n} päivää jäljellä`, restoreItem: 'Palauta', trashEmpty: 'Ei poistettuja.', emptyTrash: 'Tyhjennä nyt', emptyTrashQ: n => `Poistetaanko ${n} pysyvästi?`,
  restoredTo: (n, w) => `${n} on taas kohteessa ${w}.`, inTrash: 'Säilyy Poistetuissa 30 päivää.', remindDate: 'Tai valitse päivä', toCalendar: 'Lisää kalenteriin',
  outNow: 'Esillä nyt', allBoxes: 'Kaikki laatikot', allItems: 'Kaikki tavarat', itemsH: 'Tavarat', nothingOut: 'Mikään ei ole nyt esillä.',
  cloudMenu: 'Tili & jakaminen', cloudTitle: 'Jaa kotitaloutesi kanssa', cloudIntro: 'Kirjaudu sähköpostilla, niin varastosi tallentuu tilillesi. Voit käyttää sitä tietokoneella ja muilla puhelimilla, jakaa sen kotitaloutesi kanssa ja kirjautua ulos, jos puhelin katoaa.',
  email: 'Sähköposti', emailWhy: 'Käytetään vain kirjautumiseen. Ei salasanaa, ei uutiskirjeitä.', sendLink: 'Lähetä kirjautumislinkki', checkMail: 'Tarkista sähköpostisi', linkSent: e => `Lähetimme kirjautumislinkin osoitteeseen ${e}.`,
  linkSamePhone: 'Avaa linkki tällä puhelimella. Saapuminen voi kestää minuutin – tarkista myös roskaposti.', tooMany: 'Liian monta linkkiä juuri nyt – yritä hetken päästä.', sendFailed: 'Lähetys epäonnistui. Yritä uudelleen.',
  loginFailed: 'Kirjautuminen epäonnistui.', loggedIn: 'Olet kirjautunut.', loggedOut: 'Kirjauduttu ulos. Varastosi on tallessa tililläsi.', loginAgain: 'Kirjaudu uudelleen jatkaaksesi synkronointia.',
  loggedInAs: e => `Kirjautunut: ${e}`, joinHousehold: 'Liity QR-koodilla', joinHint: 'Skannaa koodi toisen puhelimesta.', logout: 'Kirjaudu ulos',
  logoutQ: 'Kirjaudutaanko ulos? Varasto poistetaan tältä laitteelta, mutta se säilyy tililläsi – kirjaudu uudelleen saadaksesi sen takaisin.', yourHousehold: 'Kotitaloutesi', membersN: n => n === 1 ? '1 jäsen' : `${n} jäsentä`,
  e2eNote: 'Tallennettu tilillesi EU:ssa sijaitseville palvelimille. Vain sinä ja kutsumasi näkevät sen.', invite: 'Kutsu joku', inviteHint: 'Anna heidän skannata koodi puhelimen kameralla tai Storrragessa (☰ → Skannaa laatikon tarra).',
  shareLink: 'Jaa linkki', inviteSafe: 'Koodi toimii kerran 24 tunnin ajan.', inviteText: 'Liity yhteiseen varastoomme Storrragessa', syncNow: 'Synkronoi nyt', syncing: 'Synkronoidaan…', syncedAt: t => `Synkronoitu ${t}`,
  waitingN: n => `${n} muutosta odottaa synkronointia`, offlineSync: 'Ei yhteyttä – synkronoidaan, kun yhteys palaa.', syncFailed: 'Synkronointi ei onnistunut nyt.', notMember: 'Et ole enää tämän kotitalouden jäsen.',
  badInvite: 'Kutsu ei näytä oikealta.', loginToJoin: 'Kirjaudu ensin, niin kutsu käytetään automaattisesti.', switchHouseholdQ: 'Olet jo kotitaloudessa. Vaihdetaanko uuteen?', join: 'Liity',
  mergeQ: 'Otetaanko mukaan se, mitä puhelimessa jo on?', mergeYes: 'Kyllä, ota mukaan', mergeNo: 'Ei', joined: 'Olet nyt kotitaloudessa!', joinFailed: 'Liittyminen epäonnistui. Koodi voi olla käytetty tai vanhentunut.',
  statsSetting: 'Jaa nimetöntä käyttötilastoa', statsHint: 'Vain mitä käytetään, ei koskaan mitä omistat, nimiä tai paikkoja. Ei liitetä tiliisi.', statsToast: 'Storrrage lähettää nimetöntä käyttötilastoa – ei koskaan tavaroitasi.', statsWhat: 'Asetukset',
  feedback: 'Anna palautetta', feedbackIntro: 'Mikä on hyvää, mikä ärsyttää, mitä puuttuu? Luemme kaiken.', fbIdea: 'Idea', fbBug: 'Jokin on vialla', fbLove: 'Pidän', fbPh: 'Kirjoita tähän…', fbContact: 'Sähköposti, jos haluat vastauksen', optional: 'valinnainen',
  fbPrivacy: 'Lähetetään ilman tiliäsi. Sovelluksen versio ja näkymä tulevat mukaan.', fbThanks: 'Kiitos! 💜', offlineSend: 'Ei yhteyttä – yritä uudelleen verkossa.', loading: 'Ladataan…',
  installTitle: 'Asenna Storrrage', install: 'Asenna', installBanner: 'Asenna Storrrage sovellukseksi puhelimeen', installedToast: 'Storrrage on nyt aloitusnäytöllä.',
  iosStep1: 'Napauta Safarin alareunan Jaa-painiketta.', iosStep2: 'Valitse ”Lisää Koti-valikkoon”.', iosStep3: 'Napauta ”Lisää”. Avaa Storrrage jatkossa aina aloitusnäytöltä.', iosNote: 'iPhonessa on käytettävä Safaria. Asennetulla sovelluksella on oma muistinsa, joten kirjaudu sovelluksen sisällä.',
  andStep1: 'Napauta Chromen oikean yläkulman ⋮.', andStep2: 'Valitse ”Asenna sovellus” tai ”Lisää aloitusnäyttöön”.', usageSync: n => `Storrrage käyttää noin ${n} Mt puhelimessa. Kaikki synkronoidaan myös tilillesi.`,
  nameShown: 'Näkyy muille kotitaloudessa.', loginEmail: 'Kirjautunut osoitteella', mailReminders: 'Lähetä minulle muistutuksia sähköpostiin', otherEmail: 'Lähetä toiseen osoitteeseen (valinnainen)',
  mailHint: 'Tulossa pian. Viesti kertoo vain, että jokin vaatii huomiota.', logIn: 'Kirjaudu', appearance: 'Ulkoasu', light: 'Vaalea', dark: 'Tumma', auto: 'Automaattinen', advanced: 'Lisää',
  restoreHint: 'Tarvitaan vain vanhoille varmuuskopioille.', inApp: 'Sovelluksessa', youTag: '(sinä)', editPlaces: 'Muokkaa paikkoja', shareTitle: 'Jaa puhelinten välillä', someone: 'Joku', activeNow: 'sovelluksessa nyt',
  inThisBox: n => `${n} on tässä laatikossa juuri nyt.`, editingItem: n => `${n} on avannut tämän tavaran juuri nyt – odota hetki, etteivät muutokset mene päällekkäin.`,
  tapTalk: 'Napauta ja puhu', chatPh: 'Kirjoita, esim. ”missä teltta on?”', simpleMode: 'Yksinkertaiset komennot, toimii ilman yhteyttä', aiOn: 'Ota tekoäly käyttöön', offlineSimple: 'ei yhteyttä – yksinkertaiset komennot',
  noSignalTxt2: 'yllä olevat komennot toimivat ilman yhteyttä. Jos mikrofoni tarvitsee yhteyden, käytä näppäimistön mikrofonia.', noPlaceYet: 'Ei vielä paikkaa', unsorted: 'Lajittelematon', addWhat: 'Lisää', where: 'Minne?',
  notLoggedIn: 'Et ole kirjautunut.', ownerTag: 'sinä aloitit sen', noHousehold: 'Ei vielä jaettu', memberSince: 'Jäsen alkaen', inStorage: 'Säilössä', lastSynced: 'Viimeksi synkronoitu',
  inviteWho: 'Kuka? (valinnainen, esim. Anna)', invitesSent: 'Kutsut', joinedOn: d => `liittyi ${d}`, expired: 'vanhentunut', waitingUntil: t => `odottaa · voimassa ${t} asti`, invite1: 'Kutsu', noInvites: 'Ei vielä kutsuja.',
  scanQR: 'Skannaa QR-koodi', whatName: 'Mikä on nimesi?', startNew: 'Aloita oma varasto', loginWelcome: 'Lähetämme koodin sähköpostiisi – ei salasanaa.',
  invitedIntro: 'Kirjoita sähköpostisi, niin lähetämme koodin. Sitten pääset suoraan yhteiseen varastoon.', connectNow: 'Tallenna tililleni', joinOther: 'Liity toiseen kotitalouteen (QR)',
  mergedIntoAccount: 'Puhelimessa olleet tiedot lisättiin tilillesi.', unsyncedQ: n => `${n} muutosta ei ole vielä tallennettu tilille. Kirjaudutaanko silti ulos? Ne katoavat.`,
  logoutAll: 'Kirjaudu ulos kaikilta laitteilta', logoutAllQ: 'Kirjaudutaanko ulos kaikilta laitteilta? Käytä tätä, jos puhelin on kadonnut.', logoutAllHint: 'Katosiko puhelin? Kirjaudu tietokoneella ja valitse ”Kirjaudu ulos kaikilta laitteilta”.',
  wipedRemote: 'Sinut kirjattiin ulos toiselta laitteelta, joten varasto poistettiin tästä laitteesta.', codeSent: e => `Lähetimme viestin osoitteeseen ${e}. Kirjoita koodi tähän:`, wrongAddress: 'Väärä osoite?',
  orTapLink: 'Tai napauta viestin painiketta (tällä laitteella).', sendAgain: 'Lähetä uudelleen', sentAgain: 'Lähetetty uudelleen.', codeWrong: 'Koodi on väärä tai vanhentunut. Yritä uudelleen tai pyydä uusi.',
  slogan: 'Tiedä mitä sinulla on – ja missä se on.', startNewHint: 'Uusi täällä? Kirjoita nimesi ja aloita. Tiliä ei tarvita – kaikki tallentuu puhelimeen.', or: 'tai',
  loginHint: 'Onko sinulla tili, tai haluatko luoda sellaisen? Lähetämme koodin sähköpostiin – ei salasanaa. Voit jakaa ja käyttää kaikkea tietokoneelta.', yourEmail: 'Sähköpostisi', sendCode: 'Lähetä koodi',
  invitedTitle: 'Sinut on kutsuttu!', pitchTitle: 'Luo ilmainen tili – tarvitset vain sähköpostin', pitch1: 'Jaa asuinkumppaneidesi kanssa', pitch2: 'Käytä kaikkea tietokoneella ja muilla puhelimilla', pitch3: 'Turvassa, jos puhelin katoaa', pitch4: 'Lisää ominaisuuksia tulossa',
  fold: 'Pienennä', unfold: 'Laajenna', foldAll: 'Pienennä kaikki', unfoldAll: 'Laajenna kaikki', badEmail: 'Tarkista sähköpostiosoite.', sending: 'Lähetetään…', sendTimeout: 'Sähköpostipalvelin ei vastannut ajoissa. Yritä minuutin päästä.',
  mailNotSent: 'Viestiä ei lähetetty', errorCode: 'Tiedot', moveLocalQ: n => `Puhelimessa on laatikoita ja tavaroita (${n}), jotka eivät ole tililläsi. Siirretäänkö ne tilille? Ne merkitään ”Uusi”.`, moveLocalYes: 'Kyllä, siirrä', moveLocalNo: 'Ei, poista ne',
  logInOrCreate: 'Kirjaudu tai luo tili', yourAccount: 'Tilisi', peopleTitle: 'Kotitalouden ihmiset', peopleHint: 'Lisää kaikki, joilla on tavaroita täällä. Kutsu ne, jotka haluavat käyttää sovellusta itse.',
  inAppTag: 'käyttää sovellusta', invitePending: 'kutsuttu', inviteAgain: 'Kutsu uudelleen', inviteToApp: 'Kutsu', loginToInvite: 'Kirjaudu ensin – sitten voit kutsua.', inviteFor: n => `Kutsu ${n}`, sendInvite: 'Lähetä kutsu',
  inviteHint2: 'Tai anna hänen skannata koodi puhelimen kameralla.', inviteMsg: n => `${n} kutsuu sinut jakamaan varastomme Storrragessa:`, storageWord: 'Säilytys',
  notSharedYet: 'Varastoasi ei ole vielä tallennettu tilille.', creatingInvite: 'Luodaan kutsua…', inviteFailed: 'Kutsun luominen epäonnistui.',
  pasteCode: 'Liitä koodi', noCodeCopied: 'Koodia ei ole kopioitu – kopioi ensin numerot viestistä.', pasteManually: 'Paina kenttää pitkään ja valitse Liitä.', nameQ: 'Mikä on nimesi?', next: 'Seuraava', hiName: n => `Hei ${n}!`,
  placeQ: 'Mitä kutsut paikkaa, jossa säilytät tavaroita?', kitQ: 'Miten haluat aloittaa?', kitYes: 'Aloituspaketti', kitYesSub: '10 tavallista laatikkoa kolmen seinän vierellä – nimeä uudelleen tai poista halutessasi', kitNo: 'Aloita tyhjästä',
  kitDone: 'Aloituspaketti on valmis. Napauta laatikkoa täyttääksesi sen.', zoneLeft: 'Vasen seinä', zoneBack: 'Takaseinä', zoneRight: 'Oikea seinä',
  kitXmas: 'Joulukoristeet', kitEaster: 'Pääsiäinen & juhlat', kitTools: 'Työkalut', kitCamping: 'Retkeily', kitSport: 'Urheilu', kitKidsClothes: 'Lastenvaatteet', kitBooks: 'Kirjat', kitCables: 'Johdot & elektroniikka', kitKitchen: 'Keittiö & astiat', kitMisc: 'Sekalaista',
  newThing: 'Uusi tavara', askAI: 'Kysy · beta', searchWord: 'Hae', searchOrAsk: 'Hae tai kysy Storrragelta…', askAbout: q => `Kysy Storrragelta: ”${q}”`,
  tab_home: 'Koti', tab_search: 'Hae', tab_profile: 'Profiili', tab_add: 'Lisää'
};

STR.nb = {
  space: 'ROM', places_n: n => n === 1 ? '1 STED' : `${n} STEDER`, boxes_n: n => n === 1 ? '1 ESKE' : `${n} ESKER`, items_n: n => n === 1 ? '1 TING' : `${n} TING`, box_n: n => `ESKE ${n}`,
  allPlaces: 'Alle steder', addPlace: '+ Sted', notInBox: 'Ikke i en eske', notInBoxShort: 'ikke i en eske',
  emptyPlace: 'Trykk på + for å legge til en eske, eller noe som ikke ligger i en eske, som en sykkel.',
  addItem: 'Legg til ting', addSeveral: 'Legg til flere', addThingChoice: 'Legg til ting', addMultipleChoice: 'Legg til flere', addBoxChoice: 'Legg til eske', item: 'ting', items: 'ting', editBox: 'Rediger eske', label: 'Etikett',
  findStuff: 'FINN TINGENE DINE!', typeKeyword: 'Skriv et søkeord', searchIn: 'Søk i', everywhere: 'Overalt', allOf: p => `Hele ${p}`,
  boxesH: 'Esker', similar: 'Lignende ting', noMatch: q => `Ingenting passer med «${q}». Prøv et annet ord.`, nothingHere: 'Ingenting her ennå.',
  welcome: 'Hold oversikt over hva som står hvor: esker, ting, bilder og kvitteringer. Finn alt ved å søke eller bare spørre.',
  yourName: 'Navnet ditt', getStarted: 'Kom i gang', noAccount: 'Ingen konto trengs. Alt blir på telefonen.', writeName: 'Skriv navnet ditt først.',
  storrrage: 'STORRRAGE', profile: 'Profil', settings: 'Innstillinger', notifications: 'Varsler', premium: 'Premium',
  version: v => `Storrrage versjon ${v}`, household: 'Husstand', addName: 'Legg til et navn', add: 'Legg til', you: '(deg)', remove: 'Fjern',
  householdHint: 'Brukes til «hvem eier den» på ting, og når du snakker med Storrrage («Elsas støvler»).', noOne: 'Ingen lagt til ennå.',
  aiAssistant: 'AI-assistent', off: 'Av', storagePlaces: 'Lagringssteder', backupNow: 'Ta sikkerhetskopi nå', never: 'Aldri',
  restore: 'Gjenopprett fra sikkerhetskopi', insurance: 'Forsikringsrapport', labelsAll: 'Etiketter for alle esker', scanLabel: 'Skann en etikett', language: 'Språk',
  usage: mb => `Alt lagres bare på denne telefonen. Storrrage bruker omtrent ${mb} MB.`,
  dueIntro: 'Disse har du ikke brukt på en stund. Verdt å beholde, eller på tide å selge?', lastUsedOn: d => `Sist brukt ${d}`,
  usedRecently: 'Brukt nylig', markSale: 'Merk for salg', nothingDue: 'Ingenting trenger oppmerksomhet. Sett «Påminn meg hvis ubrukt» på en ting for å få et dytt.',
  prem1: 'Del lagring med husstanden', prem2: 'Selg på Finn, Tradera og Vinted', prem3: 'Innlogging og synk mellom telefoner', premLater: 'Kommer senere. Alt du bruker nå er gratis.',
  whatIsIt: 'Hva er det?', whereIs: 'Hvor den er', addDetail: 'Legg til detaljer', lastUsed: 'Sist brukt', remind: 'Påminn meg hvis ubrukt', noRemind: 'Ingen påminnelse',
  remindM: m => m === 12 ? 'Etter 1 år' : m === 24 ? 'Etter 2 år' : `Etter ${m} måneder`, notify: d => `påminn ${d}`,
  attachments: 'Vedlegg', addAttach: '+ Legg til kvittering, garanti eller bruksanvisning', tags: 'Stikkord',
  registered: (d, by) => `Registrert ${d}${by ? ` av ${by}` : ''}.`, storedSince: d => `Lagret siden ${d}.`, changed: d => `Sist endret ${d}.`,
  delItem: 'Slett ting', done: 'Ferdig', save: 'Lagre', saveAnother: 'Lagre + legg til en til', saved: 'Lagret.', savedNext: n => `${n} lagret. Legg til den neste.`, nameFirst: 'Gi den et navn først.',
  f_size: 'Størrelse', f_brand: 'Merke', f_value: 'Pris / verdi (kr)', f_model: 'Modell', f_qty: 'Antall', f_owner: 'Eier & status', f_color: 'Farge', f_season: 'Sesong',
  f_serial: 'Serienummer', f_category: 'Kategori', f_spot: 'Nøyaktig hvor', f_notes: 'Notater', whose: 'Hvem eier den', status: 'Status', loanTo: 'Lånt ut til', shared: 'Felles',
  st_store: 'Lagret', st_loan: 'Utlånt', st_sale: 'Til salgs', st_sold: 'Solgt', st_given: 'Gitt bort',
  addTo: p => `Legg til i ${p}`, boxStorage: 'Eske / oppbevaring', itemNoBox: 'Ting uten eske', severalPhotos: 'Flere ting fra bilder',
  cancel: 'Avbryt', close: 'Lukk', ok: 'OK', moveX: n => `Flytt ${n}`, to: 'Til', move: 'Flytt', movedTo: w => `Flyttet til ${w}.`, rename: 'Gi nytt navn', del: 'Slett', edit: 'Rediger',
  moveToPlace: 'Flytt til sted', emptyFirst: 'Tøm stedet for å slette det.', delQ: n => `Slette «${n}»? Det kan ikke angres.`, delNoteQ: 'Slette dette talenotatet?',
  rmPhotoQ: 'Fjerne dette bildet?', rmQ: n => `Fjerne «${n}»?`, rmTagQ: n => `Fjerne stikkordet «${n}»?`, newPlace: 'Nytt lagringssted', newPlaceHint: 'For eksempel Kjelleren, Loftet eller Garasjen',
  renameX: n => `Gi nytt navn til ${n}`, newTag: 'Ny', tagHint: 'For eksempel tur eller vinter', voiceNotes: 'Talenotater', voiceNotesBox: 'Talenotater for denne esken',
  menu: 'Meny', allSettings: 'Alle innstillinger', usedNoted: 'Notert. Påminnelsen starter på nytt.', markedSale: 'Merket for salg.',
  placesHint: 'For eksempel kjellerboden, loftet, garasjen eller hytta. Bare et navn lagres, aldri en adresse.', placeNameHint: 'Navn, f.eks. Loftet',
  fileMissing: 'Filen mangler.', savingPhoto: 'Lagrer bilde…', unnamed: 'Uten navn', batchTitle: 'Legg til flere ting', batchWhere: w => `De havner i ${w}.`,
  modeEach: 'Ett bilde per ting', modeEachHint: 'Ta eller velg et bilde av hver ting.', modeMulti: 'Flere ting på ett bilde', modeMultiHint: 'Legg tingene fram og ta ett bilde. Hver ting blir sin egen.',
  batchAI: 'AI foreslår navn og detaljer fra bildene. Du sjekker dem før de legges til.', batchNoAI: 'Slå på AI-assistenten for å få forslag automatisk. Uten den navngir du hver ting selv.',
  batchPrivacy: 'Bilder sendes til AI-tjenesten for å bli gjenkjent.', thinking: 'Gjenkjenner…', aiFailed: e => `Kunne ikke gjenkjenne: ${e}`,
  addN: n => n === 1 ? 'Legg til 1 ting' : `Legg til ${n} ting`, batchAdded: n => n === 1 ? 'La til 1 ting.' : `La til ${n} ting.`, namePh: 'Navn', include: 'Ta med',
  morePhotos: '+ Flere bilder', noneYet: 'Ingen bilder ennå.', batchFound: n => n === 1 ? 'Fant 1 ting.' : `Fant ${n} ting.`, aiSuggest: 'Foreslå fra bilde', testTag: 'TEST',
  aiLooking: 'Ser på bildet…', aiNothing: 'AI-en kjente ikke igjen noe på bildet.', aiSuggestH: 'Forslag fra bildet', aiSuggestHint: 'Huk av det du vil bruke. Avhukede detaljer erstatter det som står nå.',
  aiNow: v => `nå: ${v}`, apply: 'Bruk valgte', aiApplied: n => n === 1 ? 'Oppdaterte 1 detalj.' : `Oppdaterte ${n} detaljer.`, aiNeedPhoto: 'Legg til et bilde først.',
  rmPhoto: 'Fjern bilde', addPhoto: 'Legg til bilde', editBoxH: 'Rediger eske', newBox: 'Ny eske', name: 'Navn', boxNamePh: 'Vinterklær', storagePlace: 'Lagringssted',
  whereInPlace: 'Hvor på stedet', wherePh: 'Bakveggen, øverste hylle', boxPhoto: 'Bilde av esken', delBox: 'Slett eske', saveBox: 'Lagre eske', addBox: 'Legg til eske',
  waitPhoto: 'Vent til bildet er lagret.', nameBox: 'Gi esken et navn.', whoPhone: 'Hvem bruker denne telefonen?', whoPhoneHint: 'Så «min» og «mine» betyr denne personen når du snakker med Storrrage. Det viser også hvem som registrerte hver ting.',
  notSet: 'Ikke valgt', scanH: 'Skann en etikett', pointCam: 'Rett kameraet mot QR-koden på esken.', typeCode: 'Eller skriv eskens kode', openBox: 'Åpne eske',
  noCam: 'Kameraet er ikke tilgjengelig her. Skriv koden fra etiketten i stedet.', camBlocked: 'Kameraet ble blokkert. Skriv koden fra etiketten, eller tillat kameraet i nettleserens innstillinger.',
  offline: 'Frakoblet. Alt du gjør lagres på telefonen.', shareTo: 'Del til Drive, e-post eller en annen app', saveToPhone: 'Lagre på telefonen (Nedlastinger)', savedDl: 'Lagret i Nedlastinger.',
  shareFail: 'Deling fungerte ikke. Bruk Lagre på telefonen i stedet.', labelsAllH: 'Etiketter for alle esker', talkH: 'Snakk eller skriv med Storrrage', send: 'Send',
  pause: 'Gjør det jeg sa etter en pause på', whatSay: 'Hva kan jeg si? (også uten dekning)', noSignal: 'Uten dekning:',
  noSR: 'Talegjenkjenning finnes ikke i denne nettleseren. Bruk mikrofonen på tastaturet i stedet.', readAloud: 'Les svar høyt',
  aiIntro: 'Med AI på kan du snakke fritt. Storrrage forstår oppfølgingsspørsmål og spør om detaljer som betyr noe. Uten dekning brukes de enkle kommandoene.',
  provider: 'Leverandør', gemFree: 'Google Gemini (gratis, for testing)', claudePaid: 'Claude (betalt)', simpleOnly: 'Bare enkle kommandoer. Ingenting sendes noe sted.', testOnly: 'Bruk bare oppdiktede testting.',
  freeTier: 'På Googles gratisnivå kan det du sender brukes til å forbedre Googles produkter og leses av mennesker. Ikke send ditt ekte lager før du bytter til en betalt løsning.',
  apiKey: 'API-nøkkel', checkKey: 'Sjekk nøkkelen', checkToChoose: 'Sjekk nøkkelen for å velge',
  aiSends: 'Når du snakker, sender Storrrage det du sa, siste del av samtalen og navn og detaljer på steder, esker og ting. Talenotater sendes aldri.',
  pasteKey: 'Lim inn nøkkelen først.', checking: 'Sjekker…', works: 'Fungerer.', pasteToTurnOn: 'Lim inn API-nøkkelen for å slå på AI.', aiIsOff: 'AI er av.', cantSave: 'Kunne ikke lagre innstillingen.',
  getGem: 'Få en gratis nøkkel: åpne aistudio.google.com, logg inn og velg «Get API key».', getClaude: 'Få en nøkkel: åpne console.anthropic.com, sett inn et lite beløp under Billing og lag en nøkkel under API keys.',
  keyLocal: 'Nøkkelen lagres bare på denne telefonen og er ikke med i sikkerhetskopier.', inside: 'Inni', topLevel: p => `${p}, direkte`, nameOptional: 'La stå tom for å kalle den opp etter innholdet',
  boxInBox: 'Eske i denne esken', boxesInside: 'Esker inni', addHereBox: b => `Legg til i ${b}`, notes: 'Notater', recent: 'Nylig sett', favorites: 'Favoritter', fav: 'Favoritt', unfav: 'Fjern favoritt',
  viewLarge: 'Store ruter', viewSmall: 'Små ruter', viewList: 'Liste', select: 'Velg', selected: n => `${n} valgt`, moveSel: 'Flytt til…', delSel: 'Slett',
  delSelQ: n => n === 1 ? 'Slette 1 ting? Det kan ikke angres.' : `Slette ${n} ting? Det kan ikke angres.`, movedN: (n, w) => `Flyttet ${n} til ${w}.`, deletedN: n => `Slettet ${n}.`,
  didYouMean: 'Mente du', share: 'Del hvor den er', copied: 'Kopiert.', shareCopy: 'Del en kopi av dette stedet', icon: 'Bilde', numbering: 'Eskenumre',
  numPlace: 'Egen serie for hvert sted (B-001 på hvert sted)', numAccount: 'Én serie for alle steder', export: 'Eksporter en liste', exportH: 'Eksporter en liste over tingene dine',
  exportHint: 'Pent i rader: sted, eske, ting og detaljer.', excel: 'Excel (.xlsx)', word: 'Word (.doc)', pdf: 'PDF', scope: 'Hva skal med', exportAll: 'Alt',
  loadingLib: 'Gjør klar filen…', needNet: 'Dette krever dekning første gang.', backupHint: d => d ? `Siste sikkerhetskopi ${d}.` : 'Ingen sikkerhetskopi ennå.', backupDo: 'Ta sikkerhetskopi',
  addNav: 'Legg til', whichPlace: 'Legg til på hvilket sted?', nameNeeded: 'Alle ting trenger et navn.', discarded: 'Forkastet: tingen hadde ikke navn.',
  col_place: 'Sted', col_box: 'Eske', col_inbox: 'Inni', col_item: 'Ting', col_cat: 'Kategori', col_brand: 'Merke', col_model: 'Modell', col_size: 'Størrelse', col_color: 'Farge',
  col_owner: 'Eier', col_status: 'Status', col_qty: 'Antall', col_value: 'Verdi (kr)', col_stored: 'Lagret siden', col_used: 'Sist brukt', col_tags: 'Stikkord', col_notes: 'Notater', col_serial: 'Serienr.',
  listTitle: 'Lagerliste', total: 'Totalt', showAll: 'Vis alle', dragLooseHint: 'Hold på en rund markør og dra den inn i en sone.', addZone: 'Legg til sone', zoneExists: 'Det finnes allerede en sone med det navnet.',
  doorSide: 'Dør og innerste del', doorHint: 'Velg hvilken side døren er på, og hvor innerst er.', door_top: 'Topp', door_bottom: 'Bunn', door_left: 'Venstre', door_right: 'Høyre',
  dragHint: 'Hold på en eske eller rund markør og dra den til en stabel eller sone.', back: 'Tilbake', switchSpace: 'Velg sted', shelf: 'Rutenett', map: 'Kart', door: 'Dør', farIn: 'Innerst',
  noZone: 'Ingen sone', placement: 'Plassering', placementHint: 'Hvor esken står: sonen (f.eks. «Ved døren», «Hylle 2») og hvilken stabel.', zone: 'Sone', zoneHint: 'F.eks. Ved døren, Hylle 2, Innerst',
  stack: 'Stabel', newStack: 'En ny stabel', level: 'Nivå', onTop: 'Øverst', atBottom: 'Nederst', stackOf: (n, codes) => codes ? `Stabel ${n}: på ${codes}` : `Stabel ${n}`,
  closerDoor: 'Flytt opp', furtherIn: 'Flytt ned', collections: 'Stikkord', collection: 'Stikkord', inBoxes: n => n === 1 ? 'på 1 sted' : `på ${n} steder`, showOnMap: 'Vis på kart',
  insideBox: 'inni', toCollection: 'Stikkord', collHint: 'Ting med samme stikkord vises samlet, også når de ligger i ulike esker.', collPh: 'F.eks. Jul eller Vinter',
  addedToColl: (n, t) => `La ${n} til #${t}.`, isHere: 'er her', openItem: 'Åpne ting', foundIn: 'Funnet i', list: 'Liste', takeOut: 'Ta fram', putBack: 'Legg tilbake', outTag: 'Framme',
  outSince: d => `framme siden ${d}`, backBy: d => `tilbake innen ${d}`, outSection: 'Framme akkurat nå', outUntil: 'Framme til (valgfritt)',
  tookOut: (n, w) => `${n} tatt fram fra ${w}. Plassen beholdes.`, putBackDone: (n, w) => `${n} er tilbake i ${w}.`, deletedX: n => `${n} slettet.`, undo: 'Angre', more: 'Mer',
  quickAddPh: w => `Legg til i ${w}…`, boxEmpty: 'Ingenting her ennå.', backQ: 'Er den tilbake på plass?', stillOut: 'Fortsatt framme', isBack: 'Den er tilbake',
  adLabel: 'Annonse · testplass', adTitle: 'Storrrage uten reklame', adText: 'Premium fjerner reklame.', readMore: 'Les mer', adsSetting: 'Vis annonseplasser (test)',
  swipeHint: 'Sveip til høyre for å ta fram eller legge tilbake, til venstre for å slette.', addShort: 'Ting', severalShort: 'Flere', subShort: 'Eske inni',
  recentSearches: 'Siste søk', clear: 'Tøm', pickIcon: 'Bytt ikon', pickIconHint: 'Brukes når tingen ikke har bilde.', autoIcon: 'Automatisk',
  askOut: n => `Tar du fram ${n}?`, yesTemp: 'Ja, en stund', yesGone: 'Ja, for godt', no: 'Nei', allOutAlready: 'Alt er allerede framme.', allBackAlready: 'Alt er allerede tilbake.',
  tookOutN: (n, w) => `Tok fram ${n} fra ${w}. Plassene beholdes.`, putBackN: (n, w) => `La ${n} tilbake i ${w}.`, boxOutDone: c => `${c} er framme. Plassen på kartet beholdes.`, boxBackDone: c => `${c} er tilbake på plass.`,
  takeOutBox: 'Ta fram hele esken', putBackBox: 'Sett esken tilbake', boxIsOut: 'Hele esken er framme', outOfN: (o, n) => `${o} av ${n} framme`, takeOutAll: 'Ta fram alt', putBackAll: 'Legg alt tilbake',
  today: 'i dag', yesterday: 'i går', daysAgo: n => `for ${n} dager siden`, weeksAgo: n => n === 1 ? 'for 1 uke siden' : `for ${n} uker siden`, monthsAgo: n => n === 1 ? 'for 1 måned siden' : `for ${n} måneder siden`,
  yearsAgo: n => n === 1 ? 'for 1 år siden' : `for ${n} år siden`, checked: 'sjekket', neverChecked: 'aldri sjekket', openedApp: 'åpnet i appen', changedAgo: 'endret',
  checkQ: 'Stemmer alt i esken fortsatt?', checkYes: '✓ Ja, alt stemmer', checkNo: 'Noe er endret', checkedThanks: 'Takk! Merket som sjekket i dag.', checkFix: 'Oppdater det som er endret, og merk den som sjekket.',
  checkedYear: (c, n) => `${c} av ${n} esker sjekket eller oppdatert i år`, nudgeCollOut: c => `Det er den tiden av året. Tar du fram ${c}?`, nudgeCollBack: c => `Er ${c} tilbake på plass?`,
  nudgePattern: (n, d) => `Du pleier å ta fram ${n} omtrent hver ${d}. dag. Gjør du det nå?`, nudgeYearly: n => `Du tok fram ${n} rundt denne tiden i fjor. Igjen?`, notNow: 'Ikke nå', suggestions: 'Forslag',
  sortBy: 'Sorter', sort_manual: 'Egen rekkefølge', sort_az: 'A–Å', sort_changed: 'Sist endret', sort_added: 'Sist lagt til', sort_used: 'Sist brukt',
  listDragHint: 'Hold på en eske eller ting for å dra den – opp, ned eller til en annen eske.', editItem: 'Rediger', trash: 'Slettet', trashHint: 'Slettede ting tas vare på her i 30 dager.',
  daysLeft: n => n === 1 ? '1 dag igjen' : `${n} dager igjen`, restoreItem: 'Gjenopprett', trashEmpty: 'Ingenting slettet.', emptyTrash: 'Tøm nå', emptyTrashQ: n => `Slette ${n} ting for godt?`,
  restoredTo: (n, w) => `${n} er tilbake i ${w}.`, inTrash: 'Tas vare på i Slettet i 30 dager.', remindDate: 'Eller velg en dato', toCalendar: 'Legg i kalenderen',
  outNow: 'Framme nå', allBoxes: 'Alle esker', allItems: 'Alle ting', itemsH: 'Ting', nothingOut: 'Ingenting er framme nå.',
  cloudMenu: 'Konto & deling', cloudTitle: 'Del med husstanden', cloudIntro: 'Logg inn med e-posten din, så lagres lageret ditt på kontoen. Da kan du bruke det på PC-en og andre telefoner, dele med husstanden og logge ut hvis telefonen blir borte.',
  email: 'E-post', emailWhy: 'Brukes bare til innlogging. Ikke passord, ikke nyhetsbrev.', sendLink: 'Send innloggingslenke', checkMail: 'Sjekk e-posten din', linkSent: e => `Vi har sendt en innloggingslenke til ${e}.`,
  linkSamePhone: 'Åpne lenken på denne telefonen. Det kan ta et minutt – sjekk søppelpost også.', tooMany: 'For mange lenker sendt akkurat nå – prøv igjen om litt.', sendFailed: 'Kunne ikke sende. Prøv igjen.',
  loginFailed: 'Innloggingen fungerte ikke.', loggedIn: 'Du er logget inn.', loggedOut: 'Logget ut. Tingene dine er trygt lagret på kontoen.', loginAgain: 'Logg inn igjen for å fortsette å synkronisere.',
  loggedInAs: e => `Logget inn som ${e}`, joinHousehold: 'Bli med via QR-kode', joinHint: 'Skann koden på den andres telefon.', logout: 'Logg ut',
  logoutQ: 'Logge ut? Tingene fjernes fra denne enheten, men blir på kontoen – logg inn igjen for å få dem tilbake.', yourHousehold: 'Husstanden din', membersN: n => n === 1 ? '1 medlem' : `${n} medlemmer`,
  e2eNote: 'Lagret på kontoen din på servere i EU. Bare du og de du inviterer kan se det.', invite: 'Inviter noen', inviteHint: 'La dem skanne med telefonkameraet eller i Storrrage (☰ → Skann en etikett).',
  shareLink: 'Del lenke i stedet', inviteSafe: 'Koden virker én gang i 24 timer.', inviteText: 'Del lageret vårt i Storrrage', syncNow: 'Synk nå', syncing: 'Synkroniserer…', syncedAt: t => `Synket ${t}`,
  waitingN: n => `${n} endringer venter på synk`, offlineSync: 'Frakoblet – synker når du har dekning.', syncFailed: 'Kunne ikke synke nå.', notMember: 'Du er ikke lenger med i denne husstanden.',
  badInvite: 'Invitasjonen ser feil ut.', loginToJoin: 'Logg inn først, så brukes invitasjonen automatisk.', switchHouseholdQ: 'Du er allerede med i en husstand. Bytte til den nye?', join: 'Bli med',
  mergeQ: 'Ta med det som allerede ligger på telefonen?', mergeYes: 'Ja, ta det med', mergeNo: 'Nei', joined: 'Du er med i husstanden!', joinFailed: 'Kunne ikke bli med. Koden kan være brukt eller for gammel.',
  statsSetting: 'Del anonym bruksstatistikk', statsHint: 'Bare hva som brukes, aldri hva du eier, navn eller steder. Ikke koblet til kontoen din.', statsToast: 'Storrrage sender anonym bruksstatistikk – aldri tingene dine.', statsWhat: 'Innstillinger',
  feedback: 'Gi tilbakemelding', feedbackIntro: 'Hva er bra, hva irriterer, hva mangler? Vi leser alt.', fbIdea: 'Idé', fbBug: 'Noe er feil', fbLove: 'Liker', fbPh: 'Skriv her…', fbContact: 'E-post, hvis du vil ha svar', optional: 'valgfritt',
  fbPrivacy: 'Sendes uten kontoen din. Appversjon og skjerm følger med.', fbThanks: 'Takk! 💜', offlineSend: 'Ingen dekning – prøv igjen når du er på nett.', loading: 'Laster…',
  installTitle: 'Installer Storrrage', install: 'Installer', installBanner: 'Installer Storrrage som app på telefonen', installedToast: 'Storrrage ligger nå på startskjermen.',
  iosStep1: 'Trykk på Del-knappen nederst i Safari.', iosStep2: 'Velg «Legg til på Hjem-skjerm».', iosStep3: 'Trykk «Legg til». Åpne alltid Storrrage fra Hjem-skjermen.', iosNote: 'På iPhone må det være Safari. Den installerte appen har egen lagring, så logg inn inne i appen.',
  andStep1: 'Trykk på ⋮ øverst til høyre i Chrome.', andStep2: 'Velg «Installer appen» eller «Legg til på startskjermen».', usageSync: n => `Storrrage bruker omtrent ${n} MB på telefonen. Alt synkes også med kontoen din.`,
  nameShown: 'Vises for de andre i husstanden.', loginEmail: 'Logget inn med', mailReminders: 'Send meg påminnelser på e-post', otherEmail: 'Send til en annen adresse (valgfritt)',
  mailHint: 'Kommer snart. E-posten sier bare at noe bør sjekkes.', logIn: 'Logg inn', appearance: 'Utseende', light: 'Lyst', dark: 'Mørkt', auto: 'Automatisk', advanced: 'Mer',
  restoreHint: 'Trengs bare for gamle sikkerhetskopier.', inApp: 'I appen', youTag: '(deg)', editPlaces: 'Rediger steder', shareTitle: 'Del mellom telefoner', someone: 'Noen', activeNow: 'i appen nå',
  inThisBox: n => `${n} er i denne esken akkurat nå.`, editingItem: n => `${n} har denne tingen åpen nå – vent litt så endringene ikke kolliderer.`,
  tapTalk: 'Trykk og snakk', chatPh: 'Skriv, f.eks. «hvor er teltet?»', simpleMode: 'Enkle kommandoer, virker frakoblet', aiOn: 'Slå på AI', offlineSimple: 'frakoblet – enkle kommandoer',
  noSignalTxt2: 'kommandoene over virker uten dekning. Trenger mikrofonen dekning, bruk mikrofonen på tastaturet.', noPlaceYet: 'Ikke noe sted ennå', unsorted: 'Usortert', addWhat: 'Legg til', where: 'Hvor?',
  notLoggedIn: 'Du er ikke logget inn.', ownerTag: 'du startet den', noHousehold: 'Ikke delt ennå', memberSince: 'Medlem siden', inStorage: 'Lagret', lastSynced: 'Sist synket',
  inviteWho: 'Hvem? (valgfritt, f.eks. Anna)', invitesSent: 'Invitasjoner', joinedOn: d => `ble med ${d}`, expired: 'utløpt', waitingUntil: t => `venter · gyldig til ${t}`, invite1: 'Invitasjon', noInvites: 'Ingen invitasjoner ennå.',
  scanQR: 'Skann QR-kode', whatName: 'Hva heter du?', startNew: 'Start lageret mitt', loginWelcome: 'Vi sender en kode til e-posten din – ikke noe passord.',
  invitedIntro: 'Skriv e-posten din, så sender vi en kode. Da kommer du rett inn i det delte lageret.', connectNow: 'Lagre på kontoen min', joinOther: 'Bli med i en annen husstand (QR)',
  mergedIntoAccount: 'Det som lå på telefonen ble lagt til på kontoen din.', unsyncedQ: n => `${n} endringer er ikke lagret på kontoen ennå. Logge ut likevel? De går tapt.`,
  logoutAll: 'Logg ut på alle enheter', logoutAllQ: 'Logge ut på alle enhetene dine? Bruk dette hvis en telefon er borte.', logoutAllHint: 'Mistet telefonen? Logg inn på PC-en og velg «Logg ut på alle enheter».',
  wipedRemote: 'Du ble logget ut fra en annen enhet, så tingene ble fjernet herfra.', codeSent: e => `Vi har sendt en e-post til ${e}. Skriv inn koden her:`, wrongAddress: 'Feil adresse?',
  orTapLink: 'Eller trykk på knappen i e-posten (på denne enheten).', sendAgain: 'Send igjen', sentAgain: 'Sendt igjen.', codeWrong: 'Koden er feil eller for gammel. Prøv igjen eller send en ny.',
  slogan: 'Ha oversikt over alt du har – og hvor det er.', startNewHint: 'Ny her? Skriv navnet ditt og sett i gang. Ingen konto trengs – alt lagres på telefonen.', or: 'eller',
  loginHint: 'Har du en konto, eller vil du lage en? Vi sender en kode på e-post – ikke noe passord. Da kan du dele og nå alt fra PC-en.', yourEmail: 'E-posten din', sendCode: 'Send kode',
  invitedTitle: 'Du er invitert!', pitchTitle: 'Lag en gratis konto – du trenger bare e-post', pitch1: 'Del med dem du bor med', pitch2: 'Nå alt fra PC-en og andre telefoner', pitch3: 'Trygt hvis telefonen blir borte', pitch4: 'Flere funksjoner på vei',
  fold: 'Slå sammen', unfold: 'Utvid', foldAll: 'Slå sammen alle', unfoldAll: 'Utvid alle', badEmail: 'Sjekk e-postadressen.', sending: 'Sender…', sendTimeout: 'E-postserveren svarte ikke. Prøv igjen om et minutt.',
  mailNotSent: 'E-posten ble ikke sendt', errorCode: 'Detaljer', moveLocalQ: n => `Telefonen har esker og ting (${n}) som ikke er på kontoen din. Flytte dem inn? De merkes «Ny».`, moveLocalYes: 'Ja, flytt dem inn', moveLocalNo: 'Nei, fjern dem',
  logInOrCreate: 'Logg inn eller lag konto', yourAccount: 'Kontoen din', peopleTitle: 'Personer i husstanden', peopleHint: 'Legg til alle som har ting her. Inviter dem som vil bruke appen selv.',
  inAppTag: 'bruker appen', invitePending: 'invitert', inviteAgain: 'Inviter igjen', inviteToApp: 'Inviter', loginToInvite: 'Logg inn først – så kan du invitere.', inviteFor: n => `Inviter ${n}`, sendInvite: 'Send invitasjon',
  inviteHint2: 'Eller la dem skanne koden med telefonkameraet.', inviteMsg: n => `${n} inviterer deg til å dele lageret vårt i Storrrage:`, storageWord: 'Oppbevaring',
  notSharedYet: 'Lageret ditt er ikke lagret på kontoen ennå.', creatingInvite: 'Lager invitasjonen…', inviteFailed: 'Kunne ikke lage invitasjonen.',
  pasteCode: 'Lim inn koden', noCodeCopied: 'Ingen kode kopiert – kopier tallene i e-posten først.', pasteManually: 'Hold inne i feltet og velg Lim inn.', nameQ: 'Hva heter du?', next: 'Neste', hiName: n => `Hei ${n}!`,
  placeQ: 'Hva kaller du stedet der du oppbevarer ting?', kitQ: 'Hvordan vil du starte?', kitYes: 'Startpakke', kitYesSub: '10 vanlige esker langs tre vegger – gi nytt navn eller fjern som du vil', kitNo: 'Start tomt',
  kitDone: 'Startpakken er klar. Trykk på en eske for å fylle den.', zoneLeft: 'Venstre vegg', zoneBack: 'Bakveggen', zoneRight: 'Høyre vegg',
  kitXmas: 'Julepynt', kitEaster: 'Påske & høytider', kitTools: 'Verktøy', kitCamping: 'Camping', kitSport: 'Sport', kitKidsClothes: 'Barneklær', kitBooks: 'Bøker', kitCables: 'Ledninger & elektronikk', kitKitchen: 'Kjøkken & servise', kitMisc: 'Diverse',
  newThing: 'Ny ting', askAI: 'Spør · beta', searchWord: 'Søk', searchOrAsk: 'Søk, eller spør Storrrage…', askAbout: q => `Spør Storrrage: «${q}»`,
  tab_home: 'Hjem', tab_search: 'Søk', tab_profile: 'Profil', tab_add: 'Legg til'
};

Object.assign(STR.da, {editRooms: 'Rediger rum', labelLinked: c => `Etiketten hører nu til ${c}.`, newLabelH: 'Ny etiket', newLabelHint: 'Etiketten bruges ikke endnu. Hvad skal den høre til?', newLabelBox: 'Opret en ny kasse', newLabelLink: 'Knyt til en eksisterende kasse', boxNameQ: 'Hvad er der i kassen?',
  printLabel: 'Udskriv etiket', useOtherLabel: 'Brug en anden etiket (scan den)', moveLabel: 'Flyt etiketten til en anden kasse', labelMenuHint: 'Etiketter kan flyttes mellem kasser. Fortrykte tomme etiketter knyttes første gang, du scanner dem.',
  blankLabels: 'Tomme etiketter', blankHowMany: 'Hvor mange tomme etiketter?', blankPrintHint: 'Udskriv, klip ud og sæt på kasserne. Første scanning knytter etiketten til en kasse.',
  scanBarcode: 'Scan stregkode', pointBarcode: 'Ret kameraet mod stregkoden.', noBarcodeCam: 'Stregkodescanning findes ikke i denne browser. Skriv nummeret i stedet.', lookingUp: 'Søger efter produktet…', barcodeFound: n => `Fundet: ${n}`, barcodeSaved: 'Stregkoden er gemt. Ingen produktinfo fundet – skriv navnet selv.',
  moveTitle: 'Flytning', moveIntroH: 'Skal du flytte?', moveIntro: 'Giv kasserne et rum i det nye hjem, og følg dem fra pakket til flyttet til pakket ud. Dit normale opbevaringssted virker som altid.', moveStart: 'Start en flytning',
  mv_packed: 'Pakket', mv_moved: 'Flyttet', mv_unpacked: 'Pakket ud', allRooms: 'Alle rum', pickRoom: 'Vælg rum', newRoom: 'Nyt rum', moveEmpty: 'Ingen kasser i flytningen endnu.', moveNewBox: 'Ny flyttekasse', moveAddExisting: 'Tilføj eksisterende kasser',
  moveLabels: 'Udskriv etiketter til flytningen', moveRooms: 'Rum (adskil med komma)', moveEnd: 'Afslut flytningen', moveEndQ: 'Afslut flytningen? Kasserne bliver, hvor de er, uden rum og flyttestatus.', moveEnded: 'Flytningen er færdig. Velkommen hjem!', moveOngoing: (d, n) => `Flytning: ${d} af ${n} kasser pakket ud`});
Object.assign(STR.nb, {editRooms: 'Rediger rom', labelLinked: c => `Etiketten hører nå til ${c}.`, newLabelH: 'Ny etikett', newLabelHint: 'Denne etiketten er ikke i bruk ennå. Hva skal den høre til?', newLabelBox: 'Lag en ny eske', newLabelLink: 'Koble til en eksisterende eske', boxNameQ: 'Hva er i esken?',
  printLabel: 'Skriv ut etikett', useOtherLabel: 'Bruk en annen etikett (skann den)', moveLabel: 'Flytt etiketten til en annen eske', labelMenuHint: 'Etiketter kan flyttes mellom esker. Forhåndstrykte tomme etiketter kobles første gang du skanner dem.',
  blankLabels: 'Tomme etiketter', blankHowMany: 'Hvor mange tomme etiketter?', blankPrintHint: 'Skriv ut, klipp ut og fest på eskene. Første skanning kobler etiketten til en eske.',
  scanBarcode: 'Skann strekkode', pointBarcode: 'Rett kameraet mot strekkoden.', noBarcodeCam: 'Strekkodeskanning finnes ikke i denne nettleseren. Skriv inn nummeret i stedet.', lookingUp: 'Søker etter produktet…', barcodeFound: n => `Fant: ${n}`, barcodeSaved: 'Strekkoden er lagret. Fant ingen produktinfo – skriv navnet selv.',
  moveTitle: 'Flytting', moveIntroH: 'Skal du flytte?', moveIntro: 'Gi eskene et rom i det nye hjemmet og følg dem fra pakket til flyttet til pakket ut. Det vanlige lageret virker som før.', moveStart: 'Start en flytting',
  mv_packed: 'Pakket', mv_moved: 'Flyttet', mv_unpacked: 'Pakket ut', allRooms: 'Alle rom', pickRoom: 'Velg rom', newRoom: 'Nytt rom', moveEmpty: 'Ingen esker i flyttingen ennå.', moveNewBox: 'Ny flytteeske', moveAddExisting: 'Legg til eksisterende esker',
  moveLabels: 'Skriv ut etiketter for flyttingen', moveRooms: 'Rom (skill med komma)', moveEnd: 'Avslutt flyttingen', moveEndQ: 'Avslutte flyttingen? Eskene blir der de er, uten rom og flyttestatus.', moveEnded: 'Flyttingen er ferdig. Velkommen hjem!', moveOngoing: (d, n) => `Flytting: ${d} av ${n} esker pakket ut`});
Object.assign(STR.fi, {editRooms: 'Muokkaa huoneita', labelLinked: c => `Tarra kuuluu nyt laatikolle ${c}.`, newLabelH: 'Uusi tarra', newLabelHint: 'Tätä tarraa ei ole vielä käytetty. Mihin se kuuluu?', newLabelBox: 'Luo uusi laatikko', newLabelLink: 'Yhdistä olemassa olevaan laatikkoon', boxNameQ: 'Mitä laatikossa on?',
  printLabel: 'Tulosta tarra', useOtherLabel: 'Käytä toista tarraa (skannaa se)', moveLabel: 'Siirrä tarra toiseen laatikkoon', labelMenuHint: 'Tarroja voi siirtää laatikoiden välillä. Valmiiksi tulostetut tyhjät tarrat yhdistetään ensimmäisellä skannauksella.',
  blankLabels: 'Tyhjät tarrat', blankHowMany: 'Kuinka monta tyhjää tarraa?', blankPrintHint: 'Tulosta, leikkaa ja kiinnitä laatikoihin. Ensimmäinen skannaus yhdistää tarran laatikkoon.',
  scanBarcode: 'Skannaa viivakoodi', pointBarcode: 'Osoita kameralla viivakoodia.', noBarcodeCam: 'Viivakoodin luku ei ole käytettävissä tässä selaimessa. Kirjoita numero.', lookingUp: 'Haetaan tuotetta…', barcodeFound: n => `Löytyi: ${n}`, barcodeSaved: 'Viivakoodi tallennettu. Tuotetietoja ei löytynyt – kirjoita nimi itse.',
  moveTitle: 'Muutto', moveIntroH: 'Oletko muuttamassa?', moveIntro: 'Anna laatikoille huone uudessa kodissa ja seuraa niitä pakatusta muutettuun ja purettuun. Tavallinen varastosi toimii normaalisti.', moveStart: 'Aloita muutto',
  mv_packed: 'Pakattu', mv_moved: 'Muutettu', mv_unpacked: 'Purettu', allRooms: 'Kaikki huoneet', pickRoom: 'Valitse huone', newRoom: 'Uusi huone', moveEmpty: 'Muutossa ei ole vielä laatikoita.', moveNewBox: 'Uusi muuttolaatikko', moveAddExisting: 'Lisää olemassa olevia laatikoita',
  moveLabels: 'Tulosta muuton tarrat', moveRooms: 'Huoneet (pilkulla erotettuna)', moveEnd: 'Päätä muutto', moveEndQ: 'Päätetäänkö muutto? Laatikot jäävät paikoilleen ilman huonetta ja muuttotilaa.', moveEnded: 'Muutto valmis. Tervetuloa kotiin!', moveOngoing: (d, n) => `Muutto: ${d}/${n} laatikkoa purettu`});
Object.assign(STR.da, {f_warranty: 'Garanti til', warrantyLeft: n => n < 0 ? `Garantien udløb for ${-n} dage siden` : n === 0 ? 'Garantien udløber i dag' : `Garantien udløber om ${n} dage`, warrantyH: 'Garanti udløber snart', worth: v => `værdi ${v}`,
  loansTitle: 'Udlånt', loansHint: 'Ting du har lånt ud, pr. person. Sæt status “Udlånt” på en ting og skriv, hvem der har den.', loansEmpty: 'Intet er lånt ud. 🎉', unknownPerson: 'Nogen', lentSince: d => d <= 0 ? 'lånt ud i dag' : d === 1 ? 'lånt ud for 1 dag siden' : `lånt ud for ${d} dage siden`,
  gotBack: 'Fået tilbage', remindLoan: 'Påmind', loanMsg: (who, item, me) => `Hej${who ? ' ' + who : ''}! Har du stadig min ${item}? Vil gerne have den tilbage, når du er færdig 🙂${me ? ' /' + me : ''}`, loansOld: 'Lånt ud i over en måned'});
Object.assign(STR.nb, {f_warranty: 'Garanti til', warrantyLeft: n => n < 0 ? `Garantien gikk ut for ${-n} dager siden` : n === 0 ? 'Garantien går ut i dag' : `Garantien går ut om ${n} dager`, warrantyH: 'Garanti går ut snart', worth: v => `verdi ${v}`,
  loansTitle: 'Utlånt', loansHint: 'Ting du har lånt ut, per person. Sett status «Utlånt» på en ting og skriv hvem som har den.', loansEmpty: 'Ingenting er lånt ut. 🎉', unknownPerson: 'Noen', lentSince: d => d <= 0 ? 'lånt ut i dag' : d === 1 ? 'lånt ut for 1 dag siden' : `lånt ut for ${d} dager siden`,
  gotBack: 'Fått tilbake', remindLoan: 'Påminn', loanMsg: (who, item, me) => `Hei${who ? ' ' + who : ''}! Har du fortsatt ${item} min? Vil gjerne ha den tilbake når du er ferdig 🙂${me ? ' /' + me : ''}`, loansOld: 'Lånt ut i over en måned'});
Object.assign(STR.fi, {f_warranty: 'Takuu päättyy', warrantyLeft: n => n < 0 ? `Takuu päättyi ${-n} päivää sitten` : n === 0 ? 'Takuu päättyy tänään' : `Takuu päättyy ${n} päivän kuluttua`, warrantyH: 'Takuu päättymässä', worth: v => `arvo ${v}`,
  loansTitle: 'Lainassa', loansHint: 'Lainaamasi tavarat henkilöittäin. Aseta tavaran tilaksi ”Lainassa” ja kirjoita kenellä se on.', loansEmpty: 'Mitään ei ole lainassa. 🎉', unknownPerson: 'Joku', lentSince: d => d <= 0 ? 'lainattu tänään' : d === 1 ? 'lainattu 1 päivä sitten' : `lainattu ${d} päivää sitten`,
  gotBack: 'Sain takaisin', remindLoan: 'Muistuta', loanMsg: (who, item, me) => `Hei${who ? ' ' + who : ''}! Onko ${item} vielä sinulla? Haluaisin sen takaisin, kun olet valmis 🙂${me ? ' /' + me : ''}`, loansOld: 'Lainassa yli kuukauden'});
Object.assign(STR.da, {n_many: (n, first) => `${n} ting skal tjekkes. Først: ${first}`, notifTitle: 'Notifikationer', notifSetting: 'Send notifikationer til denne telefon', notifHint: 'Påmindelser, garantier der udløber, ting der burde være tilbage, og ændringer andre i husstanden laver.', notifBlocked: 'Notifikationer er blokeret. Tillad dem for Storrrage i telefonens indstillinger.', notifUnsupported: 'Denne browser kan ikke vise notifikationer.', notifOnToast: 'Notifikationer er slået til.',
  n_dueT: 'Tid til at tjekke', n_due: n => `${n} er ikke brugt længe. Beholde eller sælge?`, n_loan: (n, w) => `${w} har stadig din ${n}. Tid til at bede om den tilbage?`, n_out: (n, w) => `Er ${n} tilbage i ${w}?`, n_hh: (w, list) => `${w} har lavet ændringer: ${list}`,
  loanSinceL: 'Lånt ud siden', remindBack: 'Mind mig om at bede om den tilbage om', w1: '1 uge', w2: '2 uger', m1: '1 måned', m3: '3 måneder', pickDate: 'Vælg dato', remindOn: d => `Påmindelse ${d}`, addInto: c => `Tilføj til kassen ${c}`, boxInsideX: c => `Kasse inden i ${c}`});
Object.assign(STR.nb, {n_many: (n, first) => `${n} ting bør sjekkes. Først: ${first}`, notifTitle: 'Varsler', notifSetting: 'Send varsler til denne telefonen', notifHint: 'Påminnelser, garantier som går ut, ting som burde være tilbake, og endringer andre i husstanden gjør.', notifBlocked: 'Varsler er blokkert. Tillat dem for Storrrage i telefonens innstillinger.', notifUnsupported: 'Denne nettleseren kan ikke vise varsler.', notifOnToast: 'Varsler er på.',
  n_dueT: 'På tide å sjekke', n_due: n => `${n} er ikke brukt på lenge. Beholde eller selge?`, n_loan: (n, w) => `${w} har fortsatt ${n} din. På tide å be om den tilbake?`, n_out: (n, w) => `Er ${n} tilbake i ${w}?`, n_hh: (w, list) => `${w} har gjort endringer: ${list}`,
  loanSinceL: 'Lånt ut siden', remindBack: 'Minn meg på å be om den tilbake om', w1: '1 uke', w2: '2 uker', m1: '1 måned', m3: '3 måneder', pickDate: 'Velg dato', remindOn: d => `Påminnelse ${d}`, addInto: c => `Legg til i esken ${c}`, boxInsideX: c => `Eske inni ${c}`});
Object.assign(STR.fi, {n_many: (n, first) => `${n} asiaa kaipaa huomiota. Ensin: ${first}`, notifTitle: 'Ilmoitukset', notifSetting: 'Lähetä ilmoituksia tähän puhelimeen', notifHint: 'Muistutukset, päättyvät takuut, tavarat joiden pitäisi olla palautettu ja muiden kotitalouden jäsenten muutokset.', notifBlocked: 'Ilmoitukset on estetty. Salli ne Storrragelle puhelimen asetuksista.', notifUnsupported: 'Tämä selain ei voi näyttää ilmoituksia.', notifOnToast: 'Ilmoitukset ovat päällä.',
  n_dueT: 'Aika tarkistaa', n_due: n => `${n} on ollut pitkään käyttämättä. Säilytetäänkö vai myydäänkö?`, n_loan: (n, w) => `${w}: ${n} on yhä lainassa. Pyydetäänkö takaisin?`, n_out: (n, w) => `Onko ${n} palautettu kohteeseen ${w}?`, n_hh: (w, list) => `${w} teki muutoksia: ${list}`,
  loanSinceL: 'Lainassa alkaen', remindBack: 'Muistuta pyytämään takaisin', w1: '1 viikko', w2: '2 viikkoa', m1: '1 kuukausi', m3: '3 kuukautta', pickDate: 'Valitse päivä', remindOn: d => `Muistutus ${d}`, addInto: c => `Lisää laatikkoon ${c}`, boxInsideX: c => `Laatikko laatikon ${c} sisään`});

Object.assign(STR.en, {discardNewItemQ: 'Discard this new item?'});
Object.assign(STR.sv, {discardNewItemQ: 'Vill du slänga den nya saken?'});
Object.assign(STR.da, {discardNewItemQ: 'Vil du kassere den nye ting?'});
Object.assign(STR.nb, {discardNewItemQ: 'Vil du forkaste den nye tingen?'});
Object.assign(STR.fi, {discardNewItemQ: 'Haluatko hylätä tämän uuden tavaran?'});
Object.assign(STR.en, {itemSaveQ: 'Save changes to this item before leaving?', saveChanges: 'Save changes', discardChanges: 'Discard changes', keepEditing: 'Keep editing'});
Object.assign(STR.sv, {itemSaveQ: 'Vill du spara ändringarna innan du lämnar saken?', saveChanges: 'Spara ändringar', discardChanges: 'Släng ändringar', keepEditing: 'Fortsätt redigera'});
Object.assign(STR.da, {itemSaveQ: 'Vil du gemme ændringerne, før du forlader tingen?', saveChanges: 'Gem ændringer', discardChanges: 'Kassér ændringer', keepEditing: 'Fortsæt redigering'});
Object.assign(STR.nb, {itemSaveQ: 'Vil du lagre endringene før du går ut av tingen?', saveChanges: 'Lagre endringer', discardChanges: 'Forkast endringer', keepEditing: 'Fortsett redigering'});
Object.assign(STR.fi, {itemSaveQ: 'Tallennetaanko muutokset ennen kuin poistut tavarasta?', saveChanges: 'Tallenna muutokset', discardChanges: 'Hylkää muutokset', keepEditing: 'Jatka muokkausta'});
Object.assign(STR.en, {saveAnother: 'Save + add new'});
Object.assign(STR.sv, {saveAnother: 'Spara + lägg till ny'});
Object.assign(STR.da, {saveAnother: 'Gem + tilføj ny'});
Object.assign(STR.nb, {saveAnother: 'Lagre + legg til ny'});
Object.assign(STR.fi, {saveAnother: 'Tallenna + lisää uusi'});

/* ---------- start ---------- */
async function init(){
  render();
  try {
    idb = await openDB();
    boxes = await dbAll();
    lastBackup = await metaGet('lastBackup') || null;
    household = await metaGet('household') || [];
    recentOwners = await metaGet('recentOwners') || [];
    me = await metaGet('me') || '';
    voiceLang = await metaGet('voiceLang') || voiceLang;
    { const lp = await metaGet('langPref'), old = await metaGet('lang'); langPref = lp || (old === 'sv' || old === 'en' ? old : 'auto'); lang = langPref === 'auto' ? phoneLang() : langPref; if (langPref === 'auto') voiceLang = VOICE[lang] || 'en-US'; }
    { const s = await metaGet('silenceMs'); if (typeof s === 'number') silenceMs = s; }
    ai = await metaGet('ai') || ai;
    theme = await metaGet('theme') || 'system'; applyTheme();
    { const so = await metaGet('speakOn'); if (typeof so === 'boolean') speakOn = so; }
    numbering = await metaGet('numbering') || 'place';
    viewMode = await metaGet('viewMode') || 'grid';
    move = await metaGet('move') || {active: false, rooms: []};
    listSort = await metaGet('listSort') || 'manual'; folded = new Set(await metaGet('folded') || []); foldedPlaces = new Set(await metaGet('foldedPlaces') || []); boxOrder = await metaGet('boxOrder') || {};
    trash = await metaGet('trash') || []; purgeTrash();
    placeView = await metaGet('placeView') || 'shelf';
    rkSize = await metaGet('rkSize') || 'M'; rkMeasure = !!(await metaGet('rkMeasure')); rkRules = Object.assign(rkRules, await metaGet('rkRules') || {});
    shelfMode = await metaGet('shelfMode') || 'grid';
    recentQ = await metaGet('recentQ') || [];
    nudgeSnooze = await metaGet('nudgeSnooze') || {};
    { const ap = await metaGet('adsPreview'); if (typeof ap === 'boolean') adsPreview = ap; }
    recents = await metaGet('recent') || [];
    favoriteOrder = await metaGet('favoriteOrder') || [];
    notes = await noteAll();
    places = await metaGet('places') || [];
    if (!places.length){ places = [{id: newId(), name: (PLACE_SUG[lang] || PLACE_SUG.en)[0], createdAt: new Date().toISOString()}]; await metaPut('places', places); }
    for (const b of boxes) if (!b.placeId || !findPlace(b.placeId)){ b.placeId = places[0].id; await dbPut(clone(b)); }
    currentPlace = await metaGet('currentPlace') || 'all';
    if (currentPlace !== 'all' && !findPlace(currentPlace)) currentPlace = 'all';
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch {
    app.innerHTML = '<p class="status">This browser won’t let Storrrage store data. Open it in Chrome, not in a private tab.</p>'; return;
  }
  ready = true; updateStatus();
  await cloudInit();
  const hasStuff = boxes.some(b => !b.loose || (b.items || []).length);
  if (!me && !hasStuff && !cloud.session && !(await metaGet('onboarded').catch(() => false))) view = {name: 'welcome'};
  else view = {name: 'home', place: currentPlace};
  try { history.replaceState({root: 1}, ''); } catch {}
  render(); arm();
  try { if (sessionStorage.getItem('wiped')){ sessionStorage.removeItem('wiped'); setTimeout(() => toast(tr('wipedRemote')), 600); } if (sessionStorage.getItem('loggedOut')){ sessionStorage.removeItem('loggedOut'); setTimeout(() => toast(tr('loggedOut')), 600); } } catch {}
  if (cloud.session && !me && !pendingJoinCode) setTimeout(askMyName, 800);
  notifOn = !!(await metaGet('notifOn').catch(() => false)); notified = await metaGet('notified').catch(() => null) || {};
  setTimeout(notifyAlerts, 3000); setInterval(notifyAlerts, 3600 * 1000);
  track('open', {places: places.length, boxes: Math.min(realBoxes().length, 999), synced: !!cloud.hid});
  statsNotice();
}

/* ---------- Shelves (test): shelf units on the walls, boxes and loose things on them ----------
   Data: place.units = [{id, name, wall: 'left'|'back'|'right', width, shelves, gap}] (cm).
   Position on a box (b.shelf) or a loose item (it.shelf) = {u, s, x, l}:
   u = unit id, s = shelf from the bottom (0), x = column from the left, l = level in that column (0 = on the shelf). */
const RK_TYPES = {moving: {w: 60, h: 40, d: 40}, banana: {w: 50, h: 25, d: 40}, small: {w: 40, h: 30, d: 30}};
const RK_ITEM = {w: 30, h: 30, d: 30};
const RK_WALLS = ['left', 'back', 'right'];
let rkSize = 'M', rkMeasure = false, rkMode = 'shelves', rkTidyDetail = false, rkTidyShow = 'after', rkLastTidy = null;
let rkRules = {heavy: true, reach: true, top: true, season: true, fragile: true};
let rkPendingItem = null;
Object.assign(STR.en, {
  rk_view: 'Shelves', rk_small: 'Small', rk_medium: 'Medium', rk_large: 'Large', rk_sizeL: 'Size',
  rk_measure: 'Measurements', rk_measureHint: 'Shows centimetres: how wide each shelf unit is, how full each shelf is, and the size of each box.',
  rk_tidy: 'Tidy up', rk_wall_left: 'Left wall', rk_wall_back: 'Far wall', rk_wall_right: 'Right wall', rk_wall: 'Wall',
  rk_unitName: n => `Shelf ${n}`, rk_addUnit: 'Add shelf unit', rk_editUnit: 'Edit shelf unit', rk_width: 'Width (cm)', rk_shelves: 'Shelves',
  rk_gap: 'Height between shelves (cm)', rk_delUnit: 'Remove shelf unit',
  rk_delUnitQ: n => n ? `Remove this shelf unit? The ${n} boxes and things on it stay in this place, just not on a shelf.` : 'Remove this shelf unit?',
  rk_badSize: 'Check the numbers: width 30–400 cm, 1–8 shelves and 15–150 cm between shelves.',
  rk_empty: 'No shelf units here yet. Add the shelves you have, then drag your boxes and things onto them.',
  rk_quick: 'One shelf unit per wall', rk_unplaced: 'Not on a shelf yet', rk_unplacedEmpty: 'Drag here to take something off its shelf.',
  rk_autoPlace: 'Place them for me', rk_dragHint: 'Tap to open. Hold and drag to move – onto a shelf, between boxes or on top of a box.',
  rk_shelfN: n => `Shelf ${n}`, rk_free: n => `${n} cm free`, rk_fits: t => `Fits a ${t}`,
  rk_used: (u, w, h) => `${u} of ${w} cm used, ${h} cm high`, rk_tooWide: n => `${n} cm too wide`, rk_tooTall: 'Too tall for the shelf',
  rk_unitMeta: (w, s, n) => `${w} cm, ${s} shelves, ${n} on it`, rk_offShelf: x => `${x} is no longer on a shelf`,
  rk_boxType: 'Box size', rk_bt_moving: 'Moving box 60×40×40 cm', rk_bt_banana: 'Banana box 50×40×25 cm', rk_bt_small: 'Small box 40×30×30 cm', rk_bt_custom: 'Own measurements',
  rk_bn_moving: 'moving box', rk_bn_banana: 'banana box', rk_bn_small: 'small box',
  rk_w: 'Width', rk_h: 'Height', rk_d: 'Depth', rk_addOn: (u, s) => `Add to ${u}, ${s}`,
  rk_bottom: 'bottom shelf', rk_top: 'top shelf', rk_nth: n => `shelf ${n} from the bottom`, rk_only: 'the shelf',
  rk_simple: 'Simple', rk_detailed: 'Detailed', rk_now: 'Where they are now', rk_after: 'Where they go',
  rk_toMove: 'To move (number = step)', rk_stays: 'Stays', rk_nothing: 'Everything is already where these rules want it.',
  rk_moved: 'I’ve moved them', rk_from: 'From', rk_to: 'To', rk_tidyHint: 'Choose the rules. It only suggests spots where the box fits.',
  rk_zones: 'Bottom shelf: heavy. Middle shelves: easy to reach. Top shelf: light and rarely used.',
  rk_r_heavy: 'Heavy on the lowest shelf', rk_r_heavyD: 'Easier on your back and safer for the shelf',
  rk_r_reach: 'Used often within easy reach', rk_r_reachD: 'Middle shelves, on the shelf unit closest to the door',
  rk_r_top: 'Light and rarely used up high', rk_r_topD: 'Keepsakes and archive boxes go on top',
  rk_r_season: 'Coming season within reach', rk_r_seasonD: 'Out of season goes up high',
  rk_r_fragile: 'Nothing on top of fragile boxes', rk_r_fragileD: 'Fragile boxes get their own spot',
  rk_ruleCol: 'Breaking the rule', rk_nowCol: 'Now', rk_afterCol: 'After', rk_guesses: n => `Check the guesses (${n})`,
  rk_guessHint: 'Guessed from names, contents, seasons and when you last opened the box. Change one and it stays.',
  rk_weight: 'Weight', rk_use: 'Used', rk_fragileL: 'Fragile', rk_seasonL: 'Season',
  rk_light: 'Light ~3 kg', rk_mediumW: 'Medium ~8 kg', rk_heavy: 'Heavy ~15 kg', rk_often: 'Often', rk_sometimes: 'Sometimes', rk_rarely: 'Rarely',
  rk_yes: 'Yes', rk_no: 'No', rk_allYear: 'All year', rk_christmas: 'Christmas', rk_easter: 'Easter', rk_winter: 'Winter', rk_summer: 'Summer',
  rk_why_heavy: 'Heavy – lowest shelf', rk_why_reach: 'Used often – easy to reach', rk_why_seasonUp: s => `${s} is coming up – within reach`,
  rk_why_seasonOff: 'Out of season – up high', rk_why_top: 'Light or rarely used – up high', rk_why_room: 'Makes room for boxes that need this spot', rk_why_place: 'Gets a spot on a shelf',
  rk_updated: 'Shelves updated', rk_notPlaced: 'not on a shelf', rk_noRoom: n => `${n} didn’t fit anywhere – add a shelf unit or shelf.`,
  rk_q: x => `Is it OK to keep ${x} here?`, rk_qW: n => `It sticks out ${n} cm.`, rk_qH: n => `The stack is ${n} cm too tall.`,
  rk_qYes: 'Yes, keep it', rk_qNo: 'No, move it', rk_hard: 'This looks hard to fit',
  rk_hardW: (need, have) => `The boxes need ${need} cm, but the shelf is ${have} cm wide (measured).`,
  rk_hardH: (need, have) => `The stack is ${need} cm high, but there is ${have} cm to the shelf above (measured).`,
  rk_editM: 'Check measurements', rk_force: 'It fits anyway…', rk_forceOk: 'Keep it like this',
  rk_forceQ: 'You’ve measured both the shelf and the boxes, and the numbers don’t add up. Keep it like this anyway?',
  rk_grewW: (u, w) => `${u} is now ${w} cm wide`, rk_grewH: (s, h) => `${s} is now ${h} cm high`,
  rk_measured: 'I’ve measured this shelf unit', rk_measuredHint: 'Then the app warns you when something doesn’t fit, instead of making the shelf bigger.',
  rk_gapsNote: x => `Some shelves are higher: ${x}. Changing the height or number of shelves resets them.`,
  rk_room: 'The room', rk_roomEdit: 'Edit the room', rk_planHint: 'Tap to jump there. Hold a shelf unit and drag it to any wall.',
  rk_planAt: (w, n) => `${w}: ${n} cm from the corner`, rk_planNoRoom: 'No room there – it would overlap another shelf unit', rk_planMoved: (u, w) => `${u} moved to the ${w}`,
  rk_roomW: 'Width, far wall (cm)', rk_roomD: 'Depth, side walls (cm)', rk_door: 'Door', rk_door_left: 'Left', rk_door_mid: 'Middle', rk_door_right: 'Right',
  rk_doorW: 'Door width (cm)', rk_roomMeasured: 'I’ve measured the room', rk_roomMeasuredHint: 'Then the app warns you when shelf units don’t fit along a wall, instead of making the room bigger.',
  rk_unitsInRoom: 'Shelf units', rk_fromCorner: 'From the corner (cm)', rk_auto: 'auto', rk_depth: 'Depth (cm)',
  rk_cornerHint: 'Measured from the far corner along the side walls, and from the left corner along the far wall. Leave it empty and the app places them for you.',
  rk_wallFull: (u, w, need, have) => `${u} doesn’t fit along the ${w} (${need} of ${have} cm).`, rk_overlap: (a, b) => `${a} and ${b} overlap.`,
  rk_roomBad: 'Check the numbers: the room 50–2000 cm, the door 50–300 cm, shelf depth 10–200 cm.'
});
Object.assign(STR.sv, {
  rk_view: 'Hyllor', rk_small: 'Liten', rk_medium: 'Mellan', rk_large: 'Stor', rk_sizeL: 'Storlek',
  rk_measure: 'Mått', rk_measureHint: 'Visar centimeter: hur bred varje hylla är, hur fullt varje hyllplan är och hur stor varje låda är.',
  rk_tidy: 'Städa', rk_wall_left: 'Vänster vägg', rk_wall_back: 'Bortre vägg', rk_wall_right: 'Höger vägg', rk_wall: 'Vägg',
  rk_unitName: n => `Hylla ${n}`, rk_addUnit: 'Lägg till hylla', rk_editUnit: 'Ändra hylla', rk_width: 'Bredd (cm)', rk_shelves: 'Hyllplan',
  rk_gap: 'Höjd mellan hyllplanen (cm)', rk_delUnit: 'Ta bort hyllan',
  rk_delUnitQ: n => n ? `Ta bort hyllan? De ${n} lådor och saker som står på den blir kvar här, bara inte på en hylla.` : 'Ta bort hyllan?',
  rk_badSize: 'Kolla siffrorna: bredd 30–400 cm, 1–8 hyllplan och 15–150 cm mellan hyllplanen.',
  rk_empty: 'Inga hyllor här än. Lägg till hyllorna du har och dra sedan dina lådor och saker till dem.',
  rk_quick: 'En hylla per vägg', rk_unplaced: 'Inte på en hylla än', rk_unplacedEmpty: 'Dra hit för att ta ner något från hyllan.',
  rk_autoPlace: 'Placera åt mig', rk_dragHint: 'Tryck för att öppna. Håll inne och dra för att flytta – till en hylla, mellan lådor eller ovanpå en låda.',
  rk_shelfN: n => `Hyllplan ${n}`, rk_free: n => `${n} cm ledigt`, rk_fits: t => `Plats för en ${t}`,
  rk_used: (u, w, h) => `${u} av ${w} cm använt, ${h} cm högt`, rk_tooWide: n => `${n} cm för brett`, rk_tooTall: 'För hög för hyllplanet',
  rk_unitMeta: (w, s, n) => `${w} cm, ${s} hyllplan, ${n} på den`, rk_offShelf: x => `${x} står inte längre på en hylla`,
  rk_boxType: 'Lådans storlek', rk_bt_moving: 'Flyttkartong 60×40×40 cm', rk_bt_banana: 'Bananlåda 50×40×25 cm', rk_bt_small: 'Liten låda 40×30×30 cm', rk_bt_custom: 'Egna mått',
  rk_bn_moving: 'flyttkartong', rk_bn_banana: 'bananlåda', rk_bn_small: 'liten låda',
  rk_w: 'Bredd', rk_h: 'Höjd', rk_d: 'Djup', rk_addOn: (u, s) => `Lägg till på ${u}, ${s}`,
  rk_bottom: 'nedersta hyllplanet', rk_top: 'översta hyllplanet', rk_nth: n => `hyllplan ${n} nerifrån`, rk_only: 'hyllplanet',
  rk_simple: 'Enkel', rk_detailed: 'Detaljerad', rk_now: 'Var de står nu', rk_after: 'Vart de ska',
  rk_toMove: 'Ska flyttas (siffra = steg)', rk_stays: 'Står kvar', rk_nothing: 'Allt står redan där reglerna vill.',
  rk_moved: 'Jag har flyttat dem', rk_from: 'Från', rk_to: 'Till', rk_tidyHint: 'Välj regler. Förslaget använder bara platser där lådan får plats.',
  rk_zones: 'Nedersta hyllplanet: tungt. Mitten: lätt att nå. Översta: lätt och sällan använt.',
  rk_r_heavy: 'Tungt längst ner', rk_r_heavyD: 'Skonsamt för ryggen och säkrare för hyllan',
  rk_r_reach: 'Det du använder ofta nära till hands', rk_r_reachD: 'Mittenhyllplanen, på hyllan närmast dörren',
  rk_r_top: 'Lätt och sällan använt högst upp', rk_r_topD: 'Minnen och arkivlådor hamnar överst',
  rk_r_season: 'Kommande säsong nära till hands', rk_r_seasonD: 'Det som inte är säsong hamnar högt upp',
  rk_r_fragile: 'Inget ovanpå ömtåliga lådor', rk_r_fragileD: 'Ömtåliga lådor får en egen plats',
  rk_ruleCol: 'Bryter mot regeln', rk_nowCol: 'Nu', rk_afterCol: 'Efter', rk_guesses: n => `Kolla gissningarna (${n})`,
  rk_guessHint: 'Gissat utifrån namn, innehåll, säsong och när du senast öppnade lådan. Ändrar du en så gäller din.',
  rk_weight: 'Vikt', rk_use: 'Används', rk_fragileL: 'Ömtålig', rk_seasonL: 'Säsong',
  rk_light: 'Lätt ~3 kg', rk_mediumW: 'Mellan ~8 kg', rk_heavy: 'Tung ~15 kg', rk_often: 'Ofta', rk_sometimes: 'Ibland', rk_rarely: 'Sällan',
  rk_yes: 'Ja', rk_no: 'Nej', rk_allYear: 'Hela året', rk_christmas: 'Jul', rk_easter: 'Påsk', rk_winter: 'Vinter', rk_summer: 'Sommar',
  rk_why_heavy: 'Tung – nedersta hyllplanet', rk_why_reach: 'Används ofta – nära till hands', rk_why_seasonUp: s => `${s} närmar sig – nära till hands`,
  rk_why_seasonOff: 'Inte säsong – högt upp', rk_why_top: 'Lätt eller sällan använd – högt upp', rk_why_room: 'Gör plats för lådor som behöver platsen', rk_why_place: 'Får en plats på en hylla',
  rk_updated: 'Hyllorna uppdaterade', rk_notPlaced: 'inte på en hylla', rk_noRoom: n => `${n} fick inte plats – lägg till en hylla eller ett hyllplan.`,
  rk_q: x => `Är det okej att ${x} står här?`, rk_qW: n => `Den sticker ut ${n} cm.`, rk_qH: n => `Traven är ${n} cm för hög.`,
  rk_qYes: 'Ja, det är okej', rk_qNo: 'Nej, flytta den', rk_hard: 'Det här verkar svårt att få plats',
  rk_hardW: (need, have) => `Lådorna behöver ${need} cm, men hyllan är ${have} cm bred (uppmätt).`,
  rk_hardH: (need, have) => `Traven är ${need} cm hög, men det är ${have} cm upp till nästa hyllplan (uppmätt).`,
  rk_editM: 'Kolla måtten', rk_force: 'Det får plats ändå…', rk_forceOk: 'Behåll så här',
  rk_forceQ: 'Du har mätt både hyllan och lådorna, och siffrorna går inte ihop. Vill du ändå ha det så här?',
  rk_grewW: (u, w) => `${u} är nu ${w} cm bred`, rk_grewH: (s, h) => `${s} är nu ${h} cm högt`,
  rk_measured: 'Jag har mätt hyllan', rk_measuredHint: 'Då varnar appen när något inte får plats, i stället för att göra hyllan större.',
  rk_gapsNote: x => `Vissa hyllplan är högre: ${x}. Ändrar du höjden eller antalet hyllplan nollställs de.`,
  rk_room: 'Rummet', rk_roomEdit: 'Ändra rummet', rk_planHint: 'Tryck för att hoppa dit. Håll in en hylla och dra den till valfri vägg.',
  rk_planAt: (w, n) => `${w}: ${n} cm från hörnet`, rk_planNoRoom: 'Ingen plats där – den skulle gå in i en annan hylla', rk_planMoved: (u, w) => `${u} flyttad till ${w}`,
  rk_roomW: 'Bredd, bortre väggen (cm)', rk_roomD: 'Djup, sidoväggarna (cm)', rk_door: 'Dörr', rk_door_left: 'Vänster', rk_door_mid: 'Mitten', rk_door_right: 'Höger',
  rk_doorW: 'Dörrens bredd (cm)', rk_roomMeasured: 'Jag har mätt rummet', rk_roomMeasuredHint: 'Då varnar appen när hyllor inte får plats längs en vägg, i stället för att göra rummet större.',
  rk_unitsInRoom: 'Hyllor', rk_fromCorner: 'Från hörnet (cm)', rk_auto: 'auto', rk_depth: 'Djup (cm)',
  rk_cornerHint: 'Mät från det bortre hörnet längs sidoväggarna och från vänstra hörnet längs bortre väggen. Lämna tomt så placerar appen dem åt dig.',
  rk_wallFull: (u, w, need, have) => `${u} får inte plats längs ${w} (${need} av ${have} cm).`, rk_overlap: (a, b) => `${a} och ${b} går in i varandra.`,
  rk_roomBad: 'Kolla siffrorna: rummet 50–2000 cm, dörren 50–300 cm, hyllans djup 10–200 cm.'
});
const rkUnits = pid => ((findPlace(pid) || {}).units || []);
const rkGapOf = (u, s) => (u.gaps && u.gaps[s]) || u.gap;
const rkWallLabel = w => tr('rk_wall_' + w);
const rkShelfWord = (s, n) => n === 1 ? tr('rk_only') : s === 0 ? tr('rk_bottom') : s === n - 1 ? tr('rk_top') : tr('rk_nth', s + 1);
function rkDims(e){
  if (e.kind === 'item') return RK_ITEM;
  const b = e.b; if (b.boxType === 'custom' && b.boxDims && b.boxDims.w) return b.boxDims;
  return RK_TYPES[b.boxType] || RK_TYPES.moving;
}
function rkEnts(pid){
  const m = new Map();
  topBoxesIn(pid).sort(byCode).forEach(b => m.set('b:' + b.id, {k: 'b:' + b.id, kind: 'box', b, pos: b.shelf}));
  const l = looseOf(pid);
  (l ? [...(l.items || [])].sort(byName) : []).forEach(it => m.set('i:' + it.id, {k: 'i:' + it.id, kind: 'item', it, l, pos: it.shelf}));
  return m;
}
function rkGrid(pid){
  const units = rkUnits(pid), ents = rkEnts(pid), grid = {}, unplaced = [], placed = [];
  units.forEach(u => { grid[u.id] = Array.from({length: u.shelves}, () => []); });
  ents.forEach(e => { const q = e.pos; if (q && grid[q.u] && q.s >= 0 && q.s < grid[q.u].length) placed.push(e); else unplaced.push(e.k); });
  placed.sort((a, c) => (a.pos.x - c.pos.x) || (a.pos.l - c.pos.l));
  const tmp = {};
  placed.forEach(e => { const key = e.pos.u + ':' + e.pos.s, cols = tmp[key] = tmp[key] || []; let col = cols.find(c => c.x === e.pos.x); if (!col){ col = {x: e.pos.x, ks: []}; cols.push(col); } col.ks.push(e.k); });
  Object.entries(tmp).forEach(([key, cols]) => { const [u, s] = key.split(':'); grid[u][+s] = cols.sort((a, c) => a.x - c.x).map(c => c.ks); });
  return {units, grid, ents, unplaced};
}
const rkColW = (ents, col) => Math.max(0, ...col.map(k => rkDims(ents.get(k)).w));
const rkColH = (ents, col) => col.reduce((a, k) => a + rkDims(ents.get(k)).h, 0);
const rkUsedW = (ents, shelf) => shelf.reduce((a, c) => a + rkColW(ents, c), 0);
const rkName = e => e.kind === 'box' ? e.b.code : (e.it.name || tr('unnamed'));
function rkWhere(units, grid, k){
  for (const u of units) for (let s = 0; s < (grid[u.id] || []).length; s++) if (grid[u.id][s].some(c => c.includes(k))) return {u, s};
  return null;
}
const rkWhereText = (units, grid, k) => { const w = rkWhere(units, grid, k); return w ? `${w.u.name}, ${rkShelfWord(w.s, w.u.shelves)}` : tr('rk_notPlaced'); };
/* write a whole new arrangement: only boxes that really changed are saved, and it can be undone */
function rkCommit(pid, grid, msg){
  const {ents} = rkGrid(pid), next = new Map();
  Object.entries(grid).forEach(([u, shelves]) => shelves.forEach((cols, s) => cols.forEach((col, x) => col.forEach((k, l) => next.set(k, {u, s, x, l})))));
  const same = (a, b) => (!a && !b) || (a && b && a.u === b.u && a.s === b.s && a.x === b.x && a.l === b.l);
  const changed = [...ents.values()].filter(e => !same(e.pos, next.get(e.k)));
  if (!changed.length) return render();
  const l = looseOf(pid), boxIds = changed.filter(e => e.kind === 'box').map(e => e.b.id);
  const itemsChanged = changed.some(e => e.kind === 'item');
  snapshot([...boxIds, itemsChanged && l ? l.id : null].filter(Boolean));
  changed.filter(e => e.kind === 'box').forEach(e => { const nb = clone(e.b), p = next.get(e.k); if (p) nb.shelf = p; else delete nb.shelf; putBox(nb, true); });
  if (itemsChanged && l){ const nl = clone(l); nl.items.forEach(it => { const p = next.get('i:' + it.id); if (p) it.shelf = p; else delete it.shelf; }); putBox(nl, true); }
  render();
  if (msg) toastAction(msg, tr('undo'), () => { undoApply(); render(); });
}
let rkLastDrop = null;
function rkDrop(ek, pid, t){
  const {units, grid, ents} = rkGrid(pid), e = ents.get(ek); if (!e) return;
  rkLastDrop = t.type === 'out' ? null : {k: ek, u: t.u, s: t.s};
  const shelf = t.u && grid[t.u] ? grid[t.u][t.s] : null;
  if (t.type === 'stack'){ const col = shelf && shelf[t.c]; if (!col || (col.length === 1 && col[0] === ek)) return; }
  const ref = t.type === 'insert' && shelf ? shelf[t.idx] : null;
  const stackCol = t.type === 'stack' ? shelf[t.c] : null;
  Object.values(grid).forEach(sh => sh.forEach((cols, i) => { sh[i] = cols.map(c => c.filter(k => k !== ek)).filter(c => c.length); }));
  const sh2 = shelf ? grid[t.u][t.s] : null;
  if (t.type === 'stack'){ const col = sh2.find(c => c === stackCol) || sh2.find(c => stackCol.filter(k => k !== ek).every(k => c.includes(k))); if (!col) return; col.push(ek); }
  else if (t.type === 'insert'){ let i = ref ? sh2.findIndex(c => c === ref || (ref.filter(k => k !== ek).length && ref.filter(k => k !== ek).every(k => c.includes(k)))) : -1; if (i < 0) i = Math.min(t.idx, sh2.length); sh2.splice(i, 0, [ek]); }
  const w = t.type === 'out' ? null : rkWhere(units, grid, ek);
  rkCommit(pid, grid, w ? `${rkName(e)} → ${w.u.name}, ${rkShelfWord(w.s, w.u.shelves)}` : tr('rk_offShelf', rkName(e)));
}

/* --- drawing --- */
function rkBoxEl(e, w, h, o){
  const b = e.b, n = (b.items || []).length + childBoxes(b.id).length, big = w >= 54 && h >= 40;
  const label = w >= 22 && h >= 16 ? `<span class="rklabel">${esc(boxNum(b))}</span>` : '';
  const name = o.large && w >= 70 && h >= 52 ? `<span class="rkname">${esc(b.name || boxLabel(b))}</span>` : '';
  const dims = o.measure && o.large && w >= 70 && h >= 66 ? `<span class="rkdim">${rkDims(e).w}×${rkDims(e).h}</span>` : '';
  return `<button class="rkbox${b.out ? ' out' : ''}${o.tall ? ' tall' : ''}" style="width:${w.toFixed(1)}px;height:${h.toFixed(1)}px" data-open="${esc(b.id)}" data-rk-ek="b:${esc(b.id)}" aria-label="${esc(b.code + ' ' + (b.name || ''))}">${label}${name}${dims}${big && n ? `<span class="rkcount">${n}</span>` : ''}</button>`;
}
function rkItemEl(e, w, h, o){
  const it = e.it, p = (it.photos || [])[0], d = Math.max(10, Math.min(w, h));
  return `<button class="rkitem${isOut(it) ? ' out' : ''}" style="width:${w.toFixed(1)}px;height:${h.toFixed(1)}px" data-item="${esc(it.id)}" data-box="${esc(e.l.id)}" data-rk-ek="i:${esc(it.id)}" aria-label="${esc(it.name || '')}"><span class="lcirc" style="width:${d.toFixed(1)}px;height:${d.toFixed(1)}px">${p ? imgTag(p.ref, '') : ''}${d >= 26 ? `<span class="ticon${p ? ' fb' : ''}" style="font-size:${Math.min(40, d * .45).toFixed(0)}px">${guessIcon(it)}</span>` : ''}</span></button>`;
}
function rkDraw(u, data, width, o){
  const {ents, grid} = data, inner = Math.max(40, width - 12), sc = inner / u.width, compact = width < 170, minPx = compact ? 6 : 16;
  let rows = '';
  for (let s = u.shelves - 1; s >= 0; s--){
    const shelf = grid[u.id][s] || [], used = rkUsedW(ents, shelf), free = u.width - used;
    const cols = shelf.map((col, c) => {
      const tall = rkColH(ents, col) > rkGapOf(u, s);
      return `<div class="rkcol" data-rk-col data-rk-c="${c}">${col.map(k => { const e = ents.get(k), d = rkDims(e), w = Math.max(minPx, d.w * sc - 2), h = Math.max(minPx, d.h * sc - 2);
        return e.kind === 'box' ? rkBoxEl(e, w, h, {large: !compact, measure: o.measure, tall}) : rkItemEl(e, w, h); }).join('')}</div>`;
    }).join('');
    let add = '';
    if (free >= 12){ const fpx = free * sc, fit = ['moving', 'banana', 'small'].find(t => RK_TYPES[t].w <= free && RK_TYPES[t].h <= rkGapOf(u, s));
      add = compact || fpx < 76 ? (fpx >= 20 ? `<button class="rkfree sm" data-rk-add data-rk-u="${esc(u.id)}" data-rk-s="${s}" aria-label="${esc(tr('rk_addOn', u.name, rkShelfWord(s, u.shelves)))}">+</button>` : '')
        : `<button class="rkfree" data-rk-add data-rk-u="${esc(u.id)}" data-rk-s="${s}" aria-label="${esc(tr('rk_addOn', u.name, rkShelfWord(s, u.shelves)))}"><b>+</b><span>${esc(o.measure || !fit ? tr('rk_free', free) : tr('rk_fits', tr('rk_bn_' + fit)))}</span></button>`; }
    rows += (o.measure && !compact ? `<div class="rkfill"><span>${esc(tr('rk_shelfN', s + 1))}: ${esc(tr('rk_used', used, u.width, rkGapOf(u, s)))}</span><i style="width:${Math.min(100, Math.max(0, used / u.width * 100))}%"></i></div>` : '')
      + `<div class="rkshelf${free < 0 ? ' wide' : ''}" data-rk-shelf data-rk-u="${esc(u.id)}" data-rk-s="${s}" style="min-height:${Math.round(rkGapOf(u, s) * sc)}px">${cols}${add}${free < 0 ? `<span class="rkwarn">${compact ? '!' : esc(tr('rk_tooWide', -free))}</span>` : ''}</div><div class="rkplank"></div>${rkQuestion(u, s, data, compact)}`;
  }
  return `${o.measure && !compact ? `<div class="rkruler"><span>${u.width} cm</span></div>` : ''}<div class="rkframe${compact ? ' thin' : ''}">${rows}</div><div class="rklegs" aria-hidden="true"><i></i><i></i></div>`;
}
/* something sticks out or is too tall: ask about it right below that shelf.
   Measured shelf + measured boxes = a real warning that is hard to click away; otherwise one tap and the shelf follows the boxes. */
const rkBoxMeasured = e => e.kind === 'box' && (e.b.boxTypeSet || e.b.boxType === 'custom');
function rkProblem(u, s, data){
  const {ents, grid} = data, shelf = grid[u.id][s] || [], gap = rkGapOf(u, s);
  const used = rkUsedW(ents, shelf), tall = shelf.filter(c => rkColH(ents, c) > gap);
  if (used <= u.width && !tall.length) return null;
  const sig = shelf.map(c => c.join('+')).join('|');
  const keys = [...new Set([...(used > u.width ? shelf.flat() : []), ...tall.flat()])];
  const last = rkLastDrop && rkLastDrop.u === u.id && rkLastDrop.s === s && keys.includes(rkLastDrop.k) ? rkLastDrop.k : null;
  const culprit = last || (tall.length ? tall[0][tall[0].length - 1] : shelf[shelf.length - 1][shelf[shelf.length - 1].length - 1]);
  const strict = !!u.measured && keys.every(k => rkBoxMeasured(ents.get(k)));
  return {used, wide: used - u.width, high: tall.length ? Math.max(...tall.map(c => rkColH(ents, c))) : 0, gap, sig, culprit, strict, accepted: (u.ok || {})[s] === sig};
}
function rkQuestion(u, s, data, compact){
  const pr = rkProblem(u, s, data); if (!pr || pr.accepted) return '';
  const name = rkName(data.ents.get(pr.culprit)), at = `data-rk-u="${esc(u.id)}" data-rk-s="${s}"`;
  if (pr.strict) return `<div class="rkq strict" role="alert"><b>⚠ ${tr('rk_hard')}</b>
    ${pr.wide > 0 ? `<span>${esc(tr('rk_hardW', pr.used, u.width))}</span>` : ''}${pr.high ? `<span>${esc(tr('rk_hardH', pr.high, pr.gap))}</span>` : ''}
    <div class="rkqb"><button class="btn primary small" data-rk-q="edit" ${at}>${tr('rk_editM')}</button><button class="btn quiet small" data-rk-q="no" ${at} data-rk-k="${esc(pr.culprit)}">${tr('rk_qNo')}</button></div>
    <button class="linkbtn rkforce" data-rk-q="force" ${at}>${tr('rk_force')}</button></div>`;
  const why = pr.wide > 0 ? tr('rk_qW', pr.wide) : tr('rk_qH', pr.high - pr.gap);
  return `<div class="rkq${compact ? ' cmp' : ''}"><span>${esc(tr('rk_q', name))}${compact ? '' : ' ' + esc(why)}</span>
    <div class="rkqb"><button class="btn primary small" data-rk-q="yes" ${at}>${tr('rk_qYes')}</button><button class="btn quiet small" data-rk-q="no" ${at} data-rk-k="${esc(pr.culprit)}">${tr('rk_qNo')}</button></div></div>`;
}
function rkAnswer(pid, q, uid, s, k){
  const p = findPlace(pid), u = (p.units || []).find(x => x.id === uid); if (!u) return;
  const data = rkGrid(pid), pr = rkProblem(u, s, data); if (!pr && q !== 'edit') return render();
  const save = () => { metaPut('places', places).catch(() => {}); render(); };
  if (q === 'edit') return rkUnitSheet(pid, uid);
  if (q === 'no'){
    if (rkLastDrop && rkLastDrop.k === k && rkLastDrop.u === uid && rkLastDrop.s === s && undoStack.length){ rkLastDrop = null; undoApply(); return render(); }
    return rkDrop(k, pid, {type: 'out'});
  }
  if (q === 'force') return askConfirm(tr('rk_forceQ'), tr('rk_forceOk')).then(y => { if (!y) return render(); u.ok = Object.assign({}, u.ok, {[s]: pr.sig}); save(); });
  if (q === 'yes'){
    if (u.measured){ u.ok = Object.assign({}, u.ok, {[s]: pr.sig}); return save(); }
    const msgs = [];
    if (pr.wide > 0){ u.width = pr.used; msgs.push(tr('rk_grewW', u.name, u.width)); }
    if (pr.high){ u.gaps = Array.from({length: u.shelves}, (_, i) => rkGapOf(u, i)); u.gaps[s] = pr.high; msgs.push(tr('rk_grewH', tr('rk_shelfN', s + 1), pr.high)); }
    rkLastDrop = null; save(); toast(msgs.join(' · '));
  }
}
/* --- the room from above: walls, door and shelf units to scale; tap to jump, ✎ to edit --- */
const RK_DOOR_X = {left: .2, mid: .5, right: .8};
function rkRoomOf(p){ return Object.assign({w: 200, d: 250, door: 'mid', doorW: 80, measured: false}, p.room || {}); }
function rkPlan(p){
  const room = rkRoomOf(p), units = p.units || [], spots = [], need = {back: 0, left: 0, right: 0};
  const backDepth = Math.max(0, ...units.filter(u => u.wall === 'back').map(u => u.depth || 40));
  RK_WALLS.forEach(w => {
    let run = w === 'back' ? 0 : (backDepth ? backDepth + 5 : 0);
    units.filter(u => u.wall === w).forEach(u => {
      const at = u.at !== undefined && u.at !== null && u.at !== '' ? +u.at : run, dp = u.depth || 40;
      run = at + u.width + 5; need[w] = Math.max(need[w], at + u.width);
      spots.push({u, wall: w, at, len: u.width, dp});
    });
  });
  const sideDepth = Math.max(0, ...spots.filter(x => x.wall !== 'back').map(x => x.dp));
  const W = room.measured ? room.w : Math.max(room.w, need.back, sideDepth * 2 + room.doorW);
  const D = room.measured ? room.d : Math.max(room.d, need.left, need.right, backDepth + 60);
  spots.forEach(sp => {
    if (sp.wall === 'back') Object.assign(sp, {x: sp.at, y: 0, w: sp.len, h: sp.dp});
    else if (sp.wall === 'left') Object.assign(sp, {x: 0, y: sp.at, w: sp.dp, h: sp.len});
    else Object.assign(sp, {x: W - sp.dp, y: sp.at, w: sp.dp, h: sp.len});
    const wallLen = sp.wall === 'back' ? W : D;
    sp.over = sp.at + sp.len > wallLen;
  });
  const issues = [];
  spots.filter(sp => sp.over).forEach(sp => issues.push(tr('rk_wallFull', sp.u.name, rkWallLabel(sp.wall).toLowerCase(), sp.at + sp.len, sp.wall === 'back' ? W : D)));
  spots.forEach((a, i) => spots.slice(i + 1).forEach(b => { if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h){ a.clash = b.clash = true; issues.push(tr('rk_overlap', a.u.name, b.u.name)); } }));
  const dw = Math.min(room.doorW, W), dx = Math.min(W - dw / 2, Math.max(dw / 2, W * RK_DOOR_X[room.door]));
  return {room, W, D, spots, issues, door: {x: dx, w: dw}};
}
function rkPlanHTML(pid){
  const p = findPlace(pid), pl = rkPlan(p), {W, D} = pl, fs = Math.max(W, D) / 16, pad = fs * 1.6;
  const wall = (w, x1, y1, x2, y2) => `<g class="rkpw${rkWallFocus === w ? ' on' : ''}" data-rk-wall="${w}" role="button" tabindex="0" aria-label="${esc(rkWallLabel(w))}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="hit"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="ln"/></g>`;
  const dl = pl.door.x - pl.door.w / 2, dr = pl.door.x + pl.door.w / 2;
  const fit = (t, len) => { const max = Math.max(2, Math.floor(len / (fs * .8 * .6))); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
  const units = pl.spots.map(sp => { const vert = sp.h > sp.w, cx = sp.x + sp.w / 2, cy = sp.y + sp.h / 2;
    return `<g class="rkpu${sp.over || sp.clash ? ' bad' : ''}" data-rk-jump="${esc(sp.u.id)}" role="button" tabindex="0" aria-label="${esc(sp.u.name)}"><rect x="${sp.x}" y="${sp.y}" width="${sp.w}" height="${sp.h}" rx="${fs * .25}"/>
      <text x="${cx}" y="${cy}" font-size="${fs * .8}" ${vert ? `transform="rotate(-90 ${cx} ${cy})"` : ''}>${esc(fit(sp.u.name, vert ? sp.h : sp.w))}</text></g>`; }).join('') + `<text class="rkpd rkpinfo" x="${W / 2}" y="${D - fs * 1.2}" font-size="${fs * .58}"></text>`;
  const dims = pl.room.measured || rkMeasure ? `<text class="rkpd" x="${W / 2}" y="${-pad * .45}" font-size="${fs * .7}">${W} cm</text><text class="rkpd" x="${-pad * .45}" y="${D / 2}" font-size="${fs * .7}" transform="rotate(-90 ${-pad * .45} ${D / 2})">${D} cm</text>` : '';
  return `<section class="rkplan"><div class="rkplanhead"><b>${tr('rk_room')}</b><span class="zcount">${esc(tr('rk_planHint'))}</span><button class="space-edit-btn rkpen" data-rk-act="room" aria-label="${esc(tr('rk_roomEdit'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button></div>
    <svg class="rkpsvg" viewBox="${-pad} ${-pad} ${W + pad * 2} ${D + pad * 2}" style="aspect-ratio:${(W + pad * 2) / (D + pad * 2)}">
      <rect x="0" y="0" width="${W}" height="${D}" class="fl"/>${units}
      ${wall('back', 0, 0, W, 0)}${wall('left', 0, 0, 0, D)}${wall('right', W, 0, W, D)}
      <line x1="0" y1="${D}" x2="${dl}" y2="${D}" class="front"/><line x1="${dr}" y1="${D}" x2="${W}" y2="${D}" class="front"/>
      <line x1="${dl}" y1="${D}" x2="${dr}" y2="${D}" class="door"/><text class="rkpdoor" x="${pl.door.x}" y="${D + pad * .75}" font-size="${fs * .75}">${tr('rk_door')}</text>${dims}
    </svg>${pl.issues.length ? `<p class="rkplanwarn">⚠ ${pl.issues.map(esc).join(' ')}</p>` : ''}</section>`;
}
let rkWallFocus = null;
/* drag a shelf unit in the plan, like a home planner: it snaps to the closest wall and never overlaps another unit */
let rkPP = null, rkPD = null, rkPlanSuppress = false;
function rkPlanPoint(svg, x, y){ const pt = svg.createSVGPoint(); pt.x = x; pt.y = y; const m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : {x: 0, y: 0}; }
function rkPlanRect(wall, at, sp, W){ return wall === 'back' ? {x: at, y: 0, w: sp.len, h: sp.dp} : wall === 'left' ? {x: 0, y: at, w: sp.dp, h: sp.len} : {x: W - sp.dp, y: at, w: sp.dp, h: sp.len}; }
const rkHits = (a, b) => a.x < b.x + b.w - .5 && b.x < a.x + a.w - .5 && a.y < b.y + b.h - .5 && b.y < a.y + a.h - .5;
function rkPlanFit(d, wall, want){
  const {sp, others, W, D} = d, max = (wall === 'back' ? W : D) - sp.len;
  if (max < 0) return null;
  const ok = at => at >= 0 && at <= max && !others.some(o => rkHits(rkPlanRect(wall, at, sp, W), o));
  const cands = [Math.round(want / 5) * 5, want, 0, max];
  others.forEach(o => { const [a, b] = wall === 'back' ? [o.x, o.x + o.w] : [o.y, o.y + o.h]; cands.push(a - sp.len, b, Math.floor((a - sp.len) / 5) * 5, Math.ceil(b / 5) * 5); });
  const good = cands.map(c => Math.max(0, Math.min(max, c))).filter(ok).sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  return good.length ? Math.round(good[0]) : null;
}
function rkPlanStart(g, e){
  const svg = g.ownerSVGElement, p = findPlace(currentPlace), pl = rkPlan(p), sp = pl.spots.find(x => x.u.id === g.dataset.rkJump); if (!sp) return;
  rkPD = {g, svg, pid: currentPlace, sp, W: pl.W, D: pl.D, others: pl.spots.filter(x => x !== sp).map(x => ({x: x.x, y: x.y, w: x.w, h: x.h})), all: pl.spots, wall: sp.wall, at: sp.at, ok: true, moved: false, sx: e.clientX, sy: e.clientY};
  g.classList.add('drag'); g.parentNode.appendChild(g); document.body.classList.add('dragging-on');
  if (navigator.vibrate) navigator.vibrate(12);
}
function rkPlanMove(x, y){
  const d = rkPD, q = rkPlanPoint(d.svg, x, y), {W, D, sp} = d;
  const dist = {left: Math.abs(q.x), right: Math.abs(W - q.x), back: Math.abs(q.y)};
  const wall = Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0];
  const want = Math.round(((wall === 'back' ? q.x : q.y) - sp.len / 2) / 5) * 5;
  const at = rkPlanFit(d, wall, want), free = at !== null;
  const r = rkPlanRect(wall, free ? at : Math.max(0, Math.min((wall === 'back' ? W : D) - sp.len, want)), sp, W);
  const rect = d.g.querySelector('rect'), txt = d.g.querySelector('text'), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  rect.setAttribute('x', r.x); rect.setAttribute('y', r.y); rect.setAttribute('width', r.w); rect.setAttribute('height', r.h);
  txt.setAttribute('x', cx); txt.setAttribute('y', cy); if (r.h > r.w) txt.setAttribute('transform', `rotate(-90 ${cx} ${cy})`); else txt.removeAttribute('transform');
  d.g.classList.toggle('bad', !free);
  const info = d.svg.querySelector('.rkpinfo'); if (info) info.textContent = free ? tr('rk_planAt', rkWallLabel(wall), at) : tr('rk_planNoRoom');
  if (free && (wall !== d.wall || at !== d.at) && navigator.vibrate) navigator.vibrate(4);
  Object.assign(d, {wall, at: free ? at : d.at, ok: free});
}
function rkPlanEnd(drop){
  const d = rkPD; rkPD = null; document.body.classList.remove('dragging-on'); if (!d) return;
  if (!drop || !d.moved || !d.ok){ if (d.moved && !d.ok) toast(tr('rk_planNoRoom')); return render(); }
  const p = findPlace(d.pid), prev = clone(p.units || []);
  p.units = (p.units || []).map(u => { const sp = d.all.find(x => x.u.id === u.id), nu = Object.assign({}, u, {at: sp ? Math.round(sp.at) : u.at}); if (u.id === d.sp.u.id){ nu.wall = d.wall; nu.at = d.at; } return nu; });
  metaPut('places', places).catch(() => {}); render();
  toastAction(tr('rk_planMoved', d.sp.u.name, rkWallLabel(d.wall).toLowerCase()), tr('undo'), () => { p.units = prev; metaPut('places', places).catch(() => {}); render(); });
}
app.addEventListener('pointerdown', e => {
  if (e.button > 0 || placeView !== 'racks') return;
  const g = e.target.closest('.rkpu'); if (!g) return;
  rkPP = {g, x: e.clientX, y: e.clientY, t: setTimeout(() => { if (!rkPP) return; rkPlanStart(rkPP.g, {clientX: rkPP.x, clientY: rkPP.y}); }, HOLD_MS)};
});
document.addEventListener('pointermove', e => {
  if (rkPP && !rkPD && Math.hypot(e.clientX - rkPP.x, e.clientY - rkPP.y) > SLOP){ clearTimeout(rkPP.t); rkPP = null; return; }
  if (!rkPD) return;
  if (!rkPD.moved && Math.hypot(e.clientX - rkPD.sx, e.clientY - rkPD.sy) > 4) rkPD.moved = true;
  if (rkPD.moved) rkPlanMove(e.clientX, e.clientY);
}, {passive: true});
document.addEventListener('touchmove', e => { if (rkPD) e.preventDefault(); }, {passive: false});
document.addEventListener('pointerup', () => {
  if (rkPP) clearTimeout(rkPP.t); rkPP = null;
  if (rkPD){ const moved = rkPD.moved; if (moved){ rkPlanSuppress = true; setTimeout(() => { rkPlanSuppress = false; }, 400); } rkPlanEnd(true); }
});
document.addEventListener('pointercancel', () => { if (rkPP) clearTimeout(rkPP.t); rkPP = null; if (rkPD) rkPlanEnd(false); });
function rkJump(sel){ setTimeout(() => { const el = app.querySelector(sel); if (!el) return; el.scrollIntoView({behavior: 'smooth', block: 'start'}); el.classList.add('rkflash'); setTimeout(() => el.classList.remove('rkflash'), 1400); }, 30); }
function rkRoomSheet(pid){
  const p = findPlace(pid), r = rkRoomOf(p), units = p.units || [];
  openSheet(`<h3>${tr('rk_roomEdit')}</h3>
    <div class="row2"><label class="field"><span>${tr('rk_roomW')}</span><input id="rmW" type="number" inputmode="numeric" value="${r.w}"></label>
    <label class="field"><span>${tr('rk_roomD')}</span><input id="rmD" type="number" inputmode="numeric" value="${r.d}"></label></div>
    <div class="field"><span>${tr('rk_door')}</span><div class="seg small" id="rmDoor">${['left', 'mid', 'right'].map(k => `<button class="${r.door === k ? 'on' : ''}" data-v="${k}">${tr('rk_door_' + k)}</button>`).join('')}</div></div>
    <label class="field"><span>${tr('rk_doorW')}</span><input id="rmDW" type="number" inputmode="numeric" value="${r.doorW}"></label>
    <label class="rkrule"><input type="checkbox" id="rmM" ${r.measured ? 'checked' : ''}><span><b>${tr('rk_roomMeasured')}</b><small>${tr('rk_roomMeasuredHint')}</small></span></label>
    ${units.length ? `<h3 style="margin-top:16px">${tr('rk_unitsInRoom')}</h3><p class="hint">${tr('rk_cornerHint')}</p>
    ${units.map(u => `<div class="rkroomu"><b>${esc(u.name)} <small>${u.width} cm</small></b><div class="rkdims">
      <label class="field"><span>${tr('rk_wall')}</span><select data-ru="${esc(u.id)}" data-k="wall">${RK_WALLS.map(w => `<option value="${w}" ${u.wall === w ? 'selected' : ''}>${rkWallLabel(w)}</option>`).join('')}</select></label>
      <label class="field"><span>${tr('rk_fromCorner')}</span><input data-ru="${esc(u.id)}" data-k="at" type="number" inputmode="numeric" placeholder="${tr('rk_auto')}" value="${u.at !== undefined && u.at !== null ? esc(u.at) : ''}"></label>
      <label class="field"><span>${tr('rk_depth')}</span><input data-ru="${esc(u.id)}" data-k="depth" type="number" inputmode="numeric" value="${u.depth || 40}"></label></div></div>`).join('')}` : ''}
    <div class="sheet-foot"><button class="btn quiet" id="rmX">${tr('cancel')}</button><button class="btn primary" id="rmOk">${tr('save')}</button></div>`);
  let door = r.door;
  $('#rmDoor').onclick = e => { const t = e.target.closest('[data-v]'); if (!t) return; door = t.dataset.v; sheet.querySelectorAll('#rmDoor [data-v]').forEach(x => x.classList.toggle('on', x === t)); };
  $('#rmX').onclick = closeSheet;
  $('#rmOk').onclick = () => {
    const w = parseInt($('#rmW').value, 10), d = parseInt($('#rmD').value, 10), dw = parseInt($('#rmDW').value, 10);
    if (!(w >= 50 && w <= 2000 && d >= 50 && d <= 2000 && dw >= 50 && dw <= 300)) return toast(tr('rk_roomBad'));
    const next = units.map(u => Object.assign({}, u));
    for (const el of sheet.querySelectorAll('[data-ru]')){
      const u = next.find(x => x.id === el.dataset.ru), k = el.dataset.k, v = el.value.trim();
      if (k === 'wall') u.wall = v;
      else if (k === 'at'){ if (v === '') delete u.at; else { const n = parseInt(v, 10); if (!(n >= 0 && n <= 2000)) return toast(tr('rk_roomBad')); u.at = n; } }
      else { const n = parseInt(v, 10); if (!(n >= 10 && n <= 200)) return toast(tr('rk_roomBad')); u.depth = n; }
    }
    p.room = {w, d, door, doorW: dw, measured: $('#rmM').checked}; p.units = next;
    metaPut('places', places).catch(() => {}); closeSheet(); render();
  };
}
function rkTileFor(e){
  if (e.kind === 'box') return `<div class="rkt" data-rk-ek="b:${esc(e.b.id)}">${shelfTile(e.b).replace(/ data-lp="[^"]*"/, '')}</div>`;
  return `<div class="rkt" data-rk-ek="i:${esc(e.it.id)}">${tokenHTML(e.it, e.l, {lp: false})}</div>`;
}
function rkTiles(u, data){
  const {ents, grid} = data;
  let rows = '';
  for (let s = u.shelves - 1; s >= 0; s--){
    const shelf = grid[u.id][s] || [];
    rows += `<div class="rkrow" data-rk-shelf data-rk-u="${esc(u.id)}" data-rk-s="${s}"><span class="rkn" aria-label="${esc(tr('rk_shelfN', s + 1))}">${s + 1}</span>
      ${shelf.map((col, c) => `<div class="rkcol tiles" data-rk-col data-rk-c="${c}">${[...col].reverse().map(k => rkTileFor(ents.get(k))).join('')}</div>`).join('')}
      <button class="itile add rkadd" data-rk-add data-rk-u="${esc(u.id)}" data-rk-s="${s}" aria-label="${esc(tr('rk_addOn', u.name, rkShelfWord(s, u.shelves)))}"><span class="timg">${PLUS_SVG}</span></button></div>${rkQuestion(u, s, data, false)}`;
  }
  return rows;
}
function rkAvail(){ return Math.min(app.clientWidth || 360, 560) - 32; }
function racksHTML(pid){
  if (rkMode === 'tidy') return rkTidyHTML(pid);
  const data = rkGrid(pid), {units, ents, unplaced} = data;
  const n = rkSize === 'M' ? 2 : 1, cardW = (rkAvail() - (n - 1) * 10) / n;
  const sizeSeg = `<div class="seg small" role="group" aria-label="${esc(tr('rk_sizeL'))}">${[['S', 'rk_small'], ['M', 'rk_medium'], ['L', 'rk_large']].map(([v, k]) => `<button class="${rkSize === v ? 'on' : ''}" data-rk-size="${v}">${tr(k)}</button>`).join('')}</div>`;
  const bar = `<div class="rkbar">${sizeSeg}${rkSize !== 'S' ? `<button class="btn quiet small${rkMeasure ? ' on' : ''}" data-rk-act="measure" aria-pressed="${rkMeasure}">📏 ${tr('rk_measure')}</button>` : ''}${units.length ? `<button class="btn quiet small" data-rk-act="tidy">${tr('rk_tidy')} ›</button>` : ''}</div>
    ${rkMeasure && rkSize !== 'S' ? `<p class="maphint">${tr('rk_measureHint')}</p>` : ''}`;
  const un = units.length ? `<section class="rkun${unplaced.length ? '' : ' empty'}" data-rk-unplaced="1"><div class="lhead"><b>${tr('rk_unplaced')}</b><span class="zcount">${unplaced.length || ''}</span>${unplaced.length ? `<button class="linkbtn" data-rk-act="auto">${tr('rk_autoPlace')} ›</button>` : ''}</div>
    ${unplaced.length ? `<div class="lstrip rkstrip">${unplaced.map(k => rkTileFor(ents.get(k))).join('')}</div>` : `<p class="maphint">${tr('rk_unplacedEmpty')}</p>`}</section>` : '';
  if (!units.length) return bar + rkPlanHTML(pid) + `<div class="rkempty"><p class="hint">${tr('rk_empty')}</p><div class="sheet-foot" style="justify-content:flex-start"><button class="btn primary" data-rk-act="quick">${tr('rk_quick')}</button><button class="btn quiet" data-rk-act="addunit">+ ${tr('rk_addUnit')}</button></div></div>`;
  const walls = RK_WALLS.map(w => {
    const list = units.filter(u => u.wall === w); if (!list.length) return '';
    return `<h2 class="section rkwallh" id="rkw-${w}">${rkWallLabel(w)}</h2><div class="rkgrid" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${list.map(u => {
      const cnt = (data.grid[u.id] || []).reduce((a, sh) => a + sh.reduce((x, c) => x + c.length, 0), 0);
      return `<div class="rkcard${rkSize === 'S' ? ' tiles' : ''}" id="rku-${esc(u.id)}"><div class="rkhead"><span><b>${esc(u.name)}</b><small>${esc(tr('rk_unitMeta', u.width, u.shelves, cnt))}</small></span><button class="space-edit-btn" data-rk-edit="${esc(u.id)}" aria-label="${esc(tr('rk_editUnit'))} ${esc(u.name)}">⋯</button></div>
        ${rkSize === 'S' ? rkTiles(u, data) : rkDraw(u, data, cardW - 16, {measure: rkMeasure})}</div>`;
    }).join('')}</div>`;
  }).join('');
  return bar + rkPlanHTML(pid) + `<p class="maphint">${tr('rk_dragHint')}</p>` + un + `<div class="racks">${walls}</div><button class="btn quiet block" data-rk-act="addunit">+ ${tr('rk_addUnit')}</button>`;
}

/* --- shelf units --- */
function rkUnitSheet(pid, uid, presetWall){
  const p = findPlace(pid), u = uid ? rkUnits(pid).find(x => x.id === uid) : null;
  const letter = String.fromCharCode(65 + rkUnits(pid).length % 26);
  const v = u || {name: tr('rk_unitName', letter), wall: presetWall || 'left', width: 90, shelves: 4, gap: 45};
  openSheet(`<h3>${u ? tr('rk_editUnit') : tr('rk_addUnit')}</h3>
    <label class="field"><span>${tr('name')}</span><input id="rkN" value="${esc(v.name)}"></label>
    <label class="field"><span>${tr('rk_wall')}</span><select id="rkW">${RK_WALLS.map(w => `<option value="${w}" ${v.wall === w ? 'selected' : ''}>${rkWallLabel(w)}</option>`).join('')}</select></label>
    <div class="rkdims"><label class="field"><span>${tr('rk_width')}</span><input id="rkWi" type="number" inputmode="numeric" value="${v.width}"></label>
    <label class="field"><span>${tr('rk_shelves')}</span><input id="rkS" type="number" inputmode="numeric" value="${v.shelves}"></label>
    <label class="field"><span>${tr('rk_gap')}</span><input id="rkG" type="number" inputmode="numeric" value="${v.gap}"></label></div>
    ${u && u.gaps ? `<p class="hint">${esc(tr('rk_gapsNote', u.gaps.map((g, i) => g !== u.gap ? `${tr('rk_shelfN', i + 1)}: ${g} cm` : '').filter(Boolean).join(', ')))}</p>` : ''}
    <label class="rkrule"><input type="checkbox" id="rkM" ${v.measured ? 'checked' : ''}><span><b>${tr('rk_measured')}</b><small>${tr('rk_measuredHint')}</small></span></label>
    <div class="sheet-foot">${u ? `<button class="btn danger" id="rkDel">${tr('rk_delUnit')}</button><span class="spacer"></span>` : ''}<button class="btn quiet" id="rkX">${tr('cancel')}</button><button class="btn primary" id="rkOk">${u ? tr('save') : tr('add')}</button></div>`);
  $('#rkX').onclick = closeSheet;
  $('#rkOk').onclick = () => {
    const measured = $('#rkM').checked;
    const name = $('#rkN').value.trim() || v.name, wall = $('#rkW').value, width = parseInt($('#rkWi').value, 10), shelves = parseInt($('#rkS').value, 10), gap = parseInt($('#rkG').value, 10);
    if (!(width >= 30 && width <= 400 && shelves >= 1 && shelves <= 8 && gap >= 15 && gap <= 150)) return toast(tr('rk_badSize'));
    const units = (p.units || []).slice();
    if (u){ const i = units.findIndex(x => x.id === u.id), nu = Object.assign({}, u, {name, wall, width, shelves, gap, measured});
      if (gap !== u.gap || shelves !== u.shelves) delete nu.gaps;
      if (width !== u.width || gap !== u.gap || shelves !== u.shelves || measured !== !!u.measured) delete nu.ok;
      units[i] = nu; }
    else units.push({id: newId(), name, wall, width, shelves, gap, measured});
    p.units = units; metaPut('places', places).catch(() => {});
    closeSheet(); render();
  };
  if (u) $('#rkDel').onclick = async () => {
    const data = rkGrid(pid), cnt = (data.grid[u.id] || []).reduce((a, sh) => a + sh.reduce((x, c) => x + c.length, 0), 0);
    if (!(await askConfirm(tr('rk_delUnitQ', cnt), tr('rk_delUnit')))) return rkUnitSheet(pid, uid);
    const grid = data.grid; delete grid[u.id];
    p.units = (p.units || []).filter(x => x.id !== u.id); metaPut('places', places).catch(() => {});
    closeSheet(); rkCommit(pid, grid);
  };
}
function rkQuick(pid){
  const p = findPlace(pid);
  p.units = RK_WALLS.map((w, i) => ({id: newId(), name: tr('rk_unitName', String.fromCharCode(65 + i)), wall: w, width: 90, shelves: 4, gap: 45}));
  metaPut('places', places).catch(() => {}); render();
}
function rkAddSheet(pid, uid, s){
  const u = rkUnits(pid).find(x => x.id === uid); if (!u) return;
  openSheet(`<h3>${esc(tr('rk_addOn', u.name, rkShelfWord(s, u.shelves)))}</h3>
    <div class="choice"><button class="btn primary big" id="rkAB">${ICON.box}<span>${tr('boxStorage')}</span></button><button class="btn primary big" id="rkAI">${ICON.star}<span>${tr('itemNoBox')}</span></button></div>
    <div class="sheet-foot" style="margin-top:12px"><button class="btn quiet" id="rkAX">${tr('cancel')}</button></div>`);
  const at = () => { const {grid} = rkGrid(pid); return {u: uid, s, x: (grid[uid][s] || []).length, l: 0}; };
  $('#rkAB').onclick = () => { closeSheet(); boxSheet(null, pid, null, null, at()); };
  $('#rkAI').onclick = () => { closeSheet(); newItem(ensureLoose(pid).id); if (itemEdit && itemEdit.isNew) rkPendingItem = {id: itemEdit.itemId, pid, pos: at()}; };
  $('#rkAX').onclick = closeSheet;
}
/* a thing added from a shelf gets its spot once it has been saved */
function rkPlacePending(pid){
  const pi = rkPendingItem; if (!pi || pi.pid !== pid || (itemEdit && itemEdit.itemId === pi.id)) return;
  rkPendingItem = null;
  const l = looseOf(pid), it = l && (l.items || []).find(i => i.id === pi.id); if (!it || it.shelf) return;
  const nl = clone(l); nl.items.find(i => i.id === pi.id).shelf = pi.pos; putBox(nl, true);
}

/* --- drag: hold, move, drop (same feel as the map) --- */
let rkPress = null, rkDrag = null;
function rkHit(x, y){
  const el = document.elementsFromPoint(x, y).find(n => !n.closest('.toast, .dropline, .rkghost')); if (!el) return null;
  const out = el.closest('[data-rk-unplaced]');
  if (out){ const r = out.getBoundingClientRect(); return {type: 'out', line: {x: r.left, y: r.top, w: r.width, h: r.height}, area: true}; }
  const sh = el.closest('[data-rk-shelf]'); if (!sh) return null;
  const u = sh.dataset.rkU, s = +sh.dataset.rkS, sr = sh.getBoundingClientRect();
  const colEl = el.closest('[data-rk-col]'), drag = rkDrag;
  if (colEl && sh.contains(colEl)){
    const r = colEl.getBoundingClientRect(), mine = [...colEl.querySelectorAll('[data-rk-ek]')].every(n => n.dataset.rkEk === drag.ek);
    if (!mine && Math.min(x - r.left, r.right - x) > r.width * .22){
      const top = [...colEl.querySelectorAll('[data-rk-ek]')].reduce((m, n) => Math.min(m, n.getBoundingClientRect().top), r.bottom);
      return {type: 'stack', u, s, c: +colEl.dataset.rkC, line: {x: r.left - 2, y: top - 4, w: r.width + 4, h: 3}};
    }
  }
  const cols = [...sh.querySelectorAll('[data-rk-col]')];
  const idx = cols.filter(c => { const r = c.getBoundingClientRect(); return r.left + r.width / 2 < x; }).length;
  const lx = cols[idx] ? cols[idx].getBoundingClientRect().left - 3 : cols[idx - 1] ? cols[idx - 1].getBoundingClientRect().right + 1 : sr.left + 4;
  return {type: 'insert', u, s, idx, line: {x: lx, y: sr.top + 3, w: 3, h: Math.max(28, sr.height - 6)}};
}
function rkStart(src, e){
  const r = src.getBoundingClientRect(), ghost = src.cloneNode(true); ghost.classList.add('rkghost');
  Object.assign(ghost.style, {left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'});
  const line = document.createElement('div'); line.className = 'dropline'; line.hidden = true;
  document.body.append(ghost, line); src.classList.add('dragging'); document.body.classList.add('dragging-on');
  rkDrag = {ek: src.dataset.rkEk, pid: currentPlace, src, ghost, line, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, moved: false, target: null};
  if (navigator.vibrate) navigator.vibrate(12);
  const tb = ($('.topbar') || {getBoundingClientRect: () => ({bottom: 0})}).getBoundingClientRect().bottom;
  const loop = () => {
    if (!rkDrag) return;
    if (rkDrag.moved){
      const top = tb + 40, bottom = innerHeight - 62 - 40;
      if (rkDrag.y < top) window.scrollBy(0, -Math.min(14, (top - rkDrag.y) / 3)); else if (rkDrag.y > bottom) window.scrollBy(0, Math.min(14, (rkDrag.y - bottom) / 3));
      const st = document.elementFromPoint(rkDrag.x, rkDrag.y), sc = st && st.closest('.rkstrip');
      if (sc){ const sr = sc.getBoundingClientRect(); if (rkDrag.x < sr.left + 26) sc.scrollLeft -= 6; else if (rkDrag.x > sr.right - 26) sc.scrollLeft += 6; }
      rkUpdate();
    }
    rkDrag.raf = requestAnimationFrame(loop);
  };
  rkDrag.raf = requestAnimationFrame(loop);
}
function rkUpdate(){
  const d = rkDrag; if (!d) return;
  d.ghost.style.transform = `translate3d(${d.x - d.sx}px, ${d.y - d.sy}px, 0) scale(1.06)`;
  const hit = rkHit(d.x, d.y), key = hit ? [hit.type, hit.u, hit.s, hit.c, hit.idx].join('|') : '';
  if (key !== d.key && hit && navigator.vibrate) navigator.vibrate(5);
  d.key = key; d.target = hit;
  if (hit){ Object.assign(d.line.style, {left: hit.line.x + 'px', top: hit.line.y + 'px', width: hit.line.w + 'px', height: hit.line.h + 'px'}); d.line.classList.toggle('area', !!hit.area); }
  d.line.hidden = !hit;
}
function rkEnd(drop){
  const d = rkDrag; if (!d) return; rkDrag = null;
  cancelAnimationFrame(d.raf); d.ghost.remove(); d.line.remove(); d.src.classList.remove('dragging'); document.body.classList.remove('dragging-on');
  if (drop && d.target) rkDrop(d.ek, d.pid, d.target);
}
app.addEventListener('pointerdown', e => {
  if (e.button > 0 || placeView !== 'racks' || rkMode !== 'shelves') return;
  const c = e.target.closest('[data-rk-ek]'); if (!c) return;
  rkPress = {c, x: e.clientX, y: e.clientY, t: setTimeout(() => { if (!rkPress) return; rkStart(rkPress.c, {clientX: rkPress.x, clientY: rkPress.y}); }, HOLD_MS)};
});
document.addEventListener('pointermove', e => {
  if (rkPress && !rkDrag && Math.hypot(e.clientX - rkPress.x, e.clientY - rkPress.y) > SLOP){ clearTimeout(rkPress.t); rkPress = null; return; }
  if (!rkDrag) return;
  rkDrag.x = e.clientX; rkDrag.y = e.clientY;
  if (!rkDrag.moved && Math.hypot(e.clientX - rkDrag.sx, e.clientY - rkDrag.sy) > 6) rkDrag.moved = true;
  if (rkDrag.moved) rkUpdate();
}, {passive: true});
document.addEventListener('touchmove', e => { if (rkDrag) e.preventDefault(); }, {passive: false});
document.addEventListener('pointerup', () => {
  if (rkPress) clearTimeout(rkPress.t);
  if (rkDrag){
    const d = rkDrag; lpFired = true; setTimeout(() => { lpFired = false; }, 400);
    if (!d.moved){ rkEnd(false); const [kind, id] = [d.ek.slice(0, 1), d.ek.slice(2)]; if (kind === 'b') lpMenu('box:' + id); else { const l = looseOf(d.pid); if (l) lpMenu(`item:${l.id}:${id}`); } }
    else rkEnd(true);
  }
  rkPress = null;
});
document.addEventListener('pointercancel', () => { if (rkPress) clearTimeout(rkPress.t); rkPress = null; if (rkDrag) rkEnd(false); });

/* --- tidy up: suggestions from simple rules --- */
const RK_SEASON_MONTHS = {christmas: [9, 10, 11], easter: [1, 2, 3], winter: [9, 10, 11, 0, 1], summer: [4, 5, 6, 7]};
const rkUpcoming = s => !!s && RK_SEASON_MONTHS[s] && RK_SEASON_MONTHS[s].includes(new Date().getMonth());
function rkProps(e){
  const own = e.kind === 'box' ? (e.b.tidy || {}) : {};
  const names = e.kind === 'box' ? [e.b.name, ...(e.b.items || []).map(i => i.name)] : [e.it.name];
  const seasons = e.kind === 'box' ? (e.b.items || []).map(i => i.season) : [e.it.season];
  const t = names.filter(Boolean).join(' ').toLowerCase();
  const w = /verktyg|tool|borr|drill|hammare|hammer|färg|paint|bok|böcker|book|album|pärm|binder|kakel|tile|hantel|dumbbell|skruv|screw|spik|nail|porslin|china/.test(t) ? 'heavy'
    : /kabel|kablar|cable|camping|tält|tent|jul|christmas|vinter|winter|skid|ski|kök|kitchen|spel|game|pussel|puzzle|skor|shoe|stövl|boot/.test(t) ? 'medium' : 'light';
  const fragile = /glas|glass|porslin|porcelain|china|julkul|bauble|lampa|lamp|ljusstake|candle|telefon|phone|vas|vase|tavl|spegel|mirror|ägg|egg|figur/.test(t);
  let season = /jul|christmas|advent/.test(t) ? 'christmas' : /påsk|easter/.test(t) ? 'easter' : /vinter|winter|skid|ski|pulka|sled/.test(t) ? 'winter' : /sommar|summer|camping|tält|tent|bad|beach|trädgård|garden/.test(t) ? 'summer' : '';
  if (!season){ const c = {Winter: 0, Summer: 0}; seasons.forEach(x => { if (c[x] !== undefined) c[x]++; }); if (c.Winter || c.Summer) season = c.Winter >= c.Summer ? 'winter' : 'summer'; }
  const lastUse = Math.min(e.kind === 'box' ? daysSince(e.b.openedAt) : Infinity, ...(e.kind === 'box' ? (e.b.items || []) : [e.it]).map(i => daysSince(i.lastUsed)));
  const use = lastUse <= 45 ? 'often' : lastUse !== Infinity && lastUse >= 180 ? 'rarely'
    : /verktyg|tool|kabel|cable|laddare|charger|skarvsladd|extension/.test(t) ? 'often' : /brev|letter|album|dagbok|diar|gamla|old |minne|keepsake|arkiv|archive|kvitto|receipt/.test(t) ? 'rarely' : 'sometimes';
  const g = {w, use, fragile, season};
  return {w: own.w || g.w, use: own.use || g.use, fragile: own.fragile !== undefined ? own.fragile : g.fragile, season: own.season !== undefined ? own.season : g.season, guessed: k => own[k] === undefined};
}
const rkZone = (s, n) => n === 1 ? 'mid' : s === 0 ? 'bottom' : s === n - 1 ? 'top' : 'mid';
function rkNear(units, pid){
  const pl = pid && rkPlan(findPlace(pid));
  if (pl && pl.spots.length){
    const dx = pl.door.x, D = pl.D, dist = {}; let max = 0;
    pl.spots.forEach(sp => { const d = Math.hypot(sp.x + sp.w / 2 - dx, sp.y + sp.h / 2 - D); dist[sp.u.id] = d; max = Math.max(max, d); });
    const r = {}; units.forEach(u => { r[u.id] = max ? 1 - (dist[u.id] || 0) / max : 1; }); return r;
  }
  const order = [], by = w => units.filter(u => u.wall === w);
  const L = by('left'), R = by('right'), B = by('back');
  for (let i = 0; i < Math.max(L.length, R.length); i++){ if (L[i]) order.push(L[i].id); if (R[i]) order.push(R[i].id); }
  B.forEach(u => order.push(u.id));
  const r = {}; order.forEach((id, i) => { r[id] = order.length > 1 ? 1 - i / (order.length - 1) : 1; }); return r;
}
function rkScore(p, u, s, near){
  const R = rkRules, z = rkZone(s, u.shelves), nr = near[u.id];
  const hot = p.use === 'often' || (R.season && rkUpcoming(p.season));
  let sc = 0;
  if (R.heavy) sc += p.w === 'heavy' ? {bottom: 4, mid: 1, top: -4}[z] : p.w === 'medium' ? {bottom: 1, mid: 1, top: 0}[z] : 0;
  if (R.reach && p.use === 'often') sc += {bottom: 0, mid: 3, top: -3}[z] + 2 * nr;
  if (R.season && p.season){ if (rkUpcoming(p.season)) sc += {bottom: 1, mid: 2, top: -2}[z] + 1.5 * nr; else sc += {bottom: -1, mid: -1, top: 2}[z] - nr; }
  if (R.top && !hot && (p.use === 'rarely' || p.w === 'light')) sc += {bottom: -1, mid: 0, top: 2}[z] - .5 * nr;
  return sc;
}
function rkWhy(p, z, wasPlaced){
  if (p.w === 'heavy' && z === 'bottom') return tr('rk_why_heavy');
  if (p.use === 'often' && z === 'mid') return tr('rk_why_reach');
  if (p.season && rkUpcoming(p.season) && z !== 'top') return tr('rk_why_seasonUp', tr('rk_' + p.season));
  if (p.season && !rkUpcoming(p.season) && z === 'top') return tr('rk_why_seasonOff');
  if (z === 'top') return tr('rk_why_top');
  return wasPlaced ? tr('rk_why_room') : tr('rk_why_place');
}
function rkPropose(pid){
  const data = rkGrid(pid), {units, ents, grid: cur} = data, near = rkNear(units, pid);
  const next = {}; units.forEach(u => { next[u.id] = Array.from({length: u.shelves}, () => []); });
  const where = {}; [...ents.keys()].forEach(k => { const w = rkWhere(units, cur, k); where[k] = w ? w.u.id + ':' + w.s : ''; });
  const props = new Map([...ents.values()].map(e => [e.k, rkProps(e)]));
  const prio = e => { const p = props.get(e.k); return (p.w === 'heavy' ? 3 : 0) + (p.use === 'often' ? 2 : 0) + (rkUpcoming(p.season) ? 1 : 0) + rkDims(e).w / 100 + (e.kind === 'box' ? .5 : 0); };
  const list = [...ents.values()].sort((a, c) => prio(c) - prio(a));
  const noRoom = [];
  list.forEach(e => {
    const p = props.get(e.k), d = rkDims(e); let best = null;
    units.forEach(u => next[u.id].forEach((sh, s) => {
      const fitsNew = rkUsedW(ents, sh) + d.w <= u.width && d.h <= rkGapOf(u, s);
      let col = -1;
      if (!fitsNew) sh.forEach((c, i) => { if (col >= 0) return; const fragileBelow = rkRules.fragile && c.some(k => props.get(k).fragile); if (!fragileBelow && rkColH(ents, c) + d.h <= rkGapOf(u, s) && d.w <= rkColW(ents, c)) col = i; });
      if (!fitsNew && col < 0) return;
      const sc = rkScore(p, u, s, near) + (where[e.k] === u.id + ':' + s ? .6 : 0) - (col >= 0 ? .8 : 0);
      if (!best || sc > best.sc) best = {sc, u, s, col};
    }));
    if (!best){ const w = rkWhere(units, cur, e.k); if (w) next[w.u.id][w.s].push([e.k]); else noRoom.push(e.k); return; }
    const sh = next[best.u.id][best.s]; if (best.col >= 0) sh[best.col].push(e.k); else sh.push([e.k]);
  });
  const xOf = k => { const q = ents.get(k).pos; return q && where[k] ? q.x : 999; };
  units.forEach(u => next[u.id].forEach(sh => sh.sort((a, c) => xOf(a[0]) - xOf(c[0]))));
  const steps = [...ents.keys()].filter(k => { const w = rkWhere(units, next, k); return (w ? w.u.id + ':' + w.s : '') !== where[k]; })
    .map(k => { const w = rkWhere(units, next, k); return {k, w, from: rkWhereText(units, cur, k), to: rkWhereText(units, next, k), why: w ? rkWhy(props.get(k), rkZone(w.s, w.u.shelves), !!where[k]) : ''}; })
    .sort((a, c) => (a.w ? a.w.s : 99) - (c.w ? c.w.s : 99));
  return {grid: next, steps, data, props, noRoom};
}
function rkIssues(units, grid, props){
  const iss = {heavy: 0, reach: 0, top: 0, season: 0, fragile: 0};
  units.forEach(u => (grid[u.id] || []).forEach((sh, s) => { const z = rkZone(s, u.shelves); sh.forEach(col => col.forEach((k, l) => {
    const p = props.get(k);
    if (p.w === 'heavy' && z !== 'bottom') iss.heavy++;
    if (p.use === 'often' && z !== 'mid') iss.reach++;
    if (p.use === 'rarely' && !rkUpcoming(p.season) && z !== 'top') iss.top++;
    if (p.season && (rkUpcoming(p.season) ? z === 'top' : z === 'mid')) iss.season++;
    if (p.fragile && l < col.length - 1) iss.fragile++;
  })); }));
  return iss;
}
function rkMini(u, data, grid, width, mark){
  const {ents} = data, inner = Math.max(40, width - 6), sc = inner / u.width;
  let rows = '';
  for (let s = u.shelves - 1; s >= 0; s--){
    rows += `<div class="rkmrow" style="min-height:${Math.round(rkGapOf(u, s) * sc)}px">${(grid[u.id][s] || []).map(col => `<div class="rkmcol">${col.map(k => { const d = rkDims(ents.get(k)), m = mark[k];
      return `<span class="rkm ${m ? 'move' : 'keep'}${ents.get(k).kind === 'item' ? ' round' : ''}" style="width:${Math.max(5, d.w * sc - 1).toFixed(1)}px;height:${Math.max(5, d.h * sc - 1).toFixed(1)}px;font-size:${Math.max(9, Math.min(18, d.h * sc * .32)).toFixed(0)}px">${m && d.w * sc >= 12 ? m : ''}</span>`; }).join('')}</div>`).join('')}</div><div class="rkplank thin"></div>`;
  }
  return `<div class="rkframe thin">${rows}</div>`;
}
function rkTidyHTML(pid){
  const P = rkPropose(pid), {data, props} = P, {units} = data; rkLastTidy = {pid, grid: P.grid};
  const mark = {}; P.steps.forEach((s, i) => { mark[s.k] = String(i + 1); });
  const det = rkTidyDetail, n = det ? 1 : 2, cardW = (rkAvail() - (n - 1) * 10) / n;
  const grid = rkTidyShow === 'after' ? P.grid : data.grid;
  const rules = ['heavy', 'reach', 'top', 'season', 'fragile'].map(k => `<label class="rkrule"><input type="checkbox" data-rk-rule="${k}" ${rkRules[k] ? 'checked' : ''}><span><b>${tr('rk_r_' + k)}</b>${det ? `<small>${tr('rk_r_' + k + 'D')}</small>` : ''}</span></label>`).join('');
  let table = '';
  if (det){ const a = rkIssues(units, data.grid, props), b = rkIssues(units, P.grid, props);
    table = `<table class="rktable"><thead><tr><th>${tr('rk_ruleCol')}</th><th>${tr('rk_nowCol')}</th><th>${tr('rk_afterCol')}</th></tr></thead><tbody>${Object.keys(a).filter(k => rkRules[k]).map(k => `<tr><td>${tr('rk_r_' + k)}</td><td>${a[k]}</td><td class="${b[k] < a[k] ? 'good' : ''}">${b[k]}</td></tr>`).join('')}</tbody></table>`; }
  const cards = units.map(u => `<div class="rkcard"><div class="rkhead"><span><b>${esc(u.name)}</b><small>${rkWallLabel(u.wall)}</small></span></div>${rkMini(u, data, grid, cardW - 16, mark)}</div>`).join('');
  const moves = P.steps.length ? `<ol class="rkmoves">${P.steps.map((s, i) => { const e = data.ents.get(s.k), p = props.get(s.k), d = rkDims(e);
      return `<li><span class="rkstep">${i + 1}</span><span><b>${esc(e.kind === 'box' ? `${e.b.code} ${e.b.name || ''}` : e.it.name || '')}</b><small>${tr('rk_to')}: ${esc(s.to)}</small>${det ? `<small>${tr('rk_from')}: ${esc(s.from)}</small><small>${d.w}×${d.h} cm · ${tr(p.w === 'heavy' ? 'rk_heavy' : p.w === 'medium' ? 'rk_mediumW' : 'rk_light')}${p.fragile ? ' · ' + tr('rk_fragileL').toLowerCase() : ''}</small>` : ''}<em>${esc(s.why)}</em></span></li>`; }).join('')}</ol>` : `<p class="hint">${tr('rk_nothing')}</p>`;
  const sel = (k, key, v, opts) => `<select data-rk-guess="${esc(k)}" data-rk-key="${key}" class="${props.get(k).guessed(key) ? 'g' : ''}">${opts.map(([ov, t]) => `<option value="${ov}" ${String(v) === String(ov) ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const boxEnts = [...data.ents.values()].filter(e => e.kind === 'box');
  const guesses = det ? `<details class="rkguess"><summary>${tr('rk_guesses', boxEnts.length)}</summary><p class="hint">${tr('rk_guessHint')}</p>${boxEnts.map(e => { const p = props.get(e.k);
      return `<div class="rkgrow"><b>${esc(e.b.code)} ${esc(e.b.name || '')}</b><div class="rkgsel">
        <label><span>${tr('rk_weight')}</span>${sel(e.k, 'w', p.w, [['light', tr('rk_light')], ['medium', tr('rk_mediumW')], ['heavy', tr('rk_heavy')]])}</label>
        <label><span>${tr('rk_use')}</span>${sel(e.k, 'use', p.use, [['often', tr('rk_often')], ['sometimes', tr('rk_sometimes')], ['rarely', tr('rk_rarely')]])}</label>
        <label><span>${tr('rk_fragileL')}</span>${sel(e.k, 'fragile', p.fragile, [['false', tr('rk_no')], ['true', tr('rk_yes')]])}</label>
        <label><span>${tr('rk_seasonL')}</span>${sel(e.k, 'season', p.season, [['', tr('rk_allYear')], ['christmas', tr('rk_christmas')], ['easter', tr('rk_easter')], ['winter', tr('rk_winter')], ['summer', tr('rk_summer')]])}</label></div></div>`; }).join('')}</details>` : '';
  return `<div class="rkbar"><button class="btn quiet small" data-rk-act="back">‹ ${tr('rk_view')}</button><div class="seg small"><button class="${det ? '' : 'on'}" data-rk-detail="0">${tr('rk_simple')}</button><button class="${det ? 'on' : ''}" data-rk-detail="1">${tr('rk_detailed')}</button></div></div>
    <p class="maphint">${tr('rk_tidyHint')}</p><div class="rkrules">${rules}</div>${det ? `<p class="maphint">${tr('rk_zones')}</p>` : ''}${guesses}
    ${table}
    <div class="rkbar"><div class="seg small"><button class="${rkTidyShow === 'before' ? 'on' : ''}" data-rk-show="before">${tr('rk_now')}</button><button class="${rkTidyShow === 'after' ? 'on' : ''}" data-rk-show="after">${tr('rk_after')}</button></div></div>
    <div class="rkgrid" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${cards}</div>
    <div class="legend rklegend"><span><i class="mv"></i>${tr('rk_toMove')}</span><span><i></i>${tr('rk_stays')}</span></div>
    ${P.noRoom.length ? `<p class="hint">${esc(tr('rk_noRoom', P.noRoom.length))}</p>` : ''}
    ${moves}
    <div class="sheet-foot" style="margin-top:14px"><button class="btn primary" data-rk-act="apply" ${P.steps.length ? '' : 'disabled'}>${tr('rk_moved')}</button></div>`;
}
app.addEventListener('click', e => {
  if (placeView !== 'racks') return;
  const pid = currentPlace;
  const sz = e.target.closest('[data-rk-size]'); if (sz){ rkSize = sz.dataset.rkSize; metaPut('rkSize', rkSize).catch(() => {}); return render(); }
  const ed = e.target.closest('[data-rk-edit]'); if (ed) return rkUnitSheet(pid, ed.dataset.rkEdit);
  const wj = e.target.closest('[data-rk-wall]'); if (wj){ const w = wj.dataset.rkWall; rkWallFocus = w; render(); if (rkUnits(pid).some(u => u.wall === w)) rkJump('#rkw-' + w); else rkUnitSheet(pid, null, w); return; }
  const uj = e.target.closest('[data-rk-jump]'); if (uj){ if (rkPlanSuppress){ rkPlanSuppress = false; return; } rkJump('#rku-' + uj.dataset.rkJump); return; }
  const q = e.target.closest('[data-rk-q]'); if (q) return rkAnswer(pid, q.dataset.rkQ, q.dataset.rkU, +q.dataset.rkS, q.dataset.rkK);
  const ad = e.target.closest('[data-rk-add]'); if (ad) return rkAddSheet(pid, ad.dataset.rkU, +ad.dataset.rkS);
  const dt = e.target.closest('[data-rk-detail]'); if (dt){ rkTidyDetail = dt.dataset.rkDetail === '1'; return render(); }
  const sh = e.target.closest('[data-rk-show]'); if (sh){ rkTidyShow = sh.dataset.rkShow; return render(); }
  const a = e.target.closest('[data-rk-act]'); if (!a) return;
  const k = a.dataset.rkAct;
  if (k === 'measure'){ rkMeasure = !rkMeasure; metaPut('rkMeasure', rkMeasure).catch(() => {}); return render(); }
  if (k === 'tidy' || k === 'auto'){ rkMode = 'tidy'; render(); window.scrollTo(0, 0); arm(); return; }
  if (k === 'back'){ rkMode = 'shelves'; return render(); }
  if (k === 'addunit') return rkUnitSheet(pid);
  if (k === 'room') return rkRoomSheet(pid);
  if (k === 'quick') return rkQuick(pid);
  if (k === 'apply' && rkLastTidy && rkLastTidy.pid === pid){ rkMode = 'shelves'; rkCommit(pid, rkLastTidy.grid, tr('rk_updated')); window.scrollTo(0, 0); }
});
app.addEventListener('change', e => {
  if (placeView !== 'racks') return;
  const r = e.target.closest('[data-rk-rule]'); if (r){ rkRules[r.dataset.rkRule] = r.checked; metaPut('rkRules', rkRules).catch(() => {}); return render(); }
  const g = e.target.closest('[data-rk-guess]'); if (g){
    const b = findBox(g.dataset.rkGuess.slice(2)); if (!b) return;
    const nb = clone(b), key = g.dataset.rkKey; let v = g.value; if (key === 'fragile') v = v === 'true';
    nb.tidy = Object.assign({}, nb.tidy, {[key]: v}); putBox(nb, true); render();
  }
});
app.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('[data-rk-wall],[data-rk-jump]')){ e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', {bubbles: true})); } });
let rkResizeT = null;
window.addEventListener('resize', () => { if (placeView !== 'racks') return; clearTimeout(rkResizeT); rkResizeT = setTimeout(() => { if (!rkDrag && !(sheet && sheet.open)) render(); }, 200); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
init();
})();
