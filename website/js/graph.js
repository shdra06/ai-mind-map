/* ============================================================
   AI Mind Map — Elite D3.js Knowledge Graph  (v2)
   Explorer Page — Real codebase data
   ============================================================ */

(function () {
  'use strict';

  const TYPE_COLORS = {
    class:'#00b894', method:'#6c5ce7', function:'#00cec9',
    interface:'#fd79a8', enum:'#fdcb6e', constructor:'#a29bfe',
    property:'#74b9ff', hook:'#ff7675', component:'#55efc4',
    route:'#e17055', test:'#636e72', constant:'#b2bec3',
    type_alias:'#dfe6e9', namespace:'#81ecec', decorator:'#fab1a0',
  };
  const DEFAULT_COLOR = '#8b8ba3';

  const EDGE_STYLES = {
    calls:      { stroke:'#6c5ce7', strokeWidth:1.5, dash:'none' },
    imports:    { stroke:'#00cec9', strokeWidth:1,   dash:'none' },
    uses:       { stroke:'#fdcb6e', strokeWidth:1,   dash:'4,4'  },
    contains:   { stroke:'#5a5a72', strokeWidth:0.8, dash:'none' },
    inherits:   { stroke:'#00b894', strokeWidth:2,   dash:'none' },
    implements: { stroke:'#fd79a8', strokeWidth:1.5, dash:'none' },
  };
  const DEFAULT_EDGE = { stroke:'#5a5a72', strokeWidth:1, dash:'none' };

  function getNodeRadius(node) {
    return Math.max(8, Math.min(24, 8 + Math.sqrt(node.degree || 1) * 2));
  }

  let graphData = { nodes:[], edges:[] };
  let simulation = null;
  let svg, g, linkGroup, nodeGroup, labelGroup, hotspotGroup;
  let activeFilters = new Set(Object.keys(TYPE_COLORS));
  let selectedNode = null;
  let currentLayout = 'force';
  let width, height;
  let hotspotNodeIds = new Set();

  async function init() {
    try {
      const res = await fetch('data/graph-demo.json');
      graphData = await res.json();
    } catch(e) { console.error('Failed to load graph data:', e); return; }

    const realTypes = new Set(graphData.nodes.map(n => n.type));
    activeFilters = new Set([...realTypes]);

    const sorted = [...graphData.nodes].sort((a,b) => (b.degree||0)-(a.degree||0));
    hotspotNodeIds = new Set(sorted.slice(0,5).map(n => n.id));

    setupSVG();
    addRealDataBanner();
    createArrowMarkers();
    drawGraph();
    setupSimulation();
    bindControls();
    updateStats();
    buildLegend();
  }

  function setupSVG() {
    const container = document.getElementById('graph-canvas');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    width = rect.width || 900;
    height = rect.height || 600;

    svg = d3.select('#graph-canvas').append('svg')
      .attr('width','100%').attr('height','100%')
      .attr('viewBox',[0,0,width,height]);

    svg.append('rect').attr('width',width).attr('height',height).attr('fill','#F0EBE3');

    const defs = svg.append('defs');
    defs.append('pattern').attr('id','dot-grid').attr('width',24).attr('height',24)
      .attr('patternUnits','userSpaceOnUse')
      .append('circle').attr('cx',1).attr('cy',1).attr('r',0.7)
      .attr('fill','rgba(26,22,18,0.06)');

    svg.append('rect').attr('width',width).attr('height',height).attr('fill','url(#dot-grid)');

    const zoom = d3.zoom().scaleExtent([0.1,6])
      .on('zoom', event => g.attr('transform', event.transform));
    svg.call(zoom);
    svg.__zoom = zoom;

    g = svg.append('g').attr('class','graph-group');
    linkGroup    = g.append('g').attr('class','links');
    hotspotGroup = g.append('g').attr('class','hotspots');
    nodeGroup    = g.append('g').attr('class','nodes');
    labelGroup   = g.append('g').attr('class','labels');

    window.addEventListener('resize', () => {
      const r = container.getBoundingClientRect();
      width = r.width; height = r.height;
      svg.attr('viewBox',[0,0,width,height]);
      if (simulation) simulation.force('center',d3.forceCenter(width/2,height/2)).alpha(0.3).restart();
    });
  }

  function addRealDataBanner() {
    const canvas = document.getElementById('graph-canvas');
    if (!canvas || document.getElementById('real-data-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'real-data-badge';
    badge.style.cssText = 'position:absolute;top:10px;right:10px;z-index:10;padding:0.4rem 0.9rem;background:rgba(0,184,148,0.1);border:1px solid rgba(0,184,148,0.25);border-radius:99px;font-size:0.75rem;color:#1A7F37;font-family:JetBrains Mono,monospace;display:flex;align-items:center;gap:0.5rem;pointer-events:none;';
    badge.innerHTML = '<span style="width:6px;height:6px;background:#34d399;border-radius:50%;box-shadow:0 0 6px #34d399;display:inline-block;"></span>Real ai-mind-map codebase &middot; 120 nodes &middot; 300 edges';
    canvas.style.position = 'relative';
    canvas.appendChild(badge);
  }


  function createArrowMarkers() {
    const defs = svg.select('defs');
    const allTypes = [...Object.keys(EDGE_STYLES), 'default'];
    allTypes.forEach(type => {
      const style = EDGE_STYLES[type] || DEFAULT_EDGE;
      defs.append('marker')
        .attr('id',`arrow-${type}`).attr('viewBox','0 -5 10 10')
        .attr('refX',30).attr('refY',0)
        .attr('markerWidth',5).attr('markerHeight',5)
        .attr('orient','auto')
        .append('path').attr('d','M0,-5L10,0L0,5')
        .attr('fill',style.stroke).attr('opacity',0.7);
    });
  }

  function drawGraph() {
    const visibleNodes   = getVisibleNodes();
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    const visibleEdges   = graphData.edges.filter(e =>
      visibleNodeIds.has(e.source.id||e.source) && visibleNodeIds.has(e.target.id||e.target)
    );

    const links = linkGroup.selectAll('.link').data(visibleEdges,
      d => `${d.source.id||d.source}-${d.target.id||d.target}-${d.type}`);
    links.exit().transition().duration(300).attr('opacity',0).remove();
    links.enter().append('line').attr('class','link')
      .attr('stroke',           d => (EDGE_STYLES[d.type]||DEFAULT_EDGE).stroke)
      .attr('stroke-width',     d => (EDGE_STYLES[d.type]||DEFAULT_EDGE).strokeWidth)
      .attr('stroke-opacity',   0.35)
      .attr('stroke-dasharray', d => (EDGE_STYLES[d.type]||DEFAULT_EDGE).dash)
      .attr('marker-end',       d => `url(#arrow-${EDGE_STYLES[d.type]?d.type:'default'})`);

    const hotspots = hotspotGroup.selectAll('.hotspot-ring')
      .data(visibleNodes.filter(n => hotspotNodeIds.has(n.id)), d => d.id);
    hotspots.exit().remove();
    hotspots.enter().append('circle').attr('class','hotspot-ring')
      .attr('r',d => getNodeRadius(d)+6).attr('fill','none')
      .attr('stroke','#fd79a8').attr('stroke-width',1.5)
      .attr('stroke-opacity',0).each(function() {
        let op=0, dir=1;
        const el = d3.select(this);
        const tick = () => {
          op += dir*0.025; if(op>=0.7)dir=-1; if(op<=0)dir=1;
          el.attr('stroke-opacity',op);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

    const nodes = nodeGroup.selectAll('.node').data(visibleNodes, d => d.id);
    nodes.exit().transition().duration(300).attr('r',0).remove();
    nodes.enter().append('circle').attr('class','node')
      .attr('r',0)
      .attr('fill',  d => TYPE_COLORS[d.type]||DEFAULT_COLOR)
      .attr('stroke',d => TYPE_COLORS[d.type]||DEFAULT_COLOR)
      .attr('stroke-width',2).attr('stroke-opacity',0.4)
      .attr('cursor','pointer')
      .call(drag())
      .on('click',      (event,d) => { event.stopPropagation(); selectNode(d); })
      .on('mouseenter', (event,d) => hoverNode(d,true))
      .on('mouseleave', (event,d) => hoverNode(d,false))
      .transition().duration(500).ease(d3.easeCubicOut)
      .attr('r', d => getNodeRadius(d));

    const labels = labelGroup.selectAll('.label').data(visibleNodes, d => d.id);
    labels.exit().transition().duration(300).attr('opacity',0).remove();
    labels.enter().append('text').attr('class','label')
      .attr('text-anchor','middle')
      .attr('dy',      d => getNodeRadius(d)+13)
      .attr('fill',    '#1A1614')
      .attr('font-size',    d => d.type==='class'||d.type==='component'?'10px':'8px')
      .attr('font-family',  "'Inter',sans-serif")
      .attr('font-weight',  d => d.type==='class'?'600':'400')
      .attr('pointer-events','none')
      .attr('opacity',0)
      .text(d => { const p=d.async?'⚡':''; const n=d.name.length>16?d.name.slice(0,14)+'…':d.name; return p+n; })
      .transition().delay(300).duration(400).attr('opacity',0.85);
  }

  function setupSimulation() {
    const visibleNodes   = getVisibleNodes();
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    const visibleEdges   = graphData.edges.filter(e =>
      visibleNodeIds.has(e.source.id||e.source) && visibleNodeIds.has(e.target.id||e.target)
    );
    simulation = d3.forceSimulation(visibleNodes)
      .force('link', d3.forceLink(visibleEdges).id(d=>d.id)
        .distance(d => d.type==='contains'?40:d.type==='inherits'?80:100)
        .strength(0.3))
      .force('charge', d3.forceManyBody().strength(d => -200-(d.degree||0)*5))
      .force('center',  d3.forceCenter(width/2,height/2))
      .force('collide', d3.forceCollide(d => getNodeRadius(d)+12))
      .alphaDecay(0.02).velocityDecay(0.4)
      .on('tick', ticked);
  }

  function ticked() {
    linkGroup.selectAll('.link')
      .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    hotspotGroup.selectAll('.hotspot-ring')
      .attr('cx',d=>d.x).attr('cy',d=>d.y);
    nodeGroup.selectAll('.node')
      .attr('cx',d=>d.x).attr('cy',d=>d.y);
    labelGroup.selectAll('.label')
      .attr('x',d=>d.x).attr('y',d=>d.y);
  }

  function drag() {
    return d3.drag()
      .on('start',(event,d)=>{ if(!event.active)simulation.alphaTarget(0.3).restart(); d.fx=d.x;d.fy=d.y; })
      .on('drag', (event,d)=>{ d.fx=event.x;d.fy=event.y; })
      .on('end',  (event,d)=>{ if(!event.active)simulation.alphaTarget(0); d.fx=null;d.fy=null; });
  }


  function selectNode(d) {
    selectedNode = d;
    nodeGroup.selectAll('.node').transition().duration(600)
      .attr('opacity',0.1).attr('stroke-width',2);
    linkGroup.selectAll('.link').transition().duration(600).attr('stroke-opacity',0.04);
    labelGroup.selectAll('.label').transition().duration(600).attr('opacity',0.08);
    hotspotGroup.selectAll('.hotspot-ring').transition().duration(600).attr('opacity',0.1);

    const connectedIds = new Set([d.id]);
    graphData.edges.forEach(e => {
      const sid=e.source.id||e.source, tid=e.target.id||e.target;
      if(sid===d.id)connectedIds.add(tid);
      if(tid===d.id)connectedIds.add(sid);
    });
    nodeGroup.selectAll('.node').filter(n=>connectedIds.has(n.id))
      .transition().duration(600).attr('opacity',1).attr('stroke-width',n=>n.id===d.id?4:2);
    linkGroup.selectAll('.link').filter(e=>{
      const sid=e.source.id||e.source,tid=e.target.id||e.target;
      return sid===d.id||tid===d.id;
    }).transition().duration(600).attr('stroke-opacity',0.75).attr('stroke-width',2.5);
    labelGroup.selectAll('.label').filter(n=>connectedIds.has(n.id))
      .transition().duration(600).attr('opacity',1);
    showNodeDetails(d);
  }

  function clearSelection() {
    selectedNode=null;
    nodeGroup.selectAll('.node').transition().duration(400).attr('opacity',1).attr('stroke-width',2);
    linkGroup.selectAll('.link').transition().duration(400)
      .attr('stroke-opacity',0.35)
      .attr('stroke-width',d=>(EDGE_STYLES[d.type]||DEFAULT_EDGE).strokeWidth);
    labelGroup.selectAll('.label').transition().duration(400).attr('opacity',0.85);
    hotspotGroup.selectAll('.hotspot-ring').transition().duration(400).attr('opacity',1);
    hideNodeDetails();
  }

  function hoverNode(d, isHover) {
    const node = nodeGroup.selectAll('.node').filter(n=>n.id===d.id);
    if(isHover){
      node.transition().duration(150)
        .attr('r',getNodeRadius(d)+5).attr('stroke-width',4).attr('stroke-opacity',0.9)
        .attr('filter',`drop-shadow(0 0 8px ${TYPE_COLORS[d.type]||DEFAULT_COLOR})`);
      showTooltip(d);
    } else {
      node.transition().duration(200)
        .attr('r',getNodeRadius(d))
        .attr('stroke-width',selectedNode&&selectedNode.id===d.id?4:2)
        .attr('stroke-opacity',0.4).attr('filter','none');
      hideTooltip();
    }
  }

  function showTooltip(d) {
    let tt = document.getElementById('graph-tooltip');
    if(!tt){
      tt = document.createElement('div');
      tt.id='graph-tooltip';
      tt.style.cssText='position:absolute;pointer-events:none;z-index:20;background:rgba(255,255,255,0.97);border:1px solid rgba(26,22,18,0.15);border-radius:10px;padding:0.75rem 1rem;font-size:0.82rem;min-width:180px;backdrop-filter:blur(12px);display:none;box-shadow:0 8px 32px rgba(26,22,18,0.12);';
      document.getElementById('graph-canvas').appendChild(tt);
    }
    const color=TYPE_COLORS[d.type]||DEFAULT_COLOR;
    const basename=(d.file||'').split(/[\\/]/).pop();
    const visIcon=d.visibility==='private'?'🔒':'🌐';
    const asyncBadge=d.async?'<span style="background:rgba(232,97,26,0.1);color:#E8611A;padding:0.1rem 0.35rem;border-radius:4px;font-size:0.7rem;">⚡async</span>':'';
    tt.innerHTML=`<div style="font-weight:700;color:#1A1614;margin-bottom:0.35rem;">${d.async?'⚡ ':''}${d.name}</div><div style="display:inline-block;background:${color}22;color:${color};border:1px solid ${color}44;border-radius:4px;padding:0.1rem 0.4rem;font-size:0.7rem;font-family:'JetBrains Mono',monospace;margin-bottom:0.35rem;">${d.type}</div>${asyncBadge}<div style="color:#5C5248;font-size:0.75rem;margin-top:0.3rem;">${visIcon} ${basename||'unknown'}</div><div style="color:#8C8278;font-size:0.72rem;margin-top:0.2rem;">degree: ${d.degree||0}</div>`;
    tt.style.display='block';
    document.getElementById('graph-canvas').addEventListener('mousemove',positionTooltip);
  }
  function positionTooltip(e) {
    const tt=document.getElementById('graph-tooltip');
    if(!tt)return;
    const rect=e.currentTarget.getBoundingClientRect();
    let left=e.clientX-rect.left+16, top=e.clientY-rect.top-10;
    if(left+200>rect.width) left=e.clientX-rect.left-216;
    if(top+100>rect.height) top=e.clientY-rect.top-110;
    tt.style.left=left+'px'; tt.style.top=top+'px';
  }
  function hideTooltip() {
    const tt=document.getElementById('graph-tooltip');
    if(tt)tt.style.display='none';
    const c=document.getElementById('graph-canvas');
    if(c)c.removeEventListener('mousemove',positionTooltip);
  }


  function showNodeDetails(d) {
    const panel = document.getElementById('node-details');
    if(!panel)return;
    const color=TYPE_COLORS[d.type]||DEFAULT_COLOR;
    const basename=(d.file||'').split(/[\\/]/).pop();
    const lineRange=d.line?`${d.line}${d.endLine?'-'+d.endLine:''}`:'?';
    const visIcon=d.visibility==='private'?'🔒 private':d.visibility==='public'?'🌐 public':'🌐';
    const callers=[], callees=[];
    graphData.edges.forEach(e=>{
      const sid=e.source.id||e.source, tid=e.target.id||e.target;
      if(tid===d.id){const src=graphData.nodes.find(n=>n.id===sid);if(src)callers.push({node:src,type:e.type});}
      if(sid===d.id){const tgt=graphData.nodes.find(n=>n.id===tid);if(tgt)callees.push({node:tgt,type:e.type});}
    });
    const bs='display:inline-block;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.72rem;font-family:JetBrains Mono,monospace;margin-right:0.4rem;';
    const asyncB=d.async?`<span style="${bs}background:rgba(108,92,231,0.2);color:#a78bfa;border:1px solid rgba(108,92,231,0.3);">⚡ async</span>`:'';
    const statB=d.static?`<span style="${bs}background:rgba(0,206,201,0.12);color:#00cec9;border:1px solid rgba(0,206,201,0.25);">🔒 static</span>`:'';
    const expB=d.exported?`<span style="${bs}background:rgba(0,184,148,0.12);color:#34d399;border:1px solid rgba(0,184,148,0.25);">📤 exported</span>`:'';
    function nodeLink(n,et){
      const c=TYPE_COLORS[n.type]||DEFAULT_COLOR;
      return `<li style="padding:0.3rem 0;border-bottom:1px solid rgba(26,22,18,0.08);display:flex;justify-content:space-between;align-items:center;"><a href="#" onclick="window.__graphSelectNode('${n.id}');return false;" style="color:${c};font-family:'JetBrains Mono',monospace;font-size:0.8rem;">${n.name}</a><span style="color:#8C8278;font-size:0.72rem;">${et}</span></li>`;
    }
    panel.innerHTML=`
      <div style="margin-bottom:1rem;">
        <div style="font-size:1.3rem;font-weight:700;background:linear-gradient(135deg,#1A1614,#E8611A);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;word-break:break-word;">${d.async?'⚡ ':''}${d.name}</div>
        ${d.qualifiedName&&d.qualifiedName!==d.name?`<div style="color:#8C8278;font-size:0.75rem;font-family:'JetBrains Mono',monospace;margin-top:0.25rem;word-break:break-all;">${d.qualifiedName}</div>`:''}
        <div style="margin-top:0.6rem;"><span style="display:inline-block;background:${color}22;color:${color};border:1px solid ${color}55;border-radius:5px;padding:0.2rem 0.6rem;font-size:0.75rem;font-family:'JetBrains Mono',monospace;">${d.type}</span></div>
      </div>
      <div style="display:grid;gap:0.4rem;margin-bottom:1rem;">
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:0.3rem 0;border-bottom:1px solid rgba(26,22,18,0.08);"><span style="color:#8C8278;">File</span><span style="color:#E8611A;font-family:'JetBrains Mono',monospace;font-size:0.72rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${d.file||''}">${basename||'?'}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:0.3rem 0;border-bottom:1px solid rgba(26,22,18,0.08);"><span style="color:#8C8278;">Lines</span><span style="color:#5C5248;font-family:'JetBrains Mono',monospace;font-size:0.72rem;">${lineRange}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:0.3rem 0;border-bottom:1px solid rgba(26,22,18,0.08);"><span style="color:#8C8278;">Visibility</span><span style="color:#5C5248;font-size:0.72rem;">${visIcon}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:0.3rem 0;border-bottom:1px solid rgba(26,22,18,0.08);"><span style="color:#8C8278;">Connections</span><span style="color:#1A7F37;font-family:'JetBrains Mono',monospace;font-weight:700;">${d.degree||0}</span></div>
        ${d.language?`<div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:0.3rem 0;"><span style="color:#8C8278;">Language</span><span style="color:#5C5248;font-size:0.72rem;">${d.language}</span></div>`:''}
      </div>
      ${d.signature?`<div style="margin-bottom:1rem;"><div style="color:#8C8278;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.4rem;">Signature</div><div style="background:rgba(26,22,18,0.07);border:1px solid rgba(232,97,26,0.15);border-radius:6px;padding:0.6rem 0.8rem;font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:#C44D0F;word-break:break-all;line-height:1.6;">${escapeHtml(d.signature)}</div></div>`:''}
      ${d.doc?`<div style="margin-bottom:1rem;"><div style="color:#8C8278;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.4rem;">Doc</div><div style="color:#5C5248;font-style:italic;font-size:0.8rem;line-height:1.6;">${escapeHtml(d.doc.slice(0,200))}${d.doc.length>200?'…':''}</div></div>`:''}
      <div style="margin-bottom:1rem;">${asyncB}${statB}${expB}</div>
      ${callers.length?`<div style="margin-bottom:1rem;"><div style="color:#8C8278;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.4rem;">Called by <span style="color:#E8611A;">${callers.length}</span></div><ul style="list-style:none;max-height:120px;overflow-y:auto;">${callers.slice(0,8).map(c=>nodeLink(c.node,c.type)).join('')}${callers.length>8?`<li style="color:#8C8278;font-size:0.72rem;padding:0.3rem 0;">+${callers.length-8} more…</li>`:''}</ul></div>`:''}
      ${callees.length?`<div style="margin-bottom:1rem;"><div style="color:#8C8278;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.4rem;">Calls <span style="color:#E8611A;">${callees.length}</span></div><ul style="list-style:none;max-height:120px;overflow-y:auto;">${callees.slice(0,8).map(c=>nodeLink(c.node,c.type)).join('')}${callees.length>8?`<li style="color:#8C8278;font-size:0.72rem;padding:0.3rem 0;">+${callees.length-8} more…</li>`:''}</ul></div>`:''}
    `;
    panel.classList.add('visible');
  }

  function hideNodeDetails() {
    const panel=document.getElementById('node-details');
    if(panel)panel.classList.remove('visible');
  }


  function handleSearch(query) {
    if(!query||!query.trim()){clearSearch();return;}
    const q=query.toLowerCase();
    nodeGroup.selectAll('.node').transition().duration(200)
      .attr('opacity',d=>matchesSearch(d,q)?1:0.06)
      .attr('r',d=>matchesSearch(d,q)?getNodeRadius(d)+3:getNodeRadius(d)-2);
    labelGroup.selectAll('.label').transition().duration(200)
      .attr('opacity',d=>matchesSearch(d,q)?1:0.04);
    linkGroup.selectAll('.link').transition().duration(200).attr('stroke-opacity',0.04);
  }
  function matchesSearch(d,q){
    const bn=(d.file||'').split(/[\\/]/).pop().toLowerCase();
    return d.name.toLowerCase().includes(q)||(d.qualifiedName||'').toLowerCase().includes(q)||bn.includes(q)||d.type.toLowerCase().includes(q);
  }
  function clearSearch(){
    if(selectedNode){selectNode(selectedNode);return;}
    nodeGroup.selectAll('.node').transition().duration(300).attr('opacity',1).attr('r',d=>getNodeRadius(d));
    labelGroup.selectAll('.label').transition().duration(300).attr('opacity',0.85);
    linkGroup.selectAll('.link').transition().duration(300).attr('stroke-opacity',0.35);
  }

  function filterByType(){
    linkGroup.selectAll('.link').remove();
    hotspotGroup.selectAll('.hotspot-ring').remove();
    nodeGroup.selectAll('.node').remove();
    labelGroup.selectAll('.label').remove();
    graphData.nodes.forEach(n=>{
      if(!activeFilters.has(n.type))return;
      if(n.x===undefined){n.x=width/2+(Math.random()-0.5)*300;n.y=height/2+(Math.random()-0.5)*300;}
    });
    drawGraph();
    if(simulation)simulation.stop();
    setupSimulation();
    updateStats();
  }

  function switchLayout(layout){
    currentLayout=layout;
    if(!simulation)return;
    simulation.stop();
    if(layout==='force'){
      graphData.nodes.forEach(n=>{n.fx=null;n.fy=null;});
      setupSimulation();
    } else if(layout==='radial'){
      const vn=getVisibleNodes();
      const cx=width/2,cy=height/2,radius=Math.min(width,height)*0.35;
      const groups={};
      vn.forEach(n=>{(groups[n.type]=groups[n.type]||[]).push(n);});
      const tkeys=Object.keys(groups);
      tkeys.forEach((type,gi)=>{
        const ao=(2*Math.PI*gi)/tkeys.length;
        groups[type].forEach((n,ni)=>{
          const angle=ao+(2*Math.PI*ni)/(groups[type].length*tkeys.length);
          const r=radius*(0.6+0.4*(ni/groups[type].length));
          n.fx=cx+Math.cos(angle)*r; n.fy=cy+Math.sin(angle)*r;
        });
      });
      const ids=new Set(vn.map(n=>n.id));
      simulation=d3.forceSimulation(vn)
        .force('link',d3.forceLink(graphData.edges.filter(e=>ids.has(e.source.id||e.source)&&ids.has(e.target.id||e.target))).id(d=>d.id).distance(80).strength(0.1))
        .on('tick',ticked);
      setTimeout(()=>{vn.forEach(n=>{n.fx=null;n.fy=null;});},2200);
    } else if(layout==='tree'){
      const vn=getVisibleNodes();
      const typeOrder=['component','class','method','function','interface','enum','constructor','property','hook','test','constant'];
      const levels={};
      vn.forEach(n=>{const l=typeOrder.indexOf(n.type);const level=l>=0?l:4;(levels[level]=levels[level]||[]).push(n);});
      Object.keys(levels).forEach(level=>{
        const ns=levels[level];
        const y=80+parseInt(level)*(height-160)/(Object.keys(levels).length);
        ns.forEach((n,i)=>{n.fx=(width*(i+1))/(ns.length+1);n.fy=y;});
      });
      const ids=new Set(vn.map(n=>n.id));
      simulation=d3.forceSimulation(vn)
        .force('link',d3.forceLink(graphData.edges.filter(e=>ids.has(e.source.id||e.source)&&ids.has(e.target.id||e.target))).id(d=>d.id).strength(0.05))
        .on('tick',ticked);
      setTimeout(()=>{vn.forEach(n=>{n.fx=null;n.fy=null;});},2800);
    }
  }

  function highlightMostConnected(){
    const sorted=[...graphData.nodes].filter(n=>activeFilters.has(n.type))
      .sort((a,b)=>(b.degree||0)-(a.degree||0)).slice(0,20);
    const topIds=new Set(sorted.map(n=>n.id));
    nodeGroup.selectAll('.node').transition().duration(600)
      .attr('opacity',d=>topIds.has(d.id)?1:0.07)
      .attr('stroke-width',d=>topIds.has(d.id)?3.5:2);
    labelGroup.selectAll('.label').transition().duration(600)
      .attr('opacity',d=>topIds.has(d.id)?1:0.05);
    linkGroup.selectAll('.link').transition().duration(600).attr('stroke-opacity',0.05);
  }

  function buildLegend(){
    const container=document.getElementById('graph-legend');
    if(!container)return;
    const realTypes=[...new Set(graphData.nodes.map(n=>n.type))].sort();
    container.innerHTML=realTypes.map(type=>`
      <label style="display:flex;align-items:center;gap:0.45rem;cursor:pointer;font-size:0.78rem;color:#8b8ba3;padding:0.2rem 0;">
        <input type="checkbox" class="filter-checkbox" data-type="${type}" checked
               style="accent-color:${TYPE_COLORS[type]||DEFAULT_COLOR};width:13px;height:13px;">
        <span style="width:8px;height:8px;background:${TYPE_COLORS[type]||DEFAULT_COLOR};border-radius:50%;flex-shrink:0;"></span>
        ${type}
      </label>`).join('');
    bindCheckboxes();
  }
  function bindCheckboxes(){
    document.querySelectorAll('.filter-checkbox').forEach(cb=>{
      cb.addEventListener('change',e=>{
        const type=e.target.dataset.type;
        e.target.checked?activeFilters.add(type):activeFilters.delete(type);
        filterByType();
      });
    });
  }

  function updateStats(){
    const vn=getVisibleNodes();
    const vids=new Set(vn.map(n=>n.id));
    const ve=graphData.edges.filter(e=>vids.has(e.source.id||e.source)&&vids.has(e.target.id||e.target));
    const el=document.getElementById('graph-stats');
    if(el)el.textContent=`${vn.length} nodes · ${ve.length} edges`;
  }
  function getVisibleNodes(){return graphData.nodes.filter(n=>activeFilters.has(n.type));}
  function escapeHtml(str){
    if(!str)return'';
    const d=document.createElement('div');d.textContent=str;return d.innerHTML;
  }

  function bindControls(){
    const si=document.getElementById('graph-search');
    if(si){
      let timer;
      si.addEventListener('input',e=>{clearTimeout(timer);timer=setTimeout(()=>handleSearch(e.target.value),200);});
      si.addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';clearSearch();}});
    }
    document.querySelectorAll('input[name="layout"]').forEach(r=>{
      r.addEventListener('change',e=>switchLayout(e.target.value));
    });
    const zs=document.getElementById('zoom-slider');
    if(zs)zs.addEventListener('input',e=>svg.transition().duration(300).call(svg.__zoom.scaleTo,parseFloat(e.target.value)));
    const rb=document.getElementById('reset-zoom');
    if(rb)rb.addEventListener('click',()=>{svg.transition().duration(500).call(svg.__zoom.transform,d3.zoomIdentity);if(zs)zs.value=1;});
    const fs=document.getElementById('fullscreen-toggle');
    if(fs)fs.addEventListener('click',()=>{
      const el=document.getElementById('graph-canvas');
      !document.fullscreenElement?el.requestFullscreen().catch(()=>{}):document.exitFullscreen();
    });
    const mc=document.getElementById('most-connected-btn');
    if(mc)mc.addEventListener('click',highlightMostConnected);
    svg.on('click',event=>{
      if(event.target.tagName==='rect'||event.target.tagName==='svg')clearSelection();
    });
    window.__graphSelectNode=id=>{
      const node=graphData.nodes.find(n=>n.id===id);
      if(node)selectNode(node);
    };
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  } else { init(); }

  document.addEventListener('DOMContentLoaded',()=>{
    const toggle=document.querySelector('.nav-toggle')||document.getElementById('hamburger');
    const menu=document.querySelector('.nav-links')||document.getElementById('mobileNav');
    if(toggle&&menu)toggle.addEventListener('click',()=>menu.classList.toggle('open'));
  });

})();

