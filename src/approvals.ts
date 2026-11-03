/**
 * Approval projection: host pending records → the browser's `/approvals` rows.
 *
 * Nothing in this module talks to the Gateway. It turns the payload a list call
 * returned into the row the extension validates, and turns the row's decision back
 * into the decision the host understands, which keeps both directions testable
 * without a running agent.
 *
 * Two rules shape everything below. The first is the host's own fail-closed bound:
 * a decision outside the record's persisted `allowedDecisions` is not rejected as a
 * bad request but silently applied as a denial, so the scopes a row advertises must
 * come from the same derivation the Gateway used when it created the record. The
 * second is byte stability: the extension compares a row against the one it read a
 * second ago before it accepts any decision, so a derived field must never depend on
 * the clock, on a config reload, or on which of two equivalent spellings the host
 * happened to pick.
 */
import {
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalDecision,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequestPayload,
  PluginApprovalRequestPayload,
} from "openclaw/plugin-sdk/approval-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import {
  APPROVAL_SCOPE_PRESENTATION,
  APPROVAL_TARGET_MAX_CHARS,
  type ApprovalDecisionPayload,
  type ApprovalDto,
  type ApprovalScopeId,
  type ApprovalScopeOption,
} from "./protocol.js";

/** Approval families this endpoint can show and decide. A host kind outside these is not listed. */
export type PageAssistApprovalKind = "exec" | "plugin";

/**
 * One pending record as delivered by `exec.approval.list` / `plugin.approval.list`.
 *
 * `request` stays a record rather than a payload type: the list crosses a wire, and
 * every field is read through a checked accessor below instead of being trusted from
 * a cast.
 */
export type PageAssistApprovalEntry = {
  kind: PageAssistApprovalKind;
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  request: Readonly<Record<string, unknown>>;
};

/** Text that failed the safety check, so none of it may reach a reviewer. */
const APPROVAL_TEXT_SUPPRESSED =
  "[approval text suppressed by display safety policy; decide it on the native surface]";

/**
 * An exec record whose display resolver produced nothing. Distinct from the sentence
 * above because nothing was withheld — the record simply has no command to show, and a
 * reviewer told about a safety policy that never fired would look for one.
 */
const APPROVAL_TARGET_NO_COMMAND = "[the approval record carries no command text]";

/** A `\u{...}` escape for one code point, kept as text so source files stay ASCII. */
function codePointLiteral(codePoint: number): string {
  return `\\u{${codePoint.toString(16).toUpperCase()}}`;
}

/**
 * Invisible and spoof-prone code points, matching the host's approval sanitizer
 * (`src/infra/exec-approval-text-sanitize.ts`) so an escaped command renders the same
 * here as it does in the Control UI.
 *
 * Built from code points rather than written as a literal class on purpose: a pattern
 * whose job is to remove invisible characters must not itself contain any, or an edit
 * to this file could silently change what it matches. Unicode mode keeps `\p{Cs}` on
 * unpaired surrogate halves, which is all of them a JS string can carry.
 */
const INVISIBLE_CHARS = new RegExp(
  "[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}" +
    [0x00a0, 0x1680, 0x202f, 0x205f, 0x3000, 0x115f, 0x1160, 0x3164, 0xffa0]
      .map(codePointLiteral)
      .join("") +
    codePointLiteral(0x2000) +
    "-" +
    codePointLiteral(0x200a) +
    "]",
  "gu",
);

/** The two line breaks the host normalizes before it escapes anything. */
const UNICODE_LINE_BREAKS = new RegExp(
  `[${[0x2028, 0x2029].map(codePointLiteral).join("")}]`,
  "gu",
);

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

/**
 * Redacts secrets and escapes spoofable characters in text this endpoint shows raw.
 *
 * The host's own sanitizer is not on the Plugin SDK surface, and it does one thing more
 * than the exported redactor can: it proves that removing invisible characters cannot
 * expose a secret the untouched text hid, which needs a redaction bitmap this module has
 * no access to. The same guarantee is kept here by refusing to show the text whenever the
 * two views disagree — a hidden warning costs the user a click on the native surface,
 * while one visible secret is not recoverable.
 */
