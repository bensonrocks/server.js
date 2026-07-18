document.getElementById('year').textContent = new Date().getFullYear();

// ---------- Theme toggle ----------
const root = document.documentElement;
const themeToggle = document.getElementById('theme-toggle');
const storedTheme = localStorage.getItem('nimbustrade-theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
root.dataset.theme = storedTheme || (prefersDark ? 'dark' : 'light');

themeToggle.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('nimbustrade-theme', next);
});

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
