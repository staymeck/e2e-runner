import { SetMetadata } from "@nestjs/common";
import type { Request } from "express";
import type { WebRole } from "../config/service-config";

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
/** Marks a route reachable with no credential at all — only the login route needs this. */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = "e2e:roles";
/**
 * Restricts a route to the listed web roles, or an admin. Has no effect on a request authenticated
 * with the shared API key (`kind: "service"`): that stays full-access, the same as before roles
 * existed, so the CLI and n8n integrations are untouched.
 */
export const Roles = (...roles: readonly WebRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
