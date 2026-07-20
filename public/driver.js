// ── Driver Portal Application ──────────────────────────────────────────────

let driverId = null;
let driverName = null;
let driverPin = null;
let currentJobs = [];
let completedJobs = [];
let currentLocation = { lat: 1.3521, lng: 103.8198 }; // Singapore center default
let driverMap = null;
let mapMarkers = [];
let isOnline = navigator.onLine;
let selectedJobId = null;
let startTime = null;
let distanceTravelled = 0;

// ── Initialize Application ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  setupOfflineDetection();
  setInterval(updateTime, 60000); // Update time every minute
});

function initializeApp() {
  // Check if already logged in
  const sessionData = JSON.parse(sessionStorage.getItem('driverSession') || 'null');
  if (sessionData && sessionData.driverId) {
    driverId = sessionData.driverId;
    driverName = sessionData.driverName;
    driverPin = sessionData.pin;
    showDashboard();
  } else {
    setupPinLogin();
  }
}

// ── PIN Login System ──────────────────────────────────────────────────────
function setupPinLogin() {
  const pinInput = document.getElementById('pinInput');
  const pinKeypad = document.querySelectorAll('.pin-key');
  const pinSubmitBtn = document.getElementById('pinSubmitBtn');
  const pinError = document.getElementById('pinError');

  pinKeypad.forEach(key => {
    key.addEventListener('click', () => {
      if (key.classList.contains('clear')) {
        pinInput.value = '';
        pinError.textContent = '';
      } else if (key.classList.contains('delete')) {
        pinInput.value = pinInput.value.slice(0, -1);
      } else if (key.dataset.key) {
        if (pinInput.value.length < 4) {
          pinInput.value += key.dataset.key;
        }
      }
      updatePinSubmitBtn();
    });
  });

  pinInput.addEventListener('input', updatePinSubmitBtn);

  pinSubmitBtn.addEventListener('click', async () => {
    const pin = pinInput.value;
    if (pin.length !== 4) {
      pinError.textContent = 'Please enter a 4-digit PIN';
      return;
    }

    try {
      const response = await fetch('/api/driver/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });

      if (response.status === 200) {
        const data = await response.json();
        driverId = data.id;
        driverName = data.name;
        driverPin = pin;

        // Save session
        sessionStorage.setItem('driverSession', JSON.stringify({
          driverId, driverName, pin, loginTime: Date.now()
        }));

        showDashboard();
      } else {
        pinError.textContent = 'Invalid PIN. Try again.';
        pinInput.value = '';
        updatePinSubmitBtn();
      }
    } catch (error) {
      pinError.textContent = 'Login failed. Check connection.';
    }
  });

  function updatePinSubmitBtn() {
    pinSubmitBtn.disabled = pinInput.value.length !== 4;
  }
}

// ── Dashboard View ────────────────────────────────────────────────────────
function showDashboard() {
  document.getElementById('pinLoginOverlay').classList.add('hidden');
  document.getElementById('driverDashboard').classList.remove('hidden');

  updateHeader();
  loadDriverJobs();
  initializeMap();
  startGPSTracking();
  loadOfflineJobs();
}

function updateHeader() {
  document.getElementById('driverHeaderName').textContent = driverName || 'Driver';
  document.getElementById('driverHeaderTime').textContent = getCurrentTime();
  setInterval(() => {
    document.getElementById('driverHeaderTime').textContent = getCurrentTime();
  }, 60000);
}

function getCurrentTime() {
  const now = new Date();
  return now.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });
}

function updateTime() {
  document.getElementById('driverHeaderTime').textContent = getCurrentTime();
}

// ── Load Driver Jobs ──────────────────────────────────────────────────────
async function loadDriverJobs() {
  try {
    const response = await fetch(`/api/driver/jobs?driverId=${driverId}`, {
      headers: { 'x-driver-pin': driverPin }
    });

    if (response.status === 200) {
      const data = await response.json();
      currentJobs = data.pending || [];
      completedJobs = data.completed || [];

      // Save to localStorage for offline access
      localStorage.setItem(`driverJobs_${driverId}`, JSON.stringify({
        pending: currentJobs,
        completed: completedJobs,
        timestamp: Date.now()
      }));

      renderJobsList();
      updateStats();
      renderMapMarkers();
    }
  } catch (error) {
    console.error('Failed to load jobs:', error);
    loadOfflineJobs();
  }
}