function sanitizeApprovalText(value: string, options?: { preserveLineBreaks?: boolean }): string {
  const redacted = redactSensitiveText(value, { mode: "tools" });
  const stripped = value.replace(INVISIBLE_CHARS, "");
  if (stripped === value) {
    // No invisibles at all: both views have identical coverage, so the redacted text is safe.
    return redacted;
  }
  if (redactSensitiveText(stripped, { mode: "tools" }) !== stripped) {
    // Removing invisibles reached a secret. Which spans the untouched text missed cannot
    // be determined here, so nothing is displayed.
    return APPROVAL_TEXT_SUPPRESSED;
  }
  const escape = (char: string): string =>
    options?.preserveLineBreaks && char === "\n" ? char : formatCodePointEscape(char);
  return value.replace(INVISIBLE_CHARS, escape);
}

/** Maps every line break the host recognizes onto `\n`, the shape its prose cap uses. */
function normalizeApprovalLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(UNICODE_LINE_BREAKS, "\n");
}

/** Code-point-safe cut at the wire ceiling, so a row never splits a surrogate pair. */
function truncateApprovalText(value: string): string {
  if (value.length <= APPROVAL_TARGET_MAX_CHARS) {
    return value;
  }
  return Array.from(value).slice(0, APPROVAL_TARGET_MAX_CHARS).join("");
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The extension's identifier rule: a non-empty string of at most 512 characters.
 *
 * An id outside it is not shown rather than sent, because one bad row makes the whole
 * `/approvals` response fail validation in the browser — the panel would lose every
 * approval it could have acted on because one field the host wrote was junk.
 */
const WIRE_ID_MAX_CHARS = 512;

function readWireId(value: unknown): string | null {
  const trimmed = readText(value);
  return trimmed && trimmed.length <= WIRE_ID_MAX_CHARS ? trimmed : null;
}

/** Keeps only decisions the host can name, in the order given, without repeats. */
function readDecisionList(value: unknown): ExecApprovalDecision[] {
  const decisions: ExecApprovalDecision[] = [];
  if (!Array.isArray(value)) {
    return decisions;
  }
  for (const entry of value) {
    if (
      (entry === "allow-once" || entry === "allow-always" || entry === "deny") &&
      !decisions.includes(entry)
    ) {
      decisions.push(entry);
    }
  }
  return decisions;
}

/**
 * The decision set the Gateway will accept for this record.
 *
 * Denial is always available — the host appends it even when a request supplied a
 * malformed list — so a row that advertises no approve scope is still decidable.
 */
function canonicalizeDecisions(decisions: readonly ExecApprovalDecision[]): ExecApprovalDecision[] {
  const allowed = readDecisionList(decisions);
  return allowed.includes("deny") ? allowed : [...allowed, "deny"];
}

/**
 * Derives the allowed decisions the way the Gateway did when it persisted the record, so
 * every scope this endpoint advertises is one the host will honour.
 *
 * exec reads the policy knobs (`ask`, `unavailableDecisions`) through the exported
 * resolver and ignores any list the payload carries; plugin reads the plugin's own list
 * and defaults to all three. The plugin branch mirrors
 * `resolveCanonicalPluginApprovalRequestAllowedDecisions` from
 * `src/infra/plugin-approvals.ts`, which the SDK does not export.
 */
export function resolveApprovalAllowedDecisions(
  entry: PageAssistApprovalEntry,
): readonly ExecApprovalDecision[] {
  if (entry.kind === "exec") {
    const request = entry.request as Partial<ExecApprovalRequestPayload>;
    return canonicalizeDecisions(
      resolveExecApprovalRequestAllowedDecisions({
        ask: typeof request.ask === "string" ? request.ask : null,
        unavailableDecisions: Array.isArray(request.unavailableDecisions)
          ? request.unavailableDecisions
          : null,
      }),
    );
  }
  const explicit = readDecisionList(
    (entry.request as Partial<PluginApprovalRequestPayload>).allowedDecisions,
  );
  return canonicalizeDecisions(
    explicit.length > 0 ? explicit : ["allow-once", "allow-always", "deny"],
  );
}

/**
 * The approve buttons for one row, in contract order.
 *
 * `deny` is not a scope: the extension renders a separate reject control, and the
 * reference channel's rows never list it either.
 */
export function buildApprovalScopes(
  allowedDecisions: readonly ExecApprovalDecision[],
): ApprovalScopeOption[] {
  const scopes: ApprovalScopeOption[] = [];
  if (allowedDecisions.includes("allow-once")) {
    scopes.push(APPROVAL_SCOPE_PRESENTATION.exact);
  }
  if (allowedDecisions.includes("allow-always")) {
    scopes.push(APPROVAL_SCOPE_PRESENTATION.similar);
  }
  return scopes;
}

/** The host session this record belongs to, or `null` when it carries none. */
export function approvalSessionKey(entry: PageAssistApprovalEntry): string | null {
  return readText(entry.request.sessionKey);
}

/** The agent that raised the record; the row falls back to this endpoint's bound agent. */
export function approvalAgentId(entry: PageAssistApprovalEntry): string | null {
  return readWireId(entry.request.agentId);
}

/**
 * What the panel shows as the tool name.
 *
 * An exec approval is about a command, not about a tool, so the fixed label is both
 * accurate and stable across polls; a plugin's title is the sentence the plugin wrote
 * for exactly this purpose.
 */
function buildApprovalTool(entry: PageAssistApprovalEntry): string {
  if (entry.kind === "exec") {
    return "exec";
  }
  return sanitizeApprovalText(readText(entry.request.title) ?? "Plugin action");
}

/**
 * The target the user is being asked about, never a model-written summary of it.
 *
 * exec reads the host's own sanitized command display text — the same string the Control
 * UI shows — so the two surfaces cannot disagree about what was approved.
 */
function buildApprovalTarget(entry: PageAssistApprovalEntry): string {
  if (entry.kind === "exec") {
    const { commandText } = resolveExecApprovalCommandDisplay(
      entry.request as ExecApprovalRequestPayload,
    );
    return truncateApprovalText(commandText || APPROVAL_TARGET_NO_COMMAND);
  }
  // A plugin that wrote no description still has to show what it is asking about, so the
  // tool name carries the row — the reference channel falls back the same way rather than
  // leaving a row the user cannot make sense of.
  const description = readText(entry.request.description);
  if (!description) {
    return readText(entry.request.toolName) ?? "Plugin action";
  }
  return truncateApprovalText(sanitizeApprovalText(description));
}

/**
 * Why the host is asking.
 *
 * exec prefers the analyzer's warning prose, then the risk categories it classified, and
 * only then a neutral sentence: an empty risk row reads as "no risk", which is the one
 * thing an approval prompt must never imply. plugin records carry a severity instead of
 * an analysis, and the reference channel surfaces it the same way, defaulting to
 * `warning` exactly as the host's presentation does.
 */
function buildApprovalRisk(entry: PageAssistApprovalEntry): string {
  if (entry.kind === "exec") {
    const request = entry.request as Partial<ExecApprovalRequestPayload>;
    const warning = readText(request.warningText);
    if (warning) {
      return truncateApprovalText(
        sanitizeApprovalText(normalizeApprovalLineBreaks(warning), {
          preserveLineBreaks: true,
        }),
      );
    }
    const classified = Array.isArray(request.commandAnalysis?.riskKinds)
      ? request.commandAnalysis.riskKinds
      : [];
    const kinds = classified
      .map((kind) => readText(kind))
      .filter((kind): kind is string => kind !== null);
    if (kinds.length > 0) {
      return `Risk: ${kinds.map((kind) => sanitizeApprovalText(kind)).join(", ")}`;
    }
    return "Native policy requires approval before this command runs";
  }
  const severity = readText((entry.request as Partial<PluginApprovalRequestPayload>).severity);
  const normalized =
    severity === "info" || severity === "warning" || severity === "critical"
      ? severity
      : "warning";
  return `Severity ${normalized}`;
}

/**
 * One `/approvals` row, or `null` when the record cannot produce a valid one.
 *
 * `conversationId` and `requestId` come from the caller because a row is only meaningful
 * for the browser conversation that owns the session, and the extension's validator
 * rejects an empty `requestId`: a record whose run already finished is a row the user
 * cannot act on, so it is dropped rather than shown with a dangling id.
 *
 * `tool`, `target` and `risk` are not checked the same way because they cannot come out
 * empty — every builder below ends in a fixed label — and a row with a weak label is still
 * one the user can decide, which beats a row the panel never sees.
 */
export function buildApprovalDto(params: {
  entry: PageAssistApprovalEntry;
  conversationId: string;
  requestId: string;
  fallbackAgentId: string;
  nowMs: number;
}): ApprovalDto | null {
  const { entry } = params;
  if (!params.requestId) {
    return null;
  }
  const agentId = approvalAgentId(entry) ?? params.fallbackAgentId;
  if (!agentId) {
    return null;
  }
  return {
    id: entry.id,
    conversationId: params.conversationId,
    agentId,
    requestId: params.requestId,
    tool: buildApprovalTool(entry),
    target: buildApprovalTarget(entry),
    risk: buildApprovalRisk(entry),
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
    actionable: entry.expiresAtMs > params.nowMs,
    scopes: buildApprovalScopes(resolveApprovalAllowedDecisions(entry)),
  };
}

/**
 * Reads one list response into entries, dropping rows that cannot be a record.
 *
 * A row that fails to parse is skipped rather than failing the whole poll: the panel is
 * better off showing the approvals it can read than nothing at all, and a malformed row
 * is rejected by the host at resolve time in any case.
 */
export function normalizeApprovalListResponse(
  value: unknown,
  kind: PageAssistApprovalKind,
): PageAssistApprovalEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: PageAssistApprovalEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const id = readWireId(record.id);
    const request = record.request;
    if (
      !id ||
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      !Number.isFinite(record.createdAtMs) ||
      !Number.isFinite(record.expiresAtMs)
    ) {
      continue;
    }
    // Each list method stamps its own kind; the payload-derived fallback covers a host
    // that replies without the field, which is how the reader side derives it too.
    const rowKind = readText(record.approvalKind);
    entries.push({
      kind: rowKind === "exec" || rowKind === "plugin" ? rowKind : kind,
      id,
      createdAtMs: Number(record.createdAtMs),
      expiresAtMs: Number(record.expiresAtMs),
      request: request as Readonly<Record<string, unknown>>,
    });
  }
  return entries;
}

