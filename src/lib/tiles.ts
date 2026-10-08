import sharp from "sharp";

// 画面差分：把新帧和"客户端当前显示的画面"逐块比较，只编码并发送变化的矩形。
// 敲一个字母只会改动几十个像素，传几 KB 即可，而不是整屏 JPEG。

sharp.cache(false);
sharp.concurrency(2);

export type Raw = { data: Buffer; w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Piece = Rect & { data: Buffer };

const T = 32; // 比较块大小
const TH = 10; // 单通道差值小于此值视为 JPEG 噪声，不算变化

export async function decode(jpeg: Buffer): Promise<Raw> {
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

export function sameSize(a: Raw | null, b: Raw): a is Raw {
  return !!a && a.w === b.w && a.h === b.h;
}

function tileChanged(prev: Raw, cur: Raw, x0: number, y0: number, x1: number, y1: number) {
  const { w } = cur;
  const len = (x1 - x0) * 3;
  for (let y = y0; y < y1; y++) {
    const o = (y * w + x0) * 3;
    if (prev.data.compare(cur.data, o, o + len, o, o + len) === 0) continue;
    for (let i = o; i < o + len; i++) {
      const d = prev.data[i] - cur.data[i];
      if (d > TH || d < -TH) return true;
    }
  }
  return false;
}

/** 返回变化的矩形；"full" 表示变化太大，应整帧发送；空数组表示没有可见变化 */
export function diffRects(prev: Raw, cur: Raw): Rect[] | "full" {
  const { w, h } = cur;
  const cols = Math.ceil(w / T);
  const rows = Math.ceil(h / T);
  const runs: { r: number; c0: number; c1: number }[] = [];
  let changedTiles = 0;

  for (let r = 0; r < rows; r++) {
    const y0 = r * T;
    const y1 = Math.min(h, y0 + T);
    const s = y0 * w * 3;
    const e = y1 * w * 3;
    if (prev.data.compare(cur.data, s, e, s, e) === 0) continue; // 整条带完全相同，最快路径
    let start = -1;
    for (let c = 0; c <= cols; c++) {
      const ch = c < cols && tileChanged(prev, cur, c * T, y0, Math.min(w, (c + 1) * T), y1);
      if (ch) {
        changedTiles++;
        if (start < 0) start = c;
      } else if (start >= 0) {
        runs.push({ r, c0: start, c1: c });
        start = -1;
      }
    }
  }
  if (!runs.length) return [];
  if (changedTiles > cols * rows * 0.5) return "full";

  // 纵向合并相同列范围的相邻行
  let rects: Rect[] = [];
  const open = new Map<string, Rect>();
  let lastRow = -2;
  for (const run of runs) {
    if (run.r !== lastRow) {
      if (run.r !== lastRow + 1) open.clear();
      lastRow = run.r;
    }
    const key = `${run.c0}:${run.c1}`;
    const ex = open.get(key);
    const y1 = Math.min(h, (run.r + 1) * T);
    if (ex && ex.y + ex.h === run.r * T) {
      ex.h = y1 - ex.y;
    } else {
      const rc = { x: run.c0 * T, y: run.r * T, w: Math.min(w, run.c1 * T) - run.c0 * T, h: y1 - run.r * T };
      rects.push(rc);
      open.set(key, rc);
    }
  }

  // 贪心合并：并集面积不比两者之和大太多就合并，减少编码次数和包头开销
  const area = (r: Rect) => r.w * r.h;
  const union = (a: Rect, b: Rect): Rect => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  let merged = true;
  while (merged && rects.length > 1) {
    merged = false;
    outer: for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const u = union(rects[i], rects[j]);
        if (area(u) <= (area(rects[i]) + area(rects[j])) * 1.35 + 2048) {
          rects = rects.filter((_, k) => k !== i && k !== j);
          rects.push(u);
          merged = true;
          break outer;
        }
      }
    }
  }
  while (rects.length > 6) {
    const a = rects.pop()!;
    const b = rects.pop()!;
    rects.push(union(a, b));
  }
  const total = rects.reduce((n, r) => n + area(r), 0);
  if (total > w * h * 0.6) return "full";
  return rects;
}

export async function encodeRects(
  cur: Raw,
  rects: Rect[],
  quality: number,
  chroma: "4:4:4" | "4:2:0" = "4:4:4",
): Promise<Piece[]> {
  return Promise.all(
    rects.map(async (r) => ({
      ...r,
      data: await sharp(cur.data, { raw: { width: cur.w, height: cur.h, channels: 3 } })
        .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
        .jpeg({ quality, chromaSubsampling: chroma })
        .toBuffer(),
    })),
  );
}

export async function encodeScaled(cur: Raw, scale: number, quality: number): Promise<{ data: Buffer; w: number; h: number }> {
  const w = Math.max(80, Math.round(cur.w * scale));
  const h = Math.max(60, Math.round(cur.h * scale));
  const img = sharp(cur.data, { raw: { width: cur.w, height: cur.h, channels: 3 } });
  const data = await (scale < 1 ? img.resize(w, h, { kernel: "linear" }) : img).jpeg({ quality }).toBuffer();
  return { data, w: scale < 1 ? w : cur.w, h: scale < 1 ? h : cur.h };
}

export async function encodeFull(cur: Raw, quality: number) {
  return sharp(cur.data, { raw: { width: cur.w, height: cur.h, channels: 3 } }).jpeg({ quality }).toBuffer();
}

/** 把已发送的矩形同步进"客户端画面"副本 */
export function applyRects(prev: Raw, cur: Raw, rects: Rect[]) {
  for (const r of rects) {
    const len = r.w * 3;
    for (let y = r.y; y < r.y + r.h; y++) {
      const o = (y * cur.w + r.x) * 3;
      cur.data.copy(prev.data, o, o, o + len);
    }
  }
}

/**
 * 消息格式（服务器 -> 浏览器，二进制）:
 * u32 id | u8 flags(bit0=整帧) | u16 W | u16 H | f32 scrollY | u8 n
 * 然后 n 个: u16 x | u16 y | u16 w | u16 h | u32 len | JPEG
 * 矩形坐标均为原始分辨率；JPEG 自身尺寸可以更小（降采样整帧），客户端拉伸到矩形内。
 */
export function pack(id: number, full: boolean, W: number, H: number, scrollY: number, pieces: Piece[]) {
  const size = 14 + pieces.reduce((n, p) => n + 12 + p.data.length, 0);
  const out = Buffer.allocUnsafe(size);
  out.writeUInt32BE(id, 0);
  out.writeUInt8(full ? 1 : 0, 4);
  out.writeUInt16BE(W, 5);
  out.writeUInt16BE(H, 7);
  out.writeFloatBE(scrollY, 9);
  out.writeUInt8(pieces.length, 13);
  let o = 14;
  for (const p of pieces) {
    out.writeUInt16BE(p.x, o);
    out.writeUInt16BE(p.y, o + 2);
    out.writeUInt16BE(p.w, o + 4);
    out.writeUInt16BE(p.h, o + 6);
    out.writeUInt32BE(p.data.length, o + 8);
    p.data.copy(out, o + 12);
    o += 12 + p.data.length;
  }
  return out;
}