function loadOfflineJobs() {
  const cached = localStorage.getItem(`driverJobs_${driverId}`);
  if (cached) {
    const data = JSON.parse(cached);
    currentJobs = data.pending || [];
    completedJobs = data.completed || [];
    renderJobsList();
    updateStats();
  }
}

function renderJobsList() {
  const jobsList = document.getElementById('jobsList');
  document.getElementById('jobsCount').textContent = currentJobs.length;

  if (currentJobs.length === 0) {
    jobsList.innerHTML = '<div style="padding: 2rem; text-align: center; color: #64748b; font-size: 13px;">No deliveries assigned for today</div>';
    return;
  }

  jobsList.innerHTML = currentJobs.map((job, idx) => `
    <div class="job-card" data-job-id="${job.id}" onclick="selectJob('${job.id}')">
      <div class="job-number">#${idx + 1} • ${job.id}</div>
      <div class="job-customer">${escapeHtml(job.customer)}</div>
      <div class="job-address">${escapeHtml(job.address)}</div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="job-distance">📍 ${calculateDistance(currentLocation, job.location).toFixed(1)} km away</div>
        <div class="job-status ${job.status || 'pending'}">${(job.status || 'Pending').toUpperCase()}</div>
      </div>
    </div>
  `).join('');

  // Add click handlers
  document.querySelectorAll('.job-card').forEach(card => {
    card.addEventListener('click', (e) => {
      const jobId = card.dataset.jobId;
      selectJob(jobId);
    });
  });
}

function selectJob(jobId) {
  selectedJobId = jobId;
  const job = currentJobs.find(j => j.id === jobId);
  if (!job) return;

  // Update active state
  document.querySelectorAll('.job-card').forEach(card => card.classList.remove('active'));
  document.querySelector(`[data-job-id="${jobId}"]`)?.classList.add('active');

  // Show job details
  showJobDetail(job);
}

function showJobDetail(job) {
  const modal = document.getElementById('jobDetailModal');

  document.getElementById('detailJobTitle').textContent = job.customer;
  document.getElementById('detailJobRef').textContent = `Ref: ${job.id}`;
  document.getElementById('detailCustomer').textContent = job.customer;
  document.getElementById('detailAddress').textContent = job.address;
  document.getElementById('detailPostal').textContent = job.postalCode || '—';
  document.getElementById('detailPhone').textContent = job.phone || '—';

  // Items
  const itemsList = document.getElementById('detailItemsList');
  if (job.items && job.items.length > 0) {
    itemsList.innerHTML = job.items.map(item => `
      <div class="detail-item">
        <span class="item-sku">${item.sku}</span> •
        <span class="item-qty">Qty: ${item.qty}</span>
        ${item.description ? ` • ${escapeHtml(item.description)}` : ''}
      </div>
    `).join('');
  } else {
    itemsList.innerHTML = '<div class="detail-item" style="color: #64748b;">No items specified</div>';
  }

  // Distance & ETA
  const dist = calculateDistance(currentLocation, job.location);
  const eta = Math.ceil(dist / 30); // Assume 30 km/h average speed
  document.getElementById('detailDistance').textContent = `${dist.toFixed(1)} km`;
  document.getElementById('detailETA').textContent = `${eta} min`;

  // Setup action buttons
  setupJobActions(job);

  modal.classList.remove('hidden');
}

function setupJobActions(job) {
  const startBtn = document.getElementById('startDeliveryBtn');
  const completeBtn = document.getElementById('markCompleteBtn');
  const failedBtn = document.getElementById('markFailedBtn');

  startBtn.onclick = () => startDelivery(job.id);
  completeBtn.onclick = () => completeDelivery(job.id, 'delivered');
  failedBtn.onclick = () => completeDelivery(job.id, 'failed');

  // Hide start button if already started
  if (job.status === 'in-progress') {
    startBtn.style.display = 'none';
  } else {
    startBtn.style.display = '';
  }
}

