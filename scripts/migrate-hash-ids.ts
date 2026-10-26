/**
 * One-shot migration to CONTENT-ADDRESSED IDS (graph format v2, 2026-10-26).
 *
 * Why: a node id is now derived from its normalized statement and a chain id
 * from its (premises, conclusion) key (src/core/graph.ts). That is what makes
 * two machines' ledgers union idempotently — the same fact minted twice lands
 * on ONE id. This script rewrites a data dir written by the random-id build.
 *
 * What it does, in order:
 *   1. nodes.jsonl — new id per line, old→new map. Lines that collapse onto
 *      one id (same normalized statement) stay as multiple lines: reads merge
 *      them (aliases + provenance union), exactly like a link-append.
 *   2. chains.jsonl — premises/conclusion remapped through that map, id
 *      recomputed from the key. A chain is DROPPED when an endpoint no longer
 *      resolves, a premise equals the conclusion, or no premise survives.
 *   3. positions.json — layout keys remapped; when two old ids collapse, the
 *      smaller old id's resting spot stands (deterministic, no guessing).
 *   4. format.json — stamped with the current graph format version.
 *   5. coverage.jsonl / sessions.jsonl / sources.json are NOT touched: they
 *      carry chat ids and message fingerprints, no node ids.
 *
 * Dry-run by default; `--apply` writes. Every file it rewrites is first copied
 * to `<file>.pre-hashids-<stamp>` beside it. Idempotent: on an already-migrated
 * dir it reports "nothing to do" and writes nothing.
 *
 * Run from the repo root (the master tree — data never crosses trees):
 *
 *   npx tsx scripts/migrate-hash-ids.ts                       # dry run on ./data
 *   npx tsx scripts/migrate-hash-ids.ts --data <dir> --apply   # write
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { chainIdForKey, chainKey, nodeIdForStatement, normalizeStatement } from "../src/core/graph.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../src/core/contracts/graph.ts";

interface NodeLine {
	id: string;
	name: string;
	statement: string;
	aliases?: string[];
	createdAt: string;
	provenance: unknown[];
}

interface ChainLine {
	id: string;
	premises: string[];
	conclusion: string;
	createdAt: string;
	provenance: unknown[];
}

function argValue(flag: string): string | undefined {
	const at = process.argv.indexOf(flag);
	if (at < 0) return undefined;
	const value = process.argv[at + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

const DATA_DIR = path.resolve(argValue("--data") ?? "data");
const APPLY = process.argv.includes("--apply");
const GRAPH_DIR = path.join(DATA_DIR, "graph");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function readJsonl<T>(file: string): { lines: T[]; skipped: number } {
	if (!fs.existsSync(file)) return { lines: [], skipped: 0 };
	const lines: T[] = [];
	let skipped = 0;
	for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
		if (!raw.trim()) continue;
		try {
			lines.push(JSON.parse(raw) as T);
		} catch {
			skipped++;
		}
	}
	return { lines, skipped };
}

function writeAtomic(file: string, body: string): void {
	const tmp = `${file}.migrate-${process.pid}`;
	fs.writeFileSync(tmp, body, "utf-8");
	fs.renameSync(tmp, file);
}

function backup(file: string): void {
	if (!fs.existsSync(file)) return;
	fs.copyFileSync(file, `${file}.pre-hashids-${stamp}`);
}

function jsonl(records: ReadonlyArray<unknown>): string {
	return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

/** A node's identity material is its statement — a line without one cannot be
 *  addressed, so it is reported instead of silently dropped. */
const nodesFile = path.join(GRAPH_DIR, "nodes.jsonl");
const chainsFile = path.join(GRAPH_DIR, "chains.jsonl");
const positionsFile = path.join(GRAPH_DIR, "positions.json");
const formatFile = path.join(GRAPH_DIR, "format.json");

const { lines: nodeLines, skipped: skippedNodes } = readJsonl<NodeLine>(nodesFile);
const { lines: chainLines, skipped: skippedChains } = readJsonl<ChainLine>(chainsFile);

if (nodeLines.length === 0 && chainLines.length === 0) {
	console.log(`[migrate] ${GRAPH_DIR}: no ledgers to migrate (nothing to do)`);
	process.exit(0);
}

// ─── 1. nodes ────────────────────────────────────────────────────────────────
const idMap = new Map<string, string>();
const materialById = new Map<string, string>();
const collisions: string[] = [];
const migratedNodes: NodeLine[] = [];
let nodesRewritten = 0;
let droppedNoStatement = 0;

for (const line of nodeLines) {
	if (typeof line.statement !== "string" || line.statement.trim() === "") {
		droppedNoStatement++;
		continue;
	}
	const id = nodeIdForStatement(line.statement);
	const material = normalizeStatement(line.statement);
	const seen = materialById.get(id);
	if (seen !== undefined && seen !== material) {
		// 64-bit hash collision. Refuse rather than weld two facts together.
		collisions.push(`${line.id} -> ${id}: "${seen.slice(0, 60)}" vs "${material.slice(0, 60)}"`);
		continue;
	}
	materialById.set(id, material);
	idMap.set(line.id, id);
	if (line.id !== id) nodesRewritten++;
	migratedNodes.push({ ...line, id, aliases: line.aliases ?? [] });
}

const newIds = new Set(migratedNodes.map((line) => line.id));
const duplicateStatements = nodeLines.length - droppedNoStatement - newIds.size;

// ─── 2. chains ───────────────────────────────────────────────────────────────
const migratedChains: ChainLine[] = [];
const seenChainLines = new Set<string>();
let chainsRewritten = 0;
let chainsDroppedEndpoint = 0;
let chainsDroppedDegenerate = 0;

