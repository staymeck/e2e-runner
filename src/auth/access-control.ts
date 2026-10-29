import { ExecutionContext, ForbiddenException, SetMetadata } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { WebRole } from "../config/service-config";
import type { WebUser } from "./web-users";

const BEARER = /^Bearer\s+(\S+)$/i;

/** The raw bearer token from `Authorization`, whatever it turns out to be (API key, web session, or neither). */
export function bearerTokenOf(request: Request): string | undefined {
  return BEARER.exec(request.headers.authorization?.trim() ?? "")?.[1];
}

/** What a request's `Authorization` bearer resolved to, attached by `AuthGuard`. */
export type RequestAuth = { readonly kind: "service" } | { readonly kind: "user"; readonly username: string; readonly role: WebRole };

declare module "express" {
  interface Request {
    auth?: RequestAuth;
  }
}

export const IS_PUBLIC_KEY = "e2e:public";
/**
 * Skips the global `AuthGuard`. Either the route is reachable with no credential at all (only the
 * login route needs that), or it substitutes its own guard via `@UseGuards(...)` that enforces an
 * equivalent-or-narrower policy `AuthGuard` cannot express alone — e.g. `ArtifactAccessGuard`, which
 * accepts `AuthGuard`'s own credentials too, plus a job-scoped ticket for a caller with neither.
 */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = "e2e:roles";
/**
 * Restricts a route to the listed web roles, or an admin. Has no effect on a request authenticated
 * with the shared API key (`kind: "service"`): that stays full-access, the same as before roles
 * existed, so the CLI and n8n integrations are untouched.
 */
export const Roles = (...roles: readonly WebRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/**
 * Shared by `AuthGuard` and `ArtifactAccessGuard`: a web session reaching a `@Roles(...)`-restricted
 * route must have one of those roles, or be an admin — a service-key request never calls this (it is
 * always full-access, checked by its caller before this). Kept in one place so the two guards' role
 * policy cannot silently diverge from each other.
 */
export function enforceRole(reflector: Reflector, context: ExecutionContext, user: WebUser): void {
  const roles = reflector.getAllAndOverride<WebRole[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
  if (roles && roles.length > 0 && user.role !== "admin" && !roles.includes(user.role)) {
    throw new ForbiddenException("Your role cannot access this resource");
  }
}
