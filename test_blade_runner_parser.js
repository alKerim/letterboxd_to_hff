const fs = require('fs');

// Mock browser environment for Node.js
global.DOMParser = class DOMParser {
  parseFromString(html, mimeType) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html);
    return dom.window.document;
  }
};

global.URL = require('url').URL;

// Import our parsing function
function parseSearchResults(html, searchTitle) {
  try {
    console.log(`🔍 Parsing results for: "${searchTitle}"`);
    
    // Create a temporary DOM element to parse the HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    const searchTitleLower = searchTitle.toLowerCase();
    
    // Look for film title links with the pattern we discovered
    const titleLinks = doc.querySelectorAll('a[title="zur Vollanzeige"]');
    console.log(`📋 Found ${titleLinks.length} title links in response`);
    
    for (const link of titleLinks) {
      const linkText = link.textContent.trim();
      const linkTextLower = linkText.toLowerCase();
      
      console.log(`🔍 Checking link: "${linkText}"`);
      
      // Check if this result contains our search title
      if (linkTextLower.includes(searchTitleLower)) {
        console.log(`✅ Found matching title: "${linkText}"`);
        
        // Check if the item is available (look for availability text)
        const parentElement = link.parentElement || link;
        const availabilityText = parentElement ? parentElement.textContent : '';
        
        const isAvailable = availabilityText.includes('ausleihbar') || 
                           availabilityText.includes('verfügbar') ||
                           availabilityText.includes('available');
        
        console.log(`📊 Availability check: ${isAvailable ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
        console.log(`📄 Parent text: "${availabilityText.substring(0, 200)}..."`);
        
        if (isAvailable) {
          console.log('✅ Found availability text in response');
        }
        
        // Get the detail link
        const detailLink = new URL(link.href, 'https://webopac.hff-muc.de').href;
        
        return {
          available: isAvailable,
          link: detailLink,
          title: linkText
        };
      }
    }
    
    // If no exact match found, check if there are any results at all
    const hasResults = html.includes('lokale Datenbank') && 
                      (html.includes('ausleihbar') || html.includes('verfügbar'));
    
    if (hasResults) {
      console.log('⚠️ Found some results but no exact match');
      // Found some results but not an exact match
      return {
        available: false,
        note: 'Found similar results but no exact match'
      };
    }
    
    // Debug: Let's see what we actually got
    console.log('🔍 Debug: Checking if search title appears in response');
    if (html.toLowerCase().includes(searchTitleLower)) {
      console.log('✅ Search title found in response but no matching link');
      // Try a broader search for availability
      const isAvailable = html.includes('ausleihbar') || html.includes('verfügbar');
      console.log(`📊 Broader availability check: ${isAvailable ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
      
      if (isAvailable) {
        return {
          available: true,
          title: searchTitle,
          note: 'Found via broader search'
        };
      }
    }
    
    console.log('❌ No results found');
    return { available: false };
  } catch (error) {
    console.error('❌ Error parsing search results:', error);
    return { available: false };
  }
}

// Session management
let sessionCookies = null;
let sessionId = null;

async function initializeSession() {
  try {
    console.log('🔄 Initializing WebOPAC session...');
    const response = await fetch('https://webopac.hff-muc.de/webOPACClient.hffsis/start.do?Login=wohff', {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    console.log('📡 Session initialization response status:', response.status);

    if (response.ok) {
      const setCookieHeader = response.headers.get('set-cookie');
      console.log('🍪 Set-Cookie header:', setCookieHeader);
      
      if (setCookieHeader) {
        const cookies = setCookieHeader.split(',').map(cookie => {
          const match = cookie.trim().match(/^([^=]+)=([^;]+)/);
          return match ? `${match[1]}=${match[2]}` : cookie.trim();
        }).join('; ');
        
        // Extract session ID from cookies
        const sessionMatch = cookies.match(/JSESSIONID=([^;]+)/);
        if (sessionMatch) {
          sessionId = sessionMatch[1];
        }
        
        sessionCookies = cookies;
        console.log('✅ Session initialized successfully');
        console.log('🍪 Formatted cookies:', sessionCookies);
        console.log('🆔 Session ID:', sessionId);
        return true;
      } else {
        console.log('⚠️ No Set-Cookie header found');
        return false;
      }
    } else {
      console.error('❌ Session initialization failed with status:', response.status);
      return false;
    }
  } catch (error) {
    console.error('❌ Error initializing session:', error);
    return false;
  }
}

async function searchWithSession(searchString) {
  const encodedSearch = encodeURIComponent(searchString.trim());
  
  // Build search URL with session ID and media type filter
  let searchUrl = `https://webopac.hff-muc.de/webOPACClient.hffsis/search.do?methodToCall=submit&methodToCallParameter=submitSearch&searchCategories%5B0%5D=-1&searchString%5B0%5D=${encodedSearch}`;
  
  // Add session ID if we have it
  if (sessionId) {
    searchUrl += `&CSId=${sessionId}`;
  }
  
  // Add media type filter for DVD/Blu-ray
  searchUrl += `&callingPage=searchParameters&searchRestrictionID%5B0%5D=5&searchRestrictionValue1%5B0%5D=9`;
  
  console.log('🔍 Search URL with filters:', searchUrl);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://webopac.hff-muc.de/webOPACClient.hffsis/start.do?Login=wohff'
  };

  if (sessionCookies) {
    headers['Cookie'] = sessionCookies;
    console.log('🍪 Using session cookies');
  }

  const response = await fetch(searchUrl, {
    method: 'GET',
    headers: headers
  });

  console.log('📡 Search response status:', response.status);

  if (!response.ok) {
    console.error('❌ Search request failed:', response.status);
    return null;
  }

  const html = await response.text();
  console.log('📄 Received HTML response, length:', html.length, 'characters');
  
  // Check for session expiration
  if (html.includes('Diese Sitzung ist nicht mehr gültig')) {
    console.log('🔄 Session expired detected in response');
    return null;
  }
  
  return html;
}

// Test with a sample HTML response
async function testParser() {
  console.log('🧪 Testing Blade Runner parser with session...\n');
  
  // First, establish a session
  const sessionEstablished = await initializeSession();
  if (!sessionEstablished) {
    console.log('❌ Failed to establish session, testing with mock response...');
    
    // Fallback: test with a mock response
    const mockHtml = `
      <html>
        <body>
          <div>
            <a href="/detail.do?methodToCall=showDetail&CSId=123&id=456" title="zur Vollanzeige">
              Blade Runner Scott, Ridley, 1937- [Regisseur] ; Ford, Harrison, 1942- [Schauspieler]
            </a>
            <span>Ein oder mehrere Exemplare dieses Titels sind in der aktuellen Zweigstelle ausleihbar.</span>
          </div>
        </body>
      </html>
    `;
    
    const result = parseSearchResults(mockHtml, 'Blade Runner');
    console.log('📋 Mock Parser Result:', result);
    return;
  }
  
  // Now search with the established session
  const html = await searchWithSession('blade runner');
  
  if (html) {
    // Save the response for inspection
    fs.writeFileSync('blade_runner_response_with_session.html', html);
    console.log('💾 Saved response to blade_runner_response_with_session.html');
    
    // Test our parser
    const result = parseSearchResults(html, 'Blade Runner');
    console.log('\n📋 Parser Result:', result);
    
    if (result.available) {
      console.log('✅ SUCCESS: Blade Runner correctly identified as AVAILABLE!');
    } else {
      console.log('❌ FAILED: Blade Runner incorrectly identified as NOT AVAILABLE');
      console.log('🔍 Let\'s inspect the HTML to see what we missed...');
      
      // Look for availability text in the HTML
      const hasAusleihbar = html.includes('ausleihbar');
      const hasVerfugbar = html.includes('verfügbar');
      const hasBladeRunner = html.toLowerCase().includes('blade runner');
      
      console.log(`📊 HTML Analysis:`);
      console.log(`   - Contains "ausleihbar": ${hasAusleihbar}`);
      console.log(`   - Contains "verfügbar": ${hasVerfugbar}`);
      console.log(`   - Contains "blade runner": ${hasBladeRunner}`);
      
      // Extract a sample of the HTML around "blade runner"
      const bladeRunnerIndex = html.toLowerCase().indexOf('blade runner');
      if (bladeRunnerIndex !== -1) {
        const sample = html.substring(Math.max(0, bladeRunnerIndex - 100), bladeRunnerIndex + 200);
        console.log(`📄 Sample HTML around "blade runner":`);
        console.log(sample);
      }
    }
  } else {
    console.log('❌ Failed to get search response with session');
  }
}

// Run the test
testParser().catch(console.error); 