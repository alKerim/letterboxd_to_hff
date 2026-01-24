// Background service worker for HFF Library Availability Extension

// Cache for search results (persists during extension lifetime)
const searchCache = new Map();

// Session management
let sessionInitialized = false;
let sessionInitPromise = null;

// Request throttling - limit concurrent requests
const MAX_CONCURRENT_REQUESTS = 8;
let activeRequests = 0;
const requestQueue = [];

/**
 * Initialize a session with HFF WebOPAC
 * Must be called before making search requests
 */
async function ensureSession() {
  // If already initializing, wait for it
  if (sessionInitPromise) {
    return sessionInitPromise;
  }
  
  // If already initialized recently, skip
  if (sessionInitialized) {
    return true;
  }
  
  sessionInitPromise = (async () => {
    try {
      console.log('🔄 Initializing HFF session...');
      const response = await fetch('https://webopac.hff-muc.de/webOPACClient.hffsis/start.do?Login=wohff', {
        method: 'GET',
        credentials: 'include'
      });
      
      if (response.ok) {
        console.log('✅ HFF session initialized');
        sessionInitialized = true;
        
        // Session expires after some time, reset after 5 minutes
        setTimeout(() => {
          sessionInitialized = false;
          console.log('🔄 Session expired, will reinitialize on next request');
        }, 5 * 60 * 1000);
        
        return true;
      } else {
        console.error('❌ Failed to initialize session:', response.status);
        return false;
      }
    } catch (error) {
      console.error('❌ Error initializing session:', error);
      return false;
    } finally {
      sessionInitPromise = null;
    }
  })();
  
  return sessionInitPromise;
}

/**
 * Search for a film in the HFF library
 * @param {string} title - Film title to search for
 * @param {string} year - Film year (optional)
 * @returns {Promise<Object>} - Search result object
 */
