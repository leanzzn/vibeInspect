// React + TypeScript 정적 분석기.
// TypeScript 컴파일러로 파싱하고, 이름이 아니라 TypeScript의 심볼 해석으로 호출 대상을 찾는다.
// 그래서 다른 파일의 같은 이름 함수를 연결하지 않는다. 대상 코드는 실행하지 않는다.
// 확정할 수 없는 호출은 추측하지 않고 'gap' 노드(확인 필요 / 분석하지 못함)로 남긴다.
import ts from 'typescript';
import type { CodeLocation, Flow, FlowRelation, FlowRelationKind, MapNode, ProjectAnalysis, StructureRelation, StructureRelationKind } from './model';

const S = 'static-analysis' as const;
const ROUTER = /^react-router(-dom)?$/;
const REACT = /^react$/;
// 선언이 없어도 되는 JS 내장 함수: 확인 필요로 표시하지 않는다
const BUILTINS = new Set(['Number', 'String', 'Boolean', 'BigInt', 'Symbol', 'Array', 'Object', 'Date', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']);
// 콜백을 그 자리에서 바로 실행하는 배열 메서드: 안의 호출을 바깥 함수의 호출로 본다
const SYNC_CALLBACK = new Set(['map', 'filter', 'forEach', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'sort', 'toSorted']);

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
type Gap = { t: 'gap'; status: 'needs-check' | 'unanalyzed'; reason: string; soft?: boolean };
type Target =
  | { t: 'unit'; fn: Fn }
  | { t: 'state'; decl: ts.VariableDeclaration; stateName: string; setter: string }
  | { t: 'navigate' }
  | { t: 'data'; decl: ts.VariableDeclaration }
  | { t: 'external' }
  | { t: 'ignore' }
  | Gap;

const PARAM_FN: Gap = { t: 'gap', status: 'needs-check', reason: 'props나 매개변수로 받은 함수입니다. 실제로 어떤 함수가 전달될지는 호출하는 쪽에 따라 달라집니다.' };

export function analyzeProject(
  files: Record<string, string>,
  meta: { id: string; name: string; sourceName: string },
  scope?: ProjectAnalysis['scope'],
): ProjectAnalysis {
  // ── 메모리 안의 가상 파일 시스템으로 TypeScript 프로그램 구성 ──
  const has = (f: string) => Object.prototype.hasOwnProperty.call(files, f);
  const rel = (n: string) => n.replace(/^\//, '');
  const dirs = new Set<string>(['/']);
  for (const f of Object.keys(files)) for (let i = f.lastIndexOf('/'); i > 0; i = f.lastIndexOf('/', i - 1)) dirs.add('/' + f.slice(0, i));
  const host: ts.CompilerHost = {
    getSourceFile: (n, lang) => has(rel(n)) ? ts.createSourceFile(n, files[rel(n)], lang, true, n.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : undefined,
    fileExists: (n) => has(rel(n)),
    readFile: (n) => (has(rel(n)) ? files[rel(n)] : undefined),
    directoryExists: (d) => dirs.has(d.replace(/(.)\/$/, '$1')),
    getDirectories: () => [],
    getDefaultLibFileName: () => '/__no_lib__.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const roots = Object.keys(files).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).map((f) => '/' + f);
  const program = ts.createProgram(roots, {
    noLib: true, noEmit: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
  }, host);
  const checker = program.getTypeChecker();
  // 문법 오류: TypeScript는 오류가 있어도 최대한 읽어 내지만, 그 파일의 관계는 빠지거나 틀릴 수 있다
  const parseErrors: { file: string; line: number; message: string }[] = [];
  for (const d of program.getSyntacticDiagnostics()) {
    if (!d.file || parseErrors.some((e) => e.file === rel(d.file!.fileName))) continue; // 파일당 첫 오류만
    parseErrors.push({ file: rel(d.file.fileName), line: d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') });
  }

  // ── 결과 저장소 ──
  const nodes = new Map<string, MapNode>();
  const rels = new Map<string, StructureRelation>();
  const stateOwner = new Map<string, string>();
  const routed = new Set<string>(), eventBound = new Set<string>();
  const routeElements = new Set<ts.Node>();
  let usesReact = false;

  const fileOf = (n: ts.Node) => rel(n.getSourceFile().fileName);
  const lineOf = (n: ts.Node) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  function loc(n: ts.Node, label: string): CodeLocation {
    const sf = n.getSourceFile();
    return {
      file: rel(sf.fileName),
      startLine: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      endLine: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
      label,
      anchor: n.getText(sf).split('\n')[0].trim().slice(0, 80),
    };
  }
  const short = (n: ts.Node) => n.getText().replace(/\s+/g, ' ').slice(0, 40);

  function addRel(from: string, to: string, kind: StructureRelationKind, label: string, at: CodeLocation, trigger?: string) {
    const id = `${from}→${to}:${kind}:${trigger ?? ''}`;
    const r = rels.get(id);
    if (r) { if (r.locations.length < 6 && !r.locations.some((l) => l.startLine === at.startLine && l.file === at.file)) r.locations.push(at); return; }
    rels.set(id, { id, from, to, kind, label, locations: [at], provenance: S, trigger });
  }

  // ── 함수 단위(카드) ──
  function unitName(fn: ts.Node): { name: string; decl: ts.Node } | null {
    if (ts.isFunctionDeclaration(fn) && fn.name) return { name: fn.name.text, decl: fn };
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && fn.parent.initializer === fn && ts.isIdentifier(fn.parent.name)) {
      return { name: fn.parent.name.text, decl: fn.parent };
    }
    return null;
  }
  const isFn = (n: ts.Node): n is Fn => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  const hasJsx = (n: ts.Node): boolean => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || !!ts.forEachChild(n, (c) => hasJsx(c) || undefined);

  function unitId(fn: Fn): string {
    const u = unitName(fn)!;
    const id = `fn:${fileOf(fn)}#${u.name}@${lineOf(u.decl)}`;
    if (!nodes.has(id)) {
      const component = /^[A-Z]/.test(u.name) && !!fn.body && hasJsx(fn.body);
      const outer = context(u.decl).owner;
      const inside = outer.startsWith('fn:') ? ` · ${nodes.get(outer)?.title} 안에 선언` : '';
      nodes.set(id, {
        id, title: u.name, kind: component ? 'ui' : 'logic', provenance: S, verification: { status: 'confirmed' },
        summary: `${component ? '컴포넌트' : '함수'} · ${fileOf(fn)}${inside}`,
        locations: [loc(u.decl, `${u.name} 선언`)],
      });
    }
    return id;
  }
  function moduleId(sf: ts.SourceFile): string {
    const id = `mod:${rel(sf.fileName)}`;
    if (!nodes.has(id)) nodes.set(id, {
      id, title: rel(sf.fileName).split('/').pop()!, kind: 'module', provenance: S, verification: { status: 'confirmed' },
      summary: `${rel(sf.fileName)}의 최상위 코드 (함수 밖에서 실행되는 부분)`, locations: [loc(sf.statements[0] ?? sf, '파일 시작')],
    });
    return id;
  }
  function routeId(path: string, def?: ts.Node): string {
    const id = `route:${path}`;
    const n = nodes.get(id) ?? {
      id, title: `경로 ${path}`, kind: 'routing' as const, provenance: S, locations: [],
      summary: '코드에 적힌 화면 주소입니다.', verification: { status: 'unconfirmed' as const, reason: '이 경로를 화면에 연결하는 <Route path>를 분석 범위에서 찾지 못했습니다.' },
    };
    if (def && n.verification.status === 'unconfirmed') { n.verification = { status: 'confirmed' }; n.locations.push(loc(def, `<Route path="${path}">`)); }
    nodes.set(id, n);
    return id;
  }
  function gapId(owner: string, at: ts.Node, what: string, g: Gap): string {
    const id = `gap:${owner}:${what}:${g.status}`;
    const l = loc(at, what);
    const n = nodes.get(id);
    if (n) { if (n.locations.length < 6) n.locations.push(l); return id; }
    nodes.set(id, {
      id, title: `${what} — ${g.status === 'needs-check' ? '확인 필요' : '분석하지 못함'}`, kind: 'gap', provenance: S,
      summary: g.reason, verification: { status: 'unconfirmed', reason: g.reason }, locations: [l],
    });
    return id;
  }
  const addGap = (owner: string, at: ts.Node, what: string, g: Gap, trigger?: string) =>
    addRel(owner, gapId(owner, at, what, g), 'unresolved', trigger ? `${trigger} 안에서 ${what}` : what, loc(at, what), trigger);

  // ── 이 코드가 어느 함수 안에서, 어떤 계기로 실행되는가 ──
  function context(n: ts.Node): { owner: string; trigger?: string } {
    let trigger: string | undefined;
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isSourceFile(p)) return { owner: moduleId(p), trigger };
      if (!isFn(p)) continue;
      if (unitName(p)) return { owner: unitId(p), trigger };
      if (trigger) continue;
      const par = p.parent;
      if (ts.isJsxExpression(par) && ts.isJsxAttribute(par.parent) && /^on[A-Z]/.test(par.parent.name.getText())) trigger = par.parent.name.getText();
      else if (ts.isCallExpression(par) && par.arguments.includes(p as ts.Expression)) {
        const callee = par.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (isExt(callee, REACT, /^use(Layout|Insertion)?Effect$/)) trigger = name;
        else if (!SYNC_CALLBACK.has(name)) trigger = `${name || '익명'} 콜백(실행 시점 확인 필요)`;
      } else trigger = '익명 함수(실행 시점 확인 필요)';
    }
    return { owner: moduleId(n.getSourceFile()), trigger };
  }

  // ── import / 심볼 해석 ──
  // '@/…'·'~/…'·'#…'는 tsconfig paths 등의 경로 별칭이다. 외부 패키지로 보고 넘기지 않고 끊긴 지점으로 남긴다
  const isLocal = (m: string) => m.startsWith('.') || m.startsWith('/') || /^(@\/|~\/|#)/.test(m);
  function importInfo(id: ts.Node): { module: string; name: string } | null {
    const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
    if (!d) return null;
    const spec = (decl: ts.ImportDeclaration | ts.JSDocImportTag) => (decl.moduleSpecifier as ts.StringLiteral).text;
    if (ts.isImportSpecifier(d)) return { module: spec(d.parent.parent.parent), name: (d.propertyName ?? d.name).text };
    if (ts.isImportClause(d)) return { module: spec(d.parent), name: 'default' };
    if (ts.isNamespaceImport(d)) return { module: spec(d.parent.parent), name: '*' };
    return null;
  }
  /** 외부 패키지에서 가져온 이름인지 (예: react의 useState, React.useState) */
  function isExt(expr: ts.Node, mod: RegExp, name: RegExp): boolean {
    if (ts.isIdentifier(expr)) { const i = importInfo(expr); return !!i && mod.test(i.module) && name.test(i.name); }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      const i = importInfo(expr.expression);
      return !!i && mod.test(i.module) && (i.name === '*' || i.name === 'default') && name.test(expr.name.text);
    }
    return false;
  }
  function unitOfDecl(d: ts.Node): Fn | undefined {
    if (ts.isFunctionDeclaration(d) && d.name) return d;
    if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isIdentifier(d.name)) return d.initializer;
  }

  function resolve(id: ts.Node): Target {
    let sym = checker.getSymbolAtLocation(id);
    if (!sym) {
      if (ts.isIdentifier(id) && BUILTINS.has(id.text)) return { t: 'ignore' };
      if (ts.isIdentifier(id) && id.text === 'fetch') return { t: 'gap', status: 'unanalyzed', reason: '외부 서비스 호출입니다. 서버 내부와 실제 응답 데이터는 분석하지 않습니다.' };
      return { t: 'gap', status: 'unanalyzed', reason: '선언을 찾지 못했습니다(전역 함수이거나 분석 범위 밖일 수 있음).', soft: true };
    }
    if (sym.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(sym);
      if (!target.declarations?.length) {
        const i = importInfo(id);
        if (i && !isLocal(i.module)) return { t: 'external' };
        return { t: 'gap', status: 'unanalyzed', reason: `import 대상(${i?.module ?? '알 수 없음'})을 찾지 못했습니다. 제외된 파일이거나 경로 별칭일 수 있습니다.` };
      }
      sym = target;
    }
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!d || d.getSourceFile().isDeclarationFile) return { t: 'ignore' };
    const fn = unitOfDecl(d);
    if (fn) return { t: 'unit', fn };
    if (ts.isParameter(d)) return PARAM_FN;
    if (ts.isClassDeclaration(d)) return { t: 'gap', status: 'unanalyzed', reason: '클래스로 만든 컴포넌트입니다. 이 버전은 클래스 안을 분석하지 않습니다.' };
    if (ts.isBindingElement(d)) {
      const pat = d.parent, vd = pat.parent;
      if (ts.isArrayBindingPattern(pat) && ts.isVariableDeclaration(vd) && vd.initializer && ts.isCallExpression(vd.initializer)
        && isExt(vd.initializer.expression, REACT, /^use(State|Reducer)$/) && pat.elements.indexOf(d) === 1) {
        const first = pat.elements[0];
        if (ts.isBindingElement(first) && ts.isIdentifier(first.name) && ts.isIdentifier(d.name)) return { t: 'state', decl: vd, stateName: first.name.text, setter: d.name.text };
      }
      let q: ts.Node = d;
      while (ts.isBindingElement(q) || ts.isObjectBindingPattern(q) || ts.isArrayBindingPattern(q)) q = q.parent;
      if (ts.isParameter(q)) return PARAM_FN;
      const src = ts.isVariableDeclaration(q) && q.initializer ? short(q.initializer) : '다른 값';
      return { t: 'gap', status: 'needs-check', reason: `${src}에서 꺼낸 값입니다. 실제로 어떤 함수인지는 실행 시점의 값에 따라 정해지므로 정적으로 확정하지 않았습니다.` };
    }
    if (ts.isVariableDeclaration(d)) {
      if (d.initializer && ts.isCallExpression(d.initializer) && isExt(d.initializer.expression, ROUTER, /^useNavigate$/)) return { t: 'navigate' };
      return { t: 'data', decl: d };
    }
    return { t: 'ignore' };
  }

  /** 컴포넌트의 props 매개변수(구조 분해하지 않은 것)인가 */
  function isPropsObject(e: ts.Node): boolean {
    const d = ts.isIdentifier(e) ? checker.getSymbolAtLocation(e)?.valueDeclaration : undefined;
    if (!d || !ts.isParameter(d) || !isFn(d.parent)) return false;
    const u = unitName(d.parent);
    return !!u && /^[A-Z]/.test(u.name) && !!d.parent.body && hasJsx(d.parent.body);
  }

  function stateId(t: Extract<Target, { t: 'state' }>): string {
    const owner = context(t.decl).owner;
    const id = `state:${fileOf(t.decl)}#${t.stateName}@${lineOf(t.decl)}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, title: `상태 ${t.stateName}`, kind: 'state', provenance: S, verification: { status: 'confirmed' },
        summary: `${nodes.get(owner)?.title ?? fileOf(t.decl)} 안의 React 상태(useState). ${t.setter}로 바뀝니다.`,
        locations: [loc(t.decl, 'useState 선언')],
      });
      stateOwner.set(id, owner);
    }
    return id;
  }

  // ── 화면 이동 ──
  function literalPaths(e: ts.Node | undefined): string[] | null {
    if (!e) return null;
    if (ts.isJsxExpression(e)) return literalPaths(e.expression);
    if (ts.isParenthesizedExpression(e)) return literalPaths(e.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
    if (ts.isConditionalExpression(e)) {
      const a = literalPaths(e.whenTrue), b = literalPaths(e.whenFalse);
      return a && b ? [...a, ...b] : null;
    }
    return null;
  }
  function navigateTo(owner: string, arg: ts.Node | undefined, at: ts.Node, how: string, trigger?: string) {
    const paths = literalPaths(arg);
    if (!paths) return addGap(owner, at, `${how} 경로`, { t: 'gap', status: 'unanalyzed', reason: '이동할 경로가 실행 시점 값으로 정해져 정적으로 알 수 없습니다.' }, trigger);
    const cond = paths.length > 1 ? ' (조건에 따라)' : '';
    const prefix = !trigger ? '' : trigger === '링크 클릭' ? '링크 클릭 시 ' : `${trigger} 안에서 `;
    for (const p of paths) {
      const label = `${how} → ${p}${cond}`;
      addRel(owner, routeId(p.split(/[?#]/)[0]), 'navigate', prefix + label, loc(at, label), trigger);
    }
  }

  // ── 호출 ──
  function onCall(call: ts.CallExpression) {
    const { owner, trigger } = context(call);
    const c = call.expression;
    const label = (s: string) => (trigger ? `${trigger} 안에서 ${s}` : s);
    if (ts.isIdentifier(c) || ts.isPropertyAccessExpression(c)) {
      const name = ts.isIdentifier(c) ? c.text : c.name.text;
      const t = resolve(ts.isIdentifier(c) ? c : c.name);
      if (t.t === 'unit') return addRel(owner, unitId(t.fn), 'call', label(`${name}()`), loc(call, `${name}() 호출`), trigger);
      if (t.t === 'state') return addRel(owner, stateId(t), 'setState', label(`${t.setter}(…)`), loc(call, `${t.setter} 호출`), trigger);
      if (t.t === 'navigate') return navigateTo(owner, call.arguments[0], call, `${name}()`, trigger);
      if (ts.isIdentifier(c)) {
        if (t.t === 'gap') return addGap(owner, call, `${name}()`, t, trigger);
        if (t.t === 'data') return addGap(owner, call, `${name}()`, { t: 'gap', status: 'unanalyzed', reason: '변수에 담긴 함수입니다. 어떤 함수인지 정적으로 확정하지 않았습니다.' }, trigger);
        return;
      }
      // obj.method(): 프로젝트 함수로 해석되지 않으면 외부·내장 메서드로 보고 넘어간다. 단, 컴포넌트 props에서 꺼낸 함수는 표시한다.
      if (isPropsObject(c.expression)) addGap(owner, call, `${short(c)}()`, PARAM_FN, trigger);
      return;
    }
    if (c.kind === ts.SyntaxKind.ImportKeyword) return addGap(owner, call, 'import()', { t: 'gap', status: 'unanalyzed', reason: '동적 import는 분석하지 않습니다.' }, trigger);
    if (c.kind === ts.SyntaxKind.SuperKeyword) return;
    addGap(owner, call, `${short(c)}()`, {
      t: 'gap', status: 'unanalyzed',
      reason: ts.isElementAccessExpression(c) ? '동적 호출(obj[key]())입니다. 어떤 함수가 불릴지 실행 시점에 정해집니다.' : '호출 대상이 식으로 계산되는 동적 호출입니다.',
    }, trigger);
  }

  // ── JSX ──
  function visibleText(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement) {
    if (!ts.isJsxOpeningElement(el)) return '';
    return el.parent.children.filter(ts.isJsxText).map((t) => t.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 20);
  }
  const attr = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) =>
    el.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
  /** <Route>의 전체 경로. 중첩 Route의 상대 경로는 바깥 Route 경로에 붙인다. 경로가 식이면 null */
  function routePath(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | null {
    const a = attr(el, 'path');
    const own = a ? literalPaths(a.initializer) : null;
    if (a ? own?.length !== 1 : !attr(el, 'index')) return null; // 동적 경로이거나 경로 없는 레이아웃 Route
    const parts = [own?.[0] ?? ''];
    for (let p: ts.Node | undefined = el.parent; p && !parts[0].startsWith('/'); p = p.parent) {
      if (ts.isJsxElement(p) && p.openingElement !== el && isExt(p.openingElement.tagName, ROUTER, /^Route$/)) {
        const pp = literalPaths(attr(p.openingElement, 'path')?.initializer)?.[0];
        if (pp !== undefined) parts.unshift(pp);
      }
    }
    return ('/' + parts.join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  }

  function onJsx(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement) {
    const { owner, trigger } = context(el);
    const tag = el.tagName;
    const intrinsic = ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);

    for (const a of el.attributes.properties) {
      if (!ts.isJsxAttribute(a) || !/^on[A-Z]/.test(a.name.getText()) || !a.initializer || !ts.isJsxExpression(a.initializer) || !a.initializer.expression) continue;
      const ev = a.name.getText(), ex = a.initializer.expression;
      if (isFn(ex)) continue; // 인라인 함수: 안의 호출을 onCall이 이 이벤트 계기로 기록한다
      const text = intrinsic ? visibleText(el) : '';
      const evLabel = `${ev}${intrinsic ? '' : ' (컴포넌트에 전달)'}${text ? ` · “${text}”` : ''}`;
      if (!ts.isIdentifier(ex) && !ts.isPropertyAccessExpression(ex)) {
        addGap(owner, a, `${ev}={${short(ex)}}`, { t: 'gap', status: 'unanalyzed', reason: '이벤트에 연결된 값이 식으로 계산되어 대상을 확정하지 못했습니다.' }, trigger);
        continue;
      }
      const t = resolve(ts.isIdentifier(ex) ? ex : ex.name);
      if (t.t === 'unit') {
        const id = unitId(t.fn);
        if (intrinsic) eventBound.add(id);
        addRel(owner, id, 'event', evLabel, loc(a, evLabel), ev);
      } else if (t.t === 'state') addRel(owner, stateId(t), 'setState', `${evLabel} → ${t.setter}`, loc(a, evLabel), ev);
      else if (t.t === 'gap' || t.t === 'data' || ts.isPropertyAccessExpression(ex)) {
        const g: Gap = t.t === 'gap' && !t.soft ? t : ts.isPropertyAccessExpression(ex) && isPropsObject(ex.expression)
          ? PARAM_FN : { t: 'gap', status: 'unanalyzed', reason: '이벤트에 연결된 함수를 프로젝트 안에서 확정하지 못했습니다.' };
        addGap(owner, a, `${ev}={${short(ex)}}`, g, ev);
      }
    }

    if (intrinsic) return;
    if (isExt(tag, ROUTER, /^Route$/)) {
      const path = routePath(el);
      if (path !== null) {
        const rid = routeId(path, el);
        addRel(owner, rid, 'render', `<Route path="${path}">`, loc(el, `<Route path="${path}">`), trigger);
        const inner = attr(el, 'element')?.initializer;
        const jsx = inner && ts.isJsxExpression(inner) ? inner.expression : undefined;
        const open = jsx && (ts.isJsxSelfClosingElement(jsx) ? jsx : ts.isJsxElement(jsx) ? jsx.openingElement : undefined);
        if (open) {
          const t = resolve(ts.isPropertyAccessExpression(open.tagName) ? open.tagName.name : open.tagName);
          if (t.t === 'unit') { routeElements.add(open); routed.add(unitId(t.fn)); addRel(rid, unitId(t.fn), 'render', '이 경로에서 표시', loc(open, '경로의 화면'), undefined); }
        }
      }
      return;
    }
    if (isExt(tag, ROUTER, /^(Link|NavLink)$/)) return navigateTo(owner, attr(el, 'to')?.initializer, el, `<${tag.getText()}>`, trigger ?? '링크 클릭');
    if (isExt(tag, ROUTER, /^Navigate$/)) return navigateTo(owner, attr(el, 'to')?.initializer, el, '<Navigate>', trigger);
    if (routeElements.has(el)) return;
    const t = resolve(ts.isPropertyAccessExpression(tag) ? tag.name : tag);
    const name = tag.getText();
    if (t.t === 'unit') addRel(owner, unitId(t.fn), 'render', trigger ? `${trigger} 안에서 <${name}>` : `<${name}>`, loc(el, `<${name}>`), trigger);
    else if (t.t === 'gap' && !t.soft) addGap(owner, el, `<${name}>`, t, trigger);
  }

  // ── 다른 파일의 최상위 값 참조 (데이터 참조) ──
  function onIdentifier(id: ts.Identifier) {
    const p = id.parent;
    if ((ts.isCallExpression(p) && p.expression === id) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)
      || ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p) || ts.isTypeQueryNode(p)
      || (ts.isPropertyAccessExpression(p) && p.name === id) || ((p as ts.NamedDeclaration).name === id)) return;
    const sym = checker.getSymbolAtLocation(id);
    if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return; // 다른 파일 값은 반드시 import를 거친다
    const t = resolve(id);
    if (t.t !== 'data') return;
    const d = t.decl;
    if (!ts.isVariableStatement(d.parent.parent) || !ts.isSourceFile(d.parent.parent.parent) || !ts.isIdentifier(d.name)) return;
    const { owner, trigger } = context(id);
    const did = `data:${fileOf(d)}#${d.name.text}`;
    if (!nodes.has(did)) nodes.set(did, {
      id: did, title: d.name.text, kind: 'data', provenance: S, verification: { status: 'confirmed' },
      summary: `${fileOf(d)}에 선언된 최상위 값입니다. 실행 중 바뀌는지는 분석하지 않습니다.`, locations: [loc(d, `${d.name.text} 선언`)],
    });
    addRel(owner, did, 'data', trigger ? `${trigger} 안에서 ${d.name.text} 참조` : `${d.name.text} 참조`, loc(id, `${d.name.text} 참조`), trigger);
  }

  // ── 순회 ──
  const analyzed: string[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !has(rel(sf.fileName))) continue;
    analyzed.push(rel(sf.fileName));
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && REACT.test((n.moduleSpecifier as ts.StringLiteral).text)) usesReact = true;
      if (isFn(n) && unitName(n)) unitId(n);
      if (ts.isCallExpression(n)) onCall(n);
      else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) onJsx(n);
      else if (ts.isIdentifier(n)) onIdentifier(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // ── 정리: 관계 없는 일반 함수는 빼고, 종류를 확정 ──
  const relList = [...rels.values()];
  const touched = new Set(relList.flatMap((r) => [r.from, r.to]));
  for (const [id, n] of nodes) {
    if (n.kind === 'logic' && !touched.has(id)) nodes.delete(id);
    if (n.kind === 'module' && !touched.has(id)) nodes.delete(id);
    if (routed.has(id)) { n.kind = 'page'; n.summary = `경로(<Route>)에 연결된 화면 컴포넌트 · ${n.locations[0].file}`; }
    else if (eventBound.has(id) && n.kind === 'logic') { n.kind = 'event'; n.summary = `JSX 이벤트에 직접 연결된 함수 · ${n.summary.replace(/^함수 · /, '')}`; }
  }

  const broken = new Set(parseErrors.map((e) => e.file));
  for (const n of nodes.values()) if (n.locations.some((l) => broken.has(l.file))) n.summary += ' · 이 파일에 문법 오류가 있어 관계가 빠졌거나 틀렸을 수 있음';

  const flows = buildFlows(nodes, relList, stateOwner);
  return {
    project: {
      id: meta.id, name: meta.name, sourceName: meta.sourceName,
      stack: usesReact ? 'React + TypeScript (자동 판별: react import 있음)' : 'TypeScript (react import를 찾지 못함)',
      description: `${analyzed.length}개 .ts/.tsx 파일을 구문 분석했습니다.`,
    },
    provenance: S,
    notice: '업로드한 ZIP의 .ts/.tsx를 TypeScript 구문 분석으로 읽고, 코드에서 직접 확인한 관계만 표시한 자동 분석 결과입니다. 기능 이름은 추정하지 않고 코드의 이름을 그대로 씁니다.',
    nodes: [...nodes.values()],
    relations: relList,
    features: flows.map((f) => {
      const entry = nodes.get(f.featureId.slice('feat:'.length))!;
      const first = relList.filter((r) => r.from === entry.id && r.kind !== 'render');
      const ev = first.filter((r) => r.trigger).length;
      const gaps = f.steps.filter((s) => s.verification.status === 'unconfirmed').length;
      return { id: f.featureId, title: entry.title, entryNodeId: entry.id, flowId: f.id,
        summary: `그릴 때 관계 ${first.length - ev} · 이벤트·콜백 관계 ${ev} · 끊긴 지점 ${gaps}` };
    }).sort((a, b) => Number(nodes.get(b.entryNodeId)!.kind === 'page') - Number(nodes.get(a.entryNodeId)!.kind === 'page') || a.title.localeCompare(b.title)),
    flows,
    scope: { ...(scope ?? { analyzedFiles: analyzed, excluded: [], entryCount: analyzed.length }), parseErrors },
  };
}

// ── 상세 흐름: 컴포넌트 하나에서 직접 확인한 관계를 따라간다 ──
const FLOW_KIND: Record<StructureRelationKind, FlowRelationKind> = {
  call: 'call', event: 'event', setState: 'setState', navigate: 'navigate', data: 'data', render: 'render', unresolved: 'gap',
};
const KIND_TEXT: Record<string, string> = {
  logic: '함수', event: '이벤트 함수', state: 'React 상태', data: '데이터(최상위 값)', routing: '화면 경로', page: '화면 컴포넌트', ui: '컴포넌트', gap: '추적이 끊긴 지점', module: '파일 최상위 코드',
};
const MAX_DEPTH = 4, MAX_STEPS = 30;

function buildFlows(nodes: Map<string, MapNode>, rels: StructureRelation[], stateOwner: Map<string, string>): Flow[] {
  const out = (id: string) => rels.filter((r) => r.from === id);
  const flows: Flow[] = [];
  for (const comp of nodes.values()) {
    if (comp.kind !== 'page' && comp.kind !== 'ui') continue;
    if (!out(comp.id).some((r) => r.kind !== 'render')) continue;
    const fid = `flow:${comp.id}`;
    const order = [comp.id], depth = new Map([[comp.id, 0]]), incoming = new Map<string, string[]>();
    const relations: FlowRelation[] = [];
    for (let i = 0; i < order.length; i++) {
      const cur = order[i], kind = nodes.get(cur)!.kind;
      const expand = cur === comp.id || kind === 'logic' || kind === 'event' || kind === 'routing';
      if (!expand || depth.get(cur)! >= MAX_DEPTH) continue;
      // 그릴 때 관계를 먼저, 이벤트·콜백 관계를 뒤에 (읽기 순서일 뿐 실행 순서가 아니다)
      const edges = out(cur).filter((r) => (kind === 'routing') === (r.kind === 'render')).sort((a, b) => Number(!!a.trigger) - Number(!!b.trigger));
      for (const r of edges) {
        if (!nodes.has(r.to)) continue;
        const label = cur === comp.id && !r.trigger ? `그릴 때: ${r.label}` : r.label;
        relations.push({ id: `${fid}:${r.id}`, from: cur, to: r.to, kind: FLOW_KIND[r.kind], label });
        incoming.set(r.to, [...(incoming.get(r.to) ?? []), label]);
        if (!depth.has(r.to) && order.length < MAX_STEPS) { depth.set(r.to, depth.get(cur)! + 1); order.push(r.to); }
      }
    }
    for (const id of order) {
      if (stateOwner.get(id) === comp.id) relations.push({ id: `${fid}:rerender:${id}`, from: id, to: comp.id, kind: 'rerender', label: '상태가 바뀌면 다시 그려질 수 있음' });
    }
    const steps = order.map((id) => {
      const n = nodes.get(id)!;
      const how = incoming.get(id);
      const explanation = id === comp.id
        ? `${n.title}이(가) 그려질 때 실행되는 코드와 JSX에 연결된 이벤트를 따라갑니다. React는 상태가 바뀌면 다시 그리고, 조건에 따라 일부만 실행하므로 이 단계 순서는 실제 실행 순서가 아니라 읽기 순서입니다.`
        : `${KIND_TEXT[n.kind] ?? n.kind}. ${how ? `연결: ${[...new Set(how)].join(' / ')}. ` : ''}${n.summary}`;
      return { id, title: n.title, explanation, locations: n.locations, provenance: S, verification: n.verification };
    });
    flows.push({
      id: fid, featureId: `feat:${comp.id}`, title: `${comp.title}에서 시작하는 흐름`, steps, relations,
      caveat: `정적 분석으로 찾은 가능한 흐름입니다. 실제 실행 기록이 아니며, 렌더링·조건 분기·상태 업데이트를 한 줄의 실행 순서로 단정하지 않습니다. 깊이 ${MAX_DEPTH}단계·${MAX_STEPS}개까지만 따라갑니다.`,
    });
  }
  return flows;
}
