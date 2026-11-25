# Decisions

What was chosen, what was refused, and which facts were measured rather than assumed. A fact marked *measured* was
observed on Studio (studio.genlayer.com, chain 61999, Studio v0.123) or with the named tool version on 25 Nov 2026.

## 1. The boundary: what the network agrees on

The network is asked one thing: for ONE disputed question, which option the question supports, or whether two or
more are defensible (AMBIGUOUS), or none (UNANSWERABLE). Everything else is code: the commitment, the seals, the
windows, who may call what, the scores, the money. The model never sees the key, so it cannot anchor on it; it never
sees an amount or an address, so it cannot be steered by them.

The stored value is `{"mark", "fp"}`: one character and a 16-hex fingerprint of the exact inputs. Validators rerun
the leader and compare that dict by exact equality. There is no tolerance anywhere in the comparison: a validator
that read the question differently disagrees, and the round stores nothing.

## 2. Two orders, one block, closed tokens

Each disputed question is asked twice inside the same leader closure: as written, and rotated by one place and
lettered again. Rotation by one, not reversal: a reversal leaves the middle option on its letter when the count is
odd (3 or 5 options), so a model that always says "C" would agree with itself. Rotation by one moves every option
for every count from 2 to 5, which a test checks. A letter is mapped back to the setter's option number before the
two answers are compared, so an honest reader gives the same number twice and a letter-biased reader gives two
different numbers and the mark `U`. Sequential prompts in one block are legal; nested nondet blocks are not.

## 3. The model can only take a question away

When the validators agree on an option other than the key's, the question is voided, not re-keyed. Re-keying would
let one consensus round write the answer every taker is scored against; voiding only removes a question the setter
got wrong. The setter's bond pays for it: a slice of `bond // questions` goes to the disputer.

`unsettled` (the two orders, or the leader's reading, did not settle) leaves the key standing and the disputer's
bond untouched. The benefit of the doubt goes to the committed key, and the disputer loses nothing for raising it.

## 4. Once per question, whatever it found

A question has at most one stored dispute. A second dispute on the same question, from anyone, is refused before the
round. So a dispute is never a second roll: a taker cannot ask until the answer suits. The one exception is the
network's own: a round that no majority carries stores nothing, and the same dispute may be sent again. That is not a
re-roll of a stored verdict; nothing was stored.

## 5. Why the answers are sealed

If answers were public at entry, a late taker could copy the crowd. A seal is `sha256(answers:salt:own address)`:
binding the address means a copied seal opens for nobody but its author. Seals are opened inside the dispute window,
after the key is public; a taker that never opens its seal scores 0 and its fee stays in the pot.

## 6. The money

- Takers pay the fee with `enter()` itself (payable). A payable call never runs the model and never raises: a
  refusal returns `ok: false` and sends the value straight back with `emit_transfer`. Value sent with a raising
  payable call is not returned on GenLayer, so no payable call has a `_fail` in its code (a static test checks).
- Bonds are credit: deposit once, stake from credit, withdraw what is left. A dispute never takes value.
- Settlement is a fixed sum per correct answer: `unit = (fees - cut) // correct`. It needs only the total of correct
  answers on the standing questions, which per-option tallies give in at most 12 reads; each claim needs only that
  taker's own answers. No call walks the takers, so no number of takers can make finalize too expensive.
- Every remainder of an integer division goes to the setter, so the contract's books close to the atto (the on-chain
  run checks the contract ends holding exactly zero).

## 7. Who may do what

| Write | Who | Why |
|---|---|---|
| `deposit`, `withdraw` | anyone, for itself | only the sender's own credit moves |
| `open_quiz` | anyone | the sender becomes the setter and stakes its own bond |
| `enter` | anyone but the setter, once | the setter knows the key |
| `reveal_key` | the setter | |
| `reveal_answers` | a taker | its own seal |
| `dispute` | a taker | the setter cannot dispute its own key |
| `finalize` | anyone | fixed rule, once, after the windows; open so a setter cannot hold the pot by staying away |
| `claim` | a taker | its own entry |