async function searchFilm(title, year) {
  try {
    // Check cache first
    const cacheKey = `${title.toLowerCase()}_${year || 'no-year'}`;
    if (searchCache.has(cacheKey)) {
      console.log('🔄 Returning cached result for:', title);
      return searchCache.get(cacheKey);
    }

    console.log(`🔍 Starting search for: "${title}" ${year ? `(${year})` : ''}`);

    // Ensure we have a valid session
    await ensureSession();

    // Prepare search parameters - include year if available to narrow results
    const searchString = year ? `${title} ${year}` : title;
    const encodedSearch = encodeURIComponent(searchString.trim());
    
    // Perform the search with retry on session expired
    let result = await performSearch(searchString, encodedSearch, title, year);
    
    // If we got a session expired error, reinitialize and retry once
    if (result.error === 'Session expired') {
      console.log('🔄 Session expired, reinitializing and retrying...');
      sessionInitialized = false;
      await ensureSession();
      result = await performSearch(searchString, encodedSearch, title, year);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error searching for film:', error);
    return { available: false, error: error.message };
  }
}

/**
 * Wait for a slot in the request queue
 */
async function waitForRequestSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeRequests < MAX_CONCURRENT_REQUESTS) {
        activeRequests++;
        resolve();
      } else {
        requestQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

/**
 * Small delay to avoid hammering the server
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Release a request slot
 */
function releaseRequestSlot() {
  activeRequests--;
  if (requestQueue.length > 0) {
    const next = requestQueue.shift();
    next();
  }
}

/**
 * Perform the actual search request
 */
async function performSearch(searchString, encodedSearch, title, year) {
  // Wait for available slot to avoid overwhelming the server
  await waitForRequestSlot();
  
  // Small delay between requests (100ms) to be nice to the HFF server
  await delay(100);
  
  try {
    return await performSearchInternal(searchString, encodedSearch, title, year);
  } finally {
    releaseRequestSlot();
  }
}

/**
 * Internal search function (called after acquiring request slot)
 */
async function performSearchInternal(searchString, encodedSearch, title, year) {
  // Build simple search URL
  const searchUrl = `https://webopac.hff-muc.de/webOPACClient.hffsis/search.do?methodToCall=submit&methodToCallParameter=submitSearch&searchCategories%5B0%5D=-1&searchString%5B0%5D=${encodedSearch}`;
  
  console.log('🔍 Search URL:', searchUrl);
  console.log('🌐 Making search request to WebOPAC...');
  console.log('Search string:', searchString);

  try {
    const response = await fetch(searchUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    console.log('📡 Response status:', response.status);

    if (!response.ok) {
      console.error('❌ Search request failed:', response.status);
      const errorText = await response.text().catch(() => 'Could not read error body');
      console.error('📄 Error response:', errorText.substring(0, 500));
      return { available: false, error: `Search request failed with status ${response.status}` };
    }

    const html = await response.text();
    console.log('📄 Received HTML response, length:', html.length, 'characters');
    
    // Check for session expired - if the response is small and contains session error, return special error
    if (html.length < 6000 && (html.includes('Diese Sitzung ist nicht mehr gültig') || html.includes('session is no longer valid'))) {
      console.log('⚠️ Session expired - response is too small, need to reinitialize');
      return { available: false, error: 'Session expired' };
    }
    
    if (html.includes('Fehler') && html.length < 1000) {
      console.error('❌ Got error page from HFF');
      console.log('📄 Error HTML:', html);
      return { available: false, error: 'HFF returned error page' };
    }
    
    // Parse the search results
    console.log('🔍 Parsing search results...');
    const result = parseSearchResults(html, title);
    
    // Cache the result
    const cacheKey = `${title.toLowerCase()}_${year || 'no-year'}`;
    searchCache.set(cacheKey, result);
    
    console.log('📋 Final result for', title, ':', JSON.stringify(result));
    return result;
  } catch (error) {
    console.error('❌ Fetch error:', error.message);
    console.error('❌ Error stack:', error.stack);
    return { available: false, error: error.message };
  }
}

/**
 * Parse search results from HTML response using regex (service workers don't have DOM access)
 * @param {string} html - HTML content from search
 * @param {string} searchTitle - Original search title
 * @returns {Object} - Parsed result object
 */
function parseSearchResults(html, searchTitle) {
  try {
    console.log(`🔍 Parsing results for: "${searchTitle}"`);
    console.log(`📄 HTML response length: ${html.length} chars`);
    
    const searchTitleLower = searchTitle.toLowerCase();
    
    // Check if we got any results at all (look for result count)
    const resultCountMatch = html.match(/lokale Datenbank\s*\((\d+)\)/i);
    if (resultCountMatch) {
      console.log(`📊 Found ${resultCountMatch[1]} results in database`);
    } else {
      console.log('⚠️ Could not find result count - might be no results or different format');
    }
    
    // Multiple patterns to try for finding title links
    const patterns = [
      // Pattern 1: Links with title="zur Vollanzeige" (original pattern)
      /<a[^>]*title="zur Vollanzeige"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi,
      // Pattern 2: Links with href containing singleHit.do (detail page links)
      /<a[^>]*href="([^"]*singleHit\.do[^"]*)"[^>]*>([^<]+)<\/a>/gi,
      // Pattern 3: Links with class containing "title" or inside title divs
      /<a[^>]*href="([^"]*showHit[^"]*)"[^>]*>([^<]+)<\/a>/gi,
      // Pattern 4: Any links within result table rows
      /<td[^>]*class="[^"]*resultTitle[^"]*"[^>]*>.*?<a[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi,
    ];
    
    let allMatches = [];
    
    for (let i = 0; i < patterns.length; i++) {
      const matches = [...html.matchAll(patterns[i])];
      if (matches.length > 0) {
        console.log(`📋 Pattern ${i + 1} found ${matches.length} links`);
        allMatches = allMatches.concat(matches.map(m => ({ href: m[1], text: m[2].trim() })));
      }
    }
    
    // Deduplicate matches by text
    const seenTexts = new Set();
    allMatches = allMatches.filter(m => {
      if (seenTexts.has(m.text.toLowerCase())) return false;
      seenTexts.add(m.text.toLowerCase());
      return true;
    });
    
    console.log(`📋 Total unique links found: ${allMatches.length}`);
    if (allMatches.length > 0) {
      console.log('📋 First 5 matches:', allMatches.slice(0, 5).map(m => m.text));
    }
    
    // Filter to only DVD and Blu-Ray results
    // The HFF results show media type info in HTML - look for DVD-Video, DVD, Blu-Ray
    console.log(`📀 Starting DVD/Blu-ray filter on ${allMatches.length} results...`);
    const beforeDvdFilter = allMatches.length;
    const dvdFilteredMatches = allMatches.filter(match => {
      const hrefIndex = html.indexOf(match.href);
      if (hrefIndex === -1) return false;
      
      // Look at HTML around this result (search backwards more to catch media type)
      const startPos = Math.max(0, hrefIndex - 1500);
      const endPos = Math.min(html.length, hrefIndex + 500);
      const nearbyHtml = html.substring(startPos, endPos);
      
      // Check for DVD or Blu-Ray in various formats
      // Can appear as: DVD-Video, DVD, Blu-Ray, Blu-ray, alt="DVD"
      const isDvdOrBluray = /(?:DVD(?:-Video)?|Blu-?[Rr]ay)/i.test(nearbyHtml);
      
      if (!isDvdOrBluray) {
        console.log(`📀 Filtering out: "${match.text}" (not DVD/Blu-ray)`);
      }
      return isDvdOrBluray;
    });
    
    // Fallback: if filter removed everything but there were results, keep original
    if (dvdFilteredMatches.length === 0 && beforeDvdFilter > 0) {
      console.log(`⚠️ DVD filter removed all ${beforeDvdFilter} results - using originals as fallback`);
      // DON'T use fallback - we ONLY want DVD/Blu-ray results
      // Just log and continue with empty results
      allMatches = [];
      console.log(`📀 No DVD/Blu-ray found, returning no results`);
    } else {
      allMatches = dvdFilteredMatches;
      console.log(`📀 After DVD/Blu-ray filter: ${allMatches.length} of ${beforeDvdFilter} results`);
    }
    
    // Calculate similarity score between two titles
    const calculateTitleSimilarity = (title1, title2) => {
      const t1 = title1.toLowerCase().trim();
      const t2 = title2.toLowerCase().trim();
      
      // Exact match
      if (t1 === t2) return 100;
      
      // Remove punctuation but keep accented chars, normalize spaces
      const normalize = (s) => s.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const n1 = normalize(t1);
      const n2 = normalize(t2);
      
      if (n1 === n2) return 95;
      
      // Get all words (filter out very short ones like "a", "o", "le", etc.)
      const getWords = (s) => s.split(' ').filter(w => w.length > 2);
      const searchWords = getWords(n1);
      const resultWords = getWords(n2);
      
      // For SINGLE WORD searches, be VERY strict
      if (searchWords.length === 1) {
        const searchWord = searchWords[0];
        
        // Result must ALSO be a single significant word, or search word must be at the BEGINNING
        if (resultWords.length === 1 && resultWords[0] === searchWord) {
          return 90; // Both are single words that match exactly
        }
        
        // Check if result starts with exactly the search term (as a standalone title)
        // "Lucky" should match "Lucky (2017)" but NOT "Lucky Luke" or "O Lucky Man"
        const resultStartsWithSearch = n2 === n1 || 
                                        n2.startsWith(n1 + ' ') ||
                                        n2.match(new RegExp(`^${n1}\\s*[\\(\\[\\d]`)); // Lucky (2017) or Lucky 2017
        
        if (resultStartsWithSearch) {
          // But also check the result isn't much longer (different film with same first word)
          if (resultWords.length <= 2) {
            return 80; // Short result starting with search word
          }
          // If there are many more words, it's probably a different film
          console.log(`📊 Rejecting: "${t1}" vs "${t2}" - single word search but result has ${resultWords.length} significant words`);
          return 25;
        }
        
        // If search word appears elsewhere (not at start), it's probably not the right film
        // e.g., "Lucky" should NOT match "O Lucky Man!" or "Get Lucky"
        if (resultWords.includes(searchWord)) {
          console.log(`📊 Rejecting: "${t1}" found within "${t2}" but not at start`);
          return 20; // Word found but not at beginning - different film
        }
        
        return 10; // Single word not found properly
      }
      
      // For TWO WORD searches, still be fairly strict
      if (searchWords.length === 2) {
        // Both words must appear at the beginning of the result
        if (resultWords.length >= 2 && 
            resultWords[0] === searchWords[0] && 
            resultWords[1] === searchWords[1]) {
          if (resultWords.length <= 3) {
            return 85;
          }
          return 75; // First two words match exactly - good match even with subtitle
        }
        
        // Check if all search words are in result
        const commonWords = searchWords.filter(w => resultWords.includes(w));
        if (commonWords.length === 2) {
          if (resultWords.length <= 3) return 75;
          return 50; // Both words found but result is much longer
        }
        
        return 15;
      }
      
      // For LONGER titles (3+ words), use word overlap
      const commonWords = searchWords.filter(w => resultWords.includes(w));
      const overlapRatio = commonWords.length / Math.max(searchWords.length, resultWords.length);
      const coverageRatio = commonWords.length / searchWords.length; // How much of search is covered
      
      // Check if words appear in the same order at the start
      let matchingPrefix = 0;
      for (let i = 0; i < Math.min(searchWords.length, resultWords.length); i++) {
        if (searchWords[i] === resultWords[i]) {
          matchingPrefix++;
        } else {
          break;
        }
      }
      
      // Bonus for matching prefix
      const prefixBonus = (matchingPrefix / searchWords.length) * 20;
      
      // Most of the search words should be in the result
      if (coverageRatio >= 0.8 && overlapRatio >= 0.5) return Math.min(95, 85 + prefixBonus);
      if (coverageRatio >= 0.6 && overlapRatio >= 0.4) return Math.min(85, 70 + prefixBonus);
      if (coverageRatio >= 0.5) return 50 + prefixBonus / 2;
      
      return overlapRatio * 40;
    };
    
    // Find best matching result
    let bestMatch = null;
    let bestScore = 0;
    const MATCH_THRESHOLD = 70; // Require at least 70% similarity
    
    for (const match of allMatches) {
      const score = calculateTitleSimilarity(searchTitle, match.text);
      console.log(`📊 Similarity "${searchTitle}" vs "${match.text}": ${score}%`);
      
      if (score > bestScore && score >= MATCH_THRESHOLD) {
        bestScore = score;
        bestMatch = match;
      }
    }
    
    if (bestMatch) {
      console.log(`✅ Best matching title: "${bestMatch.text}" (${bestScore}% match)`);
      
      // Check availability in the full HTML
      const isAvailable = html.includes('ausleihbar') || 
                         html.includes('verfügbar') ||
                         html.includes('available');
      
      console.log(`📊 Availability check: ${isAvailable ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
      
      // Use the start.do URL with Query parameter
      const searchLink = `https://webopac.hff-muc.de/webOPACClient.hffsis/start.do?Branch=00&Query=-1=%22${encodeURIComponent(bestMatch.text)}%22`;
      
      return {
        available: isAvailable,
        link: searchLink,
        title: bestMatch.text,
        matchScore: bestScore
      };
    }
    
    // No good match found
    if (allMatches.length > 0) {
      console.log('⚠️ Found results but no title matched well enough');
      return {
        available: false,
        note: 'Found results but titles did not match closely enough'
      };
    }
    
    console.log('❌ No results found');
    return { available: false };
  } catch (error) {
    console.error('❌ Error parsing search results:', error);
    return { available: false, error: error.message };
  }
}

/**
 * Clear expired cache entries
 */
function cleanupCache() {
  const now = Date.now();
  for (const [key, value] of searchCache.entries()) {
    if (value.timestamp && (now - value.timestamp) > 3600000) { // 1 hour
      searchCache.delete(key);
    }
  }
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_AVAILABILITY') {
    searchFilm(message.title, message.year)
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        console.error('Error in message handler:', error);
        sendResponse({ available: false, error: error.message });
      });
    
    return true; // Indicates async response
  }
  
  // Forward other message types to content script
  if (message.type === 'START_SCAN' || message.type === 'STOP_SCAN' || message.type === 'GET_STATUS') {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message, sendResponse);
      }
    });
    return true; // Indicates async response
  }
});

// Periodic cleanup
setInterval(cleanupCache, 300000); // Every 5 minutes

// Log when extension starts
chrome.runtime.onInstalled.addListener(() => {
  console.log('✅ HFF Library Availability extension installed');
}); 