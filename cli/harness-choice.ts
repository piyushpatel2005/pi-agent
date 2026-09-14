// Resolve which harness to wire — flag, interactive prompt, or config default.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  HARNESSES,
  HARNESS_PRODUCT_NAME,
  requireHarness,
  type Harness,
} from "../core/engine/install.ts";

export type HarnessChoiceOptions = {
  /** From `--harness`. Skips the prompt when set. */
  harness?: string;
  /** From `--yes`. Skips the prompt and uses `configured`. */
  yes?: boolean;
  /** Value from `pi.config.json` (install / uninstall). */
  configured?: string;
  /** Suggested default when there is no config yet (`pi init`). */
  initDefault?: string;
};

/**
 * Pick a harness for install, init, or uninstall.
 *
 * Interactive when stdin is a TTY and neither `--harness` nor `--yes` was passed.
 */
export async function resolveHarnessChoice(options: HarnessChoiceOptions): Promise<string> {
  const configured = options.configured ?? options.initDefault ?? "cursor";

  if (options.harness) {
    requireHarness(options.harness);
    return options.harness;
  }

  if (options.yes || !process.stdin.isTTY) {
    requireHarness(configured);
    return configured;
  }

  console.log("");
  console.log("Which coding tool should pi harness?");
  for (let index = 0; index < HARNESSES.length; index++) {
    const id = HARNESSES[index]!;
    console.log(`  ${index + 1}. ${HARNESS_PRODUCT_NAME[id]} (${id})`);
  }

  const defaultHarness = (HARNESSES as readonly string[]).includes(configured)
    ? (configured as Harness)
    : HARNESSES[0]!;
  const defaultIndex = HARNESSES.indexOf(defaultHarness) + 1;
  console.log(
    `Press Enter for ${HARNESS_PRODUCT_NAME[defaultHarness]} (${defaultHarness}), or enter 1–${HARNESSES.length}.`,
  );
  console.log("");

  const rl = createInterface({ input, output });
  try {
    const raw = (await rl.question(`Choice [1-${HARNESSES.length}]: `)).trim();
    if (raw === "") return defaultHarness;

    const asNumber = Number.parseInt(raw, 10);
    if (asNumber >= 1 && asNumber <= HARNESSES.length) {
      return HARNESSES[asNumber - 1]!;
    }

    const lower = raw.toLowerCase();
    if ((HARNESSES as readonly string[]).includes(lower)) return lower;

    console.error(`Unrecognized choice "${raw}". Using ${defaultHarness}.`);
    return defaultHarness;
  } finally {
    rl.close();
  }
}
