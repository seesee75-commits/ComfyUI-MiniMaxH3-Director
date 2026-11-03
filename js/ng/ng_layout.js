// Nodes saved at an older, smaller size (the compact Director, the former Context nodes) grow to their full card once on
// load. What lies right of or below a grown node moves along, so nothing overlaps; nodes in one column move only once,
// and a group around a grown node grows with it.
const pending = new Map(); // node -> its saved [width, height]

export function noteGrowth(node, before) { pending.set(node, before); }

// Cards, the Studio and the Storyboard are as tall as their content, and the user can drag them taller (user 2026-10-19:
// "the preview should grow when I make the node bigger"). When a drag stops, the height it left beyond the content goes to
// the node's growing part (a preview, the waveform, the canvas, the timeline) through `setGrow(px)`, which is kept in
// node.properties.ng_grow. Below the content's own height the node snaps back to it. The node reports its content without
// the grown part as its minimum (computeSize), so ComfyUI lets it be dragged smaller again; `fit` sizes it to minimum + grow.
// Waiting for the drag to end keeps the growth from fighting the pointer.
// Only the user's drag counts: ComfyUI marks it with resizing_node or the pointer's resize direction (frontend 1.55, measured
// 2026-10-19); a node sized by code (placing it, loading an image) is no drag. Without ComfyUI's canvas (tests) all count.
export function draggedByUser(node) {
  const canvas = globalThis.comfyAPI?.app?.app?.canvas;
  return !canvas || canvas.resizing_node === node || Boolean(canvas.pointer?.resizeDirection);
}

export function followDraggedHeight(node, setGrow, fit) {
  let settling = 0, target = 0;
  setGrow(node.properties.ng_grow || 0);
  const resized = node.onResize;
  node.onResize = function (...args) {
    const result = resized?.apply(this, args);
    // the node's own fit is no drag either
    if (!draggedByUser(node)) return result;
    if (Math.abs(node.size[1] - ((node.computeSize?.()[1] ?? node.size[1]) + (node.properties.ng_grow || 0))) < 3) return result;
    target = node.size[1];
    clearTimeout(settling);
    settling = setTimeout(adopt, 200);
    return result;
  };
  // One step: the growing parts grow by exactly what they are given (a preview's height, the waveform's, the timeline's).
  // Repeating it before `fit` had measured the grown content kept adding height (GUI test 2026-10-19: a 1872-high preview).
  function adopt() {
    const grow = Math.max(0, Math.round(target - (node.computeSize?.()[1] ?? target)));
    if (grow !== (node.properties.ng_grow || 0)) { node.properties.ng_grow = grow; setGrow(grow); }
    fit();
  }
}

// A node that grows by its content after it was loaded (a picture chosen on a card, a card connected to the Connector, a shot
// added in the Studio) moves what lies below it down, as on load (user 2026-10-25: "the nodes below are covered"). A drag by
// the user and the sizes a workflow is loaded with move nothing.
// Growth counts from the largest size the node has had since it was loaded or dragged: what lies below already stands clear
// of that. Counted from the previous frame, a height that wobbled by a few pixels pushed the nodes below on every upward
// step, and they drifted down without end (issue #37).
export function pushOnGrowth(node) {
  let peak = null;
  const resized = node.onResize, configured = node.onConfigure;
  node.onConfigure = function (...args) { const result = configured?.apply(this, args); peak = null; return result; };
  node.onResize = function (...args) {
    const result = resized?.apply(this, args), before = peak, size = [node.size[0], node.size[1]];
    if (!before || draggedByUser(node)) { peak = size; return result; }
    peak = [Math.max(before[0], size[0]), Math.max(before[1], size[1])];
    if (node.graph && size[1] > before[1] + 2) {
      makeRoom(node.graph, [[node, before]]);
      node.graph.setDirtyCanvas?.(true, true);
    }
    return result;
  };
}

// grown: [[node, [savedWidth, savedHeight]], ...] with each node already at its new size.
export function makeRoom(graph, grown) {
  const nodes = graph._nodes || graph.nodes || [], groups = graph._groups || graph.groups || [], all = [...nodes, ...groups];
  const encloses = (group, node, before) => group.pos[0] <= node.pos[0] && group.pos[1] <= node.pos[1]
    && group.pos[0] + group.size[0] >= node.pos[0] + before[0] && group.pos[1] + group.size[1] >= node.pos[1] + before[1];
  const columns = [];
  for (const entry of [...grown].sort((a, b) => a[0].pos[0] - b[0].pos[0])) {
    const column = columns.find((members) => Math.abs(members[0][0].pos[0] - entry[0].pos[0]) < 20);
    if (column) column.push(entry); else columns.push([entry]);
  }
  for (const members of columns) {
    const mine = new Set(members.map(([node]) => node)), x = members[0][0].pos[0];
    const dx = Math.max(0, ...members.map(([node, before]) => node.size[0] - before[0]));
    const right = x + Math.min(...members.map(([, before]) => before[0])) - 10, width = Math.max(...members.map(([node]) => node.size[0]));
    for (const item of all) if (!mine.has(item) && item.pos[0] >= right) item.pos[0] += dx;
    for (const group of groups) if (members.some(([node, before]) => encloses(group, node, before))) group.size[0] += dx;
    for (const [node, before] of members.sort((a, b) => a[0].pos[1] - b[0].pos[1])) {
      const dy = Math.max(0, node.size[1] - before[1]), below = node.pos[1] + before[1] - 10;
      for (const item of all)
        if (item !== node && item.pos[1] >= below && item.pos[0] < x + width && item.pos[0] + item.size[0] > x) item.pos[1] += dy;
      for (const group of groups) if (encloses(group, node, before)) group.size[1] += dy;
    }
  }
}

window.comfyAPI?.app?.app?.registerExtension?.({
  name: "mmxd.ng.layout_growth",
  afterConfigureGraph() {
    const graph = window.comfyAPI.app.app.graph;
    const grown = [...pending].filter(([node]) => node.graph === graph);
    pending.clear();
    if (grown.length) { makeRoom(graph, grown); graph.setDirtyCanvas?.(true, true); }
  },
});
