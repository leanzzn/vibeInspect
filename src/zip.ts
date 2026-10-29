// 브라우저 안에서 프로젝트 ZIP을 읽는다. 서버에 파일을 쓰지 않고, 내용을 실행하지 않는다.
// 중앙 디렉터리만 먼저 읽어 제외 대상을 걸러 낸 뒤, 남은 파일만 실제 해제 크기를 세면서 푼다.

const MB = 1024 * 1024;
export const LIMITS = {
  /** 업로드 ZIP 자체 크기 */
  zipBytes: 50 * MB,
  /** ZIP 안의 항목 수(폴더·제외 대상 포함) */
  entries: 20000,
  /** 분석 대상으로 남는 파일 수 */
  files: 2000,
  /** 분석 대상 파일 하나의 해제 크기 */
  fileBytes: 1 * MB,
  /** 분석 대상 파일 전체의 실제 해제 크기 합 */
  totalBytes: 20 * MB,
};
export type Limits = typeof LIMITS;

export const EXCLUDED_DIRS = ['node_modules', 'dist', 'build', '.git', '.cache', '.vite', '.next', '.turbo', '.parcel-cache', 'coverage', '__MACOSX'];
export const ANALYZED_EXT = ['.ts', '.tsx'];

export class ZipError extends Error {}

export interface ZipResult {
  /** ZIP 최상위 공통 폴더를 뺀 상대 경로 → 원문 */
  files: Record<string, string>;
  excluded: { path: string; reason: string }[];
  entryCount: number;
  /** 벗겨 낸 공통 최상위 폴더 (없으면 '') */
  root: string;
}

const SENSITIVE = [
  /^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc)$/i, /secret|credential|passw(or)?d|service-?account/i,
];

/** 환경 변수·인증 정보로 보이는 파일 이름인가 (경로의 마지막 부분 기준) */
export const isSensitiveName = (path: string) => SENSITIVE.some((r) => r.test(path.split('/').pop() ?? ''));

/** 위험한 경로면 사유를, 아니면 null */
export function unsafePathReason(name: string): string | null {
  if (/[\0-\x1f]/.test(name)) return '이름에 제어 문자가 있음';
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return '절대 경로';
  if (p.split('/').includes('..')) return '상위 폴더로 벗어나는 경로(..)';
  return null;
}

const normalize = (name: string) => name.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/');

/** 압축 해제 전에 판단할 수 있는 제외 사유 (경로 기준) */
export function excludeReason(path: string): string | null {
  const parts = path.split('/');
  const dir = parts.slice(0, -1).find((d) => EXCLUDED_DIRS.includes(d));
  if (dir) return `제외 폴더 (${dir})`;
  const base = parts[parts.length - 1];
  if (isSensitiveName(base)) return '환경 변수·인증 정보로 보이는 파일';
  if (!ANALYZED_EXT.some((e) => base.endsWith(e))) return '분석 범위 밖 형식 (.ts/.tsx만 분석)';
  return null;
}

