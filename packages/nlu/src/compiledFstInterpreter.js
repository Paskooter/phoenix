// Interpretation of the output stream produced by the pinned jibo-nlu
// compiler.  The native v8_interpreter first pairs S:/E: and P:/Q: markers,
// then executes the small NL-return language while its object_tracker moves
// between rule contexts.  This module keeps those operations explicit so the
// result is inspectable and does not depend on the AST matcher.

import { runInNewContext } from 'node:vm';

function object() {
  return Object.create(null);
}

function splitContext(value) {
  // A connected factory opens an outer parsed-variable frame with a bare P:
  // marker. The native v8 interpreter leaves that marker's name empty when
  // there is no matching Q:; the later factory reference closes it
  // indirectly, so an empty value is a valid root-relative context.
  if (value === '') return { context: '', uri: '' };
  const match = /^\{([^}]*)\}(?:\s+(.*))?$/su.exec(value);
  if (!match) throw new Error(`Malformed tagged output symbol: ${value}`);
  return { context: match[1], uri: (match[2] || '').trim() };
}

function uriAddress(uri) {
  const colon = uri.indexOf(':');
  return colon < 0 ? uri : uri.slice(colon + 1);
}

function normalizedPath(context) {
  return context === '' ? [] : context.split('.').filter(Boolean);
}

function assignmentParts(statement) {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '+' && statement[i + 1] === '=') {
      return { lhs: statement.slice(0, i).trim(), operator: '+=', rhs: statement.slice(i + 2).trim() };
    }
    if (char === '=') {
      return { lhs: statement.slice(0, i).trim(), operator: '=', rhs: statement.slice(i + 1).trim() };
    }
  }
  throw new Error(`NL return is not an assignment: ${statement}`);
}

function trimRecursively(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const result = [];
    for (const [key, child] of Object.entries(value)) result[key] = trimRecursively(child);
    return result;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = trimRecursively(child);
  return result;
}

function shouldAttachThis(ruleDepth, value) {
  return value[0] !== '\''
    && (ruleDepth > 0 || value === '_parsed' || value.includes('.'));
}

function fixSourceEscapes(value) {
  // v8_interpreter::fix_rh_escapes does not decode JavaScript escapes.  It
  // protects only quotes and backslashes before handing the text to V8.  For
  // example, the source RHS 'a\\nb' becomes the JSON string "a\\\\nb".
  if (!value.startsWith('\'')) return value;
  if (value.length < 2 || value[value.length - 1] !== '\'') {
    throw new Error(`Malformed string literal in NL return: ${value}`);
  }
  let body = '';
  for (const char of value.slice(1, -1)) {
    if (char === '\'' || char === '\\') body += '\\';
    body += char;
  }
  return `'${body}'`;
}

function sourceStringLiteral(value) {
  let body = '';
  for (const char of value) {
    if (char === '\'' || char === '\\') body += `\\${char}`;
    else if (char === '\n') body += '\\n';
    else if (char === '\r') body += '\\r';
    else if (char === '\u2028') body += '\\u2028';
    else if (char === '\u2029') body += '\\u2029';
    else body += char;
  }
  return `'${body}'`;
}

/**
 * Pair compiler markers in the same reverse pass as v8_interpreter.  Factory
 * markers are intentionally retained here only as an ignored tag: a
 * ConnectedFstExecutor has already replaced G: arcs with epsilon links before
 * this stage, while this helper remains useful for direct tag fixtures.
 */
export function pairCompilerMarkers(symbols) {
  const paired = [];
  const ruleEnds = [];
  const parsedEnds = [];
  for (const symbol of symbols) paired.push(symbol);
  for (let i = paired.length - 1; i >= 0; i -= 1) {
    const symbol = paired[i];
    if (symbol.startsWith('E:')) ruleEnds.push(symbol.slice(2));
    else if (symbol.startsWith('Q:')) parsedEnds.push(symbol.slice(2));
    else if (symbol.startsWith('S:')) {
      if (ruleEnds.length === 0) throw new Error('S: marker has no matching E: marker');
      paired[i] = `S:${ruleEnds.pop()}`;
    } else if (symbol.startsWith('P:')) {
      // The outer P: around a connected factory has no Q: in the serialized
      // path. v8_interpreter leaves its value empty and the later factory:
      // symbol appends into that frame. Pair named starts when a Q: is
      // available, while preserving this source-defined empty start.
      if (parsedEnds.length > 0) paired[i] = `P:${parsedEnds.pop()}`;
    }
  }
  if (ruleEnds.length || parsedEnds.length) throw new Error('Unbalanced compiler markers');
  return paired;
}

