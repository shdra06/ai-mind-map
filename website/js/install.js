/* ═══════════════════════════════════════════════════════════════
   AI Mind Map — Installation Wizard Controller
   Agent selection · Step progression · Config preview
   ═══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── Agent config templates ─────────────────────────────── */
  const configs = {
    claude: {
      name: 'Claude Code',
      file: '~/.claude/claude_desktop_config.json',
      content: {
        mcpServers: {
          'ai-mind-map': {
            command: 'npx',
            args: ['-y', 'ai-mind-map'],
          },
        },
      },
    },
    cursor: {
      name: 'Cursor',
      file: '.cursor/mcp.json',
      content: {
        mcpServers: {
          'ai-mind-map': {
            command: 'npx',
            args: ['-y', 'ai-mind-map'],
          },
        },
      },
    },
    vscode: {
      name: 'VS Code Copilot',
      file: '.vscode/mcp.json',
      content: {
        servers: {
          'ai-mind-map': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'ai-mind-map'],
          },
        },
      },
    },
    windsurf: {
      name: 'Windsurf',
      file: '~/.codeium/windsurf/mcp_config.json',
      content: {
        mcpServers: {
          'ai-mind-map': {
            command: 'npx',
            args: ['-y', 'ai-mind-map'],
          },
        },
      },
    },
    antigravity: {
      name: 'Antigravity / Gemini',
      file: '~/.gemini/settings.json',
      content: {
        mcpServers: {
          'ai-mind-map': {
            command: 'npx',
            args: ['-y', 'ai-mind-map'],
          },
        },
      },
    },
    zed: {
      name: 'Zed',
      file: '~/.config/zed/settings.json',
      content: {
        context_servers: {
          'ai-mind-map': {
            command: { path: 'npx', args: ['-y', 'ai-mind-map'] },
          },
        },
      },
    },
    continuedev: {
      name: 'Continue.dev',
      file: '~/.continue/config.json',
      content: {
        experimental: {
          modelContextProtocolServers: [
            {
              transport: { type: 'stdio', command: 'npx', args: ['-y', 'ai-mind-map'] },
            },
          ],
        },
      },
    },
    codex: {
      name: 'Codex',
      file: '~/.codex/config.json',
      content: {
        mcpServers: {
          'ai-mind-map': {
            command: 'npx',
            args: ['-y', 'ai-mind-map'],
          },
        },
      },
    },
  };

  /* ── State ──────────────────────────────────────────────── */
  let selectedAgent = 'claude';
  let currentStep = 1;

  /* ── DOM refs ───────────────────────────────────────────── */
  const agentGrid      = document.getElementById('agent-grid');
  const agentNameEl    = document.getElementById('agent-name-display');
  const configToggle   = document.getElementById('config-toggle');
  const configContent  = document.getElementById('config-content');
  const configFilePath = document.getElementById('config-file-path');
  const configJson     = document.getElementById('config-json');
  const stepDots       = [null, null, document.getElementById('step-dot-2'), document.getElementById('step-dot-3'), document.getElementById('step-dot-4')];
  const steps          = [null, document.getElementById('step-1'), document.getElementById('step-2'), document.getElementById('step-3'), document.getElementById('step-4')];

  /* ── Agent card selection ───────────────────────────────── */
  if (agentGrid) {
    agentGrid.addEventListener('click', e => {
      const card = e.target.closest('.agent-card');
      if (!card) return;

      // Toggle active
      agentGrid.querySelectorAll('.agent-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      selectedAgent = card.dataset.agent;

      // Update display name
      if (agentNameEl) agentNameEl.textContent = configs[selectedAgent].name;

      // Update config preview
      updateConfigPreview();

      // Advance to step 2
      if (currentStep < 2) advanceTo(2);
    });
  }

  /* ── Step progression ───────────────────────────────────── */
  function advanceTo(step) {
    if (step <= currentStep) return;
    currentStep = step;

    // Show the step section
    for (let i = 2; i <= 4; i++) {
      if (steps[i]) {
        if (i <= step) {
          steps[i].classList.add('visible');
        }
      }
    }

    // Update step dots
    const allDots = document.querySelectorAll('.step-number');
    const allLines = document.querySelectorAll('.step-line');
    allDots.forEach((dot, idx) => {
      if (idx + 1 < step) {
        dot.classList.add('completed');
        dot.classList.remove('active');
      } else if (idx + 1 === step) {
        dot.classList.add('active');
        dot.classList.remove('completed');
      }
    });
    allLines.forEach((line, idx) => {
      if (idx + 1 < step) line.classList.add('filled');
    });

    // Smooth scroll
    if (steps[step]) {
      setTimeout(() => {
        steps[step].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 200);
    }
  }

  /* ── Copy to clipboard ─────────────────────────────────── */
  document.addEventListener('click', e => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;

    const text = btn.dataset.text || btn.closest('.code-block').querySelector('code, pre')?.textContent || '';
    navigator.clipboard.writeText(text.trim()).then(() => {
      btn.classList.add('copied');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = orig;
      }, 2000);
    });

    // Advance steps on copy
    if (btn.id === 'copy-install' && currentStep < 3) {
      setTimeout(() => advanceTo(3), 600);
    }
    if (currentStep === 3 && btn !== document.getElementById('copy-install') && btn !== document.getElementById('copy-config')) {
      setTimeout(() => advanceTo(4), 600);
    }
  });

  /* ── Config preview toggle ──────────────────────────────── */
  if (configToggle) {
    configToggle.addEventListener('click', () => {
      configContent.classList.toggle('open');
      configToggle.querySelector('.config-toggle__arrow').classList.toggle('open');
    });
  }

  /* ── Update config preview ──────────────────────────────── */
  function updateConfigPreview() {
    const cfg = configs[selectedAgent];
    if (!cfg) return;
    if (configFilePath) configFilePath.textContent = cfg.file;
    if (configJson) configJson.textContent = JSON.stringify(cfg.content, null, 2);
  }

  /* ── Init ───────────────────────────────────────────────── */
  const init = () => {
    updateConfigPreview();
    // Show step 2 by default (agent is pre-selected)
    advanceTo(2);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
