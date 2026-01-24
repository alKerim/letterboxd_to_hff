// Popup script for HFF Library Availability Extension

document.addEventListener('DOMContentLoaded', function() {
  const scanButton = document.getElementById('scan-button');
  const scanText = document.getElementById('scan-text');
  const scanSpinner = document.getElementById('scan-spinner');
  const statusText = document.getElementById('status-text');
  
  // Check if we're on a Letterboxd page
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    const currentTab = tabs[0];
    const isLetterboxd = currentTab.url && currentTab.url.includes('letterboxd.com');
    
    if (isLetterboxd) {
      statusText.textContent = 'Extension is ready. Click "Scan for HFF" to check film availability.';
      statusText.style.color = '#333';
      scanButton.disabled = false;
      
      // Check current scan status
      checkScanStatus();
    } else {
      statusText.textContent = 'Navigate to Letterboxd to use this extension.';
      statusText.style.color = '#666';
      scanButton.disabled = true;
    }
  });
  
  // Add click handler for the scan button
  scanButton.addEventListener('click', function() {
    if (scanButton.disabled) return;
    
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      const currentTab = tabs[0];
      
      if (scanText.textContent === 'Scan for HFF') {
        // Start scanning
        startScan(currentTab.id);
      } else {
        // Stop scanning
        stopScan(currentTab.id);
      }
    });
  });
  
  // Add click handler for the catalog link
  const catalogLink = document.querySelector('.link');
  catalogLink.addEventListener('click', function(e) {
    e.preventDefault();
    chrome.tabs.create({url: 'https://webopac.hff-muc.de'});
  });
  
  function startScan(tabId) {
    scanButton.disabled = true;
    scanText.textContent = 'Scanning...';
    scanSpinner.style.display = 'block';
    statusText.textContent = 'Scanning for HFF availability...';
    statusText.style.color = '#333';
    
    chrome.tabs.sendMessage(tabId, {type: 'START_SCAN'}, function(response) {
      if (chrome.runtime.lastError) {
        console.error('Error starting scan:', chrome.runtime.lastError);
        resetScanButton();
        statusText.textContent = 'Error: Could not start scan. Please refresh the page.';
        statusText.style.color = '#e74c3c';
      } else {
        scanButton.disabled = false;
        scanText.textContent = 'Stop Scan';
        scanSpinner.style.display = 'none';
      }
    });
  }
  
  function stopScan(tabId) {
    scanButton.disabled = true;
    scanText.textContent = 'Stopping...';
    scanSpinner.style.display = 'block';
    
    chrome.tabs.sendMessage(tabId, {type: 'STOP_SCAN'}, function(response) {
      if (chrome.runtime.lastError) {
        console.error('Error stopping scan:', chrome.runtime.lastError);
      }
      resetScanButton();
      statusText.textContent = 'Scan stopped. Click "Scan for HFF" to scan again.';
      statusText.style.color = '#666';
    });
  }
  
  function resetScanButton() {
    scanButton.disabled = false;
    scanText.textContent = 'Scan for HFF';
    scanSpinner.style.display = 'none';
  }
  
  function checkScanStatus() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      const currentTab = tabs[0];
      
      chrome.tabs.sendMessage(currentTab.id, {type: 'GET_STATUS'}, function(response) {
        if (!chrome.runtime.lastError && response && response.isScanning) {
          scanText.textContent = 'Stop Scan';
          scanSpinner.style.display = 'none';
          statusText.textContent = `Scanning... Found ${response.processedCount} films.`;
          statusText.style.color = '#333';
        }
      });
    });
  }
}); 