import ts from 'typescript';
import { ALLOWED_EXCEPTIONS, ALLOWED_EXCEPTION_FILE, ALLOWED_EXCEPTION_FUNCTION, isWriteApi } from './denylist.js';

export type RuleId =
  | 'denylist-api'
  | 'dynamic-socket-access'
  | 'socket-spread'
  | 'logout-outside-unlink'
  | 'baileys-import-outside-wa'
  | 'download-media-import';

export interface Violation {
  file: string;
  line: number;
  column: number;
  rule: RuleId;
  name: string;
  message: string;
}

export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line}  ${v.name}  [${v.rule}] ${v.message}`;
}

const WA_LIBS = ['baileys', '@whiskeysockets/baileys', 'whatsapp-web.js'];
const SOCKET_NAMES = new Set(['sock', 'socket']);
const ENUMERATORS = new Set(['keys', 'values', 'entries', 'assign', 'getOwnPropertyNames', 'getOwnPropertyDescriptors', 'ownKeys', 'fromEntries']);

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function isWaLibModule(spec: string): boolean {
  return WA_LIBS.some((lib) => spec === lib || spec.startsWith(`${lib}/`));
}

function insideWaDir(file: string): boolean {
  return /(^|\/)src\/daemon\/wa\//.test(norm(file));
}

function isAllowedLogoutFile(file: string): boolean {
  const f = norm(file);
  return f === ALLOWED_EXCEPTION_FILE || f.endsWith(`/${ALLOWED_EXCEPTION_FILE}`);
}

/** Name a function-like node is declared or bound as. */
function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) {
    if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const p = node.parent;
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.initializer === node) {
      if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
    }
  }
  return undefined;
}

function insideUnlink(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (functionName(n) === ALLOWED_EXCEPTION_FUNCTION) return true;
  }
  return false;
}

/** `sock`, `socket`, `this.sock`, `deps.socket` ... */
function isSocketExpr(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return isSocketExpr(e.expression);
  if (ts.isIdentifier(e)) return SOCKET_NAMES.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return SOCKET_NAMES.has(e.name.text);
  return false;
}

export function scanSource(fileName: string, sourceText: string): Violation[] {
  const file = norm(fileName);
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Violation[] = [];
  const inWa = insideWaDir(file);

  const add = (node: ts.Node, rule: RuleId, name: string, message: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, column: character + 1, rule, name, message });
  };

  const checkModule = (node: ts.Node, spec: string | undefined): void => {
    if (inWa) return;
    if (spec === undefined) {
      add(node, 'baileys-import-outside-wa', '<dynamic module>', 'non-literal import()/require() outside src/daemon/wa/** is forbidden');
    } else if (isWaLibModule(spec)) {
      add(node, 'baileys-import-outside-wa', spec, 'the WhatsApp library may only be imported inside src/daemon/wa/**');
    }
  };

  const checkLogout = (node: ts.Node): void => {
    if (!isAllowedLogoutFile(file) || !insideUnlink(node)) {
      add(node, 'logout-outside-unlink', 'logout', `logout is allowed only inside ${ALLOWED_EXCEPTION_FUNCTION}() in ${ALLOWED_EXCEPTION_FILE}`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (isWriteApi(node.text)) add(node, 'denylist-api', node.text, 'WhatsApp write API is forbidden (read-only guard)');
      else if (ALLOWED_EXCEPTIONS.includes(node.text)) checkLogout(node);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const inElementAccess = ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node;
      if (isWriteApi(node.text)) add(node, 'denylist-api', node.text, 'WhatsApp write API name used as a string (read-only guard)');
      else if (inElementAccess && ALLOWED_EXCEPTIONS.includes(node.text)) checkLogout(node);
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkModule(node, node.moduleSpecifier.text);
      if (ts.isImportDeclaration(node)) {
        const nb = node.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if ((el.propertyName ?? el.name).text === 'downloadMediaMessage') {
              add(el, 'download-media-import', 'downloadMediaMessage', 'importing downloadMediaMessage is forbidden (no media download)');
            }
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      checkModule(node, ts.isStringLiteral(e) ? e.text : undefined);
    } else if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      checkModule(node, lit && ts.isStringLiteral(lit) ? lit.text : undefined);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isImportCall || isRequire) {
        const a = node.arguments[0];
        checkModule(node, a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : undefined);
      }
      // Object.keys(sock), Object.assign({}, sock), Reflect.ownKeys(sock) ...
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === 'Object' || callee.expression.text === 'Reflect') &&
        ENUMERATORS.has(callee.name.text) &&
        node.arguments.some(isSocketExpr)
      ) {
        add(node, 'socket-spread', callee.getText(sf), 'enumerating/copying the socket object is forbidden');
      }
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      const literal = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg);
      if (isSocketExpr(node.expression) && !literal) {
        add(node, 'dynamic-socket-access', node.getText(sf), 'computed (non-literal) property access on the socket is forbidden');
      }
    } else if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isSocketExpr(node.expression)) {
      add(node, 'socket-spread', node.getText(sf), 'spreading the socket object is forbidden');
    } else if (ts.isBindingElement(node) && node.dotDotDotToken) {
      const decl = node.parent.parent;
      if (ts.isVariableDeclaration(decl) && decl.initializer && isSocketExpr(decl.initializer)) {
        add(node, 'socket-spread', node.getText(sf), 'rest-destructuring the socket object is forbidden');
      }
    } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && isSocketExpr(node.expression)) {
      add(node, 'socket-spread', node.expression.getText(sf), 'iterating the socket object is forbidden');
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}
