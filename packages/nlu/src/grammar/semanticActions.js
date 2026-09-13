// Small interpreter for the JavaScript semantic-action subset used by the
// version-matched Pegasus grammars. The native compiler stores action bodies
// as JavaScript and the V8 interpreter runs them against the current rule's
// `this` object. Keeping the evaluator explicit avoids executing grammar text
// with the host process while preserving the operations used by the factory
// rules (assign/delete, if/else, member reads, arithmetic and string helpers).

const MULTI_OPERATORS = [
  '===', '!==', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '&&', '||',
];

function actionTokens(source) {
  const tokens = [];
  let pos = 0;
  const text = String(source);

  const push = (kind, value = kind) => tokens.push({ kind, value });
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === ' ' || ch === '\t' || ch === '\r') { pos += 1; continue; }
    if (ch === '\n') { push('NL'); pos += 1; continue; }
    if (ch === '/' && text[pos + 1] === '/') {
      pos += 2;
      while (pos < text.length && text[pos] !== '\n') pos += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = pos;
      pos += 1;
      while (pos < text.length && /[A-Za-z0-9_$]/.test(text[pos])) pos += 1;
      push('ID', text.slice(start, pos));
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[pos + 1] || ''))) {
      const start = pos;
      pos += 1;
      while (pos < text.length && /[0-9.]/.test(text[pos])) pos += 1;
      const value = Number(text.slice(start, pos));
      if (!Number.isFinite(value)) throw new Error('invalid semantic-action number');
      push('NUMBER', value);
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      pos += 1;
      let value = '';
      let closed = false;
      while (pos < text.length) {
        const current = text[pos];
        if (current === quote) { pos += 1; closed = true; break; }
        if (current === '\\') {
          if (pos + 1 >= text.length) break;
          const escaped = text[pos + 1];
          const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
          value += escapes[escaped] ?? escaped;
          pos += 2;
          continue;
        }
        value += current;
        pos += 1;
      }
      if (!closed) throw new Error('unterminated semantic-action string');
      push('STRING', value);
      continue;
    }
    let matched = false;
    for (const operator of MULTI_OPERATORS) {
      if (text.startsWith(operator, pos)) {
        push('OP', operator);
        pos += operator.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if ('(){};,.:=+-*/%<>!&|'.includes(ch)) {
      push(ch, ch);
      pos += 1;
      continue;
    }
    throw new Error(`unsupported semantic-action character ${JSON.stringify(ch)}`);
  }
  push('EOF');
  return tokens;
}

const PRECEDENCE = new Map([
  ['||', 1],
  ['&&', 2],
  ['|', 3],
  ['&', 4],
  ['==', 5], ['===', 5], ['!=', 5], ['!==', 5],
  ['<', 6], ['<=', 6], ['>', 6], ['>=', 6],
  ['+', 7], ['-', 7],
  ['*', 8], ['/', 8], ['%', 8],
]);

class ActionParser {
  constructor(source) {
    this.tokens = actionTokens(source);
    this.pos = 0;
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }

  is(kind, value = undefined) {
    const token = this.peek();
    return token.kind === kind && (value === undefined || token.value === value);
  }

  take(kind, value = undefined) {
    if (!this.is(kind, value)) {
      const token = this.peek();
      throw new Error(`expected ${value ?? kind}, got ${token.value}`);
    }
    this.pos += 1;
    return this.tokens[this.pos - 1];
  }

  skipSeparators() {
    while (this.is('NL') || this.is(';')) this.pos += 1;
  }

  parse() {
    const statements = this.parseStatements('EOF');
    this.skipSeparators();
    this.take('EOF');
    return { type: 'program', statements };
  }

  parseStatements(endKind) {
    const statements = [];
    this.skipSeparators();
    while (!this.is(endKind)) {
      if (this.is('EOF')) throw new Error(`unterminated semantic-action block, expected ${endKind}`);
      statements.push(this.parseStatement());
      this.skipSeparators();
    }
    return statements;
  }

  parseStatement() {
    if (this.is('ID', 'if')) return this.parseIf();
    if (this.is('ID', 'delete')) return this.parseDelete();
    return this.parseAssignment();
  }

  parseIf() {
    this.take('ID', 'if');
    this.skipSeparators();
    this.take('(');
    const condition = this.parseExpression();
    this.take(')');
    const then = this.parseBlock();
    this.skipSeparators();
    let otherwise = null;
    if (this.is('ID', 'else')) {
      this.pos += 1;
      this.skipSeparators();
      otherwise = this.is('ID', 'if') ? [this.parseIf()] : this.parseBlock();
    }
    return { type: 'if', condition, then, otherwise };
  }

