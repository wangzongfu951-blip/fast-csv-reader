// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Reads one CSV input {text, header} once, left to right, and answers
// {columns, rows, errors} with exactly csv-reader 1.0.0's broken-row policy:
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a
// line left with no characters is no record; outside quotes a CR not
// followed by LF is dropped (stray_cr); a field that opens with a quote
// runs to the next quote that is not doubled, "" inside it is one quote,
// each CRLF or lone CR inside it is read as LF; what follows its closing
// quote, up to the next comma or line break, is appended as it stands
// (quote_junk, when the field ends); a quote that never closes is a
// literal character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal
// character; fields stay strings, never trimmed or converted; columns is
// the first record when header is true, else null; rows holds the records
// after it (every record when header is false), each padded with empty
// strings (short_row) or cut (long_row) to the first record's width; each
// error is {code, line, row} in the order met, line the 1-based line its
// record starts on, row its record's index in rows (null for the header).
//
// Speed comes from scanning by UTF-16 code unit (charCodeAt) and taking
// each field as a slice of the input wherever possible: a plain field
// costs one slice and no per-character string building, and the slow
// paths (stray CRs, doubled quotes, CRs inside quoted fields, junk)
// only pay when they actually occur.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CC_COMMA = 44; // ,
const CC_QUOTE = 34; // "
const CC_LF = 10; // \n
const CC_CR = 13; // \r
const CC_BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next code unit to read
  let line = 1; // line that code unit is on
  if (n > 0 && text.charCodeAt(0) === CC_BOM) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null while the header is still unread).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value and how it ended.
  let fv = '';
  let fe = END;

  // Reads an unquoted field onto `pre` ('' normally, '"' when a quote
  // that never closed is re-read as unquoted). Sets fv/fe. A CR not
  // followed by LF is dropped and reported as stray_cr.
  function readUnquoted(pre) {
    let start = pos;
    let parts = null; // kept segments, only built if a stray CR drops in
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === CC_COMMA) {
        fv = parts === null
          ? (pre === '' ? text.slice(start, pos) : pre + text.slice(start, pos))
          : parts.join('') + text.slice(start, pos);
        pos += 1;
        fe = COMMA;
        return;
      }
      if (c === CC_LF) {
        fv = parts === null
          ? (pre === '' ? text.slice(start, pos) : pre + text.slice(start, pos))
          : parts.join('') + text.slice(start, pos);
        pos += 1;
        line += 1;
        fe = LINE_BREAK;
        return;
      }
      if (c === CC_CR) {
        if (pos + 1 < n && text.charCodeAt(pos + 1) === CC_LF) {
          fv = parts === null
            ? (pre === '' ? text.slice(start, pos) : pre + text.slice(start, pos))
            : parts.join('') + text.slice(start, pos);
          pos += 2;
          line += 1;
          fe = LINE_BREAK;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [pre, text.slice(start, pos)];
        else parts.push(text.slice(start, pos));
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    fv = parts === null
      ? (pre === '' ? text.slice(start, pos) : pre + text.slice(start, pos))
      : parts.join('') + text.slice(start, pos);
    fe = END;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fv/fe.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let start = pos; // start of the content segment being scanned
    let parts = null; // kept segments, only built on an escape or a CR
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === CC_QUOTE) {
        if (pos + 1 < n && text.charCodeAt(pos + 1) === CC_QUOTE) {
          if (parts === null) parts = [text.slice(start, pos)];
          else parts.push(text.slice(start, pos));
          parts.push('"');
          pos += 2;
          start = pos;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === CC_CR) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [text.slice(start, pos)];
        else parts.push(text.slice(start, pos));
        parts.push('\n');
        line += 1;
        pos += (pos + 1 < n && text.charCodeAt(pos + 1) === CC_LF) ? 2 : 1;
        start = pos;
        continue;
      }
      if (c === CC_LF) line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    // Content is [start, pos - 1): pos sits just past the closing quote.
    const value = parts === null
      ? text.slice(start, pos - 1)
      : parts.join('') + text.slice(start, pos - 1);
    if (pos >= n) {
      fv = value;
      fe = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === CC_COMMA) {
      fv = value;
      pos += 1;
      fe = COMMA;
      return;
    }
    if (c === CC_LF) {
      fv = value;
      pos += 1;
      line += 1;
      fe = LINE_BREAK;
      return;
    }
    if (c === CC_CR && pos + 1 < n && text.charCodeAt(pos + 1) === CC_LF) {
      fv = value;
      pos += 2;
      line += 1;
      fe = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fv.length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === CC_LF) {
        pos += 1;
        line += 1;
      } else if (c === CC_CR && pos + 1 < n && text.charCodeAt(pos + 1) === CC_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === CC_QUOTE;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
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
