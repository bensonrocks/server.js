document.getElementById('year').textContent = new Date().getFullYear();

const navToggle = document.getElementById('nav-toggle');
const mainNav = document.getElementById('main-nav');

navToggle.addEventListener('click', () => {
  mainNav.classList.toggle('open');
});

mainNav.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => mainNav.classList.remove('open'));
});

document.querySelectorAll('.faq-item').forEach((item) => {
  const question = item.querySelector('.faq-q');
  question.addEventListener('click', () => {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach((open) => open.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});

document.querySelectorAll('.pillar-expand-toggle').forEach((btn) => {
  const panel = document.getElementById(btn.getAttribute('aria-controls'));
  btn.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(isOpen));
  });
});

// ---------- Scroll progress bar ----------
const progressBar = document.getElementById('scroll-progress');
function updateScrollProgress() {
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const pct = docHeight > 0 ? (window.scrollY / docHeight) * 100 : 0;
  progressBar.style.width = pct + '%';
}
window.addEventListener('scroll', updateScrollProgress, { passive: true });
updateScrollProgress();

// ---------- Header shadow on scroll ----------
const siteHeader = document.querySelector('.site-header');
window.addEventListener('scroll', () => {
  siteHeader.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

// ---------- Scroll-reveal animations ----------
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function setupReveal(selector, stagger = 90, threshold = 0.15) {
  const els = document.querySelectorAll(selector);
  if (!els.length) return;

  if (prefersReducedMotion) {
    els.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  els.forEach((el, i) => {
    el.classList.add('reveal');
    el.style.transitionDelay = `${i * stagger}ms`;
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold });

  els.forEach((el) => observer.observe(el));
}

setupReveal('.ledger-flow > *', 110, 0.4);
setupReveal('.pillar-card', 100);
setupReveal('.problem-card', 100);
setupReveal('.step', 90);
setupReveal('.team-card', 110);
setupReveal('.why-card', 90);
setupReveal('.engage-card', 100);
setupReveal('.compare-wrap', 0);

// ---------- Animated hero stat counters ----------
function animateCount(el) {
  const target = parseFloat(el.dataset.count);
  const suffix = el.dataset.suffix || '';
  if (prefersReducedMotion || Number.isNaN(target)) {
    el.textContent = target + suffix;
    return;
  }
  const duration = 1100;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased) + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

document.querySelectorAll('.hero-ledger [data-count]').forEach((el) => {
  setTimeout(() => animateCount(el), 300);
});

// ---------- Network map (real world map — Singapore hub to 12 markets) ----------
(function buildNetworkMap() {
  const el = document.getElementById('network-map');
  if (!el || typeof L === 'undefined') return;

  const HUB = { code: 'SG', name: 'Singapore · Origin', lat: 1.3521, lng: 103.8198, dir: 'left' };
  const MARKETS = [
    { code: 'MY', name: 'Kuala Lumpur', lat: 3.1390, lng: 101.6869, dir: 'top' },
    { code: 'TH', name: 'Bangkok', lat: 13.7563, lng: 100.5018, dir: 'left' },
    { code: 'VN', name: 'Ho Chi Minh City', lat: 10.8231, lng: 106.6297, dir: 'right' },
    { code: 'ID', name: 'Jakarta', lat: -6.2088, lng: 106.8456, dir: 'bottom' },
    { code: 'PH', name: 'Manila', lat: 14.5995, lng: 120.9842, dir: 'right' },
    { code: 'CN', name: 'Shanghai', lat: 31.2304, lng: 121.4737, dir: 'top' },
    { code: 'AU', name: 'Sydney', lat: -33.8688, lng: 151.2093, dir: 'right' },
    { code: 'AE', name: 'Dubai', lat: 25.2048, lng: 55.2708, dir: 'top' },
    { code: 'MX', name: 'Mexico City', lat: 19.4326, lng: -99.1332, dir: 'bottom' },
    { code: 'US', name: 'Los Angeles', lat: 34.0522, lng: -118.2437, dir: 'top' },
    { code: 'CA', name: 'Toronto', lat: 43.6532, lng: -79.3832, dir: 'top' },
    { code: 'UK', name: 'London', lat: 51.5072, lng: -0.1276, dir: 'top' },
  ];

  const map = L.map(el, {
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    attributionControl: true,
    worldCopyJump: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  const hubIcon = L.divIcon({ className: '', html: '<div class="nt-marker-hub"></div>', iconSize: [11, 11], iconAnchor: [5.5, 5.5] });
  const nodeIcon = L.divIcon({ className: '', html: '<div class="nt-marker-node"></div>', iconSize: [9, 9], iconAnchor: [4.5, 4.5] });

  const allPoints = [[HUB.lat, HUB.lng]];

  MARKETS.forEach((m) => {
    allPoints.push([m.lat, m.lng]);
    L.polyline([[HUB.lat, HUB.lng], [m.lat, m.lng]], {
      color: '#0a558b', weight: 1, dashArray: '2 5', opacity: 0.45, interactive: false,
    }).addTo(map);
  });

  const dirOffset = {
    top: [0, -6], bottom: [0, 6], left: [-8, 0], right: [8, 0],
  };

  MARKETS.forEach((m) => {
    L.marker([m.lat, m.lng], { icon: nodeIcon, interactive: false })
      .bindTooltip(`${m.code} · ${m.name}`, { permanent: true, direction: m.dir, offset: dirOffset[m.dir], className: 'nt-map-label' })
      .addTo(map);
  });

  L.marker([HUB.lat, HUB.lng], { icon: hubIcon, interactive: false })
    .bindTooltip(HUB.name, { permanent: true, direction: HUB.dir, offset: dirOffset[HUB.dir], className: 'nt-map-label nt-hub-label' })
    .addTo(map);

  map.fitBounds(L.latLngBounds(allPoints), { padding: [34, 34] });
})();
