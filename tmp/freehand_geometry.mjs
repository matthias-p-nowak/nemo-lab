const EPS = 1e-9;
const CUT_EPS = 1e-8;
const KEY_SCALE = 1000; // 1e-3 snap

export function p(x, y) {
  return { x: Number(x), y: Number(y) };
}

function sub(a, b) {
  return p(a.x - b.x, a.y - b.y);
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(a, b, t) {
  return p(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

function segParam(pointOnSegment, a, b) {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom <= EPS) return 0;
  return dot(sub(pointOnSegment, a), ab) / denom;
}

export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let acc = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    acc += a.x * b.y - b.x * a.y;
  }
  return Math.abs(acc) * 0.5;
}

function signedArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let acc = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    acc += a.x * b.y - b.x * a.y;
  }
  return acc * 0.5;
}

function ensureCCW(points) {
  return signedArea(points) < 0 ? points.slice().reverse() : points.slice();
}

function dedupeConsecutive(points, eps = 1e-6) {
  const out = [];
  for (const pt of points) {
    if (out.length > 0 && dist(out[out.length - 1], pt) <= eps) continue;
    out.push(p(pt.x, pt.y));
  }
  return out;
}

/**
 * Returns either:
 * - { kind: "point", tA, tB, point }
 * - { kind: "overlap", a0, a1, b0, b1, p0, p1, length }
 * - null
 */
function segmentIntersectionDetailed(a0, a1, b0, b1) {
  const r = sub(a1, a0);
  const s = sub(b1, b0);
  const rxs = cross(r, s);
  const qmp = sub(b0, a0);
  const qmpxr = cross(qmp, r);

  if (Math.abs(rxs) <= EPS && Math.abs(qmpxr) <= EPS) {
    const rr = dot(r, r);
    if (rr <= EPS) return null;
    const t0 = dot(sub(b0, a0), r) / rr;
    const t1 = dot(sub(b1, a0), r) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if (hi - lo <= EPS) return null;
    const p0 = lerp(a0, a1, lo);
    const p1 = lerp(a0, a1, hi);
    const length = dist(p0, p1);
    if (length <= EPS) return null;
    return {
      kind: "overlap",
      a0: lo,
      a1: hi,
      b0: segParam(p0, b0, b1),
      b1: segParam(p1, b0, b1),
      p0,
      p1,
      length,
    };
  }

  if (Math.abs(rxs) <= EPS) return null;

  const t = cross(qmp, s) / rxs;
  const u = cross(qmp, r) / rxs;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;

  const tt = Math.max(0, Math.min(1, t));
  const uu = Math.max(0, Math.min(1, u));
  return {
    kind: "point",
    tA: tt,
    tB: uu,
    point: lerp(a0, a1, tt),
  };
}

function pushUniqueNumber(arr, value, eps = CUT_EPS) {
  for (const v of arr) {
    if (Math.abs(v - value) <= eps) return;
  }
  arr.push(value);
}

function buildSegmentsFromParams(polyline, params) {
  const out = [];
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const vals = params[i].slice().sort((x, y) => x - y);
    const uniq = [];
    for (const t of vals) {
      if (uniq.length === 0 || Math.abs(t - uniq[uniq.length - 1]) > CUT_EPS) uniq.push(t);
    }
    for (let k = 0; k < uniq.length - 1; k += 1) {
      const t0 = uniq[k];
      const t1 = uniq[k + 1];
      if (t1 - t0 <= CUT_EPS) continue;
      const s0 = lerp(a, b, t0);
      const s1 = lerp(a, b, t1);
      if (dist(s0, s1) <= 1e-7) continue;
      out.push([s0, s1]);
    }
  }
  return out;
}

