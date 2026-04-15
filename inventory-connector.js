/**
 * The Bottle Store — Inventory Connector
 * Merges CMS product data (descriptions, prices) with Odoo warehouse stock
 * Caches result for 5 minutes
 */

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 });

// ── CONFIG ──────────────────────────────────────────────
const CMS_URL = 'https://thebottlestoredelivery.com/index.php?route=extension/feed/products';
const CMS_TOKEN = process.env.CMS_API_TOKEN || '6971bc164bc91da904758ef1c6ae86c220d7f1937b0beb785b5adcee4998c0ab';

const ODOO_URL = process.env.ODOO_URL || 'https://the-bottle-store-staging-30431764.dev.odoo.com/api/products';
const ODOO_KEY = process.env.ODOO_API_KEY || 'test_api_key';

// ── FETCH CMS PRODUCTS ───────────────────────────────────
async function fetchCMSProducts() {
  const res = await fetch(CMS_URL, {
    headers: { 'Authorization': `Bearer ${CMS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`CMS API error: ${res.status}`);
  const data = await res.json();

  // Normalise — handle both array and wrapped response
  const products = Array.isArray(data) ? data : data.products ?? [];

  return products.map(p => ({
    product_code: String(p.product_code ?? ''),
    name: p.name ?? '',
    description: stripHtml(p.description ?? ''),
    price: parseFloat(p.price ?? 0),
    categories: (p.categories ?? []).map(c => c.name),
    // Derive primary category for the bot
    primary_category: derivePrimaryCategory(p.categories ?? []),
  }));
}

// ── FETCH ODOO STOCK ─────────────────────────────────────
async function fetchOdooStock() {
  const res = await fetch(`${ODOO_URL}?api_key=${ODOO_KEY}`);
  if (!res.ok) throw new Error(`Odoo API error: ${res.status}`);
  const data = await res.json();
  const products = Array.isArray(data) ? data : data.products ?? [];

  // Return a map of product_name/code -> warehouse stock
  const stockMap = {};
  products.forEach(p => {
    const key = String(p.product_code ?? p.name ?? '').toLowerCase().trim();
    stockMap[key] = {
      warehouses: p.stock ?? {},          // { abu_dhabi: 20, dubai: 5 }
      total: Object.values(p.stock ?? {}).reduce((a, b) => a + b, 0)
    };
  });
  return stockMap;
}

// ── MERGE & CACHE ─────────────────────────────────────────
async function getInventory() {
  const cached = cache.get('inventory');
  if (cached) return cached;

  console.log('[Inventory] Refreshing from CMS + Odoo...');

  const [cmsProducts, odooStock] = await Promise.all([
    fetchCMSProducts(),
    fetchOdooStock(),
  ]);

  const merged = cmsProducts.map(p => {
    // Match on product_code first, fall back to normalised name
    const key = (p.product_code || p.name).toLowerCase().trim();
    const nameKey = p.name.toLowerCase().trim();
    const stock = odooStock[key] ?? odooStock[nameKey] ?? { warehouses: {}, total: 0 };

    return {
      product_code: p.product_code,
      name: p.name,
      description: p.description,
      price: p.price,
      primary_category: p.primary_category,
      categories: p.categories,
      stock_by_warehouse: stock.warehouses,  // { abu_dhabi: 20, dubai: 5 }
      total_stock: stock.total,
    };
  });

  // Only keep products with at least some stock somewhere
  const inStock = merged.filter(p => p.total_stock > 0);

  console.log(`[Inventory] ${inStock.length} products in stock across all warehouses`);
  cache.set('inventory', inStock);
  return inStock;
}

// ── WAREHOUSE FILTER ──────────────────────────────────────
// Called per-request with the customer's selected warehouse
function filterByWarehouse(inventory, warehouseKey) {
  if (!warehouseKey) return inventory; // fallback: return all
  return inventory
    .filter(p => (p.stock_by_warehouse[warehouseKey] ?? 0) > 0)
    .map(p => ({
      ...p,
      available_stock: p.stock_by_warehouse[warehouseKey] ?? 0
    }));
}

// ── FORMAT FOR PROMPT ─────────────────────────────────────
// Converts inventory to a compact string for the Claude system prompt
function formatForPrompt(inventory) {
  return inventory.map(p => {
    const desc = p.description ? ` | ${p.description.slice(0, 120)}` : '';
    return `[${p.product_code}] ${p.name} | ${p.primary_category} | AED ${p.price} | Stock: ${p.available_stock ?? p.total_stock}${desc}`;
  }).join('\n');
}

// ── HELPERS ───────────────────────────────────────────────
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

function derivePrimaryCategory(categories) {
  // Use most specific category (deepest level)
  if (!categories.length) return 'Drink';
  // Prefer leaf categories over parents like "Spirits", "Wine"
  const broad = ['spirits', 'wine', 'beer', 'beverages', 'drinks'];
  const specific = categories.find(c => !broad.includes(c.name?.toLowerCase()));
  return specific?.name ?? categories[categories.length - 1]?.name ?? 'Drink';
}

module.exports = { getInventory, filterByWarehouse, formatForPrompt };
