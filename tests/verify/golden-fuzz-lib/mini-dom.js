'use strict';

/**
 * A small, STRICT XML DOM (DOMParser, XMLSerializer, DOMImplementation) built on `sax`, enough for the real DYMO framework's Label class.
 *
 * Why not @xmldom/xmldom: it is only installed on macOS here (electron-builder -> dmg-builder -> dmg-license (darwin only) -> plist), it is
 * lenient (a mismatched end tag or a bare `&` parses silently) and Chromium's parser is not. `sax` ships with electron-updater
 * (-> builder-util-runtime -> sax) on every platform, and its strict mode refuses ill-formed input, like Chromium does.
 *
 * Strictness: ill-formed XML throws a `Error('XML parse error: ...')`; characters XML 1.0 forbids (control characters, lone surrogates,
 * U+FFFE/U+FFFF) are rejected too, which sax does not check. Chromium answers a <parsererror> document instead, after which the framework finds no
 * object; a thrown error is the same failure, only louder.
 *
 * Not part of the app and not a test.
 */

const sax = require('sax');

const INVALID_XML_CHAR = /[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/u;

class XmlNode {
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('NotFoundError: the node is not a child of this node');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(reference);
    if (index < 0) throw new Error('NotFoundError: the reference node is not a child of this node');
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  replaceChild(node, old) {
    this.insertBefore(node, old);
    this.removeChild(old);
    return old;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(text) {
    while (this.childNodes.length > 0) this.removeChild(this.childNodes[0]);
    if (String(text) !== '') this.appendChild(this.ownerDocument.createTextNode(String(text)));
  }

  /** Descendant elements with this tag name, in document order ("*" = all). */
  getElementsByTagName(name) {
    const found = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (name === '*' || child.tagName === name) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

class XmlText extends XmlNode {
  constructor(data, ownerDocument) {
    super(3, ownerDocument);
    this.data = data;
    this.nodeName = '#text';
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(value) {
    this.data = String(value);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class XmlElement extends XmlNode {
  constructor(tagName, ownerDocument) {
    super(1, ownerDocument);
    this.tagName = tagName;
    this.nodeName = tagName;
    this.localName = tagName;
    this.attrs = new Map();
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  get nodeValue() {
    return null;
  }
}

class XmlDocument extends XmlNode {
  constructor() {
    super(9, null);
    this.ownerDocument = this;
    this.nodeName = '#document';
    this.declaration = null;
  }

  get documentElement() {
    return this.childNodes.find((child) => child.nodeType === 1) || null;
  }

  createElement(name) {
    return new XmlElement(name, this);
  }

  createTextNode(data) {
    return new XmlText(String(data), this);
  }
}

const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text) => escapeText(text).replace(/"/g, '&quot;');

function serializeNode(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  if (node.nodeType === 9) return (node.declaration ? `${node.declaration}` : '') + node.childNodes.map(serializeNode).join('');
  const attributes = [...node.attrs].map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join('');
  if (node.childNodes.length === 0) return `<${node.tagName}${attributes}/>`;
  return `<${node.tagName}${attributes}>${node.childNodes.map(serializeNode).join('')}</${node.tagName}>`;
}

class XMLSerializer {
  serializeToString(node) {
    return serializeNode(node);
  }
}

class DOMParser {
  /**
   * @param {string} source
   * @returns {XmlDocument}
   * @throws {Error} the XML is ill-formed
   */
  parseFromString(source) {
    const raw = String(source);
    const bad = INVALID_XML_CHAR.exec(raw);
    if (bad) throw new Error(`XML parse error: the character U+${bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} is not allowed in XML 1.0`);
    const document = new XmlDocument();
    const parser = sax.parser(true, { xmlns: false, position: false });
    let current = document;
    let rootSeen = false;
    parser.onerror = (error) => {
      throw new Error(`XML parse error: ${error.message.split('\n')[0]}`);
    };
    parser.onprocessinginstruction = (instruction) => {
      if (instruction.name === 'xml') document.declaration = `<?xml ${instruction.body}?>`;
    };
    parser.onopentag = (tag) => {
      if (current === document && rootSeen) throw new Error('XML parse error: more than one root element');
      const element = document.createElement(tag.name);
      for (const [key, value] of Object.entries(tag.attributes)) element.attrs.set(key, value);
      current.appendChild(element);
      current = element;
      rootSeen = true;
    };
    parser.onclosetag = () => {
      current = current.parentNode;
    };
    const onText = (text) => {
      if (current !== document) current.appendChild(document.createTextNode(text));
      else if (text.trim() !== '') throw new Error('XML parse error: text outside the root element');
    };
    parser.ontext = onText;
    parser.oncdata = onText;
    parser.write(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).close();
    if (!rootSeen) throw new Error('XML parse error: no root element');
    return document;
  }
}

class DOMImplementation {
  hasFeature() {
    return false; // no XPath: the framework falls back to its own tree walking
  }

  createDocument() {
    return new XmlDocument();
  }
}

module.exports = { DOMParser, XMLSerializer, DOMImplementation, XmlDocument, XmlElement, XmlText };
