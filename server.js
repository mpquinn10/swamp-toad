require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// ── Constants ─────────────────────────────────────────────
const DAILY_FREE_FLIES = 3;
const FLIES_PER_PACK   = 50;

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

// ── Supabase admin client ─────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY');
}

// Returns the authenticated user from the Bearer token, or null
async function getUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

async function getFlyCounts(userId) {
  const { data, error } = await supabase
    .from('user_flies')
    .select('daily_used, daily_date, bought')
    .eq('user_id', userId)
    .single();

  if (error || !data) return { dailyUsed: 0, bought: 0 };

  const dailyUsed = data.daily_date === today() ? data.daily_used : 0;
  return { dailyUsed, bought: data.bought || 0 };
}

// Deducts one fly. Returns { consumed: true, dailyRemaining, bought } or { consumed: false }
async function consumeFly(userId) {
  const { dailyUsed, bought } = await getFlyCounts(userId);
  const dailyRemaining = DAILY_FREE_FLIES - dailyUsed;
  const td = today();

  if (dailyRemaining > 0) {
    const { error } = await supabase
      .from('user_flies')
      .upsert({
        user_id: userId,
        daily_used: dailyUsed + 1,
        daily_date: td,
        bought,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    if (error) throw error;
    return { consumed: true, dailyRemaining: dailyRemaining - 1, bought };
  }

  if (bought > 0) {
    const { error } = await supabase
      .from('user_flies')
      .upsert({
        user_id: userId,
        daily_used: dailyUsed,
        daily_date: td,
        bought: bought - 1,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    if (error) throw error;
    return { consumed: true, dailyRemaining: 0, bought: bought - 1 };
  }

  return { consumed: false, dailyRemaining: 0, bought: 0 };
}

async function addBoughtFlies(userId, amount) {
  const { data } = await supabase
    .from('user_flies')
    .select('daily_used, daily_date, bought')
    .eq('user_id', userId)
    .single();

  const td = today();
  const current = data || { daily_used: 0, daily_date: td, bought: 0 };

  await supabase
    .from('user_flies')
    .upsert({
      user_id: userId,
      daily_used: current.daily_date === td ? current.daily_used : 0,
      daily_date: td,
      bought: (current.bought || 0) + amount,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
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
    const userId = session.metadata?.userId;
    const flyAmount = parseInt(session.metadata?.flyAmount || String(FLIES_PER_PACK), 10);
    if (userId) {
      await addBoughtFlies(userId, flyAmount);
      console.log(`[${new Date().toISOString()}] +${flyAmount} flies → user ${userId.substring(0, 8)}***`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── GET /api/config ───────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

// ── GET /api/flies ────────────────────────────────────────
app.get('/api/flies', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in to see your flies.' });

  const paymentEnabled = !!(stripe && process.env.STRIPE_PRICE_ID);
  try {
    const { dailyUsed, bought } = await getFlyCounts(user.id);
    const dailyRemaining = Math.max(0, DAILY_FREE_FLIES - dailyUsed);
    res.json({ dailyUsed, dailyRemaining, bought, total: dailyRemaining + bought, paymentEnabled });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] getFlyCounts error:`, err.message);
    res.status(500).json({ error: 'The swamp is restless.' });
  }
});

// ── POST /api/checkout ────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(400).json({ error: 'Payments not available right now.' });
  }

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });

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
      metadata: { userId: user.id, flyAmount: String(FLIES_PER_PACK) },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Checkout error:`, err.message);
    res.status(500).json({ error: 'The swamp is restless. Try again.' });
  }
});

// ── POST /api/ask ─────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const question = (req.body.question || '').trim();

  if (!question) return res.status(400).json({ error: 'Say something. The swamp waits.' });
  if (question.length > 500) return res.status(400).json({ error: 'Too many words. Ask simpler.' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in to ask the toad.' });

  let flyResult;
  try {
    flyResult = await consumeFly(user.id);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] consumeFly error:`, err.message);
    flyResult = { consumed: true, dailyRemaining: 0, bought: 0 }; // fail open
  }
  if (!flyResult.consumed) {
    return res.status(429).json({ error: NO_FLIES_MSG, noFlies: true });
  }

  const fliesLeft = flyResult.dailyRemaining + flyResult.bought;
  console.log(`[${new Date().toISOString()}] User: ${user.id.substring(0, 8)}*** | Flies left: ${fliesLeft}`);

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
