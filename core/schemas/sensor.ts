// Sensors: deterministic checks that run when a step reports complete.
//
// The point of a sensor is to notice something a reader would otherwise have to
// notice for themselves — an artifact full of TBDs, code that landed with no
// documentation, a validation report that quietly skipped half its criteria.
//
// Sensors are ADVISORY. They report at the gate; they never block a write. That
// is a deliberate asymmetry with the change-budget guard, and the reason is
// false positives: "you are over 300 lines" is a count and is always right,
// while "this change needed documentation" is a judgement that will sometimes
// be wrong. A guard that is sometimes wrong trains people to work around
// guards. A report that is sometimes wrong just costs a glance.

import { z } from "zod";

export const Severity = {
  /** Something a human should look at before approving. */
  Warn: "warn",
  /** Worth saying, not worth stopping for. */
  Info: "info",
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

export const Finding = z.object({
  severity: z.enum(Object.values(Severity) as [Severity, ...Severity[]]),
  /** One sentence, written for the person reading the gate. */
  message: z.string().min(1),
  /** The file this is about, when there is one. */
  path: z.string().optional(),
});

export type Finding = z.infer<typeof Finding>;

export const SensorResult = z.object({
  sensor: z.string().min(1),
  /** False when anything at `warn` was found. */
  pass: z.boolean(),
  findings: z.array(Finding).default([]),
  /**
   * Why the sensor did not run. A sensor that cannot check something must say
   * so rather than passing, otherwise a green report means two different things.
   */
  skipped: z.string().optional(),
});

export type SensorResult = z.infer<typeof SensorResult>;

export function pass(sensor: string, findings: Finding[] = []): SensorResult {
  return {
    sensor,
    pass: !findings.some((finding) => finding.severity === Severity.Warn),
    findings,
  };
}

export function skip(sensor: string, reason: string): SensorResult {
  return { sensor, pass: true, findings: [], skipped: reason };
}

export function warn(message: string, path?: string): Finding {
  return { severity: Severity.Warn, message, ...(path ? { path } : {}) };
}

export function info(message: string, path?: string): Finding {
  return { severity: Severity.Info, message, ...(path ? { path } : {}) };
}