  parseBlock() {
    this.skipSeparators();
    this.take('{');
    const statements = this.parseStatements('}');
    this.take('}');
    return statements;
  }

  parsePath() {
    const path = [this.take('ID').value];
    while (this.is('.')) {
      this.pos += 1;
      path.push(this.take('ID').value);
    }
    return path;
  }

  parseDelete() {
    this.take('ID', 'delete');
    return { type: 'delete', path: this.parsePath() };
  }

  // Assignment operators are represented as either `OP` or one-character
  // punctuation tokens by actionTokens. Keep the lookahead error readable.
  takeAssignmentOperator() {
    const token = this.peek();
    if (token.kind === 'OP' || token.kind === '=') {
      this.pos += 1;
      return token.value;
    }
    throw new Error(`expected assignment operator, got ${token.value}`);
  }

  parseAssignment() {
    const path = this.parsePath();
    const operator = this.takeAssignmentOperator();
    if (!['=', '+=', '-=', '*=', '/='].includes(operator)) {
      throw new Error(`unsupported semantic-action assignment operator ${operator}`);
    }
    return { type: 'assign', path, operator, value: this.parseExpression() };
  }

  parseExpression(minPrecedence = 0) {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.kind === 'NL' || token.kind === ';' || token.kind === ')' || token.kind === '}' || token.kind === ',' || token.kind === 'EOF') break;
      const operator = token.value;
      const precedence = PRECEDENCE.get(operator);
      if (precedence === undefined || precedence < minPrecedence) break;
      this.pos += 1;
      const right = this.parseExpression(precedence + 1);
      left = { type: 'binary', operator, left, right };
    }
    return left;
  }

  parseUnary() {
    if (this.is('!', '!') || this.is('-', '-') || this.is('+', '+')) {
      const operator = this.peek().value;
      this.pos += 1;
      return { type: 'unary', operator, value: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    if (this.is('NUMBER')) return { type: 'literal', value: this.take('NUMBER').value };
    if (this.is('STRING')) {
      const expression = { type: 'literal', value: this.take('STRING').value };
      return this.parseMethodCall(expression);
    }
    if (this.is('(')) {
      this.pos += 1;
      const expression = this.parseExpression();
      this.take(')');
      return expression;
    }
    if (!this.is('ID')) throw new Error(`expected semantic-action expression, got ${this.peek().value}`);
    const path = this.parsePath();
    if (!this.is('(')) return { type: 'path', path };
    this.pos += 1;
    const args = [];
    while (!this.is(')')) {
      args.push(this.parseExpression());
      if (this.is(',')) this.pos += 1;
      else break;
    }
    this.take(')');
    return { type: 'call', path, args };
  }

  parseMethodCall(receiver) {
    if (!this.is('.')) return receiver;
    this.pos += 1;
    const method = this.take('ID').value;
    if (!this.is('(')) throw new Error(`unsupported semantic-action property ${method}`);
    this.pos += 1;
    const args = [];
    while (!this.is(')')) {
      args.push(this.parseExpression());
      if (this.is(',')) this.pos += 1;
      else break;
    }
    this.take(')');
    return { type: 'methodCall', receiver, method, args };
  }
}

function parseProgram(source) {
  return new ActionParser(source).parse();
}

export function parseSemanticAction(source) {
  return parseProgram(source);
}

function cloneScope(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneScope);
  const copy = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneScope(child);
  return copy;
}

function truthy(value) { return Boolean(value); }

function jsString(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return String(value);
}

function jsNumber(value) {
  if (value === null) return 0;
  if (value === undefined) return NaN;
  return Number(value);
}

function looseEqual(left, right) {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  if (typeof left === 'number' || typeof right === 'number') return jsNumber(left) === jsNumber(right);
  return String(left) === String(right);
}

function getPath(scope, path) {
  let value = path[0] === 'this' ? scope : scope[path[0]];
  for (let index = 1; index < path.length; index += 1) {
    if (value === undefined || value === null) return undefined;
    value = value[path[index]];
  }
  return value;
}

function setPath(scope, path, value) {
  const parts = path[0] === 'this' ? path.slice(1) : path;
  if (!parts.length) throw new Error('cannot assign semantic-action this');
  let target = scope;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!target[parts[index]] || typeof target[parts[index]] !== 'object') target[parts[index]] = {};
    target = target[parts[index]];
  }
  target[parts[parts.length - 1]] = value;
}

