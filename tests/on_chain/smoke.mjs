/* Keyed against GenLayer Studio (chain 61999, Studio v0.123, GenVM v0.4), with throwaway accounts. Deploys its own copy.
 *
 *   npm ci                                         # genlayer-js 2.0.0, pinned by package-lock.json
 *   node tests/on_chain/smoke.mjs                  # the whole run, about an hour
 *   RESUME=1 node tests/on_chain/smoke.mjs         # continue a run that was cut off, from the saved state
 *   STATE=/some/dir/run.json ...                   # the state file: keys, contract address, every step made
 *   FRESH=1 ...                                    # start over even though a saved run exists
 *
 * Studio v0.123 charges fees: every deploy and write carries the distribution and fee value quoted by
 * estimateTransactionFees(), and every transaction is checked for both its status (FINALIZED) and its execution
 * result (FINISHED_WITH_RETURN or FINISHED_WITH_ERROR). What a transaction cost its sender is read from the
 * transaction's own fee accounting (paid less refunded), so every wallet can be checked to the atto.
 *
 * Five accounts the script generates and funds itself: SETTER writes the quiz and its key; ANA, BO and CY take it;
 * STRANGER takes no part and is refused everywhere it tries.
 *
 * Phases:
 *   A  deploy; deposits; SETTER opens Q1 (four questions, a 0.1 GEN fee, a 0.4 GEN bond, a 0.05 GEN dispute bond,
 *      a 10% cut). SETTER tries to take its own quiz and STRANGER pays the wrong fee: both refused, the value back
 *      in the same transaction. ANA, BO and CY enter with sealed answers. SETTER tries to reveal before entries
 *      close, STRANGER tries to reveal at all: refused.
 *   B  entries close. STRANGER tries to enter late: refused, value back. SETTER reveals with the wrong salt:
 *      refused, the commitment does not match; then with the right one. The takers open their seals. STRANGER and
 *      SETTER try to dispute: refused. Three disputes, one consensus round each, every validator answering the
 *      question in two orders: BO disputes question 1 (the key is right: holds), ANA question 2 (keyed Ag for gold:
 *      wrong), CY question 3 (two primes among the options: ambiguous). CY tries question 1 again: refused, each
 *      question is disputed once. STRANGER tries to finalize early: refused.
 *   C  the dispute window ends; STRANGER finalizes; STRANGER's claim is refused; the takers claim, ANA twice
 *      (refused); the deployed code is compared with contracts/keyed.py byte for byte; the views are checked; every
 *      party withdraws; the contract ends holding exactly what stats() says it owes (nothing); every wallet ends
 *      where the money table says, fees included.
 *
 * Every refusal is a signed transaction. A round the validators do not carry stores nothing; it is sent again and
 * both transactions are kept. Every id is read from the receipt of the call that made it. Every wait is by the
 * chain's own clock, read from the views. Every step is saved as it is made, so a run cut off continues with
 * RESUME=1 without sending anything twice.
 */
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPC = "https://studio.genlayer.com/api";
const EXPLORER = "https://explorer-studio.genlayer.com";
const STATE = process.env.STATE || join(tmpdir(), "keyed-smoke-state.json");
const RECORD = process.env.RECORD || STATE.replace(/\.json$/, "") + "-record.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const rpc = async (m, p) => {
  let last;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (j.error && (j.error.code === -32029 || j.error.code === -32429 || r.status === 429)) { await sleep(((j.error.data?.retry_after_seconds) || 20) * 1000); continue; }
      if (j.error) { last = new Error(m + ": " + JSON.stringify(j.error).slice(0, 200)); await sleep(6000); continue; }
      return j.result;
    } catch (e) { last = e; await sleep(4000); }
  }
  throw last;
};
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  - " + d : ""}`); return !!c; };
const GEN = 10n ** 18n;
const tally = (v) => `${v.agree} agree, ${v.disagree} disagree, ${v.idle} idle`;
const sha = (x) => createHash("sha256").update(x).digest("hex");
const FILE = readFileSync(new URL("../../contracts/keyed.py", import.meta.url));

