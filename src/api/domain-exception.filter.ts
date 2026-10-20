import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { Response } from "express";
import { UnknownProjectError } from "../core/adapter";
import { DIAGNOSTICS, type Diagnostics } from "../core/diagnostics";
import { InvalidDetailsError, InvalidTransitionError, JobAlreadyFinishedError, JobNotFoundError } from "../core/job";
import { InvalidJobRequestError, RefNotAllowedError, RefNotFoundError } from "../core/job-request";

interface Mapping {
  readonly type: new (...args: never[]) => Error;
  readonly status: HttpStatus;
  readonly code: string;
}

/** The status each domain error becomes. Anything not listed is a 500 with no detail. */
const MAPPINGS: readonly Mapping[] = [
  { type: InvalidJobRequestError, status: HttpStatus.BAD_REQUEST, code: "invalid_request" },
  { type: RefNotAllowedError, status: HttpStatus.FORBIDDEN, code: "ref_not_allowed" },
  { type: UnknownProjectError, status: HttpStatus.NOT_FOUND, code: "unknown_project" },
  { type: JobNotFoundError, status: HttpStatus.NOT_FOUND, code: "job_not_found" },
  { type: RefNotFoundError, status: HttpStatus.UNPROCESSABLE_ENTITY, code: "ref_not_found" },
  { type: JobAlreadyFinishedError, status: HttpStatus.CONFLICT, code: "job_finished" },
  { type: InvalidTransitionError, status: HttpStatus.CONFLICT, code: "invalid_transition" },
  { type: InvalidDetailsError, status: HttpStatus.CONFLICT, code: "invalid_transition" },
];

/**
 * Errors raised by the HTTP layer before a controller runs (a body that is not JSON, one that is too
 * large). They carry their own 4xx status; the text shown is ours, never the parser's.
 */
function clientError(exception: unknown): { status: number; code: string; message: string } | undefined {
  const status = (exception as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || status < 400 || status >= 500) return undefined;
  if (status === 413) return { status, code: "payload_too_large", message: "Request body too large" };
  if (status === 400) return { status, code: "invalid_request", message: "Malformed request body" };
  return { status, code: "invalid_request", message: "Invalid request" };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(@Inject(DIAGNOSTICS) private readonly diagnostics: Diagnostics) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({ statusCode: status, error: HttpStatus[status]?.toLowerCase() ?? "error", message: exception.message });
      return;
    }
    const client = clientError(exception);
    if (client) {
      response.status(client.status).json({ statusCode: client.status, error: client.code, message: client.message });
      return;
    }
    const mapping = MAPPINGS.find((candidate) => exception instanceof candidate.type);
    if (mapping && exception instanceof Error) {
      response.status(mapping.status).json({ statusCode: mapping.status, error: mapping.code, message: exception.message });
      return;
    }
    // Unexpected: the cause goes to the log, never to the client.
    this.diagnostics.error({ error: exception instanceof Error ? (exception.stack ?? exception.message) : String(exception) }, "unhandled error in a request");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, error: "internal_error", message: "Internal server error" });
  }
}
