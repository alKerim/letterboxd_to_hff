# HFF Library Availability for Letterboxd

A Chrome Extension that shows which films on Letterboxd are available at the HFF Munich University of Television and Film library.

## Features

- **Manual Activation**: Click the extension icon and select "Scan for HFF" to start checking availability
- **Film Detection**: Detects all visible films on Letterboxd pages (watchlist, films, diary, etc.)
- **Real-time Availability**: Checks the HFF WebOPAC system for film availability
- **Visual Indicators**: Shows green dots on film tiles that are available at the library
- **Clickable Links**: Click on availability indicators to open the catalog entry
- **Smart Caching**: Caches search results to avoid redundant queries
- **Dynamic Content**: Works with infinite scroll and dynamically loaded content
- **Modern UI**: Minimal, clean design that matches Letterboxd's aesthetic

## Installation

### Manual Installation

1. **Download the Extension**
   - Clone or download this repository to your local machine

2. **Open Chrome Extensions**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right corner

3. **Load the Extension**
   - Click "Load unpacked" button
   - Select the folder containing the extension files
   - The extension should now appear in your extensions list

4. **Verify Installation**
   - Navigate to any Letterboxd page (e.g., https://letterboxd.com/films/)
   - Click the extension icon in the Chrome toolbar
   - Click "Scan for HFF" to start checking availability
   - You should see green dots appear on film tiles that are available at HFF

## How It Works

1. **Manual Activation**: Click the extension icon and select "Scan for HFF"
2. **Film Detection**: The extension scans Letterboxd pages for film tiles and extracts titles and years
3. **Availability Check**: For each film, it searches the HFF WebOPAC system
4. **Visual Feedback**: Available films get a green indicator dot
5. **Interactive**: Click the dot to open the catalog entry in a new tab

## File Structure

```
letterboxd_hff_chromeextension/
├── manifest.json          # Extension configuration
├── background.js          # Service worker for WebOPAC communication
├── content.js            # Content script injected into Letterboxd
├── utils.js              # Shared utility functions
├── styles.css            # Visual styling for indicators
├── popup.html            # Extension popup interface
├── popup.js              # Popup functionality
├── icons/                # Extension icons (placeholder)
└── README.md             # This file
```

## Permissions

The extension requires the following permissions:

- **tabs**: To detect when you're on Letterboxd pages
- **scripting**: To inject content scripts
- **storage**: To cache search results
- **activeTab**: To access the current tab
- **Host permissions**: 
  - `https://webopac.hff-muc.de/*` - To search the HFF library
  - `https://letterboxd.com/*` - To work on Letterboxd pages

## Technical Details

### Architecture
- **Manifest V3**: Uses the latest Chrome extension manifest version
- **Service Worker**: Background script handles WebOPAC session management
- **Content Script**: Injected into Letterboxd pages for film detection
- **MutationObserver**: Monitors for dynamically loaded content

### WebOPAC Integration
- Establishes sessions with the HFF WebOPAC system
- Performs search queries using the catalog's search interface
- Parses HTML responses to detect film availability
- Maintains session cookies for efficient queries

### Performance Features
- **Debounced Processing**: Limits API calls during rapid scrolling
- **Result Caching**: Stores search results to avoid duplicate queries
- **Session Management**: Reuses WebOPAC sessions when possible
- **Lazy Loading**: Only processes visible film elements

## Troubleshooting

### Extension Not Working
1. Ensure you're on a Letterboxd page (letterboxd.com)
2. Check that the extension is enabled in `chrome://extensions/`
3. Click the extension icon and then "Scan for HFF"
4. Wait a few seconds for indicators to appear
5. Check the browser console for any error messages

### No Availability Indicators
1. The extension only shows indicators for films that are actually available at HFF
2. Check that you have a stable internet connection
3. The HFF WebOPAC system might be temporarily unavailable

### Performance Issues
1. The extension caches results, so subsequent visits should be faster
2. If you experience slowdowns, try refreshing the page
3. The extension is designed to be lightweight and shouldn't impact page performance

## Development

### Local Development
1. Make changes to the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Test your changes on Letterboxd

### Debugging
- Open Chrome DevTools on a Letterboxd page
- Check the Console tab for extension logs
- Use the Network tab to monitor WebOPAC requests

## Privacy

- The extension only accesses Letterboxd pages and the HFF WebOPAC system
- No data is sent to third-party servers
- Search results are cached locally in your browser
- No personal information is collected or stored

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the browser console for error messages
3. Ensure you're using a supported Chrome version

## License

This extension is provided as-is for educational and personal use.

---

**Note**: This extension is not officially affiliated with HFF Munich or Letterboxd. It's an independent tool to help students and faculty check library availability more easily. # letterboxd_to_hff