// ---------- state ----------
if (existsSync(STATE) && !process.env.RESUME && !process.env.FRESH) {
  console.log("A saved run exists. RESUME=1 continues it; FRESH=1 starts over; STATE=<path> keeps another.");
  process.exit(2);
}
const st = existsSync(STATE) && process.env.RESUME && !process.env.FRESH ? JSON.parse(readFileSync(STATE, "utf8")) : {};
st.keys = st.keys || {}; st.steps = st.steps || {}; st.views = st.views || {}; st.order = st.order || []; st.fees = st.fees || {};
const save = () => {
  writeFileSync(STATE, JSON.stringify(st, null, 1));
  const { keys, ...shown } = st;       // the record carries no key
  writeFileSync(RECORD, JSON.stringify(shown, null, 1));
};
const ROLES = ["setter", "ana", "bo", "cy", "stranger"];
for (const k of ROLES) st.keys[k] = st.keys[k] || generatePrivateKey();
const acct = {}, client = {};
for (const k of ROLES) { acct[k] = createAccount(st.keys[k]); client[k] = createClient({ chain: studionet, account: acct[k] }); }
const rd = createClient({ chain: studionet });
st.accounts = Object.fromEntries(ROLES.map((k) => [k, acct[k].address]));
save();
const A = (k) => st.accounts[k];

const balance = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]) || "0x0");
const nonceOf = async (a) => Number(BigInt(await rpc("eth_getTransactionCount", [a, "latest"]) || "0x0"));
const fundOnce = async (k, whole) => {
  st.funded = st.funded || {};
  if (st.funded[k]) return;
  await rpc("sim_fundAccount", { account_address: A(k), amount: whole * 1e18 });
  for (let i = 0; i < 20 && (await balance(A(k))) === 0n; i++) await sleep(3000);
  st.funded[k] = String(await balance(A(k))); save();
};

