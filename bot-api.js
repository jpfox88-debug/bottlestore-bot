/**
 * The Bottle Store — Bot API Server
 * Single endpoint for website widget + iOS + Android
 *
 * POST /api/bot/message
 * Body: { message, sessionId, warehouse, mode }
 * Returns: { text, products, audioBase64? }
 *
 * TWO-STEP APPROACH:
 * Step 1 — Classify: cheap call to understand what the customer wants
 * Step 2 — Search + Recommend: search full inventory, send top 80 relevant products to Claude
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getInventory, filterByWarehouse, formatForPrompt, searchInventory } = require('./inventory-connector');

// Prefer Render persistent disk mounted at /data; fall back to repo copy for local dev.
function resolveDataFile(filename) {
  const diskDir = '/data';
  try {
    if (fs.statSync(diskDir).isDirectory()) return path.join(diskDir, filename);
  } catch { /* /data not present, fall through */ }
  return path.join(__dirname, filename);
}

const PROMOTIONS_FILE = resolveDataFile('promotions.json');
const SETTINGS_FILE = resolveDataFile('settings.json');
console.log(`[Promotions] Storage: ${PROMOTIONS_FILE}`);
console.log(`[Settings] Storage: ${SETTINGS_FILE}`);

const DEFAULT_SETTINGS = {
  welcomeEnabled: false,
  welcomeDelay: 3,
  welcomeMessage: "Hello! I'm Jeffrey, your personal sommelier. Looking for something special today?",
};

async function readPromotions() {
  try {
    return JSON.parse(await fs.promises.readFile(PROMOTIONS_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writePromotions(arr) {
  await fs.promises.writeFile(PROMOTIONS_FILE, JSON.stringify(arr, null, 2));
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw e;
  }
}

async function writeSettings(s) {
  await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function requireAdminAuth(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const app = express();
app.use(express.json());
app.use(cors());
app.set('trust proxy', true); // Render sits behind a proxy; trust X-Forwarded-For for req.ip

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store (swap for Redis in production)
const sessions = new Map();
const disclosedSessions = new Set();

// ── RATE LIMIT (per IP, 30 req/min) ───────────────────────
const ipCounters = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = ipCounters.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    ipCounters.set(ip, { count: 1, windowStart: now });
    return next();
  }
  if (entry.count >= RATE_MAX) {
    return res.status(429).json({ error: "Jeffrey is catching his breath — please try again in a minute." });
  }
  entry.count++;
  next();
}

// ── SUPPORT QUESTIONS — answer without touching inventory ─
const SUPPORT_PATTERNS = [
  /deliver/i, /how (long|fast|quick)/i, /when.*(arriv|get here)/i,
  /minimum order/i, /free delivery/i, /payment/i, /pay/i,
  /return/i, /track/i, /age/i, /21/i, /express/i
];

function isSupportQuery(message) {
  return SUPPORT_PATTERNS.some(p => p.test(message));
}

// ── STEP 1: CLASSIFY what the customer wants ──────────────
async function classifyQuery(message, conversationContext) {
  const contextStr = conversationContext.length > 0
    ? `Recent conversation:\n${conversationContext.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n')}\n\n`
    : '';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `${contextStr}Customer message: "${message}"

Extract search intent as JSON. Be smart about inference:
- "Czech white" → category: white wine, region: czech
- "something for a bbq" → category: red wine, vibe: casual
- "birthday bubbles" → category: champagne
- "G&T" → category: gin
- "dram" → category: whisky

Respond ONLY with JSON, no other text:
{
  "category": "wine|red wine|white wine|rosé|champagne|sparkling|gin|vodka|whisky|rum|tequila|beer|sake|liqueur|non-alcoholic|any",
  "region": "french|italian|spanish|czech|australian|argentinian|chilean|japanese|scottish|irish|american|lebanese|new zealand|any",
  "grape": "string or null",
  "maxPrice": number or null,
  "keywords": ["array", "of", "key", "words"],
  "vibe": "celebration|gift|casual|luxury|everyday|null"
}`
    }]
  });

  try {
    const text = response.content[0]?.text ?? '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { category: 'any', region: 'any', keywords: [] };
  }
}

