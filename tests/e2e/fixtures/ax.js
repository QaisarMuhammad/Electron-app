'use strict';
/*
 * Chromium's accessibility tree for the scenarios of tests/e2e/ui-shots.js, read through the DevTools protocol of the page
 * under test (Accessibility.getPartialAXTree / getFullAXTree). It is what a screen reader is given, so it answers what the DOM
 * cannot: the computed role, the computed accessible name and description, and whether an element is a live region.
 * Not a unit test (the name must not end in .test.js).
 */

const valueOf = (field) => (field && field.value !== undefined && field.value !== null ? field.value : '');

/** A protocol AX node as { role, name, description, ignored, live, atomic } (strings and booleans only). */
function simplify(node) {
  const properties = {};
  for (const property of node.properties || []) properties[property.name] = valueOf(property.value);
  return {
    role: String(valueOf(node.role)),
    name: String(valueOf(node.name)).trim(),
    description: String(valueOf(node.description)).trim(),
    ignored: !!node.ignored,
    live: properties.live ? String(properties.live) : '',
    atomic: properties.atomic === true,
  };
}

/** The remote object id of the first element matching `selector`, or null. */
async function objectIdOf(p, selector) {
  const { result } = await p.cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  return result && result.objectId ? result.objectId : null;
}

/**
 * The accessibility node of the first element matching `selector`.
 * @returns {Promise<null | {role:string, name:string, description:string, ignored:boolean, live:string, atomic:boolean}>}
 *   `live` is "assertive" or "polite" for a live region (role="alert" is assertive and atomic), '' otherwise.
 */
async function axNode(p, selector) {
  await p.cdp('Accessibility.enable');
  const objectId = await objectIdOf(p, selector);
  if (!objectId) return null;
  const { nodes } = await p.cdp('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
  return nodes && nodes[0] ? simplify(nodes[0]) : null;
}

/**
 * Every node that is exposed to assistive technology below the first element matching `rootSelector` (the root included),
 * in document order.
 * @returns {Promise<{role:string, name:string, description:string, ignored:boolean, live:string, atomic:boolean}[]>}
 */
async function axOutline(p, rootSelector) {
  await p.cdp('Accessibility.enable');
  const objectId = await objectIdOf(p, rootSelector);
  if (!objectId) throw new Error(`axOutline: no element ${rootSelector}`);
  const { nodes: partial } = await p.cdp('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
  const rootBackend = partial[0].backendDOMNodeId;
  const { nodes } = await p.cdp('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => node.backendDOMNodeId === rootBackend);
  const out = [];
  const walk = (node) => {
    if (!node.ignored) out.push(simplify(node));
    for (const id of node.childIds || []) {
      const child = byId.get(id);
      if (child) walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

module.exports = { axNode, axOutline };
