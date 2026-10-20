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

const APP_VERSION = '2026-10-20.1';
let boxes = [], ready = false, lastBackup = null;
let household = [], me = '', notes = [];
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
const dbPut = b => tx('boxes', 'readwrite', s => s.put(b));
const dbDel = id => tx('boxes', 'readwrite', s => s.delete(id));
const phPut = (k, b) => tx('photos', 'readwrite', s => s.put(b, k));
const phGet = k => tx('photos', 'readonly', s => s.get(k));
const phDel = k => tx('photos', 'readwrite', s => s.delete(k));
const metaGet = k => tx('meta', 'readonly', s => s.get(k));
const metaPut = (k, v) => tx('meta', 'readwrite', s => s.put(v, k));
const noteAll = () => tx('notes', 'readonly', s => s.getAll());
const notePut = n => tx('notes', 'readwrite', s => s.put(n));
const noteDel = id => tx('notes', 'readwrite', s => s.delete(id));

/* ---------- helpers ---------- */
let toastTimer;
function toast(msg){
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role','status'); t.textContent = msg;
  document.body.appendChild(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3800);
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
const labelText = b => 'BOXES:id:' + b.id;
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
const saveErr = e => (e && e.name === 'QuotaExceededError') ? 'The phone is out of storage space for Storrrage.' : 'Couldn’t save that change. Try again.';


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
  const hay = [it.name, it.category, it.notes, (it.tags || []).join(' '), it.owner, it.spot, placeName(b.placeId), it.size ? 'size storlek ' + it.size : '',
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
  dbPut(clone(box)).catch(e => toast(saveErr(e)));
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
async function storePhoto(file){
  const takenAt = new Date(file.lastModified || Date.now()).toISOString();
  const cv = await shrink(file, PHOTO_MAX);
  let blob = await toBlob(cv, 'image/webp', PHOTO_QUALITY);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(cv, 'image/jpeg', .8);
  const ref = newId();
  await phPut(ref, blob);
  return {ref, takenAt, addedAt: new Date().toISOString()};
}
const urls = new Map();
async function photoURL(ref){
  if (urls.has(ref)) return urls.get(ref);
  const b = await phGet(ref).catch(() => null); if (!b) return '';
  const u = URL.createObjectURL(b); urls.set(ref, u); return u;
}
function hydrate(root = document){
  root.querySelectorAll('img[data-ph]:not([src])').forEach(async img => {
    const fail = () => { img.remove(); };
    img.onerror = fail;
    const u = await photoURL(img.dataset.ph); if (u) img.src = u; else fail();
  });
}
function refInUse(ref){
  return trash.some(t => (t.item.photos || []).some(p => p.ref === ref) || (t.item.files || []).some(f => f.ref === ref)) || boxes.some(b => (b.photo && b.photo.ref === ref) || (b.items || []).some(i => (i.photos || []).some(p => p.ref === ref) || (i.files || []).some(f => f.ref === ref)));
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
  old.forEach(t => { (t.item.photos || []).forEach(p => dropPhoto(p.ref)); (t.item.files || []).forEach(f => dropPhoto(f.ref)); });
}
function restoreTrash(id){
  const t = trash.find(x => x.id === id); if (!t) return;
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
  if ($('#trEmpty')) $('#trEmpty').onclick = () => askConfirm(tr('emptyTrashQ', trash.length), tr('emptyTrash')).then(y => { if (!y) return; const all = trash; trash = []; metaPut('trash', trash).catch(() => {}); all.forEach(t => { (t.item.photos || []).forEach(p => dropPhoto(p.ref)); (t.item.files || []).forEach(f => dropPhoto(f.ref)); }); trashSheet(); });
}
function dropPhoto(ref){
  if (!ref) return;
  setTimeout(() => {
    if (refInUse(ref) || (typeof batchRefs !== 'undefined' && batchRefs.has(ref))) return;
    phDel(ref).catch(() => {});
    if (urls.has(ref)){ URL.revokeObjectURL(urls.get(ref)); urls.delete(ref); }
  }, 300);
}
/* ---------- full-screen photo viewer with pinch and double-tap zoom ---------- */
const viewer = document.createElement('dialog');
viewer.id = 'viewer';
viewer.innerHTML = '<div class="vwrap"><img id="vImg" alt=""></div><button class="vclose" aria-label="Close photo">×</button><p class="vhint">Pinch or double-tap to zoom</p>';
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
    const u = await photoURL(ref); if (!u) return;
    img.src = u; reset(); pts.clear(); viewer.showModal();
  };
})();
const imgTag = (ref, cls, alt = '') => `<img class="${cls}" data-ph="${esc(ref)}" alt="${esc(alt)}">`;

