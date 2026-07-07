(function(){
  "use strict";

  // ---------- state ----------
  let collection = [];            // your owned records
  let wantlist = [];               // your wantlist
  let filtered = [];
  let filters = { format:null, genre:null, decade:null, formatDesc:null, country:null, creditId:null };
  let genreMode = 'style';         // 'genre' | 'style' | 'both'
  let viewMode = localStorage.getItem('cratespace:viewMode') || (matchMedia('(max-width:760px)').matches ? 'compact' : 'large');
  let searchTerm = "";
  let activeDataset = 'crate';     // 'crate' | 'wantlist'
  let currentView = { type:'browse' };
  const trackCache = new Map();    // release id -> tracklist (session only)
  let priceCache = {};             // release id -> {low, median, high, currency, unavailable, fetchedAt}
  let artistCache = {};            // artist id -> {name, profile, fetchedAt}
  let labelCache = {};             // label id -> {name, profile, fetchedAt}
  let marketCache = {};            // release id -> {numForSale, lowest, currency, fetchedAt}
  let enrichCache = {};            // release id -> {country, communityHave, communityWant, totalDurationSec, credits, fetchedAt}
  let valuePassRunning = false;
  let valuePassCancelled = false;
  let valuePassForce = false;

  const el = id => document.getElementById(id);
  const usernameInput = el('username');
  const tokenInput = el('token');
  const syncBtn = el('syncBtn');
  const fullSyncCrateBtn = el('fullSyncCrateBtn');
  const syncWantBtn = el('syncWantBtn');
  const fullSyncWantBtn = el('fullSyncWantBtn');
  const clearCacheBtn = el('clearCacheBtn');
  const ghRepo = el('ghRepo');
  const ghPath = el('ghPath');
  const ghToken = el('ghToken');
  const ghPushBtn = el('ghPushBtn');
  const ghPullBtn = el('ghPullBtn');
  const ghNote = el('ghNote');
  const setupToggle = el('setupToggle');
  const setupToggleLabel = el('setupToggleLabel');
  const setupPanel = el('setupPanel');
  const ghNoteDefault = ghNote.innerHTML;
  const syncNote = el('syncNote');
  const navTabs = el('navTabs');
  const tabCrate = el('tabCrate');
  const tabWant = el('tabWant');
  const tabGaps = el('tabGaps');
  const tabInsights = el('tabInsights');
  const crateCount = el('crateCount');
  const wantCount = el('wantCount');
  const gapsCount = el('gapsCount');
  const valueBar = el('valueBar');
  const valueSum = el('valueSum');
  const valueCoverage = el('valueCoverage');
  const valueProgress = el('valueProgress');
  const valueBtn = el('valueBtn');
  const valueRefreshBtn = el('valueRefreshBtn');
  const valueBarToggle = el('valueBarToggle');
  const viewModeToggle = el('viewModeToggle');
  const assumedConditionSelect = el('assumedConditionSelect');
  const displayCurrencySelect = el('displayCurrencySelect');
  const searchRow = el('searchRow');
  const layout = el('layout');
  const grid = el('grid');
  const detailView = el('detailView');
  const gapsView = el('gapsView');
  const insightsView = el('insightsView');
  const stateArea = el('stateArea');
  const searchInput = el('searchInput');
  const sortSelect = el('sortSelect');
  const groupSelect = el('groupSelect');
  const countTag = el('countTag');
  const formatTabs = el('formatTabs');
  const genreTabs = el('genreTabs');
  const decadeTabs = el('decadeTabs');
  const genreGroupLabel = el('genreGroupLabel');
  const genreModeToggle = el('genreModeToggle');
  const clearFiltersBtn = el('clearFilters');
  const filtersToggleBtn = el('filtersToggleBtn');
  const filtersCloseBtn = el('filtersCloseBtn');
  const modalRoot = el('modalRoot');

  // ---------- large-data storage (IndexedDB) ----------
  // localStorage has a small, fixed per-origin quota that's especially tight
  // on iOS Safari (historically ~5MB) — a large collection can blow straight
  // through it with nothing else even helping. IndexedDB's quota is tied to
  // actual available device storage instead, so the crate and wantlist —
  // the two essential, potentially-large datasets — live here rather than
  // in localStorage. Everything else (prices, bios, preferences) stays in
  // localStorage since it's smaller and the synchronous access is convenient.
  const IDB_NAME = 'cratespace-db';
  const IDB_STORE = 'kv';
  let idbPromise = null;
  function openIdb(){
    if(!window.indexedDB) return Promise.reject(new Error('This browser has no IndexedDB support — cannot store a crate this large.'));
    if(idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject)=>{
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = ()=>{ req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error || new Error('Could not open local database.'));
    });
    return idbPromise;
  }
  async function idbGet(key){
    const db = await openIdb();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = ()=> resolve(req.result === undefined ? null : req.result);
      req.onerror = ()=> reject(req.error);
    });
  }
  async function idbSet(key, value){
    const db = await openIdb();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = ()=> resolve(true);
      tx.onerror = ()=> reject(tx.error);
    });
  }
  async function idbSetSafe(key, value){
    try{ await idbSet(key, value); return true; }
    catch(e){ return false; }
  }
  async function idbDelete(key){
    const db = await openIdb();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = ()=> resolve(true);
      tx.onerror = ()=> reject(tx.error);
    });
  }

  // ---------- persistence ----------
  function collectionKey(u){ return `cratespace:collection:${u.toLowerCase()}`; }
  function wantlistKey(u){ return `cratespace:wantlist:${u.toLowerCase()}`; }

  function loadJSON(key){
    try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
  }
  function saveJSON(key, val){
    try{ localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch(e){ return false; }
  }

  async function loadAllCaches(){
    priceCache = (await idbGet('cratespace:prices')) || {};
    artistCache = (await idbGet('cratespace:artists')) || {};
    labelCache = (await idbGet('cratespace:labels')) || {};
    marketCache = (await idbGet('cratespace:market')) || {};
    enrichCache = (await idbGet('cratespace:enrich')) || {};
    const savedCondition = loadJSON('cratespace:assumedCondition');
    if(savedCondition) assumedConditionSelect.value = savedCondition;
    displayCurrencySelect.value = displayCurrency;
    ensureFxRates().then(()=>{
      if(displayCurrency === 'auto') return;
      updateValueBar();
      if(currentView.type === 'browse') render();
      else if(currentView.type === 'gaps') renderGapsView();
      else if(currentView.type === 'insights') renderInsightsView();
      else if(currentView.type === 'artist' || currentView.type === 'label') refreshAfterMutation();
    });
  }
  async function savePriceCache(){ await idbSet('cratespace:prices', priceCache); }
  async function saveMarketCache(){ await idbSet('cratespace:market', marketCache); }
  async function saveEnrichCache(){ await idbSet('cratespace:enrich', enrichCache); }
  async function saveArtistCache(){ await idbSet('cratespace:artists', artistCache); }
  async function saveLabelCache(){ await idbSet('cratespace:labels', labelCache); }

  function fmtDate(iso){
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  }
  function fmtMoney(value, currency){
    try{ return new Intl.NumberFormat(undefined, { style:'currency', currency: currency || 'USD', maximumFractionDigits:0, minimumFractionDigits:0 }).format(value); }
    catch(e){ return `${currency||''} ${Math.round(value)}`.trim(); }
  }

  // ---------- display currency & conversion ----------
  // Discogs' price suggestions come back in whatever currency the token's
  // account uses — that's the "auto" mode below, and needs no conversion.
  // Anything else is converted using ECB reference rates (via the free,
  // keyless Frankfurter API), cached locally for a day at a time.
  let displayCurrency = localStorage.getItem('cratespace:displayCurrency') || 'NOK';
  let fxRates = null;
  async function ensureFxRates(){
    const dayMs = 24*60*60*1000;
    const cached = loadJSON('cratespace:fxRates');
    if(cached && cached.rates && (Date.now() - cached.fetchedAt < dayMs)){
      fxRates = cached;
      return;
    }
    // Served as a static JSON file off a CDN rather than a custom API server —
    // CDNs send an unconditional Access-Control-Allow-Origin: * with no
    // origin-checking logic, which tends to work even from a null origin
    // (e.g. a page opened via file://), unlike some API servers.
    const urls = [
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json',
      'https://latest.currency-api.pages.dev/v1/currencies/eur.json'
    ];
    for(const url of urls){
      try{
        const resp = await fetch(url);
        if(!resp.ok) continue;
        const data = await resp.json();
        const raw = data.eur || {};
        const rates = { EUR: 1 };
        Object.keys(raw).forEach(k => { rates[k.toUpperCase()] = raw[k]; });
        fxRates = { rates, fetchedAt: Date.now() };
        saveJSON('cratespace:fxRates', fxRates);
        return;
      }catch(e){ /* try next mirror */ }
    }
    if(cached) fxRates = cached; // stale is better than nothing
  }
  function convertCurrency(amount, from, to){
    if(!from || !to || from === to || !fxRates || !fxRates.rates) return { amount, currency: from || to };
    const rFrom = fxRates.rates[from], rTo = fxRates.rates[to];
    if(!rFrom || !rTo) return { amount, currency: from }; // unsupported currency code — show source as-is
    return { amount: amount / rFrom * rTo, currency: to };
  }
  // The one function almost everywhere in the UI should call for a user-facing amount.
  function fmtMoneyDisplay(value, sourceCurrency){
    const src = sourceCurrency || 'USD';
    if(displayCurrency === 'auto') return fmtMoney(value, src);
    const { amount, currency } = convertCurrency(value, src, displayCurrency);
    return fmtMoney(amount, currency);
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function cleanDiscogsText(s){
    if(!s) return '';
    let t = escapeHtml(s)
      .replace(/\[b\](.*?)\[\/b\]/gs, '<strong>$1</strong>')
      .replace(/\[i\](.*?)\[\/i\]/gs, '<em>$1</em>')
      .replace(/\[u\](.*?)\[\/u\]/gs, '<u>$1</u>')
      .replace(/\[url=(.*?)\](.*?)\[\/url\]/gs, '<a href="$1" target="_blank" rel="noopener">$2</a>')
      .replace(/\[(?:a|l|r)=(.*?)\]/g, '$1');
    const paras = t.split(/\n{2,}/).map(p => p.replace(/\n/g,'<br>')).filter(Boolean);
    return paras.map(p=>`<p>${p}</p>`).join('');
  }

  function showState(html){
    stateArea.innerHTML = `<div class="state">${html}</div>`;
    layout.style.display = 'none';
    detailView.style.display = 'none';
    searchRow.style.display = 'none';
  }
  function clearState(){ stateArea.innerHTML = ''; }

  // ---------- shared rate-limit-aware Discogs fetch ----------
  const API = "https://api.discogs.com";
  const pace = { gapMs: 3200, maxGapMs: 15000, lastRequestAt: 0 };
  let lastTokenPresence = null;
  function currentToken(){ return tokenInput.value.trim(); }
  function ensurePace(hasToken){
    if(lastTokenPresence !== hasToken){
      pace.gapMs = hasToken ? 1300 : 3200;
      lastTokenPresence = hasToken;
    }
  }

  async function discogsFetch(url, onThrottle){
    const token = currentToken();
    ensurePace(!!token);
    const headers = token ? { Authorization: `Discogs token=${token}` } : {};
    const maxAttempts = 8;
    let attempt = 0;
    while(true){
      const wait = pace.gapMs - (Date.now() - pace.lastRequestAt);
      if(wait > 0) await new Promise(r=>setTimeout(r, wait));
      let resp, networkFailed = false;
      pace.lastRequestAt = Date.now();
      try{ resp = await fetch(url, { headers }); }
      catch(err){ networkFailed = true; }
      const isRateLimited = networkFailed || (resp && resp.status === 429);
      if(isRateLimited && attempt < maxAttempts){
        attempt++;
        const retryAfter = (!networkFailed && resp.headers.get('Retry-After')) ? Number(resp.headers.get('Retry-After')) * 1000 : 60000;
        pace.gapMs = Math.min(pace.gapMs * 1.6, pace.maxGapMs);
        if(onThrottle) onThrottle(`Discogs is throttling us — waiting ${Math.round(retryAfter/1000)}s, then slowing to ${(pace.gapMs/1000).toFixed(1)}s between requests (attempt ${attempt}/${maxAttempts})…`);
        await new Promise(r=>setTimeout(r, retryAfter));
        continue;
      }
      if(networkFailed){
        throw new Error("Couldn't reach Discogs after several retries, even after slowing way down. Wait a few minutes and try again, ideally with a token (it raises the limit from 25 to 60 requests/minute).");
      }
      return resp;
    }
  }

  const CONDITION_LABELS = ["Mint (M)","Near Mint (NM or M-)","Very Good Plus (VG+)","Very Good (VG)","Good Plus (G+)","Good (G)","Fair (F)","Poor (P)"];
  function extractCondition(entry){
    const notes = entry.notes;
    if(!Array.isArray(notes)) return null;
    // Field id 1 is Media Condition on a standard Discogs collection folder.
    const byFieldOne = notes.find(n => n.field_id === 1 && CONDITION_LABELS.includes(n.value));
    if(byFieldOne) return byFieldOne.value;
    // Fall back to scanning for any note that happens to match a known grade,
    // in case a custom field layout moved things around.
    const anyMatch = notes.find(n => CONDITION_LABELS.includes(n.value));
    return anyMatch ? anyMatch.value : null;
  }

  function mapEntry(entry){
    const bi = entry.basic_information || {};
    const artists = (bi.artists||[]).map(a=>({ id:a.id, name:(a.name||'').replace(/\s\(\d+\)$/,'') }));
    const labels = (bi.labels||[]).map(l=>({ id:l.id, name:l.name, catno:l.catno }));
    const formatDescriptions = (bi.formats||[]).flatMap(f=>f.descriptions||[]);
    return {
      id: entry.id,
      instance_id: entry.instance_id || null,
      artists,
      artistDisplay: artists.map(a=>a.name).join(', ') || 'Unknown artist',
      title: bi.title || 'Untitled',
      year: bi.year || null,
      cover: bi.cover_image || '',
      genres: bi.genres || [],
      styles: bi.styles || [],
      formats: (bi.formats||[]).map(f=>f.name),
      formatDescriptions,
      labels,
      catno: labels[0]?.catno || '',
      date_added: entry.date_added || null,
      condition: extractCondition(entry),
      masterId: bi.master_id || null
    };
  }

  // Fetches a sorted-by-added-desc list, page by page. If knownIds is provided
  // (non-empty), stops as soon as it sees 2 consecutive already-known items —
  // a small buffer against same-timestamp ties — and returns only the new
  // items found before that point. Discogs has no server-side "changes since"
  // endpoint, so this client-side early-stop is what makes a sync a delta
  // instead of a full re-fetch. Pass an empty/null knownIds for a full fetch.
  async function fetchPagedList(path, idFn, knownIds, onProgress){
    let page = 1, perPage = 100, newItems = [], totalPages = 1, consecutiveKnown = 0, stopped = false;
    outer:
    while(true){
      const url = `${API}${path}${path.includes('?')?'&':'?'}page=${page}&per_page=${perPage}`;
      const resp = await discogsFetch(url, note => onProgress && onProgress(page, totalPages, newItems.length, note));
      if(resp.status === 401) throw new Error("Discogs said this is private, or the token is invalid. Add a valid personal access token and try again.");
      if(resp.status === 404) throw new Error(`No Discogs user found with that username.`);
      if(!resp.ok){
        let msg = `Discogs returned an error (${resp.status}).`;
        try{ const j = await resp.json(); if(j.message) msg = j.message; }catch(e){}
        throw new Error(msg);
      }
      const data = await resp.json();
      totalPages = data.pagination?.pages || 1;
      const key = data.releases ? 'releases' : (data.wants ? 'wants' : null);
      const pageItems = key ? data[key] : [];
      for(const raw of pageItems){
        if(knownIds && knownIds.size && knownIds.has(idFn(raw))){
          consecutiveKnown++;
          if(consecutiveKnown >= 2){ stopped = true; break outer; }
          continue;
        }
        consecutiveKnown = 0;
        newItems.push(mapEntry(raw));
      }
      if(onProgress) onProgress(page, totalPages, newItems.length);
      if(page >= totalPages) break;
      page++;
    }
    return { items: newItems, stoppedEarly: stopped };
  }

  function collectionIdFor(raw){ return raw.instance_id ? `i${raw.instance_id}` : `r${raw.id}`; }
  function wantIdFor(raw){ return `r${raw.id}`; }
  function knownCollectionIds(items){ return new Set(items.map(r => r.instance_id ? `i${r.instance_id}` : `r${r.id}`)); }
  function knownWantIds(items){ return new Set(items.map(r => `r${r.id}`)); }

  function parseDurationToSeconds(dur){
    if(!dur) return 0;
    const parts = dur.split(':').map(Number);
    if(parts.some(isNaN)) return 0;
    if(parts.length === 2) return parts[0]*60 + parts[1];
    if(parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
    return 0;
  }

  async function storeEnrichmentFromReleaseData(releaseId, data){
    const totalDurationSec = (data.tracklist||[]).reduce((sum,t)=> sum + parseDurationToSeconds(t.duration), 0);
    const credits = (data.extraartists||[]).map(a=>({ id:a.id, name:(a.name||'').replace(/\s\(\d+\)$/,''), role:a.role||'' }));
    const entry = {
      country: data.country || null,
      communityHave: data.community?.have ?? null,
      communityWant: data.community?.want ?? null,
      totalDurationSec,
      credits,
      fetchedAt: Date.now()
    };
    enrichCache[releaseId] = entry;
    await saveEnrichCache();
    return entry;
  }

  async function fetchTracklist(releaseId){
    if(trackCache.has(releaseId)) return trackCache.get(releaseId);
    const resp = await discogsFetch(`${API}/releases/${releaseId}`);
    if(!resp.ok) throw new Error('Could not load the tracklist for this release.');
    const data = await resp.json();
    // Opening a record's modal already fetches this full payload for the tracklist —
    // piggyback the Insights enrichment fields off it for free, no extra request.
    await storeEnrichmentFromReleaseData(releaseId, data);
    const result = { tracklist: data.tracklist || [], notes: data.notes || '' };
    trackCache.set(releaseId, result);
    return result;
  }

  async function fetchEnrichment(releaseId, force){
    if(!force && enrichCache[releaseId]) return enrichCache[releaseId];
    const resp = await discogsFetch(`${API}/releases/${releaseId}`);
    if(!resp.ok) throw new Error('Could not load extra detail for this release.');
    const data = await resp.json();
    return storeEnrichmentFromReleaseData(releaseId, data);
  }

  async function fetchMarketStats(releaseId, force){
    if(!force && marketCache[releaseId]) return marketCache[releaseId];
    const resp = await discogsFetch(`${API}/marketplace/stats/${releaseId}`);
    let entry;
    if(resp.status === 404){
      entry = { numForSale:0, fetchedAt: Date.now() };
    }else if(!resp.ok){
      throw new Error('Could not load marketplace stats for this release.');
    }else{
      const data = await resp.json();
      entry = {
        numForSale: data.num_for_sale || 0,
        lowest: data.lowest_price ? data.lowest_price.value : null,
        currency: data.lowest_price ? data.lowest_price.currency : null,
        fetchedAt: Date.now()
      };
    }
    marketCache[releaseId] = entry;
    await saveMarketCache();
    return entry;
  }

  async function fetchPriceSuggestions(releaseId, force){
    if(!force && priceCache[releaseId]) return priceCache[releaseId];
    if(!currentToken()) throw new Error('Add a personal access token to see value estimates.');
    const resp = await discogsFetch(`${API}/marketplace/price_suggestions/${releaseId}`);
    let entry;
    if(resp.status === 404){
      entry = { unavailable:true, fetchedAt: Date.now() };
    }else if(!resp.ok){
      throw new Error('Could not load pricing for this release.');
    }else{
      const data = await resp.json();
      // Keep the raw per-condition numbers, not just the derived stats — lets us
      // audit an odd-looking value later without re-fetching from Discogs.
      const breakdown = Object.entries(data)
        .filter(([,v]) => v && typeof v.value === 'number')
        .map(([condition,v]) => ({ condition, value: v.value, currency: v.currency }));
      const values = breakdown.map(b=>b.value);
      const currency = breakdown.map(b=>b.currency).find(Boolean) || 'USD';
      if(!values.length){
        entry = { unavailable:true, fetchedAt: Date.now() };
      }else{
        const sorted = values.slice().sort((a,b)=>a-b);
        const mid = Math.floor(sorted.length/2);
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
        entry = { low: sorted[0], median, high: sorted[sorted.length-1], currency, breakdown, fetchedAt: Date.now() };
      }
    }
    priceCache[releaseId] = entry;
    await savePriceCache();
    return entry;
  }

  async function fetchArtistProfile(id){
    if(artistCache[id]) return artistCache[id];
    const resp = await discogsFetch(`${API}/artists/${id}`);
    let entry;
    if(resp.ok){
      const data = await resp.json();
      entry = { name: data.name, profile: data.profile || '', fetchedAt: Date.now() };
    }else{
      entry = { name:'', profile:'', error:true, fetchedAt: Date.now() };
    }
    artistCache[id] = entry;
    await saveArtistCache();
    return entry;
  }

  async function fetchLabelProfile(id){
    if(labelCache[id]) return labelCache[id];
    const resp = await discogsFetch(`${API}/labels/${id}`);
    let entry;
    if(resp.ok){
      const data = await resp.json();
      entry = { name: data.name, profile: data.profile || '', fetchedAt: Date.now() };
    }else{
      entry = { name:'', profile:'', error:true, fetchedAt: Date.now() };
    }
    labelCache[id] = entry;
    await saveLabelCache();
    return entry;
  }

  // ---------- data access ----------
  function activeItems(){ return activeDataset === 'wantlist' ? wantlist : collection; }
  function getAssumedCondition(){ return assumedConditionSelect.value || 'Very Good Plus (VG+)'; }

  // Returns {amount, currency, exact} for a record's estimated value, or null if unpriced.
  // exact=true means this is priced at the record's own known condition; otherwise it's
  // estimated using the user-chosen "assumed condition" fallback.
  function getItemValue(r){
    const p = priceCache[r.id];
    if(!p || p.unavailable || typeof p.median !== 'number') return null;
    if(p.breakdown && p.breakdown.length){
      const cond = r.condition || getAssumedCondition();
      const match = p.breakdown.find(b => b.condition === cond);
      if(match) return { amount: match.value, currency: match.currency || p.currency, exact: !!r.condition };
    }
    return { amount: p.median, currency: p.currency, exact:false };
  }

  function sumValueOf(items){
    let sum = 0, count = 0, currency = 'USD';
    items.forEach(r=>{
      const iv = getItemValue(r);
      if(iv){ sum += iv.amount; count++; currency = iv.currency || currency; }
    });
    return { sum, count, currency, total: items.length };
  }
  function valueSuffix(items){
    const v = sumValueOf(items);
    return v.count ? ` · ~${fmtMoneyDisplay(v.sum, v.currency)} (${v.count} of ${v.total} priced)` : '';
  }

  function groupKeyFor(r, mode){
    if(mode === 'artist') return r.artistDisplay || 'Unknown artist';
    if(mode === 'year') return r.year ? String(r.year) : 'Unknown year';
    if(mode === 'label') return (r.labels[0] && r.labels[0].name) || 'Unknown label';
    return null;
  }

  function matchesFormatMixValue(r, value){
    if(!r.formats.includes('Vinyl')) return false;
    const descs = r.formatDescriptions || [];
    const matches = descs.filter(d=>TARGET_FORMATS.includes(d));
    if(value === 'Vinyl (other)') return matches.length === 0;
    return matches.includes(value);
  }

  function applyFiltersAndSort(){
    const items = activeItems();
    filtered = items.filter(r=>{
      if(filters.format && !r.formats.includes(filters.format)) return false;
      if(filters.genre && !(r.genres.includes(filters.genre) || r.styles.includes(filters.genre))) return false;
      if(filters.decade){
        if(!r.year) return false;
        if(Math.floor(r.year/10)*10 !== filters.decade) return false;
      }
      if(filters.formatDesc && !matchesFormatMixValue(r, filters.formatDesc)) return false;
      if(filters.country && enrichCache[r.id]?.country !== filters.country) return false;
      if(filters.creditId && !(enrichCache[r.id]?.credits||[]).some(c=>c.id===filters.creditId)) return false;
      if(searchTerm){
        const hay = `${r.artistDisplay} ${r.title} ${r.labels.map(l=>l.name).join(' ')} ${r.catno} ${r.genres.join(' ')} ${r.styles.join(' ')}`.toLowerCase();
        if(!hay.includes(searchTerm)) return false;
      }
      return true;
    });
    const sortMode = sortSelect.value;
    filtered.sort((a,b)=>{
      switch(sortMode){
        case 'artist-asc': return a.artistDisplay.localeCompare(b.artistDisplay);
        case 'title-asc': return a.title.localeCompare(b.title);
        case 'year-desc': {
          if(!a.year && !b.year) return 0;
          if(!a.year) return 1;
          if(!b.year) return -1;
          return b.year - a.year;
        }
        case 'year-asc': {
          if(!a.year && !b.year) return 0;
          if(!a.year) return 1;
          if(!b.year) return -1;
          return a.year - b.year;
        }
        case 'added-desc': return new Date(b.date_added||0) - new Date(a.date_added||0);
        case 'value-desc': {
          const av=getItemValue(a)?.amount ?? null, bv=getItemValue(b)?.amount ?? null;
          if(av==null && bv==null) return 0;
          if(av==null) return 1;
          if(bv==null) return -1;
          return bv-av;
        }
        case 'value-asc': {
          const av=getItemValue(a)?.amount ?? null, bv=getItemValue(b)?.amount ?? null;
          if(av==null && bv==null) return 0;
          if(av==null) return 1;
          if(bv==null) return -1;
          return av-bv;
        }
        default: return 0;
      }
    });
  }

  // ---------- render: browse grid ----------
  function render(){
    if(currentView.type !== 'browse') return;
    applyFiltersAndSort();
    countTag.textContent = `${filtered.length} record${filtered.length===1?'':'s'}${valueSuffix(filtered)}`;
    if(filtered.length === 0){
      grid.innerHTML = `<div class="state" style="padding:60px 20px;">
        <h2>Empty bin</h2>
        <p>Nothing matches that search or filter combination. Try clearing a filter.</p>
      </div>`;
      return;
    }
    const isWant = activeDataset === 'wantlist';
    const mode = groupSelect.value;
    if(mode === 'none'){
      grid.innerHTML = `<div class="${gridClass()}">${filtered.map(r => sleeveCard(r, isWant)).join('')}</div>`;
    }else if(mode === 'master'){
      // Groups different pressings/versions of the same underlying release —
      // most useful on the wantlist, where several versions of one album
      // often get wantlisted separately. Releases with no master_id (some
      // compilations, one-offs) each get their own single-item group.
      const groups = new Map();
      filtered.forEach(r=>{
        const key = r.masterId ? `m:${r.masterId}` : `single:${r.id}`;
        if(!groups.has(key)) groups.set(key, { label: r.title, items: [] });
        groups.get(key).items.push(r);
      });
      const entries = Array.from(groups.values()).sort((a,b)=> b.items.length - a.items.length || a.label.localeCompare(b.label));
      grid.innerHTML = entries.map(g=>{
        return `
          <div class="group-section">
            <div class="group-header">
              <h3>${escapeHtml(g.label)}</h3>
              <span class="group-count">${g.items.length} version${g.items.length===1?'':'s'} wantlisted${valueSuffix(g.items)}</span>
            </div>
            <div class="${gridClass()}">${g.items.map(r=>sleeveCard(r, isWant)).join('')}</div>
          </div>`;
      }).join('');
    }else{
      const groups = new Map();
      filtered.forEach(r=>{
        const key = groupKeyFor(r, mode);
        if(!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });
      let keys = Array.from(groups.keys());
      if(mode === 'year'){
        keys.sort((a,b)=> (b==='Unknown year'?-Infinity:Number(b)) - (a==='Unknown year'?-Infinity:Number(a)));
      }else{
        keys.sort((a,b)=> a.localeCompare(b));
      }
      grid.innerHTML = keys.map(key=>{
        const items = groups.get(key);
        return `
          <div class="group-section">
            <div class="group-header">
              <h3>${escapeHtml(key)}</h3>
              <span class="group-count">${items.length} record${items.length===1?'':'s'}${valueSuffix(items)}</span>
            </div>
            <div class="${gridClass()}">${items.map(r=>sleeveCard(r, isWant)).join('')}</div>
          </div>`;
      }).join('');
    }
    wireSleeveClicks(grid);
  }

  function gridClass(){ return `grid grid-${viewMode}`; }

  function sleeveCard(r, isWant){
    const art = r.cover ? `<img src="${r.cover}" alt="${escapeHtml(r.title)} cover" loading="lazy">`
                         : `<div class="no-art">${escapeHtml(r.title)}</div>`;
    const iv = getItemValue(r);
    const priceBadge = iv
      ? `<div class="price-badge" title="${iv.exact ? `Priced at your copy's condition (${escapeHtml(r.condition)})` : 'Estimated using the assumed condition — actual condition not on record'}">${iv.exact?'':'~'}${fmtMoneyDisplay(iv.amount, iv.currency)}</div>` : '';
    const wantRibbon = isWant ? `<div class="want-ribbon">Want</div>` : '';
    const artistLinks = r.artists.map(a=>`<span class="artist-link" data-type="artist" data-id="${a.id}" data-name="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>`).join(', ');
    const firstLabel = r.labels[0];
    const labelLink = firstLabel ? `<span class="label-link" data-type="label" data-id="${firstLabel.id}" data-name="${escapeHtml(firstLabel.name)}">${escapeHtml(firstLabel.name)}</span>` : '—';

    if(viewMode === 'list'){
      const listPrice = iv ? `<span class="list-price">${iv.exact?'':'~'}${fmtMoneyDisplay(iv.amount, iv.currency)}</span>` : '';
      const listWant = isWant ? `<span class="list-want">Want</span>` : '';
      return `
        <div class="sleeve sleeve-list" data-id="${r.id}" tabindex="0">
          <div class="list-thumb">${art}</div>
          <div class="list-info">
            <div class="list-title">${escapeHtml(r.title)}</div>
            <div class="list-sub">${artistLinks} · ${r.year||'—'} · ${labelLink}</div>
          </div>
          ${listPrice}${listWant}
        </div>`;
    }

    return `
      <div class="sleeve" data-id="${r.id}" tabindex="0">
        <div class="sleeve-art">
          ${wantRibbon}${priceBadge}
          <div class="disc" data-catno="${escapeHtml(r.catno||'')}"></div>
          <div class="cover">${art}</div>
        </div>
        <div class="sleeve-meta">
          <div class="artist">${artistLinks}</div>
          <div class="title">${escapeHtml(r.title)}</div>
          <div class="sub">${r.year||'—'} · ${labelLink}</div>
        </div>
      </div>`;
  }

  function wireSleeveClicks(container){
    container.querySelectorAll('.sleeve').forEach(node=>{
      node.addEventListener('click', (e)=>{
        const al = e.target.closest('.artist-link');
        if(al){ e.stopPropagation(); openArtistView(Number(al.dataset.id), al.dataset.name); return; }
        const ll = e.target.closest('.label-link');
        if(ll){ e.stopPropagation(); openLabelView(Number(ll.dataset.id), ll.dataset.name); return; }
        openModal(Number(node.dataset.id));
      });
    });
  }

  function buildTabs(){
    const items = activeItems();
    const formats = {}, decades = {}, genreMap = {};
    items.forEach(r=>{
      r.formats.forEach(f => formats[f] = (formats[f]||0)+1);
      if(r.year){ const d = Math.floor(r.year/10)*10; decades[d] = (decades[d]||0)+1; }
      let source = [];
      if(genreMode === 'genre') source = r.genres;
      else if(genreMode === 'style') source = r.styles;
      else source = r.genres.concat(r.styles);
      source.forEach(g => genreMap[g] = (genreMap[g]||0)+1);
    });
    genreGroupLabel.textContent = genreMode === 'genre' ? 'Genre' : (genreMode === 'style' ? 'Style' : 'Genre & Style');
    formatTabs.innerHTML = tabsHtml(formats, filters.format);
    genreTabs.innerHTML = tabsHtml(genreMap, filters.genre);
    decadeTabs.innerHTML = tabsHtml(decades, filters.decade, v => v+'s');

    formatTabs.querySelectorAll('.tab').forEach(t=> t.addEventListener('click', ()=>{
      filters.format = (filters.format === t.dataset.val) ? null : t.dataset.val;
      setInsightFilterChip(null);
      buildTabs(); render(); closeFiltersDrawer();
    }));
    genreTabs.querySelectorAll('.tab').forEach(t=> t.addEventListener('click', ()=>{
      filters.genre = (filters.genre === t.dataset.val) ? null : t.dataset.val;
      setInsightFilterChip(null);
      buildTabs(); render(); closeFiltersDrawer();
    }));
    decadeTabs.querySelectorAll('.tab').forEach(t=> t.addEventListener('click', ()=>{
      const v = Number(t.dataset.val);
      filters.decade = (filters.decade === v) ? null : v;
      setInsightFilterChip(null);
      buildTabs(); render(); closeFiltersDrawer();
    }));
  }

  function tabsHtml(map, active, labelFn){
    return Object.entries(map)
      .sort((a,b)=> b[1]-a[1])
      .map(([val,count])=>{
        const isActive = String(active) === String(val);
        const label = labelFn ? labelFn(val) : val;
        return `<div class="tab ${isActive?'active':''}" data-val="${escapeHtml(val)}">
          <span>${escapeHtml(label)}</span><span class="n">${count}</span>
        </div>`;
      }).join('');
  }

  genreModeToggle.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      genreMode = btn.dataset.mode;
      genreModeToggle.querySelectorAll('button').forEach(b=>b.classList.toggle('active', b===btn));
      filters.genre = null;
      buildTabs(); render();
    });
  });

  valueBarToggle.addEventListener('click', ()=>{
    valueBar.classList.toggle('tools-open');
  });

  function updateViewModeButtons(){
    viewModeToggle.querySelectorAll('button').forEach(b=> b.classList.toggle('active', b.dataset.mode === viewMode));
  }
  viewModeToggle.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      viewMode = btn.dataset.mode;
      localStorage.setItem('cratespace:viewMode', viewMode);
      updateViewModeButtons();
      if(currentView.type === 'browse') render();
      else if(currentView.type === 'gaps') renderGapsView();
      else if(currentView.type === 'artist' || currentView.type === 'label') refreshAfterMutation();
    });
  });
  updateViewModeButtons();

  // ---------- modal ----------
  async function openModal(id){
    let sourceList = null;
    let r = activeItems().find(x=>x.id===id);
    if(r){ sourceList = activeDataset === 'wantlist' ? 'wantlist' : 'crate'; }
    if(!r){ r = collection.find(x=>x.id===id); if(r) sourceList = 'crate'; }
    if(!r){ r = wantlist.find(x=>x.id===id); if(r) sourceList = 'wantlist'; }
    if(!r) return;
    const art = r.cover ? `<img src="${r.cover}" alt="">` : `<div class="no-art">${escapeHtml(r.title)}</div>`;
    const artistLinks = r.artists.map(a=>`<span class="artist-link" data-type="artist" data-id="${a.id}" data-name="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>`).join(', ');
    const labelLinks = r.labels.map(l=>`<span class="label-link" data-type="label" data-id="${l.id}" data-name="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>`).join(', ') || '—';
    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="backdrop">
        <div class="modal">
          <button class="modal-close" id="modalClose">&times;</button>
          <div class="modal-grid">
            <div class="modal-art">
              <div class="disc" data-catno="${escapeHtml(r.catno||'')}"></div>
              <div class="cover">${art}</div>
            </div>
            <div class="modal-info">
              <div class="artist">${artistLinks}</div>
              <h2>${escapeHtml(r.title)}</h2>
              <div class="stamp">${r.year||'—'}</div>
              <div class="stamp">${escapeHtml(r.formats.join(' / ')||'—')}</div>
              <div class="stamp">${escapeHtml(r.catno||'no cat#')}</div>
              <div style="margin-top:8px;">
                ${r.genres.map(g=>`<span class="tag">${escapeHtml(g)}</span>`).join('')}
                ${r.styles.map(s=>`<span class="tag" style="background:var(--rust)">${escapeHtml(s)}</span>`).join('')}
              </div>
              <div style="margin-top:10px;font-size:12.5px;color:#6b6250;">${labelLinks}</div>
              <div class="value-block">
                <h4>Value</h4>
                <div id="valueBody"></div>
              </div>
              <div class="tracklist">
                <h4>Tracklist</h4>
                <div class="tracklist-body" id="tracklistBody"><div class="track-loading">Dropping the needle…</div></div>
              </div>
              <div class="modal-footer-row">
                <a class="discogs-link" href="https://www.discogs.com/release/${r.id}" target="_blank" rel="noopener">View on Discogs →</a>
                <button class="remove-btn" id="removeItemBtn">Remove from ${sourceList === 'crate' ? 'crate' : 'wantlist'}</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    el('backdrop').addEventListener('click', e=>{ if(e.target.id==='backdrop') closeModal(); });
    el('modalClose').addEventListener('click', closeModal);
    document.addEventListener('keydown', escCloseOnce);
    const removeBtn = el('removeItemBtn');
    if(removeBtn) removeBtn.addEventListener('click', async ()=>{
      const label = sourceList === 'crate' ? 'crate' : 'wantlist';
      const ok = await showConfirm(
        `Remove <b>${escapeHtml(r.title)}</b> by ${escapeHtml(r.artistDisplay)} from your ${label}? This only changes what's cached in this browser — it won't touch Discogs, and a future sync won't bring it back unless it's still on Discogs.`,
        { title:`Remove from ${label}?`, confirmLabel:'Remove', cancelLabel:'Keep it' }
      );
      if(!ok) return;
      if(sourceList === 'crate') await removeFromCrate(r); else await removeFromWantlist(r);
      closeModal();
      refreshAfterMutation();
    });
    modalRoot.querySelectorAll('.artist-link').forEach(node=> node.addEventListener('click', ()=>{
      closeModal(); openArtistView(Number(node.dataset.id), node.dataset.name);
    }));
    modalRoot.querySelectorAll('.label-link').forEach(node=> node.addEventListener('click', ()=>{
      closeModal(); openLabelView(Number(node.dataset.id), node.dataset.name);
    }));

    renderValueBody(r.id);

    try{
      const { tracklist } = await fetchTracklist(id);
      const body = el('tracklistBody');
      if(!body) return;
      if(!tracklist.length){
        body.innerHTML = `<div class="track-loading">No tracklist listed on Discogs for this release.</div>`;
        return;
      }
      body.innerHTML = tracklist.map(t=>{
        if(t.type_ === 'heading'){
          return `<div class="track-heading">${escapeHtml(t.title||'')}</div>`;
        }
        return `
        <div class="track-row">
          <span class="pos">${escapeHtml(t.position||'')}</span>
          <span>${escapeHtml(t.title||'')}</span>
          <span class="dur">${escapeHtml(t.duration||'')}</span>
        </div>`;
      }).join('');
    }catch(err){
      const body = el('tracklistBody');
      if(body) body.innerHTML = `<div class="track-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderValueBody(releaseId){
    const body = el('valueBody');
    if(!body) return;
    const cached = priceCache[releaseId];
    if(cached && !cached.unavailable){
      const breakdownHtml = cached.breakdown
        ? `<div class="value-breakdown">${cached.breakdown.slice().sort((a,b)=>a.value-b.value).map(b=>`
            <div class="breakdown-row"><span>${escapeHtml(b.condition)}</span><span>${fmtMoneyDisplay(b.value, b.currency)}</span></div>
          `).join('')}</div>`
        : `<div class="value-note">Condition-by-condition breakdown wasn't kept when this was first fetched — <span class="refresh-link" id="refreshValueLink">refresh this one price</span> to see it.</div>`;
      body.innerHTML = `
        <div class="value-grid">
          <div class="value-cell"><div class="lab">Low</div><div class="val">${fmtMoneyDisplay(cached.low, cached.currency)}</div></div>
          <div class="value-cell"><div class="lab">Median</div><div class="val">${fmtMoneyDisplay(cached.median, cached.currency)}</div></div>
          <div class="value-cell"><div class="lab">High</div><div class="val">${fmtMoneyDisplay(cached.high, cached.currency)}</div></div>
        </div>
        ${breakdownHtml}
        <div class="value-note">Discogs' modeled price suggestions per condition grade (Poor–Mint) — not a record of actual past sales, and not necessarily in the same currency a given sale was recorded in. <span class="refresh-link" id="refreshValueLink2">Refresh this price</span></div>`;
      const link1 = el('refreshValueLink');
      const link2 = el('refreshValueLink2');
      [link1, link2].forEach(link=>{
        if(!link) return;
        link.addEventListener('click', async ()=>{
          link.textContent = 'Refreshing…';
          try{
            await fetchPriceSuggestions(releaseId, true);
            renderValueBody(releaseId);
            render();
            updateValueBar();
          }catch(err){
            body.innerHTML = `<div class="value-note">${escapeHtml(err.message)}</div>`;
          }
        });
      });
      return;
    }
    if(cached && cached.unavailable){
      body.innerHTML = `<div class="value-note">No price suggestions available for this release on Discogs.</div>`;
      return;
    }
    if(!currentToken()){
      body.innerHTML = `<div class="value-note">Add a personal access token above to look up value estimates.</div>`;
      return;
    }
    body.innerHTML = `<button class="btn small" id="lookupValueBtn">Look up value</button>`;
    const btn = el('lookupValueBtn');
    if(btn) btn.addEventListener('click', async ()=>{
      btn.disabled = true;
      btn.textContent = 'Looking up…';
      try{
        await fetchPriceSuggestions(releaseId);
        renderValueBody(releaseId);
        render();
        updateValueBar();
      }catch(err){
        body.innerHTML = `<div class="value-note">${escapeHtml(err.message)}</div>`;
      }
    });
  }

  function escCloseOnce(e){ if(e.key==='Escape') closeModal(); }

  // Themed replacement for window.confirm() — returns a Promise<boolean>.
  function showConfirm(message, opts){
    opts = opts || {};
    const title = opts.title || 'Are you sure?';
    const confirmLabel = opts.confirmLabel || 'Continue';
    const cancelLabel = opts.cancelLabel || 'Cancel';
    return new Promise(resolve=>{
      const root = document.createElement('div');
      root.className = 'confirm-backdrop';
      root.innerHTML = `
        <div class="confirm-box">
          <div class="confirm-title">${escapeHtml(title)}</div>
          <div class="confirm-message">${message}</div>
          <div class="confirm-actions">
            <button class="btn ghost small" id="confirmCancelBtn">${escapeHtml(cancelLabel)}</button>
            <button class="btn small" id="confirmOkBtn">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(root);
      function cleanup(result){
        document.removeEventListener('keydown', onKey);
        root.remove();
        resolve(result);
      }
      function onKey(e){
        if(e.key === 'Escape') cleanup(false);
        if(e.key === 'Enter') cleanup(true);
      }
      document.addEventListener('keydown', onKey);
      root.addEventListener('click', e=>{ if(e.target === root) cleanup(false); });
      root.querySelector('#confirmCancelBtn').addEventListener('click', ()=> cleanup(false));
      root.querySelector('#confirmOkBtn').addEventListener('click', ()=> cleanup(true));
      root.querySelector('#confirmOkBtn').focus();
    });
  }

  function closeModal(){
    modalRoot.innerHTML = '';
    document.removeEventListener('keydown', escCloseOnce);
  }

  // Discogs has no way to tell us about deletions, so this is purely a local
  // edit — it never touches Discogs, and won't survive a resync if the item
  // is genuinely still there. Matched by instance_id where available (a
  // collection item's stable unique id) since the same release can appear
  // more than once in a crate; wantlist items fall back to release id.
  async function removeFromCrate(record){
    collection = collection.filter(r => record.instance_id ? r.instance_id !== record.instance_id : r.id !== record.id);
    const username = usernameInput.value.trim();
    if(username){
      const cached = (await idbGet(collectionKey(username))) || {};
      cached.items = collection;
      await idbSet(collectionKey(username), cached);
    }
  }
  async function removeFromWantlist(record){
    wantlist = wantlist.filter(r => r.id !== record.id);
    const username = usernameInput.value.trim();
    if(username){
      const cached = (await idbGet(wantlistKey(username))) || {};
      cached.items = wantlist;
      await idbSet(wantlistKey(username), cached);
    }
  }
  function refreshAfterMutation(){
    refreshNav();
    updateValueBar();
    if(currentView.type === 'browse'){ buildTabs(); render(); }
    else if(currentView.type === 'gaps'){ renderGapsView(); }
    else if(currentView.type === 'insights'){ renderInsightsView(); }
    else if(currentView.type === 'artist'){
      const inCrate = collection.filter(r=> r.artists.some(a=>a.id===currentView.id));
      const inWant = wantlist.filter(r=> r.artists.some(a=>a.id===currentView.id));
      renderDetailSections(inCrate, inWant);
    }else if(currentView.type === 'label'){
      const inCrate = collection.filter(r=> r.labels.some(l=>l.id===currentView.id));
      const inWant = wantlist.filter(r=> r.labels.some(l=>l.id===currentView.id));
      renderDetailSections(inCrate, inWant);
    }
  }

  // ---------- artist / label detail views ----------
  function showBrowseView(){
    currentView = { type:'browse' };
    detailView.style.display = 'none';
    gapsView.style.display = 'none';
    insightsView.style.display = 'none';
    layout.style.display = 'flex';
    searchRow.style.display = 'flex';
    tabGaps.classList.remove('active');
    tabInsights.classList.remove('active');
    render();
  }

  // Every clickable piece of metadata in Insights routes through here — always
  // lands on the Crate (collection) view, since Insights is scoped to your
  // collection, not the wantlist.
  function goToCrateWithFilter(opts){
    opts = opts || {};
    activeDataset = 'crate';
    tabCrate.classList.add('active');
    tabWant.classList.remove('active');
    filters = { format:null, genre:null, decade:null, formatDesc:null, country:null, creditId:null };
    searchTerm = ''; searchInput.value = '';
    if(opts.genreModeValue){
      genreMode = opts.genreModeValue;
      genreModeToggle.querySelectorAll('button').forEach(b=> b.classList.toggle('active', b.dataset.mode === genreMode));
    }
    if(opts.genre) filters.genre = opts.genre;
    if(opts.decade != null) filters.decade = opts.decade;
    if(opts.format) filters.format = opts.format;
    if(opts.formatDesc) filters.formatDesc = opts.formatDesc;
    if(opts.country) filters.country = opts.country;
    if(opts.creditId) filters.creditId = opts.creditId;
    if(opts.search){ searchTerm = opts.search.toLowerCase(); searchInput.value = opts.search; }
    setInsightFilterChip(opts.label || null);
    showBrowseView();
    buildTabs();
    updateValueBar();
    render();
  }

  function setInsightFilterChip(label){
    const chip = el('insightFilterChip');
    if(!chip) return;
    if(label){
      chip.style.display = 'inline-flex';
      chip.innerHTML = `Filtered from Insights: <b>${escapeHtml(label)}</b> <span class="chip-x" id="insightFilterClear">✕</span>`;
      const clearBtn = el('insightFilterClear');
      if(clearBtn) clearBtn.addEventListener('click', ()=>{
        filters = { format:null, genre:null, decade:null, formatDesc:null, country:null, creditId:null };
        searchTerm = ''; searchInput.value = '';
        setInsightFilterChip(null);
        buildTabs(); render();
      });
    }else{
      chip.style.display = 'none';
      chip.innerHTML = '';
    }
  }

  async function openArtistView(id, name){
    currentView = { type:'artist', id, name };
    layout.style.display = 'none';
    searchRow.style.display = 'none';
    gapsView.style.display = 'none';
    insightsView.style.display = 'none';
    tabGaps.classList.remove('active');
    tabInsights.classList.remove('active');
    detailView.style.display = 'block';
    renderDetailSkeleton(name);
    const inCrate = collection.filter(r=> r.artists.some(a=>a.id===id));
    const inWant = wantlist.filter(r=> r.artists.some(a=>a.id===id));
    renderDetailSections(inCrate, inWant);
    try{
      const profile = await fetchArtistProfile(id);
      if(currentView.type==='artist' && currentView.id===id) renderDetailBio(profile.name || name, profile);
    }catch(e){ /* leave loading note in place on failure */ }
  }

  async function openLabelView(id, name){
    currentView = { type:'label', id, name };
    layout.style.display = 'none';
    searchRow.style.display = 'none';
    gapsView.style.display = 'none';
    insightsView.style.display = 'none';
    tabGaps.classList.remove('active');
    tabInsights.classList.remove('active');
    detailView.style.display = 'block';
    renderDetailSkeleton(name);
    const inCrate = collection.filter(r=> r.labels.some(l=>l.id===id));
    const inWant = wantlist.filter(r=> r.labels.some(l=>l.id===id));
    renderDetailSections(inCrate, inWant);
    try{
      const profile = await fetchLabelProfile(id);
      if(currentView.type==='label' && currentView.id===id) renderDetailBio(profile.name || name, profile);
    }catch(e){ /* leave loading note in place on failure */ }
  }

  function renderDetailSkeleton(name){
    detailView.innerHTML = `
      <span class="back-link" id="backLink">← Back to crate</span>
      <div class="detail-header">
        <h2>${escapeHtml(name)}</h2>
        <div class="detail-bio" id="detailBio"><p class="detail-loading">Reading the sleeve notes…</p></div>
      </div>
      <div class="detail-section">
        <h3>In your crate <span class="detail-section-count" id="detailCrateCount"></span></h3>
        <div id="detailCrateGrid"></div>
      </div>
      <div class="detail-section">
        <h3>On your wantlist <span class="detail-section-count" id="detailWantCount"></span></h3>
        <div id="detailWantGrid"></div>
      </div>`;
    el('backLink').addEventListener('click', showBrowseView);
  }

  function renderDetailBio(name, profile){
    const bio = el('detailBio');
    if(!bio) return;
    if(profile.error){
      bio.innerHTML = `<p class="detail-loading">Couldn't load a description from Discogs for this one.</p>`;
      return;
    }
    bio.innerHTML = profile.profile ? cleanDiscogsText(profile.profile) : `<p class="detail-loading">No description on Discogs for this one.</p>`;
  }

  function renderDetailSections(inCrate, inWant){
    const crateGrid = el('detailCrateGrid');
    const wantGrid = el('detailWantGrid');
    const crateCountEl = el('detailCrateCount');
    const wantCountEl = el('detailWantCount');
    if(crateCountEl) crateCountEl.textContent = inCrate.length ? `(${inCrate.length}${valueSuffix(inCrate)})` : '';
    if(wantCountEl) wantCountEl.textContent = inWant.length ? `(${inWant.length}${valueSuffix(inWant)})` : '';
    if(crateGrid){
      crateGrid.innerHTML = inCrate.length
        ? `<div class="${gridClass()}">${inCrate.map(r=>sleeveCard(r,false)).join('')}</div>`
        : `<div class="empty-note">Nothing by this one in your crate yet.</div>`;
      wireSleeveClicks(crateGrid);
    }
    if(wantGrid){
      wantGrid.innerHTML = inWant.length
        ? `<div class="${gridClass()}">${inWant.map(r=>sleeveCard(r,true)).join('')}</div>`
        : `<div class="empty-note">Nothing by this one on your wantlist.</div>`;
      wireSleeveClicks(wantGrid);
    }
  }

  // ---------- fill the gaps ----------
  const TARGET_FORMATS = ['LP','7"','12"','Box Set'];
  let gapMinOwned = 2;
  let gapFormats = new Set(TARGET_FORMATS);
  let dealPassRunning = false;
  let dealPassCancelled = false;

  function hasTargetFormat(r, formatSet){
    if(!r.formatDescriptions || !r.formatDescriptions.length) return false;
    return r.formatDescriptions.some(d => formatSet.has(d));
  }

  function isVariousArtist(a){
    return a.id === 194 || /^various(\s+artists)?$/i.test((a.name||'').trim());
  }

  function computeGaps(){
    // Only counts releases where we know the format breakdown — older cached
    // items synced before this feature was added won't have it until resynced.
    const ownedByArtist = new Map();
    collection.forEach(r=>{
      if(!hasTargetFormat(r, gapFormats)) return;
      r.artists.forEach(a=>{
        if(!a.id || isVariousArtist(a)) return;
        if(!ownedByArtist.has(a.id)) ownedByArtist.set(a.id, { name:a.name, releases:[] });
        ownedByArtist.get(a.id).releases.push(r);
      });
    });
    const wantByArtist = new Map();
    wantlist.forEach(r=>{
      if(!hasTargetFormat(r, gapFormats)) return;
      r.artists.forEach(a=>{
        if(!a.id || isVariousArtist(a)) return;
        if(!wantByArtist.has(a.id)) wantByArtist.set(a.id, { name:a.name, releases:[] });
        wantByArtist.get(a.id).releases.push(r);
      });
    });
    const groups = [];
    wantByArtist.forEach((want, artistId)=>{
      const owned = ownedByArtist.get(artistId);
      const ownedCount = owned ? owned.releases.length : 0;
      if(ownedCount < gapMinOwned) return;
      groups.push({ artistId, name: owned.name || want.name, ownedCount, wanted: want.releases });
    });
    groups.sort((a,b)=> b.ownedCount - a.ownedCount || a.name.localeCompare(b.name));
    return groups;
  }

  function anyMissingFormatData(){
    return collection.length > 0 && collection.every(r => !r.formatDescriptions);
  }

  function showGapsView(){
    currentView = { type:'gaps' };
    layout.style.display = 'none';
    searchRow.style.display = 'none';
    detailView.style.display = 'none';
    insightsView.style.display = 'none';
    gapsView.style.display = 'block';
    tabCrate.classList.remove('active');
    tabWant.classList.remove('active');
    tabInsights.classList.remove('active');
    tabGaps.classList.add('active');
    renderGapsView();
  }

  function renderGapsView(){
    const groups = computeGaps();
    gapsCount.textContent = groups.length;
    const missingFormats = anyMissingFormatData();
    const controlsHtml = `
      <div class="gaps-controls">
        <div class="ctrl">
          <label>Focus formats</label>
          <div class="format-checks" id="gapFormatChecks">
            ${TARGET_FORMATS.map(f=>`<label><input type="checkbox" value="${escapeHtml(f)}" ${gapFormats.has(f)?'checked':''}> ${escapeHtml(f)}</label>`).join('')}
          </div>
        </div>
        <div class="ctrl">
          <label>Minimum owned</label>
          <select id="gapMinOwnedSelect">
            ${[1,2,3,4,5,8,10].map(n=>`<option value="${n}" ${n===gapMinOwned?'selected':''}>${n}+ releases</option>`).join('')}
          </select>
        </div>
        <div class="ctrl">
          <label>Deals (opt-in — one Discogs request per record)</label>
          <div>
            <button class="btn small" id="dealPassBtn">Check for deals</button>
            <button class="btn ghost small" id="dealRefreshBtn">Refresh all</button>
          </div>
        </div>
        <div class="gaps-note" id="gapsProgress">
          Artists you own <b>${gapMinOwned}+</b> of (in ${TARGET_FORMATS.filter(f=>gapFormats.has(f)).join(', ')||'—'}) with something still on your wantlist.
          ${missingFormats ? ' Your cached crate predates format tracking — run a <b>Full resync</b> of your crate for accurate results here.' : ''}
        </div>
      </div>`;

    const groupsHtml = groups.length
      ? groups.map(g => `
          <div class="gap-group" data-artist-id="${g.artistId}">
            <div class="gap-group-header">
              <h3 class="gap-artist-link" data-id="${g.artistId}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</h3>
              <span class="gap-owned-badge">${g.ownedCount} owned</span>
              <span class="gap-want-count">${g.wanted.length} wanted${valueSuffix(g.wanted)}</span>
            </div>
            <div class="${gridClass()}">
              ${g.wanted.map(r => `<div class="gap-item">${sleeveCard(r, true)}${gapDealHtml(r)}</div>`).join('')}
            </div>
          </div>`).join('')
      : `<div class="state" style="padding:60px 20px;"><h2>No gaps found yet</h2><p>Either you already own everything you want from your regular artists, your wantlist doesn't overlap with them yet, or your crate needs a sync/resync so format data is available.</p></div>`;

    gapsView.innerHTML = `
      <h2 style="margin:0 0 6px;">Fill the Gaps</h2>
      <p class="detail-bio" style="margin-bottom:0;">Artists you already collect on vinyl, ranked by how deep you're already in — with what's still missing from your wantlist.</p>
      ${controlsHtml}
      ${groupsHtml}`;

    el('gapFormatChecks').querySelectorAll('input').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        if(cb.checked) gapFormats.add(cb.value); else gapFormats.delete(cb.value);
        renderGapsView();
      });
    });
    el('gapMinOwnedSelect').addEventListener('change', (e)=>{
      gapMinOwned = Number(e.target.value);
      renderGapsView();
    });
    el('dealPassBtn').addEventListener('click', ()=> runDealPass(groups, false));
    el('dealRefreshBtn').addEventListener('click', ()=> runDealPass(groups, true));
    gapsView.querySelectorAll('.gap-artist-link').forEach(h=>{
      h.addEventListener('click', ()=> openArtistView(Number(h.dataset.id), h.dataset.name));
    });
    wireSleeveClicks(gapsView);
  }

  function gapDealHtml(r){
    const price = priceCache[r.id];
    const market = marketCache[r.id];
    if(!market){
      return `<div class="gap-deal">Not checked yet.</div>`;
    }
    if(!market.numForSale){
      return `<div class="gap-deal">None currently for sale on Discogs.</div>`;
    }
    const nm = price?.breakdown?.find(b=>b.condition==='Near Mint (NM or M-)');
    const mint = price?.breakdown?.find(b=>b.condition==='Mint (M)');
    const ceiling = nm?.value ?? mint?.value ?? price?.median ?? null;
    const isDeal = ceiling != null && market.lowest != null && market.lowest <= ceiling;
    const lowestStr = market.lowest != null ? fmtMoneyDisplay(market.lowest, market.currency) : '—';
    const shopLink = `https://www.discogs.com/sell/release/${r.id}?sort=price%2Casc`;
    return `<div class="gap-deal ${isDeal?'deal-hit':''}">
      ${isDeal ? '★ Worth a look — ' : ''}Lowest listed: ${lowestStr} (${market.numForSale} for sale)${ceiling!=null ? ` · your NM/M estimate: ${fmtMoneyDisplay(ceiling, price.currency)}` : ''}
      <br><a href="${shopLink}" target="_blank" rel="noopener">Check condition on Discogs →</a>
    </div>`;
  }

  async function runDealPass(groups, force){
    if(dealPassRunning){ dealPassCancelled = true; return; }
    if(!currentToken()){
      el('gapsProgress').innerHTML = 'Add a personal access token above first — pricing data needs it.';
      return;
    }
    const items = groups.flatMap(g=>g.wanted);
    const todo = force ? items : items.filter(r => !marketCache[r.id]);
    dealPassRunning = true; dealPassCancelled = false;
    let done = 0;
    let erroredMessage = null;
    for(const r of todo){
      if(dealPassCancelled) break;
      try{
        await fetchMarketStats(r.id, force);
        if(!priceCache[r.id] || force) await fetchPriceSuggestions(r.id, force).catch(()=>{});
      }catch(err){
        erroredMessage = err.message;
        break;
      }
      done++;
      if(done % 3 === 0 || done === todo.length){
        const p = el('gapsProgress');
        if(p) p.textContent = `Checked ${done} of ${todo.length}…`;
        if(currentView.type === 'gaps') renderGapsView();
      }
    }
    dealPassRunning = false;
    if(currentView.type === 'gaps') renderGapsView();
    if(erroredMessage){
      const p = el('gapsProgress');
      if(p) p.textContent = `Stopped after an error (${done} checked first): ${erroredMessage}`;
    }
  }

  // ---------- insights ----------
  let timelineCutoff = localStorage.getItem('cratespace:timelineCutoff') || null;
  function monthsBetween(d1, d2){
    const a = new Date(d1), b = new Date(d2);
    return (b.getFullYear()-a.getFullYear())*12 + (b.getMonth()-a.getMonth());
  }
  function pct(n, total){ return total ? Math.round((n/total)*100) : 0; }

  function computeInsights(){
    if(!collection.length) return null;
    const artistMap = new Map(), labelMap = new Map();
    const genreMap = {}, styleMap = {}, decadeMap = {}, topFormatMap = {}, formatMixMap = {}, vinylDescMap = {}, yearCounts = {};
    const addedByMonth = new Map();
    let oldest = null, newest = null;
    const addedDates = [], filteredAddedDates = [];

    collection.forEach(r=>{
      r.artists.forEach(a=>{
        if(!a.id || isVariousArtist(a)) return;
        if(!artistMap.has(a.id)) artistMap.set(a.id, { name:a.name, count:0 });
        artistMap.get(a.id).count++;
      });
      r.labels.forEach(l=>{
        if(!l.id) return;
        if(!labelMap.has(l.id)) labelMap.set(l.id, { name:l.name, count:0 });
        labelMap.get(l.id).count++;
      });
      r.genres.forEach(g=> genreMap[g] = (genreMap[g]||0)+1);
      r.styles.forEach(st=> styleMap[st] = (styleMap[st]||0)+1);
      if(r.year){
        const d = Math.floor(r.year/10)*10;
        decadeMap[d] = (decadeMap[d]||0)+1;
        yearCounts[r.year] = (yearCounts[r.year]||0)+1;
        if(!oldest || r.year < oldest.year) oldest = r;
        if(!newest || r.year > newest.year) newest = r;
      }
      r.formats.forEach(f=>{
        topFormatMap[f] = (topFormatMap[f]||0)+1;
        if(f === 'Vinyl'){
          const matches = (r.formatDescriptions||[]).filter(d=>TARGET_FORMATS.includes(d));
          if(matches.length) matches.forEach(d=> formatMixMap[d] = (formatMixMap[d]||0)+1);
          else formatMixMap['Vinyl (other)'] = (formatMixMap['Vinyl (other)']||0)+1;
        }else{
          formatMixMap[f] = (formatMixMap[f]||0)+1;
        }
      });
      if(r.formats.includes('Vinyl') && r.formatDescriptions){
        r.formatDescriptions.forEach(d=>{
          if(TARGET_FORMATS.includes(d)) vinylDescMap[d] = (vinylDescMap[d]||0)+1;
        });
      }
      if(r.date_added){
        addedDates.push(r.date_added);
        if(!timelineCutoff || r.date_added >= timelineCutoff){
          filteredAddedDates.push(r.date_added);
          const ym = r.date_added.slice(0,7);
          addedByMonth.set(ym, (addedByMonth.get(ym)||0)+1);
        }
      }
    });

    filteredAddedDates.sort();
    const firstAdded = filteredAddedDates[0] || null;
    const lastAdded = filteredAddedDates[filteredAddedDates.length-1] || null;
    let avgPerMonth = null;
    if(firstAdded && lastAdded){
      const span = Math.max(1, monthsBetween(firstAdded, lastAdded)+1);
      avgPerMonth = filteredAddedDates.length / span;
    }

    const topArtist = [...artistMap.values()].sort((a,b)=>b.count-a.count)[0] || null;
    const topLabel = [...labelMap.values()].sort((a,b)=>b.count-a.count)[0] || null;
    const topGenre = Object.entries(genreMap).sort((a,b)=>b[1]-a[1])[0] || null;
    const topStyle = Object.entries(styleMap).sort((a,b)=>b[1]-a[1])[0] || null;
    const topDecade = Object.entries(decadeMap).sort((a,b)=>b[1]-a[1])[0] || null;

    let priced=0, valueSum=0, currency='USD';
    const valuedItems=[];
    collection.forEach(r=>{
      const iv = getItemValue(r);
      if(iv){ priced++; valueSum+=iv.amount; currency=iv.currency||currency; valuedItems.push({ r, amount:iv.amount, currency:iv.currency||currency }); }
    });
    valuedItems.sort((a,b)=>b.amount-a.amount);
    const topValuable = valuedItems.slice(0,10);
    const valueByGenre = {}, valueByDecade = {};
    valuedItems.forEach(({r,amount})=>{
      (r.genres.length?r.genres:['Unknown']).forEach(g=>{ valueByGenre[g] = (valueByGenre[g]||0)+amount; });
      if(r.year){ const d = Math.floor(r.year/10)*10; valueByDecade[d] = (valueByDecade[d]||0)+amount; }
    });

    let enrichedCount=0, totalDurationSec=0, haveSum=0, haveCount=0;
    const countryMap = {};
    const creditMap = new Map();
    collection.forEach(r=>{
      const e = enrichCache[r.id];
      if(!e) return;
      enrichedCount++;
      totalDurationSec += e.totalDurationSec||0;
      if(typeof e.communityHave === 'number'){ haveSum += e.communityHave; haveCount++; }
      if(e.country) countryMap[e.country] = (countryMap[e.country]||0)+1;
      const seen = new Set();
      (e.credits||[]).forEach(c=>{
        if(!c.id || seen.has(c.id)) return;
        seen.add(c.id);
        if(!creditMap.has(c.id)) creditMap.set(c.id, { name:c.name, count:0, roles:new Set() });
        const entry = creditMap.get(c.id);
        entry.count++;
        if(c.role) entry.roles.add(c.role);
      });
    });
    const topCredits = [...creditMap.values()].sort((a,b)=>b.count-a.count).slice(0,10);
    const avgHave = haveCount ? haveSum/haveCount : null;

    return {
      total: collection.length,
      artistCount: artistMap.size,
      labelCount: labelMap.size,
      topArtist, topLabel, topGenre, topStyle, topDecade,
      topFormatMap, formatMixMap, vinylDescMap,
      oldest, newest,
      firstAdded, lastAdded, avgPerMonth, addedByMonth,
      genreMapAll: genreMap, styleMapAll: styleMap, decadeMapAll: decadeMap,
      topStylesList: Object.entries(styleMap).sort((a,b)=>b[1]-a[1]).slice(0,10),
      priced, valueSum, currency, topValuable, valueByGenre, valueByDecade,
      enrichedCount, totalDurationSec, avgHave, countryMap, topCredits,
      artistMapAll: artistMap, labelMapAll: labelMap, yearCounts
    };
  }

  function ic(text, kind, value, label){
    return `<span class="insight-clickable" data-ik="${kind}" data-iv="${escapeHtml(String(value))}"${label?` data-ilabel="${escapeHtml(label)}"`:''}>${text}</span>`;
  }
  function wireInsightClicks(container){
    container.querySelectorAll('.insight-clickable').forEach(node=>{
      node.addEventListener('click', ()=>{
        const kind = node.dataset.ik, value = node.dataset.iv, label = node.dataset.ilabel || value;
        switch(kind){
          case 'artist': goToCrateWithFilter({ search:value, label:`Artist — ${value}` }); break;
          case 'label': goToCrateWithFilter({ search:value, label:`Label — ${value}` }); break;
          case 'genre': goToCrateWithFilter({ genre:value, genreModeValue:'genre', label:`Genre — ${value}` }); break;
          case 'style': goToCrateWithFilter({ genre:value, genreModeValue:'style', label:`Style — ${value}` }); break;
          case 'decade': goToCrateWithFilter({ decade:Number(value), label:`Decade — ${value}s` }); break;
          case 'title': goToCrateWithFilter({ search:value, label:`Title — ${value}` }); break;
          case 'formatDesc': goToCrateWithFilter({ formatDesc:value, label:`Format — ${value}` }); break;
          case 'country': goToCrateWithFilter({ country:value, label:`Pressing country — ${value}` }); break;
          case 'credit': goToCrateWithFilter({ creditId:Number(value), label:`Credit — ${label}` }); break;
        }
      });
    });
  }

  function buildNarrative(s){
    const paras = [];
    const vinylCount = s.topFormatMap['Vinyl']||0;
    const lp=s.vinylDescMap['LP']||0, seven=s.vinylDescMap['7"']||0, twelve=s.vinylDescMap['12"']||0, box=s.vinylDescMap['Box Set']||0;

    let p1 = `Your crate holds <b>${s.total}</b> record${s.total===1?'':'s'} across <b>${s.artistCount}</b> artists and <b>${s.labelCount}</b> labels`;
    if(vinylCount) p1 += ` — <b>${pct(vinylCount,s.total)}%</b> of it on vinyl`;
    if(lp||seven||twelve||box){
      const parts=[];
      if(lp) parts.push(`${ic(pct(lp,vinylCount)+'% LP','formatDesc','LP')}`);
      if(seven) parts.push(`${ic(pct(seven,vinylCount)+'% 7"','formatDesc','7"')}`);
      if(twelve) parts.push(`${ic(pct(twelve,vinylCount)+'% 12"','formatDesc','12"')}`);
      if(box) parts.push(`${ic(pct(box,vinylCount)+'% box sets','formatDesc','Box Set')}`);
      p1 += `, split roughly ${parts.join(', ')}`;
    }
    paras.push(p1 + '.');

    if(s.topArtist){
      paras.push(`${ic(`<b>${escapeHtml(s.topArtist.name)}</b>`,'artist',s.topArtist.name)} is your most-collected artist, with <b>${s.topArtist.count}</b> release${s.topArtist.count===1?'':'s'} — about ${pct(s.topArtist.count,s.total)}% of your entire shelf.`);
    }
    if(s.topDecade || s.topGenre || s.topStyle){
      const bits=[];
      if(s.topDecade) bits.push(`${ic(`<b>${s.topDecade[0]}s</b> pressings`,'decade',s.topDecade[0])} (${pct(s.topDecade[1],s.total)}%)`);
      if(s.topGenre) bits.push(`${ic(`<b>${escapeHtml(s.topGenre[0])}</b>`,'genre',s.topGenre[0])} as a genre`);
      if(s.topStyle) bits.push(`${ic(`<b>${escapeHtml(s.topStyle[0])}</b>`,'style',s.topStyle[0])} as the style you actually reach for most`);
      paras.push(`You lean hardest into ${bits.join(', and ')}.`);
    }
    if(s.topLabel){
      paras.push(`${ic(`<b>${escapeHtml(s.topLabel.name)}</b>`,'label',s.topLabel.name)} is the label you keep coming back to, with <b>${s.topLabel.count}</b> releases in your crate.`);
    }
    if(s.oldest && s.newest){
      const oldDecade = Math.floor(s.oldest.year/10)*10, newDecade = Math.floor(s.newest.year/10)*10;
      paras.push(`Your oldest pressing dates to ${ic(`<b>${s.oldest.year}</b>`,'decade',oldDecade)} (${ic(escapeHtml(s.oldest.title),'title',s.oldest.title)} by ${ic(escapeHtml(s.oldest.artistDisplay),'artist',s.oldest.artistDisplay)}); your newest catch is from ${ic(`<b>${s.newest.year}</b>`,'decade',newDecade)}.`);
    }
    if(s.firstAdded){
      const fmtShort = iso => new Date(iso).toLocaleDateString(undefined,{ year:'numeric', month:'long' });
      let p = `You've been logging records here since <b>${fmtShort(s.firstAdded)}</b>`;
      if(s.avgPerMonth) p += `, averaging roughly <b>${s.avgPerMonth < 1 ? s.avgPerMonth.toFixed(1) : Math.round(s.avgPerMonth)}</b> a month`;
      paras.push(p + '.');
    }
    if(s.priced){
      const top = s.topValuable[0];
      let p = `Priced items alone are worth an estimated <b>${fmtMoneyDisplay(s.valueSum,s.currency)}</b> (based on ${s.priced} of ${s.total} records)`;
      if(top) p += `, led by ${ic(`<b>${escapeHtml(top.r.title)}</b>`,'title',top.r.title)} by ${ic(escapeHtml(top.r.artistDisplay),'artist',top.r.artistDisplay)} at ${fmtMoneyDisplay(top.amount, top.currency)}`;
      paras.push(p + '.');
    }else{
      paras.push(`<span class="locked">Estimate some values from the My Crate view to unlock value-based insights here.</span>`);
    }
    if(s.enrichedCount){
      let p = '';
      if(s.totalDurationSec){
        const hours = s.totalDurationSec/3600;
        p += `Stack it all up and — for the ${s.enrichedCount} of ${s.total} records checked so far — you're sitting on roughly <b>${hours<48?hours.toFixed(1)+' hours':(hours/24).toFixed(1)+' days'}</b> of continuous listening. `;
      }
      if(s.avgHave!=null){
        p += `The average record here is owned by about <b>${Math.round(s.avgHave)}</b> other Discogs users — ${s.avgHave<200?"you're collecting deeper into the crates than most.":'a fairly well-trodden path, taste-wise.'}`;
      }
      if(p) paras.push(p);
      if(s.topCredits.length){
        const c = s.topCredits[0];
        const roleStr = c.roles.size ? [...c.roles].slice(0,2).join('/') : 'credited';
        paras.push(`Here's one you probably didn't clock: ${ic(`<b>${escapeHtml(c.name)}</b>`,'credit',c.id,c.name)} shows up as ${escapeHtml(roleStr)} on <b>${c.count}</b> of your records — more connective tissue running through your shelf than any single headline artist besides ${s.topArtist?ic(escapeHtml(s.topArtist.name),'artist',s.topArtist.name):'your top artist'}.`);
      }
    }else{
      paras.push(`<span class="locked">Run "Enrich my collection" below to unlock total playtime, pressing countries, and hidden-collaborator insights.</span>`);
    }
    return paras;
  }

  function showInsightsView(){
    currentView = { type:'insights' };
    layout.style.display = 'none';
    searchRow.style.display = 'none';
    detailView.style.display = 'none';
    gapsView.style.display = 'none';
    insightsView.style.display = 'block';
    tabCrate.classList.remove('active');
    tabWant.classList.remove('active');
    tabGaps.classList.remove('active');
    tabInsights.classList.add('active');
    renderInsightsView();
  }

  const chartInstances = {};
  function makeChart(canvasId, config){
    const canvas = el(canvasId);
    if(!canvas || typeof Chart === 'undefined') return;
    if(chartInstances[canvasId]){ chartInstances[canvasId].destroy(); }
    chartInstances[canvasId] = new Chart(canvas.getContext('2d'), config);
  }
  const PALETTE = ['#d8a51d','#9a3324','#49603f','#7c715a','#c98b3a','#6b2e22','#3a4a30','#a89b7c','#e0c068','#b5493a'];

  function renderInsightsView(){
    const s = computeInsights();
    if(!s){
      insightsView.innerHTML = `<div class="state" style="padding:60px 20px;"><h2>Nothing to analyze yet</h2><p>Sync your crate first — Insights works off your collection.</p></div>`;
      return;
    }
    const narrative = buildNarrative(s).map(p=>`<p>${p}</p>`).join('');

    const statCards = [
      { lab:'Total records', val:s.total },
      { lab:'Artists', val:s.artistCount },
      { lab:'Labels', val:s.labelCount },
      { lab:'Top artist', val:s.topArtist?s.topArtist.name:'—', sub:s.topArtist?`${s.topArtist.count} releases`:'', click:s.topArtist?{ik:'artist', iv:s.topArtist.name}:null },
      { lab:'Top decade', val:s.topDecade?`${s.topDecade[0]}s`:'—', sub:s.topDecade?`${s.topDecade[1]} records`:'', click:s.topDecade?{ik:'decade', iv:s.topDecade[0]}:null },
      { lab:'Top genre', val:s.topGenre?s.topGenre[0]:'—', click:s.topGenre?{ik:'genre', iv:s.topGenre[0]}:null },
      { lab:'Oldest pressing', val:s.oldest?s.oldest.year:'—', click:s.oldest?{ik:'decade', iv:Math.floor(s.oldest.year/10)*10}:null },
      { lab:'Newest addition', val:s.newest?s.newest.year:'—', click:s.newest?{ik:'decade', iv:Math.floor(s.newest.year/10)*10}:null }
    ];
    if(s.priced) statCards.push({ lab:'Est. crate value', val:fmtMoneyDisplay(s.valueSum,s.currency), sub:`${s.priced} of ${s.total} priced` });
    if(s.enrichedCount && s.totalDurationSec){
      const hours = s.totalDurationSec/3600;
      statCards.push({ lab:'Total playtime', val: hours<48?`${hours.toFixed(1)}h`:`${(hours/24).toFixed(1)}d`, sub:`${s.enrichedCount} of ${s.total} checked` });
    }
    if(s.avgHave!=null) statCards.push({ lab:'Avg. community "have"', val:Math.round(s.avgHave), sub:'lower = more obscure' });

    const statCardsHtml = statCards.map(c=>{
      const clickAttrs = c.click ? ` class="stat-card insight-clickable" data-ik="${c.click.ik}" data-iv="${escapeHtml(String(c.click.iv))}"` : ' class="stat-card"';
      return `<div${clickAttrs}><div class="lab">${escapeHtml(c.lab)}</div><div class="val">${escapeHtml(String(c.val))}</div>${c.sub?`<div class="sub">${escapeHtml(c.sub)}</div>`:''}</div>`;
    }).join('');

    const enrichHtml = `
      <div class="enrich-panel">
        <div class="txt">Unlock total playtime, pressing countries, community-obscurity, and hidden-collaborator insights by checking each record's full details (one Discogs request per record, cached afterward — opening a record's modal also does this for free, one at a time).</div>
        <div class="progress" id="enrichProgress"></div>
        <button class="btn small" id="enrichBtn">Enrich my collection</button>
        <button class="btn ghost small" id="enrichRefreshBtn">Refresh all</button>
      </div>`;

    const chartsHtml = `
      <div class="insight-section">
        <h3>The shape of your crate</h3>
        <div class="chart-grid">
          <div class="chart-box"><h4>Format mix</h4><canvas id="chartFormat"></canvas></div>
          <div class="chart-box"><h4>Top styles</h4><div class="chart-tall-wrap" id="chartStylesWrap"><canvas id="chartStyles"></canvas></div></div>
          <div class="chart-box"><h4>By decade</h4><canvas id="chartDecades"></canvas></div>
          <div class="chart-box"><h4>Top labels</h4><div class="chart-tall-wrap" id="chartLabelsWrap"><canvas id="chartLabels"></canvas></div></div>
          <div class="chart-box wide">
            <h4 style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <span>Collecting over time</span>
              <span class="timeline-cutoff-ctrl">
                Hide activity before
                <input type="date" id="timelineCutoffInput" value="${timelineCutoff||''}">
                ${timelineCutoff ? '<button class="btn ghost small" id="timelineCutoffClear">Clear</button>' : ''}
              </span>
            </h4>
            <canvas id="chartTimeline"></canvas>
          </div>
        </div>
      </div>`;

    const valueSection = s.priced ? `
      <div class="insight-section">
        <h3>Where the value sits</h3>
        <div class="chart-grid">
          <div class="chart-box"><h4>Value by genre</h4><canvas id="chartValueGenre"></canvas></div>
          <div class="chart-box"><h4>Value by decade</h4><canvas id="chartValueDecade"></canvas></div>
          <div class="chart-box wide">
            <h4>Most valuable records</h4>
            <table class="leaderboard">
              <thead><tr><th>Record</th><th>Artist</th><th style="text-align:right;">Est. value</th></tr></thead>
              <tbody>${s.topValuable.map(v=>`<tr><td>${ic(escapeHtml(v.r.title),'title',v.r.title)}</td><td>${ic(escapeHtml(v.r.artistDisplay),'artist',v.r.artistDisplay)}</td><td class="num">${fmtMoneyDisplay(v.amount,v.currency)}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      </div>` : '';

    const enrichedSection = s.enrichedCount ? `
      <div class="insight-section">
        <h3>Beyond the metadata</h3>
        <div class="chart-grid">
          ${Object.keys(s.countryMap).length ? `<div class="chart-box"><h4>Pressing countries</h4><div class="chart-tall-wrap" id="chartCountriesWrap"><canvas id="chartCountries"></canvas></div></div>` : ''}
          ${s.topCredits.length ? `<div class="chart-box wide">
            <h4>Most-credited names on your shelf (besides headline artists)</h4>
            <table class="leaderboard">
              <thead><tr><th>Name</th><th>Role(s)</th><th style="text-align:right;">Records</th></tr></thead>
              <tbody>${s.topCredits.map(c=>`<tr><td class="insight-clickable" data-ik="credit" data-iv="${c.id}" data-ilabel="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td><td>${escapeHtml([...c.roles].slice(0,3).join(', '))}</td><td class="num">${c.count}</td></tr>`).join('')}</tbody>
            </table>
          </div>` : ''}
        </div>
      </div>` : '';

    insightsView.innerHTML = `
      <h2 style="margin:0 0 6px;">Insights</h2>
      <div class="insight-narrative">${narrative}</div>
      <div class="stat-cards">${statCardsHtml}</div>
      ${enrichHtml}
      ${chartsHtml}
      ${valueSection}
      ${enrichedSection}
    `;

    el('enrichBtn').addEventListener('click', ()=> runEnrichPass(false));
    el('enrichRefreshBtn').addEventListener('click', ()=> runEnrichPass(true));
    el('timelineCutoffInput').addEventListener('change', (e)=>{
      timelineCutoff = e.target.value || null;
      if(timelineCutoff) localStorage.setItem('cratespace:timelineCutoff', timelineCutoff);
      else localStorage.removeItem('cratespace:timelineCutoff');
      renderInsightsView();
    });
    const cutoffClearBtn = el('timelineCutoffClear');
    if(cutoffClearBtn) cutoffClearBtn.addEventListener('click', ()=>{
      timelineCutoff = null;
      localStorage.removeItem('cratespace:timelineCutoff');
      renderInsightsView();
    });

    wireInsightClicks(insightsView);
    drawInsightCharts(s);
  }

  function drawInsightCharts(s){
    if(typeof Chart === 'undefined') return; // CDN unreachable/offline — page still works without charts
    Chart.defaults.color = '#ded2b4';
    Chart.defaults.borderColor = 'rgba(236,227,206,0.12)';
    Chart.defaults.font.family = "'IBM Plex Mono', monospace";

    function sizeTallWrap(wrapId, count){
      const wrap = el(wrapId);
      if(wrap) wrap.style.height = Math.max(180, count*28+24) + 'px';
    }

    // Default Chart.js hit-testing only registers a click that lands exactly on
    // a bar's pixels. getElementsAtEventForMode with intersect:false is much
    // more forgiving — it finds the nearest data point along the given axis,
    // so clicking anywhere in that bar's row (including on its label) works.
    function chartClick(axis, action){
      return (evt, _elements, chart) => {
        const pts = chart.getElementsAtEventForMode(evt.native || evt, 'index', { intersect:false, axis }, true);
        if(pts.length) action(pts[0].index);
      };
    }
    function chartHoverCursor(axis){
      return (evt, _elements, chart) => {
        const pts = chart.getElementsAtEventForMode(evt.native || evt, 'index', { intersect:false, axis }, true);
        evt.native.target.style.cursor = pts.length ? 'pointer' : 'default';
      };
    }

    const formatEntries = Object.entries(s.formatMixMap).sort((a,b)=>b[1]-a[1]);
    function formatMixAction(i){
      const v = formatEntries[i][0];
      goToCrateWithFilter({ formatDesc:v, label:`Format — ${v}` });
    }
    makeChart('chartFormat', {
      type:'doughnut',
      data:{ labels:formatEntries.map(e=>e[0]), datasets:[{ data:formatEntries.map(e=>e[1]), backgroundColor:PALETTE, borderColor:'#16130f', borderWidth:2 }] },
      options:{
        onClick: (evt, elements) => { if(elements.length) formatMixAction(elements[0].index); },
        onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins:{
          legend:{
            position:'bottom', labels:{ boxWidth:10, font:{size:10} },
            // Chart.js's default legend click just toggles that slice's visibility —
            // replacing it here means clicking a legend label filters instead of
            // making the slice disappear.
            onClick: (evt, legendItem) => formatMixAction(legendItem.index)
          }
        }
      }
    });

    sizeTallWrap('chartStylesWrap', s.topStylesList.length);
    makeChart('chartStyles', {
      type:'bar',
      data:{ labels:s.topStylesList.map(e=>e[0]), datasets:[{ data:s.topStylesList.map(e=>e[1]), backgroundColor:'#d8a51d' }] },
      options:{
        indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{display:false}},
        scales:{ x:{ ticks:{precision:0} }, y:{ ticks:{autoSkip:false} } },
        onClick: chartClick('y', i => { const v = s.topStylesList[i][0]; goToCrateWithFilter({ genre:v, genreModeValue:'style', label:`Style — ${v}` }); }),
        onHover: chartHoverCursor('y')
      }
    });

    const decadeEntries = Object.entries(s.decadeMapAll).sort((a,b)=>Number(a[0])-Number(b[0]));
    makeChart('chartDecades', {
      type:'bar',
      data:{ labels:decadeEntries.map(e=>e[0]+'s'), datasets:[{ data:decadeEntries.map(e=>e[1]), backgroundColor:'#9a3324' }] },
      options:{
        plugins:{legend:{display:false}}, scales:{ y:{ ticks:{precision:0} } },
        onClick: chartClick('x', i => { const v = Number(decadeEntries[i][0]); goToCrateWithFilter({ decade:v, label:`Decade — ${v}s` }); }),
        onHover: chartHoverCursor('x')
      }
    });

    const topLabels = [...s.labelMapAll.values()].sort((a,b)=>b.count-a.count).slice(0,10);
    sizeTallWrap('chartLabelsWrap', topLabels.length);
    makeChart('chartLabels', {
      type:'bar',
      data:{ labels:topLabels.map(l=>l.name), datasets:[{ data:topLabels.map(l=>l.count), backgroundColor:'#49603f' }] },
      options:{
        indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{display:false}},
        scales:{ x:{ ticks:{precision:0} }, y:{ ticks:{autoSkip:false} } },
        onClick: chartClick('y', i => { const v = topLabels[i].name; goToCrateWithFilter({ search:v, label:`Label — ${v}` }); }),
        onHover: chartHoverCursor('y')
      }
    });

    const months = [...s.addedByMonth.keys()].sort();
    makeChart('chartTimeline', {
      type:'line',
      data:{ labels:months, datasets:[{ data:months.map(m=>s.addedByMonth.get(m)), borderColor:'#d8a51d', backgroundColor:'rgba(216,165,29,0.15)', fill:true, tension:0.25, pointRadius:0 }] },
      options:{ plugins:{legend:{display:false}}, scales:{ x:{ ticks:{maxTicksLimit:10} }, y:{ ticks:{precision:0} } } }
    });

    if(s.priced){
      const genreVals = Object.entries(s.valueByGenre).sort((a,b)=>b[1]-a[1]).slice(0,8);
      makeChart('chartValueGenre', {
        type:'bar',
        data:{ labels:genreVals.map(e=>e[0]), datasets:[{ data:genreVals.map(e=>Math.round(e[1])), backgroundColor:'#d8a51d' }] },
        options:{
          indexAxis:'y', plugins:{legend:{display:false}},
          onClick: chartClick('y', i => { const v = genreVals[i][0]; goToCrateWithFilter({ genre:v, genreModeValue:'genre', label:`Genre — ${v}` }); }),
          onHover: chartHoverCursor('y')
        }
      });
      const decVals = Object.entries(s.valueByDecade).sort((a,b)=>Number(a[0])-Number(b[0]));
      makeChart('chartValueDecade', {
        type:'bar',
        data:{ labels:decVals.map(e=>e[0]+'s'), datasets:[{ data:decVals.map(e=>Math.round(e[1])), backgroundColor:'#9a3324' }] },
        options:{
          plugins:{legend:{display:false}},
          onClick: chartClick('x', i => { const v = Number(decVals[i][0]); goToCrateWithFilter({ decade:v, label:`Decade — ${v}s` }); }),
          onHover: chartHoverCursor('x')
        }
      });
    }

    if(Object.keys(s.countryMap).length){
      const countryEntries = Object.entries(s.countryMap).sort((a,b)=>b[1]-a[1]).slice(0,10);
      sizeTallWrap('chartCountriesWrap', countryEntries.length);
      makeChart('chartCountries', {
        type:'bar',
        data:{ labels:countryEntries.map(e=>e[0]), datasets:[{ data:countryEntries.map(e=>e[1]), backgroundColor:'#49603f' }] },
        options:{
          indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{display:false}},
          scales:{ y:{ ticks:{autoSkip:false} } },
          onClick: chartClick('y', i => { const v = countryEntries[i][0]; goToCrateWithFilter({ country:v, label:`Pressing country — ${v}` }); }),
          onHover: chartHoverCursor('y')
        }
      });
    }
  }

  let enrichPassRunning = false, enrichPassCancelled = false;
  async function runEnrichPass(force){
    if(enrichPassRunning){ enrichPassCancelled = true; return; }
    if(!currentToken()){
      const p = el('enrichProgress');
      if(p) p.textContent = 'Add a personal access token above first.';
      return;
    }
    const items = force ? collection : collection.filter(r => !enrichCache[r.id]);
    if(force){
      const ok = await showConfirm(`This re-checks full details for all <b>${collection.length}</b> records, one Discogs request each.`, { title:'Refresh all enrichment data?', confirmLabel:'Refresh all' });
      if(!ok) return;
    }
    enrichPassRunning = true; enrichPassCancelled = false;
    let done = 0;
    let erroredMessage = null;
    for(const r of items){
      if(enrichPassCancelled) break;
      try{ await fetchEnrichment(r.id, force); }
      catch(err){ erroredMessage = err.message; break; }
      done++;
      if(done % 5 === 0 || done === items.length){
        const p = el('enrichProgress');
        if(p) p.textContent = `Checked ${done} of ${items.length}…`;
        if(currentView.type === 'insights') renderInsightsView();
      }
    }
    enrichPassRunning = false;
    if(currentView.type === 'insights') renderInsightsView();
    if(erroredMessage){
      const p = el('enrichProgress');
      if(p) p.textContent = `Stopped after an error (${done} checked first): ${erroredMessage}`;
    }
  }

  // ---------- value pass (opt-in background pricing) ----------
  function updateValueBar(){
    const items = activeItems();
    let sum = 0, count = 0, currency = 'USD';
    items.forEach(r=>{
      const iv = getItemValue(r);
      if(iv){ sum += iv.amount; count++; currency = iv.currency || currency; }
    });
    valueSum.textContent = count ? fmtMoneyDisplay(sum, currency) : '—';
    valueCoverage.textContent = `${count} of ${items.length} priced`;
    if(valuePassRunning){
      valueBtn.textContent = valuePassForce ? 'Estimate value' : 'Stop';
      valueBtn.disabled = valuePassForce;
      valueRefreshBtn.textContent = valuePassForce ? 'Stop' : 'Refresh all';
      valueRefreshBtn.disabled = !valuePassForce;
    }else{
      valueBtn.textContent = count ? 'Estimate more' : 'Estimate value';
      valueBtn.disabled = false;
      valueRefreshBtn.textContent = 'Refresh all';
      valueRefreshBtn.disabled = false;
    }
  }

  async function runValuePass(force){
    if(valuePassRunning){ valuePassCancelled = true; return; }
    if(!currentToken()){
      valueProgress.textContent = 'Add a personal access token above first — Discogs requires it for pricing data.';
      return;
    }
    if(force){
      const ok = await showConfirm('This re-checks the price of every record in this view, even ones already priced. For a large collection that means one Discogs request per record and can take a long time.', { title:'Refresh all prices?', confirmLabel:'Refresh all' });
      if(!ok) return;
    }
    valuePassRunning = true;
    valuePassForce = force;
    valuePassCancelled = false;
    updateValueBar();
    const items = force ? activeItems() : activeItems().filter(r => !priceCache[r.id]);
    let done = 0;
    let erroredMessage = null;
    for(const r of items){
      if(valuePassCancelled) break;
      try{
        await fetchPriceSuggestions(r.id, force);
      }catch(err){
        erroredMessage = err.message;
        break;
      }
      done++;
      if(done % 5 === 0 || done === items.length){
        valueProgress.textContent = `${force ? 'Refreshing' : 'Pricing'} ${done} of ${items.length}…`;
        updateValueBar();
        render();
      }
    }
    valuePassRunning = false;
    if(erroredMessage){
      valueProgress.textContent = `Stopped after an error (${done} priced first): ${erroredMessage}`;
    }else{
      valueProgress.textContent = valuePassCancelled ? 'Stopped — click again to resume.' : (items.length ? 'Done.' : 'Nothing new to price.');
    }
    updateValueBar();
    render();
  }

  valueBtn.addEventListener('click', ()=> runValuePass(false));
  valueRefreshBtn.addEventListener('click', ()=> runValuePass(true));
  assumedConditionSelect.addEventListener('change', ()=>{
    saveJSON('cratespace:assumedCondition', assumedConditionSelect.value);
    updateValueBar();
    render();
  });

  displayCurrencySelect.addEventListener('change', ()=>{
    displayCurrency = displayCurrencySelect.value;
    localStorage.setItem('cratespace:displayCurrency', displayCurrency);
    updateValueBar();
    if(currentView.type === 'browse') render();
    else if(currentView.type === 'gaps') renderGapsView();
    else if(currentView.type === 'insights') renderInsightsView();
    else if(currentView.type === 'artist' || currentView.type === 'label') refreshAfterMutation();
  });

  // ---------- sync flow ----------
  function setSetupCollapsed(collapsed, persist){
    setupPanel.classList.toggle('collapsed', collapsed);
    setupToggle.classList.toggle('collapsed', collapsed);
    if(persist) localStorage.setItem('cratespace:setupCollapsed', collapsed ? '1' : '0');
  }
  function updateSetupToggleLabel(){
    setupToggleLabel.textContent = collection.length
      ? `Setup & Sync · ${collection.length} record${collection.length===1?'':'s'}`
      : 'Setup & Sync';
  }
  setupToggle.addEventListener('click', ()=>{
    setSetupCollapsed(!setupPanel.classList.contains('collapsed'), true);
  });

  function refreshNav(){
    crateCount.textContent = collection.length;
    wantCount.textContent = wantlist.length;
    navTabs.style.display = (collection.length || wantlist.length) ? 'flex' : 'none';
    valueBar.style.display = (collection.length || wantlist.length) ? 'flex' : 'none';
    updateSetupToggleLabel();
  }

  function switchDataset(ds){
    activeDataset = ds;
    tabCrate.classList.toggle('active', ds==='crate');
    tabWant.classList.toggle('active', ds==='wantlist');
    filters = { format:null, genre:null, decade:null, formatDesc:null, country:null, creditId:null };
    searchInput.value = ''; searchTerm = '';
    setInsightFilterChip(null);
    showBrowseView();
    buildTabs();
    updateValueBar();
    render();
  }
  tabCrate.addEventListener('click', ()=> switchDataset('crate'));
  tabWant.addEventListener('click', ()=> switchDataset('wantlist'));
  tabInsights.addEventListener('click', showInsightsView);
  tabGaps.addEventListener('click', showGapsView);

  async function doSyncCrate(opts){
    opts = opts || {};
    const full = !!opts.full;
    const quiet = !!opts.quiet; // true only for the initial cache load at boot
    const username = usernameInput.value.trim();
    if(!username){ showState(`<h2>Missing username</h2><p>Enter a Discogs username to dig through.</p>`); return; }

    if(quiet){
      const cached = await idbGet(collectionKey(username));
      if(cached && cached.items?.length){
        collection = cached.items;
        clearState();
        layout.style.display = 'flex';
        searchRow.style.display = 'flex';
        syncNote.innerHTML = `Crate loaded from this browser's cache · last synced <b>${fmtDate(cached.syncedAt)}</b>. Click "Sync my crate" to check for new records.`;
        refreshNav(); buildTabs(); updateValueBar(); render();
        return true;
      }
      return false;
    }

    const cachedRaw = full ? null : await idbGet(collectionKey(username));
    const existingItems = cachedRaw?.items || [];
    const knownIds = knownCollectionIds(existingItems);
    if(full && existingItems.length === 0){
      const priorRaw = await idbGet(collectionKey(username));
      if(priorRaw?.items?.length){
        const ok = await showConfirm(`This re-downloads all <b>${priorRaw.items.length}</b> records from Discogs from scratch instead of just checking for new ones. For a large crate that can take a while.`, { title:'Full resync your crate?', confirmLabel:'Full resync' });
        if(!ok) return;
      }
    }

    syncBtn.disabled = true; fullSyncCrateBtn.disabled = true;
    showState(`<div class="spinner-disc"></div><h2>${full ? 'Rebuilding the crate…' : 'Checking for new records…'}</h2><p id="progressText">Contacting Discogs.</p>`);
    try{
      const { items: newItems } = await fetchPagedList(
        `/users/${encodeURIComponent(username)}/collection/folders/0/releases?sort=added&sort_order=desc`,
        collectionIdFor,
        full ? null : knownIds,
        (page,total,count,note)=>{
          const p = document.getElementById('progressText');
          if(p) p.textContent = note || `${full ? 'Fetched' : 'Checked'} page ${page} of ${total} — ${count} ${full ? 'records' : 'new records'} so far.`;
        }
      );
      const merged = full ? newItems : newItems.concat(existingItems);
      collection = merged;
      await idbSet(collectionKey(username), { syncedAt: new Date().toISOString(), items: merged });
      localStorage.setItem('cratespace:lastUser', username);
      clearState();
      layout.style.display = 'flex';
      searchRow.style.display = 'flex';
      syncNote.innerHTML = full
        ? `Full resync complete · <b>${merged.length}</b> records loaded and cached.`
        : (newItems.length
            ? `Synced just now · <b>${newItems.length}</b> new record${newItems.length===1?'':'s'} found (now <b>${merged.length}</b> total).`
            : `No new records found · still <b>${merged.length}</b> total.`);
      filters = { format:null, genre:null, decade:null, formatDesc:null, country:null, creditId:null };
      searchInput.value = ''; searchTerm = '';
      switchDataset('crate');
      refreshNav(); buildTabs(); updateValueBar(); render();
      if(localStorage.getItem('cratespace:setupCollapsed') === null) setSetupCollapsed(true, false);
    }catch(err){
      showState(`<h2>Couldn't sync the crate</h2><p>${escapeHtml(err.message)}</p>`);
    }finally{
      syncBtn.disabled = false; fullSyncCrateBtn.disabled = false;
    }
  }

  async function doSyncWantlist(opts){
    opts = opts || {};
    const full = !!opts.full;
    const username = usernameInput.value.trim();
    if(!username){ showState(`<h2>Missing username</h2><p>Enter a Discogs username first.</p>`); return; }

    const cachedRaw = full ? null : await idbGet(wantlistKey(username));
    const existingItems = cachedRaw?.items || [];
    const knownIds = knownWantIds(existingItems);
    if(full && existingItems.length === 0){
      const priorRaw = await idbGet(wantlistKey(username));
      if(priorRaw?.items?.length){
        const ok = await showConfirm(`This re-downloads your entire wantlist (<b>${priorRaw.items.length}</b> items) from scratch instead of just checking for new ones.`, { title:'Full resync your wantlist?', confirmLabel:'Full resync' });
        if(!ok) return;
      }
    }

    syncWantBtn.disabled = true; fullSyncWantBtn.disabled = true;
    const prevNote = syncNote.innerHTML;
    syncNote.innerHTML = full ? `Rebuilding your wantlist from Discogs…` : `Checking your wantlist for new items…`;
    try{
      const { items: newItems } = await fetchPagedList(
        `/users/${encodeURIComponent(username)}/wants?sort=added&sort_order=desc`,
        wantIdFor,
        full ? null : knownIds,
        (page,total,count)=>{
          syncNote.innerHTML = `${full ? 'Fetching' : 'Checking'} wantlist — page ${page} of ${total}, ${count} ${full?'items':'new items'} so far…`;
        }
      );
      const merged = full ? newItems : newItems.concat(existingItems);
      wantlist = merged;
      await idbSet(wantlistKey(username), { syncedAt: new Date().toISOString(), items: merged });
      localStorage.setItem('cratespace:lastUser', username);
      syncNote.innerHTML = full
        ? `Wantlist rebuilt · <b>${merged.length}</b> items loaded and cached.`
        : (newItems.length
            ? `Wantlist synced · <b>${newItems.length}</b> new item${newItems.length===1?'':'s'} found (now <b>${merged.length}</b> total).`
            : `No new wantlist items found · still <b>${merged.length}</b> total.`);
      refreshNav(); buildTabs(); updateValueBar(); render();
    }catch(err){
      syncNote.innerHTML = prevNote;
      alert(`Couldn't sync the wantlist: ${err.message}`);
    }finally{
      syncWantBtn.disabled = false; fullSyncWantBtn.disabled = false;
    }
  }

  syncBtn.addEventListener('click', ()=> doSyncCrate({}));
  fullSyncCrateBtn.addEventListener('click', ()=> doSyncCrate({ full:true }));
  syncWantBtn.addEventListener('click', ()=> doSyncWantlist({}));
  fullSyncWantBtn.addEventListener('click', ()=> doSyncWantlist({ full:true }));
  clearCacheBtn.addEventListener('click', async ()=>{
    const username = usernameInput.value.trim();
    if(username){
      await idbDelete(collectionKey(username));
      await idbDelete(wantlistKey(username));
    }
    await idbDelete('cratespace:prices');
    await idbDelete('cratespace:artists');
    await idbDelete('cratespace:labels');
    await idbDelete('cratespace:market');
    await idbDelete('cratespace:enrich');
    // Clean up any leftovers from before these moved to IndexedDB.
    localStorage.removeItem('cratespace:prices');
    localStorage.removeItem('cratespace:artists');
    localStorage.removeItem('cratespace:labels');
    localStorage.removeItem('cratespace:market');
    localStorage.removeItem('cratespace:enrich');
    collection = []; wantlist = []; priceCache = {}; artistCache = {}; labelCache = {}; marketCache = {}; enrichCache = {};
    refreshNav();
    showState(`<h2>Cache cleared</h2><p>Enter your token (if needed) and sync again to reload your crate.</p>`);
  });

  async function buildBackupPayload(){
    const username = usernameInput.value.trim() || localStorage.getItem('cratespace:lastUser') || '';
    return {
      crateSpaceBackup: 1,
      exportedAt: new Date().toISOString(),
      username,
      collection: username ? await idbGet(collectionKey(username)) : null,
      wantlist: username ? await idbGet(wantlistKey(username)) : null,
      prices: priceCache,
      market: marketCache,
      artists: artistCache,
      labels: labelCache,
      enrich: enrichCache,
      assumedCondition: assumedConditionSelect.value
    };
  }

  function isValidBackupPayload(payload){
    return !!(payload && (payload.crateSpaceBackup === 1 || payload.deadwaxBackup === 1) && payload.username);
  }

  // Writes a backup payload's contents into localStorage. Returns
  // {failures, crateCount, wantCount} — callers handle confirmation dialogs,
  // failure messaging, and reloading themselves.
  async function applyBackupPayload(payload){
    const crateCount = payload.collection?.items?.length || 0;
    const wantCount = payload.wantlist?.items?.length || 0;
    const failures = [];

    // Everything here goes to IndexedDB now, which has no meaningful size
    // ceiling (unlike localStorage, which is especially tight on iOS Safari
    // and was the actual cause of "value data" failing to save before).
    // Clean up any leftover localStorage copies from before this moved.
    localStorage.removeItem('cratespace:prices');
    localStorage.removeItem('cratespace:market');
    localStorage.removeItem('cratespace:artists');
    localStorage.removeItem('cratespace:labels');
    localStorage.removeItem('cratespace:enrich');

    if(payload.collection && !(await idbSetSafe(collectionKey(payload.username), payload.collection))) failures.push('crate');
    if(payload.wantlist && !(await idbSetSafe(wantlistKey(payload.username), payload.wantlist))) failures.push('wantlist');
    if(!(await idbSetSafe('cratespace:prices', payload.prices || {}))) failures.push('value data');
    if(!(await idbSetSafe('cratespace:market', payload.market || {}))) failures.push('deal-check data');
    if(!(await idbSetSafe('cratespace:artists', payload.artists || {}))) failures.push('artist bios');
    if(!(await idbSetSafe('cratespace:labels', payload.labels || {}))) failures.push('label bios');
    if(!(await idbSetSafe('cratespace:enrich', payload.enrich || {}))) failures.push('enrichment data (playtime/credits/country)');
    if(payload.assumedCondition) saveJSON('cratespace:assumedCondition', payload.assumedCondition);
    localStorage.setItem('cratespace:lastUser', payload.username);
    return { failures, crateCount, wantCount };
  }

  function reportImportOutcome(username, failures, crateCount, wantCount){
    if(failures.length){
      alert(`Something went wrong saving: ${failures.join(', ')}. This shouldn't normally happen now that everything is stored in IndexedDB rather than the much smaller localStorage — it may be worth checking this device isn't critically low on storage overall, or trying again. Whatever did save is intact; the rest was skipped rather than silently lost.`);
    }else if(crateCount === 0 && wantCount === 0){
      alert(`Heads up: this backup itself contains 0 crate records and 0 wantlist items for "${username}" — there's nothing to restore from it. This usually means it was pushed before a sync had completed in that browser.`);
    }
  }

  // ---------- GitHub sync (private repo as a personal backend) ----------
  function githubToken(){ return ghToken.value.trim(); }

  // Proper byte-accurate UTF-8 <-> base64 conversion. The classic
  // btoa(unescape(encodeURIComponent(x))) trick relies on deprecated
  // escape/unescape functions that have real edge cases with certain
  // Unicode sequences — rare on a small string, but with thousands of
  // artist/label names the odds of hitting one climb fast, and the failure
  // mode is silent corruption (no thrown error, just a string that later
  // fails JSON.parse) rather than a clear crash. TextEncoder/TextDecoder
  // work on actual bytes and don't have that problem.
  function utf8ToBase64(str){
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const chunkSize = 0x8000;
    for(let i=0; i<bytes.length; i+=chunkSize){
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunkSize));
    }
    return btoa(binary);
  }
  function base64ToUtf8(b64){
    const binary = atob(b64.replace(/\s/g,''));
    const bytes = new Uint8Array(binary.length);
    for(let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parseRepoInput(){
    const raw = ghRepo.value.trim();
    const parts = raw.split('/').filter(Boolean);
    if(parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  async function githubApiFetch(url, options){
    options = options || {};
    const headers = Object.assign({
      'Authorization': `Bearer ${githubToken()}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, options.headers || {});
    let resp;
    try{
      resp = await fetch(url, Object.assign({}, options, { headers }));
    }catch(err){
      throw new Error("Couldn't reach GitHub's API — check your connection and try again.");
    }
    if(!resp.ok){
      let msg = `GitHub API error (${resp.status}).`;
      try{ const j = await resp.json(); if(j.message) msg = j.message; }catch(e){}
      if(resp.status === 401) msg = 'GitHub rejected the token — check it\'s valid and not expired.';
      if(resp.status === 403) msg = 'GitHub denied that request — check the token has "Contents: Read and write" permission on this repo.';
      if(resp.status === 404) msg = `Repo, branch, or path not found — check "${ghRepo.value.trim()}" is correct and the token can see it.`;
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return resp.status === 204 ? null : resp.json();
  }

  async function githubPush(onProgress){
    const parsed = parseRepoInput();
    if(!parsed) throw new Error('Enter the repo as "github-username/repo-name".');
    const { owner, repo } = parsed;
    const path = ghPath.value.trim() || 'cratespace-backup.json';
    const api = `https://api.github.com/repos/${owner}/${repo}`;

    const payload = await buildBackupPayload();
    const jsonStr = JSON.stringify(payload);
    const contentB64 = utf8ToBase64(jsonStr);

    onProgress && onProgress('Checking repo…');
    const repoInfo = await githubApiFetch(api);
    const branch = repoInfo.default_branch || 'main';

    onProgress && onProgress('Reading current branch…');
    let refData = null;
    try{
      refData = await githubApiFetch(`${api}/git/ref/heads/${encodeURIComponent(branch)}`);
    }catch(err){
      // A brand-new repo with zero commits has no branches yet. GitHub reports
      // this inconsistently — sometimes a plain 404, sometimes a 409 with
      // "Git Repository is empty." — so check the status code, not the wording.
      if(err.status !== 404 && err.status !== 409) throw err;
      // Handled below: bootstrap the first commit and create the branch.
    }

    let newCommitSha;
    if(refData){
      onProgress && onProgress('Uploading backup blob…');
      const blob = await githubApiFetch(`${api}/git/blobs`, {
        method:'POST',
        body: JSON.stringify({ content: contentB64, encoding:'base64' })
      });
      const commit = await githubApiFetch(`${api}/git/commits/${refData.object.sha}`);
      onProgress && onProgress('Building new commit…');
      const tree = await githubApiFetch(`${api}/git/trees`, {
        method:'POST',
        body: JSON.stringify({ base_tree: commit.tree.sha, tree:[{ path, mode:'100644', type:'blob', sha: blob.sha }] })
      });
      const newCommit = await githubApiFetch(`${api}/git/commits`, {
        method:'POST',
        body: JSON.stringify({ message:`CrateSpace backup — ${new Date().toISOString()}`, tree: tree.sha, parents:[refData.object.sha] })
      });
      newCommitSha = newCommit.sha;
      onProgress && onProgress('Updating branch…');
      await githubApiFetch(`${api}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method:'PATCH',
        body: JSON.stringify({ sha: newCommitSha })
      });
    }else{
      // Bootstrapping a genuinely empty repo: the low-level Git Data API
      // (blob/tree/commit/ref) doesn't reliably work with zero prior commits.
      // The simple Contents API is specifically built to create a new file
      // from nothing, so use that just for this first commit.
      onProgress && onProgress('Creating first commit (empty repo)…');
      let created;
      try{
        created = await githubApiFetch(`${api}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method:'PUT',
          body: JSON.stringify({ message:`CrateSpace backup — ${new Date().toISOString()}`, content: contentB64 })
        });
      }catch(err){
        throw new Error(`Couldn't create the first commit (${err.message}). A quick one-time fix: on GitHub, open the repo and click "Add a README file" (or add any file) to give it one initial commit, then try Push again — after that, pushes use a different path with no size limit.`);
      }
      newCommitSha = created.commit?.sha;
    }
    return { crateCount: payload.collection?.items?.length||0, wantCount: payload.wantlist?.items?.length||0 };
  }

  async function githubPull(onProgress){
    const parsed = parseRepoInput();
    if(!parsed) throw new Error('Enter the repo as "github-username/repo-name".');
    const { owner, repo } = parsed;
    const path = ghPath.value.trim() || 'cratespace-backup.json';
    const api = `https://api.github.com/repos/${owner}/${repo}`;

    onProgress && onProgress('Fetching backup…');
    let jsonStr, reportedSize, pathUsed;
    let needsGitDataApi = false;
    try{
      // Simple path first — works for files under the Contents API's size ceiling.
      const data = await githubApiFetch(`${api}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
      // For files past some size threshold, GitHub doesn't always error —
      // it can return 200 OK with an empty/missing content field instead
      // (encoding "none", or just no content at all) and expect you to
      // follow git_url. Check for that explicitly rather than trusting
      // any 200 response to mean we got real data.
      if(!data.content || data.encoding !== 'base64'){
        needsGitDataApi = true;
      }else{
        jsonStr = base64ToUtf8(data.content);
        reportedSize = data.size;
        pathUsed = 'contents API';
      }
    }catch(err){
      if(!/too large/i.test(err.message)) throw err;
      needsGitDataApi = true;
    }

    if(needsGitDataApi){
      // Large file — fall back to the Git Data API, which has no such limit.
      onProgress && onProgress('Large file — using the Git Data API…');
      const repoInfo = await githubApiFetch(api);
      const branch = repoInfo.default_branch || 'main';
      const refData = await githubApiFetch(`${api}/git/ref/heads/${encodeURIComponent(branch)}`);
      const commit = await githubApiFetch(`${api}/git/commits/${refData.object.sha}`);
      const tree = await githubApiFetch(`${api}/git/trees/${commit.tree.sha}?recursive=1`);
      const entry = tree.tree.find(t=>t.path===path);
      if(!entry) throw new Error(`Couldn't find "${path}" in the repo.`);
      const blobData = await githubApiFetch(`${api}/git/blobs/${entry.sha}`);
      jsonStr = base64ToUtf8(blobData.content);
      reportedSize = blobData.size;
      pathUsed = 'Git Data API';
    }

    // Sanity-check what we actually got against what GitHub says the file is.
    const actualBytes = new TextEncoder().encode(jsonStr).length;
    const sizeNote = (typeof reportedSize === 'number')
      ? ` GitHub reports the file as ${reportedSize} bytes; decoded to ${actualBytes} bytes via ${pathUsed}${reportedSize !== actualBytes ? ' — MISMATCH, likely truncated or corrupted in transit' : ' (matches)'}.`
      : '';

    let payload;
    try{ payload = JSON.parse(jsonStr); }
    catch(e){
      const posMatch = e.message.match(/position (\d+)/i);
      let context = '';
      if(posMatch){
        const pos = Number(posMatch[1]);
        context = ` Near byte ${pos}: …${jsonStr.slice(Math.max(0,pos-40), pos)}⚠${jsonStr.slice(pos, pos+40)}…`;
      }
      throw new Error(`The file in that repo doesn't look like valid JSON (${e.message}).${sizeNote}${context}`);
    }
    if(!isValidBackupPayload(payload)) throw new Error("That file doesn't look like a valid CrateSpace backup.");
    return payload;
  }

  function rememberGhFields(){
    localStorage.setItem('cratespace:ghRepo', ghRepo.value.trim());
    localStorage.setItem('cratespace:ghPath', ghPath.value.trim());
  }
  ghRepo.addEventListener('change', rememberGhFields);
  ghPath.addEventListener('change', rememberGhFields);

  ghPushBtn.addEventListener('click', async ()=>{
    rememberGhFields();
    ghPushBtn.disabled = true; ghPullBtn.disabled = true;
    try{
      const { crateCount, wantCount } = await githubPush(msg => ghNote.innerHTML = msg);
      ghNote.innerHTML = `Pushed just now — ${crateCount} crate records, ${wantCount} wantlist items.`;
    }catch(err){
      ghNote.innerHTML = `<span style="color:var(--rust)">${escapeHtml(err.message)}</span>`;
    }finally{
      ghPushBtn.disabled = false; ghPullBtn.disabled = false;
    }
  });

  ghPullBtn.addEventListener('click', async ()=>{
    rememberGhFields();
    ghPushBtn.disabled = true; ghPullBtn.disabled = true;
    try{
      const payload = await githubPull(msg => ghNote.innerHTML = msg);
      const crateCount = payload.collection?.items?.length || 0;
      const wantCount = payload.wantlist?.items?.length || 0;
      const existingHasData = collection.length || wantlist.length;
      const msg = existingHasData
        ? `This backup for "<b>${escapeHtml(payload.username)}</b>" contains <b>${crateCount}</b> crate records and <b>${wantCount}</b> wantlist items. It will replace what's cached in this browser now, plus pricing/deal/bio data.`
        : `Pull the backup for "<b>${escapeHtml(payload.username)}</b>" — <b>${crateCount}</b> crate records and <b>${wantCount}</b> wantlist items?`;
      const ok = await showConfirm(msg, { title:'Replace local data?', confirmLabel:'Pull & replace' });
      if(!ok){ ghNote.innerHTML = ghNoteDefault; ghPushBtn.disabled=false; ghPullBtn.disabled=false; return; }
      const { failures } = await applyBackupPayload(payload);
      reportImportOutcome(payload.username, failures, crateCount, wantCount);
      location.reload();
    }catch(err){
      ghNote.innerHTML = `<span style="color:var(--rust)">${escapeHtml(err.message)}</span>`;
      ghPushBtn.disabled = false; ghPullBtn.disabled = false;
    }
  });


  let searchDebounce;
  searchInput.addEventListener('input', ()=>{
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(()=>{
      searchTerm = searchInput.value.trim().toLowerCase();
      setInsightFilterChip(null);
      render();
    }, 150);
  });
  sortSelect.addEventListener('change', render);
  groupSelect.addEventListener('change', render);
  function closeFiltersDrawer(){ document.body.classList.remove('filters-open'); }
  filtersToggleBtn.addEventListener('click', ()=> document.body.classList.add('filters-open'));
  filtersCloseBtn.addEventListener('click', closeFiltersDrawer);

  clearFiltersBtn.addEventListener('click', ()=>{
    filters = { format:null, genre:null, decade:null, formatDesc:null, country:null, creditId:null };
    setInsightFilterChip(null);
    buildTabs(); render();
    closeFiltersDrawer();
  });
  document.querySelectorAll('.divider-group h4').forEach(h=>{
    h.addEventListener('click', ()=> h.closest('.divider-group').classList.toggle('collapsed'));
  });

  // ---------- boot ----------
  (async function init(){
    await loadAllCaches();
    const savedCollapsed = localStorage.getItem('cratespace:setupCollapsed');
    const hasExplicitPreference = savedCollapsed !== null;
    if(hasExplicitPreference) setSetupCollapsed(savedCollapsed === '1', false);
    const lastGhRepo = localStorage.getItem('cratespace:ghRepo');
    const lastGhPath = localStorage.getItem('cratespace:ghPath');
    if(lastGhRepo) ghRepo.value = lastGhRepo;
    if(lastGhPath) ghPath.value = lastGhPath;
    const lastUser = localStorage.getItem('cratespace:lastUser');
    if(lastUser){
      usernameInput.value = lastUser;
      const cachedWant = await idbGet(wantlistKey(lastUser));
      if(cachedWant && cachedWant.items?.length) wantlist = cachedWant.items;
      doSyncCrate({ quiet:true }).then(loaded=>{
        refreshNav(); updateValueBar();
        if(!hasExplicitPreference) setSetupCollapsed(!!loaded, false);
        if(!loaded){
          showState(`<h2>Your crate is empty</h2><p>Click "Sync my crate" to fetch it from Discogs.</p>`);
        }
      });
    }else{
      if(!hasExplicitPreference) setSetupCollapsed(false, false);
      showState(`<h2>Your crate is empty</h2><p>Enter your Discogs username (and a personal access token if your collection is private, or to raise the rate limit) then click "Sync my crate".</p>`);
    }
  })();
})();