for (const line of chainLines) {
	const conclusion = idMap.get(line.conclusion) ?? (newIds.has(line.conclusion) ? line.conclusion : undefined);
	if (conclusion === undefined) {
		chainsDroppedEndpoint++;
		continue;
	}
	const premises = [
		...new Set(
			line.premises
				.map((premise) => idMap.get(premise) ?? (newIds.has(premise) ? premise : undefined))
				.filter((premise): premise is string => premise !== undefined && premise !== conclusion),
		),
	];
	if (premises.length === 0) {
		chainsDroppedDegenerate++;
		continue;
	}
	const id = chainIdForKey(chainKey(premises, conclusion));
	const record: ChainLine = { ...line, id, premises, conclusion };
	// Read-time merge already unifies duplicates; keeping byte-identical lines
	// would only pad the ledger.
	const key = JSON.stringify([record.id, record.premises, record.conclusion, record.createdAt, record.provenance]);
	if (seenChainLines.has(key)) continue;
	seenChainLines.add(key);
	if (line.id !== id) chainsRewritten++;
	migratedChains.push(record);
}

// ─── 3. positions ────────────────────────────────────────────────────────────
let positionsBody: string | undefined;
let positionsRewritten = 0;
let positionsKept = 0;
if (fs.existsSync(positionsFile)) {
	const raw = JSON.parse(fs.readFileSync(positionsFile, "utf-8")) as {
		positions?: Record<string, { x: number; y: number }>;
		updatedAt?: string;
	};
	const positions: Record<string, { x: number; y: number }> = {};
	const source = raw.positions ?? {};
	for (const oldId of Object.keys(source).sort()) {
		const newId = idMap.get(oldId) ?? (newIds.has(oldId) ? oldId : undefined);
		if (newId === undefined) {
			// A resting spot for a node this ledger no longer carries (its id was
			// never migrated because nothing references it): KEEP it verbatim —
			// positions are a derived cache and the next layout settle prunes it.
			// Dropping it here would be this script destroying what it cannot read.
			positions[oldId] = source[oldId]!;
			positionsKept++;
			continue;
		}
		if (newId in positions) continue; // collapsed duplicates: smallest old id stands
		if (newId !== oldId) positionsRewritten++;
		positions[newId] = source[oldId]!
	}
	positionsBody = JSON.stringify({ positions, updatedAt: raw.updatedAt ?? new Date().toISOString() }, null, "\t");
}

// ─── report ──────────────────────────────────────────────────────────────────
console.log(`[migrate] ${GRAPH_DIR}${APPLY ? "" : " (dry run)"}`);
console.log(`  nodes:     ${nodeLines.length} lines, ${nodesRewritten} rewritten, ${duplicateStatements} collapse onto an existing identity`);
console.log(`  chains:    ${chainLines.length} lines, ${chainsRewritten} rewritten, ${migratedChains.length} kept`);
if (chainsDroppedEndpoint) console.log(`  chains:    ${chainsDroppedEndpoint} DROPPED (unresolvable endpoint)`);
if (chainsDroppedDegenerate) console.log(`  chains:    ${chainsDroppedDegenerate} DROPPED (no premise survives)`);
if (positionsBody !== undefined) console.log(`  positions: ${positionsRewritten} keys remapped, ${positionsKept} kept as-is (unreferenced)`);

// A line this script cannot address is a line it would DELETE on write. Refuse
// instead of silently shrinking the ledgers: fixing a corrupt ledger by hand is
// a different, deliberate operation.
const unaddressable = skippedNodes + skippedChains + droppedNoStatement;
if (unaddressable > 0) {
	console.error(`\n[migrate] ABORTED: ${unaddressable} line(s) cannot be addressed (${skippedNodes} corrupt node lines, ${skippedChains} corrupt chain lines, ${droppedNoStatement} node lines without a statement).`);
	console.error("[migrate] nothing was written. Repair those lines first (or remove them deliberately) and re-run.");
	process.exit(1);
}

if (collisions.length > 0) {
	console.error(`\n[migrate] ABORTED: ${collisions.length} hash collision(s) — two different statements share an id:`);
	for (const collision of collisions.slice(0, 10)) console.error(`  ${collision}`);
	console.error("[migrate] nothing was written. Widen ID_HEX_CHARS or resolve the colliding statements by hand.");
	process.exit(1);
}

const alreadyMigrated =
	nodesRewritten === 0 &&
	chainsRewritten === 0 &&
	positionsRewritten === 0 &&
	chainsDroppedEndpoint === 0 &&
	chainsDroppedDegenerate === 0 &&
	fs.existsSync(formatFile) &&
	(JSON.parse(fs.readFileSync(formatFile, "utf-8")) as { version?: number }).version === CURRENT_GRAPH_FORMAT_VERSION;
if (alreadyMigrated) {
	console.log("[migrate] already at the content-addressed format — nothing to do");
	process.exit(0);
}
if (!APPLY) {
	console.log("[migrate] dry run: pass --apply to write (files are backed up beside themselves first)");
	process.exit(0);
}

// ─── write ───────────────────────────────────────────────────────────────────
for (const file of [nodesFile, chainsFile, positionsFile, formatFile]) backup(file);
writeAtomic(nodesFile, jsonl(migratedNodes));
writeAtomic(chainsFile, jsonl(migratedChains));
if (positionsBody !== undefined) writeAtomic(positionsFile, positionsBody);
writeAtomic(formatFile, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }, null, "\t") + "\n");
console.log("[migrate] written; backups: *.pre-hashids-" + stamp);
