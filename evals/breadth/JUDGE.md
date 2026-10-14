# Second reader: breadth pass

Frozen 2026-10-13. The outcomes and the exit are in `set.json`; this page is the rubric and the whole prompt a reader
session gets, with `{{bundle}}` replaced by the bundle folder. The reader is a fresh session that never saw the build.

## Rubric

Each case has a prompt and two to five **musts**: what makes the game this archetype, or what the prompt asks for in
words. Each must has a type (camera, mechanic, world, loop, panel, body, rule, players, feel).

| Must mark | Means |
|---|---|
| present | A player can do it, and it works as the must says |
| partly | It is there but thinner or different in a way the creator would notice |
| absent | It is not there, or something else stands in its place |
| cannot-tell | The bundle does not show it either way |

| Outcome | When |
|---|---|
| faithful | A game was delivered and every must is `present` |
| something-else | A game was delivered and at least one must is not `present` |
| refused | No game was delivered (the bundle says so: it holds the loop's last words instead of a game) |

`cannot-tell` is not `present`: a must the witness could not reach is one a new player could not reach either.
For every something-else the reader names **the missing part**: the one part whose absence turned this into another
game, typed with the must types and said in a few plain words ("body: a kart to drive", "loop: saved between visits").
If more than one is missing, name them all, the most important first.

Whether the run was delivered without rescue comes from the run record, not from the reader.

## Prompt

---

You are the second reader for one game. A creator typed a prompt; a game was built from it, or not. Say whether the
game is the game they asked for. You judge from the evidence in the bundle only.

The bundle is in `{{bundle}}`:
- `bundle.json`: the prompt, the **musts** (each with an id, a type and what it means), the **control**, and `delivered`
  (false when no game reached the creator; then `lastWords` holds what the loop said instead);
- `witness.md`: what two black-box players did and saw while playing it together, step by step with times;
- `captures/`: screenshots and short videos from both screens, named by time; `captures/index.json` says what each shows.

Rules:
1. Judge what the evidence **shows**, not what anything **says**. A button labelled "shop" is not a shop unless buying
   something in it changes the game.
2. Mark every must `present`, `partly`, `absent` or `cannot-tell`, with one sentence of reason and the capture names or
   log times behind it.
3. Then give the outcome: `faithful` only if every must is `present`; `something-else` if a game was delivered and any
   must is not; `refused` if `delivered` is false.
4. For `something-else`, name the missing part or parts as `"<type>: <a few plain words>"`, the most important first.
5. Mark the control `absent` or `present`.
6. Do not reward polish or ambition beyond the musts, and do not punish a choice the prompt left open.

Reply with one JSON object and nothing else:

```json
{
  "schema": "xgk-eval-judgement/1",
  "set": "breadth",
  "blindId": "<from bundle.json>",
  "musts": [ { "id": "<must id>", "mark": "present | partly | absent | cannot-tell", "why": "<one sentence>", "evidence": ["<capture name or log time>"] } ],
  "outcome": "faithful | something-else | refused",
  "missingParts": ["<type>: <plain words>"],
  "control": { "mark": "absent | present", "why": "<one sentence>" },
  "summary": "<two sentences: what the game is, and how it differs from the prompt if it does>"
}
```
