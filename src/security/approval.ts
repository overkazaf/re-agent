// Tool approval. Two independent inputs decide whether a call runs:
//
//   1. the tool's tier (read / write / exec), from its declared risk
//   2. the session's approval mode, plus any per-tool override
//
// On top of that, a command that trips a safety pattern (rm -rf, curl with the
// network off, anything that looks like a credential) always asks — that is the
// one case an "allow" override does not silence.

import type {
  AgentTool,
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  ApprovalTier,
  ExecutionPolicy,
  ToolContext,
} from "../types";

export const APPROVAL_MODES: ApprovalMode[] = ["yolo", "safe", "write", "always-ask"];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "safe";

export function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as string[]).includes(value);
}

export class ApprovalDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalDeniedError";
  }
}

export function tierForRisk(risk: AgentTool["risk"]): ApprovalTier {
  if (risk === "read") return "read";
  if (risk === "write") return "write";
  return "exec"; // execute and network are both "can do anything" tiers
}

export function autoApproves(mode: ApprovalMode, tier: ApprovalTier): boolean {
  if (mode === "yolo" || mode === "safe") return true; // `safe` only reacts to concerns
  if (tier === "read") return true;
  if (mode === "write") return tier === "write";
  return false; // always-ask
}

/**
 * Resolves one approval, prompting through `context.confirm` when a human is
 * attached. Returns normally when the call may proceed; throws otherwise.
 */
export async function requestApproval(request: ApprovalRequest, context: ToolContext): Promise<void> {
  const policy = context.policy;
  const mode = policy.approvalMode ?? DEFAULT_APPROVAL_MODE;
  const override = policy.approvals?.[request.tool];
  if (override === "deny") {
    throw new ApprovalDeniedError(`Tool '${request.tool}' is denied for this session.`);
  }

  // Safety concerns outrank an "allow" override in every mode but yolo: the
  // operator allowing `run_command` is not the same as allowing `rm -rf /`.
  const mustAsk = request.concerns.length > 0 && mode !== "yolo";
  if (!mustAsk && (override === "allow" || autoApproves(mode, request.tier))) return;

  if (!context.confirm) {
    throw new ApprovalDeniedError(refusalMessage(request, mode));
  }

  const decision = await context.confirm(request);
  applyMemory(decision, request, policy);
  if (decision === "allow" || decision === "allow-always") return;
  throw new ApprovalDeniedError(`Operator denied ${request.tool}: ${request.summary}`);
}

function applyMemory(decision: ApprovalDecision, request: ApprovalRequest, policy: ExecutionPolicy): void {
  if (decision !== "allow-always" && decision !== "deny-always") return;
  policy.approvals ??= {};
  policy.approvals[request.tool] = decision === "allow-always" ? "allow" : "deny";
}

/** What a non-interactive run reports instead of hanging on a prompt. */
function refusalMessage(request: ApprovalRequest, mode: ApprovalMode): string {
  if (request.concerns.length > 0) {
    return `Blocked by policy: ${request.concerns.join("; ")}`;
  }
  return `Tool '${request.tool}' needs approval (mode=${mode}) and this run is not interactive. Use --approval yolo or run it in the REPL.`;
}
