import fs from "node:fs";
import path from "node:path";
import { applyFreehandStroke, polygonArea, p, strokeOverlapScore, editDiagnostics } from "./freehand_geometry.mjs";

const root = process.cwd();
const logPath = path.join(root, "previous_work", "freehand_trial.jsonl");

function parseJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSON at line ${idx + 1}: ${err}`);
      }
    });
}

function toLoop(points) {
  return (points ?? []).map(([x, y]) => p(x, y));
}

function normalizeMasks(resultMasks) {
  return (resultMasks ?? []).map((m) => toLoop(m.polygon));
}

function areaPctDiff(a, b) {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom;
}

function parseArgs(argv) {
  let debugSeq = null;
  let stateMode = "expected"; // expected | sequential
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--debug" && i + 1 < argv.length) {
      debugSeq = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (argv[i] === "--state" && i + 1 < argv.length) {
      const mode = String(argv[i + 1] || "").toLowerCase();
      if (mode === "expected" || mode === "sequential") {
        stateMode = mode;
      }
      i += 1;
    }
  }
  return { debugSeq, stateMode };
}

function splitSessions(events) {
  const sessions = [];
  let current = [];
  let lastStrokeSeq = null;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.event !== "stroke" && ev.event !== "result") continue;

    if (ev.event === "stroke" && Number.isFinite(ev.seq)) {
      if (lastStrokeSeq !== null && ev.seq <= lastStrokeSeq) {
        if (current.length > 0) sessions.push(current);
        current = [];
      }
      lastStrokeSeq = ev.seq;
    }
    current.push(ev);
  }

  if (current.length > 0) sessions.push(current);
  return sessions;
}

function replaySession(events, opts = {}) {
  const debugSeq = opts.debugSeq ?? null;
  const stateMode = opts.stateMode ?? "expected";

  const strokes = new Map();
  const results = new Map();

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.event === "stroke") strokes.set(ev.seq, ev);
    if (ev.event === "result") results.set(ev.seq, ev);
  }

  const seqs = [...new Set([...strokes.keys(), ...results.keys()])].sort((a, b) => a - b);

  let masks = [];
  let passed = 0;
  let failed = 0;

  for (const seq of seqs) {
    const strokeEv = strokes.get(seq);
    const resultEv = results.get(seq);

    if (!strokeEv || !resultEv) {
      failed += 1;
      console.log(`SEQ ${seq}: FAIL missing ${!strokeEv ? "stroke" : "result"} event`);
      continue;
    }

    const strokePoints = toLoop(strokeEv.points || []);
    const replayed = applyFreehandStroke(
      masks,
      strokePoints,
      {
        minSampleDistancePx: 3.0,
        simplifyTolerance: 0.5,
        maxSelfIntersectionSegments: 3,
      }
    );

    if (debugSeq !== null && seq === debugSeq && masks.length > 0) {
      console.log(`SEQ ${seq} DEBUG:`);
      const ranked = masks
        .map((loop, idx) => ({ idx, overlap: strokeOverlapScore(loop, strokePoints), loop }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || a.idx - b.idx);
      if (ranked.length === 0) {
        console.log("  no overlap targets");
      } else {
        for (const target of ranked) {
          const diag = editDiagnostics(target.loop, strokePoints, 0.1);
          console.log(
            `  mask=${target.idx} overlap=${target.overlap.toFixed(3)} ` +
            `outlineParts=${diag.outlineParts} strokeParts=${diag.strokeParts} ` +
            `candidatesTotal=${diag.candidatesTotal} candidatesPassingArea=${diag.candidatesPassingArea} ` +
            `originalArea=${diag.originalArea.toFixed(3)} minAcceptedArea=${diag.minAcceptedArea.toFixed(3)}`
          );
        }
      }
    }

    const expectedMasks = normalizeMasks(resultEv.masks);
    const gotMasks = replayed.masks;

    let ok = true;
    const problems = [];

    if (gotMasks.length !== expectedMasks.length) {
      ok = false;
      problems.push(`mask_count expected=${expectedMasks.length} got=${gotMasks.length}`);
    }

    const n = Math.min(gotMasks.length, expectedMasks.length);
    const areaChecks = [];
    for (let i = 0; i < n; i += 1) {
      const expectedArea = polygonArea(expectedMasks[i]);
      const gotArea = polygonArea(gotMasks[i]);
      const rel = areaPctDiff(expectedArea, gotArea);
      areaChecks.push(`m${i}: exp=${expectedArea.toFixed(3)} got=${gotArea.toFixed(3)} rel=${(rel * 100).toFixed(2)}%`);
      if (rel > 0.01) {
        ok = false;
        problems.push(`area_tolerance m${i} rel=${(rel * 100).toFixed(2)}% > 1.00%`);
      }
    }

    if (ok) {
      passed += 1;
      console.log(`SEQ ${seq}: PASS (${areaChecks.join(", ") || "no masks"})`);
    } else {
      failed += 1;
      console.log(`SEQ ${seq}: FAIL ${problems.join("; ")} (${areaChecks.join(", ") || "no masks"})`);
    }

    masks = stateMode === "sequential" ? gotMasks : expectedMasks;
  }

  return { passed, failed, total: passed + failed };
}

function replay(events) {
  const { debugSeq, stateMode } = parseArgs(process.argv.slice(2));
  const sessions = splitSessions(events);
  if (sessions.length === 0) {
    console.log("No stroke/result sessions found.");
    return { passed: 0, failed: 0, total: 0 };
  }

  let totalPassed = 0;
  let totalFailed = 0;
  let totalCases = 0;

  for (let i = 0; i < sessions.length; i += 1) {
    const sessionNo = i + 1;
    console.log(`\nSession ${sessionNo}:`);
    const stats = replaySession(sessions[i], { debugSeq, stateMode });
    totalPassed += stats.passed;
    totalFailed += stats.failed;
    totalCases += stats.total;
    console.log(`Summary session ${sessionNo} (${stateMode} state): ${stats.passed} passed, ${stats.failed} failed, ${stats.total} total`);
  }

  console.log(`\nSummary all sessions (${stateMode} state): ${totalPassed} passed, ${totalFailed} failed, ${totalCases} total`);
  return { passed: totalPassed, failed: totalFailed, total: totalCases };
}

const events = parseJsonl(logPath);
replay(events);
