// Estação Jaú-1 — busca clima, notícias e jogos do São Paulo e grava data.json.
// Roda sozinho no GitHub Actions a cada 30 minutos (.github/workflows/dados.yml).
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';

const SPFC = '2026'; // id do São Paulo na ESPN

async function get(url, type = 'json') {
  const r = await fetch(url, { headers: { 'user-agent': 'estacao-jau-1/1.0' } });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return type === 'json' ? r.json() : r.text();
}
const safe = (p, fallback) => p.catch(e => { console.error(String(e)); return fallback; });

/* ---------- clima (Open-Meteo, Jaú) ---------- */
function wmo(c) {
  if (c === 0) return ['sol', 'Céu limpo'];
  if (c <= 2) return ['sol', 'Poucas nuvens'];
  if (c === 3) return ['nuvens', 'Nublado'];
  if (c <= 48) return ['nuvens', 'Neblina'];
  if (c <= 67 || (c >= 80 && c <= 82)) return ['chuva', 'Chuva'];
  if (c >= 95) return ['chuva', 'Tempestade'];
  return ['nuvens', 'Tempo instável'];
}
async function clima() {
  const j = await get('https://api.open-meteo.com/v1/forecast?latitude=-22.296&longitude=-48.558'
    + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min'
    + '&timezone=America%2FSao_Paulo&forecast_days=1');
  const [cond, texto] = wmo(j.current.weather_code);
  return {
    temp: Math.round(j.current.temperature_2m),
    max: Math.round(j.daily.temperature_2m_max[0]),
    min: Math.round(j.daily.temperature_2m_min[0]),
    cond, texto
  };
}

/* ---------- notícias (g1) ---------- */
function limpar(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).trim();
}
async function rss(url, n) {
  const x = await get(url, 'text');
  return [...x.matchAll(/<item[\s>][\s\S]*?<title>([\s\S]*?)<\/title>/g)].map(m => limpar(m[1])).filter(Boolean).slice(0, n);
}
async function noticias() {
  const [tec, mundo] = await Promise.all([
    safe(rss('https://g1.globo.com/rss/g1/tecnologia/', 5), []),
    safe(rss('https://g1.globo.com/rss/g1/mundo/', 5), [])
  ]);
  const out = [];
  for (let i = 0; i < 5; i++) {
    if (tec[i]) out.push('Tecnologia: ' + tec[i]);
    if (mundo[i]) out.push('Mundo: ' + mundo[i]);
  }
  return out;
}

/* ---------- jogos do São Paulo (ESPN) ---------- */
function campeonato(nome) {
  const n = (nome || '').toLowerCase();
  if (n.includes('serie a') || n.includes('série a')) return 'Brasileirão';
  if (n.includes('copa do brasil')) return 'Copa do Brasil';
  if (n.includes('libertadores')) return 'Libertadores';
  if (n.includes('sudamericana')) return 'Sul-Americana';
  if (n.includes('paulista')) return 'Paulistão';
  return nome || '';
}
function jogo(e) {
  const c = e.competitions[0];
  const casa = c.competitors.find(x => x.homeAway === 'home');
  const fora = c.competitors.find(x => x.homeAway === 'away');
  const placar = x => x.score == null ? null : (typeof x.score === 'object' ? (x.score.displayValue ?? x.score.value) : x.score);
  const pc = placar(casa), pf = placar(fora);
  return {
    quando: e.date,
    casa: casa.team.shortDisplayName, fora: fora.team.shortDisplayName,
    siglaCasa: casa.team.abbreviation, siglaFora: fora.team.abbreviation,
    emCasa: casa.team.id === SPFC,
    campeonato: campeonato(e.league && e.league.name),
    local: (c.venue && c.venue.fullName) || '',
    placar: pc != null && pf != null ? pc + '×' + pf : null,
    estado: c.status && c.status.type ? c.status.type.state : null
  };
}
async function jogos() {
  const base = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/' + SPFC + '/schedule';
  const [prox, ant] = await Promise.all([get(base + '?fixture=true'), safe(get(base), { events: [] })]);
  const agora = Date.now();
  const futuros = (prox.events || []).map(jogo)
    .filter(g => new Date(g.quando).getTime() > agora - 3 * 3600e3)
    .sort((a, b) => new Date(a.quando) - new Date(b.quando));
  const passados = (ant.events || []).map(jogo)
    .filter(g => g.estado === 'post' && g.placar)
    .sort((a, b) => new Date(b.quando) - new Date(a.quando));
  return { proximo: futuros[0] || null, seguintes: futuros.slice(1, 3), ultimo: passados[0] || null };
}

