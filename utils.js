// Utility functions for HFF Library Availability Extension

/**
 * Encode a string for use in URL parameters
 * @param {string} str - The string to encode
 * @returns {string} - URL encoded string
 */
function encodeForURL(str) {
  return encodeURIComponent(str.trim());
}

/**
 * Extract film title and year from Letterboxd film element
 * @param {Element} filmElement - The film tile element
 * @returns {Object|null} - Object with title and year, or null if not found
 */
function extractFilmInfo(filmElement) {
  try {
    // Look for the film title in various possible locations
    let titleElement = filmElement.querySelector('.film-poster .image, .poster .image');
    if (!titleElement) {
      titleElement = filmElement.querySelector('[data-target-link]');
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
    const yearMatch = filmElement.textContent.match(/\((\d{4})\)/);
    if (yearMatch) {
      year = yearMatch[1];
    }

    // If no year found, try to get it from the URL or other attributes
    if (!year) {
      const linkElement = filmElement.querySelector('a[href*="/film/"]');
      if (linkElement) {
        const href = linkElement.getAttribute('href');
        const yearMatch = href.match(/\/film\/[^\/]+\/(\d{4})\//);
        if (yearMatch) {
          year = yearMatch[1];
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
 * Create a unique key for caching film searches
 * @param {string} title - Film title
 * @param {string} year - Film year (optional)
 * @returns {string} - Cache key
 */
function createCacheKey(title, year) {
  const cleanTitle = title.toLowerCase().trim();
  return year ? `${cleanTitle}_${year}` : cleanTitle;
}

/**
 * Simple HTML parser to check if search results contain the film
 * @param {string} html - HTML content from WebOPAC search
 * @param {string} searchTitle - The title we're searching for
 * @returns {Object} - Object with availability status and link
 */
function parseSearchResults(html, searchTitle) {
  try {
    // Create a temporary DOM element to parse the HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    const searchTitleLower = searchTitle.toLowerCase();
    
    // Look for film title links with the pattern we discovered
    const titleLinks = doc.querySelectorAll('a[title="zur Vollanzeige"]');
    
    for (const link of titleLinks) {
      const linkText = link.textContent.trim();
      const linkTextLower = linkText.toLowerCase();
      
      // Check if this result contains our search title
      if (linkTextLower.includes(searchTitleLower)) {
        // Check if the item is available (look for availability text)
        const parentElement = link.parentElement || link;
        const availabilityText = parentElement ? parentElement.textContent : '';
        
        const isAvailable = availabilityText.includes('ausleihbar') || 
                           availabilityText.includes('verfügbar') ||
                           availabilityText.includes('available');
        
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
      // Found some results but not an exact match
      return {
        available: false,
        note: 'Found similar results but no exact match'
      };
    }
    
    return { available: false };
  } catch (error) {
    console.error('Error parsing search results:', error);
    return { available: false };
  }
}

/**
 * Debounce function to limit the rate of function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} - Debounced function
 */
function debounce(func, wait) {
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

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    encodeForURL,
    extractFilmInfo,
    createCacheKey,
    parseSearchResults,
    debounce
  };
} 