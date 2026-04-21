/**
 * The Bottle Store — Inventory Connector
 * Pulls product data from the CMS API.
 * Caches result for 5 minutes
 */

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 });

// ── CONFIG ──────────────────────────────────────────────
const CMS_URL = 'https://thebottlestoredelivery.com/index.php?route=extension/feed/products';
const CMS_TOKEN = process.env.CMS_API_TOKEN;

// ── FETCH CMS PRODUCTS ───────────────────────────────────
async function fetchCMSProducts() {
  const res = await fetch(CMS_URL, {
    headers: { 'Authorization': `Bearer ${CMS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`CMS API error: ${res.status}`);
  const data = await res.json();
  const products = Array.isArray(data) ? data : data.products ?? [];

  return products.map(p => ({
    product_code: String(p.product_code ?? ''),
    name: p.name ?? '',
    description: stripHtml(p.description ?? ''),
    price: parseFloat(p.price ?? 0),
    categories: (p.categories ?? []).map(c => c.name),
    primary_category: derivePrimaryCategory(p.categories ?? []),
    total_stock: parseInt(p.quantity ?? p.stock ?? 1),
    stock_by_warehouse: {},
  }));
}

// ── GET INVENTORY (cached) ────────────────────────────────
async function getInventory() {
  const cached = cache.get('inventory');
  if (cached) return cached;

  console.log('[Inventory] Refreshing from CMS...');
  const products = await fetchCMSProducts();
  const inStock = products.filter(p => p.total_stock > 0);

  console.log(`[Inventory] ${inStock.length} products available`);
  cache.set('inventory', inStock);
  return inStock;
}

// ── WAREHOUSE FILTER ──────────────────────────────────────
function filterByWarehouse(inventory, warehouseKey) {
  if (!warehouseKey) return inventory.map(p => ({ ...p, available_stock: p.total_stock }));
  // CMS has no per-warehouse breakdown yet — return all with total_stock
  return inventory.map(p => ({
    ...p,
    available_stock: p.stock_by_warehouse[warehouseKey] ?? p.total_stock
  }));
}

// ── FORMAT FOR PROMPT ─────────────────────────────────────
function formatForPrompt(inventory) {
  return inventory.map(p => {
    const desc = p.description ? ` | ${p.description.slice(0, 100)}` : '';
    return `[${p.product_code}] ${p.name} | ${p.primary_category} | AED ${p.price} | Stock: ${p.available_stock ?? p.total_stock}${desc}`;
  }).join('\n');
}

// ── SMART SEARCH ──────────────────────────────────────────
// Accepts a structured intent object from the classifier
// Returns up to maxResults most relevant products
function searchInventory(inventory, intent, maxResults = 80) {
  if (!intent) return inventory.slice(0, maxResults);

  if (typeof intent === 'string') {
    intent = { category: 'any', region: 'any', keywords: intent.toLowerCase().split(/\s+/) };
  }

  const {
    category = 'any',
    region = 'any',
    grape = null,
    maxPrice = null,
    keywords = [],
    vibe = null
  } = intent;

  const categoryMap = {
    'red wine':      ['Red Wine', 'Fine Wine Red'],
    'white wine':    ['White Wine', 'Fine Wine White'],
    'rose':          ['Rosé Wine'],
    'rosé':          ['Rosé Wine'],
    'sparkling':     ['Champagne & Sparkling', 'Sparkling Wine'],
    'champagne':     ['Champagne & Sparkling', 'Champagne'],
    'prosecco':      ['Sparkling Wine', 'Champagne & Sparkling'],
    'port':          ['Fortified Wine'],
    'vermouth':      ['Vermouth'],
    'whisky':        ['Whisky & Bourbon'],
    'whiskey':       ['Whisky & Bourbon'],
    'bourbon':       ['Whisky & Bourbon'],
    'scotch':        ['Whisky & Bourbon'],
    'gin':           ['Gin'],
    'vodka':         ['Vodka'],
    'rum':           ['Rum'],
    'tequila':       ['Tequila & Mezcal'],
    'mezcal':        ['Tequila & Mezcal'],
    'cognac':        ['Brandy & Cognac'],
    'brandy':        ['Brandy & Cognac'],
    'liqueur':       ['Liqueurs & Other Spirits'],
    'beer':          ['Beer & Cider'],
    'lager':         ['Beer & Cider'],
    'ipa':           ['Beer & Cider'],
    'cider':         ['Beer & Cider'],
    'sake':          ['Sake & Soju'],
    'soju':          ['Sake & Soju'],
    'non-alcoholic': ['DrinkDry'],
    'alcohol free':  ['DrinkDry'],
  };

  const regionKeywords = {
    'french':        ['france', 'bordeaux', 'burgundy', 'rhone', 'loire', 'provence', 'alsace', 'sancerre', 'chablis'],
    'italian':       ['italy', 'italian', 'toscana', 'barolo', 'chianti', 'veneto', 'amarone', 'brunello', 'sicilia', 'piemonte'],
    'spanish':       ['spain', 'spanish', 'rioja', 'ribera', 'priorat', 'cava', 'galicia'],
    'czech':         ['czech', 'moravia', 'bohemia', 'thaya', 'zamecke', 'podyji', 'mikulov'],
    'australian':    ['australia', 'australian', 'barossa', 'margaret river', 'mclaren', 'victoria', 'tasmania'],
    'new zealand':   ['new zealand', 'marlborough', 'central otago', 'hawkes bay'],
    'argentinian':   ['argentina', 'argentinian', 'mendoza', 'malbec'],
    'chilean':       ['chile', 'chilean', 'maipo', 'colchagua', 'casablanca'],
    'south african': ['south africa', 'stellenbosch', 'franschhoek', 'western cape'],
    'lebanese':      ['lebanon', 'lebanese', 'bekaa', 'ksara', 'massaya', 'ixsir'],
    'japanese':      ['japan', 'japanese', 'suntory', 'nikka', 'yamazaki', 'hakushu', 'hibiki'],
    'scottish':      ['scotland', 'scottish', 'scotch', 'islay', 'speyside', 'highland', 'glenfiddich', 'macallan'],
    'irish':         ['ireland', 'irish', 'jameson', 'bushmills', 'teeling'],
    'american':      ['america', 'american', 'usa', 'bourbon', 'kentucky', 'tennessee', 'napa', 'california'],
  };

  const grapeVarieties = ['malbec', 'merlot', 'cabernet', 'sauvignon blanc', 'chardonnay',
    'pinot noir', 'pinot grigio', 'syrah', 'shiraz', 'riesling', 'grenache',
    'tempranillo', 'sangiovese', 'nebbiolo', 'viognier', 'gewurztraminer'];

  const scored = inventory.map(p => {
    let score = 0;
    const nameL = p.name.toLowerCase();
    const descL = (p.description || '').toLowerCase();
    const catL = (p.primary_category || '').toLowerCase();
    const catsL = (p.categories || []).join(' ').toLowerCase();
    const searchable = `${nameL} ${descL} ${catL} ${catsL}`;

    // Keyword matches
    keywords.forEach(word => {
      if (word.length < 3) return;
      if (nameL.includes(word)) score += 10;
      if (descL.includes(word)) score += 3;
      if (catL.includes(word)) score += 5;
    });

    // Category matching
    const catToMatch = (category || '').toLowerCase();
    if (catToMatch && catToMatch !== 'any') {
      const mappedCats = categoryMap[catToMatch] || [];
      if (mappedCats.some(c => (p.primary_category || '') === c || (p.categories || []).includes(c))) score += 15;
      if (catL.includes(catToMatch)) score += 10;
    }

    // Region matching
    const regionToMatch = (region || '').toLowerCase();
    if (regionToMatch && regionToMatch !== 'any') {
      const terms = regionKeywords[regionToMatch] || [regionToMatch];
      if (terms.some(t => searchable.includes(t))) score += 12;
    }

    // Grape matching
    if (grape) {
      if (searchable.includes(grape.toLowerCase())) score += 12;
    }
    grapeVarieties.forEach(g => {
      if (keywords.includes(g) && searchable.includes(g)) score += 10;
    });

    // Price filtering
    if (maxPrice && p.price > maxPrice) score -= 20;
    if (maxPrice && p.price <= maxPrice) score += 8;

    // Vibe scoring
    if (vibe === 'everyday' && p.price < 80) score += 5;
    if (['luxury', 'celebration', 'gift'].includes(vibe) && p.price > 150) score += 4;
    if (['luxury', 'celebration', 'gift'].includes(vibe) &&
      (p.categories || []).some(c => c.toLowerCase().includes('luxury') || c.toLowerCase().includes('fine'))) score += 6;

    return { product: p, score };
  });

  const relevant = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.product)
    .slice(0, maxResults);

  if (relevant.length < 5) {
    console.log('[Search] No strong matches, falling back to top stock');
    return inventory
      .sort((a, b) => (b.available_stock ?? b.total_stock) - (a.available_stock ?? a.total_stock))
      .slice(0, maxResults);
  }

  return relevant;
}

// ── HELPERS ───────────────────────────────────────────────
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

function derivePrimaryCategory(categories) {
  if (!categories.length) return 'Drink';
  const broad = ['spirits', 'wine', 'beer', 'beverages', 'drinks'];
  const specific = categories.find(c => !broad.includes(c.name?.toLowerCase()));
  return specific?.name ?? categories[categories.length - 1]?.name ?? 'Drink';
}

module.exports = { getInventory, filterByWarehouse, formatForPrompt, searchInventory };
