// Content script for HFF Library Availability Extension

class HFFAvailabilityChecker {
  constructor() {
    this.processedElements = new Set();
    this.pendingChecks = new Map();
    this.observer = null;
    this.isInitialized = false;
    this.isScanning = false;
    
    this.init();
  }

  init() {
    // Wait for page to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setupMessageListener());
    } else {
      this.setupMessageListener();
    }
  }

  setupMessageListener() {
    // Listen for messages from the popup or background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'START_SCAN') {
        this.startScan();
        sendResponse({ success: true });
      } else if (message.type === 'STOP_SCAN') {
        this.stopScan();
        sendResponse({ success: true });
      } else if (message.type === 'GET_STATUS') {
        sendResponse({ 
          isScanning: this.isScanning, 
          processedCount: this.processedElements.size 
        });
      }
    });
  }

  startScan() {
    if (this.isScanning) return;
    
    console.log('HFF Availability Checker starting scan...');
    this.isScanning = true;
    this.isInitialized = true;
    
    // Clear previous results
    this.clearPreviousResults();
    
    // Process existing film elements
    this.processVisibleFilms();
    
    // Set up observer for dynamic content
    this.setupObserver();
    
    // Handle scroll events for lazy loading
    this.setupScrollHandler();
  }

  stopScan() {
    if (!this.isScanning) return;
    
    console.log('HFF Availability Checker stopping scan...');
    this.isScanning = false;
    
    // Stop the observer
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    
    // Remove scroll handlers
    this.removeScrollHandlers();
  }

  clearPreviousResults() {
    // Remove all existing indicators
    document.querySelectorAll('.hff-loading-indicator, .hff-availability-indicator').forEach(el => el.remove());
    this.processedElements.clear();
    this.pendingChecks.clear();
  }

  /**
   * Find and process all visible film elements
   */
  processVisibleFilms() {
    if (!this.isScanning) return;
    
    // Check if we're on a single film page
    const isSingleFilmPage = this.isSingleFilmPage();
    
    if (isSingleFilmPage) {
      console.log('🎬 Single film page detected, only scanning main film');
      this.processSingleFilmPage();
      return;
    }
    
    // Regular processing for lists, watchlists, etc.
    const filmSelectors = [
      '.film-poster',
      '.poster',
      '[data-target-link*="/film/"]',
      '.poster-container'
    ];

    let totalFound = 0;
    let newElements = 0;

    for (const selector of filmSelectors) {
      const elements = document.querySelectorAll(selector);
      totalFound += elements.length;
      
      elements.forEach(element => {
        if (!this.processedElements.has(element)) {
          this.processFilmElement(element);
          newElements++;
        }
      });
    }

    if (newElements > 0) {
      console.log(`🎬 Found ${totalFound} total film elements, processing ${newElements} new ones`);
      console.log(`📊 Total processed so far: ${this.processedElements.size}`);
    }
  }

  /**
   * Check if we're on a single film page
   */
  isSingleFilmPage() {
    // Check URL pattern for single film pages
    const url = window.location.href;
    const singleFilmPattern = /\/film\/[^\/]+\/\d{4}\/?$/;
    
    if (singleFilmPattern.test(url)) {
      return true;
    }
    
    // Also check for the main film poster/header
    const mainFilmHeader = document.querySelector('.film-header, .film-poster-container, .poster-container');
    if (mainFilmHeader) {
      return true;
    }
    
    return false;
  }

  /**
   * Process a single film page
   */
  processSingleFilmPage() {
    // Look for the main film title in the page header
    const titleSelectors = [
      'h1.film-title',
      '.film-header h1',
      '.film-poster-container h1',
      'h1'
    ];
    
    let filmTitle = null;
    let filmYear = null;
    
    // Try to get the film title from the page
    for (const selector of titleSelectors) {
      const titleElement = document.querySelector(selector);
      if (titleElement) {
        const titleText = titleElement.textContent.trim();
        if (titleText && titleText.length > 0) {
          filmTitle = titleText;
          break;
        }
      }
    }
    
    // Try to get the year from the URL or page
    const urlMatch = window.location.href.match(/\/film\/[^\/]+\/(\d{4})/);
    if (urlMatch) {
      filmYear = urlMatch[1];
    }
    
    if (filmTitle) {
      console.log(`🎬 Single film page: "${filmTitle}" ${filmYear ? `(${filmYear})` : ''}`);
      
      // Create a virtual element for processing
      const virtualElement = {
        dataset: { filmTitle, filmYear },
        textContent: filmTitle
      };
      
      this.processFilmElement(virtualElement);
    } else {
      console.log('❌ Could not find film title on single film page');
    }
  }

  /**
   * Process a single film element
   * @param {Element} element - The film element to process
   */
  processFilmElement(element) {
    try {
      // Extract film information
      const filmInfo = this.extractFilmInfo(element);
      if (!filmInfo || !filmInfo.title) {
        return;
      }

      // Mark as processed
      this.processedElements.add(element);
      
      // Check if we already have a result for this film
      const cacheKey = this.createCacheKey(filmInfo.title, filmInfo.year);
      if (this.pendingChecks.has(cacheKey)) {
        return;
      }

      // Add loading indicator
      this.addLoadingIndicator(element);
      
      // Check availability
      this.checkAvailability(filmInfo, element);

    } catch (error) {
      console.error('Error processing film element:', error);
    }
  }

  /**
   * Extract film title and year from element
   * @param {Element} element - The film element
   * @returns {Object|null} - Film info object
   */
  extractFilmInfo(element) {
    try {
      // Handle virtual element for single film pages
      if (element.dataset && element.dataset.filmTitle) {
        return {
          title: element.dataset.filmTitle,
          year: element.dataset.filmYear || null
        };
      }
      
      // Look for the film title in various possible locations
      let titleElement = element.querySelector('.image, img');
      if (!titleElement) {
        titleElement = element.querySelector('[data-target-link]');
      }
      
      if (!titleElement) {
        return null;
      }

      // Get the title from alt text or data attribute
      let title = titleElement.getAttribute('alt') || 
                  titleElement.getAttribute('title') || 
                  titleElement.getAttribute('data-target-link');

      if (!title) {
        return null;
      }

      // Clean up the title (remove common prefixes/suffixes from Letterboxd)
      title = title
        .replace(/^Poster for\s+/i, '')      // Remove "Poster for " prefix
        .replace(/\s*\(Film\)\s*$/i, '')     // Remove "(Film)" suffix
        .replace(/\s*\(\d{4}\)\s*$/, '')     // Remove year in parentheses at end
        .trim();

      // Try to extract year from various sources
      let year = null;
      
      // Look for year in the film element or its children
      const yearMatch = element.textContent.match(/\((\d{4})\)/);
      if (yearMatch) {
        year = yearMatch[1];
      }

      // If no year found, try to get it from the URL or other attributes
      if (!year) {
        const linkElement = element.querySelector('a[href*="/film/"]') || element;
        if (linkElement) {
          const href = linkElement.getAttribute('href');
          if (href) {
            const yearMatch = href.match(/\/film\/[^\/]+\/(\d{4})\//);
            if (yearMatch) {
              year = yearMatch[1];
            }
          }
        }
      }

      return {
        title: title,
        year: year
      };
    } catch (error) {
      console.error('Error extracting film info:', error);
      return null;
    }
  }

  /**
   * Create a cache key for the film
   * @param {string} title - Film title
   * @param {string} year - Film year
   * @returns {string} - Cache key
   */
  createCacheKey(title, year) {
    const cleanTitle = title.toLowerCase().trim();
    return year ? `${cleanTitle}_${year}` : cleanTitle;
  }

  /**
   * Add a loading indicator to the film element
   * @param {Element} element - The film element
   */
  addLoadingIndicator(element) {
    // Handle virtual elements for single film pages
    if (element.dataset && element.dataset.filmTitle) {
      // For single film pages, add indicator to the page header
      const headerElement = document.querySelector('.film-header, .film-poster-container, h1');
      if (headerElement) {
        const indicator = document.createElement('div');
        indicator.className = 'hff-loading-indicator';
        indicator.innerHTML = '<div class="hff-spinner"></div>';
        
        headerElement.style.position = 'relative';
        headerElement.appendChild(indicator);
      }
      return;
    }
    
    const indicator = document.createElement('div');
    indicator.className = 'hff-loading-indicator';
    indicator.innerHTML = '<div class="hff-spinner"></div>';
    
    // Position the indicator
    element.style.position = 'relative';
    element.appendChild(indicator);
  }

  /**
   * Check availability for a film
   * @param {Object} filmInfo - Film information
   * @param {Element} element - The film element
   */
  async checkAvailability(filmInfo, element) {
    const cacheKey = this.createCacheKey(filmInfo.title, filmInfo.year);
    
    // Mark as pending
    this.pendingChecks.set(cacheKey, true);
    
    console.log(`🔍 Checking availability for: "${filmInfo.title}" ${filmInfo.year ? `(${filmInfo.year})` : ''}`);
    
    try {
      // Add timeout to prevent hanging (90 seconds to account for queue wait time)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), 90000); // 90 second timeout
      });

      const resultPromise = this.sendMessage({
        type: 'CHECK_AVAILABILITY',
        title: filmInfo.title,
        year: filmInfo.year
      });

      const result = await Promise.race([resultPromise, timeoutPromise]);

      console.log(`📋 Result for "${filmInfo.title}":`, result);

      // Remove loading indicator
      this.removeLoadingIndicator(element);
      
      // Add availability indicator
      if (result.available) {
        console.log(`✅ "${filmInfo.title}" is available at HFF!`);
        this.addAvailabilityIndicator(element, result);
      } else {
        console.log(`❌ "${filmInfo.title}" is not available at HFF`);
      }

    } catch (error) {
      console.error(`❌ Error checking availability for "${filmInfo.title}":`, error);
      this.removeLoadingIndicator(element);
    } finally {
      this.pendingChecks.delete(cacheKey);
    }
  }

  /**
   * Remove loading indicator from element
   * @param {Element} element - The film element
   */
  removeLoadingIndicator(element) {
    // Handle virtual elements for single film pages
    if (element.dataset && element.dataset.filmTitle) {
      // For single film pages, remove indicator from the page header
      const headerElement = document.querySelector('.film-header, .film-poster-container, h1');
      if (headerElement) {
        const indicator = headerElement.querySelector('.hff-loading-indicator');
        if (indicator) {
          indicator.remove();
        }
      }
      return;
    }
    
    const indicator = element.querySelector('.hff-loading-indicator');
    if (indicator) {
      indicator.remove();
    }
  }

  /**
   * Add availability indicator to element
   * @param {Element} element - The film element
   * @param {Object} result - Availability result
   */
  addAvailabilityIndicator(element, result) {
    // Handle virtual elements for single film pages
    if (element.dataset && element.dataset.filmTitle) {
      // For single film pages, add indicator to the page header
      const headerElement = document.querySelector('.film-header, .film-poster-container, h1');
      if (headerElement) {
        const indicator = document.createElement('div');
        indicator.className = 'hff-availability-indicator';
        indicator.title = 'Available at HFF Mediathek';
        
        if (result.link) {
          indicator.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(result.link, '_blank');
          });
          indicator.style.cursor = 'pointer';
        }
        
        headerElement.style.position = 'relative';
        headerElement.appendChild(indicator);
      }
      return;
    }
    
    const indicator = document.createElement('div');
    indicator.className = 'hff-availability-indicator';
    indicator.title = 'Available at HFF Mediathek';
    
    if (result.link) {
      indicator.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(result.link, '_blank');
      });
      indicator.style.cursor = 'pointer';
    }
    
    // Position the indicator
    element.style.position = 'relative';
    element.appendChild(indicator);
  }

  /**
   * Send message to background script
   * @param {Object} message - Message to send
   * @returns {Promise} - Response promise
   */
  sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Set up mutation observer for dynamic content
   */
  setupObserver() {
    this.observer = new MutationObserver((mutations) => {
      if (!this.isScanning) return;
      
      let shouldProcess = false;
      
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if this is a film element or contains film elements
              if (node.matches('.film-poster, .poster, [data-target-link*="/film/"]') ||
                  node.querySelector('.film-poster, .poster, [data-target-link*="/film/"]')) {
                shouldProcess = true;
              }
            }
          });
        }
      });
      
      if (shouldProcess) {
        // Debounce the processing to avoid excessive calls
        clearTimeout(this.processTimeout);
        this.processTimeout = setTimeout(() => {
          this.processVisibleFilms();
        }, 100);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Set up scroll handler for lazy loading
   */
  setupScrollHandler() {
    this.debouncedProcess = this.debounce(() => {
      if (this.isScanning) {
        this.processVisibleFilms();
      }
    }, 200);

    window.addEventListener('scroll', this.debouncedProcess);
    window.addEventListener('resize', this.debouncedProcess);
  }

  /**
   * Remove scroll handlers
   */
  removeScrollHandlers() {
    if (this.debouncedProcess) {
      window.removeEventListener('scroll', this.debouncedProcess);
      window.removeEventListener('resize', this.debouncedProcess);
      this.debouncedProcess = null;
    }
  }

  /**
   * Debounce function
   * @param {Function} func - Function to debounce
   * @param {number} wait - Wait time in milliseconds
   * @returns {Function} - Debounced function
   */
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}

// Initialize the checker when the script loads
const hffChecker = new HFFAvailabilityChecker(); 