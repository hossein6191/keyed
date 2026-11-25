# Keyed

A multiple-choice quiz whose answer key is bonded: the setter commits to the key before anyone answers, takers seal
their answers, and when a taker disputes one question every validator answers that question itself, in two option
orders, without seeing the key. A wrong or ambiguous key voids the question for everyone and costs the setter part
of its bond.

## The problem

Bounty quizzes, certification exams and trivia pools all have the same weak point: the answer key. The setter writes
it alone, and when a question has two right answers, or the key is simply wrong, the only appeal is to the setter.
Prize money then follows a key nobody checked. And in an open pool, anyone who answers late can copy the crowd.

Keyed fixes the key before entries open, makes the setter stake a bond on it, and gives every taker one argument per
question that the network, not the setter, decides.

## What it is

Anyone may **open a quiz**. Opening fixes, for good:

- a **title** and 2 to 12 **questions**, each with 2 to 5 options, in plain text;
- a **commitment** to the key: `sha256("<key>:<salt>")`, where the key is one letter per question, A for the first
  option. Nobody can read the key from it;
- an **entry fee** (0.001 to 100 GEN), the setter's **cut** of the fees (at most 30%), the setter's **bond** and a
  **dispute bond** (each 0.01 to 100 GEN);
- three **windows**: entries, then the setter's reveal, then disputes (each 600 seconds to 30 days).

| step | who | what happens |
|---|---|---|
| `enter(quiz, seal)` | anyone but the setter, once, while entries are open | pays the fee with the call; the seal is `sha256("<answers>:<salt>:<own address>")`, so nobody can read or reuse it |
| `reveal_key(quiz, key, salt)` | the setter, after entries close and before the reveal deadline | the code checks the key against the commitment; the dispute window opens |
| `reveal_answers(quiz, answers, salt)` | a taker, inside the dispute window | opens its own seal; a seal never opened scores 0 |
| `dispute(quiz, question, reason)` | a taker, inside the dispute window | stakes the dispute bond from credit; one consensus round (below) |
| `finalize(quiz)` | anyone, after the dispute window (or after the reveal deadline if no key came) | settles by the fixed rule below |
| `claim(quiz)` | a taker | its share goes to its credit; `withdraw()` pays credit out |

Bonds are staked from **credit**: `deposit()` adds credit, `withdraw()` takes all of it back. The two payable calls,
`deposit` and `enter`, never ask the model and never raise: a refusal returns `ok: false` and sends the value
straight back.

## How consensus is used

Only a dispute asks the model, and it is one consensus block, `gl.vm.run_nondet(leader_fn, validator_fn)`. The
leader asks one question twice:

> Which option does the QUESTION support? Answer with the letter of that option, or AMBIGUOUS, or UNANSWERABLE.

The first time the options are lettered as the setter wrote them. The second time they are rotated by one place and
lettered again, so no option keeps its letter (for any count from 2 to 5; a reversal would leave the middle one in
place). Each letter is mapped back to the setter's option number, and the two answers combine into one mark:

| mark | means |
|---|---|
| `1`..`5` | both orders named the same option |
| `M` | both orders said AMBIGUOUS: two or more options are defensible |
| `N` | both orders said UNANSWERABLE: no option is correct |
| `U` | anything else, a reply that cannot be read included |

A model that answers by position ("always A") names two different options and reads `U`: position bias shows up in
the stored value instead of hiding behind a unanimous vote.

The stored value is `{"mark": <one character>, "fp": <16 hex>}`, where `fp` is the start of the sha256 of the exact
question, options and reason. Every validator reruns both askings itself and compares that dict by exact equality.
There is no tolerance. A leader whose model call failed is never agreed with, so nothing is stored and the dispute
may be sent again.

The prompt shows three blocks, QUESTION, OPTIONS and ARGUMENT, each between delimiter lines tagged with the start of
the block's own sha256, with every untrusted string fenced (`<` and `>` replaced, never deleted) and each option on
its own line after a letter the contract wrote. The model is told that all three blocks are untrusted, that the
argument is one party's claim and not evidence, and that the key is not shown. It never sees the key, an amount, an
address or a clock.

The money moves in the same call:

| outcome | when | effect |
|---|---|---|
| holds | the mark is the key's option | the disputer's bond goes to the setter |
| wrong | the mark is another option | the question is void for every taker; the disputer keeps its bond and takes a slice of the setter's bond (`bond // questions`) |
| ambiguous | `M` | void, the same |
| unanswerable | `N` | void, the same |
| unsettled | `U` | the question stands as keyed; the disputer keeps its bond |

