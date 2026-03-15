require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

// ── Constants ─────────────────────────────────────────────
const DAILY_FREE_FLIES = 3;
const FLIES_PER_PACK   = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

const NO_FLIES_MSG = "No flies left. Feed the toad and come back.";

// ── Exhale cache ──────────────────────────────────────────
let cachedExhaleB64 = null;
const EXHALE_TMP = '/tmp/swamptoad_exhale.mp3';

async function getExhale(key) {
  if (cachedExhaleB64) return cachedExhaleB64;
  try {
    cachedExhaleB64 = fs.readFileSync(EXHALE_TMP).toString('base64');
    return cachedExhaleB64;
  } catch (_) {}
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text: 'slow deep smoky exhale, pipe smoke breath out, gravelly', duration_seconds: 2.5, prompt_influence: 0.3 }),
    });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      cachedExhaleB64 = buf.toString('base64');
      try { fs.writeFileSync(EXHALE_TMP, buf); } catch (_) {}
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Exhale error:`, e.message);
  }
  return cachedExhaleB64;
}

// ── KV client ─────────────────────────────────────────────
let kvClient = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { createClient } = require('@vercel/kv');
    kvClient = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    console.log('Storage: Vercel KV');
  } else {
    console.log('Storage: in-memory');
  }
} catch (e) {
  console.log('Storage: in-memory (KV init failed)');
}

// ── In-memory session store (local dev fallback) ──────────
// token -> { dailyByDate: Map<string, number>, bought: number }
const inMemorySessions = new Map();

function getOrCreateSession(token) {
  if (!inMemorySessions.has(token)) {
    inMemorySessions.set(token, { dailyByDate: new Map(), bought: 0 });
  }
  return inMemorySessions.get(token);
}

function dayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function secondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.floor((midnight - now) / 1000);
}

async function getFlyCounts(token) {
  if (kvClient) {
    const [dailyUsed, bought] = await Promise.all([
      kvClient.get(`flies:daily:${token}:${dayKey()}`),
      kvClient.get(`flies:bought:${token}`),
    ]);
    return { dailyUsed: dailyUsed || 0, bought: bought || 0 };
  }
  const s = getOrCreateSession(token);
  return { dailyUsed: s.dailyByDate.get(dayKey()) || 0, bought: s.bought };
}

// Deducts one fly. Returns { consumed: true, dailyRemaining, bought } or { consumed: false }
async function consumeFly(token) {
  const { dailyUsed, bought } = await getFlyCounts(token);
  const dailyRemaining = DAILY_FREE_FLIES - dailyUsed;

  if (dailyRemaining > 0) {
    if (kvClient) {
      const key = `flies:daily:${token}:${dayKey()}`;
      const newVal = await kvClient.incr(key);
      if (newVal === 1) await kvClient.expire(key, secondsUntilMidnight());
    } else {
      const s = getOrCreateSession(token);
      s.dailyByDate.set(dayKey(), dailyUsed + 1);
    }
    return { consumed: true, dailyRemaining: dailyRemaining - 1, bought };
  }

  if (bought > 0) {
    if (kvClient) {
      const newBought = await kvClient.decrby(`flies:bought:${token}`, 1);
      return { consumed: true, dailyRemaining: 0, bought: Math.max(0, newBought) };
    } else {
      const s = getOrCreateSession(token);
      s.bought = Math.max(0, s.bought - 1);
      return { consumed: true, dailyRemaining: 0, bought: s.bought };
    }
  }

  return { consumed: false, dailyRemaining: 0, bought: 0 };
}

async function addBoughtFlies(token, amount) {
  if (kvClient) {
    await kvClient.incrby(`flies:bought:${token}`, amount);
    return;
  }
  const s = getOrCreateSession(token);
  s.bought += amount;
}

// ── Stripe ────────────────────────────────────────────────
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('Stripe: enabled');
  }
} catch (e) {
  console.log('Stripe: disabled (package not found)');
}

// ── Express app ───────────────────────────────────────────
const app = express();

// ── Stripe webhook: must be defined before express.json() ─
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Webhook signature error:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token = session.metadata?.sessionToken;
    const flyAmount = parseInt(session.metadata?.flyAmount || String(FLIES_PER_PACK), 10);
    if (token && UUID_RE.test(token)) {
      await addBoughtFlies(token, flyAmount);
      console.log(`[${new Date().toISOString()}] +${flyAmount} flies → session ${token.substring(0, 8)}***`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── GET /api/flies ────────────────────────────────────────
app.get('/api/flies', async (req, res) => {
  const token = (req.headers['x-session-token'] || '').trim();
  const paymentEnabled = !!(stripe && process.env.STRIPE_PRICE_ID);

  if (!token || !UUID_RE.test(token)) {
    return res.json({
      dailyUsed: 0,
      dailyRemaining: DAILY_FREE_FLIES,
      bought: 0,
      total: DAILY_FREE_FLIES,
      paymentEnabled,
    });
  }

  try {
    const { dailyUsed, bought } = await getFlyCounts(token);
    const dailyRemaining = Math.max(0, DAILY_FREE_FLIES - dailyUsed);
    res.json({ dailyUsed, dailyRemaining, bought, total: dailyRemaining + bought, paymentEnabled });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] getFlyCounts error:`, err.message);
    res.json({ dailyUsed: 0, dailyRemaining: DAILY_FREE_FLIES, bought: 0, total: DAILY_FREE_FLIES, paymentEnabled });
  }
});

