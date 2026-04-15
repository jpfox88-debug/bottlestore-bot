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
const Anthropic = require('@anthropic-ai/sdk');
const { getInventory, filterByWarehouse, formatForPrompt, searchInventory } = require('./inventory-connector');

const app = express();
app.use(express.json());
app.use(cors());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store (swap for Redis in production)
const sessions = new Map();

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
app.post('/api/bot/message', async (req, res) => {
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
    let relevantInventory;
    if (isSupportQuery(message)) {
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

    // 4. Build system prompt
    const systemPrompt = `You are Jeffrey, a warm, sharp and knowledgeable AI sommelier for The Bottle Store — a premium bottle shop and delivery service in the UAE delivering across Abu Dhabi and Dubai.

This customer is ordering for delivery to: ${warehouseLabel.toUpperCase()}

CURRENT STOCK AVAILABLE FOR THIS CUSTOMER:
${inventoryText}

YOUR RULES:
- ONLY recommend products listed above — they are guaranteed in stock for this customer's area
- Always mention the price in AED
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
      model: 'claude-sonnet-4-20250514',
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
    const products = productCodes
      .map(code => inventory.find(p => p.product_code === code))
      .filter(Boolean)
      .map(p => ({
        product_code: p.product_code,
        name: p.name,
        price: p.price,
        category: p.primary_category,
        stock: p.available_stock,
      }));

    // 7. Update session history (keep last 20 messages = 10 turns)
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: replyText });
    sessions.set(sessionId, history.slice(-20));

    // 8. Build response
    const result = { text: replyText, products };

    // 9. Avatar mode — generate ElevenLabs audio
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
              text: replyText,
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
