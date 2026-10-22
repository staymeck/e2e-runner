import { Body, Controller, Get, HttpCode, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { bearerTokenOf, Public } from "../auth/access-control";
import { WEB_SESSIONS, WebSessions } from "../auth/web-sessions";
import { WEB_USER_DIRECTORY, WebUserDirectory } from "../auth/web-users";
import { DIAGNOSTICS, type Diagnostics } from "../core/diagnostics";

function parseLogin(body: unknown): { username: string; password: string } {
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    throw new UnauthorizedException("Invalid username or password");
  }
  return { username: username.trim(), password };
}

@Controller("v1/auth")
export class AuthController {
  constructor(
    @Inject(WEB_USER_DIRECTORY) private readonly users: WebUserDirectory,
    @Inject(WEB_SESSIONS) private readonly sessions: WebSessions,
    @Inject(DIAGNOSTICS) private readonly diagnostics: Diagnostics,
  ) {}

  @Public()
  @Post("login")
  login(@Body() body: unknown): { token: string; username: string; role: string } {
    const { username, password } = parseLogin(body);
    const user = this.users.verify(username, password);
    if (!user) {
      this.diagnostics.warn({ username }, "rejected a web login attempt");
      throw new UnauthorizedException("Invalid username or password");
    }
    const token = this.sessions.issue(user);
    return { token, username: user.username, role: user.role };
  }

  /** A no-op for a request authenticated with the shared API key: there is no session to revoke. */
  @Post("logout")
  @HttpCode(204)
  logout(@Req() request: Request): void {
    this.sessions.revoke(bearerTokenOf(request));
  }

  /** Lets the web restore who is logged in after a reload, without re-sending credentials. */
  @Get("me")
  me(@Req() request: Request): { kind: "service" } | { kind: "user"; username: string; role: string } {
    // AuthGuard always sets this before a non-public route runs; this route requires a credential.
    const auth = request.auth!;
    return auth.kind === "service" ? { kind: "service" } : { kind: "user", username: auth.username, role: auth.role };
  }
}
