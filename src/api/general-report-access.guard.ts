import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ARTIFACT_TICKETS, GENERAL_REPORT_TICKET_SUBJECT, type TicketStore } from "../auth/artifact-ticket";
import { bearerTokenOf, enforceRole } from "../auth/access-control";
import { API_KEY_VERIFIER, type CredentialVerifier } from "../auth/api-key-verifier";
import { WEB_SESSIONS, type WebSessions } from "../auth/web-sessions";

/**
 * Guards `GET /v1/report/general/html` — the general report's public page, same reasoning as
 * `ArtifactAccessGuard` (a caller with no session or API key, opening a link a webhook handed them).
 * A separate guard, not a reuse of `ArtifactAccessGuard`, because this route has no `:id` param to
 * compare the ticket against: it resolves to the one fixed `GENERAL_REPORT_TICKET_SUBJECT` instead.
 */
@Injectable()
export class GeneralReportAccessGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_VERIFIER) private readonly apiKeys: CredentialVerifier,
    @Inject(WEB_SESSIONS) private readonly sessions: WebSessions,
    @Inject(ARTIFACT_TICKETS) private readonly tickets: TicketStore,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerTokenOf(request);

    if (token && this.apiKeys.verify(token)) {
      request.auth = { kind: "service" };
      return true;
    }

    if (token) {
      const user = this.sessions.verify(token);
      if (user) {
        request.auth = { kind: "user", username: user.username, role: user.role };
        enforceRole(this.reflector, context, user);
        return true;
      }
    }

    const ticket = typeof request.query.ticket === "string" ? request.query.ticket : undefined;
    if (ticket && this.tickets.resolve(ticket) === GENERAL_REPORT_TICKET_SUBJECT) return true;

    throw new UnauthorizedException("Invalid or missing credentials");
  }
}
