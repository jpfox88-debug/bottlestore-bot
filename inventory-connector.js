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

module.exports = { getInventory, filterByWarehouse, formatForPrompt, searchInventory };

// ── SMART SEARCH ──────────────────────────────────────────
// Searches inventory based on keywords from the user's message
// Returns up to maxResults most relevant products
function searchInventory(inventory, intent, maxResults = 80) {
  if (!intent) return inventory.slice(0, maxResults);

  // Accept either a string query (legacy) or a structured intent object
  if (typeof intent === 'string') {
    intent = { category: 'any', region: 'any', keywords: intent.toLowerCase().split(/\s+/) };
  }

  const { category = 'any', region = 'any', grape = null, maxPrice = null, keywords = [], vibe = null } = intent;
  const q = [...keywords, category, region, grape, vibe].filter(Boolean).join(' ').toLowerCase();

  // Category keyword mappings
  const categoryMap = {
    // Wine types
    'red wine': ['Red Wine', 'Fine Wine Red'],
    'white wine': ['White Wine', 'Fine Wine White'],
    'rose': ['Rosé Wine'],
    'rosé': ['Rosé Wine'],
    'sparkling': ['Champagne & Sparkling', 'Sparkling Wine'],
    'champagne': ['Champagne & Sparkling', 'Champagne'],
    'prosecco': ['Sparkling Wine', 'Champagne & Sparkling'],
    'port': ['Fortified Wine'],
    'vermouth': ['Vermouth'],
    // Spirits
    'whisky': ['Whisky & Bourbon'],
    'whiskey': ['Whisky & Bourbon'],
    'bourbon': ['Whisky & Bourbon'],
    'scotch': ['Whisky & Bourbon'],
    'gin': ['Gin'],
    'vodka': ['Vodka'],
    'rum': ['Rum'],
    'tequila': ['Tequila & Mezcal'],
    'mezcal': ['Tequila & Mezcal'],
    'cognac': ['Brandy & Cognac'],
    'brandy': ['Brandy & Cognac'],
    'liqueur': ['Liqueurs & Other Spirits'],
    // Beer
    'beer': ['Beer & Cider'],
    'lager': ['Beer & Cider'],
    'ipa': ['Beer & Cider'],
    'cider': ['Beer & Cider'],
    // Other
    'sake': ['Sake & Soju'],
    'soju': ['Sake & Soju'],
    'non-alcoholic': ['DrinkDry'],
    'alcohol free': ['DrinkDry'],
    'ready to drink': ['Ready to Drink'],
  };

  // Country/region keyword mappings to match against product names/descriptions
  const regionKeywords = {
    'french': ['france', 'bordeaux', 'burgundy', 'champagne', 'rhone', 'loire', 'provence', 'sancerre', 'chablis', 'pouilly'],
    'italian': ['italy', 'italian', 'toscana', 'barolo', 'chianti', 'prosecco', 'veneto', 'amarone', 'brunello', 'sicilia', 'piemonte'],
    'spanish': ['spain', 'spanish', 'rioja', 'ribera', 'priorat', 'cava', 'galicia'],
    'czech': ['czech', 'moravia', 'bohemia', 'thaya', 'zamecke', 'podyji'],
    'australian': ['australia', 'australian', 'barossa', 'margaret river', 'mclaren', 'victoria', 'tasmania'],
    'new zealand': ['new zealand', 'marlborough', 'central otago', 'hawkes bay'],
    'argentinian': ['argentina', 'argentinian', 'mendoza', 'malbec'],
    'chilean': ['chile', 'chilean', 'maipo', 'colchagua', 'casablanca'],
    'south african': ['south africa', 'stellenbosch', 'franschhoek', 'western cape'],
    'lebanese': ['lebanon', 'lebanese', 'bekaa', 'ksara', 'massaya', 'ixsir'],
    'japanese': ['japan', 'japanese', 'suntory', 'nikka', 'yamazaki', 'hakushu'],
    'scottish': ['scotland', 'scottish', 'scotch', 'islay', 'speyside', 'highland'],
    'irish': ['ireland', 'irish', 'jameson', 'bushmills'],
    'american': ['america', 'american', 'usa', 'bourbon', 'kentucky', 'tennessee', 'napa', 'california'],
  };

  // Score each product
  const scored = inventory.map(p => {
    let score = 0;
    const nameL = p.name.toLowerCase();
    const descL = (p.description || '').toLowerCase();
    const catL = (p.primary_category || '').toLowerCase();
    const catsL = (p.categories || []).join(' ').toLowerCase();
    const searchable = `${nameL} ${descL} ${catL} ${catsL}`;

    // Direct word matches in name (highest weight)
    const words = q.split(/\s+/).filter(w => w.length > 2);
    words.forEach(word => {
      if (nameL.includes(word)) score += 10;
      if (descL.includes(word)) score += 3;
      if (catL.includes(word)) score += 5;
    });

    // Category mapping matches
    Object.entries(categoryMap).forEach(([keyword, cats]) => {
      if (q.includes(keyword)) {
        if (cats.some(c => p.primary_category === c || (p.categories || []).includes(c))) {
          score += 15;
        }
      }
    });

    // Region/country matches
    Object.entries(regionKeywords).forEach(([keyword, terms]) => {
      if (q.includes(keyword)) {
        if (terms.some(t => searchable.includes(t))) score += 12;
      }
    });

    // Grape variety matches
    const grapes = ['malbec', 'merlot', 'cabernet', 'sauvignon', 'chardonnay', 'pinot', 'syrah', 'shiraz', 'riesling', 'grenache', 'tempranillo', 'sangiovese', 'nebbiolo'];
    grapes.forEach(grape => {
      if (q.includes(grape) && searchable.includes(grape)) score += 10;
    });

    // Price range matching
    if (maxPrice && p.price > maxPrice) score -= 20; // penalise over-budget
    if (maxPrice && p.price <= maxPrice) score += 8;
    if (vibe === 'everyday' && p.price < 80) score += 5;
    if ((vibe === 'luxury' || vibe === 'celebration' || vibe === 'gift') && p.price > 150) score += 5;

    // Luxury/vibe boost
    if ((vibe === 'luxury' || vibe === 'celebration' || vibe === 'gift') 
        && (p.categories || []).includes('Luxury')) score += 8;

    return { product: p, score };
  });

  // Return top results with score > 0, or fallback to top stocked
  const relevant = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.product)
    .slice(0, maxResults);

  if (relevant.length < 10) {
    // Fallback: return top stocked products if no matches
    return inventory
      .sort((a, b) => (b.available_stock ?? b.total_stock) - (a.available_stock ?? a.total_stock))
      .slice(0, maxResults);
  }

  return relevant;
}

module.exports = { getInventory, filterByWarehouse, formatForPrompt, searchInventory };
