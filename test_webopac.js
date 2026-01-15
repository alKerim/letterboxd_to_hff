#!/usr/bin/env node

// Test script for HFF WebOPAC integration
// This script manually tests the search functionality

const https = require('https');
const { URL } = require('url');

class WebOPACTester {
  constructor() {
    this.sessionCookies = null;
    this.sessionExpiry = null;
    this.SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Make an HTTPS request with custom options
   */
  makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      
      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          ...options.headers
        }
      };

      if (this.sessionCookies) {
        requestOptions.headers['Cookie'] = this.sessionCookies;
      }

      console.log(`Making ${requestOptions.method} request to: ${url}`);
      console.log('Headers:', requestOptions.headers);

      const req = https.request(requestOptions, (res) => {
        console.log(`Response status: ${res.statusCode}`);
        console.log('Response headers:', res.headers);

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          // Extract cookies from response
          const setCookieHeader = res.headers['set-cookie'];
          if (setCookieHeader) {
            console.log('Set-Cookie header:', setCookieHeader);
            this.sessionCookies = setCookieHeader;
            this.sessionExpiry = Date.now() + this.SESSION_TIMEOUT;
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: data
          });
        });
      });

      req.on('error', (error) => {
        console.error('Request error:', error);
        reject(error);
      });

      req.end();
    });
  }

  /**
   * Initialize a session with WebOPAC
   */
  async initializeSession() {
    try {
      console.log('\n=== Initializing WebOPAC Session ===');
      
      const response = await this.makeRequest(
        'https://webopac.hff-muc.de/webOPACClient.hffsis/start.do?Login=wohff'
      );

      console.log(`Session initialization status: ${response.statusCode}`);
      
      if (response.statusCode === 200) {
        console.log('✅ Session initialized successfully');
        console.log('Session cookies:', this.sessionCookies);
        return true;
      } else {
        console.log('❌ Failed to initialize session');
        return false;
      }
    } catch (error) {
      console.error('❌ Error initializing session:', error.message);
      return false;
    }
  }

  /**
   * Search for a film
   */
  async searchFilm(title, year = null) {
    try {
      console.log(`\n=== Searching for: "${title}" ${year ? `(${year})` : ''} ===`);
      
      if (!this.sessionCookies) {
        console.log('No session cookies found, initializing session...');
        const sessionEstablished = await this.initializeSession();
        if (!sessionEstablished) {
          throw new Error('Failed to establish session');
        }
      }

      // Prepare search parameters
      const searchString = year ? `${title} ${year}` : title;
      const encodedSearch = encodeURIComponent(searchString.trim());
      
      const searchUrl = `https://webopac.hff-muc.de/webOPACClient.hffsis/search.do?methodToCall=submit&methodToCallParameter=submitSearch&searchCategories%5B0%5D=-1&searchString%5B0%5D=${encodedSearch}`;

      console.log('Search URL:', searchUrl);
      console.log('Search string:', searchString);

      const response = await this.makeRequest(searchUrl);

      console.log(`Search response status: ${response.statusCode}`);
      
      if (response.statusCode === 200) {
        console.log('✅ Search request successful');
        console.log('Response length:', response.data.length, 'characters');
        
        // Parse the response
        this.parseSearchResults(response.data, title);
      } else {
        console.log('❌ Search request failed');
        console.log('Response data:', response.data.substring(0, 500));
      }

    } catch (error) {
      console.error('❌ Error searching for film:', error.message);
    }
  }

  /**
   * Parse search results from HTML
   */
  parseSearchResults(html, searchTitle) {
    try {
      console.log('\n=== Parsing Search Results ===');
      
      // Look for common patterns in the HTML
      const searchTitleLower = searchTitle.toLowerCase();
      
      // Check if the search title appears in the response
      if (html.toLowerCase().includes(searchTitleLower)) {
        console.log('✅ Found search title in response');
      } else {
        console.log('❌ Search title not found in response');
      }

      // Look for result indicators
      const resultPatterns = [
        /class="result"/gi,
        /class="hit"/gi,
        /class="searchResult"/gi,
        /<table[^>]*>/gi,
        /<tr[^>]*>/gi
      ];

      console.log('\nSearching for result patterns:');
      resultPatterns.forEach(pattern => {
        const matches = html.match(pattern);
        if (matches) {
          console.log(`Found ${matches.length} matches for pattern: ${pattern}`);
        }
      });

      // Look for links to detail pages
      const detailLinks = html.match(/href="[^"]*detail\.do[^"]*"/gi) || [];
      const showLinks = html.match(/href="[^"]*show\.do[^"]*"/gi) || [];
      
      console.log(`\nFound ${detailLinks.length} detail links`);
      console.log(`Found ${showLinks.length} show links`);

      // Extract some sample text around the search term
      const searchIndex = html.toLowerCase().indexOf(searchTitleLower);
      if (searchIndex !== -1) {
        const start = Math.max(0, searchIndex - 200);
        const end = Math.min(html.length, searchIndex + searchTitle.length + 200);
        const sampleText = html.substring(start, end);
        console.log('\nSample text around search term:');
        console.log('...' + sampleText + '...');
      }

      // Save the full response to a file for inspection
      const fs = require('fs');
      fs.writeFileSync('webopac_response.html', html);
      console.log('\n📄 Full response saved to webopac_response.html');

    } catch (error) {
      console.error('❌ Error parsing search results:', error.message);
    }
  }

  /**
   * Run the test
   */
  async runTest() {
    console.log('🎬 HFF WebOPAC Integration Test');
    console.log('================================\n');

    // Test with "Paris Texas"
    await this.searchFilm('Paris Texas', '1984');
    
    // Test with just the title
    await this.searchFilm('Paris Texas');
    
    // Test with a different film
    await this.searchFilm('Blade Runner', '1982');
  }
}

// Run the test
const tester = new WebOPACTester();
tester.runTest().catch(console.error); 