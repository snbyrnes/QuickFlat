/*
 * QuickFlat - streaming SAX-style XML parser.
 *
 * A tiny, dependency-free pull parser. It scans the document once and fires
 * start/end/text callbacks. It is deliberately small and handles the subset of
 * XML used by data exports (elements, attributes, text, entities, CDATA,
 * comments, processing instructions, self-closing and nil elements).
 *
 * It is written as a classic script so the same file can run in a Web Worker
 * (via importScripts) and be unit-tested in Node (via vm). It attaches itself
 * to the global object as `QFSax`.
 */
(function (root) {
  'use strict';

  var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  /** Decode the XML entities found in text/attribute values in a single pass. */
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, ent) {
      if (ent.charCodeAt(0) === 35 /* # */) {
        var cp = (ent.charCodeAt(1) === 120 || ent.charCodeAt(1) === 88) /* x/X */
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
        if (isNaN(cp)) return m;
        try { return String.fromCodePoint(cp); } catch (e) { return m; }
      }
      var v = NAMED[ent];
      return v === undefined ? m : v;
    });
  }

  /** Strip a namespace prefix, e.g. "xsi:nil" -> "nil". */
  function localName(qname) {
    var i = qname.indexOf(':');
    return i === -1 ? qname : qname.slice(i + 1);
  }

  /** Parse the attribute portion of a tag into a plain object. */
  function parseAttrs(s) {
    var attrs = {};
    var re = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m;
    while ((m = re.exec(s))) {
      attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    }
    return attrs;
  }

  function noop() {}

  /**
   * Parse `text`, invoking handlers:
   *   onStartElement(name, attrs)
   *   onEndElement(name)
   *   onText(text)            // already entity-decoded
   *   onProgress(pos, length) // ~1% steps, for UI progress bars
   */
  function parse(text, handlers) {
    var len = text.length;
    var i = 0;
    var onStart = handlers.onStartElement || noop;
    var onEnd = handlers.onEndElement || noop;
    var onText = handlers.onText || noop;
    var onProgress = handlers.onProgress || noop;
    var step = Math.max(65536, Math.floor(len / 100));
    var nextProgress = step;

    while (i < len) {
      var lt = text.indexOf('<', i);
      if (lt === -1) {
        if (i < len) emitText(text.slice(i));
        break;
      }
      if (lt > i) emitText(text.slice(i, lt));

      var c1 = text.charCodeAt(lt + 1);

      if (c1 === 33 /* ! */) {
        if (text.substr(lt, 4) === '<!--') {
          var ce = text.indexOf('-->', lt + 4);
          i = ce === -1 ? len : ce + 3;
        } else if (text.substr(lt, 9) === '<![CDATA[') {
          var de = text.indexOf(']]>', lt + 9);
          onText(text.slice(lt + 9, de === -1 ? len : de)); // CDATA: no entity decode
          i = de === -1 ? len : de + 3;
        } else {
          var doc = text.indexOf('>', lt + 2); // DOCTYPE / other declaration
          i = doc === -1 ? len : doc + 1;
        }
        continue;
      }

      if (c1 === 63 /* ? */) { // <?xml ... ?> processing instruction
        var pe = text.indexOf('?>', lt + 2);
        i = pe === -1 ? len : pe + 2;
        continue;
      }

      // Ordinary tag: find the closing '>' while ignoring quoted attribute values.
      var j = lt + 1;
      var quote = 0;
      while (j < len) {
        var c = text.charCodeAt(j);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) {
          quote = c;
        } else if (c === 62 /* > */) {
          break;
        }
        j++;
      }
      if (j >= len) break;

      var rawTag = text.slice(lt + 1, j);
      i = j + 1;

      if (rawTag.charCodeAt(0) === 47 /* / */) {
        onEnd(localName(rawTag.slice(1).trim()));
      } else {
        var selfClose = rawTag.charCodeAt(rawTag.length - 1) === 47;
        var inner = selfClose ? rawTag.slice(0, -1) : rawTag;
        var sp = inner.search(/[\s]/);
        var qname = (sp === -1 ? inner : inner.slice(0, sp)).trim();
        var name = localName(qname);
        var attrs = sp === -1 ? {} : parseAttrs(inner.slice(sp + 1));
        onStart(name, attrs);
        if (selfClose) onEnd(name);
      }

      if (i >= nextProgress) {
        onProgress(i, len);
        nextProgress = i + step;
      }
    }
    onProgress(len, len);

    function emitText(t) {
      if (t.length === 0) return;
      onText(decodeEntities(t));
    }
  }

  root.QFSax = { parse: parse, decodeEntities: decodeEntities, localName: localName };
})(typeof self !== 'undefined' ? self : this);