function buildSourceScript(symbols) {
  const lines = [
    'RecursiveTrimFunction = function(a) {',
    '  if (typeof a == \'object\') {',
    '    for (var k in a) {',
    '      if (a.hasOwnProperty(k)) {',
    '        if (typeof a[k] == \'string\') a[k] = a[k].trim();',
    '        else if (typeof a[k] == \'object\') RecursiveTrimFunction(a[k]);',
    '      }',
    '    }',
    '  }',
    '};',
    'ParsedVarStack = [];',
    'WrapperObject = new Object();',
    'WrapperObject.RunFunction = function() {',
  ];
  const ruleStack = [];
  const baseStack = [];
  let base = 0;
  let parsedDepth = 0;
  let charBytes = [];

  const emit = source => lines.push(source);
  const enterRelativeToBase = context => {
    const parts = normalizedPath(context);
    let common = 0;
    while (
      common < parts.length
      && ruleStack.length > base + common
      && ruleStack[base + common] === parts[common]
    ) common += 1;

    const pops = ruleStack.length - base - common;
    for (let i = 0; i < pops; i += 1) {
      const name = ruleStack.pop();
      emit('};');
      emit(`this.${name}.RunFunction();`);
    }
    while (common < parts.length) {
      const name = parts[common];
      ruleStack.push(name);
      emit(`this.${name} = new Object();`);
      emit(`this.${name}.RunFunction = function() {`);
      common += 1;
    }
  };

  const startRule = uri => {
    const { context, uri: addressUri } = splitContext(uri);
    enterRelativeToBase(context);
    const name = uriAddress(addressUri);
    ruleStack.push(name);
    emit(`this.${name} = new Object();`);
    emit(`this.${name}.RunFunction = function() {`);
    baseStack.push(base);
    base = ruleStack.length;
  };

  const endRule = () => {
    enterRelativeToBase('');
    if (!ruleStack.length || baseStack.length === 0) {
      throw new Error('E: marker has no matching S: marker');
    }
    const name = ruleStack.pop();
    emit('};');
    emit(`this.${name}.RunFunction();`);
    base = baseStack.pop();
  };

  const startParsed = uri => {
    const { context } = splitContext(uri);
    enterRelativeToBase(context);
    emit('ParsedVarStack.push(this);');
    emit("this._parsed = '';" );
    parsedDepth += 1;
  };

  const endParsed = () => {
    if (parsedDepth === 0) throw new Error('Q: marker has no matching P: marker');
    emit('if (ParsedVarStack.length > 1) ParsedVarStack.slice(-2)[0]._parsed += ParsedVarStack.slice(-1)[0]._parsed;');
    emit('ParsedVarStack.pop();');
    parsedDepth -= 1;
  };

  const assign = statement => {
    const { lhs: rawLhs, operator, rhs } = assignmentParts(statement.replace(/;\s*$/u, '').trim());
    if (!rawLhs || !rhs) throw new Error(`Malformed NL assignment: ${statement}`);
    const depth = ruleStack.length;
    const lhs = rawLhs.startsWith('this.') ? rawLhs.slice(5) : rawLhs;
    const fixedRhs = fixSourceEscapes(rhs);
    const sourceLhs = shouldAttachThis(depth, rawLhs) && !rawLhs.startsWith('this.')
      ? `this.${lhs}`
      : rawLhs;
    const sourceRhs = shouldAttachThis(depth, fixedRhs) && !fixedRhs.startsWith('this.')
      ? `this.${fixedRhs}`
      : fixedRhs;
    if (operator === '+=') {
      emit(`if (typeof ${sourceLhs} == 'undefined') { ${sourceLhs} = ''; };`);
    }
    emit(`${sourceLhs} ${operator} ${sourceRhs};`);
  };

  const processNl = raw => {
    const { context, uri: statement } = splitContext(raw);
    enterRelativeToBase(context);
    if (statement.startsWith('{%') && statement.endsWith('%}')) {
      emit(statement.slice(2, -2));
      emit(';');
    } else if (statement) {
      assign(statement);
    }
  };

  const flushChars = () => {
    if (charBytes.length === 0 || parsedDepth === 0) {
      charBytes = [];
      return;
    }
    emit(`ParsedVarStack.slice(-1)[0]._parsed += ${sourceStringLiteral(Buffer.from(charBytes).toString('utf8'))};`);
    charBytes = [];
  };

  for (const symbol of pairCompilerMarkers(symbols)) {
    if (symbol === 'ε' || symbol === 'σ' || symbol === 'H:' || symbol.startsWith('G:')) continue;
    if (symbol.startsWith('C:')) {
      const value = symbol.slice(2);
      const byte = /^\d+$/u.test(value) ? Number(value) : Buffer.from(value, 'utf8')[0];
      if (Number.isInteger(byte) && byte >= 0 && byte <= 255) charBytes.push(byte);
      else throw new Error(`Invalid C: output symbol ${symbol}`);
      continue;
    }
    flushChars();
    if (symbol.startsWith('N:')) processNl(symbol.slice(2));
    else if (symbol.startsWith('S:')) startRule(symbol.slice(2));
    else if (symbol.startsWith('E:')) endRule();
    else if (symbol.startsWith('P:')) startParsed(symbol.slice(2));
    else if (symbol.startsWith('Q:')) endParsed();
    else if (symbol.startsWith('W:')) {
      if (parsedDepth > 0) emit(`ParsedVarStack.slice(-1)[0]._parsed += ${sourceStringLiteral(symbol.slice(2))};`);
    } else if (symbol.startsWith('factory:')) {
      if (parsedDepth === 0) throw new Error(`Factory reference outside parsed variable: ${symbol}`);
      emit(`ParsedVarStack.slice(-1)[0]._parsed += ${sourceStringLiteral(symbol.slice('factory:'.length))};`);
    } else {
      throw new Error(`Unknown compiler output symbol ${symbol}`);
    }
  }
  flushChars();
  enterRelativeToBase('');
  if (ruleStack.length !== 0 || baseStack.length !== 0) {
    throw new Error('Unbalanced compiler context markers');
  }
  lines.push('};', 'WrapperObject.RunFunction();');
  return lines.join('\n');
}

/**
 * Interpret one native result-FST output path by generating the same complete
 * WrapperObject script as the pinned v8_interpreter. Executing once is
 * required: raw NL blocks share function-local `var`/function state, and
 * nested contexts share their generated RunFunction closure.
 */
export function interpretOutputSymbols(symbols, { trim = true } = {}) {
  const root = object();
  const script = buildSourceScript(symbols);
  runInNewContext(script, root);
  delete root.WrapperObject;
  delete root.ParsedVarStack;
  delete root.RecursiveTrimFunction;
  const result = trim ? trimRecursively(root) : root;
  return JSON.parse(JSON.stringify(result));
}
