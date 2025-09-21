/*
Discord eSports Bot API - HLTV edition

Este arquivo cria uma API REST que:
- Permite cadastrar webhooks do Discord para times BR (FURIA, Imperial, paiN etc.)
- Consulta a API do HLTV (via pacote npm hltv) para checar partidas agendadas
- Notifica automaticamente o webhook no Discord quando encontra novos jogos

Dependências (npm):
  express, lowdb, node-schedule, discord-webhook-node, hltv

Como usar:
1) Criar um projeto Node.js:
   npm init -y
   npm i express lowdb node-schedule discord-webhook-node hltv

2) Copiar este arquivo para discord-esports-bot-api.js
3) Rodar: node discord-esports-bot-api.js
4) No Discord, vá em Configurações do Servidor > Integrações > Webhooks e crie um webhook para o canal desejado.
5) Use o endpoint POST /subscribe com JSON:
   { "team": "FURIA", "webhook": "https://discord.com/api/webhooks/..." }
6) O bot vai consultar HLTV periodicamente e avisar quando houver partidas futuras.
*/

const express = require('express');
const { writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { Webhook, MessageBuilder } = require('discord-webhook-node');
const schedule = require('node-schedule');
const { HLTV } = require('hltv');

// Banco de dados simples em arquivo JSON
const DB_FILE = join(__dirname, 'esports_subscriptions.json');
let db = { subscriptions: [], seenMatches: {} };
if (existsSync(DB_FILE)) {
  try { db = require(DB_FILE); } catch (e) { console.error('Erro ao ler DB, iniciando vazio'); }
}

function saveDB() {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const app = express();
app.use(express.json());

function normalizeTeamName(name) {
  return name.trim().toLowerCase();
}

function findSubscriptionsForTeam(team) {
  const t = normalizeTeamName(team);
  return db.subscriptions.filter(s => normalizeTeamName(s.team) === t);
}

async function sendDiscordWebhook(webhookUrl, title, content, url = null) {
  try {
    const hook = new Webhook(webhookUrl);
    const embed = new MessageBuilder()
      .setTitle(title)
      .setDescription(content)
      .setTimestamp();
    if (url) embed.setURL(url);
    await hook.send(embed);
  } catch (err) {
    console.error('Falha ao enviar webhook:', err.message);
  }
}

// Função para buscar partidas futuras no HLTV
async function fetchUpcomingMatches(teamName) {
  try {
    const matches = await HLTV.getMatches();
    const filtered = matches.filter(m => {
      if (!m.team1 || !m.team2) return false;
      const t1 = normalizeTeamName(m.team1.name);
      const t2 = normalizeTeamName(m.team2.name);
      const t = normalizeTeamName(teamName);
      return t1.includes(t) || t2.includes(t);
    });
    return filtered;
  } catch (err) {
    console.error('Erro ao buscar HLTV:', err.message);
    return [];
  }
}

async function pollTeam(team) {
  const teamKey = normalizeTeamName(team);
  console.log('Polling', team);
  const matches = await fetchUpcomingMatches(team);
  if (!db.seenMatches[teamKey]) db.seenMatches[teamKey] = [];

  for (const m of matches) {
    const id = `${m.id}`;
    if (!db.seenMatches[teamKey].includes(id)) {
      db.seenMatches[teamKey].push(id);
      saveDB();

      const subs = findSubscriptionsForTeam(team);
      for (const s of subs) {
        const title = `🔥 Novo jogo da ${s.team}!`;
        const content = `${m.team1.name} vs ${m.team2.name}\nTorneio: ${m.event.name}\nData: ${new Date(m.date).toLocaleString('pt-BR')}`;
        const link = `https://www.hltv.org/matches/${m.id}/_`;
        console.log('Enviando notificação para', s.webhook);
        sendDiscordWebhook(s.webhook, title, content, link);
      }
    }
  }
}

const POLL_MINUTES = process.env.POLL_MINUTES ? Number(process.env.POLL_MINUTES) : 10;
function schedulePolling() {
  console.log(`Agendando polling HLTV a cada ${POLL_MINUTES} minutos`);
  schedule.scheduleJob(`*/${POLL_MINUTES} * * * *`, async () => {
    const teams = Array.from(new Set(db.subscriptions.map(s => s.team)));
    for (const t of teams) {
      try { await pollTeam(t); } catch (e) { console.error('Erro no pollTeam', e.message); }
    }
  });
}

// Endpoints
app.post('/subscribe', (req, res) => {
  const { team, webhook } = req.body;
  if (!team || !webhook) return res.status(400).json({ error: 'team e webhook são obrigatórios' });

  db.subscriptions.push({ team: team.trim(), webhook: webhook.trim(), createdAt: new Date().toISOString() });
  saveDB();
  res.json({ ok: true, message: `Inscrito ${team}` });
});

app.post('/unsubscribe', (req, res) => {
  const { team, webhook } = req.body;
  if (!team || !webhook) return res.status(400).json({ error: 'team e webhook são obrigatórios' });
  const before = db.subscriptions.length;
  db.subscriptions = db.subscriptions.filter(s => !(normalizeTeamName(s.team) === normalizeTeamName(team) && s.webhook === webhook));
  saveDB();
  res.json({ ok: true, removed: before - db.subscriptions.length });
});

app.get('/subscriptions', (req, res) => {
  res.json({ subscriptions: db.subscriptions });
});

app.get('/poll-now', async (req, res) => {
  const teams = Array.from(new Set(db.subscriptions.map(s => s.team)));
  for (const t of teams) { await pollTeam(t); }
  res.json({ ok: true, polled: teams.length });
});

app.get('/health', (req, res) => res.json({ status: 'ok', subscriptions: db.subscriptions.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
  schedulePolling();
});
