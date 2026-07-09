/* ═══════════════════════════════════════════════════════════════
   AI Mind Map — Architecture Page Interactions
   Pipeline hover · Scroll reveals · Edge tooltips
   ═══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── Pipeline card hover — highlight connections ─────── */
  const pipeCards = document.querySelectorAll('.pipe-card');
  const connectionMap = {};

  // Build adjacency from data-connects attributes
  pipeCards.forEach(card => {
    const id = card.dataset.pipe;
    const connects = card.dataset.connects;
    if (id && connects) {
      if (!connectionMap[id]) connectionMap[id] = [];
      connectionMap[id].push(connects);
    }
  });

  pipeCards.forEach(card => {
    card.addEventListener('mouseenter', () => {
      const id = card.dataset.pipe;
      // Highlight self
      card.classList.add('highlight');
      // Highlight connected
      const connected = connectionMap[id] || [];
      connected.forEach(targetId => {
        const target = document.querySelector(`[data-pipe="${targetId}"]`);
        if (target) target.classList.add('highlight');
      });
      // Also highlight anything that connects TO this card
      Object.keys(connectionMap).forEach(srcId => {
        if (connectionMap[srcId].includes(id)) {
          const src = document.querySelector(`[data-pipe="${srcId}"]`);
          if (src) src.classList.add('highlight');
        }
      });
    });

    card.addEventListener('mouseleave', () => {
      pipeCards.forEach(c => c.classList.remove('highlight'));
    });
  });

  /* ── Memory tier bar animation on scroll ────────────── */
  const tierBars = document.querySelectorAll('.tier-limit-bar');
  const tierObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const bar = entry.target;
        const width = bar.style.getPropertyValue('--bar-width');
        // Reset and animate
        bar.style.width = '0%';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            bar.style.width = width;
          });
        });
        tierObserver.unobserve(bar);
      }
    });
  }, { threshold: 0.5 });
  tierBars.forEach(bar => tierObserver.observe(bar));

  /* ── Language badge stagger animation ───────────────── */
  const langBadges = document.querySelectorAll('.lang-badge');
  const langObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const badges = entry.target.parentElement.querySelectorAll('.lang-badge');
        badges.forEach((badge, i) => {
          badge.style.opacity = '0';
          badge.style.transform = 'translateY(16px) scale(0.9)';
          badge.style.transition = `all 0.4s cubic-bezier(0.16,1,0.3,1) ${i * 40}ms`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              badge.style.opacity = '1';
              badge.style.transform = 'translateY(0) scale(1)';
            });
          });
        });
        langObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.2 });

  if (langBadges.length > 0) {
    langObserver.observe(langBadges[0]);
  }

  /* ── Edge card hover tooltip ────────────────────────── */
  const edgeDetails = {
    calls:      'Weight: 1.0 — Direct function invocation, strongest signal',
    imports:    'Weight: 0.5 — Module-level dependency, file coupling',
    exports:    'Weight: 0.4 — Public API surface, consumed by importers',
    inherits:   'Weight: 0.8 — Class hierarchy, strong structural bond',
    implements: 'Weight: 0.7 — Interface contract, enforced relationship',
    uses:       'Weight: 0.3 — Variable/type reference, lighter coupling',
    decorates:  'Weight: 0.6 — Decorator modifies behavior at definition',
    overrides:  'Weight: 0.7 — Method override, polymorphic relationship',
    contains:   'Weight: 0.5 — Nested/inner symbol, structural nesting',
    tests:      'Weight: 0.4 — Test targets implementation, coverage link',
    depends_on: 'Weight: 0.3 — External package dependency',
    routes_to:  'Weight: 0.6 — HTTP/event route to handler mapping',
  };

  document.querySelectorAll('.edge-card').forEach(card => {
    const name = card.querySelector('h4')?.textContent;
    if (name && edgeDetails[name]) {
      // Create tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'edge-tooltip';
      tooltip.textContent = edgeDetails[name];
      tooltip.style.cssText = `
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%);
        background: rgba(10,11,20,0.95);
        border: 1px solid rgba(108,92,231,0.3);
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 0.75rem;
        color: #8b8ba3;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease;
        z-index: 10;
        font-family: 'JetBrains Mono', monospace;
        max-width: 280px;
        white-space: normal;
        text-align: center;
      `;
      card.style.position = 'relative';
      card.appendChild(tooltip);

      card.addEventListener('mouseenter', () => { tooltip.style.opacity = '1'; });
      card.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
    }
  });

  /* ── PageRank node pulse sync ───────────────────────── */
  const prNode = document.querySelector('.pr-node--large');
  if (prNode) {
    const callers = document.querySelectorAll('.pr-caller');
    callers.forEach((caller, i) => {
      caller.addEventListener('mouseenter', () => {
        prNode.style.boxShadow = '0 0 50px rgba(0,184,148,0.6)';
        caller.style.borderColor = 'var(--cyan)';
        caller.style.color = 'var(--cyan)';
      });
      caller.addEventListener('mouseleave', () => {
        prNode.style.boxShadow = '';
        caller.style.borderColor = '';
        caller.style.color = '';
      });
    });
  }
})();
