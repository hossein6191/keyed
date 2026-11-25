# Contracts

One file. `contracts/keyed.py`, class `Keyed`, is the contract. It is written for GenVM v0.4 (header `# v0.4.0`,
runner `py-genlayer:kzybg95x1gn21dw72m7hyg0maaap04n4nx55j9yt6fkdqxtz6bz0`), the runner Studio v0.123 ships.

## Keyed

### Purpose

A multiple-choice quiz whose answer key is bonded. A setter opens a quiz of 2 to 12 questions, each with 2 to 5
options, and commits to the key with `sha256("<key>:<salt>")`. It stakes a bond from its credit and fixes an entry
fee, a cut of the fees (at most 30%), a dispute bond, and three windows: entries, reveal and disputes. Takers pay the
fee with `enter` and seal their answers with `sha256("<answers>:<salt>:<own address>")`. When entries close, the
setter reveals the key, and the code checks it against the commitment. Inside the dispute window the takers open
their seals, and any taker may dispute ONE question with a short reason, staking the dispute bond. After the window
anyone may call `finalize`, and each taker then calls `claim`.

### Consensus

There is one round, `_judge(stem, options, reason)`, and only `dispute()` runs it. It is one
`gl.vm.run_nondet(leader_fn, validator_fn)` block. Its leader closure holds the file's only two
`gl.nondet.exec_prompt(..., response_format="json")` calls. Nothing is nested, and there is no web access.

The leader:

1. builds `_task(stem, options, reason, AS_WRITTEN)`, with the options lettered A, B, C... as the setter wrote
   them, and `_task(stem, options, reason, ROTATED)`, with the options rotated by one place and lettered again, so
   that no option keeps its letter for any count from 2 to 5;
2. reads each reply strictly with `_read_choice`: a JSON object, or the text of one, of at most 2,000 characters,
   whose `answer` is a letter of a shown option, `AMBIGUOUS` or `UNANSWERABLE`, case and spacing aside. A letter
   is mapped back through the order it was shown in to the setter's option number (1 to 5); `AMBIGUOUS` is `M`,
   `UNANSWERABLE` is `N`, anything else is `""`;
3. combines the two with `_mark`: the shared value when both are the same and not empty, `U` otherwise.

The leader returns `{"mark": <1..5, M, N or U>, "fp": _inputs_fp(stem, options, reason)}`. A model failure raises
`[LLM_ERROR]`, and then nothing is stored. `validator_fn` is `_agrees`. It returns False for a leader error. It
reruns `leader_fn` inside try/except, where a failure counts as False, and otherwise returns `theirs == mine`: the
whole stored value, by exact equality.

`_clean_value(agreed, n, expected)` reads the agreed value back. `expected` is the fingerprint worked out outside
the round from the stored texts. A mark outside the alphabet or past the question's options, or an `fp` other than
`expected`, reads `U`.

`_outcome(mark, key_letter)` gives `holds` when the mark is the key's option, `wrong` for another option,
`ambiguous` for `M`, `unanswerable` for `N`, and `unsettled` for `U`.

### Prompt

Every instruction line is a module constant: `HEADER`, `UNTRUSTED`, `EITHER_ORDER`, then the blocks `QUESTION`,
`OPTIONS` and `ARGUMENT`, then `READING`, `QUESTION`, `MEANING` and `RETURN_WORD`. `_block(label, body)` prints only
a contract label (otherwise `BLOCK`) and tags both delimiter lines with the first 16 hex characters of the body's own
sha256, so a body cannot carry its own closing line. Every untrusted string is fenced with
`str(raw).replace("<", "(").replace(">", ")")` and capped at its door limit; each option sits on its own line after
a letter the contract wrote. The model is told the key is not shown, that the argument is one party's claim and not
evidence, and that the order and the letters carry no meaning. It never sees the key, an amount, an address or a
clock.

### State

| Field | What it holds |
|---|---|
| `quiz_rows` | `Q<n>` -> `Quiz`: the setter, money, windows, commitment, key once revealed, counters, settlement |
| `question_rows` | `<quiz>\|<k>` -> `Question`: stem, options joined by newlines, the one dispute id, void flag |
| `entry_rows` | `<quiz>\|<taker>` -> `Entry`: seal, answers once opened, claimed, payout |
| `dispute_rows` | `D<n>` -> `Dispute`: question, disputer, reason, mark, fp, outcome, bond, slice |
| `tallies` | `<quiz>\|<k>\|<option>` -> takers who opened that answer |
| `balances` | address -> credit |
| `index`, `counts` | paged lists: entries and disputes of a quiz, quizzes of a setter |
| `credit_total`, `escrow_total` | what the contract owes: credit, and bonds and fees held for quizzes |

No storage dataclass holds a collection; every row is scalars.

### Key methods

| Method | Who | Model | Notes |
|---|---|---|---|
| `deposit()` payable | anyone, for itself | no | never raises; a refusal sends the value back |
| `withdraw()` | anyone, its own credit | no | |
| `open_quiz(title, questions, fee, bond, dispute_bond, cut_bps, entry_s, reveal_s, dispute_s, commitment)` | anyone; becomes the setter | no | bond from credit |
| `enter(quiz, seal)` payable | anyone but the setter, once | no | exact fee with the call; never raises |
| `reveal_key(quiz, key, salt)` | the setter | no | after close, before the deadline; checked against the commitment |
| `reveal_answers(quiz, answers, salt)` | a taker, its own seal | no | inside the dispute window; tallies kept here |
| `dispute(quiz, k, reason)` | a taker | yes, one round | one dispute per question, ever |
| `finalize(quiz)` | anyone | no | after the dispute window, or after the reveal deadline with no key |
| `claim(quiz)` | a taker | no | unit times score, or the share |
| views | `quiz`, `question`, `entry`, `dispute_of`, `entries_of`, `disputes_of`, `quizzes_of`, `credit`, `stats`, `rules` | | |

### Settlement

`scored`: `unit = (fees - cut) // correct`, where `correct` sums the tallies of the key's option over the questions
still standing (at most 12 reads); each taker's claim is `unit * score` (at most 12 comparisons); the setter gets the
cut, the remainder of the division and `bond - slices`. `no_correct`: every taker gets `(fees - cut) // takers`.
`unrevealed`: every taker gets its fee and `bond // takers`. Every remainder goes to the setter. No call walks the
takers.

### Reuse

The pieces that travel: a committed answer key checked in code; seals bound to the sealer's address; a closed-set
question asked in the written order and a rotated order inside one block so position bias becomes a disagreement in
the stored value; a judgment that can only remove an item, never write one; pull-based settlement with per-option
tallies so a pot can be divided without walking its members.
