/*
 * QuickFlat - record extraction.
 *
 * Turns the SAX event stream into a faithful, schema-agnostic tree of records:
 *   - leaf elements become strings (or null when empty / xsi:nil)
 *   - elements with children become objects
 *   - repeated child tags become arrays
 *
 * Records are the direct children of the document's root element (e.g. each
 * <Product> under <Products>). The root element's own attributes are returned
 * as `meta` so provenance like datePublished/schemaVersion is preserved.
 *
 * Output shape is intentionally generic; HPRA-specific column shaping lives in
 * transform.js so this stays reusable for any record-list XML.
 */
(function (root) {
  'use strict';

  var SAX = root.QFSax;

  function isNil(attrs) {
    for (var k in attrs) {
      if (SAX.localName(k) === 'nil' && /^true$/i.test(attrs[k])) return true;
    }
    return false;
  }

  /** Collapse a frame captured during parsing into its JS value. */
  function buildValue(f) {
    if (f.nil) return null;
    if (!f.hasEl) {
      var t = f.text.trim();
      return t === '' ? null : t;
    }
    var obj = {};
    for (var n = 0; n < f.order.length; n++) {
      var tag = f.order[n];
      var arr = f.childMap[tag];
      obj[tag] = arr.length === 1 ? arr[0] : arr;
    }
    return obj;
  }

  function addChild(parent, tag, value) {
    var bucket = parent.childMap[tag];
    if (bucket) {
      bucket.push(value);
    } else {
      parent.childMap[tag] = [value];
      parent.order.push(tag);
    }
  }

  /**
   * extract(text, onProgress) -> {
   *   records: Array<value>,    // one per direct child of the root element
   *   meta: { rootTag, recordTag, datePublished, schemaVersion, attrs },
   *   recordTag, isHPRA, recordCount
   * }
   */
  function extract(text, onProgress) {
    var frames = [{ tag: '#doc', childMap: {}, order: [], text: '', hasEl: false, nil: false }];
    var records = [];
    var recordCounts = {};
    var rootTag = null;
    var rootAttrs = {};

    SAX.parse(text, {
      onStartElement: function (name, attrs) {
        if (frames.length > 1) frames[frames.length - 1].hasEl = true;
        frames.push({ tag: name, attrs: attrs, childMap: {}, order: [], text: '', hasEl: false, nil: isNil(attrs) });
        if (frames.length === 2) { rootTag = name; rootAttrs = attrs; }
      },
      onText: function (t) {
        frames[frames.length - 1].text += t;
      },
      onEndElement: function () {
        var f = frames.pop();
        var value = buildValue(f);
        if (frames.length === 1) {
          // The root element itself just closed - nothing more to attach to.
          return;
        }
        if (frames.length === 2) {
          // Direct child of the root element => one record.
          records.push(value);
          recordCounts[f.tag] = (recordCounts[f.tag] || 0) + 1;
        } else {
          addChild(frames[frames.length - 1], f.tag, value);
        }
      },
      onProgress: onProgress || function () {}
    });

    var recordTag = null;
    var best = -1;
    for (var k in recordCounts) {
      if (recordCounts[k] > best) { best = recordCounts[k]; recordTag = k; }
    }

    var isHPRA = rootTag === 'Products' && recordTag === 'Product' &&
      records.some(function (r) { return r && typeof r === 'object' && ('DrugIDPK' in r || 'LicenceNumber' in r); });

    return {
      records: records,
      recordTag: recordTag,
      recordCount: records.length,
      isHPRA: isHPRA,
      meta: {
        rootTag: rootTag,
        recordTag: recordTag,
        datePublished: rootAttrs.datePublished || null,
        schemaVersion: rootAttrs.schemaVersion || null,
        attrs: rootAttrs
      }
    };
  }

  root.QFExtract = { extract: extract };
})(typeof self !== 'undefined' ? self : this);