export function splitPolyline(subject, cutter) {
  if (!Array.isArray(subject) || subject.length < 2) return [];
  if (!Array.isArray(cutter) || cutter.length < 2) return [subject.map((pt) => p(pt.x, pt.y))];

  const cuts = [];
  const subjectMaxT = subject.length - 1;
  const shouldKeepGlobalT = (gt) => gt > CUT_EPS && gt < subjectMaxT - CUT_EPS;
  for (let i = 0; i < subject.length - 1; i += 1) {
    const a0 = subject[i];
    const a1 = subject[i + 1];
    for (let j = 0; j < cutter.length - 1; j += 1) {
      const b0 = cutter[j];
      const b1 = cutter[j + 1];
      const hit = segmentIntersectionDetailed(a0, a1, b0, b1);
      if (!hit) continue;
      if (hit.kind === "point") {
        let gt = i + hit.tA;
        if (hit.tA <= CUT_EPS) gt = i;
        if (hit.tA >= 1 - CUT_EPS) gt = i + 1;
        if (!shouldKeepGlobalT(gt)) continue;
        cuts.push({ globalT: gt, point: gt === i + 1 ? p(a1.x, a1.y) : p(hit.point.x, hit.point.y) });
      } else {
        {
          let gt = i + hit.a0;
          if (hit.a0 <= CUT_EPS) gt = i;
          if (hit.a0 >= 1 - CUT_EPS) gt = i + 1;
          if (shouldKeepGlobalT(gt)) {
            cuts.push({ globalT: gt, point: gt === i + 1 ? p(a1.x, a1.y) : p(hit.p0.x, hit.p0.y) });
          }
        }
        if (Math.abs(hit.a1 - hit.a0) > CUT_EPS) {
          let gt = i + hit.a1;
          if (hit.a1 <= CUT_EPS) gt = i;
          if (hit.a1 >= 1 - CUT_EPS) gt = i + 1;
          if (shouldKeepGlobalT(gt)) {
            cuts.push({ globalT: gt, point: gt === i + 1 ? p(a1.x, a1.y) : p(hit.p1.x, hit.p1.y) });
          }
        }
      }
    }
  }

  cuts.sort((a, b) => a.globalT - b.globalT);
  const deduped = [];
  for (const cut of cuts) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.abs(cut.globalT - prev.globalT) > CUT_EPS) {
      deduped.push(cut);
    }
  }

  if (deduped.length === 0) {
    return [subject.map((pt) => p(pt.x, pt.y))];
  }

  const result = [];
  let current = [p(subject[0].x, subject[0].y)];
  let cutIdx = 0;

  for (let i = 0; i < subject.length - 1; i += 1) {
    const segEndT = i + 1;
    // Interior cuts strictly within this segment
    while (cutIdx < deduped.length && deduped[cutIdx].globalT < segEndT - CUT_EPS) {
      const cut = deduped[cutIdx];
      if (cut.globalT > i + CUT_EPS) {
        const last = current[current.length - 1];
        if (!last || dist(last, cut.point) > 1e-7) current.push(p(cut.point.x, cut.point.y));
        if (current.length >= 2) result.push(current);
        current = [p(cut.point.x, cut.point.y)];
      }
      cutIdx += 1;
    }
    // Push segment endpoint
    const segEnd = subject[i + 1];
    const last = current[current.length - 1];
    if (!last || dist(last, segEnd) > 1e-7) current.push(p(segEnd.x, segEnd.y));
    // Cuts landing exactly on this vertex (globalT == i+1) — split after the vertex
    while (cutIdx < deduped.length && Math.abs(deduped[cutIdx].globalT - segEndT) <= CUT_EPS) {
      if (current.length >= 2) result.push(current);
      current = [p(segEnd.x, segEnd.y)];
      cutIdx += 1;
    }
  }

  if (current.length >= 2) result.push(current);
  return result.filter((poly) => poly.length >= 2 && dist(poly[0], poly[poly.length - 1]) > 1e-7);
}

function collectSelfIntersections(stroke) {
  const hits = [];
  for (let i = 0; i < stroke.length - 1; i += 1) {
    const a0 = stroke[i];
    const a1 = stroke[i + 1];
    for (let j = i + 2; j < stroke.length - 1; j += 1) {
      const b0 = stroke[j];
      const b1 = stroke[j + 1];
      const hit = segmentIntersectionDetailed(a0, a1, b0, b1);
      if (!hit || hit.kind !== "point") continue;
      if (hit.tA <= 1e-6 || hit.tA >= 1 - 1e-6) continue;
      if (hit.tB <= 1e-6 || hit.tB >= 1 - 1e-6) continue;
      hits.push({ segA: i, segB: j, point: hit.point, tA: hit.tA, tB: hit.tB });
    }
  }
  return hits;
}

