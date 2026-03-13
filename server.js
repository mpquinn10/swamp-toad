require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Swamp Toad.

You have been alive since before memory. You have watched empires
rot into swamp. You have seen every human mistake made ten thousand
times. Nothing surprises you. Nothing rushes you.

You speak slowly. Deliberately. Every word costs something so you
don't waste them.

Your voice is raspy but strong — like an oak that has survived
every storm by refusing to argue with the wind.

You smoke a pipe. You sit. You observe. You answer when asked.

VOICE RULES:
- Short sentences. Never more than needed.
- No filler words. No certainly, absolutely, great question.
- Dry humor only — you're not trying to be funny. You just are.
- You are never shocked by someone's problem. You've heard worse.
- You tell the truth even when it's uncomfortable. Especially then.
- You do not coddle. You do not flatter. You respect people too
  much for that.
- Occasionally reference the swamp, water, mud, roots, rot,
  stillness, fog — but don't force it. Let it come natural.
- You may take one long slow drag before answering something
  particularly foolish.

WHAT YOU ARE NOT:
- You are not a therapist
- You are not a hype man
- You are not an assistant
- You are not in a hurry

FORMAT:
- 3 to 6 sentences usually. Never more than 8.
- No bullet points. No lists. Just words.
- Speak directly to the person. No preamble.

You have one job. Tell people what they already know
but won't say to themselves.`;

const RATE_LIMIT_MESSAGE = "You've had enough wisdom for one day. Come back tomorrow.";

// Exhale sound — generated once and cached for the server's lifetime
let cachedExhale = null;

async function getExhale(key) {
  if (cachedExhale) return cachedExhale;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text: 'slow deep smoky exhale, pipe smoke breath out, gravelly', duration_seconds: 2.5, prompt_influence: 0.3 }),
    });
    if (r.ok) cachedExhale = Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Exhale cache error:`, e.message);
  }
  return cachedExhale;
}

// In-memory rate limiting
const ipRequests = new Map(); // ip -> count for today
let dailyTotal = 0;
let lastResetDate = new Date().toDateString();

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    ipRequests.clear();
    dailyTotal = 0;
    lastResetDate = today;
    console.log(`[${new Date().toISOString()}] New day — counters reset.`);
  }
}

function maskIp(ip) {
  if (!ip) return 'unknown';
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  return ip.substring(0, 6) + '***';
}

app.post('/api/ask', async (req, res) => {
  resetIfNewDay();

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const question = (req.body.question || '').trim();

  if (!question) {
    return res.status(400).json({ error: 'Say something. The swamp waits.' });
  }

  if (question.length > 500) {
    return res.status(400).json({ error: 'Too many words. Ask simpler.' });
  }

  // Hard daily cap across all users
  if (dailyTotal >= 500) {
    console.log(`[${new Date().toISOString()}] Daily cap hit. Turning away: ${maskIp(ip)}`);
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }

  // Per-IP daily limit
  const ipCount = ipRequests.get(ip) || 0;
  if (ipCount >= 10) {
    console.log(`[${new Date().toISOString()}] IP limit hit: ${maskIp(ip)}`);
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }

  console.log(`[${new Date().toISOString()}] IP: ${maskIp(ip)} | IP count: ${ipCount + 1}/10 | Daily: ${dailyTotal + 1}/500`);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    });

    // Update counters only after successful call
    ipRequests.set(ip, ipCount + 1);
    dailyTotal++;

    const response = message.content[0].text;

    // ElevenLabs TTS + sound effects
    let audio = null;
    let exhale = null;
    let soundEffects = [];

    if (process.env.ELEVENLABS_API_KEY) {
      const key = process.env.ELEVENLABS_API_KEY;
      try {
        // Extract *actions* and strip them from spoken text
        const actions = [];
        const spokenText = response.replace(/\*([^*]+)\*/g, (_, a) => {
          actions.push(a.trim());
          return '';
        }).replace(/\s{2,}/g, ' ').trim();

        // Fire TTS + exhale + non-drag sound effects in parallel
        const [ttsAudio, exhaleAudio, ...sfxAudios] = await Promise.all([
          (async () => {
            const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/Q2RUKfy4Zwg6YGnxO4ER', {
              method: 'POST',
              headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
              body: JSON.stringify({
                text: spokenText || response,
                model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.65, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true },
              }),
            });
            if (!r.ok) { console.error(`[${new Date().toISOString()}] TTS error: ${r.status}`); return null; }
            return Buffer.from(await r.arrayBuffer()).toString('base64');
          })(),
          getExhale(key),
          ...actions.slice(0, 2)
            .filter(a => {
              const l = a.toLowerCase();
              return !(l.includes('drag') || l.includes('pipe') || l.includes('smoke') || l.includes('puff'));
            })
            .map(async (action) => {
              const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
                method: 'POST',
                headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
                body: JSON.stringify({ text: action, duration_seconds: 3.0, prompt_influence: 0.3 }),
              });
              if (!r.ok) { console.error(`[${new Date().toISOString()}] SFX error: ${r.status}`); return null; }
              return Buffer.from(await r.arrayBuffer()).toString('base64');
            }),
        ]);

        audio = ttsAudio;
        exhale = exhaleAudio;
        soundEffects = sfxAudios.filter(Boolean);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] ElevenLabs error:`, err.message);
      }
    }

    res.json({ response, audio, exhale, soundEffects });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] API error:`, err.message);
    res.status(500).json({ error: 'The swamp is quiet right now. Try again.' });
  }
});

// Email subscribe — appends to emails.txt
app.post('/api/subscribe', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'The swamp needs a real address.' });
  }

  const line = `${new Date().toISOString()} | ${email}\n`;
  const file = path.join(__dirname, 'emails.txt');

  try {
    fs.appendFileSync(file, line);
    console.log(`[${new Date().toISOString()}] Subscriber: ${email.substring(0, 4)}***`);
    res.json({ success: true });
  } catch (err) {
    console.error('Email log error:', err.message);
    res.status(500).json({ error: 'Something stirred in the swamp. Try again.' });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Swamp Toad is awake on port ${PORT}`);
});
