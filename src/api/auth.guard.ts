import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { bearerTokenOf, enforceRole, IS_PUBLIC_KEY } from "../auth/access-control";
import { API_KEY_VERIFIER, type CredentialVerifier } from "../auth/api-key-verifier";
import { WEB_SESSIONS, WebSessions } from "../auth/web-sessions";

/**
 * Every route needs `Authorization: Bearer <token>`, unless marked `@Public()`. The token is either
 * the service's own shared API key (full access, for machine clients: the CLI, n8n) or a web
 * session issued by `POST /v1/auth/login` (scoped to its role). A route marked `@Roles(...)`
 * additionally requires a user session in one of those roles, or an admin — a service-key request
 * always passes that check, so today's machine-client contract does not change.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_VERIFIER) private readonly apiKeys: CredentialVerifier,
    @Inject(WEB_SESSIONS) private readonly sessions: WebSessions,
    // `tsx`/esbuild does not emit `design:paramtypes`, so Nest cannot resolve this by type alone
    // (every other provider in this codebase sidesteps that with an explicit token, same as here).
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerTokenOf(request);

    if (this.apiKeys.verify(token)) {
      request.auth = { kind: "service" };
      return true;
    }

    const user = this.sessions.verify(token);
    if (!user) throw new UnauthorizedException("Invalid or missing credentials");
    request.auth = { kind: "user", username: user.username, role: user.role };
    enforceRole(this.reflector, context, user);
    return true;
  }
}
