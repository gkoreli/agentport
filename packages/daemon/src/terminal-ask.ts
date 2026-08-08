/**
 * The daemon owner's own terminal, rendering a question the agent asked.
 *
 * This is the only trusted question surface that exists (ADR-024 R12). It
 * lives here rather than inside either CLI because both need it and they must
 * not drift: two copies would be two sets of rules about what a blank answer
 * means, and "blank" is the difference between "I chose nothing" and "nobody
 * was there", which the agent is told apart.
 *
 * Supplying this is what GRANTS the connect tier its elicitation capability —
 * `#trustedSurfaces` reads `onLocalAsk`'s presence, so an embedder without a
 * terminal refuses rather than forwarding the question to the requesting page.
 *
 * The question text is AGENT-AUTHORED and, on this tier, the agent has been
 * reading the site's page. So the framing line comes first and says whose
 * words follow, exactly as `onLocalApproval` names the authority before
 * printing the agent's summary. Control characters cannot reach here at all —
 * `display()` rejects them at the wire (ADR-019) — which is what makes it safe
 * to print these strings to a terminal rather than escaping at every call.
 */
import type { Interface } from 'node:readline';
import type { AskAnswers, AskQuestion } from './runtime.js';

export interface TerminalStyle {
  bold: (text: string) => string;
  dim: (text: string) => string;
}

const PLAIN: TerminalStyle = { bold: (t) => t, dim: (t) => t };

/** How many times a mistyped choice is re-offered before the field is left blank. */
const RETRIES = 2;

export function createTerminalAsk(
  rl: Interface,
  isClosed: () => boolean,
  style: TerminalStyle = PLAIN,
): (question: AskQuestion) => Promise<AskAnswers | undefined> {
  const line = (prompt: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      // Fail shut, and fail as SKIPPED rather than as an answer: a closed or
      // non-interactive stdin means nobody is there, and inventing an empty
      // answer would attribute a choice to a user who never made one.
      if (isClosed()) return resolve(undefined);
      const onClose = () => resolve(undefined);
      rl.once('close', onClose);
      try {
        rl.question(prompt, (answer) => {
          rl.removeListener('close', onClose);
          resolve(answer);
        });
      } catch {
        rl.removeListener('close', onClose);
        resolve(undefined);
      }
    });

  return async (question) => {
    const { bold, dim } = style;
    console.log('');
    console.log(dim('  Your agent is asking you a question.'));
    console.log(`  ${bold(question.message)}`);
    console.log(dim('  Leave an answer blank to skip it.'));

    // Null-prototype: field keys arrive over the wire, and `__proto__` is a
    // legal key by the id pattern. Assigning it onto a normal object would hit
    // the prototype setter and vanish silently — the same guard the wire-side
    // answer path uses.
    const answers: AskAnswers = Object.create(null) as AskAnswers;
    let anyPrompted = false;

    for (const field of question.fields) {
      console.log('');
      console.log(`  ${field.label}`);
      let value: string | undefined;

      if (field.options && field.options.length > 0) {
        const options = field.options;
        options.forEach((option, i) => console.log(dim(`    ${i + 1}) ${option}`)));
        const hint = field.multi ? '  choose (e.g. 1,3): ' : '  choose (e.g. 1): ';
        for (let attempt = 0; attempt <= RETRIES; attempt++) {
          const raw = await line(hint);
          if (raw === undefined) return undefined;
          anyPrompted = true;
          const trimmed = raw.trim();
          if (trimmed === '') break;
          const picked = trimmed
            .split(',')
            .map((part) => Number(part.trim()))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length);
          const wanted = trimmed.split(',').length;
          if (picked.length !== wanted || (!field.multi && picked.length !== 1)) {
            console.log(dim(field.multi ? '    not a valid choice list' : '    pick exactly one'));
            continue;
          }
          // `options[n - 1]` is in range by the filter above; the assertion is
          // for noUncheckedIndexedAccess, not a claim about the input.
          value = picked.map((n) => options[n - 1] as string).join(', ');
          break;
        }
      } else {
        const raw = await line('  > ');
        if (raw === undefined) return undefined;
        anyPrompted = true;
        const trimmed = raw.trim();
        if (trimmed !== '') value = trimmed;
      }

      if (value !== undefined) answers[field.key] = value;
    }

    console.log('');
    // Nobody was ever prompted (a question with no fields): that is a skip,
    // not an empty answer. Otherwise an all-blank form IS an answer — the user
    // was asked and chose to say nothing, which ADR-024 treats as proceeding
    // without one rather than as an absent user.
    return anyPrompted ? answers : undefined;
  };
}
