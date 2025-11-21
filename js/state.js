// ===============================================
// state.js  — shared global state + utilities
// ===============================================

// Single global namespace for all modules
window.App = window.App || {};


// -------------------------------------------------
// 1. GLOBAL SHARED STATE
// -------------------------------------------------
App.state = {
  // Currently selected zones
  selectedPrimary: null,      // main selected zone (left or right)
  selectedSecondary: null,    // pair-focus zone

  // Hover state (always safe to reset on mouseout)
  currentHoverId: null,

  // Corridor UI state
  corridorMode: false,        // whether corridor highlighting is active
  activeCorridorId: null,     // canonical corridor ID (e.g. "Midtown↔JFK")
  availableCorridors: [],     // zone-specific list for dropdown/search
  corridorKeyToClusterIds: {},// canonical key → underlying cluster_ids

  // Zone caps (computed later)
  zoneCapMap: {},             // LocationID → max edges to show

  // Zoom coordination
  isAutoZooming: false,       // prevents hover flicker during zoom

  // OD nodes / structures
  odZonePoints: [],           // [{id, x, y, zone, borough}]
  odZonesById: {},            // id → zone metadata

  // Cluster data
  clusterById: {},            // cluster_id → timeseries array
  clusterTopList: [],         // top clusters ranked by volume

  // Corridor search index
  corridorSearch: {
    zoneNameToId: {},             // "chelsea" → id
    aliasToBoroughs: {},          // "JFK" → Set(["Queens"])
    corridorOriginOptions: [],    // list of all alias endpoints
    corridorDestOptionsByOrigin: {}, // alias → Set of allowed dest aliases
    corridorOriginOptionsByDest: {}  // inverse mapping for dest-based suggestions
  }
};


// -------------------------------------------------
// 2. GENERAL UTILITY HELPERS
// -------------------------------------------------
App.utils = {};

// Format hour like “08:00”
App.utils.fmtHour = function (h) {
  return (h < 10 ? "0" + h : h) + ":00";
};

// Normalize borough names (input may vary)
App.utils.normalizeBorough = function (b) {
  if (!b) return "";
  const s = b.toLowerCase();
  if (s.includes("manhattan")) return "Manhattan";
  if (s.includes("brooklyn")) return "Brooklyn";
  if (s.includes("queens")) return "Queens";
  if (s.includes("bronx")) return "The Bronx";
  if (s.includes("staten")) return "Staten Island";
  return b;
};

// Produce canonical corridor key: “A ↔ B” regardless of direction
App.utils.canonicalCorridorKeyFromLabel = function (label) {
  if (!label) return null;
  const parts = label.split("↔").map(s => s.trim());
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  const key = [a, b].sort((x, y) => x.localeCompare(y)).join("↔");
  return key;
};

// Case-insensitive zone lookup
App.utils.lookupZoneByName = function (name) {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return App.state.corridorSearch.zoneNameToId[key] || null;
};

// Detect borough keywords inside a user-typed string
App.utils.extractBoroughFromQuery = function (query) {
  if (!query) return null;
  const q = query.toLowerCase();
  if (q.includes("manh")) return "Manhattan";
  if (q.includes("brook")) return "Brooklyn";
  if (q.includes("queen")) return "Queens";
  if (q.includes("bronx")) return "The Bronx";
  if (q.includes("staten") || q.includes("si")) return "Staten Island";
  return null;
};