/* ---------- agenda (Google Agenda, endereço secreto iCal) ----------
   O endereço fica guardado no segredo GOOGLE_AGENDA_URL do repositório e os
   compromissos saem CRIPTOGRAFADOS com a chave do segredo CHAVE_ESTACAO,
   porque este repositório é público. Só quem tem a chave (a TV) consegue ler. */
const OFFSET = -3 * 3600e3; // horário de Brasília (sem horário de verão desde 2019)
function desdobrar(txt) { return txt.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }
function textoIcs(s) { return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }
function dataIcs(params, v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, Y, M, D, h = '00', mi = '00', s = '00', z] = m;
  const utc = Date.UTC(+Y, +M - 1, +D, +h, +mi, +s);
  return { ms: z ? utc : utc - OFFSET, diaInteiro: !m[4] || /VALUE=DATE(?!-)/.test(params) };
}
function lerEventos(txt) {
  const eventos = []; let ev = null;
  for (const linha of desdobrar(txt)) {
    if (linha === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (linha === 'END:VEVENT') { if (ev && ev.inicio) eventos.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = linha.indexOf(':'); if (i < 0) continue;
    const chave = linha.slice(0, i), valor = linha.slice(i + 1);
    const nome = chave.split(';')[0], params = chave.slice(nome.length);
    if (nome === 'DTSTART') ev.inicio = dataIcs(params, valor);
    else if (nome === 'DTEND') ev.fim = dataIcs(params, valor);
    else if (nome === 'SUMMARY') ev.titulo = textoIcs(valor);
    else if (nome === 'RRULE') ev.rrule = Object.fromEntries(valor.split(';').map(p => p.split('=')));
    else if (nome === 'EXDATE') valor.split(',').forEach(v => { const d = dataIcs(params, v); if (d) ev.exdates.push(d.ms); });
    else if (nome === 'RECURRENCE-ID') ev.recId = dataIcs(params, valor);
    else if (nome === 'UID') ev.uid = valor;
    else if (nome === 'STATUS') ev.status = valor;
  }
  return eventos;
}
const DIAS_RR = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function ocorrencias(ev, de, ate) {
  const ini = ev.inicio.ms, dur = ev.fim ? Math.max(0, ev.fim.ms - ini) : 0;
  if (!ev.rrule) return [ini];
  const r = ev.rrule, passo = +(r.INTERVAL || 1), limite = r.COUNT ? +r.COUNT : Infinity;
  const ateR = r.UNTIL ? Math.min(ate, dataIcs('', r.UNTIL).ms + (r.UNTIL.length === 8 ? 864e5 - 1 : 0)) : ate;
  const local = new Date(ini + OFFSET); // campos UTC = hora de Brasília
  const hms = ini + OFFSET - Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()); // hora do dia
  const diaEm = (Y, M, D) => Date.UTC(Y, M, D) - OFFSET + hms;
  const out = []; let n = 0;
  const add = ms => { if (ms < ini) return true; n++; if (n > limite || ms > ateR) return false; if (ms + dur >= de) out.push(ms); return true; };
  const freq = r.FREQ, byday = r.BYDAY ? r.BYDAY.split(',') : null;
  // pula direto para perto da janela (eventos repetidos antigos), quando não há COUNT
  const periodo = { DAILY: 864e5, WEEKLY: 7 * 864e5, MONTHLY: 31 * 864e5, YEARLY: 366 * 864e5 }[freq] * passo;
  const k0 = !r.COUNT && periodo ? Math.max(0, Math.floor((de - ini) / periodo) - 2) : 0;
  for (let k = k0; k < k0 + 3000; k++) {
    const Y = local.getUTCFullYear(), M = local.getUTCMonth(), D = local.getUTCDate();
    let lote = [];
    if (freq === 'DAILY') lote = [diaEm(Y, M, D + k * passo)];
    else if (freq === 'WEEKLY') {
      const semana = D - local.getUTCDay() + k * 7 * passo; // domingo da semana
      lote = (byday || [Object.keys(DIAS_RR)[local.getUTCDay()]]).map(b => diaEm(Y, M, semana + DIAS_RR[b.slice(-2)])).sort((a, b) => a - b);
    } else if (freq === 'MONTHLY') {
      const mes = M + k * passo;
      if (byday && /^-?\d/.test(byday[0])) {
        const ord = parseInt(byday[0], 10), wd = DIAS_RR[byday[0].slice(-2)];
        if (ord > 0) { const p = new Date(Date.UTC(Y, mes, 1)).getUTCDay(); lote = [diaEm(Y, mes, 1 + ((wd - p + 7) % 7) + (ord - 1) * 7)]; }
        else { const u = new Date(Date.UTC(Y, mes + 1, 0)); lote = [diaEm(Y, mes + 1, -((u.getUTCDay() - wd + 7) % 7))]; }
      } else if (new Date(Date.UTC(Y, mes, D)).getUTCDate() === D) lote = [diaEm(Y, mes, D)];
    } else if (freq === 'YEARLY') lote = [diaEm(Y + k * passo, M, D)];
    else return [ini];
    let continuar = true;
    for (const ms of lote) { if (!add(ms)) { continuar = false; break; } }
    if (!continuar || (lote.length && lote[0] > ateR)) break;
  }
  return out.filter(ms => !ev.exdates.includes(ms));
}
async function agenda() {
  const url = process.env.GOOGLE_AGENDA_URL;
  if (!url) return null;
  const txt = await get(url, 'text');
  const todos = lerEventos(txt).filter(e => e.status !== 'CANCELLED');
  const de = Date.now() - 864e5, ate = Date.now() + 8 * 864e5;
  const trocados = new Set(todos.filter(e => e.recId).map(e => e.uid + '@' + e.recId.ms));
  const lista = [];
  for (const ev of todos) {
    const dur = ev.fim ? ev.fim.ms - ev.inicio.ms : 0;
    for (const ms of ocorrencias(ev, de, ate)) {
      if (!ev.recId && trocados.has(ev.uid + '@' + ms)) continue;
      if (ms > ate || ms + dur < de) continue;
      lista.push({ inicio: new Date(ms).toISOString(), fim: new Date(ms + dur).toISOString(), titulo: ev.titulo || '(sem título)', diaInteiro: ev.inicio.diaInteiro });
    }
  }
  lista.sort((a, b) => a.inicio.localeCompare(b.inicio));
  return lista.slice(0, 60);
}
function cifrar(obj, senha) {
  const sal = randomBytes(16), iv = randomBytes(12);
  const chave = pbkdf2Sync(senha, sal, 60000, 32, 'sha256');
  const c = createCipheriv('aes-256-gcm', chave, iv);
  const dados = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, sal: sal.toString('base64'), iv: iv.toString('base64'), dados: dados.toString('base64') };
}

/* ---------- junta tudo ---------- */
const anterior = await readFile('data.json', 'utf8').then(JSON.parse).catch(() => ({}));
const [c, n, j, ag] = await Promise.all([safe(clima(), null), safe(noticias(), []), safe(jogos(), null), safe(agenda(), null)]);
const senha = process.env.CHAVE_ESTACAO;
const dados = {
  atualizado: new Date().toISOString(),
  clima: c || anterior.clima || null,
  noticias: n.length ? n : (anterior.noticias || []),
  jogos: j || anterior.jogos || null,
  privado: ag && senha ? cifrar({ eventos: ag }, senha) : (anterior.privado || null)
};
await writeFile('data.json', JSON.stringify(dados, null, 1) + '\n');
console.log('ok:', dados.clima ? dados.clima.temp + '°C' : 'sem clima', '|', dados.noticias.length, 'notícias |',
  dados.jogos && dados.jogos.proximo ? 'próximo: ' + dados.jogos.proximo.casa + ' x ' + dados.jogos.proximo.fora : 'sem jogo', '|',
  ag ? ag.length + ' compromissos (criptografados)' : 'sem agenda');
