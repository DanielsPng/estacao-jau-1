// Estação Jaú-1 — busca clima, notícias e jogos do São Paulo e grava data.json.
// Roda sozinho no GitHub Actions a cada 30 minutos (.github/workflows/dados.yml).
import { readFile, writeFile } from 'node:fs/promises';

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

/* ---------- junta tudo ---------- */
const anterior = await readFile('data.json', 'utf8').then(JSON.parse).catch(() => ({}));
const [c, n, j] = await Promise.all([safe(clima(), null), safe(noticias(), []), safe(jogos(), null)]);
const dados = {
  atualizado: new Date().toISOString(),
  clima: c || anterior.clima || null,
  noticias: n.length ? n : (anterior.noticias || []),
  jogos: j || anterior.jogos || null
};
await writeFile('data.json', JSON.stringify(dados, null, 1) + '\n');
console.log('ok:', dados.clima ? dados.clima.temp + '°C' : 'sem clima', '|', dados.noticias.length, 'notícias |',
  dados.jogos && dados.jogos.proximo ? 'próximo: ' + dados.jogos.proximo.casa + ' x ' + dados.jogos.proximo.fora : 'sem jogo');
