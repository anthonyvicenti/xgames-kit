// JSON Schemas the MCP tools share: the play-test report (an input), and the output schemas of the tools whose answer
// has a stable shape (MCP 2025-06-18 `outputSchema`; the server sends the answer as `structuredContent` too). Output
// schemas name what a caller can rely on and allow more: a tool may add a field, never drop a required one.
// Not under builder/mcp/tools/: every file there is a tools file (builder/mcp/server.mjs loads them all).

const str = { type: 'string' };
const strOrNull = { type: ['string', 'null'] };
const strings = { type: 'array', items: str };

/**
 * The play-test report gamesfun_playtest_report takes (builder/loop/playtest.mjs readReport): every promise the round
 * asked, by its id, as seen (with evidence), not-seen or unreachable (with a note).
 */
export const PLAYTEST_REPORT = {
  type: 'object',
  description: 'One entry in `promises` for every promise the round asked, by its id.',
  required: ['promises', 'summary'],
  additionalProperties: false,
  properties: {
    promises: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'status'], additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 60, description: 'The promise id from the round\'s message, e.g. control.primary or build.1' },
          status: { type: 'string', enum: ['seen', 'not-seen', 'unreachable'], description: 'seen: it happened on your own screen (give evidence); not-seen: you got where it should happen and it did not; unreachable: you could not get there (say how far you got).' },
          evidence: { ...strings, description: 'Screenshot paths (from gamesfun_play) or the HUD\'s words.' },
          note: { type: 'string', description: 'What you did and what the screen showed, in plain words.' },
          run: { type: 'string', maxLength: 60, description: 'The gamesfun_play run it rests on (its name). A two-player promise: the friends run.' },
          screens: { type: 'object', additionalProperties: false, properties: { host: { type: 'string' }, friend: { type: 'string' } }, description: 'A two-player promise: what each screen showed, the host\'s and the friend\'s.' },
        },
      },
    },
    feel: { ...strings, description: 'What a new player would say, one line each.' },
    summary: { type: 'string', description: 'Two or three sentences, as you would tell the friend who made it.' },
  },
};

/**
 * The second reader's reading gamesfun_reader_report takes (builder/loop/reader.mjs readReading): every ledger line,
 * by its id, kept, partly, lost or cannot-tell, with a reason; evidence for kept and partly.
 */
export const READING = {
  type: 'object',
  description: 'One entry in `rows` for every ledger line, by its id.',
  required: ['rows', 'summary'],
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: 'gf-reading/1' },
    rows: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'mark', 'why'], additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 32, description: 'The ledger line\'s id from the task message.' },
          mark: { type: 'string', enum: ['kept', 'partly', 'lost', 'cannot-tell'], description: 'kept: the evidence shows it as their words ask; partly: there, thinner or different in a way they would notice; lost: absent or replaced; cannot-tell: nothing shows it either way.' },
          why: { type: 'string', description: 'One sentence of reason.' },
          evidence: { ...strings, description: 'Capture file names or the play-tester\'s notes that support the mark (required for kept and partly).' },
        },
      },
    },
    findings: { ...strings, description: 'What the person would notice that the marks do not say, one plain sentence each.' },
    summary: { type: 'string', description: 'Two sentences: what the game is, and the biggest thing it kept or lost.' },
  },
};

/** What a loop tool says comes next: the tool and its arguments (null while the person has the next move). */
const CALL = { type: ['object', 'null'] };
/** A round handed to the session or to the play-tester. */
const ROUND = { type: 'object', properties: { kind: strOrNull, model: strOrNull, area: strOrNull, message: strOrNull } };

/** Every gamesfun_step_* tool, gamesfun_ask and gamesfun_change: where the loop stands after the call (builder/mcp/loop-tools.mjs where()). */
export const STEP_OUTPUT = {
  type: 'object',
  required: ['status', 'step'],
  properties: {
    ran: strOrNull, why: strOrNull, status: strOrNull, step: strOrNull, tool: strOrNull, args: CALL, do: str, round: ROUND,
    action: { type: ['object', 'null'], properties: { tool: strOrNull, args: CALL, returns: str, or: CALL } },
    ladder: { type: 'object' }, waitingOn: str, about: str, after: CALL, refused: str, problems: strings, outcome: { type: ['object', 'string', 'null'] },
    proof: { type: 'object' }, rolledBack: { type: 'object' },
  },
};

/** gamesfun_next: the same, read from the state alone (status and step are null before a run starts). */
export const NEXT_OUTPUT = { ...STEP_OUTPUT, required: ['status', 'step', 'do'], properties: { ...STEP_OUTPUT.properties, checkpoints: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: str, at: str, before: str } } } } };

/** gamesfun_rollback */
export const ROLLBACK_OUTPUT = {
  type: 'object',
  required: ['game', 'restored'],
  properties: { game: str, restored: str, takenAt: strOrNull, written: { type: 'array' }, removed: { type: 'array' }, hash: strOrNull, proof: { type: 'object' }, note: str, next: CALL },
};

/** gamesfun_playtest_report */
export const REPORT_OUTPUT = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, kept: { type: 'boolean' }, do: str } };

/** gamesfun_play */
export const PLAY_OUTPUT = {
  type: 'object',
  required: ['run', 'folder', 'screenshots', 'log'],
  properties: { run: str, folder: str, evidenceBase: str, screenshots: strings, log: strings, exit: { type: 'integer' }, errors: strings, note: str },
};

/** gamesfun_verify */
export const VERIFY_OUTPUT = {
  type: 'object',
  required: ['game', 'pass', 'passed', 'ran', 'failed', 'checks'],
  properties: {
    game: str, pass: { type: 'boolean' }, passed: { type: 'integer' }, ran: { type: 'integer' },
    skipped: { type: 'array', items: { type: ['integer', 'string'] } },
    failed: { type: 'array', items: { type: 'object', required: ['n', 'name'], properties: { n: { type: ['integer', 'string'] }, name: str, detail: { type: ['string', 'null'] } } } },
    checks: { ...strings, description: 'One line per check: PASS, FAIL or SKIP, its number and name, and a failure\'s detail.' },
    notes: { type: 'array' }, evidence: strOrNull, seconds: { type: ['number', 'null'] },
  },
};

/** gamesfun_catalog: the catalog in lines (`text`), or with `json` the raw sections by name. */
export const CATALOG_OUTPUT = {
  type: 'object',
  description: 'Without json: { text } (the catalog in lines). With json: one key per section asked for (loops also gives loopGuide).',
  properties: {
    text: str,
    loops: {}, loopGuide: {}, mechanics: {}, worlds: {}, looks: {}, bodies: {}, props: {}, clips: {}, fair: {}, spec: {},
  },
};

const SLOT = {
  type: 'object', required: ['id', 'type'],
  properties: { id: str, label: str, type: str, group: str, file: str, bytes: { type: 'integer' }, value: {}, constraints: {} },
};
/** gamesfun_slots_list */
export const SLOTS_LIST_OUTPUT = {
  type: 'object',
  required: ['total', 'shown', 'slots'],
  properties: { total: { type: 'integer' }, shown: { type: 'integer' }, groups: {}, slots: { type: 'array', items: SLOT } },
};
/** gamesfun_slots_set */
export const SLOTS_SET_OUTPUT = {
  type: 'object',
  required: ['id', 'file'],
  properties: { id: str, file: str, pointer: {}, before: {}, after: {}, bytes: { type: 'integer' }, pictures: { type: 'array' }, slots: {}, reminder: str },
};
