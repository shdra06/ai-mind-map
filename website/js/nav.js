/* ============================================================
   AI MIND MAP — Navigation Module
   Handles mobile menu, active links, scroll effects,
   and smooth anchor scrolling.
   ============================================================ */

(function () {
  'use strict';

  // ── DOM Refs ──────────────────────────────────────────────
  const navbar = document.querySelector('.navbar');
  const hamburger = document.querySelector('.hamburger');
  const mobileNav = document.querySelector('.mobile-nav');
  const navLinks = document.querySelectorAll('.nav-link');

  // ── Mobile Hamburger Toggle ───────────────────────────────
  if (hamburger && mobileNav) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('active');
      mobileNav.classList.toggle('active');
      document.body.style.overflow = mobileNav.classList.contains('active')
        ? 'hidden'
        : '';
    });

    // Close mobile nav on link click
    mobileNav.querySelectorAll('.nav-link').forEach((link) => {
      link.addEventListener('click', () => {
        hamburger.classList.remove('active');
        mobileNav.classList.remove('active');
        document.body.style.overflow = '';
      });
    });

    // Close mobile nav on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobileNav.classList.contains('active')) {
        hamburger.classList.remove('active');
        mobileNav.classList.remove('active');
        document.body.style.overflow = '';
      }
    });
  }

  // ── Scroll-Triggered Glass Nav ────────────────────────────
  function handleNavScroll() {
    if (!navbar) return;
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', handleNavScroll, { passive: true });
  handleNavScroll(); // run on load

  // ── Active Link Detection ─────────────────────────────────
  function setActiveLink() {
    const currentPath = window.location.pathname;
    const currentFile = currentPath.split('/').pop() || 'index.html';

    navLinks.forEach((link) => {
      link.classList.remove('active');
      const href = link.getAttribute('href');
      if (!href) return;

      const linkFile = href.split('/').pop() || 'index.html';

      if (linkFile === currentFile) {
        link.classList.add('active');
      } else if (
        (currentFile === '' || currentFile === 'index.html') &&
        (linkFile === '' || linkFile === 'index.html' || linkFile === './')
      ) {
        link.classList.add('active');
      }
    });
  }

  setActiveLink();

  // ── Smooth Scroll for Anchor Links ────────────────────────
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;

    const targetId = link.getAttribute('href');
    if (targetId === '#') return;

    const target = document.querySelector(targetId);
    if (!target) return;

    e.preventDefault();

    const navHeight = navbar ? navbar.offsetHeight : 0;
    const targetPos =
      target.getBoundingClientRect().top + window.pageYOffset - navHeight - 20;

    window.scrollTo({
      top: targetPos,
      behavior: 'smooth',
    });

    // Close mobile nav if open
    if (mobileNav && mobileNav.classList.contains('active')) {
      hamburger.classList.remove('active');
      mobileNav.classList.remove('active');
      document.body.style.overflow = '';
    }
  });

  // ── Copy-to-Clipboard for Code Blocks ─────────────────────
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-btn');
    if (!copyBtn) return;

    const codeBlock = copyBtn.closest('.code-block');
    if (!codeBlock) return;

    const codeEl = codeBlock.querySelector('code');
    if (!codeEl) return;

    const text = codeEl.textContent.trim();

    navigator.clipboard
      .writeText(text)
      .then(() => {
        copyBtn.textContent = '✓ Copied';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      })
      .catch(() => {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          copyBtn.textContent = '✓ Copied';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 2000);
        } catch (err) {
          copyBtn.textContent = 'Failed';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 2000);
        }
        document.body.removeChild(textarea);
      });
  });
})();
