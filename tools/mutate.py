"""Remove each defence of Keyed in turn, and record the test that killed it.

    python tools/mutate.py                 # writes tests/MUTATIONS.md; exit 1 if any mutant survives
    python tools/mutate.py --jobs 8        # run eight mutants at a time (default: the number of CPUs)
    python tools/mutate.py --only fence    # run only the mutants whose name contains "fence"; writes nothing

A passing count is a claim; this table is the evidence. Each mutant is written
to its own file (never over the source) and the suite runs against it with
bytecode caching off, so a stale .pyc can never attribute a kill to the wrong
code. The harness refuses to run over a failing baseline, refuses an anchor
that is not found exactly once, and treats a mutant that does not even import
as a broken anchor, never as a kill. A mutation is (name, before, after), or
(name, [(before, after), ...]) when moving a defence takes two edits.
"""
import argparse
import concurrent.futures
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = (ROOT / "contracts" / "keyed.py").read_text(encoding="utf-8")
PYTEST = [sys.executable, "-m", "pytest", "-q", "-x", "--no-header", "-p", "no:cacheprovider",
          str(ROOT / "tests" / "test_pure.py")]

# against contracts/keyed.py
MUTATIONS = [
    # --- the prompt boundary
    ("the fence does nothing",
     'return str(raw).replace("<", "(").replace(">", ")")', 'return str(raw)'),
    ("the fence deletes instead of replacing",
     'return str(raw).replace("<", "(").replace(">", ")")', 'return str(raw).replace("<", "").replace(">", "")'),
    ("the fence only replaces the opening bracket",
     'return str(raw).replace("<", "(").replace(">", ")")', 'return str(raw).replace("<", "(")'),
    ("the delimiters carry a fixed tag", '    tag = _tag(body)\n', '    tag = "0123456789abcdef"\n'),
    ("a closing line carries another tag",
     '"\\n<<<END " + name + " " + tag + ">>>"', '"\\n<<<END " + name + " " + _tag(name) + ">>>"'),
    ("any label reaches a delimiter line", 'name = label if label in LABELS else LABEL_FALLBACK', 'name = label'),
    ("the question is not fenced", '_block(LABEL_QUESTION, _fence(stem)[:MAX_STEM])', '_block(LABEL_QUESTION, stem[:MAX_STEM])'),
    ("the reason is not fenced", '_block(LABEL_ARGUMENT, _fence(reason)[:MAX_REASON])', '_block(LABEL_ARGUMENT, reason[:MAX_REASON])'),
    ("an option is not fenced", '_fence(options[shown[j]])[:MAX_OPTION]', 'options[shown[j]][:MAX_OPTION]'),
    ("an option is not capped", '_fence(options[shown[j]])[:MAX_OPTION]', '_fence(options[shown[j]])'),
    ("the option letter is left off its line", 'LETTERS[j] + ". " + _fence', '_fence'),
    ("the reason is left out",
     '+ _block(LABEL_ARGUMENT, _fence(reason)[:MAX_REASON]) + "\\n\\n"\n', ''),
    ("the prompt never says the blocks are untrusted",
     'HEADER + "\\n\\n" + UNTRUSTED + "\\n\\n" + EITHER_ORDER', 'HEADER + "\\n\\n" + EITHER_ORDER'),
    ("only the argument is called untrusted",
     "Everything inside the QUESTION, OPTIONS and ARGUMENT blocks is", "Everything inside the ARGUMENT block is"),
    ("the warning comes after the blocks",
     [('HEADER + "\\n\\n" + UNTRUSTED + "\\n\\n" + EITHER_ORDER', 'HEADER + "\\n\\n" + EITHER_ORDER'),
      ('+ READING + "\\n\\n" + QUESTION', '+ UNTRUSTED + "\\n\\n" + READING + "\\n\\n" + QUESTION')]),
    ("the order is not declared meaningless", 'UNTRUSTED + "\\n\\n" + EITHER_ORDER + "\\n\\n"', 'UNTRUSTED + "\\n\\n"'),
    ("the reading is left out", '+ READING + "\\n\\n" + QUESTION', '+ QUESTION'),
    ("the prompt does not say the key is hidden", 'The setter\'s answer key is not shown. ', ''),
    ("what the tokens mean is left out",
     '+ QUESTION + "\\n" + MEANING + "\\n" + RETURN_WORD', '+ QUESTION + "\\n" + RETURN_WORD'),
    ("AMBIGUOUS is not offered", 'Answer with the letter of that option, or AMBIGUOUS, or UNANSWERABLE.',
     'Answer with the letter of that option, or UNANSWERABLE.'),
    ("the answer shape is not asked for", 'Return JSON of the form {"answer": "B"}, ', 'Return one word, '),

    # --- the two orders
    ("the second order is the first", 'b = gl.nondet.exec_prompt(_task(stem, options, reason, ROTATED)',
     'b = gl.nondet.exec_prompt(_task(stem, options, reason, AS_WRITTEN)'),
    ("the second order is not counted",
     '_mark(_read_choice(a, n, AS_WRITTEN), _read_choice(b, n, ROTATED))',
     '_mark(_read_choice(a, n, AS_WRITTEN), _read_choice(a, n, AS_WRITTEN))'),
    ("the rotated letter is not mapped back",
     'return OPTION_MARKS[_rotation(n, order)[LETTERS.index(word)]]', 'return OPTION_MARKS[LETTERS.index(word)]'),
    ("the rotation is a reversal", 'return [(j + 1) % n for j in range(n)]', 'return [n - 1 - j for j in range(n)]'),
    ("the rotation leaves the first option in place",
     'return [(j + 1) % n for j in range(n)]', 'return [0] + [(j % (n - 1)) + 1 for j in range(1, n)]'),
    ("the rotated order is the written order", '    if order == ROTATED:\n        return [(j + 1)',
     '    if False:\n        return [(j + 1)'),

    # --- reading the model
    ("an answer is read case by case", 'word = _answer_of(raw).strip().upper()', 'word = _answer_of(raw).strip()'),
    ("a letter past the options is read", 'if len(word) == 1 and word in LETTERS[:n]:', 'if len(word) == 1 and word in LETTERS:'),
    ("AMBIGUOUS is not read", '    if word == AMBIGUOUS:\n        return MARK_M', '    if False:\n        return MARK_M'),
    ("UNANSWERABLE reads as AMBIGUOUS", '    if word == UNANSWERABLE:\n        return MARK_N',
     '    if word == UNANSWERABLE:\n        return MARK_M'),
    ("an object is cut out of prose",
     '            table = _loads_answer(text)\n', '            table = _loads_answer(text[text.find("{"):text.rfind("}") + 1])\n'),
    ("a long reply is parsed", '        if len(text) > MAX_REPLY:\n            return ""', '        if False:\n            return ""'),
    ("a model's JSON may build floats",
     'json.loads(text, parse_float=_keep_text, parse_constant=_refuse_number)', 'json.loads(text)'),

    # --- combining and the outcome
    ("one order is enough", 'if as_written != "" and as_written == rotated:', 'if as_written != "":'),
    ("two empty answers agree", 'if as_written != "" and as_written == rotated:', 'if as_written == rotated:'),
    ("a disagreement reads as ambiguous", '        return as_written\n    return MARK_U', '        return as_written\n    return MARK_M'),
    ("a wrong option reads as holds",
     'return O_HOLDS if OPTION_MARKS.index(mark) == LETTERS.index(key_letter) else O_WRONG', 'return O_HOLDS'),
    ("a matching option reads as wrong",
     'return O_HOLDS if OPTION_MARKS.index(mark) == LETTERS.index(key_letter) else O_WRONG', 'return O_WRONG'),
    ("unsettled voids", 'VOIDING = (O_WRONG, O_AMBIGUOUS, O_UNANSWERABLE)', 'VOIDING = (O_WRONG, O_AMBIGUOUS, O_UNANSWERABLE, O_UNSETTLED)'),
    ("ambiguous does not void", 'VOIDING = (O_WRONG, O_AMBIGUOUS, O_UNANSWERABLE)', 'VOIDING = (O_WRONG, O_UNANSWERABLE)'),
    ("unanswerable reads as ambiguous", '    if mark == MARK_N:\n        return O_UNANSWERABLE', '    if mark == MARK_N:\n        return O_AMBIGUOUS'),

    # --- the fingerprint and the agreed value
    ("the fingerprint leaves out the reason",
     'json.dumps({"options": options, "question": stem, "reason": reason}', 'json.dumps({"options": options, "question": stem}'),
    ("the fingerprint leaves out the options",
     'json.dumps({"options": options, "question": stem, "reason": reason}', 'json.dumps({"question": stem, "reason": reason}'),
    ("a fingerprint of other inputs is taken", '    if not good or fp != expected:', '    if not good:'),
    ("a mark past the options is taken", 'or (len(mark) == 1 and mark in OPTION_MARKS[:n]))', 'or (len(mark) == 1 and mark in OPTION_MARKS))'),
    ("the validator agrees with a leader that raised",
     '    if not isinstance(leaders_res, gl.vm.Return):\n        return False', '    if not isinstance(leaders_res, gl.vm.Return):\n        return True'),
    ("the validator only checks the shape", '    return theirs == mine', '    return isinstance(mine, dict)'),
    ("the validator's own failure escapes", '        mine = leader_fn()\n    except Exception:\n        return False',
     '        mine = leader_fn()\n    except ZeroDivisionError:\n        return False'),
    ("the validator compares the mark only", '    return theirs == mine', '    return theirs.get("mark") == mine.get("mark")'),

    # --- payable calls
    ("a refused payment keeps the value", '            _send(_low(sender), value)\n', ''),
    ("a deposit above the cap is taken", '        if value > MAX_DEPOSIT:\n', '        if False:\n'),
    ("the setter may take its own quiz", '        elif who == _low(q.setter):\n', '        elif False:\n'),
    ("the setter is compared case by case", '        elif who == _low(q.setter):\n', '        elif str(sender) == str(q.setter):\n'),
    ("an address enters twice", '        elif (qid + "|" + who) in self.entry_rows:\n', '        elif False:\n'),
    ("any fee is taken", '        elif value != int(q.fee):\n', '        elif value <= 0:\n'),
    ("entries stay open after close", '        elif now >= int(q.close_at):\n', '        elif now > int(q.close_at) + 600:\n'),
    ("a malformed seal is taken", '            problem = _sealed_problem(seal, "the seal")', '            problem = ""'),

    # --- the key and the seals
    ("anyone reveals the key", '        if _low(gl.message.sender_address) != _low(q.setter):\n            _fail("only the setter',
     '        if False:\n            _fail("only the setter'),
    ("the key is revealed before entries close", '        if now < int(q.close_at):\n            _fail(qid + " takes entries until "',
     '        if False:\n            _fail(qid + " takes entries until "'),
    ("the key is revealed after the deadline", '        if now >= int(q.reveal_by):\n            _fail("the reveal deadline',
     '        if False:\n            _fail("the reveal deadline'),
    ("the key is not checked against the commitment", '        if _key_commitment(key, salt) != str(q.commitment):',
     '        if False:'),
    ("the key is revealed twice", '        if str(q.key) != "":\n            _fail("the key of " + qid + " was revealed already")',
     '        if False:\n            _fail("the key of " + qid + " was revealed already")'),
    ("a key letter past the options is taken",
     '            if key[k] not in LETTERS[:int(self._question(qid, k + 1).n_options)]:', '            if key[k] not in LETTERS:'),
    ("the seal is not bound to the taker", 'return _sha256(answers + ":" + salt + ":" + taker.lower())',
     'return _sha256(answers + ":" + salt)'),
    ("the seal is not checked", '        if _answers_seal(answers, salt, who) != str(e.seal):', '        if False:'),
    ("answers open before the key", '        if str(q.key) == "":\n            _fail("answers to "', '        if False:\n            _fail("answers to "'),
    ("answers open twice", '        if str(e.answers) != "":\n            _fail("this taker opened', '        if False:\n            _fail("this taker opened'),
    ("answers open after the window",
     '        if now >= int(q.dispute_end):\n            _fail("the dispute window of " + qid + " ended at " + str(int(q.dispute_end)))\n        n = int(q.n_questions)\n        if not isinstance(answers',
     '        n = int(q.n_questions)\n        if not isinstance(answers'),
    ("a letter past the options is tallied",
     '            if letter in LETTERS[:int(self._question(qid, k + 1).n_options)]:', '            if letter in LETTERS:'),

    # --- disputes
    ("a stranger disputes", '            _fail("only a taker of " + qid + " may dispute its key")', '            pass'),
    ("a dispute before the key",
     '        if str(q.key) == "":\n            _fail("the key of " + qid + " is not revealed yet',
     '        if False:\n            _fail("the key of " + qid + " is not revealed yet'),
    ("a dispute after the window",
     '        if now >= int(q.dispute_end):\n            _fail("the dispute window of " + qid + " ended at " + str(int(q.dispute_end)))\n        k = ',
     '        k = '),
    ("a question is disputed twice", '        if str(row.dispute_id) != "":', '        if False:'),
    ("a dispute without credit for the bond", '        if held < bond:\n            _fail("a dispute on "', '        if False:\n            _fail("a dispute on "'),
    ("a key that holds costs the disputer nothing", '            self._take(who, bond)\n            self._give(setter, bond)\n', '            pass\n'),
    ("a void pays no slice", '            self._give(who, piece)\n', ''),
    ("a void slice is the whole bond", '            piece = int(q.bond) // n', '            piece = int(q.bond)'),
    ("a void leaves the question standing", '            row.void = 1\n', ''),
    ("the dispute is not recorded on its question", '        row.dispute_id = did\n', ''),
    ("the dispute row stores the leader's mark only after a raise", 'mark, fp = _judge(str(row.stem), options, text)',
     'mark, fp = _judge(str(row.stem), options[::-1], text)'),

    # --- settlement
    ("finalize before the window ends", '        if revealed and now < int(q.dispute_end):', '        if False:'),
    ("finalize before the reveal deadline", '        if not revealed and now < int(q.reveal_by):', '        if False:'),
    ("finalize twice", '        if str(q.settled) != "":\n            _fail(qid + " was settled already',
     '        if False:\n            _fail(qid + " was settled already'),
    ("a void question still counts", '                if int(self._question(qid, k + 1).void) == 0:\n                    letter',
     '                if True:\n                    letter'),
    ("a void question still scores", 'if answers[k] == key[k] and int(self._question(qid, k + 1).void) == 0:',
     'if answers[k] == key[k]:'),
    ("the cut is not taken", '            cut = fees * int(q.cut_bps) // BPS', '            cut = 0'),
    ("the remainder is lost", '                to_setter = cut + (pot - int(q.unit) * correct) + bond_left',
     '                to_setter = cut + bond_left'),
    ("the setter's bond left is kept", '                to_setter = cut + (pot - int(q.unit) * correct) + bond_left',
     '                to_setter = cut + (pot - int(q.unit) * correct)'),
    ("the slices are not taken from the bond left", '        bond_left = int(q.bond) - int(q.slices_paid)', '        bond_left = int(q.bond)'),
    ("an unrevealed key keeps the bond", '            share = bond_left // takers if takers > 0 else 0', '            share = 0'),
    ("a claim twice", '        if int(e.claimed) == 1:', '        if False:'),
    ("a claim before finalize", '        if str(q.settled) == "":\n            _fail(qid + " is not settled yet',
     '        if False:\n            _fail(qid + " is not settled yet'),
    ("a stranger claims", '            _fail("only a taker of " + qid + " has a share to claim")', '            pass'),
    ("a withdrawal keeps the credit", '        self.balances[who] = 0\n', ''),
]