function deletePath(scope, path) {
  const parts = path[0] === 'this' ? path.slice(1) : path;
  if (!parts.length) return;
  let target = scope;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!target || typeof target !== 'object') return;
    target = target[parts[index]];
  }
  if (target && typeof target === 'object') delete target[parts[parts.length - 1]];
}

function evaluateExpression(expression, scope) {
  if (expression.type === 'literal') return expression.value;
  if (expression.type === 'path') return getPath(scope, expression.path);
  if (expression.type === 'call') {
    if (expression.path.length === 1 && expression.path[0] === 'String') {
      return jsString(evaluateExpression(expression.args[0], scope));
    }
    if (expression.path.length === 1 && expression.path[0] === 'parseInt') {
      return parseInt(evaluateExpression(expression.args[0], scope), 10);
    }
    if (expression.path.at(-1) === 'concat') {
      const receiver = getPath(scope, expression.path.slice(0, -1));
      return jsString(receiver) + expression.args.map(arg => jsString(evaluateExpression(arg, scope))).join('');
    }
    throw new Error(`unsupported semantic-action call ${expression.path.join('.')}`);
  }
  if (expression.type === 'methodCall') {
    if (expression.method !== 'concat') throw new Error(`unsupported semantic-action method ${expression.method}`);
    const receiver = evaluateExpression(expression.receiver, scope);
    return jsString(receiver) + expression.args.map(arg => jsString(evaluateExpression(arg, scope))).join('');
  }
  if (expression.type === 'unary') {
    const value = evaluateExpression(expression.value, scope);
    if (expression.operator === '!') return !truthy(value);
    if (expression.operator === '-') return -jsNumber(value);
    return jsNumber(value);
  }
  if (expression.type !== 'binary') throw new Error(`unknown semantic-action expression ${expression.type}`);
  const left = evaluateExpression(expression.left, scope);
  const right = evaluateExpression(expression.right, scope);
  switch (expression.operator) {
    case '+': return typeof left === 'string' || typeof right === 'string' ? jsString(left) + jsString(right) : jsNumber(left) + jsNumber(right);
    case '-': return jsNumber(left) - jsNumber(right);
    case '*': return jsNumber(left) * jsNumber(right);
    case '/': return jsNumber(left) / jsNumber(right);
    case '%': return jsNumber(left) % jsNumber(right);
    case '&': return jsNumber(left) & jsNumber(right);
    case '|': return jsNumber(left) | jsNumber(right);
    case '&&': return truthy(left) ? right : left;
    case '||': return truthy(left) ? left : right;
    case '==': case '===': return expression.operator === '===' ? left === right : looseEqual(left, right);
    case '!=': case '!==': return expression.operator === '!==' ? left !== right : !looseEqual(left, right);
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    default: throw new Error(`unsupported semantic-action operator ${expression.operator}`);
  }
}

function executeStatements(statements, scope) {
  for (const statement of statements) {
    if (statement.type === 'assign') {
      const value = evaluateExpression(statement.value, scope);
      if (statement.operator === '=') setPath(scope, statement.path, value);
      else {
        const previous = getPath(scope, statement.path);
        const operator = statement.operator[0];
        const next = operator === '+'
          ? (typeof previous === 'string' || typeof value === 'string' ? jsString(previous) + jsString(value) : jsNumber(previous) + jsNumber(value))
          : operator === '-' ? jsNumber(previous) - jsNumber(value)
            : operator === '*' ? jsNumber(previous) * jsNumber(value)
              : jsNumber(previous) / jsNumber(value);
        setPath(scope, statement.path, next);
      }
    } else if (statement.type === 'delete') {
      deletePath(scope, statement.path);
    } else if (statement.type === 'if') {
      if (truthy(evaluateExpression(statement.condition, scope))) executeStatements(statement.then, scope);
      else if (statement.otherwise) executeStatements(statement.otherwise, scope);
    } else {
      throw new Error(`unknown semantic-action statement ${statement.type}`);
    }
  }
}

// Execute a parsed action against a copy of the current rule scope. Returning
// the copy lets the matcher apply deletes as well as assignments without
// mutating a sibling backtracking path.
export function executeSemanticAction(program, scope, parsedText) {
  const next = cloneScope(scope || {});
  next._parsed = parsedText;
  executeStatements(program.statements, next);
  return next;
}
