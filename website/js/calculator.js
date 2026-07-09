/* ═══════════════════════════════════════════════════════════════
   AI Mind Map — Token Savings Calculator
   Live Chart.js charts + animated cost breakdowns
   ═══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── Pricing table (per 1M tokens) ─────────────────────── */
  const PRICING = {
    gpt4:      30.00,
    claude:    15.00,
    gpt4omini: 0.15,
  };

  /* ── Formula constants ─────────────────────────────────── */
  const TOKENS_PER_LINE    = 3;
  const REREADS_PER_SESSION = 2.5;
  const MINDMAP_FACTOR     = 0.10; // 90% reduction

  /* ── DOM refs ───────────────────────────────────────────── */
  const sliderFiles    = document.getElementById('slider-files');
  const sliderLines    = document.getElementById('slider-lines');
  const sliderSessions = document.getElementById('slider-sessions');
  const selectModel    = document.getElementById('select-model');

  const valFiles    = document.getElementById('val-files');
  const valLines    = document.getElementById('val-lines');
  const valSessions = document.getElementById('val-sessions');

  const tokensWithout = document.getElementById('tokens-without');
  const tokensWith    = document.getElementById('tokens-with');
  const tokensSaved   = document.getElementById('tokens-saved');

  const costWithout  = document.getElementById('cost-without');
  const costWith     = document.getElementById('cost-with');
  const costDaily    = document.getElementById('cost-daily');
  const costMonthly  = document.getElementById('cost-monthly');
  const costYearly   = document.getElementById('cost-yearly');

  /* ── Chart.js setup ─────────────────────────────────────── */
  let barChart, pieChart;

  const chartFont = {
    family: "'Inter', sans-serif",
    weight: 500,
  };

  const initBarChart = () => {
    const ctx = document.getElementById('bar-chart').getContext('2d');
    barChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Without AI Mind Map', 'With AI Mind Map'],
        datasets: [{
          data: [0, 0],
          backgroundColor: [
            'rgba(253, 121, 168, 0.7)',
            'rgba(0, 184, 148, 0.7)',
          ],
          borderColor: [
            'rgba(253, 121, 168, 1)',
            'rgba(0, 184, 148, 1)',
          ],
          borderWidth: 2,
          borderRadius: 8,
          barPercentage: 0.6,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(18,19,31,0.95)',
            titleFont: chartFont,
            bodyFont: { ...chartFont, family: "'JetBrains Mono', monospace" },
            borderColor: 'rgba(108,92,231,0.3)',
            borderWidth: 1,
            padding: 12,
            callbacks: {
              label: ctx => formatNum(ctx.raw) + ' tokens/day',
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
            ticks: {
              color: 'rgba(139,139,163,0.7)',
              font: { ...chartFont, size: 11, family: "'JetBrains Mono', monospace" },
              callback: v => formatNum(v),
            },
          },
          y: {
            grid: { display: false },
            ticks: {
              color: '#f0f0f5',
              font: { ...chartFont, size: 12 },
            },
          },
        },
      },
    });
  };

  const initPieChart = () => {
    const ctx = document.getElementById('pie-chart').getContext('2d');
    pieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Saved', 'Remaining'],
        datasets: [{
          data: [90, 10],
          backgroundColor: [
            'rgba(0, 184, 148, 0.75)',
            'rgba(55, 56, 77, 0.5)',
          ],
          borderColor: [
            'rgba(0, 184, 148, 1)',
            'rgba(55, 56, 77, 0.3)',
          ],
          borderWidth: 2,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '65%',
        animation: { duration: 600, easing: 'easeOutQuart' },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#8b8ba3',
              font: { ...chartFont, size: 12 },
              padding: 16,
              usePointStyle: true,
              pointStyleWidth: 10,
            },
          },
          tooltip: {
            backgroundColor: 'rgba(18,19,31,0.95)',
            bodyFont: chartFont,
            borderColor: 'rgba(108,92,231,0.3)',
            borderWidth: 1,
            callbacks: {
              label: ctx => ctx.label + ': ' + ctx.raw + '%',
            },
          },
        },
      },
    });
  };

  /* ── Calculation ────────────────────────────────────────── */
  const calculate = () => {
    const files    = parseInt(sliderFiles.value);
    const lines    = parseInt(sliderLines.value);
    const sessions = parseInt(sliderSessions.value);
    const model    = selectModel.value;
    const price    = PRICING[model]; // $/1M tokens

    // Token math
    const without = files * lines * TOKENS_PER_LINE * sessions * REREADS_PER_SESSION;
    const withMM  = files * lines * TOKENS_PER_LINE * sessions * MINDMAP_FACTOR;
    const saved   = without - withMM;
    const pctSaved = Math.round((saved / without) * 100);

    // Cost math
    const costWithoutVal = (without / 1_000_000) * price;
    const costWithVal    = (withMM / 1_000_000) * price;
    const costSavedDay   = costWithoutVal - costWithVal;
    const costSavedMonth = costSavedDay * 30;
    const costSavedYear  = costSavedDay * 365;

    // Update slider labels
    valFiles.textContent    = formatNum(files);
    valLines.textContent    = formatNum(lines);
    valSessions.textContent = sessions;

    // Update bar chart
    barChart.data.datasets[0].data = [without, withMM];
    barChart.update('none');

    // Update pie chart
    pieChart.data.datasets[0].data = [pctSaved, 100 - pctSaved];
    pieChart.update('none');

    // Update text displays
    tokensWithout.textContent = formatNum(Math.round(without)) + ' tokens/day';
    tokensWith.textContent    = formatNum(Math.round(withMM)) + ' tokens/day';
    tokensSaved.textContent   = formatNum(Math.round(saved)) + ' tokens/day (' + pctSaved + '%)';

    costWithout.textContent = '$' + costWithoutVal.toFixed(2);
    costWith.textContent    = '$' + costWithVal.toFixed(2);
    costDaily.textContent   = '$' + costSavedDay.toFixed(2);
    costMonthly.textContent = '$' + costSavedMonth.toFixed(2);
    costYearly.textContent  = '$' + costSavedYear.toFixed(2);
  };

  /* ── Helpers ────────────────────────────────────────────── */
  function formatNum(n) {
    if (typeof n !== 'number') n = parseFloat(n);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    return Math.round(n).toLocaleString();
  }

  /* ── Debounce ───────────────────────────────────────────── */
  let debounceTimer;
  const debouncedCalc = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(calculate, 100);
  };

  /* ── Event binding ──────────────────────────────────────── */
  const inputs = [sliderFiles, sliderLines, sliderSessions, selectModel];
  inputs.forEach(el => {
    if (el) el.addEventListener('input', debouncedCalc);
  });

  /* ── Init ───────────────────────────────────────────────── */
  const boot = () => {
    initBarChart();
    initPieChart();
    calculate();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    // Chart.js might still be loading from CDN
    if (typeof Chart !== 'undefined') {
      boot();
    } else {
      window.addEventListener('load', boot);
    }
  }
})();