// ---------- fees: quoted before every transaction, and read back from every transaction ----------
const quote = async (who) => {
  for (let i = 0; ; i++) {
    try {
      const q = await client[who].estimateTransactionFees({ leaderTimeunitsAllocation: 600n, validatorTimeunitsAllocation: 600n });
      if (!q?.policy?.enabled || !q?.distribution || !(q.feeValue > 0n)) throw new Error("no usable fee quote: " + JSON.stringify(q, (k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 200));
      return { distribution: q.distribution, feeValue: q.feeValue };
    } catch (e) { if (i >= 8) throw e; await sleep(10000); }
  }
};
const feeOf = async (tx) => {
  for (let i = 0; i < 30; i++) {
    const t = await rpc("eth_getTransactionByHash", [tx]);
    const fa = t?.data?.fee_accounting;
    if (fa && fa.status === "settled" && fa.paid_fee_value !== undefined) return BigInt(fa.paid_fee_value) - BigInt(fa.total_refunded || 0);
    await sleep(4000);
  }
  return null;
};

// ---------- transactions ----------
const errText = (e) => String(e?.details || e?.shortMessage || e?.cause?.message || e?.message || e);
const sendRaw = async (who, what, make) => {
  const addr = A(who);
  for (let i = 0; ; i++) {
    const n0 = await nonceOf(addr);
    try { return await make(); } catch (e) {
      const text = errText(e);
      if (i >= 8) throw e;
      console.log(`      ${what} was not taken (${text.slice(0, 70)}); looking again in 20s`);
      await sleep(20000);
      if ((await nonceOf(addr)) > n0) {
        const list = await rpc("sim_getTransactionsForAddress", [addr]);
        const hit = (list || []).find((t) => String(t.from_address).toLowerCase() === addr.toLowerCase() && Number(t.nonce) === n0);
        if (hit?.hash) return hit.hash;
        throw new Error(what + " landed but its hash could not be read back");
      }
    }
  }
};
const countVotes = (t) => { let a = 0, d = 0, idl = 0; for (const k in (t.consensus_data?.votes || {})) { const v = t.consensus_data.votes[k]; if (v === "agree") a++; else if (v === "disagree") d++; else idl++; } return { agree: a, disagree: d, idle: idl }; };
const wait = async (tx) => {
  let stuck = 0;
  for (let i = 0; i < 900; i++) {
    await sleep(4000);
    const t = await rpc("eth_getTransactionByHash", [tx]);
    if (t?.status === "FINALIZED") {
      const lr = t.consensus_data?.leader_receipt, one = Array.isArray(lr) ? lr[0] : lr;
      let msg = "";
      try { msg = Buffer.from(one.result, "base64").toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim(); } catch (e) {}
      const v = countVotes(t);
      return { tx, msg, status: t.status, exec: t.txExecutionResultName || "", leader: one?.execution_result || "", result: t.result_name || "", votes: v, applied: t.result_name === "MAJORITY_AGREE" || v.agree * 2 > v.agree + v.disagree + v.idle, address: t.data?.contract_address || t.to_address || "" };
    }
    if (t?.status === "UNDETERMINED" && (stuck = stuck + 1) > 150) return { tx, msg: "UNDETERMINED", status: t.status, exec: "", leader: "", result: "", votes: countVotes(t), applied: false, address: "" };
    if (t?.status === "CANCELED") return { tx, msg: "CANCELED", status: t.status, exec: "", leader: "", result: "", votes: { agree: 0, disagree: 0, idle: 0 }, applied: false, address: "" };
    if (i > 0 && i % 75 === 0) console.log(`      [${stamp()}] still ${t?.status || "unknown"} after ${Math.round(i * 4 / 60)} minutes: ${tx}`);
  }
  return { tx, msg: "TIMEOUT", status: "TIMEOUT", exec: "", leader: "", result: "", votes: { agree: 0, disagree: 0, idle: 0 }, applied: false, address: "" };
};
const jsonOf = (msg) => { const b = String(msg).indexOf("{"); if (b === -1) return null; try { return JSON.parse(String(msg).slice(b)); } catch (e) { return null; } };
const settleBalance = async (a, before, want) => { for (let i = 0; i < 60; i++) { const b = await balance(a); if (b - before === want) return b; await sleep(4000); } return await balance(a); };

// One step: a signed transaction with quoted fees, its status, execution result and tally, what it returned, and
// what it cost its sender. opt.value is sent with it; opt.money is the change the sender's wallet should show
// apart from the fee, once every transfer has landed (a refund emitted by the call lands a moment after it).
const call = async (id, who, fn, args = [], opt = {}) => {
  if (!st.steps[id]) { st.steps[id] = { id, who, fn, args: args.map((x) => (Array.isArray(x) ? JSON.stringify(x) : String(x))), value: String(opt.value || 0n), tries: [] }; st.order.push(id); }
  const rec = st.steps[id];
  if (!rec.done) {
    if (rec.before === undefined) { rec.before = String(await balance(A(who))); save(); }
    let r;
    for (;;) {
      if (!rec.pending) {
        const fees = await quote(who);
        rec.pending = await sendRaw(who, fn, () => client[who].writeContract({ address: st.contract, functionName: fn, args, fees, ...(opt.value ? { value: opt.value } : {}) }));
        save();
      }
      r = await wait(rec.pending);
      const fee = await feeOf(r.tx);
      st.fees[who] = String(BigInt(st.fees[who] || "0") + (fee ?? 0n));
      rec.tries.push({ tx: r.tx, status: r.status, exec: r.exec, leader: r.leader, result: r.result, votes: r.votes, applied: r.applied, fee: fee === null ? null : String(fee), msg: r.msg, at: stamp() });
      rec.pending = null; save();
      console.log(`      [${stamp()}] ${who.toUpperCase()} ${fn}(${args.map((x) => String(x).slice(0, 26)).join(", ")})${opt.value ? " +" + Number(opt.value) / 1e18 + " GEN" : ""}  ${r.tx}  ${r.status} ${r.exec}  ${tally(r.votes)}  fee ${fee}`);
      if (r.msg === "TIMEOUT" || rec.tries.length >= 4) break;
      if (!r.applied) { console.log("      the validators did not carry that round (" + tally(r.votes) + "), so nothing was stored; sending it again"); continue; }
      break;
    }
    if (opt.money !== undefined) {
      const spent = rec.tries.reduce((s, t) => s + BigInt(t.fee || "0"), 0n);
      const want = (typeof opt.money === "function" ? opt.money(jsonOf(r.msg)) : opt.money) - spent;
      const before = BigInt(rec.before);
      const now = await settleBalance(A(who), before, want);
      rec.delta = String(now - before); rec.want = String(want);
    }
    rec.done = true; save();
  }
  const last = rec.tries[rec.tries.length - 1];
  return { ...last, j: jsonOf(last.msg), tries: rec.tries, delta: rec.delta, want: rec.want };
};
const fine = (r) => r.status === "FINALIZED" && r.exec === "FINISHED_WITH_RETURN";
const refused = (r, words) => r.status === "FINALIZED" && r.exec === "FINISHED_WITH_ERROR" && r.msg.includes(words);
const moved = (r) => r.delta !== undefined && r.delta === r.want;
const votes = (r) => r.tries.map((t) => tally(t.votes)).join(", then ");

const deploy = async (id, who) => {
  if (!st.steps[id]) { st.steps[id] = { id, who, fn: "deploy keyed.py", args: [], value: "0", tries: [] }; st.order.push(id); }
  const rec = st.steps[id];
  if (!rec.done) {
    for (;;) {
      if (!rec.pending) { const fees = await quote(who); rec.pending = await sendRaw(who, "deploy", () => client[who].deployContract({ code: FILE.toString("utf8"), args: [], fees })); save(); }
      const r = await wait(rec.pending);
      const fee = await feeOf(r.tx);
      st.fees[who] = String(BigInt(st.fees[who] || "0") + (fee ?? 0n));
      rec.tries.push({ tx: r.tx, status: r.status, exec: r.exec, result: r.result, votes: r.votes, applied: r.applied, fee: fee === null ? null : String(fee), msg: r.msg.slice(0, 300), at: stamp() });
      rec.address = r.address; rec.pending = null; save();
      console.log(`      [${stamp()}] ${who.toUpperCase()} deploy keyed.py  ${r.tx}  ${r.status} ${r.exec}  ${tally(r.votes)}  ${r.address}`);
      if (r.applied || r.msg === "TIMEOUT" || rec.tries.length >= 3) break;
    }
    rec.done = true; save();
  }
  return rec;
};

// ---------- reads ----------
let lastRead = 0;
const read = async (fn, args = []) => {
  for (let i = 0; i < 30; i++) {
    const gap = 3500 - (Date.now() - lastRead);
    if (gap > 0) await sleep(gap);
    lastRead = Date.now();
    try { return JSON.parse(String(await rd.readContract({ address: st.contract, functionName: fn, args }))); } catch (e) {
      if (i === 29) return { error: "VIEW ERROR " + fn + ": " + errText(e).slice(0, 100) };
      await sleep(/rate|429|limit/i.test(errText(e)) ? 25000 : 10000);
    }
  }
};
const seen = async (id, fn, args = []) => { if (!st.views[id]) { st.views[id] = { fn, args, at: stamp(), out: await read(fn, args) }; save(); } return st.views[id].out; };
// wait, by the chain's own clock, until one of the quiz's instants has passed
const untilPast = async (field) => {
  for (;;) {
    const q = await read("quiz", ["Q1"]);
    if (q.error || !(Number(q[field]) > 0)) { console.log(`      [${stamp()}] quiz(Q1) could not be read; reading again in 30 s`); await sleep(30000); continue; }
    const now = Number(q.now > 0 ? q.now : Math.floor(Date.now() / 1000));
    const left = Number(q[field]) - now;
    if (left < -5) return;
    console.log(`      [${stamp()}] waiting ${left + 20} s, by the chain clock, for ${field} of Q1 to pass`);
    await sleep((left + 20) * 1000);
  }
};

// ---------- the demonstration: the same texts as tests/test_pure.py ----------
const TITLE = "General knowledge, round one";
const QUESTIONS = [
  ["Which planet in our solar system is closest to the Sun?", "Venus", "Mercury", "Earth", "Mars"],
  ["What is the chemical symbol for the element gold?", "Ag", "Au", "Gd", "Go"],
  ["Which of these numbers is a prime number?", "7", "9", "11", "15"],
  ["How many sides does a hexagon have?", "5", "6", "7", "8"],
];
const KEY = "BAAB";
const SALT = st.salt = st.salt || "keyed-" + sha(st.keys.setter + "salt").slice(0, 20);   // a secret until the reveal
const ANSWERS = { ana: "BBBB", bo: "AAAB", cy: "BACB" };
const tsalt = (k) => (st.tsalt = st.tsalt || {}, st.tsalt[k] = st.tsalt[k] || k + "-" + sha(st.keys[k] + "seal").slice(0, 16));
const seal = (k) => sha(ANSWERS[k] + ":" + tsalt(k) + ":" + A(k).toLowerCase());
const REASON = {
  1: "Venus is the closest planet to the Sun because it is the hottest planet.",
  2: "Ag is the symbol for silver; the chemical symbol for gold is Au.",
  3: "Both 7 and 11 are prime numbers, so the question has two correct options.",
};
const FEE = GEN / 10n, BOND = (4n * GEN) / 10n, DBOND = GEN / 20n, CUT = 1000n;
const ENTRY = 1500, REVEAL = 1500, DISPUTE = 2400;

await fundOnce("setter", 3); await fundOnce("ana", 3); await fundOnce("bo", 3); await fundOnce("cy", 3); await fundOnce("stranger", 3);
if (!st.start) { st.start = {}; for (const k of ROLES) st.start[k] = String(await balance(A(k))); st.started = new Date().toISOString(); save(); }
console.log(`[${stamp()}] ${ROLES.map((k) => k.toUpperCase().padEnd(9) + " " + A(k)).join("\n           ")}`);

// ================================================================ phase A
console.log(`\n[${stamp()}] ---- phase A: deploy, deposits, the quiz, the entries and the refusals code can make`);
const dep = await deploy("deploy", "setter");
st.contract = dep.address; save();
ok(`SETTER deploys contracts/keyed.py with quoted fees: ${dep.tries.at(-1).status}, ${dep.tries.at(-1).exec}`, dep.tries.at(-1).status === "FINALIZED" && /^FINISHED_WITH_RETURN$/.test(dep.tries.at(-1).exec) && /^0x[0-9a-fA-F]{40}$/.test(st.contract), `${tally(dep.tries.at(-1).votes)}  ${st.contract}`);
const dS = await call("depositSetter", "setter", "deposit", [], { value: BOND, money: -BOND });
ok("SETTER deposits 0.4 GEN of credit, the bond", fine(dS) && dS.j?.credit === String(BOND) && moved(dS), `${votes(dS)}  ${dS.msg.slice(0, 100)}`);
for (const k of ["ana", "bo", "cy"]) {
  const d = await call("deposit_" + k, k, "deposit", [], { value: DBOND, money: -DBOND });
  ok(`${k.toUpperCase()} deposits 0.05 GEN of credit, one dispute bond`, fine(d) && d.j?.credit === String(DBOND) && moved(d), `${votes(d)}`);
}
const com = sha(KEY + ":" + SALT);
const op = await call("open", "setter", "open_quiz", [TITLE, QUESTIONS, FEE, BOND, DBOND, CUT, ENTRY, REVEAL, DISPUTE, com]);
ok(`SETTER opens Q1, "${TITLE}": four questions, the key committed, the 0.4 GEN bond staked from credit`, fine(op) && op.j?.ok === true && op.j?.quiz === "Q1" && op.j?.questions === 4 && op.j?.credit === "0", `${votes(op)}  ${op.msg.slice(0, 140)}`);
const own = await call("enterSetter", "setter", "enter", ["Q1", "a".repeat(64)], { value: FEE, money: 0n });
ok("SETTER tries to take its own quiz: refused, the 0.1 GEN back in the same transaction", fine(own) && own.j?.ok === false && String(own.j?.reason).includes("the setter of Q1 may not take it") && own.j?.returned === String(FEE) && moved(own), `${votes(own)}  ${own.j?.reason}`);
const cheap = await call("enterCheap", "stranger", "enter", ["Q1", "b".repeat(64)], { value: FEE / 2n, money: 0n });
ok("STRANGER pays half the fee: refused, the 0.05 GEN back", fine(cheap) && cheap.j?.ok === false && String(cheap.j?.reason).includes("the entry fee of Q1 is") && moved(cheap), `${votes(cheap)}  ${cheap.j?.reason}`);
for (const k of ["ana", "bo", "cy"]) {
  const e = await call("enter_" + k, k, "enter", ["Q1", seal(k)], { value: FEE, money: -FEE });
  ok(`${k.toUpperCase()} enters Q1 with a sealed answer sheet, paying 0.1 GEN`, fine(e) && e.j?.ok === true && moved(e), `${votes(e)}  ${e.msg.slice(0, 100)}`);
}
const early = await call("revealEarly", "setter", "reveal_key", ["Q1", KEY, SALT]);
ok("SETTER tries to reveal the key while entries are open: refused", refused(early, "takes entries until"), `${votes(early)}  ${early.msg.slice(0, 110)}`);
const sKey = await call("revealStranger", "stranger", "reveal_key", ["Q1", KEY, SALT]);
ok("STRANGER tries to reveal the key: refused", refused(sKey, "only the setter of Q1 may reveal its key"), `${votes(sKey)}  ${sKey.msg.slice(0, 110)}`);

// ================================================================ phase B
console.log(`\n[${stamp()}] ---- phase B: entries close, the key, the seals, three disputes`);
await untilPast("close_at");
const late = await call("enterLate", "stranger", "enter", ["Q1", "c".repeat(64)], { value: FEE, money: 0n });
ok("STRANGER tries to enter after the close: refused, the 0.1 GEN back", fine(late) && late.j?.ok === false && String(late.j?.reason).includes("closed to entries") && moved(late), `${votes(late)}  ${late.j?.reason}`);
const bad = await call("revealWrong", "setter", "reveal_key", ["Q1", KEY, SALT + "x"]);
ok("SETTER reveals with the wrong salt: refused, the commitment does not match", refused(bad, "do not match the commitment of Q1"), `${votes(bad)}  ${bad.msg.slice(0, 110)}`);
const rv = await call("reveal", "setter", "reveal_key", ["Q1", KEY, SALT]);
ok(`SETTER reveals the key ${KEY}: it matches the commitment`, fine(rv) && rv.j?.key === KEY, `${votes(rv)}  ${rv.msg.slice(0, 120)}`);
for (const k of ["ana", "bo", "cy"]) {
  const o = await call("open_" + k, k, "reveal_answers", ["Q1", ANSWERS[k], tsalt(k)]);
  ok(`${k.toUpperCase()} opens its seal: ${ANSWERS[k]}`, fine(o) && o.j?.answers === ANSWERS[k], `${votes(o)}  ${o.msg.slice(0, 120)}`);
}
const sd = await call("disputeStranger", "stranger", "dispute", ["Q1", 1, REASON[1]]);
ok("STRANGER tries to dispute: refused, only a taker disputes", refused(sd, "only a taker of Q1 may dispute its key"), `${votes(sd)}  ${sd.msg.slice(0, 110)}`);
const sd2 = await call("disputeSetter", "setter", "dispute", ["Q1", 2, REASON[2]]);
ok("SETTER tries to dispute its own key: refused", refused(sd2, "only a taker of Q1 may dispute its key"), `${votes(sd2)}  ${sd2.msg.slice(0, 110)}`);
const out = {};
const d1 = await call("dispute1", "bo", "dispute", ["Q1", 1, REASON[1]]);
out[1] = d1.j?.outcome;
ok(`BO disputes question 1 ("Venus ... hottest"): mark ${d1.j?.mark}, the key holds, BO's 0.05 GEN bond to SETTER`, fine(d1) && d1.applied && d1.j?.mark === "2" && d1.j?.outcome === "holds" && d1.j?.credit === "0", `${votes(d1)}  ${JSON.stringify({ mark: d1.j?.mark, fp: d1.j?.fp, outcome: d1.j?.outcome })}`);
const d2 = await call("dispute2", "ana", "dispute", ["Q1", 2, REASON[2]]);
out[2] = d2.j?.outcome;
ok(`ANA disputes question 2 (keyed Ag for gold): mark ${d2.j?.mark}, wrong, void for everyone, ANA keeps her bond and takes a 0.1 GEN slice`, fine(d2) && d2.applied && d2.j?.mark === "2" && d2.j?.outcome === "wrong" && d2.j?.void === true && d2.j?.slice === String(BOND / 4n), `${votes(d2)}  ${JSON.stringify({ mark: d2.j?.mark, fp: d2.j?.fp, outcome: d2.j?.outcome })}`);
const d3 = await call("dispute3", "cy", "dispute", ["Q1", 3, REASON[3]]);
out[3] = d3.j?.outcome;
ok(`CY disputes question 3 (7 and 11 both prime): mark ${d3.j?.mark}, ambiguous, void, CY takes a 0.1 GEN slice`, fine(d3) && d3.applied && d3.j?.mark === "M" && d3.j?.outcome === "ambiguous" && d3.j?.void === true, `${votes(d3)}  ${JSON.stringify({ mark: d3.j?.mark, fp: d3.j?.fp, outcome: d3.j?.outcome })}`);
const again = await call("dispute1Again", "cy", "dispute", ["Q1", 1, "Mercury is right, but I want the validators to look at it once more."]);
ok("CY disputes question 1 again: refused, each question is disputed once, no second roll", refused(again, "question 1 of Q1 was disputed already"), `${votes(again)}  ${again.msg.slice(0, 120)}`);
const fe = await call("finalizeEarly", "stranger", "finalize", ["Q1"]);
ok("STRANGER tries to finalize inside the dispute window: refused", refused(fe, "the dispute window of Q1 ends at"), `${votes(fe)}  ${fe.msg.slice(0, 110)}`);

// ================================================================ phase C
console.log(`\n[${stamp()}] ---- phase C: the window ends, settlement, the code read back, the views, the money`);
await untilPast("dispute_end");
// the money table, worked out here from the outcomes the run actually produced
const VOIDING = ["wrong", "ambiguous", "unanswerable"];
const voided = [1, 2, 3, 4].filter((k) => VOIDING.includes(out[k]));
const score = (k) => [0, 1, 2, 3].filter((i) => ANSWERS[k][i] === KEY[i] && !voided.includes(i + 1)).length;
const correct = BigInt(score("ana") + score("bo") + score("cy"));
const fees = 3n * FEE, cut = (fees * CUT) / 10000n, pot = fees - cut;
const slice = BOND / 4n, bondLeft = BOND - slice * BigInt(voided.length);
const unit = correct > 0n ? pot / correct : 0n;
const setterPaid = correct > 0n ? cut + (pot - unit * correct) + bondLeft : cut + (pot - (pot / 3n) * 3n) + bondLeft;
const payout = (k) => (correct > 0n ? unit * BigInt(score(k)) : pot / 3n);
const disputer = { 1: "bo", 2: "ana", 3: "cy" };
const disputeMoney = (k) => { let m = 0n; for (const q of [1, 2, 3]) { if (disputer[q] !== k) continue; if (out[q] === "holds") m -= DBOND; if (VOIDING.includes(out[q])) m += slice; } return m; };
const holdsBonds = [1, 2, 3].filter((q) => out[q] === "holds").length;
const fz = await call("finalize", "stranger", "finalize", ["Q1"]);
ok(`STRANGER finalizes Q1: ${fz.j?.settled}, ${fz.j?.total_correct} correct answers on the standing questions, ${Number(BigInt(fz.j?.unit || 0)) / 1e18} GEN each`, fine(fz) && fz.j?.settled === "scored" && fz.j?.total_correct === Number(correct) && fz.j?.unit === String(unit) && fz.j?.setter_paid === String(setterPaid), `${votes(fz)}  ${fz.msg.slice(0, 160)}`);
const sc = await call("claimStranger", "stranger", "claim", ["Q1"]);
ok("STRANGER tries to claim: refused, only a taker has a share", refused(sc, "only a taker of Q1 has a share to claim"), `${votes(sc)}  ${sc.msg.slice(0, 110)}`);
for (const k of ["ana", "bo", "cy"]) {
  const c = await call("claim_" + k, k, "claim", ["Q1"]);
  ok(`${k.toUpperCase()} claims: score ${score(k)}, ${Number(payout(k)) / 1e18} GEN into its credit`, fine(c) && c.j?.score === score(k) && c.j?.payout === String(payout(k)), `${votes(c)}  ${c.msg.slice(0, 140)}`);
}
const twice = await call("claimTwice", "ana", "claim", ["Q1"]);
ok("ANA claims again: refused", refused(twice, "claimed its share of Q1 already"), `${votes(twice)}  ${twice.msg.slice(0, 110)}`);
{
  const chain = Buffer.from(String(await rpc("gen_getContractCode", [st.contract])), "base64");
  st.code = { address: st.contract, bytes: chain.length, sha256: sha(chain), file_bytes: FILE.length, file_sha256: sha(FILE), identical: Buffer.compare(chain, FILE) === 0 };
  save();
  ok(`the code deployed at ${st.contract} is byte for byte contracts/keyed.py`, st.code.identical, `${chain.length} bytes, sha256 ${st.code.sha256}`);
  const q = await seen("quiz", "quiz", ["Q1"]);
  ok("quiz(Q1) reads settled: key BAAB, three takers, three disputes, two void, every share claimed", q.key === KEY && q.takers === 3 && q.opened === 3 && q.disputes === 3 && q.void === voided.length && q.settled === "scored" && q.claimed === 3 && q.phase === "settled", JSON.stringify({ key: q.key, void: q.void, settled: q.settled, unit: q.unit, claimed_total: q.claimed_total }));
  const q2 = await seen("question2", "question", ["Q1", 2]);
  ok("question(Q1, 2) reads void, keyed A, disputed in D2, the validators' mark 2 (Au)", q2.void === true && q2.key === "A" && q2.dispute === "D2" && q2.mark === "2" && JSON.stringify(q2.tallies) === JSON.stringify([2, 1, 0, 0]), JSON.stringify(q2));
  const dv = await seen("dispute3", "dispute_of", ["D3"]);
  ok("dispute_of(D3) keeps CY's reason word for word, the mark and the fingerprint", dv.reason === REASON[3] && dv.mark === d3.j?.mark && dv.fp === d3.j?.fp && dv.disputer === A("cy").toLowerCase(), JSON.stringify({ mark: dv.mark, fp: dv.fp, outcome: dv.outcome }));
  const rules = await seen("rules", "rules", []);
  ok("rules() publishes the question word for word and the comparison", rules.dispute?.question === "Which option does the QUESTION support? Answer with the letter of that option, or AMBIGUOUS, or UNANSWERABLE." && String(rules.compared).includes("exact equality"), "");
  const owed = { setter: BigInt(holdsBonds) * DBOND + setterPaid, ana: DBOND + disputeMoney("ana") + payout("ana"), bo: DBOND + disputeMoney("bo") + payout("bo"), cy: DBOND + disputeMoney("cy") + payout("cy") };
  const statsBefore = await read("stats", []);
  const heldBefore = await balance(st.contract);
  ok("before the withdrawals the contract holds exactly the credit it owes, nothing in escrow", heldBefore === BigInt(statsBefore.held) && statsBefore.escrow_total === "0" && BigInt(statsBefore.credit_total) === Object.values(owed).reduce((a, b) => a + b, 0n), `${heldBefore} held, stats ${JSON.stringify({ credit_total: statsBefore.credit_total, escrow_total: statsBefore.escrow_total })}`);
  for (const k of ["setter", "ana", "bo", "cy"]) {
    const w = await call("withdraw_" + k, k, "withdraw", [], { money: owed[k] });
    ok(`${k.toUpperCase()} withdraws ${Number(owed[k]) / 1e18} GEN of credit, and its wallet shows it, less the fee`, fine(w) && w.j?.withdrawn === String(owed[k]) && moved(w), `${votes(w)}  delta ${w.delta}, want ${w.want}`);
  }
  let held = await balance(st.contract);
  for (let i = 0; i < 30 && held !== 0n; i++) { await sleep(4000); held = await balance(st.contract); }
  const stats = await seen("stats", "stats", []);
  ok("the contract ends holding nothing, and stats() agrees: every deposit and fee went out to its owner", held === 0n && stats.held === "0" && stats.holds === holdsBonds && stats.refused_payments === 3 && stats.returned === String(FEE + FEE / 2n + FEE), `${held} held, ${JSON.stringify({ held: stats.held, deposited: stats.deposited_total, withdrawn: stats.withdrawn_total, returned: stats.returned })}`);
  st.end = {}; for (const k of ROLES) st.end[k] = String(await balance(A(k)));
  st.ended = new Date().toISOString(); save();
  const net = (k) => BigInt(st.end[k]) - BigInt(st.start[k]);
  const want = { setter: -BOND + owed.setter, ana: -DBOND - FEE + owed.ana, bo: -DBOND - FEE + owed.bo, cy: -DBOND - FEE + owed.cy, stranger: 0n };
  ok("every wallet ends where the money table says, less exactly the fees its own transactions paid", ROLES.every((k) => net(k) === want[k] - BigInt(st.fees[k] || "0")), ROLES.map((k) => `${k.toUpperCase()} ${Number(net(k)) / 1e18} (money ${Number(want[k]) / 1e18}, fees ${Number(BigInt(st.fees[k] || "0")) / 1e18})`).join("  "));
}

st.checks = { pass, fail }; save();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`Keyed: ${st.contract}  ${EXPLORER}/address/${st.contract}`);
console.log("transactions:", st.order.reduce((n, id) => n + st.steps[id].tries.length, 0), "in", st.order.length, "steps; sent a second time:", st.order.filter((id) => st.steps[id].tries.length > 1).join(", ") || "none");
for (const id of st.order) { const s = st.steps[id]; console.log(`${id.padEnd(16)} ${s.tries.map((t) => t.tx + " " + t.status + " " + t.exec + " " + tally(t.votes)).join(" | ")}`); }
process.exit(fail ? 1 : 0);
