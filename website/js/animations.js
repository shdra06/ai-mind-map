/* ============================================================
   AI MIND MAP — Animation Utilities
   Scroll-reveal, animated counters, typewriter,
   and neural-network particle background.
   ============================================================ */

(function () {
  'use strict';

  // ── Scroll Reveal (IntersectionObserver) ──────────────────
  function initScrollReveal() {
    const revealElements = document.querySelectorAll('.reveal');
    if (!revealElements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('active');
            // Don't unobserve — let it stay revealed
          }
        });
      },
      {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px',
      }
    );

    revealElements.forEach((el) => observer.observe(el));
  }

  // ── Animated Counter ──────────────────────────────────────
  // Usage: <span class="counter" data-target="99" data-suffix="%"></span>
  function initCounters() {
    const counters = document.querySelectorAll('.counter');
    if (!counters.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !entry.target.dataset.counted) {
            entry.target.dataset.counted = 'true';
            animateCounter(entry.target);
          }
        });
      },
      { threshold: 0.5 }
    );

    counters.forEach((el) => observer.observe(el));
  }

  function animateCounter(el) {
    const target = parseInt(el.dataset.target, 10) || 0;
    const suffix = el.dataset.suffix || '';
    const prefix = el.dataset.prefix || '';
    const duration = parseInt(el.dataset.duration, 10) || 2000;
    const start = performance.now();

    function easeOutExpo(t) {
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }

    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutExpo(progress);
      const current = Math.round(eased * target);

      el.textContent = prefix + current.toLocaleString() + suffix;

      if (progress < 1) {
        requestAnimationFrame(update);
      }
    }

    requestAnimationFrame(update);
  }

  // ── Typewriter Effect ─────────────────────────────────────
  // Usage: <span class="typewriter" data-text="Hello World" data-speed="80"></span>
  function initTypewriters() {
    const typewriters = document.querySelectorAll('.typewriter');
    if (!typewriters.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !entry.target.dataset.typed) {
            entry.target.dataset.typed = 'true';
            typewrite(entry.target);
          }
        });
      },
      { threshold: 0.5 }
    );

    typewriters.forEach((el) => observer.observe(el));
  }

  function typewrite(el) {
    const text = el.dataset.text || el.textContent;
    const speed = parseInt(el.dataset.speed, 10) || 60;
    el.textContent = '';
    el.style.borderRight = '2px solid var(--accent-cyan)';

    let i = 0;
    function type() {
      if (i < text.length) {
        el.textContent += text.charAt(i);
        i++;
        setTimeout(type, speed);
      } else {
        // Blink cursor then remove
        setTimeout(() => {
          el.style.borderRight = 'none';
        }, 1500);
      }
    }
    type();
  }

  // ── Neural Network Particle Background ────────────────────
  function initParticles(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let width, height;
    let particles = [];
    let animId;
    let mouse = { x: -1000, y: -1000 };

    const CONFIG = {
      particleCount: 80,
      maxDistance: 150,
      particleMinRadius: 1,
      particleMaxRadius: 2.5,
      speed: 0.3,
      colors: [
        'rgba(108, 92, 231, 0.6)',   // purple
        'rgba(0, 206, 201, 0.5)',    // cyan
        'rgba(253, 121, 168, 0.3)',  // pink
        'rgba(240, 240, 245, 0.2)',  // white
      ],
      lineColor: 'rgba(108, 92, 231, ',
      mouseRadius: 200,
    };

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      width = canvas.width = rect.width;
      height = canvas.height = rect.height;
    }

    function createParticle() {
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * CONFIG.speed,
        vy: (Math.random() - 0.5) * CONFIG.speed,
        radius:
          CONFIG.particleMinRadius +
          Math.random() * (CONFIG.particleMaxRadius - CONFIG.particleMinRadius),
        color:
          CONFIG.colors[Math.floor(Math.random() * CONFIG.colors.length)],
        baseOpacity: 0.3 + Math.random() * 0.5,
      };
    }

    function init() {
      resize();
      particles = [];
      // Adjust count for mobile
      const count =
        width < 768
          ? Math.floor(CONFIG.particleCount * 0.4)
          : CONFIG.particleCount;
      for (let i = 0; i < count; i++) {
        particles.push(createParticle());
      }
    }

    function drawParticle(p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }

    function drawLine(p1, p2, dist) {
      const opacity = (1 - dist / CONFIG.maxDistance) * 0.25;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = CONFIG.lineColor + opacity + ')';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    function update() {
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Move
        p.x += p.vx;
        p.y += p.vy;

        // Wrap around edges
        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10;
        if (p.y > height + 10) p.y = -10;

        // Mouse interaction — gentle push
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const mouseDist = Math.sqrt(dx * dx + dy * dy);
        if (mouseDist < CONFIG.mouseRadius) {
          const force = (CONFIG.mouseRadius - mouseDist) / CONFIG.mouseRadius;
          p.vx += (dx / mouseDist) * force * 0.01;
          p.vy += (dy / mouseDist) * force * 0.01;
        }

        // Dampen velocity
        p.vx *= 0.999;
        p.vy *= 0.999;

        drawParticle(p);

        // Connect nearby particles
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dist = Math.sqrt(
            (p.x - p2.x) ** 2 + (p.y - p2.y) ** 2
          );
          if (dist < CONFIG.maxDistance) {
            drawLine(p, p2, dist);
          }
        }
      }

      animId = requestAnimationFrame(update);
    }

    // Events
    window.addEventListener('resize', () => {
      resize();
    });

    canvas.parentElement.addEventListener('mousemove', (e) => {
      const rect = canvas.parentElement.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    });

    canvas.parentElement.addEventListener('mouseleave', () => {
      mouse.x = -1000;
      mouse.y = -1000;
    });

    // Visibility API — pause when tab hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(animId);
      } else {
        animId = requestAnimationFrame(update);
      }
    });

    init();
    update();
  }

  // ── Initialize Everything ─────────────────────────────────
  function boot() {
    initScrollReveal();
    initCounters();
    initTypewriters();
    // Particle canvas — looks for #hero-particles
    initParticles('hero-particles');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for external use
  window.AIMindMapAnimations = {
    initScrollReveal,
    initCounters,
    initTypewriters,
    initParticles,
    animateCounter,
  };
})();
