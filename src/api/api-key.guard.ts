import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { API_KEY_VERIFIER, type CredentialVerifier } from "../auth/api-key-verifier";

const BEARER = /^Bearer\s+(\S+)$/i;

/** Every route needs `Authorization: Bearer <api key>`. There is no open mode. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(API_KEY_VERIFIER) private readonly verifier: CredentialVerifier) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization?.trim() ?? "";
    const token = BEARER.exec(header)?.[1];
    if (this.verifier.verify(token)) return true;
    throw new UnauthorizedException("Invalid or missing API key");
  }
}
