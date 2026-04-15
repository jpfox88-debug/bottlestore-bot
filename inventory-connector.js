/**
 * The Bottle Store — Inventory Connector (CMS only)
 * Fetches all product data from the website back office API
 * Stock quantity is included in the CMS response
 * Caches for 5 minutes
 */

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 });

const CMS_URL = 'https://thebottlestoredelivery.com/index.php?route=extension/feed/products';
const CMS_TOKEN = process.env.CMS_API_TOKEN;

// ── FETCH & SHAPE ─────────────────────────────────────────
async function getInventory() {
  const cached = cache.get('inventory');
  if (cached) return cached;

  console.log('[Inventory] Refreshing from CMS...');

  const res = await fetch(CMS_URL, {
    headers: { 'Authorization': `Bearer ${CMS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`CMS API error: ${res.status}`);

  const data = await res.json();
  const raw = Array.isArray(data) ? data : data.products ?? [];

  const inventory = raw.map(p => ({
    product_code: String(p.product_code ?? ''),
    name: p.name ?? '',
    description: stripHtml(p.description ?? ''),
    price: parseFloat(p.price ?? 0),
    stock: parseInt(p.quantity ?? 0, 10),
    primary_category: derivePrimaryCategory(p.categories ?? []),
    categories: (p.categories ?? []).map(c => c.name),
  }));

  // Only return products with stock > 0
  const inStock = inventory.filter(p => p.stock > 0);

  console.log(`[Inventory] ${inStock.length} products in stock`);
  cache.set('inventory', inStock);
  return inStock;
}

// ── WAREHOUSE FILTER ──────────────────────────────────────
// CMS currently returns a single stock number, not per-warehouse.
// When Odoo warehouse data is confirmed, filtering gets added here.
// For now we return all in-stock products for any warehouse.
function filterByWarehouse(inventory, warehouseKey) {
  return inventory;
}

// ── FORMAT FOR CLAUDE PROMPT ──────────────────────────────
function formatForPrompt(inventory) {
  return inventory.map(p => {
    const desc = p.description ? ` | ${p.description.slice(0, 150)}` : '';
    return `[${p.product_code}] ${p.name} | ${p.primary_category} | AED ${p.price} | Stock: ${p.stock}${desc}`;
  }).join('\n');
}

// ── HELPERS ───────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .trim();
}

function derivePrimaryCategory(categories) {
  if (!categories.length) return 'Drink';
  const broad = ['spirits', 'wine', 'beer', 'beverages', 'drinks', 'alcohol'];
  const specific = categories.find(c => !broad.includes(c.name?.toLowerCase()));
  return specific?.name ?? categories[categories.length - 1]?.name ?? 'Drink';
}

module.exports = { getInventory, filterByWarehouse, formatForPrompt };