export function splitSelfIntersecting(stroke) {
  if (!Array.isArray(stroke) || stroke.length < 2) return { segments: [], intersections: 0 };

  const params = Array.from({ length: stroke.length - 1 }, () => [0, 1]);
  const intersections = collectSelfIntersections(stroke);

  for (const hit of intersections) {
    pushUniqueNumber(params[hit.segA], hit.tA);
    pushUniqueNumber(params[hit.segB], hit.tB);
  }

  return {
    segments: buildSegmentsFromParams(stroke, params),
    intersections: intersections.length,
  };
}

function pointKey(pt) {
  return `${Math.round(pt.x * KEY_SCALE)},${Math.round(pt.y * KEY_SCALE)}`;
}

function canonicalCycleKey(nodes) {
  if (nodes.length < 3) return "";
  const n = nodes.length;
  const a = nodes.slice();
  const b = nodes.slice().reverse();

  const minRot = (arr) => {
    let best = 0;
    for (let i = 1; i < n; i += 1) {
      for (let k = 0; k < n; k += 1) {
        const lhs = arr[(i + k) % n];
        const rhs = arr[(best + k) % n];
        if (lhs < rhs) { best = i; break; }
        if (lhs > rhs) break;
      }
    }
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(arr[(best + i) % n]);
    return out.join("|");
  };

  const k1 = minRot(a);
  const k2 = minRot(b);
  return k1 < k2 ? k1 : k2;
}

function nodeAllSegments(segmentPolylines) {
  const segments = [];
  for (const polyline of segmentPolylines) {
    if (!polyline || polyline.length < 2) continue;
    for (let i = 0; i < polyline.length - 1; i += 1) {
      const a = polyline[i];
      const b = polyline[i + 1];
      if (dist(a, b) <= 1e-8) continue;
      segments.push([p(a.x, a.y), p(b.x, b.y)]);
    }
  }

  const cuts = Array.from({ length: segments.length }, () => [0, 1]);
  for (let i = 0; i < segments.length; i += 1) {
    const [a0, a1] = segments[i];
    for (let j = i + 1; j < segments.length; j += 1) {
      const [b0, b1] = segments[j];
      const hit = segmentIntersectionDetailed(a0, a1, b0, b1);
      if (!hit) continue;
      if (hit.kind === "point") {
        pushUniqueNumber(cuts[i], hit.tA);
        pushUniqueNumber(cuts[j], hit.tB);
      } else {
        pushUniqueNumber(cuts[i], hit.a0);
        pushUniqueNumber(cuts[i], hit.a1);
        pushUniqueNumber(cuts[j], hit.b0);
        pushUniqueNumber(cuts[j], hit.b1);
      }
    }
  }

  const noded = [];
  for (let i = 0; i < segments.length; i += 1) {
    const [a, b] = segments[i];
    const vals = cuts[i].slice().sort((x, y) => x - y);
    const uniq = [];
    for (const t of vals) {
      if (uniq.length === 0 || Math.abs(t - uniq[uniq.length - 1]) > CUT_EPS) uniq.push(t);
    }
    for (let k = 0; k < uniq.length - 1; k += 1) {
      const t0 = uniq[k];
      const t1 = uniq[k + 1];
      if (t1 - t0 <= CUT_EPS) continue;
      const s0 = lerp(a, b, t0);
      const s1 = lerp(a, b, t1);
      if (dist(s0, s1) <= 1e-7) continue;
      noded.push([s0, s1]);
    }
  }
  return noded;
}

