import { z } from "zod";

/**
 * The public contract of Bugloop. Everything that leaves the widget,
 * lands in a GitHub issue, or is sent to a backend webhook follows these shapes.
 * Bump SCHEMA_VERSION on any breaking change.
 */
export const SCHEMA_VERSION = "1.0" as const;

export const FailedRequest = z.object({
  method: z.string().max(10),
  url: z.string().max(2000),
  /** 0 means the request never got a response (network error, CORS, abort). */
  status: z.number().int(),
  duration_ms: z.number().optional(),
});
export type FailedRequest = z.infer<typeof FailedRequest>;

export const Breadcrumb = z.object({
  type: z.enum(["click", "navigation"]),
  message: z.string().max(300),
  at: z.string(),
});
export type Breadcrumb = z.infer<typeof Breadcrumb>;

export const ReportContext = z.object({
  url: z.string().max(2000),
  route: z.string().max(500).optional(),
  app_version: z.string().max(100).optional(),
  user_agent: z.string().max(500).optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  console_errors: z.array(z.string().max(2000)).max(20).default([]),
  failed_requests: z.array(FailedRequest).max(20).default([]),
  breadcrumbs: z.array(Breadcrumb).max(30).default([]),
});
export type ReportContext = z.infer<typeof ReportContext>;

/**
 * Why the widget sent a report on its own (source "auto"), without the user pressing the button.
 * The server dedupes on this, so one broken endpoint becomes one issue, not one per visitor.
 */
export const AutoTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), method: z.string().max(10), url: z.string().max(2000), status: z.number().int() }),
  z.object({ kind: z.literal("error"), message: z.string().max(2000) }),
]);
export type AutoTrigger = z.infer<typeof AutoTrigger>;

/** What the widget POSTs to the intake service. */
export const ReportInput = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  /** Only needed when the server sets BUGLOOP_PROJECT_KEY (e.g. one server for several sites). */
  project_key: z.string().max(200).optional(),
  user_message: z.string().trim().min(3).max(5000),
  contact: z.string().max(200).optional(),
  /** "auto": sent by the widget when a request failed or an uncaught error was thrown; nobody typed the message. */
  source: z.enum(["user_report", "server_error", "auto"]).default("user_report"),
  trigger: AutoTrigger.optional(),
  context: ReportContext,
});
export type ReportInput = z.infer<typeof ReportInput>;

export const Area = z.enum(["frontend", "backend", "both", "unclear"]);
export type Area = z.infer<typeof Area>;

export const Tier = z.enum(["low", "mid", "high"]);
export type Tier = z.infer<typeof Tier>;

/** All probabilities and scores are normalised to 0..1. */
export const TriageResult = z.object({
  is_bug: z.number().min(0).max(1),
  frontend: z.number().min(0).max(1),
  backend: z.number().min(0).max(1),
  area: Area,
  severity: z.number().min(0).max(1),
  difficulty: z.number().min(0).max(1),
  injection_risk: z.number().min(0).max(1),
  tier: Tier,
  decided_by: z.enum(["jev", "llm", "rules"]),
});
export type TriageResult = z.infer<typeof TriageResult>;

/** Stored inside every Bugloop issue; the fixer reads it back. */
export const IssueData = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  report_id: z.string(),
  fingerprint: z.string(),
  created_at: z.string(),
  report: ReportInput.omit({ project_key: true }),
  triage: TriageResult,
});
export type IssueData = z.infer<typeof IssueData>;

/** What backend teams receive on their webhook. */
export const WebhookPayload = z.object({
  event: z.enum(["report.created", "report.duplicate"]),
  issue_url: z.string(),
  data: IssueData,
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;

export * from "./marker.ts";
export * from "./llm.ts";