A static test lists the open writes with these reasons and fails on any new write that is neither gated by its
sender nor listed. A setter that never reveals loses its bond to the takers (`unrevealed`), so every actor has a way
out of every state.

## 8. The limits

- The validators judge by what is generally established. A question about a private or very recent fact will read
  UNANSWERABLE, which voids it: write questions whose answer is public.
- A setter that hands the key to one taker (or takes the quiz from a second address) is not detected. The seal
  stops copying between takers, not collusion with the setter.
- The first dispute on a question is the only one. A taker who disputes early with a weak argument uses up the
  question; at worst the two orders disagree and the key stands. The argument is fenced and the prompt says it is
  one party's claim, so a hostile argument should not move an honest reader.

## 9. Measured facts about the v0.4 tooling

- *measured* `gen_getContractSchemaForCode` on Studio loads `contracts/keyed.py` with the v0.4 header and returns
  its schema (the dry-run the `write-contract` skill describes).
- *measured* `genvm-linter` 0.11.1rc2: `genvm-lint check contracts/keyed.py` prints "Lint failed" with four E014
  warnings ("Class 'Quiz' used in storage needs @allow_storage decorator", and the same for `Question`, `Entry`,
  `Dispute`) and exits 1; validation passes (19 methods, 10 view, 9 write). This is the false positive the
  `genvm-lint` skill documents: `@allow_storage` does not exist on the v0.4 runner. E014 is the only finding.
- *measured* `estimateTransactionFeesForWrite` (genlayer-js 2.0.0) failed on Studio for a plain payable write:
  `sim_estimateTransactionFees` answered "execution failed" with a receipt whose result decodes to
  `fee below_minimum`. The generic `estimateTransactionFees()` works; the smoke uses it for every deploy and write,
  with the leader and validator time-unit allocations raised to the policy's maximum (600) so a dispute's two model
  calls fit. The quote deposits about 0.1 GEN; the unused part comes back when the transaction is finalized.
- *measured* What a transaction cost its sender is `data.fee_accounting.paid_fee_value - total_refunded` on the
  transaction record, once `fee_accounting.status` is `settled`. A deploy of a small contract cost 78,634,750,000,823
  atto; a payable write that sent its value back cost 126,304,250,000,823 atto, and the wallet moved by exactly that.
  The smoke uses these numbers to check every wallet to the atto.
- *measured* A v0.4 transaction record carries `status` (`FINALIZED`), `txExecutionResultName`
  (`FINISHED_WITH_RETURN`, or `FINISHED_WITH_ERROR` for a raised refusal) and `result_name` (`MAJORITY_AGREE`); the
  smoke checks the first two on every step.
- *measured* Direct mode (`genlayer-test` 0.30.0, `GENVM_VERSION=v0.6.0-rc14`) loads and runs this contract on the
  real v0.4 SDK: a full flow (deposit, open, enter, reveal, open a seal, a dispute with a mocked model, finalize,
  claim) passed. But `direct_vm.warp()` does not refresh `gl.message.raw["datetime"]`: it re-syncs only the sender,
  value and chain id, so a contract that reads the message clock keeps the clock of the moment the SDK loaded. A
  test has to set `sys.modules["genlayer.message"].raw["datetime"]` itself. The suite in this repository stays on
  its own stub and scripted network (no download, under a second), and the on-chain run covers the real runtime.

## 10. Verified, and not verified

Verified: 100 offline tests; 95 of 95 mutants killed (`tests/MUTATIONS.md`); the on-chain run in the README, whose
deployed code was read back and compared byte for byte with `contracts/keyed.py`.

Not verified: the outcome of a dispute with other models than Studio's validators; quizzes with many takers on chain
(the run had three; the cost of every call is independent of the number of takers by construction, and the tests
check no loop walks a stored collection).