export function polygonize(segmentPolylines) {
  function removeDeadEnds(nodedSegs) {
    let segs = nodedSegs.slice();
    let changed = true;
    while (changed) {
      changed = false;
      const degree = new Map();
      for (const [a, b] of segs) {
        const ka = pointKey(a);
        const kb = pointKey(b);
        degree.set(ka, (degree.get(ka) || 0) + 1);
        degree.set(kb, (degree.get(kb) || 0) + 1);
      }
      const next = segs.filter(([a, b]) => (degree.get(pointKey(a)) || 0) >= 2 && (degree.get(pointKey(b)) || 0) >= 2);
      if (next.length < segs.length) {
        segs = next;
        changed = true;
      }
    }
    return segs;
  }

  const noded = removeDeadEnds(nodeAllSegments(segmentPolylines));

  const nodes = new Map();
  const halfEdges = [];

  function ensureNode(pt) {
    const id = pointKey(pt);
    let node = nodes.get(id);
    if (!node) {
      node = { id, x: pt.x, y: pt.y, outs: [] };
      nodes.set(id, node);
    }
    return node;
  }

  const directedSeen = new Set();
  for (const seg of noded) {
    const a = ensureNode(seg[0]);
    const b = ensureNode(seg[1]);
    if (a.id === b.id) continue;
    const d1 = `${a.id}>${b.id}`;
    if (directedSeen.has(d1)) continue;
    directedSeen.add(d1);
    directedSeen.add(`${b.id}>${a.id}`);

    const e1 = halfEdges.length;
    const e2 = halfEdges.length + 1;
    halfEdges.push({
      id: e1,
      from: a.id,
      to: b.id,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      rev: e2,
      used: false,
    });
    halfEdges.push({
      id: e2,
      from: b.id,
      to: a.id,
      angle: Math.atan2(a.y - b.y, a.x - b.x),
      rev: e1,
      used: false,
    });
    a.outs.push(e1);
    b.outs.push(e2);
  }

  for (const node of nodes.values()) {
    node.outs.sort((ia, ib) => halfEdges[ia].angle - halfEdges[ib].angle);
  }

  const rings = [];
  const seenCycles = new Set();

  for (const start of halfEdges) {
    if (start.used) continue;

    const cycleNodes = [start.from];
    let current = start;
    let ok = true;
    let steps = 0;
    const maxSteps = Math.max(8, halfEdges.length * 2);

    while (steps++ < maxSteps) {
      if (current.used) { ok = false; break; }
      current.used = true;
      cycleNodes.push(current.to);

      const at = nodes.get(current.to);
      if (!at || at.outs.length === 0) { ok = false; break; }
      const revIdx = at.outs.indexOf(current.rev);
      if (revIdx < 0) { ok = false; break; }
      const nextIdx = (revIdx - 1 + at.outs.length) % at.outs.length;
      current = halfEdges[at.outs[nextIdx]];

      if (current.id === start.id) break;
    }

    if (!ok) continue;
    if (current.id !== start.id) continue;
    if (cycleNodes.length < 4) continue;
    if (cycleNodes[0] !== cycleNodes[cycleNodes.length - 1]) continue;

    const open = cycleNodes.slice(0, -1);
    const cycKey = canonicalCycleKey(open);
    if (!cycKey || seenCycles.has(cycKey)) continue;

    const ring = open.map((id) => {
      const node = nodes.get(id);
      return p(node.x, node.y);
    });

    const deduped = dedupeConsecutive(ring, 1e-7);
    if (deduped.length < 3) continue;
    if (polygonArea(deduped) <= 1e-6) continue;

    seenCycles.add(cycKey);
    rings.push(ensureCCW(deduped));
  }

  return rings;
}

function pointSegDistance(pt, a, b) {
  const ab = sub(b, a);
  const ab2 = dot(ab, ab);
  if (ab2 <= EPS) return dist(pt, a);
  const t = Math.max(0, Math.min(1, dot(sub(pt, a), ab) / ab2));
  return dist(pt, lerp(a, b, t));
}

function simplifyRDP(points, tol) {
  if (points.length <= 2) return points.slice();
  let bestDist = 0;
  let bestIdx = -1;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = pointSegDistance(points[i], points[0], points[points.length - 1]);
    if (d > bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestDist <= tol || bestIdx < 0) return [points[0], points[points.length - 1]];
  const left = simplifyRDP(points.slice(0, bestIdx + 1), tol);
  const right = simplifyRDP(points.slice(bestIdx), tol);
  return left.slice(0, -1).concat(right);
}

function simplifyClosedLoop(loop, tol) {
  const ring = dedupeConsecutive(loop, 1e-7);
  if (ring.length < 3) return [];
  if (tol <= 0) return ensureCCW(ring);
  const closed = ring.concat([ring[0]]);
  const simplified = simplifyRDP(closed, tol);
  const open = dedupeConsecutive(simplified.slice(0, -1), 1e-7);
  if (open.length < 3 || polygonArea(open) <= 1e-6) return [];
  return ensureCCW(open);
}