function startDelivery(jobId) {
  const job = currentJobs.find(j => j.id === jobId);
  if (!job) return;

  job.status = 'in-progress';
  startTime = Date.now();

  updateJobOffline(jobId, { status: 'in-progress' });
  document.getElementById('driverStatusBadge').textContent = 'On Delivery';
  document.getElementById('driverStatusBadge').style.background = '#dbeafe';
  document.getElementById('driverStatusBadge').style.color = '#075985';

  renderJobsList();
}

async function completeDelivery(jobId, status) {
  const job = currentJobs.find(j => j.id === jobId);
  if (!job) return;

  // Calculate time taken
  const timeTaken = startTime ? (Date.now() - startTime) / 1000 / 60 : 0; // in minutes

  const updateData = {
    status: status,
    completedAt: new Date().toISOString(),
    timeTaken,
    distanceTravelled,
    location: currentLocation
  };

  try {
    const response = await fetch(`/api/driver/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-driver-id': driverId,
        'x-driver-pin': driverPin
      },
      body: JSON.stringify(updateData)
    });

    if (response.status === 200) {
      // Move to completed
      currentJobs = currentJobs.filter(j => j.id !== jobId);
      completedJobs.push({ ...job, ...updateData });

      updateJobOffline(jobId, updateData);
      renderJobsList();
      updateStats();
      closeJobDetail();

      alert(`Delivery marked as ${status}!`);
    }
  } catch (error) {
    // Save offline
    updateJobOffline(jobId, updateData);
    currentJobs = currentJobs.filter(j => j.id !== jobId);
    completedJobs.push({ ...job, ...updateData });

    renderJobsList();
    updateStats();
    closeJobDetail();
  }
}

function updateJobOffline(jobId, data) {
  const offline = JSON.parse(localStorage.getItem(`driverOfflineUpdates_${driverId}`) || '{}');
  offline[jobId] = { ...offline[jobId], ...data, timestamp: Date.now() };
  localStorage.setItem(`driverOfflineUpdates_${driverId}`, JSON.stringify(offline));
}

function closeJobDetail() {
  document.getElementById('jobDetailModal').classList.add('hidden');
}

// ── Update Stats ──────────────────────────────────────────────────────────
function updateStats() {
  document.getElementById('statJobsRemaining').textContent = currentJobs.length;
  document.getElementById('statJobsCompleted').textContent = completedJobs.length;

  // Calculate total distance
  const totalDistance = completedJobs.reduce((sum, job) => sum + (job.distanceTravelled || 0), 0);
  document.getElementById('statDistance').textContent = totalDistance.toFixed(0);

  // Calculate total time
  const totalTime = completedJobs.reduce((sum, job) => sum + (job.timeTaken || 0), 0);
  const hours = (totalTime / 60).toFixed(1);
  document.getElementById('statTime').textContent = hours;
}

// ── GPS Tracking ──────────────────────────────────────────────────────────
function startGPSTracking() {
  if (!navigator.geolocation) {
    console.error('Geolocation not available');
    return;
  }

  // Get initial location
  navigator.geolocation.getCurrentPosition(
    (position) => {
      updateLocation(position.coords);
    },
    (error) => {
      console.error('Geolocation error:', error);
    }
  );

  // Watch position continuously
  navigator.geolocation.watchPosition(
    (position) => {
      updateLocation(position.coords);
    },
    (error) => {
      console.error('Watch position error:', error);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
}

function updateLocation(coords) {
  const newLat = coords.latitude;
  const newLng = coords.longitude;
  const accuracy = coords.accuracy;

  // Calculate distance travelled
  if (currentLocation.lat && currentLocation.lng) {
    const dist = calculateDistance(
      { lat: currentLocation.lat, lng: currentLocation.lng },
      { lat: newLat, lng: newLng }
    );
    distanceTravelled += dist;
  }

  currentLocation = { lat: newLat, lng: newLng };

  // Update location display
  const accuracyText = accuracy < 10 ? '✅' : accuracy < 50 ? '⚠️' : '❌';
  document.getElementById('currentLocationText').textContent =
    `${accuracyText} ${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}`;

  // Update map
  if (driverMap) {
    updateDriverMarker();
  }

  // Save location history
  saveLocationHistory(newLat, newLng);
}

function saveLocationHistory(lat, lng) {
  const history = JSON.parse(localStorage.getItem(`driverLocationHistory_${driverId}`) || '[]');
  history.push({ lat, lng, timestamp: Date.now() });
  // Keep only last 100 locations
  if (history.length > 100) history.shift();
  localStorage.setItem(`driverLocationHistory_${driverId}`, JSON.stringify(history));
}

// ── Map Initialization ────────────────────────────────────────────────────
function initializeMap() {
  const mapContainer = document.getElementById('driverMap');
  driverMap = new google.maps.Map(mapContainer, {
    center: currentLocation,
    zoom: 14,
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
    zoomControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER }
  });

  // Current location marker
  new google.maps.Marker({
    position: currentLocation,
    map: driverMap,
    title: 'My Location',
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: '#0ea5e9',
      fillOpacity: 1,
      strokeColor: 'white',
      strokeWeight: 2
    }
  });

  renderMapMarkers();

  // Map controls
  document.getElementById('centerMapBtn').addEventListener('click', () => {
    driverMap.panTo(currentLocation);
    driverMap.setZoom(15);
  });

  document.getElementById('toggleMapBtn').addEventListener('click', () => {
    const panel = document.querySelector('.driver-jobs-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
}

function renderMapMarkers() {
  // Clear old markers
  mapMarkers.forEach(marker => marker.setMap(null));
  mapMarkers = [];

  // Add job markers
  currentJobs.forEach((job, idx) => {
    const color = job.status === 'in-progress' ? '#f59e0b' : '#ef4444';
    const marker = new google.maps.Marker({
      position: job.location,
      map: driverMap,
      title: `${idx + 1}. ${job.customer}`,
      label: String(idx + 1),
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: 'white',
        strokeWeight: 2
      }
    });

    marker.addListener('click', () => selectJob(job.id));
    mapMarkers.push(marker);
  });

  // Fit bounds to show all markers
  if (mapMarkers.length > 0) {
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(currentLocation);
    mapMarkers.forEach(marker => bounds.extend(marker.getPosition()));
    driverMap.fitBounds(bounds);
  }
}

function updateDriverMarker() {
  if (driverMap && currentLocation) {
    driverMap.panTo(currentLocation);
  }
}

// ── Utility Functions ────────────────────────────────────────────────────
function calculateDistance(from, to) {
  const R = 6371; // Earth's radius in km
  const dLat = (to.lat - from.lat) * Math.PI / 180;
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(from.lat * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Offline Detection ────────────────────────────────────────────────────
function setupOfflineDetection() {
  window.addEventListener('online', () => {
    isOnline = true;
    document.getElementById('offlineBadge').classList.add('hidden');
    syncOfflineData();
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    document.getElementById('offlineBadge').classList.remove('hidden');
  });

  // Check initial state
  if (!navigator.onLine) {
    document.getElementById('offlineBadge').classList.remove('hidden');
  }
}

async function syncOfflineData() {
  const offline = localStorage.getItem(`driverOfflineUpdates_${driverId}`);
  if (!offline) return;

  const updates = JSON.parse(offline);
  for (const [jobId, data] of Object.entries(updates)) {
    try {
      await fetch(`/api/driver/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-driver-id': driverId,
          'x-driver-pin': driverPin
        },
        body: JSON.stringify(data)
      });
    } catch (error) {
      console.error(`Failed to sync job ${jobId}:`, error);
    }
  }

  localStorage.removeItem(`driverOfflineUpdates_${driverId}`);
}

// ── Logout ────────────────────────────────────────────────────────────────
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  if (confirm('Logout and stop tracking?')) {
    sessionStorage.removeItem('driverSession');
    location.reload();
  }
});

// Close job detail
document.getElementById('closeDetailBtn')?.addEventListener('click', closeJobDetail);
document.getElementById('jobDetailModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'jobDetailModal') closeJobDetail();
});