// ── MAIN BOT ENDPOINT ─────────────────────────────────────
app.post('/api/bot/message', rateLimitMiddleware, async (req, res) => {
  const { message, sessionId, warehouse, mode = 'chat' } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  try {
    // 1. Load full warehouse inventory (cached)
    const allInventory = await getInventory();
    const inventory = filterByWarehouse(allInventory, warehouse);

    const warehouseLabel = warehouse
      ? warehouse.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
      : 'your area';

    // 2. Load session history
    const history = sessions.get(sessionId) ?? [];

    // 3. For support questions, skip inventory entirely
    const isSupport = isSupportQuery(message);
    let relevantInventory;
    if (isSupport) {
      relevantInventory = []; // no inventory needed for delivery/payment questions
    } else {
      // STEP 1 — Classify the query (fast, cheap, uses Haiku)
      const intent = await classifyQuery(message, history);
      console.log(`[Classify] intent:`, JSON.stringify(intent));

      // STEP 2 — Search full inventory using intent
      relevantInventory = searchInventory(inventory, intent, 80);
      console.log(`[Search] ${relevantInventory.length} products matched from ${inventory.length} total`);
    }

    const inventoryText = relevantInventory.length > 0
      ? formatForPrompt(relevantInventory)
      : '(No inventory needed for this query)';

    // 3b. Load active promotions (skip for support queries)
    const activePromotions = isSupport
      ? []
      : (await readPromotions()).filter(p => p.active);
    const promotionsBlock = activePromotions.length > 0
      ? `\nFEATURED PRODUCTS — recommend these first when the trigger word appears in the customer's message:\n${activePromotions.map(p => `- "${p.trigger}" → ${p.product_name} [${p.product_code}]`).join('\n')}\n`
      : '';

    // 4. Build system prompt
    const systemPrompt = `You are Jeffrey, a warm, sharp and knowledgeable AI sommelier for The Bottle Store — a premium bottle shop and delivery service in the UAE delivering across Abu Dhabi and Dubai.

This customer is ordering for delivery to: ${warehouseLabel.toUpperCase()}

CURRENT STOCK AVAILABLE FOR THIS CUSTOMER:
${inventoryText}
${promotionsBlock}
YOUR RULES:
- ONLY recommend products listed above — they are guaranteed in stock for this customer's area
- Never state a price unless it appears exactly in the inventory list provided
- Never claim a product is in stock unless it appears in the inventory list provided
- Never invent or embellish product details beyond your sommelier knowledge — tasting notes and food pairings are fine, but invented awards, ratings, scores or vintages are not
- If you are unsure about something, say so honestly rather than guess
- Never create false urgency — do not say things like "only X left", "selling fast", "while stocks last", or similar scarcity tactics
- Never use manipulative or high-pressure language
- Never collect or ask for personal information beyond what is needed to help with the order
- If a customer asks whether you are a robot, an AI, or human (or any similar question about your nature), always answer honestly that you are an AI assistant
- Always mention the price in AED when recommending a product
- Use your expert knowledge of wines, spirits and beers to give tasting notes, food pairings and context
- Be warm, concise and conversational — 2 to 4 sentences unless listing products
- If nothing in the list matches what the customer wants, say so honestly and suggest the closest available alternative
- Never use markdown formatting like **bold** or *italic* — plain text only
- Get straight to the recommendation, no unnecessary preamble

CUSTOMER SUPPORT — use these answers:
- Delivery: 7 days a week, 10am–10pm. Standard 60–90 mins. Express available (+AED 25).
- Minimum order: AED 50. Free delivery over AED 150.
- Returns: Within 24 hours for damaged or incorrect items.
- Payment: Credit cards, Apple Pay, cash on delivery, Tabby.
- Age: 21+ required, ID checked on delivery.
- Order tracking: Real-time via WhatsApp link sent after ordering.

PRODUCT CARDS — when recommending specific products, end your reply on a new line with:
PRODUCTS:code1,code2
(use the product codes in square brackets from the inventory list)`;

    // 5. Call Claude Sonnet for the actual recommendation
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        ...history,
        { role: 'user', content: message }
      ]
    });

    const fullText = response.content[0]?.text ?? '';

    // 6. Parse product codes and strip from reply
    const productMatch = fullText.match(/PRODUCTS:([A-Za-z0-9,\-]+)/);
    const rawText = fullText
      .replace(/\nPRODUCTS:[A-Za-z0-9,\-]+/, '')
      .replace(/PRODUCTS:[A-Za-z0-9,\-]+/, '')
      .trim();
    // Strip any markdown bold/italic
    const replyText = rawText
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .trim();

    const productCodes = productMatch ? productMatch[1].split(',').map(s => s.trim()) : [];
    const promotedCodes = new Set(activePromotions.map(p => p.product_code));
    const products = productCodes
      .map(code => {
        let hit = relevantInventory.find(p => p.product_code === code);
        if (!hit && promotedCodes.has(code)) {
          hit = inventory.find(p => p.product_code === code);
        }
        if (!hit) {
          console.warn(`[Validate] Stripped product code not in relevantInventory or promotions: ${code}`);
        }
        return hit;
      })
      .filter(Boolean)
      .map(p => ({
        product_code: p.product_code,
        name: p.name,
        slug: p.slug,
        price: p.price,
        category: p.primary_category,
        stock: p.available_stock,
      }));

    // Price sanity check — log (don't block) AED figures that don't match any
    // inventory price or a known support-rule figure (min order / free delivery / express).
    const SUPPORT_PRICE_CENTS = new Set([5000, 15000, 2500]);
    const inventoryCents = new Set(relevantInventory.map(p => Math.round(p.price * 100)));
    const mentioned = [...replyText.matchAll(/AED\s*(\d+(?:[.,]\d+)?)/gi)]
      .map(m => Math.round(parseFloat(m[1].replace(',', '.')) * 100))
      .filter(Number.isFinite);
    const unmatchedPrices = mentioned.filter(c => !inventoryCents.has(c) && !SUPPORT_PRICE_CENTS.has(c));
    if (unmatchedPrices.length > 0) {
      console.warn(`[Sanity] Prices mentioned not found in inventory: ${unmatchedPrices.map(c => 'AED ' + (c / 100)).join(', ')}`);
    }

    // 7. Update session history (keep last 20 messages = 10 turns).
    // Store Claude's raw reply (without the disclosure prefix) so the model
    // doesn't start echoing the disclosure pattern on later turns.
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: replyText });
    sessions.set(sessionId, history.slice(-20));

    // 8. Prepend one-time AI disclosure on the first response of each session.
    let outboundText = replyText;
    if (!disclosedSessions.has(sessionId)) {
      const disclosure = "Just so you know — I'm Jeffrey, an AI assistant for The Bottle Store. I'm here to help you find the perfect drink but I'm not human.";
      outboundText = `${disclosure}\n\n${replyText}`;
      disclosedSessions.add(sessionId);
    }

    // 9. Build response
    const result = { text: outboundText, products };

    // 10. Avatar mode — generate ElevenLabs audio
    if (mode === 'avatar' && process.env.ELEVENLABS_KEY) {
      try {
        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': process.env.ELEVENLABS_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              text: outboundText,
              model_id: 'eleven_turbo_v2',
              output_format: 'pcm_16000',
              voice_settings: { stability: 0.5, similarity_boost: 0.8 }
            })
          }
        );
        const audioBuffer = await ttsRes.arrayBuffer();
        result.audioBase64 = Buffer.from(audioBuffer).toString('base64');
      } catch (e) {
        console.error('[TTS] ElevenLabs error:', e.message);
      }
    }

    res.json(result);

  } catch (err) {
    console.error('[Bot] Error:', err);
    res.status(500).json({ error: 'Bot unavailable, please try again.' });
  }
});

