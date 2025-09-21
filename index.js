const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const SUBSCRIPTIONS_FILE = path.join(__dirname, 'esports_subscriptions.json');

let db = { subscriptions: {}, seenMatches: {} };
if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
  try { db = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8')); }
  catch (e) { console.error('Erro ao ler DB, iniciando vazio:', e.message); }
}

function saveDB() {
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(db, null, 2));
}

function normalizeTeamName(name) {
  return String(name || '').trim().toLowerCase();
}

async function fetchHLTVMatchesHtml() {
  const res = await axios.get('https://www.hltv.org/matches', {
    headers: { 'User-Agent': 'GrooddCommunityBot/1.0 (+https://example.com)' }
  });
  return res.data;
}

function extractMatchesFromHtml(html) {
  const $ = cheerio.load(html);
  const found = [];

  // procura por links que levam a /matches/<id>/
  $('a[href*="/matches/"]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const idMatch = href.match(/\/matches\/(\d+)\//);
    if (!idMatch) return;
    const id = idMatch[1];
    if (found.some(m => m.id === id)) return;

    // pega um texto de contexto próximo (pai mais próximo com texto)
    let context = $(el).closest('div').text() || $(el).text() || '';
    context = context.replace(/\s+/g, ' ').trim();

    // tenta extrair "TeamA vs TeamB" com regex
    let team1 = '';
    let team2 = '';
    const vsRegex = /(.+?)\s+v(?:s|\.?)\s+(.+?)(?:\s|$)/i;
    const dashRegex = /(.+?)\s+[-–]\s+(.+?)(?:\s|$)/;
    let m = context.match(vsRegex) || context.match(dashRegex);
    if (m) {
      team1 = m[1].trim();
      team2 = m[2].trim();
    } else {
      // fallback simples: pega os dois primeiros "blocos" de palavras
      const parts = context.split(' ').slice(0, 6).join(' ');
      team1 = parts.slice(0, 20).trim();
      team2 = '';
    }

    // tenta achar nome do evento se houver (heurística)
    let event = '';
    const parentText = $(el).closest('div').parent().text() || '';
    const evtMatch = parentText.match(/(?:Event|Tournament|Liga|League|Stage):?\s*([^\n\r]+)/i);
    if (evtMatch) event = evtMatch[1].trim();

    const link = 'https://www.hltv.org' + href;
    found.push({ id, team1, team2, event, link, raw: context });
  });

  return found;
}

async function getMatchesForTeam(teamName) {
  try {
    const html = await fetchHLTVMatchesHtml();
    const all = extractMatchesFromHtml(html);
    const t = normalizeTeamName(teamName);
    return all.filter(m =>
      (m.team1 && normalizeTeamName(m.team1).includes(t)) ||
      (m.team2 && normalizeTeamName(m.team2).includes(t))
    );
  } catch (err) {
    console.error('Erro ao buscar/parsear HLTV:', err.message);
    return [];
  }
}

async function notifyNewMatchesForTeam(team) {
  const teamKey = normalizeTeamName(team);
  if (!db.seenMatches[teamKey]) db.seenMatches[teamKey] = [];
  const matches = await getMatchesForTeam(team);
  for (const m of matches) {
    if (!db.seenMatches[teamKey].includes(m.id)) {
      db.seenMatches[teamKey].push(m.id);
      saveDB();
      const subs = db.subscriptions[team] || [];
      for (const webhook of subs) {
        const content =
          `🔥 **Novo jogo de ${team}**\n` +
          `**${m.team1 || '—'} vs ${m.team2 || '—'}**\n` +
          `Torneio: ${m.event || '—'}\n` +
          `🔗 ${m.link}`;
        try {
          await axios.post(webhook, { content });
          console.log('Notificado webhook:', webhook, '->', team);
        } catch (err) {
          console.error('Falha ao enviar webhook:', err.message);
        }
      }
    }
  }
}

// cron: a cada 10 minutos
cron.schedule('*/10 * * * *', async () => {
  const teams = Object.keys(db.subscriptions);
  if (teams.length === 0) {
    console.log('Nenhuma inscrição encontrada — pulando polling.');
    return;
  }
  console.log('⏳ Polling HLTV para:', teams.join(', '));
  for (const t of teams) {
    try { await notifyNewMatchesForTeam(t); }
    catch (e) { console.error('Erro no notifyNewMatchesForTeam', e.message); }
  }
});

// --- API minimal ---
const app = express();
app.use(express.json());

app.post('/subscribe', (req, res) => {
  const { team, webhook } = req.body;
  if (!team || !webhook) return res.status(400).json({ error: "Precisa enviar 'team' e 'webhook' no body." });
  if (!db.subscriptions[team]) db.subscriptions[team] = [];
  if (!db.subscriptions[team].includes(webhook)) db.subscriptions[team].push(webhook);
  saveDB();
  res.json({ ok: true, message: `Inscrito ${team}` });
});

app.post('/unsubscribe', (req, res) => {
  const { team, webhook } = req.body;
  if (!team || !webhook) return res.status(400).json({ error: "Precisa enviar 'team' e 'webhook'." });
  db.subscriptions[team] = (db.subscriptions[team] || []).filter(w => w !== webhook);
  saveDB();
  res.json({ ok: true });
});

app.get('/subscriptions', (req, res) => res.json(db.subscriptions));

app.get('/poll-now', async (req, res) => {
  const teams = Object.keys(db.subscriptions);
  for (const t of teams) await notifyNewMatchesForTeam(t);
  res.json({ ok: true, polled: teams.length });
});

app.get('/health', (req, res) => res.json({ status: 'ok', subscriptions: Object.keys(db.subscriptions).length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
