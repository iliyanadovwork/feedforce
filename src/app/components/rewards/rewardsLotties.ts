// Hand-authored Lottie animations for the Rewards "How it works" boxes — small looping shape
// animations in the app's white-on-dark palette (the boxes render on a fixed dark tile), bundled as
// plain JSON objects so nothing is fetched at runtime. Rendered by lottie-react (client-only).
//
// Lottie schema cheat-sheet for future edits: a document is {v, fr, ip, op, w, h, layers}. A shape
// layer (ty:4) has transform `ks` (o/r/p/a/s) and `shapes` (groups `gr` of primitives: rc rect,
// el ellipse, sh path + fl fill, st stroke, tm trim). Animated properties use {a:1, k:[keyframes]}.

const ZINC = [0.35, 0.35, 0.4, 1];
const WHITE = [1, 1, 1, 1];
const INK = [0.04, 0.04, 0.04, 1];

// Standard ease-in-out keyframe pair helpers.
const EASE_I = { x: [0.4], y: [1] };
const EASE_O = { x: [0.6], y: [0] };
const kf = (t: number, s: number[]) => ({ i: EASE_I, o: EASE_O, t, s });

const staticTransform = { p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } };
const layerKs = (p: (number | object)[] | object, s?: object, o?: object) => ({
  o: o ?? { a: 0, k: 100 },
  r: { a: 0, k: 0 },
  p: Array.isArray(p) ? { a: 0, k: p } : p,
  a: { a: 0, k: [0, 0, 0] },
  s: s ?? { a: 0, k: [100, 100, 100] },
});
const doc = (op: number, layers: object[]) => ({ v: '5.7.4', fr: 60, ip: 0, op, w: 120, h: 120, nm: 'rewards', ddd: 0, assets: [], layers });
const fill = (c: number[], o = 100) => ({ ty: 'fl', c: { a: 0, k: c }, o: { a: 0, k: o }, r: 1 });
const stroke = (c: number[], w: number) => ({ ty: 'st', c: { a: 0, k: c }, o: { a: 0, k: 100 }, w: { a: 0, k: w }, lc: 2, lj: 2 });
const group = (...it: object[]) => ({ ty: 'gr', it: [...it, { ty: 'tr', ...staticTransform }] });
const shapeLayer = (ind: number, op: number, ks: object, ...shapes: object[]) => ({ ddd: 0, ind, ty: 4, nm: `l${ind}`, sr: 1, ks, ao: 0, shapes, ip: 0, op, st: 0, bm: 0 });

/** 1. Join: a badge with a check that draws itself on. */
export const lottieJoin = doc(150, [
  shapeLayer(
    1, 150, layerKs([60, 60, 0]),
    group(
      { ty: 'sh', d: 1, ks: { a: 0, k: { i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]], v: [[-16, 2], [-5, 13], [16, -9]], c: false } } },
      { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [kf(10, [0]), { t: 45, s: [100] }] }, o: { a: 0, k: 0 }, m: 1 },
      stroke(INK, 9),
    ),
  ),
  shapeLayer(
    2, 150, layerKs([60, 60, 0], { a: 1, k: [kf(0, [100, 100, 100]), kf(75, [106, 106, 100]), { t: 150, s: [100, 100, 100] }] }),
    group({ ty: 'el', d: 1, s: { a: 0, k: [72, 72] }, p: { a: 0, k: [0, 0] } }, fill(WHITE)),
  ),
]);

/** 2. Sticker toggle: a switch flipping on (and back, so the loop reads as a toggle). */
export const lottieToggle = doc(180, [
  shapeLayer(
    1, 180,
    layerKs({ a: 1, k: [kf(0, [46, 60, 0]), kf(25, [74, 60, 0]), kf(115, [74, 60, 0]), { t: 140, s: [46, 60, 0] }] }),
    group(
      { ty: 'el', d: 1, s: { a: 0, k: [26, 26] }, p: { a: 0, k: [0, 0] } },
      { ty: 'fl', c: { a: 1, k: [kf(0, WHITE), kf(25, INK), kf(115, INK), { t: 140, s: WHITE }] }, o: { a: 0, k: 100 }, r: 1 },
    ),
  ),
  shapeLayer(
    2, 180, layerKs([60, 60, 0]),
    group(
      { ty: 'rc', d: 1, s: { a: 0, k: [64, 36] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 18 } },
      { ty: 'fl', c: { a: 1, k: [kf(0, ZINC), kf(25, WHITE), kf(115, WHITE), { t: 140, s: ZINC }] }, o: { a: 0, k: 100 }, r: 1 },
    ),
  ),
]);

/** 3. Views: three bars growing, the tallest in white. */
const bar = (ind: number, x: number, h: number, t0: number, c: number[]) =>
  shapeLayer(
    ind, 180,
    layerKs([x, 88, 0], { a: 1, k: [kf(t0, [100, 0, 100]), { t: t0 + 30, s: [100, 100, 100] }] }),
    group({ ty: 'rc', d: 1, s: { a: 0, k: [16, h] }, p: { a: 0, k: [0, -h / 2] }, r: { a: 0, k: 4 } }, fill(c)),
  );
export const lottieViews = doc(180, [bar(1, 36, 28, 10, ZINC), bar(2, 60, 44, 25, ZINC), bar(3, 84, 62, 40, WHITE)]);

/** 4. Pool: a vessel filling to exactly half (50% of revenue). */
export const lottiePool = doc(200, [
  shapeLayer(
    1, 200,
    layerKs([60, 82, 0], { a: 1, k: [kf(10, [100, 0, 100]), { t: 60, s: [100, 50, 100] }] }),
    group({ ty: 'rc', d: 1, s: { a: 0, k: [44, 48] }, p: { a: 0, k: [0, -24] }, r: { a: 0, k: 4 } }, fill(WHITE)),
  ),
  shapeLayer(
    2, 200, layerKs([60, 58, 0]),
    group({ ty: 'rc', d: 1, s: { a: 0, k: [52, 52] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 10 } }, stroke(ZINC, 4)),
  ),
]);

/** 5. Payout: a coin bouncing over its shadow. */
export const lottiePayout = doc(120, [
  shapeLayer(
    1, 120,
    layerKs({ a: 1, k: [kf(0, [60, 62, 0]), kf(30, [60, 46, 0]), { t: 60, s: [60, 62, 0] }] }),
    group({ ty: 'el', d: 1, s: { a: 0, k: [30, 30] }, p: { a: 0, k: [0, 0] } }, stroke(INK, 4)),
    group({ ty: 'el', d: 1, s: { a: 0, k: [48, 48] }, p: { a: 0, k: [0, 0] } }, fill(WHITE)),
  ),
  shapeLayer(
    2, 120,
    layerKs([60, 92, 0], { a: 1, k: [kf(0, [100, 100, 100]), kf(30, [70, 100, 100]), { t: 60, s: [100, 100, 100] }] }, { a: 0, k: 18 }),
    group({ ty: 'el', d: 1, s: { a: 0, k: [40, 9] }, p: { a: 0, k: [0, 0] } }, fill(ZINC)),
  ),
]);