// ── INVENTORY ENDPOINT (for debugging) ───────────────────
app.get('/api/inventory', async (req, res) => {
  const { warehouse } = req.query;
  const all = await getInventory();
  const filtered = filterByWarehouse(all, warehouse);
  res.json({ total: filtered.length, warehouse: warehouse ?? 'all', products: filtered });
});

// ── PROMOTIONS ────────────────────────────────────────────
app.get('/api/promotions', async (_, res) => {
  try {
    const promotions = await readPromotions();
    res.json({ promotions });
  } catch (err) {
    console.error('[Promotions] read error:', err);
    res.status(500).json({ error: 'Failed to load promotions' });
  }
});

app.post('/api/promotions', requireAdminAuth, async (req, res) => {
  const { trigger, product_code, product_name, reason } = req.body || {};
  if (!trigger || !product_code || !product_name) {
    return res.status(400).json({ error: 'trigger, product_code, and product_name are required' });
  }
  try {
    const promotions = await readPromotions();
    const promo = {
      id: crypto.randomUUID(),
      trigger: String(trigger).trim(),
      product_code: String(product_code).trim(),
      product_name: String(product_name).trim(),
      reason: reason ? String(reason).trim() : '',
      active: true,
    };
    promotions.push(promo);
    await writePromotions(promotions);
    res.json({ promotion: promo });
  } catch (err) {
    console.error('[Promotions] write error:', err);
    res.status(500).json({ error: 'Failed to save promotion' });
  }
});