Each question is disputed **once**, whatever the outcome: a second dispute on the same question is refused before the
round, so nobody can ask until the answer suits. The model can only take a question away; it never writes the key.

## Why this has to be on GenLayer

The disputed thing is a judgment about language and fact: does this question, as written, have exactly one right
option? No oracle answers that, and the setter is the interested party. On GenLayer several validators answer it
independently, the comparison is exact, and the consequence (a void question, a bond moved, every score recomputed)
follows in the same transaction.

## Who may do what

| write | who | why it is safe |
|---|---|---|
| `deposit`, `withdraw` | anyone | only the sender's own credit moves |
| `open_quiz` | anyone | the sender becomes the setter and stakes its own bond |
| `enter` | anyone but the setter, once | the setter knows the key |
| `reveal_key` | the setter only | |
| `reveal_answers` | a taker, its own seal | the seal is bound to its address |
| `dispute` | a taker only | |
| `finalize` | anyone | fixed rule, once, after the windows; open so a setter cannot hold the pot by staying away |
| `claim` | a taker, its own entry | |

A static test fails on any write that is neither gated by its sender nor listed with its reason.

## The money

Settlement is a fixed sum per correct answer on the questions still standing:

- **scored**: `unit = (fees - cut) // correct`, where `correct` is the number of correct answers, over all takers,
  on the questions not voided. Each taker claims `unit x its score`. The setter receives the cut, the remainder of
  the division and what is left of its bond.
- **no_correct**: no correct answer at all: each taker claims `(fees - cut) // takers`.
- **unrevealed**: the setter never revealed: each taker claims its whole fee and `bond // takers`; the setter loses
  its bond.

### Every settlement is bounded

`correct` comes from per-option tallies kept when takers open their seals, so `finalize` reads at most 12 tallies and
`claim` compares at most 12 answers. No call walks the takers, the quizzes or the disputes, whatever their number; a
static test checks that no loop iterates a stored collection.

## The limits, stated plainly

- The validators judge by what is generally established. A question about a private or very recent fact reads
  UNANSWERABLE and is voided: write questions whose answer is public.
- A setter who hands the key to a friend, or takes its own quiz from a second address, is not detected. The seal
  stops copying between takers; it cannot stop collusion with the setter.
- The first dispute on a question is the only one. A weak dispute uses the question up; at worst the two orders
  disagree and the key stands.
- A round that no majority carries stores nothing and may be sent again; a stored dispute is final.

## What is in this repository

| path | what |
|---|---|
| `contracts/keyed.py` | the contract, the only file that is deployed |
| `tests/test_pure.py` | the offline suite: a stubbed v0.4 runtime, a simulated network where every node has its own model, the journeys, and static checks over the parsed source |
| `tools/mutate.py`, `tests/MUTATIONS.md` | each defence removed in turn, and the test that caught it |
| `tests/on_chain/smoke.mjs`, `tests/on_chain/smoke-run.log` | the on-chain run against GenLayer Studio, and its log |
| `CONTRACTS.md` | the contract's state, methods and bounds |
| `DECISIONS.md` | why it is built this way, and the measured facts about the v0.4 tooling |

## Running it

```
pip install -r requirements-dev.txt
pytest tests/ -q                           # 100 passed, no network, no Studio
python tools/mutate.py                     # 95 / 95 killed, rewrites tests/MUTATIONS.md
genvm-lint check contracts/keyed.py        # lint and validation (see DECISIONS.md on the E014 false positive)
```

The on-chain run deploys its own copy with accounts it generates and funds from the Studio faucet, quotes fees for
every transaction, and at the end reads the deployed code back and compares it with `contracts/keyed.py`:

```
npm ci
node tests/on_chain/smoke.mjs
```

The run plays "General knowledge, round one": four questions, a 0.1 GEN fee, a 0.4 GEN bond, a 0.05 GEN dispute bond
and a 10% cut. The setter's key is `BAAB`: question 1 (closest planet to the Sun: Mercury, B) is right, question 2
(symbol for gold) is keyed Ag, which is silver, and question 3 (which number is prime: 7, 9, 11, 15) has two right
options. ANA, BO and CY answer `BBBB`, `AAAB` and `BACB`. Then BO disputes question 1 (and the key holds), ANA
disputes question 2 (wrong, void), CY disputes question 3 (ambiguous, void). With two questions voided, BO, who
matched the wrong key on both, drops from joint first to last.

## Network