/* ---------- language: Swedish or English for the whole app (item names never change) ---------- */
let lang = (navigator.language || '').toLowerCase().startsWith('sv') ? 'sv' : 'en';
const STR = {
  en: {
    space: 'SPACE', places_n: n => n === 1 ? '1 PLACE' : `${n} PLACES`, boxes_n: n => n === 1 ? '1 BOX' : `${n} BOXES`, items_n: n => n === 1 ? '1 ITEM' : `${n} ITEMS`,
    box_n: n => `BOX ${n}`, allPlaces: 'All places', addPlace: '+ Place', notInBox: 'Not in a box', notInBoxShort: 'not in a box',
    emptyPlace: 'Tap + to add a box, or something that isn’t in a box, like a bike.', addItem: 'Add item', addSeveral: 'Add several', item: 'item', items: 'items',
    editBox: 'Edit box', label: 'Label', findStuff: 'FIND YOUR STUFF!', typeKeyword: 'Type keyword', searchIn: 'Search in', everywhere: 'Everywhere', allOf: p => `All of ${p}`,
    boxesH: 'Boxes', similar: 'Similar things', noMatch: q => `Nothing matches “${q}”. Try another word, in Swedish or English.`, nothingHere: 'Nothing stored here yet.',
    welcome: 'Keep track of what’s stored where: boxes, things, photos and receipts. Find anything by searching or just asking.', yourName: 'Your name', getStarted: 'Get started',
    noAccount: 'No account needed for now. Everything stays on this phone.', writeName: 'Write your name first.',
    storrrage: 'STORRRAGE', profile: 'Profile', settings: 'Settings', notifications: 'Notifications', premium: 'Premium', version: v => `Storrrage version ${v}`,
    household: 'People in the household', addName: 'Add a name', add: 'Add', you: '(you)', remove: 'Remove', householdHint: 'Used for “whose is it” on items, and when talking to Storrrage (“Elsa’s boots”).', noOne: 'No one added yet.',
    aiAssistant: 'AI assistant', off: 'Off', storagePlaces: 'Storage places', backupNow: 'Back up now', never: 'Never', restore: 'Restore from backup', insurance: 'Insurance report',
    labelsAll: 'Labels for all boxes', scanLabel: 'Scan a box label', language: 'Language', usage: mb => `Everything is stored only on this phone. Storrrage uses about ${mb} MB.`,
    dueIntro: 'You haven’t used these for a while. Still worth keeping, or time to sell?', lastUsedOn: d => `Last used ${d}`, usedRecently: 'Used it recently', markSale: 'Mark for sale',
    nothingDue: 'Nothing needs your attention. On an item, set “Remind me if unused” to get a nudge when you haven’t used it in a while.',
    prem1: 'Share storage with your household', prem2: 'Sell on Blocket, Tradera and Vinted', prem3: 'Login and sync between phones', premLater: 'Coming later. Everything you use now is free.',
    whatIsIt: 'What is it?', whereIs: 'Where it is', addDetail: 'Add details', lastUsed: 'Last time used', remind: 'Remind me if unused', noRemind: 'No reminder',
    remindM: m => m === 12 ? 'After 1 year' : m === 24 ? 'After 2 years' : `After ${m} months`, notify: d => `notify ${d}`, attachments: 'Attachments', addAttach: '+ Add receipt, warranty or manual',
    tags: 'Tags', registered: (d, by) => `Registered ${d}${by ? ` by ${by}` : ''}.`, storedSince: d => `Stored since ${d}.`, changed: d => `Last changed ${d}.`,
    delItem: 'Delete item', done: 'Done', save: 'Save', saveAnother: 'Save + add another', saved: 'Saved.', savedNext: n => `${n} saved. Add the next one.`, nameFirst: 'Give it a name first.',
    f_size: 'Size', f_brand: 'Brand', f_value: 'Price / value (kr)', f_model: 'Model', f_qty: 'Quantity', f_owner: 'Whose & status', f_color: 'Colour', f_season: 'Season', f_serial: 'Serial number',
    f_category: 'Category', f_spot: 'Where exactly', f_notes: 'Notes', whose: 'Whose is it', status: 'Status', loanTo: 'Lent to whom', shared: 'Shared',
    st_store: 'In storage', st_loan: 'On loan', st_sale: 'For sale', st_sold: 'Sold', st_given: 'Given away',
    addTo: p => `Add to ${p}`, boxStorage: 'Box / storage', itemNoBox: 'Item without a box', severalPhotos: 'Several items from photos', cancel: 'Cancel', close: 'Close', ok: 'OK',
    moveX: n => `Move ${n}`, to: 'To', move: 'Move', movedTo: w => `Moved to ${w}.`, rename: 'Rename', del: 'Delete', edit: 'Edit', moveToPlace: 'Move to place', emptyFirst: 'Empty this place to delete it.',
    delQ: n => `Delete “${n}”? This can’t be undone.`, delNoteQ: 'Delete this voice note?', rmPhotoQ: 'Remove this photo?', rmQ: n => `Remove “${n}”?`, rmTagQ: n => `Remove the tag “${n}”?`,
    newPlace: 'New storage place', newPlaceHint: 'For example Basement, Vinden or Garaget', renameX: n => `Rename ${n}`, newTag: 'Add a tag', tagHint: 'For example hiking or winter',
    backupBanner: d => d ? `Last backup was ${d}. Everything is stored only on this phone, so keep a copy somewhere else.` : 'You haven’t made a backup yet. Everything is stored only on this phone, so keep a copy somewhere else.',
    voiceNotes: 'Voice notes', voiceNotesBox: 'Voice notes for this box', menu: 'Menu', allSettings: 'All settings', usedNoted: 'Noted. The reminder starts over.', markedSale: 'Marked for sale.',
    placesHint: 'For example the basement storage unit, the attic, the garage or the summer house. Only a name is stored, never an address.', placeNameHint: 'Name, e.g. Vinden',
    fileMissing: 'That file is missing.', savingPhoto: 'Saving photo…', unnamed: 'Unnamed',
    batchTitle: 'Add several items', batchWhere: w => `They’ll go into ${w}.`, modeEach: 'One photo per item', modeEachHint: 'Take or pick a photo of each thing.',
    modeMulti: 'Several items in one photo', modeMultiHint: 'Lay things out and take one photo. Each thing becomes its own item.',
    batchAI: 'AI will suggest names and details from the photos. You check them before adding.', batchNoAI: 'Turn on the AI assistant to get names and details suggested automatically. Without it you name each item yourself.',
    batchPrivacy: 'Photos are sent to the AI service to be recognised.', thinking: 'Recognising…', aiFailed: e => `Couldn’t recognise: ${e}`, addN: n => n === 1 ? 'Add 1 item' : `Add ${n} items`,
    batchAdded: n => n === 1 ? 'Added 1 item.' : `Added ${n} items.`, namePh: 'Name', include: 'Include', morePhotos: '+ More photos', noneYet: 'No photos yet.', batchFound: n => n === 1 ? 'Found 1 thing.' : `Found ${n} things.`,
  },
  sv: {
    space: 'FÖRVARING', places_n: n => n === 1 ? '1 PLATS' : `${n} PLATSER`, boxes_n: n => n === 1 ? '1 LÅDA' : `${n} LÅDOR`, items_n: n => n === 1 ? '1 SAK' : `${n} SAKER`,
    box_n: n => `LÅDA ${n}`, allPlaces: 'Alla platser', addPlace: '+ Plats', notInBox: 'Utan låda', notInBoxShort: 'utan låda',
    emptyPlace: 'Tryck på + för att lägga till en låda, eller något som inte ligger i en låda, som en cykel.', addItem: 'Lägg till sak', addSeveral: 'Lägg till flera', item: 'sak', items: 'saker',
    editBox: 'Ändra låda', label: 'Etikett', findStuff: 'HITTA DINA GREJER!', typeKeyword: 'Skriv ett sökord', searchIn: 'Sök i', everywhere: 'Överallt', allOf: p => `Hela ${p}`,
    boxesH: 'Lådor', similar: 'Liknande saker', noMatch: q => `Inget matchar ”${q}”. Prova ett annat ord, på svenska eller engelska.`, nothingHere: 'Inget sparat här än.',
    welcome: 'Håll koll på vad som förvaras var: lådor, saker, foton och kvitton. Hitta allt genom att söka eller bara fråga.', yourName: 'Ditt namn', getStarted: 'Kom igång',
    noAccount: 'Inget konto behövs just nu. Allt stannar på den här telefonen.', writeName: 'Skriv ditt namn först.',
    storrrage: 'STORRRAGE', profile: 'Profil', settings: 'Inställningar', notifications: 'Notiser', premium: 'Premium', version: v => `Storrrage version ${v}`,
    household: 'Personer i hushållet', addName: 'Lägg till ett namn', add: 'Lägg till', you: '(du)', remove: 'Ta bort', householdHint: 'Används för ”vems är det” på saker, och när du pratar med Storrrage (”Elsas kängor”).', noOne: 'Ingen tillagd än.',
    aiAssistant: 'AI-assistent', off: 'Av', storagePlaces: 'Förvaringsplatser', backupNow: 'Säkerhetskopiera nu', never: 'Aldrig', restore: 'Återställ från säkerhetskopia', insurance: 'Försäkringsrapport',
    labelsAll: 'Etiketter för alla lådor', scanLabel: 'Skanna en etikett', language: 'Språk', usage: mb => `Allt sparas bara på den här telefonen. Storrrage använder ungefär ${mb} MB.`,
    dueIntro: 'Du har inte använt de här på ett tag. Värda att behålla, eller dags att sälja?', lastUsedOn: d => `Senast använd ${d}`, usedRecently: 'Använt nyligen', markSale: 'Markera till salu',
    nothingDue: 'Inget behöver din uppmärksamhet. Välj ”Påminn om oanvänd” på en sak för att få en knuff när du inte använt den på ett tag.',
    prem1: 'Dela förvaring med hushållet', prem2: 'Sälj på Blocket, Tradera och Vinted', prem3: 'Inloggning och synk mellan telefoner', premLater: 'Kommer senare. Allt du använder nu är gratis.',
    whatIsIt: 'Vad är det?', whereIs: 'Var den finns', addDetail: 'Lägg till detaljer', lastUsed: 'Senast använd', remind: 'Påminn om oanvänd', noRemind: 'Ingen påminnelse',
    remindM: m => m === 12 ? 'Efter 1 år' : m === 24 ? 'Efter 2 år' : `Efter ${m} månader`, notify: d => `påminnelse ${d}`, attachments: 'Bilagor', addAttach: '+ Lägg till kvitto, garanti eller manual',
    tags: 'Taggar', registered: (d, by) => `Registrerad ${d}${by ? ` av ${by}` : ''}.`, storedSince: d => `Förvaras sedan ${d}.`, changed: d => `Senast ändrad ${d}.`,
    delItem: 'Ta bort sak', done: 'Klar', save: 'Spara', saveAnother: 'Spara + lägg till nästa', saved: 'Sparat.', savedNext: n => `${n} sparad. Lägg till nästa.`, nameFirst: 'Ge den ett namn först.',
    f_size: 'Storlek', f_brand: 'Märke', f_value: 'Pris / värde (kr)', f_model: 'Modell', f_qty: 'Antal', f_owner: 'Vems & status', f_color: 'Färg', f_season: 'Säsong', f_serial: 'Serienummer',
    f_category: 'Kategori', f_spot: 'Var exakt', f_notes: 'Anteckningar', whose: 'Vems är det', status: 'Status', loanTo: 'Utlånad till', shared: 'Gemensam',
    st_store: 'I förrådet', st_loan: 'Utlånad', st_sale: 'Till salu', st_sold: 'Såld', st_given: 'Bortskänkt',
    addTo: p => `Lägg till i ${p}`, boxStorage: 'Låda / förvaring', itemNoBox: 'Sak utan låda', severalPhotos: 'Flera saker från foton', cancel: 'Avbryt', close: 'Stäng', ok: 'OK',
    moveX: n => `Flytta ${n}`, to: 'Till', move: 'Flytta', movedTo: w => `Flyttad till ${w}.`, rename: 'Byt namn', del: 'Ta bort', edit: 'Ändra', moveToPlace: 'Flytta till plats', emptyFirst: 'Töm platsen för att kunna ta bort den.',
    delQ: n => `Ta bort ”${n}”? Det går inte att ångra.`, delNoteQ: 'Ta bort röstanteckningen?', rmPhotoQ: 'Ta bort fotot?', rmQ: n => `Ta bort ”${n}”?`, rmTagQ: n => `Ta bort taggen ”${n}”?`,
    newPlace: 'Ny förvaringsplats', newPlaceHint: 'Till exempel Källaren, Vinden eller Garaget', renameX: n => `Byt namn på ${n}`, newTag: 'Lägg till en tagg', tagHint: 'Till exempel vandring eller vinter',
    backupBanner: d => d ? `Senaste säkerhetskopian gjordes ${d}. Allt sparas bara på den här telefonen, så spara en kopia någon annanstans.` : 'Du har inte gjort någon säkerhetskopia än. Allt sparas bara på den här telefonen, så spara en kopia någon annanstans.',
    voiceNotes: 'Röstanteckningar', voiceNotesBox: 'Röstanteckningar för lådan', menu: 'Meny', allSettings: 'Alla inställningar', usedNoted: 'Noterat. Påminnelsen börjar om.', markedSale: 'Markerad till salu.',
    placesHint: 'Till exempel källarförrådet, vinden, garaget eller sommarstugan. Bara ett namn sparas, aldrig en adress.', placeNameHint: 'Namn, t.ex. Vinden',
    fileMissing: 'Filen saknas.', savingPhoto: 'Sparar foto…', unnamed: 'Namnlös',
    batchTitle: 'Lägg till flera saker', batchWhere: w => `De hamnar i ${w}.`, modeEach: 'Ett foto per sak', modeEachHint: 'Ta eller välj ett foto av varje sak.',
    modeMulti: 'Flera saker på ett foto', modeMultiHint: 'Lägg ut sakerna och ta ett foto. Varje sak blir en egen post.',
    batchAI: 'AI föreslår namn och detaljer utifrån fotona. Du kollar dem innan de läggs till.', batchNoAI: 'Slå på AI-assistenten för att få namn och detaljer föreslagna automatiskt. Utan den namnger du varje sak själv.',
    batchPrivacy: 'Fotona skickas till AI-tjänsten för att kännas igen.', thinking: 'Känner igen…', aiFailed: e => `Kunde inte känna igen: ${e}`, addN: n => n === 1 ? 'Lägg till 1 sak' : `Lägg till ${n} saker`,
    batchAdded: n => n === 1 ? 'La till 1 sak.' : `La till ${n} saker.`, namePh: 'Namn', include: 'Ta med', morePhotos: '+ Fler foton', noneYet: 'Inga foton än.', batchFound: n => n === 1 ? 'Hittade 1 sak.' : `Hittade ${n} saker.`,
  },
};
Object.assign(STR.en, {
    aiSuggest: 'Suggest from photo', testTag: 'TEST', aiLooking: 'Looking at the photo…', aiNothing: 'The AI didn’t recognise anything in the photo.',
    aiSuggestH: 'Suggestions from the photo', aiSuggestHint: 'Tick what you want to use. Ticked details replace what’s there now.', aiNow: v => `now: ${v}`, apply: 'Use selected', aiApplied: n => n === 1 ? 'Updated 1 detail.' : `Updated ${n} details.`, aiNeedPhoto: 'Add a photo first.',
    rmPhoto: 'Remove photo',
    addPhoto: 'Add photo',
    editBoxH: 'Edit box',
    newBox: 'New box',
    name: 'Name',
    boxNamePh: 'Winter clothes',
    storagePlace: 'Storage place',
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
    storagePlace: 'Förvaringsplats',
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
Object.assign(STR.en, {dragHint: 'Hold a box or a round marker and drag it onto a stack or into a zone.', back: 'Back', switchSpace: 'Choose place', shelf: 'Shelf', map: 'Map', door: 'Door', farIn: 'Far end', noZone: 'No zone', placement: 'Placement',
  placementHint: 'Where the box stands: the zone (for example “By the door”, “Shelf 2”, “Far end”) and which stack it’s in.', zone: 'Zone', zoneHint: 'For example By the door, Shelf 2, Far end',
  stack: 'Stack', newStack: 'A new stack', level: 'Level', onTop: 'On top', atBottom: 'At the bottom', stackOf: (n, codes) => codes ? `Stack ${n}: on ${codes}` : `Stack ${n}`, closerDoor: 'Move up', furtherIn: 'Move down'});
Object.assign(STR.sv, {dragHint: 'Håll in en låda eller rund markör och dra den till en stapel eller zon.', back: 'Tillbaka', switchSpace: 'Välj plats', shelf: 'Hylla', map: 'Karta', door: 'Dörren', farIn: 'Längst in', noZone: 'Utan zon', placement: 'Placering',
  placementHint: 'Var lådan står: zonen (till exempel ”Vid dörren”, ”Hylla 2”, ”Längst in”) och vilken stapel den står i.', zone: 'Zon', zoneHint: 'Till exempel Vid dörren, Hylla 2, Längst in',
  stack: 'Stapel', newStack: 'En ny stapel', level: 'Nivå', onTop: 'Överst', atBottom: 'Längst ner', stackOf: (n, codes) => codes ? `Stapel ${n}: ovanpå ${codes}` : `Stapel ${n}`, closerDoor: 'Flytta upp', furtherIn: 'Flytta ner'});
Object.assign(STR.en, {collections: 'Collections', collection: 'Collection', inBoxes: n => n === 1 ? 'in 1 place' : `in ${n} places`, showOnMap: 'Show on map', insideBox: 'inside',
  toCollection: 'Collection', collHint: 'Things with the same tag form a collection, even when they’re in different boxes.', collPh: 'For example Christmas or Winter', addedToColl: (n, t) => `Added ${n} to #${t}.`,
  isHere: 'is here', openItem: 'Open item', foundIn: 'Found in'});
Object.assign(STR.sv, {collections: 'Samlingar', collection: 'Samling', inBoxes: n => n === 1 ? 'på 1 ställe' : `på ${n} ställen`, showOnMap: 'Visa på kartan', insideBox: 'inuti',
  toCollection: 'Samling', collHint: 'Saker med samma tagg blir en samling, även om de ligger i olika lådor.', collPh: 'Till exempel Jul eller Vinter', addedToColl: (n, t) => `La till ${n} i #${t}.`,
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
const STATUS_KEYS = {'In storage': 'st_store', 'On loan': 'st_loan', 'For sale': 'st_sale', 'Sold': 'st_sold', 'Given away': 'st_given'};
const showColor = c => !c ? '' : lang === 'sv' ? cap(COLOR_SV[c] || c) : c;
const showSeason = s => !s ? '' : lang === 'sv' ? (SEASON_SV[s] || s) : s;
const showStatus = s => !s ? '' : STATUS_KEYS[s] ? tr(STATUS_KEYS[s]) : s;
const showOwner = o => o === 'Shared' ? tr('shared') : (o || '');
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
  if (v.name === 'search' || v.name === 'profile') return {name: 'home', place: currentPlace};
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
  while (backStack.length){ const v = backStack.pop(); if (viewValid(v) && !sameView(v, view)){ go(v); return true; } }
  return goUp();
}
function arm(){ if (armed || !(prevView() || parentView())) return; try { history.pushState({guard: 1}, ''); armed = true; } catch {} }
function go(v){
  leaveItemPage();
  quickAddFor = null;
  if (selecting && !(v.name === view.name && v.boxId === view.boxId && v.tag === view.tag)) selecting = null;
  if ((v.name === 'home' || v.name === 'mapfocus') && v.place) setPlace(v.place);
  view = v; if (v.name !== 'search') query = view.name === 'search' ? query : '';
  render(); window.scrollTo(0, 0); arm();
}
function goUp(){ const p = parentView(); if (!p) return false; go(p); return true; }
function navigate(v){
  if (v.name === 'box'){ remember('box', v.boxId); touchOpened(findBox(v.boxId)); if (view.name === 'search' && v.hl) v.fromSearch = true; }
  if (v.name === 'item' && v.itemId !== itemDraft) remember('item', v.itemId, v.boxId);
  if (v.name !== 'search') query = '';
  if (!sameView(v, view)) pushBack();
  go(v);
}
window.addEventListener('popstate', () => {
  armed = false;
  const vw = document.getElementById('viewer');
  if (vw && vw.open){ vw.close(); arm(); return; }
  if (sheet.open){ closeSheet(); arm(); return; }
  if (goBack()) arm();
});
function goHome(pid){ setPlace(pid || 'all'); navigate({name: 'home', place: pid || 'all'}); }
function openSpace(){ goHome(currentPlace !== 'all' ? currentPlace : null); }
function openBox(id){
  const b = findBox(id); if (!b) return;
  if (currentPlace !== b.placeId) setPlace(b.placeId);
  navigate({name: 'box', boxId: id});
}
function showSearch(q){ query = q || ''; if (view.name !== 'search') navigate({name: 'search'}); else render(); const s = $('#q'); if (s && s.value !== query) s.value = query; }

const possessive = () => {
  if (!me) return lang === 'sv' ? 'MIN' : 'MY';
  const n = me.toUpperCase();
  return lang === 'sv' ? (/[SXZ]$/.test(n) ? n : n + 'S') : (n.endsWith('S') ? n + '’' : n + '’S');
};
function crumbs(parts, sub){
  return `<nav class="crumbs" aria-label="Where you are">${parts.map(p => p.nav ? `<button data-nav='${esc(JSON.stringify(p.nav))}'>${esc(p.label)}</button>` : `<span>${esc(p.label)}</span>`).join('<span class="sep"> - </span>')}</nav>${sub ? `<p class="tagline">${sub}</p>` : ''}`;
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
  else if (currentPlace !== 'all' && findPlace(currentPlace)) renderPlace(currentPlace);
  else renderSpace();
  const tab = view.name === 'search' ? 'search' : view.name === 'profile' ? 'profile' : 'home';
  if (!['box', 'search', 'collection'].includes(view.name)) document.body.classList.remove('selecting');
  document.querySelectorAll('.tabbar [data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === tab); const l = b.querySelector('.tl'); if (l) l.textContent = tr('tab_' + b.dataset.tab); });
  const pdot = $('#profileDot'); if (pdot) pdot.hidden = !dueCount() && !outItems().some(([it]) => outOverdue(it)) && !realBoxes().some(boxOutLate) && !nudges().length;
  topbarUpdate();
  hydrate(app); hydrateNotes(app);
}
STR.en.tab_home = 'Active'; STR.en.tab_search = 'Search'; STR.en.tab_profile = 'Profile'; STR.en.tab_add = 'Add'; STR.sv.tab_add = 'Lägg till';
STR.sv.tab_home = 'Aktiv'; STR.sv.tab_search = 'Sök'; STR.sv.tab_profile = 'Profil';

/* tiles */
const addTile = (act, label, extra = '') => `<button class="tile add" data-act="${act}" ${extra} aria-label="${esc(label)}">+</button>`;
function boxTile(b){ return shelfTile(b); }
function itemTile(it, b, caption){
  const p = (it.photos || [])[0];
  const sel = selecting && selecting.has('i:' + b.id + ':' + it.id);
  const hl = view.name === 'box' && view.hl === it.id;
  return `<button class="itile${sel ? ' sel' : ''}${hl ? ' hl' : ''}${isOut(it) ? ' out' : ''}" data-item="${esc(it.id)}" data-box="${esc(b.id)}" data-lp="item:${esc(b.id)}:${esc(it.id)}">
    <span class="timg">${p ? imgTag(p.ref, '') : ''}<span class="ticon${p ? ' fb' : ''}">${guessIcon(it)}</span>${dot(isDue(it))}${it.fav ? '<span class="favstar">★</span>' : ''}${selecting ? `<span class="selbox">${sel ? '✓' : ''}</span>` : ''}</span>
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
function placeBar(){
  const sel = places.length === 1 ? places[0].id : currentPlace;
  return ''; `<div class="placebar" aria-label="${esc(tr('storagePlaces'))}">${places.length > 1 ? `<button class="pchip${sel === 'all' ? ' on' : ''}" data-goplace="all">${tr('allPlaces')}</button>` : ''}${places.map(p => `<button class="pchip${sel === p.id ? ' on' : ''}" data-goplace="${esc(p.id)}" data-lp="place:${esc(p.id)}"><span class="picon">${placeIcon(p)}</span>${esc(p.name)}${dot(dueCount(b => b.placeId === p.id))}</button>`).join('')}<button class="pchip add" data-act="addplace">${tr('addPlace')}</button></div>`;
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
    <div class="grid${viewCls()}">${bx.map(boxTile).join('')}${addTile('addhere', tr('addTo', placeName(pid)), `data-pid="${esc(pid)}"`)}</div>
    ${li.length ? `<h2 class="section">${tr('notInBox')}</h2><div class="igrid${viewCls()}">${li.map(it => itemTile(it, loose, it.spot ? esc(it.spot) : '')).join('')}</div>` : ''}
    ${!bx.length && !li.length && !heading ? `<p class="hint center">${tr('emptyPlace')}</p>` : ''}`;
}
let recents = [];
function remember(kind, id, boxId){
  recents = [{k: kind, id, boxId}].concat(recents.filter(r => !(r.k === kind && r.id === id))).slice(0, 12);
  metaPut('recent', recents).catch(() => {});
}
function topStrips(pid){
  const f = favEntries(pid), r = recentEntries(pid);
  const row = (title, list) => list.length ? `<div class="mini"><span class="minih">${title}</span><div class="strip mini">${list.map(([kind, x, b]) => kind === 'box' ? shelfTile(x) : itemTile(x, b)).join('')}</div></div>` : '';
  return row('★ ' + tr('favorites'), f) + row(tr('recent'), r);
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
  return out;
}
let placeView = 'shelf';
function topbarUpdate(){
  const sw = $('#spaceBtn'), bk = $('#backBtn'), lg = $('#logoBtn'); if (!sw) return;
  const pid = view.name === 'box' || view.name === 'item' || view.name === 'batch' ? (findBox(view.boxId) || {}).placeId : (places.length === 1 ? places[0].id : currentPlace);
  const p = pid && pid !== 'all' ? findPlace(pid) : null;
  sw.innerHTML = p ? `<span class="picon">${placeIcon(p)}</span><span class="sname">${esc(p.name)}</span><span class="caret">▾</span>` : `<span class="sname">${tr('allPlaces')}</span><span class="caret">▾</span>`;
  const up = prevView() || parentView();
  bk.hidden = !up; lg.hidden = !!up;
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
    <span class="timg">${boxArt(boxNum(b))}<span class="bcount">${n}</span>${tileFresh(b)}${b.fav ? '<span class="favstar">★</span>' : ''}${b.out ? `<span class="boxouttag">↗</span>` : ''}${dot(dueCount(x => x.id === b.id || x.parentId === b.id))}</span>
    <span class="ttext"><span class="tname">${esc(b.name || boxLabel(b))}</span></span></button>`;
}
/* the freshness dot only shows when a box is about to stop being "fresh" (not checked for ~5 months) */
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
  return `<section class="lcarousel" data-unplace="${opts.dropTarget ? '1' : ''}"><div class="lhead"><b>${tr('notInBox')}</b>${l && li.length ? `<button class="linkbtn" data-open="${esc(l.id)}">${tr('showAll')} ›</button>` : ''}<span class="zcount">${tr('items_n', li.length).toLowerCase()}</span></div>
    ${opts.hint ? `<p class="maphint">${opts.hint}</p>` : ''}
    <div class="lstrip">${li.map(it => itemTile(it, l, opts.showZone && it.zone ? esc(it.zone) : '')).join('')}
      <button class="itile add" data-act="addloose" data-pid="${esc(pid)}"><span class="timg">+</span><span class="ttext"><span class="tname">${tr('add')}</span></span></button></div></section>`;
}
function shelfHTML(pid){
  const bx = topBoxesIn(pid).sort(byCode);
  return `<div class="shelf">${bx.map(shelfTile).join('')}<button class="itile add" data-act="addhere" data-pid="${esc(pid)}" aria-label="${esc(tr('addTo', placeName(pid)))}"><span class="timg">+</span><span class="ttext"><span class="tname">${tr('add')}</span></span></button></div>
    ${looseCarousel(pid, {showZone: true})}`;
}
function placeHead(pid){
  const nB = boxesIn(pid).length, nI = boxes.filter(b => b.placeId === pid).reduce((s, b) => s + (b.items || []).length, 0);
  return `<div class="phead"><div><p class="tagline">${counts(tr('boxes_n', nB), tr('items_n', nI))}</p></div>
    <div class="seg small"><button class="${placeView === 'shelf' ? 'on' : ''}" data-pview="shelf">${tr('shelf')}</button><button class="${placeView === 'list' ? 'on' : ''}" data-pview="list">${tr('list')}</button><button class="${placeView === 'map' ? 'on' : ''}" data-pview="map">${tr('map')}</button></div></div>`;
}
function renderSpace(){
  const nB = realBoxes().length, nI = boxes.reduce((s, b) => s + (b.items || []).length, 0);
  app.innerHTML = `<div class="phead"><p class="tagline">${counts(tr('places_n', places.length), tr('boxes_n', nB), tr('items_n', nI))}</p></div>
    ${topStrips()}
    ${places.map(p => { const pb = boxesIn(p.id).length, pi = boxes.filter(b => b.placeId === p.id).reduce((s, b) => s + (b.items || []).length, 0);
      const [cc, cn] = checkedThisYear(p.id);
      return `<section class="spacesec card">${nudgeBar(p.id)}<button class="spacehead" data-goplace="${esc(p.id)}" data-lp="place:${esc(p.id)}"><span class="picon">${placeIcon(p)}</span><b>${esc(p.name)}</b><small>${tr('boxes_n', pb).toLowerCase()} · ${tr('items_n', pi).toLowerCase()}${cn ? ` · ✓ ${cc}/${cn}` : ''}</small><span class="chev">›</span></button>${shelfHTML(p.id)}</section>`; }).join('')}
    ${notesHTML(notes.filter(n => !n.boxId || !findBox(n.boxId)), tr('voiceNotes'))}
    ${backupBanner()}`;
}
function nudgeBar(pid){ const n = nudges(pid)[0]; return n ? nudgeCard(n, true) : ''; }
function renderPlace(pid, focus){
  const what = focus ? [...(view.hlBoxes || []).map(findBox).filter(Boolean).map(b => (view.hlBoxes.length === 1 ? `${b.code} ${b.name}` : b.code)), ...looseItems(pid).filter(i => (view.hlItems || []).includes(i.id)).map(i => i.name)] : [];
  app.innerHTML = `${focus ? `<div class="findhint"><span>${ICON.pin} <b>${esc(what.join(', '))}</b></span></div>` : placeHead(pid)}
    ${focus || placeView === 'map' ? '' : topStrips(pid)}
    ${focus ? '' : nudgeBar(pid)}
    ${focus || placeView === 'map' ? mapHTML(pid) : placeView === 'list' ? listHTML(pid) : shelfHTML(pid)}
    ${focus ? '' : (([c, n]) => n ? `<p class="freshsum">${freshDot({checkedAt: c === n ? today() : null, updatedAt: null})} ${esc(tr('checkedYear', c, n))}</p>` : '')(checkedThisYear(pid))}
    ${notesHTML(notes.filter(n => !n.boxId || !findBox(n.boxId)), tr('voiceNotes'))}
    ${backupBanner()}`;
  if (focus) scrollToHighlight();
}
let selecting = null;
function renderBox(b){
  const items = [...(b.items || [])].sort(byName), kids = b.loose ? [] : childBoxes(b.id).sort(byCode);
  const chain = b.loose ? [] : boxChain(b);
  const path = [placeName(b.placeId), ...chain.map(x => x.code)].join(' › ');
  const where = [b.location, b.stack ? `${tr('stack')} ${b.stack}` : '', b.level ? `${tr('level')} ${b.level}` : ''].filter(Boolean).join(' · ');
  const hlIt = view.hl && items.find(i => i.id === view.hl);
  const nOut = items.filter(isOut).length;
  const askOut = hlIt && view.fromSearch && !view.asked && !isOut(hlIt);
  const needCheck = !b.loose && items.length && daysSince(b.checkedAt) > 30 && !view.checkDismissed;
  app.innerHTML = `${b.out ? `<div class="findhint outhint"><span>↗ <b>${tr('boxIsOut')}</b> · ${esc(tr('outSince', b.out.since))}${b.out.until ? ' · ' + esc(tr('backBy', b.out.until)) : ''}</span><button class="btn primary small" data-act="boxback">↩ ${tr('putBackBox')}</button></div>` : ''}
    ${askOut ? `<div class="askout"><span>${esc(tr('askOut', hlIt.name))}</span><span class="fhbtns"><button class="btn primary small" data-askout="temp">${tr('yesTemp')}</button><button class="btn quiet small" data-askout="gone">${tr('yesGone')}</button><button class="btn quiet small" data-askout="no">${tr('no')}</button></span></div>` : ''}
    ${hlIt ? `<div class="findhint"><span>🔎 <b>${esc(hlIt.name)}</b> ${tr('isHere')}</span><span class="fhbtns"><button class="btn primary small" data-item="${esc(hlIt.id)}" data-box="${esc(b.id)}" data-open-item="1">${tr('openItem')}</button><button class="btn quiet small" data-mapbox="${esc(b.id)}" data-mapitem="${esc(b.loose ? hlIt.id : '')}" aria-label="${esc(tr('showOnMap'))}">${ICON.pin}</button></span></div>` : ''}
    <div class="bhead">
      ${b.loose ? `<h1 class="btitle"><span class="bname">${tr('notInBox')}</span></h1>` : `<h1 class="btitle"><span class="bcode">${esc(b.code)}</span><span class="bname">${esc(b.name)}</span></h1>`}
      <p class="bpath"><button data-goplace="${esc(b.placeId)}">${esc(path)}</button>${where ? ` · ${esc(where)}` : ''} · ${tr('items_n', items.length).toLowerCase()}${nOut ? ` · <b class="outsum">↗ ${esc(tr('outOfN', nOut, items.length))}</b>` : ''}</p>
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
    ${viewMode === 'list' ? '' : `<div class="igrid${viewCls()}">${items.map(it => itemTile(it, b)).join('')}${items.length || selecting ? '' : `<button class="itile add" data-act="additem"><span class="timg">+</span><span class="ttext"><span class="tname">${tr('addItem')}</span></span></button>
      <button class="itile add" data-act="batch"><span class="timg">${ICON.camera}</span><span class="ttext"><span class="tname">${tr('addSeveral')}</span></span></button>
      ${b.loose ? '' : `<button class="itile add" data-act="subbox"><span class="timg">${ICON.box}</span><span class="ttext"><span class="tname">${tr('boxInBox')}</span></span></button>`}`}</div>`}
    ${(items.length || viewMode === 'list') && !selecting ? `<div class="addrow"><button class="btn quiet small" data-act="additem">+ ${tr('addShort')}</button><button class="btn quiet small" data-act="batch">${ICON.camera} ${tr('severalShort')}</button>${b.loose ? '' : `<button class="btn quiet small" data-act="subbox">${ICON.box} ${tr('subShort')}</button>`}</div>` : ''}
    ${notesHTML(notes.filter(n => n.boxId === b.id), tr('voiceNotesBox'))}
    ${selBar(['tag', 'move', 'del'])}`;
  document.body.classList.toggle('selecting', !!selecting);
  if (hlIt) scrollToHighlight();
}
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
function rememberQuery(q){ q = (q || '').trim(); if (q.length < 2) return; recentQ = [q, ...recentQ.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8); metaPut('recentQ', recentQ).catch(() => {}); }
function rowsOrTiles(entries){
  const bx = entries.filter(e => e[0] === 'box').map(e => e[1]), its = entries.filter(e => e[0] === 'item').map(e => [e[1], e[2]]);
  return `${bx.length ? `<div class="shelf${shelfCls()}">${bx.map(shelfTile).join('')}</div>` : ''}${its.length ? (viewMode === 'list' ? rowsHTML(its, {where: true}) : `<div class="igrid${viewCls()}">${its.map(([it, b]) => itemTile(it, b, whereCaption(b))).join('')}</div>`) : ''}`;
}
let searchQuick = null;
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
    const boxHits = searchQuick ? [] : realBoxes().filter(b => { if (!inScope(b)) return false; const h = [b.code, b.code.replace('B-', ''), b.name, b.location, b.notes, placeName(b.placeId)].join(' ').toLowerCase(); return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => h.includes(w)); }).sort(byCode);
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
  app.innerHTML = `<div class="headrow"><div class="headtext">${crumbs([{label: tr('findStuff')}], counts(tr('boxes_n', nB), tr('items_n', nI)))}</div>${viewToggle()}</div>
    <input class="input search" id="q" type="search" placeholder="${esc(tr('typeKeyword'))}" value="${esc(query)}" autocomplete="off" enterkeyhint="search">
    ${quickChips()}
    ${scopeChips()}
    ${collectionChips(q)}
    ${(q || P.size || B.size) && !selecting && /itile/.test(body) ? `<div class="selrow"><button class="btn quiet small" data-act="selectmode">${tr('select')}</button></div>` : ''}
    <div id="results">${body}</div>
    ${selBar(['tag', 'move', 'del'])}`;
  document.body.classList.toggle('selecting', !!selecting);
  const s = $('#q');
  if (focused){ s.focus(); try { s.setSelectionRange(pos, pos); } catch {} }
  let tmr; s.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { query = s.value; render(); }, 150); });
  app.querySelectorAll('[data-quick]').forEach(c => c.onclick = () => { searchQuick = searchQuick === c.dataset.quick ? null : c.dataset.quick; render(); });
  app.querySelectorAll('[data-suggest]').forEach(c => c.onclick = () => { query = c.dataset.suggest; rememberQuery(query); render(); });
  s.addEventListener('keydown', e => { if (e.key === 'Enter'){ rememberQuery(s.value); s.blur(); } });
  app.querySelectorAll('[data-scope]').forEach(c => c.onclick = () => {
    const v = c.dataset.scope;
    if (v === 'all'){ P.clear(); B.clear(); }
    else if (v === 'allboxes') B.clear();
    else if (v.startsWith('p:')){ const id = v.slice(2); P.has(id) ? P.delete(id) : P.add(id); B.clear(); }
    else if (v.startsWith('b:')){ const id = v.slice(2); B.has(id) ? B.delete(id) : B.add(id); }
    render();
  });
}
function renderWelcome(){
  app.innerHTML = `<div class="welcome">
    <div class="langsw">${langSwitch()}</div>
    <div class="logobig">${logoSVG()}</div>
    <h1>Storrrage</h1>
    <p>${tr('welcome')}</p>
    <input class="input" id="wName" placeholder="${esc(tr('yourName'))}" autocapitalize="words" autocomplete="given-name">
    <button class="btn primary block" id="wGo">${tr('getStarted')}</button>
    <p class="hint center">${tr('noAccount')}</p></div>`;
  const go = () => {
    const n = $('#wName').value.trim(); if (!n){ $('#wName').focus(); return toast(tr('writeName')); }
    me = addPerson(n); metaPut('me', me).catch(() => {}); metaPut('onboarded', true).catch(() => {});
    navigate({name: 'home', place: 'all'}, true);
  };
  $('#wGo').onclick = go; $('#wName').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}
const langSwitch = () => `<div class="seg" role="group" aria-label="Language / Språk"><button class="${lang === 'sv' ? 'on' : ''}" data-lang-ui="sv">Svenska</button><button class="${lang === 'en' ? 'on' : ''}" data-lang-ui="en">English</button></div>`;
function setLang(l){
  lang = l; metaPut('lang', l).catch(() => {});
  voiceLang = l === 'sv' ? 'sv-SE' : 'en-US'; metaPut('voiceLang', voiceLang).catch(() => {});
  render();
}
document.addEventListener('click', e => { const b = e.target.closest('[data-lang-ui]'); if (b){ setLang(b.dataset.langUi); if (sheet.open && sheet.querySelector('[data-lang-ui]')) menuSheet(); } });

function renderProfile(){
  const sub = view.sub || '', due = dueItems();
  if (!sub){
    app.innerHTML = `${crumbs([{label: possessive() + ' ' + tr('storrrage')}])}
      <div class="list">
        <button class="row" data-sub="profile">${ICON.user}<span>${tr('profile')}</span></button>
        <button class="row" data-sub="settings">${ICON.gear}<span>${tr('settings')}</span></button>
        <button class="row" data-sub="notifications">${ICON.bell}<span>${tr('notifications')}${due.length ? '<i class="dot inline"></i>' : ''}</span>${due.length ? `<b class="count">${due.length}</b>` : ''}</button>
        <button class="row" data-sub="premium">${ICON.star}<span>${tr('premium')}</span></button>
      </div>
      <div class="field"><span>${tr('language')}</span>${langSwitch()}</div>
      <p class="proof center">${tr('version', APP_VERSION)}</p>`;
    return;
  }
  const back = [{label: possessive() + ' ' + tr('storrrage'), nav: {name: 'profile'}}];
  if (sub === 'profile'){
    app.innerHTML = `${crumbs([...back, {label: tr('profile').toUpperCase()}])}
      <div class="fl"><input id="pfName" value="${esc(me)}" placeholder="${esc(tr('yourName'))}" autocapitalize="words"><label>${tr('yourName')}</label></div>
      <h2 class="section">${tr('household')}</h2>
      <div id="plist2"></div>
      <div class="vtype"><input class="input" id="pName2" placeholder="${esc(tr('addName'))}" autocapitalize="words"><button class="btn primary" id="pAdd2">${tr('add')}</button></div>
      <p class="proof">${tr('householdHint')}</p>`;
    const draw = () => { $('#plist2').innerHTML = household.length ? household.map((n, i) => `<div class="prow"><span>${esc(n)}${n === me ? ' ' + tr('you') : ''}</span>${n === me ? '' : `<button class="linkbtn" data-pdel="${i}">${tr('remove')}</button>`}</div>`).join('') : `<p class="hint">${tr('noOne')}</p>`; };
    draw();
    $('#pfName').addEventListener('change', e => { const n = e.target.value.trim(); if (!n) return; me = addPerson(n); metaPut('me', me).catch(() => {}); draw(); });
    const add = () => { const n = addPerson($('#pName2').value); $('#pName2').value = ''; if (n) draw(); };
    $('#pAdd2').onclick = add; $('#pName2').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    $('#plist2').onclick = e => { const d = e.target.closest('[data-pdel]'); if (!d) return; household.splice(+d.dataset.pdel, 1); metaPut('household', household).catch(() => {}); draw(); };
    return;
  }
  if (sub === 'settings'){
    app.innerHTML = `${crumbs([...back, {label: tr('settings').toUpperCase()}])}
      <div class="field" style="margin-top:14px"><span>${tr('language')}</span>${langSwitch()}</div>
      <div class="list">
        <button class="row" data-m="ai"><span>${tr('aiAssistant')}</span><em>${ai.provider === 'off' ? tr('off') : esc(AI_LABEL[ai.provider])}</em></button>
        <button class="row" data-m="places"><span>${tr('storagePlaces')}</span><em>${places.length}</em></button>
        <button class="row" data-m="backup"><span>${tr('backupNow')}</span><em>${lastBackup ? esc(fmtDate(lastBackup)) : tr('never')}</em></button>
        <button class="row" data-m="import"><span>${tr('restore')}</span></button>
        <button class="row" data-m="export"><span>${tr('export')}</span><em>Excel · Word · PDF</em></button>
        <button class="row" data-m="report"><span>${tr('insurance')}</span></button>
        <button class="row" data-m="labels"><span>${tr('labelsAll')}</span></button>
        <button class="row" data-m="scan"><span>${tr('scanLabel')}</span></button>
      </div>
      <label class="check"><input type="checkbox" id="adsChk" ${adsPreview ? 'checked' : ''}> ${tr('adsSetting')}</label>
      <div class="field"><span>${tr('numbering')}</span><select class="input" id="numSel"><option value="place" ${numbering === 'place' ? 'selected' : ''}>${tr('numPlace')}</option><option value="account" ${numbering === 'account' ? 'selected' : ''}>${tr('numAccount')}</option></select></div>
      <p class="proof center" id="usage"></p>`;
    $('#adsChk').onchange = e => { adsPreview = e.target.checked; metaPut('adsPreview', adsPreview).catch(() => {}); };
    $('#numSel').onchange = e => { numbering = e.target.value; metaPut('numbering', numbering).catch(() => {}); };
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(est => { const el = $('#usage'); if (el && est.usage) el.textContent = tr('usage', Math.max(1, Math.round(est.usage / 1048576))); }).catch(() => {});
    return;
  }
  if (sub === 'notifications'){
    const late = outItems().filter(([it]) => outOverdue(it));
    const lateBoxes = realBoxes().filter(boxOutLate), sug = nudges();
    app.innerHTML = `${crumbs([...back, {label: tr('notifications').toUpperCase()}])}
      ${backupBanner()}
      ${sug.length ? `<h2 class="section">${tr('suggestions')}</h2>${sug.map(n => nudgeCard(n)).join('')}` : ''}
      ${lateBoxes.length ? `<h2 class="section">${tr('backQ')}</h2><div class="shelf">${lateBoxes.map(shelfTile).join('')}</div>` : ''}
      ${late.length ? `<h2 class="section">${tr('backQ')}</h2><div class="dues">${late.map(([it, b]) => `<div class="due">${itemTile(it, b, whereCaption(b))}
        <div class="dueact"><span class="hint">${esc(tr('backBy', it.out.until))}</span><button class="btn primary small" data-backok="${esc(b.id)}:${esc(it.id)}">↩ ${tr('isBack')}</button><button class="btn quiet small" data-more="${esc(b.id)}:${esc(it.id)}">${tr('stillOut')}</button></div></div>`).join('')}</div>` : ''}
      ${due.length ? `<p class="hint">${tr('dueIntro')}</p>
        <div class="dues">${due.map(([it, b]) => `<div class="due">${itemTile(it, b, whereCaption(b))}
          <div class="dueact"><span class="hint">${esc(tr('lastUsedOn', it.lastUsed || it.storedOn || ''))}</span>
          <button class="btn quiet small" data-used="${esc(b.id)}:${esc(it.id)}">${tr('usedRecently')}</button>
          <button class="btn quiet small" data-sell="${esc(b.id)}:${esc(it.id)}">${tr('markSale')}</button></div></div>`).join('')}</div>`
      : `<p class="hint">${tr('nothingDue')}</p>`}`;
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
/* ---------- item page: name under the photo, place as a field, optional details ---------- */
let itemDraft = null, flushItem = null, shownOpt = new Set(), shownFor = null;
function leaveItemPage(){
  const v = view;
  if (v.name === 'item' && flushItem){ try { flushItem(); } catch {} }
  flushItem = null;
  if (v.name !== 'item' || itemDraft !== v.itemId) return;
  const b = findBox(v.boxId), it = b && (b.items || []).find(i => i.id === v.itemId);
  if (it && !(it.name || '').trim()){ const nb = clone(b); nb.items = nb.items.filter(i => i.id !== it.id); putBox(nb, true); (it.photos || []).forEach(p => dropPhoto(p.ref)); (it.files || []).forEach(f => dropPhoto(f.ref)); if ((it.photos || []).length) toast(tr('discarded')); }
  itemDraft = null;
}
function newItem(boxId, replace){
  const b = findBox(boxId); if (!b) return;
  const it = {id: newId(), name: '', category: '', value: '', storedOn: today(), notes: '', photos: [], tags: [], addedAt: new Date().toISOString(), addedBy: me || ''};
  const nb = clone(b); nb.items = (nb.items || []).concat(it); putBox(nb, true);
  leaveItemPage();
  itemDraft = it.id;
  if (!replace) pushBack();
  view = {name: 'item', boxId, itemId: it.id};
  render(); window.scrollTo(0, 0); arm();
  setTimeout(() => { const n = $('#fName'); if (n) n.focus(); }, 80);
}
function itemSheet(boxId, itemId){ if (itemId) navigate({name: 'item', boxId, itemId}); else newItem(boxId); }
const OPT = ['size', 'brand', 'value', 'model', 'qty', 'owner', 'color', 'season', 'serial', 'category', 'spot', 'notes'];
const STATUSES = Object.keys(STATUS_KEYS);
function curItem(){ const b = findBox(view.boxId); const it = b && (b.items || []).find(i => i.id === view.itemId); return it ? [it, b] : [null, null]; }
function saveItem(mut, rerender){
  const [it, b] = curItem(); if (!it) return;
  const nb = clone(b), x = nb.items.find(i => i.id === it.id);
  mut(x); x.updatedAt = new Date().toISOString();
  if (x.name && itemDraft === x.id) itemDraft = null;
  putBox(nb, !rerender);
}
function hasVal(it, k){ return k === 'owner' ? !!(it.owner || it.status || it.loanTo) : (it[k] !== undefined && it[k] !== null && String(it[k]).trim() !== ''); }
function finishItem(again){
  if (flushItem) flushItem();
  const [it, b] = curItem(); if (!it) return;
  if (!(it.name || '').trim()){ const nm = $('#fName'); if (nm){ nm.focus(); nm.classList.add('need'); } return toast(tr('nameFirst')); }
  itemDraft = null;
  toast(again ? tr('savedNext', it.name) : tr('saved'));
  if (again) return newItem(b.id, true);
  goBack();
}
function moveItemTo(boxId, itemId, sel){
  const b = findBox(boxId), it = b && (b.items || []).find(i => i.id === itemId); if (!it) return null;
  const destId = sel.startsWith('loose:') ? ensureLoose(sel.slice(6)).id : sel;
  if (destId === b.id) return b;
  snapshot([b.id, destId]);
  const from = clone(findBox(b.id)); from.items = from.items.filter(i => i.id !== itemId); putBox(from, true);
  const to = clone(findBox(destId)), moved = Object.assign(clone(it), {updatedAt: new Date().toISOString()}); if (!to.loose){ delete moved.spot; delete moved.zone; delete moved.stack; delete moved.level; }
  to.items = (to.items || []).concat(moved); putBox(to, true);
  if (view.name === 'item' && view.itemId === itemId) view = {name: 'item', boxId: destId, itemId};
  toast(tr('movedTo', to.loose ? placeName(to.placeId) : to.code));
  return to;
}
function moveTargetsHTML(cur){
  const opt = (x, depth) => `<option value="${esc(x.id)}" ${x.id === cur.id ? 'selected' : ''}>${'\u2003'.repeat(depth)}${esc(placeName(x.placeId))} · ${esc(x.code)} ${esc(x.name)}</option>` + childBoxes(x.id).sort(byCode).map(c => opt(c, depth + 1)).join('');
  return places.map(p => `<optgroup label="${esc(p.name)}"><option value="loose:${esc(p.id)}" ${cur.loose && cur.placeId === p.id ? 'selected' : ''}>${esc(p.name)}, ${tr('notInBoxShort')}</option>
    ${topBoxesIn(p.id).sort(byCode).map(x => opt(x, 0)).join('')}</optgroup>`).join('');
}
function renderItem(){
  const [it, b] = curItem();
  if (shownFor !== it.id){ shownOpt = new Set(); shownFor = it.id; }
  const isNew = itemDraft === it.id;
  const show = k => hasVal(it, k) || shownOpt.has(k);
  const n = notifyAt(it), due = isDue(it), photos = it.photos || [];
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
    if (k === 'spot') return b.loose ? input(k) : '';
    if (k === 'notes') return `<div class="fl"><textarea data-f="notes" placeholder="${esc(tr('f_notes'))}">${esc(it.notes || '')}</textarea><label>${tr('f_notes')}</label></div>`;
    if (k === 'owner') return `<div class="fl group"><label class="always">${tr('f_owner')}</label>
      <div class="pair"><input data-f="owner" value="${esc(showOwner(it.owner))}" placeholder="${esc(tr('whose'))}" list="people" autocapitalize="words">
      <select data-f="status" aria-label="${esc(tr('status'))}"><option value="">${tr('status')}…</option>${STATUSES.map(s => `<option value="${s}" ${status === s ? 'selected' : ''}>${tr(STATUS_KEYS[s])}</option>`).join('')}${status && !STATUS_KEYS[status] ? `<option value="${esc(status)}" selected>${esc(status)}</option>` : ''}</select></div>
      ${status === 'On loan' ? `<input class="sub" data-f="loanTo" value="${esc(loanTo)}" placeholder="${esc(tr('loanTo'))}" list="people" autocapitalize="words">` : ''}</div>`;
    return input(k);
  };
  const addable = OPT.filter(k => !show(k) && (k !== 'spot' || b.loose));
  const crumbParts = [crumbSpace(), crumbPlace(b.placeId)].concat(b.loose ? [] : [{label: boxLabel(b), nav: {name: 'box', boxId: b.id}}]);
  app.innerHTML = `${crumbs(crumbParts)}
    <div class="hero">
      ${photos.length ? `<button class="heroimg" data-viewph="${esc(photos[0].ref)}">${imgTag(photos[0].ref, '')}</button>` : `<button class="heroimg empty" data-act="pickicon" aria-label="${esc(tr('pickIcon'))}"><span class="ticon">${guessIcon(it)}</span><span class="iconedit">${tr('pickIcon')}</span></button>`}
      <label class="cam" aria-label="Photo">${ICON.camera}<input type="file" accept="image/*" id="fPhoto" multiple hidden></label>
    </div>
    ${photos.length ? `<div class="thumbs">${photos.map((p, i) => `<span class="th"><button data-viewph="${esc(p.ref)}">${imgTag(p.ref, '')}</button><button class="x" data-rmph="${i}" aria-label="${esc(tr('remove'))}">×</button></span>`).join('')}</div>` : ''}
    ${isOut(it) ? `<p class="outline"><span>↗ ${tr('outTag')} · ${esc(tr('outSince', it.out.since))}${it.out.until ? ' · ' + esc(tr('backBy', it.out.until)) : ''}</span><button class="linkbtn" data-act="itemback">↩ ${tr('putBack')}</button></p>` : ''}
    <div class="titlerow"><input class="title" id="fName" value="${esc(it.name)}" placeholder="${esc(tr('whatIsIt'))}" autocomplete="off" autocapitalize="sentences" required>
      ${isOut(it) ? '' : `<button class="iconbtn outbtn" data-act="itemout" aria-label="${esc(tr('takeOut'))}" title="${esc(tr('takeOut'))}">↗</button>`}<button class="iconbtn star" data-act="favitem" aria-label="${esc(it.fav ? tr('unfav') : tr('fav'))}" aria-pressed="${it.fav ? 'true' : 'false'}">${it.fav ? '★' : '☆'}</button></div>
    ${ai.provider !== 'off' && photos.length ? `<div class="aisug"><button class="btn quiet small" data-act="aisuggest" ${navigator.onLine ? '' : 'disabled'}>✨ ${tr('aiSuggest')}</button><span class="testtag">${tr('testTag')}</span></div>` : ''}
    <div class="whereline"><button class="pinbtn" data-mapbox="${esc(b.id)}" data-mapitem="${esc(b.loose ? it.id : '')}" aria-label="${esc(tr('showOnMap'))}">${ICON.pin}</button><span class="wtxt">${esc(b.loose ? placeName(b.placeId) + ' · ' + tr('notInBoxShort') : `${placeName(b.placeId)} · ${b.code} ${b.name}`)}</span><button class="linkbtn" data-act="moveitem2">${tr('move')}</button></div>
    ${OPT.map(field).join('')}
    ${addable.length ? `<div class="adddet"><span class="lab">${tr('addDetail')}</span><div class="chips">${addable.map(k => `<button class="chipbtn" data-addopt="${k}">+ ${esc(tr('f_' + k))}</button>`).join('')}</div></div>` : ''}
    <div class="fl"><input data-f="lastUsed" type="date" value="${esc(it.lastUsed || '')}"><label class="always">${tr('lastUsed')}</label></div>
    <div class="fl"><select data-f="remindMonths" aria-label="${esc(tr('remind'))}">${[0, 6, 12, 24].map(v => `<option value="${v}" ${+(it.remindMonths || 0) === v ? 'selected' : ''}>${v ? tr('remindM', v) : tr('noRemind')}</option>`).join('')}</select><label class="always">${tr('remind')}</label></div>
    <div class="fl"><input data-f="remindAt" type="date" value="${esc(it.remindAt || '')}"><label class="always">${tr('remindDate')}</label></div>
    ${n ? `<p class="notifyrow"><span class="notify${due ? ' due' : ''}">${esc(tr('notify', n))}${dot(due)}</span><button class="linkbtn" data-act="ics">${tr('toCalendar')}</button></p>` : ''}
    <div class="fl att"><label class="always">${tr('attachments')}</label>
      ${(it.files || []).map((f, i) => `<div class="attrow"><span>${esc(f.name)}</span><button data-viewfile="${i}" aria-label="${esc(f.name)}">${ICON.eye}</button><button class="x" data-rmfile="${i}" aria-label="${esc(tr('remove'))}">×</button></div>`).join('')}
      <div><label class="addfile">${tr('addAttach')}<input type="file" accept="image/*,application/pdf" id="fFile" hidden></label></div></div>
    <div class="tags"><span class="lab">${tr('tags')}</span>${(it.tags || []).map((t, i) => `<span class="tag"><button class="tagopen" data-coll="${esc(String(t).toLowerCase())}">${esc(t)}</button><button class="tagx" data-rmtag="${i}" aria-label="${esc(tr('remove'))}">×</button></span>`).join('')}<button class="tag plus" data-act="addtag" aria-label="${esc(tr('newTag'))}">+</button></div>
    <button class="btn quiet block" data-act="sharewhere">${tr('share')}</button>
    ${adSlot('card')}
    <p class="proof">${[it.addedAt ? tr('registered', fmtStamp(it.addedAt), it.addedBy) : '', (it.storedOn || it.addedAt) ? tr('storedSince', it.storedOn || fmtDate(it.addedAt)) : '', it.updatedAt ? tr('changed', fmtStamp(it.updatedAt)) : ''].filter(Boolean).map(esc).join(' ')}</p>
    <button class="btn danger block" data-act="delitem">${tr('delItem')}</button>
    <div class="donebar">${isNew ? `<button class="btn quiet" data-act="saveagain">${tr('saveAnother')}</button>` : ''}<button class="btn primary" data-act="done">${isNew ? tr('save') : tr('done')}</button></div>
    <datalist id="people">${household.map(p => `<option value="${esc(p)}">`).join('')}<option value="${esc(tr('shared'))}"></datalist>
    <datalist id="colours">${COLORS.map(c => `<option value="${esc(showColor(c))}">`).join('')}</datalist>
    <datalist id="seasons">${SEASONS.map(c => `<option value="${esc(showSeason(c))}">`).join('')}</datalist>
    <datalist id="brands">${recentValues('brand').map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;
  const timers = {};
  const conv = (k, v) => {
    v = typeof v === 'string' ? v.trim() : v;
    if (k === 'owner' && v) return v.toLowerCase() === tr('shared').toLowerCase() || v.toLowerCase() === 'shared' ? 'Shared' : addPerson(cap(v));
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
    if (k === 'status' && v !== 'On loan') delete x.loanTo;
    if (v === '' || v == null) delete x[k]; else x[k] = v;
  }, false);
  const RERENDER = ['remindMonths', 'remindAt', 'lastUsed', 'status'];
  flushItem = () => {
    Object.keys(timers).forEach(k => clearTimeout(timers[k]));
    const [x] = curItem(); if (!x) return;
    const nm2 = $('#fName'); if (nm2 && nm2.value.trim() && nm2.value.trim() !== x.name) commit('name', nm2.value);
    app.querySelectorAll('[data-f]').forEach(el => {
      const k = el.dataset.f, [y] = curItem(); if (!y) return;
      const cur = k === 'color' ? showColor(y.color) : k === 'season' ? showSeason(y.season) : k === 'owner' ? showOwner(y.owner) : String(y[k] ?? (k === 'remindMonths' ? 0 : ''));
      if (String(el.value) !== cur) commit(k, el.value);
    });
  };
  app.querySelectorAll('[data-f]').forEach(el => {
    const k = el.dataset.f;
    el.addEventListener('input', () => { if (el.tagName === 'SELECT') return; clearTimeout(timers[k]); timers[k] = setTimeout(() => commit(k, el.value), 700); });
    el.addEventListener('change', () => { clearTimeout(timers[k]); if (RERENDER.includes(k)){ flushItem(); render(); } else commit(k, el.value); });
  });
  const nm = $('#fName');
  nm.addEventListener('input', () => { clearTimeout(timers.name); timers.name = setTimeout(() => commit('name', nm.value), 600); });
  nm.addEventListener('change', () => { clearTimeout(timers.name); commit('name', nm.value); });
  if (app.querySelector('[data-where]')) app.querySelector('[data-where]').addEventListener('change', e => { if (flushItem) flushItem(); moveItemTo(view.boxId, view.itemId, e.target.value); render(); });
  $('#fPhoto').addEventListener('change', async e => {
    const files = [...e.target.files]; if (!files.length) return; toast(tr('savingPhoto'));
    const added = [];
    for (const f of files){ try { added.push(await storePhoto(f)); } catch (err){ toast(saveErr(err)); } }
    if (flushItem) flushItem();
    if (added.length) saveItem(x => { x.photos = (x.photos || []).concat(added); }, true);
  });
  $('#fFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      let blob = f;
      if (f.type.startsWith('image/')){ const cv = await shrink(f, PHOTO_MAX); blob = await toBlob(cv, 'image/webp', PHOTO_QUALITY) || await toBlob(cv, 'image/jpeg', .8); }
      const ref = newId(); await phPut(ref, blob);
      if (flushItem) flushItem();
      saveItem(x => { x.files = (x.files || []).concat({ref, name: f.name.replace(/\.[^.]+$/, '') || tr('attachments'), type: blob.type || f.type, addedAt: new Date().toISOString()}); }, true);
    } catch (err){ toast(saveErr(err)); }
  });
}
async function openFile(f){
  const blob = await phGet(f.ref).catch(() => null); if (!blob) return toast(tr('fileMissing'));
  if ((f.type || blob.type || '').startsWith('image/')) return openViewer(f.ref);
  const u = URL.createObjectURL(blob); const w = window.open(u, '_blank'); if (!w) location.href = u; setTimeout(() => URL.revokeObjectURL(u), 60000);
}
/* ---------- batch: several items from photos, with AI recognition when it's on ---------- */
let batch = null;
const batchRefs = new Set();
function openBatch(boxId){
  batch = {boxId, mode: null, rows: [], busy: 0};
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
async function cropRef(ref, box){
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
  const r = newId(); await phPut(r, out); batchRefs.add(r); return r;
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
  batch.mode = mode;
  const useAI = aiReady();
  for (const file of files){
    let p; try { p = await storePhoto(file); } catch (e){ toast(saveErr(e)); continue; }
    batchRefs.add(p.ref);
    const row = {id: newId(), name: '', photos: [p], fields: {}, include: true, status: useAI ? 'thinking' : 'ready', src: p.ref};
    batch.rows.push(row); render();
    if (!useAI) continue;
    batch.busy++;
    try {
      const found = await recogniseRow(batch.rows, p.ref, mode);
      if (mode === 'multi' && found.length > 1){
        const at = batch.rows.indexOf(row), made = [];
        for (const x of found){
          const c = await cropRef(p.ref, x.box_2d);
          made.push({id: newId(), name: cap(String(x.name || '').trim()), photos: c ? [{ref: c, takenAt: p.takenAt, addedAt: p.addedAt}, p] : [p], fields: fieldsFromAI(x), include: true, status: 'ready', src: p.ref});
        }
        batch.rows.splice(at, 1, ...made);
        toast(tr('batchFound', made.length));
      } else if (found.length){
        row.name = cap(String(found[0].name || '').trim()); row.fields = fieldsFromAI(found[0]); row.status = 'ready';
      } else row.status = 'ready';
    } catch (e){ row.status = 'failed'; row.err = aiErrorText(e); }
    batch.busy--; if (view.name === 'batch') render();
  }
}
function renderBatch(){
  if (!batch || batch.boxId !== view.boxId) batch = {boxId: view.boxId, mode: null, rows: [], busy: 0};
  const b = findBox(batch.boxId);
  const where = b.loose ? `${placeName(b.placeId)}, ${tr('notInBoxShort')}` : `${b.code} ${b.name}`;
  const crumbParts = [crumbSpace(), crumbPlace(b.placeId)].concat(b.loose ? [] : [{label: boxLabel(b), nav: {name: 'box', boxId: b.id}}]);
  const rows = batch.rows, n = rows.filter(r => r.include && r.status !== 'thinking').length;
  const missing = rows.some(r => r.include && r.status !== 'thinking' && !(r.name || '').trim());
  const detail = f => [showColor(f.color), f.brand, f.size && (lang === 'sv' ? 'stl ' : 'size ') + f.size, f.value && kr(f.value), f.category].filter(Boolean).map(esc).join(' · ');
  app.innerHTML = `${crumbs(crumbParts)}
    <h2 class="pagetitle">${tr('batchTitle')}</h2>
    <p class="hint">${esc(tr('batchWhere', where))}</p>
    <p class="hint">${aiReady() ? tr('batchAI') + (ai.provider === 'gemini' ? ' ' + tr('batchPrivacy') : '') : tr('batchNoAI')}</p>
    ${!rows.length ? `<div class="choice col">
      <label class="btn primary big">${ICON.camera}<span>${tr('modeEach')}</span><small>${tr('modeEachHint')}</small><input type="file" accept="image/*" multiple hidden data-batchmode="each"></label>
      <label class="btn primary big">${ICON.box}<span>${tr('modeMulti')}</span><small>${tr('modeMultiHint')}</small><input type="file" accept="image/*" multiple hidden data-batchmode="multi"></label></div>`
    : `<div class="brows">${rows.map((r, i) => `<div class="brow${r.include ? '' : ' off'}">
        <button class="bthumb" data-viewph="${esc(r.photos[0].ref)}">${imgTag(r.photos[0].ref, '')}</button>
        <div class="bmain">${r.status === 'thinking' ? `<p class="hint">${tr('thinking')}</p>` : `<input class="input" data-bname="${i}" value="${esc(r.name)}" placeholder="${esc(tr('namePh'))}" autocapitalize="sentences">
          ${detail(r.fields) ? `<p class="bdet">${detail(r.fields)}</p>` : ''}${r.status === 'failed' ? `<p class="hint">${esc(tr('aiFailed', r.err || ''))}</p>` : ''}`}</div>
        <label class="binc"><input type="checkbox" data-binc="${i}" ${r.include ? 'checked' : ''}><span>${tr('include')}</span></label></div>`).join('')}</div>
      <label class="btn quiet block morebtn">${tr('morePhotos')}<input type="file" accept="image/*" multiple hidden data-batchmode="${batch.mode || 'each'}"></label>`}
    <div class="donebar"><button class="btn quiet" data-act="batchcancel">${tr('cancel')}</button><button class="btn primary" data-act="batchadd" ${n && !batch.busy && !missing ? '' : 'disabled'}>${tr('addN', n)}</button></div>${missing && n ? `<p class="hint needname">${tr('nameNeeded')}</p>` : ''}`;
  app.querySelectorAll('[data-batchmode]').forEach(inp => inp.addEventListener('change', e => { const f = [...e.target.files]; if (f.length) addBatchFiles(f, inp.dataset.batchmode); }));
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
  const b = findBox(batch.boxId), used = new Set();
  let count = 0;
  if (add && b){
    const nb = clone(b), now = new Date().toISOString();
    batch.rows.forEach((r, i) => {
      if (!r.include || r.status === 'thinking') return;
      if (!(r.name || '').trim()) return;
      const it = Object.assign({id: newId(), name: cap((r.name || '').trim()), category: '', value: '', storedOn: today(), notes: '', photos: r.photos, tags: [], addedAt: now, addedBy: me || ''}, r.fields);
      nb.items = (nb.items || []).concat(it); r.photos.forEach(p => used.add(p.ref)); count++;
    });
    snapshot([b.id]); putBox(nb, true);
  }
  const refs = [...batchRefs]; batchRefs.clear();
  refs.forEach(r => { if (!used.has(r)) dropPhoto(r); });
  batch = null;
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
  const refs = bx.flatMap(b => [b.photo && b.photo.ref, ...(b.items || []).flatMap(i => [...(i.photos || []).map(x => x.ref), ...(i.files || []).map(f => f.ref)])]).filter(Boolean);
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
        [tr('col_color')]: showColor(it.color), [tr('col_owner')]: showOwner(it.owner), [tr('col_status')]: [showStatus(it.status), it.loanTo].filter(Boolean).join(' '),
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
  const bits = [it.size && (lang === 'sv' ? 'stl ' : 'size ') + it.size, showOwner(it.owner), showColor(it.color), it.brand, it.category].filter(Boolean);
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
    <button class="lgh-add" data-quickadd="${esc(b.id)}" aria-label="${esc(tr('addItem'))}">+</button></div>`;
}
let quickAddFor = null;
function quickAddRow(b){
  if (quickAddFor !== b.id) return '';
  return `<div class="qadd"><input class="input" id="qaIn" data-qa="${esc(b.id)}" placeholder="${esc(tr('quickAddPh', b.loose ? tr('notInBox').toLowerCase() : b.code))}" autocapitalize="sentences" enterkeyhint="done"><button class="btn primary" data-act="qadone">${tr('done')}</button></div>`;
}
/* the whole place as one grouped list */
/* sorting the list: your own order (drag), A–Ö, last changed, last added, last used */
let listSort = 'manual', boxOrder = {};
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
  return `<div class="sortbar"><span class="lab">${tr('sortBy')}</span><div class="chips">${SORTS.map(k => `<button class="chipbtn small${listSort === k ? ' on' : ''}" data-sort="${k}">${tr('sort_' + k)}</button>`).join('')}</div></div>`;
}
function listHTML(pid){
  const all = orderedGroups(pid);
  const loose = looseOf(pid);
  const outs = outItems(b => b.placeId === pid);
  return `${sortBar()}<div class="lgroups" data-lpid="${esc(pid)}">${all.map(b => `<section class="lgroup" data-gid="${esc(b.id)}">${groupHeader(b)}${rowsHTML(sortItems([...(b.items || [])].filter(it => !isOut(it))).map(it => [it, b]))}${quickAddRow(b)}
      ${!(b.items || []).filter(it => !isOut(it)).length && quickAddFor !== b.id ? `<p class="lempty">${tr('boxEmpty')}</p>` : ''}</section>`).join('')}</div>
    ${all.length > 1 || all.some(b => (b.items || []).length > 1) ? `<p class="swipehint">${tr('listDragHint')}</p>` : ''}
    ${!all.length ? `<p class="hint center">${tr('emptyPlace')}</p>` : ''}
    <div class="lgroup-actions"><button class="btn quiet small" data-act="addhere" data-pid="${esc(pid)}">+ ${tr('boxStorage')}</button>${loose && (loose.items || []).length ? '' : `<button class="btn quiet small" data-quickadd="${esc(ensureLooseId(pid))}">+ ${tr('itemNoBox')}</button>`}</div>
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
  document.body.appendChild(t);
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
  ldragT = setTimeout(() => { off(); if (swipe && swipe.on) return; swipe = null; startListDrag(src, x0, y0, id); }, 420);
});
function startListDrag(src, x, y, pid){
  const isGroup = src.classList.contains('lgroup-h');
  const el = isGroup ? src.closest('.lgroup') : src.closest('.lrow-wrap');
  const r = el.getBoundingClientRect();
  const ghost = el.cloneNode(true); ghost.classList.add('ldrag-ghost');
  Object.assign(ghost.style, {width: r.width + 'px', left: r.left + 'px', top: r.top + 'px'});
  document.body.appendChild(ghost); el.classList.add('ldrag-src');
  const line = document.createElement('div'); line.className = 'ldrop-line'; document.body.appendChild(line);
  ldrag = {isGroup, el, ghost, line, dy: y - r.top, y, target: null, pid};
  lpFired = true; if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
  document.body.classList.add('ldragging');
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
  setTimeout(() => { lpFired = false; }, 300);
  const t = d.target; if (!t) return;
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
function addHereSheet(pid, boxId){
  const b = boxId && findBox(boxId);
  openSheet(`<h3>${esc(b ? tr('addHereBox', `${b.code} ${b.name}`) : tr('addTo', placeName(pid)))}</h3>
    <div class="choice">${b ? `<button class="btn primary big" id="adItem">${ICON.star}<span>${tr('addItem')}</span></button><button class="btn primary big" id="adBox">${ICON.box}<span>${tr('boxInBox')}</span></button>`
      : `<button class="btn primary big" id="adBox">${ICON.box}<span>${tr('boxStorage')}</span></button><button class="btn primary big" id="adItem">${ICON.star}<span>${tr('itemNoBox')}</span></button>`}</div>
    <button class="btn quiet block" id="adBatch">${ICON.camera} ${tr('severalPhotos')}</button>
    <div class="sheet-foot" style="margin-top:12px"><button class="btn quiet" id="adX">${tr('cancel')}</button></div>`);
  $('#adBox').onclick = () => { closeSheet(); boxSheet(null, pid, b ? b.id : null); };
  $('#adItem').onclick = () => { closeSheet(); newItem(b ? b.id : ensureLoose(pid).id); };
  $('#adBatch').onclick = () => { closeSheet(); openBatch(b ? b.id : ensureLoose(pid).id); };
  $('#adX').onclick = closeSheet;
}
function addNavSheet(){
  const v = view;
  if ((v.name === 'box' || v.name === 'item' || v.name === 'batch') && findBox(v.boxId)){ const b = findBox(v.boxId); return b.loose ? addHereSheet(b.placeId) : addHereSheet(b.placeId, b.id); }
  const pid = scopePlace();
  if (pid) return addHereSheet(pid);
  openSheet(`<h3>${tr('whichPlace')}</h3><div class="menu">${places.map(p => `<button class="btn quiet" data-ap="${esc(p.id)}">${placeIcon(p)} ${esc(p.name)}</button>`).join('')}
    <button class="btn quiet" data-ap="new">${tr('addPlace')}</button><button class="btn" data-ap="x">${tr('close')}</button></div>`);
  sheet.querySelector('.menu').onclick = e => {
    const t = e.target.closest('[data-ap]'); if (!t) return;
    if (t.dataset.ap === 'x') return closeSheet();
    if (t.dataset.ap === 'new') return askText(tr('newPlace'), {placeholder: tr('newPlaceHint'), ok: tr('add')}).then(n => { const p = n && addPlace(n); if (p){ goHome(p.id); addHereSheet(p.id); } });
    addHereSheet(t.dataset.ap);
  };
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
  toTrash([[it, b]]);
  const cur = findBox(boxId); const nb = clone(cur); nb.items = nb.items.filter(i => i.id !== itemId); putBox(nb, true);
  toast(tr('inTrash'));
  if (view.name === 'item'){ flushItem = null; itemDraft = null; goBack(); } else render();
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
app.addEventListener('contextmenu', e => { if (e.target.closest('[data-lp], .crate, .ltoken, .mtoken')) e.preventDefault(); });

function backupBanner(){
  const items = boxes.reduce((s, b) => s + (b.items || []).length, 0);
  if (!items) return '';
  const days = lastBackup ? (Date.now() - new Date(lastBackup)) / 864e5 : Infinity;
  if (days < 30) return '';
  return `<p class="backuphint"><span>${esc(tr('backupHint', lastBackup ? fmtDate(lastBackup) : ''))}</span> <button class="linkbtn" data-act="backup">${tr('backupDo')}</button></p>`;
}
function itemRow(it, b){
  const p = (it.photos || [])[0];
  const img = p ? imgTag(p.ref, 'thumb') : `<span class="thumb none icon" aria-hidden="true">${guessIcon(it)}</span>`;
  const sub = [showOwner(it.owner), it.size, showColor(it.color), it.category].filter(Boolean).join(', ');
  return `<li><button class="item" data-item="${esc(it.id)}" data-box="${esc(b.id)}">${img}<span class="item-main"><span class="item-name">${esc(it.name)}</span><span class="item-sub">${esc(sub)}</span></span></button></li>`;
}
function notesHTML(list, title){
  if (!list.length) return '';
  return `<section class="notes"><h2 class="section">${esc(title)}</h2>${list.map(n => `<div class="note">
    <audio controls preload="none" data-note="${esc(n.id)}"></audio>
    <span class="hint">${esc(fmtStamp(n.createdAt))}, ${n.duration} s${n.by ? `, ${esc(n.by)}` : ''}</span>
    <button class="linkbtn" data-notedel="${esc(n.id)}">${tr('del')}</button></div>`).join('')}</section>`;
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
}

app.addEventListener('click', e => {
  if (lpFired){ lpFired = false; e.preventDefault(); return; }
  const pv = e.target.closest('[data-pview]'); if (pv){ placeView = pv.dataset.pview; metaPut('placeView', placeView).catch(() => {}); return render(); }
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
  const so = e.target.closest('[data-sort]'); if (so){ listSort = so.dataset.sort; metaPut('listSort', listSort).catch(() => {}); return render(); }
  const ft = e.target.closest('[data-favtoggle]'); if (ft){ const [bid, iid] = ft.dataset.favtoggle.split(':'); const nb = clone(findBox(bid)), x = nb && nb.items.find(i => i.id === iid); if (!x) return; x.fav = !x.fav; putBox(nb); return; }
  const mo = e.target.closest('[data-more]'); if (mo){ const [bid, iid] = mo.dataset.more.split(':'); return rowMenu(bid, iid); }
  const qa = e.target.closest('[data-quickadd]'); if (qa){ let id = qa.dataset.quickadd; if (id.startsWith('new:')) id = ensureLoose(id.slice(4)).id; quickAddFor = quickAddFor === id ? null : id; render(); setTimeout(() => { const i = $('#qaIn'); if (i) i.focus(); }, 40); return; }
  const t = e.target.closest('[data-nav],[data-goplace],[data-open],[data-item],[data-act],[data-notedel],[data-sub],[data-m],[data-viewph],[data-rmph],[data-viewfile],[data-rmfile],[data-rmtag],[data-used],[data-sell],[data-addopt]'); if (!t) return;
  const d = t.dataset;
  if (d.nav){ const v = JSON.parse(d.nav); if (v.name === 'home') return goHome(v.place === 'all' ? null : v.place); return navigate(v); }
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
  if (d.rmph !== undefined){ const [it] = curItem(); const p = it.photos[+d.rmph]; askConfirm(tr('rmPhotoQ'), tr('remove')).then(y => { if (!y) return; saveItem(x => { x.photos = x.photos.filter(q => q.ref !== p.ref); }, true); dropPhoto(p.ref); }); return; }
  if (d.viewfile !== undefined){ const [it] = curItem(); return openFile(it.files[+d.viewfile]); }
  if (d.rmfile !== undefined){ const [it] = curItem(); const f = it.files[+d.rmfile]; askConfirm(tr('rmQ', f.name), tr('remove')).then(y => { if (!y) return; saveItem(x => { x.files = x.files.filter(q => q.ref !== f.ref); }, true); dropPhoto(f.ref); }); return; }
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
    case 'addhere': addHereSheet(d.pid || scopePlace() || places[0].id); break;
    case 'additem': newItem(b.id); break;
    case 'batch': openBatch(b.id); break;
    case 'batchcancel': finishBatch(false); break;
    case 'batchadd': finishBatch(true); break;
    case 'editbox': boxSheet(b.id); break;
    case 'label': labels([b]); break;
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
    case 'ics': { if (flushItem) flushItem(); const [it3, b3] = curItem(); if (it3) calendarFile(it3, b3); break; }
    case 'moveitem2': if (flushItem) flushItem(); moveItemSheet(view.boxId, view.itemId); break;
    case 'itemout': if (flushItem) flushItem(); setOut(view.boxId, view.itemId, true); break;
    case 'itemback': if (flushItem) flushItem(); setOut(view.boxId, view.itemId, false); break;
    case 'qadone': { const i = $('#qaIn'); if (i && i.value.trim()) quickAdd(i.dataset.qa, i.value); quickAddFor = null; render(); break; }
    case 'subbox': boxSheet(null, b.placeId, b.id); break;
    case 'placement': placementSheet(b.id); break;
    case 'doorside': doorSheet(currentPlace); break;
    case 'newzone': addZone(currentPlace); break;
    case 'addloose': newItem(ensureLoose(d.pid || currentPlace).id); break;
    case 'addzone': boxSheet(null, currentPlace !== 'all' ? currentPlace : places[0].id, null, d.zone); break;
    case 'saveagain': finishItem(true); break;
    case 'addtag': if (flushItem) flushItem(); askText(tr('newTag'), {placeholder: tr('tagHint'), ok: tr('add')}).then(tg => { if (tg) saveItem(x => { x.tags = [...new Set([...(x.tags || []), tg.toLowerCase()])]; }, true); }); break;
  }
});
document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  if (b.dataset.tab === 'add') return addNavSheet();
  if (b.dataset.tab === 'home') return goHome(currentPlace !== 'all' ? currentPlace : null);
  if (b.dataset.tab === 'search'){ navigate({name: 'search'}); setTimeout(() => { const s = $('#q'); if (s) s.focus(); }, 50); return; }
  navigate({name: 'profile'});
});
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
}
function closeSheet(){ if (sheet.open) sheet.close(); }
sheet.addEventListener('close', () => { if (sheet.open) return; const f = onSheetClose; onSheetClose = null; if (f) f(); });
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function photoState(initial, multiple){
  const st = {photos: clone(initial), added: [], removed: [], busy: false};
  const draw = () => {
    const w = $('#phwrap');
    w.innerHTML = `<div class="photos">${st.photos.map((p, i) => `<div class="ph">${imgTag(p.ref, '')}<button data-rm="${i}" aria-label="${tr('rmPhoto')}">×</button></div>`).join('')}
      ${multiple || !st.photos.length ? `<label class="addph">${tr('addPhoto')}<input type="file" accept="image/*" ${multiple ? 'multiple' : ''}></label>` : ''}</div>`;
    hydrate(w);
  };
  st.mount = () => {
    draw();
    $('#phwrap').addEventListener('change', async e => {
      if (!e.target.files) return;
      const files = [...e.target.files]; st.busy = true;
      $('#phwrap').insertAdjacentHTML('beforeend', `<p class="hint">${tr('savingPhoto')}</p>`);
      for (const f of files){
        try { const p = await storePhoto(f); st.photos.push(p); st.added.push(p.ref); }
        catch (err) { toast(saveErr(err)); }
      }
      st.busy = false; draw();
    });
    $('#phwrap').addEventListener('click', e => {
      const im = e.target.closest('img[data-ph]'); if (im) return openViewer(im.dataset.ph);
      const rm = e.target.closest('[data-rm]'); if (!rm) return;
      const [p] = st.photos.splice(+rm.dataset.rm, 1);
      if (st.added.includes(p.ref)){ st.added = st.added.filter(r => r !== p.ref); dropPhoto(p.ref); } else st.removed.push(p.ref);
      draw();
    });
  };
  st.commit = () => { st.removed.forEach(dropPhoto); st.added = []; st.removed = []; };
  st.discard = () => { st.added.forEach(dropPhoto); st.added = []; };
  return st;
}

