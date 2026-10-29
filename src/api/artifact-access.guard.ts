import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ARTIFACT_TICKETS, type ArtifactTickets } from "../auth/artifact-ticket";
import { bearerTokenOf, enforceRole } from "../auth/access-control";
import { API_KEY_VERIFIER, type CredentialVerifier } from "../auth/api-key-verifier";
import { WEB_SESSIONS, type WebSessions } from "../auth/web-sessions";

/**
 * Guards a job's artifact route (today: `GET .../report`) that must also work for a caller with no
 * session or API key at all — the whole reason it exists — by accepting either of two separate
 * credentials, same shape as `StreamTickets`' WS handshake: the service's normal `Authorization`
 * (API key or web session, role-checked exactly like `AuthGuard`), or a `?ticket=` scoped to this one
 * job, resolved against `ArtifactTickets`. The route carries `@Public()` to skip the global `AuthGuard`
 * (which would otherwise reject the no-Authorization, ticket-only case before this ever runs) and
 * `@UseGuards(ArtifactAccessGuard)` to run this instead, on this route only.
 */
@Injectable()
export class ArtifactAccessGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_VERIFIER) private readonly apiKeys: CredentialVerifier,
    @Inject(WEB_SESSIONS) private readonly sessions: WebSessions,
    @Inject(ARTIFACT_TICKETS) private readonly tickets: ArtifactTickets,
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

    const jobId = request.params.id;
    const ticket = typeof request.query.ticket === "string" ? request.query.ticket : undefined;
    if (ticket && this.tickets.resolve(ticket) === jobId) return true;

    throw new UnauthorizedException("Invalid or missing credentials");
  }
}
