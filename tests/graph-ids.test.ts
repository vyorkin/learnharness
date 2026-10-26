/**
 * Content-addressed graph identity (2026-10-26, cross-machine sync).
 *
 * The whole point of the change: the SAME fact minted twice — by two chats, or
 * by two machines merging the same lesson — must land on ONE node id, so a
 * union of the ledgers is idempotent instead of producing twins. These pins
 * hold the derivation (pure), the merger's convergence (through the real fs
 * adapters under an isolated LH_DATA_DIR), and the v1 → v2 migration script's
 * rewrite + idempotency.
 *
 * Ledger isolation: the data dir seam is set BEFORE any config-loading import
 * and every app-module import is dynamic (the birth-stamp discipline).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hashids-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chainIdForKey, chainKey, getGraph, mergeFindings, nodeIdForStatement, normalizeStatement } = await import(
	"../src/core/graph.ts"
);
const { graphStore } = await import("../src/store/graph.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { CURRENT_GRAPH_FORMAT_VERSION } = await import("../src/core/contracts/graph.ts");

const repoRoot = path.resolve(import.meta.dirname, "..");

function newChat(title: string) {
	return chatStore.createChat(title);
}

function sessionSource(chatId: string) {
	return { foldedAt: chatStore.getChat(chatId)!.updatedAt };
}

describe("content-addressed ids", () => {
	it("derive a node id from the normalized statement", () => {
		const id = nodeIdForStatement("Перестановка множества X — это биекция X на себя.");
		assert.match(id, /^n_[0-9a-f]{16}$/, "16 hex chars, the widened width");
		assert.equal(
			id,
			nodeIdForStatement("  перестановка   множества X — это биекция X на себя.  "),
			"case and whitespace are not identity",
		);
		assert.notEqual(id, nodeIdForStatement("Перестановка множества X — это биекция X на Y."), "different statement, different id");
	});

	it("normalizes unicode and collapses whitespace", () => {
		assert.equal(normalizeStatement("Équivalence\tdeux\nlignes"), "équivalence deux lignes");
		// NFKC folds compatibility forms, so a full-width spelling is the same fact
		assert.equal(nodeIdForStatement("ＡＢＣ"), nodeIdForStatement("ABC"));
	});

	it("derive a chain id from the (premises, conclusion) key, order-insensitively", () => {
		const one = chainIdForKey(chainKey(["n_aaaa", "n_bbbb"], "n_cccc"));
		const two = chainIdForKey(chainKey(["n_bbbb", "n_aaaa"], "n_cccc"));
		assert.match(one, /^arg_[0-9a-f]{16}$/);
		assert.equal(one, two, "premise order is not identity");
		assert.notEqual(one, chainIdForKey(chainKey(["n_aaaa"], "n_cccc")), "a different premise set is a different argument");
	});
});

describe("the merger is convergent under content-addressed ids", () => {
	it("mints ONE node for the same statement asserted by two chats", () => {
		const a = newChat("identity A");
		const b = newChat("identity B");
		const statement = "Группа есть множество с ассоциативной операцией и нейтральным элементом.";

		const first = mergeFindings(
			a.id,
			{ propositions: [{ id: "p1", name: "Группа", statement, aliases: [] }], chains: [] },
			{ links: [] },
			{ chatStore, graphStore },
			sessionSource(a.id),
		);
		assert.equal(first.nodes, 1, "first sighting is an emission");

		// Chat B re-encounters the same fact, with a different job-local id and
		// the auditor NOT linking it (the honest worst case): the content hash
		// still resolves both propositions to one node id.
		const second = mergeFindings(
			b.id,
			{ propositions: [{ id: "zz", name: "Группа", statement: `${statement}  `, aliases: ["Group"] }], chains: [] },
			{ links: [] },
			{ chatStore, graphStore },
			sessionSource(b.id),
		);
		assert.equal(second.nodes, 0, "re-encounter is a link-style append, not a new node");

		const graph = getGraph(graphStore);
		const nodes = graph.nodes.filter((node) => node.statement.trim() === statement.trim());
		assert.equal(nodes.length, 1, "one node, never a twin");
		assert.equal(nodes[0]!.id, nodeIdForStatement(statement));
		assert.deepEqual(
			nodes[0]!.provenance.map((point) => point.chatId).sort(),
			[a.id, b.id].sort(),
			"both chats' provenance unions on that one node",
		);
		assert.ok(nodes[0]!.aliases.includes("Group"));
	});

	it("merges one argument asserted by two chats under one chain id", () => {
		const a = newChat("chain A");
		const b = newChat("chain B");
		const premiseStatement = "Моноид — полугруппа с нейтральным элементом.";
		const conclusionStatement = "Множество всех эндоморфизмов моноида есть моноид.";

		const aStats = mergeFindings(
			a.id,
			{
				propositions: [
					{ id: "p1", name: "Моноид", statement: premiseStatement, aliases: [] },
					{ id: "p2", name: "End", statement: conclusionStatement, aliases: [] },
				],
				chains: [{ premises: ["p1"], conclusion: "p2" }],
			},
			{ links: [] },
			{ chatStore, graphStore },
			sessionSource(a.id),
		);
		assert.equal(aStats.chains, 1);

		const premiseId = nodeIdForStatement(premiseStatement);
		const conclusionId = nodeIdForStatement(conclusionStatement);

		// Chat B asserts the same argument by referencing the ids verbatim (the
		// digest path) — no propositions of its own.
		const bStats = mergeFindings(
			b.id,
			{ propositions: [], chains: [{ premises: [premiseId], conclusion: conclusionId }] },
			{ links: [] },
			{ chatStore, graphStore },
			sessionSource(b.id),
		);
		assert.equal(bStats.chains, 1, "a second chat's assertion is emitted...");

		const graph = getGraph(graphStore);
		const chains = graph.chains.filter((chain) => chain.conclusion === conclusionId);
		assert.equal(chains.length, 1, "...and reads as ONE logical argument");
		assert.equal(chains[0]!.id, chainIdForKey(chainKey([premiseId], conclusionId)));
		assert.deepEqual(
			chains[0]!.provenance.map((point) => point.chatId).sort(),
			[a.id, b.id].sort(),
			"both assertions carry their provenance",
		);
	});
});

describe("migrate-hash-ids.ts (v1 -> v2)", () => {
	function legacyDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-legacy-"));
		const graph = path.join(dir, "graph");
		fs.mkdirSync(graph, { recursive: true });
		// Random ids, the v1 shape — a real v1 ledger's ids, not hand-invented
		// semantics: node lines as the old merger wrote them.
		const nodes = [
			{
				id: "n_607a73e6ebbf",
				name: "Перестановка",
				statement: "Перестановка множества X — это биекция X на себя.",
				aliases: ["перестановка есть биекция"],
				createdAt: "2026-10-25T21:33:33.233Z",
				provenance: [{ chatId: "chat_x", messageId: "msg_a" }],
			},
			{
				id: "n_c7e4d9706b83",
				name: "Произведение",
				statement: "Произведение перестановок есть композиция отображений.",
				aliases: [],
				createdAt: "2026-10-25T21:33:33.233Z",
				provenance: [{ chatId: "chat_x", messageId: "msg_a" }],
			},
			// A twin: same normalized statement as the first line (case differs).
			{
				id: "n_deadbeefcafe",
				name: "Перестановка (снова)",
				statement: "  перестановка множества x — это биекция x на себя. ",
				aliases: ["A permutation is a bijection"],
				createdAt: "2026-10-25T21:40:00.000Z",
				provenance: [{ chatId: "chat_y", messageId: "msg_b" }],
			},
		];
		const chains = [
			{
				id: "arg_527295ddf371",
				premises: ["n_607a73e6ebbf"],
				conclusion: "n_deadbeefcafe",
				createdAt: "2026-10-25T21:33:33.233Z",
				provenance: [{ chatId: "chat_x", messageId: "" }],
			},
			{
				id: "arg_ba5a256db92f",
				premises: ["n_607a73e6ebbf", "n_c7e4d9706b83"],
				conclusion: "n_deadbeefcafe",
				createdAt: "2026-10-25T21:33:33.233Z",
				provenance: [{ chatId: "chat_x", messageId: "" }],
			},
			// Endpoint that resolves to nothing: must be dropped, not guessed.
			{
				id: "arg_000000000000",
				premises: ["n_607a73e6ebbf"],
				conclusion: "n_missing",
				createdAt: "2026-10-25T21:33:33.233Z",
				provenance: [{ chatId: "chat_x", messageId: "" }],
			},
		];
		const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
		fs.writeFileSync(path.join(graph, "nodes.jsonl"), jsonl(nodes));
		fs.writeFileSync(path.join(graph, "chains.jsonl"), jsonl(chains));
		fs.writeFileSync(
			path.join(graph, "positions.json"),
			JSON.stringify({
				positions: {
					n_607a73e6ebbf: { x: 1, y: 2 },
					n_c7e4d9706b83: { x: 3, y: 4 },
					n_deadbeefcafe: { x: 5, y: 6 },
					n_missing: { x: 7, y: 8 },
				},
				updatedAt: "2026-10-25T21:33:33.233Z",
			}),
		);
		fs.writeFileSync(path.join(graph, "format.json"), JSON.stringify({ version: 1 }) + "\n");
		return dir;
	}

	function migrate(dir: string): string {
		return execFileSync("npx", ["tsx", "scripts/migrate-hash-ids.ts", "--data", dir, "--apply"], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
	}

	it("rewrites ids, remaps chains and positions, archives the ledger, is idempotent", () => {
		const dir = legacyDir();
		const graph = path.join(dir, "graph");
		migrate(dir);

		const nodes = fs
			.readFileSync(path.join(graph, "nodes.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { id: string; statement: string; aliases: string[] });
		assert.equal(nodes.length, 3, "no line is lost — collapsing is a read-time merge");
		for (const node of nodes) assert.match(node.id, /^n_[0-9a-f]{16}$/);
		const permutationId = nodeIdForStatement("Перестановка множества X — это биекция X на себя.");
		assert.equal(nodes.filter((node) => node.id === permutationId).length, 2, "the twin lands on the same identity");

		const chains = fs
			.readFileSync(path.join(graph, "chains.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { id: string; premises: string[]; conclusion: string });
		assert.equal(chains.length, 1, "the unresolvable chain and the collapsed-degenerate one are both dropped");
		for (const chain of chains) assert.match(chain.id, /^arg_[0-9a-f]{16}$/);
		// The twin premise collapsed onto the conclusion, so that premise is
		// dropped (the merger's own premise==conclusion rule); the chain survives
		// with the premises that still say something.
		const productId = nodeIdForStatement("Произведение перестановок есть композиция отображений.");
		assert.equal(chains[0]!.premises.length, 1);
		assert.deepEqual(chains[0]!.premises, [productId]);
		assert.equal(chains[0]!.conclusion, permutationId);

		const positions = JSON.parse(fs.readFileSync(path.join(graph, "positions.json"), "utf-8")) as {
			positions: Record<string, { x: number; y: number }>;
		};
		// A resting spot whose node id resolves to nothing is KEPT verbatim (the
		// next layout settle prunes it) — migration never deletes what it cannot
		// interpret.
		assert.deepEqual(Object.keys(positions.positions).sort(), [permutationId, productId, "n_missing"].sort());
		assert.deepEqual(positions.positions[permutationId], { x: 1, y: 2 }, "the smallest old id's resting spot stands");

		assert.equal(
			(JSON.parse(fs.readFileSync(path.join(graph, "format.json"), "utf-8")) as { version: number }).version,
			CURRENT_GRAPH_FORMAT_VERSION,
		);
		assert.ok(fs.readdirSync(graph).some((name) => name.includes(".pre-hashids-")), "a backup sits beside the ledger");

		// Idempotent: the second run finds nothing to rewrite and touches nothing.
		const before = fs.readFileSync(path.join(graph, "nodes.jsonl"), "utf-8");
		const report = migrate(dir);
		assert.match(report, /nothing to do/);
		assert.equal(fs.readFileSync(path.join(graph, "nodes.jsonl"), "utf-8"), before);
	});
});
