/**
 * AI Mind Map — Gemini AI Integration for Codebase Intelligence Chat
 * 
 * Uses Google Gemini 2.0 Flash (free tier) to power intelligent codebase Q&A.
 * The model receives the full codebase graph as context and answers naturally.
 * 
 * Free tier: 15 RPM, 1M tokens/day, no credit card needed.
 */

(function () {
  'use strict';

  const GEMINI_MODEL = 'gemini-2.0-flash-lite';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  let apiKey = null;
  let codebaseContext = null;
  let conversationHistory = [];

  /**
   * Build a compressed codebase context string for the AI
   * This is what makes the AI "understand" the codebase
   */
  function buildContext(data) {
    const parts = [];
    
    parts.push(`## CODEBASE ANALYSIS CONTEXT`);
    parts.push(`Repository: ${data.repoName || 'Unknown'}`);
    parts.push(`Total Files: ${data.files?.length || 0}`);
    parts.push(`Total Functions: ${data.nodes?.filter(n => n.type === 'function').length || 0}`);
    parts.push(`Total Classes: ${data.nodes?.filter(n => n.type === 'class').length || 0}`);
    
    // Routes
    const routes = data.routes || data.nodes?.filter(n => n.type === 'route') || [];
    if (routes.length > 0) {
      parts.push(`\n### HTTP Routes (${routes.length}):`);
      routes.slice(0, 30).forEach(r => {
        parts.push(`- ${r.method || 'GET'} ${r.path || r.label} → ${r.handler || 'handler'} (${r.file || r.file})`);
      });
    }
    
    // Files with their functions
    const fileMap = {};
    (data.nodes || []).forEach(n => {
      if (n.type === 'function' || n.type === 'class') {
        const f = n.file || 'unknown';
        if (!fileMap[f]) fileMap[f] = [];
        fileMap[f].push(`${n.type}: ${n.label}`);
      }
    });
    
    parts.push(`\n### File Structure:`);
    Object.entries(fileMap).slice(0, 40).forEach(([file, symbols]) => {
      parts.push(`📁 ${file}`);
      symbols.slice(0, 10).forEach(s => parts.push(`  - ${s}`));
    });
    
    // Edges (connections)
    const edgeSummary = {};
    (data.edges || []).forEach(e => {
      const s = typeof e.source === 'string' ? e.source : (e.source?.label || e.source?.id);
      const t = typeof e.target === 'string' ? e.target : (e.target?.label || e.target?.id);
      const key = `${s} → ${t}`;
      edgeSummary[key] = e.type || 'calls';
    });
    
    parts.push(`\n### Key Connections (${Object.keys(edgeSummary).length}):`);
    Object.entries(edgeSummary).slice(0, 50).forEach(([edge, type]) => {
      parts.push(`- [${type}] ${edge}`);
    });
    
    // Scores
    if (data.scores) {
      parts.push(`\n### Quality Scores:`);
      Object.entries(data.scores).forEach(([key, val]) => {
        if (typeof val === 'number') parts.push(`- ${key}: ${val}`);
      });
    }
    
    // Security findings
    if (data.security?.length > 0) {
      parts.push(`\n### Security Findings:`);
      data.security.slice(0, 10).forEach(s => {
        parts.push(`- [${s.severity}] ${s.category}: ${s.file} (×${s.count})`);
      });
    }
    
    // Dead code / orphans
    const orphans = (data.nodes || []).filter(n => {
      const hasIncoming = (data.edges || []).some(e => {
        const t = typeof e.target === 'string' ? e.target : e.target?.id;
        return t === n.id;
      });
      return !hasIncoming && n.type !== 'file';
    });
    
    if (orphans.length > 0) {
      parts.push(`\n### Potentially Dead Code (${orphans.length} symbols with no incoming references):`);
      orphans.slice(0, 15).forEach(n => {
        parts.push(`- ${n.type}: ${n.label} in ${n.file || 'unknown'}`);
      });
    }
    
    return parts.join('\n');
  }

  /**
   * Send a message to Gemini and get a response
   */
  async function chat(userMessage) {
    if (!apiKey) throw new Error('No API key set');
    if (!codebaseContext) throw new Error('No codebase context loaded');
    
    // Build the system instruction
    const systemInstruction = `You are an expert code analysis AI embedded in a Codebase Intelligence Explorer tool. 
You have been given the full analysis of a GitHub repository including its functions, classes, routes, connections, quality scores, and security findings.

Your job is to answer questions about this codebase intelligently. You can:
- Explain how routes/functions work based on the connection graph
- Identify potential issues, dead code, and security risks
- Suggest refactoring improvements
- Trace execution paths through the codebase
- Explain the architecture and design patterns used

Always be specific — reference actual function names, file paths, and connections from the data.
Keep responses concise but insightful (2-4 paragraphs max).
Use emojis sparingly for visual markers.
When showing paths, use tree notation: ├── ── └──

Here is the complete codebase analysis:

${codebaseContext}`;

    // Add to conversation history
    conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] });
    
    // Keep history manageable (last 10 messages)
    const recentHistory = conversationHistory.slice(-10);
    
    const requestBody = {
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: recentHistory,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        topP: 0.9,
        topK: 40
      }
    };

    const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 400 && errorData.error?.message?.includes('API key')) {
        throw new Error('Invalid API key. Get a free key at makersuite.google.com');
      }
      if (response.status === 429) {
        throw new Error('Rate limit hit. Free tier: 15 req/min. Wait a moment and try again.');
      }
      throw new Error(`Gemini API error: ${response.status} — ${errorData.error?.message || 'Unknown error'}`);
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    
    // Add assistant response to history
    conversationHistory.push({ role: 'model', parts: [{ text }] });
    
    return text;
  }

  /**
   * Render the API key input UI
   */
  function renderKeyInput(container, onKeySet) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-key-setup';
    wrapper.innerHTML = `
      <div class="ai-key-banner">
        <div class="ai-key-icon">✨</div>
        <div class="ai-key-text">
          <strong>Enable AI-Powered Chat</strong>
          <span>Free Gemini API key — no credit card needed</span>
        </div>
      </div>
      <div class="ai-key-row">
        <input type="password" class="ai-key-input" placeholder="Paste your Gemini API key..." autocomplete="off">
        <button class="ai-key-btn">Connect</button>
      </div>
      <a href="https://aistudio.google.com/apikey" target="_blank" class="ai-key-link">🔑 Get free API key →</a>
    `;
    
    const input = wrapper.querySelector('.ai-key-input');
    const btn = wrapper.querySelector('.ai-key-btn');
    
    const handleConnect = async () => {
      const key = input.value.trim();
      if (!key) return;
      
      btn.textContent = 'Verifying...';
      btn.disabled = true;
      
      try {
        // Test the key with a simple request
        apiKey = key;
        await chat('Say "Connected!" in one word');
        
        // Save key to localStorage
        try { localStorage.setItem('gemini-api-key', key); } catch (e) {}
        
        wrapper.innerHTML = `
          <div class="ai-key-banner ai-key-connected">
            <div class="ai-key-icon">🧠</div>
            <div class="ai-key-text">
              <strong>AI Chat Active</strong>
              <span>Gemini Flash • Free tier • Ask anything about this codebase</span>
            </div>
          </div>
        `;
        
        conversationHistory = []; // Reset after test
        if (onKeySet) onKeySet();
      } catch (err) {
        btn.textContent = 'Connect';
        btn.disabled = false;
        input.style.borderColor = '#d63031';
        input.placeholder = err.message;
        apiKey = null;
      }
    };
    
    btn.addEventListener('click', handleConnect);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') handleConnect(); });
    
    // Auto-load saved key
    try {
      const saved = localStorage.getItem('gemini-api-key');
      if (saved) {
        input.value = saved;
        setTimeout(handleConnect, 100);
      }
    } catch (e) {}
    
    container.prepend(wrapper);
  }

  // Inject CSS
  const style = document.createElement('style');
  style.textContent = `
    .ai-key-setup {
      padding: 0.65rem;
      border-bottom: 1px solid var(--border-soft, rgba(44,37,32,0.08));
    }
    .ai-key-banner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.65rem;
      background: linear-gradient(135deg, rgba(108,92,231,0.08), rgba(0,206,201,0.06));
      border-radius: 8px;
      margin-bottom: 0.4rem;
    }
    .ai-key-connected {
      background: linear-gradient(135deg, rgba(0,184,148,0.08), rgba(0,206,201,0.06));
    }
    .ai-key-icon { font-size: 1.1rem; }
    .ai-key-text {
      display: flex;
      flex-direction: column;
    }
    .ai-key-text strong {
      font-size: 0.75rem;
      color: var(--text-primary, #2C2520);
    }
    .ai-key-text span {
      font-size: 0.62rem;
      color: var(--text-secondary, #6B6560);
    }
    .ai-key-row {
      display: flex;
      gap: 0.3rem;
      margin-bottom: 0.3rem;
    }
    .ai-key-input {
      flex: 1;
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--border-soft, rgba(44,37,32,0.08));
      border-radius: 6px;
      font-size: 0.72rem;
      background: #fff;
      color: var(--text-primary, #2C2520);
      font-family: 'Geist Mono', monospace;
    }
    .ai-key-input:focus {
      outline: none;
      border-color: var(--accent-primary, #E8611A);
    }
    .ai-key-btn {
      padding: 0.35rem 0.75rem;
      background: var(--accent-primary, #E8611A);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .ai-key-btn:hover { background: var(--accent-hover, #C44D0F); }
    .ai-key-btn:disabled { opacity: 0.6; cursor: wait; }
    .ai-key-link {
      font-size: 0.65rem;
      color: var(--accent-primary, #E8611A);
      text-decoration: none;
    }
    .ai-key-link:hover { text-decoration: underline; }
    .ai-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      font-size: 0.58rem;
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      background: linear-gradient(135deg, rgba(108,92,231,0.12), rgba(0,206,201,0.1));
      color: #6c5ce7;
      font-weight: 600;
      vertical-align: middle;
    }
  `;
  document.head.appendChild(style);

  // Export
  window.IntelAI = {
    get isReady() { return !!apiKey && !!codebaseContext; },
    
    setContext(data) {
      codebaseContext = buildContext(data);
      conversationHistory = [];
    },
    
    setApiKey(key) {
      apiKey = key;
      try { localStorage.setItem('gemini-api-key', key); } catch (e) {}
    },
    
    chat,
    renderKeyInput,
    
    clearHistory() {
      conversationHistory = [];
    }
  };

})();