function boxSheet(id, presetPid, presetParent, presetZone){
  const existing = id ? findBox(id) : null;
  const b = existing ? clone(existing) : {id: newId(), code: '', name: '', location: '', notes: '', items: [], createdAt: new Date().toISOString(), placeId: presetPid || scopePlace() || places[0].id, parentId: presetParent || null, autoName: true};
  if (presetParent && findBox(presetParent)) b.placeId = findBox(presetParent).placeId;
  if (!existing) b.code = nextCode(b.placeId);
  if (!existing && presetZone) b.location = presetZone;
  const ps = photoState(b.photo ? [b.photo] : [], false);
  const banned = existing ? new Set([existing.id, ...descendants(existing.id).map(x => x.id)]) : new Set();
  const parentOpts = pid => `<option value="">${esc(tr('topLevel', placeName(pid)))}</option>` + boxesIn(pid).filter(x => !banned.has(x.id)).sort(byCode).map(x => `<option value="${esc(x.id)}" ${x.id === b.parentId ? 'selected' : ''}>${esc(x.code)} ${esc(x.name)}</option>`).join('');
  let saved = false;
  openSheet(`<h3>${existing ? tr('editBoxH') : tr('newBox')} <span class="chip" id="bCode">${esc(b.code)}</span></h3>
    <label class="field"><span>${tr('name')}</span><input id="bName" value="${esc(b.autoName ? '' : b.name)}" placeholder="${esc(tr('nameOptional'))}"></label>
    <div class="row2">
      <label class="field"><span>${tr('storagePlace')}</span><select id="bPlace">${places.map(p => `<option value="${esc(p.id)}" ${p.id === b.placeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field"><span>${tr('inside')}</span><select id="bParent">${parentOpts(b.placeId)}</select></label>
    </div>
    <label class="field"><span>${tr('zone')}</span><input id="bLoc" list="bzones" value="${esc(b.location)}" placeholder="${esc(tr('zoneHint'))}"><datalist id="bzones">${zonesOf(b.placeId).filter(Boolean).map(z => `<option value="${esc(z)}">`).join('')}</datalist></label>
    <label class="field"><span>${tr('notes')}</span><textarea id="bNotes">${esc(b.notes)}</textarea></label>
    <div class="field"><span>${tr('boxPhoto')}</span><div id="phwrap"></div></div>
    <div class="sheet-foot">
      ${existing ? `<button class="btn danger" id="bDel">${tr('delBox')}</button><span class="spacer"></span>` : ''}
      <button class="btn quiet" id="bCancel">${tr('cancel')}</button>
      <button class="btn primary" id="bSave">${existing ? tr('saveBox') : tr('addBox')}</button>
    </div>`, () => { if (!saved) ps.discard(); });
  ps.mount();
  $('#bPlace').onchange = e => { const pid = e.target.value; $('#bParent').innerHTML = parentOpts(pid); if (!existing){ b.code = nextCode(pid); $('#bCode').textContent = b.code; } };
  $('#bCancel').onclick = closeSheet;
  $('#bSave').onclick = () => {
    if (ps.busy) return toast(tr('waitPhoto'));
    const name = $('#bName').value.trim();
    const newPlace = $('#bPlace').value, parent = $('#bParent').value || null;
    if (existing && newPlace !== existing.placeId && numbering === 'place' && realBoxes().some(x => x.placeId === newPlace && x.code === b.code && x.id !== b.id)) b.code = nextCode(newPlace);
    b.autoName = !name; b.name = name || autoBoxName(b);
    const zoneWas = (b.location || '').trim();
    b.location = $('#bLoc').value.trim(); b.notes = $('#bNotes').value.trim(); b.placeId = newPlace; b.parentId = parent;
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
  return main.map(field).join('') + `<details class="more" ${moreOpen ? 'open' : ''}><summary>More details</summary>${rest.map(field).join('')}</details>`;
}
function addPerson(name){
  name = (name || '').trim(); if (!name) return '';
  const hit = household.find(h => h.toLowerCase() === name.toLowerCase()); if (hit) return hit;
  household.push(name); metaPut('household', household).catch(() => {}); return name;
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
        if (r && r.data && r.data.startsWith('BOXES:id:')){ const bx = findBox(r.data.slice(9)); if (bx){ closeSheet(); openBox(bx.id); return; } }
        else if (r && r.data && r.data.startsWith('BOXES:') && go(r.data.slice(6))) return;
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
    || `<p class="hint">${L() === 'sv' ? 'Tryck på knappen och säg vad du gör, till exempel “öppna låda 3”.' : 'Tap the button and say what you’re doing, for example “open box 3”.'}</p>`;
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
  el.textContent = b ? `${sv ? 'Öppen låda' : 'Open box'}: ${b.code} ${b.name}${places.length > 1 ? ` (${placeName(b.placeId)})` : ''}`
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
    if (a.color) x.color = a.color; if (a.size) x.size = a.size; if (a.owner) x.owner = a.owner;
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
  const cm = subject.replace(/^(?:hela|samlingen|the|whole|collection)\s+/i, '').replace(/\s+(?:collection|samlingen)$/i, '').replace(/^#/, '').toLowerCase();
  const coll = collectionsAll().find(c => c.tag === cm || stems(cm).includes(c.tag) || stems(c.tag).includes(cm));
  if (coll && (/#|hela|samling|whole|collection/i.test(subject) || !findIn(subject))){ setOutMany(coll.list, out, null, '#' + tagLabel(coll.tag)); return say(out ? t('collOutV', {c: tagLabel(coll.tag), n: coll.list.length}) : t('collBackV', {c: tagLabel(coll.tag)})); }
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
    if (a.size) it.size = a.size; if (a.owner) it.owner = a.owner; if (a.color) it.color = a.color;
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
  btn.textContent = state === 'on' ? (L() === 'sv' ? 'Lyssnar… tryck när du är klar' : 'Listening… tap when you’re done') : (L() === 'sv' ? 'Tryck och prata' : 'Tap and speak');
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
  if (rec) return toast('Stop the voice note first.');
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
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Recording isn’t available in this browser.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
  catch { return toast('Microphone access is blocked. Allow it for Storrrage in Chrome’s site settings.'); }
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
  openSheet(`<h3>${tr('talkH')}</h3>
    <p class="hint" id="vCtx"></p>
    <p class="aistat" id="vAI"></p>
    <div class="vlog" id="vlog" aria-live="polite"></div>
    <div class="vlive" id="vLive" hidden></div>
    ${SR ? '<button class="mic" id="micBtn"></button>' : `<p class="hint">${tr('noSR')}</p>`}
    <div class="vtype"><input id="vText" enterkeyhint="send" autocomplete="off"><button class="btn primary" id="vSend">${tr('send')}</button></div>
    <div class="vrow">
      <button class="btn quiet" id="recBtn"></button>
      <span class="chips" style="margin:0"><button type="button" class="chipbtn" data-lang="sv-SE">Svenska</button><button type="button" class="chipbtn" data-lang="en-US">English</button></span>
    </div>
    <label class="check"><input type="checkbox" id="vSpeak" ${speakOn ? 'checked' : ''}> ${tr('readAloud')}</label>
    ${SR ? `<div class="field"><span>${tr('pause')}</span><div class="chips" id="vPause">${SILENCE_CHOICES.map(([ms, l]) => `<button type="button" class="chipbtn${ms === silenceMs ? ' on' : ''}" data-ms="${ms}">${l}</button>`).join('')}</div></div>` : ''}
    <details class="more"><summary>${tr('whatSay')}</summary><ul class="help" id="vHelp"></ul></details>
    <details class="more"><summary>${tr('noSignal')}</summary><p class="hint">${tr('noSignalTxt')}</p></details>
    <div class="sheet-foot"><button class="btn" id="vClose">${tr('close')}</button></div>`, () => { stopListening(); if (rec) rec.stop(); if (window.speechSynthesis) speechSynthesis.cancel(); });
  const drawLang = () => {
    sheet.querySelectorAll('[data-lang]').forEach(c => c.classList.toggle('on', c.dataset.lang === voiceLang));
    $('#vHelp').innerHTML = HELP[L()].map(h => `<li>“${esc(h)}”</li>`).join('');
    $('#vText').placeholder = vPlaceholder(); setMic('off'); drawLog();
  };
  drawLang(); updateCtx(); updRecBtn();
  const drawAI = () => { $('#vAI').innerHTML = ai.provider === 'off' ? `${lang === 'sv' ? 'Enkla kommandon.' : 'Simple commands.'} <button class="linkbtn" id="vAIset">${lang === 'sv' ? 'Slå på AI' : 'Turn on AI'}</button>` : `AI: ${esc(AI_LABEL[ai.provider])}${navigator.onLine ? '' : (lang === 'sv' ? ' (offline, enkla kommandon)' : ' (offline, using simple commands)')}. <button class="linkbtn" id="vAIset">${tr('settings')}</button>`; $('#vAIset').onclick = aiSheet; };
  drawAI();
  if (SR) $('#micBtn').onclick = listen;
  const send = () => { const v = $('#vText'); const x = v.value; v.value = ''; if (x.trim()) handleBatch(x); };
  if (SR) $('#vPause').onclick = e => {
    const c = e.target.closest('[data-ms]'); if (!c) return;
    silenceMs = +c.dataset.ms; metaPut('silenceMs', silenceMs).catch(() => {});
    $('#vPause').querySelectorAll('[data-ms]').forEach(x => x.classList.toggle('on', +x.dataset.ms === silenceMs));
  };
  $('#vSend').onclick = send;
  $('#vText').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('#recBtn').onclick = toggleRecord;
  $('#vSpeak').onchange = e => { speakOn = e.target.checked; if (!speakOn && window.speechSynthesis) speechSynthesis.cancel(); };
  sheet.querySelector('.vrow').addEventListener('click', e => {
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
  if (s.owner !== undefined){ const o = str(s.owner); set('owner', o ? (o.toLowerCase() === 'shared' ? 'Shared' : addPerson(cap(o))) : ''); }
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
  if (aiBusy) return toast('Still thinking about the last thing you said.');
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
  const ls = [...list].sort(byCode).map(b => `<div class="l"><div class="q">${qrSvg(labelText(b), 6)}</div><div><div class="c">${esc(b.code)}</div><div class="n">${esc(b.name)}</div></div></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Box labels</title><style>
    body{font-family:Arial,sans-serif;margin:12mm}.g{display:grid;grid-template-columns:1fr 1fr;gap:8mm}
    .l{border:1.5px dashed #888;padding:6mm;display:flex;gap:6mm;align-items:center;break-inside:avoid}
    .q{width:34mm;height:34mm;flex:none}.q svg{width:100%;height:100%}.c{font:900 30pt/1 Impact,Arial Black,sans-serif}.n{font-size:12pt;margin-top:2mm}
    p{color:#555}@media print{p{display:none}}</style></head><body><p>Print this page, cut out the labels and tape them to the boxes.</p><div class="g">${ls}</div></body></html>`;
  deliver(list.length === 1 ? `label-${list[0].code}.html` : 'box-labels.html', new Blob([html], {type: 'text/html'}), list.length === 1 ? `${tr('label')} ${list[0].code}` : tr('labelsAllH'));
}
async function thumbData(ref){
  try { const b = await phGet(ref); if (!b) return ''; return (await shrink(b, 360)).toDataURL('image/jpeg', .72); }
  catch { return ''; }
}
async function insuranceReport(){
  if (!boxes.length) return toast('Add some boxes first.');
  toast('Building the report…');
  const pi = b => places.findIndex(p => p.id === b.placeId);
  const all = [...boxes].filter(b => !b.loose || (b.items || []).length).sort((x, y) => pi(x) - pi(y) || (x.loose ? -1 : 0) - (y.loose ? -1 : 0) || byCode(x, y));
  const total = all.reduce((s, b) => s + boxValue(b), 0);
  let body = '';
  for (const b of all){
    let rows = '';
    for (const it of (b.items || [])){
      const imgs = [];
      for (const p of (it.photos || [])){ const d = await thumbData(p.ref); if (d) imgs.push(`<img src="${d}" alt=""><br><small>Photo ${esc(fmtStamp(p.takenAt))}</small>`); }
      rows += `<tr><td><b>${esc(it.name)}</b>${it.category ? `<br>${esc(it.category)}` : ''}${it.notes ? `<br><small>${esc(it.notes)}</small>` : ''}</td>
        <td>${esc(kr(it.value))}</td><td>${esc(it.storedOn)}</td><td>${esc(fmtStamp(it.addedAt))}</td><td class="ph">${imgs.join('<br>')}</td></tr>`;
    }
    const bimg = b.photo ? await thumbData(b.photo.ref) : '';
    body += `<section><h2>${b.loose ? `${esc(placeName(b.placeId))}: not in a box` : `${esc(b.code)} ${esc(b.name)}`}</h2><p>${esc([placeName(b.placeId), b.location].filter(Boolean).join(', '))}. Packed ${esc(fmtDate(b.createdAt))}. ${(b.items || []).length} items, ${esc(kr(boxValue(b)) || '0 kr')}.</p>
      ${bimg ? `<img class="box" src="${bimg}" alt="">` : ''}
      ${rows ? `<table><tr><th>Item</th><th>Est. value</th><th>Stored since</th><th>Registered</th><th>Photos</th></tr>${rows}</table>` : '<p>Empty.</p>'}</section>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Storage inventory ${today()}</title><style>
    body{font-family:Arial,sans-serif;margin:14mm;color:#111}h1{margin:0}table{border-collapse:collapse;width:100%;margin:8px 0 24px}
    th,td{border:1px solid #bbb;padding:6px;vertical-align:top;text-align:left;font-size:10pt}td.ph img{width:110px}img.box{width:200px}
    section{break-inside:avoid-page}small{color:#555}</style></head><body>
    <h1>Storage inventory</h1><p>Generated ${esc(fmtStamp(new Date().toISOString()))}. ${all.filter(b => !b.loose).length} boxes, ${all.reduce((s, b) => s + (b.items || []).length, 0)} items, estimated total value ${esc(kr(total) || '0 kr')}.</p>
    <p>"Registered" is when the item was entered in the inventory. Photo times come from the image file.</p>${body}</body></html>`;
  deliver(`storage-inventory-${today()}.html`, new Blob([html], {type: 'text/html'}), 'Insurance report ready');
}
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function backup(){
  if (!boxes.length && !notes.length) return toast('Nothing to back up yet.');
  toast('Preparing backup…');
  const photos = {};
  const refs = boxes.flatMap(b => [b.photo && b.photo.ref, ...(b.items || []).flatMap(i => (i.photos || []).map(p => p.ref))]).filter(Boolean);
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
    const data = JSON.parse(await f.text()); const list = Array.isArray(data) ? data : data.boxes;
    if (!Array.isArray(list)) throw 0;
    toast('Restoring…');
    let n = 0;
    for (const b of list){
      if (!b || !b.id || !b.code || findBox(b.id)) continue;
      const refs = [b.photo && b.photo.ref, ...(b.items || []).flatMap(i => (i.photos || []).map(p => p.ref))].filter(Boolean);
      for (const r of refs){ const d = data.photos && data.photos[r]; if (d) await phPut(r, await (await fetch(d)).blob()); }
      putBox(b); n++;
    }
    (data.household || []).forEach(addPerson);
    (data.places || []).forEach(p => { if (p && p.id && !findPlace(p.id)){ places.push(p); } }); metaPut('places', places).catch(() => {});
    boxes.forEach(b => { if (!b.placeId || !findPlace(b.placeId)){ b.placeId = places[0].id; dbPut(clone(b)).catch(() => {}); } });
    let k = 0;
    for (const x of (data.notes || [])){
      if (!x || !x.id || notes.some(y => y.id === x.id) || !x.audio) continue;
      const nn = {id: x.id, boxId: x.boxId || null, createdAt: x.createdAt, duration: x.duration || 0, by: x.by || '', blob: await (await fetch(x.audio)).blob()};
      await notePut(nn); notes.push(nn); k++;
    }
    updateStatus(); render();
    toast(n || k ? `Restored ${n} ${n === 1 ? 'box' : 'boxes'}${k ? ` and ${k} voice ${k === 1 ? 'note' : 'notes'}` : ''}.` : 'Everything in that backup is already here.');
  } catch { toast('That file isn’t a Storrrage backup.'); }
});
function menuSheet(){
  openSheet(`<h3>${tr('menu')}</h3><div class="menu">
    <div class="field" style="margin:0 0 6px"><span>${tr('language')}</span>${langSwitch()}</div>
    <button class="btn quiet" data-m="scan">${tr('scanLabel')}</button>
    <button class="btn quiet" data-m="backup">${tr('backupNow')}</button>
    <button class="btn quiet" data-m="export">${tr('export')}</button>
    <button class="btn quiet" data-m="ai">${tr('aiAssistant')}${ai.provider !== 'off' ? `: ${esc(AI_LABEL[ai.provider])}` : ''}</button>
    <button class="btn quiet" data-m="trash">${ICON.trash} ${tr('trash')}${trash.length ? ` (${trash.length})` : ''}</button>
    <button class="btn quiet" data-m="settings">${tr('allSettings')}</button>
    <button class="btn" data-m="close">${tr('close')}</button>
    <p class="proof center" style="margin:8px 0 0">${tr('version', APP_VERSION)}</p></div>`);
  sheet.querySelector('.menu').onclick = e => {
    const m = e.target.closest('[data-m]'); if (!m) return; const k = m.dataset.m;
    if (k === 'close') return closeSheet();
    if (k === 'settings'){ closeSheet(); return navigate({name: 'profile', sub: 'settings'}); }
    if (k === 'import') closeSheet();
    settingsAction(k);
  };
}

/* ---------- start ---------- */
async function init(){
  render();
  try {
    idb = await openDB();
    boxes = await dbAll();
    lastBackup = await metaGet('lastBackup') || null;
    household = await metaGet('household') || [];
    me = await metaGet('me') || '';
    voiceLang = await metaGet('voiceLang') || voiceLang;
    lang = await metaGet('lang') || (voiceLang.startsWith('sv') ? 'sv' : lang);
    { const s = await metaGet('silenceMs'); if (typeof s === 'number') silenceMs = s; }
    ai = await metaGet('ai') || ai;
    numbering = await metaGet('numbering') || 'place';
    viewMode = await metaGet('viewMode') || 'grid';
    listSort = await metaGet('listSort') || 'manual'; boxOrder = await metaGet('boxOrder') || {};
    trash = await metaGet('trash') || []; purgeTrash();
    placeView = await metaGet('placeView') || 'shelf';
    shelfMode = await metaGet('shelfMode') || 'grid';
    recentQ = await metaGet('recentQ') || [];
    nudgeSnooze = await metaGet('nudgeSnooze') || {};
    { const ap = await metaGet('adsPreview'); if (typeof ap === 'boolean') adsPreview = ap; }
    recents = await metaGet('recent') || [];
    notes = await noteAll();
    places = await metaGet('places') || [];
    if (!places.length){ places = [{id: newId(), name: (navigator.language || '').toLowerCase().startsWith('sv') ? 'Källaren' : 'Basement', createdAt: new Date().toISOString()}]; await metaPut('places', places); }
    for (const b of boxes) if (!b.placeId || !findPlace(b.placeId)){ b.placeId = places[0].id; await dbPut(clone(b)); }
    currentPlace = await metaGet('currentPlace') || 'all';
    if (currentPlace !== 'all' && !findPlace(currentPlace)) currentPlace = 'all';
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch {
    app.innerHTML = '<p class="status">This browser won’t let Storrrage store data. Open it in Chrome, not in a private tab.</p>'; return;
  }
  ready = true; updateStatus();
  const hasStuff = boxes.some(b => !b.loose || (b.items || []).length);
  if (!me && !hasStuff && !(await metaGet('onboarded').catch(() => false))) view = {name: 'welcome'};
  else view = {name: 'home', place: currentPlace};
  try { history.replaceState({root: 1}, ''); } catch {}
  render(); arm();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
init();
})();
