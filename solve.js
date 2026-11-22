// Fast CSV reader with csv-reader 1.0.0's exact semantics.
//
// Same answers as make.fun's csv-reader 1.0.0 (vendor/csv-reader/index.js in the
// kit), but written for speed: the text is scanned with jumps instead of one
// character at a time -- a regex finds the next comma / LF / CR of an unquoted
// field, indexOf finds the next quote of a quoted field, and field values are
// taken as slices instead of built up a character at a time. No clock, no
// randomness, no locale, nothing kept from one call to the next.
//
// Semantics (csv-reader 1.0.0's written broken-row policy):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character, and the text after it is read again as
//     an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings,
//     never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's
//     index in rows (null for the header), in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record ends.

/** The next comma, LF or CR from a position (global regex, lastIndex set per call). */
const DELIM = /[,\n\r]/g;

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value and how it ended.
  let lastValue = '';
  let lastEnded = END;

  // Characters appended by the last unquoted read (for quote_junk).
  let uAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Sets lastValue / lastEnded; uAdded counts the characters kept in this call.
  function readUnquoted(value) {
    uAdded = 0;
    let start = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        value += text.slice(start, len);
        uAdded += len - start;
        pos = len;
        lastValue = value;
        lastEnded = END;
        return;
      }
      const idx = m.index;
      const ch = m[0];
      if (ch === ',') {
        value += text.slice(start, idx);
        uAdded += idx - start;
        pos = idx + 1;
        lastValue = value;
        lastEnded = COMMA;
        return;
      }
      if (ch === '\n') {
        value += text.slice(start, idx);
        uAdded += idx - start;
        pos = idx + 1;
        line += 1;
        lastValue = value;
        lastEnded = LINE_BREAK;
        return;
      }
      // ch === '\r'
      if (idx + 1 < len && text.charCodeAt(idx + 1) === 10) {
        value += text.slice(start, idx);
        uAdded += idx - start;
        pos = idx + 2;
        line += 1;
        lastValue = value;
        lastEnded = LINE_BREAK;
        return;
      }
      // A lone CR: dropped (stray_cr), and the field goes on after it.
      error('stray_cr');
      value += text.slice(start, idx);
      uAdded += idx - start;
      pos = idx + 1;
      start = pos;
    }
  }

  // Normalises a quoted field's raw content: each CRLF and lone CR becomes one LF, and every line break
  // (LF, CRLF, lone CR) moves the line count by one. Only called once the closing quote is confirmed.
  function normaliseQuoted(value) {
    if (value.indexOf('\r') !== -1) {
      return value.replace(/\r\n?|\n/g, () => {
        line += 1;
        return '\n';
      });
    }
    if (value.indexOf('\n') !== -1) line += value.split('\n').length - 1;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos. Sets lastValue / lastEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        value += text.slice(pos, q);
        value += '"';
        pos = q + 2;
        continue;
      }
      value += text.slice(pos, q);
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      readUnquoted('"');
      return;
    }
    value = normaliseQuoted(value);
    if (pos >= len) {
      lastValue = value;
      lastEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      lastValue = value;
      lastEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      lastValue = value;
      lastEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      lastValue = value;
      lastEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (uAdded > 0) error('quote_junk');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(lastValue);
    } while (lastEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
