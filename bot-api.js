/**
 * The Bottle Store — Bot API Server
 * Single endpoint for website widget + iOS + Android
 *
 * POST /api/bot/message
 * Body: { message, sessionId, warehouse, mode }
 * Returns: { text, products, audioBase64? }
 */

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { getInventory, filterByWarehouse, formatForPrompt } = require('./inventory-connector');

const app = express();
app.use(express.json());
app.use(cors());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store (swap for Redis in production)
const sessions = new Map();

// ── MAIN BOT ENDPOINT ─────────────────────────────────────
app.post('/api/bot/message', async (req, res) => {
  const { message, sessionId, warehouse, mode = 'chat' } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  try {
    // 1. Load inventory filtered to customer's warehouse
    const allInventory = await getInventory();
    const inventory = filterByWarehouse(allInventory, warehouse);
    const inventoryText = formatForPrompt(inventory);

    // 2. Load session history
    const history = sessions.get(sessionId) ?? [];

    // 3. Build system prompt
    const warehouseLabel = warehouse
      ? warehouse.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
      : 'your area';

    const systemPrompt = `You are Sofia, a warm and knowledgeable AI sommelier for The Bottle Store — a premium bottle shop and delivery service in the UAE delivering across Abu Dhabi and Dubai.

This customer is ordering for delivery to: ${warehouseLabel.toUpperCase()}

CURRENT STOCK AVAILABLE FOR THIS CUSTOMER:
${inventoryText}

YOUR RULES:
- ONLY recommend products listed above — they are guaranteed in stock for this customer's area
- Always mention the price in AED
- Use your expert knowledge of wines, spirits and beers to give tasting notes, food pairings and context — you don't need this from the data
- Be warm, concise and conversational — 2 to 4 sentences unless listing products
- If something is not in stock, say so honestly and suggest the closest available alternative
- Never recommend products not on the list above

CUSTOMER SUPPORT — use these answers for common queries:
- Delivery: 7 days a week, 10am–10pm. Standard 60–90 mins. Express available (+AED 25).
- Minimum order: AED 50. Free delivery over AED 150.
- Returns: Within 24 hours for damaged or incorrect items.
- Payment: Credit cards, Apple Pay, cash on delivery, Tabby.
- Age: 21+ required, ID checked on delivery.
- Order tracking: Real-time via WhatsApp link sent after ordering.

PRODUCT CARDS — when recommending specific products, end your reply on a new line with:
PRODUCTS:code1,code2
(use the product codes in square brackets from the inventory list)`;

    // 4. Call Claude
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

    // 5. Parse product cards
    const productMatch = fullText.match(/\nPRODUCTS:([A-Z0-9,]+)/);
    const replyText = fullText.replace(/\nPRODUCTS:[A-Z0-9,]+/, '').trim();
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

    // 6. Update session history (keep last 20 messages = 10 turns)
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: replyText });
    sessions.set(sessionId, history.slice(-20));

    // 7. Build response
    const result = { text: replyText, products };

    // 8. Avatar mode — generate ElevenLabs audio
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
        // Non-fatal — return text response without audio
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
