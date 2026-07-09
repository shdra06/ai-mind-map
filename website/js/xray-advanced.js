/**
 * AI Mind Map — Advanced X-Ray Grading Engine v2
 * 
 * Based on industry standards:
 * - ISO/IEC 25010 (SQuaRE) quality model
 * - ISO/IEC 5055 (CISQ) automated quality measures
 * - McCabe Cyclomatic Complexity (1976)
 * - SonarSource Cognitive Complexity
 * - Halstead Complexity Measures
 * - Robert C. Martin Package Metrics (Instability, Abstractness)
 * - SonarQube/CodeClimate grading methodology
 * - SOLID principle violation detection
 * - OWASP security pattern detection
 * 
 * 12 Metric Categories, 40+ individual checks
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════
     ███  METRIC THRESHOLDS (Industry Standard)  ███
     ═══════════════════════════════════════════════════════════════ */

  const THRESHOLDS = {
    // McCabe Cyclomatic Complexity per function
    cyclomaticComplexity: { low: 10, moderate: 20, high: 50 },
    // SonarSource Cognitive Complexity per function
    cognitiveComplexity: { low: 15, moderate: 25, high: 40 },
    // Lines per function (Clean Code)
    linesPerFunction: { low: 30, moderate: 60, high: 100 },
    // Parameters per function (Clean Code: max 3-4)
    paramsPerFunction: { low: 4, moderate: 6, high: 8 },
    // Nesting depth (industry: max 3-4)
    nestingDepth: { low: 3, moderate: 5, high: 7 },
    // Lines per file (maintainability)
    linesPerFile: { low: 300, moderate: 500, high: 1000 },
    // Functions per file
    functionsPerFile: { low: 15, moderate: 25, high: 40 },
    // Fan-out per module (efferent coupling)
    fanOut: { low: 8, moderate: 15, high: 25 },
    // Fan-in per module (afferent coupling)
    fanIn: { low: 10, moderate: 20, high: 40 },
    // Comment density (recommended: 10-30%)
    commentDensity: { low: 5, target: 15, high: 40 },
    // Technical Debt Ratio (SonarQube: A ≤5%, B 6-10%, C 11-20%, D 21-50%, E >50%)
    techDebtRatio: { a: 5, b: 10, c: 20, d: 50 },
    // Duplication threshold
    duplication: { low: 3, moderate: 5, high: 10 },
  };

  /* ═══════════════════════════════════════════════════════════════
     ███  ADVANCED METRICS CALCULATORS  ███
     ═══════════════════════════════════════════════════════════════ */

  /**
   * McCabe Cyclomatic Complexity
   * M = number of decision points + 1
   * Decision points: if, else if, while, for, case, &&, ||, ?:, catch
   */
  function calculateCyclomaticComplexity(code) {
    if (!code) return 1;
    const decisions = [
      /\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bwhile\s*\(/g,
      /\bfor\s*\(/g, /\bcase\s+/g, /\bcatch\s*\(/g,
      /\?\s*[^:]/g, /&&/g, /\|\|/g, /\?\?/g
    ];
    let count = 1;
    decisions.forEach(re => { const m = code.match(re); if (m) count += m.length; });
    return count;
  }

  /**
   * SonarSource Cognitive Complexity
   * Differs from cyclomatic: penalizes NESTING, recognizes shorthand
   * Increment for: if, else if, else, switch, for, while, do, catch, ternary, &&, ||
   * Nesting increment: +1 for each level of nesting at point of decision
   */
  function calculateCognitiveComplexity(code) {
    if (!code) return 0;
    const lines = code.split('\n');
    let complexity = 0;
    let nesting = 0;
    const openers = /\{/g, closers = /\}/g;
    
    lines.forEach(line => {
      const t = line.trim();
      // Track nesting
      const opens = (line.match(openers) || []).length;
      const closes = (line.match(closers) || []).length;
      
      // Structural increment + nesting penalty
      if (/\b(if|else\s+if)\s*\(/.test(t)) complexity += 1 + nesting;
      else if (/\belse\b/.test(t) && !/else\s+if/.test(t)) complexity += 1;
      if (/\b(for|while|do)\s*[\({]/.test(t)) complexity += 1 + nesting;
      if (/\bswitch\s*\(/.test(t)) complexity += 1 + nesting;
      if (/\bcatch\s*\(/.test(t)) complexity += 1 + nesting;
      
      // Logical operators (each one)
      const logicals = (t.match(/&&|\|\||\?\?/g) || []).length;
      complexity += logicals;
      
      // Ternary
      if (/\?[^?]/.test(t) && /:/.test(t) && !/case\s/.test(t)) complexity += 1 + nesting;
      
      nesting += opens - closes;
      if (nesting < 0) nesting = 0;
    });
    
    return complexity;
  }

  /**
   * Halstead Complexity Measures
   * n1 = distinct operators, n2 = distinct operands
   * N1 = total operators, N2 = total operands
   * Program Length: N = N1 + N2
   * Vocabulary: n = n1 + n2
   * Volume: V = N × log2(n)
   * Difficulty: D = (n1/2) × (N2/n2)
   * Effort: E = D × V
   * Bugs predicted: B = V / 3000
   */
  function calculateHalstead(code) {
    if (!code) return { volume: 0, difficulty: 0, effort: 0, bugs: 0, time: 0 };
    
    const operatorPatterns = /[+\-*/%=<>!&|^~?:;,.{}()\[\]]/g;
    const keywordPatterns = /\b(if|else|for|while|do|switch|case|break|continue|return|throw|try|catch|finally|new|delete|typeof|instanceof|void|in|of|class|function|const|let|var|import|export|default|async|await|yield)\b/g;
    const operandPatterns = /\b(?:[a-zA-Z_$][\w$]*|[0-9]+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`]*`)\b/g;
    
    const operators = new Set();
    const operands = new Set();
    let N1 = 0, N2 = 0;
    
    let m;
    const ops = code.match(operatorPatterns) || [];
    const kws = code.match(keywordPatterns) || [];
    const opds = code.match(operandPatterns) || [];
    
    ops.forEach(o => { operators.add(o); N1++; });
    kws.forEach(k => { operators.add(k); N1++; });
    opds.forEach(o => { operands.add(o); N2++; });
    
    const n1 = operators.size || 1;
    const n2 = operands.size || 1;
    const N = N1 + N2;
    const n = n1 + n2;
    const volume = N * Math.log2(n || 2);
    const difficulty = (n1 / 2) * (N2 / n2);
    const effort = difficulty * volume;
    const bugs = volume / 3000;
    const time = effort / 18; // Stroud number: 18 moments per second
    
    return { volume: Math.round(volume), difficulty: Math.round(difficulty), effort: Math.round(effort), bugs: Math.round(bugs * 100) / 100, time: Math.round(time / 60) };
  }

  /**
   * Nesting Depth Analysis
   * Max nesting depth in a function
   */
  function calculateMaxNesting(code) {
    if (!code) return 0;
    let max = 0, current = 0;
    for (const ch of code) {
      if (ch === '{') { current++; max = Math.max(max, current); }
      if (ch === '}') current--;
    }
    return max;
  }

  /**
   * Parameter Count
   * Extract parameters from function signature
   */
  function countParameters(code) {
    if (!code) return 0;
    const m = code.match(/\(([^)]*)\)/);
    if (!m || !m[1].trim()) return 0;
    return m[1].split(',').filter(p => p.trim()).length;
  }

  /**
   * Comment Density
   * (comment lines / total lines) × 100
   */
  function calculateCommentDensity(code) {
    if (!code) return 0;
    const lines = code.split('\n');
    const total = lines.length;
    if (total === 0) return 0;
    
    let comments = 0;
    let inBlock = false;
    lines.forEach(line => {
      const t = line.trim();
      if (inBlock) { comments++; if (/\*\//.test(t)) inBlock = false; return; }
      if (/^\/\//.test(t) || /^#/.test(t)) { comments++; return; }
      if (/\/\*/.test(t)) { comments++; inBlock = true; if (/\*\//.test(t)) inBlock = false; }
      if (/\/\//.test(t)) comments += 0.5; // inline comments count half
    });
    return Math.round((comments / total) * 100);
  }

  /**
   * Code Duplication Detection
   * Hash function bodies and find duplicates
   */
  function detectDuplication(files) {
    const chunks = new Map(); // hash → [locations]
    const minLines = 4;
    
    files.forEach(file => {
      const lines = (file.content || '').split('\n');
      for (let i = 0; i <= lines.length - minLines; i++) {
        const chunk = lines.slice(i, i + minLines).map(l => l.trim()).filter(l => l.length > 0).join('|');
        if (chunk.length < 20) continue; // skip tiny chunks
        const key = simpleHash(chunk);
        if (!chunks.has(key)) chunks.set(key, []);
        chunks.get(key).push({ file: file.path, line: i + 1 });
      }
    });
    
    let duplicatedBlocks = 0;
    let duplicatedFiles = new Set();
    chunks.forEach((locations, key) => {
      if (locations.length > 1) {
        const uniqueFiles = new Set(locations.map(l => l.file));
        if (uniqueFiles.size > 1) {
          duplicatedBlocks++;
          uniqueFiles.forEach(f => duplicatedFiles.add(f));
        }
      }
    });
    
    return { blocks: duplicatedBlocks, files: duplicatedFiles.size, percentage: files.length > 0 ? Math.round((duplicatedFiles.size / files.length) * 100) : 0 };
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0;
    }
    return hash;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  SECURITY SCANNER  ███
     ═══════════════════════════════════════════════════════════════ */

  const SECURITY_PATTERNS = [
    { id: 'hardcoded-secret', severity: 'critical', category: 'Hardcoded Secret',
      patterns: [
        /(?:api[_-]?key|apikey|secret|password|passwd|token|auth[_-]?token|access[_-]?key)\s*[=:]\s*['"][^'"]{8,}/gi,
        /['"](?:sk|pk|rk|ak)[-_][a-zA-Z0-9]{20,}['"]/g,
        /['"](?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}['"]/g,
        /['"]AKIA[A-Z0-9]{16}['"]/g,
      ],
      impact: 'OWASP A07:2021 — Credentials in source code can be extracted and used for unauthorized access'
    },
    { id: 'eval-usage', severity: 'critical', category: 'Code Injection Risk',
      patterns: [/\beval\s*\(/g, /new\s+Function\s*\(/g, /\bexec\s*\(/g],
      impact: 'OWASP A03:2021 — eval() can execute arbitrary code, enabling injection attacks'
    },
    { id: 'innerhtml', severity: 'warning', category: 'XSS Risk',
      patterns: [/\.innerHTML\s*=(?!=)/g, /dangerouslySetInnerHTML/g, /\$\(.*\)\.html\s*\(/g, /document\.write\s*\(/g],
      impact: 'OWASP A03:2021 — Direct HTML insertion without sanitization enables cross-site scripting'
    },
    { id: 'sql-injection', severity: 'critical', category: 'SQL Injection Risk',
      patterns: [/['"`]\s*\+\s*\w+.*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)/gi, /\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)/gi],
      impact: 'OWASP A03:2021 — String concatenation in SQL queries allows injection of malicious SQL'
    },
    { id: 'path-traversal', severity: 'warning', category: 'Path Traversal Risk',
      patterns: [/\.\.\//g],
      impact: 'OWASP A01:2021 — Path traversal can expose files outside intended directories',
      minCount: 5 // only flag if excessive
    },
    { id: 'no-auth-check', severity: 'info', category: 'Missing Auth Pattern',
      patterns: [/app\.(get|post|put|delete|patch)\s*\(\s*['"][^'"]+['"]\s*,\s*(?!.*(?:auth|middleware|protect|guard|verify))/gi],
      impact: 'OWASP A01:2021 — Route handlers without authentication middleware may expose data'
    },
    { id: 'console-log', severity: 'info', category: 'Debug Artifacts',
      patterns: [/console\.(log|debug|info)\s*\(/g],
      impact: 'Production code should not contain console.log statements — may leak sensitive information'
    },
    { id: 'todo-fixme', severity: 'info', category: 'Unresolved Technical Debt',
      patterns: [/\/\/\s*(?:TODO|FIXME|HACK|XXX|BUG)\b/gi],
      impact: 'Unresolved TODO/FIXME comments indicate known issues or incomplete implementation'
    },
  ];

  function runSecurityScan(files) {
    const findings = [];
    files.forEach(file => {
      const content = file.content || '';
      SECURITY_PATTERNS.forEach(pattern => {
        let totalMatches = 0;
        pattern.patterns.forEach(re => {
          const matches = content.match(re);
          if (matches) totalMatches += matches.length;
        });
        const minCount = pattern.minCount || 1;
        if (totalMatches >= minCount) {
          findings.push({
            severity: pattern.severity,
            category: pattern.category,
            file: file.path,
            count: totalMatches,
            impact: pattern.impact,
            id: pattern.id
          });
        }
      });
    });
    return findings;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  DOCUMENTATION QUALITY  ███
     ═══════════════════════════════════════════════════════════════ */

  function analyzeDocumentation(files) {
    let totalFunctions = 0;
    let documentedFunctions = 0;
    let totalCommentDensity = 0;
    let filesWithJSDoc = 0;
    let hasReadme = false;
    let hasLicense = false;
    let hasContributing = false;
    let hasChangelog = false;
    
    files.forEach(file => {
      const content = file.content || '';
      const fns = file.parsed.functions.length;
      totalFunctions += fns;
      
      // Check for JSDoc/docstrings before function definitions
      const jsDocCount = (content.match(/\/\*\*[\s\S]*?\*\/\s*\n\s*(?:export\s+)?(?:async\s+)?(?:function|const|class)/g) || []).length;
      const pyDocCount = (content.match(/"""[\s\S]*?"""/g) || []).length;
      documentedFunctions += jsDocCount + pyDocCount;
      if (jsDocCount > 0 || pyDocCount > 0) filesWithJSDoc++;
      
      totalCommentDensity += calculateCommentDensity(content);
      
      const lower = file.path.toLowerCase();
      if (/readme/i.test(lower)) hasReadme = true;
      if (/license/i.test(lower)) hasLicense = true;
      if (/contributing/i.test(lower)) hasContributing = true;
      if (/changelog/i.test(lower)) hasChangelog = true;
    });
    
    const avgCommentDensity = files.length > 0 ? Math.round(totalCommentDensity / files.length) : 0;
    const docCoverage = totalFunctions > 0 ? Math.round((documentedFunctions / totalFunctions) * 100) : 0;
    
    let score = 0;
    score += hasReadme ? 20 : 0;
    score += hasLicense ? 10 : 0;
    score += hasContributing ? 10 : 0;
    score += hasChangelog ? 5 : 0;
    score += Math.min(25, docCoverage / 2); // max 25 for doc coverage
    score += Math.min(15, avgCommentDensity); // max 15 for comment density
    score += Math.min(15, filesWithJSDoc * 2); // max 15 for files with JSDoc
    
    return {
      score: Math.min(100, Math.round(score)),
      docCoverage,
      avgCommentDensity,
      hasReadme, hasLicense, hasContributing, hasChangelog,
      documentedFunctions, totalFunctions
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  ADVANCED ANALYSIS ENGINE  ███
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Run the complete advanced analysis suite
   * Returns an object with all metric categories
   */
  function runAdvancedAnalysis(files, nodes, edges) {
    const result = {
      // Per-function metrics
      functionMetrics: [],
      // Per-file metrics  
      fileMetrics: [],
      // Module-level (Robert C. Martin)
      moduleMetrics: [],
      // Aggregate scores
      scores: {},
      // Security findings
      security: [],
      // Documentation quality
      documentation: {},
      // Code duplication
      duplication: {},
      // Halstead program-level
      halstead: {},
      // Summary statistics
      summary: {}
    };

    // === 1. Per-Function Analysis ===
    files.forEach(file => {
      const content = file.content || '';
      const lines = content.split('\n');
      
      file.parsed.functions.forEach(fn => {
        // Extract function body (approximate)
        const startLine = fn.line - 1;
        let braceCount = 0, started = false, endLine = startLine;
        for (let i = startLine; i < lines.length && i < startLine + 200; i++) {
          for (const ch of lines[i]) {
            if (ch === '{') { braceCount++; started = true; }
            if (ch === '}') braceCount--;
          }
          endLine = i;
          if (started && braceCount <= 0) break;
        }
        
        const body = lines.slice(startLine, endLine + 1).join('\n');
        const bodyLines = endLine - startLine + 1;
        
        const cc = calculateCyclomaticComplexity(body);
        const cog = calculateCognitiveComplexity(body);
        const nesting = calculateMaxNesting(body);
        const params = countParameters(fn.code || '');
        
        // Risk classification per function
        let risk = 'low';
        if (cc > THRESHOLDS.cyclomaticComplexity.high || cog > THRESHOLDS.cognitiveComplexity.high) risk = 'critical';
        else if (cc > THRESHOLDS.cyclomaticComplexity.moderate || cog > THRESHOLDS.cognitiveComplexity.moderate) risk = 'high';
        else if (cc > THRESHOLDS.cyclomaticComplexity.low || cog > THRESHOLDS.cognitiveComplexity.low) risk = 'moderate';
        
        result.functionMetrics.push({
          name: fn.name,
          file: file.path,
          line: fn.line,
          lines: bodyLines,
          cyclomaticComplexity: cc,
          cognitiveComplexity: cog,
          maxNesting: nesting,
          parameters: params,
          risk
        });
      });
    });

    // === 2. Per-File Analysis ===
    files.forEach(file => {
      const content = file.content || '';
      const lineCount = content.split('\n').length;
      const fnCount = file.parsed.functions.length;
      const commentDensity = calculateCommentDensity(content);
      
      // File-level fan-out (efferent coupling)
      const fileId = 'f:' + file.path;
      const fanOut = edges.filter(e => {
        const s = typeof e.source === 'string' ? e.source : e.source.id;
        return s === fileId && e.type === 'imports';
      }).length;
      
      // File-level fan-in (afferent coupling)
      const fanIn = edges.filter(e => {
        const t = typeof e.target === 'string' ? e.target : e.target.id;
        return t === fileId && e.type === 'imports';
      }).length;
      
      // Instability (Robert C. Martin): I = Ce / (Ca + Ce)
      const instability = (fanIn + fanOut) > 0 ? fanOut / (fanIn + fanOut) : 0.5;
      
      // Per-file complexity aggregates
      const fileFns = result.functionMetrics.filter(f => f.file === file.path);
      const avgCC = fileFns.length > 0 ? fileFns.reduce((s, f) => s + f.cyclomaticComplexity, 0) / fileFns.length : 0;
      const maxCC = fileFns.length > 0 ? Math.max(...fileFns.map(f => f.cyclomaticComplexity)) : 0;
      
      let risk = 'low';
      if (lineCount > THRESHOLDS.linesPerFile.high || maxCC > THRESHOLDS.cyclomaticComplexity.high) risk = 'critical';
      else if (lineCount > THRESHOLDS.linesPerFile.moderate || maxCC > THRESHOLDS.cyclomaticComplexity.moderate) risk = 'high';
      else if (lineCount > THRESHOLDS.linesPerFile.low || maxCC > THRESHOLDS.cyclomaticComplexity.low) risk = 'moderate';
      
      result.fileMetrics.push({
        path: file.path,
        lines: lineCount,
        functions: fnCount,
        classes: file.parsed.classes.length,
        imports: file.parsed.imports.length,
        commentDensity,
        fanIn, fanOut,
        instability: Math.round(instability * 100) / 100,
        avgComplexity: Math.round(avgCC * 10) / 10,
        maxComplexity: maxCC,
        risk
      });
    });

    // === 3. Security Scan ===
    result.security = runSecurityScan(files);

    // === 4. Documentation Quality ===
    result.documentation = analyzeDocumentation(files);

    // === 5. Code Duplication ===
    result.duplication = detectDuplication(files);

    // === 6. Program-Level Halstead ===
    const allCode = files.map(f => f.content || '').join('\n');
    result.halstead = calculateHalstead(allCode);

    // === 7. Calculate Advanced Scores ===
    calculateAdvancedScores(result);

    return result;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  ADVANCED SCORING (12 Categories)  ███
     ═══════════════════════════════════════════════════════════════ */

  function calculateAdvancedScores(analysis) {
    const fm = analysis.functionMetrics;
    const fileMet = analysis.fileMetrics;
    const sec = analysis.security;
    const doc = analysis.documentation;
    const dup = analysis.duplication;

    // 1. Cyclomatic Complexity Score
    const avgCC = fm.length > 0 ? fm.reduce((s, f) => s + f.cyclomaticComplexity, 0) / fm.length : 0;
    const highCCCount = fm.filter(f => f.cyclomaticComplexity > THRESHOLDS.cyclomaticComplexity.low).length;
    const ccScore = Math.max(0, 100 - avgCC * 5 - highCCCount * 3);

    // 2. Cognitive Complexity Score
    const avgCog = fm.length > 0 ? fm.reduce((s, f) => s + f.cognitiveComplexity, 0) / fm.length : 0;
    const highCogCount = fm.filter(f => f.cognitiveComplexity > THRESHOLDS.cognitiveComplexity.low).length;
    const cogScore = Math.max(0, 100 - avgCog * 4 - highCogCount * 3);

    // 3. Maintainability Score (function size + params + nesting)
    const longFns = fm.filter(f => f.lines > THRESHOLDS.linesPerFunction.low).length;
    const tooManyParams = fm.filter(f => f.parameters > THRESHOLDS.paramsPerFunction.low).length;
    const deepNesting = fm.filter(f => f.maxNesting > THRESHOLDS.nestingDepth.low).length;
    const maintainScore = Math.max(0, 100 - longFns * 4 - tooManyParams * 5 - deepNesting * 5);

    // 4. Modularity Score (file size + functions per file)
    const largeFiles = fileMet.filter(f => f.lines > THRESHOLDS.linesPerFile.low).length;
    const bloatedFiles = fileMet.filter(f => f.functions > THRESHOLDS.functionsPerFile.low).length;
    const modScore = Math.max(0, 100 - largeFiles * 8 - bloatedFiles * 6);

    // 5. Coupling Score (fan-in/fan-out balance)
    const avgFanOut = fileMet.length > 0 ? fileMet.reduce((s, f) => s + f.fanOut, 0) / fileMet.length : 0;
    const highCoupling = fileMet.filter(f => f.fanOut > THRESHOLDS.fanOut.low).length;
    const couplingScore = Math.max(0, 100 - avgFanOut * 3 - highCoupling * 8);

    // 6. Instability Score (Robert C. Martin — distance from main sequence)
    const avgInstability = fileMet.length > 0 ? fileMet.reduce((s, f) => s + f.instability, 0) / fileMet.length : 0.5;
    const instabilityScore = Math.round(Math.max(0, 100 - Math.abs(avgInstability - 0.5) * 60));

    // 7. Security Score
    const criticalSec = sec.filter(s => s.severity === 'critical').length;
    const warningSec = sec.filter(s => s.severity === 'warning').length;
    const securityScore = Math.max(0, 100 - criticalSec * 20 - warningSec * 5);

    // 8. Documentation Score
    const docScore = doc.score;

    // 9. Duplication Score
    const dupScore = Math.max(0, 100 - dup.percentage * 5);

    // 10. SOLID Compliance (approximated)
    // SRP: functions per file, file size
    // OCP: use of classes/interfaces
    // LSP: inheritance depth (not measurable here)
    // ISP: parameter count (too many = violation)
    // DIP: ratio of abstract to concrete
    const srpViolations = fileMet.filter(f => f.functions > 20 || f.lines > 400).length;
    const ispViolations = fm.filter(f => f.parameters > 5).length;
    const solidScore = Math.max(0, 100 - srpViolations * 8 - ispViolations * 4);

    // 11. Code Health (composite of complexity metrics)
    const codeHealth = Math.round(ccScore * 0.3 + cogScore * 0.3 + maintainScore * 0.25 + modScore * 0.15);

    // 12. Technical Debt Ratio (SonarQube formula)
    // Estimated remediation time (minutes) vs development time
    const totalIssues = fm.filter(f => f.risk !== 'low').length + sec.length;
    const remediationMinutes = totalIssues * 15; // avg 15min per issue
    const devMinutes = fm.length * 30; // avg 30min per function
    const techDebtRatio = devMinutes > 0 ? Math.round((remediationMinutes / devMinutes) * 100) : 0;

    // === OVERALL GRADE (weighted composite) ===
    const overall = Math.round(
      ccScore * 0.12 +         // 12% - Cyclomatic Complexity
      cogScore * 0.12 +        // 12% - Cognitive Complexity
      maintainScore * 0.12 +   // 12% - Maintainability
      modScore * 0.10 +        // 10% - Modularity
      couplingScore * 0.10 +   // 10% - Coupling
      securityScore * 0.15 +   // 15% - Security
      docScore * 0.08 +        // 8%  - Documentation
      dupScore * 0.06 +        // 6%  - Duplication
      solidScore * 0.08 +      // 8%  - SOLID Compliance
      instabilityScore * 0.07  // 7%  - Architectural Stability
    );

    // Letter grade (SonarQube-style)
    let grade;
    if (overall >= 90) grade = 'A';
    else if (overall >= 80) grade = 'A-';
    else if (overall >= 70) grade = 'B+';
    else if (overall >= 60) grade = 'B';
    else if (overall >= 50) grade = 'C+';
    else if (overall >= 40) grade = 'C';
    else if (overall >= 30) grade = 'D';
    else grade = 'F';

    analysis.scores = {
      cyclomaticComplexity: Math.round(ccScore),
      cognitiveComplexity: Math.round(cogScore),
      maintainability: Math.round(maintainScore),
      modularity: Math.round(modScore),
      coupling: Math.round(couplingScore),
      instability: instabilityScore,
      security: Math.round(securityScore),
      documentation: docScore,
      duplication: Math.round(dupScore),
      solidCompliance: Math.round(solidScore),
      codeHealth,
      techDebtRatio,
      overall,
      grade
    };

    // Summary statistics
    analysis.summary = {
      totalFiles: fileMet.length,
      totalFunctions: fm.length,
      totalClasses: fileMet.reduce((s, f) => s + f.classes, 0),
      avgCyclomaticComplexity: Math.round(avgCC * 10) / 10,
      avgCognitiveComplexity: Math.round(avgCog * 10) / 10,
      avgLinesPerFunction: fm.length > 0 ? Math.round(fm.reduce((s, f) => s + f.lines, 0) / fm.length) : 0,
      avgLinesPerFile: fileMet.length > 0 ? Math.round(fileMet.reduce((s, f) => s + f.lines, 0) / fileMet.length) : 0,
      avgFanOut: Math.round(avgFanOut * 10) / 10,
      criticalFunctions: fm.filter(f => f.risk === 'critical').length,
      highRiskFunctions: fm.filter(f => f.risk === 'high').length,
      securityFindings: sec.length,
      securityCritical: criticalSec,
      techDebtRatio,
      halsteadBugs: analysis.halstead.bugs,
      duplicationPct: dup.percentage
    };
  }

  // Export for use by xray.js
  window.AdvancedXRay = {
    runAdvancedAnalysis,
    calculateCyclomaticComplexity,
    calculateCognitiveComplexity,
    calculateHalstead,
    THRESHOLDS,
    SECURITY_PATTERNS
  };

})();