async function inflateRaw(data: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // 실제로 풀린 바이트 수로 판단한다 (헤더에 적힌 크기를 믿지 않는다)
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ZipError('압축을 푼 크기가 ZIP에 기록된 크기를 넘었습니다. 압축 폭탄이거나 손상된 ZIP일 수 있어 중단했습니다.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function readProjectZip(data: Uint8Array, limits: Limits = LIMITS): Promise<ZipResult> {
  const mb = (n: number) => `${Math.round(n / MB)}MB`;
  if (data.length > limits.zipBytes) throw new ZipError(`ZIP 파일이 ${mb(limits.zipBytes)}를 넘습니다. node_modules·dist 등을 빼고 다시 압축해 주세요.`);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // ── 중앙 디렉터리 끝(EOCD) 찾기 ──
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('ZIP 파일 형식이 아닙니다(중앙 디렉터리를 찾지 못함).');
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOff = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) throw new ZipError('ZIP64 형식은 지원하지 않습니다.');
  if (count > limits.entries) throw new ZipError(`ZIP 안의 항목이 ${count}개로 제한(${limits.entries}개)을 넘습니다.`);
  if (cdOff + cdSize > eocd) throw new ZipError('ZIP 구조가 손상되었습니다.');

  // ── 항목 목록 (압축은 아직 풀지 않음) ──
  interface Entry { path: string; flags: number; method: number; csize: number; usize: number; local: number; symlink: boolean }
  const entries: Entry[] = [];
  const excluded: ZipResult['excluded'] = [];
  const dec = new TextDecoder();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) throw new ZipError('ZIP 구조가 손상되었습니다(항목 헤더 불일치).');
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nlen));
    const unixMode = v.getUint16(p + 4, true) >> 8 === 3 ? v.getUint32(p + 38, true) >>> 16 : 0;
    const e: Entry = {
      path: name, flags: v.getUint16(p + 8, true), method: v.getUint16(p + 10, true),
      csize: v.getUint32(p + 20, true), usize: v.getUint32(p + 24, true), local: v.getUint32(p + 42, true),
      symlink: (unixMode & 0o170000) === 0o120000,
    };
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || name.endsWith('\\')) continue; // 폴더 항목
    const bad = unsafePathReason(name);
    if (bad) { excluded.push({ path: name, reason: `위험한 경로: ${bad}` }); continue; }
    entries.push({ ...e, path: normalize(name) });
  }

  // ── 같은 경로가 두 번 이상 나오면(대소문자 무시) 어느 쪽도 믿지 않는다 ──
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.path.toLowerCase(), (seen.get(e.path.toLowerCase()) ?? 0) + 1);

  // ── 공통 최상위 폴더(예: test_code/) 벗기기. 그 바로 아래에 package.json·tsconfig.json이 있을 때만 프로젝트 루트로 본다 ──
  const first = entries[0]?.path.split('/')[0];
  const root = first && entries.every((e) => e.path.startsWith(first + '/'))
    && entries.some((e) => e.path === `${first}/package.json` || e.path === `${first}/tsconfig.json`) ? first + '/' : '';

  const keep: Entry[] = [];
  for (const e of entries) {
    const rel = e.path.slice(root.length);
    const reason =
      (seen.get(e.path.toLowerCase())! > 1 && '중복 경로') ||
      (e.symlink && '심볼릭 링크') ||
      excludeReason(rel) ||
      ((e.flags & 1) !== 0 && '암호화된 항목') ||
      (e.method !== 0 && e.method !== 8 && `지원하지 않는 압축 방식(${e.method})`) ||
      (e.usize > limits.fileBytes && `파일 하나 크기 제한(${mb(limits.fileBytes)}) 초과`) ||
      null;
    if (reason) excluded.push({ path: rel, reason });
    else keep.push({ ...e, path: rel });
  }
  if (keep.length > limits.files) throw new ZipError(`분석 대상 파일이 ${keep.length}개로 제한(${limits.files}개)을 넘습니다.`);

  // ── 남은 파일만 실제로 푼다 ──
  const files: Record<string, string> = {};
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  for (const e of keep) {
    if (e.local + 30 > data.length || v.getUint32(e.local, true) !== 0x04034b50) throw new ZipError(`ZIP 구조가 손상되었습니다: ${e.path}`);
    const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
    if (start + e.csize > data.length) throw new ZipError(`ZIP 구조가 손상되었습니다: ${e.path}`);
    if (total + e.usize > limits.totalBytes) throw new ZipError(`분석 대상 파일의 압축 해제 크기 합이 제한(${mb(limits.totalBytes)})을 넘습니다.`);
    const raw = data.subarray(start, start + e.csize);
    let bytes: Uint8Array;
    if (e.method === 0) {
      if (e.csize !== e.usize) throw new ZipError(`ZIP 구조가 손상되었습니다: ${e.path}`);
      bytes = raw;
    } else {
      bytes = await inflateRaw(raw, e.usize);
    }
    total += bytes.length;
    let text: string;
    try {
      if (bytes.includes(0)) throw new Error();
      text = utf8.decode(bytes);
    } catch {
      excluded.push({ path: e.path, reason: '텍스트가 아님(바이너리로 보임)' });
      continue;
    }
    files[e.path] = text.replace(/\r\n/g, '\n');
  }
  return { files, excluded, entryCount: count, root: root.replace(/\/$/, '') };
}