GenLayer Studio (studio.genlayer.com), chain 61999, Studio v0.123, GenVM v0.4, runner
`py-genlayer:kzybg95x1gn21dw72m7hyg0maaap04n4nx55j9yt6fkdqxtz6bz0`, genlayer-js 2.0.0 with fees on every deploy
and write.

## Evidence

Run on 2026-11-25 on GenLayer Studio (chain 61999, Studio v0.123, GenVM v0.4) by `tests/on_chain/smoke.mjs` with genlayer-js 2.0.0, from five accounts generated for this run and funded from the Studio faucet: SETTER writes the quiz, ANA, BO and CY take it, STRANGER is anyone else. **44 passed, 0 failed**; 36 in 36 steps; sent a second time: none. Every transaction carried fees quoted by `estimateTransactionFees`, and every step was checked for its status and its execution result. The whole log is `tests/on_chain/smoke-run.log`.

- Keyed register: [`0xaF11AA533eD8048c70936Fdf0D06ada1b74FddC3`](https://explorer-studio.genlayer.com/address/0xaF11AA533eD8048c70936Fdf0D06ada1b74FddC3)
- deployed code read back with `gen_getContractCode`: 59788 bytes, sha256 `99c94c8eeeec9983cea067a5e405ebfa9b82609bc86d2e3708798c38a9f34a6f`, byte for byte `contracts/keyed.py`: **True**
- the deployed bytes, linted with `genvm-lint check` (genvm-linter 0.11.1rc2): validation passes; the only lint findings are the four E014 false positives on `@gl.storage.allow` described in `DECISIONS.md`
- the three disputes: question 1 mark `2` (the key's Mercury) **holds**, 3 agree; question 2 mark `2` (Au, keyed Ag) **wrong**, void, 3 agree; question 3 mark `M` **ambiguous**, void, 3 agree, 1 disagree, 1 idle. Settled `scored`: 5 correct answers on questions 1 and 4, 0.054 GEN each; ANA 0.108, BO 0.054, CY 0.108; SETTER 0.28 (cut 0.03 + BO's dispute bond 0.05 + bond left 0.2); the contract ends holding 0
- fees actually paid by the five accounts over the run: 0.003165 GEN in all (read from each transaction's fee accounting; every wallet check below includes them)

| check | by | transactions | status / execution | votes |
|---|---|---|---|---|
| SETTER deploys contracts/keyed.py with quoted fees: FINALIZED, FINISHED_WITH_RETURN | SETTER | [0x690be26c…](https://explorer-studio.genlayer.com/tx/0x690be26c44d8ca606631191bcf0150f70abda356fee69e8562522e9401b23c19) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| SETTER deposits 0.4 GEN of credit, the bond | SETTER | [0x5de0923f…](https://explorer-studio.genlayer.com/tx/0x5de0923f8ffbbe09c1b85b9e721d283c77fc9fbc45137084541c7291b8cc218f) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| ANA deposits 0.05 GEN of credit, one dispute bond | ANA | [0x7d84b950…](https://explorer-studio.genlayer.com/tx/0x7d84b95000c20e383b919854605cd3645039b8cff9bce820e8919a6fd33cf63f) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| BO deposits 0.05 GEN of credit, one dispute bond | BO | [0xde8e2b37…](https://explorer-studio.genlayer.com/tx/0xde8e2b375cda63552d841303f52b4c8fd7a4ccdd685b425d85ddbd388bb9bbb3) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| CY deposits 0.05 GEN of credit, one dispute bond | CY | [0x0cd051a6…](https://explorer-studio.genlayer.com/tx/0x0cd051a6566faf2c125724552bc420c9d63a41926d02da1c7f9ca6057966d4bb) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| SETTER opens Q1, "General knowledge, round one": four questions, the key committed, the 0.4 GEN bond staked from credit | SETTER | [0xe8369acd…](https://explorer-studio.genlayer.com/tx/0xe8369acd2a0481081dce264ac37a22bd9eb38aa776f6f8da5f6caccd907987eb) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| SETTER tries to take its own quiz: refused, the 0.1 GEN back in the same transaction | SETTER | [0x2e7fe1fa…](https://explorer-studio.genlayer.com/tx/0x2e7fe1fa4d19c237d8d833b669f1dc6e25ffbfcdf322e679802e6a1af6f5e3c5) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| STRANGER pays half the fee: refused, the 0.05 GEN back | STRANGER | [0xd282f936…](https://explorer-studio.genlayer.com/tx/0xd282f936b0cd7acafd60d304b5b9c26893f23625499364b9b020269b410de6eb) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| ANA enters Q1 with a sealed answer sheet, paying 0.1 GEN | ANA | [0x4cad96f2…](https://explorer-studio.genlayer.com/tx/0x4cad96f25d56aa41f0fc354a31ba61dbf86539144c0bbe9f0d223cd28f8d76e5) | FINALIZED FINISHED_WITH_RETURN | 4 agree, 0 disagree, 1 idle |
| BO enters Q1 with a sealed answer sheet, paying 0.1 GEN | BO | [0xaf011100…](https://explorer-studio.genlayer.com/tx/0xaf011100cbde2424227d51f75d97d46da17055fcf269e215734af02e728489c9) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| CY enters Q1 with a sealed answer sheet, paying 0.1 GEN | CY | [0x8676a1e9…](https://explorer-studio.genlayer.com/tx/0x8676a1e982cf599be7104e2940214f03581927da7c93e22908cfd23f2120cd53) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| SETTER tries to reveal the key while entries are open: refused | SETTER | [0x9ca3921e…](https://explorer-studio.genlayer.com/tx/0x9ca3921ea2ed20731d22b08ab18abe981288db0161b54d8465a45b90d7c2fc0f) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| STRANGER tries to reveal the key: refused | STRANGER | [0x1ce00c52…](https://explorer-studio.genlayer.com/tx/0x1ce00c52955363f045113a3dc4415d6806a0907295975a6d64862b71e6687650) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| STRANGER tries to enter after the close: refused, the 0.1 GEN back | STRANGER | [0xaf23424d…](https://explorer-studio.genlayer.com/tx/0xaf23424dbaf57c56a118dd1c707ea63ce91764b8f7b26f011dab336e9463e539) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| SETTER reveals with the wrong salt: refused, the commitment does not match | SETTER | [0x2fc2dfd5…](https://explorer-studio.genlayer.com/tx/0x2fc2dfd57b0f3b2c7b08ff3930c829ffd32ea0a27bc8d5d50a306371a0a80958) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| SETTER reveals the key BAAB: it matches the commitment | SETTER | [0x5a98e0e5…](https://explorer-studio.genlayer.com/tx/0x5a98e0e53051f5ddc7cb21ec22a2a058364bc8fd80928229d8d2330ddc1e13d2) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| ANA opens its seal: BBBB | ANA | [0x1ed6fa89…](https://explorer-studio.genlayer.com/tx/0x1ed6fa893a8f2966075c0429ba00872b5507c404e34d8a1434bce3456d38eb07) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| BO opens its seal: AAAB | BO | [0xdb4b2fe8…](https://explorer-studio.genlayer.com/tx/0xdb4b2fe8ddc3fa3d639d43b9086474d427a57516960f7f516ce96a17edc91689) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| CY opens its seal: BACB | CY | [0xae8362a0…](https://explorer-studio.genlayer.com/tx/0xae8362a0b7f15e89e71e26017f81afc5f5a54a49a166797837ebac061ca5a37b) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| STRANGER tries to dispute: refused, only a taker disputes | STRANGER | [0x7be89913…](https://explorer-studio.genlayer.com/tx/0x7be899137dfb5e393f231a942ba06707e429ea26fd89b2f394bda5e85faff533) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| SETTER tries to dispute its own key: refused | SETTER | [0x392c6540…](https://explorer-studio.genlayer.com/tx/0x392c654060d38783d7857517932bac8404830a0a9c22fa417379f16cf13425ff) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| BO disputes question 1 ("Venus ... hottest"): mark 2, the key holds, BO's 0.05 GEN bond to SETTER | BO | [0xa32e1911…](https://explorer-studio.genlayer.com/tx/0xa32e19119fb021f35d212b0364eb0d37d3609d8fff5e885249bee8e0db8835e1) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| ANA disputes question 2 (keyed Ag for gold): mark 2, wrong, void for everyone, ANA keeps her bond and takes a 0.1 GEN slice | ANA | [0x9f80bfc6…](https://explorer-studio.genlayer.com/tx/0x9f80bfc6faba62f717a9976aae5869fc688b204d8da8cdf25519ebd12243db5f) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| CY disputes question 3 (7 and 11 both prime): mark M, ambiguous, void, CY takes a 0.1 GEN slice | CY | [0x0851f8d9…](https://explorer-studio.genlayer.com/tx/0x0851f8d9926cb051996429c16cffbc17a3b5d75dac7c2b0580c1df507dd7ff89) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 1 disagree, 1 idle |
| CY disputes question 1 again: refused, each question is disputed once, no second roll | CY | [0xacdc2c23…](https://explorer-studio.genlayer.com/tx/0xacdc2c23254f96bd67c55c2d8b14653178e803381265667cf7978e6a524049ae) | FINALIZED FINISHED_WITH_ERROR | 4 agree, 0 disagree, 1 idle |
| STRANGER tries to finalize inside the dispute window: refused | STRANGER | [0x4a0bab02…](https://explorer-studio.genlayer.com/tx/0x4a0bab020b996fb96f7d19a5939a1166383a93bc2010c8be6ea96892212e27e1) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| STRANGER finalizes Q1: scored, 5 correct answers on the standing questions, 0.054 GEN each | STRANGER | [0xc3ea39db…](https://explorer-studio.genlayer.com/tx/0xc3ea39dbae42df805a3515a61f9f13667a522eea25a4faa17bf23b854c7d9aec) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| STRANGER tries to claim: refused, only a taker has a share | STRANGER | [0x53454b48…](https://explorer-studio.genlayer.com/tx/0x53454b486cd92daf318edef662ae1dabd04d9984e01e4bbe992ddff70f471820) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| ANA claims: score 2, 0.108 GEN into its credit | ANA | [0xa194edd5…](https://explorer-studio.genlayer.com/tx/0xa194edd5606864bbc5de924841347277a1dcc8223c98dfe806e085ddf4a8c736) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| BO claims: score 1, 0.054 GEN into its credit | BO | [0xa3af8b5d…](https://explorer-studio.genlayer.com/tx/0xa3af8b5d96976c18ab2a1b386675749777171865ad8e29539bf4bfed2d638706) | FINALIZED FINISHED_WITH_RETURN | 5 agree, 0 disagree, 0 idle |
| CY claims: score 2, 0.108 GEN into its credit | CY | [0x9e605b79…](https://explorer-studio.genlayer.com/tx/0x9e605b798ff97841861ec9a8d5721d80403db166fd5b52c3cc1437df0771e43d) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| ANA claims again: refused | ANA | [0xf808a253…](https://explorer-studio.genlayer.com/tx/0xf808a253779dd77b2645749d0ea4ea79536e97755301d1f5d19901ecad0a8e9a) | FINALIZED FINISHED_WITH_ERROR | 3 agree, 0 disagree, 2 idle |
| the code deployed at 0xaF11AA533eD8048c70936Fdf0D06ada1b74FddC3 is byte for byte contracts/keyed.py |  |  |  |  |
| quiz(Q1) reads settled: key BAAB, three takers, three disputes, two void, every share claimed |  |  |  |  |
| question(Q1, 2) reads void, keyed A, disputed in D2, the validators' mark 2 (Au) |  |  |  |  |
| dispute_of(D3) keeps CY's reason word for word, the mark and the fingerprint |  |  |  |  |
| rules() publishes the question word for word and the comparison |  |  |  |  |
| before the withdrawals the contract holds exactly the credit it owes, nothing in escrow |  |  |  |  |
| SETTER withdraws 0.28 GEN of credit, and its wallet shows it, less the fee | SETTER | [0x7b8a1090…](https://explorer-studio.genlayer.com/tx/0x7b8a109015973f2a9fb7aa7aa9e30fddb09d4e797193e5ac9cd3a8782468f943) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| ANA withdraws 0.258 GEN of credit, and its wallet shows it, less the fee | ANA | [0x653d519d…](https://explorer-studio.genlayer.com/tx/0x653d519d920ddb07b3f00f3f1e799db5a5a3a12b3919df3751018b3ea5017744) | FINALIZED FINISHED_WITH_RETURN | 4 agree, 0 disagree, 1 idle |
| BO withdraws 0.054 GEN of credit, and its wallet shows it, less the fee | BO | [0xdda51234…](https://explorer-studio.genlayer.com/tx/0xdda51234d51cab3cf759aed94dfb62371c74219e1ce85b2712aeba2c76560cd3) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| CY withdraws 0.258 GEN of credit, and its wallet shows it, less the fee | CY | [0x2f8e4dae…](https://explorer-studio.genlayer.com/tx/0x2f8e4daefcd84e5d5bc19e8c69ecf1f6e753fd47f4089f756b063a012c69732a) | FINALIZED FINISHED_WITH_RETURN | 3 agree, 0 disagree, 2 idle |
| the contract ends holding nothing, and stats() agrees: every deposit and fee went out to its owner |  |  |  |  |
| every wallet ends where the money table says, less exactly the fees its own transactions paid |  |  |  |  |

## Licence

MIT. See `LICENSE`.