app.delete('/api/promotions/:id', requireAdminAuth, async (req, res) => {
  try {
    const promotions = await readPromotions();
    const next = promotions.filter(p => p.id !== req.params.id);
    if (next.length === promotions.length) {
      return res.status(404).json({ error: 'Promotion not found' });
    }
    await writePromotions(next);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Promotions] delete error:', err);
    res.status(500).json({ error: 'Failed to delete promotion' });
  }
});

// ── SETTINGS ──────────────────────────────────────────────
app.get('/api/settings', async (_, res) => {
  try {
    const settings = await readSettings();
    res.json({ settings });
  } catch (err) {
    console.error('[Settings] read error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.post('/api/settings', requireAdminAuth, async (req, res) => {
  const { welcomeEnabled, welcomeDelay, welcomeMessage } = req.body || {};
  if (typeof welcomeEnabled !== 'boolean') {
    return res.status(400).json({ error: 'welcomeEnabled must be a boolean' });
  }
  const delayNum = Number(welcomeDelay);
  if (!Number.isFinite(delayNum) || delayNum < 1 || delayNum > 10) {
    return res.status(400).json({ error: 'welcomeDelay must be a number between 1 and 10' });
  }
  if (typeof welcomeMessage !== 'string' || welcomeMessage.trim().length === 0) {
    return res.status(400).json({ error: 'welcomeMessage must be a non-empty string' });
  }
  if (welcomeMessage.length > 500) {
    return res.status(400).json({ error: 'welcomeMessage must be 500 characters or fewer' });
  }
  try {
    const settings = {
      welcomeEnabled,
      welcomeDelay: Math.round(delayNum),
      welcomeMessage: welcomeMessage.trim(),
    };
    await writeSettings(settings);
    res.json({ settings });
  } catch (err) {
    console.error('[Settings] write error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── PRIVACY NOTICE ────────────────────────────────────────
app.get('/api/privacy', (_, res) => {
  res.type('text/plain').send(
`Privacy Notice — The Bottle Store AI Sommelier

Jeffrey is an AI assistant. Conversations are held in memory on the server only for the duration of your session so that Jeffrey can remember recent context while helping you.

- Messages are NOT permanently stored, NOT written to disk, and NOT used to train AI models.
- When your session ends, or when the server restarts, the conversation is discarded.
- Aggregate operational logs (request counts, error rates, timings) may be retained for monitoring, but do not include the content of your messages.
- No personal information is requested beyond what is needed to fulfil an order.

If you have questions about how your data is handled, please contact The Bottle Store directly.
`
  );
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Bot] Server running on port ${PORT}`));

// ── KEEPALIVE — ping self every 14 mins to prevent Render cold starts ─────
setInterval(() => {
  fetch(`http://localhost:${process.env.PORT || 3000}/health`)
    .then(() => console.log('[Keepalive] ping ok'))
    .catch(e => console.warn('[Keepalive] ping failed:', e.message));
}, 14 * 60 * 1000);