def _env(**extra):
    return dict(os.environ, PYTHONDONTWRITEBYTECODE="1", **extra)


def run(path: pathlib.Path) -> str:
    out = subprocess.run(PYTEST, env=_env(KEYED_SOURCE=str(path)), capture_output=True, text=True, cwd=ROOT)
    if out.returncode == 0:
        return ""
    text = out.stdout + out.stderr
    if "error during collection" in text or "IndentationError" in text or "SyntaxError" in text:
        raise RuntimeError("the mutant does not even import; that is a broken anchor, not a killed defence:\n"
                           + text[-600:])
    m = re.search(r"FAILED tests/test_pure\.py::(\S+)", text)
    if not m:
        raise RuntimeError("a test failed but its name could not be read:\n" + text[-800:])
    return m.group(1)


def edits_of(rest):
    return rest[0] if len(rest) == 1 else [(rest[0], rest[1])]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    parser.add_argument("--only", default="")
    args = parser.parse_args()
    names = [m[0] for m in MUTATIONS]
    if len(set(names)) != len(names):
        print("two mutants share a name")
        return 2
    chosen = [m for m in MUTATIONS if args.only in m[0]]
    texts = []
    for name, *rest in chosen:
        text = SRC
        for old, new in edits_of(rest):
            if SRC.count(old) != 1:
                print(f"  ! anchor found {SRC.count(old)} times, expected once: {name}")
                return 2
            text = text.replace(old, new)
        if text == SRC:
            print(f"  ! the mutant is the source itself: {name}")
            return 2
        texts.append((name, text))
    baseline = subprocess.run(PYTEST, env=_env(), capture_output=True, text=True, cwd=ROOT)
    if baseline.returncode != 0:
        print("the unmutated suite does not pass; a mutation table over a failing suite proves nothing")
        print((baseline.stdout + baseline.stderr)[-600:])
        return 3
    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for k, (name, text) in enumerate(texts):
            path = pathlib.Path(tmp) / f"keyed_{k}.py"
            path.write_text(text, encoding="utf-8")
            paths.append((name, path))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            futures = {pool.submit(run, path): name for name, path in paths}
            for future in concurrent.futures.as_completed(futures):
                name = futures[future]
                killer = future.result()
                results[name] = killer
                print(f"  {'killed ' if killer else 'ESCAPED'}  {name}" + (f"  <- {killer}" if killer else ""), flush=True)
    rows = [(name, results[name]) for name, _ in texts]
    escaped = [name for name, killer in rows if not killer]
    if escaped:
        print(f"\n{len(escaped)} mutant(s) escaped; no table written:")
        for name in escaped:
            print("  - " + name)
        return 1
    if args.only:
        print(f"\n{len(rows)} / {len(rows)} killed (a subset; tests/MUTATIONS.md left as it was)")
        return 0
    table = ["# Mutations", "",
             f"{len(rows)} defences in `contracts/keyed.py`, each removed or inverted in turn, and the test "
             "that failed because of it. Generated by `tools/mutate.py`; it refuses to write this file if any mutant "
             "survives, if an anchor is not found exactly once, or if the unmutated suite is not green.", "",
             "| defence removed | killed by |", "|---|---|"]
    table += [f"| {n} | `{k}` |" for n, k in rows] + [""]
    (ROOT / "tests" / "MUTATIONS.md").write_text("\n".join(table), encoding="utf-8")
    print(f"\n{len(rows)} / {len(rows)} killed - tests/MUTATIONS.md written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