// ── POST /api/checkout ────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(400).json({ error: 'Payments not available right now.' });
  }

  const token = (req.headers['x-session-token'] || '').trim();
  if (!token || !UUID_RE.test(token)) {
    return res.status(400).json({ error: 'Invalid session.' });
  }

  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  const baseUrl = `${proto}://${host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'payment',
      success_url: `${baseUrl}/?payment=success`,
      cancel_url:  `${baseUrl}/`,
      metadata: { sessionToken: token, flyAmount: String(FLIES_PER_PACK) },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Checkout error:`, err.message);
    res.status(500).json({ error: 'The swamp is restless. Try again.' });
  }
});

// ── POST /api/ask ─────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const token    = (req.headers['x-session-token'] || '').trim();
  const question = (req.body.question || '').trim();

  if (!question) return res.status(400).json({ error: 'Say something. The swamp waits.' });
  if (question.length > 500) return res.status(400).json({ error: 'Too many words. Ask simpler.' });

  if (!token || !UUID_RE.test(token)) {
    return res.status(400).json({ error: 'The swamp does not know you.' });
  }

  let flyResult;
  try {
    flyResult = await consumeFly(token);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] consumeFly error:`, err.message);
    flyResult = { consumed: true, dailyRemaining: 0, bought: 0 }; // fail open
  }
  if (!flyResult.consumed) {
    return res.status(429).json({ error: NO_FLIES_MSG, noFlies: true });
  }

  const fliesLeft = flyResult.dailyRemaining + flyResult.bought;
  console.log(`[${new Date().toISOString()}] Session: ${token.substring(0, 8)}*** | Flies left: ${fliesLeft}`);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    });

    const response = message.content[0].text;

    let audio = null;
    let exhale = null;
    let soundEffects = [];

    if (process.env.ELEVENLABS_API_KEY) {
      const key = process.env.ELEVENLABS_API_KEY;
      try {
        const actions = [];
        const spokenText = response.replace(/\*([^*]+)\*/g, (_, a) => {
          actions.push(a.trim());
          return '';
        }).replace(/\s{2,}/g, ' ').trim();

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

    res.json({ response, audio, exhale, soundEffects, fliesLeft, dailyRemaining: flyResult.dailyRemaining, bought: flyResult.bought });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] API error:`, err.message);
    res.status(500).json({ error: 'The swamp is quiet right now. Try again.' });
  }
});

// ── POST /api/subscribe ───────────────────────────────────
app.post('/api/subscribe', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'The swamp needs a real address.' });
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId  = process.env.BEEHIIV_PUBLICATION_ID;

  if (!apiKey || !pubId) {
    console.error('BeehiiV env vars not set');
    return res.status(500).json({ error: 'The swamp is restless. Try again.' });
  }

  try {
    const r = await fetch(`https://api.beehiiv.com/v2/publications/${pubId}/subscriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        reactivate_existing: false,
        send_welcome_email: true,
        utm_source: 'swamptoad_web',
        utm_medium: 'organic',
        utm_campaign: 'email_capture',
      }),
    });

    if (!r.ok) {
      const body = await r.text();
      console.error(`[${new Date().toISOString()}] BeehiiV error ${r.status}:`, body);
      return res.status(500).json({ error: 'The swamp is restless. Try again.' });
    }

    console.log(`[${new Date().toISOString()}] Subscriber added: ${email.substring(0, 4)}***`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] BeehiiV error:`, err.message);
    res.status(500).json({ error: 'The swamp is restless. Try again.' });
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