/** The host decision a browser row maps to, plus the scope that was offered. */
export type PageAssistApprovalChoice = {
  decision: ExecApprovalDecision;
  approvalKind: PageAssistApprovalKind;
  scope?: ApprovalScopeId;
};

/**
 * Maps a validated decision payload onto the host's decision.
 *
 * The mapping is exact — `exact`→`allow-once`, `similar`→`allow-always`, any denial to
 * `deny` — and the result is checked against the record's own allowed set rather than
 * assumed: a decision the host does not list would be applied as a denial by its
 * fail-closed path, which would tell the user their approval worked while their command
 * never runs.
 *
 * A refusal is thrown as `RangeError` so this module stays free of the HTTP layer; the
 * route turns it into the contract's 400.
 */
export function resolveApprovalDecision(
  entry: PageAssistApprovalEntry,
  payload: ApprovalDecisionPayload,
): PageAssistApprovalChoice {
  if (!payload.approved) {
    return { decision: "deny", approvalKind: entry.kind };
  }
  const scope: ApprovalScopeId = payload.scope ?? "exact";
  const allowed = resolveApprovalAllowedDecisions(entry);
  if (scope === "exact" && !allowed.includes("allow-once")) {
    // Not the reference channel's wording, which has no one-off floor to state and so
    // only ever covers the generalized scope an exec policy can withhold.
    throw new RangeError("This approval has no one-off scope");
  }
  if (scope === "similar" && !allowed.includes("allow-always")) {
    throw new RangeError("This approval has no generalized scope");
  }
  return {
    decision: scope === "exact" ? "allow-once" : "allow-always",
    approvalKind: entry.kind,
    scope,
  };
}