export function strokeOverlapScore(loop, stroke) {
  let overlapLength = 0;
  const points = [];
  const outline = loop.concat([loop[0]]);
  for (let i = 0; i < outline.length - 1; i += 1) {
    for (let j = 0; j < stroke.length - 1; j += 1) {
      const hit = segmentIntersectionDetailed(outline[i], outline[i + 1], stroke[j], stroke[j + 1]);
      if (!hit) continue;
      if (hit.kind === "overlap") {
        overlapLength += hit.length;
      } else {
        points.push(hit.point);
      }
    }
  }
  if (overlapLength > 0) return overlapLength;

  const unique = [];
  for (const pt of points) {
    if (!unique.some((u) => dist(u, pt) <= 1e-3)) unique.push(pt);
  }
  return unique.length;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) total += dist(points[i], points[i + 1]);
  return total;
}

export function editPolygonWithStroke(loop, stroke, simplifyTolerance = 0.5) {
  const originalArea = polygonArea(loop);
  const minAcceptedArea = originalArea * 0.1;
  const minPartLen = 2.0;
  const outline = loop.concat([loop[0]]);
  const outlineParts = splitPolyline(outline, stroke).filter(
    (seg) => seg.length >= 2 && dist(seg[0], seg[seg.length - 1]) > 1e-7 && polylineLength(seg) > minPartLen,
  );
  const strokeParts = splitPolyline(stroke, outline).filter(
    (seg) => seg.length >= 2 && dist(seg[0], seg[seg.length - 1]) > 1e-7 && polylineLength(seg) > minPartLen,
  );

  if (outlineParts.length < 3 || strokeParts.length < 3) return null;

  let best = null;
  let bestArea = 0;
  let candidatesSeen = 0;
  let candidatesAccepted = 0;
  for (let replaceIdx = 0; replaceIdx < outlineParts.length; replaceIdx += 1) {
    const keptOutline = outlineParts.filter((_, i) => i !== replaceIdx);
    for (const strokePart of strokeParts) {
      const merged = keptOutline.concat([strokePart]);
      const candidates = polygonize(merged);
      for (const candidate of candidates) {
        candidatesSeen += 1;
        const area = polygonArea(candidate);
        if (area < minAcceptedArea) continue;
        candidatesAccepted += 1;
        if (area > bestArea) {
          bestArea = area;
          best = candidate;
        }
      }
    }
  }

  if (!best) return null;
  const simplified = simplifyClosedLoop(best, simplifyTolerance);
  if (simplified.length < 3) return null;
  return simplified;
}

export function editDiagnostics(loop, stroke, minAreaRatio = 0.1) {
  const originalArea = polygonArea(loop);
  const minPartLen = 2.0;
  const outline = loop.concat([loop[0]]);
  const outlineParts = splitPolyline(outline, stroke).filter(
    (seg) => seg.length >= 2 && dist(seg[0], seg[seg.length - 1]) > 1e-7 && polylineLength(seg) > minPartLen,
  );
  const strokeParts = splitPolyline(stroke, outline).filter(
    (seg) => seg.length >= 2 && dist(seg[0], seg[seg.length - 1]) > 1e-7 && polylineLength(seg) > minPartLen,
  );
  const outlineEndpoints = [];
  for (const seg of outlineParts) {
    outlineEndpoints.push(seg[0]);
    outlineEndpoints.push(seg[seg.length - 1]);
  }
  const matchesOutlineEndpoint = (pt) => outlineEndpoints.some((ep) => dist(ep, pt) < 2.0);
  const strokePartsFiltered = strokeParts.filter((seg) => {
    const start = seg[0];
    const end = seg[seg.length - 1];
    return matchesOutlineEndpoint(start) && matchesOutlineEndpoint(end);
  });
  let candidatesTotal = 0;
  let candidatesPassingArea = 0;
  const minAcceptedArea = originalArea * minAreaRatio;

  if (outlineParts.length >= 3 && strokePartsFiltered.length >= 1) {
    for (let replaceIdx = 0; replaceIdx < outlineParts.length; replaceIdx += 1) {
      const keptOutline = outlineParts.filter((_, i) => i !== replaceIdx);
      for (const strokePart of strokePartsFiltered) {
        const merged = keptOutline.concat([strokePart]);
        const candidates = polygonize(merged);
        for (const candidate of candidates) {
          candidatesTotal += 1;
          const area = polygonArea(candidate);
          if (area >= minAcceptedArea) candidatesPassingArea += 1;
        }
      }
    }
  }

  return {
    outlineParts: outlineParts.length,
    strokeParts: strokePartsFiltered.length,
    candidatesTotal,
    candidatesPassingArea,
    originalArea,
    minAcceptedArea,
  };
}

