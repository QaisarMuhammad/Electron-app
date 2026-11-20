'use strict';

/**
 * Domains under which anybody can register or deploy a site of their own (SPEC 12).
 *
 * A wildcard entry in the allow-list (`*.example.com`) trusts every host below that domain with `window.electron`: printing,
 * the cash drawer, the printer list. That is right for a company's own domain and wrong for `*.co.uk` (every UK business site),
 * `*.github.io` or `*.herokuapp.com` (every project anybody has put on those services): a manager who wants to reach a demo or a
 * staging deployment is likely to type exactly such an entry. Settings refuses it, and the allow-list ignores it when it is
 * already in config.json.
 *
 * The list is built in on purpose: no network, no dependency, nothing that can go missing at a till. It does not try to be the
 * full Public Suffix List. It holds the two shapes that matter here:
 *   - a bare top-level domain (`com`, `uk`, `london`) and a country domain with a registry label (`co.uk`, `com.au`, `ac.nz`);
 *   - the hosting platforms that give each customer a subdomain (a hand-kept list of the common ones).
 * An exact address on such a domain (`https://api.partner.co.uk`, `https://myapp.herokuapp.com`) is a single site and stays fine.
 */

/** Second-level labels that country registries hand out for their own categories: co.uk, com.au, ac.nz, or.jp, gov.uk ... */
const REGISTRY_LABELS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'mil', 'net', 'org', 'or', 'ne', 'go', 'gob', 'ltd', 'plc', 'me']);

/** Hosting platforms where every customer gets a subdomain: a wildcard over one of them trusts all of its customers. */
const SHARED_HOSTING_SUFFIXES = Object.freeze([
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com', 'blogspot.com', 'wordpress.com', 'wixsite.com',
  'myshopify.com', 'weebly.com', 'glitch.me', 'repl.co', 'onrender.com', 'fly.dev', 'appspot.com', 'ngrok.io', 'ngrok-free.app',
  'trycloudflare.com',
]);
const SHARED_HOSTING = new Set(SHARED_HOSTING_SUFFIXES);

/**
 * Whether a wildcard over this domain would trust sites that belong to other people.
 *
 * @param {unknown} hostname a host as the URL parser writes it (lower case, no port, no trailing dot): the part after `*.`
 * @returns {boolean} true for a bare top-level domain, a registry suffix such as `co.uk`, or a shared hosting domain such as `github.io`
 */
function isSharedSuffix(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return true;
  if (labels.length === 2 && labels[1].length === 2 && REGISTRY_LABELS.has(labels[0])) return true;
  return SHARED_HOSTING.has(hostname);
}

module.exports = { isSharedSuffix, SHARED_HOSTING_SUFFIXES };