export function applyFreehandStroke(existingMasks, strokePoints, config = {}) {
  const minDist = Number.isFinite(config.minSampleDistancePx) ? config.minSampleDistancePx : 3.0;
  const simplifyTolerance = Number.isFinite(config.simplifyTolerance) ? config.simplifyTolerance : 0.5;
  const maxSelfIntersectionSegments = Number.isFinite(config.maxSelfIntersectionSegments) ? config.maxSelfIntersectionSegments : 3;

  const stroke = dedupeConsecutive(strokePoints.map((pt) => p(pt.x, pt.y)), 1e-7);
  if (stroke.length < 2) {
    return { masks: existingMasks.map((m) => m.slice()), changed: false, outcome: "stroke_too_short" };
  }

  let strokeLen = 0;
  for (let i = 0; i < stroke.length - 1; i += 1) strokeLen += dist(stroke[i], stroke[i + 1]);
  if (strokeLen < minDist) {
    return { masks: existingMasks.map((m) => m.slice()), changed: false, outcome: "below_min_distance" };
  }

  const self = splitSelfIntersecting(stroke);
  const isSimple = self.intersections === 0;

  if (!isSimple) {
    const segmentComplexity = self.intersections + 1;
    if (segmentComplexity > maxSelfIntersectionSegments) {
      return { masks: existingMasks.map((m) => m.slice()), changed: false, outcome: "no-op" };
    }
    const loops = polygonize(self.segments);
    if (loops.length === 0) {
      return { masks: existingMasks.map((m) => m.slice()), changed: false, outcome: "no-op" };
    }
    let best = loops[0];
    let bestArea = polygonArea(best);
    for (let i = 1; i < loops.length; i += 1) {
      const area = polygonArea(loops[i]);
      if (area > bestArea) {
        bestArea = area;
        best = loops[i];
      }
    }
    const simplified = simplifyClosedLoop(best, simplifyTolerance);
    if (simplified.length < 3) {
      return { masks: existingMasks.map((m) => m.slice()), changed: false, outcome: "no-op" };
    }
    return {
      masks: existingMasks.map((m) => m.slice()).concat([simplified]),
      changed: true,
      outcome: "created",
    };
  }

  let bestIdx = -1;
  let bestCandidate = null;
  let bestOverlap = 0;
  let bestArea = 0;
  const overlapEps = 1e-9;

  for (let i = 0; i < existingMasks.length; i += 1) {
    const loop = existingMasks[i];
    const overlap = strokeOverlapScore(loop, stroke);
    if (overlap <= 0) continue;
    const candidate = editPolygonWithStroke(loop, stroke, simplifyTolerance);
    if (!candidate) continue;
    const area = polygonArea(loop);

    if (bestIdx < 0 || overlap > bestOverlap + overlapEps) {
      bestIdx = i;
      bestCandidate = candidate;
      bestOverlap = overlap;
      bestArea = area;
      continue;
    }
    if (Math.abs(overlap - bestOverlap) <= overlapEps) {
      if (area > bestArea || (Math.abs(area - bestArea) <= overlapEps && i < bestIdx)) {
        bestIdx = i;
        bestCandidate = candidate;
        bestOverlap = overlap;
        bestArea = area;
      }
    }
  }

  if (bestIdx < 0 || !bestCandidate) {
    return { masks: existingMasks.map((m) => m.slice()), changed: false, outcome: "no-op" };
  }

  const next = existingMasks.map((m) => m.slice());
  next[bestIdx] = bestCandidate;
  return { masks: next, changed: true, outcome: "updated" };
}
